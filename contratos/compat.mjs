// Reglas de compatibilidad BACKWARD (Semana 7, sección 7.5). Sin dependencias: se puede usar en cualquier CI.
// ALCANCE (heurística pedagógica, como aclara el libro): compara propiedades, tipos, requeridos, enum y límites; NO sigue `$ref` ni composición (allOf/oneOf/anyOf).
// Un `$ref` solo se compara por igualdad de texto; si cambió, se reporta como advertencia para revisión humana.

const tipos = (t) => (t === undefined ? undefined : [].concat(t).map(String).sort().join('|'));

/** Compara dos JSON Schema. Devuelve { problemas: [...breaking], advertencias: [...revisar] }. */
export function compararEsquema(viejo = {}, nuevo = {}, ruta = '$', out = { problemas: [], advertencias: [] }) {
  const P = (m) => out.problemas.push(`${ruta}: ${m}`);
  const A = (m) => out.advertencias.push(`${ruta}: ${m}`);
  if (viejo.$ref || nuevo.$ref) { if (viejo.$ref !== nuevo.$ref) A(`$ref cambió (${viejo.$ref} → ${nuevo.$ref}); revisar a mano`); return out; }
  if (tipos(viejo.type) !== tipos(nuevo.type)) { if (viejo.type !== undefined) P(`tipo cambiado ${tipos(viejo.type)} → ${tipos(nuevo.type) ?? '(sin tipo)'}`); }
  const pv = viejo.properties ?? {}, pn = nuevo.properties ?? {};
  for (const c of Object.keys(pv)) {
    if (!(c in pn)) { P(`campo eliminado "${c}" (renombrar equivale a eliminar + agregar)`); continue; }
    compararEsquema(pv[c], pn[c], `${ruta}.${c}`, out);
  }
  const rv = new Set(viejo.required ?? []);
  for (const c of nuevo.required ?? []) {
    if (rv.has(c)) continue;
    P(c in pv ? `el campo opcional "${c}" pasó a requerido` : `campo requerido nuevo "${c}" sin valor por defecto`);
  }
  if (viejo.enum && nuevo.enum) { const q = viejo.enum.filter((v) => !nuevo.enum.some((w) => JSON.stringify(w) === JSON.stringify(v))); if (q.length) P(`valores de enum eliminados: ${q.join(', ')}`); }
  else if (!viejo.enum && nuevo.enum) P('se agregó un enum (estrecha los valores permitidos)');
  for (const [k, peor] of [['maximum', (a, b) => b < a], ['maxLength', (a, b) => b < a], ['maxItems', (a, b) => b < a], ['minimum', (a, b) => b > a], ['minLength', (a, b) => b > a], ['minItems', (a, b) => b > a]]) {
    if (viejo[k] === undefined && nuevo[k] !== undefined) P(`restricción nueva ${k}=${nuevo[k]} (estrecha)`);
    else if (viejo[k] !== undefined && nuevo[k] !== undefined && peor(viejo[k], nuevo[k])) P(`${k} más estricto (${viejo[k]} → ${nuevo[k]})`);
  }
  if (viejo.pattern !== nuevo.pattern) { if (viejo.pattern === undefined) P('se agregó un pattern (estrecha)'); else if (nuevo.pattern !== undefined) A(`pattern cambió (${viejo.pattern} → ${nuevo.pattern}); verificar que no estreche`); }
  if (viejo.additionalProperties !== false && nuevo.additionalProperties === false) P('additionalProperties pasó a false (rechaza campos antes aceptados)');
  if (viejo.items && nuevo.items) compararEsquema(viejo.items, nuevo.items, `${ruta}[]`, out);
  return out;
}

/** Compara los $defs de dos documentos (p. ej. schemas/requests.json). */
export function compararDocumento(viejo, nuevo, etiqueta) {
  const out = { problemas: [], advertencias: [] };
  for (const n of Object.keys(viejo.$defs ?? {})) {
    if (!(n in (nuevo.$defs ?? {}))) { out.problemas.push(`${etiqueta}#${n}: esquema eliminado`); continue; }
    compararEsquema(viejo.$defs[n], nuevo.$defs[n], `${etiqueta}#${n}`, out);
  }
  return out;
}

// ---------- Protobuf (regla clave del libro: el NÚMERO de campo es lo que viaja) ----------
const cierre = (t, desde) => { let d = 1, i = desde; while (i < t.length && d) { if (t[i] === '{') d++; else if (t[i] === '}') d--; i++; } return i; };
function bloques(txt, pref = '', res = []) {                // message/service (los anidados llevan nombre calificado: Padre.Hijo)
  const re = /\b(message|service|enum)\s+(\w+)\s*\{/g; let m;
  while ((m = re.exec(txt))) {
    const fin = cierre(txt, re.lastIndex); const cuerpo = txt.slice(re.lastIndex, fin - 1);
    res.push({ tipo: m[1], nombre: pref + m[2], cuerpo });
    if (m[1] === 'message') bloques(cuerpo, `${pref}${m[2]}.`, res);
    re.lastIndex = fin;
  }
  return res;
}
const sinAnidados = (c) => { let out = '', pos = 0, m; const re = /\b(message|enum)\s+\w+\s*\{/g; while ((m = re.exec(c))) { out += c.slice(pos, m.index); pos = cierre(c, re.lastIndex); re.lastIndex = pos; } return out + c.slice(pos); };
export function analizarProto(txt) {
  const limpio = txt.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const mensajes = new Map(), rpcs = new Map();
  for (const b of bloques(limpio)) {
    if (b.tipo === 'enum') continue;
    if (b.tipo === 'service') { for (const r of b.cuerpo.matchAll(/rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/g)) rpcs.set(`${b.nombre}.${r[1]}`, `${r[2] ? 'stream ' : ''}${r[3]} -> ${r[4] ? 'stream ' : ''}${r[5]}`); continue; }
    const plano = sinAnidados(b.cuerpo).replace(/\boneof\s+\w+\s*\{/g, ' ').replace(/\}/g, ' ');
    const campos = new Map(), reservados = new Set();
    for (const f of plano.matchAll(/(?:^|[;{}\s])((?:repeated|optional)\s+)?(map\s*<[^>]+>|[A-Za-z_][\w.]*)\s+(\w+)\s*=\s*(\d+)/g)) if (!['reserved', 'option', 'syntax', 'returns'].includes(f[2])) campos.set(Number(f[4]), { nombre: f[3], tipo: `${f[1] ?? ''}${f[2]}`.replace(/\s+/g, ' ').trim() });
    for (const r of plano.matchAll(/reserved\s+([^;]+);/g)) for (const x of r[1].split(',')) { const t = x.trim(); const rg = t.match(/^(\d+)\s+to\s+(\d+|max)$/); if (rg) for (let k = Number(rg[1]); k <= Math.min(rg[2] === 'max' ? 1000 : Number(rg[2]), 1000); k++) reservados.add(k); else if (/^\d+$/.test(t)) reservados.add(Number(t)); }
    mensajes.set(b.nombre, { campos, reservados });
  }
  return { mensajes, rpcs };
}
export function compararProto(viejoTxt, nuevoTxt, etiqueta) {
  const v = analizarProto(viejoTxt), n = analizarProto(nuevoTxt); const out = { problemas: [], advertencias: [] };
  for (const [nombre, mv] of v.mensajes) {
    const mn = n.mensajes.get(nombre); if (!mn) { out.problemas.push(`${etiqueta}: message ${nombre} eliminado`); continue; }
    for (const [num, f] of mv.campos) {
      const g = mn.campos.get(num);
      if (!g) { if (mn.reservados.has(num)) out.advertencias.push(`${etiqueta}: ${nombre}.${f.nombre} (=${num}) eliminado y marcado reserved (correcto)`); else out.problemas.push(`${etiqueta}: ${nombre}.${f.nombre} (=${num}) eliminado sin marcar reserved (el número podría reutilizarse)`); continue; }
      if (g.tipo !== f.tipo) out.problemas.push(`${etiqueta}: ${nombre} campo =${num} cambió de tipo ${f.tipo} → ${g.tipo}${g.nombre !== f.nombre ? ` (y de nombre ${f.nombre} → ${g.nombre}: número reutilizado)` : ''}`);
      else if (g.nombre !== f.nombre) out.advertencias.push(`${etiqueta}: ${nombre} campo =${num} se renombró ${f.nombre} → ${g.nombre} (binario compatible; rompe JSON/clientes que usen el nombre)`);
    }
  }
  for (const [k, firma] of v.rpcs) { const g = n.rpcs.get(k); if (!g) out.problemas.push(`${etiqueta}: rpc ${k} eliminado`); else if (g !== firma) out.problemas.push(`${etiqueta}: rpc ${k} cambió su firma (${firma} → ${g})`); }
  return out;
}
