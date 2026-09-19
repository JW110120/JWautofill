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
  
  // 第一步：计算高频信息
  //
  // ⚠️ 两条边界铁律（缺一则写回后沿内容轮廓出现一圈白边）：
  //  ① 区域判定只能用「选区掩码 > 0」，不能再按「alpha > 0」判定 ——
  //     写回范围是 selectionDocIndices（掩码>0），按 alpha 判定会让统计口径与写回口径不一致。
  //  ② 采样到「数据缺失」像素（图层外/全透明，即 RGBA 全 0）时，必须用中心像素值顶替（边缘延拓）。
  //     直接采到 0 会让 8·c − Σ邻居 凭空变成 8·c 的"高频"，enhanced = c + 8c·k 当场顶到 255；
  //     选区边缘与图层 alpha 边缘两条路径同因，这也是本功能反复出现「边缘白边」的根因。
  // 原低通分支（lowPassKernel / lowFreqData）只写不读，已删。
  const highFreqData = new Float32Array(pixels.length);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const centerIdx = (y * width + x) * 4;
      const pixelIdx = y * width + x;

      if ((selectionMask[pixelIdx] || 0) === 0) {
        continue;
      }

      const centerR = pixels[centerIdx];
      const centerG = pixels[centerIdx + 1];
      const centerB = pixels[centerIdx + 2];

      let hpR = 0;
      let hpG = 0;
      let hpB = 0;

      // 应用3x3高通卷积核
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const sampleIdx = ((y + ky) * width + (x + kx)) * 4;
          const kernel = highPassKernel[ky + 1][kx + 1];

          let sR = pixels[sampleIdx];
          let sG = pixels[sampleIdx + 1];
          let sB = pixels[sampleIdx + 2];

          if (sR === 0 && sG === 0 && sB === 0 && pixels[sampleIdx + 3] === 0) {
            sR = centerR;
            sG = centerG;
            sB = centerB;
          }

          hpR += sR * kernel;
          hpG += sG * kernel;
          hpB += sB * kernel;
        }
      }

      highFreqData[centerIdx] = hpR;
      highFreqData[centerIdx + 1] = hpG;
      highFreqData[centerIdx + 2] = hpB;
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
      
      // 区域与系数一律以选区掩码为准（与写回范围 selectionDocIndices 同口径，背景层亦是）
      const maskValue = selectionMask[pixelIdx] || 0;

      if (maskValue > 0) {
        const selectionCoeff = maskValue / 255;
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
          // 数据缺失像素同样用中心像素灰度顶替，否则轮廓处方差被 0 拉爆、varianceFactor 直接取 1
          const centerGray = (pixels[centerIdx] + pixels[centerIdx + 1] + pixels[centerIdx + 2]) / 3;
          
          // 计算5x5区域的方差
          for (let ky = -2; ky <= 2; ky++) {
            for (let kx = -2; kx <= 2; kx++) {
              const sampleY = y + ky;
              const sampleX = x + kx;
              
              if (sampleY >= 0 && sampleY < height && sampleX >= 0 && sampleX < width) {
                const sampleIdx = (sampleY * width + sampleX) * 4;
                const sR = pixels[sampleIdx];
                const sG = pixels[sampleIdx + 1];
                const sB = pixels[sampleIdx + 2];
                const grayValue = (sR === 0 && sG === 0 && sB === 0 && pixels[sampleIdx + 3] === 0)
                  ? centerGray
                  : (sR + sG + sB) / 3;
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
                const sR = pixels[sampleIdx];
                const sG = pixels[sampleIdx + 1];
                const sB = pixels[sampleIdx + 2];
                const grayValue = (sR === 0 && sG === 0 && sB === 0 && pixels[sampleIdx + 3] === 0)
                  ? centerGray
                  : (sR + sG + sB) / 3;
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
          
        }
      }
    }
  }
  
  return result;
}