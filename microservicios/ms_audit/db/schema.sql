-- ms_audit: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE TABLE bitacora (
    bit_id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usu_id         BIGINT,                          -- ID logico (Identity); NULL si es anonimo
    bit_accion     VARCHAR(60) NOT NULL,
    bit_entidad    VARCHAR(60) NOT NULL,
    bit_entidad_id VARCHAR(64),
    bit_detalle    JSONB,
    bit_ip         VARCHAR(45),
    bit_creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_bitacora_usu_id  ON bitacora (usu_id);
CREATE INDEX ix_bitacora_fecha   ON bitacora (bit_creado_en DESC);
CREATE INDEX ix_bitacora_entidad ON bitacora (bit_entidad, bit_entidad_id);
