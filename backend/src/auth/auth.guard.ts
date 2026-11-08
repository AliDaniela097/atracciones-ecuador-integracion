import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../common/problem.js';
import type { Principal, Req } from '../common/http.js';

export const ROLES_KEY = 'roles';
/** Roles aceptados. 'PARTNER' = llamada M2M de Booking con X-API-Key. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Req>();
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    let principal: Principal | undefined;

    const key = req.headers['x-api-key'];
    if (typeof key === 'string' && key) {
      if (config.apiKeys.some((k) => safeEq(k, key))) principal = { type: 'api-key', roles: ['PARTNER'] };
      else throw unauthorized('X-API-Key inválida.');
    } else {
      const h = req.headers.authorization;
      if (!h?.startsWith('Bearer ')) throw unauthorized('Falta Authorization: Bearer <token> o X-API-Key.');
      try {
        const p: any = jwt.verify(h.slice(7), config.jwtSecret);
        principal = { type: 'jwt', id: Number(p.sub), email: p.email, roles: p.roles ?? [] };
      } catch {
        throw unauthorized('El token JWT expiró o su firma es inválida.');
      }
    }
    req.principal = principal;
    if (required?.length && !required.some((r) => principal!.roles.includes(r)))
      throw forbidden(`Se requiere uno de los roles: ${required.join(', ')}.`);
    return true;
  }
}
