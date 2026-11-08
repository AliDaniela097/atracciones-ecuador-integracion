import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, usd } from '../../api.js';
import { Cargando, Error_ } from '../../components/ui.jsx';

export default function Dashboard() {
  const [d, setD] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => { api('GET', '/admin/dashboard').then(setD).catch(setErr); }, []);
  if (err) return <Error_ e={err} />;
  if (!d) return <Cargando />;
  const k = [['Atracciones publicadas', d.atracciones_publicadas], ['Reservas hoy', d.reservas_hoy], ['Reservas activas', d.reservas_activas], ['Canceladas', d.reservas_canceladas], ['Ingresos', usd(d.ingresos_usd)], ['Eventos de stock pendientes', d.eventos_stock_pendientes_grpc]];
  return (
    <section>
      <h1>Panel de administración</h1>
      <div className="kpis">{k.map(([t, v]) => <div className="kpi" key={t}><span>{t}</span><strong>{v}</strong></div>)}</div>
      <p className="acciones"><Link className="boton" to="/admin/atracciones/nueva">+ Crear atracción con cupos</Link> <Link className="boton sec" to="/admin/reservas">Reservas y check-in</Link></p>
      <h2>Atracciones más reservadas</h2>
      <table><thead><tr><th>Atracción</th><th>Reservas</th></tr></thead><tbody>{d.top_atracciones?.map((t) => <tr key={t.id}><td>{t.nombre}</td><td>{t.reservas}</td></tr>)}</tbody></table>
    </section>
  );
}
