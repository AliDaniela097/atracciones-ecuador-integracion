import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export interface CheckinAviso {
  externalOrderId: string; clientId: string; asistentesReales: number; adminId: string; fechaCheckin: string; observaciones: string; correlationId?: string;
}
export interface CheckinResultado { notificado: boolean; estado: 'ENVIADO' | 'PENDIENTE_REINTENTO' | 'NO_CONFIGURADO' | 'RECHAZADO'; detalle?: string }

/**
 * Avisa a Booking Central que el turista llegó (POST {BOOKING}/reservas/{id}/checkin, X-API-Key).
 * 2xx = entregado; 4xx (salvo 408/429) = rechazo definitivo; red/5xx = se reintenta con espera creciente (en memoria).
 * Limitación honesta: si el proceso se reinicia con un aviso pendiente, se reenvía cuando el guía repita el check-in (es idempotente).
 */
@Injectable()
export class BookingCheckinService {
  private log = new Logger('BookingCheckin');
  private pendientes = new Map<string, NodeJS.Timeout>();
  enviados = 0; fallidos = 0;

  configurado() { return !!(config.booking.checkinUrl && (config.booking.apiKey || config.apiKeys[0])); }

  private async intentar(a: CheckinAviso): Promise<{ ok: boolean; definitivo: boolean; detalle: string }> {
    const url = config.booking.checkinUrl.replace('{id}', encodeURIComponent(a.externalOrderId));
    const body = {
      external_order_id: a.externalOrderId, client_id: a.clientId, estado: 'CONFIRMADO_ASISTIDO', asistentes_reales: a.asistentesReales,
      admin_id: a.adminId, fecha_checkin: a.fechaCheckin, observaciones: a.observaciones,
    };
    try {
      const res = await fetch(url, {
        method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(config.booking.checkinTimeoutMs),
        headers: { 'content-type': 'application/json', 'x-api-key': config.booking.apiKey || config.apiKeys[0] || '', 'x-correlation-id': a.correlationId ?? randomUUID() },
      });
      const text = await res.text(); let j: any = {}; try { j = JSON.parse(text); } catch { /* no JSON */ }
      if (res.ok && j.acknowledged !== false) return { ok: true, definitivo: true, detalle: `HTTP ${res.status} ${j.status ?? ''}`.trim() };
      const reintentable = res.status >= 500 || res.status === 408 || res.status === 429;
      return { ok: false, definitivo: !reintentable, detalle: `HTTP ${res.status} ${(j.code ?? j.detail ?? text).toString().slice(0, 120)}` };
    } catch (e: any) {
      return { ok: false, definitivo: false, detalle: `red: ${e?.name === 'TimeoutError' ? 'tiempo agotado' : (e?.message ?? e)}`.slice(0, 160) };
    }
  }

  async notificar(a: CheckinAviso): Promise<CheckinResultado> {
    if (!this.configurado()) return { notificado: false, estado: 'NO_CONFIGURADO', detalle: 'BOOKING_CHECKIN_URL/BOOKING_REST_STOCK_URL o la API key no están configuradas' };
    const clave = a.externalOrderId;
    const previo = this.pendientes.get(clave); if (previo) { clearTimeout(previo); this.pendientes.delete(clave); }
    const r = await this.intentar(a);
    if (r.ok) { this.enviados++; return { notificado: true, estado: 'ENVIADO', detalle: r.detalle }; }
    this.fallidos++;
    this.log.warn(`Check-in ${clave} no entregado: ${r.detalle}`);
    if (r.definitivo) return { notificado: false, estado: 'RECHAZADO', detalle: r.detalle };
    this.reintentar(a, 1);
    return { notificado: false, estado: 'PENDIENTE_REINTENTO', detalle: r.detalle };
  }

  private reintentar(a: CheckinAviso, n: number) {
    if (n >= config.booking.checkinMaxAttempts) { this.log.error(`Check-in ${a.externalOrderId}: se agotaron los reintentos.`); return; }
    const t = setTimeout(async () => {
      this.pendientes.delete(a.externalOrderId);
      const r = await this.intentar(a);
      if (r.ok) { this.enviados++; return; }
      this.fallidos++;
      if (!r.definitivo) this.reintentar(a, n + 1);
      else this.log.error(`Check-in ${a.externalOrderId} rechazado por Booking: ${r.detalle}`);
    }, Math.min(2 ** n * 2000, 60_000));
    t.unref(); this.pendientes.set(a.externalOrderId, t);
  }

  estado() { return { configurado: this.configurado(), enviados: this.enviados, fallidos: this.fallidos, pendientes_reintento: this.pendientes.size }; }
}
