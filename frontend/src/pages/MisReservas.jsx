import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, usd } from '../api.js';
import { Cargando, Insignia } from '../components/ui.jsx';
import AccionesReserva, { fechaCorta } from '../components/Cancelacion.jsx';
import { misReservas } from '../misReservas.js';
import { useSesion } from '../App.jsx';
import { useSondeo } from '../sondeo.js';

const CADA_MS = 4500;      // sondeo silencioso: entre 4 y 5 s
const MAX_SONDEO = 12;     // solo se consultan las 12 reservas vigentes más recientes: 12 × 13 ciclos/min ≈ 160 peticiones/min (el límite es 300)
const hora = (d) => d.toLocaleTimeString('es-EC', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Huella de lo que se ve en la tarjeta: si no cambia, no se vuelve a dibujar.
const huella = (r) => [r.status, r.date, r.time, r.ticket_count, r.total_price, r.reembolso_id, r.monto_reembolsado,
  r.cancellation_policy?.free_cancellation, r.cancellation_policy?.cancellable_until].join('|');
// Una reserva ya cancelada o con check-in no vuelve a estar vigente: ignora respuestas atrasadas que digan lo contrario.
const retrocede = (antes, nueva) => antes.status !== 'CONFIRMED' && nueva.status === 'CONFIRMED';

const Tarjeta = memo(function Tarjeta({ r, ahora, onCambio }) { // eslint-disable-line no-unused-vars
  return (
    <article className="reserva-card" aria-label={`Reserva ${r.reservation_code}`}>
      <div className="stock-cab">
        <div><h2>{r.attraction_name}</h2><p className="meta">Código <strong>{r.reservation_code}</strong></p></div>
        <Insignia key={r.status} estado={r.status} />
      </div>
      <div className="datos"><span>{fechaCorta(r.date)} · {r.time}</span><span>{r.ticket_count} {r.ticket_count === 1 ? 'persona' : 'personas'}</span><span>Total {usd(r.total_price)}</span></div>
      <AccionesReserva reserva={r} onCambio={onCambio} />
    </article>
  );
});

export default function MisReservas() {
  const s = useSesion(); const email = s?.user?.email;
  const [lista, setLista] = useState(null); const [aviso, setAviso] = useState('');
  const [actualizado, setActualizado] = useState(null); const [ahora, setAhora] = useState(Date.now());
  const vigentes = useRef([]);

  // silencioso = true: sondeo en segundo plano. No muestra «Cargando», no avisa de errores y solo cambia las tarjetas cuyo estado cambió.
  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (!email) return;
    const ids = silencioso ? vigentes.current.slice(0, MAX_SONDEO) : misReservas.leer(email);
    if (!ids.length && silencioso) return;
    const r = await Promise.all(ids.map(async (id) => {
      try { return await api('GET', `/atracciones/reservas/${id}`); }
      catch (e) {
        if (e.status === 429 && silencioso) throw e;
        if (e.status === 404 && !silencioso) misReservas.quitar(email, id);
        return e.status === 404 ? null : { falla: id };
      }
    }));
    const nuevas = new Map(r.filter((x) => x && !x.falla).map((x) => [x.reservation_id, x]));
    setLista((prev) => {
      const antes = new Map((prev ?? []).map((x) => [x.reservation_id, x]));
      const unir = (v) => { const a = antes.get(v.reservation_id); return a && (huella(a) === huella(v) || retrocede(a, v)) ? a : v; };
      if (silencioso) { // solo reemplaza lo que cambió; el orden y el resto de tarjetas quedan intactos
        if (!prev) return prev;
        let cambio = false;
        const sig = prev.map((x) => { const v = nuevas.get(x.reservation_id); const y = v ? unir(v) : x; if (y !== x) cambio = true; return y; });
        return cambio ? sig : prev;
      }
      const sig = [...nuevas.values()].map(unir);
      return prev && sig.length === prev.length && sig.every((x, i) => x === prev[i]) ? prev : sig;
    });
    if (!silencioso) setAviso(r.some((x) => x?.falla) ? 'No se pudieron cargar algunas reservas. Pulsa «Actualizar» para reintentar.' : '');
    setActualizado(new Date());
  }, [email]);
  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { vigentes.current = (lista ?? []).filter((x) => x.status === 'CONFIRMED').map((x) => x.reservation_id); }, [lista]);
  useEffect(() => { const t = setInterval(() => setAhora(Date.now()), 60000); return () => clearInterval(t); }, []); // el plazo de cancelación se vence aunque nada cambie en el servidor
  useSondeo(() => cargar({ silencioso: true }), { cada: CADA_MS, activo: !!email });

  const actualizar = useCallback((c) => setLista((l) => (l ?? []).map((x) => (x.reservation_id === c.reservation_id ? c : x))), []);

  if (!s) return <section><h1>Mis reservas</h1><p className="aviso">Para ver tus reservas, <Link to="/login">ingresa</Link> o <Link to="/registro">crea una cuenta</Link>.</p></section>;

  return (
    <section>
      <h1>Mis reservas</h1>
      <p className="meta">Aquí aparecen las reservas que hiciste con tu cuenta desde este navegador. Puedes cancelar mientras no hayas hecho check-in y falten al menos 24 horas para el turno.</p>
      <p className="fila-vivo">
        <button type="button" className="sec" onClick={() => cargar()}>Actualizar</button>
        {actualizado && <span className="en-vivo" role="status"><i aria-hidden="true" /> Se actualiza solo · {hora(actualizado)}</span>}
      </p>
      {aviso && <div className="alerta espera" role="status">{aviso}</div>}
      {!lista ? <Cargando /> : !lista.length ? <p className="vacio">Todavía no hiciste reservas desde este navegador. <Link to="/">Ver atracciones</Link></p>
        : lista.map((r) => <Tarjeta key={r.reservation_id} r={r} ahora={ahora} onCambio={actualizar} />)}
    </section>
  );
}
