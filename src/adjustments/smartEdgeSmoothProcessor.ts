import { action, imaging } from 'photoshop';

/*
  这个文件实现「边缘平滑」功能，分成两种用户能理解的模式：

  1) 仅色块边界（edge）
     目标：让色块边界更干净、更“磨平”，但不要让用户看出选区边界。
     做法：用 Photoshop 自带的「中间值（median）」滤镜生成参考结果（读取后立即撤销），
           对整个选区写回 median 结果，并在选区边缘做渐隐，避免出现“选区边界感”。

  2) 仅主线条（line）
     目标：先把选区内杂线/噪点“磨平”，再把识别到的主线条拟合成平滑线条写回去。
     做法顺序：
       - 先在原始像素中识别疑似主线条，并记录主线条的采样颜色
       - 用 PS 的「中间值」把选区磨平（作为“干净底图”）
       - 在“干净底图”上把拟合线条画回去
       - 如果识别不到主线条，也仍然返回“磨平后的底图”（保证用户能看到磨平效果）
*/

/*
  边缘平滑的参数说明（面板上能调的是其中一部分）：
  - mode:
      edge：仅色块边界
      line：仅主线条
  - edgeMedianRadius：色块边界的中间值半径（PS median 半径）
  - backgroundSmoothRadius：主线条模式里用于“先磨平”的中间值半径（PS median 半径）
  - lineStrength/lineWidthScale/lineHardness：主线条回写的力度、粗细倍率、硬度
*/
interface EdgeDetectionParams {
  alphaThreshold?: number;
  colorThreshold?: number;
  smoothRadius?: number;
  preserveDetail?: boolean;
  intensity?: number;
  mode?: 'edge' | 'line';
  edgeMedianRadius?: number;
  backgroundSmoothRadius?: number;
  lineStrength?: number;
  lineWidthScale?: number;
  lineHardness?: number;
}

type Vec2 = { x: number; y: number };

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));
const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));

type PhotoshopContext = { documentID: number; layerID: number };

/*
  Photoshop 的 getPixels 可能返回 RGB 或 RGBA。
  为了让后续处理逻辑统一，这里把输入统一成 RGBA（缺失的 A 默认 255）。
*/
function normalizePixelsToRGBA(
  raw: Uint8Array,
  pixelCount: number
): Uint8Array {
  const bpp = pixelCount > 0 ? raw.length / pixelCount : 0;
  if (bpp === 4) return raw;
  if (bpp === 3) {
    const rgba = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      const s = i * 3;
      const d = i * 4;
      rgba[d] = raw[s] || 0;
      rgba[d + 1] = raw[s + 1] || 0;
      rgba[d + 2] = raw[s + 2] || 0;
      rgba[d + 3] = 255;
    }
    return rgba;
  }
  const rgba = new Uint8Array(pixelCount * 4);
  rgba.fill(0);
  for (let i = 0; i < pixelCount; i++) rgba[i * 4 + 3] = 255;
  return rgba;
}

async function getMedianFilteredSelectionRegionRGBA(
  ps: PhotoshopContext,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  radius: number
): Promise<Uint8Array | null> {
  // 色块边界模式需要“在不影响原图层”的前提下，拿到 PS 原生中间值结果。
  // 做法：复制当前图层 -> 在临时图层上执行 median（会受当前选区限制）-> 读取像素 -> 删除临时图层。
  const regionW = bounds.x1 - bounds.x0 + 1;
  const regionH = bounds.y1 - bounds.y0 + 1;
  if (regionW <= 0 || regionH <= 0) return null;

  let tempLayerId: number | null = null;
  try {
    await action.batchPlay([
      {
        _obj: 'duplicate',
        _target: [{ _ref: 'layer', _id: ps.layerID }],
        _options: { dialogOptions: 'dontDisplay' }
      }
    ], { synchronousExecution: true });

    const dupInfo = await action.batchPlay([
      {
        _obj: 'get',
        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
      }
    ], { synchronousExecution: true });

    tempLayerId = dupInfo?.[0]?.layerID;
    if (!tempLayerId) return null;

    await action.batchPlay([
      {
        _obj: 'median',
        radius: { _unit: 'pixelsUnit', _value: radius },
        _isCommand: false,
        _options: { dialogOptions: 'dontDisplay' }
      }
    ], { synchronousExecution: true });

    const pixels = await imaging.getPixels({
      documentID: ps.documentID,
      layerID: tempLayerId,
      sourceBounds: {
        left: bounds.x0,
        top: bounds.y0,
        right: bounds.x1 + 1,
        bottom: bounds.y1 + 1
      },
      targetSize: { width: regionW, height: regionH }
    });

    const raw = new Uint8Array(await pixels.imageData.getData());
    pixels.imageData.dispose();
    return normalizePixelsToRGBA(raw, regionW * regionH);
  } catch (e) {
    return null;
  } finally {
    if (tempLayerId) {
      try {
        await action.batchPlay([
          {
            _obj: 'delete',
            _target: [{ _ref: 'layer', _id: tempLayerId }],
            _isCommand: false
          }
        ], { synchronousExecution: true });
      } catch (e) {
      }
      try {
        await action.batchPlay([
          {
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: ps.layerID }],
            makeVisible: false,
            _isCommand: false
          }
        ], { synchronousExecution: true });
      } catch (e) {
      }
    }
  }
}

function buildSelectionInnerFadeRegion(
  selectionMask: Uint8Array,
  width: number,
  height: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  fadeWidth: number
): Uint8Array {
  // 计算“选区边缘渐隐系数”（0~255）：
  //  - 选区边界像素=0（不写回/几乎不写回）
  //  - 向选区内部逐步增加，直到达到 fadeWidth 以后=255（完全写回）
  // 目的是：即使选区没有羽化，也尽量避免用户看见“选区边界”的痕迹。
  const regionW = bounds.x1 - bounds.x0 + 1;
  const regionH = bounds.y1 - bounds.y0 + 1;
  const regionSize = Math.max(0, regionW * regionH);
  const fade = new Uint8Array(regionSize);
  if (regionW <= 0 || regionH <= 0) return fade;

  const fw = Math.max(1, fadeWidth | 0);
  const dist = new Int16Array(regionSize);
  dist.fill(-1);

  const q = new Int32Array(regionSize);
  let head = 0;
  let tail = 0;

  const isSelected = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return (selectionMask[y * width + x] || 0) !== 0;
  };

  for (let ry = 0; ry < regionH; ry++) {
    const y = bounds.y0 + ry;
    for (let rx = 0; rx < regionW; rx++) {
      const x = bounds.x0 + rx;
      if (!isSelected(x, y)) continue;

      const boundary =
        !isSelected(x - 1, y) ||
        !isSelected(x + 1, y) ||
        !isSelected(x, y - 1) ||
        !isSelected(x, y + 1);

      if (!boundary) continue;
      const ri = ry * regionW + rx;
      dist[ri] = 0;
      q[tail++] = ri;
    }
  }

  while (head < tail) {
    // 用 BFS 从边界往内部扩散，得到每个选区像素离边界的步数（近似距离）。
    const ri = q[head++] as number;
    const d = dist[ri] as number;
    if (d >= fw) continue;

    const rx = ri % regionW;
    const ry = (ri - rx) / regionW;
    const x = bounds.x0 + rx;
    const y = bounds.y0 + ry;

    const tryPush = (nx: number, ny: number, nRi: number) => {
      if (dist[nRi] !== -1) return;
      if (!isSelected(nx, ny)) return;
      dist[nRi] = (d + 1) as any;
      q[tail++] = nRi;
    };

    if (rx > 0) tryPush(x - 1, y, ri - 1);
    if (rx + 1 < regionW) tryPush(x + 1, y, ri + 1);
    if (ry > 0) tryPush(x, y - 1, ri - regionW);
    if (ry + 1 < regionH) tryPush(x, y + 1, ri + regionW);
  }

  for (let i = 0; i < regionSize; i++) {
    const d = dist[i];
    const rx = i % regionW;
    const ry = (i - rx) / regionW;
    const docIdx = (bounds.y0 + ry) * width + (bounds.x0 + rx);
    const isSel = (selectionMask[docIdx] || 0) !== 0;
    if (!isSel) {
      fade[i] = 0;
      continue;
    }
    if (d < 0) {
      fade[i] = 255;
      continue;
    }
    if (d >= fw) {
      fade[i] = 255;
      continue;
    }
    fade[i] = Math.round((255 * d) / fw);
  }

  return fade;
}

/*
  在一个数组里“就地”找第 k 小的元素（快速选择/部分排序）。
  用途：求中位数时不需要完整排序，速度更快、内存更省。
*/
function selectKInPlace(a: Uint8Array, n: number, k: number): number {
  let left = 0;
  let right = n - 1;
  while (true) {
    if (left === right) return a[left] || 0;
    let pivotIndex = (left + right) >> 1;
    const pivotValue = a[pivotIndex] || 0;
    {
      const tmp = a[pivotIndex] || 0;
      a[pivotIndex] = a[right] || 0;
      a[right] = tmp;
    }
    let storeIndex = left;
    for (let i = left; i < right; i++) {
      const v = a[i] || 0;
      if (v < pivotValue) {
        const tmp = a[storeIndex] || 0;
        a[storeIndex] = v;
        a[i] = tmp;
        storeIndex++;
      }
    }
    {
      const tmp = a[right] || 0;
      a[right] = a[storeIndex] || 0;
      a[storeIndex] = tmp;
    }
    if (k === storeIndex) return a[k] || 0;
    if (k < storeIndex) right = storeIndex - 1;
    else left = storeIndex + 1;
  }
}

/*
  求 samples[0..n) 的中位数（n 为样本数量）。
  注意：会修改 samples 的内容顺序（因为内部用就地选择算法）。
*/
function medianOfSamples(samples: Uint8Array, n: number): number {
  if (n <= 0) return 0;
  const k = (n - 1) >> 1;
  return selectKInPlace(samples, n, k);
}

/*
  把“预乘 alpha”的 RGB（rP/gP/bP）转换成亮度（0~255）。
  这里用的是近似 Rec.601 的整数权重，足够用于边缘检测。
*/
function lumaFromPremult(rP: number, gP: number, bP: number): number {
  return (77 * rP + 150 * gP + 29 * bP + 128) >> 8;
}

/*
  从 selectionMask（0 表示不在选区内）计算选区的包围盒。
  返回的是选区像素的最小/最大 x/y，用于后续只处理必要区域。
*/
function computeSelectionBounds(selectionMask: Uint8Array, width: number, height: number) {
  const pixelCount = width * height;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < pixelCount; i++) {
    if ((selectionMask[i] || 0) === 0) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/*
  在选区内做一个简单的梯度幅值（边缘强度）估计，并同时统计直方图：
  - gradMag：每个像素的梯度强度（0~2047）
  - edgeThreshold：用于判定“可能是边缘”的阈值（从直方图的分位数估计）
  - strongThreshold：更强的边缘阈值（用于归一化 edge01）
*/
function buildGradMagHistogram(
  lumaP: Uint8Array,
  selectionMask: Uint8Array,
  width: number,
  height: number
) {
  const pixelCount = width * height;
  const gradMag = new Uint16Array(pixelCount);
  const hist = new Uint32Array(2048);
  let selectedCount = 0;

  const getL = (x: number, y: number) => lumaP[y * width + x] || 0;

  for (let y = 1; y < height - 1; y++) {
    const rowBase = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = rowBase + x;
      if ((selectionMask[idx] || 0) === 0) continue;

      const p00 = getL(x - 1, y - 1);
      const p10 = getL(x, y - 1);
      const p20 = getL(x + 1, y - 1);
      const p01 = getL(x - 1, y);
      const p21 = getL(x + 1, y);
      const p02 = getL(x - 1, y + 1);
      const p12 = getL(x, y + 1);
      const p22 = getL(x + 1, y + 1);

      const gx = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;
      const gy = -p00 - 2 * p10 - p20 + p02 + 2 * p12 + p22;

      const g = Math.abs(gx) + Math.abs(gy);
      const gClamped = g > 2047 ? 2047 : g;
      gradMag[idx] = gClamped;
      hist[gClamped]++;
      selectedCount++;
    }
  }

  const getPercentile = (p01: number) => {
    if (selectedCount <= 0) return 0;
    const target = Math.max(0, Math.min(selectedCount - 1, Math.round(p01 * (selectedCount - 1))));
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
      acc += hist[i] || 0;
      if (acc > target) return i;
    }
    return hist.length - 1;
  };

  const p70 = getPercentile(0.7);
  const p92 = getPercentile(0.92);
  const edgeThreshold = Math.max(24, Math.min(700, p70));
  const strongThreshold = Math.max(edgeThreshold + 1, Math.min(1100, Math.max(p92, edgeThreshold + 60)));

  return { gradMag, edgeThreshold, strongThreshold, selectedCount };
}

/*
  在 bounds 范围内，对亮度做“只在选区权重内参与”的盒式模糊（box blur）。
  它的作用不是最终效果，而是给“主线条识别/抹除”提供一个更平滑的背景亮度参考（bgLuma）。
*/
function maskedBoxBlurLuma(
  lumaP: Uint8Array,
  selectionMask: Uint8Array,
  width: number,
  height: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  radius: number
) {
  const { x0, y0, x1, y1 } = bounds;
  const regionW = x1 - x0 + 1;
  const regionH = y1 - y0 + 1;
  const regionSize = regionW * regionH;

  const hSumL = new Uint32Array(regionSize);
  const hSumW = new Uint32Array(regionSize);

  const clampX = (x: number) => (x < x0 ? x0 : (x > x1 ? x1 : x));

  for (let ry = 0; ry < regionH; ry++) {
    const y = y0 + ry;
    const docRow = y * width;
    const base = ry * regionW;
    let sumL = 0;
    let sumW = 0;

    for (let dx = -radius; dx <= radius; dx++) {
      const xx = clampX(x0 + dx);
      const idx = docRow + xx;
      const w = selectionMask[idx] || 0;
      sumW += w;
      sumL += (lumaP[idx] || 0) * w;
    }

    hSumL[base] = sumL;
    hSumW[base] = sumW;

    for (let rx = 1; rx < regionW; rx++) {
      const outX = clampX(x0 + rx - radius - 1);
      const inX = clampX(x0 + rx + radius);
      const outIdx = docRow + outX;
      const inIdx = docRow + inX;
      const wOut = selectionMask[outIdx] || 0;
      const wIn = selectionMask[inIdx] || 0;
      sumW += wIn - wOut;
      sumL += (lumaP[inIdx] || 0) * wIn - (lumaP[outIdx] || 0) * wOut;
      hSumL[base + rx] = sumL;
      hSumW[base + rx] = sumW;
    }
  }

  const out = new Uint8Array(width * height);
  const clampY = (y: number) => (y < y0 ? y0 : (y > y1 ? y1 : y));

  for (let rx = 0; rx < regionW; rx++) {
    let sumL = 0;
    let sumW = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = clampY(y0 + dy);
      const ri = (yy - y0) * regionW + rx;
      sumL += hSumL[ri] || 0;
      sumW += hSumW[ri] || 0;
    }

    const firstDocIdx = y0 * width + (x0 + rx);
    if (sumW > 0) out[firstDocIdx] = Math.round(sumL / sumW);

    for (let ry = 1; ry < regionH; ry++) {
      const outY = clampY(y0 + ry - radius - 1);
      const inY = clampY(y0 + ry + radius);
      const outRi = (outY - y0) * regionW + rx;
      const inRi = (inY - y0) * regionW + rx;
      sumL += (hSumL[inRi] || 0) - (hSumL[outRi] || 0);
      sumW += (hSumW[inRi] || 0) - (hSumW[outRi] || 0);
      const docIdx = (y0 + ry) * width + (x0 + rx);
      if (sumW > 0) out[docIdx] = Math.round(sumL / sumW);
    }
  }

  return out;
}

/*
  和 maskedBoxBlurLuma 类似，只不过处理的是 alpha 通道。
  用途：在普通图层里，抹除/回写时需要一个平滑的背景 alpha 参考（bgAlpha），避免硬边突兀。
*/
function maskedBoxBlurAlpha(
  alpha: Uint8Array,
  selectionMask: Uint8Array,
  width: number,
  height: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  radius: number
) {
  const { x0, y0, x1, y1 } = bounds;
  const regionW = x1 - x0 + 1;
  const regionH = y1 - y0 + 1;
  const regionSize = regionW * regionH;

  const hSumA = new Uint32Array(regionSize);
  const hSumW = new Uint32Array(regionSize);

  const clampX = (x: number) => (x < x0 ? x0 : (x > x1 ? x1 : x));

  for (let ry = 0; ry < regionH; ry++) {
    const y = y0 + ry;
    const docRow = y * width;
    const base = ry * regionW;
    let sumA = 0;
    let sumW = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = clampX(x0 + dx);
      const idx = docRow + xx;
      const w = selectionMask[idx] || 0;
      sumW += w;
      sumA += (alpha[idx] || 0) * w;
    }
    hSumA[base] = sumA;
    hSumW[base] = sumW;
    for (let rx = 1; rx < regionW; rx++) {
      const outX = clampX(x0 + rx - radius - 1);
      const inX = clampX(x0 + rx + radius);
      const outIdx = docRow + outX;
      const inIdx = docRow + inX;
      const wOut = selectionMask[outIdx] || 0;
      const wIn = selectionMask[inIdx] || 0;
      sumW += wIn - wOut;
      sumA += (alpha[inIdx] || 0) * wIn - (alpha[outIdx] || 0) * wOut;
      hSumA[base + rx] = sumA;
      hSumW[base + rx] = sumW;
    }
  }

  const out = new Uint8Array(width * height);
  const clampY = (y: number) => (y < y0 ? y0 : (y > y1 ? y1 : y));

  for (let rx = 0; rx < regionW; rx++) {
    let sumA = 0;
    let sumW = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = clampY(y0 + dy);
      const ri = (yy - y0) * regionW + rx;
      sumA += hSumA[ri] || 0;
      sumW += hSumW[ri] || 0;
    }
    const firstDocIdx = y0 * width + (x0 + rx);
    if (sumW > 0) out[firstDocIdx] = Math.round(sumA / sumW);

    for (let ry = 1; ry < regionH; ry++) {
      const outY = clampY(y0 + ry - radius - 1);
      const inY = clampY(y0 + ry + radius);
      const outRi = (outY - y0) * regionW + rx;
      const inRi = (inY - y0) * regionW + rx;
      sumA += (hSumA[inRi] || 0) - (hSumA[outRi] || 0);
      sumW += (hSumW[inRi] || 0) - (hSumW[outRi] || 0);
      const docIdx = (y0 + ry) * width + (x0 + rx);
      if (sumW > 0) out[docIdx] = Math.round(sumA / sumW);
    }
  }

  return out;
}

/*
  用 PCA（主成分分析）的思路，估计一组像素点的“主方向”。
  输入是像素索引（1D），需要 width 才能还原 (x, y)。
  输出是单位向量 v=(x,y)，表示线条整体朝向。
*/
function estimateLineDirectionPCA(indices: number[], width: number): Vec2 {
  const n = indices.length;
  if (n <= 1) return { x: 1, y: 0 };
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    const idx = indices[i] || 0;
    const x = idx % width;
    const y = (idx - x) / width;
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const idx = indices[i] || 0;
    const x = idx % width;
    const y = (idx - x) / width;
    const dx = x - meanX;
    const dy = y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, tr * tr - 4 * det);
  const lambda1 = (tr + Math.sqrt(disc)) / 2;
  let vx = 1;
  let vy = 0;
  if (Math.abs(sxy) > 1e-6) {
    vx = lambda1 - syy;
    vy = sxy;
  } else if (sxx >= syy) {
    vx = 1;
    vy = 0;
  } else {
    vx = 0;
    vy = 1;
  }
  const len = Math.hypot(vx, vy) || 1;
  return { x: vx / len, y: vy / len };
}

/*
  把一堆“疑似主线条像素”拟合成一条更平滑的中心线（polyline）。

  做法概念：
  - 先把点投影到主方向 v 上，得到 u（沿线方向）和 v（垂直方向的偏移）
  - 沿 u 做分箱，对每个箱求平均 v（得到一条粗糙中心线）
  - 对缺口做短距离插值，对 v 曲线做一次小窗口平滑
  - 再从 (u, v) 反投影回 (x, y)，形成最终 polyline
*/
function buildSmoothedCenterline(
  indices: number[],
  width: number,
  height: number,
  v: Vec2
) {
  const n = indices.length;
  const vx = v.x;
  const vy = v.y;
  let minU = Infinity;
  let maxU = -Infinity;
  const uVals = new Float32Array(n);
  const vVals = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const idx = indices[i] || 0;
    const x = idx % width;
    const y = (idx - x) / width;
    const u = x * vx + y * vy;
    const vv = -x * vy + y * vx;
    uVals[i] = u;
    vVals[i] = vv;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
  }
  if (!Number.isFinite(minU) || !Number.isFinite(maxU) || maxU - minU < 2) return [];

  const bins = Math.min(20000, Math.max(8, Math.ceil(maxU - minU) + 1));
  const accV = new Float32Array(bins);
  const cnt = new Uint16Array(bins);

  const scale = (bins - 1) / (maxU - minU);
  for (let i = 0; i < n; i++) {
    const u = uVals[i];
    const vv = vVals[i];
    const b = clampInt(Math.round((u - minU) * scale), 0, bins - 1);
    accV[b] += vv;
    const c = (cnt[b] || 0) + 1;
    cnt[b] = c > 65535 ? 65535 : c;
  }

  const vMean = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const c = cnt[i] || 0;
    vMean[i] = c > 0 ? accV[i] / c : NaN;
  }

  const maxGap = 6;
  let last = -1;
  for (let i = 0; i < bins; i++) {
    if (Number.isFinite(vMean[i])) {
      if (last >= 0 && i - last > 1 && i - last <= maxGap) {
        const a = vMean[last];
        const b = vMean[i];
        const span = i - last;
        for (let t = 1; t < span; t++) {
          vMean[last + t] = a + ((b - a) * t) / span;
        }
      }
      last = i;
    }
  }

  const smoothW = 7;
  const half = smoothW >> 1;
  const vSmooth = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    if (!Number.isFinite(vMean[i])) {
      vSmooth[i] = NaN;
      continue;
    }
    let sum = 0;
    let wSum = 0;
    for (let j = -half; j <= half; j++) {
      const k = i + j;
      if (k < 0 || k >= bins) continue;
      const vv = vMean[k];
      if (!Number.isFinite(vv)) continue;
      const w = 1 - Math.abs(j) / (half + 1);
      sum += vv * w;
      wSum += w;
    }
    vSmooth[i] = wSum > 0 ? sum / wSum : vMean[i];
  }

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < bins; i++) {
    const vv = vSmooth[i];
    if (!Number.isFinite(vv)) continue;
    const u = minU + (i / scale);
    const x = u * vx - vv * vy;
    const y = u * vy + vv * vx;
    const xi = clampInt(Math.round(x), 0, width - 1);
    const yi = clampInt(Math.round(y), 0, height - 1);
    if (points.length > 0) {
      const prev = points[points.length - 1];
      if (prev.x === xi && prev.y === yi) continue;
    }
    points.push({ x: xi, y: yi });
  }
  return points;
}

function chaikinSmoothPolyline(points: Array<{ x: number; y: number }>, iterations: number, width: number, height: number) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts;
    const out: Array<{ x: number; y: number }> = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const qx = 0.75 * p0.x + 0.25 * p1.x;
      const qy = 0.75 * p0.y + 0.25 * p1.y;
      const rx = 0.25 * p0.x + 0.75 * p1.x;
      const ry = 0.25 * p0.y + 0.75 * p1.y;
      out.push({ x: qx, y: qy }, { x: rx, y: ry });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  const snapped: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const xi = clampInt(Math.round(p.x), 0, width - 1);
    const yi = clampInt(Math.round(p.y), 0, height - 1);
    if (snapped.length > 0) {
      const prev = snapped[snapped.length - 1];
      if (prev.x === xi && prev.y === yi) continue;
    }
    snapped.push({ x: xi, y: yi });
  }
  return snapped;
}

function estimateStrokeRadiusFromMask(indices: number[], width: number, height: number, v: Vec2) {
  if (indices.length <= 0) return 1;
  const mark = new Uint8Array(width * height);
  for (let i = 0; i < indices.length; i++) mark[indices[i] || 0] = 1;

  const px = -v.y;
  const py = v.x;

  const maxSamples = Math.min(256, indices.length);
  const step = Math.max(1, Math.floor(indices.length / maxSamples));
  const widths = new Uint8Array(maxSamples);
  let n = 0;

  for (let i = 0; i < indices.length && n < maxSamples; i += step) {
    const idx = indices[i] || 0;
    const x0 = idx % width;
    const y0 = (idx - x0) / width;
    let count = 1;

    for (let dir = -1 as -1 | 1; dir <= 1; dir += 2 as any) {
      for (let t = 1; t <= 48; t++) {
        const x = Math.round(x0 + px * t * dir);
        const y = Math.round(y0 + py * t * dir);
        if (x < 0 || x >= width || y < 0 || y >= height) break;
        const j = y * width + x;
        if ((mark[j] || 0) === 0) break;
        count++;
      }
    }

    widths[n] = count > 255 ? 255 : count;
    n++;
  }

  const wMed = medianOfSamples(widths, n);
  const radius = Math.max(1, Math.round(wMed / 2));
  return radius;
}

/*
  在 outputData 上“盖一个圆形笔刷点”（disk stamp）。
  - radius：半径
  - hardness01：硬度（1=硬边，0=软边）
  - color：要画的颜色/透明度
  - selectionMask：只在选区内写
*/
function stampDisk(
  outputData: Uint8Array,
  selectionMask: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  hardness01: number,
  color: { r: number; g: number; b: number; a: number },
  isBackgroundLayer: boolean
) {
  const r = Math.max(1, Math.round(radius));
  const x0 = clampInt(cx - r, 0, width - 1);
  const x1 = clampInt(cx + r, 0, width - 1);
  const y0 = clampInt(cy - r, 0, height - 1);
  const y1 = clampInt(cy + r, 0, height - 1);

  const hard = clamp01(hardness01);
  const invSoft = 1 / Math.max(1e-6, 1 - hard);
  const r2 = r * r;

  for (let y = y0; y <= y1; y++) {
    const rowBase = y * width;
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const idx = rowBase + x;
      if ((selectionMask[idx] || 0) === 0) continue;

      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;

      const d = Math.sqrt(d2) / r;
      const aa = d <= hard ? 1 : (1 - (d - hard) * invSoft);
      const cover = clamp01(aa);
      if (cover <= 0) continue;

      const p = idx * 4;
      if (isBackgroundLayer) {
        const oR = outputData[p] || 0;
        const oG = outputData[p + 1] || 0;
        const oB = outputData[p + 2] || 0;
        outputData[p] = Math.round(oR * (1 - cover) + color.r * cover);
        outputData[p + 1] = Math.round(oG * (1 - cover) + color.g * cover);
        outputData[p + 2] = Math.round(oB * (1 - cover) + color.b * cover);
        outputData[p + 3] = 255;
        continue;
      }

      const oA = outputData[p + 3] || 0;
      const oR = outputData[p] || 0;
      const oG = outputData[p + 1] || 0;
      const oB = outputData[p + 2] || 0;

      const srcA = (color.a / 255) * cover;
      const dstA = oA / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 1e-6) {
        outputData[p] = 0;
        outputData[p + 1] = 0;
        outputData[p + 2] = 0;
        outputData[p + 3] = 0;
        continue;
      }
      const outR = (color.r * srcA + oR * dstA * (1 - srcA)) / outA;
      const outG = (color.g * srcA + oG * dstA * (1 - srcA)) / outA;
      const outB = (color.b * srcA + oB * dstA * (1 - srcA)) / outA;

      outputData[p] = Math.round(clampInt(outR, 0, 255));
      outputData[p + 1] = Math.round(clampInt(outG, 0, 255));
      outputData[p + 2] = Math.round(clampInt(outB, 0, 255));
      outputData[p + 3] = Math.round(clampInt(outA * 255, 0, 255));
    }
  }
}

/*
  把一条 polyline 光栅化到 outputData：
  - 把折线每一段按像素步进采样
  - 每个采样点调用 stampDisk 画一个圆形笔刷
*/
function rasterizeStroke(
  outputData: Uint8Array,
  selectionMask: Uint8Array,
  width: number,
  height: number,
  polyline: Array<{ x: number; y: number }>,
  radius: number,
  hardness01: number,
  color: { r: number; g: number; b: number; a: number },
  isBackgroundLayer: boolean
) {
  if (polyline.length < 2) return;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const steps = Math.max(1, Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(a.x + dx * t);
      const y = Math.round(a.y + dy * t);
      stampDisk(outputData, selectionMask, width, height, x, y, radius, hardness01, color, isBackgroundLayer);
    }
  }
}

/*
  在选区里“找主线条”：
  - 用 (当前亮度 - 背景亮度) 的差异 + 梯度强度，得到候选线条像素（strokeMask）
  - 在候选像素里做连通域搜索，挑出最像主线条的一块（面积大且平均差异大）
  返回：
    indices：主线条像素索引列表
    avgDiff：主线条像素和背景的平均差异（用于调节回写力度）
*/
function extractMainStrokeComponent(
  lumaP: Uint8Array,
  bgLuma: Uint8Array,
  gradMag: Uint16Array,
  selectionMask: Uint8Array,
  pixelData: Uint8Array,
  alpha: Uint8Array,
  bgAlpha: Uint8Array | null,
  width: number,
  height: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  edgeThreshold: number,
  isBackgroundLayer: boolean
) {
  const pixelCount = width * height;
  const strokeMask = new Uint8Array(pixelCount);
  const diffHist = new Uint32Array(256);
  let nSel = 0;

  for (let y = bounds.y0; y <= bounds.y1; y++) {
    const rowBase = y * width;
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const idx = rowBase + x;
      if ((selectionMask[idx] || 0) === 0) continue;
      if (!isBackgroundLayer) {
        const a = pixelData[idx * 4 + 3] || 0;
        if (a < 16) continue;
      }
      const dL = Math.abs((lumaP[idx] || 0) - (bgLuma[idx] || 0)) & 255;
      const dA = (!isBackgroundLayer && bgAlpha) ? (Math.abs((alpha[idx] || 0) - (bgAlpha[idx] || 0)) & 255) : 0;
      const d = dA > dL ? dA : dL;
      diffHist[d]++;
      nSel++;
    }
  }

  const getDiffPercentile = (p01: number) => {
    if (nSel <= 0) return 0;
    const target = Math.max(0, Math.min(nSel - 1, Math.round(p01 * (nSel - 1))));
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += diffHist[i] || 0;
      if (acc > target) return i;
    }
    return 255;
  };

  const diffThr = Math.max(10, Math.min(80, getDiffPercentile(0.86)));
  const gThr = Math.max(10, edgeThreshold * 0.65);

  for (let y = bounds.y0; y <= bounds.y1; y++) {
    const rowBase = y * width;
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const idx = rowBase + x;
      if ((selectionMask[idx] || 0) === 0) continue;
      const dL = Math.abs((lumaP[idx] || 0) - (bgLuma[idx] || 0)) & 255;
      const dA = (!isBackgroundLayer && bgAlpha) ? (Math.abs((alpha[idx] || 0) - (bgAlpha[idx] || 0)) & 255) : 0;
      const d = dA > dL ? dA : dL;
      if (d < diffThr) continue;
      const gL = gradMag[idx] || 0;
      let gA = 0;
      if (!isBackgroundLayer && bgAlpha && x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
        const idxL = idx - 1;
        const idxR = idx + 1;
        const idxU = idx - width;
        const idxD = idx + width;
        const gxA = (alpha[idxR] || 0) - (alpha[idxL] || 0);
        const gyA = (alpha[idxD] || 0) - (alpha[idxU] || 0);
        gA = Math.min(2047, Math.abs(gxA) + Math.abs(gyA));
      }
      if ((gL >= gThr ? gL : gA) < gThr) continue;
      strokeMask[idx] = 255;
    }
  }

  const visited = new Uint8Array(pixelCount);
  let bestScore = 0;
  let bestIndices: number[] = [];
  let bestSumDiff = 0;

  const q: number[] = [];
  const comp: number[] = [];

  for (let y = bounds.y0; y <= bounds.y1; y++) {
    const rowBase = y * width;
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const seed = rowBase + x;
      if ((strokeMask[seed] || 0) === 0) continue;
      if ((visited[seed] || 0) !== 0) continue;

      q.length = 0;
      comp.length = 0;
      q.push(seed);
      visited[seed] = 1;

      let sumDiff = 0;
      while (q.length > 0) {
        const idx = q.pop() as number;
        comp.push(idx);
        sumDiff += Math.abs((lumaP[idx] || 0) - (bgLuma[idx] || 0));

        const ix = idx % width;
        const iy = (idx - ix) / width;
        const up = iy > bounds.y0 ? idx - width : -1;
        const down = iy < bounds.y1 ? idx + width : -1;
        const left = ix > bounds.x0 ? idx - 1 : -1;
        const right = ix < bounds.x1 ? idx + 1 : -1;

        if (up >= 0 && (strokeMask[up] || 0) !== 0 && (visited[up] || 0) === 0) { visited[up] = 1; q.push(up); }
        if (down >= 0 && (strokeMask[down] || 0) !== 0 && (visited[down] || 0) === 0) { visited[down] = 1; q.push(down); }
        if (left >= 0 && (strokeMask[left] || 0) !== 0 && (visited[left] || 0) === 0) { visited[left] = 1; q.push(left); }
        if (right >= 0 && (strokeMask[right] || 0) !== 0 && (visited[right] || 0) === 0) { visited[right] = 1; q.push(right); }
      }

      const size = comp.length;
      if (size < 64) continue;
      const avgDiff = sumDiff / size;
      const score = size * (avgDiff + 5);
      if (score > bestScore) {
        bestScore = score;
        bestSumDiff = sumDiff;
        bestIndices = comp.slice(0);
      }
    }
  }

  if (bestIndices.length <= 0) return null;

  return {
    indices: bestIndices,
    avgDiff: bestSumDiff / bestIndices.length,
    diffThr,
    gThr
  };
}

/*
  从主线条像素里估计“线条颜色”（用中位数更抗噪）。
  这里用的是磨平前的原始像素采样，保证线条回写时颜色不会被“磨平底图”冲淡。
*/
function estimateStrokeColor(
  pixelData: Uint8Array,
  indices: number[],
  width: number,
  isBackgroundLayer: boolean
) {
  const maxSamples = Math.min(1024, indices.length);
  const step = Math.max(1, Math.floor(indices.length / maxSamples));
  const sR = new Uint8Array(maxSamples);
  const sG = new Uint8Array(maxSamples);
  const sB = new Uint8Array(maxSamples);
  const sA = new Uint8Array(maxSamples);
  let n = 0;
  for (let i = 0; i < indices.length && n < maxSamples; i += step) {
    const idx = indices[i] || 0;
    const p = idx * 4;
    const r = pixelData[p] || 0;
    const g = pixelData[p + 1] || 0;
    const b = pixelData[p + 2] || 0;
    const a = isBackgroundLayer ? 255 : (pixelData[p + 3] || 0);
    if (!isBackgroundLayer && a > 0 && a < 250) {
      const mx = Math.max(r, g, b);
      if (mx <= a + 1) {
        const scale = 255 / a;
        sR[n] = clampInt(Math.round(r * scale), 0, 255);
        sG[n] = clampInt(Math.round(g * scale), 0, 255);
        sB[n] = clampInt(Math.round(b * scale), 0, 255);
      } else {
        sR[n] = r;
        sG[n] = g;
        sB[n] = b;
      }
      sA[n] = a;
    } else {
      sR[n] = r;
      sG[n] = g;
      sB[n] = b;
      sA[n] = a;
    }
    n++;
  }
  if (!isBackgroundLayer) {
    let maxA = 0;
    for (let i = 0; i < n; i++) {
      const a = sA[i] || 0;
      if (a > maxA) maxA = a;
    }

    const thr = Math.max(16, Math.round(maxA * 0.75));
    let m = 0;
    for (let i = 0; i < n; i++) {
      const a = sA[i] || 0;
      if (a < thr) continue;
      sR[m] = sR[i] || 0;
      sG[m] = sG[i] || 0;
      sB[m] = sB[i] || 0;
      sA[m] = a;
      m++;
    }

    if (m >= 8) {
      const k = Math.max(0, Math.min(m - 1, Math.floor((m - 1) * 0.85)));
      const a85 = selectKInPlace(sA, m, k);
      return {
        r: medianOfSamples(sR, m),
        g: medianOfSamples(sG, m),
        b: medianOfSamples(sB, m),
        a: a85
      };
    }
  }
  return {
    r: medianOfSamples(sR, n),
    g: medianOfSamples(sG, n),
    b: medianOfSamples(sB, n),
    a: isBackgroundLayer ? 255 : medianOfSamples(sA, n)
  };
}

/*
  主入口：对整张“文档尺寸”的像素数据做处理，返回同尺寸 RGBA ArrayBuffer。

  注意：
  - 像素输入/输出是“内存里的数组”，写回 Photoshop 图层由外部调用方负责。
  - ps 参数用于调用 Photoshop 原生滤镜（median）并读取处理后的像素结果。
*/
export async function processSmartEdgeSmooth(
  pixelDataBuffer: ArrayBuffer,
  selectionMaskBuffer: ArrayBuffer,
  dimensions: { width: number; height: number },
  _params: EdgeDetectionParams,
  isBackgroundLayer: boolean = false,
  ps?: PhotoshopContext,
  basePixelDataAfterMedianBuffer?: ArrayBuffer
): Promise<ArrayBuffer> {
  // 这个函数返回“完整文档尺寸”的像素数组（RGBA，背景图层也带 A=255），由调用方统一写回图层。
  const params = (_params || {}) as EdgeDetectionParams;
  const pixelData = new Uint8Array(pixelDataBuffer);
  const selectionMaskRaw = new Uint8Array(selectionMaskBuffer);
  const { width, height } = dimensions;
  const pixelCount = width * height;

  // selectionMaskRaw 可能是 0~255 的羽化值或透明度选区值。
  // 为避免“半透明选区几乎没效果”（值会被重复当成权重衰减），这里统一转成二值选区：
  // 只要 >0 就当作“在选区内”，值固定为 255。
  const selectionMask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    selectionMask[i] = (selectionMaskRaw[i] || 0) > 0 ? 255 : 0;
  }

  const outputData = new Uint8Array(pixelData.length);
  outputData.set(pixelData);

  const lumaP = new Uint8Array(pixelCount);
  const alpha = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const p = i * 4;
    const a = isBackgroundLayer ? 255 : (pixelData[p + 3] || 0);
    alpha[i] = a;
    const rP = (pixelData[p] * a + 127) / 255;
    const gP = (pixelData[p + 1] * a + 127) / 255;
    const bP = (pixelData[p + 2] * a + 127) / 255;
    lumaP[i] = lumaFromPremult(rP, gP, bP);
  }

  const sel = computeSelectionBounds(selectionMask, width, height);
  if (sel.maxX < 0) return outputData.buffer;

  const mode = params.mode || 'edge';
  const edgeMedianRadius = clampInt(Math.round(params.edgeMedianRadius ?? 16), 10, 30);
  const eraseMedianRadius = clampInt(Math.round(params.backgroundSmoothRadius ?? 16), 10, 30);
  const lineStrength = clamp01(params.lineStrength ?? 1);
  const lineWidthScale = Math.max(0.5, Math.min(2, params.lineWidthScale ?? 1));
  const lineHardness = clamp01(params.lineHardness ?? 1);

  const regionPad = Math.max(edgeMedianRadius + 2, eraseMedianRadius + 2);
  const bounds = {
    x0: clampInt(sel.minX - regionPad, 0, width - 1),
    y0: clampInt(sel.minY - regionPad, 0, height - 1),
    x1: clampInt(sel.maxX + regionPad, 0, width - 1),
    y1: clampInt(sel.maxY + regionPad, 0, height - 1)
  };
  const regionW = bounds.x1 - bounds.x0 + 1;
  const regionH = bounds.y1 - bounds.y0 + 1;
  const selectionInnerFadeWidth = clampInt(Math.round(Math.max(edgeMedianRadius, eraseMedianRadius) * 0.5), 2, 12);
  const selectionInnerFade = buildSelectionInnerFadeRegion(selectionMask, width, height, bounds, selectionInnerFadeWidth);

  const writeMedianIntoSelection = (regionRGBA: Uint8Array, baseRGBA: Uint8Array) => {
    if (regionW <= 0 || regionH <= 0) return;
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      const rowBase = y * width;
      const ry = y - bounds.y0;
      const regionRowBase = ry * regionW;
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        const idx = rowBase + x;
        if ((selectionMask[idx] || 0) === 0) continue;

        const rx = x - bounds.x0;
        const ri = regionRowBase + rx;
        const rp = ri * 4;
        const p = idx * 4;
        const fade01 = (selectionInnerFade[ri] || 0) / 255;
        const w = fade01;
        if (w <= 0.001) continue;

        const baseR = baseRGBA[p] || 0;
        const baseG = baseRGBA[p + 1] || 0;
        const baseB = baseRGBA[p + 2] || 0;
        const baseA = isBackgroundLayer ? 255 : (baseRGBA[p + 3] || 0);

        outputData[p] = Math.round(baseR * (1 - w) + (regionRGBA[rp] || 0) * w);
        outputData[p + 1] = Math.round(baseG * (1 - w) + (regionRGBA[rp + 1] || 0) * w);
        outputData[p + 2] = Math.round(baseB * (1 - w) + (regionRGBA[rp + 2] || 0) * w);
        outputData[p + 3] = isBackgroundLayer ? 255 : Math.round(baseA * (1 - w) + (regionRGBA[rp + 3] || 0) * w);
      }
    }
  };

  if (mode === 'edge') {
    const edgeRegion = ps ? await getMedianFilteredSelectionRegionRGBA(ps, bounds, edgeMedianRadius) : null;
    if (edgeRegion) {
      writeMedianIntoSelection(edgeRegion, pixelData);
    }
    return outputData.buffer;
  }

  const { gradMag, edgeThreshold, strongThreshold, selectedCount } = buildGradMagHistogram(lumaP, selectionMask, width, height);
  if (selectedCount <= 0) return outputData.buffer;

  const bgLuma = eraseMedianRadius > 0
    ? maskedBoxBlurLuma(lumaP, selectionMask, width, height, bounds, Math.max(0, Math.min(40, eraseMedianRadius)))
    : lumaP;

  const bgAlpha = (!isBackgroundLayer)
    ? maskedBoxBlurAlpha(alpha, selectionMask, width, height, bounds, Math.max(4, Math.round(Math.max(0, Math.min(40, eraseMedianRadius)) * 0.7)))
    : null;

  const mainStroke = extractMainStrokeComponent(
    lumaP,
    bgLuma,
    gradMag,
    selectionMask,
    pixelData,
    alpha,
    bgAlpha,
    width,
    height,
    bounds,
    edgeThreshold,
    isBackgroundLayer
  );

  const hasMainStroke = !!(mainStroke && mainStroke.indices.length >= 40);

  if (mode === 'line') {
    if (basePixelDataAfterMedianBuffer) {
      const base = new Uint8Array(basePixelDataAfterMedianBuffer);
      outputData.set(base);
      for (let y = bounds.y0; y <= bounds.y1; y++) {
        const rowBase = y * width;
        const ry = y - bounds.y0;
        const regionRowBase = ry * regionW;
        for (let x = bounds.x0; x <= bounds.x1; x++) {
          const idx = rowBase + x;
          if ((selectionMask[idx] || 0) === 0) continue;
          const rx = x - bounds.x0;
          const ri = regionRowBase + rx;
          const fade01 = (selectionInnerFade[ri] || 0) / 255;
          if (fade01 <= 0.001) continue;
          const p = idx * 4;
          outputData[p] = Math.round((pixelData[p] || 0) * (1 - fade01) + (base[p] || 0) * fade01);
          outputData[p + 1] = Math.round((pixelData[p + 1] || 0) * (1 - fade01) + (base[p + 1] || 0) * fade01);
          outputData[p + 2] = Math.round((pixelData[p + 2] || 0) * (1 - fade01) + (base[p + 2] || 0) * fade01);
          if (isBackgroundLayer) {
            outputData[p + 3] = 255;
          } else {
            outputData[p + 3] = Math.round((pixelData[p + 3] || 0) * (1 - fade01) + (base[p + 3] || 0) * fade01);
          }
        }
      }
    }

    if (hasMainStroke && mainStroke) {
      const v = estimateLineDirectionPCA(mainStroke.indices, width);
      const polylineRaw = buildSmoothedCenterline(mainStroke.indices, width, height, v);
      const polyline = chaikinSmoothPolyline(polylineRaw, 3, width, height);
      const strokeColor = estimateStrokeColor(pixelData, mainStroke.indices, width, isBackgroundLayer);

      const approxLen = Math.max(8, polyline.length);
      const baseRadius = estimateStrokeRadiusFromMask(mainStroke.indices, width, height, v);
      const radius = clampInt(Math.round(baseRadius * lineWidthScale), 1, 48);

      let sumG = 0;
      for (let i = 0; i < mainStroke.indices.length; i += Math.max(1, Math.floor(mainStroke.indices.length / 2048))) {
        sumG += gradMag[mainStroke.indices[i] || 0] || 0;
      }
      const avgG = sumG / Math.max(1, Math.min(2048, mainStroke.indices.length));
      const sharp01 = clamp01((avgG - edgeThreshold) / Math.max(1, strongThreshold - edgeThreshold));
      const hardness01 = clamp01((0.8 + 0.2 * sharp01) * (0.05 + 0.95 * lineHardness));

      const alphaBoost = clamp01(0.95 + 0.35 * (mainStroke.avgDiff / 40));
      const outStrokeA = isBackgroundLayer ? 255 : clampInt(Math.round(strokeColor.a * alphaBoost * lineStrength), 0, 255);
      const finalStrokeColor = { r: strokeColor.r, g: strokeColor.g, b: strokeColor.b, a: outStrokeA };

      rasterizeStroke(outputData, selectionMask, width, height, polyline, radius, hardness01, finalStrokeColor, isBackgroundLayer);
    }

    return outputData.buffer;
  }

  return outputData.buffer;
}

export const defaultSmartEdgeSmoothParams: EdgeDetectionParams = {
  alphaThreshold: 10,
  colorThreshold: 10,
  smoothRadius: 20,
  preserveDetail: true,
  intensity: 10,
  mode: 'edge',
  edgeMedianRadius: 16,
  backgroundSmoothRadius: 16,
  lineStrength: 1,
  lineWidthScale: 1,
  lineHardness: 1
};

