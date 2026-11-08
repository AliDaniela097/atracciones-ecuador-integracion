// Errores gRPC con cuerpo estructurado: details = JSON { code, message, invalid_params } (equivalente al RFC 7807 del contrato REST).
import grpc from '@grpc/grpc-js';
export const S = grpc.status;

export class GrpcFail extends Error {
  constructor(status, code, message, invalid_params = []) { super(message); this.status = status; this.code = code; this.invalid_params = invalid_params; }
}
export const fail = (status, code, message, invalid_params) => new GrpcFail(status, code, message, invalid_params);

const cuerpo = (code, message, invalid_params = []) => JSON.stringify({ code, message, invalid_params });

// Convierte un handler async (request) => response en un handler de grpc-js, traduciendo errores.
export function wrap(nombre, fn, log = console) {
  return async (call, callback) => {
    try { callback(null, await fn(call.request, call)); }
    catch (e) {
      if (e instanceof GrpcFail) return callback({ code: e.status, details: cuerpo(e.code, e.message, e.invalid_params) });
      if (e?.code === '23505') return callback({ code: S.ALREADY_EXISTS, details: cuerpo('DUPLICATE', 'El registro ya existe.') });
      if (e?.code === '23514') return callback({ code: S.FAILED_PRECONDITION, details: cuerpo('CONSTRAINT_VIOLATION', 'Se violó una regla de la base de datos.') });
      if (e?.code === '23503') return callback({ code: S.FAILED_PRECONDITION, details: cuerpo('REFERENCE_VIOLATION', 'Referencia inválida.') });
      log.error(JSON.stringify({ level: 'error', rpc: nombre, msg: String(e?.message ?? e) }));
      callback({ code: S.INTERNAL, details: cuerpo('INTERNAL', 'Error interno del microservicio.') });
    }
  };
}
