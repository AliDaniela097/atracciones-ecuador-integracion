// Servidor gRPC de ms_booking.   npm start   (puerto GRPC_PORT, por defecto 50063)
import dotenv from 'dotenv';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(raiz, '.env'), quiet: true });
const { wrap } = await import('./lib/errors.mjs');
const { crearValidador } = await import('./lib/validate.mjs');
const { q, closePool } = await import('./lib/db.mjs');
const { crearServicio } = await import('./service.mjs');

const def = protoLoader.loadSync(path.join(raiz, 'proto/ms_booking.proto'), { keepCase: true, longs: Number, defaults: false, arrays: true, oneofs: false });
const pkg = grpc.loadPackageDefinition(def);
const servicio = crearServicio(crearValidador(path.join(raiz, 'schemas/requests.json')));
const handlers = Object.fromEntries(Object.entries(servicio).map(([n, fn]) => [n, wrap(n, fn)]));

const server = new grpc.Server();
server.addService(pkg.ms_booking.v1.BookingService.service, handlers);
const port = Number(process.env.GRPC_PORT ?? 50063);
await q('SELECT 1');                                                   // falla rápido si DATABASE_URL está mal
await new Promise((res, rej) => server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (e) => (e ? rej(e) : res())));
console.log(JSON.stringify({ level: 'info', msg: 'ms_booking iniciado', grpc_port: port }));
const salir = () => { server.tryShutdown(async () => { await closePool(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', salir); process.on('SIGTERM', salir);
