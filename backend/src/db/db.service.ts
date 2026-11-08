import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { Pool as NeonPool, neonConfig, types as neonTypes } from '@neondatabase/serverless';
import ws from 'ws';
import { config } from '../config.js';

export type Q = Pick<pg.Pool | pg.PoolClient, 'query'>;

// BIGINT (OID 20) llega como string por defecto; los IDs de este sistema caben en number.
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC (OID 1700) a number: precios con 2 decimales.
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE (OID 1082) se mantiene como texto YYYY-MM-DD (sin desfase de zona horaria).
pg.types.setTypeParser(1082, (v) => v);
// Mismos convertidores para el modo WebSocket (el paquete de Neon trae su propia copia de pg-types).
neonTypes.setTypeParser(20, (v: string) => Number(v));
neonTypes.setTypeParser(1700, (v: string) => Number(v));
neonTypes.setTypeParser(1082, (v: string) => v);

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: pg.Pool;
  private beat?: NodeJS.Timeout;

  constructor() {
    const url = config.databaseUrl;
    const ssl = /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined;
    if (config.dbOverWs) {
      neonConfig.webSocketConstructor = ws as any;
      if (config.dbWsProxy) { // solo para pruebas locales contra un Postgres propio
        neonConfig.wsProxy = () => config.dbWsProxy; neonConfig.useSecureWebSocket = false; neonConfig.pipelineTLS = false; neonConfig.pipelineConnect = false;
      }
      this.pool = new NeonPool({ connectionString: url.replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, ''), max: 10, idleTimeoutMillis: 600_000, connectionTimeoutMillis: 15_000 }) as unknown as pg.Pool;
      console.log(JSON.stringify({ level: 'info', msg: 'Base de datos por WebSocket (puerto 443)' }));
    } else {
      this.pool = new pg.Pool({ connectionString: url, ssl, max: 10, idleTimeoutMillis: 600_000, connectionTimeoutMillis: 10_000, keepAlive: true });
    }
    // Latido: mantiene viva una conexión (y despierta Neon) para que /health no supere el umbral de 800 ms por reconexiones.
    if (config.dbKeepaliveMs > 0) { this.beat = setInterval(() => { void this.pool.query('SELECT 1').catch(() => undefined); }, config.dbKeepaliveMs); this.beat.unref(); }
  }

  async query<T = any>(text: string, params: unknown[] = [], q: Q = this.pool): Promise<T[]> {
    const r = await q.query(text, params as any[]);
    return r.rows as T[];
  }

  async one<T = any>(text: string, params: unknown[] = [], q: Q = this.pool): Promise<T | undefined> {
    return (await this.query<T>(text, params, q))[0];
  }

  /** Transacción ACID (READ COMMITTED + bloqueos de fila explícitos donde hace falta). */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async onModuleDestroy() {
    if (this.beat) clearInterval(this.beat);
    await this.pool.end();
  }
}
