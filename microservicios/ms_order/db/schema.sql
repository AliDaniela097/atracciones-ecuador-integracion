-- Tomado SIN CAMBIOS de 02_microservicios_v2_bases_de_datos.sql (script del equipo, Descubre EC v2).
-- Base de datos propia: ms_order (database-per-service). Las referencias a otros servicios son IDs logicos, sin FK.

-- ============================================================================
--  10 · ORDER MANAGEMENT SERVICE  (gRPC)
--  Tablas: estado, orden, orden_detalle, orden_cupon, idempotencia
--  Relaciones internas: estado 1-N orden, orden 1-N orden_detalle,
--                       orden 1-N orden_cupon
--  Referencias externas (ID logico): orden.usu_id, idempotencia.idem_sujeto
--                       -> usuario (Identity); orden.car_id -> carrito (Cart);
--                       orden.mpa_id -> metodo_pago (Payment);
--                       orden_cupon.cup_id -> cupon (Coupon);
--                       orden_detalle.atr_id -> atraccion (Catalog)
-- ============================================================================
CREATE DOMAIN dom_moneda AS CHAR(3)
    CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN dom_importe AS NUMERIC(12,2)
    CHECK (VALUE >= 0);

CREATE OR REPLACE FUNCTION fn_actualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Estados propios de la orden (sin est_grupo).
CREATE TABLE estado (
    est_id     SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    est_codigo VARCHAR(20) NOT NULL UNIQUE,
    est_nombre VARCHAR(50) NOT NULL,
    est_final  BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE TABLE orden (
    ord_id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ord_numero         VARCHAR(20) NOT NULL UNIQUE,  -- external_order_id del contrato
    usu_id             BIGINT      NOT NULL,         -- ID logico (Identity)
    car_id             BIGINT,                       -- ID logico (Cart); NULL = compra directa
    est_id             SMALLINT    NOT NULL,
    mpa_id             SMALLINT,                     -- ID logico (Payment)
    ord_fecha          TIMESTAMPTZ NOT NULL DEFAULT now(),
    ord_subtotal       dom_importe NOT NULL DEFAULT 0,
    ord_descuento      dom_importe NOT NULL DEFAULT 0,
    ord_iva            dom_importe NOT NULL DEFAULT 0,
    ord_total          dom_importe NOT NULL DEFAULT 0,
    ord_moneda         dom_moneda  NOT NULL DEFAULT 'USD',
    ord_observaciones  VARCHAR(500),
    ord_creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ord_actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT orden_total_coherente
        CHECK (ord_total = ord_subtotal - ord_descuento + ord_iva),
    -- Un carrito se convierte en UNA sola orden.
    CONSTRAINT uq_orden_car_id UNIQUE (car_id),
    CONSTRAINT fk_orden_estado
        FOREIGN KEY (est_id) REFERENCES estado (est_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_orden_usu_id ON orden (usu_id);
CREATE INDEX ix_orden_est_id ON orden (est_id);
CREATE INDEX ix_orden_fecha  ON orden (ord_fecha DESC);
CREATE INDEX ix_orden_mpa_id ON orden (mpa_id);

CREATE TABLE orden_detalle (
    det_id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ord_id              BIGINT       NOT NULL,
    atr_id              BIGINT       NOT NULL,       -- ID logico (Catalog)
    det_descripcion     VARCHAR(255) NOT NULL,       -- snapshot del nombre
    det_cantidad        INTEGER      NOT NULL,
    det_precio_unitario dom_importe  NOT NULL,       -- snapshot del precio (Pricing)
    det_subtotal        dom_importe  NOT NULL,
    CONSTRAINT orden_detalle_cantidad_valida CHECK (det_cantidad > 0),
    CONSTRAINT orden_detalle_subtotal_coherente
        CHECK (det_subtotal = det_cantidad * det_precio_unitario),
    CONSTRAINT fk_orden_detalle_orden
        FOREIGN KEY (ord_id) REFERENCES orden (ord_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_orden_detalle_ord_id ON orden_detalle (ord_id);
CREATE INDEX ix_orden_detalle_atr_id ON orden_detalle (atr_id);

CREATE TABLE orden_cupon (
    ord_id       BIGINT      NOT NULL,
    cup_id       BIGINT      NOT NULL,               -- ID logico (Coupon)
    orc_usado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_orden_cupon PRIMARY KEY (ord_id, cup_id),
    CONSTRAINT fk_orden_cupon_orden
        FOREIGN KEY (ord_id) REFERENCES orden (ord_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_orden_cupon_cup_id ON orden_cupon (cup_id);

-- Registro de operaciones idempotentes (evita cobros dobles)
CREATE TABLE idempotencia (
    idem_clave        UUID         NOT NULL,
    idem_sujeto       BIGINT       NOT NULL,         -- ID logico usu_id (Identity)
    idem_operacion    VARCHAR(150) NOT NULL,
    idem_request_hash VARCHAR(64)  NOT NULL,
    idem_estado       VARCHAR(12)  NOT NULL DEFAULT 'IN_PROGRESS',
    idem_response     JSONB,
    idem_expira_en    TIMESTAMPTZ  NOT NULL,
    idem_creado_en    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT pk_idempotencia PRIMARY KEY (idem_clave, idem_sujeto),
    CONSTRAINT idempotencia_estado_valido
        CHECK (idem_estado IN ('IN_PROGRESS', 'DONE', 'FAILED'))
);
CREATE INDEX ix_idempotencia_expira_en ON idempotencia (idem_expira_en);

CREATE TRIGGER trg_orden_actualizado BEFORE UPDATE ON orden
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_timestamp('ord_actualizado_en');

CREATE VIEW v_orden_financiero AS
SELECT o.ord_id, o.ord_numero, o.ord_fecha, o.usu_id,
       COALESCE(SUM(det.det_subtotal), 0) AS calculado_subtotal,
       o.ord_subtotal, o.ord_descuento, o.ord_iva, o.ord_total,
       (o.ord_subtotal - o.ord_descuento + o.ord_iva) AS total_recalculado
FROM orden o
LEFT JOIN orden_detalle det ON det.ord_id = o.ord_id
GROUP BY o.ord_id, o.ord_numero, o.ord_fecha, o.usu_id,
         o.ord_subtotal, o.ord_descuento, o.ord_iva, o.ord_total;

INSERT INTO estado (est_codigo, est_nombre, est_final) VALUES
    ('CREADA',      'Orden creada',      FALSE),
    ('PAGADA',      'Orden pagada',      TRUE),
    ('CANCELADA',   'Orden cancelada',   TRUE),
    ('REEMBOLSADA', 'Orden reembolsada', TRUE);
