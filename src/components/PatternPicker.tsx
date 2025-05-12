import React, { useState, useEffect } from 'react';
import { Pattern } from '../types/state';
import { FileIcon, DeleteIcon } from '../styles/Icons';

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
    const [angle, setAngle] = useState<number>(0);
    const [scale, setScale] = useState<number>(100);

    const handleFileSelect = async () => {
        try {
            const files = await require('uxp').storage.localFileSystem.getFileForOpening({
                allowMultiple: true,
                types: ['jpg', 'jpeg', 'png'],
                title: '选择图案文件'
            });

            if (!files || (Array.isArray(files) && files.length === 0)) {
                return;
            }

            const fileArray = Array.isArray(files) ? files : [files];
            
            const processFile = async (file) => {
                try {
                    const arrayBuffer = await file.read({ format: require('uxp').storage.formats.binary });
                    
                    const bytes = new Uint8Array(arrayBuffer);
                    let binary = '';
                    const chunkSize = 1024;
                    
                    for (let i = 0; i < bytes.length; i += chunkSize) {
                        const chunk = bytes.slice(i, i + chunkSize);
                        chunk.forEach(byte => {
                            binary += String.fromCharCode(byte);
                        });
                    }
                    
                    const base64String = btoa(binary);
                    const fileType = file.name.split('.').pop()?.toLowerCase() || 'jpeg';
                    const dataUrl = `data:image/${fileType};base64,${base64String}`;

                    return {
                        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                        name: file.name,
                        preview: dataUrl,
                        data: arrayBuffer
                    };
                } catch (error) {
                    console.error('处理文件时发生错误:', error);
                    return null;
                }
            };

            // 修改这里：确保所有文件处理完成后再更新状态
            const newPatterns = await Promise.all(
                fileArray.map(async file => await processFile(file))
            ).then(results => results.filter(Boolean));

            // 更新状态
            setPatterns(prevPatterns => [...prevPatterns, ...newPatterns]);
            
            // 如果有新图案，自动选择第一个
            // 修改这里：移除自动调用onSelect的逻辑
            if (newPatterns.length > 0) {
                setSelectedPattern(newPatterns[0].id);
                // 移除这行：onSelect(newPatterns[0]);
            }
        } catch (error) {
            console.error('选择文件时发生错误:', error);
        }
    };  

    // 辅助函数：生成唯一ID
    const generateUniqueId = () => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    };

    // 辅助函数：将ArrayBuffer转换为base64字符串
    const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    };
    
    const handleDelete = () => {
        if (selectedPattern) {
            setPatterns(patterns.filter(p => p.id !== selectedPattern));
            setSelectedPattern(null);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="pattern-picker">
            <div className="picker-header">
                <h3>选择图案</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>

            <div className="pattern-container">
                <div className="patterns-grid">
                    {patterns.map(pattern => (
                        <div
                            key={pattern.id}
                            className={`photo-container ${selectedPattern === pattern.id ? 'selected' : ''}`}
                            onClick={() => {
                                setSelectedPattern(pattern.id);
                                onSelect(pattern);
                            }}
                        >
                            <img src={pattern.preview} alt={pattern.name} />
                        </div>
                    ))}
                </div>
            </div>

            <div className="pattern-icon-container">
                <div className="icon-group">
                    <sp-action-button 
                        quiet 
                        class="icon-button"
                        onClick={handleFileSelect}
                    >
                        <FileIcon />
                    </sp-action-button>
                    <sp-action-button 
                        quiet 
                        class="icon-button"
                        onClick={handleDelete}
                        disabled={!selectedPattern}
                    >
                        <DeleteIcon />
                    </sp-action-button>
                </div>
            </div>

            <div className="pattern-settings">
                <div className="setting-item">
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

                <div className="setting-item">
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
            </div>

            <div className="panel-footer">
                <button onClick={() => {
                    onSelect({
                        id: selectedPattern || '',
                        name: patterns.find(p => p.id === selectedPattern)?.name || '',
                        preview: patterns.find(p => p.id === selectedPattern)?.preview || '',
                        angle,
                        scale
                    });
                    onClose();
                }}>保存设置</button>
            </div>
        </div>
    );
};

export default PatternPicker;