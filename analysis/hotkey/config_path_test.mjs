// 配置路径统一化测试：模拟 UXP 面板在 ws.onopen 时做的事
//   1) {type:'setConfigPath', path:'<PluginData>\\hotkeys.json'}   —— 与 license.json 等同目录
//   2) {type:'getConfig'}                                          —— 确认读到的是新路径的内容
//   3) {type:'shutdown'}                                           —— 守护进程优雅退出（面板「断开」用）
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';

const PLUGIN_DATA = process.env.APPDATA +
  '\\Adobe\\UXP\\PluginsStorage\\PHSP\\27\\External\\com.listen2me.jwautofill\\PluginData';
const TARGET = PLUGIN_DATA + '\\hotkeys.json';

const KEY = crypto.randomBytes(16).toString('base64');
const sock = net.connect(18923, '127.0.0.1');
let handshakeDone = false;
let buf = Buffer.alloc(0);
const received = [];

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
    if (opcode === 0x1) { const s = payload.toString('utf8'); received.push(s); console.log('[path] recv: ' + s.replace(/\s+/g, ' ')); }
    else if (opcode === 0x8) { console.log('[path] server closed'); }
  }
}

sock.on('connect', () => {
  sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:18923\r\nUpgrade: websocket\r\n' +
    'Connection: Upgrade\r\nSec-WebSocket-Key: ' + KEY + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
});

sock.on('data', (d) => {
  if (!handshakeDone) {
    buf = Buffer.concat([buf, d]);
    const s = buf.toString('latin1');
    const idx = s.indexOf('\r\n\r\n');
    if (idx === -1) return;
    if (!s.startsWith('HTTP/1.1 101')) { console.log('[path] handshake FAILED'); process.exit(1); }
    handshakeDone = true; buf = buf.subarray(idx + 4);
    console.log('[path] handshake OK');
    setTimeout(run, 300);
  } else { buf = Buffer.concat([buf, d]); handleFrames(); }
});

function run() {
  console.log('[path] setConfigPath -> ' + TARGET);
  sendText(JSON.stringify({ type: 'setConfigPath', path: TARGET }));

  setTimeout(() => {
    console.log('[path] getConfig');
    sendText(JSON.stringify({ type: 'getConfig' }));
  }, 900);

  setTimeout(() => {
    console.log('[path] hotkeys.json exists in PluginData: ' + fs.existsSync(TARGET));
    if (fs.existsSync(TARGET)) console.log('[path] content: ' + fs.readFileSync(TARGET, 'utf8').replace(/\s+/g, ' '));
    const store = process.env.LOCALAPPDATA + '\\JWautofill\\configpath.txt';
    console.log('[path] configpath.txt: ' + (fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : '(missing)'));
    console.log('[path] sending shutdown');
    sendText(JSON.stringify({ type: 'shutdown' }));
  }, 2200);

  setTimeout(() => { sock.end(); process.exit(0); }, 4000);
}

sock.on('error', (e) => { console.log('[path] sock err: ' + e.message); process.exit(1); });
