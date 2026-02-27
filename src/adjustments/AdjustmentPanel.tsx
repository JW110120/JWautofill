import React, { useState, useEffect, useRef } from 'react';
import { processBlockAverage } from './blockAverageProcessor';
import { processBlockGradient } from './blockGradientProcessor';
import { processPixelTransition } from './pixelTransitionProcessor';
import { processGradientRelax } from './gradientRelaxProcessor';
import { processSpecialSharpen } from './specialSharpenProcessor';
import { processLineEnhancement } from './lineProcessing';
import { processHighFrequencyEnhancement } from './highFrequencyEnhancer';
import { processSmartEdgeSmooth, defaultSmartEdgeSmoothParams } from './smartEdgeSmoothProcessor';
import { checkEditingState, processPixelData, applyProcessedPixels } from './pixelDataProcessor';
import { LicenseManager } from '../utils/LicenseManager';
import { action, app, core, imaging } from 'photoshop';
import type { Gradient } from '../types/state';
import './adjustment.css';
import './adjustment-input.css';
import { AdjustmentMenu } from '../utils/AdjustmentMenu';
import { ExpandIcon } from '../styles/Icons';
import { PanelStateManager } from '../utils/PanelStateManager';

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
  { id: 'gradientRelax', parentId: 'localContrast', title: '梯度修改', isVisible: true, order: 1 },
  { id: 'highFreqEnhancement', parentId: 'localContrast', title: '高频增强', isVisible: true, order: 2 },
  { id: 'edgeSmooth', parentId: 'edgeProcessing', title: '边缘平滑', isVisible: true, order: 0 },
  { id: 'lineEnhancement', parentId: 'edgeProcessing', title: '线条加黑', isVisible: true, order: 1 }
];

const AdjustmentPanel: React.FC = () => {
// DOM引用，用于绑定键盘事件
const rootRef = useRef<HTMLDivElement>(null);

// 许可证状态管理
const [isLicensed, setIsLicensed] = useState(false);
const [isTrial, setIsTrial] = useState(false);
const [trialDaysRemaining, setTrialDaysRemaining] = useState(0);

// 分区状态管理
const [sections, setSections] = useState<SectionConfig[]>(defaultSections);
const [subFeatures, setSubFeatures] = useState<SubFeature[]>(defaultSubFeatures);
const [isDragMode, setIsDragMode] = useState(false);
// 标记：面板状态是否已从本地加载完成（避免初次写入覆盖旧值）
const [panelStateLoaded, setPanelStateLoaded] = useState(false);


// 控制"隐藏/显示分区"面板
const [showVisibilityPanel, setShowVisibilityPanel] = useState(false);

const [radius, setRadius] = useState(15);
const [sigma, setSigma] = useState(5);
const [specialSharpenStrength, setSpecialSharpenStrength] = useState(5);
const [gradientRelaxStrength, setGradientRelaxStrength] = useState(-5);

const [useWeightedAverage, setUseWeightedAverage] = useState(true);
const [weightedIntensity, setWeightedIntensity] = useState(5);
const [highFreqIntensity, setHighFreqIntensity] = useState(5);
const [highFreqRange, setHighFreqRange] = useState(3);

// 智能边缘平滑参数
const [edgeSmoothMode, setEdgeSmoothMode] = useState((defaultSmartEdgeSmoothParams.mode as any) || 'edge');
const [edgeMedianRadius, setEdgeMedianRadius] = useState(defaultSmartEdgeSmoothParams.edgeMedianRadius ?? 16);
const [edgeBackgroundSmoothRadius, setEdgeBackgroundSmoothRadius] = useState(defaultSmartEdgeSmoothParams.backgroundSmoothRadius ?? 16);
const [edgeLineStrength, setEdgeLineStrength] = useState(Math.round((defaultSmartEdgeSmoothParams.lineStrength ?? 1) * 100));
const [edgeLineWidthScale, setEdgeLineWidthScale] = useState(defaultSmartEdgeSmoothParams.lineWidthScale ?? 1);
const [edgeLineHardness, setEdgeLineHardness] = useState(Math.round((defaultSmartEdgeSmoothParams.lineHardness ?? 1) * 100));

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

// ========= 像素调整面板状态：加载 =========
useEffect(() => {
  (async () => {
    try {
      const loaded = await PanelStateManager.initialize({
        adjustmentPanel: {
          sections,
          subFeatures,
          toggles: { useWeightedAverage },
        },
      });
      const ap = loaded && loaded.adjustmentPanel;
      if (ap) {
        if (ap.sections && ap.sections.length) {
          setSections(ap.sections);
        }
        if (ap.subFeatures && ap.subFeatures.length) {
          setSubFeatures(ap.subFeatures);
        }
        if (ap.toggles) {
          if (typeof ap.toggles.useWeightedAverage === 'boolean') {
            setUseWeightedAverage(ap.toggles.useWeightedAverage);
          }
        }
        if (ap.values) {
          if (typeof ap.values.radius === 'number') setRadius(ap.values.radius);
          if (typeof ap.values.sigma === 'number') setSigma(ap.values.sigma);
          if (typeof ap.values.specialSharpenStrength === 'number') setSpecialSharpenStrength(ap.values.specialSharpenStrength);
          if (typeof ap.values.gradientRelaxStrength === 'number') {
            const v = ap.values.gradientRelaxStrength;
            const signedReady = ap.values.gradientModifySigned === true;
            const clampedAbs = Math.max(0, Math.min(10, Math.abs(v)));
            const next = signedReady ? Math.max(-10, Math.min(10, v)) : (v === 0 ? 0 : -clampedAbs);
            setGradientRelaxStrength(next);
          }
          if (typeof ap.values.weightedIntensity === 'number') setWeightedIntensity(ap.values.weightedIntensity);
          if (typeof ap.values.highFreqIntensity === 'number') setHighFreqIntensity(ap.values.highFreqIntensity);
          if (typeof ap.values.highFreqRange === 'number') setHighFreqRange(ap.values.highFreqRange);
          if (typeof ap.values.edgeSmoothMode === 'string') setEdgeSmoothMode(ap.values.edgeSmoothMode === 'line' ? 'line' : 'edge');
          if (typeof ap.values.edgeMedianRadius === 'number') setEdgeMedianRadius(Math.max(10, Math.min(30, Math.round(ap.values.edgeMedianRadius))));
          if (typeof ap.values.edgeBackgroundSmoothRadius === 'number') setEdgeBackgroundSmoothRadius(Math.max(10, Math.min(30, Math.round(ap.values.edgeBackgroundSmoothRadius))));
          if (typeof ap.values.edgeLineStrength === 'number') setEdgeLineStrength(ap.values.edgeLineStrength);
          if (typeof ap.values.edgeLineWidthScale === 'number') setEdgeLineWidthScale(ap.values.edgeLineWidthScale);
          if (typeof ap.values.edgeLineHardness === 'number') setEdgeLineHardness(ap.values.edgeLineHardness);
        }
      }
      setPanelStateLoaded(true);
    } catch (e) {
      console.warn('⚠️ 像素调整面板状态加载失败，使用默认状态:', e);
      setPanelStateLoaded(true);
    }
  })();
  // 仅在挂载时执行一次
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// ========= 像素调整面板状态：持久化 =========
useEffect(() => {
  if (!panelStateLoaded) return;
  PanelStateManager.update({
    adjustmentPanel: {
      sections,
      subFeatures,
      toggles: { useWeightedAverage },
      values: {
        radius,
        sigma,
        specialSharpenStrength,
        gradientRelaxStrength,
        gradientModifySigned: true,
        weightedIntensity,
        highFreqIntensity,
        highFreqRange,
        edgeSmoothMode,
        edgeMedianRadius,
        edgeBackgroundSmoothRadius,
        edgeLineStrength,
        edgeLineWidthScale,
        edgeLineHardness,
      },
    },
  }, { debounceMs: 400 }).catch(e => console.warn('⚠️ 保存像素调整面板状态失败:', e));
}, [
  panelStateLoaded,
  sections,
  subFeatures,
  useWeightedAverage,
  radius,
  sigma,
  specialSharpenStrength,
  gradientRelaxStrength,
  weightedIntensity,
  highFreqIntensity,
  highFreqRange,
  edgeSmoothMode,
  edgeMedianRadius,
  edgeBackgroundSmoothRadius,
  edgeLineStrength,
  edgeLineWidthScale,
  edgeLineHardness,
]);

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
    },
    onResetParameters: () => {
      // 1) 分区与子功能回归默认配置（顺序、可见性、折叠状态）
      setSections([...defaultSections]);
      setSubFeatures([...defaultSubFeatures]);
      // 2) 基础参数复位
      setRadius(15);
      setSigma(5);
      setSpecialSharpenStrength(5);
      setGradientRelaxStrength(-5);
      setUseWeightedAverage(true);
      setWeightedIntensity(5);
      setHighFreqIntensity(5);
      setHighFreqRange(3);
      // 3) 智能边缘平滑参数复位
      setEdgeSmoothMode((defaultSmartEdgeSmoothParams.mode as any) || 'edge');
      setEdgeMedianRadius(defaultSmartEdgeSmoothParams.edgeMedianRadius ?? 20);
      setEdgeBackgroundSmoothRadius(defaultSmartEdgeSmoothParams.backgroundSmoothRadius ?? 16);
      setEdgeLineStrength(Math.round((defaultSmartEdgeSmoothParams.lineStrength ?? 1) * 100));
      setEdgeLineWidthScale(defaultSmartEdgeSmoothParams.lineWidthScale ?? 1);
      setEdgeLineHardness(Math.round((defaultSmartEdgeSmoothParams.lineHardness ?? 1) * 100));
      // 4) 关闭可见性面板
      setShowVisibilityPanel(false);
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

// 拦截 Enter 键，避免触发 Photoshop 的“重复上一操作”
useEffect(() => {
  const el = rootRef.current ?? document.getElementById('pixeladjustment');
  if (!el) return;

  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key;
    if (key === 'Enter') {
      // 在本面板内始终阻止 Enter 的默认行为和冒泡
      e.preventDefault();
      e.stopPropagation();
    }
  };

  el.addEventListener('keydown', onKeyDown, { capture: true } as any);
  // 保险起见，监听 document 但仅当事件目标在本面板内部时才阻止
  const onDocKeyDown = (e: KeyboardEvent) => {
    const container = rootRef.current ?? document.getElementById('pixeladjustment');
    if (!container) return;
    if (e.key === 'Enter' && container.contains(e.target as Node)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', onDocKeyDown, { capture: true } as any);

  return () => {
    el.removeEventListener('keydown', onKeyDown, { capture: true } as any);
    document.removeEventListener('keydown', onDocKeyDown, { capture: true } as any);
  };
}, []);
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
  }
};

const handleLicenseBeforeAction = (): boolean => {
  // 触发一次异步刷新，尽快感知在另一个入口刚完成的授权
  try { checkLicenseStatus(); } catch {}
  if (!isLicensed && !isTrial) {
    // 第二入口不开启对话框，直接弹出提示
    try {
      core.showAlert({ message: '当前未激活，请在选区笔界面完成授权后再使用此功能。' });
    } catch {}
    console.log('需要在主面板（第一入口）进行授权激活');
    return false;
  }
  return true;
};





// 滑块变化处理
const handleRadiusChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  setRadius(parseInt(event.target.value, 10));
};

const handleSigmaChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  setSigma(parseFloat(event.target.value));
};

const handleSpecialSharpenStrengthChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  setSpecialSharpenStrength(parseFloat(event.target.value));
};

const handleGradientRelaxStrengthChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  setGradientRelaxStrength(parseInt(event.target.value, 10));
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

const handleSpecialSharpenStrengthNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseFloat(event.target.value);
  if (!isNaN(value) && value >= 1 && value <= 10) {
    setSpecialSharpenStrength(value);
  }
};

const handleGradientRelaxStrengthNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= -10 && value <= 10) {
    setGradientRelaxStrength(value);
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

const handleEdgeSmoothModeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
  setEdgeSmoothMode(event.target.value);
};

const handleEdgeMedianRadiusChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  setEdgeMedianRadius(parseInt(event.target.value, 10));
};

const handleEdgeMedianRadiusNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 10 && value <= 30) {
    setEdgeMedianRadius(value);
  }
};

const handleEdgeBackgroundSmoothRadiusChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  setEdgeBackgroundSmoothRadius(parseInt(event.target.value, 10));
};

const handleEdgeBackgroundSmoothRadiusNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 10 && value <= 30) {
    setEdgeBackgroundSmoothRadius(value);
  }
};

const handleEdgeLineStrengthChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  setEdgeLineStrength(parseInt(event.target.value, 10));
};

const handleEdgeLineStrengthNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 0 && value <= 100) {
    setEdgeLineStrength(value);
  }
};

const handleEdgeLineWidthScaleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  setEdgeLineWidthScale(parseFloat(event.target.value));
};

const handleEdgeLineWidthScaleNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseFloat(event.target.value);
  if (!isNaN(value) && value >= 0.5 && value <= 2) {
    setEdgeLineWidthScale(value);
  }
};

const handleEdgeLineHardnessChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  setEdgeLineHardness(parseInt(event.target.value, 10));
};

const handleEdgeLineHardnessNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 0 && value <= 100) {
    setEdgeLineHardness(value);
  }
};

// 图层锁定处理工具函数（记录-解锁-恢复）
const getCurrentLayerLockState = async () => {
  try {
    const res = await action.batchPlay([
      {
        _obj: 'get',
        _target: [
          { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }
        ],
        _property: 'layerLocking',
        _options: { dialogOptions: 'dontDisplay' }
      }
    ], { synchronousExecution: true });
    const obj: any = res && res[0] ? res[0] : {};
    const locking: any = obj.layerLocking || obj || {};
    return {
      protectAll: !!locking.protectAll,
      protectComposite: !!locking.protectComposite,
      protectPosition: !!locking.protectPosition,
      protectTransparency: !!locking.protectTransparency
    };
  } catch (e) {
    console.warn('⚠️ 读取图层锁定状态失败，默认视为未锁定', e);
    return { protectAll: false, protectComposite: false, protectPosition: false, protectTransparency: false };
  }
};

const unlockAllLayerLocks = async () => {
  try {
    await action.batchPlay([
      {
        _obj: 'applyLocking',
        _target: [
          { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }
        ],
        layerLocking: { _obj: 'layerLocking', protectNone: true },
        _options: { dialogOptions: 'dontDisplay' }
      }
    ], { synchronousExecution: true });
  } catch (e) {
    console.warn('⚠️ 解锁图层失败', e);
  }
};

const restoreLayerLocks = async (state: { protectAll?: boolean; protectComposite?: boolean; protectPosition?: boolean; protectTransparency?: boolean; }) => {
  try {
    const layerLocking: any = { _obj: 'layerLocking' };
    if (state.protectAll) {
      layerLocking.protectAll = true;
    } else {
      if (state.protectTransparency) layerLocking.protectTransparency = true;
      if (state.protectPosition) layerLocking.protectPosition = true;
      if (state.protectComposite) layerLocking.protectComposite = true;
      if (!state.protectTransparency && !state.protectPosition && !state.protectComposite) {
        layerLocking.protectNone = true;
      }
    }
    await action.batchPlay([
      {
        _obj: 'applyLocking',
        _target: [
          { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }
        ],
        layerLocking,
        _options: { dialogOptions: 'dontDisplay' }
      }
    ], { synchronousExecution: true });
  } catch (e) {
    console.warn('⚠️ 恢复图层锁定失败', e);
  }
};

const runWithTemporaryUnlock = async (fn: () => Promise<void>) => {
  const prev = await getCurrentLayerLockState();
  const hadLock = !!(prev.protectAll || prev.protectComposite || prev.protectPosition || prev.protectTransparency);
  if (hadLock) {
    await unlockAllLayerLocks();
  }
  try {
    await fn();
  } finally {
    if (hadLock) {
      await restoreLayerLocks(prev);
    }
  }
};

// 在操作完成后释放面板焦点，让 Photoshop 重新接收快捷键
const giveFocusBackToPS = () => {
  try {
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.blur === 'function') {
      active.blur();
    }
    // 异步再尝试一次，确保 executeAsModal 之后也释放焦点
    setTimeout(() => {
      const active2 = document.activeElement as HTMLElement | null;
      if (active2 && typeof active2.blur === 'function') {
        active2.blur();
      }
    }, 0);
  } catch (e) {
    console.warn('⚠️ 释放面板焦点失败:', e);
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
      
      await runWithTemporaryUnlock(async () => {
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
    });
    giveFocusBackToPS();
  } catch (error) {
    console.error('❌ 分块平均处理失败:', error);
    await core.showAlert({ message: '分块平均处理失败: ' + error.message });
  }
};

const handleBlockGradient = async () => {
  if (!handleLicenseBeforeAction()) return;
  try {
    const { executeAsModal } = core;

    await executeAsModal(async () => {
      const editingState = await checkEditingState();
      if (!editingState.isValid) {
        return;
      }

      const { layer, isBackgroundLayer } = editingState;

      const selectionBounds = await getSelectionData();
      if (!selectionBounds) {
        await core.showAlert({ message: '获取文档信息失败' });
        return;
      }

      const panelState = await PanelStateManager.loadLatest();
      const gradient = (panelState?.appPanel as any)?.selectedGradient as Gradient | null;
      if (!gradient || !gradient.stops || gradient.stops.length === 0) {
        await core.showAlert({ message: '请先在主面板的渐变设置中选择一个渐变预设' });
        return;
      }

      await runWithTemporaryUnlock(async () => {
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);

        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }

        const processedPixels = await processBlockGradient(
          pixelResult.selectionPixelData.buffer,
          fullSelectionMask.buffer,
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          gradient,
          isBackgroundLayer
        );

        await applyProcessedPixels(processedPixels, pixelResult);
      });
    });
    giveFocusBackToPS();
  } catch (error) {
    const msg = typeof error === 'string' ? error : (error && (error.message || (error as any).toString?.() || '未知错误'));
    console.error('❌ 分块渐变处理失败:', error);
    await core.showAlert({ message: '分块渐变处理失败: ' + msg });
  }
};

// 线条处理功能
const handleLineEnhancement = async () => {
  if (!handleLicenseBeforeAction()) return;
  try {
    const { executeAsModal } = core;
    let selectionBounds: any = null;
    let pixelResult: any = null;
    let isBackgroundLayer = false;
    let abortedByBackgroundLayer = false;
    await executeAsModal(async () => {
      const editingState = await checkEditingState();
      if (!editingState.isValid) {
        return;
      }
      const { layer, isBackgroundLayer: bg } = editingState;
      isBackgroundLayer = bg;
      if (isBackgroundLayer) {
        abortedByBackgroundLayer = true;
        await core.showAlert({ message: '请选择不透明底的线稿图层！' });
        return;
      }
      selectionBounds = await getSelectionData();
      if (!selectionBounds) {
        await core.showAlert({ message: '获取文档信息失败' });
        return;
      }
      pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);
    });
    if (abortedByBackgroundLayer) {
      giveFocusBackToPS();
      return;
    }
    if (!selectionBounds || !pixelResult) {
      giveFocusBackToPS();
      return;
    }
    const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
    let maskIndex = 0;
    for (let docIndex of pixelResult.selectionIndices) {
      fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
      maskIndex++;
    }
    const processedPixels = await processLineEnhancement(
      pixelResult.selectionPixelData.buffer,
      fullSelectionMask.buffer,
      { width: selectionBounds.docWidth, height: selectionBounds.docHeight }
    );
    await executeAsModal(async () => {
      await runWithTemporaryUnlock(async () => {
        await applyProcessedPixels(processedPixels, pixelResult);
      });
    });
    giveFocusBackToPS();
  } catch (error) {
    const msg = typeof error === 'string' ? error : (error && (error.message || (error as any).toString?.() || '未知错误'));
    console.error('❌ 线条增强处理失败:', error);
    await core.showAlert({ message: '线条增强处理失败: ' + msg });
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
      
      await runWithTemporaryUnlock(async () => {
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
    });
    giveFocusBackToPS();
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
      
      await runWithTemporaryUnlock(async () => {
        const isLineMode = edgeSmoothMode === 'line';
        const prePixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);
        
        // 创建完整文档尺寸的选区掩码数组
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of prePixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }

        let postPixelResult = prePixelResult;
        let baseAfterMedianBuffer: ArrayBuffer | undefined = undefined;
        if (isLineMode) {
          await action.batchPlay([
            {
              _obj: 'median',
              radius: { _unit: 'pixelsUnit', _value: edgeBackgroundSmoothRadius },
              _isCommand: false,
              _options: { dialogOptions: 'dontDisplay' }
            }
          ], { synchronousExecution: true });

          postPixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);
          baseAfterMedianBuffer = postPixelResult.fullPixelData.buffer;
        }
        
        // 步骤3：用智能边缘平滑算法处理像素数据
        // 注意：传递完整的像素数据而不是选区像素数据，因为算法需要邻域信息
        const processedPixels = await processSmartEdgeSmooth(
          prePixelResult.fullPixelData.buffer, 
          fullSelectionMask.buffer, 
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          {
            mode: isLineMode ? 'line' : 'edge',
            edgeMedianRadius: edgeMedianRadius,
            backgroundSmoothRadius: edgeBackgroundSmoothRadius,
            lineStrength: edgeLineStrength / 100,
            lineWidthScale: edgeLineWidthScale,
            lineHardness: edgeLineHardness / 100
          },
          isBackgroundLayer,
          isLineMode ? undefined : { documentID: app.activeDocument.id, layerID: layer.id },
          baseAfterMedianBuffer
        );
        
        console.log('✅ 智能边缘平滑处理完成，长度:', processedPixels.byteLength);
        
        // 步骤4：应用处理后的像素数据
        // 将ArrayBuffer转换为Uint8Array
        const processedPixelsArray = new Uint8Array(processedPixels);
        const coeffLen = postPixelResult.selectionBounds.selectionCoefficients?.length || 0;
        const selectionCoefficients = coeffLen > 0 ? new Float32Array(coeffLen) : new Float32Array(0);
        selectionCoefficients.fill(1);
        const resultForWriteback = {
          ...postPixelResult,
          selectionBounds: {
            ...postPixelResult.selectionBounds,
            selectionCoefficients
          }
        };
        await applyProcessedPixels(processedPixelsArray, resultForWriteback as any);
        
        console.log('✅ 智能边缘平滑处理完成');
      });
    });
    giveFocusBackToPS();
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
      
      await runWithTemporaryUnlock(async () => {
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
    });
    giveFocusBackToPS();
  } catch (error) {
    console.error('❌ 像素过渡处理失败:', error);
    await core.showAlert({ message: '像素过渡处理失败: ' + error.message });
  }
};

const handleGradientModify = async () => {
  if (!handleLicenseBeforeAction()) return;
  if (gradientRelaxStrength === 0) return;
  try {
    const { executeAsModal } = core;

    await executeAsModal(async () => {
      const editingState = await checkEditingState();
      if (!editingState.isValid) {
        return;
      }

      const { layer, isBackgroundLayer } = editingState;

      const selectionBounds = await getSelectionData();
      if (!selectionBounds) {
        await core.showAlert({ message: '请先创建选区' });
        return;
      }

      await runWithTemporaryUnlock(async () => {
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);

        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }

        const processedPixels = await processGradientRelax(
          pixelResult.selectionPixelData.buffer,
          fullSelectionMask.buffer,
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          { amount: gradientRelaxStrength },
          isBackgroundLayer
        );

        await applyProcessedPixels(processedPixels, pixelResult);
      });
    });
    giveFocusBackToPS();
  } catch (error) {
    console.error('❌ 梯度修改处理失败:', error);
    await core.showAlert({ message: '梯度修改处理失败: ' + error.message });
  }
};

const handleSpecialSharpen = async () => {
  if (!handleLicenseBeforeAction()) return;
  try {
    const { executeAsModal } = core;

    await executeAsModal(async () => {
      const editingState = await checkEditingState();
      if (!editingState.isValid) {
        return;
      }

      const { layer, isBackgroundLayer } = editingState;

      const selectionBounds = await getSelectionData();
      if (!selectionBounds) {
        await core.showAlert({ message: '请先创建选区' });
        return;
      }

      await runWithTemporaryUnlock(async () => {
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);

        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }

        const processedPixels = await processSpecialSharpen(
          pixelResult.selectionPixelData.buffer,
          fullSelectionMask.buffer,
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          { strength: specialSharpenStrength },
          isBackgroundLayer
        );

        await applyProcessedPixels(processedPixels, pixelResult);
      });
    });
    giveFocusBackToPS();
  } catch (error) {
    console.error('❌ 特殊锐化处理失败:', error);
    await core.showAlert({ message: '特殊锐化处理失败: ' + error.message });
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
    
    <button className="adjustment-button" onClick={handlePixelTransition} title={`● 特制类高斯模糊过渡滤镜，特点是屏蔽alpha为0的像素，从而更好保护形状。

● 半径决定参考范围大小；强度决定过渡幅度。

即：半径大→过渡范围更广；强度大→边缘更平滑。`}>像素过渡</button>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 控制处理时参考的邻域大小，单位 px。

● 半径越大，影响范围越宽，过渡更柔和但更慢。

示例：小图建议 5–10px；大图建议 10–20px。`}>半径</div>
        <div className="unit-container">
          <input type="range" min="5" max="20" step="1" value={radius} onChange={handleRadiusChange} className="adjustment-slider-input" />
          <input type="number" min="5" max="20" step="1" value={radius} onChange={handleRadiusNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">px</div>
        </div>
      </div>
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 控制过渡力度，单位级。

● 强度越高，对比被削弱越多，边缘更圆滑。

示例：轻微处理用 1–2 级；明显去锯齿用 3–5 级。`}>强度</div>
        <div className="unit-container">
          <input type="range" min="1" max="5" step="0.5" value={sigma} onChange={handleSigmaChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="5" step="0.5" value={sigma} onChange={handleSigmaNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>

    <button className="adjustment-button" onClick={handleGradientModify} title={`● 修改选区内的梯度形态：负值放缓（过渡更宽更柔），正值陡峭（过渡更窄更硬）。

● 同时作用于颜色与不透明度（alpha）的过渡。

● 计算时屏蔽选区外像素，避免透明外部拖低边缘导致露出选区边界。`}>梯度修改</button>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● -10 到 -1：放缓梯度（过渡更宽、更柔和）。

● 0：不做修改。

● 1 到 10：陡峭梯度（过渡更窄、更明显）。

提示：绝对值越大，影响越明显且更慢。`}>程度</div>
        <div className="unit-container">
          <input type="range" min="-10" max="10" step="1" value={gradientRelaxStrength} onChange={handleGradientRelaxStrengthChange} className="adjustment-slider-input" />
          <input type="number" min="-10" max="10" step="1" value={gradientRelaxStrength} onChange={handleGradientRelaxStrengthNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>

    <button className="adjustment-button" onClick={handleSpecialSharpen} title={`● 一种更“硬”的局部锐化方式，用于强化过渡边缘与对比。

● 仅对选区内生效，并尽量避免选区边界露出。

● 数值越大效果越强，也越慢。`}>特殊锐化</button>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 控制锐化强度，单位级。

● 建议 2–6 用于轻中度增强，7–10 用于强烈强化。`}>强度</div>
        <div className="unit-container">
          <input type="range" min="1" max="10" step="0.5" value={specialSharpenStrength} onChange={handleSpecialSharpenStrengthChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="10" step="0.5" value={specialSharpenStrength} onChange={handleSpecialSharpenStrengthNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>

    <button className="adjustment-button" onClick={handleHighFrequencyEnhancement} title={`● 提升细小纹理与微对比，使画面更清晰。

● 仅对选区内的高频细节生效，低频形状不被破坏。

● 强度决定增强幅度；范围决定纳入的细节尺度宽度。

示例：强度高→更锐利；范围大→兼顾更粗的纹理。`}>高频增强</button>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 控制细节增强强弱，单位级。

● 建议 1–4 用于精修，5–8 用于明显锐化。`}>强度</div>
        <div className="unit-container">
          <input type="range" min="1" max="10" step="0.5" value={highFreqIntensity} onChange={handleHighFreqIntensityChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="10" step="0.5" value={highFreqIntensity} onChange={handleHighFreqIntensityNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 控制被视为高频的细节宽度，单位级。

● 值小偏向极细纹理；值大兼顾较粗纹理。`}>范围</div>
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
    <button className="adjustment-button" onClick={handleSmartEdgeSmooth} title={`● 两种模式：色块边界的“中间值”平滑；或识别主线条后“抹平→拟合→回写”。

● 普通图层会对 RGBA 四通道处理；背景图层只处理 RGB。`}>边缘平滑</button>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 仅色块边界：对选区做“中间值”平滑，并在选区边缘做渐隐避免边界感。

● 仅主线条：先对选区做“中间值”抹除，再拟合主线条并写回。`}>平滑模式</div>
        <div className="unit-container">
          <select value={edgeSmoothMode} onChange={handleEdgeSmoothModeChange} className="adjustment-select">
            <option value="edge">仅色块边界</option>
            <option value="line">仅主线条</option>
          </select>
        </div>
      </div>

      {edgeSmoothMode === 'edge' && (
        <>
          <div className="adjustment-slider-item">
            <div className="wider-adjustment-slider-label" title={`● PS 自带“中间值”滤镜半径。半径越大，边缘越柔和但更慢。`}>中间值半径</div>
            <div className="unit-container">
              <input type="range" min="10" max="30" step="1" value={edgeMedianRadius} onChange={handleEdgeMedianRadiusChange} className="adjustment-slider-input" />
              <input type="number" min="10" max="30" step="1" value={edgeMedianRadius} onChange={handleEdgeMedianRadiusNumberChange} className="adjustment-number-input" />
              <div className="adjustment-unit">px</div>
            </div>
          </div>
        </>
      )}

      {edgeSmoothMode === 'line' && (
        <>
          <div className="adjustment-slider-item">
            <div className="wider-adjustment-slider-label" title={`● 主线条模式中的“抹除”使用 PS 自带“中间值”滤镜。半径越大越能清掉杂线与脏点，但整体会更软。`}>中间值半径</div>
            <div className="unit-container">
              <input type="range" min="10" max="30" step="1" value={edgeBackgroundSmoothRadius} onChange={handleEdgeBackgroundSmoothRadiusChange} className="adjustment-slider-input" />
              <input type="number" min="10" max="30" step="1" value={edgeBackgroundSmoothRadius} onChange={handleEdgeBackgroundSmoothRadiusNumberChange} className="adjustment-number-input" />
              <div className="adjustment-unit">px</div>
            </div>
          </div>

          <div className="adjustment-slider-item">
            <div className="wide-adjustment-slider-label" title={`● 主线条回写的不透明度倍率。越高线条越“压回去”。`}>线条力度</div>
            <div className="unit-container">
              <input type="range" min="0" max="100" step="1" value={edgeLineStrength} onChange={handleEdgeLineStrengthChange} className="adjustment-slider-input" />
              <input type="number" min="0" max="100" step="1" value={edgeLineStrength} onChange={handleEdgeLineStrengthNumberChange} className="adjustment-number-input" />
              <div className="adjustment-unit">%</div>
            </div>
          </div>

          <div className="adjustment-slider-item">
            <div className="wide-adjustment-slider-label" title={`● 主线条回写的粗细倍率。大于 1 会更粗，小于 1 会更细。`}>线条粗细</div>
            <div className="unit-container">
              <input type="range" min="0.5" max="2" step="0.05" value={edgeLineWidthScale} onChange={handleEdgeLineWidthScaleChange} className="adjustment-slider-input" />
              <input type="number" min="0.5" max="2" step="0.05" value={edgeLineWidthScale} onChange={handleEdgeLineWidthScaleNumberChange} className="adjustment-number-input" />
              <div className="adjustment-unit">x</div>
            </div>
          </div>

          <div className="adjustment-slider-item">
            <div className="wide-adjustment-slider-label" title={`● 主线条边缘硬度。越高越锐利，越低越柔。`}>线条硬度</div>
            <div className="unit-container">
              <input type="range" min="0" max="100" step="1" value={edgeLineHardness} onChange={handleEdgeLineHardnessChange} className="adjustment-slider-input" />
              <input type="number" min="0" max="100" step="1" value={edgeLineHardness} onChange={handleEdgeLineHardnessNumberChange} className="adjustment-number-input" />
              <div className="adjustment-unit">%</div>
            </div>
          </div>
        </>
      )}
    </div>

    <div className="adjustment-divider"></div>

    <button className="adjustment-button" onClick={handleLineEnhancement} title={`● 针对边缘线条的 Alpha 进行增强，使轮廓更清晰。

● 适合线稿、UI 描边、图标轮廓等。

● 无选区时默认对整幅图处理。`}>线条加黑</button>
  </div>
);

const renderBlockAdjustmentContent = () => (
  <div className="adjustment-section">

    <div className="adjustment-double-buttons">
      <button className="adjustment-button" onClick={handleBlockAverage} title={`● 按网格对选区分块做加权平均，降低噪点和斑驳。

● 加权模式让中心权重更高，保留主体轮廓。`}>分块平均</button>
      
      <div className="adjustment-swtich-container">
        <label 
          className="adjustment-swtich-label"
          onClick={() => setUseWeightedAverage(!useWeightedAverage)}
          style={{ cursor: 'pointer' }}
          title={`● 开启后中心像素影响更大，边缘影响更小，保留主体。`}
        >加权模式</label>
        <sp-switch 
          checked={useWeightedAverage}
          onChange={(e) => setUseWeightedAverage(e.target.checked)}
          style={{ marginLeft: '8px' }}
        />
      </div>
    </div>

    {useWeightedAverage && (
      <div className="adjustment-slider-container">
        <div className="adjustment-slider-item">
          <div className="adjustment-slider-label" title={`● 控制分块平滑力度，单位级。

● 值越大，纹理被弱化越多。

示例：照片降噪用 2–6；UI 底色统一用 6–10。`}>强度</div>
          <div className="unit-container">
            <input type="range" min="1" max="10" step="0.5" value={weightedIntensity} onChange={handleWeightedIntensityChange} className="adjustment-slider-input" />
            <input type="number" min="1" max="10" step="0.5" value={weightedIntensity} onChange={handleWeightedIntensityNumberChange} className="adjustment-number-input" />
            <div className="adjustment-unit">级</div>
          </div>
        </div>
      </div>
    )}

    <div className="adjustment-divider"></div>

    <button className="adjustment-button" onClick={handleBlockGradient} title={`● 对每个不相连选区（连通块）分别采样一次渐变颜色并填充。

● 渐变数据来自主面板“渐变设置”的最终预览（含角度与反向）。

● 每个连通块取形状质心，沿渐变方向投影后做归一化映射。`}>分块渐变</button>
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
  <div key={section.id} className="adjust-expand-section"
       draggable
       onDragStart={(e)=>handleDragStart(e, section.id)}
       onDragOver={handleDragOver}
       onDrop={(e)=>handleDrop(e, section.id)}
  >
    <div className="adjust-expand-header" onClick={()=>toggleSectionCollapse(section.id)}>
      <div className={`adjust-expand-icon ${section.isCollapsed ? '' : 'expanded'}`}>
        <ExpandIcon expanded={!section.isCollapsed} />
      </div>
      <div>{section.title}</div>
    </div>
    {!section.isCollapsed && (
      <div className="adjust-expand-content expanded">
        {renderSectionContent(section.id)}
      </div>
    )}
  </div>
);

return (
  <div className="adjustment-container" ref={rootRef}>
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
