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
 *            —— sd/lineMask/密度覆盖 在一个「处理窗口」内计算；窗口 = 选区包围盒 + halo，
 *            窗口外的像素不参与、也不影响窗口内结果。选区只决定「哪些像素允许写回」。
 *            窗口必须比选区外扩 halo，否则选区边界处的线条会被当成断口，
 *            产生「选区边缘透明环」bug。
 *   Phase B  高斯平滑 sd（几何抛光）+ 高斯平滑原 alpha（密度抛光）
 *   Phase C  由 sd_blur 重建反锯齿覆盖 cov（决定平滑轮廓形状+抗锯齿），再乘密度：
 *            · 原线像素 → 抛光后的真实密度（保留笔压深浅）
 *            · 原为背景/孔洞像素 → 用「最近原线像素的 alpha」作为密度，而非原始 alpha 的高斯光晕，
 *              避免线外因光晕泄漏产生游离杂点；同时平滑新增的边缘/内部孔洞得到干净填充
 *   Phase D  去杂点剪枝（只清孤立/单连接像素）
 *   Phase E  原线连通域标记：对 lineMask 做 8 连通分量标注并记录面积，供 Phase E.5/写回判定
 *   Phase F  写回（仅选区；原线 RGB 直通，背景绝对保持；被 SDF 判为线外且属于「已覆盖分量」
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
  /** 平滑范围 px（UI 3~12，默认 8）。σ 上限与抗锯齿带宽参考 */
  radius?: number;
}

const THR = 16;                 // 线条二值化阈值
const SPECK_MAX = 10;           // 游离杂点判定：原线掩码中 8 连通域面积 < 该值 → 杂点
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
  const radius = clampInt(Math.round(typeof params.radius === 'number' ? params.radius : 8), 3, 12);

  // ---- 平滑力度 → 高斯 σ ----
  // σ 控制在「小于线宽」范围：宽线条(>2σ)基本不收缩，仅细小毛刺被清理。
  // 上限放宽到 3.2，以便更充分地抛光边缘锯齿/杂点。
  const sigma = clamp(1.0 + strength * radius * 0.25, 0.8, 3.2);
  const sigmaBody = clamp(sigma * 0.55, 0.7, radius); // 密度抛光（轻抛，保留更多笔压）
  const band = Math.max(0.7, radius * 0.13);          // 抗锯齿软边过渡带宽(px)
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
  const halo = Math.max(8, 2 * kernelRadius + 8);
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

  // ================= Phase A：形态学前置清理 + 有符号距离场 =================
  // 先用半径 2 开运算（腐蚀→膨胀）去掉原线稿边缘 1~2px 孤立杂点/毛刺，
  // 再建 SDF。这样锯齿/碎点不会作为「线内实体」被保留，对 20px 左右粗线影响很小。
  const lineMaskClean = binaryOpen(lineMask, rw, rh, 2);
  // SDF 在整个窗口内连续计算（不按选区截断），保证选区边界两侧的距离场连续
  const sd = buildSignedDistance(lineMaskClean, rw, rh);

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
      if (size < SPECK_MAX) {
        for (let k = begin; k < tail; k++) isSpeck[stack[k]] = 1;
      }
    }
  }

  // ================= Phase B：几何 + 密度抛光 =================
  const scratch = new Float32Array(rn);
  const sdB = new Float32Array(rn);
  gaussianBlur(sd, rw, rh, sigma, scratch, sdB);
  const bodyBlur = new Float32Array(rn);
  gaussianBlur(alpha, rw, rh, sigmaBody, scratch, bodyBlur);

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
      const cov = smoothstep((sdB[i] - T) / band);   // 0..1 覆盖（边界软过渡→抗锯齿）
      // 密度：原线像素用抛光真实密度；非原线像素用最近原线 alpha（与洪泛取色同源的局部密度）
      let density: number;
      if (alpha[i] > THR) {
        density = bodyBlur[i] * bodyScale;
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
function buildSignedDistance(lineMask: Uint8Array, w: number, h: number): Float32Array {
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
    sd[i] = lineMask[i] ? Math.sqrt(dIn2[i]) : -Math.sqrt(dLine2[i]);
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
  strength: 1,   // 平滑力度 100%
  radius: 8      // 平滑范围 8px
};

// ================= 工具：半径 r 二值开运算（去 rpx 边缘杂点/毛刺） =================
// 语义与逐邻居扫描版完全一致（越界邻居「跳过」= 只看裁剪后有效的邻居），
// 但用积分图把每次 25 次邻居访问压成 4 次查表。
// 旧实现把循环限制在 [r, h-r)，导致画布边缘 r 像素条带整体变 0（贴边线条被挖出缺口）；
// 现全范围处理，越界邻居不计入：腐蚀阶段不因越界而失败（贴边线条不被腐蚀），
// 膨胀阶段不因越界而命中。
function binaryOpen(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const n = w * h;
  const stride = w + 1;
  const S = new Int32Array((w + 1) * (h + 1));
  const buildSum = (data: Uint8Array) => {
    for (let y = 0; y < h; y++) {
      const srcRow = y * w;
      const curRow = (y + 1) * stride;
      const prevRow = y * stride;
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += data[srcRow + x];
        S[curRow + x + 1] = S[prevRow + x + 1] + rowSum;
      }
    }
  };

  const eroded = new Uint8Array(n);
  buildSum(src);
  for (let y = 0; y < h; y++) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r + 1 > h ? h : y + r + 1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!src[row + x]) continue;
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r + 1 > w ? w : x + r + 1;
      const area = (y1 - y0) * (x1 - x0);
      // 仅当裁剪后的邻域全是线内才算腐蚀保留
      if (S[y1 * stride + x1] - S[y0 * stride + x1] - S[y1 * stride + x0] + S[y0 * stride + x0] === area) {
        eroded[row + x] = 1;
      }
    }
  }

  const opened = new Uint8Array(n);
  buildSum(eroded);
  for (let y = 0; y < h; y++) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r + 1 > h ? h : y + r + 1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (eroded[row + x]) { opened[row + x] = 1; continue; }
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r + 1 > w ? w : x + r + 1;
      if (S[y1 * stride + x1] - S[y0 * stride + x1] - S[y1 * stride + x0] + S[y0 * stride + x0] > 0) {
        opened[row + x] = 1;
      }
    }
  }
  return opened;
}
