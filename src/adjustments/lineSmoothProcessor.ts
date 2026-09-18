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
  /** 平滑力度 0~1（UI 0-100%，默认 100 → 1）。控制高斯 σ */
  strength?: number;
  /** 轮廓平滑 px（面板「轮廓平滑」，UI 3~9，默认 8）。σ 上限，决定轮廓几何被磨到多细的尺度；
   *  抗锯齿带宽为格子尺度定值，不受其影响。⚠️ 该尺度被线宽封顶（SIGMA_THICK_RATIO），管不了沿笔轴的粗细起伏。 */
  radius?: number;
  /**
   * 宽度拉平 px（面板「宽度拉平」，0 = 关闭，默认 0）。**沿笔轴**对宽度场做低通的尺度，
   * 不受线宽封顶 —— 这是它与 radius 的本质分工：radius 管轮廓几何尺度（σ，受线宽封顶），
   * 本参数管粗细起伏的长波尺度。0 时不进入任何计算，输出与旧版逐字节一致。
   */
  flattenRadius?: number;
}

const THR = 16;                 // 线条二值化阈值
const SPECK_MAX = 10;           // 游离杂点判定：原线掩码中 8 连通域面积 < 该值 → 杂点（面积开运算的唯一判据）
const SIGMA_MIN = 0.5;          // 自适应 σ 下限（1px 线也落到这一档，只求不塌缩）
const SIGMA_MAX = 3.2;          // 自适应 σ 上限
const SIGMA_THICK_RATIO = 1.80; // 档位判据：窗口内存在 ≥ ratio·σ 的内切半径（等价线宽 ≥ 3.6σ，即安全口径 σ ≤ 0.56·线宽）
const SIGMA_WINDOW_RATIO = 2.00; // 判据窗口半径 = ratio·σ（必须 ≥ SIGMA_THICK_RATIO·σ - 0.5，粗线最外圈才够得着核心）
const BAND_LATTICE = 0.30;      // 抗锯齿过渡带宽(px)：格子尺度定值，不随 σ/radius 放大（理由见 Phase C 注释）
// ---- 沿轴宽度拉平（flattenRadius > 0 时才用到；关闭时不分配、不扫描）----
const FLAT_MAX = 700;           // flattenRadius 上限(px)
const FLAT_GRID = 8;            // 宽度场网格步长(px)：格内取 max，远小于低通尺度即可
const FLAT_EDGE = 1.5;          // 脊线判据下限（half < 1.5 处不算脊线）
const FLAT_RIDGE_EPS = 0.6;     // 脊线判据容差（脊线是平台而非尖峰，必须给容差）
const FLAT_CLAMP_FRAC = 0.50;   // Δ 相对宽度场的限幅（±50%）
//   ⚠️ 不能收紧到 0.35：限幅一绑住，Δ 的均值就不为 0（宽相位可取满、窄相位被削）
//   ⇒ 每点一次线就整体变细一点。用户笔触起伏幅度≈均宽 29%，0.35 恰好绑住窄相位，
//   实测系统性变细 −1.8%（改 0.50 后消失）。
const FLAT_CLAMP_PX = 12;       // Δ 绝对限幅(px)
const FLAT_MIN_AREA = 200;      // 小于该面积的分量不做拉平（没有可分辨的波）
const FLAT_BODY_RATIO = 0.35;   // 双侧邻域最大半宽(Href) < 0.35·分量最大半宽 ⇒ 视为「细支/笔尖」，Δ 归零（理由见 flattenWidthUndulation）
// Href 的窗口半径（单位：格）= clamp(round(flatR / (FLAT_REF_DIV·FLAT_GRID)), MIN, MAX)。
// 用途：细支豁免判据的参照 —— 必须回答「此处是不是两侧都粗的凹陷」，而不是「此处有多细」。
const FLAT_REF_DIV = 6;         // 窗口半径 ≈ flatR/6 (px)：flatR 200/250/450/700 → 32/40/72/80px
const FLAT_REF_MIN = 3;         // 下限 3 格 = 24px（再小则短凹陷仍会被当细支豁免）
const FLAT_REF_MAX = 10;        // 上限 10 格 = 80px（再大则相隔较远的粗段也能「夹」住细支根部）
const FLAT_SPREAD_MAX = 10;     // 散播半径上限(格)=80px，覆盖 ≤80px 半宽的横截面
const FLAT_CENTER_DEAD = 0.5;   // 中轴位移死区(px)：小于此值视为「无位移」—— 保证两侧对称场景与旧版逐值一致
const FLAT_CENTER_CLAMP = 12;   // 中轴位移限幅(px)：弯曲/分叉处的质心估计可能失真，兜住
const FLAT_AXIS_RATIO = 2.0;    // 分量长宽比 ≥ 此值才认为笔画走向已确定；否则中轴跟随整体退化（斜线/团块不冒风险）
const FLAT_HALO = 96;           // 开启拉平时窗口额外外扩(px)：保证选区边缘处宽度场完整
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
  // 宽度拉平尺度（面板「宽度拉平」）：0 = 关闭 —— 不进入任何计算，输出与旧版逐字节一致。
  // 它不受线宽封顶，量纲是「沿笔轴做低通的尺度」，与 radius（轮廓几何尺度）互不替代。
  // 详见 flattenWidthUndulation 头注。
  const flattenRadius = clampInt(Math.round(typeof params.flattenRadius === 'number' ? params.flattenRadius : 0), 0, FLAT_MAX);
  const flatOn = flattenRadius > 0;

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
  // 开启宽度拉平时额外外扩 FLAT_HALO：宽度场需要选区外足够长的样点，否则窗口边缘处
  // 样点突然消失 ⇒ Δ 淡出 ⇒ 选区边界上出现宽度台阶。
  const halo = Math.max(8, 2 * kernelRadius + 8, flatOn ? FLAT_HALO : 0);
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
      // 宽度拉平需要每个分量的包围盒；关闭时不统计（不给默认路径多加一遍 O(n) 扫描）
      if (flatOn) {
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
  // ================= Phase A.2：沿轴宽度拉平（可选） =================
  // 只改 sd：让零等值线自己移动。Phase B/C 完全不知道这件事发生过。
  if (flatOn) flattenWidthUndulation(sd, half, lineCompId, lineCompSize, lineCompBox, rw, rh, flattenRadius);

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
  const sdB = new Float32Array(rn);
  const bodyBlur = new Float32Array(rn);
  {
    const tmpSd = new Float32Array(rn);
    const tmpBody = new Float32Array(rn);
    const used = new Uint8Array(sigmaLevels.length);
    for (let i = 0; i < rn; i++) used[sigmaIdx[i]] = 1;
    for (let k = 0; k < sigmaLevels.length; k++) {
      if (!used[k]) continue;
      const sig = sigmaLevels[k];
      const sigBody = clamp(sig * 0.55, 0.7, radius);
      const polish = k === 0;
      gaussianBlur(sd, rw, rh, sig, scratch, tmpSd);
      if (polish) gaussianBlur(alpha, rw, rh, sigBody, scratch, tmpBody);
      for (let i = 0; i < rn; i++) {
        if (sigmaIdx[i] !== k) continue;
        sdB[i] = tmpSd[i];
        bodyBlur[i] = polish ? tmpBody[i] : alpha[i];
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
      // 密度：原线像素取 max(自身 alpha, 抛光密度)；非原线像素用最近原线 alpha。
      // max 的保底项是幂等性所必需：密度抛光（对 alpha 再做一次 σBody 高斯）会把线外
      // 的 0 掺进边缘像素造成压暗（硬边 12px 线最外圈 255→158），再乘 cov 就形成又一处
      // 「越点越细」的衰减源（实测 12px 硬边连点 12 次 -15.2%，改为 max 后 0.0%）。
      // 取 max 后语义变成：边缘/笔压原样保留，只有「内部被模糊抬升的低值像素」（噪点）
      // 仍被抛光拉平 —— 即抛光只做它该做的事，不再有反向的减墨作用。
      let density: number;
      if (alpha[i] > THR) {
        density = Math.max(alpha[i], bodyBlur[i] * bodyScale);
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
        // 亚阈值淡边残留（仅宽度拉平开启时；保证 flat=0 与旧版逐字节一致）：
        // 原始 alpha ≤ THR 的边缘像素**不属于任何连通域**（线掩码要求 alpha > THR），
        // 上面那条规则按 cid 找它们永远够不到。轮廓被拉平内推后，这些软边像素留在原处、
        // 与新墨之间拉开空隙 ⇒ 变成孤立淡点（实测 alpha≈10，缩放到 1000% 就是一个可见的
        // 浅灰小方块 —— 用户截图即此现象）。两条判据都满足才清：
        //   ① 8 邻域里存在「已被 SDF 实际处理(compCovered)的连通域」像素 —— 否则属极细线
        //      保护区（覆盖率 < COVER_MIN，线条被整体保留），一律不动；
        //   ② 8 邻域里没有任何「输出墨」(输出 alpha > 0) —— 紧贴新轮廓的淡边是正常抗锯齿
        //      过渡，必须保留；只有被新墨丢下的孤立碎片才清。
        if (!cleared && flatOn && a0 > 0 && a0 <= THR) {
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

// ================= Phase A.2：沿轴宽度拉平 =================
/*
  为什么需要它（2026-09-18 定量诊断）：
  SDF 高斯平滑对「粗细起伏」的拉平量 ≈ σ²/(2R)（R = 起伏的曲率半径），而 σ 被线宽封顶
  （SIGMA_THICK_RATIO：σ ≤ 0.56·线宽）。用户笔触实测：均宽 24px、起伏主频 λ≈384px
  ⇒ σ 比波长小 30~100 倍 ⇒ 拉平率仅 1.1%，且 radius/strength 全部档位结果完全一致。
  结论：这不是调参问题，是**算子尺度不匹配** —— 只要 σ 受线宽约束，各向同性高斯就永远
  追不上长波（放大 σ 到波长量级必然让细线塌缩，那正是上一轮刚修掉的缺陷）。
  所以换一个尺度轴：不放大 σ，而是沿**笔轴**对宽度场做低通，把「宽度相对自身长波趋势的
  偏离」直接换算成距离场偏置：

      h  = 脊线处的 half（该处局部半宽）
      H1 = 宽度场：分量包围盒上按 FLAT_GRID 分格取 max（= 该格内最大内切半径），
           再按「分量自身尺度」散播成连续场（散播半径 rSig = maxHalf/FLAT_GRID）
      H2 = H1 的归一化低通（尺度 = flattenRadius）
      Δ  = clamp(H1 − H2, ±0.50·H1, ±12px)        →   sd -= Δ

  Δ 是空间变化的偏置，零等值线自己移动 ⇒ 新轮廓天然光滑，不会出现「几何径向重采样」
  的梳齿毛边（那一版已废弃），也不需要显式求中轴（在真实带压感的笔触上极脆）。

  三条必须遵守的口径：
  ① **逐连通域隔离**。宽度场若跨分量混合，细线挨着粗线时细线的 H2 被抬高 ⇒ Δ<0 把它撑胖
     （±35% 限幅也足够显眼）。故取样/散播/低通都在本分量自己的网格上做；写回时跳过
     「别的分量」的墨像素。half 本身只在线内非零，天然把取样限制在本分量上。
  ② Δ 只在「本分量宽度场有定义」的散播带内生效，带外恒 0；带内 Δ 沿横截面近似恒定
     （这正是需要的：整条横截面一起平移）。两侧在带边界处都 ≈0（H1≈H2），不会产生假等值线。
  ③ 散播与低通都必须**归一化**（值域/权重域分别模糊再相除）。只模糊值域会被「外围 0」拉低
     ⇒ Δ 退化成近似均匀收缩（原型阶段实测 −11.5px 的系统性变细）。

  已知边界（有意为之，别当 bug）：
  · 分量的沿轴跨度 < 0.5·flattenRadius 时跳过 —— 比低通尺度还短的线没有可分辨的波；该判据同时
    兜住性能（否则 R=700 时每个小碎块都要开一张几百格的宽度场网格）；
  · 明显细于本分量主体的段落（局部半宽 < FLAT_BODY_RATIO·最大半宽：发丝、T 形细支、毛笔尖）
    不参与拉平 —— 同一连通域内宽度场是共享的，细支的 H2 会被主体粗段抬高而撑胖
    （实测 3px 发丝接在 20px 粗杠上，整条被撑到 5px）；
  · 开启时窗口额外外扩 FLAT_HALO，超出该距离的选区边缘处 Δ 会淡出（宽度台阶）；
  · Δ 上限 ±0.50·H1 ⇒ 突然变细的段落最多被撑胖 50%，不会无界变形；幅度超过半宽的极端起伏
    会被限幅削掉（实测 ±40% 的方波式起伏在强拉平下均宽掉约 10%，手绘常见起伏 ≤30% 不受影响）。
*/

// 单次盒模糊（先横后纵，滑动窗口和）。⚠️ 这里是**纯卷积求和，不做归一化**：
// 归一化由「值域/权重域相除」在外层完成。这样网格外（无样点）按 0 截断即等价于
// 「无限域 + 0 填充」，是精确的 —— 也就是说网格只需覆盖「分量包围盒 + 散播支撑」，
// 不需要为低通再留 3·rLow 的边界（那会让耗时和内存涨 50 倍）。
// src / dst / tmp 必须互不相同。
function boxBlurInto(src: Float32Array, dst: Float32Array, tmp: Float32Array, w: number, h: number, r: number): void {
  const rr = r > 1 ? r : 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    const k0 = rr < w ? rr : w - 1;
    for (let x = 0; x <= k0; x++) sum += src[row + x];
    tmp[row] = sum;
    for (let x = 1; x < w; x++) {
      const addI = x + rr;
      const subI = x - rr - 1;
      if (addI < w) sum += src[row + addI];
      if (subI >= 0) sum -= src[row + subI];
      tmp[row + x] = sum;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    const k0 = rr < h ? rr : h - 1;
    for (let y = 0; y <= k0; y++) sum += tmp[y * w + x];
    dst[x] = sum;
    for (let y = 1; y < h; y++) {
      const addI = y + rr;
      const subI = y - rr - 1;
      if (addI < h) sum += tmp[addI * w + x];
      if (subI >= 0) sum -= tmp[subI * w + x];
      dst[y * w + x] = sum;
    }
  }
}

// 3 次盒模糊级联 ≈ 高斯（单次盒模糊频响太差，Δ 会振铃）。结果落在 dst。
function boxBlur3(src: Float32Array, dst: Float32Array, s1: Float32Array, s2: Float32Array, w: number, h: number, r: number): void {
  boxBlurInto(src, s1, dst, w, h, r);
  boxBlurInto(s1, s2, dst, w, h, r);
  boxBlurInto(s2, dst, s1, w, h, r);
}

// 沿一条线（base/stride/n 定义）做「双侧滑动最大」：先向左看 r 格取滑动最大 fwd[k]，
// 再向右看 r 格取滑动最大 bwd[k]，写回 min(fwd, bwd)。单调双端队列，O(n) 与半径无关。
// 语义：该点在同一轴上「两侧都至少有 W 那么宽」的最大 W。
function lineTwoSidedMax(
  src: Float32Array, tmp: Float32Array, base: number, stride: number,
  n: number, r: number, dq: Int32Array
): void {
  const rr = r > 0 ? r : 0;
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    const v = src[base + i * stride];
    while (head < tail && src[base + dq[tail - 1] * stride] <= v) tail--;
    dq[tail++] = i;
    if (dq[head] < i - rr) head++;
    tmp[i] = src[base + dq[head] * stride];
  }
  head = 0; tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    const v = src[base + i * stride];
    while (head < tail && src[base + dq[tail - 1] * stride] <= v) tail--;
    dq[tail++] = i;
    if (dq[head] > i + rr) head++;
    const b = src[base + dq[head] * stride];
    if (b < tmp[i]) tmp[i] = b;
  }
}

// 整张网格的双侧邻域最大值 Href（x、y 两轴取较大者）：
//   Href[k] = max( min(max_x⁻, max_x⁺), min(max_y⁻, max_y⁺) )
// 与「普通盒状最大值」的关键区别：盒状最大值只问「邻域里出现过粗段吗」，于是长细支在
// 靠近粗段的根部会被误判成凹陷而撑胖（实测会破坏 T 形细支不变量）；双侧 min 额外要求
// **反方向也是粗段**（= 被夹住），长细支/毛笔尖沿走向的一侧永远是细的 ⇒ 仍然豁免。
// 单调双端队列，O(n) 与半径无关。src / dst / line 必须互不相同，line 长度 ≥ max(w, h)。
function twoSidedMaxInto(
  src: Float32Array, dst: Float32Array, line: Float32Array,
  w: number, h: number, r: number
): void {
  const dq = new Int32Array((w > h ? w : h) + 1);
  dst.fill(0, 0, w * h);
  for (let y = 0; y < h; y++) {
    lineTwoSidedMax(src, line, y * w, 1, w, r, dq);
    const row = y * w;
    for (let x = 0; x < w; x++) { const k = row + x; if (line[x] > dst[k]) dst[k] = line[x]; }
  }
  for (let x = 0; x < w; x++) {
    lineTwoSidedMax(src, line, x, w, h, r, dq);
    for (let y = 0; y < h; y++) { const k = y * w + x; const v = line[y]; if (v > dst[k]) dst[k] = v; }
  }
}

function flattenWidthUndulation(
  sd: Float32Array,
  half: Float32Array,
  compId: Int32Array,
  compSize: number[],
  compBox: number[],
  rw: number,
  rh: number,
  flatR: number
): void {
  const rLow = Math.max(1, Math.round(flatR / FLAT_GRID));
  // Href 窗口半径（格）：随 flattenRadius 变，但有上下限 —— 太小则短凹陷仍被当细支豁免，
  // 太大则相隔较远的粗段也能「夹」住真正的细支根部而把它撑胖。
  const rRef = clampInt(Math.round(flatR / (FLAT_REF_DIV * FLAT_GRID)), FLAT_REF_MIN, FLAT_REF_MAX);
  const nComp = compSize.length - 1;
  // 分量间复用缓冲（分量多时避免反复分配）；按最大需要的一次性增长
  let capCells = 0;
  let bufMc: Float32Array | null = null;  // 格内最大 half → 复用为 H1 → 复用为 Δ
  let bufSv: Float32Array | null = null;  // 取样值
  let bufSw: Float32Array | null = null;  // 取样权重 → 复用为 hasH
  let bufBv: Float32Array | null = null;  // 模糊结果（值域）
  let bufBw: Float32Array | null = null;  // 模糊结果（权重域）
  let bufT1: Float32Array | null = null;
  let bufRef: Float32Array | null = null;  // Href（双侧邻域最大半宽）→ 门槛与限幅的共同参照
  let bufT2: Float32Array | null = null;
  let bufMx: Float32Array | null = null;  // 格内 sd 加权质心 x → 散播后=中轴 x → 复用为 δcx
  let bufMy: Float32Array | null = null;  // 同上 y
  let bufMw: Float32Array | null = null;  // 质心权重
  let bufTx: Float32Array | null = null;  // 脊线采样暂存 x → 复用为低频权重（tw）
  let bufTy: Float32Array | null = null;
  let bufTw: Float32Array | null = null;
  let bufCx: Float32Array | null = null;  // 中轴低频 x（H2 类比）
  let bufCy: Float32Array | null = null;

  for (let c = 1; c <= nComp; c++) {
    if ((compSize[c] || 0) < FLAT_MIN_AREA) continue;
    const o = (c - 1) * 4;
    const bx0 = compBox[o], by0 = compBox[o + 1], bx1 = compBox[o + 2], by1 = compBox[o + 3];
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (bw < flatR * 0.5 && bh < flatR * 0.5) continue;   // 沿轴跨度不足半个拉平尺度 ⇒ 没有可分辨的波（同时兜住性能）

    // ---- ① 分量最大半宽：决定散播半径（3σ₁ 必须盖住整个横截面）----
    let maxHalf = 0;
    for (let y = by0; y <= by1; y++) {
      const row = y * rw;
      for (let x = bx0; x <= bx1; x++) {
        const i = row + x;
        if (compId[i] !== c) continue;
        const h = half[i];
        if (h > maxHalf) maxHalf = h;
      }
    }
    if (maxHalf < FLAT_EDGE) continue;
    // 散播半径 ≈ 局部半宽的一半：3σ₁ 支撑 ≈ 1.7·半宽，够盖住整个横截面，又不会伸到相邻
    // 线条上去 —— 伸过去时「别的分量」的墨像素会被跳过，但两条线之间的空隙像素仍会被改写，
    // 通过它们污染邻线的模糊距离场（实测细线 −1.26px、行内 std 0→2.74px）。
    const rSig = clampInt(Math.ceil(maxHalf / (2 * FLAT_GRID)), 2, FLAT_SPREAD_MAX);

    // ---- ② 网格几何：只需覆盖「分量包围盒 + 散播支撑」（低通的边界截断即精确，见 boxBlurInto）----
    const m = 3 * rSig + 2;
    const gx0 = bx0 - m * FLAT_GRID;
    const gy0 = by0 - m * FLAT_GRID;
    const gw = Math.ceil(bw / FLAT_GRID) + 2 * m + 2;
    const gh = Math.ceil(bh / FLAT_GRID) + 2 * m + 2;
    const gN = gw * gh;
    if (bufMc === null || gN > capCells) {
      capCells = gN;
      bufMc = new Float32Array(capCells);
      bufSv = new Float32Array(capCells);
      bufSw = new Float32Array(capCells);
      bufBv = new Float32Array(capCells);
      bufBw = new Float32Array(capCells);
      bufT1 = new Float32Array(capCells);
      bufT2 = new Float32Array(capCells);
      bufRef = new Float32Array(capCells);
      bufMx = new Float32Array(capCells);
      bufMy = new Float32Array(capCells);
      bufMw = new Float32Array(capCells);
      bufTx = new Float32Array(capCells);
      bufTy = new Float32Array(capCells);
      bufTw = new Float32Array(capCells);
      bufCx = new Float32Array(capCells);
      bufCy = new Float32Array(capCells);
    }
    const mc = bufMc as Float32Array, sv = bufSv as Float32Array, sw = bufSw as Float32Array;
    const bv = bufBv as Float32Array, bw2 = bufBw as Float32Array;
    const t1 = bufT1 as Float32Array, t2 = bufT2 as Float32Array;
    const ref = bufRef as Float32Array;
    mc.fill(0, 0, gN);
    const mx = bufMx as Float32Array, my = bufMy as Float32Array, mw = bufMw as Float32Array;
    const tx = bufTx as Float32Array, ty = bufTy as Float32Array, tw = bufTw as Float32Array;
    const cx2 = bufCx as Float32Array, cy2 = bufCy as Float32Array;
    mx.fill(0, 0, gN); my.fill(0, 0, gN); mw.fill(0, 0, gN);

    // ---- ③ 格内取 max（只统计本分量像素，别的分量留下空格）----
    for (let y = by0; y <= by1; y++) {
      const row = y * rw;
      const cro = (((y - gy0) / FLAT_GRID) | 0) * gw;
      for (let x = bx0; x <= bx1; x++) {
        const i = row + x;
        if (compId[i] !== c) continue;
        const h = half[i];
        if (h <= 0) continue;
        const k = cro + (((x - gx0) / FLAT_GRID) | 0);
        if (h > mc[k]) mc[k] = h;
        // 中轴位置：格内 sd 加权质心（供「中轴跟随」使用 —— 单侧凸起时不让平缓的
        // 另一侧被一起推进去）。用线内距离 h 作权重，使质心贴着中轴而非几何中心。
        // 沿轴分量会在 ⑥.5 被投影掉：否则「按宽度加权的低频」会凭空造出假位移。
        mx[k] += h * x; my[k] += h * y; mw[k] += h;
      }
    }

    // ---- ④ 脊线取样：3×3 格邻域内的极大（带容差 —— 脊线是平台而非尖峰）----
    sv.fill(0, 0, gN);
    sw.fill(0, 0, gN);
    tx.fill(0, 0, gN); ty.fill(0, 0, gN); tw.fill(0, 0, gN);
    for (let cy = 1; cy < gh - 1; cy++) {
      const row = cy * gw;
      for (let cx = 1; cx < gw - 1; cx++) {
        const k = row + cx;
        const v = mc[k];
        if (v < FLAT_EDGE) continue;
        let best = v;
        for (let dy = -1; dy <= 1; dy++) {
          const b = k + dy * gw - 1;
          for (let dx = 0; dx < 3; dx++) {
            const q = mc[b + dx];
            if (q > best) best = q;
          }
        }
        if (v >= best - FLAT_RIDGE_EPS) { sv[k] = v; sw[k] = 1; }
        if (v >= best - FLAT_RIDGE_EPS) {
          sv[k] = v; sw[k] = 1;
          tx[k] = mx[k]; ty[k] = my[k]; tw[k] = mw[k];
        }
      }
    }

    // ---- ⑤ 归一化散播 → H1（带外 0），hasH = 权重域 > 0 ----
    boxBlur3(sv, bv, t1, t2, gw, gh, rSig);
    boxBlur3(sw, bw2, t1, t2, gw, gh, rSig);
    for (let k = 0; k < gN; k++) {
      const wsum = bw2[k];
      if (wsum > 1e-6) { mc[k] = bv[k] / wsum; sw[k] = 1; } else { mc[k] = 0; sw[k] = 0; }
    }

    // ---- ⑤.1 中轴位置散播（与 H1 同尺度、同归一化手法）→ mx/my = 中轴坐标场 ----
    boxBlur3(tx, mx, t1, t2, gw, gh, rSig);
    boxBlur3(ty, my, t1, t2, gw, gh, rSig);
    boxBlur3(tw, mw, t1, t2, gw, gh, rSig);
    for (let k = 0; k < gN; k++) {
      const wsum = mw[k];
      if (wsum > 1e-6) { mx[k] = mx[k] / wsum; my[k] = my[k] / wsum; } else { mx[k] = 0; my[k] = 0; }
    }

    // ---- ⑤.5 双侧邻域参照 Href（H1 沿两轴的「两侧都至少有 W 那么宽」最大 W）----
    // 见 ⑥ 的门槛：只有两侧都没有粗段的窄段（长细支、毛笔尖）才豁免拉平；被粗段夹住
    // 的窄段（凹陷、腰）即使自身很细也参与补偿 —— 这正是「凹陷获得补偿」的开关。
    twoSidedMaxInto(mc, ref, t1, gw, gh, rRef);

    // ---- ⑥ 归一化低通 → H2 → Δ（只在散播带内定义）----
    boxBlur3(mc, bv, t1, t2, gw, gh, rLow);
    boxBlur3(sw, bw2, t1, t2, gw, gh, rLow);
    for (let k = 0; k < gN; k++) {
      if (sw[k] === 0) { mc[k] = 0; continue; }
      // 明显细于本分量主体的段落（发丝、T 形细支、毛笔尖）不参与拉平：
      // 同一个连通域内宽度场是共享的，细支的 H2 会被主体的粗段抬高 ⇒ Δ<0 把它撑胖
      // （实测 3px 发丝接在 20px 粗杠上，整条被撑到 5px）。语义上也说得通：
      // 「粗细起伏」只对接近主体宽度的段落成立，真·细支不是起伏。
      // ⚠️ 参照必须是双侧邻域 Href，不能用分量全局 maxHalf（2026-09-18 二次修复）：
      // 凸起会把 maxHalf 抬高，于是同一分量里「被粗段夹住的凹陷」也低于 0.35·maxHalf 而
      // 被整段豁免（实测凹陷中心 Δ=0、宽度完全不动）—— 而凹陷恰恰是最需要补偿的。
      // 换成 Href 后：凹陷的窗口里两侧都能看到粗段 ⇒ 照常参与（Δ<0 把两侧推出去）；
      // 长细支的窗口里反方向始终是细段 ⇒ 仍然豁免。判据从「有多细」变成「两侧是否都粗」。
      if (ref[k] < FLAT_BODY_RATIO * maxHalf) { mc[k] = 0; continue; }
      const wsum = bw2[k];
      const h1 = mc[k];
      const h2 = wsum > 1e-6 ? bv[k] / wsum : h1;
      let d = h1 - h2;
      // 限幅参照同样用 Href：凹陷自身的 h1 很小，按 0.5·h1 卡死等于「只许削平不许补」。
      // 窗口含自身 ⇒ Href ≥ h1 恒成立 ⇒ 凸起与均匀段的限幅与旧版逐值一致。
      const lim = FLAT_CLAMP_FRAC * ref[k];
      if (d > lim) d = lim; else if (d < -lim) d = -lim;
      if (d > FLAT_CLAMP_PX) d = FLAT_CLAMP_PX; else if (d < -FLAT_CLAMP_PX) d = -FLAT_CLAMP_PX;
      mc[k] = d;
    }

    // ---- ⑦ 双线性采样 Δ 并偏置 sd ----
    // ---- ⑥.5 中轴位移 δc：把「中轴相对其低频的位移」按轮廓朝向分配到两侧 ----
    // 为什么需要：Δ=H1−H2 是「半宽超额」，而半宽是两侧共用的标量 ⇒ sd -= Δ 对两侧一视同仁，
    // 中轴被迫留在原地。于是「只有一侧凸起」时，平缓的另一侧被无辜内推同样多
    // （实测左轮廓 253→255，用户看到的正是这一侧被拉出的凹陷）。
    // 正确语义：目标轮廓 = 两侧各自沿走向的低频。设 δh = H1−H2、δc = c − c_low，则
    // 左轮廓内推量 = δh − δc，右轮廓内推量 = δh + δc。分侧不需要显式走向/主轴：
    // half 的梯度在轮廓处恒指向线内（左轮廓 +t、右轮廓 −t），δc·ĝ 自动带符号。
    // δc → 0（两侧对称 / 中轴无起伏）时退化为旧行为 ⇒ 逐值一致；死区兜住质心估计的亚像素噪声。
    // 走向用包围盒长边近似（长宽比不足 FLAT_AXIS_RATIO 时判不准 ⇒ 整体退化，不冒风险）。
    const axisRatio = bw > bh ? bw / bh : bh / bw;
    const axisLocked = axisRatio >= FLAT_AXIS_RATIO;
    const alongY = bh >= bw;
    // 沿轴线性去趋势：中轴「沿走向的平移」属于走向本身，不是宽度起伏；而低通半径是
    // 有限的，两端窗口被截断时会把这个线性趋势误读成位移（斜线实测 ~4px，与真实起伏同量级，
    // 足以让等宽斜线被凭空改形）。逐「垂直于轴的通道」做最小二乘直线拟合后减去。
    if (axisLocked) {
      const lat = alongY ? mx : my;
      // ⚠️ 通道必须是「平行于轴」的一条线：扁平下标 k = gy·gw + gx，
      // 所以固定 gx、沿 y 变化时步长是 gw，固定 gy、沿 x 变化时步长才是 1。
      // 写反会退化成一串「按行主序斜穿网格」的格子 —— 它横跨笔画、x 质心值剧烈跳变，
      // 拟合出的假斜率会把 δc 凭空抬到几像素（对称/均匀笔触全被改形）。
      const nA = alongY ? gh : gw;
      const stride = alongY ? gw : 1;
      const lanes = alongY ? gw : gh;
      for (let ln = 0; ln < lanes; ln++) {
        const base = alongY ? ln : ln * gw;
        let cnt = 0, s1 = 0, s2 = 0, s11 = 0, s12 = 0;
        for (let t = 0; t < nA; t++) {
          const k = base + t * stride;
          if (sw[k] === 0) continue;
          cnt++; s1 += t; s2 += lat[k]; s11 += t * t; s12 += t * lat[k];
        }
        if (cnt < 4) continue;
        const den = cnt * s11 - s1 * s1;
        if (den < 1e-6) continue;
        const slope = (cnt * s12 - s1 * s2) / den;
        const icept = (s2 - slope * s1) / cnt;
        for (let t = 0; t < nA; t++) { const k = base + t * stride; if (sw[k] !== 0) lat[k] -= slope * t + icept; }
      }
    }
    boxBlur3(mx, cx2, t1, t2, gw, gh, rLow);
    boxBlur3(my, cy2, t1, t2, gw, gh, rLow);
    boxBlur3(sw, tw, t1, t2, gw, gh, rLow);
    for (let k = 0; k < gN; k++) {
      if (sw[k] === 0) { mx[k] = 0; my[k] = 0; continue; }
      const wsum = tw[k];
      if (wsum <= 1e-6) { mx[k] = 0; my[k] = 0; continue; }
      let dcx = mx[k] - cx2[k] / wsum;
      let dcy = my[k] - cy2[k] / wsum;
      if (!axisLocked) { dcx = 0; dcy = 0; }
      else if (alongY) { dcy = 0; }
      else { dcx = 0; }
      const dcm = Math.sqrt(dcx * dcx + dcy * dcy);
      if (dcm <= FLAT_CENTER_DEAD) { dcx = 0; dcy = 0; }
      else {
        const scl = dcm > FLAT_CENTER_CLAMP ? FLAT_CENTER_CLAMP / dcm : 1 - FLAT_CENTER_DEAD / dcm;
        dcx *= scl; dcy *= scl;
      }
      mx[k] = dcx; my[k] = dcy;
    }

    const em = (3 * rSig + 1) * FLAT_GRID;
    const ax0 = bx0 - em > 0 ? bx0 - em : 0;
    const ay0 = by0 - em > 0 ? by0 - em : 0;
    const ax1 = bx1 + em < rw - 1 ? bx1 + em : rw - 1;
    const ay1 = by1 + em < rh - 1 ? by1 + em : rh - 1;
    for (let y = ay0; y <= ay1; y++) {
      const v = (y - gy0) / FLAT_GRID - 0.5;
      let j0 = Math.floor(v);
      if (j0 < 0) j0 = 0; else if (j0 > gh - 2) j0 = gh - 2;
      const fy = v - j0;
      const rowA = j0 * gw, rowB = rowA + gw;
      const grow = y * rw;
      for (let x = ax0; x <= ax1; x++) {
        const i = grow + x;
        const other = compId[i];
        if (other !== 0 && other !== c) continue;   // 不碰别的分量的墨像素
        const u = (x - gx0) / FLAT_GRID - 0.5;
        let i0 = Math.floor(u);
        if (i0 < 0) i0 = 0; else if (i0 > gw - 2) i0 = gw - 2;
        const fx = u - i0;
        const a00 = mc[rowA + i0], a10 = mc[rowA + i0 + 1];
        const a01 = mc[rowB + i0], a11 = mc[rowB + i0 + 1];
        const top = a00 + (a10 - a00) * fx;
        const bot = a01 + (a11 - a01) * fx;
        let d = top + (bot - top) * fy;
        // 中轴跟随：δc 按轮廓朝向（∇half 指向线内）分给两侧 —— 见 ⑥.5。
        // src/tmp 不冲突：half 在本函数内只读，故可安全用于中心差分。
        {
          const e00 = mx[rowA + i0], e10 = mx[rowA + i0 + 1];
          const e01 = mx[rowB + i0], e11 = mx[rowB + i0 + 1];
          const f00 = my[rowA + i0], f10 = my[rowA + i0 + 1];
          const f01 = my[rowB + i0], f11 = my[rowB + i0 + 1];
          const xA = e00 + (e10 - e00) * fx, xB = e01 + (e11 - e01) * fx;
          const yA = f00 + (f10 - f00) * fx, yB = f01 + (f11 - f01) * fx;
          const dcx = xA + (xB - xA) * fy;
          const dcy = yA + (yB - yA) * fy;
          // ⚠️ 中轴跟随只「重新分配」本像素既有的拉平量，绝不新增位移 ⇒ 重分配量硬性封顶为 |Δ|。
          // 推导：Δc=(ΔL+ΔR)/2、Δh=(ΔR−ΔL)/2 ⇒ 任何真实变形都有 |δc| ≤ |δh|（等号=单侧变形，
          // δc≡0=两侧对称）；而纯平移/纯路径弯曲（宽度没变 ⇒ Δ≈0）立刻被压到 0。
          // 缺了这条封顶，低频中轴是「弦」的弯曲笔画会被整段推走：等宽长弧实测 δh=0.79 而
          // δc 被 FLAT_CENTER_CLAMP 顶到饱和 12 ⇒ 左轮廓 d=−8.65、右 +10.23（位移 5px）。
          const ad = d < 0 ? -d : d;
          if ((dcx !== 0 || dcy !== 0) && ad > 0 && x > 0 && x < rw - 1 && y > 0 && y < rh - 1) {
            const hgx = half[i + 1] - half[i - 1];
            const hgy = half[i + rw] - half[i - rw];
            const hgm = Math.sqrt(hgx * hgx + hgy * hgy);
            if (hgm > 1e-4) {
              const dcm = Math.sqrt(dcx * dcx + dcy * dcy);
              const sc = dcm > ad ? ad / dcm : 1;
              d -= sc * (dcx * hgx + dcy * hgy) / hgm;
            }
          }
        }
        if (d !== 0) sd[i] -= d;
      }
    }
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

export const defaultLineSmoothParams: LineSmoothParams = {
  strength: 1,        // 平滑力度 100%
  radius: 8,          // 轮廓平滑 8px
  flattenRadius: 0    // 宽度拉平 0 = 关闭（默认与旧版逐字节一致）
};

// ================= 工具：面积开运算 =================
// 原「半径 2 二值开运算」已删除：它是**按结构元宽度筛**的算子，会把线宽 < 5px 的线条
// 整体抹掉，与「细线也应被平滑」的目标直接冲突（详见 Phase A 注释）。
// 现在的面积开运算由 Phase A.5 的 8 连通域标注给出（面积 < SPECK_MAX 的分量即
// isSpeck），Phase A 据此构造 lineMaskClean —— 判据只看面积，与线宽无关。

