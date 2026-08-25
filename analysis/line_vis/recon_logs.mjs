// 解析桌面"原始.log"/"平滑后.log"里的 alpha采样 段，重建 alpha 网格为 PNG，并诊断孔洞/锯齿。
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

function parseLog(path) {
  const text = readFileSync(path, 'latin1');
  const lines = text.split(/\r?\n/);
  const grid = new Map(); // y -> number[]
  let maxX = 0;
  for (const ln of lines) {
    const m = ln.match(/y=(\d+):\s*(.*)$/);
    if (!m) continue;
    const y = parseInt(m[1], 10);
    const vals = m[2].split(',').map((s) => (s.trim() === '' ? 0 : parseInt(s, 10) || 0));
    grid.set(y, vals);
    if (vals.length > maxX) maxX = vals.length;
  }
  const ys = [...grid.keys()].sort((a, b) => a - b);
  const h = (ys.length ? ys[ys.length - 1] + 1 : 0);
  const w = maxX;
  const arr = new Int16Array(w * h);
  for (const y of ys) {
    const vals = grid.get(y);
    for (let x = 0; x < vals.length; x++) arr[y * w + x] = vals[x];
  }
  return { w, h, arr };
}

// 最小 PNG 编码器（8-bit 灰度，无过滤）
function writeGrayPNG(path, w, h, getByte) {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter none
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = getByte(x, y) & 0xff;
  }
  const idat = zlib.deflateSync(raw);
  const crc = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  writeFileSync(path, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
}

const orig = parseLog('C:/Users/Administrator/Desktop/原始.log');
const sm = parseLog('C:/Users/Administrator/Desktop/平滑后.log');
console.log('原始尺寸', orig.w, 'x', orig.h);
console.log('平滑尺寸', sm.w, 'x', sm.h);

const THR = 16;
const w = Math.max(orig.w, sm.w);
const h = Math.max(orig.h, sm.h);

// 诊断：
let holes = 0;         // 原为线，平滑后成背景（孔洞/缺损）
let newPixels = 0;     // 平滑后新增覆盖（原背景变线）
let linePixOrig = 0, linePixSm = 0;
const holeList = [];
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const aO = x < orig.w ? orig.arr[y * orig.w + x] : 0;
    const aS = x < sm.w ? sm.arr[y * sm.w + x] : 0;
    const oLine = aO > THR, sLine = aS > THR;
    if (oLine) linePixOrig++;
    if (sLine) linePixSm++;
    if (oLine && !sLine) { holes++; if (holeList.length < 60) holeList.push([x, y, aO]); }
    if (!oLine && sLine) newPixels++;
  }
}
console.log('原线像素数', linePixOrig, ' 平滑后线像素数', linePixSm);
console.log('孔洞(原线→背景):', holes);
console.log('新增覆盖(背景→线):', newPixels);
// 输出所有孔洞细节（x,y,原alpha），并列出平滑后在这些点的 alpha
console.log('\n孔洞详情（x,y,原alpha,平滑alpha）:');
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const aO = x < orig.w ? orig.arr[y * orig.w + x] : 0;
    const aS = x < sm.w ? sm.arr[y * sm.w + x] : 0;
    if (aO > THR && aS <= THR) {
      console.log(`  hole at (${x},${y}) orig=${aO} sm=${aS}`);
    }
  }
}
console.log('\n新增像素详情（x,y,原alpha,平滑alpha）前60:');
let n2 = 0;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const aO = x < orig.w ? orig.arr[y * orig.w + x] : 0;
    const aS = x < sm.w ? sm.arr[y * sm.w + x] : 0;
    if (aO <= THR && aS > THR) {
      n2++;
      if (n2 <= 60) console.log(`  new at (${x},${y}) orig=${aO} sm=${aS}`);
    }
  }
}

// 逐行线宽 + 行内断点统计（找出"缺损"/锯齿）
function rowStats(arr, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) {
    let x0 = -1, x1 = -1, cnt = 0, runs = 0, prev = false;
    for (let x = 0; x < w; x++) {
      const a = x < arr.w ? arr.arr[y * arr.w + x] : 0;
      const on = a > THR;
      if (on) { cnt++; if (x0 < 0) x0 = x; x1 = x; if (!prev) runs++; }
      prev = on;
    }
    out.push({ y, x0, x1, cnt, runs, width: x1 >= x0 ? x1 - x0 + 1 : 0 });
  }
  return out;
}
const so = rowStats(orig, w, h);
const ss = rowStats(sm, w, h);

// 找出平滑后行内出现多个 run（断点=缺损）的行
let brokenRows = 0;
for (let y = 0; y < h; y++) {
  if (ss[y].cnt > 0 && ss[y].runs > 2) brokenRows++;
}
console.log('平滑后行内断点>2 的行数（缺损/锯齿候选）:', brokenRows, '/', h);

// 找孔洞密集区（按 y 分桶）
const holeByY = {};
for (const [x, y] of holeList) holeByY[y] = (holeByY[y] || 0) + 1;
const topHoleY = Object.entries(holeByY).sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('孔洞最多的 y（前15）:', JSON.stringify(topHoleY));

// 写图：左原 右平滑，灰度=alpha
writeGrayPNG('F:/Coding/JWautofill/analysis/line_vis/recon_orig.png', w, h, (x, y) => (x < orig.w ? orig.arr[y * orig.w + x] : 0));
writeGrayPNG('F:/Coding/JWautofill/analysis/line_vis/recon_sm.png', w, h, (x, y) => (x < sm.w ? sm.arr[y * sm.w + x] : 0));

// 对比图（彩色）：原线=青，平滑新增=红，平滑丢失(孔洞)=蓝
writeGrayPNG('F:/Coding/JWautofill/analysis/line_vis/recon_diff.png', w, h, (x, y) => 0); // placeholder, replaced below by rgb
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
// 4x 放大 diff（最近邻），方便看清孔洞/锯齿
function upscaleGray(srcW, srcH, factor, getGray) {
  const dw = srcW * factor, dh = srcH * factor;
  writeGrayPNG('F:/Coding/JWautofill/analysis/line_vis/recon_diff_4x.png', dw, dh, (x, y) => getGray(x / factor | 0, y / factor | 0));
}
upscaleGray(w, h, 4, (x, y) => {
  const aO = x < orig.w ? orig.arr[y * orig.w + x] : 0;
  const aS = x < sm.w ? sm.arr[y * sm.w + x] : 0;
  const oLine = aO > THR, sLine = aS > THR;
  if (oLine && !sLine) return 220; // 孔洞=亮
  if (!oLine && sLine) return 120; // 新增=中
  if (oLine && sLine) return 60;   // 两者=暗青
  return 0;
});

writeRGBPNG('F:/Coding/JWautofill/analysis/line_vis/recon_diff.png', w, h, (x, y) => {
  const aO = x < orig.w ? orig.arr[y * orig.w + x] : 0;
  const aS = x < sm.w ? sm.arr[y * sm.w + x] : 0;
  const oLine = aO > THR, sLine = aS > THR;
  if (oLine && !sLine) return [40, 80, 255];   // 蓝 = 孔洞/缺损（原有线丢失）
  if (!oLine && sLine) return [230, 30, 30];   // 红 = 平滑新增覆盖
  if (oLine && sLine) return [0, 200, 200];    // 青 = 两者都有（保留线）
  return [10, 10, 10];                          // 黑 = 背景
});
console.log('已写出 recon_orig.png / recon_sm.png / recon_diff.png');
