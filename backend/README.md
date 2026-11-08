# Atracciones Ecuador — Backend (tienda individual para Booking Prototipo)

Tienda de atracciones turísticas **solo de ciudades con aeropuerto de Ecuador**. Reto 2 (RDA2), Integración de Sistemas, PUCE.
Backend NestJS 12 + PostgreSQL (Neon). REST v3 (contrato OpenAPI) + gRPC (contrato `inventory.proto`).

## 1. Puesta en marcha (paso a paso)

```bash
cd backend
npm install
cp .env.example .env        # en Windows: copy .env.example .env   → luego edite .env
```

**Base de datos en Neon (gratis, sin tarjeta):**
1. Cree un proyecto en <https://console.neon.tech> → botón **Connect** → copie la *connection string* (termina en `?sslmode=require`).
2. Péguela en `DATABASE_URL` dentro de `.env`. No la comparta ni la suba a Git (`.gitignore` ya excluye `.env`).
3. Complete también `JWT_SECRET`, `BOOKING_API_KEYS`, `ADMIN_EMAIL` y `ADMIN_PASSWORD` (instrucciones dentro de `.env.example`).

```bash
npm run db:migrate    # crea las tablas (3FN)
npm run db:seed       # catálogos, 13 ciudades con aeropuerto, 5 atracciones de ejemplo y el usuario administrador
npm run build
npm start             # http://localhost:3000   ·   Swagger: http://localhost:3000/api/docs
```
> `npm run db:reset` **borra todo** y vuelve a crear. Úselo solo en desarrollo.

**Docker** (lo que pide la guía para integrar con Booking):
```bash
docker compose up --build -d api                 # API con su BD de Neon (.env)
docker compose --profile local up --build        # TODO local: Postgres + Booking simulado (para probar sin nadie más)
```
Si Booking corre en su propio Docker/host, ponga `BOOKING_GRPC_TARGET=host.docker.internal:50051` (Windows/Mac) o la IP/host que le indique el líder.

## 2. Pruebas
```bash
npm run build && npm run test:e2e     # 47 pruebas: REST, contrato (ajv), concurrencia, idempotencia, Outbox y gRPC contra un Booking simulado
npm run check:contract                # el YAML carga, los $ref resuelven
npm run mock:booking                  # Booking simulado en :50051 para probar a mano
```
Las pruebas **reinician la BD**: se niegan a correr si `DATABASE_URL` no es local (usen una BD de pruebas, no la de Neon con datos reales).

## 3. Integración con Booking

| Sentido | Protocolo | Qué ocurre |
|---|---|---|
| Tienda → Booking | **gRPC** (HTTP/2, `:50051`) | `PushStockUpdate` tras cada venta/cancelación/cambio de aforo; `GetSlotAvailability` + `StreamInventoryChanges` para conciliar (`POST /admin/sync/conciliar`) |
| Booking → Tienda | **REST** `POST {baseUrlRest}/reservas` | Cabeceras `Idempotency-Key` y `X-Correlation-Id`; responde `201` o `409 OUT_OF_STOCK` (RFC 7807) |

* `baseUrlRest` válido: `https://SU-HOST/api/v3/atracciones` (también responden `/api/v3/reservas` y `/reservas`; `/api/v1` y `/api/v2` redirigen a v3).
* Autenticación de Booking: cabecera `X-API-Key` con una de las claves de `BOOKING_API_KEYS` (acordar con el líder).
* `GET /api/v3/atracciones/health` alimenta el semáforo (UP < 200 ms, DEGRADED 200–800 ms, DOWN → 503).
* Los cambios de aforo se guardan en la tabla `outbox_evento` **dentro de la misma transacción** que la venta; un despachador los envía por gRPC con reintentos. Si Booking está caído, la venta no se pierde ni se bloquea y el evento se entrega al volver (probado).

## 4. Endpoints principales (contrato en `contracts/atracciones-openapi-v3.yaml`, v3.1.0)
Público: `GET /atracciones`, `POST /atracciones/search`, `GET /atracciones/{id}`, `GET /atracciones/{id}/disponibilidad?date=`, `GET /atracciones/categorias[/arbol]`, `GET /atracciones/health`.
Con credencial: `POST /atracciones/reservas`, `GET /atracciones/reservas/{id}`, `POST .../cancel`, `POST .../checkin`, `GET|PUT /atracciones/promociones/contrato`, `GET /atracciones/eventos`.
Extensión de la tienda: `POST /auth/login|register`, `GET /auth/me`, `/admin/**` (rol ADMIN). **Todo listado es paginado** (`page`, `limit`; respuesta con `metadata`).

## 5. Qué se corrigió respecto a los archivos entregados
Ver `db/migrations/001_modelo_relacional.sql` (cabecera con los 12 cambios de normalización 3FN) y la sección «Hallazgos» del informe de entrega. Resumen: el YAML original no carga por claves duplicadas; el `.proto` embebido en el YAML estaba desactualizado; `slot_id` no es único entre atracciones; las cédulas de ejemplo no pasan módulo 10.

## 6. Conceptos del curso aplicados
| Concepto (semana) | Dónde está |
|---|---|
| OpenAPI, Swagger UI, rutas versionadas `/v1 /v2` (S2) | `contracts/*.yaml`, `/api/docs`, redirección v1/v2→v3 |
| Schema-first y validación en ejecución con **ajv**; SemVer de contratos (S7) | `src/contract/contract.service.ts` valida el cuerpo contra los esquemas del propio YAML; el contrato pasó de 3.0.0 a 3.1.0 (MINOR) sin romper campos |
| Idempotencia y *Idempotent Consumer*; *Correlation Identifier* (S1, S5) | tabla `idempotencia`, `X-Correlation-Id` en toda respuesta y evento |
| **Outbox**, Retry/Backoff (S1) | `outbox_evento`, `src/grpc/grpc-inventory.service.ts` |
| **Saga**: Booking orquesta, la tienda aporta la compensación (S6) | `POST /reservas/{id}/cancel` con reintegro de cupos y reembolso; `409 OUT_OF_STOCK` como único disparador |
| Integración híbrida síncrona/asíncrona (S1) | REST para compras + gRPC/eventos para inventario |
| Ley de Postel | `reservas.normalize.ts` acepta alias en español y el payload abreviado de Booking |
