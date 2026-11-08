import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiProblem, problemType } from './problem.js';

export type Req = Request & { correlationId: string; principal?: Principal };
export interface Principal { type: 'jwt' | 'api-key'; id?: number; email?: string; roles: string[] }

/** X-Correlation-Id: se respeta el que llega; si no, se genera y se devuelve siempre en la respuesta. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Req, res: Response, next: NextFunction) {
    const cid = (req.headers['x-correlation-id'] as string | undefined)?.trim() || `cid-${randomUUID().slice(0, 8)}`;
    req.correlationId = cid;
    res.setHeader('X-Correlation-Id', cid);
    next();
  }
}

/** Todo error sale como application/problem+json (RFC 7807). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(ex: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Req>();
    const res = ctx.getResponse<Response>();
    let status = 500, code = 'INTERNAL_ERROR', title = 'Error interno del servidor', detail = 'Ocurrió un error inesperado.';
    let slug = 'internal-error'; let invalid: any;

    if (ex instanceof ApiProblem) {
      ({ status, code, title, detail } = ex); slug = ex.typeSlug ?? code.toLowerCase(); invalid = ex.invalidParams;
    } else if (ex instanceof HttpException) {
      status = ex.getStatus();
      const body: any = ex.getResponse();
      detail = typeof body === 'string' ? body : (Array.isArray(body?.message) ? body.message.join('; ') : body?.message ?? ex.message);
      code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'BAD_REQUEST' : status === 413 ? 'PAYLOAD_TOO_LARGE' : `HTTP_${status}`;
      title = status === 404 ? 'Recurso no encontrado' : status === 400 ? 'Solicitud inválida' : ex.name;
      if (status === 400 && /JSON/i.test(detail)) { code = 'INVALID_JSON'; title = 'JSON inválido'; detail = 'El cuerpo de la petición no es JSON válido: ' + detail; }
      slug = code.toLowerCase().replace(/_/g, '-');
    } else if (ex?.type === 'entity.parse.failed') {
      status = 400; code = 'INVALID_JSON'; title = 'JSON inválido'; detail = 'El cuerpo de la petición no es JSON válido.'; slug = 'invalid-json';
    } else if (ex?.code === '23505') {
      status = 409; code = 'DUPLICATE'; title = 'Registro duplicado'; detail = `Ya existe un registro con ese valor (${ex.constraint ?? 'único'}).`; slug = 'duplicate';
    } else if (ex?.code === '23514') {
      status = 422; code = 'BUSINESS_RULE_VIOLATION'; title = 'Regla de negocio incumplida'; detail = ex.message; slug = 'unprocessable-entity';
    } else if (ex?.code === '23503') {
      status = 409; code = 'REFERENCE_CONFLICT'; title = 'Conflicto de referencia'; detail = 'El registro está referenciado por otros datos o referencia un dato inexistente.'; slug = 'reference-conflict';
    } else if (ex?.code === '22P02' || ex?.code === '22007' || ex?.code === '22008') {
      status = 400; code = 'BAD_REQUEST'; title = 'Solicitud inválida'; detail = 'Un valor tiene formato inválido.'; slug = 'bad-request';
    } else if (ex?.code === 'ECONNREFUSED' || ex?.code === 'ETIMEDOUT' || ex?.code === '57P01' || ex?.code === '08006') {
      status = 503; code = 'SERVICE_UNAVAILABLE'; title = 'Servicio no disponible'; detail = 'La base de datos no responde.'; slug = 'service-unavailable';
    }
    if (status >= 500) console.error(JSON.stringify({ level: 'error', cid: req.correlationId, path: req.originalUrl, err: String(ex?.stack ?? ex) }));

    const body: Record<string, unknown> = {
      type: problemType(slug), title, status, detail,
      instance: (req.originalUrl ?? req.url).split('?')[0],
      code, correlation_id: req.correlationId, timestamp: new Date().toISOString(),
    };
    if (invalid?.length) body.invalid_params = invalid;
    res.status(status).type('application/problem+json').send(body);
  }
}
