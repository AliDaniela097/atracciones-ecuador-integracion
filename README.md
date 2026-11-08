# Atracciones Ecuador

Tienda de atracciones turísticas de las ciudades con aeropuerto del Ecuador, integrada con **Booking Prototipo**. Proyecto individual de Integración de Sistemas (PUCE, Ingeniería en Sistemas de Información).

- **Autora:** Alisson Basantes
- **Nodo en Booking:** `NODE_ATR_ALISSON`
- **Sitio en producción:** https://alisson-atracciones-api.azurewebsites.net/
- **Documentación de la API (Swagger):** https://alisson-atracciones-api.azurewebsites.net/api/docs
- **Estado del servicio:** https://alisson-atracciones-api.azurewebsites.net/api/v3/health

## Qué hace

- **Sitio público:** catálogo con búsqueda en vivo por nombre y ciudad, detalle de cada atracción, disponibilidad de cupos por turno y reserva con código y archivo de calendario (.ics).
- **Panel de administración:** gestión de atracciones y cupos, reservas, check-in del turista (con aviso a Booking), indicadores y bitácora de observabilidad en tiempo real.
- **Integración con Booking:** API REST v3 con contrato OpenAPI, aviso de stock por gRPC, bus de eventos con RabbitMQ y Outbox para no perder avisos si Booking no responde.

## Tecnología

| Capa | Tecnología |
|---|---|
| Backend | NestJS (Node.js, TypeScript), REST v3 + gRPC |
| Base de datos | PostgreSQL (Neon) |
| Mensajería | RabbitMQ |
| Frontend | React 18 + Vite |
| Microservicios | 16 servicios, cada uno con su carpeta, su base de datos y su contrato |
| Despliegue | Azure App Service |
| Integración continua | GitHub Actions (compatibilidad de contratos) |

## Estructura

```
backend/         API pública v3, reservas, administración, bus y gRPC saliente
frontend/        Sitio y panel de administración (React + Vite)
microservicios/  Servicios con su propio contrato y base de datos
contratos/       Verificador de compatibilidad de contratos
gateway/         Documentación de cumplimiento y configuración de referencia (Kong)
deploy/          Empaquetado y arranque para Azure
ARQUITECTURA.md Qué se cumple, qué falla si algo se cae y con qué evidencia
```

La explicación completa de la arquitectura, del aislamiento de fallos y de las limitaciones conocidas está en [ARQUITECTURA.md](ARQUITECTURA.md).

## Puesta en marcha local

Requisitos: Node.js 22 y una base de datos PostgreSQL (por ejemplo, un proyecto gratuito en Neon).

```bash
cd backend
npm install
cp .env.example .env      # en Windows: copy .env.example .env  y complete los valores
npm run db:migrate
npm run db:seed
npm run build
npm start                 # http://localhost:3000   ·   Swagger: /api/docs
```

El frontend se ejecuta aparte durante el desarrollo:

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173 (usa el backend en el puerto 3150 por defecto)
```

Para apuntar el frontend a otro backend: `VITE_API_TARGET=https://su-backend npm run dev`.

## Pruebas

Desde `backend/`: `npm run test:e2e`, `npm run check:contract`, `npm run test:resiliencia`. Detalles y alcance en [ARQUITECTURA.md](ARQUITECTURA.md).

## Despliegue en Azure

```bash
node deploy/build-package.mjs
az webapp deploy --resource-group <grupo> --name <app> --src-path deploy/deploy.zip --type zip
```

## Seguridad

Los secretos (`.env`, cadenas de conexión, claves de API, `deploy/azure-settings.json`) **no se suben al repositorio**; solo se incluyen archivos `.env.example` con valores de ejemplo. Cada variable está explicada dentro de su `.env.example`.

## Licencias

Las tipografías Fraunces y Manrope se incluyen bajo licencia SIL Open Font License (ver `frontend/LICENCIAS-FUENTES.md`). Las ilustraciones de reemplazo del sitio son propias.
