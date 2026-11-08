// ms_support — mensajes de contacto de los visitantes. Base propia: ms_support.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar } from '../../_shared/auth.mjs';
import { paginar, meta } from '../../_shared/pgs.mjs';
import { publicar } from '../../_shared/eventos.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esquemas = {
  mensaje: { type: 'object', additionalProperties: false, required: ['nombre', 'correo', 'asunto', 'cuerpo'], properties: {
    nombre: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' }, correo: { type: 'string', format: 'email', maxLength: 160 },
    asunto: { type: 'string', minLength: 1, maxLength: 30, pattern: '\\S' }, cuerpo: { type: 'string', minLength: 5, maxLength: 2000, pattern: '\\S' } } },
  leido: { type: 'object', additionalProperties: false, required: ['leido'], properties: { leido: { type: 'boolean' } } },
  lista: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, leido: { type: 'boolean' } } },
};
const fila = (x) => ({ men_id: x.men_id, nombre: x.men_nombre, correo: x.men_correo, asunto: x.men_asunto, cuerpo: x.men_cuerpo, leido: x.men_leido, creado_en: x.men_creado_en });
// Endpoint público: freno anti-spam (5 mensajes por IP cada 10 min) además del límite general.
const envios = new Map();
const spam = (ip) => { const t = Date.now(); const a = (envios.get(ip) ?? []).filter((x) => t - x < 600000); a.push(t); envios.set(ip, a); if (envios.size > 5000) envios.clear(); return a.length > 5; };

function crearRutas(r, { db }) {
  r.post('/v1/mensajes', async (ctx) => {
    if (spam(ctx.ip)) throw err(429, 'RATE_LIMITED', 'Demasiados mensajes enviados. Intente más tarde.');
    const b = ctx.validar('mensaje', ctx.body);
    const x = (await db.q('INSERT INTO mensaje_contacto (men_nombre, men_correo, men_asunto, men_cuerpo) VALUES (btrim($1),$2,btrim($3),btrim($4)) RETURNING *', [b.nombre, b.correo, b.asunto, b.cuerpo])).rows[0];
    publicar({ tipo: 'MENSAJE_CONTACTO_RECIBIDO', origen: 'support', entidad: 'mensaje_contacto', entidad_id: String(x.men_id), ip: ctx.ip });
    return responder(201, { men_id: x.men_id, creado_en: x.men_creado_en });      // no se devuelve el contenido a un anónimo
  });
  r.get('/v1/mensajes', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] });
    const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q); const par = []; let where = '';
    if (q.leido !== undefined) { par.push(q.leido); where = 'WHERE men_leido = $1'; }
    const tot = (await db.q(`SELECT count(*) AS n FROM mensaje_contacto ${where}`, par)).rows[0].n;
    const rows = (await db.q(`SELECT * FROM mensaje_contacto ${where} ORDER BY men_creado_en DESC LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows;
    return { data: rows.map(fila), metadata: meta(tot, p) };
  });
  r.patch('/v1/mensajes/:id', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); if (!/^\d{1,18}$/.test(ctx.params.id)) throw err(400, 'BAD_ID', 'id numérico requerido.');
    const { leido } = ctx.validar('leido', ctx.body);
    const x = (await db.q('UPDATE mensaje_contacto SET men_leido = $2 WHERE men_id = $1 RETURNING *', [ctx.params.id, leido])).rows[0]; if (!x) throw noEncontrado('El mensaje');
    return fila(x);
  });
}
export default { nombre: 'support', marcador: 'mensaje_contacto', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
