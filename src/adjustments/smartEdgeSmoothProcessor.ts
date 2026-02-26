interface EdgeDetectionParams {
  alphaThreshold?: number;
  colorThreshold?: number;
  smoothRadius?: number;
  preserveDetail?: boolean;
  intensity?: number;
  mode?: 'auto' | 'edge' | 'line';
  edgeMedianRadius?: number;
  edgeMedianStrength?: number;
  backgroundSmoothRadius?: number;
  lineStrength?: number;
  lineWidthScale?: number;
  lineHardness?: number;
}

type Vec2 = { x: number; y: number };

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));
const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));

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

function medianOfSamples(samples: Uint8Array, n: number): number {
  if (n <= 0) return 0;
  const k = (n - 1) >> 1;
  return selectKInPlace(samples, n, k);
}

function lumaFromPremult(rP: number, gP: number, bP: number): number {
  return (77 * rP + 150 * gP + 29 * bP + 128) >> 8;
}

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

function buildEdgeBandMask(
  selectionMask: Uint8Array,
  gradMag: Uint16Array,
  width: number,
  height: number,
  edgeThreshold: number
) {
  const pixelCount = width * height;
  const edgeMask = new Uint8Array(pixelCount);
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      if ((selectionMask[idx] || 0) === 0) continue;
      let edge = (gradMag[idx] || 0) >= edgeThreshold;
      if (!edge) {
        const up = y > 0 ? idx - width : -1;
        const down = y + 1 < height ? idx + width : -1;
        const left = x > 0 ? idx - 1 : -1;
        const right = x + 1 < width ? idx + 1 : -1;
        if (up >= 0 && (selectionMask[up] || 0) === 0) edge = true;
        else if (down >= 0 && (selectionMask[down] || 0) === 0) edge = true;
        else if (left >= 0 && (selectionMask[left] || 0) === 0) edge = true;
        else if (right >= 0 && (selectionMask[right] || 0) === 0) edge = true;
      }
      if (edge) edgeMask[idx] = 255;
    }
  }
  return edgeMask;
}

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
      const m = selectionMask[idx] || 0;
      if (m === 0) continue;

      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;

      const d = Math.sqrt(d2) / r;
      const aa = d <= hard ? 1 : (1 - (d - hard) * invSoft);
      const cover = clamp01(aa) * (m / 255);
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

function medianSmoothAt(
  pixelData: Uint8Array,
  selectionMask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
  step: number,
  isBackgroundLayer: boolean,
  outR: Uint8Array,
  outG: Uint8Array,
  outB: Uint8Array,
  outA: Uint8Array
) {
  const samplesR = outR;
  const samplesG = outG;
  const samplesB = outB;
  const samplesA = outA;

  let n = 0;
  const x0 = clampInt(x - radius, 0, width - 1);
  const x1 = clampInt(x + radius, 0, width - 1);
  const y0 = clampInt(y - radius, 0, height - 1);
  const y1 = clampInt(y + radius, 0, height - 1);

  for (let yy = y0; yy <= y1; yy += step) {
    const rowBase = yy * width;
    for (let xx = x0; xx <= x1; xx += step) {
      const idx = rowBase + xx;
      if ((selectionMask[idx] || 0) === 0) continue;
      const p = idx * 4;
      samplesR[n] = pixelData[p] || 0;
      samplesG[n] = pixelData[p + 1] || 0;
      samplesB[n] = pixelData[p + 2] || 0;
      samplesA[n] = isBackgroundLayer ? 255 : (pixelData[p + 3] || 0);
      n++;
      if (n >= samplesR.length) return null;
    }
  }

  if (n < 9) return null;
  return {
    r: medianOfSamples(samplesR, n),
    g: medianOfSamples(samplesG, n),
    b: medianOfSamples(samplesB, n),
    a: isBackgroundLayer ? 255 : medianOfSamples(samplesA, n)
  };
}

function extractMainStrokeComponent(
  lumaP: Uint8Array,
  bgLuma: Uint8Array,
  gradMag: Uint16Array,
  selectionMask: Uint8Array,
  pixelData: Uint8Array,
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
      const d = Math.abs((lumaP[idx] || 0) - (bgLuma[idx] || 0)) & 255;
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
      const d = Math.abs((lumaP[idx] || 0) - (bgLuma[idx] || 0)) & 255;
      if (d < diffThr) continue;
      if ((gradMag[idx] || 0) < gThr) continue;
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
    sR[n] = pixelData[p] || 0;
    sG[n] = pixelData[p + 1] || 0;
    sB[n] = pixelData[p + 2] || 0;
    sA[n] = isBackgroundLayer ? 255 : (pixelData[p + 3] || 0);
    n++;
  }
  return {
    r: medianOfSamples(sR, n),
    g: medianOfSamples(sG, n),
    b: medianOfSamples(sB, n),
    a: isBackgroundLayer ? 255 : medianOfSamples(sA, n)
  };
}

export async function processSmartEdgeSmooth(
  pixelDataBuffer: ArrayBuffer,
  selectionMaskBuffer: ArrayBuffer,
  dimensions: { width: number; height: number },
  _params: EdgeDetectionParams,
  isBackgroundLayer: boolean = false
): Promise<ArrayBuffer> {
  const params = (_params || {}) as EdgeDetectionParams;
  const pixelData = new Uint8Array(pixelDataBuffer);
  const selectionMask = new Uint8Array(selectionMaskBuffer);
  const { width, height } = dimensions;
  const pixelCount = width * height;

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

  const mode = params.mode || 'auto';
  const edgeMedianRadius = clampInt(Math.round(params.edgeMedianRadius ?? 20), 4, 40);
  const edgeMedianStrength = clamp01(params.edgeMedianStrength ?? 1);
  const bgBlurRadius = clampInt(Math.round(params.backgroundSmoothRadius ?? 16), 0, 40);
  const lineStrength = clamp01(params.lineStrength ?? 1);
  const lineWidthScale = Math.max(0.5, Math.min(2, params.lineWidthScale ?? 1));
  const lineHardness = clamp01(params.lineHardness ?? 1);

  const regionPad = Math.max(edgeMedianRadius + 2, bgBlurRadius + 2);
  const bounds = {
    x0: clampInt(sel.minX - regionPad, 0, width - 1),
    y0: clampInt(sel.minY - regionPad, 0, height - 1),
    x1: clampInt(sel.maxX + regionPad, 0, width - 1),
    y1: clampInt(sel.maxY + regionPad, 0, height - 1)
  };

  const { gradMag, edgeThreshold, strongThreshold, selectedCount } = buildGradMagHistogram(lumaP, selectionMask, width, height);
  if (selectedCount <= 0) return outputData.buffer;

  const edgeBandMask = buildEdgeBandMask(selectionMask, gradMag, width, height, edgeThreshold);

  const bgLuma = bgBlurRadius > 0
    ? maskedBoxBlurLuma(lumaP, selectionMask, width, height, bounds, bgBlurRadius)
    : lumaP;
  const bgAlpha = (isBackgroundLayer || bgBlurRadius <= 0)
    ? null
    : maskedBoxBlurAlpha(alpha, selectionMask, width, height, bounds, Math.max(4, Math.round(bgBlurRadius * 0.7)));

  const mainStroke = extractMainStrokeComponent(
    lumaP,
    bgLuma,
    gradMag,
    selectionMask,
    pixelData,
    width,
    height,
    bounds,
    edgeThreshold,
    isBackgroundLayer
  );

  const hasMainStroke = !!(mainStroke && mainStroke.indices.length >= 180);

  if (mode !== 'edge' && hasMainStroke && mainStroke) {
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      const rowBase = y * width;
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        const idx = rowBase + x;
        const m = selectionMask[idx] || 0;
        if (m === 0) continue;

        const p = idx * 4;
        const oA = isBackgroundLayer ? 255 : (pixelData[p + 3] || 0);
        const oPremR = (pixelData[p] * oA + 127) / 255;
        const oPremG = (pixelData[p + 1] * oA + 127) / 255;
        const oPremB = (pixelData[p + 2] * oA + 127) / 255;
        const oL = lumaP[idx] || 0;
        const bL = bgLuma[idx] || oL;
        const ratio = bL / (oL + 1);

        if (isBackgroundLayer) {
          outputData[p] = clampInt(Math.round(pixelData[p] * ratio), 0, 255);
          outputData[p + 1] = clampInt(Math.round(pixelData[p + 1] * ratio), 0, 255);
          outputData[p + 2] = clampInt(Math.round(pixelData[p + 2] * ratio), 0, 255);
          outputData[p + 3] = 255;
          continue;
        }

        const bA = bgAlpha ? (bgAlpha[idx] || oA) : oA;
        const outA = clampInt(Math.round(oA * 0.4 + bA * 0.6), 0, 255);

        const outPremR = oPremR * ratio;
        const outPremG = oPremG * ratio;
        const outPremB = oPremB * ratio;

        if (outA <= 0) {
          outputData[p] = 0;
          outputData[p + 1] = 0;
          outputData[p + 2] = 0;
          outputData[p + 3] = 0;
          continue;
        }

        const invA = 255 / outA;
        outputData[p] = clampInt(Math.round(outPremR * invA), 0, 255);
        outputData[p + 1] = clampInt(Math.round(outPremG * invA), 0, 255);
        outputData[p + 2] = clampInt(Math.round(outPremB * invA), 0, 255);
        outputData[p + 3] = outA;
      }
    }

    const v = estimateLineDirectionPCA(mainStroke.indices, width);
    const polyline = buildSmoothedCenterline(mainStroke.indices, width, height, v);
    const strokeColor = estimateStrokeColor(pixelData, mainStroke.indices, width, isBackgroundLayer);

    const selArea = Math.max(1, (sel.maxX - sel.minX + 1) * (sel.maxY - sel.minY + 1));
    const approxLen = Math.max(8, polyline.length);
    const thickness = clampInt(Math.round(mainStroke.indices.length / approxLen), 1, 28);
    const radius = Math.max(1, Math.round((thickness / 2) * lineWidthScale));

    let sumG = 0;
    for (let i = 0; i < mainStroke.indices.length; i += Math.max(1, Math.floor(mainStroke.indices.length / 2048))) {
      sumG += gradMag[mainStroke.indices[i] || 0] || 0;
    }
    const avgG = sumG / Math.max(1, Math.min(2048, mainStroke.indices.length));
    const sharp01 = clamp01((avgG - edgeThreshold) / Math.max(1, strongThreshold - edgeThreshold));
    const hardness01 = clamp01((0.72 + 0.22 * sharp01) * (0.6 + 0.4 * lineHardness));

    const alphaBoost = clamp01(0.85 + 0.25 * (mainStroke.avgDiff / 40));
    const outStrokeA = isBackgroundLayer ? 255 : clampInt(Math.round(strokeColor.a * alphaBoost * lineStrength), 0, 255);
    const finalStrokeColor = { r: strokeColor.r, g: strokeColor.g, b: strokeColor.b, a: outStrokeA };

    rasterizeStroke(outputData, selectionMask, width, height, polyline, radius, hardness01, finalStrokeColor, isBackgroundLayer);

    const sampleCap = 1200;
    const samplesR = new Uint8Array(sampleCap);
    const samplesG = new Uint8Array(sampleCap);
    const samplesB = new Uint8Array(sampleCap);
    const samplesA = new Uint8Array(sampleCap);

    const edgeStep = 2;
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      const rowBase = y * width;
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        const idx = rowBase + x;
        if ((edgeBandMask[idx] || 0) === 0) continue;
        const g = gradMag[idx] || 0;
        const edge01 = clamp01((g - edgeThreshold) / Math.max(1, strongThreshold - edgeThreshold));
        if (edge01 <= 0.05) continue;
        const m = selectionMask[idx] || 0;
        if (m === 0) continue;

        const med = medianSmoothAt(
          outputData,
          selectionMask,
          width,
          height,
          x,
          y,
          edgeMedianRadius,
          edgeStep,
          isBackgroundLayer,
          samplesR,
          samplesG,
          samplesB,
          samplesA
        );
        if (!med) continue;

        const p = idx * 4;
        const w = edgeMedianStrength * clamp01(0.35 + 0.55 * edge01) * (m / 255);
        outputData[p] = Math.round((outputData[p] || 0) * (1 - w) + med.r * w);
        outputData[p + 1] = Math.round((outputData[p + 1] || 0) * (1 - w) + med.g * w);
        outputData[p + 2] = Math.round((outputData[p + 2] || 0) * (1 - w) + med.b * w);
        outputData[p + 3] = isBackgroundLayer ? 255 : Math.round((outputData[p + 3] || 0) * (1 - w) + med.a * w);
      }
    }

    return outputData.buffer;
  }

  const sampleCap = 1200;
  const samplesR = new Uint8Array(sampleCap);
  const samplesG = new Uint8Array(sampleCap);
  const samplesB = new Uint8Array(sampleCap);
  const samplesA = new Uint8Array(sampleCap);

  if (mode === 'line') {
    return outputData.buffer;
  }

  const edgeStep = 2;
  for (let y = bounds.y0; y <= bounds.y1; y++) {
    const rowBase = y * width;
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const idx = rowBase + x;
      const m = selectionMask[idx] || 0;
      if (m === 0) continue;
      if ((edgeBandMask[idx] || 0) === 0) continue;

      const g = gradMag[idx] || 0;
      const edge01 = clamp01((g - edgeThreshold) / Math.max(1, strongThreshold - edgeThreshold));
      const w = edgeMedianStrength * clamp01(0.2 + 0.75 * edge01) * (m / 255);
      if (w <= 0.01) continue;

      const yDoc = y;
      const xDoc = x;

      const med = medianSmoothAt(
        pixelData,
        selectionMask,
        width,
        height,
        xDoc,
        yDoc,
        edgeMedianRadius,
        edgeStep,
        isBackgroundLayer,
        samplesR,
        samplesG,
        samplesB,
        samplesA
      );
      if (!med) continue;

      const p = idx * 4;
      outputData[p] = Math.round((pixelData[p] || 0) * (1 - w) + med.r * w);
      outputData[p + 1] = Math.round((pixelData[p + 1] || 0) * (1 - w) + med.g * w);
      outputData[p + 2] = Math.round((pixelData[p + 2] || 0) * (1 - w) + med.b * w);
      outputData[p + 3] = isBackgroundLayer ? 255 : Math.round((pixelData[p + 3] || 0) * (1 - w) + med.a * w);
    }
  }

  return outputData.buffer;
}

export const defaultSmartEdgeSmoothParams: EdgeDetectionParams = {
  alphaThreshold: 10,
  colorThreshold: 10,
  smoothRadius: 20,
  preserveDetail: true,
  intensity: 10,
  mode: 'auto',
  edgeMedianRadius: 20,
  edgeMedianStrength: 1,
  backgroundSmoothRadius: 16,
  lineStrength: 1,
  lineWidthScale: 1,
  lineHardness: 1
};

