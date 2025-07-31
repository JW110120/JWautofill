// 分块平均处理函数 - 对独立的矩形区域分别计算平均值
export async function processBlockAverage(layerPixelData: ArrayBuffer, selectionData: ArrayBuffer, bounds: { width: number; height: number }): Promise<Uint8Array> {
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
      
      const pixelIndex = index * 4;
      if (layerPixels[pixelIndex + 3] === 0) continue; // 跳过透明像素
      
      visited[index] = true;
      component.push(index);
      
      // 检查4连通的相邻像素
      const x = index % bounds.width;
      const y = Math.floor(index / bounds.width);
      
      // 右邻居
      if (x + 1 < bounds.width) {
        const rightIndex = y * bounds.width + (x + 1);
        if (rightIndex < pixelCount && !visited[rightIndex] && selectionMask[rightIndex] && layerPixels[rightIndex * 4 + 3] > 0) {
          stack.push(rightIndex);
        }
      }
      // 左邻居
      if (x - 1 >= 0) {
        const leftIndex = y * bounds.width + (x - 1);
        if (leftIndex < pixelCount && !visited[leftIndex] && selectionMask[leftIndex] && layerPixels[leftIndex * 4 + 3] > 0) {
          stack.push(leftIndex);
        }
      }
      // 下邻居
      if (y + 1 < bounds.height) {
        const downIndex = (y + 1) * bounds.width + x;
        if (downIndex < pixelCount && !visited[downIndex] && selectionMask[downIndex] && layerPixels[downIndex * 4 + 3] > 0) {
          stack.push(downIndex);
        }
      }
      // 上邻居
      if (y - 1 >= 0) {
        const upIndex = (y - 1) * bounds.width + x;
        if (upIndex < pixelCount && !visited[upIndex] && selectionMask[upIndex] && layerPixels[upIndex * 4 + 3] > 0) {
          stack.push(upIndex);
        }
      }
    }
  };
  
  // 查找所有独立的连通区域
  let regionCount = 0;
  for (let index = 0; index < pixelCount; index++) {
    if (!visited[index] && selectionMask[index] && layerPixels[index * 4 + 3] > 0) {
      const component: number[] = [];
      floodFill(index, component);
      
      if (component.length > 0) {
        regionCount++;
        
        // 计算这个区域的平均颜色
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
  
  console.log(`总共找到 ${regionCount} 个独立矩形区域`);
  
  return result;
}

// 像素过渡处理函数 - 高级模糊算法，只影响alpha>0的像素
export async function processPixelTransition(layerPixelData: ArrayBuffer, selectionData: ArrayBuffer, bounds: { width: number; height: number }, params: { radius: number; sigma: number }): Promise<Uint8Array> {
  const width = bounds.width;
  const height = bounds.height;
  const pixels = new Uint8Array(layerPixelData);
  const selectionMask = new Uint8Array(selectionData);
  const temp = new Uint8Array(pixels.length);
  const result = new Uint8Array(pixels.length);
  
  // 复制原始数据
  temp.set(pixels);
  result.set(pixels);
  
  // 高斯模糊参数
  const radius = params.radius;
  const sigma = params.sigma;
  
  // 创建高斯核
  const kernel: number[] = [];
  const kernelSize = radius * 2 + 1;
  let kernelSum = 0;
  
  for (let i = 0; i < kernelSize; i++) {
    const x = i - radius;
    const value = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel[i] = value;
    kernelSum += value;
  }
  
  // 归一化核
  for (let i = 0; i < kernelSize; i++) {
    kernel[i] /= kernelSum;
  }
  
  // 第一步：水平模糊（只处理alpha>0的像素）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const centerIdx = (y * width + x) * 4;
      
      // 只处理有透明度的像素
      if (pixels[centerIdx + 3] > 0) {
        let r = 0, g = 0, b = 0, a = 0;
        let weightSum = 0;
        
        for (let i = 0; i < kernelSize; i++) {
          const sampleX = x + i - radius;
          if (sampleX >= 0 && sampleX < width) {
            const idx = (y * width + sampleX) * 4;
            if (pixels[idx + 3] > 0) { // 只从有透明度的像素采样
              const weight = kernel[i];
              r += pixels[idx] * weight;
              g += pixels[idx + 1] * weight;
              b += pixels[idx + 2] * weight;
              a += pixels[idx + 3] * weight;
              weightSum += weight;
            }
          }
        }
        
        if (weightSum > 0) {
          temp[centerIdx] = Math.round(r / weightSum);
          temp[centerIdx + 1] = Math.round(g / weightSum);
          temp[centerIdx + 2] = Math.round(b / weightSum);
          temp[centerIdx + 3] = Math.round(a / weightSum);
        }
      }
    }
  }
  
  // 第二步：垂直模糊（基于水平模糊的结果）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const centerIdx = (y * width + x) * 4;
      
      // 只处理有透明度的像素
      if (temp[centerIdx + 3] > 0) {
        let r = 0, g = 0, b = 0, a = 0;
        let weightSum = 0;
        
        for (let i = 0; i < kernelSize; i++) {
          const sampleY = y + i - radius;
          if (sampleY >= 0 && sampleY < height) {
            const idx = (sampleY * width + x) * 4;
            if (temp[idx + 3] > 0) { // 只从有透明度的像素采样
              const weight = kernel[i];
              r += temp[idx] * weight;
              g += temp[idx + 1] * weight;
              b += temp[idx + 2] * weight;
              a += temp[idx + 3] * weight;
              weightSum += weight;
            }
          }
        }
        
        if (weightSum > 0) {
          result[centerIdx] = Math.round(r / weightSum);
          result[centerIdx + 1] = Math.round(g / weightSum);
          result[centerIdx + 2] = Math.round(b / weightSum);
          result[centerIdx + 3] = Math.round(a / weightSum);
        }
      }
    }
  }
  
  // 第三步：边缘保护 - 在透明和不透明像素边界处进行特殊处理
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const centerIdx = (y * width + x) * 4;
      
      if (result[centerIdx + 3] > 0) {
        // 检查周围8个像素的透明度变化
        let transparentNeighbors = 0;
        let opaqueNeighbors = 0;
        
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            
            const neighborIdx = ((y + dy) * width + (x + dx)) * 4;
            if (result[neighborIdx + 3] === 0) {
              transparentNeighbors++;
            } else {
              opaqueNeighbors++;
            }
          }
        }
        
        // 如果是边缘像素（有透明邻居），减少模糊强度
        if (transparentNeighbors > 0) {
          const edgeFactor = 1 - (transparentNeighbors / 8) * 0.5;
          result[centerIdx] = Math.round(pixels[centerIdx] * (1 - edgeFactor) + result[centerIdx] * edgeFactor);
          result[centerIdx + 1] = Math.round(pixels[centerIdx + 1] * (1 - edgeFactor) + result[centerIdx + 1] * edgeFactor);
          result[centerIdx + 2] = Math.round(pixels[centerIdx + 2] * (1 - edgeFactor) + result[centerIdx + 2] * edgeFactor);
          result[centerIdx + 3] = Math.round(pixels[centerIdx + 3] * (1 - edgeFactor) + result[centerIdx + 3] * edgeFactor);
        }
      }
    }
  }
  
  return result;
}