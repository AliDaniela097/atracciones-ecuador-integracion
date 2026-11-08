// Sube a Azure SOLO las 5 cadenas de conexión de las bases (después de cambiar las contraseñas en Neon). No toca ninguna otra variable.
// Antes: edite las contraseñas en backend/.env y microservicios/ms_inventory|ms_order|ms_booking/.env.   No imprime secretos.
//   node deploy/actualizar-bases-azure.mjs alisson-atracciones-api
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = process.argv[2];
if (!app) { console.error('Uso: node deploy/actualizar-bases-azure.mjs <nombre-de-la-app>'); process.exit(1); }
const aqui = path.dirname(fileURLToPath(import.meta.url)); const raiz = path.resolve(aqui, '..');
const leer = (rel) => { const f = path.join(raiz, rel); if (!fs.existsSync(f)) { console.error(`✖ No existe ${rel}`); process.exit(1); }
  const o = {}; for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const t = l.trim(); if (!t || t.startsWith('#')) continue; const i = t.indexOf('='); if (i < 1) continue; let v = t.slice(i + 1).trim(); if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1); o[t.slice(0, i).trim()] = v; } return o; };
const url = (rel) => { const v = leer(rel).DATABASE_URL; if (!v || !/^postgres(ql)?:\/\//.test(v)) { console.error(`✖ ${rel}: falta DATABASE_URL válida`); process.exit(1); } return v; };
const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

const nuevo = {
  DATABASE_URL: url('backend/.env'),
  MS_INVENTORY_DATABASE_URL: url('microservicios/ms_inventory/.env'),
  MS_ORDER_DATABASE_URL: url('microservicios/ms_order/.env'),
  MS_BOOKING_DATABASE_URL: url('microservicios/ms_booking/.env'),
};
nuevo.MS_DB_BASE_URL = nuevo.MS_INVENTORY_DATABASE_URL;

// ¿Cambiaron respecto al archivo viejo (azure-settings.json)? Compara huellas, sin mostrar nada.
const viejoF = path.join(aqui, 'azure-settings.json');
if (fs.existsSync(viejoF)) {
  const viejo = Object.fromEntries(JSON.parse(fs.readFileSync(viejoF, 'utf8')).map((x) => [x.name, x.value]));
  const iguales = Object.keys(nuevo).filter((k) => viejo[k] && h(viejo[k]) === h(nuevo[k]));
  if (iguales.length) { console.error(`✖ Estas variables siguen IGUALES a las anteriores (¿no cambió la contraseña en el .env?): ${iguales.join(', ')}`); process.exit(1); }
}
const tmp = path.join(aqui, '.tmp-bases.json');
fs.writeFileSync(tmp, JSON.stringify(Object.entries(nuevo).map(([name, value]) => ({ name, value, slotSetting: false }))));
try {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'az.cmd' : 'az', ['webapp', 'config', 'appsettings', 'set', '--resource-group', `rg-${app}`, '--name', app, '--settings', '@.tmp-bases.json', '--query', '[].name', '-o', 'tsv'], { cwd: aqui, shell: win, encoding: 'utf8' });
  if (r.status !== 0) { console.error('✖ Falló az webapp config appsettings set:\n' + (r.stderr || '').replace(/postgres(ql)?:\/\/\S+/g, 'postgresql://***')); process.exit(1); }
  console.log(`✔ Actualizadas en Azure: ${Object.keys(nuevo).join(', ')}.\n  La app se reinicia sola (tarda ~1-2 minutos). No se tocó ninguna otra variable.`);
} finally { fs.rmSync(tmp, { force: true }); }
