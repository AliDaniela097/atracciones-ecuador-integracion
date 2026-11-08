import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service.js';
import { ReservasService } from '../reservas/reservas.service.js';
import { GrpcInventoryService } from '../grpc/grpc-inventory.service.js';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import type { Req as R } from '../common/http.js';
import { Db } from '../db/db.service.js';
import { bitacora } from '../observabilidad/bitacora.js';

/** Panel de administración. Todo exige JWT con rol ADMIN. Los listados son paginados (page, limit). */
@Controller('admin') @UseGuards(AuthGuard) @Roles('ADMIN')
export class AdminController {
  constructor(@Inject(AdminService) private a: AdminService, @Inject(ReservasService) private r: ReservasService,
    @Inject(GrpcInventoryService) private g: GrpcInventoryService, @Inject(Db) private db: Db) {}

  /** Observabilidad: últimos eventos del sistema (HTTP, clientes, reservas, check-in, stock hacia Booking, bus). ?despues=<n> para pedir solo lo nuevo. */
  @Get('bitacora') bitacoraList(@Query() q: any) { return bitacora.listar({ despues: Number(q.despues) || 0, canal: q.canal || undefined, limite: Number(q.limit) || 100 }); }

  @Get('dashboard') dashboard() { return this.a.dashboard(); }

  @Get('atracciones') list(@Query() q: any) { return this.a.listAtracciones(q); }
  @Post('atracciones') create(@Body() b: any) { return this.a.saveAtraccion(b); }
  @Get('atracciones/:id') get(@Param('id') id: string) { return this.a.getAtraccion(id); }
  @Put('atracciones/:id') update(@Param('id') id: string, @Body() b: any) { return this.a.saveAtraccion(b, id); }
  @Delete('atracciones/:id') @HttpCode(204) remove(@Param('id') id: string) { return this.a.deleteAtraccion(id); }
  @Post('atracciones/:id/publicar') @HttpCode(200) publicar(@Param('id') id: string) { return this.a.setEstado(id, 'PUBLICADA'); }
  @Post('atracciones/:id/despublicar') @HttpCode(200) despublicar(@Param('id') id: string) { return this.a.setEstado(id, 'INACTIVA'); }

  @Post('atracciones/:id/horarios') addHorario(@Param('id') id: string, @Body() b: any) { return this.a.addHorario(id, b); }
  @Patch('horarios/:hid') patchHorario(@Param('hid', ParseIntPipe) hid: number, @Body() b: any) { return this.a.patchHorario(hid, b); }
  @Post('atracciones/:id/turnos/generar') @HttpCode(200) async generar(@Param('id') id: string, @Body() b: any, @Req() req: R) {
    const r = await this.a.generarTurnos(id, b, req.correlationId);
    bitacora.registrar('ADMIN', `Turnos generados para ${id} (${b.desde} → ${b.hasta}): ${r.turnos_creados} nuevos; stock encolado hacia Booking`, { cid: req.correlationId });
    return r;
  }
  @Get('atracciones/:id/turnos') turnos(@Param('id') id: string, @Query() q: any) { return this.a.listTurnos(id, q); }
  @Patch('turnos/:tid') async patchTurno(@Param('tid', ParseIntPipe) tid: number, @Body() b: any, @Req() req: R) {
    const r = await this.a.patchTurno(tid, b, req.correlationId);
    bitacora.registrar('ADMIN', `Turno ${tid} modificado${b.cupo_total !== undefined ? ` (cupo total → ${b.cupo_total})` : ''}${b.cerrado !== undefined ? ` (${b.cerrado ? 'cerrado' : 'reabierto'})` : ''}; stock encolado hacia Booking`, { cid: req.correlationId });
    return r;
  }
  @Get('atracciones/:id/fechas-bloqueadas') bloqueadas(@Param('id') id: string) { return this.a.listBloqueadas(id); }
  @Post('atracciones/:id/fechas-bloqueadas') bloquear(@Param('id') id: string, @Body() b: any) { return this.a.bloquearFecha(id, b); }
  @Delete('fechas-bloqueadas/:fid') @HttpCode(204) desbloquear(@Param('fid', ParseIntPipe) fid: number) { return this.a.desbloquearFecha(fid); }

  @Get('categorias') cats() { return this.a.listCategorias(); }
  @Post('categorias') catCreate(@Body() b: any) { return this.a.saveCategoria(b); }
  @Put('categorias/:id') catUpdate(@Param('id', ParseIntPipe) id: number, @Body() b: any) { return this.a.saveCategoria(b, id); }
  @Delete('categorias/:id') @HttpCode(204) catDelete(@Param('id', ParseIntPipe) id: number) { return this.a.deleteCategoria(id); }

  @Get('operadores') ops(@Query() q: any) { return this.a.listOperadores(q); }
  @Post('operadores') opCreate(@Body() b: any) { return this.a.saveOperador(b); }
  @Put('operadores/:id') opUpdate(@Param('id', ParseIntPipe) id: number, @Body() b: any) { return this.a.saveOperador(b, id); }
  @Get('guias') guias(@Query() q: any) { return this.a.listGuias(q); }
  @Post('guias') guiaCreate(@Body() b: any) { return this.a.saveGuia(b); }

  @Get('ciudades') ciudades(@Query() q: any) { return this.a.listCiudades(q); }
  @Post('ciudades') ciudadCreate(@Body() b: any) { return this.a.addCiudad(b); }
  @Get('provincias') provincias() { return this.a.listProvincias(); }

  @Get('reservas') reservas(@Query() q: any) { return this.r.listar(q); }
  @Get('usuarios') usuarios(@Query() q: any) { return this.a.listUsuarios(q); }
  @Patch('usuarios/:id') patchUsuario(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: R) { return this.a.patchUsuario(id, b, req.principal?.id); }

  // Sincronización gRPC con Booking
  @Get('sync/estado') async sync() {
    const pending = await this.db.query(`SELECT evt_id, evt_aggregate_id, evt_payload->>'slot_id' AS slot_id, evt_intentos, evt_ultimo_error, evt_proximo_intento FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL ORDER BY evt_id LIMIT 50`);
    return { ...this.g.stats(), pendientes: pending };
  }
  @Post('sync/enviar-pendientes') @HttpCode(200) enviar() { return this.g.pushPending(500); }
  @Post('sync/reenviar-todo') @HttpCode(200) reenviarTodo(@Body() b: any) { return this.g.enqueueAllStock(Math.min(Number(b?.dias ?? 30), 60)); }
  @Post('sync/conciliar') @HttpCode(200) conciliar(@Body() b: any) { return this.g.reconcile(Math.min(Number(b?.dias ?? 14), 60)); }
}
