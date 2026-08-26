/**
 * 扣白 / 扣黑：把“曾在纯白（或纯黑）底上叠加的半透明色”反推回“透明底 + 原半透明色”。
 *
 * 数学模型（假设原始图层是统一源色 S、各像素 alpha 可不同）：
 *   扣白：out = S·a + 白·(1−a)  ⇒  a = (255 − out) / (255 − S)          （白底=255）
 *   扣黑：out = S·a + 黑·(1−a)  ⇒  a = out / S                         （黑底=0）
 *
 * 关键：alpha 不再固定，而是按像素“离背景色多远”逐像素反推 →
 *   越接近背景（白/黑）的像素 alpha 越低（趋近透明），
 *   越接近源色 S 的像素 alpha 越高（趋近不透明）。
 * 这样图层内不同区域（如线稿主体 50%、内部 75%、核心 87.5%）会还原出各自的 alpha，
 * 而不是被一个固定比例拉平。
 *
 * 距离度量用 Rec.709 亮度（Y = 0.299R + 0.587G + 0.114B）：
 *   对“某通道分母极小”的情况（如源色近纯红，R 通道 255−S≈0）仍稳定，避免单通道噪声。
 *
 * 源色 S 的估计：取选区（无选区=整层）内离背景色最远（最饱和）的非背景像素颜色。
 *   —— 若原图存在全不透明区域，该像素颜色就是 S，反推精确；
 *   —— 若原图最深处也不到 100% 不透明（如理想结果最深处 224 ≈ 87.8%），
 *       S 会略偏浅，需要把 KNOCK_MAX_ALPHA 调成该真实值（如 224）来标定绝对 alpha。
 *       数学上单张合并图无法唯一确定绝对 alpha（欠定），这是信息论极限。
 *
 * 背景识别：三通道均 ≥ WHITE_THRESHOLD（扣白）/ ≤ BLACK_THRESHOLD（扣黑）⇒ 视为背景，归零透明；
 * alpha=0 的透明像素保持透明。
 *
 * 性能：两遍扫描、整数亮度+预计算倒数、不分配大数组，原地修改 fullPixelData，适配低配机器。
 */
export type KnockoutMode = 'white' | 'black';

/**
 * 反推 alpha 的参考值 = “原图最深像素的真实不透明度”（0–255）。
 * 算法把最深像素的比例标定为 1，再乘该参考值得到绝对 alpha：alpha = ratio · KNOCK_MAX_ALPHA。
 * 默认 255 ⇒ 假设原图最深处 100% 不透明（标准 unmultiply）。
 * 若原图最深处只有部分不透明（如理想结果最大 224 ⇒ 87.8%），
 * 将其改为 224 即可精确还原原图分层 alpha（如 128/192/224 三档）。
 */
export const KNOCK_MAX_ALPHA = 255;

// 背景判定阈值
const WHITE_THRESHOLD = 252; // 三通道均 ≥ 该值 ⇒ 纯白背景
const BLACK_THRESHOLD = 2;   // 三通道均 ≤ 该值 ⇒ 纯黑背景

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
}

export function processKnockout(
  fullPixelData: Uint8Array,
  selectionIndices: ArrayLike<number>,
  mode: KnockoutMode
): void {
  const n = selectionIndices.length;
  const maxA = KNOCK_MAX_ALPHA;

  // ── Pass 1：估计源色 S = 离背景色最远的非背景像素 ──
  let sr = 0, sg = 0, sb = 0;
  let bestDist = -1;
  if (mode === 'white') {
    for (let k = 0; k < n; k++) {
      const p = selectionIndices[k] * 4;
      if (fullPixelData[p + 3] === 0) continue;
      const r = fullPixelData[p];
      const g = fullPixelData[p + 1];
      const b = fullPixelData[p + 2];
      if (r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD) continue;
      const d = (255 - r) * (255 - r) + (255 - g) * (255 - g) + (255 - b) * (255 - b);
      if (d > bestDist) { bestDist = d; sr = r; sg = g; sb = b; }
    }
  } else {
    for (let k = 0; k < n; k++) {
      const p = selectionIndices[k] * 4;
      if (fullPixelData[p + 3] === 0) continue;
      const r = fullPixelData[p];
      const g = fullPixelData[p + 1];
      const b = fullPixelData[p + 2];
      if (r <= BLACK_THRESHOLD && g <= BLACK_THRESHOLD && b <= BLACK_THRESHOLD) continue;
      const d = r * r + g * g + b * b;
      if (d > bestDist) { bestDist = d; sr = r; sg = g; sb = b; }
    }
  }
  if (bestDist < 0) return; // 全是背景/透明，无可处理像素

  // 源色亮度（×1000 定点），预计算反推系数（避免循环内除法）
  const ys = 299 * sr + 587 * sg + 114 * sb; // S 的亮度 ×1000
  let invDen = 0;
  if (mode === 'white') {
    const den = 255000 - ys; // 白底：分母 = (255 − Y(S)) ×1000
    invDen = den > 0 ? 1 / den : 0;
  } else {
    invDen = ys > 0 ? 1 / ys : 0; // 黑底：分母 = Y(S) ×1000
  }

  // ── Pass 2：逐像素按亮度反推 alpha，颜色还原为源色 S ──
  for (let k = 0; k < n; k++) {
    const p = selectionIndices[k] * 4;
    if (fullPixelData[p + 3] === 0) continue; // 透明：保持透明（图层外/透明区不当作背景）
    const r = fullPixelData[p];
    const g = fullPixelData[p + 1];
    const b = fullPixelData[p + 2];

    if (mode === 'white') {
      if (r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD) {
        fullPixelData[p] = 0;
        fullPixelData[p + 1] = 0;
        fullPixelData[p + 2] = 0;
        fullPixelData[p + 3] = 0;
        continue;
      }
      const y = 299 * r + 587 * g + 114 * b; // 像素亮度 ×1000
      let ratio = (255000 - y) * invDen;
      if (ratio < 0) ratio = 0; else if (ratio > 1) ratio = 1;
      fullPixelData[p] = sr;
      fullPixelData[p + 1] = sg;
      fullPixelData[p + 2] = sb;
      fullPixelData[p + 3] = clampByte(ratio * maxA);
    } else {
      if (r <= BLACK_THRESHOLD && g <= BLACK_THRESHOLD && b <= BLACK_THRESHOLD) {
        fullPixelData[p] = 0;
        fullPixelData[p + 1] = 0;
        fullPixelData[p + 2] = 0;
        fullPixelData[p + 3] = 0;
        continue;
      }
      const y = 299 * r + 587 * g + 114 * b; // 像素亮度 ×1000
      let ratio = y * invDen;
      if (ratio < 0) ratio = 0; else if (ratio > 1) ratio = 1;
      fullPixelData[p] = sr;
      fullPixelData[p + 1] = sg;
      fullPixelData[p + 2] = sb;
      fullPixelData[p + 3] = clampByte(ratio * maxA);
    }
  }
}
