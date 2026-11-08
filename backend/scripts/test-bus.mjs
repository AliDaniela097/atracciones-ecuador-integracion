// Prueba del bus RabbitMQ con un broker simulado EN MEMORIA (no toca CloudAMQP). Verifica: 1 conexión/2 canales, formato CloudEvents de stock.updated,
// consumo con ACK, reintentos → DLQ, deduplicación, filtrado de reservas ajenas y compensación idempotente.
//   npm run build && npm run test:bus      (requiere DATABASE_URL local con el esquema migrado; no modifica datos de negocio)
import 'dotenv/config';
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)) { console.error('Rechazado: DATABASE_URL debe ser una BD local.'); process.exit(1); }
Object.assign(process.env, { AMQP_URL: 'amqps://usuario:clave@broker.invalido/vhost', AMQP_MAX_RETRIES: '1', SERVICE_ID: 'NODE_ATR_ALISSON', AMQP_PUBLISH_TIMEOUT_MS: '2000' });
const fake = (await import('@onify/fake-amqplib')).default ?? (await import('@onify/fake-amqplib'));
const { AmqpService } = await import('../dist/bus/amqp.service.js');
const { BusHandlers } = await import('../dist/bus/bus-handlers.service.js');
const { Db } = await import('../dist/db/db.service.js');
const { ApiProblem } = await import('../dist/common/problem.js');
const { config } = await import('../dist/config.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m ?? 'falso'); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m ?? 'eq'}: esperado ${JSON.stringify(b)}, recibido ${JSON.stringify(a)}`); };
const t = async (n, f) => { try { await f(); pass++; console.log('  ✔ ' + n); } catch (e) { fail++; console.log('  ✘ ' + n + '\n      ' + e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const evento = (tipo, data, id = uuid()) => ({ specversion: '1.0', id, type: 'com.booking.' + tipo, source: 'BOOKING', time: new Date().toISOString(), datacontenttype: 'application/json', correlationid: uuid(), node_id: 'BOOKING', data });

const db = new Db();
const amqp = new AmqpService();
// El simulador no implementa dead-lettering (lo hace RabbitMQ real): se registran las llamadas para verificar que se declara el DLX y que se rechaza sin reencolar.
const reg = { colas: {}, nacks: [] };
const conectar = async (u, o) => { const c = await fake.connect(u, o); const cc = c.createChannel.bind(c);
  c.createChannel = async () => { const ch = await cc(); const aq = ch.assertQueue.bind(ch); ch.assertQueue = (n, a) => { reg.colas[n] = a; return aq(n, a); }; const nk = ch.nack.bind(ch); ch.nack = (m, all, rq) => { reg.nacks.push({ all, rq }); return nk(m, all, rq); }; return ch; }; return c; };
amqp.conectar = conectar;
// "Booking": segunda conexión independiente que publica y escucha
const bk = await fake.connect(process.env.AMQP_URL); const bpub = await bk.createChannel(); await bpub.assertExchange('booking.events', 'topic', { durable: true });
const spy = await bk.createChannel(); const qs = (await spy.assertQueue('', { exclusive: true })).queue; await spy.bindQueue(qs, 'booking.events', 'stock.updated');

const llamadas = []; let modo = 'ok'; const propias = new Set(['ATR-AAAA111', 'ATR-BBBB222']);
const reservasStub = {
  async findRow(id) { if (propias.has(id)) return 1; throw new ApiProblem(404, 'RESERVATION_NOT_FOUND', 'x', 'no existe'); },
  async cancelar(id, body, cid, p) {
    llamadas.push({ id, body, p });
    if (modo === 'negocio') throw new ApiProblem(409, 'RESERVATION_NOT_CANCELLABLE', 'x', 'check-in hecho');
    if (modo === 'caida') throw new Error('BD caída');
    return {};
  },
};
const handlers = new BusHandlers(amqp, reservasStub, db); handlers.onModuleInit();

console.log('■ Conexión');
await t('una sola conexión AMQP con dos canales y topología declarada (exchange, cola, DLX, DLQ)', async () => {
  const antes = fake.connections.length;
  await amqp.iniciar(); await sleep(100);
  eq(fake.connections.length - antes, 1, 'conexiones nuevas'); eq(reg.colas[config.amqp.queue].arguments['x-dead-letter-exchange'], config.amqp.dlx, 'la cola debe declarar el DLX'); ok(reg.colas[config.amqp.dlq], 'se declara la DLQ'); ok(amqp.stats().conectado, 'conectado');
  ok(!JSON.stringify(amqp.stats()).includes('clave'), 'las estadísticas no deben exponer credenciales'); eq(amqp.stats().host, 'broker.invalido');
});

console.log('\n■ Publicación de stock.updated');
const stock = { service_id: 'NODE_ATR_ALISSON', item_id: 'PRhu4UBTWPBC', date: '2026-11-15', time_slot: '10:00 a.m.', available_units: 15, timestamp: 1000, slot_id: 'slot-20261115-1000' };
await t('publica CloudEvents v1.0 con campos obligatorios, persistente y con confirmación', async () => {
  const a = await amqp.publicarStock(stock); ok(a.success);
  const m = await spy.get(qs, { noAck: true }); ok(m, 'no llegó el mensaje');
  const ev = JSON.parse(m.content.toString()); eq(m.fields.routingKey, 'stock.updated'); eq(m.properties.deliveryMode, 2);
  for (const k of ['specversion', 'id', 'type', 'source', 'time', 'datacontenttype', 'correlationid', 'node_id', 'data']) ok(ev[k] !== undefined, 'falta ' + k);
  eq(ev.specversion, '1.0'); eq(ev.type, 'com.booking.stock.updated'); eq(ev.source, 'NODE_ATR_ALISSON'); eq(ev.node_id, 'NODE_ATR_ALISSON'); ok(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(ev.traceparent));
  eq(ev.data.item_id, 'PRhu4UBTWPBC'); eq(ev.data.time_slot, '10:00'); eq(ev.data.new_units, 15); eq(ev.data.available_units, 15); ok(ev.data.delta === undefined, 'sin valor previo no hay delta');
  eq(m.properties.headers['x-correlation-id'], ev.correlationid);
});
await t('el segundo envío del mismo turno calcula delta; el id es determinista', async () => {
  await amqp.publicarStock({ ...stock, available_units: 14, timestamp: 2000 });
  const ev = JSON.parse((await spy.get(qs, { noAck: true })).content.toString()); eq(ev.data.delta, -1);
  await amqp.publicarStock({ ...stock, available_units: 14, timestamp: 2000 });
  const ev2 = JSON.parse((await spy.get(qs, { noAck: true })).content.toString()); eq(ev2.id, ev.id, 'mismo evento lógico, mismo id');
});
await t('sin conexión, publicar falla de forma controlada (el Outbox reintenta)', async () => {
  const otro = new AmqpService(); let e; try { await otro.publicarStock(stock); } catch (x) { e = x; }
  ok(e && /no conectado/i.test(e.message)); eq(otro.stats().publicacion_fallida, 1);
});

console.log('\n■ Consumo (ACK, deduplicación, filtrado, compensación)');
const publicar = (clave, ev) => bpub.publish('booking.events', clave, Buffer.from(JSON.stringify(ev)), { persistent: true, messageId: ev.id });
const esperar = async (f, ms = 3000) => { for (let i = 0; i < ms / 50; i++) { if (await f()) return true; await sleep(50); } return false; };
await t('saga.compensate de una reserva NUESTRA la cancela con SAGA_ORCHESTRATOR y confirma el mensaje', async () => {
  llamadas.length = 0; modo = 'ok'; const ev = evento('saga.compensate', { reservation_code: 'ATR-AAAA111' }); publicar('saga.compensate', ev);
  ok(await esperar(() => llamadas.length === 1), 'no se canceló: ' + JSON.stringify(amqp.stats())); eq(llamadas[0].id, 'ATR-AAAA111'); eq(llamadas[0].body.solicitante, 'SAGA_ORCHESTRATOR'); eq(llamadas[0].p.roles, ['PARTNER']);
  ok(await esperar(() => amqp.stats().consumidos >= 1), 'no se confirmó');
  const q = await (await fake.connect(process.env.AMQP_URL)).createChannel(); eq((await q.checkQueue(config.amqp.queue)).messageCount, 0, 'la cola debe quedar vacía');
});
await t('el mismo evento entregado dos veces se procesa una sola vez (consumidor idempotente)', async () => {
  llamadas.length = 0; const ev = evento('saga.compensate', { reservation_code: 'ATR-BBBB222' }); publicar('saga.compensate', ev); publicar('saga.compensate', ev);
  ok(await esperar(() => amqp.stats().duplicados >= 1), 'no detectó duplicado'); eq(llamadas.length, 1);
});
await t('evento de una reserva AJENA (otra tienda) se ignora sin cancelar nada', async () => {
  llamadas.length = 0; const n = amqp.stats().ignorados; publicar('saga.compensate', evento('saga.compensate', { reservation_code: 'AUT-XXXX999', order_id: 'ORD-OTRA' }));
  ok(await esperar(() => amqp.stats().ignorados > n), 'no se ignoró'); eq(llamadas.length, 0);
});
await t('payment.refunded también compensa; order.confirmed solo se registra', async () => {
  llamadas.length = 0; publicar('payment.refunded', evento('payment.refunded', { external_order_id: 'ATR-AAAA111' })); ok(await esperar(() => llamadas.length === 1));
  const n = amqp.stats().consumidos; publicar('order.confirmed', evento('order.confirmed', { reservation_code: 'ATR-AAAA111' })); ok(await esperar(() => amqp.stats().consumidos > n)); eq(llamadas.length, 1);
});
await t('una regla de negocio (409 ya hizo check-in) no se reintenta ni va a DLQ: se registra y se confirma', async () => {
  llamadas.length = 0; modo = 'negocio'; const dlq = amqp.stats().a_dlq; const n = amqp.stats().ignorados;
  publicar('saga.compensate', evento('saga.compensate', { reservation_code: 'ATR-AAAA111' }));
  ok(await esperar(() => amqp.stats().ignorados > n)); eq(llamadas.length, 1); eq(amqp.stats().a_dlq, dlq);
});
await t('un error transitorio se reintenta con espera y, al agotarse, el mensaje va a la DLQ', async () => {
  llamadas.length = 0; modo = 'caida'; const ev = evento('saga.compensate', { reservation_code: 'ATR-AAAA111' }); publicar('saga.compensate', ev);
  ok(await esperar(() => llamadas.length >= 2, 6000), 'no hubo reintento: ' + JSON.stringify({ ...amqp.stats(), llamadas: llamadas.length })); ok(await esperar(() => amqp.stats().a_dlq >= 1, 6000), 'no llegó a la DLQ');
  eq(amqp.stats().reintentados >= 1, true); ok(reg.nacks.some((n) => n.rq === false && n.all === false), 'debe rechazar SIN reencolar para que el broker lo mande a la DLQ');
  eq((await db.query("SELECT 1 FROM idempotencia WHERE idem_clave=$1 AND idem_operacion='AMQP:saga.compensate'", [ev.id])).length, 0, 'tras fallar se libera el id para poder reintentar');
});
await t('formato real de Booking: saga.compensate con data.acciones_compensatorias[] (solo se cancelan las reservas NUESTRAS, con varias tiendas en la misma orden)', async () => {
  llamadas.length = 0; modo = 'ok';
  const ev = evento('saga.compensate', { saga_id: 'SAGA-7K2X9M', codigo_compensacion: 'REF-SAGA-AB12CD', motivo: 'OUT_OF_STOCK_PARTNER', acciones_compensatorias: [
    { tipo: 'CANCELAR_ORDEN_EXTERNA', proveedor_id: 'NODE_ATR_ALISSON', external_order_id: 'ATR-AAAA111', reservation_code: 'ATR-AAAA111', monto: 110 },
    { tipo: 'CANCELAR_ORDEN_EXTERNA', proveedor_id: 'NODE_AUTOS_X', external_order_id: 'ATR-BBBB222', reservation_code: 'ATR-BBBB222', monto: 50 },
    { tipo: 'CANCELAR_ORDEN_EXTERNA', proveedor_id: 'NODE_ATR_ALISSON', external_order_id: 'AUT-9', reservation_code: 'AUT-9', monto: 10 }] });
  publicar('saga.compensate', ev); ok(await esperar(() => amqp.stats().consumidos >= 1 && llamadas.length >= 1));
  await sleep(300); eq(llamadas.map((l) => l.id), ['ATR-AAAA111'], 'solo la de nuestro proveedor y que existe aquí');
});
await t('formato real de Booking: order.confirmed con data.items[] se reconoce y no cancela nada', async () => {
  llamadas.length = 0; const n = amqp.stats().consumidos;
  publicar('order.confirmed', evento('order.confirmed', { saga_id: 'SAGA-7K2X9M', correlation_id: 'corr-1', items: [{ tipo_servicio: 'ATRACCION', external_item_id: 'PRhu4UBTWPBC', reservation_code: 'ATR-BBBB222', external_order_id: 'ORD-ATR-101', cantidad: 2, precio_unitario: 55 }, { tipo_servicio: 'AUTO', reservation_code: 'ATR-AAAA111' }] }));
  ok(await esperar(() => amqp.stats().consumidos > n)); eq(llamadas.length, 0);
  const h = await handlers.resolverReservas(evento('order.confirmed', { items: [{ tipo_servicio: 'ATRACCION', reservation_code: 'ATR-BBBB222' }, { tipo_servicio: 'AUTO', reservation_code: 'ATR-AAAA111' }] }));
  eq(h, ['ATR-BBBB222'], 'solo cuentan los items de tipo ATRACCION que existen aquí');
});
await t('un mensaje que no es CloudEvents válido va directo a la DLQ', async () => {
  const dlq = amqp.stats().a_dlq; bpub.publish('booking.events', 'order.confirmed', Buffer.from('no-json')); ok(await esperar(() => amqp.stats().a_dlq > dlq));
});

await amqp.onModuleDestroy(); await db.pool?.end?.().catch(() => {});
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} pruebas OK, ${fail} fallidas`); process.exit(fail ? 1 : 0);
