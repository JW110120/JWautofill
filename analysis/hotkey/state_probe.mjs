// Prints the daemon's internal state (active flag, loaded hotkey table, hook status).
import net from 'net';
import crypto from 'crypto';

const KEY = crypto.randomBytes(16).toString('base64');
const sock = net.connect(18923, '127.0.0.1');
let done = false;
let buf = Buffer.alloc(0);

function sendText(str) {
  const p = Buffer.from(str, 'utf8');
  const m = crypto.randomBytes(4);
  let h;
  if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
  else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
  const mk = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) mk[i] = p[i] ^ m[i % 4];
  sock.write(Buffer.concat([h, m, mk]));
}

sock.on('connect', () => {
  sock.write(
    'GET / HTTP/1.1\r\nHost: 127.0.0.1:18923\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Key: ' + KEY + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
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
    sendText('{"type":"getState"}');
    setTimeout(() => { try { sock.end(); } catch { /* ignore */ } process.exit(0); }, 1200);
    return;
  }
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 2) return;
    const l0 = buf[1] & 0x7f;
    let off = 2, len = l0;
    if (l0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    if (buf.length < off + len) return;
    const op = buf[0] & 0x0f;
    const p = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    if (op === 0x1) console.log(p.toString('utf8'));
  }
});
sock.on('error', (e) => { console.log('err ' + e.message); process.exit(1); });
