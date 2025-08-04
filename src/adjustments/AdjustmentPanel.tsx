import React, { useState } from 'react';
import { processBlockAverage, processPixelTransition } from './pixelProcessing';
import { processLineEnhancement } from './lineProcessing';
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
      console.log('✅ 成功获取选区边界内的像素数据，数据类型:', selectionData.constructor.name, '长度:', selectionData.length);
      
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
  const [radius, setRadius] = useState(10);
  const [sigma, setSigma] = useState(3);
  const [isDragging, setIsDragging] = useState(false);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartValue, setDragStartValue] = useState(0);

  // 拖拽处理函数
  const handleLabelMouseDown = (event: React.MouseEvent, target: string) => {
    event.preventDefault();
    setIsDragging(true);
    setDragTarget(target);
    setDragStartX(event.clientX);
    setDragStartValue(target === 'radius' ? radius : sigma);
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (!isDragging || !dragTarget) return;

    const deltaX = event.clientX - dragStartX;
    const sensitivity = dragTarget === 'radius' ? 0.1 : 0.02;
    const minValue = dragTarget === 'radius' ? 5 : 1;
    const maxValue = dragTarget === 'radius' ? 20 : 5;
    
    const newValue = Math.max(
      minValue,
      Math.min(maxValue, dragStartValue + (deltaX * sensitivity))
    );

    if (dragTarget === 'radius') {
      setRadius(Math.round(newValue));
    } else {
      setSigma(Math.round(newValue * 2) / 2); // 保持0.5的步长
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
          isBackgroundLayer
        );
        
        console.log('✅ 处理像素数据完成，长度:', processedPixels.length);
        
        // 步骤4：应用处理后的像素数据
        await applyProcessedPixels(processedPixels, pixelResult);
        
        console.log('✅ 分块平均处理完成');
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
      <h2 className="adjustment-title">
        调整内容
      </h2>
      
      {/* 概括栏目 */}
      <div className="adjustment-section">
        <div className="adjustment-section-title">细节调整</div>
        <div className="adjustment-buttons">
          <button 
            className="adjustment-button"
            onClick={handleBlockAverage}
            title="对不相连选区分别计算平均值"
          >
            分块平均
          </button>
        </div>
      </div>

      <div className="adjustment-divider"></div>
      
      {/* 过渡栏目 */}
      <div className="adjustment-section">
        <div className="adjustment-section-title">局部对比</div>
        <div className="adjustment-buttons">
          <button 
            className="adjustment-button"
            onClick={handlePixelTransition}
            title="模糊选区内alpha>0的像素"
          >
            像素过渡
          </button>
        </div>
        
        {/* 过渡参数滑块 */}
        <div className="adjustment-slider-container">
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
            <div style={{ display: 'flex', alignItems: 'center'}}>
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
            <div style={{ display: 'flex', alignItems: 'center'}}>
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
      </div>
      
      <div className="adjustment-divider"></div>
      
      {/* 线条处理栏目 */}
      <div className="adjustment-section">
        <div className="adjustment-section-title">线条处理</div>
        <div className="adjustment-buttons">
          <button 
            className="adjustment-button"
            onClick={handleLineEnhancement}
            title="增强选区内像素的alpha通道，让线条更加清晰"
          >
            加黑线条
          </button>
        </div>
      </div>
    </div>
  );
};

export default AdjustmentPanel;