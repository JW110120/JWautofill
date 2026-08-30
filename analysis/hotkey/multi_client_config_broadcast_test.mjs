// Tests the daemon's multi-client broadcast path without needing a keypress.
// Pushing a "config" message makes the daemon SaveConfig -> ReloadConfig -> BroadcastConfig(),
// which uses the very same Broadcast() used for hotkey hits.
// If only ONE client receives the echo, cross-panel delivery is broken at the daemon.
import net from 'net';
import crypto from 'crypto';

const N = Number(process.argv[2] || 2);
const SECONDS = Number(process.argv[3] || 6);

function makeClient(idx) {
  return new Promise((resolve) => {
    const KEY = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(18923, '127.0.0.1');
    let handshaked = false;
    let buf = Buffer.alloc(0);
    const seen = [];

    sock.on('connect', () => {
      sock.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1:18923\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + KEY + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaked) {
        const s = buf.toString('latin1');
        const i = s.indexOf('\r\n\r\n');
        if (i === -1) return;
        handshaked = true;
        buf = buf.subarray(i + 4);
      }
      for (;;) {
        if (buf.length < 2) return;
        const l0 = buf[1] & 0x7f;
        let off = 2, len = l0;
        if (l0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (l0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const op = buf[0] & 0x0f;
        const p = buf.subarray(off, off + len).toString('utf8');
        buf = buf.subarray(off + len);
        if (op !== 0x1) continue;
        let msg = null;
        try { msg = JSON.parse(p); } catch { continue; }
        seen.push(msg.type);
        console.log(`[client#${idx}] <- ${msg.type}`);
      }
    });

    sock.on('error', (e) => console.log(`[client#${idx}] err ${e.message}`));
    setTimeout(() => resolve({
      idx, sock, seen,
      send: (o) => {
        const payload = Buffer.from(JSON.stringify(o), 'utf8');
        const mask = crypto.randomBytes(4);
        let head;
        if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
        else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
        sock.write(Buffer.concat([head, mask, masked]));
      },
      end: () => { try { sock.destroy(); } catch { } }
    }), 300);
  });
}

const clients = [];
for (let i = 1; i <= N; i++) clients.push(await makeClient(i));
console.log(`\n>>> ${N} clients connected; client#1 will push a config to trigger a broadcast.\n`);

setTimeout(() => {
  clients[0].send({ type: 'getConfig' });
}, 800);
setTimeout(() => {
  clients[0].send({
    type: 'config',
    payload: [{ id: 'main_toggle', combo: 'Ctrl+Q', action: 'toggleMain', brush: '' }]
  });
}, 1600);

setTimeout(() => {
  console.log('\n=== RESULT (config broadcasts received AFTER the push) ===');
  for (const c of clients) {
    console.log(`client#${c.idx}: ${c.seen.length} text frames -> ${JSON.stringify(c.seen)}`);
    c.end();
  }
  process.exit(0);
}, SECONDS * 1000);
