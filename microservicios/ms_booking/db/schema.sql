-- Tomado SIN CAMBIOS de 02_microservicios_v2_bases_de_datos.sql (script del equipo, Descubre EC v2).
-- Base de datos propia: ms_booking (database-per-service). Las referencias a otros servicios son IDs logicos, sin FK.

-- ============================================================================
--  11 · BOOKING SERVICE  (gRPC)
--  Tablas: estado, reserva, reserva_pasajero
--  Relaciones internas: estado 1-N reserva, reserva 1-N reserva_pasajero
--  Referencias externas (ID logico): reserva.det_id -> orden_detalle (Order),
--                                    reserva.dis_id -> disponibilidad (Inventory)
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE DOMAIN dom_documento AS VARCHAR(20)
    CHECK (VALUE ~ '^[0-9]{10}$' OR VALUE ~ '^[A-Z]{1,2}[0-9]{6,9}$');
CREATE DOMAIN dom_importe AS NUMERIC(12,2)
    CHECK (VALUE >= 0);

CREATE OR REPLACE FUNCTION fn_actualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Estados propios de la reserva (sin est_grupo).
CREATE TABLE estado (
    est_id     SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    est_codigo VARCHAR(20) NOT NULL UNIQUE,
    est_nombre VARCHAR(50) NOT NULL,
    est_final  BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE TABLE reserva (
    res_id                 BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    res_uuid               UUID         NOT NULL UNIQUE DEFAULT gen_random_uuid(), -- id publico
    res_codigo             VARCHAR(12)  NOT NULL UNIQUE,   -- DEC-7F3K9Q
    det_id                 BIGINT       NOT NULL,          -- ID logico (Order)
    dis_id                 BIGINT       NOT NULL,          -- ID logico (Inventory)
    est_id                 SMALLINT     NOT NULL,
    res_adultos            INTEGER      NOT NULL,
    res_ninos              INTEGER      NOT NULL DEFAULT 0,
    res_numero_tickets     INTEGER      NOT NULL,
    res_precio_unitario    dom_importe  NOT NULL,          -- snapshot
    res_subtotal           dom_importe  NOT NULL,
    res_observaciones      VARCHAR(500),
    res_motivo_cancelacion VARCHAR(255),
    res_creado_en          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    res_actualizado_en     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    res_cancelado_en       TIMESTAMPTZ,
    res_confirmado_en      TIMESTAMPTZ,
    CONSTRAINT reserva_pasajeros_validos
        CHECK (res_adultos > 0 AND res_ninos >= 0),
    CONSTRAINT reserva_total_coherente
        CHECK (res_numero_tickets = res_adultos + res_ninos),
    CONSTRAINT fk_reserva_estado
        FOREIGN KEY (est_id) REFERENCES estado (est_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_reserva_det_id ON reserva (det_id);
CREATE INDEX ix_reserva_dis_id ON reserva (dis_id);
CREATE INDEX ix_reserva_est_id ON reserva (est_id);

CREATE TABLE reserva_pasajero (
    pax_id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    res_id               BIGINT       NOT NULL,
    pax_nombre           VARCHAR(120) NOT NULL,
    pax_documento        dom_documento,
    pax_fecha_nacimiento DATE,
    pax_es_titular       BOOLEAN      NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_reserva_pasajero_reserva
        FOREIGN KEY (res_id) REFERENCES reserva (res_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_reserva_pasajero_res_id ON reserva_pasajero (res_id);

CREATE TRIGGER trg_reserva_actualizado BEFORE UPDATE ON reserva
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_timestamp('res_actualizado_en');

INSERT INTO estado (est_codigo, est_nombre, est_final) VALUES
    ('PENDIENTE_PAGO', 'Reserva pendiente',  FALSE),
    ('CONFIRMADA',     'Reserva confirmada', FALSE),
    ('CANCELADA',      'Reserva cancelada',  TRUE),
    ('COMPLETADA',     'Reserva completada', TRUE);
