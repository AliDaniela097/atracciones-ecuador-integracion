import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import amqp from 'amqplib';
import { bitacora } from '../observabilidad/bitacora.js';
import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { config } from '../config.js';
import { construirStockUpdated, leerCloudEvent, type CloudEvent } from './cloudevents.js';
import type { StockUpdate } from '../grpc/grpc-inventory.service.js';

export type ResultadoManejo = 'procesado' | 'ignorado' | 'duplicado';
export type Manejador = (clave: string, ev: CloudEvent) => Promise<ResultadoManejo>;
type Conectar = (url: string, opts?: any) => Promise<ChannelModel>;

/**
 * Bus de eventos RabbitMQ (CloudAMQP). UNA sola conexión AMQP por tienda (el plan gratis limita a 20 para toda la clase)
 * con dos canales: uno con confirmaciones para publicar y otro para consumir.
 *  - Publica en el exchange topic `booking.events` (persistente, con confirmación del broker).
 *  - Consume `order.confirmed`, `saga.compensate` y `payment.refunded` con ACK manual, reintentos y cola de errores (DLQ).
 * La URL (secreta) llega solo por la variable de entorno AMQP_URL y nunca se escribe en logs.
 */
@Injectable()
export class AmqpService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Bus');
  private conn?: ChannelModel; private pub?: ConfirmChannel; private sub?: Channel;
  private cerrando = false; private intento = 0; private reco?: NodeJS.Timeout;
  private manejador?: Manejador;
  private previo = new Map<string, number>();
  /** Reemplazable en pruebas para usar un broker simulado en memoria. */
  conectar: Conectar = (url, opts) => amqp.connect(url, opts);
  st = { conectado: false, publicados: 0, publicacion_fallida: 0, consumidos: 0, reintentados: 0, a_dlq: 0, duplicados: 0, ignorados: 0, reconexiones: 0, ultimo_error: null as string | null, ultimo_publicado_en: null as string | null, ultimo_consumido_en: null as string | null };

  habilitado() { return config.amqp.enabled && !!config.amqp.url; }
  stats() { return { habilitado: this.habilitado(), host: this.host(), exchange: config.amqp.exchange, cola: config.amqp.queue, ...this.st }; }
  private host() { try { return config.amqp.url ? new URL(config.amqp.url).host : null; } catch { return 'url-invalida'; } }
  setManejador(m: Manejador) { this.manejador = m; }

  async onModuleInit() { if (this.habilitado()) void this.iniciar(); else this.log.log('Bus RabbitMQ deshabilitado (falta AMQP_URL).'); }
  async onModuleDestroy() { this.cerrando = true; if (this.reco) clearTimeout(this.reco); await this.sub?.close().catch(() => {}); await this.pub?.close().catch(() => {}); await this.conn?.close().catch(() => {}); this.st.conectado = false; }

  async iniciar() {
    if (this.cerrando) return;
    try {
      const conn = await this.conectar(config.amqp.url, { heartbeat: 30 });
      this.conn = conn; this.intento = 0;
      conn.on('error', (e: any) => { this.st.ultimo_error = `conexión: ${e?.message ?? e}`.slice(0, 200); });
      conn.on('close', () => { this.st.conectado = false; if (!this.cerrando) { this.log.warn('Conexión AMQP cerrada; se reintentará.'); this.reconectar(); } });
      this.pub = await conn.createConfirmChannel();
      this.pub.on('error', (e: any) => { this.st.ultimo_error = `canal publicación: ${e?.message ?? e}`.slice(0, 200); });
      await this.pub.assertExchange(config.amqp.exchange, 'topic', { durable: true });
      this.sub = await conn.createChannel();
      this.sub.on('error', (e: any) => { this.st.ultimo_error = `canal consumo: ${e?.message ?? e}`.slice(0, 200); });
      await this.prepararConsumo(this.sub);
      this.st.conectado = true; this.st.ultimo_error = null;
      bitacora.registrar('BUS', `Conectado al bus RabbitMQ (${this.host()}); escuchando ${config.amqp.queue}`);
      this.log.log(`Bus conectado a ${this.host()} (1 conexión, 2 canales). Escuchando ${config.amqp.queue}.`);
    } catch (e: any) {
      this.st.conectado = false; this.st.ultimo_error = `${e?.message ?? e}`.replace(/amqps?:\/\/[^\s]+/g, 'amqp://***').slice(0, 200);
      this.log.warn(`No se pudo conectar al bus: ${this.st.ultimo_error}`);
      try { await this.conn?.close(); } catch { /* ya cerrada */ }
      this.reconectar();
    }
  }

  private reconectar() {
    if (this.cerrando || this.reco) return;
    this.st.reconexiones++; this.intento++;
    const espera = Math.min(1000 * 2 ** Math.min(this.intento, 5), 30_000);
    this.reco = setTimeout(() => { this.reco = undefined; void this.iniciar(); }, espera); this.reco.unref();
  }

  private async prepararConsumo(ch: Channel) {
    const { exchange, queue, dlx, dlq, bindKeys, prefetch } = config.amqp;
    await ch.assertExchange(dlx, 'direct', { durable: true });
    await ch.assertQueue(dlq, { durable: true });
    await ch.bindQueue(dlq, dlx, 'dead');
    await ch.assertQueue(queue, { durable: true, arguments: { 'x-dead-letter-exchange': dlx, 'x-dead-letter-routing-key': 'dead' } });
    for (const k of bindKeys) await ch.bindQueue(queue, exchange, k);
    await ch.prefetch(prefetch);
    await ch.consume(queue, (m) => { if (m) void this.alRecibir(ch, m); }, { noAck: false });
  }

  private async alRecibir(ch: Channel, m: ConsumeMessage) {
    try {
      const p = leerCloudEvent(m.content);
      if (!p.ok) { bitacora.registrar('BUS', `Mensaje inválido enviado a la DLQ: ${p.motivo}`, { nivel: 'WARN' }); this.log.warn(`Mensaje inválido a DLQ: ${p.motivo}`); this.st.a_dlq++; ch.nack(m, false, false); return; }
      // Un mensaje reencolado llega por el exchange por defecto (routingKey = nombre de la cola); la clave original viaja en una cabecera.
      const clave = String(m.properties.headers?.['x-original-key'] ?? m.fields.routingKey);
      const r = this.manejador ? await this.manejador(clave, p.ev) : 'ignorado';
      this.st.consumidos++; this.st.ultimo_consumido_en = new Date().toISOString();
      if (r === 'duplicado') this.st.duplicados++; else if (r === 'ignorado') this.st.ignorados++;
      ch.ack(m);
    } catch (e: any) {
      const n = Number(m.properties.headers?.['x-retry'] ?? 0);
      this.st.ultimo_error = `consumo: ${e?.message ?? e}`.slice(0, 200);
      if (n >= config.amqp.maxRetries) { this.log.error(`Mensaje a DLQ tras ${n} reintentos: ${this.st.ultimo_error}`); this.st.a_dlq++; try { ch.nack(m, false, false); } catch { /* canal cerrado */ } return; }
      // Reintento con espera creciente: se reenvía a la propia cola con x-retry+1 y se confirma el original.
      this.st.reintentados++;
      const espera = Math.min(2 ** (n + 1) * 1000, 30_000);
      const t = setTimeout(() => { try { ch.sendToQueue(config.amqp.queue, m.content, { persistent: true, headers: { ...(m.properties.headers ?? {}), 'x-retry': n + 1, 'x-original-key': String(m.properties.headers?.['x-original-key'] ?? m.fields.routingKey) }, contentType: m.properties.contentType, messageId: m.properties.messageId }); } catch (e2: any) { this.log.warn(`No se pudo reencolar el reintento: ${e2?.message ?? e2}`); } }, espera);
      t.unref();
      try { ch.ack(m); } catch { /* canal cerrado: el broker reentrega */ }
    }
  }

  /** Publica stock.updated con confirmación del broker. Lanza si no hay conexión o no se confirma (el Outbox reintenta). */
  async publicarStock(m: StockUpdate): Promise<{ success: boolean; message: string; processed_at: number; error_code: string; current_available: number }> {
    if (!this.pub || !this.st.conectado) { this.st.publicacion_fallida++; throw Object.assign(new Error('Bus no conectado'), { details: 'Bus RabbitMQ no conectado' }); }
    const clave = `${m.item_id}|${m.slot_id}`;
    const ev = construirStockUpdated(m, this.previo.get(clave));
    const cuerpo = Buffer.from(JSON.stringify(ev));
    const ch = this.pub;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('El broker no confirmó la publicación a tiempo')), config.amqp.publishTimeoutMs);
      try {
        ch.publish(config.amqp.exchange, 'stock.updated', cuerpo, {
          deliveryMode: 2, contentType: 'application/json', messageId: ev.id, type: ev.type, appId: config.serviceId, timestamp: Math.floor(Date.now() / 1000),
          headers: { 'x-correlation-id': ev.correlationid },
        }, (err: any) => { clearTimeout(t); err ? reject(err) : resolve(); });
      } catch (e) { clearTimeout(t); reject(e); }
    }).catch((e) => { this.st.publicacion_fallida++; this.st.ultimo_error = `publicación: ${e?.message ?? e}`.slice(0, 200); throw Object.assign(e instanceof Error ? e : new Error(String(e)), { details: this.st.ultimo_error }); });
    this.previo.set(clave, m.available_units); if (this.previo.size > 5000) this.previo.delete(this.previo.keys().next().value as string);
    this.st.publicados++; this.st.ultimo_publicado_en = new Date().toISOString();
    bitacora.registrar('BUS', `Publicado stock.updated en ${config.amqp.exchange}`, { datos: { item: m.item_id, fecha: m.date, cupos: m.available_units } });
    return { success: true, message: 'Publicado en el bus', processed_at: Date.now(), error_code: 'OK', current_available: m.available_units };
  }
}
