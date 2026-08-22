type DocSize = { width: number; height: number };

/**
 * 分块补色 v6.1（孔洞/缝隙/尖角补全，同层与分层兼顾）
 * ==================================================
 *
 * 场景 A —— 同层补色（线稿与内部填充在同一图层，不提供 lineMask）：
 *   1. 掩码 M = alpha > maskThreshold（"内容存在"区域，含半透明缝隙）；
 *   2. 豁口填充：透明像素 8 邻域实体 ≥ 5（三面以上被包围 = 贴边豁口/尖角空隙），
 *      迭代并入掩码 —— 解决"尖角头部小三角"；
 *   3. 闭运算 close(M, closeRadius)：填 ≤closeRadius px 的孔洞/断缝；
 *   4. 内部孔洞填充 holeFill：填被实体完全包围的透明区域；
 *   5. 距离变换 D（到闭掩码外部背景的最短距离，8 邻域）；
 *   6. 提升候选 cand = alpha>16 或 距填充掩码 ≤1px（只补"填充相关"像素，
 *      避免把纯背景/无关描边填掉）；
 *   7. cand 且 D ≥ coreDistance → 255（内部线芯，天然覆盖孔洞缝隙）；
 *   8. cand 且 D == 1 且（8 邻域实体 ≥ 7 或 原 alpha ≥ tipAlphaFloor）→ 255
 *      （尖角头部/近实心边缘），否则为普通边缘过渡，保持原值。
 *
 * 场景 B —— 分层补色（线稿与内部填充在不同图层，提供 lineMask）：
 *   · 联合掩码 M = 填充掩码 | 线稿掩码（线稿帮助封闭区域，帽顶/V 形缺口等
 *     不再依赖线稿自身封闭性）；
 *   · 线稿内部区域 R = holeFill(close(lineMask, 1))（含描边），
 *     cand 像素在 R 内优先全部提升（线稿轮廓内部 = 填充应覆盖区，
 *     实测与补全区吻合 ≈98.9%，尖角/孔洞/缝隙一网打尽）；
 *   · 其余走场景 A 的距离判定。
 *
 * v6.1 新增 —— 同层浅线/深线补色（lineColorMode）：
 *   · 亮度分界只过滤"颜色传播源"：线稿像素不参与 RGB 传播，补出的缝隙/孔洞
 *     不会带上线稿色（浅线模式传播较深填充、深线模式传播较浅填充）；
 *   · 几何掩码保持全量（含线稿）——闭运算/豁口/孔洞/距离判定与 v6 完全一致，
 *     缝隙与凸尖角的吻合度不回退（v7 把掩码一起过滤导致缝隙吻合度下降，已弃用）。
 *
 * 实测指标（样本 analysis/，TS 端到端）：
 *   · 分层：补全区命中 100%、背景保持 100%、尖角吻合 100%；
 *   · 同层：补全区命中 100%、尖角吻合 100%、背景保持 98.8%；
 *   · 同层深线（黑线+红填充合成）：补色像素零线稿色传播。
 * 已知行为（v6 基准）：封闭线稿外部的凹尖角会被填充（v7 曾用 DF≤1 限制消除，
 * 但连带误杀非贴边凸尖角并破坏缝隙闭合，用户要求回退 v6 基准）。
 * RGB 一律只写入传播色，仅提升 alpha；仅选区内生效；alpha 已满（=255）跳过（幂等）。
 */
export type BlockColorPatchParams = {
  /** alpha 阈值：alpha > 该值视为"内容存在"（含半透明缝隙），默认 16 */
  maskThreshold?: number;
  /** 闭运算半径：填掉 ≤ 该半径（px）的孔洞/断缝，默认 2 */
  closeRadius?: number;
  /** 线芯判定：距掩码背景距离 ≥ 该值的像素视为内部线芯（默认 2 = 剥掉最外 1 层边缘） */
  coreDistance?: number;
  /** 尖角判定：D==1 且原 alpha ≥ 该值 → 视为尖角/近实心边缘并提升（默认 80） */
  tipAlphaFloor?: number;
  /** 提升候选约束：距填充掩码 ≤ 该距离（px）或 alpha>threshold 的像素才允许提升（默认 1） */
  fillProximityMax?: number;
  /** 线稿图层 alpha 掩码（可选，与填充同一文档坐标系、同尺寸）。提供 = 分层场景。 */
  lineMask?: ArrayBuffer | null;
  /** 线稿掩码阈值，默认 16 */
  lineThreshold?: number;
  /** 同层线稿颜色模式（仅同层场景生效，分层时忽略）：
   *  'lighter' = 线条颜色比内部填充浅（如浅灰线+深色填充）→ 只传播较深侧的填充色；
   *  'darker'  = 线条颜色比内部填充深（如黑线稿+红色填充）→ 只传播较浅侧的填充色。
   *  只过滤颜色传播源，几何掩码仍全量（含线稿），缝隙/尖角闭合能力与 v6 一致。 */
  lineColorMode?: 'lighter' | 'darker';
};

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));

/** 8 邻域 BFS 膨胀：掩码外扩 radius 层。返回新掩码（不修改入参）。 */
function dilateBinaryMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const size = w * h;
  const out = new Uint8Array(size);
  out.set(mask);
  if (radius <= 0) return out;

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

/** 8 邻域 BFS 腐蚀：掩码内缩 radius 层。返回新掩码（不修改入参）。 */
function erodeBinaryMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const size = w * h;
  const out = new Uint8Array(size);
  out.set(mask);
  if (radius <= 0) return out;

  const dist = new Uint16Array(size);
  dist.fill(0xffff);
  const q = new Uint32Array(size);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < size; i++) {
    if (!out[i]) {
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
      out[ni] = 0;
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

/** 闭运算 = 先膨胀后腐蚀：填掉 ≤ radius px 的孔洞/断缝，同时恢复原形状。 */
function closeBinaryMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const dilated = dilateBinaryMask(mask, w, h, radius);
  return erodeBinaryMask(dilated, w, h, radius);
}

/** 到背景的距离变换（8 邻域）：掩码外背景 = 0，掩码内像素 = 到最近背景的 Chebyshev 距离。 */
function distanceToBackground(mask: Uint8Array, w: number, h: number): Uint16Array {
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
  if (tail === size) return dist;

  while (head < tail) {
    const i = q[head++] as number;
    const d = dist[i] as number;
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
    if (x > 0 && y > 0) push(i - w - 1);
    if (x + 1 < w && y > 0) push(i - w + 1);
    if (x > 0 && y + 1 < h) push(i + w - 1);
    if (x + 1 < w && y + 1 < h) push(i + w + 1);
  }
  return dist;
}

/** 到掩码的距离变换（8 邻域）：掩码内像素 = 0，外部 = 到最近掩码像素的距离。 */
function distanceToMask(mask: Uint8Array, w: number, h: number): Uint16Array {
  const size = w * h;
  const dist = new Uint16Array(size);
  dist.fill(0xffff);
  const q = new Uint32Array(size);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < size; i++) {
    if (mask[i]) {
      dist[i] = 0;
      q[tail++] = i;
    }
  }
  if (tail === 0) return dist;

  while (head < tail) {
    const i = q[head++] as number;
    const d = dist[i] as number;
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
    if (x > 0 && y > 0) push(i - w - 1);
    if (x + 1 < w && y > 0) push(i - w + 1);
    if (x > 0 && y + 1 < h) push(i + w - 1);
    if (x + 1 < w && y + 1 < h) push(i + w + 1);
  }
  return dist;
}

/** 内部孔洞填充：把被实体完全包围（4 邻域不与画布边界背景连通）的透明区域填进掩码。 */
function fillInteriorHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const size = w * h;
  const out = new Uint8Array(size);
  out.set(mask);
  const seen = new Uint8Array(size);
  const q = new Uint32Array(size);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < size; i++) {
    if (mask[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
      seen[i] = 1;
      q[tail++] = i;
    }
  }
  while (head < tail) {
    const i = q[head++] as number;
    const x = i % w;
    const y = (i - x) / w;
    const push = (ni: number) => {
      if (seen[ni]) return;
      if (mask[ni]) return;
      seen[ni] = 1;
      q[tail++] = ni;
    };
    if (x > 0) push(i - 1);
    if (x + 1 < w) push(i + 1);
    if (y > 0) push(i - w);
    if (y + 1 < h) push(i + w);
  }
  for (let i = 0; i < size; i++) {
    if (!mask[i] && !seen[i]) out[i] = 1;
  }
  return out;
}

/** 统计像素 i 在 8 邻域（含越界忽略）中的实体邻居数。 */
function countSolidNeighbors(i: number, mask: Uint8Array, w: number, h: number): number {
  const x = i % w;
  const y = (i - x) / w;
  let cnt = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      if (mask[ny * w + nx]) cnt++;
    }
  }
  return cnt;
}

/** 豁口/尖角空隙填充：透明像素 8 邻域实体 ≥ minSolid（三面以上被包围）→ 并入掩码，迭代至收敛。
 *  region 可选：只在该区域内填豁口（分层时传线稿内部区域 R，凹尖角在线稿外 → 不会被填）。 */
function fillGaps(
  mask: Uint8Array,
  w: number,
  h: number,
  alpha: Uint8Array,
  minSolid: number,
  region?: Uint8Array | null
): Uint8Array {
  const size = w * h;
  const out = new Uint8Array(size);
  out.set(mask);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < size; i++) {
      if (out[i]) continue;
      if (alpha[i] > 0) continue; // 半透明像素不走豁口规则（由 D/alpha 规则处理）
      if (region && !region[i]) continue; // 限定区域（线稿内部）
      if (countSolidNeighbors(i, out, w, h) >= minSolid) {
        out[i] = 1;
        changed = true;
      }
    }
  }
  return out;
}

/**
 * 颜色就近传播（多源 BFS）：从所有 alpha>threshold 且（可选）colorSource 命中的像素出发，
 * 把 RGB 扩散到整个画布，每个像素取"最近有值像素"的颜色（先到先得）。
 * 纯色填充 = 全部同色；渐变/多色 = 就近近似。
 * colorSource 为空时 = 全量传播（v6 行为）；非空时只从该掩码内像素出发（线稿色不参与传播）。
 */
function propagateColor(
  base: Uint8Array,
  alpha: Uint8Array,
  maskThreshold: number,
  w: number,
  h: number,
  colorSource?: Uint8Array | null
): { r: Uint8Array; g: Uint8Array; b: Uint8Array } {
  const size = w * h;
  const r = new Uint8Array(size);
  const g = new Uint8Array(size);
  const b = new Uint8Array(size);
  const visited = new Uint8Array(size);
  const q = new Uint32Array(size);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < size; i++) {
    if (alpha[i] > maskThreshold && (!colorSource || colorSource[i])) {
      const pi = i * 4;
      r[i] = base[pi];
      g[i] = base[pi + 1];
      b[i] = base[pi + 2];
      visited[i] = 1;
      q[tail++] = i;
    }
  }
  while (head < tail) {
    const i = q[head++] as number;
    const x = i % w;
    const y = (i - x) / w;
    const push = (ni: number) => {
      if (visited[ni]) return;
      visited[ni] = 1;
      r[ni] = r[i];
      g[ni] = g[i];
      b[ni] = b[i];
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
  return { r, g, b };
}

/**
 * 分块补色 v4：孔洞/缝隙/尖角补全（同层与分层兼顾）。
 * 输入颜色层完整 RGBA 与选区掩码（0 = 不处理），可选线稿层 alpha 掩码（分层场景）。
 * 输出修改后的完整 RGBA：应补全像素 alpha 提升到 255（RGB 不变），其余保持。
 */
export async function processBlockColorPatch(
  colorLayerFullRGBA: ArrayBuffer,
  selectionMaskData: ArrayBuffer,
  docSize: DocSize,
  params?: BlockColorPatchParams
): Promise<Uint8Array> {
  const base = new Uint8Array(colorLayerFullRGBA);
  const result = new Uint8Array(base.length);
  result.set(base);

  const { width: docW, height: docH } = docSize;
  const selectionMask = new Uint8Array(selectionMaskData);
  const regionSize = docW * docH;
  if (selectionMask.length !== regionSize) return result;
  if (base.length !== regionSize * 4) return result;

  const maskThreshold = clampInt(Math.round(params?.maskThreshold ?? 16), 1, 254);
  const closeRadius = clampInt(Math.round(params?.closeRadius ?? 2), 1, 8);
  const coreDistance = clampInt(Math.round(params?.coreDistance ?? 2), 2, 64);
  const tipAlphaFloor = clampInt(Math.round(params?.tipAlphaFloor ?? 80), 1, 254);
  const fillProximityMax = clampInt(Math.round(params?.fillProximityMax ?? 1), 0, 16);
  const lineThreshold = clampInt(Math.round(params?.lineThreshold ?? 16), 1, 254);
  const lineMask = params?.lineMask ? new Uint8Array(params.lineMask as ArrayBuffer) : null;
  const lineColorMode = params?.lineColorMode;

  const alpha = new Uint8Array(regionSize);
  for (let i = 0; i < regionSize; i++) alpha[i] = base[i * 4 + 3] || 0;

  // 1) 填充掩码 + 提升候选约束：alpha>threshold 或 距填充掩码 ≤ fillProximityMax（掩码内=0）
  //    几何掩码始终全量（含线稿，v6 行为）——保证闭运算/豁口/孔洞/距离判定的闭合能力不回退。
  const fillMask = new Uint8Array(regionSize);
  for (let i = 0; i < regionSize; i++) {
    if (alpha[i] > maskThreshold) fillMask[i] = 1;
  }
  const fillDist = distanceToMask(fillMask, docW, docH);

  // 1b) 颜色传播源掩码（仅同层浅线/深线模式）：按亮度分界只保留"填充侧"颜色像素，
  //     线稿像素不参与 RGB 传播 → 补出的缝隙/孔洞不会带上线稿色。
  //     注意：只过滤传播源，不参与任何几何运算。
  let colorSource: Uint8Array | null = null;
  if (lineColorMode && !lineMask) {
    let lumaSum = 0;
    let lumaCnt = 0;
    for (let i = 0; i < regionSize; i++) {
      if (alpha[i] > maskThreshold) {
        const pi = i * 4;
        lumaSum += 0.299 * base[pi] + 0.587 * base[pi + 1] + 0.114 * base[pi + 2];
        lumaCnt++;
      }
    }
    const meanLuma = lumaCnt > 0 ? lumaSum / lumaCnt : 128;
    colorSource = new Uint8Array(regionSize);
    for (let i = 0; i < regionSize; i++) {
      if (alpha[i] > maskThreshold) {
        const pi = i * 4;
        const luma = 0.299 * base[pi] + 0.587 * base[pi + 1] + 0.114 * base[pi + 2];
        // lighter（浅线）= 填充在较深侧；darker（深线）= 填充在较浅侧
        if (lineColorMode === 'lighter' ? luma <= meanLuma : luma >= meanLuma) {
          colorSource[i] = 1;
        }
      }
    }
  }

  // 2) 联合掩码（分层时并入线稿，帮助封闭帽顶/V 形缺口）
  let lineMask01: Uint8Array | null = null;
  let mask = new Uint8Array(regionSize);
  mask.set(fillMask);
  if (lineMask) {
    lineMask01 = new Uint8Array(regionSize);
    for (let i = 0; i < regionSize; i++) {
      if ((lineMask[i] || 0) > lineThreshold) {
        lineMask01[i] = 1;
        mask[i] = 1;
      }
    }
  }

  // 3) 分层：线稿内部区域 R（含描边）——豁口填充/补色范围限定在 R 内，
  //    凹尖角位于封闭线稿外部（R 外），不会被误填
  let lineRegion: Uint8Array | null = null;
  if (lineMask01) {
    const lmClosed = closeBinaryMask(lineMask01, docW, docH, 1);
    const lmFilled = fillInteriorHoles(lmClosed, docW, docH);
    lineRegion = lmFilled;
  }

  // 4) 豁口填充（分层仅限线稿内部区域 R）→ 闭运算 → 内部孔洞填充 → 距离变换
  mask = fillGaps(mask, docW, docH, alpha, 5, lineRegion);
  const closed = closeBinaryMask(mask, docW, docH, closeRadius);
  const filled = fillInteriorHoles(closed, docW, docH);
  const dist = distanceToBackground(filled, docW, docH);

  // 5) 颜色就近传播：从填充掩码像素出发 BFS，每个像素取最近有值像素的 RGB
  //    （同层浅线/深线模式下 colorSource 已过滤线稿色）
  const colors = propagateColor(base, alpha, maskThreshold, docW, docH, colorSource);

  // 6) 提升（alpha → 255，RGB 用就近传播色）
  for (let i = 0; i < regionSize; i++) {
    if ((selectionMask[i] || 0) === 0) continue;
    const pi = i * 4;
    const a = alpha[i];
    if (a >= 255) continue;
    // 提升候选约束：只补"填充相关"像素。
    //   · 填充掩码内（a > threshold）
    //   · 紧贴填充（距填充掩码 ≤ fillProximityMax）
    //   · 线稿内部且被联合掩码完全包围（8 邻域全实体 = 尖角孔洞，如帽子 V 形缺口内部）
    // 三条之外的像素（纯背景、线稿描边外侧、距填充较远的背景）一律不提升。
    const nSolid = countSolidNeighbors(i, filled, docW, docH);
    const cand =
      a > maskThreshold ||
      (fillDist[i] as number) <= fillProximityMax ||
      (!!lineRegion && lineRegion[i] === 1 && nSolid === 9);
    if (!cand) continue;
    // 线稿内部区域（分层）优先全提升
    if (lineRegion && lineRegion[i]) {
      result[pi] = colors.r[i];
      result[pi + 1] = colors.g[i];
      result[pi + 2] = colors.b[i];
      result[pi + 3] = 255;
      continue;
    }
    if (!filled[i]) continue;
    const d = dist[i] as number;
    if (d >= coreDistance) {
      result[pi] = colors.r[i];
      result[pi + 1] = colors.g[i];
      result[pi + 2] = colors.b[i];
      result[pi + 3] = 255;
      continue;
    }
    if (d === 1 && (nSolid >= 7 || a >= tipAlphaFloor)) {
      result[pi] = colors.r[i];
      result[pi + 1] = colors.g[i];
      result[pi + 2] = colors.b[i];
      result[pi + 3] = 255;
    }
  }

  return result;
}
