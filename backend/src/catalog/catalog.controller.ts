import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';
import { ContractService } from '../contract/contract.service.js';
import { badRequest } from '../common/problem.js';

@Controller('atracciones')
export class CatalogController {
  constructor(@Inject(CatalogService) private s: CatalogService, @Inject(ContractService) private c: ContractService) {}

  @Get('categorias/arbol') arbol() { return this.s.categoriasArbol(); }
  @Get('categorias') categorias(@Query('padre_id') padre?: string) { return this.s.categoriasPlano(padre); }

  @Post('search') @HttpCode(200)
  search(@Body() body: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('El cuerpo debe ser un objeto JSON.', 'INVALID_BODY');
    const errs = this.c.check('SearchAtraccionesRequestV2', body);
    if (errs.length) throw badRequest('La búsqueda no cumple el contrato SearchAtraccionesRequestV2.', 'VALIDATION_ERROR', errs);
    return this.s.search(body);
  }

  @Get() listar(@Query() q: Record<string, any>) { return this.s.search(q); }
}

/** Rutas con :id van en un controlador aparte, registrado al final, para no capturar /atracciones/health, /reservas, etc. */
@Controller('atracciones')
export class CatalogDetailController {
  constructor(@Inject(CatalogService) private s: CatalogService) {}
  @Get(':id/disponibilidad') disp(@Param('id') id: string, @Query('date') date?: string, @Query('fecha') fecha?: string) { return this.s.disponibilidad(id, date ?? fecha); }
  /**
   * Aggregator (Semana 8): arma la pantalla de detalle con datos de varias fuentes en UNA llamada. Sin reglas de negocio ni base propia:
   * solo combina y, si una fuente falla, responde igual con esa parte en null (fuentes.<x> = 'ERROR').
   */
  @Get(':id/detalle-completo') async completo(@Param('id') id: string, @Query('date') date?: string) {
    const hoy = new Date(Date.now() - 5 * 3600e3 + 86400e3).toISOString().slice(0, 10);
    const [d, disp, res] = await Promise.allSettled([
      this.s.detalle(id), this.s.disponibilidad(id, date ?? hoy),
      this.s.findAtraccion(id).then((a: any) => fetch(`http://127.0.0.1:${process.env.MS_REVIEW_PORT ?? 50105}/v1/atracciones/${a.atr_id}/resenas?limit=5`, { signal: AbortSignal.timeout(2500), headers: { 'x-request-id': `agg-${Date.now().toString(36)}` } })).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
    ]);
    if (d.status === 'rejected') throw d.reason;           // sin el detalle no hay pantalla: se propaga 404 u otro error tal cual
    const f = (x: PromiseSettledResult<unknown>) => (x.status === 'fulfilled' ? 'OK' : 'ERROR');
    return { atraccion: d.value, disponibilidad: disp.status === 'fulfilled' ? disp.value : null, resenas: res.status === 'fulfilled' ? res.value : null, fuentes: { detalle: 'OK', disponibilidad: f(disp), resenas: f(res) } };
  }
  @Get(':id') detalle(@Param('id') id: string) { return this.s.detalle(id); }
}
