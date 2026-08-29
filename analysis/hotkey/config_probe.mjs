// Read-only probe: ask the daemon what config it currently holds.
import net from 'net';
import crypto from 'crypto';

const KEY = crypto.randomBytes(16).toString('base64');
const EXPECT = crypto.createHash('sha1').update(KEY + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
const sock = net.connect(18923, '127.0.0.1');
const log = (m) => console.log('[probe] ' + m);

sock.on('connect', () => {
  sock.write(
    'GET / HTTP/1.1\r\nHost: 127.0.0.1:18923\r\nUpgrade: websocket\r\n' +
    'Connection: Upgrade\r\nSec-WebSocket-Key: ' + KEY + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
  );
});

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

function frames() {
  for (;;) {
    if (buf.length < 2) return;
    const l0 = buf[1] & 0x7f;
    let off = 2, len = l0;
    if (l0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (l0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const op = buf[0] & 0x0f;
    const p = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    if (op === 0x1) log('recv: ' + p.toString('utf8'));
    else if (op === 0x8) { sock.end(); }
  }
}

sock.on('data', (d) => {
  if (!done) {
    buf = Buffer.concat([buf, d]);
    const s = buf.toString('latin1');
    const i = s.indexOf('\r\n\r\n');
    if (i === -1) return;
    done = true;
    buf = buf.subarray(i + 4);
    sendText(JSON.stringify({ type: 'getConfig' }));
    setTimeout(() => { sock.end(); process.exit(0); }, 1500);
  } else {
    buf = Buffer.concat([buf, d]);
    frames();
  }
});
sock.on('error', (e) => { log('err ' + e.message); process.exit(1); });
