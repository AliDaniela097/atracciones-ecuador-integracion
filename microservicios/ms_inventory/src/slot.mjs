// Utilidades del turno (disponibilidad + horario). slot_id y time_slot siguen el contrato de Booking.
import { q } from './lib/db.mjs';

export const SEL = `SELECT d.dis_id, d.atr_id, d.hor_id, d.dis_fecha, h.hor_hora, d.dis_cupo_total, d.dis_cupo_reservado, d.dis_cerrada
                    FROM disponibilidad d JOIN horario h ON h.hor_id = d.hor_id AND h.atr_id = d.atr_id`;
export const hhmm = (t) => String(t).slice(0, 5);
export const slotId = (fecha, hora) => `slot-${fecha.replace(/-/g, '')}-${hora.replace(':', '')}`;
export const label12h = (hora) => {                 // "09:00" -> "09:00 a.m."  (formato que usa Booking en time_slot)
  const [h, m] = hora.split(':').map(Number);
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
};
export const dto = (r) => ({
  dis_id: r.dis_id, atr_id: r.atr_id, hor_id: r.hor_id, dis_fecha: r.dis_fecha, hor_hora: hhmm(r.hor_hora),
  dis_cupo_total: r.dis_cupo_total, dis_cupo_reservado: r.dis_cupo_reservado,
  cupos_disponibles: r.dis_cupo_total - r.dis_cupo_reservado, dis_cerrada: r.dis_cerrada,
  slot_id: slotId(r.dis_fecha, hhmm(r.hor_hora)),
});
export async function leer(disId, cliente = { query: q }) {
  const r = await cliente.query(`${SEL} WHERE d.dis_id = $1`, [disId]);
  return r.rows[0] ? dto(r.rows[0]) : null;
}
