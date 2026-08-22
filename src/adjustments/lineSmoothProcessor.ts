/*
 * lineSmoothProcessor.ts —— 「仅主线条」平滑算法（边缘平滑 · 主线条模式）
 *
 * 设计目标（产品需求）：
 *   1. 线条平滑后不变粗不变细（线宽硬约束）
 *   2. 不与原本线条 alpha 偏离太多（线内均值补偿，整体深浅保持）
 *   3. 毛刺感极大削弱（沿切线对称方向平滑：边缘/过渡带/核心）
 *   4. 反复描线极大削弱（沿切线方向磨平 alpha 波动）
 *   5. 平滑力度 = 平滑强度（混合比例/迭代次数），而非 alpha 提升量
 *
 * 管线（与 analysis/line_smooth_proto_v4.py 逐行对应）：
 *   Phase 1  方向场：结构张量（Sobel 梯度 + 7x7 高斯窗口）→ 每像素切线角
 *   Phase 2  沿切线各向异性平滑（迭代 N 次）：
 *              A. 核心（线内深度 >= coreDepth）：全采样(±1 垂直偏移)，
 *                 结果 max(sm, a0) —— 暗痕被周围亮痕拉亮、亮痕保持（非对称）
 *              B. 边缘带（线内深度 < coreDepth）：仅纯切线采样，
 *                 限制 [a_orig-25, a_orig+12]，保底 17（防缩线）
 *              C. 过渡带（线外距线 < radius+1）：仅纯切线采样，只降不升（防变粗）
 *   Phase 3  局部主体收敛（仅核心）：向沿切线窗口 P88 收敛，提升上限 maxBodyBoost
 *   Phase 4  碎点清理：线外孤立低 alpha 簇（面积<=12、距主线>1.2px）移除
 *   Phase 5  背景（alpha==0）绝对保持
 *
 * 注意：
 *   - 本文件为纯像素算法，不依赖 photoshop / UXP，可被 Node 直接单元测试。
 *   - 输入输出均为文档尺寸 RGBA（straight alpha），仅修改选区内像素。
 *   - RGB 直通色保持原值不变（透明度改变不影响颜色通道）。
 */

export interface LineSmoothParams {
  /** 平滑力度 0~1（UI 0-100%，默认 100 → 1）。控制迭代次数与主体收敛力度 */
  strength?: number;
  /** 平滑范围 px（UI 3~12，默认 8）。内部采样半径 = clamp(round(radius/2), 2, 6) */
  radius?: number;
}

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));
const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));

/** 欧氏距离变换（精确 8SSEDT，两遍扫描）。
 *  seeds=1 的像素 dist=0；其余像素得到到最近种子的欧氏距离（非平方）。
 *  复用/精简自 pencilAASmoothProcessor 的 edt8SSEDT。 */
function edtDistance(seeds: Uint8Array, width: number, height: number): Float32Array {
  const n = width * height;
  const dist2 = new Int32Array(n);
  const INF = 0x3fffffff;
  const seedX = new Int32Array(n);
  const seedY = new Int32Array(n);
  dist2.fill(INF);
  for (let i = 0; i < n; i++) {
    if (seeds[i] !== 0) {
      dist2[i] = 0;
      seedX[i] = i % width;
      seedY[i] = (i - seedX[i]) / width;
    }
  }
  const tryUpdate = (i: number, j: number, x: number, y: number) => {
    const dj = dist2[j];
    if (dj >= INF) return;
    const dx = x - seedX[j];
    const dy = y - seedY[j];
    const d2 = dx * dx + dy * dy;
    if (d2 < dist2[i]) {
      dist2[i] = d2;
      seedX[i] = seedX[j];
      seedY[i] = seedY[j];
    }
  };
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (dist2[i] === 0) continue;
      if (x > 0) tryUpdate(i, i - 1, x, y);
      if (x > 0 && y > 0) tryUpdate(i, i - width - 1, x, y);
      if (y > 0) tryUpdate(i, i - width, x, y);
      if (x + 1 < width && y > 0) tryUpdate(i, i - width + 1, x, y);
    }
  }
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
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.sqrt(dist2[i]);
  }
  return out;
}

/** 结构张量方向场：返回每像素切线角（弧度，[-pi/2, pi/2)）。 */
function structureTensorAngle(alpha: Float32Array, width: number, height: number, sigma = 2.0, win = 7): Float32Array {
  const n = width * height;
  // Sobel 梯度
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const p00 = alpha[i - width - 1], p10 = alpha[i - width], p20 = alpha[i - width + 1];
      const p01 = alpha[i - 1], p21 = alpha[i + 1];
      const p02 = alpha[i + width - 1], p12 = alpha[i + width], p22 = alpha[i + width + 1];
      gx[i] = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;
      gy[i] = -p00 - 2 * p10 - p20 + p02 + 2 * p12 + p22;
    }
  }
  // 高斯窗口（7x7, sigma=2）
  const half = (win - 1) / 2;
  const gaussW = new Float32Array(win);
  {
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      gaussW[k + half] = w;
      sum += w;
    }
    for (let k = 0; k < win; k++) gaussW[k] /= sum;
  }
  const Sxx = new Float32Array(n);
  const Syy = new Float32Array(n);
  const Sxy = new Float32Array(n);
  // 分离式高斯卷积（水平 → 垂直）
  const tmpSxx = new Float32Array(n), tmpSyy = new Float32Array(n), tmpSxy = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      let axx = 0, ayy = 0, axy = 0;
      for (let k = -half; k <= half; k++) {
        const xx = clampInt(x + k, 0, width - 1);
        const j = row + xx;
        const w = gaussW[k + half];
        axx += gx[j] * gx[j] * w;
        ayy += gy[j] * gy[j] * w;
        axy += gx[j] * gy[j] * w;
      }
      tmpSxx[i] = axx; tmpSyy[i] = ayy; tmpSxy[i] = axy;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      let axx = 0, ayy = 0, axy = 0;
      for (let k = -half; k <= half; k++) {
        const yy = clampInt(y + k, 0, height - 1);
        const j = yy * width + x;
        const w = gaussW[k + half];
        axx += tmpSxx[j] * w;
        ayy += tmpSyy[j] * w;
        axy += tmpSxy[j] * w;
      }
      Sxx[i] = axx; Syy[i] = ayy; Sxy[i] = axy;
    }
  }
  // 主方向角 φ = 0.5*atan2(2Sxy, Sxx-Syy)；切线 = φ + pi/2，归一化到 [-pi/2, pi/2)
  const tan = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const phi = 0.5 * Math.atan2(2 * Sxy[i], Sxx[i] - Syy[i]);
    let t = phi + Math.PI / 2;
    t = ((t % Math.PI) + Math.PI) % Math.PI - Math.PI / 2;
    tan[i] = t;
  }
  return tan;
}

/** 主入口：对文档尺寸 RGBA（straight alpha）做「仅主线条」平滑。 */
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
  const radius = clampInt(Math.round((typeof params.radius === 'number' ? params.radius : 8) / 2), 2, 6);

  // ---- 参数（v16：平滑力度 = 平滑强度，不提升 alpha） ----
  const THR = 16;            // 线条二值化阈值
  const CORE_DEPTH = 1.2;    // 核心深度阈值
  // 平滑力度映射：强度越高，沿切线方向的混合比例越大、迭代越多（真正的"平滑强度"）
  const ITERS = strength >= 0.5 ? 2 : 1;
  const MIX_IN = 0.2 + 0.3 * strength;   // 线内（核心/边缘带）平滑混合比例
  const MIX_OUT = 0.12 + 0.18 * strength; // 过渡带平滑混合比例（温和，防外扩）
  const W0 = 1.5;            // 核心中心权重（保真）

  // ---- 选区掩码（>0 视为可选）与线条掩码 ----
  const sel = new Uint8Array(pixelCount);
  const lineMask = new Uint8Array(pixelCount);
  const alpha = new Float32Array(pixelCount);
  let selCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if ((selRaw[i] || 0) > 0) { sel[i] = 1; selCount++; }
    const a = pixels[i * 4 + 3] || 0;
    alpha[i] = a;
    if (a > THR) lineMask[i] = 1;
  }
  if (selCount === 0) return out.buffer;

  // 距离场（scipy EDT 语义）
  const lineInv = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) lineInv[i] = lineMask[i] ? 0 : 1;
  const distOut = edtDistance(lineMask, width, height);   // 线外像素到线距离（线内=0）
  const distIn = edtDistance(lineInv, width, height);     // 线内深度（线外=0）

  // 方向场
  const tan = structureTensorAngle(alpha, width, height);

  // ---- 像素分类 ----
  const coreMask = new Uint8Array(pixelCount);
  const edgeMask = new Uint8Array(pixelCount);
  const outerMask = new Uint8Array(pixelCount);
  let pairCount = 0;
  const pairIdx = new Int32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (lineMask[i] === 1) {
      if (distIn[i] >= CORE_DEPTH) coreMask[i] = 1;
      else edgeMask[i] = 1;
    } else if (distOut[i] < radius + 1) {
      outerMask[i] = 1;
    }
    if (coreMask[i] || edgeMask[i] || outerMask[i]) pairIdx[pairCount++] = i;
  }

  // 采样权重（沿切线距离高斯）
  const sigmaD = Math.max(1.0, radius * 0.5);
  const distW = new Float32Array(radius + 1);
  for (let d = 0; d <= radius; d++) distW[d] = Math.exp(-(d * d) / (2 * sigmaD * sigmaD));

  // ---- Phase 2: 沿切线对称方向平滑（迭代） ----
  // 核心/边缘带：双向对称平滑（磨平波动），mix = MIX_IN
  // 过渡带：温和双向平滑（磨平边缘锯齿低点），mix = MIX_OUT
  const cur = new Float32Array(alpha);
  const nxt = new Float32Array(pixelCount);
  for (let it = 0; it < ITERS; it++) {
    nxt.set(cur);
    for (let p = 0; p < pairCount; p++) {
      const i = pairIdx[p];
      const inCore = coreMask[i] === 1;
      const inEdge = edgeMask[i] === 1;
      const a0 = cur[i];
      const cy = (i / width) | 0;
      const cx = i - cy * width;
      const t = tan[i];
      const tx = Math.cos(t), ty = Math.sin(t);
      const pxv = -ty, pyv = tx;
      let accW = inCore ? W0 : 1.6;
      let accA = a0 * accW;
      for (let d = 1; d <= radius; d++) {
        const offs = inCore ? [-1, 0, 1] : [0];
        for (let oi = 0; oi < offs.length; oi++) {
          const off = offs[oi];
          // 核心全采样；边缘/过渡带纯切线 + 0.5px 垂直偏移（防跨层）
          const x = cx + tx * d + pxv * off * (inCore ? 1.0 : 0.5);
          const y = cy + ty * d + pyv * off * (inCore ? 1.0 : 0.5);
          const xi = Math.round(x), yi = Math.round(y);
          if (xi < 0 || xi >= width || yi < 0 || yi >= height) continue;
          const j = yi * width + xi;
          const aj = cur[j];
          let wOff: number;
          if (inCore) {
            wOff = off === 0 ? 0.6 : (Math.abs(x - xi) + Math.abs(y - yi) < 0.4 ? 0.45 : 0.3);
          } else {
            wOff = 0.8;
          }
          const wt = distW[d] * wOff;
          accW += wt;
          accA += aj * wt;
        }
      }
      const sm = accA / accW;
      let nv = a0 + (sm - a0) * (inCore ? MIX_IN : MIX_OUT);
      if (inCore) {
        nxt[i] = nv;
      } else if (inEdge) {
        // 边缘带保底 17（防缩线）
        nxt[i] = nv < 17 ? 17 : nv;
      } else {
        // 过渡带温和双向
        nxt[i] = nv;
      }
    }
    cur.set(nxt);
  }

  // ---- Phase 3: 线内均值补偿（对称平滑的回归效应，整体深浅保持） ----
  {
    let sum0 = 0, sum1 = 0, cnt = 0;
    for (let i = 0; i < pixelCount; i++) {
      if (lineMask[i] === 1) {
        sum0 += alpha[i];
        sum1 += cur[i];
        cnt++;
      }
    }
    if (cnt > 0) {
      const offset = sum0 / cnt - sum1 / cnt;
      if (Math.abs(offset) > 0.5) {
        for (let i = 0; i < pixelCount; i++) {
          if (lineMask[i] === 1) {
            const v = cur[i] + offset;
            cur[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
          }
        }
      }
    }
  }

  // ---- Phase 3.5: 线宽硬约束（新增 >16 像素降回原值 → 不粗不细） ----
  for (let i = 0; i < pixelCount; i++) {
    if (cur[i] > THR && alpha[i] <= THR) cur[i] = alpha[i];
  }

  // ---- Phase 5: 写回（背景 alpha==0 绝对保持；RGB 直通色不变） ----
  for (let i = 0; i < pixelCount; i++) {
    if (sel[i] !== 1) continue;
    const a0 = alpha[i];
    if (a0 === 0) continue;   // 背景保持
    const af = Math.round(cur[i]);
    const p = i * 4;
    out[p + 3] = af < 0 ? 0 : (af > 255 ? 255 : af);
  }

  return out.buffer;
}

export const defaultLineSmoothParams: LineSmoothParams = {
  strength: 1,   // 平滑力度 100%
  radius: 8      // 平滑范围 8px（内部采样半径 4）
};
