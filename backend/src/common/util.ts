import { badRequest } from './problem.js';

// ---------- Horas y slot_id ("slot-YYYYMMDD-HHMM") ----------
/** Acepta "10:30 a.m.", "10:30 AM", "10:30:00", "10:30", "1030" → "HH:MM" (24 h). */
export function parseTime(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(?::(\d{2}))?\s*(am|pm|a m|p m)?$/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0); const suf = m[4]?.replace(' ', '');
  if (min > 59) return null;
  if (suf) { if (h < 1 || h > 12) return null; if (suf === 'pm' && h < 12) h += 12; if (suf === 'am' && h === 12) h = 0; }
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
export const label12h = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const suf = h < 12 ? 'a.m.' : 'p.m.'; const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${suf}`;
};
export const hhmmFromDb = (t: string) => String(t).slice(0, 5);
export const slotId = (date: string, hhmm: string) => `slot-${date.replace(/-/g, '')}-${hhmm.replace(':', '')}`;
export function parseSlot(id: string): { date: string; time: string } | null {
  const m = /^slot-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(id ?? '');
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`, time = `${m[4]}:${m[5]}`;
  if (!isRealDate(date) || Number(m[4]) > 23 || Number(m[5]) > 59) return null;
  return { date, time };
}
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const todayEC = () => {
  // Fecha de hoy en Ecuador (UTC-5, sin horario de verano)
  const d = new Date(Date.now() - 5 * 3600_000);
  return d.toISOString().slice(0, 10);
};

// ---------- Paginación (misma forma PaginationMetadata del contrato) ----------
export interface PageQuery { page: number; limit: number; offset: number }
export function pageQuery(q: Record<string, any>, defLimit = 10, maxLimit = 50): PageQuery {
  const page = q.page === undefined ? 1 : Number(q.page);
  const limit = q.limit === undefined ? defLimit : Number(q.limit);
  if (!Number.isInteger(page) || page < 1) throw badRequest('page debe ser un entero ≥ 1.', 'INVALID_PAGE', [{ name: 'page', reason: 'Entero ≥ 1' }]);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit)
    throw badRequest(`limit debe ser un entero entre 1 y ${maxLimit}.`, 'INVALID_LIMIT', [{ name: 'limit', reason: `Entero entre 1 y ${maxLimit}` }]);
  return { page, limit, offset: (page - 1) * limit };
}
export function pageMeta(total: number, p: PageQuery) {
  const total_pages = Math.max(1, Math.ceil(total / p.limit));
  const next = p.page < total_pages ? Buffer.from(JSON.stringify({ offset: p.offset + p.limit })).toString('base64') : null;
  return { total_results: total, page: p.page, limit: p.limit, total_pages, next_cursor: next };
}

// ---------- Validadores de identidad ----------
/** Cédula ecuatoriana: 10 dígitos, provincia 01-24 (o 30), 3er dígito < 6, dígito verificador módulo 10. */
export function cedulaValida(c: string): boolean {
  if (!/^\d{10}$/.test(c)) return false;
  const prov = Number(c.slice(0, 2));
  if ((prov < 1 || prov > 24) && prov !== 30) return false;
  if (Number(c[2]) > 5) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) { let v = Number(c[i]) * (i % 2 === 0 ? 2 : 1); if (v > 9) v -= 9; sum += v; }
  return (10 - (sum % 10)) % 10 === Number(c[9]);
}
export const telefonoValido = (p: string) => /^(\+\d{7,15}|09\d{8})$/.test(p.replace(/[\s-]/g, ''));
export const correoValido = (e: string) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e);

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);
export const durationLabel = (h: number) => {
  if (Number.isInteger(h)) return h === 1 ? '1 hora' : `${h} horas`;
  const whole = Math.floor(h), min = Math.round((h - whole) * 60);
  return whole === 0 ? `${min} min` : `${whole} h ${min} min`;
};
export const toBool = (v: unknown): boolean | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['true', '1', 'si', 'sí', 'yes'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  throw badRequest(`Valor booleano inválido: ${v}`, 'INVALID_BOOLEAN');
};
