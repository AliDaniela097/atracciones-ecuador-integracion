import { createHash } from 'node:crypto';

/**
 * Límite de peticiones en la puerta de entrada (Gateway, Semana 8): problema transversal, sin reglas de negocio.
 * Ventana fija de 60 s en memoria, por cliente: API Key (partners como Booking) > token JWT (persona) > IP (anónimo).
 * Distingue tráfico: partners y usuarios autenticados tienen más margen que el anónimo, y el login/registro es más estricto (fuerza bruta).
 * Valores por variables de entorno: RATE_LIMIT_PARTNER_PER_MIN (600), RATE_LIMIT_USER_PER_MIN (300), RATE_LIMIT_ANON_PER_MIN (120), RATE_LIMIT_AUTH_PER_MIN (20), RATE_LIMIT_ENABLED=false para apagarlo.
 */
const num = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const VENTANA_MS = 60_000;
const cubo = new Map<string, { n: number; hasta: number }>();
setInterval(() => { const t = Date.now(); for (const [k, v] of cubo) if (v.hasta <= t) cubo.delete(k); }, VENTANA_MS).unref();

const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const EXENTAS = /^\/api\/v3\/(health|atracciones\/health|ms\/health)(\/|\?|$)/;

export function limitarPeticiones(req: any, res: any, next: any) {
  if (process.env.RATE_LIMIT_ENABLED === 'false') return next();
  const url: string = req.originalUrl ?? req.url;
  if (!url.startsWith('/api/v3/') || EXENTAS.test(url)) return next();
  const clave = req.headers['x-api-key'] ? `k:${h(String(req.headers['x-api-key']))}` : /^Bearer\s+\S+/i.test(String(req.headers.authorization ?? '')) ? `t:${h(String(req.headers.authorization))}` : `i:${req.ip}`;
  const esAuth = /^\/api\/v3\/auth\/(login|register)(\?|$)/.test(url) && req.method === 'POST';
  const limite = esAuth ? num('RATE_LIMIT_AUTH_PER_MIN', 20) : clave[0] === 'k' ? num('RATE_LIMIT_PARTNER_PER_MIN', 600) : clave[0] === 't' ? num('RATE_LIMIT_USER_PER_MIN', 300) : num('RATE_LIMIT_ANON_PER_MIN', 120);
  const id = `${esAuth ? 'a' : 'g'}|${clave[0] === 'i' || esAuth ? `i:${req.ip}` : clave}`;
  const ahora = Date.now(); let c = cubo.get(id);
  if (!c || c.hasta <= ahora) { c = { n: 0, hasta: ahora + VENTANA_MS }; cubo.set(id, c); }
  c.n++;
  res.setHeader('RateLimit-Limit', String(limite)); res.setHeader('RateLimit-Remaining', String(Math.max(0, limite - c.n))); res.setHeader('RateLimit-Reset', String(Math.ceil((c.hasta - ahora) / 1000)));
  if (c.n > limite) {
    const espera = Math.ceil((c.hasta - ahora) / 1000);
    res.setHeader('Retry-After', String(espera));
    return res.status(429).type('application/problem+json').json({ type: 'https://atracciones.ec/problems/too-many-requests', title: 'Demasiadas peticiones', status: 429, detail: `Superaste el límite de ${limite} peticiones por minuto. Reintenta en ${espera} s.`, instance: url.split('?')[0], code: 'RATE_LIMITED', correlation_id: req.correlationId, timestamp: new Date().toISOString() });
  }
  next();
}
