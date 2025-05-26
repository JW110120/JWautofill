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

    const getGradientStyle = () => {
        const displayStops = reverse
            ? stops.map(s => ({ ...s, position: 100 - s.position })).sort((a, b) => a.position - b.position)
            : stops;
        const stopString = displayStops.map(s => `${s.color} ${s.position}%`).join(', ');
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
        
        if (position !== undefined) {
            newStops[index] = {
                ...newStops[index],
                position: position
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
        setDragStartPosition(stops[index].position);
        setDragStopIndex(index);
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.color-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - dragStartX;
            const newPosition = Math.max(0, Math.min(100, dragStartPosition + (deltaX / rect.width) * 100));
            
            handleStopChange(index, undefined, newPosition);
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
        setDragStartPosition(stops[index].position);
        setDragStopIndex(index);
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.gradient-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - dragStartX;
            const newPosition = Math.max(0, Math.min(100, dragStartPosition + (deltaX / rect.width) * 100));
            
            handleStopChange(index, undefined, newPosition);
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

    // 中点拖拽处理
    const handleMidpointMouseDown = (e: React.MouseEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingMidpoint(true);
        setDragStartX(e.clientX);
        setDragStartPosition(stops[index].midpoint || 50);
        setDragStopIndex(index);
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const trackElement = document.querySelector('.gradient-preview') as HTMLElement;
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
                <div className="subtitle"><h3>颜色序列</h3></div>
                
                {/* 不透明度控制 */}
                {selectedStopIndex !== null && selectedStopType === 'opacity' && (
                    <div className="opacity-input">
                        <label className="subtitle">不透明度：</label>
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
                        <label className="subtitle">%</label>
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

                {/* 透明度滑块 */}
                <div className="gradient-slider-track">
                    {stops.map((stop, index) => (
                        <div
                            key={`opacity-${index}`}
                            className={`gradient-slider-thumb ${selectedStopIndex === index && selectedStopType === 'opacity' ? 'selected' : ''}`}
                            style={{ 
                                left: `${stop.position}%`,
                                backgroundColor: stop.color
                            }}
                            onMouseDown={(e) => handleOpacityStopMouseDown(e, index)}
                            onClick={(e) => {
                                e.stopPropagation();
                                setSelectedStopIndex(index);
                                setSelectedStopType('opacity');
                            }}
                        />
                    ))}
                </div>

                {/* 渐变预览区域 */}
                <div className="gradient-preview">
                    <div 
                        className="opacity-checkerboard"
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0
                        }}
                    />
                    <div 
                        style={{
                            position: 'relative',
                            width: '100%',
                            height: '100%',
                            background: `linear-gradient(to right, ${stops.map(s => `${s.color} ${s.position}%`).join(', ')})`,
                            cursor: 'pointer'
                        }}
                        onClick={handleAddStop}
                    />
                    
                    {/* 中点滑块 */}
                    {selectedStopIndex !== null && (
                        <>
                            {/* 左侧中点 */}
                            {selectedStopIndex > 0 && (
                                <div
                                    className="midpoint-slider"
                                    style={{
                                        position: 'absolute',
                                        left: `${stops[selectedStopIndex - 1].position + (stops[selectedStopIndex].position - stops[selectedStopIndex - 1].position) * (stops[selectedStopIndex - 1].midpoint || 50) / 100}%`,
                                        top: '50%',
                                        transform: 'translate(-50%, -50%)',
                                        width: '8px',
                                        height: '8px',
                                        backgroundColor: 'white',
                                        border: '1px solid #666',
                                        borderRadius: '50%',
                                        cursor: 'ew-resize',
                                        zIndex: 10
                                    }}
                                    onMouseDown={(e) => handleMidpointMouseDown(e, selectedStopIndex - 1)}
                                />
                            )}
                            
                            {/* 右侧中点 */}
                            {selectedStopIndex < stops.length - 1 && (
                                <div
                                    className="midpoint-slider"
                                    style={{
                                        position: 'absolute',
                                        left: `${stops[selectedStopIndex].position + (stops[selectedStopIndex + 1].position - stops[selectedStopIndex].position) * (stops[selectedStopIndex].midpoint || 50) / 100}%`,
                                        top: '50%',
                                        transform: 'translate(-50%, -50%)',
                                        width: '8px',
                                        height: '8px',
                                        backgroundColor: 'white',
                                        border: '1px solid #666',
                                        borderRadius: '50%',
                                        cursor: 'ew-resize',
                                        zIndex: 10
                                    }}
                                    onMouseDown={(e) => handleMidpointMouseDown(e, selectedStopIndex)}
                                />
                            )}
                        </>
                    )}
                </div>

                {/* 颜色滑块 */}
                <div className="color-slider-track">
                    {stops.map((stop, index) => (
                        <div
                            key={`color-${index}`}
                            className={`color-slider-thumb ${selectedStopIndex === index && selectedStopType === 'color' ? 'selected' : ''}`}
                            style={{ 
                                left: `${stop.position}%`,
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
                </div>
                
                {/* 颜色控制 */}
                {selectedStopIndex !== null && selectedStopType === 'color' && (
                    <div className="color-input-container">
                        <label className="subtitle">颜色：</label>
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

                <div className="gradient-setting-item">
                    <div className="reverse-checkbox-container">
                        <label>反向：</label>
                        <input
                            type="checkbox"
                            checked={reverse}
                            onChange={(e) => setReverse(e.target.checked)}
                        />
                    </div>
                </div>
            </div>

            {/* 预览区域 */}
            <div className="final-preview-container">
                <div className="subtitle"><h3>最终预览</h3></div>
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
                        stops: stops.map(({ midpoint, ...stop }) => stop), // 移除midpoint
                        presets
                    });
                    onClose();
                }}>保存设置</button>
            </div>
        </div>
    );
};

export default GradientPicker;
