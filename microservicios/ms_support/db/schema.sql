-- ms_support: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE DOMAIN dom_correo AS VARCHAR(160)
    CHECK (VALUE ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');

CREATE TABLE mensaje_contacto (
    men_id        BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    men_nombre    VARCHAR(120)  NOT NULL,
    men_correo    dom_correo    NOT NULL,
    men_asunto    VARCHAR(30)   NOT NULL,
    men_cuerpo    VARCHAR(2000) NOT NULL,
    men_leido     BOOLEAN       NOT NULL DEFAULT FALSE,
    men_creado_en TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX ix_mensaje_contacto_leido ON mensaje_contacto (men_leido);


-- ============================================================================
--  16 · AUDIT SERVICE  (REST · consumidor de eventos)
--  Tablas: bitacora
--  Referencias externas (ID logico): usu_id -> usuario (Identity)
-- ============================================================================
