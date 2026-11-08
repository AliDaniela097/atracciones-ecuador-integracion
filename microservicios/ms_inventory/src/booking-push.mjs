// ms_inventory es CLIENTE gRPC de Booking (inventory.proto oficial): cada cambio de cupo se avisa con PushStockUpdate.
//   item_id <- atr_id · date <- dis_fecha · available_units <- (dis_cupo_total - dis_cupo_reservado) · slot_id <- slot-YYYYMMDD-HHMM
// Regla de Booking: timestamp monotónico por turno (si llega uno menor responde STALE_TIMESTAMP_IGNORED).
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leer, label12h } from './slot.mjs';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_ID = process.env.SERVICE_ID ?? 'NODE_ATR_ALISSON';
export const estado = {
  enabled: process.env.GRPC_ENABLED !== 'false', target: process.env.BOOKING_GRPC_TARGET ?? 'localhost:50051',
  sent_ok: 0, sent_failed: 0, stale_ignored: 0, last_ok_at: '', last_error: '',
};
let client; let ultimoTs = 0;
const siguienteTs = () => (ultimoTs = Math.max(Date.now(), ultimoTs + 1));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function getClient() {
  if (client) return client;
  const def = protoLoader.loadSync(path.join(raiz, 'proto/booking/inventory.proto'), { keepCase: true, longs: Number, enums: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(def);
  const creds = process.env.BOOKING_GRPC_TLS === 'true' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  client = new pkg.inventory.InventoryStockService(estado.target, creds);
  return client;
}
const llamar = (msg) => new Promise((resolve, reject) =>
  getClient().PushStockUpdate(msg, { deadline: Date.now() + 5000 }, (e, r) => (e ? reject(e) : resolve(r))));

async function enviarActual(disId) {
  if (!estado.enabled) return { success: false, error_code: 'GRPC_DISABLED', message: 'GRPC_ENABLED=false' };
  const av = await leer(disId);                           // siempre se envía el valor MÁS RECIENTE de la base
  if (!av) return { success: false, error_code: 'AVAILABILITY_NOT_FOUND', message: `dis_id ${disId} no existe` };
  let ultimoError = '';
  for (let intento = 0; intento < 3; intento++) {
    const msg = { service_id: SERVICE_ID, item_id: String(av.atr_id), date: av.dis_fecha, time_slot: label12h(av.hor_hora),
      available_units: av.dis_cerrada ? 0 : av.cupos_disponibles, timestamp: siguienteTs(), slot_id: av.slot_id };
    try {
      const ack = await llamar(msg);
      if (ack.success) { estado.sent_ok++; estado.last_ok_at = new Date().toISOString(); return { success: true, error_code: '', message: 'OK' }; }
      if (ack.error_code === 'STALE_TIMESTAMP_IGNORED') { estado.stale_ignored++; return { success: true, error_code: ack.error_code, message: 'Booking ya tenía un dato más reciente.' }; }
      estado.sent_failed++; estado.last_error = `${ack.error_code}: ${ack.message}`;           // error de negocio (ITEM_NOT_FOUND, INVALID_SLOT)
      return { success: false, error_code: ack.error_code, message: ack.message };
    } catch (e) {                                                                               // error de transporte: se reintenta con espera creciente
      ultimoError = e.details || e.message;
      await dormir(300 * 2 ** intento);
    }
  }
  estado.sent_failed++; estado.last_error = `Transporte: ${ultimoError}`;
  return { success: false, error_code: 'BOOKING_UNREACHABLE', message: ultimoError };
}

// Un solo envío a la vez por turno: así el último envío siempre lleva el valor más nuevo y el timestamp más alto.
const cadenas = new Map();
const RETRY_MS = Number(process.env.GRPC_RETRY_MS ?? 15000);     // si Booking no responde, se reintenta el turno más tarde (en memoria)
const MAX_REINTENTOS = 40; const pendientes = new Set();
function reintentarLuego(disId, intento) {
  if (pendientes.has(disId) || intento >= MAX_REINTENTOS) return;
  pendientes.add(disId);
  setTimeout(() => { pendientes.delete(disId); sincronizar(disId, intento + 1).catch(() => {}); }, RETRY_MS).unref();
}
export function sincronizar(disId, intento = 0) {
  const previa = cadenas.get(disId) ?? Promise.resolve();
  const actual = previa.then(() => enviarActual(disId), () => enviarActual(disId));
  actual.then((r) => { if (r.error_code === 'BOOKING_UNREACHABLE') reintentarLuego(disId, intento); }).catch(() => {});
  cadenas.set(disId, actual);
  actual.finally(() => { if (cadenas.get(disId) === actual) cadenas.delete(disId); }).catch(() => {});
  return actual;
}
export const sincronizarEnSegundoPlano = (ids) => { for (const id of ids) sincronizar(id).catch(() => {}); };
export const cerrarCliente = () => client?.close();
