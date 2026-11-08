import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, usd } from '../api.js';
import { Cargando, Error_, Paginacion } from '../components/ui.jsx';
import { Foto, Panorama } from '../components/Arte.jsx';

const Pin = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>;
const Check = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.6 2.6L16 9.5" /></svg>;

// Si pones una foto tuya en src/assets (portada.jpg, .png o .webp), se usa como fondo de la portada.
const portadas = import.meta.glob('../assets/portada.{jpg,jpeg,png,webp}', { eager: true, query: '?url', import: 'default' });
const fotoPortada = Object.values(portadas)[0];

export default function Catalogo() {
  const [f, setF] = useState({ q: '', ciudad: '' });
  const [d, setD] = useState(null); const [err, setErr] = useState(null); const [cargando, setCargando] = useState(true);
  const ultima = useRef(0); const primera = useRef(true);
  const buscar = (p = 1, filtros = f) => {
    const n = ++ultima.current; setErr(null);
    api('GET', '/atracciones', { query: { q: filtros.q, ciudad: filtros.ciudad, page: p, limit: 9 }, auth: false })
      .then((r) => { if (n === ultima.current) setD(r); })
      .catch((x) => { if (n === ultima.current) setErr(x); })
      .finally(() => { if (n === ultima.current) setCargando(false); });
  };
  useEffect(() => { buscar(1); /* carga inicial */ }, []); // eslint-disable-line
  // Búsqueda en vivo: al escribir se actualizan los resultados solos (con una pequeña espera).
  useEffect(() => {
    if (primera.current) { primera.current = false; return undefined; }
    const t = setTimeout(() => buscar(1, f), 350);
    return () => clearTimeout(t);
  }, [f.q, f.ciudad]); // eslint-disable-line
  const irLista = () => document.getElementById('escenario')?.scrollIntoView({ behavior: 'smooth' });
  const total = d?.metadata?.total_results;
  const campos = (
    <>
      <input placeholder="Buscar tours o parques…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Buscar" />
      <input placeholder="Ciudad (ej. Quito)" value={f.ciudad} onChange={(e) => setF({ ...f, ciudad: e.target.value })} aria-label="Ciudad" />
    </>
  );
  return (
    <>
      <section className="hero" aria-labelledby="titulo-inicio">
        {fotoPortada ? <img className="hero-foto" src={fotoPortada} alt="" /> : <Panorama />}
        <div className="hero-texto">
          <p className="sobretitulo"><i />El Ecuador te espera</p>
          <h1 id="titulo-inicio">Cuatro mundos <span>en un solo país</span></h1>
          <p className="lead">Costa, Sierra, Amazonía y Galápagos. Tours, parques y experiencias en las ciudades con aeropuerto del Ecuador: elige tu turno y reserva en minutos.</p>
          <div className="hero-botones"><button className="menta flecha" onClick={irLista}>Ver atracciones</button></div>
          {total != null && <p className="datos-inicio"><strong>{total}</strong> {total === 1 ? 'atracción disponible' : 'atracciones disponibles'} · cupos en vivo por turno</p>}
        </div>

        <form className="hero-buscar" role="search" onSubmit={(e) => { e.preventDefault(); buscar(1); irLista(); }}>
          <h2>¿A dónde vamos?</h2>
          <p>Escribe y los resultados aparecen al instante.</p>
          <label>Atracción<input placeholder="Tour, parque, museo…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Buscar en portada" /></label>
          <label>Ciudad<input placeholder="Ej. Quito, Guayaquil…" value={f.ciudad} onChange={(e) => setF({ ...f, ciudad: e.target.value })} aria-label="Ciudad en portada" /></label>
          <button type="submit" className="menta flecha">Buscar</button>
          <button type="button" className="enlace" onClick={() => setF({ q: '', ciudad: '' })}>Limpiar búsqueda</button>
        </form>

        <ul className="hero-confianza" aria-label="Ventajas">
          <li><Check />Cupos en tiempo real</li><li><Check />Código de reserva</li><li><Check />Calendario .ics</li><li><Check />Check-in digital</li>
        </ul>
      </section>

      <section className="escenario contenedor" id="escenario" aria-label="Catálogo de atracciones">
        <h2 className="titulo-seccion">Atracciones</h2>
        <form className="filtros" role="search" onSubmit={(e) => { e.preventDefault(); buscar(1); }}>
          {campos}
          <button type="submit">Buscar</button>
          <button type="button" className="sec" onClick={() => setF({ q: '', ciudad: '' })}>Limpiar</button>
        </form>
        <Error_ e={err} />
        {cargando && !d ? <Cargando /> : !d?.data?.length ? <p className="vacio">No se encontraron atracciones con esos filtros. Prueba con otra ciudad o limpia la búsqueda.</p> : (
          <div className="rejilla">
            {d.data.map((a) => (
              <article key={a.id} className="tarjeta">
                <div className="tarjeta-img"><Foto src={a.photos?.[0]} alt={a.name} clave={a.id ?? a.name} texto={`${a.name} ${a.city}`} /><span className="ciudad"><Pin />{a.city}</span></div>
                <div className="cuerpo">
                  <h2><Link to={`/atraccion/${a.id}`}>{a.name}</Link></h2>
                  <p className="meta">{a.duration}</p>
                  <p className="corto">{a.short_description}</p>
                  <p className="pie-t"><strong>Desde {usd(a.price?.adult)}</strong>{a.free_cancellation && <span className="chip">Cancelación gratuita</span>}</p>
                </div>
              </article>
            ))}
          </div>
        )}
        <Paginacion meta={d?.metadata} onPagina={(p) => { buscar(p); irLista(); }} />
      </section>
    </>
  );
}
