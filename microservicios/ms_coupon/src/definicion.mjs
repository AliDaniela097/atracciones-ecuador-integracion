// ms_coupon — cupones de descuento y su vigencia. Base propia: ms_coupon.
// Los usos reales se cuentan en Order (orden_cupon): quien llama a /validar informa cuántos usos lleva el cupón (usos_actuales).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar } from '../../_shared/auth.mjs';
import { paginar, meta } from '../../_shared/pgs.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const props = {
  codigo: { type: 'string', pattern: '^[A-Za-z0-9_-]{3,30}$' }, tipo: { type: 'string', enum: ['PORCENTAJE', 'FIJO'] }, valor: { type: 'number', exclusiveMinimum: 0, multipleOf: 0.01 },
  fecha_inicio: { type: 'string', format: 'date' }, fecha_fin: { type: ['string', 'null'], format: 'date' }, usos_max: { type: ['integer', 'null'], minimum: 1 }, activo: { type: 'boolean' },
};
const esquemas = {
  crear: { type: 'object', additionalProperties: false, required: ['codigo', 'tipo', 'valor', 'fecha_inicio'], properties: props },
  cambiar: { type: 'object', additionalProperties: false, minProperties: 1, properties: { fecha_fin: props.fecha_fin, usos_max: props.usos_max, activo: props.activo, valor: props.valor } },
  validar: { type: 'object', additionalProperties: false, required: ['codigo', 'subtotal'], properties: { codigo: { type: 'string', minLength: 1, maxLength: 30 }, subtotal: { type: 'number', minimum: 0, multipleOf: 0.01 }, usos_actuales: { type: 'integer', minimum: 0 } } },
  lista: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, activo: { type: 'boolean' } } },
};
const fila = (x) => ({ cup_id: x.cup_id, codigo: x.cup_codigo, tipo: x.cup_tipo, valor: x.cup_valor, fecha_inicio: x.cup_fecha_inicio, fecha_fin: x.cup_fecha_fin, usos_max: x.cup_usos_max, activo: x.cup_activo });
const HOY = "(now() AT TIME ZONE 'America/Guayaquil')::date";

function crearRutas(r, { db }) {
  r.post('/v1/cupones', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const b = ctx.validar('crear', ctx.body);
    if (b.tipo === 'PORCENTAJE' && b.valor > 100) throw err(400, 'VALIDATION_ERROR', 'Un porcentaje no puede superar 100.', [{ name: 'valor', reason: 'máximo 100 para PORCENTAJE' }]);
    if (b.fecha_fin && b.fecha_fin < b.fecha_inicio) throw err(400, 'VALIDATION_ERROR', 'La fecha de fin es anterior al inicio.', [{ name: 'fecha_fin', reason: 'debe ser ≥ fecha_inicio' }]);
    const x = (await db.q('INSERT INTO cupon (cup_codigo, cup_tipo, cup_valor, cup_fecha_inicio, cup_fecha_fin, cup_usos_max, cup_activo) VALUES (upper($1),$2,$3,$4,$5,$6,$7) RETURNING *',
      [b.codigo, b.tipo, b.valor, b.fecha_inicio, b.fecha_fin ?? null, b.usos_max ?? null, b.activo ?? true])).rows[0];
    return responder(201, fila(x), { Location: `/v1/cupones/${x.cup_codigo}` });
  });
  r.get('/v1/cupones', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q); const par = []; let w = '';
    if (q.activo !== undefined) { par.push(q.activo); w = 'WHERE cup_activo = $1'; }
    const tot = (await db.q(`SELECT count(*) AS n FROM cupon ${w}`, par)).rows[0].n;
    return { data: (await db.q(`SELECT * FROM cupon ${w} ORDER BY cup_id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows.map(fila), metadata: meta(tot, p) };
  });
  r.get('/v1/cupones/:codigo', async (ctx) => { await autorizar(ctx, { roles: ['ADMIN'] }); const x = (await db.q('SELECT * FROM cupon WHERE cup_codigo = upper($1)', [ctx.params.codigo])).rows[0]; if (!x) throw noEncontrado('El cupón'); return fila(x); });
  r.patch('/v1/cupones/:codigo', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const b = ctx.validar('cambiar', ctx.body);
    const act = (await db.q('SELECT * FROM cupon WHERE cup_codigo = upper($1)', [ctx.params.codigo])).rows[0]; if (!act) throw noEncontrado('El cupón');
    const valor = b.valor ?? act.cup_valor; if (act.cup_tipo === 'PORCENTAJE' && valor > 100) throw err(400, 'VALIDATION_ERROR', 'Un porcentaje no puede superar 100.', [{ name: 'valor', reason: 'máximo 100' }]);
    const fin = b.fecha_fin === undefined ? act.cup_fecha_fin : b.fecha_fin; if (fin && fin < act.cup_fecha_inicio) throw err(400, 'VALIDATION_ERROR', 'La fecha de fin es anterior al inicio.', [{ name: 'fecha_fin', reason: 'debe ser ≥ fecha_inicio' }]);
    const x = (await db.q('UPDATE cupon SET cup_valor = $2, cup_fecha_fin = $3, cup_usos_max = $4, cup_activo = $5 WHERE cup_id = $1 RETURNING *',
      [act.cup_id, valor, fin, b.usos_max === undefined ? act.cup_usos_max : b.usos_max, b.activo ?? act.cup_activo])).rows[0];
    return fila(x);
  });
  // Valida un cupón para un subtotal. Responde 200 siempre que la petición sea correcta: { valido:false, motivo } si no aplica.
  r.post('/v1/cupones/validar', async (ctx) => {
    await autorizar(ctx, {}); const b = ctx.validar('validar', ctx.body);
    const x = (await db.q(`SELECT *, ${HOY} AS hoy FROM cupon WHERE cup_codigo = upper($1)`, [b.codigo])).rows[0];
    const no = (motivo) => ({ valido: false, motivo, descuento: 0 });
    if (!x) return no('NO_EXISTE'); if (!x.cup_activo) return no('INACTIVO');
    if (x.hoy < x.cup_fecha_inicio) return no('AUN_NO_VIGENTE'); if (x.cup_fecha_fin && x.hoy > x.cup_fecha_fin) return no('VENCIDO');
    if (x.cup_usos_max !== null && (b.usos_actuales ?? 0) >= x.cup_usos_max) return no('USOS_AGOTADOS');
    const bruto = x.cup_tipo === 'PORCENTAJE' ? Math.round(b.subtotal * x.cup_valor) / 100 : x.cup_valor;
    const descuento = Math.round(Math.min(bruto, b.subtotal) * 100) / 100;                           // nunca mayor al subtotal
    return { valido: true, cup_id: x.cup_id, codigo: x.cup_codigo, tipo: x.cup_tipo, valor: x.cup_valor, descuento, total_con_descuento: Math.round((b.subtotal - descuento) * 100) / 100 };
  });
}
export default { nombre: 'coupon', marcador: 'cupon', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
