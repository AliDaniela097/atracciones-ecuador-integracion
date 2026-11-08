// Arranca los 13 microservicios nuevos en UN proceso (cada uno con su servidor, su puerto y su base de datos propios).
// Se agrupan para ahorrar memoria en el App Service B1; cada servicio sigue siendo independiente (también puede correr solo: npm start en su carpeta).
// Robustez: si un servicio no puede arrancar (p. ej. la base está despertando) se reintenta con espera creciente SIN afectar a los demás;
// si un servidor se cae, se vuelve a levantar. /health del hub resume el estado de todos.
import dotenv from 'dotenv';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(raiz, '.env.ms'), quiet: true });
process.env.MS_INTERNAL_KEY ||= crypto.randomBytes(24).toString('hex');       // clave entre servicios (solo vive en este proceso si no se define)
const { SERVICIOS } = await import('../_shared/servicios.mjs');
const { migrar, iniciar } = await import('../_shared/servicio.mjs');

const seleccion = (process.env.MS_ENABLED_SERVICES ?? Object.keys(SERVICIOS).join(',')).split(',').map((s) => s.trim()).filter((s) => SERVICIOS[s]);
const estado = Object.fromEntries(seleccion.map((n) => [n, { estado: 'ARRANCANDO', intentos: 0, desde: null, ultimo_error: null }]));
const vivos = new Map(); let cerrando = false;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'hub', ...o }));

async function mantener(nombre) {
  const e = estado[nombre];
  while (!cerrando) {
    try {
      e.intentos += 1; e.estado = 'ARRANCANDO';
      const def = (await import(`../ms_${nombre}/src/definicion.mjs`)).default;
      if (process.env.MS_AUTO_MIGRATE !== 'false') await migrar(def);
      const s = await iniciar(def);
      vivos.set(nombre, s); e.estado = 'UP'; e.desde = new Date().toISOString(); e.ultimo_error = null; e.intentos = 0;
      await new Promise((res) => { s.server.once('close', res); s.server.once('error', res); });     // espera a que se caiga
      vivos.delete(nombre); if (cerrando) return;
      e.estado = 'REINICIANDO'; log({ level: 'error', msg: `ms_${nombre} se detuvo; se reinicia` });
    } catch (x) {
      e.estado = 'REINTENTANDO'; e.ultimo_error = String(x.message ?? x).slice(0, 200);
      log({ level: 'error', msg: `ms_${nombre} no pudo arrancar: ${e.ultimo_error}` });
    }
    await dormir(Math.min(60000, 2000 * 2 ** Math.min(e.intentos, 5)));
  }
}
seleccion.forEach((n) => { mantener(n); });

// Salud agregada (solo local): GET /health → estado de cada servicio (consultando su /health).
const hubPort = Number(process.env.MS_HUB_PORT ?? 50100);
const hub = http.createServer(async (req, res) => {
  if (!['/health', '/health/live'].includes(req.url.split('?')[0])) { res.writeHead(404).end(); return; }
  const detalle = {};
  await Promise.all(seleccion.map(async (n) => {
    if (estado[n].estado !== 'UP' || !vivos.get(n)) { detalle[n] = { status: 'DOWN', ...estado[n] }; return; }
    try { const j = await vivos.get(n).salud(); detalle[n] = { status: j.status, protocol: j.protocol, database: j.database, requests: j.requests, uptime_s: j.uptime_s }; }
    catch (x) { detalle[n] = { status: 'DOWN', error: x.message }; }
  }));
  const caidos = Object.entries(detalle).filter(([, v]) => v.status !== 'UP').map(([k]) => k);
  const cuerpo = { status: caidos.length === 0 ? 'UP' : caidos.length === seleccion.length ? 'DOWN' : 'DEGRADED', total: seleccion.length, up: seleccion.length - caidos.length, down: caidos, services: detalle, memory_mb: Math.round(process.memoryUsage().rss / 1048576) };
  res.writeHead(caidos.length === seleccion.length ? 503 : 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(cuerpo));
});
hub.on('error', (e) => log({ level: 'error', msg: 'hub: ' + e.message }));
hub.listen(hubPort, process.env.MS_BIND ?? '127.0.0.1', () => log({ level: 'info', msg: 'hub iniciado', puerto: hubPort, servicios: seleccion.length }));

const salir = async () => { cerrando = true; log({ msg: 'cerrando' }); await Promise.race([Promise.all([...vivos.values()].map((s) => s.cerrar())), dormir(4000)]); process.exit(0); };
process.on('SIGINT', salir); process.on('SIGTERM', salir);
// Una promesa rechazada o excepción inesperada en un servicio NO debe tumbar a los demás.
process.on('unhandledRejection', (e) => log({ level: 'error', msg: 'unhandledRejection: ' + String(e?.stack ?? e).slice(0, 500) }));
process.on('uncaughtException', (e) => log({ level: 'error', msg: 'uncaughtException: ' + String(e?.stack ?? e).slice(0, 500) }));
