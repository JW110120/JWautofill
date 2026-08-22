import { readFileSync } from 'fs';
import { processBlockColorPatch } from '../src/adjustments/blockColorPatchProcessor.ts';

const CW = 145, CH = 140, N = CW * CH;
const loadRows = (p) => {
  const d = JSON.parse(readFileSync(p, 'utf-8'));
  const rows = {};
  for (const [k, v] of Object.entries(d.rows)) rows[Number(k)] = v;
  return rows;
};
const place = (p, ox, oy) => {
  const rows = loadRows(p);
  const c = new Uint8Array(N);
  for (const [y, r] of Object.entries(rows)) {
    const yy = Number(y);
    for (let x = 0; x < r.length; x++) c[(yy + oy) * CW + (x + ox)] = r[x];
  }
  return c;
};
const line = place('analysis/line.json', 10, 9);
const fill = place('analysis/fill_with_holes.json', 13, 11);
const good = place('analysis/fill_filled.json', 11, 9);

// 红色填充 RGBA（透明区白色）
const rgba = new Uint8Array(N * 4);
for (let i = 0; i < N; i++) {
  rgba[i * 4 + 3] = fill[i];
  rgba[i * 4] = fill[i] > 0 ? 230 : 255;
  rgba[i * 4 + 1] = fill[i] > 0 ? 14 : 255;
  rgba[i * 4 + 2] = fill[i] > 0 ? 14 : 255;
}
const sel = new Uint8Array(N).fill(1);

const ev = (out, name) => {
  let gacc = 0, gcnt = 0, bacc = 0, bcnt = 0, tacc = 0, tcnt = 0, rgbGood = 0, rgbBad = 0, over = 0;
  for (let i = 0; i < N; i++) {
    const p = out[i * 4 + 3], t = good[i], a = fill[i];
    if (t === 255) { gcnt++; if (p === 255) gacc++; }
    if (t === 0) { bcnt++; if (p === 0) bacc++; }
    if (t === 255 && a < 121) { tcnt++; if (p === 255) tacc++; }
    if (p === 255 && t === 0) over++;
    if (p === 255 && a < 255 && t === 255) {
      const R = out[i * 4], G = out[i * 4 + 1], B = out[i * 4 + 2];
      if (Math.abs(R - 230) <= 3 && Math.abs(G - 14) <= 3 && Math.abs(B - 14) <= 3) rgbGood++;
      else rgbBad++;
    }
  }
  console.log(name + ': 补全区=' + (gacc / gcnt * 100).toFixed(2) + '% 背景=' + (bacc / bcnt * 100).toFixed(2) +
    '% 尖角=' + (tacc / tcnt * 100).toFixed(2) + '% 误填=' + over + ' RGB正确=' + (rgbGood / (rgbGood + rgbBad) * 100).toFixed(1) + '%');
};

// ===== 1. 分层 v7 =====
const outLayer = await processBlockColorPatch(rgba.buffer, sel.buffer, { width: CW, height: CH }, { lineMask: line.buffer });
ev(outLayer, '分层v7(线稿引导)');

// ===== 2. 同层深线：黑色线稿 + 红色填充合成（线稿像素覆盖在填充上） =====
// 合成：line>16 的位置 = 黑色线稿（覆盖填充色），其余 = 红色填充
const rgbaSame = new Uint8Array(rgba);
for (let i = 0; i < N; i++) {
  if (line[i] > 16) {
    rgbaSame[i * 4] = 20; rgbaSame[i * 4 + 1] = 20; rgbaSame[i * 4 + 2] = 20; // 黑色线稿
    if (rgbaSame[i * 4 + 3] < 255) rgbaSame[i * 4 + 3] = line[i]; // 线稿 alpha
  }
}
// 凹尖角测试：在线稿帽子左侧加一个凹陷（fill=0 但被线稿半包围）
const outDark = await processBlockColorPatch(rgbaSame.buffer, sel.buffer, { width: CW, height: CH }, { lineColorMode: 'darker' });
ev(outDark, '同层深线(darker)');

// 检查同层深线：被补的像素 RGB 应为红色（非黑色）
let sameRed = 0, sameBlack = 0;
for (let i = 0; i < N; i++) {
  const p = outDark[i * 4 + 3], a = rgbaSame[i * 4 + 3];
  if (p === 255 && a < 255) {
    const R = outDark[i * 4], G = outDark[i * 4 + 1], B = outDark[i * 4 + 2];
    if (Math.abs(R - 230) <= 30 && G < 100 && B < 100) sameRed++;
    else if (R < 80 && G < 80 && B < 80) sameBlack++;
  }
}
console.log('同层深线 补色像素: 红色=' + sameRed + ' 黑色=' + sameBlack);
