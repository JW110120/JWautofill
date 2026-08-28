// 原始 TCP WebSocket 客户端：完整模拟 UXP 端行为（握手、掩码帧收发）
// 验证链路：getConfig -> 推送 config(小写键) -> 重新 getConfig -> 检查 hotkeys.json 落盘
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';

const KEY = crypto.randomBytes(16).toString('base64');
const EXPECT = crypto.createHash('sha1').update(KEY + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
const sock = net.connect(18923, '127.0.0.1');
const log = (m) => console.log('[test] ' + m);

sock.on('connect', () => {
  log('tcp connected, sending handshake');
  sock.write(
    'GET / HTTP/1.1\r\n' +
    'Host: 127.0.0.1:18923\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Key: ' + KEY + '\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );
});

let handshakeDone = false;
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

function handleFrames() {
  while (true) {
    if (buf.length < 2) return;
    const len0 = buf[1] & 0x7f;
    let off = 2, len = len0;
    if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const opcode = buf[0] & 0x0f;
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    if (opcode === 0x1) log('recv: ' + payload.toString('utf8'));
    else if (opcode === 0x8) { log('server sent close'); sock.end(); }
  }
}

sock.on('data', (d) => {
  if (!handshakeDone) {
    buf = Buffer.concat([buf, d]);
    const s = buf.toString('latin1');
    const idx = s.indexOf('\r\n\r\n');
    if (idx === -1) return;
    log('handshake response: ' + JSON.stringify(s.slice(0, idx + 4)));
    if (s.startsWith('HTTP/1.1 101') && s.includes(EXPECT)) {
      handshakeDone = true;
      buf = buf.subarray(idx + 4);
      log('handshake OK');
      sendText(JSON.stringify({ type: 'getConfig' }));
      setTimeout(() => {
        log('>>> pushing config with lowercase keys (identical to UXP pushConfig)');
        sendText(JSON.stringify({ type: 'config', payload: [
          { id: 'bk_test', combo: 'Ctrl+Alt+K', action: 'applyBrush', brush: '多线混合' }
        ]}));
      }, 400);
      setTimeout(() => {
        log('>>> getConfig again');
        sendText(JSON.stringify({ type: 'getConfig' }));
      }, 1200);
      setTimeout(() => {
        const p = process.env.LOCALAPPDATA + '\\JWautofill\\hotkeys.json';
        log('hotkeys.json exists: ' + fs.existsSync(p));
        try { log('content: ' + fs.readFileSync(p, 'utf8')); } catch (e) { log('read err: ' + e.message); }
        sock.end(); process.exit(0);
      }, 2200);
    } else {
      log('!!! handshake FAILED');
      sock.end(); process.exit(1);
    }
  } else {
    buf = Buffer.concat([buf, d]);
    handleFrames();
  }
});
sock.on('error', (e) => { log('sock err: ' + e.message); process.exit(1); });
