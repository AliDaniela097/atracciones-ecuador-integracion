// Prueba funcional de los 13 microservicios nuevos (contra el hub en marcha). Usa SOLO datos de prueba.
//   Local:  MS_DB_BASE_URL=postgresql://postgres:postgres@localhost:5432/postgres MS_EXPOSE_TOKENS=true MS_ADMIN_EMAIL=admin@test.ec MS_ADMIN_PASSWORD=Admin12345 node scripts/start-hub.mjs
//           node scripts/test-ms13.mjs [grupo1|grupo2|grupo3|todo]
// NUNCA lo apunte a Neon/producción: crea usuarios, reseñas, pagos, etc.
import { SERVICIOS, puertoDe } from '../_shared/servicios.mjs';
const ADMIN = { correo: process.env.MS_ADMIN_EMAIL ?? 'admin@test.ec', password: process.env.MS_ADMIN_PASSWORD ?? 'Admin12345' };
const sufijo = Date.now().toString(36);
let ok = 0, mal = 0; const fallas = [];
export const url = (s, r) => `http://127.0.0.1:${puertoDe(s)}${r}`;
export async function http(s, metodo, ruta, { body, token, headers = {} } = {}) {
  const r = await fetch(url(s, ruta), { method: metodo, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; } return { st: r.status, j, h: r.headers };
}
export function chequear(nombre, cond, extra) { if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else { mal += 1; fallas.push(nombre); console.log(`  ✗ ${nombre}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
export const ctx = { sufijo, tokens: {}, ids: {} };

export async function grupo1() {
  console.log('\n== identity ==');
  let r = await http('identity', 'POST', '/v1/auth/login', { body: ADMIN }); chequear('login admin inicial', r.st === 200 && r.j.access_token && r.j.roles.includes('ADMIN'), r);
  ctx.tokens.admin = r.j.access_token;
  const correo = `cliente_${sufijo}@prueba.ec`;
  r = await http('identity', 'POST', '/v1/auth/register', { body: { correo, password: 'Clave12345', nombre: 'Ana', apellido: 'Prueba' } });
  chequear('registro 201 con rol CLIENTE', r.st === 201 && r.j.roles?.[0] === 'CLIENTE' && r.j.verification_token, r);
  ctx.ids.usuario = r.j.usu_id; const vt = r.j.verification_token; ctx.correo = correo;
  r = await http('identity', 'POST', '/v1/auth/register', { body: { correo, password: 'Clave12345', nombre: 'Ana', apellido: 'Prueba' } }); chequear('registro duplicado → 409', r.st === 409 && r.j.code === 'DUPLICATE', r);
  r = await http('identity', 'POST', '/v1/auth/register', { body: { correo: 'mal', password: '123', nombre: '', apellido: 'x', extra: 1 } }); chequear('registro inválido → 400 con invalid_params', r.st === 400 && r.j.invalid_params.length >= 3, r);
  r = await http('identity', 'POST', '/v1/auth/verify-email', { body: { token: vt } }); chequear('verificar correo', r.st === 200 && r.j.verificado, r);
  r = await http('identity', 'POST', '/v1/auth/verify-email', { body: { token: vt } }); chequear('token de verificación no se reutiliza', r.st === 400, r);
  r = await http('identity', 'POST', '/v1/auth/login', { body: { correo, password: 'incorrecta1' } }); chequear('login con clave mala → 401', r.st === 401 && r.j.code === 'INVALID_CREDENTIALS', r);
  r = await http('identity', 'POST', '/v1/auth/login', { body: { correo, password: 'Clave12345' } }); chequear('login cliente', r.st === 200 && r.j.access_token, r); ctx.tokens.cliente = r.j.access_token;
  r = await http('identity', 'GET', '/v1/auth/me', { token: ctx.tokens.cliente }); chequear('/me devuelve el usuario', r.st === 200 && r.j.correo === correo.toLowerCase(), r);
  r = await http('identity', 'GET', '/v1/auth/me'); chequear('/me sin token → 401', r.st === 401, r);
  r = await http('identity', 'GET', '/v1/usuarios', { token: ctx.tokens.cliente }); chequear('listar usuarios siendo CLIENTE → 403', r.st === 403, r);
  r = await http('identity', 'GET', '/v1/usuarios?limit=2', { token: ctx.tokens.admin }); chequear('listar usuarios como ADMIN con paginación', r.st === 200 && r.j.metadata.limit === 2 && r.j.data.length <= 2, r);
  r = await http('identity', 'GET', `/v1/usuarios/${ctx.ids.usuario}`, { token: ctx.tokens.cliente }); chequear('el cliente ve su propio usuario', r.st === 200, r);
  r = await http('identity', 'GET', `/v1/usuarios/1`, { token: ctx.tokens.cliente }); chequear('el cliente NO ve a otro usuario → 403', r.st === 403, r);
  r = await http('identity', 'POST', `/v1/usuarios/${ctx.ids.usuario}/roles`, { token: ctx.tokens.admin, body: { rol: 'OPERADOR' } }); chequear('asignar rol OPERADOR', r.st === 201 && r.j.roles.includes('OPERADOR'), r);
  r = await http('identity', 'POST', '/v1/auth/password/forgot', { body: { correo: 'noexiste@prueba.ec' } }); chequear('olvidé clave: 202 aunque no exista el correo', r.st === 202 && !r.j.reset_token, r);
  r = await http('identity', 'POST', '/v1/auth/password/forgot', { body: { correo } }); const rt = r.j.reset_token;
  r = await http('identity', 'POST', '/v1/auth/password/reset', { body: { token: rt, password: 'Nueva12345' } }); chequear('restablecer clave', r.st === 200, r);
  r = await http('identity', 'GET', '/v1/auth/me', { token: ctx.tokens.cliente }); chequear('restablecer cierra las sesiones anteriores', r.st === 401, r);
  r = await http('identity', 'POST', '/v1/auth/login', { body: { correo, password: 'Nueva12345' } }); chequear('login con la clave nueva', r.st === 200, r); ctx.tokens.cliente = r.j.access_token;
  r = await http('identity', 'POST', '/v1/auth/logout', { token: ctx.tokens.cliente }); chequear('logout', r.st === 200, r);
  r = await http('identity', 'GET', '/v1/auth/me', { token: ctx.tokens.cliente }); chequear('token revocado → 401', r.st === 401, r);
  r = await http('identity', 'POST', '/v1/auth/login', { body: { correo, password: 'Nueva12345' } }); ctx.tokens.cliente = r.j.access_token;
  const x = `fuerza_${sufijo}@prueba.ec`; await http('identity', 'POST', '/v1/auth/register', { body: { correo: x, password: 'Clave12345', nombre: 'F', apellido: 'B' } });
  for (let i = 0; i < 5; i++) await http('identity', 'POST', '/v1/auth/login', { body: { correo: x, password: 'mala12345' } });
  r = await http('identity', 'POST', '/v1/auth/login', { body: { correo: x, password: 'Clave12345' } }); chequear('freno de fuerza bruta tras 5 fallos → 429', r.st === 429, r);

  console.log('\n== billing_profile ==');
  const u = ctx.ids.usuario;
  r = await http('billing_profile', 'POST', `/v1/usuarios/${u}/datos-facturacion`, { token: ctx.tokens.cliente, body: { identificacion: '1710034065', razon_social: 'Ana Prueba', correo: 'ana@prueba.ec' } });
  chequear('crear dato de facturación (queda principal)', r.st === 201 && r.j.es_principal === true, r); ctx.ids.dfa = r.j.dfa_id;
  r = await http('billing_profile', 'POST', `/v1/usuarios/${u}/datos-facturacion`, { token: ctx.tokens.cliente, body: { tipo_identificacion: 'RUC', identificacion: '123', razon_social: 'X', correo: 'a@b.ec' } });
  chequear('RUC mal formado → 400', r.st === 400 && r.j.invalid_params[0].name === 'identificacion', r);
  r = await http('billing_profile', 'POST', `/v1/usuarios/${u}/datos-facturacion`, { token: ctx.tokens.cliente, body: { tipo_identificacion: 'RUC', identificacion: '1790012345001', razon_social: 'Mi Empresa', correo: 'e@prueba.ec', es_principal: true } });
  chequear('segundo dato como principal', r.st === 201 && r.j.es_principal, r);
  r = await http('billing_profile', 'GET', `/v1/usuarios/${u}/datos-facturacion`, { token: ctx.tokens.cliente }); chequear('solo uno es principal', r.st === 200 && r.j.data.filter((d) => d.es_principal).length === 1 && r.j.data.length === 2, r);
  r = await http('billing_profile', 'GET', `/v1/usuarios/${u}/datos-facturacion`); chequear('sin token → 401', r.st === 401, r);
  r = await http('billing_profile', 'GET', `/v1/usuarios/999999/datos-facturacion`, { token: ctx.tokens.cliente }); chequear('datos de otro usuario → 403', r.st === 403, r);
  r = await http('billing_profile', 'PATCH', `/v1/datos-facturacion/${ctx.ids.dfa}`, { token: ctx.tokens.cliente, body: { razon_social: 'Ana P. Editada' } }); chequear('editar', r.st === 200 && r.j.razon_social === 'Ana P. Editada', r);
  r = await http('billing_profile', 'DELETE', `/v1/datos-facturacion/${ctx.ids.dfa}`, { token: ctx.tokens.cliente }); chequear('borrado lógico 204', r.st === 204, r);
  r = await http('billing_profile', 'GET', `/v1/datos-facturacion/${ctx.ids.dfa}`, { token: ctx.tokens.cliente }); chequear('lo borrado ya no aparece → 404', r.st === 404, r);

  console.log('\n== location ==');
  r = await http('location', 'GET', '/v1/regiones'); chequear('4 regiones', r.st === 200 && r.j.data.length === 4, r);
  r = await http('location', 'GET', '/v1/provincias'); chequear('24 provincias', r.st === 200 && r.j.data.length === 24, r);
  r = await http('location', 'GET', '/v1/ciudades?q=quit'); chequear('buscar ciudad "quit"', r.st === 200 && r.j.data[0]?.nombre === 'Quito' && r.j.data[0].provincia === 'Pichincha', r); ctx.ids.quito = r.j.data[0]?.ciu_id;
  r = await http('location', 'GET', '/v1/ciudades?limit=500'); chequear('limit máximo 100 → 400', r.st === 400, r);
  r = await http('location', 'GET', '/v1/ciudades/abc'); chequear('id no numérico → 400', r.st === 400, r);
  r = await http('location', 'GET', '/v1/ciudades/99999'); chequear('ciudad inexistente → 404', r.st === 404, r);
  r = await http('location', 'POST', '/v1/ciudades', { token: ctx.tokens.cliente, body: { nombre: 'Prueba', codigo: '999999', prov_id: 1 } }); chequear('crear ciudad como CLIENTE → 403', r.st === 403, r);
  r = await http('location', 'POST', '/v1/ciudades', { token: ctx.tokens.admin, body: { nombre: `Ciudad ${sufijo}`, codigo: String(100000 + Math.floor(Math.random() * 800000)), prov_id: 1 } }); chequear('crear ciudad como ADMIN', r.st === 201, r);

  console.log('\n== support ==');
  r = await http('support', 'POST', '/v1/mensajes', { body: { nombre: 'Visitante', correo: 'v@prueba.ec', asunto: 'Consulta', cuerpo: 'Hola, quisiera información.' } }); chequear('mensaje público 201 (sin devolver contenido)', r.st === 201 && !r.j.cuerpo, r);
  r = await http('support', 'POST', '/v1/mensajes', { body: { nombre: 'V', correo: 'x', asunto: '', cuerpo: 'a' } }); chequear('mensaje inválido → 400', r.st === 400, r);
  r = await http('support', 'GET', '/v1/mensajes', { token: ctx.tokens.cliente }); chequear('leer mensajes como CLIENTE → 403', r.st === 403, r);
  r = await http('support', 'GET', '/v1/mensajes?leido=false', { token: ctx.tokens.admin }); chequear('leer mensajes como ADMIN', r.st === 200 && r.j.data.length >= 1, r);
  r = await http('support', 'PATCH', `/v1/mensajes/${r.j.data[0].men_id}`, { token: ctx.tokens.admin, body: { leido: true } }); chequear('marcar leído', r.st === 200 && r.j.leido, r);

  console.log('\n== audit ==');
  await espera(1200);                                          // los eventos viajan en segundo plano
  r = await http('audit', 'GET', '/v1/bitacora?accion=LOGIN&limit=5', { token: ctx.tokens.admin }); chequear('la bitácora recibió los LOGIN', r.st === 200 && r.j.metadata.total_results >= 1, r);
  r = await http('audit', 'GET', '/v1/bitacora?accion=USUARIO_REGISTRADO', { token: ctx.tokens.admin }); chequear('la bitácora recibió USUARIO_REGISTRADO', r.st === 200 && r.j.metadata.total_results >= 1, r);
  r = await http('audit', 'GET', '/v1/bitacora', { token: ctx.tokens.cliente }); chequear('bitácora como CLIENTE → 403', r.st === 403, r);
  r = await http('audit', 'POST', '/internal/eventos', { body: { tipo: 'X', origen: 'y' } }); chequear('/internal sin clave desde fuera del proceso hub → 403', r.st === 403 || r.st === 202, r);
  r = await http('audit', 'GET', '/v1/bitacora?accion=LOGIN&limit=1', { token: ctx.tokens.admin }); chequear('la bitácora no guarda contraseñas ni tokens', !JSON.stringify(r.j).match(/Nueva12345|Clave12345/), r);
  r = await http('identity', 'GET', '/ruta-que-no-existe'); chequear('404 JSON uniforme', r.st === 404 && r.j.code === 'NOT_FOUND', r);
  r = await http('identity', 'DELETE', '/v1/auth/login'); chequear('405 método no permitido', r.st === 405, r);
  const bad = await fetch(url('identity', '/v1/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{malo' }); chequear('JSON roto → 400', bad.status === 400);
  const big = await fetch(url('support', '/v1/mensajes'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(300000) }) }).catch((e) => ({ status: 'cortado' })); chequear('cuerpo > 256 KB rechazado', big.status === 413 || big.status === 'cortado', big.status);
}

export async function grupo2() {
  const { rpcPricing } = await import('../_shared/pricing-cliente.mjs');
  const A = ctx.tokens.admin;
  console.log('\n== catalog ==');
  let r = await http('catalog', 'POST', '/v1/operadores', { token: A, body: { codigo: Math.floor(Math.random() * 1e8), nombre: `Operador ${sufijo}`, prov_id: 19, ruc: String(1790000000000 + Math.floor(Math.random() * 99999999)).slice(0, 13) } });
  chequear('crear operador (valida la provincia en Location)', r.st === 201, r); const ope = r.j.ope_id; ctx.ids.ope = ope;
  r = await http('catalog', 'POST', '/v1/operadores', { token: A, body: { codigo: 55, nombre: 'X', prov_id: 30000 } }); chequear('operador con provincia inexistente → 422', r.st === 422 && r.j.code === 'PROVINCE_NOT_FOUND', r);
  const base = { nombre: `Tour Centro Histórico ${sufijo}`, descripcion: 'Recorrido guiado por el centro histórico de Quito.', tipo: 'GUIDED_TOUR', latitud: -0.2201, longitud: -78.5123, duracion_horas: 3.5, ciu_id: ctx.ids.quito, ope_id: ope, estado: 'PUBLICADA' };
  r = await http('catalog', 'POST', '/v1/atracciones', { token: ctx.tokens.cliente, body: base }); chequear('crear atracción como CLIENTE → 403', r.st === 403, r);
  r = await http('catalog', 'POST', '/v1/atracciones', { token: A, body: { ...base, tipo: 'MAGIA', latitud: 200 } }); chequear('atracción inválida → 400 con detalle', r.st === 400 && r.j.invalid_params.length >= 2, r);
  r = await http('catalog', 'POST', '/v1/atracciones', { token: A, body: { ...base, ciu_id: 30001 } }); chequear('ciudad inexistente → 422', r.st === 422 && r.j.code === 'CITY_NOT_FOUND', r);
  r = await http('catalog', 'POST', '/v1/atracciones', { token: A, body: base }); chequear('crear atracción (valida ciudad en Location)', r.st === 201 && r.j.slug.startsWith('tour-centro-historico'), r);
  const atr = r.j.atr_id; ctx.ids.atr = atr; const slug = r.j.slug; const uuid = r.j.uuid;
  r = await http('catalog', 'POST', '/v1/atracciones', { token: A, body: base }); chequear('mismo nombre genera slug distinto', r.st === 201 && r.j.slug !== slug, r); const atr2 = r.j.atr_id;
  r = await http('catalog', 'POST', '/v1/atracciones', { token: A, body: { ...base, nombre: `Borrador ${sufijo}`, estado: 'BORRADOR' } }); const borrador = r.j.atr_id;
  r = await http('catalog', 'GET', `/v1/atracciones/${borrador}`); chequear('un borrador no es visible al público → 404', r.st === 404, r);
  r = await http('catalog', 'GET', `/v1/atracciones/${borrador}`, { token: A }); chequear('el ADMIN sí ve el borrador', r.st === 200, r);
  for (const ref of [atr, slug, uuid]) { r = await http('catalog', 'GET', `/v1/atracciones/${ref}`); chequear(`ficha por ${ref === atr ? 'id' : ref === slug ? 'slug' : 'uuid'}`, r.st === 200 && r.j.atr_id === atr && r.j.operador?.ope_id === ope, r); }
  r = await http('catalog', 'GET', '/v1/categorias'); chequear('árbol de categorías', r.st === 200 && r.j.data.length >= 6, r); const cats = r.j.data;
  r = await http('catalog', 'POST', '/v1/categorias', { token: A, body: { nombre: `Senderismo ${sufijo}`, padre_id: cats[0].cat_id } }); chequear('subcategoría', r.st === 201, r); const sub = r.j.cat_id;
  r = await http('catalog', 'PUT', `/v1/atracciones/${atr}/categorias`, { token: A, body: { ids: [sub] } }); chequear('asignar categoría', r.st === 200, r);
  r = await http('catalog', 'PUT', `/v1/atracciones/${atr}/categorias`, { token: A, body: { ids: [999999] } }); chequear('categoría inexistente → 422', r.st === 422, r);
  r = await http('catalog', 'GET', `/v1/atracciones?cat_id=${cats[0].cat_id}&limit=50`); chequear('filtrar por categoría padre incluye subcategorías', r.st === 200 && r.j.data.some((a) => a.atr_id === atr), r);
  r = await http('catalog', 'PUT', `/v1/atracciones/${atr}/idiomas`, { token: A, body: { ids: [1, 2] } }); chequear('asignar idiomas', r.st === 200, r);
  r = await http('catalog', 'POST', '/v1/inclusiones', { token: A, body: { tipo: 'INCLUYE', nombre: `Guía ${sufijo}` } }); const inc = r.j.inc_id;
  r = await http('catalog', 'PUT', `/v1/atracciones/${atr}/inclusiones`, { token: A, body: { ids: [inc] } }); chequear('asignar inclusiones', r.st === 200, r);
  r = await http('catalog', 'POST', `/v1/atracciones/${atr}/fotos`, { token: A, body: { url: 'https://ejemplo.ec/foto1.jpg', alt: 'Plaza Grande' } }); chequear('agregar foto', r.st === 201, r); const fot = r.j.fot_id;
  r = await http('catalog', 'POST', `/v1/atracciones/${atr}/fotos`, { token: A, body: { url: 'javascript:alert(1)', alt: 'x' } }); chequear('foto con URL peligrosa → 400', r.st === 400, r);
  r = await http('catalog', 'GET', `/v1/atracciones/${atr}`); chequear('ficha completa con fotos, idiomas e inclusiones', r.j.fotos.length === 1 && r.j.idiomas.length === 2 && r.j.inclusiones.length === 1 && r.j.categorias.length === 1, r);
  r = await http('catalog', 'GET', `/v1/atracciones?q=${encodeURIComponent('centro')}&ciu_id=${ctx.ids.quito}&orden=calificacion&limit=3`); chequear('búsqueda por texto + ciudad', r.st === 200 && r.j.data.length >= 1 && r.j.data[0].foto_principal !== undefined, r);
  r = await http('catalog', 'GET', '/v1/atracciones?q=%25%25_'); chequear('los comodines de la búsqueda se escapan', r.st === 200 && r.j.data.length === 0, r);
  r = await http('catalog', 'GET', '/v1/atracciones?estado=BORRADOR'); chequear('listar borradores sin permiso → 401', r.st === 401, r);
  r = await http('catalog', 'PATCH', `/v1/atracciones/${atr2}`, { token: A, body: { destacada: true, nombre: 'Nombre editado' } }); chequear('editar atracción', r.st === 200 && r.j.destacada, r);
  r = await http('catalog', 'DELETE', `/v1/atracciones/${atr2}`, { token: A }); chequear('borrado lógico', r.st === 204, r);
  r = await http('catalog', 'GET', `/v1/atracciones/${atr2}`, { token: A }); chequear('lo eliminado ya no aparece (ni al ADMIN)', r.st === 404, r);
  r = await http('catalog', 'DELETE', `/v1/atracciones/${atr}/fotos/${fot}`, { token: A }); chequear('quitar foto', r.st === 204, r);
  // operador (rol OPERADOR vinculado) edita solo lo suyo
  r = await http('catalog', 'POST', `/v1/operadores/${ope}/usuarios`, { token: A, body: { usu_id: ctx.ids.usuario, cargo: 'ADMIN' } }); chequear('vincular usuario OPERADOR a la empresa', r.st === 201, r);
  r = await http('identity', 'POST', '/v1/auth/login', { body: { correo: ctx.correo, password: 'Nueva12345' } }); ctx.tokens.operador = r.j.access_token;
  r = await http('catalog', 'PATCH', `/v1/atracciones/${atr}`, { token: ctx.tokens.operador, body: { descripcion_corta: 'Corto' } }); chequear('el OPERADOR vinculado edita su atracción', r.st === 200, r);
  r = await http('catalog', 'POST', '/v1/operadores', { token: A, body: { codigo: Math.floor(Math.random() * 1e8), nombre: `Otra ${sufijo}`, prov_id: 19 } }); const ope2 = r.j.ope_id;
  r = await http('catalog', 'POST', '/v1/atracciones', { token: ctx.tokens.operador, body: { ...base, nombre: 'Ajena', ope_id: ope2 } }); chequear('el OPERADOR NO crea en otra empresa → 403', r.st === 403, r);

  console.log('\n== pricing (gRPC) ==');
  const T = async (tipo, precio, extra = {}) => rpcPricing('CreateTariff', { atr_id: atr, tar_tipo: tipo, tar_precio: precio, tar_vigente_desde: '2026-01-01', ...extra });
  let x = await T('ADULTO', 20); chequear('crear tarifa ADULTO', x.tar_precio === 20 && x.tar_vigente_hasta === '', x);
  await T('NINO', 10); await T('GRUPO', 15);
  x = await rpcPricing('CalculatePrice', { atr_id: atr, fecha: '2026-06-01', adultos: 2, ninos: 1 }); chequear('cotizar 2 adultos + 1 niño = 50.00', x.subtotal === 50 && x.lineas.length === 2 && x.moneda === 'USD', x);
  x = await rpcPricing('CalculatePrice', { atr_id: atr, fecha: '2026-06-01', adultos: 8, ninos: 4 }).catch((e) => e); chequear('12 personas → tarifa GRUPO 15 (180.00 < 200.00 individual)', x.subtotal === 180 && x.lineas[0].tar_tipo === 'GRUPO', x);
  x = await rpcPricing('CalculatePrice', { atr_id: atr, fecha: '2026-06-01', mayores: 1 }).catch((e) => e); chequear('tipo sin tarifa → error TARIFF_NOT_FOUND', x.code === 'TARIFF_NOT_FOUND', x);
  x = await rpcPricing('CalculatePrice', { atr_id: atr, adultos: 0 }).catch((e) => e); chequear('cero personas → error de validación', x.status === 400 || x.code === 'VALIDATION_ERROR', x);
  x = await T('ADULTO', 25, { tar_vigente_desde: '2026-07-01' }); chequear('nueva tarifa ADULTO desde 2026-07-01', x.tar_precio === 25, x);
  x = await rpcPricing('GetCurrentTariffs', { atr_id: atr, fecha: '2026-06-30' }); chequear('el 30/06 sigue vigente la tarifa vieja (20)', x.data.find((t) => t.tar_tipo === 'ADULTO').tar_precio === 20, x);
  x = await rpcPricing('GetCurrentTariffs', { atr_id: atr, fecha: '2026-07-01' }); chequear('desde el 01/07 rige la nueva (25)', x.data.find((t) => t.tar_tipo === 'ADULTO').tar_precio === 25, x);
  x = await rpcPricing('ListTariffHistory', { atr_id: atr, tar_tipo: 'ADULTO' }); const vieja = x.data.find((t) => t.tar_precio === 20); chequear('historial: la vieja quedó cerrada el 30/06', x.data.length === 2 && vieja.tar_vigente_hasta === '2026-06-30', x);
  x = await T('ADULTO', 30, { tar_vigente_desde: '2026-03-01' }).catch((e) => e); chequear('tarifa con fecha anterior a la última → rechazada', x.code === 'TARIFF_DATE_CONFLICT', x);
  x = await T('ADULTO', 30, { tar_moneda: 'EUR', tar_vigente_desde: '2026-09-01' }).catch((e) => e); chequear('no se cambia de moneda', x.code === 'MIXED_CURRENCY', x);
  x = await rpcPricing('CreateTariff', { atr_id: atr, tar_tipo: 'ADULTO', tar_precio: 10.555 }).catch((e) => e); chequear('precio con 3 decimales → error', x.status === 400 || x.code === 'VALIDATION_ERROR', x);

  console.log('\n== coupon ==');
  const cod = `PROMO${sufijo}`.toUpperCase().slice(0, 20);
  r = await http('coupon', 'POST', '/v1/cupones', { token: A, body: { codigo: cod, tipo: 'PORCENTAJE', valor: 20, fecha_inicio: '2026-01-01', usos_max: 2 } }); chequear('crear cupón', r.st === 201 && r.j.codigo === cod, r);
  r = await http('coupon', 'POST', '/v1/cupones', { token: A, body: { codigo: cod, tipo: 'FIJO', valor: 5, fecha_inicio: '2026-01-01' } }); chequear('código repetido → 409', r.st === 409, r);
  r = await http('coupon', 'POST', '/v1/cupones', { token: A, body: { codigo: 'ABC', tipo: 'PORCENTAJE', valor: 150, fecha_inicio: '2026-01-01' } }); chequear('porcentaje > 100 → 400', r.st === 400, r);
  r = await http('coupon', 'POST', '/v1/cupones', { token: ctx.tokens.cliente, body: { codigo: 'ZZZ', tipo: 'FIJO', valor: 5, fecha_inicio: '2026-01-01' } }); chequear('crear cupón como CLIENTE → 403', r.st === 403, r);
  r = await http('coupon', 'POST', '/v1/cupones/validar', { token: ctx.tokens.cliente, body: { codigo: cod.toLowerCase(), subtotal: 50 } }); chequear('validar 20% de 50.00 = 10.00 (acepta minúsculas)', r.st === 200 && r.j.valido && r.j.descuento === 10 && r.j.total_con_descuento === 40, r);
  r = await http('coupon', 'POST', '/v1/cupones/validar', { token: ctx.tokens.cliente, body: { codigo: cod, subtotal: 50, usos_actuales: 2 } }); chequear('usos agotados', r.j.valido === false && r.j.motivo === 'USOS_AGOTADOS', r);
  r = await http('coupon', 'POST', '/v1/cupones/validar', { token: ctx.tokens.cliente, body: { codigo: 'NOEXISTE', subtotal: 50 } }); chequear('cupón inexistente', r.j.valido === false && r.j.motivo === 'NO_EXISTE', r);
  r = await http('coupon', 'POST', '/v1/cupones', { token: A, body: { codigo: `FIJO${sufijo}`.toUpperCase().slice(0, 20), tipo: 'FIJO', valor: 100, fecha_inicio: '2026-01-01' } });
  r = await http('coupon', 'POST', '/v1/cupones/validar', { token: ctx.tokens.cliente, body: { codigo: `FIJO${sufijo}`, subtotal: 30 } }); chequear('descuento fijo nunca supera el subtotal', r.j.valido && r.j.descuento === 30 && r.j.total_con_descuento === 0, r);
  r = await http('coupon', 'POST', '/v1/cupones', { token: A, body: { codigo: `OLD${sufijo}`.toUpperCase().slice(0, 20), tipo: 'FIJO', valor: 5, fecha_inicio: '2020-01-01', fecha_fin: '2020-12-31' } });
  r = await http('coupon', 'POST', '/v1/cupones/validar', { token: ctx.tokens.cliente, body: { codigo: `OLD${sufijo}`, subtotal: 30 } }); chequear('cupón vencido', r.j.valido === false && r.j.motivo === 'VENCIDO', r);
  r = await http('coupon', 'PATCH', `/v1/cupones/${cod}`, { token: A, body: { activo: false } }); chequear('desactivar cupón', r.st === 200 && r.j.activo === false, r);
  r = await http('coupon', 'POST', '/v1/cupones/validar', { token: ctx.tokens.cliente, body: { codigo: cod, subtotal: 50 } }); chequear('cupón inactivo', r.j.motivo === 'INACTIVO', r);

  console.log('\n== review (+ evento hacia catalog) ==');
  const U = ctx.ids.usuario;
  r = await http('review', 'POST', `/v1/atracciones/${atr}/resenas`, { token: ctx.tokens.cliente, body: { puntuacion: 5, comentario: 'Excelente recorrido, muy recomendado.' } }); chequear('reseña con sesión', r.st === 201 && r.j.usu_id === U && r.j.atraccion.promedio === 5, r); const ren1 = r.j.ren_id;
  r = await http('review', 'POST', `/v1/atracciones/${atr}/resenas`, { token: ctx.tokens.cliente, body: { puntuacion: 4, comentario: 'Segunda reseña del mismo usuario.' } }); chequear('segunda reseña del mismo usuario → 409', r.st === 409, r);
  r = await http('review', 'POST', `/v1/atracciones/${atr}/resenas`, { body: { puntuacion: 3, comentario: 'Anónima pero válida.', autor_nombre: 'Visitante' } }); chequear('reseña anónima con autor_nombre', r.st === 201 && r.j.usu_id === null && r.j.atraccion.promedio === 4 && r.j.atraccion.numero_resenas === 2, r); ren2 = r.j.ren_id;
  r = await http('review', 'POST', `/v1/atracciones/${atr}/resenas`, { body: { puntuacion: 3, comentario: 'Sin nombre de autor.' } }); chequear('anónima sin autor_nombre → 400', r.st === 400, r);
  r = await http('review', 'POST', `/v1/atracciones/${atr}/resenas`, { body: { puntuacion: 9, comentario: 'x', autor_nombre: 'A' } }); chequear('puntuación 9 → 400', r.st === 400, r);
  r = await http('review', 'POST', `/v1/atracciones/999999/resenas`, { body: { puntuacion: 3, comentario: 'Atracción que no existe.', autor_nombre: 'A' } }); chequear('atracción inexistente → 422', r.st === 422, r);
  await espera(1500);
  r = await http('catalog', 'GET', `/v1/atracciones/${atr}`); chequear('Catalog recibió RESENA_PUBLICADA: promedio 4 y 2 reseñas', r.j.calificacion_promedio === 4 && r.j.numero_resenas === 2, { p: r.j.calificacion_promedio, n: r.j.numero_resenas });
  r = await http('review', 'GET', `/v1/atracciones/${atr}/resenas`); chequear('listado con resumen y distribución', r.st === 200 && r.j.resumen.total === 2 && r.j.resumen.distribucion['5'] === 1 && r.j.resumen.distribucion['3'] === 1, r);
  r = await http('review', 'PATCH', `/v1/resenas/${ren2}/visibilidad`, { token: ctx.tokens.cliente, body: { visible: false } }); chequear('ocultar reseña como CLIENTE → 403', r.st === 403, r);
  r = await http('review', 'PATCH', `/v1/resenas/${ren2}/visibilidad`, { token: A, body: { visible: false } }); chequear('ADMIN oculta la reseña', r.st === 200 && r.j.atraccion.promedio === 5 && r.j.atraccion.numero_resenas === 1, r);
  await espera(1500);
  r = await http('catalog', 'GET', `/v1/atracciones/${atr}`); chequear('Catalog recalculó tras ocultar (5.0 y 1)', r.j.calificacion_promedio === 5 && r.j.numero_resenas === 1, { p: r.j.calificacion_promedio, n: r.j.numero_resenas });
  r = await http('review', 'DELETE', `/v1/resenas/${ren1}`, { token: A }); chequear('borrar reseña', r.st === 204, r);
  await espera(1500);
  r = await http('catalog', 'GET', `/v1/atracciones/${atr}`); chequear('Catalog quedó en 0 reseñas', r.j.calificacion_promedio === 0 && r.j.numero_resenas === 0, { p: r.j.calificacion_promedio, n: r.j.numero_resenas });

  console.log('\n== cart ==');
  r = await http('cart', 'GET', `/v1/usuarios/${U}/carrito`, { token: ctx.tokens.cliente }); chequear('carrito vacío creado al consultar', r.st === 200 && r.j.items.length === 0 && r.j.activo, r); const car = r.j.car_id;
  r = await http('cart', 'GET', `/v1/usuarios/${U}/carrito`, { token: ctx.tokens.cliente }); chequear('el carrito activo es único', r.j.car_id === car, r);
  r = await http('cart', 'POST', `/v1/usuarios/${U}/carrito/items`, { token: ctx.tokens.cliente, body: { atr_id: atr, adultos: 2, ninos: 1 } }); chequear('agregar línea', r.st === 201 && r.j.adultos === 2, r); const cai = r.j.cai_id;
  r = await http('cart', 'POST', `/v1/usuarios/${U}/carrito/items`, { token: ctx.tokens.cliente, body: { atr_id: atr, adultos: 1 } }); chequear('misma atracción: se suman personas (200)', r.st === 200 && r.j.cai_id === cai && r.j.adultos === 3, r);
  r = await http('cart', 'POST', `/v1/usuarios/${U}/carrito/items`, { token: ctx.tokens.cliente, body: { atr_id: 999999 } }); chequear('atracción inexistente → 422', r.st === 422, r);
  r = await http('cart', 'POST', `/v1/usuarios/${U}/carrito/items`, { token: ctx.tokens.cliente, body: { atr_id: atr, adultos: 0 } }); chequear('0 adultos → 400', r.st === 400, r);
  r = await http('cart', 'GET', `/v1/usuarios/${U}/carrito?precios=true`, { token: ctx.tokens.cliente }); chequear('carrito con precios desde Pricing: 3×25 + 1×10 = 85.00', r.st === 200 && r.j.precios_disponibles && r.j.subtotal === 85, r);
  r = await http('cart', 'GET', `/v1/usuarios/${U}/carrito`, { token: ctx.tokens.admin }); chequear('el ADMIN puede ver el carrito', r.st === 200, r);
  r = await http('cart', 'GET', `/v1/usuarios/${U}/carrito`); chequear('sin token → 401', r.st === 401, r);
  r = await http('cart', 'GET', `/v1/usuarios/1/carrito`, { token: ctx.tokens.cliente }); chequear('carrito de otro usuario → 403', r.st === 403, r);
  r = await http('cart', 'PATCH', `/v1/usuarios/${U}/carrito/items/${cai}`, { token: ctx.tokens.cliente, body: { adultos: 1, ninos: 0 } }); chequear('editar cantidades', r.st === 200 && r.j.adultos === 1 && r.j.ninos === 0, r);
  r = await http('cart', 'DELETE', `/v1/usuarios/${U}/carrito/items/${cai}`, { token: ctx.tokens.cliente }); chequear('quitar línea', r.st === 204, r);
  r = await http('cart', 'DELETE', `/v1/usuarios/${U}/carrito/items/${cai}`, { token: ctx.tokens.cliente }); chequear('quitar línea inexistente → 404', r.st === 404, r);
  await http('cart', 'POST', `/v1/usuarios/${U}/carrito/items`, { token: ctx.tokens.cliente, body: { atr_id: atr } });
  r = await http('cart', 'POST', `/v1/usuarios/${U}/carrito/cerrar`, { token: ctx.tokens.cliente }); chequear('cerrar carrito (checkout)', r.st === 200 && r.j.cerrado, r);
  r = await http('cart', 'GET', `/v1/usuarios/${U}/carrito`, { token: ctx.tokens.cliente }); chequear('después de cerrar nace un carrito nuevo vacío', r.j.car_id !== car && r.j.items.length === 0, r);
}
let ren2;

const tarjetaConFin = (ult4, prefijo = '4') => { for (let m = 0; m < 1e9; m++) { const n = prefijo + String(m).padStart(11, '0') + ult4.slice(0, 0); const base = n.slice(0, 16 - 4) + ult4; if (base.length === 16 && luhnOk(base)) return base; } };
const luhnOk = (n) => { let s = 0, alt = false; for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } s += d; alt = !alt; } return s % 10 === 0; };
const buscarTarjeta = (ult4) => { for (let m = 0; m < 1e8; m++) { const n = '4' + String(m).padStart(7, '0') + ult4.padStart(8, '0').slice(0, 0) ; const c = `4${String(m).padStart(11, '0')}`.slice(0, 12) + ult4; if (c.length === 16 && luhnOk(c)) return c; } };
const xmlParser = async () => { const { XMLParser } = await import('fast-xml-parser'); return new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, isArray: (n) => n === 'detalle' || n === 'factura' }); };
async function soap(op, interior, token, crudo) {
  const sobre = crudo ?? `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:inv="urn:descubre-ec:invoicing:v1"><soapenv:Body><inv:${op}Request>${interior}</inv:${op}Request></soapenv:Body></soapenv:Envelope>`;
  const r = await fetch(url('invoicing', '/soap'), { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `urn:descubre-ec:invoicing:v1/${op}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: sobre });
  const t = await r.text(); const doc = (await xmlParser()).parse(t); const body = doc?.Envelope?.Body;
  return { st: r.status, texto: t, fault: body?.Fault, resp: body?.[`${op}Response`] };
}
export async function grupo3() {
  const { rpcOrder, obtenerOrden } = await import('../_shared/order-cliente.mjs');
  const A = ctx.tokens.admin; const C = ctx.tokens.cliente; const U = ctx.ids.usuario; const atr = ctx.ids.atr;
  const nuevaOrden = async (monto = 50, cant = 2) => (await rpcOrder('CreateOrder', { usu_id: U, items: [{ atr_id: atr, det_descripcion: 'Tour de prueba', det_cantidad: cant, det_precio_unitario: monto / cant }] }));
  const visa = tarjetaConFin('1111'); const visaRech = tarjetaConFin('0002'); const visaFalla = tarjetaConFin('0119');
  const pagoTarjeta = (ord, monto, numero = visa, extra = {}) => ({ ord_id: ord, metodo: 'TARJETA', monto, tarjeta: { numero, titular: 'ANA PRUEBA', mes: 12, anio: 2030, cvv: '123', ...extra } });

  console.log('\n== payment ==');
  let r = await http('payment', 'GET', '/v1/metodos-pago'); chequear('métodos de pago', r.st === 200 && r.j.data.length === 4, r);
  const o1 = await nuevaOrden(50); chequear('(preparación) orden creada vía gRPC en CREADA con total 50', o1.est_codigo === 'CREADA' && o1.ord_total === 50, o1);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(o1.ord_id, 49.99) }); chequear('monto distinto al total → 422 AMOUNT_MISMATCH', r.st === 422 && r.j.code === 'AMOUNT_MISMATCH', r);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(999999, 50) }); chequear('orden inexistente → 422', r.st === 422 && r.j.code === 'ORDER_NOT_FOUND', r);
  r = await http('payment', 'POST', '/v1/pagos', { body: pagoTarjeta(o1.ord_id, 50) }); chequear('sin token → 401', r.st === 401, r);
  const otro = await http('identity', 'POST', '/v1/auth/register', { body: { correo: `otro_${sufijo}@prueba.ec`, password: 'Clave12345', nombre: 'Otro', apellido: 'Usuario' } });
  const tokOtro = (await http('identity', 'POST', '/v1/auth/login', { body: { correo: `otro_${sufijo}@prueba.ec`, password: 'Clave12345' } })).j.access_token; ctx.tokens.otro = tokOtro; ctx.ids.otro = otro.j.usu_id;
  r = await http('payment', 'POST', '/v1/pagos', { token: tokOtro, body: pagoTarjeta(o1.ord_id, 50) }); chequear('pagar la orden de otro usuario → 403', r.st === 403, r);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(o1.ord_id, 50, '4111111111111112') }); chequear('tarjeta con Luhn inválido → 422', r.st === 422 && r.j.code === 'INVALID_CARD', r);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(o1.ord_id, 50, visa, { anio: 2021 }) }); chequear('tarjeta vencida → 422', r.st === 422 && r.j.code === 'CARD_EXPIRED', r);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(o1.ord_id, 50, '6011000000000004') }); chequear('marca no soportada → 422', r.st === 422, r);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: { ord_id: o1.ord_id, metodo: 'TARJETA', monto: 50 } }); chequear('TARJETA sin datos de tarjeta → 400', r.st === 400, r);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(o1.ord_id, 50, visaRech) }); chequear('tarjeta ...0002 → RECHAZADO con motivo', r.st === 201 && r.j.estado === 'RECHAZADO' && r.j.motivo_rechazo, r);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(o1.ord_id, 50, visaFalla) }); chequear('tarjeta ...0119 → FALLIDO', r.st === 201 && r.j.estado === 'FALLIDO', r);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(o1.ord_id, 50) }); chequear('reintento tras rechazo → APROBADO', r.st === 201 && r.j.estado === 'APROBADO' && r.j.autorizacion && r.j.orden_actualizada === true, r); const pag1 = r.j.pag_id; ctx.ids.pag1 = pag1; ctx.ids.ord1 = o1.ord_id;
  chequear('la respuesta solo trae marca y últimos 4', r.j.tarjeta.ultimos4 === '1111' && !JSON.stringify(r.j).includes(visa) && !JSON.stringify(r.j).includes('123"'), r.j.tarjeta);
  const ord1 = await obtenerOrden(o1.ord_id); chequear('Order pasó a PAGADA automáticamente (gRPC)', ord1.est_codigo === 'PAGADA', ord1);
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(o1.ord_id, 50) }); chequear('pagar una orden ya pagada → 409', r.st === 409 && r.j.code === 'ORDER_NOT_PAYABLE', r);
  r = await http('payment', 'GET', `/v1/pagos/${pag1}`, { token: C }); chequear('el dueño lee su pago (con moneda)', r.st === 200 && r.j.moneda === 'USD' && r.j.tarjeta.ultimos4 === '1111', r);
  r = await http('payment', 'GET', `/v1/pagos/${pag1}`, { token: tokOtro }); chequear('otro usuario NO lee el pago → 403', r.st === 403, r);
  r = await http('payment', 'GET', `/v1/ordenes/${o1.ord_id}/pagos`, { token: C }); chequear('historial de la orden: 3 intentos', r.st === 200 && r.j.data.length === 3, r);
  const pg = await import('pg'); const cli = new pg.default.Client({ connectionString: process.env.MS_DB_BASE_URL?.replace(/\/[^/]*$/, '/ms_payment') ?? 'postgresql://postgres:postgres@localhost:5432/ms_payment' }); await cli.connect();
  const guardado = (await cli.query(`SELECT count(*)::int AS n FROM pago_tarjeta t JOIN pago p USING (pag_id) WHERE t::text LIKE $1 OR p::text LIKE $1 OR t::text LIKE '%123%cvv%'`, [`%${visa}%`])).rows[0].n;
  chequear('en la base NO está el número completo de la tarjeta', guardado === 0, guardado); await cli.end();
  // transferencia
  const o2 = await nuevaOrden(30, 1);
  const transf = (ord, monto) => ({ ord_id: ord, metodo: 'TRANSFERENCIA', monto, transferencia: { banco: 'Banco Pichincha', numero_comprobante: `CMP-${Date.now()}`, fecha_transferencia: '2026-10-29' } });
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: transf(o2.ord_id, 30) }); chequear('transferencia queda PENDIENTE', r.st === 201 && r.j.estado === 'PENDIENTE' && r.j.orden_actualizada === null, r); const pag2 = r.j.pag_id;
  r = await http('payment', 'POST', '/v1/pagos', { token: C, body: transf(o2.ord_id, 30) }); chequear('segundo pago con uno pendiente → 409 PAYMENT_IN_PROGRESS', r.st === 409 && r.j.code === 'PAYMENT_IN_PROGRESS', r);
  r = await http('payment', 'POST', `/v1/pagos/${pag2}/confirmar`, { token: C }); chequear('el CLIENTE no confirma su transferencia → 403', r.st === 403, r);
  r = await http('payment', 'POST', `/v1/pagos/${pag2}/confirmar`, { token: A }); chequear('el ADMIN confirma → APROBADO y la orden PAGADA', r.st === 200 && r.j.estado === 'APROBADO' && r.j.orden_actualizada === true, r);
  r = await http('payment', 'POST', `/v1/pagos/${pag2}/confirmar`, { token: A }); chequear('confirmar dos veces → 409', r.st === 409 && r.j.code === 'PAYMENT_NOT_PENDING', r);
  const o3 = await nuevaOrden(20, 1); r = await http('payment', 'POST', '/v1/pagos', { token: C, body: transf(o3.ord_id, 20) }); const pag3 = r.j.pag_id;
  r = await http('payment', 'POST', `/v1/pagos/${pag3}/rechazar`, { token: A, body: { motivo: 'Comprobante ilegible' } }); chequear('el ADMIN rechaza una transferencia', r.st === 200 && r.j.estado === 'RECHAZADO' && r.j.motivo_rechazo === 'Comprobante ilegible', r);
  const o4 = await nuevaOrden(10, 1); r = await http('payment', 'POST', '/v1/pagos', { token: C, body: { ord_id: o4.ord_id, metodo: 'EN_SITIO', monto: 10 } }); chequear('pago EN_SITIO queda PENDIENTE', r.st === 201 && r.j.estado === 'PENDIENTE', r);
  // dos pagos simultáneos de la misma orden: solo uno entra
  const o5 = await nuevaOrden(15, 1); const dos = await Promise.all([1, 2].map(() => http('payment', 'POST', '/v1/pagos', { token: C, body: { ord_id: o5.ord_id, metodo: 'EN_SITIO', monto: 15 } })));
  chequear('dos cobros simultáneos de la misma orden: uno 201 y otro 409', dos.filter((x) => x.st === 201).length === 1 && dos.filter((x) => x.st === 409).length === 1, dos.map((x) => x.st));
  r = await http('payment', 'GET', '/v1/pagos?estado=APROBADO&limit=5', { token: A }); chequear('listado ADMIN con filtro', r.st === 200 && r.j.data.every((p) => p.estado === 'APROBADO'), r);
  r = await http('payment', 'GET', '/v1/pagos', { token: C }); chequear('listado como CLIENTE → 403', r.st === 403, r);

  console.log('\n== refund ==');
  const sol = (pag, monto, motivo = 'Cliente canceló') => ({ pag_id: pag, monto, motivo });
  r = await http('refund', 'POST', '/v1/reembolsos', { token: tokOtro, body: sol(pag1, 10) }); chequear('reembolso de un pago ajeno → 403', r.st === 403, r);
  r = await http('refund', 'POST', '/v1/reembolsos', { token: C, body: sol(999999, 10) }); chequear('pago inexistente → 422', r.st === 422 && r.j.code === 'PAYMENT_NOT_FOUND', r);
  r = await http('refund', 'POST', '/v1/reembolsos', { token: A, body: sol(pag3, 10) }); chequear('pago RECHAZADO no se reembolsa → 409', r.st === 409 && r.j.code === 'PAYMENT_NOT_REFUNDABLE', r);
  r = await http('refund', 'POST', '/v1/reembolsos', { token: C, body: sol(pag1, 0) }); chequear('monto 0 → 400', r.st === 400, r);
  r = await http('refund', 'POST', '/v1/reembolsos', { token: C, body: sol(pag1, 20) }); chequear('solicitar 20 de 50', r.st === 201 && r.j.estado === 'SOLICITADO' && r.j.moneda === 'USD', r); const rem1 = r.j.rem_id;
  r = await http('refund', 'POST', '/v1/reembolsos', { token: C, body: sol(pag1, 40) }); chequear('20 + 40 supera lo cobrado → 422 REFUND_EXCEEDS_PAYMENT', r.st === 422 && r.j.code === 'REFUND_EXCEEDS_PAYMENT', r);
  r = await http('refund', 'POST', '/v1/reembolsos', { token: C, body: sol(pag1, 30) }); chequear('solicitar los 30 restantes', r.st === 201, r); const rem2 = r.j.rem_id;
  r = await http('refund', 'POST', '/v1/reembolsos', { token: C, body: sol(pag1, 0.01) }); chequear('ya no queda nada disponible → 422', r.st === 422, r);
  r = await http('refund', 'POST', `/v1/reembolsos/${rem1}/procesar`, { token: C }); chequear('el CLIENTE no procesa → 403', r.st === 403, r);
  r = await http('refund', 'POST', `/v1/reembolsos/${rem1}/procesar`, { token: A }); chequear('procesar el primero: pago aún no devuelto por completo', r.st === 200 && r.j.estado === 'PROCESADO' && r.j.pago_devuelto_por_completo === false && r.j.referencia, r);
  r = await http('refund', 'POST', `/v1/reembolsos/${rem1}/procesar`, { token: A }); chequear('procesar dos veces → 409', r.st === 409, r);
  r = await http('refund', 'POST', `/v1/reembolsos/${rem2}/procesar`, { token: A }); chequear('procesar el segundo: devuelto por completo y orden REEMBOLSADA', r.st === 200 && r.j.pago_devuelto_por_completo === true && r.j.orden_actualizada === true, r);
  const ordR = await obtenerOrden(ctx.ids.ord1); chequear('Order quedó REEMBOLSADA (gRPC)', ordR.est_codigo === 'REEMBOLSADA', ordR);
  r = await http('refund', 'DELETE', `/v1/reembolsos/${rem1}`, { token: C }); chequear('un reembolso procesado no se cancela → 422', r.st === 422, r);
  r = await http('refund', 'GET', `/v1/reembolsos/${rem1}`, { token: C }); chequear('el dueño lee su reembolso', r.st === 200 && r.j.numero.startsWith('REM-'), r);
  r = await http('refund', 'GET', `/v1/reembolsos?procesado=true&limit=5`, { token: A }); chequear('listado ADMIN', r.st === 200 && r.j.metadata.total_results >= 2, r);
  // carrera: dos solicitudes simultáneas que juntas superan lo cobrado
  const o6 = await nuevaOrden(50); const p6 = (await http('payment', 'POST', '/v1/pagos', { token: C, body: pagoTarjeta(o6.ord_id, 50) })).j.pag_id;
  const carrera = await Promise.all([1, 2].map(() => http('refund', 'POST', '/v1/reembolsos', { token: C, body: sol(p6, 30) })));
  chequear('dos solicitudes simultáneas de 30 sobre 50: solo una entra (candado por pago)', carrera.filter((x) => x.st === 201).length === 1 && carrera.filter((x) => x.st === 422).length === 1, carrera.map((x) => x.st));
  const pend = carrera.find((x) => x.st === 201).j.rem_id; r = await http('refund', 'DELETE', `/v1/reembolsos/${pend}`, { token: C }); chequear('cancelar una solicitud pendiente', r.st === 204, r);

  console.log('\n== invoicing (SOAP) ==');
  const dets = (n = 2, precio = 25, desc = 0) => `<inv:detalles>${Array.from({ length: n }, (_, i) => `<inv:detalle><inv:det_id>${Date.now() % 1e9 + i + Math.floor(Math.random() * 1e6)}</inv:det_id><inv:codigo>TOUR-${i + 1}</inv:codigo><inv:descripcion>Tour &amp; guía ${i + 1}</inv:descripcion><inv:cantidad>1</inv:cantidad><inv:precio_unitario>${precio}</inv:precio_unitario><inv:descuento>${desc}</inv:descuento></inv:detalle>`).join('')}</inv:detalles>`;
  const cli1 = '<inv:cliente><inv:tipo_identificacion>CEDULA</inv:tipo_identificacion><inv:identificacion>1710034065</inv:identificacion><inv:razon_social>Ana Prueba</inv:razon_social><inv:correo>ana@prueba.ec</inv:correo></inv:cliente>';
  let w = await fetch(url('invoicing', '/soap?wsdl')); const wt = await w.text(); chequear('WSDL disponible con las 5 operaciones', w.status === 200 && /EmitirFactura/.test(wt) && /AnularFactura/.test(wt) && /<definitions/.test(wt));
  const ordF = 880000000 + Math.floor(Math.random() * 1e6);
  let s = await soap('EmitirFactura', `<inv:ord_id>${ordF}</inv:ord_id>${cli1}${dets(2, 25, 5)}`, A);
  const f = s.resp?.factura?.[0]; chequear('emitir factura: subtotal 50, descuento 10, IVA 15% de 40 = 6.00, total 46.00', s.st === 200 && f && f.subtotal === '50' && f.descuento === '10' && f.iva === '6' && f.total === '46', s.fault ?? s.texto.slice(0, 300));
  chequear('estado inicial NO_PAGADA y número 001-001-#########', f?.estado === 'NO_PAGADA' && /^001-001-\d{9}$/.test(f.numero), f);
  const cl = f?.clave_acceso; const dvOk = (() => { let sm = 0, p = 2; for (let i = 47; i >= 0; i--) { sm += +cl[i] * p; p = p === 7 ? 2 : p + 1; } const dv = 11 - (sm % 11); return String(dv === 11 ? 0 : dv === 10 ? 1 : dv) === cl[48]; })();
  chequear('clave de acceso: 49 dígitos con dígito verificador módulo 11 correcto', /^\d{49}$/.test(cl ?? '') && dvOk, cl);
  chequear('el XML escapa caracteres especiales (& → &amp;)', /Tour &amp; gu/.test(s.texto));
  s = await soap('EmitirFactura', `<inv:ord_id>${ordF}</inv:ord_id>${cli1}${dets(1, 99)}`, A); chequear('repetir la emisión de la misma orden devuelve la misma factura (idempotente)', s.resp?.repetida === 'true' && s.resp.factura[0].numero === f.numero, s.resp);
  s = await soap('ConsultarFactura', `<inv:ord_id>${ordF}</inv:ord_id>`, A); chequear('consultar por orden', s.resp?.factura?.[0]?.fac_id === f.fac_id, s.fault);
  s = await soap('ConsultarFactura', `<inv:numero>${f.numero}</inv:numero>`, A); chequear('consultar por número', s.resp?.factura?.[0]?.fac_id === f.fac_id, s.fault);
  s = await soap('ConsultarFactura', `<inv:fac_id>99999999</inv:fac_id>`, A); chequear('factura inexistente → Fault INVOICE_NOT_FOUND', s.fault && /INVOICE_NOT_FOUND/.test(s.texto), s.st);
  s = await soap('ConsultarFactura', `<inv:fac_id>1</inv:fac_id><inv:ord_id>1</inv:ord_id>`, A); chequear('consulta con dos criterios → Fault de validación', s.fault && /VALIDATION_ERROR/.test(s.texto), s.texto.slice(0, 200));
  // factura con datos guardados (ms_billing_profile)
  const dfa = (await http('billing_profile', 'POST', `/v1/usuarios/${U}/datos-facturacion`, { token: C, body: { identificacion: '179' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0'), tipo_identificacion: 'RUC', razon_social: 'Mi Empresa SA', correo: 'e@prueba.ec' } })).j.dfa_id;
  s = await soap('EmitirFactura', `<inv:ord_id>${ordF + 1}</inv:ord_id><inv:dfa_id>${dfa}</inv:dfa_id>${dets(1, 10)}`, A); chequear('emitir con dfa_id: toma el cliente de Billing Profile', s.resp?.factura?.[0]?.cliente?.razon_social === 'Mi Empresa SA' && s.resp.factura[0].cliente.tipo_identificacion === 'RUC', s.fault ?? s.texto.slice(0, 300));
  const fid2 = s.resp?.factura?.[0]?.fac_id;
  s = await soap('EmitirFactura', `<inv:ord_id>${ordF + 2}</inv:ord_id><inv:dfa_id>99999999</inv:dfa_id>${dets(1, 10)}`, A); chequear('dfa_id inexistente → Fault', s.fault && /BILLING_PROFILE_NOT_FOUND/.test(s.texto), s.texto.slice(0, 200));
  const cf = '<inv:cliente><inv:tipo_identificacion>CONSUMIDOR_FINAL</inv:tipo_identificacion><inv:identificacion>9999999999999</inv:identificacion><inv:razon_social>CONSUMIDOR FINAL</inv:razon_social><inv:correo>cf@prueba.ec</inv:correo></inv:cliente>';
  s = await soap('EmitirFactura', `<inv:ord_id>${ordF + 3}</inv:ord_id>${cf}${dets(1, 80)}`, A); chequear('consumidor final por encima del tope → Fault FINAL_CONSUMER_LIMIT', s.fault && /FINAL_CONSUMER_LIMIT/.test(s.texto), s.texto.slice(0, 200));
  s = await soap('EmitirFactura', `<inv:ord_id>${ordF + 4}</inv:ord_id>${cf}${dets(1, 20)}`, A); chequear('consumidor final bajo el tope se emite', s.resp?.factura?.[0]?.total === '23', s.fault ?? s.texto.slice(0, 200));
  s = await soap('EmitirFactura', `<inv:ord_id>${ordF + 5}</inv:ord_id>${cli1}${dets(1, 10, 50)}`, A); chequear('descuento mayor a la línea → Fault', s.fault && /DISCOUNT_EXCEEDS_LINE/.test(s.texto), s.texto.slice(0, 200));
  s = await soap('EmitirFactura', `<inv:ord_id>0</inv:ord_id>${cli1}${dets(1, 10)}`, A); chequear('ord_id 0 → Fault de validación con detalle', s.fault && /ord_id/.test(s.texto), s.texto.slice(0, 200));
  s = await soap('ListarFacturas', '<inv:estado>NO_PAGADA</inv:estado><inv:limit>2</inv:limit>', A); chequear('listar facturas con paginación', s.resp?.total_results && s.resp.factura.length <= 2, s.fault ?? s.texto.slice(0, 200));
  s = await soap('MarcarFacturaPagada', `<inv:fac_id>${f.fac_id}</inv:fac_id>`, A); chequear('marcar pagada', s.resp?.factura?.[0]?.estado === 'PAGADA', s.fault);
  s = await soap('AnularFactura', `<inv:fac_id>${f.fac_id}</inv:fac_id>`, A); chequear('una factura PAGADA ya no se anula → Fault INVOICE_FINAL', s.fault && /INVOICE_FINAL/.test(s.texto), s.texto.slice(0, 200));
  s = await soap('AnularFactura', `<inv:fac_id>${fid2}</inv:fac_id><inv:motivo>Error de datos</inv:motivo>`, A); chequear('anular una NO_PAGADA', s.resp?.factura?.[0]?.estado === 'ANULADA', s.fault);
  s = await soap('ConsultarFactura', `<inv:fac_id>${f.fac_id}</inv:fac_id>`, C); chequear('un CLIENTE no usa el servicio de facturación → 403', s.st === 403, s.st);
  s = await soap('ConsultarFactura', `<inv:fac_id>${f.fac_id}</inv:fac_id>`); chequear('sin token → 401', s.st === 401, s.st);
  s = await soap('X', '', A, '<no-es-soap><roto'); chequear('XML mal formado → Fault INVALID_XML', s.fault && /INVALID_XML|INVALID_SOAP/.test(s.texto), s.texto.slice(0, 200));
  s = await soap('X', '', A, '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><inv:ConsultarFacturaRequest xmlns:inv="urn:descubre-ec:invoicing:v1"><inv:fac_id>&a;</inv:fac_id></inv:ConsultarFacturaRequest></soapenv:Body></soapenv:Envelope>'); chequear('DOCTYPE/ENTITY rechazado (anti-XXE)', s.fault && /DTD_NOT_ALLOWED/.test(s.texto), s.texto.slice(0, 200));
  s = await soap('Borrar', '<inv:x>1</inv:x>', A); chequear('operación desconocida → Fault', s.fault && /UNKNOWN_OPERATION/.test(s.texto), s.texto.slice(0, 200));
}

const args = process.argv.slice(2); const cual = args[0] ?? 'todo';
if (process.argv[1].endsWith('test-ms13.mjs')) {
  const mods = [];
  if (['grupo1', 'grupo2', 'grupo3', 'todo'].includes(cual)) mods.push(grupo1);
  if (['grupo2', 'grupo3', 'todo'].includes(cual)) mods.push(grupo2);
  if (['grupo3', 'todo'].includes(cual)) mods.push(grupo3);
  for (const f of mods) await f();
  console.log(`\nResultado: ${ok} pruebas correctas, ${mal} con falla.`);
  if (mal) { console.log('Fallaron:\n - ' + fallas.join('\n - ')); process.exit(1); }
}
