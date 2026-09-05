import { action, app, imaging } from 'photoshop';
import { processLineSmooth } from './lineSmoothProcessor';

/*
  这个文件实现「边缘平滑」功能，分成两种用户能理解的模式：

  1) 仅色块边界（edge）——本文件实现
     目标：让色块边界更干净、更“磨平”，但不要让用户看出选区边界。
     做法：用 Photoshop 自带的「中间值（median）」滤镜生成参考结果（读取后立即撤销），
           对整个选区写回 median 结果，并在选区边缘做渐隐，避免出现“选区边界感”。

  2) 仅主线条（line）——已下沉到 lineSmoothProcessor
     本文件只做参数转发，不再保留任何线条平滑实现。
     算法：有符号距离场(SDF)高斯平滑（纯像素算法，不依赖 PS 滤镜）。
*/

/*
  边缘平滑的参数说明（面板当前只暴露这三个参数，不支持旧预设）：
  - mode：edge=仅色块边界（本文件实现）；line=仅主线条（转发给 lineSmoothProcessor）
  - edgeMedianRadius：色块边界的中间值半径（PS median 半径）——仅 edge 使用
  - lineSmoothStrength / lineSmoothRadius：主线条平滑的力度(0~1) / 范围(px)——仅 line 使用
*/
interface EdgeDetectionParams {
  mode?: 'edge' | 'line';
  edgeMedianRadius?: number;
  lineSmoothStrength?: number;
  lineSmoothRadius?: number;
}

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));
const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v));

type PhotoshopContext = { documentID: number; layerID: number };

/*
  Photoshop 的 getPixels 可能返回 RGB 或 RGBA。
  为了让后续处理逻辑统一，这里把输入统一成 RGBA（缺失的 A 默认 255）。
*/
function normalizePixelsToRGBA(
  raw: Uint8Array,
  pixelCount: number
): Uint8Array {
  const bpp = pixelCount > 0 ? raw.length / pixelCount : 0;
  if (bpp === 4) return raw;
  if (bpp === 3) {
    const rgba = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      const s = i * 3;
      const d = i * 4;
      rgba[d] = raw[s] || 0;
      rgba[d + 1] = raw[s + 1] || 0;
      rgba[d + 2] = raw[s + 2] || 0;
      rgba[d + 3] = 255;
    }
    return rgba;
  }
  const rgba = new Uint8Array(pixelCount * 4);
  rgba.fill(0);
  for (let i = 0; i < pixelCount; i++) rgba[i * 4 + 3] = 255;
  return rgba;
}

/*
  把图层 bounds 规整成整数像素矩形（文档坐标系）。
  UXP 的 Layer.bounds 理论上已是像素，但图层被滤镜/变换后可能带小数，这里统一取整。
*/
function normalizeLayerBounds(raw: any): { left: number; top: number; right: number; bottom: number } | null {
  if (!raw) return null;
  const left = Math.round(Number(raw.left));
  const top = Math.round(Number(raw.top));
  const right = Math.round(Number(raw.right));
  const bottom = Math.round(Number(raw.bottom));
  if (![left, top, right, bottom].every((v) => Number.isFinite(v))) return null;
  return { left, top, right, bottom };
}

function findLayerByIdRecursive(layers: any[], layerId: number): any | null {
  for (const layer of layers || []) {
    if (!layer) continue;
    if (layer.id === layerId) return layer;
    const children = (layer as any).layers;
    if (children && children.length > 0) {
      const hit = findLayerByIdRecursive(children, layerId);
      if (hit) return hit;
    }
  }
  return null;
}

/*
  读取某个图层的实时像素 bounds（文档坐标系，单位 px）。

  这是「仅色块边界」正确性的命脉：imaging.getPixels 会把 sourceBounds 裁剪到图层
  bounds，然后再把裁剩下的内容重采样到 targetSize。因此当图层只有一小块、而我们
  按整个选区尺寸去请求时，那一小块会被【拉伸】铺满整个区域，写回后整幅画面被撑满
  文档。正确做法与 pixelDataProcessor.processPixelData 一致：先取图层真实 bounds，
  只请求「需要区域 ∩ 图层 bounds」，并保证 source 尺寸与 targetSize 严格 1:1。
*/
function getLayerPixelBounds(
  documentID: number,
  layerID: number
): { left: number; top: number; right: number; bottom: number } | null {
  try {
    const doc = app.activeDocument;
    if (!doc || doc.id !== documentID) return null;

    // duplicate 之后临时图层就是当前激活图层，优先直接取，省一次遍历
    const active = doc.activeLayers?.[0];
    if (active && active.id === layerID && active.bounds) {
      const b = normalizeLayerBounds(active.bounds);
      if (b) return b;
    }

    const found = findLayerByIdRecursive(doc.layers as any, layerID);
    if (found && found.bounds) return normalizeLayerBounds(found.bounds);
    return null;
  } catch (e) {
    return null;
  }
}

async function getMedianFilteredSelectionRegionRGBA(
  ps: PhotoshopContext,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  radius: number
): Promise<Uint8Array | null> {
  // 色块边界模式需要“在不影响原图层”的前提下，拿到 PS 原生中间值结果。
  // 做法：复制当前图层 -> 在临时图层上执行 median（会受当前选区限制）-> 读取像素 -> 删除临时图层。
  const regionW = bounds.x1 - bounds.x0 + 1;
  const regionH = bounds.y1 - bounds.y0 + 1;
  if (regionW <= 0 || regionH <= 0) return null;

  let tempLayerId: number | null = null;
  try {
    await action.batchPlay([
      {
        _obj: 'duplicate',
        _target: [{ _ref: 'layer', _id: ps.layerID }],
        _options: { dialogOptions: 'dontDisplay' }
      }
    ], { synchronousExecution: true });

    const dupInfo = await action.batchPlay([
      {
        _obj: 'get',
        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
      }
    ], { synchronousExecution: true });

    tempLayerId = dupInfo?.[0]?.layerID;
    if (!tempLayerId) return null;

    await action.batchPlay([
      {
        _obj: 'median',
        radius: { _unit: 'pixelsUnit', _value: radius },
        _isCommand: false,
        _options: { dialogOptions: 'dontDisplay' }
      }
    ], { synchronousExecution: true });

    // 滤镜可能改变图层 bounds，所以 median 之后再取一次实时 bounds
    const layerBounds = getLayerPixelBounds(ps.documentID, tempLayerId);
    if (!layerBounds) return null;

    // 只请求「处理区域 ∩ 图层 bounds」，source 与 target 尺寸严格 1:1（不做任何缩放）
    const sx0 = Math.max(bounds.x0, layerBounds.left);
    const sy0 = Math.max(bounds.y0, layerBounds.top);
    const sx1 = Math.min(bounds.x1 + 1, layerBounds.right);
    const sy1 = Math.min(bounds.y1 + 1, layerBounds.bottom);
    const sw = sx1 - sx0;
    const sh = sy1 - sy0;
    if (sw <= 0 || sh <= 0) return null;

    const pixels = await imaging.getPixels({
      documentID: ps.documentID,
      layerID: tempLayerId,
      sourceBounds: {
        left: sx0,
        top: sy0,
        right: sx1,
        bottom: sy1
      },
      targetSize: { width: sw, height: sh },
      componentSize: 8
    });

    const raw = new Uint8Array(await pixels.imageData.getData());
    // 请求尺寸可能被 UXP 取整/裁剪，一律按返回的实际宽高解析（见项目踩坑记录）
    const gotW = (pixels.imageData as any).width || 0;
    const gotH = (pixels.imageData as any).height || 0;
    pixels.imageData.dispose();
    if (gotW <= 0 || gotH <= 0) return null;

    // 长度必须是 gotW*gotH 的 3 倍或 4 倍，否则说明解析口径不对。
    // 这里宁可直接放弃（返回 null = 不做改动），也绝不能把错误数据写回图层。
    const pixelCount = gotW * gotH;
    if (raw.length !== pixelCount * 4 && raw.length !== pixelCount * 3) {
      console.warn('⚠️ 中间值图层像素长度异常，跳过本次处理:', raw.length, gotW, gotH);
      return null;
    }

    const srcRGBA = normalizePixelsToRGBA(raw, pixelCount);

    // 按文档坐标把图层像素摆回“区域缓冲”，区域其余部分保持全透明（RGBA=0）。
    // 透明像素不计入图层 bounds，所以不会把图层外接矩形撑成文档大小。
    const region = new Uint8Array(regionW * regionH * 4);
    const scaleX = sw / gotW;
    const scaleY = sh / gotH;
    for (let sy = 0; sy < gotH; sy++) {
      const dy = sy0 + Math.round(sy * scaleY);
      if (dy < bounds.y0 || dy > bounds.y1) continue;
      const ry = dy - bounds.y0;
      for (let sx = 0; sx < gotW; sx++) {
        const dx = sx0 + Math.round(sx * scaleX);
        if (dx < bounds.x0 || dx > bounds.x1) continue;
        const rx = dx - bounds.x0;
        const si = (sy * gotW + sx) * 4;
        const di = (ry * regionW + rx) * 4;
        region[di] = srcRGBA[si];
        region[di + 1] = srcRGBA[si + 1];
        region[di + 2] = srcRGBA[si + 2];
        region[di + 3] = srcRGBA[si + 3];
      }
    }

    return region;
  } catch (e) {
    return null;
  } finally {
    if (tempLayerId) {
      try {
        await action.batchPlay([
          {
            _obj: 'delete',
            _target: [{ _ref: 'layer', _id: tempLayerId }],
            _isCommand: false
          }
        ], { synchronousExecution: true });
      } catch (e) {
      }
      try {
        await action.batchPlay([
          {
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: ps.layerID }],
            makeVisible: false,
            _isCommand: false
          }
        ], { synchronousExecution: true });
      } catch (e) {
      }
    }
  }
}

function buildSelectionInnerFadeRegion(
  selectionMask: Uint8Array,
  width: number,
  height: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  fadeWidth: number
): Uint8Array {
  // 计算“选区边缘渐隐系数”（0~255）：
  //  - 选区边界像素=0（不写回/几乎不写回）
  //  - 向选区内部逐步增加，直到达到 fadeWidth 以后=255（完全写回）
  // 目的是：即使选区没有羽化，也尽量避免用户看见“选区边界”的痕迹。
  const regionW = bounds.x1 - bounds.x0 + 1;
  const regionH = bounds.y1 - bounds.y0 + 1;
  const regionSize = Math.max(0, regionW * regionH);
  const fade = new Uint8Array(regionSize);
  if (regionW <= 0 || regionH <= 0) return fade;

  const fw = Math.max(1, fadeWidth | 0);
  const dist = new Int16Array(regionSize);
  dist.fill(-1);

  const q = new Int32Array(regionSize);
  let head = 0;
  let tail = 0;

  const isSelected = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return (selectionMask[y * width + x] || 0) !== 0;
  };

  for (let ry = 0; ry < regionH; ry++) {
    const y = bounds.y0 + ry;
    for (let rx = 0; rx < regionW; rx++) {
      const x = bounds.x0 + rx;
      if (!isSelected(x, y)) continue;

      const boundary =
        !isSelected(x - 1, y) ||
        !isSelected(x + 1, y) ||
        !isSelected(x, y - 1) ||
        !isSelected(x, y + 1);

      if (!boundary) continue;
      const ri = ry * regionW + rx;
      dist[ri] = 0;
      q[tail++] = ri;
    }
  }

  while (head < tail) {
    // 用 BFS 从边界往内部扩散，得到每个选区像素离边界的步数（近似距离）。
    const ri = q[head++] as number;
    const d = dist[ri] as number;
    if (d >= fw) continue;

    const rx = ri % regionW;
    const ry = (ri - rx) / regionW;
    const x = bounds.x0 + rx;
    const y = bounds.y0 + ry;

    const tryPush = (nx: number, ny: number, nRi: number) => {
      if (dist[nRi] !== -1) return;
      if (!isSelected(nx, ny)) return;
      dist[nRi] = (d + 1) as any;
      q[tail++] = nRi;
    };

    if (rx > 0) tryPush(x - 1, y, ri - 1);
    if (rx + 1 < regionW) tryPush(x + 1, y, ri + 1);
    if (ry > 0) tryPush(x, y - 1, ri - regionW);
    if (ry + 1 < regionH) tryPush(x, y + 1, ri + regionW);
  }

  for (let i = 0; i < regionSize; i++) {
    const d = dist[i];
    const rx = i % regionW;
    const ry = (i - rx) / regionW;
    const docIdx = (bounds.y0 + ry) * width + (bounds.x0 + rx);
    const isSel = (selectionMask[docIdx] || 0) !== 0;
    if (!isSel) {
      fade[i] = 0;
      continue;
    }
    if (d < 0) {
      fade[i] = 255;
      continue;
    }
    if (d >= fw) {
      fade[i] = 255;
      continue;
    }
    fade[i] = Math.round((255 * d) / fw);
  }

  return fade;
}

/*
  从 selectionMask（0 表示不在选区内）计算选区的包围盒。
  返回的是选区像素的最小/最大 x/y，用于后续只处理必要区域。
*/
function computeSelectionBounds(selectionMask: Uint8Array, width: number, height: number) {
  const pixelCount = width * height;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < pixelCount; i++) {
    if ((selectionMask[i] || 0) === 0) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/*
  主入口：对整张“文档尺寸”的像素数据做处理，返回同尺寸 RGBA ArrayBuffer。

  注意：
  - 像素输入/输出是“内存里的数组”，写回 Photoshop 图层由外部调用方负责。
  - ps 参数用于调用 Photoshop 原生滤镜（median）并读取处理后的像素结果。
*/
export async function processSmartEdgeSmooth(
  pixelDataBuffer: ArrayBuffer,
  selectionMaskBuffer: ArrayBuffer,
  dimensions: { width: number; height: number },
  _params: EdgeDetectionParams,
  isBackgroundLayer: boolean = false,
  ps?: PhotoshopContext
): Promise<ArrayBuffer> {
  // 这个函数返回“完整文档尺寸”的像素数组（RGBA，背景图层也带 A=255），由调用方统一写回图层。
  const params = (_params || {}) as EdgeDetectionParams;
  const pixelData = new Uint8Array(pixelDataBuffer);
  const selectionMaskRaw = new Uint8Array(selectionMaskBuffer);
  const { width, height } = dimensions;
  const pixelCount = width * height;

  // selectionMaskRaw 可能是 0~255 的羽化值或透明度选区值。
  // 为避免“半透明选区几乎没效果”（值会被重复当成权重衰减），这里统一转成二值选区：
  // 只要 >0 就当作“在选区内”，值固定为 255。
  const selectionMask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    selectionMask[i] = (selectionMaskRaw[i] || 0) > 0 ? 255 : 0;
  }

  const outputData = new Uint8Array(pixelData.length);
  outputData.set(pixelData);

  const sel = computeSelectionBounds(selectionMask, width, height);
  if (sel.maxX < 0) return outputData.buffer;

  const mode = params.mode || 'edge';

  // 「仅主线条」：整体转发给 lineSmoothProcessor，本文件不再参与。
  // 面板只暴露两个参数：平滑力度（默认 100%）、平滑范围（默认 8px）。
  if (mode === 'line') {
    const lineSmoothStrength = clamp01(params.lineSmoothStrength ?? 1);
    const lineSmoothRadius = clampInt(Math.round(params.lineSmoothRadius ?? 8), 3, 12);
    return processLineSmooth(
      pixelDataBuffer,
      selectionMaskBuffer,
      { width, height },
      {
        strength: lineSmoothStrength,
        radius: lineSmoothRadius
      }
    );
  }

  // 以下是「仅色块边界」：处理区域与渐隐宽度只由中间值半径决定
  const edgeMedianRadius = clampInt(Math.round(params.edgeMedianRadius ?? 16), 10, 30);
  const regionPad = edgeMedianRadius + 2;
  const bounds = {
    x0: clampInt(sel.minX - regionPad, 0, width - 1),
    y0: clampInt(sel.minY - regionPad, 0, height - 1),
    x1: clampInt(sel.maxX + regionPad, 0, width - 1),
    y1: clampInt(sel.maxY + regionPad, 0, height - 1)
  };
  const regionW = bounds.x1 - bounds.x0 + 1;
  const regionH = bounds.y1 - bounds.y0 + 1;
  const selectionInnerFadeWidth = clampInt(Math.round(edgeMedianRadius * 0.5), 2, 12);
  const selectionInnerFade = buildSelectionInnerFadeRegion(selectionMask, width, height, bounds, selectionInnerFadeWidth);

  const writeMedianIntoSelection = (regionRGBA: Uint8Array, baseRGBA: Uint8Array) => {
    if (regionW <= 0 || regionH <= 0) return;
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      const rowBase = y * width;
      const ry = y - bounds.y0;
      const regionRowBase = ry * regionW;
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        const idx = rowBase + x;
        if ((selectionMask[idx] || 0) === 0) continue;

        const rx = x - bounds.x0;
        const ri = regionRowBase + rx;
        const rp = ri * 4;
        const p = idx * 4;
        const fade01 = (selectionInnerFade[ri] || 0) / 255;
        const w = fade01;
        if (w <= 0.001) continue;

        const baseR = baseRGBA[p] || 0;
        const baseG = baseRGBA[p + 1] || 0;
        const baseB = baseRGBA[p + 2] || 0;
        const baseA = isBackgroundLayer ? 255 : (baseRGBA[p + 3] || 0);

        outputData[p] = Math.round(baseR * (1 - w) + (regionRGBA[rp] || 0) * w);
        outputData[p + 1] = Math.round(baseG * (1 - w) + (regionRGBA[rp + 1] || 0) * w);
        outputData[p + 2] = Math.round(baseB * (1 - w) + (regionRGBA[rp + 2] || 0) * w);
        outputData[p + 3] = isBackgroundLayer ? 255 : Math.round(baseA * (1 - w) + (regionRGBA[rp + 3] || 0) * w);
      }
    }
  };

  // 拿到 PS 原生「中间值」结果后，按选区（含边缘渐隐）混合回输出缓冲
  const edgeRegion = ps ? await getMedianFilteredSelectionRegionRGBA(ps, bounds, edgeMedianRadius) : null;
  if (edgeRegion) {
    writeMedianIntoSelection(edgeRegion, pixelData);
  }

  return outputData.buffer;
}

export const defaultSmartEdgeSmoothParams: EdgeDetectionParams = {
  mode: 'edge',
  edgeMedianRadius: 16,
  lineSmoothStrength: 1,       // 平滑力度默认 100%
  lineSmoothRadius: 8          // 平滑范围默认 8px
};
