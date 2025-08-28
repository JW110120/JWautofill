import React, { useState, useEffect, useRef } from 'react';
import { Pattern } from '../types/state';
import { FileIcon, DeleteIcon } from '../styles/Icons';
import { action, core, imaging, app } from 'photoshop';
import { LayerInfoHandler } from '../utils/LayerInfoHandler';
import { PresetManager } from '../utils/PresetManager';

interface PatternPickerProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (pattern: Pattern) => void;
    isClearMode?: boolean;
}
    //-------------------------------------------------------------------------------------------------
    // 定义图案面板上的核心选项参数
    const PatternPicker: React.FC<PatternPickerProps> = ({
        isOpen,
        onClose,
        onSelect,
        isClearMode = false
    }) => {
    const [patterns, setPatterns] = useState<Pattern[]>([]);
    const [selectedPattern, setSelectedPattern] = useState<string | null>(null);
    const [selectedPatterns, setSelectedPatterns] = useState<Set<string>>(new Set());
    const [lastClickedPattern, setLastClickedPattern] = useState<string | null>(null);
    const [angle, setAngle] = useState<number>(0);
    const [scale, setScale] = useState<number>(100);

    // 新增滑动条拖拽状态    
    const [isSliderDragging, setIsSliderDragging] = useState(false);
    const [dragTarget, setDragTarget] = useState<'angle' | 'scale' | null>(null);
    const [dragStartX, setDragStartX] = useState(0);
    const [dragStartValue, setDragStartValue] = useState(0);

    const [fillMode, setFillMode] = useState<'stamp' | 'tile'>('stamp'); // 填充模式状态，默认为单次
    const [rotateAll, setRotateAll] = useState(true); // 全部旋转状态，默认勾选

    // 新增预览拖拽状态
    const [isPreviewDragging, setIsPreviewDragging] = useState<boolean>(false);
    const [dragStart, setDragStart] = useState<{x: number, y: number}>({x: 0, y: 0});
    const previewRef = useRef<HTMLDivElement>(null);
    
    // 新增预览相关状态
    const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({});
    const [previewZoom, setPreviewZoom] = useState<number>(100); // 预览缩放级别
    const [previewOffset, setPreviewOffset] = useState<{x: number, y: number}>({x: 0, y: 0}); // 预览偏移
    
    
    // 预览缩放档位
    const zoomLevels = [12.5, 25, 33, 50, 67, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1200, 1600];

    // 定义可载入图案类型
    const mimeTypeMap = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
    };
    const [preserveTransparency, setPreserveTransparency] = useState<boolean>(false);
    
    // 添加蒙版状态检测
    const [isInLayerMask, setIsInLayerMask] = useState(false);
    const [isInQuickMask, setIsInQuickMask] = useState(false);
    const [isInSingleColorChannel, setIsInSingleColorChannel] = useState(false);
    
    // 添加灰度预览URL缓存
    const [grayPreviewUrls, setGrayPreviewUrls] = useState<Record<string, string>>({});
    
    // 添加当前背景色状态用于检测主题变化
    const [currentBgColor, setCurrentBgColor] = useState<string>('');
    
    // 添加preview wrapper的引用
    const previewWrapperRef = useRef<HTMLDivElement>(null);

    // 实时更新功能：使用防抖机制避免频繁调用
    useEffect(() => {
        if (!selectedPattern || selectedPatterns.size > 0) return;

        // 拖拽滑块时不触发 onSelect，避免频繁调用 PS 接口导致“程序错误”弹窗
        if (isSliderDragging) return;
        
        const selectedPatternData = patterns.find(p => p.id === selectedPattern);
        if (selectedPatternData && selectedPatternData.grayData && selectedPatternData.patternRgbData) {
            const patternToSend = {
                ...selectedPatternData,
                angle,
                scale,
                fillMode,
                rotateAll,
                preserveTransparency,
                components: selectedPatternData.patternComponents || selectedPatternData.components || 3,
                currentScale: scale,
                currentAngle: angle
            };
            
            // 使用防抖机制，延迟300ms后再调用onSelect，避免频繁更新导致性能问题
            const debounceTimeoutId = setTimeout(() => {
                onSelect(patternToSend);
            }, 300);
            
            return () => clearTimeout(debounceTimeoutId);
        }
    }, [selectedPattern, angle, scale, fillMode, rotateAll, preserveTransparency, patterns, selectedPatterns.size]);

    // 面板打开时加载已保存的图案预设
    useEffect(() => {
        if (!isOpen) return;
        (async () => {
            try {
                const savedPatterns = await PresetManager.loadPatternPresets();
                if (Array.isArray(savedPatterns) && savedPatterns.length > 0) {
                    setPatterns(savedPatterns);
                }
            } catch (err) {
                console.error('加载图案预设失败:', err);
            }
        })();
    }, [isOpen]);

    // 当图案预设变更时，持久化保存（仅保存可序列化字段）
    useEffect(() => {
        (async () => {
            try {
                await PresetManager.savePatternPresets(patterns);
            } catch (err) {
                console.error('保存图案预设失败:', err);
            }
        })();
    }, [patterns]);

    // 组件卸载时强制保存预设，确保数据不丢失
    useEffect(() => {
        return () => {
            // 组件卸载时的清理函数
            if (patterns.length > 0) {
                console.log('🚨 PatternPicker: 组件卸载，强制保存预设');
                // 使用同步方式尝试保存，虽然可能不完全可靠，但比不保存好
                PresetManager.savePatternPresets(patterns).catch(error => {
                    console.error('❌ PatternPicker: 组件卸载时保存失败:', error);
                });
            }
        };
    }, [patterns]);

    // 定期自动保存预设（每30秒）
    useEffect(() => {
        if (!isOpen || patterns.length === 0) return;
        
        const autoSaveInterval = setInterval(async () => {
            try {
                console.log('🔄 PatternPicker: 定期自动保存预设');
                await PresetManager.savePatternPresets(patterns);
            } catch (error) {
                console.error('❌ PatternPicker: 定期保存失败:', error);
            }
        }, 30000); // 30秒间隔
        
        return () => {
            clearInterval(autoSaveInterval);
        };
    }, [isOpen, patterns]);

    //-------------------------------------------------------------------------------------------------
    // 新增滑块拖动事件处理
    const handleMouseDown = (event: React.MouseEvent, target: 'angle' | 'scale') => {
        setIsSliderDragging(true);
        setDragTarget(target);
        setDragStartX(event.clientX);
        setDragStartValue(target === 'angle' ? angle : scale);
        event.preventDefault();
    };
    
    // 处理滑块拖拽开始
    const handleMouseMove = (event: MouseEvent) => {
        if (!isSliderDragging || !dragTarget) return;
        
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

    // 处理滑块拖拽结束
    const handleMouseUp = () => {
        setIsSliderDragging(false);
        setDragTarget(null);
    };

    // 监听鼠标在拖动滑块时的状态。
    useEffect(() => {
        if (isSliderDragging) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            return () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };
        }
    }, [isSliderDragging, dragTarget, dragStartX, dragStartValue, angle, scale]);

    // 拖动结束后，同步一次图案的变换状态，避免拖动期间频繁更新
    useEffect(() => {
        if (!isSliderDragging && selectedPattern) {
            updatePatternTransform(selectedPattern, scale, angle);
        }
    }, [isSliderDragging]);


    //-------------------------------------------------------------------------------------------------
    // 新增各种与预览交互时的逻辑。
    // 处理预览缩放
    const handlePreviewZoomChange = (e: any) => {
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
            
            if (newZoom && zoomLevels.includes(newZoom)) {
                setPreviewZoom(newZoom);
                setPreviewOffset({x: 0, y: 0});
            }
    };
    
    // 处理预览鼠标滚轮切换缩放下拉菜单
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
            setIsPreviewDragging(true);
            setDragStart({
                x: e.clientX - previewOffset.x,
                y: e.clientY - previewOffset.y
            });
        }
    };
    
    // 处理预览拖拽移动
    const handlePreviewMouseMove = (e: React.MouseEvent) => {
        if (isPreviewDragging && previewZoom > 100) {
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
        setIsPreviewDragging(false);
    };
    
    // 添加鼠标拖拽图案预览事件监听
    useEffect(() => {
        const handleGlobalMouseMove = (e: MouseEvent) => {
            if (isPreviewDragging && previewZoom > 100) {
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
            setIsPreviewDragging(false);
        };
        
        if (isPreviewDragging) {
            document.addEventListener('mousemove', handleGlobalMouseMove);
            document.addEventListener('mouseup', handleGlobalMouseUp);
        }
        
        return () => {
            document.removeEventListener('mousemove', handleGlobalMouseMove);
            document.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [isPreviewDragging, dragStart, previewZoom]);

    // 检测蒙版模式的函数
    const checkMaskModes = async () => {
        try {
            const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
            setIsInLayerMask(layerInfo?.isInLayerMask || false);
            setIsInQuickMask(layerInfo?.isInQuickMask || false);
            setIsInSingleColorChannel(layerInfo?.isInSingleColorChannel || false);
        } catch (error) {
            console.error('检测蒙版模式失败:', error);
            setIsInLayerMask(false);
            setIsInQuickMask(false);
            setIsInSingleColorChannel(false);
        }
    };

    // 面板打开时检测一次，包含isClearMode检查
    useEffect(() => {
        if (isOpen) {
            checkMaskModes();
        }
    }, [isOpen, isClearMode]);

    // 监听主题/背景色变化，刷新PNG灰度预览的背景混合
    useEffect(() => {
        if (!isOpen) return;

        const readBgColor = (): string => {
            try {
                // 优先从预览容器获取背景色
                const el = previewWrapperRef.current || (document.querySelector('.preview-wrapper') as HTMLElement) || (document.querySelector('.pattern-container') as HTMLElement);
                if (el) {
                    const c = getComputedStyle(el).backgroundColor;
                    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c.trim();
                }
                
                // 从 CSS 变量获取背景色，优先使用 --dark-bg-color
                const rootStyles = getComputedStyle(document.documentElement);
                let varColor = rootStyles.getPropertyValue('--dark-bg-color').trim();
                if (!varColor) {
                    varColor = rootStyles.getPropertyValue('--bg-color').trim();
                }
                
                // 如果还是没有，则检查当前主题
                if (!varColor) {
                    // 检测当前主题并返回对应的默认颜色
                    if (window.matchMedia?.('(prefers-color-scheme: lightest)').matches) {
                        varColor = 'rgb(220, 220, 220)';
                    } else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
                        varColor = 'rgb(164, 164, 164)';
                    } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
                        varColor = 'rgb(63, 63, 63)';
                    } else {
                        varColor = 'rgb(30, 30, 30)'; // darkest 默认
                    }
                }
                
                return varColor || 'rgb(30, 30, 30)';
            } catch (e) {
                console.warn('读取背景色失败:', e);
                return 'rgb(30, 30, 30)';
            }
        };

        const regenerateIfChanged = () => {
            const newColor = readBgColor();
            if (newColor && newColor !== currentBgColor) {
                console.log('检测到背景色变化:', currentBgColor, '->', newColor);
                setCurrentBgColor(newColor);
                setGrayPreviewUrls({});
                const shouldShowGray = isClearMode || isInLayerMask || isInQuickMask || isInSingleColorChannel;
                if (shouldShowGray) {
                    patterns.forEach(p => {
                        if (p.grayData) {
                            generateGrayPreviewUrl(p)
                                .then(url => setGrayPreviewUrls(prev => ({ ...prev, [p.id]: url })))
                                .catch(err => console.error('主题变化后生成灰度预览失败:', err));
                        }
                    });
                }
            }
        };

        // 初始检测
        regenerateIfChanged();

        // 创建媒体查询监听器
        const mqs = [
            window.matchMedia?.('(prefers-color-scheme: darkest)'),
            window.matchMedia?.('(prefers-color-scheme: dark)'),
            window.matchMedia?.('(prefers-color-scheme: light)'),
            window.matchMedia?.('(prefers-color-scheme: lightest)')
        ].filter(Boolean) as MediaQueryList[];

        // 立即检测的事件处理器 - 更快响应
        const onChangeImmediate = () => {
            regenerateIfChanged();
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => regenerateIfChanged());
            }
            setTimeout(regenerateIfChanged, 50);
            setTimeout(regenerateIfChanged, 150);
            setTimeout(regenerateIfChanged, 300);
        };

        // 为每个媒体查询添加监听器
        mqs.forEach(mq => {
            mq.addEventListener?.('change', onChangeImmediate);
        });
        
        // 监听窗口事件
        window.addEventListener('focus', onChangeImmediate);
        window.addEventListener('resize', onChangeImmediate);
        document.addEventListener?.('visibilitychange', onChangeImmediate);

        // 使用 MutationObserver 监听 :root 样式变化（更精确的主题变化检测）
        let styleObserver: MutationObserver | null = null;
        try {
            styleObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                        regenerateIfChanged(); // 立即响应，不延迟
                    }
                });
            });
            
            // 监听 document.documentElement 的 style/class 属性变化
            styleObserver.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['style', 'class']
            });
        } catch (e) {
            console.log('MutationObserver 不可用，使用备用轮询机制');
        }

        // 备用轮询机制：保持1秒频率以确保响应及时
        const pollingInterval = setInterval(() => {
            regenerateIfChanged();
        }, 1000);

        return () => {
            mqs.forEach(mq => mq.removeEventListener?.('change', onChangeImmediate));
            window.removeEventListener('focus', onChangeImmediate);
            window.removeEventListener('resize', onChangeImmediate);
            document.removeEventListener?.('visibilitychange', onChangeImmediate);
            if (styleObserver) {
                styleObserver.disconnect();
            }
            clearInterval(pollingInterval);
        };
    }, [isOpen, isClearMode, isInLayerMask, isInQuickMask, isInSingleColorChannel, patterns.length]);

    // 图案数组变化时检测状态并生成灰度预览
    useEffect(() => {
        const handlePatternsChange = async () => {
            if (patterns.length === 0) return;
            
            console.log('图案数组变化，开始检测状态...');
            
            // 先检测当前编辑状态
            await checkMaskModes();
            
            // 延迟一点确保状态更新完成
            setTimeout(async () => {
                // 重新获取最新的状态
                try {
                    const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                    const currentIsInLayerMask = layerInfo?.isInLayerMask || false;
                    const currentIsInQuickMask = layerInfo?.isInQuickMask || false;
                    const currentIsInSingleColorChannel = layerInfo?.isInSingleColorChannel || false;
                    
                    const shouldShowGray = isClearMode || currentIsInLayerMask || currentIsInQuickMask || currentIsInSingleColorChannel;
                    
                    console.log('图案变化后状态检测结果:', {
                        isClearMode,
                        currentIsInLayerMask,
                        currentIsInQuickMask,
                        currentIsInSingleColorChannel,
                        shouldShowGray,
                        patternsCount: patterns.length
                    });
                    
                    if (shouldShowGray) {
                        patterns.forEach(pattern => {
                            if (pattern.grayData && !grayPreviewUrls[pattern.id]) {
                                console.log('为图案生成灰度预览:', pattern.name);
                                generateGrayPreviewUrl(pattern).then(grayUrl => {
                                    setGrayPreviewUrls(prev => ({
                                        ...prev,
                                        [pattern.id]: grayUrl
                                    }));
                                    console.log('灰度预览生成完成:', pattern.name);
                                }).catch(error => {
                                    console.error('生成灰度预览失败:', pattern.name, error);
                                });
                            }
                        });
                    }
                } catch (error) {
                    console.error('重新检测状态失败:', error);
                }
            }, 100); // 100ms延迟确保状态同步
        };
        
        handlePatternsChange();
    }, [patterns, isClearMode]);

    // 当蒙版模式状态变化时，重新检测并生成灰度预览
    useEffect(() => {
        const handleMaskModeChange = async () => {
            // 清理现有的灰度预览缓存
            setGrayPreviewUrls({});
            
            // 重新检测当前状态（确保状态是最新的）
            await checkMaskModes();
            
            // 根据最新状态判断是否需要生成灰度预览
            const shouldShowGray = isClearMode || isInLayerMask || isInQuickMask || isInSingleColorChannel;
            console.log('蒙版模式变化检测:', {
                isClearMode,
                isInLayerMask,
                isInQuickMask,
                isInSingleColorChannel,
                shouldShowGray,
                patternsCount: patterns.length
            });
            
            if (shouldShowGray && patterns.length > 0) {
                patterns.forEach(pattern => {
                    if (pattern.grayData) { // 确保有灰度数据才生成预览
                        generateGrayPreviewUrl(pattern).then(grayUrl => {
                            setGrayPreviewUrls(prev => ({
                                ...prev,
                                [pattern.id]: grayUrl
                            }));
                            console.log('已生成灰度预览:', pattern.name);
                        }).catch(error => {
                            console.error('生成灰度预览失败:', pattern.name, error);
                        });
                    } else {
                        console.warn('图案缺少灰度数据，跳过预览生成:', pattern.name);
                    }
                });
            }
        };
        
        handleMaskModeChange();
    }, [isClearMode, isInLayerMask, isInQuickMask, isInSingleColorChannel, patterns]);

    // 当图案有了灰度数据后，立即检测状态并生成预览（针对异步加载的情况）
    useEffect(() => {
        const handleGrayDataReady = async () => {
            // 再次检测当前状态
            await checkMaskModes();
            
            const shouldShowGray = isClearMode || isInLayerMask || isInQuickMask || isInSingleColorChannel;
            console.log('灰度数据就绪检测:', {
                shouldShowGray,
                patternsWithGrayData: patterns.filter(p => p.grayData).length,
                totalPatterns: patterns.length
            });
            
            if (shouldShowGray) {
                patterns.forEach(pattern => {
                    // 只处理有灰度数据但还没有灰度预览的图案
                    if (pattern.grayData && !grayPreviewUrls[pattern.id]) {
                        generateGrayPreviewUrl(pattern).then(grayUrl => {
                            setGrayPreviewUrls(prev => ({
                                ...prev,
                                [pattern.id]: grayUrl
                            }));
                            console.log('灰度数据就绪后生成预览:', pattern.name);
                        }).catch(error => {
                            console.error('灰度数据就绪后生成预览失败:', pattern.name, error);
                        });
                    }
                });
            }
        };
        
        // 检查是否有新加载的图案具有灰度数据
        const patternsWithGrayData = patterns.filter(p => p.grayData);
        if (patternsWithGrayData.length > 0) {
            handleGrayDataReady();
        }
    }, [patterns.map(p => p.id + ':' + (p.grayData ? 'gray' : 'no-gray')).join(','), isClearMode, isInLayerMask, isInQuickMask, isInSingleColorChannel, grayPreviewUrls]);

    // 监听通道切换和快速蒙版切换事件
    useEffect(() => {
        if (!isOpen) return;
        
        const checkMaskModes = async () => {
            try {
                const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                setIsInLayerMask(layerInfo?.isInLayerMask || false);
                setIsInQuickMask(layerInfo?.isInQuickMask || false);
                setIsInSingleColorChannel(layerInfo?.isInSingleColorChannel || false);
            } catch (error) {   
                console.error('检测蒙版模式失败:', error);
                setIsInLayerMask(false);
                setIsInQuickMask(false);
                setIsInSingleColorChannel(false);
            }
        };

        // 监听Photoshop事件来检查状态变化
        const handleNotification = async () => {
            try {
                // 检测图层蒙版和快速蒙版状态，包含isClearMode变化
                await checkMaskModes();
            } catch (error) {
                // 静默处理错误，避免频繁的错误日志
            }
        };

        // 添加事件监听器
        action.addNotificationListener(['set', 'select', 'clearEvent', 'delete', 'make'], handleNotification);

        // 清理函数
        return () => {
            action.removeNotificationListener(['set', 'select', 'clearEvent', 'delete', 'make'], handleNotification);
        };
    }, [isOpen]);

    //-------------------------------------------------------------------------------------------------
    // 新增从系统中载入待填充图案的方法
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
                file: file,
                originalFormat: fileExtension // 保存原始扩展名
            };
  
            return pattern;
        } catch (error) {
            console.error('处理文件失败:', file.name, error);
            return null;
        }
    };

    // 使用辅助函数获取Base64信息
    const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    };
    
    // 新增选中文件的逻辑
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

    // 辅助函数：为加载的图案生成唯一ID
    const generateUniqueId = () => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    };

    // 将外部的图案转化为PS内部图案
    const createPatternFromImage = async () => {
        // 获取选中的图案
        let selectedPatternData = patterns.find(p => p.id === selectedPattern);
        if (!selectedPatternData) return;
        
        // 检查是否已经有缓存的图案数据，避免重复处理
        if (selectedPatternData.patternRgbData && selectedPatternData.grayData && 
            selectedPatternData.width && selectedPatternData.height) {
            return `Pattern_${selectedPatternData.id}`;
        }
        
        // 生成唯一的文档名称
        const docName = `Pattern_${Date.now()}`;
        const patternName = `Pattern_${Date.now()}`;
        
        // 获取图片元素以读取实际尺寸
        const imgElement = document.querySelector('.pattern-final-preview') as HTMLImageElement;
        if (!imgElement || !imgElement.complete) {
            console.error('❌ 图片元素未找到或未完全加载');
            return;
        }
        
        // 验证图片尺寸
        if (!imgElement.naturalWidth || !imgElement.naturalHeight || 
            imgElement.naturalWidth <= 0 || imgElement.naturalHeight <= 0) {
            console.error('❌ 图片尺寸无效:', {
                naturalWidth: imgElement.naturalWidth,
                naturalHeight: imgElement.naturalHeight
            });
            return;
        }
        
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
                // 为了减少界面闪烁，使用较小的临时文档尺寸，后续会调整
                const tempWidth = Math.min(imgElement.naturalWidth, 512);
                const tempHeight = Math.min(imgElement.naturalHeight, 512);
                
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
                                    _value: tempWidth
                                },
                                height: {
                                    _unit: "pixelsUnit",
                                    _value: tempHeight
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
                            width: {
                                _unit: "pixelsUnit",
                                _value: imgElement.naturalWidth
                            },
                            height: {
                                _unit: "pixelsUnit",
                                _value: imgElement.naturalHeight
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

                    // 根据文件类型决定是否应用alpha通道
                    const fileName = selectedPatternData.file.name.toLowerCase();
                    const isJpg = fileName.endsWith('.jpg') || fileName.endsWith('.jpeg');

                    // 按照官方API格式获取文档的像素数据
                    let options = {
                        "documentID": activeDoc.id,
                        "targetSize": {
                            "height": imgElement.naturalHeight,
                            "width": imgElement.naturalWidth
                        },
                        "componentSize": 8,
                        "applyAlpha": false, // 设置为false以保留alpha通道，获取真正的RGBA数据
                        "colorProfile": "sRGB IEC61966-2.1",
                        "bounds": {
                            "left": 0,
                            "top": 0,
                            "right": imgElement.naturalWidth,
                            "bottom": imgElement.naturalHeight
                        }
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

                        // 更新图案数据，包含组件信息
                        selectedPatternData.patternRgbData = rgbData;
                        selectedPatternData.width = pixelData.imageData.width;
                        selectedPatternData.height = pixelData.imageData.height;
                        selectedPatternData.components = pixelData.imageData.components; // 保存组件数
                        selectedPatternData.hasAlpha = pixelData.imageData.components === 4; // 标记是否有透明度
                        
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
                    // 在catch块中重置pixelData为null，确保后续逻辑正确处理
                    pixelData = null;
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
                
                // 确保components变量始终有定义
                const components = pixelData?.imageData?.components || 3;
                
                // 确保rgbData不为null
                if (!rgbData) {
                    rgbData = new Uint8Array(defaultWidth * defaultHeight * components).fill(128);
                    console.warn('rgbData为空，使用默认数据');
                }
                
                const originalGrayData = convertToGrayData(
                    rgbData!, 
                    pixelData.imageData.width, 
                    pixelData.imageData.height,
                    components
                );
                
                
                // 直接使用原始灰度数据，变换处理由ClearHandler负责
                patternGrayData = originalGrayData;
                patternWidth = pixelData.imageData.width;
                patternHeight = pixelData.imageData.height;
                
                // 保存原始灰度数据用于后续变换
                selectedPatternData.originalGrayData = originalGrayData;
                
                
                // 在释放前捕获原始尺寸，避免后续访问已释放的 imageData 导致错误
                const capturedOriginalWidth = (pixelData && pixelData.imageData && typeof pixelData.imageData.width === 'number') ? pixelData.imageData.width : imgElement.naturalWidth;
                const capturedOriginalHeight = (pixelData && pixelData.imageData && typeof pixelData.imageData.height === 'number') ? pixelData.imageData.height : imgElement.naturalHeight;
                
                // 释放图像数据以避免内存泄漏
                if (pixelData && pixelData.imageData && pixelData.imageData.dispose) {
                    pixelData.imageData.dispose();
                }
                
                // 关闭临时文档（快速且静默）
                await action.batchPlay(
                    [
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
                
                // 修正 colorSpace 的值
                let finalColorSpace = "RGB"; // 默认为RGB
                if (components === 1) {
                    finalColorSpace = "gray";
                }

                setPatterns(prevPatterns => {
                    const updatedPatterns = prevPatterns.map(p => {
                        if (p.id === selectedPattern) {
                            const updatedPattern = {
                                ...p,
                                patternRgbData: rgbData,
                                patternComponents: components,
                                components: components, // 同时设置components字段以确保兼容性
                                hasAlpha: components === 4, // 正确设置透明度标记
                                grayData: patternGrayData,
                                originalGrayData: selectedPatternData.originalGrayData,
                                width: patternWidth,
                                height: patternHeight,
                                originalWidth: capturedOriginalWidth,
                                originalHeight: capturedOriginalHeight,
                                currentScale: scale,
                                currentAngle: angle,
                                colorSpace: finalColorSpace // 使用修正后的 colorSpace
                            };
                            
                            return updatedPattern;
                        }
                        return p;
                    });
                    
                    return updatedPatterns;
                });
                
            }, { commandName: '载入图案' });
            
            return patternName;
        } catch (error) {
            console.error('创建图案失败:', error);
            return null;
        }
    };

    // 将图案的RGB/RGBA数据转换为灰度数据，支持透明度
    const convertToGrayData = (pixelData: Uint8Array, width: number, height: number, components: number): Uint8Array => {
        const grayData = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            const r = pixelData[i * components];
            const g = pixelData[i * components + 1];
            const b = pixelData[i * components + 2];
            
        // 使用标准的RGB到灰度转换公式，不在此处处理透明度
            // 透明度信息将在PatternFill的最终混合阶段处理
            const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            
            grayData[i] = gray;
        }
        return grayData;
    };

    // 生成灰度预览URL
    const generateGrayPreviewUrl = async (pattern: Pattern): Promise<string> => {
        if (!pattern.grayData || !pattern.width || !pattern.height) {
            return pattern.preview; // 如果没有灰度数据，返回原始预览
        }

        console.log('生成灰度预览 - 文件格式:', pattern.originalFormat, '通道数:', pattern.components, '文件名:', pattern.file?.name, 'hasAlpha:', pattern.hasAlpha);

        // 处理JPG无Alpha的情况 - 明确检查文件格式
        const isJpegFormat = pattern.originalFormat === 'jpg' || pattern.originalFormat === 'jpeg' || 
                            (pattern.file?.name && (pattern.file.name.toLowerCase().endsWith('.jpg') || pattern.file.name.toLowerCase().endsWith('.jpeg')));
        
        if (isJpegFormat) {
            try {
                // 创建JPG的灰色版本预览的数据数组
                const grayDataArray = new Uint8Array(pattern.width * pattern.height * 3);

                // 将单通道灰度数据转换为RGBA格式
                for (let i = 0; i < pattern.width * pattern.height; i++) {
                    const gray = pattern.grayData[i];
                    
                    // 设置灰度值到RGB通道
                    grayDataArray[i * 3] = gray;     // R
                    grayDataArray[i * 3 + 1] = gray; // G
                    grayDataArray[i * 3 + 2] = gray; // B
                }

                // 使用Photoshop的imaging API创建图像数据
                const options = {
                    width: pattern.width,
                    height: pattern.height,
                    chunky: true,
                    colorProfile: "sRGB IEC61966-2.1",
                    colorSpace: "RGB",
                    components: 3,
                    componentSize: 8
                };
                
                const imageData = await imaging.createImageDataFromBuffer(grayDataArray, options);

                // 将图像数据编码为JPEG格式的base64
                const jpegData = await imaging.encodeImageData({"imageData": imageData, "base64": true, "format": "jpeg"});
                
                // 释放图像数据
                imageData.dispose();
                
                return `data:image/jpeg;base64,${jpegData}`;
            } catch (error) {
                console.error('JPG生成灰度预览失败:', error);
                return pattern.preview;
            }
        } else if (pattern.originalFormat === 'png') {

            try {
                // 获取当前主题的背景色（从实际的预览容器元素获取）
                const getBackgroundColor = () => {
                    try {
                        // 查找预览容器元素
                        const previewWrapper = (previewWrapperRef.current as HTMLElement) || (document.querySelector('.preview-wrapper') as HTMLElement);
                        const patternContainer = document.querySelector('.pattern-container') as HTMLElement;
                        
                        // 优先从预览容器获取背景色
                        let targetElement = previewWrapper || patternContainer;
                        
                        if (targetElement) {
                            const computedStyle = getComputedStyle(targetElement);
                            const bgColor = computedStyle.backgroundColor;
                            console.log('从预览容器获取背景色:', bgColor);
                            
                            // 解析RGB颜色值
                            if (bgColor && bgColor.startsWith('rgb(')) {
                                const rgbValues = bgColor.match(/\d+/g);
                                if (rgbValues && rgbValues.length >= 3) {
                                    return {
                                        r: parseInt(rgbValues[0], 10),
                                        g: parseInt(rgbValues[1], 10),
                                        b: parseInt(rgbValues[2], 10)
                                    };
                                }
                            }
                        }
                        
                        // 备用方案：从CSS变量获取
                        const rootStyles = getComputedStyle(document.documentElement);
                        
                        // 尝试多个CSS变量，包括UXP host变量
                        const varNames = [
                            '--dark-bg-color',
                            '--bg-color', 
                            '--uxp-host-background-color'
                        ];
                        
                        let cssVarColor = '';
                        for (const varName of varNames) {
                            cssVarColor = rootStyles.getPropertyValue(varName).trim();
                            if (cssVarColor) break;
                        }
                        
                        if (cssVarColor && cssVarColor.startsWith('rgb(')) {
                            const rgbValues = cssVarColor.match(/\d+/g);
                            if (rgbValues && rgbValues.length >= 3) {
                                console.log('从CSS变量获取背景色:', cssVarColor);
                                return {
                                    r: parseInt(rgbValues[0], 10),
                                    g: parseInt(rgbValues[1], 10),
                                    b: parseInt(rgbValues[2], 10)
                                };
                            }
                        }
                        
                        // 处理十六进制颜色
                        if (cssVarColor && cssVarColor.startsWith('#')) {
                            const hex = cssVarColor.substring(1);
                            if (hex.length === 6) {
                                const r = parseInt(hex.substring(0, 2), 16);
                                const g = parseInt(hex.substring(2, 4), 16);
                                const b = parseInt(hex.substring(4, 6), 16);
                                console.log('从CSS变量获取背景色(hex):', cssVarColor);
                                return { r, g, b };
                            }
                        }
                        
                        // 根据当前主题返回对应的默认颜色
                        if (window.matchMedia?.('(prefers-color-scheme: lightest)').matches) {
                            console.log('使用lightest主题默认背景色');
                            return { r: 220, g: 220, b: 220 };
                        } else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
                            console.log('使用light主题默认背景色');
                            return { r: 164, g: 164, b: 164 };
                        } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
                            console.log('使用dark主题默认背景色');
                            return { r: 63, g: 63, b: 63 };
                        } else {
                            console.log('使用darkest主题默认背景色');
                            return { r: 30, g: 30, b: 30 };
                        }
                    } catch (error) {
                        console.error('获取背景色时出错:', error);
                        return { r: 30, g: 30, b: 30 };
                    }
                };

                const backgroundColor = getBackgroundColor();
                
                // 创建PNG的灰色版本预览的数据数组（包含alpha通道）
                const grayDataArray = new Uint8Array(pattern.width * pattern.height * 4);
                
                // 处理透明度混合
                for (let i = 0; i < pattern.width * pattern.height; i++) {
                    let finalGray;
                    let alpha = 255; // 默认完全不透明
                    
                    if (pattern.hasAlpha && pattern.patternRgbData && pattern.patternComponents === 4) {
                        // 从RGBA数据中获取RGB和alpha值
                        const r = pattern.patternRgbData[i * 4];
                        const g = pattern.patternRgbData[i * 4 + 1];
                        const b = pattern.patternRgbData[i * 4 + 2];
                        alpha = pattern.patternRgbData[i * 4 + 3]; // 保持原始alpha值
                        
                        // 先将RGB混合背景色，再转换为灰度
                        if (alpha === 0) {
                            // 完全透明区域：使用背景色的灰度
                            finalGray = Math.round(0.299 * backgroundColor.r + 0.587 * backgroundColor.g + 0.114 * backgroundColor.b);
                        } else if (alpha === 255) {
                            // 完全不透明区域：直接从RGB转灰度
                            finalGray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                        } else {
                            // 半透明区域：先混合RGB和背景色，再转灰度
                            const alphaRatio = alpha / 255;
                            const blendedR = Math.round(r * alphaRatio + backgroundColor.r * (1 - alphaRatio));
                            const blendedG = Math.round(g * alphaRatio + backgroundColor.g * (1 - alphaRatio));
                            const blendedB = Math.round(b * alphaRatio + backgroundColor.b * (1 - alphaRatio));
                            finalGray = Math.round(0.299 * blendedR + 0.587 * blendedG + 0.114 * blendedB);
                        }
                    } else {
                        // 没有透明度信息，直接使用灰度值
                        finalGray = pattern.grayData[i];
                    }
                    
                    // 保存RGBA格式的灰度数据，保持原始透明度
                    grayDataArray[i * 4] = finalGray;     // R
                    grayDataArray[i * 4 + 1] = finalGray; // G
                    grayDataArray[i * 4 + 2] = finalGray; // B
                    grayDataArray[i * 4 + 3] = alpha;     // A
                }

                // 使用Photoshop的imaging API创建图像数据
                // 注意：encodeImageData仅支持JPEG；为了避免透明边被错误处理，我们在上面已将灰度数据与背景合成，并保留A通道
                // 这里构建RGB缓冲区（丢弃A）用于编码
                const rgbBuffer = new Uint8Array(pattern.width * pattern.height * 3);
                for (let i = 0; i < pattern.width * pattern.height; i++) {
                    rgbBuffer[i * 3] = grayDataArray[i * 4];
                    rgbBuffer[i * 3 + 1] = grayDataArray[i * 4 + 1];
                    rgbBuffer[i * 3 + 2] = grayDataArray[i * 4 + 2];
                }

                const options = {
                    width: pattern.width,
                    height: pattern.height,
                    pixelFormat: "RGB",
                    isChunky: true,
                    colorProfile: "sRGB IEC61966-2.1",
                    colorSpace: "RGB",
                    components: 3,
                    componentSize: 8
                };

                const imageData = await imaging.createImageDataFromBuffer(rgbBuffer, options);

                // 将图像数据编码为JPEG格式的base64
                const jpegData = await imaging.encodeImageData({"imageData": imageData, "base64": true, "format": "jpeg"});
                
                // 释放图像数据
                imageData.dispose();
                
                const jpegDataUrl = `data:image/jpeg;base64,${jpegData}`;

                return jpegDataUrl;

            } catch (error) {
                console.error('PNG生成灰度预览失败:', error);
                return pattern.preview;
            }
        }
    };

    // 获取预览URL（根据状态返回彩色或灰度）
    const getPreviewUrl = (pattern: Pattern): string => {
        const shouldShowGray = isClearMode || isInLayerMask || isInQuickMask || isInSingleColorChannel;
        
        if (!shouldShowGray) {
            return pattern.preview;
        }

        // 检查是否已有缓存的灰度预览
        if (grayPreviewUrls[pattern.id]) {
            return grayPreviewUrls[pattern.id];
        }

        // 异步生成并缓存灰度预览
        generateGrayPreviewUrl(pattern).then(grayUrl => {
            setGrayPreviewUrls(prev => ({
                ...prev,
                [pattern.id]: grayUrl
            }));
        }).catch(error => {
            console.error('生成灰度预览失败:', error);
        });

        // 在灰度预览生成期间返回原始预览
        return pattern.preview;
    };
    
    // 删除图案的逻辑
    const handleDelete = async () => {
        if (selectedPatterns.size > 0) {
            // 删除多选的图案
            const newPatterns = patterns.filter(p => !selectedPatterns.has(p.id));
            setPatterns(newPatterns);
            setSelectedPatterns(new Set());
            setLastClickedPattern(null);
            
            // 如果删除后列表为空，则清空选择并通知父组件
            if (newPatterns.length === 0) {
                setSelectedPattern(null);
                onSelect(null);
            }
            
            // 删除图案后检测当前编辑内容状态
            await checkMaskModes();
            console.log('多个图案删除成功');
        } else if (selectedPattern) {
            const currentIndex = patterns.findIndex(p => p.id === selectedPattern);
            if (currentIndex === -1) return; // Should not happen

            // 从状态中删除图案
            const newPatterns = patterns.filter(p => p.id !== selectedPattern);
            setPatterns(newPatterns);

            // 如果删除后列表为空，则清空选择并通知父组件
            if (newPatterns.length === 0) {
                setSelectedPattern(null);
                onSelect(null);
            } else {
                // 确定新的选中项
                // 如果删除的不是第一项，则选中前一项
                // 如果删除的是第一项，则选中新的第一项
                const newIndex = currentIndex > 0 ? currentIndex - 1 : 0;
                setSelectedPattern(newPatterns[newIndex].id);
            }
            
            // 删除图案后检测当前编辑内容状态
            await checkMaskModes();
            console.log('图案删除成功');
        }
    };

    //-------------------------------------------------------------------------------------------------
    // 更新图案的变形（不进行实际变换，由ClearHandler处理）
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
    };
    
    // 图案选择处理函数
    const handlePatternSelect = (patternId: string, event?: React.MouseEvent) => {
        if (event && (event.ctrlKey || event.metaKey)) {
            // Ctrl+点击（Windows）或Cmd+点击（Mac）：切换选中状态
            
            // 如果当前是单选状态且点击的是已选中的项目，则取消选中
            if (selectedPattern === patternId && selectedPatterns.size === 0) {
                setSelectedPattern(null);
                setLastClickedPattern(null);
                onSelect(null);
                return;
            }
            
            const newSelectedPatterns = new Set(selectedPatterns);
            
            // 如果当前是单选状态，先将单选项加入多选集合
            if (selectedPattern !== null && selectedPatterns.size === 0) {
                newSelectedPatterns.add(selectedPattern);
            }
            
            if (newSelectedPatterns.has(patternId)) {
                newSelectedPatterns.delete(patternId);
            } else {
                newSelectedPatterns.add(patternId);
            }
            
            setSelectedPatterns(newSelectedPatterns);
            setLastClickedPattern(patternId);
            
            // 如果多选集合为空，清空所有选中状态
            if (newSelectedPatterns.size === 0) {
                setSelectedPattern(null);
                onSelect(null);
            } else if (newSelectedPatterns.size === 1) {
                // 如果只剩一个，转为单选状态
                const remainingPatternId = Array.from(newSelectedPatterns)[0];
                setSelectedPattern(remainingPatternId);
                setSelectedPatterns(new Set());
            } else {
                // 多选时清空单选状态
                setSelectedPattern(null);
            }
        } else if (event && event.shiftKey && lastClickedPattern !== null) {
            // Shift+点击：范围选择
            const newSelectedPatterns = new Set(selectedPatterns);
            
            // 如果当前是单选状态，先将单选项加入多选集合
            if (selectedPattern !== null && selectedPatterns.size === 0) {
                newSelectedPatterns.add(selectedPattern);
            }
            
            const patternIds = patterns.map(p => p.id);
            const startIndex = patternIds.indexOf(lastClickedPattern);
            const endIndex = patternIds.indexOf(patternId);
            
            if (startIndex !== -1 && endIndex !== -1) {
                const start = Math.min(startIndex, endIndex);
                const end = Math.max(startIndex, endIndex);
                for (let i = start; i <= end; i++) {
                    newSelectedPatterns.add(patternIds[i]);
                }
            }
            
            setSelectedPatterns(newSelectedPatterns);
            setLastClickedPattern(patternId);
            
            // 如果范围选择只有一个项目，按单选处理
            if (newSelectedPatterns.size === 1) {
                setSelectedPattern(patternId);
                setSelectedPatterns(new Set());
            } else {
                // 多选时清空单选状态
                setSelectedPattern(null);
            }
        } else {
            // 单选模式
            setSelectedPattern(patternId);
            setSelectedPatterns(new Set());
            setLastClickedPattern(patternId);
        }
    };


    // 处理点击空白区域取消选中
    const handleContainerClick = (event: React.MouseEvent) => {
        // 检查点击的是否是预设区域的空白部分
        if (event.target === event.currentTarget) {
            setSelectedPattern(null);
            setSelectedPatterns(new Set());
            setLastClickedPattern(null);
            onSelect(null);
        }
    };

    // 更新图案的角度滑块的变化
    const handleAngleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newAngle = Number(e.target.value);
        setAngle(newAngle);
        
        // 拖拽时跳过 updatePatternTransform，避免额外调用
        if (selectedPattern && !isSliderDragging) {
            updatePatternTransform(selectedPattern, scale, newAngle);
        }
    };
    
    // 更新图案的缩放滑块的变化
    const handleScaleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newScale = Number(e.target.value);
        setScale(newScale);
        
        // 拖拽时跳过 updatePatternTransform，避免额外调用
        if (selectedPattern && !isSliderDragging) {
            updatePatternTransform(selectedPattern, newScale, angle);
        }
    };
    
    //-------------------------------------------------------------------------------------------------
    // 监听 patterns 加载情况，输出图案的具体信息。
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

    //-------------------------------------------------------------------------------------------------
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

    if (!isOpen) return null;

    return (
        <div className="pattern-picker">
            <div className="panel-header">
                <h3>选择图案</h3>
                <button className="close-button" onClick={() => {
                    onClose();
                }}>×</button>
            </div>
            <div className="pattern-container">
                 <div className="pattern-preset" onClick={handleContainerClick}>
                    {patterns.map(pattern => (
                        <div
                            key={pattern.id}
                            className={`photo-container ${selectedPattern === pattern.id ? 'selected' : ''} ${selectedPatterns.has(pattern.id) ? 'multi-selected' : ''}`}
                            onClick={(e) => handlePatternSelect(pattern.id, e)}
                        >
                            <img 
                                src={getPreviewUrl(pattern)} 
                                alt={pattern.name}
                                onLoad={async (e) => {
                                    const img = e.currentTarget;
                                    console.log(`图片加载成功 - ${pattern.name}:`, {
                                        naturalSize: `${img.naturalWidth}x${img.naturalHeight}`,
                                        displaySize: `${img.offsetWidth}x${img.offsetHeight}`,
                                        complete: img.complete
                                    });
                                    
                                    setLoadedImages(prev => ({...prev, [pattern.id]: true}));
                                    
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
                                        if (selectedPatterns.size > 0 || selectedPattern) {
                                            handleDelete();
                                        }
                                    }}
                                    disabled={!selectedPattern && selectedPatterns.size === 0}
                                    style={{
                                        cursor: (!selectedPattern && selectedPatterns.size === 0) ? 'not-allowed' : 'pointer',
                                        opacity: (!selectedPattern && selectedPatterns.size === 0) ? 0.4 : 1,
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
                        <label onMouseDown={(e) => handleMouseDown(e, 'angle')} style={{ cursor: isSliderDragging && dragTarget === 'angle' ? 'ew-resize' : 'ew-resize' }}>角度：
                            <div>
                            <input
                                type="number"
                                min="0"
                                max="360"
                                value={angle}
                                onChange={handleAngleChange}
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
                            onChange={(e) => setAngle(Number(e.target.value))}
                            onMouseDown={() => { setIsSliderDragging(true); setDragTarget('angle'); }}
                            onMouseUp={() => { setIsSliderDragging(false); setDragTarget(null); }}
                            onMouseLeave={() => { if (isSliderDragging && dragTarget === 'angle') { setIsSliderDragging(false); setDragTarget(null); } }}
                        />
                    </div>

                    <div className="pattern-setting-item">
                        <label onMouseDown={(e) => handleMouseDown(e, 'scale')} style={{ cursor: isSliderDragging && dragTarget === 'scale' ? 'ew-resize' : 'ew-resize' }}>缩放：
                            <div>
                                <input
                                    type="number"
                                    min="20"
                                    max="300"
                                    value={scale}
                                    onChange={handleScaleChange}
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
                            onChange={(e) => setScale(Number(e.target.value))}
                            onMouseDown={() => { setIsSliderDragging(true); setDragTarget('scale'); }}
                            onMouseUp={() => { setIsSliderDragging(false); setDragTarget(null); }}
                            onMouseLeave={() => { if (isSliderDragging && dragTarget === 'scale') { setIsSliderDragging(false); setDragTarget(null); } }}
                        />
                    </div>
                </div>
               
                <div className="pattern-fillmode-container">
                            <sp-radio-group 
                            selected={fillMode}
                            name="fillMode"
                            onChange={(e) => setFillMode(e.target.value as 'stamp' | 'tile')}
                        >
                            <sp-radio value="stamp" className="pattern-fillmode-radio">
                                <span className="pattern-radio-item-label">单次</span>
                            </sp-radio>
                            <sp-radio value="tile" className="pattern-fillmode-radio">
                                <span className="pattern-radio-item-label">平铺</span>
                            </sp-radio>
                        </sp-radio-group>
                </div>

                <div className="pattern-checkbox-container">
                       <label
                            htmlFor="transparencyCheckbox"
                            className="pattern-checkbox-label"
                            onClick={() => setPreserveTransparency(!preserveTransparency)}
                        >
                            剪贴蒙版：
                       </label>
                       <input
                            type="checkbox"
                            id="transparencyCheckbox"
                            checked={preserveTransparency}
                            onChange={(e) => setPreserveTransparency(e.target.checked)}
                            className="pattern-checkbox-input"
                        />
                        {fillMode === 'tile' && (
                            <>
                                <label
                                    htmlFor="rotateAllCheckbox"
                                    className="pattern-checkbox-label"
                                    style={{marginLeft: '20px'}}
                                    onClick={() => setRotateAll(!rotateAll)}
                                >
                                    旋转阵列：
                                </label>
                                <input
                                    type="checkbox"
                                    id="rotateAllCheckbox"
                                    checked={rotateAll}
                                    onChange={(e) => setRotateAll(e.target.checked)}
                                    className="pattern-checkbox-input"
                                />
                            </>
                        )}
                </div>
                
            </div>
            <div className="pattern-final-preview-container">
                <div className="pattern-subtitle">
                    <h3>预览</h3>
                    {selectedPattern && (
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
                    )}
                </div>
                <div 
                    className="preview-wrapper"
                    ref={previewWrapperRef}
                    onWheel={selectedPattern ? handlePreviewWheel : undefined}
                    onMouseDown={selectedPattern ? handlePreviewMouseDown : undefined}
                    onMouseMove={selectedPattern ? handlePreviewMouseMove : undefined}
                    onMouseUp={selectedPattern ? handlePreviewMouseUp : undefined}
                    style={{
                        cursor: selectedPattern && previewZoom > 100 ? (isPreviewDragging ? 'grabbing' : 'grab') : 'default',
                        overflow: 'hidden',
                        position: 'relative'
                    }}
                >
                    {selectedPattern ? (
                        <>
                            <img
                                className="pattern-final-preview"
                                src={patterns.find(p => p.id === selectedPattern) ? getPreviewUrl(patterns.find(p => p.id === selectedPattern)!) : ''}
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
                        </>
                    ) : (
                        <div style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            color: '#666',
                            fontSize: '12px',
                            zIndex: 3,
                            pointerEvents: 'none'
                        }}>
                            请选择一个图案预设
                        </div>
                    )}
                </div>
            </div>



        </div>
    );
};

export default PatternPicker;
