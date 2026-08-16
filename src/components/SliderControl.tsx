import React from 'react';
import { ColorSettings } from '../types/state';
import RangeSlider from './RangeSlider';

interface SliderControlProps {
    settingKey: keyof ColorSettings;
    label: string;
    value: number;
    min: number;
    max: number;
    unit: string;
    isDraggingActive: boolean;
    onValueChange: (key: keyof ColorSettings, value: number) => void;
    onLabelMouseDown: (event: React.MouseEvent, key: keyof ColorSettings) => void;
}

const SliderControl: React.FC<SliderControlProps> = ({
    settingKey,
    label,
    value,
    min,
    max,
    unit,
    isDraggingActive,
    onValueChange,
    onLabelMouseDown,
}) => {
    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const numValue = Number(event.target.value);
        if (!isNaN(numValue)) {
            const clampedValue = Math.max(min, Math.min(max, numValue));
            onValueChange(settingKey, clampedValue);
        }
    };

    const handleRangeChange = (value: number) => {
        onValueChange(settingKey, value); // RangeSlider 已按 min/max/step 吸附
    };

    return (
        <div className="colorsettings-slider-item">
            <div className="colorsettings-slider-header">
                <label
                    className={`colorsettings-slider-label ${isDraggingActive ? 'dragging' : 'not-dragging'}`}
                    onMouseDown={(e) => onLabelMouseDown(e, settingKey)}
                >
                    {label}
                </label>

                <div style={{ display: 'flex', alignItems: 'center' }}>
                    <input
                        type="number"
                        min={min}
                        max={max}
                        value={value || 0}
                        onChange={handleInputChange}
                    />
                    <span>{unit}</span>
                </div>
            </div>

            <RangeSlider
                min={min}
                max={max}
                step={1}
                value={value || 0}
                onChange={handleRangeChange}
                className="colorsettings-slider-range"
            />
        </div>
    );
};

export default SliderControl;