export async function processGradientRelax(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: { width: number; height: number },
  params: { amount: number },
  isBackgroundLayer: boolean = false
): Promise<Uint8Array> {
  const width = bounds.width;
  const height = bounds.height;
  const pixels = new Uint8Array(layerPixelData);
  const selectionMask = new Uint8Array(selectionData);

  const rawAmount = typeof params.amount === 'number' ? params.amount : 0;
  const amount = Math.max(-10, Math.min(10, rawAmount));
  if (amount === 0) {
    const out0 = new Uint8Array(pixels.length);
    out0.set(pixels);
    return out0;
  }

  const magnitude = Math.abs(amount);
  const effectBase = Math.max(0, Math.min(1, magnitude / 10));

  const radius = Math.max(2, Math.min(30, Math.round(2 + magnitude * 2)));
  const sigma = Math.max(1, radius * 0.55);

  const kernelSize = radius * 2 + 1;
  const kernel = new Float32Array(kernelSize);
  let sum = 0;
  for (let i = 0; i < kernelSize; i++) {
    const x = i - radius;
    const v = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel[i] = v;
    sum += v;
  }
  if (sum > 0) {
    for (let i = 0; i < kernelSize; i++) kernel[i] /= sum;
  }

  const smoothstep = (edge0: number, edge1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };

  const temp = new Uint8Array(pixels.length);
  temp.set(pixels);
  const blurred = new Uint8Array(pixels.length);
  blurred.set(pixels);
  const supportX = new Uint8Array(width * height);
  const support = new Uint8Array(width * height);

  const passHorizontal = () => {
    for (let y = 0; y < height; y++) {
      const rowBase = y * width;
      for (let x = 0; x < width; x++) {
        const centerIndex = rowBase + x;
        const centerPix = centerIndex * 4;
        const centerMask = selectionMask[centerIndex] || 0;
        if (centerMask === 0) {
          supportX[centerIndex] = 0;
          continue;
        }

        let localKernelSum = 0;
        let weightSum = 0;
        let maskWeightSum = 0;
        let sumA = 0;
        let sumPremR = 0;
        let sumPremG = 0;
        let sumPremB = 0;

        for (let i = 0; i < kernelSize; i++) {
          const sx = x + i - radius;
          if (sx < 0 || sx >= width) continue;
          const k = kernel[i];
          localKernelSum += k;

          const m = selectionMask[rowBase + sx] || 0;
          if (m === 0) continue;
          const idx = (rowBase + sx) * 4;
          const a = pixels[idx + 3];

          const w = k * (m / 255);
          weightSum += w;
          maskWeightSum += w;
          sumA += a * w;
          const a01 = a / 255;
          sumPremR += pixels[idx] * a01 * w;
          sumPremG += pixels[idx + 1] * a01 * w;
          sumPremB += pixels[idx + 2] * a01 * w;
        }

        if (localKernelSum <= 0) {
          supportX[centerIndex] = 0;
          continue;
        }
        const s = Math.max(0, Math.min(1, maskWeightSum / localKernelSum));
        supportX[centerIndex] = Math.round(s * 255);

        if (weightSum <= 0) continue;

        const blurA = sumA / weightSum;
        let blurR = 0;
        let blurG = 0;
        let blurB = 0;
        if (blurA > 0.001) {
          const invA = 255 / blurA;
          blurR = Math.max(0, Math.min(255, sumPremR / weightSum * invA));
          blurG = Math.max(0, Math.min(255, sumPremG / weightSum * invA));
          blurB = Math.max(0, Math.min(255, sumPremB / weightSum * invA));
        }

        temp[centerPix] = Math.round(blurR);
        temp[centerPix + 1] = Math.round(blurG);
        temp[centerPix + 2] = Math.round(blurB);
        temp[centerPix + 3] = isBackgroundLayer
          ? 255
          : Math.round(blurA);
      }
    }
  };

  const passVertical = () => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const centerIndex = y * width + x;
        const centerPix = centerIndex * 4;
        const centerMask = selectionMask[centerIndex] || 0;
        if (centerMask === 0) {
          support[centerIndex] = 0;
          continue;
        }

        let localKernelSum = 0;
        let weightSum = 0;
        let maskWeightSum = 0;
        let sumA = 0;
        let sumPremR = 0;
        let sumPremG = 0;
        let sumPremB = 0;

        for (let i = 0; i < kernelSize; i++) {
          const sy = y + i - radius;
          if (sy < 0 || sy >= height) continue;
          const k = kernel[i];
          localKernelSum += k;

          const sIndex = sy * width + x;
          const m = supportX[sIndex] || 0;
          const idx = sIndex * 4;
          const a = temp[idx + 3];

          const wMask = k * (m / 255);
          maskWeightSum += wMask;

          const m2 = selectionMask[sIndex] || 0;
          if (m2 === 0) continue;
          const w = k * (m2 / 255);
          weightSum += w;
          sumA += a * w;
          const a01 = a / 255;
          sumPremR += temp[idx] * a01 * w;
          sumPremG += temp[idx + 1] * a01 * w;
          sumPremB += temp[idx + 2] * a01 * w;
        }

        if (localKernelSum <= 0) {
          support[centerIndex] = 0;
          continue;
        }
        const s = Math.max(0, Math.min(1, maskWeightSum / localKernelSum));
        support[centerIndex] = Math.round(s * 255);

        if (weightSum <= 0) continue;

        const blurA = sumA / weightSum;
        let blurR = 0;
        let blurG = 0;
        let blurB = 0;
        if (blurA > 0.001) {
          const invA = 255 / blurA;
          blurR = Math.max(0, Math.min(255, sumPremR / weightSum * invA));
          blurG = Math.max(0, Math.min(255, sumPremG / weightSum * invA));
          blurB = Math.max(0, Math.min(255, sumPremB / weightSum * invA));
        }

        blurred[centerPix] = Math.round(blurR);
        blurred[centerPix + 1] = Math.round(blurG);
        blurred[centerPix + 2] = Math.round(blurB);
        blurred[centerPix + 3] = isBackgroundLayer ? 255 : Math.round(blurA);
      }
    }
  };

  passHorizontal();
  passVertical();

  const out = new Uint8Array(pixels.length);
  out.set(pixels);

  const clamp255 = (v: number) => Math.max(0, Math.min(255, v));
  const softLimiter = (delta: number, limit: number) => {
    const ad = Math.abs(delta);
    if (ad <= limit) return delta;
    const scale = limit / ad;
    return delta * scale;
  };

  const kScale = amount > 0 ? 0.9 : 1.0;

  for (let i = 0; i < width * height; i++) {
    const m = selectionMask[i] || 0;
    if (m === 0) continue;

    const fade = smoothstep(0.72, 0.97, (support[i] || 0) / 255);
    const k = effectBase * fade * kScale;
    if (k <= 0) continue;

    const p = i * 4;
    const oA = isBackgroundLayer ? 255 : pixels[p + 3];
    const bA = isBackgroundLayer ? 255 : blurred[p + 3];

    if (amount < 0) {
      out[p] = Math.round(pixels[p] * (1 - k) + blurred[p] * k);
      out[p + 1] = Math.round(pixels[p + 1] * (1 - k) + blurred[p + 1] * k);
      out[p + 2] = Math.round(pixels[p + 2] * (1 - k) + blurred[p + 2] * k);
      out[p + 3] = isBackgroundLayer ? 255 : Math.round(oA * (1 - k) + bA * k);
      continue;
    }

    const deltaA = softLimiter(oA - bA, 80);
    const outA = clamp255(oA + deltaA * k);

    const oA01 = oA / 255;
    const bA01 = bA / 255;
    const oPremR = pixels[p] * oA01;
    const oPremG = pixels[p + 1] * oA01;
    const oPremB = pixels[p + 2] * oA01;
    const bPremR = blurred[p] * bA01;
    const bPremG = blurred[p + 1] * bA01;
    const bPremB = blurred[p + 2] * bA01;

    const dPremR = softLimiter(oPremR - bPremR, 90);
    const dPremG = softLimiter(oPremG - bPremG, 90);
    const dPremB = softLimiter(oPremB - bPremB, 90);

    const outPremR = oPremR + dPremR * k;
    const outPremG = oPremG + dPremG * k;
    const outPremB = oPremB + dPremB * k;

    if (isBackgroundLayer) {
      out[p] = Math.round(clamp255(pixels[p] + (pixels[p] - blurred[p]) * k));
      out[p + 1] = Math.round(clamp255(pixels[p + 1] + (pixels[p + 1] - blurred[p + 1]) * k));
      out[p + 2] = Math.round(clamp255(pixels[p + 2] + (pixels[p + 2] - blurred[p + 2]) * k));
      out[p + 3] = 255;
      continue;
    }

    if (outA <= 0.001) {
      out[p] = 0;
      out[p + 1] = 0;
      out[p + 2] = 0;
      out[p + 3] = 0;
      continue;
    }

    const invA = 255 / outA;
    out[p] = Math.round(clamp255(outPremR * invA));
    out[p + 1] = Math.round(clamp255(outPremG * invA));
    out[p + 2] = Math.round(clamp255(outPremB * invA));
    out[p + 3] = Math.round(outA);
  }

  return out;
}
