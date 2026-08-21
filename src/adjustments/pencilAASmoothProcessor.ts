// pencilAASmoothProcessor.ts —— 铅笔线条去锯齿（覆盖率重建，模拟圆头笔笔触）
//
// 解决的问题：
//   PS 铅笔工具画出的是"像素级硬边阶梯"（每个像素要么全透明要么全不透明）。
//   直接用高斯模糊虽然能去掉锯齿，但边缘带的 alpha 仍保留"每跨一个像素台阶
//   起伏一次"的周期性节律 —— 在曲线上表现为"一抖一抖"，没有圆头笔的平滑感。
//   基于距离场（SDF）的重建也不行：像素网格上到边界的距离天然量化（每圈差 1px），
//   同一圈的像素 alpha 相同 → 圈内仍是"软二值阶梯"。
//
// 本算法（基于真实采样数据拟合：半径 7px 铅笔 vs 普通圆头笔对照采样，两组一致）：
//   1. 铅笔线二值化 → mask。
//   2. 对 mask 做 box 平滑（半径 blurR，柔化宽度 0.5~2px 映射到 blurR 1~3，
//      默认 2px → blurR=3，即拟合值）成连续渐变场，
//      再在像素内 4×4 子采样求覆盖率 cov（亚像素连续 → 圈内 alpha 连续渐变）。
//      box 模糊保持重心 → cov 的 0.5 等高线精确落在 mask 边界 → 宽度守恒、幂等。
//   3. alpha = F(cov)，F 为真实采样拟合的分段线性表（r=3 场）：
//      - mask 内第一圈 cov≈0.55~0.7 → alpha≈197~253（微削，匹配真实 193~250）
//      - mask 外第一圈 cov≈0.3~0.48 → alpha≈27~147（补像素，匹配真实）
//   4. 长台阶直线专项（近水平/垂直的略倾斜直线，如 1:5~1:20）：
//      box 模糊覆盖率在长台阶段内恒定 → 台阶跳变处 alpha 突变 → 周期性阶梯感残留。
//      对"平台段 ≥5px 的边界带"，改用"相邻列/行线性插值边界"的覆盖率（亚像素连续），
//      跳变处连续渐变（无突变）；台阶段 alpha 保持（匹配真实圆头笔 198~230）。
//      曲线/陡斜线（平台段短）仍走 blur 覆盖率，不受影响。
//   5. 幂等锚定：mask 内输出 ≥128、mask 外 ≤127 → 输出≥128 的集合与 mask 完全一致，
//      二次点击 cov 场不变 → 严格幂等（连点不粗不细）。
//      （注意：真实圆头笔 mask 比铅笔 mask 大约 0.5px，严格幂等要求边界处 alpha=128，
//       故圆头笔"外扩圈"的高 alpha（128~197）会收敛到 127 —— 这是幂等的代价，视觉无碍。）
//   6. RGB：直通色保持笔色/背景色；原透明像素改写为最近线内像素的直通色（消黑边）。
//
// 特性：
//   - alpha 与 RGB 一起处理（直通色恒定，无灰边/黑边/白边）
//   - 支持周围 alpha>0 的内容（色块等）：mask 外像素 aRecon ≥ bgA，背景不被侵蚀
//   - 粗细线分流：细线（≤3px）域内部保持实心，只补外部过渡（防吃穿）
//   - 只修改选区内像素；选区羽化混合由调用方完成
//   - 仅适用于非背景的普通像素图层

interface PencilAAParams {
  softWidth?: number;       // 柔化宽度（px），0.5~2，默认 2（→blurR 1~3）。控制过渡带软硬
  strength?: number;        // 混合强度 0~1，默认 1（UI 固定 100%：<100% 会破坏幂等）
  alphaThreshold?: number;  // 线条二值化阈值 64~192，默认 128
  thinLineProtect?: boolean; // 细线保护开关，默认 true
  thinLineSmooth?: number;  // 细线平滑度 0~1，默认 0.6
}

const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));
const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));

const INF = 0x3fffffff; // 距离平方的"无穷大"（Int32 可容纳）

/*
  欧氏距离变换（精确 8SSEDT，两遍扫描）：
  输入 seeds（1 = 种子像素），输出 dist2（到最近种子的欧氏距离平方，Int32Array）。
  种子像素 dist2=0；非种子经两遍扫描收敛到最近种子的真实欧氏距离平方。
  实现：每个像素维护"最近种子坐标"，更新时用种子坐标重算欧氏距离平方
  （不能用距离平方的曼哈顿累加——平方不满足三角不等式，会算错距离）。
  同时把 feature（种子携带的值，如 alpha 或打包的直通颜色）传播到最近种子所属像素。
  feature 可为 Uint8Array（单通道）或 Int32Array（打包值），输入输出类型一致。
*/
function edt8SSEDT(
  seeds: Uint8Array,
  width: number,
  height: number,
  feature: Uint8Array | Int32Array,
  outDist2: Int32Array,
  outFeature: Uint8Array | Int32Array
): void {
  const n = width * height;
  const seedX = new Int32Array(n);
  const seedY = new Int32Array(n);
  outDist2.fill(INF);
  for (let i = 0; i < n; i++) {
    if (seeds[i] !== 0) {
      outDist2[i] = 0;
      seedX[i] = i % width;
      seedY[i] = (i - seedX[i]) / width;
      outFeature[i] = feature[i];
    }
  }

  // 尝试用邻居 j 的种子坐标更新当前像素 i（像素坐标 x,y）
  const tryUpdate = (i: number, j: number, x: number, y: number) => {
    const dj = outDist2[j];
    if (dj >= INF) return;
    const dx = x - seedX[j];
    const dy = y - seedY[j];
    const d2 = dx * dx + dy * dy;
    if (d2 < outDist2[i]) {
      outDist2[i] = d2;
      seedX[i] = seedX[j];
      seedY[i] = seedY[j];
      outFeature[i] = outFeature[j];
    }
  };

  // 正向扫描：检查 左 / 左上 / 上 / 右上
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (outDist2[i] === 0) continue;
      if (x > 0) tryUpdate(i, i - 1, x, y);
      if (x > 0 && y > 0) tryUpdate(i, i - width - 1, x, y);
      if (y > 0) tryUpdate(i, i - width, x, y);
      if (x + 1 < width && y > 0) tryUpdate(i, i - width + 1, x, y);
    }
  }

  // 反向扫描：检查 右 / 下 / 左下 / 右下
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const i = row + x;
      if (x + 1 < width) tryUpdate(i, i + 1, x, y);
      if (y + 1 < height) tryUpdate(i, i + width, x, y);
      if (x > 0 && y + 1 < height) tryUpdate(i, i + width - 1, x, y);
      if (x + 1 < width && y + 1 < height) tryUpdate(i, i + width + 1, x, y);
    }
  }
}

/*
  连通域标记（4 连通）：
  - 统计每个域内"到最近线外像素距离平方"的最大值（maxD2）
  - 统计每个域内原始 alpha 的最大值（domainMax = 线内主体水平 aBody 的来源）
  返回 label（-1 = 非 mask 像素）、thinFlag（1 = 细线域：maxD ≤ 1.5px，即线宽 ≤3px）、
  domainMax（按域索引的线内 alpha 最大值）。
*/
function labelComponents(
  mask: Uint8Array,
  distOut2: Int32Array,
  srcAlpha: Uint8Array,
  width: number,
  height: number
): { label: Int32Array; thinFlag: Uint8Array; domainMax: Float32Array } {
  const n = width * height;
  const label = new Int32Array(n);
  label.fill(-1);
  const thinFlag = new Uint8Array(n);

  const q = new Int32Array(n);
  const THIN_MAXD2 = 2.25; // 1.5 * 1.5（线宽 ≤3px 判为细线域）

  const domainMaxArr: number[] = [];
  let nextLabel = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i] === 0 || label[i] >= 0) continue;

    // BFS 收集当前域
    let head = 0;
    let tail = 0;
    q[tail++] = i;
    label[i] = nextLabel;
    let maxD2 = 0;
    let maxA = 0;

    while (head < tail) {
      const cur = q[head++];
      const d2 = distOut2[cur];
      if (d2 > maxD2) maxD2 = d2;
      const a = srcAlpha[cur];
      if (a > maxA) maxA = a;

      const x = cur % width;
      const y = (cur - x) / width;
      // 4 连通
      if (x > 0) {
        const j = cur - 1;
        if (mask[j] !== 0 && label[j] < 0) { label[j] = nextLabel; q[tail++] = j; }
      }
      if (x + 1 < width) {
        const j = cur + 1;
        if (mask[j] !== 0 && label[j] < 0) { label[j] = nextLabel; q[tail++] = j; }
      }
      if (y > 0) {
        const j = cur - width;
        if (mask[j] !== 0 && label[j] < 0) { label[j] = nextLabel; q[tail++] = j; }
      }
      if (y + 1 < height) {
        const j = cur + width;
        if (mask[j] !== 0 && label[j] < 0) { label[j] = nextLabel; q[tail++] = j; }
      }
    }

    domainMaxArr.push(maxA);
    if (maxD2 <= THIN_MAXD2) {
      for (let k = 0; k < tail; k++) thinFlag[q[k]] = 1;
    }
    nextLabel++;
  }

  return { label, thinFlag, domainMax: new Float32Array(domainMaxArr) };
}

/*
  对二值 mask 做半径 r 的盒式模糊（水平+垂直，O(n·r)）。
  用于把 mask 平滑成渐变场（0~255，仍以像素中心为格点）。
  注意：coverage 用"子采样 >127.5 的比例"，0.5 等高线位置 ≈ 原 mask 边界
  （box 模糊保持重心），因此线条宽度守恒、内部保持实心。
*/
function boxBlurMask(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const n = width * height;
  const hsum = new Uint32Array(n);
  const out = new Uint8Array(n);
  if (r <= 0) {
    out.set(mask);
    return out;
  }

  // 水平：窗口 [max(0,x-r), min(width-1,x+r)] 内求和
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const xA = x - r < 0 ? 0 : x - r;
      const xB = x + r >= width ? width - 1 : x + r;
      let s = 0;
      for (let xx = xA; xx <= xB; xx++) s += mask[row + xx];
      hsum[row + x] = s;
    }
  }

  // 垂直：s = 2D 窗口内 mask 总数（0~(2r+1)²），除以窗口面积得 0~255 渐变场
  const winArea = (2 * r + 1) * (2 * r + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const yA = y - r < 0 ? 0 : y - r;
      const yB = y + r >= height ? height - 1 : y + r;
      let s = 0;
      for (let yy = yA; yy <= yB; yy++) s += hsum[yy * width + x];
      out[y * width + x] = clampInt(Math.round((s * 255) / winArea), 0, 255);
    }
  }
  return out;
}

/*
  计算像素 (i,j) 被线条形状覆盖的比例（coverage，0~1）：
  在像素区域内 4×4 子采样"渐变场（box 模糊后的 mask，0~255）"的双线性插值并取平均。
  渐变场连续 → coverage 连续 → 同一圈像素 coverage 互不相同 → 圈内 alpha 连续渐变（无"软圈"）。
*/
function coverage4x4(blur: Uint8Array, width: number, height: number, i: number, j: number): number {
  let sum = 0;
  for (let sy = 0; sy < 4; sy++) {
    const y = j - 0.5 + (sy + 0.5) / 4;
    const jj = y < 0 ? 0 : (y > height - 1 ? height - 1 : (y | 0));
    let fy = y - jj;
    if (fy < 0) fy = 0;
    else if (fy > 1) fy = 1;
    const jp = jj + 1 < height ? jj + 1 : jj;
    const row0 = jj * width;
    const row1 = jp * width;
    for (let sx = 0; sx < 4; sx++) {
      const x = i - 0.5 + (sx + 0.5) / 4;
      const ii = x < 0 ? 0 : (x > width - 1 ? width - 1 : (x | 0));
      let fx = x - ii;
      if (fx < 0) fx = 0;
      else if (fx > 1) fx = 1;
      const ip = ii + 1 < width ? ii + 1 : ii;
      const m00 = blur[row0 + ii];
      const m10 = blur[row0 + ip];
      const m01 = blur[row1 + ii];
      const m11 = blur[row1 + ip];
      sum += (m00 * (1 - fx) + m10 * fx) * (1 - fy) + (m01 * (1 - fx) + m11 * fx) * fy;
    }
  }
  return sum / (16 * 255);
}

/*
  真实采样拟合的"coverage → alpha"分段线性表
  （第一次采样：半径7px 铅笔 vs 普通圆头笔，D 型曲线 + 高曲率曲线，两组一致）。
  特征：box_blur(mask, r=3) 后的 4×4 coverage。
  box 模糊保持重心 → cov 的 0.5 等高线 = mask 边界 → 锚定 F(0.5)≈128 实现宽度守恒 + 严格幂等。
*/
const F_TABLE_X = [0.075, 0.125, 0.175, 0.225, 0.275, 0.325, 0.375, 0.425, 0.475, 0.525, 0.575, 0.625, 0.675, 0.725, 0.775, 0.825, 0.875, 0.925];
const F_TABLE_Y = [0.0, 0.0, 0.5, 3.2, 10.4, 27.4, 57.5, 101.2, 147.3, 197.7, 228.9, 244.7, 252.9, 254.7, 255.0, 255.0, 255.0, 255.0];

function lookUpF(cov: number): number {
  const xs = F_TABLE_X;
  const ys = F_TABLE_Y;
  if (cov <= xs[0]) return ys[0];
  if (cov >= xs[xs.length - 1]) return ys[ys.length - 1];
  // 线性扫描（表很短，足够快）
  for (let k = 1; k < xs.length; k++) {
    if (cov <= xs[k]) {
      const t = (cov - xs[k - 1]) / (xs[k] - xs[k - 1]);
      return ys[k - 1] + (ys[k] - ys[k - 1]) * t;
    }
  }
  return ys[ys.length - 1];
}

/*
  —— 近水平/近垂直"长台阶"直线专项 ——
  接近水平/垂直的略倾斜直线，二值台阶很长（如 1:10 → 每 10px 才跳变一次）。
  box 模糊覆盖率在长台阶段内恒定（窗口内 mask 模式相同）→ 台阶跳变处 alpha 突变，
  残留周期性阶梯感。专项修复：把"每列/每行"的边界位置（top/bot/left/right）在
  相邻列/行之间线性插值，重建亚像素连续边界，再算覆盖率 ——
  台阶段内 alpha 保持（与圆头笔一致），台阶跳变处连续渐变（无突变）。
  只对"平台段 ≥5px"的长台阶边界带启用，曲线/陡斜线仍走 blur 覆盖率（不劣化）。
*/

/*
  长台阶插值覆盖率 → alpha（真实数据拟合）：
  插值 coverage 的 0.5 等高线在 mask 内第一圈（像素半覆盖），真实圆头笔在该处
  alpha≈211~224（比 blur 场的 F 表高，因为插值 cov 与 blur cov 的 0.5 语义不同）。
  拟合：cov 0.425→198、0.5→211、0.6→228、1.0→255；低端封顶 198（跳变处不降，
  保证沿线条方向无突变）。
*/
function gInterp(cov: number): number {
  return Math.min(255, 198 + 172 * Math.max(0, cov - 0.425));
}

// 提取每列 top/bot、每行 left/right 边界位置（-1 = 该列/行无 mask）
function extractBorders(
  mask: Uint8Array,
  rw: number,
  rh: number
): { top: Int32Array; bot: Int32Array; left: Int32Array; right: Int32Array } {
  const top = new Int32Array(rw); top.fill(-1);
  const bot = new Int32Array(rw); bot.fill(-1);
  const left = new Int32Array(rh); left.fill(-1);
  const right = new Int32Array(rh); right.fill(-1);
  for (let x = 0; x < rw; x++) {
    for (let y = 0; y < rh; y++) {
      if (mask[y * rw + x] !== 1) continue;
      if (top[x] < 0) top[x] = y;
      bot[x] = y;
    }
  }
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (mask[y * rw + x] !== 1) continue;
      if (left[y] < 0) left[y] = x;
      right[y] = x;
    }
  }
  return { top, bot, left, right };
}

// 每个位置的"连续平台段长度"（seq=-1 处为 0）
function plateauLen(seq: Int32Array, n: number): Int32Array {
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (seq[i] < 0) continue;
    let j = i;
    while (j > 0 && seq[j - 1] === seq[i]) j--;
    let k = i;
    while (k < n - 1 && seq[k + 1] === seq[i]) k++;
    out[i] = k - j + 1;
  }
  return out;
}

// 列插值覆盖率：边界 top/bot 在相邻列线性插值（亚像素连续），4×4 子采样判断
function covColInterp(
  mask: Uint8Array,
  top: Int32Array,
  bot: Int32Array,
  rw: number,
  rh: number,
  i: number,
  j: number
): number {
  if (top[i] < 0) return 0;
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    const yy = j - 0.5 + (sy + 0.5) / 4;
    for (let sx = 0; sx < 4; sx++) {
      const xx = i - 0.5 + (sx + 0.5) / 4;
      const x0 = xx < 0 ? 0 : (xx > rw - 1 ? rw - 1 : (xx | 0));
      const x1 = x0 + 1 < rw ? x0 + 1 : x0;
      const f = xx - x0;
      const t0 = top[x0], t1 = top[x1], b0 = bot[x0], b1 = bot[x1];
      if (t0 < 0 || t1 < 0) continue;
      const tt = t0 * (1 - f) + t1 * f;
      const bb = b0 * (1 - f) + b1 * f;
      if (tt <= yy && yy <= bb) hits++;
    }
  }
  return hits / 16;
}

// 行插值覆盖率（对称：近垂直线）
function covRowInterp(
  mask: Uint8Array,
  left: Int32Array,
  right: Int32Array,
  rw: number,
  rh: number,
  i: number,
  j: number
): number {
  if (left[j] < 0) return 0;
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    const yy = j - 0.5 + (sy + 0.5) / 4;
    for (let sx = 0; sx < 4; sx++) {
      const xx = i - 0.5 + (sx + 0.5) / 4;
      const y0 = yy < 0 ? 0 : (yy > rh - 1 ? rh - 1 : (yy | 0));
      const y1 = y0 + 1 < rh ? y0 + 1 : y0;
      const f = yy - y0;
      const l0 = left[y0], l1 = left[y1], r0 = right[y0], r1 = right[y1];
      if (l0 < 0 || l1 < 0) continue;
      const ll = l0 * (1 - f) + l1 * f;
      const rr = r0 * (1 - f) + r1 * f;
      if (ll <= xx && xx <= rr) hits++;
    }
  }
  return hits / 16;
}

/*
  主入口：对完整文档尺寸的 RGBA（straight alpha）像素做铅笔去锯齿。
  - pixelData：完整文档 RGBA（straight）
  - selectionMask：完整文档 0~255（>0 表示可修改；羽化混合由调用方完成）
  - 返回同尺寸 RGBA ArrayBuffer
*/
export async function processPencilAASmooth(
  pixelData: ArrayBuffer,
  selectionMaskBuffer: ArrayBuffer,
  dimensions: { width: number; height: number },
  _params?: PencilAAParams,
  isBackgroundLayer: boolean = false
): Promise<ArrayBuffer> {
  const width = Math.max(1, dimensions.width | 0);
  const height = Math.max(1, dimensions.height | 0);
  const pixelCount = width * height;

  const pixels = new Uint8Array(pixelData);
  const selectionMaskRaw = new Uint8Array(selectionMaskBuffer);
  const out = new Uint8Array(pixels.length);
  out.set(pixels);

  // 背景图层 alpha 恒 255，距离场无意义，直接返回（由调用方拦截提示）
  if (isBackgroundLayer) return out.buffer;
  if (pixels.length < pixelCount * 4) return out.buffer;

  const params = (_params || {}) as PencilAAParams;
  const softWidth = Math.max(0.5, Math.min(2, typeof params.softWidth === 'number' ? params.softWidth : 2));
  const strength = clamp01(typeof params.strength === 'number' ? params.strength : 1);
  const alphaThreshold = clampInt(Math.round(params.alphaThreshold ?? 128), 64, 192);
  const thinLineProtect = params.thinLineProtect !== false;
  const thinLineSmooth = clamp01(typeof params.thinLineSmooth === 'number' ? params.thinLineSmooth : 0.6);

  // 选区有效像素（selectionMask > 0）包围盒
  let minX = width, minY = height, maxX = -1, maxY = -1, selCount = 0;
  const selValid = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const s = selectionMaskRaw[i] || 0;
    if (s <= 0) continue;
    selValid[i] = 1;
    selCount++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (selCount === 0) return out.buffer;

  // alpha 与线条 mask（全文档计算：alpha≥阈值视为线条，供距离场参照，不受选区限制）
  const alpha = new Uint8Array(pixelCount);
  const mask = new Uint8Array(pixelCount);
  let lineCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    const a = pixels[i * 4 + 3] || 0;
    alpha[i] = a;
    if (a >= alphaThreshold) { mask[i] = 1; lineCount++; }
  }
  if (lineCount === 0) return out.buffer;

  // 只在外扩 bbox 内做重建（bbox 外像素不动）
  const pad = 8; // blurR(max 4) + 过渡带 + 余量
  const x0 = minX - pad < 0 ? 0 : minX - pad;
  const y0 = minY - pad < 0 ? 0 : minY - pad;
  const x1 = maxX + pad >= width ? width - 1 : maxX + pad;
  const y1 = maxY + pad >= height ? height - 1 : maxY + pad;
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  const rn = rw * rh;

  // 区域化数组
  const rMask = new Uint8Array(rn);
  const rSel = new Uint8Array(rn);
  const rAlpha = new Uint8Array(rn);
  for (let ry = 0; ry < rh; ry++) {
    const docY = y0 + ry;
    const rowDoc = docY * width;
    const rowR = ry * rw;
    for (let rx = 0; rx < rw; rx++) {
      const di = rowDoc + (x0 + rx);
      const ri = rowR + rx;
      rMask[ri] = mask[di];
      rSel[ri] = selValid[di];
      rAlpha[ri] = alpha[di];
    }
  }

  // ---- EDT_in：种子 = 线内像素（mask=1）----
  // 得到线外像素"到最近线内像素的距离"（distIn2），
  // 同时传播"线内像素的打包直通颜色"（供透明背景上的过渡带像素取线条色，避免黑边）。
  const seedIn = new Uint8Array(rn);
  for (let i = 0; i < rn; i++) {
    if (rMask[i] === 1) seedIn[i] = 1;
  }
  const distIn2 = new Int32Array(rn);
  const packedInColor = new Int32Array(rn);
  {
    const tmpPacked = new Int32Array(rn);
    for (let ry = 0; ry < rh; ry++) {
      const docY = y0 + ry;
      const rowDoc = docY * width;
      const rowR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowR + rx;
        if (rMask[ri] === 0) continue;
        const p = (rowDoc + (x0 + rx)) * 4;
        tmpPacked[ri] = (pixels[p] << 16) | (pixels[p + 1] << 8) | pixels[p + 2];
      }
    }
    edt8SSEDT(seedIn, rw, rh, tmpPacked, distIn2, packedInColor);
  }

  // ---- EDT_out_dist：种子 = 全部线外像素（mask=0）----
  // 得到线内像素"到最近线外像素的距离"（≈ 到 mask 边界的距离）。
  const seedOutAll = new Uint8Array(rn);
  for (let i = 0; i < rn; i++) {
    if (rMask[i] === 0) seedOutAll[i] = 1;
  }
  const distOut2 = new Int32Array(rn);
  {
    const tmpFeat = new Uint8Array(rn);
    edt8SSEDT(seedOutAll, rw, rh, rAlpha, distOut2, tmpFeat);
  }

  // ---- EDT_out_bg：种子 = 线外像素且"距线 ≥1.73px"（distIn2 ≥ 3）----
  // 稳定背景参照（透明 0 / 色块 / 其他线表面），保证背景水平不随多次处理漂移。
  const seedOutBg = new Uint8Array(rn);
  for (let i = 0; i < rn; i++) {
    if (rMask[i] === 0 && distIn2[i] >= 3) seedOutBg[i] = 1;
  }
  const distBg2 = new Int32Array(rn);
  const bgAlpha = new Uint8Array(rn);
  edt8SSEDT(seedOutBg, rw, rh, rAlpha, distBg2, bgAlpha);

  // ---- 连通域：细线标记 + 线内主体水平（aBody = 域内原始 alpha 最大值）----
  let thinFlag: Uint8Array | null = null;
  let labelArr: Int32Array | null = null;
  let domainMax: Float32Array | null = null;
  if (thinLineProtect) {
    const comp = labelComponents(rMask, distOut2, rAlpha, rw, rh);
    thinFlag = comp.thinFlag;
    labelArr = comp.label;
    domainMax = comp.domainMax;
  }

  // ---- coverage 场：对 mask 做 box 平滑（blurR 由柔化宽度映射，默认 2px → blurR=3）----
  // 映射 softWidth 0.5/1/1.5/2 → blurR 1/1/2/3（默认 2px 对应拟合值 blurR=3，效果与旧 2.7px 一致）。
  // box 模糊保持重心 → cov 的 0.5 等高线精确落在 mask 边界：
  //   输出≥128 ⇔ cov≥0.5 ⇔ mask（配合下方锚定）→ 二次处理 cov 场不变 → 严格幂等。
  const blurR = clampInt(Math.round(softWidth * 1.4), 1, 4);
  const blurredMask = boxBlurMask(rMask, rw, rh, blurR);
  const maxD2Screen = (blurR + 2.5) * (blurR + 2.5); // 粗筛：只处理边界带内的像素

  // ---- 长台阶直线专项：每列/每行边界 + 平台长度（供插值覆盖率分支使用）----
  const borders = extractBorders(rMask, rw, rh);
  const platTop = plateauLen(borders.top, rw);
  const platBot = plateauLen(borders.bot, rw);
  const platLeft = plateauLen(borders.left, rh);
  const platRight = plateauLen(borders.right, rh);
  const MIN_PLAT = 5; // 平台段 ≥5px 判为长台阶（约 1:5 及更缓的斜线）

  // ---- 覆盖率重建（查表 + 长台阶插值分支）----
  for (let ry = 0; ry < rh; ry++) {
    const rowR = ry * rw;
    const docY = y0 + ry;
    for (let rx = 0; rx < rw; rx++) {
      const ri = rowR + rx;
      if (rSel[ri] === 0) continue;

      const inMask = rMask[ri] === 1;
      if (inMask && thinFlag && thinFlag[ri] === 1) continue; // 细线域内部保持实心

      // 稳定背景参照圈（距线 ≥1.73px）永不改写：保证背景水平稳定、幂等
      if (!inMask && distIn2[ri] >= 3) continue;

      // 色块保护：mask 外的有色背景（alpha>127 的色块）不参与过渡（非线条边缘）
      if (!inMask && bgAlpha[ri] > 127) continue;

      // 粗筛：远离边界不处理
      const d2 = inMask ? distOut2[ri] : distIn2[ri];
      if (d2 > maxD2Screen) continue;

      let aRecon: number;
      let skipCov = false;

      // 长台阶插值分支（mask 内边界带，平台段 ≥MIN_PLAT 的列/行）：
      //   台阶段内 alpha 恒定（与圆头笔一致）、台阶跳变处连续渐变（消除阶梯感）。
      if (inMask) {
        const hPlat = platTop[rx] > platBot[rx] ? platTop[rx] : platBot[rx];
        const nearH =
          (borders.top[rx] >= 0 && (ry === borders.top[rx] || ry === borders.top[rx] + 1)) ||
          (borders.bot[rx] >= 0 && (ry === borders.bot[rx] || ry === borders.bot[rx] - 1));
        const vPlat = platLeft[ry] > platRight[ry] ? platLeft[ry] : platRight[ry];
        const nearV =
          (borders.left[ry] >= 0 && (rx === borders.left[ry] || rx === borders.left[ry] + 1)) ||
          (borders.right[ry] >= 0 && (rx === borders.right[ry] || rx === borders.right[ry] - 1));
        if (hPlat >= MIN_PLAT && nearH) {
          aRecon = gInterp(covColInterp(rMask, borders.top, borders.bot, rw, rh, rx, ry));
          skipCov = true;
        } else if (vPlat >= MIN_PLAT && nearV) {
          aRecon = gInterp(covRowInterp(rMask, borders.left, borders.right, rw, rh, rx, ry));
          skipCov = true;
        }
      }

      if (!skipCov) {
        const cov = coverage4x4(blurredMask, rw, rh, rx, ry);
        // 完全覆盖（主体）或完全未覆盖（远处背景）→ 不改（F 表两端本身 ≈255/0）
        if (cov <= 0.22) continue;
        if (cov >= 0.97) continue;
        aRecon = lookUpF(cov);
      }

      // 幂等锚定：mask 内 ≥128（不内缩）、mask 外 ≤127（不外扩）
      if (inMask) aRecon = Math.max(aRecon, 128);
      else aRecon = Math.min(aRecon, 127);

      // 色块衔接：过渡目标不低于稳定背景水平（色块不被侵蚀）
      const bgA = bgAlpha[ri];
      if (bgA > 0 && aRecon < bgA) aRecon = bgA;

      // 半透明线：边缘不高于线内主体水平（防"湿边"）
      if (inMask && domainMax && labelArr) {
        const aBody = domainMax[labelArr[ri]];
        if (aBody < 255 && aRecon > aBody) aRecon = aBody;
      }

      const docX = x0 + rx;
      const di = docY * width + docX;
      const p = di * 4;

      const a0 = pixels[p + 3] || 0;
      const aTarget = Math.round(a0 + (aRecon - a0) * strength);
      const aF = clampInt(aTarget, 0, 255);
      if (aF === a0) continue;

      // 直通 RGB：PS 的 straight alpha 图层中，半透明边缘像素的直通色应保持
      // "笔色/背景色"恒定（合成时由 alpha 决定明暗），而不是反预乘（会过曝成白边）。
      //  - 线条内：保持原直通色（= 线条色）
      //  - 线外有色像素（色块）：保持原直通色（= 色块色）
      //  - 线外透明像素（a0=0）：取"最近线内像素的直通色"（原为垃圾值/黑，改为线条色）
      let sr: number, sg: number, sb: number;
      if (inMask || a0 > 0) {
        sr = pixels[p]; sg = pixels[p + 1]; sb = pixels[p + 2];
      } else {
        const packed = packedInColor[ri] | 0;
        sr = (packed >> 16) & 255;
        sg = (packed >> 8) & 255;
        sb = packed & 255;
      }

      if (aF <= 0) {
        out[p] = 0; out[p + 1] = 0; out[p + 2] = 0; out[p + 3] = 0;
        continue;
      }
      out[p] = sr; out[p + 1] = sg; out[p + 2] = sb; out[p + 3] = aF;
    }
  }

  // 细线兜底：对细线域像素做 straight 空间的 3x3 高斯轻量平滑（alpha 只降不抬），混合 thinLineSmooth
  if (thinFlag && thinLineSmooth > 0.01) {
    const straightR = new Float32Array(rn);
    const straightG = new Float32Array(rn);
    const straightB = new Float32Array(rn);
    const aCur = new Float32Array(rn);

    for (let ry = 0; ry < rh; ry++) {
      const docY = y0 + ry;
      const rowR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowR + rx;
        if (rSel[ri] === 0) continue;
        const di = (docY * width + (x0 + rx)) * 4;
        aCur[ri] = out[di + 3] || 0;
        straightR[ri] = out[di];
        straightG[ri] = out[di + 1];
        straightB[ri] = out[di + 2];
      }
    }

    const mix = thinLineSmooth;
    for (let ry = 0; ry < rh; ry++) {
      const docY = y0 + ry;
      const rowR = ry * rw;
      for (let rx = 0; rx < rw; rx++) {
        const ri = rowR + rx;
        if (rSel[ri] === 0) continue;
        if (thinFlag[ri] !== 1) continue;

        let sA = 0, sR = 0, sG = 0, sB = 0, cnt = 0;
        const yA = ry > 0 ? ry - 1 : ry;
        const yB = ry + 1 < rh ? ry + 1 : ry;
        const xA = rx > 0 ? rx - 1 : rx;
        const xB = rx + 1 < rw ? rx + 1 : rx;
        for (let yy = yA; yy <= yB; yy++) {
          const row2 = yy * rw;
          for (let xx = xA; xx <= xB; xx++) {
            const rj = row2 + xx;
            if (rSel[rj] === 0) continue;
            if (thinFlag[rj] !== 1) continue; // 只统计细线域像素，外部描边圈不参与（保护 1px 线不被拉淡）
            if (aCur[rj] <= 0) continue;
            sA += aCur[rj]; sR += straightR[rj]; sG += straightG[rj]; sB += straightB[rj]; cnt++;
          }
        }
        if (cnt <= 0) continue;

        const avgA = sA / cnt;
        const avgR = sR / cnt;
        const avgG = sG / cnt;
        const avgB = sB / cnt;

        const di = (docY * width + (x0 + rx)) * 4;
        const a0 = aCur[ri];
        // 只降不抬：细线域的补像素过渡不被高斯"回填"回 255，
        // 只有窗口平均低于自身时轻微压低，让过渡更贴近背景。
        const aF = Math.round(a0 + (avgA - a0) * mix);
        if (aF >= a0) continue;
        if (aF <= 0) {
          out[di] = 0; out[di + 1] = 0; out[di + 2] = 0; out[di + 3] = 0;
          continue;
        }
        out[di] = clampInt(Math.round(straightR[ri] + (avgR - straightR[ri]) * mix), 0, 255);
        out[di + 1] = clampInt(Math.round(straightG[ri] + (avgG - straightG[ri]) * mix), 0, 255);
        out[di + 2] = clampInt(Math.round(straightB[ri] + (avgB - straightB[ri]) * mix), 0, 255);
        out[di + 3] = clampInt(aF, 0, 255);
      }
    }
  }

  return out.buffer;
}

export const defaultPencilAAParams: PencilAAParams = {
  softWidth: 2, // 默认柔化宽度（0.5~2px 滑块上限，2px → blurR=3 对应拟合值，效果与 2.7 一致）
  strength: 1, // 固定 100%：混合依赖当前像素值会破坏幂等（多次点击边缘逐次变实变粗）
  alphaThreshold: 128, // 固定默认：线条二值化阈值
  thinLineProtect: true, // 固定默认：细线保护
  thinLineSmooth: 0.6 // 固定默认：细线轻量平滑
};
