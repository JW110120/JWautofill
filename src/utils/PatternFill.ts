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
    bounds: any
): Promise<Uint8Array> {
    let resultData: Uint8Array;
    
    // 对于灰度数据（components === 1），使用原来的逻辑
    if (components === 1) {
        // 灰度数据直接初始化为透明
        resultData = new Uint8Array(targetWidth * targetHeight * components);
    } else {
        // 对于RGB/RGBA数据，获取目标图层的原始像素数据
        const { app, imaging } = require('photoshop');
        
        try {
            const activeDoc = app.activeDocument;
            const activeLayers = activeDoc.activeLayers;
            
            if (activeLayers.length === 0) {
                throw new Error('没有活动图层');
            }

            // 检查选区是否存在且有效
            if (!bounds || bounds.left >= bounds.right || bounds.top >= bounds.bottom) {
                // 如果选区无效，则创建一个完全透明的背景
                console.log('选区无效或为空，创建透明背景');
                resultData = new Uint8Array(targetWidth * targetHeight * components);
                if (components === 4) {
                    // RGBA格式：设置为完全透明
                    for (let i = 3; i < resultData.length; i += 4) {
                        resultData[i] = 0;
                    }
                } else {
                    // RGB格式：设置为白色（或根据需要调整）
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
            // 仅在确实是获取像素失败时警告，而不是因为没有选区
            if (error.message.includes('grabPixels')) {
                 console.log('无法获取像素（可能因为没有选区），使用默认透明背景。');
            } else {
                 console.warn('获取原始像素数据失败，使用默认背景:', error);
            }

            // 如果获取失败，创建默认透明背景
            resultData = new Uint8Array(targetWidth * targetHeight * components);
            if (components === 4) {
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
                        
                        // 如果是RGBA格式，需要根据alpha通道进行透明度混合
                        if (components === 4) {
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
                            // RGB格式直接复制
                            for (let c = 0; c < components; c++) {
                                resultData[targetIndex + c] = patternData[sourceIndex + c];
                            }
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
                        
                        // 如果是RGBA格式，需要根据alpha通道进行透明度混合
                        if (components === 4) {
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
                            // RGB格式直接复制
                            for (let c = 0; c < components; c++) {
                                resultData[targetIndex + c] = patternData[sourceIndex + c];
                            }
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
    console.log('🔄 贴墙纸模式参数:', { angle, rotateAll, targetWidth, targetHeight, scaledPatternWidth, scaledPatternHeight });
    
    // 创建最终结果数据
    const resultData = new Uint8Array(targetWidth * targetHeight * components);
    
    if (angle === 0) {
        // 无旋转的情况，直接平铺
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                const patternX = Math.floor((x % scaledPatternWidth) * patternWidth / scaledPatternWidth);
                const patternY = Math.floor((y % scaledPatternHeight) * patternHeight / scaledPatternHeight);
                
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
        
        // 为了解决旋转时的边界问题，创建一个更大的平铺区域
        const diagonal = Math.sqrt(targetWidth * targetWidth + targetHeight * targetHeight);
        const expandedSize = Math.ceil(diagonal * 1.2); // 减少扩展倍数，避免过度扩展
        
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
                
                // 使用连续平铺逻辑，确保无缝衔接
                const tileX = ((targetX % scaledPatternWidth) + scaledPatternWidth) % scaledPatternWidth;
                const tileY = ((targetY % scaledPatternHeight) + scaledPatternHeight) % scaledPatternHeight;
                
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
                
                // 检查是否在原始图案范围内
                if (originalX >= 0 && originalX < scaledPatternWidth && 
                    originalY >= 0 && originalY < scaledPatternHeight) {
                    
                    // 映射到原始图案像素
                    const sourceX = Math.floor(originalX * patternWidth / scaledPatternWidth);
                    const sourceY = Math.floor(originalY * patternHeight / scaledPatternHeight);
                    
                    if (sourceX >= 0 && sourceX < patternWidth && 
                        sourceY >= 0 && sourceY < patternHeight) {
                        const sourceIndex = (sourceY * patternWidth + sourceX) * components;
                        
                        for (let c = 0; c < components; c++) {
                            rotatedPatternData[targetIndex + c] = patternData[sourceIndex + c];
                        }
                    }
                }
                // 如果不在范围内，保持透明（默认为0）
            }
        }
        
        // 使用旋转后的图案进行无缝平铺
        console.log(`🔄 开始平铺旋转后的图案，尺寸: ${rotatedWidth}x${rotatedHeight}`);
        
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                const targetIndex = (y * targetWidth + x) * components;
                
                // 计算在旋转后图案中的位置（确保无缝平铺）
                const tileX = ((x % rotatedWidth) + rotatedWidth) % rotatedWidth;
                const tileY = ((y % rotatedHeight) + rotatedHeight) % rotatedHeight;
                
                const sourceIndex = (tileY * rotatedWidth + tileX) * components;
                
                // 检查源索引是否有效
                if (sourceIndex >= 0 && sourceIndex < rotatedPatternData.length - components + 1) {
                    for (let c = 0; c < components; c++) {
                        resultData[targetIndex + c] = rotatedPatternData[sourceIndex + c];
                    }
                } else {
                    // 如果索引无效，使用透明像素
                    for (let c = 0; c < components; c++) {
                        resultData[targetIndex + c] = c === 3 ? 0 : 255; // 透明或白色
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
        
        console.log('🎨 图案填充开始，组件数:', components);

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
                components: components,
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
            
            console.log('🔄 图案数据生成完成:', {
                patternDataLength: patternData.length,
                expectedLength: selectionWidth * selectionHeight * components,
                samplePatternPixels: Array.from(patternData.slice(0, 12)),
                components: components
            });
            
            // 创建ImageData对象
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
                grayPatternData = await createStampPatternData(
                    options.pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    selectionWidth,
                    selectionHeight,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    options.pattern.currentAngle || options.pattern.angle || 0,
                    bounds
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