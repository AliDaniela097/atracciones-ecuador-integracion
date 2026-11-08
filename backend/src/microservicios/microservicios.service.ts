import { Inject, Injectable, Logger } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Db } from '../db/db.service.js';
import { config } from '../config.js';
import { ApiProblem, outOfStock, unprocessable } from '../common/problem.js';

/** Referencias que quedan guardadas en reserva.res_ms_ref para poder compensar y para trazabilidad. */
export interface MsRefs { dis_id: number; cantidad: number; ord_id: number; ord_numero: string; det_id: number; res_uuid: string; res_codigo: string }

export interface MsInput {
  atr_id: number; atr_nombre: string; date: string; hhmm: string; cupo_total: number; seats: number;
  adultos: number; ninos: number; precio_unit: number; idem_key: string; observaciones?: string;
  titular: { nombre: string; documento: string };
}

/**
 * Orquestador de la Saga hacia los 3 microservicios gRPC (la tienda REST actúa como API Gateway):
 *   1) ms_inventory.ReserveSlots → 2) ms_order.CreateOrder → 3) ms_booking.CreateReservation + ConfirmReservation
 * Si un paso falla, se compensa en orden inverso (LIFO). Solo se activa con MS_ENABLED=true.
 */
@Injectable()
export class MicroserviciosService {
  private log = new Logger('Microservicios');
  private clients: Record<string, any> = {};

  constructor(@Inject(Db) private db: Db) {}

  get enabled() { return config.ms.enabled; }

  // --- Aislamiento de fallos (Semana 1: "un fallo no derriba todo el sistema") ---
  private abiertoHasta = 0;
  get degrade() { return config.ms.degrade; }
  /** Cortacircuitos abierto = los microservicios fallaron hace poco; se omiten un rato (la reserva sigue solo en la tienda). */
  circuitoAbierto() { return this.degrade && Date.now() < this.abiertoHasta; }
  abrirCircuito() { this.abiertoHasta = Date.now() + config.ms.breakerMs; }
  /** Solo "no disponible" (caído/timeout) permite degradar; los errores de negocio (sin cupo, validación) NUNCA se ocultan. */
  esIndisponible(e: unknown) { return e instanceof ApiProblem && e.code === 'MICROSERVICE_UNAVAILABLE'; }

  /** Crea (si no existe) la columna de trazabilidad. Idempotente y segura. */
  async init() {
    if (!this.enabled) return;
    await this.db.query('ALTER TABLE reserva ADD COLUMN IF NOT EXISTS res_ms_ref jsonb').catch((e) => this.log.warn(`No se pudo crear res_ms_ref: ${e.message}`));
    this.log.log(`Integración con microservicios ACTIVA → inventory=${config.ms.inventory} order=${config.ms.order} booking=${config.ms.booking}`);
  }

  private client(svc: 'inventory' | 'order' | 'booking') {
    if (this.clients[svc]) return this.clients[svc];
    const map = { inventory: ['ms_inventory/proto/ms_inventory.proto', 'ms_inventory.v1', 'InventoryService'], order: ['ms_order/proto/ms_order.proto', 'ms_order.v1', 'OrderService'], booking: ['ms_booking/proto/ms_booking.proto', 'ms_booking.v1', 'BookingService'] } as const;
    const [file, pkgName, name] = map[svc];
    const def = protoLoader.loadSync(path.join(config.ms.protoDir, file), { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    const pkg: any = (grpc.loadPackageDefinition(def) as any)[pkgName.split('.')[0]][pkgName.split('.')[1]];
    this.clients[svc] = new pkg[name](config.ms[svc], grpc.credentials.createInsecure(), { 'grpc.initial_reconnect_backoff_ms': 300, 'grpc.max_reconnect_backoff_ms': 1500 });
    return this.clients[svc];
  }

  private call<T = any>(svc: 'inventory' | 'order' | 'booking', method: string, req: any): Promise<T> {
    return new Promise((resolve, reject) =>
      this.client(svc)[method](req, { deadline: new Date(Date.now() + config.ms.deadlineMs) }, (e: any, r: T) => (e ? reject(this.toProblem(svc, method, e)) : resolve(r))));
  }

  /** Traduce un error gRPC (details = JSON {code,message,invalid_params}) a un RFC 7807 de la tienda. */
  private toProblem(svc: string, method: string, e: any): ApiProblem {
    let d: any = {};
    try { d = JSON.parse(e.details); } catch { d = { message: e.details }; }
    if (e.code === grpc.status.UNAVAILABLE || e.code === grpc.status.DEADLINE_EXCEEDED)
      return new ApiProblem(503, 'MICROSERVICE_UNAVAILABLE', 'Servicio no disponible', `El microservicio ms_${svc} no respondió (${method}).`, undefined, 'service-unavailable');
    if (e.code === grpc.status.INVALID_ARGUMENT || e.code === grpc.status.FAILED_PRECONDITION)
      return unprocessable(`ms_${svc}.${method}: ${d.message ?? e.details}`, d.code ?? 'MICROSERVICE_VALIDATION', d.invalid_params);
    return new ApiProblem(502, 'MICROSERVICE_ERROR', 'Error en microservicio', `ms_${svc}.${method}: ${d.message ?? e.details}`, undefined, 'bad-gateway');
  }

  /** Garantiza que el turno exista en ms_inventory (horario + disponibilidad) y devuelve su dis_id. */
  private async ensureSlot(i: MsInput): Promise<number> {
    try { await this.call('inventory', 'CreateHorario', { atr_id: i.atr_id, hor_hora: i.hhmm, hor_cupo: i.cupo_total }); }
    catch (e: any) { if (e.code !== 'HORARIO_DUPLICATE' && !/ya tiene un horario/.test(e.detail ?? '')) throw e; }
    await this.call('inventory', 'GenerateAvailability', { atr_id: i.atr_id, fecha_desde: i.date, fecha_hasta: i.date });
    const l: any = await this.call('inventory', 'ListAvailability', { atr_id: i.atr_id, fecha_desde: i.date, fecha_hasta: i.date, limit: 100, page: 1 });
    const av = (l.data as any[]).find((x) => String(x.hor_hora).slice(0, 5) === i.hhmm);
    if (!av) throw new ApiProblem(502, 'MICROSERVICE_ERROR', 'Error en microservicio', `ms_inventory no generó disponibilidad para ${i.date} ${i.hhmm}.`, undefined, 'bad-gateway');
    return av.dis_id;
  }

  async crear(i: MsInput): Promise<MsRefs> {
    const done: Array<() => Promise<void>> = []; // pasos de compensación, se ejecutan al revés (LIFO)
    try {
      const dis_id = await this.ensureSlot(i);
      const rs: any = await this.call('inventory', 'ReserveSlots', { dis_id, cantidad: i.seats });
      if (!rs.success) throw outOfStock(`ms_inventory: ${rs.message} (${rs.error_code}).`);
      done.push(async () => { await this.call('inventory', 'ReleaseSlots', { dis_id, cantidad: i.seats }); });

      const ord: any = await this.call('order', 'CreateOrder', {
        usu_id: config.ms.usuId, ord_moneda: 'USD', ord_observaciones: `Reserva tienda atracciones (${i.atr_nombre})`.slice(0, 250), idempotency_key: randomUUID(),
        items: [{ atr_id: i.atr_id, det_descripcion: i.atr_nombre.slice(0, 200), det_cantidad: i.seats, det_precio_unitario: i.precio_unit }],
      });
      done.push(async () => { await this.call('order', 'UpdateOrderStatus', { ord_id: ord.ord_id, est_codigo: 'CANCELADA' }); });
      const det_id = ord.detalles[0].det_id;

      const res: any = await this.call('booking', 'CreateReservation', {
        det_id, dis_id, res_adultos: i.adultos, res_ninos: i.ninos, res_precio_unitario: i.precio_unit, res_observaciones: (i.observaciones ?? '').slice(0, 250),
        pasajeros: [{ pax_nombre: i.titular.nombre, pax_documento: i.titular.documento, pax_es_titular: true }],
      });
      done.push(async () => { await this.call('booking', 'CancelReservation', { res_uuid: res.res_uuid, res_motivo_cancelacion: 'Compensación de la Saga' }); });
      await this.call('booking', 'ConfirmReservation', { res_uuid: res.res_uuid });
      await this.call('order', 'UpdateOrderStatus', { ord_id: ord.ord_id, est_codigo: 'PAGADA' }).catch((e) => this.log.warn(`Orden ${ord.ord_numero} no pasó a PAGADA: ${e.detail}`));
      return { dis_id, cantidad: i.seats, ord_id: ord.ord_id, ord_numero: ord.ord_numero, det_id, res_uuid: res.res_uuid, res_codigo: res.res_codigo };
    } catch (e) {
      await this.compensate(done);
      throw e;
    }
  }

  /** Ejecuta los pasos de compensación en orden inverso; un fallo se registra y no detiene los demás. */
  async compensate(steps: Array<() => Promise<void>>) {
    for (const s of steps.reverse()) await s().catch((e) => this.log.error(`Falló una compensación: ${e.detail ?? e.message}`));
  }

  /** Compensación a partir de las referencias guardadas (cancelación posterior o fallo al guardar en la tienda). */
  async deshacer(r: MsRefs, motivo: string) {
    const steps: Array<() => Promise<void>> = [
      async () => { await this.call('inventory', 'ReleaseSlots', { dis_id: r.dis_id, cantidad: r.cantidad }); },
      async () => {
        const o: any = await this.call('order', 'GetOrder', { ord_id: r.ord_id });
        await this.call('order', 'UpdateOrderStatus', { ord_id: r.ord_id, est_codigo: o.est_codigo === 'PAGADA' ? 'REEMBOLSADA' : 'CANCELADA' });
      },
      async () => { await this.call('booking', 'CancelReservation', { res_uuid: r.res_uuid, res_motivo_cancelacion: motivo.slice(0, 250) }); },
    ];
    await this.compensate(steps);
  }
}
