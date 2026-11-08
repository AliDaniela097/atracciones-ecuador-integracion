# Microservicios de Alisson — `ms_inventory`, `ms_order`, `ms_booking`

Tres microservicios **gRPC** del proyecto Descubre EC / Atracciones. Cada uno tiene **su propio contrato (`.proto`)**, **su propia base de datos**
(database-per-service) y **sus propias pruebas de esquemas**. Las tablas son las del script del equipo
(`02_microservicios_v2_bases_de_datos.sql`), copiadas **sin cambiar nombres ni columnas**, para que la integración con el resto del equipo funcione.

| Microservicio | Qué hace | Tablas (su base) | Puerto | Contrato |
|---|---|---|---|---|
| `ms_inventory` | Horarios, cupos por fecha, días bloqueados; reserva/libera cupos; **avisa el stock a Booking** | `horario`, `disponibilidad`, `fecha_bloqueada` | 50061 | `ms_inventory/proto/ms_inventory.proto` |
| `ms_order` | Órdenes, líneas, cupones aplicados, idempotencia | `estado`, `orden`, `orden_detalle`, `orden_cupon`, `idempotencia` | 50062 | `ms_order/proto/ms_order.proto` |
| `ms_booking` | Reservas y pasajeros | `estado`, `reserva`, `reserva_pasajero` | 50063 | `ms_booking/proto/ms_booking.proto` |

## Dónde encaja cada contrato (según el líder del Booking)

```
 Booking ──REST (atracciones-openapi-v3.yaml)──► API Gateway / backend público  ──gRPC──► ms_order · ms_booking · ms_inventory
                                                     (carpeta ../backend)                       │
 Booking ◄──gRPC (inventory.proto: PushStockUpdate)──────────────────────────────────────────── ms_inventory (cliente gRPC)
```

* **`inventory.proto` (de Booking)** lo usa `ms_inventory` como **cliente**: cada vez que se reserva, libera, genera o bloquea un cupo, envía `PushStockUpdate`.
  Correspondencia: `item_id` ← `atr_id` · `date` ← `dis_fecha` · `available_units` ← `dis_cupo_total - dis_cupo_reservado` (0 si el turno está cerrado) · `slot_id` ← `slot-YYYYMMDD-HHMM`.
* **`atracciones-openapi-v3.yaml` (REST)** lo implementa el API Gateway (su backend de `../backend`). Booking nunca habla directo con estos microservicios.

## Pasos para ejecutarlo (Windows, VS Code)

1. **Neon: crear 3 bases** en el mismo proyecto (Neon → su proyecto → *Branches* → *Databases* → **New database**): `ms_inventory`, `ms_order`, `ms_booking`.
   Para cada una copie su *connection string* (Connect → elija la base → sin *Connection pooling* → termina en `?sslmode=require`).
2. En VS Code abra **esta carpeta** (`microservicios`) y en la terminal: `npm install` (una sola vez; instala los tres).
3. En **cada** carpeta `ms_*` copie `.env.example` a `.env` (`Copy-Item ms_inventory\.env.example ms_inventory\.env`, y lo mismo con `ms_order` y `ms_booking`)
   y pegue en `DATABASE_URL` la cadena de **esa** base. **Nunca suba `.env` a Git** (ya está en `.gitignore`).
4. `npm run db:migrate` — crea las tablas en las tres bases (si una base no existe intenta crearla).
5. `npm run test:schemas` — pruebas de esquemas de los tres (**hágalas antes de integrar**, como pidió Gloria).
6. Arrancar: en una terminal `npm run mock:booking` (Booking simulado, opcional) y en otra `npm run start:all`.
   Con el Booking real: en `ms_inventory/.env` ponga `BOOKING_GRPC_TARGET=rda1-backend-integracion-sistemas.onrender.com:50051` y `BOOKING_GRPC_TLS=true`
   (según la guía; si falla, revise `GetSyncStatus` → `last_error` y pregunte al líder si el puerto/TLS es otro).
7. Probar a mano (con el servidor corriendo):
   ```
   node scripts/cliente.mjs inventory CreateHorario "{\"atr_id\":1001,\"hor_hora\":\"09:00\",\"hor_cupo\":10}"
   node scripts/cliente.mjs inventory GenerateAvailability "{\"atr_id\":1001,\"fecha_desde\":\"2026-11-10\",\"fecha_hasta\":\"2026-11-12\"}"
   node scripts/cliente.mjs inventory ListAvailability "{\"atr_id\":1001,\"limit\":5}"
   node scripts/cliente.mjs inventory GetSyncStatus "{}"
   ```
   Si PowerShell se queja de las comillas, guarde el JSON en un archivo y use `@`: `node scripts/cliente.mjs inventory CreateHorario @horario.json`.
7b. **Demo para presentar** (con los 3 servicios arrancados): `npm run demo`. Muestra una compra feliz, la falta de cupo (`OUT_OF_STOCK`) y la compensación de la Saga. Las líneas con ✖ son fallos **provocados a propósito** para mostrar cómo reacciona el sistema. Crea un turno nuevo en cada corrida (atracción de demo 9001).
8. Prueba completa (**solo con Postgres local**, borra las bases `ms_*` del servidor local): `npm run e2e` (54 pruebas: unitarias de cada servicio, la Saga con compensación,
   12 compradores simultáneos y Booking caído/reconectado). Si no tiene Postgres local: `docker run --name pg-e2e -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16`.
   El script se niega a correr contra una base remota (Neon) para no borrarla.

## Cómo se aplicó la semana 7 (el contrato manda)

| Idea de la clase | Dónde está |
|---|---|
| Un contrato por microservicio | Un `.proto` por servicio (`proto/`) + un JSON Schema por servicio (`schemas/requests.json`) |
| gRPC: sin `.proto` no hay nada | El servidor y los clientes se **construyen desde el `.proto`** (`@grpc/proto-loader`); ningún mensaje se define a mano en el código |
| Verificación de tipos de gRPC | El `.proto` fija los tipos. **OJO:** se cargan al ejecutar (no hay compilación con `protoc`), así que la verificación ocurre al iniciar/serializar, no en tiempo de compilación de TypeScript |
| JSON Schema + AJV en ejecución | Toda petición se valida con **AJV** contra `schemas/requests.json` (rangos, patrones, formatos, `oneOf`); el error sale con `invalid_params` (equivalente al RFC 7807 del REST) |
| Pruebas de esquemas (script con AJV, no la IA) | `npm run test:schemas`: casos válidos **y** inválidos por esquema (`schemas/casos.json`), campos del esquema **idénticos** a los del `.proto` (detecta desincronización) e ida y vuelta de serialización |
| Versionamiento (SemVer) | `v1.0.0` en la cabecera de cada `.proto` y de cada esquema. Agregar campo opcional = MINOR; quitar/cambiar tipo = MAJOR |
| QA / contract testing | `npm run e2e`. **No** se usó Pact |

## Errores (formato común)

Todo error gRPC lleva `details` = JSON `{ "code", "message", "invalid_params": [{ "name", "reason" }] }`.
`OUT_OF_STOCK` **no** es un error gRPC: `ReserveSlots` responde `success=false, error_code=OUT_OF_STOCK` (es el disparador de la compensación de la Saga).
Los demás: `VALIDATION_ERROR` (INVALID_ARGUMENT), `*_NOT_FOUND` (NOT_FOUND), `INVALID_TRANSITION` (FAILED_PRECONDITION), `IDEMPOTENCY_KEY_REUSED` / `*_ALREADY_EXISTS` (ALREADY_EXISTS).

## Saga de compra (orquestada por el gateway)

`ReserveSlots` (inventory) → `CreateOrder` (order) → `CreateReservation` (booking) → pago → `UpdateOrderStatus PAGADA` + `ConfirmReservation`.
Si un paso falla se compensa en orden inverso: `UpdateOrderStatus CANCELADA` y `ReleaseSlots`. Está probada en `scripts/e2e.mjs` (escenarios A–D).
**Pendiente:** conectar el gateway (`../backend`) para que `POST /reservas` llame a estos servicios; hoy el backend sigue usando su propia base.

## Supuestos y límites (léalos antes de presentar)

* **Inconsistencia en la base del equipo:** `estado.est_final = TRUE` para `PAGADA` en `ms_order`, pero una orden pagada debe poder pasar a `REEMBOLSADA` (lo hace `ms_refund`).
  Implementé `CREADA→PAGADA|CANCELADA` y `PAGADA→REEMBOLSADA`. Confirmar con Gloria.
* `ms_order` **no calcula** descuento ni IVA: los recibe de quien llama (Coupon/Pricing) y verifica `total = subtotal - descuento + iva`, como exige la base.
* `ms_booking` guarda **un solo precio unitario** (así es la tabla): `res_subtotal = precio × (adultos + niños)`. Si niños y adultos tienen precio distinto, el gateway debe usar el promedio o la base debe cambiar.
* `ms_booking` permite **una reserva activa por `det_id`** (regla que deduje del modelo; la base no la impone con UNIQUE).
* `ms_booking` valida el documento con el patrón del dominio `dom_documento` (10 dígitos o pasaporte); **no** aplica el módulo 10 de la cédula (sí lo hace el backend REST).
* Los reintentos de `ms_inventory` hacia Booking viven **en memoria** (hasta 40 intentos cada `GRPC_RETRY_MS`); si el servicio se reinicia mientras Booking está caído, un cupo cambiado se reenvía con `SyncToBooking`. El backend REST sí usa un Outbox persistente.
* La **autenticación entre servicios** (JWT/mTLS) no está implementada: los puertos gRPC están en claro y solo deben usarse en red local o detrás del gateway.
* Los `.proto` de `ms_order` y `ms_booking` son **propuesta mía** a partir de las tablas; no vienen del equipo del Booking. Deben acordarse con el resto del equipo.

---

# Los 13 microservicios nuevos (arquitectura de 16 servicios)

Para completar los **16 microservicios** de la arquitectura del equipo (`02_microservicios_v2_bases_de_datos.sql`), además de `ms_inventory`, `ms_order` y `ms_booking` (gRPC) se implementaron:

| # | Servicio | Protocolo | Puerto* | Base de datos | Qué hace |
|---|---|---|---|---|---|
| 1 | `ms_identity` | REST | 50101 | `ms_identity` | Registro, login (token de sesión), verificación de correo, recuperación de clave, roles ADMIN/OPERADOR/CLIENTE |
| 2 | `ms_billing_profile` | REST | 50102 | `ms_billing_profile` | Datos de facturación del cliente (cédula/RUC/pasaporte/consumidor final), uno principal |
| 3 | `ms_location` | REST | 50103 | `ms_location` | Regiones, 24 provincias y ciudades (catálogo) |
| 4 | `ms_catalog` | REST | 50104 | `ms_catalog` | Atracciones, categorías en árbol, idiomas, inclusiones, fotos, operadores; consume `RESENA_PUBLICADA` |
| 5 | `ms_review` | REST | 50105 | `ms_review` | Reseñas 1–5; publica `RESENA_PUBLICADA` / `RESENA_RETIRADA` |
| 6 | `ms_pricing` | **gRPC** | 50112 | `ms_pricing` | Tarifas versionadas por fecha y cotización (`CalculatePrice`) |
| 8 | `ms_cart` | REST | 50106 | `ms_cart` | Carrito activo por usuario; consulta precios a Pricing por gRPC |
| 9 | `ms_coupon` | REST | 50107 | `ms_coupon` | Cupones y validación (porcentaje/fijo, vigencia, usos) |
| 12 | `ms_payment` | REST | 50108 | `ms_payment` | Pagos tarjeta / transferencia / en sitio; valida la orden en `ms_order` (gRPC) y la pasa a PAGADA |
| 13 | `ms_refund` | REST | 50109 | `ms_refund` | Reembolsos; consulta a Payment que no se devuelva más de lo cobrado; orden → REEMBOLSADA |
| 14 | `ms_invoicing` | **SOAP** | 50113 | `ms_invoicing` | Facturas electrónicas (WSDL en `GET /soap?wsdl`) |
| 15 | `ms_support` | REST | 50110 | `ms_support` | Mensajes de contacto (público con freno anti-spam) |
| 16 | `ms_audit` | REST | 50111 | `ms_audit` | Bitácora; **consumidor de eventos** de todos los servicios |

\* Solo escuchan en `127.0.0.1`. Hacia afuera, el backend los expone en `/api/v3/ms/<servicio>/v1/...` (REST) y `/api/v3/ms/health` (resumen de los 13). `pricing` e `invoicing` no se exponen: los usan los demás servicios dentro del contenedor. Rutas `/internal/*` nunca se reenvían.

**Una base por servicio** (como pide el equipo), todas en el mismo servidor Neon: `MS_DB_BASE_URL` apunta a cualquier base de ese servidor y cada servicio usa la suya (`ms_identity`, `ms_catalog`…), que se **crea sola** al arrancar junto con sus tablas (el SQL de `db/schema.sql` es el del script del equipo, sin cambiar reglas). Las referencias entre servicios son IDs lógicos sin FK, igual que en el diseño.

## Cómo se ejecutan
- **Todos juntos (como en Azure):** `npm run hub` → un proceso con los 13 servidores (≈ 90 MB), cada uno con su puerto y su pool. Si un servicio no puede arrancar (p. ej. la base despierta) se reintenta con espera creciente sin afectar a los demás; `GET http://127.0.0.1:50100/health` resume el estado.
- **Uno solo:** `cd ms_catalog && npm start`.
- Configuración: copie `.env.ms.example` a `.env.ms` (nunca a Git).
- Pruebas locales (**nunca contra Neon**: crean datos): levante el hub contra Postgres local con `scripts/hub-local.sh start`, y en otra terminal `npm run test:ms13` (209 pruebas). `ms_order` debe estar corriendo en `localhost:50062` para las pruebas de pagos/reembolsos.

## Robustez (lo que se probó, no lo que se supone)
- 600 peticiones simultáneas mezcladas: 600 × HTTP 200 en < 1 s.
- Base de datos apagada: los servicios responden **503 `DATABASE_UNAVAILABLE`** (no se caen) y se recuperan solos al volver.
- Proceso del hub terminado a la fuerza (`kill -9`): `azure-start.mjs` lo reinicia en ~2 s; el backend y los 3 gRPC siguen.
- Llamadas entre servicios con plazo (3 s), reintento de lecturas y **cortacircuito** (5 fallos seguidos → 15 s sin llamar).
- Cuerpo máx. 256 KB, plazo por petición 12 s, límite de 600 peticiones/min por IP, errores uniformes `{code,message,invalid_params,request_id}`.
- Candados por pago/orden: dos cobros simultáneos de la misma orden → uno entra y el otro recibe 409; dos reembolsos simultáneos que juntos superan lo cobrado → solo uno entra.
- Sin secretos en el código: claves de sesión guardadas como hash SHA-256, contraseñas con bcrypt, bitácora que omite campos de clave/token/tarjeta.

## Qué es SIMULADO (decirlo en la presentación)
- **Pagos con tarjeta:** no hay pasarela real. Un simulador decide: número válido (Luhn, VISA/MASTERCARD/AMEX, no vencida) y termina en `0002` → RECHAZADO, en `0119` → FALLIDO, el resto → APROBADO. Nunca se guarda el número completo ni el CVV (solo marca y últimos 4).
- **Reembolsos:** el "envío a la pasarela" es simulado (referencia `SIM-RF-…`).
- **Facturación SRI:** la clave de acceso de 49 dígitos se calcula con el algoritmo (módulo 11) pero la factura **no se envía al SRI** ni tiene validez tributaria; el RUC emisor por defecto es de prueba (`INVOICE_EMISOR_RUC`). IVA 15 % configurable (`INVOICE_IVA_PCT`); tope de consumidor final 50 USD configurable (`INVOICE_FINAL_CONSUMER_MAX`, **verificar con el SRI**).
- **Correo:** no hay servicio de correo; la verificación y la recuperación de clave generan tokens que en producción **no se entregan a nadie** hasta conectar un proveedor (`MS_EXPOSE_TOKENS=false`).
- **Eventos entre servicios (hoy):** transporte provisional por HTTP interno con reintentos y cola en memoria (1000). Si el proceso se reinicia con eventos en cola, **se pierden** (por eso el siguiente paso es el bus RabbitMQ/CloudAMQP con Outbox). Catalog y Audit son idempotentes frente a repetidos.

## Límites conocidos
- El backend NestJS (contrato v3 con Booking) sigue usando sus propias tablas; los 13 servicios nuevos conviven y se llaman por `/api/v3/ms/...`. Aún **no** reemplazan la lógica interna del backend (decisión pendiente: cuánto migrar antes de presentar).
- `ms_cart` no valida el cupo (`dis_id`) contra `ms_inventory`; solo guarda el identificador.
- `ms_coupon` no cuenta usos: quien llama informa `usos_actuales` (los usos viven en `orden_cupon` de Order, como define el diseño).
- Si dos eventos de reseña llegan desordenados gana el último en llegar; el siguiente evento de esa atracción corrige el dato (siempre trae totales completos).
- Índice de búsqueda por similitud (`pg_trgm`) solo si la extensión está disponible; si no, la búsqueda usa `ILIKE` sin índice.
