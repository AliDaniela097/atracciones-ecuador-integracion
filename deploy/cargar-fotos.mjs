// Agrega fotos reales de Wikimedia Commons (licencias libres) a las atracciones ya publicadas.
// Uso:  node deploy\cargar-fotos.mjs --simular   (consulta Commons, muestra autor y licencia de cada foto; NO toca Azure)
//       node deploy\cargar-fotos.mjs             (pide correo y contraseña del Administrador Sistema y guarda las fotos)
// Solo acepta fotos con licencia libre (CC BY, CC BY-SA, CC0, dominio público). Crea CREDITOS-FOTOS.md con los créditos.
// Es repetible: vuelve a escribir las fotos de cada atracción sin duplicar.
import readline from 'node:readline/promises';
import { writeFileSync } from 'node:fs';

const BASE = process.env.API_URL ?? 'https://alisson-atracciones-api.azurewebsites.net/api/v3';
const SIMULAR = process.argv.includes('--simular');
const UA = { 'User-Agent': 'AtraccionesEcuador/1.0 (proyecto academico PUCE; adbasantes2@gmail.com)' };

// nombre de la atracción → archivos candidatos en Wikimedia Commons (se usa el primero que exista y tenga licencia libre)
const FOTOS = {
  'Mitad del Mundo y Museo Intiñan': ['Mitad del Mundo, Quito, Ecuador, 2015-07-22, DD 07.JPG', 'Mitad del Mundo, Quito, Ecuador, 2015-07-22, DD 03.JPG', 'Mitad del Mundo, Quito, Ecuador, 2015-07-22, DD 06.JPG', 'Mitad del Mundo, Quito, Ecuador, 2015-07-22, DD 02.JPG', 'La Mitad del Mundo, Quito, Ecuador 001.JPG'],
  'Basílica del Voto Nacional': ['Basílica del Voto Nacional, Quito - 4.jpg', 'Quito AvVenezuela basilicadelvotonacional.JPG', 'Quito’s Basilica del Voto Nacional.jpg'],
  'Mirador del Panecillo y Virgen de Quito': ['Virgen de Quito.jpg', 'Quito banner Virgen de Quito.jpg'],
  'Bosque nublado de Mindo': ['Mindo-Cloud-Forest-05.jpg', 'Mindo-Cloud-Forest-12.jpg', 'Ecuador Mindo Hill Scene.jpg'],
  'Parque Seminario (Parque de las Iguanas)': ['Parque Seminario Ecuador364.JPG', 'Monumento a la Iguana.jpg'],
  'Cerro Santa Ana y Barrio Las Peñas': ['Guayas from Santa Ana.JPG', 'Faro de Guayaquil.jpg'],
  'Parque Histórico Guayaquil': ['Parque Histórico Guayaquil - Edificios (1).JPG', 'Parque Histórico Guayaquil - Edificios (2).JPG', 'Parque Histórico Guayaquil - Cabaña.JPG'],
  'Parque Calderón y Catedral de la Inmaculada': ['Cuenca Ecuador Catedral Nueva 01.jpg', 'Cuenca Ecuador Catedral Nueva 02.jpg', 'Cupulas Catedral Nueva Cuenca.jpg'],
  'Museo Pumapungo y parque arqueológico': ['Pumapungo.jpg', 'Pumapungo banner.jpg'],
  'Mirador de Turi': ['Cuenca desde el mirador de Turi.jpg', 'Cuenca (Ecuador) from Turi.jpg'],
  'Complejo Arqueológico de Ingapirca': ['Ingapirca Temple of the sun.jpg', 'Ingapirca.jpg', 'Templo del sol.jpg'],
  'Playa Murciélago': ['Manta Ec playa Murciélago.jpg', 'Manta Ecuador playa Murciélago 02.jpg', 'Manta Ecuador playa Murciélago 03.jpg'],
  'Montecristi y sombreros de paja toquilla': ['Montecristi panorama.JPG', 'Montecristi.jpg', 'Monumentosombreropajatoquilla.jpg'],
  'Isla de la Plata, Parque Nacional Machalilla': ['Isladelaplata.JPG', 'Playa Isla de Plata.JPG', 'Isla de la Plata Ecuador449.JPG'],
  'Parque Nacional Cotopaxi': ['Cotopaxi National Park.jpg', 'Volcán Cotopaxi, Ecuador.JPG', 'Cotopaxi Volcano.jpg'],
  'Laguna del Quilotoa': ['Laguna Quilotoa, Ecuador.jpg', 'Lago Quilotoa.JPG', 'Panorama quilotoa crater lake ecuador.jpg'],
  'Playa de Atacames': ['Atacames Beach, Ecuador -1- (361306423).jpg'],
  'Playa de Same': ['Ecuador - Same - Esmeraldas - 009.JPG', 'Ecuador - Same - Esmeraldas - 007.JPG', 'Ecuador - Same - Esmeraldas - 012.JPG'],
  'Mompiche y su rompiente': ['Ecuador - Mompiche - Esmeraldas - 007.JPG', 'Mangroves near Mompiche - Ecuador.jpg'],
  'Reserva de Producción de Fauna Cuyabeno': ['Cuyabeno Reserve, Laguna Grande.jpg', 'Cuyabeno Wild Life Reserve banner.jpg'],
  'Cascada de San Rafael': ['AMA Cascada de San Rafael limite provincial de Napo y Sucumbíos (8227381138).jpg'],
  'Catedral de Macas y mirador del río Upano': ['Ecuador Macas churchVirgenPurisima.JPG'],
  'Parque Nacional Sangay (lagunas de Atillo)': ['Ama la Vida - Flickr - ANDES Laguna de Atillo Parque Nacional Sangay (8226339107).jpg', 'Sangay National Park banner Laguna Collanes.JPG'],
  'Parque Amazónico La Isla': ['Amazon Rainforest in Tena, Ecuador.jpg', 'Amazon rainforest treetops in Tena, Ecuador.jpg'],
  'Rafting en el río Jatunyacu': ['Río Napo, Selina Amazon Lodge - Tena.jpg', 'Alluvium Rio Napo Ecuador.jpg'],
  'Cavernas de Jumandy': ['CAVERNAS DE JUMANDY (19964246522).jpg'],
  'Crucero por el río Napo': ['Napo River.jpg', 'Gabarra en el rio Napo Ecuador.jpg'],
  'Parque Nacional Yasuní': ['Scarlet macaw (Ara macao macao) in flight Yasuni.jpg'],
  'Parque Nacional Podocarpus': ['Parque Nacional Podocarpus banner.jpg'],
  'Puerta de la Ciudad y centro histórico': ['LojaCityGates.JPG', 'Loja banner.jpg'],
  'Valle de Vilcabamba': ['VilcabambaEcuador.JPG', 'Vilcabamba Ecuador261.JPG'],
  'Isla Seymour Norte': ['Isla Seymour Norte, islas Galápagos, Ecuador, 2015-07-23, DD 02-03 PAN.JPG', 'Coast of North Seymour Island in the Galapagos with a bird in flight in a blue sky photo by Alvaro Sevilla Design.JPG'],
  'Isla Bartolomé': ['Bartolomé Island Pinnacle Rock.jpg', 'Bartolome Island, Galapagos (50122421803).jpg'],
  'Kicker Rock (León Dormido)': ['León Dormido (Kicker Rock).JPG', 'Kicker Rock.jpg'],
  'Playa Lobería': ['Galápagos sea lion San Cristóbal Galápagos Ecuador DSC00189 ad.JPG'],
  // Sin foto libre confirmada (quedan con la ilustración): Isla Santay, Mercado de Saquisilí, Centro de Interpretación de Galápagos
};

const libre = (lic = '') => /^(CC[ -]BY|CC0|Public domain|PD)/i.test(lic) && !/-NC|-ND|non-?free|fair use/i.test(lic);
const limpio = (h = '') => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();

async function infoCommons(titulos) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1200', titles: titulos.map((t) => 'File:' + t).join('|') });
  const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error('Commons respondió ' + r.status);
  const j = await r.json(); const norm = Object.fromEntries((j.query.normalized ?? []).map((n) => [n.to, n.from]));
  const out = {};
  for (const p of Object.values(j.query.pages)) {
    const ii = p.imageinfo?.[0]; if (!ii) continue; const m = ii.extmetadata ?? {};
    out[(norm[p.title] ?? p.title).replace(/^File:/, '')] = { archivo: p.title.replace(/^File:/, ''), url: ii.thumburl ?? ii.url, ancho: ii.width, autor: limpio(m.Artist?.value) || 'Autor no indicado', licencia: m.LicenseShortName?.value ?? '', lic_url: m.LicenseUrl?.value ?? '', pagina: ii.descriptionurl };
  }
  return out;
}

// 1) Consultar Commons (todos los candidatos en lotes de 40)
const todos = [...new Set(Object.values(FOTOS).flat())]; const info = {};
for (let i = 0; i < todos.length; i += 40) Object.assign(info, await infoCommons(todos.slice(i, i + 40)));
const elegidas = [], sin = [];
for (const [nombre, cands] of Object.entries(FOTOS)) {
  const ok = cands.map((c) => info[c] ?? info[c.replace(/’/g, "'")]).find((x) => x && libre(x.licencia) && x.ancho >= 800 && !/no indicado/i.test(x.autor));
  if (ok) elegidas.push({ nombre, ...ok }); else sin.push(nombre);
}
for (const e of elegidas) console.log(`✔ ${e.nombre}\n    ${e.archivo} · ${e.autor} · ${e.licencia} · ${e.ancho}px`);
for (const n of sin) console.log(`✖ ${n}: ninguna foto candidata con licencia libre confirmada`);
console.log(`\n${elegidas.length} fotos listas, ${sin.length} sin foto.`);

const creditos = ['# Créditos de fotos', '', 'Las fotos de las atracciones provienen de Wikimedia Commons y se usan según sus licencias libres. Cada autor conserva sus derechos.', '',
  '| Atracción | Archivo | Autor | Licencia |', '|---|---|---|---|',
  ...elegidas.map((e) => `| ${e.nombre} | [${e.archivo}](${e.pagina}) | ${e.autor.replace(/\|/g, '/')} | ${e.lic_url ? `[${e.licencia}](${e.lic_url})` : e.licencia} |`), ''].join('\n');
writeFileSync('CREDITOS-FOTOS.md', creditos);
console.log('Se creó CREDITOS-FOTOS.md en la carpeta actual.');
if (SIMULAR) { console.log('(simulación: no se envió nada a Azure)'); process.exit(0); }

// 2) Guardar en Azure
async function api(metodo, ruta, token, body) {
  const r = await fetch(BASE + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  const t = await r.text(); const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`${metodo} ${ruta} → ${r.status} ${j?.detail ?? j?.message ?? t}`); return j;
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const email = (await rl.question('\nCorreo del Administrador Sistema: ')).trim();
const password = await rl.question('Contraseña (se verá al escribir): '); rl.close();
const { access_token: tk } = await api('POST', '/auth/login', null, { email, password });
const ids = Object.fromEntries((await api('GET', '/admin/atracciones?limit=100', tk)).data.map((a) => [a.nombre, a.id]));
let ok = 0, fallo = 0;
for (const e of elegidas) {
  const id = ids[e.nombre]; if (!id) { console.log(`! no encontrada en Azure: ${e.nombre}`); fallo++; continue; }
  try { await api('PUT', `/admin/atracciones/${id}`, tk, { fotos: [{ url: e.url, alt: `${e.nombre}. Foto: ${e.autor}, ${e.licencia}, Wikimedia Commons` }] }); ok++; console.log(`+ ${e.nombre}`); }
  catch (x) { fallo++; console.log(`! ${e.nombre}: ${x.message}`); }
}
console.log(`\nListo. Fotos guardadas: ${ok} · con error: ${fallo}`);
