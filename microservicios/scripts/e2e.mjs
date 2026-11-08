// Pruebas de extremo a extremo de los 3 microservicios + Booking simulado + Saga de compra con compensación.
//   npm run e2e        (usa Postgres LOCAL; BORRA y recrea las bases ms_inventory, ms_order y ms_booking)
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { startMock } from './booking-mock.mjs';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG = (process.env.E2E_PG ?? 'postgresql://postgres:postgres@localhost:5432').replace(/\/$/, '');
if (!['localhost', '127.0.0.1', '::1'].includes(new URL(PG).hostname) && process.env.E2E_ALLOW_RESET !== '1') {
  console.error('❌ Este script BORRA las bases ms_*. Se niega a correr contra un servidor que no es local (use E2E_ALLOW_RESET=1 solo si está segura).'); process.exit(1);
}
const MS = { inventory: 50161, order: 50162, booking: 50163 }; const MOCK = 50151;

// ---------- infraestructura ----------
for (const n of ['inventory', 'order', 'booking'])
  execFileSync(process.execPath, ['scripts/db.mjs', 'reset'], { cwd: path.join(raiz, `ms_${n}`), env: { ...process.env, DATABASE_URL: `${PG}/ms_${n}` }, stdio: 'inherit' });
let mock = await startMock({ port: MOCK });
const procesos = ['inventory', 'order', 'booking'].map((n) => {
  const p = spawn(process.execPath, ['src/server.mjs'], { cwd: path.join(raiz, `ms_${n}`), stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DATABASE_URL: `${PG}/ms_${n}`, GRPC_PORT: String(MS[n]), BOOKING_GRPC_TARGET: `localhost:${MOCK}`, BOOKING_GRPC_TLS: 'false', GRPC_ENABLED: 'true', GRPC_RETRY_MS: '1500', SERVICE_ID: 'NODE_ATR_ALISSON' } });
  return p;
});
const esperarPuerto = (port) => new Promise((res, rej) => {
  const t0 = Date.now();
  const intento = () => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(); }); s.on('error', () => { s.destroy(); Date.now() - t0 > 15000 ? rej(new Error(`puerto ${port} no abrió`)) : setTimeout(intento, 200); }); };
  intento();
});
await Promise.all(Object.values(MS).map(esperarPuerto));

function cliente(ms, paquete, servicio, port) {
  const def = protoLoader.loadSync(path.join(raiz, ms, 'proto', `${ms}.proto`), { keepCase: true, longs: Number, defaults: true, arrays: true });
  const C = paquete.split('.').reduce((o, k) => o[k], grpc.loadPackageDefinition(def))[servicio];
  const c = new C(`localhost:${port}`, grpc.credentials.createInsecure());
  return new Proxy({}, { get: (_, m) => (req = {}) => new Promise((res, rej) => c[m](req, { deadline: Date.now() + 8000 }, (e, r) => {
    if (!e) return res(r);
    let cuerpo = {}; try { cuerpo = JSON.parse(e.details); } catch { cuerpo = { message: e.details }; }
    rej(Object.assign(new Error(`${e.code} ${cuerpo.code ?? ''} ${cuerpo.message ?? ''}`), { status: e.code, code: cuerpo.code, invalid_params: cuerpo.invalid_params ?? [] }));
  })) });
}
const inv = cliente('ms_inventory', 'ms_inventory.v1', 'InventoryService', MS.inventory);
const ord = cliente('ms_order', 'ms_order.v1', 'OrderService', MS.order);
const bok = cliente('ms_booking', 'ms_booking.v1', 'BookingService', MS.booking);
const S = grpc.status;

// ---------- mini framework de pruebas ----------
let pasaron = 0; const fallaron = [];
const t = async (nombre, fn) => { try { await fn(); pasaron++; console.log(`  ✓ ${nombre}`); } catch (e) { fallaron.push(nombre); console.log(`  ✗ ${nombre}\n      ${e.message}`); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} esperado ${JSON.stringify(b)}, recibido ${JSON.stringify(a)}`); };
const ok = (c, m = 'condición falsa') => { if (!c) throw new Error(m); };
const falla = async (p, status, code) => { try { await p; } catch (e) { eq(e.status, status, 'status gRPC'); if (code) eq(e.code, code, 'code'); return e; } throw new Error('se esperaba un error y no ocurrió'); };
const esperar = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const dia = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const enBooking = (atr, slot) => mock.slots.get(`${atr}|${slot}`);

try {
  console.log('\n== ms_inventory ==');
  let h9, d9; const F = dia(10), F2 = dia(11), F3 = dia(12);
  await t('crear horario 09:00 (cupo 5)', async () => { h9 = await inv.CreateHorario({ atr_id: 1001, hor_hora: '09:00', hor_cupo: 5 }); eq(h9.hor_hora, '09:00'); eq(h9.hor_cupo, 5); });
  await t('horario duplicado → ALREADY_EXISTS', () => falla(inv.CreateHorario({ atr_id: 1001, hor_hora: '09:00', hor_cupo: 5 }), S.ALREADY_EXISTS, 'HORARIO_DUPLICATE'));
  await t('hora inválida (25:00) → INVALID_ARGUMENT con invalid_params', async () => { const e = await falla(inv.CreateHorario({ atr_id: 1001, hor_hora: '25:00' }), S.INVALID_ARGUMENT, 'VALIDATION_ERROR'); eq(e.invalid_params[0].name, 'hor_hora'); });
  await t('crear segundo horario 14:00 (cupo por defecto 20)', async () => { const h = await inv.CreateHorario({ atr_id: 1001, hor_hora: '14:00' }); eq(h.hor_cupo, 20); });
  await t('ListHorarios paginado (limit 1 → 2 páginas)', async () => { const r = await inv.ListHorarios({ atr_id: 1001, page: 1, limit: 1 }); eq(r.data.length, 1); eq(r.metadata.total_results, 2); eq(r.metadata.total_pages, 2); });
  await t('GenerateAvailability crea 2 horarios × 3 días = 6', async () => { const r = await inv.GenerateAvailability({ atr_id: 1001, fecha_desde: F, fecha_hasta: F3 }); eq(r.creadas, 6); });
  await t('GenerateAvailability repetido no duplica', async () => { const r = await inv.GenerateAvailability({ atr_id: 1001, fecha_desde: F, fecha_hasta: F3 }); eq(r.creadas, 0); });
  await t('rango mayor a 62 días → RANGE_TOO_LARGE', () => falla(inv.GenerateAvailability({ atr_id: 1001, fecha_desde: F, fecha_hasta: dia(100) }), S.INVALID_ARGUMENT, 'RANGE_TOO_LARGE'));
  await t('ListAvailability paginado y ordenado', async () => {
    const r = await inv.ListAvailability({ atr_id: 1001, page: 1, limit: 4 }); eq(r.data.length, 4); eq(r.metadata.total_results, 6); eq(r.metadata.total_pages, 2);
    eq(r.data[0].dis_fecha, F); eq(r.data[0].hor_hora, '09:00'); eq(r.data[1].hor_hora, '14:00'); d9 = r.data[0];
  });
  await t('ListAvailability: limit 101 → INVALID_ARGUMENT', () => falla(inv.ListAvailability({ atr_id: 1001, limit: 101 }), S.INVALID_ARGUMENT, 'VALIDATION_ERROR'));
  await t('disponibilidad: cupos = total - reservado y slot_id canónico', async () => { const a = await inv.GetAvailability({ dis_id: d9.dis_id }); eq(a.cupos_disponibles, a.dis_cupo_total - a.dis_cupo_reservado); eq(a.slot_id, `slot-${F.replace(/-/g, '')}-0900`); });
  await t('GetAvailability inexistente → NOT_FOUND', () => falla(inv.GetAvailability({ dis_id: 999999 }), S.NOT_FOUND, 'AVAILABILITY_NOT_FOUND'));
  await t('ReserveSlots 2 de 5 → quedan 3', async () => { const r = await inv.ReserveSlots({ dis_id: d9.dis_id, cantidad: 2 }); ok(r.success); eq(r.availability.cupos_disponibles, 3); });
  await t('ReserveSlots 4 con 3 libres → OUT_OF_STOCK (sin cambios)', async () => { const r = await inv.ReserveSlots({ dis_id: d9.dis_id, cantidad: 4 }); eq(r.success, false); eq(r.error_code, 'OUT_OF_STOCK'); eq(r.availability.cupos_disponibles, 3); });
  await t('ReleaseSlots 1 → 4 libres; liberar de más → INVALID_RELEASE', async () => {
    const r = await inv.ReleaseSlots({ dis_id: d9.dis_id, cantidad: 1 }); ok(r.success); eq(r.availability.cupos_disponibles, 4);
    const x = await inv.ReleaseSlots({ dis_id: d9.dis_id, cantidad: 10 }); eq(x.error_code, 'INVALID_RELEASE');
  });
  await t('Booking (simulado) recibe PushStockUpdate con item_id=atr_id, units=4 y time_slot "09:00 a.m."', async () => {
    const slot = `slot-${F.replace(/-/g, '')}-0900`;
    ok(await esperar(() => enBooking('1001', slot)?.available === 4), `Booking tiene ${JSON.stringify(enBooking('1001', slot))}`);
    eq(enBooking('1001', slot).time_slot, '09:00 a.m.'); eq(enBooking('1001', slot).date, F);
  });
  await t('GetSyncStatus: envíos OK y ningún error', async () => { const s = await inv.GetSyncStatus({}); ok(s.sent_ok >= 1, 'sent_ok=' + s.sent_ok); eq(s.last_error, ''); eq(s.target, `localhost:${MOCK}`); });
  await t('SyncToBooking manual → success', async () => { const r = await inv.SyncToBooking({ dis_id: d9.dis_id }); ok(r.success, r.message); });
  await t('BlockDate cierra los 2 turnos del día; Booking queda en 0', async () => {
    const r = await inv.BlockDate({ atr_id: 1001, fb_fecha: F2, fb_motivo: 'Feriado de prueba' }); eq(r.slots_cerrados, 2);
    const slot = `slot-${F2.replace(/-/g, '')}-0900`; ok(await esperar(() => enBooking('1001', slot)?.available === 0), 'Booking no quedó en 0');
  });
  await t('BlockDate repetido → ALREADY_EXISTS', () => falla(inv.BlockDate({ atr_id: 1001, fb_fecha: F2, fb_motivo: 'otra vez' }), S.ALREADY_EXISTS, 'DATE_ALREADY_BLOCKED'));
  await t('reservar en turno cerrado → SLOT_CLOSED', async () => { const l = await inv.ListAvailability({ atr_id: 1001, fecha_desde: F2, fecha_hasta: F2 }); const r = await inv.ReserveSlots({ dis_id: l.data[0].dis_id, cantidad: 1 }); eq(r.error_code, 'SLOT_CLOSED'); });
  await t('turnos de una fecha bloqueada no se generan', async () => { const r = await inv.GenerateAvailability({ atr_id: 1001, fecha_desde: F2, fecha_hasta: F2 }); eq(r.creadas, 0); });
  await t('CONCURRENCIA: 12 compradores, cupo 5 → exactamente 5 ganan y 7 OUT_OF_STOCK', async () => {
    await inv.CreateHorario({ atr_id: 1002, hor_hora: '10:00', hor_cupo: 5 }); await inv.GenerateAvailability({ atr_id: 1002, fecha_desde: F, fecha_hasta: F });
    const dis = (await inv.ListAvailability({ atr_id: 1002 })).data[0].dis_id;
    const rs = await Promise.all(Array.from({ length: 12 }, () => inv.ReserveSlots({ dis_id: dis, cantidad: 1 })));
    eq(rs.filter((r) => r.success).length, 5); eq(rs.filter((r) => r.error_code === 'OUT_OF_STOCK').length, 7);
    const a = await inv.GetAvailability({ dis_id: dis }); eq(a.dis_cupo_reservado, 5); eq(a.cupos_disponibles, 0);
    ok(await esperar(() => enBooking('1002', `slot-${F.replace(/-/g, '')}-1000`)?.available === 0), 'Booking no terminó en 0');
  });

  console.log('\n== ms_order ==');
  const items = [{ atr_id: 1001, det_descripcion: 'Tour Centro Histórico (adulto)', det_cantidad: 2, det_precio_unitario: 25 }, { atr_id: 1001, det_descripcion: 'Tour Centro Histórico (niño)', det_cantidad: 1, det_precio_unitario: 12.5 }];
  const KEY = '6f1b3c1e-5a7d-4f0a-9a43-7d1c8f0e2b11'; let o1;
  await t('CreateOrder: totales y numeración', async () => {
    o1 = await ord.CreateOrder({ usu_id: 5, items, ord_descuento: 5, cup_ids: [1, 2], idempotency_key: KEY });
    eq(o1.ord_subtotal, 62.5); eq(o1.ord_total, 57.5); eq(o1.est_codigo, 'CREADA'); ok(/^ORD-\d{6}-[A-Z0-9]{6}$/.test(o1.ord_numero), o1.ord_numero);
    eq(o1.detalles.length, 2); eq(o1.detalles[0].det_subtotal, 50); eq(o1.cup_ids, [1, 2]); eq(o1.idempotent_replay, false);
  });
  await t('idempotencia: misma clave y cuerpo → misma orden (replay=true)', async () => { const o = await ord.CreateOrder({ usu_id: 5, items, ord_descuento: 5, cup_ids: [1, 2], idempotency_key: KEY }); eq(o.ord_id, o1.ord_id); eq(o.idempotent_replay, true); eq((await ord.ListOrders({ usu_id: 5 })).metadata.total_results, 1); });
  await t('idempotencia: misma clave, otro cuerpo → IDEMPOTENCY_KEY_REUSED', () => falla(ord.CreateOrder({ usu_id: 5, items: [items[0]], idempotency_key: KEY }), S.ALREADY_EXISTS, 'IDEMPOTENCY_KEY_REUSED'));
  await t('idempotencia concurrente: 5 peticiones iguales → una sola orden', async () => {
    const k = 'a1b2c3d4-0000-4000-8000-000000000001';
    const rs = await Promise.all(Array.from({ length: 5 }, () => ord.CreateOrder({ usu_id: 6, items: [items[0]], idempotency_key: k })));
    eq(new Set(rs.map((r) => r.ord_id)).size, 1); eq((await ord.ListOrders({ usu_id: 6 })).metadata.total_results, 1);
  });
  await t('sin items → INVALID_ARGUMENT', () => falla(ord.CreateOrder({ usu_id: 5, items: [] }), S.INVALID_ARGUMENT, 'VALIDATION_ERROR'));
  await t('descuento mayor al subtotal → DISCOUNT_EXCEEDS_SUBTOTAL', () => falla(ord.CreateOrder({ usu_id: 5, items: [items[0]], ord_descuento: 999 }), S.INVALID_ARGUMENT, 'DISCOUNT_EXCEEDS_SUBTOTAL'));
  await t('precio con 3 decimales → INVALID_ARGUMENT', () => falla(ord.CreateOrder({ usu_id: 5, items: [{ ...items[0], det_precio_unitario: 25.123 }] }), S.INVALID_ARGUMENT, 'VALIDATION_ERROR'));
  await t('línea con precio 0 (infante) es válida', async () => { const o = await ord.CreateOrder({ usu_id: 7, items: [{ atr_id: 1001, det_descripcion: 'Infante', det_cantidad: 1, det_precio_unitario: 0 }] }); eq(o.ord_total, 0); });
  await t('un carrito solo se convierte en una orden', async () => { await ord.CreateOrder({ usu_id: 8, car_id: 77, items: [items[0]] }); await falla(ord.CreateOrder({ usu_id: 8, car_id: 77, items: [items[0]] }), S.ALREADY_EXISTS, 'CART_ALREADY_CONVERTED'); });
  await t('GetOrder por id y por número; inexistente → NOT_FOUND', async () => {
    eq((await ord.GetOrder({ ord_id: o1.ord_id })).ord_numero, o1.ord_numero); eq((await ord.GetOrder({ ord_numero: o1.ord_numero })).ord_id, o1.ord_id);
    await falla(ord.GetOrder({ ord_id: 99999 }), S.NOT_FOUND, 'ORDER_NOT_FOUND'); await falla(ord.GetOrder({}), S.INVALID_ARGUMENT, 'VALIDATION_ERROR');
  });
  await t('ListOrders paginado y con filtros', async () => {
    for (let i = 0; i < 3; i++) await ord.CreateOrder({ usu_id: 9, items: [items[0]] });
    const p1 = await ord.ListOrders({ usu_id: 9, page: 1, limit: 2 }); const p2 = await ord.ListOrders({ usu_id: 9, page: 2, limit: 2 });
    eq(p1.data.length, 2); eq(p2.data.length, 1); eq(p1.metadata.total_pages, 2); eq((await ord.ListOrders({ usu_id: 9, est_codigo: 'PAGADA' })).metadata.total_results, 0);
  });
  await t('transiciones: CREADA→PAGADA ok; PAGADA→CANCELADA no; PAGADA→REEMBOLSADA ok; REEMBOLSADA→PAGADA no', async () => {
    eq((await ord.UpdateOrderStatus({ ord_id: o1.ord_id, est_codigo: 'PAGADA' })).est_codigo, 'PAGADA');
    await falla(ord.UpdateOrderStatus({ ord_id: o1.ord_id, est_codigo: 'CANCELADA' }), S.FAILED_PRECONDITION, 'INVALID_TRANSITION');
    eq((await ord.UpdateOrderStatus({ ord_id: o1.ord_id, est_codigo: 'REEMBOLSADA' })).est_codigo, 'REEMBOLSADA');
    await falla(ord.UpdateOrderStatus({ ord_id: o1.ord_id, est_codigo: 'PAGADA' }), S.FAILED_PRECONDITION, 'INVALID_TRANSITION');
  });

  console.log('\n== ms_booking ==');
  const pax = [{ pax_nombre: 'Ana Pérez', pax_documento: '1712345678', pax_es_titular: true }, { pax_nombre: 'Luis Pérez', pax_fecha_nacimiento: '2015-03-02' }];
  const base = { det_id: 501, dis_id: 1, res_adultos: 2, res_ninos: 1, res_precio_unitario: 25, pasajeros: pax }; let r1;
  await t('CreateReservation: PENDIENTE_PAGO, tickets, subtotal y código DEC-XXXXXX', async () => {
    r1 = await bok.CreateReservation(base); eq(r1.est_codigo, 'PENDIENTE_PAGO'); eq(r1.res_numero_tickets, 3); eq(r1.res_subtotal, 75); ok(/^DEC-[A-Z0-9]{6}$/.test(r1.res_codigo));
    eq(r1.pasajeros.length, 2); eq(r1.pasajeros[0].pax_es_titular, true);
  });
  await t('dos titulares / ningún titular → HOLDER_REQUIRED', async () => {
    await falla(bok.CreateReservation({ ...base, det_id: 502, pasajeros: pax.map((p) => ({ ...p, pax_es_titular: true })) }), S.INVALID_ARGUMENT, 'HOLDER_REQUIRED');
    await falla(bok.CreateReservation({ ...base, det_id: 502, pasajeros: [{ pax_nombre: 'Sin Titular' }] }), S.INVALID_ARGUMENT, 'HOLDER_REQUIRED');
  });
  await t('más pasajeros que tickets → TOO_MANY_PASSENGERS', () => falla(bok.CreateReservation({ ...base, det_id: 502, res_adultos: 1, res_ninos: 0, pasajeros: pax }), S.INVALID_ARGUMENT, 'TOO_MANY_PASSENGERS'));
  await t('documento inválido → VALIDATION_ERROR señalando el campo', async () => { const e = await falla(bok.CreateReservation({ ...base, det_id: 502, pasajeros: [{ pax_nombre: 'Ana', pax_documento: '123', pax_es_titular: true }] }), S.INVALID_ARGUMENT, 'VALIDATION_ERROR'); ok(e.invalid_params[0].name.includes('pax_documento'), e.invalid_params[0].name); });
  await t('misma línea de orden dos veces → RESERVATION_ALREADY_EXISTS', () => falla(bok.CreateReservation(base), S.ALREADY_EXISTS, 'RESERVATION_ALREADY_EXISTS'));
  await t('GetReservation por uuid y por código; inexistente → NOT_FOUND', async () => {
    eq((await bok.GetReservation({ res_uuid: r1.res_uuid })).res_codigo, r1.res_codigo); eq((await bok.GetReservation({ res_codigo: r1.res_codigo })).res_uuid, r1.res_uuid);
    await falla(bok.GetReservation({ res_codigo: 'DEC-ZZZZZZ' }), S.NOT_FOUND, 'RESERVATION_NOT_FOUND');
  });
  await t('ConfirmReservation → CONFIRMADA (con fecha); confirmar otra vez → INVALID_TRANSITION', async () => {
    const c = await bok.ConfirmReservation({ res_uuid: r1.res_uuid }); eq(c.est_codigo, 'CONFIRMADA'); ok(c.res_confirmado_en);
    await falla(bok.ConfirmReservation({ res_uuid: r1.res_uuid }), S.FAILED_PRECONDITION, 'INVALID_TRANSITION');
  });
  await t('CancelReservation exige motivo; cancela; luego no se puede completar', async () => {
    await falla(bok.CancelReservation({ res_codigo: r1.res_codigo }), S.INVALID_ARGUMENT, 'VALIDATION_ERROR');
    const c = await bok.CancelReservation({ res_codigo: r1.res_codigo, res_motivo_cancelacion: 'El cliente se arrepintió' }); eq(c.est_codigo, 'CANCELADA'); ok(c.res_cancelado_en); eq(c.res_motivo_cancelacion, 'El cliente se arrepintió');
    await falla(bok.CompleteReservation({ res_codigo: r1.res_codigo }), S.FAILED_PRECONDITION, 'INVALID_TRANSITION');
  });
  await t('tras cancelar, la misma línea de orden puede reservarse de nuevo', async () => { const r = await bok.CreateReservation(base); eq(r.est_codigo, 'PENDIENTE_PAGO'); });
  await t('ciclo completo: PENDIENTE_PAGO → CONFIRMADA → COMPLETADA', async () => {
    const r = await bok.CreateReservation({ ...base, det_id: 503 }); await bok.ConfirmReservation({ res_uuid: r.res_uuid });
    eq((await bok.CompleteReservation({ res_uuid: r.res_uuid })).est_codigo, 'COMPLETADA');
  });
  await t('ListReservations paginado y filtrado por estado', async () => {
    for (const d of [510, 511, 512]) await bok.CreateReservation({ ...base, det_id: d });
    const p = await bok.ListReservations({ page: 1, limit: 2 }); eq(p.data.length, 2); ok(p.metadata.total_results >= 5); ok(p.metadata.total_pages >= 3);
    eq((await bok.ListReservations({ est_codigo: 'COMPLETADA' })).metadata.total_results, 1);
  });

  console.log('\n== SAGA de compra (inventory → order → booking) con compensación ==');
  const hoy = dia(20);
  await inv.CreateHorario({ atr_id: 1003, hor_hora: '11:30', hor_cupo: 4 }); await inv.GenerateAvailability({ atr_id: 1003, fecha_desde: hoy, fecha_hasta: hoy });
  const dis = (await inv.ListAvailability({ atr_id: 1003 })).data[0]; 
  async function comprar({ usu, adultos, ninos = 0, pasajeros }) {
    const tickets = adultos + ninos;
    const r = await inv.ReserveSlots({ dis_id: dis.dis_id, cantidad: tickets });                      // 1) reservar cupo
    if (!r.success) return { ok: false, paso: 'inventory', codigo: r.error_code };
    let orden;
    try { orden = await ord.CreateOrder({ usu_id: usu, items: [{ atr_id: 1003, det_descripcion: 'Tour Saga', det_cantidad: tickets, det_precio_unitario: 20 }] }); }   // 2) crear orden
    catch (e) { await inv.ReleaseSlots({ dis_id: dis.dis_id, cantidad: tickets }); return { ok: false, paso: 'order', codigo: e.code }; }
    try { var reserva = await bok.CreateReservation({ det_id: orden.detalles[0].det_id, dis_id: dis.dis_id, res_adultos: adultos, res_ninos: ninos, res_precio_unitario: 20, pasajeros }); }  // 3) crear reserva
    catch (e) {                                                                                                    // COMPENSACIÓN (LIFO): cancelar orden y devolver cupo
      await ord.UpdateOrderStatus({ ord_id: orden.ord_id, est_codigo: 'CANCELADA' }); await inv.ReleaseSlots({ dis_id: dis.dis_id, cantidad: tickets });
      return { ok: false, paso: 'booking', codigo: e.code, compensado: true, ord_id: orden.ord_id };
    }
    await ord.UpdateOrderStatus({ ord_id: orden.ord_id, est_codigo: 'PAGADA' }); await bok.ConfirmReservation({ res_uuid: reserva.res_uuid });   // 4) pago simulado y confirmación
    return { ok: true, orden, reserva };
  }
  const titular = [{ pax_nombre: 'Ana Pérez', pax_documento: '1712345678', pax_es_titular: true }];
  const libres = async () => (await inv.GetAvailability({ dis_id: dis.dis_id })).cupos_disponibles;
  await t('A) compra feliz de 2 cupos: orden PAGADA, reserva CONFIRMADA, quedan 2', async () => {
    const r = await comprar({ usu: 900, adultos: 2, pasajeros: [...titular, { pax_nombre: 'Luis Pérez' }] }); ok(r.ok, JSON.stringify(r));
    eq((await ord.GetOrder({ ord_id: r.orden.ord_id })).est_codigo, 'PAGADA'); eq((await bok.GetReservation({ res_uuid: r.reserva.res_uuid })).est_codigo, 'CONFIRMADA'); eq(await libres(), 2);
  });
  await t('B) pedir 3 con 2 libres: OUT_OF_STOCK en el primer paso; NO se crea orden ni reserva', async () => {
    const antes = (await ord.ListOrders({ usu_id: 901 })).metadata.total_results;
    const r = await comprar({ usu: 901, adultos: 3, pasajeros: titular }); eq(r.ok, false); eq(r.paso, 'inventory'); eq(r.codigo, 'OUT_OF_STOCK');
    eq((await ord.ListOrders({ usu_id: 901 })).metadata.total_results, antes); eq(await libres(), 2);
  });
  await t('C) falla al crear la reserva (sin titular): se COMPENSA → orden CANCELADA y cupo devuelto', async () => {
    const r = await comprar({ usu: 902, adultos: 1, pasajeros: [{ pax_nombre: 'Sin Titular' }] }); eq(r.ok, false); eq(r.paso, 'booking'); eq(r.compensado, true);
    eq((await ord.GetOrder({ ord_id: r.ord_id })).est_codigo, 'CANCELADA'); eq(await libres(), 2);
  });
  await t('D) última compra agota el turno (0 libres) y la siguiente es OUT_OF_STOCK', async () => {
    const r = await comprar({ usu: 903, adultos: 2, pasajeros: [...titular, { pax_nombre: 'Marta Gómez' }] }); ok(r.ok, JSON.stringify(r)); eq(await libres(), 0);
    eq((await comprar({ usu: 904, adultos: 1, pasajeros: titular })).codigo, 'OUT_OF_STOCK');
  });
  await t('Booking (simulado) termina viendo 0 unidades para ese turno', async () => { ok(await esperar(() => enBooking('1003', `slot-${hoy.replace(/-/g, '')}-1130`)?.available === 0), JSON.stringify(enBooking('1003', `slot-${hoy.replace(/-/g, '')}-1130`))); });

  console.log('\n== Resiliencia: Booking caído y reconectado ==');
  const disR = (await inv.ListAvailability({ atr_id: 1001, fecha_desde: F3, fecha_hasta: F3 })).data[0]; const slotR = `slot-${F3.replace(/-/g, '')}-0900`;
  await mock.stop();
  const antesFallos = (await inv.GetSyncStatus({})).sent_failed;
  await t('con Booking caído la reserva de cupo SIGUE funcionando (la venta no se pierde)', async () => { const r = await inv.ReserveSlots({ dis_id: disR.dis_id, cantidad: 1 }); ok(r.success); eq(r.availability.cupos_disponibles, 4); });
  await t('el envío fallido queda registrado en GetSyncStatus', async () => { ok(await esperar(async () => (await inv.GetSyncStatus({})).sent_failed > antesFallos, 12000), 'no se registró el fallo'); ok((await inv.GetSyncStatus({})).last_error.length > 0); });
  mock = await startMock({ port: MOCK });
  await t('al volver Booking, el reintento automático entrega el cupo correcto (4)', async () => { ok(await esperar(() => enBooking('1001', slotR)?.available === 4, 25000), JSON.stringify(enBooking('1001', slotR))); });
} finally {
  procesos.forEach((p) => p.kill('SIGINT')); await mock.stop().catch(() => {});
  console.log(`\n${fallaron.length ? '❌' : '✅'} ${pasaron} pruebas OK, ${fallaron.length} fallidas${fallaron.length ? ':\n - ' + fallaron.join('\n - ') : ''}`);
  setTimeout(() => process.exit(fallaron.length ? 1 : 0), 500);
}
