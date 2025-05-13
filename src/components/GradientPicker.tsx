import React, { useState } from 'react';
import { Gradient, GradientStop } from '../types/state';
import { AddIcon, DeleteIcon } from '../styles/Icons';

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
    const [selectedStopIndex, setSelectedStopIndex] = useState<number | null>(null);
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

    const handleStopChange = (index: number, color: string, position: number) => {
        const newStops = [...stops];
        newStops[index] = { color, position };
        setStops(newStops.sort((a, b) => a.position - b.position));
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
            <div className="panel-header">
                <h3>渐变设置</h3>
            </div>
                {/* 不透明度滑块区域 */}
                <div className="gradient-slider-container">
                    <div className="gradient-slider-track" onClick={handleAddStop}>
                        {stops.map((stop, index) => (
                            <div
                                key={`opacity-${index}`}
                                className={`gradient-slider-thumb ${selectedStopIndex === index ? 'selected' : ''}`}
                                style={{ left: `${stop.position}%` }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedStopIndex(index);
                                }}
                            />
                        ))}
                    </div>
                    {selectedStopIndex !== null && (
                        <div className="gradient-slider-controls">
                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={stops[selectedStopIndex].position}
                                onChange={(e) => handleStopChange(selectedStopIndex, stops[selectedStopIndex].color, Number(e.target.value))}
                            />
                            {stops.length > 1 && (
                                <sp-action-button 
                                    quiet 
                                    class="icon-button"
                                    onClick={() => handleRemoveStop(selectedStopIndex)}
                                >
                                    <DeleteIcon />
                                </sp-action-button>
                            )}
                        </div>
                    )}
                </div>

                {/* 渐变预览区域 */}
                <div 
                    className="gradient-preview" 
                    style={{
                        background: `linear-gradient(to right, ${stops.map(s => s.color).join(', ')})`,
                        cursor: 'pointer'
                    }}
                    onClick={handleAddStop}
                />

                {/* 颜色滑块区域 */}
                {/* 颜色滑块区域 */}
                <div className="gradient-slider-container">
                    <div className="gradient-slider-track" onClick={handleAddStop}>
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
                    {selectedStopIndex !== null && (
                        <div className="gradient-slider-controls">
                            <input
                                type="color"
                                value={stops[selectedStopIndex].color}
                                onChange={(e) => handleStopChange(selectedStopIndex, e.target.value, stops[selectedStopIndex].position)}
                            />
                            {stops.length > 1 && (
                                <sp-action-button 
                                    quiet 
                                    class="icon-button"
                                    onClick={() => handleRemoveStop(selectedStopIndex)}
                                >
                                    <DeleteIcon />
                                </sp-action-button>
                            )}
                        </div>
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
                <div className="checkbox-reverse">
                    <label className="checkbox-label">反向：</label>
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
