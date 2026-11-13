import React, { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { sesion } from './api.js';
import Catalogo from './pages/Catalogo.jsx';
import Detalle from './pages/Detalle.jsx';
import MisReservas from './pages/MisReservas.jsx';
import { Login, Registro } from './pages/Auth.jsx';
import AdminDashboard from './pages/admin/Dashboard.jsx';
import AdminAtracciones from './pages/admin/Atracciones.jsx';
import NuevaAtraccion from './pages/admin/NuevaAtraccion.jsx';
import Cupos from './pages/admin/Cupos.jsx';
import Reservas from './pages/admin/Reservas.jsx';
import EditarAtraccion from './pages/admin/EditarAtraccion.jsx';
import Observabilidad from './pages/admin/Observabilidad.jsx';
import Usuarios from './pages/admin/Usuarios.jsx';
import Stock from './pages/admin/Stock.jsx';
import { Marca } from './components/Arte.jsx';

export function useSesion() {
  const [s, setS] = useState(sesion.leer());
  useEffect(() => { const f = () => setS(sesion.leer()); window.addEventListener('sesion', f); return () => window.removeEventListener('sesion', f); }, []);
  return s;
}
const esAdmin = (s) => !!s?.user?.roles?.includes('ADMIN');

function Protegida({ s, children }) { return esAdmin(s) ? children : <Navigate to="/login?admin=1" replace />; }

export default function App() {
  const s = useSesion(); const nav = useNavigate(); const { pathname } = useLocation();
  const inicio = pathname === '/';
  const [bajo, setBajo] = useState(false);
  // Responsivo: en celular cada tabla se muestra como tarjetas; aquí cada celda recibe el nombre de su columna.
  useEffect(() => {
    const rotular = () => document.querySelectorAll('table').forEach((t) => {
      const th = [...t.querySelectorAll('thead th')].map((x) => x.textContent.trim());
      t.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (td.tagName === 'TD' && td.getAttribute('data-label') !== (th[i] || '')) td.setAttribute('data-label', th[i] || ''); }));
    });
    rotular();
    const mo = new MutationObserver(rotular);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  useEffect(() => { const f = () => setBajo(window.scrollY > 24); f(); window.addEventListener('scroll', f, { passive: true }); return () => window.removeEventListener('scroll', f); }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  const irCatalogo = () => {
    const ir = () => document.getElementById('escenario')?.scrollIntoView({ behavior: 'smooth' });
    if (inicio) ir(); else { nav('/'); setTimeout(ir, 120); }
  };
  return (
    <div className="app">
      <div className="marco">
        <header className={`barra ${bajo ? 'fija' : ''} ${inicio ? 'sobre-foto' : ''} ${esAdmin(s) ? 'admin' : ''}`}>
          <Link to="/" className="marca"><Marca />Atracciones Ecuador</Link>
          <nav aria-label="Principal">
            <NavLink to="/" end>Atracciones</NavLink>
            {s && <NavLink to="/mis-reservas">Mis reservas</NavLink>}
            {!s && <><NavLink to="/login">Ingresar</NavLink><NavLink to="/registro">Crear cuenta</NavLink></>}
            {esAdmin(s) && <>
              <NavLink to="/admin" end>Panel</NavLink><NavLink to="/admin/atracciones">Mis atracciones</NavLink><NavLink to="/admin/stock">Stock</NavLink>
              <NavLink to="/admin/reservas">Reservas y check-in</NavLink><NavLink to="/admin/usuarios">Usuarios</NavLink><NavLink to="/admin/observabilidad">Observabilidad</NavLink>
            </>}
          </nav>
          <div className="barra-der">
            {s ? <>
              {!(esAdmin(s) && /^administrador$/i.test(s.user?.nombre ?? '')) && <span className="usuario">{s.user?.nombre}</span>}
              {esAdmin(s) && <span className="rol">Administrador</span>}
              <button className="sec" onClick={() => { sesion.borrar(); nav('/'); }}>Salir</button>
            </> : <>
              <button className="cta" onClick={irCatalogo}>Planea tu viaje</button>
            </>}
          </div>
        </header>
        <main className={inicio ? 'sin-relleno' : ''}>
          <Routes>
            <Route path="/" element={<Catalogo />} />
            <Route path="/atraccion/:id" element={<Detalle />} />
            <Route path="/mis-reservas" element={<MisReservas />} />
            <Route path="/login" element={<Login />} />
            <Route path="/registro" element={<Registro />} />
            <Route path="/admin" element={<Protegida s={s}><AdminDashboard /></Protegida>} />
            <Route path="/admin/atracciones" element={<Protegida s={s}><AdminAtracciones /></Protegida>} />
            <Route path="/admin/atracciones/nueva" element={<Protegida s={s}><NuevaAtraccion /></Protegida>} />
            <Route path="/admin/atracciones/:id/editar" element={<Protegida s={s}><EditarAtraccion /></Protegida>} />
            <Route path="/admin/usuarios" element={<Protegida s={s}><Usuarios /></Protegida>} />
            <Route path="/admin/stock" element={<Protegida s={s}><Stock /></Protegida>} />
            <Route path="/admin/observabilidad" element={<Protegida s={s}><Observabilidad /></Protegida>} />
            <Route path="/admin/atracciones/:id/cupos" element={<Protegida s={s}><Cupos /></Protegida>} />
            <Route path="/admin/reservas" element={<Protegida s={s}><Reservas /></Protegida>} />
            <Route path="*" element={<p className="vacio">Página no encontrada. <Link to="/">Volver al inicio</Link></p>} />
          </Routes>
        </main>
        <footer className="pie"><strong>Alisson Basantes</strong></footer>
      </div>
    </div>
  );
}
