import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../db/db.service.js';
import { config } from '../config.js';
import { AmqpService } from '../bus/amqp.service.js';
import { GrpcInventoryService } from '../grpc/grpc-inventory.service.js';

/** Semáforo de nodo: UP (<200 ms) · DEGRADED (200–800 ms) · DOWN (BD caída o >800 ms). */
@Controller(['atracciones/health', 'health'])
export class HealthController {
  constructor(@Inject(Db) private db: Db, @Inject(GrpcInventoryService) private grpc: GrpcInventoryService, @Inject(AmqpService) private bus: AmqpService) {}

  @Get() @Header('Cache-Control', 'no-store')
  async health(@Res({ passthrough: true }) res: Response) {
    const t0 = performance.now(); let connected = true;
    try { await this.db.query('SELECT 1'); } catch { connected = false; }
    const latency = Math.round(performance.now() - t0);
    const status = !connected || latency > 800 ? 'DOWN' : latency >= 200 ? 'DEGRADED' : 'UP';
    // DEGRADED responde 200 (se dibuja amarillo con el cuerpo); solo DOWN devuelve 503.
    if (status === 'DOWN') res.status(503);
    const pending = connected ? Number((await this.db.one(`SELECT COUNT(*) AS n FROM outbox_evento WHERE evt_tipo='STOCK_ACTUALIZADO' AND evt_publicado_en IS NULL`).catch(() => ({ n: -1 })))?.n ?? 0) : -1;
    return {
      status, service: 'Atracciones', node_id: config.nodeId, node_code: config.serviceId, url_base: config.publicBaseUrl, version: config.version, database_connected: connected,
      latency_ms: latency, memory_usage_mb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10, uptime_seconds: Math.round(process.uptime()), timestamp: new Date().toISOString(),
      grpc: { enabled: config.grpc.enabled, target: config.grpc.target, pending_stock_events: pending, ...this.grpc.stats() },
      bus: this.bus.stats(),
    };
  }
}
