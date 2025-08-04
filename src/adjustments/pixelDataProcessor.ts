import { app, core, imaging } from 'photoshop';
import { LayerInfoHandler } from '../utils/LayerInfoHandler';

// 选区数据接口
interface SelectionBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  docWidth: number;
  docHeight: number;
  selectionPixels: Set<number>;
  selectionDocIndices: Set<number>;
  selectionValues: Uint8Array;
  selectionCoefficients: Float32Array;
}

// 像素处理结果接口
interface PixelProcessingResult {
  fullPixelData: Uint8Array;
  selectionPixelData: Uint8Array;
  selectionIndices: number[];
  selectionBounds: SelectionBounds;
  layer: any;
  isBackgroundLayer: boolean;
}

// 检测当前编辑状态是否适用于像素处理
export const checkEditingState = async () => {
  try {
    // 获取当前文档和图层信息
    const doc = app.activeDocument;
    if (!doc) {
      await core.showAlert({ message: '未找到活动文档' });
      return { isValid: false };
    }

    const layer = doc.activeLayers[0];
    if (!layer) {
      await core.showAlert({ message: '未找到活动图层' });
      return { isValid: false };
    }

    // 使用 LayerInfoHandler 获取详细的图层信息
    const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
    if (!layerInfo) {
      await core.showAlert({ message: '获取图层信息失败' });
      return { isValid: false };
    }

    // 检查是否在编辑快速蒙版模式
    if (layerInfo.isInQuickMask) {
      await core.showAlert({ message: '当前处于快速蒙版编辑模式，请退出快速蒙版模式后再使用此功能' });
      return { isValid: false };
    }

    // 检查是否在编辑图层蒙版
    if (layerInfo.isInLayerMask) {
      await core.showAlert({ message: '当前正在编辑图层蒙版，请切换到图层内容编辑模式后再使用此功能' });
      return { isValid: false };
    }

    // 检查是否在编辑单个通道
    if (layerInfo.isInSingleColorChannel) {
      await core.showAlert({ message: '当前正在编辑单个通道，请切换到复合通道编辑模式后再使用此功能' });
      return { isValid: false };
    }

    // 检查图层类型
    if (!layerInfo.hasPixels) {
      await core.showAlert({ message: '请选择像素图层' });
      return { isValid: false };
    }

    return { isValid: true, layer, isBackgroundLayer: layerInfo.isBackground };
  } catch (error) {
    console.error('检测编辑状态失败:', error);
    await core.showAlert({ message: '检测编辑状态失败: ' + error.message });
    return { isValid: false };
  }
};

// 处理像素数据的通用函数
export const processPixelData = async (selectionBounds: SelectionBounds, layer: any, isBackgroundLayer: boolean): Promise<PixelProcessingResult> => {
  // 步骤1：获取图层的实际边界和像素数据
  const layerBounds = {
    left: layer.bounds.left,
    top: layer.bounds.top,
    right: layer.bounds.right,
    bottom: layer.bounds.bottom
  };
  
  const layerWidth = layerBounds.right - layerBounds.left;
  const layerHeight = layerBounds.bottom - layerBounds.top;
  
  // 获取图层实际像素数据
  const layerPixels = await imaging.getPixels({
    documentID: app.activeDocument.id,
    layerID: layer.id,
    sourceBounds: layerBounds,
    targetSize: {
      width: layerWidth,
      height: layerHeight
    }
  });
  
  const layerPixelData = await layerPixels.imageData.getData();
  console.log('✅ 获取图层像素数组，尺寸:', layerWidth, 'x', layerHeight, '长度:', layerPixelData.length);
  
  // 创建完整文档大小的像素数组，不进行预初始化
  // 背景图层和普通图层都将通过后续的像素填充来设置正确的值
  const fullPixelData = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight * 4);
  
  // 移除强制白色初始化，避免在选区边界产生白色边缘
  // 背景图层的像素值将通过下面的图层像素数据填充来设置
  
  // 将图层像素数据填入对应位置
  if (isBackgroundLayer) {
    // 背景图层：处理RGB格式的像素数据（3个字节每像素）
    const pixelCount = selectionBounds.docWidth * selectionBounds.docHeight;
    const bytesPerPixel = layerPixelData.length / pixelCount; // 检测实际的字节数
    
    if (bytesPerPixel === 3) {
      // RGB格式：3个字节每像素
      for (let i = 0; i < pixelCount; i++) {
        const layerIndex = i * 3;
        const docIndex = i * 4;
        
        fullPixelData[docIndex] = layerPixelData[layerIndex];         // R
        fullPixelData[docIndex + 1] = layerPixelData[layerIndex + 1]; // G
        fullPixelData[docIndex + 2] = layerPixelData[layerIndex + 2]; // B
        fullPixelData[docIndex + 3] = 255; // 背景图层alpha始终为255
      }
    } else {
      // RGBA格式：4个字节每像素
      for (let i = 0; i < pixelCount; i++) {
        const layerIndex = i * 4;
        const docIndex = i * 4;
        
        fullPixelData[docIndex] = layerPixelData[layerIndex];         // R
        fullPixelData[docIndex + 1] = layerPixelData[layerIndex + 1]; // G
        fullPixelData[docIndex + 2] = layerPixelData[layerIndex + 2]; // B
        fullPixelData[docIndex + 3] = 255; // 背景图层alpha始终为255
      }
    }
    
    console.log('✅ 背景图层像素数据格式:', bytesPerPixel === 3 ? 'RGB' : 'RGBA', '每像素字节数:', bytesPerPixel);
  } else {
    // 普通图层：按图层边界填入像素数据
    for (let y = 0; y < layerHeight; y++) {
      for (let x = 0; x < layerWidth; x++) {
        const layerIndex = (y * layerWidth + x) * 4;
        const docX = layerBounds.left + x;
        const docY = layerBounds.top + y;
        
        // 确保坐标在文档范围内
        if (docX >= 0 && docX < selectionBounds.docWidth && docY >= 0 && docY < selectionBounds.docHeight) {
          const docIndex = (docY * selectionBounds.docWidth + docX) * 4;
          
          fullPixelData[docIndex] = layerPixelData[layerIndex];         // R
          fullPixelData[docIndex + 1] = layerPixelData[layerIndex + 1]; // G
          fullPixelData[docIndex + 2] = layerPixelData[layerIndex + 2]; // B
          fullPixelData[docIndex + 3] = layerPixelData[layerIndex + 3]; // A
        }
      }
    }
  }
  
  // 释放图层像素数据内存
  layerPixels.imageData.dispose();
  
  console.log('✅ 创建完整文档像素数组，长度:', fullPixelData.length);
  
  // 步骤2：创建完整文档尺寸的选区像素数组，选区外根据图层类型设置
  const selectionPixelData = new Uint8Array(fullPixelData.length); // 保持完整文档尺寸
  const selectionIndices = Array.from(selectionBounds.selectionDocIndices);
  
  // 根据图层类型初始化选区外的像素
  if (isBackgroundLayer) {
    // 背景图层：选区外使用原始图层像素数据，而不是强制设为白色
    // 这样可以避免在选区边界处产生不自然的白色边缘
    selectionPixelData.set(fullPixelData);
  }
  // 普通图层：选区外保持透明（默认为0，无需额外处理）
  
  // 对于普通图层，只复制选区内的像素
  if (!isBackgroundLayer) {
    for (const docIndex of selectionIndices) {
      const sourceIndex = docIndex * 4;
      
      selectionPixelData[sourceIndex] = fullPixelData[sourceIndex];         // R
      selectionPixelData[sourceIndex + 1] = fullPixelData[sourceIndex + 1]; // G
      selectionPixelData[sourceIndex + 2] = fullPixelData[sourceIndex + 2]; // B
      selectionPixelData[sourceIndex + 3] = fullPixelData[sourceIndex + 3]; // A
    }
  }
  
  console.log('✅ 创建完整尺寸选区像素数组，长度:', selectionPixelData.length);
  
  return {
    fullPixelData,
    selectionPixelData,
    selectionIndices,
    selectionBounds,
    layer,
    isBackgroundLayer
  };
};

// 应用处理后的像素数据到图层
export const applyProcessedPixels = async (
  processedPixels: Uint8Array,
  result: PixelProcessingResult
): Promise<void> => {
  const { fullPixelData, selectionIndices, selectionBounds, layer, isBackgroundLayer } = result;
  
  // 应用处理后的像素数据
  const newFullPixelData = new Uint8Array(fullPixelData.length);
  newFullPixelData.set(fullPixelData); // 复制原始数据
  
  let coefficientIndex = 0;
  for (const docIndex of selectionIndices) {
    const pixelIndex = docIndex * 4;
    const coefficient = selectionBounds.selectionCoefficients[coefficientIndex];
    
    if (isBackgroundLayer) {
      // 背景图层：与原始像素混合，避免消除锯齿时产生白边
      newFullPixelData[pixelIndex] = Math.round(fullPixelData[pixelIndex] * (1 - coefficient) + processedPixels[pixelIndex] * coefficient);
      newFullPixelData[pixelIndex + 1] = Math.round(fullPixelData[pixelIndex + 1] * (1 - coefficient) + processedPixels[pixelIndex + 1] * coefficient);
      newFullPixelData[pixelIndex + 2] = Math.round(fullPixelData[pixelIndex + 2] * (1 - coefficient) + processedPixels[pixelIndex + 2] * coefficient);
      // 背景图层的alpha始终保持255
      newFullPixelData[pixelIndex + 3] = 255;
    } else {
      // 普通图层：根据选区系数混合原始颜色和处理后的颜色
      newFullPixelData[pixelIndex] = Math.round(fullPixelData[pixelIndex] * (1 - coefficient) + processedPixels[pixelIndex] * coefficient);
      newFullPixelData[pixelIndex + 1] = Math.round(fullPixelData[pixelIndex + 1] * (1 - coefficient) + processedPixels[pixelIndex + 1] * coefficient);
      newFullPixelData[pixelIndex + 2] = Math.round(fullPixelData[pixelIndex + 2] * (1 - coefficient) + processedPixels[pixelIndex + 2] * coefficient);
      newFullPixelData[pixelIndex + 3] = Math.round(fullPixelData[pixelIndex + 3] * (1 - coefficient) + processedPixels[pixelIndex + 3] * coefficient);
    }
    
    coefficientIndex++;
  }
  
  console.log('✅ 映射回完整像素数组完成');
  
  // 根据图层类型创建不同的像素数据
  let outputPixelData: Uint8Array;
  let components: number;
  
  if (isBackgroundLayer) {
    // 背景图层：创建RGB格式的数据（3个组件）
    components = 3;
    const pixelCount = selectionBounds.docWidth * selectionBounds.docHeight;
    outputPixelData = new Uint8Array(pixelCount * 3);
    
    for (let i = 0; i < pixelCount; i++) {
      const sourceIndex = i * 4;
      const targetIndex = i * 3;
      outputPixelData[targetIndex] = newFullPixelData[sourceIndex];         // R
      outputPixelData[targetIndex + 1] = newFullPixelData[sourceIndex + 1]; // G
      outputPixelData[targetIndex + 2] = newFullPixelData[sourceIndex + 2]; // B
    }
  } else {
    // 普通图层：使用RGBA格式的数据（4个组件）
    components = 4;
    outputPixelData = newFullPixelData;
  }
  
  // 把改造后的像素数组通过putPixels写回图层
  const newImageData = await imaging.createImageDataFromBuffer(outputPixelData, {
    width: selectionBounds.docWidth,
    height: selectionBounds.docHeight,
    colorSpace: 'RGB',
    pixelFormat: isBackgroundLayer ? 'RGB' : 'RGBA',
    components: components,
    componentSize: 8
  });
  
  await imaging.putPixels({
    documentID: app.activeDocument.id,
    layerID: layer.id,
    imageData: newImageData,
    targetBounds: {
      left: 0,
      top: 0,
      right: selectionBounds.docWidth,
      bottom: selectionBounds.docHeight
    }
  });
  
  // 释放内存
  newImageData.dispose();
};