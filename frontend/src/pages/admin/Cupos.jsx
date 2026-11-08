import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, hoyEC } from '../../api.js';
import { Campo, Cargando, Error_, Ok } from '../../components/ui.jsx';

export default function Cupos() {
  const { id } = useParams();
  const [a, setA] = useState(null); const [t, setT] = useState(null); const [err, setErr] = useState(null); const [ok, setOk] = useState('');
  const [r, setR] = useState({ desde: hoyEC(0), hasta: hoyEC(14) });
  const [vivo, setVivo] = useState(true); const [edit, setEdit] = useState({}); const [guardando, setGuardando] = useState(null); const [actualizado, setActualizado] = useState(null);
  const rango = useRef(r); rango.current = r; const editando = useRef(edit); editando.current = edit;

  const cargar = useCallback(() => Promise.all([api('GET', `/admin/atracciones/${id}`), api('GET', `/admin/atracciones/${id}/turnos`, { query: { desde: rango.current.desde, hasta: rango.current.hasta, limit: 200 } })])
    .then(([x, y]) => { setA(x); setT(y.data ?? y); setErr(null); setActualizado(new Date()); }).catch(setErr), [id]);
  useEffect(() => { cargar(); }, [cargar]);
  // Refresco en vivo (cada 4 s): permite ver bajar los cupos cuando Booking reserva. Se pausa mientras se edita un valor.
  useEffect(() => { if (!vivo) return undefined; const h = setInterval(() => { if (!Object.keys(editando.current).length) cargar(); }, 4000); return () => clearInterval(h); }, [vivo, cargar]);

  const generar = async (e) => { e.preventDefault(); setOk(''); try { const x = await api('POST', `/admin/atracciones/${id}/turnos/generar`, { body: r }); setOk(`${x.turnos_creados} turno(s) nuevo(s). El stock se envía a Booking automáticamente.`); cargar(); } catch (z) { setErr(z); } };
  const guardar = async (x, cambios, msg) => {
    setErr(null); setOk(''); setGuardando(x.id);
    try { await api('PATCH', `/admin/turnos/${x.id}`, { body: cambios }); setOk(`${x.fecha} ${x.hora}: ${msg}. Stock reenviado a Booking.`); setEdit(({ [x.id]: _, ...resto }) => resto); await cargar(); }
    catch (z) { setErr(z); } finally { setGuardando(null); }
  };

  if (!a && !err) return <Cargando />;
  return (
    <section>
      <Link to="/admin/atracciones">‹ Mis atracciones</Link>
      <h1>Cupos: {a?.nombre}</h1>
      <p className="meta">Aquí ves el stock real de cada turno. Si cambias un cupo o cierras un turno, tu sistema avisa a Booking en el momento. {a && <Link to={`/admin/atracciones/${id}/editar`}>Editar datos y tarifas</Link>}</p>
      <Error_ e={err} /><Ok>{ok}</Ok>
      <form className="filtros" onSubmit={generar}>
        <Campo etiqueta="Desde"><input type="date" value={r.desde} onChange={(e) => setR({ ...r, desde: e.target.value })} /></Campo>
        <Campo etiqueta="Hasta"><input type="date" min={r.desde} value={r.hasta} onChange={(e) => setR({ ...r, hasta: e.target.value })} /></Campo>
        <button>Generar turnos</button><button type="button" className="sec" onClick={cargar}>Actualizar ahora</button>
        <label className="chk"><input type="checkbox" checked={vivo} onChange={(e) => setVivo(e.target.checked)} /> En vivo (cada 4 s){actualizado && vivo ? ` · ${actualizado.toLocaleTimeString('es-EC')}` : ''}</label>
      </form>
      {!t ? null : !t.length ? <p className="vacio">No hay turnos en ese rango.</p> : (
        <div className="scroll"><table><thead><tr><th>Fecha</th><th>Hora</th><th>Cupo total</th><th>Reservados</th><th>Disponibles</th><th>Estado</th><th></th></tr></thead>
          <tbody>{t.map((x) => {
            const valor = edit[x.id] ?? x.cupo_total; const cambio = edit[x.id] !== undefined && Number(edit[x.id]) !== x.cupo_total;
            return (
              <tr key={x.id}><td>{x.fecha}</td><td>{x.hora}</td>
                <td><input className="num" type="number" min={Math.max(1, x.cupo_reservado)} max={500} value={valor} aria-label={`Cupo total ${x.fecha} ${x.hora}`} onChange={(e) => setEdit({ ...edit, [x.id]: e.target.value })} /></td>
                <td>{x.cupo_reservado}</td><td><strong>{x.cupos_disponibles}</strong></td><td>{x.cerrado ? 'CERRADO' : x.estado}</td>
                <td className="acc">
                  {cambio && <><button disabled={guardando === x.id} onClick={() => guardar(x, { cupo_total: Number(edit[x.id]) }, `cupo total ${x.cupo_total} → ${edit[x.id]}`)}>Guardar</button><button className="sec" onClick={() => setEdit(({ [x.id]: _, ...resto }) => resto)}>Cancelar</button></>}
                  {!cambio && <button className="sec" disabled={guardando === x.id} onClick={() => guardar(x, { cerrado: !x.cerrado }, x.cerrado ? 'turno reabierto' : 'turno cerrado')}>{x.cerrado ? 'Reabrir' : 'Cerrar'}</button>}
                </td></tr>);
          })}</tbody></table></div>
      )}
    </section>
  );
}
