// 特殊木刻滤镜（支持 alpha 的边缘一致化木刻效果）
// 目标：解决 PS 自带木刻仅作用于内部像素、边缘（尤其半透明抗锯齿区）保持原样的问题

type Bounds = { width: number; height: number };

export type SpecialWoodcutParams = {
  levels: number; // 2–16
  edgeThreshold: number; // 0–255
  edgeStrength: number; // 0–100（%）
};

const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v | 0));

const buildQuantLut = (levels: number) => {
  const l = clampInt(levels, 2, 16);
  const lut = new Uint8Array(256);
  const denom = Math.max(1, l - 1);
  for (let v = 0; v < 256; v++) {
    let idx = ((v * l) / 255) | 0; // floor((v/255)*levels)
    if (idx >= l) idx = l - 1; // 避免 v=255 时溢出到 levels
    const q = Math.round((idx * 255) / denom);
    lut[v] = q < 0 ? 0 : q > 255 ? 255 : q;
  }
  return lut;
};

const luminance8 = (r: number, g: number, b: number) => ((r * 54 + g * 183 + b * 19 + 128) >> 8) & 0xff;

const absInt = (x: number) => (x < 0 ? -x : x);

// 像素数组格式：RGBA，8-bit/component，chunky
export async function processSpecialWoodcut(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: Bounds,
  params: SpecialWoodcutParams,
  isBackgroundLayer: boolean = false
): Promise<Uint8Array> {
  const width = Math.max(1, bounds.width | 0);
  const height = Math.max(1, bounds.height | 0);
  const pixelCount = width * height;

  const pixels = new Uint8Array(layerPixelData);
  const selectionMask = new Uint8Array(selectionData);

  if (pixels.length < pixelCount * 4) {
    return pixels;
  }

  const levels = clampInt(params.levels, 2, 16);
  const edgeThreshold = clampInt(params.edgeThreshold, 0, 255);
  const edgeStrength01 = Math.max(0, Math.min(1, (params.edgeStrength || 0) / 100));

  const quantLut = buildQuantLut(levels);
  const intensity = new Uint8Array(pixelCount);
  const alphaArr = new Uint8Array(pixelCount);

  let maxAlpha = 0;
  for (let i = 0; i < pixelCount; i++) {
    const i4 = i * 4;
    const r = pixels[i4] || 0;
    const g = pixels[i4 + 1] || 0;
    const b = pixels[i4 + 2] || 0;
    const a = isBackgroundLayer ? 255 : (pixels[i4 + 3] || 0);

    alphaArr[i] = a;
    maxAlpha |= a;

    const lum = luminance8(r, g, b);
    const vis = ((lum * a + 127) / 255) | 0;
    intensity[i] = vis & 0xff;
  }

  if (!isBackgroundLayer && maxAlpha === 0) {
    return pixels;
  }

  const edge = new Uint8Array(pixelCount);

  if (width >= 3 && height >= 3) {
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;

        const i00 = intensity[i - width - 1];
        const i01 = intensity[i - width];
        const i02 = intensity[i - width + 1];
        const i10 = intensity[i - 1];
        const i12 = intensity[i + 1];
        const i20 = intensity[i + width - 1];
        const i21 = intensity[i + width];
        const i22 = intensity[i + width + 1];

        const gxI = -i00 - (i10 << 1) - i20 + i02 + (i12 << 1) + i22;
        const gyI = -i00 - (i01 << 1) - i02 + i20 + (i21 << 1) + i22;
        const magI = (absInt(gxI) + absInt(gyI)) >> 3;

        const a00 = alphaArr[i - width - 1];
        const a01 = alphaArr[i - width];
        const a02 = alphaArr[i - width + 1];
        const a10 = alphaArr[i - 1];
        const a12 = alphaArr[i + 1];
        const a20 = alphaArr[i + width - 1];
        const a21 = alphaArr[i + width];
        const a22 = alphaArr[i + width + 1];

        const gxA = -a00 - (a10 << 1) - a20 + a02 + (a12 << 1) + a22;
        const gyA = -a00 - (a01 << 1) - a02 + a20 + (a21 << 1) + a22;
        const magA = (absInt(gxA) + absInt(gyA)) >> 3;

        const mag = magI > magA ? magI : magA;
        edge[i] = mag > 255 ? 255 : mag;
      }
    }
  }

  for (let i = 0; i < pixelCount; i++) {
    if (selectionMask && selectionMask.length >= pixelCount) {
      if ((selectionMask[i] || 0) === 0) continue;
    }

    const i4 = i * 4;
    const a = alphaArr[i] || 0;

    if (!isBackgroundLayer && a === 0) {
      continue;
    }

    const r = pixels[i4] || 0;
    const g = pixels[i4 + 1] || 0;
    const b = pixels[i4 + 2] || 0;

    const baseR = quantLut[r];
    const baseG = quantLut[g];
    const baseB = quantLut[b];

    let outR = baseR;
    let outG = baseG;
    let outB = baseB;

    const e = edge[i] || 0;
    if (edgeStrength01 > 0 && e >= edgeThreshold) {
      const w = edgeStrength01 * (e / 255);
      if (w > 0) {
        let edgeR = baseR;
        let edgeG = baseG;
        let edgeB = baseB;

        if (a > 0 && a < 255) {
          const visR = ((r * a + 127) / 255) | 0;
          const visG = ((g * a + 127) / 255) | 0;
          const visB = ((b * a + 127) / 255) | 0;

          const qVisR = quantLut[visR & 0xff];
          const qVisG = quantLut[visG & 0xff];
          const qVisB = quantLut[visB & 0xff];

          edgeR = Math.round((qVisR * 255) / a);
          edgeG = Math.round((qVisG * 255) / a);
          edgeB = Math.round((qVisB * 255) / a);

          if (edgeR < 0) edgeR = 0;
          else if (edgeR > 255) edgeR = 255;
          if (edgeG < 0) edgeG = 0;
          else if (edgeG > 255) edgeG = 255;
          if (edgeB < 0) edgeB = 0;
          else if (edgeB > 255) edgeB = 255;
        }

        outR = Math.round(baseR * (1 - w) + edgeR * w);
        outG = Math.round(baseG * (1 - w) + edgeG * w);
        outB = Math.round(baseB * (1 - w) + edgeB * w);
      }
    }

    pixels[i4] = outR;
    pixels[i4 + 1] = outG;
    pixels[i4 + 2] = outB;
    if (!isBackgroundLayer) {
      pixels[i4 + 3] = a;
    }
  }

  return pixels;
}

