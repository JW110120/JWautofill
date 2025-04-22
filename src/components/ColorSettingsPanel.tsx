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

    const handleSliderChange = (key: keyof ColorSettings) => (event: React.ChangeEvent<HTMLInputElement>) => {
        setSettings(prev => ({
            ...prev,
            [key]: Number(event.target.value)
        }));
    };

    if (!isOpen) return null;

    return (
        <div className="color-settings-panel">
            <div className="panel-header">
                <h3>颜色动态设置</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>
            
            <div className="slider-group">
                <div className="slider-item">
                    <label>色相变化</label>
                    <input
                        type="range"
                        min="0"
                        max="360"
                        value={settings.hueVariation}
                        onChange={handleSliderChange('hueVariation')}
                    />
                    <span>{settings.hueVariation}°</span>
                </div>

                <div className="slider-item">
                    <label>饱和度变化</label>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        value={settings.saturationVariation}
                        onChange={handleSliderChange('saturationVariation')}
                    />
                    <span>{settings.saturationVariation}%</span>
                </div>

                <div className="slider-item">
                    <label>亮度变化</label>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        value={settings.brightnessVariation}
                        onChange={handleSliderChange('brightnessVariation')}
                    />
                    <span>{settings.brightnessVariation}%</span>
                </div>

                <div className="slider-item">
                    <label>不透明度变化</label>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        value={settings.opacityVariation}
                        onChange={handleSliderChange('opacityVariation')}
                    />
                    <span>{settings.opacityVariation}%</span>
                </div>

                <div className="slider-item">
                    <label>压力变化</label>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        value={settings.pressureVariation}
                        onChange={handleSliderChange('pressureVariation')}
                    />
                    <span>{settings.pressureVariation}%</span>
                </div>
            </div>

            <div className="panel-footer">
                <button onClick={() => onSave(settings)}>保存设置</button>
            </div>
        </div>
    );
};

export default ColorSettingsPanel;