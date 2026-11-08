-- ms_location: esquema tomado SIN cambios de reglas de 02_microservicios_v2_bases_de_datos.sql (equipo). Solo se quitó \connect/CREATE DATABASE y las extensiones innecesarias.

CREATE TABLE region (
    reg_id      SMALLINT     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reg_nombre  VARCHAR(30)  NOT NULL UNIQUE,
    reg_codigo  CHAR(2)      NOT NULL UNIQUE,
    CONSTRAINT region_nombre_no_vacio CHECK (btrim(reg_nombre) <> '')
);

CREATE TABLE provincia (
    prov_id      SMALLINT     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prov_nombre  VARCHAR(60)  NOT NULL UNIQUE,
    prov_codigo  CHAR(2)      NOT NULL UNIQUE,      -- codigo interno 01-24
    reg_id       SMALLINT     NOT NULL,
    prov_activa  BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT fk_provincia_region
        FOREIGN KEY (reg_id) REFERENCES region (reg_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_provincia_reg_id ON provincia (reg_id);

CREATE TABLE ciudad (
    ciu_id          SMALLINT     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ciu_nombre      VARCHAR(80)  NOT NULL,
    ciu_codigo      CHAR(6)      NOT NULL UNIQUE,   -- codigo INEC/DANE
    prov_id         SMALLINT     NOT NULL,
    ciu_activa      BOOLEAN      NOT NULL DEFAULT TRUE,
    ciu_descripcion VARCHAR(500),
    ciu_imagen      VARCHAR(500),
    CONSTRAINT uq_ciudad_provincia_nombre UNIQUE (prov_id, ciu_nombre),
    CONSTRAINT fk_ciudad_provincia
        FOREIGN KEY (prov_id) REFERENCES provincia (prov_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_ciudad_prov_id ON ciudad (prov_id);

INSERT INTO region (reg_nombre, reg_codigo) VALUES
    ('SIERRA',   'SI'),
    ('COSTA',    'CO'),
    ('AMAZONIA', 'AM'),
    ('GALAPAGOS','GA');

INSERT INTO provincia (prov_nombre, prov_codigo, reg_id) VALUES
    ('Azuay',                          '01', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Bolívar',                        '02', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Cañar',                          '03', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Carchi',                         '04', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Chimborazo',                     '05', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Cotopaxi',                       '06', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('El Oro',                         '07', (SELECT reg_id FROM region WHERE reg_codigo='CO')),
    ('Esmeraldas',                     '08', (SELECT reg_id FROM region WHERE reg_codigo='CO')),
    ('Galápagos',                      '09', (SELECT reg_id FROM region WHERE reg_codigo='GA')),
    ('Guayas',                         '10', (SELECT reg_id FROM region WHERE reg_codigo='CO')),
    ('Imbabura',                       '11', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Loja',                           '12', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Los Ríos',                       '13', (SELECT reg_id FROM region WHERE reg_codigo='CO')),
    ('Manabí',                         '14', (SELECT reg_id FROM region WHERE reg_codigo='CO')),
    ('Morona Santiago',                '15', (SELECT reg_id FROM region WHERE reg_codigo='AM')),
    ('Napo',                           '16', (SELECT reg_id FROM region WHERE reg_codigo='AM')),
    ('Orellana',                       '17', (SELECT reg_id FROM region WHERE reg_codigo='AM')),
    ('Pastaza',                        '18', (SELECT reg_id FROM region WHERE reg_codigo='AM')),
    ('Pichincha',                      '19', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Santa Elena',                    '20', (SELECT reg_id FROM region WHERE reg_codigo='CO')),
    ('Santo Domingo de los Tsáchilas', '21', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Sucumbíos',                      '22', (SELECT reg_id FROM region WHERE reg_codigo='AM')),
    ('Tungurahua',                     '23', (SELECT reg_id FROM region WHERE reg_codigo='SI')),
    ('Zamora Chinchipe',               '24', (SELECT reg_id FROM region WHERE reg_codigo='AM'));

INSERT INTO ciudad (ciu_nombre, ciu_codigo, prov_id) VALUES
    ('Cuenca',                 '010100', (SELECT prov_id FROM provincia WHERE prov_nombre='Azuay')),
    ('Guayaquil',              '090150', (SELECT prov_id FROM provincia WHERE prov_nombre='Guayas')),
    ('Quito',                  '170150', (SELECT prov_id FROM provincia WHERE prov_nombre='Pichincha')),
    ('Ambato',                 '180150', (SELECT prov_id FROM provincia WHERE prov_nombre='Tungurahua')),
    ('Riobamba',               '060100', (SELECT prov_id FROM provincia WHERE prov_nombre='Chimborazo')),
    ('Loja',                   '130100', (SELECT prov_id FROM provincia WHERE prov_nombre='Loja')),
    ('Puerto Baquerizo Moreno','020100', (SELECT prov_id FROM provincia WHERE prov_nombre='Galápagos')),
    ('Manta',                  '140350', (SELECT prov_id FROM provincia WHERE prov_nombre='Manabí')),
    ('Salinas',                '090300', (SELECT prov_id FROM provincia WHERE prov_nombre='Santa Elena')),
    ('La Troncal',             '030050', (SELECT prov_id FROM provincia WHERE prov_nombre='Cañar')),
    ('Ibarra',                 '100150', (SELECT prov_id FROM provincia WHERE prov_nombre='Imbabura')),
    ('Tulcan',                 '040100', (SELECT prov_id FROM provincia WHERE prov_nombre='Carchi')),
    ('Latacunga',              '050100', (SELECT prov_id FROM provincia WHERE prov_nombre='Cotopaxi')),
    ('Macas',                  '160100', (SELECT prov_id FROM provincia WHERE prov_nombre='Morona Santiago')),
    ('Puyo',                   '190150', (SELECT prov_id FROM provincia WHERE prov_nombre='Pastaza')),
    ('Archidona',              '170350', (SELECT prov_id FROM provincia WHERE prov_nombre='Napo')),
    ('Nueva Loja',             '230100', (SELECT prov_id FROM provincia WHERE prov_nombre='Sucumbíos'));


-- ============================================================================
--  4 · CATALOG & ATTRACTIONS SERVICE  (REST)
--  Tablas: categoria, operador, operador_usuario, idioma, inclusion,
--          atraccion, atraccion_categoria, atraccion_idioma,
--          atraccion_inclusion, atraccion_foto
--  Relaciones internas: categoria 1-N categoria (cat_padre_id),
--                       categoria 1-N atraccion_categoria,
--                       atraccion 1-N atraccion_categoria,
--                       atraccion 1-N atraccion_foto,
--                       operador  1-N atraccion,
--                       operador  1-N operador_usuario,
--                       atraccion 1-N atraccion_idioma, idioma 1-N atraccion_idioma,
--                       atraccion 1-N atraccion_inclusion, inclusion 1-N atraccion_inclusion
--  Referencias externas (ID logico): atraccion.ciu_id -> ciudad (Location),
--                       operador.prov_id -> provincia (Location),
--                       operador_usuario.usu_id -> usuario (Identity)
--  atr_calificacion_promedio / atr_numero_resenas se actualizan al consumir
--  el evento RESENA_PUBLICADA de Review.
-- ============================================================================
