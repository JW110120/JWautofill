// 分块平均处理算法 - 对独立的选区分别计算平均值
export async function processBlockAverage(layerPixelData: ArrayBuffer, selectionData: ArrayBuffer, bounds: { width: number; height: number }, isBackgroundLayer: boolean = false, useWeightedAverage: boolean = false, weightedIntensity: number = 1): Promise<Uint8Array> {
  const layerPixels = new Uint8Array(layerPixelData);
  const selectionPixels = new Uint8Array(selectionData);
  const result = new Uint8Array(layerPixels.length);
  
  // 复制原始选区像素数据
  result.set(layerPixels);
  
  // 选区像素数量
  const pixelCount = layerPixels.length / 4;
  
  // 创建选区内像素的映射（基于选区像素数组的索引）
  const selectionMask = new Array(pixelCount).fill(false);
  const selectionCoefficients = new Array(pixelCount).fill(0);
  
  // 处理选区数据，建立选区掩码（基于选区像素数组）
  if (selectionPixels.length === pixelCount) {
    // 单通道选区数据
    for (let i = 0; i < pixelCount; i++) {
      selectionCoefficients[i] = selectionPixels[i] / 255;
      selectionMask[i] = selectionPixels[i] > 0;
    }
  } else if (selectionPixels.length === pixelCount * 4) {
    // RGBA选区数据，使用alpha通道
    for (let i = 0; i < pixelCount; i++) {
      const alpha = selectionPixels[i * 4 + 3];
      selectionCoefficients[i] = alpha / 255;
      selectionMask[i] = alpha > 0;
    }
  }
  
  // 创建访问标记数组
  const visited = new Array(pixelCount).fill(false);
  
  // 基于空间连通性的flood fill算法
  const floodFill = (startIndex: number, component: number[]): void => {
    const stack: number[] = [startIndex];
    
    while (stack.length > 0) {
      const index = stack.pop()!;
      
      if (index < 0 || index >= pixelCount) continue;
      if (visited[index] || !selectionMask[index]) continue;
      
      visited[index] = true;
      component.push(index);
      
      // 检查4连通的相邻像素
      const x = index % bounds.width;
      const y = Math.floor(index / bounds.width);
      
      // 右邻居
      if (x + 1 < bounds.width) {
        const rightIndex = y * bounds.width + (x + 1);
        if (rightIndex < pixelCount && !visited[rightIndex] && selectionMask[rightIndex]) {
          stack.push(rightIndex);
        }
      }
      // 左邻居
      if (x - 1 >= 0) {
        const leftIndex = y * bounds.width + (x - 1);
        if (leftIndex < pixelCount && !visited[leftIndex] && selectionMask[leftIndex]) {
          stack.push(leftIndex);
        }
      }
      // 下邻居
      if (y + 1 < bounds.height) {
        const downIndex = (y + 1) * bounds.width + x;
        if (downIndex < pixelCount && !visited[downIndex] && selectionMask[downIndex]) {
          stack.push(downIndex);
        }
      }
      // 上邻居
      if (y - 1 >= 0) {
        const upIndex = (y - 1) * bounds.width + x;
        if (upIndex < pixelCount && !visited[upIndex] && selectionMask[upIndex]) {
          stack.push(upIndex);
        }
      }
    }
  };
  
  // 查找所有独立的连通区域
  let regionCount = 0;
  for (let index = 0; index < pixelCount; index++) {
    if (!visited[index] && selectionMask[index]) {
      const component: number[] = [];
      floodFill(index, component);
      
      if (component.length > 0) {
        regionCount++;
        
        if (useWeightedAverage) {
          // 基于颜色频率的加权平均算法
          const colorTolerance = 30; // 颜色容差，用于颜色聚类
          
          // 颜色聚类：将相似颜色归为一类
          const colorClusters: Array<{
            r: number;
            g: number;
            b: number;
            a: number;
            count: number;
            pixels: number[];
          }> = [];
          
          // 对区域内每个像素进行颜色聚类
          for (const idx of component) {
            const pIdx = idx * 4;
            const pixelR = layerPixels[pIdx];
            const pixelG = layerPixels[pIdx + 1];
            const pixelB = layerPixels[pIdx + 2];
            const pixelA = layerPixels[pIdx + 3];
            
            // 查找是否存在相似的颜色簇
            let foundCluster = false;
            for (const cluster of colorClusters) {
              const colorDistance = Math.sqrt(
                Math.pow(pixelR - cluster.r, 2) +
                Math.pow(pixelG - cluster.g, 2) +
                Math.pow(pixelB - cluster.b, 2) +
                Math.pow(pixelA - cluster.a, 2)
              );
              
              if (colorDistance <= colorTolerance) {
                // 更新簇的平均颜色（增量更新）
                const totalCount = cluster.count + 1;
                cluster.r = Math.round((cluster.r * cluster.count + pixelR) / totalCount);
                cluster.g = Math.round((cluster.g * cluster.count + pixelG) / totalCount);
                cluster.b = Math.round((cluster.b * cluster.count + pixelB) / totalCount);
                cluster.a = Math.round((cluster.a * cluster.count + pixelA) / totalCount);
                cluster.count = totalCount;
                cluster.pixels.push(idx);
                foundCluster = true;
                break;
              }
            }
            
            // 如果没有找到相似颜色簇，创建新的簇
            if (!foundCluster) {
              colorClusters.push({
                r: pixelR,
                g: pixelG,
                b: pixelB,
                a: pixelA,
                count: 1,
                pixels: [idx]
              });
            }
          }
          
          console.log(`加权区域 ${regionCount}: 像素数=${component.length}, 颜色簇数=${colorClusters.length}`);
          
          // 按颜色频率计算加权平均
          let weightedR = 0, weightedG = 0, weightedB = 0, weightedA = 0;
          let totalWeight = 0;
          
          for (const cluster of colorClusters) {
            const weight = cluster.count; // 颜色出现次数作为权重
            weightedR += cluster.r * weight;
            weightedG += cluster.g * weight;
            weightedB += cluster.b * weight;
            weightedA += cluster.a * weight;
            totalWeight += weight;
            
            console.log(`  颜色簇: RGB(${cluster.r},${cluster.g},${cluster.b}) 权重=${cluster.count}`);
          }
          
          const avgR = totalWeight > 0 ? Math.round(weightedR / totalWeight) : 0;
          const avgG = totalWeight > 0 ? Math.round(weightedG / totalWeight) : 0;
          const avgB = totalWeight > 0 ? Math.round(weightedB / totalWeight) : 0;
          const avgA = totalWeight > 0 ? Math.round(weightedA / totalWeight) : 0;
          
          console.log(`  最终加权平均: RGB(${avgR},${avgG},${avgB})`);
          
          // 应用弱化对比的混合算法
          for (const idx of component) {
            const pIdx = idx * 4;
            const coefficient = selectionCoefficients[idx];
            
            // 找到该像素所属的颜色簇
            let pixelCluster = null;
            for (const cluster of colorClusters) {
              if (cluster.pixels.includes(idx)) {
                pixelCluster = cluster;
                break;
              }
            }
            
            if (pixelCluster) {
              // 根据颜色频率计算弱化系数：频率越低，弱化效果越强
              const frequencyRatio = pixelCluster.count / component.length;
              const softenFactor = 0.2 + (1 - frequencyRatio) * 0.6; // 0.2-0.8的弱化范围
              
              // 混合原始像素和加权平均，产生弱化对比的效果
              // weightedIntensity: 1=保留更多原图像素, 10=保留更多加权平均
              const intensityFactor = weightedIntensity / 10; // 将1-10映射到0-1
              const blendFactor = coefficient * softenFactor * intensityFactor;
              result[pIdx] = Math.round(layerPixels[pIdx] * (1 - blendFactor) + avgR * blendFactor);
              result[pIdx + 1] = Math.round(layerPixels[pIdx + 1] * (1 - blendFactor) + avgG * blendFactor);
              result[pIdx + 2] = Math.round(layerPixels[pIdx + 2] * (1 - blendFactor) + avgB * blendFactor);
              result[pIdx + 3] = Math.round(layerPixels[pIdx + 3] * (1 - blendFactor) + avgA * blendFactor);
            }
          }
        } else {
          // 原始算法 - 计算简单平均颜色
          let totalR = 0, totalG = 0, totalB = 0, totalA = 0;
          
          for (const idx of component) {
            const pIdx = idx * 4;
            totalR += layerPixels[pIdx];
            totalG += layerPixels[pIdx + 1];
            totalB += layerPixels[pIdx + 2];
            totalA += layerPixels[pIdx + 3];
          }
          
          const avgR = Math.round(totalR / component.length);
          const avgG = Math.round(totalG / component.length);
          const avgB = Math.round(totalB / component.length);
          const avgA = Math.round(totalA / component.length);
          
          console.log(`矩形区域 ${regionCount}: 像素数=${component.length}, 平均颜色=RGB(${avgR},${avgG},${avgB}), 起始位置=(${component[0] % bounds.width}, ${Math.floor(component[0] / bounds.width)})`);
          
          // 将该区域的平均颜色应用到区域内的所有像素
          for (const idx of component) {
            const pIdx = idx * 4;
            const coefficient = selectionCoefficients[idx];
            
            // 根据选区系数混合原始颜色和区域平均颜色
            result[pIdx] = Math.round(layerPixels[pIdx] * (1 - coefficient) + avgR * coefficient);
            result[pIdx + 1] = Math.round(layerPixels[pIdx + 1] * (1 - coefficient) + avgG * coefficient);
            result[pIdx + 2] = Math.round(layerPixels[pIdx + 2] * (1 - coefficient) + avgB * coefficient);
            result[pIdx + 3] = Math.round(layerPixels[pIdx + 3] * (1 - coefficient) + avgA * coefficient);
          }
        }
      }
    }
  }
  
  console.log(`总共找到 ${regionCount} 个独立矩形区域`);
  
  return result;
}