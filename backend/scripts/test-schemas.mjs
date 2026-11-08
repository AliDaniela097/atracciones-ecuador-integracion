// Pruebas de esquemas del contrato (semana 7): se ejecutan ANTES de integrar con Booking.
//   npm run test:schemas
// 1) Cada ejemplo (request, response, componente) del YAML se valida con AJV contra su propio JSON Schema.
// 2) Cada mensaje del .proto se serializa y deserializa (ida y vuelta) para confirmar que los campos y tipos son los del contrato.
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { load } from 'js-yaml';
import * as protoLoader from '@grpc/proto-loader';

const doc = load(readFileSync('contracts/atracciones-openapi-v3.yaml', 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
(addFormats.default ?? addFormats)(ajv);
ajv.addSchema({ $id: 'oas', components: doc.components }, 'oas');
const fix = (s) => JSON.parse(JSON.stringify(s).replaceAll('"$ref":"#/', '"$ref":"oas#/'));

let total = 0; const fails = [];
function probar(donde, schema, valor) {
  total++;
  const v = ajv.compile(fix(schema));
  if (!v(valor)) fails.push({ donde, error: ajv.errorsText(v.errors, { separator: ' | ' }).slice(0, 300) });
}
function recorrer(n, ruta) {
  if (!n || typeof n !== 'object') return;
  if (n.schema && n.example !== undefined) probar(`${ruta} (example)`, n.schema, n.example);
  if (n.schema && n.examples && typeof n.examples === 'object')
    for (const [k, e] of Object.entries(n.examples)) if (e?.value !== undefined) probar(`${ruta} (examples.${k})`, n.schema, e.value);
  for (const [k, v] of Object.entries(n)) recorrer(v, `${ruta}/${k}`);
}
recorrer(doc.paths, 'paths');
for (const [name, s] of Object.entries(doc.components.schemas)) if (s.example !== undefined) probar(`components/schemas/${name} (example)`, { $ref: `#/components/schemas/${name}` }, s.example);

// --- gRPC: ida y vuelta de cada mensaje con los valores de ejemplo ---
const def = protoLoader.loadSync('contracts/proto/inventory.proto', { keepCase: true, longs: Number, enums: String, defaults: true });
const svc = def['inventory.InventoryStockService'];
const muestras = {
  PushStockUpdate: [{ service_id: 'atracciones', item_id: 'PRhu4UBTWPBC', date: '2026-11-01', time_slot: '09:00', available_units: 12, timestamp: 1790000000000, slot_id: 'slot-20261101-0900' },
                    { success: true, message: 'OK', processed_at: 1790000000001, error_code: '', current_available: 12 }],
  GetSlotAvailability: [{ service_id: 'atracciones', item_id: 'PRhu4UBTWPBC', date: '2026-11-01', time_slot: '09:00', slot_id: 'slot-20261101-0900' },
                        { item_id: 'PRhu4UBTWPBC', slot_id: 'slot-20261101-0900', date: '2026-11-01', time_slot: '09:00', available_units: 12, status: 'AVAILABLE', last_updated_epoch: 1790000000000 }],
  StreamInventoryChanges: [{ event_id: 'e1', service_id: 'atracciones', item_id: 'PRhu4UBTWPBC', date: '2026-11-01', time_slot: '09:00', delta: -2, timestamp: 1790000000000, slot_id: 'slot-20261101-0900' },
                           { total_events_processed: 1, is_synchronized: true, last_sync_hash: 'abc' }],
};
let protoOk = 0;
for (const [rpc, [req, res]] of Object.entries(muestras)) {
  const m = svc[rpc]; if (!m) { fails.push({ donde: `proto ${rpc}`, error: 'el rpc no existe en el .proto' }); continue; }
  const a = m.requestDeserialize(m.requestSerialize(req)); const b = m.responseDeserialize(m.responseSerialize(res));
  for (const [x, y, n] of [[req, a, 'request'], [res, b, 'response']]) {
    const dif = Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
    if (dif.length) fails.push({ donde: `proto ${rpc} ${n}`, error: `campos que no sobreviven la ida y vuelta: ${dif.join(', ')}` }); else protoOk++;
  }
}
console.log(`OpenAPI ${doc.openapi} v${doc.info.version}: ${total} ejemplos validados con AJV · gRPC: ${protoOk}/6 mensajes de ida y vuelta OK`);
if (fails.length) { console.error(`\n❌ ${fails.length} fallo(s):`); fails.forEach((f) => console.error(` - ${f.donde}\n     ${f.error}`)); process.exit(1); }
console.log('✅ Todos los esquemas cumplen.');
