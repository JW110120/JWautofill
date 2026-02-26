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

  const INF = 0xffff;
  const dist = new Uint16Array(width * height);
  for (let i = 0; i < width * height; i++) {
    dist[i] = (selectionMask[i] || 0) > 0 ? INF : 0;
  }
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      const d = dist[idx];
      if (d === 0) continue;
      let best = d;
      if (x > 0) {
        const left = dist[idx - 1];
        if (left + 1 < best) best = left + 1;
      }
      if (y > 0) {
        const up = dist[idx - width];
        if (up + 1 < best) best = up + 1;
      }
      dist[idx] = best;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    const rowBase = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const idx = rowBase + x;
      const d = dist[idx];
      if (d === 0) continue;
      let best = d;
      if (x + 1 < width) {
        const right = dist[idx + 1];
        const cand = right === INF ? INF : right + 1;
        if (cand < best) best = cand;
      }
      if (y + 1 < height) {
        const down = dist[idx + width];
        const cand = down === INF ? INF : down + 1;
        if (cand < best) best = cand;
      }
      dist[idx] = best;
    }
  }

  const featherPx = Math.max(6, Math.min(80, Math.round(radius * 2)));
  const featherMask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const m = selectionMask[i] || 0;
    if (m === 0) {
      featherMask[i] = 0;
      continue;
    }
    const d = dist[i];
    const d0 = d === INF ? featherPx : Math.max(0, d - 1);
    const u = Math.max(0, Math.min(1, d0 / featherPx));
    const fade = smootherstep01(smootherstep01(u));
    featherMask[i] = Math.round(fade * m);
  }

  const channelCount = isBackgroundLayer ? 3 : 4;
  const minCh = new Uint8Array(width * height);
  const maxCh = new Uint8Array(width * height);
  const minH = new Uint8Array(width * height);
  const maxH = new Uint8Array(width * height);

  const computeMinMaxForChannel = (ch: number) => {
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
        const valid = (selectionMask[idx] || 0) > 0;
        const v = valid ? pixels[idx * 4 + ch] : 0;
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
        const valid = (selectionMask[idx] || 0) > 0;
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

  const contrast = Math.pow(2, amount / 5);
  const out = new Uint8Array(pixels.length);
  out.set(pixels);

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  for (let ch = 0; ch < channelCount; ch++) {
    computeMinMaxForChannel(ch);
    for (let i = 0; i < width * height; i++) {
      const fm = featherMask[i] || 0;
      if (fm === 0) continue;

      const k = effectBase * (fm / 255);
      if (k <= 0) continue;

      const mn = minCh[i];
      const mx = maxCh[i];
      const range = mx - mn;
      if (range < 2) continue;

      const p = i * 4;
      const v = pixels[p + ch];
      const tn = (v - mn) / range;
      const tn2 = clamp01(0.5 + (tn - 0.5) * contrast);
      const v2 = mn + tn2 * range;
      out[p + ch] = Math.round(v * (1 - k) + v2 * k);
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
