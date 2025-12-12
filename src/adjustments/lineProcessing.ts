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
      if (!(alpha === 255 && coefficient >= 0.99)) {
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
  
  // 第三步：创建保守的alpha增强函数
  const enhanceAlpha = (originalAlpha: number): number => {
    if (originalAlpha === 0) {
      // 对于完全透明的像素，不进行处理
      return 0;
    }
    
    // 只对真正需要增强的低alpha值进行处理
    // 如果alpha值已经比较高（超过180），则只进行轻微增强
    if (originalAlpha >= 180) {
      return Math.min(255, originalAlpha + Math.max(2, Math.round((255 - originalAlpha) * 0.1)));
    }
    
    // 对于中等alpha值（120-180），进行适度增强
    if (originalAlpha >= 120) {
      const enhancement = Math.round((255 - originalAlpha) * 0.25);
      return Math.min(255, originalAlpha + enhancement);
    }
    
    // 只对低alpha值（小于120）进行较大增强
    const normalizedPosition = (originalAlpha - minAlpha) / Math.max(1, maxAlpha - minAlpha);
    const enhancementFactor = Math.pow(1 - normalizedPosition, 0.4); // 降低指数，减少增强幅度
    
    // 限制增强幅度，避免过度处理
    const maxEnhancement = Math.min(60, (255 - originalAlpha) * 0.4);
    const enhancement = maxEnhancement * enhancementFactor;
    
    return Math.min(255, Math.round(originalAlpha + enhancement));
  };
  
  // 第四步：应用增强算法
  for (const { index, alpha, coefficient } of pixelData) {
    const byteIndex = index * 4;
    const enhancedAlpha = enhanceAlpha(alpha);
    
    // 根据选区系数混合原始alpha和增强后的alpha
    result[byteIndex + 3] = Math.round(
      alpha * (1 - coefficient) + enhancedAlpha * coefficient
    );
  }
  
  // 第五步：高级抗锯齿处理（仅复制alpha通道以降低内存）
  const alphaChannel = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    alphaChannel[i] = result[i * 4 + 3];
  }
  
  // 第一轮：对增强后的像素进行高斯模糊式平滑
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
        // 根据选区系数决定平滑强度
        const smoothingStrength = Math.min(0.4, coefficient * 0.3);
        alphaChannel[index] = Math.round(
          result[centerByteIndex + 3] * (1 - smoothingStrength) + smoothedAlpha * smoothingStrength
        );
      }
    }
  }
  
  // 第二轮：轻量级边缘抗锯齿处理（减少线条加粗）
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const centerIndex = y * width + x;
      const centerByteIndex = centerIndex * 4;
      const coefficient = getSelectionCoefficient(centerIndex);
      
      // 只处理选区内原本透明但邻近有内容的像素，并且要求更严格的条件
      if (coefficient > 0.5 && layerPixels[centerByteIndex + 3] === 0) { // 提高选区系数要求
        // 检查周围8个像素，寻找边缘
        let strongNeighborCount = 0; // 强邻居（alpha > 150）的数量
        let neighborAlphaSum = 0;
        let neighborCount = 0;
        
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            
            const nx = x + dx;
            const ny = y + dy;
            const neighborIndex = ny * width + nx;
            const neighborAlpha = alphaChannel[neighborIndex];
            
            if (neighborAlpha > 0) {
              neighborAlphaSum += neighborAlpha;
              neighborCount++;
              
              // 只有强邻居才算作真正的边缘
              if (neighborAlpha > 150) {
                strongNeighborCount++;
              }
            }
          }
        }
        
        // 只有当有足够多的强邻居时才进行边缘处理，避免过度扩展
        if (strongNeighborCount >= 2 && neighborCount > 0) {
          const avgNeighborAlpha = neighborAlphaSum / neighborCount;
          // 大幅降低边缘alpha值，减少线条加粗
          const edgeAlpha = Math.round(
            avgNeighborAlpha * (strongNeighborCount / 8) * coefficient * 0.08 // 从0.25降低到0.08
          );
          alphaChannel[centerIndex] = Math.min(15, edgeAlpha); // 从40降低到15
          
          // 同时复制邻居的平均颜色
          let rSum = 0, gSum = 0, bSum = 0, colorCount = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              
              const nx = x + dx;
              const ny = y + dy;
              const neighborIndex = ny * width + nx;
              if (alphaChannel[neighborIndex] > 150) { // 只从强邻居复制颜色
                const nb = neighborIndex * 4;
                rSum += result[nb];
                gSum += result[nb + 1];
                bSum += result[nb + 2];
                colorCount++;
              }
            }
          }
          
          if (colorCount > 0) {
            result[centerByteIndex] = Math.round(rSum / colorCount);
            result[centerByteIndex + 1] = Math.round(gSum / colorCount);
            result[centerByteIndex + 2] = Math.round(bSum / colorCount);
          }
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
