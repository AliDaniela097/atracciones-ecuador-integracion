// Acceso a PostgreSQL (una base por microservicio, p. ej. en Neon). Solo consultas parametrizadas.
import pg from 'pg';
import { Pool as NeonPool, neonConfig, types as neonTypes } from '@neondatabase/serverless';
import ws from 'ws';
const { Pool, types } = pg;
// DB_OVER_WS=true: habla con Neon por WebSocket (puerto 443) cuando la red bloquea el 5432. DB_WS_PROXY solo para pruebas locales.
const POR_WS = /^(1|true)$/i.test(process.env.DB_OVER_WS ?? '');
for (const t of [types, neonTypes]) {
  t.setTypeParser(20, (v) => Number(v));      // BIGINT  -> number
  t.setTypeParser(1700, (v) => Number(v));    // NUMERIC -> number
  t.setTypeParser(1082, (v) => v);            // DATE    -> 'YYYY-MM-DD' (sin zona horaria)
  t.setTypeParser(1083, (v) => v);            // TIME    -> 'HH:MM:SS'
}

let pool;
export const getPool = () => {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL en el archivo .env de este microservicio.');
    if (POR_WS) {
      neonConfig.webSocketConstructor = ws;
      if (process.env.DB_WS_PROXY) { neonConfig.wsProxy = () => process.env.DB_WS_PROXY; neonConfig.useSecureWebSocket = false; neonConfig.pipelineTLS = false; neonConfig.pipelineConnect = false; }
      const url = process.env.DATABASE_URL.replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
      pool = new NeonPool({ connectionString: url, max: 10, connectionTimeoutMillis: 15000 });
    } else pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    pool.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'pool: ' + e.message })));
  }
  return pool;
};
export const q = (text, params) => getPool().query(text, params);
export async function tx(fn) {
  const c = await getPool().connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch { /* ignorar */ } throw e; }
  finally { c.release(); }
}
export const closePool = async () => { if (pool) { await pool.end(); pool = undefined; } };
export const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? '');
export function paginar(req, defLimit = 20, maxLimit = 100) {
  const page = req.page ?? 1; const limit = Math.min(req.limit ?? defLimit, maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}
export const meta = (total, p) => ({ total_results: total, page: p.page, limit: p.limit, total_pages: Math.max(1, Math.ceil(total / p.limit)) });
