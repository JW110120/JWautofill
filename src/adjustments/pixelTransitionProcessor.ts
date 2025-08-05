// 像素过渡处理算法 - 高级模糊算法，只影响alpha>0的像素
export async function processPixelTransition(layerPixelData: ArrayBuffer, selectionData: ArrayBuffer, bounds: { width: number; height: number }, params: { radius: number; sigma: number }, isBackgroundLayer: boolean = false): Promise<Uint8Array> {
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
  
  // 第一步：水平模糊（根据图层类型处理像素）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const centerIdx = (y * width + x) * 4;
      const centerAlpha = pixels[centerIdx + 3];
      
      // 根据图层类型判断是否需要处理该像素
      let shouldProcess = false;
      if (isBackgroundLayer) {
        // 背景图层：只处理选区内的像素
        const selectionValue = selectionMask[y * width + x] || 0;
        shouldProcess = selectionValue > 0;
      } else {
        // 普通图层：只处理有透明度的像素
        shouldProcess = centerAlpha > 0;
      }
      
      if (shouldProcess) {
        let r = 0, g = 0, b = 0, a = 0;
        let weightSum = 0;
        let transparentSamples = 0;
        let totalSamples = 0;
        
        for (let i = 0; i < kernelSize; i++) {
          const sampleX = x + i - radius;
          if (sampleX >= 0 && sampleX < width) {
            const idx = (y * width + sampleX) * 4;
            const sampleAlpha = pixels[idx + 3];
            totalSamples++;
            
            // 根据图层类型判断是否为透明像素
            let isTransparent = false;
            if (isBackgroundLayer) {
              // 背景图层：超出边界或不在选区内的像素视为透明（不参与模糊计算）
              if (sampleX < 0 || sampleX >= width) {
                isTransparent = true; // 超出边界的像素视为透明
              } else {
                const sampleSelectionValue = selectionMask[y * width + sampleX] || 0;
                isTransparent = sampleSelectionValue === 0;
              }
            } else {
              // 普通图层：alpha为0视为透明
              isTransparent = sampleAlpha === 0;
            }
            
            if (!isTransparent) { // 从非透明像素采样
              const weight = kernel[i];
              r += pixels[idx] * weight;
              g += pixels[idx + 1] * weight;
              b += pixels[idx + 2] * weight;
              a += sampleAlpha * weight;
              weightSum += weight;
            } else {
              transparentSamples++;
            }
          }
        }
        
        if (weightSum > 0) {
          const transparentRatio = transparentSamples / totalSamples;
          
          // 使用更平滑的边界保护策略，避免方向性差异
          if (transparentRatio > 0.5) {
            // 根据透明比例计算渐进的混合因子，而不是固定值
            const blendFactor = Math.min(0.4, (transparentRatio - 0.5) * 0.8);
            temp[centerIdx] = Math.round(pixels[centerIdx] * (1 - blendFactor) + (r / weightSum) * blendFactor);
            temp[centerIdx + 1] = Math.round(pixels[centerIdx + 1] * (1 - blendFactor) + (g / weightSum) * blendFactor);
            temp[centerIdx + 2] = Math.round(pixels[centerIdx + 2] * (1 - blendFactor) + (b / weightSum) * blendFactor);
            temp[centerIdx + 3] = Math.round(centerAlpha * (1 - blendFactor * 0.6) + (a / weightSum) * (blendFactor * 0.6));
          } else {
            // 正常模糊处理
            temp[centerIdx] = Math.round(r / weightSum);
            temp[centerIdx + 1] = Math.round(g / weightSum);
            temp[centerIdx + 2] = Math.round(b / weightSum);
            temp[centerIdx + 3] = Math.round(a / weightSum);
          }
        }
      }
    }
  }
  
  // 第二步：垂直模糊（基于水平模糊的结果，保持一致的边界处理策略）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const centerIdx = (y * width + x) * 4;
      const centerAlpha = temp[centerIdx + 3];
      const originalAlpha = pixels[centerIdx + 3];
      
      // 根据图层类型判断是否需要处理该像素
      let shouldProcess = false;
      if (isBackgroundLayer) {
        // 背景图层：只处理选区内的像素
        const selectionValue = selectionMask[y * width + x] || 0;
        shouldProcess = selectionValue > 0;
      } else {
        // 普通图层：只处理有透明度的像素
        shouldProcess = centerAlpha > 0;
      }
      
      if (shouldProcess) {
        let r = 0, g = 0, b = 0, a = 0;
        let weightSum = 0;
        let transparentSamples = 0;
        let totalSamples = 0;
        
        for (let i = 0; i < kernelSize; i++) {
          const sampleY = y + i - radius;
          if (sampleY >= 0 && sampleY < height) {
            const idx = (sampleY * width + x) * 4;
            const sampleAlpha = temp[idx + 3];
            totalSamples++;
            
            // 根据图层类型判断是否为透明像素
            let isTransparent = false;
            if (isBackgroundLayer) {
              // 背景图层：超出边界或不在选区内的像素视为透明（不参与模糊计算）
              if (sampleY < 0 || sampleY >= height) {
                isTransparent = true; // 超出边界的像素视为透明
              } else {
                const sampleSelectionValue = selectionMask[sampleY * width + x] || 0;
                isTransparent = sampleSelectionValue === 0;
              }
            } else {
              // 普通图层：alpha为0视为透明
              isTransparent = sampleAlpha === 0;
            }
            
            if (!isTransparent) { // 从非透明像素采样
              const weight = kernel[i];
              r += temp[idx] * weight;
              g += temp[idx + 1] * weight;
              b += temp[idx + 2] * weight;
              a += sampleAlpha * weight;
              weightSum += weight;
            } else {
              transparentSamples++;
            }
          }
        }
        
        if (weightSum > 0) {
          const transparentRatio = transparentSamples / totalSamples;
          
          // 使用与水平模糊相同的渐进边界保护策略
          if (transparentRatio > 0.5) {
            // 根据透明比例计算渐进的混合因子，保持与水平模糊一致
            const blendFactor = Math.min(0.4, (transparentRatio - 0.5) * 0.8);
            result[centerIdx] = Math.round(temp[centerIdx] * (1 - blendFactor) + (r / weightSum) * blendFactor);
            result[centerIdx + 1] = Math.round(temp[centerIdx + 1] * (1 - blendFactor) + (g / weightSum) * blendFactor);
            result[centerIdx + 2] = Math.round(temp[centerIdx + 2] * (1 - blendFactor) + (b / weightSum) * blendFactor);
            result[centerIdx + 3] = Math.round(centerAlpha * (1 - blendFactor * 0.6) + (a / weightSum) * (blendFactor * 0.6));
          } else {
            // 正常模糊处理
            result[centerIdx] = Math.round(r / weightSum);
            result[centerIdx + 1] = Math.round(g / weightSum);
            result[centerIdx + 2] = Math.round(b / weightSum);
            result[centerIdx + 3] = Math.round(a / weightSum);
          }
        }
      }
    }
  }
  
  // 第三步：智能边缘保护 - 保持抗锯齿效果的同时进行边缘处理，防止半透明叠加
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const centerIdx = (y * width + x) * 4;
      const originalAlpha = pixels[centerIdx + 3];
      const blurredAlpha = result[centerIdx + 3];
      
      if (originalAlpha > 0) {
        // 计算周围像素的透明度梯度和变化强度
        let alphaGradientSum = 0;
        let maxAlphaDiff = 0;
        let neighborCount = 0;
        let lowAlphaNeighbors = 0;
        let highAlphaNeighbors = 0;
        
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            
            const neighborIdx = ((y + dy) * width + (x + dx)) * 4;
            const neighborAlpha = pixels[neighborIdx + 3];
            
            // 计算alpha差异
            const alphaDiff = Math.abs(originalAlpha - neighborAlpha);
            maxAlphaDiff = Math.max(maxAlphaDiff, alphaDiff);
            alphaGradientSum += alphaDiff;
            neighborCount++;
            
            // 统计低alpha邻居（包括完全透明）
            if (neighborAlpha < originalAlpha * 0.5) {
              lowAlphaNeighbors++;
            }
            // 统计高alpha邻居
            if (neighborAlpha > originalAlpha * 1.5 && neighborAlpha > 100) {
              highAlphaNeighbors++;
            }
          }
        }
        
        const avgAlphaGradient = alphaGradientSum / neighborCount;
        
        // 检测alpha叠加现象：模糊后的透明度显著高于原始透明度
        const alphaIncrease = blurredAlpha - originalAlpha;
        const alphaIncreaseRatio = originalAlpha > 0 ? alphaIncrease / originalAlpha : 0;
        
        // 检查是否有透明邻居（用于判断是否为外轮廓）
        let hasTransparentNeighbor = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const neighborIdx = ((y + dy) * width + (x + dx)) * 4;
            const neighborAlpha = pixels[neighborIdx + 3];
            if (neighborAlpha === 0) {
              hasTransparentNeighbor = true;
              break;
            }
          }
          if (hasTransparentNeighbor) break;
        }
        
        // 只有在外轮廓边缘（有透明邻居）才检测半透明叠加
        const isSemiTransparentOverlay = hasTransparentNeighbor && alphaIncrease > 30 && alphaIncreaseRatio > 0.3 && originalAlpha < 200;
        
        // 精确分类当前像素和邻居像素的透明度类型
        const getAlphaType = (alpha) => {
          if (alpha === 0) return 'transparent'; // 完全透明
          if (alpha === 255) return 'opaque'; // 完全不透明
          return 'semitransparent'; // 半透明
        };
        
        const centerAlphaType = getAlphaType(originalAlpha);
        
        // 检测是否存在外轮廓边界（透明区域与不透明/半透明的边界）
        let hasOutlineEdge = false;
        
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            
            const neighborIdx = ((y + dy) * width + (x + dx)) * 4;
            const neighborAlpha = pixels[neighborIdx + 3];
            const neighborAlphaType = getAlphaType(neighborAlpha);
            
            // 检测外轮廓边界：透明区域与不透明、透明区域与半透明
            const isOutlineEdgeCase = 
              (centerAlphaType === 'transparent' && (neighborAlphaType === 'opaque' || neighborAlphaType === 'semitransparent')) ||
              (neighborAlphaType === 'transparent' && (centerAlphaType === 'opaque' || centerAlphaType === 'semitransparent'));
            
            if (isOutlineEdgeCase) {
              hasOutlineEdge = true;
              break;
            }
          }
          if (hasOutlineEdge) break;
        }
        
        // 只有外轮廓边界需要保护
        const isOuterEdgePixel = hasOutlineEdge && centerAlphaType !== 'transparent' && (maxAlphaDiff > 50 || avgAlphaGradient > 30);
        
        if (isOuterEdgePixel || isSemiTransparentOverlay) {
          // 根据原始透明度和梯度强度计算保护强度
          const alphaRatio = originalAlpha / 255;
          const gradientFactor = Math.min(maxAlphaDiff / 255, 1);
          
          let protectionStrength;
          
          if (isSemiTransparentOverlay) {
            // 针对半透明叠加的特殊保护
            const overlayIntensity = Math.min(alphaIncreaseRatio, 1);
            protectionStrength = 0.7 + overlayIntensity * 0.25; // 强保护，防止叠加
            
            // 对于半透明叠加，额外限制透明度增长
            const maxAllowedAlpha = Math.min(originalAlpha * 1.2, originalAlpha + 20);
            if (blurredAlpha > maxAllowedAlpha) {
              result[centerIdx + 3] = Math.round(maxAllowedAlpha);
            }
          } else if (isOuterEdgePixel) {
            // 外轮廓边界保护：只保护透明区域与不透明/半透明的边界
            if (alphaRatio < 0.3) {
              // 低透明度像素：强保护，保持抗锯齿效果
              protectionStrength = 0.8 + gradientFactor * 0.15;
            } else if (alphaRatio < 0.7) {
              // 中等透明度像素：中等保护
              protectionStrength = 0.6 + gradientFactor * 0.2;
            } else {
              // 高透明度像素：轻微保护
              protectionStrength = 0.3 + gradientFactor * 0.3;
            }
          }
          
          // 应用保护：混合原始像素和模糊像素
          result[centerIdx] = Math.round(pixels[centerIdx] * protectionStrength + result[centerIdx] * (1 - protectionStrength));
          result[centerIdx + 1] = Math.round(pixels[centerIdx + 1] * protectionStrength + result[centerIdx + 1] * (1 - protectionStrength));
          result[centerIdx + 2] = Math.round(pixels[centerIdx + 2] * protectionStrength + result[centerIdx + 2] * (1 - protectionStrength));
          
          // 对透明度通道使用特殊处理，保持渐变效果
          if (!isSemiTransparentOverlay) {
            const alphaProtection = Math.min(protectionStrength + 0.1, 0.95);
            result[centerIdx + 3] = Math.round(pixels[centerIdx + 3] * alphaProtection + result[centerIdx + 3] * (1 - alphaProtection));
          }
        }
      }
    }
  }
  
  return result;
}