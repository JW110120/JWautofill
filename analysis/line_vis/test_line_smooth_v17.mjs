// test_line_smooth_v17.mjs —— 拟合重建算法端到端验证
// 合成一张「脏线稿」：主斜线(多遍描线+粗细抖动+毛刺) + 彩色 RGB。
// 跑 processLineSmooth，量化：背景保持 / 线宽 / 线内MAE / 核心P50,P85 /
// 反复描线波动收敛(goal4) / 相邻行突变降低(goal3) / 整体深浅偏移(goal2) /
// 新像素就近洪泛取色是否正确。
//
// 运行：node --experimental-strip-types analysis/line_vis/test_line_smooth_v17.mjs
import { processLineSmooth } from '../../src/adjustments/lineSmoothProcessor.ts';

const W = 150;
const H = 130;
const LINE_RGB = [190, 60, 40];

// ---- 构造脏线稿 ----
const aOrig = new Float32Array(W * H);
const rgbOrig = new Uint8Array(W * H * 4);
const sel = new Uint8Array(W * H).fill(1);

function stamp(cx, halfW, baseA, jitter) {
  for (let y = 0; y < H; y++) {
    const ww = halfW + (jitter ? ((y % 2 === 0) ? 1 : -1) : 0); // 粗细抖动/毛刺
    const cxx = Math.round(cx(y));
    for (let x = cxx - ww; x <= cxx + ww; x++) {
      if (x < 0 || x >= W) continue;
      const i = y * W + x;
      const a = baseA + ((Math.random() * 30) | 0) - 15; // 轻微 alpha 噪声
      if (a > aOrig[i]) {
        aOrig[i] = a;
        rgbOrig[i * 4] = LINE_RGB[0];
        rgbOrig[i * 4 + 1] = LINE_RGB[1];
        rgbOrig[i * 4 + 2] = LINE_RGB[2];
        rgbOrig[i * 4 + 3] = Math.round(aOrig[i]);
      }
    }
  }
}

// 主线条（第一遍，实）
stamp((y) => 18 + y * 0.85, 3, 215, true);
// 反复描线：偏移 +2px 的第二条（更淡），制造「多次描线深浅不一」
stamp((y) => 20 + y * 0.85, 2, 95, false);
// 再补一笔偏移 -1px，制造交叉重叠区
stamp((y) => 17 + y * 0.85, 2, 120, false);

// 背景像素 RGB=0（straight alpha 透明）
// 组装 RGBA buffer
const buf = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  buf[i * 4] = rgbOrig[i * 4];
  buf[i * 4 + 1] = rgbOrig[i * 4 + 1];
  buf[i * 4 + 2] = rgbOrig[i * 4 + 2];
  buf[i * 4 + 3] = Math.round(aOrig[i]);
}

const outBuf = await processLineSmooth(buf.buffer, sel.buffer, { width: W, height: H }, { strength: 1, radius: 8 });
const out = new Uint8Array(outBuf);

// ---- 指标 ----
const line = new Uint8Array(W * H);
let nLine = 0;
for (let i = 0; i < W * H; i++) { if (aOrig[i] > 16) { line[i] = 1; nLine++; } }

let bgOk = 0, bgN = 0;
for (let i = 0; i < W * H; i++) { if (aOrig[i] === 0) { bgN++; if (out[i * 4 + 3] === 0) bgOk++; } }
const bgKeep = bgN ? (bgOk / bgN) * 100 : 100;

let nRes = 0;
for (let i = 0; i < W * H; i++) { if (out[i * 4 + 3] > 16) nRes++; }
const widthPct = (100 * (nRes - nLine)) / Math.max(1, nLine);

let mae = 0, cnt = 0, meanShift = 0;
for (let i = 0; i < W * H; i++) {
  if (line[i]) {
    const d = out[i * 4 + 3] - aOrig[i];
    mae += Math.abs(d); meanShift += d; cnt++;
  }
}
mae = cnt ? mae / cnt : 0;
meanShift = cnt ? meanShift / cnt : 0;

// 核心像素
const core = [];
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (line[i] && line[i - 1] && line[i + 1] && line[i - W] && line[i + W]) core.push(i);
  }
}
const P = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };
const c50 = P(core.map(i => out[i * 4 + 3]), 0.5);
const c85 = P(core.map(i => out[i * 4 + 3]), 0.85);

// 反复描线波动收敛（goal4）：核心 std
const m0 = core.reduce((s, i) => s + aOrig[i], 0) / Math.max(1, core.length);
const m1 = core.reduce((s, i) => s + out[i * 4 + 3], 0) / Math.max(1, core.length);
const std0 = Math.sqrt(core.reduce((s, i) => s + (aOrig[i] - m0) ** 2, 0) / Math.max(1, core.length));
const std1 = Math.sqrt(core.reduce((s, i) => s + (out[i * 4 + 3] - m1) ** 2, 0) / Math.max(1, core.length));
const stdConv = 100 * (1 - std1 / Math.max(1e-6, std0));

// 相邻行突变降低（goal3）
let d0 = 0, d1 = 0, dn = 0;
for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) {
  d0 += Math.abs(aOrig[y * W + x] - aOrig[(y - 1) * W + x]);
  d1 += Math.abs(out[(y * W + x) * 4 + 3] - out[((y - 1) * W + x) * 4 + 3]);
  dn++;
}
const rowJump = 100 * (1 - d1 / Math.max(1e-6, d0));

// 新像素 + 就近洪泛取色（goal: 新增覆盖像素应拿到附近线色）
let newPx = 0, floodOk = 0, floodChecked = 0;
for (let i = 0; i < W * H; i++) {
  const aRes = out[i * 4 + 3];
  if (aRes > 16 && aOrig[i] <= 16) {
    newPx++;
    const r = out[i * 4], g = out[i * 4 + 1], b = out[i * 4 + 2];
    if (r === LINE_RGB[0] && g === LINE_RGB[1] && b === LINE_RGB[2]) floodOk++;
    floodChecked++;
  }
}

console.log('===== 拟合重建算法 v17 验证 =====');
console.log(`尺寸: ${W}x${H}`);
console.log(`背景保持      : ${bgKeep.toFixed(2)}%  (目标 100%)`);
console.log(`线宽变化      : ${widthPct >= 0 ? '+' : ''}${widthPct.toFixed(1)}%  (目标接近 0)`);
console.log(`线内 MAE      : ${mae.toFixed(1)}  (偏离越小越好)`);
console.log(`整体深浅偏移  : ${meanShift >= 0 ? '+' : ''}${meanShift.toFixed(1)}  (goal2: 不偏离太多)`);
console.log(`核心 P50/P85  : ${c50.toFixed(0)}/${c85.toFixed(0)}  (主体水平保持)`);
console.log(`核心波动收敛  : -${stdConv.toFixed(0)}%  (goal4: 反复描线合成一根)`);
console.log(`相邻行突变降低: -${rowJump.toFixed(0)}%  (goal3: 毛刺削弱)`);
console.log(`新覆盖像素    : ${newPx}  就近洪泛取色成功: ${floodOk}/${floodChecked} (${floodChecked ? (100 * floodOk / floodChecked).toFixed(1) : '0'}%)`);
