// Carga atracciones reales de las ciudades con aeropuerto, usando la API de administración (la misma que usa el panel).
// Uso:  node deploy\cargar-atracciones.mjs            (pide correo y contraseña del Administrador Sistema)
//       node deploy\cargar-atracciones.mjs --simular  (solo muestra lo que cargaría, sin conectarse)
// Es seguro repetirlo: las atracciones que ya existen (mismo nombre) se omiten.
import readline from 'node:readline/promises';

const BASE = process.env.API_URL ?? 'https://alisson-atracciones-api.azurewebsites.net/api/v3';
const SIMULAR = process.argv.includes('--simular');
const DIAS = 60; // días de turnos que se generan desde mañana

// [ciudad, nombre, tipo, categoría, horas, adulto USD, latitud, longitud, punto de encuentro, descripción]
// Precios y horarios son valores de demostración del prototipo. Coordenadas aproximadas del sitio.
const NATURA = 'naturaleza-aventura', CULT = 'cultura-historia', PLAYA = 'playa-mar', GAL = 'galapagos', GASTRO = 'gastronomia';
const A = [
  ['Quito', 'Mitad del Mundo y Museo Intiñan', 'ADMISSION', CULT, 3, 12, -0.0022, -78.4558, 'Entrada principal de la Ciudad Mitad del Mundo', 'Visita al monumento de la Mitad del Mundo, en San Antonio de Pichincha, y a los museos de la línea ecuatorial.'],
  ['Quito', 'Basílica del Voto Nacional', 'ADMISSION', CULT, 1.5, 8, -0.2142, -78.5122, 'Entrada de la Basílica, calle Carchi', 'Mayor templo neogótico de América; se sube a sus torres con vista al centro de Quito.'],
  ['Quito', 'Mirador del Panecillo y Virgen de Quito', 'GUIDED_TOUR', CULT, 2, 10, -0.2295, -78.5192, 'Base del Panecillo, calle García Moreno', 'Recorrido al mirador de la loma del Panecillo, con la escultura de la Virgen de Quito y vistas de la ciudad.'],
  ['Quito', 'Bosque nublado de Mindo', 'DAY_TRIP', NATURA, 9, 55, -0.0505, -78.7766, 'Terminal Carcelén, Quito', 'Excursión de un día a Mindo para caminatas, cascadas y observación de aves en el bosque nublado del noroccidente.'],
  ['Guayaquil', 'Parque Seminario (Parque de las Iguanas)', 'GUIDED_TOUR', CULT, 1.5, 8, -2.1946, -79.8836, 'Frente a la Catedral Metropolitana', 'Paseo por el parque histórico del centro, famoso por sus iguanas, junto a la Catedral.'],
  ['Guayaquil', 'Cerro Santa Ana y Barrio Las Peñas', 'GUIDED_TOUR', CULT, 2, 10, -2.1893, -79.877, 'Inicio de la escalinata, calle Numa Pompilio Llona', 'Ascenso por la escalinata del Cerro Santa Ana hasta el faro y la capilla, con vista al río Guayas.'],
  ['Guayaquil', 'Parque Histórico Guayaquil', 'ADMISSION', CULT, 3, 6, -2.1456, -79.8651, 'Entrada principal del parque, Samborondón', 'Parque con zonas de vida silvestre, arquitectura tradicional y tradiciones montubias.'],
  ['Guayaquil', 'Isla Santay', 'DAY_TRIP', NATURA, 4, 14, -2.218, -79.849, 'Muelle del Malecón del Río (Guayaquil)', 'Visita a la isla en el río Guayas: puente peatonal, senderos, aves y comunidad de pescadores.'],
  ['Cuenca', 'Parque Calderón y Catedral de la Inmaculada', 'GUIDED_TOUR', CULT, 2, 10, -2.8975, -79.0049, 'Parque Calderón, frente a la Catedral Nueva', 'Recorrido por el centro histórico de Cuenca, Patrimonio de la Humanidad, con visita a la Catedral Nueva.'],
  ['Cuenca', 'Museo Pumapungo y parque arqueológico', 'ADMISSION', CULT, 2, 5, -2.9062, -78.997, 'Entrada del Museo, calle Larga y Huayna Cápac', 'Museo del Banco Central con colecciones etnográficas, el parque arqueológico de Pumapungo y su jardín de plantas andinas.'],
  ['Cuenca', 'Mirador de Turi', 'GUIDED_TOUR', CULT, 2, 8, -2.9308, -79.0, 'Plaza de San Sebastián, Cuenca', 'Visita al mirador de Turi con vista panorámica de la ciudad y su iglesia.'],
  ['Cuenca', 'Complejo Arqueológico de Ingapirca', 'DAY_TRIP', CULT, 8, 40, -2.5436, -78.8733, 'Parque Calderón, Cuenca', 'Excursión al mayor complejo arqueológico inca del Ecuador, con el Templo del Sol, en la provincia del Cañar.'],
  ['Manta', 'Playa Murciélago', 'ADMISSION', PLAYA, 3, 5, -0.9477, -80.743, 'Entrada de la playa, avenida Malecón', 'Tarde de playa en la bahía de Manta, con oleaje suave y gastronomía marina.'],
  ['Manta', 'Montecristi y sombreros de paja toquilla', 'GUIDED_TOUR', CULT, 4, 18, -1.046, -80.66, 'Parque Central de Montecristi', 'Visita al pueblo de Montecristi, cuna del sombrero de paja toquilla, con taller artesanal y Ciudad Alfaro.'],
  ['Manta', 'Isla de la Plata, Parque Nacional Machalilla', 'DAY_TRIP', NATURA, 10, 75, -1.2703, -81.0746, 'Muelle de Puerto López', 'Excursión desde Puerto López a la isla, con caminata para ver piqueros de patas azules y snorkel.'],
  ['Latacunga', 'Parque Nacional Cotopaxi', 'DAY_TRIP', NATURA, 8, 45, -0.684, -78.436, 'Parque Vicente León, Latacunga', 'Excursión al Parque Nacional Cotopaxi: laguna de Limpiopungo, museo de sitio y vistas del volcán.'],
  ['Latacunga', 'Laguna del Quilotoa', 'DAY_TRIP', NATURA, 9, 40, -0.85, -78.9, 'Parque Vicente León, Latacunga', 'Excursión a la laguna de cráter del Quilotoa, con mirador y descenso opcional a la orilla.'],
  ['Latacunga', 'Mercado indígena de Saquisilí', 'GUIDED_TOUR', GASTRO, 4, 20, -0.8394, -78.6676, 'Plaza Gran Colombia, Saquisilí', 'Visita al mercado indígena de los jueves, uno de los más grandes de la Sierra, con productos y comida local.'],
  ['Esmeraldas', 'Playa de Atacames', 'ADMISSION', PLAYA, 4, 6, 0.87, -79.847, 'Malecón de Atacames', 'Día de playa en Atacames, uno de los balnearios más visitados de la costa norte.'],
  ['Esmeraldas', 'Playa de Same', 'DAY_TRIP', PLAYA, 6, 22, 0.8625, -79.8087, 'Parque Central de Atacames', 'Excursión a la playa de Same, de arena amplia y ambiente más tranquilo.'],
  ['Esmeraldas', 'Mompiche y su rompiente', 'DAY_TRIP', PLAYA, 8, 35, 0.513, -80.024, 'Terminal terrestre de Esmeraldas', 'Viaje de día a Mompiche, pueblo costero conocido por sus olas y su paisaje de acantilados.'],
  ['Lago Agrio', 'Reserva de Producción de Fauna Cuyabeno', 'DAY_TRIP', NATURA, 10, 70, -0.1, -76.2, 'Terminal terrestre de Lago Agrio', 'Excursión a Cuyabeno: paseo en canoa por lagunas amazónicas con observación de aves y fauna.'],
  ['Lago Agrio', 'Cascada de San Rafael', 'DAY_TRIP', NATURA, 9, 50, -0.1, -77.58, 'Terminal terrestre de Lago Agrio', 'Excursión a la cascada más alta del país, en el límite entre Napo y Sucumbíos, con sendero entre selva.'],
  ['Macas', 'Catedral de Macas y mirador del río Upano', 'GUIDED_TOUR', CULT, 2, 8, -2.3086, -78.1167, 'Parque Central de Macas', 'Recorrido por la Catedral de Macas, con vitrales de la cultura shuar, y el mirador del río Upano.'],
  ['Macas', 'Parque Nacional Sangay (lagunas de Atillo)', 'DAY_TRIP', NATURA, 9, 45, -2.2, -78.5, 'Parque Central de Macas', 'Excursión a la zona de páramo y lagunas del Parque Nacional Sangay.'],
  ['Tena', 'Parque Amazónico La Isla', 'ADMISSION', NATURA, 2, 6, -0.9936, -77.8112, 'Entrada del parque, ribera del río Tena', 'Sendero ecológico sobre una isla en la confluencia de los ríos Tena y Pano, con fauna amazónica.'],
  ['Tena', 'Rafting en el río Jatunyacu', 'GUIDED_TOUR', NATURA, 4, 45, -1.0, -77.8, 'Oficina de turismo de Tena', 'Descenso en balsa por rápidos del río, con guía y equipo de seguridad.'],
  ['Tena', 'Cavernas de Jumandy', 'ADMISSION', NATURA, 3, 8, -0.9536, -77.782, 'Entrada de las cavernas, vía Archidona', 'Visita a las cavernas de la zona de Archidona, con recorrido guiado por su interior.'],
  ['Coca', 'Crucero por el río Napo', 'GUIDED_TOUR', NATURA, 4, 35, -0.465, -76.987, 'Malecón de Puerto Francisco de Orellana (Coca)', 'Paseo en bote por el río Napo, con observación de aves y comunidades ribereñas.'],
  ['Coca', 'Parque Nacional Yasuní', 'DAY_TRIP', NATURA, 10, 85, -1.0, -76.0, 'Muelle de Coca', 'Excursión a un sector del Parque Nacional Yasuní, una de las zonas de mayor biodiversidad del planeta.'],
  ['Loja', 'Parque Nacional Podocarpus', 'DAY_TRIP', NATURA, 8, 35, -4.115, -79.177, 'Parque Central de Loja', 'Excursión al sector Cajanuma del Parque Nacional Podocarpus, con senderos de bosque de neblina.'],
  ['Loja', 'Puerta de la Ciudad y centro histórico', 'GUIDED_TOUR', CULT, 2, 8, -3.9925, -79.2068, 'Plaza de la Independencia, Loja', 'Recorrido por el centro de Loja, ciudad musical del Ecuador, con visita a la Puerta de la Ciudad.'],
  ['Loja', 'Valle de Vilcabamba', 'DAY_TRIP', NATURA, 8, 40, -4.261, -79.222, 'Parque Central de Loja', 'Excursión al valle de Vilcabamba, conocido por su clima templado y sus senderos.'],
  ['Baltra', 'Isla Seymour Norte', 'DAY_TRIP', GAL, 5, 95, -0.4, -90.28, 'Muelle de Baltra', 'Visita a la isla para ver fragatas, piqueros de patas azules e iguanas terrestres.'],
  ['Baltra', 'Isla Bartolomé', 'DAY_TRIP', GAL, 9, 130, -0.2833, -90.55, 'Muelle de Baltra', 'Excursión a Bartolomé: ascenso al mirador de Pinnacle Rock y snorkel en la bahía.'],
  ['San Cristóbal', 'Kicker Rock (León Dormido)', 'DAY_TRIP', GAL, 8, 140, -0.777, -89.517, 'Muelle de Puerto Baquerizo Moreno', 'Navegación hasta el islote de Kicker Rock y snorkel en el canal con tiburones, rayas y tortugas.'],
  ['San Cristóbal', 'Playa Lobería', 'ADMISSION', GAL, 3, 5, -0.915, -89.6, 'Terminal de buses, Puerto Baquerizo Moreno', 'Visita a la playa con colonia de lobos marinos, a pocos minutos del aeropuerto.'],
  ['San Cristóbal', 'Centro de Interpretación de Galápagos', 'ADMISSION', GAL, 2, 5, -0.902, -89.615, 'Entrada del Centro, Puerto Baquerizo Moreno', 'Museo sobre la historia natural y humana de Galápagos, con senderos hacia la bahía.'],
];

const cuerpo = ([ciudad, nombre, tipo, cat, horas, adulto, lat, lon, enc, desc]) => ({ ciudad, cat, adulto, body: {
  nombre, descripcion: desc, descripcion_corta: desc.split(/[.:]/)[0].slice(0, 120), tipo, duracion_horas: horas, latitud: lat, longitud: lon, punto_encuentro: enc,
  cancelacion_gratuita: true, horas_cancelacion: 24, incluye_guia: tipo !== 'ADMISSION', idiomas: ['es', 'en'] } });

if (SIMULAR) {
  const porCiudad = {}; for (const a of A) (porCiudad[a[0]] ??= []).push(a[1]);
  for (const [c, l] of Object.entries(porCiudad)) console.log(`${c} (${l.length}): ${l.join(' · ')}`);
  console.log(`\nTotal: ${A.length} atracciones (simulación, no se envió nada).`); process.exit(0);
}

async function api(metodo, ruta, token, body) {
  const r = await fetch(BASE + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  const t = await r.text(); const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`${metodo} ${ruta} → ${r.status} ${j?.detail ?? j?.message ?? t}`);
  return j;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const email = (await rl.question('Correo del Administrador Sistema: ')).trim();
const password = await rl.question('Contraseña (se verá al escribir): ');
rl.close();
const { access_token: tk } = await api('POST', '/auth/login', null, { email, password });

const ciudades = Object.fromEntries((await api('GET', '/admin/ciudades?limit=100', tk)).data.map((c) => [c.nombre, c.id]));
const ops = (await api('GET', '/admin/operadores?limit=100', tk)).data; if (!ops.length) throw new Error('No hay operadores registrados.');
const cats = Object.fromEntries((await api('GET', '/admin/categorias', tk)).map((c) => [c.slug, c.id]));
const existentes = new Set((await api('GET', '/admin/atracciones?limit=100', tk)).data.map((a) => a.nombre.toLowerCase()));
const mas = (n) => { const d = new Date(Date.now() - 5 * 3600e3 + n * 864e5); return d.toISOString().slice(0, 10); };
let creadas = 0, omitidas = 0, fallidas = 0;
for (const x of A.map(cuerpo)) {
  const nombre = x.body.nombre;
  if (existentes.has(nombre.toLowerCase())) { omitidas++; console.log(`= ya existe: ${nombre}`); continue; }
  try {
    if (!ciudades[x.ciudad]) throw new Error(`Ciudad no encontrada: ${x.ciudad}`);
    const a = await api('POST', '/admin/atracciones', tk, { ...x.body, ciudad_id: ciudades[x.ciudad], operador_id: ops[0].id, categorias: [cats[x.cat]].filter(Boolean) });
    await api('PUT', `/admin/atracciones/${a.id}`, tk, { tarifas: { ADULTO: x.adulto, NINO: Math.round(x.adulto * 50) / 100, ESTUDIANTE: Math.round(x.adulto * 80) / 100 } });
    for (const hora of ['09:00', '14:00']) await api('POST', `/admin/atracciones/${a.id}/horarios`, tk, { hora, cupo: 20 });
    await api('POST', `/admin/atracciones/${a.id}/turnos/generar`, tk, { desde: mas(1), hasta: mas(DIAS) });
    await api('POST', `/admin/atracciones/${a.id}/publicar`, tk);
    creadas++; console.log(`+ ${x.ciudad}: ${nombre}`);
  } catch (e) { fallidas++; console.log(`! ${nombre}: ${e.message}`); }
}
console.log(`\nListo. Creadas: ${creadas} · ya existían: ${omitidas} · con error: ${fallidas}`);
