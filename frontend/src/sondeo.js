import { useEffect, useRef } from 'react';

// Sondeo silencioso: llama a `fn` cada `cada` ms en segundo plano, sin que el usuario lo note.
//  - Una consulta termina antes de empezar la siguiente (nunca se acumulan).
//  - Se pausa con la pestaña oculta y al volver consulta de inmediato.
//  - Si el servidor responde 429 (demasiadas peticiones), espera `espera429` ms antes de reintentar.
//  - `fn` se lee siempre en su versión más reciente, así que cambiar de filtros o de fecha no reinicia el ciclo.
//  - Cualquier otro error se ignora: se conserva lo último que se mostró y se reintenta en el siguiente ciclo.
export function useSondeo(fn, { cada, activo = true, espera429 = 20000 }) {
  const ultima = useRef(fn);
  ultima.current = fn;
  useEffect(() => {
    if (!activo) return undefined;
    let parar = false; let corriendo = false; let h;
    const ciclo = async () => {
      if (parar || corriendo) return;
      corriendo = true;
      let ms = cada;
      if (!document.hidden) {
        try { await ultima.current(); } catch (e) { if (e?.status === 429) ms = espera429; }
      }
      corriendo = false;
      if (!parar) h = setTimeout(ciclo, ms);
    };
    const alVolver = () => { if (!document.hidden && !parar && !corriendo) { clearTimeout(h); ciclo(); } };
    document.addEventListener('visibilitychange', alVolver);
    h = setTimeout(ciclo, cada);
    return () => { parar = true; clearTimeout(h); document.removeEventListener('visibilitychange', alVolver); };
  }, [cada, activo, espera429]);
}
