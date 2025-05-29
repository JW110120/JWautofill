import React, { useState } from 'react';
import { Gradient, GradientStop } from '../types/state';
import { AddIcon, DeleteIcon } from '../styles/Icons';
import { app, action, core } from 'photoshop';

const { executeAsModal } = core;
const { batchPlay } = action;

interface GradientPickerProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (gradient: Gradient) => void;
}

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
    const [gradientType, setGradientType] = useState<'linear' | 'radial'>('linear');
    const [angle, setAngle] = useState(0);
    const [scale, setScale] = useState(100);
    const [reverse, setReverse] = useState(false);
    const [preserveTransparency, setPreserveTransparency] = useState<boolean>(false); // 添加新状态
    const [selectedStopIndex, setSelectedStopIndex] = useState<number | null>(null);
    const [selectedStopType, setSelectedStopType] = useState<'color' | 'opacity'>('color');
    const [stops, setStops] = useState<ExtendedGradientStop[]>([
        { color: 'rgba(0, 0, 0, 1)', position: 0, colorPosition: 0, opacityPosition: 0, midpoint: 50 },
        { color: 'rgba(255, 255, 255, 1)', position: 100, colorPosition: 100, opacityPosition: 100 }
    ]);

    // 分离的拖拽状态
    const [isDraggingColor, setIsDraggingColor] = useState(false);
    const [isDraggingOpacity, setIsDraggingOpacity] = useState(false);
    const [isDraggingMidpoint, setIsDraggingMidpoint] = useState(false);
    const [dragStartX, setDragStartX] = useState(0);
    const [dragStartPosition, setDragStartPosition] = useState(0);
    const [dragStopIndex, setDragStopIndex] = useState<number | null>(null);

    const handleAddPreset = () => {
        const newPreset: Gradient = {
            type: gradientType,
            angle,
            reverse,
            stops: stops.map(({ midpoint, colorPosition, opacityPosition, ...stop }) => stop)
        };
        const newPresets = [...presets, newPreset];
        setPresets(newPresets);
        setSelectedPreset(newPresets.length - 1);
    };

    const handleDeletePreset = (index: number) => {
        setPresets(presets.filter((_, i) => i !== index));
        if (selectedPreset === index) {
            const newSelectedIndex = index > 0 ? index - 1 : null;
            setSelectedPreset(newSelectedIndex);
            
            if (newSelectedIndex !== null) {
                const previousPreset = presets[newSelectedIndex];
                setGradientType(previousPreset.type);
                setAngle(previousPreset.angle || 0);
                setScale(previousPreset.scale || 100);
                setReverse(previousPreset.reverse || false);
                setStops(previousPreset.stops.map((stop, i) => ({
                    ...stop,
                    colorPosition: stop.position,
                    opacityPosition: stop.position,
                    midpoint: i < previousPreset.stops.length - 1 ? 50 : undefined
                })));
            }
        }
    };

    const handlePresetSelect = (index: number) => {
        const preset = presets[index];
        setSelectedPreset(index);
        setGradientType(preset.type);
        setAngle(preset.angle || 0);
        setScale(preset.scale || 100);
        setReverse(preset.reverse || false);
        setStops(preset.stops.map((stop, i) => ({
            ...stop,
            colorPosition: stop.position,
            opacityPosition: stop.position,
            midpoint: i < preset.stops.length - 1 ? 50 : undefined
        })));
    };

// 修正的预览渐变函数
const getPreviewGradientStyle = () => {
    // 创建一个综合的渐变，同时考虑颜色位置和透明度位置
    const allPositions = new Set<number>();
    
    // 收集所有位置点
    stops.forEach(stop => {
        allPositions.add(stop.colorPosition);
        allPositions.add(stop.opacityPosition);
    });
    
    const sortedPositions = Array.from(allPositions).sort((a, b) => a - b);
    
    const gradientStops = sortedPositions.map(position => {
        // 在当前位置插值颜色
        const colorAtPosition = interpolateColor(position, 'color');
        // 在当前位置插值透明度
        const opacityAtPosition = interpolateOpacity(position);
        
        const rgbaMatch = colorAtPosition.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgbaMatch) {
            const [_, r, g, b] = rgbaMatch;
            return `rgba(${r}, ${g}, ${b}, ${opacityAtPosition}) ${position}%`;
        }
        return `rgba(0, 0, 0, ${opacityAtPosition}) ${position}%`;
    });
    
    // 注意：这里不应用 reverse，只是纯粹的预览
    return `linear-gradient(to right, ${gradientStops.join(', ')})`;
};

    // 颜色插值函数
    const interpolateColor = (position: number, type: 'color' | 'opacity') => {
        const relevantStops = type === 'color' 
            ? [...stops].sort((a, b) => a.colorPosition - b.colorPosition)
            : [...stops].sort((a, b) => a.opacityPosition - b.opacityPosition);
            
        const pos = type === 'color' ? 'colorPosition' : 'opacityPosition';
        
        // 找到位置两侧的stop
        let leftStop = relevantStops[0];
        let rightStop = relevantStops[relevantStops.length - 1];
        
        for (let i = 0; i < relevantStops.length - 1; i++) {
            if (relevantStops[i][pos] <= position && relevantStops[i + 1][pos] >= position) {
                leftStop = relevantStops[i];
                rightStop = relevantStops[i + 1];
                break;
            }
        }
        
        if (leftStop[pos] === rightStop[pos]) {
            return leftStop.color;
        }
        
        // 计算插值比例
        const ratio = (position - leftStop[pos]) / (rightStop[pos] - leftStop[pos]);
        
        // 插值颜色
        const leftRgba = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        const rightRgba = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        
        if (leftRgba && rightRgba) {
            const r = Math.round(parseInt(leftRgba[1]) * (1 - ratio) + parseInt(rightRgba[1]) * ratio);
            const g = Math.round(parseInt(leftRgba[2]) * (1 - ratio) + parseInt(rightRgba[2]) * ratio);
            const b = Math.round(parseInt(leftRgba[3]) * (1 - ratio) + parseInt(rightRgba[3]) * ratio);
            return `rgb(${r}, ${g}, ${b})`;
        }
        
        return leftStop.color;
    };

    // 透明度插值函数
    const interpolateOpacity = (position: number) => {
        const opacityStops = [...stops].sort((a, b) => a.opacityPosition - b.opacityPosition);
        
        // 找到位置两侧的stop
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
            const rgbaMatch = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
            return rgbaMatch ? parseFloat(rgbaMatch[4]) : 1;
        }
        
        // 计算插值比例
        const ratio = (position - leftStop.opacityPosition) / (rightStop.opacityPosition - leftStop.opacityPosition);
        
        // 插值透明度
        const leftRgba = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        const rightRgba = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        
        if (leftRgba && rightRgba) {
            const leftAlpha = parseFloat(leftRgba[4]);
            const rightAlpha = parseFloat(rightRgba[4]);
            return leftAlpha * (1 - ratio) + rightAlpha * ratio;
        }
        
        return 1;
    };

    const getGradientStyle = () => {
        // 构建带中点的渐变字符串，使用colorPosition和opacityPosition
        const sortedStops = [...stops].sort((a, b) => a.colorPosition - b.colorPosition);
        let gradientStops: string[] = [];
        
        for (let i = 0; i < sortedStops.length; i++) {
            const currentStop = sortedStops[i];
            gradientStops.push(`${currentStop.color} ${currentStop.colorPosition}%`);
            
            // 如果有下一个stop且当前stop有中点设置，添加中点
            if (i < sortedStops.length - 1 && currentStop.midpoint !== undefined && currentStop.midpoint !== 50) {
                const nextStop = sortedStops[i + 1];
                const midpointPosition = currentStop.colorPosition + (nextStop.colorPosition - currentStop.colorPosition) * (currentStop.midpoint / 100);
                
                // 在中点位置插入颜色过渡
                const progress = currentStop.midpoint / 100;
                const currentRgba = currentStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
                const nextRgba = nextStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
                
                if (currentRgba && nextRgba) {
                    const r = Math.round(parseInt(currentRgba[1]) * (1 - progress) + parseInt(nextRgba[1]) * progress);
                    const g = Math.round(parseInt(currentRgba[2]) * (1 - progress) + parseInt(nextRgba[2]) * progress);
                    const b = Math.round(parseInt(currentRgba[3]) * (1 - progress) + parseInt(nextRgba[3]) * progress);
                    const a = parseFloat(currentRgba[4]) * (1 - progress) + parseFloat(nextRgba[4]) * progress;
                    
                    gradientStops.push(`rgba(${r}, ${g}, ${b}, ${a}) ${midpointPosition}%`);
                }
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
        setIsDraggingColor(true);
        setSelectedStopIndex(index);
        setSelectedStopType('color');
        setDragStartX(e.clientX);
        setDragStartPosition(stops[index].colorPosition);
        setDragStopIndex(index);
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.color-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - dragStartX;
            const newPosition = Math.max(0, Math.min(100, dragStartPosition + (deltaX / rect.width) * 100));
            
            handleStopChange(index, undefined, undefined, undefined, newPosition);
        };
        
        const handleMouseUp = () => {
            setIsDraggingColor(false);
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
        setIsDraggingOpacity(true);
        setSelectedStopIndex(index);
        setSelectedStopType('opacity');
        setDragStartX(e.clientX);
        setDragStartPosition(stops[index].opacityPosition);
        setDragStopIndex(index);
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.gradient-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - dragStartX;
            const newPosition = Math.max(0, Math.min(100, dragStartPosition + (deltaX / rect.width) * 100));
            
            handleStopChange(index, undefined, undefined, undefined, undefined, newPosition);
        };
        
        const handleMouseUp = () => {
            setIsDraggingOpacity(false);
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
        setDragStartX(e.clientX);
        setDragStartPosition(stops[index].midpoint || 50);
        setDragStopIndex(index);
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.color-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - dragStartX;
            const newMidpoint = Math.max(0, Math.min(100, dragStartPosition + (deltaX / rect.width) * 100));
            
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
        setDragStartX(e.clientX);
        setDragStartPosition(stops[index].midpoint || 50);
        setDragStopIndex(index);
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.gradient-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - dragStartX;
            const newMidpoint = Math.max(0, Math.min(100, dragStartPosition + (deltaX / rect.width) * 100));
            
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

    return (
        <div className="gradient-picker">
            <div className="panel-header">
                <h3>渐变设置</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>

            {/* 预设区域 */}
            <div className="gradient-presets-area">
                <div className="gradient-presets">
                    {presets.map((preset, index) => (
                        <div 
                            key={index} 
                            className={`preset-item ${selectedPreset === index ? 'selected' : ''}`}
                            onClick={() => handlePresetSelect(index)}
                        >
                            <div className="preset-preview" style={{
                                background: getGradientStyle()
                            }} />
                        </div>
                    ))}
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
                        <sp-action-button 
                            quiet 
                            class="icon-button" 
                            onClick={() => {
                                if (selectedPreset !== null) {
                                    handleDeletePreset(selectedPreset);
                                }
                            }}
                            disabled={selectedPreset === null}
                        >
                            <DeleteIcon />
                        </sp-action-button>
                    </div>
                </div>
            </div>

            {/* 渐变编辑区域 */}
            <div className="gradient-edit-area">
                <div className="gradient-subtitle"><h3>颜色渐变</h3></div>
                
                {/* 不透明度控制 */}
                {selectedStopIndex !== null && selectedStopType === 'opacity' && (
                    <div className="opacity-input">
                        <label className="gradient-subtitle">不透明度：</label>
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
                        <sp-action-button 
                            quiet 
                            className="delete-button"
                            onClick={() => handleRemoveStop(selectedStopIndex)}
                            disabled={stops.length <= 2}
                        >
                            <DeleteIcon />
                        </sp-action-button>
                    </div>
                )}

                {/* 透明度滑块 - 修改样式 */}
                <div className="gradient-slider-track">
                    {stops.map((stop, index) => {
                        // 计算透明度stop的显示颜色
                        const rgbaMatch = stop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
                        const alpha = rgbaMatch ? parseFloat(rgbaMatch[4]) : 1;
                        const grayValue = Math.round(255 * alpha); // 0% = 白色(255), 100% = 黑色(0)
                        const displayColor = `rgb(${255 - grayValue}, ${255 - grayValue}, ${255 - grayValue})`;
                        
                        return (
                            <div
                                key={`opacity-${index}`}
                                className={`gradient-slider-thumb ${selectedStopIndex === index && selectedStopType === 'opacity' ? 'selected' : ''}`}
                                style={{ 
                                    left: `${stop.opacityPosition}%`,
                                    backgroundColor: displayColor,
                                    border: selectedStopIndex === index && selectedStopType === 'opacity' 
                                        ? '2px solid var(--primary-color)' 
                                        : '2px solid var(--border-color)' // 修复选中状态边框颜色
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
                            backgroundImage: `
                              linear-gradient(45deg, #ccc 25%, transparent 25%),
                              linear-gradient(-45deg, #ccc 25%, transparent 25%),
                              linear-gradient(45deg, transparent 75%, #ccc 75%),
                              linear-gradient(-45deg, transparent 75%, #ccc 75%)`,
                            backgroundSize: '10px 10px',
                            backgroundPosition: '0 0, 0 5px, 5px -5px, -5px 0px',
                            zIndex: 1
                        }}
                    />
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
                            className={`color-slider-thumb ${selectedStopIndex === index && selectedStopType === 'color' ? 'selected' : ''}`}
                            style={{ 
                                left: `${stop.colorPosition}%`,
                                backgroundColor: getRGBColor(stop.color)
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
                                // 找到当前选中stop左侧最近的stop
                                const leftStops = stops.filter((_, i) => i !== selectedStopIndex && stops[i].colorPosition < stops[selectedStopIndex].colorPosition);
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
                                // 找到当前选中stop右侧最近的stop
                                const rightStops = stops.filter((_, i) => i !== selectedStopIndex && stops[i].colorPosition > stops[selectedStopIndex].colorPosition);
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
                        
                        <sp-action-button 
                            quiet 
                            className="delete-button"
                            onClick={() => handleRemoveStop(selectedStopIndex)}
                            disabled={stops.length <= 2}
                        >
                            <DeleteIcon />
                        </sp-action-button>
                    </div>
                )}
            </div>

            {/* 渐变类型设置 */}
            <div className="gradient-settings-area">
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
                        <label>角度：</label>
                        <input
                            type="range"
                            min="0"
                            max="360"
                            step="1"
                            value={angle}
                            onChange={(e) => setAngle(Number(e.target.value))}
                        />
                        <span className="value">{angle}°</span>
                    </div>
                )}    

                <div className="reverse-checkbox-group">
                    <div className="reverse-checkbox-container">
                        <label>反向：</label>
                        <input
                            type="checkbox"
                            checked={reverse}
                            onChange={(e) => setReverse(e.target.checked)}
                        />
                    </div>

                    <div className="reverse-checkbox-container">
                         <label
                            htmlFor="transparencyCheckbox"
                            className="pattern-checkbox-label"
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
                <div className="final-preview" style={{
                    background: getGradientStyle()
                }} />
            </div>

            <div className="panel-footer">
                <button onClick={() => {
                    onSelect({
                        type: gradientType,
                        angle,
                        reverse,
                        stops: stops.map(({ midpoint, colorPosition, opacityPosition, ...stop }) => stop), // 移除扩展属性
                        preserveTransparency,// 添加这个属性
                        presets
                    });
                    onClose();
                }}>保存设置</button>
            </div>
        </div>
    );
};

export default GradientPicker;
