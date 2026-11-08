// ms_refund — devoluciones totales o parciales de un pago. Base propia: ms_refund.
// Regla (reemplaza al trigger trg_reembolso_no_excede): antes de aceptar una solicitud se consulta a Payment el monto cobrado y se verifica que
// (reembolsos ya solicitados/procesados + el nuevo) no supere lo cobrado. La comprobación se hace con candado por pago, así dos solicitudes simultáneas no se pasan.
// Flujo: el dueño (o un ADMIN) SOLICITA → un ADMIN PROCESA (la devolución a la pasarela es SIMULADA). Si el pago queda devuelto por completo, la orden pasa a REEMBOLSADA.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado, conflicto, regla } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar } from '../../_shared/auth.mjs';
import { obtener } from '../../_shared/llamadas.mjs';
import { cambiarEstadoOrden, obtenerOrden, ordenActivo } from '../../_shared/order-cliente.mjs';
import { paginar, meta } from '../../_shared/pgs.mjs';
import { publicar } from '../../_shared/eventos.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cents = (x) => Math.round(x * 100);
const esquemas = {
  solicitud: { type: 'object', additionalProperties: false, required: ['pag_id', 'monto'], properties: { pag_id: { type: 'integer', minimum: 1 }, monto: { type: 'number', exclusiveMinimum: 0, multipleOf: 0.01 }, motivo: { type: 'string', minLength: 3, maxLength: 300 } } },
  lista: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, pag_id: { type: 'integer' }, procesado: { type: 'boolean' } } },
};
const fila = (x) => ({ rem_id: x.rem_id, numero: x.rem_numero, pag_id: x.pag_id, monto: x.rem_monto, motivo: x.rem_motivo, referencia: x.rem_referencia, estado: x.rem_procesado_en ? 'PROCESADO' : 'SOLICITADO', solicitado_en: x.rem_solicitado_en, procesado_en: x.rem_procesado_en });
const numeroRem = () => `REM-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const ID = (v, n = 'id') => { if (!/^\d{1,18}$/.test(v)) throw err(400, 'BAD_ID', `${n} debe ser numérico.`); return v; };

function crearRutas(r, { db }) {
  // Pago + moneda + dueño (vía Order) para decidir permisos. Si Payment no responde → 503 (no se aceptan reembolsos "a ciegas").
  async function datosPago(pagId) {
    const p = await obtener('payment', `/v1/pagos/${pagId}`); if (!p) throw err(422, 'PAYMENT_NOT_FOUND', 'El pago no existe.', [{ name: 'pag_id', reason: 'no existe' }]); return p;
  }
  async function esDuenoDelPago(a, pago) {
    if (a.roles.includes('ADMIN') || a.interno) return true; if (!ordenActivo()) return false;
    const o = await obtenerOrden(pago.ord_id).catch(() => null); return Boolean(o && o.usu_id === a.usu_id);
  }
  const sumas = async (c, pagId) => (await c.query('SELECT COALESCE(sum(rem_monto),0)::float AS total, COALESCE(sum(rem_monto) FILTER (WHERE rem_procesado_en IS NOT NULL),0)::float AS procesado FROM reembolso WHERE pag_id = $1', [pagId])).rows[0];

  r.post('/v1/reembolsos', async (ctx) => {
    const a = await autorizar(ctx, {}); const b = ctx.validar('solicitud', ctx.body);
    const pago = await datosPago(b.pag_id);
    if (!(await esDuenoDelPago(a, pago))) throw err(403, 'FORBIDDEN', 'El pago no pertenece a este usuario.');
    if (pago.estado !== 'APROBADO') throw conflicto(`Solo se devuelven pagos APROBADO (este está ${pago.estado}).`, 'PAYMENT_NOT_REFUNDABLE');
    const x = await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(7770031, $1)', [b.pag_id % 2147483647]);
      const s = await sumas(c, b.pag_id); const disponible = cents(pago.monto) - cents(s.total);
      if (cents(b.monto) > disponible) throw err(422, 'REFUND_EXCEEDS_PAYMENT', `El reembolso supera lo cobrado: cobrado ${pago.monto.toFixed(2)}, ya solicitado ${s.total.toFixed(2)}, disponible ${(disponible / 100).toFixed(2)}.`,
        [{ name: 'monto', reason: `máximo ${(disponible / 100).toFixed(2)}` }]);
      return (await c.query('INSERT INTO reembolso (pag_id, rem_numero, rem_monto, rem_motivo) VALUES ($1,$2,$3,$4) RETURNING *', [b.pag_id, numeroRem(), b.monto, b.motivo ?? null])).rows[0];
    });
    publicar({ tipo: 'REEMBOLSO_SOLICITADO', origen: 'refund', usu_id: a.usu_id, entidad: 'reembolso', entidad_id: String(x.rem_id), datos: { pag_id: x.pag_id, monto: x.rem_monto } });
    return responder(201, { ...fila(x), moneda: pago.moneda }, { Location: `/v1/reembolsos/${x.rem_id}` });
  });

  r.post('/v1/reembolsos/:id/procesar', async (ctx) => {
    const a = await autorizar(ctx, { roles: ['ADMIN'] }); ID(ctx.params.id);
    const act = (await db.q('SELECT * FROM reembolso WHERE rem_id = $1', [ctx.params.id])).rows[0]; if (!act) throw noEncontrado('El reembolso');
    const pago = await datosPago(act.pag_id);
    const { x, completo } = await db.tx(async (c) => {
      const cur = (await c.query('SELECT * FROM reembolso WHERE rem_id = $1 FOR UPDATE', [act.rem_id])).rows[0];
      if (cur.rem_procesado_en) throw conflicto('El reembolso ya fue procesado.', 'ALREADY_PROCESSED');
      const upd = (await c.query('UPDATE reembolso SET rem_procesado_en = now(), rem_referencia = $2 WHERE rem_id = $1 RETURNING *', [act.rem_id, `SIM-RF-${crypto.randomBytes(6).toString('hex')}`])).rows[0];   // simulado: no hay pasarela real
      const s = await sumas(c, act.pag_id); return { x: upd, completo: cents(s.procesado) === cents(pago.monto) };
    });
    let ordenOk = null;
    if (completo && ordenActivo()) { try { await cambiarEstadoOrden(pago.ord_id, 'REEMBOLSADA'); ordenOk = true; } catch (e) { ordenOk = e.code === 'INVALID_TRANSITION' ? (await obtenerOrden(pago.ord_id).catch(() => null))?.est_codigo === 'REEMBOLSADA' : false; } }
    publicar({ tipo: 'REEMBOLSO_PROCESADO', origen: 'refund', usu_id: a.usu_id, entidad: 'reembolso', entidad_id: String(x.rem_id), datos: { pag_id: x.pag_id, monto: x.rem_monto, completo } });
    return { ...fila(x), pago_devuelto_por_completo: completo, orden_actualizada: ordenOk };
  });

  r.delete('/v1/reembolsos/:id', async (ctx) => {                         // cancelar una solicitud aún no procesada
    const a = await autorizar(ctx, {}); ID(ctx.params.id);
    const act = (await db.q('SELECT * FROM reembolso WHERE rem_id = $1', [ctx.params.id])).rows[0]; if (!act) throw noEncontrado('El reembolso');
    if (!(await esDuenoDelPago(a, await datosPago(act.pag_id)))) throw err(403, 'FORBIDDEN', 'No tiene permiso para este reembolso.');
    const x = await db.q('DELETE FROM reembolso WHERE rem_id = $1 AND rem_procesado_en IS NULL', [act.rem_id]); if (!x.rowCount) throw regla('Un reembolso procesado no se puede cancelar.', 'ALREADY_PROCESSED');
    return responder(204, undefined);
  });
  r.get('/v1/reembolsos/:id', async (ctx) => {
    const a = await autorizar(ctx, {}); ID(ctx.params.id); const x = (await db.q('SELECT * FROM reembolso WHERE rem_id = $1', [ctx.params.id])).rows[0]; if (!x) throw noEncontrado('El reembolso');
    if (!(await esDuenoDelPago(a, await datosPago(x.pag_id)))) throw err(403, 'FORBIDDEN', 'No tiene permiso para este reembolso.');
    return fila(x);
  });
  r.get('/v1/reembolsos', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q); const par = []; const w = [];
    if (q.pag_id) { par.push(q.pag_id); w.push(`pag_id = $${par.length}`); } if (q.procesado !== undefined) w.push(q.procesado ? 'rem_procesado_en IS NOT NULL' : 'rem_procesado_en IS NULL');
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const tot = (await db.q(`SELECT count(*) AS n FROM reembolso ${where}`, par)).rows[0].n;
    return { data: (await db.q(`SELECT * FROM reembolso ${where} ORDER BY rem_id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows.map(fila), metadata: meta(tot, p) };
  });
}
export default { nombre: 'refund', marcador: 'reembolso', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
