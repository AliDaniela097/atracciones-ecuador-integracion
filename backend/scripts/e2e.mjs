// Pruebas de integración end-to-end: arranca la API compilada + un Booking gRPC simulado y verifica contrato, reglas y concurrencia.
//   npm run build && npm run test:e2e
// SEGURIDAD: reinicia la BD, por eso se niega a correr contra una BD que no sea local salvo E2E_ALLOW_RESET=1.
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startMock } from './booking-mock.mjs';
import http_ from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('Falta DATABASE_URL'); process.exit(1); }
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) && process.env.E2E_ALLOW_RESET !== '1') {
  console.error('Rechazado: las pruebas reinician la base de datos y DATABASE_URL no es local. Use una BD de pruebas (o E2E_ALLOW_RESET=1 bajo su responsabilidad).'); process.exit(1);
}
const PORT = 3101, GRPC_PORT = 50061, BASE = `http://localhost:${PORT}/api/v3`, KEY = 'clave-e2e';
const REST_PORT = 50072;
const env = { ...process.env, PORT: String(PORT), BOOKING_CHECKIN_URL: `http://localhost:${REST_PORT}/api/v3/reservas/{id}/checkin`, BOOKING_API_KEY: 'clave-booking-e2e', BOOKING_CHECKIN_MAX_ATTEMPTS: '4', BOOKING_API_KEYS: KEY, GRPC_ENABLED: 'true', BOOKING_GRPC_TARGET: `localhost:${GRPC_PORT}`, GRPC_DISPATCH_INTERVAL_MS: '300', GRPC_RETRY_MS: '1000',
  JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret', ADMIN_EMAIL: 'admin@atracciones.test', ADMIN_PASSWORD: 'Admin12345!', VALIDATE_CEDULA: 'true' };

// ---------- mini framework ----------
let pass = 0, fail = 0; const failures = [];
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg ?? 'eq'}: esperado ${JSON.stringify(b)}, recibido ${JSON.stringify(a)}`); };
const ok = (c, msg) => { if (!c) throw new Error(msg ?? 'condición falsa'); };
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✔ ${name}`); } catch (e) { fail++; failures.push(name); console.log(`  ✘ ${name}\n      ${e.message}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(method, p, { body, headers = {}, token, key, raw } = {}) {
  const h = { ...headers }; if (body !== undefined && !raw) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`; if (key) h['x-api-key'] = key;
  const r = await fetch(p.startsWith('http') ? p : BASE + p, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, headers: r.headers, json, text };
}
const cedula = (seed) => { // genera una cédula válida (provincia 17)
  const d = [1, 7, Number(String(seed).padStart(7, '0')[0]) % 6, ...String(seed).padStart(7, '0').slice(1).split('').map(Number)].slice(0, 9);
  let s = 0; d.forEach((x, i) => { let v = x * (i % 2 === 0 ? 2 : 1); if (v > 9) v -= 9; s += v; });
  return d.join('') + ((10 - (s % 10)) % 10);
};
const addDays = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const slotOf = (date, hhmm) => `slot-${date.replace(/-/g, '')}-${hhmm.replace(':', '')}`;
const reserva = (o = {}) => ({
  attraction_id: 'PRhu4UBTWPBC', slot_id: slotOf(addDays(5), '09:00'), date: addDays(5), time: '09:00 a.m.', adult_count: 2, child_count: 1,
  customer: { full_name: 'María José Flores', email: 'turista@epn.edu.ec', phone: '+593991234567', document_type: 'CEDULA', document_id: cedula(1000001) },
  payment_method: { method: 'CREDIT_CARD' }, ...o });
const post = (b, key = randomUUID(), extra = {}) => http('POST', '/atracciones/reservas', { body: b, headers: { 'idempotency-key': key, ...extra }, key: KEY });

// ---------- arranque ----------
console.log('▶ Preparando BD de pruebas, Booking simulado (gRPC) y API…');
const rs = spawnSync('node', ['scripts/db.mjs', 'reset'], { cwd: root, env, encoding: 'utf8' });
if (rs.status !== 0) { console.error(rs.stdout, rs.stderr); process.exit(1); }
const booking = await startMock({ port: GRPC_PORT });
// Booking REST simulado (recibe el aviso de check-in del contrato v3.1)
const ci_log = []; let ci_modo = 'ok';
const restMock = http_.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  let body; try { body = JSON.parse(b); } catch { body = null; } ci_log.push({ url: req.url, key: req.headers['x-api-key'], body, modo: ci_modo });
  const [st, out] = ci_modo === 'ok' ? [200, { acknowledged: true, status: 'CONFIRMADO_ASISTIDO' }] : ci_modo === '404' ? [404, { code: 'NOT_FOUND' }] : [503, { code: 'DOWN' }];
  res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }); });
await new Promise((r) => restMock.listen(REST_PORT, r));
const srv = spawn('node', ['dist/main.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/atracciones/health')).ok) break; } catch {} await sleep(250); }
const pool = new pg.Pool({ connectionString: dbUrl });
const { ContractService } = await import('../dist/contract/contract.service.js');
const contract = new ContractService();
const valid = (schema, data) => { const e = contract.check(schema, data); if (e.length) throw new Error(`No cumple ${schema}: ${JSON.stringify(e.slice(0, 4))}`); };
let admin, adminToken, clientToken, quitoId, operadorId = 1;

try {
  console.log('\n■ Salud, correlación y compatibilidad de rutas');
  await t('health UP con campos del contrato NodeHealthResponse', async () => {
    const r = await http('GET', '/atracciones/health', { headers: { 'x-correlation-id': 'cid-test-1' } });
    eq(r.status, 200); eq(r.json.status, 'UP'); valid('NodeHealthResponse', r.json); eq(r.headers.get('x-correlation-id'), 'cid-test-1');
  });
  await t('/api/v2 y /api/v1 siguen operativas (Ley de Postel)', async () => {
    eq((await http('GET', `http://localhost:${PORT}/api/v2/atracciones/health`)).status, 200);
    eq((await http('GET', `http://localhost:${PORT}/api/v1/atracciones/health`)).status, 200);
  });
  await t('JSON inválido → 400 problem+json INVALID_JSON', async () => {
    const r = await http('POST', '/atracciones/search', { raw: '{malo', headers: { 'content-type': 'application/json' } });
    eq(r.status, 400); ok(r.headers.get('content-type').includes('application/problem+json')); eq(r.json.code, 'INVALID_JSON');
  });
  await t('ruta inexistente → 404 problem+json', async () => {
    const r = await http('GET', '/no-existe'); eq(r.status, 404); eq(r.json.code, 'NOT_FOUND'); ok(r.json.correlation_id);
  });

  console.log('\n■ Catálogo público y paginación');
  await t('listado paginado + metadata PaginationMetadata y esquema de tarjeta', async () => {
    const r = await http('GET', '/atracciones?limit=2&page=2'); eq(r.status, 200);
    eq(r.json.metadata.page, 2); eq(r.json.metadata.limit, 2); eq(r.json.metadata.total_results, 5); eq(r.json.metadata.total_pages, 3); eq(r.json.data.length, 2);
    valid('PaginationMetadata', r.json.metadata); r.json.data.forEach((c) => valid('AtraccionCardResponseV2', c));
  });
  await t('limit>50 y page<1 → 400 con invalid_params', async () => {
    const a = await http('GET', '/atracciones?limit=51'); eq(a.status, 400); eq(a.json.invalid_params[0].name, 'limit');
    eq((await http('GET', '/atracciones?page=0')).status, 400);
  });
  await t('filtro por ciudad (sin tildes) y orden PRICE_DESC', async () => {
    const q = await http('GET', '/atracciones?city=quito'); ok(q.json.data.every((x) => x.city === 'Quito') && q.json.data.length === 2);
    const p = await http('GET', '/atracciones?sort=PRICE_DESC'); const prices = p.json.data.map((x) => x.price.adult); eq(prices, [...prices].sort((a, b) => b - a));
    eq((await http('GET', '/atracciones?sort=XX')).status, 400);
  });
  await t('POST /search valida el cuerpo contra SearchAtraccionesRequestV2', async () => {
    const r = await http('POST', '/atracciones/search', { body: { query: 'tortugas', limit: 5 } }); eq(r.status, 200); eq(r.json.data[0].id, 'GPtortugas01'); valid('SearchAtraccionesResponseV2', r.json);
    const bad = await http('POST', '/atracciones/search', { body: { precio_min: -5, limit: 99 } }); eq(bad.status, 400); eq(bad.json.code, 'VALIDATION_ERROR');
  });
  await t('búsqueda por disponibilidad en fecha (fecha_inicio) respeta cupos', async () => {
    const r = await http('POST', '/atracciones/search', { body: { fecha_inicio: addDays(3), adult_count: 21 } }); eq(r.json.data.length, 0);
    eq((await http('POST', '/atracciones/search', { body: { fecha_inicio: addDays(3), adult_count: 2 } })).json.metadata.total_results, 5);
  });
  await t('detalle por código y por slug cumple AtraccionDetailResponseV2', async () => {
    const a = await http('GET', '/atracciones/PRhu4UBTWPBC'); eq(a.status, 200); valid('AtraccionDetailResponseV2', a.json);
    eq((await http('GET', '/atracciones/tour-centro-historico-quito')).json.id, 'PRhu4UBTWPBC');
    const nf = await http('GET', '/atracciones/NOEXISTE'); eq(nf.status, 404); eq(nf.json.code, 'ATTRACTION_NOT_FOUND');
  });
  await t('árbol de categorías con banderas obligatorias', async () => {
    const r = await http('GET', '/atracciones/categorias/arbol'); eq(r.status, 200);
    r.json.forEach((c) => { valid('CategoryTreeNode', c); ok(typeof c.incluye_comida === 'boolean' && typeof c.incluye_transporte === 'boolean' && typeof c.incluye_guia === 'boolean'); });
    ok(Array.isArray((await http('GET', '/atracciones/categorias')).json));
  });
  await t('disponibilidad: formato slot_id, cupos y validación de fecha', async () => {
    const d = addDays(3); const r = await http('GET', `/atracciones/PRhu4UBTWPBC/disponibilidad?date=${d}`); eq(r.status, 200); valid('DisponibilidadResponse', r.json);
    eq(r.json.time_slots.map((s) => s.slot_id), [slotOf(d, '09:00'), slotOf(d, '10:30'), slotOf(d, '14:00')]); eq(r.json.total_available_slots, 60);
    eq((await http('GET', '/atracciones/PRhu4UBTWPBC/disponibilidad')).status, 400);
    eq((await http('GET', '/atracciones/PRhu4UBTWPBC/disponibilidad?date=2026-02-30')).status, 400);
    eq((await http('GET', `/atracciones/NOEXISTE/disponibilidad?date=${d}`)).status, 404);
  });

  console.log('\n■ Seguridad de reservas');
  await t('crear reserva sin credenciales → 401; con X-API-Key inválida → 401', async () => {
    eq((await http('POST', '/atracciones/reservas', { body: reserva(), headers: { 'idempotency-key': randomUUID() } })).status, 401);
    eq((await http('POST', '/atracciones/reservas', { body: reserva(), headers: { 'idempotency-key': randomUUID() }, key: 'mala' })).status, 401);
  });
  await t('promociones y eventos exigen autenticación', async () => {
    eq((await http('GET', '/atracciones/promociones/contrato')).status, 401); eq((await http('GET', '/atracciones/eventos')).status, 401);
  });

  console.log('\n■ Reservas: validaciones del contrato (400 / 422)');
  await t('sin Idempotency-Key → 400 MISSING_IDEMPOTENCY_KEY', async () => {
    const r = await http('POST', '/atracciones/reservas', { body: reserva(), key: KEY }); eq(r.status, 400); eq(r.json.code, 'MISSING_IDEMPOTENCY_KEY');
  });
  await t('slot_id vs time distinto → 400 SLOT_TIME_MISMATCH (tipo slot-mismatch)', async () => {
    const r = await post(reserva({ time: '14:00:00' })); eq(r.status, 400); eq(r.json.code, 'SLOT_TIME_MISMATCH'); ok(r.json.type.endsWith('/slot-mismatch'));
    const r2 = await post(reserva({ date: addDays(6) })); eq(r2.json.code, 'SLOT_TIME_MISMATCH');
  });
  await t('fecha pasada, adult_count=0 y cédula inválida → 422 sin activar Saga', async () => {
    const past = addDays(-2); const a = await post(reserva({ date: past, slot_id: slotOf(past, '09:00') })); eq(a.status, 422); eq(a.json.code, 'SEMANTIC_VALIDATION_FAILED');
    const b = await post(reserva({ adult_count: 0 })); eq(b.status, 422); ok(b.json.invalid_params.some((p) => p.name === 'adult_count'));
    const c = await post(reserva({ customer: { ...reserva().customer, document_id: '1723456789' } })); eq(c.status, 422); ok(c.json.invalid_params.some((p) => p.name === 'customer.document_id'));
  });
  await t('faltan campos obligatorios → 400 VALIDATION_ERROR; atracción/slot inexistentes → 404', async () => {
    const r = await post({ attraction_id: 'PRhu4UBTWPBC' }); eq(r.status, 400); eq(r.json.code, 'VALIDATION_ERROR');
    eq((await post(reserva({ attraction_id: 'NOEXISTE' }))).status, 404);
    const d = addDays(5); eq((await post(reserva({ slot_id: slotOf(d, '23:00'), time: '11:00 p.m.' }))).json.code, 'SLOT_NOT_FOUND');
  });

  console.log('\n■ Reservas: creación, idempotencia y stock');
  let created, keyA = randomUUID(), body1 = reserva({ slot_id: slotOf(addDays(4), '10:30'), date: addDays(4), time: '10:30:00' });
  await t('201 con ReservaConfirmadaResponseV2, Location, total correcto y voucher firmado', async () => {
    const r = await post(body1, keyA); eq(r.status, 201); created = r.json; valid('ReservaConfirmadaResponseV2', r.json);
    eq(r.json.status, 'CONFIRMED'); eq(r.json.ticket_count, 3); eq(r.json.total_price, 25 * 2 + 12.5); eq(r.json.time, '10:30 a.m.'); ok(r.headers.get('location').endsWith(r.json.reservation_id));
    ok(/^ORD-ATR-\d+$/.test(r.json.external_order_id)); ok(r.json.voucher_qr_payload.split('.').length === 3); eq(r.json.success, true);
  });
  await t('mismo Idempotency-Key + mismo cuerpo → respuesta idéntica, sin descontar cupos otra vez', async () => {
    const r = await post(body1, keyA); eq(r.status, 201); eq(r.headers.get('idempotent-replay'), 'true'); eq(r.json.reservation_id, created.reservation_id);
    const d = await http('GET', `/atracciones/PRhu4UBTWPBC/disponibilidad?date=${addDays(4)}`); eq(d.json.time_slots[1].available_slots, 17);
    eq((await pool.query('SELECT COUNT(*)::int n FROM reserva')).rows[0].n, 1);
  });
  await t('mismo Idempotency-Key con cuerpo distinto → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const r = await post({ ...body1, adult_count: 1 }, keyA); eq(r.status, 409); eq(r.json.code, 'IDEMPOTENCY_KEY_REUSED');
  });
  await t('payload abreviado de Booking (customer.name, sin document_type ni pago) → 201', async () => {
    const guide = { attraction_id: 'PRhu4UBTWPBC', date: addDays(7), time: '10:30 a.m.', slot_id: slotOf(addDays(7), '10:30'), adult_count: 2, child_count: 1, senior_count: 0, infant_count: 0, total_tickets: 3,
      customer: { name: 'María José Flores', email: 'turista@epn.edu.ec', phone: '+593991234567', document_id: cedula(1000002) }, special_requirements: 'Audio-guía en inglés', booking_reservation_id: 'RES-ATR-A1B2C3' };
    const r = await http('POST', '/reservas', { body: guide, headers: { 'idempotency-key': randomUUID(), 'x-correlation-id': 'cid-booking-1' }, key: KEY });
    eq(r.status, 201); eq(r.json.status, 'CONFIRMED'); eq(r.json.success, true); eq(r.headers.get('x-correlation-id'), 'cid-booking-1');
    eq((await http('GET', `/atracciones/reservas/RES-ATR-A1B2C3`, { key: KEY })).json.reservation_id, r.json.reservation_id); // consultable por el id de Booking
  });
  await t('alias en español (v2) aceptados: atraccion_id/fecha/hora/cantidad_adultos/metodo_pago', async () => {
    const d = addDays(8); const r = await post({ atraccion_id: 'GYmalecon001', fecha: d, slot_id: slotOf(d, '14:00'), hora: '14:00:00', cantidad_adultos: 1, cantidad_estudiantes: 1,
      customer: { nombre_completo: 'Luis Andrade', correo: 'luis@mail.com', telefono: '0991234567', tipo_documento: 'PASAPORTE', numero_documento: 'AB123456' }, metodo_pago: 'SOA_BOOKING_GATEWAY' });
    eq(r.status, 201); eq(r.json.student_count, 1); eq(r.json.total_price, 15 + 12);
  });
  await t('infantes ocupan cupo con precio $0', async () => {
    const d = addDays(9); const r = await post(reserva({ slot_id: slotOf(d, '09:00'), date: d, time: '09:00', adult_count: 1, child_count: 0, infant_count: 2 })); eq(r.status, 201); eq(r.json.total_price, 25);
    eq((await http('GET', `/atracciones/PRhu4UBTWPBC/disponibilidad?date=${d}`)).json.time_slots[0].available_slots, 17);
  });
  await t('GET reserva por UUID / PNR / external_order_id (requiere auth)', async () => {
    eq((await http('GET', `/atracciones/reservas/${created.reservation_id}`)).status, 401);
    for (const id of [created.reservation_id, created.reservation_code, created.external_order_id]) eq((await http('GET', `/atracciones/reservas/${id}`, { key: KEY })).json.reservation_id, created.reservation_id);
    eq((await http('GET', `/atracciones/reservas/NOEXISTE`, { key: KEY })).status, 404);
  });
  await t('.ics de calendario descargable', async () => {
    const r = await http('GET', `/atracciones/reservas/${created.reservation_id}/evento.ics`); eq(r.status, 200); ok(r.text.includes('BEGIN:VEVENT') && r.text.includes('DTSTART;TZID=America/Guayaquil:' + addDays(4).replace(/-/g, '') + 'T103000'));
  });

  console.log('\n■ Panel de administración (JWT) y paginación');
  await t('login: credenciales incorrectas → 401; correctas → JWT con rol ADMIN', async () => {
    eq((await http('POST', '/auth/login', { body: { email: 'admin@atracciones.test', password: 'mala' } })).status, 401);
    const r = await http('POST', '/auth/login', { body: { email: 'admin@atracciones.test', password: 'Admin12345!' } }); eq(r.status, 200); adminToken = r.json.access_token; ok(r.json.user.roles.includes('ADMIN'));
    quitoId = (await http('GET', '/admin/ciudades?limit=100', { token: adminToken })).json.data.find((c) => c.nombre === 'Quito').id;
  });
  await t('registro público crea SIEMPRE rol CLIENTE; no puede acceder a /admin (403)', async () => {
    const r = await http('POST', '/auth/register', { body: { email: 'turista1@mail.com', password: 'Turista123', nombre: 'Ana', apellido: 'Paz', roles: ['ADMIN'] } }); eq(r.status, 201); eq(r.json.user.roles, ['CLIENTE']); clientToken = r.json.access_token;
    eq((await http('GET', '/admin/dashboard', { token: clientToken })).status, 403); eq((await http('GET', '/admin/dashboard')).status, 401);
    eq((await http('POST', '/auth/register', { body: { email: 'turista1@mail.com', password: 'Turista123', nombre: 'A', apellido: 'B' } })).status, 409);
    eq((await http('POST', '/auth/register', { body: { email: 'x', password: '123', nombre: '', apellido: '' } })).status, 400);
  });
  await t('un CLIENTE solo ve sus reservas; ADMIN ve todas', async () => {
    eq((await http('GET', `/atracciones/reservas/${created.reservation_id}`, { token: clientToken })).status, 403);
    eq((await http('GET', `/atracciones/reservas/${created.reservation_id}`, { token: adminToken })).status, 200);
  });
  await t('dashboard y listados paginados (atracciones, reservas, usuarios, ciudades)', async () => {
    const d = await http('GET', '/admin/dashboard', { token: adminToken }); eq(d.status, 200); ok(d.json.reservas_activas >= 4);
    const a = await http('GET', '/admin/atracciones?limit=2&page=1', { token: adminToken }); eq(a.json.data.length, 2); eq(a.json.metadata.total_pages, 3);
    eq((await http('GET', '/admin/reservas?limit=2&estado=CONFIRMED', { token: adminToken })).json.metadata.limit, 2);
    ok((await http('GET', '/admin/usuarios', { token: adminToken })).json.data.length >= 2);
    const c = await http('GET', '/admin/ciudades', { token: adminToken }); ok(c.json.data.every((x) => x.aeropuertos.length >= 1));
  });
  await t('regla de negocio: no se puede crear atracción en ciudad SIN aeropuerto (422)', async () => {
    const prov = (await pool.query(`SELECT prov_id FROM provincia WHERE prov_codigo='18'`)).rows[0].prov_id;
    const ciu = (await pool.query(`INSERT INTO ciudad (ciu_nombre, prov_id) VALUES ('Ambato',$1) RETURNING ciu_id`, [prov])).rows[0].ciu_id;
    const r = await http('POST', '/admin/atracciones', { token: adminToken, body: { nombre: 'Fiesta de las Flores', descripcion: 'x', tipo: 'ADMISSION', ciudad_id: ciu, operador_id: operadorId, latitud: -1.24, longitud: -78.6, duracion_horas: 2 } });
    eq(r.status, 422); eq(r.json.code, 'BUSINESS_RULE_VIOLATION');
  });
  let nuevo;
  await t('CRUD admin: crear atracción con tarifas, horario, turnos; no se publica incompleta; publicar; visible en catálogo', async () => {
    const c = await http('POST', '/admin/atracciones', { token: adminToken, body: { nombre: 'Prueba Concurrencia', descripcion: 'Atracción de pruebas', tipo: 'GUIDED_TOUR', ciudad_id: quitoId, operador_id: operadorId, latitud: -0.2, longitud: -78.5, duracion_horas: 2,
      punto_encuentro: 'Plaza', categorias: [1], idiomas: ['es'], fotos: [{ url: 'https://x.test/a.jpg', alt: 'foto' }] } });
    eq(c.status, 201); nuevo = c.json; eq(nuevo.estado, 'BORRADOR');
    const bad = await http('POST', `/admin/atracciones/${nuevo.codigo}/publicar`, { token: adminToken }); eq(bad.status, 400); eq(bad.json.code, 'NOT_READY_TO_PUBLISH');
    eq((await http('GET', `/atracciones/${nuevo.codigo}`)).status, 404); // los borradores no son públicos
    eq((await http('PUT', `/admin/atracciones/${nuevo.codigo}`, { token: adminToken, body: { tarifas: { ADULTO: 10, NINO: 5 } } })).json.tarifas.ADULTO, 10);
    const h = await http('POST', `/admin/atracciones/${nuevo.codigo}/horarios`, { token: adminToken, body: { hora: '8:00 a.m.', cupo: 5 } }); eq(h.status, 201); eq(h.json.hora, '08:00');
    eq((await http('POST', `/admin/atracciones/${nuevo.codigo}/turnos/generar`, { token: adminToken, body: { desde: addDays(2), hasta: addDays(4) } })).json.turnos_creados, 3);
    eq((await http('POST', `/admin/atracciones/${nuevo.codigo}/publicar`, { token: adminToken })).json.estado, 'PUBLICADA');
    valid('AtraccionDetailResponseV2', (await http('GET', `/atracciones/${nuevo.codigo}`)).json);
  });
  await t('cambiar precio conserva el histórico de tarifas (vigencia)', async () => {
    await http('PUT', `/admin/atracciones/${nuevo.codigo}`, { token: adminToken, body: { tarifas: { ADULTO: 12 } } });
    eq((await http('GET', `/atracciones/${nuevo.codigo}`)).json.price.adult, 12);
    ok(Number((await pool.query(`SELECT COUNT(*) n FROM tarifa WHERE atr_id=$1 AND tar_tipo='ADULTO'`, [nuevo.id])).rows[0].n) >= 1);
  });

  console.log('\n■ Concurrencia: anti-sobreventa (aforo 5, 12 compradores simultáneos)');
  await t('exactamente 5 reservas 201 y 7 respuestas 409 OUT_OF_STOCK; cupos consistentes', async () => {
    const d = addDays(3); const mk = (i) => ({ attraction_id: nuevo.codigo, slot_id: slotOf(d, '08:00'), date: d, time: '08:00', adult_count: 1, child_count: 0,
      customer: { full_name: `Cliente Numero${i}`.replace(/\d/g, 'X'), email: `c${i}@mail.com`, phone: '+593991234567', document_type: 'CEDULA', document_id: cedula(2000000 + i) }, payment_method: { method: 'TRANSFER' } });
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => post(mk(i))));
    const okN = rs.filter((r) => r.status === 201).length, no = rs.filter((r) => r.status === 409);
    eq(okN, 5); eq(no.length, 7); ok(no.every((r) => r.json.code === 'OUT_OF_STOCK' && r.headers.get('content-type').includes('problem+json')));
    const row = (await pool.query(`SELECT tur_cupo_reservado FROM turno t JOIN horario h ON h.hor_id=t.hor_id WHERE h.atr_id=$1 AND t.tur_fecha=$2`, [nuevo.id, d])).rows[0]; eq(row.tur_cupo_reservado, 5);
    const av = (await http('GET', `/atracciones/${nuevo.codigo}/disponibilidad?date=${d}`)).json.time_slots[0]; eq(av.status, 'AGOTADO'); eq(av.available_slots, 0);
    eq((await post(mk(99))).json.code, 'OUT_OF_STOCK');
  });
  await t('mismo Idempotency-Key en paralelo → una sola reserva', async () => {
    const d = addDays(2); const k = randomUUID(); const b = { attraction_id: nuevo.codigo, slot_id: slotOf(d, '08:00'), date: d, time: '08:00', adult_count: 1,
      customer: { full_name: 'Paralelo Prueba', email: 'p@mail.com', phone: '+593991234567', document_type: 'CEDULA', document_id: cedula(3000001) }, payment_method: { method: 'TRANSFER' } };
    const rs = await Promise.all([post(b, k), post(b, k), post(b, k)]);
    ok(rs.every((r) => r.status === 201)); eq(new Set(rs.map((r) => r.json.reservation_id)).size, 1);
    eq((await pool.query(`SELECT COUNT(*)::int n FROM reserva r JOIN turno t ON t.tur_id=r.tur_id JOIN horario h ON h.hor_id=t.hor_id WHERE h.atr_id=$1 AND t.tur_fecha=$2`, [nuevo.id, d])).rows[0].n, 1);
  });

  console.log('\n■ Cancelación (compensación Saga), reembolso y check-in');
  let toCancel;
  await t('cancelar libera cupos, emite reembolso 100% y es idempotente', async () => {
    const d = addDays(10); const r = await post(reserva({ slot_id: slotOf(d, '09:00'), date: d, time: '09:00', adult_count: 3, child_count: 0, customer: { ...reserva().customer, document_id: cedula(4000001) } })); toCancel = r.json;
    const before = (await http('GET', `/atracciones/PRhu4UBTWPBC/disponibilidad?date=${d}`)).json.time_slots[0].available_slots; eq(before, 17);
    const c = await http('POST', `/atracciones/reservas/${toCancel.reservation_id}/cancel`, { key: KEY, body: { reason: 'SAGA_COMPENSATION_PARTNER_FAILURE', solicitante: 'SAGA_ORCHESTRATOR' } });
    eq(c.status, 200); eq(c.json.status, 'CANCELLED'); eq(c.json.monto_reembolsado, 75); ok(/^REF-ATR-/.test(c.json.reembolso_id)); valid('ReservaConfirmadaResponseV2', c.json);
    eq((await http('GET', `/atracciones/PRhu4UBTWPBC/disponibilidad?date=${d}`)).json.time_slots[0].available_slots, 20);
    const again = await http('POST', `/atracciones/reservas/${toCancel.reservation_id}/cancel`, { key: KEY, body: {} }); eq(again.status, 200); eq(again.json.reembolso_id, c.json.reembolso_id);
    eq((await http('GET', `/atracciones/PRhu4UBTWPBC/disponibilidad?date=${d}`)).json.time_slots[0].available_slots, 20); // no libera dos veces
  });
  await t('CLIENTE no puede cancelar una atracción sin cancelación gratuita (409); sin rol no puede usar SAGA_ORCHESTRATOR (403)', async () => {
    const d = addDays(10); const r = await post({ atraccion_id: 'GYmalecon001', fecha: d, slot_id: slotOf(d, '10:30'), hora: '10:30', adult_count: 1,
      customer: { full_name: 'Ana Paz', email: 'turista1@mail.com', phone: '0991234567', document_type: 'CEDULA', document_id: cedula(4000002) }, payment_method: 'TRANSFERENCIA' });
    const c = await http('POST', `/atracciones/reservas/${r.json.reservation_id}/cancel`, { key: KEY, body: { solicitante: 'CLIENTE' } }); eq(c.status, 409); eq(c.json.code, 'CANCELLATION_NOT_ALLOWED');
    const own = await http('POST', `/atracciones/reservas/${r.json.reservation_id}/cancel`, { token: clientToken, body: { solicitante: 'SAGA_ORCHESTRATOR' } }); eq(own.status, 403);
  });
  await t('check-in: documento incorrecto 403, correcto 200 CHECKED_IN, repetido 200 idempotente, luego no cancelable', async () => {
    const d = addDays(11); const doc = cedula(5000001);
    const r = await post(reserva({ slot_id: slotOf(d, '09:00'), date: d, time: '09:00', adult_count: 1, child_count: 0, customer: { ...reserva().customer, document_id: doc } }));
    const id = r.json.reservation_id;
    eq((await http('POST', `/atracciones/reservas/${id}/checkin`, { key: KEY, body: { documento_identidad: cedula(5000002) } })).status, 403);
    eq((await http('POST', `/atracciones/reservas/${id}/checkin`, { key: KEY, body: {} })).status, 400);
    eq((await http('POST', `/atracciones/reservas/${id}/checkin`, { token: clientToken, body: { documento_identidad: doc } })).status, 403);
    eq((await http('POST', `/atracciones/reservas/${id}/checkin`, { key: KEY, body: { documento_identidad: doc, codigo_voucher_qr: 'OTRO' } })).status, 403);
    const ci = await http('POST', `/atracciones/reservas/${id}/checkin`, { key: KEY, body: { documento_identidad: doc, codigo_voucher_qr: r.json.voucher_qr_payload, guia_asignado: 'Carlos Morales (MINTUR-5541)' } });
    eq(ci.status, 200); eq(ci.json.estado, 'CHECKED_IN'); eq(ci.json.titular_documento, doc);
    const ci2 = await http('POST', `/atracciones/reservas/${id}/checkin`, { key: KEY, body: { documento_identidad: doc } }); eq(ci2.status, 200); eq(ci2.json.hora_checkin, ci.json.hora_checkin);
    eq((await http('POST', `/atracciones/reservas/${id}/cancel`, { key: KEY, body: { solicitante: 'ADMIN' } })).json.code, 'RESERVATION_NOT_CANCELLABLE');
    const cx = await http('POST', `/atracciones/reservas/${toCancel.reservation_id}/checkin`, { key: KEY, body: { documento_identidad: reserva().customer.document_id } }); ok([403, 409].includes(cx.status));
  });

  console.log('\n■ Contrato v3.1: clientes y aviso de check-in a Booking');
  await t('GET/POST /clientes: auth, validación, alta 201, repetido 200 con el mismo client_id, búsqueda por identificación y por email', async () => {
    eq((await http('GET', '/clientes?email=a@b.com')).status, 401);
    eq((await http('GET', '/clientes', { key: KEY })).status, 400);
    eq((await http('GET', '/clientes?email=nadie@nada.com', { key: KEY })).status, 404);
    eq((await http('GET', '/clientes?identificacion=' + cedula(6000001), { token: clientToken })).status, 403);
    const doc = cedula(6000001); const body = { nombre: 'Luis Andrade', email: 'luis.andrade@mail.com', identificacion: doc, telefono: '+593988112233' };
    const a = await http('POST', '/clientes', { key: KEY, body }); eq(a.status, 201); ok(/^\d+$/.test(a.json.client_id));
    const b = await http('POST', '/clientes', { key: KEY, body }); eq(b.status, 200); eq(b.json.client_id, a.json.client_id);
    const g1 = await http('GET', `/clientes?identificacion=${doc}`, { key: KEY }); eq(g1.status, 200); eq(g1.json.client_id, a.json.client_id); eq(g1.json.nombre, 'Luis Andrade'); eq(g1.json.email, 'luis.andrade@mail.com'); eq(g1.json.identificacion, doc);
    const g2 = await http('GET', '/clientes?email=LUIS.ANDRADE@mail.com', { key: KEY }); eq(g2.status, 200); eq(g2.json.client_id, a.json.client_id);
    eq((await http('POST', '/clientes', { key: KEY, body: { nombre: 'X', email: 'no-es-correo', identificacion: '' } })).status, 400);
    eq((await http('POST', '/clientes', { key: KEY, body: { ...body, identificacion: '1712345679', email: 'otro@mail.com' } })).status, 422);
    eq((await pool.query('SELECT COUNT(*)::int n FROM cliente WHERE cli_documento=$1', [doc])).rows[0].n, 1);
  });
  await t('una reserva con el mismo documento reutiliza al cliente creado por /clientes (sin duplicar)', async () => {
    const doc = cedula(6000001); const d = addDays(13); const antes = (await http('GET', `/clientes?identificacion=${doc}`, { key: KEY })).json.client_id;
    const r = await post(reserva({ slot_id: slotOf(d, '09:00'), date: d, time: '09:00', adult_count: 1, child_count: 0, customer: { ...reserva().customer, document_id: doc, email: 'luis.andrade@mail.com', full_name: 'Luis Andrade' } }));
    eq(r.status, 201); eq((await http('GET', `/clientes?identificacion=${doc}`, { key: KEY })).json.client_id, antes);
    eq((await pool.query('SELECT COUNT(*)::int n FROM cliente WHERE cli_documento=$1', [doc])).rows[0].n, 1);
  });
  await t('check-in presencial: avisa a Booking con URL, X-API-Key y cuerpo del contrato v3.1', async () => {
    const d = addDays(14); const doc = cedula(6000003);
    const r = await post(reserva({ slot_id: slotOf(d, '09:00'), date: d, time: '09:00', adult_count: 2, child_count: 1, customer: { ...reserva().customer, document_id: doc } }));
    ci_log.length = 0; ci_modo = 'ok';
    const ci = await http('POST', `/atracciones/reservas/${r.json.reservation_id}/checkin`, { key: KEY, body: { documento_identidad: doc, codigo_voucher_qr: r.json.voucher_qr_payload, admin_id: 'guia-turistico', observaciones: 'Validado con QR y cédula' } });
    eq(ci.status, 200); eq(ci.json.estado, 'CHECKED_IN'); eq(ci.json.booking_checkin.notificado, true); eq(ci.json.booking_checkin.estado, 'ENVIADO');
    eq(ci_log.length, 1); const x = ci_log[0];
    eq(x.url, `/api/v3/reservas/${encodeURIComponent(r.json.reservation_code)}/checkin`); eq(x.key, 'clave-booking-e2e');
    eq(x.body.external_order_id, r.json.reservation_code); eq(x.body.estado, 'CONFIRMADO_ASISTIDO'); eq(x.body.asistentes_reales, 3); eq(x.body.admin_id, 'guia-turistico');
    eq(x.body.observaciones, 'Validado con QR y cédula'); ok(!Number.isNaN(Date.parse(x.body.fecha_checkin)), 'fecha_checkin ISO');
    eq(x.body.client_id, (await http('GET', `/clientes?identificacion=${doc}`, { key: KEY })).json.client_id);
    // con asistentes_reales explícito
    const d2 = addDays(15); const doc2 = cedula(6000005);
    const r2 = await post(reserva({ slot_id: slotOf(d2, '09:00'), date: d2, time: '09:00', adult_count: 2, child_count: 0, customer: { ...reserva().customer, document_id: doc2 } }));
    ci_log.length = 0; await http('POST', `/atracciones/reservas/${r2.json.reservation_id}/checkin`, { key: KEY, body: { documento_identidad: doc2, asistentes_reales: 1 } });
    eq(ci_log[0].body.asistentes_reales, 1);
  });
  await t('check-in: si Booking está caído el check-in local SÍ se registra y el aviso se reintenta hasta entregarse', async () => {
    const d = addDays(16); const doc = cedula(6000007);
    const r = await post(reserva({ slot_id: slotOf(d, '09:00'), date: d, time: '09:00', adult_count: 1, child_count: 0, customer: { ...reserva().customer, document_id: doc } }));
    ci_log.length = 0; ci_modo = '503';
    const ci = await http('POST', `/atracciones/reservas/${r.json.reservation_id}/checkin`, { key: KEY, body: { documento_identidad: doc } });
    eq(ci.status, 200); eq(ci.json.estado, 'CHECKED_IN'); eq(ci.json.booking_checkin.estado, 'PENDIENTE_REINTENTO');
    ci_modo = 'ok'; for (let i = 0; i < 30 && !ci_log.some((l) => l.modo === 'ok'); i++) await sleep(300);
    ok(ci_log.some((l) => l.modo === 'ok'), 'el reintento no llegó a Booking: ' + JSON.stringify(ci_log.map((l) => l.modo)));
  });
  await t('check-in: un rechazo definitivo de Booking (404) no se reintenta y no revierte el check-in local', async () => {
    const d = addDays(17); const doc = cedula(6000009);
    const r = await post(reserva({ slot_id: slotOf(d, '09:00'), date: d, time: '09:00', adult_count: 1, child_count: 0, customer: { ...reserva().customer, document_id: doc } }));
    ci_log.length = 0; ci_modo = '404';
    const ci = await http('POST', `/atracciones/reservas/${r.json.reservation_id}/checkin`, { key: KEY, body: { documento_identidad: doc } });
    eq(ci.status, 200); eq(ci.json.estado, 'CHECKED_IN'); eq(ci.json.booking_checkin.estado, 'RECHAZADO'); await sleep(2500); eq(ci_log.length, 1);
    ci_modo = 'ok';
  });

  console.log('\n■ Promociones B2B (cuestionario de la cátedra)');
  await t('GET/PUT contrato de promociones con validaciones', async () => {
    const g = await http('GET', '/atracciones/promociones/contrato', { key: KEY }); eq(g.status, 200); valid('PromocionesContratoResponse', g.json);
    eq((await http('PUT', '/atracciones/promociones/contrato', { key: KEY, body: { permite_promociones: true, porcentaje_descuento_maximo: 80 } })).status, 400);
    const dest = await http('PUT', '/atracciones/promociones/contrato', { key: KEY, body: { permite_promociones: true, porcentaje_descuento_maximo: 15, destinos_habilitados: ['Quito', 'Baños'] } }); eq(dest.status, 400); eq(dest.json.code, 'INVALID_DESTINATION');
    const p = await http('PUT', '/atracciones/promociones/contrato', { key: KEY, body: { permite_promociones: true, porcentaje_descuento_maximo: 15, destinos_habilitados: ['Quito', 'Cuenca', 'Galápagos'.replace('Galápagos', 'Baltra')], vigencia_hasta: '2027-12-31', condiciones_combo: '48 h de anticipación' } });
    eq(p.status, 200); valid('PromocionesContratoResponse', p.json); eq(p.json.porcentaje_descuento_maximo, 15); eq(p.json.destinos_habilitados, ['Baltra', 'Cuenca', 'Quito']);
    eq((await http('GET', '/atracciones/PRhu4UBTWPBC')).json.porcentaje_descuento_paquete, 0); // el tour no habilita paquete → 0
    eq((await http('PUT', '/atracciones/promociones/contrato', { token: clientToken, body: { permite_promociones: false, porcentaje_descuento_maximo: 0 } })).status, 403);
  });

  console.log('\n■ Outbox / feed de eventos (CloudEvents)');
  await t('feed con cursor "after", filtro por tipo y esquema OutboxEventItem', async () => {
    const all = await http('GET', '/atracciones/eventos?limit=200', { key: KEY }); eq(all.status, 200); all.json.forEach((e) => valid('OutboxEventItem', e));
    const seq = all.json.map((e) => e.sequence_number); eq(seq, [...seq].sort((a, b) => a - b));
    const page = await http('GET', `/atracciones/eventos?after=${seq[2]}&limit=3`, { key: KEY }); eq(page.json.map((e) => e.sequence_number), seq.slice(3, 6));
    const only = await http('GET', '/atracciones/eventos?type=RESERVA_CANCELADA', { key: KEY }); ok(only.json.length >= 1 && only.json.every((e) => e.event_type === 'RESERVA_CANCELADA'));
    eq((await http('GET', '/atracciones/eventos?type=XX', { key: KEY })).status, 400);
    const types = new Set(all.json.map((e) => e.event_type)); for (const x of ['RESERVA_CREADA', 'RESERVA_CONFIRMADA', 'STOCK_ACTUALIZADO', 'RESERVA_CANCELADA']) ok(types.has(x), 'falta ' + x);
  });

  console.log('\n■ gRPC hacia Booking (cliente de la tienda ↔ servidor simulado)');
  await t('el despachador envía STOCK_ACTUALIZADO por PushStockUpdate y el Outbox queda vacío', async () => {
    for (let i = 0; i < 40; i++) { const n = (await pool.query(`SELECT COUNT(*)::int n FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL`)).rows[0].n; if (n === 0) break; await sleep(250); }
    eq((await pool.query(`SELECT COUNT(*)::int n FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL`)).rows[0].n, 0);
    const pushes = booking.log.filter((l) => l.rpc === 'Push'); const pub = (await pool.query(`SELECT COUNT(*)::int n FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NOT NULL`)).rows[0].n; eq(pushes.length, pub, 'un Push por cada evento publicado'); ok(pushes.length > 0 && pushes.every((l) => l.meta.service_id === 'NODE_ATR_ALISSON' && l.meta.api_key === 'clave-booking-e2e'), 'cada Push gRPC lleva las cabeceras service_id y x-api-key');
    const m = pushes[0]; eq(m.service_id, 'NODE_ATR_ALISSON'); ok(/^slot-\d{8}-\d{4}$/.test(m.slot_id)); ok(/^\d{2}:\d{2} [ap]\.m\.$/.test(m.time_slot));
  });
  await t('el stock de Booking coincide con la BD local y los timestamps por slot son estrictamente crecientes', async () => {
    const rows = (await pool.query(`SELECT v.slot_id, v.cupos_disponibles, a.atr_codigo FROM v_turno_disponibilidad v JOIN atraccion a ON a.atr_id=v.atr_id WHERE v.tur_id IN (SELECT DISTINCT tur_id FROM reserva)`)).rows;
    for (const r of rows) eq(booking.slots.get(r.atr_codigo + '|' + r.slot_id)?.available, r.cupos_disponibles, 'slot ' + r.slot_id);
    const by = new Map(); for (const l of booking.log.filter((x) => x.rpc === 'Push')) { const k = l.item_id + '|' + l.slot_id; (by.get(k) ?? by.set(k, []).get(k)).push(l.timestamp); }
    for (const [s, ts] of by) for (let i = 1; i < ts.length; i++) ok(ts[i] > ts[i - 1], `timestamp no monótono en ${s}`);
  });
  await t('STALE_TIMESTAMP_IGNORED se trata como entregado (no reintenta eternamente)', async () => {
    const key = [...booking.slots.keys()][0]; const [item, slot] = key.split('|'); booking.slots.get(key).ts = Date.now() + 10 * 60_000; // Booking "ya vio" un dato futuro
    const tur = (await pool.query(`SELECT t.tur_id FROM turno t JOIN horario h ON h.hor_id=t.hor_id JOIN atraccion a ON a.atr_id=h.atr_id
        WHERE a.atr_codigo=$1 AND t.tur_fecha=$2 AND h.hor_hora=$3::time`, [item, slot.slice(5, 9) + '-' + slot.slice(9, 11) + '-' + slot.slice(11, 13), slot.slice(14, 16) + ':' + slot.slice(16)])).rows[0];
    ok(tur, 'turno no hallado');
    await http('PATCH', `/admin/turnos/${tur.tur_id}`, { token: adminToken, body: { cerrado: false } });
    for (let i = 0; i < 30; i++) { const n = (await pool.query(`SELECT COUNT(*)::int n FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL`)).rows[0].n; if (n === 0) break; await sleep(200); }
    const stale = (await pool.query(`SELECT COUNT(*)::int n FROM outbox_evento WHERE evt_ultimo_error LIKE 'STALE%'`)).rows[0].n; ok(stale >= 1, 'no se registró STALE');
  });
  await t('Booking caído: el Outbox acumula sin perder eventos y al volver se entrega todo en orden', async () => {
    await booking.stop();
    const d = addDays(12); const rs = await Promise.all([1, 2, 3].map((i) => post(reserva({ slot_id: slotOf(d, '14:00'), date: d, time: '2:00 p.m.', adult_count: 1, child_count: 0, customer: { ...reserva().customer, document_id: cedula(6000000 + i) } }))));
    ok(rs.every((r) => r.status === 201), 'la venta no debe depender de que Booking esté arriba'); await sleep(1500);
    const pend = (await pool.query(`SELECT COUNT(*)::int n FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL`)).rows[0].n; ok(pend >= 3, 'pendientes: ' + pend);
    eq((await http('GET', '/atracciones/health')).json.grpc.pending_stock_events >= 3, true);
    Object.assign(booking, await startMock({ port: GRPC_PORT })); // Booking "revive" (estado vacío)
    for (let i = 0; i < 40; i++) { const n = (await pool.query(`SELECT COUNT(*)::int n FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL`)).rows[0].n; if (n === 0) break; await sleep(250); }
    const left = (await pool.query(`SELECT evt_id, evt_intentos, left(evt_ultimo_error,160) e, evt_proximo_intento - now() AS wait FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL`)).rows;
    ok(left.length === 0, 'sin entregar: ' + JSON.stringify(left));
    eq(booking.slots.get('PRhu4UBTWPBC|' + slotOf(d, '14:00'))?.available, 17);
  });
  await t('conciliación: GetSlotAvailability detecta diferencias y StreamInventoryChanges las corrige con deltas', async () => {
    const d = addDays(12); booking.slots.get('PRhu4UBTWPBC|' + slotOf(d, '14:00')).available = 10; // Booking desincronizado
    const r = await http('POST', '/admin/sync/conciliar', { token: adminToken, body: { dias: 20 } }); eq(r.status, 200); ok(r.json.differences >= 1, JSON.stringify(r.json));
    eq(booking.slots.get('PRhu4UBTWPBC|' + slotOf(d, '14:00')).available, 17); ok(booking.log.some((l) => l.rpc === 'Stream' && l.event_id && l.delta === 7));
    const again = await http('POST', '/admin/sync/conciliar', { token: adminToken, body: { dias: 20 } }); eq(again.json.differences, 0);
  });
  await t('admin: bloquear el turno (cerrado) lo publica como AGOTADO en Booking; capacidad no puede bajar de lo reservado', async () => {
    const d = addDays(3); const tur = (await pool.query(`SELECT t.tur_id FROM turno t JOIN horario h ON h.hor_id=t.hor_id WHERE h.atr_id=$1 AND t.tur_fecha=$2`, [nuevo.id, d])).rows[0];
    eq((await http('PATCH', `/admin/turnos/${tur.tur_id}`, { token: adminToken, body: { cupo_total: 2 } })).status, 400);
    eq((await http('PATCH', `/admin/turnos/${tur.tur_id}`, { token: adminToken, body: { cupo_total: 8 } })).status, 200);
    for (let i = 0; i < 20; i++) { if (booking.slots.get(nuevo.codigo + '|' + slotOf(d, '08:00'))?.available === 3) break; await sleep(200); }
    eq(booking.slots.get(nuevo.codigo + '|' + slotOf(d, '08:00'))?.available, 3);
  });
  await t('admin: eliminar atracción con reservas futuras activas → 409; sin ellas → 204 (borrado lógico)', async () => {
    eq((await http('DELETE', `/admin/atracciones/${nuevo.codigo}`, { token: adminToken })).status, 409);
    const lim = await http('POST', '/admin/atracciones', { token: adminToken, body: { nombre: 'Temporal', descripcion: 'x', tipo: 'ADMISSION', ciudad_id: quitoId, operador_id: operadorId, latitud: 0, longitud: 0, duracion_horas: 1 } });
    eq((await http('DELETE', `/admin/atracciones/${lim.json.codigo}`, { token: adminToken })).status, 204);
    eq((await http('GET', `/admin/atracciones/${lim.json.codigo}`, { token: adminToken })).status, 404);
  });
} finally {
  srv.kill('SIGTERM'); restMock.close(); await booking.stop().catch(() => {}); await pool.end().catch(() => {});
}
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} pruebas OK, ${fail} fallidas`);
if (fail) { console.log('Fallidas:\n - ' + failures.join('\n - ')); console.log('\n--- log del servidor (últimas líneas) ---\n' + srvLog.split('\n').slice(-25).join('\n')); }
process.exit(fail ? 1 : 0);
