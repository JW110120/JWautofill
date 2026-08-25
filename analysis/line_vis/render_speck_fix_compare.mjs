// render_speck_fix_compare.mjs —— 渲染「修复前 vs 修复后」对比图
// 左:原图(黑底白线+杂点) | 中:修复前输出(白底黑线) | 右:修复后输出(白底黑线)
import { processLineSmooth, defaultLineSmoothParams } from '../../src/adjustments/lineSmoothProcessor.ts';
import { processLineSmooth as processOld } from '../../analysis/line_vis/_baseline/lineSmoothProcessor_prefixed.ts';
import fs from 'fs';
import zlib from 'zlib';

const THR = 16;
const W = 300, H = 300;

function makeLine() {
  const alpha = new Float32Array(W * H);
  const cx = (y) => 150 + 70 * Math.sin(y / 70);
  for (let y = 10; y < H - 10; y++) {
    const cy = cx(y);
    const halfW = 9 + 2 * Math.sin(y / 11);
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

function addSpecks(alpha, n) {
  const seeds = [];
  let placed = 0, guard = 0;
  while (placed < n && guard < n * 50) {
    guard++;
    const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
    if (alpha[y * W + x] > THR) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (alpha[yy * W + xx] > THR) near = true;
    }
    if (near) continue;
    const a = 40 + (Math.random() * 215) | 0;
    const r = (Math.random() * 1.3) | 0;
    for (let dy = 0; dy <= r && y + dy < H; dy++)
      for (let dx = 0; dx <= r && x + dx < W; dx++)
        if (alpha[(y + dy) * W + (x + dx)] <= THR) alpha[(y + dy) * W + (x + dx)] = a;
    seeds.push([x, y]);
    placed++;
  }
  return seeds;
}

const base = makeLine();
addSpecks(base, 120);
const alpha = base;

const buf = new ArrayBuffer(W * H * 4);
const u = new Uint8Array(buf);
for (let i = 0; i < W * H; i++) {
  const a = alpha[i] | 0;
  u[i * 4] = a; u[i * 4 + 1] = a; u[i * 4 + 2] = a; u[i * 4 + 3] = a;
}
const sel = new Uint8Array(W * H).fill(1);

const outNewBuf = await processLineSmooth(buf, sel.buffer, { width: W, height: H }, defaultLineSmoothParams);
const outOldBuf = await processOld(buf.slice(0), sel.buffer.slice(0), { width: W, height: H }, defaultLineSmoothParams);
const outNew = new Uint8Array(outNewBuf);
const outOld = new Uint8Array(outOldBuf);

const outANew = new Int16Array(W * H);
const outAOld = new Int16Array(W * H);
for (let i = 0; i < W * H; i++) { outANew[i] = outNew[i * 4 + 3]; outAOld[i] = outOld[i * 4 + 3]; }

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

// 每面板渲染时放大 3 倍便于观察
const SCALE = 3;
const CW = W * SCALE, CH = H * SCALE;
writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/speck_fix_compare.png', CW * 3, CH, (x, y) => {
  const panel = Math.floor(x / CW);
  const lx = Math.floor((x % CW) / SCALE), ly = Math.floor(y / SCALE);
  const i = ly * W + lx;
  if (panel === 0) { const a = alpha[i]; return [a, a, a]; }
  if (panel === 1) { const a = outAOld[i]; return [255 - Math.min(255, a), 255 - Math.min(255, a), 255 - Math.min(255, a)]; }
  const a = outANew[i]; return [255 - Math.min(255, a), 255 - Math.min(255, a), 255 - Math.min(255, a)];
});
console.log('已写出 speck_fix_compare.png (左:原图 | 中:修复前 | 右:修复后)');
