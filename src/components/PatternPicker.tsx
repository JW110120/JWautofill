import React, { useState, useEffect } from 'react';
import { Pattern } from '../types/state';
import { FileIcon, DeleteIcon } from '../styles/Icons';
import { action, core } from 'photoshop';

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
    const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({});
    const mimeTypeMap = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif'
    };

    const processFile = async (file) => {
        try {
            
            // 从文件名中提取文件扩展名
            const fileExtension = file.name.split('.').pop()?.toLowerCase() || 'jpeg';
            const mimeType = mimeTypeMap[fileExtension] || 'image/png';
            
            // 读取文件内容用于预览
            const arrayBuffer = await file.read({ format: require('uxp').storage.formats.binary });
            const base64String = arrayBufferToBase64(arrayBuffer);
            const dataUrl = `data:${mimeType};base64,${base64String}`;
            
            // 创建pattern对象，保存文件引用
            const pattern = {
                id: generateUniqueId(),
                name: file.name,
                preview: dataUrl,
                file: file
            };
            
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

            if (!files || (Array.isArray(files) && files.length === 0)) {
                console.log('未选择文件');
                return;
            }

            const fileArray = Array.isArray(files) ? files : [files];
            
            const newPatterns = await Promise.all(
                fileArray.map(async file => {
                    console.log('开始处理文件:', file.name);
                    const pattern = await processFile(file);
                    if (pattern) {
                    }
                    return pattern;
                })
            ).then(results => results.filter(Boolean));
            
            setPatterns(prevPatterns => {
                const updatedPatterns = [...prevPatterns, ...newPatterns];
                return updatedPatterns;
            });

            if (newPatterns.length > 0) {
                const firstNewPattern = newPatterns[0];
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

    const handleDelete = async () => {
        if (selectedPattern) {
            const patternToDelete = patterns.find(p => p.id === selectedPattern);
            if (patternToDelete?.patternName) {
                try {
                    // 删除PS中的图案
                    await core.executeAsModal(async () => {
                        await action.batchPlay(
                            [
                                {
                                    _obj: "delete",
                                    _target: [
                                        {
                                            _ref: "pattern",
                                            _name: patternToDelete.patternName
                                        }
                                    ],
                                    _options: {
                                        dialogOptions: "dontDisplay"
                                    }
                                }
                            ],
                            { synchronousExecution: true }
                        );
                    }, { commandName: '删除图案' });
                    console.log('PS图案删除成功:', patternToDelete.patternName);
                } catch (error) {
                    console.error('删除PS图案失败:', error);
                }
            }
            
            // 从状态中删除图案
            setPatterns(patterns.filter(p => p.id !== selectedPattern));
            setSelectedPattern(null);
        }
    };

    const handleAngleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newAngle = Number(e.target.value);
        setAngle(newAngle);
    };
    
    const handleScaleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newScale = Number(e.target.value);
        setScale(newScale);
    };

    useEffect(() => {
        if (patterns.length > 0) {
            // 延迟检查DOM，确保React已完成渲染
            const timer = setTimeout(() => {
                const imgElements = document.querySelectorAll('.photo-container img');
                imgElements.forEach((img, index) => {
                    console.log(`图片[${index}]实际尺寸:`, {
                        offsetWidth: img.offsetWidth,
                        offsetHeight: img.offsetHeight,
                        clientWidth: img.clientWidth,
                        clientHeight: img.clientHeight,
                        complete: img.complete,
                        src: img.src.substring(0, 30) + '...'
                    });
                });
            }, 500); // 延迟500ms
            
            return () => clearTimeout(timer);
        }
    }, [patterns]);

    if (!isOpen) return null;

    async function createPatternFromImage() {
        // 生成唯一的文档名称
        const docName = `Pattern_${Date.now()}`;
        const patternName = `Pattern_${Date.now()}`;
        
        // 获取选中的图案
        const selectedPatternData = patterns.find(p => p.id === selectedPattern);
        if (!selectedPatternData) return;
        
        // 获取图片元素以读取实际尺寸
        const imgElement = document.querySelector('.pattern-final-preview') as HTMLImageElement;
        if (!imgElement || !imgElement.complete) return;
        
        try {
            const {localFileSystem: fs} = require("uxp").storage;
            
            // 获取文件的会话令牌
            const filePath = selectedPatternData.file.nativePath;
            const fileToken = await fs.createSessionToken(selectedPatternData.file);
            
            // 在modal scope中执行创建图案操作
            await core.executeAsModal(async () => {
                await action.batchPlay(
                    [
                        {
                            _obj: "make",
                            new: {
                                _obj: "document",
                                name: docName,
                                artboard: false,
                                autoPromoteBackgroundLayer: false,
                                mode: {
                                    _class: "RGBColorMode"
                                },
                                width: {
                                    _unit: "pixelsUnit",
                                    _value: imgElement.naturalWidth
                                },
                                height: {
                                    _unit: "pixelsUnit",
                                    _value: imgElement.naturalHeight
                                },
                                resolution: {
                                    _unit: "densityUnit",
                                    _value: 72
                                },
                                fill: {
                                    _enum: "fill",
                                    _value: "transparent"
                                }
                            },
                            _options: {
                                dialogOptions: "dontDisplay"
                            }
                        },
                        {
                            _obj: "placeEvent",
                            null: {
                                _path: fileToken,
                                _kind: "local"
                            },
                            freeTransformCenterState: {
                                _enum: "quadCenterState",
                                _value: "QCSAverage"
                            },
                            _options: {
                                dialogOptions: "dontDisplay"
                            }
                        },
                        {
                            _obj: "make",
                            _target: [
                                {
                                    _ref: "pattern"
                                }
                            ],
                            using: {
                                _ref: [
                                    {
                                       _ref: "property",
                                       _property: "selection"
                                    },
                                    {
                                       _ref: "document",
                                       _enum: "ordinal",
                                       _value: "targetEnum"
                                    }
                                 ]
                              },
                            name: patternName,
                            _options: {
                                dialogOptions: "dontDisplay"
                            }
                        },
                        {
                            _obj: "close",
                            saving: {
                                _enum: "yesNo",
                                _value: "no"
                            },
                            _options: {
                                dialogOptions: "dontDisplay"
                            }
                        }
                    ],
                    { synchronousExecution: true }
                );
            }, { commandName: '创建图案' });
            
            console.log('图案创建完成:', { docName, patternName });
            
            // 更新选中的图案对象，添加patternName属性
            setPatterns(prevPatterns => {
                return prevPatterns.map(p => {
                    if (p.id === selectedPattern) {
                        return {
                            ...p,
                            patternName: patternName // 保存创建的图案名称
                        };
                    }
                    return p;
                });
            });
            
            return patternName;
        } catch (error) {
            console.error('创建图案失败:', error);
            return null;
        }
    }

    return (
        <div className="pattern-picker">
            <div className="panel-header">
                <h3>选择图案</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>
            <div className="pattern-container">
                    {patterns.map(pattern => (
                        <div
                            key={pattern.id}
                            className={`photo-container ${selectedPattern === pattern.id ? 'selected' : ''}`}
                            onClick={() => setSelectedPattern(pattern.id)}
                        >
                            <img 
                                src={pattern.preview} 
                                alt={pattern.name}
                                onLoad={async (e) => {
                                    const img = e.currentTarget;
                                    console.log(`图片加载成功 - ${pattern.name}:`, {
                                        naturalSize: `${img.naturalWidth}x${img.naturalHeight}`,
                                        displaySize: `${img.offsetWidth}x${img.offsetHeight}`,
                                        complete: img.complete
                                    });
                                    
                                    setLoadedImages(prev => ({...prev, [pattern.id]: true}));
                                    
                                    // 只有当这个图案被选中且还没有创建过图案时才创建PS图案
                                    if (selectedPattern === pattern.id && !pattern.patternName) {
                                        const patternName = await createPatternFromImage();
                                        if (patternName) {
                                            console.log('创建图案成功', {
                                                patternName: patternName,
                                                imageSize: `${img.naturalWidth}x${img.naturalHeight}`
                                            });
                                        }
                                    }
                                }}
                                onError={(e) => {
                                    console.error(`图片加载失败 - ${pattern.name}:`, e);
                                    setLoadedImages(prev => ({...prev, [pattern.id]: false}));
                                }}
                                style={{
                                    maxWidth: '100%',
                                    maxHeight: '100%',
                                    width: 'auto',
                                    height: 'auto',
                                    objectFit: 'contain',
                                    display: 'block', // 移除条件显示
                                    opacity: loadedImages[pattern.id] ? 1 : 0, // 使用透明度来控制显示
                                    transition: 'opacity 0.2s',
                                    padding: '4px'
                                }}
                            />
                            {(!loadedImages[pattern.id] && loadedImages[pattern.id] !== true) && ( // 修改判断条件
                                <div style={{
                                    position: 'absolute',
                                    top: '0%',
                                    left: '0%',
                                    width: '100%',
                                    height: '100%',
                                    display: 'flex',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    backgroundColor: 'rgba(255,255,255,0.8)',
                                    borderRadius: '4px',
                                    color: 'var(--black-text)',
                                }}>
                                    {loadedImages[pattern.id] === false ? '加载失败' : '加载中...'}
                                </div>
                            )}
                        </div>
                    ))}
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

            <div className="pattern-settings-area">
                <div className="setting-item-group">
                    <div className="setting-item">
                        <label>角度：</label>
                    <input
                        type="range"
                        min="0"
                        max="360"
                        step="1"
                        value={angle}
                        onChange={handleAngleChange}
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
                        onChange={handleScaleChange}
                    />
                        <span className="value">{scale}%</span>
                    </div>
                </div>
            </div>
            {selectedPattern && (
                <div className="pattern-final-preview-container">
                    <div className="subtitle"><h3>预览</h3></div>
                    <div className="preview-wrapper">
                        <img
                            src={patterns.find(p => p.id === selectedPattern)?.preview}
                            className="pattern-final-preview"
                            style={{
                                position: 'absolute',
                                top: '50%',
                                left: '50%',
                                transform: `translate(-50%, -50%) rotate(${angle}deg) scale(${scale / 100})`,
                                transformOrigin: 'center center',
                                transition: 'transform 0.1s ease',
                                willChange: 'transform' // 添加这行优化性能
                            }}
                        />
                    </div>
                </div>
            )}

            <div className="panel-footer">
                <button onClick={() => {
                    const selectedPatternData = patterns.find(p => p.id === selectedPattern);
                    if (selectedPatternData) {
                        onSelect({
                            ...selectedPatternData,  // 保留原有的图案数据
                            angle,                   // 添加角度
                            scale,                   // 添加缩放
                            patternName: selectedPatternData.patternName  // 使用已创建的图案名称
                        });
                        onClose();
                    } else {
                        onClose();
                    }
                }}>保存设置</button>
            </div>
        </div>
    );
};

export default PatternPicker;
