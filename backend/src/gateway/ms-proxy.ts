import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Puerta de entrada HTTP a los microservicios REST nuevos (identity, billing_profile, location, catalog, review, cart, coupon, payment, refund, support, audit),
 * que escuchan solo en 127.0.0.1 dentro del mismo contenedor. Ruta pública:  /api/v3/ms/<servicio>/v1/...   y   /api/v3/ms/health (resumen de los 13).
 * - Solo se reenvían rutas /v1/... (nunca /internal/...), y se descarta cualquier cabecera x-internal-key que venga de afuera.
 * - La autenticación y los permisos los aplica cada microservicio (token emitido por ms_identity).
 * - pricing (gRPC) e invoicing (SOAP) no se exponen por aquí: los usan Order/Cart/Payment dentro del contenedor.
 */
const PUERTOS: Record<string, number> = { identity: 50101, billing_profile: 50102, location: 50103, catalog: 50104, review: 50105, cart: 50106, coupon: 50107, payment: 50108, refund: 50109, support: 50110, audit: 50111 };
const HUB = Number(process.env.MS_HUB_PORT ?? 50100);
const MAX_BODY = 256 * 1024;
const REENVIAR = ['authorization', 'content-type', 'accept', 'accept-language', 'user-agent', 'x-request-id', 'idempotency-key'];
const RESPONDER = ['content-type', 'location', 'x-request-id', 'cache-control'];

const problema = (res: any, status: number, code: string, message: string) => res.status(status).json({ code, message, invalid_params: [] });

export function registrarMsGateway(app: NestExpressApplication) {
  app.use('/api/v3/ms', async (req: any, res: any) => {
    try {
      const [ruta, consulta] = String(req.url).split('?');
      const partes = ruta.split('/').filter(Boolean);
      if (partes.length === 1 && partes[0] === 'health' && req.method === 'GET') {
        try {
          const r = await fetch(`http://127.0.0.1:${HUB}/health`, { signal: AbortSignal.timeout(4000) });
          return res.status(r.status).set('Cache-Control', 'no-store').type('application/json').send(await r.text());
        } catch { return problema(res, 503, 'MICROSERVICES_UNAVAILABLE', 'Los microservicios no responden por ahora.'); }
      }
      const servicio = (partes[0] ?? '').replace(/-/g, '_');
      const puerto = PUERTOS[servicio];
      if (!puerto) return problema(res, 404, 'NOT_FOUND', `Servicio desconocido. Disponibles: ${Object.keys(PUERTOS).join(', ')}.`);
      const destino = '/' + partes.slice(1).join('/');
      if (!/^\/v1(\/|$)/.test(destino) || destino.includes('..')) return problema(res, 404, 'NOT_FOUND', 'Ruta no encontrada.');
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return problema(res, 405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');

      let cuerpo: Buffer | undefined;
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const trozos: Buffer[] = []; let n = 0;
        for await (const c of req) { n += c.length; if (n > MAX_BODY) return problema(res, 413, 'PAYLOAD_TOO_LARGE', 'El cuerpo supera 256 KB.'); trozos.push(c); }
        cuerpo = Buffer.concat(trozos);
      }
      const cab: Record<string, string> = {};
      for (const h of REENVIAR) if (typeof req.headers[h] === 'string') cab[h] = req.headers[h];
      cab['x-correlation-id'] = req.correlationId;          // el Gateway inyecta el id de correlación (Semana 8) y lo propaga a cada microservicio
      if (!cab['x-request-id']) cab['x-request-id'] = req.correlationId;
      cab['x-forwarded-for'] = String(req.ip ?? '');       // IP real del cliente (los servicios la usan para limitar abusos)
      const r = await fetch(`http://127.0.0.1:${puerto}${destino}${consulta ? '?' + consulta : ''}`, { method: req.method, headers: cab, body: cuerpo?.length ? cuerpo : undefined, signal: AbortSignal.timeout(15000), redirect: 'manual' });
      for (const h of RESPONDER) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
      res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
    } catch (e: any) {
      if (e?.name === 'TimeoutError') return problema(res, 504, 'GATEWAY_TIMEOUT', 'El microservicio tardó demasiado.');
      problema(res, 502, 'BAD_GATEWAY', 'No se pudo contactar al microservicio.');
    }
  });
}
