// collect_line_metrics.mjs —— 收集 TS 输出完整指标（报告用）
import { readFileSync } from 'fs';

const LOG_LINE = /^(?:AdjustmentPanel\.tsx:\d+\s+)?y=(\d+):\s*(.*)$/;

function parseLog(path) {
  const grid = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = LOG_LINE.exec(line.trim());
    if (!m) continue;
    grid[Number(m[1])] = m[2].split(',').map(Number);
  }
  const h = Math.max(...Object.keys(grid).map(Number)) + 1;
  const w = Math.max(...Object.values(grid).map(r => r.length));
  const a = new Float32Array(h * w);
  for (const [y, r] of Object.entries(grid)) for (let x = 0; x < r.length; x++) a[Number(y) * w + x] = r[x];
  return { a, w, h };
}

const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const std = arr => Math.sqrt(mean(arr.map(v => (v - mean(arr)) ** 2)));
const P = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };

const sample = parseLog('C:/Users/Administrator/Desktop/平滑线条样本.log');
const ts = parseLog('analysis/line_vis/ts_res.log');
const { w, h } = sample;
const N = w * h;

const line = [], core = [];
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  if (sample.a[i] > 16) {
    line.push(i);
    if (sample.a[i - 1] > 16 && sample.a[i + 1] > 16 && sample.a[i - w] > 16 && sample.a[i + w] > 16) core.push(i);
  }
}
const cv0 = core.map(i => sample.a[i]);
const cv1 = core.map(i => ts.a[i]);

console.log('===== TS 输出 完整指标（样本 105x140） =====');
// 背景保持
let bgOk = 0, bgN = 0;
for (let i = 0; i < N; i++) { if (sample.a[i] === 0) { bgN++; if (ts.a[i] === 0) bgOk++; } }
console.log(`背景保持: ${(bgOk / bgN * 100).toFixed(2)}%`);
let nRes = 0;
for (let i = 0; i < N; i++) if (ts.a[i] > 16) nRes++;
console.log(`线内像素: ${line.length} -> ${nRes}，线宽变化: ${((100 * (nRes - line.length)) / line.length).toFixed(1)}%`);
console.log(`线内 alpha MAE: ${mean(line.map(i => Math.abs(ts.a[i] - sample.a[i]))).toFixed(2)}`);
console.log(`线内 alpha 均值: ${mean(line.map(i => sample.a[i])).toFixed(1)} -> ${mean(line.map(i => ts.a[i])).toFixed(1)}`);
console.log(`核心主体 P50/P85/P95: ${P(cv1, 0.5).toFixed(0)}/${P(cv1, 0.85).toFixed(0)}/${P(cv1, 0.95).toFixed(0)} (样本 ${P(cv0, 0.5).toFixed(0)}/${P(cv0, 0.85).toFixed(0)}/${P(cv0, 0.95).toFixed(0)})`);
console.log(`核心波动(反复描线): ${std(cv0).toFixed(1)} -> ${std(cv1).toFixed(1)}，收敛 ${(100 * (1 - std(cv1) / std(cv0))).toFixed(0)}%`);
let d0 = 0, d1 = 0, n2 = 0;
for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) {
  d0 += Math.abs(sample.a[y * w + x] - sample.a[(y - 1) * w + x]);
  d1 += Math.abs(ts.a[y * w + x] - ts.a[(y - 1) * w + x]);
  n2++;
}
console.log(`相邻行突变: ${(d0 / n2).toFixed(2)} -> ${(d1 / n2).toFixed(2)}`);

console.log('\n===== 形态对比（核心像素水平） =====');
for (const [name, g] of [['样本(输入)', sample], ['TS算法输出', ts],
  ['理想情况', parseLog('C:/Users/Administrator/Desktop/理想情况结果.log')],
  ['最低要求', parseLog('C:/Users/Administrator/Desktop/最低要求结果.log')]]) {
  const gw = g.w, gh = g.h;
  const gc = [];
  for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
    const i = y * gw + x;
    if (g.a[i] > 16 && g.a[i - 1] > 16 && g.a[i + 1] > 16 && g.a[i - gw] > 16 && g.a[i + gw] > 16) gc.push(g.a[i]);
  }
  if (gc.length) console.log(`${name}: 核心P50=${P(gc, 0.5).toFixed(0)} P85=${P(gc, 0.85).toFixed(0)} (n=${gc.length})`);
}

console.log('\n===== RGBA 四通道说明 =====');
console.log('R/G/B：算法只改 alpha 通道，RGB 直通色保持原值（0 通道差异）');
console.log('A 通道：背景(alpha=0) 100% 保持；非背景像素按算法结果更新');
