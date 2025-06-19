import { app, action, core, imaging } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Pattern } from '../types/state';

interface PatternFillOptions {
    opacity: number;
    blendMode: string;
    preserveTransparency: boolean;
    pattern: Pattern;
}

// 创建平铺图案数据的辅助函数（先平铺，后旋转）
function createTiledPatternData(
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
    // 第一步：创建平铺的图案数据（不考虑旋转）
    const tiledData = new Uint8Array(targetWidth * targetHeight * components);
    
    // 先进行平铺操作
    for (let y = 0; y < targetHeight; y++) {
        for (let x = 0; x < targetWidth; x++) {
            // 计算在缩放后图案中的位置
            const patternX = Math.floor((x % scaledPatternWidth) * patternWidth / scaledPatternWidth);
            const patternY = Math.floor((y % scaledPatternHeight) * patternHeight / scaledPatternHeight);
            
            // 确保坐标在图案范围内
            const sourceX = Math.min(patternX, patternWidth - 1);
            const sourceY = Math.min(patternY, patternHeight - 1);
            
            const sourceIndex = (sourceY * patternWidth + sourceX) * components;
            const targetIndex = (y * targetWidth + x) * components;
            
            // 复制像素数据
            for (let c = 0; c < components; c++) {
                tiledData[targetIndex + c] = patternData[sourceIndex + c];
            }
        }
    }
    
    // 第二步：如果有旋转角度，对整个平铺后的图案进行旋转
    if (angle !== 0) {
        const rotatedData = new Uint8Array(targetWidth * targetHeight * components);
        const angleRad = (angle * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        // 旋转中心为整个目标区域的中心
        const centerX = targetWidth / 2;
        const centerY = targetHeight / 2;
        
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                // 相对于中心的坐标
                const relativeX = x - centerX;
                const relativeY = y - centerY;
                
                // 反向旋转以获取原始坐标
                const originalX = relativeX * cos + relativeY * sin + centerX;
                const originalY = -relativeX * sin + relativeY * cos + centerY;
                
                const targetIndex = (y * targetWidth + x) * components;
                
                // 检查原始坐标是否在范围内
                if (originalX >= 0 && originalX < targetWidth && originalY >= 0 && originalY < targetHeight) {
                    // 使用双线性插值
                    const x1 = Math.floor(originalX);
                    const y1 = Math.floor(originalY);
                    const x2 = Math.min(x1 + 1, targetWidth - 1);
                    const y2 = Math.min(y1 + 1, targetHeight - 1);
                    
                    const fx = originalX - x1;
                    const fy = originalY - y1;
                    
                    for (let c = 0; c < components; c++) {
                        const p1 = tiledData[(y1 * targetWidth + x1) * components + c];
                        const p2 = tiledData[(y1 * targetWidth + x2) * components + c];
                        const p3 = tiledData[(y2 * targetWidth + x1) * components + c];
                        const p4 = tiledData[(y2 * targetWidth + x2) * components + c];
                        
                        const interpolated = p1 * (1 - fx) * (1 - fy) +
                                           p2 * fx * (1 - fy) +
                                           p3 * (1 - fx) * fy +
                                           p4 * fx * fy;
                        
                        rotatedData[targetIndex + c] = Math.round(interpolated);
                    }
                } else {
                    // 如果超出范围，使用平铺逻辑获取对应像素
                    const wrappedX = ((Math.floor(originalX) % targetWidth) + targetWidth) % targetWidth;
                    const wrappedY = ((Math.floor(originalY) % targetHeight) + targetHeight) % targetHeight;
                    const sourceIndex = (wrappedY * targetWidth + wrappedX) * components;
                    
                    for (let c = 0; c < components; c++) {
                        rotatedData[targetIndex + c] = tiledData[sourceIndex + c];
                    }
                }
            }
        }
        
        return rotatedData;
    }
    
    return tiledData;
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
            
            // 创建平铺的图案数据
            const tiledData = createTiledPatternData(
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
            
            console.log('🔄 平铺数据生成完成:', {
                tiledDataLength: tiledData.length,
                expectedLength: selectionWidth * selectionHeight * options.pattern.patternComponents,
                sampleTiledPixels: Array.from(tiledData.slice(0, 12))
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
            const imageData = await imaging.createImageDataFromBuffer(tiledData, imageDataOptions);
            
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
            
            const tiledGrayData = createTiledPatternData(
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
            
            // 创建灰度ImageData对象
            const grayImageDataOptions = {
                width: selectionWidth,
                height: selectionHeight,
                components: 1,
                chunky: true,
                colorProfile: "Generic Gray Profile",
                colorSpace: 'Grayscale'
            };
            const grayImageData = await imaging.createImageDataFromBuffer(tiledGrayData, grayImageDataOptions);
            
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