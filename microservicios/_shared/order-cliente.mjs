// Cliente gRPC de ms_order (existente). Payment y Refund lo usan para validar la orden y avanzar su estado.
//   MS_ORDER_GRPC=host:puerto (por defecto 127.0.0.1:50062, el GRPC_PORT de ms_order en el mismo contenedor).
//   MS_ORDER_CHECK=off desactiva la integración (solo para pruebas aisladas).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearClienteGrpc } from './grpc-cliente.mjs';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = crearClienteGrpc({ nombre: 'Order', protoPath: path.join(raiz, 'ms_order/proto/ms_order.proto'), paquete: 'ms_order.v1', servicio: 'OrderService', target: () => process.env.MS_ORDER_GRPC ?? '127.0.0.1:50062' });
export const ordenActivo = () => (process.env.MS_ORDER_CHECK ?? 'on') !== 'off';
export const rpcOrder = c.rpc;
export const obtenerOrden = (ord_id) => c.rpc('GetOrder', { ord_id });
export const cambiarEstadoOrden = (ord_id, est_codigo) => c.rpc('UpdateOrderStatus', { ord_id, est_codigo });
export const cerrarClienteOrder = c.cerrar;
