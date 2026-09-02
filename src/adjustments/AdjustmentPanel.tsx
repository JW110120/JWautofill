import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getPopRoot } from '../utils/popRoot';
import {
  createOcclusionSession,
  estimatePopRect,
} from '../utils/popOverlay';
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
import { runKnockoutBatch } from './knockoutBatchProcessor';
import { LicenseManager } from '../utils/LicenseManager';
import { action, app, core, imaging } from 'photoshop';
import type { Gradient } from '../types/state';
import './adjustment.css';
import './adjustment-input.css';
import { AdjustmentMenu } from '../utils/AdjustmentMenu';
import { ExpandIcon, AddIcon, DeleteIcon, SyncIcon } from '../styles/Icons';
import { PanelStateManager } from '../utils/PanelStateManager';
import { maskSyncEngine, MASK_SYNC_CHANNEL_LABELS, LayerTreeEntry, MaskSyncTask, MaskSyncChannel, SyncState } from '../utils/MaskSyncEngine';
import BrushHotkeySection from '../hotkey/BrushHotkeySection';
import RangeSlider from '../components/RangeSlider';
import Select from '../components/Select';
import { helpTexts } from '../constants/helpTexts';
import { useLabelDrag } from '../utils/useLabelDrag';

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
  id: 'quickAction' | 'detailAdjust' | 'edgeProcessing' | 'maskSync' | 'brushHotkey' | string;
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
  { id: 'quickAction', title: '快捷操作', isCollapsed: false, isVisible: true, order: 0 },
  { id: 'detailAdjust', title: '细节调整', isCollapsed: false, isVisible: true, order: 1 },
  { id: 'edgeProcessing', title: '边缘处理', isCollapsed: false, isVisible: true, order: 2 },
  { id: 'maskSync', title: '蒙版同步', isCollapsed: false, isVisible: true, order: 3 },
  { id: 'brushHotkey', title: '笔刷热键', isCollapsed: false, isVisible: true, order: 4 }
];

// 默认子功能配置
const defaultSubFeatures: SubFeature[] = [
  { id: 'pixelTransition', parentId: 'detailAdjust', title: '像素过渡', isVisible: true, order: 0 },
  { id: 'gradientRelax', parentId: 'detailAdjust', title: '梯度修改', isVisible: true, order: 1 },
  { id: 'highFreqEnhancement', parentId: 'detailAdjust', title: '高频增强', isVisible: true, order: 2 },
  { id: 'edgeSmooth', parentId: 'edgeProcessing', title: '边缘平滑', isVisible: true, order: 0 },
  { id: 'lineEnhancement', parentId: 'edgeProcessing', title: '线条加黑', isVisible: true, order: 2 }
];

/**
 * 合并已保存分区与默认分区，保证默认分区（含新增的「蒙版同步」）在插件
 * 安装/升级后一定出现，不会因旧版本的 panel-state.json 缺少该分区而被整体替换掉。
 * - 默认分区全部保留；已保存分区沿用用户的可见性/折叠/顺序设置；
 * - 新增的默认分区若不在已保存数据中，按默认（可见）补齐；
 * - 已保存但不在默认中的分区也保留，避免丢数据。
 */
const mergeSections = (
  defaults: SectionConfig[],
  loaded?: Array<{ id: string; isCollapsed?: boolean; isVisible?: boolean; order?: number; title?: string }>
): SectionConfig[] => {
  if (!loaded || loaded.length === 0) return defaults.map(s => ({ ...s }));
  const loadedMap = new Map(loaded.map(s => [s.id, s]));
  const result: SectionConfig[] = [];
  // 1) 默认分区全部保留（新增分区自动补齐，默认可见）
  for (const d of defaults) {
    const l = loadedMap.get(d.id);
    result.push(
      l
        ? {
            ...d,
            isCollapsed: l.isCollapsed ?? d.isCollapsed,
            isVisible: l.isVisible ?? true,
            order: l.order ?? d.order,
          }
        : { ...d }
    );
  }
  // 2) 保留已保存但不在默认中的分区
  for (const l of loaded) {
    if (!defaults.some(d => d.id === l.id)) {
      result.push({
        id: l.id,
        title: l.title ?? l.id,
        isCollapsed: !!l.isCollapsed,
        isVisible: l.isVisible ?? true,
        order: l.order ?? 99,
      });
    }
  }
  result.sort((a, b) => a.order - b.order);
  return result;
};

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
// 许可证检查是否已完成：避免异步检查返回前锁定遮罩闪现（已激活用户会看到一瞬间的遮罩）
const [licenseChecked, setLicenseChecked] = useState(false);

// 分区状态管理
const [sections, setSections] = useState<SectionConfig[]>(defaultSections);
const [subFeatures, setSubFeatures] = useState<SubFeature[]>(defaultSubFeatures);
const [isDragMode, setIsDragMode] = useState(false);
// 分区级拖拽：记录「被拖起的分区」与「当前悬停的落点分区」，用于落点虚线 + 拖起半透明
const [dragSourceId, setDragSourceId] = useState<string | null>(null);
const [dragOverId, setDragOverId] = useState<string | null>(null);
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
const [lineReferenceOptions, setLineReferenceOptions] = useState<Array<{ value: string; label: string; depth: number; disabled?: boolean }>>([]);
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
const [maskSyncResults, setMaskSyncResults] = useState<Record<string, SyncState>>({});
const [maskSyncEngineReady, setMaskSyncEngineReady] = useState(false);

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

/**
 * 锁定遮罩打开时给 body 加类，由 input-fix.css 隐藏本面板内的所有可编辑控件。
 * 原因：UXP 官方 Known Issues —— text field / number input 是原生视图，
 * 永远绘制在同面板最上层，z-index 与层级都压不住，会浮在遮罩之上。
 * 与主面板（body.license-dialog-open）同一套做法。
 */
useEffect(() => {
  const locked = licenseChecked && !isLicensed && !isTrial;
  if (locked) {
    document.body.classList.add('adjustment-lock-open');
  } else {
    document.body.classList.remove('adjustment-lock-open');
  }
  return () => {
    document.body.classList.remove('adjustment-lock-open');
  };
}, [licenseChecked, isLicensed, isTrial]);

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
        // 旧版本分区 id 重命名迁移：blockAdjustment→quickAction、localContrast→detailAdjust。
        // 避免升级后旧 panel-state.json 残留旧 id，与新默认值叠加产生重复分区/失效子功能。
        const SECTION_ID_MIGRATION: Record<string, string> = {
          blockAdjustment: 'quickAction',
          localContrast: 'detailAdjust',
        };
        const migratedSections = (ap.sections || []).map((s: any) => ({
          ...s,
          id: SECTION_ID_MIGRATION[s.id] ?? s.id,
        }));
        const migratedSubFeatures = (ap.subFeatures || []).map((sf: any) => ({
          ...sf,
          parentId: SECTION_ID_MIGRATION[sf.parentId] ?? sf.parentId,
        }));
        if (migratedSections.length) {
          // 与默认分区合并：保证「蒙版同步」等新增分区在安装/升级后可见，
          // 不再因旧 panel-state.json 缺失该分区而被整体替换掉。
          setSections(mergeSections(defaultSections, migratedSections));
        }
        if (migratedSubFeatures.length) {
          setSubFeatures(migratedSubFeatures);
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
    },
    onAlphaSample: () => {
      handleLayerAlphaSample();
    },
    onUninstallHotkeyDaemon: () => {
      // 卸载守护进程是低频操作（通常在删除整个插件前），入口放在右上角菜单里。
      // 具体实现注册在 BrushHotkeySection（它持有状态提示），这里只做转发。
      import('../hotkey/HotkeyBridge').then((m) => {
        m.requestUninstall().then((msg) => { console.log('[卸载守护进程] ' + msg); });
      }).catch((e) => console.error('卸载守护进程失败:', e));
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

/**
 * 两个图层树是否完全相同（逐字段比较）。
 * buildLayerTree 内部是 batchPlay，会在 PS 端触发 set/select 等通知，
 * 这些通知又会回流触发引擎 notify / 面板刷新——若不比较去重，每次刷新都会
 * 强制全面板 re-render，re-render 引发的布局重排/输入重放正是
 * "下拉打开后立刻自动关闭"的根源（只影响带 onOpen 的样本/目标下拉）。
 */
const sameLayerTree = (a: LayerTreeEntry[], b: LayerTreeEntry[]): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.id !== y.id || x.name !== y.name || x.kind !== y.kind ||
        x.depth !== y.depth || x.hasUserMask !== y.hasUserMask ||
        x.isBackground !== y.isBackground || x.isAdjustment !== y.isAdjustment ||
        x.label !== y.label || x.path.join('/') !== y.path.join('/')) {
      return false;
    }
  }
  return true;
};

/** 任务列表内容比较（引擎每次 notify 都返回新数组引用，内容没变就不必重渲染）。 */
const sameMaskSyncTasks = (a: MaskSyncTask[], b: MaskSyncTask[]): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.id !== y.id || x.name !== y.name ||
        x.sampleLayerId !== y.sampleLayerId || x.targetLayerId !== y.targetLayerId ||
        x.channel !== y.channel || x.invert !== y.invert || x.enabled !== y.enabled) {
      return false;
    }
  }
  return true;
};

/**
 * 同步结果比较：**忽略 time 字段**（引擎 2s 轮询每次都会刷新时间戳，若把 time
 * 也纳入比较，面板每 2 秒就会重渲染一次，恰好落在下拉打开瞬间就会引发闪关）。
 * 只关心内容变化（synced/reason）。
 */
const sameSyncResults = (a: Record<string, SyncState> | undefined, b: Record<string, SyncState>): boolean => {
  const x = a || {};
  const kx = Object.keys(x);
  const ky = Object.keys(b);
  if (kx.length !== ky.length) return false;
  for (const k of ky) {
    const sb = b[k];
    const sa = x[k];
    if (!sa || !sb || sa.synced !== sb.synced || sa.reason !== sb.reason) return false;
  }
  return true;
};

const refreshMaskSyncOptions = async (): Promise<LayerTreeEntry[] | null> => {
  try {
    const tree = await maskSyncEngine.buildLayerTree();
    // 树内容没变就不 setState（比较引用/内容后再决定），切断
    // "刷新 → re-render → 布局重排/输入重放 → 下拉闪关"的链路。
    setMaskSyncSampleOptions(prev => (sameLayerTree(prev, tree) ? prev : tree));
    const targets = tree.filter(t => t.hasUserMask);
    setMaskSyncTargetOptions(prev => (sameLayerTree(prev, targets) ? prev : targets));
    return tree;
  } catch (e) {
    console.warn('⚠️ 刷新蒙版同步文件树失败:', e);
    return null;
  }
};

useEffect(() => {
  let unsub: (() => void) | undefined;
  let cancelled = false;
  const boot = async () => {
    await maskSyncEngine.init();
    if (cancelled) return;
    setMaskSyncEngineReady(true);
    unsub = maskSyncEngine.subscribe((info) => {
      // 引擎高频 notify（事件驱动 + 2s 兜底轮询）：内容无变化时不 setState，
      // 避免全面板反复 re-render 干扰下拉交互（下拉闪关的直接诱因）。
      const tasks = maskSyncEngine.getTasks();
      setMaskSyncTasks(prev => (sameMaskSyncTasks(prev, tasks) ? prev : tasks));
      if (info.results) {
        setMaskSyncResults(prev => (sameSyncResults(prev, info.results) ? prev : info.results));
      }
      // 文档切换/重开：刷新文件树下拉，并按名称路径重解析失效的图层引用
      if (info.docChanged) {
        refreshMaskSyncOptions();
        maskSyncEngine.reconcileTasks().then(changed => {
          if (changed) {
            const t2 = maskSyncEngine.getTasks();
            setMaskSyncTasks(prev => (sameMaskSyncTasks(prev, t2) ? prev : t2));
          }
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

// 图层结构变化（新建/删除/重命名/移动图层）时刷新文件树下拉，并重解析失效引用
useEffect(() => {
  let timer: any = 0;
  const scheduleRefresh = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      refreshMaskSyncOptions();
      maskSyncEngine.reconcileTasks().then(changed => {
        if (changed) {
          const t2 = maskSyncEngine.getTasks();
          setMaskSyncTasks(prev => (sameMaskSyncTasks(prev, t2) ? prev : t2));
        }
      });
    }, 120);
  };
  const handleMaskSyncNotif = (eventName?: any) => {
    const evt = typeof eventName === 'string' ? eventName : '';
    if (evt === 'make' || evt === 'delete' || evt === 'set' || evt === 'rename' || evt === 'move') {
      scheduleRefresh();
    }
  };
  // 逐个注册：单个事件名不支持时不拖垮其他事件（UXP 数组注册遇非法事件名会整体抛错）
  // ⚠️ 注意：addNotificationListener 第一个参数必须是【数组】，传字符串会整体注册失败
  const refreshEvents = ['make', 'delete', 'set', 'rename', 'move'];
  for (const evt of refreshEvents) {
    try {
      action.addNotificationListener([evt] as any, handleMaskSyncNotif);
    } catch {}
  }
  return () => {
    try {
      if (timer) clearTimeout(timer);
      for (const evt of refreshEvents) {
        try {
          action.removeNotificationListener([evt] as any, handleMaskSyncNotif);
        } catch {}
      }
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

const patchMaskSyncTask = async (taskId: string, patch: Partial<MaskSyncTask>) => {
  // 以 taskId 从当前 state 取最新任务，避免闭包里的旧对象被多次 patch 互相覆盖
  const cur = maskSyncTasks.find(t => t.id === taskId);
  if (!cur) return;
  const next = { ...cur, ...patch };
  setMaskSyncTasks(prev => prev.map(t => (t.id === taskId ? next : t)));
  try {
    await maskSyncEngine.updateTask(next);
  } catch (e) {
    console.warn('⚠️ 更新同步任务失败:', e);
  }
};

/**
 * 根据样本图层类型返回可用的通道下拉选项：
 * - 背景图层（只有 RGB 三通道）：灰度、R、G、B + 色相、饱和度（无 A、无蒙版）
 * - 调整图层（无 A 通道）：灰度、R、G、B、蒙版
 * - 普通像素图层：灰度、R、G、B、A、蒙版 + 色相、饱和度
 * 色相/饱和度通道依赖真实 RGB，仅背景图层与普通像素图层提供（调整图层/带蒙版组不提供）。
 */
const getMaskSyncChannelsForEntry = (entry?: LayerTreeEntry): MaskSyncChannel[] => {
  // 色相/饱和度通道：仅样本图层有真实 RGB 时可用（背景图层 / 普通像素图层）
  if (!entry) return ['gray', 'r', 'g', 'b', 'a', 'mask', 'hue', 'sat'];
  // 带蒙版的图层组：样本只能取该组自身的蒙版通道
  if (entry.kind === 'group' && entry.hasUserMask) return ['mask'];
  if (entry.isBackground) return ['gray', 'r', 'g', 'b', 'hue', 'sat'];
  if (entry.isAdjustment) return ['gray', 'r', 'g', 'b', 'mask'];
  return ['gray', 'r', 'g', 'b', 'a', 'mask', 'hue', 'sat'];
};

/* ================= 自定义下拉（支持“注释右对齐”） =================
 * 原生 <option> 无法让“（像素）”这类注释右对齐，改用自绘下拉：
 * 主文本靠左、注释靠右，弹出层 fixed 定位避免被面板 overflow 裁剪。 */
/** 把 label 末尾的（注释）拆出来：'　└ 图层1（像素）' → label='　└ 图层1' tag='（像素）' */
const splitLabelTag = (label: string): { label: string; tag: string } => {
  const idx = label.lastIndexOf('（');
  if (idx > 0 && label.endsWith('）')) {
    return { label: label.slice(0, idx), tag: label.slice(idx) };
  }
  return { label, tag: '' };
};

const handleMaskSyncSampleChange = async (task: MaskSyncTask, value: string) => {
  const id = parseInt(value, 10);
  if (!Number.isFinite(id)) return;
  let hit = maskSyncSampleOptions.find(o => o.id === id);
  // 下拉列表可能已过期（onMouseDown 触发的刷新未完成），重新构建一次再查
  if (!hit) {
    const tree = await refreshMaskSyncOptions();
    hit = (tree || []).find(o => o.id === id);
  }
  if (!hit) {
    console.warn(`⚠️ 蒙版同步：样本图层 id=${id} 未找到，选择未保存`);
    return;
  }
  // 样本图层支持：像素图层 / 调整图层 / 背景图层（背景只有 RGB 三通道）；
  // 此外「带蒙版的图层组」也可作为样本（只能取该组的蒙版通道）。
  const isMaskedGroup = hit.kind === 'group' && hit.hasUserMask;
  if (hit.kind !== 'pixel' && !hit.isAdjustment && !hit.isBackground && !isMaskedGroup) return;
  const patch: Partial<MaskSyncTask> = {
    sampleLayerId: hit.id,
    sampleLayerPath: hit.path,
    sampleLayerName: hit.name,
  };
  if (isMaskedGroup) {
    // 带蒙版的图层组：样本只能取「蒙版」通道，选中即强制锁定为蒙版
    patch.channel = 'mask';
  } else {
    // 若当前通道不在新样本的可用通道内（如切到背景图层后 A/蒙版不可用），重置为灰阶；
    // 若通道尚未选择（''），保持空白不自动填充
    const channels = getMaskSyncChannelsForEntry(hit);
    if (task.channel && !channels.includes(task.channel)) patch.channel = 'gray';
  }
  await patchMaskSyncTask(task.id, patch);
};

const handleMaskSyncChannelChange = async (task: MaskSyncTask, value: string) => {
  const channel = value as MaskSyncChannel;
  if (!MASK_SYNC_CHANNEL_LABELS[channel]) return;
  await patchMaskSyncTask(task.id, { channel });
};

const handleMaskSyncInvertChange = async (task: MaskSyncTask, checked: boolean) => {
  await patchMaskSyncTask(task.id, { invert: checked });
};

const handleMaskSyncTargetChange = async (task: MaskSyncTask, value: string) => {
  const id = parseInt(value, 10);
  if (!Number.isFinite(id)) return;
  let hit = maskSyncTargetOptions.find(o => o.id === id && o.hasUserMask);
  if (!hit) {
    const tree = await refreshMaskSyncOptions();
    hit = (tree || []).find(o => o.id === id && o.hasUserMask);
  }
  if (!hit) {
    console.warn(`⚠️ 蒙版同步：目标图层 id=${id} 未找到或没有蒙版，选择未保存`);
    return;
  }
  await patchMaskSyncTask(task.id, { targetLayerId: hit.id, targetLayerPath: hit.path, targetLayerName: hit.name });
};

const handleMaskSyncEnabledChange = async (task: MaskSyncTask, checked: boolean) => {
  await patchMaskSyncTask(task.id, { enabled: checked });
};

/** 手动立即同步一次（忽略同步开关，方便验证），结果直接显示在面板上。 */
const handleMaskSyncNow = async (task: MaskSyncTask) => {
  try {
    const forceTask = { ...task, enabled: true };
    const r = await maskSyncEngine.syncTask(forceTask);
    setMaskSyncResults(prev => ({
      ...prev,
      [task.id]: { time: Date.now(), synced: r.synced, reason: r.reason },
    }));
    console.log(`[蒙版同步] 手动同步[${task.name}]: ${r.synced ? '✓ 已写入蒙版' : '跳过(' + r.reason + ')'}`);
  } catch (e) {
    console.warn('⚠️ 手动同步失败:', e);
  }
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
  await patchMaskSyncTask(task.id, { name });
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
    // 统一判定（唯一事实来源）：与 app.tsx 共用 LicenseManager.getLicenseState()，
    // 避免两处判定逻辑漂移导致「试用被当作已激活」之类的问题。
    const { isLicensed: licensed, isTrial: trial, trialDaysRemaining: days } =
      await LicenseManager.getLicenseState();

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
  } finally {
    setLicenseChecked(true);
  }
};

const handleLicenseBeforeAction = (): boolean => {
  // 触发一次异步刷新，尽快感知在另一个入口刚完成的授权
  try { checkLicenseStatus(); } catch {}
  if (!isLicensed && !isTrial) {
    // 第二入口不开启对话框，直接弹出提示
    try {
      core.showAlert({ message: '当前未激活，请在选区填充界面完成授权后再使用此功能。' });
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

const buildLineReferenceOptions = (layers: any[], depth: number, out: Array<{ value: string; label: string; depth: number; disabled?: boolean }>) => {
  for (const layer of layers || []) {
    if (!layer) continue;
    const children = (layer as any)?.layers;
    const hasChildren = !!(children && Array.isArray(children) && children.length > 0);
    // 层级缩进改为按 depth 在 CSS 层用 padding-left 体现（与蒙版同步样本下拉一致），
    // 组内图层/嵌套组前面补一个 └ 符号增强层级辨识（depth>0 才加）
    const indent = depth > 0 ? '└ ' : '';
    const kind = (layer as any)?.kind;
    const isPixel = kind === 'pixel';
    const labelSuffix = hasChildren ? '（组）' : (isPixel ? '（像素）' : '（不可用）');
    out.push({
      value: String(layer.id),
      label: `${indent}${layer.name || `图层 ${layer.id}`}${labelSuffix}`,
      depth,
      disabled: !isPixel
    });
    if (hasChildren) buildLineReferenceOptions(children, depth + 1, out);
  }
};

const refreshLineReferenceOptions = (docOverride?: any) => {
  try {
    const doc = docOverride || app.activeDocument;
    const layers = doc?.layers || [];
    const out: Array<{ value: string; label: string; depth: number; disabled?: boolean }> = [];
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

/** 线稿参考层选择（Select 下拉，value = 图层 id 或 'auto'）。 */
const handleLineReferenceSelect = (value: string) => {
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
    try { core.showAlert({ message: '该图层不可作为线稿参考层，请选择像素图层' }); } catch {}
    setLineReferenceLayerId(null);
    setLineReferenceLayerName('');
    return;
  }
  setLineReferenceLayerId(id);
  setLineReferenceLayerName(layer.name || '');
};

const handleEdgeSmoothModeChange = (value: string) => {
  setEdgeSmoothMode(value);
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
  // 背景图层在 Photoshop 中被视为“整体锁定”（isBackgroundLayer），
  // 它无法（也不需要）做锁定/解锁操作：对其执行 applyLocking 会弹出
  // “命令'加锁'当前不可用”警告；而且写回像素（imaging.putPixels）本就不依赖锁定状态。
  // 因此背景图层直接执行 fn，跳过解锁/恢复锁定流程，避免两次无意义的警告。
  try {
    // 注意：本 UXP 运行时只用复数 activeLayers[0]，单数 activeLayer 不存在（见项目踩坑记录）
    const activeLayer = app.activeDocument?.activeLayers?.[0];
    if (activeLayer && (activeLayer as any).isBackgroundLayer) {
      await fn();
      return;
    }
  } catch (e) {
    console.warn('⚠️ 判断背景图层失败，仍按原逻辑尝试临时解锁流程:', e);
  }

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
        await applyProcessedPixels(processedPixels, pixelResult, '分块平均');
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

        await applyProcessedPixels(processedPixels, pixelResult, '分块渐变');
      });
    });
    giveFocusBackToPS();
  } catch (error) {
    const msg = typeof error === 'string' ? error : (error && (error.message || (error as any).toString?.() || '未知错误'));
    console.error('❌ 分块渐变处理失败:', error);
    await core.showAlert({ message: '分块渐变处理失败: ' + msg });
  }
};

/** 读取指定图层的 alpha 掩码（文档坐标、docW*docH 尺寸；RGBA 图层取 A，RGB 背景层视为 255）。 */
const readLineLayerAlphaMask = async (
  doc: any,
  layerId: number,
  docW: number,
  docH: number
): Promise<Uint8Array | null> => {
  try {
    const layer = findLayerById(doc?.layers || [], layerId);
    if (!layer || !layer.bounds) return null;
    const b = layer.bounds;
    const left = Math.round(b.left || 0);
    const top = Math.round(b.top || 0);
    const right = Math.round(b.right || 0);
    const bottom = Math.round(b.bottom || 0);
    const lw = Math.max(0, right - left);
    const lh = Math.max(0, bottom - top);
    if (lw <= 0 || lh <= 0) return null;
    const res: any = await imaging.getPixels({
      documentID: doc.id,
      layerID: layerId,
      sourceBounds: { left, top, right, bottom },
      targetSize: { width: lw, height: lh },
      componentSize: 8,
    });
    const imgData = res.imageData;
    const raw = new Uint8Array(await imgData.getData());
    const gotW = imgData.width || 0;
    const gotH = imgData.height || 0;
    imgData.dispose();
    // 用返回的 imageData 实际宽高计算通道数（请求尺寸可能被 UXP 取整/裁剪）
    const comps = gotW > 0 && gotH > 0 && raw.length > 0 ? Math.round(raw.length / (gotW * gotH)) : 0;
    if (comps !== 3 && comps !== 4) {
      console.warn(`⚠️ 线稿层 alpha 读取失败：comps=${comps}（请求 ${lw}x${lh}，实际 ${gotW}x${gotH}）`);
      return null;
    }
    const mask = new Uint8Array(docW * docH);
    for (let y = 0; y < gotH; y++) {
      for (let x = 0; x < gotW; x++) {
        const dx = left + x;
        const dy = top + y;
        if (dx < 0 || dx >= docW || dy < 0 || dy >= docH) continue;
        const si = (y * gotW + x) * comps;
        mask[dy * docW + dx] = comps === 4 ? raw[si + 3] : 255;
      }
    }
    return mask;
  } catch (e) {
    console.warn('⚠️ 读取线稿层 alpha 失败:', e);
    return null;
  }
};

/** 分块补色公共流程：sameOnly=true 走同层算法（lineColorMode 区分浅/深线）；false 走分层算法（线稿引导）。 */
const runBlockColorPatch = async (sameOnly: boolean, lineColorMode?: 'lighter' | 'darker') => {
  if (!handleLicenseBeforeAction()) return;
  try {
    const { executeAsModal } = core;

    await executeAsModal(async () => {
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

      const doc = app.activeDocument;

      // 线稿参考层（仅分层模式）：优先用户手动选择；否则自动取当前激活图层上方最近的像素图层。
      // 线稿层与填充层同层或找不到可用线稿层 → 退化同层算法。
      let refLayer: any | null = null;
      if (!sameOnly) {
        if (typeof lineReferenceLayerId === 'number' && lineReferenceLayerId !== layer.id) {
          refLayer = findLayerById(doc.layers || [], lineReferenceLayerId);
        }
        if (!refLayer || refLayer.kind !== 'pixel' || refLayer.id === layer.id) {
          refLayer = getAutoLineReferenceLayer(doc, layer.id);
        }
        if (!refLayer || refLayer.kind !== 'pixel' || refLayer.id === layer.id) {
          refLayer = null;
        }
      }
      const useLineGuide = !sameOnly && !!refLayer;

      await runWithTemporaryUnlock(async () => {
        const pixelResult = await processPixelData(selectionBounds, layer, isBackgroundLayer);

        // 创建完整文档尺寸的选区掩码数组
        const fullSelectionMask = new Uint8Array(selectionBounds.docWidth * selectionBounds.docHeight);
        let maskIndex = 0;
        for (const docIndex of pixelResult.selectionIndices) {
          fullSelectionMask[docIndex] = selectionBounds.selectionValues[maskIndex];
          maskIndex++;
        }

        // 线稿引导（分层场景）：读取线稿层 alpha 掩码，线稿轮廓内部全部补全（含尖角/孔洞/缝隙）
        let lineMask: ArrayBuffer | null = null;
        if (useLineGuide && refLayer) {
          lineMask = await readLineLayerAlphaMask(
            doc,
            refLayer.id,
            selectionBounds.docWidth,
            selectionBounds.docHeight
          );
        }

        // v7 算法：alpha 孔洞/缝隙/尖角补全（同层颜色模式 / 分层线稿引导）
        const processedPixels = await processBlockColorPatch(
          pixelResult.fullPixelData.buffer,
          fullSelectionMask.buffer,
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          lineMask ? { lineMask } : (lineColorMode ? { lineColorMode } : undefined)
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
        const patchName = sameOnly ? (lineColorMode === 'lighter' ? '浅线同层补色' : '深线同层补色') : '分层补色';
        await applyProcessedPixels(processedPixelsArray, resultForWriteback as any, patchName);
      });
    });
    giveFocusBackToPS();
  } catch (error) {
    const msg = typeof error === 'string' ? error : (error && (error.message || (error as any).toString?.() || '未知错误'));
    console.error('❌ 分块补色失败:', error);
    await core.showAlert({ message: '分块补色失败: ' + msg });
  }
};

/** 浅线同层补色：线条颜色比内部填充浅 → 只传播较深的内部填充色。 */
const handleBlockColorPatchLightLine = async () => {
  await runBlockColorPatch(true, 'lighter');
};

/** 深线同层补色：线条颜色比内部填充深 → 只传播较浅的内部填充色。 */
const handleBlockColorPatchDarkLine = async () => {
  await runBlockColorPatch(true, 'darker');
};

/** 分层补色：线稿与内部填充在不同图层，用线稿轮廓引导补全。 */
const handleBlockColorPatchLayered = async () => {
  await runBlockColorPatch(false);
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
    baseline.isBackgroundLayer,
    '特殊木刻预览还原'
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

      await applyProcessedPixels(processedPixels, pixelResult, '特殊木刻');
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
        await applyProcessedPixels(processedPixels, pixelResult, '线条加黑');
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
// withBg=true 时是"保底下对齐"（原"背景保护"）：处理"低透明度背景（如 alpha=50 的色块）上画线"的场景——
// 参照估计排除背景水平（环带中位数），只以线条主体水平为参照，交叉凸起拉回线水平，
// 背景色块不透明度保持不变；自动识别并保护普通线条像素（非交叉区线 core 不修改）；
// 参照须比像素低至少 BRIGHT_DELTA（只修明显凸起，保护线自身）。
// direction='up' 时是"alpha上对齐"：检测线条上比主体偏淡/被削弱的像素（淡斑、断点），
// 以周围线条主体水平为参照拉高，让线条更均匀（与下对齐对称，只增不减）。
// I/O 模式参考 handleGradientModify：整文档 getPixels → 算法 → 整文档 putPixels，
// 选区外像素由掩码系数 (mask/255) 混合保留。环形邻域参考所有画过的线条像素（不受选区限制），
// 因此小选区也能引用选区外的线条找到"单线水平"真正统一交叉点。
const handleAlphaAlign = async (withBg: boolean = false, direction: 'down' | 'up' = 'down') => {
  if (!handleLicenseBeforeAction()) return;
  const name = withBg ? '保底下对齐' : (direction === 'up' ? 'alpha上对齐' : 'alpha下对齐');
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
          withBg, // 保底下对齐：参照排除低透明度背景，只以线条主体水平为参照
          direction // 上对齐：把比主体偏淡的像素拉高到线条主体水平
        );

        // 写回：按选区羽化系数混合，选区内写入计算结果，选区外保留原像素
        await applyProcessedPixels(processedPixels, pixelResult, name);
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
        await applyProcessedPixels(processedPixels, pixelResult, '高频增强');
        
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
        
        // 步骤3：用智能边缘平滑算法处理像素数据
        // 注意：传递完整的像素数据而不是选区像素数据，因为算法需要邻域信息
        // 仅主线条模式（line）已重构为纯像素算法（结构张量方向场 + 沿切线平滑），
        // 不再需要 PS「中间值」预处理；参数精简为：平滑力度(默认100%) + 平滑范围(默认8px)
        const processedPixels = await processSmartEdgeSmooth(
          prePixelResult.fullPixelData.buffer, 
          fullSelectionMask.buffer, 
          { width: selectionBounds.docWidth, height: selectionBounds.docHeight },
          {
            mode: isLineMode ? 'line' : 'edge',
            edgeMedianRadius: edgeMedianRadius,
            backgroundSmoothRadius: edgeBackgroundSmoothRadius,
            lineSmoothStrength: edgeLineStrength / 100,
            lineSmoothRadius: edgeLineSmoothRadius
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
        await applyProcessedPixels(processedPixelsArray, resultForWriteback as any, '边缘平滑');
        
        console.log('✅ 智能边缘平滑处理完成');
      });
    });
    giveFocusBackToPS();
  } catch (error) {
    console.error('❌ 智能边缘平滑处理失败:', error);
    await core.showAlert({ message: '智能边缘平滑处理失败: ' + error.message });
  }
};

// 图层像素 alpha 采样：把当前图层像素的 alpha 通道以矩阵形式打印到控制台。
// 用途：方便对照/调试，把图层像素的 alpha 数据导出到控制台供分析。
const handleLayerAlphaSample = async () => {
  if (!handleLicenseBeforeAction()) return;
  try {
    const { executeAsModal } = core;

    await executeAsModal(async () => {
      const editingState = await checkEditingState();
      if (!editingState.isValid) return;
      const { layer, isBackgroundLayer } = editingState;
      if (isBackgroundLayer) {
        await core.showAlert({ message: 'alpha采样仅支持非背景的普通像素图层，请选择像素图层后再使用。' });
        return;
      }

      // 读取图层边界内的像素（图层边界 = 内容包围盒，一条路径描边的数据量很小）
      const bounds = layer.bounds;
      const W = Math.round(bounds.right - bounds.left);
      const H = Math.round(bounds.bottom - bounds.top);
      if (W <= 0 || H <= 0) {
        await core.showAlert({ message: '图层为空，请先在该像素图层上绘制内容后再采样。' });
        return;
      }
      if (W * H > 250000) {
        await core.showAlert({ message: '图层像素过多（' + W + 'x' + H + '），请用选区框选笔画区域后再试。' });
        return;
      }

      const pixels = await imaging.getPixels({
        documentID: app.activeDocument.id,
        layerID: layer.id,
        sourceBounds: {
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom
        },
        targetSize: { width: W, height: H }
      });
      const raw = new Uint8Array(await pixels.imageData.getData());
      const bpp = raw.length / (W * H);

      console.log('===== [alpha采样] 图层: ' + layer.name + ' =====');
      console.log('尺寸: ' + W + 'x' + H + ' 边界: (' + Math.round(bounds.left) + ',' + Math.round(bounds.top) + ')');
      // alpha 矩阵：每行一条记录，便于直接复制
      for (let y = 0; y < H; y++) {
        const row: number[] = [];
        for (let x = 0; x < W; x++) {
          const idx = y * W + x;
          row.push(bpp === 4 ? raw[idx * 4 + 3] : 255);
        }
        console.log('y=' + y + ': ' + row.join(','));
      }
      console.log('===== [alpha采样] 结束 =====');

      pixels.imageData.dispose();
    });
    giveFocusBackToPS();
  } catch (error) {
    console.error('❌ alpha采样失败:', error);
    await core.showAlert({ message: 'alpha采样失败: ' + error.message });
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
        await applyProcessedPixels(processedPixels, pixelResult, '像素过渡');

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

        await applyProcessedPixels(processedPixels, pixelResult, '梯度修改');
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

        await applyProcessedPixels(processedPixels, pixelResult, '特殊锐化');
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
  e.dataTransfer.effectAllowed = 'move';
  setDragSourceId(id);
  setDragOverId(null);
  setIsDragMode(true);
};

const handleDragOver = (e: React.DragEvent, id: string) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (id !== dragSourceId) setDragOverId(id);
};

const handleDragEnd = () => {
  setDragSourceId(null);
  setDragOverId(null);
  setIsDragMode(false);
};

const handleDrop = (e: React.DragEvent, targetId: string) => {
  e.preventDefault();
  const sourceId = e.dataTransfer.getData('text/plain');
  setDragSourceId(null);
  setDragOverId(null);
  setIsDragMode(false);
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
};

// ============================================================================
// 滑块文字标签横向拖拽调值（对齐 APP 主面板：按住标签左右拖 = 改滑块值）
// 灵敏度统一按「每 5px 鼠标位移 ≈ 1 个步长」标定，即 sensitivity ≈ 步长 / 5。
// ============================================================================
const SLIDER_DRAG_CONFIGS = {
  radius:                      { min: 5,   max: 20,  step: 1,   sensitivity: 0.2   },
  sigma:                       { min: 1,   max: 5,   step: 0.5, sensitivity: 0.1   },
  gradientRelaxStrength:       { min: -10, max: 10,  step: 1,   sensitivity: 0.2   },
  specialSharpenStrength:      { min: 1,   max: 10,  step: 0.5, sensitivity: 0.1   },
  highFreqIntensity:           { min: 1,   max: 10,  step: 0.5, sensitivity: 0.1   },
  highFreqRange:               { min: 1,   max: 10,  step: 0.5, sensitivity: 0.1   },
  edgeMedianRadius:            { min: 10,  max: 30,  step: 1,   sensitivity: 0.2   },
  edgeLineStrength:            { min: 0,   max: 100, step: 1,   sensitivity: 0.2   },
  edgeLineSmoothRadius:        { min: 3,   max: 12,  step: 1,   sensitivity: 0.2   },
  weightedIntensity:           { min: 1,   max: 10,  step: 0.5, sensitivity: 0.1   },
  specialWoodcutLevels:        { min: 2,   max: 16,  step: 1,   sensitivity: 0.2   },
  specialWoodcutEdgeThreshold: { min: 0,   max: 255, step: 1,   sensitivity: 0.5   },
  specialWoodcutEdgeStrength:  { min: 0,   max: 100, step: 1,   sensitivity: 0.2   }
} as const;

type SliderDragKey = keyof typeof SLIDER_DRAG_CONFIGS;

const { dragTarget: sliderDragTarget, onLabelMouseDown: onSliderLabelMouseDown } = useLabelDrag(
  SLIDER_DRAG_CONFIGS as Record<SliderDragKey, { min: number; max: number; step?: number; sensitivity?: number }>,
  (key: SliderDragKey, value: number) => {
    switch (key) {
      case 'radius': handleRadiusChange(value); break;
      case 'sigma': handleSigmaChange(value); break;
      case 'gradientRelaxStrength': handleGradientRelaxStrengthChange(value); break;
      case 'specialSharpenStrength': handleSpecialSharpenStrengthChange(value); break;
      case 'highFreqIntensity': handleHighFreqIntensityChange(value); break;
      case 'highFreqRange': handleHighFreqRangeChange(value); break;
      case 'edgeMedianRadius': handleEdgeMedianRadiusChange(value); break;
      case 'edgeLineStrength': handleEdgeLineStrengthChange(value); break;
      case 'edgeLineSmoothRadius': handleEdgeLineSmoothRadiusChange(value); break;
      case 'weightedIntensity': handleWeightedIntensityChange(value); break;
      case 'specialWoodcutLevels': handleSpecialWoodcutLevelsChange(value); break;
      case 'specialWoodcutEdgeThreshold': handleSpecialWoodcutEdgeThresholdChange(value); break;
      case 'specialWoodcutEdgeStrength': handleSpecialWoodcutEdgeStrengthChange(value); break;
    }
  }
);

/** 可拖拽滑块标签的统一 className：基类 + 可拖拽修饰类 + 拖拽中/未拖拽 */
const sliderLabelClass = (key: SliderDragKey, base: string) =>
  `${base} adjustment-slider-label-drag ${sliderDragTarget === key ? 'dragging' : 'not-dragging'}`;

// 渲染子功能内容
const renderDetailAdjustContent = () => (
  <div className="adjustment-section">

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button" onClick={handlePixelTransition} title={helpTexts.adjustment.pixelTransition}>像素过渡</div>

      <div className="adjustment-swtich-container">
        <label
          className="adjustment-swtich-label"
          onClick={() => setUsePowerfulMode(!usePowerfulMode)}
          title={helpTexts.adjustment.powerfulMode}
        >强力模式</label>
        <sp-switch
          checked={usePowerfulMode}
          onChange={(e) => setUsePowerfulMode((e.target as HTMLInputElement).checked)}
        />
      </div>
    </div>

    {!usePowerfulMode && (
      <div className="adjustment-slider-container">
        <div className="adjustment-slider-item">
          <div className={sliderLabelClass('radius', 'adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'radius', radius)} title={helpTexts.adjustment.radius}>半径</div>
          <div className="unit-container">
            <RangeSlider min={5} max={20} step={1} value={radius} onChange={handleRadiusChange} className="adjustment-slider-input" />
            <div className="num-input-row"><input type="number" min="5" max="20" step="1" value={radius} onChange={handleRadiusNumberChange} className="adjustment-number-input" /></div>
            <div className="adjustment-unit">px</div>
          </div>
        </div>
        <div className="adjustment-slider-item">
          <div className={sliderLabelClass('sigma', 'adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'sigma', sigma)} title={helpTexts.adjustment.sigma}>强度</div>
          <div className="unit-container">
            <RangeSlider min={1} max={5} step={0.5} value={sigma} onChange={handleSigmaChange} className="adjustment-slider-input" />
            <div className="num-input-row"><input type="number" min="1" max="5" step="0.5" value={sigma} onChange={handleSigmaNumberChange} className="adjustment-number-input" /></div>
            <div className="adjustment-unit">级</div>
          </div>
        </div>
      </div>
    )}

    <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleGradientModify} title={helpTexts.adjustment.gradientModify}>梯度修改</div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className={sliderLabelClass('gradientRelaxStrength', 'adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'gradientRelaxStrength', gradientRelaxStrength)} title={helpTexts.adjustment.gradientRelax}>程度</div>
        <div className="unit-container">
          <RangeSlider min={-10} max={10} step={1} value={gradientRelaxStrength} onChange={handleGradientRelaxStrengthChange} className="adjustment-slider-input" />
          <div className="num-input-row"><input type="number" min="-10" max="10" step="1" value={gradientRelaxStrength} onChange={handleGradientRelaxStrengthNumberChange} className="adjustment-number-input" /></div>
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleSpecialSharpen} title={helpTexts.adjustment.specialSharpen}>特殊锐化</div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className={sliderLabelClass('specialSharpenStrength', 'adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'specialSharpenStrength', specialSharpenStrength)} title={helpTexts.adjustment.specialSharpenStrength}>强度</div>
        <div className="unit-container">
          <RangeSlider min={1} max={10} step={0.5} value={specialSharpenStrength} onChange={handleSpecialSharpenStrengthChange} className="adjustment-slider-input" />
          <div className="num-input-row"><input type="number" min="1" max="10" step="0.5" value={specialSharpenStrength} onChange={handleSpecialSharpenStrengthNumberChange} className="adjustment-number-input" /></div>
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleHighFrequencyEnhancement} title={helpTexts.adjustment.highFreq}>高频增强</div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className={sliderLabelClass('highFreqIntensity', 'adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'highFreqIntensity', highFreqIntensity)} title={helpTexts.adjustment.highFreqIntensity}>强度</div>
        <div className="unit-container">
          <RangeSlider min={1} max={10} step={0.5} value={highFreqIntensity} onChange={handleHighFreqIntensityChange} className="adjustment-slider-input" />
          <div className="num-input-row"><input type="number" min="1" max="10" step="0.5" value={highFreqIntensity} onChange={handleHighFreqIntensityNumberChange} className="adjustment-number-input" /></div>
          <div className="adjustment-unit">级</div>
        </div>
      </div>
      <div className="adjustment-slider-item">
        <div className={sliderLabelClass('highFreqRange', 'adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'highFreqRange', highFreqRange)} title={helpTexts.adjustment.highFreqRange}>范围</div>
        <div className="unit-container">
          <RangeSlider min={1} max={10} step={0.5} value={highFreqRange} onChange={handleHighFreqRangeChange} className="adjustment-slider-input" />
          <div className="num-input-row"><input type="number" min="1" max="10" step="0.5" value={highFreqRange} onChange={handleHighFreqRangeNumberChange} className="adjustment-number-input" /></div>
          <div className="adjustment-unit">级</div>
        </div>
      </div>
    </div>
  </div>
);

const renderEdgeProcessingContent = () => (
  <div className="adjustment-section">
    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleSmartEdgeSmooth} title={helpTexts.adjustment.edgeSmooth}>边缘平滑</div>

    <div className="adjustment-slider-container adjustment-slider-container-vpad">
      <div className="adjustment-slider-item adjustment-slider-item-no-gap adjustment-slider-item">
        {/* 下拉行：标签不可拖拽，光标保持 default（与可拖拽滑块标签区分） */}
        <div className="adjustment-slider-label adjustment-slider-label-static" title={helpTexts.adjustment.edgeSmoothMode}>平滑模式</div>
        <div className="unit-container">
          <Select
            value={edgeSmoothMode}
            onChange={handleEdgeSmoothModeChange}
            className="adjustment-smooth-mode-select"
            title={helpTexts.adjustment.edgeSmoothModeSelect}
            showCheck
            placeholder=""
            options={[
              { value: 'edge', label: '仅色块边界' },
              { value: 'line', label: '仅主线条' },
            ]}
          />
        </div>
      </div>

      {edgeSmoothMode === 'edge' && (
        <>
          <div className="adjustment-slider-item">
            <div className={sliderLabelClass('edgeMedianRadius', 'wider-adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'edgeMedianRadius', edgeMedianRadius)} title={helpTexts.adjustment.edgeMedianRadius}>中间值半径</div>
            <div className="unit-container">
              <RangeSlider min={10} max={30} step={1} value={edgeMedianRadius} onChange={handleEdgeMedianRadiusChange} className="adjustment-slider-input" />
              <div className="num-input-row"><input type="number" min="10" max="30" step="1" value={edgeMedianRadius} onChange={handleEdgeMedianRadiusNumberChange} className="adjustment-number-input" /></div>
              <div className="adjustment-unit">px</div>
            </div>
          </div>
        </>
      )}

      {edgeSmoothMode === 'line' && (
        <>
          <div className="adjustment-slider-item">
            <div className={sliderLabelClass('edgeLineStrength', 'wide-adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'edgeLineStrength', edgeLineStrength)} title={helpTexts.adjustment.edgeLineStrength}>平滑力度</div>
            <div className="unit-container">
              <RangeSlider min={0} max={100} step={1} value={edgeLineStrength} onChange={handleEdgeLineStrengthChange} className="adjustment-slider-input" />
              <div className="num-input-row"><input type="number" min="0" max="100" step="1" value={edgeLineStrength} onChange={handleEdgeLineStrengthNumberChange} className="adjustment-number-input" /></div>
              <div className="adjustment-unit">%</div>
            </div>
          </div>

          <div className="adjustment-slider-item">
            <div className={sliderLabelClass('edgeLineSmoothRadius', 'wide-adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'edgeLineSmoothRadius', edgeLineSmoothRadius)} title={helpTexts.adjustment.edgeLineRange}>平滑范围</div>
            <div className="unit-container">
              <RangeSlider min={3} max={12} step={1} value={edgeLineSmoothRadius} onChange={handleEdgeLineSmoothRadiusChange} className="adjustment-slider-input" />
              <div className="num-input-row"><input type="number" min="3" max="12" step="1" value={edgeLineSmoothRadius} onChange={handleEdgeLineSmoothRadiusNumberChange} className="adjustment-number-input" /></div>
              <div className="adjustment-unit">px</div>
            </div>
          </div>

        </>
      )}
    </div>

    <div className="adjustment-divider"></div>

    {/* 2×2 按钮组：四颗统一 .adjustment-button-quad(92px) 保证左右两列严格对齐；
        仅第一行底部留 10px 与下一行分隔，第二行不加 */}
    <div className="adjustment-double-buttons adjustment-double-buttons-mb">
      <div role="button" tabIndex={0} className="adjustment-button adjustment-button-quad" onClick={() => handleAlphaAlign(false, 'down')} title={helpTexts.adjustment.alphaDown}>alpha下对齐</div>

      <div role="button" tabIndex={0} className="adjustment-button adjustment-button-quad" onClick={() => handleAlphaAlign(false, 'up')} title={helpTexts.adjustment.alphaUp}>alpha上对齐</div>
    </div>

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button adjustment-button-quad" onClick={() => handleAlphaAlign(true, 'down')} title={helpTexts.adjustment.alphaBgDown}>保底下对齐</div>

      <div role="button" tabIndex={0} className="adjustment-button adjustment-button-quad" onClick={handleLineEnhancement} title={helpTexts.adjustment.lineEnhance}>线条加黑</div>
    </div>
  </div>
);

/** 同步原因 → 用户可读的中文说明（面板直接展示，无需查 console）。 */
const formatSyncState = (task: MaskSyncTask): { text: string; ok: boolean } | null => {
  const st = maskSyncResults[task.id];
  if (!st) return null;
  const timeStr = new Date(st.time).toLocaleTimeString('zh-CN', { hour12: false });
  if (st.synced) {
    return { text: `已写入蒙版 ${timeStr}`, ok: true };
  }
  const reasons: Record<string, string> = {
    incomplete: '未配置完成：请选择样本图层、通道与目标蒙版',
    'no-channel': '未选择通道',
    disabled: '同步开关未开启',
    throttled: '同步过于频繁，已节流跳过',
    unchanged: '通道内容已匹配目标蒙版，无需写入',
    'no-doc-size': '无法获取文档尺寸',
    'layer-not-found': '样本图层不存在（可能已被删除）',
    'layer-bounds-failed': '无法获取样本图层边界',
    'empty-layer': '样本图层为空（无像素内容）',
    'mask-unavailable': '目标图层无蒙版或蒙版不可用',
    'target-locked': '目标蒙版上锁，无法同步',
    'sample-pixels-failed': '样本像素读取失败',
    'unsupported-components': '样本像素通道数异常（非 RGB/RGBA）',
    error: '执行出错（见控制台）',
  };
  let text = reasons[st.reason] || st.reason;
  if (st.detail && st.reason !== 'error') text += `：${st.detail}`;
  // 「未改动」「节流跳过」属于中性常态（没有写入需求），不标红，避免制造焦虑；
  // 仅当确实出现配置/执行错误时才标红（fail 样式）。
  const benign = st.reason === 'unchanged' || st.reason === 'throttled';
  return { text: `${text}（${timeStr}）`, ok: benign };
};

const renderMaskSyncContent = () => (
  <div className="mask-sync-section">
    {/* 不再复用 .adjustment-section：它自带 border + padding，会在「引擎状态条」与
        「卡片总容器 A」之外再套一层可见的大容器。改用 .mask-sync-section，
        仅保留内边距/宽度/间距，无边框，外面不再有可见的框 */}
    {/* 引擎状态条：确认插件已加载最新代码。绿点+引擎就绪 左对齐，文档名+任务数 右对齐。
        已挪到「卡片大容器」外部（上方），不再包裹在任务卡片列表里 */}
    <div className="mask-sync-status-bar">
      <span className={`mask-sync-status-dot ${maskSyncEngineReady ? 'ok' : 'warn'}`} />
      <span className="mask-sync-status-ready">
        {maskSyncEngineReady ? '引擎就绪' : '引擎初始化中…'}
      </span>
      {maskSyncEngineReady && (
        maskSyncEngine.getDocName()
          ? <span className="mask-sync-status-info">{maskSyncEngine.getDocName()}</span>
          : <span className="mask-sync-status-info idle" title="未打开文档时蒙版同步不运行，属正常状态">未打开文档</span>
      )}
    </div>

    {/* 容器 A（边框可见）：仅包裹任务卡片 + 新建按钮；
        引擎状态条 .mask-sync-status-bar 位于其外部上方（不在容器内），
        且引擎状态与容器 A 之外不再套任何有边框的外层容器。
        空态提示也放进容器 A（对齐笔刷热键：空态在边框盒内），保证上下留白对称 */}
    <div className="mask-sync-card-list">
    {maskSyncTasks.length === 0 && (
      <div className="mask-sync-empty">点击 + 新建同步任务</div>
    )}

    {maskSyncTasks.map(task => {
      const sampleEntry = maskSyncSampleOptions.find(o => o.id === task.sampleLayerId);
      const channelOptions = getMaskSyncChannelsForEntry(sampleEntry);
      return (
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
              title={helpTexts.adjustment.maskSyncRename}
            >{task.name}</span>
          )}
        </div>

        <div className="mask-sync-divider" />

        {/* 部分一：样本（图层 + 通道 + 反相） */}
        <div className="mask-sync-row mask-sync-row-close">
          <span className="mask-sync-label">样本</span>
          <Select
            value={task.sampleLayerId != null ? String(task.sampleLayerId) : ''}
            onChange={(v) => handleMaskSyncSampleChange(task, v)}
            onOpen={refreshMaskSyncOptions}
            title={helpTexts.adjustment.maskSyncSampleLayer}
            placeholder=""
            options={maskSyncSampleOptions.map(opt => {
              const { label, tag } = splitLabelTag(opt.label);
              // 像素/调整/背景图层可選；带蒙版的图层组也可作为样本（只能取蒙版通道）
              const selectable = opt.kind === 'pixel' || opt.isAdjustment || opt.isBackground || (opt.kind === 'group' && opt.hasUserMask);
              return { value: String(opt.id), label, tag, disabled: !selectable, depth: opt.depth };
            })}
          />
        </div>

        <div className="mask-sync-row">
          <span className="mask-sync-label">通道</span>
          <Select
            value={task.channel || ''}
            onChange={(v) => handleMaskSyncChannelChange(task, v)}
            showCheck
            placeholder=""
            options={channelOptions.map(ch => ({ value: ch, label: MASK_SYNC_CHANNEL_LABELS[ch] }))}
          />
        </div>

        <div className="mask-sync-divider" />

        {/* 部分二：目标（有蒙版的图层/组）+ 反相 */}
        <div className="mask-sync-row">
          <span className="mask-sync-label">蒙版</span>
          <Select
            value={task.targetLayerId != null ? String(task.targetLayerId) : ''}
            onChange={(v) => handleMaskSyncTargetChange(task, v)}
            onOpen={refreshMaskSyncOptions}
            title={helpTexts.adjustment.maskSyncTargetLayer}
            placeholder=""
            options={maskSyncTargetOptions.map(opt => {
              const { label, tag } = splitLabelTag(opt.label);
              return { value: String(opt.id), label, tag, depth: opt.depth };
            })}
          />
        </div>

        <div className="mask-sync-row mask-sync-invert-row">
          <label
            className="mask-sync-checkbox"
            title={helpTexts.adjustment.maskSyncInvert}
          >
            <span>反相</span>
            <input
              type="checkbox"
              checked={task.invert}
              onChange={(e) => handleMaskSyncInvertChange(task, e.target.checked)}
            />
          </label>
        </div>

        <div className="mask-sync-divider" />

        {/* 上次同步状态（无需 console 即可诊断） */}
        {(() => {
          const st = formatSyncState(task);
          if (!st) return null;
          return (
            <div className={`mask-sync-result ${st.ok ? 'ok' : 'fail'}`}>
              {st.ok && <span className="mask-sync-result-icon">●</span>}
              <span className="mask-sync-result-text">{st.text}</span>
            </div>
          );
        })()}

        {/* 部分三：同步开关 + 立即同步 + 删除 */}
        <div className="mask-sync-footer">
          <div className="adjustment-swtich-container mask-sync-switch">
            <label
              className="adjustment-swtich-label"
              title={helpTexts.adjustment.maskSyncEnabled}
            >同步</label>
            <sp-switch
              checked={task.enabled}
              onChange={(e) => handleMaskSyncEnabledChange(task, (e.target as HTMLInputElement).checked)}
            />
          </div>
          {/* 立即同步：改成与刷新一致的无边框图标按钮（--text-color / 16px），不再显示文字。
              当样本图层 / 通道 / 目标蒙版三下拉任一项未选时禁用（灰 + 不触发同步） */}
          {(() => {
            const syncDisabled = !task.sampleLayerId || !task.channel || !task.targetLayerId;
            return (
              <div
                role="button"
                tabIndex={0}
                className={`hotkey-icon-button${syncDisabled ? ' disabled' : ''}`}
                title={syncDisabled ? helpTexts.adjustment.maskSyncNowDisabled : helpTexts.adjustment.maskSyncNow}
                onClick={() => { if (!syncDisabled) handleMaskSyncNow(task); }}
              >
                <SyncIcon className="icon-16" />
              </div>
            );
          })()}
          {/* 删除：复用笔刷热键的「垃圾桶」图标按钮样式（无边框、透明背景、--text-color） */}
          <div
            role="button"
            tabIndex={0}
            className="hotkey-icon-button"
            onClick={() => handleMaskSyncRemove(task.id)}
            title={helpTexts.adjustment.maskSyncDelete}
          >
            <DeleteIcon className="icon-16" />
          </div>
        </div>
      </div>
      );
    })}

    {/* 新建同步任务按钮：位于容器 A（卡片大容器）底部 */}
    <div className="mask-sync-add-row">
      <sp-action-button quiet class="mask-sync-add-button" onClick={handleMaskSyncAdd} title={helpTexts.adjustment.maskSyncAdd}>
        <AddIcon />
      </sp-action-button>
    </div>
    </div>
  </div>
);

/** 虚线分割线（同层补色 与 分层补色 之间）。
 *  UXP 对 CSS 背景/边框高级特性支持不可靠（linear-gradient+var() 整条不渲染、
 *  background-repeat: repeat-x 只渲染一次），因此改用纯 DOM 方案：
 *  一段 6px 短线 + 6px 空（12px 周期）的 span 序列 + flex 排列 + overflow 裁剪，
 *  短线颜色读取主题 --border-color。 */
const DashedDivider: React.FC = () => {
  const [borderColor, setBorderColor] = useState('rgb(128, 128, 128)');
  useEffect(() => {
    try {
      const bc =
        (getComputedStyle(document.documentElement).getPropertyValue('--border-color') || '').trim();
      if (bc) setBorderColor(bc);
    } catch {
      // 读取失败：保持默认灰
    }
  }, []);
  // 60 段 × 12px = 720px，足以覆盖任意面板宽度（多余部分被 overflow 裁掉）
  return (
    <div className="adjustment-dashed-divider">
      {Array.from({ length: 60 }, (_, i) => (
        <span key={i} className="adjustment-dashed-divider-dash" style={{ backgroundColor: borderColor }} />
      ))}
    </div>
  );
};

// 扣白 / 扣黑（batchPlay 版，替代原像素级算法）：
// 复刻手动验证的方案 —— 载入 RGB 复合通道亮度选区（Ctrl+点击）→ Delete 清除亮部
// → 复制 N 份合并增强 alpha。扣黑用反色法（Invert→扣白流程→Invert）纠正“偏暗”，
// N 按内容亮度动态计算。仅普通像素图层可用；背景图层直接警告并终止。
const handleKnockout = async (mode: 'white' | 'black') => {
  if (!handleLicenseBeforeAction()) return;
  const label = mode === 'white' ? '白' : '黑';
  try {
    const { executeAsModal } = core;
    await executeAsModal(async () => {
      const editingState = await checkEditingState();
      if (!editingState.isValid) return;
      const { isBackgroundLayer } = editingState;

      // 仅普通像素图层可用，背景图层弹出警告并终止
      if (isBackgroundLayer) {
        await core.showAlert({ message: `扣${label}功能仅支持普通像素图层，不能用于背景图层。` });
        return;
      }

      await runWithTemporaryUnlock(async () => {
        // batchPlay 原生流程：反色(仅扣黑) → 载入亮度选区 → Clear → 复制N份合并 → 反色(仅扣黑)
        await runKnockoutBatch(mode);
      });
    });
    giveFocusBackToPS();
  } catch (error) {
    const msg = typeof error === 'string' ? error : (error && (error.message || (error as any).toString?.() || '未知错误'));
    console.error(`❌ 扣${label}处理失败:`, error);
    try { await core.showAlert({ message: `扣${label}处理失败: ` + msg }); } catch {}
  }
};

const handleKnockoutWhite = () => handleKnockout('white');
const handleKnockoutBlack = () => handleKnockout('black');

const renderQuickActionContent = () => (
  <div className="adjustment-section">

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button" onClick={handleBlockAverage} title={helpTexts.adjustment.blockAverage}>分块平均</div>
      
      <div className="adjustment-swtich-container">
        <label 
          className="adjustment-swtich-label"
          onClick={() => setUseWeightedAverage(!useWeightedAverage)}
          title={helpTexts.adjustment.weightedMode}
        >加权模式</label>
        <sp-switch 
          checked={useWeightedAverage}
          onChange={(e) => setUseWeightedAverage(e.target.checked)}
        />
      </div>
    </div>

    {useWeightedAverage && (
      <div className="adjustment-slider-container">
        <div className="adjustment-slider-item">
          <div className={sliderLabelClass('weightedIntensity', 'adjustment-slider-label')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'weightedIntensity', weightedIntensity)} title={helpTexts.adjustment.weightedIntensity}>强度</div>
          <div className="unit-container">
            <RangeSlider min={1} max={10} step={0.5} value={weightedIntensity} onChange={handleWeightedIntensityChange} className="adjustment-slider-input" />
            <div className="num-input-row"><input type="number" min="1" max="10" step="0.5" value={weightedIntensity} onChange={handleWeightedIntensityNumberChange} className="adjustment-number-input" /></div>
            <div className="adjustment-unit">级</div>
          </div>
        </div>
      </div>
    )}

    <div className="adjustment-divider"></div>

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleBlockGradient} title={helpTexts.adjustment.blockGradient}>分块渐变</div>

    <div className="adjustment-divider"></div>

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button adjustment-button-7" onClick={handleBlockColorPatchLightLine} title={helpTexts.adjustment.patchLightLine}>浅线同层补色</div>

      <div role="button" tabIndex={0} className="adjustment-button adjustment-button-7" onClick={handleBlockColorPatchDarkLine} title={helpTexts.adjustment.patchDarkLine}>深线同层补色</div>
    </div>

    {/* 虚线分割线：同层补色 与 分层补色 之间（JS 拼渐变渲染，短线/空各 6px） */}
    <DashedDivider />

    <div role="button" tabIndex={0} className="adjustment-button" onClick={handleBlockColorPatchLayered} title={helpTexts.adjustment.patchLayered}>分层补色</div>

    <div className="adjustment-slider-container adjustment-slider-container-vpad">
      <div className="adjustment-slider-item adjustment-slider-item-no-gap">
        {/* 下拉行：标签不可拖拽，光标保持 default（原为 pointer，语义错误） */}
        <div className="adjustment-slider-label adjustment-slider-label-static" title={helpTexts.adjustment.lineReference}>线稿参考</div>
        <div className="unit-container">
          <Select
            value={lineReferenceLayerId ? String(lineReferenceLayerId) : 'auto'}
            onChange={handleLineReferenceSelect}
            placeholder=""
            options={[
              { value: 'auto', label: '自动', tag: '上方像素层' },
              ...lineReferenceOptions.map(opt => {
                const s = splitLabelTag(opt.label);
                return { value: opt.value, label: s.label, tag: s.tag, depth: opt.depth, disabled: opt.disabled };
              })
            ]}
            showCheck
            title={helpTexts.adjustment.lineReferenceSelect}
            className="adjustment-smooth-mode-select"
          />
        </div>
      </div>
    </div>

    <div className="adjustment-divider"></div>

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button" onClick={() => handleSpecialWoodcut(false)} title={helpTexts.adjustment.woodcut}>特殊木刻</div>

      <div role="button" tabIndex={0} className="adjustment-button adjustment-button-lv2" onClick={resetSpecialWoodcutParams} title={helpTexts.adjustment.woodcutReset}>重置</div>
    </div>

    <div className="adjustment-slider-container">
      <div className="adjustment-slider-item">
        <div className={sliderLabelClass('specialWoodcutLevels', 'adjustment-slider-label adjustment-slider-label-3')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'specialWoodcutLevels', specialWoodcutLevels)} title={helpTexts.adjustment.woodcutLevels}>色阶数</div>
        <div className="unit-container">
          <RangeSlider min={2} max={16} step={1} value={specialWoodcutLevels} onChange={handleSpecialWoodcutLevelsChange} className="adjustment-slider-input" />
          <div className="num-input-row"><input type="number" min="2" max="16" step="1" value={specialWoodcutLevels} onChange={handleSpecialWoodcutLevelsNumberChange} className="adjustment-number-input" /></div>
          <div className="adjustment-unit">级</div>
        </div>
      </div>

      <div className="adjustment-slider-item">
        <div className={sliderLabelClass('specialWoodcutEdgeThreshold', 'adjustment-slider-label adjustment-slider-label-4')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'specialWoodcutEdgeThreshold', specialWoodcutEdgeThreshold)} title={helpTexts.adjustment.woodcutEdgeThreshold}>边缘阈值</div>
        <div className="unit-container">
          <RangeSlider min={0} max={255} step={1} value={specialWoodcutEdgeThreshold} onChange={handleSpecialWoodcutEdgeThresholdChange} className="adjustment-slider-input" />
          <div className="num-input-row"><input type="number" min="0" max="255" step="1" value={specialWoodcutEdgeThreshold} onChange={handleSpecialWoodcutEdgeThresholdNumberChange} className="adjustment-number-input" /></div>
          <div className="adjustment-unit">值</div>
        </div>
      </div>

      <div className="adjustment-slider-item">
        <div className={sliderLabelClass('specialWoodcutEdgeStrength', 'adjustment-slider-label adjustment-slider-label-4')} onMouseDown={(e) => onSliderLabelMouseDown(e, 'specialWoodcutEdgeStrength', specialWoodcutEdgeStrength)} title={helpTexts.adjustment.woodcutEdgeStrength}>边缘强度</div>
        <div className="unit-container">
          <RangeSlider min={0} max={100} step={1} value={specialWoodcutEdgeStrength} onChange={handleSpecialWoodcutEdgeStrengthChange} className="adjustment-slider-input" />
          <div className="num-input-row"><input type="number" min="0" max="100" step="1" value={specialWoodcutEdgeStrength} onChange={handleSpecialWoodcutEdgeStrengthNumberChange} className="adjustment-number-input" /></div>
          <div className="adjustment-unit">%</div>
        </div>
      </div>
    </div>
    
    <div className="adjustment-swtich-container adjustment-swtich-align-left">
        <label
          className="adjustment-swtich-label"
          onClick={() => setSpecialWoodcutPreview(!specialWoodcutPreview)}
          title={helpTexts.adjustment.woodcutPreview}
        >预览</label>
        <sp-switch
          checked={specialWoodcutPreview}
          onChange={(e) => setSpecialWoodcutPreview(e.target.checked)}
        />
    </div>

    <div className="adjustment-divider"></div>

    <div className="adjustment-double-buttons">
      <div role="button" tabIndex={0} className="adjustment-button adjustment-button-lv2" onClick={handleKnockoutWhite} title={helpTexts.adjustment.knockoutWhite}>扣白</div>
      <div role="button" tabIndex={0} className="adjustment-button adjustment-button-lv2" onClick={handleKnockoutBlack} title={helpTexts.adjustment.knockoutBlack}>扣黑</div>
    </div>
  </div>
);

// 渲染整个分区
const renderSectionContent = (sectionId: string) => {
  if (sectionId === 'quickAction') return renderQuickActionContent();
  if (sectionId === 'detailAdjust') return renderDetailAdjustContent();
  if (sectionId === 'edgeProcessing') return renderEdgeProcessingContent();
  if (sectionId === 'maskSync') return renderMaskSyncContent();
  if (sectionId === 'brushHotkey') return <BrushHotkeySection />;
  return null;
};

const renderSection = (section: SectionConfig) => (
  <div key={section.id} className={
    'adjust-expand-section' +
    (dragSourceId === section.id ? ' dragging' : '') +
    (dragOverId === section.id && dragSourceId !== section.id ? ' drop-target' : '')
  }>
    <div className="adjust-expand-header"
         draggable
         onDragStart={(e)=>handleDragStart(e, section.id)}
         onDragOver={(e)=>handleDragOver(e, section.id)}
         onDragEnd={handleDragEnd}
         onDrop={(e)=>handleDrop(e, section.id)}
         onClick={()=>toggleSectionCollapse(section.id)}
         title={section.id === 'brushHotkey' ? helpTexts.hotkey.header : undefined}
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

const licenseLocked = licenseChecked && !isLicensed && !isTrial;

/* 激活提示卡片节点：试用中 或 未激活且试用已结束 时显示 */
const bannerNode = (isTrial || (!isLicensed && !isTrial && trialDaysRemaining === 0)) ? (
  <div className={`license-status-banner ${isTrial ? 'is-trial' : 'is-expired'}`}>
    {isTrial && trialDaysRemaining > 0 ? (
      <>
        <span className="badge-dot" />
        <span className="trial-status">试用还剩 {trialDaysRemaining} 天</span>
      </>
    ) : (
      <>
        <span className="badge-dot danger" />
        <span className="trial-expired">需要在选区填充面板激活</span>
      </>
    )}
  </div>
) : null;

return (
  <div className="adjustment-container" ref={rootRef}>
    {/*
     * 激活提示卡片 + 锁定遮罩（2026-08-31 二次定稿）：
     * ⚠️ 卡片必须永远留在普通文档流里渲染，绝不能塞进 position:fixed 的遮罩内部。
     *    原因：fixed 遮罩的包含块比普通内容区更宽（不扣右侧滚动条），
     *    卡片一旦进遮罩，右缘就会整体右移、被滚动条压住——
     *    margin-right/width 怎么补都不对（实测 50% 宽度时右缘也异常右移，可复现）。
     *    而未锁定时卡片在普通文档流里的边距实测是正确的，所以两边统一用文档流。
     * 遮罩改为「从卡片下方开始」：top = 容器 padding-top 10 + 卡片高 30 + 下边距 6 = 46px，
     * 卡片区域不被遮罩盖住（它本来就要可见），遮罩照样盖住下方全部内容。
     * 卡片不是可编辑控件（无 input），顶部 46px 不遮不拦没有副作用；
     * 可编辑控件仍由 body.adjustment-lock-open 统一隐藏（见 adjustment-input.css）。
     */}
    {bannerNode}
    {licenseLocked && (
      <div
        className="adjustment-lock-overlay"
        style={
          bannerNode
            ? { top: '46px', height: 'calc(100% - 46px)' }
            : { top: '10px', height: 'calc(100% - 10px)' }
        }
      />
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
