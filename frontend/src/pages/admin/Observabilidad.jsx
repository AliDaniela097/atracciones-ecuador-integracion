import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Error_ } from '../../components/ui.jsx';

const CANALES = ['', 'HTTP', 'CLIENTES', 'RESERVA', 'CHECKIN', 'STOCK', 'BUS', 'ADMIN'];

export default function Observabilidad() {
  const [filas, setFilas] = useState([]); const [err, setErr] = useState(null); const [canal, setCanal] = useState(''); const [vivo, setVivo] = useState(true);
  const [salud, setSalud] = useState(null); const ultimo = useRef(0); const canalRef = useRef(canal); canalRef.current = canal;

  const cargar = useCallback(async (reiniciar = false) => {
    try {
      if (reiniciar) ultimo.current = 0;
      const r = await api('GET', '/admin/bitacora', { query: { despues: ultimo.current || undefined, canal: canalRef.current || undefined, limit: 200 } });
      if (r.data.length) setFilas((prev) => [...r.data, ...(reiniciar || !ultimo.current ? [] : prev)].slice(0, 400));
      else if (reiniciar) setFilas([]);
      ultimo.current = r.ultimo; setErr(null);
    } catch (e) { setErr(e); }
    fetch('/api/v3/health').then((x) => x.json()).then(setSalud).catch(() => setSalud(null));
  }, []);
  useEffect(() => { cargar(true); }, [canal, cargar]);
  useEffect(() => { if (!vivo) return undefined; const t = setInterval(() => cargar(false), 3000); return () => clearInterval(t); }, [vivo, cargar]);

  return (
    <section>
      <h1>Observabilidad</h1>
      <p className="meta">Lo que pasa por detrás, en tiempo real: peticiones, consultas de clientes, reservas de Booking, check-in, envío de stock (gRPC/REST/bus) y eventos de RabbitMQ. Cada línea lleva su correlation-id para seguir una operación de punta a punta.</p>
      {salud && (
        <div className="kpis">
          <div className="kpi"><span>Servicio</span><strong>{salud.status}</strong></div>
          <div className="kpi"><span>Base de datos</span><strong>{salud.database_connected ? 'Conectada' : 'Sin conexión'}</strong></div>
          <div className="kpi"><span>Bus RabbitMQ</span><strong>{salud.bus?.conectado ? 'Conectado' : salud.bus?.habilitado ? 'Reintentando' : 'Apagado'}</strong></div>
          <div className="kpi"><span>Stock pendiente a Booking</span><strong>{salud.grpc?.pending_stock_events ?? '—'}</strong></div>
          <div className="kpi"><span>Stock enviado OK / fallido</span><strong>{salud.grpc?.sent_ok ?? 0} / {salud.grpc?.sent_failed ?? 0}</strong></div>
        </div>
      )}
      <div className="filtros">
        <select value={canal} onChange={(e) => setCanal(e.target.value)} aria-label="Canal">{CANALES.map((c) => <option key={c} value={c}>{c || 'Todos los canales'}</option>)}</select>
        <label className="chk"><input type="checkbox" checked={vivo} onChange={(e) => setVivo(e.target.checked)} /> En vivo (cada 3 s)</label>
        <button type="button" className="sec" onClick={() => cargar(true)}>Recargar</button>
      </div>
      <Error_ e={err} />
      <div className="bitacora" role="log" aria-live="polite">
        {!filas.length ? <div className="l">Sin eventos todavía. Haz una reserva, un check-in o cambia un cupo para verlos aparecer.</div> : filas.map((e) => (
          <div className="l" key={e.n}>
            <span className="ts">{e.ts.slice(11, 23)}</span><span className={e.nivel}>{e.nivel}</span><span className={`c-${e.canal}`}>[{e.canal}]</span>
            <span>{e.mensaje}{e.datos && Object.keys(e.datos).length ? ' · ' + Object.entries(e.datos).map(([k, v]) => `${k}=${v}`).join(' ') : ''}</span>
            {e.cid && <span className="cid">cid={e.cid}</span>}
          </div>))}
      </div>
    </section>
  );
}
