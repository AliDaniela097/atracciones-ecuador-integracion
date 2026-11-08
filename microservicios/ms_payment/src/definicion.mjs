// ms_payment — cobros por tarjeta, transferencia o pago en sitio. Base propia: ms_payment.
// IMPORTANTE: NO hay pasarela real. La aprobación de tarjetas la decide un SIMULADOR determinista (ver README, "Qué es simulado").
// Nunca se guarda ni se registra el número completo de la tarjeta ni el CVV: solo marca, últimos 4 dígitos, titular, mes y año.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado, conflicto } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar, exigirInterna } from '../../_shared/auth.mjs';
import { obtenerOrden, cambiarEstadoOrden, ordenActivo } from '../../_shared/order-cliente.mjs';
import { paginar, meta } from '../../_shared/pgs.mjs';
import { publicar } from '../../_shared/eventos.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const esquemas = {
  pago: { type: 'object', additionalProperties: false, required: ['ord_id', 'metodo', 'monto'], properties: {
    ord_id: { type: 'integer', minimum: 1 }, metodo: { type: 'string', enum: ['TARJETA', 'TRANSFERENCIA', 'EN_SITIO'] }, monto: { type: 'number', exclusiveMinimum: 0, maximum: 1000000, multipleOf: 0.01 },
    tarjeta: { type: 'object', additionalProperties: false, required: ['numero', 'titular', 'mes', 'anio', 'cvv'], properties: {
      numero: { type: 'string', pattern: '^[0-9]{13,19}$' }, titular: { type: 'string', minLength: 2, maxLength: 120, pattern: '\\S' }, mes: { type: 'integer', minimum: 1, maximum: 12 },
      anio: { type: 'integer', minimum: 2020, maximum: 2100 }, cvv: { type: 'string', pattern: '^[0-9]{3,4}$' }, pais: { type: 'string', pattern: '^[A-Z]{2}$' } } },
    transferencia: { type: 'object', additionalProperties: false, required: ['banco', 'numero_comprobante', 'fecha_transferencia'], properties: {
      banco: { type: 'string', minLength: 2, maxLength: 60, pattern: '\\S' }, numero_comprobante: { type: 'string', minLength: 3, maxLength: 40, pattern: '^[A-Za-z0-9-]+$' },
      fecha_transferencia: { type: 'string', format: 'date' }, archivo_adjunto: { type: 'string', maxLength: 500, pattern: '^https?://' } } } } },
  rechazo: { type: 'object', additionalProperties: false, properties: { motivo: { type: 'string', minLength: 3, maxLength: 300 } } },
  lista: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, estado: { type: 'string', enum: ['PENDIENTE', 'APROBADO', 'RECHAZADO', 'FALLIDO'] }, ord_id: { type: 'integer' } } },
};
const luhn = (n) => { let s = 0; let alt = false; for (let i = n.length - 1; i >= 0; i--) { let d = Number(n[i]); if (alt) { d *= 2; if (d > 9) d -= 9; } s += d; alt = !alt; } return s % 10 === 0; };
const marca = (n) => (/^4/.test(n) ? 'VISA' : /^(5[1-5]|2(2[2-9][0-9]|[3-6][0-9]{2}|7[01][0-9]|720))/.test(n) ? 'MASTERCARD' : /^3[47]/.test(n) ? 'AMEX' : null);
const numeroPago = () => `PAG-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const cents = (x) => Math.round(x * 100);

const SEL = `SELECT p.*, e.est_codigo, m.mpa_codigo FROM pago p JOIN estado e ON e.est_id = p.est_id JOIN metodo_pago m ON m.mpa_id = p.mpa_id`;
const vista = (p, extra = {}) => ({ pag_id: p.pag_id, numero: p.pag_numero, ord_id: p.ord_id, metodo: p.mpa_codigo, estado: p.est_codigo, monto: p.pag_monto, referencia: p.pag_referencia, autorizacion: p.pag_autorizacion,
  fecha: p.pag_fecha, aprobado_en: p.pag_aprobado_en, rechazado_en: p.pag_rechazado_en, motivo_rechazo: p.pag_motivo_rechazo, ...extra });

function crearRutas(r, { db }) {
  const estadoId = async (c, cod) => (await c.query('SELECT est_id FROM estado WHERE est_codigo = $1', [cod])).rows[0].est_id;
  const cargar = async (id) => { if (!/^\d{1,18}$/.test(id)) throw err(400, 'BAD_ID', 'id numérico requerido.'); const x = (await db.q(`${SEL} WHERE p.pag_id = $1`, [id])).rows[0]; if (!x) throw noEncontrado('El pago'); return x; };
  // Dueño del pago = dueño de la orden (el pago solo guarda ord_id). ADMIN/interno ven todo.
  async function permitirLectura(ctx, pago) {
    const a = await autorizar(ctx, {});
    if (a.roles.includes('ADMIN') || a.interno) return a;
    if (!ordenActivo()) throw err(403, 'FORBIDDEN', 'No tiene permiso para este pago.');
    const o = await obtenerOrden(pago.ord_id).catch((e) => { if (e.status === 404) return null; throw e; });
    if (!o || o.usu_id !== a.usu_id) throw err(403, 'FORBIDDEN', 'No tiene permiso para este pago.');
    return a;
  }
  const avanzarOrden = async (ordId, estado) => { if (!ordenActivo()) return null; try { await cambiarEstadoOrden(ordId, estado); return true; } catch (e) { if (e.code === 'INVALID_TRANSITION') { try { return (await obtenerOrden(ordId)).est_codigo === estado; } catch { return false; } } console.error(JSON.stringify({ level: 'error', msg: `no se pudo pasar la orden ${ordId} a ${estado}: ${e.message}` })); return false; } };

  r.get('/v1/metodos-pago', async () => ({ data: (await db.q('SELECT mpa_id, mpa_codigo AS codigo, mpa_nombre AS nombre, mpa_requiere_datos AS requiere_datos FROM metodo_pago WHERE mpa_activo ORDER BY mpa_id')).rows }));

  r.post('/v1/pagos', async (ctx) => {
    const a = await autorizar(ctx, {}); const b = ctx.validar('pago', ctx.body);
    if (b.metodo === 'TARJETA' && !b.tarjeta) throw err(400, 'VALIDATION_ERROR', 'Falta el objeto tarjeta.', [{ name: 'tarjeta', reason: 'requerido para TARJETA' }]);
    if (b.metodo === 'TRANSFERENCIA' && !b.transferencia) throw err(400, 'VALIDATION_ERROR', 'Falta el objeto transferencia.', [{ name: 'transferencia', reason: 'requerido para TRANSFERENCIA' }]);
    if (b.metodo !== 'TARJETA' && b.tarjeta) throw err(400, 'VALIDATION_ERROR', 'tarjeta solo aplica al método TARJETA.', [{ name: 'tarjeta', reason: 'no permitido' }]);
    if (b.metodo !== 'TRANSFERENCIA' && b.transferencia) throw err(400, 'VALIDATION_ERROR', 'transferencia solo aplica al método TRANSFERENCIA.', [{ name: 'transferencia', reason: 'no permitido' }]);
    // 1) La orden: debe existir, estar CREADA, ser del usuario y coincidir el monto.
    if (ordenActivo()) {
      const o = await obtenerOrden(b.ord_id).catch((e) => { if (e.status === 404) throw err(422, 'ORDER_NOT_FOUND', 'La orden no existe.', [{ name: 'ord_id', reason: 'no existe' }]); throw e; });
      if (!a.roles.includes('ADMIN') && !a.interno && o.usu_id !== a.usu_id) throw err(403, 'FORBIDDEN', 'La orden no pertenece a este usuario.');
      if (o.est_codigo !== 'CREADA') throw conflicto(`La orden está ${o.est_codigo}; solo se pagan órdenes CREADA.`, 'ORDER_NOT_PAYABLE');
      if (cents(o.ord_total) !== cents(b.monto)) throw err(422, 'AMOUNT_MISMATCH', `El monto no coincide con el total de la orden (${o.ord_total.toFixed(2)} ${o.ord_moneda}).`, [{ name: 'monto', reason: `debe ser ${o.ord_total.toFixed(2)}` }]);
    } else if (!a.roles.includes('ADMIN') && !a.interno) throw err(403, 'FORBIDDEN', 'Sin integración con Order solo un administrador puede registrar pagos.');
    // 2) Reglas del método y decisión del simulador.
    let estado = 'PENDIENTE'; let rechazo = null; let det = null; let referencia = null; let autorizacion = null;
    if (b.metodo === 'TARJETA') {
      const t = b.tarjeta; const m = marca(t.numero);
      if (!luhn(t.numero)) throw err(422, 'INVALID_CARD', 'El número de tarjeta no es válido.', [{ name: 'tarjeta.numero', reason: 'no pasa la verificación (Luhn)' }]);
      if (!m) throw err(422, 'UNSUPPORTED_CARD', 'Solo se aceptan VISA, MASTERCARD y AMEX.', [{ name: 'tarjeta.numero', reason: 'marca no soportada' }]);
      const hoy = new Date(); if (t.anio < hoy.getUTCFullYear() || (t.anio === hoy.getUTCFullYear() && t.mes < hoy.getUTCMonth() + 1)) throw err(422, 'CARD_EXPIRED', 'La tarjeta está vencida.', [{ name: 'tarjeta.anio', reason: 'vencida' }]);
      if (m === 'AMEX' ? t.cvv.length !== 4 : t.cvv.length !== 3) throw err(422, 'INVALID_CARD', 'El CVV no corresponde a la marca.', [{ name: 'tarjeta.cvv', reason: m === 'AMEX' ? '4 dígitos' : '3 dígitos' }]);
      det = { pat_marca: m, pat_ultimos4: t.numero.slice(-4), pat_titular: t.titular.trim(), pat_mes: t.mes, pat_anio: t.anio, pat_pais: t.pais ?? 'EC' };
      referencia = `SIM-${crypto.randomBytes(6).toString('hex')}`;
      if (det.pat_ultimos4 === '0002') { estado = 'RECHAZADO'; rechazo = 'Fondos insuficientes (simulado)'; }
      else if (det.pat_ultimos4 === '0119') { estado = 'FALLIDO'; }
      else { estado = 'APROBADO'; autorizacion = String(crypto.randomInt(100000, 999999)); }
    }
    // 3) Registro (con candado por orden: evita dos pagos simultáneos de la misma orden).
    const { p, d } = await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(7770021, $1)', [b.ord_id % 2147483647]);
      const abierto = (await c.query(`SELECT e.est_codigo FROM pago p JOIN estado e ON e.est_id = p.est_id WHERE p.ord_id = $1 AND e.est_codigo IN ('PENDIENTE','APROBADO') LIMIT 1`, [b.ord_id])).rows[0];
      if (abierto) throw conflicto(abierto.est_codigo === 'APROBADO' ? 'La orden ya tiene un pago aprobado.' : 'La orden ya tiene un pago pendiente de confirmación.', abierto.est_codigo === 'APROBADO' ? 'ALREADY_PAID' : 'PAYMENT_IN_PROGRESS');
      const mpa = (await c.query('SELECT mpa_id FROM metodo_pago WHERE mpa_codigo = $1 AND mpa_activo', [b.metodo])).rows[0];
      const ins = (await c.query(`INSERT INTO pago (pag_numero, ord_id, mpa_id, est_id, pag_monto, pag_referencia, pag_autorizacion, pag_aprobado_en, pag_rechazado_en, pag_motivo_rechazo)
                                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING pag_id`,
        [numeroPago(), b.ord_id, mpa.mpa_id, await estadoId(c, estado), b.monto, referencia, autorizacion, estado === 'APROBADO' ? new Date() : null, estado === 'RECHAZADO' ? new Date() : null, rechazo])).rows[0];
      if (det) await c.query('INSERT INTO pago_tarjeta (pag_id, pat_marca, pat_ultimos4, pat_titular, pat_mes, pat_anio, pat_pais) VALUES ($1,$2,$3,$4,$5,$6,$7)', [ins.pag_id, det.pat_marca, det.pat_ultimos4, det.pat_titular, det.pat_mes, det.pat_anio, det.pat_pais]);
      if (b.transferencia) await c.query('INSERT INTO pago_transferencia (pag_id, ptr_banco, ptr_numero_comprobante, ptr_fecha_transferencia, ptr_archivo_adjunto) VALUES ($1,$2,$3,$4,$5)', [ins.pag_id, b.transferencia.banco, b.transferencia.numero_comprobante, b.transferencia.fecha_transferencia, b.transferencia.archivo_adjunto ?? null]);
      return { p: (await c.query(`${SEL} WHERE p.pag_id = $1`, [ins.pag_id])).rows[0], d: det };
    });
    // 4) Si quedó aprobado, la orden pasa a PAGADA. Si Order no responde, el pago queda aprobado y un conciliador reintenta (ver alIniciar).
    const ordenOk = estado === 'APROBADO' ? await avanzarOrden(p.ord_id, 'PAGADA') : null;
    publicar({ tipo: `PAGO_${estado}`, origen: 'payment', usu_id: a.usu_id, entidad: 'pago', entidad_id: String(p.pag_id), datos: { ord_id: p.ord_id, monto: p.pag_monto, metodo: b.metodo } });
    return responder(201, vista(p, { tarjeta: d ? { marca: d.pat_marca, ultimos4: d.pat_ultimos4, titular: d.pat_titular } : undefined, orden_actualizada: ordenOk }), { Location: `/v1/pagos/${p.pag_id}` });
  });

  r.get('/v1/pagos/:id', async (ctx) => {
    const p = await cargar(ctx.params.id); await permitirLectura(ctx, p);
    const t = (await db.q('SELECT pat_marca AS marca, pat_ultimos4 AS ultimos4, pat_titular AS titular, pat_mes AS mes, pat_anio AS anio FROM pago_tarjeta WHERE pag_id = $1', [p.pag_id])).rows[0];
    const tr = (await db.q('SELECT ptr_banco AS banco, ptr_numero_comprobante AS numero_comprobante, ptr_fecha_transferencia AS fecha_transferencia, ptr_archivo_adjunto AS archivo_adjunto FROM pago_transferencia WHERE pag_id = $1', [p.pag_id])).rows[0];
    let moneda; if (ordenActivo()) { try { moneda = (await obtenerOrden(p.ord_id)).ord_moneda; } catch { /* sin moneda */ } }
    return vista(p, { moneda, tarjeta: t, transferencia: tr });
  });
  r.get('/v1/ordenes/:ordId/pagos', async (ctx) => {
    if (!/^\d{1,18}$/.test(ctx.params.ordId)) throw err(400, 'BAD_ID', 'ordId numérico requerido.');
    const a = await autorizar(ctx, {});
    if (!a.roles.includes('ADMIN') && !a.interno) { if (!ordenActivo()) throw err(403, 'FORBIDDEN', 'Sin permiso.'); const o = await obtenerOrden(Number(ctx.params.ordId)).catch(() => null); if (!o || o.usu_id !== a.usu_id) throw err(403, 'FORBIDDEN', 'Sin permiso.'); }
    return { data: (await db.q(`${SEL} WHERE p.ord_id = $1 ORDER BY p.pag_id`, [ctx.params.ordId])).rows.map((x) => vista(x)) };
  });
  r.get('/v1/pagos', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q); const par = []; const w = [];
    if (q.estado) { par.push(q.estado); w.push(`e.est_codigo = $${par.length}`); } if (q.ord_id) { par.push(q.ord_id); w.push(`p.ord_id = $${par.length}`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const tot = (await db.q(`SELECT count(*) AS n FROM pago p JOIN estado e ON e.est_id = p.est_id ${where}`, par)).rows[0].n;
    return { data: (await db.q(`${SEL} ${where} ORDER BY p.pag_id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows.map((x) => vista(x)), metadata: meta(tot, p) };
  });

  // Pagos pendientes (transferencia / en sitio): los confirma o rechaza el personal.
  const resolver = async (ctx, aprobar) => {
    const a = await autorizar(ctx, { roles: ['ADMIN', 'OPERADOR'] }); const b = aprobar ? {} : ctx.validar('rechazo', ctx.body); const p = await cargar(ctx.params.id);
    if (!a.roles.includes('ADMIN') && !a.interno) {                              // el personal de operadores solo resuelve pagos EN_SITIO, y nunca los de sus propias órdenes
      if (p.mpa_codigo !== 'EN_SITIO') throw err(403, 'FORBIDDEN', 'Las transferencias solo las confirma un administrador.');
      const o = ordenActivo() ? await obtenerOrden(p.ord_id).catch(() => null) : null;
      if (!o || o.usu_id === a.usu_id) throw err(403, 'FORBIDDEN', 'No puede resolver un pago de su propia orden.');
    }
    const nuevo = await db.tx(async (c) => {
      const x = (await c.query('SELECT e.est_codigo FROM pago p JOIN estado e ON e.est_id = p.est_id WHERE p.pag_id = $1 FOR UPDATE OF p', [p.pag_id])).rows[0];
      if (x.est_codigo !== 'PENDIENTE') throw conflicto(`El pago está ${x.est_codigo}; solo se resuelven pagos PENDIENTE.`, 'PAYMENT_NOT_PENDING');
      await c.query('UPDATE pago SET est_id = $2, pag_aprobado_en = $3, pag_rechazado_en = $4, pag_motivo_rechazo = $5, pag_autorizacion = $6 WHERE pag_id = $1',
        [p.pag_id, await estadoId(c, aprobar ? 'APROBADO' : 'RECHAZADO'), aprobar ? new Date() : null, aprobar ? null : new Date(), aprobar ? null : (b.motivo ?? 'Rechazado por el personal'), aprobar ? String(crypto.randomInt(100000, 999999)) : null]);
      return (await c.query(`${SEL} WHERE p.pag_id = $1`, [p.pag_id])).rows[0];
    });
    const ordenOk = aprobar ? await avanzarOrden(nuevo.ord_id, 'PAGADA') : null;
    publicar({ tipo: aprobar ? 'PAGO_APROBADO' : 'PAGO_RECHAZADO', origen: 'payment', usu_id: a.usu_id, entidad: 'pago', entidad_id: String(nuevo.pag_id), datos: { ord_id: nuevo.ord_id, monto: nuevo.pag_monto } });
    return vista(nuevo, { orden_actualizada: ordenOk });
  };
  r.post('/v1/pagos/:id/confirmar', (ctx) => resolver(ctx, true));
  r.post('/v1/pagos/:id/rechazar', (ctx) => resolver(ctx, false));
  r.post('/internal/conciliar', async (ctx) => { exigirInterna(ctx); return { revisados: await conciliar(db) }; });
}

// Conciliador: si un pago quedó APROBADO pero Order no alcanzó a pasar a PAGADA (caída entre ambos), lo corrige. Idempotente y sin estado extra.
async function conciliar(db) {
  if (!ordenActivo()) return 0;
  const filas = (await db.q(`SELECT p.ord_id FROM pago p JOIN estado e ON e.est_id = p.est_id WHERE e.est_codigo = 'APROBADO' AND p.pag_aprobado_en > now() - interval '24 hours' ORDER BY p.pag_id DESC LIMIT 50`)).rows;
  for (const f of filas) {
    try { const o = await obtenerOrden(f.ord_id); if (o.est_codigo === 'CREADA') await cambiarEstadoOrden(f.ord_id, 'PAGADA'); } catch { /* Order caída: se reintenta en el próximo ciclo */ }
  }
  return filas.length;
}
let timer;
async function alIniciar(db) {
  clearInterval(timer); let corriendo = false;
  timer = setInterval(async () => { if (corriendo) return; corriendo = true; try { await conciliar(db); } catch { /* siguiente ciclo */ } finally { corriendo = false; } }, Number(process.env.MS_PAYMENT_RECONCILE_MS ?? 60000)); timer.unref();
}
export default { nombre: 'payment', marcador: 'pago', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas, alIniciar };
