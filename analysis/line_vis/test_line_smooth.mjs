// test_line_smooth.mjs —— 仅主线条平滑算法端到端验证
// 输入：平滑线条样本.log（alpha 网格）→ 构造 RGBA → processLineSmooth → 输出 alpha 网格
// 对比：Python 原型 v4 结果（line_vis/v4_res.log）+ 理想情况/最低要求形态
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { processLineSmooth } from '../../src/adjustments/lineSmoothProcessor.ts';

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
  for (const [y, r] of Object.entries(grid)) {
    for (let x = 0; x < r.length; x++) a[Number(y) * w + x] = r[x];
  }
  return { a, w, h };
}

function gridToRGBA(a, w, h, lineColor = [60, 60, 60]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const al = a[i];
    rgba[i * 4] = lineColor[0];
    rgba[i * 4 + 1] = lineColor[1];
    rgba[i * 4 + 2] = lineColor[2];
    rgba[i * 4 + 3] = Math.round(al);
  }
  return rgba;
}

function toGrid(rgba, w, h) {
  const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = rgba[i * 4 + 3];
  return a;
}

function evaluate(name, orig, res, w, h) {
  const line = new Uint8Array(w * h);
  let nLine = 0;
  for (let i = 0; i < w * h; i++) { if (orig[i] > 16) { line[i] = 1; nLine++; } }
  // 背景保持
  let bgOk = 0, bgN = 0;
  for (let i = 0; i < w * h; i++) { if (orig[i] === 0) { bgN++; if (res[i] === 0) bgOk++; } }
  const bgKeep = bgN ? (bgOk / bgN) * 100 : 100;
  // 线宽变化
  let nRes = 0;
  for (let i = 0; i < w * h; i++) { if (res[i] > 16) nRes++; }
  const widthPct = (100 * (nRes - nLine)) / Math.max(1, nLine);
  // 线内 MAE
  let mae = 0, cnt = 0;
  for (let i = 0; i < w * h; i++) { if (line[i]) { mae += Math.abs(res[i] - orig[i]); cnt++; } }
  mae = cnt ? mae / cnt : 0;
  // 核心像素（dist_in>=1.2 的近似：线内且上下左右都有线内像素）
  const coreVals = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!line[i]) continue;
      if (line[i - 1] && line[i + 1] && line[i - w] && line[i + w]) coreVals.push(i);
    }
  }
  const cv = coreVals.map(i => orig[i]);
  const cv2 = coreVals.map(i => res[i]);
  const std0 = Math.sqrt(cv.reduce((s, v) => s + (v - cv.reduce((a, b) => a + b, 0) / cv.length) ** 2, 0) / Math.max(1, cv.length));
  const m2 = cv2.reduce((a, b) => a + b, 0) / Math.max(1, cv2.length);
  const std1 = Math.sqrt(cv2.reduce((s, v) => s + (v - m2) ** 2, 0) / Math.max(1, cv2.length));
  const conv = 100 * (1 - std1 / Math.max(1e-6, std0));
  // 相邻行突变
  let d0 = 0, d1 = 0, dn = 0;
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      d0 += Math.abs(orig[y * w + x] - orig[(y - 1) * w + x]);
      d1 += Math.abs(res[y * w + x] - res[(y - 1) * w + x]);
      dn++;
    }
  }
  d0 /= dn; d1 /= dn;
  const P = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  };
  const c50 = P(cv2, 0.5), c85 = P(cv2, 0.85);
  console.log(`${name}: 背景${bgKeep.toFixed(1)}% 线宽${widthPct >= 0 ? '+' : ''}${widthPct.toFixed(1)}% MAE${mae.toFixed(1)} 核心P50/P85=${c50.toFixed(0)}/${c85.toFixed(0)} 核心波动-${conv.toFixed(0)}% 行突变-${((1 - d1 / Math.max(1e-6, d0)) * 100).toFixed(0)}%`);
}

// ===== 1. 用样本构造输入跑 TS 算法 =====
const sample = parseLog('C:/Users/Administrator/Desktop/平滑线条样本.log');
const rgba = gridToRGBA(sample.a, sample.w, sample.h);
const sel = new Uint8Array(sample.w * sample.h).fill(1);

// 与 Python v4 对比（若存在）
if (existsSync('analysis/line_vis/v4_res.log')) {
  const v4 = parseLog('analysis/line_vis/v4_res.log');
  const aOut = toGrid(rgba, sample.w, sample.h);
  // 计算差异（TS 输出 vs v4 网格）
  const outBuf = await processLineSmooth(rgba.buffer, sel.buffer, { width: sample.w, height: sample.h }, { strength: 1, radius: 8 });
  const outArr = toGrid(new Uint8Array(outBuf), sample.w, sample.h);
  let diff = 0, dn2 = 0;
  for (let i = 0; i < sample.w * sample.h; i++) {
    if (aOut[i] > 0) { diff += Math.abs(outArr[i] - v4.a[i]); dn2++; }
  }
  console.log(`TS vs Python v4: 线内平均差 ${(diff / Math.max(1, dn2)).toFixed(2)} (像素级一致性)`);
  evaluate('TS输出', sample.a, outArr, sample.w, sample.h);
  // 保存 TS 输出 log
  let log = '===== [alpha采样] 图层: TS结果 =====\n' + `尺寸: ${sample.w}x${sample.h}\n`;
  for (let y = 0; y < sample.h; y++) {
    const row = [];
    for (let x = 0; x < sample.w; x++) row.push(Math.round(outArr[y * sample.w + x]));
    log += `y=${y}: ` + row.join(',') + '\n';
  }
  log += '===== [alpha采样] 结束 =====\n';
  writeFileSync('analysis/line_vis/ts_res.log', log);
  console.log('saved analysis/line_vis/ts_res.log');
} else {
  const outBuf = await processLineSmooth(rgba.buffer, sel.buffer, { width: sample.w, height: sample.h }, { strength: 1, radius: 8 });
  const outArr = toGrid(new Uint8Array(outBuf), sample.w, sample.h);
  evaluate('TS输出', sample.a, outArr, sample.w, sample.h);
}

// ===== 2. 强度/范围参数扫描（TS 内） =====
console.log('\n--- TS 参数敏感性 ---');
for (const s of [0.3, 0.6, 1.0]) {
  for (const r of [4, 8, 12]) {
    const outBuf = await processLineSmooth(rgba.buffer, sel.buffer, { width: sample.w, height: sample.h }, { strength: s, radius: r });
    const outArr = toGrid(new Uint8Array(outBuf), sample.w, sample.h);
    evaluate(`strength=${s} radius=${r}`, sample.a, outArr, sample.w, sample.h);
  }
}
