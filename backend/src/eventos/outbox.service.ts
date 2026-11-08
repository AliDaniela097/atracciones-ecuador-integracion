import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Db } from '../db/db.service.js';
import { badRequest } from '../common/problem.js';
import { hhmmFromDb, label12h, pageQuery } from '../common/util.js';
import { config } from '../config.js';

export type EventType = 'RESERVA_CREADA' | 'RESERVA_CONFIRMADA' | 'STOCK_ACTUALIZADO' | 'RESERVA_CANCELADA';
const TYPES: EventType[] = ['RESERVA_CREADA', 'RESERVA_CONFIRMADA', 'STOCK_ACTUALIZADO', 'RESERVA_CANCELADA'];

/** Transactional Outbox: el evento se inserta en la MISMA transacción que el cambio de negocio. */
@Injectable()
export class OutboxService {
  constructor(@Inject(Db) private db: Db) {}

  async emit(c: PoolClient, tipo: EventType, aggregateId: string, correlationId: string | undefined, payload: object) {
    await c.query(
      'INSERT INTO outbox_evento (evt_tipo, evt_aggregate_id, evt_correlation_id, evt_payload) VALUES ($1,$2,$3,$4)',
      [tipo, aggregateId, correlationId ?? null, JSON.stringify(payload)]);
  }

  /**
   * Emite STOCK_ACTUALIZADO para un turno con el mensaje gRPC listo (StockUpdateMessage).
   * El timestamp es estrictamente creciente por turno (regla monotónica de Booking).
   * Debe llamarse DESPUÉS de actualizar tur_cupo_reservado dentro de la misma transacción.
   */
  async emitStock(c: PoolClient, turId: number, correlationId?: string) {
    const { rows } = await c.query(
      `SELECT v.tur_fecha, v.hor_hora, v.slot_id, v.cupos_disponibles, a.atr_codigo, t.tur_sync_ts
         FROM turno t JOIN v_turno_disponibilidad v ON v.tur_id=t.tur_id JOIN atraccion a ON a.atr_id=v.atr_id
        WHERE t.tur_id=$1 FOR UPDATE OF t`, [turId]);
    const r = rows[0]; if (!r) return;
    const ts = Math.max(Date.now(), Number(r.tur_sync_ts) + 1);
    await c.query('UPDATE turno SET tur_sync_ts=$2 WHERE tur_id=$1', [turId, ts]);
    const hhmm = hhmmFromDb(r.hor_hora);
    await this.emit(c, 'STOCK_ACTUALIZADO', r.atr_codigo, correlationId, {
      service_id: config.serviceId, item_id: r.atr_codigo, date: r.tur_fecha, time_slot: label12h(hhmm),
      available_units: r.cupos_disponibles, timestamp: ts, slot_id: r.slot_id,
    });
  }

  /** GET /atracciones/eventos — feed paginado por cursor `after`, forma CloudEvents v1.0. */
  async feed(q: Record<string, any>) {
    const after = q.after === undefined ? 0 : Number(q.after);
    if (!Number.isInteger(after) || after < 0) throw badRequest('after debe ser un entero ≥ 0.', 'INVALID_CURSOR', [{ name: 'after', reason: 'Entero ≥ 0' }]);
    const p = pageQuery({ limit: q.limit }, 50, 200);
    const params: unknown[] = [after];
    let typeSql = '';
    if (q.type) {
      if (!TYPES.includes(q.type)) throw badRequest('type inválido.', 'INVALID_EVENT_TYPE', [{ name: 'type', reason: TYPES.join(' | ') }]);
      params.push(q.type); typeSql = ` AND evt_tipo=$${params.length}`;
    }
    params.push(p.limit);
    const rows = await this.db.query(`SELECT * FROM outbox_evento WHERE evt_id > $1${typeSql} ORDER BY evt_id LIMIT $${params.length}`, params);
    return rows.map((e) => ({
      specversion: '1.0', source: '/api/v3/atracciones', event_id: e.evt_uuid, sequence_number: e.evt_id, event_type: e.evt_tipo,
      aggregate_id: e.evt_aggregate_id, correlation_id: e.evt_correlation_id ?? 'n/a', timestamp: new Date(e.evt_creado_en).toISOString(),
      payload: e.evt_payload, data: e.evt_payload,
    }));
  }
}
