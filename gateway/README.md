# Gateway (Semana 8) — qué hay, dónde está y qué falta

**Dónde vive el código:** `backend/src/gateway/` (módulo del backend NestJS). **Honestidad ante todo:** hoy el Gateway corre **dentro del mismo proceso** que la API; no es un componente independiente como Kong. El libro (8.1) lo permite para lógica propia (Aggregator/BFF) pero recomienda un Gateway dedicado para lo genérico (rate-limiting, autenticación). `kong.yml` (esta carpeta) es el equivalente declarativo, **sin desplegar y sin probar contra Kong real**.

| Función del libro (8.1) | ¿Está? | Evidencia |
|---|---|---|
| Enrutamiento / **Proxy** | Sí | `backend/src/gateway/ms-proxy.ts`: `/api/v3/ms/<servicio>/v1/...` → 11 microservicios REST (solo `/v1`, nunca `/internal`). |
| **Correlation-id** en el borde | Sí | `backend/src/common/http.ts` (respeta `X-Correlation-Id` entrante o crea `cid-xxxxxxxx`); `ms-proxy.ts` lo reenvía como `x-correlation-id`/`x-request-id`; sale en los errores y en la pantalla de Observabilidad. |
| **Rate-limiting** diferenciado | Sí | `backend/src/gateway/rate-limit.ts`: socio (API Key) 600/min · usuario (JWT) 300/min · anónimo 120/min · login/registro 20/min; responde 429 + `Retry-After`. En memoria: **se reinicia con el servidor y no se comparte entre instancias**. |
| **Aggregator** | Sí | `GET /api/v3/atracciones/{id}/detalle-completo` (`catalog.controller.ts`): detalle + disponibilidad + reseñas en una llamada; si una fuente falla, responde con esa parte en `null`. |
| Autenticación en el borde | **Parcial** | API Key / JWT se validan en `backend/src/auth/auth.guard.ts` (dentro del backend). La autorización fina por recurso la hace cada servicio, como pide 8.5. |
| **BFF** (uno por tipo de cliente) | **No** | Decisión consciente: web pública y panel admin usan la misma API v3. Revisar si crece el número de clientes. |
| Caching en el Gateway | **No** | — |
| Canary / blue-green | **No** | El plan B1 de App Service no incluye *deployment slots*. |
| Service Mesh (Istio/Linkerd) | **No, a propósito** | Tabla 3b del libro: con 2–5 servicios y un solo equipo, la complejidad supera el beneficio; además exigen Kubernetes. |
| Kong / Nginx real | **No** | Solo `kong.yml` de referencia. |

**Qué NO hace el Gateway (regla de 8.1):** ninguna regla de negocio. Rate-limit, correlation-id y proxy son transversales; descuentos, cupos y estados viven en el dominio.

**Riesgo a declarar:** al estar dentro del backend, si el backend cae, el Gateway cae con él (el libro lo llama *punto único de fallo*; mitigación real = varias instancias detrás de un balanceador, no disponible en el plan actual).
