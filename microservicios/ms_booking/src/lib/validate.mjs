// Validación en ejecución con AJV contra schemas/requests.json (JSON Schema). Es el equivalente, para gRPC, de validar con el esquema del OpenAPI.
// El .proto verifica la forma al compilar/cargar; el JSON Schema agrega reglas que el proto no puede expresar (rangos, patrones, formatos, oneOf).
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { fail, S } from './errors.mjs';

export function crearValidador(rutaEsquema) {
  const doc = JSON.parse(readFileSync(rutaEsquema, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false, multipleOfPrecision: 4 });
  (addFormats.default ?? addFormats)(ajv);
  ajv.addSchema(doc, 'contrato');
  const cache = new Map();
  const compilar = (n) => {
    if (!cache.has(n)) { if (!doc.$defs[n]) throw new Error(`Esquema inexistente: ${n}`); cache.set(n, ajv.compile({ $ref: `contrato#/$defs/${n}` })); }
    return cache.get(n);
  };
  const errores = (nombre, datos) => {
    const v = compilar(nombre);
    return v(datos) ? [] : v.errors.map((e) => ({
      name: (e.instancePath || '/').replace(/^\//, '').replace(/\//g, '.') || (e.params?.missingProperty ?? '(raíz)'),
      reason: e.keyword === 'required' ? `Falta el campo obligatorio '${e.params.missingProperty}'` : e.message,
    }));
  };
  return {
    doc, errores,
    validar(nombre, datos) {
      const e = errores(nombre, datos);
      if (e.length) throw fail(S.INVALID_ARGUMENT, 'VALIDATION_ERROR', 'La petición no cumple el contrato.', e);
      return datos;
    },
  };
}
