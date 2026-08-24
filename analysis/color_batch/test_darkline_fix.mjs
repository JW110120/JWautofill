import { readFileSync } from 'fs';
import { processBlockColorPatch } from '../../src/adjustments/blockColorPatchProcessor.ts';

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
const line = place('analysis/color_batch/line.json', 10, 9);
const fill = place('analysis/color_batch/fill_with_holes.json', 13, 11);
const good = place('analysis/color_batch/fill_filled.json', 11, 9);

// 红色填充 RGBA
const rgba = new Uint8Array(N * 4);
for (let i = 0; i < N; i++) {
  rgba[i * 4 + 3] = fill[i];
  rgba[i * 4] = fill[i] > 0 ? 230 : 255;
  rgba[i * 4 + 1] = fill[i] > 0 ? 14 : 255;
  rgba[i * 4 + 2] = fill[i] > 0 ? 14 : 255;
}
const sel = new Uint8Array(N).fill(1);

// 同层深线：黑色线稿覆盖在红色填充上（模拟真实同一图层）
const rgbaSame = new Uint8Array(rgba);
for (let i = 0; i < N; i++) {
  if (line[i] > 16) {
    rgbaSame[i * 4] = 20; rgbaSame[i * 4 + 1] = 20; rgbaSame[i * 4 + 2] = 20; // 黑色线稿
    if (rgbaSame[i * 4 + 3] < 255) rgbaSame[i * 4 + 3] = line[i]; // 线稿 alpha（含半透明边缘）
  }
}

const outDark = await processBlockColorPatch(rgbaSame.buffer, sel.buffer, { width: CW, height: CH }, { lineColorMode: 'darker' });

// ===== 1) 指标回归 =====
let gacc = 0, gcnt = 0, bacc = 0, bcnt = 0, tacc = 0, tcnt = 0, rgbGood = 0, rgbBad = 0, over = 0;
for (let i = 0; i < N; i++) {
  const p = outDark[i * 4 + 3], t = good[i], a = fill[i];
  if (t === 255) { gcnt++; if (p === 255) gacc++; }
  if (t === 0) { bcnt++; if (p === 0) bacc++; }
  if (t === 255 && a < 121) { tcnt++; if (p === 255) tacc++; }
  if (p === 255 && t === 0) over++;
  if (p === 255 && a < 255 && t === 255) {
    const R = outDark[i * 4], G = outDark[i * 4 + 1], B = outDark[i * 4 + 2];
    if (Math.abs(R - 230) <= 3 && Math.abs(G - 14) <= 3 && Math.abs(B - 14) <= 3) rgbGood++;
    else rgbBad++;
  }
}
console.log('同层深线(darker): 补全区=' + (gacc / gcnt * 100).toFixed(2) + '% 背景=' + (bacc / bcnt * 100).toFixed(2) +
  '% 尖角=' + (tacc / tcnt * 100).toFixed(2) + '% 误填=' + over + ' RGB正确=' + (rgbGood / (rgbGood + rgbBad) * 100).toFixed(1) + '%');

// ===== 1b) 仅统计"非黑线覆盖"的红色填充区（排除合成黑线叠加造成的指标假降）=====
{
  let gg = 0, gc = 0, bg = 0, bc = 0, tg = 0, tc = 0, rg = 0, rb = 0, ov = 0;
  for (let i = 0; i < N; i++) {
    if (line[i] > 16) continue; // 跳过合成黑线叠加位置
    const p = outDark[i * 4 + 3], t = good[i], a = fill[i];
    if (t === 255) { gc++; if (p === 255) gg++; }
    if (t === 0) { bc++; if (p === 0) bg++; }
    if (t === 255 && a < 121) { tc++; if (p === 255) tg++; }
    if (p === 255 && t === 0) ov++;
    if (p === 255 && a < 255 && t === 255) {
      const R = outDark[i * 4], G = outDark[i * 4 + 1], B = outDark[i * 4 + 2];
      if (Math.abs(R - 230) <= 3 && Math.abs(G - 14) <= 3 && Math.abs(B - 14) <= 3) rg++;
      else rb++;
    }
  }
  console.log('[红色填充区,排除黑线] 补全区=' + (gg / gc * 100).toFixed(2) + '% 背景=' + (bg / bc * 100).toFixed(2) +
    '% 尖角=' + (tg / tc * 100).toFixed(2) + '% 误填=' + ov + ' RGB正确=' + (rg / (rg + rb) * 100).toFixed(1) + '%');
}

// ===== 2) 回归守卫：原始 bug（红色溢出到线稿/背景外侧）不得复现 =====
//   v6.2→v6.3 授权：最内侧 1px 黑线可被填充色覆盖以封缝（lineModified 预期 > 0）。
//   真正需要守住的：纯背景像素（原始 alpha=0，既非填充也非线稿）不得被填充到内部区域之外；
//   即"线稿外侧 / 凹尖角"绝不能出现红色。
let lineTotal = 0, lineModified = 0, lineRecoloredRed = 0;
let exteriorFilled = 0; // 纯背景被误填
for (let i = 0; i < N; i++) {
  const a0 = rgbaSame[i * 4 + 3];
  const isLine0 = line[i] > 16;
  const isFill0 = fill[i] > 0;
  if (isLine0) { // 输入中的黑色线稿位置
    lineTotal++;
    const r0 = rgbaSame[i * 4], g0 = rgbaSame[i * 4 + 1], b0 = rgbaSame[i * 4 + 2], a0l = rgbaSame[i * 4 + 3];
    const r1 = outDark[i * 4], g1 = outDark[i * 4 + 1], b1 = outDark[i * 4 + 2], a1 = outDark[i * 4 + 3];
    if (r1 !== r0 || g1 !== g0 || b1 !== b0 || a1 !== a0l) lineModified++;
    if (a1 === 255 && (r1 > 120 || r1 - b1 > 80)) lineRecoloredRed++;
  }
  // 纯背景（地面真值 good=0 且非线稿）却被提升 → 越界染色（真正的凹尖角/外侧泄漏）
  if (!isLine0 && good[i] === 0 && outDark[i * 4 + 3] === 255) exteriorFilled++;
}
console.log('黑线像素总数=' + lineTotal + ' 最内侧被填(封缝)=' + lineModified + ' 其中被染红=' + lineRecoloredRed);
console.log('纯背景被误填(越界)=' + exteriorFilled + (exteriorFilled === 0 ? '  PASS(无溢出/凹尖角不填)' : '  FAIL(红溢出到背景)'));


