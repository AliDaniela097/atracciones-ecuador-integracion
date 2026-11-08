-- ms_cart: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE OR REPLACE FUNCTION fn_actualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE carrito (
    car_id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usu_id             BIGINT      NOT NULL,        -- ID logico (Identity)
    car_activo         BOOLEAN     NOT NULL DEFAULT TRUE,
    car_creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    car_actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_carrito_usu_id ON carrito (usu_id);
-- Solo UN carrito activo por usuario.
CREATE UNIQUE INDEX ux_carrito_activo ON carrito (usu_id) WHERE car_activo;

CREATE TABLE carrito_item (
    cai_id        BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    car_id        BIGINT      NOT NULL,
    atr_id        BIGINT      NOT NULL,             -- ID logico (Catalog)
    dis_id        BIGINT,                           -- ID logico (Inventory), opcional
    cai_adultos   INTEGER     NOT NULL DEFAULT 1,
    cai_ninos     INTEGER     NOT NULL DEFAULT 0,
    cai_creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT carrito_item_cantidades_validas
        CHECK (cai_adultos > 0 AND cai_ninos >= 0),
    CONSTRAINT uq_carrito_item UNIQUE (car_id, atr_id, dis_id),
    CONSTRAINT fk_carrito_item_carrito
        FOREIGN KEY (car_id) REFERENCES carrito (car_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_carrito_item_car_id ON carrito_item (car_id);
CREATE INDEX ix_carrito_item_atr_id ON carrito_item (atr_id);
CREATE INDEX ix_carrito_item_dis_id ON carrito_item (dis_id);

CREATE TRIGGER trg_carrito_actualizado BEFORE UPDATE ON carrito
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_timestamp('car_actualizado_en');


-- ============================================================================
--  9 · COUPON SERVICE  (REST)
--  Tablas: cupon
--  Referencias externas: ninguna (los usos se cuentan en orden_cupon, Order)
-- ============================================================================
