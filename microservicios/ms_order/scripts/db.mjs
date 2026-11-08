// Migraciones de ESTE microservicio (su propia base de datos).
//   node scripts/db.mjs migrate   -> crea la base si no existe y aplica db/schema.sql (si las tablas aún no existen)
//   node scripts/db.mjs reset     -> BORRA todo el esquema public y lo vuelve a crear (en bases remotas exige CONFIRMAR_RESET=1)
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MARCADOR = 'orden';          // tabla que indica que el esquema ya fue creado
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(raiz, '.env'), quiet: true });
const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ Falta DATABASE_URL en el .env de este microservicio (copie .env.example a .env).'); process.exit(1); }
const u = new URL(url); const dbName = decodeURIComponent(u.pathname.slice(1));
const esLocal = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);

async function conectar(database) {
  let cadena = url;
  if (database) { const x = new URL(url); x.pathname = '/' + database; cadena = x.toString(); }   // (pg ignora "database" si hay connectionString)
  const c = new pg.Client({ connectionString: cadena });
  await c.connect(); return c;
}
async function asegurarBase() {
  try { return await conectar(); }
  catch (e) {
    if (e.code !== '3D000') throw e;                                   // 3D000 = la base no existe
    if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`Nombre de base no permitido: ${dbName}`);
    const motivos = [];
    for (const admin of ['neondb', 'postgres']) {
      try { const a = await conectar(admin); await a.query(`CREATE DATABASE "${dbName}"`); await a.end(); console.log(`  base creada: ${dbName}`); return await conectar(); }
      catch (err) { motivos.push(`${admin}: ${err.message}`); }
    }
    console.error(`❌ La base "${dbName}" no existe y no pude crearla (${motivos.join(' | ')}). Créela a mano (en Neon: Branch → Databases → New database) y repita.`); process.exit(1);
  }
}
async function migrar(c) {
  const ya = (await c.query('SELECT to_regclass($1) AS t', [`public.${MARCADOR}`])).rows[0].t;
  if (ya) { console.log(`  ${dbName}: el esquema ya existe (nada que hacer)`); return; }
  await c.query('BEGIN');
  try { await c.query(readFileSync(path.join(raiz, 'db/schema.sql'), 'utf8')); await c.query('COMMIT'); console.log(`  ok ${dbName}: esquema creado`); }
  catch (e) { await c.query('ROLLBACK'); throw e; }
}

const cmd = process.argv[2];
if (!['migrate', 'reset'].includes(cmd)) { console.error('Uso: node scripts/db.mjs migrate|reset'); process.exit(1); }
const c = await asegurarBase();
try {
  if (cmd === 'reset') {
    if (!esLocal && process.env.CONFIRMAR_RESET !== '1') { console.error('❌ reset borra TODO en una base remota. Si está segura: CONFIRMAR_RESET=1 npm run db:reset'); process.exit(1); }
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }
  await migrar(c);
} catch (e) { console.error('❌', e.message); process.exitCode = 1; }
finally { await c.end(); }
