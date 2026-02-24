// 分块平均处理算法 - 对独立的选区分别计算平均值（优化版本）
export async function processBlockAverage(layerPixelData: ArrayBuffer, selectionData: ArrayBuffer, bounds: { width: number; height: number }, isBackgroundLayer: boolean = false, useWeightedAverage: boolean = false, weightedIntensity: number = 1): Promise<Uint8Array> {
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
        
        if (useWeightedAverage) {
          // 简化的加权算法：使用近似颜色聚类（减少计算）
          const colorTolerance = 900; // 使用平方距离避免sqrt
          
          // 简化聚类：最多16个颜色簇，减少内存分配
          const maxClusters = 16;
          const clusterR = new Uint8Array(maxClusters);
          const clusterG = new Uint8Array(maxClusters);
          const clusterB = new Uint8Array(maxClusters);
          const clusterA = new Uint8Array(maxClusters);
          const clusterCount = new Uint16Array(maxClusters);
          let numClusters = 0;
          
          // 快速聚类（避免对象分配）
          for (let ci = 0; ci < compSize; ci++) {
            const idx = componentIdxs[ci];
            const pIdx = idx << 2; // * 4
            const r = layerPixels[pIdx];
            const g = layerPixels[pIdx + 1];
            const b = layerPixels[pIdx + 2];
            const a = layerPixels[pIdx + 3];
            
            if (a === 0) continue;
            
            let clusterFound = false;
            for (let c = 0; c < numClusters; c++) {
              const dr = r - clusterR[c];
              const dg = g - clusterG[c];
              const db = b - clusterB[c];
              const da = a - clusterA[c];
              if (dr*dr + dg*dg + db*db + da*da <= colorTolerance) {
                const newCount = clusterCount[c] + 1;
                clusterR[c] = ((clusterR[c] * clusterCount[c] + r) / newCount) | 0;
                clusterG[c] = ((clusterG[c] * clusterCount[c] + g) / newCount) | 0;
                clusterB[c] = ((clusterB[c] * clusterCount[c] + b) / newCount) | 0;
                clusterA[c] = ((clusterA[c] * clusterCount[c] + a) / newCount) | 0;
                clusterCount[c] = newCount;
                clusterFound = true;
                break;
              }
            }
            
            if (!clusterFound && numClusters < maxClusters) {
              clusterR[numClusters] = r;
              clusterG[numClusters] = g;
              clusterB[numClusters] = b;
              clusterA[numClusters] = a;
              clusterCount[numClusters] = 1;
              numClusters++;
            }
          }
          
          // 计算加权平均
          let weightedR = 0, weightedG = 0, weightedB = 0, weightedA = 0, totalWeight = 0;
          for (let c = 0; c < numClusters; c++) {
            const weight = clusterCount[c];
            weightedR += clusterR[c] * weight;
            weightedG += clusterG[c] * weight;
            weightedB += clusterB[c] * weight;
            weightedA += clusterA[c] * weight;
            totalWeight += weight;
          }
          
          if (totalWeight > 0) {
            const avgR = (weightedR / totalWeight) | 0;
            const avgG = (weightedG / totalWeight) | 0;
            const avgB = (weightedB / totalWeight) | 0;
            const avgA = (weightedA / totalWeight) | 0;
            const intensityFactor = weightedIntensity * 0.1; // /10
            
            // 应用混合
            for (let ci = 0; ci < compSize; ci++) {
              const idx = componentIdxs[ci];
              const pIdx = idx << 2;
              if (layerPixels[pIdx + 3] === 0) continue;
              
              const coeff = selectionCoefficients[idx] * 0.00392156863; // /255
              const blendFactor = coeff * intensityFactor;
              const invBlend = 1 - blendFactor;
              
              result[pIdx] = (layerPixels[pIdx] * invBlend + avgR * blendFactor) | 0;
              result[pIdx + 1] = (layerPixels[pIdx + 1] * invBlend + avgG * blendFactor) | 0;
              result[pIdx + 2] = (layerPixels[pIdx + 2] * invBlend + avgB * blendFactor) | 0;
              result[pIdx + 3] = (layerPixels[pIdx + 3] * invBlend + avgA * blendFactor) | 0;
            }
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
