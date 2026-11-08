-- ms_refund: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE DOMAIN dom_importe AS NUMERIC(12,2)
    CHECK (VALUE >= 0);

CREATE TABLE reembolso (
    rem_id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pag_id            BIGINT      NOT NULL,         -- ID logico (Payment)
    rem_numero        VARCHAR(30) NOT NULL UNIQUE,
    rem_monto         dom_importe NOT NULL,
    rem_motivo        VARCHAR(300),
    rem_referencia    VARCHAR(100),                 -- id del reembolso en la pasarela
    rem_solicitado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    rem_procesado_en  TIMESTAMPTZ,
    rem_creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reembolso_monto_valido CHECK (rem_monto > 0)
);
CREATE INDEX ix_reembolso_pag_id ON reembolso (pag_id);


-- ============================================================================
--  14 · ELECTRONIC INVOICING SERVICE  (SOAP)
--  Tablas: estado, factura, factura_detalle
--  Relaciones internas: estado 1-N factura, factura 1-N factura_detalle
--  Referencias externas (ID logico): factura.ord_id -> orden (Order),
--                       factura.dfa_id -> dato_facturacion (Billing Profile),
--                       factura_detalle.det_id -> orden_detalle (Order)
-- ============================================================================
