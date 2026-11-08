-- Datos base. Idempotente: se puede ejecutar varias veces.
INSERT INTO region (reg_nombre, reg_codigo) VALUES
 ('Costa','CO'),('Sierra','SI'),('Amazonía','AM'),('Insular','IN')
ON CONFLICT (reg_codigo) DO NOTHING;

-- Las 24 provincias con su código INEC (DPA). Verificar contra la tabla oficial del INEC antes de producción.
INSERT INTO provincia (prov_nombre, prov_codigo, reg_id)
SELECT v.n, v.c, r.reg_id FROM (VALUES
 ('Azuay','01','SI'),('Bolívar','02','SI'),('Cañar','03','SI'),('Carchi','04','SI'),('Cotopaxi','05','SI'),('Chimborazo','06','SI'),
 ('El Oro','07','CO'),('Esmeraldas','08','CO'),('Guayas','09','CO'),('Imbabura','10','SI'),('Loja','11','SI'),('Los Ríos','12','CO'),
 ('Manabí','13','CO'),('Morona Santiago','14','AM'),('Napo','15','AM'),('Pastaza','16','AM'),('Pichincha','17','SI'),('Tungurahua','18','SI'),
 ('Zamora Chinchipe','19','AM'),('Galápagos','20','IN'),('Sucumbíos','21','AM'),('Orellana','22','AM'),
 ('Santo Domingo de los Tsáchilas','23','CO'),('Santa Elena','24','CO')
) v(n,c,rc) JOIN region r ON r.reg_codigo = v.rc
ON CONFLICT (prov_codigo) DO NOTHING;

INSERT INTO ciudad (ciu_nombre, prov_id, ciu_descripcion)
SELECT v.n, p.prov_id, v.d FROM (VALUES
 ('Quito','17','Capital, Centro Histórico Patrimonio de la Humanidad.'),
 ('Guayaquil','09','Puerto principal y mayor ciudad del país.'),
 ('Cuenca','01','Ciudad patrimonial de los Andes australes.'),
 ('Manta','13','Playas, puerto atunero y gastronomía marina.'),
 ('Latacunga','05','Puerta de entrada al Cotopaxi y la Ruta del Quilotoa.'),
 ('Esmeraldas','08','Playas del norte y cultura afroecuatoriana.'),
 ('Lago Agrio','21','Acceso a la Reserva Cuyabeno.'),
 ('Macas','14','Entrada al Parque Nacional Sangay.'),
 ('Tena','15','Capital de la aventura y los ríos amazónicos.'),
 ('Coca','22','Puerta al Parque Nacional Yasuní y río Napo.'),
 ('Loja','11','Ciudad musical; aeropuerto en Catamayo.'),
 ('Baltra','20','Aeropuerto de Galápagos (isla Baltra).'),
 ('San Cristóbal','20','Capital de Galápagos.')
) v(n,pc,d)
JOIN provincia p ON p.prov_codigo = v.pc
ON CONFLICT (prov_id, ciu_nombre) DO NOTHING;

-- Aeropuertos (verificar servicio comercial vigente antes de producción; ver informe)
INSERT INTO aeropuerto (apt_nombre, apt_iata, apt_icao, ciu_id)
SELECT v.n, v.i, v.o, c.ciu_id FROM (VALUES
 ('Aeropuerto Internacional Mariscal Sucre','UIO','SEQM','Quito'),
 ('Aeropuerto Internacional José Joaquín de Olmedo','GYE','SEGU','Guayaquil'),
 ('Aeropuerto Internacional Mariscal Lamar','CUE','SECU','Cuenca'),
 ('Aeropuerto Internacional Eloy Alfaro','MEC','SEMT','Manta'),
 ('Aeropuerto Internacional Cotopaxi','LTX','SELT','Latacunga'),
 ('Aeropuerto General Rivadeneira','ESM','SETN','Esmeraldas'),
 ('Aeropuerto Lago Agrio','LGQ','SENL','Lago Agrio'),
 ('Aeropuerto Edmundo Carvajal','XMS','SEMC','Macas'),
 ('Aeropuerto Jumandy','TNW','SENP','Tena'),
 ('Aeropuerto Francisco de Orellana','OCC','SECO','Coca'),
 ('Aeropuerto Camilo Ponce Enríquez','LOH','SECA','Loja'),
 ('Aeropuerto Internacional Seymour','GPS','SEGS','Baltra'),
 ('Aeropuerto San Cristóbal','SCY','SESC','San Cristóbal')
) v(n,i,o,cn) JOIN ciudad c ON c.ciu_nombre = v.cn
ON CONFLICT (apt_iata) DO NOTHING;

INSERT INTO rol (rol_nombre, rol_descripcion) VALUES
 ('ADMIN','Administrador de la plataforma: gestiona todo'),
 ('OPERADOR','Operador turístico: gestiona sus atracciones'),
 ('CLIENTE','Turista registrado')
ON CONFLICT (rol_nombre) DO NOTHING;

INSERT INTO estado_reserva (est_codigo, est_nombre, est_final) VALUES
 ('PENDING','Pendiente de confirmación',false),
 ('CONFIRMED','Confirmada',false),
 ('CHECKED_IN','Check-in realizado',false),
 ('COMPLETED','Completada',true),
 ('CANCELLED','Cancelada',true),
 ('EXPIRED','Expirada',true)
ON CONFLICT (est_codigo) DO NOTHING;

INSERT INTO idioma (idi_codigo, idi_nombre) VALUES
 ('es','Español'),('en','Inglés'),('fr','Francés'),('de','Alemán'),('qu','Kichwa')
ON CONFLICT (idi_codigo) DO NOTHING;

INSERT INTO categoria (cat_nombre, cat_slug, cat_descripcion, cat_icono, cat_orden, cat_incluye_guia) VALUES
 ('Naturaleza y aventura','naturaleza-aventura','Volcanes, selva, senderismo','mountain',1,true),
 ('Cultura e historia','cultura-historia','Museos, centros históricos','landmark',2,true),
 ('Playa y mar','playa-mar','Costa y buceo','waves',3,false),
 ('Gastronomía','gastronomia','Rutas del cacao, café y cocina local','utensils',4,false),
 ('Galápagos','galapagos','Fauna endémica y snorkel','turtle',5,true)
ON CONFLICT (cat_slug) DO NOTHING;

INSERT INTO inclusion (inc_tipo, inc_nombre) VALUES
 ('INCLUYE','Guía bilingüe'),('INCLUYE','Transporte'),('INCLUYE','Entradas'),('INCLUYE','Seguro de viaje'),
 ('NO_INCLUYE','Almuerzo'),('NO_INCLUYE','Propinas')
ON CONFLICT DO NOTHING;

INSERT INTO acuerdo_promocion (acp_id, acp_permite, acp_descuento_maximo, acp_vigencia_hasta, acp_condiciones)
VALUES (1, true, 20, CURRENT_DATE + 365, 'Descuento máximo 20% aplicable a precio base de adultos')
ON CONFLICT (acp_id) DO NOTHING;
INSERT INTO acuerdo_promocion_destino (acp_id, ciu_id)
SELECT 1, ciu_id FROM ciudad WHERE ciu_nombre IN ('Quito','Guayaquil','Cuenca')
ON CONFLICT DO NOTHING;
