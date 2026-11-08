// Llamadas entre microservicios (HTTP) con tiempo límite, reintento de lecturas y cortacircuitos:
// si un servicio vecino falla 5 veces seguidas, se deja de llamar 15 s (responde 503 al instante en vez de colgarse).
import { err } from './errores-http.mjs';
import { urlDe } from './servicios.mjs';

const estado = new Map();                                    // servicio -> { fallos, abiertoHasta }
const e = (s) => { if (!estado.has(s)) estado.set(s, { fallos: 0, abiertoHasta: 0 }); return estado.get(s); };
export const claveInterna = () => process.env.MS_INTERNAL_KEY ?? '';

export async function llamar(servicio, metodo, ruta, { body, headers = {}, timeoutMs = 3000, reintentos } = {}) {
  const st = e(servicio);
  if (Date.now() < st.abiertoHasta) throw err(503, 'DEPENDENCY_UNAVAILABLE', `El servicio ${servicio} no está disponible por ahora.`);
  const intentos = (reintentos ?? (metodo === 'GET' ? 1 : 0)) + 1;
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(urlDe(servicio) + ruta, {
        method: metodo, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', ...(claveInterna() ? { 'x-internal-key': claveInterna() } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const txt = await r.text(); let json; try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw: txt }; }
      if (r.status >= 500) { ultimo = err(503, 'DEPENDENCY_ERROR', `El servicio ${servicio} respondió ${r.status}.`); st.fallos += 1; continue; }
      st.fallos = 0; return { status: r.status, body: json };
    } catch (x) { ultimo = err(503, 'DEPENDENCY_UNAVAILABLE', `No se pudo contactar a ${servicio} (${x.name === 'TimeoutError' ? 'tiempo agotado' : x.message}).`); st.fallos += 1; }
  }
  if (st.fallos >= 5) st.abiertoHasta = Date.now() + 15000;
  throw ultimo;
}
// Devuelve el cuerpo si 2xx; null si 404; lanza el error del vecino en otro caso.
export async function obtener(servicio, ruta, opc) {
  const r = await llamar(servicio, 'GET', ruta, opc);
  if (r.status === 404) return null;
  if (r.status >= 400) throw err(r.status === 401 || r.status === 403 ? 502 : r.status, r.body?.code ?? 'DEPENDENCY_REJECTED', r.body?.message ?? `${servicio} rechazó la consulta.`);
  return r.body;
}
export const estadoCortacircuitos = () => Object.fromEntries([...estado].map(([k, v]) => [k, { fallos: v.fallos, abierto: Date.now() < v.abiertoHasta }]));
