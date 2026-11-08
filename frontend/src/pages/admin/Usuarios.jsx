import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useSesion } from '../../App.jsx';
import { Cargando, Error_, Paginacion } from '../../components/ui.jsx';

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

export default function Usuarios() {
  const s = useSesion(); const yo = s?.user?.id;
  const [d, setD] = useState(null); const [err, setErr] = useState(null); const [q, setQ] = useState(''); const [pag, setPag] = useState(1);
  const [f, setF] = useState({ nombre: '', apellido: '' }); const [creando, setCreando] = useState(false); const [errC, setErrC] = useState(null);
  const [nuevo, setNuevo] = useState(null); const [copiado, setCopiado] = useState('');
  const primera = useRef(true);

  const cargar = (page = pag, texto = q) => api('GET', '/admin/usuarios', { query: { q: texto, page, limit: 15 } }).then((r) => { setD(r); setPag(page); }).catch(setErr);
  useEffect(() => { cargar(1); }, []); // eslint-disable-line
  useEffect(() => { if (primera.current) { primera.current = false; return undefined; } const t = setTimeout(() => cargar(1, q), 350); return () => clearTimeout(t); }, [q]); // eslint-disable-line

  if (err?.status === 403) return <section><h1>Usuarios y trabajadores</h1><div className="alerta error" role="alert"><strong>Solo el Administrador del Sistema puede gestionar usuarios.</strong><p>Pídele a esa cuenta que cree o cambie las cuentas del personal.</p></div></section>;

  const vista = correoDe(f.nombre, f.apellido);

  const crear = async (e) => {
    e.preventDefault(); setErrC(null); setNuevo(null);
    if (!vista) { setErrC(new Error('Escribe el nombre y el apellido del trabajador.')); return; }
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
      setNuevo({ correo, clave, nombre: `${f.nombre.trim()} ${f.apellido.trim()}` }); setF({ nombre: '', apellido: '' }); cargar(1, q);
    } catch (x) { setErrC(x); } finally { setCreando(false); }
  };

  const copiar = async (texto, que) => { try { await navigator.clipboard.writeText(texto); setCopiado(que); setTimeout(() => setCopiado(''), 2000); } catch { setCopiado('No se pudo copiar: selecciona el texto y cópialo a mano.'); } };
  const enlace = `${window.location.origin}/#/login?admin=1`;

  const cambiar = async (u, body) => { setErr(null); try { await api('PATCH', `/admin/usuarios/${u.id}`, { body }); cargar(pag); } catch (x) { setErr(x); } };

  return (
    <section>
      <h1>Usuarios y trabajadores</h1>
      <p className="meta">Crea cuentas para el personal que atiende el panel. El correo y la contraseña se generan solos.</p>

      <form className="formulario" onSubmit={crear}>
        <h2>Nuevo trabajador</h2>
        <div className="fila">
          <label className="campo"><span>Nombre</span><input required value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoComplete="off" placeholder="Ej. María José" /></label>
          <label className="campo"><span>Apellido</span><input required value={f.apellido} onChange={(e) => setF({ ...f, apellido: e.target.value })} autoComplete="off" placeholder="Ej. Pérez Mora" /></label>
        </div>
        <p className="meta">Correo de ingreso: <strong>{vista || `nombre.apellido@${DOMINIO}`}</strong></p>
        <Error_ e={errC} />
        <div><button disabled={creando}>{creando ? 'Creando…' : 'Crear trabajador'}</button></div>
      </form>

      {nuevo && (
        <div className="alerta ok" role="status">
          <h3>Cuenta creada para {nuevo.nombre}</h3>
          <p>Correo: <strong>{nuevo.correo}</strong></p>
          <p>Contraseña: <strong className="clave">{nuevo.clave}</strong></p>
          <p className="meta">Esta contraseña se muestra una sola vez y no se puede volver a ver. Entrégala de forma privada y pídele al trabajador que no la comparta.</p>
          <div className="acciones">
            <button type="button" onClick={() => copiar(`Panel: ${enlace}\nCorreo: ${nuevo.correo}\nContraseña: ${nuevo.clave}`, 'Datos copiados')}>Copiar datos para entregar</button>
            <button type="button" className="sec" onClick={() => setNuevo(null)}>Ya la entregué, ocultar</button>
          </div>
          {copiado && <p className="meta" role="status">{copiado}</p>}
        </div>
      )}

      <h2>Cuentas registradas</h2>
      <div className="filtros" role="search"><input placeholder="Buscar por nombre o correo…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar usuarios" /></div>
      <Error_ e={err} />
      {!d ? <Cargando /> : !d.data.length ? <p className="vacio">No hay cuentas con esa búsqueda.</p> : (
        <div className="scroll"><table><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
          <tbody>{d.data.map((u) => {
            const esAdm = u.roles.includes('ADMIN'); const soy = u.id === yo; const sist = String(u.email ?? '').toLowerCase() === SISTEMA;
            return (
              <tr key={u.id}>
                <td className="nom">{u.nombre} {u.apellido}</td><td>{u.email}</td>
                <td>{sist ? <span className="ins ins-confirmed">Administrador del Sistema</span> : <span className={`ins ${esAdm ? 'ins-publicada' : 'ins-inactiva'}`}>{esAdm ? 'Administrador' : 'Sin acceso al panel'}</span>}</td>
                <td><span className={`ins ${u.activo ? 'ins-publicada' : 'ins-inactiva'}`}>{u.activo ? 'Activa' : 'Desactivada'}</span></td>
                <td className="acc">{sist || soy ? <span className="meta">{sist ? 'Cuenta principal' : 'Tu cuenta'}</span> : <>
                  {!esAdm && <button onClick={() => cambiar(u, { roles: ['ADMIN'] })}>Dar acceso de administrador</button>} <button className="sec" onClick={() => cambiar(u, { activo: !u.activo })}>{u.activo ? 'Desactivar' : 'Activar'}</button></>}</td>
              </tr>);
          })}</tbody></table></div>
      )}
      <Paginacion meta={d?.metadata} onPagina={(p) => cargar(p)} />
    </section>
  );
}
