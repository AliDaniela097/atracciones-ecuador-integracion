// Verificador de compatibilidad de contratos (Semana 7, 7.5): compara los contratos ACTUALES contra la copia de referencia (baseline/) = la última versión publicada.
//   node contratos/check-compat.mjs            → sale con código 1 si algún cambio ROMPE la compatibilidad hacia atrás (úsalo en CI / antes de desplegar)
//   node contratos/check-compat.mjs --update   → acepta los contratos actuales como nueva referencia (solo tras revisar; un cambio incompatible exige MAJOR)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { compararDocumento, compararProto, compararEsquema } from './compat.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url)); const raiz = path.resolve(aqui, '..');
const base = path.join(aqui, 'baseline');
const actualizar = process.argv.includes('--update');
const ms = fs.readdirSync(path.join(raiz, 'microservicios'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('ms_')).map((d) => d.name);

/** Contratos vigilados: [nombre en baseline, ruta real, tipo] */
const contratos = [];
for (const m of ms) {
  const dir = path.join(raiz, 'microservicios', m);
  if (fs.existsSync(path.join(dir, 'schemas/requests.json'))) contratos.push([`${m}.requests.json`, path.join(dir, 'schemas/requests.json'), 'jsonschema']);
  if (fs.existsSync(path.join(dir, 'proto'))) for (const f of fs.readdirSync(path.join(dir, 'proto'))) if (f.endsWith('.proto')) contratos.push([`${m}.${f}`, path.join(dir, 'proto', f), 'proto']);
}
contratos.push(['backend.inventory.proto', path.join(raiz, 'backend/contracts/proto/inventory.proto'), 'proto']);
contratos.push(['backend.atracciones-openapi-v3.yaml', path.join(raiz, 'backend/contracts/atracciones-openapi-v3.yaml'), 'openapi']);

const yaml = () => createRequire(path.join(raiz, 'backend/package.json'))('js-yaml');
function openapi(viejoTxt, nuevoTxt, et) {
  const { load } = yaml(); const v = load(viejoTxt), n = load(nuevoTxt); const out = { problemas: [], advertencias: [] };
  for (const [ruta, ops] of Object.entries(v.paths ?? {})) for (const metodo of Object.keys(ops)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(metodo)) continue;
    if (!n.paths?.[ruta]?.[metodo]) out.problemas.push(`${et}: operación eliminada ${metodo.toUpperCase()} ${ruta}`);
  }
  for (const [nombre, esq] of Object.entries(v.components?.schemas ?? {})) {
    if (!n.components?.schemas?.[nombre]) { out.problemas.push(`${et}#${nombre}: esquema eliminado`); continue; }
    compararEsquema(esq, n.components.schemas[nombre], `${et}#${nombre}`, out);
  }
  return out;
}

if (actualizar) {
  fs.mkdirSync(base, { recursive: true });
  for (const [n, ruta] of contratos) fs.copyFileSync(ruta, path.join(base, n));
  console.log(`Referencia actualizada: ${contratos.length} contratos copiados a contratos/baseline/.`); process.exit(0);
}

let rotos = 0, avisos = 0, revisados = 0;
for (const [n, ruta, tipo] of contratos) {
  const ref = path.join(base, n);
  if (!fs.existsSync(ref)) { console.log(`  ⚠ ${n}: sin referencia (contrato nuevo). Ejecute con --update para registrarlo.`); avisos++; continue; }
  const v = fs.readFileSync(ref, 'utf8'), a = fs.readFileSync(ruta, 'utf8'); revisados++;
  const r = tipo === 'jsonschema' ? compararDocumento(JSON.parse(v), JSON.parse(a), n) : tipo === 'proto' ? compararProto(v, a, n) : openapi(v, a, n);
  if (r.problemas.length) { rotos += r.problemas.length; console.log(`  ✘ ${n}`); r.problemas.forEach((p) => console.log(`      ROMPE: ${p}`)); }
  else console.log(`  ✔ ${n}${v === a ? '' : ' (cambió, pero es compatible hacia atrás)'}`);
  r.advertencias.forEach((w) => { avisos++; console.log(`      aviso: ${w}`); });
}
for (const f of fs.readdirSync(base)) if (!contratos.some(([n]) => n === f)) { console.log(`  ✘ ${f}: el contrato existía en la referencia y ya no existe`); rotos++; }
console.log(`\n${revisados} contratos comparados · ${rotos} cambios que ROMPEN la compatibilidad · ${avisos} avisos`);
if (rotos) console.log('Si el cambio es deliberado: súbale la versión MAJOR (SemVer), avise a los consumidores y ejecute --update.');
process.exit(rotos ? 1 : 0);
