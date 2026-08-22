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

const rgba = new Uint8Array(N * 4);
for (let i = 0; i < N; i++) rgba[i * 4 + 3] = fill[i];
const sel = new Uint8Array(N).fill(1);

const ev = (out, name) => {
  let acc = 0, vacc = 0, vcnt = 0, gacc = 0, gcnt = 0, bacc = 0, bcnt = 0, tacc = 0, tcnt = 0, mae = 0;
  for (let i = 0; i < N; i++) {
    const p = out[i * 4 + 3], t = good[i], a = fill[i];
    mae += Math.abs(p - t);
    if (p === t) acc++;
    if (t > 0 || a > 0) { vcnt++; if (p === t) vacc++; }
    if (t === 255) { gcnt++; if (p === 255) gacc++; }
    if (t === 0) { bcnt++; if (p === 0) bacc++; }
    if (t === 255 && a < 121) { tcnt++; if (p === 255) tacc++; }
  }
  console.log(name + ': 全图精确=' + (acc / N * 100).toFixed(2) + '% 有值=' + (vacc / vcnt * 100).toFixed(2) +
    '% 补全区=' + (gacc / gcnt * 100).toFixed(2) + '% 背景=' + (bacc / bcnt * 100).toFixed(2) +
    '% 尖角=' + (tcnt ? (tacc / tcnt * 100).toFixed(2) : 'n/a') + '% MAE=' + (mae / N).toFixed(3));
};

const outSame = await processBlockColorPatch(rgba.buffer, sel.buffer, { width: CW, height: CH });
ev(outSame, '分层场景(无lineMask=同层退化)');

const outLayer = await processBlockColorPatch(rgba.buffer, sel.buffer, { width: CW, height: CH }, { lineMask: line.buffer });
ev(outLayer, '分层场景(线稿引导)');

// 同层样本（蛇形线）
const d1 = JSON.parse(readFileSync('analysis/with_holes.json', 'utf-8')).rows;
const d2 = JSON.parse(readFileSync('analysis/filled.json', 'utf-8')).rows;
const rgba2 = new Uint8Array(128 * 125 * 4);
const good2 = new Uint8Array(128 * 125);
for (const [y, r] of Object.entries(d1)) {
  for (let x = 0; x < r.length; x++) rgba2[(Number(y) * 128 + x) * 4 + 3] = r[x];
}
for (const [y, r] of Object.entries(d2)) {
  for (let x = 0; x < r.length; x++) good2[Number(y) * 128 + x] = r[x];
}
const sel2 = new Uint8Array(128 * 125).fill(1);
const outSnake = await processBlockColorPatch(rgba2.buffer, sel2.buffer, { width: 128, height: 125 });
let acc2 = 0, gacc2 = 0, gcnt2 = 0, bacc2 = 0, bcnt2 = 0, tacc2 = 0, tcnt2 = 0, mae2 = 0;
for (let i = 0; i < 128 * 125; i++) {
  const p = outSnake[i * 4 + 3], t = good2[i], a = rgba2[i * 4 + 3];
  mae2 += Math.abs(p - t);
  if (p === t) acc2++;
  if (t === 255) { gcnt2++; if (p === 255) gacc2++; }
  if (t === 0) { bcnt2++; if (p === 0) bacc2++; }
  if (t === 255 && a < 121) { tcnt2++; if (p === 255) tacc2++; }
}
console.log('同层样本(蛇形线): 全图精确=' + (acc2 / 16000 * 100).toFixed(2) + '% 补全区=' + (gacc2 / gcnt2 * 100).toFixed(2) +
  '% 背景=' + (bacc2 / bcnt2 * 100).toFixed(2) + '% 尖角=' + (tcnt2 ? (tacc2 / tcnt2 * 100).toFixed(2) : 'n/a') + '% MAE=' + (mae2 / 16000).toFixed(3));
