import React, { useState, useEffect, useRef } from 'react';
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
    // 新增预览相关状态
    const [previewZoom, setPreviewZoom] = useState<number>(100); // 预览缩放级别
    const [previewOffset, setPreviewOffset] = useState<{x: number, y: number}>({x: 0, y: 0}); // 预览偏移
    const [isDragging, setIsDragging] = useState<boolean>(false);
    const [dragStart, setDragStart] = useState<{x: number, y: number}>({x: 0, y: 0});
    const previewRef = useRef<HTMLDivElement>(null);
    
    // 预览缩放档位
    const zoomLevels = [12.5, 25, 33, 50, 67, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1200, 1600];
    
    const mimeTypeMap = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif'
    };
    const [preserveTransparency, setPreserveTransparency] = useState<boolean>(false);
    
    // 处理预览缩放
    const handlePreviewZoomChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newZoom = Number(e.target.value);
        setPreviewZoom(newZoom);
        // 重置偏移到中心
        setPreviewOffset({x: 0, y: 0});
    };
    
    // 处理鼠标滚轮缩放
    const handlePreviewWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -1 : 1;
        const currentIndex = zoomLevels.indexOf(previewZoom);
        const newIndex = Math.max(0, Math.min(zoomLevels.length - 1, currentIndex + delta));
        setPreviewZoom(zoomLevels[newIndex]);
        setPreviewOffset({x: 0, y: 0});
    };
    
    // 处理拖拽开始
    const handlePreviewMouseDown = (e: React.MouseEvent) => {
        if (previewZoom > 100) {
            setIsDragging(true);
            setDragStart({
                x: e.clientX - previewOffset.x,
                y: e.clientY - previewOffset.y
            });
        }
    };
    
    // 处理拖拽移动
    const handlePreviewMouseMove = (e: React.MouseEvent) => {
        if (isDragging && previewZoom > 100) {
            const newOffset = {
                x: e.clientX - dragStart.x,
                y: e.clientY - dragStart.y
            };
            
            // 限制拖拽范围
            const maxOffset = (previewZoom - 100) * 2;
            newOffset.x = Math.max(-maxOffset, Math.min(maxOffset, newOffset.x));
            newOffset.y = Math.max(-maxOffset, Math.min(maxOffset, newOffset.y));
            
            setPreviewOffset(newOffset);
        }
    };
    
    // 处理拖拽结束
    const handlePreviewMouseUp = () => {
        setIsDragging(false);
    };
    
    // 添加全局鼠标事件监听
    useEffect(() => {
        const handleGlobalMouseMove = (e: MouseEvent) => {
            if (isDragging && previewZoom > 100) {
                const newOffset = {
                    x: e.clientX - dragStart.x,
                    y: e.clientY - dragStart.y
                };
                
                const maxOffset = (previewZoom - 100) * 2;
                newOffset.x = Math.max(-maxOffset, Math.min(maxOffset, newOffset.x));
                newOffset.y = Math.max(-maxOffset, Math.min(maxOffset, newOffset.y));
                
                setPreviewOffset(newOffset);
            }
        };
        
        const handleGlobalMouseUp = () => {
            setIsDragging(false);
        };
        
        if (isDragging) {
            document.addEventListener('mousemove', handleGlobalMouseMove);
            document.addEventListener('mouseup', handleGlobalMouseUp);
        }
        
        return () => {
            document.removeEventListener('mousemove', handleGlobalMouseMove);
            document.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [isDragging, dragStart, previewZoom]);


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
                        min="20"
                        max="300"
                        step="1"
                        value={scale}
                        onChange={handleScaleChange}
                    />
                        <span className="value">{scale}%</span>
                    </div>
                </div>
                <div className="pattern-checkbox-container">
                        <input
                            type="checkbox"
                            id="transparencyCheckbox"
                            checked={preserveTransparency}
                            onChange={(e) => setPreserveTransparency(e.target.checked)}
                            className="pattern-checkbox-input"
                        />
                        <label
                            htmlFor="transparencyCheckbox"
                            className="pattern-checkbox-label"
                            onClick={() => setPreserveTransparency(!preserveTransparency)}
                        >
                            保留不透明度
                        </label>
                </div>
            </div>
            {selectedPattern && (
                <div className="pattern-final-preview-container">
                    <div className="pattern-subtitle">
                        <h3>预览</h3>
                        <div className="preview-controls">
                            <sp-picker
                                size="s"
                                selects="single"
                                selected={previewZoom.toString()}
                                onChange={(e: any) => {
                                    const newZoom = Number(e.target.value);
                                    setPreviewZoom(newZoom);
                                    setPreviewOffset({x: 0, y: 0});
                                }}
                                className="zoom-picker"
                            >
                                <sp-menu>
                                    {zoomLevels.map(level => (
                                        <sp-menu-item 
                                            key={level} 
                                            value={level.toString()}
                                            selected={level === previewZoom}
                                        >
                                            {level}%
                                        </sp-menu-item>
                                    ))}
                                </sp-menu>
                            </sp-picker>
                        </div>
                    </div>
                    <div 
                        className="preview-wrapper"
                        ref={previewRef}
                        onWheel={handlePreviewWheel}
                        onMouseDown={handlePreviewMouseDown}
                        onMouseMove={handlePreviewMouseMove}
                        onMouseUp={handlePreviewMouseUp}
                        style={{
                            cursor: previewZoom > 100 ? (isDragging ? 'grabbing' : 'grab') : 'default',
                            overflow: 'hidden'
                        }}
                    >
                        <img
                            src={patterns.find(p => p.id === selectedPattern)?.preview}
                            className="pattern-final-preview"
                            style={{
                                position: 'absolute',
                                top: '50%',
                                left: '50%',
                                transform: `translate(-50%, -50%) translate(${previewOffset.x}px, ${previewOffset.y}px) rotate(${angle}deg) scale(${(scale * previewZoom) / 10000})`,
                                transformOrigin: 'center center',
                                transition: isDragging ? 'none' : 'transform 0.1s ease',
                                willChange: 'transform',
                                imageRendering: previewZoom > 400 ? 'pixelated' : 'auto'
                            }}
                            draggable={false}
                        />
                        {previewZoom > 100 && (
                            <div className="zoom-indicator">
                                {previewZoom}%
                            </div>
                        )}
                    </div>
                </div>
            )}


            <div className="panel-footer">
                <button onClick={() => {
                    const selectedPatternData = patterns.find(p => p.id === selectedPattern);
                    if (selectedPatternData) {
                        onSelect({
                            ...selectedPatternData,
                            angle,
                            scale,
                            patternName: selectedPatternData.patternName,
                            preserveTransparency // 添加保留不透明度设置
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
