# Auditoría técnica — Atracciones Ecuador

Fecha: 2026-11-08 · Alcance: auditoría de solo lectura (no se modificó ningún archivo del proyecto) · Commit auditado: `adf516f`

## A) Resumen ejecutivo

**Veredicto: Listo con correcciones.** No hay secretos en el repositorio ni en su historial, y los últimos commits solo tocaron el front.

- **Contrato:** hay 17 rutas implementadas que el YAML no declara, entre ellas `PATCH /admin/usuarios/{id}`, que el front usa.
- **Seguridad:** la cuenta `admin@atraccionec.com` se puede desactivar o degradar por API. Un token sigue valiendo hasta 8 h después de desactivar la cuenta.
- **Descripción del proyecto:** no coincide con el repo. No hay TypeORM, los usuarios tienen ID numérico y 13 de los 16 microservicios corren en un solo proceso.
- **Pendientes:** nunca se midió Lighthouse, el bus RabbitMQ no está confirmado en producción y el despliegue real es un solo App Service.

## B) Tabla de hallazgos

| N.º | Área | Severidad | Evidencia | Problema | Recomendación |
|---|---|---|---|---|---|
| 1 | Seguridad (BFLA) | **Alta** | `backend/src/admin/admin.service.ts:327-337`; `frontend/src/pages/admin/Usuarios.jsx:87` | `patchUsuario` solo bloquea que un admin se desactive a sí mismo. Cualquier otro ADMIN puede enviar `PATCH /admin/usuarios/{id}` con `{activo:false}` o `{roles:[]}` sobre `admin@atraccionec.com`. La protección existe solo en el front. | Backend, solo si se decide: bloquear la cuenta principal. Mientras tanto, documentar el riesgo. Todos los trabajadores son ADMIN, así que cualquiera puede dejar sin acceso a la dueña. |
| 2 | Seguridad (JWT) | **Alta** | `backend/src/auth/auth.guard.ts:32-33`; `backend/src/auth/auth.service.ts:19` | El guard valida solo la firma y no consulta `usu_activo` ni los roles actuales. Un trabajador desactivado conserva acceso al panel hasta 8 h (`JWT_EXPIRES_IN`). | Documentar. Si se toca el backend: reducir la expiración o consultar el estado en cada petición. |
| 3 | Seguridad (registro) | **Alta** | `backend/src/auth/auth.service.ts:43-61`; `frontend/src/pages/admin/Usuarios.jsx:56-60` | El trabajador se crea por el registro público (`POST /auth/register`) y luego se promueve con PATCH. Cualquiera puede registrar `x.y@atraccionec.com` sin verificar el correo, para suplantar o reservar el nombre. Si el PATCH falla, queda una cuenta huérfana (el front lo avisa). | Documentar la limitación. No usar el dominio `@atraccionec.com` como señal de confianza. |
| 4 | Contrato | **Alta** | Comparación de rutas: controladores contra YAML | 17 rutas implementadas no están en el YAML: `PATCH /admin/usuarios/{id}`, `PATCH /admin/horarios/{id}`, `GET\|POST /admin/atracciones/{id}/fechas-bloqueadas`, `DELETE /admin/fechas-bloqueadas/{id}`, `PUT\|DELETE /admin/categorias/{id}`, `PUT /admin/operadores/{id}`, `GET /admin/provincias`, `GET /admin/bitacora`, `POST /admin/sync/reenviar-todo`, `GET\|POST /clientes`, `GET /atracciones/{id}/detalle-completo`, `GET /atracciones/reservas/{id}/trazabilidad` y `/evento.ics`. | Documentarlas en el YAML y en el documento de alcance, como extensión de la tienda, con versión 3.2.0 o similar. |
| 5 | Descripción del proyecto | **Alta** | `backend/package.json`; `backend/src/auth/auth.service.ts:16`; `ARQUITECTURA.md` | El brief dice NestJS + TypeORM y UUIDs. El código usa SQL a mano sobre `@neondatabase/serverless`, sin TypeORM. `usu_id` es numérico y los endpoints `/admin/*/{id}` aceptan enteros. Solo la reserva usa UUID. Los microservicios son JavaScript `.mjs`. | Corregir el brief y la presentación, o aclarar el alcance. Presentar como TypeORM/UUID lo que no lo es es un riesgo en la defensa. |
| 6 | Arquitectura | **Alta** | `ARQUITECTURA.md` §2 | Los 16 microservicios, el backend y la web corren en un solo contenedor y un solo App Service B1. 13 servicios comparten un proceso (hub). Hay puntos únicos de falla: el App Service, la base Neon del backend y `_shared`. | Declararlo en la entrega. El documento ya lo admite. |
| 7 | Secretos / config | **Media** | `backend/src/config.ts:14`; `backend/src/main.ts:16` | `JWT_SECRET` tiene un valor por defecto conocido. El arranque solo se detiene si `NODE_ENV=production`. NO VERIFICADO que Azure defina `NODE_ENV`. | Confirmar `NODE_ENV=production` y un `JWT_SECRET` largo en Azure. |
| 8 | Seguridad (CORS) | **Media** | `backend/src/config.ts:25`; `backend/src/main.ts:48` | `CORS_ORIGINS` vale `*` por defecto, que refleja cualquier origen. Mitigado porque el front se sirve desde el mismo origen. | Fijar `CORS_ORIGINS` en Azure. |
| 9 | Seguridad (cabeceras) | **Media** | `backend/src/main.ts:39` | Solo hay `nosniff` y `Referrer-Policy`. No hay CSP, HSTS, X-Frame-Options ni helmet. | Añadir cabeceras en Azure o en el front. |
| 10 | Seguridad (rate limit) | **Media** | `backend/src/gateway/rate-limit.ts:11`; `backend/src/auth/auth.service.ts:9` | El límite de peticiones y el freno de fuerza bruta están en memoria. Se reinician con cada despliegue y no se comparten entre instancias. Con `trust proxy` en `true`, la IP depende de `X-Forwarded-For`. | Aceptable con una instancia. Documentar la limitación. |
| 11 | Seguridad (validación) | **Media** | `backend/src/admin/admin.controller.ts:22-63`; `backend/src/admin/admin.service.ts:334` | Los cuerpos llegan como `any` y se validan a mano. `roles` acepta cualquier cadena. Si el rol no existe, el `INSERT … SELECT` no inserta nada y deja al usuario sin roles sin avisar. | Validar la lista de roles permitidos. |
| 12 | Seguridad (BOLA) | **Baja** | `backend/src/reservas/reservas.service.ts:177-178`; `backend/src/reservas/reservas.controller.ts:24-25` | El cliente solo accede a su reserva (compara el correo del token con el del titular), lo cual es correcto. Excepción: `GET …/{id}/evento.ics` no pide token y usa el UUID como capacidad, lo que está documentado. | Aceptable. Declarar la excepción en el contrato. |
| 13 | Contraseña de trabajadores | **Media** | `frontend/src/pages/admin/Usuarios.jsx:20-27` y `:96` | La contraseña se genera en el navegador con `crypto.getRandomValues` (14 caracteres), viaja por HTTPS, se guarda con bcrypt de costo 10 y se muestra una sola vez. El admin la copia al portapapeles y la entrega manualmente. No hay forma de restablecerla y no se fuerza el cambio en el primer ingreso. No aparece en `localStorage` ni en logs (la bitácora omite el cuerpo). | Añadir cambio obligatorio en el primer ingreso, o aceptar y documentar el riesgo. |
| 14 | Front / mensajes | **Baja** | `frontend/src/pages/admin/Usuarios.jsx:41` | El texto dice «Solo el Administrador del Sistema puede gestionar usuarios». El backend permite a cualquier ADMIN, así que el 403 casi nunca ocurre y el mensaje es engañoso. | Corregir el texto o la regla. |
| 15 | Front / sesión | **Media** | `frontend/src/api.js:6-8` | El JWT y el usuario van en `sessionStorage`, no en `localStorage`. Es mejor, pero cualquier XSS lo leería. No hay CSP (ver hallazgo 9). | Añadir CSP. |
| 16 | Bus RabbitMQ | **Media** | `backend/src/bus/amqp.service.ts:66-98`; `backend/src/config.ts:57` | Existen backoff exponencial, DLQ y `x-correlation-id`. `AMQP_URL` solo se define en Azure. NO VERIFICADO si está conectado en producción: el propio documento dice que se observó desconectado y sin prueba automática. No verifiqué que el consumidor sea idempotente. | Configurar CloudAMQP y correr `npm run smoke:bus`. |
| 17 | Integración stock | **Media** | `backend/src/config.ts:40-49` | El modo por defecto es gRPC (`BOOKING_STOCK_MODE=grpc`). El brief dice que se envía por HTTP. NO VERIFICADO el modo real en Azure. | Confirmar `BOOKING_STOCK_MODE=rest` en producción. |
| 18 | Integridad del backend | **Media** | `git log`, `git diff --stat f6a4b0e adf516f`; carpeta `_to_delete/respaldo-backend-antes-roles-…` | Entre el primer commit y HEAD solo cambiaron 4 archivos del front, y `backend/` está limpio. Pero el historial son 3 commits, el primero con 290 archivos, así que no hay línea base del backend «aprobado». La carpeta de respaldo `…antes-roles` sugiere que el backend cambió antes del primer commit. | Comparar manualmente con la versión que aprobó el líder. |
| 19 | Contrato / calidad | **Baja** | Salida de `backend/scripts/check-contract.mjs` | El YAML es válido: OpenAPI 3.0.3, 34 rutas, 41 esquemas, 0 `$ref` rotos. Pero verificó «0 ejemplos de esquema», y el documento de alcance no menciona `PATCH /admin/usuarios`. | Ampliar los ejemplos. |
| 20 | REST | **Baja** | `backend/src/main.ts:41-47`; `backend/src/common/problem.ts:15` | Hay versionado `/api/v3` y errores RFC 7807 uniformes. Pero `/api/v1` y `/api/v2` redirigen a v3, y los tipos de error apuntan a `booking.epn.edu.ec`, un dominio ajeno. `PATCH /admin/usuarios` devuelve `{ok:true}`, no el recurso. Los listados de categorías, provincias, operadores y guías no se pudieron verificar como paginados. | Revisar la paginación de esos listados. |
| 21 | Roles | **Baja** | `backend/src/auth/auth.guard.ts:11`; `backend/src/reservas/reservas.controller.ts:40` | El backend sigue usando el rol `OPERADOR`, aunque el brief dice que no hay cajero. Es inofensivo, pero está en el código. | Documentar. |
| 22 | Repositorio | **Baja** | `.gitignore`; `git status --ignored` | `_to_delete/` (18 MB), `deploy.zip` (21 MB), `azure-settings.json`, `.env` y los `node_modules` están ignorados y no están en git. `portada.jpg` pesa 1 MB, lo que afecta al LCP. | Borrar `_to_delete` antes de entregar y comprimir la portada. |
| 23 | Documentación | **Baja** | `README.md` | El README no lista las variables de entorno y remite a los `.env.example`. No documenta que el front se despliega empaquetado dentro del backend, aunque sí el comando de despliegue. | Enlazar `.env.example` y explicar el empaquetado. |
| 24 | Observabilidad | **Baja** | `backend/src/main.ts:27-37`; `backend/src/common/problem.ts:53` | Hay una bitácora HTTP con latencia y correlation id, y no registra el cuerpo ni los valores de la query. Los errores 5xx imprimen el `stack` en la consola. No hay métricas ni alertas. | Aceptable para este alcance. |

## C) Bloqueantes antes de subir a GitHub o entregar

No hay secretos que bloqueen la subida. Lo que debes corregir:

1. Decidir sobre los hallazgos 1 y 2 (cuenta principal y tokens que siguen vigentes). Como no se toca el backend, al menos documéntalos como riesgo aceptado.
2. Actualizar el YAML y el documento de alcance con las 17 rutas faltantes (hallazgo 4).
3. Corregir el brief y la presentación: no hay TypeORM, el ID de usuario es numérico y el despliegue es monolítico (hallazgos 5 y 6).
4. Confirmar en Azure `NODE_ENV=production`, un `JWT_SECRET` propio, `CORS_ORIGINS` y `BOOKING_STOCK_MODE` (hallazgos 7, 8 y 17).
5. Borrar o dejar fuera del repositorio `_to_delete/` (ya está en `.gitignore`).

## D) Lo que está bien hecho

- Cero credenciales reales en el árbol y en los 3 commits. Los patrones de Neon, `npg_`, AMQP, `AccountKey`, llaves privadas y JWT no dieron resultados.
- `.gitignore` correcto y `.env.example` sin valores reales. Los `.env` y `azure-settings.json` locales están ignorados.
- Las contraseñas usan bcrypt, y el login compara en tiempo constante aunque el usuario no exista.
- El registro público siempre asigna el rol CLIENTE. Un login fallido devuelve el mismo mensaje y hay freno tras 5 intentos.
- Errores en formato RFC 7807 con correlation id y sin trazas en la respuesta.
- Hay paginación (`metadata`) en los listados de usuarios, reservas y atracciones.
- Los 16 microservicios existen, y cada uno tiene `db/schema.sql`, `.env.example` y esquemas de petición. Los 3 servicios gRPC tienen `proto/`.
- Las rutas `/admin` están protegidas con `@Roles('ADMIN')` en el backend y con `Protegida` en el front.
- Estilo del front: fondo verde azulado con menta, portada con foto, sin carrusel y pie con «Alisson Basantes» a la izquierda.
- El historial de commits es coherente: `feat` y `fix`, con alcance.

## E) Lo que no se pudo verificar

| Tema | Qué se necesita |
|---|---|
| Lighthouse (LCP, INP, CLS) | Ejecutarlo contra la URL de Azure o contra `npm run build` y `preview`. No hay Lighthouse instalado ni entorno de navegador. |
| Pruebas e2e (`test:e2e`, `test:bus`) | Una base PostgreSQL local. No se ejecutaron. |
| Variables reales en Azure (`NODE_ENV`, `JWT_SECRET`, `AMQP_URL`, `BOOKING_STOCK_MODE`) | Acceso a la configuración de la App Service. Solo se vio que `azure-settings.json` contiene al menos una de las claves `AMQP_URL`, `CORS_ORIGINS` o `JWT_SECRET`. |
| Estado del bus y del registro del nodo en producción | Llamar a `/api/v3/health` y revisar la consola de CloudAMQP. |
| Idempotencia del consumidor del bus | Revisar `backend/src/bus/bus-handlers.service.ts` y correr `test:bus`. |
| Backend idéntico al aprobado | La versión que aprobó el líder, para compararla con `diff`. |
| Paginación de categorías, operadores y guías | Revisión de cada listado. |
| Accesibilidad y contraste en la vista | Navegador. Se vieron `label`, `alt` y `lang="es"` en el código, pero no se midió el contraste. |
| Cada microservicio en ejecución (health, cortacircuitos) | Levantar el hub. Solo se comprobó que existen los archivos. |

## F) Checklist final de entrega

- [ ] Rutas faltantes añadidas al YAML y al documento de alcance
- [ ] Riesgo de la cuenta `admin@atraccionec.com` y de los JWT de 8 h documentado
- [ ] Brief corregido (sin TypeORM, ID numérico, despliegue monolítico)
- [ ] `NODE_ENV=production`, `JWT_SECRET` propio y `CORS_ORIGINS` fijados en Azure
- [ ] `BOOKING_STOCK_MODE` confirmado y registro del nodo `NODE_ATR_ALISSON` comprobado
- [ ] CloudAMQP conectado y `smoke:bus` ejecutado
- [ ] Lighthouse medido y portada comprimida
- [ ] `_to_delete/` borrada o fuera del repositorio
- [ ] README con variables de entorno y explicación del empaquetado
- [ ] Cambio obligatorio de la contraseña en el primer ingreso, o riesgo aceptado
- [ ] Revisión final de `git status` antes del push
