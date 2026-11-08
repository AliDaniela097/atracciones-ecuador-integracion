// Ciclo de vida común de un microservicio REST: migración (crea la base y el esquema si faltan), arranque, salud y cierre.
//   def = { nombre, esquemas, marcador (tabla que indica esquema creado), schemaPath, crearRutas(router, {db}), alIniciar?(db) }
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { crearRouter, crearServidor } from './rest.mjs';
import { crearDb, urlBase } from './pgs.mjs';
import { SERVICIOS, puertoDe } from './servicios.mjs';
import { estadoCortacircuitos } from './llamadas.mjs';
import { estadoEventos } from './eventos.mjs';

const nombreSeguro = (n) => { if (!/^[a-z0-9_]+$/.test(n)) throw new Error(`Nombre de base no permitido: ${n}`); return n; };
async function conectarCliente(cadena) { const c = new pg.Client({ connectionString: cadena, connectionTimeoutMillis: 15000 }); await c.connect(); return c; }

export async function migrar(def) {
  const dbName = nombreSeguro(SERVICIOS[def.nombre].db);
  let c;
  try { c = await conectarCliente(urlBase(dbName, def.nombre)); }
  catch (e) {
    if (e.code !== '3D000') throw e;                                   // la base no existe: se crea desde la base de administración
    const admin = await conectarCliente(process.env.MS_DB_BASE_URL);
    try { await admin.query(`CREATE DATABASE "${dbName}"`); console.log(`  base creada: ${dbName}`); }
    catch (e2) { if (e2.code !== '42P04') throw e2; } finally { await admin.end(); }
    c = await conectarCliente(urlBase(dbName, def.nombre));
  }
  try {
    const ya = (await c.query('SELECT to_regclass($1) AS t', [`public.${def.marcador}`])).rows[0].t;
    if (ya) return false;
    // Un solo bloque transaccional con candado de transacción (funciona también con el pooler de Neon): dos procesos no crean el esquema a la vez.
    try {
      await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(7770013)');
      const otra = (await c.query('SELECT to_regclass($1) AS t', [`public.${def.marcador}`])).rows[0].t;
      if (otra) { await c.query('COMMIT'); return false; }
      await c.query(readFileSync(def.schemaPath, 'utf8')); await c.query('COMMIT');
      console.log(`  ok ${dbName}: esquema creado`); return true;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  } finally { await c.end(); }
}

export async function iniciar(def, { host = process.env.MS_BIND ?? '127.0.0.1', puerto } = {}) {
  if (def.iniciarPropio) return def.iniciarPropio({ host, puerto: puerto ?? puertoDe(def.nombre) });     // gRPC (pricing) y SOAP (invoicing)
  const db = crearDb(SERVICIOS[def.nombre].db, def.nombre);
  const router = crearRouter();
  def.crearRutas(router, { db });
  const t0 = Date.now();
  const salud = async () => {
    let dbOk = false; let msg;
    try { await Promise.race([db.q('SELECT 1'), new Promise((_, r) => setTimeout(() => r(new Error('timeout BD')), 2500))]); dbOk = true; } catch (e) { msg = e.message; }
    return { status: dbOk ? 'UP' : 'DOWN', service: `ms_${def.nombre}`, protocol: 'REST', uptime_s: Math.round((Date.now() - t0) / 1000), database: dbOk ? 'UP' : `DOWN (${msg})`, ...server.stats(), breakers: estadoCortacircuitos(), events: estadoEventos() };
  };
  const server = crearServidor({ nombre: def.nombre, router, esquemas: def.esquemas ?? {}, db, salud });
  if (def.alIniciar) await def.alIniciar(db);
  const p = puerto ?? puertoDe(def.nombre);
  await new Promise((res, rej) => { server.once('error', rej); server.listen(p, host, res); });
  const cerrar = () => new Promise((res) => { server.close(async () => { await db.cerrar(); res(); }); server.closeIdleConnections?.(); setTimeout(() => { server.closeAllConnections?.(); }, 2500).unref(); });
  console.log(JSON.stringify({ level: 'info', msg: `ms_${def.nombre} iniciado`, puerto: p, host }));
  return { server, db, cerrar, puerto: p, salud };
}

// Para ejecutar un microservicio como proceso propio: node ms_x/src/server.mjs
export async function ejecutarComoProceso(def) {
  if (process.env.MS_AUTO_MIGRATE !== 'false') await migrar(def);
  const s = await iniciar(def);
  const salir = () => { s.cerrar().then(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); };
  process.on('SIGINT', salir); process.on('SIGTERM', salir);
  process.on('unhandledRejection', (e) => console.error(JSON.stringify({ level: 'error', msg: 'unhandledRejection: ' + (e?.stack ?? e) })));
  return s;
}
