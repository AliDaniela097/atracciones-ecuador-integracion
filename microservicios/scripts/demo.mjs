// Demostración en vivo del flujo de compra con los 3 microservicios YA ARRANCADOS (npm run start:all).   npm run demo
// No borra nada: crea un turno nuevo cada vez y muestra: compra feliz, falta de cupo (OUT_OF_STOCK) y compensación de la Saga.
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H = process.env.GRPC_HOST ?? 'localhost';
const P = { inventory: Number(process.env.PORT_INVENTORY ?? 50061), order: Number(process.env.PORT_ORDER ?? 50062), booking: Number(process.env.PORT_BOOKING ?? 50063) };
function cliente(ms, paquete, servicio, port) {
  const def = protoLoader.loadSync(path.join(raiz, ms, 'proto', `${ms}.proto`), { keepCase: true, longs: Number, defaults: true, arrays: true });
  const C = paquete.split('.').reduce((o, k) => o[k], grpc.loadPackageDefinition(def))[servicio];
  const c = new C(`${H}:${port}`, grpc.credentials.createInsecure());
  return new Proxy({}, { get: (_, m) => (req = {}) => new Promise((res, rej) => c[m](req, { deadline: Date.now() + 10000 }, (e, r) => {
    if (!e) return res(r);
    let b = {}; try { b = JSON.parse(e.details); } catch { b = { message: e.details || e.message }; }
    rej(Object.assign(new Error(`${b.code ?? e.code}: ${b.message}`), { code: b.code }));
  })) });
}
const inv = cliente('ms_inventory', 'ms_inventory.v1', 'InventoryService', P.inventory);
const ord = cliente('ms_order', 'ms_order.v1', 'OrderService', P.order);
const bok = cliente('ms_booking', 'ms_booking.v1', 'BookingService', P.booking);

const ATR = Number(process.env.DEMO_ATR ?? 9001);
const fecha = new Date(Date.now() + (30 + Math.floor(Math.random() * 300)) * 86400000).toISOString().slice(0, 10);
const titulo = (t) => console.log(`\n━━ ${t} ${'━'.repeat(Math.max(2, 70 - t.length))}`);
const ok = (t) => console.log(`  ✔ ${t}`); const no = (t) => console.log(`  ✖ ${t}`);

async function comprar(dis, { adultos, titular = true }) {
  const r = await inv.ReserveSlots({ dis_id: dis, cantidad: adultos });
  if (!r.success) { no(`1) ms_inventory.ReserveSlots → ${r.error_code}: ${r.message}`); return { ok: false }; }
  ok(`1) ms_inventory.ReserveSlots → cupo reservado (quedan ${r.availability.cupos_disponibles})`);
  const orden = await ord.CreateOrder({ usu_id: 1, items: [{ atr_id: ATR, det_descripcion: 'Tour demo', det_cantidad: adultos, det_precio_unitario: 25 }] });
  ok(`2) ms_order.CreateOrder → ${orden.ord_numero} · total $${orden.ord_total} · ${orden.est_codigo}`);
  try {
    const pas = Array.from({ length: adultos }, (_, i) => ({ pax_nombre: i === 0 ? 'Ana Pérez' : `Acompañante ${i}`, pax_documento: i === 0 ? '1712345678' : undefined, pax_es_titular: titular && i === 0 }));
    const res = await bok.CreateReservation({ det_id: orden.detalles[0].det_id, dis_id: dis, res_adultos: adultos, res_precio_unitario: 25, pasajeros: pas });
    ok(`3) ms_booking.CreateReservation → ${res.res_codigo} · ${res.est_codigo}`);
    await ord.UpdateOrderStatus({ ord_id: orden.ord_id, est_codigo: 'PAGADA' }); const conf = await bok.ConfirmReservation({ res_uuid: res.res_uuid });
    ok(`4) pago simulado → orden PAGADA · reserva ${conf.est_codigo}`); return { ok: true };
  } catch (e) {
    no(`3) ms_booking.CreateReservation falló → ${e.message}`);
    await ord.UpdateOrderStatus({ ord_id: orden.ord_id, est_codigo: 'CANCELADA' }); ok('   COMPENSACIÓN: orden CANCELADA');
    const l = await inv.ReleaseSlots({ dis_id: dis, cantidad: adultos }); ok(`   COMPENSACIÓN: cupo devuelto (quedan ${l.availability.cupos_disponibles})`); return { ok: false, compensado: true };
  }
}

try {
  titulo(`Preparación: atracción ${ATR}, turno 09:00 del ${fecha} (4 cupos)`);
  try { await inv.CreateHorario({ atr_id: ATR, hor_hora: '09:00', hor_cupo: 4 }); } catch (e) { if (e.code !== 'HORARIO_DUPLICATE') throw e; }
  await inv.GenerateAvailability({ atr_id: ATR, fecha_desde: fecha, fecha_hasta: fecha });
  const dis = (await inv.ListAvailability({ atr_id: ATR, fecha_desde: fecha, fecha_hasta: fecha })).data[0];
  ok(`ms_inventory: dis_id=${dis.dis_id} · ${dis.slot_id} · ${dis.cupos_disponibles} cupos libres`);

  titulo('A) Compra feliz de 2 cupos');
  await comprar(dis.dis_id, { adultos: 2 });
  const libres = async () => (await inv.GetAvailability({ dis_id: dis.dis_id })).cupos_disponibles;
  const quedan = await libres();
  titulo(`B) Piden ${quedan + 1} cupos y solo quedan ${quedan} → OUT_OF_STOCK (no se crea orden ni reserva)`);
  await comprar(dis.dis_id, { adultos: quedan + 1 });
  titulo('C) Falla la reserva (no hay titular) → la Saga COMPENSA y devuelve el cupo');
  await comprar(dis.dis_id, { adultos: 1, titular: false });
  titulo('Estado final');
  const fin = await inv.GetAvailability({ dis_id: dis.dis_id }); ok(`Cupos libres del turno: ${fin.cupos_disponibles} de ${fin.dis_cupo_total}`);
  await new Promise((r) => setTimeout(r, 800));
  const s = await inv.GetSyncStatus({}); ok(`Envío a Booking (${s.target}): ${s.sent_ok} OK · ${s.sent_failed} fallidos · último error: ${s.last_error || 'ninguno'}`);
  console.log('');
} catch (e) { console.error(`\n❌ ${e.message}\n   ¿Están corriendo los 3 microservicios (npm run start:all) y existen las tablas (npm run db:migrate)?`); process.exit(1); }
process.exit(0);
