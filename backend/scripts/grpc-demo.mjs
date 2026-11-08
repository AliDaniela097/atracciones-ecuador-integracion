// Demostración del canal gRPC hacia Booking (InventoryStockService.PushStockUpdate), SIN ejecutar un segundo backend:
// lee de la base el cupo ACTUAL de una atracción y lo envía por gRPC (HTTP/2) con las cabeceras service_id y x-api-key.
//   node scripts/grpc-demo.mjs --item <CODIGO_ATRACCION> [--date AAAA-MM-DD] [--target 100.93.143.85:50051]
// Usa del .env: DATABASE_URL, BOOKING_API_KEY, SERVICE_ID y BOOKING_GRPC_TARGET (o --target). Solo LEE la base: no modifica nada.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const item = arg('item'), fecha = arg('date'), target = arg('target') ?? process.env.BOOKING_GRPC_TARGET ?? 'localhost:50051';
const serviceId = process.env.SERVICE_ID ?? 'NODE_ATR_ALISSON', apiKey = process.env.BOOKING_API_KEY ?? '';
if (!item) { console.error('Uso: node scripts/grpc-demo.mjs --item <CODIGO> [--date AAAA-MM-DD] [--target host:50051]'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL en backend/.env'); process.exit(1); }
if (!apiKey) { console.error('Falta BOOKING_API_KEY en backend/.env (Booking exige la cabecera x-api-key).'); process.exit(1); }

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { label12h, hhmmFromDb, todayEC } = await import('../dist/common/util.js');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: /sslmode=require|neon\.tech/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined, max: 1 });
const { rows } = await pool.query(
  `SELECT v.slot_id, to_char(v.tur_fecha,'YYYY-MM-DD') AS fecha, v.hor_hora, v.cupos_disponibles, a.atr_codigo
     FROM v_turno_disponibilidad v JOIN atraccion a ON a.atr_id=v.atr_id
    WHERE a.atr_codigo=$1 AND v.hor_activo AND v.tur_fecha >= COALESCE($2::date, $3::date)
    ORDER BY v.tur_fecha, v.hor_hora LIMIT $4`, [item, fecha ?? null, todayEC(), fecha ? 20 : 3]);
await pool.end();
if (!rows.length) { console.error(`No hay turnos para ${item}${fecha ? ' el ' + fecha : ''}.`); process.exit(1); }

const def = protoLoader.loadSync(path.join(raiz, 'contracts/proto/inventory.proto'), { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
const pkg = grpc.loadPackageDefinition(def);
const cliente = new pkg.inventory.InventoryStockService(target, process.env.BOOKING_GRPC_TLS === 'true' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure());
console.log(`gRPC → ${target}  (HTTP/2, InventoryStockService.PushStockUpdate, service_id=${serviceId})\n`);
let fallos = 0;
for (const r of rows) {
  const msg = { service_id: serviceId, item_id: r.atr_codigo, date: r.fecha, time_slot: label12h(hhmmFromDb(String(r.hor_hora))), available_units: r.cupos_disponibles, timestamp: Date.now(), slot_id: r.slot_id };
  const md = new grpc.Metadata(); md.set('service_id', serviceId); md.set('x-api-key', apiKey);
  const ack = await new Promise((res) => cliente.PushStockUpdate(msg, md, { deadline: new Date(Date.now() + 8000) }, (e, a) => res(e ? { success: false, error_code: e.code + ' ' + e.details } : a)));
  if (!ack.success) fallos++;
  console.log(`${msg.date} ${msg.time_slot.padEnd(10)} cupos=${String(msg.available_units).padStart(3)}  →  ${ack.success ? 'OK' : 'FALLÓ'}  ${ack.error_code ?? ''} ${ack.message ?? ''}`);
}
cliente.close();
console.log(fallos ? `\n${fallos} envío(s) fallaron. Revisa la red (Tailscale) y la clave.` : '\nEnvío gRPC correcto: Booking confirmó cada turno.');
process.exit(fallos ? 1 : 0);
