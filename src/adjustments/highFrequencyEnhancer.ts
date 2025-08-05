// 高频信息增强处理算法 - 识别并增强选区内的高频细节信息
export async function processHighFrequencyEnhancement(
  layerPixelData: ArrayBuffer, 
  selectionData: ArrayBuffer, 
  bounds: { width: number; height: number }, 
  params: { intensity: number; thresholdRange?: number },
  isBackgroundLayer: boolean = false
): Promise<Uint8Array> {
  const width = bounds.width;
  const height = bounds.height;
  const pixels = new Uint8Array(layerPixelData);
  const selectionMask = new Uint8Array(selectionData);
  const result = new Uint8Array(pixels.length);
  
  // 复制原始数据
  result.set(pixels);
  
  // 高频增强参数
  const intensity = params.intensity; // 1-10的强度等级
  const enhancementFactor = intensity / 10; // 转换为0.1-1.0的因子
  const thresholdRange = params.thresholdRange || 3; // 1-10的范围等级，默认为3
  
  // 创建高频检测核 - 用于检测边缘和细节
  const highPassKernel = [
    [-1, -1, -1],
    [-1,  8, -1],
    [-1, -1, -1]
  ];
  
  // 创建低通滤波核 - 用于获取低频信息
  const lowPassKernel = [
    [1/16, 2/16, 1/16],
    [2/16, 4/16, 2/16],
    [1/16, 2/16, 1/16]
  ];
  
  // 第一步：计算高频信息
  const highFreqData = new Float32Array(pixels.length);
  const lowFreqData = new Float32Array(pixels.length);
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const centerIdx = (y * width + x) * 4;
      
      // 检查是否在选区内
      let inSelection = false;
      if (isBackgroundLayer) {
        const selectionValue = selectionMask[y * width + x] || 0;
        inSelection = selectionValue > 0;
      } else {
        const centerAlpha = pixels[centerIdx + 3];
        inSelection = centerAlpha > 0;
      }
      
      if (inSelection) {
        // 对每个颜色通道计算高频和低频信息
        for (let channel = 0; channel < 3; channel++) {
          let highFreqSum = 0;
          let lowFreqSum = 0;
          
          // 应用3x3卷积核
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const sampleIdx = ((y + ky) * width + (x + kx)) * 4;
              const pixelValue = pixels[sampleIdx + channel];
              
              // 高频检测
              highFreqSum += pixelValue * highPassKernel[ky + 1][kx + 1];
              
              // 低频检测
              lowFreqSum += pixelValue * lowPassKernel[ky + 1][kx + 1];
            }
          }
          
          highFreqData[centerIdx + channel] = highFreqSum;
          lowFreqData[centerIdx + channel] = lowFreqSum;
        }
      }
    }
  }
  
  // 第二步：分析高频强度分布，识别高频区域
  const highFreqIntensity = new Float32Array(width * height);
  let maxIntensity = 0;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const pixelIdx = idx * 4;
      
      // 计算该像素的高频强度（RGB三通道的平均值）
      const rHigh = Math.abs(highFreqData[pixelIdx]);
      const gHigh = Math.abs(highFreqData[pixelIdx + 1]);
      const bHigh = Math.abs(highFreqData[pixelIdx + 2]);
      
      const intensity = (rHigh + gHigh + bHigh) / 3;
      highFreqIntensity[idx] = intensity;
      maxIntensity = Math.max(maxIntensity, intensity);
    }
  }
  
  // 第三步：自适应阈值检测高频区域
  // 将阈值范围从1-10映射到0.05-0.4，数值越大，阈值越低，高频区域越大
  // 当范围为10时，阈值降低到5%，能够包含更多中等对比度的区域
  const thresholdRatio = 0.45 - (thresholdRange / 10) * 0.4; // 范围从0.05到0.4
  const adaptiveThreshold = maxIntensity * thresholdRatio;
  
  // 第四步：应用高频增强
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const centerIdx = (y * width + x) * 4;
      const pixelIdx = y * width + x;
      
      // 检查是否在选区内
      let inSelection = false;
      let selectionCoeff = 0;
      
      if (isBackgroundLayer) {
        const selectionValue = selectionMask[pixelIdx] || 0;
        inSelection = selectionValue > 0;
        selectionCoeff = selectionValue / 255;
      } else {
        const centerAlpha = pixels[centerIdx + 3];
        inSelection = centerAlpha > 0;
        selectionCoeff = centerAlpha / 255;
      }
      
      if (inSelection) {
        const currentIntensity = highFreqIntensity[pixelIdx];
        
        // 只对高频区域进行增强
        if (currentIntensity > adaptiveThreshold) {
          // 计算增强系数
          const intensityRatio = Math.min(currentIntensity / maxIntensity, 1);
          const localEnhancement = enhancementFactor * intensityRatio * selectionCoeff;
          
          // 计算周围像素的方差，用于判断细节丰富程度
          let variance = 0;
          let sampleCount = 0;
          let avgValue = 0;
          
          // 计算5x5区域的方差
          for (let ky = -2; ky <= 2; ky++) {
            for (let kx = -2; kx <= 2; kx++) {
              const sampleY = y + ky;
              const sampleX = x + kx;
              
              if (sampleY >= 0 && sampleY < height && sampleX >= 0 && sampleX < width) {
                const sampleIdx = (sampleY * width + sampleX) * 4;
                const grayValue = (pixels[sampleIdx] + pixels[sampleIdx + 1] + pixels[sampleIdx + 2]) / 3;
                avgValue += grayValue;
                sampleCount++;
              }
            }
          }
          
          avgValue /= sampleCount;
          
          // 计算方差
          for (let ky = -2; ky <= 2; ky++) {
            for (let kx = -2; kx <= 2; kx++) {
              const sampleY = y + ky;
              const sampleX = x + kx;
              
              if (sampleY >= 0 && sampleY < height && sampleX >= 0 && sampleX < width) {
                const sampleIdx = (sampleY * width + sampleX) * 4;
                const grayValue = (pixels[sampleIdx] + pixels[sampleIdx + 1] + pixels[sampleIdx + 2]) / 3;
                variance += Math.pow(grayValue - avgValue, 2);
              }
            }
          }
          
          variance /= sampleCount;
          const varianceFactor = Math.min(variance / 1000, 1); // 归一化方差因子
          
          // 对RGB通道应用增强
          for (let channel = 0; channel < 3; channel++) {
            const originalValue = pixels[centerIdx + channel];
            const highFreqComponent = highFreqData[centerIdx + channel];
            
            // 使用Unsharp Masking技术进行增强
            // 增强公式: enhanced = original + (highFreq * enhancement * variance)
            const enhancement = highFreqComponent * localEnhancement * varianceFactor * 0.5;
            let enhancedValue = originalValue + enhancement;
            
            // 防止溢出和下溢
            enhancedValue = Math.max(0, Math.min(255, enhancedValue));
            
            // 应用增强结果
            result[centerIdx + channel] = Math.round(enhancedValue);
          }
          
          // Alpha通道保持不变（对于普通图层）
          if (!isBackgroundLayer) {
            result[centerIdx + 3] = pixels[centerIdx + 3];
          }
          
          console.log(`高频增强像素 (${x},${y}): 强度=${currentIntensity.toFixed(2)}, 增强系数=${localEnhancement.toFixed(3)}, 方差=${variance.toFixed(2)}`);
        }
      }
    }
  }
  
  console.log(`高频增强完成，阈值=${adaptiveThreshold.toFixed(2)}, 最大强度=${maxIntensity.toFixed(2)}`);
  
  return result;
}