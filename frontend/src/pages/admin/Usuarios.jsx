import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useSesion } from '../../App.jsx';
import { Cargando, Error_, Paginacion } from '../../components/ui.jsx';
import { useSondeo } from '../../sondeo.js';

const DOMINIO = 'atraccionec.com';
const SISTEMA = 'admin@atraccionec.com';

/** "María José" "Pérez Mora" -> "maria.perez": sin tildes ni espacios, solo primer nombre y primer apellido. */
const limpiar = (t) => String(t ?? '').trim().split(/\s+/)[0].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const correoDe = (nombre, apellido, n = 1) => {
  const a = limpiar(nombre); const b = limpiar(apellido);
  return a && b ? `${a}.${b}${n > 1 ? n : ''}@${DOMINIO}` : '';
};

/** Contraseña aleatoria con el generador criptográfico del navegador: 14 caracteres, sin letras que se confunden (l, I, O, 0, 1). */
function crearClave() {
  const grupos = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#$%*+-=?'];
  const todo = grupos.join('');
  const azar = (max) => { const lim = Math.floor(0x100000000 / max) * max; const b = new Uint32Array(1); do { crypto.getRandomValues(b); } while (b[0] >= lim); return b[0] % max; };
  const c = grupos.map((g) => g[azar(g.length)]);
  while (c.length < 14) c.push(todo[azar(todo.length)]);
  for (let i = c.length - 1; i > 0; i--) { const j = azar(i + 1); [c[i], c[j]] = [c[j], c[i]]; }
  return c.join('');
}

const POR_PAGINA = 15;
const esEmpleado = (u) => u.roles.includes('ADMIN') || u.roles.includes('OPERADOR');
const fecha = (iso) => (iso ? new Date(iso).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
const CADA_CLIENTES_MS = 8000;

export default function Usuarios() {
  const s = useSesion(); const yo = s?.user?.id;
  const [todos, setTodos] = useState(null); const [err, setErr] = useState(null); const [q, setQ] = useState(''); const [pag, setPag] = useState(1);
  const [tab, setTab] = useState('empleados');
  const [cl, setCl] = useState(null); const [qc, setQc] = useState(''); const [pc, setPc] = useState(1); const [errCl, setErrCl] = useState(null);
  const [f, setF] = useState({ nombre: '', apellido: '' }); const [creando, setCreando] = useState(false); const [errC, setErrC] = useState(null);
  const [nuevo, setNuevo] = useState(null); const [copiado, setCopiado] = useState('');
  const primera = useRef(true);

  /** Trae todas las cuentas (de 100 en 100) y las separa aquí en empleados y usuarios según su rol. */
  const cargar = async (texto = q) => {
    try {
      let lista = []; let page = 1; let total = 1;
      do { const r = await api('GET', '/admin/usuarios', { query: { q: texto, page, limit: 100 } }); lista = lista.concat(r.data); total = r.metadata?.total_pages ?? 1; page++; } while (page <= total && page <= 30);
      setTodos(lista); setErr(null);
    } catch (x) { setErr(x); }
  };
  useEffect(() => { cargar(''); }, []); // eslint-disable-line
  useEffect(() => { if (primera.current) { primera.current = false; return undefined; } const t = setTimeout(() => { setPag(1); cargar(q); }, 350); return () => clearTimeout(t); }, [q]); // eslint-disable-line

  if (err?.status === 403) return <section><h1>Empleados y usuarios</h1><div className="alerta error" role="alert"><strong>Solo el Administrador del Sistema puede gestionar cuentas.</strong><p>Pídele a esa cuenta que cree o cambie las cuentas del personal.</p></div></section>;

  const empleados = (todos ?? []).filter(esEmpleado);
  const lista = empleados;
  const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
  const vista_ = lista.slice((pag - 1) * POR_PAGINA, pag * POR_PAGINA);
  const meta = { page: pag, total_pages: paginas, total_results: lista.length };
  const vista = correoDe(f.nombre, f.apellido);

  const crear = async (e) => {
    e.preventDefault(); setErrC(null); setNuevo(null);
    if (!vista) { setErrC(new Error('Escribe el nombre y el apellido del empleado.')); return; }
    setCreando(true);
    try {
      const clave = crearClave(); let reg = null; let correo = '';
      for (let n = 1; n <= 9 && !reg; n++) {
        correo = correoDe(f.nombre, f.apellido, n);
        try { reg = await api('POST', '/auth/register', { auth: false, body: { email: correo, password: clave, nombre: f.nombre.trim(), apellido: f.apellido.trim() } }); }
        catch (x) { if (x.code !== 'EMAIL_ALREADY_REGISTERED') throw x; }
      }
      if (!reg) throw new Error('Ya existen demasiadas cuentas con ese nombre. Usa otro nombre o apellido.');
      try { await api('PATCH', `/admin/usuarios/${reg.user.id}`, { body: { roles: ['ADMIN'] } }); }
      catch (x) { x.message = `La cuenta ${correo} se creó, pero no se pudo darle el rol de administrador: ${x.message}.`; throw x; }
      setNuevo({ correo, clave, nombre: `${f.nombre.trim()} ${f.apellido.trim()}` }); setF({ nombre: '', apellido: '' }); cargar(q);
    } catch (x) { setErrC(x); } finally { setCreando(false); }
  };

  const copiar = async (texto, que) => { try { await navigator.clipboard.writeText(texto); setCopiado(que); setTimeout(() => setCopiado(''), 2000); } catch { setCopiado('No se pudo copiar: selecciona el texto y cópialo a mano.'); } };
  const enlace = `${window.location.origin}/#/login?admin=1`;
  const cambiar = async (u, body) => { setErr(null); try { await api('PATCH', `/admin/usuarios/${u.id}`, { body }); cargar(q); } catch (x) { setErr(x); } };

  /** Clientes (solo lectura): todos los turistas que han reservado por la web o por Booking, con el resumen de sus reservas. */
  const cargarClientes = async () => {
    try { const r = await api('GET', '/admin/clientes', { query: { q: qc, page: pc, limit: POR_PAGINA } }); setCl(r); setErrCl(null); }
    catch (x) { if (x.status === 429) throw x; setErrCl(x); }
  };
  useEffect(() => { const t = setTimeout(cargarClientes, 0); return () => clearTimeout(t); }, [qc, pc]); // eslint-disable-line
  useSondeo(cargarClientes, { cada: CADA_CLIENTES_MS, activo: tab === 'usuarios' });
  const cambiarTab = (t) => { setTab(t); setPag(1); };

  return (
    <section>
      <h1>Empleados y usuarios</h1>
      <p className="meta">Los <strong>empleados</strong> trabajan en el panel de administración. Los <strong>usuarios</strong> son los clientes que han reservado (por la web o por Booking); es una lista de solo lectura.</p>

      <div className="pestanas" role="tablist">
        <button role="tab" aria-selected={tab === 'empleados'} className={tab === 'empleados' ? 'activa' : ''} onClick={() => cambiarTab('empleados')}>Empleados{todos ? ` (${empleados.length})` : ''}</button>
        <button role="tab" aria-selected={tab === 'usuarios'} className={tab === 'usuarios' ? 'activa' : ''} onClick={() => cambiarTab('usuarios')}>Usuarios{cl ? ` (${cl.metadata.total_results})` : ''}</button>
      </div>

      {tab === 'empleados' && (<>
        <form className="formulario" onSubmit={crear}>
          <h2>Nuevo empleado</h2>
          <div className="fila">
            <label className="campo"><span>Nombre</span><input required value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoComplete="off" placeholder="Ej. María José" /></label>
            <label className="campo"><span>Apellido</span><input required value={f.apellido} onChange={(e) => setF({ ...f, apellido: e.target.value })} autoComplete="off" placeholder="Ej. Pérez Mora" /></label>
          </div>
          <p className="meta">Correo de ingreso: <strong>{vista || `nombre.apellido@${DOMINIO}`}</strong> · La contraseña se genera sola.</p>
          <Error_ e={errC} />
          <div><button disabled={creando}>{creando ? 'Creando…' : 'Crear empleado'}</button></div>
        </form>

        {nuevo && (
          <div className="alerta ok" role="status">
            <h3>Cuenta creada para {nuevo.nombre}</h3>
            <p>Correo: <strong>{nuevo.correo}</strong></p>
            <p>Contraseña: <strong className="clave">{nuevo.clave}</strong></p>
            <p className="meta">Esta contraseña se muestra una sola vez y no se puede volver a ver. Entrégala de forma privada y pídele al empleado que no la comparta.</p>
            <div className="acciones">
              <button type="button" onClick={() => copiar(`Panel: ${enlace}\nCorreo: ${nuevo.correo}\nContraseña: ${nuevo.clave}`, 'Datos copiados')}>Copiar datos para entregar</button>
              <button type="button" className="sec" onClick={() => setNuevo(null)}>Ya la entregué, ocultar</button>
            </div>
            {copiado && <p className="meta" role="status">{copiado}</p>}
          </div>
        )}
      </>)}

      {tab === 'empleados' ? (<>
        <h2>Empleados</h2>
        <div className="filtros" role="search"><input placeholder="Buscar por nombre o correo…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar cuentas" /></div>
        <Error_ e={err} />
        {!todos ? <Cargando /> : !lista.length ? <p className="vacio">{q ? 'No hay cuentas con esa búsqueda.' : 'Aún no hay empleados.'}</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
            <tbody>{vista_.map((u) => {
              const soy = u.id === yo; const sist = String(u.email ?? '').toLowerCase() === SISTEMA;
              return (
                <tr key={u.id}>
                  <td className="nom">{u.nombre} {u.apellido}</td><td>{u.email}</td>
                  <td><span className={`ins ${sist ? 'ins-confirmed' : 'ins-publicada'}`}>{sist ? 'Administrador del Sistema' : u.roles.includes('ADMIN') ? 'Administrador' : 'Operador'}</span></td>
                  <td><span className={`ins ${u.activo ? 'ins-publicada' : 'ins-inactiva'}`}>{u.activo ? 'Activa' : 'Desactivada'}</span></td>
                  <td className="acc">{sist || soy ? <span className="meta">{sist ? 'Cuenta principal' : 'Tu cuenta'}</span>
                    : <button className="sec" onClick={() => cambiar(u, { activo: !u.activo })}>{u.activo ? 'Desactivar' : 'Activar'}</button>}</td>
                </tr>);
            })}</tbody></table></div>
        )}
        <Paginacion meta={meta} onPagina={(p) => setPag(p)} />
      </>) : (<>
        <h2>Usuarios (clientes que reservaron)</h2>
        <p className="meta">Solo lectura. Se actualiza solo cada {CADA_CLIENTES_MS / 1000} segundos: los clientes que hacen check-in o reservan desde Booking aparecen aquí.</p>
        <div className="filtros" role="search"><input type="search" placeholder="Buscar por nombre, cédula, correo o teléfono…" value={qc} onChange={(e) => { setQc(e.target.value); setPc(1); }} aria-label="Buscar clientes" /></div>
        <Error_ e={errCl} />
        {!cl ? <Cargando /> : !cl.data.length ? <p className="vacio">{qc ? 'No hay clientes con esa búsqueda.' : 'Todavía no hay clientes con reservas.'}</p> : (
          <div className="scroll"><table className="tabla-clientes">
            <thead><tr><th>Cliente</th><th>Documento</th><th>Correo</th><th>Teléfono</th><th>Reservas</th><th>Vigentes</th><th>Check-in</th><th>Canceladas</th><th>Última</th></tr></thead>
            <tbody>{cl.data.map((c) => (
              <tr key={c.id}>
                <td className="nom">{c.nombre}</td>
                <td className="nw"><strong>{c.documento}</strong> <small>{c.tipo_documento === 'CEDULA' ? 'Cédula' : c.tipo_documento === 'PASAPORTE' ? 'Pasaporte' : 'RUC'}</small></td>
                <td>{c.email}</td><td>{c.telefono}</td>
                <td>{c.reservas}</td><td>{c.vigentes}</td><td>{c.checkins}</td><td>{c.canceladas}</td>
                <td>{fecha(c.ultima_reserva)}</td>
              </tr>))}</tbody></table></div>
        )}
        <Paginacion meta={cl?.metadata} onPagina={(p) => setPc(p)} />
      </>)}
    </section>
  );
}
