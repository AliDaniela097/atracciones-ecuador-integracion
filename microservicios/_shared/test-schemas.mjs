// Pruebas de esquemas de ESTE microservicio (semana 7). Se ejecutan ANTES de integrar:   npm run test:schemas
//  1) Cada caso VÁLIDO de schemas/casos.json pasa AJV y cada caso INVÁLIDO falla (hay al menos uno de cada tipo por esquema).
//  2) Los campos del JSON Schema coinciden EXACTAMENTE con los campos del mensaje del .proto (detecta desincronización contrato <-> esquema).
//  3) Cada petición del .proto se serializa y deserializa (ida y vuelta) sin perder datos.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { crearValidador } from '../src/lib/validate.mjs';

const MS = '__MS__';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v = crearValidador(path.join(raiz, 'schemas/requests.json'));
const casos = JSON.parse(readFileSync(path.join(raiz, 'schemas/casos.json'), 'utf8'));
const def = protoLoader.loadSync(path.join(raiz, `proto/${MS}.proto`), { keepCase: true, longs: Number, defaults: false, arrays: true, oneofs: false });
void grpc;

const fallos = []; let n = { validos: 0, invalidos: 0, campos: 0, rpcs: 0 };
const nombres = Object.keys(v.doc.$defs);

// 1) casos válidos / inválidos
for (const nombre of nombres) {
  const c = casos[nombre];
  if (!c?.validos?.length || !c?.invalidos?.length) { fallos.push(`${nombre}: faltan casos (se exige ≥1 válido y ≥1 inválido en schemas/casos.json)`); continue; }
  c.validos.forEach((d, i) => { n.validos++; const e = v.errores(nombre, d); if (e.length) fallos.push(`${nombre}: el caso válido #${i + 1} fue rechazado → ${e[0].name}: ${e[0].reason}`); });
  c.invalidos.forEach((x) => { n.invalidos++; if (!v.errores(nombre, x.datos).length) fallos.push(`${nombre}: el caso inválido "${x.descripcion}" fue ACEPTADO`); });
}
for (const k of Object.keys(casos)) if (!v.doc.$defs[k]) fallos.push(`casos.json menciona un esquema inexistente: ${k}`);

// 2) esquema <-> proto: mismos campos
const servicio = Object.entries(def).find(([, d]) => Object.values(d).some((m) => typeof m?.requestSerialize === 'function'));
const paquete = servicio[0].split('.').slice(0, -1).join('.');
for (const nombre of nombres) {
  const msg = def[`${paquete}.${nombre}`];
  if (!msg) { fallos.push(`${nombre}: no existe un mensaje con ese nombre en el .proto`); continue; }
  const delProto = (msg.type.field ?? []).map((f) => f.name).sort();
  const delEsquema = Object.keys(v.doc.$defs[nombre].properties ?? {}).sort();
  n.campos++;
  if (JSON.stringify(delProto) !== JSON.stringify(delEsquema)) fallos.push(`${nombre}: campos distintos. proto=[${delProto}] esquema=[${delEsquema}]`);
}

// 3) cada rpc: su petición tiene esquema y sobrevive a la ida y vuelta
// Compara el contenido sin importar el orden de las claves ni los arreglos vacíos que agrega el cargador.
const ordenar = (x) => (Array.isArray(x) ? (x.length ? x.map(ordenar) : undefined) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, ordenar(x[k])])) : x);
const limpio = (o) => JSON.stringify(ordenar(o));
for (const [rpc, m] of Object.entries(servicio[1])) {
  n.rpcs++;
  const req = m.requestType.type.name;
  if (!v.doc.$defs[req]) { fallos.push(`rpc ${rpc}: la petición ${req} no tiene JSON Schema`); continue; }
  for (const ej of casos[req]?.validos ?? []) {
    const vuelta = m.requestDeserialize(m.requestSerialize(ej));
    if (limpio(vuelta) !== limpio(ej)) fallos.push(`rpc ${rpc}: la ida y vuelta cambió los datos → ${limpio(ej)} ≠ ${limpio(vuelta)}`);
  }
}

console.log(`${MS}: ${nombres.length} esquemas · ${n.validos} casos válidos · ${n.invalidos} inválidos · ${n.campos} mensajes comparados con el .proto · ${n.rpcs} rpc con ida y vuelta`);
if (fallos.length) { console.error(`\n❌ ${fallos.length} fallo(s):`); fallos.forEach((f) => console.error(' - ' + f)); process.exit(1); }
console.log('✅ Todos los esquemas cumplen.');
