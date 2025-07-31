import React, { useState } from 'react';
import { processBlockAverage, processPixelTransition } from './pixelProcessing';
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
    
    // 获取选区边界
    const bounds = selectionResult[0].selection;
    const left = Math.round(bounds.left._value);
    const top = Math.round(bounds.top._value);
    const right = Math.round(bounds.right._value);
    const bottom = Math.round(bounds.bottom._value);
    const width = right - left;
    const height = bottom - top;
    
    // 使用imaging.getSelection获取羽化选区的像素数据
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
    
    const selectionData = await pixels.imageData.getData();
    console.log('✅ 成功获取选区边界内的像素数据，数据类型:', selectionData.constructor.name, '长度:', selectionData.length);
    
    // 创建临时数组来存储矩形边界内的所有像素信息
    const tempSelectionValues = new Uint8Array(width * height);
    const tempSelectionCoefficients = new Float32Array(width * height);
    // 创建一个新的Set来存储选区内像素（值大于0）在文档中的索引
    const selectionDocIndices = new Set<number>();
    
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
    const selectionSize = selectionDocIndices.size;
    const selectionValues = new Uint8Array(selectionSize);
    const selectionCoefficients = new Float32Array(selectionSize);
    
    // 将选区内像素的值和系数填入新数组
    let fillIndex = 0;
    for (let i = 0; i < width * height; i++) {
      if (tempSelectionValues[i] > 0) {
        selectionValues[fillIndex] = tempSelectionValues[i];
        selectionCoefficients[fillIndex] = tempSelectionCoefficients[i];
        fillIndex++;
      }
    }
    console.log('✅ 选区内像素数量（selectionDocIndices.size）:', selectionDocIndices.size);
    
    // 释放ImageData内存
    pixels.imageData.dispose();
   
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
        // 获取选区边界信息
        const selectionBounds = await getSelectionData();
        if (!selectionBounds) {
          await core.showAlert({ message: '请先创建选区' });
          return;
        }
        
        // 检查当前图层是否为像素图层
        const doc = app.activeDocument;
        if (!doc) {
          await core.showAlert({ message: '未找到活动文档' });
          return;
        }
        
        const layer = doc.activeLayers[0];
        if (!layer) {
          await core.showAlert({ message: '未找到活动图层' });
          return;
        }
        if (layer.kind !== 'pixel') {
          await core.showAlert({ message: '请选择像素图层' });
          return;
        }
        
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
        
        // 创建完整文档大小的像素数组，初始化为透明
        const fullPixelData = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight * 4);
        
        // 将图层像素数据填入对应位置
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
        
        // 释放图层像素数据内存
        layerPixels.imageData.dispose();
        
        console.log('✅ 创建完整文档像素数组，长度:', fullPixelData.length);
        
        // 步骤2：创建完整文档尺寸的选区像素数组，选区外设为透明
        const selectionPixelData = new Uint8Array(fullPixelData.length); // 保持完整文档尺寸
        const selectionIndices = Array.from(selectionBounds.selectionDocIndices);
        
        // 复制选区内的像素，选区外保持透明（默认为0）
        for (const docIndex of selectionIndices) {
          const sourceIndex = docIndex * 4;
          
          selectionPixelData[sourceIndex] = fullPixelData[sourceIndex];         // R
          selectionPixelData[sourceIndex + 1] = fullPixelData[sourceIndex + 1]; // G
          selectionPixelData[sourceIndex + 2] = fullPixelData[sourceIndex + 2]; // B
          selectionPixelData[sourceIndex + 3] = fullPixelData[sourceIndex + 3]; // A
        }
        
        console.log('✅ 创建完整尺寸选区像素数组，长度:', selectionPixelData.length);
        
        // 创建完整文档尺寸的选区掩码数组
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }
        
        // 步骤3：用公式计算得到新数组
        const processedPixels = await processBlockAverage(
          selectionPixelData.buffer, 
          fullSelectionMask.buffer, 
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight }
        );
        
        console.log('✅ 处理像素数据完成，长度:', processedPixels.length);
        
        // 步骤4：应用处理后的像素数据
        const newFullPixelData = new Uint8Array(fullPixelData.length);
        newFullPixelData.set(fullPixelData); // 复制原始数据
        
        let coefficientIndex = 0;
        for (const docIndex of selectionIndices) {
          const pixelIndex = docIndex * 4;
          const coefficient = selectionBounds.selectionCoefficients[coefficientIndex];
          
          // 根据选区系数混合原始颜色和处理后的颜色
          newFullPixelData[pixelIndex] = Math.round(fullPixelData[pixelIndex] * (1 - coefficient) + processedPixels[pixelIndex] * coefficient);
          newFullPixelData[pixelIndex + 1] = Math.round(fullPixelData[pixelIndex + 1] * (1 - coefficient) + processedPixels[pixelIndex + 1] * coefficient);
          newFullPixelData[pixelIndex + 2] = Math.round(fullPixelData[pixelIndex + 2] * (1 - coefficient) + processedPixels[pixelIndex + 2] * coefficient);
          newFullPixelData[pixelIndex + 3] = Math.round(fullPixelData[pixelIndex + 3] * (1 - coefficient) + processedPixels[pixelIndex + 3] * coefficient);
          
          coefficientIndex++;
        }
        
        console.log('✅ 映射回完整像素数组完成');
        
        // 步骤5：把改造后的完整像素数组通过putPixels写回图层
        const newImageData = await imaging.createImageDataFromBuffer(newFullPixelData, {
          width: selectionBounds.docWidth,
          height: selectionBounds.docHeight,
          colorSpace: 'RGB',
          pixelFormat: 'RGBA',
          components: 4,
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
        
        console.log('✅ 分块平均处理完成');
      });
    } catch (error) {
      console.error('❌ 分块平均处理失败:', error);
      await core.showAlert({ message: '分块平均处理失败: ' + error.message });
    }
  };

  
  //------------------------------------------------------------------------
  // 像素过渡功能
  const handlePixelTransition = async () => {
    try {
      const { executeAsModal } = core;
      
      await executeAsModal(async () => {
        // 获取选区边界信息
        const selectionBounds = await getSelectionData();
        if (!selectionBounds) {
          await core.showAlert({ message: '请先创建选区' });
          return;
        }
        
        // 检查当前图层是否为像素图层
        const doc = app.activeDocument;
        if (!doc) {
          await core.showAlert({ message: '未找到活动文档' });
          return;
        }
        
        const layer = doc.activeLayers[0];
        if (!layer) {
          await core.showAlert({ message: '未找到活动图层' });
          return;
        }
        if (layer.kind !== 'pixel') {
          await core.showAlert({ message: '请选择像素图层' });
          return;
        }
        
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
        
        // 创建完整文档大小的像素数组，初始化为透明
        const fullPixelData = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight * 4);
        
        // 将图层像素数据填入对应位置
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
        
        // 释放图层像素数据内存
        layerPixels.imageData.dispose();
        
        console.log('✅ 创建完整文档像素数组，长度:', fullPixelData.length);
        
        // 步骤2：创建完整文档尺寸的选区像素数组，选区外设为透明
        const selectionPixelData = new Uint8Array(fullPixelData.length); // 保持完整文档尺寸
        const selectionIndices = Array.from(selectionBounds.selectionDocIndices);
        
        // 复制选区内的像素，选区外保持透明（默认为0）
        for (const docIndex of selectionIndices) {
          const sourceIndex = docIndex * 4;
          
          selectionPixelData[sourceIndex] = fullPixelData[sourceIndex];         // R
          selectionPixelData[sourceIndex + 1] = fullPixelData[sourceIndex + 1]; // G
          selectionPixelData[sourceIndex + 2] = fullPixelData[sourceIndex + 2]; // B
          selectionPixelData[sourceIndex + 3] = fullPixelData[sourceIndex + 3]; // A
        }
        
        console.log('✅ 创建完整尺寸选区像素数组，长度:', selectionPixelData.length);
        
        // 创建完整文档尺寸的选区掩码数组
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }
        
        // 步骤3：用公式计算得到新数组
        const processedPixels = await processPixelTransition(
          selectionPixelData.buffer, 
          fullSelectionMask.buffer, 
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          { radius, sigma }
        );
        
        console.log('✅ 处理像素数据完成，长度:', processedPixels.length);
        
        // 步骤4：应用处理后的像素数据
        const newFullPixelData = new Uint8Array(fullPixelData.length);
        newFullPixelData.set(fullPixelData); // 复制原始数据
        
        let coefficientIndex = 0;
        for (const docIndex of selectionIndices) {
          const pixelIndex = docIndex * 4;
          const coefficient = selectionBounds.selectionCoefficients[coefficientIndex];
          
          // 根据选区系数混合原始颜色和处理后的颜色
          newFullPixelData[pixelIndex] = Math.round(fullPixelData[pixelIndex] * (1 - coefficient) + processedPixels[pixelIndex] * coefficient);
          newFullPixelData[pixelIndex + 1] = Math.round(fullPixelData[pixelIndex + 1] * (1 - coefficient) + processedPixels[pixelIndex + 1] * coefficient);
          newFullPixelData[pixelIndex + 2] = Math.round(fullPixelData[pixelIndex + 2] * (1 - coefficient) + processedPixels[pixelIndex + 2] * coefficient);
          newFullPixelData[pixelIndex + 3] = Math.round(fullPixelData[pixelIndex + 3] * (1 - coefficient) + processedPixels[pixelIndex + 3] * coefficient);
          
          coefficientIndex++;
        }
        
        console.log('✅ 映射回完整像素数组完成');
        
        // 步骤5：把改造后的完整像素数组通过putPixels写回图层
            const newImageData = await imaging.createImageDataFromBuffer(newFullPixelData, {
              width: selectionBounds.docWidth,
              height: selectionBounds.docHeight,
              colorSpace: 'RGB',
              pixelFormat: 'RGBA',
              components: 4,
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
        <div className="adjustment-section-title">概括</div>
        <div className="adjustment-buttons">
          <button 
            className="adjustment-button"
            onClick={handleBlockAverage}
          >
            分块平均
          </button>
        </div>
      </div>
      
      {/* 过渡栏目 */}
      <div className="adjustment-section">
        <div className="adjustment-section-title">过渡</div>
        <div className="adjustment-buttons">
          <button 
            className="adjustment-button"
            onClick={handlePixelTransition}
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
      
      <div className="adjustment-description">
        <h4>功能说明</h4>
        <p><strong>分块平均：</strong>对不相连选区分别计算平均值</p>
        <p><strong>像素过渡：</strong>模糊选区内alpha&gt;0的像素</p>
      </div>
    </div>
  );
};

export default AdjustmentPanel;