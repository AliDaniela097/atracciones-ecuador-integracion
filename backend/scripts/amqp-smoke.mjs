// Prueba de humo contra el RabbitMQ REAL (CloudAMQP) desde tu PC. NO afecta a otras tiendas: usa una cola temporal propia y una clave privada.
//   $env:AMQP_URL = Read-Host "AMQP_URL"   (pegarla sin mostrarla)   →   node scripts/amqp-smoke.mjs
// Comprueba: conexión TLS (5671), que existe el exchange booking.events y que se puede publicar y recibir. Nunca imprime la URL.
import amqp from 'amqplib';
const url = process.env.AMQP_URL;
if (!url) { console.error('Falta la variable AMQP_URL.'); process.exit(1); }
const host = (() => { try { return new URL(url).host; } catch { return '(URL inválida)'; } })();
const EX = process.env.AMQP_EXCHANGE ?? 'booking.events'; const KEY = 'atracciones.alisson.smoke';
const paso = (ok, m) => console.log(`${ok ? '✔' : '✘'} ${m}`);
let conn;
try {
  conn = await amqp.connect(url, { heartbeat: 30, timeout: 10_000 }); paso(true, `Conectado a ${host}`);
  const ch = await conn.createConfirmChannel();
  try { await ch.checkExchange(EX); paso(true, `El exchange ${EX} existe`); }
  catch (e) { paso(false, `El exchange ${EX} no existe o no hay permiso (${e.message})`); process.exit(2); }
  const ch2 = await conn.createChannel(); // el chequeo fallido cierra su canal; se usa otro limpio
  const q = (await ch2.assertQueue('', { exclusive: true, autoDelete: true })).queue; await ch2.bindQueue(q, EX, KEY);
  const id = crypto.randomUUID();
  const ev = { specversion: '1.0', id, type: 'com.booking.smoke.test', source: 'NODE_ATR_ALISSON', time: new Date().toISOString(), datacontenttype: 'application/json', correlationid: crypto.randomUUID(), node_id: 'NODE_ATR_ALISSON', data: { prueba: true } };
  await new Promise((res, rej) => ch.publish(EX, KEY, Buffer.from(JSON.stringify(ev)), { deliveryMode: 2, contentType: 'application/json', messageId: id }, (e) => (e ? rej(e) : res())));
  paso(true, 'El broker confirmó la publicación');
  let got; for (let i = 0; i < 20 && !got; i++) { got = await ch2.get(q, { noAck: true }); if (!got) await new Promise((r) => setTimeout(r, 250)); }
  paso(!!got && JSON.parse(got.content.toString()).id === id, 'El mensaje de prueba se recibió completo');
  console.log('\nTodo bien: el bus es alcanzable desde esta máquina. Esta conexión se cierra ahora.');
} catch (e) { paso(false, `Falló: ${String(e.message).replace(/amqps?:\/\/[^\s]+/g, 'amqp://***')}`); process.exitCode = 1; }
finally { await conn?.close().catch(() => {}); }
