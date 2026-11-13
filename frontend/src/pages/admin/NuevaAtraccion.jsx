import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, hoyEC } from '../../api.js';
import { Campo, Cargando, Error_ } from '../../components/ui.jsx';

const TIPOS = [['GUIDED_TOUR', 'Tour guiado'], ['ADMISSION', 'Entrada'], ['DAY_TRIP', 'Excursión de un día'], ['TRANSPORT', 'Transporte'], ['PACKAGE', 'Paquete']];

export default function NuevaAtraccion() {
  const nav = useNavigate();
  const [ciudades, setCiudades] = useState(null); const [ops, setOps] = useState([]); const [err, setErr] = useState(null);
  const [f, setF] = useState({ nombre: '', descripcion: '', tipo: 'GUIDED_TOUR', ciudad_id: '', operador_id: '', latitud: '', longitud: '', duracion_horas: 2, punto_encuentro: '', foto: '', adulto: '', nino: '', hora: '09:00', cupo: 10, desde: hoyEC(1), hasta: hoyEC(14), publicar: true });
  const [paso, setPaso] = useState(''); const [enviando, setEnviando] = useState(false);
  useEffect(() => {
    Promise.all([api('GET', '/admin/ciudades', { query: { limit: 100 } }), api('GET', '/admin/operadores', { query: { limit: 100 } })])
      .then(([cs, o]) => { const c = { data: cs.data.filter((x) => x.activa && x.aeropuertos?.some((a) => a.activo)) }; setCiudades(c.data); setOps(o.data); setF((x) => ({ ...x, ciudad_id: c.data[0]?.id ?? '', operador_id: o.data[0]?.id ?? '' })); }).catch(setErr);
  }, []);
  const c = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });

  const enviar = async (e) => {
    e.preventDefault(); setErr(null); setEnviando(true);
    if (f.hasta < f.desde) { setErr({ message: 'La fecha final no puede ser anterior a la inicial.' }); setEnviando(false); return; }
    try {
      setPaso('Creando atracción…');
      const a = await api('POST', '/admin/atracciones', { body: {
        nombre: f.nombre.trim(), descripcion: f.descripcion.trim(), tipo: f.tipo, ciudad_id: Number(f.ciudad_id), operador_id: Number(f.operador_id),
        latitud: Number(f.latitud), longitud: Number(f.longitud), duracion_horas: Number(f.duracion_horas),
        cancelacion_gratuita: true, horas_cancelacion: 24,   // regla oficial del RDA2: se puede cancelar hasta 24 h antes del turno
        ...(f.punto_encuentro && { punto_encuentro: f.punto_encuentro }), ...(f.foto && { fotos: [{ url: f.foto, alt: f.nombre }] }) } });
      setPaso('Guardando tarifas…');
      await api('PUT', `/admin/atracciones/${a.id}`, { body: { tarifas: { ADULTO: Number(f.adulto), ...(f.nino !== '' && { NINO: Number(f.nino) }) } } });
      setPaso('Definiendo horario y cupo…');
      await api('POST', `/admin/atracciones/${a.id}/horarios`, { body: { hora: f.hora, cupo: Number(f.cupo) } });
      setPaso('Generando turnos con stock…');
      await api('POST', `/admin/atracciones/${a.id}/turnos/generar`, { body: { desde: f.desde, hasta: f.hasta } });
      if (f.publicar) { setPaso('Publicando…'); await api('POST', `/admin/atracciones/${a.id}/publicar`); }
      nav(`/admin/atracciones/${a.id}/cupos`);
    } catch (x) { setErr(x); } finally { setEnviando(false); setPaso(''); }
  };

  if (!ciudades && !err) return <Cargando />;
  return (
    <form className="formulario" onSubmit={enviar}>
      <h1>Crear atracción con cupos</h1>
      <Error_ e={err} />
      <fieldset><legend>Datos generales</legend>
        <Campo etiqueta="Nombre"><input required minLength={3} {...c('nombre')} /></Campo>
        <Campo etiqueta="Descripción"><textarea required minLength={10} rows={3} {...c('descripcion')} /></Campo>
        <div className="fila">
          <Campo etiqueta="Tipo"><select {...c('tipo')}>{TIPOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Campo>
          <Campo etiqueta="Duración (horas)"><input type="number" min="0.5" step="0.5" required {...c('duracion_horas')} /></Campo>
        </div>
        <div className="fila">
          <Campo etiqueta="Ciudad" ayuda="Solo ciudades con aeropuerto activo."><select required {...c('ciudad_id')}>{ciudades?.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select></Campo>
          <Campo etiqueta="Operador"><select required {...c('operador_id')}>{ops.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select></Campo>
        </div>
        <div className="fila">
          <Campo etiqueta="Latitud" ayuda="Ej. -0.2201"><input type="number" step="any" min="-90" max="90" required {...c('latitud')} /></Campo>
          <Campo etiqueta="Longitud" ayuda="Ej. -78.5120"><input type="number" step="any" min="-180" max="180" required {...c('longitud')} /></Campo>
        </div>
        <Campo etiqueta="Punto de encuentro (opcional)"><input {...c('punto_encuentro')} /></Campo>
        <Campo etiqueta="URL de foto (opcional)"><input type="url" placeholder="https://…" {...c('foto')} /></Campo>
      </fieldset>
      <fieldset><legend>Tarifas (USD)</legend>
        <div className="fila"><Campo etiqueta="Adulto"><input type="number" min="0" step="0.01" required {...c('adulto')} /></Campo><Campo etiqueta="Niño (opcional)"><input type="number" min="0" step="0.01" {...c('nino')} /></Campo></div>
      </fieldset>
      <fieldset><legend>Stock (cupos por turno)</legend>
        <div className="fila"><Campo etiqueta="Hora del turno"><input type="time" required {...c('hora')} /></Campo><Campo etiqueta="Cupos por turno"><input type="number" min="1" max="500" required {...c('cupo')} /></Campo></div>
        <div className="fila"><Campo etiqueta="Generar desde"><input type="date" min={hoyEC(0)} required {...c('desde')} /></Campo><Campo etiqueta="Hasta"><input type="date" min={f.desde} required {...c('hasta')} /></Campo></div>
        <label className="chk"><input type="checkbox" checked={f.publicar} onChange={(e) => setF({ ...f, publicar: e.target.checked })} /> Publicar de inmediato (visible para Booking y el catálogo)</label>
      </fieldset>
      <button disabled={enviando}>{enviando ? paso || 'Guardando…' : 'Crear atracción'}</button>
    </form>
  );
}
