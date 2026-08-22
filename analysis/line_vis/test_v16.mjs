// test_v16.mjs —— TS v16 算法端到端验证
import { readFileSync, writeFileSync } from 'fs';
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
  for (const [y, r] of Object.entries(grid)) for (let x = 0; x < r.length; x++) a[Number(y) * w + x] = r[x];
  return { a, w, h };
}

const sample = parseLog('C:/Users/Administrator/Desktop/平滑线条样本.log');
const { w, h } = sample;
const N = w * h;
const rgba = new Uint8Array(N * 4);
for (let i = 0; i < N; i++) {
  rgba[i * 4] = 60; rgba[i * 4 + 1] = 60; rgba[i * 4 + 2] = 60;
  rgba[i * 4 + 3] = Math.round(sample.a[i]);
}
const sel = new Uint8Array(N).fill(1);

const outBuf = await processLineSmooth(rgba.buffer, sel.buffer, { width: w, height: h }, { strength: 1, radius: 8 });
const out = new Uint8Array(outBuf);

// 与 Python v16 对比
const v16 = parseLog('analysis/line_vis/v16_res.log');
let diff = 0, cnt = 0;
for (let i = 0; i < N; i++) {
  if (sample.a[i] > 0) { diff += Math.abs(out[i * 4 + 3] - v16.a[i]); cnt++; }
}
console.log('TS vs Python v16: 非零像素平均差', (diff / cnt).toFixed(2));

// 指标
let lineCnt = 0, nRes = 0;
for (let i = 0; i < N; i++) { if (sample.a[i] > 16) lineCnt++; if (out[i * 4 + 3] > 16) nRes++; }
let mae = 0, c = 0;
for (let i = 0; i < N; i++) if (sample.a[i] > 16) { mae += Math.abs(out[i * 4 + 3] - sample.a[i]); c++; }
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const std = arr => Math.sqrt(mean(arr.map(v => (v - mean(arr)) ** 2)));
const lineVals = [], lineOut = [];
for (let i = 0; i < N; i++) if (sample.a[i] > 16) { lineVals.push(sample.a[i]); lineOut.push(out[i * 4 + 3]); }
console.log(`线宽变化: ${((100 * (nRes - lineCnt)) / lineCnt).toFixed(1)}%`);
console.log(`线内 MAE: ${(mae / c).toFixed(1)}，均值 ${mean(lineVals).toFixed(1)} -> ${mean(lineOut).toFixed(1)}`);
console.log(`线内 std: ${std(lineVals).toFixed(1)} -> ${std(lineOut).toFixed(1)} (${(100 * (1 - std(lineOut) / std(lineVals))).toFixed(0)}% 收敛)`);

// 保存 TS 输出 log
let log = '===== [alpha采样] 图层: TS v16结果 =====\n' + `尺寸: ${w}x${h}\n`;
for (let y = 0; y < h; y++) {
  const row = [];
  for (let x = 0; x < w; x++) row.push(out[(y * w + x) * 4 + 3]);
  log += `y=${y}: ` + row.join(',') + '\n';
}
log += '===== [alpha采样] 结束 =====\n';
writeFileSync('analysis/line_vis/ts_v16_res.log', log);
console.log('saved ts_v16_res.log');

// 参数敏感性（力度）
console.log('\n--- 平滑力度敏感性 ---');
for (const s of [0.2, 0.5, 1.0]) {
  const ob = await processLineSmooth(rgba.buffer, sel.buffer, { width: w, height: h }, { strength: s, radius: 8 });
  const o2 = new Uint8Array(ob);
  let m2 = 0, c2 = 0;
  for (let i = 0; i < N; i++) if (sample.a[i] > 16) { m2 += Math.abs(o2[i * 4 + 3] - sample.a[i]); c2++; }
  const outV = [];
  for (let i = 0; i < N; i++) if (sample.a[i] > 16) outV.push(o2[i * 4 + 3]);
  console.log(`strength=${s}: MAE=${(m2 / c2).toFixed(1)} std=${std(outV).toFixed(1)}`);
}
