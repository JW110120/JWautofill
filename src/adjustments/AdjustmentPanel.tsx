import React, { useState, useEffect, useRef } from 'react';
import { processBlockAverage } from './blockAverageProcessor';
import { processBlockGradient } from './blockGradientProcessor';
import { processBlockColorPatch } from './blockColorPatchProcessor';
import { processPixelTransition } from './pixelTransitionProcessor';
import { processPixelTransitionPowerful } from './powerfulTransitionProcessor';
import { processGradientRelax } from './gradientRelaxProcessor';
import { processSpecialSharpen } from './specialSharpenProcessor';
import { processSpecialWoodcut } from './specialWoodcutProcessor';
import { processLineEnhancement } from './lineProcessing';
import { processAlphaAlign } from './alphaAlignProcessor';
import { processHighFrequencyEnhancement } from './highFrequencyEnhancer';
import { processSmartEdgeSmooth, defaultSmartEdgeSmoothParams } from './smartEdgeSmoothProcessor';
import { checkEditingState, processPixelData, applyProcessedPixels, writeFullPixelsToLayer } from './pixelDataProcessor';
import { LicenseManager } from '../utils/LicenseManager';
import { action, app, core, imaging } from 'photoshop';
import type { Gradient } from '../types/state';
import './adjustment.css';
import './adjustment-input.css';
import { AdjustmentMenu } from '../utils/AdjustmentMenu';
import { ExpandIcon, AddIcon, DeleteIcon } from '../styles/Icons';
import { PanelStateManager } from '../utils/PanelStateManager';
import { maskSyncEngine, MASK_SYNC_CHANNEL_LABELS, LayerTreeEntry, MaskSyncTask, MaskSyncChannel } from '../utils/MaskSyncEngine';
import RangeSlider from '../components/RangeSlider';

// 单位换算为像素（兼容普通数字与带 _unit/_value 的单位对象）
const toPixels = (v: any, resolution: number) => {
  if (typeof v === 'number') return Math.round(v);
  const unit = v?._unit;
  const value = v?._value;
  if (typeof value !== 'number') return 0;
  if (typeof unit === 'string') {
    const u = unit.toLowerCase();
    if (u.includes('pixel')) return Math.round(value);
    if (u.includes('point') || u.includes('distance')) return Math.round(value * resolution / 72);
    if (u.includes('inch')) return Math.round(value * resolution);
    if (u.includes('cm')) return Math.round(value * resolution / 2.54);
    if (u.includes('mm')) return Math.round(value * resolution / 25.4);
  }
  return Math.round(value);
};

// 通过 batchPlay 全选当前文档（选区通道设为 allEnum）
const selectAllDocument = async () => {
  await action.batchPlay([
    {
      _obj: 'set',
      _target: [{ _ref: 'channel', _property: 'selection' }],
      to: { _enum: 'ordinal', _value: 'allEnum' },
      _options: { dialogOptions: 'dontDisplay' }
    }
  ], { synchronousExecution: true });
};

// 轻量获取文档与选区边界（不读取像素数据）。
// 当没有有效选区时，自动通过 batchPlay 全选整个文档（isFullDocument=true）。
const getSelectionBounds = async () => {
  try {
    const [docResult, selectionResult] = await Promise.all([
      action.batchPlay([
        {
          _obj: 'get',
          _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }]
        }
      ], { synchronousExecution: true }),
      action.batchPlay([
        {
          _obj: 'get',
          _target: [
            { _property: 'selection' },
            { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }
          ]
        }
      ], { synchronousExecution: true })
    ]);

    const resolution = Math.max(1, Math.round(docResult?.[0]?.resolution?._value ?? 72));
    const docWidth = toPixels(docResult?.[0]?.width, resolution);
    const docHeight = toPixels(docResult?.[0]?.height, resolution);

    // 稳健判断是否存在“有效选区”（面积 > 0），
    // 兼容 selection 为 undefined 或零面积（空对象/全 0 边界）等情况。
    const sel = selectionResult?.[0]?.selection;
    let hasSelection = false;
    let left = 0, top = 0, right = 0, bottom = 0;
    if (sel) {
      const l = toPixels(sel.left, resolution);
      const t = toPixels(sel.top, resolution);
      const r = toPixels(sel.right, resolution);
      const b = toPixels(sel.bottom, resolution);
      if (r > l && b > t) {
        hasSelection = true;
        left = l; top = t; right = r; bottom = b;
      }
    }

    let isFullDocument = false;
    if (!hasSelection) {
      // 没有选区：默认全选整个文档
      await selectAllDocument();
      left = 0; top = 0; right = docWidth; bottom = docHeight;
      isFullDocument = true;
    }

    return {
      hasSelection,
      isFullDocument,
      left, top, right, bottom,
      width: right - left,
      height: bottom - top,
      docWidth,
      docHeight
    };
  } catch (error) {
    console.error('获取选区边界失败:', error);
    return null;
  }
};

// 获取选区边界信息 + 选区像素数据（供分块平均/渐变等非分块算法使用）
const getSelectionData = async () => {
  try {
    const bounds = await getSelectionBounds();
    if (!bounds) return null;
    const { hasSelection, left, top, right, bottom, width, height, docWidth, docHeight } = bounds;

    let selectionSize, selectionValues, selectionCoefficients, selectionDocIndices;

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

      const selectionData = new Uint8Array(await pixels.imageData.getData());

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
            const docIndex = docY * docWidth + docX;

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
      // 没有选区（getSelectionBounds 已自动全选文档），创建全选的选区数据
      selectionSize = docWidth * docHeight;
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
      hasSelection,
      isFullDocument: bounds.isFullDocument,
      left,
      top,
      right,
      bottom,
      width,
      height,
      docWidth,  // 返回像素单位的文档宽度
      docHeight, // 返回像素单位的文档高度
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
  { id: 'edgeProcessing', title: '边缘处理', isCollapsed: false, isVisible: true, order: 2 },
  { id: 'maskSync', title: '蒙版同步', isCollapsed: false, isVisible: true, order: 3 }
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
const specialWoodcutPreviewTimerRef = useRef<any>(0);
const specialWoodcutApplyingRef = useRef(false);
// 标记面板是否已完成首次挂载，避免刚打开面板就自动执行一次预览写入
const specialWoodcutPreviewMountedRef = useRef(false);
// 预览基线：记录应用预览前图层的原始像素，用于在参数变化或关闭预览时还原
const specialWoodcutPreviewBaselineRef = useRef<{
  docId: number;
  layerId: number;
  layer: any;
  isBackgroundLayer: boolean;
  docWidth: number;
  docHeight: number;
  fullPixelData: Uint8Array;
} | null>(null);

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
const [usePowerfulMode, setUsePowerfulMode] = useState(false);
const [highFreqIntensity, setHighFreqIntensity] = useState(5);
const [highFreqRange, setHighFreqRange] = useState(3);

const [specialWoodcutLevels, setSpecialWoodcutLevels] = useState(4);
const [specialWoodcutEdgeThreshold, setSpecialWoodcutEdgeThreshold] = useState(32);
const [specialWoodcutEdgeStrength, setSpecialWoodcutEdgeStrength] = useState(60);
const [specialWoodcutPreview, setSpecialWoodcutPreview] = useState(true);

const [lineReferenceLayerId, setLineReferenceLayerId] = useState<number | null>(null);
const [lineReferenceLayerName, setLineReferenceLayerName] = useState<string>('');
const [lineReferenceOptions, setLineReferenceOptions] = useState<Array<{ value: string; label: string; disabled?: boolean }>>([]);
const lineReferenceSignatureRef = useRef<{ docId: number | null; hash: number }>({ docId: null, hash: 0 });
const lineReferenceSelectionRef = useRef<{ id: number | null; name: string }>({ id: null, name: '' });

// 智能边缘平滑参数
const [edgeSmoothMode, setEdgeSmoothMode] = useState((defaultSmartEdgeSmoothParams.mode as any) || 'edge');
const [edgeMedianRadius, setEdgeMedianRadius] = useState(defaultSmartEdgeSmoothParams.edgeMedianRadius ?? 16);
const [edgeBackgroundSmoothRadius, setEdgeBackgroundSmoothRadius] = useState(defaultSmartEdgeSmoothParams.backgroundSmoothRadius ?? 16);
const [edgeLineStrength, setEdgeLineStrength] = useState(Math.round((defaultSmartEdgeSmoothParams.lineSmoothStrength ?? defaultSmartEdgeSmoothParams.lineStrength ?? 1) * 100));
const [edgeLineSmoothRadius, setEdgeLineSmoothRadius] = useState(defaultSmartEdgeSmoothParams.lineSmoothRadius ?? 10);
const [edgeLinePreserveDetail, setEdgeLinePreserveDetail] = useState(Math.round((defaultSmartEdgeSmoothParams.linePreserveDetail ?? defaultSmartEdgeSmoothParams.lineHardness ?? 1) * 100));

// ===== 蒙版同步 =====
const [maskSyncTasks, setMaskSyncTasks] = useState<MaskSyncTask[]>([]);
const [maskSyncSampleOptions, setMaskSyncSampleOptions] = useState<LayerTreeEntry[]>([]);
const [maskSyncTargetOptions, setMaskSyncTargetOptions] = useState<LayerTreeEntry[]>([]);
const [maskSyncEditingId, setMaskSyncEditingId] = useState<string | null>(null);
const [maskSyncEditingName, setMaskSyncEditingName] = useState('');

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

useEffect(() => {
  refreshLineReferenceOptions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

useEffect(() => {
  lineReferenceSelectionRef.current = { id: lineReferenceLayerId, name: lineReferenceLayerName };
}, [lineReferenceLayerId, lineReferenceLayerName]);

useEffect(() => {
  let timer: any = 0;
  const scheduleRefresh = (docOverride?: any) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      refreshLineReferenceOptions(docOverride);
    }, 80);
  };
  const handleNotification = async (eventName?: any) => {
    try {
      const doc = app.activeDocument;
      const layers = doc?.layers || [];
      const docId = doc?.id ?? null;
      const hash = computeLayerSignature(layers);
      const prev = lineReferenceSignatureRef.current;
      const evt = typeof eventName === 'string' ? eventName : '';
      if (evt === 'make' || evt === 'delete') {
        scheduleRefresh(doc);
        return;
      }
      if (prev.docId !== docId || prev.hash !== hash) {
        scheduleRefresh(doc);
      }
    } catch {
      scheduleRefresh();
    }
  };
  action.addNotificationListener(['set', 'select', 'clearEvent', 'delete', 'make'], handleNotification);
  return () => {
    try {
      if (timer) clearTimeout(timer);
    } catch {}
    action.removeNotificationListener(['set', 'select', 'clearEvent', 'delete', 'make'], handleNotification);
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
          toggles: { useWeightedAverage, usePowerfulMode },
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
          if (typeof ap.toggles.usePowerfulMode === 'boolean') {
            setUsePowerfulMode(ap.toggles.usePowerfulMode);
          }
          if (typeof (ap.toggles as any).specialWoodcutPreview === 'boolean') {
            setSpecialWoodcutPreview((ap.toggles as any).specialWoodcutPreview);
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
          if (typeof (ap.values as any).specialWoodcutLevels === 'number') setSpecialWoodcutLevels(Math.max(2, Math.min(16, Math.round((ap.values as any).specialWoodcutLevels))));
          if (typeof (ap.values as any).specialWoodcutEdgeThreshold === 'number') setSpecialWoodcutEdgeThreshold(Math.max(0, Math.min(255, Math.round((ap.values as any).specialWoodcutEdgeThreshold))));
          if (typeof (ap.values as any).specialWoodcutEdgeStrength === 'number') setSpecialWoodcutEdgeStrength(Math.max(0, Math.min(100, Math.round((ap.values as any).specialWoodcutEdgeStrength))));
          if (typeof ap.values.lineReferenceLayerId === 'number') setLineReferenceLayerId(ap.values.lineReferenceLayerId);
          if (typeof ap.values.lineReferenceLayerName === 'string') setLineReferenceLayerName(ap.values.lineReferenceLayerName);
          if (typeof ap.values.edgeSmoothMode === 'string') setEdgeSmoothMode(ap.values.edgeSmoothMode === 'line' ? 'line' : 'edge');
          if (typeof ap.values.edgeMedianRadius === 'number') setEdgeMedianRadius(Math.max(10, Math.min(30, Math.round(ap.values.edgeMedianRadius))));
          if (typeof ap.values.edgeBackgroundSmoothRadius === 'number') setEdgeBackgroundSmoothRadius(Math.max(10, Math.min(30, Math.round(ap.values.edgeBackgroundSmoothRadius))));
          if (typeof ap.values.edgeLineStrength === 'number') setEdgeLineStrength(ap.values.edgeLineStrength);
          if (typeof ap.values.edgeLineSmoothRadius === 'number') setEdgeLineSmoothRadius(Math.max(3, Math.min(12, Math.round(ap.values.edgeLineSmoothRadius))));
          else if (typeof ap.values.edgeLineWidthScale === 'number') setEdgeLineSmoothRadius(Math.max(3, Math.min(12, Math.round(ap.values.edgeLineWidthScale * 8))));
          if (typeof ap.values.edgeLinePreserveDetail === 'number') setEdgeLinePreserveDetail(Math.max(0, Math.min(100, Math.round(ap.values.edgeLinePreserveDetail))));
          else if (typeof ap.values.edgeLineHardness === 'number') setEdgeLinePreserveDetail(Math.max(0, Math.min(100, Math.round(ap.values.edgeLineHardness))));
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
      toggles: { useWeightedAverage, usePowerfulMode, specialWoodcutPreview },
      values: {
        radius,
        sigma,
        specialSharpenStrength,
        gradientRelaxStrength,
        gradientModifySigned: true,
        weightedIntensity,
        highFreqIntensity,
        highFreqRange,
        specialWoodcutLevels,
        specialWoodcutEdgeThreshold,
        specialWoodcutEdgeStrength,
        lineReferenceLayerId,
        lineReferenceLayerName,
        edgeSmoothMode,
        edgeMedianRadius,
        edgeBackgroundSmoothRadius,
        edgeLineStrength,
        edgeLineSmoothRadius,
        edgeLinePreserveDetail,
      },
    },
  }, { debounceMs: 400 }).catch(e => console.warn('⚠️ 保存像素调整面板状态失败:', e));
}, [
  panelStateLoaded,
  sections,
  subFeatures,
  useWeightedAverage,
  usePowerfulMode,
  specialWoodcutPreview,
  radius,
  sigma,
  specialSharpenStrength,
  gradientRelaxStrength,
  weightedIntensity,
  highFreqIntensity,
  highFreqRange,
  specialWoodcutLevels,
  specialWoodcutEdgeThreshold,
  specialWoodcutEdgeStrength,
  lineReferenceLayerId,
  lineReferenceLayerName,
  edgeSmoothMode,
  edgeMedianRadius,
  edgeBackgroundSmoothRadius,
  edgeLineStrength,
  edgeLineSmoothRadius,
  edgeLinePreserveDetail,
]);

useEffect(() => {
  try {
    if (!specialWoodcutPreview) {
      if (specialWoodcutPreviewTimerRef.current) {
        clearTimeout(specialWoodcutPreviewTimerRef.current);
      }
      specialWoodcutPreviewTimerRef.current = 0;
      // 关闭预览时，若存在预览基线则还原原始像素
      if (specialWoodcutPreviewBaselineRef.current) {
        const { executeAsModal } = core;
        executeAsModal(async () => {
          try {
            await restoreSpecialWoodcutBaseline();
          } catch (e) {
            console.warn('⚠️ 还原特殊木刻预览失败:', e);
          }
        }).catch(() => {});
      }
      return;
    }
    if (specialWoodcutPreviewTimerRef.current) {
      clearTimeout(specialWoodcutPreviewTimerRef.current);
    }
    // 首次挂载时不自动预览，仅在用户实际调整参数后才触发
    if (!specialWoodcutPreviewMountedRef.current) {
      specialWoodcutPreviewMountedRef.current = true;
      return;
    }
    specialWoodcutPreviewTimerRef.current = setTimeout(() => {
      handleSpecialWoodcut(true);
    }, 300);
    return () => {
      if (specialWoodcutPreviewTimerRef.current) {
        clearTimeout(specialWoodcutPreviewTimerRef.current);
      }
      specialWoodcutPreviewTimerRef.current = 0;
    };
  } catch {
    return;
  }
}, [specialWoodcutPreview, specialWoodcutLevels, specialWoodcutEdgeThreshold, specialWoodcutEdgeStrength]);

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
      setSpecialWoodcutLevels(4);
      setSpecialWoodcutEdgeThreshold(32);
      setSpecialWoodcutEdgeStrength(60);
      setSpecialWoodcutPreview(true);
      setLineReferenceLayerId(null);
      setLineReferenceLayerName('');
      // 3) 智能边缘平滑参数复位
      setEdgeSmoothMode((defaultSmartEdgeSmoothParams.mode as any) || 'edge');
      setEdgeMedianRadius(defaultSmartEdgeSmoothParams.edgeMedianRadius ?? 20);
      setEdgeBackgroundSmoothRadius(defaultSmartEdgeSmoothParams.backgroundSmoothRadius ?? 16);
      setEdgeLineStrength(Math.round((defaultSmartEdgeSmoothParams.lineSmoothStrength ?? defaultSmartEdgeSmoothParams.lineStrength ?? 1) * 100));
      setEdgeLineSmoothRadius(defaultSmartEdgeSmoothParams.lineSmoothRadius ?? 10);
      setEdgeLinePreserveDetail(Math.round((defaultSmartEdgeSmoothParams.linePreserveDetail ?? defaultSmartEdgeSmoothParams.lineHardness ?? 1) * 100));
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

// ================= 蒙版同步：初始化与监听 =================
const refreshMaskSyncOptions = async () => {
  try {
    const tree = await maskSyncEngine.buildLayerTree();
    setMaskSyncSampleOptions(tree);
    setMaskSyncTargetOptions(tree.filter(t => t.hasUserMask));
  } catch (e) {
    console.warn('⚠️ 刷新蒙版同步文件树失败:', e);
  }
};

useEffect(() => {
  let unsub: (() => void) | undefined;
  let cancelled = false;
  const boot = async () => {
    await maskSyncEngine.init();
    if (cancelled) return;
    unsub = maskSyncEngine.subscribe((info) => {
      setMaskSyncTasks(maskSyncEngine.getTasks());
      // 文档切换/重开：刷新文件树下拉，并按名称路径重解析失效的图层引用
      if (info.docChanged) {
        refreshMaskSyncOptions();
        maskSyncEngine.reconcileTasks().then(changed => {
          if (changed) setMaskSyncTasks(maskSyncEngine.getTasks());
        });
      }
    });
    refreshMaskSyncOptions();
    setMaskSyncTasks(maskSyncEngine.getTasks());
    // 首次挂载/插件重载：任务引用可能是旧会话的 layerId，按路径重解析一次
    maskSyncEngine.reconcileTasks().then(changed => {
      if (changed) setMaskSyncTasks(maskSyncEngine.getTasks());
    });
  };
  boot();
  return () => {
    cancelled = true;
    if (unsub) unsub();
    maskSyncEngine.dispose();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// 图层结构变化（新建/删除/重命名图层）时刷新文件树下拉，并重解析失效引用
useEffect(() => {
  let timer: any = 0;
  const scheduleRefresh = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      refreshMaskSyncOptions();
      maskSyncEngine.reconcileTasks().then(changed => {
        if (changed) setMaskSyncTasks(maskSyncEngine.getTasks());
      });
    }, 120);
  };
  const handleMaskSyncNotif = (eventName?: any) => {
    const evt = typeof eventName === 'string' ? eventName : '';
    if (evt === 'make' || evt === 'delete') {
      scheduleRefresh();
    }
  };
  try {
    action.addNotificationListener(['make', 'delete'], handleMaskSyncNotif);
  } catch {}
  return () => {
    try {
      if (timer) clearTimeout(timer);
      action.removeNotificationListener(['make', 'delete'], handleMaskSyncNotif);
    } catch {}
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// 蒙版同步任务操作
const handleMaskSyncAdd = async () => {
  try {
    await maskSyncEngine.addTask();
  } catch (e) {
    console.warn('⚠️ 新建同步任务失败:', e);
  }
};

const handleMaskSyncRemove = async (id: string) => {
  try {
    await maskSyncEngine.removeTask(id);
    if (maskSyncEditingId === id) setMaskSyncEditingId(null);
  } catch (e) {
    console.warn('⚠️ 删除同步任务失败:', e);
  }
};

const patchMaskSyncTask = async (task: MaskSyncTask, patch: Partial<MaskSyncTask>) => {
  const next = { ...task, ...patch };
  setMaskSyncTasks(prev => prev.map(t => (t.id === task.id ? next : t)));
  try {
    await maskSyncEngine.updateTask(next);
  } catch (e) {
    console.warn('⚠️ 更新同步任务失败:', e);
  }
};

const handleMaskSyncSampleChange = async (task: MaskSyncTask, value: string) => {
  const id = parseInt(value, 10);
  if (!Number.isFinite(id)) return;
  const hit = maskSyncSampleOptions.find(o => o.id === id);
  if (!hit || hit.kind !== 'pixel') return;
  await patchMaskSyncTask(task, { sampleLayerId: hit.id, sampleLayerPath: hit.path, sampleLayerName: hit.name });
};

const handleMaskSyncChannelChange = async (task: MaskSyncTask, value: string) => {
  const channel = value as MaskSyncChannel;
  if (!MASK_SYNC_CHANNEL_LABELS[channel]) return;
  await patchMaskSyncTask(task, { channel });
};

const handleMaskSyncInvertChange = async (task: MaskSyncTask, checked: boolean) => {
  await patchMaskSyncTask(task, { invert: checked });
};

const handleMaskSyncTargetChange = async (task: MaskSyncTask, value: string) => {
  const id = parseInt(value, 10);
  if (!Number.isFinite(id)) return;
  const hit = maskSyncTargetOptions.find(o => o.id === id && o.hasUserMask);
  if (!hit) return;
  await patchMaskSyncTask(task, { targetLayerId: hit.id, targetLayerPath: hit.path, targetLayerName: hit.name });
};

const handleMaskSyncEnabledChange = async (task: MaskSyncTask, checked: boolean) => {
  await patchMaskSyncTask(task, { enabled: checked });
};

const startMaskSyncRename = (task: MaskSyncTask) => {
  setMaskSyncEditingId(task.id);
  setMaskSyncEditingName(task.name);
};

const commitMaskSyncRename = async () => {
  const id = maskSyncEditingId;
  if (!id) return;
  const name = maskSyncEditingName.trim() || '';
  setMaskSyncEditingId(null);
  if (!name) return;
  const task = maskSyncTasks.find(t => t.id === id);
  if (!task || task.name === name) return;
  await patchMaskSyncTask(task, { name });
};

// 拦截滚轮，避免滚轮穿透到 Photoshop 活动文档，改为滚动本面板
useEffect(() => {
  const el = rootRef.current ?? document.getElementById('pixeladjustment');
  if (!el) return;

  const onWheel = (e: WheelEvent) => {
    const target = e.target as Node;
    if (!el.contains(target)) return;
    // 仅当本面板确实存在上下溢出时拦截，否则保持默认行为
    if (el.scrollHeight <= el.clientHeight) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = typeof e.deltaY === 'number' ? e.deltaY : (-(e as any).wheelDelta || 0);
    el.scrollTop += delta;
  };

  el.addEventListener('wheel', onWheel, { capture: true, passive: false } as any);
  return () => el.removeEventListener('wheel', onWheel, { capture: true } as any);
}, []);

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





// 滑块变化处理（RangeSlider 直接传入数值）
const handleRadiusChange = (value: number) => {
  setRadius(value);
};

const handleSigmaChange = (value: number) => {
  setSigma(value);
};

const handleSpecialSharpenStrengthChange = (value: number) => {
  setSpecialSharpenStrength(value);
};

const handleGradientRelaxStrengthChange = (value: number) => {
  setGradientRelaxStrength(value);
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
const handleWeightedIntensityChange = (value: number) => {
  setWeightedIntensity(value);
};

const handleWeightedIntensityNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseFloat(event.target.value);
  if (!isNaN(value) && value >= 1 && value <= 10) {
    setWeightedIntensity(value);
  }
};

// 高频增强强度滑块处理
const handleHighFreqIntensityChange = (value: number) => {
  setHighFreqIntensity(value);
};

const handleHighFreqIntensityNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseFloat(event.target.value);
  if (!isNaN(value) && value >= 1 && value <= 10) {
    setHighFreqIntensity(value);
  }
};

// 高频范围滑块处理
const handleHighFreqRangeChange = (value: number) => {
  setHighFreqRange(value);
};

const handleHighFreqRangeNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseFloat(event.target.value);
  if (!isNaN(value) && value >= 1 && value <= 10) {
    setHighFreqRange(value);
  }
};

const handleSpecialWoodcutLevelsChange = (value: number) => {
  setSpecialWoodcutLevels(value);
};

const handleSpecialWoodcutLevelsNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 2 && value <= 16) {
    setSpecialWoodcutLevels(value);
  }
};

const handleSpecialWoodcutEdgeThresholdChange = (value: number) => {
  setSpecialWoodcutEdgeThreshold(value);
};

const handleSpecialWoodcutEdgeThresholdNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 0 && value <= 255) {
    setSpecialWoodcutEdgeThreshold(value);
  }
};

const handleSpecialWoodcutEdgeStrengthChange = (value: number) => {
  setSpecialWoodcutEdgeStrength(value);
};

const handleSpecialWoodcutEdgeStrengthNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 0 && value <= 100) {
    setSpecialWoodcutEdgeStrength(value);
  }
};

const resetSpecialWoodcutParams = () => {
  setSpecialWoodcutLevels(4);
  setSpecialWoodcutEdgeThreshold(32);
  setSpecialWoodcutEdgeStrength(60);
  setSpecialWoodcutPreview(true);
};

const flattenLayers = (layers: any[], out: any[] = []) => {
  for (const layer of layers || []) {
    out.push(layer);
    const children = (layer as any)?.layers;
    if (children && Array.isArray(children) && children.length > 0) {
      flattenLayers(children, out);
    }
  }
  return out;
};

const findLayerById = (layers: any[], id: number): any | null => {
  const stack = [...(layers || [])];
  while (stack.length) {
    const layer = stack.pop();
    if (!layer) continue;
    if (layer.id === id) return layer;
    const children = (layer as any)?.layers;
    if (children && Array.isArray(children) && children.length > 0) {
      for (let i = 0; i < children.length; i++) stack.push(children[i]);
    }
  }
  return null;
};

const computeLayerSignature = (layers: any[]): number => {
  let h = 2166136261 >>> 0;
  const stack = [...(layers || [])];
  while (stack.length) {
    const layer = stack.pop();
    if (!layer) continue;
    const id = layer.id || 0;
    const kind = layer.kind === 'pixel' ? 1 : (layer.kind === 'group' ? 2 : 3);
    h = Math.imul(h ^ id, 16777619) >>> 0;
    h = Math.imul(h ^ kind, 16777619) >>> 0;
    const name = layer.name || '';
    for (let i = 0; i < name.length; i++) {
      h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
    }
    const children = (layer as any)?.layers;
    if (children && Array.isArray(children) && children.length > 0) {
      for (let i = 0; i < children.length; i++) stack.push(children[i]);
    }
  }
  return h >>> 0;
};

const buildLineReferenceOptions = (layers: any[], depth: number, out: Array<{ value: string; label: string; disabled?: boolean }>) => {
  for (const layer of layers || []) {
    if (!layer) continue;
    const children = (layer as any)?.layers;
    const hasChildren = !!(children && Array.isArray(children) && children.length > 0);
    const indent = depth > 0 ? ('　'.repeat(Math.min(6, depth)) + '└ ') : '';
    const kind = (layer as any)?.kind;
    const isPixel = kind === 'pixel';
    const labelSuffix = hasChildren ? '（组）' : (isPixel ? '（像素）' : '（不可用）');
    out.push({
      value: String(layer.id),
      label: `${indent}${layer.name || `图层 ${layer.id}`}${labelSuffix}`,
      disabled: !isPixel
    });
    if (hasChildren) buildLineReferenceOptions(children, depth + 1, out);
  }
};

const refreshLineReferenceOptions = (docOverride?: any) => {
  try {
    const doc = docOverride || app.activeDocument;
    const layers = doc?.layers || [];
    const out: Array<{ value: string; label: string; disabled?: boolean }> = [];
    buildLineReferenceOptions(layers, 0, out);
    setLineReferenceOptions(out);
    const docId = doc?.id ?? null;
    lineReferenceSignatureRef.current = { docId, hash: computeLayerSignature(layers) };
    const sel = lineReferenceSelectionRef.current;
    if (typeof sel.id === 'number') {
      const layer = findLayerById(layers, sel.id);
      if (!layer || layer.kind !== 'pixel') {
        setLineReferenceLayerId(null);
        setLineReferenceLayerName('');
      } else if ((layer.name || '') !== sel.name) {
        setLineReferenceLayerName(layer.name || '');
      }
    }
  } catch (e) {
    setLineReferenceOptions([]);
  }
};

const getAutoLineReferenceLayer = (doc: any, activeLayerId: number): any | null => {
  const flat = flattenLayers(doc.layers || []);
  const idx = flat.findIndex(l => l && l.id === activeLayerId);
  const isUsable = (l: any) => !!l && l.kind === 'pixel';
  if (idx >= 0) {
    for (let i = idx - 1; i >= 0; i--) {
      const l = flat[i];
      if (isUsable(l)) return l;
    }
    for (let i = idx + 1; i < flat.length; i++) {
      const l = flat[i];
      if (isUsable(l)) return l;
    }
  }
  for (let i = 0; i < flat.length; i++) {
    const l = flat[i];
    if (isUsable(l)) return l;
  }
  return null;
};

const handleLineReferenceLayerChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
  const value = event.target.value;
  if (value === 'auto') {
    setLineReferenceLayerId(null);
    setLineReferenceLayerName('');
    return;
  }
  const id = parseInt(value, 10);
  if (!Number.isFinite(id)) {
    setLineReferenceLayerId(null);
    setLineReferenceLayerName('');
    return;
  }
  const doc = app.activeDocument;
  const layer = findLayerById(doc?.layers || [], id);
  if (!layer || layer.kind !== 'pixel') {
    try { await core.showAlert({ message: '该图层不可作为线稿参考层，请选择像素图层' }); } catch {}
    setLineReferenceLayerId(null);
    setLineReferenceLayerName('');
    return;
  }
  setLineReferenceLayerId(id);
  setLineReferenceLayerName(layer.name || '');
};

const handleEdgeSmoothModeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
  setEdgeSmoothMode(event.target.value);
};

const handleEdgeMedianRadiusChange = (value: number) => {
  setEdgeMedianRadius(value);
};

const handleEdgeMedianRadiusNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 10 && value <= 30) {
    setEdgeMedianRadius(value);
  }
};

const handleEdgeBackgroundSmoothRadiusChange = (value: number) => {
  setEdgeBackgroundSmoothRadius(value);
};

const handleEdgeBackgroundSmoothRadiusNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 10 && value <= 30) {
    setEdgeBackgroundSmoothRadius(value);
  }
};

const handleEdgeLineStrengthChange = (value: number) => {
  setEdgeLineStrength(value);
};

const handleEdgeLineStrengthNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 0 && value <= 100) {
    setEdgeLineStrength(value);
  }
};

const handleEdgeLineSmoothRadiusChange = (value: number) => {
  setEdgeLineSmoothRadius(value);
};

const handleEdgeLineSmoothRadiusNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 3 && value <= 12) {
    setEdgeLineSmoothRadius(value);
  }
};

const handleEdgeLinePreserveDetailChange = (value: number) => {
  setEdgeLinePreserveDetail(value);
};

const handleEdgeLinePreserveDetailNumberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = parseInt(event.target.value, 10);
  if (!isNaN(value) && value >= 0 && value <= 100) {
    setEdgeLinePreserveDetail(value);
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

const handleBlockColorPatch = async () => {
  if (!handleLicenseBeforeAction()) return;
  try {
    const { executeAsModal } = core;

    await executeAsModal(async () => {
      const editingState = await checkEditingState();
      if (!editingState.isValid) {
        return;
      }

      const { layer, isBackgroundLayer } = editingState;
      const initialSelectionBounds = await getSelectionData();
      if (!initialSelectionBounds) {
        await core.showAlert({ message: '获取文档信息失败' });
        return;
      }

      const doc = app.activeDocument;
      const activeLayerId = layer.id;

      let refLayer: any | null = null;
      if (typeof lineReferenceLayerId === 'number') {
        refLayer = findLayerById(doc.layers || [], lineReferenceLayerId);
      }
      if (!refLayer || refLayer.kind !== 'pixel') {
        refLayer = getAutoLineReferenceLayer(doc, activeLayerId);
      }
      if (!refLayer || refLayer.kind !== 'pixel') {
        await core.showAlert({ message: '未找到可用的线稿参考层，请在“线稿参考”下拉中选择线稿图层' });
        return;
      }

      const docW = initialSelectionBounds.docWidth;
      const docH = initialSelectionBounds.docHeight;

      await runWithTemporaryUnlock(async () => {
        const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : (v > hi ? hi : v));
        const estimateMaskHalfWidth = (mask: Uint8Array, w: number, h: number, cap: number) => {
          const size = w * h;
          if (size <= 0) return 1;
          const dist = new Uint8Array(size);
          dist.fill(255);
          const q = new Uint32Array(size);
          let head = 0;
          let tail = 0;
          for (let i = 0; i < size; i++) {
            if (!mask[i]) {
              dist[i] = 0;
              q[tail++] = i;
            }
          }
          if (tail === 0) return clampInt(cap, 1, cap);
          while (head < tail) {
            const i = q[head++] as number;
            const d = dist[i] as number;
            if (d >= cap) continue;
            const x = i % w;
            const y = (i - x) / w;
            const nd = (d + 1) as any;
            const push = (ni: number) => {
              if ((dist[ni] as number) <= nd) return;
              dist[ni] = nd;
              q[tail++] = ni;
            };
            if (x > 0) push(i - 1);
            if (x + 1 < w) push(i + 1);
            if (y > 0) push(i - w);
            if (y + 1 < h) push(i + w);
          }
          let maxD = 1;
          for (let i = 0; i < size; i++) {
            if (!mask[i]) continue;
            const d = dist[i] as number;
            if (d !== 255 && d > maxD) maxD = d;
          }
          return clampInt(maxD, 1, cap);
        };
        const luminance8 = (r: number, g: number, b: number) => ((r * 54 + g * 183 + b * 19) / 256) | 0;

        const pixelCount = docW * docH;
        const computeLineWidthPxFromRef = async (targetPixelBudget: number) => {
          const step = clampInt(Math.ceil(Math.sqrt(Math.max(1, pixelCount) / Math.max(1, targetPixelBudget))), 1, 64);
          const rw = Math.max(1, Math.ceil(docW / step));
          const rh = Math.max(1, Math.ceil(docH / step));
          const reducedCount = rw * rh;

          const refPixels = await imaging.getPixels({
            documentID: doc.id,
            layerID: refLayer.id,
            sourceBounds: { left: 0, top: 0, right: docW, bottom: docH },
            targetSize: { width: rw, height: rh }
          });
          const refRaw = new Uint8Array(await refPixels.imageData.getData());
          refPixels.imageData.dispose();

          const bpp = reducedCount > 0 ? refRaw.length / reducedCount : 0;
          const lineMask = new Uint8Array(reducedCount);
          let visible = 0;
          if (bpp === 4) {
            const alphaHist = new Uint32Array(256);
            let nonZeroAlpha = 0;
            for (let i = 0; i < reducedCount; i++) {
              const a = refRaw[i * 4 + 3] || 0;
              if (a <= 0) continue;
              alphaHist[a] += 1;
              nonZeroAlpha++;
            }
            let alphaP90 = 0;
            let alphaP98 = 0;
            if (nonZeroAlpha > 0) {
              const target90 = Math.max(1, Math.floor(nonZeroAlpha * 0.9));
              const target98 = Math.max(1, Math.floor(nonZeroAlpha * 0.98));
              let acc = 0;
              for (let a = 0; a < 256; a++) {
                acc += alphaHist[a] || 0;
                if (!alphaP90 && acc >= target90) alphaP90 = a;
                if (!alphaP98 && acc >= target98) {
                  alphaP98 = a;
                  break;
                }
              }
            }
            const alphaThreshold = clampInt(Math.round((alphaP98 || alphaP90 || 0) * 0.85), 8, 245);
            for (let i = 0; i < reducedCount; i++) {
              const a = refRaw[i * 4 + 3] || 0;
              if (a >= alphaThreshold) {
                lineMask[i] = 1;
                visible++;
              }
            }
          } else if (bpp === 3) {
            for (let i = 0; i < reducedCount; i++) {
              const p = i * 3;
              const y = luminance8(refRaw[p] || 0, refRaw[p + 1] || 0, refRaw[p + 2] || 0);
              if (y < 190) {
                lineMask[i] = 1;
                visible++;
              }
            }
          } else {
            return 0;
          }

          const visibleRatio = reducedCount > 0 ? visible / reducedCount : 0;
          if (visibleRatio < 0.00005 || visibleRatio > 0.995) return 0;

          const halfW = estimateMaskHalfWidth(lineMask, rw, rh, 10);
          const scaleMin = Math.max(1, Math.min(docW / rw, docH / rh));
          let widthPx = 0;
          if (halfW <= 1) widthPx = 2;
          else widthPx = Math.max(2, Math.round(halfW * 2 * scaleMin));
          return clampInt(widthPx, 2, 32);
        };

        const wCoarse = await computeLineWidthPxFromRef(220_000);
        const wFine = await computeLineWidthPxFromRef(900_000);
        let estimatedLineWidthPx = Math.min(wCoarse || 32, wFine || 32);
        if (estimatedLineWidthPx <= 0 || estimatedLineWidthPx >= 32) {
          estimatedLineWidthPx = 4;
        }

        let borderWidth = 0;
        if (estimatedLineWidthPx <= 3) borderWidth = 1;
        else if (estimatedLineWidthPx <= 5) borderWidth = 1;
        else if (estimatedLineWidthPx <= 8) borderWidth = 1;
        else if (estimatedLineWidthPx <= 12) borderWidth = 2;
        else borderWidth = 3;
        borderWidth = clampInt(borderWidth, 2, 8);
        const maxDistance = clampInt(borderWidth + 2, 4, 24);

        const selectionBounds: any = initialSelectionBounds;
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);

        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }

        const processedPixels = await processBlockColorPatch(
          pixelResult.fullPixelData.buffer,
          fullSelectionMask.buffer,
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          { borderWidth, maxDistance }
        );

        const processedPixelsArray = processedPixels instanceof Uint8Array ? processedPixels : new Uint8Array(processedPixels as any);
        const coeffLen = pixelResult.selectionBounds.selectionCoefficients?.length || 0;
        const selectionCoefficients = coeffLen > 0 ? new Float32Array(coeffLen) : new Float32Array(0);
        selectionCoefficients.fill(1);
        const resultForWriteback = {
          ...pixelResult,
          selectionBounds: {
            ...pixelResult.selectionBounds,
            selectionCoefficients
          }
        };
        await applyProcessedPixels(processedPixelsArray, resultForWriteback as any);

      });
    });
    giveFocusBackToPS();
  } catch (error) {
    const msg = typeof error === 'string' ? error : (error && (error.message || (error as any).toString?.() || '未知错误'));
    console.error('❌ 分块补色失败:', error);
    await core.showAlert({ message: '分块补色失败: ' + msg });
  }
};

// 还原特殊木刻预览：把保存的原始像素写回图层，并清除基线
const restoreSpecialWoodcutBaseline = async () => {
  const baseline = specialWoodcutPreviewBaselineRef.current;
  if (!baseline) return;
  // 若文档或图层已变化，无法安全还原，直接丢弃基线
  try {
    const doc = app.activeDocument;
    const activeLayer = doc?.activeLayers?.[0];
    if (!doc || !activeLayer || doc.id !== baseline.docId || activeLayer.id !== baseline.layerId) {
      specialWoodcutPreviewBaselineRef.current = null;
      return;
    }
  } catch {
    specialWoodcutPreviewBaselineRef.current = null;
    return;
  }
  await writeFullPixelsToLayer(
    baseline.fullPixelData,
    baseline.layer,
    baseline.docWidth,
    baseline.docHeight,
    baseline.isBackgroundLayer
  );
  specialWoodcutPreviewBaselineRef.current = null;
};

const handleSpecialWoodcut = async (isPreview: boolean = false) => {
  if (!handleLicenseBeforeAction()) return;
  if (specialWoodcutApplyingRef.current) return;
  specialWoodcutApplyingRef.current = true;
  try {
    const { executeAsModal } = core;

    await executeAsModal(async () => {
      const editingState = await checkEditingState();
      if (!editingState.isValid) {
        return;
      }

      const { layer, isBackgroundLayer } = editingState;

      const lockState = await getCurrentLayerLockState();
      const hadLock = !!(lockState.protectAll || lockState.protectComposite || lockState.protectPosition || lockState.protectTransparency);
      if (hadLock) {
        if (!isPreview) {
          await core.showAlert({ message: '当前图层处于锁定状态（像素锁/透明像素锁等），请先解除锁定后再使用“特殊木刻”。' });
        }
        return;
      }

      // 若存在上一次预览的基线，先还原原始像素，避免在预览结果上重复叠加
      if (specialWoodcutPreviewBaselineRef.current) {
        await restoreSpecialWoodcutBaseline();
      }

      const selectionBounds = await getSelectionData();
      if (!selectionBounds) {
        if (!isPreview) {
          await core.showAlert({ message: '获取文档信息失败' });
        }
        return;
      }

      const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);

      // 预览首次：在写回前保存原始像素作为基线，便于后续还原
      if (isPreview && !specialWoodcutPreviewBaselineRef.current) {
        specialWoodcutPreviewBaselineRef.current = {
          docId: app.activeDocument.id,
          layerId: layer.id,
          layer,
          isBackgroundLayer,
          docWidth: selectionBounds.docWidth,
          docHeight: selectionBounds.docHeight,
          fullPixelData: new Uint8Array(pixelResult.fullPixelData)
        };
      }

      const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
      let maskIndex = 0;
      for (let docIndex of pixelResult.selectionIndices) {
        fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
        maskIndex++;
      }

      const processedPixels = await processSpecialWoodcut(
        pixelResult.selectionPixelData.buffer,
        fullSelectionMask.buffer,
        { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
        {
          levels: specialWoodcutLevels,
          edgeThreshold: specialWoodcutEdgeThreshold,
          edgeStrength: specialWoodcutEdgeStrength
        },
        isBackgroundLayer
      );

      await applyProcessedPixels(processedPixels, pixelResult);
    });
    if (!isPreview) {
      // 正式应用：清除预览基线，提交当前结果
      specialWoodcutPreviewBaselineRef.current = null;
      giveFocusBackToPS();
    }
  } catch (error) {
    const msg = typeof error === 'string' ? error : (error && (error.message || (error as any).toString?.() || '未知错误'));
    console.error('❌ 特殊木刻处理失败:', error);
    if (!isPreview) {
      await core.showAlert({ message: '特殊木刻处理失败: ' + msg });
    }
  } finally {
    specialWoodcutApplyingRef.current = false;
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

// alpha对齐功能：统一半透明笔刷交叉点的不透明度
// withBg=true 时是"背景保护"：处理"低透明度背景（如 alpha=50 的色块）上画线"的场景——
// 参照估计排除背景水平（环带中位数），只以线条主体水平为参照，交叉凸起拉回线水平，
// 背景色块不透明度保持不变；自动识别并保护普通线条像素（非交叉区线 core 不修改）；
// 参照须比像素低至少 BRIGHT_DELTA（只修明显凸起，保护线自身）。
// I/O 模式参考 handleGradientModify：整文档 getPixels → 算法 → 整文档 putPixels，
// 选区外像素由掩码系数 (mask/255) 混合保留。环形邻域参考所有画过的线条像素（不受选区限制），
// 因此小选区也能引用选区外的线条找到"单线水平"真正统一交叉点。
const handleAlphaAlign = async (withBg: boolean = false) => {
  if (!handleLicenseBeforeAction()) return;
  const name = withBg ? '背景保护' : 'alpha对齐';
  try {
    const { executeAsModal } = core;

    await executeAsModal(async () => {
      // 检测当前编辑状态
      const editingState = await checkEditingState();
      if (!editingState.isValid) return;
      const { layer, isBackgroundLayer } = editingState;
      if (isBackgroundLayer) {
        await core.showAlert({ message: name + '仅支持非背景的普通像素图层，请选择像素图层后再使用。' });
        return;
      }

      // 获取选区边界与选区像素数据（无选区时内部会自动 batchPlay 全选文档）
      const selectionBounds = await getSelectionData();
      if (!selectionBounds) {
        await core.showAlert({ message: '获取文档信息失败' });
        return;
      }
      console.log('✅ [' + name + '] 选区像素数=' + (selectionBounds.selectionDocIndices ? selectionBounds.selectionDocIndices.size : -1) +
        ' 文档=' + selectionBounds.docWidth + 'x' + selectionBounds.docHeight +
        ' 选区=' + selectionBounds.left + ',' + selectionBounds.top + ',' + selectionBounds.right + ',' + selectionBounds.bottom);

      await runWithTemporaryUnlock(async () => {
        // 使用与像素过渡等已验证功能完全相同的共享像素数据处理流程
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);

        // 诊断：统计选区内 fullPixelData 的 alpha 分布，确认读到的 alpha 是否正确
        {
          let aMin = 255, aMax = 0, aNonZero = 0;
          for (let i = 0; i < pixelResult.selectionIndices.length; i++) {
            const di = pixelResult.selectionIndices[i] * 4;
            const a = pixelResult.fullPixelData[di + 3] || 0;
            if (a > 0) aNonZero++;
            if (a < aMin) aMin = a;
            if (a > aMax) aMax = a;
          }
          console.log('🔍 [' + name + '] 选区内 fullPixelData alpha: 非零像素=' + aNonZero + ' min=' + aMin + ' max=' + aMax);
        }

        // 创建完整文档尺寸的选区掩码（选区内为羽化值 0-255，选区外为 0）
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (let docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }

        // 关键：传入 fullPixelData（完整 alpha）而非 selectionPixelData。
        // 这样环形邻域能引用选区外的线条像素找到"单线水平"，
        // 而 fullSelectionMask 只决定"哪些像素会被修改"。
        const processedPixels = await processAlphaAlign(
          pixelResult.fullPixelData.buffer,
          fullSelectionMask.buffer,
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          {},
          false,
          withBg // 含背景模式：参照排除低透明度背景，只以线条主体水平为参照
        );

        // 写回：按选区羽化系数混合，选区内写入计算结果，选区外保留原像素
        await applyProcessedPixels(processedPixels, pixelResult);
      });
    });
    giveFocusBackToPS();
  } catch (error) {
    const msg = typeof error === 'string' ? error : (error && (error.message || (error as any).toString?.() || '未知错误'));
    console.error('❌ ' + name + '处理失败:', error);
    await core.showAlert({ message: name + '处理失败: ' + msg });
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
            lineSmoothStrength: edgeLineStrength / 100,
            lineSmoothRadius: edgeLineSmoothRadius,
            linePreserveDetail: edgeLinePreserveDetail / 100
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
        for (const docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }

        let processedPixels: Uint8Array;
        if (usePowerfulMode) {
          // 强力模式：自动估算等效中间值半径（不需要用户输入 radius/sigma）
          processedPixels = await processPixelTransitionPowerful(
            pixelResult.selectionPixelData.buffer,
            fullSelectionMask.buffer,
            { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
            isBackgroundLayer
          );
        } else {
          // 普通模式：用户指定 radius/sigma 的高斯模糊
          processedPixels = await processPixelTransition(
            pixelResult.selectionPixelData.buffer,
            fullSelectionMask.buffer,
            { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
            { radius, sigma },
            isBackgroundLayer
          );
        }

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

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button" onClick={handlePixelTransition} title={`● 特制类高斯模糊过渡滤镜，特点是屏蔽alpha为0的像素，从而更好保护形状。

● 半径决定参考范围大小；强度决定过渡幅度。

即：半径大→过渡范围更广；强度大→边缘更平滑。

● 强力模式开启后，算法自动识别选区内的色块厚度并估算等效中间值半径（类似 PS 中间值滤镜），无需手动调节半径/强度。`}>像素过渡</div>

      <div className="adjustment-swtich-container">
        <label
          className="adjustment-swtich-label"
          onClick={() => setUsePowerfulMode(!usePowerfulMode)}
          style={{ cursor: 'pointer' }}
          title={`● 强力模式：自动估算等效中间值半径。
\n● 15px 笔触约对应半径 18。
\n● 开启后隐藏下方的半径/强度滑块。`}
        >强力模式</label>
        <sp-switch
          checked={usePowerfulMode}
          onChange={(e) => setUsePowerfulMode((e.target as HTMLInputElement).checked)}
          style={{ marginLeft: '8px' }}
        />
      </div>
    </div>

    {!usePowerfulMode && (
      <div className="adjustment-slider-container">
        <div className="adjustment-slider-item">
          <div className="adjustment-slider-label" title={`● 控制处理时参考的邻域大小，单位 px。

● 半径越大，影响范围越宽，过渡更柔和但更慢。

示例：小图建议 5–10px；大图建议 10–20px。`}>半径</div>
          <div className="unit-container">
            <RangeSlider min={5} max={20} step={1} value={radius} onChange={handleRadiusChange} className="adjustment-slider-input" />
            <input type="number" min="5" max="20" step="1" value={radius} onChange={handleRadiusNumberChange} className="adjustment-number-input" />
            <div className="adjustment-unit">px</div>
          </div>
        </div>
        <div className="adjustment-slider-item">
          <div className="adjustment-slider-label" title={`● 控制过渡力度，单位级。

● 强度越高，对比被削弱越多，边缘更圆滑。

示例：轻微处理用 1–2 级；明显去锯齿用 3–5 级。`}>强度</div>
          <div className="unit-container">
            <RangeSlider min={1} max={5} step={0.5} value={sigma} onChange={handleSigmaChange} className="adjustment-slider-input" />
            <input type="number" min="1" max="5" step="0.5" value={sigma} onChange={handleSigmaNumberChange} className="adjustment-number-input" />
            <div className="adjustment-unit">级</div>
          </div>
        </div>
      </div>
    )}

    <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleGradientModify} title={`● 修改选区内的梯度形态：负值放缓（过渡更宽更柔），正值陡峭（过渡更窄更硬）。

● 同时作用于颜色与不透明度（alpha）的过渡。

● 计算时屏蔽选区外像素，避免透明外部拖低边缘导致露出选区边界。`}>梯度修改</div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● -10 到 -1：放缓梯度（过渡更宽、更柔和）。

● 0：不做修改。

● 1 到 10：陡峭梯度（过渡更窄、更明显）。

提示：绝对值越大，影响越明显且更慢。`}>程度</div>
        <div className="unit-container">
          <RangeSlider min={-10} max={10} step={1} value={gradientRelaxStrength} onChange={handleGradientRelaxStrengthChange} className="adjustment-slider-input" />
          <input type="number" min="-10" max="10" step="1" value={gradientRelaxStrength} onChange={handleGradientRelaxStrengthNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleSpecialSharpen} title={`● 一种更“硬”的局部锐化方式，用于强化过渡边缘与对比。

● 仅对选区内生效，并尽量避免选区边界露出。

● 数值越大效果越强，也越慢。`}>特殊锐化</div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 控制锐化强度，单位级。

● 建议 2–6 用于轻中度增强，7–10 用于强烈强化。`}>强度</div>
        <div className="unit-container">
          <RangeSlider min={1} max={10} step={0.5} value={specialSharpenStrength} onChange={handleSpecialSharpenStrengthChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="10" step="0.5" value={specialSharpenStrength} onChange={handleSpecialSharpenStrengthNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleHighFrequencyEnhancement} title={`● 提升细小纹理与微对比，使画面更清晰。

● 仅对选区内的高频细节生效，低频形状不被破坏。

● 强度决定增强幅度；范围决定纳入的细节尺度宽度。

示例：强度高→更锐利；范围大→兼顾更粗的纹理。`}>高频增强</div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 控制细节增强强弱，单位级。

● 建议 1–4 用于精修，5–8 用于明显锐化。`}>强度</div>
        <div className="unit-container">
          <RangeSlider min={1} max={10} step={0.5} value={highFreqIntensity} onChange={handleHighFreqIntensityChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="10" step="0.5" value={highFreqIntensity} onChange={handleHighFreqIntensityNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 控制被视为高频的细节宽度，单位级。

● 值小偏向极细纹理；值大兼顾较粗纹理。`}>范围</div>
        <div className="unit-container">
          <RangeSlider min={1} max={10} step={0.5} value={highFreqRange} onChange={handleHighFreqRangeChange} className="adjustment-slider-input" />
          <input type="number" min="1" max="10" step="0.5" value={highFreqRange} onChange={handleHighFreqRangeNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>
  </div>
);

const renderEdgeProcessingContent = () => (
  <div className="adjustment-section">
    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleSmartEdgeSmooth} title={`● 两种模式：色块边界的“中间值”平滑；或对线条做“抹除→方向平滑→回写”。

● 普通图层会对 RGBA 四通道处理；背景图层只处理 RGB。`}>边缘平滑</div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label" title={`● 仅色块边界：对选区做“中间值”平滑，并在选区边缘做渐隐避免边界感。

● 仅主线条：先对选区做“中间值”抹除，再对线条方向做平滑并写回。`}>平滑模式</div>
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
              <RangeSlider min={10} max={30} step={1} value={edgeMedianRadius} onChange={handleEdgeMedianRadiusChange} className="adjustment-slider-input" />
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
              <RangeSlider min={10} max={30} step={1} value={edgeBackgroundSmoothRadius} onChange={handleEdgeBackgroundSmoothRadiusChange} className="adjustment-slider-input" />
              <input type="number" min="10" max="30" step="1" value={edgeBackgroundSmoothRadius} onChange={handleEdgeBackgroundSmoothRadiusNumberChange} className="adjustment-number-input" />
              <div className="adjustment-unit">px</div>
            </div>
          </div>

          <div className="adjustment-slider-item">
            <div className="wide-adjustment-slider-label" title={`● 控制线条平滑的力度。越高越接近“油画滤镜”那种把乱线磨平的效果。`}>平滑力度</div>
            <div className="unit-container">
              <RangeSlider min={0} max={100} step={1} value={edgeLineStrength} onChange={handleEdgeLineStrengthChange} className="adjustment-slider-input" />
              <input type="number" min="0" max="100" step="1" value={edgeLineStrength} onChange={handleEdgeLineStrengthNumberChange} className="adjustment-number-input" />
              <div className="adjustment-unit">%</div>
            </div>
          </div>

          <div className="adjustment-slider-item">
            <div className="wide-adjustment-slider-label" title={`● 控制平滑的采样范围。范围越大越能把起伏磨平，但也更慢。`}>平滑范围</div>
            <div className="unit-container">
              <RangeSlider min={3} max={12} step={1} value={edgeLineSmoothRadius} onChange={handleEdgeLineSmoothRadiusChange} className="adjustment-slider-input" />
              <input type="number" min="3" max="12" step="1" value={edgeLineSmoothRadius} onChange={handleEdgeLineSmoothRadiusNumberChange} className="adjustment-number-input" />
              <div className="adjustment-unit">px</div>
            </div>
          </div>

          <div className="adjustment-slider-item">
            <div className="wide-adjustment-slider-label" title={`● 控制保边缘程度。越高越不容易把笔触边缘糊掉。`}>保护细节</div>
            <div className="unit-container">
              <RangeSlider min={0} max={100} step={1} value={edgeLinePreserveDetail} onChange={handleEdgeLinePreserveDetailChange} className="adjustment-slider-input" />
              <input type="number" min="0" max="100" step="1" value={edgeLinePreserveDetail} onChange={handleEdgeLinePreserveDetailNumberChange} className="adjustment-number-input" />
              <div className="adjustment-unit">%</div>
            </div>
          </div>
        </>
      )}
    </div>

    <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleLineEnhancement} title={`● 针对边缘线条的 Alpha 进行增强，使轮廓更清晰。

● 适合线稿、UI 描边、图标轮廓等。

● 无选区时默认对整幅图处理。`}>线条加黑</div>

    <div className="adjustment-divider"></div>

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button" onClick={() => handleAlphaAlign(false)} title={`● 统一半透明笔刷交叉点的不透明度，消除两笔交汇处出现的"深色点"。

● 分析选区内像素的 alpha，把局部异常偏高（如交叉叠加）的区域拉回周围线条的自然水平，与周边自然衔接。

● 自适应识别 1~100px 的细线与粗线交叉（含粗细混排），无需手动切换模式。

● 仅对非背景的普通像素图层生效，只修改选区内 Alpha>0 的区域（RGB 不变）。

● 会排除选区内的羽化渐变与极低不透明度残留的干扰。`}>alpha对齐</div>

      <div role="button" tabIndex={0} className="adjustment-button" onClick={() => handleAlphaAlign(true)} title={`● 与 alpha对齐 类似，但用于"低透明度背景（如 alpha=50 的色块）上画线"的场景——统一化线条交叉区域的叠加凸起，同时保护背景色块与线条自身不被侵蚀。
 
● 参照估计会排除背景水平（环带中位数），只以线条主体水平为参照：交叉凸起拉回线水平，背景保持不变。
 
● 自动识别并保护普通线条像素（非交叉区的线 core 不会被误拉低），只修"明显凸起"（参照比像素低 ≥10）。
 
● 自适应识别各种宽度的线条交错（细×细、细×粗、粗×粗）。
 
● 仅对非背景的普通像素图层生效，只修改选区内 Alpha>0 的区域（RGB 不变）。`}>背景保护</div>
    </div>
  </div>
);

const renderMaskSyncContent = () => (
  <div className="adjustment-section mask-sync-section">
    {/* 新建同步任务按钮 */}
    <div className="mask-sync-add-row">
      <sp-action-button quiet class="mask-sync-add-button" onClick={handleMaskSyncAdd} title="新建同步任务">
        <AddIcon />
      </sp-action-button>
    </div>

    {maskSyncTasks.length === 0 && (
      <div className="mask-sync-empty">点击 + 新建同步任务</div>
    )}

    {maskSyncTasks.map(task => (
      <div key={task.id} className="mask-sync-task">
        {/* 任务名：双击重命名 */}
        <div className="mask-sync-task-header">
          {maskSyncEditingId === task.id ? (
            <input
              className="mask-sync-name-input"
              value={maskSyncEditingName}
              autoFocus
              onChange={(e) => setMaskSyncEditingName(e.target.value)}
              onBlur={commitMaskSyncRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitMaskSyncRename();
                } else if (e.key === 'Escape') {
                  setMaskSyncEditingId(null);
                }
              }}
            />
          ) : (
            <span
              className="mask-sync-task-name"
              onDoubleClick={() => startMaskSyncRename(task)}
              title="双击重命名"
            >{task.name}</span>
          )}
        </div>

        <div className="mask-sync-divider" />

        {/* 部分一：样本（图层 + 通道 + 反相） */}
        <div className="mask-sync-row">
          <span className="mask-sync-label">样本图层</span>
          <select
            className="mask-sync-select"
            value={task.sampleLayerId != null ? String(task.sampleLayerId) : ''}
            onMouseDown={refreshMaskSyncOptions}
            onChange={(e) => handleMaskSyncSampleChange(task, e.target.value)}
          >
            <option value="">请选择像素图层</option>
            {maskSyncSampleOptions.map(opt => (
              <option key={opt.id} value={String(opt.id)} disabled={opt.kind !== 'pixel'}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="mask-sync-row">
          <span className="mask-sync-label">通道</span>
          <select
            className="mask-sync-select"
            value={task.channel}
            onChange={(e) => handleMaskSyncChannelChange(task, e.target.value)}
          >
            {(Object.keys(MASK_SYNC_CHANNEL_LABELS) as MaskSyncChannel[]).map(ch => (
              <option key={ch} value={ch}>{MASK_SYNC_CHANNEL_LABELS[ch]}</option>
            ))}
          </select>
        </div>

        <div className="mask-sync-divider" />

        {/* 部分二：目标（有蒙版的图层/组）+ 反相 */}
        <div className="mask-sync-row">
          <span className="mask-sync-label">目标蒙版</span>
          <select
            className="mask-sync-select"
            value={task.targetLayerId != null ? String(task.targetLayerId) : ''}
            onMouseDown={refreshMaskSyncOptions}
            onChange={(e) => handleMaskSyncTargetChange(task, e.target.value)}
          >
            <option value="">请选择带蒙版图层</option>
            {maskSyncTargetOptions.map(opt => (
              <option key={opt.id} value={String(opt.id)}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="mask-sync-row mask-sync-invert-row">
          <label
            className="mask-sync-checkbox"
            style={{ color: 'var(--text-color)' }}
            title="开启后通道灰度取反（255-值）"
          >
            <input
              type="checkbox"
              checked={task.invert}
              onChange={(e) => handleMaskSyncInvertChange(task, e.target.checked)}
            />
            <span style={{ color: 'var(--text-color)' }}>反相</span>
          </label>
        </div>

        <div className="mask-sync-divider" />

        {/* 部分三：同步开关 + 删除 */}
        <div className="mask-sync-footer">
          <div className="adjustment-swtich-container mask-sync-switch" style={{ width: 'auto', marginBottom: 0 }}>
            <label
              className="adjustment-swtich-label"
              style={{ cursor: 'pointer' }}
              title="开启后按“事件驱动+兜底轮询”自动同步样本通道到目标蒙版"
            >同步</label>
            <sp-switch
              checked={task.enabled}
              onChange={(e) => handleMaskSyncEnabledChange(task, (e.target as HTMLInputElement).checked)}
              style={{ marginLeft: '8px' }}
            />
          </div>
          <sp-action-button
            quiet
            class="mask-sync-delete-button"
            onClick={() => handleMaskSyncRemove(task.id)}
            title="删除该同步任务"
          >
            <DeleteIcon style={{ width: '15px', height: '15px', display: 'block' }} />
          </sp-action-button>
        </div>
      </div>
    ))}
  </div>
);

const renderBlockAdjustmentContent = () => (
  <div className="adjustment-section">

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button" onClick={handleBlockAverage} title={`● 按网格对选区分块做加权平均，降低噪点和斑驳。

● 加权模式让中心权重更高，保留主体轮廓。`}>分块平均</div>
      
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
            <RangeSlider min={1} max={10} step={0.5} value={weightedIntensity} onChange={handleWeightedIntensityChange} className="adjustment-slider-input" />
            <input type="number" min="1" max="10" step="0.5" value={weightedIntensity} onChange={handleWeightedIntensityNumberChange} className="adjustment-number-input" />
            <div className="adjustment-unit">级</div>
          </div>
        </div>
      </div>
    )}

    <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleBlockGradient} title={`● 对每个不相连选区（连通块）分别采样一次渐变颜色并填充。

● 渐变数据来自主面板“渐变设置”的最终预览（含角度与反向）。

● 每个连通块取形状质心，沿渐变方向投影后做归一化映射。`}>分块渐变</div>

    {/* 分块补色功能暂不完善，先隐藏不显示（连同其线稿参考选择器一起注释） */}
    {/* <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleBlockColorPatch} title={`● 解决线稿与底色之间的细缝、锐角尖头漏填等问题。

● 在选区内，把透明像素用最近的已有颜色补齐，并尽量不跨越线稿边界。

● 建议先在“线稿参考”下拉中选择线稿所在图层，再在颜色层选区内执行。`}>分块补色</div>


    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="wide-adjustment-slider-label" title={`● 指定用于识别线条边界的参考图层。

● 推荐选择线稿所在的像素图层。`}>线稿参考</div>
        <div className="unit-container">
          <select
            value={lineReferenceLayerId ? String(lineReferenceLayerId) : 'auto'}
            onChange={handleLineReferenceLayerChange}
            onMouseDown={refreshLineReferenceOptions}
            className="adjustment-select"
          >
            <option value="auto">自动：当前层上方最近像素层</option>
            {lineReferenceOptions.map(opt => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div> */}

    <div className="adjustment-divider"></div>

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button" onClick={() => handleSpecialWoodcut(false)} title={`● 木刻量化会让颜色出现阶梯状色阶。

● 本功能会额外识别透明/半透明边缘，并在边缘处按强度叠加木刻量化，使边缘与内部风格一致。

● 仅修改 RGB，alpha 保持不变。`}>特殊木刻</div>

      <div role="button" tabIndex={0} className="adjustment-button" onClick={resetSpecialWoodcutParams} title="一键恢复默认参数">重置</div>
    </div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label adjustment-slider-label-3" title="色阶数（2–16），数值越小越“硬”，越大越细腻。">色阶数</div>
        <div className="unit-container">
          <RangeSlider min={2} max={16} step={1} value={specialWoodcutLevels} onChange={handleSpecialWoodcutLevelsChange} className="adjustment-slider-input" />
          <input type="number" min="2" max="16" step="1" value={specialWoodcutLevels} onChange={handleSpecialWoodcutLevelsNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">级</div>
        </div>
      </div>

      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label adjustment-slider-label-4" title="边缘强度阈值（0–255），越低越容易把更多区域视为边缘。">边缘阈值</div>
        <div className="unit-container">
          <RangeSlider min={0} max={255} step={1} value={specialWoodcutEdgeThreshold} onChange={handleSpecialWoodcutEdgeThresholdChange} className="adjustment-slider-input" />
          <input type="number" min="0" max="255" step="1" value={specialWoodcutEdgeThreshold} onChange={handleSpecialWoodcutEdgeThresholdNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">值</div>
        </div>
      </div>

      <div className="adjustment-slider-item">
        <div className="adjustment-slider-label adjustment-slider-label-4" title="边缘木刻叠加强度（0–100%）。">边缘强度</div>
        <div className="unit-container">
          <RangeSlider min={0} max={100} step={1} value={specialWoodcutEdgeStrength} onChange={handleSpecialWoodcutEdgeStrengthChange} className="adjustment-slider-input" />
          <input type="number" min="0" max="100" step="1" value={specialWoodcutEdgeStrength} onChange={handleSpecialWoodcutEdgeStrengthNumberChange} className="adjustment-number-input" />
          <div className="adjustment-unit">%</div>
        </div>
      </div>

      <div className="adjustment-swtich-container" style={{ marginTop: '6px', justifyContent: 'flex-start', width: 'auto' }}>
        <label
          className="adjustment-swtich-label"
          onClick={() => setSpecialWoodcutPreview(!specialWoodcutPreview)}
          style={{ cursor: 'pointer' }}
          title="开启后参数变化会在 300ms 内自动刷新预览。"
        >预览</label>
        <sp-switch
          checked={specialWoodcutPreview}
          onChange={(e) => setSpecialWoodcutPreview(e.target.checked)}
          style={{ marginLeft: '8px' }}
        />
      </div>
    </div>
  </div>
);

// 渲染整个分区
const renderSectionContent = (sectionId: string) => {
  if (sectionId === 'blockAdjustment') return renderBlockAdjustmentContent();
  if (sectionId === 'localContrast') return renderLocalContrastContent();
  if (sectionId === 'edgeProcessing') return renderEdgeProcessingContent();
  if (sectionId === 'maskSync') return renderMaskSyncContent();
  return null;
};

const renderSection = (section: SectionConfig) => (
  <div key={section.id} className="adjust-expand-section">
    <div className="adjust-expand-header"
         draggable
         onDragStart={(e)=>handleDragStart(e, section.id)}
         onDragOver={handleDragOver}
         onDrop={(e)=>handleDrop(e, section.id)}
         onClick={()=>toggleSectionCollapse(section.id)}
    >
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
            <div role="button" tabIndex={0} className="adjustment-modal-close" onClick={() => setShowVisibilityPanel(false)}>×</div>
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
