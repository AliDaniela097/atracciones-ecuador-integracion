-- ms_pricing: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE DOMAIN dom_moneda AS CHAR(3)
    CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN dom_importe AS NUMERIC(12,2)
    CHECK (VALUE >= 0);

CREATE TABLE tarifa (
    tar_id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id            BIGINT      NOT NULL,         -- ID logico (Catalog)
    tar_tipo          VARCHAR(20) NOT NULL,         -- ADULTO, NINO, MAYOR, GRUPO
    tar_precio        dom_importe NOT NULL,
    tar_moneda        dom_moneda  NOT NULL DEFAULT 'USD',
    tar_vigente_desde DATE        NOT NULL DEFAULT CURRENT_DATE,
    tar_vigente_hasta DATE,                         -- NULL = vigente
    CONSTRAINT uq_tarifa_atraccion_tipo_desde UNIQUE (atr_id, tar_tipo, tar_vigente_desde),
    CONSTRAINT tarifa_tipo_valido
        CHECK (tar_tipo IN ('ADULTO', 'NINO', 'MAYOR', 'GRUPO')),
    CONSTRAINT tarifa_vigencia_valida
        CHECK (tar_vigente_hasta IS NULL OR tar_vigente_hasta >= tar_vigente_desde)
);
CREATE INDEX ix_tarifa_atr_id ON tarifa (atr_id);


-- ============================================================================
--  7 · INVENTORY & AVAILABILITY SERVICE  (gRPC)
--  Tablas: horario, disponibilidad, fecha_bloqueada
--  Relaciones internas: horario 1-N disponibilidad
--                       (FK compuesta (hor_id, atr_id) -> horario)
--  Referencias externas (ID logico): atr_id -> atraccion (Catalog) en las 3
-- ============================================================================
