// alpha对齐 算法
//
// 目标：画师用半透明（带羽化）笔刷画线时，两笔交叉处会因不透明度叠加而形成一个
//       较"深"（不透明度更高）的暗点。本算法把这种局部凸起的 alpha 拉回到周围线条
//       的自然水平，使交叉点与周边自然衔接，几乎看不出不透明度异常提高。
//
// 核心思路（多尺度环形邻域最大值取最小值作为局部参照）：
//   - 只处理"选区内 alpha > 0"的像素作为修改候选；只改 alpha，RGB 保持不变。
//   - 环形邻域的参考像素是**所有画过的线条像素**（alpha ≥ MIN_ALPHA），不受选区限制。
//     这样做是为了：小选区也能引用选区外的线条找到"单线水平"，真正统一交叉点；
//     选区只决定"哪些像素会被修改"，不影响"在哪里找参考"。
//   - 对每个候选像素，在多个尺度的"环形邻域"上分别取**最大** alpha：
//       环形内半径 k、外半径 k+ringWidth（Chebyshev 距离）。
//     取 MAX 的关键原因：Chebyshev 方形环的"角"能沿对角线方向探到交叉凸包外侧的
//     单线像素（alpha = 线中心水平，与线宽/笔刷软硬无关）。因此：
//       - 交叉中心/边缘像素：小尺度环被凸包主导（MAX 高），大尺度环的"角"探到单线
//         （MAX = 线中心水平），对各尺度取 min → 单线水平，一次拉平整个凸包
//       - 单线像素：任意尺度环的 MAX = 自身线中心水平，peak=0 不误伤（无侵蚀）
//       - 无固定阈值 → 自动适配任意不透明度（30%~70% 已验证）与任意线宽（4px~200px）
//   - 通过 minAlpha 排除没擦干净的极低不透明度残留；通过 peakThresh 忽略
//     微小抖动与抗锯齿噪声。
//   - 选区边缘用 support 羽化（参考 specialSharpen），避免边界生硬。
//   - rate = strength（默认 1.0），把交叉点完全拉到单线水平，无残留。
//
// 说明：本函数只修改 alpha 通道，RGB 保持不变（图层存储的是 straight alpha，颜色
//       不随不透明度改变）。
//       返回的 out 数组与 layerPixelData 同尺寸；调用方按选区系数混合后再写回图层。

type Bounds = { width: number; height: number };

export type AlphaAlignParams = {
  strength?: number; // 0~1，默认 1，整体缩放拉回比例
  // 模式选择：
  //   'standard'（默认）：环形邻域取 MAX。细线/软笔刷友好，单线不被侵蚀；
  //     但粗线（≥70px）交叉凸包的"轴方向"区域环探不到单线（环一出凸包就出线），
  //     只能统一凸包的一部分（表现为"只改中心小矩形"）。
  //   'thick'：环形邻域取 MIN。硬笔刷粗线交叉凸包（含轴方向）能完整统一到单线水平，
  //     但对软笔刷（渐变边缘）会把单线中心错误拉低——建议硬笔刷/高硬度线稿用。
  mode?: 'standard' | 'thick';
};

const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));

// 算法核心常量（提升到模块级，供分块处理计算邻域 halo 与复用）
const RING_WIDTH = 3;                 // 每个环形邻域的宽度
const SCALES = [4, 8, 14, 22, 32, 50, 70]; // 环形内半径（覆盖细线到 200px 粗线的交叉点）
const MIN_ALPHA = 32;                 // 低于该不透明度视为残留/噪声，不参与
const PEAK_THRESH = 5;                // 凸起高出局部线条水平的最小量（降低以捕捉弱凸起）
const FEATHER_RADIUS = 20;            // 选区边缘羽化半径（参考 specialSharpen，让过渡更柔）

// 分块处理所需的最大邻域半径（halo），保证块边缘像素也能取到完整的环形邻域
export const ALPHA_ALIGN_HALO = SCALES[SCALES.length - 1] + RING_WIDTH + 2; // = 75

export async function processAlphaAlign(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: Bounds,
  params: AlphaAlignParams = {},
  isBackgroundLayer: boolean = false
): Promise<Uint8Array> {
  const width = Math.max(1, bounds.width | 0);
  const height = Math.max(1, bounds.height | 0);
  const pixelCount = width * height;

  const pixels = new Uint8Array(layerPixelData);
  const selectionMask = new Uint8Array(selectionData);
  const out = new Uint8Array(pixels.length);
  out.set(pixels);

  // 该功能仅适用于普通（非背景）像素图层；背景图层由调用方拦截，这里兜底直接返回。
  if (isBackgroundLayer) return out;
  if (pixels.length < pixelCount * 4) return out;

  // 可调参数（经验值，针对半透明羽化笔刷的交叉点）
  const strength = clamp01(typeof params.strength === 'number' ? params.strength : 1);
  // 模式：standard = 环 MAX（细线/软笔刷友好）；thick = 环 MIN（硬笔刷粗线凸包全改）
  const useMin = params.mode === 'thick';
  const minAlpha = MIN_ALPHA;
  const peakThresh = PEAK_THRESH;
  const ringWidth = RING_WIDTH;
  const scales = SCALES;
  const rate = strength;           // 拉回比例（1.0 时完全统一到单线水平）

  // 1. 构建全图 alpha 与 valid（选区内且 alpha>0），并求选区的包围盒
  const alpha = new Uint8Array(pixelCount);
  const valid = new Uint8Array(pixelCount);
  let minX = width, minY = height, maxX = -1, maxY = -1, validCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    const a = pixels[i * 4 + 3] || 0;
    const s = selectionMask[i] || 0;
    const v = (s > 0 && a > 0) ? 1 : 0;
    valid[i] = v;
    alpha[i] = a;
    if (v) {
      validCount++;
      const x = i % width;
      const y = (i - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (validCount === 0) {
    console.log('🔍 [alpha对齐] validCount=0（选区内没有 alpha>0 的像素），直接返回');
    return out;
  }
  console.log('🔍 [alpha对齐] 尺寸=' + width + 'x' + height + ' validCount=' + validCount +
    ' 选区包围盒=(' + minX + ',' + minY + ')→(' + maxX + ',' + maxY + ')');

  // 2. 只处理“选区包围盒 + 外扩”区域，节省内存
  const maxK = scales[scales.length - 1];
  const pad = maxK + ringWidth + 2;
  const x0 = minX - pad < 0 ? 0 : minX - pad;
  const y0 = minY - pad < 0 ? 0 : minY - pad;
  const x1 = maxX + pad >= width ? width - 1 : maxX + pad;
  const y1 = maxY + pad >= height ? height - 1 : maxY + pad;
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  const rn = rw * rh;

  const aR = new Float32Array(rn); // 区域 alpha
  const vR = new Float32Array(rn); // 区域 valid（0/1）
  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    for (let rx = 0; rx < rw; rx++) {
      const docX = x0 + rx;
      const di = docY * width + docX;
      const ri = ry * rw + rx;
      aR[ri] = alpha[di];
      vR[ri] = valid[di];
    }
  }

  // 3. 计算每个尺度的环形邻域统计量，并对各尺度取最小值作为"线条水平"
  //    统计量取决于模式：
  //    - standard（环 MAX）：Chebyshev 方形环的"角"沿对角线探到交叉凸包外侧的
  //      单线像素（alpha = 线中心水平，与笔刷软硬/线宽无关）。交叉中心/边缘像素
  //      靠大尺度环探到单线（对各尺度取 min）；单线像素任意尺度 MAX = 自身，
  //      peak=0 不误伤。无固定阈值 → 自动适配任意不透明度与细/中线宽。
  //      局限：粗线（≥70px）交叉凸包的"轴方向"像素（两条线垂直距离都接近半宽）
  //      的环一旦出凸包就同时出线（无单线过渡带），MAX 探不到 → 只改凸包一部分。
  //    - thick（环 MIN）：粗线凸包的轴方向像素环 MIN 能探到附近单线（线水平），
  //      凸包（含轴方向）能完整统一；但软笔刷渐变边缘会被当作参照（侵蚀单线），
  //      适合硬笔刷/高硬度线稿。
  const refMin = new Float32Array(rn);
  refMin.fill(65535);
  for (let s = 0; s < scales.length; s++) {
    const k = scales[s];
    const inner = k;
    const outer = k + ringWidth;
    for (let ry = 0; ry < rh; ry++) {
      for (let rx = 0; rx < rw; rx++) {
        const ri = ry * rw + rx;
        if (vR[ri] === 0) continue;
        if (aR[ri] < minAlpha) continue;
        // m = 本尺度环上 alpha≥MIN_ALPHA 像素的统计值；
        //    useMin: 最小值（65535 = 环内无有效参照）
        //    !useMin: 最大值（0 = 环内无有效参照）
        let m = useMin ? 65535 : 0;
        for (let dy = -outer; dy <= outer; dy++) {
          const ny = ry + dy;
          if (ny < 0 || ny >= rh) continue;
          const ady = dy < 0 ? -dy : dy;
          const rowBase = ny * rw;
          for (let dx = -outer; dx <= outer; dx++) {
            const adx = dx < 0 ? -dx : dx;
            const cd = ady > adx ? ady : adx; // Chebyshev 距离
            if (cd < inner || cd > outer) continue;
            const nx = rx + dx;
            if (nx < 0 || nx >= rw) continue;
            const ni = rowBase + nx;
            // 环形邻域参考所有"画过的线条像素"（alpha ≥ MIN_ALPHA），不受选区限制；
            // 这样小选区也能引用选区外的线条找到"单线水平"，真正统一交叉点。
            if (aR[ni] < MIN_ALPHA) continue;
            const a = aR[ni];
            if (useMin) { if (a < m) m = a; }
            else if (a > m) m = a;
          }
        }
        if ((useMin ? m < 65535 : m > 0) && m < refMin[ri]) refMin[ri] = m;
      }
    }
  }

  // 3.5. 计算选区边缘羽化 support（参考 specialSharpen 的思路）
  //    support[ri] = 该像素被多少"被选中的像素"围绕（高斯加权），0~1。
  //    选区内部 support≈1，边缘 support<1，外部 support=0。
  //    后续 step 4 用 support 做 alpha 改动的羽化，避免"选区边界生硬"。
  const featherRadius = FEATHER_RADIUS;
  const featherSigma = featherRadius * 0.5;
  const featherKSize = featherRadius * 2 + 1;
  const featherK = new Float32Array(featherKSize);
  let featherKSum = 0;
  for (let i = 0; i < featherKSize; i++) {
    const x = i - featherRadius;
    const v = Math.exp(-(x * x) / (2 * featherSigma * featherSigma));
    featherK[i] = v;
    featherKSum += v;
  }
  for (let i = 0; i < featherKSize; i++) featherK[i] /= featherKSum;

  // 分离高斯：先水平后垂直
  const supportH = new Float32Array(rn);
  const support = new Float32Array(rn);
  // 水平
  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    const rowBaseDoc = docY * width;
    for (let rx = 0; rx < rw; rx++) {
      const ri = ry * rw + rx;
      let weightSum = 0;
      let maskWeightSum = 0;
      for (let i = 0; i < featherKSize; i++) {
        const sx = x0 + rx + i - featherRadius;
        if (sx < 0 || sx >= width) continue;
        const k = featherK[i];
        const m = selectionMask[rowBaseDoc + sx] || 0;
        weightSum += k;
        maskWeightSum += k * (m / 255);
      }
      supportH[ri] = weightSum > 0 ? maskWeightSum / weightSum : 0;
    }
  }
  // 垂直
  for (let rx = 0; rx < rw; rx++) {
    for (let ry = 0; ry < rh; ry++) {
      const ri = ry * rw + rx;
      let weightSum = 0;
      let maskWeightSum = 0;
      for (let i = 0; i < featherKSize; i++) {
        const sy = y0 + ry + i - featherRadius;
        const k = featherK[i];
        // 关键修复：kernel weight 必须累加（即使像素超出区域也要算入归一化分母），
        // 同时检查区域边界（sy - y0 必须在 [0, rh-1]）否则会读到 undefined → NaN → fade=NaN → alpha=0
        weightSum += k;
        if (sy < 0 || sy >= height) continue;
        const ryOffset = sy - y0;
        if (ryOffset < 0 || ryOffset >= rh) continue;
        const v = supportH[ryOffset * rw + rx];
        maskWeightSum += k * v;
      }
      support[ri] = weightSum > 0 ? maskWeightSum / weightSum : 0;
    }
  }

  // 4. 对每个候选像素，把高出“线条水平”的 alpha 拉低
  let changedCount = 0;
  let changedSample = '';

  // 诊断：统计每个候选像素被跳过的原因，定位"无现象"问题
  let skipLowAlpha = 0;     // a < minAlpha
  let skipNoRef = 0;        // refMin >= 65535（环上找不到 alpha>=MIN_ALPHA 的参照）
  let skipSmallPeak = 0;    // peak < peakThresh
  let maxPeak = 0;          // 所有候选像素中最大的 peak（用来判断是否阈值卡得太严）
  let maxPeakInfo = '';     // 最大 peak 像素的信息
  // alpha 直方图（仅统计候选像素 a>=minAlpha 的部分）
  let histLow = 0, histMid = 0, histHigh = 0, histSat = 0; // <64, 64-128, 129-220, 221-255

  // 选区边缘羽化（参考 specialSharpen）：用 support 值把 alpha 改动从"全改"渐变到"不改"，
  // 避免选区边界生硬。smootherstep 双层套用让过渡更平滑。
  const smootherstep01 = (t: number) => {
    const x = Math.max(0, Math.min(1, t));
    return x * x * x * (x * (x * 6 - 15) + 10);
  };

  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    for (let rx = 0; rx < rw; rx++) {
      const ri = ry * rw + rx;
      if (vR[ri] === 0) continue;
      const a = aR[ri];
      if (a < minAlpha) { skipLowAlpha++; continue; }

      // alpha 直方图
      if (a < 64) histLow++;
      else if (a <= 128) histMid++;
      else if (a <= 220) histHigh++;
      else histSat++;

      const ref = refMin[ri];
      if (ref >= 65535) { skipNoRef++; continue; } // 孤立像素，无可用参照

      const peak = a - ref;
      if (peak > maxPeak) {
        maxPeak = peak;
        maxPeakInfo = '[' + (x0 + rx) + ',' + docY + '] a=' + a + ' ref=' + ref + ' peak=' + peak;
      }
      if (peak < peakThresh) { skipSmallPeak++; continue; }

      // 计算"应有的目标 alpha"（不带羽化）
      let targetA = Math.round(a + (ref - a) * rate);
      if (targetA < 0) targetA = 0;
      else if (targetA > 255) targetA = 255;

      // 用 support 做羽化：选区中心 fade≈1（完全改），边缘 fade≈0（不改）
      const s01 = support[ri];
      const t = Math.max(0, Math.min(1, (s01 - 0.22) / (0.995 - 0.22)));
      const fade = smootherstep01(smootherstep01(t));
      let na = Math.round(a + (targetA - a) * fade);
      // 安全闸：算法语义是"把交叉凸起拉低到单线水平"，永远不应该让 alpha 升高。
      // 这里 clamp 一下，防止任何数值异常（NaN、fade 计算偏差等）导致 alpha 不降反升。
      if (na > a) na = a;
      if (na < 0) na = 0;
      else if (na > 255) na = 255;

      const di = (docY * width + (x0 + rx)) * 4;
      out[di + 3] = na;
      changedCount++;
      if (changedSample === '' && changedCount <= 3) {
        changedSample += '[' + (x0 + rx) + ',' + docY + ']a' + a + '→' + na + ' ';
      }
    }
  }
  console.log('🔍 [alpha对齐] 修改像素数=' + changedCount + (changedSample ? ' 样例: ' + changedSample : ''));
  // 诊断汇总：当 changedCount=0 时，这几行能直接指出问题所在
  const candidateCount = validCount - skipLowAlpha; // 进入候选（a>=minAlpha）的像素数
  console.log('🔍 [alpha对齐] 候选(a>=' + minAlpha + ')=' + candidateCount +
    ' 跳过[alpha过低=' + skipLowAlpha + ' 无参照=' + skipNoRef + ' peak过小=' + skipSmallPeak + ']' +
    ' alpha直方图[<64=' + histLow + ' 64-128=' + histMid + ' 129-220=' + histHigh + ' 221-255=' + histSat + ']' +
    ' 最大peak=' + maxPeak + (maxPeakInfo ? ' @ ' + maxPeakInfo : '') +
    ' (阈值peakThresh=' + peakThresh + ')');

  return out;
}
