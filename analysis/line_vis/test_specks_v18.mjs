// test_specks_v18.mjs —— 验证「线外游离杂点」被消除，且线条平滑/宽度/抗锯齿不退化
// 指标：新生成游离像素(背景→内容) + 原杂点像素存活(应=0) + 主线保留率(不含杂点)
import { processLineSmooth, defaultLineSmoothParams } from '../../src/adjustments/lineSmoothProcessor.ts';
import fs from 'fs';
import zlib from 'zlib';

const THR = 16;
const W = 300, H = 300;

// ---- 生成一条带铅笔粗细抖动的平滑主曲线 ----
function makeLine() {
  const alpha = new Float32Array(W * H);
  const cx = (y) => 150 + 70 * Math.sin(y / 70);   // 主曲线
  for (let y = 10; y < H - 10; y++) {
    const cy = cx(y);
    const halfW = 9 + 2 * Math.sin(y / 11);          // 粗细抖动
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x - cy);
      let a = 0;
      if (d < halfW) a = 235 - (d / halfW) * 30 + (Math.random() * 16 - 8);
      else if (d < halfW + 1.5) a = 60 * (1 - (d - halfW) / 1.5);
      if (a > 0) alpha[y * W + x] = Math.max(0, Math.min(255, a));
    }
  }
  return alpha;
}

// ---- 在线外随机撒 N 个杂点（孤立、不同 alpha、距线 2~12px） ----
function addSpecks(alpha, n) {
  const seeds = [];
  let placed = 0, guard = 0;
  while (placed < n && guard < n * 50) {
    guard++;
    const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
    if (alpha[y * W + x] > THR) continue;            // 不要压到线上
    // 确认附近没有线（距线≥2px 视为游离）
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (alpha[yy * W + xx] > THR) near = true;
    }
    if (near) continue;
    const a = 40 + (Math.random() * 215) | 0;        // 杂点 alpha 40~255
    const r = (Math.random() * 1.3) | 0;             // 单点或 2x2
    for (let dy = 0; dy <= r && y + dy < H; dy++)
      for (let dx = 0; dx <= r && x + dx < W; dx++)
        if (alpha[(y + dy) * W + (x + dx)] <= THR) alpha[(y + dy) * W + (x + dx)] = a;
    seeds.push([x, y]);
    placed++;
  }
  return seeds;
}

const base = makeLine();
const speckSeeds = addSpecks(base, 120);
const alpha = base;

// ---- 构造 RGBA（灰度，便于洪泛取色一致） ----
const buf = new ArrayBuffer(W * H * 4);
const u = new Uint8Array(buf);
for (let i = 0; i < W * H; i++) {
  const a = alpha[i] | 0;
  u[i * 4] = a; u[i * 4 + 1] = a; u[i * 4 + 2] = a; u[i * 4 + 3] = a;
}
const sel = new Uint8Array(W * H).fill(1);

const outBuf = await processLineSmooth(buf, sel.buffer, { width: W, height: H }, defaultLineSmoothParams);
const out = new Uint8Array(outBuf);
const outA = new Int16Array(W * H);
for (let i = 0; i < W * H; i++) outA[i] = out[i * 4 + 3];

// ---- 指标 ----
function lineStats(arr) {
  let line = 0, sumW = 0, nRows = 0, soft = 0, edge = 0;
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) { if (arr[y * W + x] > THR) c++; }
    if (c > 0) { sumW += c; nRows++; line += c; }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, a = arr[i];
    if (a <= THR) continue;
    let isEdge = false;
    if (x > 0 && arr[i - 1] <= THR) isEdge = true;
    else if (x + 1 < W && arr[i + 1] <= THR) isEdge = true;
    else if (y > 0 && arr[i - W] <= THR) isEdge = true;
    else if (y + 1 < H && arr[i + W] <= THR) isEdge = true;
    if (isEdge) { edge++; if (a < 150) soft++; }
  }
  return { linePixels: line, avgWidth: nRows ? (sumW / nRows).toFixed(2) : 0, aa: edge ? (soft / edge * 100).toFixed(1) + '%' : 'n/a' };
}
const sOrig = lineStats(alpha.map(a => a | 0));
const sOut = lineStats(outA);
console.log('原线:', sOrig);
console.log('平滑后:', sOut);

// 杂点残留：原为背景(<=THR)且距最近原线像素≥2px，但输出仍>THR 的游离像素
function distToLine(x, y) {
  let best = 99;
  for (let r = 1; r <= 2; r++)
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (alpha[yy * W + xx] > THR) best = Math.min(best, r);
    }
  return best;
}
let residual = 0, residualStrong = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x;
  if (alpha[i] <= THR && outA[i] > THR) {
    if (distToLine(x, y) >= 2) { residual++; if (outA[i] > 60) residualStrong++; }
  }
}
console.log('撒入杂点:', speckSeeds.length, ' 个');
console.log('新生成游离像素(距线≥2px):', residual, ' 其中较强(>60):', residualStrong);

// 原杂点存活：种子位置(含 2x2 扩展)的像素，输出仍>THR 的数量
const speckPixels = new Set();
for (const [sx, sy] of speckSeeds) {
  for (let dy = 0; dy < 2 && sy + dy < H; dy++)
    for (let dx = 0; dx < 2 && sx + dx < W; dx++) {
      const i = (sy + dy) * W + (sx + dx);
      if (alpha[i] > THR) speckPixels.add(i);
    }
}
let speckSurvived = 0;
for (const i of speckPixels) if (outA[i] > THR) speckSurvived++;
console.log(`原杂点像素存活: ${speckSurvived}/${speckPixels.size}  (目标 0)`);

// 主线保留：原线像素(不含杂点)中，输出仍>THR 的比例
let keep = 0, total = 0;
for (let i = 0; i < W * H; i++) if (alpha[i] > THR && !speckPixels.has(i)) { total++; if (outA[i] > THR) keep++; }
console.log('主线像素保留率(不含杂点):', (keep / total * 100).toFixed(2) + '%');

// ---- 渲染：左原(黑底白线) | 右平滑(白底黑线) ----
function writeRGBPNG(path, w, h, getRGB) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = getRGB(x, y); const o = (y * w + x) * 3;
    px[o] = r; px[o + 1] = g; px[o + 2] = b;
  }
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const tt = Buffer.from(t); const crc = Buffer.alloc(4); let c = 0xFFFFFFFF; const cd = Buffer.concat([tt, d]); for (let i = 0; i < cd.length; i++) c = crcT[(c ^ cd[i]) & 0xFF] ^ (c >>> 8); crc.writeUInt32BE(c >>> 0, 0); return Buffer.concat([l, cd, crc]); }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(path, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
}
let crcT = null; (function () { crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crcT[n] = c >>> 0; } })();

writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/v18_specks.png', W * 2, H, (x, y) => {
  const panel = x < W ? 0 : 1; const lx = x - (panel ? W : 0); const i = y * W + lx;
  if (panel === 0) { const a = alpha[i]; return [a, a, a]; }       // 黑底：原线(白) + 杂点
  const a = outA[i]; return [255 - Math.min(255, a), 255 - Math.min(255, a), 255 - Math.min(255, a)]; // 白底黑线
});
console.log('\n已写出 v18_specks.png');
