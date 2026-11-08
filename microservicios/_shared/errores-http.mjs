// Error HTTP estructurado: { code, message, invalid_params } (mismo formato de los servicios gRPC).
export class HttpError extends Error {
  constructor(status, code, message, invalid_params = []) { super(message); this.status = status; this.code = code; this.invalid_params = invalid_params; }
}
export const err = (status, code, message, invalid_params) => new HttpError(status, code, message, invalid_params);
export const noEncontrado = (que) => err(404, 'NOT_FOUND', `${que} no existe.`);
export const conflicto = (msg, code = 'CONFLICT') => err(409, code, msg);
export const regla = (msg, code = 'BUSINESS_RULE') => err(422, code, msg);

// Traduce errores de PostgreSQL (SQLSTATE) a respuestas HTTP entendibles. Devuelve null si no es un error conocido.
export function desdePg(e) {
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout exceeded when trying to connect|Connection terminated|terminating connection|the database system is (starting|shutting)|Query read timeout|57P01|57P03|08006|08001/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`))
    return err(503, 'DATABASE_UNAVAILABLE', 'La base de datos del servicio no está disponible por ahora; reintente en unos segundos.');
  switch (e?.code) {
    case '23505': return err(409, 'DUPLICATE', 'El registro ya existe (valor duplicado).');
    case '23503': return err(409, 'REFERENCE_VIOLATION', 'El registro está relacionado con otros datos o la referencia no existe.');
    case '23514': case '23502': case '22P02': case '22007': case '22003': case '22001': case '22023':
      return err(422, 'CONSTRAINT_VIOLATION', 'Algún dato no cumple las reglas de la base de datos.');
    case '40001': case '40P01': return err(503, 'RETRY', 'Conflicto de concurrencia; reintente.');
    default: return null;
  }
}
