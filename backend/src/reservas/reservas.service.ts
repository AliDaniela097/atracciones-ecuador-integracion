import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { PoolClient } from 'pg';
import { Db } from '../db/db.service.js';
import { ContractService } from '../contract/contract.service.js';
import { OutboxService } from '../eventos/outbox.service.js';
import { ApiProblem, badRequest, conflict, forbidden, notFound, outOfStock, unprocessable } from '../common/problem.js';
import type { Principal } from '../common/http.js';
import { hhmmFromDb, label12h, pageMeta, pageQuery, parseTime } from '../common/util.js';
import { BookingCheckinService } from '../checkin/booking-checkin.service.js';
import { checkSlotAndSemantics, normalizeReserva, type Canon, type TicketType } from './reservas.normalize.js';
import { config } from '../config.js';
import { MicroserviciosService, type MsRefs } from '../microservicios/microservicios.service.js';
import { bitacora } from '../observabilidad/bitacora.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const pnr = () => Array.from(randomBytes(7), (b) => ALPHA[b % ALPHA.length]).join('');
const TICKET_KEYS: TicketType[] = ['ADULTO', 'NINO', 'MAYOR', 'INFANTE', 'ESTUDIANTE'];
const stable = (o: any): string => (o && typeof o === 'object' ? (Array.isArray(o) ? `[${o.map(stable)}]` : `{${Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',')}}`) : JSON.stringify(o));

export interface Result { status: number; body: any; replay?: boolean }

@Injectable()
export class ReservasService implements OnModuleInit {
  constructor(@Inject(Db) private db: Db, @Inject(ContractService) private contract: ContractService, @Inject(OutboxService) private outbox: OutboxService, @Inject(MicroserviciosService) private ms: MicroserviciosService, @Inject(BookingCheckinService) private bookingCheckin: BookingCheckinService) {}

  async onModuleInit() { await this.ms.init(); }

  // ================= CREAR =================
  async crear(raw: any, idemKey: string | undefined, cid: string, _p?: Principal): Promise<Result> {
    if (!idemKey) throw badRequest('La cabecera Idempotency-Key (UUID v4) es obligatoria.', 'MISSING_IDEMPOTENCY_KEY', [{ name: 'Idempotency-Key', reason: 'Obligatoria' }]);
    if (!UUID_RE.test(idemKey)) throw badRequest('Idempotency-Key debe ser un UUID.', 'INVALID_IDEMPOTENCY_KEY', [{ name: 'Idempotency-Key', reason: 'UUID v4' }]);

    const { canon, schemaBody } = normalizeReserva(raw);
    if (canon.idempotency_key_body && canon.idempotency_key_body !== idemKey)
      throw badRequest('idempotency_key del cuerpo no coincide con la cabecera Idempotency-Key.', 'IDEMPOTENCY_KEY_MISMATCH');
    const errs = this.contract.check('CreateReservaRequestV3', schemaBody);
    if (errs.length) throw badRequest('El cuerpo no cumple el contrato CreateReservaRequestV3.', 'VALIDATION_ERROR', errs);
    checkSlotAndSemantics(canon);

    const operation = 'POST /atracciones/reservas';
    const hash = createHash('sha256').update(stable({ ...canon, correlation_id: undefined })).digest('hex');
    await this.db.query('DELETE FROM idempotencia WHERE idem_expira_en < now()').catch(() => undefined);
    const ins = await this.db.query(
      `INSERT INTO idempotencia (idem_clave, idem_operacion, idem_request_hash, idem_expira_en) VALUES ($1,$2,$3, now() + interval '24 hours')
       ON CONFLICT DO NOTHING RETURNING idem_clave`, [idemKey, operation, hash]);
    if (!ins.length) {
      for (let i = 0; i < 15; i++) {
        const ex = await this.db.one('SELECT * FROM idempotencia WHERE idem_clave=$1 AND idem_operacion=$2', [idemKey, operation]);
        if (!ex) break; // fue liberada por un fallo: se reintenta como nueva (recursión controlada abajo)
        if (ex.idem_request_hash !== hash) throw conflict('La Idempotency-Key ya fue usada con un cuerpo distinto.', 'IDEMPOTENCY_KEY_REUSED', 'Colisión de Idempotencia');
        if (ex.idem_estado === 'DONE') return { status: ex.idem_http_status, body: ex.idem_response, replay: true };
        await new Promise((r) => setTimeout(r, 200));
      }
      const again = await this.db.one('SELECT 1 FROM idempotencia WHERE idem_clave=$1 AND idem_operacion=$2', [idemKey, operation]);
      if (again) throw conflict('La petición original sigue en proceso.', 'IDEMPOTENCY_IN_PROGRESS', 'Colisión de Idempotencia');
      return this.crear(raw, idemKey, cid);
    }
    let refs: MsRefs | undefined; let degradado: { degradado: true; motivo: string; en: string } | undefined;
    try {
      if (this.ms.enabled) {
        if (this.ms.circuitoAbierto()) degradado = { degradado: true, motivo: 'cortacircuitos abierto: los microservicios fallaron hace poco', en: new Date().toISOString() };
        else {
          try { refs = await this.sagaMicroservicios(canon, idemKey); }
          catch (e) {
            if (!(this.ms.degrade && this.ms.esIndisponible(e))) throw e;           // error de negocio o modo estricto: se propaga igual que antes
            this.ms.abrirCircuito();
            degradado = { degradado: true, motivo: (e as ApiProblem).detail, en: new Date().toISOString() };
            bitacora.registrar('RESERVA', 'Microservicios no disponibles: la reserva continúa solo en la tienda (modo degradado)', { cid, nivel: 'WARN', datos: { motivo: degradado.motivo } });
          }
        }
      }
      let resId: number;
      try { resId = await this.db.tx((c) => this.crearTx(c, canon, cid)); }
      catch (e) { if (refs) await this.ms.deshacer(refs, 'Falló el registro en la tienda'); throw e; }
      if (refs ?? degradado) await this.db.query('UPDATE reserva SET res_ms_ref=$2 WHERE res_id=$1', [resId, JSON.stringify(refs ?? degradado)]);
      const body = { ...(await this.dto(resId)), success: true, message: 'Reserva confirmada exitosamente en la tienda individual.' };
      await this.db.query(`UPDATE idempotencia SET idem_estado='DONE', idem_http_status=201, idem_response=$3 WHERE idem_clave=$1 AND idem_operacion=$2`, [idemKey, operation, JSON.stringify(body)]);
      return { status: 201, body };
    } catch (e) {
      await this.db.query('DELETE FROM idempotencia WHERE idem_clave=$1 AND idem_operacion=$2', [idemKey, operation]).catch(() => undefined);
      throw e;
    }
  }

  /** Prepara los datos del turno y ejecuta la Saga en los microservicios. Si la atracción/turno/tarifa no existen devuelve undefined y crearTx responde con el 404/422 correcto. */
  private async sagaMicroservicios(k: Canon, idemKey: string): Promise<MsRefs | undefined> {
    const a = (await this.db.query(`SELECT atr_id, atr_nombre FROM atraccion WHERE atr_estado='PUBLICADA' AND atr_eliminado_en IS NULL AND (atr_codigo=$1 OR atr_slug=$1)`, [k.attraction_id]))[0];
    if (!a) return undefined;
    const t = (await this.db.query(`SELECT t.tur_cupo_total, h.hor_activo FROM turno t JOIN horario h ON h.hor_id=t.hor_id WHERE h.atr_id=$1 AND t.tur_fecha=$2 AND h.hor_hora=$3::time`, [a.atr_id, k.date, k.time24]))[0];
    if (!t || !t.hor_activo) return undefined;
    const fares = await this.db.query('SELECT tar_tipo, tar_precio FROM v_tarifa_vigente WHERE atr_id=$1', [a.atr_id]);
    let total = 0;
    for (const key of TICKET_KEYS) {
      if (!k.counts[key]) continue;
      const f = fares.find((x: any) => x.tar_tipo === key);
      if (!f) return undefined;
      total += k.counts[key] * Number(f.tar_precio);
    }
    const seats = TICKET_KEYS.reduce((s, key) => s + k.counts[key], 0);
    const adultos = k.counts.ADULTO + k.counts.MAYOR + k.counts.ESTUDIANTE;
    const ninos = k.counts.NINO + k.counts.INFANTE;
    const cu = k.customer;
    return this.ms.crear({
      atr_id: a.atr_id, atr_nombre: a.atr_nombre, date: k.date, hhmm: k.time24, cupo_total: t.tur_cupo_total, seats, adultos, ninos,
      precio_unit: Math.round((total / seats) * 100) / 100, idem_key: idemKey, observaciones: k.special_requirements ?? undefined,
      titular: { nombre: cu.full_name.trim(), documento: String(cu.document_id).trim().toUpperCase() },
    });
  }

  private async crearTx(c: PoolClient, k: Canon, cid: string): Promise<number> {
    const hhmm = k.time24;
    const a = (await c.query(`SELECT a.atr_id, a.ope_id, a.atr_nombre, a.atr_codigo FROM atraccion a WHERE a.atr_estado='PUBLICADA' AND a.atr_eliminado_en IS NULL AND (a.atr_codigo=$1 OR a.atr_slug=$1)`, [k.attraction_id])).rows[0];
    if (!a) throw notFound(`No existe la atracción '${k.attraction_id}'.`, 'ATTRACTION_NOT_FOUND');
    // Bloqueo pesimista de la fila del turno: serializa las ventas concurrentes del mismo slot (anti-sobreventa).
    const t = (await c.query(
      `SELECT t.tur_id, t.tur_cupo_total, t.tur_cupo_reservado, t.tur_cerrado, h.hor_activo
         FROM turno t JOIN horario h ON h.hor_id=t.hor_id
        WHERE h.atr_id=$1 AND t.tur_fecha=$2 AND h.hor_hora=$3::time FOR UPDATE OF t`, [a.atr_id, k.date, hhmm])).rows[0];
    if (!t || !t.hor_activo) throw notFound(`La atracción no tiene el turno ${k.slot_id}.`, 'SLOT_NOT_FOUND');
    const blocked = (await c.query('SELECT 1 FROM fecha_bloqueada WHERE atr_id=$1 AND fb_fecha=$2', [a.atr_id, k.date])).rowCount;
    const seats = TICKET_KEYS.reduce((s, key) => s + k.counts[key], 0); // los infantes ocupan cupo ($0)
    const free = t.tur_cerrado || blocked ? 0 : t.tur_cupo_total - t.tur_cupo_reservado;
    if (free < seats)
      throw outOfStock(`La atracción ${a.atr_nombre} no dispone de ${seats} cupos para el turno de las ${label12h(hhmm)} del ${k.date}. Cupos restantes: ${free}.`);

    const fares = (await c.query('SELECT tar_tipo, tar_precio FROM v_tarifa_vigente WHERE atr_id=$1', [a.atr_id])).rows;
    const lines = TICKET_KEYS.filter((key) => k.counts[key] > 0).map((key) => {
      const f = fares.find((x) => x.tar_tipo === key);
      if (!f) throw unprocessable(`La atracción no tiene tarifa vigente para el tipo de boleto ${key}.`, 'TARIFF_NOT_AVAILABLE', [{ name: key, reason: 'Sin tarifa vigente' }]);
      return { key, qty: k.counts[key], price: Number(f.tar_precio) };
    });

    const cu = k.customer;
    const cli = (await c.query(
      `INSERT INTO cliente (cli_tipo_documento, cli_documento, cli_nombre, cli_correo, cli_telefono) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (cli_tipo_documento, cli_documento) DO UPDATE SET cli_nombre=EXCLUDED.cli_nombre, cli_correo=EXCLUDED.cli_correo, cli_telefono=EXCLUDED.cli_telefono
       RETURNING cli_id`, [cu.document_type, cu.document_id, cu.full_name.trim(), cu.email, cu.phone.replace(/[\s-]/g, '')])).rows[0];
    const guia = (await c.query('SELECT gui_id FROM guia WHERE ope_id=$1 AND gui_activo ORDER BY gui_id LIMIT 1', [a.ope_id])).rows[0];
    const est = (await c.query(`SELECT est_id FROM estado_reserva WHERE est_codigo='CONFIRMED'`)).rows[0];

    const res = (await c.query(
      `INSERT INTO reserva (res_codigo, res_orden_externa, res_booking_id, tur_id, cli_id, est_id, gui_id, res_metodo_pago, res_requerimientos, res_confirmado_en)
       VALUES ('ATR-' || $1, 'ORD-ATR-' || nextval('seq_orden_externa'), $2, $3,$4,$5,$6,$7,$8, now()) RETURNING res_id, res_codigo`,
      [pnr(), k.booking_reservation_id ?? null, t.tur_id, cli.cli_id, est.est_id, guia?.gui_id ?? null, k.payment, k.special_requirements ?? null])).rows[0];
    for (const l of lines) await c.query('INSERT INTO reserva_boleto (res_id, bol_tipo, bol_cantidad, bol_precio_unit) VALUES ($1,$2,$3,$4)', [res.res_id, l.key, l.qty, l.price]);
    await c.query('UPDATE turno SET tur_cupo_reservado = tur_cupo_reservado + $2 WHERE tur_id=$1', [t.tur_id, seats]);

    const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
    const evt = { reservation_code: res.res_codigo, attraction_id: a.atr_codigo, slot_id: k.slot_id, date: k.date, tickets: seats, total_price: Math.round(total * 100) / 100, currency: 'USD' };
    await this.outbox.emit(c, 'RESERVA_CREADA', res.res_codigo, cid, evt);
    await this.outbox.emit(c, 'RESERVA_CONFIRMADA', res.res_codigo, cid, evt);
    await this.outbox.emitStock(c, t.tur_id, cid);
    return res.res_id;
  }

  // ================= LEER =================
  /** id = UUID, localizador PNR (ATR-XXXX), external_order_id o booking_reservation_id. */
  async findRow(id: string, q: Pick<Db, 'one'> = this.db) {
    const r = await q.one(
      `SELECT r.res_id FROM reserva r WHERE r.res_codigo=$1 OR r.res_orden_externa=$1 OR r.res_booking_id=$1 ${UUID_RE.test(id) ? 'OR r.res_uuid=$1::uuid' : ''} LIMIT 1`, [id]);
    if (!r) throw notFound(`No existe la reserva '${id}'.`, 'RESERVATION_NOT_FOUND');
    return r.res_id as number;
  }

  async obtener(id: string, p?: Principal) {
    const resId = await this.findRow(id);
    await this.authorize(resId, p);
    return this.dto(resId);
  }

  /** Un CLIENTE solo ve sus propias reservas (por correo); ADMIN/OPERADOR/PARTNER ven todas. */
  private async authorize(resId: number, p?: Principal) {
    if (!p || p.roles.some((r) => ['ADMIN', 'OPERADOR', 'PARTNER'].includes(r))) return;
    const row = await this.db.one('SELECT c.cli_correo FROM reserva r JOIN cliente c ON c.cli_id=r.cli_id WHERE r.res_id=$1', [resId]);
    if (!p.email || row?.cli_correo.toLowerCase() !== p.email.toLowerCase()) throw forbidden('La reserva pertenece a otro titular.');
  }

  async dto(resId: number) {
    const r = await this.db.one(
      `SELECT r.*, e.est_codigo, c.cli_nombre, c.cli_correo, c.cli_telefono, c.cli_tipo_documento, c.cli_documento,
              t.tur_fecha, h.hor_hora, a.atr_codigo, a.atr_nombre, a.atr_punto_encuentro, a.atr_direccion, ci.ciu_nombre,
              g.gui_nombre, g.gui_licencia, rm.rem_numero, rm.rem_monto
         FROM reserva r JOIN estado_reserva e ON e.est_id=r.est_id JOIN cliente c ON c.cli_id=r.cli_id
         JOIN turno t ON t.tur_id=r.tur_id JOIN horario h ON h.hor_id=t.hor_id JOIN atraccion a ON a.atr_id=h.atr_id JOIN ciudad ci ON ci.ciu_id=a.ciu_id
         LEFT JOIN guia g ON g.gui_id=r.gui_id LEFT JOIN reembolso rm ON rm.res_id=r.res_id
        WHERE r.res_id=$1`, [resId]);
    const lines = await this.db.query('SELECT * FROM reserva_boleto WHERE res_id=$1', [resId]);
    const qty = (t: string) => Number(lines.find((l) => l.bol_tipo === t)?.bol_cantidad ?? 0);
    const total = Math.round(lines.reduce((s, l) => s + l.bol_cantidad * l.bol_precio_unit, 0) * 100) / 100;
    const tickets = lines.reduce((s, l) => s + l.bol_cantidad, 0);
    const time = label12h(hhmmFromDb(r.hor_hora));
    const base = `/api/v3/atracciones/reservas/${r.res_uuid}`;
    const customer = { full_name: r.cli_nombre, nombre_completo: r.cli_nombre, email: r.cli_correo, correo: r.cli_correo, phone: r.cli_telefono, telefono: r.cli_telefono,
      document_type: r.cli_tipo_documento, tipo_documento: r.cli_tipo_documento, document_id: r.cli_documento, numero_documento: r.cli_documento };
    const guide = r.gui_nombre ? `Lic. ${r.gui_nombre} (Credencial Mintur #${r.gui_licencia})` : 'Por asignar';
    const out: any = {
      external_order_id: r.res_orden_externa, reservation_id: r.res_uuid, reservation_code: r.res_codigo, status: r.est_codigo,
      date: r.tur_fecha, time, ticket_count: tickets,
      adult_count: qty('ADULTO'), child_count: qty('NINO'), senior_count: qty('MAYOR'), student_count: qty('ESTUDIANTE'), infant_count: qty('INFANTE'),
      cantidad_adultos: qty('ADULTO'), cantidad_ninos: qty('NINO'), cantidad_seniors: qty('MAYOR'), cantidad_estudiantes: qty('ESTUDIANTE'), cantidad_infantes: qty('INFANTE'),
      total_price: total, currency: 'USD', fecha: r.tur_fecha, hora: time, precio_total: total, moneda: 'USD', estado: r.est_codigo,
      customer, guia_asignado: guide, punto_encuentro: r.atr_punto_encuentro ?? r.atr_direccion ?? r.ciu_nombre,
      voucher_qr_payload: jwt.sign({ res_id: r.res_uuid, code: r.res_codigo, doc: r.cli_documento }, config.jwtSecret),
      ics_calendar_url: `${config.publicBaseUrl.replace(/\/$/, '')}/atracciones/reservas/${r.res_uuid}/evento.ics`,
      attraction_id: r.atr_codigo, attraction_name: r.atr_nombre,
      _links: { self: base, checkin: `${base}/checkin`, cancel: `${base}/cancel` },
    };
    if (r.rem_numero) { out.reembolso_id = r.rem_numero; out.monto_reembolsado = r.rem_monto; }
    if (r.est_codigo === 'CANCELLED') delete out._links.cancel, delete out._links.checkin;
    return out;
  }

  // ================= LISTAR (admin, paginado) =================
  async listar(q: Record<string, any>) {
    const p = pageQuery(q, 20, 100);
    const where: string[] = ['TRUE']; const params: unknown[] = [];
    if (q.estado) { params.push(q.estado); where.push(`e.est_codigo=$${params.length}`); }
    if (q.atraccion) { params.push(q.atraccion); where.push(`a.atr_codigo=$${params.length}`); }
    if (q.fecha) { params.push(q.fecha); where.push(`t.tur_fecha=$${params.length}`); }
    if (q.q) { params.push(`%${String(q.q).replace(/[\\%_]/g, '\\$&')}%`); where.push(`(r.res_codigo ILIKE $${params.length} OR c.cli_nombre ILIKE $${params.length} OR c.cli_correo ILIKE $${params.length} OR c.cli_documento ILIKE $${params.length})`); }
    params.push(p.limit, p.offset);
    const rows = await this.db.query(
      `SELECT r.res_id, COUNT(*) OVER() AS total FROM reserva r JOIN estado_reserva e ON e.est_id=r.est_id JOIN cliente c ON c.cli_id=r.cli_id
         JOIN turno t ON t.tur_id=r.tur_id JOIN horario h ON h.hor_id=t.hor_id JOIN atraccion a ON a.atr_id=h.atr_id
        WHERE ${where.join(' AND ')} ORDER BY r.res_creado_en DESC, r.res_id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const data = [];
    for (const r of rows) data.push(await this.dto(r.res_id));
    return { metadata: pageMeta(rows[0]?.total ?? 0, p), data };
  }

  // ================= CANCELAR (compensación Saga) =================
  async cancelar(id: string, body: any, cid: string, p?: Principal) {
    const resId = await this.findRow(id);
    await this.authorize(resId, p);
    const solicitante = body?.solicitante ?? 'CLIENTE';
    if (!['CLIENTE', 'SAGA_ORCHESTRATOR', 'ADMIN'].includes(solicitante))
      throw badRequest('solicitante inválido.', 'VALIDATION_ERROR', [{ name: 'solicitante', reason: 'CLIENTE | SAGA_ORCHESTRATOR | ADMIN' }]);
    const reason = body?.reason ? String(body.reason).slice(0, 255) : null;
    // Un solicitante que dice ser ADMIN/SAGA debe tener el rol correspondiente.
    const privileged = p?.roles.some((r) => ['ADMIN', 'PARTNER', 'OPERADOR'].includes(r)) ?? false;
    if (solicitante !== 'CLIENTE' && !privileged) throw forbidden(`El solicitante ${solicitante} requiere rol ADMIN o credenciales de socio.`);

    await this.db.tx(async (c) => {
      const r = (await c.query(
        `SELECT r.res_id, r.res_codigo, r.tur_id, e.est_codigo, a.atr_cancelacion_gratuita, a.atr_horas_cancelacion, t.tur_fecha, h.hor_hora
           FROM reserva r JOIN estado_reserva e ON e.est_id=r.est_id JOIN turno t ON t.tur_id=r.tur_id JOIN horario h ON h.hor_id=t.hor_id JOIN atraccion a ON a.atr_id=h.atr_id
          WHERE r.res_id=$1 FOR UPDATE OF r`, [resId])).rows[0];
      if (r.est_codigo === 'CANCELLED') return; // idempotente: ya estaba cancelada
      if (['CHECKED_IN', 'COMPLETED', 'EXPIRED'].includes(r.est_codigo))
        throw conflict(`La reserva está en estado ${r.est_codigo} y no puede cancelarse.`, 'RESERVATION_NOT_CANCELLABLE');
      if (solicitante === 'CLIENTE') {
        if (!r.atr_cancelacion_gratuita) throw conflict('Esta atracción no admite cancelación gratuita.', 'CANCELLATION_NOT_ALLOWED');
        const start = new Date(`${r.tur_fecha}T${hhmmFromDb(r.hor_hora)}:00-05:00`).getTime();
        if (Date.now() > start - r.atr_horas_cancelacion * 3600_000)
          throw conflict(`El plazo de cancelación gratuita (${r.atr_horas_cancelacion} h antes) ya venció.`, 'CANCELLATION_WINDOW_EXPIRED');
      }
      const seats = Number((await c.query('SELECT COALESCE(SUM(bol_cantidad),0) AS n FROM reserva_boleto WHERE res_id=$1', [resId])).rows[0].n);
      const total = Number((await c.query('SELECT COALESCE(SUM(bol_cantidad*bol_precio_unit),0) AS n FROM reserva_boleto WHERE res_id=$1', [resId])).rows[0].n);
      await c.query(`UPDATE reserva SET est_id=(SELECT est_id FROM estado_reserva WHERE est_codigo='CANCELLED'), res_cancelado_en=now(), res_motivo_cancelacion=$2 WHERE res_id=$1`, [resId, reason]);
      await c.query('SELECT 1 FROM turno WHERE tur_id=$1 FOR UPDATE', [r.tur_id]);
      await c.query('UPDATE turno SET tur_cupo_reservado = GREATEST(tur_cupo_reservado - $2, 0) WHERE tur_id=$1', [r.tur_id, seats]);
      await c.query('INSERT INTO reembolso (res_id, rem_numero, rem_monto) VALUES ($1, $2, $3) ON CONFLICT (res_id) DO NOTHING', [resId, 'REF-ATR-' + r.res_codigo.replace(/^ATR-/, ''), total]);
      await this.outbox.emit(c, 'RESERVA_CANCELADA', r.res_codigo, cid, { reservation_code: r.res_codigo, reason, solicitante, refunded: total, currency: 'USD' });
      await this.outbox.emitStock(c, r.tur_id, cid);
    });
    if (this.ms.enabled) {
      const ref = (await this.db.one('SELECT res_ms_ref FROM reserva WHERE res_id=$1', [resId]))?.res_ms_ref as MsRefs | null;
      if (ref && !(ref as any).degradado) await this.ms.deshacer(ref, reason ?? 'Cancelada por el cliente');   // una reserva degradada nunca pasó por los microservicios
    }
    return this.dto(resId);
  }

  /** Trazabilidad: ids que tuvo la reserva en ms_inventory, ms_order y ms_booking. */
  async trazabilidad(id: string, p?: Principal) {
    const resId = await this.findRow(id);
    await this.authorize(resId, p);
    const r = await this.db.one('SELECT r.res_codigo, r.res_ms_ref FROM reserva r WHERE r.res_id=$1', [resId]).catch(() => ({ res_codigo: id, res_ms_ref: null }));
    return { reservation_code: r?.res_codigo, microservices_enabled: this.ms.enabled, microservices: r?.res_ms_ref ?? null };
  }

  // ================= CHECK-IN presencial =================
  async checkin(id: string, body: any, p?: Principal, cid?: string) {
    if (!body || typeof body.documento_identidad !== 'string' || !body.documento_identidad.trim())
      throw badRequest('documento_identidad es obligatorio.', 'VALIDATION_ERROR', [{ name: 'documento_identidad', reason: 'Obligatorio' }]);
    if (p && !p.roles.some((r) => ['ADMIN', 'OPERADOR', 'PARTNER'].includes(r))) throw forbidden('Solo el personal (guía/operador/admin) o Booking pueden registrar el check-in.');
    const resId = await this.findRow(id);
    let aviso: { codigo: string; orden: string; uuid: string; cliId: string; personas: number } | undefined;
    const hora = await this.db.tx(async (c) => {
      const r = (await c.query(
        `SELECT r.res_id, r.res_codigo, r.res_uuid, r.res_orden_externa, r.res_checkin_en, e.est_codigo, cl.cli_documento, cl.cli_id,
                (SELECT COALESCE(SUM(bol_cantidad),0) FROM reserva_boleto WHERE res_id=r.res_id)::int AS personas
           FROM reserva r JOIN estado_reserva e ON e.est_id=r.est_id JOIN cliente cl ON cl.cli_id=r.cli_id WHERE r.res_id=$1 FOR UPDATE OF r`, [resId])).rows[0];
      aviso = { codigo: r.res_codigo, orden: r.res_orden_externa, uuid: r.res_uuid, cliId: String(r.cli_id), personas: Number(r.personas) };
      if (r.cli_documento.toLowerCase() !== body.documento_identidad.trim().toLowerCase()) throw forbidden('El documento presentado no coincide con el del titular de la reserva.');
      if (body.codigo_voucher_qr) {
        const v = String(body.codigo_voucher_qr);
        let ok = v === r.res_codigo;
        if (!ok) { try { ok = (jwt.verify(v, config.jwtSecret) as any).res_id === r.res_uuid; } catch { ok = false; } }
        if (!ok) throw forbidden('El código QR/voucher no corresponde a esta reserva.');
      }
      if (r.est_codigo === 'CHECKED_IN') return r.res_checkin_en as Date; // idempotente
      if (r.est_codigo !== 'CONFIRMED') throw conflict(`La reserva está en estado ${r.est_codigo}; solo una reserva CONFIRMED admite check-in.`, 'CHECKIN_NOT_ALLOWED');
      const guia = body.guia_asignado || body.guia_codigo
        ? (await c.query(`SELECT gui_id FROM guia WHERE gui_activo AND (gui_licencia ILIKE $1 OR gui_nombre ILIKE $1) LIMIT 1`, [String(body.guia_codigo ?? body.guia_asignado)])).rows[0] : undefined;
      const up = (await c.query(
        `UPDATE reserva SET est_id=(SELECT est_id FROM estado_reserva WHERE est_codigo='CHECKED_IN'), res_checkin_en=now(), gui_id=COALESCE($2, gui_id) WHERE res_id=$1 RETURNING res_checkin_en`, [resId, guia?.gui_id ?? null])).rows[0];
      return up.res_checkin_en as Date;
    });
    const d = await this.dto(resId);
    // Contrato v3.1: tras emitir el check-in se avisa a Booking Central (no bloquea ni revierte el check-in local si Booking no responde).
    let booking: { notificado: boolean; estado: string; detalle?: string } = { notificado: false, estado: 'NO_APLICA' };
    if (aviso) {
      const extId = ({ code: aviso.codigo, orden: aviso.orden, uuid: aviso.uuid } as Record<string, string>)[config.booking.checkinId] ?? aviso.codigo;
      const asist = Number.isInteger(Number(body.asistentes_reales)) && Number(body.asistentes_reales) > 0 ? Number(body.asistentes_reales) : Math.max(aviso.personas, 1);
      booking = await this.bookingCheckin.notificar({
        externalOrderId: extId, clientId: aviso.cliId, asistentesReales: asist, correlationId: cid,
        adminId: String(body.admin_id ?? p?.email ?? (p?.id !== undefined ? `usuario-${p.id}` : 'guia-turistico')).slice(0, 80),
        fechaCheckin: new Date(hora).toISOString(),
        observaciones: String(body.observaciones ?? `Turista validado en punto de encuentro${body.codigo_voucher_qr ? ' con código QR' : ''} y documento de identidad`).slice(0, 300),
      });
    }
    return {
      booking_checkin: booking,
      reserva_id: d.reservation_id, reservation_code: d.reservation_code, estado: 'CHECKED_IN', titular_nombre: d.customer.full_name, titular_documento: d.customer.document_id,
      guia_asignado: body.guia_asignado ?? d.guia_asignado, punto_encuentro: d.punto_encuentro, hora_checkin: new Date(hora).toISOString(),
    };
  }

  /** Archivo .ics (iCalendar) de la reserva — contrato: ics_calendar_url. */
  async ics(id: string) {
    const d = await this.dto(await this.findRow(id));
    const [h, m] = parseTime(d.time)!.split(':').map(Number);
    const start = `${d.date.replace(/-/g, '')}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Atracciones Ecuador//ES', 'BEGIN:VEVENT', `UID:${d.reservation_id}@atracciones`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART;TZID=America/Guayaquil:${start}`, `SUMMARY:${esc(d.attraction_name)}`, `LOCATION:${esc(d.punto_encuentro)}`, `DESCRIPTION:Localizador ${d.reservation_code}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }
}
export { ApiProblem };
