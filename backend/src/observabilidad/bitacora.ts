/**
 * Bitácora de eventos (observabilidad, Semana 8): cada hecho relevante queda en (1) la consola como una línea con hora, nivel, canal y correlation-id
 * y (2) un buffer circular en memoria que el panel de administración consulta en GET /api/v3/admin/bitacora (pantalla "Observabilidad").
 * Sin datos personales: nunca se guardan correos, documentos ni claves; solo códigos de reserva/atracción, estados y tiempos.
 */
export type Nivel = 'INFO' | 'WARN' | 'ERROR';
export type Canal = 'HTTP' | 'CLIENTES' | 'RESERVA' | 'CHECKIN' | 'STOCK' | 'BUS' | 'ADMIN' | 'SISTEMA';
export interface Entrada { n: number; ts: string; nivel: Nivel; canal: Canal; mensaje: string; cid?: string; datos?: Record<string, unknown> }

const MAX = 500;
const COLOR: Record<Canal, string> = { HTTP: '90', CLIENTES: '36', RESERVA: '32', CHECKIN: '35', STOCK: '34', BUS: '33', ADMIN: '96', SISTEMA: '37' };
const NIV: Record<Nivel, string> = { INFO: '32', WARN: '33', ERROR: '31' };

class Bitacora {
  private buf: Entrada[] = []; private seq = 0;
  private color = process.env.LOG_COLOR === 'true' || (process.env.LOG_COLOR !== 'false' && !!process.stdout.isTTY);
  private silencio = process.env.BITACORA_CONSOLA === 'false';

  registrar(canal: Canal, mensaje: string, o: { cid?: string; nivel?: Nivel; datos?: Record<string, unknown> } = {}) {
    const e: Entrada = { n: ++this.seq, ts: new Date().toISOString(), nivel: o.nivel ?? 'INFO', canal, mensaje, cid: o.cid, datos: o.datos };
    this.buf.push(e); if (this.buf.length > MAX) this.buf.shift();
    if (!this.silencio) {
      const c = (code: string, s: string) => (this.color ? `\x1b[${code}m${s}\x1b[0m` : s);
      const extra = e.datos && Object.keys(e.datos).length ? ' ' + Object.entries(e.datos).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') : '';
      const linea = `${c('90', e.ts)} ${c(NIV[e.nivel], e.nivel.padEnd(5))} ${c(COLOR[canal], `[${canal}]`.padEnd(10))} ${mensaje}${extra}${e.cid ? ' ' + c('90', `cid=${e.cid}`) : ''}`;
      (e.nivel === 'ERROR' ? console.error : console.log)(linea);
    }
    return e;
  }

  listar(o: { despues?: number; canal?: string; limite?: number } = {}) {
    let r = this.buf; if (o.despues) r = r.filter((e) => e.n > o.despues!); if (o.canal) r = r.filter((e) => e.canal === o.canal);
    const lim = Math.min(Math.max(o.limite ?? 100, 1), MAX);
    return { ultimo: this.seq, total_en_memoria: this.buf.length, data: r.slice(-lim).reverse() };
  }
}
export const bitacora = new Bitacora();
