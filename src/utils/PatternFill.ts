import { app, action, imaging } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Pattern } from '../types/state';
import { BLEND_MODE_CALCULATIONS, BlendModeFunction } from './BlendModeCalculations';

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
    isGrayMode: boolean = false,
    generateAlphaData: boolean = false,
    backgroundChannelData?: Uint8Array // 新增：原始背景通道数据，用于单通道填充
): Promise<{ colorData: Uint8Array; alphaData?: Uint8Array; patternMask?: Uint8Array }> {
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
                // 单通道模式：使用传入的原始通道数据作为背景，否则填充为0
                if (backgroundChannelData) {
                    for (let y = 0; y < targetHeight; y++) {
                        for (let x = 0; x < targetWidth; x++) {
                            const docIndex = (bounds.top + y) * bounds.docWidth + (bounds.left + x);
                            const targetIndex = y * targetWidth + x;
                            resultData[targetIndex] = docIndex < backgroundChannelData.length ? backgroundChannelData[docIndex] : 0;
                        }
                    }
                } else {
                    resultData.fill(0);
                }
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

                if (isGrayMode && backgroundChannelData) {
                    // 单通道模式：使用传入的原始通道数据作为背景
                    console.log('使用传入的原始通道数据作为背景（有效选区）');
                    for (let y = 0; y < targetHeight; y++) {
                        for (let x = 0; x < targetWidth; x++) {
                            const docX = bounds.left + x;
                            const docY = bounds.top + y;
                            const docIndex = docY * bounds.docWidth + docX;
                            const targetIndex = y * targetWidth + x;
                            
                            if (docIndex >= 0 && docIndex < backgroundChannelData.length) {
                                resultData[targetIndex] = backgroundChannelData[docIndex];
                            } else {
                                resultData[targetIndex] = 0; // 超出范围时使用默认值
                            }
                        }
                    }
                } else if (components === 4) { // 图案是 RGBA
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
            if (backgroundChannelData) {
                // 单通道模式：使用传入的原始通道数据作为背景
                console.log('获取像素失败，使用传入的原始通道数据作为背景');
                for (let y = 0; y < targetHeight; y++) {
                    for (let x = 0; x < targetWidth; x++) {
                        const docX = bounds.left + x;
                        const docY = bounds.top + y;
                        const docIndex = docY * bounds.docWidth + docX;
                        const targetIndex = y * targetWidth + x;
                        
                        if (docIndex >= 0 && docIndex < backgroundChannelData.length) {
                            resultData[targetIndex] = backgroundChannelData[docIndex];
                        } else {
                            resultData[targetIndex] = 0; // 超出范围时使用默认值
                        }
                    }
                }
            } else {
                // 传统灰度模式：背景设置为0（黑色）
                resultData.fill(0);
            }
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
    
    // 选区中心
    const selectionCenterX = targetWidth / 2;
    const selectionCenterY = targetHeight / 2;
    // 使用选区中心作为旋转中心（这样图案会围绕选区中心旋转）
    const centerX = selectionCenterX;
    const centerY = selectionCenterY;
    
    // 像素混合处理函数
    const blendPixel = (sourceIndex: number, targetIndex: number) => {
        if (isGrayMode) {
            // 灰度模式：只有在图案内部才覆盖，图案外区域保持背景值
            // 这里targetIndex是单通道索引，不需要乘以components
            resultData[targetIndex] = patternData[sourceIndex];
        } else {
            // 直接复制图案像素数据，保持原始透明度信息
            // 这样可以确保PNG图案的透明度信息得到完整保留
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

    // 创建图案掩码数组，标记哪些区域是图案内的
    const patternMask = new Uint8Array(targetWidth * targetHeight);
    
    // 主循环：遍历目标区域的每个像素（优化版本）
    for (let y = 0; y < targetHeight; y++) {
        const rowOffset = y * targetWidth;
        for (let x = 0; x < targetWidth; x++) {
            const maskIndex = rowOffset + x;
            const sourceIndex = getPatternPixel(x, y);
            
            if (sourceIndex >= 0) {
                // 根据模式计算正确的targetIndex
                const targetIndex = isGrayMode ? maskIndex : maskIndex * components;
                blendPixel(sourceIndex, targetIndex);
                patternMask[maskIndex] = 255; // 标记为图案内
            }
            // 图案外区域保持原始背景值，无需显式设置
        }
    }
    
    // 如果需要生成透明度数据，创建对应的alpha数组
    let alphaData: Uint8Array | undefined;
    if (generateAlphaData && components === 4) {
        alphaData = new Uint8Array(targetWidth * targetHeight);
        
        // 提取alpha通道数据
        for (let i = 0; i < targetWidth * targetHeight; i++) {
            const sourceIndex = i * components;
            alphaData[i] = resultData[sourceIndex + 3] || 0;
        }
    }
    
    return { colorData: resultData, alphaData, patternMask };
}

// 贴墙纸模式：无缝平铺，解决旋转边界问题，同时生成透明度数据
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
    bounds?: any,  // 添加bounds参数以支持全局坐标平铺
    generateAlphaData: boolean = false  // 是否生成透明度数据
): { colorData: Uint8Array; alphaData?: Uint8Array } {
    
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
        
        // 如果需要生成透明度数据，创建对应的alpha数组
        let alphaData: Uint8Array | undefined;
        if (generateAlphaData && components === 4) {
            alphaData = new Uint8Array(targetWidth * targetHeight);
            
            // 提取alpha通道数据
            for (let i = 0; i < targetWidth * targetHeight; i++) {
                const sourceIndex = i * components;
                alphaData[i] = resultData[sourceIndex + 3] || 0;
            }
        }
        
        return { colorData: resultData, alphaData };
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
    
    // 如果需要生成透明度数据，创建对应的alpha数组
    let alphaData: Uint8Array | undefined;
    if (generateAlphaData && components === 4) {
        alphaData = new Uint8Array(targetWidth * targetHeight);
        
        // 提取alpha通道数据
        for (let i = 0; i < targetWidth * targetHeight; i++) {
            const sourceIndex = i * components;
            alphaData[i] = resultData[sourceIndex + 3] || 0;
        }
    }
    
    return { colorData: resultData, alphaData };
}



interface LayerInfo {
    hasPixels: boolean;
    isInQuickMask: boolean;
    isInLayerMask: boolean;
}

// 收集左上角和右下角像素的值，并且做处理
async function getPixelValue(action: any, x: number, y: number): Promise<number> {
    // 选择指定坐标的1x1像素区域
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
                _obj: "rectangle",
                top: {
                    _unit: "pixelsUnit",
                    _value: y
                },
                left: {
                    _unit: "pixelsUnit",
                    _value: x
                },
                bottom: {
                    _unit: "pixelsUnit",
                    _value: y + 1
                },
                right: {
                    _unit: "pixelsUnit",
                    _value: x + 1
                }
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        }
    ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

    // 获取像素的直方图
    const result = await action.batchPlay([
        {
            _obj: "get",
            _target: [
                {
                    _ref: "channel",
                    _name: "快速蒙版"
                }
            ]
        }
    ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
    
    // 分析直方图找出数量为1的色阶值
    const histogram = result[0].histogram;
    const pixelValue = histogram.findIndex(count => count === 1);
    console.log(`坐标(${x}, ${y})的像素值：`, pixelValue);

    return pixelValue;
}


// ---------------------------------------------------------------------------------------------------
export class PatternFill {
    // ---------------------------------------------------------------------------------------------------
    // 1.不在快速蒙版中，根据用户指定条件填充相应的彩色图案。（RGB/RGBA）
    static async fillPattern(options: PatternFillOptions, layerInfo: LayerInfo, state?: any) {
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
            await this.fillPatternDirect(options, state);
            return;
        } else if (layerInfo.isInLayerMask) {
            // 如果在普通图层蒙版状态，使用图层蒙版填充
            console.log('🎭 当前在图层蒙版状态，使用图层蒙版填充方法');
            await this.fillLayerMaskPattern(options, state);
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
                const stampResult = await createStampPatternData(
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
                patternData = stampResult.colorData;
            } else {
                // 贴墙纸模式：无缝平铺
                console.log('🧱 使用贴墙纸模式填充');
                const tileResult = createTilePatternData(
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
                patternData = tileResult.colorData;
            }
            
            // 创建ImageData对象，准备填充
            // UXP imaging 仅接受诸如 'RGB'/'CMYK'/'Grayscale' 等颜色空间，
            // 不支持 'RGBA'。当包含 alpha 时仍需使用 'RGB'，并通过 components=4 携带透明度。
            // 为避免 Invalid colorSpace 错误，这里统一设置为 'RGB'。
            const safeComponents = (components === 4 || components === 3) ? components : 3;
            const imageDataOptions = {
                width: selectionWidth,
                height: selectionHeight,
                components: safeComponents,
                chunky: true,
                colorProfile: "sRGB IEC61966-2.1",
                colorSpace: 'RGB'
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
            await action.batchPlay([createBlankLayer], { dialogOptions: 'dontDisplayDialogs' });
            await action.batchPlay([setLayerName], { dialogOptions: 'dontDisplayDialogs' });
            await action.batchPlay([createLayerMask], { dialogOptions: 'dontDisplayDialogs' });

            
            // 填充图案数据
            await fillPatternData();
            
            // 设置图层属性
            await action.batchPlay([setLayerProperties], { dialogOptions: 'dontDisplayDialogs' });
            
            // 根据checkbox信息是否创建剪贴蒙版。
            if (options.preserveTransparency) {
                await action.batchPlay([createClippingMask], { dialogOptions: 'dontDisplayDialogs' });
            }
            

            await action.batchPlay([applyMask], { dialogOptions: 'dontDisplayDialogs' });
            await action.batchPlay([mergeLayers], { dialogOptions: 'dontDisplayDialogs' });


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
            }], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

            console.log("✅ 图案填充完成");
        } catch (error) {
            console.error("❌ 执行图案填充时发生错误:", error);
        }
    }

    // ---------------------------------------------------------------------------------------------------
    // 2.不在快速蒙版中，图层蒙版模式下的图案填充
    private static async fillLayerMaskPattern(options: PatternFillOptions, state?: any): Promise<void> {
        try {
            console.log('🎭 开始图层蒙版图案填充');
            
            // 第一步：获取选区信息
            // 获取当前激活图层ID
            const currentLayerId = await this.getCurrentLayerId();
            const bounds = await this.getSelectionData();
            if (!bounds) {
                console.error('❌ 无法获取选区信息');
                return;
            }
            
            console.log('✅ 获取选区信息成功:', {
                selectionPixelsCount: bounds.selectionDocIndices.size
            });
            
            // 第二步：获取普通蒙版信息
            const layerMaskData = await this.getLayerMaskPixels(bounds, currentLayerId);
            if (!layerMaskData) {
                console.error('❌ 无法获取图层蒙版信息');
                return;
            }
            
            
            // 第三步：获取图案信息
            const patternGrayData = await this.getPatternFillGrayData(options, bounds);
            
            
            // 第四步：混合计算
            const blendedData = await this.blendLayerMaskWithPatternArray(
                layerMaskData.maskPixels,
                patternGrayData,
                options,
                bounds
            );
            
            // 第五步：写回文档
            await this.writeLayerMaskData(blendedData, bounds, currentLayerId, layerMaskData.fullDocMaskArray, state);
            
            console.log('✅ 图层蒙版图案填充完成');
            
        } catch (error) {
            console.error('❌ 图层蒙版图案填充失败:', error);
            throw error;
        }
    }

     // 获取当前激活图层ID
    private static async getCurrentLayerId(): Promise<number> {
        try {
            const layerResult = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "layer",
                            _enum: "ordinal",
                            _value: "targetEnum"
                        }
                    ]
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
            console.log('✅ 获取当前激活图层ID:', layerResult[0].layerID);
            return layerResult[0].layerID;
        } catch (error) {
            console.error('❌ 获取当前激活图层ID失败:', error);
            throw error;
        }
    }
    

    // 获取图层蒙版通道的像素数据
    private static async getLayerMaskPixels(bounds: any, currentLayerId: number) {
        try {             
            console.log('🎭 开始获取图层蒙版数据，图层ID:', currentLayerId);
            
            // 根据官方文档，使用getLayerMask获取完整文档的图层蒙版像素数据
            // 添加sourceBounds参数以符合API规范
            const pixels = await imaging.getLayerMask({
                documentID: app.activeDocument.id,
                layerID: currentLayerId,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: bounds.docWidth,
                    bottom: bounds.docHeight
                },
                componentSize: 8
            });
            
            const fullDocMaskArray = await pixels.imageData.getData();
            console.log('🎯 完整文档蒙版数组长度:', fullDocMaskArray.length);
            
            // 从完整文档长度的蒙版数组中按照索引提取选区内的蒙版像素数据
            const selectionSize = bounds.selectionDocIndices.size;
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            
            // 提取选区内的图层蒙版值并计算统计信息
            const selectionMaskValues = [];
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                if (docIndex >= 0 && docIndex < fullDocMaskArray.length) {
                    selectionMaskValues.push(fullDocMaskArray[docIndex]);
                }
            }
            
            let minVal = 255, maxVal = 0, zeroCount = 0, fullCount = 0;
            for (const val of selectionMaskValues) {
                minVal = Math.min(minVal, val);
                maxVal = Math.max(maxVal, val);
                if (val === 0) zeroCount++;
                if (val === 255) fullCount++;
            }
            console.log('🎯 选区内图层蒙版值统计: 最小值=', minVal, '最大值=', maxVal, '黑色像素=', zeroCount, '白色像素=', fullCount);
            
            const maskPixels = new Uint8Array(selectionSize);
            console.log('🎯 选区索引数量:', selectionIndices.length, '第一个索引:', selectionIndices[0], '最后一个索引:', selectionIndices[selectionIndices.length - 1]);
            
            let outOfRangeCount = 0;
            // 遍历选区内的每个像素，从完整文档蒙版数组中提取对应的值
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                if (docIndex >= 0 && docIndex < fullDocMaskArray.length) {
                    maskPixels[i] = fullDocMaskArray[docIndex];
                } else {
                    outOfRangeCount++;
                    maskPixels[i] = fullDocMaskArray[docIndex] || 0; // 保持原始像素值或默认黑色
                }
                
                // 只输出前3个像素的提取过程
                if (i < 3) {
                    console.log(`🎯 提取像素${i}: 文档索引=${docIndex}, 蒙版值=${maskPixels[i]}`);
                }
            }
            
            if (outOfRangeCount > 0) {
                console.warn(`⚠️ ${outOfRangeCount}个索引超出范围，使用默认值255`);
            }
            
            // 计算提取数据的统计信息
            let extractedMin = 255, extractedMax = 0;
            for (let i = 0; i < Math.min(100, maskPixels.length); i++) {
                extractedMin = Math.min(extractedMin, maskPixels[i]);
                extractedMax = Math.max(extractedMax, maskPixels[i]);
            }
            
            console.log('🎯 图层蒙版选区内像素数量:', selectionSize);
            console.log('🎯 提取的蒙版数据统计: 最小值=', extractedMin, '最大值=', extractedMax);
            
            // 释放ImageData内存
            pixels.imageData.dispose();
            
            return {
                maskPixels: maskPixels,
                fullDocMaskArray: fullDocMaskArray
            };
            
        } catch (error) {
            console.error('❌ 获取图层蒙版像素数据失败:', error);
            throw error;
        }
    }

      
   // ---------------------------------------------------------------------------------------------------
   // 图层蒙版混合模式计算
    private static getBlendModeCalculation(blendMode: string): BlendModeFunction {
        return BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
    }

    private static applyBlendMode(
        baseValue: number,
        blendValue: number,
        blendMode: string,
        opacity: number = 100
    ): number {
        const blendFunction = this.getBlendModeCalculation(blendMode);
        const blendedValue = blendFunction(baseValue, blendValue);
        
        // 应用不透明度
        const opacityFactor = Math.max(0, Math.min(100, opacity)) / 100;
        return Math.round(baseValue + (blendedValue - baseValue) * opacityFactor);
    }

    private static blendLayerMaskWithPattern(
        maskValue: number,
        patternValue: number,
        patternAlpha: number,
        blendMode: string,
        opacity: number = 100,
        isLayerMaskMode: boolean = false,
        isPatternArea: boolean = true
    ): number {
        // 如果图案完全透明，直接返回原始蒙版值
        if (patternAlpha === 0) {
            return maskValue;
        }
        
        // 图层蒙版模式下的特殊处理：如果是图案外区域，保持原始蒙版值
        if (isLayerMaskMode && !isPatternArea) {
            return maskValue;
        }
        
        // 应用混合模式计算，图层蒙版作为base，图案作为blend
        const blendFunction = this.getBlendModeCalculation(blendMode);
        const blendedValue = blendFunction(maskValue, patternValue);
        
        // 应用图案不透明度和整体不透明度
        // 确保alpha值在0-255范围内，opacity值在0-100范围内
        const normalizedAlpha = Math.max(0, Math.min(255, patternAlpha)) / 255;
        const normalizedOpacity = Math.max(0, Math.min(100, opacity)) / 100;
        
        // 计算综合透明度因子：先应用不透明度，再应用alpha透明度
        const combinedOpacity = normalizedOpacity * normalizedAlpha;
        
        // 使用标准混合公式：result = base + (blend - base) * opacity
        const finalValue = maskValue + (blendedValue - maskValue) * combinedOpacity;
        
        return Math.round(Math.max(0, Math.min(255, finalValue)));
    }

    // 混合图层蒙版与图案数据
    private static async blendLayerMaskWithPatternArray(
        maskPixels: Uint8Array,
        patternGrayData: Uint8Array,
        options: PatternFillOptions,
        bounds: any
    ): Promise<Uint8Array> {
        const result = new Uint8Array(maskPixels.length);
        
        console.log('🔄 开始混合计算，像素数量:', maskPixels.length);
        console.log('🎨 混合模式:', options.blendMode, '不透明度:', options.opacity + '%');
        
        // 性能监控
        const startTime = performance.now();
        
        // 检查图案是否支持PNG透明度
        const hasAlpha = (options.pattern.components === 4 || options.pattern.patternComponents === 4) && options.pattern.patternRgbData;
        console.log('🔍 PNG透明度检查:', {
            hasAlpha: hasAlpha,
            components: options.pattern.components,
            patternComponents: options.pattern.patternComponents,
            hasPatternRgbData: !!options.pattern.patternRgbData
        });
        
        // 生成透明度数据（如果需要）
        let patternAlphaData: Uint8Array | null = null;
        if (hasAlpha && options.pattern.patternRgbData) {
            console.log('🎨 生成图层蒙版模式的PNG透明度数据');
            patternAlphaData = await this.generateLayerMaskAlphaData(options.pattern, bounds);
        }
        
        // 获取图案掩码数据（如果有的话）
        const patternMask = (options.pattern as any).patternMask as Uint8Array | undefined;
        const hasPatternMask = !!patternMask;
        
        // 预先计算选区索引数组，避免在循环中重复转换（性能优化）
        const selectionIndices = bounds.selectionDocIndices ? Array.from(bounds.selectionDocIndices) : null;
        
        // 预先计算坐标映射缓存，进一步优化性能
        let coordinateCache: Array<{boundsX: number, boundsY: number, maskIndex: number}> | null = null;
        if (patternMask && selectionIndices) {
            coordinateCache = new Array(selectionIndices.length);
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                const docX = docIndex % bounds.docWidth;
                const docY = Math.floor(docIndex / bounds.docWidth);
                const boundsX = docX - bounds.left;
                const boundsY = docY - bounds.top;
                const maskIndex = boundsY * bounds.width + boundsX;
                coordinateCache[i] = { boundsX, boundsY, maskIndex };
            }
        }
        
        const hasCacheOptimization = !!coordinateCache;
        console.log('⚡ 性能优化状态: 图案掩码=', hasPatternMask, '坐标缓存=', hasCacheOptimization);
        
        // 计算数据统计而不是输出大量数组
        let maskMin = 255, maskMax = 0, patternMin = 255, patternMax = 0;
        for (let i = 0; i < Math.min(100, maskPixels.length); i++) {
            maskMin = Math.min(maskMin, maskPixels[i]);
            maskMax = Math.max(maskMax, maskPixels[i]);
        }
        for (let i = 0; i < Math.min(100, patternGrayData.length); i++) {
            patternMin = Math.min(patternMin, patternGrayData[i]);
            patternMax = Math.max(patternMax, patternGrayData[i]);
        }
        
        console.log('📊 蒙版数据统计: 最小值=', maskMin, '最大值=', maskMax);
        console.log('📊 图案数据统计: 最小值=', patternMin, '最大值=', patternMax);
        if (patternAlphaData) {
            console.log('📊 图案支持Alpha通道，长度:', patternAlphaData.length);
        } else if (hasAlpha) {
            console.log('⚠️ 图案应该支持Alpha通道但数据为空');
        }
        
        let minResult = 255, maxResult = 0, changeCount = 0;
        
        for (let i = 0; i < maskPixels.length; i++) {
            const maskValue = maskPixels[i];
            const patternValue = patternGrayData[i % patternGrayData.length];
            const patternAlpha = patternAlphaData ? patternAlphaData[i] : 255;
            
            // 确定当前像素是否在图案区域内（高性能缓存版本）
            let isPatternArea = true; // 默认为图案区域
            if (patternMask && coordinateCache) {
                const coord = coordinateCache[i];
                if (coord.boundsX >= 0 && coord.boundsX < bounds.width && 
                    coord.boundsY >= 0 && coord.boundsY < bounds.height && 
                    coord.maskIndex < patternMask.length) {
                    isPatternArea = patternMask[coord.maskIndex] > 0;
                }
            }
            
            const blendedValue = this.blendLayerMaskWithPattern(
                maskValue,
                patternValue,
                patternAlpha,
                options.blendMode,
                options.opacity,
                true, // 图层蒙版模式
                isPatternArea // 是否为图案区域
            );
            
            result[i] = blendedValue;
            
            // 统计结果范围和变化
            minResult = Math.min(minResult, blendedValue);
            maxResult = Math.max(maxResult, blendedValue);
            if (blendedValue !== maskValue) {
                changeCount++;
            }
            
            // 只输出前3个像素的详细计算过程
            if (i < 3) {
                console.log(`🔍 像素${i}: 蒙版=${maskValue}, 图案=${patternValue}, Alpha=${patternAlpha}, 混合结果=${blendedValue}`);
            }
        }
        
        console.log('📈 混合结果统计: 最小值=', minResult, '最大值=', maxResult, '改变像素数=', changeCount);
        
        // 性能监控结束
        const endTime = performance.now();
        const executionTime = endTime - startTime;
        console.log('⚡ 混合计算完成，耗时:', executionTime.toFixed(2), 'ms，平均每像素:', (executionTime / maskPixels.length).toFixed(4), 'ms');
        
        return result;
    }

    // 为图层蒙版模式生成PNG透明度数据
    private static async generateLayerMaskAlphaData(pattern: Pattern, bounds: any): Promise<Uint8Array | null> {
        try {
            if (!pattern.patternRgbData || !pattern.components || pattern.components !== 4) {
                console.log('⚠️ 图案不支持透明度或缺少RGBA数据');
                return null;
            }

            const patternWidth = pattern.width || pattern.originalWidth || 100;
            const patternHeight = pattern.height || pattern.originalHeight || 100;
            const scale = pattern.currentScale || pattern.scale || 100;
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            const angle = pattern.currentAngle || pattern.angle || 0;
            const fillMode = pattern.fillMode || 'tile';

            let alphaResult: { alphaData?: Uint8Array };

            if (fillMode === 'stamp') {
                // 盖图章模式：生成透明度数据
                console.log('🎯 图层蒙版：使用盖图章模式生成透明度数据');
                alphaResult = await createStampPatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    4, // RGBA数据
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    bounds,
                    false, // 非灰度模式
                    true // 生成透明度数据
                );
            } else {
                // 贴墙纸模式：生成透明度数据
                console.log('🧱 图层蒙版：使用贴墙纸模式生成透明度数据');
                alphaResult = createTilePatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    4, // RGBA数据
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    pattern.rotateAll !== false,
                    bounds,
                    true // 生成透明度数据
                );
            }

            if (!alphaResult.alphaData) {
                console.log('⚠️ 无法生成透明度数据');
                return null;
            }

            // 如果有选区索引，提取选区内的透明度数据
            if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                const selectionIndices = Array.from(bounds.selectionDocIndices);
                const selectionAlphaData = new Uint8Array(selectionIndices.length);

                for (let i = 0; i < selectionIndices.length; i++) {
                    const docIndex = selectionIndices[i];
                    const docX = docIndex % bounds.docWidth;
                    const docY = Math.floor(docIndex / bounds.docWidth);
                    const boundsX = docX - bounds.left;
                    const boundsY = docY - bounds.top;

                    if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                        const boundsIndex = boundsY * bounds.width + boundsX;
                        if (boundsIndex < alphaResult.alphaData.length) {
                            selectionAlphaData[i] = alphaResult.alphaData[boundsIndex];
                        } else {
                            selectionAlphaData[i] = 255; // 默认不透明
                        }
                    } else {
                        selectionAlphaData[i] = 255; // 默认不透明
                    }
                }

                console.log('✅ 成功生成图层蒙版透明度数据，选区内像素数:', selectionAlphaData.length);
                return selectionAlphaData;
            }

            console.log('✅ 成功生成图层蒙版透明度数据，总像素数:', alphaResult.alphaData.length);
            return alphaResult.alphaData;

        } catch (error) {
            console.error('❌ 生成图层蒙版透明度数据失败:', error);
            return null;
        }
    }

    // 将混合后的数据写回图层蒙版
    private static async writeLayerMaskData(blendedData: Uint8Array, bounds: any, currentLayerId: number, fullDocMaskArray: Uint8Array, state?: any): Promise<void> {
        try {
            console.log('📝 开始写回图层蒙版数据');
            console.log('📊 混合数据长度:', blendedData.length);
            console.log('📊 选区索引数量:', bounds.selectionDocIndices.size);
            
            // 创建完整文档大小的蒙版数组，复用已获取的数据
            const docWidth = bounds.docWidth;
            const docHeight = bounds.docHeight;
            console.log('📐 文档尺寸:', docWidth, 'x', docHeight);
            
            const fullMaskArray = new Uint8Array(fullDocMaskArray);
            
            // 将选区内的像素按索引写入完整数组
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const selectionCoefficients = bounds.selectionCoefficients;
            
            let changeCount = 0;
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                const newValue = blendedData[i];
                const coefficient = selectionCoefficients[i]; // 羽化系数已经是0-1范围，无需除以255
                
                // 应用羽化效果
                const currentValue = fullMaskArray[docIndex];
                const finalValue = Math.round(currentValue + (newValue - currentValue) * coefficient);
                
                if (finalValue !== currentValue) {
                    changeCount++;
                }
                
                fullMaskArray[docIndex] = finalValue;
                
                // 只输出前3个像素的写回过程
                if (i < 3) {
                    console.log(`📝 写回像素${i}: 索引=${docIndex}, 原值=${currentValue}, 新值=${newValue}, 系数=${coefficient.toFixed(3)}, 最终值=${finalValue}`);
                }
            }
            
            console.log('📈 实际改变的像素数量:', changeCount);
            
            // 计算写回后的统计信息
            let finalMin = 255, finalMax = 0;
            for (let i = 0; i < Math.min(100, fullMaskArray.length); i++) {
                finalMin = Math.min(finalMin, fullMaskArray[i]);
                finalMax = Math.max(finalMax, fullMaskArray[i]);
            }
            console.log('📊 写回后蒙版数据统计: 最小值=', finalMin, '最大值=', finalMax);
            
            // 根据官方文档创建ImageData对象用于图层蒙版写回
            // 图层蒙版应该使用灰度色彩空间和单通道
            const maskImageDataOptions = {
                width: docWidth,
                height: docHeight,
                components: 1, // 图层蒙版是单通道灰度
                chunky: false,
                colorProfile: "Dot Gain 15%",
                colorSpace: 'Grayscale'
            };
            const maskImageData = await imaging.createImageDataFromBuffer(fullMaskArray, maskImageDataOptions);
            
            // 根据官方文档使用putLayerMask写回完整的图层蒙版数据
            await imaging.putLayerMask({
                documentID: app.activeDocument.id,
                layerID: currentLayerId,
                targetBounds: {
                    left: 0,
                    top: 0,
                    right: docWidth,
                    bottom: docHeight
                },
                imageData: maskImageData
            });
            
            console.log('📝 putLayerMask API调用完成，参数: documentID=', app.activeDocument.id, 'layerID=', currentLayerId, 'bounds=', `${docWidth}x${docHeight}`);
            
            // 释放ImageData内存
            maskImageData.dispose();
            
            console.log('✅ 图层蒙版数据写回完成');
            
            // 检查APP主面板的取消选区checkbox状态，如果为false则使用imagingAPI恢复选区
            if (state && state.deselectAfterFill === false && bounds.selectionValues && bounds.selectionDocIndices) {
                console.log('🎯 取消选区checkbox为false，使用imagingAPI恢复选区');
                
                try {
                    console.log('🎯 使用传入的选区数据，压缩长度:', bounds.selectionValues.length);
                    console.log('🎯 文档尺寸:', bounds.docWidth, 'x', bounds.docHeight);
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullDocumentArray = new Uint8Array(bounds.docWidth * bounds.docHeight);
                    
                    // 将选区内像素的值填入对应的文档位置
                    const selectionIndicesArray = Array.from(bounds.selectionDocIndices);
                    for (let i = 0; i < bounds.selectionValues.length; i++) {
                        const docIndex = selectionIndicesArray[i];
                        if (docIndex < fullDocumentArray.length) {
                            fullDocumentArray[docIndex] = bounds.selectionValues[i];
                        }
                    }
                    
                    console.log('✅ 选区数组补全完成，完整数组长度:', fullDocumentArray.length);
                    
                    // 使用createImageDataFromBuffer创建ImageData
                    const imageDataOptions = {
                        width: bounds.docWidth,
                        height: bounds.docHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: "Dot Gain 15%",
                        colorSpace: "Grayscale"
                    };
                    
                    const imageData = await imaging.createImageDataFromBuffer(fullDocumentArray, imageDataOptions);
                    
                    // 使用putSelection更新选区
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: imageData
                    });
                    
                    // 释放ImageData内存
                    imageData.dispose();
                    
                    console.log('✅ 选区恢复完成');
                } catch (error) {
                    console.error('❌ 恢复选区失败:', error);
                }
            }
            
        } catch (error) {
            console.error('❌ 写回图层蒙版数据失败:', error);
            throw error;
        }
    }


    //-------------------------------------------------------------------------------------------------
    // 3.快速蒙版状态下的直接填充核心函数（灰度）（支持混合模式和不透明度）
    private static async fillPatternDirect(options: PatternFillOptions, state?: any) {
        try {
            console.log('🎨 开始快速蒙版图案填充。');
            
            // 获取当前选区边界信息
            const selectionBounds = await this.getSelectionData();
            if (!selectionBounds) {
                console.warn('❌ 没有选区，无法执行快速蒙版图案填充操作');
                return;
            }

            // 获取快速蒙版通道的像素数据和colorIndicates信息
            const { quickMaskPixels, isSelectedAreas, isEmpty, topLeftIsEmpty, bottomRightIsEmpty, originalTopLeft, originalBottomRight } = await this.getQuickMaskPixels(selectionBounds);
            
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
                topLeftIsEmpty,
                bottomRightIsEmpty,
                originalTopLeft,  // 传递原始左上角像素值
                originalBottomRight,  // 传递原始右下角像素值
                options.pattern  // 传递图案信息用于透明度处理
            );
            
            // 将计算后的灰度数据写回快速蒙版通道
            await this.updateQuickMaskChannel(finalGrayData, selectionBounds, state);
            
        } catch (error) {
            console.error("❌ 快速蒙版图案填充失败:", error);
            throw error;
        }
    }

    // 获取选区边界信息与文档信息
    private static async getSelectionData() {
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
                ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }),
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
                ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' })
            ]);
            
           // 获取文档尺寸信息
            const docWidth = docResult[0].width._value;
            const docHeight = docResult[0].height._value;
            const resolution = docResult[0].resolution._value;
            
            // 直接转换为像素单位
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
            
            // 使用imaging.getSelection获取羽化选区的像素数据
        const pixels = await imaging.getSelection({
            documentID: app.activeDocument.id,
            sourceBounds: {
                left: left,
                top: top,
                right: right,
                bottom: bottom
            },
            targetSize: {
                width: width,
                height: height
            },
        });
        
        const selectionData = await pixels.imageData.getData();
        console.log('✅ 成功获取选区边界内的像素数据，数据类型:', selectionData.constructor.name, '长度:', selectionData.length);
        
        // 创建临时数组来存储矩形边界内的所有像素信息
        const tempSelectionValues = new Uint8Array(width * height);
        const tempSelectionCoefficients = new Float32Array(width * height);
        // 创建一个新的Set来存储选区内像素（值大于0）在文档中的索引
        const selectionDocIndices = new Set<number>();
        
        // 第一步：处理矩形边界内的所有像素，收集选区内像素的索引
        if (selectionData.length === width * height) {
            // 单通道数据
            for (let i = 0; i < width * height; i++) {
                tempSelectionValues[i] = selectionData[i];
                tempSelectionCoefficients[i] = selectionData[i] / 255; // 计算选择系数
                
                // 只有当像素值大于0时，才认为它在选区内
                if (selectionData[i] > 0) {
                    // 计算该像素在选区边界内的坐标
                    const x = i % width;
                    const y = Math.floor(i / width);
                    
                    // 计算该像素在整个文档中的索引
                    const docX = left + x;
                    const docY = top + y;
                    const docIndex = docY * docWidthPixels + docX;
                    
                    // 将文档索引添加到集合中
                    selectionDocIndices.add(docIndex);
                }
            }
        }
        
        // 第二步：创建只包含选区内像素的数组（长度为selectionDocIndices.size）
        const selectionSize = selectionDocIndices.size;
        const selectionValues = new Uint8Array(selectionSize);
        const selectionCoefficients = new Float32Array(selectionSize);
        
        // 第三步：将选区内像素的值和系数填入新数组
        let fillIndex = 0;
        for (let i = 0; i < width * height; i++) {
            if (tempSelectionValues[i] > 0) {
                selectionValues[fillIndex] = tempSelectionValues[i];
                selectionCoefficients[fillIndex] = tempSelectionCoefficients[i];
                fillIndex++;
            }
        }
        console.log('✅ 选区内像素数量（selectionDocIndices.size）:', selectionDocIndices.size);
        
        // 释放ImageData内存
        pixels.imageData.dispose();
        
        // 取消选区
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
                    _value: "none"
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
        
        return {
            left,
            top,
            right,
            bottom,
            width,
            height,
            docWidth: docWidthPixels,  // 返回像素单位的文档宽度
            docHeight: docHeightPixels, // 返回像素单位的文档高度
            selectionPixels: selectionDocIndices, // 现在直接使用selectionDocIndices
            selectionDocIndices,       // 通过imaging.getSelection获取的选区内像素在文档中的索引
            selectionValues,           // 选区像素值（0-255）
            selectionCoefficients      // 选择系数（0-1）
        };
        
    } catch (error) {
        console.error('获取选区边界失败:', error);
        return null;
    }
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
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

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
            
            let topLeftIsEmpty = false;
            let bottomRightIsEmpty = false;
            let originalTopLeft = 0;
            let originalBottomRight = 0;

            // 获取左上角和右下角像素值
            originalTopLeft = await getPixelValue(action, 0, 0);
            originalBottomRight = await getPixelValue(action, Math.round(bounds.docWidth) - 1, Math.round(bounds.docHeight) - 1);

            
            // 取消选区
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
                        _value: "none"
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

            if (maskStatus.isEmpty) {
                console.log('快速蒙版为空，填充快速蒙版');
                
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
                ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

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
                ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                
            } else {

                // 判断是否需要填充
                if ((isSelectedAreas && (originalTopLeft === 255)) ||
                    (!isSelectedAreas && (originalTopLeft === 0))) 
                    topLeftIsEmpty = true;
                
                if ((isSelectedAreas && (originalBottomRight === 255)) ||
                    (!isSelectedAreas && (originalBottomRight === 0))) 
                    bottomRightIsEmpty = true;

                // 如果两个角都不为空，则跳过后续的填充
                if (!topLeftIsEmpty && !bottomRightIsEmpty) {
                    console.log('两个角都不为空，跳过填充');
                } else {
                    // 根据isEmpty状态添加选区
                    if (topLeftIsEmpty || bottomRightIsEmpty) {
                        // 创建选区 - 只选择需要填充的像素
                        if (topLeftIsEmpty && !bottomRightIsEmpty) {
                            // 只有左上角为空，选择左上角像素
                            console.log('只有左上角为空，选择左上角像素');
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
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        }
                                    }
                                }
                            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                        } else if (!topLeftIsEmpty && bottomRightIsEmpty) {
                            // 只有右下角为空，选择右下角像素
                            console.log('只有右下角为空，选择右下角像素');
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
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight) - 1
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth) - 1
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight)
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth)
                                        }
                                    }
                                }
                            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                        } else if (topLeftIsEmpty && bottomRightIsEmpty) {
                            console.log('两个角都为空，选择两个角的像素');
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
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight) - 1
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth) - 1
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight)
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth)
                                        }
                                    }
                                }
                            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                            await action.batchPlay([
                                {
                                    _obj: "addTo",
                                    _target: [
                                        {
                                            _ref: "channel",
                                            _property: "selection"
                                        }
                                    ],
                                    to: {
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        }
                                    }
                                }
                            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                        }

                        // 执行填充操作
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
                                        _value: isSelectedAreas ? 0 : 100
                                    }
                                },
                                source: "photoshopPicker",
                                _options: {
                                    dialogOptions: "dontDisplay"
                                }
                            }
                        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

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
                        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                    }
                }
            }
        
            
            
            // 撤销快速蒙版
            await this.clearQuickMask();
            
            // 如果是纯白快速蒙版或空白快速蒙版（非selectedAreas模式下），需要执行全选操作
            if (!isSelectedAreas && (maskStatus.isWhite || maskStatus.isEmpty)) {
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
                    topLeftIsEmpty: false,
                    bottomRightIsEmpty: false,
                    originalTopLeft: 0,
                    originalBottomRight: 0
                };
            }

            // 创建固定长度的maskValue数组，初始值全为0
            const expectedPixelCount = finalDocWidth * finalDocHeight;
            let maskValue = new Uint8Array(expectedPixelCount);
            
            // 获取quickMaskPixels中非零值的索引位置
            const nonZeroIndices: number[] = [];
            for (let i = 0; i < quickMaskPixels.length; i++) {
                if (quickMaskPixels[i] !== 0) {
                    nonZeroIndices.push(i);
                }
            }
            
            // 将非零值复制到maskValue对应位置
            for (let i = 0; i < nonZeroIndices.length; i++) {
                const sourceIndex = nonZeroIndices[i];
                maskValue[sourceIndex] = quickMaskPixels[sourceIndex];
            }
            
            console.log('快速蒙版图案非零像素数量:', nonZeroIndices.length);
            
            
            // 释放ImageData内存
            pixels.imageData.dispose();
            
            return {
                quickMaskPixels: maskValue,
                isSelectedAreas: isSelectedAreas,
                isEmpty: maskStatus.isEmpty,  // 添加isEmpty状态信息
                topLeftIsEmpty: topLeftIsEmpty,
                bottomRightIsEmpty: bottomRightIsEmpty,
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
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
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
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
    }

    //-------------------------------------------------------------------------------------------------
    // 获取图案填充的灰度数据
    private static async getPatternFillGrayData(options: PatternFillOptions, bounds: any): Promise<Uint8Array> {
        try {
            console.log('🎨 ===== getPatternFillGrayData 开始 =====');
            console.log('📊 接收到的完整options.pattern对象:', {
                hasPattern: !!options.pattern,
                patternKeys: options.pattern ? Object.keys(options.pattern) : [],
                // 基本属性
                id: options.pattern?.id,
                width: options.pattern?.width,
                height: options.pattern?.height,
                components: options.pattern?.components,
                // 数据属性
                hasGrayData: !!options.pattern?.grayData,
                grayDataLength: options.pattern?.grayData?.length,
                grayDataType: options.pattern?.grayData?.constructor?.name,
                hasPatternRgbData: !!options.pattern?.patternRgbData,
                patternRgbDataLength: options.pattern?.patternRgbData?.length,
                patternRgbDataType: options.pattern?.patternRgbData?.constructor?.name,
                // 变换属性
                scale: options.pattern?.scale,
                currentScale: options.pattern?.currentScale,
                angle: options.pattern?.angle,
                currentAngle: options.pattern?.currentAngle,
                fillMode: options.pattern?.fillMode,
                rotateAll: options.pattern?.rotateAll,
                preserveTransparency: options.pattern?.preserveTransparency,
                // 数据样本
                grayDataSample: options.pattern?.grayData ? Array.from(options.pattern.grayData.slice(0, 10)) : null,
                patternRgbDataSample: options.pattern?.patternRgbData ? Array.from(options.pattern.patternRgbData.slice(0, 12)) : null
            });
            
            
            if (!options.pattern.grayData) {
                console.error('❌ 缺少图案灰度数据，尝试从RGB数据生成');
                
                // 尝试从RGB数据生成灰度数据
                if (options.pattern.patternRgbData && options.pattern.width && options.pattern.height) {
                    console.log('🔄 从RGB数据生成灰度数据');
                    const rgbData = options.pattern.patternRgbData;
                    const width = options.pattern.width;
                    const height = options.pattern.height;
                    const components = options.pattern.components || 4; // 默认RGBA
                    
                    const grayData = new Uint8Array(width * height);
                    for (let i = 0; i < width * height; i++) {
                        const r = rgbData[i * components];
                        const g = rgbData[i * components + 1];
                        const b = rgbData[i * components + 2];
                        
                        // 使用标准的RGB到灰度转换公式
                        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                        grayData[i] = gray;
                    }
                    
                    // 将生成的灰度数据保存到图案对象中
                    options.pattern.grayData = grayData;
                    console.log('✅ 成功从RGB数据生成灰度数据，长度:', grayData.length);
                    console.log('🎯 生成的灰度数据长度:', grayData.length, '前3个值:', grayData[0], grayData[1], grayData[2]);
                } else {
                    console.error('❌ 无法生成灰度数据，缺少必要的RGB数据或尺寸信息');
                    // 根据可用的选区信息确定像素数量
                    let pixelCount = 0;
                    if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                        pixelCount = bounds.selectionDocIndices.size;
                    } else if (bounds.selectionValues && bounds.selectionValues.length > 0) {
                        pixelCount = bounds.selectionValues.length;
                    } else {
                        pixelCount = bounds.width * bounds.height;
                    }
                    const grayData = new Uint8Array(pixelCount);
                    grayData.fill(128); 
                    console.log('⚠️ 使用默认灰度数据，像素数:', pixelCount);
                    return grayData;
                }
            } else {
                console.log('✅ 找到现有的灰度数据，长度:', options.pattern.grayData.length);
                console.log('🎯 现有灰度数据长度:', options.pattern.grayData.length, '前3个值:', options.pattern.grayData[0], options.pattern.grayData[1], options.pattern.grayData[2]);
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
                const grayStampResult = await createStampPatternData(
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
                    true, // 灰度模式
                    false // 不需要生成透明度数据（灰度模式）
                );
                grayPatternData = grayStampResult.colorData;
                // 保存图案掩码供后续使用
                (options.pattern as any).patternMask = grayStampResult.patternMask;
            } else {
                // 贴墙纸模式：无缝平铺
                console.log('🧱 快速蒙版：使用贴墙纸模式填充，全部旋转:', options.pattern.rotateAll);
                const grayTileResult = createTilePatternData(
                    options.pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    options.pattern.currentAngle || options.pattern.angle || 0,
                    options.pattern.rotateAll !== false,
                    bounds,
                    false // 不需要生成透明度数据（灰度模式）
                );
                grayPatternData = grayTileResult.colorData;
            }
            
              if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                // 使用selectionDocIndices（选区内像素在文档中的索引）
                // 创建与选区内像素数量相同的数组
                const selectionSize = bounds.selectionDocIndices.size;
                const selectionGrayData = new Uint8Array(selectionSize);
                
                // 将selectionDocIndices转换为数组以便按顺序遍历
                const selectionIndices = Array.from(bounds.selectionDocIndices);
                
                // 遍历选区内的每个像素，从完整图案数据中提取对应的值
                for (let i = 0; i < selectionIndices.length; i++) {
                    const docIndex = selectionIndices[i];
                    // 计算该像素在选区边界内的坐标
                    const docX = docIndex % bounds.docWidth;
                    const docY = Math.floor(docIndex / bounds.docWidth);
                    const boundsX = docX - bounds.left;
                    const boundsY = docY - bounds.top;
                    
                    // 检查坐标是否在选区边界内
                    if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                        const boundsIndex = boundsY * bounds.width + boundsX;
                        if (boundsIndex < grayPatternData.length) {
                            selectionGrayData[i] = grayPatternData[boundsIndex];
                        } else {
                            selectionGrayData[i] = 128; // 默认中灰值
                        }
                    } else {
                        selectionGrayData[i] = 128; // 默认中灰值
                    }
                }
                
                console.log('🎯 selectionDocIndices提取完成，【图案】在选区内像素数:', selectionSize);
                return selectionGrayData;
            }
        } catch (error) {
            console.error('获取图案灰度数据失败:', error);
            let pixelCount = 0;
            
            // 根据可用的选区信息确定像素数量
            if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                pixelCount = bounds.selectionDocIndices.size;
            } else if (bounds.selectionValues && bounds.selectionValues.length > 0) {
                // 注意：selectionValues现在是选区内像素的数组，长度等于selectionDocIndices.size
                pixelCount = bounds.selectionValues.length;
            } else {
                // 如果没有选区信息，使用选区边界的面积作为默认值
                pixelCount = bounds.width * bounds.height;
            }
            
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128); // 填充中灰色
            console.log('⚠️ 使用默认灰度数据，像素数:', pixelCount);
            return grayData;
        }
    }

    // 应用混合模式计算最终灰度值（支持混合模式和透明度）
    private static async calculateFinalGrayValues(
        maskData: Uint8Array, 
        fillData: Uint8Array, 
        isSelectedAreas: boolean = true, 
        opacity: number = 100,
        blendMode: string = 'normal',
        isEmpty: boolean,
        bounds: any,
        topLeftIsEmpty: boolean = false,
        bottomRightIsEmpty: boolean = false,
        originalTopLeft: number = 0,
        originalBottomRight: number = 0,
        pattern?: Pattern
    ): Promise<Uint8Array> {
        console.log('📊 参数状态 - topLeftIsEmpty:', topLeftIsEmpty, '    bottomRightIsEmpty:', bottomRightIsEmpty, '    originalTopLeft:', originalTopLeft, '    originalBottomRight:', originalBottomRight);
        
        // maskData现在是完整文档的快速蒙版数据，fillData是选区内图案的数据
        // 需要从maskData中提取出真正在选区内的像素数据
        const selectedMaskData = new Uint8Array(fillData.length);
        
        if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
            
            // 使用selectionDocIndices直接获取选区内像素
            let fillIndex = 0;
            // 将Set转换为数组以便遍历
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            
            for (const docIndex of selectionIndices) {
                if (docIndex >= 0 && docIndex < maskData.length && fillIndex < selectedMaskData.length) {
                    selectedMaskData[fillIndex] = maskData[docIndex];
                    fillIndex++;
                }
            }
            
            console.log(`📊 通过selectionDocIndices提取了【快速蒙版】中 ${fillIndex} 个像素`);
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
        
        
        // 检查是否有透明度信息需要处理
        const hasAlpha = pattern && pattern.hasAlpha && pattern.patternRgbData && pattern.patternComponents === 4;
        
        // 如果有透明度信息，生成对应的透明度数据
        let alphaData: Uint8Array | undefined;
        if (hasAlpha) {
            const patternWidth = pattern.width || pattern.originalWidth || 100;
            const patternHeight = pattern.height || pattern.originalHeight || 100;
            const scale = pattern.currentScale || pattern.scale || 100;
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            const angle = pattern.currentAngle || pattern.angle || 0;
            
            if (pattern.fillMode === 'stamp') {
                // 盖图章模式：使用createStampPatternData生成透明度数据
                const stampAlphaResult = await createStampPatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    4, // RGBA数据
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    bounds,
                    false, // 非灰度模式
                    true // 生成透明度数据
                );
                
                if (stampAlphaResult.alphaData && bounds.selectionDocIndices) {
                    // 提取选区内的透明度数据
                    alphaData = new Uint8Array(bounds.selectionDocIndices.size);
                    const selectionIndices = Array.from(bounds.selectionDocIndices);
                    
                    for (let i = 0; i < selectionIndices.length; i++) {
                        const docIndex = selectionIndices[i];
                        const docX = docIndex % bounds.docWidth;
                        const docY = Math.floor(docIndex / bounds.docWidth);
                        const boundsX = docX - bounds.left;
                        const boundsY = docY - bounds.top;
                        
                        if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                            const boundsIndex = boundsY * bounds.width + boundsX;
                            if (boundsIndex < stampAlphaResult.alphaData.length) {
                                alphaData[i] = stampAlphaResult.alphaData[boundsIndex];
                            } else {
                                alphaData[i] = 255; // 默认不透明
                            }
                        } else {
                            alphaData[i] = 255; // 默认不透明
                        }
                    }
                }
            } else {
                // 贴墙纸模式：使用createTilePatternData生成透明度数据
                const alphaResult = createTilePatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    4, // RGBA数据
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    pattern.rotateAll !== false,
                    bounds,
                    true // 生成透明度数据
                );
                
                // 提取选区内的透明度数据
                if (alphaResult.alphaData && bounds.selectionDocIndices) {
                    const selectionIndices = Array.from(bounds.selectionDocIndices);
                    alphaData = new Uint8Array(selectionIndices.length);
                    
                    for (let i = 0; i < selectionIndices.length; i++) {
                        const docIndex = selectionIndices[i];
                        const docX = docIndex % bounds.docWidth;
                        const docY = Math.floor(docIndex / bounds.docWidth);
                        const boundsX = docX - bounds.left;
                        const boundsY = docY - bounds.top;
                        
                        if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                            const boundsIndex = boundsY * bounds.width + boundsX;
                            if (boundsIndex < alphaResult.alphaData.length) {
                                alphaData[i] = alphaResult.alphaData[boundsIndex];
                            } else {
                                alphaData[i] = 255; // 默认不透明
                            }
                        } else {
                            alphaData[i] = 255; // 默认不透明
                        }
                    }
                }
            }
        }
        
        // 分批处理，避免一次性处理过多数据导致栈溢出
        const BATCH_SIZE = 10000; // 每批处理1万个像素
        
        for (let batchStart = 0; batchStart < fillData.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, fillData.length);
            
            await new Promise(resolve => {
                setTimeout(() => {
                    // 使用混合模式计算，selectedMaskValue作为底色，fillValue作为混合色
                    for (let i = batchStart; i < batchEnd; i++) {
                        const selectedMaskValue = selectedMaskData[i];  // 选区内快速蒙版像素值 (0-255) - 底色
                        let fillValue = fillData[i]; // 图案像素值 (0-255) - 混合色
                        let effectiveOpacity = opacity; // 有效不透明度
                        
                        // 处理透明度信息（使用预生成的透明度数据）
                        if (hasAlpha && alphaData && i < alphaData.length) {
                            const alpha = alphaData[i];
                            effectiveOpacity = Math.round(opacity * alpha / 255);
                        }
                        
                        if (fillValue === 0 || effectiveOpacity === 0) {
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
                                const adjustedFillValue = Math.round(fillValue * effectiveOpacity / 100);
                                const blendedValue = this.applyBlendMode(255, adjustedFillValue, 'normal', 100); // 与纯白背景混合
                                finalData[i] = Math.min(255, Math.max(0, Math.round(blendedValue)));
                            } else {
                                // 正常情况：应用用户指定的混合模式计算，使用有效不透明度
                                const blendedValue = this.applyBlendMode(selectedMaskValue, fillValue, blendMode, effectiveOpacity);
                                finalData[i] = Math.min(255, Math.max(0, Math.round(blendedValue)));
                            }
                        }
                    }
                    resolve(void 0);
                }, 0);
            });
        }
        
        // 将计算结果映射回完整文档的newMaskValue中
        if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
            console.log('🎯 使用selectionDocIndices映射选区内的最终计算结果');
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            let resultIndex = 0;
            let mappedCount = 0;
            
            for (const docIndex of selectionIndices) {
                if (docIndex < newMaskValue.length && resultIndex < finalData.length) {
                    // 注意：bounds.selectionCoefficients现在是选区内像素的数组，
                    // 索引与selectionIndices一一对应
                    const selectionCoefficient = bounds.selectionCoefficients[resultIndex];
                    const originalValue = isEmpty ? 0 : maskData[docIndex];
                    const newValue = finalData[resultIndex];
                    
                    newMaskValue[docIndex] = Math.round(originalValue * (1 - selectionCoefficient) + newValue * selectionCoefficient);
                    
                    mappedCount++;
                    resultIndex++;
                }
            }
            
            console.log(`🎯 selectionDocIndices映射完成，映射了 ${mappedCount} 个像素`);
        }

        // 如果是不完整蒙版，根据是否在选区内决定是否还原角落像素值
        if ( topLeftIsEmpty ) {
            console.log('🔄 检查是否需要还原左上角像素值');
            // 检查左上角是否在选区内
            const topLeftInSelection = maskData[0] !== 0;
            
            // 只有当像素不在选区内时，才将其还原为0
            if (!topLeftInSelection) {
                console.log('⚪ 左上角像素不在选区内，还原为0');
                newMaskValue[0] = 0;
            }
        }

        if ( bottomRightIsEmpty ) {
            console.log('🔄 检查是否需要还原右下角像素值');
            // 检查左上角是否在选区内
            const bottomRightInSelection = maskData[maskData.length - 1] !== 0;
            
            // 只有当像素不在选区内时，才将其还原为0
            if (!bottomRightInSelection) {
                console.log('⚪ 右下角像素不在选区内，还原为0');
                newMaskValue[newMaskValue.length - 1] = 0;
            }
        }
        
        return newMaskValue;
    }

    // 将计算后的灰度数据写回快速蒙版通道
    private static async updateQuickMaskChannel(grayData: Uint8Array, bounds: any, state?: any) {
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
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
            // 检查APP主面板的取消选区checkbox状态，如果为false则使用imagingAPI恢复选区
            if (state && state.deselectAfterFill === false && bounds.selectionValues && bounds.selectionDocIndices) {
                console.log('🎯 取消选区checkbox为false，使用imagingAPI恢复选区');
                
                try {
                    console.log('🎯 使用传入的选区数据，压缩长度:', bounds.selectionValues.length);
                    console.log('🎯 文档尺寸:', bounds.docWidth, 'x', bounds.docHeight);
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullDocumentArray = new Uint8Array(bounds.docWidth * bounds.docHeight);
                    
                    // 将选区内像素的值填入对应的文档位置
                    const selectionIndicesArray = Array.from(bounds.selectionDocIndices);
                    for (let i = 0; i < bounds.selectionValues.length; i++) {
                        const docIndex = selectionIndicesArray[i];
                        if (docIndex < fullDocumentArray.length) {
                            fullDocumentArray[docIndex] = bounds.selectionValues[i];
                        }
                    }
                    
                    console.log('✅ 选区数组补全完成，完整数组长度:', fullDocumentArray.length);
                    
                    // 使用createImageDataFromBuffer创建ImageData
                    const imageDataOptions = {
                        width: bounds.docWidth,
                        height: bounds.docHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: "Dot Gain 15%",
                        colorSpace: "Grayscale"
                    };
                    
                    const imageData = await imaging.createImageDataFromBuffer(fullDocumentArray, imageDataOptions);
                    
                    // 使用putSelection更新选区
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: imageData
                    });
                    
                    // 释放ImageData内存
                    imageData.dispose();
                    
                    console.log('✅ 选区恢复完成');
                } catch (error) {
                    console.error('❌ 恢复选区失败:', error);
                }
            }
            
            
        } catch (error) {
            console.error('❌ 更新快速蒙版通道失败:', error);
        }
    }
}

// 导出函数供其他模块使用
export { createStampPatternData, createTilePatternData };
