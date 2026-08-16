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
//   - 对每个候选像素，在多个尺度的"环形邻域"上分别取最大 alpha：
//       环形内半径 k、外半径 k+ringWidth（Chebyshev 距离）。
//     交叉点是一个 2D 局部凸包：当 k 足够大、环形"跳出"凸包后，环上会落到周围
//     的单线（较低）alpha；而 k 较小时环形还困在凸包内（仍是高 alpha）。
//     因此对多个尺度取"最小值"，即可稳健地得到"该处线条应有的水平"，
//     无论交叉点（凸包）是宽还是窄，都能找到一个能逃出去的尺度。
//   - 正常线条中心 / 羽化渐变 / 硬边：因为线条是 1D 且长，沿线条方向任意尺度上都
//     存在等高的邻居，各尺度 ring max 都≈自身，min 后 peak≈0，不会被误判。
//   - 通过 minAlpha 排除没擦干净的极低不透明度残留；通过 peakThresh 忽略
//     微小抖动与抗锯齿噪声。
//   - rate = strength（默认 1.0），把交叉点完全拉到单线水平，无残留。
//
// 说明：本函数只修改 alpha 通道，RGB 保持不变（图层存储的是 straight alpha，颜色
//       不随不透明度改变）。
//       返回的 out 数组与 layerPixelData 同尺寸；调用方按选区系数混合后再写回图层。

type Bounds = { width: number; height: number };

export type AlphaAlignParams = {
  strength?: number; // 0~1，默认 1，整体缩放拉回比例
};

const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));

// 算法核心常量（提升到模块级，供分块处理计算邻域 halo 与复用）
const RING_WIDTH = 3;                 // 每个环形邻域的宽度
const SCALES = [4, 8, 14, 22, 32];    // 环形内半径（覆盖从窄到宽的交叉点）
const MIN_ALPHA = 32;                 // 低于该不透明度视为残留/噪声，不参与
const PEAK_THRESH = 10;               // 凸起高出局部线条水平的最小量

// 分块处理所需的最大邻域半径（halo），保证块边缘像素也能取到完整的环形邻域
export const ALPHA_ALIGN_HALO = SCALES[SCALES.length - 1] + RING_WIDTH + 2; // = 37

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

  // 3. 计算每个尺度的环形邻域最大值，并边算边取最小值作为“线条水平”
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
        let m = 0;
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
            if (a > m) m = a;
          }
        }
        if (m > 0 && m < refMin[ri]) refMin[ri] = m;
      }
    }
  }

  // 4. 对每个候选像素，把高出“线条水平”的 alpha 拉低
  let changedCount = 0;
  let changedSample = '';

  // 诊断：统计每个候选像素被跳过的原因，定位“无现象”问题
  let skipLowAlpha = 0;     // a < minAlpha
  let skipNoRef = 0;        // refMin >= 65535（环上找不到 alpha>=MIN_ALPHA 的参照）
  let skipSmallPeak = 0;    // peak < peakThresh
  let maxPeak = 0;          // 所有候选像素中最大的 peak（用来判断是否阈值卡得太严）
  let maxPeakInfo = '';     // 最大 peak 像素的信息
  // alpha 直方图（仅统计候选像素 a>=minAlpha 的部分）
  let histLow = 0, histMid = 0, histHigh = 0, histSat = 0; // <64, 64-128, 129-220, 221-255

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

      let na = Math.round(a + (ref - a) * rate);
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
