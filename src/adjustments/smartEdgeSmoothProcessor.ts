/**
 * 智能线条拉直处理器
 * 
 * 专门用于拉直锯齿状线条的算法，通过方向检测和线性插值实现线条平滑
 * 
 * 主要特性：
 * - 自适应方向检测：根据半径大小动态调整检测方向数量
 * - 多尺度处理：大半径时扩展尺度范围，提升大尺度线条处理效果
 * - 动态阈值：半径越大，相似度阈值越宽松
 * - 改进权重算法：对大半径更友好的距离权重计算
 * - 选区约束：只在选区内进行处理
 * - 自适应混合：根据保留细节参数调整拉直强度
 */

// 边缘检测参数接口
interface EdgeDetectionParams {
  alphaThreshold: number;     // alpha差异阈值（0-255）
  colorThreshold: number;     // 颜色反差阈值（0-255）
  smoothRadius: number;       // 平滑半径
  preserveDetail: boolean;    // 是否保留细节
  intensity: number;          // 拉直强度（1-10）
}

// 计算两个像素之间的颜色差异
function calculateColorDifference(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// 检测像素是否为边缘
function isEdgePixel(
  pixelData: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  params: EdgeDetectionParams,
  isBackgroundLayer: boolean = false
): boolean {
  const centerIndex = (y * width + x) * 4;
  const centerR = pixelData[centerIndex];
  const centerG = pixelData[centerIndex + 1];
  const centerB = pixelData[centerIndex + 2];
  const centerA = pixelData[centerIndex + 3];

  // 检查周围8个像素
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      
      const nx = x + dx;
      const ny = y + dy;
      
      // 边界检查
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      
      const neighborIndex = (ny * width + nx) * 4;
      const neighborR = pixelData[neighborIndex];
      const neighborG = pixelData[neighborIndex + 1];
      const neighborB = pixelData[neighborIndex + 2];
      const neighborA = pixelData[neighborIndex + 3];
      
      // 对于背景图层，主要检查颜色差异（alpha通常都是255）
      if (isBackgroundLayer) {
        const colorDiff = calculateColorDifference(
          centerR, centerG, centerB,
          neighborR, neighborG, neighborB
        );
        if (colorDiff > params.colorThreshold) {
          return true;
        }
      } else {
        // 对于普通图层，检查alpha差异
        const alphaDiff = Math.abs(centerA - neighborA);
        if (alphaDiff > params.alphaThreshold) {
          return true;
        }
        
        // 当alpha都不为0时，检查颜色差异
        if (centerA > 0 && neighborA > 0) {
          const colorDiff = calculateColorDifference(
            centerR, centerG, centerB,
            neighborR, neighborG, neighborB
          );
          if (colorDiff > params.colorThreshold) {
            return true;
          }
        }
      }
    }
  }
  
  return false;
}

// 计算像素的梯度方向
function calculateGradient(
  pixelData: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number
): { magnitude: number; direction: number } {
  // 使用Sobel算子计算梯度
  const sobelX = [
    [-1, 0, 1],
    [-2, 0, 2],
    [-1, 0, 1]
  ];
  
  const sobelY = [
    [-1, -2, -1],
    [0, 0, 0],
    [1, 2, 1]
  ];
  
  let gx = 0, gy = 0;
  
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const index = (ny * width + nx) * 4;
        // 使用灰度值计算梯度
        const gray = 0.299 * pixelData[index] + 0.587 * pixelData[index + 1] + 0.114 * pixelData[index + 2];
        
        gx += gray * sobelX[dy + 1][dx + 1];
        gy += gray * sobelY[dy + 1][dx + 1];
      }
    }
  }
  
  const magnitude = Math.sqrt(gx * gx + gy * gy);
  const direction = Math.atan2(gy, gx);
  
  return { magnitude, direction };
}

// 大尺度线条拉直算法（支持30像素以上的凹凸拉直）
// 已移除getLargeScaleLineStraightening函数，统一使用改进的getLineStraighteningSmooth算法

// 计算点集的线性度
function calculateLinearity(points: Array<{x: number, y: number, gray: number, step: number}>): number {
  if (points.length < 3) return 0;
  
  // 使用最小二乘法拟合直线 y = ax + b
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
    sumXY += point.x * point.y;
    sumX2 += point.x * point.x;
  }
  
  const denominator = n * sumX2 - sumX * sumX;
  if (Math.abs(denominator) < 1e-10) return 0;
  
  const a = (n * sumXY - sumX * sumY) / denominator;
  const b = (sumY - a * sumX) / n;
  
  // 计算拟合度（R²）
  let ssRes = 0, ssTot = 0;
  const meanY = sumY / n;
  
  for (const point of points) {
    const predicted = a * point.x + b;
    ssRes += (point.y - predicted) * (point.y - predicted);
    ssTot += (point.y - meanY) * (point.y - meanY);
  }
  
  if (ssTot < 1e-10) return 1;
  return Math.max(0, 1 - ssRes / ssTot);
}

// 基于线性拟合结果进行平滑
function performLinearSmoothing(
  pixelData: Uint8Array,
  points: Array<{x: number, y: number, gray: number, step: number}>,
  centerX: number,
  centerY: number,
  width: number,
  originalR: number,
  originalG: number,
  originalB: number,
  originalA: number
): [number, number, number, number] {
  if (points.length === 0) {
    return [originalR, originalG, originalB, originalA];
  }
  
  // 使用距离加权平均，距离越近权重越大
  let totalR = 0, totalG = 0, totalB = 0, totalA = 0, totalWeight = 0;
  
  for (const point of points) {
    const distance = Math.sqrt((point.x - centerX) ** 2 + (point.y - centerY) ** 2);
    const weight = Math.exp(-distance / 10); // 指数衰减权重
    
    const idx = (point.y * width + point.x) * 4;
    if (idx >= 0 && idx < pixelData.length - 3) {
      totalR += pixelData[idx] * weight;
      totalG += pixelData[idx + 1] * weight;
      totalB += pixelData[idx + 2] * weight;
      totalA += pixelData[idx + 3] * weight;
      totalWeight += weight;
    }
  }
  
  if (totalWeight === 0) {
    return [originalR, originalG, originalB, originalA];
  }
  
  return [
    Math.max(0, Math.min(255, Math.round(totalR / totalWeight))),
    Math.max(0, Math.min(255, Math.round(totalG / totalWeight))),
    Math.max(0, Math.min(255, Math.round(totalB / totalWeight))),
    Math.max(0, Math.min(255, Math.round(totalA / totalWeight)))
  ];
}

// 原有的小尺度线条拉直算法（保留用于小半径处理）
function getLineStraighteningSmooth(
  pixelData: Uint8Array,
  selectionMask: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): [number, number, number, number] {
  const originalIndex = (y * width + x) * 4;
  const centerIndex = y * width + x;
  const centerMaskValue = selectionMask[centerIndex];
  
  // 如果当前像素不在选区内，直接返回原始值
  if (centerMaskValue === 0) {
    return [
      pixelData[originalIndex],
      pixelData[originalIndex + 1],
      pixelData[originalIndex + 2],
      pixelData[originalIndex + 3]
    ];
  }
  
  // 获取原始像素值
  const originalR = pixelData[originalIndex];
  const originalG = pixelData[originalIndex + 1];
  const originalB = pixelData[originalIndex + 2];
  const originalA = pixelData[originalIndex + 3];
  
  // 改进的方向检测：使用更多方向，特别是对大半径
  const directions = [];
  const numDirections = Math.min(16, Math.max(8, radius));
  for (let i = 0; i < numDirections; i++) {
    const angle = (i * Math.PI) / numDirections;
    directions.push({
      dx: Math.cos(angle),
      dy: Math.sin(angle),
      name: `角度${(angle * 180 / Math.PI).toFixed(1)}°`
    });
  }
  
  let bestDirection = null;
  let maxSimilarity = 0;
  
  // 找到最佳的线条方向
  for (const dir of directions) {
    let similarity = 0;
    let count = 0;
    const linePoints = [];
    
    // 沿着方向收集像素点，改进采样策略
    for (let step = -radius; step <= radius; step++) {
      if (step === 0) continue; // 跳过中心点
      
      const px = Math.round(x + dir.dx * step);
      const py = Math.round(y + dir.dy * step);
      
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const maskIdx = py * width + px;
        if (selectionMask[maskIdx] > 0) {
          const idx = (py * width + px) * 4;
          const gray = 0.299 * pixelData[idx] + 0.587 * pixelData[idx + 1] + 0.114 * pixelData[idx + 2];
          linePoints.push({ x: px, y: py, gray: gray, step: step });
          
          // 计算颜色相似度
          const colorDiff = calculateColorDifference(
            originalR, originalG, originalB,
            pixelData[idx], pixelData[idx + 1], pixelData[idx + 2]
          );
          
          // 动态调整容差：半径越大，容差越大
          const tolerance = Math.min(200, 80 + radius * 4);
          const stepWeight = Math.max(0.3, 1.0 - Math.abs(step) / (radius * 1.5));
          similarity += Math.max(0, tolerance - colorDiff) * stepWeight;
          count++;
        }
      }
    }
    
    // 如果有足够的点，计算线性度作为额外的评估标准
    if (linePoints.length >= 3) {
      const linearity = calculateLinearity(linePoints);
      const avgSimilarity = count > 0 ? similarity / count : 0;
      
      // 综合相似度和线性度
      const combinedScore = avgSimilarity * 0.7 + linearity * 100 * 0.3;
      
      if (combinedScore > maxSimilarity) {
        maxSimilarity = combinedScore;
        bestDirection = { ...dir, points: linePoints };
      }
    }
  }
  
  // 动态调整阈值：考虑半径和线性度
  const baseThreshold = Math.max(10, 25 - radius * 1.5);
  const linearityBonus = bestDirection && bestDirection.points ? calculateLinearity(bestDirection.points) * 50 : 0;
  const dynamicThreshold = baseThreshold - linearityBonus;
  
  // 如果没有找到明显的方向，返回原始像素
  if (!bestDirection || maxSimilarity < dynamicThreshold) {
    return [originalR, originalG, originalB, originalA];
  }
  
  // 使用改进的平滑方法
  if (bestDirection.points && bestDirection.points.length >= 3) {
    // 如果有线性度信息，使用基于线性拟合的平滑
    return performLinearSmoothing(
      pixelData, 
      bestDirection.points, 
      x, 
      y, 
      width,
      originalR, 
      originalG, 
      originalB, 
      originalA
    );
  } else {
    // 否则使用传统的方向平滑
    let totalR = originalR * 2; // 给中心像素更高权重
    let totalG = originalG * 2;
    let totalB = originalB * 2;
    let totalA = originalA * 2;
    let totalWeight = 2;
    
    // 沿着最佳方向收集像素
    for (let step = 1; step <= radius; step++) {
      const positions = [
        { x: Math.round(x + bestDirection.dx * step), y: Math.round(y + bestDirection.dy * step) },
        { x: Math.round(x - bestDirection.dx * step), y: Math.round(y - bestDirection.dy * step) }
      ];
      
      for (const pos of positions) {
        if (pos.x >= 0 && pos.x < width && pos.y >= 0 && pos.y < height) {
          const idx = (pos.y * width + pos.x) * 4;
          const maskIdx = pos.y * width + pos.x;
          
          if (selectionMask[maskIdx] > 0) {
            // 改进的距离权重：对大半径更友好
            const weight = Math.max(0.1, 1.0 - (step - 1) / (radius * 1.5));
            
            totalR += pixelData[idx] * weight;
            totalG += pixelData[idx + 1] * weight;
            totalB += pixelData[idx + 2] * weight;
            totalA += pixelData[idx + 3] * weight;
            totalWeight += weight;
          }
        }
      }
    }
    
    const smoothedR = Math.max(0, Math.min(255, Math.round(totalR / totalWeight)));
    const smoothedG = Math.max(0, Math.min(255, Math.round(totalG / totalWeight)));
    const smoothedB = Math.max(0, Math.min(255, Math.round(totalB / totalWeight)));
    const smoothedA = Math.max(0, Math.min(255, Math.round(totalA / totalWeight)));
    
    return [smoothedR, smoothedG, smoothedB, smoothedA];
  }
}

// 多尺度线条拉直处理
function getMultiScaleLineStraightening(
  pixelData: Uint8Array,
  selectionMask: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  baseRadius: number
): [number, number, number, number] {
  // 根据基础半径动态调整尺度范围
  const scales = baseRadius <= 5 
    ? [0.8, 1.0, 1.2] // 小半径：保持原有范围
    : [0.6, 1.0, 1.4, 1.8]; // 大半径：扩大范围以处理大尺度问题
  const weights = baseRadius <= 5
    ? [0.3, 0.4, 0.3] // 小半径权重
    : [0.2, 0.3, 0.3, 0.2]; // 大半径权重
  
  let finalR = 0, finalG = 0, finalB = 0, finalA = 0;
  
  for (let i = 0; i < scales.length; i++) {
    const radius = Math.max(1, Math.round(baseRadius * scales[i]));
    const [r, g, b, a] = getLineStraighteningSmooth(
      pixelData, selectionMask, x, y, width, height, radius
    );
    
    finalR += r * weights[i];
    finalG += g * weights[i];
    finalB += b * weights[i];
    finalA += a * weights[i];
  }
  
  return [
    Math.max(0, Math.min(255, Math.round(finalR))),
    Math.max(0, Math.min(255, Math.round(finalG))),
    Math.max(0, Math.min(255, Math.round(finalB))),
    Math.max(0, Math.min(255, Math.round(finalA)))
  ];
}

// 主处理函数
export async function processSmartEdgeSmooth(
  pixelDataBuffer: ArrayBuffer,
  selectionMaskBuffer: ArrayBuffer,
  dimensions: { width: number; height: number },
  params: EdgeDetectionParams,
  isBackgroundLayer: boolean = false
): Promise<ArrayBuffer> {
  
  const pixelData = new Uint8Array(pixelDataBuffer);
  const selectionMask = new Uint8Array(selectionMaskBuffer);
  const { width, height } = dimensions;
  
  
  // 检查选区掩码中的非零值数量
  let selectionPixelCount = 0;
  for (let i = 0; i < selectionMask.length; i++) {
    if (selectionMask[i] > 0) selectionPixelCount++;
  }
  
  // 检查像素数据是否全为0（这可能是问题所在）
  let nonZeroPixelCount = 0;
  for (let i = 0; i < pixelData.length; i += 4) {
    if (pixelData[i] > 0 || pixelData[i + 1] > 0 || pixelData[i + 2] > 0 || pixelData[i + 3] > 0) {
      nonZeroPixelCount++;
    }
  }
  
  // 创建输出数组
  const outputData = new Uint8Array(pixelData.length);
  outputData.set(pixelData); // 先复制原始数据
  
  // 第一步：识别边缘像素
  const edgeMap = new Uint8Array(width * height);
  let edgeCount = 0;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskIndex = y * width + x;
      
      // 只处理选区内的像素
      if (selectionMask[maskIndex] === 0) continue;
      
      if (isEdgePixel(pixelData, x, y, width, height, params, isBackgroundLayer)) {
        edgeMap[maskIndex] = 255;
        edgeCount++;
      }
    }
  }
  
  console.log(`✅ 识别到 ${edgeCount} 个边缘像素`);
  
  // 第二步：对边缘像素进行平滑处理
  let processedCount = 0;
  let debugCount = 0;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskIndex = y * width + x;
      const pixelIndex = maskIndex * 4;
      
      // 只处理选区内的像素
      if (selectionMask[maskIndex] === 0) continue;
      
      const originalR = pixelData[pixelIndex];
      const originalG = pixelData[pixelIndex + 1];
      const originalB = pixelData[pixelIndex + 2];
      const originalA = pixelData[pixelIndex + 3];
      
      // 检测是否为边缘像素
      const isEdge = edgeMap[maskIndex] > 0;
      
      if (isEdge) {
        // 使用改进的线条拉直算法，能够处理各种尺度的凹凸
        const [smoothR, smoothG, smoothB, smoothA] = getLineStraighteningSmooth(
          pixelData,
          selectionMask,
          x,
          y,
          width,
          height,
          params.smoothRadius
        );
        
        // 根据强度参数计算混合因子，重新设计强度曲线
        // 强度1-10对应混合因子0.3-0.95，确保强度1就有明显效果
        let blendFactor;
        if (params.preserveDetail) {
          // 保留细节模式：强度1=0.2, 强度5=0.5, 强度10=0.8
          blendFactor = 0.1 + (params.intensity - 1) * 0.7 / 9;
        } else {
          // 标准模式：强度1=0.3, 强度5=0.65, 强度10=0.95
          blendFactor = 0.2 + (params.intensity - 1) * 0.75 / 9;
        }
        blendFactor = Math.max(0.1, Math.min(0.95, blendFactor));
        
        // 混合原始像素和平滑后的像素
        const blendedR = Math.round(originalR * (1 - blendFactor) + smoothR * blendFactor);
        const blendedG = Math.round(originalG * (1 - blendFactor) + smoothG * blendFactor);
        const blendedB = Math.round(originalB * (1 - blendFactor) + smoothB * blendFactor);
        const blendedA = Math.round(originalA * (1 - blendFactor) + smoothA * blendFactor);
        
        outputData[pixelIndex] = Math.max(0, Math.min(255, blendedR));
        outputData[pixelIndex + 1] = Math.max(0, Math.min(255, blendedG));
        outputData[pixelIndex + 2] = Math.max(0, Math.min(255, blendedB));
        outputData[pixelIndex + 3] = Math.max(0, Math.min(255, blendedA));
        
        processedCount++;
      } else {
        // 非边缘像素保持原样
        outputData[pixelIndex] = originalR;
        outputData[pixelIndex + 1] = originalG;
        outputData[pixelIndex + 2] = originalB;
        outputData[pixelIndex + 3] = originalA;
      }
    }
  }
  
  console.log(`✅ 拉直了 ${processedCount} 个边缘像素`);
  console.log('✅ 智能线条拉直处理完成:', {
    处理像素数: processedCount,
    边缘像素数: edgeCount,
    处理比例: `${((processedCount / Math.max(edgeCount, 1)) * 100).toFixed(1)}%`,
    算法效果: '方向检测拉直，消除锯齿线条'
  });
  
  return outputData.buffer;
}

// 默认参数
export const defaultSmartEdgeSmoothParams: EdgeDetectionParams = {
  alphaThreshold: 10,      // alpha差异阈值
  colorThreshold: 10,      // 颜色反差阈值
  smoothRadius: 20,         // 平滑半径
  preserveDetail: true,    // 保留细节
  intensity: 10             // 拉直强度
};