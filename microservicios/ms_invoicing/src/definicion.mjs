// ms_invoicing (SOAP 1.1) — facturas electrónicas. Base propia: ms_invoicing.
// IMPORTANTE: la autorización del SRI es SIMULADA (ambiente PRUEBAS): la clave de acceso se calcula con el algoritmo real (49 dígitos, módulo 11),
// pero la factura NO se envía al SRI ni tiene validez tributaria. Ver README, "Qué es simulado".
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { err, HttpError } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar } from '../../_shared/auth.mjs';
import { obtener } from '../../_shared/llamadas.mjs';
import { publicar } from '../../_shared/eventos.mjs';
import { NS, wsdl } from './wsdl.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const IVA = Number(process.env.INVOICE_IVA_PCT ?? 15);                           // IVA vigente en Ecuador (15 % desde 2024); configurable
const EMISOR_RUC = process.env.INVOICE_EMISOR_RUC ?? '9999999999001';            // RUC de PRUEBA del emisor: reemplazar al operar de verdad
const SERIE = '001001'; const AMBIENTE = '1';                                     // 1 = pruebas
const CF_MAX = Number(process.env.INVOICE_FINAL_CONSUMER_MAX ?? 50);             // tope para consumidor final (verificar vigencia con el SRI)
const cents = (x) => Math.round(x * 100); const dinero = (c) => c / 100;

const esquemas = {
  cliente: { type: 'object', additionalProperties: false, required: ['tipo_identificacion', 'identificacion', 'razon_social', 'correo'], properties: {
    tipo_identificacion: { type: 'string', enum: ['CEDULA', 'RUC', 'PASAPORTE', 'CONSUMIDOR_FINAL'] }, identificacion: { type: 'string', minLength: 1, maxLength: 20 }, razon_social: { type: 'string', minLength: 1, maxLength: 150, pattern: '\\S' },
    correo: { type: 'string', format: 'email', maxLength: 160 }, telefono: { type: 'string', pattern: '^\\+?[0-9]{7,15}$' } } },
  EmitirFacturaRequest: { type: 'object', additionalProperties: false, required: ['ord_id', 'detalles'], properties: {
    ord_id: { type: 'integer', minimum: 1 }, dfa_id: { type: 'integer', minimum: 1 }, cliente: { $ref: '#/properties/__cliente' },
    detalles: { type: 'object', additionalProperties: false, required: ['detalle'], properties: { detalle: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false,
      required: ['det_id', 'codigo', 'descripcion', 'cantidad', 'precio_unitario'], properties: { det_id: { type: 'integer', minimum: 1 }, codigo: { type: 'string', minLength: 1, maxLength: 25 }, descripcion: { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S' },
        cantidad: { type: 'integer', minimum: 1, maximum: 10000 }, precio_unitario: { type: 'number', minimum: 0, multipleOf: 0.01 }, descuento: { type: 'number', minimum: 0, multipleOf: 0.01 } } } } } } } },
  ConsultarFacturaRequest: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1, properties: { fac_id: { type: 'integer', minimum: 1 }, ord_id: { type: 'integer', minimum: 1 }, numero: { type: 'string', pattern: '^[0-9]{3}-[0-9]{3}-[0-9]{9}$' } } },
  ListarFacturasRequest: { type: 'object', additionalProperties: false, properties: { estado: { type: 'string', enum: ['NO_PAGADA', 'PAGADA', 'ANULADA'] }, desde: { type: 'string', format: 'date' }, hasta: { type: 'string', format: 'date' }, page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
  MarcarFacturaPagadaRequest: { type: 'object', additionalProperties: false, required: ['fac_id'], properties: { fac_id: { type: 'integer', minimum: 1 } } },
  AnularFacturaRequest: { type: 'object', additionalProperties: false, required: ['fac_id'], properties: { fac_id: { type: 'integer', minimum: 1 }, motivo: { type: 'string', maxLength: 300 } } },
};
esquemas.EmitirFacturaRequest.properties.cliente = esquemas.cliente; delete esquemas.EmitirFacturaRequest.properties.__cliente;

// ---------- XML ----------
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: false, isArray: (n) => n === 'detalle' });
// processEntities=false deja las entidades sin convertir; como se rechaza todo DOCTYPE, solo pueden venir las 5 predefinidas de XML: se decodifican aquí.
const ENT = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const decodificar = (o) => (typeof o === 'string' ? o.replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENT[m]) : Array.isArray(o) ? o.map(decodificar) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, decodificar(v)])) : o);
const esc = (v) => String(v ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const el = (n, v) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.map((x) => el(n, x)).join('') : typeof v === 'object' && !(v instanceof Date) ? `<inv:${n}>${Object.entries(v).map(([k, x]) => el(k, x)).join('')}</inv:${n}>` : `<inv:${n}>${esc(v instanceof Date ? v.toISOString() : v)}</inv:${n}>`);
const sobre = (cuerpo) => `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:inv="${NS}"><soap:Body>${cuerpo}</soap:Body></soap:Envelope>`;
const fault = (he) => sobre(`<soap:Fault><faultcode>${he.status >= 500 ? 'soap:Server' : 'soap:Client'}</faultcode><faultstring>${esc(he.message)}</faultstring><detail><inv:error><inv:code>${esc(he.code)}</inv:code>${(he.invalid_params ?? []).map((p) => `<inv:param><inv:name>${esc(p.name)}</inv:name><inv:reason>${esc(p.reason)}</inv:reason></inv:param>`).join('')}</inv:error></detail></soap:Fault>`);
const XML = { 'Content-Type': 'text/xml; charset=utf-8' };

// ---------- clave de acceso SRI ----------
function claveAcceso(fechaDDMMYYYY, secuencial) {
  const cod = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
  const base = `${fechaDDMMYYYY}01${EMISOR_RUC}${AMBIENTE}${SERIE}${String(secuencial).padStart(9, '0')}${cod}1`;     // 48 dígitos
  let suma = 0; let peso = 2; for (let i = base.length - 1; i >= 0; i--) { suma += Number(base[i]) * peso; peso = peso === 7 ? 2 : peso + 1; }
  const dv = 11 - (suma % 11); return base + String(dv === 11 ? 0 : dv === 10 ? 1 : dv);
}

function crearRutas(r, { db }) {
  const fecha = async () => (await db.q(`SELECT to_char(now() AT TIME ZONE 'America/Guayaquil', 'DDMMYYYY') AS f`)).rows[0].f;
  const estadoId = async (c, cod) => (await c.query('SELECT est_id FROM estado WHERE est_codigo = $1', [cod])).rows[0].est_id;
  async function cargar(c, donde, par) {
    const f = (await c.query(`SELECT f.*, e.est_codigo, e.est_final FROM factura f JOIN estado e ON e.est_id = f.est_id WHERE ${donde}`, par)).rows[0]; if (!f) return null;
    const d = (await c.query('SELECT * FROM factura_detalle WHERE fac_id = $1 ORDER BY fde_id', [f.fac_id])).rows;
    return { fac_id: f.fac_id, ord_id: f.ord_id, numero: f.fac_numero, clave_acceso: f.fac_clave_acceso, autorizacion_sri: f.fac_autorizacion_sri, ambiente: 'PRUEBAS (simulado)', estado: f.est_codigo, _final: f.est_final, emitida_en: f.fac_emitida_en,
      cliente: { tipo_identificacion: f.fac_tipo_identificacion, identificacion: f.fac_identificacion, razon_social: f.fac_razon_social, correo: f.fac_correo, telefono: f.fac_telefono ?? undefined },
      subtotal: f.fac_subtotal, descuento: f.fac_descuento, iva: f.fac_iva, total: f.fac_total,
      detalles: { detalle: d.map((x) => ({ det_id: x.det_id, codigo: x.fde_codigo, descripcion: x.fde_descripcion, cantidad: x.fde_cantidad, precio_unitario: x.fde_precio_unitario, descuento: x.fde_descuento, subtotal: x.fde_subtotal, iva_porcentaje: x.fde_iva_porcentaje, iva: x.fde_iva, total: x.fde_total })) } };
  }
  const salida = (f) => { const { _final, ...pub } = f; return pub; };
  const noHay = () => err(404, 'INVOICE_NOT_FOUND', 'La factura no existe.');

  const operaciones = {
    async EmitirFactura(ctx, d) {
      let cliente = d.cliente;
      if (d.dfa_id) {                                                                                    // datos de facturación guardados por el cliente (ms_billing_profile)
        const p = await obtener('billing_profile', `/v1/datos-facturacion/${d.dfa_id}`); if (!p) throw err(422, 'BILLING_PROFILE_NOT_FOUND', 'El dato de facturación no existe.', [{ name: 'dfa_id', reason: 'no existe' }]);
        cliente = { tipo_identificacion: p.tipo_identificacion, identificacion: p.identificacion, razon_social: p.razon_social, correo: p.correo, telefono: p.telefono ?? undefined };
      }
      if (!cliente) throw err(400, 'VALIDATION_ERROR', 'Indique dfa_id o los datos del cliente.', [{ name: 'cliente', reason: 'requerido si no hay dfa_id' }]);
      if (cliente.tipo_identificacion === 'CONSUMIDOR_FINAL' && cliente.identificacion !== '9999999999999') throw err(400, 'VALIDATION_ERROR', 'Consumidor final usa la identificación 9999999999999.', [{ name: 'cliente.identificacion', reason: 'debe ser 9999999999999' }]);
      const ids = new Set();
      const lineas = d.detalles.detalle.map((x, i) => {
        if (ids.has(x.det_id)) throw err(400, 'VALIDATION_ERROR', 'det_id repetido.', [{ name: `detalles.detalle.${i}.det_id`, reason: 'repetido' }]); ids.add(x.det_id);
        const bruto = x.cantidad * cents(x.precio_unitario); const desc = cents(x.descuento ?? 0);
        if (desc > bruto) throw err(422, 'DISCOUNT_EXCEEDS_LINE', 'El descuento de una línea supera su valor.', [{ name: `detalles.detalle.${i}.descuento`, reason: `máximo ${dinero(bruto)}` }]);
        const sub = bruto - desc; const iva = Math.round((sub * IVA) / 100);
        return { ...x, bruto, desc, sub, iva, tot: sub + iva };
      });
      const sBruto = lineas.reduce((s, l) => s + l.bruto, 0); const sDesc = lineas.reduce((s, l) => s + l.desc, 0); const sIva = lineas.reduce((s, l) => s + l.iva, 0); const total = sBruto - sDesc + sIva;
      if (cliente.tipo_identificacion === 'CONSUMIDOR_FINAL' && total > cents(CF_MAX)) throw err(422, 'FINAL_CONSUMER_LIMIT', `A consumidor final solo se factura hasta ${CF_MAX.toFixed(2)}; indique los datos del cliente.`, [{ name: 'cliente', reason: 'total supera el tope de consumidor final' }]);
      const f0 = await fecha();
      const { fac_id, repetida } = await db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(7770041)');                                         // numeración sin saltos ni repetidos
        const ya = (await c.query('SELECT fac_id FROM factura WHERE ord_id = $1', [d.ord_id])).rows[0]; if (ya) return { fac_id: ya.fac_id, repetida: true };   // idempotente por orden
        const sec = (await c.query(`SELECT COALESCE(max(substring(fac_numero from 9)::int), 0) + 1 AS n FROM factura`)).rows[0].n;
        const clave = claveAcceso(f0, sec);
        const ins = (await c.query(`INSERT INTO factura (ord_id, dfa_id, fac_numero, fac_clave_acceso, fac_autorizacion_sri, est_id, fac_subtotal, fac_descuento, fac_iva, fac_total,
                                    fac_tipo_identificacion, fac_identificacion, fac_razon_social, fac_correo, fac_telefono) VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,btrim($12),$13,$14) RETURNING fac_id`,
          [d.ord_id, d.dfa_id ?? null, `001-001-${String(sec).padStart(9, '0')}`, clave, await estadoId(c, 'NO_PAGADA'), dinero(sBruto), dinero(sDesc), dinero(sIva), dinero(total),
            cliente.tipo_identificacion, cliente.identificacion, cliente.razon_social, cliente.correo, cliente.telefono ?? null])).rows[0];
        for (const l of lineas) await c.query(`INSERT INTO factura_detalle (fac_id, det_id, fde_codigo, fde_descripcion, fde_cantidad, fde_precio_unitario, fde_descuento, fde_subtotal, fde_iva_porcentaje, fde_iva, fde_total)
                                               VALUES ($1,$2,$3,btrim($4),$5,$6,$7,$8,$9,$10,$11)`, [ins.fac_id, l.det_id, l.codigo, l.descripcion, l.cantidad, l.precio_unitario, dinero(l.desc), dinero(l.sub), IVA, dinero(l.iva), dinero(l.tot)]);
        return { fac_id: ins.fac_id, repetida: false };
      });
      if (!repetida) publicar({ tipo: 'FACTURA_EMITIDA', origen: 'invoicing', entidad: 'factura', entidad_id: String(fac_id), datos: { ord_id: d.ord_id, total: dinero(total) } });
      return { tag: 'EmitirFacturaResponse', cuerpo: { factura: salida(await cargar(db, 'f.fac_id = $1', [fac_id])), repetida } };
    },
    async ConsultarFactura(ctx, d) {
      const [col, val] = d.fac_id ? ['f.fac_id', d.fac_id] : d.ord_id ? ['f.ord_id', d.ord_id] : ['f.fac_numero', d.numero];
      const f = await cargar(db, `${col} = $1`, [val]); if (!f) throw noHay(); return { tag: 'ConsultarFacturaResponse', cuerpo: { factura: salida(f) } };
    },
    async ListarFacturas(ctx, d) {
      const page = d.page ?? 1; const limit = d.limit ?? 20; const par = []; const w = [];
      if (d.estado) { par.push(d.estado); w.push(`e.est_codigo = $${par.length}`); } if (d.desde) { par.push(d.desde); w.push(`f.fac_emitida_en >= $${par.length}::date`); } if (d.hasta) { par.push(d.hasta); w.push(`f.fac_emitida_en < $${par.length}::date + 1`); }
      const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
      const tot = (await db.q(`SELECT count(*)::int AS n FROM factura f JOIN estado e ON e.est_id = f.est_id ${where}`, par)).rows[0].n;
      const ids = (await db.q(`SELECT f.fac_id FROM factura f JOIN estado e ON e.est_id = f.est_id ${where} ORDER BY f.fac_id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, par)).rows;
      const facs = []; for (const i of ids) facs.push(salida(await cargar(db, 'f.fac_id = $1', [i.fac_id])));
      return { tag: 'ListarFacturasResponse', cuerpo: { total_results: tot, page, limit, ...(facs.length ? { __lista: facs } : {}) } };
    },
    async MarcarFacturaPagada(ctx, d) { return cambiarEstado(d.fac_id, 'PAGADA', 'MarcarFacturaPagadaResponse', 'FACTURA_PAGADA'); },
    async AnularFactura(ctx, d) { return cambiarEstado(d.fac_id, 'ANULADA', 'AnularFacturaResponse', 'FACTURA_ANULADA', d.motivo); },
  };
  async function cambiarEstado(facId, nuevo, tag, evento, motivo) {
    await db.tx(async (c) => {
      const f = (await c.query('SELECT e.est_codigo, e.est_final FROM factura f JOIN estado e ON e.est_id = f.est_id WHERE f.fac_id = $1 FOR UPDATE OF f', [facId])).rows[0]; if (!f) throw noHay();
      if (f.est_final) throw err(409, 'INVOICE_FINAL', `La factura está ${f.est_codigo}; ya no admite cambios.`);
      await c.query('UPDATE factura SET est_id = $2 WHERE fac_id = $1', [facId, await estadoId(c, nuevo)]);
    });
    publicar({ tipo: evento, origen: 'invoicing', entidad: 'factura', entidad_id: String(facId), datos: motivo ? { motivo } : {} });
    return { tag, cuerpo: { factura: salida(await cargar(db, 'f.fac_id = $1', [facId])) } };
  }

  const manejar = async (ctx) => {
    try {
      const txt = ctx.bodyRaw.toString('utf8');
      if (!txt.trim()) throw err(400, 'EMPTY_BODY', 'Envíe un sobre SOAP.');
      if (/<!DOCTYPE|<!ENTITY/i.test(txt)) throw err(400, 'DTD_NOT_ALLOWED', 'No se permiten DTD ni entidades en el XML.');       // evita XXE y "billion laughs"
      let doc; try { doc = parser.parse(txt); } catch { throw err(400, 'INVALID_XML', 'El XML no está bien formado.'); }
      const cuerpoSoap = doc?.Envelope?.Body; if (!cuerpoSoap || typeof cuerpoSoap !== 'object') throw err(400, 'INVALID_SOAP', 'Falta soap:Envelope/soap:Body.');
      const nombre = Object.keys(cuerpoSoap).find((k) => k.endsWith('Request')); const op = nombre?.replace(/Request$/, '');
      if (!op || !operaciones[op]) throw err(400, 'UNKNOWN_OPERATION', `Operación no soportada. Use: ${Object.keys(operaciones).join(', ')}.`);
      await autorizar(ctx, { roles: ['ADMIN'] });
      const entrada = cuerpoSoap[nombre] && typeof cuerpoSoap[nombre] === 'object' ? cuerpoSoap[nombre] : {};
      const datos = ctx.validarQ(nombre, decodificar(structuredClone(entrada)));
      const { tag, cuerpo } = await operaciones[op](ctx, datos);
      const lista = cuerpo.__lista; delete cuerpo.__lista;
      const xml = `<inv:${tag}>${Object.entries(cuerpo).map(([k, v]) => el(k, v)).join('')}${(lista ?? []).map((f) => el('factura', f)).join('')}</inv:${tag}>`;
      return responder(200, sobre(xml), XML);
    } catch (e) {
      const he = e instanceof HttpError ? e : null;
      if (!he) { ctx.log({ level: 'error', msg: String(e?.stack ?? e).slice(0, 600) }); return responder(500, fault(new HttpError(500, 'INTERNAL', 'Error interno del microservicio.')), XML); }
      return responder(he.status >= 500 ? 500 : he.status === 401 || he.status === 403 ? he.status : 400, fault(he), XML);              // SOAP 1.1: los Fault viajan con HTTP 500 o 4xx
    }
  };
  r.post('/soap', manejar, { raw: true });
  r.get('/soap', async (ctx) => responder(200, wsdl(`http://${ctx.headers.host ?? '127.0.0.1'}/soap`), XML));          // GET /soap?wsdl
  r.get('/wsdl', async (ctx) => responder(200, wsdl(`http://${ctx.headers.host ?? '127.0.0.1'}/soap`), XML));
}
export default { nombre: 'invoicing', marcador: 'factura', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
