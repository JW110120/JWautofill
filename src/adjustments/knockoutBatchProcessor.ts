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
 * *   · 扣黑：Invert → 载入亮度选区 → Clear → 复制 N 份合并（增强 alpha，得到
 *     可靠的内容/背景遮罩）→ Invert 回来。关键点：反色往返会把 straight 图层
 *     “解除预乘”——内容图层 X=(x,a) 经往返后变成 (x,1)，放在黑底上观感是
 *     x（而非原 X 在黑底上的 x·a），故明显偏亮。因此最后用处理前抓取的
 *     预乘值 rgb·(alpha/255) 覆盖 RGB、遮罩内 alpha 置 255，使 Z 在黑底上的
 *     观感 == 原图层在黑底上的观感（严格相等，误差 0）。N 动态计算(clamp[3,40])
 *     仅为保证内容遮罩可靠，不影响黑底观感。
 *   · 扣白：载入亮度选区 → Clear → 复制 N 份合并。N 至少 7 份（用户验证），
 *     保证合并后 alpha ≥ 99.5%，白底观感误差 < 1/255。
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

/** 清除选区像素。 */
async function clearSelection(): Promise<void> {
  await action.batchPlay([{ _obj: 'delete', _options: { dialogOptions: 'dontDisplay' } }], {});
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
 * 返回 merge 合并后的图层对象——UXP 在 merge 后 activeLayers getter 可能短暂
 * 返回空，故用 merge() 的真实返回值，不要再去读 activeDocument.activeLayers。
 */
async function duplicateAndMergeDown(n: number, startLayer: any) {
  let current = startLayer; // 由调用方传入已校验的活动图层（doc.activeLayers[0]）
  for (let i = 1; i < n; i++) {
    const dup = await current.duplicate(); // 副本成为活动图层，紧邻原图层上方
    current = await dup.merge();            // 向下合并（等效 Ctrl+E），返回合并后的图层
  }
  return current;
}

/**
 * 抓取图层每个像素的「预乘 RGB」= rgb · (alpha/255)。
 * 这就是该像素放在纯黑底上的观感（黑底合成值），也是扣黑结果在黑底上
 * 必须还原的目标值。getPixels 返回的是 straight(alpha 未预乘) 数据，
 * 故此处手动乘以 alpha 得到预乘值。
 */
interface CapturedPremult {
  premult: Uint8ClampedArray; // 长度 = w·h·4，rgb = 原 rgb·alpha/255，alpha 固定 255
  left: number; top: number; right: number; bottom: number;
  width: number; height: number;
}
async function capturePremultiplied(layer: any): Promise<CapturedPremult> {
  const b = layer.bounds;
  const width = b.right - b.left;
  const height = b.bottom - b.top;
  if (width <= 0 || height <= 0) {
    return { premult: new Uint8ClampedArray(0), left: b.left, top: b.top, right: b.right, bottom: b.bottom, width, height };
  }
  const px = await imaging.getPixels({
    documentID: app.activeDocument.id,
    layerID: layer.id,
    sourceBounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
    targetSize: { width, height }
  });
  const data = new Uint8ClampedArray(await px.imageData.getData());
  px.imageData.dispose();

  const premult = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * 4;
    const a = data[s + 3] / 255;
    premult[s]     = Math.round(data[s]     * a);
    premult[s + 1] = Math.round(data[s + 1] * a);
    premult[s + 2] = Math.round(data[s + 2] * a);
    premult[s + 3] = 255;
  }
  return { premult, left: b.left, top: b.top, right: b.right, bottom: b.bottom, width, height };
}

/**
 * 把抓取的预乘值写回最终图层，并按 knockout 产出的遮罩二值化 alpha：
 *   遮罩内（内容）→ rgb = premult，alpha = 255
 *   遮罩外（背景）→ 全 0（透明）
 * 这样 Z 在黑底上的观感 = premult·1 = 原图层在黑底上的观感（严格相等），
 * 彻底消除反色往返带来的「解除预乘 → 黑底偏亮」问题。
 */
async function applyPremultiplied(layer: any, cap: CapturedPremult): Promise<void> {
  if (cap.width <= 0 || cap.height <= 0) return;
  const doc = app.activeDocument;
  const docW = Number(doc.width);
  const docH = Number(doc.height);

  // 与 pixelDataProcessor「针对普通像素的逻辑分支」完全一致：
  // 以 mergedLayer 的【实时 bounds】读取内容遮罩，而非 stale 的 cap。
  // 该分支正是用 sourceBounds: layer.bounds 取值，避免坐标错位导致写入异常。
  const b = layer.bounds;
  const mw = b.right - b.left;
  const mh = b.bottom - b.top;
  if (mw <= 0 || mh <= 0) return;

  const px = await imaging.getPixels({
    documentID: doc.id,
    layerID: layer.id,
    sourceBounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
    targetSize: { width: mw, height: mh }
  });
  const maskData = new Uint8ClampedArray(await px.imageData.getData());
  px.imageData.dispose();

  // 文档全尺寸写回缓冲：仅在内容遮罩内填 premult，其余保持透明(0)。
  // 透明区域不计入图层 bounds，故图层尺寸不会被撑成文档宽高。
  const out = new Uint8Array(docW * docH * 4);
  for (let i = 0; i < mw * mh; i++) {
    if (maskData[i * 4 + 3] > 0) {
      const lx = i % mw;
      const ly = (i / mw) | 0;
      const dx = b.left + lx;
      const dy = b.top + ly;
      if (dx < 0 || dy < 0 || dx >= docW || dy >= docH) continue;
      // 用文档坐标反查 cap 中的预乘值（两图层几何一致时一一对应，
      // 即便有轻微错位也按偏移安全跳过，不会越界写入）
      const cx = dx - cap.left;
      const cy = dy - cap.top;
      if (cx < 0 || cy < 0 || cx >= cap.width || cy >= cap.height) continue;
      const cIdx = (cy * cap.width + cx) * 4;
      const dIdx = (dy * docW + dx) * 4;
      out[dIdx]     = cap.premult[cIdx];
      out[dIdx + 1] = cap.premult[cIdx + 1];
      out[dIdx + 2] = cap.premult[cIdx + 2];
      out[dIdx + 3] = 255; // 内容像素：预乘值 + 实底 alpha
    }
  }

  const img = await imaging.createImageDataFromBuffer(out, {
    width: docW,
    height: docH,
    colorSpace: 'RGB',
    pixelFormat: 'RGBA',
    components: 4,
    componentSize: 8
  });
  await imaging.putPixels({
    documentID: doc.id,
    layerID: layer.id,
    imageData: img,
    targetBounds: { left: 0, top: 0, right: docW, bottom: docH }
  });
  img.dispose();
}

/**
 * 执行扣白 / 扣黑（batchPlay 版）。
 * 扣白：载入亮度选区 → Clear → 复制 N 份合并。
 * 扣黑：Invert → (同上) → Invert。N 动态计算（内容暗时自动增大）。
 * 调用方须保证：普通像素图层、已处于 executeAsModal 作用域。
 * 整段操作通过 doc.suspendHistory 合并为【一条】历史记录（反色/载入选区/
 * Clear/复制合并/像素写回全部归入同一历史态，不再产生一长串历史项）。
 */
export async function runKnockoutBatch(mode: KnockoutBatchMode): Promise<void> {
  const doc = app.activeDocument;
  if (!doc) {
    throw new Error('未找到活动文档，请先打开一个包含普通像素图层的文档后再试。');
  }
  const layer = doc.activeLayers[0];
  if (!layer) {
    throw new Error('未找到活动图层，请先选中一个普通像素图层（不支持背景图层）。');
  }
  const historyName = mode === 'white' ? '扣白' : '扣黑';

  // 用 suspendHistory 把整段操作（反色 / 载入选区 / Clear / 复制合并 / 像素写回）
  // 合并成【一条】历史记录，避免生成一长串历史项。suspendHistory 本身是
  // executeAsModal 的封装，可直接在调用方已有的 executeAsModal 作用域内嵌套使用。
  await doc.suspendHistory(async () => {
    const origName = layer.name;

    // 扣黑：处理前先抓取原图预乘值（黑底观感），用于事后还原，
    // 抵消反色往返带来的“解除预乘 → 黑底偏亮”问题。
    let premultCap: CapturedPremult | null = null;
    if (mode === 'black') {
      premultCap = await capturePremultiplied(layer);
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

    // 4) 复制 N 份并合并，增强 alpha 至收敛（返回合并后的图层对象）
    const mergedLayer = await duplicateAndMergeDown(copies, layer);

    if (mode === 'black') {
      // 反色回来：还原为黑底语义的 RGB
      await invertLayer();
      // 用抓取的预乘值覆盖 RGB，使 Z 在黑底上的观感 = 原图层在黑底上的观感
      if (premultCap) {
        await applyPremultiplied(mergedLayer, premultCap);
      }
    }

    // 5) 恢复图层名（merge 后名字变成 “xxx copy”）
    //    优先用 merge() 返回的图层对象；兜底再读 activeDocument.activeLayers[0]，
    //    两者均用可选链，避免任何情况下触发 “reading 'name'”。
    try {
      const target = mergedLayer ?? app.activeDocument?.activeLayers?.[0];
      if (target && target.name !== origName) {
        target.name = origName;
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
  }, historyName);
}
