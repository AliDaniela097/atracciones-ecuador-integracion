// Ejecuta ms_catalog como proceso propio:  npm start   (puerto MS_CATALOG_PORT)
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(raiz, '..', '.env.ms'), quiet: true });
dotenv.config({ path: path.join(raiz, '.env'), quiet: true });
const { ejecutarComoProceso } = await import('../../_shared/servicio.mjs');
const def = (await import('./definicion.mjs')).default;
await ejecutarComoProceso(def);
