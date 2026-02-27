import { action, imaging } from 'photoshop';

/*
  这个文件实现「边缘平滑」功能，分成两种用户能理解的模式：

  1) 仅色块边界（edge）
     目标：让色块边界更干净、更“磨平”，但不要让用户看出选区边界。
     做法：用 Photoshop 自带的「中间值（median）」滤镜生成参考结果（读取后立即撤销），
           对整个选区写回 median 结果，并在选区边缘做渐隐，避免出现“选区边界感”。

  2) 仅主线条（line）
     目标：先把选区内杂线/噪点“磨平”，再对线条方向做平滑并写回去（不强求拟合成单根线条）。
     做法顺序：
       - 用 PS 的「中间值」把选区磨平（作为“干净底图”）
       - 在选区内估计线条方向场，沿方向做带保边缘权重的平滑
       - 把平滑后的结果写回“干净底图”
*/

/*
  边缘平滑的参数说明（面板上能调的是其中一部分）：
  - mode:
      edge：仅色块边界
      line：仅主线条
  - edgeMedianRadius：色块边界的中间值半径（PS median 半径）
  - backgroundSmoothRadius：主线条模式里用于“先磨平”的中间值半径（PS median 半径）
  - lineSmoothStrength/lineSmoothRadius/linePreserveDetail：主线条方向平滑的力度、范围、保细节
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
  lineSmoothStrength?: number;
  lineSmoothRadius?: number;
  linePreserveDetail?: number;
  lineStrength?: number;
  lineWidthScale?: number;
  lineHardness?: number;
}

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

  return { gradMag, edgeThreshold, selectedCount };
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
function buildStrokeEdgeMaskInBounds(
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
  const regionW = bounds.x1 - bounds.x0 + 1;
  const regionH = bounds.y1 - bounds.y0 + 1;
  const regionSize = regionW * regionH;

  const diffHist = new Uint32Array(256);
  let nSel = 0;

  for (let y = bounds.y0; y <= bounds.y1; y++) {
    const rowBase = y * width;
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const idx = rowBase + x;
      if ((selectionMask[idx] || 0) === 0) continue;
      if (!isBackgroundLayer) {
        const a = pixelData[idx * 4 + 3] || 0;
        if (a <= 0) continue;
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

  const diffThr = Math.max(8, Math.min(80, getDiffPercentile(0.82)));
  const gThr = Math.max(8, edgeThreshold * 0.55);

  const edgeMask = new Uint8Array(regionSize);
  let count = 0;

  for (let y = bounds.y0; y <= bounds.y1; y++) {
    const rowBase = y * width;
    const ry = y - bounds.y0;
    const base = ry * regionW;
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

      const rx = x - bounds.x0;
      edgeMask[base + rx] = 255;
      count++;
    }
  }

  return { edgeMask, diffThr, gThr, count, regionW, regionH };
}

function dilateMask8(mask: Uint8Array, regionW: number, regionH: number, iterations: number) {
  if (iterations <= 0) return mask;
  let src = mask;
  let dst = new Uint8Array(src.length);

  for (let it = 0; it < iterations; it++) {
    dst.fill(0);
    for (let y = 0; y < regionH; y++) {
      const rowBase = y * regionW;
      for (let x = 0; x < regionW; x++) {
        const i = rowBase + x;
        if ((src[i] || 0) !== 0) {
          dst[i] = 255;
          continue;
        }
        let hit = false;
        const y0 = y > 0 ? y - 1 : y;
        const y1 = y + 1 < regionH ? y + 1 : y;
        const x0 = x > 0 ? x - 1 : x;
        const x1 = x + 1 < regionW ? x + 1 : x;
        for (let yy = y0; yy <= y1 && !hit; yy++) {
          const base = yy * regionW;
          for (let xx = x0; xx <= x1; xx++) {
            if ((src[base + xx] || 0) !== 0) { hit = true; break; }
          }
        }
        if (hit) dst[i] = 255;
      }
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return src;
}

function buildGaussianLut256(sigma: number) {
  const s = Math.max(1e-3, sigma);
  const denom = 2 * s * s;
  const lut = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    const w = Math.exp(-(i * i) / denom);
    lut[i] = clampInt(Math.round(w * 1024), 0, 1024);
  }
  return lut;
}

function quantizeStepFromVector(vx: number, vy: number) {
  const ax = Math.abs(vx);
  const ay = Math.abs(vy);
  if (ax < 1e-6 && ay < 1e-6) return { dx: 1 as -1 | 0 | 1, dy: 0 as -1 | 0 | 1 };
  const sx = vx >= 0 ? 1 : -1;
  const sy = vy >= 0 ? 1 : -1;
  if (ay * 2 <= ax) return { dx: sx as any, dy: 0 as any };
  if (ax * 2 <= ay) return { dx: 0 as any, dy: sy as any };
  return { dx: sx as any, dy: sy as any };
}

function estimateDirectionFromMaskPCA(mask: Uint8Array, regionW: number, regionH: number) {
  let meanX = 0;
  let meanY = 0;
  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  let n = 0;

  for (let y = 0; y < regionH; y++) {
    const base = y * regionW;
    for (let x = 0; x < regionW; x++) {
      if ((mask[base + x] || 0) === 0) continue;
      n++;
      const dx = x - meanX;
      meanX += dx / n;
      const dy = y - meanY;
      meanY += dy / n;
      cxx += dx * (x - meanX);
      cyy += dy * (y - meanY);
      cxy += dx * (y - meanY);
    }
  }

  if (n <= 1) return { x: 1, y: 0 };

  const sxx = cxx;
  const syy = cyy;
  const sxy = cxy;
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

function applyLineDirectionalSmoothInBounds(
  outputData: Uint8Array,
  pixelData: Uint8Array,
  selectionMask: Uint8Array,
  selectionInnerFade: Uint8Array,
  lumaP: Uint8Array,
  bgLuma: Uint8Array,
  gradMag: Uint16Array,
  alpha: Uint8Array,
  bgAlpha: Uint8Array | null,
  width: number,
  height: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  isBackgroundLayer: boolean,
  edgeThreshold: number,
  smoothStrength01: number,
  smoothRadiusPx: number,
  preserveDetail01: number
) {
  const regionW = bounds.x1 - bounds.x0 + 1;
  const regionH = bounds.y1 - bounds.y0 + 1;
  const regionSize = regionW * regionH;

  const { edgeMask } = buildStrokeEdgeMaskInBounds(
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

  const dilateIters = clampInt(Math.round(Math.max(2, Math.min(6, smoothRadiusPx * 0.35))), 2, 6);
  const strokeMask = dilateMask8(edgeMask, regionW, regionH, dilateIters);

  let strokeCount = 0;
  for (let i = 0; i < regionSize; i++) {
    if ((strokeMask[i] || 0) !== 0) strokeCount++;
  }
  if (strokeCount <= 0) return;

  const guideRadius = clampInt(Math.round(Math.max(4, Math.min(12, smoothRadiusPx * 0.4))), 4, 12);
  const dirGuide = isBackgroundLayer
    ? maskedBoxBlurLuma(lumaP, selectionMask, width, height, bounds, guideRadius)
    : maskedBoxBlurAlpha(alpha, selectionMask, width, height, bounds, guideRadius);
  const simGuide = isBackgroundLayer ? lumaP : alpha;

  const vGlobal = estimateDirectionFromMaskPCA(strokeMask, regionW, regionH);
  const globalStep = quantizeStepFromVector(vGlobal.x, vGlobal.y);

  const stepX = new Int8Array(regionSize);
  const stepY = new Int8Array(regionSize);

  for (let y = 0; y < regionH; y++) {
    const docY = bounds.y0 + y;
    const base = y * regionW;
    for (let x = 0; x < regionW; x++) {
      const ri = base + x;
      if ((strokeMask[ri] || 0) === 0) continue;
      const docX = bounds.x0 + x;
      const cx = docX;
      const cy = docY;

      const xm1 = cx > 0 ? cx - 1 : cx;
      const xp1 = cx + 1 < width ? cx + 1 : cx;
      const ym1 = cy > 0 ? cy - 1 : cy;
      const yp1 = cy + 1 < height ? cy + 1 : cy;

      const a00 = dirGuide[ym1 * width + xm1] || 0;
      const a10 = dirGuide[ym1 * width + cx] || 0;
      const a20 = dirGuide[ym1 * width + xp1] || 0;
      const a01 = dirGuide[cy * width + xm1] || 0;
      const a21 = dirGuide[cy * width + xp1] || 0;
      const a02 = dirGuide[yp1 * width + xm1] || 0;
      const a12 = dirGuide[yp1 * width + cx] || 0;
      const a22 = dirGuide[yp1 * width + xp1] || 0;

      const gx = (a20 + 2 * a21 + a22) - (a00 + 2 * a01 + a02);
      const gy = (a02 + 2 * a12 + a22) - (a00 + 2 * a10 + a20);
      const tx = -gy;
      const ty = gx;
      const mag = Math.abs(tx) + Math.abs(ty);

      if (mag < 24) {
        stepX[ri] = globalStep.dx;
        stepY[ri] = globalStep.dy;
      } else {
        const q = quantizeStepFromVector(tx, ty);
        stepX[ri] = q.dx;
        stepY[ri] = q.dy;
      }
    }
  }

  const s = clamp01(smoothStrength01);
  if (s <= 0.001) return;

  const iterations = clampInt(Math.round(2 + s * 4), 2, 6);
  const sigma = 10 + (1 - clamp01(preserveDetail01)) * 70;
  const simLut = buildGaussianLut256(sigma);

  const d3 = clampInt(Math.round(Math.max(2, Math.min(24, smoothRadiusPx))), 2, 24);
  const d2 = clampInt(Math.round(d3 * 0.66), 1, d3);
  const d1 = clampInt(Math.round(d3 * 0.33), 1, d2);
  const dist: number[] = [];
  dist.push(d1);
  if (d2 !== d1) dist.push(d2);
  if (d3 !== d2) dist.push(d3);

  const w0 = 512;
  const w1 = 256;
  const w2 = 128;
  const w3 = 64;

  const srcR0 = new Uint8Array(regionSize);
  const srcG0 = new Uint8Array(regionSize);
  const srcB0 = new Uint8Array(regionSize);
  const srcA0 = new Uint8Array(regionSize);

  for (let y = 0; y < regionH; y++) {
    const docY = bounds.y0 + y;
    const rowBase = docY * width;
    const base = y * regionW;
    for (let x = 0; x < regionW; x++) {
      const ri = base + x;
      const docX = bounds.x0 + x;
      const idx = rowBase + docX;
      if ((selectionMask[idx] || 0) === 0) continue;
      const p = idx * 4;
      const a = isBackgroundLayer ? 255 : (pixelData[p + 3] || 0);
      srcA0[ri] = a;
      srcR0[ri] = Math.round(((pixelData[p] || 0) * a + 127) / 255);
      srcG0[ri] = Math.round(((pixelData[p + 1] || 0) * a + 127) / 255);
      srcB0[ri] = Math.round(((pixelData[p + 2] || 0) * a + 127) / 255);
    }
  }

  let curR = srcR0;
  let curG = srcG0;
  let curB = srcB0;
  let curA = srcA0;

  let tmpR = new Uint8Array(regionSize);
  let tmpG = new Uint8Array(regionSize);
  let tmpB = new Uint8Array(regionSize);
  let tmpA = new Uint8Array(regionSize);

  for (let it = 0; it < iterations; it++) {
    tmpR.set(curR);
    tmpG.set(curG);
    tmpB.set(curB);
    tmpA.set(curA);

    for (let y = 0; y < regionH; y++) {
      const base = y * regionW;
      for (let x = 0; x < regionW; x++) {
        const ri = base + x;
        if ((strokeMask[ri] || 0) === 0) continue;
        const dx = stepX[ri] | 0;
        const dy = stepY[ri] | 0;
        if (dx === 0 && dy === 0) continue;

        const g0 = simGuide[(bounds.y0 + y) * width + (bounds.x0 + x)] || 0;

        let sumW = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumA = 0;

        // 对中心像素也使用 Alpha 权重，保证逻辑一致性。
        // w0 * 1024 是基础权重，我们将其与 curA[ri] 结合。
        // 为了避免溢出，可以先 >> 4 或 >> 8。
        // wCenterBase = 512 * 1024 = 524288。
        // curA = 255. Product = 1.3e8. Fits in Int32.
        
        const centerA = curA[ri] || 0;
        const wCenterBase = w0 * 1024;
        const wCenter = (wCenterBase * (isBackgroundLayer ? 255 : centerA)) >> 8;
        
        if (wCenter > 0) {
          sumW += wCenter;
          sumR += (curR[ri] || 0) * wCenter;
          sumG += (curG[ri] || 0) * wCenter;
          sumB += (curB[ri] || 0) * wCenter;
          sumA += (curA[ri] || 0) * wCenter;
        }

        for (let k = 0; k < dist.length; k++) {
          const dd = dist[k] as number;
          const bw = k === 0 ? w1 : (k === 1 ? w2 : w3);
          const rx1 = x + dx * dd;
          const ry1 = y + dy * dd;
          if (rx1 >= 0 && rx1 < regionW && ry1 >= 0 && ry1 < regionH) {
            const rj = ry1 * regionW + rx1;
            if ((strokeMask[rj] || 0) !== 0) {
              const gj = simGuide[(bounds.y0 + ry1) * width + (bounds.x0 + rx1)] || 0;
              const sim = simLut[Math.abs(gj - g0) & 255] || 0;
              // 引入 Alpha 权重：防止透明像素拉低平均值
              const aj = isBackgroundLayer ? 255 : (curA[rj] || 0);
              const w = (bw * sim * aj) >> 8;
              if (w > 0) {
                sumW += w;
                sumR += (curR[rj] || 0) * w;
                sumG += (curG[rj] || 0) * w;
                sumB += (curB[rj] || 0) * w;
                sumA += (curA[rj] || 0) * w;
              }
            }
          }
          const rx2 = x - dx * dd;
          const ry2 = y - dy * dd;
          if (rx2 >= 0 && rx2 < regionW && ry2 >= 0 && ry2 < regionH) {
            const rj = ry2 * regionW + rx2;
            if ((strokeMask[rj] || 0) !== 0) {
              const gj = simGuide[(bounds.y0 + ry2) * width + (bounds.x0 + rx2)] || 0;
              const sim = simLut[Math.abs(gj - g0) & 255] || 0;
              const aj = isBackgroundLayer ? 255 : (curA[rj] || 0);
              const w = (bw * sim * aj) >> 8;
              if (w > 0) {
                sumW += w;
                sumR += (curR[rj] || 0) * w;
                sumG += (curG[rj] || 0) * w;
                sumB += (curB[rj] || 0) * w;
                sumA += (curA[rj] || 0) * w;
              }
            }
          }
        }

        if (sumW <= 0) continue;
        tmpR[ri] = clampInt(Math.round(sumR / sumW), 0, 255);
        tmpG[ri] = clampInt(Math.round(sumG / sumW), 0, 255);
        tmpB[ri] = clampInt(Math.round(sumB / sumW), 0, 255);
        tmpA[ri] = clampInt(Math.round(sumA / sumW), 0, 255);
      }
    }

    const swapR = curR; curR = tmpR; tmpR = swapR;
    const swapG = curG; curG = tmpG; tmpG = swapG;
    const swapB = curB; curB = tmpB; tmpB = swapB;
    const swapA = curA; curA = tmpA; tmpA = swapA;
  }

  const mixQ = clampInt(Math.round(s * 256), 0, 256);

  for (let y = 0; y < regionH; y++) {
    const docY = bounds.y0 + y;
    const rowBase = docY * width;
    const base = y * regionW;
    for (let x = 0; x < regionW; x++) {
      const ri = base + x;
      if ((strokeMask[ri] || 0) === 0) continue;
      const docX = bounds.x0 + x;
      const idx = rowBase + docX;
      if ((selectionMask[idx] || 0) === 0) continue;

      const fade01 = (selectionInnerFade[ri] || 0) / 255;
      if (fade01 <= 0.001) continue;

      const or = srcR0[ri] || 0;
      const og = srcG0[ri] || 0;
      const ob = srcB0[ri] || 0;
      const oa = srcA0[ri] || 0;

      const sr = curR[ri] || 0;
      const sg = curG[ri] || 0;
      const sb = curB[ri] || 0;
      const sa = curA[ri] || 0;

      // 如果 smoothStrength 很高，应该更多地使用 smooth result (sr/sg/sb/sa)
      // mixQ 是基于 smoothStrength 的。
      // 但之前的逻辑里，mixQ 只在 (pr, pg, pb, pa) 的计算中用到。
      // 而后面又和 original 做了一次基于 fade01 的混合。
      
      // 我们希望在选区中心 (fade01 ~ 1) 的地方，结果尽可能平滑。
      // 所以 mixQ 应该足够大。
      
      const pr = ((or * (256 - mixQ) + sr * mixQ + 128) >> 8) & 255;
      const pg = ((og * (256 - mixQ) + sg * mixQ + 128) >> 8) & 255;
      const pb = ((ob * (256 - mixQ) + sb * mixQ + 128) >> 8) & 255;
      const pa = ((oa * (256 - mixQ) + sa * mixQ + 128) >> 8) & 255;

      const rawStrokeA = clampInt(Math.round(pa * fade01), 0, 255);
      const maxStrokeA = clampInt(Math.round(oa * fade01), 0, 255);
      const strokeA = rawStrokeA < maxStrokeA ? rawStrokeA : maxStrokeA;
      if (strokeA <= 0) continue;

      const prF = clampInt(Math.round(pr * strokeA / 255), 0, 255);
      const pgF = clampInt(Math.round(pg * strokeA / 255), 0, 255);
      const pbF = clampInt(Math.round(pb * strokeA / 255), 0, 255);

      const p = idx * 4;

      // 使用 Replacement 逻辑：
      // 最终颜色 = SmoothPixel * fade01 + OriginalPixel * (1 - fade01)
      // 但这里 strokeA 已经包含了 fade01 导致的 Alpha 衰减，以及 maxStrokeA 的限制。
      // 为了保证平滑过渡，我们应该以 fade01 作为混合权重。
      
      // 注意：pr, pg, pb, pa 是平滑后的结果（可能包含了 mixQ 的原图成分）。
      // strokeA 是平滑结果经过 fade01 和 maxLimit 后的最终 Alpha。
      
      // 如果我们直接把 (prF, pgF, pbF, strokeA) 写入，那就是替换。
      // 但是 prF 是基于 strokeA 的预乘。
      // strokeA = min(pa * fade01, oa * fade01)。
      // 这里的 fade01 实际上起到了“选区边缘渐隐”的作用。
      // 但如果 fade01 < 1，说明我们在选区边缘。
      // 在选区边缘，我们希望它是 OriginalPixel。
      // 现在的逻辑：strokeA 变小了。如果不混合 Original，那就是变透明了。
      // 所以必须混合 Original。
      
      // 混合公式：Out = Smooth * W + Original * (1 - W)
      // 这里 W 应该是 fade01。
      // 但 strokeA 已经被 fade01 乘过了。
      // 让我们回退一步：
      // SmoothPixel 是 (pr, pg, pb, pa)。
      // OriginalPixel 是 (or, og, ob, oa)。
      // 我们希望限制 SmoothPixel 的 Alpha 不超过 OriginalPixel 的 Alpha (maxLimit)。
      // let limitedSmoothA = min(pa, oa);
      // let limitedSmoothP = (pr, pg, pb) * (limitedSmoothA / pa);
      
      // 然后混合：
      // Out = LimitedSmooth * fade01 + Original * (1 - fade01)
      
      // 优化后的混合逻辑：
      // 我们希望保留线条区域的浓度（即使 pa > oa，只要 oa 足够大），同时防止背景区域（oa ~ 0）产生光晕。
      
      // 定义一个“信任平滑结果”的权重 trustSmooth。
      // 当 oa 很小时，trustSmooth -> 0，我们强制 limitedSmoothA <= oa。
      // 当 oa 较大时（比如 > 20），trustSmooth -> 1，我们允许 limitedSmoothA = pa。
      
      // 使用简单的线性过渡：
      // trust = clamp((oa - low) / (high - low))
      const trustSmooth = oa < 10 ? 0 : (oa > 40 ? 1 : (oa - 10) / 30);
      
      // 目标 Alpha：在 oa (强限制) 和 pa (无限制) 之间插值
      const constrainedA = pa < oa ? pa : oa; // 绝对安全的下限
      const targetSmoothA = constrainedA * (1 - trustSmooth) + pa * trustSmooth;
      
      const limitedSmoothA = clampInt(Math.round(targetSmoothA), 0, 255);
      
      // 如果 pa 非常小，避免除零
      const scale = pa > 0 ? limitedSmoothA / pa : 0;
      
      const lpr = clampInt(Math.round(pr * scale), 0, 255);
      const lpg = clampInt(Math.round(pg * scale), 0, 255);
      const lpb = clampInt(Math.round(pb * scale), 0, 255);
      
      // 原始像素（预乘）
      const srcP = idx * 4;
      const srcA = isBackgroundLayer ? 255 : (pixelData[srcP + 3] || 0);
      const srcR_P = clampInt(Math.round((pixelData[srcP] || 0) * srcA / 255), 0, 255);
      const srcG_P = clampInt(Math.round((pixelData[srcP + 1] || 0) * srcA / 255), 0, 255);
      const srcB_P = clampInt(Math.round((pixelData[srcP + 2] || 0) * srcA / 255), 0, 255);
      
      // 最终混合 (Lerp)
      const w = fade01;
      const outPR = clampInt(Math.round(lpr * w + srcR_P * (1 - w)), 0, 255);
      const outPG = clampInt(Math.round(lpg * w + srcG_P * (1 - w)), 0, 255);
      const outPB = clampInt(Math.round(lpb * w + srcB_P * (1 - w)), 0, 255);
      const outA = clampInt(Math.round(limitedSmoothA * w + srcA * (1 - w)), 0, 255);
      
      if (outA <= 0) {
        outputData[p] = 0;
        outputData[p + 1] = 0;
        outputData[p + 2] = 0;
        outputData[p + 3] = isBackgroundLayer ? 255 : 0;
        continue;
      }

      outputData[p] = clampInt(Math.round((outPR * 255) / outA), 0, 255);
      outputData[p + 1] = clampInt(Math.round((outPG * 255) / outA), 0, 255);
      outputData[p + 2] = clampInt(Math.round((outPB * 255) / outA), 0, 255);
      outputData[p + 3] = isBackgroundLayer ? 255 : clampInt(outA, 0, 255);
    }
  }
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
  const lineSmoothStrength = clamp01(params.lineSmoothStrength ?? params.lineStrength ?? 1);
  const lineSmoothRadius = clampInt(Math.round(params.lineSmoothRadius ?? (Math.max(0.5, Math.min(2, params.lineWidthScale ?? 1)) * 8)), 2, 24);
  const linePreserveDetail = clamp01(params.linePreserveDetail ?? params.lineHardness ?? 1);

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

  const { gradMag, edgeThreshold, selectedCount } = buildGradMagHistogram(lumaP, selectionMask, width, height);
  if (selectedCount <= 0) return outputData.buffer;

  const bgLuma = eraseMedianRadius > 0
    ? maskedBoxBlurLuma(lumaP, selectionMask, width, height, bounds, Math.max(0, Math.min(40, eraseMedianRadius)))
    : lumaP;

  const bgAlpha = (!isBackgroundLayer)
    ? maskedBoxBlurAlpha(alpha, selectionMask, width, height, bounds, Math.max(4, Math.round(Math.max(0, Math.min(40, eraseMedianRadius)) * 0.7)))
    : null;

  if (mode === 'line') {
    applyLineDirectionalSmoothInBounds(
      outputData,
      pixelData,
      selectionMask,
      selectionInnerFade,
      lumaP,
      bgLuma,
      gradMag,
      alpha,
      bgAlpha,
      width,
      height,
      bounds,
      isBackgroundLayer,
      edgeThreshold,
      lineSmoothStrength,
      lineSmoothRadius,
      linePreserveDetail
    );

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
  lineSmoothStrength: 0.85,
  lineSmoothRadius: 10,
  linePreserveDetail: 0.7,
  lineStrength: 1,
  lineWidthScale: 1,
  lineHardness: 1
};

