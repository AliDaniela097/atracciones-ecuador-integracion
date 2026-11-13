import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, hoyEC } from '../../api.js';
import { Campo, Cargando, Error_, Insignia, Ok, Paginacion } from '../../components/ui.jsx';

// Stock en vivo de todas las atracciones. Solo usa endpoints que ya existen (no cambia el backend ni el contrato):
//   GET /admin/atracciones                       → lista paginada (5 por página); acepta q (nombre o código) y estado
//   GET /admin/atracciones/:id/turnos            → cupo total / reservado / disponible por turno del día
//   GET /admin/reservas?estado=CHECKED_IN&…      → total de check-in del día (se lee de metadata.total_results)
//   PATCH /admin/turnos/:id                      → editar el cupo total (el backend reenvía el stock a Booking)
const POR_PAGINA = 5;
const CADA_MS = 6000;          // 5 atracciones × 2 consultas cada 6 s ≈ 100 peticiones/min (el límite es 300)
const ESPERA_429_MS = 20000;   // si el servidor pide calma, se espera antes de volver a consultar
const DESTELLO_MS = 2600;
const BUSQUEDA_MS = 400;        // espera a que termines de escribir antes de buscar
const situacion = (turnos, libres) => (!turnos.length ? 'sin' : libres === 0 ? 'agotada' : 'con');
const fmt = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : ''); // 2026-11-23 → 23/11/2026
const suma = (t, k) => t.reduce((n, x) => n + Number(x[k] ?? 0), 0);

export default function Stock() {
  const [fecha, setFecha] = useState(hoyEC(0)); const [page, setPage] = useState(1);
  const [d, setD] = useState(null); const [err, setErr] = useState(null); const [aviso, setAviso] = useState(''); const [ok, setOk] = useState('');
  const [vivo, setVivo] = useState(true); const [actualizado, setActualizado] = useState(null);
  const [edit, setEdit] = useState({}); const [guardando, setGuardando] = useState(null);
  const [destello, setDestello] = useState({}); const [ocultas, setOcultas] = useState({});
  const [todas, setTodas] = useState(false);
  const [texto, setTexto] = useState(''); const [q, setQ] = useState(''); const [estado, setEstado] = useState(''); const [situ, setSitu] = useState('');
  const previo = useRef({}); const ticket = useRef(0); const espera = useRef(0);

  const cargar = useCallback(async () => {
    const mio = ++ticket.current;
    try {
      const lista = await api('GET', '/admin/atracciones', { query: { page, limit: POR_PAGINA, ...(q && { q }), ...(estado && { estado }) } });
      const filas = await Promise.all(lista.data.map(async (a) => {
        const [t, c] = await Promise.all([
          api('GET', `/admin/atracciones/${a.id}/turnos`, { query: todas ? { limit: 200 } : { desde: fecha, hasta: fecha, limit: 50 } }),
          api('GET', '/admin/reservas', { query: { estado: 'CHECKED_IN', atraccion: a.codigo, ...(!todas && { fecha }), limit: 1 } }),
        ]);
        return { a, turnos: t.data ?? t, recortado: Number(t?.metadata?.total_results ?? 0) > (t.data ?? t).length, checkins: Number(c?.metadata?.total_results ?? 0) };
      }));
      if (mio !== ticket.current) return; // llegó tarde: ya se pidió otra página o fecha
      // Destello: marca lo que cambió desde la última lectura (baja = se vendieron cupos, sube = se liberaron o aumentaron).
      const nuevos = {};
      for (const f of filas) {
        const kc = `c:${f.a.id}:${todas ? 'todas' : fecha}`;
        if (previo.current[kc] !== undefined && previo.current[kc] !== f.checkins) nuevos[kc] = f.checkins > previo.current[kc] ? 'sube' : 'baja';
        previo.current[kc] = f.checkins;
        for (const x of f.turnos) {
          const k = `t:${x.id}`;
          if (previo.current[k] !== undefined && previo.current[k] !== x.cupos_disponibles) nuevos[k] = x.cupos_disponibles < previo.current[k] ? 'baja' : 'sube';
          previo.current[k] = x.cupos_disponibles;
        }
      }
      const claves = Object.keys(nuevos);
      if (claves.length) {
        setDestello((p) => ({ ...p, ...nuevos }));
        setTimeout(() => setDestello((p) => { const n = { ...p }; claves.forEach((k) => { if (n[k] === nuevos[k]) delete n[k]; }); return n; }), DESTELLO_MS);
      }
      setD({ meta: lista.metadata, filas }); setErr(null); setAviso(''); setActualizado(new Date()); espera.current = 0;
    } catch (e) {
      if (mio !== ticket.current) return;
      if (e.status === 429) { espera.current = ESPERA_429_MS; setAviso('El servidor pidió esperar un momento. Se reintenta solo en unos segundos.'); } else setErr(e);
    }
  }, [page, fecha, todas, q, estado]);

  // Ciclo de actualización: una consulta termina antes de empezar la siguiente (nunca se acumulan) y se pausa si la pestaña está oculta.
  useEffect(() => {
    let parar = false; let h;
    const ciclo = async () => {
      if (!document.hidden) await cargar();
      if (parar || !vivo) return;
      h = setTimeout(ciclo, espera.current || CADA_MS);
    };
    ciclo();
    const alVolver = () => { if (!document.hidden && vivo) { clearTimeout(h); ciclo(); } };
    document.addEventListener('visibilitychange', alVolver);
    return () => { parar = true; clearTimeout(h); document.removeEventListener('visibilitychange', alVolver); };
  }, [cargar, vivo]);

  // Búsqueda: espera un momento tras la última tecla y vuelve a la página 1.
  useEffect(() => {
    const t = setTimeout(() => { const v = texto.trim(); if (v !== q) { setQ(v); setPage(1); setEdit({}); } }, BUSQUEDA_MS);
    return () => clearTimeout(t);
  }, [texto, q]);
  const cambiarEstado = (v) => { setEstado(v); setPage(1); setEdit({}); };
  const limpiar = () => { setTexto(''); setQ(''); setEstado(''); setSitu(''); setTodas(false); setFecha(hoyEC(0)); setPage(1); setEdit({}); };
  const cambiarTodas = (v) => { setTodas(v); setPage(1); setEdit({}); setOcultas({}); };
  const hayFiltro = Boolean(texto || q || estado || situ || todas);

  const cambiarFecha = (v) => { setFecha(v || hoyEC(0)); setPage(1); setEdit({}); };
  const valido = (x) => { const n = Number(edit[x.id]); return Number.isInteger(n) && n >= Math.max(1, x.cupo_reservado) && n <= 500; };
  const guardar = async (x) => {
    if (!valido(x)) return;
    setErr(null); setOk(''); setGuardando(x.id);
    try {
      await api('PATCH', `/admin/turnos/${x.id}`, { body: { cupo_total: Number(edit[x.id]) } });
      setOk(`${fmt(x.fecha)} ${x.hora}: cupo total ${x.cupo_total} → ${edit[x.id]}. Stock reenviado a Booking.`);
      setEdit(({ [x.id]: _quitar, ...resto }) => resto); await cargar();
    } catch (z) { setErr(z); } finally { setGuardando(null); }
  };

  const visibles = (d?.filas ?? []).filter((f) => !situ || situacion(f.turnos, suma(f.turnos, 'cupos_disponibles')) === situ);

  return (
    <section>
      <h1>Stock en vivo</h1>
      <p className="meta">Cupos de cada atracción para el día elegido, o para todas las fechas si marcas «Todas las fechas». Se actualiza solo cada {CADA_MS / 1000} segundos: cuando Booking o la web reservan, cancelan o hacen check-in, los números cambian aquí. Solo se edita el cupo total; Booking recibe el cambio al guardar.</p>
      <form className="filtros" onSubmit={(e) => { e.preventDefault(); cargar(); }}>
        <Campo etiqueta="Buscar atracción"><input type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Nombre o código…" aria-label="Buscar atracción por nombre o código" /></Campo>
        <Campo etiqueta="Estado de la atracción">
          <select value={estado} onChange={(e) => cambiarEstado(e.target.value)} aria-label="Filtrar por estado de la atracción">
            <option value="">Todas</option><option value="PUBLICADA">Publicadas</option><option value="INACTIVA">Despublicadas</option><option value="BORRADOR">Borrador</option>
          </select>
        </Campo>
        <Campo etiqueta="Stock (de esta página)">
          <select value={situ} onChange={(e) => setSitu(e.target.value)} aria-label="Filtrar por situación del stock en la página mostrada">
            <option value="">Todo el stock</option><option value="con">Con cupos libres</option><option value="agotada">Agotadas (0 libres)</option><option value="sin">Sin turnos ese día</option>
          </select>
        </Campo>
        <Campo etiqueta="Fecha (dd/mm/aaaa)"><input type="date" value={fecha} disabled={todas} onChange={(e) => cambiarFecha(e.target.value)} /></Campo>
        <label className="chk"><input type="checkbox" checked={todas} onChange={(e) => cambiarTodas(e.target.checked)} /> Todas las fechas</label>
        <button type="submit" className="sec">Actualizar ahora</button>
        {hayFiltro && <button type="button" className="sec" onClick={limpiar}>Limpiar filtros</button>}
        <label className="chk"><input type="checkbox" checked={vivo} onChange={(e) => setVivo(e.target.checked)} /> En vivo (cada {CADA_MS / 1000} s){actualizado && vivo ? ` · ${actualizado.toLocaleTimeString('es-EC')}` : ''}</label>
      </form>
      <Error_ e={err} /><Ok>{ok}</Ok>
      {aviso && <div className="alerta espera" role="status">{aviso}</div>}
      {!d ? (err ? null : <Cargando />) : !d.filas.length ? <p className="vacio">{q || estado ? 'Ninguna atracción coincide con la búsqueda.' : 'No hay atracciones.'}</p>
        : !visibles.length ? <p className="vacio">Ninguna de las {d.filas.length} atracciones de esta página tiene ese stock. Prueba otra página o pulsa «Limpiar filtros».</p>
        : visibles.map(({ a, turnos, checkins, recortado }) => {
        const total = suma(turnos, 'cupo_total'); const reservados = suma(turnos, 'cupo_reservado'); const libres = suma(turnos, 'cupos_disponibles');
        const dc = destello[`c:${a.id}:${todas ? 'todas' : fecha}`]; const abierta = ocultas[a.id] === undefined ? !todas : !ocultas[a.id];
        const dTurnos = turnos.map((x) => destello[`t:${x.id}`]).find(Boolean);
        return (
          <article className="stock-card" key={a.id} aria-label={`Stock de ${a.nombre}`}>
            <div className="stock-cab">
              <div><h2>{a.nombre}</h2><p className="meta">{a.ciudad} · <Insignia estado={a.estado} /> · <Link to={`/admin/atracciones/${a.id}/cupos`}>Gestionar turnos</Link></p></div>
              {turnos.length > 0 && <button type="button" className="sec" aria-expanded={abierta} onClick={() => setOcultas({ ...ocultas, [a.id]: abierta })}>{abierta ? 'Ocultar turnos' : `Ver turnos (${turnos.length})`}</button>}
            </div>
            {!turnos.length ? <p className="vacio">{todas ? 'Sin turnos creados.' : 'Sin turnos para esta fecha.'} <Link to={`/admin/atracciones/${a.id}/cupos`}>Generar turnos</Link></p> : (
              <>
                <div className="stock-kpis">
                  <div className="stock-kpi"><span>Cupo total</span><strong>{total}</strong></div>
                  <div className="stock-kpi"><span>Reservados</span><strong>{reservados}</strong></div>
                  <div className={`stock-kpi ${dc ? `destello-${dc}` : ''}`}><span>Check-in hechos</span><strong>{checkins}</strong></div>
                  <div className={`stock-kpi ${dTurnos ? `destello-${dTurnos}` : ''}`}><span>Disponibles</span><strong>{libres}</strong></div>
                </div>
                {abierta && (
                  <div className="scroll"><table><thead><tr>{todas && <th>Fecha</th>}<th>Hora</th><th>Cupo total</th><th>Reservados</th><th>Disponibles</th><th>Estado</th><th></th></tr></thead>
                    <tbody>{turnos.map((x) => {
                      const cambio = edit[x.id] !== undefined && Number(edit[x.id]) !== x.cupo_total;
                      return (
                        <tr key={x.id} className={destello[`t:${x.id}`] ? `destello-${destello[`t:${x.id}`]}` : ''}>
                          {todas && <td className="nw">{fmt(x.fecha)}</td>}
                          <td>{x.hora}</td>
                          <td><input className="num" type="number" min={Math.max(1, x.cupo_reservado)} max={500} value={edit[x.id] ?? x.cupo_total} aria-label={`Cupo total ${a.nombre} ${x.hora}`} aria-invalid={cambio && !valido(x)} onChange={(e) => setEdit({ ...edit, [x.id]: e.target.value })} /></td>
                          <td>{x.cupo_reservado}</td><td><strong>{x.cupos_disponibles}</strong></td><td>{x.cerrado ? 'CERRADO' : x.estado}</td>
                          <td className="acc">{cambio && <>
                            <button disabled={guardando === x.id || !valido(x)} onClick={() => guardar(x)}>Guardar</button>
                            <button className="sec" onClick={() => setEdit(({ [x.id]: _quitar, ...resto }) => resto)}>Cancelar</button>
                            {!valido(x) && <small className="invalido">Mínimo {Math.max(1, x.cupo_reservado)} (ya reservados), máximo 500.</small>}
                          </>}</td>
                        </tr>);
                    })}</tbody></table></div>
                )}
                {recortado && abierta && <p className="meta">Se muestran los primeros 200 turnos de esta atracción; elige un día para ver el resto.</p>}
              </>
            )}
          </article>);
      })}
      {d?.meta && <p className="meta">{d.meta.total_results} atracción(es){q ? ` para «${q}»` : ''}. Mostrando {visibles.length} de {d.filas.length} en esta página.</p>}
      <Paginacion meta={d?.meta} onPagina={(p) => { setPage(p); setEdit({}); }} />
    </section>
  );
}
