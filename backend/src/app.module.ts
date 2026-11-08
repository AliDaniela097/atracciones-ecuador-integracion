import { Module } from '@nestjs/common';
import { Db } from './db/db.service.js';
import { ContractService } from './contract/contract.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController } from './auth/auth.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { CatalogController, CatalogDetailController } from './catalog/catalog.controller.js';
import { OutboxService } from './eventos/outbox.service.js';
import { EventosController } from './eventos/eventos.controller.js';
import { ReservasService } from './reservas/reservas.service.js';
import { ReservasController } from './reservas/reservas.controller.js';
import { PromocionesService } from './promociones/promociones.service.js';
import { PromocionesController } from './promociones/promociones.controller.js';
import { HealthController } from './health/health.controller.js';
import { GrpcInventoryService } from './grpc/grpc-inventory.service.js';
import { MicroserviciosService } from './microservicios/microservicios.service.js';
import { BookingCheckinService } from './checkin/booking-checkin.service.js';
import { ClientesService } from './clientes/clientes.service.js';
import { ClientesController } from './clientes/clientes.controller.js';
import { AmqpService } from './bus/amqp.service.js';
import { BusHandlers } from './bus/bus-handlers.service.js';
import { AdminService } from './admin/admin.service.js';
import { AdminController } from './admin/admin.controller.js';

// El orden de los controladores importa: CatalogDetailController (:id) va al final para no capturar
// /atracciones/health, /atracciones/reservas, /atracciones/eventos ni /atracciones/promociones.
@Module({
  controllers: [AuthController, CatalogController, ReservasController, ClientesController, PromocionesController, EventosController, HealthController, AdminController, CatalogDetailController],
  providers: [Db, ContractService, AuthGuard, AuthService, CatalogService, OutboxService, ReservasService, PromocionesService, GrpcInventoryService, AdminService, MicroserviciosService, BookingCheckinService, ClientesService, AmqpService, BusHandlers],
})
export class AppModule {}
