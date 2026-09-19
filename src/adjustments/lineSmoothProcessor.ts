/*
 * lineSmoothProcessor.ts —— 「仅主线条」平滑算法（有符号距离场 · 主线条模式）
 *
 * 设计目标：
 *   1. 线宽基本保持 —— 对「有符号距离场(SDF)」做高斯平滑，宽线条几乎不收缩
 *                         （仅 <2σ 的细小毛刺被自然清理），无需再重建外边界
 *   2. 与原本线条 alpha 视觉不偏离 —— 主体密度 = 原 alpha 高斯模糊(抛光)，
 *                        并以中值归一保证整体明暗不偏
 *   3. 轮廓毛刺极大削弱 + 去锯齿 —— SDF 高斯平滑消除阶梯；重建时用带宽 band
 *                        （随 σ 档位缩放，细线不因带宽过宽而整体压暗）
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
 *   Phase A.5 原线连通域标注（8 连通分量 + 面积）→ 得到 isSpeck（面积开运算判据）
 *   Phase A  面积开运算（只剔除面积 < SPECK_MAX 的孤立杂点）+ 构建有符号距离场 sd
 *            （线内为正、线外为负；绝对精确欧氏距离 Felzenszwalb）+ 局部半宽 half
 *            —— sd/lineMask/half/密度覆盖 在一个「处理窗口」内计算；窗口 = 选区包围盒 + halo，
 *            窗口外的像素不参与、也不影响窗口内结果。选区只决定「哪些像素允许写回」。
 *            窗口必须比选区外扩 halo，否则选区边界处的线条会被当成断口，
 *            产生「选区边缘透明环」bug。
 *   Phase C 前置 多源 BFS：每个像素记录最近的原始线像素（供密度取值 + 取色 + σ 继承）
 *   Phase B 前置 逐像素自适应 σ：σ_i 取「以 i 为中心、半径 2σ 的窗口内存在内切半径 ≥ 1.8σ
 *            的线内像素」的最大档位，即 σ ≤ 0.56 × 该处结构线宽 —— 细线用小 σ，粗线仍用 σ_user
 *   Phase B  高斯平滑 sd（几何抛光，逐档；只有被用到的档位才卷积）+ 高斯平滑原 alpha
 *            （密度抛光，只对最高档生效——细线宽与 σBody 同量级，模糊只会把线外的 0 掺进来）
 *   Phase C  由 sd_blur 重建反锯齿覆盖 cov（决定平滑轮廓形状+抗锯齿），再乘密度：
 *            · 原线像素 → max(自身 alpha, 抛光密度)：边缘/笔压原样保留（幂等），
 *              只有内部被模糊抬升的低值噪点被抛光拉平（详见该节注释）
 *            · 原为背景/孔洞像素 → 用「最近原线像素的 alpha」作为密度，而非原始 alpha 的高斯光晕，
 *              避免线外因光晕泄漏产生游离杂点；同时平滑新增的边缘/内部孔洞得到干净填充
 *   Phase D  去杂点剪枝（只清孤立/单连接像素）
 *   Phase E.5 分量覆盖率判定（分辨「被 SDF 平滑的分量」与「SDF 失效的分量」）
 *   Phase E  写回（仅选区；原线 RGB 直通，背景绝对保持；被 SDF 判为线外且属于「已覆盖分量」
 *            或「小杂点分量」的原线像素连同 RGB 彻底清除；仅当某大连通域完全未被 SDF 覆盖
 *            —— 如极细线条 SDF 失效 —— 才保留原值，防止误删真实细线）
 *
 * 性能契约（本轮优化，行为不变，只改「算多少」与「怎么算」）：
 *   · 窗口化：只算「选区包围盒 + halo」。1000×1000 的选区放在 4000×4000 的文档里，
 *     原实现要遍历 16M 像素，现在只遍历 ~1.1M（窗口外扩 halo≤28）。
 *   · halo = 2·kr + 8（kr = ceil(3σ) ≤ 10）。被窗口边界截断的线条，其影响随高斯权重
 *     exp(-(halo-kr)²/2σ²) ≈ 1e-7 衰减，进入选区时已低于像素量化精度；距离场本身也不会
 *     因为「窗口外多了/少了边界」而变大（多出的边界只能让距离变小，被缩短的那部分
 *     同样落在 halo 带里）。这条是「不许按选区截断」的正确写法。
 *   · 全程 Float32 + 复用缓冲。原实现对 16M 像素要同时持有十几个 Float64Array
 *     （每个 128MB），光内存带宽与 GC 就足以让低配机器卡死。
 *   · 高斯卷积：内区免边界判断免归一化，垂直方向按行累加（原实现 x 外层 y 内层，
 *     跨行 stride 反复落 cache）；距离变换列方向按 64 列分块换取连续访问。
 *
 * 窗口化唯一的语义代价（实测已知、方向安全）：
 *   Phase E.5 的「分量覆盖率」是一个连通域级的统计量。窗口化后，跨窗口边界的连通域
 *   只能按「窗口内可见碎片」统计，与旧实现的全图统计会有出入（旧实现是按整个连通域
 *   一次判定，哪怕被判定的像素离统计来源很远）。因此当用户手动拉了一个部分选区、
 *   且选区附近有「细线接在粗线上」的连通域时，窗口边缘可能有极少量像素的
 *   「保留 / 清除」判定与旧实现不同。实测（合成线稿、含大量交叉细线）：
 *     · 选区 = 整张文档（无选区时自动全选，最常见路径）→ 窗口即整图，逐字节一致；
 *     · 选区 1000x1000 / 文档 1400x1400 → 差 0.01% 像素；
 *     · 选区 200x200 / 文档 600x600   → 差 0.28% 像素；
 *     · 极小选区（100x100）落在密集细线区 → 最多约 3% 像素。
 *   偏差方向恒为「新实现保留、旧实现清除」——即偏保守、不会误删画面内容。
 *   曾试过两种替代口径：覆盖率只统计选区内的分量（与旧实现差得更多）、
 *   把 halo 加到 96（只对部分场景有效且要额外 28% 耗时），故维持现状。
 */

export interface LineSmoothParams {
  /** 平滑力度 0~1（UI 0-100%，默认 100 → 1）。中轴重建的总闸门：0 = 完全不动（逐字节直通）。 */
  strength?: number;
  /** 曲率平滑 px（面板「曲率平滑」，UI 3~9，默认 8）。**中轴线**沿弧长被磨平到该尺度：
   *  比它短的弯曲抖动（描边抖、锯齿、小Ω）被抹掉，比它长的真实弯（C/S/I 型）原样保留。
   *  线性趋势（直线/匀弧）不受影响 —— 惩罚最小二乘只压二阶差。 */
  radius?: number;
  /**
   * 宽度平滑 px（面板「宽度平滑」，0 = 关闭，默认 250）。**沿弧长**把左右两条边界
   * 各自的半宽拉回自身的长波趋势（各自的 λ，两侧独立 ⇒ 单侧凸起只削该侧）。
   */
  flattenRadius?: number;
  /**
   * 不透明度平滑 px（面板「不透明度平滑」，0 = 关闭，默认 250）。**沿弧长**平滑横截面
   * 峰值不透明度 a(s)（笔压起伏），重建时整条横截面取同一个 a ⇒ 沿轴平滑、横向均匀。
   */
  opacityRadius?: number;
}

const THR = 16;                 // 线条二值化阈值
const SPECK_MAX = 10;           // 游离杂点判定：原线掩码中 8 连通域面积 < 该值 → 杂点（面积开运算的唯一判据）
const SIGMA_MIN = 0.5;          // 自适应 σ 下限（1px 线也落到这一档，只求不塌缩）
const SIGMA_MAX = 3.2;          // 自适应 σ 上限
const SIGMA_THICK_RATIO = 1.80; // 档位判据：窗口内存在 ≥ ratio·σ 的内切半径（等价线宽 ≥ 3.6σ，即安全口径 σ ≤ 0.56·线宽）
const SIGMA_WINDOW_RATIO = 2.00; // 判据窗口半径 = ratio·σ（必须 ≥ SIGMA_THICK_RATIO·σ - 0.5，粗线最外圈才够得着核心）
const BAND_LATTICE = 0.30;      // 抗锯齿过渡带宽(px)：格子尺度定值，不随 σ/radius 放大（理由见 Phase C 注释）
// ---- 中轴重建（V7）----
const MID_MAX = 700;            // 宽度平滑 / 不透明度平滑 的尺度上限(px)
const MID_MIN_AREA = 120;       // 小于该面积的分量不重建（没有可分辨的轴）
const MID_RIDGE_MIN_HALF = 1.0; // 脊线候选下限（half < 1 的像素在线外，不可能是轴点）
const MID_RIDGE_TOL = 0.35;     // 脊线 NMS 容差（离散 EDT 的帐篷峰逐像素量化，必须给容差才连成线）
const MID_OFFPATH_MAX = 0.30;   // 主干路径外的脊线占比上限：超过则判为分叉/网状 ⇒ 整体放弃重建
const MID_STEP = 1.0;           // 弧长重采样步长(px)
const MID_MAX_SAMPLES = 30000;  // 单分量采样点数上限（超长笔画时放大采样步长而不是截断）
const MID_PROBE_STEP = 0.5;     // 横向探测步长(px)
const MID_MIN_SAMPLES = 8;      // 采样点太少 ⇒ 没有可分辨的沿轴信号
const MID_HALO = 96;            // 开启重建时窗口额外外扩(px)：选区边缘处宽度/不透明度样本要够
const MID_TAPER_FRAC = 0.15;    // 端部回退长度上限 = 0.15·弧长
const MID_RIDGE_SCAN = 3;       // 主干覆盖率统计时「离路径 ≤ N px 视为在路径上」
const EDT_SENTINEL = 1e12;      // 1D 距离变换中「无穷」哨兵（只用于 z 轴比较，Float64）
const EDT_BLOCK = 64;           // 距离变换列分块宽度（缓存友好）
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
  const radius = clampInt(Math.round(typeof params.radius === 'number' ? params.radius : 8), 3, 9);
  // 三条**弧长域**平滑尺度（面板「曲率平滑 / 宽度平滑 / 不透明度平滑」）：
  //   · 曲率平滑 = 中轴线的弧长低通尺度（radius，3~9px，决定「描边抖动/小 Ω」被磨到多细）；
  //   · 宽度平滑 = 左右两侧半宽各自的弧长低通尺度（flattenRadius，0~700，0 = 不平滑）；
  //   · 不透明度平滑 = 横截面峰值 alpha 沿弧长的低通尺度（opacityRadius，0~700，0 = 不平滑）。
  // strength 是总闸门：0 ⇒ 整体直通（不重建），否则三条尺度按 strength 等比缩放。
  // 详见 rebuildMidAxis 头注。
  const flattenRadius = clampInt(Math.round(typeof params.flattenRadius === 'number' ? params.flattenRadius : 250), 0, MID_MAX);
  const opacityRadius = clampInt(Math.round(typeof params.opacityRadius === 'number' ? params.opacityRadius : 250), 0, MID_MAX);
  const midOn = strength > 0;

  // ---- 平滑力度 → 高斯 σ（用户上限） ----
  // σ 的最终取值由 Phase B 前置按「局部线宽」逐像素封顶（σ ≤ 0.40 × 线宽），
  // 这里的 sigma 是该上限的**天花板**：线宽足够的粗线才用得到它。
  const sigma = clamp(1.0 + strength * radius * 0.25, 0.8, SIGMA_MAX);
  const kernelRadius = Math.max(1, Math.ceil(3 * sigma)); // 几何抛光核半径（≤10）

  // ---- 选区包围盒（全图扫描一遍，只取极值，不落整张掩码） ----
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let rowAny = false;
    for (let x = 0; x < width; x++) {
      if (selRaw[row + x]) {
        rowAny = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    if (rowAny) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return out.buffer;

  // ---- 处理窗口：选区包围盒外扩 halo ----
  // halo 要盖住「高斯核能看到的范围」+「形态学前置清理改动的 2px」+「带宽」。
  // 见文件头性能契约：窗口外被截断的线条，其影响在进入选区前已衰减到量化精度以下。
  // 开启中轴重建时额外外扩 MID_HALO：弧长信号需要选区外足够长的样点，否则窗口边缘处
  // 样点突然消失 ⇒ 平滑量淡出 ⇒ 选区边界上出现宽度/不透明度台阶。
  const halo = Math.max(8, 2 * kernelRadius + 8, midOn ? MID_HALO : 0);
  const wx0 = Math.max(0, minX - halo);
  const wy0 = Math.max(0, minY - halo);
  const wx1 = Math.min(width, maxX + 1 + halo);
  const wy1 = Math.min(height, maxY + 1 + halo);
  const rw = Math.max(1, wx1 - wx0);
  const rh = Math.max(1, wy1 - wy0);
  const rn = rw * rh;

  // ---- 窗口内：选区掩码 + 原始线稿 alpha + 线条掩码（局部坐标） ----
  const sel = new Uint8Array(rn);
  const alpha = new Float32Array(rn);
  const lineMask = new Uint8Array(rn);
  let selCount = 0;
  for (let y = 0; y < rh; y++) {
    const gRow = (wy0 + y) * width + wx0;
    const lRow = y * rw;
    for (let x = 0; x < rw; x++) {
      const a = pixels[(gRow + x) * 4 + 3] || 0;
      alpha[lRow + x] = a;
      if (a > THR) lineMask[lRow + x] = 1;
      if (selRaw[gRow + x]) { sel[lRow + x] = 1; selCount++; }
    }
  }
  if (selCount === 0) return out.buffer;

  // ================= Phase A.5：原线连通域标注（面积 / 小杂点标记） =================
  // 对 lineMask 做 8 连通分量分析，记录每个原线像素所属的连通域 id 与面积。
  //   · area < SPECK_MAX 的分量 → isSpeck=1（铅笔屑/碎墨点/灰尘点，与主线条不连通）；
  //   · 大面积分量 → 可能是主线条，也可能是 SDF 无法覆盖的极细线条（见 Phase E.5）。
  // 这些分量信息用于写回阶段：被 SDF 判为线外(na==0)的原线像素，若属于「已被 SDF 覆盖的大
  // 分量」或「小杂点分量」，则连同 RGB 一并清零，避免线条被平滑变细后这些原值像素停留在
  // 近外部形成游离杂点。
  const isSpeck = new Uint8Array(rn);
  const lineCompId = new Int32Array(rn);
  const lineCompSize: number[] = [0]; // 0 占位，1-based
const lineCompBox: number[] = []; // 每分量 4 个数：minX,minY,maxX,maxY（局部坐标，1-based 对齐 compId）
  {
    const visited = new Uint8Array(rn);
    const stack = new Int32Array(rn);
    let compId = 0;
    for (let start = 0; start < rn; start++) {
      if (!lineMask[start] || visited[start]) continue;
      compId++;
      let head = 0, tail = 0;
      stack[tail++] = start;
      visited[start] = 1;
      const begin = tail - 1; // 该连通域在 stack 中的起点
      lineCompId[start] = compId;
      while (head < tail) {
        const cur = stack[head++];
        const cx = cur % rw;
        const cy = (cur - cx) / rw;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= rh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = cx + dx;
            if (xx < 0 || xx >= rw) continue;
            const nb = yy * rw + xx;
            if (lineMask[nb] && !visited[nb]) {
              visited[nb] = 1;
              lineCompId[nb] = compId;
              stack[tail++] = nb;
            }
          }
        }
      }
      const size = tail - begin;
      lineCompSize[compId] = size;
      // 中轴重建需要每个分量的包围盒；关闭时不统计（不给默认路径多加一遍 O(n) 扫描）
      if (midOn) {
        let cMinX = rw, cMinY = rh, cMaxX = -1, cMaxY = -1;
        for (let k = begin; k < tail; k++) {
          const p = stack[k];
          const px = p % rw;
          const py = (p - px) / rw;
          if (px < cMinX) cMinX = px;
          if (px > cMaxX) cMaxX = px;
          if (py < cMinY) cMinY = py;
          if (py > cMaxY) cMaxY = py;
        }
        lineCompBox.push(cMinX, cMinY, cMaxX, cMaxY);
      }
      if (size < SPECK_MAX) {
        for (let k = begin; k < tail; k++) isSpeck[stack[k]] = 1;
      }
    }
  }

  // ================= Phase A：面积开运算 + 有符号距离场 + 局部半宽 =================
  // 旧实现用「半径 2 开运算」做前置清理 —— 那是**按结构元宽度筛**的算子，等价于
  // 「线宽 < 5px 一律抹除」：细线因此不进入距离场（sd≡0 → cov≡0 → 输出逐字节无变化），
  // 而挂在粗实体上的细线又会被 Phase E.5 的连通域连坐整段清零。
  // 现改为**面积开运算**：只剔除面积 < SPECK_MAX 的孤立杂点分量（与 isSpeck 同一判据），
  // 线宽不再参与筛选，任何线宽的线都进入距离场。
  const lineMaskClean = new Uint8Array(rn);
  for (let i = 0; i < rn; i++) {
    if (lineMask[i] && !isSpeck[i]) lineMaskClean[i] = 1;
  }
  // half = 线内像素到最近背景的精确欧氏距离（≈ 内切圆半径），线宽 = 2·half。
  // 供 Phase B 前置的自适应 σ 使用：判据是「附近是否存在内切半径 ≥ 1.8σ 的线内像素」，
  // 即「该处结构是否撑得住这个 σ」——线宽 = 2·half。
  const half = new Float32Array(rn);
  // SDF 在整个窗口内连续计算（不按选区截断），保证选区边界两侧的距离场连续
  const sd = buildSignedDistance(lineMaskClean, rw, rh, half);
  // ================= Phase A.2：中轴重建（V7 核心） =================
  // 把线显式参数化为「一条中轴 + 弧长 s 上的三条 1D 信号」（半宽 L/R、峰值不透明度），
  // 各自在自己的 λ 上做惩罚最小二乘平滑后重建。详见 rebuildMidAxis 头注。
  // 输出两样东西：
  //   · sd  ← 重建后的有符号距离场（零等值线 = 平滑后的边界）；
  //   · aTgt/aValid ← 重建后的不透明度（沿轴平滑、横向均匀），Phase C 的密度源。
  // Phase B（σ 档位 / 高斯）与 Phase C/D/E 完全不改，只是"看到一个更干净的距离场"。
  const aTgt = midOn ? new Float32Array(rn) : null;
  const aValid = midOn ? new Uint8Array(rn) : null;
  const midCtx = midOn ? newMidCtx(rn) : null;
  if (midOn && aTgt && aValid && midCtx) {
    rebuildMidAxis(
      sd, half, alpha, lineCompId, lineCompSize, lineCompBox, rw, rh,
      radius, flattenRadius, opacityRadius, strength, kernelRadius,
      aTgt, aValid, midCtx
    );
  }

  // ================= Phase C 前置：多源 BFS，记录每个像素最近的原始线像素索引 =================
  // 用途：
  //   1) Phase C 为背景/孔洞像素提供「最近原始线 alpha」作为密度，避免用核心 medOrig 造成边缘黑杂点
  //   2) Phase E 为新增像素洪泛取 RGB 颜色
  //
  // 两个等价化处理（结果与「整幅窗口做无限制 BFS」逐像素一致）：
  //   · 限深：只有 cov>0 的像素才会用到近旁源，而 cov>0 意味着高斯核半径 kr 内存在一个
  //     原线像素（sd 为正只发生在原线像素上）；曼哈顿距离 ≤ √2·欧氏距离，故 BFS 只推进
  //     ceil(1.5·kr)+2 层即可覆盖全部「会被写出的像素」。层序推进保证受限范围内的赋值
  //     与无限制 BFS 完全相同；范围外的像素 cov 恒为 0，密度取什么值都不进入输出。
  //   · 缓冲四周各加一圈哨兵（预标记已访问）：邻居访问变成 4 次无判断、无取模的读写。
  const P = rw + 2;
  const nearSrc = new Int32Array(P * (rh + 2));
  nearSrc.fill(0); // 哨兵圈：0 表示「已访问」，不会被入队，也不会作为源被读取
  for (let y = 1; y <= rh; y++) {
    const rowBase = y * P;
    nearSrc.fill(-1, rowBase + 1, rowBase + 1 + rw);
  }
  const bfsQueue = new Int32Array(P * (rh + 2));
  let bfsHead = 0;
  let bfsTail = 0;
  for (let y = 0; y < rh; y++) {
    const lRow = y * rw;
    const pRow = (y + 1) * P + 1;
    for (let x = 0; x < rw; x++) {
      if (lineMaskClean[lRow + x] === 1) {
        nearSrc[pRow + x] = lRow + x;
        bfsQueue[bfsTail++] = pRow + x;
      }
    }
  }
  const BFS_MAX_DEPTH = Math.ceil(kernelRadius * 1.5) + 2;
  for (let depth = 0; depth < BFS_MAX_DEPTH && bfsHead < bfsTail; depth++) {
    const levelEnd = bfsTail;
    while (bfsHead < levelEnd) {
      const cur = bfsQueue[bfsHead++];
      const src = nearSrc[cur];
      let nb = cur - 1;
      if (nearSrc[nb] < 0) { nearSrc[nb] = src; bfsQueue[bfsTail++] = nb; }
      nb = cur + 1;
      if (nearSrc[nb] < 0) { nearSrc[nb] = src; bfsQueue[bfsTail++] = nb; }
      nb = cur - P;
      if (nearSrc[nb] < 0) { nearSrc[nb] = src; bfsQueue[bfsTail++] = nb; }
      nb = cur + P;
      if (nearSrc[nb] < 0) { nearSrc[nb] = src; bfsQueue[bfsTail++] = nb; }
    }
  }

  // ================= Phase B 前置：按「局部线宽」为每个像素选 σ 档 =================
  // σ 不取全局值，而是**逐像素**取一个「该处结构强度撑得住」的档位：
  //     σ_i = 满足「以 i 为中心、半径 SIGMA_WINDOW_RATIO·σ 的窗口内存在内切半径 ≥ SIGMA_THICK_RATIO·σ 的线内像素」
  //           的最大档位，否则取最低档。
  // 理由（2026-09-18 诊断）：σ = 3.0 与 3~5px 细线半宽同量级，sd 剖面（3px 为 [1,2,1]）经高斯
  // 卷积后中心变负 → cov ≡ 0 → 该像素被判为线外并清除。纯数学必然，只能让 σ 随结构尺寸收缩。
  // 实测安全口径 σ ≤ 0.40 × 线宽（T 形 3px：σ≤1.3 → 100%，σ1.6 → 33%，σ2.0 → 0%）——这是
  // 「不塌缩」的底线；下面 ratio=1.8 是更强的「不内移」口径（σ ≤ 0.56×线宽），理由见 Phase B 后注。
  //
  // ⚠️ 判据不能用「像素自身的 half」：任何形状的边界像素到背景都只有 1px，粗线边缘会被误判成
  // 细线、σ 被压到最低档 → 高斯核不再跨过边缘 → 平滑能力整体失效（实测粗线锯齿的改动量掉到 1/4：
  // 3104→880 像素、平均Δα 53.2→2.9）。所以必须问「**附近有没有足够粗的结构**」，
  // 而不是「这个像素自己离边界多近」——粗线边缘的问法答案为"有"（0.5σ 内就有更深的内部像素），
  // 细线的答案为"没有"。
  //
  // ⚠️ 但窗口半径不能太小：粗线边界像素要够得着「内切半径 ≥ 1.8σ」的核心区，需要
  // R ≥ 1.8σ - 0.5（核心区距边界像素 1.8σ-0.5，粗线越宽越远），故 SIGMA_WINDOW_RATIO = 2.0。
  // 1.5σ 的旧窗口会让 12px 以上粗线的边缘掉档 → 边缘与内部用不同 σ → 边缘出现档位跳变。
  //
  // 逐像素而非逐连通域：T 形（细线挂在粗横杠上）属同一连通域，按分量取最大线宽会把 σ 拉到粗杠的
  // 值，细线照样塌缩；逐像素/逐窗口才能让细段用小 σ、粗段保持大 σ。
  //
  // 档位只保留 3~4 档（小核档的高斯更便宜），每档各做一次可分离高斯，再按像素取用。
  // 线宽 ≥ 3.6·σ_user = 10.8px（默认参数）落在最高档；更细的线自动降档，
  // 保证「高斯卷积后 zero-crossing 不内移」——半宽 h、σ 的条带，零交点内移量
  // δ = h - σ·t（t 由 2φ(t)+t(2Φ(t)-1) = h/σ 定）：h/σ=1.33 时 δ≈0.33σ（显著内移），
  // h/σ≥1.75 时 δ≤0.02σ（≈0.06px，可忽略）。
  const sigmaLevels: number[] = [];
  {
    const fracs = [1, 0.66, 0.44];
    for (const f of fracs) {
      const v = clamp(sigma * f, SIGMA_MIN, SIGMA_MAX);
      if (!sigmaLevels.some((x) => Math.abs(x - v) < 1e-3)) sigmaLevels.push(v);
    }
    if (!sigmaLevels.some((x) => Math.abs(x - SIGMA_MIN) < 1e-3)) sigmaLevels.push(SIGMA_MIN);
    sigmaLevels.sort((a, b) => b - a); // 降序：索引 0 = 最大 σ
  }
  const lastLevel = sigmaLevels.length - 1;
  // 抗锯齿过渡带宽 = **格子尺度定值**，不能随 σ 或 radius 放大（2026-09-18 二次诊断）：
  // 任何形状的「掩码最外圈像素」，其 sd 恒为 1，而高斯模糊后的 sdB 恒为 ≈0.5 ——
  // 这是因为它的邻居里必然有一个背景像素(sd=-1)，加权平均后被拉到 0.5 附近（实测
  // 7px 掩码 σ1.98 时为 0.503、宽线 σ3.0 时为 0.567，与 σ 基本无关）。
  // 于是 cov = smoothstep(sdB/band)：band=1.04 时 cov≈0.46~0.57，最外圈每轮被乘一次
  // 系数 <1 的衰减 —— 掩码几何每轮完全相同 ⇒ cov 完全相同 ⇒ 纯等比衰减 ⇒ **棘轮**：
  // 128→104→85→69→56→…，跌破 THR=16 后离开掩码，下一圈成为新的最外圈继续衰减
  // ⇒ 线条逐次变细、最终断裂。band 取格子尺度 0.30 时 cov(sdB=0.5)=smoothstep(1.67)=1，
  // 最外圈完整保留；同时「轮廓真被切到的像素」(sdB∈(-0.3,0.3)) 仍拿到部分值 → 抗锯齿不减。
  const bands = sigmaLevels.map(() => BAND_LATTICE);
  // 逐档求「窗口内是否存在 half ≥ SIGMA_THICK_RATIO·σ 的线内像素」：用积分图把窗口存在性查询
  // 压成 4 次查表，档位再少也是 O(档数 · n)，不随窗口半径增长。
  const sigmaIdx = new Uint8Array(rn);
  {
    const stride = rw + 1;
    const S = new Int32Array(stride * (rh + 1));
    const flag = new Uint8Array(rn);
    for (let i = 0; i < rn; i++) sigmaIdx[i] = lastLevel;
    for (let k = 0; k < sigmaLevels.length; k++) {
      const h = SIGMA_THICK_RATIO * sigmaLevels[k];
      const R = Math.max(1, Math.ceil(SIGMA_WINDOW_RATIO * sigmaLevels[k]));
      for (let y = 0; y < rh; y++) {
        const row = y * rw;
        const cur = (y + 1) * stride;
        const prev = y * stride;
        let run = 0;
        for (let x = 0; x < rw; x++) {
          if (half[row + x] >= h) run++;
          S[cur + x + 1] = S[prev + x + 1] + run;
        }
      }
      const r0 = Math.min(R, rh - 1);
      const c0 = Math.min(R, rw - 1);
      for (let y = 0; y < rh; y++) {
        const y0 = y - r0 < 0 ? 0 : y - r0;
        const y1 = y + r0 + 1 > rh ? rh : y + r0 + 1;
        const row = y * rw;
        const sTop = y0 * stride;
        const sBot = y1 * stride;
        for (let x = 0; x < rw; x++) {
          if (flag[row + x]) continue;               // 已落到更大档，无需再判
          const x0 = x - c0 < 0 ? 0 : x - c0;
          const x1 = x + c0 + 1 > rw ? rw : x + c0 + 1;
          if (S[sBot + x1] - S[sTop + x1] - S[sBot + x0] + S[sTop + x0] > 0) {
            flag[row + x] = 1;
            sigmaIdx[row + x] = k;                    // 首个命中的档位即最大可用档
          }
        }
      }
    }
  }

  // ================= Phase B：几何 + 密度抛光（逐档高斯） =================
  // 只有被用到的档位才做卷积（例如画面全是大色块时只有最高档一次）。
  // 密度抛光（alpha 高斯）只对**最高档**生效：非最高档处 σBody 与线宽同量级，
  // 高斯会把线外的 0 掺进来（结构衰减），再经中值归一放大就把中不透明度的细线整体
  // 提亮（实测 α150 的 3px 线被抬到 186）。细线直接沿用原密度，既省一次卷积也更准。
  const scratch = new Float32Array(rn);
  const scratch2 = new Float32Array(rn);
  const sdB = new Float32Array(rn);
  const bodyBlur = new Float32Array(rn);
  {
    const tmpSd = new Float32Array(rn);
    const tmpBody = new Float32Array(rn);
    const tmpMask = new Float32Array(rn);
    const mf = new Float32Array(rn);
    const used = new Uint8Array(sigmaLevels.length);
    for (let i = 0; i < rn; i++) used[sigmaIdx[i]] = 1;
    for (let k = 0; k < sigmaLevels.length; k++) {
      if (!used[k]) continue;
      const sig = sigmaLevels[k];
      const sigBody = clamp(sig * 0.55, 0.7, radius);
      const polish = k === 0;
      gaussianBlur(sd, rw, rh, sig, scratch, tmpSd);
      if (polish) {
        // 掩码归一：bodyBlur = blur(alpha·m)/blur(m)。alpha 在离线处恰为 0，故 blur(alpha·m) ≡ blur(alpha)，
        // 只需再算一次 blur(m)。边缘处 blur(m)<1 ⇒ 除回来即得「只对线内像素取的邻域均值」，
        // 与线性无关地**自动消除「把线外的 0 掺进来」的边缘压暗**（这正是 max(α,抛光) 当年要兜的底），
        // 同时把抛光从「单向」变成「对称」（谷抬升、峰下降）⇒ 逐遍幂等。
        // ⚠️ 不要退回 max(α, 抛光)：max 单向 ⇒ 实测 img1 反复施加 +7.8%（本分支贡献 +148394/15987/−562）。
        // ⚠️ 也不要用解析近似 blur(m)≈Φ(sd/σBody) 省这一次卷积：曲率处 sdB<sd ⇒ w 高估 ⇒ 逐遍 −1.67%，
        //    远不如精确卷积的 −0.09%。故改用 gaussianBlurPair 合并两通道，代价 +5%（而非两次卷积的 +10%）。
        for (let i = 0; i < rn; i++) mf[i] = lineMaskClean[i] ? 1 : 0;
        gaussianBlurPair(alpha, mf, rw, rh, sigBody, scratch, scratch2, tmpBody, tmpMask);
      }
      for (let i = 0; i < rn; i++) {
        if (sigmaIdx[i] !== k) continue;
        sdB[i] = tmpSd[i];
        bodyBlur[i] = polish
          ? (tmpMask[i] > 0.02 ? tmpBody[i] / tmpMask[i] : alpha[i])
          : alpha[i];
      }
    }
  }

  // 主体密度中值归一：保证整体明暗不偏离原线
  // （不收集样本、不排序：alpha 是 0~255 整数，256 档直方图即精确；
  //   bodyBlur 是浮点，用「三级直方图」逐级把中位所在区间收窄到 1/65536，
  //   与「收集后整体排序取 vals[len>>1]」的差别在 1e-5 量级 —— 折算到
  //   bodyScale 是相对 4e-8，不足以翻转任何一个像素的量化结果）
  let medOrig = 0, medBlur = 0;
  {
    const histO = new Int32Array(256);
    let cnt = 0;
    for (let i = 0; i < rn; i++) {
      if (!lineMaskClean[i] || !sel[i]) continue;
      const ao = alpha[i] | 0;
      histO[ao > 255 ? 255 : ao]++;
      cnt++;
    }
    if (cnt) {
      medOrig = histMedian(histO, cnt) || 1;
      medBlur = floatMedianRefined(bodyBlur, lineMaskClean, sel, rn, cnt) || 1;
    }
  }
  const bodyScale = medBlur > 1 ? clamp(medOrig / medBlur, 0.8, 1.3) : 1;

  // ================= Phase C：重建反锯齿覆盖 =================
  // 阈值 T=0：宽线条边界在 SDF 高斯后基本不动（独立边缘），细毛刺自然收缩。
  // cov 决定平滑轮廓形状与抗锯齿软边；密度分支消除「线外游离杂点」：
  //   原线像素(alpha>THR)        保留抛光后的真实密度（笔压深浅）；
  //   背景/孔洞/平滑新增像素     用「最近原线像素的 alpha」作为密度，而非核心 medOrig，
  //                            避免把核心深色密度硬套到边界灰阶像素，产生黑色杂点。
  const T = 0;
  const strokeAlpha = new Float32Array(rn);
  for (let y = 0; y < rh; y++) {
    const lRow = y * rw;
    const pRow = (y + 1) * P + 1;
    for (let x = 0; x < rw; x++) {
      const i = lRow + x;
      const cov = smoothstep((sdB[i] - T) / bands[sigmaIdx[i]]);   // 0..1 覆盖（边界软过渡→抗锯齿）
      // 密度：三选一
      //   ① 中轴重建覆盖到的像素（aValid=1）→ 取重建后的沿轴平滑不透明度 aTgt。
      //      整条横截面同一个值 ⇒ **横向均匀**；沿弧长已被惩罚最小二乘平滑 ⇒ 沿轴平缓。
      //      「峰 RMS / 峰跳 / 二阶」三项的收益全部来自这里（img1：RMS 5.00→3.87、跳 7.0→1.6、二阶 14.5→6.2）。
      //      ⚠️ 试过两种「保横向剖面」的改法，都不可行，勿重蹈：
      //        · 乘性 `alpha × (aTgt/ap)`：ap 是**沿中轴法向**探测到的横截面峰值，而行峰值是**沿行**取的，
      //          真实笔触上二者根本不是同一条线（斜切/分叉处尤甚），ap 自身噪声 (σ≈22/均值134) 被注回输出，
      //          峰 RMS 反而劣化到 6.81（比输入 6.00 还差）。
      //        · 加性 `alpha + (aTgt − ap)`：同样受上面这条「两条线不同」的限制，峰 RMS 6.14。
      //      横向均匀化是刻意的代价：软笔触的浅灰宽翼会被拉平到该处的沿轴包络值。
      //   ② 原线像素（重建未覆盖，如端帽、被判定为分叉而放弃的分量）→ 掩码归一的邻域均值 bodyBlur。
      //      bodyBlur = blur(alpha)/blur(mask)：边缘处自动除回 ⇒ 无「掺入线外 0」的边缘压暗
      //      （旧写法用 max(α, 抛光密度) 兜底，硬边 12px 线最外圈 255→158 的衰减源由此消除，
      //        实测 12px 硬边连点 12 次 -15.2% → 0.0%；掩码归一后同样为 0.0%）。
      //      ⚠️ 但绝不可回退成 max：max 是单向的（谷抬升、峰不下降），这就是保墨化之后残留的棘轮主因。
      //   ③ 非原线像素 → 用最近原线 alpha，避免核心深色密度硬套到边界灰阶像素。
      let density: number;
      if (aValid !== null && aValid[i] === 1) {
        density = aTgt![i];
      } else if (alpha[i] > THR) {
        // ⚠️ 不要改回 `max(alpha[i], bodyBlur·bodyScale)`：max 是**单向**的（谷被抬高、峰不下降），
        //    实测 img1 反复施加时该分支贡献 +148394/15987/−562 的净加墨，是保墨后残留的棘轮主因。
        //    bodyBlur 现为「掩码归一的邻域均值」，本身已无边缘压暗（不必再用 max 兜底），
        //    且是**对称**的平滑（谷抬升、峰下降）⇒ 逐遍幂等。
        const bd = bodyBlur[i] * bodyScale;
        density = bd > 0 ? (bd < 255 ? bd : 255) : alpha[i];
      } else {
        const s = nearSrc[pRow + x];
        density = s >= 0 ? alpha[s] : 0;
      }
      let v = cov * density;
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      strokeAlpha[i] = v;
    }
  }

  // ================= Phase D：去杂点剪枝（保守，只清孤立/单连接像素） =================
  // 目标：消除 SDF 平滑后仍残留的 1px 线外黑尖/杂点，同时不伤害连续边缘。
  // 规则（二者满足其一即剪枝）：
  //   A) 输出 alpha>THR，但在 8 邻域内输出也>THR 的邻居 ≤1 个 → 孤立像素；
  //   B) 输出 alpha>THR，但 8 邻域内没有任何原线像素(alpha>THR) → 完全游离。
  // 「实际最终输出 alpha」：选区内=平滑结果，选区外=原值（写回不会动选区外像素）。
  // 邻居判定必须用它：若用 strokeAlpha 判选区外邻居，会把「选区外实际保留的原线」
  // 当成空邻居，导致选区边缘像素被误清（透明环 bug 的另一半成因）。
  // 窗口内、选区外仍属于「窗口」，其原值同样可直接读 alpha。
  const cleaned = new Float32Array(rn);
  cleaned.set(strokeAlpha);
  for (let y = 1; y < rh - 1; y++) for (let x = 1; x < rw - 1; x++) {
    const i = y * rw + x;
    if (sel[i] !== 1) continue;
    if (strokeAlpha[i] <= THR) continue;
    let lineNbr = 0, origNbr = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const j0 = i + dy * rw;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const j = j0 + dx;
        if (sel[j] === 1 ? strokeAlpha[j] > THR : alpha[j] > THR) lineNbr++;
        if (alpha[j] > THR) origNbr++;
      }
    }
    if (lineNbr <= 1 || origNbr === 0) cleaned[i] = 0;
  }
  strokeAlpha.set(cleaned);

  // ================= Phase E.5：分量级覆盖判定（区分「被平滑的大分量」与「SDF 失效的细线」） =================
  // 对每个原线连通域统计：总像素数 cnt、其中被 SDF 平滑覆盖(输出 na>0)的像素数 hit。
  // 覆盖率 cov = hit / cnt。判定：
  //   · cov >= COVER_MIN → 该分量确实被 SDF 平滑处理（线条变细是其正常结果）。此时分量内
  //     任何「原线像素但输出 na==0」的像素，只是被平滑推到线外的残留，写回时连同 RGB 清零，
  //     杜绝线条变细后近外部的游离杂点。
  //   · cov <  COVER_MIN → 该分量几乎完全未被 SDF 覆盖，最可能是极细线条(线宽 < 2σ)导致 SDF
  //     平滑后整体塌缩、本应保留却全部 na==0。此时「na==0 保留原值」以保全真实线条，避免误删。
  const COVER_MIN = 0.25;
  const compHits = new Float32Array(lineCompSize.length);
  const compCnts = new Float32Array(lineCompSize.length);
  // 覆盖率按整个窗口内的分量统计（衡量 SDF 对整个线条分量的处理效果），不按选区截断
  for (let i = 0; i < rn; i++) {
    const cid = lineCompId[i];
    if (cid <= 0) continue;
    compCnts[cid]++;
    if (strokeAlpha[i] > 0) compHits[cid]++;
  }
  const compCovered = new Uint8Array(lineCompSize.length);
  for (let cid = 1; cid < lineCompSize.length; cid++) {
    if (compCnts[cid] > 0 && compHits[cid] / compCnts[cid] >= COVER_MIN) compCovered[cid] = 1;
  }

  // ================= Phase E（写回）：原线直通 / 杂点清零 / 背景保持 =================
  // 只遍历选区包围盒，且只写 sel 像素；窗口外像素不会进入这里。
  for (let y = minY; y <= maxY; y++) {
    const gRow = y * width;
    const ly = y - wy0;
    const lRowBase = ly * rw - wx0;
    const pRowBase = (ly + 1) * P + 1 - wx0;
    for (let x = minX; x <= maxX; x++) {
      const i = lRowBase + x;
      if (sel[i] !== 1) continue;
      const sa = strokeAlpha[i];
      const p = (gRow + x) * 4;
      const a0 = pixels[p + 3] || 0;
      const na = clamp255(Math.round(sa));
      if (na > 0) {
        out[p + 3] = na;            // 更新 alpha（含边缘细化去锯齿）
        if (a0 <= 0) {
          // 新像素（原先为背景/无 RGB 数据）→ 就近洪泛取色
          // nearSrc 存的是「窗口内局部索引」（带哨兵圈寻址），取色要换算回全图坐标
          const s = nearSrc[pRowBase + x];
          if (s >= 0) {
            const sy = (s / rw) | 0;
            const sx = s - sy * rw;
            const sp = ((wy0 + sy) * width + (wx0 + sx)) * 4;
            out[p] = pixels[sp];
            out[p + 1] = pixels[sp + 1];
            out[p + 2] = pixels[sp + 2];
          }
        }
        // 原线像素（a0>0）：RGB 直通保持原色，只更新 alpha
      } else {
        // na==0：输出判定该像素在线外（被平滑移除 / 残留 / 杂点）
        const cid = lineCompId[i];
        // 仅当「属于小杂点分量」或「属于已被 SDF 覆盖的大分量」时才考虑清除：
        // 这两种情况 na==0 的残留都是应被平滑掉、不该保留在原位的像素（含线条变细后
        // 停留在近外部的游离杂点）。
        // 否则（大分量但完全未被 SDF 覆盖，极细线情况）保留原值，避免误删真实细线。
        let cleared = false;
        if (isSpeck[i] || (cid > 0 && compCovered[cid])) {
          // 额外守卫：若该 na==0 原线像素被「输出>0 的像素」完全包围，则说明它位于新线条
          // 内部（被平滑后留下的 1px 孔洞），此时保留原值，避免在线条内部误开洞。
          // 仅当它在 8 邻域内至少存在一个「背景空位(na==0)」才视为外观残留 → 清除。
          let hasEmptyNbr = false;
          const lx = x - wx0;
          const ly = y - wy0;
          for (let dy = -1; dy <= 1 && !hasEmptyNbr; dy++) {
            const yy = ly + dy;
            if (yy < 0 || yy >= rh) continue;
            const j0 = i + dy * rw;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const xx = lx + dx;
              if (xx < 0 || xx >= rw) continue;
              const j = j0 + dx;
              if ((sel[j] === 1 ? strokeAlpha[j] : alpha[j]) <= 0) { hasEmptyNbr = true; break; }
            }
          }
          if (hasEmptyNbr) {
            out[p + 3] = 0;
            out[p] = 0;
            out[p + 1] = 0;
            out[p + 2] = 0;
            cleared = true;
          }
        }
        // 亚阈值淡边残留（仅中轴重建开启时；强度=0 时整体直通，与旧版逐字节一致）：
        // 原始 alpha ≤ THR 的边缘像素**不属于任何连通域**（线掩码要求 alpha > THR），
        // 上面那条规则按 cid 找它们永远够不到。轮廓被重建内推后，这些软边像素留在原处、
        // 与新墨之间拉开空隙 ⇒ 变成孤立淡点（实测 alpha≈10，缩放到 1000% 就是一个可见的
        // 浅灰小方块 —— 用户截图即此现象）。两条判据都满足才清：
        //   ① 8 邻域里存在「已被 SDF 实际处理(compCovered)的连通域」像素 —— 否则属极细线
        //      保护区（覆盖率 < COVER_MIN，线条被整体保留），一律不动；
        //   ② 8 邻域里没有任何「输出墨」(输出 alpha > 0) —— 紧贴新轮廓的淡边是正常抗锯齿
        //      过渡，必须保留；只有被新墨丢下的孤立碎片才清。
        if (!cleared && midOn && a0 > 0 && a0 <= THR) {
          const lx2 = x - wx0;
          const ly2 = y - wy0;
          let nearCovered = false, hasInk = false;
          for (let dy = -1; dy <= 1 && !hasInk; dy++) {
            const yy2 = ly2 + dy;
            if (yy2 < 0 || yy2 >= rh) continue;
            const j0 = i + dy * rw;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const xx2 = lx2 + dx;
              if (xx2 < 0 || xx2 >= rw) continue;
              const j = j0 + dx;
              const cj = lineCompId[j];
              if (cj > 0 && compCovered[cj]) nearCovered = true;
              if ((sel[j] === 1 ? strokeAlpha[j] : alpha[j]) > 0) { hasInk = true; break; }
            }
          }
          if (nearCovered && !hasInk) {
            out[p + 3] = 0;
            out[p] = 0;
            out[p + 1] = 0;
            out[p + 2] = 0;
          }
        }
        // 其余 na==0 情况：不写，原值保留（背景保持 / SDF 失效的细线保持 / 线条内部孔洞保持）
      }
    }
  }

  return out.buffer;
}

/** 直方图中位数（与「收集后排序取 vals[len>>1]」同口径：上中位数） */
function histMedian(hist: Int32Array, total: number): number {
  const target = total >> 1;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > target) return v;
  }
  return 255;
}

/*
  浮点中位数（上中位数，与「排序后取 vals[total>>1]」同口径）。
  做法：每级把当前候选区间等分成 256 档，数出中位落在哪一档，把区间收窄到该档；
  三级之后区间宽度 = 256/256³ = 1/65536，取区间中点即为中位数。
  无需收集样本、无需排序、无需额外缓冲，且分辨率远超像素量化精度。
*/
function floatMedianRefined(
  values: Float32Array,
  maskA: Uint8Array,
  maskB: Uint8Array,
  n: number,
  total: number
): number {
  let lo = 0;
  let hi = 256;              // bodyBlur 是 alpha 的归一卷积，值域必落在 [0,255]
  let rank = total >> 1;     // 目标元素在当前区间内的序号
  for (let level = 0; level < 3; level++) {
    const hist = new Int32Array(256);
    const span = hi - lo;
    const scale = 256 / span;
    for (let i = 0; i < n; i++) {
      if (!maskA[i] || !maskB[i]) continue;
      const v = values[i];
      if (v < lo || v >= hi) continue;
      let b = ((v - lo) * scale) | 0;
      if (b < 0) b = 0;
      else if (b > 255) b = 255;
      hist[b]++;
    }
    let acc = 0;
    let bin = 255;
    for (let b = 0; b < 256; b++) {
      if (acc + hist[b] > rank) { bin = b; break; }
      acc += hist[b];
    }
    rank -= acc;
    lo = lo + span * bin / 256;
    hi = lo + span / 256;
  }
  return (lo + hi) * 0.5;
}

// ================= 工具：有符号距离场（Felzenszwalb 精确欧氏 EDT） =================
// 在「处理窗口」内计算：窗口边界若参与「线内/线外」判定，会把被窗口截断的线条
// 当成断口，边界处 sd 变负 → cov=0 → 写回阶段误删边缘一圈像素。
// 多出的（截断产生的）边界只会让距离变小、不会变大，且误差高度局限于窗口边界附近，
// 由 halo 距离保证其在选区内衰减到量化精度以下。
// `outHalf`（可选）：线内像素到最近背景的精确欧氏距离 ≈ 该点处的内切圆半径，
// 即「局部线宽 = 2·half」。这是同一次 EDT 的副产品（dIn2 已是距最近背景的平方距离），
// 不额外增加变换开销。供 Phase B 前置的逐像素自适应 σ 使用。
function buildSignedDistance(lineMask: Uint8Array, w: number, h: number, outHalf?: Float32Array): Float32Array {
  const n = w * h;
  // 不可达标记：必须远大于任何真实平方距离（w²+h²），同时保持在 float32 整数精度内
  const INF2 = Math.max(1e6, 4 * (w * w + h * h));
  const fBg = new Float32Array(n);    // 种子=背景(0)，线内=INF2 → EDT=距最近背景
  const fLine = new Float32Array(n);  // 种子=线(0)，背景=INF2 → EDT=距最近线
  for (let i = 0; i < n; i++) {
    if (lineMask[i]) { fBg[i] = INF2; fLine[i] = 0; }
    else { fBg[i] = 0; fLine[i] = INF2; }
  }
  const maxDim = Math.max(w, h);
  const ws: EdtWorkspace = {
    bufIn: new Float32Array(EDT_BLOCK * maxDim),
    bufOut: new Float32Array(EDT_BLOCK * maxDim),
    v: new Int32Array(maxDim),
    z: new Float64Array(maxDim + 1)
  };
  const dIn2 = new Float32Array(n);
  const dLine2 = new Float32Array(n);
  edtSquaredInto(fBg, w, h, dIn2, ws);
  edtSquaredInto(fLine, w, h, dLine2, ws);
  const sd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (lineMask[i]) {
      const d = Math.sqrt(dIn2[i]);
      sd[i] = d;
      if (outHalf) outHalf[i] = d;
    } else {
      sd[i] = -Math.sqrt(dLine2[i]);
    }
  }
  return sd;
}

interface EdtWorkspace {
  bufIn: Float32Array;
  bufOut: Float32Array;
  v: Int32Array;
  z: Float64Array;
}

/*
  二维精确欧氏距离平方变换（可分离：先列后行，各做一次一维下包络扫描）。
  列方向按 EDT_BLOCK 列分块再转置进连续缓冲：原实现逐列 y 方向 stride 访问，
  每读一个元素跨一整行（4KB），百万像素级全是 cache/TLB miss。
  分块之内再按 EDT_TILE 行分段，使「同一批 32 行的 cache line 被整块的列反复复用」，
  两侧访问各自连续。
*/
const EDT_TILE = 32;

function edtSquaredInto(src: Float32Array, w: number, h: number, dst: Float32Array, ws: EdtWorkspace): void {
  const { bufIn, bufOut, v, z } = ws;
  // ---- 列方向 ----
  for (let x0 = 0; x0 < w; x0 += EDT_BLOCK) {
    const cw = Math.min(EDT_BLOCK, w - x0);
    for (let cy = 0; cy < h; cy += EDT_TILE) {
      const cyEnd = Math.min(h, cy + EDT_TILE);
      for (let c = 0; c < cw; c++) {
        let sPtr = cy * w + x0 + c;
        let dPtr = c * h + cy;
        for (let y = cy; y < cyEnd; y++, sPtr += w, dPtr++) bufIn[dPtr] = src[sPtr];
      }
    }
    for (let c = 0; c < cw; c++) edt1D(bufIn, c * h, bufOut, c * h, h, v, z);
    for (let cy = 0; cy < h; cy += EDT_TILE) {
      const cyEnd = Math.min(h, cy + EDT_TILE);
      for (let c = 0; c < cw; c++) {
        let sPtr = c * h + cy;
        let dPtr = cy * w + x0 + c;
        for (let y = cy; y < cyEnd; y++, sPtr++, dPtr += w) dst[dPtr] = bufOut[sPtr];
      }
    }
  }
  // ---- 行方向（本身连续） ----
  for (let y0 = 0; y0 < h; y0 += EDT_BLOCK) {
    const bh = Math.min(EDT_BLOCK, h - y0);
    for (let r = 0; r < bh; r++) {
      const base = (y0 + r) * w;
      edt1D(dst, base, bufOut, r * w, w, v, z);
    }
    for (let r = 0; r < bh; r++) {
      const base = (y0 + r) * w;
      dst.set(bufOut.subarray(r * w, (r + 1) * w), base);
    }
  }
}

// 一维下包络（parabola lower envelope）距离变换；fin/dout 必须是不同缓冲
function edt1D(f: Float32Array, fo: number, d: Float32Array, dobj: number, n: number, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0; z[0] = -EDT_SENTINEL; z[1] = EDT_SENTINEL;
  for (let q = 1; q < n; q++) {
    const fq = f[fo + q] + q * q;
    let s = (fq - (f[fo + v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    while (s <= z[k]) {
      k--;
      s = (fq - (f[fo + v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = EDT_SENTINEL;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dd = q - v[k];
    d[dobj + q] = dd * dd + f[fo + v[k]];
  }
}

// ================= Phase A.2（V7）：中轴重建 =================
/*
  为什么换表征（2026-09-19 定量诊断，原始数据见 analysis/line_vis/_diag_arc_onesided.txt）：
  V5 的「宽度拉平」把弧长近似成**包围盒长轴**：修正量 = H1(宽度场) − H2(其低通)，是横截面内
  的标量、直接偏置 sd ⇒ 两侧同量平移。三个后果全部实测到（合成 C 弧 + 外径侧 3 处 8px 凸起）：
    ① 同一个 8px 凸起，θ=0°（弧顶）时 79% 的修正落在凸起侧、θ=±32° 时 92% 落在**对侧**
       ⇒ 轮廓左右乱窜 = 用户看到的三个 Ω；
    ② Δ 两侧同量 ⇒ 平缓的对侧被一起吃进 4.31px；
    ③ 沿轴完全没有不透明度平滑（密度抛光是对 α 做各向同性高斯，σBody≤1.8px）⇒ 峰 RMS 由
       3.97 升到 4.20（反而变差）。
  根因是同一件事：**「沿笔轴」这个维度从来没有被真正参数化过**。所以这里换表征，不再调参。

  新表征：一条线 = 1 条中轴 + 弧长 s 上的 3 条 1D 信号
      c(s)          中轴点（曲率平滑：对 x(s)、y(s) 各做二阶差分惩罚最小二乘 ⇒ 直线与匀弧
                    （一次/二次趋势）**逐值不变**，只有短于 λ 的弯曲抖动被抹掉）
      wL(s), wR(s)  左右两条边界各自的半宽（宽度平滑：各自独立 λ ⇒ 单侧凸起只削该侧）
      a(s)          横截面峰值不透明度（不透明度平滑：λ 直接就是「多长的笔压起伏被抹掉」）

  重建：对落在中轴带内的像素 p，取它到中轴的**有符号横向偏移 u**（按 +N 侧定符号），
      sd_tgt(p) = (u ≥ 0) ? ŵR(s) − u : u + ŵL(s)
  ⇒ 零等值线精确落在 |u| = ŵ 处（边界位置精确）；内部取值是真实距离的**上界**，而
    cov = smoothstep(sd/band) 在 sd ≫ band 处饱和，故内部取值偏差不进输出。
      密度直接取 ã(s)：整条横截面同值 ⇒ 横向均匀（补内部空隙、消横向墨量起伏），
      沿弧长已被平滑 ⇒ 沿轴平缓（峰 RMS / 峰跳 / 不透明度断崖三项的来源）。
      ⚠️ sd_tgt 是**逐像素按它自己那一侧的半宽**算的 ⇒ 两侧解耦是精确的，不是近似补偿。

  为什么这才叫「无限趋近最终平滑」：c / wL / wR / a 各自只受自己的 λ 控制，λ 增大时单调收敛到
  「中轴是二次以下曲线 + 两侧半宽各自单值」。三个尺度互相独立，不再此消彼长（V6 的失败方式）。

  已知边界（有意为之，不是 bug）：
  · 分叉 / 网状 / 环形分量（主干路径外的脊线比例 > MID_OFFPATH_MAX）⇒ 整体放弃重建、保持原样；
  · 两端 MID_TAPER 内按权重退回原始 sd —— 端帽/笔尖的本来形状不被切平；
  · 横截面被均匀化（取峰值 ã）—— 这正是「补充内部缺失空隙」所需；需要柔和横截面时
    用「消除锯齿 → 柔化宽度」单独处理；
  · 只改编 compId 属于本分量或背景的像素，绝不碰邻线。
*/

interface MidCtx {
  chanI: Int32Array;    // 像素 → 采样点序号
  chanU: Float32Array;  // 像素 → 有符号横向偏移 u（chanK=1 时有效）
  chanK: Uint8Array;    // 0=未覆盖 1=在中轴带内
  touched: Int32Array;  // 本分量写过的像素（用于局部清零）
  ridge: Uint8Array;    // 脊线标记
  dist: Int32Array;     // BFS 距离
  par: Int32Array;      // BFS 父节点
  queue: Int32Array;    // BFS 队列
  pix: Int32Array;      // 脊线像素列表
  path: Int32Array;     // 主干路径像素
  sx: Float32Array;     // 采样点坐标（脊线重采样后，索引空间）
  sy: Float32Array;
  cxs: Float32Array;    // 曲率平滑后的采样点坐标
  cys: Float32Array;
  wl: Float32Array;     // 实测左半宽
  wr: Float32Array;     // 实测右半宽
  ap: Float32Array;     // 实测横截面峰值 alpha
  mp: Float32Array;     // 实测横截面「保墨平均」alpha（密度源）
  tl: Float32Array;     // 平滑后左半宽
  tr: Float32Array;     // 平滑后右半宽
  ta: Float32Array;     // 平滑后峰值 alpha
  plx: Float32Array;    // 实测左边界点（绝对坐标）
  ply: Float32Array;
  prx: Float32Array;    // 实测右边界点
  pry: Float32Array;
  slx: Float32Array;    // 平滑后左边界点
  sly: Float32Array;
  srx: Float32Array;    // 平滑后右边界点
  sry: Float32Array;
  ang: Float32Array;    // 切角域平滑工作区：段切角 φ_i / 平滑后 φ̃_i
  sang: Float32Array;
  seg: Float32Array;    // 段长 |p_{i+1} − p_i|
  cum: Float64Array;    // 前缀弧长（去重域；等距重采样与回投都用它）
  rsx: Float32Array;    // 去重后的边界折线（等距重采样的输入）
  rsy: Float32Array;
  qax: Float32Array;    // 等距重采样点（切角平滑的域）
  qay: Float32Array;
  phj: Float32Array;    // 等距域原始切角 φ_j
  phk: Float32Array;    // 回投到去重采样点的平滑切角 φ̃_k
  ipx: Float32Array;    // 积分重建后的去重采样点坐标
  ipy: Float32Array;
  mapR: Int32Array;     // 原始索引 i → 去重索引（同参数化回填用）
  pw0: Float64Array;    // 惩罚最小二乘工作区：对角 / 次对角1 / 次对角2（就地 LDLᵀ）
  pw1: Float64Array;
  pw2: Float64Array;
  pwZ: Float64Array;
  pwW: Float64Array;
}

function newMidCtx(rn: number): MidCtx {
  const S = MID_MAX_SAMPLES;
  return {
    chanI: new Int32Array(rn),
    chanU: new Float32Array(rn),
    chanK: new Uint8Array(rn),
    touched: new Int32Array(rn),
    ridge: new Uint8Array(rn),
    dist: new Int32Array(rn),
    par: new Int32Array(rn),
    queue: new Int32Array(rn),
    pix: new Int32Array(rn),
    path: new Int32Array(rn),
    sx: new Float32Array(S), sy: new Float32Array(S),
    cxs: new Float32Array(S), cys: new Float32Array(S),
    wl: new Float32Array(S), wr: new Float32Array(S), ap: new Float32Array(S), mp: new Float32Array(S),
    tl: new Float32Array(S), tr: new Float32Array(S), ta: new Float32Array(S),
    plx: new Float32Array(S), ply: new Float32Array(S),
    prx: new Float32Array(S), pry: new Float32Array(S),
    slx: new Float32Array(S), sly: new Float32Array(S),
    srx: new Float32Array(S), sry: new Float32Array(S),
    ang: new Float32Array(S), sang: new Float32Array(S), seg: new Float32Array(S),
    cum: new Float64Array(S), rsx: new Float32Array(S), rsy: new Float32Array(S),
    qax: new Float32Array(S), qay: new Float32Array(S),
    phj: new Float32Array(S), phk: new Float32Array(S),
    ipx: new Float32Array(S), ipy: new Float32Array(S),
    mapR: new Int32Array(S),
    pw0: new Float64Array(S), pw1: new Float64Array(S), pw2: new Float64Array(S),
    pwZ: new Float64Array(S), pwW: new Float64Array(S)
  };
}

function rebuildMidAxis(
  sd: Float32Array,
  half: Float32Array,
  alpha: Float32Array,
  compId: Int32Array,
  compSize: number[],
  compBox: number[],
  rw: number,
  rh: number,
  radiusPx: number,
  flatPx: number,
  opacPx: number,
  strength: number,
  kernelRadius: number,
  aTgt: Float32Array,
  aValid: Uint8Array,
  ctx: MidCtx
): void {
  const nComp = compSize.length - 1;
  // λ 语义：二阶差分惩罚的增益 g(ω) = 1 / (1 + λ·(4sin²(ω/2))²)，小 ω 下 ≈ 1/(1+λω⁴)
  // ⇒ 半增益角频率 ω_c = λ^(−1/4) ⇒ 令半增益**波长** = L(px)：λ = (L/2π)⁴。
  const lamOf = (px: number): number => {
    const s = px * strength;
    if (s <= 0.5) return 0;
    const k = s / (Math.PI * 2);
    return k * k * k * k;
  };
  const lamC = lamOf(radiusPx);
  const lamW = lamOf(flatPx);
  const lamA = lamOf(opacPx);
  // 轮廓平滑的合尺度：两个惩罚最小二乘级联 ≈ ω⁴ 域相加 ⇒ λ 直接相加
  // （「曲率平滑」管细尺度毛刺/锯齿，「宽度平滑」管沿轴粗细波浪/单侧凸起，同一条边界上的两级尺度）
  const lamOutline = lamC + lamW;
  const padBand = 3 * kernelRadius + 6;    // 中轴带相对平滑后边界的额外外扩

  const chanI = ctx.chanI, chanU = ctx.chanU, chanK = ctx.chanK, touched = ctx.touched;
  const ridge = ctx.ridge, dist = ctx.dist, par = ctx.par, queue = ctx.queue;
  const pix = ctx.pix, path = ctx.path;
  const sx = ctx.sx, sy = ctx.sy, cxs = ctx.cxs, cys = ctx.cys;
  const wl = ctx.wl, wr = ctx.wr, ap = ctx.ap, mp = ctx.mp, tl = ctx.tl, tr = ctx.tr, ta = ctx.ta;
  const plx = ctx.plx, ply = ctx.ply, prx = ctx.prx, pry = ctx.pry;
  const slx = ctx.slx, sly = ctx.sly, srx = ctx.srx, sry = ctx.sry;

  for (let c = 1; c <= nComp; c++) {
    if ((compSize[c] || 0) < MID_MIN_AREA) continue;
    const o = (c - 1) * 4;
    const bx0 = compBox[o], by0 = compBox[o + 1], bx1 = compBox[o + 2], by1 = compBox[o + 3];

    let maxHalf = 0;
    for (let y = by0; y <= by1; y++) {
      const row = y * rw;
      for (let x = bx0; x <= bx1; x++) {
        if (compId[row + x] !== c) continue;
        const h = half[row + x];
        if (h > maxHalf) maxHalf = h;
      }
    }
    if (maxHalf < 0.9) continue;

    // ---- ① 脊线：half 沿其梯度方向的非极大抑制 ----------------------------------
    // half 是「线内到最近背景的精确欧氏距离」，其梯度指向轴心（half 增大方向），
    // 故脊线上的像素满足 half[p] ≥ half[p + ĝ]（沿梯度再走 1px 不再变大）。
    // 离散 EDT 的帐篷峰逐像素量化，必须给容差 MID_RIDGE_TOL 才能连成一条脊线；
    // 容差不会把非脊线拉进来（非脊线处 |∇half|≈1 ⇒ 条件差 ~1，远大于容差）。
    let nR = 0;
    for (let y = by0; y <= by1; y++) {
      const row = y * rw;
      for (let x = bx0; x <= bx1; x++) {
        const i = row + x;
        if (compId[i] !== c) continue;
        if (half[i] < MID_RIDGE_MIN_HALF) continue;
        let isR = false;
        if (x <= 0 || y <= 0 || x >= rw - 1 || y >= rh - 1) {
          isR = true;
        } else {
          const gx = half[i + 1] - half[i - 1];
          const gy = half[i + rw] - half[i - rw];
          const gm = Math.sqrt(gx * gx + gy * gy);
          if (gm < 1e-4) isR = true;
          else isR = half[i] >= sampleBilinear(half, rw, rh, x + gx / gm, y + gy / gm) - MID_RIDGE_TOL;
        }
        if (isR) { ridge[i] = 1; pix[nR++] = i; }
      }
    }

    let ok = nR >= MID_MIN_SAMPLES;
    let nS = 0;
    let totalLen = 0;
    let rStep = MID_STEP;
    let pathLen = 0;

    if (ok) {
      // ---- ② 脊线连通域：取最大者（其余是小刺/毛边），再在其中求图直径 = 主干 ----
      let label = 0, bestStart = -1, bestSize = -1;
      for (let k = 0; k < nR; k++) dist[pix[k]] = 0;
      for (let k = 0; k < nR; k++) {
        const s0 = pix[k];
        if (dist[s0] !== 0) continue;
        label++;
        let head = 0, tail = 0, cnt = 0;
        queue[tail++] = s0; dist[s0] = label;
        while (head < tail) {
          const cur = queue[head++]; cnt++;
          const cx0 = cur % rw, cy0 = (cur - cx0) / rw;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = cy0 + dy;
            if (yy < by0 || yy > by1) continue;
            const j0 = yy * rw;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nb = j0 + cx0 + dx;
              if (ridge[nb] !== 1 || dist[nb] !== 0) continue;
              dist[nb] = label; queue[tail++] = nb;
            }
          }
        }
        if (cnt > bestSize) { bestSize = cnt; bestStart = s0; }
      }
      ok = bestSize >= MID_MIN_SAMPLES;

      if (ok) {
        // 两次 BFS 求直径两端，回溯出主干路径
        const bfsFar = (start: number): number => {
          let head = 0, tail = 0, far = start, farD = 0;
          for (let k = 0; k < nR; k++) { dist[pix[k]] = -1; par[pix[k]] = -1; }
          dist[start] = 0; queue[tail++] = start;
          while (head < tail) {
            const cur = queue[head++];
            const cd = dist[cur];
            if (cd > farD) { farD = cd; far = cur; }
            const cx0 = cur % rw, cy0 = (cur - cx0) / rw;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = cy0 + dy;
              if (yy < by0 || yy > by1) continue;
              const j0 = yy * rw;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nb = j0 + cx0 + dx;
                if (ridge[nb] !== 1 || dist[nb] !== -1) continue;
                dist[nb] = cd + 1; par[nb] = cur; queue[tail++] = nb;
              }
            }
          }
          return far;
        };
        const e1 = bfsFar(bestStart);
        const e2 = bfsFar(e1);
        pathLen = 0;
        const pathCap = rw * rh;
        for (let p = e2; p !== -1 && pathLen < pathCap; p = par[p]) path[pathLen++] = p;

        // ---- ③ 分叉判据：离主干 > MID_RIDGE_SCAN 的脊线像素占比 ----
        let reach = 0;
        {
          let head = 0, tail = 0;
          for (let k = 0; k < nR; k++) dist[pix[k]] = -1;
          for (let k = 0; k < pathLen; k++) {
            const p = path[k];
            if (dist[p] === -1) { dist[p] = 0; queue[tail++] = p; }
          }
          while (head < tail) {
            const cur = queue[head++];
            const cd = dist[cur];
            reach++;
            if (cd >= MID_RIDGE_SCAN) continue;
            const cx0 = cur % rw, cy0 = (cur - cx0) / rw;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = cy0 + dy;
              if (yy < by0 || yy > by1) continue;
              const j0 = yy * rw;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nb = j0 + cx0 + dx;
                if (ridge[nb] !== 1 || dist[nb] !== -1) continue;
                dist[nb] = cd + 1; queue[tail++] = nb;
              }
            }
          }
        }
        ok = bestSize > 0 && (bestSize - reach) <= MID_OFFPATH_MAX * bestSize;
      }

      // ---- ④ 弧长重采样（等距；步长自适应以保证采样点数不爆） ----
      if (ok) {
        rStep = MID_STEP;
        if (pathLen / rStep > MID_MAX_SAMPLES) rStep = pathLen / MID_MAX_SAMPLES;
        let px0 = path[0] % rw, py0 = (path[0] - px0) / rw;
        sx[0] = px0; sy[0] = py0;
        let si = 1, nextS = rStep, acc = 0;
        for (let k = 1; k < pathLen && si < MID_MAX_SAMPLES; k++) {
          const p = path[k];
          const qx = p % rw, qy = (p - qx) / rw;
          const ddx = qx - px0, ddy = qy - py0;
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          const d0 = acc; acc += d;
          while (si < MID_MAX_SAMPLES && nextS <= acc) {
            const t = d > 1e-6 ? (nextS - d0) / d : 0;
            sx[si] = px0 + (qx - px0) * t; sy[si] = py0 + (qy - py0) * t;
            si++; nextS = si * rStep;
          }
          px0 = qx; py0 = qy;
        }
        nS = si;
        totalLen = (nS - 1) * rStep;
        ok = nS >= MID_MIN_SAMPLES;
      }

      // ---- ⑤ 曲率平滑：c(s) 的两个分量各自惩罚最小二乘（一次/二次趋势逐值不变） ----
      if (ok) {
        penalizedSmooth(sx, nS, lamC, cxs, ctx.pw0, ctx.pw1, ctx.pw2, ctx.pwZ, ctx.pwW);
        penalizedSmooth(sy, nS, lamC, cys, ctx.pw0, ctx.pw1, ctx.pw2, ctx.pwZ, ctx.pwW);
      }

      // ---- ⑥ 法向探测取「两条边界点」→ 各自沿弧长平滑 → 新中轴 / 新法向 / 新半宽 ----
      // ⚠️ 必须平滑**边界点本身（绝对坐标）**，不能只平滑「相对中轴的半宽」。
      // 理由：单侧凸起会把中轴（脊线）朝另一侧推 Δw/2 —— 而脊线的定义就是与两侧等距，
      // 从被推走的中轴量出的两条半宽**仍然相等** ⇒ 凸起会从「宽度」变成「中轴位移」而存活下来，
      // 重建时两侧一起动（实测 Δ内 +2.0 / Δ外 −2.0，削平率只有 68%）。
      // 改平滑绝对边界点后，凸起只出现在它自己那条边界上，另一条边界原样不变 ⇒ 两侧彻底解耦。
      // 新中轴取两条平滑边界的中线 ⇒ 与「中轴该在哪」这个病态问题无关（不需要判断凸起属于哪一侧）。
      if (ok) {
        /*
          探测半径只允许「局部尺度」的余量，不得用大常数外扩。
          ⚠️ 曾经是 `maxHalf + (3·kernelRadius+14)`（≈ maxHalf+41px）⇒ 实际探测深度
          `maxHalf + 41`，对 C 弧这类弯曲笔画，沿法向走 50~60px 会**打到笔画自身另一侧**，
          于是 ap[i] = pk 取到的是「法向 ±57px 窗口内的最大 alpha」，而不是本横截面的峰值。
          该值再经 penalizedSmooth 回填成全带密度 ⇒ 形成「峰值单调抬升」的正反馈：
          实测 img1 反复施加 flat0 时行峰均值 +5.5% → +8.2% → +10.1% → +14.5%，墨量 +7.5% → +18.2%。
          半高交点必然落在局部半宽之内，故 1.4×maxHalf + 4 足够，且不会越界到其它笔画/自身对侧。
        */
        const probe = 1.4 * maxHalf + 4;
        let nValid = 0;
        for (let i = 0; i < nS; i++) {
          const ia = i - 2 < 0 ? 0 : i - 2;
          const ib = i + 2 >= nS ? nS - 1 : i + 2;
          let txv = cxs[ib] - cxs[ia], tyv = cys[ib] - cys[ia];
          if (txv === 0 && tyv === 0) txv = 1;
          const tlen = Math.sqrt(txv * txv + tyv * tyv);
          const nxv = -tyv / tlen, nyv = txv / tlen;
          const cx0 = cxs[i], cy0 = cys[i];
          let pk = -1, sum = 0;
          for (let t = -probe; t <= probe; t += MID_PROBE_STEP) {
            const v = sampleBilinear(alpha, rw, rh, cx0 + nxv * t, cy0 + nyv * t);
            if (v > pk) pk = v;
            if (v > 1) sum += v;   // 横截面墨量积分（支撑内 alpha>1 的采样和，乘步长即面积）
          }
          if (pk <= THR || pk <= 0) { wl[i] = -1; wr[i] = -1; ap[i] = -1; mp[i] = -1; continue; }
          // 半高交点必须做**线性插值**：只取步进点会把边界系统性内缩最多半步，
          // 每跑一次线宽就少一点 ⇒ 连点棘轮（实测不插值时单次墨量漂移 ~1.5%）。
          const halfPk = pk * 0.5;
          let tR = 0;
          {
            let tPrev = 0;
            let vPrev = sampleBilinear(alpha, rw, rh, cx0, cy0);
            for (let t = MID_PROBE_STEP; t <= probe; t += MID_PROBE_STEP) {
              const v = sampleBilinear(alpha, rw, rh, cx0 + nxv * t, cy0 + nyv * t);
              if (v < halfPk) {
                tR = vPrev > v ? tPrev + MID_PROBE_STEP * (vPrev - halfPk) / (vPrev - v) : tPrev;
                break;
              }
              tPrev = t; vPrev = v;
            }
            if (tR === 0) tR = tPrev;
          }
          let tL = 0;
          {
            let tPrev = 0;
            let vPrev = sampleBilinear(alpha, rw, rh, cx0, cy0);
            for (let t = -MID_PROBE_STEP; t >= -probe; t -= MID_PROBE_STEP) {
              const v = sampleBilinear(alpha, rw, rh, cx0 + nxv * t, cy0 + nyv * t);
              if (v < halfPk) {
                tL = vPrev > v ? tPrev - MID_PROBE_STEP * (vPrev - halfPk) / (vPrev - v) : tPrev;
                break;
              }
              tPrev = t; vPrev = v;
            }
            if (tL === 0) tL = tPrev;
          }
          // 有效性判据：50% 交点必须落在探测半径**内部**。落在边缘说明整条法向上都没掉到半高
          // （轴心跑到墨外 / 峰值取到极低的噪声），此时 tR/tL 会饱和到 probe，产生 20~57px 的假宽度。
          // 实测粗线（宽 32px）只有两端 29/630 个站位饱和，但这一点垃圾会被弧长积分**扩散到整条曲线**，
          // 把 Σ(tl+tr)/Σ(wl+wr) 压到 0.7234（整体半宽 −27.7%）。故必须在这里判无效。
          if (tR >= probe - MID_PROBE_STEP || -tL >= probe - MID_PROBE_STEP) {
            wl[i] = -1; wr[i] = -1; ap[i] = -1; mp[i] = -1; continue;
          }
          wl[i] = tL < 0 ? -tL : 0;
          wr[i] = tR > 0 ? tR : 0;
          ap[i] = pk;
          /*
            保墨密度源：mp =（横截面 alpha 积分）/（实测 50% 宽度 wl+wr）。
            输出横截面 ≈「高 ta、半宽 wSide(≈wl/wr)、cov 软过渡 0.3px」的方波，其墨量
            恰为 ta·(wl+wr)（smoothstep 过渡带的面积补偿正好抵消半宽外扩，见 ⑦ sdT 注释）。
            ⇒ 令 mp = 输入墨量/(wl+wr)，则输出横截面墨量 = 输入横截面墨量 ⇒ **逐遍幂等**。
            ⚠️ 不要改回「峰值 ap」：峰值作密度源 ⇒ 每个横截面都被抬到自己的峰值（只升不降），
               实测 img1 反复施加 +8.87% → +4.86% → +1.34%，且 93% 的增量落在内部 [64,127] 像素上
               （边界仅 +24854/357393），是连点棘轮的唯一主因。
          */
          const wsum = wl[i] + wr[i];
          mp[i] = wsum > 1e-3 ? sum * MID_PROBE_STEP / wsum : pk;
          nValid++;
        }
        ok = nValid >= MID_MIN_SAMPLES;
        if (ok) {
          // 无效采样（轴心落在墨外）用最近的有效值补，避免出现假宽度浪尖
          let lastGood = -1;
          for (let i = 0; i < nS; i++) {
            if (wl[i] >= 0) lastGood = i;
            else if (lastGood >= 0) { wl[i] = wl[lastGood]; wr[i] = wr[lastGood]; ap[i] = ap[lastGood]; mp[i] = mp[lastGood]; }
          }
          lastGood = -1;
          for (let i = nS - 1; i >= 0; i--) {
            if (wl[i] >= 0) lastGood = i;
            else if (lastGood >= 0) { wl[i] = wl[lastGood]; wr[i] = wr[lastGood]; ap[i] = ap[lastGood]; mp[i] = mp[lastGood]; }
          }
          // 6a：把「轴心 ± 法向 × 半宽」还原成两条边界点的绝对坐标
          for (let i = 0; i < nS; i++) {
            const ia = i - 2 < 0 ? 0 : i - 2;
            const ib = i + 2 >= nS ? nS - 1 : i + 2;
            let txv = cxs[ib] - cxs[ia], tyv = cys[ib] - cys[ia];
            if (txv === 0 && tyv === 0) txv = 1;
            const tlen = Math.sqrt(txv * txv + tyv * tyv);
            const nxv = -tyv / tlen, nyv = txv / tlen;
            plx[i] = cxs[i] - nxv * wl[i]; ply[i] = cys[i] - nyv * wl[i];
            prx[i] = cxs[i] + nxv * wr[i]; pry[i] = cys[i] + nyv * wr[i];
          }
          // 6b：左右边界各自沿弧长做惩罚最小二乘，λ = 曲率平滑 ⊕ 宽度平滑。
          // ⚠️ 必须在**切角域**做，不能在位置域做（见 penalizedSmoothPathAngle 头注的推导）。
          penalizedSmoothPathAngle(plx, ply, nS, lamOutline, slx, sly, ctx);
          penalizedSmoothPathAngle(prx, pry, nS, lamOutline, srx, sry, ctx);
          // 6c：新中轴 = 两条平滑边界的中线（这一步让"凸起属于哪一侧"不再是必须回答的问题）
          for (let i = 0; i < nS; i++) { cxs[i] = (slx[i] + srx[i]) * 0.5; cys[i] = (sly[i] + sry[i]) * 0.5; }
          // 6d：新法向由新中轴切线垂向给出（第 ⑦ 步成带要用）；半宽**直接取两条平滑边界点的距离之半**。
          // ⚠️ 不要改回「在新中轴法向上做投影」的写法：6c 已把新中轴取为两条边界的中线，于是
          //    hl = −((sl−cx)·n) 与 hr = ((sr−cx)·n) **数学上恒等**（这点无法通过"左右独立"绕开），
          //    且在法向翻转/中线扭曲处两者会**一起**塌到下限 0.35 —— 实测半宽在 0.35~40.5 之间乱跳
          //    （真值恒 16），是粗线（32px）被削细 21% 的直接原因。
          //    直接取两点距离：无符号问题，且左右不对称（锥形/斜切笔触）照样保留 —— 它体现在**中轴位置**里。
          for (let i = 0; i < nS; i++) {
            const bx = srx[i] - slx[i], by = sry[i] - sly[i];
            let bw = Math.sqrt(bx * bx + by * by) * 0.5;
            if (!(bw >= 0.35)) bw = 0.35;
            tl[i] = bw; tr[i] = bw;
          }
          penalizedSmooth(mp, nS, lamA, ta, ctx.pw0, ctx.pw1, ctx.pw2, ctx.pwZ, ctx.pwW);
          for (let i = 0; i < nS; i++) {
            if (!(ta[i] >= 0)) ta[i] = 0;
            else if (ta[i] > 255) ta[i] = 255;
          }
          /*
            ⑧ 「首要不伤害」护栏：若重建后的半宽相对**实测半宽**偏离过大，就整段放弃重建（保留原样）。
            为什么需要：两条边界是**各自独立**做切角域平滑的，各自还有自己的相似变换缩放系数 sc。
            当折线锯齿很重（Σ|Δp| 远大于弦长）时 sc 会明显偏离 1，且左右两条边界偏得不一样 ⇒
            两条边界的相对间距被改变 ⇒ 重建把笔画局部削细甚至削穿。
            实测：img1 反复施加 flat450 时第 3 遍整段中上部分被抹掉（域 1→4、墨量 −24%）。
            阈值取得很松（偏离 > 50% 才计一次，且要有 35% 以上的采样越界才放弃），
            正常平滑（C 弧削平 8px 凸起 = 宽度变化 23%、中段包 +10%）不会触发。
            放弃后该分量走 Phase C 的 ②/③ 分支：形状与不透明度都保持原样 —— 宁可不变，也不要削坏。
          */
          {
            let cnt = 0, bad = 0;
            for (let i = 0; i < nS; i++) {
              if (wl[i] < 0) continue;
              cnt++;
              const baseW = wl[i] + wr[i];
              if (baseW < 0.5) continue;
              const drift = Math.abs(tl[i] - wl[i]) + Math.abs(tr[i] - wr[i]);
              if (drift > 0.5 * baseW) bad++;
            }
            if (cnt >= MID_MIN_SAMPLES && bad > 0.35 * cnt) ok = false;
          }
        }
      }
    }

    // ---- ⑦ 成带 + 重建：逐像素按自己那一侧的平滑半宽算 sd；端部按权重退回原始 sd ----
    if (ok) {
      let uMax = 0;
      for (let i = 0; i < nS; i++) { if (tl[i] > uMax) uMax = tl[i]; if (tr[i] > uMax) uMax = tr[i]; }
      uMax += padBand;
      const taperLen = Math.min(3 * kernelRadius + 4, MID_TAPER_FRAC * totalLen);
      let nTouch = 0;
      for (let i = 0; i < nS; i++) {
        const ia = i - 2 < 0 ? 0 : i - 2;
        const ib = i + 2 >= nS ? nS - 1 : i + 2;
        let txv = cxs[ib] - cxs[ia], tyv = cys[ib] - cys[ia];
        if (txv === 0 && tyv === 0) txv = 1;
        const tlen = Math.sqrt(txv * txv + tyv * tyv);
        const nxv = -tyv / tlen, nyv = txv / tlen;
        const cx0 = cxs[i], cy0 = cys[i];
        for (let t = -uMax; t <= uMax; t += MID_PROBE_STEP) {
          const xi = Math.round(cx0 + nxv * t);
          const yi = Math.round(cy0 + nyv * t);
          if (xi < 0 || yi < 0 || xi >= rw || yi >= rh) continue;
          const pi = yi * rw + xi;
          const cid2 = compId[pi];
          if (cid2 !== 0 && cid2 !== c) continue;
          const u = (xi - cx0) * nxv + (yi - cy0) * nyv;
          const au = u < 0 ? -u : u;
          if (au > uMax) continue;
          if (chanK[pi] === 1 && (chanU[pi] < 0 ? -chanU[pi] : chanU[pi]) <= au) continue;
          if (chanK[pi] === 0) touched[nTouch++] = pi;
          chanK[pi] = 1; chanI[pi] = i; chanU[pi] = u;
        }
      }
      for (let q = 0; q < nTouch; q++) {
        const pi = touched[q];
        const i = chanI[pi];
        const u = chanU[pi];
        const wSide = u >= 0 ? tr[i] : tl[i];
        /*
          ⚠️ 必须补偿 cov 的 50% 位置，否则每遍固定收窄 BAND_LATTICE/2。
          cov = smoothstep(sdB / bands)，bands = BAND_LATTICE = 0.30 ⇒ 50% 覆盖落在 sd = bands/2 = 0.15
          （不是 sd = 0）。若直接用 sd = wSide − |u|，重建后的半高交点会落在 |u| = wSide − 0.15，
          即**每施加一遍线宽每侧内缩 0.15px**。实测 img1 反复施加 flat0：Δn16 = −3.7% → −8.4% → −13.0%，
          墨量 +7.5% → +11.4% → +15.3%（宽度单向变细 + 峰值单向抬升，收敛很慢）。
          把带边外扩 bands/2，让重建后的 50% 交点严格回到实测 wSide ⇒ 幂等。
        */
        const sdT = wSide + 0.5 * BAND_LATTICE - (u < 0 ? -u : u);
        let wgt = 1;
        if (taperLen > 0.5) {
          const sPos = i * rStep;
          const a0 = sPos / taperLen, b0 = (totalLen - sPos) / taperLen;
          wgt = (a0 < 1 ? a0 : 1) * (b0 < 1 ? b0 : 1);
          wgt = wgt * wgt * (3 - 2 * wgt);
        }
        sd[pi] = wgt >= 1 ? sdT : sdT * wgt + sd[pi] * (1 - wgt);
        aTgt[pi] = ta[i];
        aValid[pi] = 1;
      }
      for (let q = 0; q < nTouch; q++) { const pi = touched[q]; chanK[pi] = 0; chanU[pi] = 0; }
    }

    for (let k = 0; k < nR; k++) ridge[pix[k]] = 0;
  }
}

/* 双线性采样：坐标是「数组索引空间」，整数处 = 像素中心 */
function sampleBilinear(a: Float32Array, w: number, h: number, fx: number, fy: number): number {
  if (fx < 0) fx = 0; else if (fx > w - 1.001) fx = w - 1.001;
  if (fy < 0) fy = 0; else if (fy > h - 1.001) fy = h - 1.001;
  const x0 = fx | 0, y0 = fy | 0;
  const tx = fx - x0, ty = fy - y0;
  const p = y0 * w + x0;
  const a00 = a[p], a10 = a[p + 1], a01 = a[p + w], a11 = a[p + w + 1];
  return (a00 + (a10 - a00) * tx) * (1 - ty) + (a01 + (a11 - a01) * tx) * ty;
}

/*
  路径的「切角域」惩罚最小二乘平滑：弧长等距重采样 → 对相邻点连线方向角 φ 做二阶差分惩罚 → 回投 + 分段重建。

  ⚠️ 为什么必须换到切角域（这是「无限趋近最终平滑」能否成立的关键）：
    位置域二阶差分惩罚的零空间是 {1, s} ⇒ λ→∞ 时 x(s)、y(s) 各自收敛到**一次函数**，即**直线**。
    于是大 λ 会把弯曲的线整体拉直：实测 C 弧 flat450 出现 Δ内 mean −1.68px、Δ外 −3.36px 的系统性内缩，
    两侧被吸进去（就是用户看到的 Ω 在另一端复发）。
    切角域的零空间同样是 {1, s}，但积分之后它对应「曲率恒为 0（直线）」与「曲率恒为常数（圆弧）」——
    即 λ→∞ 收敛到**等曲率曲线**，这正是「光滑 C/S/I 型线」的本义（用户要的最终平滑）。
    于是 λ 才有单调可收敛的语义：λ 越大越像圆弧/直线，而不是越像一条被扯直的绳子。

  ⚠️ 为什么必须先按弧长等距重采样：
    入参折线是按**中轴采样索引**排布的（p_i = c_i + n_i·w_i）。中轴脊线是 8 连通 BFS 路径，
    带 30% 的锯齿与回溯，实测相邻段长在 0.015~1.85px 之间乱跳。
    于是即使边界本身是**完美圆周**（实测内边界原始半径恒为 241.00），φ 对**索引**也完全不是线性的，
    二阶差分平滑会把这堆纯参数化噪声当成真结构抹掉 ⇒ 重建出的圆被压成中段 239.1 的弓形（−1.9px）。
    改为按弧长等距后，圆周的 φ 严格线性、惩罚代价恒为 0 ⇒ 原样通过。

  ⚠️ 两端方向畸变必须先剔除（2026-09 修正，之前缺这一步导致锥形）：
    中轴脊线是 BFS **直径**路径，两端会拐进端帽角落，那里的法向几乎垂直于边界，
    于是边界点被朝"上下"而不是"左右"外推 —— 实测等宽 16px 直线在 i=0 处两侧边界点间距只有 1.86px
    （正常 16px）。这类畸变段一旦进入惩罚最小二乘，长波窗口会把它向内扩散成整条曲线的缓慢弯曲，
    左右两条边界被弯向**相反**方向 ⇒ 相对转角差 −2.15° ⇒ 等宽直线被削成 12.99→3.29 的尖锥。
    故先按「段长异常 + 局部方向偏离」把两端畸变段整段剔除，域外沿最近有效切角**直线延伸**
    （端帽处原始折线方向不可信，不能参与平滑与积分；宽度因此保持恒定）。

  ⚠️ 输出必须与输入**同参数化**（曾在此处出错，改动时务必守住）：
    重采样改变了点的位置分布，若把「重采样域积分出的第 i 个点」当成「输入第 i 个点的平滑结果」，
    二者根本不在同一位置。调用方（6d）用 |sr[i] − sl[i]| 当宽度，参数化一旦错配，
    这个差值与局部宽度完全脱钩 —— 实测粗线（宽 32px）半宽被整体压掉 27.7%（Σ(tl+tr)/Σ(wl+wr)=0.7234）。
    故这里分三步守住同参数化：① 去重时记 mapR；② 平滑只在等距域做；③ 按弧长把 φ̃ 回投到去重采样点。

  ⚠️ 收尾必须是**刚体变换（旋转 + 平移），不得带缩放**：
    切角平滑必然改变总转角 ⇒ 末端必然对不上。但相似变换带缩放，而左右两条边界各自缩放不同，
    其**相对间距**就被改掉 ⇒ 宽度被改：实测 sc≈0.7 时整条笔画缩掉 30%（墨量 −52%、域 1→3），
    反复施加时更会逐遍收窄直到断裂（img1 flat450 第 3 遍 域=29、墨量 −8.9%、Σ(tl+tr)/Σ(wl+wr)=0.844）。
    刚体变换保持任意两点距离不变 ⇒ 宽度与间距完全不受收尾影响。
  λ 的语义与采样步长绑定：这里用统一步长 step，故 lamOf(px) 直接对应弧长波长。
*/
function penalizedSmoothPathAngle(
  px: Float32Array, py: Float32Array, n: number, lam: number,
  outX: Float32Array, outY: Float32Array, ctx: MidCtx
): void {
  if (n <= 0) return;
  if (n < 8 || !(lam > 0)) {
    for (let i = 0; i < n; i++) { outX[i] = px[i]; outY[i] = py[i]; }
    return;
  }
  const sang = ctx.sang, seg = ctx.seg, cum = ctx.cum;
  const rx = ctx.rsx, ry = ctx.rsy;
  const qx = ctx.qax, qy = ctx.qay;
  const phj = ctx.phj, phk = ctx.phk;
  const ipx = ctx.ipx, ipy = ctx.ipy, mapR = ctx.mapR;

  // ① 去重：法向探测抖动会造出完全重合的采样点（零长段方向纯属噪声，且让弧长参数化失效）
  //    同时记 mapR：原始 i → 去重索引，供 ⑧ 回填用（这是「同参数化」的前提）
  let nc = 0;
  for (let i = 0; i < n; i++) {
    const x = px[i], y = py[i];
    if (nc > 0) {
      const dx = x - rx[nc - 1], dy = y - ry[nc - 1];
      if (dx * dx + dy * dy < 1e-12) { mapR[i] = nc - 1; continue; }
    }
    rx[nc] = x; ry[nc] = y; mapR[i] = nc; nc++;
  }
  if (nc < 8) {
    for (let i = 0; i < n; i++) { outX[i] = px[i]; outY[i] = py[i]; }
    return;
  }

  // ② 弧长（全长度，用于取段长中位数与端点剔除判据）
  let totAll = 0;
  for (let k = 0; k + 1 < nc; k++) {
    const dx = rx[k + 1] - rx[k], dy = ry[k + 1] - ry[k];
    seg[k] = Math.sqrt(dx * dx + dy * dy);
    totAll += seg[k];
  }
  seg[nc - 1] = 0;
  if (!(totAll > 1e-9)) {
    for (let i = 0; i < n; i++) { outX[i] = px[i]; outY[i] = py[i]; }
    return;
  }

  // ③ 两端方向畸变剔除 → 有效域 [k0, k1]
  //    判据（二者其一即"可疑"，从两端向内逐段剔除）：
  //      a) 段长 > 4×中位段长（畸变段的两端点相距几十像素，而正常只有 ~1px）
  //      b) 段方向与「向内 REF 段处」的局部方向相差 > 60°（对弯曲边界同样成立，因为参照是局部的）
  let k0 = 0, k1 = nc - 1;
  {
    const tmp = new Float64Array(nc - 1);
    for (let k = 0; k + 1 < nc; k++) tmp[k] = seg[k];
    const srt = Array.prototype.slice.call(tmp).sort((a, b) => a - b);
    const medSeg = srt[srt.length >> 1] || 1;
    const LIM = 4 * medSeg;
    const REF = Math.max(2, Math.min(12, nc >> 3));
    const dirDiff = (a: number, b: number): number => {
      let df = Math.abs(a - b);
      if (df > Math.PI) df = 2 * Math.PI - df;
      return df;
    };
    while (k0 + REF + 1 < k1) {
      const k = k0;
      let bad = seg[k] > LIM;
      if (!bad) {
        const a1 = Math.atan2(ry[k + 1] - ry[k], rx[k + 1] - rx[k]);
        const a2 = Math.atan2(ry[k + REF + 1] - ry[k + REF], rx[k + REF + 1] - rx[k + REF]);
        bad = dirDiff(a1, a2) > Math.PI / 3;
      }
      if (!bad) break;
      k0++;
    }
    while (k1 - REF - 1 > k0) {
      const k = k1 - 1;
      let bad = seg[k] > LIM;
      if (!bad) {
        const a1 = Math.atan2(ry[k + 1] - ry[k], rx[k + 1] - rx[k]);
        const a2 = Math.atan2(ry[k - REF + 1] - ry[k - REF], rx[k - REF + 1] - rx[k - REF]);
        bad = dirDiff(a1, a2) > Math.PI / 3;
      }
      if (!bad) break;
      k1--;
    }
  }
  const nv = k1 - k0 + 1;
  if (nv < 8) {
    for (let i = 0; i < n; i++) { outX[i] = px[i]; outY[i] = py[i]; }
    return;
  }
  const m = nv - 1;

  // ④ 有效域内的弧长前缀和（cum[k0] = 0）
  let tot = 0;
  for (let k = k0; k < k1; k++) { cum[k] = tot; tot += seg[k]; }
  cum[k1] = tot;
  if (!(tot > 1e-9)) {
    for (let i = 0; i < n; i++) { outX[i] = px[i]; outY[i] = py[i]; }
    return;
  }

  // ⑤ 等距重采样（nv 个点，步长 = tot/m）→ qx/qy（**只作切角平滑的域，不再当输出**）
  const step = tot / m;
  {
    let k = k0;
    for (let j = 0; j < nv; j++) {
      const target = j * step;
      while (k + 1 < k1 && cum[k + 1] < target) k++;
      const sl = seg[k];
      const t = sl > 1e-12 ? (target - cum[k]) / sl : 0;
      const tc = t < 0 ? 0 : (t > 1 ? 1 : t);
      qx[j] = rx[k] + (rx[k + 1] - rx[k]) * tc;
      qy[j] = ry[k] + (ry[k + 1] - ry[k]) * tc;
    }
  }

  // ⑥ 等距域切角 + 解缠绕（等距采样后圆弧的 φ 才严格线性）+ 惩罚最小二乘
  for (let i = 0; i < m; i++) phj[i] = Math.atan2(qy[i + 1] - qy[i], qx[i + 1] - qx[i]);
  for (let i = 1; i < m; i++) {
    let d = phj[i] - phj[i - 1];
    if (d > Math.PI) { while (d > Math.PI) { phj[i] -= 2 * Math.PI; d = phj[i] - phj[i - 1]; } }
    else if (d < -Math.PI) { while (d < -Math.PI) { phj[i] += 2 * Math.PI; d = phj[i] - phj[i - 1]; } }
  }
  penalizedSmooth(phj, m, lam, sang, ctx.pw0, ctx.pw1, ctx.pw2, ctx.pwZ, ctx.pwW);
  /*
    半径护栏：半增益波长不得超过**曲线自身的曲率半径**。
    理由：切角域惩罚最小二乘把 φ 拉向一次函数 = 常曲率 = 单一圆弧，只有在「整条曲线本就接近等曲率」时才对。
    真实笔触的 φ 会绕圈（累计转角远超 2π），大 λ 强拉会让平滑方向场与真实形状脱节，
    进而使下面的投影长度塌陷（ε 处处很大 ⇒ Σcos ε → 0）⇒ 笔画被缩成一点。
    实测：img1 反复施加 flat450 时第 3 遍墨量 −43%、域 1→7。
    用「已平滑转角的总转角」反推曲率半径 Rc = 弧长/|Φ|，把有效 λ 收敛到 L ≤ Rc：
    直线的 Φ→0、Rc→∞ ⇒ 不受限；C 弧 Rc=258px、flat450 的 L=450px > 258 ⇒ 自动收敛到 flat250 档的强度。
  */
  {
    const phiw = Math.abs(sang[m - 1] - sang[0]);
    if (phiw > 1e-3) {
      const rc = tot / phiw;
      const lreq = 2 * Math.PI * Math.pow(lam, 0.25);
      if (lreq > rc) {
        const k2 = rc / (2 * Math.PI);
        const lam2 = k2 * k2 * k2 * k2;
        if (lam2 < lam) penalizedSmooth(phj, m, lam2, sang, ctx.pw0, ctx.pw1, ctx.pw2, ctx.pwZ, ctx.pwW);
      }
    }
  }

  // ⑦ 回投：等距域 φ̃ → 去重采样点 φ̃_k。
  //    有效域内按弧长线性插值；域外用最近有效值**常量外推**（端帽处方向不可信，只能用最内侧的好值）
  for (let k = k0; k < k1; k++) {
    const u = cum[k] / step;
    let j = u | 0;
    if (j < 0) j = 0; else if (j > m - 1) j = m - 1;
    const jb = j + 1 < m ? j + 1 : m - 1;
    let f = u - j;
    if (!(f > 0)) f = 0; else if (f > 1) f = 1;
    const a0 = sang[j];
    let d = sang[jb] - a0;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    phk[k] = a0 + d * f;
  }
  const phHead = phk[k0], phTail = phk[k1 - 1];
  for (let k = 0; k < k0; k++) phk[k] = phHead;
  for (let k = k1; k < nc; k++) phk[k] = phTail;

  // ⑧ 分段重建：有效域内每段取「原始段长在平滑切角上的投影」，只剔掉切向抖动造成的**虚长**；
  //    域外以等距步长沿最近有效切角**直线延伸**（畸变段的方向与长度都不可用，必须丢掉）。
  //    不保留 tot、也不做整体缩放 ⇒ 长度不再是可调量，宽度不受影响。
  //    投影后夹到 [0.72L, L]：只剔虚长、永不放长；下限保证方向场轻微脱节时也不被整体压短。
  {
    let accX = rx[k0], accY = ry[k0];
    ipx[k0] = accX; ipy[k0] = accY;
    for (let k = k0; k < k1; k++) {
      const L = seg[k];
      const ka = k > k0 ? k - 1 : k0, kb = k + 2 <= k1 ? k + 2 : k1;
      const th = Math.atan2(ry[kb] - ry[ka], rx[kb] - rx[ka]);
      let e = phk[k] - th;
      if (e > Math.PI) e -= 2 * Math.PI; else if (e < -Math.PI) e += 2 * Math.PI;
      let Lp = L * Math.cos(e);
      if (!(Lp > 0.72 * L)) Lp = 0.72 * L; else if (Lp > L) Lp = L;
      accX += Math.cos(phk[k]) * Lp;
      accY += Math.sin(phk[k]) * Lp;
      ipx[k + 1] = accX; ipy[k + 1] = accY;
    }
    {
      let bx = ipx[k0], by = ipy[k0];
      const cb0 = Math.cos(phHead), sb0 = Math.sin(phHead);
      for (let k = k0 - 1; k >= 0; k--) { bx -= cb0 * step; by -= sb0 * step; ipx[k] = bx; ipy[k] = by; }
    }
    {
      let ax = ipx[k1], ay = ipy[k1];
      const cb1 = Math.cos(phTail), sb1 = Math.sin(phTail);
      for (let k = k1 + 1; k < nc; k++) { ax += cb1 * step; ay += sb1 * step; ipx[k] = ax; ipy[k] = ay; }
    }
  }

  // ⑨ 收尾变换（旋转 β + 平移 t + 沿曲线尺度 sc）。拟合只用有效域 [k0,k1]，变换施加到全部点。
  //    sc 取自有效域**首末弦长比**：切角平滑必然同时改变总转角与总长度，只做旋转+平移会留下
  //    沿曲线方向的尺度残差 ⇒ 平滑后边界与原始边界在长波上错位，反噬峰/宽的平滑度
  //    （实测去掉 sc 后 img1 峰 RMS 3.86 → 4.10、峰跳 1.2 → 2.7）。
  //    ⚠️ sc 只作用于"同一笔画的两条平行边界"，两侧弦长天然接近，故不会造成左右不一致的缩放
  //    （那才是宽度漂移的来源；此处另夹到 [0.9, 1.1] 以防个别畸变点把整体拉歪）。
  {
    let sxx = 0, sxy = 0;
    for (let k = k0; k <= k1; k++) {
      const ux = ipx[k] - ipx[k0], uy = ipy[k] - ipy[k0];
      const vx = rx[k] - rx[k0], vy = ry[k] - ry[k0];
      sxx += ux * vx + uy * vy;
      sxy += ux * vy - uy * vx;
    }
    const beta = (sxx !== 0 || sxy !== 0) ? Math.atan2(sxy, sxx) : 0;
    const cux = ipx[k1] - ipx[k0], cuy = ipy[k1] - ipy[k0];
    const cvx = rx[k1] - rx[k0], cvy = ry[k1] - ry[k0];
    const cu = Math.sqrt(cux * cux + cuy * cuy);
    const cv = Math.sqrt(cvx * cvx + cvy * cvy);
    let sc = (cu > 1e-6 && cv > 1e-6) ? cv / cu : 1;
    if (!(sc > 0.9)) sc = 0.9; else if (sc > 1.1) sc = 1.1;
    const cb = Math.cos(beta) * sc, sb = Math.sin(beta) * sc;
    const ox = ipx[k0], oy = ipy[k0];
    for (let k = 0; k < nc; k++) {
      const ux = ipx[k] - ox, uy = ipy[k] - oy;
      ipx[k] = px[0] + ux * cb - uy * sb;
      ipy[k] = py[0] + ux * sb + uy * cb;
    }
    // 最小二乘平移（同样只用有效域拟合，不改变任何相对距离）
    let tx = 0, ty = 0;
    for (let k = k0; k <= k1; k++) { tx += rx[k] - ipx[k]; ty += ry[k] - ipy[k]; }
    tx /= nv; ty /= nv;
    for (let k = 0; k < nc; k++) { ipx[k] += tx; ipy[k] += ty; }
  }

  // ⑩ 回填到原始索引：输出第 i 点 = 输入第 i 点平滑后的位置（同参数化）
  for (let i = 0; i < n; i++) {
    const j = mapR[i];
    outX[i] = ipx[j]; outY[i] = ipy[j];
  }
}

/*
  1D 惩罚最小二乘平滑（Whittaker smoother）：min Σ(y−x)² + λ·Σ(x_{i+1}−2x_i+x_{i−1})²。
  矩阵 = I + λ·JᵀJ（J = 二阶差分算子），带宽 2 的对称正定五对角阵。
  就地 LDLᵀ → O(n) 前代/回代，全程无分配（工作区由调用方提供、跨调用复用）。
  ⚠️ 为什么不用高斯/盒模糊：模糊会把端点处的一/二次趋势一并吃掉（C 弧两端被拉直、
  直线被整体平移），而二阶差分惩罚对一次/二次趋势的代价恒为 0 ⇒ 长波原样通过、短波被压，
  λ 的语义恰好是「多长以下被抹掉」，这正是「无限趋近最终平滑」可收敛的前提。
*/
function penalizedSmooth(
  y: Float32Array, n: number, lam: number, out: Float32Array,
  b0: Float64Array, b1: Float64Array, b2: Float64Array, z: Float64Array, w: Float64Array
): void {
  if (n <= 0) return;
  if (n < 8 || !(lam > 0)) {
    for (let i = 0; i < n; i++) out[i] = y[i];
    return;
  }
  for (let i = 0; i < n; i++) { b0[i] = 1; b1[i] = 0; b2[i] = 0; }
  for (let r = 0; r + 2 < n; r++) {
    b0[r] += lam;
    b1[r + 1] -= 2 * lam;
    b0[r + 1] += 4 * lam;
    b2[r + 2] += lam;
    b1[r + 2] -= 2 * lam;
    b0[r + 2] += lam;
  }
  // 就地 LDLᵀ（b0→D，b1→L1，b2→L2）
  for (let i = 0; i < n; i++) {
    let l2 = 0, l1 = 0;
    if (i >= 2) l2 = b2[i] / b0[i - 2];
    if (i >= 1) {
      let v = b1[i];
      if (i >= 2) v -= l2 * b1[i - 1] * b0[i - 2];
      l1 = v / b0[i - 1];
    }
    let dd = b0[i];
    if (i >= 1) dd -= l1 * l1 * b0[i - 1];
    if (i >= 2) dd -= l2 * l2 * b0[i - 2];
    b0[i] = dd > 1e-12 ? dd : 1e-12;
    b1[i] = l1;
    b2[i] = l2;
  }
  // 前代 L z = y
  z[0] = y[0];
  for (let i = 1; i < n; i++) {
    let v = y[i] - b1[i] * z[i - 1];
    if (i >= 2) v -= b2[i] * z[i - 2];
    z[i] = v;
  }
  for (let i = 0; i < n; i++) w[i] = z[i] / b0[i];
  // 回代 Lᵀ x = w
  out[n - 1] = w[n - 1];
  if (n >= 2) out[n - 2] = w[n - 2] - b1[n - 1] * out[n - 1];
  for (let i = n - 3; i >= 0; i--) {
    out[i] = w[i] - b1[i + 1] * out[i + 1] - b2[i + 2] * out[i + 2];
  }
}

// ================= 工具：可分离高斯模糊（边界 renormalize） =================
// 与逐点求和语义完全一致，只是把「内区」与「边缘」分开：
//  · 内区（核完全落在窗口内）无需边界判断、无需归一化（核已归一到 1）；
//  · 边缘仍需按有效核权重重新归一化（与旧实现同式）。
// 垂直方向改成「逐行累加」：外层 k、内层 x 连续扫描，避免旧实现 x 外层 y 内层
// 造成的跨行 stride 反复失效。
function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number, tmp: Float32Array, out: Float32Array): void {
  const kr = Math.max(1, Math.ceil(3 * sigma));
  const klen = 2 * kr + 1;
  const kernel = new Float64Array(klen);
  let sum = 0;
  for (let k = -kr; k <= kr; k++) {
    const val = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + kr] = val;
    sum += val;
  }
  for (let k = 0; k < klen; k++) kernel[k] /= sum;

  const inStart = kr;
  const inEnd = w - kr;
  const hasInner = inEnd > inStart;

  // ---- 水平 ----
  for (let y = 0; y < h; y++) {
    const base = y * w;
    if (hasInner) {
      for (let x = inStart; x < inEnd; x++) {
        let s = 0;
        const p = base + x - kr;
        for (let k = 0; k < klen; k++) s += src[p + k] * kernel[k];
        tmp[base + x] = s;
      }
    }
    // 左侧边缘
    const leftEnd = Math.min(inStart, w);
    for (let x = 0; x < leftEnd; x++) {
      let s = 0, wsum = 0;
      for (let k = 0; k < klen; k++) {
        const xx = x - kr + k;
        if (xx < 0 || xx >= w) continue;
        const ww = kernel[k];
        s += src[base + xx] * ww;
        wsum += ww;
      }
      tmp[base + x] = wsum > 0 ? s / wsum : 0;
    }
    // 右侧边缘
    const rightStart = Math.max(inStart, inEnd, 0);
    for (let x = rightStart; x < w; x++) {
      let s = 0, wsum = 0;
      for (let k = 0; k < klen; k++) {
        const xx = x - kr + k;
        if (xx < 0 || xx >= w) continue;
        const ww = kernel[k];
        s += src[base + xx] * ww;
        wsum += ww;
      }
      tmp[base + x] = wsum > 0 ? s / wsum : 0;
    }
  }

  // ---- 垂直（逐行累加） ----
  const vInner = h - kr;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let wsum = 1;
    let inner = false;
    if (y >= kr && y < vInner) {
      inner = true;
      for (let x = 0; x < w; x++) out[base + x] = 0;
    } else {
      wsum = 0;
      for (let k = 0; k < klen; k++) {
        const yy = y - kr + k;
        if (yy < 0 || yy >= h) continue;
        wsum += kernel[k];
      }
      for (let x = 0; x < w; x++) out[base + x] = 0;
    }
    if (inner) {
      for (let k = 0; k < klen; k++) {
        const kk = kernel[k];
        const row = base + (k - kr) * w;
        for (let x = 0; x < w; x++) out[base + x] += tmp[row + x] * kk;
      }
    } else {
      const inv = wsum > 0 ? 1 / wsum : 0;
      for (let k = 0; k < klen; k++) {
        const yy = y - kr + k;
        if (yy < 0 || yy >= h) continue;
        const kk = kernel[k];
        const row = yy * w;
        for (let x = 0; x < w; x++) out[base + x] += tmp[row + x] * kk;
      }
      if (inv !== 1) for (let x = 0; x < w; x++) out[base + x] *= inv;
    }
  }
}

/*
  两通道同核高斯：与 gaussianBlur 逐式一致（同一 kernel、同一行列扫描、同一边界归一），
  只把两次卷积合并进一次遍历，共享 tap 偏移 —— 用于「掩码归一」所需的
  blur(alpha) 与 blur(mask)。单次调用耗时 ≈ 单通道的 1.5 倍而不是 2 倍（实测掩码归一
  的代价由 +10% 降到 +5%）。之所以不写成「给 gaussianBlur 加可选第二通道」：那会让
  sd/body 等单通道调用在**内层 tap 循环**里每次多付一个分支，反而拖慢主路径。
*/
function gaussianBlurPair(
  srcA: Float32Array, srcB: Float32Array,
  w: number, h: number, sigma: number,
  tmpA: Float32Array, tmpB: Float32Array,
  outA: Float32Array, outB: Float32Array
): void {
  const kr = Math.max(1, Math.ceil(3 * sigma));
  const klen = 2 * kr + 1;
  const kernel = new Float64Array(klen);
  let sum = 0;
  for (let k = -kr; k <= kr; k++) {
    const val = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + kr] = val;
    sum += val;
  }
  for (let k = 0; k < klen; k++) kernel[k] /= sum;

  const inStart = kr;
  const inEnd = w - kr;
  const hasInner = inEnd > inStart;

  // ---- 水平 ----
  for (let y = 0; y < h; y++) {
    const base = y * w;
    if (hasInner) {
      for (let x = inStart; x < inEnd; x++) {
        let s = 0, s2 = 0;
        const p = base + x - kr;
        for (let k = 0; k < klen; k++) { const kk = kernel[k]; s += srcA[p + k] * kk; s2 += srcB[p + k] * kk; }
        tmpA[base + x] = s; tmpB[base + x] = s2;
      }
    }
    const leftEnd = Math.min(inStart, w);
    for (let x = 0; x < leftEnd; x++) {
      let s = 0, s2 = 0, wsum = 0;
      for (let k = 0; k < klen; k++) {
        const xx = x - kr + k;
        if (xx < 0 || xx >= w) continue;
        const ww = kernel[k];
        s += srcA[base + xx] * ww; s2 += srcB[base + xx] * ww; wsum += ww;
      }
      const inv = wsum > 0 ? 1 / wsum : 0;
      tmpA[base + x] = s * inv; tmpB[base + x] = s2 * inv;
    }
    const rightStart = Math.max(inStart, inEnd, 0);
    for (let x = rightStart; x < w; x++) {
      let s = 0, s2 = 0, wsum = 0;
      for (let k = 0; k < klen; k++) {
        const xx = x - kr + k;
        if (xx < 0 || xx >= w) continue;
        const ww = kernel[k];
        s += srcA[base + xx] * ww; s2 += srcB[base + xx] * ww; wsum += ww;
      }
      const inv = wsum > 0 ? 1 / wsum : 0;
      tmpA[base + x] = s * inv; tmpB[base + x] = s2 * inv;
    }
  }

  // ---- 垂直（逐行累加） ----
  const vInner = h - kr;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let wsum = 1;
    let inner = false;
    if (y >= kr && y < vInner) {
      inner = true;
      for (let x = 0; x < w; x++) { outA[base + x] = 0; outB[base + x] = 0; }
    } else {
      wsum = 0;
      for (let k = 0; k < klen; k++) {
        const yy = y - kr + k;
        if (yy < 0 || yy >= h) continue;
        wsum += kernel[k];
      }
      for (let x = 0; x < w; x++) { outA[base + x] = 0; outB[base + x] = 0; }
    }
    if (inner) {
      for (let k = 0; k < klen; k++) {
        const kk = kernel[k];
        const row = base + (k - kr) * w;
        for (let x = 0; x < w; x++) { outA[base + x] += tmpA[row + x] * kk; outB[base + x] += tmpB[row + x] * kk; }
      }
    } else {
      const inv = wsum > 0 ? 1 / wsum : 0;
      for (let k = 0; k < klen; k++) {
        const yy = y - kr + k;
        if (yy < 0 || yy >= h) continue;
        const kk = kernel[k];
        const row = yy * w;
        for (let x = 0; x < w; x++) { outA[base + x] += tmpA[row + x] * kk; outB[base + x] += tmpB[row + x] * kk; }
      }
      if (inv !== 1) for (let x = 0; x < w; x++) { outA[base + x] *= inv; outB[base + x] *= inv; }
    }
  }
}

export const defaultLineSmoothParams: LineSmoothParams = {
  strength: 1,        // 平滑力度 100%
  radius: 8,          // 曲率平滑 8px
  flattenRadius: 250, // 宽度平滑 250px（实测 250 附近最均衡）
  opacityRadius: 250  // 不透明度平滑 250px
};

// ================= 工具：面积开运算 =================
// 原「半径 2 二值开运算」已删除：它是**按结构元宽度筛**的算子，会把线宽 < 5px 的线条
// 整体抹掉，与「细线也应被平滑」的目标直接冲突（详见 Phase A 注释）。
// 现在的面积开运算由 Phase A.5 的 8 连通域标注给出（面积 < SPECK_MAX 的分量即
// isSpeck），Phase A 据此构造 lineMaskClean —— 判据只看面积，与线宽无关。

