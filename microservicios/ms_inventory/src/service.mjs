// Lógica de ms_inventory. Cada método valida con AJV (schemas/requests.json), usa transacciones y bloqueo de fila para evitar sobreventa.
import { q, tx, paginar, meta } from './lib/db.mjs';
import { fail, S } from './lib/errors.mjs';
import { SEL, dto, hhmm, leer } from './slot.mjs';
import { estado, sincronizar, sincronizarEnSegundoPlano } from './booking-push.mjs';

const DIAS_MAX = 62;
const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const horarioDto = (r) => ({ hor_id: r.hor_id, atr_id: r.atr_id, hor_hora: hhmm(r.hor_hora), hor_cupo: r.hor_cupo, hor_activo: r.hor_activo });

export function crearServicio(v) {
  return {
    async CreateHorario(req) {
      const d = v.validar('CreateHorarioRequest', req);
      try {
        const r = await q('INSERT INTO horario (atr_id, hor_hora, hor_cupo) VALUES ($1, $2::time, $3) RETURNING *', [d.atr_id, d.hor_hora, d.hor_cupo ?? 20]);
        return horarioDto(r.rows[0]);
      } catch (e) {
        if (e.code === '23505') throw fail(S.ALREADY_EXISTS, 'HORARIO_DUPLICATE', `La atracción ${d.atr_id} ya tiene un horario a las ${d.hor_hora}.`);
        throw e;
      }
    },

    async ListHorarios(req) {
      const d = v.validar('ListHorariosRequest', req); const p = paginar(d);
      const total = (await q('SELECT count(*)::int AS n FROM horario WHERE atr_id = $1', [d.atr_id])).rows[0].n;
      const r = await q('SELECT * FROM horario WHERE atr_id = $1 ORDER BY hor_hora LIMIT $2 OFFSET $3', [d.atr_id, p.limit, p.offset]);
      return { data: r.rows.map(horarioDto), metadata: meta(total, p) };
    },

    async GenerateAvailability(req) {
      const d = v.validar('GenerateAvailabilityRequest', req);
      const n = diasEntre(d.fecha_desde, d.fecha_hasta);
      if (n < 0) throw fail(S.INVALID_ARGUMENT, 'INVALID_RANGE', 'fecha_hasta no puede ser anterior a fecha_desde.', [{ name: 'fecha_hasta', reason: 'Anterior a fecha_desde' }]);
      if (n + 1 > DIAS_MAX) throw fail(S.INVALID_ARGUMENT, 'RANGE_TOO_LARGE', `El rango máximo es de ${DIAS_MAX} días.`, [{ name: 'fecha_hasta', reason: `Rango mayor a ${DIAS_MAX} días` }]);
      const ids = await tx(async (c) => {
        const r = await c.query(
          `INSERT INTO disponibilidad (atr_id, hor_id, dis_fecha, dis_cupo_total)
           SELECT h.atr_id, h.hor_id, g::date, h.hor_cupo
             FROM horario h CROSS JOIN generate_series($2::date, $3::date, interval '1 day') g
            WHERE h.atr_id = $1 AND h.hor_activo
              AND NOT EXISTS (SELECT 1 FROM fecha_bloqueada fb WHERE fb.atr_id = h.atr_id AND fb.fb_fecha = g::date)
           ON CONFLICT (atr_id, dis_fecha, hor_id) DO NOTHING
           RETURNING dis_id`, [d.atr_id, d.fecha_desde, d.fecha_hasta]);
        return r.rows.map((x) => x.dis_id);
      });
      sincronizarEnSegundoPlano(ids);                       // anuncia a Booking los turnos nuevos
      const horariosActivos = (await q('SELECT count(*)::int AS n FROM horario WHERE atr_id = $1 AND hor_activo', [d.atr_id])).rows[0].n;
      return { creadas: ids.length, omitidas_por_bloqueo_o_existentes: horariosActivos * (n + 1) - ids.length };
    },

    async ListAvailability(req) {
      const d = v.validar('ListAvailabilityRequest', req); const p = paginar(d);
      const w = ['d.atr_id = $1']; const prm = [d.atr_id];
      if (d.fecha_desde) { prm.push(d.fecha_desde); w.push(`d.dis_fecha >= $${prm.length}`); }
      if (d.fecha_hasta) { prm.push(d.fecha_hasta); w.push(`d.dis_fecha <= $${prm.length}`); }
      if (d.solo_con_cupo) w.push('NOT d.dis_cerrada AND d.dis_cupo_total > d.dis_cupo_reservado');
      const where = w.join(' AND ');
      const total = (await q(`SELECT count(*)::int AS n FROM disponibilidad d WHERE ${where}`, prm)).rows[0].n;
      const r = await q(`${SEL} WHERE ${where} ORDER BY d.dis_fecha, h.hor_hora LIMIT $${prm.length + 1} OFFSET $${prm.length + 2}`, [...prm, p.limit, p.offset]);
      return { data: r.rows.map(dto), metadata: meta(total, p) };
    },

    async GetAvailability(req) {
      const d = v.validar('GetAvailabilityRequest', req);
      const av = await leer(d.dis_id);
      if (!av) throw fail(S.NOT_FOUND, 'AVAILABILITY_NOT_FOUND', `No existe la disponibilidad ${d.dis_id}.`);
      return av;
    },

    // Reserva cupos con bloqueo pesimista (SELECT ... FOR UPDATE): con 12 compradores y 5 cupos, solo 5 ganan.
    async ReserveSlots(req) {
      const d = v.validar('SlotChangeRequest', req);
      const res = await tx(async (c) => {
        const r = await c.query(`${SEL} WHERE d.dis_id = $1 FOR UPDATE OF d`, [d.dis_id]);
        if (!r.rows[0]) throw fail(S.NOT_FOUND, 'AVAILABILITY_NOT_FOUND', `No existe la disponibilidad ${d.dis_id}.`);
        const av = dto(r.rows[0]);
        if (av.dis_cerrada) return { success: false, error_code: 'SLOT_CLOSED', message: 'El turno está cerrado.', availability: av };
        if (av.cupos_disponibles < d.cantidad)
          return { success: false, error_code: 'OUT_OF_STOCK', message: `Solo quedan ${av.cupos_disponibles} cupos; se pidieron ${d.cantidad}.`, availability: av };
        await c.query('UPDATE disponibilidad SET dis_cupo_reservado = dis_cupo_reservado + $2 WHERE dis_id = $1', [d.dis_id, d.cantidad]);
        return { success: true, error_code: '', message: 'OK', availability: await leer(d.dis_id, c) };
      });
      if (res.success) sincronizarEnSegundoPlano([d.dis_id]);
      return res;
    },

    // Compensación de la Saga: devuelve los cupos reservados.
    async ReleaseSlots(req) {
      const d = v.validar('SlotChangeRequest', req);
      const res = await tx(async (c) => {
        const r = await c.query(`${SEL} WHERE d.dis_id = $1 FOR UPDATE OF d`, [d.dis_id]);
        if (!r.rows[0]) throw fail(S.NOT_FOUND, 'AVAILABILITY_NOT_FOUND', `No existe la disponibilidad ${d.dis_id}.`);
        const av = dto(r.rows[0]);
        if (d.cantidad > av.dis_cupo_reservado)
          return { success: false, error_code: 'INVALID_RELEASE', message: `Solo hay ${av.dis_cupo_reservado} cupos reservados; no se pueden liberar ${d.cantidad}.`, availability: av };
        await c.query('UPDATE disponibilidad SET dis_cupo_reservado = dis_cupo_reservado - $2 WHERE dis_id = $1', [d.dis_id, d.cantidad]);
        return { success: true, error_code: '', message: 'OK', availability: await leer(d.dis_id, c) };
      });
      if (res.success) sincronizarEnSegundoPlano([d.dis_id]);
      return res;
    },

    async BlockDate(req) {
      const d = v.validar('BlockDateRequest', req);
      const { fila, ids } = await tx(async (c) => {
        let f;
        try { f = (await c.query('INSERT INTO fecha_bloqueada (atr_id, fb_fecha, fb_motivo) VALUES ($1, $2, $3) RETURNING *', [d.atr_id, d.fb_fecha, d.fb_motivo])).rows[0]; }
        catch (e) { if (e.code === '23505') throw fail(S.ALREADY_EXISTS, 'DATE_ALREADY_BLOCKED', `La fecha ${d.fb_fecha} ya estaba bloqueada para la atracción ${d.atr_id}.`); throw e; }
        const cerrados = await c.query('UPDATE disponibilidad SET dis_cerrada = TRUE WHERE atr_id = $1 AND dis_fecha = $2 RETURNING dis_id', [d.atr_id, d.fb_fecha]);
        return { fila: f, ids: cerrados.rows.map((x) => x.dis_id) };
      });
      sincronizarEnSegundoPlano(ids);                       // Booking queda con 0 unidades en esos turnos
      return { fb_id: fila.fb_id, atr_id: fila.atr_id, fb_fecha: fila.fb_fecha, fb_motivo: fila.fb_motivo, slots_cerrados: ids.length };
    },

    async SyncToBooking(req) {
      const d = v.validar('SyncRequest', req);
      if (!(await leer(d.dis_id))) throw fail(S.NOT_FOUND, 'AVAILABILITY_NOT_FOUND', `No existe la disponibilidad ${d.dis_id}.`);
      return sincronizar(d.dis_id);
    },

    async GetSyncStatus(req) { v.validar('Empty', req); return { ...estado }; },
  };
}
