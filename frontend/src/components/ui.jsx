import React from 'react';
export const Cargando = ({ texto = 'Cargando…' }) => <p className="vacio" role="status">{texto}</p>;
export const Error_ = ({ e }) => e ? <div className="alerta error" role="alert"><strong>{e.message}</strong>{e.params?.length ? <ul>{e.params.map((p, i) => <li key={i}>{p.name}: {p.reason}</li>)}</ul> : null}</div> : null;
export const Ok = ({ children }) => children ? <div className="alerta ok" role="status">{children}</div> : null;
export const Campo = ({ etiqueta, children, ayuda }) => <label className="campo"><span>{etiqueta}</span>{children}{ayuda && <small>{ayuda}</small>}</label>;
export const Insignia = ({ estado }) => <span className={`ins ins-${String(estado).toLowerCase()}`}>{({ CONFIRMED: 'RESERVADO', CHECKED_IN: 'CONFIRMADO_ASISTIDO', CANCELLED: 'CANCELADA', PUBLICADA: 'Publicada', BORRADOR: 'Borrador', INACTIVA: 'Inactiva', DISPONIBLE: 'Disponible', ULTIMOS_CUPOS: 'Últimos cupos', AGOTADO: 'Agotado' })[estado] ?? estado}</span>;
export function Paginacion({ meta, onPagina }) {
  if (!meta || meta.total_pages <= 1) return null;
  return <div className="paginas"><button disabled={meta.page <= 1} onClick={() => onPagina(meta.page - 1)}>‹ Anterior</button><span>Página {meta.page} de {meta.total_pages} ({meta.total_results} resultados)</span><button disabled={meta.page >= meta.total_pages} onClick={() => onPagina(meta.page + 1)}>Siguiente ›</button></div>;
}
