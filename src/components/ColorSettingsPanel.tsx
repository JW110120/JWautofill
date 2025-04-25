import React, { useState } from 'react';
import { ColorSettings } from '../types/state';

interface ColorSettingsProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (settings: ColorSettings) => void;
    initialSettings?: ColorSettings;
}

const ColorSettingsPanel: React.FC<ColorSettingsProps> = ({
    isOpen,
    onClose,
    onSave,
    initialSettings = {
        hueVariation: 0,
        saturationVariation: 0,
        brightnessVariation: 0,
        opacityVariation: 0,
        pressureVariation: 0
    }
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
            
            <div className="slider-group">
                {Object.keys(settings).map((key) => (
                    <div key={key} className="slider-item">
                        <label
                            className={`slider-label ${isDragging && dragTarget === key ? 'dragging' : 'not-dragging'}`}
                            onMouseDown={(e) => handleLabelMouseDown(e, key as keyof ColorSettings)}
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                width: '100%',
                                marginBottom: '5px',
                                fontSize: '13px',
                                cursor: 'ew-resize',
                                userSelect: 'none'
                            }}
                        >
                            <span style={{ flexShrink: 0 }}>
                                {key === 'hueVariation' ? '色相抖动' :
                                 key === 'saturationVariation' ? '饱和度抖动' :
                                 key === 'brightnessVariation' ? '亮度抖动' :
                                 key === 'opacityVariation' ? '不透明度抖动' : '压力抖动'}
                            </span>
                            <span className="slider-value" style={{ marginLeft: 'auto' }}>
                                {settings[key as keyof ColorSettings]}{getUnitSymbol(key as keyof ColorSettings)}
                            </span>
                        </label>
                        <input
                            type="range"
                            min="0"
                            max={key === 'hueVariation' ? '360' : '100'}
                            step="1"
                            value={settings[key as keyof ColorSettings]}
                            onChange={handleSliderChange(key as keyof ColorSettings)}
                            className="slider-input"
                            style={{ width: '100%', margin: '5px 0' }}
                        />
                    </div>
                ))}
            </div>

            <div className="panel-footer">
                <button 
                    onClick={() => onSave(settings)}
                    className="save-button"
                >
                    保存设置
                </button>
            </div>
        </div>
    );
};

export default ColorSettingsPanel;