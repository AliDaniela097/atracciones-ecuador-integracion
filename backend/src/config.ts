import 'dotenv/config';
import { fileURLToPath } from 'node:url';

const bool = (v: string | undefined, def: boolean) => (v === undefined || v === '' ? def : /^(1|true|si|yes)$/i.test(v));

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** true = habla con Neon por WebSocket (puerto 443) cuando la red bloquea el 5432. Pruebas locales: DB_WS_PROXY=localhost:PUERTO. */
  dbOverWs: bool(process.env.DB_OVER_WS, false),
  dbWsProxy: process.env.DB_WS_PROXY ?? '',
  /** Latido a la BD (ms) para mantener conexiones calientes; 0 lo desactiva. */
  dbKeepaliveMs: Number(process.env.DB_KEEPALIVE_MS ?? 15000),
  jwtSecret: process.env.JWT_SECRET ?? 'cambia-este-secreto-en-produccion',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  /** Claves X-API-Key aceptadas (M2M Booking ↔ tienda), separadas por coma. */
  apiKeys: (process.env.BOOKING_API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  serviceId: process.env.SERVICE_ID ?? 'NODE_ATR_ALISSON',
  nodeId: process.env.NODE_ID ?? 'node-atracciones-alisson-01',
  providerId: process.env.PROVIDER_ID ?? 'proveedor-atracciones-alisson',
  providerName: process.env.PROVIDER_NAME ?? 'Atracciones Ecuador (Alisson Basantes)',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000/api/v3',
  version: '3.1.0',
  validateCedula: bool(process.env.VALIDATE_CEDULA, true),
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  /** Integración con los microservicios gRPC (ms_inventory, ms_order, ms_booking). El stock hacia Booking lo sigue enviando SOLO el backend (item_id = código de la atracción); ms_inventory debe tener GRPC_ENABLED=false. */
  ms: {
    enabled: bool(process.env.MS_ENABLED, false),
    inventory: process.env.MS_INVENTORY_TARGET ?? 'localhost:50061',
    order: process.env.MS_ORDER_TARGET ?? 'localhost:50062',
    booking: process.env.MS_BOOKING_TARGET ?? 'localhost:50063',
    protoDir: process.env.MS_PROTO_DIR ?? fileURLToPath(new URL('../../microservicios', import.meta.url)),
    usuId: Number(process.env.MS_USU_ID ?? 1),
    deadlineMs: Number(process.env.MS_DEADLINE_MS ?? 8000),
    /** Aislamiento de fallos: si un microservicio NO responde (caído/lento), la reserva sigue solo en la tienda (su base es la fuente de verdad) y queda marcada como degradada. false = comportamiento estricto (503). */
    degrade: bool(process.env.MS_DEGRADE_ON_FAILURE, true),
    /** Tras una falla, no se vuelve a intentar con los microservicios durante este tiempo (cortacircuitos), para no hacer esperar 8 s a cada reserva. */
    breakerMs: Number(process.env.MS_BREAKER_MS ?? 15000),
  },
  /** Cómo se informa el stock a Booking: 'grpc' (PushStockUpdate, 50051) o 'rest' (POST /api/v3/inventory/stock, respaldo documentado en la guía de Azure). */
  booking: {
    stockMode: ((m) => (m === 'rest' ? 'rest' : m === 'amqp' ? 'amqp' : 'grpc') as 'grpc' | 'rest' | 'amqp')((process.env.BOOKING_STOCK_MODE ?? 'grpc').toLowerCase()),
    restStockUrl: process.env.BOOKING_REST_STOCK_URL ?? '',
    apiKey: process.env.BOOKING_API_KEY ?? '',
    /** true = además de los 5 campos documentados, enviar service_id y slot_id. */
    restExtraFields: bool(process.env.BOOKING_REST_EXTRA_FIELDS, false),
    /** Aviso de check-in presencial a Booking (contrato v3.1). Plantilla con {id}; si falta, se deriva de BOOKING_REST_STOCK_URL. */
    checkinUrl: process.env.BOOKING_CHECKIN_URL
      ?? ((process.env.BOOKING_REST_STOCK_URL ?? '').includes('/inventory/stock') ? (process.env.BOOKING_REST_STOCK_URL as string).replace(/\/inventory\/stock.*$/, '/reservas/{id}/checkin') : ''),
    /** Qué identificador de la reserva se envía como external_order_id: code (ATR-XXXX) | orden (ORD-ATR-n) | uuid. */
    checkinId: (process.env.BOOKING_CHECKIN_ID ?? 'code').toLowerCase(),
    checkinTimeoutMs: Number(process.env.BOOKING_CHECKIN_TIMEOUT_MS ?? 5000),
    checkinMaxAttempts: Number(process.env.BOOKING_CHECKIN_MAX_ATTEMPTS ?? 6),
  },
  /** Bus RabbitMQ (CloudAMQP). AMQP_URL es secreta: solo por variable de entorno, nunca en archivos del repositorio. */
  amqp: {
    url: process.env.AMQP_URL ?? '',
    enabled: bool(process.env.AMQP_ENABLED, true),
    exchange: process.env.AMQP_EXCHANGE ?? 'booking.events',
    queue: process.env.AMQP_QUEUE ?? 'q.atracciones.alisson.eventos',
    dlx: process.env.AMQP_DLX ?? 'dlx.atracciones.alisson',
    dlq: process.env.AMQP_DLQ ?? 'q.atracciones.alisson.dlq',
    bindKeys: (process.env.AMQP_BIND_KEYS ?? 'order.confirmed,saga.compensate,payment.refunded').split(',').map((s) => s.trim()).filter(Boolean),
    /** Dónde viaja el identificador de la reserva en el evento (Booking no lo fijó aún). Se prueban en orden. */
    idFields: (process.env.AMQP_ID_FIELDS ?? 'data.reservation_code,data.external_order_id,data.reservationCode,data.reservation_id,data.order_id,data.booking_id,data.id,subject').split(',').map((s) => s.trim()).filter(Boolean),
    /** Arreglos del evento donde Booking lista las reservas (order.confirmed → data.items, saga.compensate → data.acciones_compensatorias). */
    arrayPaths: (process.env.AMQP_ARRAY_PATHS ?? 'data.items,data.acciones_compensatorias').split(',').map((s) => s.trim()).filter(Boolean),
    prefetch: Number(process.env.AMQP_PREFETCH ?? 5),
    maxRetries: Number(process.env.AMQP_MAX_RETRIES ?? 3),
    publishTimeoutMs: Number(process.env.AMQP_PUBLISH_TIMEOUT_MS ?? 8000),
  },
  grpc: {
    enabled: bool(process.env.GRPC_ENABLED, true),
    target: process.env.BOOKING_GRPC_TARGET ?? 'localhost:50051',
    tls: bool(process.env.BOOKING_GRPC_TLS, false),
    intervalMs: Number(process.env.GRPC_DISPATCH_INTERVAL_MS ?? 2000),
    deadlineMs: Number(process.env.GRPC_DEADLINE_MS ?? 5000),
    maxAttempts: Number(process.env.GRPC_MAX_ATTEMPTS ?? 10),
    /** Espera tras un fallo de transporte (Booking caído) antes de reintentar. */
    retryMs: Number(process.env.GRPC_RETRY_MS ?? 30_000),
  },
};
