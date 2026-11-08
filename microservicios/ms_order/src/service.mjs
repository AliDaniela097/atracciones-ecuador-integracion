// Lógica de ms_order: órdenes, líneas, cupones aplicados e idempotencia (evita órdenes/cobros dobles).
import { createHash, randomInt } from 'node:crypto';
import { q, tx, paginar, meta, iso } from './lib/db.mjs';
import { fail, S } from './lib/errors.mjs';

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const aleatorio = (n) => Array.from({ length: n }, () => ALFABETO[randomInt(ALFABETO.length)]).join('');
const numeroOrden = () => `ORD-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${aleatorio(6)}`;   // ORD-261027-K3F9QZ (≤ 20 caracteres)
const cents = (x) => Math.round(x * 100);
const dinero = (c) => (c / 100).toFixed(2);
const TRANSICIONES = { CREADA: ['PAGADA', 'CANCELADA'], PAGADA: ['REEMBOLSADA'] };

function canonico(o) {                                  // JSON con claves ordenadas, para el hash de idempotencia
  if (Array.isArray(o)) return o.map(canonico);
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonico(o[k])]));
  return o;
}

async function cargar(c, where, params) {
  const r = await c.query(`SELECT o.*, e.est_codigo FROM orden o JOIN estado e ON e.est_id = o.est_id WHERE ${where}`, params);
  const o = r.rows[0]; if (!o) return null;
  const det = (await c.query('SELECT * FROM orden_detalle WHERE ord_id = $1 ORDER BY det_id', [o.ord_id])).rows;
  const cup = (await c.query('SELECT cup_id FROM orden_cupon WHERE ord_id = $1 ORDER BY cup_id', [o.ord_id])).rows;
  return {
    ord_id: o.ord_id, ord_numero: o.ord_numero, usu_id: o.usu_id, car_id: o.car_id ?? 0, est_codigo: o.est_codigo, mpa_id: o.mpa_id ?? 0,
    ord_fecha: iso(o.ord_fecha), ord_subtotal: o.ord_subtotal, ord_descuento: o.ord_descuento, ord_iva: o.ord_iva, ord_total: o.ord_total,
    ord_moneda: o.ord_moneda, ord_observaciones: o.ord_observaciones ?? '',
    detalles: det.map((d) => ({ det_id: d.det_id, atr_id: d.atr_id, det_descripcion: d.det_descripcion, det_cantidad: d.det_cantidad, det_precio_unitario: d.det_precio_unitario, det_subtotal: d.det_subtotal })),
    cup_ids: cup.map((x) => x.cup_id), idempotent_replay: false,
  };
}
const noEncontrada = (x) => fail(S.NOT_FOUND, 'ORDER_NOT_FOUND', `No existe la orden ${x}.`);

export function crearServicio(v) {
  return {
    async CreateOrder(req) {
      const d = v.validar('CreateOrderRequest', req);
      const subC = d.items.reduce((s, i) => s + i.det_cantidad * cents(i.det_precio_unitario), 0);
      const desC = cents(d.ord_descuento ?? 0); const ivaC = cents(d.ord_iva ?? 0);
      if (desC > subC) throw fail(S.INVALID_ARGUMENT, 'DISCOUNT_EXCEEDS_SUBTOTAL', 'El descuento no puede superar el subtotal.', [{ name: 'ord_descuento', reason: `Mayor al subtotal (${dinero(subC)})` }]);
      const totC = subC - desC + ivaC;

      return tx(async (c) => {
        let hash;
        if (d.idempotency_key) {
          const { idempotency_key, ...resto } = d;
          hash = createHash('sha256').update(JSON.stringify(canonico(resto))).digest('hex');
          await c.query('DELETE FROM idempotencia WHERE idem_clave = $1 AND idem_sujeto = $2 AND idem_expira_en < now()', [idempotency_key, d.usu_id]);
          const ins = await c.query(
            `INSERT INTO idempotencia (idem_clave, idem_sujeto, idem_operacion, idem_request_hash, idem_expira_en)
             VALUES ($1, $2, 'CreateOrder', $3, now() + interval '24 hours') ON CONFLICT DO NOTHING RETURNING idem_clave`, [idempotency_key, d.usu_id, hash]);
          if (!ins.rowCount) {
            const e = (await c.query('SELECT * FROM idempotencia WHERE idem_clave = $1 AND idem_sujeto = $2', [idempotency_key, d.usu_id])).rows[0];
            if (e.idem_request_hash !== hash) throw fail(S.ALREADY_EXISTS, 'IDEMPOTENCY_KEY_REUSED', 'La misma idempotency_key se usó con un cuerpo distinto.');
            if (e.idem_estado === 'DONE') return { ...e.idem_response, idempotent_replay: true };
            throw fail(S.ABORTED, 'IDEMPOTENCY_IN_PROGRESS', 'Hay otra petición con la misma clave en curso.');
          }
        }
        let ordId;
        for (let i = 0; i < 5 && !ordId; i++) {
          try {
            const r = await c.query(
              `INSERT INTO orden (ord_numero, usu_id, car_id, est_id, mpa_id, ord_subtotal, ord_descuento, ord_iva, ord_total, ord_moneda, ord_observaciones)
               VALUES ($1, $2, $3, (SELECT est_id FROM estado WHERE est_codigo = 'CREADA'), $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (ord_numero) DO NOTHING RETURNING ord_id`,
              [numeroOrden(), d.usu_id, d.car_id ?? null, d.mpa_id ?? null, dinero(subC), dinero(desC), dinero(ivaC), dinero(totC), d.ord_moneda ?? 'USD', d.ord_observaciones ?? null]);
            ordId = r.rows[0]?.ord_id;
          } catch (e) {
            if (e.constraint === 'uq_orden_car_id') throw fail(S.ALREADY_EXISTS, 'CART_ALREADY_CONVERTED', `El carrito ${d.car_id} ya se convirtió en una orden.`);
            throw e;
          }
        }
        if (!ordId) throw fail(S.INTERNAL, 'ORDER_NUMBER_COLLISION', 'No se pudo generar un número de orden único.');
        for (const i of d.items)
          await c.query('INSERT INTO orden_detalle (ord_id, atr_id, det_descripcion, det_cantidad, det_precio_unitario, det_subtotal) VALUES ($1,$2,$3,$4,$5,$6)',
            [ordId, i.atr_id, i.det_descripcion, i.det_cantidad, dinero(cents(i.det_precio_unitario)), dinero(i.det_cantidad * cents(i.det_precio_unitario))]);
        for (const cup of d.cup_ids ?? []) await c.query('INSERT INTO orden_cupon (ord_id, cup_id) VALUES ($1, $2)', [ordId, cup]);
        const orden = await cargar(c, 'o.ord_id = $1', [ordId]);
        if (d.idempotency_key) await c.query("UPDATE idempotencia SET idem_estado = 'DONE', idem_response = $3 WHERE idem_clave = $1 AND idem_sujeto = $2", [d.idempotency_key, d.usu_id, JSON.stringify(orden)]);
        return orden;
      });
    },

    async GetOrder(req) {
      const d = v.validar('GetOrderRequest', req);
      const o = d.ord_id ? await cargar({ query: q }, 'o.ord_id = $1', [d.ord_id]) : await cargar({ query: q }, 'o.ord_numero = $1', [d.ord_numero]);
      if (!o) throw noEncontrada(d.ord_id ?? d.ord_numero);
      return o;
    },

    async ListOrders(req) {
      const d = v.validar('ListOrdersRequest', req); const p = paginar(d);
      const w = ['TRUE']; const prm = [];
      if (d.usu_id) { prm.push(d.usu_id); w.push(`o.usu_id = $${prm.length}`); }
      if (d.est_codigo) { prm.push(d.est_codigo); w.push(`e.est_codigo = $${prm.length}`); }
      const base = `FROM orden o JOIN estado e ON e.est_id = o.est_id WHERE ${w.join(' AND ')}`;
      const total = (await q(`SELECT count(*)::int AS n ${base}`, prm)).rows[0].n;
      const ids = (await q(`SELECT o.ord_id ${base} ORDER BY o.ord_fecha DESC, o.ord_id DESC LIMIT $${prm.length + 1} OFFSET $${prm.length + 2}`, [...prm, p.limit, p.offset])).rows;
      const data = []; for (const r of ids) data.push(await cargar({ query: q }, 'o.ord_id = $1', [r.ord_id]));
      return { data, metadata: meta(total, p) };
    },

    async UpdateOrderStatus(req) {
      const d = v.validar('UpdateOrderStatusRequest', req);
      return tx(async (c) => {
        const r = await c.query('SELECT o.ord_id, e.est_codigo FROM orden o JOIN estado e ON e.est_id = o.est_id WHERE o.ord_id = $1 FOR UPDATE OF o', [d.ord_id]);
        if (!r.rows[0]) throw noEncontrada(d.ord_id);
        const desde = r.rows[0].est_codigo;
        if (!(TRANSICIONES[desde] ?? []).includes(d.est_codigo))
          throw fail(S.FAILED_PRECONDITION, 'INVALID_TRANSITION', `No se puede pasar de ${desde} a ${d.est_codigo}.`);
        await c.query('UPDATE orden SET est_id = (SELECT est_id FROM estado WHERE est_codigo = $2) WHERE ord_id = $1', [d.ord_id, d.est_codigo]);
        return cargar(c, 'o.ord_id = $1', [d.ord_id]);
      });
    },
  };
}
