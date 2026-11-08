import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, sesion } from '../api.js';
import { Campo, Error_ } from '../components/ui.jsx';

function entrar(r, nav, admin) { sesion.guardar({ token: r.access_token, user: r.user }); nav(admin && r.user.roles.includes('ADMIN') ? '/admin' : '/'); }

export function Login() {
  const nav = useNavigate(); const [qs] = useSearchParams(); const admin = qs.get('admin') === '1';
  const [f, setF] = useState({ email: '', password: '' }); const [err, setErr] = useState(null); const [cargando, setCargando] = useState(false);
  const enviar = async (e) => { e.preventDefault(); setErr(null); setCargando(true); try { entrar(await api('POST', '/auth/login', { body: f, auth: false }), nav, true); } catch (x) { setErr(x); } finally { setCargando(false); } };
  return (
    <form className="formulario angosto" onSubmit={enviar}>
      <h1>{admin ? 'Ingreso de administración' : 'Ingresar'}</h1>
      <Error_ e={err} />
      <Campo etiqueta="Correo"><input type="email" required autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>
      <Campo etiqueta="Contraseña"><input type="password" required autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Campo>
      <button disabled={cargando}>{cargando ? 'Ingresando…' : 'Ingresar'}</button>
      <p>¿No tienes cuenta? <Link to="/registro">Regístrate</Link></p>
    </form>
  );
}

export function Registro() {
  const nav = useNavigate(); const [f, setF] = useState({ nombre: '', apellido: '', email: '', password: '' }); const [err, setErr] = useState(null); const [cargando, setCargando] = useState(false);
  const enviar = async (e) => { e.preventDefault(); setErr(null); setCargando(true); try { entrar(await api('POST', '/auth/register', { body: f, auth: false }), nav, false); } catch (x) { setErr(x); } finally { setCargando(false); } };
  const c = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });
  return (
    <form className="formulario angosto" onSubmit={enviar}>
      <h1>Crear cuenta</h1>
      <Error_ e={err} />
      <Campo etiqueta="Nombre"><input required {...c('nombre')} /></Campo>
      <Campo etiqueta="Apellido"><input required {...c('apellido')} /></Campo>
      <Campo etiqueta="Correo"><input type="email" required autoComplete="username" {...c('email')} /></Campo>
      <Campo etiqueta="Contraseña" ayuda="Mínimo 8 caracteres, con letras y números."><input type="password" required minLength={8} autoComplete="new-password" {...c('password')} /></Campo>
      <button disabled={cargando}>{cargando ? 'Creando…' : 'Crear cuenta'}</button>
      <p>¿Ya tienes cuenta? <Link to="/login">Ingresa</Link></p>
    </form>
  );
}
