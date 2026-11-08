-- ms_invoicing: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE DOMAIN dom_correo AS VARCHAR(160)
    CHECK (VALUE ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');
CREATE DOMAIN dom_telefono AS VARCHAR(20)
    CHECK (VALUE ~ '^\+?[0-9]{7,15}$');
CREATE DOMAIN dom_porcentaje AS NUMERIC(5,2)
    CHECK (VALUE >= 0 AND VALUE <= 100);
CREATE DOMAIN dom_importe AS NUMERIC(12,2)
    CHECK (VALUE >= 0);

-- Estados propios de la factura (sin est_grupo).
CREATE TABLE estado (
    est_id     SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    est_codigo VARCHAR(20) NOT NULL UNIQUE,
    est_nombre VARCHAR(50) NOT NULL,
    est_final  BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE TABLE factura (
    fac_id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ord_id               BIGINT       NOT NULL,      -- ID logico (Order)
    dfa_id               BIGINT,                     -- ID logico (Billing Profile)
    fac_numero           VARCHAR(20)  NOT NULL UNIQUE,
    fac_clave_acceso     VARCHAR(49),                -- clave de acceso SRI
    fac_autorizacion_sri VARCHAR(49),
    est_id               SMALLINT     NOT NULL,
    fac_emitida_en       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    fac_subtotal         dom_importe  NOT NULL,
    fac_descuento        dom_importe  NOT NULL DEFAULT 0,
    fac_iva              dom_importe  NOT NULL DEFAULT 0,
    fac_total            dom_importe  NOT NULL,
    -- Snapshot del comprador al momento de emitir
    fac_tipo_identificacion VARCHAR(20)  NOT NULL,
    fac_identificacion      VARCHAR(20)  NOT NULL,
    fac_razon_social        VARCHAR(150) NOT NULL,
    fac_correo              dom_correo   NOT NULL,
    fac_telefono            dom_telefono,
    CONSTRAINT factura_tipo_identificacion_valido
        CHECK (fac_tipo_identificacion IN ('CEDULA', 'RUC', 'PASAPORTE', 'CONSUMIDOR_FINAL')),
    CONSTRAINT factura_total_coherente
        CHECK (fac_total = fac_subtotal - fac_descuento + fac_iva),
    CONSTRAINT uq_factura_orden UNIQUE (ord_id),
    CONSTRAINT fk_factura_estado
        FOREIGN KEY (est_id) REFERENCES estado (est_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_factura_dfa_id ON factura (dfa_id);
CREATE INDEX ix_factura_est_id ON factura (est_id);

CREATE TABLE factura_detalle (
    fde_id              BIGINT         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fac_id              BIGINT         NOT NULL,
    det_id              BIGINT         NOT NULL,     -- ID logico (Order)
    fde_codigo          VARCHAR(25)    NOT NULL,     -- codigo principal del producto (SRI)
    fde_descripcion     VARCHAR(300)   NOT NULL,
    fde_cantidad        INTEGER        NOT NULL,
    fde_precio_unitario dom_importe    NOT NULL,
    fde_descuento       dom_importe    NOT NULL DEFAULT 0,
    fde_subtotal        dom_importe    NOT NULL,
    fde_iva_porcentaje  dom_porcentaje NOT NULL DEFAULT 0,
    fde_iva             dom_importe    NOT NULL DEFAULT 0,
    fde_total           dom_importe    NOT NULL,
    CONSTRAINT factura_detalle_cantidad_valida CHECK (fde_cantidad > 0),
    CONSTRAINT factura_detalle_subtotal_coherente
        CHECK (fde_subtotal = fde_cantidad * fde_precio_unitario - fde_descuento),
    CONSTRAINT factura_detalle_total_coherente
        CHECK (fde_total = fde_subtotal + fde_iva),
    -- Una linea de orden se factura una sola vez
    CONSTRAINT uq_factura_detalle_det_id UNIQUE (det_id),
    CONSTRAINT fk_factura_detalle_factura
        FOREIGN KEY (fac_id) REFERENCES factura (fac_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_factura_detalle_fac_id ON factura_detalle (fac_id);

INSERT INTO estado (est_codigo, est_nombre, est_final) VALUES
    ('NO_PAGADA', 'Factura no pagada', FALSE),
    ('PAGADA',    'Factura pagada',    TRUE),
    ('ANULADA',   'Factura anulada',   TRUE);


-- ============================================================================
--  15 · SUPPORT SERVICE  (REST)
--  Tablas: mensaje_contacto
--  Referencias externas: ninguna
-- ============================================================================
