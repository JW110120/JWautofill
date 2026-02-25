export async function processGradientRelax(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: { width: number; height: number },
  params: { strength: number },
  isBackgroundLayer: boolean = false
): Promise<Uint8Array> {
  const width = bounds.width;
  const height = bounds.height;
  const pixels = new Uint8Array(layerPixelData);
  const selectionMask = new Uint8Array(selectionData);

  const strength = Math.max(1, Math.min(10, params.strength || 1));
  const effectBase = Math.max(0, Math.min(1, strength / 10));

  const radius = Math.max(2, Math.min(30, Math.round(2 + strength * 2)));
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
  const result = new Uint8Array(pixels.length);
  result.set(pixels);

  const passHorizontal = () => {
    for (let y = 0; y < height; y++) {
      const rowBase = y * width;
      for (let x = 0; x < width; x++) {
        const centerPix = (rowBase + x) * 4;
        const centerA = pixels[centerPix + 3];
        const centerMask = selectionMask[rowBase + x] || 0;

        const shouldProcess = isBackgroundLayer ? centerMask > 0 : centerA > 0;
        if (!shouldProcess) continue;

        let localKernelSum = 0;
        let weightSum = 0;
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
          if (!isBackgroundLayer && a === 0) continue;

          const w = k * (m / 255);
          weightSum += w;
          sumA += a * w;
          const a01 = a / 255;
          sumPremR += pixels[idx] * a01 * w;
          sumPremG += pixels[idx + 1] * a01 * w;
          sumPremB += pixels[idx + 2] * a01 * w;
        }

        if (weightSum <= 0 || localKernelSum <= 0) continue;

        const support = Math.max(0, Math.min(1, weightSum / localKernelSum));
        const boundaryFade = smoothstep(0.72, 0.97, support);
        const effect = effectBase * boundaryFade;
        if (effect <= 0) continue;

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

        temp[centerPix] = Math.round(pixels[centerPix] * (1 - effect) + blurR * effect);
        temp[centerPix + 1] = Math.round(pixels[centerPix + 1] * (1 - effect) + blurG * effect);
        temp[centerPix + 2] = Math.round(pixels[centerPix + 2] * (1 - effect) + blurB * effect);
        temp[centerPix + 3] = isBackgroundLayer
          ? 255
          : Math.round(centerA * (1 - effect) + blurA * effect);
      }
    }
  };

  const passVertical = () => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const centerIndex = y * width + x;
        const centerPix = centerIndex * 4;
        const centerA = temp[centerPix + 3];
        const centerMask = selectionMask[centerIndex] || 0;

        const shouldProcess = isBackgroundLayer ? centerMask > 0 : centerA > 0;
        if (!shouldProcess) continue;

        let localKernelSum = 0;
        let weightSum = 0;
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
          const m = selectionMask[sIndex] || 0;
          if (m === 0) continue;
          const idx = sIndex * 4;
          const a = temp[idx + 3];
          if (!isBackgroundLayer && a === 0) continue;

          const w = k * (m / 255);
          weightSum += w;
          sumA += a * w;
          const a01 = a / 255;
          sumPremR += temp[idx] * a01 * w;
          sumPremG += temp[idx + 1] * a01 * w;
          sumPremB += temp[idx + 2] * a01 * w;
        }

        if (weightSum <= 0 || localKernelSum <= 0) continue;

        const support = Math.max(0, Math.min(1, weightSum / localKernelSum));
        const boundaryFade = smoothstep(0.72, 0.97, support);
        const effect = effectBase * boundaryFade;
        if (effect <= 0) continue;

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

        result[centerPix] = Math.round(temp[centerPix] * (1 - effect) + blurR * effect);
        result[centerPix + 1] = Math.round(temp[centerPix + 1] * (1 - effect) + blurG * effect);
        result[centerPix + 2] = Math.round(temp[centerPix + 2] * (1 - effect) + blurB * effect);
        result[centerPix + 3] = isBackgroundLayer
          ? 255
          : Math.round(centerA * (1 - effect) + blurA * effect);
      }
    }
  };

  passHorizontal();
  passVertical();

  return result;
}

