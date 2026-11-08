import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { OutboxService } from './outbox.service.js';
import { AuthGuard, Roles } from '../auth/auth.guard.js';

@Controller('atracciones/eventos') @UseGuards(AuthGuard)
export class EventosController {
  constructor(@Inject(OutboxService) private o: OutboxService) {}
  @Get() @Roles('ADMIN', 'OPERADOR', 'PARTNER') feed(@Query() q: Record<string, any>) { return this.o.feed(q); }
}
