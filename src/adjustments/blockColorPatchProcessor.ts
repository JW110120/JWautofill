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
  const lineGrow = clampInt(Math.round(params.lineGrow || 1), 0, 6);
  const emptyAlphaThreshold = clampInt(Math.round(params.emptyAlphaThreshold ?? 1), 0, 255);
  const seedAlphaThreshold = clampInt(Math.round(params.seedAlphaThreshold ?? 1), 0, 255);
  const lineAlphaThreshold = clampInt(Math.round(params.lineAlphaThreshold ?? 6), 0, 255);

  const lineThreshold = clampInt(30 + lineSensitivity * 20, 30, 230);

  const barrier0 = new Uint8Array(regionSize);
  for (let i = 0; i < regionSize; i++) {
    const p = i * 4;
    const a = lineRGBA[p + 3] || 0;
    if (a <= lineAlphaThreshold) continue;
    const r = lineRGBA[p] || 0;
    const g = lineRGBA[p + 1] || 0;
    const b = lineRGBA[p + 2] || 0;
    const y = luminance8(r, g, b);
    if (y <= lineThreshold) barrier0[i] = 1;
  }
  const barrier = dilateBinaryMask(barrier0, regionW, regionH, lineGrow);

  const dist = new Uint16Array(regionSize);
  dist.fill(0xffff);
  const colorPacked = new Uint32Array(regionSize);
  const q = new Uint32Array(regionSize);
  let head = 0;
  let tail = 0;

  let seedCount = 0;

  for (let ry = 0; ry < regionH; ry++) {
    const docY = roiTop + ry;
    const rowBase = docY * docW;
    const regionRow = ry * regionW;
    for (let rx = 0; rx < regionW; rx++) {
      const docX = roiLeft + rx;
      const docIdx = rowBase + docX;
      const sel = selectionMask[docIdx] || 0;
      if (sel === 0) continue;
      const ri = regionRow + rx;
      if (barrier[ri]) continue;
      const pi = docIdx * 4;
      const a = base[pi + 3] || 0;
      if (a > seedAlphaThreshold) {
        dist[ri] = 0;
        colorPacked[ri] = packRGBA(base[pi] || 0, base[pi + 1] || 0, base[pi + 2] || 0, 255);
        q[tail++] = ri;
        seedCount++;
      }
    }
  }

  if (seedCount === 0) {
    for (let ry = 0; ry < regionH; ry++) {
      const docY = roiTop + ry;
      const rowBase = docY * docW;
      const regionRow = ry * regionW;
      for (let rx = 0; rx < regionW; rx++) {
        const docX = roiLeft + rx;
        const docIdx = rowBase + docX;
        const pi = docIdx * 4;
        const a = base[pi + 3] || 0;
        if (a <= seedAlphaThreshold) continue;
        const ri = regionRow + rx;
        if (barrier[ri]) continue;

        const hasSelectedNeighbor =
          (rx > 0 && (selectionMask[docIdx - 1] || 0) !== 0) ||
          (rx + 1 < regionW && (selectionMask[docIdx + 1] || 0) !== 0) ||
          (ry > 0 && (selectionMask[docIdx - docW] || 0) !== 0) ||
          (ry + 1 < regionH && (selectionMask[docIdx + docW] || 0) !== 0);

        if (!hasSelectedNeighbor) continue;

        dist[ri] = 0;
        colorPacked[ri] = packRGBA(base[pi] || 0, base[pi + 1] || 0, base[pi + 2] || 0, 255);
        q[tail++] = ri;
        seedCount++;
      }
    }
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
      if (barrier[nRi]) return;
      const docX = roiLeft + nrx;
      const docY = roiTop + nry;
      const docIdx = docY * docW + docX;
      if ((selectionMask[docIdx] || 0) === 0) return;
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
      if (barrier[ri]) continue;
      const docX = roiLeft + rx;
      const docIdx = rowBase + docX;
      const sel = selectionMask[docIdx] || 0;
      if (sel === 0) continue;
      const pi = docIdx * 4;
      const a = base[pi + 3] || 0;
      if (a > emptyAlphaThreshold) continue;
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
