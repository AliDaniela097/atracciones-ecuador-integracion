// Uso: node scripts/db.mjs migrate | seed | reset   (lee DATABASE_URL de .env o del entorno)
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL (ver .env.example)'); process.exit(1); }
const ssl = /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined;
const client = new pg.Client({ connectionString: url, ssl });

const run = async (dir) => {
  for (const f of fs.readdirSync(path.join(root, dir)).filter((x) => x.endsWith('.sql')).sort()) {
    await client.query(fs.readFileSync(path.join(root, dir, f), 'utf8'));
    console.log(`  ok ${dir}/${f}`);
  }
};
const crearAdmin = async () => {
  const correo = process.env.ADMIN_EMAIL, pass = process.env.ADMIN_PASSWORD;
  if (!correo || !pass) return console.log('  (sin ADMIN_EMAIL/ADMIN_PASSWORD: no se crea administrador)');
  const hash = await bcrypt.hash(pass, 10);
  const { rows } = await client.query(
    `INSERT INTO usuario (usu_correo, usu_password, usu_nombre, usu_apellido) VALUES ($1,$2,'Administrador','Sistema')
     ON CONFLICT (usu_correo) DO UPDATE SET usu_password = EXCLUDED.usu_password RETURNING usu_id`, [correo, hash]);
  await client.query(`INSERT INTO usuario_rol SELECT $1, rol_id FROM rol WHERE rol_nombre='ADMIN' ON CONFLICT DO NOTHING`, [rows[0].usu_id]);
  console.log(`  ok administrador ${correo}`);
};

const cmd = process.argv[2];
await client.connect();
try {
  if (cmd === 'reset') {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('  esquema reiniciado');
  }
  if (cmd === 'migrate' || cmd === 'reset') await run('db/migrations');
  if (cmd === 'seed' || cmd === 'reset') {
    await run('db/seeds');
    await crearAdmin();
  }
  if (!['migrate', 'seed', 'reset'].includes(cmd)) console.log('Uso: migrate | seed | reset');
} finally { await client.end(); }
