// aliasSmoothProcessor.ts —— 轮廓消除锯齿（覆盖率重建）
//
// 解决的问题：
//   色块的轮廓落在像素网格上必然出现"阶梯"（铅笔硬边、硬笔刷、套索/魔棒填色都是如此）。
//   直接高斯模糊虽然能去掉锯齿，但边缘带的 alpha 仍保留"每跨一个像素台阶起伏一次"的
//   周期性节律 —— 在曲线上表现为"一抖一抖"，没有圆头笔的平滑感。
//   基于距离场（SDF）的重建也不行：像素网格上到边界的距离天然量化（每圈差 1px），
//   同一圈的像素 alpha 相同 → 圈内仍是"软二值阶梯"。
//
// 本算法（基于真实采样数据拟合：半径 7px 铅笔 vs 普通圆头笔对照采样，两组一致）：
//   1. 按选区内的"本体不透明度"自动取阈值，把轮廓二值化成 mask。
//   2. 对 mask 做 box 平滑（半径 blurR，柔化宽度 0.5~2px 映射到 blurR 1~4，
//      默认 2px → blurR=3，即拟合值）成连续渐变场，
//      再在像素内 4×4 子采样求覆盖率 cov（亚像素连续 → 圈内 alpha 连续渐变）。
//      box 模糊保持重心 → cov 的 0.5 等高线精确落在 mask 边界 → 宽度守恒、幂等。
//   3. alpha = 本体不透明度 × profile(cov)，profile 为真实采样拟合的分段线性曲线
//      （按不透明笔触标定，0.5 等高线处 ≈0.676，即边界像素约为本体不透明度的 2/3）。
//   4. 长台阶直线专项（近水平/垂直的略倾斜直线，如 1:5~1:20）：
//      box 模糊覆盖率在长台阶段内恒定 → 台阶跳变处 alpha 突变 → 周期性阶梯感残留。
//      对"平台段 ≥5px 的边界带"，改用"相邻列/行线性插值边界"的覆盖率（亚像素连续），
//      跳变处连续渐变（无突变）；台阶段 alpha 保持（匹配真实圆头笔 198~230）。
//      曲线/陡斜线（平台段短）仍走 blur 覆盖率，不受影响。
//   5. 幂等锚定：mask 内输出 ≥阈值、mask 外输出 ≤阈值-1 → 输出的 mask 与输入完全一致，
//      二次点击 cov 场不变 → 严格幂等（连点不粗不细）。
//   6. RGB：直通色保持笔色/背景色；原透明像素改写为最近形状内像素的直通色（消黑边）。
//
// 适用范围（已从"仅铅笔笔触"推广为"任意色块轮廓"）：
//   轮廓 = 不透明度发生跃变的地方。铅笔硬边、硬笔刷、套索/魔棒填色得到的色块、
//   半透明笔触都适用。阈值按选区内容自动推算，所以半透明色块同样能被识别与重建。
//
// ⚠️ 与早期"铅笔去锯齿"的关键差别（湿边修复）：
//   早期把 profile(cov) 直接当作"不透明度"使用（一张按不透明笔触标定的 0~255 绝对表），
//   于是半透明形状的轮廓外围被压到接近 127 —— 明显高于形状自身的不透明度，
//   结果是轮廓变实、变厚，也就是"湿边"。
//   现在改成 aRecon = 本体不透明度 × profile(cov)，并硬性封顶在本体不透明度：
//   本体越淡，过渡带越淡，轮廓永不比本体更实。
//
// 不变量（改代码时别破坏）：
//   ① 像素集合不变：输出以同一阈值二值化仍得到同一个 mask → 严格幂等。
//   ② 轮廓外只补不削：不把原有的软过渡压暗（半透明笔触的柔边不被吃掉）。
//   ③ 过渡带不透明度 ≤ 本体不透明度（防湿边）。
//   ④ 只修改选区内像素；选区羽化混合由调用方完成。

interface AliasSmoothParams {
  softWidth?: number;        // 柔化宽度（px），0.5~2，默认 2（→blurR 3）。控制过渡带软硬
  strength?: number;         // 混合强度 0~1，默认 1（UI 固定 100%：<100% 会破坏幂等）
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
  连通域标记（4 连通），只为"细线分流"服务：
  thinFlag：域内"到轮廓的最大距离"≤2px（线宽 ≤4px）→ 细线，交给「细线专项」做几何重建。
  这类窄条内部没有距轮廓 ≥2px 的像素，所以它们同时也是"本体不透明度"的种子
  （否则取不到本体水平）。按"整域回填"，避免逐像素再查域属性。
*/
function markThinComponents(
  mask: Uint8Array,
  distOut2: Int32Array,
  width: number,
  height: number
): Uint8Array {
  const n = width * height;
  const thinFlag = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const q = new Int32Array(n);
  const THIN_MAXD2 = 4; // 2²：线宽 ≤4px

  for (let i = 0; i < n; i++) {
    if (mask[i] === 0 || visited[i] === 1) continue;

    let head = 0;
    let tail = 0;
    q[tail++] = i;
    visited[i] = 1;
    let maxD2 = 0;

    while (head < tail) {
      const cur = q[head++];
      const d2 = distOut2[cur];
      if (d2 > maxD2) maxD2 = d2;

      const x = cur % width;
      const y = (cur - x) / width;
      // 4 连通
      if (x > 0) {
        const j = cur - 1;
        if (mask[j] !== 0 && visited[j] === 0) { visited[j] = 1; q[tail++] = j; }
      }
      if (x + 1 < width) {
        const j = cur + 1;
        if (mask[j] !== 0 && visited[j] === 0) { visited[j] = 1; q[tail++] = j; }
      }
      if (y > 0) {
        const j = cur - width;
        if (mask[j] !== 0 && visited[j] === 0) { visited[j] = 1; q[tail++] = j; }
      }
      if (y + 1 < height) {
        const j = cur + width;
        if (mask[j] !== 0 && visited[j] === 0) { visited[j] = 1; q[tail++] = j; }
      }
    }

    if (maxD2 <= THIN_MAXD2) {
      for (let k = 0; k < tail; k++) thinFlag[q[k]] = 1;
    }
  }

  return thinFlag;
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
  计算像素 (i,j) 被形状覆盖的比例（coverage，0~1）：
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
  真实采样拟合的"coverage → 相对不透明度"分段线性表
  （第一次采样：半径7px 铅笔 vs 普通圆头笔，D 型曲线 + 高曲率曲线，两组一致）。
  特征：box_blur(mask, r=3) 后的 4×4 coverage；纵轴是当时按不透明笔触标定的不透明度（0~255），
  这里归一化成 0~1 的"相对值"，使用时再乘形状自身的不透明度 —— 半透明形状按比例变淡，
  不会出现轮廓比本体更实的湿边。
  box 模糊保持重心 → cov 的 0.5 等高线 = mask 边界 → 锚定 profile(0.5)≈0.676 实现宽度守恒 + 严格幂等。
*/
const F_TABLE_X = [0.075, 0.125, 0.175, 0.225, 0.275, 0.325, 0.375, 0.425, 0.475, 0.525, 0.575, 0.625, 0.675, 0.725, 0.775, 0.825, 0.875, 0.925];
const F_TABLE_Y = [0.0, 0.0, 0.5, 3.2, 10.4, 27.4, 57.5, 101.2, 147.3, 197.7, 228.9, 244.7, 252.9, 254.7, 255.0, 255.0, 255.0, 255.0];
const F_PROFILE = F_TABLE_Y.map(v => v / 255);

function lookUpF(cov: number): number {
  const xs = F_TABLE_X;
  const ys = F_PROFILE;
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
  色块的直边同样属于"长台阶"，一并受益。
*/

/*
  长台阶插值覆盖率 → 相对不透明度（真实数据拟合）：
  插值 coverage 的 0.5 等高线在 mask 内第一圈（像素半覆盖），真实圆头笔在该处
  约为本体不透明度的 0.83（比 blur 场的 F 表高，因为插值 cov 与 blur cov 的 0.5 语义不同）。
  拟合：cov 0.425→0.776、0.5→0.827、0.6→0.894、1.0→1.0；低端封顶 0.776（跳变处不降，
  保证沿线条方向无突变）。
*/
function gInterp(cov: number): number {
  return Math.min(1, (198 + 172 * Math.max(0, cov - 0.425)) / 255);
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
  本体不透明度估计（选区内的众数）：
  形状的"实心水平"在直方图里必然是最高的那一档（轮廓过渡带只占几圈像素）。
  ⚠️ 投票权重必须是 alpha（墨量）而不是像素个数：细线的抗锯齿毛刺像素往往比本体像素还多
     （1px 线每行 ~2 个毛刺像素 vs 1 个本体像素），按个数统计会让"毛刺那一档"胜出 → 阈值塌到个位数，
     mask 把整圈毛刺吞进去 —— 这就是细线上"没有任何现象"的直接原因。按下墨量统计则落到本体那一档。
  粗分档（8 宽一档）后取计数最大的一档，用该档的下边界作为本体水平。
  - 硬边形状（alpha 只有 0 与本体两个值）→ 直接落在本体值那一档（不透明时阈值退化为 127，与旧版 128 等价）
  - 半透明形状 → 得到形状自身的不透明度量级，阈值随之下降，半透明色块才可能进入 mask
  - 只统计选区内的像素，不受画面其他内容干扰
  ⚠️ 取值必须只依赖"哪一档胜出"，不能用档内像素均值：
     均值会随第一次处理新生成的过渡带像素而漂移，阈值跟着变 → 二次运行出现零散改动（幂等被破坏）。
     用档的下边界是纯阶跃函数，只要胜出档不变，阈值就完全一致。
*/
function estimateBodyLevel(pixels: Uint8Array, selValid: Uint8Array, pixelCount: number): number {
  const HIST_BINS = 32; // 8 宽一档
  const hist = new Int32Array(HIST_BINS);
  for (let i = 0; i < pixelCount; i++) {
    if (selValid[i] === 0) continue;
    const a = pixels[i * 4 + 3] || 0;
    if (a <= 0) continue;
    hist[a >> 3] += a;
  }
  let bestBin = -1;
  let bestCount = 0;
  for (let b = 0; b < HIST_BINS; b++) {
    // 计数相同时取更高的一档：宁可阈值偏高（少收一点淡边），也不要误收大片淡雾
    if (hist[b] >= bestCount && hist[b] > 0) {
      bestCount = hist[b];
      bestBin = b;
    }
  }
  if (bestBin < 0) return 0;
  return bestBin << 3;
}

/*
  主入口：对完整文档尺寸的 RGBA（straight alpha）像素做轮廓消除锯齿。
  - pixelData：完整文档 RGBA（straight）
  - selectionMaskBuffer：完整文档 0~255（>0 表示可修改；羽化混合由调用方完成）
  - 返回同尺寸 RGBA ArrayBuffer
*/
/*
  平台中心线性插值：把整数阶梯 vals[] 重建成亚像素连续的边界位置。
  阶梯的每个"平台"（值恒定的连续段）中心恰是真实边界上的采样点 —— 边界跨过半整数时平台才切换，
  所以平台中心之间线性插值就是真实边界的精确重建（直线情形精确；曲线退化为逐扫描线插值，仍然正确）。
  ⚠️ 不要用"相邻扫描线插值"替代：1:20 的缓坡本该花 20 列走完 1px，相邻列插值会在 1 列内走完 1px，
     斜坡被压缩、台阶跳变照旧残留（旧版长台阶分支的隐患正在此）。
*/
function makePlateauInterp(vals: Int32Array, m: number): (i: number) => number {
  // 平台 = 值恒定的连续段；pOf[i] 记录每个扫描线属于第几个平台
  const pOf = new Int32Array(m);
  const pVal: number[] = [];
  const pSt: number[] = [];
  const pEn: number[] = [];
  for (let i = 0; i < m;) {
    let j = i;
    while (j + 1 < m && vals[j + 1] === vals[i]) j++;
    for (let k = i; k <= j; k++) pOf[k] = pVal.length;
    pVal.push(vals[i]); pSt.push(i); pEn.push(j);
    i = j + 1;
  }
  const np = pVal.length;
  // 典型平台长度：取内部平台长度的中位数（平台太少时退化为全部）
  const lens: number[] = [];
  for (let p = np > 2 ? 1 : 0; p < (np > 2 ? np - 1 : np); p++) lens.push(pEn[p] - pSt[p] + 1);
  lens.sort((a, b) => a - b);
  const typ = lens.length ? lens[lens.length >> 1] : 1;
  // 平台中心 = 真实边界取到"该平台值 + 0.5"的那一行。
  // ⚠️ 笔触两端的平台常被链的边界截断，观测中心不等于真实中心 —— 直接当插值锚点会让端部十几行的
  //    亚像素位置偏最多半个平台长（实测 ~0.38px）。按典型平台长度把"应有的"中心补回来。
  const pCen = new Float64Array(np);
  for (let p = 0; p < np; p++) {
    let s0 = pSt[p], e0 = pEn[p];
    const len = e0 - s0 + 1;
    if (np >= 2 && len < typ) {
      if (p === 0) s0 = e0 - typ + 1;
      else if (p === np - 1) e0 = s0 + typ - 1;
    }
    pCen[p] = (s0 + e0) / 2;
  }
  return (i: number) => {
    const q = i < 0 ? 0 : (i > m - 1 ? m - 1 : i);
    const p = pOf[q];
    const c0 = pCen[p], v0 = pVal[p];
    let p1 = -1;
    if (p > 0 && (i < c0 || p + 1 >= np)) p1 = p - 1;
    else if (p + 1 < np) p1 = p + 1;
    else if (p > 0) p1 = p - 1;
    if (p1 < 0) return v0;
    const c1 = pCen[p1], v1 = pVal[p1];
    if (c1 === c0) return v0;
    return v0 + (v1 - v0) * ((i - c0) / (c1 - c0));
  };
}

export async function processAliasSmooth(
  pixelData: ArrayBuffer,
  selectionMaskBuffer: ArrayBuffer,
  dimensions: { width: number; height: number },
  _params?: AliasSmoothParams,
  isBackgroundLayer: boolean = false
): Promise<ArrayBuffer> {
  const width = Math.max(1, dimensions.width | 0);
  const height = Math.max(1, dimensions.height | 0);
  const pixelCount = width * height;

  const pixels = new Uint8Array(pixelData);
  const selectionMaskRaw = new Uint8Array(selectionMaskBuffer);
  const out = new Uint8Array(pixels.length);
  out.set(pixels);

  // 背景图层 alpha 恒 255，没有轮廓可重建，直接返回（由调用方拦截提示）
  if (isBackgroundLayer) return out.buffer;
  if (pixels.length < pixelCount * 4) return out.buffer;

  const params = (_params || {}) as AliasSmoothParams;
  const softWidth = Math.max(0.5, Math.min(2, typeof params.softWidth === 'number' ? params.softWidth : 2));
  const strength = clamp01(typeof params.strength === 'number' ? params.strength : 1);

  // 选区有效像素（selectionMask > 0）包围盒 + 本体不透明度估计
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

  const bodyLevel = estimateBodyLevel(pixels, selValid, pixelCount);
  if (bodyLevel <= 0) return out.buffer;
  // 轮廓二值化阈值：本体水平的一半（轮廓的几何边界所在）。不透明形状 → 128，与旧版一致
  const thr = clampInt(Math.round(bodyLevel / 2), 2, 128);

  // alpha 与形状 mask（全文档计算：alpha≥阈值视为形状，供距离场参照，不受选区限制）
  const alpha = new Uint8Array(pixelCount);
  const mask = new Uint8Array(pixelCount);
  let shapeCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    const a = pixels[i * 4 + 3] || 0;
    alpha[i] = a;
    if (a >= thr) { mask[i] = 1; shapeCount++; }
  }
  if (shapeCount === 0) return out.buffer;

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

  // ---- EDT_in：种子 = 形状内像素（mask=1）----
  // 得到形状外像素"到最近形状内像素的距离"（distIn2），
  // 同时传播"形状内像素的打包直通颜色"（供透明背景上的过渡带像素取形状色，避免黑边）。
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

  // ---- EDT_out_dist：种子 = 全部形状外像素（mask=0）----
  // 得到形状内像素"到最近形状外像素的距离"（≈ 到轮廓的距离）。
  const seedOutAll = new Uint8Array(rn);
  for (let i = 0; i < rn; i++) {
    if (rMask[i] === 0) seedOutAll[i] = 1;
  }
  const distOut2 = new Int32Array(rn);
  {
    const tmpFeat = new Uint8Array(rn);
    edt8SSEDT(seedOutAll, rw, rh, rAlpha, distOut2, tmpFeat);
  }

  // ---- 连通域：细线分流标记 ----
  const thinFlag = markThinComponents(rMask, distOut2, rw, rh);

  // ---- EDT_body：本体不透明度场 ----
  // 种子 = 形状内"距轮廓 ≥2px"的像素（它们的 alpha 就是形状的实心水平），
  // 窄条（宽 ≤5px）没有这样的像素，整段都算种子。
  // 把最近种子的 alpha 传播到每个像素：轮廓像素按"所在形状的本体水平"等比缩放过渡带，
  // 于是同一张图上不同透明度的色块各按自己的水平处理，轮廓永不比本体更实。
  const seedBody = new Uint8Array(rn);
  for (let i = 0; i < rn; i++) {
    if (rMask[i] === 0) continue;
    if (distOut2[i] >= 4 || thinFlag[i] === 1) seedBody[i] = 1;
  }
  const distBody2 = new Int32Array(rn);
  const bodyAlpha = new Uint8Array(rn);
  edt8SSEDT(seedBody, rw, rh, rAlpha, distBody2, bodyAlpha);

  // ---- coverage 场：对 mask 做 box 平滑（blurR 由柔化宽度映射，默认 2px → blurR=3）----
  // box 模糊保持重心 → cov 的 0.5 等高线精确落在 mask 边界：
  //   输出 ≥阈值 ⇔ cov ≥ 0.5 ⇔ mask（配合下方锚定）→ 二次处理 cov 场不变 → 严格幂等。
  const blurR = clampInt(Math.round(softWidth * 1.4), 1, 4);
  const blurredMask = boxBlurMask(rMask, rw, rh, blurR);
  const maxD2Screen = (blurR + 2.5) * (blurR + 2.5); // 粗筛：只处理轮廓带内的像素

  // ---- 长台阶直线专项：每列/每行边界 + 平台长度（供插值覆盖率分支使用）----
  const borders = extractBorders(rMask, rw, rh);
  const platTop = plateauLen(borders.top, rw);
  const platBot = plateauLen(borders.bot, rw);
  const platLeft = plateauLen(borders.left, rh);
  const platRight = plateauLen(borders.right, rh);
  const MIN_PLAT = 5; // 平台段 ≥5px 判为长台阶（约 1:5 及更缓的斜线）

  // ---- 细线专项（线宽 ≤4px）：亚像素边界重建 + 墨量守恒 ----
  // 细线在 blur 窗口里占比极小（1px 线在 r=3 的窗口里只有 7/49），cov 恒在 0.2 以下，
  // 而 F 表是按"实心区"标定的 —— 走覆盖率只会把整条线压到阈值附近：只是变淡，不是消锯齿。
  // 细线内部也没有"距轮廓 ≥2px"的像素可作本体锚点（aBody 只能取自身 alpha，会自我漂移）。
  // 于是改用几何重建：
  //   ① 把 mask 沿主扫描轴切成游程，相邻扫描线的游程按重叠串成"带"（链）；
  //   ② 链的上下边界是整数阶梯，用平台中心插值还原成亚像素连续的边界，带心取两边界均值；
  //   ③ 带宽取"出现次数最多的厚度"当常量（刚性）：逐扫描线用 B[i]-A[i]+1 会因上下边界在不同
  //      扫描线切换而使带高在 1↔2 间跳变，覆盖度归一化跟着抖 → 亚像素位置会算歪；
  //   ④ 覆盖度 = 像素与几何带的重叠长度（解析式、连续）；
  //   ⑤ 墨量守恒：每条扫描线 ink = 几何跨距内原有 alpha 之和，重分布为 ink·cov/Σcov。
  //      不增厚不变淡，峰值不超 ink/带宽（= 本体不透明度）；
  //      ⚠️ 跨距必须取几何区间 [⌊eT⌋, ⌈eB⌉-1]，不能只取 mask 游程：重分布后落到阈值以下的
  //         肩部像素会掉出 mask，只按游程量墨会让墨量逐次流失。
  //   ⑥ 幂等闸门：带内一旦出现"0 < alpha < 带内最大值"的过渡像素，说明它已经是平滑结果
  //      （上一轮或笔刷自带）→ 只认领、不再改写。亚像素信息在"硬阶梯"里只存在于台阶结构，
  //      而"带高"在平滑后无法从像素值反推（1px@255 与 2px@127 的像素值完全一样），
  //      所以细线只能是一次性的：认得出硬阶梯才动手，动过手就认得出来。
  //   ⑦ 锚定沿用主路径（mask 内 ≥阈值、mask 外 ≤阈值-1、mask 内只降）⇒ mask 不变。
  const thinScope = new Uint8Array(rn);   // 认领（主路径避让）
  const thinDone = new Uint8Array(rn);    // 已处理（两个轴向去重）
  const processThinBands = (vertical: boolean): void => {
    const S = vertical ? rh : rw; // 扫描线数
    const L = vertical ? rw : rh; // 单条扫描线长度
    // 沿扫描轴切游程，再把相邻扫描线的游程按重叠串成链（链的扫描线必然连续）
    const cS0: number[] = [];
    const cA: number[][] = [];
    const cB: number[][] = [];
    let prevA: number[] = [], prevB: number[] = [], prevC: number[] = [];
    for (let s = 0; s < S; s++) {
      const curA: number[] = [], curB: number[] = [], curC: number[] = [];
      for (let v = 0; v < L; v++) {
        const ri0 = vertical ? s * rw + v : v * rw + s;
        if (rMask[ri0] === 0 || thinFlag[ri0] === 0) continue;
        const a = v;
        while (v + 1 < L) {
          const rj = vertical ? s * rw + (v + 1) : (v + 1) * rw + s;
          if (rMask[rj] === 0 || thinFlag[rj] === 0) break;
          v++;
        }
        const b = v;
        let c = -1, ov0 = -1;
        for (let k = 0; k < prevA.length; k++) {
          const ov = (prevB[k] < b ? prevB[k] : b) - (prevA[k] > a ? prevA[k] : a) + 1;
          if (ov >= 0 && ov > ov0) { ov0 = ov; c = prevC[k]; }
        }
        if (c < 0) { c = cS0.length; cS0.push(s); cA.push([]); cB.push([]); }
        cA[c].push(a); cB[c].push(b);
        curA.push(a); curB.push(b); curC.push(c);
      }
      prevA = curA; prevB = curB; prevC = curC;
    }
    // 逐链重建
    for (let ci = 0; ci < cS0.length; ci++) {
      const A = Int32Array.from(cA[ci]);
      const B = Int32Array.from(cB[ci]);
      const m = A.length;
      if (m < 2) continue;
      let thickSum = 0;
      for (let i = 0; i < m; i++) thickSum += B[i] - A[i] + 1;
      // 只处理"沿扫描轴延伸的细带"：跨度须明显大于平均厚度（近垂直的段交给另一个轴向）
      if (m < 3 * (thickSum / m)) continue;
      const s0 = cS0[ci];
      // 刚性带宽：取出现次数最多的厚度
      const wHist = new Int32Array(8);
      for (let i = 0; i < m; i++) {
        let w = B[i] - A[i] + 1;
        if (w > 7) w = 7; else if (w < 1) w = 1;
        wHist[w]++;
      }
      let wq = 1, wBest = 0;
      for (let w = 1; w <= 7; w++) if (wHist[w] > wBest) { wBest = wHist[w]; wq = w; }
      // 认领窗口（±2px）；幂等闸门 = "边缘是否已经带亚像素过渡"
      // ⚠️ 判据不能用"窗口内出现任何中间 alpha"：PS 的铅笔/笔刷即使在硬边上也会留一圈极淡的
      //    抗锯齿像素（几个灰阶），那样会把所有真实笔触一并拦掉 —— 细线就"没有任何现象"。
      //    真正的判据是"过渡里有没有把亚像素位置编码进去"，基准取全链最大 alpha（本体水平）：
      //      · 硬阶梯：剖面非 0 即本体，0.25~0.75 本体之间的中间档几乎没有 → 位置只在台阶里 → 要重建；
      //      · 已抗锯齿 / 已处理过：边缘像素正落在 0.25~0.75 本体之间 → 位置已在像素值里，
      //        再重建只会把已经正确的位置重新量化（越修越糊）→ 只认领、不改写。
      //    用全链最大 alpha 而不是"窗口内最大值"当基准：处理后局部峰值会掉到一半，
      //    用局部峰值做基准会把"已处理的线"误判成"硬阶梯"，于是越点越糊。
      // 基准取"本行游程内的最大 alpha"（本体水平），而不是全链最大：笔画常带压感渐变，
      // 用全链最大会把渐细的那一段整段误判成"已抗锯齿"而整条跳过。
      let gradedLines = 0;
      for (let i = 0; i < m; i++) {
        const s = s0 + i;
        let bMax = 0;
        for (let v = A[i]; v <= B[i]; v++) {
          const a = rAlpha[vertical ? s * rw + v : v * rw + s];
          if (a > bMax) bMax = a;
        }
        if (bMax <= 0) continue;
        let graded = 0;
        for (let v = A[i] - 2; v <= B[i] + 2; v++) {
          if (v < 0 || v >= L) continue;
          const ri = vertical ? s * rw + v : v * rw + s;
          thinScope[ri] = 1;
          const a = rAlpha[ri];
          if (a > bMax * 0.25 && a < bMax * 0.75) graded++;
        }
        if (graded > 0) gradedLines++;
      }
      if (gradedLines * 2 > m) continue; // 多数扫描线的边缘已带亚像素级过渡：只认领，不改写
      const iT = makePlateauInterp(A, m);
      const iB = makePlateauInterp(B, m);
      // 每条扫描线的墨量（几何跨距内原有 alpha 之和）（首尾各补一格仅供插值取用，不写出）
      const ink = new Float64Array(m + 2);
      for (let i = 0; i < m; i++) {
        const s = s0 + i;
        const eMid = (iT(i) + iB(i) + 1) / 2;
        const eT = eMid - wq / 2, eB = eMid + wq / 2;
        let lo = Math.floor(eT), hi = Math.ceil(eB) - 1;
        if (hi < lo) hi = lo;
        let sum = 0;
        for (let v = lo; v <= hi; v++) {
          if (v < 0 || v >= L) continue;
          sum += rAlpha[vertical ? s * rw + v : v * rw + s];
        }
        ink[i + 1] = sum;
      }
      ink[0] = ink[1];
      ink[m + 1] = ink[m];
      for (let i = 0; i < m; i++) { // 不外推写链外一行：那会在空像素上凭空造出虚边
        const s = s0 + i;
        if (s < 0 || s >= S) continue;
        const ik = ink[i + 1];
        if (ik <= 0) continue;
        const eMid = (iT(i) + iB(i) + 1) / 2;
        const eT = eMid - wq / 2, eB = eMid + wq / 2;
        let lo = Math.floor(eT), hi = Math.ceil(eB) - 1;
        if (hi < lo) hi = lo;
        const nSpan = hi - lo + 1;
        const cov = new Float64Array(nSpan);
        let sCov = 0;
        for (let k = 0; k < nSpan; k++) {
          const v = lo + k;
          const l = v > eT ? v : eT;
          const h = v + 1 < eB ? v + 1 : eB;
          let c = h - l;
          if (c < 0) c = 0; else if (c > 1) c = 1;
          cov[k] = c;
          sCov += c;
        }
        if (sCov <= 1e-6) continue;
        // 本扫描线上"本链自己"的游程：mask 内但不在其中 → 属于别的图形，留给主路径
        const ownA = (i >= 0 && i < m) ? A[i] : 1;
        const ownB = (i >= 0 && i < m) ? B[i] : -1;
        // ① 目标值：按覆盖度分摊墨量，再按不变量截断（内 ≤ 原值且 ≥ 阈值；外 ≤ 阈值-1 且只增不减）
        const tgt = new Float64Array(nSpan);
        const act = new Uint8Array(nSpan);
        let lost = 0;
        for (let k = 0; k < nSpan; k++) {
          const v = lo + k;
          if (v < 0 || v >= L) continue;
          const ri = vertical ? s * rw + v : v * rw + s;
          const inMask = rMask[ri] === 1;
          if (inMask && (v < ownA || v > ownB)) continue;
          if (thinDone[ri] === 1) continue;
          thinDone[ri] = 1;
          if (rSel[ri] === 0) continue;
          act[k] = 1;
          const a0 = rAlpha[ri];
          let aT = (ik * cov[k]) / sCov;
          if (inMask) {
            if (aT < thr) aT = thr;
            if (aT > a0) { lost += aT - a0; aT = a0; }
          } else {
            if (aT > thr - 1) { lost += aT - (thr - 1); aT = thr - 1; }
            if (aT < a0) aT = a0;
          }
          tgt[k] = aT;
        }
        // ② 墨量守恒：被截断丢掉的墨转投到"外侧还有余额"的肩部像素。
        //    少了这一步，内圈被 a0 卡住的那部分墨就凭空蒸发 → 每点一次峰值降一点（实测每次 ~2~3 级）。
        if (lost > 0.5) {
          let room = 0;
          for (let k = 0; k < nSpan; k++) {
            const v = lo + k;
            if (!act[k] || v < 0 || v >= L) continue;
            const ri = vertical ? s * rw + v : v * rw + s;
            if (rMask[ri] === 1) continue;
            const cap = thr - 1;
            if (tgt[k] < cap) room += (cap - tgt[k]) * (cov[k] > 0 ? cov[k] : 0.5);
          }
          if (room > 1e-6) {
            const share = lost < room ? lost : room;
            for (let k = 0; k < nSpan; k++) {
              const v = lo + k;
              if (!act[k] || v < 0 || v >= L) continue;
              const ri = vertical ? s * rw + v : v * rw + s;
              if (rMask[ri] === 1) continue;
              const cap = thr - 1;
              if (tgt[k] >= cap) continue;
              const wk = cov[k] > 0 ? cov[k] : 0.5;
              tgt[k] = Math.min(cap, tgt[k] + (share * wk) / room);
            }
          }
        }
        // ③ 写出
        for (let k = 0; k < nSpan; k++) {
          if (!act[k]) continue;
          const v = lo + k;
          const ri = vertical ? s * rw + v : v * rw + s;
          const inMask = rMask[ri] === 1;
          const a0 = rAlpha[ri];
          const aF = clampInt(Math.round(tgt[k]), 0, 255);
          if (aF === a0) continue;
          if (!inMask && aF < a0) continue;
          const ry = vertical ? s : v;
          const rx = vertical ? v : s;
          const p = ((y0 + ry) * width + (x0 + rx)) * 4;
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
    }
  };
  processThinBands(false); // 近水平细带：按列切游程
  processThinBands(true);  // 近垂直细带：按行切游程

  // ---- 覆盖率重建（查表 + 长台阶插值分支）----
  for (let ry = 0; ry < rh; ry++) {
    const rowR = ry * rw;
    const docY = y0 + ry;
    for (let rx = 0; rx < rw; rx++) {
      const ri = rowR + rx;
      if (rSel[ri] === 0) continue;

      const inMask = rMask[ri] === 1;
      // 细线专项已重建过的像素（含其肩部）不参与主路径，避免两套逻辑互相覆盖
      if (thinScope[ri] === 1) continue;
      // 细线域（线宽 ≤4px）交给「细线专项」重建（见 processThinBands），主路径整体跳过：
      if (thinFlag[ri] === 1) continue;
      // 它们在 blur 窗口里的占比太小，走覆盖率会被压到阈值附近 —— 只是变淡，不是消锯齿。
      // 轮廓外的稳定背景参照圈（距形状 ≥1.73px）永不改写
      if (!inMask && distIn2[ri] >= 3) continue;
      // 本体内部（距轮廓 ≥2px）永不改写：
      //   ① 那一带本来就是实心（cov≈1，下面也会被 cov≥0.97 挡掉）；
      //   ② 它们是"本体不透明度"的种子。凹角、窄颈处的 box 窗口会外溢，cov 掉到 0.97 以下，
      //      若放任改写，本体水平就会在多次点击之间缓慢漂移 —— 幂等就此破功（实测每次降 1 级）。
      if (distOut2[ri] >= 4) continue;

      // 粗筛：远离轮廓不处理
      const d2 = inMask ? distOut2[ri] : distIn2[ri];
      if (d2 > maxD2Screen) continue;

      // 本像素所属形状的本体不透明度：过渡带按它等比缩放，且封顶在它
      const aBody = bodyAlpha[ri];
      if (aBody <= 0) continue;

      let aRecon: number;
      let skipCov = false;

      // 长台阶插值分支（mask 内轮廓带，平台段 ≥MIN_PLAT 的列/行）：
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
          aRecon = aBody * gInterp(covColInterp(rMask, borders.top, borders.bot, rw, rh, rx, ry));
          skipCov = true;
        } else if (vPlat >= MIN_PLAT && nearV) {
          aRecon = aBody * gInterp(covRowInterp(rMask, borders.left, borders.right, rw, rh, rx, ry));
          skipCov = true;
        }
      }

      if (!skipCov) {
        const cov = coverage4x4(blurredMask, rw, rh, rx, ry);
        // 完全覆盖（本体）或完全未覆盖（远处背景）→ 不改（profile 两端本身就是 1/0）
        if (cov <= 0.22) continue;
        if (cov >= 0.97) continue;
        aRecon = aBody * lookUpF(cov);
      }

      const docX = x0 + rx;
      const di = docY * width + docX;
      const p = di * 4;
      const a0 = pixels[p + 3] || 0;

      // 不变量③：过渡带不高于本体（半透明形状不会出现"湿边"）
      if (aRecon > aBody) aRecon = aBody;

      // 不变量①：锚定在二值化阈值上——mask 内 ≥thr、mask 外 ≤thr-1，
      // 于是输出的 mask 与输入完全一致（二次点击不会越点越粗/越细）。
      // 不变量②：两侧各自的单调性（内侧只削、外侧只补）——
      //   · 内侧：结果落在 [thr, 原值] 内 → 轮廓内侧的不透明度永不增高，也不会把
      //     本来就已经柔和的边重新"硬化"（旧版会把软边半透明笔触推成一条硬边）；
      //   · 外侧：结果落在 (原值, thr-1] 内 → 原有软过渡不被压暗，背景不被啃。
      //   合起来：内侧只削、外侧只补 —— 轮廓带只会向"过渡区"方向长，不会整体变实。
      if (inMask) {
        if (aRecon < thr) aRecon = thr;
        if (aRecon > a0) aRecon = a0;
      } else {
        if (aRecon > thr - 1) aRecon = thr - 1;
        if (aRecon < a0) aRecon = a0;
      }

      const aTarget = Math.round(a0 + (aRecon - a0) * strength);
      const aF = clampInt(aTarget, 0, 255);
      if (aF === a0) continue;
      // 四舍五入的保底：外侧只补不削
      if (!inMask && aF < a0) continue;

      // 直通 RGB：PS 的 straight alpha 图层中，半透明边缘像素的直通色应保持
      // "笔色/背景色"恒定（合成时由 alpha 决定明暗），而不是反预乘（会过曝成白边）。
      //  - 形状内：保持原直通色（= 形状色）
      //  - 形状外有色像素（底色）：保持原直通色
      //  - 形状外透明像素（a0=0）：取"最近形状内像素的直通色"（原为垃圾值/黑，改为形状色）
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

  return out.buffer;
}

export const defaultAliasSmoothParams: AliasSmoothParams = {
  softWidth: 2, // 默认柔化宽度（0.5~2px 滑块上限，2px → blurR=3 对应拟合曲线，效果与旧版一致）
  strength: 1, // 固定 100%：混合依赖当前像素值会破坏幂等（多次点击边缘逐次变实变粗）
};
