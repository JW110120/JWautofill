// 分块平均处理算法 - 对独立的选区（连通块）分别计算平均值，支持普通平均与对比减弱两种模式
export async function processBlockAverage(layerPixelData: ArrayBuffer, selectionData: ArrayBuffer, bounds: { width: number; height: number }, isBackgroundLayer: boolean = false, useContrastReduction: boolean = false, contrastReductionIntensity: number = 8): Promise<Uint8Array> {
  const layerPixels = new Uint8Array(layerPixelData);
  const selectionPixels = new Uint8Array(selectionData);
  const result = new Uint8Array(layerPixels.length);
  
  // 复制原始选区像素数据
  result.set(layerPixels);
  
  // 选区像素数量
  const pixelCount = layerPixels.length / 4;
  const { width, height } = bounds;
  
  // 使用更高效的位掩码和紧凑的数据结构
  const visitedBits = new Uint32Array(Math.ceil(pixelCount / 32));
  const selectionCoefficients = new Uint8Array(pixelCount); // 使用 0-255 范围而非浮点数
  
  // 内联函数：检查和设置访问状态（避免函数调用开销）
  const isVisited = (idx: number) => {
    const wordIdx = Math.floor(idx / 32);
    const bitIdx = idx % 32;
    return (visitedBits[wordIdx] & (1 << bitIdx)) !== 0;
  };
  
  const setVisited = (idx: number) => {
    const wordIdx = Math.floor(idx / 32);
    const bitIdx = idx % 32;
    visitedBits[wordIdx] |= (1 << bitIdx);
  };
  
  // 预处理选区数据（仅一次遍历，避免重复计算）
  const hasSelection = selectionPixels.length > 0;
  if (!hasSelection) {
    return result; // 没有选区直接返回
  }
  
  if (selectionPixels.length === pixelCount) {
    // 单通道选区数据
    for (let i = 0; i < pixelCount; i++) {
      selectionCoefficients[i] = selectionPixels[i];
    }
  } else if (selectionPixels.length === pixelCount * 4) {
    // RGBA选区数据，使用alpha通道
    for (let i = 0; i < pixelCount; i++) {
      selectionCoefficients[i] = selectionPixels[i * 4 + 3];
    }
  }
  
  // 基于空间连通性的 flood fill（使用循环和预分配队列减少开销）
  const queue = new Int32Array(pixelCount);
  const componentIdxs = new Int32Array(pixelCount);
  
  const floodFill = (startIndex: number): number => {
    let qHead = 0, qTail = 0;
    let compSize = 0;
    queue[qTail++] = startIndex;
    setVisited(startIndex);
    
    while (qHead < qTail) {
      const index = queue[qHead++];
      componentIdxs[compSize++] = index;
      const x = index % width;
      const y = (index / width) | 0;
      
      // 右
      if (x + 1 < width) {
        const ni = index + 1;
        if (!isVisited(ni) && selectionCoefficients[ni] > 0) { setVisited(ni); queue[qTail++] = ni; }
      }
      // 左
      if (x - 1 >= 0) {
        const ni = index - 1;
        if (!isVisited(ni) && selectionCoefficients[ni] > 0) { setVisited(ni); queue[qTail++] = ni; }
      }
      // 下
      if (y + 1 < height) {
        const ni = index + width;
        if (!isVisited(ni) && selectionCoefficients[ni] > 0) { setVisited(ni); queue[qTail++] = ni; }
      }
      // 上
      if (y - 1 >= 0) {
        const ni = index - width;
        if (!isVisited(ni) && selectionCoefficients[ni] > 0) { setVisited(ni); queue[qTail++] = ni; }
      }
    }
    return compSize;
  };
  
  // 查找所有独立的连通区域（优化版本）
  let regionCount = 0;
  for (let index = 0; index < pixelCount; index++) {
    if (!isVisited(index) && selectionCoefficients[index] > 0) {
      const compSize = floodFill(index);
      
      if (compSize > 0) {
        regionCount++;
        
        if (useContrastReduction) {
          // 对比减弱：按像素与所在连通块均值的偏离量自适应压缩。
          // 偏离小的像素（大面积底色）几乎不动，偏离大的像素（线条）大幅向均值靠拢，保留块内原有层次。
          let totalR = 0, totalG = 0, totalB = 0, totalA = 0, totalL = 0, totalL2 = 0;
          let validPixelCount = 0;
          
          for (let ci = 0; ci < compSize; ci++) {
            const pIdx = componentIdxs[ci] << 2;
            if (layerPixels[pIdx + 3] === 0) continue;
            
            const r = layerPixels[pIdx];
            const g = layerPixels[pIdx + 1];
            const b = layerPixels[pIdx + 2];
            const l = 0.299 * r + 0.587 * g + 0.114 * b;
            
            totalR += r;
            totalG += g;
            totalB += b;
            totalA += layerPixels[pIdx + 3];
            totalL += l;
            totalL2 += l * l;
            validPixelCount++;
          }
          
          if (validPixelCount === 0) continue;
          
          const avgR = totalR / validPixelCount;
          const avgG = totalG / validPixelCount;
          const avgB = totalB / validPixelCount;
          const avgA = totalA / validPixelCount;
          const avgL = totalL / validPixelCount;
          
          // 压缩尺度取该连通块自身的亮度标准差，下限 6 防止近纯色块被自身噪声主导
          const sigmaL = Math.sqrt(Math.max(0, totalL2 / validPixelCount - avgL * avgL));
          const tau = sigmaL > 6 ? sigmaL : 6;
          
          // 强度 1-10 映射为偏离的最大抹除比例 7%-70%（只有偏离最大的像素才会触到这个上限）
          const maxReduction = contrastReductionIntensity * 0.07;
          
          // 混合颜色带（内置行为，参数写死，不对用户暴露）：偏离 ≤1.5σ 的像素完全不受此影响（平台段），
          // 1.5σ–6σ 之间线性过渡，≥6σ 的像素完全保留原值，使大反差特征不至于被压平。alpha 不参与该柔化。
          const blendIfStart = 1.5 * tau;
          const blendIfSpan = 4.5 * tau;
          
          for (let ci = 0; ci < compSize; ci++) {
            const idx = componentIdxs[ci];
            const pIdx = idx << 2;
            if (layerPixels[pIdx + 3] === 0) continue;
            
            const l = 0.299 * layerPixels[pIdx] + 0.587 * layerPixels[pIdx + 1] + 0.114 * layerPixels[pIdx + 2];
            const u = Math.abs(l - avgL);
            const ratio = u / tau;
            const coeff = selectionCoefficients[idx] * 0.00392156863; // /255
            const factor = coeff * maxReduction * (ratio / (1 + ratio));
            
            let phi = 1;
            if (u > blendIfStart) {
              const q = (u - blendIfStart) / blendIfSpan;
              phi = q > 1 ? 0 : 1 - q;
            }
            
            const invRgb = 1 - factor * phi;
            const invAlpha = 1 - factor;
            
            result[pIdx] = (layerPixels[pIdx] * invRgb + avgR * factor * phi) | 0;
            result[pIdx + 1] = (layerPixels[pIdx + 1] * invRgb + avgG * factor * phi) | 0;
            result[pIdx + 2] = (layerPixels[pIdx + 2] * invRgb + avgB * factor * phi) | 0;
            result[pIdx + 3] = (layerPixels[pIdx + 3] * invAlpha + avgA * factor) | 0;
          }
        } else {
          // 简单平均算法（优化版）
          let totalR = 0, totalG = 0, totalB = 0, totalA = 0, validPixelCount = 0;
          
          for (let ci = 0; ci < compSize; ci++) {
            const idx = componentIdxs[ci];
            const pIdx = idx << 2;
            if (layerPixels[pIdx + 3] === 0) continue;
            
            totalR += layerPixels[pIdx];
            totalG += layerPixels[pIdx + 1];
            totalB += layerPixels[pIdx + 2];
            totalA += layerPixels[pIdx + 3];
            validPixelCount++;
          }
          
          if (validPixelCount === 0) continue;
          
          const avgR = (totalR / validPixelCount) | 0;
          const avgG = (totalG / validPixelCount) | 0;
          const avgB = (totalB / validPixelCount) | 0;
          const avgA = (totalA / validPixelCount) | 0;
          
          // 应用混合
          for (let ci = 0; ci < compSize; ci++) {
            const idx = componentIdxs[ci];
            const pIdx = idx << 2;
            if (layerPixels[pIdx + 3] === 0) continue;
            
            const coeff = selectionCoefficients[idx] * 0.00392156863; // /255
            const invCoeff = 1 - coeff;
            
            result[pIdx] = (layerPixels[pIdx] * invCoeff + avgR * coeff) | 0;
            result[pIdx + 1] = (layerPixels[pIdx + 1] * invCoeff + avgG * coeff) | 0;
            result[pIdx + 2] = (layerPixels[pIdx + 2] * invCoeff + avgB * coeff) | 0;
            result[pIdx + 3] = (layerPixels[pIdx + 3] * invCoeff + avgA * coeff) | 0;
          }
        }
      }
    }
  }
  
  // console.log(`总共找到 ${regionCount} 个独立矩形区域`);
  return result;
}
