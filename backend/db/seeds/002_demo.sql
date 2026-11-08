-- Datos de demostración (solo desarrollo). Fechas relativas a hoy.
INSERT INTO operador (ope_nombre, ope_ruc, ope_correo, ope_telefono, prov_id)
SELECT 'Ecuador Aventura Tours', '1790000000001', 'info@ecuadoraventura.test', '+593999999999', prov_id
FROM provincia WHERE prov_codigo='17'
ON CONFLICT (ope_ruc) DO NOTHING;

INSERT INTO atraccion (atr_codigo, atr_slug, atr_nombre, atr_descripcion, atr_descripcion_corta, atr_tipo, atr_estado,
  ciu_id, ope_id, atr_direccion, atr_punto_encuentro, atr_latitud, atr_longitud, atr_duracion_horas,
  atr_cancelacion_gratuita, atr_destacada, atr_incluye_guia, atr_incluye_transporte)
SELECT v.cod, v.slug, v.nom, v.des, v.cor, v.tipo, 'PUBLICADA', c.ciu_id, o.ope_id, v.dir, v.enc, v.lat, v.lon, v.dur, (v.cod IN ('PRhu4UBTWPBC','CUcajas00001')), v.dest, true, true
FROM (VALUES
 ('PRhu4UBTWPBC','tour-centro-historico-quito','Tour Centro Histórico de Quito','Recorrido a pie por plazas, iglesias y calles coloniales declaradas Patrimonio de la Humanidad.','Centro histórico a pie','GUIDED_TOUR','Quito','Plaza Grande, Quito','Frente al Palacio de Carondelet',-0.220000,-78.512000,3.0,true),
 ('QTpichinch01','teleferico-pichincha','Teleférico y volcán Pichincha','Ascenso en teleférico hasta 4.000 m con vistas a Quito.','Vistas desde 4.000 m','ADMISSION','Quito','Av. Occidental, Quito','Estación base del teleférico',-0.188000,-78.518000,4.0,false),
 ('GYmalecon001','malecon-2000-guayaquil','Malecón 2000 y Las Peñas','Paseo por el malecón del río Guayas y el barrio Las Peñas.','Malecón y Las Peñas','GUIDED_TOUR','Guayaquil','Malecón Simón Bolívar','Reloj del Malecón',-2.193000,-79.880000,3.0,false),
 ('CUcajas00001','parque-nacional-cajas','Parque Nacional Cajas','Excursión de un día por lagunas de páramo en Cajas.','Lagunas de páramo','DAY_TRIP','Cuenca','Parque Calderón, Cuenca','Parque Calderón',-2.790000,-79.240000,8.0,true),
 ('GPtortugas01','snorkel-tortugas-galapagos','Snorkel con tortugas en Galápagos','Snorkel guiado en bahía con tortugas y lobos marinos.','Snorkel guiado','GUIDED_TOUR','San Cristóbal','Muelle de San Cristóbal','Muelle principal',-0.900000,-89.610000,4.0,false)
) v(cod,slug,nom,des,cor,tipo,ciun,dir,enc,lat,lon,dur,dest)
JOIN ciudad c ON c.ciu_nombre=v.ciun
CROSS JOIN LATERAL (SELECT ope_id FROM operador WHERE ope_ruc='1790000000001') o
ON CONFLICT (atr_codigo) DO NOTHING;

INSERT INTO tarifa (atr_id, tar_tipo, tar_precio)
SELECT a.atr_id, t.tipo, round(b.base * t.f, 2)
FROM atraccion a
JOIN (VALUES ('PRhu4UBTWPBC',25.00),('QTpichinch01',30.00),('GYmalecon001',15.00),('CUcajas00001',45.00),('GPtortugas01',80.00)) b(cod,base) ON b.cod=a.atr_codigo
CROSS JOIN (VALUES ('ADULTO',1.0),('NINO',0.5),('MAYOR',0.7),('INFANTE',0.0),('ESTUDIANTE',0.8)) t(tipo,f)
ON CONFLICT DO NOTHING;

INSERT INTO horario (atr_id, hor_hora, hor_cupo)
SELECT a.atr_id, h.hora::time, 20 FROM atraccion a
CROSS JOIN (VALUES ('09:00'),('10:30'),('14:00')) h(hora)
ON CONFLICT DO NOTHING;

INSERT INTO turno (hor_id, tur_fecha, tur_cupo_total)
SELECT h.hor_id, d::date, h.hor_cupo FROM horario h
CROSS JOIN generate_series(CURRENT_DATE + 1, CURRENT_DATE + 30, interval '1 day') d
ON CONFLICT DO NOTHING;

INSERT INTO atraccion_categoria (atr_id, cat_id)
SELECT a.atr_id, c.cat_id FROM atraccion a JOIN categoria c ON c.cat_slug =
  CASE a.atr_codigo WHEN 'PRhu4UBTWPBC' THEN 'cultura-historia' WHEN 'GYmalecon001' THEN 'cultura-historia'
  WHEN 'GPtortugas01' THEN 'galapagos' ELSE 'naturaleza-aventura' END
ON CONFLICT DO NOTHING;
INSERT INTO atraccion_idioma (atr_id, idi_id) SELECT a.atr_id, i.idi_id FROM atraccion a CROSS JOIN idioma i WHERE i.idi_codigo IN ('es','en') ON CONFLICT DO NOTHING;
INSERT INTO atraccion_foto (atr_id, fot_url, fot_alt, fot_orden)
SELECT atr_id, 'https://picsum.photos/seed/'||atr_codigo||'/1200/800', 'Foto de '||atr_nombre, 0 FROM atraccion
WHERE NOT EXISTS (SELECT 1 FROM atraccion_foto f WHERE f.atr_id=atraccion.atr_id);

INSERT INTO guia (ope_id, gui_nombre, gui_licencia)
SELECT ope_id, 'Carlos Morales', 'MINTUR-5541' FROM operador WHERE ope_ruc='1790000000001'
ON CONFLICT (gui_licencia) DO NOTHING;
