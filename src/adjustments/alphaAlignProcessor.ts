// alpha对齐 算法 v10 —— 三档整片归一：上对齐→最深档、下对齐→最浅档、众对齐→众数档
//
// ⚠️ 本文件另含一套算法：**极值微调**（「提升下极值」/「削弱上极值」）。
//    它是 v5 的"逐像素多尺度环带参照"算法的回归版，专治**线条上的污渍**（局部现象），
//    并把作用通道从 alpha 扩展到 RGBA（颜色与不透明度一起修）。见文件末尾 processExtremeAlign。
//    两套算法互不影响：v10 三个按钮仍是整片归一，只动 alpha。
//
// ─────────────────────────────────────────────────────────────────────────
// v10：基准的定义（用户 2026-09-23 明确纠正）
// ─────────────────────────────────────────────────────────────────────────
//
//   上对齐：基准 = **选区内 alpha 的最大值** —— 把整片内容抬到选区里最深的那一档。
//   下对齐：基准 = **选区内 alpha 的最小值** —— 把整片内容压到选区里最浅的那一档。
//   众对齐（processAlphaModeAlign）：基准 = **选区内出现次数最多的 alpha**（众数）。
//
//   三个按钮共用同一次"选区直方图"，只是取的统计量不同 ⇒ 三个候选水平：
//   最浅（下）/ 最多（众）/ 最深（上），执行动作都是"整片归一"，覆盖选区内所有像素。
//
//   实现要点：
//     - 直方图 = 选区内 alpha >= MIN_ALPHA 的像素。低于 32 的是没擦干净的残留与羽化
//       尘埃，自 v1 起就被排除；若让它们参与"最小值"，下对齐会把整片压到近乎全透明
//       （等于把画面擦掉）。
//     - 写回无任何"找不到参照就跳过"的分支 ⇒ 遗漏在结构上不可能出现。
//     - 目标只是直方图的函数、与像素位置无关 ⇒ 同一个 alpha 处处同一结果 ⇒ 无斑驳/条纹。
//     - na = round(a + (target - a) × rate × fade)，fade 只由选区羽化 support 决定。
//
//   ⚠️ 整片归一 = 抹平：软笔刷的羽化过渡档、画稿里"有意画得更深的另一层"都会被一起拉到
//   目标水平。要保留多层级/软边结构，把选区缩小到需要统一的区域。
//
//   历史（详细推导、被否方案与实测数据见 .workbuddy/memory/refs/pixel-algorithms.md）：
//   v1~v6 逐像素多尺度环带参照（v5 参照场共识修斑驳/条纹、v6 低平台回退 + 上对齐孤立坑）；
//   v7 全局平台基准（两条保护合起来吃光 100% 候选 = 0 改动）；
//   v8 基准=众数的单侧写回（"内容全在众数之上"的画稿上对齐恒为空转）；
//   v9 基准=同侧计数最多的一档（方向反了：上对齐会把凸起继续往更高的一层抬）。
//   以上路线均已放弃，勿重走。
//
//  仍然只改 alpha，RGB 不动；选区边缘羽化 support 与 rate 的语义与 v1 完全一致。

// 目标：画师用半透明（带羽化）笔刷画线时，两笔交叉/叠画处会因不透明度叠加而形成一个
// 较"深"（不透明度更高）的区域；反过来，反复擦 / 没画透的地方会留下偏淡的斑块。
// 本算法把选区内容整体归一到一个选定水平 —— 下对齐取最浅的、上对齐取最深的、
// 众对齐取最多的，都是"整片统一"，不是"只修局部凸起"。
//
// ─────────────────────────────────────────────────────────────────────────
// 语义自 v1 起从未改变的部分
// ─────────────────────────────────────────────────────────────────────────
//       - 只处理"选区内 alpha > 0"的像素作为修改候选；只改 alpha，RGB 保持不变；
//       - 基准统计与写回范围都取自**选区内的像素**（v10 起。v1~v9 让基准可以引用选区外
//         的线条，那是"逐像素环带找周围水平"那条旧路线的产物，已随该路线一起废弃）；
//       - minAlpha 排除没擦干净的极低不透明度残留（详见文件头）；
//       - 选区边缘用 support 羽化；rate = strength（默认 1.0）把像素完全落到基准水平。
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
const MIN_ALPHA = 32;                  // 低于该不透明度视为残留/噪声，不参与对齐
const FEATHER_RADIUS = 20;             // 选区边缘羽化半径（语义同 v1；实现为 box 级联）
const EXTREME_WARN_SHARE = 0.01;       // 仅用于 console 提示：基准档像素占比低于该值时警告
                                       // "整片会被孤立极值带走"（不改语义，只提醒，便于排查）

// ---- 极值微调常量（继承 v5 多尺度环带参照，仅供 processExtremeAlign 使用）----
// 说明：v10 的三档整片归一只用 MIN_ALPHA / FEATHER_RADIUS（上面两个），不需要环带；
//       下面这些是"局部参照"路线（v5）的全套参数，随该路线一起在本文件中复活。
const RING_WIDTH = 3;                  // 每个环形邻域的宽度（Chebyshev 带 [k, k+RING_WIDTH]）
const MAX_SCALE = 112;                 // 最大环内半径：覆盖 100px 线宽交叉的凸包（凸包半径≈55）
const RAY_LEN = MAX_SCALE + RING_WIDTH; // = 115，环带最远读取距离
const SCREEN_SCALES = [6, 14, 42, 112]; // 快速筛选用的尺度（覆盖小/中/大凸包）
const PEAK_THRESH = 5;                 // 与参照水平"显著不同"的最小量
// 多尺度环带（内半径序列，从内到外）：
//   k=1 捕捉软笔刷/极细线（core 仅 1~2px）的线主体；k=4 捕捉 3~8px 细线交叉；
//   k=14 / k=42 捕捉中粗线交叉凸包；k=112 捕捉大凸包（100px 级线宽）与色块主体。
const RING_SCALES = [1, 4, 14, 42, MAX_SCALE];
const RING_MIN_COUNT = 8;              // 环带有效像素下限：低于此视为无参照信息（孤立值/线端羽化点），跳过该尺度
const HIGH_CLUSTER_MIN = 4;            // "像素处于自身平台"的最小簇（绝对数）：用绝对数而非占比，
                                       // 因为软笔刷细线 core 只有 1~2px 宽，任何尺度环带里"同水平"像素
                                       // 都是固定的少数几个，占比阈值永远追不上 ⇒ 漏拦截致 core 被羽化值污染
const BRIGHT_CLUSTER_MIN_ABS = 5;      // "参照平台"的最小簇（绝对数）
const BRIGHT_CLUSTER_MIN_RATIO = 0.10; // 在环带的高端区间内从高到低找第一个计数 ≥ max(5, 10%环带) 的值作为参照
const QUANTILE_MIN_COUNT = 128;        // 中位数回退所需的最小环带有效像素（所有尺度都无稳定平台时用）
const CLOSE_DELTA = 8;                 // "平坦平台"判据的接近窗口：环带 [v, v+CLOSE_DELTA] 内占 ≥ HIGH_CLUSTER_MIN
                                       // 说明像素周围是"与自身同水平"的平台 → 不是污渍
const BRIGHT_GAP = 60;                 // 高端参照区间的宽度：参照只在环带 [max-BRIGHT_GAP, max] 内找
const REF_CONSENSUS_RADIUS = 6;        // 参照场共识窗口半径（方形，单位像素）：把同片区域的参照收敛到同一层级
const REF_CONSENSUS_SUPPORT = 3;       // 参照值在窗口内出现次数下限（防个别噪点把整片拉偏）
const REF_FILL_PROTECTED_DELTA = BRIGHT_GAP / 2; // (=30) 越过"已受保护"像素所需的落差门槛
const EXTREME_ALIGN_HALO = RAY_LEN + 2; // 区域外扩半径：保证块边缘像素也能取到完整的环形邻域

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
  const alignUp = direction === 'up';
  const rate = strength;              // 对齐比例（1.0 = 完全落到目标水平）

  // 1. 全图扫描：求"选区内容包围盒"（决定写回扫描与 support 的范围）
  let minX = width, minY = height, maxX = -1, maxY = -1, candCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if ((selectionMask[i] || 0) === 0) continue;
    if ((pixels[i * 4 + 3] || 0) === 0) continue;
    candCount++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (candCount === 0) {
    console.log('🔍 [alpha对齐] 选区内没有 alpha>0 的像素，直接返回');
    return out;
  }

  // 2. 参照域 = **选区本身**（v10，用户 2026-09-23 定义）。
  //    上对齐取选区内 alpha 的**最大值**、下对齐取**最小值**、alpha众对齐取**众数** ——
  //    三个按钮共用同一次"选区直方图"，只是取的统计量不同，构成三档候选水平：
  //    最浅（下对齐）/ 最多（众对齐）/ 最深（上对齐），都是整片归一。
  //    因此不再需要 halo：基准按定义就取自选区内，选区外的内容不参与。
  //    （halo 是"逐像素环带找周围水平"那条旧路线留下的机制，该路线已整体废弃。）
  //    下面的 bbox 只用于划定写回与羽化的扫描范围，不参与基准计算。
  const pad = FEATHER_RADIUS + 2;
  const x0 = minX - pad < 0 ? 0 : minX - pad;
  const y0 = minY - pad < 0 ? 0 : minY - pad;
  const x1 = maxX + pad >= width ? width - 1 : maxX + pad;
  const y1 = maxY + pad >= height ? height - 1 : maxY + pad;
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;

  // 3. 选区直方图（只统计 alpha >= MIN_ALPHA：更低的视为残留与羽化尘埃）
  const hist = new Uint32Array(256);
  let histCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if ((selectionMask[i] || 0) === 0) continue;
    const a = pixels[i * 4 + 3] || 0;
    if (a < minAlpha) continue;
    hist[a]++;
    histCount++;
  }
  if (histCount === 0) {
    console.log('🔍 [alpha对齐] 选区内没有 alpha>=' + minAlpha + ' 的像素，直接返回');
    return out;
  }

  // 4. 三档统计量（同一份直方图）：最浅 minA / 最多 modeA / 最深 maxA。
  //    基准（v10）：上对齐 = maxA（整片抬到选区内最深的水平）；
  //                下对齐 = minA（整片压到选区内最浅的水平）。
  //    与 alpha众对齐 的 modeA 合成完整的三档选择。
  //    ⚠️ 从 MIN_ALPHA 起算：低于 32 的是没擦干净的残留/羽化尘埃，若让它们参与"最小值"，
  //    下对齐会把整片压到近乎全透明（等于擦掉画面）。这是"排除极低不透明度干扰"的同一
  //    条既有语义，自 v1 起未变。
  let minA = minAlpha;
  let maxA = minAlpha;
  for (let v = minAlpha; v < 256; v++) { if (hist[v] > 0) { minA = v; break; } }
  for (let v = 255; v >= minAlpha; v--) { if (hist[v] > 0) { maxA = v; break; } }
  let modeA = minAlpha;
  let modeCnt = -1;
  for (let v = minAlpha; v < 256; v++) {
    const c = hist[v];
    if (c > modeCnt || (c === modeCnt && v > modeA)) { modeCnt = c; modeA = v; }
  }
  const target = alignUp ? maxA : minA;
  const targetCnt = hist[target];
  const targetShare = targetCnt / histCount;

  console.log('🔍 [alpha对齐' + (alignUp ? '上' : '下') + ' v10] 尺寸=' + width + 'x' + height +
    ' 候选=' + candCount + ' 选区内 alpha>=' + minAlpha + ' 像素=' + histCount +
    ' | 最浅=' + minA + '(' + hist[minA] + ') 众数=' + modeA + '(' + hist[modeA] + ')' +
    ' 最深=' + maxA + '(' + hist[maxA] + ')' +
    ' | 基准=' + (alignUp ? '最深 ' : '最浅 ') + target +
    '(' + targetCnt + ' 个，占 ' + (100 * targetShare).toFixed(1) + '%)' +
    (targetShare < EXTREME_WARN_SHARE
      ? ' ⚠️ 基准档像素极少（<' + (100 * EXTREME_WARN_SHARE) + '%）：可能是残留/孤立极值，' +
        '整片会被它带走——如需排除请缩小选区或先清理该档像素'
      : ''));

  // 5. 选区边缘羽化 support（box 级联近似高斯，标准差约 10，语义同 v1，但 O(n)）
  const support = buildSelectionSupport(selectionMask, width, height, x0, y0, rw, rh);

  // 6. 写回：选区内**所有** alpha >= MIN_ALPHA 的像素一律朝目标水平靠（整片归一）——
  //    不论它原本在基准的哪一侧；没有任何"找不到参照就跳过"的分支。
  let lowAlphaCount = 0;   // 低于 MIN_ALPHA（残留/羽化尘埃）而跳过
  let sameCount = 0;       // 结果与原值相同（已在目标水平，或羽化 fade 后回落到原值）
  let changedCount = 0;
  let changedSample = '';

  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    const rowBaseDoc = docY * width;
    const rowBaseR = ry * rw;
    for (let rx = 0; rx < rw; rx++) {
      const di = rowBaseDoc + (x0 + rx);
      if ((selectionMask[di] || 0) === 0) continue;
      const a = pixels[di * 4 + 3] || 0;
      if (a === 0) continue;                     // alpha=0 不动，不注入新的透明度
      // 修改候选与 v1 同口径：MIN_ALPHA 以下视为残留，不参与（否则会把近乎透明的
      // 边角一路抬到目标水平，等于凭空放大轮廓）
      if (a < minAlpha) { lowAlphaCount++; continue; }

      // 落到目标水平：rate 决定对齐比例，support 决定选区边缘的羽化过渡。
      const s01 = support[rowBaseR + rx] * (1 / 255);
      const t = Math.max(0, Math.min(1, (s01 - 0.22) / (0.995 - 0.22)));
      const fade = smootherstep01(smootherstep01(t));
      let na = Math.round(a + (target - a) * rate * fade);
      if (na < 0) na = 0;
      else if (na > 255) na = 255;
      if (na === a) { sameCount++; continue; }

      out[di * 4 + 3] = na;
      changedCount++;
      if (changedSample === '' && changedCount <= 3) {
        changedSample += '[' + (x0 + rx) + ',' + docY + ']a' + a + '→' + na + ' ';
      }
    }
  }
  console.log('🔍 [alpha对齐' + (alignUp ? '上' : '下') + ' v10] 候选=' + candCount +
    ' 残留跳过=' + lowAlphaCount + ' 已在目标=' + sameCount +
    ' 修改像素数=' + changedCount + (changedSample ? ' 样例: ' + changedSample : ''));
  if (changedCount === 0) {
    console.log('🔍 [alpha对齐' + (alignUp ? '上' : '下') + ' v10] 本次未修改任何像素：' +
      '选区内 alpha>=' + minAlpha + ' 的内容本来就在目标水平 ' + target + '。');
  }

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

// ===========================================================================
// 极值微调 —— 「提升下极值」/「削弱上极值」（线条上的污渍专用）
// ===========================================================================
//
// 为什么需要这两个按钮（v10 之后）：
//   v10 的「整片归一」对色块非常有效（同一次选区直方图取极值/众数 ⇒ 空间完全一致、
//   结构上不可能有遗留），但它的动作是**抹平** —— 线条画稿里"有意画得更深的另一层"、
//   软笔刷的羽化过渡档都会被一起压/抬到同一水平。线条上的污渍是**局部**现象，
//   要修它就得有**局部参照**；于是把 v5 的「逐像素多尺度环带参照」请回来，
//   另立两个按钮专管线稿。
//
// 语义（按钮名就是判据）：
//   提升下极值 raiseLow  （= v5 的"上对齐"）：把**偏低**的值抬到本线条主体水平，只增不减。
//   削弱上极值 weakenHigh（= v5 的"下对齐"）：把**偏高**的值压低到本线条主体水平，只减不增。
//
// 与 v5 的唯一差别 —— 作用通道从 alpha 扩到 RGBA：
//   画线时颜色与不透明度会一起被蹭脏（半透明笔刷叠画 / 擦除 / 边缘混色），只修 alpha
//   会留下"不透明度对了、颜色还是脏的"的残留。四个通道用**同一套算法各自独立跑一遍**：
//     · 判"哪些像素属于线条"的闸门始终是 **alpha ≥ MIN_ALPHA**（与 v5 完全一致 ——
//       线条的几何由 alpha 定义，与通道值无关）；
//     · 每个通道的环带直方图 / 参照簇 / 平坦拦截 / 共识 / 补判 / 写回全部用**该通道自己的值**；
//     · alpha 通道因此与 v5 逐字节一致（它的"通道值"就是 alpha）。
//   ⇒ 一处污渍会同时被"不透明度"和"颜色"两个维度修回线条本色：偏暗的污渍被提升下极值
//     抬回线色，偏亮的污渍被削弱上极值压回线色（两侧对称，实测见 refs）。
//
// ⚠️ 相对 v5 的两处刻意取舍（都是"通道语义"决定的，不是简化）：
//   ① 「本层邻域」护栏（bandMax > v + BRIGHT_GAP 的尺度直接跳过）**只对 alpha 通道生效**。
//      alpha 的"另一层"真实存在（另一条线 / 叠画带），环带明显更亮确实说明它已跑出本层；
//      但 RGB 没有"层"语义，通道落差**本身就是污渍** —— 照搬护栏会让偏离 >60 的色斑
//      被整个跳过，而那正是要修的对象。
//   ② 参照高端区间的下界由 minAlpha 改为 0：v5 里直方图只装 alpha 值（≥minAlpha），
//      夹到 minAlpha 无副作用；RGB 通道值可以落在 0~255 任意处，夹 minAlpha 会让
//      "深色线条"（如 RGB=30）整个找不到参照。
//
// 其余全部继承 v5（含 v5 的参照场空间一致化：窗口内达标的参照极值收敛 + 漏判补判）：
//   · 环带参考像素是**所有画过的线条像素**（不受选区限制）⇒ 小选区也能找到"单线水平"；
//     选区只决定"哪些像素会被修改"，不决定"在哪里找参考"；
//   · 多尺度环带 k = 1/4/14/42/112 + 高端平台簇 + 平坦拦截 + 中位数回退；
//   · 两遍处理（第二遍读第一遍修改后的值，等价"再点一次"但一次完成）；
//   · 参照场共识（R=6）：同片区域的像素收敛到同一层级，消除斑驳/条纹，并补判漏网像素；
//   · 选区边缘用 support 羽化；rate = strength（默认 1.0，完全拉到参照水平）。
//
// 只修改选区内 **alpha ≥ MIN_ALPHA** 的像素（低于此的是没擦干净的残留与羽化尘埃，
// 动它们会把近乎透明的边角一路抬到主体水平、凭空放大轮廓）；alpha=0 的像素绝不注入
// 不透明度。返回的 out 与 layerPixelData 同尺寸，调用方按选区系数混合后写回。

export type ExtremeAlignParams = {
  strength?: number; // 0~1，默认 1，整体缩放"拉回参照"的比例
};

/** 极值微调方向：raiseLow = 提升下极值（只增不减）；weakenHigh = 削弱上极值（只减不增）。 */
export type ExtremeDirection = 'raiseLow' | 'weakenHigh';

export async function processExtremeAlign(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: Bounds,
  params: ExtremeAlignParams = {},
  isBackgroundLayer: boolean = false,
  direction: ExtremeDirection = 'weakenHigh'
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

  const rate = clamp01(typeof params.strength === 'number' ? params.strength : 1);
  const raise = direction === 'raiseLow';
  const minAlpha = MIN_ALPHA;
  const peakThresh = PEAK_THRESH;
  const ringWidth = RING_WIDTH;

  // 1. 选区包围盒：只用来划定"扫描与羽化"的区域范围 —— 参照由每个像素自己的环带给出，
  //    选区只决定"哪些像素会被修改"，不决定"在哪里找参考"（与 v5 同）。
  let minX = width, minY = height, maxX = -1, maxY = -1, validCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if ((selectionMask[i] || 0) === 0) continue;
    if ((pixels[i * 4 + 3] || 0) === 0) continue;
    validCount++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (validCount === 0) {
    console.log('🔍 [极值微调] 选区内没有 alpha>0 的像素，直接返回');
    return out;
  }

  // 2. 区域 = 选区包围盒 + halo：环带允许读到选区外的线条像素，小选区也能引用选区外的
  //    线条找到"单线水平"（v5 的关键设计，勿改成"只读选区内"）。
  const pad = EXTREME_ALIGN_HALO;
  const x0 = minX - pad < 0 ? 0 : minX - pad;
  const y0 = minY - pad < 0 ? 0 : minY - pad;
  const x1 = maxX + pad >= width ? width - 1 : maxX + pad;
  const y1 = maxY + pad >= height ? height - 1 : maxY + pad;
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  const rn = rw * rh;

  // 区域像素副本：四通道扫描都要反复随机读，先拷成紧凑数组（getPixels 是 straight 数据，
  // 颜色不随不透明度改变 ⇒ RGB 可以独立修改）。
  const rgba = new Uint8Array(rn * 4);
  const vR = new Uint8Array(rn); // 选区内 & alpha>0：只有它们参与"修改候选"与参照场补判
  for (let ry = 0; ry < rh; ry++) {
    const rowBaseDoc = (y0 + ry) * width;
    const rowBaseR = ry * rw;
    for (let rx = 0; rx < rw; rx++) {
      const di = rowBaseDoc + (x0 + rx);
      const ri = rowBaseR + rx;
      rgba[ri * 4] = pixels[di * 4];
      rgba[ri * 4 + 1] = pixels[di * 4 + 1];
      rgba[ri * 4 + 2] = pixels[di * 4 + 2];
      rgba[ri * 4 + 3] = pixels[di * 4 + 3];
      vR[ri] = ((selectionMask[di] || 0) > 0 && pixels[di * 4 + 3] > 0) ? 1 : 0;
    }
  }

  // 3. 选区边缘羽化 support（box 级联近似高斯，σ≈10，语义同 v1，但 O(n)）。
  //    四个通道共用：羽化只描述"选区边界怎么过渡"，与通道无关。
  const support = buildSelectionSupport(selectionMask, width, height, x0, y0, rw, rh);

  // 4. 逐通道（R/G/B/A）独立跑完整套分析 + 写回。四个通道的临时数组只分配一次、循环复用
  //    （区域可能很大，不能每通道再来一轮分配）。
  const CH_NAMES = ['R', 'G', 'B', 'A'];
  const suspicious = new Uint8Array(rn);
  const refMin = new Uint16Array(rn);
  const flatAll = new Uint8Array(rn);
  const curV = new Uint8Array(rn);
  const base = new Uint16Array(rn);
  const histBuf = new Uint16Array(256);
  const chi = new Uint16Array(256);
  const dirName = raise ? '提升下极值' : '削弱上极值';
  console.log('🔍 [极值微调·' + dirName + '] 尺寸=' + width + 'x' + height +
    ' 候选=' + validCount + ' 区域=' + rw + 'x' + rh + '(halo=' + pad + ')');

  const clearHist = () => { for (let v = 0; v < 256; v++) histBuf[v] = 0; };
  // 参照平台的最小簇：绝对数下限保护小环带（同 v5）
  const brightClusterMin = (cnt: number, ratio: number) => {
    const t = (cnt * ratio) | 0;
    return t > BRIGHT_CLUSTER_MIN_ABS ? t : BRIGHT_CLUSTER_MIN_ABS;
  };

  let totalChanged = 0;

  for (let ch = 0; ch < 4; ch++) {
    // 「层」护栏只对 alpha 生效（见文件头 ①）
    const guardLayer = ch === 3;

    // ---- 4.1 快速筛选：环带里存在明显偏离自身的水平 ⇒ 可疑（可能被污渍污染）----
    //   单线像素：采样点都是自身线水平 → 不可疑，零误伤；
    //   污渍像素：朝外采样拿到线条主体水平 → 最小值明显低于自身（削弱）或
    //             最大值明显高于自身（提升）⇒ 标记可疑。
    let screenCount = 0;
    suspicious.fill(0);
    for (let ry = 0; ry < rh; ry++) {
      const rowBaseR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowBaseR + rx;
        if (vR[ri] === 0) continue;
        if (rgba[ri * 4 + 3] < minAlpha) continue;
        const v = rgba[ri * 4 + ch];
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
              const bi = (ny * rw + nx) * 4;
              if (rgba[bi + 3] < minAlpha) continue; // 只认线条像素（与通道值无关）
              const s = rgba[bi + ch];
              if (s < minSample) minSample = s;
              if (s > maxSample) maxSample = s;
            }
          }
          if (raise) {
            if (maxSample >= 0 && maxSample > v + peakThresh) isSuspicious = true;
          } else if (minSample < 65535 && minSample < v - peakThresh) {
            isSuspicious = true;
          }
        }
        if (isSuspicious) { suspicious[ri] = 1; screenCount++; }
      }
    }

    // ---- 4.2 完整分析（两遍）----
    //    第一遍固定读**原通道值**（判定与处理顺序无关，避免"前面像素被提前修好导致环带
    //    统计漂移"）；第二遍读第一遍修改后的值（污渍被拉回后环带参照自然正确，
    //    等价"再点一次"的机理，但一次完成）。
    refMin.fill(65535);
    flatAll.fill(0);
    for (let i = 0; i < rn; i++) curV[i] = rgba[i * 4 + ch];

    let readCur = false; // false = 读原值（第一遍）；true = 读 curV（第二遍）
    let curRx = 0;
    let curRy = 0;
    // 「本层邻域」护栏本次分析是否命中过（仅 alpha 通道会命中）：用于统计"疑似被护栏拦下"
    // 的像素数 —— 这类像素的落差超过了 BRIGHT_GAP，日志里会单独报出来（便于判断是否该放宽）。
    let guardHit = false;
    const valAt = (ri: number) => (readCur ? curV[ri] : rgba[ri * 4 + ch]);

    // 把当前像素 (rx,ry) 的 Chebyshev 带 [k, k+RING_WIDTH] 内、alpha≥MIN_ALPHA 的像素
    // 的**本通道值**累加到 histBuf，并统计 cnt（有效像素数）/ bandMax（本通道最大值）。
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
            const bi = (rowBase + nx) * 4;
            if (rgba[bi + 3] < minAlpha) continue;
            const s = readCur ? curV[rowBase + nx] : rgba[bi + ch];
            cnt++;
            histBuf[s]++;
            if (s > bandMax) bandMax = s;
          }
        } else {
          for (let dx = -outer; dx <= -inner; dx += step) {
            const nx = curRx + dx;
            if (nx < 0) continue;
            const bi = (rowBase + nx) * 4;
            if (rgba[bi + 3] < minAlpha) continue;
            const s = readCur ? curV[rowBase + nx] : rgba[bi + ch];
            cnt++;
            histBuf[s]++;
            if (s > bandMax) bandMax = s;
          }
          for (let dx = inner; dx <= outer; dx += step) {
            const nx = curRx + dx;
            if (nx >= rw) continue;
            const bi = (rowBase + nx) * 4;
            if (rgba[bi + 3] < minAlpha) continue;
            const s = readCur ? curV[rowBase + nx] : rgba[bi + ch];
            cnt++;
            histBuf[s]++;
            if (s > bandMax) bandMax = s;
          }
        }
      }
      return { cnt, bandMax };
    };

    // 削弱上极值（= v5 下对齐）：参照取环带**高端稳定簇**（线条主体水平）中**最低**的候选，
    // 只把"显著高于该水平"的值压回去。候选取最低：小尺度环带可能命中过渡值，
    // 大尺度环带里线条主体占比上升、胜出，纠正小尺度误选。
    const analyzeDown = (ri: number): number => {
      const v = valAt(ri);
      let bestRef = 65535;
      let qHist: Uint16Array | null = null; // 中位数回退用直方图（有效的大尺度候选）
      let qCnt = 0;
      let midFlat = false;    // 中尺度（k14/k42）确认"像素在自身平台"
      let midNonFlat = false; // 中尺度出现"非平坦"（污渍带）
      for (let si = 0; si < RING_SCALES.length; si++) {
        const k = RING_SCALES[si];
        const r = scanBand(k, 1); // 全采样填充 histBuf
        const cnt = r.cnt;
        if (cnt < RING_MIN_COUNT) {
          // 环带里几乎没有参照像素（孤立值/极细线）→ 该尺度无信息
          clearHist();
          continue;
        }
        // 自身平台拦截：环带内 ≥v 的像素数达阈值，且其中 ≥HIGH_CLUSTER_MIN 个落在
        // [v, v+CLOSE_DELTA] 内 ⇒ 周围是与自身同水平的平台（线条主体/均匀色块）→ 不是污渍。
        let highCount = 0;
        for (let t = v; t < 256; t++) highCount += histBuf[t];
        if (highCount >= HIGH_CLUSTER_MIN) {
          let nearCount = 0;
          const nearMax = v + CLOSE_DELTA > 255 ? 255 : v + CLOSE_DELTA;
          for (let t = v; t <= nearMax; t++) nearCount += histBuf[t];
          if (nearCount >= HIGH_CLUSTER_MIN) {
            if (si === 2 || si === 3) midFlat = true;
            clearHist();
            continue;
          }
        }
        if (si === 2 || si === 3) midNonFlat = true;
        // 高端区间 [bandMax-BRIGHT_GAP, bandMax] 内找第一个计数达标的簇（= 线条主体水平）
        const bMin = brightClusterMin(cnt, BRIGHT_CLUSTER_MIN_RATIO);
        let loV = r.bandMax - BRIGHT_GAP;
        if (loV < 0) loV = 0; // 注：RGB 通道值可以很低，下界必须是 0（见文件头 ②）
        let v1 = -1;
        for (let t = r.bandMax; t >= loV; t--) {
          if (histBuf[t] >= bMin) { v1 = t; break; }
        }
        if (v1 < 0) {
          if (cnt >= QUANTILE_MIN_COUNT) { qHist = new Uint16Array(histBuf); qCnt = cnt; }
          clearHist();
          continue;
        }
        if (v1 < v - peakThresh) {
          if (v1 < bestRef) bestRef = v1;
          clearHist();
          continue;
        }
        if (v1 < v) {
          // 接近自身（差 < peakThresh）：环带中存在与自身同水平的稳定簇 → 不是污渍，保护
          flatAll[ri] = 1;
          clearHist();
          return 65535;
        }
        // v1 ≥ v：像素在更高水平区域内（环带高端被它主导）→ 放大尺度再试
        clearHist();
        continue;
      }
      if (bestRef < 65535) return bestRef;
      if (midFlat && !midNonFlat) { flatAll[ri] = 1; return 65535; }
      if (qHist !== null && qCnt >= QUANTILE_MIN_COUNT) {
        const half = qCnt / 2;
        let acc = 0;
        for (let t = 0; t < 256; t++) {
          acc += qHist[t];
          if (acc >= half) {
            if (t < v - peakThresh) return t;
            break;
          }
        }
      }
      // 无法确认是污渍 → 不改，且第二遍跳过（防环带污染误伤）
      flatAll[ri] = 1;
      return 65535;
    };

    // 提升下极值（= v5 上对齐）：参照取环带高端稳定簇（线条主体水平）中**最高**的候选，
    // 只把"显著低于该水平"的值抬回来。
    const analyzeUp = (ri: number): number => {
      const v = valAt(ri);
      let bestRef = -1;
      let qHist: Uint16Array | null = null;
      let qCnt = 0;
      let midFlat = false;
      let midNonFlat = false;
      let sawBelow = false; // 出现过"高端簇 ≤ 自身"（像素并不偏淡）→ 禁用中位数回退
      for (let si = 0; si < RING_SCALES.length; si++) {
        const k = RING_SCALES[si];
        const r = scanBand(k, 1);
        const cnt = r.cnt;
        if (cnt < RING_MIN_COUNT) {
          clearHist();
          continue;
        }
        // 「本层邻域」护栏（仅 alpha 通道，见文件头 ①）：环带最亮值已高出自身 BRIGHT_GAP
        // 以上 → 该环带已跑出本像素所在的那一层，采到的是别的层，不能当参照。
        if (guardLayer && r.bandMax > v + BRIGHT_GAP) {
          guardHit = true; // 诊断用：累计"护栏拦下"的像素数（见写回前的日志）
          clearHist();
          continue;
        }
        let highCount = 0;
        for (let t = v; t < 256; t++) highCount += histBuf[t];
        if (highCount >= HIGH_CLUSTER_MIN) {
          let nearCount = 0;
          const nearMax = v + CLOSE_DELTA > 255 ? 255 : v + CLOSE_DELTA;
          for (let t = v; t <= nearMax; t++) nearCount += histBuf[t];
          if (nearCount >= HIGH_CLUSTER_MIN) {
            if (si === 2 || si === 3) midFlat = true;
            clearHist();
            continue;
          }
        }
        if (si === 2 || si === 3) midNonFlat = true;
        const bMin = brightClusterMin(cnt, BRIGHT_CLUSTER_MIN_RATIO);
        let loV = r.bandMax - BRIGHT_GAP;
        if (loV < 0) loV = 0;
        let v1 = -1;
        for (let t = r.bandMax; t >= loV; t--) {
          if (histBuf[t] >= bMin) { v1 = t; break; }
        }
        if (v1 < 0) {
          if (cnt >= QUANTILE_MIN_COUNT) { qHist = new Uint16Array(histBuf); qCnt = cnt; }
          clearHist();
          continue;
        }
        if (v1 > v + peakThresh) {
          if (v1 > bestRef) bestRef = v1;
          clearHist();
          continue;
        }
        if (v1 > v) {
          flatAll[ri] = 1;
          clearHist();
          return 65535;
        }
        // 高端簇 ≤ 自身：像素不低于周围线条水平 → 非偏淡
        sawBelow = true;
        clearHist();
        continue;
      }
      if (midFlat && !midNonFlat) { flatAll[ri] = 1; return 65535; }
      if (bestRef >= 0) return bestRef;
      if (sawBelow) { flatAll[ri] = 1; return 65535; }
      if (midFlat) { flatAll[ri] = 1; return 65535; }
      if (qHist !== null && qCnt >= QUANTILE_MIN_COUNT) {
        const half = qCnt / 2;
        let acc = 0;
        for (let t = 0; t < 256; t++) {
          acc += qHist[t];
          if (acc >= half) {
            if (t > v + peakThresh) return t;
            break;
          }
        }
      }
      flatAll[ri] = 1;
      return 65535;
    };

    const analyze = (ri: number): number => (raise ? analyzeUp(ri) : analyzeDown(ri));

    let analyzedCount = 0;
    let guardBlocked = 0; // 诊断：无参照、且至少命中过一次「本层邻域」护栏的像素数
    // ---- 第一遍：处理主体 ----
    for (let ry = 0; ry < rh; ry++) {
      const rowBaseR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowBaseR + rx;
        if (suspicious[ri] === 0) continue;
        analyzedCount++;
        curRx = rx;
        curRy = ry;
        guardHit = false;
        const ref = analyze(ri);
        if (ref < 65535) {
          refMin[ri] = ref;
          curV[ri] = ref; // 更新当前状态（第二遍环带可读到修好后的主体水平）
        } else if (guardHit) {
          guardBlocked++;
        }
      }
    }
    // ---- 第二遍：处理第一遍未解决的像素（污渍深处/角部残余）----
    //   跳过"非污渍"像素（flatAll：它们处于自身平台；第二遍环带已含第一遍修改值，
    //   重判会被污染误伤）
    readCur = true;
    for (let ry = 0; ry < rh; ry++) {
      const rowBaseR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowBaseR + rx;
        if (suspicious[ri] === 0 || refMin[ri] < 65535 || flatAll[ri] !== 0) continue;
        curRx = rx;
        curRy = ry;
        guardHit = false;
        const ref = analyze(ri);
        if (ref < 65535) refMin[ri] = ref;
        else if (guardHit) guardBlocked++;
      }
    }

    // ---- 4.3 参照场空间一致化（v5）----
    //   逐像素独立估计的参照在同一片区域里可能落到不同层级，修完就成了棋盘状斑驳、
    //   沿笔触连成条纹。这里对参照场做一次"窗口内出现次数达标的参照极值共识"：
    //     削弱上极值 = 窗口内计数达标的**最低**参照（只降不升，取最低无副作用）；
    //     提升下极值 = 窗口内参照的**下中位数**（≈像素所在层的水平）。
    //       v5 曾保留"取最高"作对照，实测整片会被抬到窗口里最亮的层、粗糙度反弹 ⇒ 不采纳。
    //   另做漏判补判：分析阶段没拿到参照、也没被保护的像素，若窗口共识与自身明显不同，
    //   一并对齐（修复"同片区域只改了一部分"）。
    if (REF_CONSENSUS_RADIUS > 0) {
      base.set(refMin); // 读原始参照场，避免边写边读（iron law：就地更新禁止读已被自身变更的数组）
      const CR = REF_CONSENSUS_RADIUS;
      let fixedCount = 0;
      let filledCount = 0;
      let protectedFilledCount = 0;
      for (let ry = 0; ry < rh; ry++) {
        for (let rx = 0; rx < rw; rx++) {
          const ri = ry * rw + rx;
          if (vR[ri] === 0) continue;
          const ny0 = ry - CR < 0 ? 0 : ry - CR;
          const ny1 = ry + CR >= rh ? rh - 1 : ry + CR;
          const nx0 = rx - CR < 0 ? 0 : rx - CR;
          const nx1 = rx + CR >= rw ? rw - 1 : rx + CR;
          let refCnt = 0;
          for (let ny = ny0; ny <= ny1; ny++) {
            const rowBase = ny * rw;
            for (let nx = nx0; nx <= nx1; nx++) {
              const rv = base[rowBase + nx];
              if (rv >= 65535) continue;
              chi[rv]++;
              refCnt++;
            }
          }
          if (refCnt === 0) continue;
          let chosen = -1;
          if (!raise) {
            for (let t = 0; t < 256; t++) {
              if (chi[t] >= REF_CONSENSUS_SUPPORT) { chosen = t; break; }
            }
          } else {
            const half = refCnt / 2;
            let acc = 0;
            for (let t = 0; t < 256; t++) {
              acc += chi[t];
              if (acc >= half) { chosen = t; break; }
            }
          }
          for (let t = 0; t < 256; t++) chi[t] = 0;
          if (chosen < 0) continue;
          const own = base[ri];
          if (own < 65535) {
            // 已有参照：向共识层级收敛（只往"更该走"的方向并，另一个方向留给别的像素）
            const merged = raise ? (chosen > own ? chosen : own) : (chosen < own ? chosen : own);
            if (merged !== own) { refMin[ri] = merged; fixedCount++; }
          } else {
            // 无参照 → 补判。补判对象仍须满足 MIN_ALPHA（与"修改候选"同一口径）
            if (rgba[ri * 4 + 3] < minAlpha) continue;
            const wasProtected = flatAll[ri] !== 0;
            const fillThresh = wasProtected ? REF_FILL_PROTECTED_DELTA : peakThresh;
            const v = rgba[ri * 4 + ch];
            const deviates = raise ? (v < chosen - fillThresh) : (v > chosen + fillThresh);
            if (deviates) {
              refMin[ri] = chosen;
              flatAll[ri] = 0;
              filledCount++;
              if (wasProtected) protectedFilledCount++;
            }
          }
        }
      }
      if (filledCount > 0 || fixedCount > 0) {
        console.log('🔍 [极值微调·' + dirName + '] ' + CH_NAMES[ch] + ' 参照场一致化(R=' + CR + ')：收敛 ' +
          fixedCount + ' 个 / 补判 ' + filledCount + ' 个（其中越过保护 ' + protectedFilledCount + ' 个）');
      }
    }

    // ---- 4.4 写回本通道 ----
    //   方向闸门：提升下极值只增不减、削弱上极值只减不增（与按钮名严格一致）。
    //   RGB 与 alpha 走完全相同的公式与闸门 ⇒ 一处污渍在"颜色"和"不透明度"上被同时修正。
    let changedCount = 0;
    let changedSample = '';
    for (let ry = 0; ry < rh; ry++) {
      const docY = y0 + ry;
      const rowBaseDoc = docY * width;
      const rowBaseR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowBaseR + rx;
        if (vR[ri] === 0) continue;
        const ref = refMin[ri];
        if (ref >= 65535) continue;
        // 修改候选口径与 v5 一致：alpha ≥ MIN_ALPHA（残留与羽化尘埃不参与）
        if (rgba[ri * 4 + 3] < minAlpha) continue;
        const v = rgba[ri * 4 + ch];
        const di = rowBaseDoc + (x0 + rx);
        // 目标值（不带羽化）→ 再用 support 做选区边缘过渡
        let target = Math.round(v + (ref - v) * rate);
        if (target < 0) target = 0;
        else if (target > 255) target = 255;
        const s01 = support[ri] * (1 / 255);
        const t = Math.max(0, Math.min(1, (s01 - 0.22) / (0.995 - 0.22)));
        const fade = smootherstep01(smootherstep01(t));
        let nv = Math.round(v + (target - v) * fade);
        if (raise ? (nv < v) : (nv > v)) nv = v; // 方向闸门
        if (nv < 0) nv = 0;
        else if (nv > 255) nv = 255;
        if (nv === v) continue;
        out[di * 4 + ch] = nv;
        changedCount++;
        if (changedSample === '' && changedCount <= 3) {
          changedSample += '[' + (x0 + rx) + ',' + docY + ']' + CH_NAMES[ch] + v + '→' + nv + '(ref' + ref + ') ';
        }
      }
    }
    totalChanged += changedCount;
    console.log('🔍 [极值微调·' + dirName + '] ' + CH_NAMES[ch] + ' 可疑=' + screenCount +
      ' 分析=' + analyzedCount + ' 修改=' + changedCount +
      (guardBlocked > 0
        ? ' 护栏拦下=' + guardBlocked + '（落差 > ' + BRIGHT_GAP + '，判为"另一层"不作参照）'
        : '') +
      (changedSample ? ' 样例: ' + changedSample : ''));
  }

  console.log('🔍 [极值微调·' + dirName + '] 四通道合计修改像素写入=' + totalChanged +
    (totalChanged === 0 ? '（本次没有需要修的污渍）' : ''));

  return out;
}
