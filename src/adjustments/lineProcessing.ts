// 线条处理算法 - alpha通道增强功能
export async function processLineEnhancement(layerPixelData: ArrayBuffer, selectionData: ArrayBuffer, bounds: { width: number; height: number }): Promise<Uint8Array> {
  const layerPixels = new Uint8Array(layerPixelData);
  const selectionPixels = new Uint8Array(selectionData);
  const result = new Uint8Array(layerPixels.length);
  
  // 复制原始像素数据
  result.set(layerPixels);
  
  const pixelCount = layerPixels.length / 4;
  const { width, height } = bounds;
  
  // 解析选区数据，获取选区强度系数
  const getSelectionCoefficient = (pixelIndex: number): number => {
    if (selectionPixels.length === pixelCount) {
      // 单通道选区数据
      return selectionPixels[pixelIndex] / 255;
    } else if (selectionPixels.length === pixelCount * 4) {
      // RGBA选区数据，使用alpha通道
      return selectionPixels[pixelIndex * 4 + 3] / 255;
    }
    return 0;
  };

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  const smoothstep = (edge0: number, edge1: number, x: number) => {
    const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0));
    return t * t * (3 - 2 * t);
  };

  const getLocalMaxAlpha = (pixelIndex: number): number => {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    let maxA = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const nIndex = ny * width + nx;
        const a = layerPixels[nIndex * 4 + 3];
        if (a > maxA) maxA = a;
      }
    }
    return maxA;
  };
  
  // 第一步：收集必要像素并流式统计alpha范围
  const pixelData: Array<{ index: number; alpha: number; coefficient: number }> = [];
  let minAlpha = 255;
  let maxAlpha = 0;
  let nonZeroCount = 0;
  
  for (let i = 0; i < pixelCount; i++) {
    const coefficient = getSelectionCoefficient(i);
    if (coefficient > 0) {
      const alpha = layerPixels[i * 4 + 3];
      if (alpha > 0) {
        if (alpha < minAlpha) minAlpha = alpha;
        if (alpha > maxAlpha) maxAlpha = alpha;
        nonZeroCount++;
      }
      if (alpha > 0 && !(alpha === 255 && coefficient >= 0.99)) {
        pixelData.push({ index: i, alpha, coefficient });
      }
    }
  }
  
  if (pixelData.length === 0) {
    console.log('选区内没有像素需要处理');
    return result;
  }
  
  // 第二步：计算alpha值的统计信息（流式结果）
  if (nonZeroCount === 0) {
    console.log('选区内没有非透明像素');
    return result;
  }
  
  console.log(`Alpha值范围: ${minAlpha} - ${maxAlpha}，总像素数: ${pixelData.length}`);
  if (minAlpha === 255 && maxAlpha === 255) {
    return result;
  }
  
  // 第三步：连续曲线加黑（自适应k，保护最外沿羽化）
  const enhanceAlpha = (originalAlpha: number): number => {
    if (originalAlpha <= 0) return 0;
    if (originalAlpha >= 255) return 255;

    const a = originalAlpha / 255;

    const kMax = 3.0;
    const edgeProtect = smoothstep(0.04, 0.18, a);
    const lowBoostRaw = 1 - smoothstep(0.22, 0.86, a);
    const lowBoost = Math.pow(lowBoostRaw, 1.15);
    const kEff = 1 + (kMax - 1) * (edgeProtect * lowBoost);

    const enhanced = 1 - Math.pow(1 - a, kEff);
    const midDamp = smoothstep(0.16, 0.55, a) * (1 - smoothstep(0.78, 0.93, a));
    const deltaScale = 1 - 0.22 * midDamp;
    const finalAlpha = a + (enhanced - a) * deltaScale;
    return Math.max(0, Math.min(255, Math.round(finalAlpha * 255)));
  };
  
  // 第四步：应用增强算法
  for (const { index, alpha, coefficient } of pixelData) {
    const byteIndex = index * 4;
    const enhancedAlpha = enhanceAlpha(alpha);

    const localMaxA = getLocalMaxAlpha(index);
    const rel = localMaxA > 0 ? alpha / localMaxA : 0;
    const edgeKeep = smoothstep(0.42, 0.86, rel);
    const edgeAwareAlpha = alpha + (enhancedAlpha - alpha) * edgeKeep;

    result[byteIndex + 3] = Math.round(alpha * (1 - coefficient) + edgeAwareAlpha * coefficient);
  }
  
  // 第五步：轻量级平滑（不扩边，只在原有羽化内保持衰减柔和）
  const alphaChannel = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    alphaChannel[i] = result[i * 4 + 3];
  }
  
  // 对增强后的像素进行高斯核平滑（双缓冲写入alphaChannel）
  for (const { index, alpha, coefficient } of pixelData) {
    if (alpha === 255 && coefficient >= 0.99) {
      continue;
    }
    if (alpha > 0) {
      const x = index % width;
      const y = Math.floor(index / width);
      const centerByteIndex = index * 4;
      
      // 跳过边界像素避免越界
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) continue;
      
      // 使用3x3高斯核进行平滑
      const gaussianKernel = [
        0.0625, 0.125, 0.0625,  // 上行
        0.125,  0.25,  0.125,   // 中行
        0.0625, 0.125, 0.0625   // 下行
      ];
      
      let weightedAlphaSum = 0;
      let totalWeight = 0;
      
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const neighborIndex = ny * width + nx;
            const neighborByteIndex = neighborIndex * 4;
            const neighborAlpha = result[neighborByteIndex + 3];
            const kernelIndex = (dy + 1) * 3 + (dx + 1);
            const weight = gaussianKernel[kernelIndex];
            
            weightedAlphaSum += neighborAlpha * weight;
            totalWeight += weight;
          }
        }
      }
      
      if (totalWeight > 0) {
        const smoothedAlpha = Math.round(weightedAlphaSum / totalWeight);
        const smoothingStrength = Math.min(0.20, coefficient * 0.16);
        const currentAlpha = result[centerByteIndex + 3];
        if (smoothedAlpha < currentAlpha) {
          alphaChannel[index] = Math.round(currentAlpha * (1 - smoothingStrength) + smoothedAlpha * smoothingStrength);
        }
      }
    }
  }
  
  // 将alpha通道写回结果
  for (let i = 0; i < pixelCount; i++) {
    result[i * 4 + 3] = alphaChannel[i];
  }
  
  console.log(`线条增强处理完成: 处理了 ${pixelData.length} 个像素，alpha范围: ${minAlpha}-${maxAlpha}`);
  
  return result;
}
