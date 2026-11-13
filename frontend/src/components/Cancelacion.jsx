import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { api, usd, uuid } from '../api.js';
import { Error_ } from './ui.jsx';

// Regla oficial del RDA2: se puede cancelar (con reembolso simulado del 100%) hasta N horas ANTES del turno y mientras no haya check-in.
// La política (N horas y fecha límite) la calcula el backend y llega en `cancellation_policy`; aquí solo se muestra u oculta el botón.
// El backend sigue siendo quien decide: si rechaza, se muestra su mensaje.
export function estadoCancelacion(r, ahora = Date.now()) {
  if (r.status === 'CANCELLED') return { tipo: 'cancelada' };
  if (r.status === 'CHECKED_IN' || r.status === 'COMPLETED') return { tipo: 'checkin' };
  if (r.status !== 'CONFIRMED') return { tipo: 'otro' };
  const p = r.cancellation_policy;
  const horas = p?.deadline_hours ?? 24;
  if (p && !p.free_cancellation) return { tipo: 'no_permitida' };
  if (p?.cancellable_until && ahora > new Date(p.cancellable_until).getTime()) return { tipo: 'fuera_plazo', horas };
  return { tipo: 'cancelable', horas, hasta: p?.cancellable_until };
}

export const fechaCorta = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const limite = (iso) => new Date(iso).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Acciones de cancelación de UNA reserva: botón, avisos, modal de confirmación y modal de éxito.
// onCambio(reservaCancelada) avisa al padre para que actualice la reserva y refresque el stock.
export default function AccionesReserva({ reserva, onCambio }) {
  const [confirmando, setConfirmando] = useState(false); const [enviando, setEnviando] = useState(false);
  const [err, setErr] = useState(null); const [exito, setExito] = useState(null);
  const est = estadoCancelacion(reserva);
  const personas = reserva.ticket_count ?? (reserva.adult_count + reserva.child_count);

  const cancelar = async () => {
    setErr(null); setEnviando(true);
    try {
      const c = await api('POST', `/atracciones/reservas/${reserva.reservation_id}/cancel`, {
        headers: { 'Idempotency-Key': uuid() }, body: { solicitante: 'CLIENTE', reason: 'Cancelada por el cliente desde la web' } });
      setConfirmando(false); setExito(c);
    } catch (x) { setErr(x); } finally { setEnviando(false); }
  };
  const cerrarExito = () => { const c = exito; setExito(null); onCambio?.(c); };

  return (
    <>
      {est.tipo === 'cancelable' && (
        <div className="cancel-bloque">
          <p className="cancel-nota">
            {est.hasta ? <>Puedes cancelar hasta el <strong>{limite(est.hasta)}</strong> ({est.horas} h antes del turno), siempre que no hayas hecho check-in. Reembolso simulado del 100%.</>
              : <>Puedes cancelar hasta {est.horas} h antes del turno, siempre que no hayas hecho check-in. Reembolso simulado del 100%.</>}
          </p>
          <button type="button" className="sec peligro" onClick={() => { setErr(null); setConfirmando(true); }}>Cancelar reserva</button>
        </div>
      )}
      {est.tipo === 'fuera_plazo' && <p className="cancel-nota aviso" role="status">Cancelación no disponible (menos de {est.horas}h antes del inicio de la actividad). La política de cancelación gratuita aplica hasta {est.horas}h antes.</p>}
      {est.tipo === 'checkin' && <p className="cancel-nota fijo" role="status"><span className="exito-badge">Check-in realizado</span> Servicio iniciado, no cancelable.</p>}
      {est.tipo === 'no_permitida' && <p className="cancel-nota aviso" role="status">Esta atracción no admite cancelación.</p>}
      {est.tipo === 'cancelada' && reserva.reembolso_id && <p className="cancel-nota fijo" role="status">Reserva cancelada. Reembolso simulado del 100% ({usd(reserva.monto_reembolsado)}), código {reserva.reembolso_id}.</p>}

      {confirmando && createPortal(
        <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar cancelación" onKeyDown={(e) => { if (e.key === 'Escape' && !enviando) setConfirmando(false); }}>
          <div className="formulario">
            <h2>¿Cancelar la reserva {reserva.reservation_code}?</h2>
            <p>Se anulará la reserva de <strong>{personas} {personas === 1 ? 'persona' : 'personas'}</strong> en «{reserva.attraction_name}» y se liberarán los cupos. Recibirás un reembolso simulado del 100% ({usd(reserva.total_price)}).</p>
            <Error_ e={err} />
            <div className="fila">
              <button type="button" className="peligro-solido" disabled={enviando} onClick={cancelar}>{enviando ? 'Cancelando…' : 'Sí, cancelar reserva'}</button>
              <button type="button" className="sec" autoFocus disabled={enviando} onClick={() => setConfirmando(false)}>Volver</button>
            </div>
          </div>
        </div>, document.body)}

      {exito && createPortal(
        <div className="modal" role="dialog" aria-modal="true" aria-label="Cancelación exitosa">
          <div className="formulario">
            <span className="exito-badge">✓ Cancelación y reembolso exitosos</span>
            <h2>¡Cancelación y Reembolso Exitosos!</h2>
            <ul className="exito-lista">
              <li><span>Código de reembolso</span><strong>{exito.refund?.refund_id ?? exito.reembolso_id}</strong></li>
              <li><span>Monto reembolsado</span><strong>100% ({usd(exito.refund?.amount ?? exito.monto_reembolsado)})</strong></li>
              <li><span>Stock reincorporado</span><strong>✓ Cupos liberados ({exito.stock_restoration?.restored_spots ?? personas})</strong></li>
            </ul>
            <p className="meta">Reembolso simulado: no se hace ningún movimiento de dinero real.</p>
            <button type="button" autoFocus onClick={cerrarExito}>Cerrar</button>
          </div>
        </div>, document.body)}
    </>
  );
}
