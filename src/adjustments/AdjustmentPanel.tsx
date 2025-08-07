import React, { useState } from 'react';
import { processBlockAverage } from './blockAverageProcessor';
import { processPixelTransition } from './pixelTransitionProcessor';
import { processLineEnhancement } from './lineProcessing';
import { processHighFrequencyEnhancement } from './highFrequencyEnhancer';
import { processSmartEdgeSmooth, defaultSmartEdgeSmoothParams } from './smartEdgeSmoothProcessor';
import { checkEditingState, processPixelData, applyProcessedPixels } from './pixelDataProcessor';
import { action, app, core, imaging } from 'photoshop';
import './adjustment.css';

// 获取选区边界信息和文档信息（完全参考ClearHandler.getSelectionData）
const getSelectionData = async () => {
  try {
    // batchplay获取文档信息和选区信息
    const [docResult, selectionResult] = await Promise.all([
      action.batchPlay([
        {
          _obj: "get",
          _target: [
            {
              _ref: "document",
              _enum: "ordinal",
              _value: "targetEnum"
            }
          ]
        }
      ], { synchronousExecution: true }),
      action.batchPlay([
        {
          _obj: "get",
          _target: [
            {
              _property: "selection"
            },
            {
              _ref: "document",
              _enum: "ordinal",
              _value: "targetEnum"
            }
          ]
        }
      ], { synchronousExecution: true })
    ]);
    
    // 获取文档尺寸信息
    const docWidth = docResult[0].width._value;
    const docHeight = docResult[0].height._value;
    const resolution = docResult[0].resolution._value;
    
    // 直接转换为像素单位
    const docWidthPixels = Math.round(docWidth * resolution / 72);
    const docHeightPixels = Math.round(docHeight * resolution / 72);
    
    // 检查是否有选区
    const hasSelection = selectionResult[0].selection !== undefined;
    
    let left, top, right, bottom, width, height;
    
    if (hasSelection) {
      // 有选区时，获取选区边界
      const bounds = selectionResult[0].selection;
      left = Math.round(bounds.left._value);
      top = Math.round(bounds.top._value);
      right = Math.round(bounds.right._value);
      bottom = Math.round(bounds.bottom._value);
      width = right - left;
      height = bottom - top;
    } else {
      // 没有选区时，使用整个文档作为选区
      left = 0;
      top = 0;
      right = docWidthPixels;
      bottom = docHeightPixels;
      width = docWidthPixels;
      height = docHeightPixels;
    }
    
    let selectionData, selectionSize, selectionValues, selectionCoefficients, selectionDocIndices;
    
    if (hasSelection) {
      // 有选区时，使用imaging.getSelection获取羽化选区的像素数据
      const pixels = await imaging.getSelection({
        documentID: app.activeDocument.id,
        sourceBounds: {
          left: left,
          top: top,
          right: right,
          bottom: bottom
        },
        targetSize: {
          width: width,
          height: height
        },
      });
      
      selectionData = await pixels.imageData.getData();
      
      // 创建临时数组来存储矩形边界内的所有像素信息
      const tempSelectionValues = new Uint8Array(width * height);
      const tempSelectionCoefficients = new Float32Array(width * height);
      // 创建一个新的Set来存储选区内像素（值大于0）在文档中的索引
      selectionDocIndices = new Set<number>();
      
      // 处理矩形边界内的所有像素，收集选区内像素的索引
      if (selectionData.length === width * height) {
        // 单通道数据
        for (let i = 0; i < width * height; i++) {
          tempSelectionValues[i] = selectionData[i];
          tempSelectionCoefficients[i] = selectionData[i] / 255; // 计算选择系数
          
          // 只有当像素值大于0时，才认为它在选区内
          if (selectionData[i] > 0) {
            // 计算该像素在选区边界内的坐标
            const x = i % width;
            const y = Math.floor(i / width);
            
            // 计算该像素在整个文档中的索引
            const docX = left + x;
            const docY = top + y;
            const docIndex = docY * docWidthPixels + docX;
            
            // 将文档索引添加到集合中
            selectionDocIndices.add(docIndex);
          }
        }
      }
      
      // 创建只包含选区内像素的数组（长度为selectionDocIndices.size）
      selectionSize = selectionDocIndices.size;
      selectionValues = new Uint8Array(selectionSize);
      selectionCoefficients = new Float32Array(selectionSize);
      
      // 将选区内像素的值和系数填入新数组
      let fillIndex = 0;
      for (let i = 0; i < width * height; i++) {
        if (tempSelectionValues[i] > 0) {
          selectionValues[fillIndex] = tempSelectionValues[i];
          selectionCoefficients[fillIndex] = tempSelectionCoefficients[i];
          fillIndex++;
        }
      }
      
      // 释放ImageData内存
      pixels.imageData.dispose();
    } else {
      // 没有选区时，创建全选的选区数据
      selectionSize = docWidthPixels * docHeightPixels;
      selectionValues = new Uint8Array(selectionSize);
      selectionCoefficients = new Float32Array(selectionSize);
      selectionDocIndices = new Set<number>();
      
      // 填充全选数据
      for (let i = 0; i < selectionSize; i++) {
        selectionValues[i] = 255; // 完全选中
        selectionCoefficients[i] = 1.0; // 完全选择系数
        selectionDocIndices.add(i);
      }
    }
    
    console.log('✅ 选区内像素数量（selectionDocIndices.size）:', selectionDocIndices.size);
    

   
    return {
      left,
      top,
      right,
      bottom,
      width,
      height,
      docWidth: docWidthPixels,  // 返回像素单位的文档宽度
      docHeight: docHeightPixels, // 返回像素单位的文档高度
      selectionPixels: selectionDocIndices, // 现在直接使用selectionDocIndices
      selectionDocIndices,       // 通过imaging.getSelection获取的选区内像素在文档中的索引
      selectionValues,           // 选区像素值（0-255）
      selectionCoefficients      // 选择系数（0-1）
    };
    
  } catch (error) {
    console.error('获取选区边界失败:', error);
    return null;
  }
};

// 调整内容面板组件
const AdjustmentPanel = () => {
  // 状态管理
  const [radius, setRadius] = useState(15);
  const [sigma, setSigma] = useState(5);
  const [isDragging, setIsDragging] = useState(false);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartValue, setDragStartValue] = useState(0);
  const [useWeightedAverage, setUseWeightedAverage] = useState(true);
  const [weightedIntensity, setWeightedIntensity] = useState(5);
  const [highFreqIntensity, setHighFreqIntensity] = useState(5);
  const [highFreqRange, setHighFreqRange] = useState(3);
  
  // 智能边缘平滑参数
  const [edgeAlphaThreshold, setEdgeAlphaThreshold] = useState(defaultSmartEdgeSmoothParams.alphaThreshold);
  const [edgeColorThreshold, setEdgeColorThreshold] = useState(defaultSmartEdgeSmoothParams.colorThreshold);
  const [edgeSmoothRadius, setEdgeSmoothRadius] = useState(defaultSmartEdgeSmoothParams.smoothRadius);
  const [preserveDetail, setPreserveDetail] = useState(defaultSmartEdgeSmoothParams.preserveDetail);
  const [edgeIntensity, setEdgeIntensity] = useState(defaultSmartEdgeSmoothParams.intensity);

  // 拖拽处理函数
  const handleLabelMouseDown = (event: React.MouseEvent, target: string) => {
    event.preventDefault();
    setIsDragging(true);
    setDragTarget(target);
    setDragStartX(event.clientX);
    if (target === 'radius') {
      setDragStartValue(radius);
    } else if (target === 'sigma') {
      setDragStartValue(sigma);
    } else if (target === 'weightedIntensity') {
      setDragStartValue(weightedIntensity);
    } else if (target === 'highFreqIntensity') {
      setDragStartValue(highFreqIntensity);
    } else if (target === 'highFreqRange') {
      setDragStartValue(highFreqRange);
    } else if (target === 'edgeAlphaThreshold') {
      setDragStartValue(edgeAlphaThreshold);
    } else if (target === 'edgeColorThreshold') {
      setDragStartValue(edgeColorThreshold);
    } else if (target === 'edgeSmoothRadius') {
      setDragStartValue(edgeSmoothRadius);
    } else if (target === 'edgeIntensity') {
      setDragStartValue(edgeIntensity);
    }
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (!isDragging || !dragTarget) return;

    const deltaX = event.clientX - dragStartX;
    let sensitivity, minValue, maxValue;
    
    if (dragTarget === 'radius') {
      sensitivity = 0.1;
      minValue = 5;
      maxValue = 20;
    } else if (dragTarget === 'sigma') {
      sensitivity = 0.02;
      minValue = 1;
      maxValue = 5;
    } else if (dragTarget === 'weightedIntensity') {
      sensitivity = 0.05;
      minValue = 1;
      maxValue = 10;
    } else if (dragTarget === 'highFreqIntensity') {
      sensitivity = 0.05;
      minValue = 1;
      maxValue = 10;
    } else if (dragTarget === 'highFreqRange') {
      sensitivity = 0.05;
      minValue = 1;
      maxValue = 10;
    } else if (dragTarget === 'edgeAlphaThreshold') {
      sensitivity = 0.5;
      minValue = 10;
      maxValue = 100;
    } else if (dragTarget === 'edgeColorThreshold') {
      sensitivity = 0.5;
      minValue = 10;
      maxValue = 100;
    } else if (dragTarget === 'edgeSmoothRadius') {
      sensitivity = 0.05;
      minValue = 1;
      maxValue = 8;
    } else if (dragTarget === 'edgeIntensity') {
      sensitivity = 0.05;
      minValue = 1;
      maxValue = 10;
    }
    
    const newValue = Math.max(
      minValue,
      Math.min(maxValue, dragStartValue + (deltaX * sensitivity))
    );

    if (dragTarget === 'radius') {
      setRadius(Math.round(newValue));
    } else if (dragTarget === 'sigma') {
      setSigma(Math.round(newValue * 2) / 2); // 保持0.5的步长
    } else if (dragTarget === 'weightedIntensity') {
      setWeightedIntensity(Math.round(newValue * 2) / 2); // 保持0.5的步长
    } else if (dragTarget === 'highFreqIntensity') {
      setHighFreqIntensity(Math.round(newValue * 2) / 2); // 保持0.5的步长
    } else if (dragTarget === 'highFreqRange') {
      setHighFreqRange(Math.round(newValue * 2) / 2); // 保持0.5的步长
    } else if (dragTarget === 'edgeAlphaThreshold') {
      setEdgeAlphaThreshold(Math.round(newValue));
    } else if (dragTarget === 'edgeColorThreshold') {
      setEdgeColorThreshold(Math.round(newValue));
    } else if (dragTarget === 'edgeSmoothRadius') {
      setEdgeSmoothRadius(Math.round(newValue * 2) / 2); // 保持0.5的步长
    } else if (dragTarget === 'edgeIntensity') {
      setEdgeIntensity(Math.round(newValue * 2) / 2); // 保持0.5的步长
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    setDragTarget(null);
  };

  // 添加事件监听器
  React.useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragTarget, dragStartX, dragStartValue]);

  // 滑块变化处理
  const handleRadiusChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRadius(parseInt(event.target.value, 10));
  };

  const handleSigmaChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSigma(parseFloat(event.target.value));
  };

  // 数值输入处理
  const handleRadiusNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(event.target.value, 10);
    if (!isNaN(value) && value >= 5 && value <= 20) {
      setRadius(value);
    }
  };

  const handleSigmaNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(event.target.value);
    if (!isNaN(value) && value >= 1 && value <= 5) {
      setSigma(value);
    }
  };

  // 加权强度滑块处理
  const handleWeightedIntensityChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setWeightedIntensity(parseFloat(event.target.value));
  };

  const handleWeightedIntensityNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(event.target.value);
    if (!isNaN(value) && value >= 1 && value <= 10) {
      setWeightedIntensity(value);
    }
  };

  // 高频增强强度滑块处理
  const handleHighFreqIntensityChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setHighFreqIntensity(parseFloat(event.target.value));
  };

  const handleHighFreqIntensityNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(event.target.value);
    if (!isNaN(value) && value >= 1 && value <= 10) {
      setHighFreqIntensity(value);
    }
  };

  // 高频范围滑块处理
  const handleHighFreqRangeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setHighFreqRange(parseFloat(event.target.value));
  };

  const handleHighFreqRangeNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(event.target.value);
    if (!isNaN(value) && value >= 1 && value <= 10) {
      setHighFreqRange(value);
    }
  };

  // 智能边缘平滑滑块处理
  const handleEdgeAlphaThresholdChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEdgeAlphaThreshold(parseInt(event.target.value, 10));
  };

  const handleEdgeAlphaThresholdNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(event.target.value, 10);
    if (!isNaN(value) && value >= 10 && value <= 100) {
      setEdgeAlphaThreshold(value);
    }
  };

  const handleEdgeColorThresholdChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEdgeColorThreshold(parseInt(event.target.value, 10));
  };

  const handleEdgeColorThresholdNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(event.target.value, 10);
    if (!isNaN(value) && value >= 10 && value <= 100) {
      setEdgeColorThreshold(value);
    }
  };

  const handleEdgeSmoothRadiusChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEdgeSmoothRadius(parseFloat(event.target.value));
  };

  const handleEdgeSmoothRadiusNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(event.target.value);
    if (!isNaN(value) && value >= 1 && value <= 8) {
      setEdgeSmoothRadius(value);
    }
  };

  // 强度滑块处理
  const handleEdgeIntensityChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEdgeIntensity(parseFloat(event.target.value));
  };

  const handleEdgeIntensityNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(event.target.value);
    if (!isNaN(value) && value >= 1 && value <= 10) {
      setEdgeIntensity(value);
    }
  };
  // 分块平均功能
  const handleBlockAverage = async () => {
    try {
      const { executeAsModal } = core;
      
      await executeAsModal(async () => {
        // 检测当前编辑状态
        const editingState = await checkEditingState();
        if (!editingState.isValid) {
          return;
        }
        
        const { layer, isBackgroundLayer } = editingState;
        
        // 获取选区边界信息（如果没有选区则默认全选整个文档）
        const selectionBounds = await getSelectionData();
        if (!selectionBounds) {
          await core.showAlert({ message: '获取文档信息失败' });
          return;
        }
        
        // 使用共享的像素数据处理函数
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);
        
        // 创建完整文档尺寸的选区掩码数组
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }
        
        // 步骤3：用公式计算得到新数组
        const processedPixels = await processBlockAverage(
          pixelResult.selectionPixelData.buffer, 
          fullSelectionMask.buffer, 
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          isBackgroundLayer,
          useWeightedAverage,
          weightedIntensity
        );
        
        // 步骤4：应用处理后的像素数据
        await applyProcessedPixels(processedPixels, pixelResult);
      });
    } catch (error) {
      console.error('❌ 分块平均处理失败:', error);
      await core.showAlert({ message: '分块平均处理失败: ' + error.message });
    }
  };

  // 线条处理功能
  const handleLineEnhancement = async () => {
    try {
      const { executeAsModal } = core;
      
      await executeAsModal(async () => {
        // 检测当前编辑状态
        const editingState = await checkEditingState();
        if (!editingState.isValid) {
          return;
        }
        
        const { layer, isBackgroundLayer } = editingState;
        
        // 获取选区边界信息（如果没有选区则默认全选整个文档）
        const selectionBounds = await getSelectionData();
        if (!selectionBounds) {
          await core.showAlert({ message: '获取文档信息失败' });
          return;
        }
        
        // 使用共享的像素数据处理函数
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);
        
        // 创建完整文档尺寸的选区掩码数组
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }
        
        // 步骤3：用线条增强算法处理像素数据
        const processedPixels = await processLineEnhancement(
          pixelResult.selectionPixelData.buffer, 
          fullSelectionMask.buffer, 
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight }
        );
        
        console.log('✅ 线条增强处理完成，长度:', processedPixels.length);
        
        // 步骤4：应用处理后的像素数据
        await applyProcessedPixels(processedPixels, pixelResult);
        
        console.log('✅ 线条增强处理完成');
      });
    } catch (error) {
      console.error('❌ 线条增强处理失败:', error);
      await core.showAlert({ message: '线条增强处理失败: ' + error.message });
    }
  };

  
  // 高频增强功能
  const handleHighFrequencyEnhancement = async () => {
    try {
      const { executeAsModal } = core;
      
      await executeAsModal(async () => {
        // 检测当前编辑状态
        const editingState = await checkEditingState();
        if (!editingState.isValid) {
          return;
        }
        
        const { layer, isBackgroundLayer } = editingState;
        
        // 获取选区边界信息
        const selectionBounds = await getSelectionData();
        if (!selectionBounds) {
          await core.showAlert({ message: '请先创建选区' });
          return;
        }
        
        // 使用共享的像素数据处理函数
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);
        
        // 创建完整文档尺寸的选区掩码数组
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }
        
        // 步骤3：用高频增强算法处理像素数据
        const processedPixels = await processHighFrequencyEnhancement(
          pixelResult.selectionPixelData.buffer, 
          fullSelectionMask.buffer, 
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          { intensity: highFreqIntensity, thresholdRange: highFreqRange },
          isBackgroundLayer
        );
        
        console.log('✅ 高频增强处理完成，长度:', processedPixels.length);
        
        // 步骤4：应用处理后的像素数据
        await applyProcessedPixels(processedPixels, pixelResult);
        
        console.log('✅ 高频增强处理完成');
      });
    } catch (error) {
      console.error('❌ 高频增强处理失败:', error);
      await core.showAlert({ message: '高频增强处理失败: ' + error.message });
    }
  };

  // 智能边缘平滑功能
  const handleSmartEdgeSmooth = async () => {
    try {
      const { executeAsModal } = core;
      
      await executeAsModal(async () => {
        // 检测当前编辑状态
        const editingState = await checkEditingState();
        if (!editingState.isValid) {
          return;
        }
        
        const { layer, isBackgroundLayer } = editingState;
        
        // 获取选区边界信息
        const selectionBounds = await getSelectionData();
        if (!selectionBounds) {
          await core.showAlert({ message: '获取文档信息失败' });
          return;
        }
        
        // 使用共享的像素数据处理函数
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);
        
        // 创建完整文档尺寸的选区掩码数组
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }
        
        // 步骤3：用智能边缘平滑算法处理像素数据
        // 注意：传递完整的像素数据而不是选区像素数据，因为算法需要邻域信息
        const processedPixels = await processSmartEdgeSmooth(
          pixelResult.fullPixelData.buffer, 
          fullSelectionMask.buffer, 
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          {
            alphaThreshold: edgeAlphaThreshold,
            colorThreshold: edgeColorThreshold,
            smoothRadius: edgeSmoothRadius,
            preserveDetail: preserveDetail,
            intensity: edgeIntensity
          },
          isBackgroundLayer
        );
        
        console.log('✅ 智能边缘平滑处理完成，长度:', processedPixels.byteLength);
        
        // 步骤4：应用处理后的像素数据
        // 将ArrayBuffer转换为Uint8Array
        const processedPixelsArray = new Uint8Array(processedPixels);
        await applyProcessedPixels(processedPixelsArray, pixelResult);
        
        console.log('✅ 智能边缘平滑处理完成');
      });
    } catch (error) {
      console.error('❌ 智能边缘平滑处理失败:', error);
      await core.showAlert({ message: '智能边缘平滑处理失败: ' + error.message });
    }
  };

  //------------------------------------------------------------------------
  // 像素过渡功能
  const handlePixelTransition = async () => {
    try {
      const { executeAsModal } = core;
      
      await executeAsModal(async () => {
        // 检测当前编辑状态
        const editingState = await checkEditingState();
        if (!editingState.isValid) {
          return;
        }
        
        const { layer, isBackgroundLayer } = editingState;
        
        // 获取选区边界信息
        const selectionBounds = await getSelectionData();
        if (!selectionBounds) {
          await core.showAlert({ message: '请先创建选区' });
          return;
        }
        
        // 使用共享的像素数据处理函数
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);
        
        // 创建完整文档尺寸的选区掩码数组
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }
        
        // 步骤3：用公式计算得到新数组
        const processedPixels = await processPixelTransition(
          pixelResult.selectionPixelData.buffer, 
          fullSelectionMask.buffer, 
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          { radius, sigma },
          isBackgroundLayer
        );
        
        console.log('✅ 处理像素数据完成，长度:', processedPixels.length);
        
        // 步骤4：应用处理后的像素数据
        await applyProcessedPixels(processedPixels, pixelResult);
        
        console.log('✅ 像素过渡处理完成');
      });
    } catch (error) {
      console.error('❌ 像素过渡处理失败:', error);
      await core.showAlert({ message: '像素过渡处理失败: ' + error.message });
    }
  };
  
  return (
    <div className="adjustment-container">
      
      {/* 概括栏目 */}
      <div className="adjustment-section">
        <div className="adjustment-section-title">分块调整</div>

        <div className="adjustment-divider"></div>
        
         <div className="adjustment-double-buttons">
           {/* 分块确认按钮 */}
            <button 
              className="adjustment-button"
              onClick={handleBlockAverage}
              title={useWeightedAverage ? "使用特定平均算法弱化区域对比" : "对不相连选区分别计算平均值"}
            >
              分块平均
            </button>

            {/* 分块平均参数 */}
            <div className="adjustment-swtich-container">
            <label 
              className="adjustment-swtich-label"
              onClick={() => setUseWeightedAverage(!useWeightedAverage)}
              style={{ cursor: 'pointer' }}
            >
              加权模式
            </label>
                <sp-switch 
                checked={useWeightedAverage}
                onChange={(e) => setUseWeightedAverage(e.target.checked)}
              /> 
            </div>
        </div>

        {/* 加权强度滑块 - 仅在加权模式开启时显示 */}
        {useWeightedAverage && (
          <div className="adjustment-slider-container">
            <div className="adjustment-slider-item">
              <label
                className={`adjustment-slider-label ${
                  isDragging && dragTarget === 'weightedIntensity' 
                  ? 'dragging' 
                  : 'not-dragging'
                }`}
                onMouseDown={(e) => handleLabelMouseDown(e, 'weightedIntensity')}
              >
                强度
              </label>
              <input
                type="range"
                min="1"
                max="10"
                step="0.5"
                value={weightedIntensity}
                onChange={handleWeightedIntensityChange}
                className="adjustment-slider-input"
              />
              <div className="unit-container">
                <input
                  type="number"
                  min="1"
                  max="10"
                  step="0.5"
                  value={weightedIntensity}
                  onChange={handleWeightedIntensityNumberChange}
                  className="adjustment-number-input"
                />
                <span className="adjustment-unit">级</span>
              </div>
            </div>
          </div>   
        )}
      </div>
      
      {/* 过渡栏目 */}
      <div className="adjustment-section">
        <div className="adjustment-section-title">局部对比</div>
        <div className="adjustment-divider"></div>
        <button 
            className="adjustment-button"
            onClick={handlePixelTransition}
            title="模糊选区内alpha>0的像素"
          >
          像素过渡
        </button>


        <div className="adjustment-slider-container">
          {/* 过渡半径滑块 */}
          <div className="adjustment-slider-item">
            <label
              className={`adjustment-slider-label ${
                isDragging && dragTarget === 'radius' 
                ? 'dragging' 
                : 'not-dragging'
              }`}
              onMouseDown={(e) => handleLabelMouseDown(e, 'radius')}
            >
              半径
            </label>
            <input
              type="range"
              min="5"
              max="20"
              step="1"
              value={radius}
              onChange={handleRadiusChange}
              className="adjustment-slider-input"
            />
            <div className="unit-container">
              <input
                type="number"
                min="5"
                max="20"
                value={radius}
                onChange={handleRadiusNumberChange}
                className="adjustment-number-input"
              />
              <span className="adjustment-unit">px</span>
            </div>
          </div>
          
          {/* 过渡强度滑块 */}
          <div className="adjustment-slider-item">
            <label
              className={`adjustment-slider-label ${
                isDragging && dragTarget === 'sigma' 
                ? 'dragging' 
                : 'not-dragging'
              }`}
              onMouseDown={(e) => handleLabelMouseDown(e, 'sigma')}
            >
              强度
            </label>
            <input
              type="range"
              min="1"
              max="5"
              step="0.5"
              value={sigma}
              onChange={handleSigmaChange}
              className="adjustment-slider-input"
            />
            <div className="unit-container">
              <input
                type="number"
                min="1"
                max="5"
                step="0.5"
                value={sigma}
                onChange={handleSigmaNumberChange}
                className="adjustment-number-input"
              />
              <span className="adjustment-unit">px</span>
            </div>
          </div>
       
        </div>

        <div className="adjustment-divider"></div>

        <button 
            className="adjustment-button"
            onClick={handleHighFrequencyEnhancement}
            title="增强选区内高频信息，如头发等细节"
          >
            高频增强
        </button>
        
        <div className="adjustment-slider-container">
          {/* 高频增强强度滑块 */}
          <div className="adjustment-slider-item">
            <label
              className={`adjustment-slider-label ${
                isDragging && dragTarget === 'highFreqIntensity' 
                ? 'dragging' 
                : 'not-dragging'
              }`}
              onMouseDown={(e) => handleLabelMouseDown(e, 'highFreqIntensity')}
            >
              强度
            </label>
            <input
              type="range"
              min="1"
              max="10"
              step="0.5"
              value={highFreqIntensity}
              onChange={handleHighFreqIntensityChange}
              className="adjustment-slider-input"
            />
            <div className="unit-container">
              <input
                type="number"
                min="1"
                max="10"
                step="0.5"
                value={highFreqIntensity}
                onChange={handleHighFreqIntensityNumberChange}
                className="adjustment-number-input"
              />
              <span className="adjustment-unit">级</span>
            </div>
          </div>
        
          {/* 高频范围滑块 */}
          <div className="adjustment-slider-item">
            <label
              className={`adjustment-slider-label ${
                isDragging && dragTarget === 'highFreqRange' 
                ? 'dragging' 
                : 'not-dragging'
              }`}
              onMouseDown={(e) => handleLabelMouseDown(e, 'highFreqRange')}
            >
              范围
            </label>
            <input
              type="range"
              min="1"
              max="10"
              step="0.5"
              value={highFreqRange}
              onChange={handleHighFreqRangeChange}
              className="adjustment-slider-input"
            />
            <div className="unit-container">
              <input
                type="number"
                min="1"
                max="10"
                step="0.5"
                value={highFreqRange}
                onChange={handleHighFreqRangeNumberChange}
                className="adjustment-number-input"
              />
              <span className="adjustment-unit">级</span>
            </div>
          </div>
        </div>
      </div>
      
      
      {/* 边缘处理栏目 */}
      <div className="adjustment-section">
        <div className="adjustment-section-title">边缘处理</div>
        <div className="adjustment-divider"></div>
        
          {/* 平滑按钮控件 */}
        <div className="adjustment-double-buttons">
            <button 
              className="adjustment-button"
              onClick={handleSmartEdgeSmooth}
              title="智能识别边缘并进行平滑处理，保留色块内部细节"
            >
              边缘平滑
            </button>
            <div className="adjustment-swtich-container">
            <label 
              className="adjustment-swtich-label"
              onClick={() => setPreserveDetail(!preserveDetail)}
              style={{ cursor: 'pointer' }}
            >
              保留细节
            </label>
              <sp-switch 
                checked={preserveDetail}
                onChange={(e) => setPreserveDetail(e.target.checked)}
              />
            </div>
        </div>

        <div className="adjustment-slider-container">
           {/* 边缘alpha滑块控件 */}
          <div className="adjustment-slider-item">
            <label 
              className="wider-adjustment-slider-label"
              onMouseDown={(e) => handleLabelMouseDown(e, 'edgeAlphaThreshold')}
              title="拖拽调整Alpha差异阈值"
            >
              Alpha阈值
            </label>
            <input
              type="range"
              min="10"
              max="100"
              step="1"
              value={edgeAlphaThreshold}
              onChange={handleEdgeAlphaThresholdChange}
              className="narrower-adjustment-slider-input"
            />
            <div className="unit-container">
            <input
              type="number"
              min="10"
              max="100"
              value={edgeAlphaThreshold}
              onChange={handleEdgeAlphaThresholdNumberChange}
              className="adjustment-number-input"
            />
            <span className="adjustment-unit">%</span>
            </div>
          </div>
          
          <div className="adjustment-slider-item">
            <label 
              className="wide-adjustment-slider-label"

              onMouseDown={(e) => handleLabelMouseDown(e, 'edgeColorThreshold')}
              title="拖拽调整颜色差异阈值"
            >
              颜色阈值
            </label>
            <input
              type="range"
              min="10"
              max="100"
              step="1"
              value={edgeColorThreshold}
              onChange={handleEdgeColorThresholdChange}
              className="narrow-adjustment-slider-input"
            />
            <div className="unit-container">
            <input
              type="number"
              min="10"
              max="100"
              value={edgeColorThreshold}
              onChange={handleEdgeColorThresholdNumberChange}
              className="adjustment-number-input"
            />
            <span className="adjustment-unit">%</span>
            </div>
          </div>
          
          <div className="adjustment-slider-item">
            <label 
              className="adjustment-slider-label"
              onMouseDown={(e) => handleLabelMouseDown(e, 'edgeSmoothRadius')}
              title="拖拽调整平滑半径"
            >
              半径  
            </label>
            <input
              type="range"
              min="1"
              max="30"
              step="0.5"
              value={edgeSmoothRadius}
              onChange={handleEdgeSmoothRadiusChange}
              className="adjustment-slider-input"
            />
            <div className="unit-container">
            <input
              type="number"
              min="1"
              max="30"
              step="0.5"
              value={edgeSmoothRadius}
              onChange={handleEdgeSmoothRadiusNumberChange}
              className="adjustment-number-input"
            />
            <span className="adjustment-unit">px</span>
            </div>
          </div>

          <div className="adjustment-slider-item">
            <label 
              className="adjustment-slider-label"
              onMouseDown={(e) => handleLabelMouseDown(e, 'edgeIntensity')}
              title="拖拽调整拉直强度"
            >
              强度  
            </label>
            <input
              type="range"
              min="1"
              max="10"
              step="0.5"
              value={edgeIntensity}
              onChange={handleEdgeIntensityChange}
              className="adjustment-slider-input"
            />
            <div className="unit-container">
            <input
              type="number"
              min="1"
              max="10"
              step="0.5"
              value={edgeIntensity}
              onChange={handleEdgeIntensityNumberChange}
              className="adjustment-number-input"
            />
            <span className="adjustment-unit">级</span>
            </div>
          </div>
        </div>

        <div className="adjustment-divider"></div>
        
          <button 
            className="adjustment-button"
            onClick={handleLineEnhancement}
            title="增强选区内像素的alpha通道，让线条更加清晰"
          >
            加黑线条
          </button>
      </div>
    </div>
  );
};

export default AdjustmentPanel;