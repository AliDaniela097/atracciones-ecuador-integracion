// Arranque para Azure App Service (Linux): UN solo contenedor con el backend REST, los 3 microservicios gRPC y el "hub" con los 13 microservicios nuevos.
//   Comando de inicio:  node azure-start.mjs
// Los microservicios escuchan solo en localhost (50061-50063 gRPC; 50100 hub con 50101-50113); hacia afuera únicamente se expone el backend (PORT de Azure).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.dirname(fileURLToPath(import.meta.url));
const log = (msg, extra = {}) => console.log(JSON.stringify({ level: 'info', origen: 'azure-start', msg, ...extra }));
const falta = (n) => { console.error(JSON.stringify({ level: 'error', origen: 'azure-start', msg: `Falta la variable de entorno ${n} (App Service → Variables de entorno).` })); process.exit(1); };
for (const n of ['DATABASE_URL', 'MS_INVENTORY_DATABASE_URL', 'MS_ORDER_DATABASE_URL', 'MS_BOOKING_DATABASE_URL']) if (!process.env[n]) falta(n);

const servicios = [
  { nombre: 'ms_inventory', cwd: 'microservicios/ms_inventory', cmd: ['src/server.mjs'], env: { DATABASE_URL: process.env.MS_INVENTORY_DATABASE_URL, GRPC_PORT: '50061', GRPC_ENABLED: 'false' }, puerto: 50061 },
  { nombre: 'ms_order', cwd: 'microservicios/ms_order', cmd: ['src/server.mjs'], env: { DATABASE_URL: process.env.MS_ORDER_DATABASE_URL, GRPC_PORT: '50062' }, puerto: 50062 },
  { nombre: 'ms_booking', cwd: 'microservicios/ms_booking', cmd: ['src/server.mjs'], env: { DATABASE_URL: process.env.MS_BOOKING_DATABASE_URL, GRPC_PORT: '50063' }, puerto: 50063 },
];
// Hub de los 13 microservicios nuevos (un proceso, 13 servidores y 13 bases). Si falta MS_DB_BASE_URL se omite SIN afectar al resto.
const hub = process.env.MS_DB_BASE_URL
  ? { nombre: 'ms_hub', cwd: 'microservicios', cmd: ['--max-old-space-size=320', 'scripts/start-hub.mjs'], env: { MS_ORDER_GRPC: '127.0.0.1:50062', MS_BIND: '127.0.0.1', MS_EXPOSE_TOKENS: 'false' }, puerto: 50100 }
  : null;
if (!hub) console.log(JSON.stringify({ level: 'warn', origen: 'azure-start', msg: 'MS_DB_BASE_URL no está definida: los 13 microservicios nuevos NO se inician.' }));
const backend = { nombre: 'backend', cwd: 'backend', cmd: ['dist/main.js'], env: { MS_ENABLED: process.env.MS_ENABLED ?? 'true', MS_INVENTORY_TARGET: 'localhost:50061', MS_ORDER_TARGET: 'localhost:50062', MS_BOOKING_TARGET: 'localhost:50063' }, puerto: Number(process.env.PORT ?? 8080) };

const hijos = new Map(); let cerrando = false;
const esperarPuerto = (puerto, ms = 60000) => new Promise((ok, mal) => {
  const t0 = Date.now();
  const intento = () => { const s = net.connect(puerto, '127.0.0.1'); s.on('connect', () => { s.destroy(); ok(); }); s.on('error', () => { s.destroy(); Date.now() - t0 > ms ? mal(new Error(`el puerto ${puerto} no abrió`)) : setTimeout(intento, 300); }); };
  intento();
});
function lanzar(s, intentos = 0) {
  const p = spawn(process.execPath, s.cmd, { cwd: path.join(raiz, s.cwd), env: { ...process.env, ...s.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const pref = (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(`[${s.nombre}] ${l}`));
  p.stdout.on('data', pref); p.stderr.on('data', pref); hijos.set(s.nombre, p);
  p.on('exit', (codigo) => {
    if (cerrando) return;
    const espera = Math.min(2000 * 2 ** intentos, 30000);
    log(`${s.nombre} terminó (código ${codigo}); se reinicia en ${espera} ms`, { intentos: intentos + 1 });
    setTimeout(() => lanzar(s, intentos + 1), espera);
  });
  setTimeout(() => { if (hijos.get(s.nombre) === p && p.exitCode === null) intentos = 0; }, 60000).unref();
}
const cerrar = () => { cerrando = true; hijos.forEach((h) => h.kill('SIGTERM')); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', cerrar); process.on('SIGINT', cerrar);

log('Iniciando microservicios', { node: process.version });
if (hub) servicios.push(hub);
servicios.forEach((s) => lanzar(s));
try { await Promise.all(servicios.map((s) => esperarPuerto(s.puerto))); log('Microservicios listos; iniciando el backend REST', { puerto: backend.puerto }); }
catch (e) { log(`Aviso: ${e.message}. Se inicia el backend igualmente (reintentará la conexión).`); }
lanzar(backend);
