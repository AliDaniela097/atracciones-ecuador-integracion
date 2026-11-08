import { Injectable } from '@nestjs/common';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { load as yamlLoad } from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InvalidParam } from '../common/problem.js';

export const contractsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../contracts');

/**
 * Validación en tiempo de ejecución contra el contrato OpenAPI (schema-first, semana 7):
 * los esquemas salen del YAML, no se duplican a mano en el código.
 */
@Injectable()
export class ContractService {
  readonly doc: any;
  private ajv: Ajv;
  private cache = new Map<string, ValidateFunction>();

  constructor() {
    this.doc = yamlLoad(fs.readFileSync(path.join(contractsDir, 'atracciones-openapi-v3.yaml'), 'utf8'));
    this.ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
    (addFormats as any).default ? (addFormats as any).default(this.ajv) : (addFormats as any)(this.ajv);
    this.ajv.addSchema({ $id: 'oas', components: this.doc.components }, 'oas');
  }

  private compiled(name: string): ValidateFunction {
    let v = this.cache.get(name);
    if (!v) { v = this.ajv.compile({ $ref: `oas#/components/schemas/${name}` }); this.cache.set(name, v); }
    return v;
  }

  /** Devuelve la lista de errores como `invalid_params` (vacía si es válido). */
  check(name: string, data: unknown): InvalidParam[] {
    const v = this.compiled(name);
    if (v(data)) return [];
    return (v.errors ?? []).map((e) => ({
      name: (e.instancePath.replace(/^\//, '').replace(/\//g, '.') || (e.params as any)?.missingProperty || 'body') +
        (e.keyword === 'required' && e.instancePath ? '.' + (e.params as any).missingProperty : ''),
      reason: e.message ?? 'inválido',
    }));
  }
}
