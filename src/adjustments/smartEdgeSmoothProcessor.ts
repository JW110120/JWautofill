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

  const pixelCount = width * height;
  const outputData = new Uint8Array(pixelData.length);
  outputData.set(pixelData);

  const clamp255 = (v: number) => Math.max(0, Math.min(255, v));
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const lumaFromPremult = (r: number, g: number, b: number) => (77 * r + 150 * g + 29 * b + 128) >> 8;

  const lumaP = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const p = i * 4;
    const a = isBackgroundLayer ? 255 : pixelData[p + 3];
    const rP = (pixelData[p] * a + 127) / 255;
    const gP = (pixelData[p + 1] * a + 127) / 255;
    const bP = (pixelData[p + 2] * a + 127) / 255;
    lumaP[i] = lumaFromPremult(rP, gP, bP);
  }

  const gradMag = new Uint16Array(pixelCount);
  const gradDir = new Uint8Array(pixelCount);
  const gradHist = new Uint32Array(2048);
  let selectedCount = 0;

  const getL = (x: number, y: number) => lumaP[y * width + x];

  for (let y = 1; y < height - 1; y++) {
    const rowBase = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = rowBase + x;
      if ((selectionMask[idx] || 0) === 0) continue;

      const p00 = getL(x - 1, y - 1);
      const p10 = getL(x, y - 1);
      const p20 = getL(x + 1, y - 1);
      const p01 = getL(x - 1, y);
      const p21 = getL(x + 1, y);
      const p02 = getL(x - 1, y + 1);
      const p12 = getL(x, y + 1);
      const p22 = getL(x + 1, y + 1);

      const gx = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;
      const gy = -p00 - 2 * p10 - p20 + p02 + 2 * p12 + p22;

      const agx = Math.abs(gx);
      const agy = Math.abs(gy);
      const g = agx + agy;
      const gClamped = g > 2047 ? 2047 : g;
      gradMag[idx] = gClamped;

      let dir = 0;
      if (agx === 0 && agy === 0) {
        dir = 0;
      } else if (agy <= (agx * 106) / 256) {
        dir = 0;
      } else if (agy >= (agx * 618) / 256) {
        dir = 2;
      } else {
        dir = gx * gy >= 0 ? 1 : 3;
      }
      gradDir[idx] = dir;

      gradHist[gClamped]++;
      selectedCount++;
    }
  }

  if (selectedCount <= 0) {
    return outputData.buffer;
  }

  const getPercentile = (p01: number) => {
    const target = Math.max(0, Math.min(selectedCount - 1, Math.round(p01 * (selectedCount - 1))));
    let acc = 0;
    for (let i = 0; i < gradHist.length; i++) {
      acc += gradHist[i];
      if (acc > target) return i;
    }
    return gradHist.length - 1;
  };

  const p70 = getPercentile(0.7);
  const p92 = getPercentile(0.92);
  const paramEdgeThreshold = isBackgroundLayer
    ? params.colorThreshold * 6
    : Math.max(params.colorThreshold * 6, params.alphaThreshold * 6);
  const edgeThreshold = Math.max(24, Math.min(600, Math.max(p70, paramEdgeThreshold)));
  const strongThreshold = Math.max(edgeThreshold + 1, Math.min(900, Math.max(p92, edgeThreshold + 40)));

  const intensity01 = clamp01(params.intensity / 10);
  const intensityCurve = Math.pow(intensity01, 0.45);
  const baseStrength = clamp01(intensityCurve * (params.preserveDetail ? 1.05 : 1.45));

  let selMinX = width;
  let selMinY = height;
  let selMaxX = -1;
  let selMaxY = -1;
  for (let i = 0; i < pixelCount; i++) {
    if ((selectionMask[i] || 0) === 0) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < selMinX) selMinX = x;
    if (x > selMaxX) selMaxX = x;
    if (y < selMinY) selMinY = y;
    if (y > selMaxY) selMaxY = y;
  }
  if (selMaxX < 0) {
    return outputData.buffer;
  }

  const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));

  const medianEnabled = params.smoothRadius >= 12 || params.intensity >= 8;
  const medianRadius = medianEnabled ? clampInt(Math.round(params.smoothRadius * 1.5), 6, 40) : 0;

  const regionPad = medianEnabled ? (medianRadius + 2) : 2;
  const regionX0 = clampInt(selMinX - regionPad, 0, width - 1);
  const regionY0 = clampInt(selMinY - regionPad, 0, height - 1);
  const regionX1 = clampInt(selMaxX + regionPad, 0, width - 1);
  const regionY1 = clampInt(selMaxY + regionPad, 0, height - 1);
  const regionW = regionX1 - regionX0 + 1;
  const regionH = regionY1 - regionY0 + 1;

  const regionIndexOf = (x: number, y: number) => (y - regionY0) * regionW + (x - regionX0);
  const docIndexOfRegion = (ri: number) => {
    const ry = (ri / regionW) | 0;
    const rx = ri - ry * regionW;
    return (regionY0 + ry) * width + (regionX0 + rx);
  };

  const smoothstep01 = (t: number) => {
    const x = clamp01(t);
    return x * x * (3 - 2 * x);
  };

  let regionMedianLuma: Uint8Array | null = null;
  let regionSupportCount: Uint16Array | null = null;
  let supportWindowArea = 1;

  if (medianEnabled) {
    const regionLuma = new Uint8Array(regionW * regionH);
    const regionMask01 = new Uint8Array(regionW * regionH);
    for (let ry = 0; ry < regionH; ry++) {
      const docY = regionY0 + ry;
      const docRow = docY * width;
      const base = ry * regionW;
      for (let rx = 0; rx < regionW; rx++) {
        const docX = regionX0 + rx;
        const di = docRow + docX;
        regionLuma[base + rx] = lumaP[di] || 0;
        regionMask01[base + rx] = (selectionMask[di] || 0) > 0 ? 1 : 0;
      }
    }

    const r = medianRadius;
    supportWindowArea = (r * 2 + 1) * (r * 2 + 1);

    const maskH = new Uint16Array(regionW * regionH);
    for (let ry = 0; ry < regionH; ry++) {
      const rowBase = ry * regionW;
      let sum = 0;
      for (let dx = -r; dx <= r; dx++) {
        const x = clampInt(dx, 0, regionW - 1);
        sum += regionMask01[rowBase + x] || 0;
      }
      maskH[rowBase] = sum;
      for (let rx = 1; rx < regionW; rx++) {
        const outX = clampInt(rx - r - 1, 0, regionW - 1);
        const inX = clampInt(rx + r, 0, regionW - 1);
        sum += (regionMask01[rowBase + inX] || 0) - (regionMask01[rowBase + outX] || 0);
        maskH[rowBase + rx] = sum;
      }
    }

    const maskHV = new Uint16Array(regionW * regionH);
    for (let rx = 0; rx < regionW; rx++) {
      let sum = 0;
      for (let dy = -r; dy <= r; dy++) {
        const y = clampInt(dy, 0, regionH - 1);
        sum += maskH[y * regionW + rx] || 0;
      }
      maskHV[rx] = sum;
      for (let ry = 1; ry < regionH; ry++) {
        const outY = clampInt(ry - r - 1, 0, regionH - 1);
        const inY = clampInt(ry + r, 0, regionH - 1);
        sum += (maskH[inY * regionW + rx] || 0) - (maskH[outY * regionW + rx] || 0);
        maskHV[ry * regionW + rx] = sum;
      }
    }

    regionSupportCount = maskHV;

    const medianH = new Uint8Array(regionW * regionH);
    const half = (r * 2 + 1) >> 1;

    for (let ry = 0; ry < regionH; ry++) {
      const rowBase = ry * regionW;
      const hist = new Uint16Array(256);
      for (let dx = -r; dx <= r; dx++) {
        const x = clampInt(dx, 0, regionW - 1);
        hist[regionLuma[rowBase + x] || 0]++;
      }
      let median = 0;
      let less = 0;
      while (less + (hist[median] || 0) <= half) {
        less += hist[median] || 0;
        median++;
      }
      medianH[rowBase] = median;
      for (let rx = 1; rx < regionW; rx++) {
        const outX = clampInt(rx - r - 1, 0, regionW - 1);
        const inX = clampInt(rx + r, 0, regionW - 1);
        const outV = regionLuma[rowBase + outX] || 0;
        const inV = regionLuma[rowBase + inX] || 0;
        hist[outV]--;
        if (outV < median) less--;
        hist[inV]++;
        if (inV < median) less++;

        while (less > half) {
          median--;
          less -= hist[median] || 0;
        }
        while (less + (hist[median] || 0) <= half) {
          less += hist[median] || 0;
          median++;
        }
        medianH[rowBase + rx] = median;
      }
    }

    const medianHV = new Uint8Array(regionW * regionH);
    for (let rx = 0; rx < regionW; rx++) {
      const hist = new Uint16Array(256);
      for (let dy = -r; dy <= r; dy++) {
        const y = clampInt(dy, 0, regionH - 1);
        hist[medianH[y * regionW + rx] || 0]++;
      }
      let median = 0;
      let less = 0;
      while (less + (hist[median] || 0) <= half) {
        less += hist[median] || 0;
        median++;
      }
      medianHV[rx] = median;
      for (let ry = 1; ry < regionH; ry++) {
        const outY = clampInt(ry - r - 1, 0, regionH - 1);
        const inY = clampInt(ry + r, 0, regionH - 1);
        const outV = medianH[outY * regionW + rx] || 0;
        const inV = medianH[inY * regionW + rx] || 0;
        hist[outV]--;
        if (outV < median) less--;
        hist[inV]++;
        if (inV < median) less++;

        while (less > half) {
          median--;
          less -= hist[median] || 0;
        }
        while (less + (hist[median] || 0) <= half) {
          less += hist[median] || 0;
          median++;
        }
        medianHV[ry * regionW + rx] = median;
      }
    }

    regionMedianLuma = medianHV;
  }

  const denoiseRadius = Math.max(1, Math.min(2, Math.round(params.smoothRadius / 18)));
  const tangentLen = Math.max(1, Math.min(4, Math.round(params.smoothRadius / 14) + (params.intensity >= 7 ? 1 : 0)));

  const sigmaRBase = Math.max(10, Math.min(80, 8 + params.colorThreshold * 3));
  const sigmaR = params.preserveDetail ? sigmaRBase * 0.75 : sigmaRBase;
  const sigmaR2 = sigmaR * sigmaR;

  const rangeLUT = new Float32Array(256);
  if (sigmaR2 > 0.0001) {
    const denom = 2 * sigmaR2;
    for (let d = 0; d < 256; d++) {
      rangeLUT[d] = Math.exp(-(d * d) / denom);
    }
  } else {
    for (let d = 0; d < 256; d++) rangeLUT[d] = d === 0 ? 1 : 0;
  }

  const buildSpatialKernel = (r: number) => {
    const size = r * 2 + 1;
    const out = new Float32Array(size * size);
    const sigmaS = Math.max(0.6, r * 0.85);
    const denom = 2 * sigmaS * sigmaS;
    let k = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        out[k++] = Math.exp(-d2 / denom);
      }
    }
    return out;
  };

  const spatial3 = buildSpatialKernel(1);
  const spatial5 = buildSpatialKernel(2);

  const denoisePremultAt = (x: number, y: number, r: number) => {
    const centerIndex = y * width + x;
    const centerL = lumaP[centerIndex];
    const spatial = r === 1 ? spatial3 : spatial5;
    const size = r * 2 + 1;

    let sumW = 0;
    let sumA = 0;
    let sumPremR = 0;
    let sumPremG = 0;
    let sumPremB = 0;
    let k = 0;

    for (let dy = -r; dy <= r; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) {
        k += size;
        continue;
      }
      const rowBase = ny * width;
      for (let dx = -r; dx <= r; dx++, k++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const nIndex = rowBase + nx;
        const m = selectionMask[nIndex] || 0;
        if (m === 0) continue;

        const d = Math.abs((lumaP[nIndex] || 0) - centerL) & 255;
        const w = spatial[k] * rangeLUT[d] * (m / 255);
        if (w <= 0) continue;

        const p = nIndex * 4;
        const a = isBackgroundLayer ? 255 : pixelData[p + 3];
        const rP = (pixelData[p] * a + 127) / 255;
        const gP = (pixelData[p + 1] * a + 127) / 255;
        const bP = (pixelData[p + 2] * a + 127) / 255;

        sumW += w;
        sumA += a * w;
        sumPremR += rP * w;
        sumPremG += gP * w;
        sumPremB += bP * w;
      }
    }

    if (sumW <= 1e-6) {
      const p = centerIndex * 4;
      const a = isBackgroundLayer ? 255 : pixelData[p + 3];
      const rP = (pixelData[p] * a + 127) / 255;
      const gP = (pixelData[p + 1] * a + 127) / 255;
      const bP = (pixelData[p + 2] * a + 127) / 255;
      return { a, rP, gP, bP };
    }

    return {
      a: sumA / sumW,
      rP: sumPremR / sumW,
      gP: sumPremG / sumW,
      bP: sumPremB / sumW
    };
  };

  const tangentPremultAt = (x: number, y: number, len: number, dir: number) => {
    const centerIndex = y * width + x;
    const centerL = lumaP[centerIndex];

    let tx = 1;
    let ty = 0;
    if (dir === 0) {
      tx = 0; ty = 1;
    } else if (dir === 2) {
      tx = 1; ty = 0;
    } else if (dir === 1) {
      tx = 1; ty = -1;
    } else {
      tx = 1; ty = 1;
    }

    let sumW = 0;
    let sumA = 0;
    let sumPremR = 0;
    let sumPremG = 0;
    let sumPremB = 0;

    for (let t = -len; t <= len; t++) {
      const nx = x + tx * t;
      const ny = y + ty * t;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIndex = ny * width + nx;
      const m = selectionMask[nIndex] || 0;
      if (m === 0) continue;

      const d = Math.abs((lumaP[nIndex] || 0) - centerL) & 255;
      const spatialW = 1 - Math.abs(t) / (len + 1);
      const w = spatialW * rangeLUT[d] * (m / 255);
      if (w <= 0) continue;

      const p = nIndex * 4;
      const a = isBackgroundLayer ? 255 : pixelData[p + 3];
      const rP = (pixelData[p] * a + 127) / 255;
      const gP = (pixelData[p + 1] * a + 127) / 255;
      const bP = (pixelData[p + 2] * a + 127) / 255;

      sumW += w;
      sumA += a * w;
      sumPremR += rP * w;
      sumPremG += gP * w;
      sumPremB += bP * w;
    }

    if (sumW <= 1e-6) {
      const p = centerIndex * 4;
      const a = isBackgroundLayer ? 255 : pixelData[p + 3];
      const rP = (pixelData[p] * a + 127) / 255;
      const gP = (pixelData[p + 1] * a + 127) / 255;
      const bP = (pixelData[p + 2] * a + 127) / 255;
      return { a, rP, gP, bP };
    }

    return {
      a: sumA / sumW,
      rP: sumPremR / sumW,
      gP: sumPremG / sumW,
      bP: sumPremB / sumW
    };
  };

  const tangentPremultAtFiltered = (
    x: number,
    y: number,
    len: number,
    dir: number,
    includeIndex: (index: number) => boolean
  ) => {
    const centerIndex = y * width + x;
    const centerL = lumaP[centerIndex];

    let tx = 1;
    let ty = 0;
    if (dir === 0) {
      tx = 0; ty = 1;
    } else if (dir === 2) {
      tx = 1; ty = 0;
    } else if (dir === 1) {
      tx = 1; ty = -1;
    } else {
      tx = 1; ty = 1;
    }

    let sumW = 0;
    let sumA = 0;
    let sumPremR = 0;
    let sumPremG = 0;
    let sumPremB = 0;

    for (let t = -len; t <= len; t++) {
      const nx = x + tx * t;
      const ny = y + ty * t;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIndex = ny * width + nx;
      if (!includeIndex(nIndex)) continue;

      const m = selectionMask[nIndex] || 0;
      if (m === 0) continue;

      const d = Math.abs((lumaP[nIndex] || 0) - centerL) & 255;
      const spatialW = 1 - Math.abs(t) / (len + 1);
      const w = spatialW * rangeLUT[d] * (m / 255);
      if (w <= 0) continue;

      const p = nIndex * 4;
      const a = isBackgroundLayer ? 255 : pixelData[p + 3];
      const rP = (pixelData[p] * a + 127) / 255;
      const gP = (pixelData[p + 1] * a + 127) / 255;
      const bP = (pixelData[p + 2] * a + 127) / 255;

      sumW += w;
      sumA += a * w;
      sumPremR += rP * w;
      sumPremG += gP * w;
      sumPremB += bP * w;
    }

    if (sumW <= 1e-6) {
      const p = centerIndex * 4;
      const a = isBackgroundLayer ? 255 : pixelData[p + 3];
      const rP = (pixelData[p] * a + 127) / 255;
      const gP = (pixelData[p + 1] * a + 127) / 255;
      const bP = (pixelData[p + 2] * a + 127) / 255;
      return { a, rP, gP, bP };
    }

    return {
      a: sumA / sumW,
      rP: sumPremR / sumW,
      gP: sumPremG / sumW,
      bP: sumPremB / sumW
    };
  };

  const isSecondaryEdge = (x: number, y: number, idx: number, dir: number, g: number) => {
    let nx = 1;
    let ny = 0;
    if (dir === 0) { nx = 1; ny = 0; }
    else if (dir === 2) { nx = 0; ny = 1; }
    else if (dir === 1) { nx = 1; ny = -1; }
    else { nx = 1; ny = 1; }

    let best = g;
    for (let s = -2; s <= 2; s++) {
      if (s === 0) continue;
      const px = x + nx * s;
      const py = y + ny * s;
      if (px <= 0 || px >= width - 1 || py <= 0 || py >= height - 1) continue;
      const nIdx = py * width + px;
      if ((selectionMask[nIdx] || 0) === 0) continue;
      const gg = gradMag[nIdx] || 0;
      if (gg > best) best = gg;
    }

    if (best <= 0) return false;
    return g < best * 0.92;
  };

  const getLocalInkStats = (x: number, y: number) => {
    const centerIndex = y * width + x;
    const centerL = lumaP[centerIndex];
    let minL = centerL;
    let sumL = 0;
    let count = 0;
    let darkNeighbors = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      const rowBase = ny * width;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const nIndex = rowBase + nx;
        if ((selectionMask[nIndex] || 0) === 0) continue;
        const l = lumaP[nIndex] || 0;
        if (l < minL) minL = l;
        sumL += l;
        count++;
        if (l <= centerL + 10) darkNeighbors++;
      }
    }
    const meanL = count > 0 ? sumL / count : centerL;
    const inkCore = centerL <= minL + 8 && darkNeighbors >= 4 && centerL + 14 < meanL;
    return { centerL, minL, meanL, inkCore };
  };

  const isNearStrongEdge = (x: number, y: number, idx: number) => {
    if (x <= 0 || x >= width - 1 || y <= 0 || y >= height - 1) return false;

    const up = idx - width;
    const down = idx + width;
    const left = idx - 1;
    const right = idx + 1;
    const upLeft = up - 1;
    const upRight = up + 1;
    const downLeft = down - 1;
    const downRight = down + 1;

    if ((selectionMask[up] || 0) > 0 && (gradMag[up] || 0) >= strongThreshold) return true;
    if ((selectionMask[down] || 0) > 0 && (gradMag[down] || 0) >= strongThreshold) return true;
    if ((selectionMask[left] || 0) > 0 && (gradMag[left] || 0) >= strongThreshold) return true;
    if ((selectionMask[right] || 0) > 0 && (gradMag[right] || 0) >= strongThreshold) return true;

    if ((selectionMask[upLeft] || 0) > 0 && (gradMag[upLeft] || 0) >= strongThreshold) return true;
    if ((selectionMask[upRight] || 0) > 0 && (gradMag[upRight] || 0) >= strongThreshold) return true;
    if ((selectionMask[downLeft] || 0) > 0 && (gradMag[downLeft] || 0) >= strongThreshold) return true;
    if ((selectionMask[downRight] || 0) > 0 && (gradMag[downRight] || 0) >= strongThreshold) return true;

    return false;
  };

  const mainLineMask = new Uint8Array(pixelCount);
  const mainGate = strongThreshold * 0.9;
  const scanX0 = clampInt(regionX0, 1, width - 2);
  const scanY0 = clampInt(regionY0, 1, height - 2);
  const scanX1 = clampInt(regionX1, 1, width - 2);
  const scanY1 = clampInt(regionY1, 1, height - 2);

  for (let y = scanY0; y <= scanY1; y++) {
    const rowBase = y * width;
    for (let x = scanX0; x <= scanX1; x++) {
      const idx = rowBase + x;
      if ((selectionMask[idx] || 0) === 0) continue;
      const g = gradMag[idx] || 0;
      if (g < mainGate) continue;
      if (!isBackgroundLayer) {
        const a = pixelData[idx * 4 + 3] || 0;
        if (a < 48) continue;
      }

      const dir = gradDir[idx] || 0;
      let n1 = 0;
      let n2 = 0;
      if (dir === 0) {
        n1 = idx - 1;
        n2 = idx + 1;
      } else if (dir === 2) {
        n1 = idx - width;
        n2 = idx + width;
      } else if (dir === 1) {
        n1 = idx - width - 1;
        n2 = idx + width + 1;
      } else {
        n1 = idx - width + 1;
        n2 = idx + width - 1;
      }

      const g1 = gradMag[n1] || 0;
      const g2 = gradMag[n2] || 0;
      if (g >= g1 && g >= g2) {
        mainLineMask[idx] = 255;
      }
    }
  }

  const polarityAt = (idx: number, normalOffset: number) => {
    const lNeg = lumaP[idx - normalOffset] || 0;
    const lPos = lumaP[idx + normalOffset] || 0;
    const d = lPos - lNeg;
    if (d >= 6) return 1;
    if (d <= -6) return -1;
    return 0;
  };

  const maxStrokeHalf = 8;
  for (let y = scanY0; y <= scanY1; y++) {
    const rowBase = y * width;
    for (let x = scanX0; x <= scanX1; x++) {
      const idx = rowBase + x;
      if ((selectionMask[idx] || 0) === 0) continue;
      const g = gradMag[idx] || 0;
      if (g < mainGate) continue;

      const dir = gradDir[idx] || 0;
      let dx = 1;
      let dy = 0;
      if (dir === 0) { dx = 1; dy = 0; }
      else if (dir === 2) { dx = 0; dy = 1; }
      else if (dir === 1) { dx = 1; dy = 1; }
      else { dx = 1; dy = -1; }
      const normalOffset = dx + dy * width;

      const pol = polarityAt(idx, normalOffset);
      if (pol === 0) continue;

      for (let s = 2; s <= maxStrokeHalf; s++) {
        const nx = x + dx * s;
        const ny = y + dy * s;
        if (nx <= 0 || nx >= width - 1 || ny <= 0 || ny >= height - 1) break;
        const nIdx = idx + normalOffset * s;
        if ((selectionMask[nIdx] || 0) === 0) continue;
        if ((gradMag[nIdx] || 0) < mainGate) continue;
        const pol2 = polarityAt(nIdx, normalOffset);
        if (pol2 === 0 || pol2 === pol) continue;

        if (pol2 === -pol) {
          const span = s;
          for (let t = 0; t <= span; t++) {
            const fIdx = idx + normalOffset * t;
            if ((selectionMask[fIdx] || 0) === 0) continue;
            mainLineMask[fIdx] = 255;
          }
        }
        break;
      }

      for (let s = 2; s <= maxStrokeHalf; s++) {
        const nx = x - dx * s;
        const ny = y - dy * s;
        if (nx <= 0 || nx >= width - 1 || ny <= 0 || ny >= height - 1) break;
        const nIdx = idx - normalOffset * s;
        if ((selectionMask[nIdx] || 0) === 0) continue;
        if ((gradMag[nIdx] || 0) < mainGate) continue;
        const pol2 = polarityAt(nIdx, normalOffset);
        if (pol2 === 0 || pol2 === pol) continue;
        if (pol2 === -pol) {
          const span = s;
          for (let t = 0; t <= span; t++) {
            const fIdx = idx - normalOffset * t;
            if ((selectionMask[fIdx] || 0) === 0) continue;
            mainLineMask[fIdx] = 255;
          }
        }
        break;
      }
    }
  }

  const protectMask = new Uint8Array(pixelCount);
  const protectR = 2;
  const protectX0 = clampInt(regionX0 - protectR, 0, width - 1);
  const protectY0 = clampInt(regionY0 - protectR, 0, height - 1);
  const protectX1 = clampInt(regionX1 + protectR, 0, width - 1);
  const protectY1 = clampInt(regionY1 + protectR, 0, height - 1);

  for (let y = protectY0; y <= protectY1; y++) {
    const rowBase = y * width;
    for (let x = protectX0; x <= protectX1; x++) {
      const idx = rowBase + x;
      if (mainLineMask[idx] === 0) continue;
      for (let dy = -protectR; dy <= protectR; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const nRow = ny * width;
        for (let dx = -protectR; dx <= protectR; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = nRow + nx;
          if ((selectionMask[nIdx] || 0) === 0) continue;
          protectMask[nIdx] = 255;
        }
      }
    }
  }

  const isNearMainLine = (_x: number, _y: number, idx: number) => protectMask[idx] > 0;

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      const m = selectionMask[idx] || 0;
      if (m === 0) continue;

      const p = idx * 4;
      const oA = isBackgroundLayer ? 255 : pixelData[p + 3];
      const oPremR = (pixelData[p] * oA + 127) / 255;
      const oPremG = (pixelData[p + 1] * oA + 127) / 255;
      const oPremB = (pixelData[p + 2] * oA + 127) / 255;

      const g = gradMag[idx] || 0;
      const dir = gradDir[idx] || 0;
      const isEdge = g >= edgeThreshold;
      const edge01 = isEdge ? clamp01((g - edgeThreshold) / (strongThreshold - edgeThreshold)) : 0;

      const secondary = isEdge && x > 0 && x < width - 1 && y > 0 && y < height - 1
        ? isSecondaryEdge(x, y, idx, dir, g)
        : false;

      const { centerL, minL, meanL, inkCore } = getLocalInkStats(x, y);
      const nearStrongEdge = isNearStrongEdge(x, y, idx);
      const isMainLine = mainLineMask[idx] > 0;
      const nearMainLine = isNearMainLine(x, y, idx);
      const smudge = !nearMainLine && !inkCore && nearStrongEdge && oA >= 160 && centerL > minL + 6 && centerL + 18 < meanL;

      let selectionFade = 1;
      if (regionSupportCount) {
        const ri = regionIndexOf(x, y);
        const support01 = (regionSupportCount[ri] || 0) / supportWindowArea;
        selectionFade = smoothstep01((support01 - 0.62) / 0.38);
      }

      let candidate;
      let blend = 0;

      if (isMainLine) {
        const len = Math.max(1, Math.min(tangentLen, 3));
        candidate = tangentPremultAtFiltered(
          x,
          y,
          len,
          dir,
          (nIndex) => (protectMask[nIndex] > 0) || ((gradMag[nIndex] || 0) >= strongThreshold * 0.9)
        );
        blend = baseStrength * (params.preserveDetail ? 0.28 : 0.35);
      } else if (!nearMainLine && regionMedianLuma && isEdge && !secondary) {
        const ri = regionIndexOf(x, y);
        const mL = regionMedianLuma[ri] || 0;
        const ratio = (mL + 0.5) / (centerL + 0.5);
        candidate = { a: oA, rP: oPremR * ratio, gP: oPremG * ratio, bP: oPremB * ratio };
        blend = baseStrength * (0.55 + 0.75 * edge01);
      } else if (smudge) {
        candidate = denoisePremultAt(x, y, 2);
        blend = baseStrength * 1.0;
      } else if (!isEdge) {
        candidate = denoisePremultAt(x, y, denoiseRadius);
        blend = baseStrength * (nearMainLine ? 0.22 : 0.95);
      } else if (secondary) {
        candidate = denoisePremultAt(x, y, 2);
        blend = baseStrength * (0.85 + 0.3 * edge01);
      } else {
        candidate = tangentPremultAt(x, y, tangentLen, dir);
        blend = baseStrength * (0.45 + 0.75 * edge01);
      }

      if (!isBackgroundLayer && inkCore) {
        blend *= params.preserveDetail ? 0.35 : 0.45;
      } else if (!isBackgroundLayer && isMainLine) {
        blend *= 0.75;
      } else if (!isBackgroundLayer && isEdge && !secondary && oA < 255) {
        blend *= 0.88;
      }
      if (!isMainLine) {
        blend *= selectionFade;
      }
      blend = clamp01(blend);

      let outA = 255;
      if (!isBackgroundLayer) {
        if (inkCore || isMainLine || (isEdge && !secondary)) {
          outA = oA;
        } else {
          const alphaBlend = clamp01(smudge ? blend * 1.15 : blend * 0.85);
          const mixedA = oA * (1 - alphaBlend) + candidate.a * alphaBlend;
          const maxDrop = (params.preserveDetail ? 10 : 18) * (0.35 + 0.65 * (smudge ? 0.8 : edge01));
          outA = Math.max(mixedA, oA - maxDrop);
        }
      }
      const outPremR = oPremR * (1 - blend) + candidate.rP * blend;
      const outPremG = oPremG * (1 - blend) + candidate.gP * blend;
      const outPremB = oPremB * (1 - blend) + candidate.bP * blend;

      if (inkCore) {
        const oL = lumaP[idx] || 0;
        const cL = lumaFromPremult(outPremR, outPremG, outPremB);
        if (cL > oL + 4) {
          outputData[p] = pixelData[p];
          outputData[p + 1] = pixelData[p + 1];
          outputData[p + 2] = pixelData[p + 2];
          outputData[p + 3] = isBackgroundLayer ? 255 : oA;
          continue;
        }
      } else if (isMainLine) {
        const oL = lumaP[idx] || 0;
        const cL = lumaFromPremult(outPremR, outPremG, outPremB);
        if (cL > oL + 2) {
          outputData[p] = pixelData[p];
          outputData[p + 1] = pixelData[p + 1];
          outputData[p + 2] = pixelData[p + 2];
          outputData[p + 3] = isBackgroundLayer ? 255 : oA;
          continue;
        }
      }

      if (isBackgroundLayer) {
        outputData[p] = Math.round(clamp255(outPremR));
        outputData[p + 1] = Math.round(clamp255(outPremG));
        outputData[p + 2] = Math.round(clamp255(outPremB));
        outputData[p + 3] = 255;
        continue;
      }

      if (outA <= 0.001) {
        outputData[p] = 0;
        outputData[p + 1] = 0;
        outputData[p + 2] = 0;
        outputData[p + 3] = 0;
        continue;
      }

      const invA = 255 / outA;
      outputData[p] = Math.round(clamp255(outPremR * invA));
      outputData[p + 1] = Math.round(clamp255(outPremG * invA));
      outputData[p + 2] = Math.round(clamp255(outPremB * invA));
      outputData[p + 3] = Math.round(clamp255(outA));
    }
  }

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
