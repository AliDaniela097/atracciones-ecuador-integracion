import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Db } from '../db/db.service.js';
import { OutboxService } from '../eventos/outbox.service.js';
import { config } from '../config.js';
import { AmqpService } from '../bus/amqp.service.js';
import { contractsDir } from '../contract/contract.service.js';
import { bitacora } from '../observabilidad/bitacora.js';
import { hhmmFromDb, label12h, todayEC } from '../common/util.js';

export interface StockUpdate { service_id: string; item_id: string; date: string; time_slot: string; available_units: number; timestamp: number; slot_id: string }
interface Ack { success: boolean; message: string; processed_at: number; error_code: string; current_available: number }

/**
 * Cliente gRPC hacia Booking (puerto 50051, HTTP/2): la tienda es el CLIENTE, Booking el servidor.
 *  - PushStockUpdate (unary): lo usa el despachador del Outbox ante cada venta/cancelación/cambio de aforo.
 *  - StreamInventoryChanges (client-streaming): lo usa la conciliación masiva con deltas.
 *  - GetSlotAvailability (unary): lo usa la conciliación para comparar contra lo que Booking tiene.
 */
/** Rechaza si la promesa no termina a tiempo: evita que un envío colgado bloquee el despachador para siempre. */
function conLimite<T>(p: Promise<T>, ms: number, que: string): Promise<T> {
  let t: NodeJS.Timeout;
  const limite = new Promise<never>((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${que}: sin respuesta en ${ms} ms`), { details: `${que}: sin respuesta en ${ms} ms` })), ms); });
  return Promise.race([p, limite]).finally(() => clearTimeout(t));
}

@Injectable()
export class GrpcInventoryService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('gRPC');
  private client: any;
  private timer?: NodeJS.Timeout;
  private running = false;
  private runningSince = 0;
  private pausadoHasta = 0;
  private lastLog = 0;
  private st = { last_attempt_at: null as string | null, sent_ok: 0, sent_failed: 0, stale_ignored: 0, last_ok_at: null as string | null, last_error: null as string | null };

  constructor(@Inject(Db) private db: Db, @Inject(OutboxService) private outbox: OutboxService, @Inject(AmqpService) private bus: AmqpService) {}

  stats() { return { ...this.st }; }

  private getClient() {
    if (this.client) return this.client;
    const def = protoLoader.loadSync(path.join(contractsDir, 'proto/inventory.proto'), { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    const pkg: any = grpc.loadPackageDefinition(def);
    const creds = config.grpc.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.client = new pkg.inventory.InventoryStockService(config.grpc.target, creds, { 'grpc.keepalive_time_ms': 30_000, 'grpc.initial_reconnect_backoff_ms': 500, 'grpc.max_reconnect_backoff_ms': 5_000 });
    return this.client;
  }
  /** Cabeceras gRPC que exige Booking: service_id y x-api-key (la clave solo sale de BOOKING_API_KEY, nunca del código). */
  private meta() { const m = new grpc.Metadata(); m.set('service_id', config.serviceId); if (config.booking.apiKey) m.set('x-api-key', config.booking.apiKey); return m; }
  private deadline() { return new Date(Date.now() + config.grpc.deadlineMs); }

  onModuleInit() {
    if (!config.grpc.enabled) { this.log.warn('gRPC deshabilitado (GRPC_ENABLED=false): los eventos de stock quedan en el Outbox.'); return; }
    this.log.log(`Despachador gRPC → ${config.grpc.target} cada ${config.grpc.intervalMs} ms (service_id=${config.serviceId})`);
    this.timer = setInterval(() => void this.pushPending().catch(() => undefined), config.grpc.intervalMs);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); this.client?.close?.(); }

  // ---------- RPC 1 ----------
  pushOne(msg: StockUpdate): Promise<Ack> {
    if (config.booking.stockMode === 'rest') return this.pushOneRest(msg);
    if (config.booking.stockMode === 'amqp') return this.bus.publicarStock(msg);
    return new Promise((resolve, reject) => this.getClient().PushStockUpdate(msg, this.meta(), { deadline: this.deadline() }, (e: any, ack: Ack) => (e ? reject(e) : resolve(ack))));
  }

  /**
   * Respaldo HTTP documentado por Booking: POST {BOOKING_REST_STOCK_URL} con X-API-Key.
   * 2xx con acknowledged/success = entregado; 4xx = error de negocio (se reintenta con espera); red/5xx = fallo de transporte.
   */
  private async pushOneRest(msg: StockUpdate): Promise<Ack> {
    const url = config.booking.restStockUrl; const key = config.booking.apiKey || config.apiKeys[0] || '';
    if (!url) throw Object.assign(new Error('BOOKING_REST_STOCK_URL no está configurada'), { details: 'BOOKING_REST_STOCK_URL vacía' });
    const body: Record<string, unknown> = { item_id: msg.item_id, available_units: msg.available_units, date: msg.date, time_slot: msg.time_slot, timestamp: msg.timestamp };
    if (config.booking.restExtraFields) { body.slot_id = msg.slot_id; body.service_id = msg.service_id; }
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-correlation-id': randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(config.grpc.deadlineMs) });
    const text = await res.text(); let j: any = {}; try { j = JSON.parse(text); } catch { /* cuerpo no JSON */ }
    if (res.status >= 500 || res.status === 429) throw Object.assign(new Error(`HTTP ${res.status}`), { details: `HTTP ${res.status} ${text.slice(0, 120)}` });
    const ok = res.ok && (j.acknowledged === true || j.success === true || (j.acknowledged === undefined && j.success === undefined));
    const stale = /STALE/i.test(String(j.error_code ?? j.code ?? ''));
    return { success: ok || stale, message: String(j.message ?? j.detail ?? (ok ? 'OK' : text.slice(0, 160))), processed_at: Date.now(), error_code: stale ? 'STALE_TIMESTAMP_IGNORED' : ok ? 'OK' : String(j.error_code ?? j.code ?? `HTTP_${res.status}`), current_available: Number(j.current_available ?? msg.available_units) };
  }

  /** Encola STOCK_ACTUALIZADO de todos los turnos futuros de atracciones publicadas (carga inicial hacia Booking). */
  async enqueueAllStock(days = 30) {
    const turnos = await this.db.query(
      `SELECT t.tur_id FROM turno t JOIN horario h ON h.hor_id=t.hor_id JOIN atraccion a ON a.atr_id=h.atr_id
        WHERE a.atr_estado='PUBLICADA' AND a.atr_eliminado_en IS NULL AND h.hor_activo AND t.tur_fecha BETWEEN $1::date AND $1::date + $2::int
        ORDER BY t.tur_fecha, h.hor_hora, a.atr_id LIMIT 2000`, [todayEC(), days]);
    for (const r of turnos) await this.db.tx((c) => this.outbox.emitStock(c, r.tur_id));
    return { encolados: turnos.length, siguiente_paso: 'El despachador los envía solo; revise GET /admin/sync/estado.' };
  }

  /** Envía en orden los STOCK_ACTUALIZADO pendientes. Para en el primer fallo de transporte para no desordenar. */
  async pushPending(limit = 100): Promise<{ sent: number; failed: number; pending: number }> {
    if (Date.now() < this.pausadoHasta) return { sent: 0, failed: 0, pending: -2 }; // Booking caído: pausa global para no desordenar ni gastar recursos
    if (this.running) {
      if (Date.now() - this.runningSince < 60_000) return { sent: 0, failed: 0, pending: -1 };
      this.log.error('Un envío de stock llevaba más de 60 s sin terminar; se libera el bloqueo y se reintenta.');
    }
    this.running = true; this.runningSince = Date.now(); let sent = 0, failed = 0;
    try {
      const rows = await conLimite(this.db.query(
        `SELECT evt_id, evt_payload, evt_intentos, evt_correlation_id FROM outbox_evento
          WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL AND evt_proximo_intento <= now() AND evt_intentos < $2
          ORDER BY evt_id LIMIT $1`, [limit, config.grpc.maxAttempts]), 20_000, 'consulta de pendientes');
      if (rows.length) { this.st.last_attempt_at = new Date().toISOString(); if (Date.now() - this.lastLog > 30_000) { this.lastLog = Date.now(); this.log.log(`Enviando ${rows.length} evento(s) de stock a Booking (modo ${config.booking.stockMode})`); } }
      for (const r of rows) {
        try {
          const ack = await conLimite(this.pushOne(r.evt_payload), config.grpc.deadlineMs + 3000, 'envío a Booking');
          if (ack.success || ack.error_code === 'OK' || ack.error_code === 'STALE_TIMESTAMP_IGNORED') {
            await this.db.query('UPDATE outbox_evento SET evt_publicado_en=now(), evt_ultimo_error=$2 WHERE evt_id=$1', [r.evt_id, ack.error_code === 'STALE_TIMESTAMP_IGNORED' ? 'STALE_TIMESTAMP_IGNORED (Booking ya tenía un dato más nuevo)' : null]);
            this.st.sent_ok++; if (ack.error_code === 'STALE_TIMESTAMP_IGNORED') this.st.stale_ignored++;
            this.st.last_ok_at = new Date().toISOString(); sent++;
            bitacora.registrar('STOCK', `→ Booking [${config.booking.stockMode === 'grpc' ? 'gRPC PushStockUpdate' : config.booking.stockMode === 'rest' ? 'REST POST /inventory/stock' : 'RabbitMQ stock.updated'}] ${ack.error_code === 'STALE_TIMESTAMP_IGNORED' ? 'ignorado por Booking (ya tenía un dato más nuevo)' : 'OK'}`, { cid: r.evt_correlation_id ?? undefined, datos: { item: r.evt_payload.item_id, fecha: r.evt_payload.date, turno: r.evt_payload.time_slot, cupos: r.evt_payload.available_units } });
          } else {
            // ITEM_NOT_FOUND / INVALID_SLOT: error de negocio de Booking. Se reintenta con espera exponencial y cuenta como intento.
            const n = r.evt_intentos + 1;
            await this.db.query(`UPDATE outbox_evento SET evt_intentos=$2, evt_ultimo_error=$3, evt_proximo_intento=now() + ($4 || ' seconds')::interval WHERE evt_id=$1`,
              [r.evt_id, n, `${ack.error_code}: ${ack.message}`.slice(0, 300), String(Math.min(2 ** n * 2, 300))]);
            this.st.sent_failed++; this.st.last_error = ack.error_code; failed++;
            bitacora.registrar('STOCK', `→ Booking rechazó el stock: ${ack.error_code}`, { cid: r.evt_correlation_id ?? undefined, nivel: 'WARN', datos: { item: r.evt_payload.item_id, fecha: r.evt_payload.date, intento: n } });
          }
        } catch (e: any) {
          // Fallo de transporte (Booking caído / sin red): no consume intentos; se reintenta tras GRPC_RETRY_MS y se corta el lote.
          await this.db.query(`UPDATE outbox_evento SET evt_ultimo_error=$2, evt_proximo_intento=now() + ($3 || ' milliseconds')::interval WHERE evt_id=$1`, [r.evt_id, `transporte: ${e.code ?? ''} ${e.details ?? e.message}`.slice(0, 300), String(config.grpc.retryMs)]);
          this.st.sent_failed++; this.st.last_error = String(e.details ?? e.message); failed++;
          this.pausadoHasta = Date.now() + config.grpc.retryMs;
          bitacora.registrar('STOCK', `→ Booking no respondió (${this.st.last_error}); el Outbox reintenta sin perder el evento`, { cid: r.evt_correlation_id ?? undefined, nivel: 'WARN', datos: { item: r.evt_payload.item_id, fecha: r.evt_payload.date } });
          if (Date.now() - this.lastLog > 30_000) { this.lastLog = Date.now(); this.log.warn(`Fallo de transporte hacia Booking: ${this.st.last_error}`); }
          break;
        }
      }
      const pending = Number((await this.db.one(`SELECT COUNT(*) AS n FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL`))!.n);
      return { sent, failed, pending };
    } finally { this.running = false; }
  }

  // ---------- RPC 3 ----------
  getAvailability(req: { item_id: string; date: string; time_slot: string; slot_id: string }): Promise<any> {
    return new Promise((resolve, reject) => this.getClient().GetSlotAvailability({ service_id: config.serviceId, ...req }, this.meta(), { deadline: this.deadline() }, (e: any, r: any) => (e ? reject(e) : resolve(r))));
  }

  // ---------- RPC 2 ----------
  streamDeltas(events: Array<{ item_id: string; date: string; time_slot: string; slot_id: string; delta: number; timestamp: number }>): Promise<any> {
    return new Promise((resolve, reject) => {
      const call = this.getClient().StreamInventoryChanges(this.meta(), { deadline: new Date(Date.now() + 30_000) }, (e: any, s: any) => (e ? reject(e) : resolve(s)));
      for (const ev of events) call.write({ event_id: randomUUID(), service_id: config.serviceId, ...ev });
      call.end();
    });
  }

  /**
   * Conciliación: compara el aforo local con el que Booking tiene (RPC 3) y corrige las diferencias
   * enviando los deltas (RPC 2). Útil tras una caída de red o al registrar la tienda por primera vez.
   */
  async reconcile(days = 14) {
    if (config.booking.stockMode === 'rest') return { modo: 'rest', mensaje: 'La conciliación usa gRPC (GetSlotAvailability). En modo REST use POST /admin/sync/reenviar-todo para reenviar el stock.' };
    const rows = await this.db.query(
      `SELECT v.tur_id, v.slot_id, v.tur_fecha, v.hor_hora, v.cupos_disponibles, a.atr_codigo
         FROM v_turno_disponibilidad v JOIN atraccion a ON a.atr_id=v.atr_id
        WHERE a.atr_estado='PUBLICADA' AND a.atr_eliminado_en IS NULL AND v.hor_activo AND v.tur_fecha BETWEEN $1::date AND $1::date + $2::int
        ORDER BY v.tur_fecha, v.hor_hora, a.atr_codigo LIMIT 500`, [todayEC(), days]);
    const diffs: any[] = []; const report = { checked: 0, in_sync: 0, differences: 0, not_found_in_booking: 0, sent: 0 };
    for (const r of rows) {
      const slot = { item_id: r.atr_codigo, date: r.tur_fecha, time_slot: label12h(hhmmFromDb(r.hor_hora)), slot_id: r.slot_id };
      const theirs = await this.getAvailability(slot); report.checked++;
      if (!theirs.slot_id && theirs.available_units === 0 && !theirs.status) { report.not_found_in_booking++; continue; }
      const delta = r.cupos_disponibles - theirs.available_units;
      if (delta === 0) { report.in_sync++; continue; }
      report.differences++;
      const cur = await this.db.one('SELECT tur_sync_ts FROM turno WHERE tur_id=$1', [r.tur_id]);
      const ts = Math.max(Date.now(), Number(cur!.tur_sync_ts) + 1);
      await this.db.query('UPDATE turno SET tur_sync_ts=$2 WHERE tur_id=$1', [r.tur_id, ts]);
      diffs.push({ ...slot, delta, timestamp: ts });
    }
    if (diffs.length) { const sum = await this.streamDeltas(diffs); report.sent = sum.total_events_processed; return { ...report, summary: sum }; }
    return report;
  }
}
