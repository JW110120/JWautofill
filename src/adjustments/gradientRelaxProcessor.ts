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
  const radius = Math.max(1, Math.min(30, Math.round(2 + magnitude * 2)));
  const windowSize = radius * 2 + 1;

  const smootherstep01 = (t: number) => {
    const x = Math.max(0, Math.min(1, t));
    return x * x * x * (x * (x * 6 - 15) + 10);
  };
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const alphaToColorWeight01 = (a255: number) => {
    const t = clamp01(a255 / 80);
    return smootherstep01(t);
  };

  const hasAlpha = !isBackgroundLayer;
  const workingPixels = new Uint8Array(pixels.length);
  workingPixels.set(pixels);
  if (hasAlpha) {
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      const a = workingPixels[p + 3] || 0;
      if (a === 0) {
        workingPixels[p] = 0;
        workingPixels[p + 1] = 0;
        workingPixels[p + 2] = 0;
        continue;
      }
      const r = workingPixels[p] || 0;
      const g = workingPixels[p + 1] || 0;
      const b = workingPixels[p + 2] || 0;
      workingPixels[p] = Math.floor((r * a + 127) / 255);
      workingPixels[p + 1] = Math.floor((g * a + 127) / 255);
      workingPixels[p + 2] = Math.floor((b * a + 127) / 255);
    }
  }

  const validMaskAlpha = selectionMask;
  let validMaskColor = validMaskAlpha;
  if (hasAlpha) {
    validMaskColor = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const m = selectionMask[i] || 0;
      if (m === 0) continue;
      const a = pixels[i * 4 + 3] || 0;
      const w = alphaToColorWeight01(a);
      validMaskColor[i] = Math.round(m * w);
    }
  }

  const xSpan = new Uint16Array(width);
  for (let x = 0; x < width; x++) {
    const x0 = x - radius < 0 ? 0 : x - radius;
    const x1 = x + radius >= width ? width - 1 : x + radius;
    xSpan[x] = (x1 - x0 + 1) as any;
  }
  const ySpan = new Uint16Array(height);
  for (let y = 0; y < height; y++) {
    const y0 = y - radius < 0 ? 0 : y - radius;
    const y1 = y + radius >= height ? height - 1 : y + radius;
    ySpan[y] = (y1 - y0 + 1) as any;
  }

  const buildBoxSums = (mask: Uint8Array) => {
    const n = width * height;
    const sumH = new Uint32Array(n);
    const sum = new Uint32Array(n);

    for (let y = 0; y < height; y++) {
      const rowBase = y * width;
      let acc = 0;
      for (let x = -radius; x <= radius; x++) {
        if (x < 0 || x >= width) continue;
        acc += mask[rowBase + x] || 0;
      }
      sumH[rowBase] = acc;
      for (let x = 1; x < width; x++) {
        const addX = x + radius;
        const subX = x - radius - 1;
        if (addX >= 0 && addX < width) acc += mask[rowBase + addX] || 0;
        if (subX >= 0 && subX < width) acc -= mask[rowBase + subX] || 0;
        sumH[rowBase + x] = acc;
      }
    }

    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) {
        if (y < 0 || y >= height) continue;
        acc += sumH[y * width + x] || 0;
      }
      sum[x] = acc;
      for (let y = 1; y < height; y++) {
        const addY = y + radius;
        const subY = y - radius - 1;
        if (addY >= 0 && addY < height) acc += sumH[addY * width + x] || 0;
        if (subY >= 0 && subY < height) acc -= sumH[subY * width + x] || 0;
        sum[y * width + x] = acc;
      }
    }

    return sum;
  };

  const alphaWeightSum = buildBoxSums(validMaskAlpha);
  const colorWeightSum = buildBoxSums(validMaskColor);

  const supportAlpha255 = new Uint8Array(width * height);
  const supportColor255 = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    const hSpan = ySpan[y] || 1;
    for (let x = 0; x < width; x++) {
      const i = rowBase + x;
      if ((selectionMask[i] || 0) === 0) continue;
      const area = (xSpan[x] || 1) * hSpan;
      const sA = alphaWeightSum[i] / (255 * area);
      const sC = colorWeightSum[i] / (255 * area);
      supportAlpha255[i] = Math.round(smootherstep01(clamp01(sA)) * 255);
      supportColor255[i] = Math.round(smootherstep01(clamp01(sC)) * 255);
    }
  }

  const blurAlpha = hasAlpha ? new Uint8Array(width * height) : null;
  if (hasAlpha && amount < 0) {
    const n = width * height;
    const sumWAH = new Uint32Array(n);
    const sumWAV = new Uint32Array(n);
    const sumWH = new Uint32Array(n);
    const sumWV = new Uint32Array(n);

    for (let y = 0; y < height; y++) {
      const rowBase = y * width;
      let accW = 0;
      let accWA = 0;
      for (let x = -radius; x <= radius; x++) {
        if (x < 0 || x >= width) continue;
        const idx = rowBase + x;
        const w = selectionMask[idx] || 0;
        if (w === 0) continue;
        accW += w;
        accWA += w * (pixels[idx * 4 + 3] || 0);
      }
      sumWH[rowBase] = accW;
      sumWAH[rowBase] = accWA;
      for (let x = 1; x < width; x++) {
        const addX = x + radius;
        const subX = x - radius - 1;
        if (addX >= 0 && addX < width) {
          const idxA = rowBase + addX;
          const wA = selectionMask[idxA] || 0;
          if (wA !== 0) {
            accW += wA;
            accWA += wA * (pixels[idxA * 4 + 3] || 0);
          }
        }
        if (subX >= 0 && subX < width) {
          const idxS = rowBase + subX;
          const wS = selectionMask[idxS] || 0;
          if (wS !== 0) {
            accW -= wS;
            accWA -= wS * (pixels[idxS * 4 + 3] || 0);
          }
        }
        sumWH[rowBase + x] = accW;
        sumWAH[rowBase + x] = accWA;
      }
    }

    for (let x = 0; x < width; x++) {
      let accW = 0;
      let accWA = 0;
      for (let y = -radius; y <= radius; y++) {
        if (y < 0 || y >= height) continue;
        const idx = y * width + x;
        accW += sumWH[idx] || 0;
        accWA += sumWAH[idx] || 0;
      }
      sumWV[x] = accW;
      sumWAV[x] = accWA;
      for (let y = 1; y < height; y++) {
        const addY = y + radius;
        const subY = y - radius - 1;
        if (addY >= 0 && addY < height) {
          const idxA = addY * width + x;
          accW += sumWH[idxA] || 0;
          accWA += sumWAH[idxA] || 0;
        }
        if (subY >= 0 && subY < height) {
          const idxS = subY * width + x;
          accW -= sumWH[idxS] || 0;
          accWA -= sumWAH[idxS] || 0;
        }
        sumWV[y * width + x] = accW;
        sumWAV[y * width + x] = accWA;
      }
    }

    for (let i = 0; i < width * height; i++) {
      const m = selectionMask[i] || 0;
      if (m === 0) continue;
      const w = sumWV[i] || 0;
      if (w === 0) {
        blurAlpha![i] = pixels[i * 4 + 3] || 0;
        continue;
      }
      blurAlpha![i] = Math.round((sumWAV[i] || 0) / w);
    }
  }

  const channelCount = isBackgroundLayer ? 3 : 4;
  const minCh = new Uint8Array(width * height);
  const maxCh = new Uint8Array(width * height);
  const minH = new Uint8Array(width * height);
  const maxH = new Uint8Array(width * height);

  const computeMinMaxForChannel = (ch: number, validMask: Uint8Array) => {
    for (let y = 0; y < height; y++) {
      const base = y * width;
      const minIdx: number[] = [];
      const minVal: number[] = [];
      const maxIdx: number[] = [];
      const maxVal: number[] = [];
      let minHead = 0;
      let maxHead = 0;

      for (let j = -radius; j <= width - 1 + radius; j++) {
        const xClamped = j < 0 ? 0 : (j >= width ? width - 1 : j);
        const idx = base + xClamped;
        const valid = (validMask[idx] || 0) > 0;
        const v = valid ? workingPixels[idx * 4 + ch] : 0;
        const vMin = valid ? v : 255;
        const vMax = valid ? v : 0;

        while (minIdx.length > minHead && vMin <= minVal[minVal.length - 1]) {
          minIdx.pop();
          minVal.pop();
        }
        minIdx.push(j);
        minVal.push(vMin);
        while (maxIdx.length > maxHead && vMax >= maxVal[maxVal.length - 1]) {
          maxIdx.pop();
          maxVal.pop();
        }
        maxIdx.push(j);
        maxVal.push(vMax);

        const removeBefore = j - windowSize;
        while (minIdx.length > minHead && minIdx[minHead] <= removeBefore) minHead++;
        while (maxIdx.length > maxHead && maxIdx[maxHead] <= removeBefore) maxHead++;

        const outX = j - radius;
        if (outX >= 0 && outX < width) {
          const outIdx = base + outX;
          minH[outIdx] = minVal[minHead] ?? 255;
          maxH[outIdx] = maxVal[maxHead] ?? 0;
        }
      }
    }

    for (let x = 0; x < width; x++) {
      const minIdx: number[] = [];
      const minVal: number[] = [];
      const maxIdx: number[] = [];
      const maxVal: number[] = [];
      let minHead = 0;
      let maxHead = 0;

      for (let j = -radius; j <= height - 1 + radius; j++) {
        const yClamped = j < 0 ? 0 : (j >= height ? height - 1 : j);
        const idx = yClamped * width + x;
        const valid = (validMask[idx] || 0) > 0;
        const vMin = valid ? minH[idx] : 255;
        const vMax = valid ? maxH[idx] : 0;

        while (minIdx.length > minHead && vMin <= minVal[minVal.length - 1]) {
          minIdx.pop();
          minVal.pop();
        }
        minIdx.push(j);
        minVal.push(vMin);
        while (maxIdx.length > maxHead && vMax >= maxVal[maxVal.length - 1]) {
          maxIdx.pop();
          maxVal.pop();
        }
        maxIdx.push(j);
        maxVal.push(vMax);

        const removeBefore = j - windowSize;
        while (minIdx.length > minHead && minIdx[minHead] <= removeBefore) minHead++;
        while (maxIdx.length > maxHead && maxIdx[maxHead] <= removeBefore) maxHead++;

        const outY = j - radius;
        if (outY >= 0 && outY < height) {
          const outIdx = outY * width + x;
          minCh[outIdx] = minVal[minHead] ?? 255;
          maxCh[outIdx] = maxVal[maxHead] ?? 0;
        }
      }
    }
  };

  const tAmount = magnitude / 10;
  const negBoost = amount < 0 ? 1 + tAmount * tAmount : 1;
  const amountForContrast = amount < 0 ? amount * negBoost : amount;
  const contrast = Math.pow(2, amountForContrast / 5);
  const out = new Uint8Array(workingPixels.length);
  out.set(workingPixels);

  const channelOrder = channelCount === 4 ? [3, 0, 1, 2] : [0, 1, 2];
  for (const ch of channelOrder) {
    const validMask = ch === 3 ? validMaskAlpha : validMaskColor;
    computeMinMaxForChannel(ch, validMask);
    for (let i = 0; i < width * height; i++) {
      const fm = selectionMask[i] || 0;
      if (fm === 0) continue;

      const kBase = effectBase * (fm / 255);
      const supportFactor = (ch === 3 ? (supportAlpha255[i] || 0) : (supportColor255[i] || 0)) / 255;
      let k = kBase * supportFactor;
      const p = i * 4;
      if (hasAlpha && ch !== 3) k *= alphaToColorWeight01(pixels[p + 3] || 0);
      if (k <= 0) continue;

      const mn = minCh[i];
      const mx = maxCh[i];
      const range = mx - mn;
      if (range < 2) continue;

      if (hasAlpha && ch === 3 && amount < 0 && blurAlpha) {
        const edge = smootherstep01(clamp01(range / 64));
        const kA = k * edge;
        if (kA > 0) {
          const a0 = pixels[p + 3] || 0;
          const ab = blurAlpha[i] || 0;
          out[p + 3] = Math.round(a0 * (1 - kA) + ab * kA);
        }
        continue;
      }

      const v = workingPixels[p + ch];
      const tn = (v - mn) / range;
      const tn2 = clamp01(0.5 + (tn - 0.5) * contrast);
      const v2 = mn + tn2 * range;
      out[p + ch] = Math.round(v * (1 - k) + v2 * k);
    }
  }

  if (hasAlpha) {
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      const a = out[p + 3] || 0;
      if (a <= 1) {
        out[p] = 0;
        out[p + 1] = 0;
        out[p + 2] = 0;
        continue;
      }
      const rP = out[p] || 0;
      const gP = out[p + 1] || 0;
      const bP = out[p + 2] || 0;
      const r = Math.round((rP * 255) / a);
      const g = Math.round((gP * 255) / a);
      const b = Math.round((bP * 255) / a);
      out[p] = r > 255 ? 255 : (r < 0 ? 0 : r);
      out[p + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
      out[p + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
    }
  }

  if (isBackgroundLayer) {
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      out[p + 3] = 255;
    }
  }

  return out;
}
