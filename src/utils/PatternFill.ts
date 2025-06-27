import { app, action, core, imaging } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Pattern } from '../types/state';
import { applyBlendMode } from './BlendModeCalculations';

interface PatternFillOptions {
    opacity: number;
    blendMode: string;
    preserveTransparency: boolean;
    pattern: Pattern;
}

// 盖图章模式：图案居中显示，不重复
async function createStampPatternData(
    patternData: Uint8Array,
    patternWidth: number,
    patternHeight: number,
    components: number,
    targetWidth: number,
    targetHeight: number,
    scaledPatternWidth: number,
    scaledPatternHeight: number,
    angle: number,
    bounds: any,
    isGrayMode: boolean = false
): Promise<Uint8Array> {
    let resultData: Uint8Array;
    
    // 非快速蒙版模式下，获取图案的原始像素数据        
    try {
        const activeDoc = app.activeDocument;
        const activeLayers = activeDoc.activeLayers;
        
        if (activeLayers.length === 0) {
            throw new Error('没有活动图层');
        }

        // 检查选区是否存在且有效
        if (!bounds || bounds.left >= bounds.right || bounds.top >= bounds.bottom) {
            // 如果选区无效，则创建背景
            console.log('选区无效或为空，创建背景');
            resultData = new Uint8Array(targetWidth * targetHeight * components);
            if (isGrayMode) {
                // 灰度模式：背景设置为0（黑色）
                resultData.fill(0);
            } else if (components === 4) {
                //图案为RGBA格式：背景设置为完全透明
                for (let i = 3; i < resultData.length; i += 4) {
                    resultData[i] = 0;
                }
            } else {
                // 图案为RGB格式：背景设置为白色
                for (let i = 0; i < resultData.length; i += 3) {
                    resultData[i] = 255;     // R
                    resultData[i + 1] = 255; // G
                    resultData[i + 2] = 255; // B
                }
            }
        } else {
            const pixelOptions = {
                documentID: activeDoc.id,
                layerID: activeLayers[0].id,
                targetSize: {
                    width: targetWidth,
                    height: targetHeight
                },
                componentSize: 8,
                applyAlpha: true, // 始终尝试获取Alpha通道
                colorProfile: "sRGB IEC61966-2.1",
                bounds: {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom
                }
            };
            
            const pixelData = await imaging.getPixels(pixelOptions);
            if (pixelData && pixelData.imageData) {
                const dataPromise = pixelData.imageData.getData();
                let backgroundData: Uint8Array;
                if (dataPromise && typeof dataPromise.then === 'function') {
                    backgroundData = await dataPromise;
                } else {
                    backgroundData = dataPromise;
                }

                // 强制将背景处理为与图案相同的通道数
                resultData = new Uint8Array(targetWidth * targetHeight * components);

                if (components === 4) { // 图案是 RGBA
                    if (backgroundData.length === targetWidth * targetHeight * 4) {
                        // 背景也是 RGBA
                        resultData.set(backgroundData);
                    } else if (backgroundData.length === targetWidth * targetHeight * 3) {
                        // 背景是 RGB，转换为 RGBA
                        for (let i = 0; i < targetWidth * targetHeight; i++) {
                            const srcIndex = i * 3;
                            const dstIndex = i * 4;
                            resultData[dstIndex] = backgroundData[srcIndex];
                            resultData[dstIndex + 1] = backgroundData[srcIndex + 1];
                            resultData[dstIndex + 2] = backgroundData[srcIndex + 2];
                            resultData[dstIndex + 3] = 255; // 默认为不透明
                        }
                    }
                } else if (components === 3) { // 图案是 RGB
                    if (backgroundData.length === targetWidth * targetHeight * 4) {
                        // 背景是 RGBA，转换为 RGB
                        for (let i = 0; i < targetWidth * targetHeight; i++) {
                            const srcIndex = i * 4;
                            const dstIndex = i * 3;
                            resultData[dstIndex] = backgroundData[srcIndex];
                            resultData[dstIndex + 1] = backgroundData[srcIndex + 1];
                            resultData[dstIndex + 2] = backgroundData[srcIndex + 2];
                        }
                    } else if (backgroundData.length === targetWidth * targetHeight * 3) {
                        // 背景也是 RGB
                        resultData.set(backgroundData);
                    }
                }
            } else {
                throw new Error('无法获取原始像素数据');
            }
        }
    } catch (error) {
        if (error.message.includes('grabPixels')) {
             console.log('无法获取像素（可能因为没有选区），使用全选的maskValue。');
        } else {
             console.warn('获取原始像素数据失败，使用默认背景:', error);
        }

      // 如果获取失败，创建默认背景
        resultData = new Uint8Array(targetWidth * targetHeight * components);
        if (isGrayMode) {
            // 灰度模式：背景设置为0（黑色）
            resultData.fill(0);
        } else if (components === 4) {
            // RGBA格式：设置为透明
            for (let i = 3; i < resultData.length; i += 4) {
                resultData[i] = 0; // alpha = 0 (透明)
            }
        } else {
            // RGB格式：设置为白色
            for (let i = 0; i < resultData.length; i += 3) {
                resultData[i] = 255;     // R
                resultData[i + 1] = 255; // G
                resultData[i + 2] = 255; // B
            }
        }
    }
    
    // 计算图案在目标区域的居中位置
    const offsetX = (targetWidth - scaledPatternWidth) / 2;
    const offsetY = (targetHeight - scaledPatternHeight) / 2;
    
    const angleRad = (angle * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    
    // 图案中心在目标区域中的位置
    const patternCenterX = offsetX + scaledPatternWidth / 2;
    const patternCenterY = offsetY + scaledPatternHeight / 2;
    // 选区中心
    const selectionCenterX = targetWidth / 2;
    const selectionCenterY = targetHeight / 2;
    // 使用选区中心作为旋转中心（这样图案会围绕选区中心旋转）
    const centerX = selectionCenterX;
    const centerY = selectionCenterY;
    
    // 像素混合处理函数
    const blendPixel = (sourceIndex: number, targetIndex: number) => {
        if (isGrayMode) {
            // 灰度模式：正常模式100%不透明度覆盖
            resultData[targetIndex] = patternData[sourceIndex];
        } else if (components === 4) {
            // RGBA格式：根据alpha通道进行透明度混合
            const patternAlpha = patternData[sourceIndex + 3] / 255;
            if (patternAlpha > 0) { // 只有当图案像素不完全透明时才绘制
                const backgroundAlpha = resultData[targetIndex + 3] / 255;
                const outAlpha = patternAlpha + backgroundAlpha * (1 - patternAlpha);
                
                if (outAlpha > 0) {
                    resultData[targetIndex] = Math.round((patternData[sourceIndex] * patternAlpha + resultData[targetIndex] * backgroundAlpha * (1 - patternAlpha)) / outAlpha);
                    resultData[targetIndex + 1] = Math.round((patternData[sourceIndex + 1] * patternAlpha + resultData[targetIndex + 1] * backgroundAlpha * (1 - patternAlpha)) / outAlpha);
                    resultData[targetIndex + 2] = Math.round((patternData[sourceIndex + 2] * patternAlpha + resultData[targetIndex + 2] * backgroundAlpha * (1 - patternAlpha)) / outAlpha);
                    resultData[targetIndex + 3] = Math.round(outAlpha * 255);
                }
            }
        } else {
            // RGB格式：直接复制
            for (let c = 0; c < components; c++) {
                resultData[targetIndex + c] = patternData[sourceIndex + c];
            }
        }
    };

    // 获取图案像素的函数
    const getPatternPixel = (x: number, y: number) => {
        let patternX: number, patternY: number;
        
        if (angle !== 0) {
            // 计算相对于旋转中心的坐标
            const relativeX = x - centerX;
            const relativeY = y - centerY;
            
            // 反向旋转以获取原始坐标
            const originalX = relativeX * cos + relativeY * sin + centerX;
            const originalY = -relativeX * sin + relativeY * cos + centerY;
            
            // 计算在图案中的位置
            patternX = originalX - offsetX;
            patternY = originalY - offsetY;
        } else {
            // 无旋转的情况
            patternX = x - offsetX;
            patternY = y - offsetY;
        }
        
        // 检查是否在图案范围内
        if (patternX >= 0 && patternX < scaledPatternWidth && patternY >= 0 && patternY < scaledPatternHeight) {
            // 映射到原始图案坐标
            const sourceX = Math.floor(patternX * patternWidth / scaledPatternWidth);
            const sourceY = Math.floor(patternY * patternHeight / scaledPatternHeight);
            
            if (sourceX >= 0 && sourceX < patternWidth && sourceY >= 0 && sourceY < patternHeight) {
                return (sourceY * patternWidth + sourceX) * components;
            }
        }
        return -1;
    };

    // 主循环：遍历目标区域的每个像素
    for (let y = 0; y < targetHeight; y++) {
        for (let x = 0; x < targetWidth; x++) {
            const targetIndex = (y * targetWidth + x) * components;
            const sourceIndex = getPatternPixel(x, y);
            
            if (sourceIndex >= 0) {
                blendPixel(sourceIndex, targetIndex);
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
    rotateAll: boolean = true,
    bounds?: any  // 添加bounds参数以支持全局坐标平铺
): Uint8Array {
    
    // 创建最终结果数据
    const resultData = new Uint8Array(targetWidth * targetHeight * components);
    
    if (angle === 0) {
        // 无旋转的情况，直接平铺
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                // 如果有bounds参数，使用全局坐标进行平铺
                let globalX, globalY;
                if (bounds) {
                    globalX = bounds.left + x;
                    globalY = bounds.top + y;
                } else {
                    globalX = x;
                    globalY = y;
                }
                
                const patternX = Math.floor((globalX % scaledPatternWidth) * patternWidth / scaledPatternWidth);
                const patternY = Math.floor((globalY % scaledPatternHeight) * patternHeight / scaledPatternHeight);
                
                const sourceX = Math.min(patternX, patternWidth - 1);
                const sourceY = Math.min(patternY, patternHeight - 1);
                
                const sourceIndex = (sourceY * patternWidth + sourceX) * components;
                const targetIndex = (y * targetWidth + x) * components;
                
                for (let c = 0; c < components; c++) {
                    resultData[targetIndex + c] = patternData[sourceIndex + c];
                }
            }
        }
        return resultData;
    }
    
    if (rotateAll) {
        // 全部旋转模式：先平铺再整体旋转
        console.log('🔄 全部旋转模式：先平铺再整体旋转');
        
        const diagonal = Math.sqrt(targetWidth * targetWidth + targetHeight * targetHeight);
        const expandedSize = Math.ceil(diagonal);
        
        // 计算目标区域在扩展区域中的偏移，确保目标区域居中
        const offsetX = (expandedSize - targetWidth) / 2;
        const offsetY = (expandedSize - targetHeight) / 2;
        
        // 创建扩展的平铺数据
        const expandedData = new Uint8Array(expandedSize * expandedSize * components);
        
        // 先在扩展区域进行平铺（不旋转）
        for (let y = 0; y < expandedSize; y++) {
            for (let x = 0; x < expandedSize; x++) {
                // 将扩展区域坐标映射到目标区域坐标系
                const targetX = x - offsetX;
                const targetY = y - offsetY;
                
                // 如果有bounds参数，使用全局坐标进行平铺
                let globalX, globalY;
                if (bounds) {
                    globalX = bounds.left + targetX;
                    globalY = bounds.top + targetY;
                } else {
                    globalX = targetX;
                    globalY = targetY;
                }
                
                // 使用连续平铺逻辑，确保无缝衔接
                const tileX = ((globalX % scaledPatternWidth) + scaledPatternWidth) % scaledPatternWidth;
                const tileY = ((globalY % scaledPatternHeight) + scaledPatternHeight) % scaledPatternHeight;
                
                const patternX = Math.floor(tileX * patternWidth / scaledPatternWidth);
                const patternY = Math.floor(tileY * patternHeight / scaledPatternHeight);
                
                const sourceX = Math.min(Math.max(0, patternX), patternWidth - 1);
                const sourceY = Math.min(Math.max(0, patternY), patternHeight - 1);
                
                const sourceIndex = (sourceY * patternWidth + sourceX) * components;
                const targetIndex = (y * expandedSize + x) * components;
                
                for (let c = 0; c < components; c++) {
                    expandedData[targetIndex + c] = patternData[sourceIndex + c];
                }
            }
        }
        
        // 然后对整个平铺结果进行旋转
        const angleRad = (angle * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        const centerX = targetWidth / 2;
        const centerY = targetHeight / 2;
        const expandedCenterX = expandedSize / 2;
        const expandedCenterY = expandedSize / 2;
        
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                const relativeX = x - centerX;
                const relativeY = y - centerY;
                
                // 反向旋转以获取扩展区域中的坐标
                const expandedX = relativeX * cos + relativeY * sin + expandedCenterX;
                const expandedY = -relativeX * sin + relativeY * cos + expandedCenterY;
                
                const targetIndex = (y * targetWidth + x) * components;
                
                // 简化边界检查，只在安全范围内使用双线性插值
                if (expandedX >= 0 && expandedX < expandedSize - 1 && 
                    expandedY >= 0 && expandedY < expandedSize - 1) {
                    const x1 = Math.floor(expandedX);
                    const y1 = Math.floor(expandedY);
                    const x2 = x1 + 1;
                    const y2 = y1 + 1;
                    
                    // 双重检查确保采样点有效
                    if (x1 >= 0 && x2 < expandedSize && y1 >= 0 && y2 < expandedSize) {
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
                        // 使用最近邻采样作为安全回退
                        const nearestX = Math.max(0, Math.min(expandedSize - 1, Math.round(expandedX)));
                        const nearestY = Math.max(0, Math.min(expandedSize - 1, Math.round(expandedY)));
                        const sourceIndex = (nearestY * expandedSize + nearestX) * components;
                        
                        for (let c = 0; c < components; c++) {
                            resultData[targetIndex + c] = expandedData[sourceIndex + c];
                        }
                    }
                } else {
                    // 超出扩展区域时，使用扩展区域边界的像素（避免产生异常图案）
                    const clampedX = Math.max(0, Math.min(expandedSize - 1, Math.round(expandedX)));
                    const clampedY = Math.max(0, Math.min(expandedSize - 1, Math.round(expandedY)));
                    const sourceIndex = (clampedY * expandedSize + clampedX) * components;
                    
                    for (let c = 0; c < components; c++) {
                        resultData[targetIndex + c] = expandedData[sourceIndex + c];
                    }
                }
            }
        }
    } else {
        // 单独旋转模式：先旋转图案再平铺
        console.log('🔄 单独旋转模式：先旋转图案再平铺');
        
        const angleRad = (angle * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        // 计算旋转后图案的边界框
        const corners = [
            { x: 0, y: 0 },
            { x: scaledPatternWidth, y: 0 },
            { x: scaledPatternWidth, y: scaledPatternHeight },
            { x: 0, y: scaledPatternHeight }
        ];
        
        const patternCenterX = scaledPatternWidth / 2;
        const patternCenterY = scaledPatternHeight / 2;
        
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        corners.forEach(corner => {
            const relX = corner.x - patternCenterX;
            const relY = corner.y - patternCenterY;
            const rotX = relX * cos - relY * sin + patternCenterX;
            const rotY = relX * sin + relY * cos + patternCenterY;
            
            minX = Math.min(minX, rotX);
            maxX = Math.max(maxX, rotX);
            minY = Math.min(minY, rotY);
            maxY = Math.max(maxY, rotY);
        });
        
        const rotatedWidth = Math.ceil(maxX - minX);
        const rotatedHeight = Math.ceil(maxY - minY);
        const offsetX = -minX;
        const offsetY = -minY;
        
        // 创建旋转后的图案数据
        const rotatedPatternData = new Uint8Array(rotatedWidth * rotatedHeight * components);
        
        // 生成旋转后的图案
        for (let y = 0; y < rotatedHeight; y++) {
            for (let x = 0; x < rotatedWidth; x++) {
                const targetIndex = (y * rotatedWidth + x) * components;
                
                // 计算在旋转前图案中的坐标
                const adjustedX = x - offsetX;
                const adjustedY = y - offsetY;
                
                const relativeX = adjustedX - patternCenterX;
                const relativeY = adjustedY - patternCenterY;
                
                // 反向旋转获取原始坐标
                const originalX = relativeX * cos + relativeY * sin + patternCenterX;
                const originalY = -relativeX * sin + relativeY * cos + patternCenterY;
                
                // 检查是否在原始图案范围内（不使用模运算，保持图案独立性）
                if (originalX >= 0 && originalX < scaledPatternWidth && originalY >= 0 && originalY < scaledPatternHeight) {
                    // 映射到原始图案像素
                    const sourceX = Math.floor(originalX * patternWidth / scaledPatternWidth);
                    const sourceY = Math.floor(originalY * patternHeight / scaledPatternHeight);
                    
                    // 确保索引在有效范围内
                    const clampedSourceX = Math.max(0, Math.min(patternWidth - 1, sourceX));
                    const clampedSourceY = Math.max(0, Math.min(patternHeight - 1, sourceY));
                    
                    const sourceIndex = (clampedSourceY * patternWidth + clampedSourceX) * components;
                    
                    for (let c = 0; c < components; c++) {
                        rotatedPatternData[targetIndex + c] = patternData[sourceIndex + c];
                    }
                } else {
                    // 超出原始图案范围的部分设为透明（灰度值0），与ClearHandler保持一致
                    for (let c = 0; c < components; c++) {
                        rotatedPatternData[targetIndex + c] = 0;
                    }
                }
            }
        }
        
        // 使用旋转后的图案进行无缝平铺
        console.log(`🔄 开始平铺旋转后的图案`);
        
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                const targetIndex = (y * targetWidth + x) * components;
                
                // 如果有bounds参数，使用全局坐标进行平铺（与ClearHandler保持一致）
                let globalX, globalY;
                if (bounds) {
                    globalX = bounds.left + x;
                    globalY = bounds.top + y;
                } else {
                    globalX = x;
                    globalY = y;
                }
                
                // 计算在旋转后图案中的位置（确保无缝平铺）
                const tileX = ((globalX % rotatedWidth) + rotatedWidth) % rotatedWidth;
                const tileY = ((globalY % rotatedHeight) + rotatedHeight) % rotatedHeight;
                
                const sourceIndex = (tileY * rotatedWidth + tileX) * components;
                
                // 检查源索引是否有效
                if (sourceIndex >= 0 && sourceIndex < rotatedPatternData.length - components + 1) {
                    for (let c = 0; c < components; c++) {
                        resultData[targetIndex + c] = rotatedPatternData[sourceIndex + c];
                    }
                } else {
                    // 如果索引无效，使用透明像素
                    for (let c = 0; c < components; c++) {
                        resultData[targetIndex + c] = 0; // 透明
                    }
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

// ---------------------------------------------------------------------------------------------------
// 不在快速蒙版中，根据用户指定条件填充相应的图案。（RGB/RGBA）
export class PatternFill {
    static async fillPattern(options: PatternFillOptions, layerInfo: LayerInfo) {
        // 检查是否有图案数据
        const components = options.pattern.components || options.pattern.patternComponents || 3;
        if (!options.pattern.patternRgbData || !components) {
            console.error("❌ 没有可用的图案数据，无法填充", {
                hasPatternRgbData: !!options.pattern.patternRgbData,
                components: components,
                patternComponents: options.pattern.patternComponents
            });
            return;
        }
        

        // 如果在快速蒙版状态，使用快速蒙版中的填充
        if (layerInfo.isInQuickMask) {
            await this.fillPatternDirect(options);
            return;
        } else {
            console.log('📝 当前不在快速蒙版状态，使用常规填充方法');
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
                patternData = await createStampPatternData(
                    options.pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    components,
                    selectionWidth,
                    selectionHeight,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    bounds
                );
            } else {
                // 贴墙纸模式：无缝平铺
                console.log('🧱 使用贴墙纸模式填充');
                patternData = createTilePatternData(
                    options.pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    components,
                    selectionWidth,
                    selectionHeight,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    options.pattern.rotateAll !== false
                );
            }
            
            // 创建ImageData对象，准备填充
            const imageDataOptions = {
                width: selectionWidth,
                height: selectionHeight,
                components: components,
                chunky: true,
                colorProfile: "sRGB IEC61966-2.1",
                colorSpace: options.pattern.colorSpace || (components === 4 ? 'RGBA' : 'RGB')
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
            // 新建待处理图层
            await action.batchPlay([createBlankLayer], {});
            await action.batchPlay([setLayerName], {});
            await action.batchPlay([createLayerMask], {});

            
            // 填充图案数据
            await fillPatternData();
            
            // 设置图层属性
            await action.batchPlay([setLayerProperties], {});
            
            // 根据checkbox信息是否创建剪贴蒙版。
            if (options.preserveTransparency) {
                await action.batchPlay([createClippingMask], {});
            }
            

            await action.batchPlay([applyMask], {});
            await action.batchPlay([mergeLayers], {});


            // 选中上一个选区，为主面板的清除选区留后路。
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
    // 快速蒙版状态下的直接填充核心函数（灰度）（支持混合模式和不透明度）
    private static async fillPatternDirect(options: PatternFillOptions) {
        try {
            console.log('🎨 开始快速蒙版图案填充。');
            
            // 获取当前选区边界信息
            const selectionBounds = await this.getSelectionBounds();
            if (!selectionBounds) {
                console.warn('❌ 没有选区，无法执行快速蒙版图案填充操作');
                return;
            }

            // 获取快速蒙版通道的像素数据和colorIndicates信息
            const { quickMaskPixels, isSelectedAreas, isEmpty, isNotFull, originalTopLeft, originalBottomRight } = await this.getQuickMaskPixels(selectionBounds);
            
            // 获取图案填充的灰度数据
            const fillGrayData = await this.getPatternFillGrayData(options, selectionBounds);
            
            // 应用混合模式计算最终灰度值
            const finalGrayData = await this.calculateFinalGrayValues(
                quickMaskPixels, 
                fillGrayData, 
                isSelectedAreas, 
                options.opacity,
                options.blendMode,
                isEmpty,  // 传递isEmpty状态
                selectionBounds,  // 传递bounds信息
                isNotFull,  // 传递不完整蒙版标记
                originalTopLeft,  // 传递原始左上角像素值
                originalBottomRight  // 传递原始右下角像素值
            );
            
            // 将计算后的灰度数据写回快速蒙版通道
            await this.updateQuickMaskChannel(finalGrayData, selectionBounds, isEmpty);
            
        } catch (error) {
            console.error("❌ 快速蒙版图案填充失败:", error);
            throw error;
        }
    }

    // 获取选区边界信息与文档信息（参考ClearHandler的实现）
    private static async getSelectionBounds() {
        try {
            // batchplay获取文档信息和选区信息
            const [docResult, selectionResult] = await Promise.all([
                action.batchPlay([
                    {
                        _obj: "get",
                        _target: [
                            {
                                _ref: "document",
                                _enum: "ordinal",
                                _value: "targetEnum"
                            }
                        ]
                    }
                ], { synchronousExecution: true }),
                action.batchPlay([
                    {
                        _obj: "get",
                        _target: [
                            {
                                _property: "selection"
                            },
                            {
                                _ref: "document",
                                _enum: "ordinal",
                                _value: "targetEnum"
                            }
                        ]
                    }
                ], { synchronousExecution: true })
            ]);
            
            // 步骤1: 将选区转换为路径,容差2
            const pathResult = await action.batchPlay([
                {
                    _obj: "make",
                    _target: [
                        {
                            _ref: "path"
                        }
                    ],
                    from: {
                        _ref: "selectionClass",
                        _property: "selection"
                    },
                    tolerance: {
                        _unit: "pixelsUnit",
                        _value: 2
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
            // 步骤2: 获取路径的边缘点坐标信息
            const pathPointsResult = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "path",
                            _name: "工作路径"
                        }
                    ]
                }
            ], { synchronousExecution: true });
            
            // 提取路径的anchor点坐标
            let pathPoints = [];
            if (pathPointsResult[0] && pathPointsResult[0].pathContents && pathPointsResult[0].pathContents.pathComponents) {
                const pathComponents = pathPointsResult[0].pathContents.pathComponents;
                for (const component of pathComponents) {
                    if (component.subpathListKey) {
                        for (const subpath of component.subpathListKey) {
                            if (subpath.points) {
                                for (const point of subpath.points) {
                                    if (point.anchor && point.anchor.horizontal && point.anchor.vertical) {
                                        pathPoints.push({
                                            x: point.anchor.horizontal._value,
                                            y: point.anchor.vertical._value
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            
            // 步骤3: 删除工作路径
            await action.batchPlay([
                {
                    _obj: "delete",
                    _target: [
                        {
                            _ref: "path",
                            _property: "workPath"
                        }
                    ],
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
           // 获取文档尺寸信息（完全参考ClearHandler的处理方式）
            const docWidth = docResult[0].width._value;
            const docHeight = docResult[0].height._value;
            const resolution = docResult[0].resolution._value;
            
            // 直接转换为像素单位（与ClearHandler保持一致）
            const docWidthPixels = Math.round(docWidth * resolution / 72);
            const docHeightPixels = Math.round(docHeight * resolution / 72);    
            // 获取选区边界
            const bounds = selectionResult[0].selection;
            const left = Math.round(bounds.left._value);
            const top = Math.round(bounds.top._value);
            const right = Math.round(bounds.right._value);
            const bottom = Math.round(bounds.bottom._value);
            const width = right - left;
            const height = bottom - top;
            
            // 使用射线法计算选区内的像素（传入正确的像素单位）
            const selectionPixels = await this.getPixelsInPolygon(pathPoints, left, top, right, bottom, docWidthPixels, docHeightPixels);
            
            return {
                left,
                top,
                right,
                bottom,
                width,
                height,
                docWidth: docWidthPixels,  // 返回像素单位的文档宽度
                docHeight: docHeightPixels, // 返回像素单位的文档高度
                selectionPixels
            };
            
        } catch (error) {
            console.error('获取选区边界失败:', error);
            return null;
        }
    }


    // 收集在多边形选区内的像素（优化版本，避免栈溢出）
    private static async getPixelsInPolygon(polygonPoints: Array<{x: number, y: number}>, left: number, top: number, right: number, bottom: number, docWidth: number, docHeight: number): Promise<Set<number>> {
        const selectionPixels = new Set<number>();
        
        const startY = Math.floor(top);
        const endY = Math.ceil(bottom);
        const startX = Math.floor(left);
        const endX = Math.ceil(right);
        // 分批处理，避免一次性处理过多像素导致栈溢出
        const BATCH_SIZE = 1000; // 每批处理1000行
        
        for (let batchStartY = startY; batchStartY <= endY; batchStartY += BATCH_SIZE) {
            const batchEndY = Math.min(batchStartY + BATCH_SIZE - 1, endY);
            
            // 使用setTimeout让出控制权，避免阻塞主线程
            await new Promise(resolve => {
                setTimeout(() => {
                    this.processBatchPixels(polygonPoints, startX, endX, batchStartY, batchEndY, docWidth, docHeight, selectionPixels);
                    resolve(void 0);
                }, 0);
            });
        }
        
        console.log('🎯 选区内像素数量:', selectionPixels.size);
        return selectionPixels;
    }
    
    // 分批处理像素，避免栈溢出
    private static processBatchPixels(polygonPoints: Array<{x: number, y: number}>, startX: number, endX: number, startY: number, endY: number, docWidth: number, docHeight: number, selectionPixels: Set<number>) {
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                if (this.isPointInPolygon(x, y, polygonPoints)) {
                    // 计算像素在整个文档数组中的位置：docWidth * ( y - 1 ) + x
                    const pixelIndex = docWidth * ( y - 1 ) + x;
                    selectionPixels.add(pixelIndex);
                }
            }
        }
    }

    // 射线法判断像素是否在多边形内
    private static isPointInPolygon(x: number, y: number, polygonPoints: Array<{x: number, y: number}>): boolean {
        let intersectionCount = 0;
        const n = polygonPoints.length;
        
        for (let i = 0; i < n; i++) {
            const p1 = polygonPoints[i];
            const p2 = polygonPoints[(i + 1) % n];
            
            // 检查射线是否与边相交
            if (((p1.y > y) !== (p2.y > y)) && 
                (x < (p2.x - p1.x) * (y - p1.y) / (p2.y - p1.y) + p1.x)) {
                intersectionCount++;
            }
        }
        
        // 奇数个交点表示在多边形内
        return intersectionCount % 2 === 1;
    }


    //-------------------------------------------------------------------------------------------------
    // 获取快速蒙版通道的像素数据
    private static async getQuickMaskPixels(bounds: any) {
        try {  
            // 获取快速蒙版通道信息
            const channelResult = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "channel",
                            _name: "快速蒙版"  // 快速蒙版通道名称
                        }
                    ]
                }
            ], { synchronousExecution: true });

            // 获取colorIndicates信息
            let isSelectedAreas = false;
            if (channelResult[0] && 
                channelResult[0].alphaChannelOptions && 
                channelResult[0].alphaChannelOptions.colorIndicates) {
                isSelectedAreas = channelResult[0].alphaChannelOptions.colorIndicates._value === "selectedAreas";
            }
            console.log(`🔍 检测到colorIndicates为${isSelectedAreas ? 'selectedAreas' : '非selectedAreas'}`);
            // 检查快速蒙版直方图状态
            const histogram = channelResult[0].histogram;
            const maskStatus = await this.analyzeQuickMaskHistogram(histogram, isSelectedAreas);
            
            if (maskStatus.isEmpty) {
                console.log('⚠️ 检测到快速蒙版为空，通过填充快速蒙版改造以便后续正常填充');
                
                // 第一步：设置前景色为指定颜色（根据selectedAreas类型）
                await action.batchPlay([
                    {
                        _obj: "set",
                        _target: [
                            {
                                _ref: "color",
                                _property: "foregroundColor"
                            }
                        ],
                        to: {
                            _obj: "HSBColorClass",
                            hue: {
                                _unit: "angleUnit",
                                _value: 0
                            },
                            saturation: {
                                _unit: "percentUnit",
                                _value: 0
                            },
                            brightness: {
                                _unit: "percentUnit",
                                _value: isSelectedAreas ? 0 : 100  // selectedAreas设置黑色(0)，非selectedAreas设置白色(100)
                            }
                        },
                        source: "photoshopPicker",
                        _options: {
                            dialogOptions: "dontDisplay"
                        }
                    }
                ], { synchronousExecution: true });

                // 第二步：使用前景色填充
                await action.batchPlay([
                    {
                        _obj: "fill",
                        using: {
                            _enum: "fillContents",
                            _value: "foregroundColor"
                        },
                        opacity: {
                            _unit: "percentUnit",
                            _value: 100
                        },
                        mode: {
                            _enum: "blendMode",
                            _value: "normal"
                        },
                        _options: {
                            dialogOptions: "dontDisplay"
                        }
                    }
                ], { synchronousExecution: true });
                
            }
            
            
            // 撤销快速蒙版
            await this.clearQuickMask();
            
            // 如果是纯白快速蒙版（非selectedAreas模式下），需要执行全选操作
            if (!isSelectedAreas && maskStatus.isWhite) {
                await this.selectAll();
            }

            // 通过获取选区的灰度信息，间接获取完整文档的快速蒙版数据，maskValue数组
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);
            
            const pixels = await imaging.getSelection({
                documentID: app.activeDocument.id,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: finalDocWidth,
                    bottom: finalDocHeight
                },
                componentSize: 8,
                colorProfile: "Dot Gain 15%"
            });
            
            const quickMaskPixels = await pixels.imageData.getData();
            console.log('✅ 快速蒙版内所有的图案长度:', quickMaskPixels.length);

            // 如果快速蒙版为空，直接返回空的maskValue数组
            if (maskStatus.isEmpty) {
                console.log('⚠️ 检测到快速蒙版为空，跳过复杂的像素映射逻辑');
                const expectedPixelCount = finalDocWidth * finalDocHeight;
                const maskValue = new Uint8Array(expectedPixelCount);
                
                // 将quickMaskPixels数据复制到maskValue中
                for (let i = 0; i < Math.min(quickMaskPixels.length, maskValue.length); i++) {
                    maskValue[i] = quickMaskPixels[i];
                }
                
                // 释放ImageData内存
                pixels.imageData.dispose();
                
                return {
                    quickMaskPixels: maskValue,
                    isSelectedAreas: isSelectedAreas,
                    isEmpty: maskStatus.isEmpty,
                    isNotFull: false,
                    originalTopLeft: 0,
                    originalBottomRight: 0
                };
            }

            // 使用临时图层获取选区在整个文档中的精确索引位置
            console.log('🎯 获取蒙版非空像素的索引位置');
            
            // 1. 新建一个临时图层
            const tempLayer = await app.activeDocument.layers.add({
                name: "临时索引图层",
                opacity: 100,
                blendMode: "normal"
            });
            // 2. 为选区填充前景色（使用batchPlay）
            await action.batchPlay([
                {
                    _obj: "fill",
                    using: {
                        _enum: "fillContents",
                        _value: "foregroundColor"
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], {});
            
            // 3. 获取这个临时图层每一个像素在整个文档中的索引值
            const tempLayerPixels = await imaging.getPixels({
                documentID: app.activeDocument.id,
                layerID: tempLayer.id,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: finalDocWidth,
                    bottom: finalDocHeight
                },
                componentSize: 8,
                colorProfile: "sRGB IEC61966-2.1"
            });
            
            const tempLayerData = await tempLayerPixels.imageData.getData();
            
            // 4. 删除临时图层
            await require('photoshop').action.batchPlay([
                {
                    _obj: "delete",
                    _target: [
                        {
                            _ref: "layer",
                            _enum: "ordinal",
                            _value: "targetEnum"
                        }
                    ]
                }
            ], {});
            
            // 5. 利用获取的索引值扩展出maskValue数组
            const expectedPixelCount = finalDocWidth * finalDocHeight;
            let maskValue = new Uint8Array(expectedPixelCount);
            
            // 找出所有非透明像素的位置（Alpha值不为0的位置）
            const selectionIndices: number[] = [];
            
            // tempLayerData是RGBA格式，每4个字节代表一个像素
            for (let i = 0; i < tempLayerData.length; i += 4) {
                const alpha = tempLayerData[i + 3];
                
                // 如果Alpha值不为0，说明这个位置在选区内（非透明像素）
                if (alpha !== 0) {
                    const pixelIndex = Math.floor(i / 4);
                    selectionIndices.push(pixelIndex);
                }
            }
            
            
            // 调试：检查quickMaskPixels中非零像素的数量
            let quickMaskNonZeroCount = 0;
            for (let i = 0; i < quickMaskPixels.length; i++) {
                if (quickMaskPixels[i] !== 0) {
                    quickMaskNonZeroCount++;
                }
            }
            
            // 调试：检查tempLayerData中alpha值的分布
            let alphaDistribution = new Array(256).fill(0);
            for (let i = 3; i < tempLayerData.length; i += 4) {
                const alpha = tempLayerData[i];
                alphaDistribution[alpha]++;
            }
            
            // 将quickMaskPixels中的非零值映射到正确的索引位置
            let nonZeroIndex = 0; // 用于追踪quickMaskPixels中非零值的索引
            for (let i = 0; i < quickMaskPixels.length && nonZeroIndex < selectionIndices.length; i++) {
                if (quickMaskPixels[i] !== 0) {
                    const targetIndex = selectionIndices[nonZeroIndex];
                    maskValue[targetIndex] = quickMaskPixels[i];
                    nonZeroIndex++;
                }
            }
            console.log('🎯 成功映射非零像素数量:', nonZeroIndex);
            
            // 输出四个角落附近5个点的maskValue值
            console.log('🔍 maskValue四个角落附近的值:');
            console.log('左上角附近5个点:', [
                maskValue[0], // 左上角
                maskValue[1], // 右移1个像素
                maskValue[finalDocWidth], // 下移1行
                maskValue[finalDocWidth + 1], // 右下移1个像素
                maskValue[2] // 右移2个像素
            ]);
            console.log('右上角附近5个点:', [
                maskValue[finalDocWidth - 1], // 右上角
                maskValue[finalDocWidth - 2], // 左移1个像素
                maskValue[finalDocWidth * 2 - 1], // 下移1行
                maskValue[finalDocWidth * 2 - 2], // 左下移1个像素
                maskValue[finalDocWidth - 3] // 左移2个像素
            ]);
            console.log('左下角附近5个点:', [
                maskValue[(finalDocHeight - 1) * finalDocWidth], // 左下角
                maskValue[(finalDocHeight - 1) * finalDocWidth + 1], // 右移1个像素
                maskValue[(finalDocHeight - 2) * finalDocWidth], // 上移1行
                maskValue[(finalDocHeight - 2) * finalDocWidth + 1], // 右上移1个像素
                maskValue[(finalDocHeight - 1) * finalDocWidth + 2] // 右移2个像素
            ]);
            console.log('右下角附近5个点:', [
                maskValue[finalDocHeight * finalDocWidth - 1], // 右下角
                maskValue[finalDocHeight * finalDocWidth - 2], // 左移1个像素
                maskValue[(finalDocHeight - 1) * finalDocWidth - 1], // 上移1行
                maskValue[(finalDocHeight - 1) * finalDocWidth - 2], // 左上移1个像素
                maskValue[finalDocHeight * finalDocWidth - 3] // 左移2个像素
            ]);
            
            // 检查边界像素是否全为0，判断是否为不完整蒙版
            console.log('🔍 开始执行边界像素检查逻辑');
            let isNotFull = false;
            let originalTopLeft = 0;
            let originalBottomRight = 0;
            
            // 检查第一行是否全为0
            let firstRowAllZero = true;
            let firstRowNonZeroCount = 0;
            for (let x = 0; x < finalDocWidth; x++) {
                if (maskValue[x] !== 0) {
                    firstRowAllZero = false;
                    firstRowNonZeroCount++;
                }
            }
            
            // 检查最后一行是否全为0
            let lastRowAllZero = true;
            let lastRowNonZeroCount = 0;
            const lastRowStart = (finalDocHeight - 1) * finalDocWidth;
            for (let x = 0; x < finalDocWidth; x++) {
                if (maskValue[lastRowStart + x] !== 0) {
                    lastRowAllZero = false;
                    lastRowNonZeroCount++;
                }
            }
            
            // 检查第一列是否全为0
            let firstColAllZero = true;
            let firstColNonZeroCount = 0;
            for (let y = 0; y < finalDocHeight; y++) {
                if (maskValue[y * finalDocWidth] !== 0) {
                    firstColAllZero = false;
                    firstColNonZeroCount++;
                }
            }
            
            // 检查最后一列是否全为0
            let lastColAllZero = true;
            let lastColNonZeroCount = 0;
            for (let y = 0; y < finalDocHeight; y++) {
                if (maskValue[y * finalDocWidth + (finalDocWidth - 1)] !== 0) {
                    lastColAllZero = false;
                    lastColNonZeroCount++;
                }
            }
            
            
            // 如果任一边界全为0，则标记为不完整蒙版
            if (firstRowAllZero || lastRowAllZero || firstColAllZero || lastColAllZero) {
                isNotFull = true;
                console.log('🔍 检测到某条边界像素全为0，标记为不完整蒙版状态');
                
                // 记录左上角和右下角的原始像素值
                originalTopLeft = maskValue[0]; // 第一个像素
                originalBottomRight = maskValue[maskValue.length - 1]; // 最后一个像素
                
                console.log('📝 原始角落像素值 - 左上角:', originalTopLeft, '右下角:', originalBottomRight);
                
                // 将角落像素设为255
                maskValue[0] = 255;
                maskValue[maskValue.length - 1] = 255;
                
            } else {
                console.log('✅ 蒙版完整');
            }
            
            // 释放ImageData内存
            pixels.imageData.dispose();
            
            return {
                quickMaskPixels: maskValue,
                isSelectedAreas: isSelectedAreas,
                isEmpty: maskStatus.isEmpty,  // 添加isEmpty状态信息
                isNotFull: isNotFull,  // 添加不完整蒙版标记
                originalTopLeft: originalTopLeft,  // 原始左上角像素值
                originalBottomRight: originalBottomRight  // 原始右下角像素值
            };
            
        } catch (error) {
            console.error('❌ 获取快速蒙版像素数据失败:', error);
            throw error;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 分析快速蒙版直方图状态
    private static analyzeQuickMaskHistogram(histogram: number[], isSelectedAreas: boolean) {
        let isEmpty = false;
        let isWhite = false;
        
        if (histogram && Array.isArray(histogram)) {
            if (isSelectedAreas) {
                // selectedAreas模式：检查是否为空（只有255色阶有值，且其他色阶都为0）
                let nonZeroCount = 0;
                let totalPixels = 0;
                for (let i = 0; i < 256; i++) {
                    totalPixels += histogram[i];
                    if (i < 255 && histogram[i] > 0) {
                        nonZeroCount++;
                    }
                }
                // 只有当除了255色阶外其他都是0，且255色阶包含了所有像素时，才认为是空
                isEmpty = (nonZeroCount === 0 && histogram[255] === totalPixels && totalPixels > 0);
                console.log('selectedAreas——————快速蒙版为空？', isEmpty);
            } else {
                // 非selectedAreas模式：检查是否为全选（纯白）或空白（纯黑）
                let totalPixels = 0;
                for (let i = 0; i < 256; i++) {
                    totalPixels += histogram[i];
                }
                
                // 检查是否为全选（纯白）：只有255色阶有值
                let nonZeroCountWhite = 0;
                for (let i = 0; i < 255; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCountWhite++;
                    }
                }
                isWhite = (nonZeroCountWhite === 0 && histogram[255] === totalPixels && totalPixels > 0);
                
                // 检查是否为空白（纯黑）：只有0色阶有值
                let nonZeroCountBlack = 0;
                for (let i = 1; i < 256; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCountBlack++;
                    }
                }
                isEmpty = (nonZeroCountBlack === 0 && histogram[0] === totalPixels && totalPixels > 0);
                
                console.log('非selectedAreas模式——————快速蒙版为空？', isEmpty, '    全选？', isWhite);
            }
        }
        
        return { isEmpty, isWhite };
    }

    //-------------------------------------------------------------------------------------------------
    // 撤销快速蒙版
    private static async clearQuickMask() {
       await action.batchPlay([
            {
                _obj: "clearEvent",
                _target: [
                    {
                        _ref: "property",
                        _property: "quickMask"
                    },
                    {
                        _ref: "document",
                        _enum: "ordinal",
                        _value: "targetEnum"
                    }
                ],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true });
    }
     
    //-------------------------------------------------------------------------------------------------
    // 全选操作
    private static async selectAll() {
        await action.batchPlay([
            {
                _obj: "set",
                _target: [
                    {
                        _ref: "channel",
                        _property: "selection"
                    }
                ],
                to: {
                    _enum: "ordinal",
                    _value: "allEnum"
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true });
    }

    //-------------------------------------------------------------------------------------------------
    // 获取图案填充的灰度数据
    private static async getPatternFillGrayData(options: PatternFillOptions, bounds: any): Promise<Uint8Array> {
        try {
            if (!options.pattern.grayData) {
                console.error('缺少图案灰度数据');
                const pixelCount = bounds.selectionPixels
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128); // 默认中灰
                return grayData;
            }
            
            // 优先使用width和height，这些是PatternPicker中设置的当前尺寸
            const patternWidth = options.pattern.width || options.pattern.originalWidth || 100;
            const patternHeight = options.pattern.height || options.pattern.originalHeight || 100;
                
            // 使用当前的缩放和角度设置
            const scale = options.pattern.currentScale || options.pattern.scale || 100;
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            
            // 根据填充模式选择算法
            const fillMode = options.pattern.fillMode || 'tile'; // 默认为贴墙纸模式
            let grayPatternData: Uint8Array;
            
            if (fillMode === 'stamp') {
                // 盖图章模式：图案居中显示，不重复
                console.log('🎯 快速蒙版：使用盖图章模式填充');
                grayPatternData = await createStampPatternData(
                    options.pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    options.pattern.currentAngle || options.pattern.angle || 0,
                    bounds,
                    true // 灰度模式
                );
            } else {
                // 贴墙纸模式：无缝平铺
                console.log('🧱 快速蒙版：使用贴墙纸模式填充，全部旋转:', options.pattern.rotateAll);
                grayPatternData = createTilePatternData(
                    options.pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    options.pattern.currentAngle || options.pattern.angle || 0,
                    options.pattern.rotateAll !== false
                );
            }
            
            if (bounds.selectionPixels && bounds.selectionPixels.size > 0) {
                console.log('🎯 从选区的矩形边界中提取选区内像素');
                const selectionGrayData = new Uint8Array(bounds.selectionPixels.size);
                const selectionPixelsArray = Array.from(bounds.selectionPixels);
                let fillIndex = 0;
                
                // 遍历selectionPixels集合，从完整图案数据中提取对应像素
                for (const docIndex of selectionPixelsArray) {
                    // 将文档索引转换为选区边界内的相对索引
                    const docX = docIndex % bounds.docWidth;
                    const docY = Math.floor(docIndex / bounds.docWidth);
                    
                    // 计算在选区边界内的相对位置
                    const relativeX = docX - bounds.left;
                    const relativeY = docY - bounds.top;
                    
                    // 检查是否在选区边界内
                    if (relativeX >= 0 && relativeX < bounds.width && 
                        relativeY >= 0 && relativeY < bounds.height) {
                        const boundsIndex = relativeY * bounds.width + relativeX;
                        if (boundsIndex < grayPatternData.length) {
                            selectionGrayData[fillIndex] = grayPatternData[boundsIndex];
                        } else {
                            selectionGrayData[fillIndex] = 128; // 默认中灰值
                        }
                    } else {
                        selectionGrayData[fillIndex] = 128; // 边界外默认中灰值
                    }
                    fillIndex++;
                }
                
                console.log('🎯 提取完成，选区内像素数:', selectionGrayData.length);
                return selectionGrayData;
            } else {
                // 没有射线法数据，直接返回完整的选区边界图案数据
                console.log('🎯 返回完整选区边界图案数据，像素数:', grayPatternData.length);
                return grayPatternData;
            }
            
        } catch (error) {
            console.error('获取图案灰度数据失败:', error);
            const pixelCount = bounds.selectionPixels
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128);
            return grayData;
        }
    }

    // 应用混合模式计算最终灰度值（支持混合模式）
    private static async calculateFinalGrayValues(
        maskData: Uint8Array, 
        fillData: Uint8Array, 
        isSelectedAreas: boolean = true, 
        opacity: number = 100,
        blendMode: string = 'normal',
        isEmpty: boolean,
        bounds: any,
        isNotFull: boolean = false,
        originalTopLeft: number = 0,
        originalBottomRight: number = 0
    ): Promise<Uint8Array> {
        console.log('📊 参数状态 - isNotFull:', isNotFull, '    originalTopLeft:', originalTopLeft, '    originalBottomRight:', originalBottomRight);
        
        // maskData现在是完整文档的快速蒙版数据，fillData是选区内图案的数据
        // 需要从maskData中提取出真正在选区内的像素数据
        const selectedMaskData = new Uint8Array(fillData.length);
        
        if (bounds.selectionPixels && bounds.selectionPixels.size > 0) {
            console.log('🎯 从扩充为全文档长度的图案数组中，根据选区索引，精确提取新数组做计算');       
            // 使用Array.from确保兼容性
            const selectionPixelsArray = Array.from(bounds.selectionPixels);
            let fillIndex = 0;
            
            // 遍历selectionPixels集合，提取对应的maskData像素
            for (const docIndex of selectionPixelsArray) {
                if (fillIndex >= selectedMaskData.length) {
                    break;
                }
                
                if (docIndex >= 0 && docIndex < maskData.length) {
                    selectedMaskData[fillIndex] = maskData[docIndex];
                } else {
                    selectedMaskData[fillIndex] = 128; // 默认中灰值
                }
                fillIndex++;
            }
            
            console.log(`📊 提取了 ${fillIndex} 个像素`);
            // 提取的蒙版值
        } else {
            // 回退方式：遍历选区边界内的所有像素
            let fillIndex = 0;
            for (let y = 0; y < bounds.height; y++) {
                for (let x = 0; x < bounds.width; x++) {
                    const targetX = bounds.left + x;
                    const targetY = bounds.top + y;
                    const docIndex = targetY * bounds.docWidth + targetX;
                    
                    if (docIndex < maskData.length && fillIndex < selectedMaskData.length) {
                        selectedMaskData[fillIndex] = maskData[docIndex];
                        fillIndex++;
                    }
                }
            }
        }
        
        // 创建完整文档尺寸的新蒙版数组
        const newMaskValue = new Uint8Array(maskData.length);
        
        // 如果是空白快速蒙版，先将整个数组设为0
        if (isEmpty) {
            newMaskValue.fill(0);
        } else {
            // 否则复制原始maskData作为基础
            newMaskValue.set(maskData);
        }
        
        // 计算选区内的混合结果
        const finalData = new Uint8Array(fillData.length);
        // 分批处理，避免一次性处理过多数据导致栈溢出
        const BATCH_SIZE = 10000; // 每批处理1万个像素
        
        for (let batchStart = 0; batchStart < fillData.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, fillData.length);
            
            await new Promise(resolve => {
                setTimeout(() => {
                    // 使用混合模式计算，selectedMaskValue作为底色，fillValue作为混合色
                    for (let i = batchStart; i < batchEnd; i++) {
                        const selectedMaskValue = selectedMaskData[i];  // 选区内快速蒙版像素值 (0-255) - 底色
                        const fillValue = fillData[i]; // 图案像素值 (0-255) - 混合色
                        
                        if (fillValue === 0) {
                            if (isEmpty) {
                                // 空白快速蒙版：选区内图案外的部分设为0，不参与混合
                                finalData[i] = 0;
                            } else {
                                // 正常情况：保持原始蒙版值
                                finalData[i] = selectedMaskValue;
                            }
                        } else {
                            if (isEmpty) {
                                // 空白快速蒙版特殊处理：只在图案内部进行与纯白背景的混合
                                const adjustedFillValue = Math.round(fillValue * opacity / 100);
                                const blendedValue = applyBlendMode(255, adjustedFillValue, 'normal', 100); // 与纯白背景混合
                                finalData[i] = Math.min(255, Math.max(0, Math.round(blendedValue)));
                            } else {
                                // 正常情况：应用用户指定的混合模式计算
                                const blendedValue = applyBlendMode(selectedMaskValue, fillValue, blendMode, opacity);
                                finalData[i] = Math.min(255, Math.max(0, Math.round(blendedValue)));
                            }
                        }
                    }
                    resolve(void 0);
                }, 0);
            });
        }
        
        // 将计算结果映射回完整文档的newMaskValue中
        if (bounds.selectionPixels && bounds.selectionPixels.size > 0) {
            console.log('🎯 计算完成，将选区内计算结果映射回全文档长度的新蒙版数组');
            // 使用Array.from确保兼容性
            const selectionPixelsArray = Array.from(bounds.selectionPixels);
            let resultIndex = 0;
            let mappedCount = 0;
            
            // 遍历selectionPixels数组，将结果写入对应位置
            for (const docIndex of selectionPixelsArray) {
                if (docIndex < newMaskValue.length && resultIndex < finalData.length) {
                    newMaskValue[docIndex] = finalData[resultIndex];
                    mappedCount++;
                    resultIndex++;
                }
            }
            
            // 验证映射结果
            // 映射验证完成
        } else {
            // 回退方式：按选区边界映射计算结果
            let resultIndex = 0;
            for (let y = 0; y < bounds.height; y++) {
                for (let x = 0; x < bounds.width; x++) {
                    const targetX = bounds.left + x;
                    const targetY = bounds.top + y;
                    const docIndex = targetY * bounds.docWidth + targetX;
                    
                    if (docIndex < newMaskValue.length && resultIndex < finalData.length) {
                        newMaskValue[docIndex] = finalData[resultIndex];
                        resultIndex++;
                    }
                }
            }
        }
        
        // 如果是不完整蒙版，恢复原始角落像素值
        if (isNotFull) {
            console.log('🔄 恢复原始角落像素值');
            newMaskValue[0] = originalTopLeft;  // 恢复左上角像素
            newMaskValue[newMaskValue.length - 1] = originalBottomRight;  // 恢复右下角像素
        }
        
        return newMaskValue;
    }

    // 将计算后的灰度数据写回快速蒙版通道
    private static async updateQuickMaskChannel(grayData: Uint8Array, bounds: any) {
        try {
            console.log('🔄 将选区重新改回快速蒙版');
            
            let documentColorProfile = "Dot Gain 15%"; // 默认值

       
    
            // 使用bounds中已经获取的文档尺寸信息，确保为整数
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);
            
            // 创建完整文档尺寸的ImageData
            const fullOptions = {
                width: finalDocWidth,
                height: finalDocHeight,
                components: 1,
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            const fullImageData = await imaging.createImageDataFromBuffer(grayData, fullOptions);
            
            // 使用putSelection更新整个快速蒙版
            await imaging.putSelection({
                documentID: app.activeDocument.id,
                imageData: fullImageData
            });
            
            fullImageData.dispose();
            
            // 重新进入快速蒙版
            await action.batchPlay([
                {
                _obj: "set",
                _target: [
                    {
                        _ref: "property",
                        _property: "quickMask"
                    },
                    {
                        _ref: "document",
                        _enum: "ordinal",
                        _value: "targetEnum"
                    }
                ],
                _options: {
                    dialogOptions: "dontDisplay"
                }
                }
            ], { synchronousExecution: true });
            
            
        } catch (error) {
            console.error('❌ 更新快速蒙版通道失败:', error);
        }
    }
}