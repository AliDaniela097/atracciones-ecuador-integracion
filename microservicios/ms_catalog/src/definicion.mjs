// ms_catalog — ficha de la atracción, árbol de categorías, idiomas, inclusiones, fotos y operadores. Base propia: ms_catalog.
// Referencias lógicas: atraccion.ciu_id y operador.prov_id → Location; operador_usuario.usu_id → Identity.
// Consume el evento RESENA_PUBLICADA/RESENA_RETIRADA de Review para actualizar la calificación (reemplaza al trigger del script original).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, noEncontrado, regla } from '../../_shared/errores-http.mjs';
import { responder } from '../../_shared/rest.mjs';
import { autorizar, exigirInterna } from '../../_shared/auth.mjs';
import { obtener } from '../../_shared/llamadas.mjs';
import { paginar, meta } from '../../_shared/pgs.mjs';
import { publicar } from '../../_shared/eventos.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TIPOS = ['GUIDED_TOUR', 'ADMISSION', 'DAY_TRIP', 'TRANSPORT', 'PACKAGE'];
const ESTADOS = ['BORRADOR', 'PUBLICADA', 'INACTIVA'];
const str = (max, min = 1) => ({ type: 'string', minLength: min, maxLength: max, pattern: '\\S' });
const atrProps = {
  nombre: str(200), descripcion: str(20000), descripcion_corta: { type: 'string', maxLength: 280 }, tipo: { type: 'string', enum: TIPOS }, estado: { type: 'string', enum: ESTADOS },
  latitud: { type: 'number', minimum: -90, maximum: 90 }, longitud: { type: 'number', minimum: -180, maximum: 180 }, direccion: { type: 'string', maxLength: 255 }, punto_encuentro: { type: 'string', maxLength: 255 },
  duracion_horas: { type: 'number', exclusiveMinimum: 0, maximum: 720 }, moneda: { type: 'string', pattern: '^[A-Z]{3}$' }, ciu_id: { type: 'integer', minimum: 1, maximum: 32767 }, ope_id: { type: 'integer', minimum: 1 },
  cancelacion_gratuita: { type: 'boolean' }, horas_cancelacion: { type: 'integer', minimum: 0, maximum: 32767 }, destacada: { type: 'boolean' },
};
const esquemas = {
  atraccion: { type: 'object', additionalProperties: false, required: ['nombre', 'descripcion', 'tipo', 'latitud', 'longitud', 'duracion_horas', 'ciu_id', 'ope_id'], properties: atrProps },
  atraccionCambio: { type: 'object', additionalProperties: false, minProperties: 1, properties: { ...atrProps, ope_id: undefined } },
  lista: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, q: { type: 'string', maxLength: 100 }, ciu_id: { type: 'integer' }, cat_id: { type: 'integer' },
    tipo: { type: 'string', enum: TIPOS }, estado: { type: 'string', enum: ESTADOS }, ope_id: { type: 'integer' }, destacada: { type: 'boolean' }, min_calificacion: { type: 'number', minimum: 0, maximum: 5 },
    orden: { type: 'string', enum: ['nombre', 'calificacion', 'reciente'] } } },
  ids: { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'integer', minimum: 1 } } } },
  foto: { type: 'object', additionalProperties: false, required: ['url', 'alt'], properties: { url: { type: 'string', format: 'uri', maxLength: 500, pattern: '^https?://' }, alt: str(200), orden: { type: 'integer', minimum: 0, maximum: 32767 } } },
  operador: { type: 'object', additionalProperties: false, required: ['codigo', 'nombre', 'prov_id'], properties: { codigo: { type: 'integer', minimum: 1 }, nombre: str(150), ruc: { type: 'string', pattern: '^[0-9]{13}$' },
    correo: { type: 'string', format: 'email' }, telefono: { type: 'string', pattern: '^\\+?[0-9]{7,15}$' }, direccion: { type: 'string', maxLength: 255 }, prov_id: { type: 'integer', minimum: 1, maximum: 32767 }, activo: { type: 'boolean' } } },
  operadorCambio: { type: 'object', additionalProperties: false, minProperties: 1, properties: { nombre: str(150), correo: { type: 'string', format: 'email' }, telefono: { type: 'string', pattern: '^\\+?[0-9]{7,15}$' }, direccion: { type: 'string', maxLength: 255 }, activo: { type: 'boolean' } } },
  operadorUsuario: { type: 'object', additionalProperties: false, required: ['usu_id', 'cargo'], properties: { usu_id: { type: 'integer', minimum: 1 }, cargo: { type: 'string', enum: ['ADMIN', 'VENDEDOR', 'GUIA'] } } },
  categoria: { type: 'object', additionalProperties: false, required: ['nombre'], properties: { nombre: str(80), descripcion: { type: 'string', maxLength: 255 }, icono: { type: 'string', maxLength: 40 }, padre_id: { type: 'integer', minimum: 1 }, orden: { type: 'integer', minimum: 0, maximum: 32767 } } },
  inclusion: { type: 'object', additionalProperties: false, required: ['tipo', 'nombre'], properties: { tipo: { type: 'string', enum: ['INCLUYE', 'NO_INCLUYE', 'RECOMENDACION'] }, nombre: str(150), orden: { type: 'integer', minimum: 0, maximum: 32767 } } },
  evento: { type: 'object', required: ['tipo'], properties: { tipo: { type: 'string' }, datos: { type: 'object' } } },
};
delete esquemas.atraccionCambio.properties.ope_id;

const slugificar = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 190) || 'atraccion';
const ID = (v, n = 'id') => { if (!/^\d{1,18}$/.test(v)) throw err(400, 'BAD_ID', `${n} debe ser numérico.`); return v; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const card = (a) => ({ atr_id: a.atr_id, uuid: a.atr_uuid, nombre: a.atr_nombre, slug: a.atr_slug, descripcion_corta: a.atr_descripcion_corta, tipo: a.atr_tipo, estado: a.atr_estado, latitud: a.atr_latitud, longitud: a.atr_longitud,
  duracion_horas: a.atr_duracion_horas, moneda: a.atr_moneda, ciu_id: a.ciu_id, ope_id: a.ope_id, cancelacion_gratuita: a.atr_cancelacion_gratuita, horas_cancelacion: a.atr_horas_cancelacion, destacada: a.atr_destacada,
  calificacion_promedio: a.atr_calificacion_promedio, numero_resenas: a.atr_numero_resenas, foto_principal: a.foto_principal ?? null });
const ope = (o) => ({ ope_id: o.ope_id, codigo: o.ope_codigo, nombre: o.ope_nombre, ruc: o.ope_ruc, correo: o.ope_correo, telefono: o.ope_telefono, direccion: o.ope_direccion, prov_id: o.prov_id, activo: o.ope_activo });

function crearRutas(r, { db }) {
  // El usuario puede editar una atracción si es ADMIN o está vinculado (activo) al operador dueño.
  async function puedeEditar(ctx, opeId) {
    const a = await autorizar(ctx, { roles: ['ADMIN', 'OPERADOR'] });
    if (a.roles.includes('ADMIN') || a.interno) return a;
    const v = (await db.q('SELECT 1 FROM operador_usuario WHERE ope_id = $1 AND usu_id = $2 AND opeu_activo', [opeId, a.usu_id])).rows[0];
    if (!v) throw err(403, 'FORBIDDEN', 'No pertenece al operador de esta atracción.');
    return a;
  }
  async function verificarCiudad(ciuId) {
    const c = await obtener('location', `/v1/ciudades/${ciuId}`);
    if (!c) throw err(422, 'CITY_NOT_FOUND', 'La ciudad indicada no existe en Location.', [{ name: 'ciu_id', reason: 'no existe' }]);
  }
  async function verificarProvincia(provId) {
    const c = await obtener('location', `/v1/provincias/${provId}`);
    if (!c) throw err(422, 'PROVINCE_NOT_FOUND', 'La provincia indicada no existe en Location.', [{ name: 'prov_id', reason: 'no existe' }]);
  }
  async function cargarRef(ref, { incluirOcultas = false } = {}) {
    const col = /^\d+$/.test(ref) ? 'a.atr_id' : UUID.test(ref) ? 'a.atr_uuid' : 'a.atr_slug';
    if (col === 'a.atr_id' && ref.length > 18) throw noEncontrado('La atracción');
    const x = (await db.q(`SELECT a.* FROM atraccion a WHERE ${col} = $1 AND a.atr_eliminado_en IS NULL`, [ref])).rows[0];
    if (!x || (!incluirOcultas && x.atr_estado !== 'PUBLICADA')) return null; return x;
  }

  r.get('/v1/atracciones', async (ctx) => {
    const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q);
    let admin = false;
    if (q.estado && q.estado !== 'PUBLICADA') { await autorizar(ctx, { roles: ['ADMIN'] }); admin = true; }
    const par = []; const w = ['a.atr_eliminado_en IS NULL'];
    const add = (c, v) => { par.push(v); w.push(c.replaceAll('?', `$${par.length}`)); };
    add('a.atr_estado = ?', admin ? q.estado : 'PUBLICADA');
    if (q.q) add("(a.atr_nombre || ' ' || a.atr_descripcion) ILIKE ?", `%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
    if (q.ciu_id) add('a.ciu_id = ?', q.ciu_id); if (q.tipo) add('a.atr_tipo = ?', q.tipo); if (q.ope_id) add('a.ope_id = ?', q.ope_id);
    if (q.destacada !== undefined) add('a.atr_destacada = ?', q.destacada); if (q.min_calificacion !== undefined) add('a.atr_calificacion_promedio >= ?', q.min_calificacion);
    if (q.cat_id) add(`EXISTS (WITH RECURSIVE sub AS (SELECT cat_id FROM categoria WHERE cat_id = ? UNION ALL SELECT c.cat_id FROM categoria c JOIN sub s ON c.cat_padre_id = s.cat_id)
                              SELECT 1 FROM atraccion_categoria ac JOIN sub ON sub.cat_id = ac.cat_id WHERE ac.atr_id = a.atr_id)`, q.cat_id);       // incluye las subcategorías
    const orden = { nombre: 'a.atr_nombre', calificacion: 'a.atr_calificacion_promedio DESC, a.atr_nombre', reciente: 'a.atr_creado_en DESC' }[q.orden ?? 'nombre'];
    const where = 'WHERE ' + w.join(' AND ');
    const tot = (await db.q(`SELECT count(*) AS n FROM atraccion a ${where}`, par)).rows[0].n;
    const rows = (await db.q(`SELECT a.*, (SELECT f.fot_url FROM atraccion_foto f WHERE f.atr_id = a.atr_id ORDER BY f.fot_orden, f.fot_id LIMIT 1) AS foto_principal
                              FROM atraccion a ${where} ORDER BY ${orden} LIMIT ${p.limit} OFFSET ${p.offset}`, par)).rows;
    return { data: rows.map(card), metadata: meta(tot, p) };
  });

  r.get('/v1/atracciones/:ref', async (ctx) => {
    let oculta = false;
    if (ctx.headers.authorization || ctx.headers['x-internal-key']) { try { const a = await autorizar(ctx, {}); oculta = a.roles.includes('ADMIN'); } catch { /* token malo: se trata como público */ } }
    const a = await cargarRef(ctx.params.ref, { incluirOcultas: oculta }); if (!a) throw noEncontrado('La atracción');
    const [fotos, cats, idiomas, incl, op] = await Promise.all([
      db.q('SELECT fot_id, fot_url AS url, fot_alt AS alt, fot_orden AS orden FROM atraccion_foto WHERE atr_id = $1 ORDER BY fot_orden, fot_id', [a.atr_id]),
      db.q('SELECT c.cat_id, c.cat_nombre AS nombre, c.cat_slug AS slug FROM atraccion_categoria ac JOIN categoria c ON c.cat_id = ac.cat_id WHERE ac.atr_id = $1 ORDER BY c.cat_orden', [a.atr_id]),
      db.q('SELECT i.idi_id, i.idi_codigo AS codigo, i.idi_nombre AS nombre FROM atraccion_idioma ai JOIN idioma i ON i.idi_id = ai.idi_id WHERE ai.atr_id = $1 ORDER BY i.idi_codigo', [a.atr_id]),
      db.q('SELECT n.inc_id, n.inc_tipo AS tipo, n.inc_nombre AS nombre FROM atraccion_inclusion ai JOIN inclusion n ON n.inc_id = ai.inc_id WHERE ai.atr_id = $1 ORDER BY n.inc_tipo, n.inc_orden', [a.atr_id]),
      db.q('SELECT ope_id, ope_nombre, ope_ruc FROM operador WHERE ope_id = $1', [a.ope_id]),
    ]);
    return { ...card(a), descripcion: a.atr_descripcion, direccion: a.atr_direccion, punto_encuentro: a.atr_punto_encuentro, fotos: fotos.rows, categorias: cats.rows, idiomas: idiomas.rows, inclusiones: incl.rows,
      operador: op.rows[0] ? { ope_id: op.rows[0].ope_id, nombre: op.rows[0].ope_nombre, ruc: op.rows[0].ope_ruc } : null, creado_en: a.atr_creado_en, actualizado_en: a.atr_actualizado_en };
  });

  r.post('/v1/atracciones', async (ctx) => {
    const b = ctx.validar('atraccion', ctx.body); const a = await puedeEditar(ctx, b.ope_id);
    const op = (await db.q('SELECT ope_activo FROM operador WHERE ope_id = $1', [b.ope_id])).rows[0];
    if (!op) throw err(422, 'OPERATOR_NOT_FOUND', 'El operador indicado no existe.', [{ name: 'ope_id', reason: 'no existe' }]);
    if (!op.ope_activo) throw regla('El operador está inactivo.', 'OPERATOR_INACTIVE');
    await verificarCiudad(b.ciu_id);
    const base = slugificar(b.nombre); let x;
    for (let i = 0; i < 4 && !x; i++) {
      try {
        x = (await db.q(`INSERT INTO atraccion (atr_nombre, atr_slug, atr_descripcion, atr_descripcion_corta, atr_tipo, atr_estado, atr_latitud, atr_longitud, atr_direccion, atr_punto_encuentro, atr_duracion_horas, atr_moneda,
                         ciu_id, ope_id, atr_cancelacion_gratuita, atr_horas_cancelacion, atr_destacada) VALUES (btrim($1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          [b.nombre, i ? `${base}-${Math.random().toString(36).slice(2, 6)}` : base, b.descripcion, b.descripcion_corta ?? null, b.tipo, b.estado ?? 'BORRADOR', b.latitud, b.longitud, b.direccion ?? null, b.punto_encuentro ?? null,
          b.duracion_horas, b.moneda ?? 'USD', b.ciu_id, b.ope_id, b.cancelacion_gratuita ?? false, b.horas_cancelacion ?? 24, b.destacada ?? false])).rows[0];
      } catch (e) { if (!(e.code === '23505' && /slug/.test(e.constraint ?? e.detail ?? ''))) throw e; }
    }
    if (!x) throw err(409, 'SLUG_TAKEN', 'No se pudo generar un identificador único; cambie el nombre.');
    publicar({ tipo: 'ATRACCION_CREADA', origen: 'catalog', usu_id: a.usu_id, entidad: 'atraccion', entidad_id: String(x.atr_id) });
    return responder(201, card(x), { Location: `/v1/atracciones/${x.atr_id}` });
  });

  r.patch('/v1/atracciones/:id', async (ctx) => {
    ID(ctx.params.id); const b = ctx.validar('atraccionCambio', ctx.body);
    const act = (await db.q('SELECT * FROM atraccion WHERE atr_id = $1 AND atr_eliminado_en IS NULL', [ctx.params.id])).rows[0]; if (!act) throw noEncontrado('La atracción');
    const a = await puedeEditar(ctx, act.ope_id);
    if (b.ciu_id && b.ciu_id !== act.ciu_id) await verificarCiudad(b.ciu_id);
    const mapa = { nombre: 'atr_nombre', descripcion: 'atr_descripcion', descripcion_corta: 'atr_descripcion_corta', tipo: 'atr_tipo', estado: 'atr_estado', latitud: 'atr_latitud', longitud: 'atr_longitud', direccion: 'atr_direccion',
      punto_encuentro: 'atr_punto_encuentro', duracion_horas: 'atr_duracion_horas', moneda: 'atr_moneda', ciu_id: 'ciu_id', cancelacion_gratuita: 'atr_cancelacion_gratuita', horas_cancelacion: 'atr_horas_cancelacion', destacada: 'atr_destacada' };
    const sets = []; const par = [ctx.params.id];
    for (const [k, col] of Object.entries(mapa)) if (b[k] !== undefined) { par.push(b[k]); sets.push(`${col} = $${par.length}`); }
    const x = (await db.q(`UPDATE atraccion SET ${sets.join(', ')} WHERE atr_id = $1 RETURNING *`, par)).rows[0];
    publicar({ tipo: 'ATRACCION_ACTUALIZADA', origen: 'catalog', usu_id: a.usu_id, entidad: 'atraccion', entidad_id: String(x.atr_id), datos: { campos: Object.keys(b) } });
    return card(x);
  });
  r.delete('/v1/atracciones/:id', async (ctx) => {                      // borrado lógico: Order/Booking conservan referencias a la atracción
    ID(ctx.params.id);
    const act = (await db.q('SELECT ope_id FROM atraccion WHERE atr_id = $1 AND atr_eliminado_en IS NULL', [ctx.params.id])).rows[0]; if (!act) throw noEncontrado('La atracción');
    const a = await puedeEditar(ctx, act.ope_id);
    await db.q(`UPDATE atraccion SET atr_eliminado_en = now(), atr_estado = 'INACTIVA' WHERE atr_id = $1`, [ctx.params.id]);
    publicar({ tipo: 'ATRACCION_ELIMINADA', origen: 'catalog', usu_id: a.usu_id, entidad: 'atraccion', entidad_id: ctx.params.id });
    return responder(204, undefined);
  });

  // Relaciones N:M (se reemplaza el conjunto completo: PUT es idempotente).
  const relaciones = { categorias: ['atraccion_categoria', 'cat_id', 'categoria'], idiomas: ['atraccion_idioma', 'idi_id', 'idioma'], inclusiones: ['atraccion_inclusion', 'inc_id', 'inclusion'] };
  for (const [ruta, [tabla, col, maestra]] of Object.entries(relaciones)) {
    r.put(`/v1/atracciones/:id/${ruta}`, async (ctx) => {
      ID(ctx.params.id); const { ids } = ctx.validar('ids', ctx.body);
      const act = (await db.q('SELECT ope_id FROM atraccion WHERE atr_id = $1 AND atr_eliminado_en IS NULL', [ctx.params.id])).rows[0]; if (!act) throw noEncontrado('La atracción');
      await puedeEditar(ctx, act.ope_id);
      if (ids.length) { const ok = (await db.q(`SELECT count(*)::int AS n FROM ${maestra} WHERE ${col} = ANY($1::bigint[])`, [ids])).rows[0].n; if (ok !== ids.length) throw err(422, 'UNKNOWN_IDS', `Algún id de ${ruta} no existe.`, [{ name: 'ids', reason: 'contiene ids inexistentes' }]); }
      await db.tx(async (c) => { await c.query(`DELETE FROM ${tabla} WHERE atr_id = $1`, [ctx.params.id]); if (ids.length) await c.query(`INSERT INTO ${tabla} (atr_id, ${col}) SELECT $1, unnest($2::bigint[])`, [ctx.params.id, ids]); });
      return { atr_id: Number(ctx.params.id), [ruta]: ids };
    });
  }
  r.post('/v1/atracciones/:id/fotos', async (ctx) => {
    ID(ctx.params.id); const b = ctx.validar('foto', ctx.body);
    const act = (await db.q('SELECT ope_id FROM atraccion WHERE atr_id = $1 AND atr_eliminado_en IS NULL', [ctx.params.id])).rows[0]; if (!act) throw noEncontrado('La atracción');
    await puedeEditar(ctx, act.ope_id);
    const n = (await db.q('SELECT count(*)::int AS n FROM atraccion_foto WHERE atr_id = $1', [ctx.params.id])).rows[0].n; if (n >= 30) throw regla('Máximo 30 fotos por atracción.', 'TOO_MANY_PHOTOS');
    const x = (await db.q('INSERT INTO atraccion_foto (atr_id, fot_url, fot_alt, fot_orden) VALUES ($1,$2,btrim($3),$4) RETURNING fot_id, fot_url AS url, fot_alt AS alt, fot_orden AS orden', [ctx.params.id, b.url, b.alt, b.orden ?? n])).rows[0];
    return responder(201, x);
  });
  r.delete('/v1/atracciones/:id/fotos/:fotId', async (ctx) => {
    ID(ctx.params.id); ID(ctx.params.fotId, 'fotId');
    const act = (await db.q('SELECT ope_id FROM atraccion WHERE atr_id = $1 AND atr_eliminado_en IS NULL', [ctx.params.id])).rows[0]; if (!act) throw noEncontrado('La atracción');
    await puedeEditar(ctx, act.ope_id);
    const x = await db.q('DELETE FROM atraccion_foto WHERE fot_id = $1 AND atr_id = $2', [ctx.params.fotId, ctx.params.id]); if (!x.rowCount) throw noEncontrado('La foto');
    return responder(204, undefined);
  });

  // Operadores
  r.get('/v1/operadores', async (ctx) => {
    const q = ctx.validarQ('lista', { ...ctx.query }); const p = paginar(q);
    const tot = (await db.q('SELECT count(*) AS n FROM operador WHERE ope_activo')).rows[0].n;
    return { data: (await db.q(`SELECT * FROM operador WHERE ope_activo ORDER BY ope_nombre LIMIT ${p.limit} OFFSET ${p.offset}`)).rows.map((o) => ({ ope_id: o.ope_id, nombre: o.ope_nombre, prov_id: o.prov_id })), metadata: meta(tot, p) };
  });
  r.get('/v1/operadores/:id', async (ctx) => { await autorizar(ctx, { roles: ['ADMIN', 'OPERADOR'] }); const o = (await db.q('SELECT * FROM operador WHERE ope_id = $1', [ID(ctx.params.id)])).rows[0]; if (!o) throw noEncontrado('El operador'); return ope(o); });
  r.post('/v1/operadores', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const b = ctx.validar('operador', ctx.body); await verificarProvincia(b.prov_id);
    const o = (await db.q('INSERT INTO operador (ope_codigo, ope_nombre, ope_ruc, ope_correo, ope_telefono, ope_direccion, prov_id, ope_activo) VALUES ($1,btrim($2),$3,$4,$5,$6,$7,$8) RETURNING *',
      [b.codigo, b.nombre, b.ruc ?? null, b.correo ?? null, b.telefono ?? null, b.direccion ?? null, b.prov_id, b.activo ?? true])).rows[0];
    return responder(201, ope(o), { Location: `/v1/operadores/${o.ope_id}` });
  });
  r.patch('/v1/operadores/:id', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const b = ctx.validar('operadorCambio', ctx.body);
    const o = (await db.q(`UPDATE operador SET ope_nombre = COALESCE(btrim($2), ope_nombre), ope_correo = COALESCE($3, ope_correo), ope_telefono = COALESCE($4, ope_telefono), ope_direccion = COALESCE($5, ope_direccion), ope_activo = COALESCE($6, ope_activo)
                           WHERE ope_id = $1 RETURNING *`, [ID(ctx.params.id), b.nombre ?? null, b.correo ?? null, b.telefono ?? null, b.direccion ?? null, b.activo ?? null])).rows[0]; if (!o) throw noEncontrado('El operador'); return ope(o);
  });
  r.post('/v1/operadores/:id/usuarios', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const b = ctx.validar('operadorUsuario', ctx.body);
    const o = (await db.q('SELECT 1 FROM operador WHERE ope_id = $1', [ID(ctx.params.id)])).rows[0]; if (!o) throw noEncontrado('El operador');
    await db.q(`INSERT INTO operador_usuario (ope_id, usu_id, opeu_cargo) VALUES ($1,$2,$3) ON CONFLICT (ope_id, usu_id) DO UPDATE SET opeu_cargo = EXCLUDED.opeu_cargo, opeu_activo = TRUE`, [ctx.params.id, b.usu_id, b.cargo]);
    return responder(201, { ope_id: Number(ctx.params.id), usu_id: b.usu_id, cargo: b.cargo });
  });

  // Maestros
  r.get('/v1/categorias', async () => {                                    // árbol por cat_padre_id
    const rows = (await db.q('SELECT cat_id, cat_padre_id, cat_nombre AS nombre, cat_slug AS slug, cat_descripcion AS descripcion, cat_icono AS icono FROM categoria WHERE cat_activa ORDER BY cat_orden, cat_nombre')).rows;
    const por = new Map(rows.map((c) => [c.cat_id, { ...c, hijos: [] }])); const raices = [];
    for (const c of por.values()) { if (c.cat_padre_id && por.has(c.cat_padre_id)) por.get(c.cat_padre_id).hijos.push(c); else raices.push(c); }
    return { data: raices };
  });
  r.post('/v1/categorias', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN'] }); const b = ctx.validar('categoria', ctx.body);
    if (b.padre_id && !(await db.q('SELECT 1 FROM categoria WHERE cat_id = $1', [b.padre_id])).rows[0]) throw err(422, 'PARENT_NOT_FOUND', 'La categoría padre no existe.', [{ name: 'padre_id', reason: 'no existe' }]);
    const c = (await db.q('INSERT INTO categoria (cat_nombre, cat_slug, cat_descripcion, cat_icono, cat_padre_id, cat_orden) VALUES (btrim($1),$2,$3,COALESCE($4,\'map-pin\'),$5,COALESCE($6,0)) RETURNING cat_id, cat_nombre AS nombre, cat_slug AS slug',
      [b.nombre, slugificar(b.nombre), b.descripcion ?? null, b.icono ?? null, b.padre_id ?? null, b.orden ?? null])).rows[0];
    return responder(201, c);
  });
  r.get('/v1/idiomas', async () => ({ data: (await db.q('SELECT idi_id, idi_codigo AS codigo, idi_nombre AS nombre FROM idioma ORDER BY idi_codigo')).rows }));
  r.get('/v1/inclusiones', async () => ({ data: (await db.q('SELECT inc_id, inc_tipo AS tipo, inc_nombre AS nombre FROM inclusion ORDER BY inc_tipo, inc_orden, inc_nombre')).rows }));
  r.post('/v1/inclusiones', async (ctx) => {
    await autorizar(ctx, { roles: ['ADMIN', 'OPERADOR'] }); const b = ctx.validar('inclusion', ctx.body);
    const c = (await db.q('INSERT INTO inclusion (inc_tipo, inc_nombre, inc_orden) VALUES ($1,btrim($2),COALESCE($3,0)) RETURNING inc_id, inc_tipo AS tipo, inc_nombre AS nombre', [b.tipo, b.nombre, b.orden ?? null])).rows[0];
    return responder(201, c);
  });

  // Consumidor del evento de Review. Idempotente: guarda el promedio y el total que calculó Review (no suma incrementos), así un evento repetido no daña el dato.
  // (Si dos eventos llegan desordenados gana el último en llegar; el siguiente evento de esa atracción lo corrige, porque siempre trae los totales completos.)
  r.post('/internal/eventos', async (ctx) => {
    exigirInterna(ctx); const e = ctx.validar('evento', ctx.body);
    if (!['RESENA_PUBLICADA', 'RESENA_RETIRADA'].includes(e.tipo)) return responder(202, { ignorado: true });
    const d = e.datos ?? {};
    if (!Number.isInteger(d.atr_id) || typeof d.promedio !== 'number' || !Number.isInteger(d.numero_resenas) || d.promedio < 0 || d.promedio > 5 || d.numero_resenas < 0)
      throw err(400, 'VALIDATION_ERROR', 'Evento de reseña mal formado.', [{ name: 'datos', reason: 'se requieren atr_id, promedio (0-5) y numero_resenas' }]);
    const x = await db.q('UPDATE atraccion SET atr_calificacion_promedio = round($2::numeric, 2), atr_numero_resenas = $3 WHERE atr_id = $1', [d.atr_id, d.promedio, d.numero_resenas]);
    return responder(202, { actualizadas: x.rowCount });
  });
}
export default { nombre: 'catalog', marcador: 'atraccion', schemaPath: path.join(raiz, 'db/schema.sql'), esquemas, crearRutas };
