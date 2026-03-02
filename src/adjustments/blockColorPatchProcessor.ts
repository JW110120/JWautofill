type DocSize = { width: number; height: number };

export type BlockColorPatchParams = {
  borderWidth: number;
  maxDistance?: number;
  emptyAlphaThreshold?: number;
  seedAlphaThreshold?: number;
};

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));

const packRGBA = (r: number, g: number, b: number, a: number) =>
  (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;
const unpackR = (p: number) => (p >>> 24) & 255;
const unpackG = (p: number) => (p >>> 16) & 255;
const unpackB = (p: number) => (p >>> 8) & 255;
const unpackA = (p: number) => p & 255;

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
    if (x > 0 && y > 0) push(i - w - 1);
    if (x + 1 < w && y > 0) push(i - w + 1);
    if (x > 0 && y + 1 < h) push(i + w - 1);
    if (x + 1 < w && y + 1 < h) push(i + w + 1);
  }
  return out;
}

export async function processBlockColorPatch(
  colorLayerFullRGBA: ArrayBuffer,
  selectionMaskData: ArrayBuffer,
  docSize: DocSize,
  params: BlockColorPatchParams
): Promise<Uint8Array> {
  const base = new Uint8Array(colorLayerFullRGBA);
  const result = new Uint8Array(base.length);
  result.set(base);

  const { width: docW, height: docH } = docSize;
  const selectionMask = new Uint8Array(selectionMaskData);
  if (selectionMask.length !== docW * docH) return result;
  if (base.length !== docW * docH * 4) return result;

  const borderWidth = clampInt(Math.round(params.borderWidth || 0), 1, 128);
  const maxDistance = clampInt(Math.round(params.maxDistance ?? (borderWidth + 2)), 1, 200);
  const emptyAlphaThreshold = clampInt(Math.round(params.emptyAlphaThreshold ?? 16), 0, 255);
  const seedAlphaThreshold = clampInt(Math.round(params.seedAlphaThreshold ?? 16), 0, 255);

  const regionW = docW;
  const regionH = docH;
  const regionSize = regionW * regionH;

  const solid = new Uint8Array(regionSize);
  let solidCount = 0;
  for (let i = 0; i < regionSize; i++) {
    const a = base[i * 4 + 3] || 0;
    if (a <= seedAlphaThreshold) continue;
    solid[i] = 1;
    solidCount++;
  }
  if (solidCount === 0) return result;

  const dilated = dilateBinaryMask(solid, regionW, regionH, borderWidth);

  const dist = new Uint16Array(regionSize);
  dist.fill(0xffff);
  const colorPacked = new Uint32Array(regionSize);
  const q = new Uint32Array(regionSize);
  let head = 0;
  let tail = 0;

  let seedCount = 0;
  for (let ri = 0; ri < regionSize; ri++) {
    if (!solid[ri]) continue;
    if (!dilated[ri]) continue;
    dist[ri] = 0;
    const pi = ri * 4;
    colorPacked[ri] = packRGBA(base[pi] || 0, base[pi + 1] || 0, base[pi + 2] || 0, 255);
    q[tail++] = ri;
    seedCount++;
  }
  if (seedCount === 0) return result;

  while (head < tail) {
    const ri = q[head++] as number;
    const d = dist[ri] as number;
    if (d >= maxDistance) continue;

    const rx = ri % regionW;
    const ry = (ri - rx) / regionW;
    const nd = d >= 65534 ? 65534 : d + 1;
    const color = colorPacked[ri] || 0;

    const tryVisit = (nRi: number) => {
      if (dist[nRi] !== 0xffff) return;
      if (!dilated[nRi]) return;
      dist[nRi] = nd as any;
      colorPacked[nRi] = color;
      q[tail++] = nRi;
    };

    if (rx > 0) tryVisit(ri - 1);
    if (rx + 1 < regionW) tryVisit(ri + 1);
    if (ry > 0) tryVisit(ri - regionW);
    if (ry + 1 < regionH) tryVisit(ri + regionW);
    if (rx > 0 && ry > 0) tryVisit(ri - regionW - 1);
    if (rx + 1 < regionW && ry > 0) tryVisit(ri - regionW + 1);
    if (rx > 0 && ry + 1 < regionH) tryVisit(ri + regionW - 1);
    if (rx + 1 < regionW && ry + 1 < regionH) tryVisit(ri + regionW + 1);
  }

  for (let ri = 0; ri < regionSize; ri++) {
    if ((selectionMask[ri] || 0) === 0) continue;
    if (!dilated[ri]) continue;
    if (solid[ri]) continue;
    const pi = ri * 4;
    const a = base[pi + 3] || 0;
    if (a > emptyAlphaThreshold) continue;

    let c = 0;
    if (dist[ri] !== 0xffff) c = colorPacked[ri] || 0;
    if (c === 0) continue;
    result[pi] = unpackR(c);
    result[pi + 1] = unpackG(c);
    result[pi + 2] = unpackB(c);
    result[pi + 3] = Math.max(a, unpackA(c));
  }

  return result;
}
