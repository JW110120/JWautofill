import React, { useState, useEffect } from 'react';
import { Gradient, GradientStop } from '../types/state';
import { AddIcon, DeleteIcon } from '../styles/Icons';
import { app, action, core } from 'photoshop';
import { LayerInfoHandler } from '../utils/LayerInfoHandler';

const { executeAsModal } = core;
const { batchPlay } = action;

interface GradientPickerProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (gradient: Gradient | null) => void;
}

// 生成考虑中点插值的预设预览样式
const generatePresetPreviewStyle = (preset: Gradient, isInLayerMask: boolean = false, isInQuickMask: boolean = false, isInSingleColorChannel: boolean = false): string => {
    // 为预设创建临时的扩展stops
    const extendedStops = preset.stops.map((stop, i) => ({
        ...stop,
        colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
        opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
        midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < preset.stops.length - 1 ? 50 : undefined)
    }));
    
    const sortedColorStops = [...extendedStops].sort((a, b) => a.colorPosition - b.colorPosition);
    const sortedOpacityStops = [...extendedStops].sort((a, b) => a.opacityPosition - b.opacityPosition);
    
    // 采样生成渐变stops
    const sampleStep = 10; // 每10%采样一次，减少计算量
    const gradientStops: string[] = [];
    
    for (let i = 0; i <= 100; i += sampleStep) {
        const rgb = interpolateColorAtPositionForPreset(i, sortedColorStops);
        const alpha = interpolateOpacityAtPositionForPreset(i, sortedOpacityStops);
        
        if (isInLayerMask || isInQuickMask || isInSingleColorChannel) {
            // 图层蒙版模式、快速蒙版模式或单个颜色通道模式：转换为灰度值
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
    const midpoint = (leftStop.midpoint || 50) / 100;
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
    midpoint?: number;        // 与下一个stop之间的中点位置 
}

const GradientPicker: React.FC<GradientPickerProps> = ({
    isOpen,  
    onClose,
    onSelect
}) => {
    const [presets, setPresets] = useState<Gradient[]>([]);
    const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
    const [selectedPresets, setSelectedPresets] = useState<Set<number>>(new Set());
    const [lastClickedPreset, setLastClickedPreset] = useState<number | null>(null);
    const [gradientType, setGradientType] = useState<'linear' | 'radial'>('linear');
    const [angle, setAngle] = useState(0);
    const [scale, setScale] = useState(100);
    const [reverse, setReverse] = useState(false);
    const [preserveTransparency, setPreserveTransparency] = useState<boolean>(false); // 添加新状态
    const [selectedStopIndex, setSelectedStopIndex] = useState<number | null>(null);
    const [selectedStopType, setSelectedStopType] = useState<'color' | 'opacity'>('color');
    const [stops, setStops] = useState<ExtendedGradientStop[]>([ 
        { color: 'rgba(0, 0, 0, 1)', position: 0, colorPosition: 0, opacityPosition: 0, midpoint: 50 },
        { color: 'rgba(255, 255, 255, 1)', position: 100, colorPosition: 100, opacityPosition: 100, midpoint: 50 }
    ]);

    // 分离的拖拽状态
    const [isDraggingColor, setIsDraggingColor] = useState(false);
    const [isDraggingOpacity, setIsDraggingOpacity] = useState(false);
    const [isDraggingMidpoint, setIsDraggingMidpoint] = useState(false);
    const [isDraggingAngle, setIsDraggingAngle] = useState(false);
    const [dragStartX, setDragStartX] = useState(0);
    const [dragStartPosition, setDragStartPosition] = useState(0);
    const [dragStartAngle, setDragStartAngle] = useState(0); 
    const [dragStopIndex, setDragStopIndex] = useState<number | null>(null);
    const [isInLayerMask, setIsInLayerMask] = useState(false);
    const [isInQuickMask, setIsInQuickMask] = useState(false);
    const [isInSingleColorChannel, setIsInSingleColorChannel] = useState(false);

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
        if (isOpen) {
            checkMaskModes();
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
        const handleNotification = async () => {
            try {
                // 检测图层蒙版和快速蒙版状态
                await checkMaskModes();
            } catch (error) {
                // 静默处理错误，避免频繁的错误日志
            }
        };

        // 添加事件监听器
        action.addNotificationListener(['set', 'select', 'clearEvent'], handleNotification);

        // 清理函数
        return () => {
            action.removeNotificationListener(['set', 'select', 'clearEvent'], handleNotification);
        };
    }, [isOpen]);

    const handleAddPreset = () => {
        const newPreset: Gradient = {
            type: gradientType,
            angle,
            reverse,
            stops: stops.map(stop => ({
                color: stop.color,
                position: stop.position,
                // 保存扩展属性到自定义字段中
                colorPosition: stop.colorPosition,
                opacityPosition: stop.opacityPosition,
                midpoint: stop.midpoint
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
            
            // 如果删除后没有预设了，清空选中状态
            if (newPresets.length === 0) {
                setSelectedPreset(null);
            }
        } else if (index !== undefined) {
            // 删除单个预设
            const newPresets = presets.filter((_, i) => i !== index);
            setPresets(newPresets);
            
            // 如果删除后没有预设了，清空选中状态
            if (newPresets.length === 0) {
                setSelectedPreset(null);
            } else if (selectedPreset === index) {
                // 如果删除的是当前选中的预设
                const newSelectedIndex = index > 0 ? index - 1 : (newPresets.length > 0 ? 0 : null);
                setSelectedPreset(newSelectedIndex);
                
                if (newSelectedIndex !== null) {
                    const previousPreset = newPresets[newSelectedIndex];
                    setGradientType(previousPreset.type);
                    setAngle(previousPreset.angle || 0);
                    setScale(previousPreset.scale || 100);
                    setReverse(previousPreset.reverse || false);
                    setStops(previousPreset.stops.map((stop, i) => ({
                        ...stop,
                        // 如果预设中保存了扩展属性，则使用保存的值，否则使用默认值
                        colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
                        opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
                        midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < previousPreset.stops.length - 1 ? 50 : undefined)
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
            const newSelectedPresets = new Set(selectedPresets);
            if (newSelectedPresets.has(index)) {
                newSelectedPresets.delete(index);
            } else {
                newSelectedPresets.add(index);
            }
            
            setSelectedPresets(newSelectedPresets);
            setLastClickedPreset(index);
            
            // 如果多选集合为空，恢复单选状态
            if (newSelectedPresets.size === 0) {
                setSelectedPreset(index);
                const preset = presets[index];
                setGradientType(preset.type);
                setAngle(preset.angle || 0);
                setScale(preset.scale || 100);
                setReverse(preset.reverse || false);
                setStops(preset.stops.map((stop, i) => ({
                    ...stop,
                    colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
                    opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
                    midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < preset.stops.length - 1 ? 50 : undefined)
                })));
            } else {
                // 多选时清空单选状态
                setSelectedPreset(null);
            }
        } else if (event && event.shiftKey && lastClickedPreset !== null) {
            // Shift+点击：范围选择
            const newSelectedPresets = new Set(selectedPresets);
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
                setScale(preset.scale || 100);
                setReverse(preset.reverse || false);
                setStops(preset.stops.map((stop, i) => ({
                    ...stop,
                    colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
                    opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
                    midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < preset.stops.length - 1 ? 50 : undefined)
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
            setScale(preset.scale || 100);
            setReverse(preset.reverse || false);
            setStops(preset.stops.map((stop, i) => ({
                ...stop,
                // 如果预设中保存了扩展属性，则使用保存的值，否则使用默认值
                colorPosition: stop.colorPosition !== undefined ? stop.colorPosition : stop.position,
                opacityPosition: stop.opacityPosition !== undefined ? stop.opacityPosition : stop.position,
                midpoint: stop.midpoint !== undefined ? stop.midpoint : (i < preset.stops.length - 1 ? 50 : undefined)
            })));
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
            
            if (isInLayerMask || isInQuickMask || isInSingleColorChannel) {
                // 图层蒙版模式、快速蒙版模式或单个颜色通道模式：转换为灰度值
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

    // 缓存正则表达式以提升性能
    const rgbaRegex = /rgba?\((\d+),\s*(\d+),\s*(\d+)/;
    
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

    // 缓存透明度正则表达式
    const rgbaWithAlphaRegex = /rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/;
    
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
            const rgbaMatch = leftStop.color.match(rgbaWithAlphaRegex);
            return rgbaMatch ? parseFloat(rgbaMatch[4]) : 1;
        }
        
        // 计算基础插值比例
        let ratio = (position - leftStop.opacityPosition) / (rightStop.opacityPosition - leftStop.opacityPosition);
        
        // 应用中点调整
        const midpoint = (leftStop.midpoint || 50) / 100;
        if (midpoint !== 0.5) {
            if (ratio < midpoint) {
                ratio = (ratio / midpoint) * 0.5;
            } else {
                ratio = 0.5 + ((ratio - midpoint) / (1 - midpoint)) * 0.5;
            }
        }
        
        // 插值透明度
        const leftRgba = leftStop.color.match(rgbaWithAlphaRegex);
        const rightRgba = rightStop.color.match(rgbaWithAlphaRegex);
        
        if (leftRgba && rightRgba) {
            const leftAlpha = parseFloat(leftRgba[4]);
            const rightAlpha = parseFloat(rightRgba[4]);
            return leftAlpha * (1 - ratio) + rightAlpha * ratio;
        }
        
        return 1;
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
            
            if (isInLayerMask || isInQuickMask || isInSingleColorChannel) {
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
                midpoint: 50 
            }];
            const sortedStops = newStops.sort((a, b) => a.position - b.position);
            
            // 更新中点
            for (let i = 0; i < sortedStops.length - 1; i++) {
                if (!sortedStops[i].midpoint) {
                    sortedStops[i].midpoint = 50;
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
        setDragStartPosition(startPosition);
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
        setDragStartPosition(startPosition);
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
            
            // 修复选择器 - 透明度拖拽应该使用gradient-slider-track
            const trackElement = document.querySelector('.gradient-slider-track') as HTMLElement;
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
        setIsDraggingMidpoint(true);
        
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
            setIsDraggingMidpoint(false);
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
        setIsDraggingMidpoint(true);
        
        const startX = e.clientX;
        const startMidpoint = stops[index].midpoint || 50;
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.gradient-slider-track') as HTMLElement;
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
            setIsDraggingMidpoint(false);
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
        setIsDraggingAngle(true);
        setDragStartX(e.clientX);
        setDragStartAngle(angle);
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const deltaX = moveEvent.clientX - dragStartX;
            const sensitivity = 10;
            
            let newAngle = dragStartAngle + deltaX * (sensitivity / 10);
            newAngle = Math.round(newAngle);
            newAngle = Math.min(360, Math.max(0, newAngle));
            
            setAngle(newAngle);
        };
        
        const handleMouseUp = () => {
            setIsDraggingAngle(false);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
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
        return '#000000';
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
        const tilesPerRow = Math.ceil(containerWidth / tileSize);
        const rows = Math.ceil(containerHeight / tileSize);
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
                            width: tileSize,
                            height: tileSize,
                            backgroundColor: isLight ? '#ffffff' : '#cccccc',
                            // 确保无缝拼接
                            boxSizing: 'border-box'
                        }}
                    />
                );
            }
        }
        return tiles;
    };


    return (
        <div className="gradient-picker">
            <div className="panel-header">
                <h3>渐变设置</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>

            {/* 预设区域 */}
            <div className="gradient-presets-area">
                <div className="gradient-presets">
                    {presets.map((preset, index) => {
                        // 生成考虑中点插值的预设预览样式
                        const presetGradientStyle = generatePresetPreviewStyle(preset, isInLayerMask, isInQuickMask, isInSingleColorChannel);
                        
                        return (
                            <div 
                                key={index} 
                                className={`preset-item ${selectedPreset === index ? 'selected' : ''} ${selectedPresets.has(index) ? 'multi-selected' : ''}`}
                                onClick={(e) => handlePresetSelect(index, e)}
                            >
                                <div className="preset-preview" style={{
                                    position: 'relative',
                                    width: '100%',
                                    height: '100%',
                                    overflow: 'hidden'
                                }}>
                                    {/* 棋盘格背景 */}
                                    <div style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        height: '100%',
                                        zIndex: 1
                                    }}>
                                        {renderCheckerboard(50, 50, 4)}
                                    </div>
                                    {/* 渐变覆盖层 */}
                                    <div style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        height: '100%',
                                        background: presetGradientStyle,
                                        zIndex: 2
                                    }} />
                                </div>
                            </div>
                        );
                    })}
                </div>
                
                <div className="gradient-icon-container">
                    <div className="icon-group">
                        <sp-action-button 
                            quiet 
                            class="icon-button"
                            onClick={handleAddPreset}
                        >
                            <AddIcon />
                        </sp-action-button> 
                        <div className="delete-button-wrapper">
                        <sp-action-button
                            quiet
                            class="icon-button"
                            onClick={() => {
                            if (selectedPresets.size > 0) {
                                handleDeletePreset();
                            } else if (selectedPreset !== null) {
                                handleDeletePreset(selectedPreset);
                            }
                            }}
                            disabled={(selectedPreset === null && selectedPresets.size === 0) || presets.length === 0}
                            style={{
                            cursor: (selectedPreset === null && selectedPresets.size === 0) || presets.length === 0 ? 'not-allowed' : 'pointer',
                            opacity: (selectedPreset === null && selectedPresets.size === 0) || presets.length === 0 ? 0.4 : 1,
                            alignItems: 'center',
                            marginLeft: 'auto',
                            justifyContent: 'flex-end',
                            border: 'none'
                            }}
                            onMouseEnter={(e) => {
                                if (!((selectedPreset === null && selectedPresets.size === 0) || presets.length === 0)) {
                                    const iconFill = e.currentTarget.querySelector('.icon-fill');
                                    if (iconFill) iconFill.style.fill = 'var(--hover-icon)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                const iconFill = e.currentTarget.querySelector('.icon-fill');
                                if (iconFill) {
                                    iconFill.style.fill = ((selectedPreset === null && selectedPresets.size === 0) || presets.length === 0) ? 'var(--disabled-color)' : 'var(--text-color)';
                                }
                            }}
                            title="删除预设"
                        >
                            <DeleteIcon style={{
                                width: '15px',
                                height: '15px',
                                display: 'block'
                            }} />
                        </sp-action-button>
                        </div>
                    </div>
                </div>
            </div>

            {/* 渐变编辑区域 */}
            <div className="gradient-edit-area">
                <div className="gradient-subtitle"><h3>颜色渐变</h3></div>
                
                {/* 不透明度控制 */}
                {selectedStopIndex !== null && selectedStopType === 'opacity' && (
                    <div className="opacity-input">
                        <label 
                            className="gradient-subtitle draggable-label"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                const startX = e.clientX;
                                const startValue = Math.round(parseFloat(stops[selectedStopIndex].color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1') * 100);
                                
                                const handleMouseMove = (moveEvent: MouseEvent) => {
                                    const deltaX = moveEvent.clientX - startX;
                                    const newValue = Math.max(0, Math.min(100, startValue + Math.round(deltaX / 2)));
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
                            不透明度：
                        </label>
                        <input
                            type="number"
                            min="0"
                            max="100"
                            value={Math.round(parseFloat(stops[selectedStopIndex].color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1') * 100)}
                            onChange={(e) => {
                                const opacityValue = Math.max(0, Math.min(100, Number(e.target.value)));
                                handleStopChange(selectedStopIndex, undefined, undefined, opacityValue);
                            }}
                        />
                        <label className="gradient-subtitle">%</label>
                        <div className="delete-button-wrapper">
                        <sp-action-button
                            quiet
                            className="icon-button"
                            onClick={() => {
                            if (stops.length > 2) {
                                handleRemoveStop(selectedStopIndex);
                            }
                            }}
                            disabled={stops.length <= 2}
                            style={{
                            cursor: stops.length <= 2 ? 'not-allowed' : 'pointer',
                            opacity: stops.length <= 2 ? 0.5 : 1,
                            alignItems: 'center',
                            marginLeft: 'auto',
                            justifyContent: 'flex-end',
                            border: 'none'
                            }}
                            onMouseEnter={(e) => {
                                if (stops.length > 2) {
                                    const iconFill = e.currentTarget.querySelector('.icon-fill');
                                    if (iconFill) iconFill.style.fill = 'var(--hover-icon)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                const iconFill = e.currentTarget.querySelector('.icon-fill');
                                if (iconFill) {
                                    iconFill.style.fill = stops.length <= 2 ? 'var(--disabled-color)' : 'var(--text-color)';
                                }
                            }}
                            title="删除色标"
                        >
                            <DeleteIcon style={{
                                width: '15px',
                                height: '15px',
                                display: 'block'
                            }} />
                        </sp-action-button>
                        </div>
                    </div>
                )}

                {/* 透明度滑块 */}
                <div className="gradient-slider-track">
                    {stops.map((stop, index) => {
                        const rgbaMatch = stop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
                        const alpha = rgbaMatch ? parseFloat(rgbaMatch[4]) : 1;
                        const grayValue = Math.round(255 * alpha);
                        const displayColor = `rgb(${255 - grayValue}, ${255 - grayValue}, ${255 - grayValue})`;
                        
                        return (
                            <div
                                key={`opacity-${index}`}
                                className={`opacity-slider-thumb ${
                                    selectedStopIndex === index && selectedStopType === 'opacity' ? 'selected' : ''
                                }`}
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
                                        style={{
                                            position: 'absolute',
                                            left: `${leftStop.opacityPosition + (stops[selectedStopIndex].opacityPosition - leftStop.opacityPosition) * (leftStop.midpoint || 50) / 100}%`,
                                            top: '50%',
                                            transform: 'translate(-50%, -50%)',
                                            width: '6px',
                                            height: '6px',
                                            backgroundColor: 'white',
                                            border: '1px solid #666',
                                            borderRadius: '50%',
                                            cursor: 'ew-resize',
                                            zIndex: 10
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
                                        style={{
                                            position: 'absolute',
                                            left: `${stops[selectedStopIndex].opacityPosition + (rightStops[0].opacityPosition - stops[selectedStopIndex].opacityPosition) * (stops[selectedStopIndex].midpoint || 50) / 100}%`,
                                            top: '50%',
                                            transform: 'translate(-50%, -50%)',
                                            width: '6px',
                                            height: '6px',
                                            backgroundColor: 'white',
                                            border: '1px solid #666',
                                            borderRadius: '50%',
                                            cursor: 'ew-resize',
                                            zIndex: 10
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
                    <div 
                        className="opacity-checkerboard"
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            overflow: 'hidden', // 裁切超出部分
                            zIndex: 1
                        }}
                    >
                        {renderCheckerboard(220, 24)}
                    </div>
                    <div 
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            background: getPreviewGradientStyle(),
                            cursor: 'pointer',
                            zIndex: 2
                        }}
                        onClick={handleAddStop}
                    />
                </div>

                {/* 颜色滑块 */}
                <div className="color-slider-track">
                    {stops.map((stop, index) => (
                        <div
                            key={`color-${index}`}
                            className={`color-slider-thumb ${
                                selectedStopIndex === index && selectedStopType === 'color' ? 'selected' : ''
                            }`}
                            style={{ 
                                left: `${stop.colorPosition}%`,
                                backgroundColor: getRGBColor(stop.color),
                                ...(isDraggingColor && dragStopIndex === index ? {
                                    cursor: 'grabbing'
                                } : {})
                            }}
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
                                        style={{
                                            position: 'absolute',
                                            left: `${leftStop.colorPosition + (stops[selectedStopIndex].colorPosition - leftStop.colorPosition) * (leftStop.midpoint || 50) / 100}%`,
                                            top: '50%',
                                            transform: 'translate(-50%, -50%)',
                                            width: '6px',
                                            height: '6px',
                                            backgroundColor: 'white',
                                            border: '1px solid #666',
                                            borderRadius: '50%',
                                            cursor: 'ew-resize',
                                            zIndex: 10
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
                                        style={{
                                            position: 'absolute',
                                            left: `${stops[selectedStopIndex].colorPosition + (rightStop.colorPosition - stops[selectedStopIndex].colorPosition) * (stops[selectedStopIndex].midpoint || 50) / 100}%`,
                                            top: '50%',
                                            transform: 'translate(-50%, -50%)',
                                            width: '6px',
                                            height: '6px',
                                            backgroundColor: 'white',
                                            border: '1px solid #666',
                                            borderRadius: '50%',
                                            cursor: 'ew-resize',
                                            zIndex: 10
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
                    <div className="color-input-container">
                        <label className="gradient-subtitle">颜色：</label>
                        <span className="color-prefix">#</span>
                        <input
                            type="text"
                            value={getRGBColor(stops[selectedStopIndex].color).slice(1)}
                            onChange={handleColorInputChange}
                            maxLength={6}
                        />
                        <div 
                            className="color-preview"
                            style={{
                                width: '20px',
                                height: '20px',
                                backgroundColor: getRGBColor(stops[selectedStopIndex].color),
                                cursor: 'pointer',
                                border: '1px solid var(--border-color)',
                                borderRadius: '2px'
                            }}
                            onClick={async () => {
                                try {
                                    const result = await executeAsModal(async () => {
                                        return await batchPlay(
                                            [{
                                                _obj: "showColorPicker",
                                                _target: [{
                                                    _ref: "application"
                                                }]
                                            }],
                                            {}
                                        );
                                    }, { commandName: '选择颜色' });

                                    if (result && result[0] && result[0].RGBFloatColor) {
                                        const { red, grain, blue } = result[0].RGBFloatColor;
                                        const r = Math.round(red);
                                        const g = Math.round(grain);
                                        const b = Math.round(blue);
                                        const currentAlpha = stops[selectedStopIndex].color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1';
                                        const newColor = `rgba(${r}, ${g}, ${b}, ${currentAlpha})`;
                                        
                                        handleStopChange(selectedStopIndex, newColor);
                                    }
                                } catch (error) {
                                    console.error('Error showing color picker:', error);
                                }
                            }}
                        />
                        
                        <div className="delete-button-wrapper">
                        <sp-action-button
                            quiet
                            className="icon-button"
                            onClick={() => {
                            if (stops.length > 2) {
                                handleRemoveStop(selectedStopIndex);
                            }
                            }}
                            disabled={stops.length <= 2}
                            style={{
                            cursor: stops.length <= 2 ? 'not-allowed' : 'pointer',
                            opacity: stops.length <= 2 ? 0.5 : 1,
                            alignItems: 'center',
                            marginLeft: 'auto',
                            justifyContent: 'flex-end',
                            border: 'none'
                            }}
                            onMouseEnter={(e) => {
                                if (stops.length > 2) {
                                    const iconFill = e.currentTarget.querySelector('.icon-fill');
                                    if (iconFill) iconFill.style.fill = 'var(--hover-icon)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                const iconFill = e.currentTarget.querySelector('.icon-fill');
                                if (iconFill) {
                                    iconFill.style.fill = stops.length <= 2 ? 'var(--disabled-color)' : 'var(--text-color)';
                                }
                            }}
                            title="删除色标"
                        >
                            <DeleteIcon style={{
                                width: '15px',
                                height: '15px',
                                display: 'block'
                            }} />
                        </sp-action-button>
                        </div>
                    </div>
                )}
            </div>

            {/* 渐变类型设置 */}
            <div className={`gradient-settings-area ${gradientType === 'radial' ? 'radial-mode' : 'linear-mode'}`}>
                <div className="gradient-setting-item">
                    <label>样式：</label>
                    <sp-picker
                        size="s"
                        selects="single"
                        selected={gradientType}
                        onChange={(e) => setGradientType(e.target.value as typeof gradientType)}
                    >
                        <sp-menu>
                            <sp-menu-item value="linear" selected={gradientType === "linear"}>线性</sp-menu-item>
                            <sp-menu-item value="radial" selected={gradientType === "radial"}>径向</sp-menu-item>
                        </sp-menu>
                    </sp-picker>
                </div>

                {gradientType === 'linear' && (
                    <div className="gradient-setting-item">
                        <label onMouseDown={handleAngleMouseDown} style={{ cursor: isDraggingAngle ? 'ew-resize' : 'ew-resize' }}>角度：</label>
                        <input
                            type="range"
                            min="0"
                            max="360"
                            step="1"
                            value={angle}
                            style={{ cursor: 'pointer' }}
                            onChange={(e) => setAngle(Number(e.target.value))}
                        />
                        <div>
                            <input
                                type="number"
                                min="0" 
                                max="360"
                                value={angle}
                                onChange={(e) => setAngle(Number(e.target.value))}
                            />
                          <span>°</span>
                        </div>
                    </div>
                )}    

                <div className={`reverse-checkbox-group ${gradientType === 'radial' ? 'compact' : ''}`}>
                    <div className="reverse-checkbox-container">
                        <label 
                            htmlFor="reverseCheckbox"
                            onClick={() => setReverse(!reverse)}
                        >
                            反向：
                        </label>
                        <input
                            type="checkbox"
                            id="reverseCheckbox"
                            checked={reverse}
                            onChange={(e) => setReverse(e.target.checked)}
                        />
                    </div>

                    <div className="reverse-checkbox-container">
                         <label
                            htmlFor="transparencyCheckbox"
                            onClick={() => setPreserveTransparency(!preserveTransparency)}
                        >
                            保留不透明度：
                        </label>
                        <input
                            type="checkbox"
                            id="transparencyCheckbox"
                            checked={preserveTransparency}
                            onChange={(e) => setPreserveTransparency(e.target.checked)}
                        />
                       
                    </div>
                </div>
            </div>

            {/* 最终预览区域 */}
            <div className="final-preview-container">
                <div className="gradient-subtitle"><h3>最终预览</h3></div>
                <div className="final-preview">
                    {/* 当选中多个预设时不渲染预览 */}
                    {selectedPresets.size > 0 ? (
                        <div style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            color: '#666',
                            fontSize: '12px',
                            zIndex: 3,
                            pointerEvents: 'none'
                        }}>
                            已选中多个预设
                        </div>
                    ) : (
                        <>
                            {/* 棋盘格背景 */}
                            <div className="opacity-checkerboard" 
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    height: '100%',
                                    overflow: 'hidden', // 裁切超出部分
                                    zIndex: 1
                                }}
                            >
                                {renderCheckerboard(220, 150)}
                            </div>
                            {/* 渐变覆盖层 */}
                            <div style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '100%',
                                background: getGradientStyle(),
                                zIndex: 2
                            }} />
                            {/* 当渐变完全透明时显示提示 */}
                            {(() => {
                                const hasVisibleOpacity = stops.some(stop => {
                                    const rgbaMatch = stop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
                                    return rgbaMatch && parseFloat(rgbaMatch[4]) > 0;
                                });
                                
                                if (!hasVisibleOpacity) {
                                    return (
                                        <div style={{
                                            position: 'absolute',
                                            top: '50%',
                                            left: '50%',
                                            transform: 'translate(-50%, -50%)',
                                            color: '#666',
                                            fontSize: '12px',
                                            zIndex: 3,
                                            pointerEvents: 'none'
                                        }}>
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

            <div className="panel-footer">
                <button onClick={() => {
                    // 多选时或没有选中预设时传递null，只有单选了预设才传递渐变对象
                    if (selectedPresets.size > 0 || selectedPreset === null) {
                        onSelect(null);
                    } else if (selectedPreset !== null && presets[selectedPreset]) {
                        onSelect({
                            type: gradientType,
                            angle,
                            reverse,
                            stops: stops.map(({ midpoint, colorPosition, opacityPosition, ...stop }) => stop), // 移除扩展属性
                            preserveTransparency, // 添加这个属性
                            presets
                        });
                    } else {
                        onSelect(null);
                    }
                    onClose();
                }}>保存设置</button>
            </div>
        </div>
    );
};

export default GradientPicker;
