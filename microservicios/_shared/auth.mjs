// Autorización: el token lo emite y valida ms_identity. Los demás servicios le consultan (con caché de 30 s).
//   MS_AUTH_MODE=identity (por defecto) | off (solo pruebas locales).
// Las llamadas entre servicios se identifican con la cabecera x-internal-key (MS_INTERNAL_KEY).
import crypto from 'node:crypto';
import { err } from './errores-http.mjs';
import { llamar, claveInterna } from './llamadas.mjs';

export const modoAuth = () => (process.env.MS_AUTH_MODE ?? 'identity');
const cache = new Map();
const iguales = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const esInterna = (ctx) => { const k = claveInterna(); const h = ctx.headers['x-internal-key']; return Boolean(k && h && iguales(String(h), k)); };

// Exige llamada interna (eventos entre servicios). Si no hay clave configurada, solo permite loopback.
export function exigirInterna(ctx) {
  if (esInterna(ctx)) return;
  if (!claveInterna() && !ctx.headers['x-forwarded-for'] && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ctx.req.socket.remoteAddress ?? '')) return;
  throw err(403, 'FORBIDDEN', 'Ruta interna entre microservicios.');
}
export async function validarToken(token, localValidar) {
  if (localValidar) return localValidar(token);
  const hit = cache.get(token); if (hit && hit.exp > Date.now()) return hit.v;
  const r = await llamar('identity', 'POST', '/v1/auth/validate', { body: { token }, timeoutMs: 2500 });
  const v = r.status === 200 && r.body?.valid ? r.body : null;
  if (cache.size > 500) cache.clear();
  cache.set(token, { v, exp: Date.now() + (v ? 30000 : 5000) });
  return v;
}
// opc: { roles: ['ADMIN'], propietario: 'usuId' (parámetro de ruta con el id del dueño), localValidar }
export async function autorizar(ctx, opc = {}) {
  if (esInterna(ctx)) return { usu_id: null, roles: ['ADMIN'], interno: true };
  if (modoAuth() === 'off') return { usu_id: null, roles: ['ADMIN'], interno: false, sinAuth: true };
  const m = /^Bearer\s+(\S{20,200})$/.exec(ctx.headers.authorization ?? '');
  if (!m) throw err(401, 'UNAUTHORIZED', 'Falta el token (Authorization: Bearer ...).');
  const v = await validarToken(m[1], opc.localValidar);
  if (!v) throw err(401, 'UNAUTHORIZED', 'Token inválido o vencido.');
  const sesion = { usu_id: v.usu_id, roles: v.roles ?? [], interno: false };
  if (sesion.roles.includes('ADMIN')) return sesion;
  if (opc.propietario && String(ctx.params[opc.propietario]) === String(sesion.usu_id)) return sesion;
  if (opc.roles?.some((r) => sesion.roles.includes(r)) && !opc.propietario) return sesion;
  if (!opc.roles && !opc.propietario) return sesion;                                // basta con estar autenticado
  throw err(403, 'FORBIDDEN', 'No tiene permiso para esta operación.');
}
