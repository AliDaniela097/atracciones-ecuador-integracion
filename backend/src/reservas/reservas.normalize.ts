import { parseSlot, parseTime, slotId, isRealDate, todayEC, cedulaValida, telefonoValido } from '../common/util.js';
import { ApiProblem, badRequest, unprocessable, type InvalidParam } from '../common/problem.js';
import { config } from '../config.js';

export type TicketType = 'ADULTO' | 'NINO' | 'MAYOR' | 'INFANTE' | 'ESTUDIANTE';
export interface Canon {
  attraction_id: string; slot_id: string; date: string; time: string; time24: string;
  counts: Record<TicketType, number>; special_requirements?: string;
  customer: { full_name: string; email: string; phone: string; document_type: string; document_id: string };
  payment: string; booking_reservation_id?: string; idempotency_key_body?: string; correlation_id?: string;
}

const num = (v: unknown, def: number) => (v === undefined || v === null || v === '' ? def : typeof v === 'string' && v.trim() !== '' ? Number(v) : (v as number));
const first = (...v: unknown[]) => v.find((x) => x !== undefined && x !== null && x !== '');
const PAY: Record<string, string> = {
  CREDIT_CARD: 'CREDIT_CARD', DEBIT_CARD: 'DEBIT_CARD', PAYPAL: 'PAYPAL', TRANSFER: 'TRANSFER', BOOKING_GATEWAY: 'BOOKING_GATEWAY',
  TARJETA_CREDITO: 'CREDIT_CARD', TRANSFERENCIA: 'TRANSFER', SOA_BOOKING_GATEWAY: 'BOOKING_GATEWAY', PAGO_EN_SITIO: 'ON_SITE', ON_SITE: 'ON_SITE',
};

/**
 * Ley de Postel: acepta la forma v3 (inglés), los alias en español de v2 y la forma abreviada que
 * Booking envía por REST outbound (customer.name, total_tickets, sin document_type ni payment_method).
 * Devuelve el cuerpo canónico v3 o lanza 400/422 con invalid_params.
 */
export function normalizeReserva(raw: any): { canon: Canon; schemaBody: any } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('El cuerpo debe ser un objeto JSON.', 'INVALID_BODY');
  const c = raw.customer ?? raw.cliente ?? {};
  const docId = first(c.document_id, c.numero_documento, c.documento, c.cedula);
  const docType = first(c.document_type, c.tipo_documento) ?? (docId ? (/^\d{10}$/.test(String(docId)) ? 'CEDULA' : /^\d{13}$/.test(String(docId)) ? 'RUC' : 'PASAPORTE') : undefined);
  const pm = raw.payment_method ?? raw.metodo_pago;
  const pmRaw = typeof pm === 'object' && pm ? pm.method : pm;
  const payment = PAY[String(pmRaw ?? 'BOOKING_GATEWAY').toUpperCase()];
  if (!payment) throw badRequest(`payment_method '${pmRaw}' no soportado.`, 'VALIDATION_ERROR', [{ name: 'payment_method.method', reason: 'CREDIT_CARD | DEBIT_CARD | PAYPAL | TRANSFER | BOOKING_GATEWAY | ON_SITE' }]);

  const timeRaw = first(raw.time, raw.hora, raw.time_24h, raw.hora_24h);
  const dateRaw = first(raw.date, raw.fecha);
  const counts = {
    ADULTO: num(first(raw.adult_count, raw.cantidad_adultos), NaN), NINO: num(first(raw.child_count, raw.cantidad_ninos), 0),
    MAYOR: num(first(raw.senior_count, raw.cantidad_seniors), 0), INFANTE: num(first(raw.infant_count, raw.cantidad_infantes), 0),
    ESTUDIANTE: num(first(raw.student_count, raw.cantidad_estudiantes), 0),
  };
  const canonical = {
    attraction_id: first(raw.attraction_id, raw.atraccion_id), slot_id: raw.slot_id, date: dateRaw, time: timeRaw,
    adult_count: Number.isNaN(counts.ADULTO) ? undefined : counts.ADULTO, child_count: counts.NINO, senior_count: counts.MAYOR, infant_count: counts.INFANTE, student_count: counts.ESTUDIANTE,
    special_requirements: first(raw.special_requirements, raw.observaciones),
    customer: { full_name: first(c.full_name, c.nombre_completo, c.name, c.nombre), email: first(c.email, c.correo), phone: first(c.phone, c.telefono), document_type: docType, document_id: docId === undefined ? undefined : String(docId) },
    payment_method: { method: payment === 'BOOKING_GATEWAY' || payment === 'ON_SITE' ? 'TRANSFER' : payment }, // solo para validar el esquema
  };
  // Los conteos fuera de rango son error SEMÁNTICO (422), no sintáctico: se acotan para el esquema y se revisan después.
  const schemaBody: any = JSON.parse(JSON.stringify(canonical));
  if (Number.isInteger(schemaBody.adult_count) && schemaBody.adult_count < 1) schemaBody.adult_count = 1;
  for (const k of ['child_count', 'senior_count', 'infant_count', 'student_count']) if (Number.isInteger(schemaBody[k]) && schemaBody[k] < 0) schemaBody[k] = 0;

  const canon: Canon = {
    attraction_id: String(canonical.attraction_id ?? ''), slot_id: String(raw.slot_id ?? ''), date: String(dateRaw ?? ''), time: String(timeRaw ?? ''), time24: '',
    counts, special_requirements: canonical.special_requirements as string | undefined,
    customer: { full_name: String(canonical.customer.full_name ?? ''), email: String(canonical.customer.email ?? ''), phone: String(canonical.customer.phone ?? ''), document_type: String(docType ?? ''), document_id: String(docId ?? '') },
    payment, booking_reservation_id: raw.booking_reservation_id ? String(raw.booking_reservation_id) : undefined,
    idempotency_key_body: raw.idempotency_key ? String(raw.idempotency_key) : undefined, correlation_id: raw.correlation_id,
  };
  return { canon, schemaBody };
}

/** Reglas de la sección 1.1 del contrato: 400 SLOT_TIME_MISMATCH y 422 semántico. */
export function checkSlotAndSemantics(k: Canon) {
  const slot = parseSlot(k.slot_id);
  if (!slot) throw badRequest(`slot_id '${k.slot_id}' no tiene el formato slot-YYYYMMDD-HHMM.`, 'INVALID_SLOT_ID', [{ name: 'slot_id', reason: 'Formato slot-YYYYMMDD-HHMM' }]);
  if (!isRealDate(k.date)) throw badRequest("date debe tener formato YYYY-MM-DD.", 'INVALID_DATE', [{ name: 'date', reason: 'Formato YYYY-MM-DD' }]);
  const t = parseTime(k.time);
  if (!t) throw badRequest(`time '${k.time}' no es una hora reconocible (ej. '10:30 a.m.' o '10:30:00').`, 'INVALID_TIME', [{ name: 'time', reason: "Ej. '10:30 a.m.' o '10:30:00'" }]);
  k.time24 = t;
  if (slot.date !== k.date || slot.time !== t) {
    const dateBad = slot.date !== k.date;
    throw new ApiProblem(400, 'SLOT_TIME_MISMATCH', 'Inconsistencia de Franja Horaria (Slot Mismatch)',
      `El slot_id '${k.slot_id}' corresponde a las ${slot.time}:00 del ${slot.date}, pero se envió ${dateBad ? `'date': '${k.date}'` : `'time': '${k.time}'`}.`,
      [{ name: dateBad ? 'date' : 'time', reason: `No coincide con el slot ${slotId(slot.date, slot.time)}` }], 'slot-mismatch');
  }
  const sem: InvalidParam[] = [];
  if (!Number.isInteger(k.counts.ADULTO) || k.counts.ADULTO < 1) sem.push({ name: 'adult_count', reason: 'Debe ser un entero ≥ 1.' });
  for (const [n, key] of [['child_count', 'NINO'], ['senior_count', 'MAYOR'], ['infant_count', 'INFANTE'], ['student_count', 'ESTUDIANTE']] as const)
    if (!Number.isInteger(k.counts[key]) || k.counts[key] < 0) sem.push({ name: n, reason: 'Debe ser un entero ≥ 0.' });
  if (k.date < todayEC()) sem.push({ name: 'date', reason: 'La fecha de la reserva no puede estar en el pasado.' });
  const cu = k.customer;
  if (cu.full_name.trim().split(/\s+/).filter((w) => w.length > 0).length < 2 || !/^[\p{L}\s.'-]+$/u.test(cu.full_name))
    sem.push({ name: 'customer.full_name', reason: 'Debe tener al menos 2 palabras alfabéticas.' });
  if (!telefonoValido(cu.phone)) sem.push({ name: 'customer.phone', reason: 'El formato debe ser internacional E.164 o celular ecuatoriano (09XXXXXXXX).' });
  if (cu.document_type === 'CEDULA' && config.validateCedula && !cedulaValida(cu.document_id)) sem.push({ name: 'customer.document_id', reason: 'La cédula no supera la validación módulo 10 del Registro Civil.' });
  if (cu.document_type === 'PASAPORTE' && !/^[A-Za-z0-9]{6,9}$/.test(cu.document_id)) sem.push({ name: 'customer.document_id', reason: 'El pasaporte debe tener entre 6 y 9 caracteres alfanuméricos.' });
  if (cu.document_type === 'RUC' && !/^\d{13}$/.test(cu.document_id)) sem.push({ name: 'customer.document_id', reason: 'El RUC debe tener 13 dígitos.' });
  if (sem.length) throw unprocessable('La reserva no supera la validación semántica; no se inició ningún cobro.', 'SEMANTIC_VALIDATION_FAILED', sem);
}
