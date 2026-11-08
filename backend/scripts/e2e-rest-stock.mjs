// Prueba del respaldo HTTP de stock hacia Booking (POST /api/v3/inventory/stock + X-API-Key). Usa Postgres LOCAL.
//   npm run build && node scripts/e2e-rest-stock.mjs
import 'dotenv/config';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')) { console.error('Rechazado: solo corre contra Postgres local (borra la base).'); process.exit(1); }
const PORT = 3103, MOCK = 3104, BASE = `http://localhost:${PORT}/api/v3`, KEY = 'clave-rest';
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m ?? 'falso'); };
const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✔ ${n}`); } catch (e) { fail++; console.log(`  ✘ ${n}\n      ${e.message}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const cedula = (seed) => { const d = [1, 7, Number(String(seed).padStart(7, '0')[0]) % 6, ...String(seed).padStart(7, '0').slice(1).split('').map(Number)].slice(0, 9); let s = 0; d.forEach((x, i) => { let v = x * (i % 2 === 0 ? 2 : 1); if (v > 9) v -= 9; s += v; }); return d.join('') + ((10 - (s % 10)) % 10); };

const got = []; let modo = 'ok';
const mock = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  if (modo === 'caido') { res.statusCode = 503; return res.end('{}'); }
  got.push({ url: req.url, method: req.method, key: req.headers['x-api-key'], body: JSON.parse(b || '{}') });
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ acknowledged: true, success: true, source: 'HTTP_REST' })); }); }).listen(MOCK);

const env = { ...process.env, PORT: String(PORT), BOOKING_API_KEYS: KEY, GRPC_ENABLED: 'true', BOOKING_STOCK_MODE: 'rest', BOOKING_REST_STOCK_URL: `http://localhost:${MOCK}/api/v3/inventory/stock`, BOOKING_API_KEY: 'clave-hacia-booking',
  GRPC_DISPATCH_INTERVAL_MS: '300', GRPC_RETRY_MS: '1000', MS_ENABLED: 'false', JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret', ADMIN_EMAIL: 'admin@atracciones.test', ADMIN_PASSWORD: 'Admin12345!' };
const rs = spawnSync('node', ['scripts/db.mjs', 'reset'], { cwd: root, env, encoding: 'utf8' }); if (rs.status !== 0) { console.error(rs.stdout, rs.stderr); process.exit(1); }
const srv = spawn('node', ['dist/main.js'], { cwd: root, env, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/atracciones/health')).ok) break; } catch {} await sleep(250); }
const J = async (m, p, { body, headers = {} } = {}) => { const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
try {
  await t('el health incluye service: "Atracciones" y database_connected', async () => { const r = await J('GET', '/atracciones/health'); ok(r.json.service === 'Atracciones' && r.json.database_connected === true, JSON.stringify(r.json)); });
  await t('una reserva envía POST con X-API-Key y los 5 campos documentados', async () => {
    const d = addDays(5);
    const r = await J('POST', '/atracciones/reservas', { headers: { 'idempotency-key': randomUUID(), 'x-api-key': KEY }, body: { attraction_id: 'PRhu4UBTWPBC', slot_id: `slot-${d.replace(/-/g, '')}-0900`, date: d, time: '09:00 a.m.', adult_count: 2, child_count: 0,
      customer: { full_name: 'María José Flores', email: 'turista@epn.edu.ec', phone: '+593991234567', document_type: 'CEDULA', document_id: cedula(1000001) }, payment_method: { method: 'CREDIT_CARD' } } });
    ok(r.status === 201, JSON.stringify(r.json));
    for (let i = 0; i < 40 && !got.length; i++) await sleep(150);
    const m = got.at(-1); ok(m, 'Booking no recibió nada');
    ok(m.method === 'POST' && m.url === '/api/v3/inventory/stock' && m.key === 'clave-hacia-booking', JSON.stringify(m));
    const k = Object.keys(m.body).sort().join(','); ok(k === 'available_units,date,item_id,time_slot,timestamp', k);
    ok(m.body.item_id === 'PRhu4UBTWPBC' && m.body.date === d && m.body.available_units === 18 && typeof m.body.timestamp === 'number', JSON.stringify(m.body));
  });
  await t('reenviar-todo (admin) encola y entrega los turnos futuros', async () => {
    const lg = await J('POST', '/auth/login', { body: { email: 'admin@atracciones.test', password: 'Admin12345!' } }); ok(lg.status === 200, JSON.stringify(lg.json));
    const antes = got.length;
    const r = await J('POST', '/admin/sync/reenviar-todo', { headers: { authorization: `Bearer ${lg.json.access_token ?? lg.json.token}` }, body: { dias: 7 } }); ok(r.status === 200 && r.json.encolados > 20, JSON.stringify(r.json));
    for (let i = 0; i < 80 && got.length - antes < r.json.encolados; i++) await sleep(150);
    ok(got.length - antes >= r.json.encolados, `llegaron ${got.length - antes} de ${r.json.encolados}`);
  });
  await t('Booking caído (503): no se pierde nada y al volver se entrega', async () => {
    modo = 'caido'; const d = addDays(6);
    const lg = await J('POST', '/auth/login', { body: { email: 'admin@atracciones.test', password: 'Admin12345!' } });
    const r = await J('POST', '/atracciones/reservas', { headers: { 'idempotency-key': randomUUID(), 'x-api-key': KEY }, body: { attraction_id: 'PRhu4UBTWPBC', slot_id: `slot-${d.replace(/-/g, '')}-0900`, date: d, time: '09:00 a.m.', adult_count: 1, child_count: 0,
      customer: { full_name: 'Ana Pérez', email: 'ana@epn.edu.ec', phone: '+593991234567', document_type: 'CEDULA', document_id: cedula(1000002) }, payment_method: { method: 'CREDIT_CARD' } } }); ok(r.status === 201, JSON.stringify(r.json));
    await sleep(1500); const antes = got.length; modo = 'ok';
    for (let i = 0; i < 60 && got.length === antes; i++) await sleep(200);
    ok(got.length > antes && got.at(-1).body.date === d, 'no se entregó tras recuperar Booking');
  });
} finally { console.log(`\nResultado: ${pass} ✔  ${fail} ✘`); srv.kill(); mock.close(); process.exit(fail ? 1 : 0); }
