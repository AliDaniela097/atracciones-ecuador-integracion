// ms_audit — bitácora de todos los eventos del sistema (consumidor de eventos). Solo se agrega: nunca se edita ni se borra.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar, exigirInterna } from '../../_shared/auth.mjs';
import { paginar, meta } from '../../_shared/pgs.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const evento = { type: 'object', required: ['tipo', 'origen'], properties: {
  id: { type: 'string', maxLength: 64 }, tipo: { type: 'string', minLength: 1, maxLength: 60 }, origen: { type: 'string', maxLength: 40 },
  usu_id: { type: ['integer', 'null'], minimum: 1 }, entidad: { type: 'string', maxLength: 60 }, entidad_id: { type: 'string', maxLength: 64 },
  datos: { type: 'object' }, ip: { type: 'string', maxLength: 45 }, en: { type: 'string' } } };
const esquemas = {
  evento,
  lote: { type: 'object', required: ['eventos'], properties: { eventos: { type: 'array', minItems: 1, maxItems: 200, items: evento } } },
  lista: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, usu_id: { type: 'integer' }, accion: { type: 'string', maxLength: 60 },
    entidad: { type: 'string', maxLength: 60 }, entidad_id: { type: 'string', maxLength: 64 }, desde: { type: 'string', format: 'date-time' }, hasta: { type: 'string', format: 'date-time' } } },
};
const fila = (x) => ({ bit_id: x.bit_id, usu_id: x.usu_id, accion: x.bit_accion, entidad: x.bit_entidad, entidad_id: x.bit_entidad_id, detalle: x.bit_detalle, ip: x.bit_ip, creado_en: x.bit_creado_en });
const SENSIBLES = /pass|clave|token|secret|authorization|card|tarjeta_num|cvv|cvc/i;
function limpiar(o, prof = 0) {                  // nunca se guardan contraseñas, tokens ni números de tarjeta en la bitácora
  if (prof > 4 || o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.slice(0, 50).map((v) => limpiar(v, prof + 1));
  return Object.fromEntries(Object.entries(o).slice(0, 50).map(([k, v]) => [k, SENSIBLES.test(k) ? '[omitido]' : limpiar(v, prof + 1)]));
}
const insertar = (c, e) => c.query(`INSERT INTO bitacora (usu_id, bit_accion, bit_entidad, bit_entidad_id, bit_detalle, bit_ip, bit_creado_en) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()))`,
  [e.usu_id ?? null, e.tipo.toUpperCase(), e.entidad ?? e.origen, e.entidad_id ?? null, JSON.stringify(limpiar({ origen: e.origen, evento_id: e.id, ...(e.datos ?? {}) })), e.ip ?? null, e.en ?? null]);

function crearRutas(r, { db }) {
  // Consumidor: lo llaman los demás servicios (hoy por HTTP interno; con el bus RabbitMQ será la cola de este servicio).
  r.post('/internal/eventos', async (ctx) => { exigirInterna(ctx); const e = ctx.validar('evento', ctx.body); await insertar({ query: db.q }, e); return responder(202, { aceptado: true }); });
  r.post('/internal/eventos/lote', async (ctx) => {
    exigirInterna(ctx); const { eventos } = ctx.validar('lote', ctx.body);
    await db.tx(async (c) => { for (const e of eventos) await insertar(c, e); });
    return responder(202, { aceptados: eventos.length });
  });
  r.get('/v1/bitacora', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] });
    const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q); const w = []; const par = [];
    const add = (cond, v) => { par.push(v); w.push(cond.replace('?', `$${par.length}`)); };
    if (q.usu_id) add('usu_id = ?', q.usu_id); if (q.accion) add('bit_accion = ?', q.accion.toUpperCase()); if (q.entidad) add('bit_entidad = ?', q.entidad);
    if (q.entidad_id) add('bit_entidad_id = ?', q.entidad_id); if (q.desde) add('bit_creado_en >= ?', q.desde); if (q.hasta) add('bit_creado_en <= ?', q.hasta);
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const tot = (await db.q(`SELECT count(*) AS n FROM bitacora ${where}`, par)).rows[0].n;
    const rows = (await db.q(`SELECT * FROM bitacora ${where} ORDER BY bit_creado_en DESC, bit_id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows;
    return { data: rows.map(fila), metadata: meta(tot, p) };
  });
  r.get('/v1/bitacora/:id', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); if (!/^\d{1,18}$/.test(ctx.params.id)) throw err(400, 'BAD_ID', 'id numérico requerido.');
    const x = (await db.q('SELECT * FROM bitacora WHERE bit_id = $1', [ctx.params.id])).rows[0]; if (!x) throw err(404, 'NOT_FOUND', 'El registro no existe.');
    return fila(x);
  });
}
export default { nombre: 'audit', marcador: 'bitacora', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
