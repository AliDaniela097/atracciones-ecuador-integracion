import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ReservasService } from './reservas.service.js';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import type { Req as R } from '../common/http.js';
import { bitacora } from '../observabilidad/bitacora.js';

@Controller('atracciones/reservas')
export class ReservasController {
  constructor(@Inject(ReservasService) private s: ReservasService) {}

  @Post() @UseGuards(AuthGuard)
  async crear(@Body() body: any, @Req() req: R, @Res({ passthrough: true }) res: Response) {
    const r = await this.s.crear(body, req.headers['idempotency-key'] as string | undefined, req.correlationId, req.principal);
    res.status(r.status);
    const b = r.body as any; const origen = req.principal?.type === 'api-key' ? 'Booking (socio)' : 'web (usuario)';
    bitacora.registrar('RESERVA', r.replay ? `Reserva ${b.reservation_code} repetida: se devuelve la misma (Idempotency-Key)` : `Reserva ${b.reservation_code} recibida de ${origen}: ${b.status}`, { cid: req.correlationId, datos: { orden: b.external_order_id, personas: b.ticket_count, total: b.total_price, fecha: b.date } });
    if (r.replay) res.setHeader('Idempotent-Replay', 'true');
    res.setHeader('Location', `/api/v3/atracciones/reservas/${r.body.reservation_id}`);
    return r.body;
  }

  /** Calendario .ics: el UUID de la reserva actúa como capacidad (enlace del correo de confirmación). */
  @Get(':id/evento.ics') @Header('Content-Type', 'text/calendar; charset=utf-8')
  ics(@Param('id') id: string) { return this.s.ics(id); }

  @Get(':id/trazabilidad') @UseGuards(AuthGuard)
  trazabilidad(@Param('id') id: string, @Req() req: R) { return this.s.trazabilidad(id, req.principal); }

  @Get(':id') @UseGuards(AuthGuard)
  obtener(@Param('id') id: string, @Req() req: R) { return this.s.obtener(id, req.principal); }

  @Post(':id/cancel') @HttpCode(200) @UseGuards(AuthGuard)
  async cancelar(@Param('id') id: string, @Body() body: any, @Req() req: R) {
    const r = await this.s.cancelar(id, body, req.correlationId, req.principal);
    bitacora.registrar('RESERVA', `Reserva ${id} cancelada (solicitante ${body?.solicitante ?? 'CLIENTE'}); cupos liberados y stock reenviado a Booking`, { cid: req.correlationId });
    return r;
  }

  @Post(':id/checkin') @HttpCode(200) @UseGuards(AuthGuard) @Roles('ADMIN', 'OPERADOR', 'PARTNER')
  async checkin(@Param('id') id: string, @Body() body: any, @Req() req: R) {
    try {
      const r: any = await this.s.checkin(id, body, req.principal, req.correlationId);
      bitacora.registrar('CHECKIN', `Check-in de ${r.reservation_code}: reserva local → CHECKED_IN (CONFIRMADO_ASISTIDO); aviso a Booking: ${r.booking_checkin?.estado}`, { cid: req.correlationId, nivel: ['RECHAZADO', 'PENDIENTE_REINTENTO'].includes(r.booking_checkin?.estado) ? 'WARN' : 'INFO', datos: { asistentes: body?.asistentes_reales } });
      return r;
    } catch (e: any) { bitacora.registrar('CHECKIN', `Check-in de ${id} rechazado: ${e?.code ?? e?.message}`, { cid: req.correlationId, nivel: 'WARN' }); throw e; }
  }
}
