# Contratos (Semana 7) — índice y política

Cada contrato es un **artefacto versionado** (en Git junto al código) y se **hace cumplir**, no solo se documenta.

| Contrato | Dónde | Estilo | Cómo se hace cumplir |
|---|---|---|---|
| API pública v3 (Booking) | `backend/contracts/atracciones-openapi-v3.yaml` | schema-first (viene de Booking, 3.0.0 + 3.0.1 + 3.1.0) | Ajv en ejecución (`backend/src/contract/`) + `npm run check:contract` |
| Stock hacia Booking (gRPC) | `backend/contracts/proto/inventory.proto` | schema-first | Se carga desde el `.proto` |
| `ms_booking`, `ms_inventory`, `ms_order`, `ms_pricing` | `microservicios/<ms>/proto/*.proto` + `schemas/requests.json` | schema-first (escritos a mano) | Ajv en ejecución + `test:schemas` (campos del esquema = campos del `.proto`) |
| Los otros 12 microservicios | `microservicios/<ms>/schemas/requests.json` | **code-first** (generado desde `src/definicion.mjs`, marcado `x-generado`) | Ajv en ejecución con el mismo esquema que se exporta |

Versión de cada esquema/proto: SemVer en la cabecera (`1.0.0`). Agregar campo opcional = MINOR; quitar campo/cambiar tipo = MAJOR.

## Verificar compatibilidad hacia atrás (BACKWARD, 7.5)
```
node contratos/test-compat.mjs        # 19 pruebas del verificador (casos del ejercicio 7.4 + reglas de Protobuf)
node contratos/check-compat.mjs       # compara los contratos actuales con contratos/baseline/ (última versión publicada); código 1 si algo ROMPE
node contratos/exportar-esquemas.mjs  # regenera los schemas/requests.json de los 12 servicios code-first
node contratos/check-compat.mjs --update   # SOLO tras revisar un cambio deliberado: acepta lo actual como nueva referencia
```
**Límites (como aclara el libro):** heurística; no sigue `$ref` ni `allOf/oneOf/anyOf`, y no verifica **comportamiento** (eso es *contract testing*, Semana 9). El OpenAPI solo se compara en operaciones eliminadas y en `components.schemas`.
`.github/workflows/contratos.yml` ejecuta estas comprobaciones en cada Pull Request (**no se ha ejecutado en GitHub todavía**).
