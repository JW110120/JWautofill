// 用修复后的 lineSmoothProcessor 直接跑 "原始.log"，并与用户 "平滑后.log" 对比。
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { processLineSmooth } from '../../src/adjustments/lineSmoothProcessor.ts';

function parseLog(path) {
  const text = readFileSync(path, 'latin1');
  const grid = new Map();
  let maxX = 0;
  for (const ln of text.split(/\r?\n/)) {
    const m = ln.match(/y=(\d+):\s*(.*)$/);
    if (!m) continue;
    const y = parseInt(m[1], 10);
    const vals = m[2].split(',').map((s) => (s.trim() === '' ? 0 : parseInt(s, 10) || 0));
    grid.set(y, vals);
    if (vals.length > maxX) maxX = vals.length;
  }
  const ys = [...grid.keys()].sort((a, b) => a - b);
  const h = ys.length ? ys[ys.length - 1] + 1 : 0;
  const w = maxX;
  const arr = new Uint8Array(w * h);
  for (const y of ys) {
    const vals = grid.get(y);
    for (let x = 0; x < vals.length; x++) arr[y * w + x] = vals[x];
  }
  return { w, h, arr };
}

function writeGrayPNG(path, w, h, getByte) {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = getByte(x, y) & 0xff;
  }
  const idat = zlib.deflateSync(raw);
  const crc = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crcBuf]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  writeFileSync(path, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
}

const clampInt = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

function writeRGBPNG(path, w, h, getRGB) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = getRGB(x, y);
      raw[y * (w * 3 + 1) + 1 + x * 3] = r;
      raw[y * (w * 3 + 1) + 1 + x * 3 + 1] = g;
      raw[y * (w * 3 + 1) + 1 + x * 3 + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const crc = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crcBuf]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  writeFileSync(path, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
}

const orig = parseLog('C:/Users/Administrator/Desktop/原始.log');
const userSm = parseLog('C:/Users/Administrator/Desktop/平滑后.log');
const W = orig.w, H = orig.h;
console.log('尺寸', W, 'x', H);

// 构造 RGBA 与选区
const pixels = new Uint8Array(W * H * 4);
const sel = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const a = orig.arr[i];
  pixels[i * 4] = 128; pixels[i * 4 + 1] = 128; pixels[i * 4 + 2] = 128; pixels[i * 4 + 3] = a;
  sel[i] = 1; // 全选，等价于用户在曲线周围框选含线的区域
}

const outBuf = await processLineSmooth(pixels.buffer, sel.buffer, { width: W, height: H }, { strength: 1, radius: 8 });
const out = new Uint8Array(outBuf);
const fixed = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) fixed[i] = out[i * 4 + 3];

const THR = 16;
function diag(label, smArr) {
  let holes = 0, news = 0, same = 0, lineO = 0, lineS = 0;
  const holeList = [], newList = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const aO = orig.arr[i], aS = smArr[i];
      const oL = aO > THR, sL = aS > THR;
      if (oL) lineO++;
      if (sL) lineS++;
      if (oL && sL) same++;
      if (oL && !sL) { holes++; if (holeList.length < 40) holeList.push([x, y, aO, aS]); }
      if (!oL && sL) { news++; if (newList.length < 40) newList.push([x, y, aO, aS]); }
    }
  }
  console.log(`\n=== ${label} ===`);
  console.log(`  原线像素=${lineO} 平滑线像素=${lineS} 交集=${same}`);
  console.log(`  孔洞(原→背景)=${holes} 新增(背景→线)=${news}`);
  console.log('  孔洞样例 (x,y,原a,平a):', JSON.stringify(holeList));
  console.log('  新增样例 (x,y,原a,平a):', JSON.stringify(newList.slice(0, 20)));
}

// 用户旧结果
diag('用户平滑后', userSm.arr);
// 修复后结果
diag('修复后算法', fixed);

// 写出修复后的 alpha 图与对比图
writeGrayPNG('F:/Coding/JWautofill/analysis/line_vis/fixed_sm.png', W, H, (x, y) => fixed[y * W + x]);
writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/fixed_diff.png', W, H, (x, y) => {
  const i = y * W + x;
  const aO = orig.arr[i], aF = fixed[i];
  const oL = aO > THR, fL = aF > THR;
  if (oL && !fL) return [60, 80, 255];   // 蓝=孔洞
  if (!oL && fL) return [230, 50, 50];   // 红=新增
  if (oL && fL) return [0, 200, 200];    // 青=保留
  return [10, 10, 10];
});

// 4x 放大 diff
function upscaleGray(srcW, srcH, factor, getGray) {
  const dw = srcW * factor, dh = srcH * factor;
  writeGrayPNG('F:/Coding/JWautofill/analysis/line_vis/fixed_diff_4x.png', dw, dh, (x, y) => getGray(x / factor | 0, y / factor | 0));
}
upscaleGray(W, H, 4, (x, y) => {
  const i = y * W + x;
  const aO = orig.arr[i], aF = fixed[i];
  const oL = aO > THR, fL = aF > THR;
  if (oL && !fL) return 240;
  if (!oL && fL) return 140;
  if (oL && fL) return 60;
  return 0;
});

// 三列对比图：原图 | 用户平滑后 | 修复后
writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/compare_panels.png', W * 3, H, (x, y) => {
  const panel = Math.floor(x / W);
  const lx = x - panel * W;
  const i = y * W + lx;
  if (panel === 0) { const v = orig.arr[i]; return [v, v, v]; }
  if (panel === 1) { const v = userSm.arr[i]; return [v, v, v]; }
  const v = fixed[i]; return [v, v, v];
});

// 用户旧结果 vs 修复后：蓝=旧结果里的孔洞（在修复后被补回），红=修复后新增覆盖
function writeUserVsFixed(path, w, h, scale) {
  const dw = w * scale, dh = h * scale;
  writeRGBPNG(path, dw, dh, (x, y) => {
    const sx = x / scale | 0, sy = y / scale | 0;
    if (sx >= w || sy >= h) return [0, 0, 0];
    const i = sy * w + sx;
    const aU = userSm.arr[i], aF = fixed[i];
    const uL = aU > THR, fL = aF > THR;
    if (!uL && fL) return [230, 50, 50];   // 修复后新增
    if (uL && !fL) return [50, 50, 230];   // 修复后又丢了（不应出现）
    if (aU <= THR && aF <= THR) return [10, 10, 10]; // 都背景
    const d = aF - aU;
    const v = clampInt(128 + d, 0, 255);
    return [v, v, v];
  });
}
writeUserVsFixed('F:/Coding/JWautofill/analysis/line_vis/fixed_vs_user.png', W, H, 1);
writeUserVsFixed('F:/Coding/JWautofill/analysis/line_vis/fixed_vs_user_4x.png', W, H, 4);

console.log('\n已写出 fixed_sm.png / fixed_diff.png / fixed_diff_4x.png / compare_panels.png / fixed_vs_user.png / fixed_vs_user_4x.png');
