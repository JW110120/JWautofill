type DocSize = { width: number; height: number };
type Rect = { left: number; top: number; width: number; height: number };

export type BlockColorPatchParams = {
  maxDistance: number;
  lineSensitivity: number;
  lineGrow: number;
  emptyAlphaThreshold?: number;
  seedAlphaThreshold?: number;
  lineAlphaThreshold?: number;
};

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));

function normalizePixelsToRGBA(raw: Uint8Array, pixelCount: number): Uint8Array {
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

const packRGBA = (r: number, g: number, b: number, a: number) =>
  (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;
const unpackR = (p: number) => (p >>> 24) & 255;
const unpackG = (p: number) => (p >>> 16) & 255;
const unpackB = (p: number) => (p >>> 8) & 255;
const unpackA = (p: number) => p & 255;

const luminance8 = (r: number, g: number, b: number) => ((r * 54 + g * 183 + b * 19) / 256) | 0;

function computeAdaptiveLineThreshold(lineRGBA: Uint8Array, pixelCount: number, alphaThreshold: number, lineSensitivity: number): number {
  if (pixelCount <= 0) return clampInt(30 + clampInt(lineSensitivity, 1, 10) * 20, 30, 230);
  const stride = pixelCount > 800_000 ? 6 : (pixelCount > 200_000 ? 4 : 2);
  const hist = new Uint32Array(256);
  let cnt = 0;
  for (let i = 0; i < pixelCount; i += stride) {
    const p = i * 4;
    const a = lineRGBA[p + 3] || 0;
    if (a <= alphaThreshold) continue;
    const y = luminance8(lineRGBA[p] || 0, lineRGBA[p + 1] || 0, lineRGBA[p + 2] || 0);
    hist[y] += 1;
    cnt++;
  }
  if (cnt < 64) return clampInt(30 + clampInt(lineSensitivity, 1, 10) * 20, 30, 230);
  const target = Math.max(1, Math.floor(cnt * 0.35));
  let acc = 0;
  let q = 60;
  for (let y = 0; y < 256; y++) {
    acc += hist[y] || 0;
    if (acc >= target) {
      q = y;
      break;
    }
  }
  const sens = clampInt(Math.round(lineSensitivity || 6), 1, 10);
  const adjust = (sens - 6) * 6;
  return clampInt(q + 18 + adjust, 45, 210);
}

function dilateBinaryMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const size = w * h;
  const out = new Uint8Array(size);
  out.set(mask);

  const dist = new Uint16Array(size);
  dist.fill(0xffff);
  const q = new Uint32Array(size);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < size; i++) {
    if (out[i]) {
      dist[i] = 0;
      q[tail++] = i;
    }
  }
  if (tail === 0) return out;

  while (head < tail) {
    const i = q[head++] as number;
    const d = dist[i] as number;
    if (d >= radius) continue;
    const x = i % w;
    const y = (i - x) / w;
    const nd = d + 1;

    const push = (ni: number) => {
      if (dist[ni] !== 0xffff) return;
      dist[ni] = nd as any;
      out[ni] = 1;
      q[tail++] = ni;
    };

    if (x > 0) push(i - 1);
    if (x + 1 < w) push(i + 1);
    if (y > 0) push(i - w);
    if (y + 1 < h) push(i + w);
  }
  return out;
}

function erodeBinaryMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const size = w * h;
  const dist = new Uint16Array(size);
  dist.fill(0xffff);
  const q = new Uint32Array(size);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < size; i++) {
    if (!mask[i]) {
      dist[i] = 0;
      q[tail++] = i;
    }
  }

  while (head < tail) {
    const i = q[head++] as number;
    const d = dist[i] as number;
    if (d >= radius) continue;
    const x = i % w;
    const y = (i - x) / w;
    const nd = d + 1;

    const push = (ni: number) => {
      if (dist[ni] !== 0xffff) return;
      dist[ni] = nd as any;
      q[tail++] = ni;
    };

    if (x > 0) push(i - 1);
    if (x + 1 < w) push(i + 1);
    if (y > 0) push(i - w);
    if (y + 1 < h) push(i + w);
  }

  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = mask[i] && (dist[i] as number) > radius ? 1 : 0;
  }
  return out;
}

function closeBinaryMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const dilated = dilateBinaryMask(mask, w, h, radius);
  return erodeBinaryMask(dilated, w, h, radius);
}

function estimateBinaryMaskHalfWidth(mask: Uint8Array, w: number, h: number, cap: number): number {
  const size = w * h;
  if (size <= 0) return 1;
  const dist = new Uint8Array(size);
  dist.fill(255);
  const q = new Uint32Array(size);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < size; i++) {
    if (!mask[i]) {
      dist[i] = 0;
      q[tail++] = i;
    }
  }
  if (tail === 0) return clampInt(cap, 1, cap);

  while (head < tail) {
    const i = q[head++] as number;
    const d = dist[i] as number;
    if (d >= cap) continue;
    const x = i % w;
    const y = (i - x) / w;
    const nd = (d + 1) as any;
    const push = (ni: number) => {
      if ((dist[ni] as number) <= nd) return;
      dist[ni] = nd;
      q[tail++] = ni;
    };
    if (x > 0) push(i - 1);
    if (x + 1 < w) push(i + 1);
    if (y > 0) push(i - w);
    if (y + 1 < h) push(i + w);
  }

  let maxD = 1;
  for (let i = 0; i < size; i++) {
    if (!mask[i]) continue;
    const d = dist[i] as number;
    if (d !== 255 && d > maxD) maxD = d;
  }
  return clampInt(maxD, 1, cap);
}

function floodFillOutsideRegion(barrier: Uint8Array, w: number, h: number): Uint8Array {
  const size = w * h;
  const outside = new Uint8Array(size);
  const q = new Uint32Array(size);
  let head = 0;
  let tail = 0;

  const tryPush = (idx: number) => {
    if (outside[idx]) return;
    if (barrier[idx]) return;
    outside[idx] = 1;
    q[tail++] = idx;
  };

  for (let x = 0; x < w; x++) {
    tryPush(x);
    tryPush((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    tryPush(y * w);
    tryPush(y * w + (w - 1));
  }

  while (head < tail) {
    const i = q[head++] as number;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) tryPush(i - 1);
    if (x + 1 < w) tryPush(i + 1);
    if (y > 0) tryPush(i - w);
    if (y + 1 < h) tryPush(i + w);
  }
  return outside;
}

export async function processBlockColorPatch(
  colorLayerFullRGBA: ArrayBuffer,
  selectionMaskData: ArrayBuffer,
  docSize: DocSize,
  roi: Rect,
  lineRefPixelsRaw: ArrayBuffer,
  params: BlockColorPatchParams
): Promise<Uint8Array> {
  const base = new Uint8Array(colorLayerFullRGBA);
  const result = new Uint8Array(base.length);
  result.set(base);

  const { width: docW, height: docH } = docSize;
  const selectionMask = new Uint8Array(selectionMaskData);
  if (selectionMask.length !== docW * docH) return result;

  const maxDistance = clampInt(Math.round(params.maxDistance || 0), 0, 200);
  if (maxDistance <= 0) return result;

  const roiLeft = clampInt(Math.round(roi.left), 0, docW - 1);
  const roiTop = clampInt(Math.round(roi.top), 0, docH - 1);
  const roiW = clampInt(Math.round(roi.width), 1, docW - roiLeft);
  const roiH = clampInt(Math.round(roi.height), 1, docH - roiTop);

  const regionW = roiW;
  const regionH = roiH;
  const regionSize = regionW * regionH;

  const raw = new Uint8Array(lineRefPixelsRaw);
  const lineRGBA = normalizePixelsToRGBA(raw, regionSize);

  const lineSensitivity = clampInt(Math.round(params.lineSensitivity || 6), 1, 10);
  const lineGrow = clampInt(Math.round(params.lineGrow || 2), 0, 6);
  const emptyAlphaThreshold = clampInt(Math.round(params.emptyAlphaThreshold ?? 16), 0, 255);
  const seedAlphaThreshold = clampInt(Math.round(params.seedAlphaThreshold ?? 16), 0, 255);
  const lineAlphaThreshold = clampInt(Math.round(params.lineAlphaThreshold ?? 8), 0, 255);

  const barrier0 = new Uint8Array(regionSize);
  let alphaCount = 0;
  for (let i = 0; i < regionSize; i++) {
    const a = lineRGBA[i * 4 + 3] || 0;
    if (a > lineAlphaThreshold) alphaCount++;
  }
  const alphaCoverage = alphaCount / Math.max(1, regionSize);
  const effectiveLineAlphaThreshold = alphaCoverage < 0.22 ? 1 : lineAlphaThreshold;

  const adaptiveLineYThreshold = computeAdaptiveLineThreshold(lineRGBA, regionSize, effectiveLineAlphaThreshold, lineSensitivity);

  let lineCount = 0;
  if (alphaCoverage > 0.45) {
    const stride = regionSize > 800_000 ? 6 : (regionSize > 200_000 ? 4 : 2);
    const hist = new Uint32Array(256);
    let sampled = 0;
    for (let i = 0; i < regionSize; i += stride) {
      const p = i * 4;
      const a = lineRGBA[p + 3] || 0;
      if (a <= effectiveLineAlphaThreshold) continue;
      const y = luminance8(lineRGBA[p] || 0, lineRGBA[p + 1] || 0, lineRGBA[p + 2] || 0);
      hist[y] += 1;
      sampled++;
    }
    let bgY = 255;
    if (sampled > 0) {
      let best = 0;
      for (let y = 0; y < 256; y++) {
        const c = hist[y] || 0;
        if (c > best) {
          best = c;
          bgY = y;
        }
      }
    }

    let bgR = 255;
    let bgG = 255;
    let bgB = 255;
    let bgCnt = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    const bgLo = clampInt(bgY - 2, 0, 255);
    const bgHi = clampInt(bgY + 2, 0, 255);
    for (let i = 0; i < regionSize; i += stride) {
      const p = i * 4;
      const a = lineRGBA[p + 3] || 0;
      if (a <= effectiveLineAlphaThreshold) continue;
      const r = lineRGBA[p] || 0;
      const g = lineRGBA[p + 1] || 0;
      const b = lineRGBA[p + 2] || 0;
      const y = luminance8(r, g, b);
      if (y < bgLo || y > bgHi) continue;
      sumR += r;
      sumG += g;
      sumB += b;
      bgCnt++;
    }
    if (bgCnt > 0) {
      bgR = (sumR / bgCnt) | 0;
      bgG = (sumG / bgCnt) | 0;
      bgB = (sumB / bgCnt) | 0;
    }

    const sens = clampInt(Math.round(lineSensitivity || 6), 1, 10);
    const yDiffThreshold = clampInt(12 + (10 - sens) * 6, 10, 90);
    const rgbDiffThreshold = clampInt(yDiffThreshold * 3, 30, 240);
    const diffHist = new Uint32Array(256);
    let diffSampled = 0;
    for (let i = 0; i < regionSize; i += stride) {
      const p = i * 4;
      const a = lineRGBA[p + 3] || 0;
      if (a <= effectiveLineAlphaThreshold) continue;
      const x = i % regionW;
      const y = (i - x) / regionW;
      const y0 = luminance8(lineRGBA[p] || 0, lineRGBA[p + 1] || 0, lineRGBA[p + 2] || 0);
      if (x + 1 < regionW) {
        const pr = p + 4;
        const y1 = luminance8(lineRGBA[pr] || 0, lineRGBA[pr + 1] || 0, lineRGBA[pr + 2] || 0);
        const d = y1 >= y0 ? y1 - y0 : y0 - y1;
        diffHist[d] += 1;
        diffSampled++;
      }
      if (y + 1 < regionH) {
        const pd = p + regionW * 4;
        const y2 = luminance8(lineRGBA[pd] || 0, lineRGBA[pd + 1] || 0, lineRGBA[pd + 2] || 0);
        const d = y2 >= y0 ? y2 - y0 : y0 - y2;
        diffHist[d] += 1;
        diffSampled++;
      }
    }
    let qDiff = 16;
    if (diffSampled > 64) {
      const target = Math.max(1, Math.floor(diffSampled * 0.92));
      let acc = 0;
      for (let d = 0; d < 256; d++) {
        acc += diffHist[d] || 0;
        if (acc >= target) {
          qDiff = d;
          break;
        }
      }
    }
    const edgeDiffThreshold = clampInt(Math.max(6, qDiff - 4 - (sens - 6) * 2), 4, 60);
    for (let i = 0; i < regionSize; i++) {
      const p = i * 4;
      const a = lineRGBA[p + 3] || 0;
      if (a <= effectiveLineAlphaThreshold) continue;
      const r = lineRGBA[p] || 0;
      const g = lineRGBA[p + 1] || 0;
      const b = lineRGBA[p + 2] || 0;
      const y = luminance8(r, g, b);
      if (y <= adaptiveLineYThreshold) {
        barrier0[i] = 1;
        lineCount++;
        continue;
      }
      const yDiff = y >= bgY ? y - bgY : bgY - y;
      const rgbDiff = (r >= bgR ? r - bgR : bgR - r) + (g >= bgG ? g - bgG : bgG - g) + (b >= bgB ? b - bgB : bgB - b);
      let edgeLike = false;
      const x = i % regionW;
      const yy = (i - x) / regionW;
      if (x + 1 < regionW) {
        const pr = p + 4;
        const y1 = luminance8(lineRGBA[pr] || 0, lineRGBA[pr + 1] || 0, lineRGBA[pr + 2] || 0);
        const d = y1 >= y ? y1 - y : y - y1;
        if (d >= edgeDiffThreshold) edgeLike = true;
      }
      if (!edgeLike && yy + 1 < regionH) {
        const pd = p + regionW * 4;
        const y2 = luminance8(lineRGBA[pd] || 0, lineRGBA[pd + 1] || 0, lineRGBA[pd + 2] || 0);
        const d = y2 >= y ? y2 - y : y - y2;
        if (d >= edgeDiffThreshold) edgeLike = true;
      }
      if (yDiff >= yDiffThreshold || rgbDiff >= rgbDiffThreshold || edgeLike) {
        barrier0[i] = 1;
        lineCount++;
      }
    }
  } else {
    for (let i = 0; i < regionSize; i++) {
      const a = lineRGBA[i * 4 + 3] || 0;
      if (a <= effectiveLineAlphaThreshold) continue;
      barrier0[i] = 1;
      lineCount++;
    }
  }
  const lineCoverage = lineCount / Math.max(1, regionSize);
  const growAdjust = lineCoverage > 0.08 ? 1 : (lineCoverage < 0.02 ? -1 : 0);
  const tunedLineGrow = clampInt(lineGrow + growAdjust, 0, 6);

  const lineHalfWidth = estimateBinaryMaskHalfWidth(barrier0, regionW, regionH, 8);
  const lineScale = clampInt(lineHalfWidth, 1, 6);

  const outsideBarrierDilate = clampInt(lineScale, 1, 4);
  const barrierForOutsideBase = dilateBinaryMask(barrier0, regionW, regionH, outsideBarrierDilate);
  const barrierForOutsideClose = clampInt(Math.round(Math.max(1, lineScale * 0.75)), 1, 3);
  const barrierForOutside = closeBinaryMask(barrierForOutsideBase, regionW, regionH, barrierForOutsideClose);
  const outside = floodFillOutsideRegion(barrierForOutside, regionW, regionH);
  const outsideNear = dilateBinaryMask(outside, regionW, regionH, clampInt(lineScale, 1, 4));
  const outerBarrier = new Uint8Array(regionSize);
  for (let i = 0; i < regionSize; i++) {
    outerBarrier[i] = barrierForOutside[i] && outsideNear[i] ? 1 : 0;
  }

  const paintLimit = new Uint8Array(regionSize);
  for (let i = 0; i < regionSize; i++) {
    paintLimit[i] = outside[i] || outerBarrier[i] || barrier0[i] ? 0 : 1;
  }
  const barrierCross = barrier0;

  const selectionROI = new Uint8Array(regionSize);
  let selectedCount = 0;
  for (let ry = 0; ry < regionH; ry++) {
    const docY = roiTop + ry;
    const rowBase = docY * docW;
    const regionRow = ry * regionW;
    for (let rx = 0; rx < regionW; rx++) {
      const docX = roiLeft + rx;
      const docIdx = rowBase + docX;
      if ((selectionMask[docIdx] || 0) === 0) continue;
      selectedCount++;
      const ri = regionRow + rx;
      selectionROI[ri] = 1;
    }
  }
  const initialSelectionRatio = selectedCount / Math.max(1, regionSize);
  const useAutoFillArea = selectedCount === 0 || initialSelectionRatio > 0.985;

  let finalSelectedCount = 0;
  if (useAutoFillArea) {
    selectionROI.set(paintLimit);
    for (let i = 0; i < regionSize; i++) {
      if (!selectionROI[i]) continue;
      finalSelectedCount++;
    }
  } else {
    for (let i = 0; i < regionSize; i++) {
      if (!selectionROI[i]) continue;
      if (!paintLimit[i]) {
        selectionROI[i] = 0;
        continue;
      }
      finalSelectedCount++;
    }
  }
  selectedCount = finalSelectedCount;

  const allowRadius = clampInt(Math.round(maxDistance + 2), 2, 80);
  let allowedROI: Uint8Array;
  if (useAutoFillArea) {
    allowedROI = paintLimit;
  } else {
    allowedROI = dilateBinaryMask(selectionROI, regionW, regionH, allowRadius);
    for (let i = 0; i < regionSize; i++) {
      if (!paintLimit[i]) allowedROI[i] = 0;
    }
  }

  const dist = new Uint16Array(regionSize);
  dist.fill(0xffff);
  const colorPacked = new Uint32Array(regionSize);
  const q = new Uint32Array(regionSize);
  let head = 0;
  let tail = 0;

  let seedCount = 0;
  const nearLineBandRadius = clampInt(lineScale, 1, 6);
  const nearLineBand = dilateBinaryMask(barrierForOutside, regionW, regionH, nearLineBandRadius);
  const nearLineOverwriteAlphaThreshold = clampInt(200 + lineScale * 8, 200, 235);

  const isNearLine = (rx: number, ry: number, ri: number) => {
    if (barrier0[ri]) return true;
    if (rx > 0 && barrier0[ri - 1]) return true;
    if (rx + 1 < regionW && barrier0[ri + 1]) return true;
    if (ry > 0 && barrier0[ri - regionW]) return true;
    if (ry + 1 < regionH && barrier0[ri + regionW]) return true;
    return false;
  };

  const trySeed = (threshold: number, forbidNearLine: boolean) => {
    for (let ry = 0; ry < regionH; ry++) {
      const docY = roiTop + ry;
      const rowBase = docY * docW;
      const regionRow = ry * regionW;
      for (let rx = 0; rx < regionW; rx++) {
        const ri = regionRow + rx;
        if (!allowedROI[ri]) continue;
        if (barrierCross[ri]) continue;
        if (forbidNearLine && isNearLine(rx, ry, ri)) continue;
        const docX = roiLeft + rx;
        const docIdx = rowBase + docX;
        const pi = docIdx * 4;
        const a = base[pi + 3] || 0;
        if (a <= threshold) continue;
        dist[ri] = 0;
        colorPacked[ri] = packRGBA(base[pi] || 0, base[pi + 1] || 0, base[pi + 2] || 0, 255);
        q[tail++] = ri;
        seedCount++;
      }
    }
  };

  trySeed(seedAlphaThreshold, true);
  if (seedCount === 0) {
    trySeed(1, false);
  }

  if (seedCount === 0) return result;

  while (head < tail) {
    const ri = q[head++] as number;
    const d = dist[ri] as number;
    if (d >= maxDistance) continue;

    const rx = ri % regionW;
    const ry = (ri - rx) / regionW;
    const nd = d + 1;
    const color = colorPacked[ri] || 0;

    const tryVisit = (nrx: number, nry: number, nRi: number) => {
      if (dist[nRi] !== 0xffff) return;
      if (barrierCross[nRi]) return;
      if (!allowedROI[nRi]) return;
      const docX = roiLeft + nrx;
      const docY = roiTop + nry;
      const docIdx = docY * docW + docX;
      dist[nRi] = nd as any;
      colorPacked[nRi] = color;
      q[tail++] = nRi;
    };

    if (rx > 0) tryVisit(rx - 1, ry, ri - 1);
    if (rx + 1 < regionW) tryVisit(rx + 1, ry, ri + 1);
    if (ry > 0) tryVisit(rx, ry - 1, ri - regionW);
    if (ry + 1 < regionH) tryVisit(rx, ry + 1, ri + regionW);
  }

  for (let ry = 0; ry < regionH; ry++) {
    const docY = roiTop + ry;
    const rowBase = docY * docW;
    const regionRow = ry * regionW;
    for (let rx = 0; rx < regionW; rx++) {
      const ri = regionRow + rx;
      if (barrierCross[ri]) continue;
      const docX = roiLeft + rx;
      const docIdx = rowBase + docX;
      if (!selectionROI[ri]) continue;
      const pi = docIdx * 4;
      const a = base[pi + 3] || 0;
      const overwriteLimit = nearLineBand[ri] ? nearLineOverwriteAlphaThreshold : emptyAlphaThreshold;
      if (a > overwriteLimit) continue;
      if (dist[ri] === 0xffff) continue;
      const c = colorPacked[ri] || 0;
      if (c === 0) continue;
      result[pi] = unpackR(c);
      result[pi + 1] = unpackG(c);
      result[pi + 2] = unpackB(c);
      result[pi + 3] = unpackA(c);
    }
  }

  return result;
}
