// Integración REST (gateway) → microservicios gRPC. Usa Postgres LOCAL y borra sus bases.
//   npm run build && npm run test:ms
import 'dotenv/config';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { startMock } from '../../microservicios/scripts/booking-mock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const msRoot = path.resolve(root, '../microservicios');
const dbUrl = process.env.DATABASE_URL;
const PG = (process.env.E2E_PG ?? 'postgresql://postgres:postgres@localhost:5432').replace(/\/$/, '');
const local = (u) => /@(localhost|127\.0\.0\.1)[:/]/.test(u);
if (!local(dbUrl ?? '') || !local(PG)) { console.error('Rechazado: este script BORRA bases y solo corre contra Postgres local.'); process.exit(1); }
const MS = { inventory: 50171, order: 50172, booking: 50173 }, MOCK = 50181, PORT = 3102, BASE = `http://localhost:${PORT}/api/v3`, KEY = 'clave-ms';

let pass = 0, fail = 0;
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} esperado ${JSON.stringify(b)}, recibido ${JSON.stringify(a)}`); };
const ok = (c, m = 'condición falsa') => { if (!c) throw new Error(m); };
const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✔ ${n}`); } catch (e) { fail++; console.log(`  ✘ ${n}\n      ${e.message}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const cedula = (seed) => { const d = [1, 7, Number(String(seed).padStart(7, '0')[0]) % 6, ...String(seed).padStart(7, '0').slice(1).split('').map(Number)].slice(0, 9); let s = 0; d.forEach((x, i) => { let v = x * (i % 2 === 0 ? 2 : 1); if (v > 9) v -= 9; s += v; }); return d.join('') + ((10 - (s % 10)) % 10); };
const slotOf = (date, hhmm) => `slot-${date.replace(/-/g, '')}-${hhmm.replace(':', '')}`;
const reserva = (o = {}) => ({ attraction_id: 'PRhu4UBTWPBC', slot_id: slotOf(addDays(5), '09:00'), date: addDays(5), time: '09:00 a.m.', adult_count: 2, child_count: 1,
  customer: { full_name: 'María José Flores', email: 'turista@epn.edu.ec', phone: '+593991234567', document_type: 'CEDULA', document_id: cedula(1000001) }, payment_method: { method: 'CREDIT_CARD' }, ...o });
async function http(method, p, { body, headers = {} } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': KEY, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text };
}
const post = (b, key = randomUUID()) => http('POST', '/atracciones/reservas', { body: b, headers: { 'idempotency-key': key } });
const esperarPuerto = (port) => new Promise((res, rej) => { const t0 = Date.now(); const i = () => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(); }); s.on('error', () => { s.destroy(); Date.now() - t0 > 20000 ? rej(new Error(`puerto ${port}`)) : setTimeout(i, 200); }); }; i(); });
function cliente(ms, paquete, servicio, port) {
  const def = protoLoader.loadSync(path.join(msRoot, ms, 'proto', `${ms}.proto`), { keepCase: true, longs: Number, defaults: true, arrays: true });
  const C = paquete.split('.').reduce((o, k) => o[k], grpc.loadPackageDefinition(def))[servicio]; const c = new C(`localhost:${port}`, grpc.credentials.createInsecure());
  return new Proxy({}, { get: (_, m) => (req = {}) => new Promise((res, rej) => c[m](req, { deadline: Date.now() + 8000 }, (e, r) => (e ? rej(e) : res(r)))) });
}

console.log('▶ Preparando bases locales, Booking simulado, 3 microservicios y la API (MS_ENABLED=true)…');
const env = { ...process.env, PORT: String(PORT), BOOKING_API_KEYS: KEY, GRPC_ENABLED: 'true', BOOKING_GRPC_TARGET: `localhost:${MOCK}`, GRPC_DISPATCH_INTERVAL_MS: '300', MS_ENABLED: 'true', MS_DEGRADE_ON_FAILURE: 'false', MS_INVENTORY_TARGET: `localhost:${MS.inventory}`, MS_ORDER_TARGET: `localhost:${MS.order}`, MS_BOOKING_TARGET: `localhost:${MS.booking}`,
  JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret', ADMIN_EMAIL: 'admin@atracciones.test', ADMIN_PASSWORD: 'Admin12345!', VALIDATE_CEDULA: 'true' };
const rs = spawnSync('node', ['scripts/db.mjs', 'reset'], { cwd: root, env, encoding: 'utf8' }); if (rs.status !== 0) { console.error(rs.stdout, rs.stderr); process.exit(1); }
for (const n of ['inventory', 'order', 'booking']) execFileSync(process.execPath, ['scripts/db.mjs', 'reset'], { cwd: path.join(msRoot, `ms_${n}`), env: { ...process.env, DATABASE_URL: `${PG}/ms_${n}` }, stdio: 'ignore' });
const mock = await startMock({ port: MOCK });
const procs = {};
const arrancar = (n) => { procs[n] = spawn(process.execPath, ['src/server.mjs'], { cwd: path.join(msRoot, `ms_${n}`), stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, DATABASE_URL: `${PG}/ms_${n}`, GRPC_PORT: String(MS[n]), BOOKING_GRPC_TARGET: `localhost:${MOCK}`, BOOKING_GRPC_TLS: 'false', GRPC_ENABLED: 'false', GRPC_RETRY_MS: '1500', SERVICE_ID: 'NODE_ATR_ALISSON' } }); };
['inventory', 'order', 'booking'].forEach(arrancar);
await Promise.all(Object.values(MS).map(esperarPuerto));
const srv = spawn('node', ['dist/main.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/atracciones/health')).ok) break; } catch {} await sleep(250); }
const inv = cliente('ms_inventory', 'ms_inventory.v1', 'InventoryService', MS.inventory);
const ord = cliente('ms_order', 'ms_order.v1', 'OrderService', MS.order);
const bok = cliente('ms_booking', 'ms_booking.v1', 'BookingService', MS.booking);
const cupos = async (atr, fecha) => { const l = await inv.ListAvailability({ atr_id: atr, fecha_desde: fecha, fecha_hasta: fecha, limit: 100 }); return l.data.find((x) => x.hor_hora.startsWith('09:00')); };
let atrId, refs, resCode;

try {
  console.log('\n■ POST /reservas pasa por ms_inventory → ms_order → ms_booking');
  await t('crea la reserva (201) y deja trazabilidad en los 3 microservicios', async () => {
    const r = await post(reserva()); eq(r.status, 201, r.text); resCode = r.json.reservation_code;
    const tr = await http('GET', `/atracciones/reservas/${r.json.reservation_id}/trazabilidad`); eq(tr.status, 200, tr.text);
    refs = tr.json.microservices; ok(refs && refs.res_codigo.startsWith('DEC-') && refs.ord_numero.startsWith('ORD-'), JSON.stringify(tr.json));
    const b = await bok.GetReservation({ res_uuid: refs.res_uuid }); eq(b.est_codigo, 'CONFIRMADA'); eq(b.res_numero_tickets, 3);
    const o = await ord.GetOrder({ ord_id: refs.ord_id }); eq(o.est_codigo, 'PAGADA');
    const dis = await inv.GetAvailability({ dis_id: refs.dis_id }); eq(dis.dis_cupo_reservado, 3); atrId = dis.atr_id;
  });
  await t('Booking recibe el stock con item_id = código de la atracción (lo envía el backend)', async () => {
    const k = `PRhu4UBTWPBC|slot-${addDays(5).replace(/-/g, '')}-0900`; let v;
    for (let i = 0; i < 50; i++) { v = mock.slots.get(k); if (v) break; await sleep(100); }
    ok(v, `Booking no recibió ${k}; claves: ${[...mock.slots.keys()].join(', ')}`); eq(v.available, 17);
  });
  await t('la misma Idempotency-Key devuelve la misma reserva sin duplicar en ms_booking', async () => {
    const key = randomUUID(); const a = await post(reserva({ adult_count: 1, child_count: 0 }), key); const b = await post(reserva({ adult_count: 1, child_count: 0 }), key);
    eq(a.status, 201); eq(b.status, 201); eq(b.json.reservation_code, a.json.reservation_code);
    const l = await bok.ListReservations({ est_codigo: 'CONFIRMADA', limit: 100 }); eq(l.metadata.total_results, 2);
  });
  await t('sin cupo → 409 OUT_OF_STOCK y no se crea orden ni reserva', async () => {
    const antes = (await ord.ListOrders({ limit: 100 })).metadata.total_results;
    const r = await post(reserva({ adult_count: 25, child_count: 0 })); eq(r.status, 409, r.text); eq(r.json.code, 'OUT_OF_STOCK');
    eq((await ord.ListOrders({ limit: 100 })).metadata.total_results, antes);
  });
  await t('cancelar → ms_booking CANCELADA, orden REEMBOLSADA y cupos liberados', async () => {
    const antes = (await inv.GetAvailability({ dis_id: refs.dis_id })).dis_cupo_reservado;
    const r = await http('POST', `/atracciones/reservas/${resCode}/cancel`, { body: { solicitante: 'SAGA_ORCHESTRATOR', reason: 'prueba' } }); eq(r.status, 200, r.text);
    eq((await bok.GetReservation({ res_uuid: refs.res_uuid })).est_codigo, 'CANCELADA');
    eq((await ord.GetOrder({ ord_id: refs.ord_id })).est_codigo, 'REEMBOLSADA');
    eq((await inv.GetAvailability({ dis_id: refs.dis_id })).dis_cupo_reservado, antes - 3);
  });
  await t('ms_booking caído → 503 y la compensación libera el cupo y cancela la orden', async () => {
    const antes = (await cupos(atrId, addDays(5))).dis_cupo_reservado; const ordenes = (await ord.ListOrders({ limit: 100 })).metadata.total_results;
    procs.booking.kill(); await sleep(500);
    const r = await post(reserva({ adult_count: 2, child_count: 0 })); eq(r.status, 503, r.text); eq(r.json.code, 'MICROSERVICE_UNAVAILABLE');
    eq((await cupos(atrId, addDays(5))).dis_cupo_reservado, antes, 'cupo liberado');
    const l = await ord.ListOrders({ limit: 100 }); eq(l.metadata.total_results, ordenes + 1); eq(l.data.at(0).est_codigo, 'CANCELADA');
    const loc = await http('GET', `/atracciones/reservas?limit=1`); ok(true, '');
  });
  await t('al volver ms_booking, el flujo se recupera', async () => {
    arrancar('booking'); await esperarPuerto(MS.booking); await sleep(2500);
    const r = await post(reserva({ adult_count: 1, child_count: 0 })); eq(r.status, 201, r.text);
  });
} finally {
  console.log(`\nResultado: ${pass} ✔  ${fail} ✘`);
  if (fail) console.log(log.split('\n').slice(-15).join('\n'));
  srv.kill(); Object.values(procs).forEach((p) => p.kill()); await mock.close?.(); process.exit(fail ? 1 : 0);
}
