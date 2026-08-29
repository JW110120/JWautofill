// Pushes a hotkeys.json file to the daemon over WebSocket (same message the
// UXP panel sends), which forces a deterministic save + reload.
// usage: node push_config.mjs <path-to-hotkeys.json>
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';

const file = process.argv[2];
const payload = JSON.parse(fs.readFileSync(file, 'utf8'));

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
    sendText(JSON.stringify({ type: 'config', payload }));
    console.log('[push] sent ' + payload.length + ' entries');
    setTimeout(() => { try { sock.end(); } catch { /* ignore */ } process.exit(0); }, 800);
    return;
  }
});
sock.on('error', (e) => { console.log('[push] err ' + e.message); process.exit(1); });
