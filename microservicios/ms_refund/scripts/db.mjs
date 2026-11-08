// Crea la base de datos de este microservicio (si no existe) y aplica db/schema.sql (si las tablas aún no existen).
//   node scripts/db.mjs migrate        (necesita MS_DB_BASE_URL en el entorno o en ../.env)
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(raiz, '..', '.env.ms'), quiet: true });
dotenv.config({ path: path.join(raiz, '.env'), quiet: true });
const { migrar } = await import('../../_shared/servicio.mjs');
const def = (await import('../src/definicion.mjs')).default;
try { const creado = await migrar(def); if (!creado) console.log('  ms_refund: el esquema ya existe (nada que hacer)'); }
catch (e) { console.error('❌', e.message); process.exitCode = 1; }
