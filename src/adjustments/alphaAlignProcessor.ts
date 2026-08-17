// alpha对齐 算法 v3 —— 自适应环带直方图参照（无需手动切换粗细线模式）
//
// 目标（与 v1 相同）：画师用半透明（带羽化）笔刷画线时，两笔交叉处会因不透明度叠加而
// 形成一个较"深"（不透明度更高）的暗点。本算法把这种局部凸起的 alpha 拉回到周围线条的
// 自然水平，使交叉点与周边自然衔接，几乎看不出不透明度异常提高。
//
// v3 核心设计：
//
//  1. 参照统计 = 环带直方图的"单线主体平台"（众数），配合"峰值判据"与"接近度"过滤：
//     - 单线主体（如 150）在凸包像素的环带中是绝对主导（占比 25%~100%）→ 命中；
//     - 孤立高值（凸包渐变中的个别 192/212）计数远小于主体 → 不会当选
//       （修复 v2 ringMax 被孤立高值污染 → 粗线斜交叉菱形凸包角残留"三角形"、
//       软笔刷交叉外围"残余高不透明区域"的问题——一次点击即归一化，无需第二次）；
//     - 软笔刷渐变是"等值环/台阶"（40/50/60 并列或单环占比虚高）→ 靠"峰值判据"
//       （众数 ≥2×次大）与"接近度"（alpha-众数 ≤BRIGHT_DELTA 或占比 ≥BULK）排除
//       → 渐变/单线边缘像素不被拉低（修复"多次使用后线条斑驳/被反复拉低"）。
//  2. 两遍处理（等价"第二次点击成功"的机理，但一次完成）：
//     第一遍用原始 alpha 处理能判定的像素（凸包主体、细交叉）；
//     第二遍对"第一遍未解决"的像素（凸包角/深处的残余，第一遍环带朝凸包内侧方向
//     被凸包值污染导致参照偏高）用"第一遍修改后的 alpha"重新判定——此时凸包区域
//     已被拉平为单线水平，环带参照自然正确。
//  3. 性能（针对大选区）：
//     - 快速筛选：每个候选像素只采样 8 方向 × 2 半径 × 4 尺度 ≈ 64 次读取，
//       用"采样最小值 < alpha - peakThresh"标记可疑（单线像素采样最小值≈自身水平
//       不误标；凸包角像素采样朝外方向能探到单线低值不漏报），绝大多数普通线条像素
//       在此被排除；
//     - 只有可疑像素进入完整分析：k4 环带（小，便宜）快速分级 + k112 环带（大，全采样）
//       精确判定；环带扫描直接遍历环形带像素（Chebyshev 带 [k, k+RING_WIDTH]：
//       整行 + 左右竖带），不做方阵过滤；
//     - 选区边缘羽化由 O(n×kernel) 的高斯卷积改为 3 次 box 级联（O(n) 滑窗）。
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
const PLATFORM_MAJORITY = 0.3;         // 环带直方图"主体平台"的最小占比（低于此视为渐变等值环）
const PLATFORM_MAJORITY_LARGE = 0.25;  // 大环带（k112）单线平台的最小占比（凸包边缘约 28%）
const PLATFORM_MAJORITY_BULK = 0.45;   // 大环带（k112）"远离 alpha 的强平台"占比阈值：
                                       // 凸包内像素的参照（单线 150）与 alpha 差较大（>25），
                                       // 但占比极高（≥50%）；渐变环即使虚高也难超 45%
                                       // （凸包内/线平坦区，其 k112 环带主体是单线/凸包大平台，
                                       // 隔行采样占比仍准确，可安全隔行提速）
const BRIGHT_DELTA = 25;               // 众数与 alpha 的接近度阈值：|alpha-众数| ≤ 该值
                                       // 视为"局部亮点"（交叉凸包边缘），需大环带确认；
                                       // 渐变像素（alpha 与最暗渐变环差 >25）被排除

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
  //    参照 = 环带直方图的"单线主体平台"（众数）。判定要点：
  //      - 单线主体在凸包像素的环带中是绝对主导（占比 25%~100%）→ 命中；
  //      - 软笔刷渐变是"等值环/台阶"（40/50/60 并列或单环占比虚高）→ 靠
  //        "峰值判据"（众数 ≥2×次大）与"接近度"（alpha-众数 ≤BRIGHT_DELTA
  //        或占比 ≥PLATFORM_MAJORITY_BULK）排除 → 渐变/单线边缘像素不被拉低
  //        （修复"多次使用后线条斑驳"）；
  //      - 孤立高值（凸包渐变中的个别 192/212）计数远小于主体 → 不会当选
  //        （修复 v2 ringMax 被孤立高值污染 → 粗线斜交叉菱形凸包角残留"三角形"、
  //        软笔刷交叉外围"残余高不透明区域"的问题）。
  //    两遍处理：第一遍用原始 alpha 处理能判定的像素（凸包主体、细交叉）；
  //    第二遍对"第一遍未解决"的像素（凸包角/深处的残余，第一遍环带朝凸包内侧
  //    方向被凸包值污染导致参照偏高）用"第一遍修改后的 alpha"重新判定——此时凸包
  //    区域已被拉平为单线水平，环带参照自然正确（等价"第二次点击"的机理，但一次完成）。
  //    k112 环带主体是单线/凸包大平台）→ 隔行采样×3 提速；其余像素 → 全采样
  //    （隔行会把渐变等值环占比虚高数倍，导致单线边缘被误拉低成"斑驳"）。
  const refMin = new Uint16Array(rn);
  refMin.fill(65535);
  const curA = new Uint8Array(aR); // 当前状态（第一遍修改后更新，供第二遍环带读取）
  const histBuf = new Uint16Array(256); // 复用的直方图
  {
    const smallK = 4;          // 小尺度环内半径
    const largeK = MAX_SCALE;  // 大尺度环内半径（112）

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
            const s2 = curA[rowBase + nx];
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
            const s2 = curA[rowBase + nx];
            if (s2 >= minAlpha) {
              cnt++;
              histBuf[s2]++;
              if (s2 > bandMax) bandMax = s2;
            }
          }
          for (let dx = inner; dx <= outer; dx += step) {
            const nx = curRx + dx;
            if (nx >= rw) continue;
            const s2 = curA[rowBase + nx];
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
    // 直方图众数与次大值
    const modeOfHist = () => {
      let mode = -1;
      let maxC = 0;
      let secondC = 0;
      for (let v = 0; v < 256; v++) {
        if (histBuf[v] > maxC) {
          secondC = maxC;
          maxC = histBuf[v];
          mode = v;
        } else if (histBuf[v] > secondC) {
          secondC = histBuf[v];
        }
      }
      return { mode, maxC, secondC };
    };

    // 判定单个像素：返回参照（<alpha-peakThresh）或 65535（不修改）
    const analyzePixel = (ri: number): number => {
      const a = curA[ri];
      // ---- 第一级：k4 环带（全采样，便宜）----
      const r4 = scanBand(smallK, 1);
      const m4 = modeOfHist();
      const ratio4 = r4.cnt > 0 ? m4.maxC / r4.cnt : 0;
      clearHist();
      if (r4.cnt > 0 && ratio4 >= PLATFORM_MAJORITY && m4.mode < a - peakThresh) {
        return m4.mode; // 细交叉/凸包边缘：小环带已出凸包，命中单线主体平台
      }
      // 需要大环带确认：凸包内（小环带被凸包主导）或"局部亮点"
      // （众数不高于 alpha 且接近 alpha，如交叉凸包边缘/交叉渐变边缘）。
      // 排除：渐变像素（众数 > alpha 说明环带主体是更亮的线中心；
      // 或众数远低于 alpha 说明主体是最暗的渐变环）——它们 alpha 本就在线水平之下。
      const needLarge = r4.cnt > 0 && m4.mode <= a
        && (ratio4 >= PLATFORM_MAJORITY || (a - m4.mode) <= BRIGHT_DELTA);
      if (!needLarge) return 65535;
      // ---- 第二级：k112 环带（全采样）----
      // 必须全采样：隔行/步长采样会把"渐变等值环"的占比严重虚高
      // （如单线边缘像素的 40 渐变环：全采样 23%，步长 3 采样 74%），
      // 导致单线边缘像素被误拉低成"斑驳"。
      const rL = scanBand(largeK, 1);
      const mL = modeOfHist();
      const ratioL = rL.cnt > 0 ? mL.maxC / rL.cnt : 0;
      clearHist();
      const nearAlpha = mL.mode >= 0 && (a - mL.mode) <= BRIGHT_DELTA;
      if (rL.cnt > 0 && ratioL >= PLATFORM_MAJORITY_LARGE
        && mL.maxC >= mL.secondC * 2
        && mL.mode < a - peakThresh
        && (ratioL >= PLATFORM_MAJORITY_BULK || nearAlpha)) {
        return mL.mode;
      }
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
    for (let ry = 0; ry < rh; ry++) {
      const rowBaseR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowBaseR + rx;
        if (suspicious[ri] === 0 || refMin[ri] < 65535) continue;
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

      const peak = a - ref;
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
