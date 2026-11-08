// ms_review — reseñas y puntuaciones de los clientes. Base propia: ms_review.
// Cada cambio que afecte la calificación publica un evento (RESENA_PUBLICADA / RESENA_RETIRADA) con el promedio y el total ya calculados;
// Catalog lo consume para actualizar la atracción (reemplaza al trigger trg_resena_calificacion del script original).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar, validarToken, modoAuth } from '../../_shared/auth.mjs';
import { obtener } from '../../_shared/llamadas.mjs';
import { paginar, meta } from '../../_shared/pgs.mjs';
import { publicar } from '../../_shared/eventos.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const esquemas = {
  resena: { type: 'object', additionalProperties: false, required: ['puntuacion', 'comentario'], properties: {
    puntuacion: { type: 'integer', minimum: 1, maximum: 5 }, comentario: { type: 'string', minLength: 3, maxLength: 1000, pattern: '\\S' }, autor_nombre: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' } } },
  visible: { type: 'object', additionalProperties: false, required: ['visible'], properties: { visible: { type: 'boolean' } } },
  lista: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, puntuacion: { type: 'integer', minimum: 1, maximum: 5 } } },
};
const fila = (x) => ({ ren_id: x.ren_id, atr_id: x.atr_id, usu_id: x.usu_id, autor: x.usu_id ? null : x.ren_autor_nombre, puntuacion: x.ren_puntuacion, comentario: x.ren_comentario, visible: x.ren_visible, creado_en: x.ren_creado_en });
const ID = (v, n = 'id') => { if (!/^\d{1,18}$/.test(v)) throw err(400, 'BAD_ID', `${n} debe ser numérico.`); return v; };

function crearRutas(r, { db }) {
  // Totales de la atracción (solo reseñas visibles), calculados dentro de la misma transacción que el cambio.
  const totales = async (c, atrId) => { const x = (await c.query('SELECT COALESCE(round(avg(ren_puntuacion)::numeric, 2), 0)::float AS promedio, count(*)::int AS n FROM resena WHERE atr_id = $1 AND ren_visible', [atrId])).rows[0]; return { promedio: x.promedio, numero_resenas: x.n }; };
  const emitir = (tipo, usuId, ren, t) => publicar({ tipo, origen: 'review', usu_id: usuId ?? null, entidad: 'resena', entidad_id: String(ren.ren_id), datos: { atr_id: ren.atr_id, ren_id: ren.ren_id, puntuacion: ren.ren_puntuacion, ...t } });

  r.post('/v1/atracciones/:atrId/resenas', async (ctx) => {
    ID(ctx.params.atrId, 'atrId'); const b = ctx.validar('resena', ctx.body);
    // Con token: reseña del usuario (una por atracción). Sin token: anónima, exige autor_nombre.
    let usuId = null;
    if (ctx.headers.authorization) { const a = await autorizar(ctx, {}); usuId = a.usu_id; if (!usuId) throw err(400, 'NO_USER', 'La llamada no corresponde a un usuario.'); }
    else if (!b.autor_nombre) throw err(400, 'VALIDATION_ERROR', 'Una reseña anónima requiere autor_nombre.', [{ name: 'autor_nombre', reason: 'requerido sin sesión' }]);
    else if (modoAuth() === 'identity' && process.env.MS_ALLOW_ANON_REVIEWS === 'false') throw err(401, 'UNAUTHORIZED', 'Inicie sesión para reseñar.');
    if (usuId && b.autor_nombre) throw err(400, 'VALIDATION_ERROR', 'Con sesión iniciada no se envía autor_nombre.', [{ name: 'autor_nombre', reason: 'no permitido con sesión' }]);
    const atr = await obtener('catalog', `/v1/atracciones/${ctx.params.atrId}`);          // solo se reseñan atracciones publicadas
    if (!atr) throw err(422, 'ATTRACTION_NOT_FOUND', 'La atracción no existe o no está publicada.', [{ name: 'atrId', reason: 'no existe' }]);
    const { ren, t } = await db.tx(async (c) => {
      const x = (await c.query('INSERT INTO resena (atr_id, usu_id, ren_autor_nombre, ren_puntuacion, ren_comentario) VALUES ($1,$2,$3,$4,btrim($5)) RETURNING *', [ctx.params.atrId, usuId, usuId ? null : b.autor_nombre.trim(), b.puntuacion, b.comentario])).rows[0];
      return { ren: x, t: await totales(c, x.atr_id) };
    });
    emitir('RESENA_PUBLICADA', usuId, ren, t);
    return responder(201, { ...fila(ren), atraccion: t }, { Location: `/v1/resenas/${ren.ren_id}` });
  });

  r.get('/v1/atracciones/:atrId/resenas', async (ctx) => {
    ID(ctx.params.atrId, 'atrId'); const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q);
    const par = [ctx.params.atrId]; let w = 'atr_id = $1 AND ren_visible'; if (q.puntuacion) { par.push(q.puntuacion); w += ` AND ren_puntuacion = $${par.length}`; }
    const tot = (await db.q(`SELECT count(*) AS n FROM resena WHERE ${w}`, par)).rows[0].n;
    const rows = (await db.q(`SELECT * FROM resena WHERE ${w} ORDER BY ren_creado_en DESC, ren_id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows;
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const x of (await db.q('SELECT ren_puntuacion AS pu, count(*)::int AS n FROM resena WHERE atr_id = $1 AND ren_visible GROUP BY ren_puntuacion', [ctx.params.atrId])).rows) dist[x.pu] = x.n;
    const prom = (await db.q('SELECT COALESCE(round(avg(ren_puntuacion)::numeric,2),0)::float AS promedio, count(*)::int AS total FROM resena WHERE atr_id = $1 AND ren_visible', [ctx.params.atrId])).rows[0];
    return { data: rows.map(fila), resumen: { promedio: prom.promedio, total: prom.total, distribucion: dist }, metadata: meta(tot, p) };
  });

  r.get('/v1/resenas/:id', async (ctx) => { const x = (await db.q('SELECT * FROM resena WHERE ren_id = $1 AND ren_visible', [ID(ctx.params.id)])).rows[0]; if (!x) throw noEncontrado('La reseña'); return fila(x); });

  // Moderación (ADMIN): ocultar / mostrar.
  r.patch('/v1/resenas/:id/visibilidad', async (ctx) => {
    const a = await autorizar(ctx, { roles: ['ADMIN'] }); const { visible } = ctx.validar('visible', ctx.body);
    const { ren, t } = await db.tx(async (c) => {
      const x = (await c.query('UPDATE resena SET ren_visible = $2 WHERE ren_id = $1 RETURNING *', [ID(ctx.params.id), visible])).rows[0]; if (!x) throw noEncontrado('La reseña');
      return { ren: x, t: await totales(c, x.atr_id) };
    });
    emitir(visible ? 'RESENA_PUBLICADA' : 'RESENA_RETIRADA', a.usu_id, ren, t);
    return { ...fila(ren), atraccion: t };
  });
  // Borrado: el autor o un ADMIN.
  r.delete('/v1/resenas/:id', async (ctx) => {
    const a = await autorizar(ctx, { roles: ['ADMIN'] }).catch(async (e) => { if (e.status !== 403) throw e; return autorizar(ctx, {}); });   // cualquier usuario autenticado; el dueño se comprueba abajo
    const act = (await db.q('SELECT * FROM resena WHERE ren_id = $1', [ID(ctx.params.id)])).rows[0]; if (!act) throw noEncontrado('La reseña');
    if (!a.roles.includes('ADMIN') && act.usu_id !== a.usu_id) throw err(403, 'FORBIDDEN', 'Solo el autor o un administrador pueden borrar la reseña.');
    const t = await db.tx(async (c) => { await c.query('DELETE FROM resena WHERE ren_id = $1', [act.ren_id]); return totales(c, act.atr_id); });
    emitir('RESENA_RETIRADA', a.usu_id, act, t);
    return responder(204, undefined);
  });
}
void validarToken;
export default { nombre: 'review', marcador: 'resena', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
