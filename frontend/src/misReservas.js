// "Mis reservas": el backend no tiene una consulta para listar las reservas de un cliente, así que la web recuerda en este navegador
// los identificadores de las reservas que ese usuario hizo desde aquí y luego pide cada una al backend (GET /atracciones/reservas/:id)
// para mostrar su estado real. No guarda datos personales ni de pago, solo el UUID de cada reserva.
const clave = (email) => `atr_mis_reservas:${String(email ?? '').trim().toLowerCase()}`;
const MAX = 50;

export const misReservas = {
  leer(email) {
    try { const v = JSON.parse(localStorage.getItem(clave(email)) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
  },
  agregar(email, id) {
    if (!email || !id) return;
    try { const lista = [id, ...misReservas.leer(email).filter((x) => x !== id)].slice(0, MAX); localStorage.setItem(clave(email), JSON.stringify(lista)); } catch { /* almacenamiento no disponible */ }
  },
  quitar(email, id) {
    try { localStorage.setItem(clave(email), JSON.stringify(misReservas.leer(email).filter((x) => x !== id))); } catch { /* idem */ }
  },
};
