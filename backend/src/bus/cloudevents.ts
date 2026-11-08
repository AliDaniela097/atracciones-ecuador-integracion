import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { parseTime } from '../common/util.js';
import type { StockUpdate } from '../grpc/grpc-inventory.service.js';

/** UUID determinista a partir de un texto (mismo evento lógico → mismo id; permite deduplicar). */
export function uuidDe(texto: string): string {
  const h = createHash('sha256').update(texto).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const traceparent = () => `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;

export interface CloudEvent {
  specversion: '1.0'; id: string; type: string; source: string; time: string; datacontenttype: string;
  correlationid: string; traceparent?: string; node_id: string; data: Record<string, any>;
}

/** Evento stock.updated según la guía del bus de Booking (CloudEvents v1.0). `delta` solo se envía si se conoce el valor previo. */
export function construirStockUpdated(m: StockUpdate, anterior?: number): CloudEvent {
  const hhmm = parseTime(m.time_slot) ?? m.time_slot;
  const data: Record<string, any> = {
    service_id: m.service_id, item_id: m.item_id, date: m.date, time_slot: hhmm, slot_id: m.slot_id,
    new_units: m.available_units, available_units: m.available_units, timestamp: m.timestamp,
  };
  if (anterior !== undefined) data.delta = m.available_units - anterior;
  return {
    specversion: '1.0', id: uuidDe(`stock|${m.item_id}|${m.slot_id}|${m.timestamp}`), type: 'com.booking.stock.updated', source: config.serviceId,
    time: new Date().toISOString(), datacontenttype: 'application/json', correlationid: randomUUID(), traceparent: traceparent(), node_id: config.serviceId, data,
  };
}

/** Valida lo mínimo de un CloudEvent entrante. Devuelve el evento o un motivo de rechazo. */
export function leerCloudEvent(buf: Buffer): { ok: true; ev: CloudEvent } | { ok: false; motivo: string } {
  let j: any;
  try { j = JSON.parse(buf.toString('utf8')); } catch { return { ok: false, motivo: 'El cuerpo no es JSON' }; }
  if (!j || typeof j !== 'object') return { ok: false, motivo: 'El cuerpo no es un objeto' };
  if (j.specversion !== '1.0') return { ok: false, motivo: 'specversion debe ser 1.0' };
  if (typeof j.id !== 'string' || !j.id) return { ok: false, motivo: 'Falta id' };
  if (typeof j.type !== 'string' || !j.type) return { ok: false, motivo: 'Falta type' };
  if (j.data === undefined || j.data === null || typeof j.data !== 'object') j.data = {};
  return { ok: true, ev: j as CloudEvent };
}

/** Lee un campo anidado con ruta "data.reservation_code". */
export function campo(ev: any, ruta: string): unknown { return ruta.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), ev); }
