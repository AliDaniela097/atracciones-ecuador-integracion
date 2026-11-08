// Fábrica de clientes gRPC hacia los microservicios gRPC (pricing, order): plazo por llamada, errores traducidos a HttpError y cortacircuitos
// (5 fallos de conexión seguidos → 15 s sin llamar, para no colgar a quien consulta).
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { err } from './errores-http.mjs';

export function crearClienteGrpc({ nombre, protoPath, paquete, servicio, target, plazoMs = 3000 }) {
  let cliente; const br = { fallos: 0, abiertoHasta: 0 };
  const obtener = () => {
    if (!cliente) {
      const def = protoLoader.loadSync(protoPath, { keepCase: true, longs: Number, defaults: false, arrays: true, oneofs: false });
      let pkg = grpc.loadPackageDefinition(def); for (const p of paquete.split('.')) pkg = pkg[p];
      cliente = new pkg[servicio](target(), grpc.credentials.createInsecure());
    }
    return cliente;
  };
  const rpc = (metodo, req) => new Promise((res, rej) => {
    if (Date.now() < br.abiertoHasta) return rej(err(503, 'DEPENDENCY_UNAVAILABLE', `${nombre} no está disponible por ahora.`));
    obtener()[metodo](req, { deadline: Date.now() + plazoMs }, (e, r) => {
      if (!e) { br.fallos = 0; return res(r); }
      if (e.code === grpc.status.UNAVAILABLE || e.code === grpc.status.DEADLINE_EXCEEDED) { br.fallos += 1; if (br.fallos >= 5) br.abiertoHasta = Date.now() + 15000; return rej(err(503, 'DEPENDENCY_UNAVAILABLE', `No se pudo contactar a ${nombre}.`)); }
      br.fallos = 0; let c = {}; try { c = JSON.parse(e.details); } catch { /* sin cuerpo */ }
      const http = { [grpc.status.NOT_FOUND]: 404, [grpc.status.INVALID_ARGUMENT]: 400, [grpc.status.ALREADY_EXISTS]: 409 }[e.code] ?? 422;
      rej(err(http, c.code ?? `${nombre.toUpperCase()}_ERROR`, c.message ?? `${nombre} rechazó la consulta.`, c.invalid_params ?? []));
    });
  });
  return { rpc, cerrar: () => { try { cliente?.close(); } catch { /* ignorar */ } cliente = undefined; } };
}
