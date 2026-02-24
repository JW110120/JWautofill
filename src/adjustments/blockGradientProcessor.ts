import type { Gradient } from '../types/state';

type ParsedStop = {
  position: number;
  r: number;
  g: number;
  b: number;
  a: number;
  midpoint: number;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const parseCssColorToRgba = (color: string): { r: number; g: number; b: number; a: number } => {
  const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
  if (rgbaMatch) {
    const r = Math.max(0, Math.min(255, parseInt(rgbaMatch[1], 10)));
    const g = Math.max(0, Math.min(255, parseInt(rgbaMatch[2], 10)));
    const b = Math.max(0, Math.min(255, parseInt(rgbaMatch[3], 10)));
    const a = rgbaMatch[4] !== undefined ? clamp01(parseFloat(rgbaMatch[4])) : 1;
    return { r, g, b, a };
  }

  const hexMatch = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return { r, g, b, a: 1 };
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = clamp01(parseInt(hex.slice(6, 8), 16) / 255);
    return { r, g, b, a };
  }

  return { r: 0, g: 0, b: 0, a: 1 };
};

const applyMidpoint = (ratio: number, midpointPercent: number) => {
  const midpoint = clamp01((midpointPercent ?? 50) / 100);
  if (midpoint === 0.5) return ratio;
  if (midpoint <= 0) return 0;
  if (midpoint >= 1) return 1;
  if (ratio < midpoint) return (ratio / midpoint) * 0.5;
  return 0.5 + ((ratio - midpoint) / (1 - midpoint)) * 0.5;
};

const interpolateStops = (
  position: number,
  stops: ParsedStop[],
  getLeftValue: (s: ParsedStop) => number,
  getRightValue: (s: ParsedStop) => number
) => {
  let leftStop = stops[0];
  let rightStop = stops[stops.length - 1];

  for (let i = 0; i < stops.length - 1; i++) {
    if (stops[i].position <= position && stops[i + 1].position >= position) {
      leftStop = stops[i];
      rightStop = stops[i + 1];
      break;
    }
  }

  if (leftStop.position === rightStop.position) {
    return getLeftValue(leftStop);
  }

  let ratio = (position - leftStop.position) / (rightStop.position - leftStop.position);
  ratio = applyMidpoint(ratio, leftStop.midpoint);
  return getLeftValue(leftStop) * (1 - ratio) + getRightValue(rightStop) * ratio;
};

const createGradientSampler = (gradient: Gradient) => {
  const stops = gradient.stops || [];
  const reverse = !!gradient.reverse;

  const colorStops: ParsedStop[] = stops
    .map((s, i) => {
      const rgba = parseCssColorToRgba(s.color);
      return {
        position: (s.colorPosition ?? s.position ?? 0),
        r: rgba.r,
        g: rgba.g,
        b: rgba.b,
        a: rgba.a,
        midpoint: s.midpoint ?? (i < stops.length - 1 ? 50 : 50)
      };
    })
    .sort((a, b) => a.position - b.position);

  const opacityStops: ParsedStop[] = stops
    .map((s, i) => {
      const rgba = parseCssColorToRgba(s.color);
      return {
        position: (s.opacityPosition ?? s.position ?? 0),
        r: rgba.r,
        g: rgba.g,
        b: rgba.b,
        a: rgba.a,
        midpoint: s.midpoint ?? (i < stops.length - 1 ? 50 : 50)
      };
    })
    .sort((a, b) => a.position - b.position);

  return (percent: number) => {
    const normalizedPercent = Math.max(0, Math.min(100, percent));
    const p = reverse ? 100 - normalizedPercent : normalizedPercent;

    const r = interpolateStops(p, colorStops, s => s.r, s => s.r);
    const g = interpolateStops(p, colorStops, s => s.g, s => s.g);
    const b = interpolateStops(p, colorStops, s => s.b, s => s.b);
    const a = interpolateStops(p, opacityStops, s => s.a, s => s.a);

    return {
      r: Math.max(0, Math.min(255, Math.round(r))),
      g: Math.max(0, Math.min(255, Math.round(g))),
      b: Math.max(0, Math.min(255, Math.round(b))),
      a: clamp01(a)
    };
  };
};

export async function processBlockGradient(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: { width: number; height: number },
  gradient: Gradient,
  isBackgroundLayer: boolean = false
): Promise<Uint8Array> {
  const layerPixels = new Uint8Array(layerPixelData);
  const selectionPixels = new Uint8Array(selectionData);
  const result = new Uint8Array(layerPixels.length);
  result.set(layerPixels);

  const pixelCount = layerPixels.length / 4;
  const { width, height } = bounds;

  if (!gradient || !gradient.stops || gradient.stops.length === 0) {
    return result;
  }

  const sampleAtPercent = createGradientSampler(gradient);

  const selectionCoefficients = new Uint8Array(pixelCount);
  const hasSelection = selectionPixels.length > 0;
  if (!hasSelection) return result;

  if (selectionPixels.length === pixelCount) {
    for (let i = 0; i < pixelCount; i++) selectionCoefficients[i] = selectionPixels[i];
  } else if (selectionPixels.length === pixelCount * 4) {
    for (let i = 0; i < pixelCount; i++) selectionCoefficients[i] = selectionPixels[i * 4 + 3];
  } else {
    return result;
  }

  const visitedBits = new Uint32Array(Math.ceil(pixelCount / 32));
  const isVisited = (idx: number) => {
    const wordIdx = (idx / 32) | 0;
    const bitIdx = idx & 31;
    return (visitedBits[wordIdx] & (1 << bitIdx)) !== 0;
  };
  const setVisited = (idx: number) => {
    const wordIdx = (idx / 32) | 0;
    const bitIdx = idx & 31;
    visitedBits[wordIdx] |= (1 << bitIdx);
  };

  const queue = new Int32Array(pixelCount);
  const componentIdxs = new Int32Array(pixelCount);
  const regionIndexBuffer = new Int32Array(pixelCount);
  const regionOffsets: number[] = [];
  const regionLengths: number[] = [];
  const regionS: number[] = [];
  const regionCentroids: Array<{ x: number; y: number }> = [];
  let writePos = 0;

  const floodFill = (startIndex: number): number => {
    let qHead = 0;
    let qTail = 0;
    let compSize = 0;
    queue[qTail++] = startIndex;
    setVisited(startIndex);

    while (qHead < qTail) {
      const index = queue[qHead++];
      componentIdxs[compSize++] = index;
      const x = index % width;
      const y = (index / width) | 0;

      if (x + 1 < width) {
        const ni = index + 1;
        if (!isVisited(ni) && selectionCoefficients[ni] > 0) {
          setVisited(ni);
          queue[qTail++] = ni;
        }
      }
      if (x - 1 >= 0) {
        const ni = index - 1;
        if (!isVisited(ni) && selectionCoefficients[ni] > 0) {
          setVisited(ni);
          queue[qTail++] = ni;
        }
      }
      if (y + 1 < height) {
        const ni = index + width;
        if (!isVisited(ni) && selectionCoefficients[ni] > 0) {
          setVisited(ni);
          queue[qTail++] = ni;
        }
      }
      if (y - 1 >= 0) {
        const ni = index - width;
        if (!isVisited(ni) && selectionCoefficients[ni] > 0) {
          setVisited(ni);
          queue[qTail++] = ni;
        }
      }
    }
    return compSize;
  };

  const angleDeg = gradient.angle ?? 0;
  const angleRad = (angleDeg * Math.PI) / 180;
  const dirX = Math.cos(angleRad);
  const dirY = Math.sin(angleRad);

  for (let index = 0; index < pixelCount; index++) {
    if (selectionCoefficients[index] === 0 || isVisited(index)) continue;
    const compSize = floodFill(index);
    if (compSize <= 0) continue;

    let sumX = 0;
    let sumY = 0;
    let sumW = 0;
    for (let ci = 0; ci < compSize; ci++) {
      const idx = componentIdxs[ci];
      const w = selectionCoefficients[idx];
      const x = (idx % width) + 0.5;
      const y = ((idx / width) | 0) + 0.5;
      sumX += x * w;
      sumY += y * w;
      sumW += w;
    }
    const cx = sumW > 0 ? sumX / sumW : (index % width) + 0.5;
    const cy = sumW > 0 ? sumY / sumW : ((index / width) | 0) + 0.5;

    const offset = writePos;
    regionOffsets.push(offset);
    regionLengths.push(compSize);
    regionCentroids.push({ x: cx, y: cy });

    regionIndexBuffer.set(componentIdxs.subarray(0, compSize), writePos);
    writePos += compSize;
  }

  if (regionOffsets.length === 0) return result;

  let sMin = Infinity;
  let sMax = -Infinity;
  let centerX = 0;
  let centerY = 0;
  for (let i = 0; i < regionCentroids.length; i++) {
    centerX += regionCentroids[i].x;
    centerY += regionCentroids[i].y;
  }
  centerX /= regionCentroids.length;
  centerY /= regionCentroids.length;

  for (let i = 0; i < regionCentroids.length; i++) {
    const c = regionCentroids[i];
    let s = 0;
    if (gradient.type === 'radial') {
      const dx = c.x - centerX;
      const dy = c.y - centerY;
      s = Math.sqrt(dx * dx + dy * dy);
    } else {
      s = c.x * dirX + c.y * dirY;
    }
    regionS[i] = s;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }

  const denom = sMax - sMin;
  const preserveTransparency = !!gradient.preserveTransparency;
  const useAlpha = !isBackgroundLayer && !preserveTransparency;
  const writtenCount = writePos;
  const pixelsByRegion = regionIndexBuffer.subarray(0, writtenCount);

  for (let r = 0; r < regionOffsets.length; r++) {
    const t = denom > 0 ? (regionS[r] - sMin) / denom : 0.5;
    const percent = clamp01(t) * 100;
    const sampled = sampleAtPercent(percent);
    const fillA = useAlpha ? Math.round(sampled.a * 255) : 255;

    const start = regionOffsets[r];
    const end = start + regionLengths[r];
    for (let i = start; i < end; i++) {
      const idx = pixelsByRegion[i];
      const pIdx = idx << 2;
      if (!isBackgroundLayer && layerPixels[pIdx + 3] === 0) continue;
      result[pIdx] = sampled.r;
      result[pIdx + 1] = sampled.g;
      result[pIdx + 2] = sampled.b;
      if (isBackgroundLayer) {
        result[pIdx + 3] = 255;
      } else if (preserveTransparency) {
        result[pIdx + 3] = layerPixels[pIdx + 3];
      } else {
        result[pIdx + 3] = fillA;
      }
    }
  }

  return result;
}
