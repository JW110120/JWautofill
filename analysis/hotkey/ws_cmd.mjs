// Sends a single JSON message to the daemon over WebSocket.
// usage: node ws_cmd.mjs '{"type":"shutdown"}'
import net from 'net';
import crypto from 'crypto';

const payloadText = process.argv[2];
const KEY = crypto.randomBytes(16).toString('base64');
const EXPECT = crypto.createHash('sha1').update(KEY + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
const sock = net.connect(18923, '127.0.0.1');
let done = false;
let buf = Buffer.alloc(0);

function sendText(str) {
  const payload = Buffer.from(str, 'utf8');
  const mask = crypto.randomBytes(4);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  sock.write(Buffer.concat([head, mask, masked]));
}

sock.on('connect', () => {
  sock.write(
    'GET / HTTP/1.1\r\nHost: 127.0.0.1:18923\r\nUpgrade: websocket\r\n' +
    'Connection: Upgrade\r\nSec-WebSocket-Key: ' + KEY + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
  );
});

sock.on('data', (d) => {
  if (!done) {
    buf = Buffer.concat([buf, d]);
    const s = buf.toString('latin1');
    const i = s.indexOf('\r\n\r\n');
    if (i === -1) return;
    done = true;
    buf = buf.subarray(i + 4);
    sendText(payloadText);
    console.log('[cmd] sent ' + payloadText);
    setTimeout(() => { try { sock.end(); } catch { /* ignore */ } process.exit(0); }, 1500);
  }
});
sock.on('error', (e) => { console.log('[cmd] err ' + e.message); process.exit(1); });
