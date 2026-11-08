// Arranca los tres microservicios a la vez (cada uno lee SU .env).   npm run start:all
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hijos = ['ms_inventory', 'ms_order', 'ms_booking'].map((ms) => {
  const p = spawn(process.execPath, ['src/server.mjs'], { cwd: path.join(raiz, ms), stdio: ['ignore', 'pipe', 'pipe'] });
  const pref = (s) => String(s).split('\n').filter(Boolean).forEach((l) => console.log(`[${ms}] ${l}`));
  p.stdout.on('data', pref); p.stderr.on('data', pref);
  p.on('exit', (c) => console.log(`[${ms}] terminó (código ${c}). ¿Falta DATABASE_URL en ${ms}/.env o la base no tiene tablas? Ejecute npm run db:migrate`));
  return p;
});
const salir = () => { hijos.forEach((h) => h.kill('SIGINT')); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', salir); process.on('SIGTERM', salir);
