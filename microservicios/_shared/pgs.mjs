// Acceso a PostgreSQL por microservicio: UNA base por servicio (database-per-service), cada una con su pool pequeño.
// La URL se deriva de MS_DB_BASE_URL (cualquier base del mismo servidor Neon) cambiando solo el nombre de la base,
// o de MS_<NOMBRE>_DATABASE_URL si se quiere una base en otro lugar.
import pg from 'pg';
import { Pool as NeonPool, neonConfig, types as neonTypes } from '@neondatabase/serverless';
import ws from 'ws';
const { Pool, types } = pg;
const POR_WS = /^(1|true)$/i.test(process.env.DB_OVER_WS ?? '');
for (const t of [types, neonTypes]) {
  t.setTypeParser(20, (v) => Number(v)); t.setTypeParser(1700, (v) => Number(v));
  t.setTypeParser(1082, (v) => v); t.setTypeParser(1083, (v) => v);
}
export function urlBase(dbName, servicio) {
  const propia = servicio && process.env[`MS_${servicio.toUpperCase()}_DATABASE_URL`];
  if (propia) return propia;
  const base = process.env.MS_DB_BASE_URL;
  if (!base) throw new Error('Falta MS_DB_BASE_URL (cadena de conexión a Postgres/Neon; el nombre de la base se reemplaza por el de cada servicio).');
  const u = new URL(base); u.pathname = '/' + dbName; return u.toString();
}
const transitorio = (e) => /timeout exceeded when trying to connect|ECONNRESET|ECONNREFUSED|ETIMEDOUT|terminating connection|Connection terminated|57P01|57P03/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export function crearDb(dbName, servicio) {
  const url = urlBase(dbName, servicio);
  const max = Number(process.env.MS_POOL_MAX ?? 3);
  let pool;
  if (POR_WS) {
    neonConfig.webSocketConstructor = ws;
    pool = new NeonPool({ connectionString: url.replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, ''), max, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
  } else pool = new Pool({ connectionString: url, max, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, query_timeout: 15000, keepAlive: true });
  pool.on('error', (e) => console.error(JSON.stringify({ level: 'error', svc: servicio, msg: 'pool: ' + e.message })));
  // Obtiene conexión con 1 reintento (Neon puede estar "despertando"); la consulta en sí NO se reintenta (podría duplicar efectos).
  const conectar = async () => { try { return await pool.connect(); } catch (e) { if (!transitorio(e)) throw e; await dormir(700); return pool.connect(); } };
  const q = async (text, params) => { const c = await conectar(); try { return await c.query(text, params); } finally { c.release(); } };
  const tx = async (fn) => {
    const c = await conectar();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch { /* ignorar */ } throw e; }
    finally { c.release(); }
  };
  return { q, query: q, tx, pool, url, cerrar: () => pool.end().catch(() => {}) };
}
export const paginar = (query, def = 20, max = 100) => {
  const page = Math.max(1, Number(query.page ?? 1)); const limit = Math.min(Math.max(1, Number(query.limit ?? def)), max);
  return { page, limit, offset: (page - 1) * limit };
};
export const meta = (total, p) => ({ total_results: total, page: p.page, limit: p.limit, total_pages: Math.max(1, Math.ceil(total / p.limit)) });
