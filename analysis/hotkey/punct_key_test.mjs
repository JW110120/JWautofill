// 标点/符号键热键端到端测试：验证 ; ' 等符号能否被录制并触发。
//   1) 连接守护进程 -> 备份当前配置
//   2) 推送测试映射：Ctrl+Alt+;  与 Ctrl+Alt+'
//   3) 打开空白 Notepad 并激活，用 SendKeys 合成按键（不干扰 Photoshop）
//   4) 观察守护进程是否广播对应的 {type:'hotkey', combo: ...}
//   5) 还原原配置并退出
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';

const CFG = process.env.LOCALAPPDATA + '\\JWautofill\\hotkeys.json';
const STORE = process.env.LOCALAPPDATA + '\\JWautofill\\configpath.txt';
const realCfg = fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8').trim() : CFG;

const CASES = [
  { combo: 'Ctrl+Alt+;', send: '^%;' },
  { combo: "Ctrl+Alt+'", send: "^%'" }
];

const backup = fs.existsSync(realCfg) ? fs.readFileSync(realCfg) : null;
console.log('[test] config:', realCfg, '| backup exists:', backup !== null);

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
    if (opcode === 0x1) { const s = payload.toString('utf8'); received.push(s); console.log('[test] recv: ' + s); }
  }
}

sock.on('connect', () => {
  sock.write(
    'GET / HTTP/1.1\r\nHost: 127.0.0.1:18923\r\nUpgrade: websocket\r\n' +
    'Connection: Upgrade\r\nSec-WebSocket-Key: ' + KEY + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
  );
});

sock.on('data', (d) => {
  if (!handshakeDone) {
    buf = Buffer.concat([buf, d]);
    const s = buf.toString('latin1');
    const idx = s.indexOf('\r\n\r\n');
    if (idx === -1) return;
    if (!s.startsWith('HTTP/1.1 101')) { console.log('[test] handshake FAILED'); process.exit(1); }
    handshakeDone = true; buf = buf.subarray(idx + 4);
    console.log('[test] handshake OK');
    setTimeout(run, 300);
  } else { buf = Buffer.concat([buf, d]); handleFrames(); }
});

let idx = 0;
const results = [];

function pushTestConfig() {
  const c = CASES[idx];
  console.log(`[test] pushing ${c.combo}`);
  sendText(JSON.stringify({
    type: 'config',
    payload: [{ id: 'punct_test_' + idx, combo: c.combo, action: 'applyBrush', brush: '测试笔刷' }]
  }));
}

function step() {
  if (idx >= CASES.length) return finish();
  received.length = 0;
  pushTestConfig();
  setTimeout(() => {
    const c = CASES[idx];
    console.log('[test] sending keys: ' + c.send);
    try {
      execSync('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
        'F:\\Coding\\JWautofill\\analysis\\hotkey\\send_keys_param.ps1" -Keys "' + c.send + '"',
        { stdio: 'ignore' });
    } catch (e) { console.log('[test] send failed: ' + e.message); }
  }, 1000);
  setTimeout(() => {
    const c = CASES[idx];
    const hit = received.some(s => s.includes('"hotkey"') && s.includes(c.combo));
    results.push({ combo: c.combo, hit });
    console.log(`[test] ${c.combo} => ${hit ? 'HIT' : 'MISS'}`);
    idx++;
    step();
  }, 5000);
}

function finish() {
  const all = results.every(r => r.hit);
  console.log('[test] === RESULT ===');
  for (const r of results) console.log(`[test]   ${r.combo}: ${r.hit ? 'OK' : 'FAIL'}`);
  try { sendText(JSON.stringify({ type: 'config', payload: backup ? JSON.parse(backup.toString()) : [] })); } catch { }
  setTimeout(() => { sock.end(); process.exit(all ? 0 : 2); }, 900);
}

function run() { step(); }

sock.on('error', (e) => { console.log('[test] sock err: ' + e.message); process.exit(1); });
