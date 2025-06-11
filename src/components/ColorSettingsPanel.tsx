import React, { useState } from 'react';
import { ColorSettings } from '../types/state';

interface ColorSettingsProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (settings: ColorSettings) => void;
    initialSettings?: ColorSettings;
    isQuickMaskMode?: boolean;
}

const ColorSettingsPanel: React.FC<ColorSettingsProps> = ({
    isOpen,
    onClose,
    onSave,
    initialSettings = {
        hueVariation: 0,
        saturationVariation: 0,
        brightnessVariation: 0,
        opacityVariation: 0
    },
    isQuickMaskMode = false
}) => {
    const [settings, setSettings] = useState<ColorSettings>(initialSettings);
    const [isDragging, setIsDragging] = useState(false);
    const [dragTarget, setDragTarget] = useState<keyof ColorSettings | null>(null);
    const [dragStartX, setDragStartX] = useState(0);
    const [dragStartValue, setDragStartValue] = useState(0);

    const handleSliderChange = (key: keyof ColorSettings) => (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = Number(event.target.value);
        if (!isNaN(value)) {
            setSettings(prev => ({
                ...prev,
                [key]: value
            }));
        }
    };

    const handleNumberInputChange = (key: keyof ColorSettings, value: number) => {
        const maxValue = key === 'hueVariation' ? 360 : 100;
        const clampedValue = Math.max(0, Math.min(maxValue, value));
        if (!isNaN(clampedValue)) {
            setSettings(prev => ({
                ...prev,
                [key]: clampedValue
            }));
        }
    };

    const handleLabelMouseDown = (event: React.MouseEvent, key: keyof ColorSettings) => {
        event.preventDefault();
        setIsDragging(true);
        setDragTarget(key);
        setDragStartX(event.clientX);
        setDragStartValue(settings[key]);
    };

    const handleMouseMove = (event: MouseEvent) => {
        if (!isDragging || !dragTarget) return;

        const deltaX = event.clientX - dragStartX;
        const sensitivity = dragTarget === 'hueVariation' ? 1 : 0.5;
        const maxValue = dragTarget === 'hueVariation' ? 360 : 100;
        
        const newValue = Math.max(
            0,
            Math.min(maxValue, Math.round(dragStartValue + (deltaX * sensitivity)))
        );

        setSettings(prev => ({
            ...prev,
            [dragTarget]: newValue
        }));
    };

    const handleMouseUp = () => {
        setIsDragging(false);
        setDragTarget(null);
    };

    React.useEffect(() => {
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, dragTarget, dragStartX, dragStartValue]);

    if (!isOpen) return null;

    const getUnitSymbol = (key: keyof ColorSettings) => {
        return key === 'hueVariation' ? '°' : '%';
    };

    return (
        <div className="color-settings-panel">
            <div className="panel-header">
                <h3>颜色动态设置</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>
            
            <div className="colorsettings-slider-group">
                {Object.keys(settings).map((key) => {
                    if (key === 'pressureVariation') return null;
                    
                    // 在快速蒙版模式下禁用色相和饱和度抖动
                    const isDisabled = isQuickMaskMode && (key === 'hueVariation' || key === 'saturationVariation');
                    
                    return (
                        <div key={key} className={`colorsettings-slider-item ${isDisabled ? 'disabled' : ''}`}>
                            <div className="colorsettings-slider-header">
                                <label
                                    className={`colorsettings-slider-label ${isDragging && dragTarget === key ? 'dragging' : 'not-dragging'} ${isDisabled ? 'disabled' : ''}`}
                                    onMouseDown={isDisabled ? undefined : (e) => handleLabelMouseDown(e, key as keyof ColorSettings)}
                                >
                                    {key === 'hueVariation' ? '色相抖动' :
                                     key === 'saturationVariation' ? '饱和度抖动' :
                                     key === 'brightnessVariation' ? '亮度抖动' : '不透明度抖动'}
                                    {isDisabled && ' (快速蒙版模式下禁用)'}
                                </label>

                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <input
                                        type="number"
                                        min="0"
                                        max={key === 'hueVariation' ? 360 : 100}
                                        value={settings[key as keyof ColorSettings]}
                                        onChange={isDisabled ? undefined : (e) => handleNumberInputChange(key as keyof ColorSettings, Number(e.target.value))}
                                        disabled={isDisabled}
                                    />
                                    <span>
                                        {getUnitSymbol(key as keyof ColorSettings)}
                                    </span>
                                </div>
                            </div>

                            <input
                                type="range"
                                min="0"
                                max={key === 'hueVariation' ? '360' : '100'}
                                step="1"
                                value={settings[key as keyof ColorSettings]}
                                onChange={isDisabled ? undefined : handleSliderChange(key as keyof ColorSettings)}
                                disabled={isDisabled}
                            />
                        </div>
                    );
                })}
            </div>

            <div className="panel-footer">
                <button 
                    onClick={() => onSave(settings)}
                >
                    保存设置
                </button>
            </div>
        </div>
    );
};

export default ColorSettingsPanel;