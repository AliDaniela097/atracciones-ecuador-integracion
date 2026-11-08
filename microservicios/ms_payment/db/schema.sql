-- ms_payment: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE DOMAIN dom_importe AS NUMERIC(12,2)
    CHECK (VALUE >= 0);

CREATE TABLE metodo_pago (
    mpa_id             SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mpa_codigo         VARCHAR(20) NOT NULL UNIQUE,  -- TARJETA, TRANSFERENCIA, EN_SITIO
    mpa_nombre         VARCHAR(60) NOT NULL,
    mpa_requiere_datos BOOLEAN     NOT NULL DEFAULT FALSE,
    mpa_activo         BOOLEAN     NOT NULL DEFAULT TRUE
);

-- Estados propios del pago (sin est_grupo).
CREATE TABLE estado (
    est_id     SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    est_codigo VARCHAR(20) NOT NULL UNIQUE,
    est_nombre VARCHAR(50) NOT NULL,
    est_final  BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE TABLE pago (
    pag_id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pag_numero         VARCHAR(30)  NOT NULL UNIQUE,
    ord_id             BIGINT       NOT NULL,        -- ID logico (Order)
    mpa_id             SMALLINT     NOT NULL,
    est_id             SMALLINT     NOT NULL,
    pag_monto          dom_importe  NOT NULL,        -- moneda: la de la orden
    pag_referencia     VARCHAR(100),                 -- id de la pasarela
    pag_autorizacion   VARCHAR(100),
    pag_fecha          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    pag_aprobado_en    TIMESTAMPTZ,
    pag_rechazado_en   TIMESTAMPTZ,
    pag_motivo_rechazo VARCHAR(300),
    pag_creado_en      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT pago_monto_valido CHECK (pag_monto > 0),
    CONSTRAINT pago_aprobado_o_rechazado
        CHECK (pag_aprobado_en IS NULL OR pag_rechazado_en IS NULL),
    CONSTRAINT pago_motivo_solo_si_rechazado
        CHECK (pag_motivo_rechazo IS NULL OR pag_rechazado_en IS NOT NULL),
    CONSTRAINT fk_pago_metodo_pago
        FOREIGN KEY (mpa_id) REFERENCES metodo_pago (mpa_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_pago_estado
        FOREIGN KEY (est_id) REFERENCES estado (est_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_pago_ord_id ON pago (ord_id);
CREATE INDEX ix_pago_mpa_id ON pago (mpa_id);
CREATE INDEX ix_pago_est_id ON pago (est_id);
CREATE INDEX ix_pago_fecha  ON pago (pag_fecha DESC);
-- Una orden tiene a lo sumo UN pago aprobado.
CREATE UNIQUE INDEX ux_pago_orden_aprobado
    ON pago (ord_id) WHERE pag_aprobado_en IS NOT NULL;

-- NUNCA se guarda el numero de tarjeta (PCI-DSS).
CREATE TABLE pago_tarjeta (
    pat_id       BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pag_id       BIGINT       NOT NULL,
    pat_marca    VARCHAR(20)  NOT NULL,              -- VISA, MASTERCARD, AMEX
    pat_ultimos4 CHAR(4)      NOT NULL,
    pat_titular  VARCHAR(120) NOT NULL,
    pat_mes      SMALLINT     NOT NULL,
    pat_anio     SMALLINT     NOT NULL,
    pat_pais     CHAR(2)      NOT NULL,
    CONSTRAINT pago_tarjeta_mes_valido  CHECK (pat_mes BETWEEN 1 AND 12),
    CONSTRAINT pago_tarjeta_anio_valido CHECK (pat_anio BETWEEN 2020 AND 2100),
    CONSTRAINT pago_tarjeta_ultimos4_formato CHECK (pat_ultimos4 ~ '^[0-9]{4}$'),
    CONSTRAINT uq_pago_tarjeta_pag_id UNIQUE (pag_id),          -- 1:1
    CONSTRAINT fk_pago_tarjeta_pago
        FOREIGN KEY (pag_id) REFERENCES pago (pag_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE pago_transferencia (
    ptr_id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pag_id                  BIGINT      NOT NULL,
    ptr_banco               VARCHAR(60) NOT NULL,
    ptr_numero_comprobante  VARCHAR(40) NOT NULL,
    ptr_fecha_transferencia DATE        NOT NULL,
    ptr_archivo_adjunto     VARCHAR(500),
    CONSTRAINT uq_pago_transferencia_pag_id UNIQUE (pag_id),    -- 1:1
    CONSTRAINT fk_pago_transferencia_pago
        FOREIGN KEY (pag_id) REFERENCES pago (pag_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

INSERT INTO metodo_pago (mpa_codigo, mpa_nombre, mpa_requiere_datos) VALUES
    ('TARJETA',       'Tarjeta de credito/debito', TRUE),
    ('TRANSFERENCIA', 'Transferencia bancaria',    FALSE),
    ('EN_SITIO',      'Pago en el punto de venta', FALSE),
    ('PAYPHAL',       'PayPal',                    FALSE);

INSERT INTO estado (est_codigo, est_nombre, est_final) VALUES
    ('PENDIENTE', 'Pago pendiente', FALSE),
    ('APROBADO',  'Pago aprobado',  TRUE),
    ('RECHAZADO', 'Pago rechazado', TRUE),
    ('FALLIDO',   'Pago fallido',   TRUE);


-- ============================================================================
--  13 · REFUND SERVICE  (REST)
--  Tablas: reembolso
--  Referencias externas (ID logico): pag_id -> pago (Payment)
--  Regla "no reembolsar mas de lo cobrado" (antes trg_reembolso_no_excede):
--  el servicio consulta a Payment el pag_monto antes de procesar.
-- ============================================================================
