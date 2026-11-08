// Booking simulado: servidor gRPC (puerto 50051) + receptor REST. Sirve para probar la integración SIN el Booking real.
//   node scripts/booking-mock.mjs            → gRPC en :50051
// Reproduce las reglas del .proto: timestamp monotónico (STALE_TIMESTAMP_IGNORED), ITEM_NOT_FOUND, INVALID_SLOT.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLOT = /^slot-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/;

export async function startMock({ port = 50051, knownItems = null } = {}) {
  const def = protoLoader.loadSync(path.join(root, 'contracts/proto/inventory.proto'), { keepCase: true, longs: Number, enums: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(def);
  // OJO: slot_id ("slot-YYYYMMDD-HHMM") NO es único entre atracciones; la clave real es item_id + slot_id.
  const slots = new Map();      // `${item_id}|${slot_id}` → { available, ts, item_id, date, time_slot }
  const K = (m) => `${m.item_id}|${m.slot_id}`;
  const log = [];               // todo lo recibido, para aserciones
  const known = (id) => !knownItems || knownItems.has(id);

  const server = new grpc.Server();
  server.addService(pkg.inventory.InventoryStockService.service, {
    PushStockUpdate(call, cb) {
      const m = call.request; log.push({ rpc: 'Push', ...m, meta: { service_id: call.metadata.get('service_id')[0], api_key: call.metadata.get('x-api-key')[0] } });
      if (!known(m.item_id)) return cb(null, { success: false, message: 'Atracción no existe', processed_at: Date.now(), error_code: 'ITEM_NOT_FOUND', current_available: 0 });
      const sm = SLOT.exec(m.slot_id);
      if (!sm || `${sm[1]}-${sm[2]}-${sm[3]}` !== m.date) return cb(null, { success: false, message: 'slot inválido', processed_at: Date.now(), error_code: 'INVALID_SLOT', current_available: 0 });
      const cur = slots.get(K(m));
      if (cur && m.timestamp < cur.ts) return cb(null, { success: false, message: 'Timestamp obsoleto', processed_at: Date.now(), error_code: 'STALE_TIMESTAMP_IGNORED', current_available: cur.available });
      slots.set(K(m), { available: m.available_units, ts: m.timestamp, item_id: m.item_id, date: m.date, time_slot: m.time_slot });
      cb(null, { success: true, message: 'OK', processed_at: Date.now(), error_code: 'OK', current_available: m.available_units });
    },
    StreamInventoryChanges(call, cb) {
      let n = 0; const seen = new Set();
      call.on('data', (ev) => {
        log.push({ rpc: 'Stream', ...ev });
        if (seen.has(ev.event_id)) return; seen.add(ev.event_id);          // deduplicación idempotente por event_id
        const cur = slots.get(K(ev)) ?? { available: 0, ts: 0, item_id: ev.item_id, date: ev.date, time_slot: ev.time_slot };
        if (ev.timestamp >= cur.ts) { cur.available += ev.delta; cur.ts = ev.timestamp; slots.set(K(ev), cur); }
        n++;
      });
      call.on('end', () => cb(null, { total_events_processed: n, is_synchronized: true, last_sync_hash: 'mock-' + n }));
      call.on('error', () => {});
    },
    GetSlotAvailability(call, cb) {
      const r = call.request; log.push({ rpc: 'Get', ...r });
      const s = slots.get(K(r));
      if (!s) return cb(null, { item_id: r.item_id, slot_id: '', date: r.date, time_slot: r.time_slot, available_units: 0, status: '', last_updated_epoch: 0 });
      cb(null, { item_id: r.item_id, slot_id: r.slot_id, date: s.date, time_slot: s.time_slot, available_units: s.available,
        status: s.available <= 0 ? 'AGOTADO' : s.available <= 5 ? 'ULTIMOS_CUPOS' : 'DISPONIBLE', last_updated_epoch: s.ts });
    },
  });
  await new Promise((res, rej) => server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (e) => (e ? rej(e) : res())));
  return { slots, log, stop: () => new Promise((r) => server.tryShutdown(() => r())), port };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_GRPC_PORT ?? 50051);
  const m = await startMock({ port });
  console.log(`Booking simulado escuchando gRPC en :${port}. Ctrl+C para salir.`);
  setInterval(() => { if (m.log.length) { console.log(`[${new Date().toISOString()}] recibidos=${m.log.length} slots=${m.slots.size}`); } }, 10_000).unref();
}
