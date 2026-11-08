// Publicación de eventos entre microservicios (transporte v0: HTTP interno con reintentos).
// La interfaz publicar(evento) es la que usará el bus RabbitMQ/CloudAMQP; solo se cambiará el transporte.
//   evento = { tipo, origen, datos, usu_id?, entidad?, entidad_id? }
// Cola en memoria acotada (1000): si un destino está caído se reintenta con espera creciente; al agotar los intentos se descarta y se registra.
import { llamar } from './llamadas.mjs';

const SUSCRIPTORES = { RESENA_PUBLICADA: ['catalog'], RESENA_RETIRADA: ['catalog'] };      // además, TODO evento va a audit (bitácora)
const MAX_COLA = 1000; const MAX_INTENTOS = 5;
const cola = []; let trabajando = false; let descartados = 0; let enviados = 0;

export function publicar(ev) {
  const base = { id: crypto.randomUUID(), en: new Date().toISOString(), ...ev };
  const destinos = ['audit', ...(SUSCRIPTORES[ev.tipo] ?? [])];
  for (const d of destinos) { if (cola.length >= MAX_COLA) { cola.shift(); descartados += 1; } cola.push({ d, ev: base, intentos: 0, noAntes: 0 }); }
  procesar();
}
async function procesar() {
  if (trabajando) return; trabajando = true;
  try {
    while (cola.length) {
      const ahora = Date.now();
      const i = cola.findIndex((x) => x.noAntes <= ahora);
      if (i < 0) { await new Promise((r) => setTimeout(r, 250)); continue; }
      const [it] = cola.splice(i, 1);
      try {
        const r = await llamar(it.d, 'POST', '/internal/eventos', { body: it.ev, timeoutMs: 2500, reintentos: 0 });
        if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
        enviados += 1;
      } catch (x) {
        it.intentos += 1;
        if (it.intentos >= MAX_INTENTOS) { descartados += 1; console.error(JSON.stringify({ level: 'error', msg: `evento ${it.ev.tipo} descartado para ${it.d}: ${x.message}` })); }
        else { it.noAntes = Date.now() + Math.min(30000, 500 * 2 ** it.intentos); cola.push(it); }
      }
    }
  } finally { trabajando = false; }
}
export const estadoEventos = () => ({ en_cola: cola.length, enviados, descartados });
