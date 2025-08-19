import React, { useState, useEffect, useRef } from 'react';
import { processBlockAverage } from './blockAverageProcessor';
import { processPixelTransition } from './pixelTransitionProcessor';
import { processLineEnhancement } from './lineProcessing';
import { processHighFrequencyEnhancement } from './highFrequencyEnhancer';
import { processSmartEdgeSmooth, defaultSmartEdgeSmoothParams } from './smartEdgeSmoothProcessor';
import { checkEditingState, processPixelData, applyProcessedPixels } from './pixelDataProcessor';
import { LicenseManager } from '../utils/LicenseManager';
import { action, app, core, imaging } from 'photoshop';
import './adjustment.css';
import './adjustment-input.css';
import { AdjustmentMenu } from '../utils/AdjustmentMenu';
import { ExpandIcon } from '../styles/Icons';

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

// 新增：分区与子功能类型
interface SectionConfig {
  id: 'blockAdjustment' | 'localContrast' | 'edgeProcessing' | string;
  title: string;
  isCollapsed: boolean;
  isVisible: boolean;
  order: number;
}

interface SubFeature {
  id: 'pixelTransition' | 'highFreqEnhancement' | 'edgeSmooth' | 'lineEnhancement' | string;
  parentId: SectionConfig['id'];
  title: string;
  isVisible: boolean;
  order: number;
}

// 默认分区配置
const defaultSections: SectionConfig[] = [
  { id: 'blockAdjustment', title: '分块调整', isCollapsed: false, isVisible: true, order: 0 },
  { id: 'localContrast', title: '局部对比', isCollapsed: false, isVisible: true, order: 1 },
  { id: 'edgeProcessing', title: '边缘处理', isCollapsed: false, isVisible: true, order: 2 }
];

// 默认子功能配置
const defaultSubFeatures: SubFeature[] = [
  { id: 'pixelTransition', parentId: 'localContrast', title: '像素过渡', isVisible: true, order: 0 },
  { id: 'highFreqEnhancement', parentId: 'localContrast', title: '高频增强', isVisible: true, order: 1 },
  { id: 'edgeSmooth', parentId: 'edgeProcessing', title: '边缘平滑', isVisible: true, order: 0 },
  { id: 'lineEnhancement', parentId: 'edgeProcessing', title: '加黑线条', isVisible: true, order: 1 }
];

const AdjustmentPanel: React.FC = () => {
// 许可证状态管理
const [isLicensed, setIsLicensed] = useState(false);
const [isTrial, setIsTrial] = useState(false);
const [trialDaysRemaining, setTrialDaysRemaining] = useState(0);

// 分区状态管理
const [sections, setSections] = useState<SectionConfig[]>(defaultSections);
const [subFeatures, setSubFeatures] = useState<SubFeature[]>(defaultSubFeatures);
const [selectedSections, setSelectedSections] = useState<Set<string>>(new Set());
const [isDragMode, setIsDragMode] = useState(false);
const [dragTarget, setDragTarget] = useState<{ type: 'section' | 'subfeature', id: string } | null>(null);

// 控制"隐藏/显示分区"面板
const [showVisibilityPanel, setShowVisibilityPanel] = useState(false);

const [radius, setRadius] = useState(15);
const [sigma, setSigma] = useState(5);
const [isDragging, setIsDragging] = useState(false);
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

// 许可证相关 Hook 和函数
useEffect(() => {
  const onLicenseUpdated = () => { checkLicenseStatus(); };
  document.addEventListener('license-updated', onLicenseUpdated as EventListener);

  // 首次挂载时检查一次
  checkLicenseStatus();

  return () => {
    document.removeEventListener('license-updated', onLicenseUpdated as EventListener);
  };
}, []);

// 注册Flyout菜单回调
useEffect(() => {
  AdjustmentMenu.registerCallbacks({
    onToggleVisibilityPanel: (visible: boolean) => {
      setShowVisibilityPanel(visible);
    },
    onToggleAllCollapse: () => {
      // 修复：判断当前是否有折叠项，如果有折叠项则全展开，否则全折叠
      const hasCollapsed = sections.some(s => s.isCollapsed);
      toggleAllSections(hasCollapsed);
    },
    onResetOrder: () => {
      resetSectionOrder();
    }
  });
}, [sections]);

// 当“隐藏/显示分区”模态打开时，为 body 添加类，配合 CSS 隐藏背后 number 输入
useEffect(() => {
  if (showVisibilityPanel) {
    document.body.classList.add('visibility-panel-open');
  } else {
    document.body.classList.remove('visibility-panel-open');
  }
  return () => document.body.classList.remove('visibility-panel-open');
}, [showVisibilityPanel]);
const checkLicenseStatus = async () => {
  try {
    // 与 app.tsx 保持一致：使用静态方法
    const status = await LicenseManager.checkLicenseStatus();

    // 统一逻辑：TRIAL_ 开头的密钥始终视为试用，不计入正式授权
    const cachedInfo: any = (status && status.info) || await (LicenseManager as any).getCachedLicense?.();
    const isTrialKey = cachedInfo && cachedInfo.key && String(cachedInfo.key).startsWith('TRIAL_');

    // 试用到期判断（仅当是试用时才判断）
    const expired = isTrialKey ? await LicenseManager.isTrialExpired() : false;

    // 正式授权仅在非试用且 isValid 为 true 时成立
    const licensed = !!status.isValid && !isTrialKey;

    // 试用状态：具有 TRIAL_ 且未过期
    let days = 0;
    if (isTrialKey && cachedInfo && cachedInfo.expiryDate) {
      const expire = new Date(cachedInfo.expiryDate).getTime();
      days = Math.max(0, Math.ceil((expire - Date.now()) / (24 * 60 * 60 * 1000)));
    }
    const trial = !!isTrialKey && !expired;

    // 自动重新验证：仅对正式许可证执行，避免对 TRIAL_ 触发无意义的网络验证
    if (status.needsReverification && !isTrialKey) {
      try { await LicenseManager.autoReverifyIfNeeded(); } catch {}
    }

    setIsLicensed(licensed);
    setIsTrial(trial);
    setTrialDaysRemaining(days);
    // 第二入口（AdjustmentPanel）不显示对话框，仅同步状态
    // setIsLicenseDialogOpen(false);
  } catch (error) {
    console.error('检查许可证状态失败:', error);
    setIsLicensed(false);
    setIsTrial(false);
    setTrialDaysRemaining(0);
    // 第二入口即使失败也不显示对话框
    // setIsLicenseDialogOpen(false);
  }
};

// 移除：第二入口不再控制授权对话框打开/关闭
// const handleLicenseVerified = () => {
//   setIsLicensed(true);
//   setIsTrial(false);
// };

// const handleTrialStarted = () => {
//   setIsTrial(true);
//   setIsLicensed(false);
//   setTrialDaysRemaining(7);
// };

// const closeLicenseDialog = () => {
//   document.body.classList.remove('license-dialog-open');
// };

// const openLicenseDialog = () => {
//   document.body.classList.add('license-dialog-open');
// };

const handleLicenseBeforeAction = (): boolean => {
  // 触发一次异步刷新，尽快感知在另一个入口刚完成的授权
  try { checkLicenseStatus(); } catch {}
  if (!isLicensed && !isTrial) {
    // 第二入口不开启对话框，仅提示用户前往第一入口激活
    console.log('需要在主面板（第一入口）进行授权激活');
    return false;
  }
  return true;
};

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
  if (!handleLicenseBeforeAction()) return;
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
  if (!handleLicenseBeforeAction()) return;
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
  if (!handleLicenseBeforeAction()) return;
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
  if (!handleLicenseBeforeAction()) return;
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

// 像素过渡功能
const handlePixelTransition = async () => {
  if (!handleLicenseBeforeAction()) return;
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

// 折叠/展开与排序等操作函数
const toggleSectionCollapse = (id: string) => {
  setSections(prev => prev.map(s => s.id === id ? { ...s, isCollapsed: !s.isCollapsed } : s));
};

const toggleAllSections = (expanded: boolean) => {
  setSections(prev => prev.map(s => ({ ...s, isCollapsed: !expanded })));
};

const resetSectionOrder = () => {
  setSections(defaultSections.map(s => ({ ...s })));
  setSubFeatures(defaultSubFeatures.map(sf => ({ ...sf })));
};

const toggleSectionVisibility = (id: string) => {
  setSections(prev => prev.map(s => s.id === id ? { ...s, isVisible: !s.isVisible } : s));
};

// 多选处理（Ctrl/Shift）
const handleSectionSelection = (event: React.MouseEvent, id: string) => {
  event.stopPropagation();
  setSelectedSections(prev => {
    const next = new Set(prev);
    if (event.shiftKey) {
      // 简单策略：若为空则直接添加，否则按排序范围选择
      const ordered = sections.slice().sort((a,b)=>a.order-b.order);
      const last = ordered.find(s=> next.has(s.id));
      if (!last) {
        next.add(id);
      } else {
        const startIndex = ordered.findIndex(s=>s.id===last.id);
        const endIndex = ordered.findIndex(s=>s.id===id);
        if (startIndex !== -1 && endIndex !== -1) {
          const [min, max] = [Math.min(startIndex,endIndex), Math.max(startIndex,endIndex)];
          for (let i=min;i<=max;i++) next.add(ordered[i].id);
        }
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (next.has(id)) next.delete(id); else next.add(id);
    } else {
      if (next.has(id) && next.size === 1) { next.clear(); } else { next.clear(); next.add(id); }
    }
    return next;
  });
};

// 拖拽排序（分区级）
const handleDragStart = (e: React.DragEvent, id: string) => {
  e.dataTransfer.setData('text/plain', id);
  setIsDragMode(true);
};

const handleDragOver = (e: React.DragEvent) => {
  e.preventDefault();
};

const handleDrop = (e: React.DragEvent, targetId: string) => {
  e.preventDefault();
  const sourceId = e.dataTransfer.getData('text/plain');
  if (!sourceId || sourceId === targetId) return;
  setSections(prev => {
    const ordered = prev.slice().sort((a,b)=>a.order-b.order);
    const srcIdx = ordered.findIndex(s=>s.id===sourceId);
    const tgtIdx = ordered.findIndex(s=>s.id===targetId);
    if (srcIdx===-1||tgtIdx===-1) return prev;
    const [moved] = ordered.splice(srcIdx,1);
    ordered.splice(tgtIdx,0,moved);
    return ordered.map((s,idx)=>({ ...s, order: idx }));
  });
  setIsDragMode(false);
};

// 渲染子功能内容
const renderLocalContrastContent = () => (
  <div className="adjustment-section">
    <div className="adjustment-divider"></div>
    
    <button className="adjustment-button" onClick={handlePixelTransition}>像素过渡</button>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" onMouseDown={(e)=>handleLabelMouseDown(e,'radius')}>半径</div>
        <div className="unit-container">
          <input type="range" min="5" max="20" step="1" value={radius} onChange={handleRadiusChange} className="adjustment-slider-input" />
          <input type="number" min="5" max="20" step="1" value={radius} onChange={handleRadiusNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">px</div>
        </div>
      </div>
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" onMouseDown={(e)=>handleLabelMouseDown(e,'sigma')}>强度</div>
        <div className="unit-container">
          <input type="range" min="1" max="5" step="0.5" value={sigma} onChange={handleSigmaChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="5" step="0.5" value={sigma} onChange={handleSigmaNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>
    
    <button className="adjustment-button" onClick={handleHighFrequencyEnhancement}>高频增强</button>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" onMouseDown={(e)=>handleLabelMouseDown(e,'highFreqIntensity')}>强度</div>
        <div className="unit-container">
          <input type="range" min="1" max="10" step="0.5" value={highFreqIntensity} onChange={handleHighFreqIntensityChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="10" step="0.5" value={highFreqIntensity} onChange={handleHighFreqIntensityNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" onMouseDown={(e)=>handleLabelMouseDown(e,'highFreqRange')}>范围</div>
        <div className="unit-container">
          <input type="range" min="1" max="10" step="0.5" value={highFreqRange} onChange={handleHighFreqRangeChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="10" step="0.5" value={highFreqRange} onChange={handleHighFreqRangeNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>
  </div>
);

const renderEdgeProcessingContent = () => (
  <div className="adjustment-section">
    <div className="adjustment-divider"></div>

    <div className="adjustment-double-buttons">
      <button className="adjustment-button" onClick={handleSmartEdgeSmooth}>边缘平滑</button>
      
      <div className="adjustment-swtich-container">
        <label className="adjustment-swtich-label">保留细节</label>
        <sp-switch 
          checked={preserveDetail}
          onChange={(e) => setPreserveDetail(e.target.checked)}
          style={{ marginLeft: '8px' }}
        />
      </div>
    </div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" onMouseDown={(e)=>handleLabelMouseDown(e,'edgeAlphaThreshold')}>Alpha阈值</div>
        <div className="unit-container">
          <input type="range" min="10" max="100" step="1" value={edgeAlphaThreshold} onChange={handleEdgeAlphaThresholdChange} className="adjustment-slider-input" />
          <input type="number" min="10" max="100" step="1" value={edgeAlphaThreshold} onChange={handleEdgeAlphaThresholdNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">%</div>
        </div>
      </div>
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" onMouseDown={(e)=>handleLabelMouseDown(e,'edgeColorThreshold')}>颜色阈值</div>
        <div className="unit-container">
          <input type="range" min="10" max="100" step="1" value={edgeColorThreshold} onChange={handleEdgeColorThresholdChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="100" step="1" value={edgeColorThreshold} onChange={handleEdgeColorThresholdNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">%</div>
        </div>
      </div>
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" onMouseDown={(e)=>handleLabelMouseDown(e,'edgeSmoothRadius')}>半径</div>
        <div className="unit-container">
          <input type="range" min="1" max="30" step="0.5" value={edgeSmoothRadius} onChange={handleEdgeSmoothRadiusChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="30" step="0.5" value={edgeSmoothRadius} onChange={handleEdgeSmoothRadiusNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">px</div>
        </div>
      </div>
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" onMouseDown={(e)=>handleLabelMouseDown(e,'edgeIntensity')}>强度</div>
        <div className="unit-container">
          <input type="range" min="1" max="10" step="0.5" value={edgeIntensity} onChange={handleEdgeIntensityChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="10" step="0.5" value={edgeIntensity} onChange={handleEdgeIntensityNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>

    <button className="adjustment-button" onClick={handleLineEnhancement}>加黑线条</button>
  </div>
);

const renderBlockAdjustmentContent = () => (
  <div className="adjustment-section">
    <div className="adjustment-divider"></div>

    <div className="adjustment-double-buttons">
      <button className="adjustment-button" onClick={handleBlockAverage}>分块平均</button>
      
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

    {useWeightedAverage && (
      <div className="adjustment-slider-container">
        <div className="adjustment-slider-item">
          <div className="adjustment-slider-label" onMouseDown={(e)=>handleLabelMouseDown(e,'weightedIntensity')}>强度</div>
          <div className="unit-container">
            <input type="range" min="1" max="10" step="0.5" value={weightedIntensity} onChange={handleWeightedIntensityChange} className="adjustment-slider-input" />
            <input type="number" min="1" max="10" step="0.5" value={weightedIntensity} onChange={handleWeightedIntensityNumberChange} className="adjustment-number-input" />
            <div className="adjustment-unit">级</div>
          </div>
        </div>
      </div>
    )}
  </div>
);

// 渲染整个分区
const renderSectionContent = (sectionId: string) => {
  if (sectionId === 'blockAdjustment') return renderBlockAdjustmentContent();
  if (sectionId === 'localContrast') return renderLocalContrastContent();
  if (sectionId === 'edgeProcessing') return renderEdgeProcessingContent();
  return null;
};

const renderSection = (section: SectionConfig) => (
  <div key={section.id} className="expand-section"
       draggable
       onDragStart={(e)=>handleDragStart(e, section.id)}
       onDragOver={handleDragOver}
       onDrop={(e)=>handleDrop(e, section.id)}
  >
    <div className="expand-header" onClick={()=>toggleSectionCollapse(section.id)} onMouseDown={(e)=>handleSectionSelection(e, section.id)}>
      <div className={`expand-icon ${section.isCollapsed ? '' : 'expanded'}`}>
        <ExpandIcon expanded={!section.isCollapsed} />
      </div>
      <div style={{ flex: 1 }}>{section.title}</div>
      {/* 移除对号标记，避免分区标题右侧出现视觉噪点 */}
    </div>
    <div className={`expand-content ${section.isCollapsed ? '' : 'expanded'}`}>
      {renderSectionContent(section.id)}
    </div>
  </div>
);

return (
  <div className="adjustment-container">
    {/* 试用状态提示 - 仅在试用中或试用结束时显示 */}
    {(isTrial || (!isLicensed && !isTrial && trialDaysRemaining === 0)) && (
      <div className={`license-status-banner ${isTrial ? 'is-trial' : 'is-expired'}`}>
        {isTrial && trialDaysRemaining > 0 ? (
          <>
            <span className="badge-dot" />
            <span className="trial-status">试用还剩 {trialDaysRemaining} 天</span>
          </>
        ) : (
          <>
            <span className="badge-dot danger" />
            <span className="trial-expired">需要在主面板激活</span>
          </>
        )}
      </div>
    )}

    {/* 渲染可见的分区，按order排序 */}
    {sections
      .filter(section => section.isVisible)
      .sort((a, b) => a.order - b.order)
      .map(section => renderSection(section))}

    {/* 隐藏/显示分区模态框 */}
    {showVisibilityPanel && (
      <div className="adjustment-modal-overlay" onClick={() => setShowVisibilityPanel(false)}>
        <div className="adjustment-modal-content" onClick={(e) => e.stopPropagation()}>
          <div className="adjustment-modal-header">
            <span>隐藏/显示分区</span>
            <button className="adjustment-modal-close" onClick={() => setShowVisibilityPanel(false)}>×</button>
          </div>
          <div className="adjustment-modal-list">
            {sections.sort((a,b)=>a.order-b.order).map(sec => (
              <div key={sec.id} className="adjustment-modal-item">
                <span
                  className="adjustment-modal-item-label"
                  onClick={() => toggleSectionVisibility(sec.id)}
                >{sec.title}</span>
                <sp-switch
                  checked={sec.isVisible}
                  onChange={() => toggleSectionVisibility(sec.id)}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    )}
  </div>
);

};

export default AdjustmentPanel;