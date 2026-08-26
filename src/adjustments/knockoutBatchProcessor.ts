/**
 * 扣白 / 扣黑 —— batchPlay 版（替代原像素级 knockoutProcessor，原算法弃用）。
 *
 * 思路来源（用户手动验证）：
 *   图层 X 与纯白底合并得 Y（Y = X·a + 白·(1−a)）。
 *   对 Y 按 Ctrl+点击 RGB 复合通道 → 载入“亮度选区”（越接近白选中越多）
 *   → Delete 清除亮部 → 得到 P（内容保留、背景透明，alpha = 1 − 亮度）
 *   → 复制 P 为 N 份并合并 → alpha 按 1−(1−a)^N 增强，得到近似 X 的图层。
 *
 * 数学说明（为什么能“还原”）：
 *   · 扣白：Y 上越接近背景（白）的像素 alpha 越低，Delete 亮部后
 *     alpha = 1 − luma(Y)。复制 N 份合并后 alpha = 1 − luma(Y)^N，
 *     N 足够大时该图层放在白底上的视觉 ≈ 原 Y（≈ X 在白底上的视觉）。
 *   · 扣黑（关键纠正）：黑底合成 Z = X·a（RGB 是“预乘”暗色），用户原来
 *     对 Z“选亮部→反选→删暗部”的 alpha 恢复方向对，但 Z 上内容亮度低
 *     ⇒ 单份 alpha 小 ⇒ 同样 N=7 时合并后 alpha 远未收敛（黑底上暗色
 *     内容对 alpha 误差非常敏感）⇒ 结果明显偏暗。
 *     纠正 = 反色法：Z ——Invert--> Z'（= 反色 X 的白底合成）→ 走与扣白
 *     完全相同的流程 → Invert 回来。数学上与用户原操作等价，但语义与
 *     扣白对称；更关键的是份数 N 按内容亮度动态计算（clamp [3,40]），
 *     保证合并后 alpha ≥ 99.5%，黑底视觉误差 < 1/255。
 *
 * 实现（均等效用户手动操作）：
 *   · batchPlay set selection from channel RGB —— Ctrl+点击 RGB 复合通道
 *   · batchPlay clear —— Delete 键（部分选区 alpha *= 1 − 选区强度）
 *   · batchPlay invert —— Ctrl+I 反色（只反 RGB，不动 alpha）
 *   · UXP DOM Layer.duplicate() / Layer.merge() —— 复制 / 向下合并（Ctrl+E）
 */
import { action, app, imaging } from 'photoshop';

export type KnockoutBatchMode = 'white' | 'black';

/** 载入 RGB 复合通道为选区（等效 Ctrl+点击通道面板 RGB 缩略图）。 */
async function loadRGBChannelSelection(): Promise<void> {
  await action.batchPlay(
    [
      {
        _obj: 'set',
        _target: [{ _ref: 'channel', _property: 'selection' }],
        to: { _ref: 'channel', _enum: 'channel', _value: 'RGB' },
        _options: { dialogOptions: 'dontDisplay' }
      }
    ],
    {}
  );
}

/** 清除选区像素（等效 Delete 键；对部分选区 alpha *= (1 − 选区强度)）。 */
async function clearSelection(): Promise<void> {
  await action.batchPlay([{ _obj: 'clear', _options: { dialogOptions: 'dontDisplay' } }], {});
}

/** 反色图层内容（等效 Ctrl+I；只反 RGB，不影响 alpha）。 */
async function invertLayer(): Promise<void> {
  await action.batchPlay([{ _obj: 'invert', _options: { dialogOptions: 'dontDisplay' } }], {});
}

/** 取消选区（等效 Ctrl+D）。 */
async function deselect(): Promise<void> {
  await action.batchPlay(
    [
      {
        _obj: 'set',
        _target: [{ _ref: 'channel', _property: 'selection' }],
        to: { _enum: 'ordinal', _value: 'none' },
        _options: { dialogOptions: 'dontDisplay' }
      }
    ],
    {}
  );
}

/**
 * 根据当前亮度选区的灰度分布，估算需要的复制份数 N：
 *   目标：合并后内容区域 alpha ≥ 99.5%（黑底视觉误差 < 1/255）。
 *   单份 alpha = 1 − 灰度/255（Clear 后的 alpha）。
 *   取内容区域（灰度 ∈ (0,255)）alpha 的 5% 分位为最坏情况，
 *   忽略最极端的近透明噪点（它们视觉上本来就接近背景）。
 */
async function estimateCopies(minCopies: number, maxCopies = 40): Promise<number> {
  try {
    const doc = app.activeDocument;
    const width = doc.width;
    const height = doc.height;
    const pixels = await imaging.getSelection({
      documentID: doc.id,
      sourceBounds: { left: 0, top: 0, right: width, bottom: height },
      targetSize: { width, height }
    });
    const data = new Uint8Array(await pixels.imageData.getData());
    pixels.imageData.dispose();

    const alphas: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const g = data[i];
      if (g > 0 && g < 255) alphas.push(1 - g / 255);
    }
    if (alphas.length === 0) return minCopies; // 整图纯白/纯黑，无内容

    alphas.sort((a, b) => a - b);
    const aMin = alphas[Math.min(alphas.length - 1, Math.floor(alphas.length * 0.05))];
    if (aMin <= 0.02) return maxCopies; // 内容几乎全透明：直接顶格
    // 1 − (1 − aMin)^N ≥ 0.995  ⇒  N ≥ ln(0.005) / ln(1 − aMin)
    const n = Math.ceil(Math.log(0.005) / Math.log(1 - aMin));
    return Math.max(minCopies, Math.min(maxCopies, n));
  } catch (err) {
    console.warn('⚠️ 选区灰度统计失败，使用默认份数:', err);
    return minCopies;
  }
}

/**
 * 把当前图层“复制 N 份并合并”为单图层：
 *   每轮 duplicate（副本在上）+ merge（向下合并，副本+原图层），
 *   N 层同内容叠加后 alpha = 1 − (1 − a)^N，RGB 不变。
 * 使用 UXP DOM 的 Layer.duplicate() / Layer.merge()（官方 API，行为稳定）。
 */
async function duplicateAndMergeDown(n: number): Promise<void> {
  const doc = app.activeDocument;
  for (let i = 1; i < n; i++) {
    await doc.activeLayer.duplicate(); // 副本成为活动图层，紧邻原图层上方
    await doc.activeLayer.merge();     // 向下合并（等效 Ctrl+E）
  }
}

/**
 * 执行扣白 / 扣黑（batchPlay 版）。
 * 扣白：载入亮度选区 → Clear → 复制 N 份合并。
 * 扣黑：Invert → (同上) → Invert。N 动态计算（内容暗时自动增大）。
 * 调用方须保证：普通像素图层、已处于 executeAsModal 作用域。
 */
export async function runKnockoutBatch(mode: KnockoutBatchMode): Promise<void> {
  const doc = app.activeDocument;
  const layer = doc.activeLayer;
  const origName = layer.name;

  if (mode === 'black') {
    // 反色：把“黑底合成”变成“反色内容的白底合成”，复用扣白流程
    await invertLayer();
  }

  // 1) 载入 RGB 复合通道亮度选区（等效 Ctrl+点击）
  await loadRGBChannelSelection();

  // 2) 按内容亮度动态估算复制份数：扣白至少 7 份（用户验证），扣黑至少 3 份
  const copies = await estimateCopies(mode === 'white' ? 7 : 3);
  console.log(`🎯 扣${mode === 'white' ? '白' : '黑'}: 复制份数 N = ${copies}`);

  // 3) Delete 清除亮部 → 内容保留、背景透明
  await clearSelection();

  // 4) 复制 N 份并合并，增强 alpha 至收敛
  await duplicateAndMergeDown(copies);

  if (mode === 'black') {
    // 反色回来：还原为黑底语义的 RGB
    await invertLayer();
  }

  // 5) 恢复图层名（mergeLayers 后名字变成 “xxx copy”）
  try {
    if (app.activeDocument.activeLayer.name !== origName) {
      app.activeDocument.activeLayer.name = origName;
    }
  } catch (err) {
    console.warn('⚠️ 恢复图层名失败:', err);
  }

  // 6) 取消残留选区，保持面板干净
  try {
    await deselect();
  } catch (err) {
    console.warn('⚠️ 取消选区失败:', err);
  }
}
