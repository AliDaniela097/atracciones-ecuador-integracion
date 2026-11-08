// Arma el paquete para Azure: compila el backend, copia solo lo necesario, instala dependencias de PRODUCCIÓN y crea deploy.zip.
//   node deploy/build-package.mjs          (desde Proyecto_Atracciones_Web)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '..');
const stage = path.join(aqui, 'stage');
const win = process.platform === 'win32';
const run = (cmd, args, cwd) => {
  const r = spawnSync(win && cmd === 'npm' ? 'npm.cmd' : cmd, args, { cwd, stdio: 'inherit', shell: win });
  if (r.status !== 0) { console.error(`✖ Falló: ${cmd} ${args.join(' ')} (en ${cwd})`); process.exit(1); }
};
const copiar = (de, a, filtro) => fs.cpSync(de, a, { recursive: true, filter: (f) => !/(^|[\\/])(node_modules|\.env[^\\/]*|\.git)([\\/]|$)/.test(path.relative(de, f)) || /\.env\.example$/.test(f) ? (filtro ? filtro(f) : true) : false });

console.log('▶ 1/5 Compilando el backend y la web…');
run('npm', ['run', 'build'], path.join(raiz, 'backend'));
const web = path.join(raiz, 'frontend');
const hayWeb = fs.existsSync(path.join(web, 'package.json'));
if (hayWeb) {
  if (!fs.existsSync(path.join(web, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], web);
  run('npm', ['run', 'build'], web);
}

console.log('▶ 2/5 Copiando archivos necesarios…');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(aqui, 'azure-start.mjs'), path.join(stage, 'azure-start.mjs'));
const b = path.join(stage, 'backend'); fs.mkdirSync(b);
for (const f of ['dist', 'contracts']) copiar(path.join(raiz, 'backend', f), path.join(b, f));
for (const f of ['package.json', 'package-lock.json']) if (fs.existsSync(path.join(raiz, 'backend', f))) fs.copyFileSync(path.join(raiz, 'backend', f), path.join(b, f));
if (hayWeb) fs.cpSync(path.join(web, 'dist'), path.join(b, 'public'), { recursive: true });
const m = path.join(stage, 'microservicios'); fs.mkdirSync(m);
for (const f of ['package.json', 'package-lock.json']) if (fs.existsSync(path.join(raiz, 'microservicios', f))) fs.copyFileSync(path.join(raiz, 'microservicios', f), path.join(m, f));
for (const ms of ['ms_inventory', 'ms_order', 'ms_booking']) {
  fs.mkdirSync(path.join(m, ms));
  fs.copyFileSync(path.join(raiz, 'microservicios', ms, 'package.json'), path.join(m, ms, 'package.json'));
  for (const d of ['src', 'proto', 'schemas']) copiar(path.join(raiz, 'microservicios', ms, d), path.join(m, ms, d));
}

// Los 13 microservicios nuevos + el código compartido + el lanzador (hub).
copiar(path.join(raiz, 'microservicios', '_shared'), path.join(m, '_shared'));
fs.mkdirSync(path.join(m, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(raiz, 'microservicios', 'scripts', 'start-hub.mjs'), path.join(m, 'scripts', 'start-hub.mjs'));
for (const ms of ['identity', 'billing_profile', 'location', 'catalog', 'review', 'cart', 'coupon', 'payment', 'refund', 'support', 'audit', 'pricing', 'invoicing'].map((n) => `ms_${n}`)) {
  fs.mkdirSync(path.join(m, ms));
  fs.copyFileSync(path.join(raiz, 'microservicios', ms, 'package.json'), path.join(m, ms, 'package.json'));
  for (const d of ['src', 'db', 'proto', 'schemas']) if (fs.existsSync(path.join(raiz, 'microservicios', ms, d))) copiar(path.join(raiz, 'microservicios', ms, d), path.join(m, ms, d));
}

console.log('▶ 3/5 Instalando dependencias de producción (backend)…');
const instalar = (cwd) => { const ci = spawnSync(win ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd, stdio: 'inherit', shell: win }); if (ci.status !== 0) { console.log('  (npm ci falló; se usa npm install)'); run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], cwd); } };
instalar(b);
console.log('▶ 4/5 Instalando dependencias de producción (microservicios)…');
instalar(m);

console.log('▶ 5/5 Creando deploy.zip con separadores "/" (script Python)…');
const zip = path.join(aqui, 'deploy.zip');
const script = path.join(aqui, 'make-zip.py');
let z = { status: 1 };
for (const py of (win ? [['python', []], ['py', ['-3']]] : [['python3', []]])) {
  z = spawnSync(py[0], [...py[1], 'make-zip.py', path.relative(aqui, stage) || 'stage', path.relative(aqui, zip)], { stdio: 'inherit', cwd: aqui }); // rutas relativas y sin espacios: tu Python recorta las rutas con espacios
  if (z.status === 0) break;
}
if (z.status !== 0) { console.error('✖ No se pudo crear el zip. ¿Está instalado Python? (winget install Python.Python.3.12)'); process.exit(1); }
console.log('✔ Listo:', zip);
