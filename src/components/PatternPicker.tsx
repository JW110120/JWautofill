import React, { useState, useEffect } from 'react';
import { Pattern } from '../types/state';

interface PatternPickerProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (pattern: Pattern) => void;
}

const PatternPicker: React.FC<PatternPickerProps> = ({
    isOpen,
    onClose,
    onSelect
}) => {
    const [patterns, setPatterns] = useState<Pattern[]>([]);
    const [selectedPattern, setSelectedPattern] = useState<string | null>(null);

    useEffect(() => {
        // 这里可以添加加载图案的逻辑
        // 示例数据
        setPatterns([
            { id: 'pattern1', name: '点状纹理', preview: 'path/to/preview1' },
            { id: 'pattern2', name: '线条纹理', preview: 'path/to/preview2' },
            { id: 'pattern3', name: '网格纹理', preview: 'path/to/preview3' },
        ]);
    }, []);

    if (!isOpen) return null;

    return (
        <div className="pattern-picker">
            <div className="picker-header">
                <h3>选择图案</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>

            <div className="patterns-grid">
                {patterns.map(pattern => (
                    <div
                        key={pattern.id}
                        className={`pattern-item ${selectedPattern === pattern.id ? 'selected' : ''}`}
                        onClick={() => {
                            setSelectedPattern(pattern.id);
                            onSelect(pattern);
                        }}
                    >
                        <img src={pattern.preview} alt={pattern.name} />
                        <span>{pattern.name}</span>
                    </div>
                ))}
            </div>

            <div className="picker-footer">
                <button onClick={() => {
                    const selected = patterns.find(p => p.id === selectedPattern);
                    if (selected) onSelect(selected);
                    onClose();
                }}>确认</button>
            </div>
        </div>
    );
};

export default PatternPicker;