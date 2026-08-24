import { processBlockColorPatch } from '../../src/adjustments/blockColorPatchProcessor.ts';

// 自建合成：封闭黑色方形线稿（厚度 3，含一个向外凹陷的凹尖角口袋），内部红色填充
// 与线稿之间留透明缝隙，并在内部留一个孔洞。另加一段纯背景中的孤立黑线。
// 验证：
//  ① 内部缝隙/孔洞被红色补全（从内向外侵蚀）
//  ② 最内侧 1px 线稿（邻接内部）被填充色覆盖以封缝
//  ③ 外层线稿 / 纯背景孤立线 保持黑色（不再现整圈红描边）
//  ④ 线稿外侧的凹尖角口袋（被线稿与背景包围）不被填充
const W = 100, H = 100, N = W * H;
const rgba = new Uint8Array(N * 4).fill(0); // 全透明背景
const sel = new Uint8Array(N).fill(1);

const setPx = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
};
const drawVRect = (x0, y0, x1, y1, t) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const onX = x >= x0 && x <= x1 && (y >= y0 && y <= y0 + t - 1 || y <= y1 && y >= y1 - t + 1);
    const onY = y >= y0 && y <= y1 && (x >= x0 && x <= x0 + t - 1 || x <= x1 && x >= x1 - t + 1);
    if (onX || onY) setPx(x, y, 10, 10, 10, 255);
  }
};
// 主方形线稿 30..70（厚度 3）
drawVRect(30, 30, 70, 70, 3);
// 顶部中央向外凸的口袋（凹尖角）：与主线稿顶边连通 → 形成位于线稿外侧的口袋
drawVRect(45, 18, 55, 30, 3);
// 纯背景中的孤立黑线（不应被染红）
for (let x = 5; x <= 15; x++) { setPx(x, 85, 10, 10, 10, 255); setPx(x, 86, 10, 10, 10, 255); }

// 内部红色填充（留下与线稿之间的透明缝隙 + 一个内部孔洞）
for (let y = 38; y <= 62; y++) for (let x = 38; x <= 62; x++) {
  if (x >= 48 && x <= 53 && y >= 48 && y <= 53) continue; // 内部孔洞
  setPx(x, y, 230, 14, 14, 255);
}

const isLine = (x, y) => { const i = y * W + x; return rgba[i * 4 + 3] > 16 && rgba[i] < 80 && rgba[i + 1] < 80 && rgba[i + 2] < 80; };
const isRed = (i) => out[i * 4 + 3] === 255 && Math.abs(out[i * 4] - 230) <= 6 && out[i * 4 + 1] < 40 && out[i * 4 + 2] < 40;
const isBlack = (i) => out[i * 4] === 10 && out[i * 4 + 1] === 10 && out[i * 4 + 2] === 10 && out[i * 4 + 3] === 255;

const pocket = [];   // 凹尖角口袋内部（应全保持透明）
for (let y = 19; y <= 29; y++) for (let x = 46; x <= 54; x++) if (!isLine(x, y)) pocket.push(y * W + x);
const interiorGapOrHole = []; // 内部透明区（应被补全为红）
for (let y = 31; y <= 69; y++) for (let x = 31; x <= 69; x++) {
  const i = y * W + x;
  if (!isLine(x, y) && rgba[i * 4 + 3] === 0 && !(x >= 46 && x <= 54 && y <= 29)) interiorGapOrHole.push(i);
}

const out = await processBlockColorPatch(rgba.buffer, sel.buffer, { width: W, height: H }, { lineColorMode: 'darker' });

// ④ 凹尖角口袋保持透明（关键回归）
let pocketFilled = 0;
for (const i of pocket) if (out[i * 4 + 3] > 0) pocketFilled++;

// ① 内部透明区补全为红
let interiorFilled = 0, interiorRed = 0;
for (const i of interiorGapOrHole) {
  if (out[i * 4 + 3] === 255) interiorFilled++;
  if (isRed(i)) interiorRed++;
}

// ② + ③ 线稿分层统计：直接在输出结果上分类——变红的最内侧线稿（封缝）vs 保持黑色的线稿（不外染）
let lineTotal = 0, lineRed = 0, lineBlack = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!isLine(x, y)) continue;
  const i = y * W + x;
  lineTotal++;
  if (isRed(i)) lineRed++;
  else if (isBlack(i)) lineBlack++;
}
// 孤立黑线（x 5..15, y85/86）应全黑
let isolatedBlack = 0;
for (let y = 85; y <= 86; y++) for (let x = 5; x <= 15; x++) {
  const i = y * W + x;
  if (isBlack(i)) isolatedBlack++;
}

console.log('凹尖角口袋=' + pocket.length + ' 被填充=' + pocketFilled + (pocketFilled === 0 ? '  PASS' : '  FAIL(凹尖角不应填)'));
console.log('内部透明区=' + interiorGapOrHole.length + ' 补全=' + interiorFilled + ' 且为红=' + interiorRed +
  (interiorGapOrHole.length > 0 && interiorFilled === interiorGapOrHole.length && interiorRed === interiorFilled ? '  PASS' : '  FAIL'));
console.log('线稿总=' + lineTotal + ' 最内侧被填(红)=' + lineRed + (lineRed > 0 ? '  PASS(封缝生效)' : '  FAIL'));
console.log('线稿保持黑=' + lineBlack + (lineBlack > 0 ? '  PASS(不外染/无整圈红描边)' : '  FAIL'));
console.log('纯背景孤立线保持黑=' + isolatedBlack + '/22 ' + (isolatedBlack === 22 ? 'PASS' : 'FAIL'));
