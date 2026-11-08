// ms_cart — carrito de compras antes de generar la orden. Base propia: ms_cart.
// Referencias lógicas: usu_id → Identity, atr_id → Catalog, dis_id → Inventory (opcional).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado, regla } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar } from '../../_shared/auth.mjs';
import { obtener } from '../../_shared/llamadas.mjs';
import { cotizar } from '../../_shared/pricing-cliente.mjs';
import { publicar } from '../../_shared/eventos.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ITEMS = 50; const MAX_PERSONAS = 50;
const esquemas = {
  item: { type: 'object', additionalProperties: false, required: ['atr_id'], properties: { atr_id: { type: 'integer', minimum: 1 }, dis_id: { type: 'integer', minimum: 1 }, adultos: { type: 'integer', minimum: 1, maximum: MAX_PERSONAS }, ninos: { type: 'integer', minimum: 0, maximum: MAX_PERSONAS } } },
  cambio: { type: 'object', additionalProperties: false, minProperties: 1, properties: { adultos: { type: 'integer', minimum: 1, maximum: MAX_PERSONAS }, ninos: { type: 'integer', minimum: 0, maximum: MAX_PERSONAS } } },
  consulta: { type: 'object', properties: { precios: { type: 'boolean' } } },
};
const it = (x) => ({ cai_id: x.cai_id, atr_id: x.atr_id, dis_id: x.dis_id, adultos: x.cai_adultos, ninos: x.cai_ninos, creado_en: x.cai_creado_en });
const ID = (v, n) => { if (!/^\d{1,18}$/.test(v)) throw err(400, 'BAD_ID', `${n} debe ser numérico.`); return v; };

function crearRutas(r, { db }) {
  const asegurar = async (c, usuId) => {                              // el carrito activo se crea cuando hace falta; el índice único parcial evita duplicados
    for (let i = 0; i < 3; i++) {
      const x = (await c.query('SELECT * FROM carrito WHERE usu_id = $1 AND car_activo', [usuId])).rows[0]; if (x) return x;
      try { return (await c.query('INSERT INTO carrito (usu_id) VALUES ($1) RETURNING *', [usuId])).rows[0]; } catch (e) { if (e.code !== '23505') throw e; }
    }
    throw err(503, 'RETRY', 'No se pudo preparar el carrito; reintente.');
  };
  const armar = async (c, car, conPrecios) => {
    const items = (await c.query('SELECT * FROM carrito_item WHERE car_id = $1 ORDER BY cai_id', [car.car_id])).rows.map(it);
    const out = { car_id: car.car_id, usu_id: car.usu_id, activo: car.car_activo, items, total_items: items.length, actualizado_en: car.car_actualizado_en };
    if (conPrecios) {                                                   // consulta de precios a Pricing (gRPC); si Pricing no responde, el carrito se entrega igual con precios_disponibles:false
      let total = 0; let moneda = 'USD'; let completo = true;
      for (const i of out.items) {
        try { const q = await cotizar({ atr_id: i.atr_id, adultos: i.adultos, ninos: i.ninos }); i.precio = { subtotal: q.subtotal, moneda: q.moneda, lineas: q.lineas }; total += q.subtotal; moneda = q.moneda; }
        catch (e) { i.precio = null; i.precio_error = e.code ?? 'PRICING_ERROR'; completo = false; }
      }
      out.precios_disponibles = completo; out.subtotal = Math.round(total * 100) / 100; out.moneda = moneda;
    }
    return out;
  };

  r.get('/v1/usuarios/:usuId/carrito', async (ctx) => {
    await autorizar(ctx, { propietario: 'usuId' }); ID(ctx.params.usuId, 'usuId'); const q = ctx.validarQ('consulta', { ...ctx.query });
    const c = { query: db.q }; const car = await asegurar(c, ctx.params.usuId); return armar(c, car, q.precios === true);
  });
  r.post('/v1/usuarios/:usuId/carrito/items', async (ctx) => {
    const a = await autorizar(ctx, { propietario: 'usuId' }); ID(ctx.params.usuId, 'usuId'); const b = ctx.validar('item', ctx.body);
    const atr = await obtener('catalog', `/v1/atracciones/${b.atr_id}`);
    if (!atr) throw err(422, 'ATTRACTION_NOT_FOUND', 'La atracción no existe o no está publicada.', [{ name: 'atr_id', reason: 'no existe' }]);
    const adultos = b.adultos ?? 1; const ninos = b.ninos ?? 0;
    const { item, nuevo } = await db.tx(async (c) => {
      const car = await asegurar(c, ctx.params.usuId);
      await c.query('SELECT car_id FROM carrito WHERE car_id = $1 FOR UPDATE', [car.car_id]);                       // serializa los cambios del mismo carrito
      const ya = (await c.query('SELECT * FROM carrito_item WHERE car_id = $1 AND atr_id = $2 AND dis_id IS NOT DISTINCT FROM $3', [car.car_id, b.atr_id, b.dis_id ?? null])).rows[0];
      if (ya) {                                                                                                     // misma atracción y turno: se suman las personas
        if (ya.cai_adultos + adultos > MAX_PERSONAS || ya.cai_ninos + ninos > MAX_PERSONAS) throw regla(`Máximo ${MAX_PERSONAS} adultos y ${MAX_PERSONAS} niños por línea.`, 'TOO_MANY_PEOPLE');
        return { item: (await c.query('UPDATE carrito_item SET cai_adultos = cai_adultos + $2, cai_ninos = cai_ninos + $3 WHERE cai_id = $1 RETURNING *', [ya.cai_id, adultos, ninos])).rows[0], nuevo: false };
      }
      const n = (await c.query('SELECT count(*)::int AS n FROM carrito_item WHERE car_id = $1', [car.car_id])).rows[0].n; if (n >= MAX_ITEMS) throw regla(`El carrito admite hasta ${MAX_ITEMS} líneas.`, 'CART_FULL');
      const x = (await c.query('INSERT INTO carrito_item (car_id, atr_id, dis_id, cai_adultos, cai_ninos) VALUES ($1,$2,$3,$4,$5) RETURNING *', [car.car_id, b.atr_id, b.dis_id ?? null, adultos, ninos])).rows[0];
      await c.query('UPDATE carrito SET car_activo = car_activo WHERE car_id = $1', [car.car_id]);                   // dispara trg_carrito_actualizado
      return { item: x, nuevo: true };
    });
    publicar({ tipo: 'CARRITO_ITEM_AGREGADO', origen: 'cart', usu_id: a.usu_id ?? Number(ctx.params.usuId), entidad: 'carrito_item', entidad_id: String(item.cai_id) });
    return responder(nuevo ? 201 : 200, it(item));
  });
  r.patch('/v1/usuarios/:usuId/carrito/items/:caiId', async (ctx) => {
    await autorizar(ctx, { propietario: 'usuId' }); ID(ctx.params.usuId, 'usuId'); ID(ctx.params.caiId, 'caiId'); const b = ctx.validar('cambio', ctx.body);
    const x = (await db.q(`UPDATE carrito_item i SET cai_adultos = COALESCE($3, i.cai_adultos), cai_ninos = COALESCE($4, i.cai_ninos) FROM carrito c
                           WHERE i.cai_id = $1 AND i.car_id = c.car_id AND c.usu_id = $2 AND c.car_activo RETURNING i.*`, [ctx.params.caiId, ctx.params.usuId, b.adultos ?? null, b.ninos ?? null])).rows[0];
    if (!x) throw noEncontrado('La línea del carrito'); return it(x);
  });
  r.delete('/v1/usuarios/:usuId/carrito/items/:caiId', async (ctx) => {
    await autorizar(ctx, { propietario: 'usuId' }); ID(ctx.params.usuId, 'usuId'); ID(ctx.params.caiId, 'caiId');
    const x = await db.q('DELETE FROM carrito_item i USING carrito c WHERE i.cai_id = $1 AND i.car_id = c.car_id AND c.usu_id = $2 AND c.car_activo', [ctx.params.caiId, ctx.params.usuId]);
    if (!x.rowCount) throw noEncontrado('La línea del carrito'); return responder(204, undefined);
  });
  r.delete('/v1/usuarios/:usuId/carrito/items', async (ctx) => {            // vaciar
    await autorizar(ctx, { propietario: 'usuId' }); ID(ctx.params.usuId, 'usuId');
    await db.q('DELETE FROM carrito_item WHERE car_id IN (SELECT car_id FROM carrito WHERE usu_id = $1 AND car_activo)', [ctx.params.usuId]); return responder(204, undefined);
  });
  // Cierra el carrito activo (lo usa Order al generar la orden). El siguiente GET crea uno nuevo.
  r.post('/v1/usuarios/:usuId/carrito/cerrar', async (ctx) => {
    await autorizar(ctx, { propietario: 'usuId' }); ID(ctx.params.usuId, 'usuId');
    const x = (await db.q('UPDATE carrito SET car_activo = FALSE WHERE usu_id = $1 AND car_activo RETURNING car_id', [ctx.params.usuId])).rows[0]; if (!x) throw noEncontrado('El carrito activo');
    return { car_id: x.car_id, cerrado: true };
  });
}
export default { nombre: 'cart', marcador: 'carrito', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
