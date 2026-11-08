// ms_identity — registro, inicio de sesión, verificación de correo y roles. Base propia: ms_identity.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado, conflicto } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar, exigirInterna } from '../../_shared/auth.mjs';
import { paginar, meta } from '../../_shared/pgs.mjs';
import { publicar } from '../../_shared/eventos.mjs';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SESION_H = Number(process.env.MS_SESSION_HOURS ?? 12);
const usuarioPublico = (u) => ({ usu_id: u.usu_id, correo: u.usu_correo, nombre: u.usu_nombre, apellido: u.usu_apellido, documento: u.usu_documento, telefono: u.usu_telefono, verificado: u.usu_verificado, activo: u.usu_activo, ultimo_acceso: u.usu_ultimo_acceso, creado_en: u.usu_creado_en });
const PASS = { type: 'string', minLength: 8, maxLength: 72, pattern: '^(?=.*[A-Za-z])(?=.*[0-9]).+$' };   // 72 = límite de bcrypt
const CORREO = { type: 'string', format: 'email', maxLength: 160 };

// Freno de fuerza bruta: 5 intentos fallidos por correo en 15 min → bloqueo temporal (en memoria).
const fallos = new Map();
const bloqueado = (k) => { const f = fallos.get(k); return f && f.n >= 5 && Date.now() - f.t < 15 * 60000; };
const falla = (k) => { const f = fallos.get(k); if (!f || Date.now() - f.t > 15 * 60000) fallos.set(k, { n: 1, t: Date.now() }); else f.n += 1; if (fallos.size > 5000) fallos.clear(); };

async function rolesDe(db, usuId) {
  const r = await db.q('SELECT rol_nombre FROM v_usuario_roles WHERE usu_id = $1 ORDER BY rol_nombre', [usuId]);
  return r.rows.map((x) => x.rol_nombre);
}
async function crearSesion(db, u, ctx) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expira = new Date(Date.now() + SESION_H * 3600000);
  await db.q('INSERT INTO sesion (usu_id, ses_token_hash, ses_ip, ses_user_agent, ses_expira_en) VALUES ($1,$2,$3,$4,$5)',
    [u.usu_id, hash(token), String(ctx.ip).slice(0, 45), String(ctx.headers['user-agent'] ?? '').slice(0, 255), expira]);
  return { access_token: token, token_type: 'Bearer', expires_at: expira.toISOString() };
}
async function validarLocal(db, token) {
  const r = await db.q(`SELECT s.usu_id, u.usu_correo FROM sesion s JOIN usuario u ON u.usu_id = s.usu_id
                        WHERE s.ses_token_hash = $1 AND NOT s.ses_revocada AND s.ses_expira_en > now() AND u.usu_activo`, [hash(token)]);
  if (!r.rows[0]) return null;
  return { valid: true, usu_id: r.rows[0].usu_id, correo: r.rows[0].usu_correo, roles: await rolesDe(db, r.rows[0].usu_id) };
}

const esquemas = {
  registro: { type: 'object', additionalProperties: false, required: ['correo', 'password', 'nombre', 'apellido'], properties: {
    correo: CORREO, password: PASS, nombre: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' }, apellido: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
    documento: { type: 'string', pattern: '^([0-9]{10}|[A-Z]{1,2}[0-9]{6,9})$' }, telefono: { type: 'string', pattern: '^\\+?[0-9]{7,15}$' }, fecha_nacimiento: { type: 'string', format: 'date' } } },
  login: { type: 'object', additionalProperties: false, required: ['correo', 'password'], properties: { correo: CORREO, password: { type: 'string', minLength: 1, maxLength: 200 } } },
  token: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', minLength: 10, maxLength: 200 } } },
  olvido: { type: 'object', additionalProperties: false, required: ['correo'], properties: { correo: CORREO } },
  reset: { type: 'object', additionalProperties: false, required: ['token', 'password'], properties: { token: { type: 'string', minLength: 10, maxLength: 200 }, password: PASS } },
  rol: { type: 'object', additionalProperties: false, required: ['rol'], properties: { rol: { type: 'string', enum: ['ADMIN', 'OPERADOR', 'CLIENTE'] } } },
  lista: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, q: { type: 'string', maxLength: 100 } } },
};

function crearRutas(r, { db }) {
  const exponer = process.env.MS_EXPOSE_TOKENS === 'true';      // solo pruebas: sin servicio de correo, el token de verificación se devuelve en la respuesta

  r.post('/v1/auth/register', async (ctx) => {
    const b = ctx.validar('registro', ctx.body);
    const clave = await bcrypt.hash(b.password, 10);
    const { u, tok } = await db.tx(async (c) => {
      const ins = await c.query(`INSERT INTO usuario (usu_correo, usu_password, usu_nombre, usu_apellido, usu_documento, usu_telefono, usu_fecha_nacimiento)
                                 VALUES (lower($1),$2,btrim($3),btrim($4),$5,$6,$7) RETURNING *`, [b.correo, clave, b.nombre, b.apellido, b.documento ?? null, b.telefono ?? null, b.fecha_nacimiento ?? null]);
      await c.query(`INSERT INTO usuario_rol (usu_id, rol_id) SELECT $1, rol_id FROM rol WHERE rol_nombre = 'CLIENTE'`, [ins.rows[0].usu_id]);
      const t = crypto.randomBytes(24).toString('base64url');
      await c.query(`INSERT INTO token_verificacion (usu_id, tokv_token, tokv_tipo, tokv_expira_en) VALUES ($1,$2,'EMAIL', now() + interval '24 hours')`, [ins.rows[0].usu_id, hash(t)]);
      return { u: ins.rows[0], tok: t };
    });
    publish(u.usu_id, 'USUARIO_REGISTRADO', u.usu_id);
    return responder(201, { ...usuarioPublico(u), roles: ['CLIENTE'], ...(exponer ? { verification_token: tok } : {}) });
  });
  const publish = (usuId, accion, id, detalle) => publicar({ tipo: accion, origen: 'identity', usu_id: usuId, entidad: 'usuario', entidad_id: String(id ?? ''), datos: detalle ?? {} });

  r.post('/v1/auth/verify-email', async (ctx) => {
    const { token } = ctx.validar('token', ctx.body);
    const ok = await db.tx(async (c) => {
      const t = await c.query(`UPDATE token_verificacion SET tokv_usado = TRUE WHERE tokv_token = $1 AND tokv_tipo = 'EMAIL' AND NOT tokv_usado AND tokv_expira_en > now() RETURNING usu_id`, [hash(token)]);
      if (!t.rows[0]) return false;
      await c.query('UPDATE usuario SET usu_verificado = TRUE WHERE usu_id = $1', [t.rows[0].usu_id]); return true;
    });
    if (!ok) throw err(400, 'INVALID_TOKEN', 'El token es inválido, ya fue usado o venció.');
    return { verificado: true };
  });

  r.post('/v1/auth/login', async (ctx) => {
    const b = ctx.validar('login', ctx.body); const correo = b.correo.toLowerCase();
    if (bloqueado(correo)) throw err(429, 'TOO_MANY_ATTEMPTS', 'Demasiados intentos fallidos. Intente de nuevo en 15 minutos.');
    const x = await db.q('SELECT * FROM usuario WHERE usu_correo = $1', [correo]);
    const u = x.rows[0];
    // Se compara siempre contra un hash (aunque el usuario no exista) para no revelar por tiempo si el correo está registrado.
    const okPass = await bcrypt.compare(b.password, u?.usu_password ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    if (!u || !okPass || !u.usu_activo) { falla(correo); throw err(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.'); }
    fallos.delete(correo);
    await db.q('UPDATE usuario SET usu_ultimo_acceso = now() WHERE usu_id = $1', [u.usu_id]);
    const s = await crearSesion(db, u, ctx);
    publish(u.usu_id, 'LOGIN', u.usu_id);
    return { ...s, usuario: usuarioPublico(u), roles: await rolesDe(db, u.usu_id) };
  });

  r.post('/v1/auth/logout', async (ctx) => {
    const m = /^Bearer\s+(\S+)$/.exec(ctx.headers.authorization ?? ''); if (!m) throw err(401, 'UNAUTHORIZED', 'Falta el token.');
    await db.q('UPDATE sesion SET ses_revocada = TRUE WHERE ses_token_hash = $1', [hash(m[1])]);
    return responder(200, { cerrada: true });
  });

  r.get('/v1/auth/me', async (ctx) => {
    const a = await autorizar(ctx, { localValidar: (t) => validarLocal(db, t) });
    if (!a.usu_id) throw err(400, 'NO_USER', 'La llamada no corresponde a un usuario.');
    const u = (await db.q('SELECT * FROM usuario WHERE usu_id = $1', [a.usu_id])).rows[0];
    return { ...usuarioPublico(u), roles: a.roles };
  });

  // Usado por los demás servicios para validar un token (no revela datos sensibles).
  r.post('/v1/auth/validate', async (ctx) => {
    const { token } = ctx.validar('token', ctx.body);
    return (await validarLocal(db, token)) ?? { valid: false };
  });

  // Recuperación: siempre 202 (no revela si el correo existe).
  r.post('/v1/auth/password/forgot', async (ctx) => {
    const { correo } = ctx.validar('olvido', ctx.body);
    const u = (await db.q('SELECT usu_id FROM usuario WHERE usu_correo = lower($1) AND usu_activo', [correo])).rows[0];
    let tok;
    if (u) { tok = crypto.randomBytes(24).toString('base64url'); await db.q(`INSERT INTO token_verificacion (usu_id, tokv_token, tokv_tipo, tokv_expira_en) VALUES ($1,$2,'RECUPERACION', now() + interval '1 hour')`, [u.usu_id, hash(tok)]); }
    return responder(202, { mensaje: 'Si el correo existe, recibirá instrucciones.', ...(exponer && tok ? { reset_token: tok } : {}) });
  });
  r.post('/v1/auth/password/reset', async (ctx) => {
    const b = ctx.validar('reset', ctx.body); const clave = await bcrypt.hash(b.password, 10);
    const ok = await db.tx(async (c) => {
      const t = await c.query(`UPDATE token_verificacion SET tokv_usado = TRUE WHERE tokv_token = $1 AND tokv_tipo = 'RECUPERACION' AND NOT tokv_usado AND tokv_expira_en > now() RETURNING usu_id`, [hash(b.token)]);
      if (!t.rows[0]) return false;
      await c.query('UPDATE usuario SET usu_password = $2 WHERE usu_id = $1', [t.rows[0].usu_id, clave]);
      await c.query('UPDATE sesion SET ses_revocada = TRUE WHERE usu_id = $1', [t.rows[0].usu_id]); return true;     // cierra todas las sesiones
    });
    if (!ok) throw err(400, 'INVALID_TOKEN', 'El token es inválido, ya fue usado o venció.');
    return { restablecida: true };
  });

  r.get('/v1/roles', async () => ({ data: (await db.q('SELECT rol_id, rol_nombre, rol_descripcion FROM rol WHERE rol_activo ORDER BY rol_id')).rows }));

  r.get('/v1/usuarios', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'], localValidar: (t) => validarLocal(db, t) });
    const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q);
    const filtro = q.q ? 'WHERE usu_correo ILIKE $1 OR usu_nombre ILIKE $1 OR usu_apellido ILIKE $1' : ''; const par = q.q ? [`%${q.q}%`] : [];
    const tot = (await db.q(`SELECT count(*) AS n FROM usuario ${filtro}`, par)).rows[0].n;
    const rows = (await db.q(`SELECT * FROM usuario ${filtro} ORDER BY usu_id LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows;
    return { data: rows.map(usuarioPublico), metadata: meta(tot, p) };
  });
  r.get('/v1/usuarios/:usuId', async (ctx) => {
    await autorizar(ctx, { propietario: 'usuId', localValidar: (t) => validarLocal(db, t) });
    if (!/^\d+$/.test(ctx.params.usuId)) throw err(400, 'BAD_ID', 'usuId debe ser numérico.');
    const u = (await db.q('SELECT * FROM usuario WHERE usu_id = $1', [ctx.params.usuId])).rows[0]; if (!u) throw noEncontrado('El usuario');
    return { ...usuarioPublico(u), roles: await rolesDe(db, u.usu_id) };
  });
  r.post('/v1/usuarios/:usuId/roles', async (ctx) => {
    const a = await autorizar(ctx, { roles: ['ADMIN'], localValidar: (t) => validarLocal(db, t) });
    const { rol } = ctx.validar('rol', ctx.body);
    const u = (await db.q('SELECT usu_id FROM usuario WHERE usu_id = $1', [ctx.params.usuId])).rows[0]; if (!u) throw noEncontrado('El usuario');
    await db.q(`INSERT INTO usuario_rol (usu_id, rol_id, usr_asignado_por) SELECT $1, rol_id, $3 FROM rol WHERE rol_nombre = $2 ON CONFLICT DO NOTHING`, [u.usu_id, rol, a.usu_id]);
    publish(a.usu_id, 'ROL_ASIGNADO', u.usu_id, { rol });
    return responder(201, { usu_id: u.usu_id, roles: await rolesDe(db, u.usu_id) });
  });
  r.delete('/v1/usuarios/:usuId/roles/:rol', async (ctx) => {
    const a = await autorizar(ctx, { roles: ['ADMIN'], localValidar: (t) => validarLocal(db, t) });
    if (String(a.usu_id) === ctx.params.usuId && ctx.params.rol === 'ADMIN') throw conflicto('Un administrador no puede quitarse a sí mismo el rol ADMIN.', 'SELF_DEMOTE');
    await db.q('DELETE FROM usuario_rol WHERE usu_id = $1 AND rol_id = (SELECT rol_id FROM rol WHERE rol_nombre = $2)', [ctx.params.usuId, ctx.params.rol]);
    publish(a.usu_id, 'ROL_REVOCADO', ctx.params.usuId, { rol: ctx.params.rol });
    return { usu_id: Number(ctx.params.usuId), roles: await rolesDe(db, ctx.params.usuId) };
  });
  r.patch('/v1/usuarios/:usuId/activo', async (ctx) => {
    const a = await autorizar(ctx, { roles: ['ADMIN'], localValidar: (t) => validarLocal(db, t) });
    if (typeof ctx.body.activo !== 'boolean') throw err(400, 'VALIDATION_ERROR', 'Falta el campo booleano activo.', [{ name: 'activo', reason: 'requerido' }]);
    if (String(a.usu_id) === ctx.params.usuId && !ctx.body.activo) throw conflicto('No puede desactivar su propia cuenta.', 'SELF_DISABLE');
    const x = await db.q('UPDATE usuario SET usu_activo = $2 WHERE usu_id = $1 RETURNING *', [ctx.params.usuId, ctx.body.activo]); if (!x.rows[0]) throw noEncontrado('El usuario');
    if (!ctx.body.activo) await db.q('UPDATE sesion SET ses_revocada = TRUE WHERE usu_id = $1', [ctx.params.usuId]);
    return usuarioPublico(x.rows[0]);
  });
  r.post('/internal/limpiar-sesiones', async (ctx) => { exigirInterna(ctx); const x = await db.q(`DELETE FROM sesion WHERE ses_expira_en < now() - interval '7 days'`); return { eliminadas: x.rowCount }; });
}

// Al iniciar: crea el administrador inicial si se configuró MS_ADMIN_EMAIL/MS_ADMIN_PASSWORD (o ADMIN_EMAIL/ADMIN_PASSWORD) y aún no hay ninguno.
async function alIniciar(db) {
  const correo = process.env.MS_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL; const pass = process.env.MS_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
  if (!correo || !pass || pass.length < 8) return;
  const hay = (await db.q(`SELECT 1 FROM v_usuario_roles WHERE rol_nombre = 'ADMIN' LIMIT 1`)).rows[0]; if (hay) return;
  await db.tx(async (c) => {
    const u = await c.query(`INSERT INTO usuario (usu_correo, usu_password, usu_nombre, usu_apellido, usu_verificado) VALUES (lower($1),$2,'Administrador','Descubre EC',TRUE)
                             ON CONFLICT (usu_correo) DO UPDATE SET usu_verificado = TRUE RETURNING usu_id`, [correo, await bcrypt.hash(pass.slice(0, 72), 10)]);
    await c.query(`INSERT INTO usuario_rol (usu_id, rol_id) SELECT $1, rol_id FROM rol WHERE rol_nombre IN ('ADMIN','CLIENTE') ON CONFLICT DO NOTHING`, [u.rows[0].usu_id]);
  });
  console.log(JSON.stringify({ level: 'info', msg: 'ms_identity: administrador inicial creado' }));
}

export default { nombre: 'identity', marcador: 'usuario', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas, alIniciar };
