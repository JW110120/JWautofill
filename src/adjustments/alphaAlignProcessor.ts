// alpha对齐 算法 v10 —— 三档整片归一：上对齐→最深档、下对齐→最浅档、众对齐→众数档
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
