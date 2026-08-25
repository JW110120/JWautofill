/*
 * lineSmoothProcessor.ts —— 「仅主线条」平滑算法（有符号距离场 · 主线条模式）
 *
 * 设计目标：
 *   1. 线宽基本保持 —— 对「有符号距离场(SDF)」做高斯平滑，宽线条几乎不收缩
 *                         （仅 <2σ 的细小毛刺被自然清理），无需再重建外边界
 *   2. 与原本线条 alpha 视觉不偏离 —— 主体密度 = 原 alpha 高斯模糊(抛光)，
 *                        并以中值归一保证整体明暗不偏
 *   3. 轮廓毛刺极大削弱 + 去锯齿 —— SDF 高斯平滑消除阶梯；重建时用带宽 band
 *                        做 smoothstep 软过渡 → 输出自带抗锯齿软边
 *   4. 反复描线 → 合成一根 —— SDF 把多次描线合并成同一距离场，平滑后自然合成一根
 *   5. 平滑力度 = 平滑强度（高斯 σ），而非 alpha 提升量
 *
 * 为什么不用「中心线+半宽带重建」：
 *   - 中心线移动平均会把抛物线顶点拉平成平台（暴力削平）；
 *   - 对称带状重建在中心线拐点处生成「跑道胶囊」尖角；
 *   - 重建剖面硬切在 THR 处 → 丢失原线稿的抗锯齿软边。
 *   距离场平滑是形状级平滑：圆角=倒圆角，不产生平顶/尖角；软边由阈值附近的
 *   带宽过渡自然产生，天然抗锯齿。
 *
 * 管线：
 *   Phase A  构建有符号距离场 sd（线内为正、线外为负；绝对精确欧氏距离 Felzenszwalb）
 *   Phase B  高斯平滑 sd（几何抛光）+ 高斯平滑原 alpha（密度抛光）
 *   Phase C  由 sd_blur 重建反锯齿覆盖 cov（决定平滑轮廓形状+抗锯齿），再乘密度：
 *            · 原线像素 → 抛光后的真实密度（保留笔压深浅）
 *            · 原为背景/孔洞像素 → 用「代表性密度 medOrig」而非原始 alpha 的高斯光晕，
 *              避免线外因光晕泄漏产生游离杂点；同时平滑新增的边缘/内部孔洞得到干净填充
 *   Phase D  就近洪泛：新像素（alpha>0 但原为背景）从最近原线像素取 RGB
 *   Phase E  标记游离杂点：原 lineMask 中面积 < SPECK_MAX 的 8 连通小域（铅笔屑/碎墨点），
 *            与主线条不连通。它们被 Phase A 从 lineMaskClean 移除、Phase C cov≈0 清空，
 *            但「na==0 保留原值」会原样写回 → 线外游离黑点。此处显式标记供写回清零
 *   Phase F  写回（仅选区；原线 RGB 直通，背景绝对保持；不硬性删原线像素防孔洞；
 *            游离杂点连同 RGB 彻底清除）
 */

export interface LineSmoothParams {
  /** 平滑力度 0~1（UI 0-100%，默认 100 → 1）。控制高斯 σ */
  strength?: number;
  /** 平滑范围 px（UI 3~12，默认 8）。σ 上限与抗锯齿带宽参考 */
  radius?: number;
}

const THR = 16;                 // 线条二值化阈值
const SPECK_MAX = 10;           // 游离杂点判定：原线掩码中 8 连通域面积 < 该值 → 杂点
const INF = 1e12;               // 距离变换「非种子」标记
const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));
const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));
const clamp255 = (v: number) => (v < 0 ? 0 : (v > 255 ? 255 : v));
const smoothstep = (t: number) => { const u = clamp01(t); return u * u * (3 - 2 * u); };

/** 主入口：对文档尺寸 RGBA（straight alpha）做「仅主线条」距离场平滑。 */
export async function processLineSmooth(
  pixelDataBuffer: ArrayBuffer,
  selectionMaskBuffer: ArrayBuffer,
  dimensions: { width: number; height: number },
  _params?: LineSmoothParams
): Promise<ArrayBuffer> {
  const width = Math.max(1, dimensions.width | 0);
  const height = Math.max(1, dimensions.height | 0);
  const pixelCount = width * height;
  const pixels = new Uint8Array(pixelDataBuffer);
  const selRaw = new Uint8Array(selectionMaskBuffer);
  const out = new Uint8Array(pixels.length);
  out.set(pixels);
  if (pixels.length < pixelCount * 4) return out.buffer;

  const params = (_params || {}) as LineSmoothParams;
  const strength = clamp01(typeof params.strength === 'number' ? params.strength : 1);
  const radius = clampInt(Math.round(typeof params.radius === 'number' ? params.radius : 8), 3, 12);

  // ---- 平滑力度 → 高斯 σ ----
  // σ 控制在「小于线宽」范围：宽线条(>2σ)基本不收缩，仅细小毛刺被清理。
  // 上限放宽到 3.2，以便更充分地抛光边缘锯齿/杂点。
  const sigma = clamp(1.0 + strength * radius * 0.25, 0.8, 3.2);
  const sigmaBody = clamp(sigma * 0.55, 0.7, radius); // 密度抛光（轻抛，保留更多笔压）
  const band = Math.max(0.7, radius * 0.13);          // 抗锯齿软边过渡带宽(px)

  // ---- 选区掩码（>0 视为可选） ----
  const sel = new Uint8Array(pixelCount);
  let selCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if ((selRaw[i] || 0) > 0) { sel[i] = 1; selCount++; }
  }
  if (selCount === 0) return out.buffer;

  // ---- 原始线稿：alpha 与线条掩码（仅选区内的线像素） ----
  const alpha = new Float32Array(pixelCount);
  const lineMask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const a = pixels[i * 4 + 3] || 0;
    alpha[i] = a;
    if (a > THR && sel[i]) lineMask[i] = 1;
  }

  // ================= Phase A：形态学前置清理 + 有符号距离场 =================
  // 先用半径 2 开运算（腐蚀→膨胀）去掉原线稿边缘 1~2px 孤立杂点/毛刺，
  // 再建 SDF。这样锯齿/碎点不会作为「线内实体」被保留，对 20px 左右粗线影响很小。
  const lineMaskClean = binaryOpen(lineMask, width, height, 2);
  const sd = buildSignedDistance(lineMaskClean, sel, width, height);

  // ================= Phase A.5：标记游离杂点（孤立小连通域） =================
  // 原 lineMask 中面积 < SPECK_MAX 的 8 连通域视为游离杂点（铅笔屑/碎墨点/灰尘点，
  // 与主线条不连通）。它们已被 binaryOpen 从 lineMaskClean 移除，Phase C 中 cov≈0，
  // 但 Phase F 的「na==0 保留原值」会把原 alpha 原样写回 → 线外残留黑点。
  // 这里显式标记，Phase F 写回时对它们连同 RGB 一并清零。
  const isSpeck = new Uint8Array(pixelCount);
  {
    const visited = new Uint8Array(pixelCount);
    const stack = new Int32Array(pixelCount);
    for (let start = 0; start < pixelCount; start++) {
      if (!lineMask[start] || visited[start]) continue;
      let head = 0, tail = 0;
      stack[tail++] = start;
      visited[start] = 1;
      const begin = tail - 1; // 该连通域在 stack 中的起点
      while (head < tail) {
        const cur = stack[head++];
        const cx = cur % width;
        const cy = (cur - cx) / width;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = cx + dx;
            if (xx < 0 || xx >= width) continue;
            const nb = yy * width + xx;
            if (lineMask[nb] && !visited[nb]) {
              visited[nb] = 1;
              stack[tail++] = nb;
            }
          }
        }
      }
      if (tail - begin < SPECK_MAX) {
        for (let k = begin; k < tail; k++) isSpeck[stack[k]] = 1;
      }
    }
  }

  // ================= Phase B：几何 + 密度抛光 =================
  const sdB = gaussianBlur(sd, width, height, sigma);
  const bodyBlur = gaussianBlur(alpha, width, height, sigmaBody);

  // 主体密度中值归一：保证整体明暗不偏离原线
  let medOrig = 0, medBlur = 0;
  {
    const valsO: number[] = [], valsB: number[] = [];
    for (let i = 0; i < pixelCount; i++) {
      if (lineMaskClean[i] && sel[i]) { valsO.push(alpha[i]); valsB.push(bodyBlur[i]); }
    }
    if (valsO.length) {
      valsO.sort((a, b) => a - b); valsB.sort((a, b) => a - b);
      medOrig = valsO[valsO.length >> 1] || 1;
      medBlur = valsB[valsB.length >> 1] || 1;
    }
  }
  const bodyScale = medBlur > 1 ? clamp(medOrig / medBlur, 0.8, 1.3) : 1;

  // ================= Phase C 前置：多源 BFS，记录每个像素最近的原始线像素索引 =================
  // 用途：
  //   1) Phase C 为背景/孔洞像素提供「最近原始线 alpha」作为密度，避免用核心 medOrig 造成边缘黑杂点
  //   2) Phase D 为新增像素洪泛取 RGB 颜色
  const nearSrc = new Int32Array(pixelCount);
  nearSrc.fill(-1);
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (lineMaskClean[i] === 1) {
      nearSrc[i] = i;
      visited[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % width;
    const cy = (cur - cx) / width;
    const src = nearSrc[cur];
    if (cx > 0) {
      const nb = cur - 1;
      if (visited[nb] === 0) { visited[nb] = 1; nearSrc[nb] = src; queue[tail++] = nb; }
    }
    if (cx + 1 < width) {
      const nb = cur + 1;
      if (visited[nb] === 0) { visited[nb] = 1; nearSrc[nb] = src; queue[tail++] = nb; }
    }
    if (cy > 0) {
      const nb = cur - width;
      if (visited[nb] === 0) { visited[nb] = 1; nearSrc[nb] = src; queue[tail++] = nb; }
    }
    if (cy + 1 < height) {
      const nb = cur + width;
      if (visited[nb] === 0) { visited[nb] = 1; nearSrc[nb] = src; queue[tail++] = nb; }
    }
  }

  // ================= Phase C：重建反锯齿覆盖 =================
  // 阈值 T=0：宽线条边界在 SDF 高斯后基本不动（独立边缘），细毛刺自然收缩。
  // cov 决定平滑轮廓形状与抗锯齿软边；密度分支消除「线外游离杂点」：
  //   原线像素(alpha>THR)        保留抛光后的真实密度（笔压深浅）；
  //   背景/孔洞/平滑新增像素     用「最近原线像素的 alpha」作为密度，而非核心 medOrig，
  //                            避免把核心深色密度硬套到边界灰阶像素，产生黑色杂点。
  const T = 0;
  const strokeAlpha = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (sel[i] !== 1) continue;
    const cov = smoothstep((sdB[i] - T) / band);   // 0..1 覆盖（边界软过渡→抗锯齿）
    // 密度：原线像素用抛光真实密度；非原线像素用最近原线 alpha（与洪泛取色同源的局部密度）
    let density: number;
    if (alpha[i] > THR) {
      density = bodyBlur[i] * bodyScale;
    } else {
      const s = nearSrc[i];
      density = s >= 0 ? alpha[s] : 0;
    }
    let v = cov * density;
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    strokeAlpha[i] = v;
  }

  // ================= Phase D：去杂点剪枝（保守，只清孤立/单连接像素） =================
  // 目标：消除 SDF 平滑后仍残留的 1px 线外黑尖/杂点，同时不伤害连续边缘。
  // 规则（二者满足其一即剪枝）：
  //   A) 输出 alpha>THR，但在 8 邻域内输出也>THR 的邻居 ≤1 个 → 孤立像素；
  //   B) 输出 alpha>THR，但 8 邻域内没有任何原线像素(alpha>THR) → 完全游离。
  const cleaned = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) cleaned[i] = strokeAlpha[i];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    if (sel[i] !== 1) continue;
    const v = strokeAlpha[i];
    if (v <= THR) continue;
    let lineNbr = 0, origNbr = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const j = i + dy * width + dx;
      if (j < 0 || j >= pixelCount) continue;
      if (strokeAlpha[j] > THR) lineNbr++;
      if (alpha[j] > THR) origNbr++;
    }
    if (lineNbr <= 1 || origNbr === 0) cleaned[i] = 0;
  }
  for (let i = 0; i < pixelCount; i++) strokeAlpha[i] = cleaned[i];

  // ================= Phase E（写回）：原线直通 / 杂点清零 / 背景保持 =================
  for (let i = 0; i < pixelCount; i++) {
    if (sel[i] !== 1) continue;
    const sa = strokeAlpha[i];
    const p = i * 4;
    const a0 = pixels[p + 3] || 0;
    const na = clamp255(Math.round(sa));
    if (na > 0) {
      out[p + 3] = na;            // 更新 alpha（含边缘细化去锯齿）
      if (a0 <= 0) {
        // 新像素（原先为背景/无 RGB 数据）→ 就近洪泛取色
        const s = nearSrc[i];
        if (s >= 0) {
          out[p] = pixels[s * 4];
          out[p + 1] = pixels[s * 4 + 1];
          out[p + 2] = pixels[s * 4 + 2];
        }
      }
      // 原线像素（a0>0）：RGB 直通保持原色，只更新 alpha
    } else if (isSpeck[i]) {
      // 游离杂点：算法判定不在平滑线条上（na==0），且原为孤立小连通域 →
      // 连同 RGB 彻底清除，杜绝「线外游离像素杂点」残留。
      out[p + 3] = 0;
      out[p] = 0;
      out[p + 1] = 0;
      out[p + 2] = 0;
    }
    // na==0 且非杂点：不写，原值保留（主线/细线像素不会因边缘细化被误删成孔洞；背景保持）
  }

  return out.buffer;
}

// ================= 工具：有符号距离场（Felzenszwalb 精确欧氏 EDT） =================
function buildSignedDistance(lineMask: Uint8Array, sel: Uint8Array, w: number, h: number): Float64Array {
  const n = w * h;
  const fBg = new Float64Array(n);    // 种子=背景(0)，线内=INF → EDT=距最近背景
  const fLine = new Float64Array(n);  // 种子=线(0)，背景=INF → EDT=距最近线
  for (let i = 0; i < n; i++) {
    if (lineMask[i] && sel[i]) { fBg[i] = INF; fLine[i] = 0; }
    else { fBg[i] = 0; fLine[i] = INF; }
  }
  const dIn2 = edtSquared(fBg, w, h);
  const dLine2 = edtSquared(fLine, w, h);
  const sd = new Float64Array(n);
  const CAP = 1e6;
  for (let i = 0; i < n; i++) {
    if (lineMask[i] && sel[i]) {
      const d = Math.sqrt(dIn2[i]);
      sd[i] = d > CAP ? CAP : d;
    } else {
      const d = Math.sqrt(dLine2[i]);
      sd[i] = -(d > CAP ? CAP : d);
    }
  }
  return sd;
}

function edtSquared(f: Float64Array, w: number, h: number): Float64Array {
  const n = w * h;
  const d = new Float64Array(n);
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  // 列方向
  for (let x = 0; x < w; x++) {
    const fcol = new Float64Array(h);
    for (let y = 0; y < h; y++) fcol[y] = f[y * w + x];
    const dcol = new Float64Array(h);
    edt1D(fcol, dcol, h, v, z);
    for (let y = 0; y < h; y++) d[y * w + x] = dcol[y];
  }
  // 行方向
  for (let y = 0; y < h; y++) {
    const base = y * w;
    const frow = new Float64Array(w);
    for (let x = 0; x < w; x++) frow[x] = d[base + x];
    const drow = new Float64Array(w);
    edt1D(frow, drow, w, v, z);
    for (let x = 0; x < w; x++) d[base + x] = drow[x];
  }
  return d;
}

function edt1D(f: Float64Array, d: Float64Array, n: number, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dd = q - v[k];
    d[q] = dd * dd + f[v[k]];
  }
}

// ================= 工具：可分离高斯模糊（边界 renormalize） =================
function gaussianBlur(src: Float64Array, w: number, h: number, sigma: number): Float64Array {
  const kr = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float64Array(2 * kr + 1);
  let sum = 0;
  for (let k = -kr; k <= kr; k++) {
    const val = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + kr] = val;
    sum += val;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;

  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  // 水平
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0, wsum = 0;
      for (let k = -kr; k <= kr; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        const ww = kernel[k + kr];
        s += src[base + xx] * ww;
        wsum += ww;
      }
      tmp[base + x] = s / wsum;
    }
  }
  // 垂直
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0, wsum = 0;
      for (let k = -kr; k <= kr; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        const ww = kernel[k + kr];
        s += tmp[yy * w + x] * ww;
        wsum += ww;
      }
      out[y * w + x] = s / wsum;
    }
  }
  return out;
}

export const defaultLineSmoothParams: LineSmoothParams = {
  strength: 1,   // 平滑力度 100%
  radius: 8      // 平滑范围 8px
};

// ================= 工具：半径 r 二值开运算（去 rpx 边缘杂点/毛刺） =================
function binaryOpen(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const eroded = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
    const i = y * w + x;
    if (!src[i]) continue;
    let ok = 1;
    for (let dy = -r; dy <= r && ok; dy++) {
      const yy = y + dy;
      for (let dx = -r; dx <= r && ok; dx++) {
        if (!src[yy * w + (x + dx)]) { ok = 0; break; }
      }
    }
    eroded[i] = ok;
  }
  const opened = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
    const i = y * w + x;
    if (eroded[i]) { opened[i] = 1; continue; }
    let hit = 0;
    for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r && !hit; dx++) {
      if (eroded[(y + dy) * w + (x + dx)]) hit = 1;
    }
    opened[i] = hit;
  }
  return opened;
}
