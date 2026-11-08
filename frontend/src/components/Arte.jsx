import React, { useMemo, useState } from 'react';

// Ilustraciones originales dibujadas en SVG (no son fotos ni copias de obras): sirven de portada del inicio
// y de imagen de reemplazo cuando una atracción todavía no tiene foto.

// Generador pseudoaleatorio con semilla: el dibujo es siempre el mismo para la misma atracción.
const semilla = (n) => () => { n = (n * 1664525 + 1013904223) % 4294967296; return n / 4294967296; };
export const hash = (t) => { let h = 7; for (const c of String(t ?? '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

function Pinos({ x0, x1, y, n, escala = 1, color, rnd }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * rnd(); const h = (60 + rnd() * 90) * escala; const w = h * 0.38;
    const base = y + (rnd() - 0.5) * 16 * escala;
    out.push(
      <g key={i} fill={color}>
        <path d={`M${x},${base - h} L${x + w * 0.45},${base - h * 0.62} L${x + w * 0.2},${base - h * 0.62} L${x + w * 0.6},${base - h * 0.3} L${x + w * 0.3},${base - h * 0.3} L${x + w},${base} L${x - w},${base} L${x - w * 0.3},${base - h * 0.3} L${x - w * 0.6},${base - h * 0.3} L${x - w * 0.2},${base - h * 0.62} L${x - w * 0.45},${base - h * 0.62} Z`} />
      </g>,
    );
  }
  return <>{out}</>;
}

const TEMAS = [
  { n: 'sierra', cielo: ['#5aa7d6', '#a9d6ea', '#f3f1e2'], sol: ['#fff4cf', 300, 70, 28], lejos: '#9cc3b4', medio: '#4f9a7a', cerca: '#276a55', volcan: true },
  { n: 'selva', cielo: ['#2e7d7a', '#7fc4b0', '#e6f2dd'], sol: ['#ffffff', 90, 60, 20], lejos: '#79b49c', medio: '#3c8d6a', cerca: '#1d5a46', volcan: false },
  { n: 'costa', cielo: ['#f4a37a', '#f8cfa0', '#fdf0d9'], sol: ['#fff7e2', 250, 135, 38], lejos: '#e3b99a', medio: '#2d8fa3', cerca: '#1a5f73', mar: true },
  { n: 'altura', cielo: ['#2f5d9e', '#7fa8d6', '#e6eff7'], sol: ['#ffffff', 80, 55, 16], lejos: '#9fb4cf', medio: '#6c9088', cerca: '#34584f', volcan: true },
];

/** Imagen de reemplazo para tarjetas: paisaje distinto según la atracción. */
const quitar = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function elegirTema(texto, h) {
  const t = quitar(texto);
  if (/cotopaxi|chimborazo|volcan|nevado|cayambe|antisana|quilotoa|paramo|cajas/.test(t)) return TEMAS[3];
  if (/playa|malecon|galapagos|isla|mar |costa|manta|salinas|puerto|guayaquil|esmeraldas|atacames/.test(t)) return TEMAS[2];
  if (/amazon|selva|yasuni|napo|puyo|tena|coca|jungla|cascada|bosque/.test(t)) return TEMAS[1];
  return TEMAS[h % 2 === 0 ? 0 : 1];
}
export function Paisaje({ clave, texto }) {
  const h = hash(clave); const t = elegirTema(texto, h); const id = `p${h}`; const rnd = semilla(h);
  const pico = 110 + (h % 90);
  return (
    <svg className="paisaje" viewBox="0 0 400 260" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={t.cielo[0]} /><stop offset=".55" stopColor={t.cielo[1]} /><stop offset="1" stopColor={t.cielo[2]} /></linearGradient>
        <filter id={`${id}b`}><feGaussianBlur stdDeviation="6" /></filter>
      </defs>
      <rect width="400" height="260" fill={`url(#${id}c)`} />
      <circle cx={t.sol[1]} cy={t.sol[2]} r={t.sol[3] * 2} fill={t.sol[0]} opacity=".35" filter={`url(#${id}b)`} />
      <circle cx={t.sol[1]} cy={t.sol[2]} r={t.sol[3]} fill={t.sol[0]} opacity=".95" />
      {t.volcan && <><path d={`M70,175 L${pico + 60},60 L${pico + 190},175 Z`} fill="#8fa6c4" opacity=".8" /><path d={`M${pico + 60},60 l16,22 -8,-4 -8,10 -8,-9 -10,6 Z`} fill="#fff" /></>}
      <path d="M0,170 Q90,140 190,168 T400,150 L400,260 L0,260 Z" fill={t.lejos} />
      {t.mar
        ? <><path d="M0,190 H400 V260 H0 Z" fill={t.medio} /><path d="M0,205 Q60,198 120,205 T240,205 T400,203" stroke="#fff" strokeWidth="2" fill="none" opacity=".45" /><path d="M0,225 Q70,217 140,225 T280,225 T400,222" stroke="#fff" strokeWidth="2" fill="none" opacity=".3" /></>
        : <path d="M0,200 Q110,160 220,196 T400,180 L400,260 L0,260 Z" fill={t.medio} />}
      <Pinos x0={0} x1={400} y={t.mar ? 245 : 215} n={t.mar ? 3 : 12} escala={t.mar ? 0.6 : 0.5} color={t.cerca} rnd={rnd} />
      <path d="M0,238 Q120,214 250,236 T400,226 V260 H0 Z" fill={t.cerca} />
    </svg>
  );
}

/** Foto de la atracción; si no hay foto o falla la descarga, se dibuja un paisaje de reemplazo. */
export function Foto({ src, alt = '', clave, texto, className = '' }) {
  const [falla, setFalla] = useState(!src);
  return (
    <div className={`foto ${className}`}>
      {falla ? <Paisaje clave={clave} texto={texto ?? alt} /> : <img src={src} alt={alt} loading="lazy" onError={() => setFalla(true)} />}
    </div>
  );
}

/** Marca: una cumbre y un sol dentro de un círculo. */
export const Marca = () => (
  <svg className="marca-svg" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    <circle cx="20" cy="20" r="19" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".55" />
    <circle cx="26" cy="13" r="3.4" fill="var(--sol)" />
    <path d="M6,29 L16,15 L21,22 L25,17 L34,29 Z" fill="currentColor" />
  </svg>
);

/** Panorama original (ilustración, no foto): Galápagos y costa, sierra con volcanes y Amazonía, de izquierda a derecha. */
const Palma = ({ x, y, s = 1 }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <path d="M0,0 Q10,-38 3,-84" stroke="#8a6a46" strokeWidth="4.5" fill="none" strokeLinecap="round" />
    <g fill="none" stroke="#3f8a63" strokeWidth="3.4" strokeLinecap="round">
      <path d="M3,-84 q-30,-6 -46,14" /><path d="M3,-84 q-24,-22 -44,-14" /><path d="M3,-84 q4,-26 -4,-36" />
      <path d="M3,-84 q28,-6 46,14" /><path d="M3,-84 q24,-22 44,-14" />
    </g>
  </g>
);
export function Panorama() {
  const rnd = semilla(2024);
  const copas = Array.from({ length: 46 }, (_, i) => ({ x: 1010 + rnd() * 450, y: 470 + rnd() * 70, r: 16 + rnd() * 22, c: i % 3 }));
  const verdes = ['#4f9a78', '#3f8a69', '#6bb08e'];
  return (
    <svg className="panorama" viewBox="0 0 1440 640" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="pn-cielo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#bddcec" /><stop offset=".5" stopColor="#f3ead9" /><stop offset="1" stopColor="#f5f4ef" /></linearGradient>
        <linearGradient id="pn-mar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8fd0d2" /><stop offset="1" stopColor="#4fa7b4" /></linearGradient>
        <linearGradient id="pn-pie" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f5f4ef" stopOpacity="0" /><stop offset="1" stopColor="#f5f4ef" /></linearGradient>
        <radialGradient id="pn-sol"><stop offset="0" stopColor="#fff2c9" stopOpacity=".95" /><stop offset="1" stopColor="#fff2c9" stopOpacity="0" /></radialGradient>
        <linearGradient id="pn-fm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#fff" /><stop offset=".62" stopColor="#fff" /><stop offset="1" stopColor="#000" /></linearGradient>
        <linearGradient id="pn-fs" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#000" /><stop offset=".25" stopColor="#fff" /></linearGradient>
        <mask id="pn-mm" maskUnits="userSpaceOnUse" x="0" y="0" width="1440" height="640"><rect width="620" height="640" fill="url(#pn-fm)" /></mask>
        <mask id="pn-ms" maskUnits="userSpaceOnUse" x="0" y="0" width="1440" height="640"><rect x="940" width="500" height="640" fill="url(#pn-fs)" /></mask>
        <filter id="pn-b"><feGaussianBlur stdDeviation="3" /></filter>
      </defs>
      <rect width="1440" height="640" fill="url(#pn-cielo)" />
      <circle cx="760" cy="150" r="170" fill="url(#pn-sol)" />
      <g className="nubes" fill="#fff" opacity=".7"><ellipse cx="240" cy="110" rx="90" ry="14" /><ellipse cx="290" cy="98" rx="60" ry="12" /><ellipse cx="1180" cy="90" rx="100" ry="14" /><ellipse cx="1130" cy="104" rx="60" ry="10" /></g>
      {/* Sierra: cordillera y volcanes nevados */}
      <path d="M380,520 L520,360 L600,420 L690,300 L780,400 L860,330 L1010,520 Z" fill="#c4d3df" opacity=".85" filter="url(#pn-b)" />
      <path d="M520,520 L706,196 L900,520 Z" fill="#9fb6cc" />
      <path d="M706,196 l30,52 -18,-10 -16,22 -14,-20 -22,16 Z" fill="#fff" />
      <path d="M840,520 L960,300 L1080,520 Z" fill="#aac0d3" />
      <path d="M960,300 l20,34 -12,-7 -10,14 -9,-12 -14,10 Z" fill="#fff" opacity=".95" />
      <path d="M180,640 Q420,462 700,486 T1260,640 Z" fill="#8fbfa9" opacity=".85" />
      {/* Oriente: selva y río */}
      <g mask="url(#pn-ms)">
      <path d="M900,520 Q1100,430 1230,470 T1440,440 L1440,640 L900,640 Z" fill="#8cc4a8" />
      {copas.map((c, i) => <circle key={i} cx={c.x} cy={c.y} r={c.r} fill={verdes[c.c]} />)}
      <path d="M1010,600 Q1160,540 1260,580 T1440,560" stroke="#cfe9f0" strokeWidth="14" fill="none" strokeLinecap="round" opacity=".8" />
      </g>
      {/* Costa y Galápagos */}
      <g mask="url(#pn-mm)">
      <path d="M0,455 H620 V640 H0 Z" fill="url(#pn-mar)" />
      <path d="M0,500 Q70,492 140,500 T280,500 T420,498 T620,500" stroke="#fff" strokeWidth="2" fill="none" opacity=".5" />
      <path d="M0,540 Q80,531 160,540 T320,540 T620,537" stroke="#fff" strokeWidth="2" fill="none" opacity=".35" />
      <path d="M40,470 Q80,436 130,458 Q150,466 170,470 Z" fill="#4c7d70" />
      <path d="M210,466 Q240,444 282,462 Q300,468 316,470 Z" fill="#5d8f80" />
      <path d="M0,590 Q150,540 330,574 T620,566 L620,640 L0,640 Z" fill="#f0dfbf" />
      <path d="M0,610 Q170,570 340,600 T620,596 L620,640 L0,640 Z" fill="#e6cfa4" />
      <Palma x={90} y={600} s={1.15} /><Palma x={190} y={592} s={0.9} /><Palma x={440} y={588} s={1} />
      </g>
      <rect y="440" width="1440" height="200" fill="url(#pn-pie)" />
    </svg>
  );
}
