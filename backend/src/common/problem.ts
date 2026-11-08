/** RFC 7807 Problem Details con las extensiones del contrato (code, correlation_id, timestamp, invalid_params). */
export interface InvalidParam { name: string; reason: string }

export class ApiProblem extends Error {
  constructor(
    public status: number,
    public code: string,
    public title: string,
    public detail: string,
    public invalidParams?: InvalidParam[],
    public typeSlug?: string,
  ) { super(detail); }
}

const E = 'https://booking.epn.edu.ec/errors/';
export const problemType = (slug: string) => E + slug;

export const badRequest = (detail: string, code = 'BAD_REQUEST', invalid?: InvalidParam[]) =>
  new ApiProblem(400, code, 'Solicitud inválida', detail, invalid, 'bad-request');
export const unauthorized = (detail = 'Credenciales ausentes o inválidas.') =>
  new ApiProblem(401, 'UNAUTHORIZED', 'No Autorizado', detail, undefined, 'unauthorized');
export const forbidden = (detail = 'No cuenta con permisos para esta acción.') =>
  new ApiProblem(403, 'FORBIDDEN', 'Acceso Prohibido', detail, undefined, 'forbidden');
export const notFound = (detail: string, code = 'NOT_FOUND') =>
  new ApiProblem(404, code, 'Recurso no encontrado', detail, undefined, 'not-found');
export const conflict = (detail: string, code: string, title = 'Conflicto de estado') =>
  new ApiProblem(409, code, title, detail, undefined, 'conflict');
export const unprocessable = (detail: string, code = 'SEMANTIC_VALIDATION_FAILED', invalid?: InvalidParam[]) =>
  new ApiProblem(422, code, 'Validación Semántica Fallida (No Saga Compensation)', detail, invalid, 'unprocessable-entity');
export const outOfStock = (detail: string) =>
  new ApiProblem(409, 'OUT_OF_STOCK', 'Cupos Agotados para el Turno Horario (Saga Compensation Trigger)', detail, undefined, 'sin-cupos');
