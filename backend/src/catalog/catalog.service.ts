import { Inject, Injectable } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { ContractService } from '../contract/contract.service.js';
import { badRequest, notFound } from '../common/problem.js';
import { durationLabel, escapeLike, hhmmFromDb, isRealDate, label12h, pageMeta, pageQuery, slotId, toBool } from '../common/util.js';
import { config } from '../config.js';

const SORTS: Record<string, string> = {
  PRICE_ASC: 'precio_adulto ASC NULLS LAST, a.atr_id',
  PRICE_DESC: 'precio_adulto DESC NULLS LAST, a.atr_id',
  RATING_DESC: 'COALESCE(rt.score, 0) DESC, rt.review_count DESC NULLS LAST, a.atr_id',
  POPULARITY: 'popularidad DESC, a.atr_destacada DESC, a.atr_id',
};

export const inclusionFlags = (a: any) => ({
  includes_food: a.atr_incluye_comida, includes_transport: a.atr_incluye_transporte, includes_guide: a.atr_incluye_guia,
  incluye_comida: a.atr_incluye_comida, incluye_transporte: a.atr_incluye_transporte, incluye_guia: a.atr_incluye_guia,
});
const badge = (score: number, n: number) => (n === 0 ? 'Sin reseñas' : score >= 9 ? 'Excepcional' : score >= 8 ? 'Muy bueno' : score >= 7 ? 'Bueno' : 'Aceptable');

@Injectable()
export class CatalogService {
  constructor(@Inject(Db) private db: Db, @Inject(ContractService) private contract: ContractService) {}

  // ---------- Categorías ----------
  private catDto(c: any) {
    return {
      id: String(c.cat_id), padre_id: c.cat_padre_id === null ? null : String(c.cat_padre_id), nombre: c.cat_nombre, slug: c.cat_slug,
      descripcion: c.cat_descripcion ?? undefined, icono: c.cat_icono, orden: c.cat_orden,
      incluye_comida: c.cat_incluye_comida, incluye_transporte: c.cat_incluye_transporte, incluye_guia: c.cat_incluye_guia,
      includes_food: c.cat_incluye_comida, includes_transport: c.cat_incluye_transporte, includes_guide: c.cat_incluye_guia,
    };
  }
  async categoriasArbol() {
    const rows = await this.db.query('SELECT * FROM categoria WHERE cat_activa ORDER BY cat_orden, cat_nombre');
    const nodes = new Map<number, any>(rows.map((r) => [r.cat_id, { ...this.catDto(r), subcategorias: [] as any[] }]));
    const roots: any[] = [];
    for (const r of rows) {
      const n = nodes.get(r.cat_id)!;
      const parent = r.cat_padre_id ? nodes.get(r.cat_padre_id) : undefined;
      (parent ? parent.subcategorias : roots).push(n);
    }
    return roots;
  }
  async categoriasPlano(padreId?: string) {
    let rows;
    if (padreId === undefined || padreId === '') rows = await this.db.query('SELECT * FROM categoria WHERE cat_activa AND cat_padre_id IS NULL ORDER BY cat_orden, cat_nombre');
    else {
      const id = await this.resolveCategoria(padreId);
      rows = await this.db.query('SELECT * FROM categoria WHERE cat_activa AND cat_padre_id = $1 ORDER BY cat_orden, cat_nombre', [id ?? -1]);
    }
    return rows.map((r) => {
      const d: any = this.catDto(r); delete d.descripcion; delete d.icono; delete d.orden; return d;
    });
  }
  /** Acepta id numérico o slug. */
  async resolveCategoria(v: string): Promise<number | null> {
    const r = /^\d+$/.test(v) ? await this.db.one('SELECT cat_id FROM categoria WHERE cat_id=$1', [Number(v)])
      : await this.db.one('SELECT cat_id FROM categoria WHERE cat_slug=$1', [v]);
    return r?.cat_id ?? null;
  }

  // ---------- Listado / búsqueda (paginado) ----------
  async search(f: Record<string, any>) {
    const p = pageQuery(f, 10, 50);
    const where: string[] = [`a.atr_estado='PUBLICADA'`, 'a.atr_eliminado_en IS NULL', 'c.ciu_activa'];
    const params: unknown[] = [];
    const add = (sql: string, ...vals: unknown[]) => {
      let s = sql; for (const v of vals) { params.push(v); s = s.replace('?', '$' + params.length); } where.push(s);
    };
    const q = (f.query ?? f.q)?.toString().trim();
    if (q) add(`unaccent(a.atr_nombre || ' ' || a.atr_descripcion || ' ' || c.ciu_nombre) ILIKE unaccent(?)`, `%${escapeLike(q)}%`);
    const ciudad = (f.ciudad ?? f.city)?.toString().trim();
    if (ciudad) add(`unaccent(c.ciu_nombre) ILIKE unaccent(?)`, escapeLike(ciudad));
    if (f.categoria_id) {
      const id = await this.resolveCategoria(String(f.categoria_id));
      // incluye subcategorías hijas
      add(`EXISTS (SELECT 1 FROM atraccion_categoria ac WHERE ac.atr_id=a.atr_id AND ac.cat_id IN (
            WITH RECURSIVE t AS (SELECT cat_id FROM categoria WHERE cat_id=? UNION ALL SELECT k.cat_id FROM categoria k JOIN t ON k.cat_padre_id=t.cat_id) SELECT cat_id FROM t))`, id ?? -1);
    }
    for (const [k, col] of [['incluye_comida', 'atr_incluye_comida'], ['incluye_transporte', 'atr_incluye_transporte'], ['incluye_guia', 'atr_incluye_guia'],
      ['accesible_silla_ruedas', 'atr_acc_silla_ruedas'], ['animales_asistencia', 'atr_acc_animales_servicio'], ['cancelacion_gratuita', 'atr_cancelacion_gratuita']] as const) {
      const b = toBool(f[k]); if (b === true) where.push(`a.${col}`);
    }
    if (f.precio_min !== undefined && f.precio_min !== '') add('COALESCE(tp.tar_precio,0) >= ?', Number(f.precio_min));
    if (f.precio_max !== undefined && f.precio_max !== '') add('COALESCE(tp.tar_precio,0) <= ?', Number(f.precio_max));
    if (f.duracion_max_horas) add('a.atr_duracion_horas <= ?', Number(f.duracion_max_horas));
    if (f.idioma_guia) add(`EXISTS (SELECT 1 FROM atraccion_idioma ai JOIN idioma i ON i.idi_id=ai.idi_id WHERE ai.atr_id=a.atr_id AND (unaccent(i.idi_nombre) ILIKE unaccent(?) OR i.idi_codigo = lower(?)))`, String(f.idioma_guia), String(f.idioma_guia));
    const ini = f.fecha_inicio ?? f.date; const fin = f.fecha_fin ?? ini;
    if (ini) {
      if (!isRealDate(ini) || (fin && !isRealDate(fin)))
        throw badRequest('fecha_inicio/fecha_fin deben tener formato YYYY-MM-DD.', 'INVALID_DATE', [{ name: 'fecha_inicio', reason: 'Formato YYYY-MM-DD' }]);
      const adults = Number(f.adult_count ?? f.cantidad_adultos ?? 1) || 1;
      add(`EXISTS (SELECT 1 FROM v_turno_disponibilidad v WHERE v.atr_id=a.atr_id AND v.hor_activo AND v.tur_fecha BETWEEN ? AND ? AND v.cupos_disponibles >= ?
              AND NOT EXISTS (SELECT 1 FROM fecha_bloqueada fb WHERE fb.atr_id=a.atr_id AND fb.fb_fecha=v.tur_fecha))`, ini, fin, adults);
    }
    const sort = SORTS[String(f.sort ?? 'POPULARITY')];
    if (!sort) throw badRequest('sort inválido.', 'INVALID_SORT', [{ name: 'sort', reason: 'PRICE_ASC | PRICE_DESC | RATING_DESC | POPULARITY' }]);

    params.push(p.limit, p.offset);
    const rows = await this.db.query(
      `SELECT a.atr_id, COUNT(*) OVER() AS total, tp.tar_precio AS precio_adulto,
              (SELECT COUNT(*) FROM reserva rv JOIN turno t ON t.tur_id=rv.tur_id JOIN horario h ON h.hor_id=t.hor_id WHERE h.atr_id=a.atr_id) AS popularidad
         FROM atraccion a JOIN ciudad c ON c.ciu_id=a.ciu_id
         LEFT JOIN v_tarifa_vigente tp ON tp.atr_id=a.atr_id AND tp.tar_tipo='ADULTO'
         LEFT JOIN v_atraccion_rating rt ON rt.atr_id=a.atr_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${sort}
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const total = rows[0]?.total ?? 0;
    const cards = await this.cards(rows.map((r) => r.atr_id));
    return { request_id: `req-atr-${Date.now().toString(36)}`, metadata: pageMeta(total, p), data: rows.map((r) => cards.get(r.atr_id)) };
  }

  /** Tarjetas en lote (evita N+1). */
  async cards(ids: number[]): Promise<Map<number, any>> {
    const out = new Map<number, any>();
    if (!ids.length) return out;
    const [atr, fares, ratings, photos, horas] = await Promise.all([
      this.db.query(`SELECT a.*, c.ciu_nombre FROM atraccion a JOIN ciudad c ON c.ciu_id=a.ciu_id WHERE a.atr_id = ANY($1)`, [ids]),
      this.db.query(`SELECT * FROM v_tarifa_vigente WHERE atr_id = ANY($1)`, [ids]),
      this.db.query(`SELECT * FROM v_atraccion_rating WHERE atr_id = ANY($1)`, [ids]),
      this.db.query(`SELECT atr_id, fot_url FROM atraccion_foto WHERE atr_id = ANY($1) ORDER BY fot_orden, fot_id`, [ids]),
      this.db.query(`SELECT atr_id, hor_hora FROM horario WHERE atr_id = ANY($1) AND hor_activo ORDER BY hor_hora`, [ids]),
    ]);
    for (const a of atr) {
      const h24 = horas.filter((h) => h.atr_id === a.atr_id).map((h) => hhmmFromDb(h.hor_hora));
      const price = this.priceDto(fares.filter((f) => f.atr_id === a.atr_id));
      const r = ratings.find((x) => x.atr_id === a.atr_id);
      const rating = { score: r ? r.score : 0, review_count: r ? r.review_count : 0, badge_text: badge(r?.score ?? 0, r?.review_count ?? 0) };
      const dur = durationLabel(a.atr_duracion_horas);
      const incl = inclusionFlags(a);
      out.set(a.atr_id, {
        id: a.atr_codigo, slug: a.atr_slug, name: a.atr_nombre, short_description: a.atr_descripcion_corta ?? undefined, city: a.ciu_nombre,
        duration: dur, duration_hours: a.atr_duracion_horas, price, rating,
        free_cancellation: a.atr_cancelacion_gratuita, free_cancellation_hours: a.atr_horas_cancelacion, inclusions: incl,
        meeting_point: a.atr_punto_encuentro ?? undefined, photos: photos.filter((p) => p.atr_id === a.atr_id).map((p) => p.fot_url),
        permite_paquete: a.atr_permite_paquete,
        horarios: h24.map((x) => label12h(x)), horarios_24h: h24,
        nombre: a.atr_nombre, descripcion_corta: a.atr_descripcion_corta ?? undefined, ciudad: a.ciu_nombre, duracion: dur,
        precio: price, calificacion: rating, cancelacion_gratuita: a.atr_cancelacion_gratuita, inclusiones: incl, punto_encuentro: a.atr_punto_encuentro ?? undefined,
      });
    }
    return out;
  }

  priceDto(fares: any[]) {
    const g = (t: string) => Number(fares.find((f) => f.tar_tipo === t)?.tar_precio ?? 0);
    const adult = g('ADULTO'), child = g('NINO'), senior = g('MAYOR'), infant = g('INFANTE'), student = g('ESTUDIANTE');
    const currency = fares[0]?.tar_moneda ?? 'USD';
    return { currency, adult, child, senior, infant, student, adulto: adult, nino: child, tercera_edad: senior, infante: infant, estudiante: student, moneda: currency };
  }

  // ---------- Detalle ----------
  async findAtraccion(idOrSlug: string, onlyPublic = true) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    const a = await this.db.one(
      `SELECT a.*, c.ciu_nombre FROM atraccion a JOIN ciudad c ON c.ciu_id=a.ciu_id
        WHERE a.atr_eliminado_en IS NULL ${onlyPublic ? `AND a.atr_estado='PUBLICADA'` : ''}
          AND (a.atr_codigo=$1 OR a.atr_slug=$1 ${isUuid ? 'OR a.atr_uuid=$1::uuid' : ''})`, [idOrSlug]);
    if (!a) throw notFound(`No existe la atracción '${idOrSlug}'.`, 'ATTRACTION_NOT_FOUND');
    return a;
  }

  async detalle(idOrSlug: string) {
    const a = await this.findAtraccion(idOrSlug);
    const card = (await this.cards([a.atr_id])).get(a.atr_id)!;
    const [fares, r, itin, incl, langs, op, acuerdo, fotos] = await Promise.all([
      this.db.query('SELECT * FROM v_tarifa_vigente WHERE atr_id=$1', [a.atr_id]),
      this.db.one('SELECT * FROM v_atraccion_rating WHERE atr_id=$1', [a.atr_id]),
      this.db.query('SELECT * FROM atraccion_itinerario WHERE atr_id=$1 ORDER BY iti_numero', [a.atr_id]),
      this.db.query('SELECT i.inc_tipo, i.inc_nombre FROM atraccion_inclusion ai JOIN inclusion i ON i.inc_id=ai.inc_id WHERE ai.atr_id=$1 ORDER BY i.inc_id', [a.atr_id]),
      this.db.query('SELECT i.idi_nombre FROM atraccion_idioma ai JOIN idioma i ON i.idi_id=ai.idi_id WHERE ai.atr_id=$1 ORDER BY i.idi_nombre', [a.atr_id]),
      this.db.one('SELECT * FROM operador WHERE ope_id=$1', [a.ope_id]),
      this.db.one('SELECT * FROM acuerdo_promocion WHERE acp_id=1'),
      this.db.query('SELECT fot_url FROM atraccion_foto WHERE atr_id=$1 ORDER BY fot_orden, fot_id', [a.atr_id]),
    ]);
    const price = this.priceDto(fares);
    const n = r?.review_count ?? 0;
    const ratingFull = {
      score: r?.score ?? 0, review_count: n, badge_text: badge(r?.score ?? 0, n),
      breakdown: {
        limpieza: r?.limpieza ?? 0, servicio: r?.servicio ?? 0, calidad_precio: r?.calidad_precio ?? 0, puntualidad: r?.puntualidad ?? 0,
        cleanliness: r?.limpieza ?? 0, service_score: r?.servicio ?? 0, value_for_money: r?.calidad_precio ?? 0, punctuality: r?.puntualidad ?? 0,
      },
    };
    const itinerary = itin.map((s) => {
      const t = label12h(hhmmFromDb(s.iti_hora));
      return { stop_number: s.iti_numero, time: t, title: s.iti_titulo, description: s.iti_descripcion ?? undefined, duration_minutes: s.iti_duracion_minutos, location_name: s.iti_ubicacion ?? undefined,
        numero_parada: s.iti_numero, hora: t, titulo: s.iti_titulo, descripcion: s.iti_descripcion ?? undefined, duracion_minutos: s.iti_duracion_minutos, nombre_ubicacion: s.iti_ubicacion ?? undefined };
    });
    const lat = a.atr_latitud, lon = a.atr_longitud;
    const geo = {
      address: a.atr_direccion ?? a.atr_punto_encuentro ?? a.ciu_nombre, city: a.ciu_nombre, latitude: lat, longitude: lon,
      arrival_instructions: a.atr_instrucciones_llegada ?? undefined, google_maps_url: `https://maps.google.com/?q=${lat},${lon}`,
      direccion: a.atr_direccion ?? a.atr_punto_encuentro ?? a.ciu_nombre, ciudad: a.ciu_nombre, latitud: lat, longitud: lon, instrucciones_llegada: a.atr_instrucciones_llegada ?? undefined,
    };
    const access = {
      wheelchair_accessible: a.atr_acc_silla_ruedas, stroller_accessible: a.atr_acc_carriola, service_animals_allowed: a.atr_acc_animales_servicio,
      accesible_silla_ruedas: a.atr_acc_silla_ruedas, accesible_carriola: a.atr_acc_carriola, admite_animales_asistencia: a.atr_acc_animales_servicio,
    };
    const desc = a.atr_cancelacion_gratuita ? `Cancela gratis hasta ${a.atr_horas_cancelacion} horas antes de la actividad y recibe el 100% de reembolso.` : 'Esta actividad no admite cancelación gratuita.';
    const policy = { free_cancellation: a.atr_cancelacion_gratuita, deadline_hours: a.atr_horas_cancelacion, description: desc, cancelacion_gratuita: a.atr_cancelacion_gratuita, horas_limite: a.atr_horas_cancelacion, descripcion: desc };
    const inc = incl.filter((x) => x.inc_tipo === 'INCLUYE').map((x) => x.inc_nombre);
    const exc = incl.filter((x) => x.inc_tipo === 'NO_INCLUYE').map((x) => x.inc_nombre);
    const photos = fotos.map((f) => f.fot_url);
    const discount = acuerdo?.acp_permite && a.atr_permite_paquete ? Number(acuerdo.acp_descuento_maximo) : 0;
    return {
      id: a.atr_codigo, uuid: a.atr_uuid, slug: a.atr_slug, name: a.atr_nombre, description: a.atr_descripcion, city: a.ciu_nombre, duration: card.duration,
      price, rating: ratingFull, inclusions: card.inclusions, inclusions_list: inc, exclusions_list: exc, itinerary, meeting_point_geo: geo, accessibility: access,
      guide_languages: langs.map((l) => l.idi_nombre), cancellation_policy: policy, permite_paquete: a.atr_permite_paquete, porcentaje_descuento_paquete: discount, photos,
      proveedor: { id: config.providerId, nombre_comercial: op?.ope_nombre, ruc: op?.ope_ruc ?? undefined, telefono_emergencia: op?.ope_telefono ?? undefined, email_soporte: op?.ope_correo ?? undefined },
      nombre: a.atr_nombre, descripcion: a.atr_descripcion, ciudad: a.ciu_nombre, duracion: card.duration, precio: price, calificacion: ratingFull, inclusiones: card.inclusions,
      punto_encuentro_geo: geo, itinerario: itinerary, accesibilidad: access, politica_cancelacion: policy,
    };
  }

  // ---------- Disponibilidad ----------
  async disponibilidad(idOrSlug: string, dateRaw: unknown) {
    const date = String(dateRaw ?? '');
    if (!date) throw badRequest("El parámetro 'date' es obligatorio (YYYY-MM-DD).", 'MISSING_DATE', [{ name: 'date', reason: 'Obligatorio' }]);
    if (!isRealDate(date)) throw badRequest("'date' debe ser una fecha real en formato YYYY-MM-DD.", 'INVALID_DATE', [{ name: 'date', reason: 'Formato YYYY-MM-DD' }]);
    const a = await this.findAtraccion(idOrSlug);
    const blocked = await this.db.one('SELECT 1 FROM fecha_bloqueada WHERE atr_id=$1 AND fb_fecha=$2', [a.atr_id, date]);
    const rows = await this.db.query(
      `SELECT * FROM v_turno_disponibilidad WHERE atr_id=$1 AND tur_fecha=$2 AND hor_activo ORDER BY hor_hora`, [a.atr_id, date]);
    const fares = this.priceDto(await this.db.query('SELECT * FROM v_tarifa_vigente WHERE atr_id=$1', [a.atr_id]));
    const slots = rows.map((s) => {
      const hhmm = hhmmFromDb(s.hor_hora); const label = label12h(hhmm); const avail = blocked ? 0 : s.cupos_disponibles;
      const status = blocked ? 'AGOTADO' : s.estado;
      return { slot_id: slotId(date, hhmm), time: label, time_24h: `${hhmm}:00`, total_slots: s.tur_cupo_total, available_slots: avail, status, price_adult: fares.adult, price_child: fares.child,
        hora: label, hora_24h: `${hhmm}:00`, cupos_totales: s.tur_cupo_total, cupos_disponibles: avail, estado: status, precio_adulto_slot: fares.adult, precio_nino_slot: fares.child };
    });
    const total = slots.reduce((t, s) => t + s.available_slots, 0);
    return { atraccion_id: a.atr_codigo, date, fecha: date, total_available_slots: total, total_cupos_disponibles: total, time_slots: slots, turnos: slots };
  }
}
