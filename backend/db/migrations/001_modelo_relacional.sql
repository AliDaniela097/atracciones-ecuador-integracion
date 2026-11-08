-- ============================================================================
--  ATRACCIONES TURÍSTICAS DEL ECUADOR (solo ciudades con aeropuerto)
--  Tienda individual integrada con Booking Prototipo (RDA2)
--  Motor: PostgreSQL 14+ (probado en 16) / Neon      Codificación: UTF-8
--
--  CONVENCIONES (se mantienen las de tu Script Base de datos)
--   - Tablas en singular y minúsculas; PK = prefijo_id; la FK se llama igual
--     que la PK que referencia; tablas puente con PK compuesta.
--   - Importes NUMERIC(12,2). Toda FK lleva índice y ON DELETE explícito.
--
--  TERCERA FORMA NORMAL (3FN): ningún dato se guarda dos veces ni depende de
--  otro atributo que no sea la clave. Cambios respecto a tu script original:
--   1. atraccion.prov_id eliminado: la provincia se obtiene por ciudad.prov_id
--      (dependencia transitiva atraccion -> ciudad -> provincia).
--   2. atr_calificacion_promedio / atr_numero_resenas eliminados: son datos
--      derivados; se calculan en la vista v_atraccion_rating.
--   3. reserva.res_fecha / res_hora / res_adultos / res_ninos /
--      res_numero_tickets / res_precio_unitario / res_subtotal eliminados:
--      fecha y hora salen del turno; las cantidades y precios van en
--      reserva_boleto (uno por tipo de boleto) y los totales se suman.
--   4. orden_detalle.det_subtotal (cantidad*precio) no se guarda: es derivado.
--   5. turno no repite atr_id: el horario ya pertenece a una atracción.
--   6. El slot_id ("slot-20261025-1030") NO se guarda: se deriva de
--      turno.tur_fecha + horario.hor_hora (vista v_turno_disponibilidad).
--   7. Datos del comprador en su propia tabla (cliente), no repetidos en cada
--      reserva. El comprador llega desde Booking y NO es un usuario registrado.
--   8. estado único con est_grupo reemplazado por estado_reserva.
--   9. El árbol de categorías lleva las banderas incluye_comida,
--      incluye_transporte, incluye_guia que exige el contrato.
--  10. Tarifa admite los 5 tipos del contrato: ADULTO, NINO, MAYOR, INFANTE,
--      ESTUDIANTE (antes: ADULTO, NINO, MAYOR, GRUPO).
--  11. ciudad.ciu_codigo (decía "INEC/DANE"; DANE es de Colombia y los
--      códigos de ejemplo eran incorrectos) eliminado; prov_codigo usa el
--      código real INEC (DPA) de provincia.
--  12. Nueva tabla aeropuerto: una ciudad es destino solo si tiene aeropuerto
--      activo; un trigger lo exige al crear/editar una atracción.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "unaccent";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE DOMAIN dom_correo AS VARCHAR(160)
    CHECK (VALUE ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');
CREATE DOMAIN dom_telefono AS VARCHAR(20)
    CHECK (VALUE ~ '^\+?[0-9]{7,15}$');
CREATE DOMAIN dom_ruc AS VARCHAR(13)
    CHECK (VALUE ~ '^[0-9]{13}$');
CREATE DOMAIN dom_importe AS NUMERIC(12,2)
    CHECK (VALUE >= 0);

-- Actualiza la columna de "actualizado_en" cuyo nombre llega como argumento.
CREATE OR REPLACE FUNCTION fn_actualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
--  1 · GEOGRAFÍA Y AEROPUERTOS
-- ============================================================================
CREATE TABLE region (
    reg_id     SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reg_nombre VARCHAR(30) NOT NULL UNIQUE,
    reg_codigo CHAR(2)     NOT NULL UNIQUE,
    CONSTRAINT region_nombre_no_vacio CHECK (btrim(reg_nombre) <> '')
);

CREATE TABLE provincia (
    prov_id     SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prov_nombre VARCHAR(60) NOT NULL UNIQUE,
    prov_codigo CHAR(2)     NOT NULL UNIQUE,      -- código INEC (DPA) 01-24
    reg_id      SMALLINT    NOT NULL,
    CONSTRAINT fk_provincia_region FOREIGN KEY (reg_id) REFERENCES region (reg_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_provincia_reg_id ON provincia (reg_id);

CREATE TABLE ciudad (
    ciu_id          SMALLINT     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ciu_nombre      VARCHAR(80)  NOT NULL,
    prov_id         SMALLINT     NOT NULL,
    ciu_descripcion VARCHAR(500),
    ciu_imagen      VARCHAR(500),
    ciu_activa      BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_ciudad_provincia_nombre UNIQUE (prov_id, ciu_nombre),
    CONSTRAINT fk_ciudad_provincia FOREIGN KEY (prov_id) REFERENCES provincia (prov_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_ciudad_prov_id ON ciudad (prov_id);

CREATE TABLE aeropuerto (
    apt_id     SMALLINT     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    apt_nombre VARCHAR(120) NOT NULL,
    apt_iata   CHAR(3)      UNIQUE,
    apt_icao   CHAR(4)      UNIQUE,
    ciu_id     SMALLINT     NOT NULL,
    apt_activo BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT aeropuerto_iata_formato CHECK (apt_iata IS NULL OR apt_iata ~ '^[A-Z]{3}$'),
    CONSTRAINT aeropuerto_icao_formato CHECK (apt_icao IS NULL OR apt_icao ~ '^[A-Z]{4}$'),
    CONSTRAINT fk_aeropuerto_ciudad FOREIGN KEY (ciu_id) REFERENCES ciudad (ciu_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_aeropuerto_ciu_id ON aeropuerto (ciu_id);

-- ============================================================================
--  2 · IDENTIDAD Y ACCESO (panel de administración y login de turistas)
-- ============================================================================
CREATE TABLE rol (
    rol_id          SMALLINT     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rol_nombre      VARCHAR(30)  NOT NULL UNIQUE,   -- ADMIN, OPERADOR, CLIENTE
    rol_descripcion VARCHAR(200) NOT NULL
);

CREATE TABLE usuario (
    usu_id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usu_correo         dom_correo   NOT NULL UNIQUE,
    usu_password       VARCHAR(100) NOT NULL,        -- bcrypt, nunca texto plano
    usu_nombre         VARCHAR(120) NOT NULL,
    usu_apellido       VARCHAR(120) NOT NULL,
    usu_activo         BOOLEAN      NOT NULL DEFAULT TRUE,
    usu_ultimo_acceso  TIMESTAMPTZ,
    usu_creado_en      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    usu_actualizado_en TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT usuario_nombres_no_vacios CHECK (btrim(usu_nombre) <> '' AND btrim(usu_apellido) <> '')
);

CREATE TABLE usuario_rol (
    usu_id BIGINT   NOT NULL,
    rol_id SMALLINT NOT NULL,
    CONSTRAINT pk_usuario_rol PRIMARY KEY (usu_id, rol_id),
    CONSTRAINT fk_usuario_rol_usuario FOREIGN KEY (usu_id) REFERENCES usuario (usu_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_usuario_rol_rol FOREIGN KEY (rol_id) REFERENCES rol (rol_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_usuario_rol_rol_id ON usuario_rol (rol_id);

-- ============================================================================
--  3 · OPERADORES Y GUÍAS
-- ============================================================================
CREATE TABLE operador (
    ope_id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ope_nombre         VARCHAR(150) NOT NULL,
    ope_ruc            dom_ruc      UNIQUE,
    ope_correo         dom_correo,
    ope_telefono       dom_telefono,
    ope_direccion      VARCHAR(255),
    prov_id            SMALLINT     NOT NULL,        -- provincia de la sede
    ope_activo         BOOLEAN      NOT NULL DEFAULT TRUE,
    ope_creado_en      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    ope_actualizado_en TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_operador_provincia FOREIGN KEY (prov_id) REFERENCES provincia (prov_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_operador_prov_id ON operador (prov_id);

CREATE TABLE operador_usuario (
    ope_id      BIGINT      NOT NULL,
    usu_id      BIGINT      NOT NULL,
    opeu_cargo  VARCHAR(60) NOT NULL DEFAULT 'ADMIN',   -- ADMIN, VENDEDOR
    opeu_activo BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_operador_usuario PRIMARY KEY (ope_id, usu_id),
    CONSTRAINT fk_operador_usuario_operador FOREIGN KEY (ope_id) REFERENCES operador (ope_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_operador_usuario_usuario FOREIGN KEY (usu_id) REFERENCES usuario (usu_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_operador_usuario_usu_id ON operador_usuario (usu_id);

CREATE TABLE guia (
    gui_id       BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ope_id       BIGINT       NOT NULL,
    gui_nombre   VARCHAR(120) NOT NULL,
    gui_licencia VARCHAR(40)  NOT NULL UNIQUE,       -- credencial MINTUR
    gui_activo   BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT fk_guia_operador FOREIGN KEY (ope_id) REFERENCES operador (ope_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_guia_ope_id ON guia (ope_id);

-- ============================================================================
--  4 · CATÁLOGO
-- ============================================================================
CREATE TABLE categoria (
    cat_id             INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cat_padre_id       INTEGER,                      -- autorreferencia (árbol)
    cat_nombre         VARCHAR(80)  NOT NULL,
    cat_slug           VARCHAR(80)  NOT NULL UNIQUE,
    cat_descripcion    VARCHAR(255),
    cat_icono          VARCHAR(40)  NOT NULL DEFAULT 'map-pin',
    cat_orden          SMALLINT     NOT NULL DEFAULT 0,
    cat_incluye_comida     BOOLEAN  NOT NULL DEFAULT FALSE,
    cat_incluye_transporte BOOLEAN  NOT NULL DEFAULT FALSE,
    cat_incluye_guia       BOOLEAN  NOT NULL DEFAULT FALSE,
    cat_activa         BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT categoria_no_es_ella_misma CHECK (cat_padre_id IS DISTINCT FROM cat_id),
    CONSTRAINT fk_categoria_padre FOREIGN KEY (cat_padre_id) REFERENCES categoria (cat_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_categoria_cat_padre_id ON categoria (cat_padre_id);

CREATE TABLE idioma (
    idi_id     SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idi_codigo CHAR(2)     NOT NULL UNIQUE,           -- ISO 639-1
    idi_nombre VARCHAR(50) NOT NULL
);

CREATE TABLE inclusion (
    inc_id     INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inc_tipo   VARCHAR(20)  NOT NULL,                 -- INCLUYE, NO_INCLUYE
    inc_nombre VARCHAR(150) NOT NULL,
    CONSTRAINT uq_inclusion_tipo_nombre UNIQUE (inc_tipo, inc_nombre),
    CONSTRAINT inclusion_tipo_valido CHECK (inc_tipo IN ('INCLUYE', 'NO_INCLUYE'))
);

CREATE TABLE atraccion (
    atr_id                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_uuid              UUID          NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    atr_codigo            VARCHAR(12)   NOT NULL UNIQUE,   -- id público (ej. "PRhu4UBTWPBC")
    atr_slug              VARCHAR(220)  NOT NULL UNIQUE,
    atr_nombre            VARCHAR(200)  NOT NULL,
    atr_descripcion       TEXT          NOT NULL,
    atr_descripcion_corta VARCHAR(280),
    atr_tipo              VARCHAR(30)   NOT NULL,          -- GUIDED_TOUR, ADMISSION, DAY_TRIP, TRANSPORT, PACKAGE
    atr_estado            VARCHAR(20)   NOT NULL DEFAULT 'BORRADOR',
    ciu_id                SMALLINT      NOT NULL,
    ope_id                BIGINT        NOT NULL,
    atr_direccion         VARCHAR(255),
    atr_punto_encuentro   VARCHAR(255),
    atr_latitud           NUMERIC(10,6) NOT NULL,
    atr_longitud          NUMERIC(10,6) NOT NULL,
    atr_instrucciones_llegada VARCHAR(300),
    atr_duracion_horas    NUMERIC(5,2)  NOT NULL,
    atr_cancelacion_gratuita BOOLEAN    NOT NULL DEFAULT FALSE,
    atr_horas_cancelacion SMALLINT      NOT NULL DEFAULT 24,
    atr_destacada         BOOLEAN       NOT NULL DEFAULT FALSE,
    atr_permite_paquete   BOOLEAN       NOT NULL DEFAULT FALSE,
    atr_incluye_comida     BOOLEAN      NOT NULL DEFAULT FALSE,
    atr_incluye_transporte BOOLEAN      NOT NULL DEFAULT FALSE,
    atr_incluye_guia       BOOLEAN      NOT NULL DEFAULT FALSE,
    atr_acc_silla_ruedas   BOOLEAN      NOT NULL DEFAULT FALSE,
    atr_acc_carriola       BOOLEAN      NOT NULL DEFAULT FALSE,
    atr_acc_animales_servicio BOOLEAN   NOT NULL DEFAULT FALSE,
    atr_creado_en         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    atr_actualizado_en    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    atr_eliminado_en      TIMESTAMPTZ,                       -- borrado lógico
    CONSTRAINT atraccion_duracion_valida CHECK (atr_duracion_horas > 0 AND atr_duracion_horas <= 720),
    CONSTRAINT atraccion_latitud_valida  CHECK (atr_latitud BETWEEN -90 AND 90),
    CONSTRAINT atraccion_longitud_valida CHECK (atr_longitud BETWEEN -180 AND 180),
    CONSTRAINT atraccion_horas_cancelacion_valida CHECK (atr_horas_cancelacion >= 0),
    CONSTRAINT atraccion_tipo_valido CHECK (atr_tipo IN ('GUIDED_TOUR','ADMISSION','DAY_TRIP','TRANSPORT','PACKAGE')),
    CONSTRAINT atraccion_estado_valido CHECK (atr_estado IN ('BORRADOR','PUBLICADA','INACTIVA')),
    CONSTRAINT fk_atraccion_ciudad FOREIGN KEY (ciu_id) REFERENCES ciudad (ciu_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_atraccion_operador FOREIGN KEY (ope_id) REFERENCES operador (ope_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_atraccion_ciu_id ON atraccion (ciu_id);
CREATE INDEX ix_atraccion_ope_id ON atraccion (ope_id);
CREATE INDEX ix_atraccion_estado ON atraccion (atr_estado) WHERE atr_eliminado_en IS NULL;
CREATE INDEX ix_atraccion_busqueda
    ON atraccion USING gin ((atr_nombre || ' ' || atr_descripcion) gin_trgm_ops);

-- Regla de negocio: la atracción solo puede estar en una ciudad con aeropuerto activo.
CREATE OR REPLACE FUNCTION fn_atraccion_ciudad_con_aeropuerto()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM aeropuerto a WHERE a.ciu_id = NEW.ciu_id AND a.apt_activo) THEN
        RAISE EXCEPTION 'La ciudad % no tiene un aeropuerto activo; solo se admiten atracciones en ciudades con aeropuerto', NEW.ciu_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'atraccion_ciudad_con_aeropuerto';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_atraccion_ciudad_con_aeropuerto
    BEFORE INSERT OR UPDATE OF ciu_id ON atraccion
    FOR EACH ROW EXECUTE FUNCTION fn_atraccion_ciudad_con_aeropuerto();

CREATE TABLE atraccion_categoria (
    atr_id BIGINT  NOT NULL,
    cat_id INTEGER NOT NULL,
    CONSTRAINT pk_atraccion_categoria PRIMARY KEY (atr_id, cat_id),
    CONSTRAINT fk_atraccion_categoria_atraccion FOREIGN KEY (atr_id) REFERENCES atraccion (atr_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_atraccion_categoria_categoria FOREIGN KEY (cat_id) REFERENCES categoria (cat_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_atraccion_categoria_cat_id ON atraccion_categoria (cat_id);

CREATE TABLE atraccion_idioma (
    atr_id BIGINT   NOT NULL,
    idi_id SMALLINT NOT NULL,
    CONSTRAINT pk_atraccion_idioma PRIMARY KEY (atr_id, idi_id),
    CONSTRAINT fk_atraccion_idioma_atraccion FOREIGN KEY (atr_id) REFERENCES atraccion (atr_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_atraccion_idioma_idioma FOREIGN KEY (idi_id) REFERENCES idioma (idi_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_atraccion_idioma_idi_id ON atraccion_idioma (idi_id);

CREATE TABLE atraccion_inclusion (
    atr_id BIGINT  NOT NULL,
    inc_id INTEGER NOT NULL,
    CONSTRAINT pk_atraccion_inclusion PRIMARY KEY (atr_id, inc_id),
    CONSTRAINT fk_atraccion_inclusion_atraccion FOREIGN KEY (atr_id) REFERENCES atraccion (atr_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_atraccion_inclusion_inclusion FOREIGN KEY (inc_id) REFERENCES inclusion (inc_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_atraccion_inclusion_inc_id ON atraccion_inclusion (inc_id);

CREATE TABLE atraccion_foto (
    fot_id    BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id    BIGINT       NOT NULL,
    fot_url   VARCHAR(500) NOT NULL,
    fot_alt   VARCHAR(200) NOT NULL,                 -- texto alternativo (WCAG 1.1.1)
    fot_orden SMALLINT     NOT NULL DEFAULT 0,
    CONSTRAINT fk_atraccion_foto_atraccion FOREIGN KEY (atr_id) REFERENCES atraccion (atr_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_atraccion_foto_atr_id ON atraccion_foto (atr_id);

CREATE TABLE atraccion_itinerario (
    iti_id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id               BIGINT       NOT NULL,
    iti_numero           SMALLINT     NOT NULL,
    iti_hora             TIME         NOT NULL,
    iti_titulo           VARCHAR(200) NOT NULL,
    iti_descripcion      VARCHAR(500),
    iti_duracion_minutos SMALLINT     NOT NULL,
    iti_ubicacion        VARCHAR(150),
    CONSTRAINT uq_itinerario_atraccion_numero UNIQUE (atr_id, iti_numero),
    CONSTRAINT itinerario_numero_valido CHECK (iti_numero > 0),
    CONSTRAINT itinerario_duracion_valida CHECK (iti_duracion_minutos > 0),
    CONSTRAINT fk_itinerario_atraccion FOREIGN KEY (atr_id) REFERENCES atraccion (atr_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE tarifa (
    tar_id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id            BIGINT      NOT NULL,
    tar_tipo          VARCHAR(20) NOT NULL,           -- ADULTO, NINO, MAYOR, INFANTE, ESTUDIANTE
    tar_precio        dom_importe NOT NULL,
    tar_moneda        CHAR(3)     NOT NULL DEFAULT 'USD',
    tar_vigente_desde DATE        NOT NULL DEFAULT CURRENT_DATE,
    tar_vigente_hasta DATE,                           -- NULL = vigente
    CONSTRAINT uq_tarifa_atraccion_tipo_desde UNIQUE (atr_id, tar_tipo, tar_vigente_desde),
    CONSTRAINT tarifa_tipo_valido CHECK (tar_tipo IN ('ADULTO','NINO','MAYOR','INFANTE','ESTUDIANTE')),
    CONSTRAINT tarifa_moneda_valida CHECK (tar_moneda ~ '^[A-Z]{3}$'),
    CONSTRAINT tarifa_vigencia_valida CHECK (tar_vigente_hasta IS NULL OR tar_vigente_hasta >= tar_vigente_desde),
    CONSTRAINT fk_tarifa_atraccion FOREIGN KEY (atr_id) REFERENCES atraccion (atr_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_tarifa_atr_id ON tarifa (atr_id);

-- ============================================================================
--  5 · INVENTARIO: HORARIOS Y TURNOS CON AFORO
-- ============================================================================
CREATE TABLE horario (
    hor_id     BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id     BIGINT  NOT NULL,
    hor_hora   TIME    NOT NULL,
    hor_cupo   INTEGER NOT NULL DEFAULT 20,           -- aforo por defecto al generar turnos
    hor_activo BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT horario_cupo_positivo CHECK (hor_cupo > 0),
    CONSTRAINT horario_sin_segundos CHECK (date_trunc('minute', hor_hora::interval)::time = hor_hora),
    CONSTRAINT uq_horario_atraccion_hora UNIQUE (atr_id, hor_hora),
    CONSTRAINT fk_horario_atraccion FOREIGN KEY (atr_id) REFERENCES atraccion (atr_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_horario_atr_id ON horario (atr_id);

-- Turno = un horario en una fecha, con su aforo (equivale a "turnos_aforo" del contrato).
CREATE TABLE turno (
    tur_id             BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hor_id             BIGINT  NOT NULL,
    tur_fecha          DATE    NOT NULL,
    tur_cupo_total     INTEGER NOT NULL,
    tur_cupo_reservado INTEGER NOT NULL DEFAULT 0,
    tur_cerrado        BOOLEAN NOT NULL DEFAULT FALSE,
    tur_sync_ts        BIGINT  NOT NULL DEFAULT 0,    -- último timestamp enviado por gRPC (regla monotónica)
    CONSTRAINT uq_turno_horario_fecha UNIQUE (hor_id, tur_fecha),
    CONSTRAINT turno_cupos_validos CHECK (tur_cupo_total > 0 AND tur_cupo_reservado >= 0
                                          AND tur_cupo_reservado <= tur_cupo_total),
    CONSTRAINT fk_turno_horario FOREIGN KEY (hor_id) REFERENCES horario (hor_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_turno_fecha ON turno (tur_fecha);

CREATE TABLE fecha_bloqueada (
    fb_id        BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    atr_id       BIGINT       NOT NULL,
    fb_fecha     DATE         NOT NULL,
    fb_motivo    VARCHAR(200) NOT NULL,
    fb_creado_en TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_fecha_bloqueada_atraccion_fecha UNIQUE (atr_id, fb_fecha),
    CONSTRAINT fk_fecha_bloqueada_atraccion FOREIGN KEY (atr_id) REFERENCES atraccion (atr_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

-- ============================================================================
--  6 · COMPRADORES Y RESERVAS
-- ============================================================================
CREATE TABLE cliente (
    cli_id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cli_tipo_documento VARCHAR(10)  NOT NULL,         -- CEDULA, PASAPORTE, RUC
    cli_documento      VARCHAR(20)  NOT NULL,
    cli_nombre         VARCHAR(150) NOT NULL,
    cli_correo         dom_correo   NOT NULL,
    cli_telefono       VARCHAR(20)  NOT NULL,
    cli_creado_en      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    cli_actualizado_en TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_cliente_documento UNIQUE (cli_tipo_documento, cli_documento),
    CONSTRAINT cliente_tipo_documento_valido CHECK (cli_tipo_documento IN ('CEDULA','PASAPORTE','RUC'))
);
CREATE INDEX ix_cliente_correo ON cliente (cli_correo);

CREATE TABLE estado_reserva (
    est_id     SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    est_codigo VARCHAR(20) NOT NULL UNIQUE,
    est_nombre VARCHAR(50) NOT NULL,
    est_final  BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE SEQUENCE seq_orden_externa START 1000;

CREATE TABLE reserva (
    res_id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    res_uuid            UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    res_codigo          VARCHAR(12)  NOT NULL UNIQUE,          -- localizador PNR
    res_orden_externa   VARCHAR(20)  NOT NULL UNIQUE,          -- external_order_id del contrato
    res_booking_id      VARCHAR(40)  UNIQUE,                   -- booking_reservation_id (si viene de Booking)
    tur_id              BIGINT       NOT NULL,
    cli_id              BIGINT       NOT NULL,
    est_id              SMALLINT     NOT NULL,
    gui_id              BIGINT,
    res_metodo_pago     VARCHAR(20),
    res_requerimientos  VARCHAR(500),
    res_motivo_cancelacion VARCHAR(255),
    res_creado_en       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    res_actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    res_confirmado_en   TIMESTAMPTZ,
    res_checkin_en      TIMESTAMPTZ,
    res_cancelado_en    TIMESTAMPTZ,
    CONSTRAINT reserva_metodo_pago_valido
        CHECK (res_metodo_pago IS NULL OR res_metodo_pago IN ('CREDIT_CARD','DEBIT_CARD','PAYPAL','TRANSFER','BOOKING_GATEWAY','ON_SITE')),
    CONSTRAINT fk_reserva_turno FOREIGN KEY (tur_id) REFERENCES turno (tur_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_cliente FOREIGN KEY (cli_id) REFERENCES cliente (cli_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_estado FOREIGN KEY (est_id) REFERENCES estado_reserva (est_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_guia FOREIGN KEY (gui_id) REFERENCES guia (gui_id)
        ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX ix_reserva_tur_id ON reserva (tur_id);
CREATE INDEX ix_reserva_cli_id ON reserva (cli_id);
CREATE INDEX ix_reserva_est_id ON reserva (est_id);
CREATE INDEX ix_reserva_creado ON reserva (res_creado_en DESC);

-- Un renglón por tipo de boleto: cantidad y precio congelado al comprar.
CREATE TABLE reserva_boleto (
    res_id          BIGINT      NOT NULL,
    bol_tipo        VARCHAR(20) NOT NULL,
    bol_cantidad    INTEGER     NOT NULL,
    bol_precio_unit dom_importe NOT NULL,
    CONSTRAINT pk_reserva_boleto PRIMARY KEY (res_id, bol_tipo),
    CONSTRAINT reserva_boleto_tipo_valido CHECK (bol_tipo IN ('ADULTO','NINO','MAYOR','INFANTE','ESTUDIANTE')),
    CONSTRAINT reserva_boleto_cantidad_valida CHECK (bol_cantidad > 0),
    CONSTRAINT fk_reserva_boleto_reserva FOREIGN KEY (res_id) REFERENCES reserva (res_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE reembolso (
    rem_id        BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    res_id        BIGINT      NOT NULL UNIQUE,
    rem_numero    VARCHAR(30) NOT NULL UNIQUE,
    rem_monto     dom_importe NOT NULL,
    rem_creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_reembolso_reserva FOREIGN KEY (res_id) REFERENCES reserva (res_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Reseña de una reserva (compra verificada). La atracción se deduce por reserva->turno->horario.
-- Escala 1-10 para coincidir con el contrato (score 9.8, breakdown 1 a 10).
CREATE TABLE resena (
    rsn_id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    res_id             BIGINT        NOT NULL UNIQUE,
    rsn_limpieza       SMALLINT      NOT NULL,
    rsn_servicio       SMALLINT      NOT NULL,
    rsn_calidad_precio SMALLINT      NOT NULL,
    rsn_puntualidad    SMALLINT      NOT NULL,
    rsn_comentario     VARCHAR(1000) NOT NULL,
    rsn_visible        BOOLEAN       NOT NULL DEFAULT TRUE,
    rsn_creado_en      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT resena_limpieza_valida CHECK (rsn_limpieza BETWEEN 1 AND 10),
    CONSTRAINT resena_servicio_valido CHECK (rsn_servicio BETWEEN 1 AND 10),
    CONSTRAINT resena_calidad_precio_valida CHECK (rsn_calidad_precio BETWEEN 1 AND 10),
    CONSTRAINT resena_puntualidad_valida CHECK (rsn_puntualidad BETWEEN 1 AND 10),
    CONSTRAINT fk_resena_reserva FOREIGN KEY (res_id) REFERENCES reserva (res_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

-- ============================================================================
--  7 · ACUERDO B2B DE PROMOCIONES (contrato: /atracciones/promociones/contrato)
--      Una sola fila: la cátedra pide formalizarlo "una sola vez".
-- ============================================================================
CREATE TABLE acuerdo_promocion (
    acp_id                 SMALLINT     PRIMARY KEY DEFAULT 1,
    acp_permite            BOOLEAN      NOT NULL DEFAULT FALSE,
    acp_descuento_maximo   NUMERIC(5,2) NOT NULL DEFAULT 0,
    acp_fecha_acuerdo      DATE         NOT NULL DEFAULT CURRENT_DATE,
    acp_vigencia_hasta     DATE,
    acp_condiciones        VARCHAR(500),
    acp_contacto_nombre    VARCHAR(120),
    acp_contacto_correo    dom_correo,
    acp_contacto_telefono  VARCHAR(20),
    CONSTRAINT acuerdo_unico CHECK (acp_id = 1),
    CONSTRAINT acuerdo_descuento_valido CHECK (acp_descuento_maximo BETWEEN 0 AND 50)
);

CREATE TABLE acuerdo_promocion_destino (
    acp_id SMALLINT NOT NULL DEFAULT 1,
    ciu_id SMALLINT NOT NULL,
    CONSTRAINT pk_acuerdo_promocion_destino PRIMARY KEY (acp_id, ciu_id),
    CONSTRAINT fk_acuerdo_destino_acuerdo FOREIGN KEY (acp_id) REFERENCES acuerdo_promocion (acp_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_acuerdo_destino_ciudad FOREIGN KEY (ciu_id) REFERENCES ciudad (ciu_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

-- ============================================================================
--  8 · IDEMPOTENCIA Y OUTBOX (patrones de las semanas 5-8)
-- ============================================================================
CREATE TABLE idempotencia (
    idem_clave        UUID         NOT NULL,
    idem_operacion    VARCHAR(150) NOT NULL,
    idem_request_hash VARCHAR(64)  NOT NULL,
    idem_estado       VARCHAR(12)  NOT NULL DEFAULT 'IN_PROGRESS',
    idem_http_status  SMALLINT,
    idem_response     JSONB,
    idem_expira_en    TIMESTAMPTZ  NOT NULL,
    idem_creado_en    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT pk_idempotencia PRIMARY KEY (idem_clave, idem_operacion),
    CONSTRAINT idempotencia_estado_valido CHECK (idem_estado IN ('IN_PROGRESS','DONE'))
);
CREATE INDEX ix_idempotencia_expira_en ON idempotencia (idem_expira_en);

CREATE TABLE outbox_evento (
    evt_id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    evt_uuid           UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    evt_tipo           VARCHAR(30)  NOT NULL,
    evt_aggregate_id   VARCHAR(60)  NOT NULL,
    evt_correlation_id VARCHAR(80),
    evt_payload        JSONB        NOT NULL,
    evt_creado_en      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    evt_publicado_en   TIMESTAMPTZ,            -- para STOCK_ACTUALIZADO: enviado por gRPC a Booking
    evt_intentos       SMALLINT     NOT NULL DEFAULT 0,
    evt_proximo_intento TIMESTAMPTZ NOT NULL DEFAULT now(),   -- espera exponencial entre reintentos gRPC
    evt_ultimo_error   VARCHAR(300),
    CONSTRAINT evento_tipo_valido CHECK (evt_tipo IN ('RESERVA_CREADA','RESERVA_CONFIRMADA','STOCK_ACTUALIZADO','RESERVA_CANCELADA'))
);
CREATE INDEX ix_outbox_pendientes ON outbox_evento (evt_proximo_intento, evt_id) WHERE evt_publicado_en IS NULL AND evt_tipo = 'STOCK_ACTUALIZADO';
CREATE INDEX ix_outbox_tipo ON outbox_evento (evt_tipo, evt_id);

-- ============================================================================
--  9 · DISPARADORES DE MANTENIMIENTO
-- ============================================================================
CREATE TRIGGER trg_usuario_actualizado   BEFORE UPDATE ON usuario   FOR EACH ROW EXECUTE FUNCTION fn_actualizar_timestamp('usu_actualizado_en');
CREATE TRIGGER trg_operador_actualizado  BEFORE UPDATE ON operador  FOR EACH ROW EXECUTE FUNCTION fn_actualizar_timestamp('ope_actualizado_en');
CREATE TRIGGER trg_atraccion_actualizado BEFORE UPDATE ON atraccion FOR EACH ROW EXECUTE FUNCTION fn_actualizar_timestamp('atr_actualizado_en');
CREATE TRIGGER trg_cliente_actualizado   BEFORE UPDATE ON cliente   FOR EACH ROW EXECUTE FUNCTION fn_actualizar_timestamp('cli_actualizado_en');
CREATE TRIGGER trg_reserva_actualizado   BEFORE UPDATE ON reserva   FOR EACH ROW EXECUTE FUNCTION fn_actualizar_timestamp('res_actualizado_en');

-- ============================================================================
--  10 · VISTAS (datos derivados, nunca almacenados)
-- ============================================================================
-- Disponibilidad con slot_id derivado y estado operativo. Umbral de "últimos cupos": 3 (contrato OpenAPI).
CREATE VIEW v_turno_disponibilidad AS
SELECT t.tur_id, h.atr_id, t.tur_fecha, h.hor_hora,
       'slot-' || to_char(t.tur_fecha, 'YYYYMMDD') || '-' || to_char(h.hor_hora, 'HH24MI') AS slot_id,
       t.tur_cupo_total,
       CASE WHEN t.tur_cerrado THEN 0 ELSE t.tur_cupo_total - t.tur_cupo_reservado END AS cupos_disponibles,
       CASE WHEN t.tur_cerrado OR t.tur_cupo_total - t.tur_cupo_reservado <= 0 THEN 'AGOTADO'
            WHEN t.tur_cupo_total - t.tur_cupo_reservado <= 3 THEN 'ULTIMOS_CUPOS'
            ELSE 'DISPONIBLE' END AS estado,
       t.tur_cerrado, h.hor_activo
FROM turno t JOIN horario h ON h.hor_id = t.hor_id;

-- Calificación por atracción (promedios 1-10) calculada desde las reseñas.
CREATE VIEW v_atraccion_rating AS
SELECT h.atr_id,
       COUNT(r.rsn_id)                                             AS review_count,
       ROUND(AVG((r.rsn_limpieza + r.rsn_servicio + r.rsn_calidad_precio + r.rsn_puntualidad) / 4.0), 1) AS score,
       ROUND(AVG(r.rsn_limpieza), 1)       AS limpieza,
       ROUND(AVG(r.rsn_servicio), 1)       AS servicio,
       ROUND(AVG(r.rsn_calidad_precio), 1) AS calidad_precio,
       ROUND(AVG(r.rsn_puntualidad), 1)    AS puntualidad
FROM resena r
JOIN reserva rv ON rv.res_id = r.res_id
JOIN turno t    ON t.tur_id  = rv.tur_id
JOIN horario h  ON h.hor_id  = t.hor_id
WHERE r.rsn_visible
GROUP BY h.atr_id;

-- Total y cantidad de boletos por reserva (se suman, no se guardan).
CREATE VIEW v_reserva_total AS
SELECT res_id, SUM(bol_cantidad)::int AS total_boletos,
       SUM(bol_cantidad * bol_precio_unit)::numeric(12,2) AS total_precio
FROM reserva_boleto GROUP BY res_id;

-- Tarifa vigente hoy por atracción y tipo.
CREATE VIEW v_tarifa_vigente AS
SELECT DISTINCT ON (atr_id, tar_tipo) atr_id, tar_tipo, tar_precio, tar_moneda
FROM tarifa
WHERE tar_vigente_desde <= CURRENT_DATE AND (tar_vigente_hasta IS NULL OR tar_vigente_hasta >= CURRENT_DATE)
ORDER BY atr_id, tar_tipo, tar_vigente_desde DESC;
