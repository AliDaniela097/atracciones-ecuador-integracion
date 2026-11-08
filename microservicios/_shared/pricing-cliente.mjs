// Cliente gRPC de ms_pricing (lo usa Cart y, más adelante, el backend).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearClienteGrpc } from './grpc-cliente.mjs';
import { puertoDe } from './servicios.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = crearClienteGrpc({ nombre: 'Pricing', protoPath: path.join(raiz, 'ms_pricing/proto/ms_pricing.proto'), paquete: 'ms_pricing.v1', servicio: 'PricingService', target: () => process.env.MS_PRICING_GRPC ?? `127.0.0.1:${puertoDe('pricing')}` });
export const rpcPricing = c.rpc;
export const cotizar = ({ atr_id, adultos = 1, ninos = 0, mayores = 0, fecha }) => c.rpc('CalculatePrice', { atr_id, adultos, ninos, mayores, ...(fecha ? { fecha } : {}) });
export const cerrarClientePricing = c.cerrar;
