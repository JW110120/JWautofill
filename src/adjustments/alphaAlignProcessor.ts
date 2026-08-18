// alpha对齐 算法 v4 —— 多尺度环带参照 + 高端平台簇 + 中位数回退（无需手动切换粗细线模式）
//
// 目标（与 v1 相同）：画师用半透明（带羽化）笔刷画线时，两笔交叉处会因不透明度叠加而
// 形成一个较"深"（不透明度更高）的暗点。本算法把这种局部凸起的 alpha 拉回到周围线条的
// 自然水平，使交叉点与周边自然衔接，几乎看不出不透明度异常提高。
//
// v4 相对 v3 的改进（修复"细线差一口气/色块杂点无法统一化/线条斑驳"）：
//
//  1. 多尺度环带参照（核心改动）：
//     v3 只用 k4 + k112 两个固定尺度：软笔刷细线（core 仅 1~2px 宽）的环带 [4,7] 内
//     采样到的大多是"羽化带"值（如 42），众数判据把参照算成 42 → 交叉中心被拉到过暗、
//     单线 core 被误拉低（斑驳）；而细线场景 k112 大环带又采样不到线（cnt≈0）→ 卡死。
//     v4 改为尺度序列 k = [1, 4, 14, 42, 112] 从内到外逐个尝试，用两个新判据：
//       - "高端平台簇"：在 [minAlpha, alpha-peakThresh) 区间内，从高到低找第一个
//         计数达标（≥max(5, 10%环带)）的值作为参照。软笔刷细线交叉中心（alpha 212）
//         的 k1 环带里：羽化 42 有 18 个、core 150 有 8 个——从高到低先命中 150，
//         而不再被 42 污染（v3 的众数=42 是错的）；
//       - "自身平台拦截"：若环带 [alpha..255] 区间像素数 ≥ max(6, 15%环带)，
//         说明该像素处于"不低于自身水平"的平台/渐变中（单线 core、线羽化、渐变），
//         不是凸起 → 放大尺度再试；所有尺度都如此 → 不改。
//         （这也顺带修复了 v3 中 k112 大环带被"线端羽化孤立值"污染、
//          把单线 core 误拉低成斑驳的问题——孤立值环带 cnt 太小，直接被跳过。）
//  2. 中位数回退：当所有尺度都找不到稳定平台（如色块内部 alpha 不均匀/渐变波动，
//     v3 的"众数+占比"判据全部失败 → 杂点像素卡死、怎么点都无法统一化）时，
//     用最大环带（k112）的 alpha 中位数作为参照——波动色块的中位数≈色块主体水平，
//     杂点被正确拉回。
//  3. 两遍处理（保留）：第一遍用原始 alpha 处理能判定的像素；第二遍对"第一遍未解决"
//     的像素用"第一遍修改后的 alpha"重新判定——凸包区域被拉平后环带参照自然正确。
//  4. 性能（保留）：快速筛选（8方向×2半径×4尺度≈64次采样）排除绝大多数普通线条像素；
//     只有可疑像素进入完整分析；环带扫描直接遍历环形带像素（Chebyshev 带）。
//
// 其余语义与 v1 完全一致：
//   - 只处理"选区内 alpha > 0"的像素作为修改候选；只改 alpha，RGB 保持不变。
//   - 环形邻域的参考像素是**所有画过的线条像素**（alpha ≥ MIN_ALPHA），不受选区限制，
//     这样小选区也能引用选区外的线条找到"单线水平"，真正统一交叉点；
//     选区只决定"哪些像素会被修改"，不影响"在哪里找参考"。
//   - 通过 minAlpha 排除没擦干净的极低不透明度残留；peakThresh 忽略微小抖动与抗锯齿噪声。
//   - 选区边缘用 support 羽化；rate = strength（默认 1.0）把交叉点拉回单线水平。
//
// 说明：本函数只修改 alpha 通道，RGB 保持不变（图层存储的是 straight alpha，颜色
//       不随不透明度改变）。
//       返回的 out 数组与 layerPixelData 同尺寸；调用方按选区系数混合后再写回图层。

type Bounds = { width: number; height: number };

export type AlphaAlignParams = {
  strength?: number; // 0~1，默认 1，整体缩放拉回比例
  // 兼容旧参数：v2 已自适应粗细线，mode 不再生效，保留仅为 API 兼容。
  mode?: 'standard' | 'thick';
};

const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));

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
const BRIGHT_CLUSTER_MIN_RATIO_BG = 0.05; // "含背景"模式（withBg）的参照平台比例：
                                       // cntHigh 是环带内 >med（背景水平）的"线上像素"数，
                                       // 10% 对细线仍过大——软笔刷 4px 线 core 在环带里
                                       // 只有 8~24 个像素，10%×cntHigh（如 8~11）会卡在
                                       // 达标线之上，导致线 core 不被选中、羽化带当选，
                                       // 把交叉区边缘线像素拉低。5% + 绝对数下限 5 兜住。
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
const BRIGHT_DELTA = 10;               // "含背景"模式（withBg）的参照差距门槛：参照必须比
                                       // alpha 低至少该值才修改——只修"明显凸起"的交叉叠加
                                       // （交叉中心差 50+、十字臂/边缘过渡差 10+），避免把
                                       // "线条自身 vs 另一条略不同 alpha 的线"误拉低
                                       // （如 153 竖线 vs 145 横线差 8 < 10 不改；
                                       // 线自身像素另有"平坦拦截"保护，这是第二道防线）

// 分块处理所需的最大邻域半径（halo），保证块边缘像素也能取到完整的环形邻域
export const ALPHA_ALIGN_HALO = RAY_LEN + 2; // = 117

// 8 个方向的单位步进（快速筛选用）
const DIRS8: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
];

export async function processAlphaAlign(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: Bounds,
  params: AlphaAlignParams = {},
  isBackgroundLayer: boolean = false,
  withBg: boolean = false
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
  console.log('🔍 [alpha对齐 v3] 尺寸=' + width + 'x' + height + ' validCount=' + validCount +
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
          for (let d = 0; d < 8; d++) {
            const dx = DIRS8[d][0];
            const dy = DIRS8[d][1];
            for (let r2 = 0; r2 < 2; r2++) {
              const rr = r2 === 0 ? k : outer;
              const nx = rx + dx * rr;
              const ny = ry + dy * rr;
              if (nx < 0 || nx >= rw || ny < 0 || ny >= rh) continue;
              const s = aR[ny * rw + nx];
              if (s >= minAlpha && s < minSample) minSample = s;
            }
          }
          if (minSample < 65535 && minSample < a - peakThresh) isSuspicious = true;
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
    //
    // 含背景模式（withBg）：处理"低透明度背景（如 alpha=50 的色块）上画线"的场景。
    //   - 每尺度先估计背景水平（环带中位数 med），只统计 >med 的"线上像素"
    //     （cntHigh）做参照——簇阈值 bMin 基于 cntHigh 而非全环带，细线在背景
    //     主导的环带里也能命中（修复 1px 线交叉中心被拉向背景）；
    //   - 参照必须比 alpha 低至少 BRIGHT_DELTA（只修"明显凸起"的交叉叠加），
    //     避免把"线条自身/另一条略不同 alpha 的线"误拉低（如 153 竖线 vs 145 横线）；
    //   - 中位数回退取 ">med 像素" 的中位数（线主体水平），同样要求差 ≥BRIGHT_DELTA；
    //   - 背景像素（alpha≈med、环带主体是自身）被平坦拦截保护，不会被改。
    const analyzePixel = (ri: number): number => {
      const a = readSrc[ri];
      // 参照须比 alpha 低至少 refDelta（含背景模式更克制，只修明显凸起）
      const refDelta = withBg ? BRIGHT_DELTA : peakThresh;
      // 参照候选：含背景模式取**最高**候选（大尺度环带采到的羽化带/背景过渡值较低，
      // 取最高 = 线 core）；非含背景模式取**最低**候选（大尺度环带里线 core 胜出，
      // 纠正小尺度误选交叉过渡值）。
      let bestRef = withBg ? -1 : 65535;
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
        // 含背景模式：估计背景水平（环带中位数）与"线上像素数"（>med）
        let bgMed = -1;
        let cntHigh = cnt; // 非含背景：全部有效像素
        if (withBg) {
          const half = cnt / 2;
          let acc = 0;
          for (let v = 0; v < 256; v++) {
            acc += histBuf[v];
            if (acc >= half) { bgMed = v; break; }
          }
          cntHigh = 0;
          for (let v = bgMed + 1; v < 256; v++) cntHigh += histBuf[v];
          if (cntHigh < RING_MIN_COUNT) {
            // 该尺度几乎全是背景（无线上像素，如细线的 k112 大环带）→ 无参照信息
            clearHist();
            continue;
          }
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
          // 含背景模式：平坦判据用"与自身同水平像素的绝对数"（≥HIGH_CLUSTER_MIN）——
          // 大环带（k42/k112）常混入"另一条线/交叉区"的高值（如距交叉区 42-45px
          // 处环带采到 198×1/195×2），使 highCount 虚高、占比判据误判"非平坦"，
          // 导致线 core 像素不被保护、被交叉过渡值（140）拉低。
          // 只要环带里存在 ≥4 个"与自身同水平"（[a, a+CLOSE_DELTA]）的像素，
          // 说明像素处于自身线 core/平台上 → 拦截（放大尺度再试）。
          // 非含背景模式：保留占比判据（行为已调优）。
          const flat = withBg ? (nearCount >= HIGH_CLUSTER_MIN) : (nearCount * 2 >= highCount);
          if (flat) {
            // 平坦平台：不是凸起
            if (si === 2 || si === 3) midFlat = true; // k14/k42：中尺度平坦
            clearHist();
            continue;
          }
        }
        // 高端区间内找第一个计数达标的簇
        if (si === 2 || si === 3) midNonFlat = true; // k14/k42：中尺度非平坦（凸起带）
        const bMin = brightClusterMin(cntHigh, withBg ? BRIGHT_CLUSTER_MIN_RATIO_BG : BRIGHT_CLUSTER_MIN_RATIO); // 含背景模式基于"线上像素数"（背景不稀释阈值）
        let loV = r.bandMax - BRIGHT_GAP;
        if (loV < minAlpha) loV = minAlpha;
        if (withBg && bgMed + 1 > loV) loV = bgMed + 1; // 参照须高于背景
        let v1 = -1;
        for (let v = r.bandMax; v >= loV; v--) {
          if (histBuf[v] >= bMin) { v1 = v; break; }
        }
        if (v1 < 0) {
          // 高端区间无稳定簇 → 该尺度无参照信息，放大尺度。
          // 记录"有效的中位数候选"（后面的更大尺度覆盖前面的）：
          // 中位数回退不能只依赖 k112——色块/线条较小或贴边时，k112 环带可能完全
          // 落在内容之外（cnt=0），此时应回退到仍有足够采样的大尺度（如 k42）。
          if (withBg ? (cntHigh >= QUANTILE_MIN_COUNT) : (cnt >= QUANTILE_MIN_COUNT)) {
            qHist = new Uint16Array(histBuf);
            qCnt = withBg ? cntHigh : cnt;
          }
          clearHist();
          continue;
        }
        if (v1 < a - refDelta) {
          // 显著低于 alpha → 凸起，采纳为参照候选。
          // 含背景模式：取**最高**候选——大尺度环带（k42/k112）会采到另一条线的
          // 羽化带/背景过渡值（如 125/54），若取最低会被污染、把线像素拉到过暗；
          // 线 core 是环带高端簇，取最高 = 线 core（正确参照）。
          // 非含背景模式：取**最低**候选——小尺度环带可能命中交叉过渡值
          // （如 6px 交叉的 181），大尺度环带里线 core 占比上升、胜出，纠正误选。
          if (withBg ? (v1 > bestRef) : (v1 < bestRef)) bestRef = v1;
          clearHist();
          continue;
        }
        if (v1 < a) {
          // 接近 alpha（差 < refDelta）：环带中存在"与自身同水平的稳定簇"。
          // 含背景模式：这可能是另一条略不同 alpha 的线（153 vs 145 差 8）或
          // 线 core 与交叉凸起之间的过渡像素（如 160 附近有 153×8 的线 core）——
          // 像素基本处于线条自身水平附近，不是"显著凸起"，应该**保护**而非跳过
          // 继续找更低值（继续找会命中另一条线的羽化带 125，把线像素侵蚀变淡）。
          // 非含背景模式：同样语义，像素处于自身水平附近，不是凸起。
          flatAll[ri] = 1;
          clearHist();
          return 65535;
        }
        // v1 ≥ alpha：像素在凸包/渐变中（环带高端被凸包值主导）→ 放大尺度
        sawAbove = true;
        clearHist();
        continue;
      }
      // 含背景模式：中尺度（k14/k42）确认像素在自身平台、且无"非平坦"信号 →
      // 该像素是**普通线条像素**（处于自身线 core/羽化平台上），不是交叉凸起。
      // 此时任何尺度找到的参照都不可信——尤其 k112 大环带会避开交叉区、采到
      // 另一条线的羽化带/线端过渡值（如 125），把线 core（153）误拉低成"被背景
      // 侵蚀"的淡痕。必须优先保护（修复：交叉区外缘线像素 153→125 的侵蚀）。
      // 注意顺序：此保护必须放在 bestRef 返回之前，否则被大尺度参照短路。
      if (withBg && midFlat && !midNonFlat) {
        flatAll[ri] = 1;
        return 65535;
      }
      if (withBg ? (bestRef >= 0) : (bestRef < 65535)) return bestRef;
      // 含背景模式：所有尺度都"低于周围线水平"（v1 ≥ alpha，像素在 core 的羽化
      // 渐变带上，从未被判定为凸起）→ 不是凸起，禁用中位数回退（中位数会被
      // 羽化带值拉低，把线羽化边缘侵蚀变淡，如软 10px 线的 135→70、细线穿过
      // 粗线羽化区的 131→78）。
      if (withBg && sawAbove) {
        flatAll[ri] = 1;
        return 65535;
      }
      // 中尺度确认像素在自身平台 → 不是凸起，禁用中位数回退。
      // 含背景模式：只要 k14 平坦就保护（线 core/羽化像素；k42/k112 环带可能混入
      // 另一条线的羽化带/过渡值，若因此判定"非平坦"会误伤线自身）；
      // 非含背景模式：还需 k42 无非平坦信号（凸起带场景需要中位数回退修）。
      if (midFlat && (withBg || !midNonFlat)) {
        flatAll[ri] = 1;
        return 65535;
      }
      // 所有尺度都无有效参照：中位数回退（色块内部 alpha 不均匀等）
      if (qHist !== null && (withBg ? (qCnt >= RING_MIN_COUNT) : (qCnt >= QUANTILE_MIN_COUNT))) {
        if (withBg) {
          // 含背景模式：先检查环带中是否存在"与 alpha 接近"的稳定像素群
          // （[a-refDelta, a+CLOSE_DELTA] 内 ≥HIGH_CLUSTER_MIN 个）——说明像素处于
          // 自身线水平附近（如细线 core 153 穿过粗线羽化带叠加成 154），中位数回退
          // 会被"另一条线的羽化带"（如粗线 79）主导拉低 → 保护。
          // 交叉凸起中心（200）附近无此像素群（环带远离交叉区），不受影响。
          let nearSelf = 0;
          const loS = a - refDelta < 0 ? 0 : a - refDelta;
          const hiS = a + CLOSE_DELTA > 255 ? 255 : a + CLOSE_DELTA;
          for (let v = loS; v <= hiS; v++) nearSelf += qHist[v];
          if (nearSelf >= HIGH_CLUSTER_MIN) {
            flatAll[ri] = 1;
            return 65535;
          }
          // med 可能是"低水平背景"（如 alpha=50 的色块）主导。
          // 取 ">med 像素" 的中位数（线主体水平）作为参照，避免把画在背景上的
          // 线条/交叉凸起误拉向背景水平；参照仍须比 alpha 低至少 BRIGHT_DELTA。
          let total = 0;
          for (let v = 0; v < 256; v++) total += qHist[v];
          const half = total / 2;
          let acc = 0;
          let bgMed = -1;
          for (let v = 0; v < 256; v++) {
            acc += qHist[v];
            if (acc >= half) { bgMed = v; break; }
          }
          if (bgMed >= 0) {
            let cnt2 = 0;
            for (let v = bgMed + 1; v < 256; v++) cnt2 += qHist[v];
            if (cnt2 >= RING_MIN_COUNT) {
              const half2 = cnt2 / 2;
              let acc2 = 0;
              for (let v = bgMed + 1; v < 256; v++) {
                acc2 += qHist[v];
                if (acc2 >= half2) {
                  if (v < a - refDelta) return v;
                  break;
                }
              }
            }
          }
        } else {
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
      }
      // 无法确认是凸起 → 不改，且第二遍跳过（防环带污染误伤）
      flatAll[ri] = 1;
      return 65535;
    };

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
        const ref = analyzePixel(ri);
        if (ref < 65535) {
          refMin[ri] = ref;
          curA[ri] = ref; // 更新当前状态（第二遍环带可读到拉平后的单线水平）
        }
      }
    }
    // ---- 第二遍：处理第一遍未解决的像素（凸包角/深处残余）----
    //     跳过"非凸起"像素（flatAll：它们处于自身平台/接近自身水平；第二遍环带已含
    //     第一遍修改值，重判会被污染误伤）
    readSrc = curA; // 第二遍读第一遍修改后的 alpha（凸包拉平后环带参照自然正确）
    for (let ry = 0; ry < rh; ry++) {
      const rowBaseR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowBaseR + rx;
        if (suspicious[ri] === 0 || refMin[ri] < 65535 || flatAll[ri] !== 0) continue;
        curRx = rx;
        curRy = ry;
        const ref = analyzePixel(ri);
        if (ref < 65535) refMin[ri] = ref;
      }
    }
    console.log('🔍 [alpha对齐] 完整分析像素数=' + analyzedCount);
  }

  // 5. 选区边缘羽化 support（box 级联近似高斯，σ≈10，语义同 v1，但 O(n)）
  //    box 半径 b = FEATHER_RADIUS/2，3 次级联 σ ≈ b/√3 × √3 = b ≈ 10。
  //    用滑窗求和，边界按"窗口内有效像素数"归一化（等价 v1 的 weightSum 归一化）。
  const b = Math.max(1, Math.round(FEATHER_RADIUS * 0.5)); // = 10
  const support = new Float32Array(rn);
  const tmp1 = new Float32Array(rn);
  {
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
  }

  // 6. 对每个可疑像素：把高出"线条水平"的 alpha 拉低
  let changedCount = 0;
  let changedSample = '';

  // 选区边缘羽化（同 v1）：用 support 把 alpha 改动从"全改"渐变到"不改"，避免边界生硬
  const smootherstep01 = (t: number) => {
    const x = Math.max(0, Math.min(1, t));
    return x * x * x * (x * (x * 6 - 15) + 10);
  };

  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    const rowBaseR = ry * rw;
    for (let rx = 0; rx < rw; rx++) {
      const ri = rowBaseR + rx;
      if (suspicious[ri] === 0) continue;
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
      // 安全闸：算法语义是"把交叉凸起拉低到单线水平"，永远不应该让 alpha 升高。
      if (na > a) na = a;
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
  console.log('🔍 [alpha对齐] 修改像素数=' + changedCount + (changedSample ? ' 样例: ' + changedSample : ''));

  return out;
}
