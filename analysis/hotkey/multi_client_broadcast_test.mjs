// Verifies the daemon broadcasts a hotkey hit to EVERY connected client.
// Opens N raw WS clients, waits for the user (or send_vk.ps1) to press Ctrl+Q,
// then reports how many clients received the {"type":"hotkey"} frame.
import net from 'net';
import crypto from 'crypto';

const N = Number(process.argv[2] || 2);
const SECONDS = Number(process.argv[3] || 12);

function makeClient(idx) {
  return new Promise((resolve) => {
    const KEY = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(18923, '127.0.0.1');
    let handshaked = false;
    let buf = Buffer.alloc(0);
    const hits = [];

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
        console.log(`[client#${idx}] handshake OK`);
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
        if (msg?.type === 'hotkey') { hits.push(msg); console.log(`[client#${idx}] HOTKEY ${JSON.stringify(msg)}`); }
        if (msg?.type === 'mainToggle') { hits.push(msg); console.log(`[client#${idx}] MAINTOGGLE ${JSON.stringify(msg)}`); }
      }
    });

    sock.on('error', (e) => console.log(`[client#${idx}] err ${e.message}`));
    resolve({ idx, sock, hits, end: () => { try { sock.destroy(); } catch { } } });
  });
}

const clients = [];
for (let i = 1; i <= N; i++) clients.push(await makeClient(i));
console.log(`\n>>> ${N} clients connected. Press Ctrl+Q now (waiting ${SECONDS}s)...\n`);

setTimeout(() => {
  console.log('\n=== RESULT ===');
  for (const c of clients) {
    console.log(`client#${c.idx}: received ${c.hits.length} hotkey/mainToggle frame(s)`);
    c.end();
  }
  process.exit(0);
}, SECONDS * 1000);
