// ms_billing_profile — datos de facturación del cliente (pueden ser distintos en cada compra). Base propia: ms_billing_profile.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar } from '../../_shared/auth.mjs';
import { publicar } from '../../_shared/eventos.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const props = {
  tipo_identificacion: { type: 'string', enum: ['CEDULA', 'RUC', 'PASAPORTE', 'CONSUMIDOR_FINAL'] },
  identificacion: { type: 'string', minLength: 1, maxLength: 20 },
  razon_social: { type: 'string', minLength: 1, maxLength: 150, pattern: '\\S' },
  correo: { type: 'string', format: 'email', maxLength: 160 },
  telefono: { type: 'string', pattern: '^\\+?[0-9]{7,15}$' },
  es_principal: { type: 'boolean' },
};
const esquemas = {
  crear: { type: 'object', additionalProperties: false, required: ['identificacion', 'razon_social', 'correo'], properties: props },
  cambiar: { type: 'object', additionalProperties: false, minProperties: 1, properties: props },
};
const fila = (x) => ({ dfa_id: x.dfa_id, usu_id: x.usu_id, tipo_identificacion: x.dfa_tipo_identificacion, identificacion: x.dfa_identificacion, razon_social: x.dfa_razon_social, correo: x.dfa_correo, telefono: x.dfa_telefono, es_principal: x.dfa_es_principal, activo: x.dfa_activo, creado_en: x.dfa_creado_en });
// El script exige formatos según el tipo (cédula 10 dígitos, RUC 13, etc.): se valida antes de ir a la base para dar un mensaje claro.
function validarIdentificacion(tipo, id) {
  const reglas = { CEDULA: /^[0-9]{10}$/, RUC: /^[0-9]{13}$/, PASAPORTE: /^[A-Z0-9]{6,20}$/, CONSUMIDOR_FINAL: /^9999999999999$/ };
  if (!reglas[tipo].test(id)) throw err(400, 'VALIDATION_ERROR', 'La identificación no corresponde al tipo indicado.', [{ name: 'identificacion', reason: `no cumple el formato de ${tipo}` }]);
}
const idNum = (v, n) => { if (!/^\d{1,18}$/.test(v)) throw err(400, 'BAD_ID', `${n} debe ser numérico.`); return v; };

function crearRutas(r, { db }) {
  r.get('/v1/usuarios/:usuId/datos-facturacion', async (ctx) => {
    await autorizar(ctx, { propietario: 'usuId' }); idNum(ctx.params.usuId, 'usuId');
    return { data: (await db.q('SELECT * FROM dato_facturacion WHERE usu_id = $1 AND dfa_activo ORDER BY dfa_es_principal DESC, dfa_id', [ctx.params.usuId])).rows.map(fila) };
  });
  r.post('/v1/usuarios/:usuId/datos-facturacion', async (ctx) => {
    await autorizar(ctx, { propietario: 'usuId' }); idNum(ctx.params.usuId, 'usuId');
    const b = ctx.validar('crear', ctx.body); const tipo = b.tipo_identificacion ?? 'CEDULA'; validarIdentificacion(tipo, b.identificacion);
    const x = await db.tx(async (c) => {
      const hay = (await c.query('SELECT 1 FROM dato_facturacion WHERE usu_id = $1 AND dfa_activo AND dfa_es_principal', [ctx.params.usuId])).rows[0];
      const principal = b.es_principal ?? !hay;                                  // el primero queda como principal
      if (principal) await c.query('UPDATE dato_facturacion SET dfa_es_principal = FALSE WHERE usu_id = $1 AND dfa_es_principal', [ctx.params.usuId]);
      return (await c.query(`INSERT INTO dato_facturacion (usu_id, dfa_tipo_identificacion, dfa_identificacion, dfa_razon_social, dfa_correo, dfa_telefono, dfa_es_principal)
                             VALUES ($1,$2,$3,btrim($4),$5,$6,$7) RETURNING *`, [ctx.params.usuId, tipo, b.identificacion, b.razon_social, b.correo, b.telefono ?? null, principal])).rows[0];
    });
    publicar({ tipo: 'DATOS_FACTURACION_CREADOS', origen: 'billing_profile', usu_id: x.usu_id, entidad: 'dato_facturacion', entidad_id: String(x.dfa_id) });
    return responder(201, fila(x), { Location: `/v1/datos-facturacion/${x.dfa_id}` });
  });
  // Lectura por id: la usan Order e Invoicing (llamada interna) y su dueño.
  r.get('/v1/datos-facturacion/:id', async (ctx) => {
    idNum(ctx.params.id, 'id');
    const x = (await db.q('SELECT * FROM dato_facturacion WHERE dfa_id = $1 AND dfa_activo', [ctx.params.id])).rows[0]; if (!x) throw noEncontrado('El dato de facturación');
    ctx.params.dueno = x.usu_id; await autorizar(ctx, { propietario: 'dueno' });
    return fila(x);
  });
  r.patch('/v1/datos-facturacion/:id', async (ctx) => {
    idNum(ctx.params.id, 'id');
    const act = (await db.q('SELECT * FROM dato_facturacion WHERE dfa_id = $1 AND dfa_activo', [ctx.params.id])).rows[0]; if (!act) throw noEncontrado('El dato de facturación');
    ctx.params.dueno = act.usu_id; await autorizar(ctx, { propietario: 'dueno' });
    const b = ctx.validar('cambiar', ctx.body);
    const tipo = b.tipo_identificacion ?? act.dfa_tipo_identificacion; validarIdentificacion(tipo, b.identificacion ?? act.dfa_identificacion);
    const x = await db.tx(async (c) => {
      if (b.es_principal) await c.query('UPDATE dato_facturacion SET dfa_es_principal = FALSE WHERE usu_id = $1 AND dfa_es_principal AND dfa_id <> $2', [act.usu_id, act.dfa_id]);
      return (await c.query(`UPDATE dato_facturacion SET dfa_tipo_identificacion = $2, dfa_identificacion = $3, dfa_razon_social = $4, dfa_correo = $5, dfa_telefono = $6, dfa_es_principal = $7 WHERE dfa_id = $1 RETURNING *`,
        [act.dfa_id, tipo, b.identificacion ?? act.dfa_identificacion, b.razon_social ?? act.dfa_razon_social, b.correo ?? act.dfa_correo, b.telefono ?? act.dfa_telefono, b.es_principal ?? act.dfa_es_principal])).rows[0];
    });
    return fila(x);
  });
  r.delete('/v1/datos-facturacion/:id', async (ctx) => {            // borrado lógico (las facturas ya emitidas guardan su propia copia)
    idNum(ctx.params.id, 'id');
    const act = (await db.q('SELECT usu_id FROM dato_facturacion WHERE dfa_id = $1 AND dfa_activo', [ctx.params.id])).rows[0]; if (!act) throw noEncontrado('El dato de facturación');
    ctx.params.dueno = act.usu_id; await autorizar(ctx, { propietario: 'dueno' });
    await db.q('UPDATE dato_facturacion SET dfa_activo = FALSE, dfa_es_principal = FALSE WHERE dfa_id = $1', [ctx.params.id]);
    return responder(204, undefined);
  });
}
export default { nombre: 'billing_profile', marcador: 'dato_facturacion', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
