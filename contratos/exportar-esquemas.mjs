// Exporta a un archivo versionado (schemas/requests.json) los esquemas que los microservicios REST/SOAP/gRPC "code-first" tienen declarados dentro de su código (src/definicion.mjs).
// Así TODO microservicio tiene su contrato como artefacto propio (Semana 7) y el verificador (check-compat.mjs) puede vigilarlo.
// Los 4 servicios schema-first (ms_booking, ms_inventory, ms_order, ms_pricing) tienen el archivo escrito a mano y NO se tocan.
//   node contratos/exportar-esquemas.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'microservicios');
let escritos = 0, omitidos = 0;
for (const d of fs.readdirSync(raiz, { withFileTypes: true })) {
  if (!d.isDirectory() || !d.name.startsWith('ms_')) continue;
  const def = path.join(raiz, d.name, 'src/definicion.mjs');
  if (!fs.existsSync(def)) { omitidos++; continue; }
  const destino = path.join(raiz, d.name, 'schemas/requests.json');
  if (fs.existsSync(destino) && !JSON.parse(fs.readFileSync(destino, 'utf8'))['x-generado']) { console.log(`  = ${d.name}: contrato escrito a mano (schema-first); no se toca`); omitidos++; continue; }
  const ds = (await import(pathToFileURL(def).href)).default;
  const doc = { $schema: 'https://json-schema.org/draft/2020-12/schema', title: `${d.name} — esquemas de petición`, version: '1.0.0',
    'x-generado': 'GENERADO desde src/definicion.mjs con contratos/exportar-esquemas.mjs (code-first). No editar a mano: cambie el código y vuelva a exportar.', $defs: ds.esquemas ?? {} };
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const nuevo = JSON.stringify(doc, null, 2) + '\n';
  if (!fs.existsSync(destino) || fs.readFileSync(destino, 'utf8') !== nuevo) { fs.writeFileSync(destino, nuevo); escritos++; console.log(`  ✔ ${d.name}: ${Object.keys(doc.$defs).length} esquemas exportados`); }
  else console.log(`  · ${d.name}: sin cambios`);
}
console.log(`\n${escritos} archivos escritos, ${omitidos} omitidos.`); process.exit(0);
