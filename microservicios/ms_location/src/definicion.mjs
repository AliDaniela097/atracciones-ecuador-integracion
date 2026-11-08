// ms_location — regiones, provincias y ciudades (destinos). Catálogo de solo lectura que consultan otros servicios.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar } from '../../_shared/auth.mjs';
import { paginar, meta } from '../../_shared/pgs.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esquemas = {
  lista: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, reg_id: { type: 'integer' }, prov_id: { type: 'integer' }, q: { type: 'string', maxLength: 80 }, activa: { type: 'boolean' } } },
  ciudad: { type: 'object', additionalProperties: false, required: ['nombre', 'codigo', 'prov_id'], properties: {
    nombre: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' }, codigo: { type: 'string', pattern: '^[0-9]{6}$' }, prov_id: { type: 'integer', minimum: 1 },
    descripcion: { type: 'string', maxLength: 500 }, imagen: { type: 'string', maxLength: 500 }, activa: { type: 'boolean' } } },
  ciudadCambio: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
    nombre: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' }, descripcion: { type: 'string', maxLength: 500 }, imagen: { type: 'string', maxLength: 500 }, activa: { type: 'boolean' } } },
};
const ciu = (x) => ({ ciu_id: x.ciu_id, nombre: x.ciu_nombre, codigo: x.ciu_codigo, prov_id: x.prov_id, provincia: x.prov_nombre, reg_id: x.reg_id, region: x.reg_nombre, activa: x.ciu_activa, descripcion: x.ciu_descripcion, imagen: x.ciu_imagen });
const SEL = `SELECT c.*, p.prov_nombre, p.reg_id, r.reg_nombre FROM ciudad c JOIN provincia p ON p.prov_id = c.prov_id JOIN region r ON r.reg_id = p.reg_id`;
const idn = (v) => { if (!/^\d{1,9}$/.test(v)) throw err(400, 'BAD_ID', 'El id debe ser numérico.'); if (Number(v) > 32767) throw noEncontrado('El registro'); return v; };   // ids SMALLINT

function crearRutas(r, { db }) {
  r.get('/v1/regiones', async () => ({ data: (await db.q('SELECT reg_id, reg_nombre AS nombre, reg_codigo AS codigo FROM region ORDER BY reg_id')).rows }));
  r.get('/v1/provincias', async (ctx) => {
    const q = ctx.validarQ('lista', { ...ctx.query }); const par = []; let w = 'WHERE prov_activa';
    if (q.reg_id) { par.push(q.reg_id); w += ` AND reg_id = $${par.length}`; }
    return { data: (await db.q(`SELECT prov_id, prov_nombre AS nombre, prov_codigo AS codigo, reg_id FROM provincia ${w} ORDER BY prov_nombre`, par)).rows };
  });
  r.get('/v1/provincias/:id', async (ctx) => {
    const x = (await db.q('SELECT prov_id, prov_nombre AS nombre, prov_codigo AS codigo, reg_id, prov_activa AS activa FROM provincia WHERE prov_id = $1', [idn(ctx.params.id)])).rows[0]; if (!x) throw noEncontrado('La provincia'); return x;
  });
  r.get('/v1/ciudades', async (ctx) => {
    const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q); const par = []; const w = [];
    const add = (c, v) => { par.push(v); w.push(c.replace('?', `$${par.length}`)); };
    add('c.ciu_activa = ?', q.activa ?? true); if (q.prov_id) add('c.prov_id = ?', q.prov_id); if (q.reg_id) add('p.reg_id = ?', q.reg_id); if (q.q) add('c.ciu_nombre ILIKE ?', `%${q.q}%`);
    const where = 'WHERE ' + w.join(' AND ');
    const tot = (await db.q(`SELECT count(*) AS n FROM ciudad c JOIN provincia p ON p.prov_id = c.prov_id ${where}`, par)).rows[0].n;
    const rows = (await db.q(`${SEL} ${where} ORDER BY c.ciu_nombre LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows;
    return { data: rows.map(ciu), metadata: meta(tot, p) };
  });
  r.get('/v1/ciudades/:id', async (ctx) => { const x = (await db.q(`${SEL} WHERE c.ciu_id = $1`, [idn(ctx.params.id)])).rows[0]; if (!x) throw noEncontrado('La ciudad'); return ciu(x); });
  r.post('/v1/ciudades', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const b = ctx.validar('ciudad', ctx.body);
    const prov = (await db.q('SELECT 1 FROM provincia WHERE prov_id = $1', [b.prov_id])).rows[0]; if (!prov) throw err(422, 'PROVINCE_NOT_FOUND', 'La provincia indicada no existe.', [{ name: 'prov_id', reason: 'no existe' }]);
    const x = (await db.q('INSERT INTO ciudad (ciu_nombre, ciu_codigo, prov_id, ciu_descripcion, ciu_imagen, ciu_activa) VALUES (btrim($1),$2,$3,$4,$5,$6) RETURNING ciu_id', [b.nombre, b.codigo, b.prov_id, b.descripcion ?? null, b.imagen ?? null, b.activa ?? true])).rows[0];
    return responder(201, ciu((await db.q(`${SEL} WHERE c.ciu_id = $1`, [x.ciu_id])).rows[0]), { Location: `/v1/ciudades/${x.ciu_id}` });
  });
  r.patch('/v1/ciudades/:id', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const b = ctx.validar('ciudadCambio', ctx.body);
    const x = (await db.q(`UPDATE ciudad SET ciu_nombre = COALESCE(btrim($2), ciu_nombre), ciu_descripcion = COALESCE($3, ciu_descripcion), ciu_imagen = COALESCE($4, ciu_imagen), ciu_activa = COALESCE($5, ciu_activa) WHERE ciu_id = $1 RETURNING ciu_id`,
      [idn(ctx.params.id), b.nombre ?? null, b.descripcion ?? null, b.imagen ?? null, b.activa ?? null])).rows[0]; if (!x) throw noEncontrado('La ciudad');
    return ciu((await db.q(`${SEL} WHERE c.ciu_id = $1`, [x.ciu_id])).rows[0]);
  });
}
export default { nombre: 'location', marcador: 'ciudad', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
