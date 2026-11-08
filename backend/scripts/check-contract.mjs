// Verifica el contrato: el YAML carga (sin claves duplicadas), todos los $ref resuelven y los ejemplos cumplen sus esquemas.
//   npm run check:contract
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { load } from 'js-yaml';

const file = process.argv[2] ?? 'contracts/atracciones-openapi-v3.yaml';
let doc;
try { doc = load(readFileSync(file, 'utf8')); } catch (e) { console.error('❌ El YAML no carga:', e.message.split('\n')[0]); process.exit(1); }
const refs = new Set(); JSON.stringify(doc, (k, v) => { if (k === '$ref') refs.add(v); return v; });
const resolve = (r) => r.replace('#/', '').split('/').reduce((o, k) => o?.[k], doc);
const broken = [...refs].filter((r) => resolve(r) === undefined);
const ajv = new Ajv({ strict: false, allErrors: true }); (addFormats.default ?? addFormats)(ajv);
ajv.addSchema({ $id: 'oas', components: doc.components }, 'oas');
let bad = 0, checked = 0;
for (const [name, schema] of Object.entries(doc.components.schemas)) {
  try { ajv.compile({ $ref: `oas#/components/schemas/${name}` }); } catch (e) { console.error(`❌ ${name}: ${e.message}`); bad++; }
  if (schema.example !== undefined) { checked++; if (!ajv.validate({ $ref: `oas#/components/schemas/${name}` }, schema.example)) { console.error(`❌ ejemplo de ${name} inválido`, ajv.errors?.[0]); bad++; } }
}
console.log(`OpenAPI ${doc.openapi} · v${doc.info.version} · ${Object.keys(doc.paths).length} rutas · ${Object.keys(doc.components.schemas).length} esquemas · ${refs.size} $ref (${broken.length} rotos) · ${checked} ejemplos de esquema verificados`);
if (broken.length) console.error('❌ $ref rotos:', broken);
process.exit(broken.length || bad ? 1 : 0);
