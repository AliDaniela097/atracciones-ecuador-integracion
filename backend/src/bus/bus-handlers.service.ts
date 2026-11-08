import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Db } from '../db/db.service.js';
import { ReservasService } from '../reservas/reservas.service.js';
import { ApiProblem } from '../common/problem.js';
import { AmqpService, type ResultadoManejo } from './amqp.service.js';
import { campo, uuidDe, type CloudEvent } from './cloudevents.js';
import { config } from '../config.js';
import { randomUUID } from 'node:crypto';
import { bitacora } from '../observabilidad/bitacora.js';

/**
 * Qué hace la tienda con los eventos que Booking publica en el bus:
 *  - order.confirmed → solo se registra (la reserva ya se creó por la API REST).
 *  - saga.compensate / payment.refunded → se cancela la reserva (libera cupos, emite reembolso y stock), de forma idempotente.
 * El exchange es compartido con todas las tiendas: un evento solo se aplica si su identificador corresponde a una reserva NUESTRA.
 * Los campos del evento donde viaja ese identificador son configurables (AMQP_ID_FIELDS) porque Booking aún no los fijó.
 */
@Injectable()
export class BusHandlers implements OnModuleInit {
  private log = new Logger('BusEventos');
  constructor(@Inject(AmqpService) private bus: AmqpService, @Inject(ReservasService) private reservas: ReservasService, @Inject(Db) private db: Db) {}

  onModuleInit() { this.bus.setManejador((clave, ev) => this.manejar(clave, ev)); }

  /** Reserva (id interno) a la que se refiere el evento, o undefined si no es nuestra. */
  async resolverReserva(ev: CloudEvent): Promise<string | undefined> {
    for (const ruta of config.amqp.idFields) {
      const v = campo(ev, ruta);
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      const id = String(v).trim(); if (!id || id.length > 80) continue;
      try { await this.reservas.findRow(id); return id; } catch (e) { if (!(e instanceof ApiProblem && e.status === 404)) throw e; }
    }
    return undefined;
  }

  /**
   * Formato real de Booking (confirmado por el equipo de Booking): las reservas viajan en arreglos —
   * order.confirmed: data.items[] y saga.compensate: data.acciones_compensatorias[] — con reservation_code / external_order_id.
   * Una orden puede mezclar tiendas: se omiten los elementos de otro proveedor (proveedor_id) u otro tipo de servicio, y solo cuentan las reservas NUESTRAS.
   */
  async resolverReservas(ev: CloudEvent): Promise<string[]> {
    const ids = new Set<string>();
    for (const ruta of config.amqp.arrayPaths) {
      const lista = campo(ev, ruta);
      if (!Array.isArray(lista)) continue;
      for (const el of lista.slice(0, 50)) {
        if (!el || typeof el !== 'object') continue;
        if (el.proveedor_id && el.proveedor_id !== config.serviceId) continue;
        if (el.tipo_servicio && String(el.tipo_servicio).toUpperCase() !== 'ATRACCION') continue;
        for (const k of ['reservation_code', 'external_order_id', 'order_id']) {
          const v = el[k]; if (typeof v !== 'string' && typeof v !== 'number') continue;
          const id = String(v).trim(); if (!id || id.length > 80) continue;
          try { await this.reservas.findRow(id); ids.add(id); break; } catch (e) { if (!(e instanceof ApiProblem && e.status === 404)) throw e; }
        }
      }
    }
    if (!ids.size) { const uno = await this.resolverReserva(ev); if (uno) ids.add(uno); }   // compatibilidad: identificador plano en data.*
    return [...ids];
  }

  async manejar(clave: string, ev: CloudEvent): Promise<ResultadoManejo> {
    const tipo = clave.replace(/^com\.booking\./, '');
    if (!['order.confirmed', 'saga.compensate', 'payment.refunded'].includes(tipo)) return 'ignorado';
    const opId = `AMQP:${tipo}`; const uid = /^[0-9a-f-]{36}$/i.test(ev.id) ? ev.id : uuidDe(ev.id);
    const hash = createHash('sha256').update(JSON.stringify(ev)).digest('hex');
    // Consumidor idempotente: reclamar el id del evento; si ya estaba, es una reentrega.
    const ins = await this.db.query(
      `INSERT INTO idempotencia (idem_clave, idem_operacion, idem_request_hash, idem_estado, idem_expira_en) VALUES ($1,$2,$3,'IN_PROGRESS', now() + interval '7 days')
       ON CONFLICT DO NOTHING RETURNING idem_clave`, [uid, opId, hash]);
    if (!ins.length) { bitacora.registrar('BUS', `Evento ${tipo} repetido (${ev.id}): ya procesado, se ignora`, { cid: ev.correlationid }); return 'duplicado'; }
    try {
      const ids = await this.resolverReservas(ev);
      let r: ResultadoManejo = 'ignorado'; const notas: string[] = [];
      if (!ids.length) notas.push('La reserva no es de esta tienda o el evento no la identifica');
      for (const id of ids) {
        if (tipo === 'order.confirmed') { r = 'procesado'; notas.push(`Venta confirmada por Booking: ${id}`); this.log.log(notas[notas.length - 1]); continue; }
        try {
          await this.reservas.cancelar(id, { solicitante: 'SAGA_ORCHESTRATOR', reason: `Compensación por evento ${tipo} (${ev.id})` }, ev.correlationid ?? randomUUID(), { type: 'api-key', roles: ['PARTNER'] });
          r = 'procesado'; notas.push(`Reserva ${id} cancelada por ${tipo}`); this.log.log(notas[notas.length - 1]);
        } catch (e) {
          // Regla de negocio (p. ej. ya hubo check-in o ya estaba cancelada): no se reintenta, queda registrado.
          if (e instanceof ApiProblem && e.status < 500) { notas.push(`No se pudo compensar ${id}: ${e.code}`); this.log.warn(notas[notas.length - 1]); } else throw e;
        }
      }
      const nota = notas.join(' | ');
      bitacora.registrar('BUS', `Evento ${tipo} recibido de Booking → ${r}: ${nota}`, { cid: ev.correlationid, datos: { reservas: ids.length } });
      await this.db.query(`UPDATE idempotencia SET idem_estado='DONE', idem_http_status=200, idem_response=$3 WHERE idem_clave=$1 AND idem_operacion=$2`, [uid, opId, JSON.stringify({ resultado: r, nota })]);
      return r;
    } catch (e) {
      await this.db.query('DELETE FROM idempotencia WHERE idem_clave=$1 AND idem_operacion=$2', [uid, opId]).catch(() => undefined); // permite el reintento
      throw e;
    }
  }
}
