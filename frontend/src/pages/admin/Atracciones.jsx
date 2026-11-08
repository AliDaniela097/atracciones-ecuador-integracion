import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, usd } from '../../api.js';
import { Cargando, Error_, Insignia, Paginacion } from '../../components/ui.jsx';

export default function Atracciones() {
  const [d, setD] = useState(null); const [err, setErr] = useState(null);
  const cargar = (page = 1) => api('GET', '/admin/atracciones', { query: { page, limit: 15 } }).then(setD).catch(setErr);
  useEffect(() => { cargar(); }, []);
  const estado = async (a) => { setErr(null); try { await api('POST', `/admin/atracciones/${a.id}/${a.estado === 'PUBLICADA' ? 'despublicar' : 'publicar'}`); cargar(d?.metadata?.page ?? 1); } catch (e) { setErr(e); } };
  return (
    <section>
      <h1>Mis atracciones</h1>
      <p><Link className="boton" to="/admin/atracciones/nueva">+ Crear atracción</Link></p>
      <Error_ e={err} />
      {!d ? <Cargando /> : (
        <table><thead><tr><th>Nombre</th><th>Ciudad</th><th>Precio adulto</th><th>Estado</th><th></th></tr></thead>
          <tbody>{d.data.map((a) => (
            <tr key={a.id}><td>{a.nombre}</td><td>{a.ciudad}</td><td>{usd(a.precio_adulto)}</td><td><Insignia estado={a.estado} /></td>
              <td className="acc"><Link to={`/admin/atracciones/${a.id}/editar`}>Editar</Link> <Link to={`/admin/atracciones/${a.id}/cupos`}>Cupos</Link> <button className="sec" onClick={() => estado(a)}>{a.estado === 'PUBLICADA' ? 'Despublicar' : 'Publicar'}</button></td></tr>))}</tbody></table>
      )}
      <Paginacion meta={d?.metadata} onPagina={cargar} />
    </section>
  );
}
