import React, { useState, useEffect, useRef } from 'react';
import { Gradient, GradientStop } from '../types/state';
import { AddIcon, DeleteIcon } from '../styles/Icons';
import IconButton from '../components/IconButton';
import { LayerInfoHandler } from '../utils/LayerInfoHandler';
import { debouncePsProbe, markPsBusyForEvent, runWhenIdle } from '../utils/psProbe';
import { addPsNotificationListeners, removePsNotificationListeners } from '../utils/psAccess';
import { PresetManager } from '../utils/PresetManager';
import { pickColorWithInitial } from '../utils/ColorPicker';
import { parseCssRgb } from '../utils/ColorUtils';
import { calcDragValue } from '../utils/dragSensitivity';
import RangeSlider from './RangeSlider';
import Select from './Select';
import { helpTexts } from '../constants/helpTexts';

interface GradientPickerProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (gradient: Gradient | null) => void;
    isClearMode?: boolean;
    /**
     * 父面板「参数复位」信号（自增计数）。本面板参数（类型/角度/缩放/反向/色标/透明度）
     * 活在自己的 state 里，父面板复位管不到 ⇒ 靠它回到默认值。
     * ⚠️ 复位**不动presets**（预设列表）：预设是用户资产，不是参数。
     * 首次挂载为 0，用 prevResetTokenRef 跳过第一次。
     */
    resetToken?: number;
}

/**
 * 灰色显示态判定：清除模式 / 图层蒙版 / 快速蒙版 / 单通道（红绿蓝·Alpha）编辑时，
 * 颜色落到画布上的实际效果都是灰度 ⇒ 面板内的色板、渐变预览条、预设缩略图一律按灰度显示。
 * 四个标志统一走这一个判定，避免各处条件漂移。
 */
const isGrayDisplayMode = (
    isClearMode: boolean,
    isInLayerMask: boolean,
    isInQuickMask: boolean,
    isInSingleColorChannel: boolean
): boolean => isClearMode || isInLayerMask || isInQuickMask || isInSingleColorChannel;

/**
 * 面板色板显示色（纯函数，模块级 —— 禁止下沉进组件体内，es5 下 `const` 提升会导致白屏）。
 *   · 普通模式：原色 `#rrggbb`；
 *   · 灰色态：按 0.299/0.587/0.114 转灰度（口径与渐变预览条 / 预设缩略图完全一致）。
 * ⚠️ 只影响**显示**，不改动 stops 里存着的真实颜色；退出灰色态后自然恢复彩色。
 */
const getDisplayColorHex = (cssColor: string, gray: boolean): string => {
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(cssColor || '');
    if (!m) return 'rgb(0, 0, 0)';
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    if (!gray) return `#${hex(r)}${hex(g)}${hex(b)}`;
    const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    return `#${hex(v)}${hex(v)}${hex(v)}`;
};

// 生成考虑中点插值的预设预览样式
const generatePresetPreviewStyle = (preset: Gradient, isInLayerMask: boolean = false, isInQuickMask: boolean = false, isInSingleColorChannel: boolean = false, isClearMode: boolean = false): string => {
    // 为预设创建临时的扩展stops
    const extendedStops = preset.stops.map((stop, i) => ({
        ...stop,
        colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
        opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
        midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < preset.stops.length - 1 ? 50 : undefined),
        opacityMidpoint: stop.opacityMidpoint !== undefined ? stop.opacityMidpoint : (i < preset.stops.length - 1 ? 50 : undefined)
    }));
    
    const sortedColorStops = [...extendedStops].sort((a, b) => a.colorPosition - b.colorPosition);
    const sortedOpacityStops = [...extendedStops].sort((a, b) => a.opacityPosition - b.opacityPosition);
    
    // 采样生成渐变stops
    const sampleStep = 10; // 每10%采样一次，减少计算量
    const gradientStops: string[] = [];
    
    for (let i = 0; i <= 100; i += sampleStep) {
        const rgb = interpolateColorAtPositionForPreset(i, sortedColorStops);
        const alpha = interpolateOpacityAtPositionForPreset(i, sortedOpacityStops);
        
        if (isClearMode || isInLayerMask || isInQuickMask || isInSingleColorChannel) {
            // 清除模式、图层蒙版模式、快速蒙版模式或单个颜色通道模式：转换为灰度值
            const gray = Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
            const a = alpha.toFixed(3);
            gradientStops.push(`rgba(${gray}, ${gray}, ${gray}, ${a}) ${i}%`);
        } else {
            // 普通模式：使用原始RGB颜色
            const r = Math.round(rgb.r);
            const g = Math.round(rgb.g);
            const b = Math.round(rgb.b);
            const a = alpha.toFixed(3);
            gradientStops.push(`rgba(${r}, ${g}, ${b}, ${a}) ${i}%`);
        }
    }
    
    // 应用reverse效果
    const displayStops = preset.reverse
        ? gradientStops.map(stop => {
            const match = stop.match(/^(.+)\s+(\d+(?:\.\d+)?)%$/);
            if (match) {
                const color = match[1];
                const position = parseFloat(match[2]);
                return `${color} ${100 - position}%`;
            }
            return stop;
        }).reverse()
        : gradientStops;
    
    return preset.type === 'radial' 
        ? `radial-gradient(circle, ${displayStops.join(', ')})`
        : `linear-gradient(${(preset.angle || 0) + 90}deg, ${displayStops.join(', ')})`;
};

// 预设预览的颜色插值函数
const interpolateColorAtPositionForPreset = (position: number, colorStops: any[]) => {
    const rgbaRegex = /rgba?\((\d+),\s*(\d+),\s*(\d+)/;
    
    let leftStop = colorStops[0];
    let rightStop = colorStops[colorStops.length - 1];
    
    for (let i = 0; i < colorStops.length - 1; i++) {
        if (colorStops[i].colorPosition <= position && colorStops[i + 1].colorPosition >= position) {
            leftStop = colorStops[i];
            rightStop = colorStops[i + 1];
            break;
        }
    }
    
    if (leftStop.colorPosition === rightStop.colorPosition) {
        const rgbaMatch = leftStop.color.match(rgbaRegex);
        if (rgbaMatch) {
            return {
                r: parseInt(rgbaMatch[1]),
                g: parseInt(rgbaMatch[2]),
                b: parseInt(rgbaMatch[3])
            };
        }
        return { r: 0, g: 0, b: 0 };
    }
    
    let ratio = (position - leftStop.colorPosition) / (rightStop.colorPosition - leftStop.colorPosition);
    
    // 应用中点调整
    const midpoint = (leftStop.midpoint || 50) / 100;
    if (midpoint !== 0.5) {
        if (ratio < midpoint) {
            ratio = (ratio / midpoint) * 0.5;
        } else {
            ratio = 0.5 + ((ratio - midpoint) / (1 - midpoint)) * 0.5;
        }
    }
    
    const leftRgba = leftStop.color.match(rgbaRegex);
    const rightRgba = rightStop.color.match(rgbaRegex);
    
    if (leftRgba && rightRgba) {
        const leftR = parseInt(leftRgba[1]);
        const leftG = parseInt(leftRgba[2]);
        const leftB = parseInt(leftRgba[3]);
        const rightR = parseInt(rightRgba[1]);
        const rightG = parseInt(rightRgba[2]);
        const rightB = parseInt(rightRgba[3]);
        
        return {
            r: leftR * (1 - ratio) + rightR * ratio,
            g: leftG * (1 - ratio) + rightG * ratio,
            b: leftB * (1 - ratio) + rightB * ratio
        };
    }
    
    return { r: 0, g: 0, b: 0 };
};

// 预设预览的透明度插值函数
const interpolateOpacityAtPositionForPreset = (position: number, opacityStops: any[]) => {
    let leftStop = opacityStops[0];
    let rightStop = opacityStops[opacityStops.length - 1];
    
    for (let i = 0; i < opacityStops.length - 1; i++) {
        if (opacityStops[i].opacityPosition <= position && opacityStops[i + 1].opacityPosition >= position) {
            leftStop = opacityStops[i];
            rightStop = opacityStops[i + 1];
            break;
        }
    }
    
    if (leftStop.opacityPosition === rightStop.opacityPosition) {
        const rgbaMatch = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        return rgbaMatch && rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
    }
    
    let ratio = (position - leftStop.opacityPosition) / (rightStop.opacityPosition - leftStop.opacityPosition);
    
    // 应用中点调整
    const midpoint = (leftStop.opacityMidpoint || 50) / 100;
    if (midpoint !== 0.5) {
        if (ratio < midpoint) {
            ratio = (ratio / midpoint) * 0.5;
        } else {
            ratio = 0.5 + ((ratio - midpoint) / (1 - midpoint)) * 0.5;
        }
    }
    
    const leftOpacity = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)?.[4];
    const rightOpacity = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)?.[4];
    
    const leftAlpha = leftOpacity !== undefined ? parseFloat(leftOpacity) : 1;
    const rightAlpha = rightOpacity !== undefined ? parseFloat(rightOpacity) : 1;
    
    return leftAlpha * (1 - ratio) + rightAlpha * ratio;
};

// 扩展GradientStop类型以支持独立的颜色和透明度位置
interface ExtendedGradientStop extends GradientStop {
    colorPosition: number;    // 颜色stop的位置
    opacityPosition: number;  // 透明度stop的位置
    midpoint?: number;        // 颜色stop与下一个stop之间的中点位置
    opacityMidpoint?: number; // 透明度stop与下一个stop之间的中点位置
}

/* ==========================================================================
   颜色 / 透明度插值（模块级纯函数，2026-10-06 从组件体内提到这里）
   --------------------------------------------------------------------------
   提到模块级的原因（**TDZ 白屏隐患**，与 AdjustmentPanel 那次同源）：
   组件体内的 `getPreviewGradientStyle`（预览渐变的 style 生成器）会调用
   `interpolateColorAtPosition` / `interpolateOpacityAtPosition`，而这两个 const
   当时声明在**它下方**。ts-loader 按 es5 转译把 const 降级为 var（提升但值为
   undefined）⇒ 一旦有人把 getPreviewGradientStyle() 改成在组件体顶层同步调用
   （例如 `const style = getPreviewGradientStyle()`），预览条就会抛
   「TypeError: interpolateColorAtPosition is not a function」。

   原先只是「侥幸安全」——因为唯一的调用点在 return 之后的 JSX 里
   （此时组件体早已执行完毕）。这种靠调用位置躲过 TDZ 的模式极脆弱，
   必须从结构上消除：四个东西都只依赖入参、不读任何组件 state，本就该在模块级。

   ⚠️ 与上面的 `interpolate*AtPositionForPreset` **算法同构但不可合并**：
   那两个用 `any[]`，且透明度正则的 alpha 组是**可选**的
   （`/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/`，兼容无 alpha 的 rgb()）；
   下面这两个用 `ExtendedGradientStop[]`，透明度正则的 alpha 组是**必需的**
   （`/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/`）。语义有别，保持各自独立。 */

// 正则提到模块级：常量字面量每次渲染重建没有收益，且插值函数在模块级需要它们先就绪。
const GRADIENT_RGBA_REGEX = /rgba?\((\d+),\s*(\d+),\s*(\d+)/;
const GRADIENT_RGBA_WITH_ALPHA_REGEX = /rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/;

// 优化的颜色插值函数 - 减少重复计算
const interpolateColorAtPosition = (position: number, colorStops: ExtendedGradientStop[]) => {
    // 找到位置两侧的color-stop
    let leftStop = colorStops[0];
    let rightStop = colorStops[colorStops.length - 1];

    for (let i = 0; i < colorStops.length - 1; i++) {
        if (colorStops[i].colorPosition <= position && colorStops[i + 1].colorPosition >= position) {
            leftStop = colorStops[i];
            rightStop = colorStops[i + 1];
            break;
        }
    }

    // 如果位置相同，直接返回左侧stop的颜色
    if (leftStop.colorPosition === rightStop.colorPosition) {
        const rgbaMatch = leftStop.color.match(GRADIENT_RGBA_REGEX);
        if (rgbaMatch) {
            return {
                r: parseInt(rgbaMatch[1]),
                g: parseInt(rgbaMatch[2]),
                b: parseInt(rgbaMatch[3])
            };
        }
        return { r: 0, g: 0, b: 0 };
    }

    // 计算基础插值比例
    let ratio = (position - leftStop.colorPosition) / (rightStop.colorPosition - leftStop.colorPosition);

    // 应用中点调整
    const midpoint = (leftStop.midpoint || 50) / 100;
    if (midpoint !== 0.5) {
        if (ratio < midpoint) {
            ratio = (ratio / midpoint) * 0.5;
        } else {
            ratio = 0.5 + ((ratio - midpoint) / (1 - midpoint)) * 0.5;
        }
    }

    // 插值RGB颜色
    const leftRgba = leftStop.color.match(GRADIENT_RGBA_REGEX);
    const rightRgba = rightStop.color.match(GRADIENT_RGBA_REGEX);

    if (leftRgba && rightRgba) {
        const leftR = parseInt(leftRgba[1]);
        const leftG = parseInt(leftRgba[2]);
        const leftB = parseInt(leftRgba[3]);
        const rightR = parseInt(rightRgba[1]);
        const rightG = parseInt(rightRgba[2]);
        const rightB = parseInt(rightRgba[3]);

        return {
            r: leftR * (1 - ratio) + rightR * ratio,
            g: leftG * (1 - ratio) + rightG * ratio,
            b: leftB * (1 - ratio) + rightB * ratio
        };
    }

    return { r: 0, g: 0, b: 0 };
};

// 优化的透明度插值函数 - 减少重复计算
const interpolateOpacityAtPosition = (position: number, opacityStops: ExtendedGradientStop[]) => {
    // 找到位置两侧的opacity-stop
    let leftStop = opacityStops[0];
    let rightStop = opacityStops[opacityStops.length - 1];

    for (let i = 0; i < opacityStops.length - 1; i++) {
        if (opacityStops[i].opacityPosition <= position && opacityStops[i + 1].opacityPosition >= position) {
            leftStop = opacityStops[i];
            rightStop = opacityStops[i + 1];
            break;
        }
    }

    // 如果位置相同，直接返回左侧stop的透明度
    if (leftStop.opacityPosition === rightStop.opacityPosition) {
        const rgbaMatch = leftStop.color.match(GRADIENT_RGBA_WITH_ALPHA_REGEX);
        return rgbaMatch ? parseFloat(rgbaMatch[4]) : 1;
    }

    // 计算基础插值比例
    let ratio = (position - leftStop.opacityPosition) / (rightStop.opacityPosition - leftStop.opacityPosition);

    // 应用中点调整
    const midpoint = (leftStop.opacityMidpoint || 50) / 100;
    if (midpoint !== 0.5) {
        if (ratio < midpoint) {
            ratio = (ratio / midpoint) * 0.5;
        } else {
            ratio = 0.5 + ((ratio - midpoint) / (1 - midpoint)) * 0.5;
        }
    }

    // 插值透明度
    const leftRgba = leftStop.color.match(GRADIENT_RGBA_WITH_ALPHA_REGEX);
    const rightRgba = rightStop.color.match(GRADIENT_RGBA_WITH_ALPHA_REGEX);

    if (leftRgba && rightRgba) {
        const leftAlpha = parseFloat(leftRgba[4]);
        const rightAlpha = parseFloat(rightRgba[4]);
        return leftAlpha * (1 - ratio) + rightAlpha * ratio;
    }

    return 1;
};

// 渐变类型下拉的选项：提到模块级常量，保持引用稳定
// （Select 已用 React.memo 包裹，内联新建数组会让 memo 失效）。
const GRADIENT_TYPE_OPTIONS = [
    { value: 'linear', label: '线性' },
    { value: 'radial', label: '径向' },
];

const GradientPicker: React.FC<GradientPickerProps> = ({
    isOpen,  
    onClose,
    onSelect,
    isClearMode = false,
    resetToken = 0
}) => {
    const [presets, setPresets] = useState<(Gradient & { id?: string; name?: string; preview?: string })[]>([]);
    const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
    const [selectedPresets, setSelectedPresets] = useState<Set<number>>(new Set());
    const [lastClickedPreset, setLastClickedPreset] = useState<number | null>(null);
    const [gradientType, setGradientType] = useState<'linear' | 'radial'>('linear');
    const [angle, setAngle] = useState(0);
    const [reverse, setReverse] = useState(false);
    const [preserveTransparency, setPreserveTransparency] = useState<boolean>(false); // 添加新状态
    const [selectedStopIndex, setSelectedStopIndex] = useState<number | null>(null);
    const [selectedStopType, setSelectedStopType] = useState<'color' | 'opacity'>('color');
    const [stops, setStops] = useState<ExtendedGradientStop[]>([ 
        { color: 'rgba(0, 0, 0, 1)', position: 0, colorPosition: 0, opacityPosition: 0, midpoint: 50, opacityMidpoint: 50 },
        { color: 'rgba(255, 255, 255, 1)', position: 100, colorPosition: 100, opacityPosition: 100, midpoint: 50, opacityMidpoint: 50 }
    ]);
    // 保存控制：加载中标志/防抖定时器/脏标记
    const isLoadingRef = useRef(false);
    const saveTimerRef = useRef<any>(null);
    const dirtyRef = useRef(false);

    // 拖拽排序所需的引用与状态
    const dragPresetIndexRef = useRef<number | null>(null);
    const dragPresetActiveRef = useRef<boolean>(false);
    // 拖拽视觉反馈（挂通用 dragging / drop-target 类，common.css 统一样式）
    const [dragPresetVisual, setDragPresetVisual] = useState<number | null>(null);
    const [dragOverPresetVisual, setDragOverPresetVisual] = useState<number | null>(null);

    // 参数复位：只回参数，不碰预设。
    // ⚠️ **必须先清选中态**：下面那条「参数变化 → 回写当前选中预设」的 effect
    //    在 selectedPreset !== null 时会把此刻的参数覆盖进那个预设。
    //    若复位时保留选中态，用户的预设会被就地改写成默认值（等于悄悄毁掉预设）。
    //    先清选中态让该 effect 落空，预设内容原封不动。
    // ⚠️ 不 setPresets —— 预设是用户资产，「参数复位」不该删掉后添加的预设。
    // ⚠️ 跳过首次（prevResetTokenRef 初始即 resetToken），否则每次打开面板都被清空。
    const prevResetTokenRef = useRef(resetToken);
    useEffect(() => {
        if (prevResetTokenRef.current === resetToken) return;
        prevResetTokenRef.current = resetToken;
        setSelectedPreset(null);
        setSelectedPresets(new Set());
        setLastClickedPreset(null);
        setSelectedStopIndex(null);
        setGradientType('linear');
        setAngle(0);
        setReverse(false);
        setPreserveTransparency(false);
        setStops([
            { color: 'rgba(0, 0, 0, 1)', position: 0, colorPosition: 0, opacityPosition: 0, midpoint: 50, opacityMidpoint: 50 },
            { color: 'rgba(255, 255, 255, 1)', position: 100, colorPosition: 100, opacityPosition: 100, midpoint: 50, opacityMidpoint: 50 }
        ]);
    }, [resetToken]);

    // 面板打开时加载已保存的渐变预设（加载期间禁止保存）
    useEffect(() => {
        if (!isOpen) return;
        isLoadingRef.current = true;
        (async () => {
            try {
                const saved = await PresetManager.loadGradientPresets();
                if (Array.isArray(saved) && saved.length > 0) {
                    setPresets(saved);
                }
            } catch (err) {
                console.error('加载渐变预设失败:', err);
            } finally {
                // 延迟到下一tick再允许保存，避免因setPresets触发的保存
                setTimeout(() => { isLoadingRef.current = false; }, 0);
            }
        })();
    }, [isOpen]);

    // 当渐变预设变更时，防抖持久化保存（跳过初次加载期间）
    useEffect(() => {
        if (isLoadingRef.current) return;
        dirtyRef.current = true;
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }
        saveTimerRef.current = setTimeout(async () => {
            try {
                await PresetManager.saveGradientPresets(presets);
                dirtyRef.current = false;
            } catch (err) {
                console.error('保存渐变预设失败:', err);
            }
        }, 500);
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
    }, [presets]);

    // 组件卸载时清理定时器并在有脏数据时保存
    useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            if (presets.length > 0 && dirtyRef.current) {
                console.log('🚨 GradientPicker: 组件卸载，保存未落盘的预设');
                PresetManager.saveGradientPresets(presets).catch(error => {
                    console.error('❌ GradientPicker: 组件卸载时保存失败:', error);
                });
            }
        };
    }, [presets]);

    // 定期自动保存预设（每30秒，仅在有脏数据时）
    useEffect(() => {
        if (!isOpen || presets.length === 0) return;
        const autoSaveInterval = setInterval(async () => {
            try {
                if (dirtyRef.current) {
                    console.log('🔄 GradientPicker: 定期自动保存预设');
                    await PresetManager.saveGradientPresets(presets);
                    dirtyRef.current = false;
                }
            } catch (error) {
                console.error('❌ GradientPicker: 定期保存失败:', error);
            }
        }, 30000);
        return () => { clearInterval(autoSaveInterval); };
    }, [isOpen, presets]);

    // 面板关闭时（isOpen变为false）立即尝试落盘
    useEffect(() => {
        if (!isOpen && presets.length > 0 && dirtyRef.current) {
            (async () => {
                try {
                    await PresetManager.saveGradientPresets(presets);
                    dirtyRef.current = false;
                } catch (err) {
                    console.error('关闭面板时保存渐变预设失败:', err);
                }
            })();
        }
    }, [isOpen, presets]);

    // 分离的拖拽状态
    const [isDraggingColor, setIsDraggingColor] = useState(false);
    const [isDraggingOpacity, setIsDraggingOpacity] = useState(false);
    const [dragStartX, setDragStartX] = useState(0);
    const [dragStartAngle, setDragStartAngle] = useState(0); 
    const [dragStopIndex, setDragStopIndex] = useState<number | null>(null);
    const [isInLayerMask, setIsInLayerMask] = useState(false);
    const [isInQuickMask, setIsInQuickMask] = useState(false);
    const [isInSingleColorChannel, setIsInSingleColorChannel] = useState(false);

    // 灰色显示态（唯一事实来源）：色板与渐变预览条共用，保证两者口径一致。
    // ⚠️ 必须声明在组件体靠前处：JSX 里读它，若放到下方声明会因 es5 的 `const` 提升而白屏。
    const grayDisplay = isGrayDisplayMode(isClearMode, isInLayerMask, isInQuickMask, isInSingleColorChannel);

    // 检测图层蒙版和快速蒙版模式
    useEffect(() => {
        const checkMaskModes = async () => {
            try {
                const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                setIsInLayerMask(layerInfo?.isInLayerMask || false);
                setIsInQuickMask(layerInfo?.isInQuickMask || false);
                setIsInSingleColorChannel(layerInfo?.isInSingleColorChannel || false);
            } catch (error) {
                console.error('检测蒙版模式失败:', error);
                setIsInLayerMask(false);
                setIsInQuickMask(false);
                setIsInSingleColorChannel(false);
            }
        };

        // 面板打开时检测一次
        // ⚠️ 走 runWhenIdle：切文档后父面板回写 quickMask 相关 prop 会连带触发本
        // effect，直接 get 会撞回忙碌窗口。顺延到空闲后再读。
        if (isOpen) {
            const probe = runWhenIdle(() => { checkMaskModes(); }, 300, 12);
            probe();
        }
    }, [isOpen]);

    // 监听通道切换和快速蒙版切换事件
    useEffect(() => {
        if (!isOpen) return;

        const checkMaskModes = async () => {
            try {
                const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                setIsInLayerMask(layerInfo?.isInLayerMask || false);
                setIsInQuickMask(layerInfo?.isInQuickMask || false);
                setIsInSingleColorChannel(layerInfo?.isInSingleColorChannel || false);
            } catch (error) {
                console.error('检测蒙版模式失败:', error);
                setIsInLayerMask(false);
                setIsInQuickMask(false);
                setIsInSingleColorChannel(false);
            }
        };

        // 监听Photoshop事件来检查状态变化
        // 探测防抖：PS 命令（如合并图层）执行中途派发的事件立刻 get 会撞忙碌窗口，
        // 弹出宿主报错框「命令"获取"当前不可用」，延迟到事件风暴平息后再探测
        const maskProbe = debouncePsProbe(() => { checkMaskModes(); });
        const handleNotification = (eventName?: any, descriptor?: any) => {
            // ⚠️ 事件到达瞬间打忙碌标记（回调内唯一允许做的事）：checkMaskModes 会读
            // app.activeDocument / doc.activeLayers 并发多次 batchPlay get。
            // 切文档的忙碌窗口比普通事件长得多，由 markPsBusyForEvent 按事件类型裁定。
            markPsBusyForEvent(typeof eventName === 'string' ? eventName : '', descriptor);
            maskProbe();
        };

        // 添加事件监听器
        addPsNotificationListeners(handleNotification);

        // 清理函数
        return () => {
            maskProbe.cancel();
            removePsNotificationListeners(handleNotification);
        };
    }, [isOpen]);

    // 实时更新功能：使用防抖机制避免频繁调用
    useEffect(() => {
        if (selectedPreset !== null && selectedPreset < presets.length) {
            // 更新选中预设的数据
            const updatedPresets = [...presets];
            const currentPreset = presets[selectedPreset] as any;
            const updatedPreset = {
                // 保留原有的id、name和preview字段
                id: currentPreset?.id || `gradient_${Date.now()}_${selectedPreset}`,
                name: currentPreset?.name || `渐变预设 ${selectedPreset + 1}`,
                preview: currentPreset?.preview || '',
                type: gradientType,
                angle,
                reverse,
                stops: stops.map(stop => ({
                    color: stop.color,
                    position: stop.position,
                    // 保存扩展属性到自定义字段中
                    colorPosition: stop.colorPosition,
                    opacityPosition: stop.opacityPosition,
                    midpoint: stop.midpoint,
                    opacityMidpoint: stop.opacityMidpoint
                })),
                preserveTransparency
            };
            updatedPresets[selectedPreset] = updatedPreset;
            setPresets(updatedPresets);
            
            // 使用防抖机制，延迟300ms后再调用onSelect，避免频繁更新导致性能问题
            const debounceTimeoutId = setTimeout(() => {
                onSelect(updatedPreset);
            }, 300);
            
            return () => clearTimeout(debounceTimeoutId);
        }
    }, [gradientType, angle, reverse, stops, preserveTransparency, selectedPreset]);

    const handleAddPreset = () => {
        const newPreset: Gradient & { id: string; name: string; preview?: string } = {
            id: `gradient_${Date.now()}_${presets.length}`,
            name: `渐变预设 ${presets.length + 1}`,
            preview: '', // 可以在此添加预览图标识
            type: gradientType,
            angle,
            reverse,
            preserveTransparency,
            stops: stops.map(stop => ({
                color: stop.color,
                position: stop.position,
                // 保存扩展属性到自定义字段中
                colorPosition: stop.colorPosition,
                opacityPosition: stop.opacityPosition,
                midpoint: stop.midpoint,
                opacityMidpoint: stop.opacityMidpoint
            }))
        };
        const newPresets = [...presets, newPreset];
        setPresets(newPresets); 
        setSelectedPreset(newPresets.length - 1);
    };

    const handleDeletePreset = (index?: number) => {
        if (selectedPresets.size > 0) {
            // 删除多选的预设
            const sortedIndices = Array.from(selectedPresets).sort((a, b) => b - a); // 从大到小排序
            let newPresets = [...presets];
            
            sortedIndices.forEach(i => {
                newPresets = newPresets.filter((_, idx) => idx !== i);
            });
            
            setPresets(newPresets);
            setSelectedPresets(new Set());
            setLastClickedPreset(null);
            
            // 如果删除后没有预设了，清空选中状态并通知父组件
            if (newPresets.length === 0) {
                setSelectedPreset(null);
                onSelect(null);
            }
        } else if (index !== undefined) {
            // 删除单个预设
            const newPresets = presets.filter((_, i) => i !== index);
            setPresets(newPresets);
            
            // 如果删除后没有预设了，清空选中状态并通知父组件
            if (newPresets.length === 0) {
                setSelectedPreset(null);
                onSelect(null);
            } else if (selectedPreset === index) {
                // 如果删除的是当前选中的预设
                const newSelectedIndex = index > 0 ? index - 1 : (newPresets.length > 0 ? 0 : null);
                setSelectedPreset(newSelectedIndex);
                
                if (newSelectedIndex !== null) {
                    const previousPreset = newPresets[newSelectedIndex];
                    setGradientType(previousPreset.type);
                    setAngle(previousPreset.angle || 0);
                    setReverse(previousPreset.reverse || false);
                    setStops(previousPreset.stops.map((stop, i) => ({
                        ...stop,
                        // 如果预设中保存了扩展属性，则使用保存的值，否则使用默认值
                        colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
                        opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
                        midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < previousPreset.stops.length - 1 ? 50 : undefined),
                        opacityMidpoint: stop.opacityMidpoint !== undefined ? stop.opacityMidpoint : (i < previousPreset.stops.length - 1 ? 50 : undefined)
                    })));
                }
            } else if (selectedPreset !== null && selectedPreset > index) {
                // 如果删除的预设在当前选中预设之前，需要调整索引
                setSelectedPreset(selectedPreset - 1);
            }
        }
    };

    const handlePresetSelect = (index: number, event?: React.MouseEvent) => {
        if (event && (event.ctrlKey || event.metaKey)) {
            // Ctrl+点击（Windows）或Cmd+点击（Mac）：切换选中状态
            
            // 如果当前是单选状态且点击的是已选中的项目，则取消选中
            if (selectedPreset === index && selectedPresets.size === 0) {
                setSelectedPreset(null);
                setLastClickedPreset(null);
                onSelect(null);
                return;
            }
            
            const newSelectedPresets = new Set(selectedPresets);
            
            // 如果当前是单选状态，先将单选项加入多选集合
            if (selectedPreset !== null && selectedPresets.size === 0) {
                newSelectedPresets.add(selectedPreset);
            }
            
            if (newSelectedPresets.has(index)) {
                newSelectedPresets.delete(index);
            } else {
                newSelectedPresets.add(index);
            }
            
            setSelectedPresets(newSelectedPresets);
            setLastClickedPreset(index);
            
            // 如果多选集合为空，清空所有选中状态
            if (newSelectedPresets.size === 0) {
                setSelectedPreset(null);
                onSelect(null);
            } else if (newSelectedPresets.size === 1) {
                // 如果只剩一个，转为单选状态
                const remainingIndex = Array.from(newSelectedPresets)[0];
                setSelectedPreset(remainingIndex);
                setSelectedPresets(new Set());
                
                const preset = presets[remainingIndex];
                setGradientType(preset.type);
                setAngle(preset.angle || 0);
                setReverse(preset.reverse || false);
                setStops(preset.stops.map((stop, i) => ({
                    ...stop,
                    colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
                    opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
                    midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < preset.stops.length - 1 ? 50 : undefined),
                    opacityMidpoint: stop.opacityMidpoint !== undefined ? stop.opacityMidpoint : (i < preset.stops.length - 1 ? 50 : undefined)
                })));
            } else {
                // 多选时清空单选状态
                setSelectedPreset(null);
            }
        } else if (event && event.shiftKey && lastClickedPreset !== null) {
            // Shift+点击：范围选择
            const newSelectedPresets = new Set(selectedPresets);
            
            // 如果当前是单选状态，先将单选项加入多选集合
            if (selectedPreset !== null && selectedPresets.size === 0) {
                newSelectedPresets.add(selectedPreset);
            }
            
            const start = Math.min(lastClickedPreset, index);
            const end = Math.max(lastClickedPreset, index);
            for (let i = start; i <= end; i++) {
                newSelectedPresets.add(i);
            }
            
            setSelectedPresets(newSelectedPresets);
            setLastClickedPreset(index);
            
            // 如果范围选择只有一个项目，按单选处理
            if (newSelectedPresets.size === 1) {
                setSelectedPreset(index);
                setSelectedPresets(new Set());
                
                const preset = presets[index];
                setGradientType(preset.type);
                setAngle(preset.angle || 0);
                setReverse(preset.reverse || false);
                setStops(preset.stops.map((stop, i) => ({
                    ...stop,
                    colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
                    opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
                    midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < preset.stops.length - 1 ? 50 : undefined),
                    opacityMidpoint: stop.opacityMidpoint !== undefined ? stop.opacityMidpoint : (i < preset.stops.length - 1 ? 50 : undefined)
                })));
            } else {
                // 多选时清空单选状态
                setSelectedPreset(null);
            }
        } else {
            // 单选模式
            setSelectedPreset(index);
            setSelectedPresets(new Set());
            setLastClickedPreset(index);
            
            const preset = presets[index];
            setGradientType(preset.type);
            setAngle(preset.angle || 0);
            setReverse(preset.reverse || false);
            setStops(preset.stops.map((stop, i) => ({
                ...stop,
                // 如果预设中保存了扩展属性，则使用保存的值，否则使用默认值
                colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
                opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
                midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < preset.stops.length - 1 ? 50 : undefined),
                opacityMidpoint: stop.opacityMidpoint !== undefined ? stop.opacityMidpoint : (i < preset.stops.length - 1 ? 50 : undefined)
            })));
        }
    };

    // 处理点击空白区域取消选中
    const handleContainerClick = (event: React.MouseEvent) => {
        // 检查点击的是否是预设区域的空白部分
        if (event.target === event.currentTarget) {
            setSelectedPreset(null);
            setSelectedPresets(new Set());
            setLastClickedPreset(null);
            onSelect(null);
        }
    };

    // 性能优化：使用useMemo缓存排序后的stops，避免每次渲染都重新排序
    const sortedColorStops = React.useMemo(() => 
        [...stops].sort((a, b) => a.colorPosition - b.colorPosition), 
        [stops]
    );
    
    const sortedOpacityStops = React.useMemo(() => 
        [...stops].sort((a, b) => a.opacityPosition - b.opacityPosition), 
        [stops]
    );
    
    // 优化的预览渐变函数 - 减少计算量和内存分配
    const getPreviewGradientStyle = () => {
        // 直接采样关键位置，避免创建大数组
        const sampleStep = 5; // 每5%采样一次
        const gradientStops: string[] = [];
        
        // 直接在采样点计算RGBA值，避免填充整个数组
        for (let i = 0; i <= 100; i += sampleStep) {
            const rgb = interpolateColorAtPosition(i, sortedColorStops);
            const alpha = interpolateOpacityAtPosition(i, sortedOpacityStops);
            
            if (isClearMode || isInLayerMask || isInQuickMask || isInSingleColorChannel) {
                // 清除模式、图层蒙版模式、快速蒙版模式或单个颜色通道模式：转换为灰度值
                const gray = Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
                const a = alpha.toFixed(3);
                gradientStops.push(`rgba(${gray}, ${gray}, ${gray}, ${a}) ${i}%`);
            } else {
                // 普通模式：使用原始RGB颜色
                const r = Math.round(rgb.r);
                const g = Math.round(rgb.g);
                const b = Math.round(rgb.b);
                const a = alpha.toFixed(3);
                gradientStops.push(`rgba(${r}, ${g}, ${b}, ${a}) ${i}%`);
            }
        }
        
        return `linear-gradient(to right, ${gradientStops.join(', ')})`;
    };


    const getGradientStyle = () => {
        if (stops.length === 0) return '';
        
        // 直接采样关键位置，避免创建大数组
        const sampleStep = 10; // 每10%采样一次，平衡性能和质量
        const gradientStops = [];
        
        // 直接在采样点计算RGBA值，使用缓存的排序数组
        for (let i = 0; i <= 100; i += sampleStep) {
            const rgb = interpolateColorAtPosition(i, sortedColorStops);
            const alpha = interpolateOpacityAtPosition(i, sortedOpacityStops);
            
            if (isClearMode || isInLayerMask || isInQuickMask || isInSingleColorChannel) {
                // 图层蒙版模式或快速蒙版模式：转换为灰度值
                const gray = Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
                const a = alpha.toFixed(3);
                gradientStops.push(`rgba(${gray}, ${gray}, ${gray}, ${a}) ${i}%`);
            } else {
                // 普通模式：使用原始RGB颜色
                const r = Math.round(rgb.r);
                const g = Math.round(rgb.g);
                const b = Math.round(rgb.b);
                const a = alpha.toFixed(3);
                gradientStops.push(`rgba(${r}, ${g}, ${b}, ${a}) ${i}%`);
            }
        }
        
        const displayStops = reverse
            ? gradientStops.map(stop => {
                const match = stop.match(/^(.+)\s+(\d+(?:\.\d+)?)%$/);
                if (match) {
                    const color = match[1];
                    const position = parseFloat(match[2]);
                    return `${color} ${100 - position}%`;
                }
                return stop;
            }).reverse()
            : gradientStops;
            
        const stopString = displayStops.join(', ');
        
        switch (gradientType) {
            case 'linear':
                return `linear-gradient(${90+angle}deg, ${stopString})`;
            case 'radial':
                return `radial-gradient(circle, ${stopString})`;
            default:
                return `linear-gradient(${angle}deg, ${stopString})`;
        }
    };

    const handleAddStop = (e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const newPosition = Math.round((clickX / rect.width) * 100);
        
        const leftStop = stops.reduce((prev, curr) => 
            curr.position <= newPosition && curr.position > prev.position ? curr : prev
        , { position: -1, color: stops[0].color });
        
        const rightStop = stops.reduce((prev, curr) => 
            curr.position >= newPosition && curr.position < prev.position ? curr : prev
        , { position: 101, color: stops[stops.length-1].color });
        
        const progress = (newPosition - leftStop.position) / (rightStop.position - leftStop.position);
        
        const leftColor = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        const rightColor = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        
        if (leftColor && rightColor) {
            const r = Math.round(parseInt(leftColor[1]) * (1 - progress) + parseInt(rightColor[1]) * progress);
            const g = Math.round(parseInt(leftColor[2]) * (1 - progress) + parseInt(rightColor[2]) * progress);
            const b = Math.round(parseInt(leftColor[3]) * (1 - progress) + parseInt(rightColor[3]) * progress);
            const a = parseFloat(leftColor[4]) * (1 - progress) + parseFloat(rightColor[4]) * progress;
            
            const newColor = `rgba(${r}, ${g}, ${b}, ${a})`;
            const newStops = [...stops, { 
                color: newColor, 
                position: newPosition, 
                colorPosition: newPosition,
                opacityPosition: newPosition,
                midpoint: 50,
                opacityMidpoint: 50 
            }];
            const sortedStops = newStops.sort((a, b) => a.position - b.position);
            
            // 更新中点
            for (let i = 0; i < sortedStops.length - 1; i++) {
                if (!sortedStops[i].midpoint) {
                    sortedStops[i].midpoint = 50;
                }
                if (!sortedStops[i].opacityMidpoint) {
                    sortedStops[i].opacityMidpoint = 50;
                }
            }
            
            setStops(sortedStops);
        }
    };

    const handleStopChange = (index: number, color?: string, position?: number, opacity?: number, colorPosition?: number, opacityPosition?: number) => {
        const newStops = [...stops];
        const currentStop = newStops[index];
        
        if (opacity !== undefined) {
            const rgbaValues = currentStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
            if (rgbaValues) {
                const [_, r, g, b] = rgbaValues;
                newStops[index] = {
                    ...currentStop,
                    color: `rgba(${r}, ${g}, ${b}, ${opacity / 100})`
                };
            }
        } else if (color) {
            const currentAlpha = currentStop.color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1';
            if (color.startsWith('#')) {
                const r = parseInt(color.slice(1, 3), 16);
                const g = parseInt(color.slice(3, 5), 16);
                const b = parseInt(color.slice(5, 7), 16);
                newStops[index] = {
                    ...currentStop,
                    color: `rgba(${r}, ${g}, ${b}, ${currentAlpha})`
                };
            } else if (color.startsWith('rgba')) {
                newStops[index] = {
                    ...currentStop,
                    color: color
                };
            }
        }
        
        if (colorPosition !== undefined) {
            newStops[index] = {
                ...newStops[index],
                colorPosition: colorPosition
            };
        }
        
        if (opacityPosition !== undefined) {
            newStops[index] = {
                ...newStops[index],
                opacityPosition: opacityPosition
            };
        }
        
        if (position !== undefined) {
            newStops[index] = {
                ...newStops[index],
                position: position,
                colorPosition: position,
                opacityPosition: position
            };
        }
        
        setStops(newStops);
    };

    const handleRemoveStop = (index: number) => {
        if (stops.length > 2) {
            const newStops = stops.filter((_, i) => i !== index);
            // 重新计算中点
            for (let i = 0; i < newStops.length - 1; i++) {
                if (!newStops[i].midpoint) {
                    newStops[i].midpoint = 50;
                }
                if (!newStops[i].opacityMidpoint) {
                    newStops[i].opacityMidpoint = 50;
                }
            }
            setStops(newStops);
            setSelectedStopIndex(null);
        }
    };

    // 颜色stop拖拽处理
    const handleColorStopMouseDown = (e: React.MouseEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedStopIndex(index);
        setSelectedStopType('color');
        
        // 安全检查：确保colorPosition存在
        if (!stops[index] || stops[index].colorPosition === undefined) {
            return;
        }
        
        const startX = e.clientX;
        const startPosition = stops[index].colorPosition;
        setDragStartX(startX);
        setDragStopIndex(index);
        
        let hasMoved = false;
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            
            // 只有在鼠标移动超过阈值时才进入拖拽状态
            if (!hasMoved) {
                const deltaX = Math.abs(moveEvent.clientX - startX);
                if (deltaX > 3) { // 3px的移动阈值
                    hasMoved = true;
                    setIsDraggingColor(true);
                } else {
                    return;
                }
            }
            
            // 修复选择器
            const trackElement = document.querySelector('.color-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - startX;
            const newPosition = Math.max(0, Math.min(100, startPosition + (deltaX / rect.width) * 100));
            
            handleStopChange(index, undefined, undefined, undefined, newPosition);
        };
        
        const handleMouseUp = () => {
            // 只有在真正移动过的情况下才清除拖拽状态
            if (hasMoved) {
                setIsDraggingColor(false);
            }
            setDragStopIndex(null);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    // 透明度stop拖拽处理
    const handleOpacityStopMouseDown = (e: React.MouseEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedStopIndex(index);
        setSelectedStopType('opacity');
        
        // 安全检查：确保opacityPosition存在
        if (!stops[index] || stops[index].opacityPosition === undefined) {
            return;
        }
        
        const startX = e.clientX;
        const startPosition = stops[index].opacityPosition;
        setDragStartX(startX);
        setDragStopIndex(index);
        
        let hasMoved = false;
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            
            // 只有在鼠标移动超过阈值时才进入拖拽状态
            if (!hasMoved) {
                const deltaX = Math.abs(moveEvent.clientX - startX);
                if (deltaX > 1) { // 3px的移动阈值
                    hasMoved = true;
                    setIsDraggingOpacity(true);
                } else {
                    return;
                }
            }
            
            // 修复选择器 - 透明度拖拽应该使用opacity-slider-track
            const trackElement = document.querySelector('.opacity-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - startX;
            const newPosition = Math.max(0, Math.min(100, startPosition + (deltaX / rect.width) * 100));
            
            handleStopChange(index, undefined, undefined, undefined, undefined, newPosition);
        };
        
        const handleMouseUp = () => {
            // 只有在真正移动过的情况下才清除拖拽状态
            if (hasMoved) {
                setIsDraggingOpacity(false);
            }
            setDragStopIndex(null);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    // 颜色中点拖拽处理
    const handleColorMidpointMouseDown = (e: React.MouseEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        
        const startX = e.clientX;
        const startMidpoint = stops[index].midpoint || 50;
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.color-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - startX;
            const deltaPercent = (deltaX / rect.width) * 100;
            const newMidpoint = Math.max(1, Math.min(99, startMidpoint + deltaPercent));
            
            const newStops = [...stops];
            newStops[index] = { ...newStops[index], midpoint: newMidpoint };
            setStops(newStops);
        };
        
        const handleMouseUp = () => {
            setDragStopIndex(null);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    // 透明度中点拖拽处理
    const handleOpacityMidpointMouseDown = (e: React.MouseEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        
        const startX = e.clientX;
        const startMidpoint = stops[index].opacityMidpoint || 50;
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.opacity-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - startX;
            const deltaPercent = (deltaX / rect.width) * 100;
            const newMidpoint = Math.max(1, Math.min(99, startMidpoint + deltaPercent));
            
            const newStops = [...stops];
            newStops[index] = { ...newStops[index], opacityMidpoint: newMidpoint };
            setStops(newStops);
        };
        
        const handleMouseUp = () => {
            setDragStopIndex(null);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    // 角度拖拽处理
    const handleAngleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragStartX(e.clientX);
        setDragStartAngle(angle);

        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            setAngle(calcDragValue(
                dragStartAngle,
                moveEvent.clientX - dragStartX,
                0,
                360,
                1
            ));
        };

        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    // 预设拖拽排序处理
    const handlePresetDragStart = (e: React.DragEvent<HTMLDivElement>, index: number) => {
        dragPresetIndexRef.current = index;
        dragPresetActiveRef.current = true;
        setDragPresetVisual(index);
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(index)); } catch {}
        }
    };

    const handlePresetDragOver = (e: React.DragEvent<HTMLDivElement>, index: number) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        setDragOverPresetVisual((prev) => (prev === index ? prev : index));
    };

    const handlePresetDrop = async (e: React.DragEvent<HTMLDivElement>, dropIndex: number) => {
        e.preventDefault();
        const dragIndexFromRef = dragPresetIndexRef.current;
        const dragIndexFromData = (() => {
            try { return parseInt(e.dataTransfer.getData('text/plain')); } catch { return NaN; }
        })();
        const fromIndex = (dragIndexFromRef !== null && dragIndexFromRef !== undefined) ? dragIndexFromRef : dragIndexFromData;
        dragPresetActiveRef.current = false;
        dragPresetIndexRef.current = null;
        setDragPresetVisual(null);
        setDragOverPresetVisual(null);
        if (Number.isNaN(fromIndex) || fromIndex === dropIndex) {
            return;
        }
        const nextOrder = (() => {
            const updated = [...presets];
            const [moved] = updated.splice(fromIndex, 1);
            updated.splice(dropIndex, 0, moved);
            return updated;
        })();
        setPresets(nextOrder);
        // 选中态必须跟着预设一起搬家：选中项存的是「索引/位置」而不是身份，
        // 交换后若不重映射，高亮会停在旧位置（显示的是被换过来的那个预设），
        // 而编辑区仍是原选中预设的数据 —— 此后一动滑块，实时同步 effect 就会把
        // 原选中预设的数据写进新占位的那个预设，静默改写别人的数据。
        const remapIndex = (i: number) => {
            if (i === fromIndex) return dropIndex;
            if (fromIndex < dropIndex) return (i > fromIndex && i <= dropIndex) ? i - 1 : i;
            return (i >= dropIndex && i < fromIndex) ? i + 1 : i;
        };
        if (selectedPreset !== null) setSelectedPreset(remapIndex(selectedPreset));
        if (selectedPresets.size > 0) setSelectedPresets(new Set(Array.from(selectedPresets).map(remapIndex)));
        if (lastClickedPreset !== null) setLastClickedPreset(remapIndex(lastClickedPreset));
        try {
            await PresetManager.saveGradientPresets(nextOrder);
        } catch (err) {
            console.error('保存拖拽后的渐变预设顺序失败:', err);
        }
    };

    const handlePresetDragEnd = () => {
        dragPresetActiveRef.current = false;
        dragPresetIndexRef.current = null;
        setDragPresetVisual(null);
        setDragOverPresetVisual(null);
    };

    const getRGBColor = (rgbaColor: string): string => {
        const rgbaValues = rgbaColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (rgbaValues) {
            const [_, r, g, b] = rgbaValues;
            const rHex = parseInt(r).toString(16).padStart(2, '0');
            const gHex = parseInt(g).toString(16).padStart(2, '0');
            const bHex = parseInt(b).toString(16).padStart(2, '0');
            return `#${rHex}${gHex}${bHex}`;
        }
        return 'rgb(0, 0, 0)';
    };

    // 修复颜色输入处理
    const handleColorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (selectedStopIndex === null) return;
        
        const input = e.target;
        const cursorPosition = input.selectionStart || 0;
        let value = input.value.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6);
        
        // 保持光标位置的逻辑
        const currentStop = stops[selectedStopIndex];
        const currentAlpha = currentStop.color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1';
        
        // 补齐到6位
        const colorValue = value.padEnd(6, '0');
        const r = parseInt(colorValue.slice(0, 2), 16);
        const g = parseInt(colorValue.slice(2, 4), 16);
        const b = parseInt(colorValue.slice(4, 6), 16);
        
        handleStopChange(selectedStopIndex, `rgba(${r}, ${g}, ${b}, ${currentAlpha})`);
        
        // 恢复光标位置
        setTimeout(() => {
            input.value = value;
            input.setSelectionRange(cursorPosition, cursorPosition);
        }, 0);
    };

    if (!isOpen) return null;

    // 添加渲染棋盘格的函数
    const renderCheckerboard = (containerWidth: number, containerHeight: number, tileSize: number = 8) => {
        // 过量渲染：父容器实际尺寸可能比传入值略大（如 最终预览 width:100%），
        // 多铺 64px 余量保证铺满，超出部分由父级 overflow:hidden 裁掉（消除右侧漏底缝隙）。
        const OVERSCAN = 64;
        const tilesPerRow = Math.ceil((containerWidth + OVERSCAN) / tileSize);
        const rows = Math.ceil((containerHeight + OVERSCAN) / tileSize);
        const tiles = [];

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < tilesPerRow; col++) {
                const isLight = (row + col) % 2 === 0;
                tiles.push(
                    <div
                        key={`${row}-${col}`}
                        style={{
                            position: 'absolute',
                            left: col * tileSize,
                            top: row * tileSize,
                            // 宽高各 +1px：与相邻方块 1px 重叠，由后绘制（同行右侧/下行）的方块覆盖，
                            // 彻底消除 UXP 下整数坐标相邻方块间的亚像素缝隙（描边/漏底），任意缩放比都生效。
                            width: tileSize + 1,
                            height: tileSize + 1,
                            backgroundColor: isLight ? 'rgb(255, 255, 255)' : 'rgb(224, 224, 224)',
                            boxSizing: 'border-box'
                        }}
                    />
                );
            }
        }
        return tiles;
    };

    return (
            <div className="panel subpanel-gradient">
                <div className="subpanel-title-1">
                    <div title={helpTexts.gradient.panelTitle}>渐变设置</div>
                <div className="close-button" role="button" tabIndex={0} title={helpTexts.selectionFill.floatClose} onClick={onClose}>×</div>
            </div>

            {/* 预设区域 */}
            <div className="preset-area">
                <div className="gradient-presets" onClick={handleContainerClick}>
                    {presets.map((preset, index) => {
                        // 生成考虑中点插值的预设预览样式
                        const presetGradientStyle = generatePresetPreviewStyle(preset, isInLayerMask, isInQuickMask, isInSingleColorChannel, isClearMode);
                        
                        return (
                            <div
                                key={index}
                                className={'preset-item'
                                    + (dragPresetVisual === index ? ' dragging' : '')
                                    + (dragPresetVisual !== null && dragOverPresetVisual === index && dragPresetVisual !== index ? ' drop-target' : '')
                                    + (selectedPresets.has(index) ? ' thumb-multi-selected' : (selectedPreset === index ? ' thumb-selected' : ''))}
                                title={helpTexts.gradient.preset}
                                draggable={true}
                                onDragStart={(e) => handlePresetDragStart(e, index)}
                                onDragOver={(e) => handlePresetDragOver(e, index)}
                                onDrop={(e) => handlePresetDrop(e, index)}
                                onDragEnd={handlePresetDragEnd}
                                onClick={(e) => {
                                    if (dragPresetActiveRef.current) return;
                                    handlePresetSelect(index, e);
                                }}
                            >
                                    {/* 棋盘格背景 */}
                                    <div>
                                        {renderCheckerboard(50, 50, 4)}
                                    </div>
                                    {/* 渐变覆盖层 */}
                                    <div
                                        className="gradient-fill-layer"
                                        style={{ background: presetGradientStyle }}
                                    />
                            </div>
                        );
                    })}
                </div>
                
                <div className="icon-button-group-bar">
                    <div className="row-end">
                        <IconButton title={helpTexts.gradient.addPreset} onClick={handleAddPreset}>
                            <AddIcon className="icon-14" />
                        </IconButton>
                        <div
                            className={((selectedPreset === null && selectedPresets.size === 0) || presets.length === 0) ? 'icon-button-disabled' : 'icon-button'}
                            role="button"
                            tabIndex={((selectedPreset === null && selectedPresets.size === 0) || presets.length === 0) ? -1 : 0}
                            title={helpTexts.gradient.deletePreset}
                            onClick={() => {
                            if (selectedPresets.size > 0) {
                                handleDeletePreset();
                            } else if (selectedPreset !== null) {
                                handleDeletePreset(selectedPreset);
                            }
                            }}
                        >
                            <DeleteIcon className="icon-14" />
                        </div>
                    </div>
                </div>
            </div>

            {/* 渐变编辑区域 */}
            <div className="border-panel-section">
                <div className="subpanel-title-2"><h3>颜色渐变</h3></div>
                
                {/* 不透明度控制 */}
                {selectedStopIndex !== null && selectedStopType === 'opacity' && (
                    <div className="row-between">
                        <label 
                            className="label-drag label-4"
                            title={helpTexts.gradient.stopOpacity}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                const startX = e.clientX;
                                const startValue = Math.round(parseFloat(stops[selectedStopIndex].color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1') * 100);
                                
                                const handleMouseMove = (moveEvent: MouseEvent) => {
                                    const newValue = calcDragValue(
                                        startValue,
                                        moveEvent.clientX - startX,
                                        0,
                                        100,
                                        1
                                    );
                                    handleStopChange(selectedStopIndex, undefined, undefined, newValue);
                                };
                                
                                const handleMouseUp = () => {
                                    document.removeEventListener('mousemove', handleMouseMove);
                                    document.removeEventListener('mouseup', handleMouseUp);
                                };
                                
                                document.addEventListener('mousemove', handleMouseMove);
                                document.addEventListener('mouseup', handleMouseUp);
                            }}
                        >
                            不透明度
                        </label>
                    <div className="row-start">
                        <div className="num-input-row">
                            <input
                                type="number"
                                min="0"
                                max="100"
                                value={Math.round(parseFloat(stops[selectedStopIndex].color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1') * 100)}
                                title={helpTexts.gradient.stopOpacityInput}
                                onChange={(e) => {
                                    const opacityValue = Math.max(0, Math.min(100, Number(e.target.value)));
                                    handleStopChange(selectedStopIndex, undefined, undefined, opacityValue);
                                }}
                            />
                        </div>
                        <span className="num-unit">%</span>
                    </div>
                        <div
                            className={stops.length <= 2 ? 'icon-button-disabled' : 'icon-button'}
                            role="button"
                            tabIndex={stops.length <= 2 ? -1 : 0}
                            title={helpTexts.gradient.deleteStop}
                            onClick={() => {
                            if (stops.length > 2) {
                                handleRemoveStop(selectedStopIndex);
                            }
                            }}
                        >
                            <DeleteIcon className="icon-14" />
                        </div>
                    </div>
                )}

                {/* 透明度滑块 */}
                <div className="opacity-slider-track">
                    {stops.map((stop, index) => {
                        const rgbaMatch = stop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
                        const alpha = rgbaMatch ? parseFloat(rgbaMatch[4]) : 1;
                        const grayValue = Math.round(255 * alpha);
                        const displayColor = `rgb(${grayValue}, ${grayValue}, ${grayValue})`; // 修改：纯白代表完全不透明，纯黑代表完全透明
                        
                        return (
                            <div
                                key={`opacity-${index}`}
                                className={'opacity-slider-thumb' + (selectedStopIndex === index && selectedStopType === 'opacity' ? ' slider-thumb-selected' : '')}
                                style={{ 
                                    left: `${stop.opacityPosition}%`,
                                    backgroundColor: displayColor,
                                    border: selectedStopIndex === index && selectedStopType === 'opacity' 
                                        ? '2px solid var(--primary-color)' 
                                        : '2px solid var(--border-color)',
                                    ...(isDraggingOpacity && dragStopIndex === index ? {
                                        cursor: 'grabbing'
                                    } : {})
                                }}
                                title={helpTexts.gradient.stopOpacity}
                                onMouseDown={(e) => handleOpacityStopMouseDown(e, index)}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedStopIndex(index);
                                    setSelectedStopType('opacity');
                                }}
                            />
                        );
                    })}
                    
                    {/* 透明度中点滑块 - 简化逻辑 */}
                    {selectedStopIndex !== null && selectedStopType === 'opacity' && (
                        <>
                            {/* 左侧中点 */}
                            {(() => {
                                // 找到当前选中stop左侧最近的stop
                                const leftStops = stops.filter((_, i) => i !== selectedStopIndex && stops[i].opacityPosition < stops[selectedStopIndex].opacityPosition);
                                if (leftStops.length === 0) return null;
                                
                                const leftStop = leftStops.reduce((prev, curr) => 
                                    curr.opacityPosition > prev.opacityPosition ? curr : prev
                                );
                                const leftStopIndex = stops.indexOf(leftStop);
                                
                                return (
                                    <div
                                        className="midpoint-slider"
                                        title={helpTexts.gradient.midpoint}
                                        style={{
                                            left: `${leftStop.opacityPosition + (stops[selectedStopIndex].opacityPosition - leftStop.opacityPosition) * (leftStop.opacityMidpoint || 50) / 100}%`
                                        }}
                                        onMouseDown={(e) => handleOpacityMidpointMouseDown(e, leftStopIndex)}
                                    />
                                );
                            })()}
                            
                            {/* 右侧中点 */}
                            {(() => {
                                // 找到当前选中stop右侧最近的stop
                                const rightStops = stops.filter((_, i) => i !== selectedStopIndex && stops[i].opacityPosition > stops[selectedStopIndex].opacityPosition);
                                if (rightStops.length === 0) return null;
                                
                                return (
                                    <div
                                        className="midpoint-slider"
                                        title={helpTexts.gradient.midpoint}
                                        style={{
                                            left: `${stops[selectedStopIndex].opacityPosition + (rightStops[0].opacityPosition - stops[selectedStopIndex].opacityPosition) * (stops[selectedStopIndex].opacityMidpoint || 50) / 100}%`
                                        }}
                                        onMouseDown={(e) => handleOpacityMidpointMouseDown(e, selectedStopIndex)}
                                    />
                                );
                            })()}
                        </>
                    )}
                </div>

                   {/* 渐变预览区域 */}
                   <div className="gradient-preview">
                    <div className="opacity-checkerboard">
                        {renderCheckerboard(220, 24)}
                    </div>
                    <div
                        className="gradient-fill-layer"
                        style={{ background: getPreviewGradientStyle() }}
                        onClick={handleAddStop}
                        title={helpTexts.gradient.previewAddStop}
                    />
                </div>

                {/* 颜色滑块 */}
                <div className="color-slider-track">
                    {stops.map((stop, index) => (
                        <div
                            key={`color-${index}`}
                            className={'color-slider-thumb' + (selectedStopIndex === index && selectedStopType === 'color' ? ' slider-thumb-selected' : '')}
                            style={{ 
                                left: `${stop.colorPosition}%`,
                                // ⚠️ 灰色态（清除/图层蒙版/快速蒙版/单通道）下色标也要同步灰化：
                                //    上一轮只改了「颜色」行的 .color-preview，遗漏了轨道上这排方形色标
                                //    ⇒ 预览条已灰、色标仍是彩色的（2026-10-08 用户指出）。
                                //    getDisplayColorHex 只影响显示，stops 里仍存原色，退出灰色态自动恢复。
                                backgroundColor: getDisplayColorHex(stop.color, grayDisplay),
                                ...(isDraggingColor && dragStopIndex === index ? {
                                    cursor: 'grabbing'
                                } : {})
                            }}
                            title={helpTexts.gradient.colorLabel}
                            onMouseDown={(e) => handleColorStopMouseDown(e, index)}
                            onClick={(e) => {
                                e.stopPropagation();
                                setSelectedStopIndex(index);
                                setSelectedStopType('color');
                            }}
                        />  
                    ))}
                    
                    {/* 颜色中点滑块 - 修复逻辑 */}
                    {selectedStopIndex !== null && selectedStopType === 'color' && (
                        <>
                            {/* 左侧中点 */}
                            {(() => {
                                // 安全检查：确保selectedStopIndex有效且stop存在colorPosition属性
                                if (selectedStopIndex === null || !stops[selectedStopIndex] || stops[selectedStopIndex].colorPosition === undefined) {
                                    return null;
                                }
                                
                                // 找到当前选中stop左侧最近的stop
                                const leftStops = stops.filter((_, i) => i !== selectedStopIndex && 
                                    stops[i].colorPosition !== undefined && 
                                    stops[i].colorPosition < stops[selectedStopIndex].colorPosition);
                                if (leftStops.length === 0) return null;
                                
                                const leftStop = leftStops.reduce((prev, curr) => 
                                    curr.colorPosition > prev.colorPosition ? curr : prev
                                );
                                const leftStopIndex = stops.indexOf(leftStop);
                                
                                return (
                                    <div
                                        className="midpoint-slider"
                                        title={helpTexts.gradient.midpoint}
                                        style={{
                                            left: `${leftStop.colorPosition + (stops[selectedStopIndex].colorPosition - leftStop.colorPosition) * (leftStop.midpoint || 50) / 100}%`
                                        }}
                                        onMouseDown={(e) => handleColorMidpointMouseDown(e, leftStopIndex)}
                                    />
                                );
                            })()}
                            
                            {/* 右侧中点 */}
                            {(() => {
                                // 安全检查：确保selectedStopIndex有效且stop存在colorPosition属性
                                if (selectedStopIndex === null || !stops[selectedStopIndex] || stops[selectedStopIndex].colorPosition === undefined) {
                                    return null;
                                }
                                
                                // 找到当前选中stop右侧最近的stop
                                const rightStops = stops.filter((_, i) => i !== selectedStopIndex && 
                                    stops[i].colorPosition !== undefined && 
                                    stops[i].colorPosition > stops[selectedStopIndex].colorPosition);
                                if (rightStops.length === 0) return null;
                                
                                const rightStop = rightStops.reduce((prev, curr) => 
                                    curr.colorPosition < prev.colorPosition ? curr : prev
                                );
                                
                                return (
                                    <div
                                        className="midpoint-slider"
                                        title={helpTexts.gradient.midpoint}
                                        style={{
                                            left: `${stops[selectedStopIndex].colorPosition + (rightStop.colorPosition - stops[selectedStopIndex].colorPosition) * (stops[selectedStopIndex].midpoint || 50) / 100}%`
                                        }}
                                        onMouseDown={(e) => handleColorMidpointMouseDown(e, selectedStopIndex)}
                                    />
                                );
                            })()}
                        </>
                    )}
                </div>
                
                {/* 颜色控制 */}
                {selectedStopIndex !== null && selectedStopType === 'color' && (
                    <div className="row-between">
                        <label className="label-2" title={helpTexts.gradient.colorLabel}>颜色</label>
                    <div className="row-start">
                        <span className="num-unit num-unit-hash">#</span>
                        {/* ⚠️ num-input-row-wide：.num-input-row 已固定 34px（对齐单位符号），
                            此处是 6 位色值（#RRGGBB）需要 60px ⇒ 必须挂显式宽度档，
                            否则会被裁掉右侧 2/3（UXP 不支持 :has()，无法靠类型选择器自动匹配）。 */}
                        <div className="num-input-row num-input-row-wide">
                            <input
                                type="text"
                                value={getRGBColor(stops[selectedStopIndex].color).slice(1)}
                                onChange={handleColorInputChange}
                                maxLength={6}
                                title={helpTexts.gradient.colorInput}
                            />
                        </div>
                        <div
                            className="color-preview"
                            style={{ backgroundColor: getDisplayColorHex(stops[selectedStopIndex].color, grayDisplay) }}
                            title={helpTexts.gradient.colorPreview}
                            onClick={async () => {
                                // ⚠️ 初始色必须传「色标当前颜色」：showColorPicker 无参、只认当前前景色，
                                //    不先把前景色设成它，色板显示 A 而拾色器打开 PS 前景色 B（旧缺陷）。
                                //    前景色的保存/还原由 pickColorWithInitial 内部负责。
                                const stop = stops[selectedStopIndex];
                                const picked = await pickColorWithInitial(
                                    parseCssRgb(stop.color) || { red: 0, green: 0, blue: 0 },
                                    '选择颜色'
                                );
                                if (!picked) return;
                                const currentAlpha = stop.color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1';
                                handleStopChange(selectedStopIndex, `rgba(${picked.red}, ${picked.green}, ${picked.blue}, ${currentAlpha})`);
                            }}
                        />
                    </div>   
                        <div
                            className={stops.length <= 2 ? 'icon-button-disabled' : 'icon-button'}
                            role="button"
                            tabIndex={stops.length <= 2 ? -1 : 0}
                            title={helpTexts.gradient.deleteStop}
                            onClick={() => {
                            if (stops.length > 2) {
                                handleRemoveStop(selectedStopIndex);
                            }
                            }}
                        >
                            <DeleteIcon className="icon-14" />
                        </div>
                    </div>
                )}
            </div>

            {/* 渐变类型设置 */}
            <div className="border-panel-section">
                <div className="row-between" title={helpTexts.gradient.typeLabel}>
                    <label className="label-2" title={helpTexts.gradient.typeLabel}>样式</label>
                    <Select
                        value={gradientType}
                        options={GRADIENT_TYPE_OPTIONS}
                        title={helpTexts.gradient.typeLabel}
                        onChange={(v) => setGradientType(v as typeof gradientType)}
                    />
                </div>

                <div className="divider"></div>

                {/* 角度行始终渲染：径向模式下仅置为禁用态（而非隐藏），
                    这样 .gradient-settings-area 的容器高度在两种模式下保持一致，
                    不会再出现切换径向时下拉相对容器上移/间距变化的观感。 */}
                <div className={gradientType === 'radial' ? 'row-between disabled' : 'row-between'}>
                    {/* 光标：常态 ew-resize 由 .label-drag 给出；径向禁用态的
                        not-allowed 由 .row-between disabled label 覆盖（特异性更高） */}
                    <label
                        className="label-drag label-2"
                        title={helpTexts.gradient.adjustAngle}
                        onMouseDown={gradientType === 'radial' ? undefined : handleAngleMouseDown}
                    >角度</label>
                    <RangeSlider
                        min={0}
                        max={360}
                        step={1}
                        value={angle}
                        className="slider-track"
                        title={helpTexts.gradient.adjustAngle}
                        disabled={gradientType === 'radial'}
                        onChange={(v) => setAngle(v)}
                    />
                    <div className="row-start">
                        <div className="num-input-row">
                            <input
                                type="number"
                                min="0"
                                max="360"
                                value={angle}
                                disabled={gradientType === 'radial'}
                                title={helpTexts.gradient.adjustAngle}
                                onChange={(e) => setAngle(Number(e.target.value))}
                            />
                        </div>
                      <span className="num-unit">°</span>
                    </div>
                </div>

                <div className="divider"></div>

                <div className="row-between row-grid row-grid-flush">
                    <div className="grid-cell">
                    <div className="row-start">
                        <label
                            className="label-2"
                            htmlFor="reverseCheckbox"
                            title={helpTexts.gradient.reverse}
                            onClick={() => setReverse(!reverse)}
                        >
                            反向
                        </label>
                        <input
                            type="checkbox"
                            id="reverseCheckbox"
                            className="checkbox-input"
                            checked={reverse}
                            title={helpTexts.gradient.reverse}
                            onChange={(e) => setReverse(e.target.checked)}
                        />
                    </div>
                    </div>

                    <div className="grid-cell">
                    <div className="row-start">
                         <label
                            className="label-6"
                            htmlFor="transparencyCheckbox"
                            title={helpTexts.gradient.preserveTransparency}
                            onClick={() => setPreserveTransparency(!preserveTransparency)}
                        >
                            保留不透明度
                        </label>
                        <input
                            type="checkbox"
                            id="transparencyCheckbox"
                            className="checkbox-input"
                            checked={preserveTransparency}
                            title={helpTexts.gradient.preserveTransparency}
                            onChange={(e) => setPreserveTransparency(e.target.checked)}
                        />
                    </div>
                    </div>
                </div>
            </div>

            {/* 最终预览区域 */}
            <div className="final-preview-container">
                <div className="subpanel-title-2"><h3>最终预览</h3></div>
                <div className="preview-wrapper">
                    {/* 当选中多个预设时渲染提示词 */}
                    {selectedPresets.size > 0 ? (
                        <div className="final-preview-hint">
                            已选中多个预设
                        </div>
                    ) : selectedPreset === null ? (
                        <div className="final-preview-hint">
                            请选择一个渐变预设
                        </div>
                    ) : (
                        <>
                            <div className="opacity-checkerboard">
                                {renderCheckerboard(240, 300, 12)}
                            </div>
                            {/* 渐变覆盖层 */}
                            <div
                                className="gradient-fill-layer"
                                style={{ background: getGradientStyle() }}
                            />
                            {/* 当渐变完全透明时显示提示 */}
                            {(() => {
                                const hasVisibleOpacity = stops.some(stop => {
                                    const rgbaMatch = stop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
                                    return rgbaMatch && parseFloat(rgbaMatch[4]) > 0;
                                });
                                
                                if (!hasVisibleOpacity) {
                                    return (
                                        <div className="final-preview-hint">
                                            渐变完全透明
                                        </div>
                                    );
                                }
                                return null;
                            })()} 
                        </>
                    )}
                </div>
            </div>


        </div>
    );
};

export default GradientPicker;
