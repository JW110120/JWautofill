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

    const processFile = async (file) => {
        try {
            console.log('开始处理文件:', file.name);
            
            const arrayBuffer = await file.read({ format: require('uxp').storage.formats.binary });
            console.log('文件读取成功，大小:', arrayBuffer.byteLength, 'bytes');
            
            if (arrayBuffer.byteLength === 0) {
                throw new Error('文件内容为空');
            }
            
            const base64String = arrayBufferToBase64(arrayBuffer);
            console.log('Base64转换成功，长度:', base64String.length);
            
            const fileType = file.name.split('.').pop()?.toLowerCase() || 'jpeg';
            const dataUrl = `data:image/${fileType};base64,${base64String}`;
            // 直接创建pattern对象，不进行图片验证
            const pattern = {
                id: generateUniqueId(),
                name: file.name,
                preview: dataUrl,
                data: arrayBuffer
            };
            console.log('Pattern对象创建成功:', pattern.name);
            
            return pattern;
        } catch (error) {
            console.error('处理文件失败:', file.name, error);
            return null;
        }
    };

    // 使用已有的辅助函数
    const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    };
    
    const handleFileSelect = async () => {
        try {
            const files = await require('uxp').storage.localFileSystem.getFileForOpening({
                allowMultiple: true,
                types: ['jpg', 'jpeg', 'png'],
                title: '选择图案文件'
            });

            console.log('文件选择对话框已打开');

            if (!files || (Array.isArray(files) && files.length === 0)) {
                console.log('未选择文件');
                return;
            }

            const fileArray = Array.isArray(files) ? files : [files];
            console.log('选择的文件数量:', fileArray.length);
            
            const newPatterns = await Promise.all(
                fileArray.map(async file => {
                    console.log('开始处理文件:', file.name);
                    const pattern = await processFile(file);
                    if (pattern) {
                        console.log('文件处理成功，pattern创建完成:', pattern.name);
                    }
                    return pattern;
                })
            ).then(results => results.filter(Boolean));

            console.log('所有文件处理完成，成功数量:', newPatterns.length);
            console.log('新创建的patterns:', newPatterns);
            
            setPatterns(prevPatterns => {
                console.log('当前patterns:', prevPatterns);
                const updatedPatterns = [...prevPatterns, ...newPatterns];
                console.log('更新后的patterns:', updatedPatterns);
                return updatedPatterns;
            });

            if (newPatterns.length > 0) {
                const firstNewPattern = newPatterns[0];
                console.log('选择第一个新图案:', firstNewPattern.name);
                setSelectedPattern(firstNewPattern.id);
            }
        } catch (error) {
            console.error('文件选择过程出错:', error);
        }
    };

    // 辅助函数：生成唯一ID
    const generateUniqueId = () => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    };

    const handleDelete = () => {
        if (selectedPattern) {
            setPatterns(patterns.filter(p => p.id !== selectedPattern));
            setSelectedPattern(null);
        }
    };

    useEffect(() => {
        if (patterns.length > 0) {
            const imgElements = document.querySelectorAll('.photo-container img');
            imgElements.forEach(img => {
                console.log('图片实际尺寸:', {
                    offsetWidth: img.offsetWidth,
                    offsetHeight: img.offsetHeight,
                    clientWidth: img.clientWidth,
                    clientHeight: img.clientHeight
                });
            });
        }
    }, [patterns]);

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
                                // 不要在这里直接调用 onSelect
                            }}
                        >
                            <img 
                                src={pattern.preview} 
                                alt={pattern.name}
                                onLoad={(e) => {
                                    const img = e.currentTarget;
                                    setTimeout(() => {
                                        console.log('延迟测量:', {
                                            offsetWidth: img.offsetWidth,
                                            offsetHeight: img.offsetHeight
                                        });
                                    }, 50);
                                }}
                                onError={(e) => {
                                    console.error('图片加载失败:', {
                                        patternName: pattern.name,
                                        error: e,
                                        src: pattern.preview.substring(0, 100) + '...'
                                    });
                                }}
                                style={{
                                    width: '100%',
                                    height: '100%',
                                    objectFit: 'cover'
                                }}
                            />
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
                    const selectedPatternData = patterns.find(p => p.id === selectedPattern);
                    if (selectedPatternData) {
                        onSelect({
                            ...selectedPatternData,  // 保留原有的图案数据
                            angle,                   // 添加角度
                            scale                    // 添加缩放
                        });
                    }
                    onClose();
                }}>保存设置</button>
            </div>
        </div>
    );
};

export default PatternPicker;