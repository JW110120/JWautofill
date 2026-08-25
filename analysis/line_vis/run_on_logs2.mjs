// run_on_logs2.mjs —— 用真实铅笔曲线日志验证新的「有符号距离场」平滑
import { processLineSmooth, defaultLineSmoothParams } from '../../src/adjustments/lineSmoothProcessor.ts';
import fs from 'fs';
import zlib from 'zlib';

const THR = 16;

function parseLog(path) {
  const txt = fs.readFileSync(path, 'latin1');
  const rows = new Map();
  let W = 0, H = 0;
  const re = /y=(\d+):\s*([-\d.,\s]+)/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const y = parseInt(m[1], 10);
    const vals = m[2].trim().split(',').map(s => parseInt(s.trim(), 10) || 0);
    rows.set(y, vals);
    W = Math.max(W, vals.length);
    H = Math.max(H, y + 1);
  }
  const arr = new Int16Array(W * H);
  for (const [y, vals] of rows) {
    for (let x = 0; x < vals.length; x++) arr[y * W + x] = vals[x];
  }
  return { arr, W, H };
}

function metrics(arr, W, H, tag) {
  let line = 0, sumW = 0, nRows = 0;
  let p90 = 0;
  const vals = [];
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) { if (arr[y * W + x] > THR) { c++; vals.push(arr[y * W + x]); } }
    if (c > 0) { sumW += c; nRows++; line += c; }
  }
  vals.sort((a, b) => a - b);
  p90 = vals.length ? vals[Math.floor(vals.length * 0.9)] : 0;
  return { tag, linePixels: line, avgWidth: nRows ? (sumW / nRows).toFixed(2) : 0, p90 };
}

function writeRGBPNG(path, w, h, getRGB) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = getRGB(x, y);
    const o = (y * w + x) * 3;
    px[o] = r; px[o + 1] = g; px[o + 2] = b;
  }
  // PNG encode (truecolor, no compression-ish via zlib stored)
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const idat = zlib.deflateSync(raw);
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    const cd = Buffer.concat([t, data]);
    crc.writeUInt32BE(crc32(cd) >>> 0, 0);
    return Buffer.concat([len, cd, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(path, Buffer.concat([
    sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]));
}
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return c ^ 0xFFFFFFFF;
}

const orig = parseLog('C:/Users/Administrator/Desktop/原始.log');
const userSm = parseLog('C:/Users/Administrator/Desktop/新版平滑.log');
const W = orig.W, H = orig.H;
console.log('尺寸', W, 'x', H);

// 构造 RGBA（alpha=原稿，RGB 用灰度便于洪泛取色一致）
function toRGBA(arr) {
  const buf = new ArrayBuffer(W * H * 4);
  const u = new Uint8Array(buf);
  for (let i = 0; i < W * H; i++) {
    const a = arr[i];
    u[i * 4] = a; u[i * 4 + 1] = a; u[i * 4 + 2] = a; u[i * 4 + 3] = a;
  }
  return buf;
}
const sel = new Uint8Array(W * H).fill(1);

const outBuf = await processLineSmooth(toRGBA(orig.arr), sel.buffer, { width: W, height: H }, defaultLineSmoothParams);
const fixed = new Uint8Array(outBuf);
const fixedA = new Int16Array(W * H);
for (let i = 0; i < W * H; i++) fixedA[i] = fixed[i * 4 + 3];

// ---- 指标 ----
const mo = metrics(orig.arr, W, H, '原始');
const mu = metrics(userSm.arr, W, H, '新版平滑(用户测)');
const mf = metrics(fixedA, W, H, '新算法');
console.log(mo, mu, mf);

let holesVsUser = 0, addVsUser = 0;       // 新版平滑 → 新算法
let holesOrig = 0, addOrig = 0;           // 原始 → 新算法
for (let i = 0; i < W * H; i++) {
  const o = orig.arr[i] > THR, u = userSm.arr[i] > THR, f = fixedA[i] > THR;
  if (o && !f) holesOrig++;
  if (!o && f) addOrig++;
  if (u && !f) holesVsUser++;
  if (!u && f) addVsUser++;
}
console.log('原始→新算法: 孔洞(丢失)', holesOrig, ' 新增覆盖', addOrig);
console.log('新版平滑→新算法: 丢失', holesVsUser, ' 新增', addVsUser);

// 抗锯齿指标：边界像素中 alpha 处于 (THR, P90*0.8) 软过渡的比例
function aaRatio(arr) {
  let edge = 0, soft = 0;
  const P = metrics(arr, W, H, '').p90 * 0.8;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; const a = arr[i];
    if (a <= THR) continue;
    let isEdge = false;
    if (x > 0 && arr[i - 1] <= THR) isEdge = true;
    else if (x + 1 < W && arr[i + 1] <= THR) isEdge = true;
    else if (y > 0 && arr[i - W] <= THR) isEdge = true;
    else if (y + 1 < H && arr[i + W] <= THR) isEdge = true;
    if (isEdge) { edge++; if (a < P) soft++; }
  }
  return edge ? (soft / edge * 100).toFixed(1) + '%' : 'n/a';
}
console.log('抗锯齿(软边像素占比): 原始', aaRatio(orig.arr), ' | 新版平滑', aaRatio(userSm.arr), ' | 新算法', aaRatio(fixedA));

// ---- 三列对比图：原图 | 新版平滑 | 新算法 ----
writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/v2_panels.png', W * 3, H, (x, y) => {
  const panel = Math.floor(x / W);
  const lx = x - panel * W;
  const i = y * W + lx;
  if (panel === 0) { const v = orig.arr[i]; return [v, v, v]; }
  if (panel === 1) { const v = userSm.arr[i]; return [v, v, v]; }
  const v = fixedA[i]; return [v, v, v];
});

// ---- 4x 放大（最近邻）全图，肉眼看平顶/尖角/锯齿 ----
const S = 4;
writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/v2_all_4x.png', W * S, H * S, (x, y) => {
  const sx = (x / S) | 0, sy = (y / S) | 0;
  const i = sy * W + sx;
  const sxp = Math.min(W - 1, ((x + 1) / S) | 0), syp = Math.min(H - 1, ((y + 1) / S) | 0);
  const ip = syp * W + sxp;
  const a = orig.arr[i], u = userSm.arr[i], f = fixedA[i];
  // 上=原 下=新：这里只画一栏对比，用左右：左原右新
  if (x < W * S / 2) { const v = a; return [v, v, v]; }
  const v = f; return [v, v, v];
});

// ---- 差异图：原线(青) vs 新算法(品红)，孔洞(蓝) 新增(红) ----
writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/v2_diff.png', W, H, (x, y) => {
  const i = y * W + x;
  const o = orig.arr[i] > THR, f = fixedA[i] > THR;
  if (o && f) return [120, 200, 255];          // 重叠
  if (o && !f) return [40, 60, 220];           // 孔洞(丢失)
  if (!o && f) return [220, 40, 60];           // 新增覆盖
  return [8, 8, 8];
});

// ---- 白底黑线便于观察细节（三列：原图 | 用户新版平滑 | 新算法） ----
function tone(a) { const v = 255 - Math.min(255, Math.round(a)); return [v, v, v]; }
writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/v2_panels_white.png', W * 3, H, (x, y) => {
  const panel = Math.floor(x / W);
  const lx = x - panel * W;
  const i = y * W + lx;
  if (panel === 0) return tone(orig.arr[i]);
  if (panel === 1) return tone(userSm.arr[i]);
  return tone(fixedA[i]);
});

// ---- 用户新版平滑 vs 新算法 差异：红=新算法新增，蓝=新算法丢失 ----
writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/v2_fixed_vs_user.png', W, H, (x, y) => {
  const i = y * W + x;
  const u = userSm.arr[i] > THR, f = fixedA[i] > THR;
  if (u && f) return [200, 200, 200];          // 重叠
  if (u && !f) return [60, 80, 240];           // 新版平滑有、新算法丢了
  if (!u && f) return [240, 60, 60];           // 新算法新增
  return [20, 20, 20];
});

// ---- 局部 4x 放大：顶部抛物线区域 y=30..140 ----
const TOP_Y0 = 30, TOP_Y1 = 140;
function crop4x(path, getter, y0, y1) {
  const ch = y1 - y0 + 1;
  writeRGBPNG(path, W * S, ch * S, (x, y) => {
    const sx = (x / S) | 0, sy = y0 + ((y / S) | 0);
    if (sx >= W || sy >= H) return [255, 255, 255];
    return getter(sx, sy);
  });
}
crop4x('F:/Coding/JWautofill/analysis/line_vis/v2_top_orig.png', (x, y) => tone(orig.arr[y * W + x]), TOP_Y0, TOP_Y1);
crop4x('F:/Coding/JWautofill/analysis/line_vis/v2_top_user.png', (x, y) => tone(userSm.arr[y * W + x]), TOP_Y0, TOP_Y1);
crop4x('F:/Coding/JWautofill/analysis/line_vis/v2_top_fixed.png', (x, y) => tone(fixedA[y * W + x]), TOP_Y0, TOP_Y1);

// ---- 局部 4x 放大：中部圆弧 y=160..260 ----
const ARC_Y0 = 160, ARC_Y1 = 260;
crop4x('F:/Coding/JWautofill/analysis/line_vis/v2_arc_orig.png', (x, y) => tone(orig.arr[y * W + x]), ARC_Y0, ARC_Y1);
crop4x('F:/Coding/JWautofill/analysis/line_vis/v2_arc_user.png', (x, y) => tone(userSm.arr[y * W + x]), ARC_Y0, ARC_Y1);
crop4x('F:/Coding/JWautofill/analysis/line_vis/v2_arc_fixed.png', (x, y) => tone(fixedA[y * W + x]), ARC_Y0, ARC_Y1);

// ---- 局部 4x 放大：最顶端 apex y=0..60 ----
const APEX_Y0 = 0, APEX_Y1 = 60;
crop4x('F:/Coding/JWautofill/analysis/line_vis/v2_apex_orig.png', (x, y) => tone(orig.arr[y * W + x]), APEX_Y0, APEX_Y1);
crop4x('F:/Coding/JWautofill/analysis/line_vis/v2_apex_user.png', (x, y) => tone(userSm.arr[y * W + x]), APEX_Y0, APEX_Y1);
crop4x('F:/Coding/JWautofill/analysis/line_vis/v2_apex_fixed.png', (x, y) => tone(fixedA[y * W + x]), APEX_Y0, APEX_Y1);

console.log('\n已写出 v2_panels.png / v2_all_4x.png / v2_diff.png / v2_panels_white.png / v2_fixed_vs_user.png / v2_top_* / v2_arc_* / v2_apex_*');

// ---- 杂点指标：输出中「原为背景、且与任何原线像素不连通」的游离像素 ----
// 这些就是平滑后游离在线外的杂点。要求 ≈ 0。
let detachedSpecks = 0;       // 与原线 8 邻域都不相连的游离新像素
let farSpecks = 0;            // 距最近原线像素 ≥ 2px 的游离新像素（明确杂点）
const hasOrigNeighbor = (i, x, y) => {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    if (orig.arr[yy * W + xx] > THR) return true;
  }
  return false;
};
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x;
  if (fixedA[i] > THR && orig.arr[i] <= THR) {
    if (!hasOrigNeighbor(i, x, y)) {
      detachedSpecks++;
      // 距最近原线像素 ≥ 2px ?
      let near = false;
      for (let r = 1; r <= 2 && !near; r++)
        for (let dy = -r; dy <= r && !near; dy++) for (let dx = -r; dx <= r && !near; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if (orig.arr[yy * W + xx] > THR) near = true;
        }
      if (!near) farSpecks++;
    }
  }
}
console.log('游离杂点(与原线不相连):', detachedSpecks, '  | 明确杂点(距原线≥2px):', farSpecks);
