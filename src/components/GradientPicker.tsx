import React, { useState } from 'react';
import { Gradient, GradientStop } from '../types/state';

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
    const [gradientType, setGradientType] = useState<'linear' | 'radial'>('linear');
    const [angle, setAngle] = useState(0);
    const [stops, setStops] = useState<GradientStop[]>([
        { color: '#000000', position: 0 },
        { color: '#ffffff', position: 100 }
    ]);

    const handleAddStop = () => {
        setStops([...stops, { color: '#ffffff', position: 50 }]);
    };

    const handleRemoveStop = (index: number) => {
        if (stops.length > 2) {
            setStops(stops.filter((_, i) => i !== index));
        }
    };

    const handleStopChange = (index: number, color: string, position: number) => {
        const newStops = [...stops];
        newStops[index] = { color, position };
        setStops(newStops);
    };

    if (!isOpen) return null;

    return (
        <div className="gradient-picker">
            <div className="panel-header">
                <h3>渐变设置</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>

            <div className="gradient-type-selector">
                <label>
                    <input
                        type="radio"
                        value="linear"
                        checked={gradientType === 'linear'}
                        onChange={(e) => setGradientType(e.target.value as 'linear' | 'radial')}
                    />
                    线性渐变
                </label>
                <label>
                    <input
                        type="radio"
                        value="radial"
                        checked={gradientType === 'radial'}
                        onChange={(e) => setGradientType(e.target.value as 'linear' | 'radial')}
                    />
                    径向渐变
                </label>
            </div>

            {gradientType === 'linear' && (
                <div className="angle-selector">
                    <label>角度：</label>
                    <input
                        type="range"
                        min="0"
                        max="360"
                        value={angle}
                        onChange={(e) => setAngle(Number(e.target.value))}
                    />
                    <span>{angle}°</span>
                </div>
            )}

            <div className="gradient-stops">
                {stops.map((stop, index) => (
                    <div key={index} className="gradient-stop">
                        <input
                            type="color"
                            value={stop.color}
                            onChange={(e) => handleStopChange(index, e.target.value, stop.position)}
                        />
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={stop.position}
                            onChange={(e) => handleStopChange(index, stop.color, Number(e.target.value))}
                        />
                        {stops.length > 2 && (
                            <button onClick={() => handleRemoveStop(index)}>删除</button>
                        )}
                    </div>
                ))}
                <button onClick={handleAddStop}>添加颜色节点</button>
            </div>

            <div className="preview-gradient" style={{
                background: gradientType === 'linear'
                    ? `linear-gradient(${angle}deg, ${stops.map(s => `${s.color} ${s.position}%`).join(', ')})`
                    : `radial-gradient(circle, ${stops.map(s => `${s.color} ${s.position}%`).join(', ')})`
            }} />

            <div className="panel-footer">
                <button onClick={() => {
                    onSelect({
                        type: gradientType,
                        angle: gradientType === 'linear' ? angle : undefined,
                        stops
                    });
                    onClose();
                }}>确认</button>
            </div>
        </div>
    );
};

export default GradientPicker;