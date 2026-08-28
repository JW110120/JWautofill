// 热键触发端到端测试：
//   1) 连接守护进程 -> 备份当前 hotkeys.json
//   2) 推送一条测试映射 Ctrl+Alt+Shift+F12 -> 集中/小
//   3) 打开一个空白 Notepad 并激活，用 SendKeys 合成按键（不干扰 Photoshop）
//   4) 观察守护进程是否广播 {type:'hotkey'}
//   5) 还原用户原配置并退出
// 目的：判定 RegisterHotKey 是否真的能把 WM_HOTKEY 投递到守护进程的消息窗口。
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';

const CFG = process.env.LOCALAPPDATA + '\\JWautofill\\hotkeys.json';
const TEST_COMBO = 'Ctrl+Alt+Shift+F12';
const TEST_BRUSH = '集中/小';

const backup = fs.existsSync(CFG) ? fs.readFileSync(CFG) : null;
console.log('[test] backup exists:', backup !== null);

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
    else if (opcode === 0x8) { console.log('[test] server close'); }
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

function run() {
  console.log('[test] pushing test config: ' + TEST_COMBO + ' -> ' + TEST_BRUSH);
  sendText(JSON.stringify({ type: 'config', payload: [
    { id: 'bk_hotkeytest', combo: TEST_COMBO, action: 'applyBrush', brush: TEST_BRUSH }
  ]}));

  setTimeout(() => {
    console.log('[test] synthesizing keystroke via Notepad (PS not focused)');
    try {
      execSync('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
        'F:\\Coding\\JWautofill\\analysis\\hotkey\\send_test_key.ps1"', { stdio: 'ignore' });
      console.log('[test] keystroke sent');
    } catch (e) { console.log('[test] keystroke send failed: ' + e.message); }
  }, 1200);

  setTimeout(() => {
    const hit = received.some(s => s.includes('"hotkey"'));
    console.log('[test] === RESULT: hotkey broadcast ' + (hit ? 'RECEIVED ✓' : 'NOT RECEIVED ✗') + ' ===');
    // 还原用户原配置
    try { sendText(JSON.stringify({ type: 'config', payload: backup ? JSON.parse(backup.toString()) : [] })); } catch { }
    setTimeout(() => { sock.end(); process.exit(hit ? 0 : 2); }, 800);
  }, 7000);
}

sock.on('error', (e) => { console.log('[test] sock err: ' + e.message); process.exit(1); });
