import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Db } from '../db/db.service.js';
import { OutboxService } from '../eventos/outbox.service.js';
import { badRequest, conflict, notFound, type InvalidParam } from '../common/problem.js';
import { escapeLike, isRealDate, pageMeta, pageQuery, parseTime, todayEC } from '../common/util.js';

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const code12 = () => Array.from(randomBytes(12), (b) => ALNUM[b % ALNUM.length]).join('');
const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
const TICKETS = ['ADULTO', 'NINO', 'MAYOR', 'INFANTE', 'ESTUDIANTE'];

function need(body: any, fields: string[]) {
  const inv: InvalidParam[] = fields.filter((f) => body?.[f] === undefined || body[f] === null || body[f] === '').map((f) => ({ name: f, reason: 'Obligatorio' }));
  if (inv.length) throw badRequest('Faltan campos obligatorios.', 'VALIDATION_ERROR', inv);
}
const like = (q: any) => `%${escapeLike(String(q))}%`;

@Injectable()
export class AdminService {
  constructor(@Inject(Db) private db: Db, @Inject(OutboxService) private outbox: OutboxService) {}

  // ---------- Dashboard ----------
  async dashboard() {
    const one = async (sql: string) => Number((await this.db.one<{ n: number }>(sql))!.n);
    const [atrPub, atrBor, reservasHoy, conf, canc, ingresos, pend, usuarios, turnosHoy] = await Promise.all([
      one(`SELECT COUNT(*) n FROM atraccion WHERE atr_estado='PUBLICADA' AND atr_eliminado_en IS NULL`),
      one(`SELECT COUNT(*) n FROM atraccion WHERE atr_estado<>'PUBLICADA' AND atr_eliminado_en IS NULL`),
      one(`SELECT COUNT(*) n FROM reserva WHERE res_creado_en >= date_trunc('day', now())`),
      one(`SELECT COUNT(*) n FROM reserva r JOIN estado_reserva e ON e.est_id=r.est_id WHERE e.est_codigo IN ('CONFIRMED','CHECKED_IN','COMPLETED')`),
      one(`SELECT COUNT(*) n FROM reserva r JOIN estado_reserva e ON e.est_id=r.est_id WHERE e.est_codigo='CANCELLED'`),
      one(`SELECT COALESCE(SUM(b.bol_cantidad*b.bol_precio_unit),0) n FROM reserva_boleto b JOIN reserva r ON r.res_id=b.res_id JOIN estado_reserva e ON e.est_id=r.est_id WHERE e.est_codigo IN ('CONFIRMED','CHECKED_IN','COMPLETED')`),
      one(`SELECT COUNT(*) n FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL`),
      one(`SELECT COUNT(*) n FROM usuario WHERE usu_activo`),
      one(`SELECT COUNT(*) n FROM turno WHERE tur_fecha=CURRENT_DATE`),
    ]);
    const top = await this.db.query(`SELECT a.atr_codigo AS id, a.atr_nombre AS nombre, COUNT(r.res_id)::int AS reservas
      FROM atraccion a LEFT JOIN horario h ON h.atr_id=a.atr_id LEFT JOIN turno t ON t.hor_id=h.hor_id LEFT JOIN reserva r ON r.tur_id=t.tur_id
      WHERE a.atr_eliminado_en IS NULL GROUP BY a.atr_id ORDER BY reservas DESC, a.atr_nombre LIMIT 5`);
    return { atracciones_publicadas: atrPub, atracciones_no_publicadas: atrBor, reservas_hoy: reservasHoy, reservas_activas: conf, reservas_canceladas: canc, ingresos_usd: ingresos,
      eventos_stock_pendientes_grpc: pend, usuarios_activos: usuarios, turnos_hoy: turnosHoy, top_atracciones: top };
  }

  // ---------- Atracciones ----------
  async listAtracciones(q: Record<string, any>) {
    const p = pageQuery(q, 20, 100); const params: unknown[] = []; const where = ['a.atr_eliminado_en IS NULL'];
    if (q.estado) { params.push(q.estado); where.push(`a.atr_estado=$${params.length}`); }
    if (q.ciudad_id) { params.push(Number(q.ciudad_id)); where.push(`a.ciu_id=$${params.length}`); }
    if (q.q) { params.push(like(q.q)); where.push(`(a.atr_nombre ILIKE $${params.length} OR a.atr_codigo ILIKE $${params.length})`); }
    params.push(p.limit, p.offset);
    const rows = await this.db.query(
      `SELECT a.atr_id AS id, a.atr_codigo AS codigo, a.atr_slug AS slug, a.atr_nombre AS nombre, a.atr_tipo AS tipo, a.atr_estado AS estado, a.atr_destacada AS destacada,
              c.ciu_nombre AS ciudad, o.ope_nombre AS operador, a.atr_duracion_horas AS duracion_horas, tp.tar_precio AS precio_adulto, COUNT(*) OVER() AS total
         FROM atraccion a JOIN ciudad c ON c.ciu_id=a.ciu_id JOIN operador o ON o.ope_id=a.ope_id
         LEFT JOIN v_tarifa_vigente tp ON tp.atr_id=a.atr_id AND tp.tar_tipo='ADULTO'
        WHERE ${where.join(' AND ')} ORDER BY a.atr_creado_en DESC, a.atr_id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { metadata: pageMeta(rows[0]?.total ?? 0, p), data: rows.map(({ total, ...r }) => r) };
  }

  private async atrId(id: string | number): Promise<number> {
    const r = await this.db.one(`SELECT atr_id FROM atraccion WHERE atr_eliminado_en IS NULL AND (atr_codigo=$1 OR atr_id::text=$1)`, [String(id)]);
    if (!r) throw notFound(`No existe la atracción '${id}'.`, 'ATTRACTION_NOT_FOUND');
    return r.atr_id;
  }

  async getAtraccion(id: string) {
    const atrId = await this.atrId(id);
    const a = await this.db.one('SELECT * FROM atraccion WHERE atr_id=$1', [atrId]);
    const [cats, langs, incl, fotos, itin, fares, hor] = await Promise.all([
      this.db.query('SELECT cat_id FROM atraccion_categoria WHERE atr_id=$1', [atrId]),
      this.db.query('SELECT i.idi_codigo FROM atraccion_idioma ai JOIN idioma i ON i.idi_id=ai.idi_id WHERE ai.atr_id=$1', [atrId]),
      this.db.query('SELECT inc_id FROM atraccion_inclusion WHERE atr_id=$1', [atrId]),
      this.db.query('SELECT fot_url AS url, fot_alt AS alt, fot_orden AS orden FROM atraccion_foto WHERE atr_id=$1 ORDER BY fot_orden, fot_id', [atrId]),
      this.db.query('SELECT iti_numero AS numero, to_char(iti_hora,\'HH24:MI\') AS hora, iti_titulo AS titulo, iti_descripcion AS descripcion, iti_duracion_minutos AS duracion_minutos, iti_ubicacion AS ubicacion FROM atraccion_itinerario WHERE atr_id=$1 ORDER BY iti_numero', [atrId]),
      this.db.query('SELECT tar_tipo, tar_precio FROM v_tarifa_vigente WHERE atr_id=$1', [atrId]),
      this.db.query('SELECT hor_id AS id, to_char(hor_hora,\'HH24:MI\') AS hora, hor_cupo AS cupo, hor_activo AS activo FROM horario WHERE atr_id=$1 ORDER BY hor_hora', [atrId]),
    ]);
    return {
      id: a.atr_id, codigo: a.atr_codigo, slug: a.atr_slug, nombre: a.atr_nombre, descripcion: a.atr_descripcion, descripcion_corta: a.atr_descripcion_corta, tipo: a.atr_tipo, estado: a.atr_estado,
      ciudad_id: a.ciu_id, operador_id: a.ope_id, direccion: a.atr_direccion, punto_encuentro: a.atr_punto_encuentro, latitud: a.atr_latitud, longitud: a.atr_longitud,
      instrucciones_llegada: a.atr_instrucciones_llegada, duracion_horas: a.atr_duracion_horas, cancelacion_gratuita: a.atr_cancelacion_gratuita, horas_cancelacion: a.atr_horas_cancelacion,
      destacada: a.atr_destacada, permite_paquete: a.atr_permite_paquete, incluye_comida: a.atr_incluye_comida, incluye_transporte: a.atr_incluye_transporte, incluye_guia: a.atr_incluye_guia,
      accesible_silla_ruedas: a.atr_acc_silla_ruedas, accesible_carriola: a.atr_acc_carriola, admite_animales_asistencia: a.atr_acc_animales_servicio,
      categorias: cats.map((c) => c.cat_id), idiomas: langs.map((l) => l.idi_codigo), inclusiones: incl.map((i) => i.inc_id), fotos, itinerario: itin,
      tarifas: Object.fromEntries(fares.map((f) => [f.tar_tipo, f.tar_precio])), horarios: hor,
    };
  }

  async saveAtraccion(body: any, id?: string) {
    if (!id) need(body, ['nombre', 'descripcion', 'tipo', 'ciudad_id', 'operador_id', 'latitud', 'longitud', 'duracion_horas']);
    const f: Record<string, [string, unknown]> = {
      nombre: ['atr_nombre', body.nombre], descripcion: ['atr_descripcion', body.descripcion], descripcion_corta: ['atr_descripcion_corta', body.descripcion_corta], tipo: ['atr_tipo', body.tipo],
      estado: ['atr_estado', body.estado], ciudad_id: ['ciu_id', body.ciudad_id], operador_id: ['ope_id', body.operador_id], direccion: ['atr_direccion', body.direccion],
      punto_encuentro: ['atr_punto_encuentro', body.punto_encuentro], latitud: ['atr_latitud', body.latitud], longitud: ['atr_longitud', body.longitud],
      instrucciones_llegada: ['atr_instrucciones_llegada', body.instrucciones_llegada], duracion_horas: ['atr_duracion_horas', body.duracion_horas],
      cancelacion_gratuita: ['atr_cancelacion_gratuita', body.cancelacion_gratuita], horas_cancelacion: ['atr_horas_cancelacion', body.horas_cancelacion], destacada: ['atr_destacada', body.destacada],
      permite_paquete: ['atr_permite_paquete', body.permite_paquete], incluye_comida: ['atr_incluye_comida', body.incluye_comida], incluye_transporte: ['atr_incluye_transporte', body.incluye_transporte],
      incluye_guia: ['atr_incluye_guia', body.incluye_guia], accesible_silla_ruedas: ['atr_acc_silla_ruedas', body.accesible_silla_ruedas], accesible_carriola: ['atr_acc_carriola', body.accesible_carriola],
      admite_animales_asistencia: ['atr_acc_animales_servicio', body.admite_animales_asistencia],
    };
    const cols = Object.entries(f).filter(([, [, v]]) => v !== undefined);
    const atrId = await this.db.tx(async (c) => {
      let atrId: number;
      if (!id) {
        const slug = slugify(body.slug ?? body.nombre);
        const names = ['atr_codigo', 'atr_slug', ...cols.map(([, [col]]) => col)];
        const vals = [body.codigo ?? code12(), slug, ...cols.map(([, [, v]]) => v)];
        atrId = (await c.query(`INSERT INTO atraccion (${names.join(',')}) VALUES (${vals.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING atr_id`, vals)).rows[0].atr_id;
      } else {
        atrId = await this.atrId(id);
        if (body.slug) cols.push(['slug', ['atr_slug', slugify(body.slug)]]);
        if (cols.length) await c.query(`UPDATE atraccion SET ${cols.map(([, [col]], i) => `${col}=$${i + 2}`).join(',')} WHERE atr_id=$1`, [atrId, ...cols.map(([, [, v]]) => v)]);
      }
      await this.replaceRelations(c, atrId, body);
      return atrId;
    });
    return this.getAtraccion(String(atrId));
  }

  private async replaceRelations(c: PoolClient, atrId: number, b: any) {
    if (Array.isArray(b.categorias)) {
      await c.query('DELETE FROM atraccion_categoria WHERE atr_id=$1', [atrId]);
      for (const cat of b.categorias) await c.query('INSERT INTO atraccion_categoria VALUES ($1,$2) ON CONFLICT DO NOTHING', [atrId, cat]);
    }
    if (Array.isArray(b.idiomas)) {
      await c.query('DELETE FROM atraccion_idioma WHERE atr_id=$1', [atrId]);
      for (const code of b.idiomas) await c.query('INSERT INTO atraccion_idioma SELECT $1, idi_id FROM idioma WHERE idi_codigo=$2 ON CONFLICT DO NOTHING', [atrId, String(code).toLowerCase()]);
    }
    if (Array.isArray(b.inclusiones)) {
      await c.query('DELETE FROM atraccion_inclusion WHERE atr_id=$1', [atrId]);
      for (const inc of b.inclusiones) await c.query('INSERT INTO atraccion_inclusion VALUES ($1,$2) ON CONFLICT DO NOTHING', [atrId, inc]);
    }
    if (Array.isArray(b.fotos)) {
      await c.query('DELETE FROM atraccion_foto WHERE atr_id=$1', [atrId]);
      let i = 0; for (const f of b.fotos) { need(f, ['url', 'alt']); await c.query('INSERT INTO atraccion_foto (atr_id, fot_url, fot_alt, fot_orden) VALUES ($1,$2,$3,$4)', [atrId, f.url, f.alt, f.orden ?? i++]); }
    }
    if (Array.isArray(b.itinerario)) {
      await c.query('DELETE FROM atraccion_itinerario WHERE atr_id=$1', [atrId]);
      let n = 1; for (const s of b.itinerario) {
        need(s, ['hora', 'titulo', 'duracion_minutos']); const t = parseTime(s.hora);
        if (!t) throw badRequest(`Hora de itinerario inválida: ${s.hora}`, 'INVALID_TIME', [{ name: 'itinerario.hora', reason: 'HH:MM' }]);
        await c.query('INSERT INTO atraccion_itinerario (atr_id, iti_numero, iti_hora, iti_titulo, iti_descripcion, iti_duracion_minutos, iti_ubicacion) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [atrId, s.numero ?? n++, t, s.titulo, s.descripcion ?? null, s.duracion_minutos, s.ubicacion ?? null]);
      }
    }
    if (b.tarifas && typeof b.tarifas === 'object') await this.setTarifas(c, atrId, b.tarifas);
  }

  /** Tarifas con vigencia: una nueva tarifa cierra la anterior (no se sobrescribe el histórico). */
  private async setTarifas(c: PoolClient, atrId: number, t: Record<string, number>) {
    for (const [tipo, precio] of Object.entries(t)) {
      if (!TICKETS.includes(tipo)) throw badRequest(`Tipo de tarifa inválido: ${tipo}`, 'VALIDATION_ERROR', [{ name: 'tarifas.' + tipo, reason: TICKETS.join(' | ') }]);
      if (typeof precio !== 'number' || precio < 0) throw badRequest(`Precio inválido para ${tipo}`, 'VALIDATION_ERROR', [{ name: 'tarifas.' + tipo, reason: 'Número ≥ 0' }]);
      const cur = (await c.query(`SELECT tar_id, tar_precio FROM tarifa WHERE atr_id=$1 AND tar_tipo=$2 AND tar_vigente_desde <= CURRENT_DATE AND (tar_vigente_hasta IS NULL OR tar_vigente_hasta >= CURRENT_DATE) ORDER BY tar_vigente_desde DESC LIMIT 1`, [atrId, tipo])).rows[0];
      if (cur && Number(cur.tar_precio) === precio) continue;
      if (cur) await c.query(`UPDATE tarifa SET tar_vigente_hasta = CURRENT_DATE - 1 WHERE tar_id=$1 AND tar_vigente_desde < CURRENT_DATE`, [cur.tar_id]);
      await c.query(`INSERT INTO tarifa (atr_id, tar_tipo, tar_precio, tar_vigente_desde) VALUES ($1,$2,$3,CURRENT_DATE)
                     ON CONFLICT (atr_id, tar_tipo, tar_vigente_desde) DO UPDATE SET tar_precio=EXCLUDED.tar_precio, tar_vigente_hasta=NULL`, [atrId, tipo, precio]);
    }
  }

  async setEstado(id: string, estado: 'PUBLICADA' | 'INACTIVA') {
    const atrId = await this.atrId(id);
    if (estado === 'PUBLICADA') {
      const ok = await this.db.one(`SELECT (SELECT COUNT(*) FROM v_tarifa_vigente WHERE atr_id=$1 AND tar_tipo='ADULTO') AS tarifa, (SELECT COUNT(*) FROM horario WHERE atr_id=$1 AND hor_activo) AS horarios`, [atrId]);
      const inv: InvalidParam[] = [];
      if (!Number(ok!.tarifa)) inv.push({ name: 'tarifas.ADULTO', reason: 'Defina la tarifa de adulto antes de publicar' });
      if (!Number(ok!.horarios)) inv.push({ name: 'horarios', reason: 'Defina al menos un horario activo antes de publicar' });
      if (inv.length) throw badRequest('La atracción no está lista para publicarse.', 'NOT_READY_TO_PUBLISH', inv);
    }
    await this.db.query('UPDATE atraccion SET atr_estado=$2 WHERE atr_id=$1', [atrId, estado]);
    return this.getAtraccion(String(atrId));
  }

  async deleteAtraccion(id: string) {
    const atrId = await this.atrId(id);
    const open = await this.db.one(`SELECT COUNT(*) n FROM reserva r JOIN estado_reserva e ON e.est_id=r.est_id JOIN turno t ON t.tur_id=r.tur_id JOIN horario h ON h.hor_id=t.hor_id
      WHERE h.atr_id=$1 AND e.est_codigo IN ('CONFIRMED','PENDING','CHECKED_IN') AND t.tur_fecha >= CURRENT_DATE`, [atrId]);
    if (Number(open!.n)) throw conflict(`Tiene ${open!.n} reservas activas futuras; cancélelas antes de eliminar.`, 'HAS_ACTIVE_RESERVATIONS');
    await this.db.query(`UPDATE atraccion SET atr_eliminado_en=now(), atr_estado='INACTIVA' WHERE atr_id=$1`, [atrId]); // borrado lógico: el histórico de reservas se conserva
  }

  // ---------- Horarios, turnos y fechas bloqueadas ----------
  async addHorario(id: string, body: any) {
    need(body, ['hora']); const t = parseTime(body.hora);
    if (!t) throw badRequest('hora inválida (use HH:MM).', 'INVALID_TIME', [{ name: 'hora', reason: 'HH:MM' }]);
    const atrId = await this.atrId(id);
    const r = await this.db.one(`INSERT INTO horario (atr_id, hor_hora, hor_cupo) VALUES ($1,$2,$3) RETURNING hor_id AS id, to_char(hor_hora,'HH24:MI') AS hora, hor_cupo AS cupo, hor_activo AS activo`, [atrId, t, body.cupo ?? 20]);
    return r;
  }
  async patchHorario(hid: number, body: any) {
    const r = await this.db.one(`UPDATE horario SET hor_cupo=COALESCE($2,hor_cupo), hor_activo=COALESCE($3,hor_activo) WHERE hor_id=$1 RETURNING hor_id AS id, to_char(hor_hora,'HH24:MI') AS hora, hor_cupo AS cupo, hor_activo AS activo`, [hid, body.cupo ?? null, body.activo ?? null]);
    if (!r) throw notFound('Horario no encontrado.');
    return r;
  }

  /** Genera turnos (horario × fecha) y los anuncia a Booking vía Outbox → gRPC. */
  async generarTurnos(id: string, body: any, cid: string) {
    need(body, ['desde', 'hasta']);
    if (!isRealDate(body.desde) || !isRealDate(body.hasta) || body.hasta < body.desde) throw badRequest('Rango de fechas inválido.', 'INVALID_DATE', [{ name: 'desde/hasta', reason: 'YYYY-MM-DD y hasta ≥ desde' }]);
    if (body.desde < todayEC()) throw badRequest('No se pueden generar turnos en el pasado.', 'INVALID_DATE', [{ name: 'desde', reason: 'Debe ser hoy o posterior' }]);
    const days = (Date.parse(body.hasta) - Date.parse(body.desde)) / 86400000 + 1;
    if (days > 120) throw badRequest('Máximo 120 días por operación.', 'RANGE_TOO_LARGE', [{ name: 'hasta', reason: 'Máximo 120 días' }]);
    const atrId = await this.atrId(id);
    return this.db.tx(async (c) => {
      const created = (await c.query(
        `INSERT INTO turno (hor_id, tur_fecha, tur_cupo_total) SELECT h.hor_id, d::date, h.hor_cupo FROM horario h CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
          WHERE h.atr_id=$1 AND h.hor_activo ON CONFLICT (hor_id, tur_fecha) DO NOTHING RETURNING tur_id`, [atrId, body.desde, body.hasta])).rows;
      for (const t of created) await this.outbox.emitStock(c, t.tur_id, cid);
      return { turnos_creados: created.length };
    });
  }

  async listTurnos(id: string, q: Record<string, any>) {
    const atrId = await this.atrId(id); const p = pageQuery(q, 30, 200); const params: unknown[] = [atrId]; const where = ['h.atr_id=$1'];
    if (q.desde) { params.push(q.desde); where.push(`t.tur_fecha >= $${params.length}`); }
    if (q.hasta) { params.push(q.hasta); where.push(`t.tur_fecha <= $${params.length}`); }
    params.push(p.limit, p.offset);
    const rows = await this.db.query(
      `SELECT t.tur_id AS id, t.tur_fecha AS fecha, to_char(h.hor_hora,'HH24:MI') AS hora, v.slot_id, t.tur_cupo_total AS cupo_total, t.tur_cupo_reservado AS cupo_reservado,
              v.cupos_disponibles, v.estado, t.tur_cerrado AS cerrado, COUNT(*) OVER() AS total
         FROM turno t JOIN horario h ON h.hor_id=t.hor_id JOIN v_turno_disponibilidad v ON v.tur_id=t.tur_id
        WHERE ${where.join(' AND ')} ORDER BY t.tur_fecha, h.hor_hora LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { metadata: pageMeta(rows[0]?.total ?? 0, p), data: rows.map(({ total, ...r }) => r) };
  }

  async patchTurno(tid: number, body: any, cid: string) {
    return this.db.tx(async (c) => {
      const t = (await c.query('SELECT tur_cupo_reservado FROM turno WHERE tur_id=$1 FOR UPDATE', [tid])).rows[0];
      if (!t) throw notFound('Turno no encontrado.');
      if (body.cupo_total !== undefined && (!Number.isInteger(body.cupo_total) || body.cupo_total < t.tur_cupo_reservado || body.cupo_total < 1))
        throw badRequest(`cupo_total debe ser un entero ≥ ${Math.max(1, t.tur_cupo_reservado)} (cupos ya reservados).`, 'INVALID_CAPACITY', [{ name: 'cupo_total', reason: `≥ ${Math.max(1, t.tur_cupo_reservado)}` }]);
      await c.query('UPDATE turno SET tur_cupo_total=COALESCE($2,tur_cupo_total), tur_cerrado=COALESCE($3,tur_cerrado) WHERE tur_id=$1', [tid, body.cupo_total ?? null, body.cerrado ?? null]);
      await this.outbox.emitStock(c, tid, cid);
      return { ok: true };
    });
  }

  async bloquearFecha(id: string, body: any) {
    need(body, ['fecha', 'motivo']); if (!isRealDate(body.fecha)) throw badRequest('fecha inválida.', 'INVALID_DATE', [{ name: 'fecha', reason: 'YYYY-MM-DD' }]);
    const atrId = await this.atrId(id);
    return this.db.one('INSERT INTO fecha_bloqueada (atr_id, fb_fecha, fb_motivo) VALUES ($1,$2,$3) RETURNING fb_id AS id, fb_fecha AS fecha, fb_motivo AS motivo', [atrId, body.fecha, body.motivo]);
  }
  async desbloquearFecha(fbId: number) { await this.db.query('DELETE FROM fecha_bloqueada WHERE fb_id=$1', [fbId]); }
  async listBloqueadas(id: string) { return this.db.query('SELECT fb_id AS id, fb_fecha AS fecha, fb_motivo AS motivo FROM fecha_bloqueada WHERE atr_id=$1 ORDER BY fb_fecha', [await this.atrId(id)]); }

  // ---------- Categorías ----------
  async listCategorias() {
    return this.db.query(`SELECT cat_id AS id, cat_padre_id AS padre_id, cat_nombre AS nombre, cat_slug AS slug, cat_descripcion AS descripcion, cat_icono AS icono, cat_orden AS orden,
      cat_incluye_comida AS incluye_comida, cat_incluye_transporte AS incluye_transporte, cat_incluye_guia AS incluye_guia, cat_activa AS activa FROM categoria ORDER BY cat_orden, cat_nombre`);
  }
  async saveCategoria(body: any, id?: number) {
    if (!id) need(body, ['nombre']);
    const slug = body.slug ?? (body.nombre ? slugify(body.nombre) : undefined);
    const vals = [body.padre_id, body.nombre, slug, body.descripcion, body.icono, body.orden, body.incluye_comida, body.incluye_transporte, body.incluye_guia, body.activa];
    const cols = ['cat_padre_id', 'cat_nombre', 'cat_slug', 'cat_descripcion', 'cat_icono', 'cat_orden', 'cat_incluye_comida', 'cat_incluye_transporte', 'cat_incluye_guia', 'cat_activa'];
    const present = cols.map((c, i) => [c, vals[i]] as const).filter(([, v]) => v !== undefined);
    if (id) {
      if (body.padre_id === id) throw badRequest('Una categoría no puede ser su propio padre.', 'INVALID_PARENT');
      const r = await this.db.one(`UPDATE categoria SET ${present.map(([c], i) => `${c}=$${i + 2}`).join(',')} WHERE cat_id=$1 RETURNING cat_id AS id`, [id, ...present.map(([, v]) => v)]);
      if (!r) throw notFound('Categoría no encontrada.'); return r;
    }
    return this.db.one(`INSERT INTO categoria (${present.map(([c]) => c).join(',')}) VALUES (${present.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING cat_id AS id`, present.map(([, v]) => v));
  }
  async deleteCategoria(id: number) {
    const hijos = await this.db.one('SELECT COUNT(*) n FROM categoria WHERE cat_padre_id=$1', [id]);
    if (Number(hijos!.n)) throw conflict('La categoría tiene subcategorías.', 'HAS_CHILDREN');
    await this.db.query('DELETE FROM categoria WHERE cat_id=$1', [id]);
  }

  // ---------- Operadores y guías ----------
  async listOperadores(q: Record<string, any>) {
    const p = pageQuery(q, 20, 100); const params: unknown[] = []; let w = 'TRUE';
    if (q.q) { params.push(like(q.q)); w = `ope_nombre ILIKE $1`; }
    params.push(p.limit, p.offset);
    const rows = await this.db.query(`SELECT ope_id AS id, ope_nombre AS nombre, ope_ruc AS ruc, ope_correo AS correo, ope_telefono AS telefono, prov_id AS provincia_id, ope_activo AS activo, COUNT(*) OVER() AS total FROM operador WHERE ${w} ORDER BY ope_nombre LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { metadata: pageMeta(rows[0]?.total ?? 0, p), data: rows.map(({ total, ...r }) => r) };
  }
  async saveOperador(body: any, id?: number) {
    if (!id) need(body, ['nombre', 'provincia_id']);
    const m: [string, unknown][] = [['ope_nombre', body.nombre], ['ope_ruc', body.ruc], ['ope_correo', body.correo], ['ope_telefono', body.telefono], ['ope_direccion', body.direccion], ['prov_id', body.provincia_id], ['ope_activo', body.activo]];
    const pr = m.filter(([, v]) => v !== undefined);
    if (id) { const r = await this.db.one(`UPDATE operador SET ${pr.map(([c], i) => `${c}=$${i + 2}`).join(',')} WHERE ope_id=$1 RETURNING ope_id AS id`, [id, ...pr.map(([, v]) => v)]); if (!r) throw notFound('Operador no encontrado.'); return r; }
    return this.db.one(`INSERT INTO operador (${pr.map(([c]) => c).join(',')}) VALUES (${pr.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING ope_id AS id`, pr.map(([, v]) => v));
  }
  async listGuias(q: Record<string, any>) {
    const p = pageQuery(q, 20, 100);
    const rows = await this.db.query(`SELECT g.gui_id AS id, g.gui_nombre AS nombre, g.gui_licencia AS licencia, g.gui_activo AS activo, o.ope_nombre AS operador, COUNT(*) OVER() AS total FROM guia g JOIN operador o ON o.ope_id=g.ope_id ORDER BY g.gui_nombre LIMIT $1 OFFSET $2`, [p.limit, p.offset]);
    return { metadata: pageMeta(rows[0]?.total ?? 0, p), data: rows.map(({ total, ...r }) => r) };
  }
  async saveGuia(body: any) {
    need(body, ['operador_id', 'nombre', 'licencia']);
    return this.db.one('INSERT INTO guia (ope_id, gui_nombre, gui_licencia) VALUES ($1,$2,$3) RETURNING gui_id AS id', [body.operador_id, body.nombre, body.licencia]);
  }

  // ---------- Geografía ----------
  async listCiudades(q: Record<string, any>) {
    const p = pageQuery(q, 50, 200);
    const rows = await this.db.query(
      `SELECT c.ciu_id AS id, c.ciu_nombre AS nombre, pr.prov_nombre AS provincia, c.ciu_activa AS activa,
              COALESCE(json_agg(json_build_object('iata', a.apt_iata, 'nombre', a.apt_nombre, 'activo', a.apt_activo)) FILTER (WHERE a.apt_id IS NOT NULL), '[]') AS aeropuertos, COUNT(*) OVER() AS total
         FROM ciudad c JOIN provincia pr ON pr.prov_id=c.prov_id LEFT JOIN aeropuerto a ON a.ciu_id=c.ciu_id GROUP BY c.ciu_id, pr.prov_nombre ORDER BY c.ciu_nombre LIMIT $1 OFFSET $2`, [p.limit, p.offset]);
    return { metadata: pageMeta(rows[0]?.total ?? 0, p), data: rows.map(({ total, ...r }) => r) };
  }
  async listProvincias() { return this.db.query('SELECT prov_id AS id, prov_nombre AS nombre, prov_codigo AS codigo FROM provincia ORDER BY prov_nombre'); }
  async addCiudad(body: any) {
    need(body, ['nombre', 'provincia_id', 'aeropuerto']); need(body.aeropuerto, ['nombre', 'iata']);
    return this.db.tx(async (c) => {
      const ciu = (await c.query('INSERT INTO ciudad (ciu_nombre, prov_id, ciu_descripcion) VALUES ($1,$2,$3) RETURNING ciu_id AS id', [body.nombre, body.provincia_id, body.descripcion ?? null])).rows[0];
      await c.query('INSERT INTO aeropuerto (apt_nombre, apt_iata, apt_icao, ciu_id) VALUES ($1,$2,$3,$4)', [body.aeropuerto.nombre, String(body.aeropuerto.iata).toUpperCase(), body.aeropuerto.icao ? String(body.aeropuerto.icao).toUpperCase() : null, ciu.id]);
      return ciu;
    });
  }

  // ---------- Usuarios ----------
  async listUsuarios(q: Record<string, any>) {
    const p = pageQuery(q, 20, 100); const params: unknown[] = []; let w = 'TRUE';
    if (q.q) { params.push(like(q.q)); w = `(u.usu_correo ILIKE $1 OR u.usu_nombre ILIKE $1 OR u.usu_apellido ILIKE $1)`; }
    params.push(p.limit, p.offset);
    const rows = await this.db.query(
      `SELECT u.usu_id AS id, u.usu_correo AS email, u.usu_nombre AS nombre, u.usu_apellido AS apellido, u.usu_activo AS activo, u.usu_ultimo_acceso AS ultimo_acceso,
              COALESCE(array_agg(r.rol_nombre) FILTER (WHERE r.rol_id IS NOT NULL), '{}') AS roles, COUNT(*) OVER() AS total
         FROM usuario u LEFT JOIN usuario_rol ur ON ur.usu_id=u.usu_id LEFT JOIN rol r ON r.rol_id=ur.rol_id WHERE ${w} GROUP BY u.usu_id ORDER BY u.usu_creado_en DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { metadata: pageMeta(rows[0]?.total ?? 0, p), data: rows.map(({ total, ...r }) => r) };
  }
  async patchUsuario(id: number, body: any, selfId?: number) {
    if (id === selfId && (body.activo === false || (Array.isArray(body.roles) && !body.roles.includes('ADMIN'))))
      throw conflict('No puede desactivarse ni quitarse el rol ADMIN a sí mismo.', 'SELF_LOCKOUT');
    await this.db.tx(async (c) => {
      if (body.activo !== undefined) await c.query('UPDATE usuario SET usu_activo=$2 WHERE usu_id=$1', [id, !!body.activo]);
      if (Array.isArray(body.roles)) {
        await c.query('DELETE FROM usuario_rol WHERE usu_id=$1', [id]);
        for (const r of body.roles) await c.query('INSERT INTO usuario_rol SELECT $1, rol_id FROM rol WHERE rol_nombre=$2', [id, r]);
      }
    });
    return { ok: true };
  }
}
