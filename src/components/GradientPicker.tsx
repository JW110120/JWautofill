import React, { useState } from 'react';
import { Gradient, GradientStop } from '../types/state';
import { AddIcon, DeleteIcon } from '../styles/Icons';
import { ColorArea } from '@spectrum-web-components/color-area';

interface GradientPickerProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (gradient: Gradient) => void;
}

const GradientPicker: React.FC<GradientPickerProps> = ({
    isOpen,
    onClose,
    onSelect
}) => {
    const [presets, setPresets] = useState<Gradient[]>([]);
    const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
    const [gradientType, setGradientType] = useState<'linear' | 'radial' | 'angle' | 'reflected' | 'diamond'>('linear');
    const [angle, setAngle] = useState(0); // 修改默认角度为90度，使渐变从左往右
    const [scale, setScale] = useState(100);
    const [reverse, setReverse] = useState(false);
    const [colorPickerPosition, setColorPickerPosition] = useState({ x: 0, y: 0 });
    const [selectedStopIndex, setSelectedStopIndex] = useState<number | null>(null);
    const [showColorPicker, setShowColorPicker] = useState(false);
    const [stops, setStops] = useState<GradientStop[]>([
        { color: '#000000', position: 0 },
        { color: '#ffffff', position: 100 }
    ]);

    const handleAddPreset = () => {
        const newPreset: Gradient = {
            type: gradientType,
            angle,
            scale,
            reverse,
            stops: [...stops]
        };
        setPresets([...presets, newPreset]);
    };

    const handleDeletePreset = (index: number) => {
        setPresets(presets.filter((_, i) => i !== index));
        if (selectedPreset === index) {
            setSelectedPreset(null);
        }
    };

    const handlePresetSelect = (index: number) => {
        const preset = presets[index];
        setSelectedPreset(index);
        setGradientType(preset.type);
        setAngle(preset.angle || 0);
        setScale(preset.scale || 100);
        setReverse(preset.reverse || false);
        setStops([...preset.stops]);
    };

    const getGradientStyle = () => {
        const stopString = stops.map(s => `${s.color} ${s.position}%`).join(', ');
        switch (gradientType) {
            case 'linear':
                return `linear-gradient(${angle}deg, ${stopString})`;
            case 'radial':
                return `radial-gradient(circle, ${stopString})`;
            case 'angle':
                return `conic-gradient(from ${angle}deg, ${stopString})`;
            case 'reflected':
                return `repeating-linear-gradient(${angle}deg, ${stopString})`;
            case 'diamond':
                return `repeating-radial-gradient(diamond, ${stopString})`;
            default:
                return `linear-gradient(${angle}deg, ${stopString})`;
        }
    };

    const handleAddStop = () => {
        const positions = stops.map(s => s.position);
        const maxGap = Math.max(...positions.slice(1).map((pos, i) => pos - positions[i]));
        const insertIndex = positions.slice(1).findIndex((pos, i) => pos - positions[i] === maxGap);
        const newPosition = (positions[insertIndex] + positions[insertIndex + 1]) / 2;
        
        const newStops = [...stops];
        newStops.splice(insertIndex + 1, 0, { color: '#808080', position: newPosition });
        setStops(newStops.sort((a, b) => a.position - b.position));
    };

    const handleRemoveStop = (index: number) => {
        if (stops.length > 2) {
            setStops(stops.filter((_, i) => i !== index).sort((a, b) => a.position - b.position));
            setSelectedStopIndex(null);
        }
    };

    const [isDragging, setIsDragging] = useState(false);
    const [dragStartX, setDragStartX] = useState(0);
    const [dragStartPosition, setDragStartPosition] = useState(0);

    const handleStopMouseDown = (e: React.MouseEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
        setSelectedStopIndex(index);
        setDragStartX(e.clientX);
        setDragStartPosition(stops[index].position);
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            const trackElement = document.querySelector('.gradient-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - e.clientX; // 使用初始事件的clientX
            const newPosition = Math.max(0, Math.min(100, stops[index].position + (deltaX / rect.width) * 100));
            
            const newStops = [...stops];
            newStops[index] = { ...newStops[index], position: newPosition };
            setStops(newStops.sort((a, b) => a.position - b.position));
        };
        
        const handleMouseUp = () => {
            setIsDragging(false);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };



    const handleStopChange = (index: number, color: string, position: number, opacity?: number) => {
        const newStops = [...stops];
        const currentStop = newStops[index];
        
        if (opacity !== undefined) {
            // 仅更新不透明度
            const rgbaColor = currentStop.color;
            const rgbaValues = rgbaColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
            if (rgbaValues) {
                const [_, r, g, b] = rgbaValues;
                newStops[index] = {
                    ...currentStop,
                    color: `rgba(${r}, ${g}, ${b}, ${opacity / 100})`,
                    position
                };
            }
        } else {
            // 仅更新颜色，保持不透明度不变
            const currentAlpha = currentStop.color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1';
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            newStops[index] = {
                ...currentStop,
                color: `rgba(${r}, ${g}, ${b}, ${currentAlpha})`,
                position
            };
        }
        
        setStops(newStops.sort((a, b) => a.position - b.position));
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


    if (!isOpen) return null;

    return (
        <div className="gradient-picker">
            <div className="panel-header">
                <h3>预设</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>

            {/* 预设区域 */}
            <div className="gradient-presets">
                <div className="presets-grid">
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
            </div>

                     <div className="pattern-icon-container">
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

            {/* 渐变编辑区域 */}
            <div className="gradient-edit-area">
              <div className="panel-header"><h3>渐变设置</h3></div>
                {/* 不透明度滑块区域 */}
                    <div className="opacity-input">
                        <label className="sublabel">不透明度：</label>
                        <input
                            type="number"
                            min="0"
                            max="100"
                            value={selectedStopIndex !== null 
                                ? Math.round(parseFloat(stops[selectedStopIndex].color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1') * 100)
                                : 100}
                            onChange={(e) => {
                                if (selectedStopIndex !== null) {
                                    const opacityValue = Math.max(0, Math.min(100, Number(e.target.value)));
                                    handleStopChange(
                                        selectedStopIndex,
                                        stops[selectedStopIndex].color,
                                        stops[selectedStopIndex].position,
                                        opacityValue
                                    );
                                }
                            }}
                        />
                         <label className="sublabel">%</label>
                        <sp-action-button 
                            quiet 
                            className="delete-button"
                            onClick={() => selectedStopIndex !== null && stops.length >= 1 && handleRemoveStop(selectedStopIndex)}
                            disabled={selectedStopIndex === null || stops.length < 1}
                        >
                            <DeleteIcon />
                        </sp-action-button>
                    </div>
                    <div className="gradient-slider-track">
                        {stops.map((stop, index) => (
                            <div
                                key={`opacity-${index}`}
                                className={`gradient-slider-thumb ${selectedStopIndex === index ? 'selected' : ''}`}
                                style={{ 
                                    left: `${stop.position}%`,
                                    backgroundColor: stop.color
                                }}
                                onMouseDown={(e) => handleStopMouseDown(e, index)}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedStopIndex(index);
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
                </div>

                {/* 颜色滑块区域 */}
                    <div className="gradient-slider-track">
                        {stops.map((stop, index) => (
                            <div
                                key={`color-${index}`}
                                className={`gradient-slider-thumb ${selectedStopIndex === index ? 'selected' : ''}`}
                                style={{ 
                                    left: `${stop.position}%`,
                                    backgroundColor: stop.color
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedStopIndex(index);
                                }}
                            />
                        ))}
                    </div>
                    <div className="gradient-color-controls">
                        <label className="sublabel">颜色：</label>
                        <div className="color-input-container" style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' }}>
                            <input
                                type="text"
                                value={selectedStopIndex !== null ? getRGBColor(stops[selectedStopIndex].color).toUpperCase() : '#000000'}
                                readOnly
                            />
                            <div 
                                className="color-preview"
                                style={{
                                    width: '20px',
                                    height: '20px',
                                    backgroundColor: selectedStopIndex !== null ? getRGBColor(stops[selectedStopIndex].color) : '#000000',
                                    cursor: 'pointer',
                                    border: `1px solid var(--border-color)`,
                                    borderRadius: '2px'
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setShowColorPicker(!showColorPicker);
                                    setColorPickerPosition({
                                        x: e.clientX,
                                        y: e.clientY
                                    });
                                }}
                            />
                            {showColorPicker && selectedStopIndex !== null && (
                                <div style={{
                                    position: 'fixed',
                                    zIndex: 9999,
                                    top: `${colorPickerPosition.y}px`,
                                    left: `${colorPickerPosition.x}px`, 
                                    background: 'var(--background-color)',
                                    padding: '8px', 
                                    borderRadius: '4px',
                                }}>
                                    <sp-color-area 
                                        style={{
                                            width: '200px',
                                            height: '200px',
                                            display: 'block'
                                        }}
                                        color={getRGBColor(stops[selectedStopIndex].color)}
                                        onChange={(e: any) => {
                                            handleStopChange(selectedStopIndex, e.target.value, stops[selectedStopIndex].position);
                                        }}
                                    ></sp-color-area>
                                </div>
                            )}
                        </div>
                        {stops.length >= 1 && (
                            <sp-action-button 
                                quiet 
                                className="delete-button"
                                onClick={() => selectedStopIndex !== null && handleRemoveStop(selectedStopIndex)}
                                disabled={selectedStopIndex === null}
                            >
                                <DeleteIcon />
                            </sp-action-button>
                        )}
                    </div>
            </div>

            {/* 渐变类型设置 */}
            <div className="gradient-settings">
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
                            <sp-menu-item value="angle" selected={gradientType === "angle"}>角度</sp-menu-item>
                            <sp-menu-item value="reflected" selected={gradientType === "reflected"}>对称</sp-menu-item>
                            <sp-menu-item value="diamond" selected={gradientType === "diamond"}>菱形</sp-menu-item>
                        </sp-menu>
                    </sp-picker>
                </div>

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

                <div className="gradient-setting-item">
                    <label>缩放：</label>
                    <input
                        type="range"
                        min="50"
                        max="500"
                        step="1"
                        value={scale}
                        onChange={(e) => setScale(Number(e.target.value))}
                    />
                    <span className="value">{scale}%</span>
                </div>

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
            <div className="panel-header"><h3>最终预览</h3></div>
            <div className="final-preview" style={{
                background: getGradientStyle()
            }} />

            <div className="panel-footer">
                <button onClick={() => {
                    onSelect({
                        type: gradientType,
                        angle,
                        scale,
                        reverse,
                        stops,
                        presets
                    });
                    onClose();
                }}>保存设置</button>
            </div>
        </div>
    );
};

export default GradientPicker;
