// Pruebas del verificador de compatibilidad (casos del ejercicio 7.4 del libro + reglas de Protobuf). Sin dependencias.  node contratos/test-compat.mjs
import { compararEsquema, compararProto } from './compat.mjs';
let ok = 0, mal = 0;
const t = (n, fn) => { try { fn(); ok++; console.log('  ✔', n); } catch (e) { mal++; console.log('  ✘', n, '\n     ', e.message); } };
const sea = (c, m) => { if (!c) throw new Error(m); };
const v1 = { type: 'object', required: ['nombre', 'precio'], properties: { nombre: { type: 'string', maxLength: 120 }, precio: { type: 'number', minimum: 0 }, categoria: { type: 'string', enum: ['electronica', 'oficina', 'hogar'] } } };
const cambia = (f) => { const c = structuredClone(v1); f(c); return compararEsquema(v1, c); };

console.log('JSON Schema (ejercicio 7.4 del libro)');
t('(a) agregar descripcionLarga OPCIONAL → compatible (MINOR)', () => sea(cambia((c) => { c.properties.descripcionLarga = { type: 'string' }; }).problemas.length === 0, 'debió ser compatible'));
t('(b) precio de number a integer → ROMPE (MAJOR)', () => sea(cambia((c) => { c.properties.precio.type = 'integer'; }).problemas.some((p) => /tipo cambiado/.test(p)), 'no detectó el cambio de tipo'));
t('(c) agregar "jardin" al enum → compatible (con advertencia de tolerancia)', () => sea(cambia((c) => { c.properties.categoria.enum.push('jardin'); }).problemas.length === 0, 'debió ser compatible'));
t('(d) hacer categoria REQUERIDO → ROMPE', () => sea(cambia((c) => { c.required.push('categoria'); }).problemas.some((p) => /pasó a requerido/.test(p)), 'no detectó'));
t('eliminar un campo → ROMPE', () => sea(cambia((c) => { delete c.properties.precio; }).problemas.some((p) => /eliminado/.test(p)), 'no detectó'));
t('renombrar un campo (= eliminar + agregar) → ROMPE', () => sea(cambia((c) => { c.properties.costo = c.properties.precio; delete c.properties.precio; c.required = ['nombre']; }).problemas.some((p) => /eliminado/.test(p)), 'no detectó'));
t('campo requerido NUEVO → ROMPE', () => sea(cambia((c) => { c.properties.sku = { type: 'string' }; c.required.push('sku'); }).problemas.some((p) => /requerido nuevo/.test(p)), 'no detectó'));
t('quitar un valor del enum → ROMPE', () => sea(cambia((c) => { c.properties.categoria.enum = ['oficina', 'hogar']; }).problemas.some((p) => /enum eliminados/.test(p)), 'no detectó'));
t('maxLength más estricto (120 → 50) → ROMPE', () => sea(cambia((c) => { c.properties.nombre.maxLength = 50; }).problemas.some((p) => /maxLength/.test(p)), 'no detectó'));
t('relajar la restricción (maxLength 120 → 200) → compatible', () => sea(cambia((c) => { c.properties.nombre.maxLength = 200; }).problemas.length === 0, 'debió ser compatible'));
t('additionalProperties: false nuevo → ROMPE', () => sea(cambia((c) => { c.additionalProperties = false; }).problemas.some((p) => /additionalProperties/.test(p)), 'no detectó'));
t('cambio dentro de un objeto anidado → ROMPE', () => { const a = { type: 'object', properties: { cliente: { type: 'object', properties: { id: { type: 'integer' } } } } }; const b = structuredClone(a); b.properties.cliente.properties.id.type = 'string'; sea(compararEsquema(a, b).problemas.some((p) => /cliente\.id/.test(p)), 'no detectó'); });

console.log('Protobuf (el NÚMERO de campo es lo que viaja)');
const p1 = 'syntax = "proto3"; message Producto { int32 id = 1; string nombre = 2; double precio = 3; } service S { rpc Obtener (Producto) returns (Producto); }';
const comp = (txt) => compararProto(p1, txt, 'p');
t('agregar un campo nuevo (=4) → compatible', () => sea(comp(p1.replace('double precio = 3;', 'double precio = 3; string cat = 4;')).problemas.length === 0, 'debió ser compatible'));
t('cambiar el tipo de un campo (precio double → string) → ROMPE', () => sea(comp(p1.replace('double precio = 3', 'string precio = 3')).problemas.some((p) => /cambió de tipo/.test(p)), 'no detectó'));
t('quitar un campo SIN reserved → ROMPE', () => sea(comp(p1.replace('double precio = 3;', '')).problemas.some((p) => /sin marcar reserved/.test(p)), 'no detectó'));
t('quitar un campo marcándolo reserved → compatible (aviso)', () => { const r = comp(p1.replace('double precio = 3;', 'reserved 3;')); sea(r.problemas.length === 0 && r.advertencias.length === 1, JSON.stringify(r)); });
t('reutilizar el número 3 para otro significado → ROMPE', () => sea(comp(p1.replace('double precio = 3', 'string color = 3')).problemas.some((p) => /número reutilizado/.test(p)), 'no detectó'));
t('renombrar un campo conservando número y tipo → compatible binario (aviso)', () => { const r = comp(p1.replace('string nombre = 2', 'string titulo = 2')); sea(r.problemas.length === 0 && r.advertencias.length === 1, JSON.stringify(r)); });
t('eliminar un rpc → ROMPE', () => sea(comp(p1.replace(/service S \{[^}]*\}/, 'service S { }')).problemas.some((p) => /rpc/.test(p)), 'no detectó'));
console.log(`\n${ok} ✔  ${mal} ✘`); process.exit(mal ? 1 : 0);
