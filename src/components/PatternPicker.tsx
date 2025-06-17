import React, { useState, useEffect, useRef } from 'react';
import { Pattern } from '../types/state';
import { FileIcon, DeleteIcon } from '../styles/Icons';
import { action, core, imaging, app } from 'photoshop';

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
    
    // 拖动状态
    const [isDragging, setIsDragging] = useState(false);
    const [dragTarget, setDragTarget] = useState<'angle' | 'scale' | null>(null);
    const [dragStartX, setDragStartX] = useState(0);
    const [dragStartValue, setDragStartValue] = useState(0);
    const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({});
    // 新增预览相关状态
    const [previewZoom, setPreviewZoom] = useState<number>(100); // 预览缩放级别
    const [previewOffset, setPreviewOffset] = useState<{x: number, y: number}>({x: 0, y: 0}); // 预览偏移
    
    // 监听 patterns 状态变化，检查 grayData 是否正确设置
    useEffect(() => {
        patterns.forEach(pattern => {
            if (pattern.patternName && pattern.grayData) {
                console.log('✅ 图案灰度数据已设置:', {
                    patternId: pattern.id,
                    patternName: pattern.patternName,
                    hasGrayData: !!pattern.grayData,
                    grayDataLength: pattern.grayData.length,
                    patternDimensions: `${pattern.width}x${pattern.height}`,
                });
            }
        });
    }, [patterns]);
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
    const handlePreviewZoomChange = (e: any) => {
            console.log('Zoom change event:', e); // 添加调试日志
            let newZoom;
            
            // 尝试多种方式获取值
            if (e.target && e.target.value) {
                newZoom = Number(e.target.value);
            } else if (e.target && e.target.selected) {
                newZoom = Number(e.target.selected);
            } else if (e.detail && e.detail.value) {
                newZoom = Number(e.detail.value);
            } else {
                // 如果都获取不到，尝试从事件对象本身获取
                newZoom = Number(e);
            }
            
            console.log('New zoom value:', newZoom); // 添加调试日志
            
            if (newZoom && zoomLevels.includes(newZoom)) {
                setPreviewZoom(newZoom);
                setPreviewOffset({x: 0, y: 0});
                console.log('Zoom set to:', newZoom); // 添加调试日志
            }
    };
    
    // 处理预览鼠标滚轮缩放
    const handlePreviewWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -1 : 1;
        const currentIndex = zoomLevels.indexOf(previewZoom);
        const newIndex = Math.max(0, Math.min(zoomLevels.length - 1, currentIndex + delta));
        setPreviewZoom(zoomLevels[newIndex]);
        setPreviewOffset({x: 0, y: 0});
    };
    
    // 处理预览拖拽开始
    const handlePreviewMouseDown = (e: React.MouseEvent) => {
        if (previewZoom > 100) {
            setIsDragging(true);
            setDragStart({
                x: e.clientX - previewOffset.x,
                y: e.clientY - previewOffset.y
            });
        }
    };
    
    // 处理预览拖拽移动
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
    
    // 处理预览拖拽结束
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

    // 更新图案的缩放和旋转参数（不进行实际变换，由ClearHandler处理）
    const updatePatternTransform = async (patternId: string, newScale: number, newAngle: number) => {
        setPatterns(prevPatterns => {
            return prevPatterns.map(p => {
                if (p.id === patternId) {
                    return {
                        ...p,
                        currentScale: newScale,
                        currentAngle: newAngle
                    };
                }
                return p;
            });
        });
        
        console.log('图案参数更新完成:', {
            patternId,
            scale: newScale,
            angle: newAngle
        });
    };

    const handleAngleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newAngle = Number(e.target.value);
        setAngle(newAngle);
        
        // 如果有选中的图案，更新其变换
        if (selectedPattern) {
            updatePatternTransform(selectedPattern, scale, newAngle);
        }
    };
    
    const handleScaleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newScale = Number(e.target.value);
        setScale(newScale);
        
        // 如果有选中的图案，更新其变换
        if (selectedPattern) {
            updatePatternTransform(selectedPattern, newScale, angle);
        }
    };
    
    // 滑块拖动事件处理
    const handleMouseDown = (event: React.MouseEvent, target: 'angle' | 'scale') => {
        setIsDragging(true);
        setDragTarget(target);
        setDragStartX(event.clientX);
        setDragStartValue(target === 'angle' ? angle : scale);
        event.preventDefault();
    };
    
    const handleMouseMove = (event: MouseEvent) => {
        if (!isDragging || !dragTarget) return;
        
        const deltaX = event.clientX - dragStartX;
        const sensitivity = 10;
        
        let newValue = dragStartValue + deltaX * (sensitivity / 10);
        newValue = Math.round(newValue);
        
        if (dragTarget === 'angle') {
            newValue = Math.min(360, Math.max(0, newValue));
            setAngle(newValue);
        } else if (dragTarget === 'scale') {
            newValue = Math.min(300, Math.max(20, newValue));
            setScale(newValue);
        }
    };
    
    const handleMouseUp = () => {
        setIsDragging(false);
        setDragTarget(null);
    };
    
    useEffect(() => {
        if (isDragging) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            return () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };
        }
    }, [isDragging, dragTarget, dragStartX, dragStartValue, angle, scale]);

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

    // 从RGB数据转换为灰度数据
    const convertRGBToGrayData = (rgbData: Uint8Array, width: number, height: number): Uint8Array => {
        const grayData = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            const r = rgbData[i * 3];
            const g = rgbData[i * 3 + 1];
            const b = rgbData[i * 3 + 2];
            // 使用标准的RGB到灰度转换公式
            const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            grayData[i] = gray;
        }
        return grayData;
    };



    const createPatternFromImage = async () => {
        // 生成唯一的文档名称
        const docName = `Pattern_${Date.now()}`;
        const patternName = `Pattern_${Date.now()}`;
        
        // 获取选中的图案
        let selectedPatternData = patterns.find(p => p.id === selectedPattern);
        if (!selectedPatternData) return;
        
        // 获取图片元素以读取实际尺寸
        const imgElement = document.querySelector('.pattern-final-preview') as HTMLImageElement;
        if (!imgElement || !imgElement.complete) return;
        
        try {
            const {localFileSystem: fs} = require("uxp").storage;
            
            // 获取文件的会话令牌
            const filePath = selectedPatternData.file.nativePath;
            const fileToken = await fs.createSessionToken(selectedPatternData.file);
            
            let patternGrayData: Uint8Array | null = null;
            let patternWidth = 0;
            let patternHeight = 0;
            let pixelData: any = null;
            let rgbData: Uint8Array | null = null;
            
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
                        }
                    ],
                    { synchronousExecution: true }
                );
                
                // 栅格化图层
                await action.batchPlay(
                    [
                        {
                            _obj: "rasterizeLayer",
                            _target: [
                                {
                                    _ref: "layer",
                                    _enum: "ordinal",
                                    _value: "targetEnum"
                                }
                            ],
                            _options: {
                                dialogOptions: "dontDisplay"
                            }
                        }
                    ],
                    {}
                );
                
                
                // 设置默认值
                const defaultWidth = imgElement.naturalWidth;
                const defaultHeight = imgElement.naturalHeight;
                
                try {
                    const activeDoc = app.activeDocument;
                    
                    // 按照官方API格式获取文档的像素数据
                    let options = {
                        "documentID": activeDoc.id,
                        "targetSize": {
                            "height": imgElement.naturalHeight,
                            "width": imgElement.naturalWidth
                        },
                        "componentSize": 8,
                        "applyAlpha": true,
                        "colorProfile": "sRGB IEC61966-2.1"
                    };
                    
                    // 如果有选中的图层，添加图层ID
                    let activeLayers = activeDoc.activeLayers;
                    if (activeLayers.length > 0) {
                        options["layerID"] = activeLayers[0].id;
                    }
                    
                    pixelData = await imaging.getPixels(options);
                    
                    // 获取实际的像素数据
                    if (pixelData && pixelData.imageData) {
                        
                        // getData()返回Promise，需要await
                        const dataPromise = pixelData.imageData.getData();
                        
                        if (dataPromise && typeof dataPromise.then === 'function') {
                            // 如果是Promise，等待解析
                            rgbData = await dataPromise;
                        } else {
                            // 如果不是Promise，直接使用
                            rgbData = dataPromise;
                        }
                        
                        console.log('获取到像素数据:', {
                            width: pixelData.imageData.width,
                            height: pixelData.imageData.height,
                            components: pixelData.imageData.components,
                            colorSpace: pixelData.imageData.colorSpace,
                            dataLength: rgbData ? rgbData.length : 'rgbData为undefined'
                        });
                        
                        // 如果仍然没有数据，尝试其他方法
                        if (!rgbData) {
                            console.warn('getData()解析后仍为空，尝试直接访问data属性');
                            rgbData = pixelData.imageData.data || pixelData.imageData.pixels;
                        }
                    } else {
                        throw new Error('获取的像素数据格式不正确');
                    }
                    
                } catch (pixelError) {
                    console.error('获取像素数据失败:', pixelError);
                }
                
                // 确保rgbData不为null
                if (!rgbData) {
                    rgbData = new Uint8Array(defaultWidth * defaultHeight * 3).fill(128);
                    console.warn('rgbData为空，使用默认数据');
                }
                
                // 确保pixelData不为null
                if (!pixelData) {
                    pixelData = {
                        imageData: {
                            width: defaultWidth,
                            height: defaultHeight,
                            components: 3,
                            colorSpace: 'RGB'
                        }
                    };
                    console.warn('pixelData为空，使用默认数据');
                }
                
                // 转换RGB数据为灰度数据
                console.log('🔄 开始转换RGB数据为灰度数据:', {
                    rgbDataLength: rgbData!.length,
                    expectedLength: pixelData.imageData.width * pixelData.imageData.height * 3,
                    dimensions: `${pixelData.imageData.width}x${pixelData.imageData.height}`
                });
                
                const originalGrayData = convertRGBToGrayData(
                    rgbData!, 
                    pixelData.imageData.width, 
                    pixelData.imageData.height
                );
                
                console.log('✅ 灰度数据转换完成:', {
                    originalGrayDataLength: originalGrayData.length,
                    expectedLength: pixelData.imageData.width * pixelData.imageData.height,
                    sampleValues: Array.from(originalGrayData.slice(0, 10))
                });
                
                // 直接使用原始灰度数据，变换处理由ClearHandler负责
                patternGrayData = originalGrayData;
                patternWidth = pixelData.imageData.width;
                patternHeight = pixelData.imageData.height;
                
                console.log('✅ 原始灰度数据准备完成:', {
                    grayDataLength: patternGrayData.length,
                    dimensions: `${patternWidth}x${patternHeight}`,
                    expectedLength: patternWidth * patternHeight
                });
                
                // 保存原始灰度数据用于后续变换
                selectedPatternData.originalGrayData = originalGrayData;
                
                console.log('图案灰度数据处理完成:', {
                    originalSize: `${pixelData.imageData.width}x${pixelData.imageData.height}`,
                    transformedSize: `${patternWidth}x${patternHeight}`,
                    scale: scale,
                    angle: angle
                });
                
                // 释放图像数据以避免内存泄漏
                if (pixelData && pixelData.imageData && pixelData.imageData.dispose) {
                    pixelData.imageData.dispose();
                }
                
                console.log('最终数据检查:', {
                    patternWidth,
                    patternHeight,
                    patternGrayDataLength: patternGrayData ? patternGrayData.length : 0,
                    rgbDataLength: rgbData ? rgbData.length : 0
                });
                
                // 创建图案
                await action.batchPlay(
                    [
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
            
            // 更新选中的图案对象，添加patternName和灰度数据
            console.log('📝 准备更新图案状态:', {
                selectedPatternId: selectedPattern,
                patternName: patternName,
                hasPatternGrayData: !!patternGrayData,
                patternGrayDataLength: patternGrayData ? patternGrayData.length : 0,
                patternDimensions: `${patternWidth}x${patternHeight}`
            });
            
            setPatterns(prevPatterns => {
                const updatedPatterns = prevPatterns.map(p => {
                    if (p.id === selectedPattern) {
                        const updatedPattern = {
                            ...p,
                            patternName: patternName,
                            grayData: patternGrayData,
                            originalGrayData: selectedPatternData.originalGrayData,
                            width: patternWidth,
                            height: patternHeight,
                            originalWidth: pixelData.imageData.width,
                            originalHeight: pixelData.imageData.height,
                            currentScale: scale,
                            currentAngle: angle
                        };
                        
                        console.log('🔄 图案状态更新:', {
                            patternId: p.id,
                            beforeUpdate: { hasGrayData: !!p.grayData },
                            afterUpdate: { hasGrayData: !!updatedPattern.grayData, grayDataLength: updatedPattern.grayData?.length }
                        });
                        
                        return updatedPattern;
                    }
                    return p;
                });
                
                return updatedPatterns;
            });
            
            return patternName;
        } catch (error) {
            console.error('创建图案失败:', error);
            return null;
        }
    };

    if (!isOpen) return null;

    return (
        <div className="pattern-picker">
            <div className="panel-header">
                <h3>选择图案</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>
            <div className="pattern-container">
                 <div className="pattern-preset">
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
                                            console.log('图案创建请求完成', {
                                                patternName: patternName,
                                                imageSize: `${img.naturalWidth}x${img.naturalHeight}`,
                                                note: '灰度数据将在状态更新后可用'
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
                            <div className="delete-button-wrapper">
                                <sp-action-button
                                    quiet
                                    class="icon-button"
                                    onClick={() => {
                                        if (selectedPattern) {
                                            handleDelete();
                                        }
                                    }}
                                    disabled={!selectedPattern}
                                    style={{
                                        cursor: !selectedPattern ? 'not-allowed' : 'pointer',
                                        opacity: !selectedPattern ? 0.4 : 1,
                                        padding: '4px',
                                        background: 'none',
                                        border: 'none',
                                        borderRadius: '4px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center'
                                    }}
                                    onMouseEnter={(e) => {
                                        if (selectedPattern) {
                                            const iconFill = e.currentTarget.querySelector('.icon-fill');
                                            if (iconFill) iconFill.style.fill = 'var(--hover-icon)';
                                        }
                                    }}
                                    onMouseLeave={(e) => {
                                        const iconFill = e.currentTarget.querySelector('.icon-fill');
                                        if (iconFill) {
                                            iconFill.style.fill = !selectedPattern ? 'var(--disabled-color)' : 'var(--text-color)';
                                        }
                                    }}
                                    title="删除图案"
                                >
                                    <DeleteIcon style={{
                                        width: '15px',
                                        height: '15px',
                                        display: 'block'
                                    }} />
                                </sp-action-button>
                        </div>
                        </div>
                     </div>
            </div>

            

            <div className="pattern-settings-area">
                <div className="pattern-setting-item-group">
                    <div className="pattern-setting-item">
                        <label onMouseDown={(e) => handleMouseDown(e, 'angle')} style={{ cursor: isDragging && dragTarget === 'angle' ? 'ew-resize' : 'ew-resize' }}>角度：
                            <div>
                            <input
                                type="number"
                                min="0"
                                max="360"
                                value={angle}
                                onChange={(e) => setAngle(Number(e.target.value))}
                            />
                            <span>°</span>
                            </div>
                        </label>

                        <input
                            type="range"
                            min="0"
                            max="360"
                            step="1"
                            value={angle}
                            onChange={handleAngleChange}
                        />
                    </div>

                    <div className="pattern-setting-item">
                        <label onMouseDown={(e) => handleMouseDown(e, 'scale')} style={{ cursor: isDragging && dragTarget === 'scale' ? 'ew-resize' : 'ew-resize' }}>缩放：
                            <div>
                                <input
                                    type="number"
                                    min="20"
                                    max="300"
                                    value={scale}
                                    onChange={(e) => setScale(Number(e.target.value))}
                                />
                                <span>%</span>
                            </div>
                        </label>
                        <input
                            type="range"
                            min="20"
                            max="300"
                            step="1"
                            value={scale}
                            onChange={handleScaleChange}
                        />
                    </div>
                </div>

                <div className="pattern-checkbox-container">
                       <label
                            htmlFor="transparencyCheckbox"
                            className="pattern-checkbox-label"
                            onClick={() => setPreserveTransparency(!preserveTransparency)}
                        >
                            保留不透明度:
                       </label>
                       <input
                            type="checkbox"
                            id="transparencyCheckbox"
                            checked={preserveTransparency}
                            onChange={(e) => setPreserveTransparency(e.target.checked)}
                            className="pattern-checkbox-input"
                        />
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
                                onChange={handlePreviewZoomChange}
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
                            className="pattern-final-preview"
                            src={patterns.find(p => p.id === selectedPattern)?.preview}
                            alt="Pattern Preview"
                            style={{
                                position: 'absolute',
                                top: '50%',
                                left: '50%',
                                maxWidth: `${previewZoom * (scale / 100)}%`,
                                maxHeight: `${previewZoom * (scale / 100)}%`,
                                width: 'auto',
                                height: 'auto',
                                objectFit: 'contain',
                                transform: `translate(-50%, -50%) translate(${previewOffset.x}px, ${previewOffset.y}px) rotate(${angle}deg)`,
                                transformOrigin: 'center center',
                                imageRendering: previewZoom > 400 ? 'pixelated' : 'auto'
                            }}
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
