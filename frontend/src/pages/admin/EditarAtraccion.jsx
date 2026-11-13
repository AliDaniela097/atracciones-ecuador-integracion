import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { Campo, Cargando, Error_, Insignia, Ok } from '../../components/ui.jsx';

export default function EditarAtraccion() {
  const { id } = useParams();
  const [a, setA] = useState(null); const [f, setF] = useState(null); const [err, setErr] = useState(null); const [ok, setOk] = useState(''); const [env, setEnv] = useState(false);
  const [h, setH] = useState({ hora: '09:00', cupo: 10 });
  const cargar = () => api('GET', `/admin/atracciones/${id}`).then((x) => {
    setA(x); setF({ nombre: x.nombre ?? '', descripcion: x.descripcion ?? '', descripcion_corta: x.descripcion_corta ?? '', punto_encuentro: x.punto_encuentro ?? '', duracion_horas: x.duracion_horas ?? 2,
      adulto: x.tarifas?.ADULTO ?? '', nino: x.tarifas?.NINO ?? '', foto: x.fotos?.[0]?.url ?? '',
      cancelacion_gratuita: !!x.cancelacion_gratuita, horas_cancelacion: x.horas_cancelacion ?? 24 }); setErr(null);
  }).catch(setErr);
  useEffect(() => { cargar(); }, [id]); // eslint-disable-line
  const c = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });

  const guardar = async (e) => {
    e.preventDefault(); setErr(null); setOk(''); setEnv(true);
    try {
      const body = { nombre: f.nombre.trim(), descripcion: f.descripcion.trim(), descripcion_corta: f.descripcion_corta.trim() || undefined, punto_encuentro: f.punto_encuentro.trim() || undefined, duracion_horas: Number(f.duracion_horas),
        tarifas: { ADULTO: Number(f.adulto), ...(f.nino !== '' && { NINO: Number(f.nino) }) },
        cancelacion_gratuita: !!f.cancelacion_gratuita, horas_cancelacion: Math.max(0, Math.round(Number(f.horas_cancelacion) || 0)) };
      if (f.foto.trim() && f.foto.trim() !== (a.fotos?.[0]?.url ?? '')) body.fotos = [{ url: f.foto.trim(), alt: f.nombre.trim() }];
      await api('PUT', `/admin/atracciones/${id}`, { body }); setOk('Cambios guardados.'); await cargar();
    } catch (x) { setErr(x); } finally { setEnv(false); }
  };
  const estado = async () => { setErr(null); setOk(''); try { await api('POST', `/admin/atracciones/${id}/${a.estado === 'PUBLICADA' ? 'despublicar' : 'publicar'}`); setOk(a.estado === 'PUBLICADA' ? 'Atracción despublicada.' : 'Atracción publicada.'); await cargar(); } catch (x) { setErr(x); } };
  const agregarHorario = async (e) => { e.preventDefault(); setErr(null); setOk(''); try { await api('POST', `/admin/atracciones/${id}/horarios`, { body: { hora: h.hora, cupo: Number(h.cupo) } }); setOk(`Horario ${h.hora} agregado. Genera los turnos en "Cupos" para publicarlos con stock.`); await cargar(); } catch (x) { setErr(x); } };

  if (err && !a) return <Error_ e={err} />;
  if (!a || !f) return <Cargando />;
  return (
    <section>
      <Link to="/admin/atracciones">‹ Mis atracciones</Link>
      <h1>Editar: {a.nombre} <Insignia estado={a.estado} /></h1>
      <Error_ e={err} /><Ok>{ok}</Ok>
      <form className="formulario" onSubmit={guardar}>
        <fieldset><legend>Datos generales</legend>
          <Campo etiqueta="Nombre"><input required minLength={3} {...c('nombre')} /></Campo>
          <Campo etiqueta="Descripción corta (opcional)"><input maxLength={200} {...c('descripcion_corta')} /></Campo>
          <Campo etiqueta="Descripción"><textarea required minLength={10} rows={4} {...c('descripcion')} /></Campo>
          <div className="fila"><Campo etiqueta="Duración (horas)"><input type="number" min="0.5" step="0.5" required {...c('duracion_horas')} /></Campo>
            <Campo etiqueta="Punto de encuentro"><input {...c('punto_encuentro')} /></Campo></div>
          <Campo etiqueta="URL de la foto principal" ayuda="Pega la dirección de una imagen real (https://…)."><input type="url" {...c('foto')} /></Campo>
          {f.foto && <img className="miniatura" src={f.foto} alt="Vista previa" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
        </fieldset>
        <fieldset><legend>Política de cancelación</legend>
          <label className="chk"><input type="checkbox" checked={!!f.cancelacion_gratuita} onChange={(e) => setF({ ...f, cancelacion_gratuita: e.target.checked })} /> Permitir que el turista cancele su reserva (reembolso simulado del 100%)</label>
          <Campo etiqueta="Horas mínimas de anticipación" ayuda="Se puede cancelar hasta estas horas antes del turno y mientras no haya check-in. La regla oficial del RDA2 es 24.">
            <input type="number" min="0" max="720" step="1" disabled={!f.cancelacion_gratuita} {...c('horas_cancelacion')} /></Campo>
          {!f.cancelacion_gratuita && <p className="meta">Con esta opción apagada, el turista no podrá cancelar desde la web y verá «Esta atracción no admite cancelación». Booking sí puede cancelar (solo se bloquea tras el check-in).</p>}
        </fieldset>
        <fieldset><legend>Tarifas (USD)</legend>
          <div className="fila"><Campo etiqueta="Adulto"><input type="number" min="0" step="0.01" required {...c('adulto')} /></Campo><Campo etiqueta="Niño (opcional)"><input type="number" min="0" step="0.01" {...c('nino')} /></Campo></div>
        </fieldset>
        <div className="fila"><button disabled={env}>{env ? 'Guardando…' : 'Guardar cambios'}</button>
          <button type="button" className="sec" onClick={estado}>{a.estado === 'PUBLICADA' ? 'Despublicar' : 'Publicar'}</button></div>
      </form>

      <form className="formulario" onSubmit={agregarHorario}>
        <h2>Horarios</h2>
        <table><thead><tr><th>Hora</th><th>Cupo por turno</th><th>Activo</th></tr></thead>
          <tbody>{a.horarios?.map((x) => <tr key={x.id}><td>{x.hora}</td><td>{x.cupo}</td><td>{x.activo ? 'Sí' : 'No'}</td></tr>)}</tbody></table>
        <div className="fila"><Campo etiqueta="Nueva hora"><input type="time" required value={h.hora} onChange={(e) => setH({ ...h, hora: e.target.value })} /></Campo>
          <Campo etiqueta="Cupo por turno"><input type="number" min="1" max="500" required value={h.cupo} onChange={(e) => setH({ ...h, cupo: e.target.value })} /></Campo></div>
        <div className="fila"><button>Agregar horario</button><Link className="boton sec" to={`/admin/atracciones/${id}/cupos`}>Ir a Cupos (generar turnos y ajustar stock)</Link></div>
      </form>
    </section>
  );
}
