import { Inject, Injectable } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { badRequest, notFound, unprocessable, type InvalidParam } from '../common/problem.js';
import { cedulaValida } from '../common/util.js';
import { config } from '../config.js';

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const tipoDe = (id: string) => (/^\d{10}$/.test(id) ? 'CEDULA' : /^\d{13}$/.test(id) ? 'RUC' : 'PASAPORTE');
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

const dto = (r: any) => ({
  client_id: String(r.cli_id), nombre: r.cli_nombre, email: r.cli_correo, identificacion: r.cli_documento,
  tipo_identificacion: r.cli_tipo_documento, telefono: r.cli_telefono === 'N/D' ? null : r.cli_telefono,
});

/** Módulo de clientes del contrato v3.1: Booking consulta/crea al turista sin duplicarlo (único por tipo+documento). */
@Injectable()
export class ClientesService {
  constructor(@Inject(Db) private db: Db) {}

  /** GET /clientes?email=&identificacion= — busca primero por identificación y, si no, por correo. */
  async buscar(q: Record<string, any>) {
    const email = str(q.email).toLowerCase(); const ident = str(q.identificacion ?? q.identification ?? q.documento);
    if (!email && !ident) throw badRequest('Indique email y/o identificacion.', 'VALIDATION_ERROR', [{ name: 'email|identificacion', reason: 'Al menos uno es obligatorio' }]);
    if (email && !EMAIL_RE.test(email)) throw badRequest('El email no tiene un formato válido.', 'VALIDATION_ERROR', [{ name: 'email', reason: 'Formato inválido' }]);
    if (ident.length > 20) throw badRequest('La identificación supera los 20 caracteres.', 'VALIDATION_ERROR', [{ name: 'identificacion', reason: 'Máximo 20 caracteres' }]);
    let row: any;
    if (ident) row = (await this.db.query('SELECT * FROM cliente WHERE lower(cli_documento)=lower($1) ORDER BY cli_actualizado_en DESC LIMIT 1', [ident]))[0];
    if (!row && email) row = (await this.db.query('SELECT * FROM cliente WHERE lower(cli_correo)=$1 ORDER BY cli_actualizado_en DESC, cli_id DESC LIMIT 1', [email]))[0];
    if (!row) throw notFound('No existe un cliente con esos datos.', 'CLIENT_NOT_FOUND');
    return dto(row);
  }

  /** POST /clientes — idempotente: si ya existe (mismo tipo+documento) devuelve el mismo client_id con 200, sin duplicar. */
  async crear(b: any): Promise<{ status: number; body: any }> {
    const nombre = str(b?.nombre ?? b?.full_name ?? b?.name); const email = str(b?.email ?? b?.correo).toLowerCase();
    const ident = str(b?.identificacion ?? b?.documento ?? b?.document_id); const tel = str(b?.telefono ?? b?.phone).replace(/[\s-]/g, '');
    const inv: InvalidParam[] = [];
    if (nombre.length < 2 || nombre.length > 150) inv.push({ name: 'nombre', reason: 'Obligatorio, entre 2 y 150 caracteres' });
    if (!EMAIL_RE.test(email) || email.length > 160) inv.push({ name: 'email', reason: 'Obligatorio, con formato de correo válido' });
    if (!ident || ident.length > 20 || !/^[A-Za-z0-9]+$/.test(ident)) inv.push({ name: 'identificacion', reason: 'Obligatoria, alfanumérica, máximo 20 caracteres' });
    if (tel && !/^\+?[0-9]{7,15}$/.test(tel)) inv.push({ name: 'telefono', reason: 'Formato internacional (+593...) o celular ecuatoriano (09XXXXXXXX)' });
    const tipo = str(b?.tipo_identificacion ?? b?.tipo_documento).toUpperCase() || tipoDe(ident);
    if (!['CEDULA', 'PASAPORTE', 'RUC'].includes(tipo)) inv.push({ name: 'tipo_identificacion', reason: 'CEDULA | PASAPORTE | RUC' });
    if (inv.length) throw badRequest('Datos del cliente inválidos.', 'VALIDATION_ERROR', inv);
    const sem: InvalidParam[] = [];
    if (tipo === 'CEDULA' && config.validateCedula && !cedulaValida(ident)) sem.push({ name: 'identificacion', reason: 'La cédula no supera la validación módulo 10 del Registro Civil.' });
    if (tipo === 'PASAPORTE' && !/^[A-Za-z0-9]{6,9}$/.test(ident)) sem.push({ name: 'identificacion', reason: 'El pasaporte debe tener entre 6 y 9 caracteres alfanuméricos.' });
    if (tipo === 'RUC' && !/^\d{13}$/.test(ident)) sem.push({ name: 'identificacion', reason: 'El RUC debe tener 13 dígitos.' });
    if (sem.length) throw unprocessable('La identificación no es válida.', 'SEMANTIC_VALIDATION_FAILED', sem);

    const r = (await this.db.query(
      `INSERT INTO cliente (cli_tipo_documento, cli_documento, cli_nombre, cli_correo, cli_telefono) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (cli_tipo_documento, cli_documento) DO UPDATE SET cli_tipo_documento = cliente.cli_tipo_documento
       RETURNING cli_id, (xmax = 0) AS nuevo`, [tipo, ident, nombre, email, tel || 'N/D']))[0];
    return { status: r.nuevo ? 201 : 200, body: { client_id: String(r.cli_id) } };
  }
}
