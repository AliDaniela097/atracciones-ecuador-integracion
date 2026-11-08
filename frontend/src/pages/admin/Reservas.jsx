import React, { useEffect, useState } from 'react';
import { api, usd } from '../../api.js';
import { Campo, Cargando, Error_, Insignia, Ok, Paginacion } from '../../components/ui.jsx';
import { useSesion } from '../../App.jsx';

const AVISO = { ENVIADO: 'Booking fue notificado.', PENDIENTE_REINTENTO: 'Booking no respondió; se reintentará automáticamente.', NO_CONFIGURADO: 'Check-in guardado; la notificación a Booking no está configurada.', RECHAZADO: 'Check-in guardado, pero Booking rechazó la notificación.' };

export default function Reservas() {
  const s = useSesion();
  const [f, setF] = useState({ q: '', estado: '' }); const [d, setD] = useState(null); const [err, setErr] = useState(null); const [ok, setOk] = useState('');
  const [sel, setSel] = useState(null); const [form, setForm] = useState({ documento: '', asistentes: '', obs: '' }); const [mErr, setMErr] = useState(null); const [env, setEnv] = useState(false);
  const cargar = (page = 1) => api('GET', '/admin/reservas', { query: { q: f.q, estado: f.estado, page, limit: 15 } }).then((r) => { setD(r); setErr(null); }).catch(setErr);
  useEffect(() => { cargar(); }, []); // eslint-disable-line

  const abrir = (r) => { setSel(r); setMErr(null); setForm({ documento: '', asistentes: String(r.adult_count + r.child_count), obs: '' }); };
  const confirmar = async (e) => {
    e.preventDefault(); setMErr(null); setEnv(true);
    try {
      const r = await api('POST', `/atracciones/reservas/${sel.reservation_id}/checkin`, { body: {
        documento_identidad: form.documento.trim(), asistentes_reales: Number(form.asistentes), admin_id: s?.user?.id ?? undefined, ...(form.obs && { observaciones: form.obs }) } });
      setOk(`Asistencia confirmada para ${sel.reservation_code} (CONFIRMADO_ASISTIDO). ${AVISO[r?.booking_checkin?.estado] ?? ''}`); setSel(null); cargar(d?.metadata?.page ?? 1);
    } catch (x) { setMErr(x); } finally { setEnv(false); }
  };
  const cancelar = async (r) => {
    if (!window.confirm(`¿Cancelar la reserva ${r.reservation_code}? Se liberará el cupo.`)) return;
    try { await api('POST', `/atracciones/reservas/${r.reservation_id}/cancel`, { body: { solicitante: 'ADMIN' } }); setOk(`Reserva ${r.reservation_code} cancelada.`); cargar(d?.metadata?.page ?? 1); } catch (x) { setErr(x); }
  };

  return (
    <section>
      <h1>Reservas y check-in</h1>
      <p className="meta">Busca al turista por código de reserva, cédula o correo. Al confirmar la asistencia, la reserva pasa de RESERVADO a CONFIRMADO_ASISTIDO y se avisa a Booking.</p>
      <form className="filtros" onSubmit={(e) => { e.preventDefault(); cargar(1); }}>
        <input placeholder="Código de reserva, cédula, correo o nombre" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Buscar reserva" />
        <select value={f.estado} onChange={(e) => setF({ ...f, estado: e.target.value })} aria-label="Estado"><option value="">Todos los estados</option><option value="CONFIRMED">RESERVADO (pendiente de asistencia)</option><option value="CHECKED_IN">CONFIRMADO_ASISTIDO</option><option value="CANCELLED">CANCELADA</option></select>
        <button>Buscar</button>
      </form>
      <Ok>{ok}</Ok><Error_ e={err} />
      {!d ? <Cargando /> : !d.data.length ? <p className="vacio">No hay reservas con esos criterios.</p> : (
        <div className="scroll"><table><thead><tr><th>Código</th><th>Atracción</th><th>Fecha</th><th>Cliente</th><th>Personas</th><th>Total</th><th>Estado</th><th></th></tr></thead>
          <tbody>{d.data.map((r) => (
            <tr key={r.reservation_id}><td><strong>{r.reservation_code}</strong></td><td className="nom">{r.attraction_name}</td><td className="nw">{r.date} {r.time}</td><td>{r.customer?.full_name}<br /><small>{r.customer?.document_id}</small></td>
              <td>{r.adult_count + r.child_count}</td><td>{usd(r.total_price)}</td><td><Insignia estado={r.status} /></td>
              <td className="acc">{r.status === 'CONFIRMED' && <><button onClick={() => abrir(r)}>Check-in / Confirmar asistencia</button> <button className="sec" onClick={() => cancelar(r)}>Cancelar</button></>}</td></tr>))}</tbody></table></div>
      )}
      <Paginacion meta={d?.metadata} onPagina={cargar} />
      {sel && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar asistencia">
          <form className="formulario" onSubmit={confirmar}>
            <h2>Confirmar asistencia · {sel.reservation_code}</h2>
            <p>{sel.attraction_name} · {sel.customer?.full_name}</p>
            <Error_ e={mErr} />
            <Campo etiqueta="Documento de identidad del cliente" ayuda="Debe coincidir con el de la reserva."><input required autoFocus value={form.documento} onChange={(e) => setForm({ ...form, documento: e.target.value })} /></Campo>
            <Campo etiqueta="Asistentes reales"><input type="number" min="1" required value={form.asistentes} onChange={(e) => setForm({ ...form, asistentes: e.target.value })} /></Campo>
            <Campo etiqueta="Observaciones (opcional)"><input value={form.obs} onChange={(e) => setForm({ ...form, obs: e.target.value })} /></Campo>
            <div className="fila"><button disabled={env}>{env ? 'Confirmando…' : 'Confirmar asistencia'}</button><button type="button" className="sec" onClick={() => setSel(null)}>Cerrar</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
