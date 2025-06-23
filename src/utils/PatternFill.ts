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
    bounds: any
): Promise<Uint8Array> {
    let resultData: Uint8Array;
    
    // 对于灰度数据（components === 1），获取原始快速蒙版数据作为背景
    if (components === 1) {
        // 获取原始快速蒙版数据作为背景，保持图案外部区域的原始maskValue不变
        try {
            const { app, imaging } = require('photoshop');
            const maskData = await imaging.getSelection({
                documentID: app.activeDocument.id,
                sourceBounds: {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom
                },
                targetSize: {
                    width: targetWidth,
                    height: targetHeight
                },
            });
            
            const maskDataArray = await maskData.imageData.getData();
            resultData = new Uint8Array(maskDataArray);
            maskData.imageData.dispose();
            
            console.log('✅ 成功获取原始快速蒙版数据作为背景，长度:', resultData.length);
        } catch (error) {
            console.warn('⚠️ 获取原始快速蒙版数据失败，使用默认背景:', error);
            // 如果获取失败，初始化为中灰色（128）而不是全黑（0）
            resultData = new Uint8Array(targetWidth * targetHeight * components);
            resultData.fill(128);
        }
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
    // 快速蒙版状态下的直接填充（支持混合模式和不透明度）
    private static async fillPatternDirect(options: PatternFillOptions) {
        try {
            console.log('🎨 开始快速蒙版图案填充，混合模式:', options.blendMode, '不透明度:', options.opacity);
            
            // 获取当前选区边界信息
            const selectionBounds = await this.getSelectionBounds();
            if (!selectionBounds) {
                console.warn('❌ 没有选区，无法执行快速蒙版图案填充操作');
                return;
            }

            // 获取快速蒙版通道的像素数据和colorIndicates信息
            const { quickMaskPixels, isSelectedAreas } = await this.getQuickMaskPixels(selectionBounds);
            
            // 获取图案填充的灰度数据
            const fillGrayData = await this.getPatternFillGrayData(options, selectionBounds);
            
            // 应用混合模式计算最终灰度值
            const finalGrayData = await this.calculateFinalGrayValues(
                quickMaskPixels, 
                fillGrayData, 
                isSelectedAreas, 
                options.opacity,
                options.blendMode
            );
            
            // 将计算后的灰度数据写回快速蒙版通道
            await this.updateQuickMaskChannel(finalGrayData, selectionBounds);
            
            console.log("✅ 快速蒙版图案填充完成");
        } catch (error) {
            console.error("❌ 快速蒙版图案填充失败:", error);
            throw error;
        }
    }

    // 获取选区边界信息（参考ClearHandler的实现）
    private static async getSelectionBounds() {
        try {
            // 获取文档信息和选区信息
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
            
            // 步骤1: 将选区转换为路径
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
            
            // 步骤3: 将路径重新转回选区
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
                        _ref: "path",
                        _property: "workPath"
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
            // 步骤4: 删除工作路径
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
            
            console.log('📐 文档尺寸转换:', {
                原始尺寸: { width: docWidth, height: docHeight, unit: docResult[0].width._unit },
                分辨率: resolution,
                转换后像素: { docWidthPixels, docHeightPixels }
            });
            
            // 获取选区边界
            const bounds = selectionResult[0].selection;
            const left = Math.round(bounds.left._value);
            const top = Math.round(bounds.top._value);
            const right = Math.round(bounds.right._value);
            const bottom = Math.round(bounds.bottom._value);
            const width = right - left;
            const height = bottom - top;
            
            console.log('📏 选区边界信息:', { left, top, right, bottom, width, height });
            console.log('📄 文档尺寸(像素):', { docWidthPixels, docHeightPixels });
            
            // 使用射线法计算选区内的像素（传入正确的像素单位）
            const selectionPixels = await this.getPixelsInPolygon(pathPoints, left, top, right, bottom, docWidthPixels);
            
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
    private static async getPixelsInPolygon(polygonPoints: Array<{x: number, y: number}>, left: number, top: number, right: number, bottom: number, docWidth: number): Promise<Set<number>> {
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
                    this.processBatchPixels(polygonPoints, startX, endX, batchStartY, batchEndY, docWidth, selectionPixels);
                    resolve(void 0);
                }, 0);
            });
        }
        
        console.log('🎯 射线法计算完成，选区内像素数量:', selectionPixels.size);
        return selectionPixels;
    }
    
    // 分批处理像素，避免栈溢出
    private static processBatchPixels(polygonPoints: Array<{x: number, y: number}>, startX: number, endX: number, startY: number, endY: number, docWidth: number, selectionPixels: Set<number>) {
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                if (this.isPointInPolygon(x, y, polygonPoints)) {
                    // 计算像素在整个文档数组中的位置：docWidth * (y - 1) + x
                    const pixelIndex = docWidth * (y - 1) + x;
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
            
            console.log('📊 快速蒙版通道信息:', channelResult);

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
            const maskStatus = this.analyzeQuickMaskHistogram(histogram, isSelectedAreas);
            
            if (maskStatus.isEmpty) {
                await core.showAlert({ message: '您的快速蒙版已经为空！' });
                console.log('⚠️ 检测到快速蒙版为空，跳过特殊处理流程');
                const pixelCount = bounds.width * bounds.height;
                return {
                    quickMaskPixels: new Uint8Array(pixelCount),
                    isSelectedAreas: isSelectedAreas
                };
            }
            
            // 撤销快速蒙版
            await this.clearQuickMask();
            
            // 如果是纯白快速蒙版（非selectedAreas模式下），需要执行全选操作
            if (!isSelectedAreas && maskStatus.isWhite) {
                await this.selectAll();
            }

            // 通过Imaging API获取选区的黑白信息
            const pixels = await imaging.getSelection({
                documentID: app.activeDocument.id,
                sourceBounds: {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom
                },
                targetSize: {
                    width: bounds.width,
                    height: bounds.height
                },
            });
            
            const selectionData = await pixels.imageData.getData();
            console.log('✅ 成功获取选区像素数据，数据类型:', selectionData.constructor.name, '长度:', selectionData.length);
            
            // 根据获取的选区信息构建MaskValue数组
            const pixelCount = bounds.width * bounds.height;
            const maskValue = new Uint8Array(pixelCount);
            
            // 处理选区数据，转换为maskValue数组
            if (selectionData.length === pixelCount) {
                for (let i = 0; i < pixelCount; i++) {
                    maskValue[i] = 255 - selectionData[i];
                }
            } else {
                console.warn('⚠️ getSelection应该只返回单通道数据，实际数据长度:', selectionData.length, '预期:', pixelCount);
                // 按单通道处理，取第一个字节
                for (let i = 0; i < pixelCount; i++) {
                    const index = Math.min(i, selectionData.length - 1);
                    maskValue[i] = 255 - selectionData[index];
                }
            }
            
            return {
                quickMaskPixels: maskValue,
                isSelectedAreas: isSelectedAreas
            };
            
        } catch (error) {
            console.error('❌ 获取快速蒙版像素数据失败:', error);
            throw error;
        }
    }
    
    // 分析快速蒙版直方图状态
    private static analyzeQuickMaskHistogram(histogram: number[], isSelectedAreas: boolean) {
        let isEmpty = false;
        let isWhite = false;
        
        if (histogram && Array.isArray(histogram)) {
            if (isSelectedAreas) {
                // selectedAreas模式：检查是否为空（除了255色阶外其他都是0）
                let nonZeroCount = 0;
                for (let i = 0; i < 255; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCount++;
                    }
                }
                isEmpty = (nonZeroCount === 0 && histogram[255] > 0);
                console.log('📊 selectedAreas模式 - 快速蒙版为空？', isEmpty);
            } else {
                // 非selectedAreas模式：检查是否为全选（纯白）或空白（纯黑）
                let nonZeroCountWhite = 0;
                for (let i = 0; i < 255; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCountWhite++;
                    }
                }
                isWhite = (nonZeroCountWhite === 0 && histogram[255] > 0);
                
                let nonZeroCount = 0;
                for (let i = 1; i < 256; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCount++;
                    }
                }
                isEmpty = (nonZeroCount === 0 && histogram[0] > 0);
                
                console.log('📊 非selectedAreas模式 - 快速蒙版为空？', isEmpty, '纯白？', isWhite);
            }
        }
        
        return { isEmpty, isWhite };
    }

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

    // 获取图案填充的灰度数据
    private static async getPatternFillGrayData(options: PatternFillOptions, bounds: any): Promise<Uint8Array> {
        try {
            if (!options.pattern.grayData) {
                console.error('缺少图案灰度数据');
                const pixelCount = bounds.width * bounds.height;
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128); // 默认中灰
                return grayData;
            }
            
            // 安全地获取图案尺寸
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
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    options.pattern.currentAngle || options.pattern.angle || 0,
                    options.pattern.rotateAll !== false
                );
            }
            
            return grayPatternData;
            
        } catch (error) {
            console.error('获取图案灰度数据失败:', error);
            const pixelCount = bounds.width * bounds.height;
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
        blendMode: string = 'normal'
    ): Promise<Uint8Array> {
        console.log('🔍 开始混合计算（支持混合模式）:', {
            maskDataLength: maskData.length,
            fillDataLength: fillData.length,
            isSelectedAreas: isSelectedAreas,
            blendMode: blendMode,
            opacity: opacity
        });
        
        const finalData = new Uint8Array(maskData.length);
        
        // 优化：计算fillData统计信息时避免使用扩展运算符
        let fillMin = 255, fillMax = 0, fillSum = 0;
        for (let i = 0; i < fillData.length; i++) {
            const val = fillData[i];
            if (val < fillMin) fillMin = val;
            if (val > fillMax) fillMax = val;
            fillSum += val;
        }
        
        const fillStats = {
            min: fillMin,
            max: fillMax,
            avg: fillSum / fillData.length,
        };
        
        console.log('📊 fillData统计信息:', fillStats);
        console.log('🔍 混合计算样本数据 (前10个像素):');
        
        // 分批处理，避免一次性处理过多数据导致栈溢出
        const BATCH_SIZE = 10000; // 每批处理1万个像素
        
        for (let batchStart = 0; batchStart < maskData.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, maskData.length);
            
            await new Promise(resolve => {
                setTimeout(() => {
                    // 使用混合模式计算，maskValue作为底色，fillValue作为混合色
                    for (let i = batchStart; i < batchEnd; i++) {
                        const maskValue = maskData[i];  // 快速蒙版像素值 (0-255) - 底色
                        
                        // 安全获取fillValue，如果超出范围则使用默认值128
                        const fillValue = i < fillData.length ? fillData[i] : 128; // 图案像素值 (0-255) - 混合色
                        
                        // 应用混合模式计算
                        const blendedValue = applyBlendMode(maskValue, fillValue, blendMode, opacity);
                        finalData[i] = Math.min(255, Math.max(0, Math.round(blendedValue)));
                        
                        // 输出前10个像素的详细信息
                        if (i < 10) {
                            console.log(`像素 ${i} (${isSelectedAreas ? 'selectedAreas' : '非selectedAreas'}): maskValue=${maskValue}, fillValue=${fillValue}, blendMode=${blendMode}, finalValue=${blendedValue.toFixed(2)}`);
                        }
                    }
                    resolve(void 0);
                }, 0);
            });
        }
        
        console.log('✅ 混合计算完成，最终数据长度:', finalData.length);
        return finalData;
    }

    // 将计算后的灰度数据写回快速蒙版通道
    private static async updateQuickMaskChannel(grayData: Uint8Array, bounds: any) {
        try {
            console.log('🔄 开始更新快速蒙版通道');
            
            let documentColorProfile = "Dot Gain 15%"; // 默认值
            
            // 创建计算后的Grayscale数据
            const options = {
                width: bounds.width,
                height: bounds.height,
                components: 1,  
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            const grayscaleData = new Uint8Array(bounds.width * bounds.height);
            for (let i = 0; i < grayData.length; i++) {
                grayscaleData[i] = grayData[i]; 
            }

            // 使用bounds中已经获取的文档尺寸信息，确保为整数
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);
            
            console.log('📄 使用已获取的文档尺寸(像素):', finalDocWidth, 'x', finalDocHeight);
            
            // 验证文档尺寸的有效性
            if (finalDocWidth <= 0 || finalDocHeight <= 0) {
                throw new Error(`无效的文档尺寸: ${finalDocWidth}x${finalDocHeight}`);
            }
            
            // 获取当前快速蒙版的完整数据
            console.log('🔍 准备获取快速蒙版数据，sourceBounds:', {
                left: 0,
                top: 0,
                right: finalDocWidth,
                bottom: finalDocHeight
            });
            
            const fullMaskData = await imaging.getSelection({
                documentID: app.activeDocument.id,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: finalDocWidth,
                    bottom: finalDocHeight
                },
                targetSize: {
                    width: finalDocWidth,
                    height: finalDocHeight
                },
                componentSize: 8,
                colorProfile: "Dot Gain 15%"
            });
            
            const fullMaskDataArray = await fullMaskData.imageData.getData();
            const fullMaskArray = new Uint8Array(fullMaskDataArray);
            console.log('📊 获取完整快速蒙版数据，长度:', fullMaskArray.length);
            
            // 根据射线法计算的选区内像素来更新数据
            if (bounds.selectionPixels && bounds.selectionPixels.size > 0) {
                console.log('🎯 使用射线法计算的选区像素进行精确更新');
                // 遍历选区边界内的每个像素
                for (let y = 0; y < bounds.height; y++) {
                    for (let x = 0; x < bounds.width; x++) {
                        const sourceIndex = y * bounds.width + x;
                        const targetX = bounds.left + x;
                        const targetY = bounds.top + y;
                        const targetIndex = targetY * finalDocWidth + targetX;
                        
                        // 检查该像素是否在射线法计算的选区内
                        if (bounds.selectionPixels.has(targetIndex) && 
                            targetIndex < fullMaskArray.length && 
                            sourceIndex < grayscaleData.length) {
                            fullMaskArray[targetIndex] = grayscaleData[sourceIndex];
                        }
                    }
                }
            } else {
                console.log('📦 直接更新选区边界内的所有像素');
                // 回退方式：直接更新选区边界内的所有像素
                for (let y = 0; y < bounds.height; y++) {
                    for (let x = 0; x < bounds.width; x++) {
                        const sourceIndex = y * bounds.width + x;
                        const targetX = bounds.left + x;
                        const targetY = bounds.top + y;
                        const targetIndex = targetY * finalDocWidth + targetX;
                        
                        // 更新边界内的所有像素
                        if (targetIndex < fullMaskArray.length && 
                            sourceIndex < grayscaleData.length) {
                            fullMaskArray[targetIndex] = grayscaleData[sourceIndex];
                        }
                    }
                }
            }
            
            // 创建完整文档尺寸的ImageData
            const fullOptions = {
                width: finalDocWidth,
                height: finalDocHeight,
                components: 1,
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            const fullImageData = await imaging.createImageDataFromBuffer(fullMaskArray, fullOptions);
            
            // 使用putSelection更新整个快速蒙版
            await imaging.putSelection({
                documentID: app.activeDocument.id,
                imageData: fullImageData
            });
            
            fullMaskData.imageData.dispose();
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
            
            console.log('✅ 已重新进入快速蒙版');
            
        } catch (error) {
            console.error('❌ 更新快速蒙版通道失败:', error);
        }
    }
}