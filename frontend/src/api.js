// Cliente HTTP único: toda la web habla solo con la URL base del backend (el API Gateway). Sin datos de negocio aquí.
const BASE = '/api/v3';
const KEY = 'atr_sesion';

export const sesion = {
  leer() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } },
  guardar(s) { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* almacenamiento no disponible */ } window.dispatchEvent(new Event('sesion')); },
  borrar() { try { sessionStorage.removeItem(KEY); } catch { /* idem */ } window.dispatchEvent(new Event('sesion')); },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.detail || body?.message || `Error ${status}`);
    this.status = status; this.code = body?.code; this.params = body?.invalid_params ?? [];
  }
}

export async function api(metodo, ruta, { body, query, headers = {}, auth = true } = {}) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '' && v !== null)).toString() : '';
  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const s = sesion.leer(); if (auth && s?.token) h.Authorization = `Bearer ${s.token}`;
  let res;
  try { res = await fetch(BASE + ruta + qs, { method: metodo, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new ApiError(0, { detail: 'No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.' }); }
  if (res.status === 204) return null;
  const texto = await res.text(); let json = null; try { json = texto ? JSON.parse(texto) : null; } catch { /* no JSON */ }
  if (res.status === 401 && auth && s) sesion.borrar();
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));
export const hoyEC = (dias = 0) => new Date(Date.now() - 5 * 3600e3 + dias * 86400e3).toISOString().slice(0, 10);
export const usd = (n) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(n ?? 0));
