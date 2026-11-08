-- ms_coupon: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE DOMAIN dom_importe AS NUMERIC(12,2)
    CHECK (VALUE >= 0);

CREATE TABLE cupon (
    cup_id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cup_codigo       VARCHAR(30) NOT NULL UNIQUE,
    cup_tipo         VARCHAR(20) NOT NULL,          -- PORCENTAJE, FIJO
    cup_valor        dom_importe NOT NULL,
    cup_fecha_inicio DATE        NOT NULL,
    cup_fecha_fin    DATE,
    cup_usos_max     INTEGER,                       -- NULL = sin limite
    cup_activo       BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT cupon_tipo_valido CHECK (cup_tipo IN ('PORCENTAJE', 'FIJO')),
    CONSTRAINT cupon_vigencia_valida
        CHECK (cup_fecha_fin IS NULL OR cup_fecha_fin >= cup_fecha_inicio),
    CONSTRAINT cupon_usos_valido
        CHECK (cup_usos_max IS NULL OR cup_usos_max > 0),
    CONSTRAINT cupon_porcentaje_valido
        CHECK (cup_tipo <> 'PORCENTAJE' OR cup_valor <= 100)
);
CREATE INDEX ix_cupon_activo ON cupon (cup_activo);


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
