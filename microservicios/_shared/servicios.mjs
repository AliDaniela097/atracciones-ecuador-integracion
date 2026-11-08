// Catálogo de los 13 microservicios nuevos (los otros 3 —inventory, order, booking— son gRPC y ya existen).
// Puertos: solo escuchan en 127.0.0.1 (MS_BIND). Hacia afuera se expone únicamente el backend (ver README).
export const SERVICIOS = {
  identity:        { puerto: 50101, db: 'ms_identity',        protocolo: 'REST' },
  billing_profile: { puerto: 50102, db: 'ms_billing_profile', protocolo: 'REST' },
  location:        { puerto: 50103, db: 'ms_location',        protocolo: 'REST' },
  catalog:         { puerto: 50104, db: 'ms_catalog',         protocolo: 'REST' },
  review:          { puerto: 50105, db: 'ms_review',          protocolo: 'REST' },
  cart:            { puerto: 50106, db: 'ms_cart',            protocolo: 'REST' },
  coupon:          { puerto: 50107, db: 'ms_coupon',          protocolo: 'REST' },
  payment:         { puerto: 50108, db: 'ms_payment',         protocolo: 'REST' },
  refund:          { puerto: 50109, db: 'ms_refund',          protocolo: 'REST' },
  support:         { puerto: 50110, db: 'ms_support',         protocolo: 'REST' },
  audit:           { puerto: 50111, db: 'ms_audit',           protocolo: 'REST' },
  pricing:         { puerto: 50112, db: 'ms_pricing',         protocolo: 'gRPC' },
  invoicing:       { puerto: 50113, db: 'ms_invoicing',       protocolo: 'SOAP' },
};
export const puertoDe = (n) => Number(process.env[`MS_${n.toUpperCase()}_PORT`] ?? SERVICIOS[n].puerto);
export const urlDe = (n) => process.env[`MS_${n.toUpperCase()}_URL`] ?? `http://127.0.0.1:${puertoDe(n)}`;
