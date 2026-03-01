type DocSize = { width: number; height: number };
type Rect = { left: number; top: number; width: number; height: number };

export type BlockColorPatchParams = {
  /**
   * 补色传播的最大“步数”（以像素为单位的近似距离）。
   * 数值越大，颜色会从已有颜色区域向外扩散得更远。
   */
  maxDistance: number;
  /**
   * 线稿识别灵敏度（1-10）。
   * 数值越大越“容易把像素当作线”，更倾向于把浅灰/虚边也当作阻挡边界。
   */
  lineSensitivity: number;
  /**
   * 线稿“变粗”的强度（0-6）。
   * 主要用于让边界更厚，从而减少颜色穿线的概率。
   */
  lineGrow: number;
  /**
   * 认为“可被覆盖”的透明度阈值：原像素 alpha 小于等于该值时才允许写入补色。
   */
  emptyAlphaThreshold?: number;
  /**
   * 作为“种子颜色”的透明度阈值：alpha 大于该值的像素会被当作颜色源点。
   */
  seedAlphaThreshold?: number;
  /**
   * 在线稿参考里，alpha 大于该值的像素才会参与“是否为线”的判断。
   */
  lineAlphaThreshold?: number;
};

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));

/**
 * 线稿参考像素可能是 RGB 或 RGBA。
 * 这里把它统一成 RGBA，方便后续用 alpha/亮度去判断“哪里是线、哪里不是线”。
 */
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

/**
 * 在不同线稿/不同亮度分布下，固定阈值很容易误判。
 * 这里通过采样线稿参考的亮度直方图，估一个“把暗像素当作线”的亮度阈值。
 * lineSensitivity 越高，阈值会更宽松（更容易判定为线）。
 */
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

/**
 * 二值掩码膨胀：把 1 的区域向外“扩一圈”。
 * 可以把细线变粗、填平小缝，减少颜色从边界漏出去的概率。
 */
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

/**
 * 二值掩码腐蚀：把 1 的区域向内“缩一圈”。
 * 常与膨胀配合使用，用于消除小凸起或噪点。
 */
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

/**
 * 闭运算：先膨胀、再腐蚀。
 * 直观效果：让边界更“连续”，把小洞/小断裂补起来。
 */
function closeBinaryMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const dilated = dilateBinaryMask(mask, w, h, radius);
  return erodeBinaryMask(dilated, w, h, radius);
}

/**
 * 粗略估计线条“半宽”（越大代表线越粗）。
 * 用法：根据线条粗细自适应调整一些半径参数，让算法在不同分辨率/线稿粗细下表现更稳定。
 */
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

/**
 * 从画面边缘开始“灌水”，找出被边界隔开的“外部区域”。
 * barrier=1 表示不可穿越的墙（线条/边界），返回 outside=1 表示能从边缘连通到的区域。
 */
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
  lineRefPixelsRaw: ArrayBuffer,
  params: BlockColorPatchParams
): Promise<Uint8Array> {
  /**
   * 这个函数做的事（非代码视角）：
   * 1) 把线稿参考层识别成“不可跨越的边界”（barrier）。
   * 2) 在 ROI 范围内，从已有颜色像素出发，把颜色向四周扩散（BFS/泛洪），但不允许穿过边界。
   * 3) 只把扩散到的颜色写回到“需要补色”的位置（原像素很透明），从而实现“分块补色/补洞”。
   *
   * 输入里有两个关键图层：
   * - colorLayerFullRGBA：当前要被补色的颜色层（会被读，并在 result 里写回）。
   * - lineRefPixelsRaw：线稿参考层（只用于识别边界，不直接写回）。
   */
  const base = new Uint8Array(colorLayerFullRGBA);
  const result = new Uint8Array(base.length);
  result.set(base);

  const { width: docW, height: docH } = docSize;
  const selectionMask = new Uint8Array(selectionMaskData);
  if (selectionMask.length !== docW * docH) return result;
  if (base.length !== docW * docH * 4) return result;

  // 参数保护：maxDistance 为 0 代表不做补色，直接返回原图。
  const maxDistance = clampInt(Math.round(params.maxDistance || 0), 0, 200);
  if (maxDistance <= 0) return result;

  const regionW = docW;
  const regionH = docH;
  const regionSize = regionW * regionH;

  const raw = new Uint8Array(lineRefPixelsRaw);
  if (raw.length !== regionSize * 4 && raw.length !== regionSize * 3) return result;
  const lineRGBA = normalizePixelsToRGBA(raw, regionSize);

  // 把参数“钳制”到安全范围内，避免极端值带来性能/效果问题。
  const emptyAlphaThreshold = clampInt(Math.round(params.emptyAlphaThreshold ?? 16), 0, 255);
  const seedAlphaThreshold = clampInt(Math.round(params.seedAlphaThreshold ?? 16), 0, 255);
  const lineAlphaThreshold = clampInt(Math.round(params.lineAlphaThreshold ?? 8), 0, 255);

  // barrier0：线稿边界二值图（1=边界/不可跨越，0=可通行）。
  const barrier0 = new Uint8Array(regionSize);
  const effectiveLineAlphaThreshold = lineAlphaThreshold;

  // 第一步：从线稿参考里提取边界 barrier0（只按 alpha 判断）。
  for (let i = 0; i < regionSize; i++) {
    const a = lineRGBA[i * 4 + 3] || 0;
    if (a <= effectiveLineAlphaThreshold) continue;
    barrier0[i] = 1;
  }

  const lineHalfWidth = estimateBinaryMaskHalfWidth(barrier0, regionW, regionH, 8);
  const lineScale = clampInt(lineHalfWidth, 1, 6);
  const barrierCross = barrier0;

  const outside = floodFillOutsideRegion(barrier0, regionW, regionH);
  const paintLimit = new Uint8Array(regionSize);
  for (let i = 0; i < regionSize; i++) {
    paintLimit[i] = outside[i] || barrier0[i] ? 0 : 1;
  }

  const selectionROI = new Uint8Array(regionSize);
  let selectedCount = 0;
  for (let i = 0; i < regionSize; i++) {
    if ((selectionMask[i] || 0) === 0) continue;
    selectedCount++;
    selectionROI[i] = 1;
  }
  const initialSelectionRatio = selectedCount / Math.max(1, regionSize);
  const useAutoFillArea = selectedCount === 0 || initialSelectionRatio > 0.985;

  const allowRadius = clampInt(Math.round(maxDistance + 2), 2, 80);
  let allowedROI: Uint8Array;
  if (useAutoFillArea) {
    let seedIndex = -1;
    let seedIndexNotNearLine = -1;
    for (let i = 0; i < regionSize; i++) {
      if (!paintLimit[i]) continue;
      if ((selectionMask[i] || 0) === 0) continue;
      const a = base[i * 4 + 3] || 0;
      if (a <= seedAlphaThreshold) continue;
      if (seedIndex < 0) seedIndex = i;
      const x = i % regionW;
      const y = (i - x) / regionW;
      let near = false;
      if (barrier0[i]) near = true;
      else if (x > 0 && barrier0[i - 1]) near = true;
      else if (x + 1 < regionW && barrier0[i + 1]) near = true;
      else if (y > 0 && barrier0[i - regionW]) near = true;
      else if (y + 1 < regionH && barrier0[i + regionW]) near = true;
      if (!near) {
        seedIndexNotNearLine = i;
        break;
      }
    }
    if (seedIndexNotNearLine >= 0) seedIndex = seedIndexNotNearLine;
    if (seedIndex < 0) {
      for (let i = 0; i < regionSize; i++) {
        if (!paintLimit[i]) continue;
        if ((selectionMask[i] || 0) === 0) continue;
        const a = base[i * 4 + 3] || 0;
        if (a <= 1) continue;
        seedIndex = i;
        break;
      }
    }
    if (seedIndex < 0) return result;

    const component = new Uint8Array(regionSize);
    component[seedIndex] = 1;
    const compQ = new Uint32Array(regionSize);
    let compHead = 0;
    let compTail = 0;
    compQ[compTail++] = seedIndex;
    while (compHead < compTail) {
      const i = compQ[compHead++] as number;
      const x = i % regionW;
      const y = (i - x) / regionW;
      const tryPush = (ni: number) => {
        if (component[ni]) return;
        if (!paintLimit[ni]) return;
        if ((selectionMask[ni] || 0) === 0) return;
        component[ni] = 1;
        compQ[compTail++] = ni;
      };
      if (x > 0) tryPush(i - 1);
      if (x + 1 < regionW) tryPush(i + 1);
      if (y > 0) tryPush(i - regionW);
      if (y + 1 < regionH) tryPush(i + regionW);
    }

    selectionROI.set(component);
    allowedROI = component;
  } else {
    for (let i = 0; i < regionSize; i++) {
      if (!selectionROI[i]) continue;
      if (paintLimit[i]) continue;
      selectionROI[i] = 0;
    }

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
  const nearLineOverwriteAlphaThreshold = clampInt(64 + lineScale * 8, 64, 140);
  const nearColorOverwriteAlphaThreshold = 20;

  // 第五步：收集“种子颜色”（颜色传播的起点）。
  // 默认尽量避免贴线取样，减少把线色/灰边当作颜色源点带来的污染。
  const isNearLine = (rx: number, ry: number, ri: number) => {
    if (barrier0[ri]) return true;
    if (rx > 0 && barrier0[ri - 1]) return true;
    if (rx + 1 < regionW && barrier0[ri + 1]) return true;
    if (ry > 0 && barrier0[ri - regionW]) return true;
    if (ry + 1 < regionH && barrier0[ri + regionW]) return true;
    return false;
  };

  const trySeed = (threshold: number, forbidNearLine: boolean) => {
    for (let ri = 0; ri < regionSize; ri++) {
      if (!allowedROI[ri]) continue;
      if (barrierCross[ri]) continue;
      if (forbidNearLine) {
        const rx = ri % regionW;
        const ry = (ri - rx) / regionW;
        if (isNearLine(rx, ry, ri)) continue;
      }
      const pi = ri * 4;
      const a = base[pi + 3] || 0;
      if (a <= threshold) continue;
      dist[ri] = 0;
      colorPacked[ri] = packRGBA(base[pi] || 0, base[pi + 1] || 0, base[pi + 2] || 0, 255);
      q[tail++] = ri;
      seedCount++;
    }
  };

  trySeed(seedAlphaThreshold, true);
  if (seedCount === 0) {
    // 兜底：如果完全找不到种子，就降低阈值并允许贴线取样，保证算法至少能“动起来”。
    trySeed(1, false);
  }

  if (seedCount === 0) return result;

  const useDistanceLimit = !useAutoFillArea;

  // 第六步：BFS 泛洪传播。
  // dist 保存“离最近种子有多远”，colorPacked 保存“传播到这里的颜色是什么”。
  while (head < tail) {
    const ri = q[head++] as number;
    const d = dist[ri] as number;
    if (useDistanceLimit && d >= maxDistance) continue;

    const rx = ri % regionW;
    const ry = (ri - rx) / regionW;
    const nd = d >= 65534 ? 65534 : d + 1;
    const color = colorPacked[ri] || 0;

    const tryVisit = (nrx: number, nry: number, nRi: number) => {
      if (dist[nRi] !== 0xffff) return;
      if (barrierCross[nRi]) return;
      if (!allowedROI[nRi]) return;
      dist[nRi] = nd as any;
      colorPacked[nRi] = color;
      q[tail++] = nRi;
    };

    if (rx > 0) tryVisit(rx - 1, ry, ri - 1);
    if (rx + 1 < regionW) tryVisit(rx + 1, ry, ri + 1);
    if (ry > 0) tryVisit(rx, ry - 1, ri - regionW);
    if (ry + 1 < regionH) tryVisit(rx, ry + 1, ri + regionW);
  }

  // 第七步：写回结果。
  // 仅对 selectionROI 内的像素写回，并且只覆盖原本“很透明/接近空”的像素，避免破坏已有涂色。
  for (let ri = 0; ri < regionSize; ri++) {
    if (!selectionROI[ri] && !(useAutoFillArea && barrierCross[ri])) continue;
    const rx = ri % regionW;
    const ry = (ri - rx) / regionW;
    const pi = ri * 4;
    const a = base[pi + 3] || 0;

    let c = 0;
    if (dist[ri] !== 0xffff) {
      c = colorPacked[ri] || 0;
    } else if (barrierCross[ri]) {
      if (rx > 0 && dist[ri - 1] !== 0xffff) c = colorPacked[ri - 1] || 0;
      else if (rx + 1 < regionW && dist[ri + 1] !== 0xffff) c = colorPacked[ri + 1] || 0;
      else if (ry > 0 && dist[ri - regionW] !== 0xffff) c = colorPacked[ri - regionW] || 0;
      else if (ry + 1 < regionH && dist[ri + regionW] !== 0xffff) c = colorPacked[ri + regionW] || 0;
    }
    if (c === 0) continue;

    let overwriteLimit = emptyAlphaThreshold;
    if (isNearLine(rx, ry, ri)) {
      overwriteLimit = nearLineOverwriteAlphaThreshold;
    } else {
      let nearExistingColor = false;
      if (rx > 0) {
        if ((base[(ri - 1) * 4 + 3] || 0) > seedAlphaThreshold) nearExistingColor = true;
      }
      if (!nearExistingColor && rx + 1 < regionW) {
        if ((base[(ri + 1) * 4 + 3] || 0) > seedAlphaThreshold) nearExistingColor = true;
      }
      if (!nearExistingColor && ry > 0) {
        if ((base[(ri - regionW) * 4 + 3] || 0) > seedAlphaThreshold) nearExistingColor = true;
      }
      if (!nearExistingColor && ry + 1 < regionH) {
        if ((base[(ri + regionW) * 4 + 3] || 0) > seedAlphaThreshold) nearExistingColor = true;
      }
      if (nearExistingColor) {
        overwriteLimit = Math.max(overwriteLimit, nearColorOverwriteAlphaThreshold);
        const d0 = dist[ri] as number;
        if (d0 !== 0xffff && d0 <= 2) overwriteLimit = Math.max(overwriteLimit, 80);
      }
    }
    if (barrierCross[ri]) overwriteLimit = 255;
    if (a > overwriteLimit) continue;
    result[pi] = unpackR(c);
    result[pi + 1] = unpackG(c);
    result[pi + 2] = unpackB(c);
    result[pi + 3] = unpackA(c);
  }

  return result;
}
