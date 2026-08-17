// 像素过渡 - 强力模式（自动估算等效中间值半径）
//
// 目标：替代 PS 自带"中间值"滤镜的自动半径版。
//   1. 对选区内 alpha>0 的像素做距离变换（到最近 alpha=0 像素的距离）
//   2. 找最大距离 = 最粗笔触的"半宽"（即色块厚度的一半）
//   3. 中间值半径 = max(3, round(maxDist * 2.4))——经验公式：15px 笔触对应半径 18
//   4. 对选区内 alpha>0 的像素应用中间值滤波器：
//        - 邻域只统计 alpha>0 的像素（避免透明像素把中位数拉到 0）
//        - R/G/B/A 四个通道分别取中位数
//        - 背景图层 alpha 恒为 255，不参与中位数
//   5. 选区外像素不变（由调用方 applyProcessedPixels 按选区系数混合）
//
// 设计取舍：
//   - 用 Chamfer 3-4 距离变换（两遍扫描）代替 BFS/EDT，足够定位色块厚度
//   - 直方图取中位数（256 桶）而不是排序，O(boxSize + 256) 每像素
//   - 半径上限 35（防止大半径爆性能），下限 3（防单像素噪点）

export async function processPixelTransitionPowerful(
  layerPixelData: ArrayBuffer,
  selectionData: ArrayBuffer,
  bounds: { width: number; height: number },
  isBackgroundLayer: boolean = false
): Promise<Uint8Array> {
  const width = bounds.width;
  const height = bounds.height;
  const pixels = new Uint8Array(layerPixelData);
  const selectionMask = new Uint8Array(selectionData);
  const result = new Uint8Array(pixels);

  // 1. 距离变换（Chamfer 3-4 两遍扫描）
  const INF = 32767;
  const dist = new Int16Array(width * height);
  for (let i = 0; i < width * height; i++) {
    dist[i] = pixels[i * 4 + 3] > 0 ? INF : 0;
  }
  // Forward pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      let d = dist[idx];
      if (y > 0) {
        const t1 = dist[idx - width] + 3;
        if (t1 < d) d = t1;
        if (x > 0) {
          const t2 = dist[idx - width - 1] + 4;
          if (t2 < d) d = t2;
        }
        if (x < width - 1) {
          const t2 = dist[idx - width + 1] + 4;
          if (t2 < d) d = t2;
        }
      }
      if (x > 0) {
        const t = dist[idx - 1] + 3;
        if (t < d) d = t;
      }
      dist[idx] = d;
    }
  }
  // Backward pass
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const idx = y * width + x;
      let d = dist[idx];
      if (y < height - 1) {
        const t1 = dist[idx + width] + 3;
        if (t1 < d) d = t1;
        if (x > 0) {
          const t2 = dist[idx + width - 1] + 4;
          if (t2 < d) d = t2;
        }
        if (x < width - 1) {
          const t2 = dist[idx + width + 1] + 4;
          if (t2 < d) d = t2;
        }
      }
      if (x < width - 1) {
        const t = dist[idx + 1] + 3;
        if (t < d) d = t;
      }
      dist[idx] = d;
    }
  }

  // 2. 选区内 alpha>0 像素的最大距离 = 最粗笔触的半宽
  let maxDist = 0;
  for (let i = 0; i < width * height; i++) {
    if (selectionMask[i] > 0 && dist[i] < INF && dist[i] > maxDist) {
      maxDist = dist[i];
    }
  }
  // 3. 估算中间值半径（15px 笔触 → 半径 18）
  const medianRadius = Math.max(3, Math.min(35, Math.round(maxDist * 2.4)));
  if (medianRadius < 1) return result;

  // 4. 条件中间值滤波器（只对选区内 alpha>0 像素生效；邻域只统计 alpha>0 像素）
  const radius = medianRadius;
  const histR = new Uint32Array(256);
  const histG = new Uint32Array(256);
  const histB = new Uint32Array(256);
  const histA = new Uint32Array(256);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const idx4 = idx * 4;
      const a = pixels[idx4 + 3];
      if (a === 0) continue;
      if (selectionMask[idx] === 0) continue;

      histR.fill(0); histG.fill(0); histB.fill(0); histA.fill(0);
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const rowBase = ny * width;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx4 = (rowBase + nx) * 4;
          const nA = pixels[nIdx4 + 3];
          if (nA === 0) continue; // 关键：透明像素不参与中位数
          histR[pixels[nIdx4]]++;
          histG[pixels[nIdx4 + 1]]++;
          histB[pixels[nIdx4 + 2]]++;
          histA[nA]++;
          count++;
        }
      }
      if (count === 0) continue;
      const medianIdx = Math.floor(count / 2);
      const findMedian = (hist: Uint32Array): number => {
        let cumSum = 0;
        for (let i = 0; i < 256; i++) {
          cumSum += hist[i];
          if (cumSum > medianIdx) return i;
        }
        return 255;
      };
      result[idx4] = findMedian(histR);
      result[idx4 + 1] = findMedian(histG);
      result[idx4 + 2] = findMedian(histB);
      if (!isBackgroundLayer) result[idx4 + 3] = findMedian(histA);
    }
  }

  return result;
}
