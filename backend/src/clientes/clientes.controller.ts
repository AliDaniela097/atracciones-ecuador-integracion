import { Body, Controller, Get, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ClientesService } from './clientes.service.js';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import type { Req as R } from '../common/http.js';
import { bitacora } from '../observabilidad/bitacora.js';

@Controller('clientes') @UseGuards(AuthGuard) @Roles('ADMIN', 'OPERADOR', 'PARTNER')
export class ClientesController {
  constructor(@Inject(ClientesService) private s: ClientesService) {}

  @Get() async buscar(@Query() q: Record<string, any>, @Req() req: R) {
    const por = q.identificacion || q.documento ? 'identificación' : 'correo';
    try { const r = await this.s.buscar(q); bitacora.registrar('CLIENTES', `Consulta de cliente por ${por}: ENCONTRADO`, { cid: req.correlationId, datos: { cliente_id: (r as any)?.client_id ?? (r as any)?.id } }); return r; }
    catch (e: any) { bitacora.registrar('CLIENTES', `Consulta de cliente por ${por}: ${e?.status === 404 ? 'NO EXISTE (404)' : 'rechazada (' + (e?.code ?? e?.status ?? 'error') + ')'}`, { cid: req.correlationId, nivel: e?.status === 404 ? 'INFO' : 'WARN' }); throw e; }
  }

  @Post() async crear(@Body() b: any, @Res({ passthrough: true }) res: Response, @Req() req: R) {
    const r = await this.s.crear(b); res.status(r.status);
    bitacora.registrar('CLIENTES', r.status === 201 ? 'Cliente creado' : 'Cliente ya existía (respuesta idempotente 200)', { cid: req.correlationId, datos: { cliente_id: (r.body as any)?.client_id ?? (r.body as any)?.id } });
    return r.body;
  }
}
