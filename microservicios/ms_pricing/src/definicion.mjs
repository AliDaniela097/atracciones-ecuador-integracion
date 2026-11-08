// ms_pricing (gRPC) — tarifas versionadas por tipo de boleto. Order/Cart consultan aquí el precio. Base propia: ms_pricing.
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { wrap, fail, S } from '../../_shared/errors.mjs';
import { crearValidador } from '../../_shared/validate.mjs';
import { crearDb, paginar, meta } from '../../_shared/pgs.mjs';
import { SERVICIOS } from '../../_shared/servicios.mjs';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRUPO_MIN = Number(process.env.PRICING_GROUP_MIN ?? 10);          // personas mínimas para aplicar la tarifa GRUPO
const HOY = "(now() AT TIME ZONE 'America/Guayaquil')::date::text";
const cents = (x) => Math.round(x * 100); const dinero = (c) => c / 100;
const tar = (x) => ({ tar_id: x.tar_id, atr_id: x.atr_id, tar_tipo: x.tar_tipo, tar_precio: x.tar_precio, tar_moneda: x.tar_moneda, tar_vigente_desde: x.tar_vigente_desde, tar_vigente_hasta: x.tar_vigente_hasta ?? '' });
const dia = (f, n) => { const d = new Date(`${f}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function crearServicio(v, db) {
  const hoy = async () => (await db.q(`SELECT ${HOY} AS h`)).rows[0].h;
  const vigentes = async (atrId, fecha) => (await db.q(
    `SELECT DISTINCT ON (tar_tipo) * FROM tarifa WHERE atr_id = $1 AND tar_vigente_desde <= $2::date AND (tar_vigente_hasta IS NULL OR tar_vigente_hasta >= $2::date)
     ORDER BY tar_tipo, tar_vigente_desde DESC`, [atrId, fecha])).rows;
  return {
    async CreateTariff(req) {
      const d = v.validar('CreateTariffRequest', req); const desde = d.tar_vigente_desde ?? await hoy();
      return db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock($1, $2)', [d.atr_id % 2147483647, d.tar_tipo.length * 7 + d.tar_tipo.charCodeAt(0)]);   // serializa cambios de la misma atracción/tipo
        const ult = (await c.query('SELECT * FROM tarifa WHERE atr_id = $1 AND tar_tipo = $2 ORDER BY tar_vigente_desde DESC LIMIT 1', [d.atr_id, d.tar_tipo])).rows[0];
        if (ult) {
          if (ult.tar_vigente_desde >= desde) throw fail(S.FAILED_PRECONDITION, 'TARIFF_DATE_CONFLICT', `Ya existe una tarifa ${d.tar_tipo} desde ${ult.tar_vigente_desde}; la nueva debe empezar después.`, [{ name: 'tar_vigente_desde', reason: `debe ser posterior a ${ult.tar_vigente_desde}` }]);
          if (ult.tar_moneda !== (d.tar_moneda ?? 'USD')) throw fail(S.FAILED_PRECONDITION, 'MIXED_CURRENCY', `La atracción ya usa ${ult.tar_moneda}; no se puede cambiar de moneda.`);
          await c.query('UPDATE tarifa SET tar_vigente_hasta = $2::date - 1 WHERE tar_id = $1 AND (tar_vigente_hasta IS NULL OR tar_vigente_hasta >= $2::date)', [ult.tar_id, desde]);   // cierra la anterior un día antes
        }
        return tar((await c.query('INSERT INTO tarifa (atr_id, tar_tipo, tar_precio, tar_moneda, tar_vigente_desde) VALUES ($1,$2,$3,$4,$5) RETURNING *', [d.atr_id, d.tar_tipo, d.tar_precio, d.tar_moneda ?? 'USD', desde])).rows[0]);
      });
    },
    async CloseTariff(req) {
      const d = v.validar('CloseTariffRequest', req);
      const x = (await db.q('SELECT * FROM tarifa WHERE tar_id = $1', [d.tar_id])).rows[0]; if (!x) throw fail(S.NOT_FOUND, 'TARIFF_NOT_FOUND', `No existe la tarifa ${d.tar_id}.`);
      if (d.tar_vigente_hasta < x.tar_vigente_desde) throw fail(S.INVALID_ARGUMENT, 'VALIDATION_ERROR', 'La fecha de cierre es anterior al inicio de la tarifa.', [{ name: 'tar_vigente_hasta', reason: `debe ser ≥ ${x.tar_vigente_desde}` }]);
      return tar((await db.q('UPDATE tarifa SET tar_vigente_hasta = $2 WHERE tar_id = $1 RETURNING *', [d.tar_id, d.tar_vigente_hasta])).rows[0]);
    },
    async GetCurrentTariffs(req) {
      const d = v.validar('GetCurrentTariffsRequest', req); return { data: (await vigentes(d.atr_id, d.fecha ?? await hoy())).map(tar) };
    },
    async ListTariffHistory(req) {
      const d = v.validar('ListTariffHistoryRequest', req); const p = paginar(d); const par = [d.atr_id]; let w = 'atr_id = $1';
      if (d.tar_tipo) { par.push(d.tar_tipo); w += ' AND tar_tipo = $2'; }
      const tot = (await db.q(`SELECT count(*)::int AS n FROM tarifa WHERE ${w}`, par)).rows[0].n;
      const rows = (await db.q(`SELECT * FROM tarifa WHERE ${w} ORDER BY tar_vigente_desde DESC, tar_tipo LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows;
      return { data: rows.map(tar), metadata: meta(tot, p) };
    },
    // Cotiza: ADULTO/NINO/MAYOR a su tarifa. Si hay ≥ GRUPO_MIN personas y existe tarifa GRUPO, se aplica a todos solo cuando no resulta más cara que la individual.
    async CalculatePrice(req) {
      const d = v.validar('CalculatePriceRequest', req); const fecha = d.fecha ?? await hoy();
      const pedido = { ADULTO: d.adultos ?? 0, NINO: d.ninos ?? 0, MAYOR: d.mayores ?? 0 }; const personas = pedido.ADULTO + pedido.NINO + pedido.MAYOR;
      if (personas < 1) throw fail(S.INVALID_ARGUMENT, 'VALIDATION_ERROR', 'Indique al menos una persona.', [{ name: 'adultos', reason: 'la suma de adultos, niños y mayores debe ser ≥ 1' }]);
      const t = Object.fromEntries((await vigentes(d.atr_id, fecha)).map((x) => [x.tar_tipo, x]));
      const monedas = new Set(Object.values(t).map((x) => x.tar_moneda)); if (monedas.size > 1) throw fail(S.FAILED_PRECONDITION, 'MIXED_CURRENCY', 'Las tarifas vigentes tienen monedas distintas.');
      const faltan = Object.entries(pedido).filter(([k, n]) => n > 0 && !t[k]).map(([k]) => k);
      const individual = faltan.length ? null : Object.entries(pedido).filter(([, n]) => n > 0).map(([k, n]) => ({ tar_tipo: k, cantidad: n, precio_unitario: t[k].tar_precio, subtotal: dinero(n * cents(t[k].tar_precio)) }));
      let lineas = individual;
      if (t.GRUPO && personas >= GRUPO_MIN) {
        const g = [{ tar_tipo: 'GRUPO', cantidad: personas, precio_unitario: t.GRUPO.tar_precio, subtotal: dinero(personas * cents(t.GRUPO.tar_precio)) }];
        if (!individual || g[0].subtotal <= individual.reduce((s, l) => s + l.subtotal, 0)) lineas = g;
      }
      if (!lineas) throw fail(S.FAILED_PRECONDITION, 'TARIFF_NOT_FOUND', `No hay tarifa vigente el ${fecha} para: ${faltan.join(', ')}.`, faltan.map((k) => ({ name: k, reason: 'sin tarifa vigente' })));
      return { atr_id: d.atr_id, fecha, moneda: Object.values(t)[0].tar_moneda, personas, lineas, subtotal: dinero(lineas.reduce((s, l) => s + cents(l.subtotal), 0)) };
    },
  };
}

// Arranque como servicio gRPC (lo invoca servicio.mjs → iniciar()).
async function iniciarPropio({ host, puerto }) {
  const db = crearDb(SERVICIOS.pricing.db, 'pricing');
  const def = protoLoader.loadSync(path.join(raiz, 'proto/ms_pricing.proto'), { keepCase: true, longs: Number, defaults: false, arrays: true, oneofs: false });
  const pkg = grpc.loadPackageDefinition(def);
  const servicio = crearServicio(crearValidador(path.join(raiz, 'schemas/requests.json')), db);
  const handlers = Object.fromEntries(Object.entries(servicio).map(([n, fn]) => [n, wrap(n, fn)]));
  const server = new grpc.Server({ 'grpc.max_receive_message_length': 1024 * 1024 });
  server.addService(pkg.ms_pricing.v1.PricingService.service, handlers);
  await new Promise((res, rej) => server.bindAsync(`${host}:${puerto}`, grpc.ServerCredentials.createInsecure(), (e) => (e ? rej(e) : res())));
  const t0 = Date.now(); const ev = new EventEmitter();
  const salud = async () => { let ok = false; let msg; try { await Promise.race([db.q('SELECT 1'), new Promise((_, r) => setTimeout(() => r(new Error('timeout BD')), 2500))]); ok = true; } catch (e) { msg = e.message; }
    return { status: ok ? 'UP' : 'DOWN', service: 'ms_pricing', protocol: 'gRPC', uptime_s: Math.round((Date.now() - t0) / 1000), database: ok ? 'UP' : `DOWN (${msg})` }; };
  const cerrar = () => new Promise((res) => { server.tryShutdown(async () => { await db.cerrar(); ev.emit('close'); res(); }); setTimeout(() => { server.forceShutdown(); res(); }, 3000).unref(); });
  console.log(JSON.stringify({ level: 'info', msg: 'ms_pricing iniciado', puerto, host, protocolo: 'gRPC' }));
  return { server: ev, db, cerrar, puerto, salud };
}
export default { nombre: 'pricing', marcador: 'tarifa', schemaPath: path.join(raiz, 'db/schema.sql'), iniciarPropio };
