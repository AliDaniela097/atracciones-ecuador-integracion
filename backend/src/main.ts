import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import swaggerUi from 'swagger-ui-express';
import fs from 'node:fs';
import path from 'node:path';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { ContractService, contractsDir } from './contract/contract.service.js';
import { CorrelationMiddleware, ProblemFilter } from './common/http.js';
import { registrarMsGateway } from './gateway/ms-proxy.js';
import { limitarPeticiones } from './gateway/rate-limit.js';
import { bitacora } from './observabilidad/bitacora.js';

if (!config.databaseUrl) { console.error('Falta DATABASE_URL (copie .env.example a .env).'); process.exit(1); }
if (config.jwtSecret === 'cambia-este-secreto-en-produccion' && process.env.NODE_ENV === 'production') { console.error('JWT_SECRET inseguro en producción.'); process.exit(1); }

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] });
app.setGlobalPrefix('api/v3');
app.disable('x-powered-by');
app.set('trust proxy', true);

const corr = new CorrelationMiddleware();
app.use((req: any, res: any, next: any) => corr.use(req, res, next));
app.use(limitarPeticiones);
// Bitácora HTTP: una línea por petición de negocio (sin query con datos personales: solo los NOMBRES de los parámetros) con su X-Correlation-Id.
app.use((req: any, res: any, next: any) => {
  const url: string = req.originalUrl ?? req.url;
  if (!url.startsWith('/api/v3/') || /^\/api\/v3\/(health|atracciones\/health|admin\/bitacora|ms\/health)(\/|\?|$)/.test(url)) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    const [ruta, qs] = url.split('?'); const params = qs ? [...new URLSearchParams(qs).keys()].join(',') : '';
    const origen = req.headers['x-api-key'] ? 'socio(api-key)' : req.headers.authorization ? 'usuario(jwt)' : 'anónimo';
    bitacora.registrar('HTTP', `${req.method} ${ruta}${params ? '?' + params : ''} → ${res.statusCode} (${Date.now() - t0} ms)`, { cid: req.correlationId, nivel: res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO', datos: { origen } });
  });
  next();
});   // Gateway: límite de peticiones por cliente (API Key > JWT > IP)
// Seguridad básica de cabeceras
app.use((_req: any, res: any, next: any) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
// Compatibilidad (Ley de Postel): /api/v1 y /api/v2 → v3; y atajos que Booking usa como {baseUrlRest}/reservas.
app.use((req: any, _res: any, next: any) => {
  let u: string = req.url;
  u = u.replace(/^\/api\/v[12](?=\/|$|\?)/, '/api/v3');
  u = u.replace(/^\/api\/v3\/(reservas|health|eventos|promociones)(?=\/|$|\?)/, '/api/v3/atracciones/$1');
  u = u.replace(/^\/(reservas|health)(?=\/|$|\?)/, '/api/v3/atracciones/$1');
  req.url = u; next();
});
app.enableCors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins, exposedHeaders: ['X-Correlation-Id', 'Location', 'Idempotent-Replay'] });
registrarMsGateway(app);   // /api/v3/ms/<servicio>/v1/... → microservicios REST nuevos (solo si están corriendo en el mismo contenedor)
app.useGlobalFilters(new ProblemFilter());

// Documentación interactiva servida desde el MISMO contrato que valida la API.
const contract = app.get(ContractService).doc;
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(contract, { customSiteTitle: 'Atracciones Ecuador — Contrato OpenAPI v3' }));
app.use('/api/contracts/openapi.yaml', (_req: any, res: any) => res.type('text/yaml').send(fs.readFileSync(path.join(contractsDir, 'atracciones-openapi-v3.yaml'), 'utf8')));
app.use('/api/contracts/inventory.proto', (_req: any, res: any) => res.type('text/plain').send(fs.readFileSync(path.join(contractsDir, 'proto/inventory.proto'), 'utf8')));

// Web (React) servida desde la misma URL: una sola base, sin CORS. Solo si existe la carpeta public/ (generada por deploy/build-package.mjs).
const publicDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.useStaticAssets(publicDir, { index: 'index.html', maxAge: '1h', setHeaders: (res: any, f: string) => { if (f.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } });
}

app.enableShutdownHooks();
await app.listen(config.port, '0.0.0.0');
console.log(JSON.stringify({ level: 'info', msg: 'Tienda de Atracciones iniciada', port: config.port, docs: `/api/docs`, service_id: config.serviceId, grpc: config.grpc.enabled ? config.grpc.target : 'off' }));
