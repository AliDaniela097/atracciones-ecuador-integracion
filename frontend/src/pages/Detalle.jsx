import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, hoyEC, usd, uuid } from '../api.js';
import { Campo, Cargando, Error_, Insignia, Ok } from '../components/ui.jsx';
import { useSesion } from '../App.jsx';
import { Foto } from '../components/Arte.jsx';

export default function Detalle() {
  const { id } = useParams(); const s = useSesion();
  const [a, setA] = useState(null); const [err, setErr] = useState(null);
  const [fecha, setFecha] = useState(hoyEC(1)); const [disp, setDisp] = useState(null); const [dErr, setDErr] = useState(null);
  const [turno, setTurno] = useState(''); const [adultos, setAdultos] = useState(1); const [ninos, setNinos] = useState(0);
  const [cl, setCl] = useState({ full_name: '', email: '', phone: '', document_type: 'CEDULA', document_id: '' }); const [pago, setPago] = useState('CREDIT_CARD');
  const [res, setRes] = useState(null); const [rErr, setRErr] = useState(null); const [enviando, setEnviando] = useState(false); const [clave, setClave] = useState(uuid());

  useEffect(() => { api('GET', `/atracciones/${id}`, { auth: false }).then(setA).catch(setErr); }, [id]);
  const cargarDisp = () => { setDErr(null); setTurno(''); api('GET', `/atracciones/${id}/disponibilidad`, { query: { date: fecha }, auth: false }).then(setDisp).catch((e) => { setDisp(null); setDErr(e); }); };
  useEffect(() => { cargarDisp(); }, [id, fecha]); // eslint-disable-line
  useEffect(() => { if (s?.user) setCl((c) => ({ ...c, full_name: c.full_name || `${s.user.nombre ?? ''} ${s.user.apellido ?? ''}`.trim(), email: c.email || s.user.email })); }, [s]);

  const slot = disp?.time_slots?.find((t) => t.slot_id === turno);
  const total = slot ? adultos * (slot.price_adult ?? 0) + ninos * (slot.price_child ?? 0) : 0;
  const reservar = async (e) => {
    e.preventDefault(); setRErr(null); setEnviando(true);
    try {
      const r = await api('POST', '/atracciones/reservas', { headers: { 'Idempotency-Key': clave }, body: {
        attraction_id: a.id, slot_id: slot.slot_id, date: fecha, time: slot.time_24h?.slice(0, 5) ?? slot.time, adult_count: Number(adultos), child_count: Number(ninos),
        customer: { ...cl, phone: cl.phone.replace(/[\s-]/g, '') }, payment_method: { method: pago } } });
      setRes(r); setClave(uuid()); cargarDisp();
    } catch (x) { setRErr(x); } finally { setEnviando(false); }
  };
  const c = (k) => ({ value: cl[k], onChange: (e) => setCl({ ...cl, [k]: e.target.value }) });

  if (err) return <Error_ e={err} />;
  if (!a) return <Cargando />;
  return (
    <article className="detalle">
      <Link to="/" className="volver">‹ Volver a las atracciones</Link>
      <div className="detalle-cuerpo">
        <div className="detalle-info">
          <Foto className="arco" src={a.photos?.[0]} alt={a.name ?? a.nombre} clave={a.id ?? a.name} texto={`${a.name ?? a.nombre} ${a.city ?? a.ciudad}`} />
          <div>
            <h1>{a.name ?? a.nombre}</h1>
            <div className="datos">
              <span>{a.city ?? a.ciudad}</span><span>{a.duration ?? a.duracion}</span>
              {(a.meeting_point ?? a.punto_encuentro) && <span>Encuentro: {a.meeting_point ?? a.punto_encuentro}</span>}
            </div>
            <h2>Sobre esta experiencia</h2>
            <p className="descripcion">{a.description ?? a.descripcion ?? a.short_description}</p>
          </div>
        </div>

      <section className="reserva">
        <h2>Disponibilidad y reserva</h2>
        <Campo etiqueta="Fecha"><input type="date" min={hoyEC(0)} value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo>
        <Error_ e={dErr} />
        {!disp ? null : !disp.time_slots?.length ? <p className="vacio">No hay turnos para esa fecha.</p> : (
          <div className="turnos">
            {disp.time_slots.map((t) => (
              <button type="button" key={t.slot_id} disabled={t.available_slots < 1} className={`turno ${turno === t.slot_id ? 'sel' : ''}`} onClick={() => setTurno(t.slot_id)}>
                <strong>{t.time}</strong><span>{t.available_slots} de {t.total_slots} cupos</span><Insignia estado={t.status} />
              </button>
            ))}
          </div>
        )}
        {res ? (
          <div className="alerta ok" role="status">
            <h3>¡Reserva confirmada! {res.reservation_code}</h3>
            <p>Total: {usd(res.total_price)} · Estado: {res.status}</p>
            <p><a href={res.ics_calendar_url} target="_blank" rel="noreferrer">Agregar a mi calendario (.ics)</a></p>
            <p className="meta">Presenta tu código y tu documento al guía en el punto de encuentro.</p>
            <button type="button" onClick={() => setRes(null)}>Hacer otra reserva</button>
          </div>
        ) : !s ? <p className="aviso">Para reservar, <Link to="/login">ingresa</Link> o <Link to="/registro">crea una cuenta</Link>.</p> : slot && (
          <form className="formulario" onSubmit={reservar}>
            <Error_ e={rErr} />
            <div className="fila"><Campo etiqueta="Adultos"><input type="number" min={1} max={20} value={adultos} onChange={(e) => setAdultos(e.target.value)} /></Campo>
              <Campo etiqueta="Niños"><input type="number" min={0} max={20} value={ninos} onChange={(e) => setNinos(e.target.value)} /></Campo></div>
            <Campo etiqueta="Nombre completo"><input required {...c('full_name')} /></Campo>
            <Campo etiqueta="Correo"><input type="email" required {...c('email')} /></Campo>
            <Campo etiqueta="Teléfono" ayuda="Ej. 0991234567 o +593991234567"><input required {...c('phone')} /></Campo>
            <div className="fila"><Campo etiqueta="Documento"><select {...c('document_type')}><option value="CEDULA">Cédula</option><option value="PASAPORTE">Pasaporte</option><option value="RUC">RUC</option></select></Campo>
              <Campo etiqueta="Número"><input required {...c('document_id')} /></Campo></div>
            <Campo etiqueta="Método de pago"><select value={pago} onChange={(e) => setPago(e.target.value)}><option value="CREDIT_CARD">Tarjeta de crédito</option><option value="DEBIT_CARD">Tarjeta de débito</option><option value="TRANSFER">Transferencia</option><option value="ON_SITE">Pago en el sitio</option></select></Campo>
            <p className="total">Total estimado: <strong>{usd(total)}</strong></p>
            <button disabled={enviando}>{enviando ? 'Reservando…' : 'Confirmar reserva'}</button>
            <p className="meta">Pago simulado: no se hace ningún cobro real.</p>
          </form>
        )}
      </section>
      </div>
    </article>
  );
}
