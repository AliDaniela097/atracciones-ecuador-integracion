-- Tomado SIN CAMBIOS de 02_microservicios_v2_bases_de_datos.sql (script del equipo, Descubre EC v2).
-- Base de datos propia: ms_inventory (database-per-service). Las referencias a otros servicios son IDs logicos, sin FK.

-- ============================================================================
--  7 · INVENTORY & AVAILABILITY SERVICE  (gRPC)
--  Tablas: horario, disponibilidad, fecha_bloqueada
--  Relaciones internas: horario 1-N disponibilidad
--                       (FK compuesta (hor_id, atr_id) -> horario)
--  Referencias externas (ID logico): atr_id -> atraccion (Catalog) en las 3
-- ============================================================================
CREATE TABLE horario (
    hor_id     BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id     BIGINT  NOT NULL,                    -- ID logico (Catalog)
    hor_hora   TIME    NOT NULL,
    hor_cupo   INTEGER NOT NULL DEFAULT 20,
    hor_activo BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT horario_cupo_positivo CHECK (hor_cupo > 0),
    CONSTRAINT uq_horario_atraccion_hora UNIQUE (atr_id, hor_hora),
    -- Clave candidata para la FK compuesta desde disponibilidad
    CONSTRAINT uq_horario_id_atraccion UNIQUE (hor_id, atr_id)
);
CREATE INDEX ix_horario_atr_id ON horario (atr_id);

CREATE TABLE disponibilidad (
    dis_id             BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id             BIGINT  NOT NULL,            -- ID logico (Catalog)
    hor_id             BIGINT  NOT NULL,
    dis_fecha          DATE    NOT NULL,
    dis_cupo_total     INTEGER NOT NULL,
    dis_cupo_reservado INTEGER NOT NULL DEFAULT 0,
    dis_cerrada        BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_disponibilidad_atraccion_fecha_horario UNIQUE (atr_id, dis_fecha, hor_id),
    CONSTRAINT disponibilidad_cupos_validos
        CHECK (dis_cupo_total > 0
               AND dis_cupo_reservado >= 0
               AND dis_cupo_reservado <= dis_cupo_total),
    -- FK compuesta interna: el horario debe ser de la MISMA atraccion
    CONSTRAINT fk_disponibilidad_horario
        FOREIGN KEY (hor_id, atr_id) REFERENCES horario (hor_id, atr_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_disponibilidad_atr_id ON disponibilidad (atr_id);
CREATE INDEX ix_disponibilidad_hor_id ON disponibilidad (hor_id, atr_id);
CREATE INDEX ix_disponibilidad_fecha  ON disponibilidad (dis_fecha);

CREATE TABLE fecha_bloqueada (
    fb_id        BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id       BIGINT       NOT NULL,             -- ID logico (Catalog)
    fb_fecha     DATE         NOT NULL,
    fb_motivo    VARCHAR(200) NOT NULL,
    fb_creado_en TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_fecha_bloqueada_atraccion_fecha UNIQUE (atr_id, fb_fecha)
);
CREATE INDEX ix_fecha_bloqueada_atr_id ON fecha_bloqueada (atr_id);
