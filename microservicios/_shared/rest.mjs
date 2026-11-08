// Mini-framework REST sobre node:http (sin dependencias): enrutado, JSON, validación AJV, errores uniformes,
// límites de tamaño/tiempo, límite de peticiones por IP, logs JSON y cierre ordenado.
import http from 'node:http';
import crypto from 'node:crypto';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { HttpError, err, desdePg } from './errores-http.mjs';

const MAX_BODY = 256 * 1024;
const TIEMPO_HANDLER_MS = Number(process.env.MS_HANDLER_TIMEOUT_MS ?? 12000);
const LIMITE_RPM = Number(process.env.MS_RATE_LIMIT_RPM ?? 600);       // peticiones por minuto y por IP (protección básica)

export function crearRouter() {
  const rutas = [];
  const add = (metodo) => (ruta, handler, opc = {}) => {
    const nombres = [];
    const re = new RegExp('^' + ruta.replace(/:([a-zA-Z_]+)/g, (_, n) => { nombres.push(n); return '([^/]+)'; }) + '/?$');
    rutas.push({ metodo, re, nombres, handler, opc });
  };
  return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'), rutas };
}

export function crearValidador(esquemas, coerce = false) {
  const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: coerce, useDefaults: true });
  (addFormats.default ?? addFormats)(ajv);
  const cache = new Map();
  return (nombre, datos) => {
    if (!cache.has(nombre)) { if (!esquemas[nombre]) throw new Error(`Esquema inexistente: ${nombre}`); cache.set(nombre, ajv.compile(esquemas[nombre])); }
    const v = cache.get(nombre);
    if (v(datos)) return datos;
    throw err(400, 'VALIDATION_ERROR', 'La petición no cumple el contrato.', v.errors.map((e) => ({
      name: (e.instancePath || '/').replace(/^\//, '').replace(/\//g, '.') || (e.params?.missingProperty ?? '(raíz)'),
      reason: e.keyword === 'required' ? `Falta el campo obligatorio '${e.params.missingProperty}'`
        : e.keyword === 'additionalProperties' ? `Campo no permitido '${e.params.additionalProperty}'` : e.message,
    })));
  };
}

const logLinea = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
const leerCuerpo = (req) => new Promise((res, rej) => {
  const trozos = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { rej(err(413, 'PAYLOAD_TOO_LARGE', `El cuerpo supera ${MAX_BODY / 1024} KB.`)); req.destroy(); } else trozos.push(c); });
  req.on('end', () => res(Buffer.concat(trozos)));
  req.on('error', rej);
});

export function crearServidor({ nombre, router, esquemas = {}, db, salud, raw = {} }) {
  const validar = crearValidador(esquemas); const validarQ = crearValidador(esquemas, true);   // validarQ: parámetros de URL (convierte "5" en 5)
  const cubos = new Map();                                   // límite de peticiones: ventana de 1 minuto por IP
  const limpiador = setInterval(() => { const t = Date.now(); for (const [k, v] of cubos) if (t - v.t > 60000) cubos.delete(k); }, 60000); limpiador.unref();
  const excede = (ip) => { const t = Date.now(); const c = cubos.get(ip); if (!c || t - c.t > 60000) { cubos.set(ip, { t, n: 1 }); return false; } c.n += 1; return c.n > LIMITE_RPM; };
  let contador = 0; let vivas = 0;

  const server = http.createServer(async (req, res) => {
    const inicio = Date.now(); const id = req.headers['x-request-id']?.toString().slice(0, 64) || crypto.randomUUID();
    // El servidor solo escucha en 127.0.0.1: si la petición viene del backend (loopback), la IP real del cliente llega en x-forwarded-for.
    const directa = req.socket.remoteAddress ?? ''; const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const ip = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(directa) && /^[0-9a-fA-F:.]{3,45}$/.test(xff) ? xff : directa; contador += 1; vivas += 1;
    const url = new URL(req.url, 'http://x');
    let status = 500;
    const enviar = (st, cuerpo, cab = {}) => {
      status = st;
      const txt = cuerpo === undefined ? '' : (typeof cuerpo === 'string' || Buffer.isBuffer(cuerpo)) ? cuerpo : JSON.stringify(cuerpo);
      const tipo = cab['Content-Type'] ?? (typeof cuerpo === 'string' || Buffer.isBuffer(cuerpo) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
      if (!res.headersSent) { res.writeHead(st, { 'Content-Type': tipo, 'X-Request-Id': id, 'Cache-Control': 'no-store', ...cab }); }
      res.end(txt);
    };
    try {
      if (excede(ip)) throw err(429, 'RATE_LIMITED', 'Demasiadas peticiones; intente en un minuto.');
      const metodo = req.method;
      if (url.pathname === '/health' || url.pathname === '/health/live') {
        if (url.pathname === '/health/live') return enviar(200, { status: 'UP', service: nombre });
        const d = await salud();
        return enviar(d.status === 'UP' ? 200 : 503, d);
      }
      let encontrada = null; let hayRuta = false;
      for (const r of router.rutas) {
        const m = r.re.exec(url.pathname); if (!m) continue; hayRuta = true;
        if (r.metodo !== metodo) continue;
        const params = {}; r.nombres.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch { throw err(400, 'BAD_PATH', 'Ruta con codificación inválida.'); } });
        encontrada = { r, params }; break;
      }
      if (!encontrada) throw hayRuta ? err(405, 'METHOD_NOT_ALLOWED', 'Método no permitido para esta ruta.') : err(404, 'NOT_FOUND', 'Ruta no encontrada.');
      let bodyBuf = Buffer.alloc(0);
      if (['POST', 'PUT', 'PATCH'].includes(metodo)) bodyBuf = await leerCuerpo(req);
      const ctx = { req, id, ip, params: encontrada.params, query: Object.fromEntries(url.searchParams), headers: req.headers, db, nombre, validar, validarQ, bodyRaw: bodyBuf, body: undefined, log: (o) => logLinea({ svc: nombre, req: id, ...o }) };
      if (!encontrada.r.opc.raw) {                          // JSON por defecto; las rutas "raw" (SOAP/XML) leen ctx.bodyRaw
        if (bodyBuf.length) {
          if (!/json/i.test(req.headers['content-type'] ?? '')) throw err(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json.');
          try { ctx.body = JSON.parse(bodyBuf.toString('utf8')); } catch { throw err(400, 'INVALID_JSON', 'El cuerpo no es JSON válido.'); }
        } else ctx.body = {};
      }
      let t; const limite = new Promise((_, rej) => { t = setTimeout(() => rej(err(504, 'TIMEOUT', 'La operación tardó demasiado.')), TIEMPO_HANDLER_MS); });
      let r;
      try { r = await Promise.race([encontrada.r.handler(ctx), limite]); } finally { clearTimeout(t); }
      if (r?.__respuesta) return enviar(r.status, r.cuerpo, r.cabeceras);
      return enviar(200, r ?? {});
    } catch (e) {
      const he = e instanceof HttpError ? e : desdePg(e);
      if (he) enviar(he.status, { code: he.code, message: he.message, invalid_params: he.invalid_params, request_id: id });
      else { logLinea({ level: 'error', svc: nombre, req: id, msg: String(e?.stack ?? e).slice(0, 800) }); enviar(500, { code: 'INTERNAL', message: 'Error interno del microservicio.', invalid_params: [], request_id: id }); }
    } finally {
      vivas -= 1;
      if (process.env.MS_LOG_REQUESTS !== 'false') logLinea({ svc: nombre, req: id, m: req.method, p: url.pathname, st: status, ms: Date.now() - inicio });
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.on('clientError', (e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignorar */ } });
  server.stats = () => ({ requests: contador, in_flight: vivas });
  return server;
}
// Respuesta con código y cabeceras propias: return responder(201, {...}, {Location: '...'})
export const responder = (status, cuerpo, cabeceras = {}) => ({ __respuesta: true, status, cuerpo, cabeceras });
