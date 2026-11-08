// Llama a cualquier método de un microservicio desde la terminal (útil para la demo y para depurar).
//   node scripts/cliente.mjs inventory ListHorarios '{"atr_id":1001}'
//   node scripts/cliente.mjs order CreateOrder '{"usu_id":1,"items":[{"atr_id":1001,"det_descripcion":"Tour","det_cantidad":2,"det_precio_unitario":25}]}'
//   node scripts/cliente.mjs booking ListReservations '{"page":1,"limit":5}'
//   En PowerShell, si las comillas dan problemas, guarde el JSON en un archivo y use @:   node scripts/cliente.mjs inventory CreateHorario @horario.json
// Puertos por defecto: inventory 50061 · order 50062 · booking 50063 (cambie con GRPC_HOST=localhost)
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONF = { inventory: ['ms_inventory', 'ms_inventory.v1', 'InventoryService', 50061], order: ['ms_order', 'ms_order.v1', 'OrderService', 50062], booking: ['ms_booking', 'ms_booking.v1', 'BookingService', 50063] };
const [corto, metodo, json = '{}'] = process.argv.slice(2);
if (!CONF[corto] || !metodo) { console.error("Uso: node scripts/cliente.mjs <inventory|order|booking> <Metodo> '<json>'"); process.exit(1); }
const [ms, paquete, servicio, puerto] = CONF[corto];
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const def = protoLoader.loadSync(path.join(raiz, ms, 'proto', `${ms}.proto`), { keepCase: true, longs: Number, defaults: true, arrays: true });
const C = paquete.split('.').reduce((o, k) => o[k], grpc.loadPackageDefinition(def))[servicio];
const c = new C(`${process.env.GRPC_HOST ?? 'localhost'}:${process.env.GRPC_PORT ?? puerto}`, grpc.credentials.createInsecure());
if (typeof c[metodo] !== 'function') { console.error(`El método ${metodo} no existe. Disponibles: ${Object.keys(C.service).join(', ')}`); process.exit(1); }
const cuerpo = json.startsWith('@') ? readFileSync(json.slice(1), 'utf8') : json;
c[metodo](JSON.parse(cuerpo), { deadline: Date.now() + 8000 }, (e, r) => {
  if (e) { let d; try { d = JSON.parse(e.details); } catch { d = e.details; } console.error('ERROR', grpc.status[e.code], JSON.stringify(d, null, 2)); process.exit(1); }
  console.log(JSON.stringify(r, null, 2)); process.exit(0);
});
