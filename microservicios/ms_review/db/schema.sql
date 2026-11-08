-- ms_review: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE TABLE resena (
    ren_id           BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id           BIGINT        NOT NULL,        -- ID logico (Catalog)
    usu_id           BIGINT,                        -- ID logico (Identity); NULL = anonima
    ren_autor_nombre VARCHAR(120),                  -- solo para resenas anonimas
    ren_puntuacion   SMALLINT      NOT NULL,
    ren_comentario   VARCHAR(1000) NOT NULL,
    ren_visible      BOOLEAN       NOT NULL DEFAULT TRUE,
    ren_creado_en    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT resena_puntuacion_valida CHECK (ren_puntuacion BETWEEN 1 AND 5),
    CONSTRAINT uq_resena_atraccion_usuario UNIQUE (atr_id, usu_id),
    CONSTRAINT resena_autor_coherente
        CHECK ((usu_id IS NOT NULL AND ren_autor_nombre IS NULL)
            OR (usu_id IS NULL AND ren_autor_nombre IS NOT NULL))
);
CREATE INDEX ix_resena_atr_id ON resena (atr_id);
CREATE INDEX ix_resena_usu_id ON resena (usu_id);


-- ============================================================================
--  6 · PRICING SERVICE  (gRPC)
--  Tablas: tarifa
--  Referencias externas (ID logico): atr_id -> atraccion (Catalog)
-- ============================================================================
