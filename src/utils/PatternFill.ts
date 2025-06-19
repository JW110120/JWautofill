import { app, action, core, imaging } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Pattern } from '../types/state';

interface PatternFillOptions {
    opacity: number;
    blendMode: string;
    preserveTransparency: boolean;
    pattern: Pattern;
}

// 盖图章模式：图案居中显示，不重复
function createStampPatternData(
    patternData: Uint8Array,
    patternWidth: number,
    patternHeight: number,
    components: number,
    targetWidth: number,
    targetHeight: number,
    scaledPatternWidth: number,
    scaledPatternHeight: number,
    angle: number
): Uint8Array {
    // 初始化为透明（全0），而不是黑色
    const resultData = new Uint8Array(targetWidth * targetHeight * components);
    
    // 如果是RGBA格式，将alpha通道设置为0（透明）
    if (components === 4) {
        for (let i = 3; i < resultData.length; i += 4) {
            resultData[i] = 0; // alpha = 0 (透明)
        }
    }
    
    // 计算图案在目标区域的居中位置
    const offsetX = (targetWidth - scaledPatternWidth) / 2;
    const offsetY = (targetHeight - scaledPatternHeight) / 2;
    
    const angleRad = (angle * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    
    // 旋转中心为目标区域的中心
    const centerX = targetWidth / 2;
    const centerY = targetHeight / 2;
    
    for (let y = 0; y < targetHeight; y++) {
        for (let x = 0; x < targetWidth; x++) {
            const targetIndex = (y * targetWidth + x) * components;
            
            if (angle !== 0) {
                // 计算相对于中心的坐标
                const relativeX = x - centerX;
                const relativeY = y - centerY;
                
                // 反向旋转以获取原始坐标
                const originalX = relativeX * cos + relativeY * sin + centerX;
                const originalY = -relativeX * sin + relativeY * cos + centerY;
                
                // 计算在图案中的位置
                const patternX = originalX - offsetX;
                const patternY = originalY - offsetY;
                
                // 检查是否在图案范围内
                if (patternX >= 0 && patternX < scaledPatternWidth && patternY >= 0 && patternY < scaledPatternHeight) {
                    // 映射到原始图案坐标
                    const sourceX = Math.floor(patternX * patternWidth / scaledPatternWidth);
                    const sourceY = Math.floor(patternY * patternHeight / scaledPatternHeight);
                    
                    if (sourceX >= 0 && sourceX < patternWidth && sourceY >= 0 && sourceY < patternHeight) {
                        const sourceIndex = (sourceY * patternWidth + sourceX) * components;
                        for (let c = 0; c < components; c++) {
                            resultData[targetIndex + c] = patternData[sourceIndex + c];
                        }
                    }
                }
            } else {
                // 无旋转的情况
                const patternX = x - offsetX;
                const patternY = y - offsetY;
                
                if (patternX >= 0 && patternX < scaledPatternWidth && patternY >= 0 && patternY < scaledPatternHeight) {
                    const sourceX = Math.floor(patternX * patternWidth / scaledPatternWidth);
                    const sourceY = Math.floor(patternY * patternHeight / scaledPatternHeight);
                    
                    if (sourceX >= 0 && sourceX < patternWidth && sourceY >= 0 && sourceY < patternHeight) {
                        const sourceIndex = (sourceY * patternWidth + sourceX) * components;
                        for (let c = 0; c < components; c++) {
                            resultData[targetIndex + c] = patternData[sourceIndex + c];
                        }
                    }
                }
            }
        }
    }
    
    return resultData;
}

// 贴墙纸模式：无缝平铺，解决旋转边界问题
function createTilePatternData(
    patternData: Uint8Array,
    patternWidth: number,
    patternHeight: number,
    components: number,
    targetWidth: number,
    targetHeight: number,
    scaledPatternWidth: number,
    scaledPatternHeight: number,
    angle: number,
    rotateAll: boolean = true
): Uint8Array {
    // 为了解决旋转时的边界问题，我们需要创建一个更大的平铺区域
    // 计算旋转后可能需要的最大尺寸
    const diagonal = Math.sqrt(targetWidth * targetWidth + targetHeight * targetHeight);
    const expandedSize = Math.ceil(diagonal * 1.5); // 增加50%的缓冲区
    
    // 创建扩展的平铺数据
    const expandedData = new Uint8Array(expandedSize * expandedSize * components);
    
    // 先在扩展区域进行平铺
    for (let y = 0; y < expandedSize; y++) {
        for (let x = 0; x < expandedSize; x++) {
            const patternX = Math.floor((x % scaledPatternWidth) * patternWidth / scaledPatternWidth);
            const patternY = Math.floor((y % scaledPatternHeight) * patternHeight / scaledPatternHeight);
            
            const sourceX = Math.min(patternX, patternWidth - 1);
            const sourceY = Math.min(patternY, patternHeight - 1);
            
            const sourceIndex = (sourceY * patternWidth + sourceX) * components;
            const targetIndex = (y * expandedSize + x) * components;
            
            for (let c = 0; c < components; c++) {
                expandedData[targetIndex + c] = patternData[sourceIndex + c];
            }
        }
    }
    
    // 创建最终结果数据
    const resultData = new Uint8Array(targetWidth * targetHeight * components);
    
    if (angle !== 0) {
        const angleRad = (angle * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        // 旋转中心为目标区域的中心
        const centerX = targetWidth / 2;
        const centerY = targetHeight / 2;
        const expandedCenterX = expandedSize / 2;
        const expandedCenterY = expandedSize / 2;
        
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                // 相对于目标中心的坐标
                const relativeX = x - centerX;
                const relativeY = y - centerY;
                
                // 反向旋转以获取扩展区域中的坐标
                const expandedX = relativeX * cos + relativeY * sin + expandedCenterX;
                const expandedY = -relativeX * sin + relativeY * cos + expandedCenterY;
                
                const targetIndex = (y * targetWidth + x) * components;
                
                // 使用双线性插值从扩展数据中采样
                if (expandedX >= 0 && expandedX < expandedSize - 1 && expandedY >= 0 && expandedY < expandedSize - 1) {
                    const x1 = Math.floor(expandedX);
                    const y1 = Math.floor(expandedY);
                    const x2 = x1 + 1;
                    const y2 = y1 + 1;
                    
                    const fx = expandedX - x1;
                    const fy = expandedY - y1;
                    
                    for (let c = 0; c < components; c++) {
                        const p1 = expandedData[(y1 * expandedSize + x1) * components + c];
                        const p2 = expandedData[(y1 * expandedSize + x2) * components + c];
                        const p3 = expandedData[(y2 * expandedSize + x1) * components + c];
                        const p4 = expandedData[(y2 * expandedSize + x2) * components + c];
                        
                        const interpolated = p1 * (1 - fx) * (1 - fy) +
                                           p2 * fx * (1 - fy) +
                                           p3 * (1 - fx) * fy +
                                           p4 * fx * fy;
                        
                        resultData[targetIndex + c] = Math.round(interpolated);
                    }
                } else {
                    // 如果超出扩展区域，使用平铺逻辑
                    const wrappedX = ((Math.floor(expandedX) % scaledPatternWidth) + scaledPatternWidth) % scaledPatternWidth;
                    const wrappedY = ((Math.floor(expandedY) % scaledPatternHeight) + scaledPatternHeight) % scaledPatternHeight;
                    
                    const patternX = Math.floor(wrappedX * patternWidth / scaledPatternWidth);
                    const patternY = Math.floor(wrappedY * patternHeight / scaledPatternHeight);
                    
                    const sourceIndex = (patternY * patternWidth + patternX) * components;
                    
                    for (let c = 0; c < components; c++) {
                        resultData[targetIndex + c] = patternData[sourceIndex + c];
                    }
                }
            }
        }
    } else {
        // 无旋转的情况，直接从扩展数据中心区域复制
        const offsetX = (expandedSize - targetWidth) / 2;
        const offsetY = (expandedSize - targetHeight) / 2;
        
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                const sourceX = Math.floor(x + offsetX);
                const sourceY = Math.floor(y + offsetY);
                
                const sourceIndex = (sourceY * expandedSize + sourceX) * components;
                const targetIndex = (y * targetWidth + x) * components;
                
                for (let c = 0; c < components; c++) {
                    resultData[targetIndex + c] = expandedData[sourceIndex + c];
                }
            }
        }
    }
    
    return resultData;
}



interface LayerInfo {
    hasPixels: boolean;
    isInQuickMask: boolean;
}

export class PatternFill {
    static async fillPattern(options: PatternFillOptions, layerInfo: LayerInfo) {
        // 检查是否有图案数据
        if (!options.pattern.patternRgbData || !options.pattern.patternComponents) {
            console.error("❌ 没有可用的图案数据，无法填充");
            return;
        }

        // 如果在快速蒙版状态，使用简化的直接填充
        if (layerInfo.isInQuickMask) {
            await this.fillPatternDirect(options);
            return;
        }

        // 获取选区边界
        const bounds = app.activeDocument.selection.bounds;
        
        if (!bounds) {
            console.error("❌ 无法获取选区边界数据");
            return;
        }

        // 第一步：创建空白图层
        const createBlankLayer = {
            _obj: "make",
            _target: [{
                _ref: "layer"
            }],
            _options: {
                dialogOptions: "dontDisplay"
            }
        };
        
        // 设置图层名称为临时图层
        const setLayerName = {
            _obj: "set",
            _target: [{
                _ref: "layer",
                _enum: "ordinal",
                _value: "targetEnum"
            }],
            to: {
                _obj: "layer",
                name: "临时图层"
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        // 第一步半：创建图层蒙版
        const createLayerMask = {
            _obj: "make",
            new: {
               _class: "channel"
            },
            at: {
               _ref: "channel",
               _enum: "channel",
               _value: "mask"
            },
            using: {
               _enum: "userMaskEnabled",
               _value: "revealSelection"
            },
            _options: {
               dialogOptions: "dontDisplay"
            }
        };
   

        // 第二步：使用putPixels填充图案数据到选区边界内
        const fillPatternData = async () => {
            
            // 安全地获取图案尺寸，参考ClearHandler的逻辑
            let patternWidth: number;
            let patternHeight: number;
            
            try {
                // 优先使用width和height，这些是PatternPicker中设置的当前尺寸
                patternWidth = options.pattern.width || options.pattern.originalWidth || 100;
                patternHeight = options.pattern.height || options.pattern.originalHeight || 100;
                
                // 检查是否为有效数值
                if (typeof patternWidth !== 'number' || isNaN(patternWidth) || patternWidth <= 0) {
                    console.warn('⚠️ 图案宽度无效，使用默认值 100');
                    patternWidth = 100;
                }
                if (typeof patternHeight !== 'number' || isNaN(patternHeight) || patternHeight <= 0) {
                    console.warn('⚠️ 图案高度无效，使用默认值 100');
                    patternHeight = 100;
                }
            } catch (error) {
                console.error('❌ 获取图案尺寸时发生错误:', error);
                patternWidth = 100;
                patternHeight = 100;
            }
            // 使用当前的缩放和角度设置，参考ClearHandler的逻辑
            const scale = options.pattern.currentScale || options.pattern.scale || 100;
            const angle = options.pattern.currentAngle || options.pattern.angle || 0;
            
            // 添加调试信息
            console.log('🎨 图案填充调试信息:', {
                patternWidth,
                patternHeight,
                scale,
                angle,
                hasPatternRgbData: !!options.pattern.patternRgbData,
                patternRgbDataLength: options.pattern.patternRgbData?.length,
                patternComponents: options.pattern.patternComponents,
                samplePixels: options.pattern.patternRgbData ? Array.from(options.pattern.patternRgbData.slice(0, 12)) : 'no data'
            });
            
            // 计算选区尺寸
            const selectionWidth = bounds.right - bounds.left;
            const selectionHeight = bounds.bottom - bounds.top;
            
            // 计算缩放后的图案尺寸
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            
            // 根据填充模式选择算法
            const fillMode = options.pattern.fillMode || 'tile'; // 默认为贴墙纸模式
            let patternData: Uint8Array;
            
            if (fillMode === 'stamp') {
                // 盖图章模式：图案居中显示，不重复
                console.log('🎯 使用盖图章模式填充');
                patternData = createStampPatternData(
                    options.pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    options.pattern.patternComponents,
                    selectionWidth,
                    selectionHeight,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle
                );
            } else {
                // 贴墙纸模式：无缝平铺
                console.log('🧱 使用贴墙纸模式填充');
                patternData = createTilePatternData(
                    options.pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    options.pattern.patternComponents,
                    selectionWidth,
                    selectionHeight,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    options.pattern.rotateAll !== false
                );
            }
            
            console.log('🔄 图案数据生成完成:', {
                patternDataLength: patternData.length,
                expectedLength: selectionWidth * selectionHeight * options.pattern.patternComponents,
                samplePatternPixels: Array.from(patternData.slice(0, 12))
            });
            
            // 创建ImageData对象
            const imageDataOptions = {
                width: selectionWidth,
                height: selectionHeight,
                components: options.pattern.patternComponents,
                chunky: true,
                colorProfile: "sRGB IEC61966-2.1",
                colorSpace: options.pattern.patternComponents === 4 ? 'RGBA' : 'RGB'
            };
            const imageData = await imaging.createImageDataFromBuffer(patternData, imageDataOptions);
            
            // 使用putPixels填充数据
            await imaging.putPixels({
                documentID: app.activeDocument.id,
                layerID: app.activeDocument.activeLayers[0].id,
                targetBounds: {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom
                },
                imageData: imageData
            });
            
            // 释放ImageData
            imageData.dispose();
        };
        
        // 第三步：设置图层属性的配置
        const setLayerProperties = {
            _obj: "set",
            _target: [{
                _ref: "layer",
                _enum: "ordinal",
                _value: "targetEnum"
            }],
            to: {
                _obj: "layer",
                opacity: {
                    _unit: "percentUnit",
                    _value: options.opacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: BLEND_MODES[options.blendMode] || "normal"
                }
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        // 第四步：剪贴蒙版的配置
        const createClippingMask = {
            _obj: "groupEvent",
            _target: [{
                _ref: "layer",
                _enum: "ordinal",
                _value: "targetEnum"
            }],
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        const applyMask = {
            _obj: "delete",
            _target: [
               {
                  _ref: "channel",
                  _enum: "channel",
                  _value: "mask"
               }
            ],
            apply: true,
            _options: {
               dialogOptions: "dontDisplay"
            }
         };
        const mergeLayers = {
            _obj: "mergeLayersNew",
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        try {
            // 执行操作
            await action.batchPlay([createBlankLayer], {});
            await action.batchPlay([setLayerName], {});
            await action.batchPlay([createLayerMask], {});

            
            // 填充图案数据
            await fillPatternData();
            
            // 设置图层属性
            await action.batchPlay([setLayerProperties], {});
            
            if (options.preserveTransparency) {
                await action.batchPlay([createClippingMask], {});
            }
            

            await action.batchPlay([applyMask], {});
            await action.batchPlay([mergeLayers], {});


            // 选中上一个选区
            await action.batchPlay([{
                _obj: "set",
                _target: [
                    {
                        _ref: "channel",
                        _property: "selection"
                    }
                ],
                to: {
                    _enum: "ordinal",
                    _value: "previous"
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }], { synchronousExecution: true });

            console.log("✅ 图案填充完成");
        } catch (error) {
            console.error("❌ 执行图案填充时发生错误:", error);
        }
    }




    //-------------------------------------------------------------------------------------------------
    // 快速蒙版状态下的直接填充
    private static async fillPatternDirect(options: PatternFillOptions) {
        try {
            // 参考ClearHandler的逻辑：先退出快速蒙版，转换为选区
            await action.batchPlay([{
                _obj: "set",
                _target: [{
                    _ref: "channel",
                    _property: "selection"
                }],
                to: {
                    _ref: [{
                        _ref: "channel",
                        _enum: "channel",
                        _value: "mask"
                    }]
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }], { synchronousExecution: true });
            
            // 退出快速蒙版模式
            await action.batchPlay([{
                _obj: "set",
                _target: [{
                    _ref: "property",
                    _property: "quickMask"
                }],
                to: false,
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }], { synchronousExecution: true });
            
            // 获取选区边界
            const bounds = await app.activeDocument.selection.bounds;
            
            if (!options.pattern.grayData) {
                console.error('缺少图案灰度数据');
                return;
            }
            
            // 计算选区尺寸
            const selectionWidth = bounds.right - bounds.left;
            const selectionHeight = bounds.bottom - bounds.top;
            
            // 安全地获取图案尺寸，参考ClearHandler的逻辑
            let patternWidth: number;
            let patternHeight: number;
            
            try {
                // 优先使用width和height，这些是PatternPicker中设置的当前尺寸
                patternWidth = options.pattern.width || options.pattern.originalWidth || 100;
                patternHeight = options.pattern.height || options.pattern.originalHeight || 100;
                
                // 检查是否为有效数值
                if (typeof patternWidth !== 'number' || isNaN(patternWidth) || patternWidth <= 0) {
                    console.warn('⚠️ 快速蒙版模式：图案宽度无效，使用默认值 100');
                    patternWidth = 100;
                }
                if (typeof patternHeight !== 'number' || isNaN(patternHeight) || patternHeight <= 0) {
                    console.warn('⚠️ 快速蒙版模式：图案高度无效，使用默认值 100');
                    patternHeight = 100;
                }
            } catch (error) {
                console.error('❌ 快速蒙版模式：获取图案尺寸时发生错误:', error);
                patternWidth = 100;
                patternHeight = 100;
            }
            // 使用当前的缩放和角度设置，参考ClearHandler的逻辑
            const scale = options.pattern.currentScale || options.pattern.scale || 100;
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            
            // 根据填充模式选择算法
            const fillMode = options.pattern.fillMode || 'tile'; // 默认为贴墙纸模式
            let grayPatternData: Uint8Array;
            
            if (fillMode === 'stamp') {
                // 盖图章模式：图案居中显示，不重复
                console.log('🎯 快速蒙版：使用盖图章模式填充');
                grayPatternData = createStampPatternData(
                    options.pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    selectionWidth,
                    selectionHeight,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    options.pattern.currentAngle || options.pattern.angle || 0
                );
            } else {
                // 贴墙纸模式：无缝平铺
                console.log('🧱 快速蒙版：使用贴墙纸模式填充，全部旋转:', options.pattern.rotateAll);
                grayPatternData = createTilePatternData(
                    options.pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    selectionWidth,
                    selectionHeight,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    options.pattern.currentAngle || options.pattern.angle || 0,
                    options.pattern.rotateAll !== false
                );
            }
            
            // 创建灰度ImageData对象
            const grayImageDataOptions = {
                width: selectionWidth,
                height: selectionHeight,
                components: 1,
                chunky: true,
                colorProfile: "Generic Gray Profile",
                colorSpace: 'Grayscale'
            };
            const grayImageData = await imaging.createImageDataFromBuffer(grayPatternData, grayImageDataOptions);
            
            // 使用putSelection填充灰度数据
            await imaging.putSelection({
                documentID: app.activeDocument.id,
                imageData: grayImageData
            });
            
            // 释放ImageData
            grayImageData.dispose();
            
            // 重新进入快速蒙版模式
            await action.batchPlay([{
                _obj: "set",
                _target: [{
                    _ref: "property",
                    _property: "quickMask"
                }],
                to: true,
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }], { synchronousExecution: true });
            
            console.log("✅ 快速蒙版图案填充完成");
        } catch (error) {
            console.error("❌ 快速蒙版图案填充失败:", error);
            throw error;
        }
    }
}