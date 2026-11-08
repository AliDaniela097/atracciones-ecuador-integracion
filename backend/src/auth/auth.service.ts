import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Db } from '../db/db.service.js';
import { config } from '../config.js';
import { badRequest, conflict, ApiProblem, unauthorized } from '../common/problem.js';
import { correoValido } from '../common/util.js';

const fails = new Map<string, { n: number; until: number }>(); // limitador simple anti fuerza bruta (en memoria)

@Injectable()
export class AuthService {
  constructor(@Inject(Db) private db: Db) {}

  private async roles(usuId: number): Promise<string[]> {
    return (await this.db.query('SELECT r.rol_nombre FROM usuario_rol ur JOIN rol r ON r.rol_id=ur.rol_id WHERE ur.usu_id=$1', [usuId])).map((r) => r.rol_nombre);
  }
  private sign(u: any, roles: string[]) {
    return jwt.sign({ email: u.usu_correo, roles }, config.jwtSecret, { subject: String(u.usu_id), expiresIn: config.jwtExpiresIn as any });
  }
  private publico(u: any, roles: string[]) {
    return { id: u.usu_id, email: u.usu_correo, nombre: u.usu_nombre, apellido: u.usu_apellido, roles };
  }

  async login(body: any, ip: string) {
    const email = String(body?.email ?? '').trim().toLowerCase(); const password = String(body?.password ?? '');
    if (!email || !password) throw badRequest('email y password son obligatorios.', 'VALIDATION_ERROR', [{ name: !email ? 'email' : 'password', reason: 'Obligatorio' }]);
    const key = `${email}|${ip}`; const f = fails.get(key);
    if (f && f.n >= 5 && f.until > Date.now()) throw new ApiProblem(429, 'TOO_MANY_ATTEMPTS', 'Demasiados intentos', 'Espere 15 minutos antes de volver a intentar.', undefined, 'too-many-attempts');
    const u = await this.db.one('SELECT * FROM usuario WHERE usu_correo=$1', [email]);
    const ok = u ? await bcrypt.compare(password, u.usu_password) : (await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali'), false);
    if (!u || !ok || !u.usu_activo) {
      fails.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      throw unauthorized('Correo o contraseña incorrectos.');
    }
    fails.delete(key);
    await this.db.query('UPDATE usuario SET usu_ultimo_acceso=now() WHERE usu_id=$1', [u.usu_id]);
    const roles = await this.roles(u.usu_id);
    return { access_token: this.sign(u, roles), token_type: 'Bearer', expires_in: config.jwtExpiresIn, user: this.publico(u, roles) };
  }

  /** Registro público de turistas: SIEMPRE con rol CLIENTE (nunca se puede auto-asignar ADMIN). */
  async register(body: any) {
    const email = String(body?.email ?? '').trim().toLowerCase(); const password = String(body?.password ?? '');
    const nombre = String(body?.nombre ?? '').trim(); const apellido = String(body?.apellido ?? '').trim();
    const inv = [] as { name: string; reason: string }[];
    if (!correoValido(email)) inv.push({ name: 'email', reason: 'Correo inválido' });
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) inv.push({ name: 'password', reason: 'Mínimo 8 caracteres con letras y números' });
    if (!nombre) inv.push({ name: 'nombre', reason: 'Obligatorio' });
    if (!apellido) inv.push({ name: 'apellido', reason: 'Obligatorio' });
    if (inv.length) throw badRequest('Datos de registro inválidos.', 'VALIDATION_ERROR', inv);
    if (await this.db.one('SELECT 1 FROM usuario WHERE usu_correo=$1', [email])) throw conflict('Ya existe una cuenta con ese correo.', 'EMAIL_ALREADY_REGISTERED');
    const hash = await bcrypt.hash(password, 10);
    const u = await this.db.tx(async (c) => {
      const row = (await c.query('INSERT INTO usuario (usu_correo, usu_password, usu_nombre, usu_apellido) VALUES ($1,$2,$3,$4) RETURNING *', [email, hash, nombre, apellido])).rows[0];
      await c.query(`INSERT INTO usuario_rol SELECT $1, rol_id FROM rol WHERE rol_nombre='CLIENTE'`, [row.usu_id]);
      return row;
    });
    const roles = ['CLIENTE'];
    return { access_token: this.sign(u, roles), token_type: 'Bearer', expires_in: config.jwtExpiresIn, user: this.publico(u, roles) };
  }

  async me(id: number) {
    const u = await this.db.one('SELECT * FROM usuario WHERE usu_id=$1', [id]);
    if (!u || !u.usu_activo) throw unauthorized('La cuenta no existe o está desactivada.');
    return this.publico(u, await this.roles(id));
  }
}
