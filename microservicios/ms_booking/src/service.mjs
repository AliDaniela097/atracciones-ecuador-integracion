// Lógica de ms_booking: reservas y pasajeros. Estados: PENDIENTE_PAGO -> CONFIRMADA -> COMPLETADA, y CANCELADA desde los dos primeros.
import { randomInt } from 'node:crypto';
import { q, tx, paginar, meta, iso } from './lib/db.mjs';
import { fail, S } from './lib/errors.mjs';

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codigo = () => `DEC-${Array.from({ length: 6 }, () => ALFABETO[randomInt(ALFABETO.length)]).join('')}`;     // DEC-7F3K9Q
const dinero = (c) => (c / 100).toFixed(2);

async function cargar(c, where, params) {
  const r = await c.query(`SELECT r.*, e.est_codigo FROM reserva r JOIN estado e ON e.est_id = r.est_id WHERE ${where}`, params);
  const x = r.rows[0]; if (!x) return null;
  const pax = (await c.query('SELECT * FROM reserva_pasajero WHERE res_id = $1 ORDER BY pax_es_titular DESC, pax_id', [x.res_id])).rows;
  return {
    res_id: x.res_id, res_uuid: x.res_uuid, res_codigo: x.res_codigo, det_id: x.det_id, dis_id: x.dis_id, est_codigo: x.est_codigo,
    res_adultos: x.res_adultos, res_ninos: x.res_ninos, res_numero_tickets: x.res_numero_tickets, res_precio_unitario: x.res_precio_unitario, res_subtotal: x.res_subtotal,
    res_observaciones: x.res_observaciones ?? '', res_motivo_cancelacion: x.res_motivo_cancelacion ?? '',
    res_creado_en: iso(x.res_creado_en), res_actualizado_en: iso(x.res_actualizado_en), res_cancelado_en: iso(x.res_cancelado_en), res_confirmado_en: iso(x.res_confirmado_en),
    pasajeros: pax.map((p) => ({ pax_id: p.pax_id, pax_nombre: p.pax_nombre, pax_documento: p.pax_documento ?? '', pax_fecha_nacimiento: p.pax_fecha_nacimiento ?? '', pax_es_titular: p.pax_es_titular })),
  };
}
const dondeRef = (d) => (d.res_uuid ? ['r.res_uuid = $1', [d.res_uuid]] : ['r.res_codigo = $1', [d.res_codigo]]);
const noEncontrada = (d) => fail(S.NOT_FOUND, 'RESERVATION_NOT_FOUND', `No existe la reserva ${d.res_uuid ?? d.res_codigo}.`);

export function crearServicio(v) {
  // Cambio de estado con bloqueo de fila: solo se permite desde los estados indicados.
  async function cambiar(d, desde, hacia, extraSql = '', extraParams = []) {
    return tx(async (c) => {
      const [w, p] = dondeRef(d);
      const r = await c.query(`SELECT r.res_id, e.est_codigo FROM reserva r JOIN estado e ON e.est_id = r.est_id WHERE ${w} FOR UPDATE OF r`, p);
      if (!r.rows[0]) throw noEncontrada(d);
      const actual = r.rows[0].est_codigo;
      if (!desde.includes(actual)) throw fail(S.FAILED_PRECONDITION, 'INVALID_TRANSITION', `No se puede pasar de ${actual} a ${hacia}.`);
      await c.query(`UPDATE reserva SET est_id = (SELECT est_id FROM estado WHERE est_codigo = $2)${extraSql} WHERE res_id = $1`, [r.rows[0].res_id, hacia, ...extraParams]);
      return cargar(c, 'r.res_id = $1', [r.rows[0].res_id]);
    });
  }

  return {
    async CreateReservation(req) {
      const d = v.validar('CreateReservationRequest', req);
      const ninos = d.res_ninos ?? 0; const tickets = d.res_adultos + ninos;
      const titulares = d.pasajeros.filter((p) => p.pax_es_titular === true).length;
      if (titulares !== 1) throw fail(S.INVALID_ARGUMENT, 'HOLDER_REQUIRED', 'Debe haber exactamente un pasajero titular (pax_es_titular=true).', [{ name: 'pasajeros', reason: `Titulares recibidos: ${titulares}` }]);
      if (d.pasajeros.length > tickets) throw fail(S.INVALID_ARGUMENT, 'TOO_MANY_PASSENGERS', `Hay ${d.pasajeros.length} pasajeros para ${tickets} tickets.`, [{ name: 'pasajeros', reason: `Máximo ${tickets}` }]);
      const subtotalC = tickets * Math.round(d.res_precio_unitario * 100);
      return tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock($1)', [d.det_id]);                // evita dos reservas simultáneas para la misma línea de orden
        const dup = await c.query("SELECT 1 FROM reserva r JOIN estado e ON e.est_id = r.est_id WHERE r.det_id = $1 AND e.est_codigo <> 'CANCELADA'", [d.det_id]);
        if (dup.rowCount) throw fail(S.ALREADY_EXISTS, 'RESERVATION_ALREADY_EXISTS', `La línea de orden ${d.det_id} ya tiene una reserva activa.`);
        let resId;
        for (let i = 0; i < 5 && !resId; i++) {
          const r = await c.query(
            `INSERT INTO reserva (res_codigo, det_id, dis_id, est_id, res_adultos, res_ninos, res_numero_tickets, res_precio_unitario, res_subtotal, res_observaciones)
             VALUES ($1, $2, $3, (SELECT est_id FROM estado WHERE est_codigo = 'PENDIENTE_PAGO'), $4, $5, $6, $7, $8, $9)
             ON CONFLICT (res_codigo) DO NOTHING RETURNING res_id`,
            [codigo(), d.det_id, d.dis_id, d.res_adultos, ninos, tickets, dinero(Math.round(d.res_precio_unitario * 100)), dinero(subtotalC), d.res_observaciones ?? null]);
          resId = r.rows[0]?.res_id;
        }
        if (!resId) throw fail(S.INTERNAL, 'RESERVATION_CODE_COLLISION', 'No se pudo generar un código de reserva único.');
        for (const p of d.pasajeros)
          await c.query('INSERT INTO reserva_pasajero (res_id, pax_nombre, pax_documento, pax_fecha_nacimiento, pax_es_titular) VALUES ($1,$2,$3,$4,$5)',
            [resId, p.pax_nombre, p.pax_documento ?? null, p.pax_fecha_nacimiento ?? null, p.pax_es_titular === true]);
        return cargar(c, 'r.res_id = $1', [resId]);
      });
    },

    async GetReservation(req) {
      const d = v.validar('ReservationRef', req); const [w, p] = dondeRef(d);
      const r = await cargar({ query: q }, w, p); if (!r) throw noEncontrada(d); return r;
    },

    async ListReservations(req) {
      const d = v.validar('ListReservationsRequest', req); const p = paginar(d);
      const w = ['TRUE']; const prm = [];
      if (d.est_codigo) { prm.push(d.est_codigo); w.push(`e.est_codigo = $${prm.length}`); }
      if (d.det_id) { prm.push(d.det_id); w.push(`r.det_id = $${prm.length}`); }
      if (d.dis_id) { prm.push(d.dis_id); w.push(`r.dis_id = $${prm.length}`); }
      const base = `FROM reserva r JOIN estado e ON e.est_id = r.est_id WHERE ${w.join(' AND ')}`;
      const total = (await q(`SELECT count(*)::int AS n ${base}`, prm)).rows[0].n;
      const ids = (await q(`SELECT r.res_id ${base} ORDER BY r.res_creado_en DESC, r.res_id DESC LIMIT $${prm.length + 1} OFFSET $${prm.length + 2}`, [...prm, p.limit, p.offset])).rows;
      const data = []; for (const r of ids) data.push(await cargar({ query: q }, 'r.res_id = $1', [r.res_id]));
      return { data, metadata: meta(total, p) };
    },

    async ConfirmReservation(req) { const d = v.validar('ReservationRef', req); return cambiar(d, ['PENDIENTE_PAGO'], 'CONFIRMADA', ', res_confirmado_en = now()'); },
    async CompleteReservation(req) { const d = v.validar('ReservationRef', req); return cambiar(d, ['CONFIRMADA'], 'COMPLETADA'); },
    async CancelReservation(req) {
      const d = v.validar('CancelReservationRequest', req);
      return cambiar(d, ['PENDIENTE_PAGO', 'CONFIRMADA'], 'CANCELADA', ', res_cancelado_en = now(), res_motivo_cancelacion = $3', [d.res_motivo_cancelacion]);
    },
  };
}
