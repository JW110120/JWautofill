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
        { color: 'rgba(0, 0, 0, 1)', position: 0 },
        { color: 'rgba(255, 255, 255, 1)', position: 100 }
    ]); 

    const handleAddPreset = () => {
        const newPreset: Gradient = {
            type: gradientType,
            angle,
            scale,
            reverse,
            stops: [...stops]
        };
        const newPresets = [...presets, newPreset];
        setPresets(newPresets);
        setSelectedPreset(newPresets.length - 1); // 选中新增的预设
    };

    const handleDeletePreset = (index: number) => {
        setPresets(presets.filter((_, i) => i !== index));
        if (selectedPreset === index) {
            // 如果删除的是当前选中的预设，则选中上一个预设（如果存在）
            const newSelectedIndex = index > 0 ? index - 1 : null;
            setSelectedPreset(newSelectedIndex);
            
            // 如果存在上一个预设，则应用其设置
            if (newSelectedIndex !== null) {
                const previousPreset = presets[newSelectedIndex];
                setGradientType(previousPreset.type);
                setAngle(previousPreset.angle || 0);
                setScale(previousPreset.scale || 100);
                setReverse(previousPreset.reverse || false);
                setStops([...previousPreset.stops]);
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
        setStops([...preset.stops]);
    };

    const getGradientStyle = () => {
        const stopString = stops.map(s => `${s.color} ${s.position}%`).join(', ');
        switch (gradientType) {
            case 'linear':
                return `linear-gradient(${90+angle}deg, ${stopString})`;
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

    const handleAddStop = (e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const newPosition = Math.round((clickX / rect.width) * 100);
        
        // 计算新增锚点的颜色
        const leftStop = stops.reduce((prev, curr) => 
            curr.position <= newPosition && curr.position > prev.position ? curr : prev
        , { position: -1, color: stops[0].color });
        
        const rightStop = stops.reduce((prev, curr) => 
            curr.position >= newPosition && curr.position < prev.position ? curr : prev
        , { position: 101, color: stops[stops.length-1].color });
        
        // 根据位置计算颜色插值
        const progress = (newPosition - leftStop.position) / (rightStop.position - leftStop.position);
        
        // 从rgba格式中提取颜色值
        const leftColor = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        const rightColor = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        
        if (leftColor && rightColor) {
            const r = Math.round(parseInt(leftColor[1]) * (1 - progress) + parseInt(rightColor[1]) * progress);
            const g = Math.round(parseInt(leftColor[2]) * (1 - progress) + parseInt(rightColor[2]) * progress);
            const b = Math.round(parseInt(leftColor[3]) * (1 - progress) + parseInt(rightColor[3]) * progress);
            const a = parseFloat(leftColor[4]) * (1 - progress) + parseFloat(rightColor[4]) * progress;
            
            const newColor = `rgba(${r}, ${g}, ${b}, ${a})`;
            const newStops = [...stops, { color: newColor, position: newPosition }];
            setStops(newStops.sort((a, b) => a.position - b.position));
        }
    };

    const handleStopChange = (index: number, color: string, position: number, opacity?: number) => {
        const newStops = [...stops];
        const currentStop = newStops[index];
        if (opacity !== undefined) {
            // 更新不透明度时保持原有颜色
            const rgbaValues = currentStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
            if (rgbaValues) {
                const [_, r, g, b] = rgbaValues;
                newStops[index] = {
                    ...currentStop,
                    color: `rgba(${r}, ${g}, ${b}, ${opacity / 100})`,
                    position: currentStop.position
                };
            }
        } else {
            // 更新颜色时保持原有不透明度
            const currentAlpha = currentStop.color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1';
            if (color.startsWith('#')) {
                const r = parseInt(color.slice(1, 3), 16);
                const g = parseInt(color.slice(3, 5), 16);
                const b = parseInt(color.slice(5, 7), 16);
                newStops[index] = {
                    ...currentStop,
                    color: `rgba(${r}, ${g}, ${b}, ${currentAlpha})`,
                    position: currentStop.position
                };
            } else if (color.startsWith('rgba')) {
                // 直接赋值 rgba 字符串
                newStops[index] = {
                    ...currentStop,
                    color: color,
                    position: currentStop.position
                };
            }
        }
        setStops(newStops);
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
            moveEvent.preventDefault();  // 添加这行
            const trackElement = document.querySelector('.gradient-slider-track') as HTMLElement;
            if (!trackElement) return;
            
            const rect = trackElement.getBoundingClientRect();
            const deltaX = moveEvent.clientX - dragStartX;  // 修改这里，使用dragStartX
            const newPosition = Math.max(0, Math.min(100, dragStartPosition + (deltaX / rect.width) * 100));
            
            const newStops = [...stops];
            newStops[index] = { ...newStops[index], position: newPosition };
            const sortedStops = newStops.sort((a, b) => a.position - b.position);
            setStops(sortedStops);
            // 更新选中的stop索引
            const newIndex = sortedStops.findIndex(stop => stop === newStops[index]);
            setSelectedStopIndex(newIndex);
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
            // 修改：更新不透明度时保持原有颜色
            const rgbaValues = currentStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
            if (rgbaValues) {
                const [_, r, g, b] = rgbaValues;
                newStops[index] = {
                    ...currentStop,
                    color: `rgba(${r}, ${g}, ${b}, ${opacity / 100})`,
                    position: currentStop.position
                };
            }
        } else {
            // 修改：更新颜色时保持原有不透明度
            const currentAlpha = currentStop.color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1';
            if (color.startsWith('#')) {
                const r = parseInt(color.slice(1, 3), 16);
                const g = parseInt(color.slice(3, 5), 16);
                const b = parseInt(color.slice(5, 7), 16);
                newStops[index] = {
                    ...currentStop,
                    color: `rgba(${r}, ${g}, ${b}, ${currentAlpha})`,
                    position: currentStop.position
                };
            } else if (color.startsWith('rgba')) {
                // 直接赋值 rgba 字符串
                newStops[index] = {
                    ...currentStop,
                    color: color,
                    position: currentStop.position
                };
            }
        }
        
        setStops(newStops);
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
              <div className="panel-header"><h3>颜色序列</h3></div>
                {/* 不透明度滑块区域 */}
                    <div className="opacity-input">
                        <label className="subtitle">不透明度：</label>
                        <input
                            type="number"
                            min="0"
                            max="100"
                            value={selectedStopIndex !== null 
                                ? Math.round(parseFloat(stops[selectedStopIndex].color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1') * 100)
                                : ''}
                            onChange={(e) => {
                                if (selectedStopIndex !== null) {
                                    const opacityValue = Math.max(0, Math.min(100, Number(e.target.value)));
                                    const currentStop = stops[selectedStopIndex];
                                    handleStopChange(
                                        selectedStopIndex,
                                        getRGBColor(currentStop.color),
                                        currentStop.position,
                                        opacityValue
                                    );
                                }
                            }}
                            disabled={selectedStopIndex === null}
                        />
                         <label className="subtitle">%</label>
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
                    <div className="color-slider-track">
                        {stops.map((stop, index) => (
                            <div
                                key={`color-${index}`}
                                className={`color-slider-thumb ${selectedStopIndex === index ? 'selected' : ''}`}
                                style={{ 
                                    left: `${stop.position}%`,
                                    backgroundColor: stop.color
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedStopIndex(index);
                                }}
                                >
                            </div>
                        ))}
                    </div>
                    <div className="color-input-container" >
                        <label className="subtitle">颜色：</label>
                            <span className="color-prefix">#</span>
                            <input
                                type="text"
                                value={selectedStopIndex !== null ? getRGBColor(stops[selectedStopIndex].color).toUpperCase().slice(1) : ''}
                                onChange={(e) => {
                                    if (selectedStopIndex !== null) {
                                        let value = e.target.value.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6);
                                        const newStops = [...stops];
                                        const currentStop = newStops[selectedStopIndex];
                                        const currentAlpha = currentStop.color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1';
                                        
                                        // 如果有输入值，则使用输入值；如果完全删除，则使用000000
                                        const colorValue = value || '000000';
                                        const r = parseInt(colorValue.padEnd(2, '0').slice(0, 2), 16);
                                        const g = parseInt(colorValue.padEnd(4, '0').slice(2, 4), 16);
                                        const b = parseInt(colorValue.padEnd(6, '0').slice(4, 6), 16);
                                        
                                        newStops[selectedStopIndex] = {
                                            ...currentStop,
                                            color: `rgba(${r}, ${g}, ${b}, ${currentAlpha})`
                                        };
                                        setStops([...newStops]);
                                        
                                        // 直接更新输入框的值，允许部分输入
                                        e.target.value = value;
                                    }
                                }}
                                disabled={selectedStopIndex === null}
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
                                onClick={async () => {
                                    if (selectedStopIndex !== null) {
                                        try {
                                            const result = await require("photoshop").core.executeAsModal(async (executionControl, descriptor) => {
                                                return await batchPlay(
                                                    [{
                                                        _obj: "showColorPicker",
                                                        _target: [{
                                                            _ref: "application"
                                                        }]
                                                    }],
                                                    {}
                                                );
                                            });

                                            if (result && result[0] && result[0].RGBFloatColor) {
                                                const { red, grain, blue } = result[0].RGBFloatColor;
                                                // 将0-1的浮点数转换为0-255的整数
                                                const r = Math.round(red);
                                                const g = Math.round(grain);
                                                const b = Math.round(blue);
                                                // 保持原有的透明度
                                                const currentAlpha = stops[selectedStopIndex].color.match(/,\s*([\d.]+)\s*\)$/)?.[1] || '1';
                                                const newColor = `rgba(${r}, ${g}, ${b}, ${currentAlpha})`;
                                                console.log('拾色器返回的RGB:', { r, g, b, currentAlpha, newColor, 原始: result[0].RGBFloatColor });
                                                
                                                handleStopChange(selectedStopIndex, newColor, stops[selectedStopIndex].position);
                                            }
                                        } catch (error) {
                                            console.error('Error showing color picker:', error);
                                        }
                                    }
                                }}
                            />
                        
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
            <div className="final-preview-container">
            <div className="panel-header"><h3>最终预览</h3>
            </div>
  
                <div className="final-preview" style={{
                    background: getGradientStyle()
                }} />
            </div>

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
