// alpha对齐 算法 v5 —— 参照场空间一致化；移除"保底下对齐"，新增 alpha众对齐
//
// 目标（与 v1 相同）：画师用半透明（带羽化）笔刷画线时，两笔交叉/叠画处会因不透明度
// 叠加而形成一个较"深"（不透明度更高）的区域。本算法把这种局部凸起的 alpha 拉回到周围
// 线条的自然水平，使叠加区与周边自然衔接，几乎看不出不透明度异常提高。
//
// ─────────────────────────────────────────────────────────────────────────
// v5 相对 v4 的改动
// ─────────────────────────────────────────────────────────────────────────
//
//  1. 参照场空间一致化（v5 核心修复，解决"斑驳与条纹/对齐不彻底"）：
//     v1~v4 都是**逐像素独立**估计参照。对同一片连续区域，相邻像素因为"环带里正好
//     混进另一层水平"的概率不同，会各自选中**不同的层级**（实测：同一条叠画带上
//     相邻像素分别把参照判成浅色层 73 与笔画层 157），拉平后就成了 73/157 交替的
//     棋盘 —— 视觉上即"斑驳"；沿笔触方向这种交替连成线就是"条纹"。
//     另有大量像素被分析阶段判为"不改"，保留原值，于是"对齐不彻底"（实测下对齐
//     只改了 35% 的像素）。
//     v5 在所有参照算完后，对参照场做一次**窗口内出现次数达标的参照极值共识**：
//       - 下对齐取窗口内"计数达标的最低参照"，上对齐取最高的；
//       - 同一片区域的像素因此收敛到同一个层级；
//       - 对"分析阶段没有拿到参照"的像素补判：若窗口共识层级与自身明显不同
//         （下对齐：自身明显更高；上对齐：自身明显更低），说明它属于同一片区域
//         却被漏判了，一并对齐 —— 修复"对齐不彻底"。
//     这一步只作用于"参照/目标"，不引入任何新的空间滤波，因此不会糊掉自然软边。
//
//  2. 移除"保底下对齐"（withBg）：该模式已由新增的 **alpha众对齐** 取代
//     （见 processAlphaModeAlign）。随之删除 BRIGHT_*_BG / BRIGHT_DELTA 及相关分支，
//     非含背景路径的逻辑与 v4 完全一致。
//
//  3. 新增 alpha众对齐（processAlphaModeAlign）：统计选区内 alpha>0 像素的 alpha
//     直方图，取**出现次数最多的 alpha（众数）**为基准，把所有 alpha>0 像素的 alpha
//     统一到该值（RGB 不变）。这是"把整片内容统一到单一不透明度"的稳健做法 ——
//     不存在逐像素参照选择，因此天然不会产生斑驳/条纹，也不会"只改一部分"。
//
//  ── 与 1 配套的三处"串层"修复（实测数据见各常量注释）──
//  3a. 平坦判据改用**绝对数**（nearCount ≥ HIGH_CLUSTER_MIN），不再用占比：
//      大环带里混进远处另一层的高值会让占比判据误判"非平坦"，把本层像素交给
//      远处那一层处理（实测浅色层被抬到 118/157）。
//  3b. 上对齐加"本层邻域"护栏（bandMax > a + BRIGHT_GAP 的尺度直接跳过）：
//      上对齐的语义是"拉高到所在线条的主体水平"，参照必须来自同一条线附近；
//      环带一旦跑出本层，采到的是别的层，不能当参照。下对齐不加此护栏——
//      它往低处找"周围水平"，环带逸出到更暗的底色层正是"把交叉凸起拉回周围
//      自然水平"的语义，且只降不升，没有带飞风险。
//  3c. 补判（fill）越过"已受保护"像素：叠画带里会有孤立像素被误判成保护对象
//      （实测残留 158/162/143），与窗口共识落差 ≥ REF_FILL_PROTECTED_DELTA 时
//      一并对齐；补判对象仍要求 alpha ≥ MIN_ALPHA（MIN_ALPHA 以下视为残留，
//      否则会把近乎透明的边角抬到主体水平、凭空放大轮廓）。
//
// 其余语义与 v4 完全一致：
//   - 只处理"选区内 alpha > 0"的像素作为修改候选；只改 alpha，RGB 保持不变。
//   - 环形邻域的参考像素是**所有画过的线条像素**（alpha ≥ MIN_ALPHA），不受选区限制，
//     这样小选区也能引用选区外的线条找到"单线水平"，真正统一交叉点；
//     选区只决定"哪些像素会被修改"，不影响"在哪里找参考"。
//   - 通过 minAlpha 排除没擦干净的极低不透明度残留；peakThresh 忽略微小抖动与抗锯齿噪声。
//   - 选区边缘用 support 羽化；rate = strength（默认 1.0）把交叉点拉回单线水平。
//
// 说明：本函数只修改 alpha 通道，RGB 保持不变（图层存储的是 straight alpha，颜色
//       不随不透明度改变）。返回的 out 数组与 layerPixelData 同尺寸；
//       调用方按选区系数混合后再写回图层。

type Bounds = { width: number; height: number };

export type AlphaAlignParams = {
  strength?: number; // 0~1，默认 1，整体缩放拉回比例
  // 兼容旧参数：v2 已自适应粗细线，mode 不再生效，保留仅为 API 兼容。
  mode?: 'standard' | 'thick';
};

export type AlphaModeAlignParams = {
  strength?: number; // 0~1，默认 1，整体缩放对齐比例
};

const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));

const smootherstep01 = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
};

// ---- 算法核心常量 ----
const RING_WIDTH = 3;                  // 每个环形邻域的宽度（Chebyshev 带 [k, k+RING_WIDTH]）
const MAX_SCALE = 112;                 // 最大环内半径：覆盖 100px 线宽交叉的凸包（凸包半径≈55，需>55）
const RAY_LEN = MAX_SCALE + RING_WIDTH; // = 115，环带最远读取距离

const SCREEN_SCALES = [6, 14, 42, 112]; // 快速筛选用的尺度（覆盖小/中/大凸包；6 保证极小图/贴边选区也能筛到）
const MIN_ALPHA = 32;                  // 低于该不透明度视为残留/噪声，不参与
const PEAK_THRESH = 5;                 // 凸起高出局部线条水平的最小量（降低以捕捉弱凸起）
const FEATHER_RADIUS = 20;             // 选区边缘羽化半径（语义同 v1；实现改为 box 级联）

// v4 多尺度环带参照（内半径序列，从内到外）：
//   k=1 捕捉软笔刷/极细线（core 仅 1~2px）的线主体；
//   k=4 捕捉 3~8px 细线交叉；
//   k=14 / k=42 捕捉中粗线交叉凸包；
//   k=112 捕捉大凸包（100px 级线宽交叉，凸包半径≈55）与色块主体。
const RING_SCALES = [1, 4, 14, 42, MAX_SCALE];

const RING_MIN_COUNT = 8;              // 环带有效像素（alpha≥MIN_ALPHA）下限：低于此视为
                                       // 无参照信息（孤立值/线端羽化点），跳过该尺度——
                                       // 防止 v3 中 k112 大环带被"线端羽化孤立值"污染、
                                       // 把单线 core 误拉低成斑驳
const HIGH_CLUSTER_MIN = 4;            // "像素处于自身平台"的最小簇（绝对数）：环带
                                       // [alpha..255] 区间存在 ≥4 个像素时检查平坦度——
                                       // 用绝对数而非占比：软笔刷细线 core 仅 1~2px 宽，
                                       // 任何尺度环带里"同水平"像素都是固定的少数几个
                                       // （沿线的 core 像素），随环带变大的只是羽化/背景，
                                       // 占比阈值会永远追不上 → 漏拦截导致 core 被羽化值污染。
                                       // 注意：第一遍逐行处理时凸包像素会被提前拉平，
                                       // 中心像素环带里的同水平计数会减少（如 212 从 8 → 4），
                                       // 阈值必须足够低才能兜住
const BRIGHT_CLUSTER_MIN_ABS = 5;      // "高端参照平台"的最小簇（绝对数）：
const BRIGHT_CLUSTER_MIN_RATIO = 0.10; // 在 [minAlpha, alpha-peakThresh) 区间内从高到低
                                       // 找第一个计数 ≥ max(5, 10%环带) 的值作为参照——
                                       // 软笔刷细线环带里羽化 42 数量多但比 core 150 暗，
                                       // 从高到低先命中 150，不被羽化带污染
const QUANTILE_MIN_COUNT = 128;        // 中位数回退所需的最小环带有效像素：所有尺度都无
                                       // 稳定平台时（色块内部 alpha 不均匀/渐变波动），
                                       // 用最大环带（k112）的 alpha 中位数作参照
                                       // （波动色块中位数≈主体水平；cnt 太小则回退不可信）
const CLOSE_DELTA = 8;                 // "平坦平台"判据的接近窗口：环带 [alpha..255] 区间
                                       // 像素中，若 [alpha, alpha+CLOSE_DELTA] 内占 ≥50%，
                                       // 说明像素周围是"与自身同水平"的平坦平台（单线 core、
                                       // 凸包中心、色块）→ 不是凸起；否则像素处于
                                       // "显著高于自身"的区域边缘（凸包过渡渐变）→ 继续找参照
const BRIGHT_GAP = 60;                 // 高端参照区间的宽度：参照只在环带 [max-BRIGHT_GAP, max]
                                       // 内找（线 core 位于环带高值区）。软笔刷线的羽化带
                                       // （如 8px 线的 42/73/109/138）是中低值，被排除在外，
                                       // 防止交叉外缘的线 core 像素被羽化值误拉过头

// v5 参照场空间一致化参数
const REF_CONSENSUS_RADIUS = 6;        // 共识窗口半径（方形窗口，单位像素）：
                                       // 窗口越大越"整片统一"，越小越保守。
                                       // 6 覆盖 ~13×13 范围，远大于斑驳的特征尺度（1~2px），
                                       // 又小于线条交叉凸包的尺度（几十px），不会跨区域串层。
const REF_CONSENSUS_SUPPORT = 3;       // 参照值在窗口内出现次数下限：达不到的视为孤立参照，
                                       // 不作为共识依据（防止个别噪点把整片拉偏）
const REF_CONSENSUS_FILL = true;       // 是否对"分析阶段没有拿到参照"的像素补判：
                                       // 窗口共识层级与自身明显不同时一并对齐，
                                       // 修复"对齐不彻底"（同一片区域只改了一部分）
const REF_FILL_PROTECTED_DELTA = BRIGHT_GAP / 2; // (=30) 越过"已受保护"像素所需的落差门槛：
                                       // 保护（flatAll）本意是"自然软边/自身平台不动"，
                                       // 但大环带污染会让叠画带里的孤立像素被误判成保护对象
                                       // （实测残留 158/162/143 等孤立点，在白底上就是斑驳）。
                                       // 落差 ≥ 30 说明它属于"另一层"而不是本层的自然渐变
                                       // —— 越过保护一并对齐。
                                       // 实测定档：门槛 30 时下对齐的一阶差分粗糙度
                                       // 从 v4 的 10.56/8.89 降到 7.23/5.16、离群点从 284 → 171；
                                       // 放宽到 60 会漏掉落差 40~60 的残留（离群点回升到 271），
                                       // 收紧到 20 收益已接近饱和且更易伤自然渐变。
const REF_CONSENSUS_UP_USE_MAX = false; // 上对齐的共识取值规则：
                                       // false（默认）= 取窗口内参照的**下中位数**≈像素所在层的水平，
                                       //   只把真正的淡斑抬到本层，不会被窗口里更亮的层（叠画带）带飞；
                                       // true = 取窗口内达标的最高参照（会整片抬到最亮层，实测粗糙度反弹，
                                       //   仅作对照保留）

// 分块处理所需的最大邻域半径（halo），保证块边缘像素也能取到完整的环形邻域
export const ALPHA_ALIGN_HALO = RAY_LEN + 2; // = 117

// 8 个方向的单位步进（快速筛选用）
const DIRS8: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/**
 * 选区羽化 support（box 级联近似高斯，σ≈10，语义同 v1，但 O(n)）。
 * box 半径 b = FEATHER_RADIUS/2，3 次级联 σ ≈ b/√3 × √3 = b ≈ 10。
 * 用滑窗求和，边界按"窗口内有效像素数"归一化（等价 v1 的 weightSum 归一化）。
 * 返回区域坐标（x0,y0,rw,rh）下的 0~255 掩码均值。
 */
function buildSelectionSupport(
  selectionMask: Uint8Array,
  width: number, height: number,
  x0: number, y0: number, rw: number, rh: number
): Float32Array {
  const b = Math.max(1, Math.round(FEATHER_RADIUS * 0.5)); // = 10
  const support = new Float32Array(rw * rh);
  const tmp1 = new Float32Array(rw * rh);
  const y1 = y0 + rh - 1;

  // 水平 box：输入 selectionMask（文档坐标），输出到 tmp1（区域坐标）
  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    const rowBaseDoc = docY * width;
    const rowBaseR = ry * rw;
    let sum = 0;
    let cnt = 0;
    for (let x = -b; x <= b; x++) {
      const sx = x0 + x;
      if (sx >= 0 && sx < width) { sum += selectionMask[rowBaseDoc + sx]; cnt++; }
    }
    for (let rx = 0; rx < rw; rx++) {
      tmp1[rowBaseR + rx] = cnt > 0 ? sum / cnt : 0;
      const removeX = x0 + (rx - b);
      const addX = x0 + (rx + b + 1);
      if (removeX >= 0 && removeX < width) { sum -= selectionMask[rowBaseDoc + removeX]; cnt--; }
      if (addX >= 0 && addX < width) { sum += selectionMask[rowBaseDoc + addX]; cnt++; }
    }
  }
  // 垂直 box：输入 tmp1（区域坐标），输出到 support
  for (let rx = 0; rx < rw; rx++) {
    let sum = 0;
    let cnt = 0;
    for (let y = -b; y <= b; y++) {
      const sy = y0 + y;
      if (sy >= y0 && sy <= y1) { sum += tmp1[(sy - y0) * rw + rx]; cnt++; }
    }
    for (let ry = 0; ry < rh; ry++) {
      support[ry * rw + rx] = cnt > 0 ? sum / cnt : 0;
      const removeY = ry - b;
      const addY = ry + b + 1;
      if (removeY >= 0) { sum -= tmp1[removeY * rw + rx]; cnt--; }
      if (addY < rh) { sum += tmp1[addY * rw + rx]; cnt++; }
    }
  }
  // 再水平 box：输入 support（区域坐标），输出到 tmp1，然后拷贝回 support
  for (let ry = 0; ry < rh; ry++) {
    const rowBaseR = ry * rw;
    let sum = 0;
    let cnt = 0;
    for (let x = -b; x <= b; x++) {
      if (x >= 0 && x < rw) { sum += support[rowBaseR + x]; cnt++; }
    }
    for (let rx = 0; rx < rw; rx++) {
      tmp1[rowBaseR + rx] = cnt > 0 ? sum / cnt : 0;
      const removeX = rx - b;
      const addX = rx + b + 1;
      if (removeX >= 0) { sum -= support[rowBaseR + removeX]; cnt--; }
      if (addX < rw) { sum += support[rowBaseR + addX]; cnt++; }
    }
  }
  support.set(tmp1);
  return support;
}

export async function processAlphaAlign(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: Bounds,
  params: AlphaAlignParams = {},
  isBackgroundLayer: boolean = false,
  direction: 'down' | 'up' = 'down'
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

  const strength = clamp01(typeof params.strength === 'number' ? params.strength : 1);
  const minAlpha = MIN_ALPHA;
  const peakThresh = PEAK_THRESH;
  const ringWidth = RING_WIDTH;
  const alignUp = direction === 'up'; // 上对齐：把比主体偏淡的像素拉高到线条主体水平（与下对齐对称）

  const rate = strength; // 拉回比例（1.0 时完全统一到单线水平）

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
  console.log('🔍 [alpha对齐 v5] 尺寸=' + width + 'x' + height + ' validCount=' + validCount +
    ' 选区包围盒=(' + minX + ',' + minY + ')→(' + maxX + ',' + maxY + ')');

  // 2. 只处理"选区包围盒 + 外扩 halo"区域，节省内存；环形邻域可引用选区外的线条像素
  const pad = ALPHA_ALIGN_HALO;
  const x0 = minX - pad < 0 ? 0 : minX - pad;
  const y0 = minY - pad < 0 ? 0 : minY - pad;
  const x1 = maxX + pad >= width ? width - 1 : maxX + pad;
  const y1 = maxY + pad >= height ? height - 1 : maxY + pad;
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  const rn = rw * rh;

  const aR = new Uint8Array(rn); // 区域 alpha
  const vR = new Uint8Array(rn); // 区域 valid（0/1）
  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    const rowBaseDoc = docY * width;
    const rowBaseR = ry * rw;
    for (let rx = 0; rx < rw; rx++) {
      const di = rowBaseDoc + (x0 + rx);
      const ri = rowBaseR + rx;
      aR[ri] = alpha[di];
      vR[ri] = valid[di];
    }
  }

  // 3. 快速筛选：标记"可疑像素"（局部 alpha 明显高于周边单线水平）
  //    对每个候选像素采样 8 方向 × 2 半径 × 4 尺度（≈64 次读取）。
  //    判断条件用"采样最小值 < alpha - peakThresh"：环带里只要存在低于 alpha 的单线
  //    参照（采样最小值为单线水平）即标记可疑。
  //    - 单线像素：采样点都是自身线水平（150）或背景（<MIN_ALPHA 排除）→ 最小值≈alpha
  //      → 不可疑，零误伤；
  //    - 凸包角/边缘像素：采样朝凸包内方向得到凸包值（=alpha，用最大值会漏报！），
  //      朝凸包外方向得到单线水平（150）→ 最小值 < alpha → 可疑；
  //    - 软线渐变边缘像素：采样最小值可能偏低 → 误标可疑，但完整分析会给出
  //      ref（众数）≥ alpha → 不改，无害。
  //    所有筛选尺度都找不到参照（周边无线条）→ 孤立像素，跳过（同 v1 无参照跳过）。
  const suspicious = new Uint8Array(rn);
  {
    let screenCount = 0;
    for (let ry = 0; ry < rh; ry++) {
      const rowBaseR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowBaseR + rx;
        if (vR[ri] === 0) continue;
        const a = aR[ri];
        if (a < minAlpha) continue;
        let isSuspicious = false;
        for (let si = 0; si < SCREEN_SCALES.length && !isSuspicious; si++) {
          const k = SCREEN_SCALES[si];
          const outer = k + ringWidth;
          let minSample = 65535;
          let maxSample = -1;
          for (let d = 0; d < 8; d++) {
            const dx = DIRS8[d][0];
            const dy = DIRS8[d][1];
            for (let r2 = 0; r2 < 2; r2++) {
              const rr = r2 === 0 ? k : outer;
              const nx = rx + dx * rr;
              const ny = ry + dy * rr;
              if (nx < 0 || nx >= rw || ny < 0 || ny >= rh) continue;
              const s = aR[ny * rw + nx];
              if (s >= minAlpha) {
                if (s < minSample) minSample = s;
                if (s > maxSample) maxSample = s;
              }
            }
          }
          if (alignUp) {
            // 上对齐：周围存在明显高于自身的线条水平 → 本像素"偏淡"，标记可疑
            if (maxSample >= 0 && maxSample > a + peakThresh) isSuspicious = true;
          } else if (minSample < 65535 && minSample < a - peakThresh) {
            // 下对齐：周围存在明显低于自身的单线水平 → 本像素"偏高"（交叉凸起），标记可疑
            isSuspicious = true;
          }
        }
        if (isSuspicious) {
          suspicious[ri] = 1;
          screenCount++;
        }
      }
    }
    console.log('🔍 [alpha对齐] 可疑像素数=' + screenCount);
  }

  // 4. 完整分析（两遍，只针对可疑像素）
  //    v4 参照估计 = 多尺度环带（k = 1/4/14/42/112，从内到外）的"高端平台簇"：
  //      - 对每个尺度，先看环带 [alpha..255] 区间的像素数（highCount）：
  //        若 ≥ max(6, 15%环带) → 像素处于"不低于自身水平"的平台/渐变中
  //        （单线 core、线羽化、渐变边缘）→ 不是凸起，放大尺度再试；
  //      - 否则像素是局部高值（交叉凸包/杂点），在 [minAlpha, alpha-peakThresh)
  //        区间内从高到低找第一个"计数达标（≥max(5, 10%环带)）"的值作为参照——
  //        软笔刷细线环带里羽化带（如 42）数量虽多但比 core（如 150）暗，
  //        从高到低先命中 core，不被羽化带污染（修复 v3 软笔刷细线被拉过暗/斑驳）；
  //      - 孤立值（线端羽化、个别噪声）所在的环带 cnt 太小（< RING_MIN_COUNT）
  //        → 跳过该尺度（修复 v3 k112 大环带被孤立值污染、误拉低单线 core）。
  //    中位数回退：所有尺度都找不到稳定平台（色块内部 alpha 不均匀/渐变波动）时，
  //    用最大环带（k112）的 alpha 中位数作参照（波动色块中位数≈主体水平，
  //    杂点被正确拉回——修复 v3"色块内杂点怎么点都无法统一化"）。
  //    两遍处理：第一遍用原始 alpha 处理能判定的像素（凸包主体、细交叉）；
  //    第二遍对"第一遍未解决"的像素（凸包角/深处的残余，第一遍环带朝凸包内侧
  //    方向被凸包值污染导致参照偏高）用"第一遍修改后的 alpha"重新判定——此时凸包
  //    区域已被拉平为单线水平，环带参照自然正确（等价"第二次点击"的机理，但一次完成）。
  const refMin = new Uint16Array(rn);
  refMin.fill(65535);
  const flatAll = new Uint8Array(rn); // 第一遍判定"非凸起"（像素处于自身平台/接近自身水平）
                                      // → 第二遍跳过：第二遍环带已含第一遍修改值，
                                      // 重判会被污染误伤
  const curA = new Uint8Array(aR); // 当前状态（第一遍修改后更新，供第二遍环带读取）
  const histBuf = new Uint16Array(256); // 复用的直方图
  {
    // 环带读取源：第一遍固定读原始 alpha（判定与处理顺序无关，避免"前面像素被提前
    // 拉平导致环带统计漂移"——如交叉中心 k1 环带里凸包值计数被稀释、平坦拦截失效）；
    // 第二遍读修改后的 curA（凸包被拉平后，环带参照自然正确）。
    let readSrc = aR;
    // 环带扫描辅助：把当前像素 (rx,ry) 的 Chebyshev 带 [k, k+RING_WIDTH] 内
    // alpha≥MIN_ALPHA 的像素累加到 histBuf，并统计 cnt/bandMax。
    let curRx = 0;
    let curRy = 0;
    const scanBand = (k: number, step: number) => {
      const inner = k;
      const outer = k + ringWidth;
      let cnt = 0;
      let bandMax = -1;
      for (let dy = -outer; dy <= outer; dy += step) {
        const ny = curRy + dy;
        if (ny < 0 || ny >= rh) continue;
        const ady = dy < 0 ? -dy : dy;
        const rowBase = ny * rw;
        if (ady >= inner && ady <= outer) {
          for (let dx = -outer; dx <= outer; dx += step) {
            const nx = curRx + dx;
            if (nx < 0 || nx >= rw) continue;
            const s2 = readSrc[rowBase + nx];
            if (s2 >= minAlpha) {
              cnt++;
              histBuf[s2]++;
              if (s2 > bandMax) bandMax = s2;
            }
          }
        } else {
          for (let dx = -outer; dx <= -inner; dx += step) {
            const nx = curRx + dx;
            if (nx < 0) continue;
            const s2 = readSrc[rowBase + nx];
            if (s2 >= minAlpha) {
              cnt++;
              histBuf[s2]++;
              if (s2 > bandMax) bandMax = s2;
            }
          }
          for (let dx = inner; dx <= outer; dx += step) {
            const nx = curRx + dx;
            if (nx >= rw) continue;
            const s2 = readSrc[rowBase + nx];
            if (s2 >= minAlpha) {
              cnt++;
              histBuf[s2]++;
              if (s2 > bandMax) bandMax = s2;
            }
          }
        }
      }
      return { cnt, bandMax };
    };
    const clearHist = () => {
      for (let v = 0; v < 256; v++) histBuf[v] = 0;
    };

    // 判据阈值：参照平台最小簇随环带有效像素数自适应（绝对数下限保护小环带）
    const brightClusterMin = (cnt: number, ratio: number) => {
      const r = (cnt * ratio) | 0;
      return r > BRIGHT_CLUSTER_MIN_ABS ? r : BRIGHT_CLUSTER_MIN_ABS;
    };

    // 判定单个像素：返回参照（<alpha-peakThresh）或 65535（不修改）
    // 逻辑：对尺度序列从内到外，每个尺度先做"自身平台/渐变"拦截（平坦度），
    // 再在环带的**高端区间** [max-BRIGHT_GAP, max] 内找第一个计数达标的簇：
    //   - 该簇显著低于 alpha（< alpha-peakThresh）→ 采纳为参照候选（凸起 → 拉回），
    //     继续更大尺度，最终取所有候选中的最低值——大尺度环带里"交叉过渡值"
    //     （如 6px 线交叉的 181）占比下降、线 core（150）胜出，纠正小尺度误选；
    //   - 该簇接近 alpha（< alpha 但 ≥ alpha-peakThresh）→ 像素在自身水平附近
    //     （不是凸起）→ 不改，且第二遍跳过（flatAll），提前返回；
    //   - 该簇 ≥ alpha（如凸包中心值）→ 像素在凸包/渐变中 → 放大尺度再试。
    // 高端区间限制防止"线羽化带"（软笔刷线的 73/138 等中低值）被误当参照——
    // 参照必须是环带高值区的稳定簇（线 core 水平），羽化值是中低值被排除。
    const analyzePixel = (ri: number): number => {
      const a = readSrc[ri];
      // 参照候选：取**最低**候选（大尺度环带里线 core 胜出，纠正小尺度误选
      // 交叉过渡值）
      let bestRef = 65535;
      let qHist: Uint16Array | null = null; // 中位数回退用直方图（有效的大尺度候选）
      let qCnt = 0;
      // 中尺度（k14/k42）的平坦性：若中尺度确认"像素在自身平台"（线 core 等），
      // 且没有出现"非平坦"信号（highCount 显著且不接近 alpha），说明像素确实处于
      // 自身的连续主体上（单线 core/羽化）——此时禁用中位数回退：更大的环带
      // （k112）可能混入"其他内容"（另一条线的羽化带、过渡值），中位数会被污染
      // 拉低（如线端附近 core 被拉到线羽化值）。
      // 若中尺度出现"非平坦"（凸起带/叠加区，如细粗交叉、色块杂点），不触发保护，
      // 中位数回退仍可给出正确参照。
      let midFlat = false;
      let midNonFlat = false;
      // 是否出现过"v1 ≥ alpha"（像素低于周围线水平）：线羽化带像素（如 135 在
      // core 153 的羽化渐变上）在所有尺度都会遇到"环带高端簇 ≥ 自身"→ 放大尺度；
      // 若最终仍无参照候选，说明像素只是"暗于线 core 的渐变"，不是凸起——
      // 必须保护（中位数回退会把羽化带中位数当参照，把羽化边缘侵蚀变淡）。
      let sawAbove = false;
      for (let si = 0; si < RING_SCALES.length; si++) {
        const k = RING_SCALES[si];
        const r = scanBand(k, 1); // 全采样填充 histBuf
        const cnt = r.cnt;
        if (cnt < RING_MIN_COUNT) {
          // 环带里几乎没有参照像素（孤立值/极细线）→ 该尺度无信息
          clearHist();
          continue;
        }
        // 自身平台/渐变拦截：环带内 alpha ≥ a 的像素数达阈值，说明像素处于
        // "不低于自身水平"的区域中（单线 core、线羽化、渐变、凸包中心）。
        // 进一步用"平坦度"区分：
        //   - [a, a+CLOSE_DELTA] 内占 ≥50% → 周围是与自身同水平的平坦平台（单线 core、
        //     凸包中心、均匀色块）→ 不是凸起，放大尺度再试（凸包内像素需出凸包找参照）；
        //   - 否则（周围显著高于自身）→ 像素处于凸包过渡渐变中，不拦截，继续找参照。
        let highCount = 0;
        for (let v = a; v < 256; v++) highCount += histBuf[v];
        if (highCount >= HIGH_CLUSTER_MIN) {
          let nearCount = 0;
          const nearMax = a + CLOSE_DELTA > 255 ? 255 : a + CLOSE_DELTA;
          for (let v = a; v <= nearMax; v++) nearCount += histBuf[v];
          // v5：平坦判据改用**绝对数**（与 v4 的含背景模式一致）。
          // 原来的占比判据（nearCount*2 >= highCount）在大环带里会被"远处另一层的
          // 高值"污染：highCount 因为环带里混进更亮的区域而虚高，占比永远追不上，
          // 于是"像素明明在自己层上是连续的"却被判成非平坦，进而被远处更亮/更暗的
          // 层带飞（实测：浅色层像素被抬到 118/157，上对齐粗糙度反而上升 19%）。
          // 绝对数判据只问"环带里有没有 ≥4 个与我同水平的像素"——有，说明我在自己的
          // 层上是连续的（单线 core / 色块 / 羽化平台），不是凸起/坑。
          const flat = nearCount >= HIGH_CLUSTER_MIN;
          if (flat) {
            // 平坦平台：不是凸起
            if (si === 2 || si === 3) midFlat = true; // k14/k42：中尺度平坦
            clearHist();
            continue;
          }
        }
        // 高端区间内找第一个计数达标的簇
        if (si === 2 || si === 3) midNonFlat = true; // k14/k42：中尺度非平坦（凸起带）
        const bMin = brightClusterMin(cnt, BRIGHT_CLUSTER_MIN_RATIO);
        let loV = r.bandMax - BRIGHT_GAP;
        if (loV < minAlpha) loV = minAlpha;
        let v1 = -1;
        for (let v = r.bandMax; v >= loV; v--) {
          if (histBuf[v] >= bMin) { v1 = v; break; }
        }
        if (v1 < 0) {
          // 高端区间无稳定簇 → 该尺度无参照信息，放大尺度。
          // 记录"有效的中位数候选"（后面的更大尺度覆盖前面的）：
          // 中位数回退不能只依赖 k112——色块/线条较小或贴边时，k112 环带可能完全
          // 落在内容之外（cnt=0），此时应回退到仍有足够采样的大尺度（如 k42）。
          if (cnt >= QUANTILE_MIN_COUNT) {
            qHist = new Uint16Array(histBuf);
            qCnt = cnt;
          }
          clearHist();
          continue;
        }
        if (v1 < a - peakThresh) {
          // 显著低于 alpha → 凸起，采纳为参照候选。
          // 取**最低**候选——小尺度环带可能命中交叉过渡值（如 6px 交叉的 181），
          // 大尺度环带里线 core 占比上升、胜出，纠正误选。
          if (v1 < bestRef) bestRef = v1;
          clearHist();
          continue;
        }
        if (v1 < a) {
          // 接近 alpha（差 < peakThresh）：环带中存在"与自身同水平的稳定簇"
          // （另一条略不同 alpha 的线，或线 core 与交叉凸起之间的过渡像素）——
          // 像素基本处于线条自身水平附近，不是"显著凸起"，应该**保护**而非跳过
          // 继续找更低值（继续找会命中另一条线的羽化带，把线像素侵蚀变淡）。
          flatAll[ri] = 1;
          clearHist();
          return 65535;
        }
        // v1 ≥ alpha：像素在凸包/渐变中（环带高端被凸包值主导）→ 放大尺度
        sawAbove = true;
        clearHist();
        continue;
      }
      if (bestRef < 65535) return bestRef;
      // 中尺度确认像素在自身平台 → 不是凸起，禁用中位数回退。
      // 非含背景模式：还需 k42 无非平坦信号（凸起带场景需要中位数回退修）。
      if (midFlat && !midNonFlat) {
        flatAll[ri] = 1;
        return 65535;
      }
      // 所有尺度都无有效参照：中位数回退（色块内部 alpha 不均匀等）
      if (qHist !== null && qCnt >= QUANTILE_MIN_COUNT) {
        const half = qCnt / 2;
        let acc = 0;
        for (let v = 0; v < 256; v++) {
          acc += qHist[v];
          if (acc >= half) {
            if (v < a - peakThresh) return v;
            break;
          }
        }
      }
      // 无法确认是凸起 → 不改，且第二遍跳过（防环带污染误伤）
      flatAll[ri] = 1;
      return 65535;
    };

    // ---- 上对齐（alignUp）：检测线条上"比主体偏淡"的像素（淡斑/断点/被削弱处），
    //     以周围线条主体水平为参照拉高，让线条更均匀。与下对齐对称：
    //      - 参照从环带"高端稳定簇"（线 core 水平）中找，且必须比 alpha 高至少 peakThresh；
    //      - 平坦拦截：环带内"≥alpha 的像素"中 ≥50% 集中在 [a, a+CLOSE_DELTA] →
    //        像素周围是与自身同水平的平台（整条线均匀偏淡 / 自然软边过渡带）→ 保护
    //        （自然软边不会被误拉成硬边；只有"局部明显偏淡"的坑才被修复）；
    //      - 候选取**最高**：小尺度环带可能命中淡斑周围的过渡值，大尺度环带里线 core
    //        占比上升胜出（与下对齐"取最低"收敛到 core 的机理对称）；
    //      - 只允许拉高（alpha 只增不减），与下对齐只减不增对称。
    const analyzePixelUp = (ri: number): number => {
      const a = readSrc[ri];
      let bestRef = -1; // 取最高候选 = 线 core 水平
      let qHist: Uint16Array | null = null; // 中位数回退用直方图
      let qCnt = 0;
      let midFlat = false;
      let midNonFlat = false;
      let sawBelow = false; // 出现过"高端簇 ≤ alpha"（像素不低于周围线水平）→ 非偏淡
      for (let si = 0; si < RING_SCALES.length; si++) {
        const k = RING_SCALES[si];
        const r = scanBand(k, 1); // 全采样填充 histBuf
        const cnt = r.cnt;
        if (cnt < RING_MIN_COUNT) {
          clearHist();
          continue;
        }
        // v5 护栏（上对齐）：环带里最亮的值已经比自身高出 BRIGHT_GAP 以上 → 该环带
        // 已经跑出"本像素所在的那一层"，采到的是远处更亮的内容（叠画带 / 另一条线 /
        // 过渡带）。它的"高端簇"不能当作本层的线 core 水平——上对齐的语义是
        // "把偏淡像素拉高到所在线条的主体水平"，参照必须来自同一条线附近。
        // 实测：没有这道护栏时，浅色层（65）的环带会把 157 的叠画带当成参照，
        // 一路抬到 118/157，粗糙度反而上升 19%。
        // 下对齐不加这道护栏：它往低处找"周围水平"（环带逸出到更暗的底色层
        // 正是"把交叉凸起拉回周围自然水平"的语义），且只降不升，没有带飞风险。
        if (r.bandMax > a + BRIGHT_GAP) {
          clearHist();
          continue;
        }
        // 平坦拦截：环带内 ≥alpha 的像素若大部分集中在自身水平附近 → 平台
        let highCount = 0;
        for (let v = a; v < 256; v++) highCount += histBuf[v];
        if (highCount >= HIGH_CLUSTER_MIN) {
          let nearCount = 0;
          const nearMax = a + CLOSE_DELTA > 255 ? 255 : a + CLOSE_DELTA;
          for (let v = a; v <= nearMax; v++) nearCount += histBuf[v];
          // v5：与下对齐同口径 —— 平坦判据用绝对数（见 analyzePixel 的说明）
          const flat = nearCount >= HIGH_CLUSTER_MIN;
          if (flat) {
            if (si === 2 || si === 3) midFlat = true; // k14/k42：中尺度平坦
            clearHist();
            continue;
          }
        }
        if (si === 2 || si === 3) midNonFlat = true; // k14/k42：中尺度非平坦（偏淡坑）
        // 高端区间内找第一个计数达标的簇（线 core 水平）
        const bMin = brightClusterMin(cnt, BRIGHT_CLUSTER_MIN_RATIO);
        let loV = r.bandMax - BRIGHT_GAP;
        if (loV < minAlpha) loV = minAlpha;
        let v1 = -1;
        for (let v = r.bandMax; v >= loV; v--) {
          if (histBuf[v] >= bMin) { v1 = v; break; }
        }
        if (v1 < 0) {
          // 高端区间无稳定簇 → 记录中位数回退候选，放大尺度
          if (cnt >= QUANTILE_MIN_COUNT) {
            qHist = new Uint16Array(histBuf);
            qCnt = cnt;
          }
          clearHist();
          continue;
        }
        if (v1 > a + peakThresh) {
          // 显著高于 alpha → 偏淡像素，采纳为参照候选（取最高 = 线 core）
          if (v1 > bestRef) bestRef = v1;
          clearHist();
          continue;
        }
        if (v1 > a) {
          // 接近 alpha（差 < peakThresh）：像素基本处于线条主体水平附近，不是明显偏淡 → 保护
          flatAll[ri] = 1;
          clearHist();
          return 65535;
        }
        // 高端簇 ≤ alpha：像素不低于周围线水平（如更深处交叉凸起像素）→ 非偏淡
        sawBelow = true;
        clearHist();
        continue;
      }
      // 中尺度确认像素在自身平台、且无"非平坦"信号 → 普通线条像素，保护
      if (midFlat && !midNonFlat) {
        flatAll[ri] = 1;
        return 65535;
      }
      if (bestRef >= 0) return bestRef;
      // 出现过"高端簇 ≤ alpha"→ 像素不偏淡，禁用中位数回退
      if (sawBelow) {
        flatAll[ri] = 1;
        return 65535;
      }
      if (midFlat) {
        flatAll[ri] = 1;
        return 65535;
      }
      // 中位数回退：环带中位数显著高于 alpha → 以中位数为参照拉高
      if (qHist !== null && qCnt >= QUANTILE_MIN_COUNT) {
        const half = qCnt / 2;
        let acc = 0;
        for (let v = 0; v < 256; v++) {
          acc += qHist[v];
          if (acc >= half) {
            if (v > a + peakThresh) return v;
            break;
          }
        }
      }
      // 无法确认是偏淡 → 不改，且第二遍跳过
      flatAll[ri] = 1;
      return 65535;
    };

    // 按方向分发：上对齐走 analyzePixelUp；下对齐走 analyzePixel
    const analyze = (ri: number): number => (alignUp ? analyzePixelUp(ri) : analyzePixel(ri));

    let analyzedCount = 0;
    // ---- 第一遍：处理主体 ----
    for (let ry = 0; ry < rh; ry++) {
      const rowBaseR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowBaseR + rx;
        if (suspicious[ri] === 0) continue;
        analyzedCount++;
        curRx = rx;
        curRy = ry;
        const ref = analyze(ri);
        if (ref < 65535) {
          refMin[ri] = ref;
          curA[ri] = ref; // 更新当前状态（第二遍环带可读到拉平/拉高后的单线水平）
        }
      }
    }
    // ---- 第二遍：处理第一遍未解决的像素（凸包角/深处残余）----
    //     跳过"非凸起/非偏淡"像素（flatAll：它们处于自身平台/接近自身水平；第二遍环带已含
    //     第一遍修改值，重判会被污染误伤）
    readSrc = curA; // 第二遍读第一遍修改后的 alpha（凸包拉平/淡斑拉高后环带参照自然正确）
    for (let ry = 0; ry < rh; ry++) {
      const rowBaseR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowBaseR + rx;
        if (suspicious[ri] === 0 || refMin[ri] < 65535 || flatAll[ri] !== 0) continue;
        curRx = rx;
        curRy = ry;
        const ref = analyze(ri);
        if (ref < 65535) refMin[ri] = ref;
      }
    }
    console.log('🔍 [alpha对齐] 完整分析像素数=' + analyzedCount);

    // ---- 4.5 参照场空间一致化（v5 新增）----
    // 逐像素独立估计的参照在"同一片区域"里可能落到不同层级（例如浅色层 73 与
    // 笔画层 157 相邻），拉平后形成 73/157 交替的棋盘 —— 斑驳与条纹的来源。
    // 这里对参照场做一次"窗口内出现次数达标的参照极值共识"：
    //   - 下对齐取窗口内计数达标的最低参照，上对齐取最高的；
    //   - 同一片区域的像素因此收敛到同一层级（消除斑驳/条纹）；
    //   - 补判（REF_CONSENSUS_FILL）：分析阶段没拿到参照、也未被保护（flatAll=0）的
    //     像素，若窗口共识层级与自身明显不同，说明它属于同一片区域却被漏判 —— 一并对齐，
    //     修复"对齐不彻底（只改了一部分像素）"。
    if (REF_CONSENSUS_RADIUS > 0) {
      const base = new Uint16Array(refMin); // 读原始参照场，避免边写边读
      const R = REF_CONSENSUS_RADIUS;
      const chi = new Uint16Array(256);
      let fixedCount = 0;
      let filledCount = 0;
      let protectedFilledCount = 0; // 其中"越过保护"补判的像素数（诊断用）
      for (let ry = 0; ry < rh; ry++) {
        for (let rx = 0; rx < rw; rx++) {
          const ri = ry * rw + rx;
          if (vR[ri] === 0) continue;
          // 收集窗口内参照直方图
          const ny0 = ry - R < 0 ? 0 : ry - R;
          const ny1 = ry + R >= rh ? rh - 1 : ry + R;
          const nx0 = rx - R < 0 ? 0 : rx - R;
          const nx1 = rx + R >= rw ? rw - 1 : rx + R;
          let refCnt = 0;
          for (let ny = ny0; ny <= ny1; ny++) {
            const rowBase = ny * rw;
            for (let nx = nx0; nx <= nx1; nx++) {
              const v = base[rowBase + nx];
              if (v >= 65535) continue;
              chi[v]++;
              refCnt++;
            }
          }
          if (refCnt === 0) continue;
          // 取"共识层级"：
          //   下对齐 = 窗口内计数达标的**最低**参照（把叠画带整片拉回底色水平，
          //            这也正是"下对齐"的语义：只降不升，取最低不会带来副作用）；
          //   上对齐 = 窗口内参照的**下中位数**（≈像素所在层的水平）；取最高会把整片
          //            抬到窗口里最亮的层（如叠画带 157），实测粗糙度反而反弹。
          let chosen = -1;
          if (!alignUp) {
            for (let v = 0; v < 256; v++) {
              if (chi[v] >= REF_CONSENSUS_SUPPORT) { chosen = v; break; }
            }
          } else if (REF_CONSENSUS_UP_USE_MAX) {
            for (let v = 255; v >= 0; v--) {
              if (chi[v] >= REF_CONSENSUS_SUPPORT) { chosen = v; break; }
            }
          } else {
            const half = refCnt / 2;
            let acc = 0;
            for (let v = 0; v < 256; v++) {
              acc += chi[v];
              if (acc >= half) { chosen = v; break; }
            }
          }
          for (let v = 0; v < 256; v++) chi[v] = 0;
          if (chosen < 0) continue;
          const own = base[ri];
          if (own < 65535) {
            // 已有参照：向共识层级收敛（下对齐只降不升 / 上对齐只升不降）
            const merged = alignUp ? (chosen > own ? chosen : own)
                                   : (chosen < own ? chosen : own);
            if (merged !== own) {
              refMin[ri] = merged;
              fixedCount++;
            }
          } else {
            // 无参照：补判。阈值按"是否已被判为平台"分档——
            //   未受保护（flatAll=0，即分析阶段从未把它判成平台）→ peakThresh，
            //     只要窗口共识与自身明显不同就补上（修复"同片区域只改了一部分"）；
            //   已受保护（flatAll=1）→ 要求偏离超过 REF_FILL_PROTECTED_DELTA(=BRIGHT_GAP)：
            //     半个量程以上的落差说明它其实属于"另一层"而非本层的自然渐变，
            //     是保护判据的漏网（实测：叠画带里残留 158/162/143 等孤立点，
            //     在白底上就是一粒粒深色斑驳）。小落差仍尊重保护（自然软边不动）。
            const a = aR[ri];
            // 补判对象仍须满足 minAlpha（与"修改候选"同一口径）：
            // MIN_ALPHA 以下视为残留/羽化尘埃，补判它们会把"几乎透明的边角"
            // 一路抬到主体水平（实测 (0,0) 的 a=8 被抬到 118），等于凭空放大轮廓。
            if (a < minAlpha) continue;
            const wasProtected = flatAll[ri] !== 0;
            const fillThresh = wasProtected ? REF_FILL_PROTECTED_DELTA : peakThresh;
            const deviates = alignUp ? (a < chosen - fillThresh) : (a > chosen + fillThresh);
            if (deviates) {
              refMin[ri] = chosen;
              flatAll[ri] = 0;
              filledCount++;
              if (wasProtected) protectedFilledCount++;
            }
          }
        }
      }
      // 诊断：受保护（flatAll=1）但明显偏离窗口共识的像素 —— 保护判据可能过宽
      console.log('🔍 [alpha对齐] 参照场一致化(R=' + R + ')：收敛 ' + fixedCount +
        ' 个 / 补判 ' + filledCount + ' 个（其中越过保护 ' + protectedFilledCount + ' 个）');
    }
  }

  // 5. 选区边缘羽化 support（box 级联近似高斯，σ≈10，语义同 v1，但 O(n)）
  const support = buildSelectionSupport(selectionMask, width, height, x0, y0, rw, rh);

  // 6. 对每个可疑像素：下对齐把高出"线条水平"的 alpha 拉低；上对齐把偏淡像素拉高
  let changedCount = 0;
  let changedSample = '';

  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    const rowBaseR = ry * rw;
    for (let rx = 0; rx < rw; rx++) {
      const ri = rowBaseR + rx;
      const a = aR[ri];
      const ref = refMin[ri];
      if (ref >= 65535) continue;

      // 计算"应有的目标 alpha"（不带羽化）
      let targetA = Math.round(a + (ref - a) * rate);
      if (targetA < 0) targetA = 0;
      else if (targetA > 255) targetA = 255;

      // 用 support 做羽化：选区中心 fade≈1（完全改），边缘 fade≈0（不改）
      // support 是 0~255 的 mask 均值，先归一化到 0~1 再套用 v1 的阈值映射
      const s01 = support[ri] * (1 / 255);
      const t = Math.max(0, Math.min(1, (s01 - 0.22) / (0.995 - 0.22)));
      const fade = smootherstep01(smootherstep01(t));
      let na = Math.round(a + (targetA - a) * fade);
      // 安全闸：下对齐"把交叉凸起拉低到单线水平"，只允许 alpha 降低；
      // 上对齐"把偏淡像素拉高到线条水平"，只允许 alpha 升高。
      if (alignUp ? (na < a) : (na > a)) na = a;
      if (na < 0) na = 0;
      else if (na > 255) na = 255;

      const di = (docY * width + (x0 + rx)) * 4;
      out[di + 3] = na;
      changedCount++;
      if (changedSample === '' && changedCount <= 3) {
        changedSample += '[' + (x0 + rx) + ',' + docY + ']a' + a + '→' + na + '(ref' + ref + ') ';
      }
    }
  }
  console.log('🔍 [alpha对齐' + (alignUp ? '上' : '下') + '] 修改像素数=' + changedCount + (changedSample ? ' 样例: ' + changedSample : ''));

  return out;
}

/**
 * alpha众对齐：把选区内**所有 alpha>0 的像素**统一到"出现次数最多的那个 alpha"（众数）。
 *
 * 用途：整片内容的不透明度统一化（同一支半透明笔刷反复叠画后，各处 alpha 参差不齐）。
 * 与局部对齐（processAlphaAlign）不同，这里不做任何邻域参照估计 —— 基准值由整个选区的
 * 直方图唯一确定，因此：
 *   - 天然空间一致，不会出现"同片区域分别对齐到不同层级"的斑驳/条纹；
 *   - 不会"只改一部分"，对齐彻底。
 * 只修改 alpha，RGB 不变。选区边缘仍按 support 羽化（非全文档选区时边界自然过渡）。
 */
export async function processAlphaModeAlign(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: Bounds,
  params: AlphaModeAlignParams = {},
  isBackgroundLayer: boolean = false
): Promise<Uint8Array> {
  const width = Math.max(1, bounds.width | 0);
  const height = Math.max(1, bounds.height | 0);
  const pixelCount = width * height;

  const pixels = new Uint8Array(layerPixelData);
  const selectionMask = new Uint8Array(selectionData);
  const out = new Uint8Array(pixels.length);
  out.set(pixels);

  if (isBackgroundLayer) return out;
  if (pixels.length < pixelCount * 4) return out;

  const rate = clamp01(typeof params.strength === 'number' ? params.strength : 1);

  // 1. 统计选区内 alpha>0 的直方图，并求选区包围盒
  const hist = new Uint32Array(256);
  let validCount = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < pixelCount; i++) {
    if ((selectionMask[i] || 0) === 0) continue;
    const a = pixels[i * 4 + 3] || 0;
    if (a === 0) continue;
    hist[a]++;
    validCount++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (validCount === 0) {
    console.log('🔍 [alpha众对齐] 选区内没有 alpha>0 的像素，直接返回');
    return out;
  }

  // 2. 众数 = 出现次数最多的 alpha（并列时取更高的 alpha，避免整体偏淡）
  let modeA = 1;
  let modeCnt = -1;
  for (let v = 1; v < 256; v++) {
    const c = hist[v];
    if (c > modeCnt || (c === modeCnt && v > modeA)) {
      modeCnt = c;
      modeA = v;
    }
  }
  console.log('🔍 [alpha众对齐] 选区 alpha>0 像素=' + validCount + '  众数 alpha=' + modeA +
    '（' + modeCnt + ' 个，占 ' + (100 * modeCnt / validCount).toFixed(1) + '%）' +
    (modeA < MIN_ALPHA ? '  ⚠️ 众数低于 MIN_ALPHA，多由羽化/残留构成，结果会整体变淡，请留意' : ''));

  // 3. 选区羽化 support（与局部对齐同源）：中心完全对齐、选区边缘自然过渡
  const pad = FEATHER_RADIUS + 2;
  const x0 = minX - pad < 0 ? 0 : minX - pad;
  const y0 = minY - pad < 0 ? 0 : minY - pad;
  const x1 = maxX + pad >= width ? width - 1 : maxX + pad;
  const y1 = maxY + pad >= height ? height - 1 : maxY + pad;
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  const support = buildSelectionSupport(selectionMask, width, height, x0, y0, rw, rh);

  // 4. 写回：alpha>0 的像素统一到众数（alpha=0 的像素不动，不注入新的透明度）
  let changedCount = 0;
  let changedSample = '';
  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    const rowBaseR = ry * rw;
    for (let rx = 0; rx < rw; rx++) {
      const di = docY * width + (x0 + rx);
      const a = pixels[di * 4 + 3] || 0;
      if (a === 0) continue;
      const s01 = support[rowBaseR + rx] * (1 / 255);
      const t = Math.max(0, Math.min(1, (s01 - 0.22) / (0.995 - 0.22)));
      const fade = smootherstep01(smootherstep01(t));
      let na = Math.round(a + (modeA - a) * rate * fade);
      if (na < 0) na = 0;
      else if (na > 255) na = 255;
      if (na === a) continue;
      out[di * 4 + 3] = na;
      changedCount++;
      if (changedSample === '' && changedCount <= 3) {
        changedSample += '[' + (x0 + rx) + ',' + docY + ']a' + a + '→' + na + ' ';
      }
    }
  }
  console.log('🔍 [alpha众对齐] 修改像素数=' + changedCount + (changedSample ? ' 样例: ' + changedSample : ''));

  return out;
}
