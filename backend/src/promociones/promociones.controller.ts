import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { PromocionesService } from './promociones.service.js';
import { AuthGuard, Roles } from '../auth/auth.guard.js';

@Controller('atracciones/promociones/contrato') @UseGuards(AuthGuard)
export class PromocionesController {
  constructor(@Inject(PromocionesService) private s: PromocionesService) {}
  @Get() @Roles('ADMIN', 'OPERADOR', 'PARTNER') get() { return this.s.get(); }
  @Put() @Roles('ADMIN', 'PARTNER') put(@Body() body: any) { return this.s.put(body); }
}
