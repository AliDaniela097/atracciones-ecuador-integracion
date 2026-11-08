# Atracciones Ecuador — arquitectura, aislamiento de fallos y cumplimiento (Semanas 1, 2, 7 y 8)

Alisson Basantes · nodo `NODE_ATR_ALISSON` (Booking Prototipo). Este documento dice **qué se cumple, qué no y con qué evidencia**. Lo que no está probado está marcado.

## 1. Estructura de carpetas (cada pieza en su carpeta, con su contrato)

```
Proyecto_Atracciones_Web/
├─ backend/          API pública v3 (NestJS): contrato de Booking, reservas, admin, bus, gRPC saliente
│  ├─ contracts/     OpenAPI v3.1 + inventory.proto (fuente de verdad del contrato público)
│  └─ src/gateway/   Gateway (Semana 8): rate-limit, proxy a microservicios  ← aggregator en catalog/
├─ microservicios/   16 servicios, cada uno con SU carpeta, SU base de datos y SU contrato
│  ├─ ms_*/          src/ · db/ · schemas/requests.json · (proto/ en los gRPC)
│  └─ _shared/       código común (núcleo compartido: ver riesgos)
├─ frontend/         React + Vite (se compila y se sirve desde backend/public)
├─ contratos/        Semana 7: índice, verificador de compatibilidad, referencia (baseline/), pruebas
├─ gateway/          Semana 8: README de cumplimiento + kong.yml de referencia (no desplegado)
├─ deploy/           Empaquetado y arranque para Azure
└─ _to_delete/       respaldos y zips ya aplicados (borrar antes de subir a GitHub)
```
Qué dicen las semanas 1 y 2 sobre estructura: no prescriben un árbol de carpetas; piden **servicios autónomos, desplegables por separado, con su propia base de datos** (S1), **un OpenAPI/contrato independiente por microservicio** y versionado por servicio (S2.4). La estructura de arriba sigue esos criterios a nivel de código. La S7 pide el contrato como artefacto versionado e independiente del código del servicio, y la S8 el Gateway como punto de entrada que no contiene lógica de negocio.

## 2. Qué se cae cuando algo se cae (verificado donde dice "probado")

| Si se cae… | Qué pasa | Evidencia |
|---|---|---|
| Un microservicio gRPC (`ms_booking`, `ms_order`, `ms_inventory`) | La tienda **sigue vendiendo**: la reserva se confirma en la base de la tienda y queda marcada `degradado`; la bitácora registra WARN; un cortacircuitos (15 s) evita esperar 8 s por reserva; al volver, se retoma el flujo completo. Los errores de negocio (sin cupo → 409) **no** se ocultan. | **Probado**: `npm run test:resiliencia` (9 pruebas). El modo estricto anterior (503) sigue disponible con `MS_DEGRADE_ON_FAILURE=false` y probado en `npm run test:ms`. |
| Los 3 a la vez | Catálogo, health y reservas siguen respondiendo. | **Probado** (misma prueba). |
| Un microservicio REST del hub | El hub lo reinicia solo con espera creciente, sin afectar a los otros 12 (`scripts/start-hub.mjs`). El Aggregator responde con esa parte en `null`. | Revisión de código; **no probado por separado**. |
| Booking (destino) | El Outbox acumula los avisos de stock y los entrega en orden al volver. | **Probado** (`test:e2e`, 52 pruebas). |
| RabbitMQ / el bus | La API REST sigue funcionando (el bus no está en el camino de las peticiones); `health.bus` lo informa. | Se observó en producción con el bus desconectado; **sin prueba automática**. |
| **El backend** | **Se cae la API, el Gateway, la web (se sirve desde el backend) y el panel.** Los microservicios siguen vivos pero nadie los alcanza. | Diseño actual. |
| **La base Neon del backend** | La API deja de funcionar (`/health` → 503). | Diseño actual. |
| **El App Service** | **Se cae todo**: backend, 13+3 microservicios, web. | Diseño actual. |

### Lo que sigue siendo un monolito (dicho sin adornos)
- **Despliegue:** los 16 microservicios, el backend y la web corren en **un solo contenedor** (`deploy/azure-start.mjs`) de un solo App Service B1. Las carpetas son independientes; **el despliegue no lo es**. Es la causa de "si cae uno, cae todo" en la última fila de la tabla.
- Los 13 microservicios nuevos comparten **un proceso** (hub) para ahorrar memoria: una falla de memoria del proceso los tumba juntos.
- `microservicios/_shared` es un núcleo común: un error ahí afecta a los 16.
- El backend concentra el contrato completo de Booking y la lógica de reservas (monolito modular).

### Cómo se separaría de verdad (fase 2, **no hecha**; recomendada después de la auditoría)
1. Web estática en un hosting aparte (si cae la API, la página igual abre y avisa).
2. Backend, hub y los 3 gRPC en App Services distintos (el plan B1 admite varias apps; comparten CPU/RAM, pero se despliegan y reinician por separado). **Pendiente de verificar:** gRPC entre App Services requiere HTTP/2 y su soporte en Linux; no se probó.
3. Una base por servicio ya existe; falta separar la del backend si se divide más.
No se hizo antes de la auditoría porque cambia URLs, secretos y red, y un error ahí tumba la demostración.

## 3. Cumplimiento por semana

| Semana | Requisito | Estado | Evidencia / límite |
|---|---|---|---|
| 1 | Microservicios autónomos, BD propia | Cumple en código | `microservicios/ms_*/db`; despliegue conjunto (ver §2) |
| 1 | Correlation-ID, logs estructurados, observabilidad | Cumple | `X-Correlation-Id` de punta a punta; pantalla y `GET /api/v3/admin/bitacora`; health con BD y bus |
| 1 | Outbox, idempotencia, DLQ, reintentos | Cumple | Outbox + `Idempotency-Key` + DLQ del bus (probado en `test:e2e`/`test:bus`) |
| 1 | Circuit breaker (patrón complementario) | Parcial | Cortacircuitos simple hacia los microservicios (nuevo); no hay en otras llamadas |
| 2 | URIs en plural, verbos, códigos, errores uniformes, `/v3` | Cumple | OpenAPI de Booking; errores RFC 7807 |
| 2 | Paginación y filtros | Cumple | catálogo y reservas |
| 2 | HATEOAS | Parcial | Solo la reserva trae `_links` (self, checkin, cancel); el resto de recursos no |
| 2 | Cabeceras Deprecation/Sunset | **No** | No implementadas |
| 2 | Swagger/Redoc | Parcial | `/api/docs` (Swagger); sin Redoc |
| 7 | Contrato por microservicio, versionado SemVer | Cumple | `contratos/README.md` (los 12 code-first se exportan automáticamente) |
| 7 | JSON Schema + Ajv en ejecución | Cumple | `backend/src/contract`, `microservicios/_shared/validate.mjs` |
| 7 | Verificador BACKWARD + chequeo en CI | Cumple (CI sin ejecutar en GitHub) | `contratos/check-compat.mjs`, 19 pruebas; heurística (sin `$ref`/`oneOf`) |
| 7 | Contrato en repositorio independiente | **Parcial** | Carpeta aparte dentro del mismo repositorio, no repositorio propio |
| 7 | Contract testing (Pact) | **No** | Es de la Semana 9 |
| 8 | Proxy, Aggregator, correlation-id, rate-limit diferenciado | Cumple | `gateway/README.md` |
| 8 | Gateway dedicado (Kong/Nginx) | **No** | Solo `kong.yml` de referencia, sin probar |
| 8 | BFF, caching, canary/blue-green | **No** | Ver `gateway/README.md` |
| 8 | Service Mesh | No, a propósito | Justificado por tamaño (tabla 3b del libro) |
| 8 | Gateway sin lógica de negocio | Cumple | Revisado en `backend/src/gateway/` |

## 4. Cómo comprobarlo
```
cd backend && npm run build
npm run test:resiliencia     # aislamiento de fallos (9)         — requiere Postgres local
npm run test:ms              # modo estricto (7)                  — requiere Postgres local
npm run test:e2e             # contrato completo (52)             — requiere Postgres local
npm run test:bus             # bus (13)
cd .. && node contratos/test-compat.mjs && node contratos/check-compat.mjs
```
