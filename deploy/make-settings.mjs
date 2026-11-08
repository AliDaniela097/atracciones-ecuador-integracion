// Genera deploy/azure-settings.json (variables de entorno de Azure) leyendo TUS archivos .env. No imprime secretos.
//   node deploy/make-settings.mjs <nombre-de-la-app>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Lector mínimo de .env (sin dependencias): KEY=valor, ignora comentarios y comillas externas.
const dotenv = { parse(buf) {
  const o = {};
  for (const linea of buf.toString('utf8').split(/\r?\n/)) {
    const t = linea.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    o[t.slice(0, i).trim()] = v;
  }
  return o;
} };

const app = process.argv[2];
if (!app) { console.error('Uso: node deploy/make-settings.mjs <nombre-de-la-app>   (ej. alisson-atracciones-api)'); process.exit(1); }
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => { const f = path.join(raiz, rel); if (!fs.existsSync(f)) { console.error(`✖ No existe ${rel}`); process.exit(1); } return dotenv.parse(fs.readFileSync(f)); };
const be = leer('backend/.env');
const inv = leer('microservicios/ms_inventory/.env'), ord = leer('microservicios/ms_order/.env'), bok = leer('microservicios/ms_booking/.env');
const req = (o, k, de) => { if (!o[k]) { console.error(`✖ Falta ${k} en ${de}`); process.exit(1); } return o[k]; };

const claveBooking = (be.BOOKING_API_KEYS ?? '').split(',')[0].trim();
const s = {
  NODE_ENV: 'production',
  SCM_DO_BUILD_DURING_DEPLOYMENT: 'false',
  WEBSITES_CONTAINER_START_TIME_LIMIT: '600',
  // Bases de datos (cada servicio con la suya)
  DATABASE_URL: req(be, 'DATABASE_URL', 'backend/.env'),
  MS_INVENTORY_DATABASE_URL: req(inv, 'DATABASE_URL', 'ms_inventory/.env'),
  MS_ORDER_DATABASE_URL: req(ord, 'DATABASE_URL', 'ms_order/.env'),
  MS_BOOKING_DATABASE_URL: req(bok, 'DATABASE_URL', 'ms_booking/.env'),
  // Los 13 microservicios nuevos usan una base por servicio dentro del MISMO servidor Neon que ms_inventory (cada una se crea sola al arrancar).
  MS_DB_BASE_URL: req(inv, 'DATABASE_URL', 'ms_inventory/.env'),
  MS_AUTH_MODE: 'identity',
  DB_OVER_WS: 'false', // Azure sí llega al puerto 5432 de Neon
  // Seguridad y datos de la tienda
  JWT_SECRET: req(be, 'JWT_SECRET', 'backend/.env'),
  BOOKING_API_KEYS: req(be, 'BOOKING_API_KEYS', 'backend/.env'),
  SERVICE_ID: be.SERVICE_ID ?? 'NODE_ATR_ALISSON',
  NODE_ID: be.NODE_ID ?? 'node-atracciones-alisson-01',
  PROVIDER_ID: be.PROVIDER_ID ?? 'proveedor-atracciones-alisson',
  PROVIDER_NAME: be.PROVIDER_NAME ?? 'Atracciones Ecuador (Alisson Basantes)',
  VALIDATE_CEDULA: be.VALIDATE_CEDULA ?? 'true',
  PUBLIC_BASE_URL: `https://${app}.azurewebsites.net/api/v3`,
  // Microservicios dentro del mismo contenedor
  MS_ENABLED: 'true',
  // Stock hacia Booking: respaldo HTTP documentado en la guía (X-API-Key). ASUNCIÓN: la clave es la misma que registras en Booking; confírmalo con Paúl.
  GRPC_ENABLED: 'true',
  BOOKING_STOCK_MODE: 'rest',
  BOOKING_REST_STOCK_URL: 'https://booking-puce.brazilsouth.cloudapp.azure.com/api/v3/inventory/stock',
  BOOKING_API_KEY: be.BOOKING_API_KEY ?? claveBooking,
  BOOKING_GRPC_TARGET: 'booking-puce.brazilsouth.cloudapp.azure.com:50051',
  BOOKING_GRPC_TLS: 'false',
};
if (be.ADMIN_EMAIL) s.ADMIN_EMAIL = be.ADMIN_EMAIL;
if (be.ADMIN_PASSWORD) s.ADMIN_PASSWORD = be.ADMIN_PASSWORD;
const salida = Object.entries(s).map(([name, value]) => ({ name, value: String(value), slotSetting: false }));
fs.writeFileSync(path.join(raiz, 'deploy/azure-settings.json'), JSON.stringify(salida, null, 2));
console.log(`✔ deploy/azure-settings.json creado con ${salida.length} variables (no se sube a Git).`);
console.log(`  PUBLIC_BASE_URL = ${s.PUBLIC_BASE_URL}`);
