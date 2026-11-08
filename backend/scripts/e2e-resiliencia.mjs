// Aislamiento de fallos: si un microservicio se cae, la tienda NO se cae (Semana 1: "un fallo no derriba todo el sistema"). Usa Postgres LOCAL y borra sus bases.
//   npm run build && npm run test:resiliencia
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
const MS = { inventory: 50271, order: 50272, booking: 50273 }, MOCK = 50281, PORT = 3103, BASE = `http://localhost:${PORT}/api/v3`, KEY = 'clave-ms';

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

console.log('▶ Preparando bases locales, Booking simulado, 3 microservicios y la API (MS_ENABLED=true, modo degradado)…');
const env = { ...process.env, PORT: String(PORT), BOOKING_API_KEYS: KEY, GRPC_ENABLED: 'true', BOOKING_GRPC_TARGET: `localhost:${MOCK}`, GRPC_DISPATCH_INTERVAL_MS: '300', MS_ENABLED: 'true', MS_DEGRADE_ON_FAILURE: 'true', MS_BREAKER_MS: '1500', MS_INVENTORY_TARGET: `localhost:${MS.inventory}`, MS_ORDER_TARGET: `localhost:${MS.order}`, MS_BOOKING_TARGET: `localhost:${MS.booking}`,
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
let refs, codeDegradada, idDegradada;
const mockDisp = async (min, max = min) => { const k = `PRhu4UBTWPBC|slot-${addDays(5).replace(/-/g, '')}-0900`; for (let i = 0; i < 60; i++) { const v = mock.slots.get(k)?.available; if (v >= min && v <= max) return v; await sleep(100); } return mock.slots.get(k)?.available; };
const traza = async (id) => (await http('GET', `/atracciones/reservas/${id}/trazabilidad`)).json?.microservices;

try {
  console.log('\n■ Con todo arriba, la reserva pasa por los 3 microservicios (como siempre)');
  await t('201 y trazabilidad completa, sin marca de degradada', async () => {
    const r = await post(reserva()); eq(r.status, 201, r.text);
    refs = await traza(r.json.reservation_id); ok(refs?.res_codigo && !refs.degradado, JSON.stringify(refs));
    eq(await mockDisp(17), 17, 'Booking debe ver 17 cupos');
  });

  console.log('\n■ Se cae ms_booking: la tienda sigue vendiendo');
  await t('ms_booking caído → la reserva igual se confirma (201) y queda marcada como degradada', async () => {
    procs.booking.kill(); await sleep(500);
    const r = await post(reserva({ adult_count: 2, child_count: 0 })); eq(r.status, 201, r.text);
    codeDegradada = r.json.reservation_code; idDegradada = r.json.reservation_id;
    const m = await traza(idDegradada); eq(m?.degradado, true, JSON.stringify(m));
  });
  await t('el stock hacia Booking baja igual (la base de la tienda es la fuente de verdad)', async () => { eq(await mockDisp(15), 15); });
  await t('la bitácora deja constancia de la degradación (nivel WARN)', async () => { ok(log.includes('modo degradado'), 'no aparece "modo degradado" en el log'); });
  await t('cancelar la reserva degradada funciona sin tocar los microservicios (200) y libera el cupo', async () => {
    const r = await http('POST', `/atracciones/reservas/${codeDegradada}/cancel`, { body: { solicitante: 'SAGA_ORCHESTRATOR', reason: 'prueba' } }); eq(r.status, 200, r.text);
    eq(await mockDisp(17), 17);
  });

  console.log('\n■ Se caen los 3 microservicios: catálogo, reservas y salud siguen respondiendo');
  await t('con los 3 caídos: GET catálogo 200, health 200 y reserva 201', async () => {
    procs.inventory.kill(); procs.order.kill(); await sleep(600);
    const c = await http('GET', '/atracciones?page=1&limit=5'); eq(c.status, 200, c.text);
    const h = await fetch(BASE + '/atracciones/health'); eq(h.status, 200);
    const r = await post(reserva({ adult_count: 1, child_count: 0 })); eq(r.status, 201, r.text);
    eq((await traza(r.json.reservation_id))?.degradado, true);
  });
  await t('con el cortacircuitos abierto la reserva NO espera 8 s (responde rápido)', async () => {
    const t0 = Date.now(); const r = await post(reserva({ adult_count: 1, child_count: 0 })); eq(r.status, 201, r.text);
    ok(Date.now() - t0 < 2000, `tardó ${Date.now() - t0} ms`);
  });

  console.log('\n■ Los microservicios vuelven: el flujo completo se recupera solo');
  await t('al volver y cerrarse la ventana del cortacircuitos, la reserva vuelve a pasar por los 3 (sin marca)', async () => {
    ['inventory', 'order', 'booking'].forEach(arrancar); await Promise.all(Object.values(MS).map(esperarPuerto)); await sleep(3500);
    const r = await post(reserva({ adult_count: 1, child_count: 0 })); eq(r.status, 201, r.text);
    const m = await traza(r.json.reservation_id); ok(m?.res_codigo && !m.degradado, JSON.stringify(m));
  });
  await t('los errores de negocio NO se ocultan: sin cupo sigue siendo 409 OUT_OF_STOCK', async () => {
    const r = await post(reserva({ adult_count: 25, child_count: 0 })); eq(r.status, 409, r.text); eq(r.json.code, 'OUT_OF_STOCK');
  });
} finally {
  console.log(`\nResultado: ${pass} ✔  ${fail} ✘`);
  if (fail) console.log(log.split('\n').slice(-15).join('\n'));
  srv.kill(); Object.values(procs).forEach((p) => p.kill()); await mock.close?.(); process.exit(fail ? 1 : 0);
}
