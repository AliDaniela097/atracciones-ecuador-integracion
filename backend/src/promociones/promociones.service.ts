import { Inject, Injectable } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { ContractService } from '../contract/contract.service.js';
import { badRequest } from '../common/problem.js';
import { isRealDate } from '../common/util.js';
import { config } from '../config.js';

/** Cuestionario B2B de la cátedra (una sola vez): ¿acepta promociones? ¿descuento máximo? */
@Injectable()
export class PromocionesService {
  constructor(@Inject(Db) private db: Db, @Inject(ContractService) private contract: ContractService) {}

  async get() {
    const a = await this.db.one('SELECT * FROM acuerdo_promocion WHERE acp_id=1');
    const dest = await this.db.query('SELECT c.ciu_nombre FROM acuerdo_promocion_destino d JOIN ciudad c ON c.ciu_id=d.ciu_id WHERE d.acp_id=1 ORDER BY c.ciu_nombre');
    const base: any = {
      proveedor_id: config.providerId, nombre_comercial: config.providerName, permite_promociones: a?.acp_permite ?? false,
      porcentaje_descuento_maximo: Number(a?.acp_descuento_maximo ?? 0), destinos_habilitados: dest.map((d) => d.ciu_nombre),
      fecha_acuerdo: a?.acp_fecha_acuerdo, vigencia_hasta: a?.acp_vigencia_hasta ?? a?.acp_fecha_acuerdo ?? new Date().toISOString().slice(0, 10),
    };
    if (a?.acp_condiciones) base.condiciones_combo = a.acp_condiciones;
    if (a?.acp_contacto_nombre) base.contacto_comercial = { nombre: a.acp_contacto_nombre, email: a.acp_contacto_correo, telefono: a.acp_contacto_telefono };
    return base;
  }

  async put(body: any) {
    const errs = this.contract.check('ActualizarPromocionesContratoRequest', body ?? {});
    if (errs.length) throw badRequest('El cuerpo no cumple ActualizarPromocionesContratoRequest.', 'VALIDATION_ERROR', errs);
    if (body.vigencia_hasta && !isRealDate(body.vigencia_hasta)) throw badRequest('vigencia_hasta inválida.', 'INVALID_DATE', [{ name: 'vigencia_hasta', reason: 'YYYY-MM-DD' }]);
    // Solo se pueden habilitar ciudades donde la tienda opera (ciudades con aeropuerto).
    const names: string[] = body.destinos_habilitados ?? [];
    const cities = names.length ? await this.db.query(`SELECT ciu_id, ciu_nombre FROM ciudad c WHERE c.ciu_activa AND EXISTS (SELECT 1 FROM aeropuerto a WHERE a.ciu_id=c.ciu_id AND a.apt_activo) AND unaccent(lower(ciu_nombre)) = ANY($1)`,
      [names.map((n) => n.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))]) : [];
    const unknown = names.filter((n) => !cities.some((c) => c.ciu_nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') === n.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')));
    if (unknown.length)
      throw badRequest(`Destinos sin aeropuerto activo en esta tienda: ${unknown.join(', ')}.`, 'INVALID_DESTINATION', unknown.map((u) => ({ name: 'destinos_habilitados', reason: `'${u}' no es una ciudad con aeropuerto atendida` })));
    const cc = body.contacto_comercial ?? {};
    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO acuerdo_promocion (acp_id, acp_permite, acp_descuento_maximo, acp_fecha_acuerdo, acp_vigencia_hasta, acp_condiciones, acp_contacto_nombre, acp_contacto_correo, acp_contacto_telefono)
         VALUES (1,$1,$2,CURRENT_DATE,$3,$4,$5,$6,$7)
         ON CONFLICT (acp_id) DO UPDATE SET acp_permite=EXCLUDED.acp_permite, acp_descuento_maximo=EXCLUDED.acp_descuento_maximo, acp_fecha_acuerdo=CURRENT_DATE,
           acp_vigencia_hasta=EXCLUDED.acp_vigencia_hasta, acp_condiciones=EXCLUDED.acp_condiciones, acp_contacto_nombre=EXCLUDED.acp_contacto_nombre,
           acp_contacto_correo=EXCLUDED.acp_contacto_correo, acp_contacto_telefono=EXCLUDED.acp_contacto_telefono`,
        [body.permite_promociones, body.permite_promociones ? body.porcentaje_descuento_maximo : 0, body.vigencia_hasta ?? null, body.condiciones_combo ?? null, cc.nombre ?? null, cc.email ?? null, cc.telefono ?? null]);
      await c.query('DELETE FROM acuerdo_promocion_destino WHERE acp_id=1');
      for (const city of cities) await c.query('INSERT INTO acuerdo_promocion_destino (acp_id, ciu_id) VALUES (1,$1) ON CONFLICT DO NOTHING', [city.ciu_id]);
    });
    return this.get();
  }
}
