import { action, app, core, imaging } from "photoshop";
import { calculateRandomColor, hsbToRgb, rgbToGray } from './ColorUtils';
import { Pattern } from '../types/state';

export class ClearHandler {
    static async clearWithOpacity(opacity: number, state?: any, layerInfo?: any) {
        try {
            // 获取当前文档信息
            const document = app.activeDocument;
            const isInQuickMask = document.quickMaskMode;
            
            // 快速蒙版执行特殊填充逻辑
            if (isInQuickMask && state) {
                await this.clearInQuickMask(state);
                return;
            }
            
            // 图层蒙版执行特殊填充逻辑
            if (layerInfo && layerInfo.isInLayerMask && state) {
                console.log('🎭 当前在图层蒙版状态，使用图层蒙版清除方法');
                if (state.fillMode === 'foreground') {
                    await this.clearLayerMaskSolidColor(layerInfo, state, opacity);
                } else if (state.fillMode === 'pattern') {
                    if (state.selectedPattern) {
                        await this.clearLayerMaskPattern(layerInfo, state, opacity);
                    } else {
                        // 缺少图案预设，显示警告并跳过清除
                        await core.showAlert({ message: '请先选择一个图案预设' });
                        return;
                    }
                } else if (state.fillMode === 'gradient') {
                    if (state.selectedGradient) {
                        await this.clearLayerMaskGradient(layerInfo, state, opacity);
                    } else {
                        // 缺少渐变预设，显示警告并跳过清除
                        await core.showAlert({ message: '请先选择一个渐变预设' });
                        return;
                    }
                }
                return;
            }
            
            // 像素图层的清除逻辑
            if (state && state.fillMode === 'foreground') {
                // 情况1：清除模式，删除纯色
                await this.clearSolidColor(opacity, state, layerInfo);
            } else if (state && state.fillMode === 'pattern') {
                if (state.selectedPattern) {
                    // 情况2：清除模式，删除图案
                    await this.clearPattern(opacity, state);
                } else {
                    // 缺少图案预设，显示警告并跳过清除
                    await core.showAlert({ message: '请先选择一个图案预设' });
                    return;
                }
            } else if (state && state.fillMode === 'gradient') {
                if (state.selectedGradient) {
                    // 情况3：清除模式，删除渐变
                    await this.clearGradient(opacity, state);
                } else {
                    // 缺少渐变预设，显示警告并跳过清除
                    await core.showAlert({ message: '请先选择一个渐变预设' });
                    return;
                }
            } 
        } catch (error) {
            console.error('清除选区失败:', error);
            throw error;
        }
    }

    //-------------------------------------------------------------------------------------------------
    // 情况1：清除模式，像素图层，删除纯色√
    static async clearSolidColor(opacity: number, state: any, layerInfo?: any) {
        try {
            console.log('🎨 执行纯色清除模式');
            
            // 背景图层特殊处理：使用色阶调整实现白色填充效果，避免弹出对话框
            if (layerInfo && layerInfo.isBackground) {
                console.log('🎯 检测到背景图层，使用色阶调整');
                
                // 根据不透明度计算色阶输出值：X = opacity/100 * 255
                const outputValue = Math.round((opacity / 100) * 255);
                
                console.log('🎛️ 色阶参数:', {
                    opacity: opacity,
                    outputValue: outputValue
                });
                
                // 使用色阶调整实现白色填充效果
                await action.batchPlay([{
                    _obj: "levels",
                    presetKind: {
                        _enum: "presetKindType",
                        _value: "presetKindCustom"
                    },
                    adjustment: [
                        {
                            _obj: "levelsAdjustment",
                            channel: {
                                _ref: "channel",
                                _enum: "channel",
                                _value: "composite"
                            },
                            output: [
                                outputValue,
                                255
                            ]
                        }
                    ],
                    _isCommand: false,
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                
                return;
            }
            
            // 非背景图层的原有逻辑
            // 计算抖动后的颜色
            const randomColorResult = calculateRandomColor(
                {
                    hueVariation: state.hueVariation || 0,
                    saturationVariation: state.saturationVariation || 0,
                    brightnessVariation: state.brightnessVariation || 0,
                    opacityVariation: state.opacityVariation || 0,
                    calculationMode: state.calculationMode || 'absolute'
                },
                opacity,
                undefined, // 使用当前前景色
                false // 非快速蒙版模式
            );
            
            // 只使用面板不透明度，不考虑前景色灰度
            const finalOpacity = Math.round(randomColorResult.opacity);
            
            console.log('🔢 颜色计算结果:', {
                originalOpacity: randomColorResult.opacity,
                finalOpacity: finalOpacity,
            });
            
            // 保存当前前景色
            const foregroundColor = app.foregroundColor;
            const savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
            
            try {
                // 设置前景色为抖动计算的结果
                await action.batchPlay([{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: {
                            _unit: "angleUnit",
                            _value: randomColorResult.hsb.hue
                        },
                        saturation: randomColorResult.hsb.saturation,
                        brightness: randomColorResult.hsb.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                
                console.log('🎨 已设置前景色为抖动计算结果:', {
                    hue: randomColorResult.hsb.hue,
                    saturation: randomColorResult.hsb.saturation,
                    brightness: randomColorResult.hsb.brightness
                });
                
                // 使用前景色执行填充操作
                await action.batchPlay([{
                    _obj: "fill",
                    using: {
                        _enum: "fillContents",
                        _value: "foregroundColor"
                    },
                    opacity: {
                        _unit: "percentUnit",
                        _value: finalOpacity
                    },
                    mode: {
                        _enum: "blendMode",
                        _value: "clearEnum"
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            } finally {
                // 恢复原来的前景色
                await action.batchPlay([{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: savedForegroundColor.hue,
                        saturation: savedForegroundColor.saturation,
                        brightness: savedForegroundColor.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            }
            
        } catch (error) {
            console.error('❌ 纯色清除失败:', error);
            throw error;
        }
    }

    //-------------------------------------------------------------------------------------------------
    // 情况2：清除模式，像素图层，删除图案
    static async clearPattern(opacity: number, state: any) {
        try {
            console.log('🔳 执行图案清除模式');
            
            // 第一步：获取选区边界信息
            const selectionBounds = await this.getSelectionData();
            if (!selectionBounds) {
                console.warn('❌ 没有选区，无法执行图案清除操作');
                return;
            }
            
            // 第二步：获取图案的灰度数据
            const patternGrayData = await this.getPatternFillGrayData(state, selectionBounds);
            
            // 第三步：计算最终灰度值（图案清除模式的特殊公式）
            const finalGrayData = await this.calculatePatternClearValues(patternGrayData, opacity, state, selectionBounds);
            
            // 第四步：用putSelection修改选区并删除内容
            await this.applySelectionAndDelete(finalGrayData, selectionBounds, state);
        } catch (error) {
            console.error('❌ 图案清除失败:', error);
            throw error;
        }
    }

    //-------------------------------------------------------------------------------------------------
    // 情况3：清除模式，像素图层，删除渐变
    static async clearGradient(opacity: number, state: any) {
        try {
            console.log('🌈 执行渐变清除模式');
            
            // 第一步：获取选区边界信息
            const selectionBounds = await this.getSelectionData();
            if (!selectionBounds) {
                console.warn('❌ 没有选区，无法执行渐变清除操作');
                return;
            }
            
            // 第二步：获取渐变的灰度数据
            const gradientGrayData = await this.getGradientFillGrayData(state, selectionBounds);
            
            // 第三步：计算最终灰度值（渐变清除模式的特殊公式）
            const finalGrayData = await this.calculateGradientClearValues(gradientGrayData, opacity, state, selectionBounds);
            
            // 第四步：用putSelection修改选区并删除内容
            await this.applySelectionAndDelete(finalGrayData, selectionBounds, state);
        } catch (error) {
            console.error('❌ 渐变清除失败:', error);
            throw error;
        }
    }

  //-------------------------------------------------------------------------------------------------
    // 计算图案清除模式的最终灰度值（性能优化版本）
    static async calculatePatternClearValues(
        patternGrayData: Uint8Array,
        opacity: number,
        state: any,
        bounds: any
    ): Promise<Uint8Array> {
        console.log('🔳 开始计算图案清除模式的最终灰度值');
        
        const finalData = new Uint8Array(patternGrayData.length);
        const opacityFactor = opacity / 100;
        
        // 检查是否有透明度信息需要处理（PNG图案自带透明区域）
        const hasAlpha = state?.selectedPattern && state.selectedPattern.hasAlpha && 
                         state.selectedPattern.patternRgbData && state.selectedPattern.patternComponents === 4;
        
        // 如果有透明度信息，生成对应的透明度数据
        let alphaData: Uint8Array | undefined;
        if (hasAlpha && state?.selectedPattern) {
            const pattern = state.selectedPattern;
            const patternWidth = pattern.width || pattern.originalWidth || 100;
            const patternHeight = pattern.height || pattern.originalHeight || 100;
            const scale = pattern.currentScale || pattern.scale || 100;
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            const angle = pattern.currentAngle || pattern.angle || 0;
            
            // 预计算常用值以提高性能
            const boundsLeft = bounds.left;
            const boundsTop = bounds.top;
            const boundsWidth = bounds.width;
            const boundsHeight = bounds.height;
            const docWidth = bounds.docWidth;
            
            if (pattern.fillMode === 'stamp') {
                // 盖图章模式：使用createStampPatternData生成透明度数据
                const stampAlphaResult = await ClearHandler.createStampPatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    4, // RGBA数据
                    boundsWidth,
                    boundsHeight,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    bounds,
                    false, // 非灰度模式
                    true // 生成透明度数据
                );
                
                if (stampAlphaResult.alphaData && bounds.selectionDocIndices) {
                    // 提取选区内的透明度数据 - 性能优化版本
                    alphaData = new Uint8Array(bounds.selectionDocIndices.size);
                    const selectionIndices = Array.from(bounds.selectionDocIndices);
                    const alphaDataSource = stampAlphaResult.alphaData;
                    
                    // 批量处理，减少重复计算
                    for (let i = 0; i < selectionIndices.length; i++) {
                        const docIndex: number = selectionIndices[i];
                        const docX = docIndex % docWidth;
                        const docY = Math.floor(docIndex / docWidth);
                        const boundsX = docX - boundsLeft;
                        const boundsY = docY - boundsTop;
                        
                        if (boundsX >= 0 && boundsX < boundsWidth && boundsY >= 0 && boundsY < boundsHeight) {
                            const boundsIndex = boundsY * boundsWidth + boundsX;
                            alphaData[i] = boundsIndex < alphaDataSource.length ? alphaDataSource[boundsIndex] : 0;
                        } else {
                            alphaData[i] = 0; // 图案外部为透明
                        }
                    }
                }
            } else {
                // 贴墙纸模式：使用createTilePatternData生成透明度数据
                const alphaResult = ClearHandler.createTilePatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    4, // RGBA数据
                    boundsWidth,
                    boundsHeight,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    pattern.rotateAll !== false,
                    bounds,
                    true // 生成透明度数据
                );
                
                // 提取选区内的透明度数据 - 性能优化版本
                if (alphaResult.alphaData && bounds.selectionDocIndices) {
                    const selectionIndices = Array.from(bounds.selectionDocIndices);
                    alphaData = new Uint8Array(selectionIndices.length);
                    const alphaDataSource = alphaResult.alphaData;
                    
                    // 批量处理，减少重复计算
                    for (let i = 0; i < selectionIndices.length; i++) {
                        const docIndex: number = selectionIndices[i];
                        const docX = docIndex % docWidth;
                        const docY = Math.floor(docIndex / docWidth);
                        const boundsX = docX - boundsLeft;
                        const boundsY = docY - boundsTop;
                        
                        if (boundsX >= 0 && boundsX < boundsWidth && boundsY >= 0 && boundsY < boundsHeight) {
                            const boundsIndex = boundsY * boundsWidth + boundsX;
                            alphaData[i] = boundsIndex < alphaDataSource.length ? alphaDataSource[boundsIndex] : 0;
                        } else {
                            alphaData[i] = 0; // 图案外部为透明
                        }
                    }
                }
            }
        }
        
        // 图案清除模式的计算公式：最终结果 = 图案灰度 * 不透明度
        // 对于图案外部的像素（透明区域），最终值为0
        const dataLength = patternGrayData.length;
        
        // 检查是否有选区羽化系数
        const hasFeathering = bounds.selectionCoefficients && bounds.selectionCoefficients.length > 0;
        
        if (hasAlpha && alphaData) {
            // 有透明度数据的情况（绝对公式）
            for (let i = 0; i < dataLength; i++) {
                const alpha = alphaData[i];
                if (alpha === 0) {
                    finalData[i] = 0; // 透明区域直接设为0
                } else {
                    // 计算有效不透明度并应用
                    let effectiveOpacity = (opacity * alpha) / 25500; // 合并除法运算 (opacity * alpha / 255 / 100)
                    
                    // 应用选区羽化系数
                    if (hasFeathering && i < bounds.selectionCoefficients.length) {
                        effectiveOpacity *= bounds.selectionCoefficients[i];
                    }
                    
                    finalData[i] = Math.floor(patternGrayData[i] * effectiveOpacity);
                }
            }
        } else {
            // 无透明度数据的情况（绝对公式）
            for (let i = 0; i < dataLength; i++) {
                let effectiveOpacityFactor = opacityFactor;
                
                // 应用选区羽化系数
                if (hasFeathering && i < bounds.selectionCoefficients.length) {
                    effectiveOpacityFactor *= bounds.selectionCoefficients[i];
                }
                
                finalData[i] = Math.floor(patternGrayData[i] * effectiveOpacityFactor);
            }
        }
        
        console.log('✅ 图案清除模式灰度值计算完成');
        return finalData;
    }
    
    //-------------------------------------------------------------------------------------------------
    // 计算渐变清除模式的最终灰度值（性能优化版本）
    static async calculateGradientClearValues(
        gradientGrayData: Uint8Array,
        opacity: number,
        state: any,
        bounds: any
    ): Promise<Uint8Array> {
        console.log('🌈 开始计算渐变清除模式的最终灰度值');
        
        const finalData = new Uint8Array(gradientGrayData.length);
        const opacityFactor = opacity / 100;
        const dataLength = gradientGrayData.length;
        
        // 检查是否有选区羽化系数
        const hasFeathering = bounds.selectionCoefficients && bounds.selectionCoefficients.length > 0;
        
        // 检查是否有渐变透明度信息需要处理
        const hasGradientAlpha = state?.selectedGradient && state.selectedGradient.stops;
        
        // 如果有渐变透明度信息，生成对应的透明度数据
        let alphaData: Uint8Array | undefined;
        if (hasGradientAlpha && state?.selectedGradient) {
            alphaData = await this.generateGradientAlphaData(state, bounds);
        }
        
        if (hasGradientAlpha && alphaData) {
            // 有透明度数据的情况（考虑渐变透明度）
            for (let i = 0; i < dataLength; i++) {
                const alpha = alphaData[i];
                if (alpha === 0) {
                    finalData[i] = 0; // 透明区域直接设为0
                } else {
                    // 计算有效不透明度并应用
                    let effectiveOpacity = (opacity * alpha) / 25500; // 合并除法运算 (opacity * alpha / 255 / 100)
                    
                    // 应用选区羽化系数
                    if (hasFeathering && i < bounds.selectionCoefficients.length) {
                        effectiveOpacity *= bounds.selectionCoefficients[i];
                    }
                    
                    finalData[i] = Math.floor(gradientGrayData[i] * effectiveOpacity);
                }
            }
        } else {
            // 无透明度数据的情况（原有逻辑）
            for (let i = 0; i < dataLength; i++) {
                let effectiveOpacityFactor = opacityFactor;
                
                // 应用选区羽化系数
                if (hasFeathering && i < bounds.selectionCoefficients.length) {
                    effectiveOpacityFactor *= bounds.selectionCoefficients[i];
                }
                
                finalData[i] = Math.floor(gradientGrayData[i] * effectiveOpacityFactor);
            }
        }
        return finalData;
    }
    
    //-------------------------------------------------------------------------------------------------
    // 用putSelection修改选区并删除内容（修复索引映射版本）
    static async applySelectionAndDelete(finalGrayData: Uint8Array, bounds: any, state?: any) {
        try {
            console.log('🎯 开始应用选区并删除内容');
            
            const documentColorProfile = "Dot Gain 15%"; // 默认值
            
            // 创建文档大小的ImageData选项
            const selectionOptions = {
                width: bounds.docWidth,
                height: bounds.docHeight,
                components: 1,
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            // 创建完整文档大小的灰度数据数组
            const fullDocumentData = new Uint8Array(bounds.docWidth * bounds.docHeight);
            
            if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                // 先将所有像素设为0（透明）
                fullDocumentData.fill(0);
                
                // 直接按照文档索引设置选区内像素的灰度值
                const selectionIndicesArray = Array.from(bounds.selectionDocIndices);
                for (let i = 0; i < selectionIndicesArray.length && i < finalGrayData.length; i++) {
                    const docIndex = selectionIndicesArray[i];
                    // 确保文档索引在有效范围内
                    if (docIndex >= 0 && docIndex < fullDocumentData.length) {
                        fullDocumentData[docIndex] = finalGrayData[i];
                    }
                }
            } else {
                // 如果没有选区索引信息，将最终灰度数据映射到边界区域
                fullDocumentData.fill(0);
                const boundsWidth = bounds.width;
                const boundsLeft = bounds.left;
                const boundsTop = bounds.top;
                const docWidth = bounds.docWidth;
                
                let dataIndex = 0;
                for (let y = 0; y < bounds.height && dataIndex < finalGrayData.length; y++) {
                    for (let x = 0; x < boundsWidth && dataIndex < finalGrayData.length; x++) {
                        const docX = boundsLeft + x;
                        const docY = boundsTop + y;
                        const docIndex = docY * docWidth + docX;
                        
                        if (docIndex >= 0 && docIndex < fullDocumentData.length) {
                            fullDocumentData[docIndex] = finalGrayData[dataIndex];
                        }
                        dataIndex++;
                    }
                }
            }
            
            const imageData = await imaging.createImageDataFromBuffer(fullDocumentData, selectionOptions);
            
            // 使用putSelection将灰度数据作为选区应用（覆盖整个文档）
            await imaging.putSelection({
                documentID: app.activeDocument.id,
                imageData: imageData,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: bounds.docWidth,
                    bottom: bounds.docHeight
                }
            });
            
            imageData.dispose();
            
            // 删除选区内容
            await action.batchPlay([
                {
                    _obj: "delete",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            // ⚠️ 与其它填充/清除分支保持一致（2026-10-08）：
            // 本方法前面的 putSelection 已经把选区改写成了「待删除的灰度掩码」，
            // 而 getSelectionData() 内部也早已取消过选区。当用户关闭「自动删选区」
            // (deselectAfterFill === false) 时，必须把原选区还原回去 ——
            // 否则「图案/渐变 + 清除 + 描边」会沿被改写的掩码描边，而不是原选区轮廓。
            // 闸门与 updateQuickMaskChannel / updateLayerMask / PatternFill / GradientFill /
            // SingleChannelHandler 完全同构：仅 deselectAfterFill === false 才还原，
            // 默认（true）行为不变。
            if (state && state.deselectAfterFill === false
                && bounds && bounds.selectionValues && bounds.selectionValues.length > 0) {
                try {
                    const docW = Math.round(bounds.docWidth);
                    const docH = Math.round(bounds.docHeight);
                    const fullSelectionData = new Uint8Array(docW * docH);
                    if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                        // ⚠️ 显式给 Array.from 收敛元素类型：bounds 是 any，不写 <number> 会推出
                        // unknown[] ⇒ docIndex 变 unknown ⇒ fullSelectionData[docIndex] 报 TS2538。
                        const selectionIndices = Array.from<number>(bounds.selectionDocIndices);
                        let valueIndex = 0;
                        for (const docIndex of selectionIndices) {
                            if (docIndex < fullSelectionData.length && valueIndex < bounds.selectionValues.length) {
                                fullSelectionData[docIndex] = bounds.selectionValues[valueIndex];
                                valueIndex++;
                            } else if (valueIndex >= bounds.selectionValues.length) {
                                break;
                            }
                        }
                    }
                    const selectionOptions = {
                        width: docW,
                        height: docH,
                        components: 1,
                        chunky: true,
                        colorProfile: documentColorProfile,
                        colorSpace: "Grayscale"
                    };
                    const selectionImageData = await imaging.createImageDataFromBuffer(fullSelectionData, selectionOptions);
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: selectionImageData
                    });
                    selectionImageData.dispose();
                } catch (selectionError) {
                    console.error('恢复选区失败:', selectionError);
                }
            }
        } catch (error) {
            console.error('❌ 应用选区并删除内容失败:', error);
            throw error;
        }
    }
    
    // 收集左上角和右下角像素的值，并且做处理
    static async getPixelValue(action: any, x: number, y: number): Promise<number> {
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

        return pixelValue;
    }


    //-------------------------------------------------------------------------------------------------
    // 处于清除模式，并且文档状态为快速蒙版状态下，修改快速蒙版通道像素的方法
    static async clearInQuickMask(state: any) {
        try {
            
            // 只有在纯色填充模式下才获取前景色
            // 这必须在getQuickMaskPixels调用之前，因为该方法会撤销快速蒙版
            let quickMaskForegroundColor = null;
            if (state.fillMode === 'foreground') {
                quickMaskForegroundColor = app.foregroundColor;
            } else {
                console.log('🔄 非纯色填充模式，跳过前景色获取，当前模式:', state.fillMode);
            }
            
            // 获取当前选区边界信息（第一次获取）
            const selectionBounds = await this.getSelectionData();
            if (!selectionBounds) {
                console.warn('❌ 没有选区，无法执行快速蒙版清除操作');
                return;
            }
            
            // 获取快速蒙版通道的像素数据和colorIndicates信息
            const { quickMaskPixels, isSelectedAreas, isEmpty, topLeftIsEmpty, bottomRightIsEmpty, originalTopLeft, originalBottomRight } = await this.getQuickMaskPixels(selectionBounds);

            // 如果快速蒙版为空，直接返回，不执行后续操作
            if (isEmpty) {
                console.log('⚠️ 快速蒙版为空，跳过后续填充操作');
                return;
            }
            
            // 根据填充模式获取填充内容的灰度数据，对应情况4、5、6
            let fillGrayData;
            if (state.fillMode === 'foreground') {
                console.log('🎨 使用纯色填充模式');
                fillGrayData = await this.getSolidFillGrayData(state, selectionBounds, quickMaskForegroundColor);
            } else if (state.fillMode === 'pattern') {
                if (state.selectedPattern) {
                    console.log('🔳 使用图案填充模式');
                    fillGrayData = await this.getPatternFillGrayData(state, selectionBounds);
                } else {
                    // 缺少图案预设，显示警告并跳过清除
                    await core.showAlert({ message: '请先选择一个图案预设' });
                    return;
                }
            } else if (state.fillMode === 'gradient') {
                if (state.selectedGradient) {
                    console.log('🌈 使用渐变填充模式');
                    fillGrayData = await this.getGradientFillGrayData(state, selectionBounds);
                } else {
                    // 缺少渐变预设，显示警告并跳过清除
                    await core.showAlert({ message: '请先选择一个渐变预设' });
                    return;
                }
            } else {
                console.warn('❌ 未知的填充模式或缺少填充数据，填充模式:', state.fillMode);
                return;
            }

            // 应用新的混合公式计算最终灰度值
            const finalGrayData = await this.calculateFinalGrayValues(
                quickMaskPixels, 
                fillGrayData, 
                isSelectedAreas, 
                state.opacity,
                isEmpty,
                selectionBounds,
                topLeftIsEmpty,
                bottomRightIsEmpty,
                originalTopLeft,
                originalBottomRight,
                state
            );
            
            // 将计算后的灰度数据写回快速蒙版通道
            await this.updateQuickMaskChannel(finalGrayData, selectionBounds, state);
            
        } catch (error) {
            console.error('❌ 快速蒙版特殊填充失败:', error);
            throw error;
        }
    }

  
    //-------------------------------------------------------------------------------------------------
    // 获取选区边界信息和文档信息
    static async getSelectionData() {
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
    static async getQuickMaskPixels(bounds: any) {
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
            const maskStatus = this.analyzeQuickMaskHistogram(histogram, isSelectedAreas);

            let topLeftIsEmpty = false;
            let bottomRightIsEmpty = false;
            let originalTopLeft = 0;
            let originalBottomRight = 0;

            // 获取左上角和右下角像素值
            originalTopLeft = await ClearHandler.getPixelValue(action, 0, 0);
            originalBottomRight = await ClearHandler.getPixelValue(action, Math.round(bounds.docWidth) - 1, Math.round(bounds.docHeight) - 1);

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
                await core.showAlert({ message: '您的快速蒙版已经为空！' });
                console.log('⚠️ 检测到快速蒙版为空，跳过修改蒙版流程！');
                const pixelCount = bounds.width * bounds.height;
                return {
                    quickMaskPixels: new Uint8Array(pixelCount),
                    isSelectedAreas: isSelectedAreas,
                    isEmpty: maskStatus.isEmpty,  // 添加isEmpty状态信息
                    topLeftIsEmpty: topLeftIsEmpty,
                    bottomRightIsEmpty: bottomRightIsEmpty,
                    originalTopLeft: originalTopLeft,  // 原始左上角像素值
                    originalBottomRight: originalBottomRight  // 原始右下角像素值
                };
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
            await ClearHandler.clearQuickMask();
            
            // 如果是纯白快速蒙版（非selectedAreas模式下），需要执行全选操作
            if (!isSelectedAreas && maskStatus.isWhite) {
                await ClearHandler.selectAll();
            }

            // 通过获取选区的灰度信息，间接获取完整文档的快速蒙版数据，maskValue数组
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);

            // 通过Imaging API获取快速蒙版转化的选区的黑白信息
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
            
            const quickMaskData = await pixels.imageData.getData();

            // 释放ImageData内存
            pixels.imageData.dispose();
            
            // 创建固定长度的maskValue数组，初始值全为0
            const expectedPixelCount = finalDocWidth * finalDocHeight;
            let maskValue = new Uint8Array(expectedPixelCount);
            
            // 将quickMaskData转换为Uint8Array
            const quickMaskPixels = new Uint8Array(quickMaskData);
            
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
    // 分析快速蒙版直方图状态
    static analyzeQuickMaskHistogram(histogram: number[], isSelectedAreas: boolean) {
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
                console.log('selectedAreas——————快速蒙版为空？', isEmpty);
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
                
                console.log('非selectedAreas模式——————快速蒙版为空？', isEmpty, '    全选？', isWhite);
            }
        }
        
        return { isEmpty, isWhite };
    }
    
    // 撤销快速蒙版
    static async clearQuickMask() {
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
    
    // 执行全选操作
    static async selectAll() {
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
    // 获取纯色填充的灰度数据
    static async getSolidFillGrayData(state: any, bounds: any, quickMaskForegroundColor?: any) {
        console.log('🔍 调试getSolidFillGrayData - state.opacity:', state.opacity);
        
        // 使用传入的快速蒙版前景色，如果没有则实时获取当前前景色
        const currentForegroundColor = quickMaskForegroundColor || app.foregroundColor;
        
        const pixelCount = bounds.width * bounds.height;
        const grayData = new Uint8Array(pixelCount);
        
        // 在快速蒙版模式下，使用灰度抖动而不是HSB颜色抖动
        const isQuickMaskMode = true; // 在getSolidFillGrayData中，我们总是处于快速蒙版模式
        const panelColor = calculateRandomColor(state.colorSettings, state.opacity, currentForegroundColor, isQuickMaskMode);
        console.log('🔍 填充的纯色 - panelColor:', panelColor);
        
        // 将HSB颜色转换为灰度值
        const rgb = hsbToRgb(panelColor.hsb.hue, panelColor.hsb.saturation, panelColor.hsb.brightness);
        const grayValue = rgbToGray(rgb.red, rgb.green, rgb.blue);
        grayData.fill(grayValue);
        
        return grayData;
    }
    
    //-------------------------------------------------------------------------------------------------
    // 获取图案填充的灰度数据（支持羽化选区和PNG透明度）
    static async getPatternFillGrayData(state: any, bounds: any): Promise<Uint8Array> {
        try {
            
            // 检查是否有有效的图案数据
            if (!state.selectedPattern || !state.selectedPattern.grayData) {
                console.error('缺少图案灰度数据');
                let pixelCount = 0;
                
                // 根据可用的选区信息确定像素数量
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
            
            // 优先使用width和height，这些是PatternPicker中设置的当前尺寸
            const pattern = state.selectedPattern;
            const patternWidth = pattern.width || pattern.originalWidth || 100;
            const patternHeight = pattern.height || pattern.originalHeight || 100;
                
            // 使用当前的缩放和角度设置
            const scale = pattern.currentScale || pattern.scale || 100;
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            
            // 根据填充模式选择算法
            const fillMode = pattern.fillMode || 'tile'; // 默认为贴墙纸模式
            let grayPatternData: Uint8Array;
            
            if (fillMode === 'stamp') {
                // 盖图章模式：图案居中显示，不重复
                console.log('🎯 快速蒙版清除：使用盖图章模式填充');
                const grayStampResult = await ClearHandler.createStampPatternData(
                    pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    pattern.currentAngle || pattern.angle || 0,
                    bounds,
                    true, // 灰度模式
                    false // 不需要生成透明度数据（灰度模式）
                );
                grayPatternData = grayStampResult.colorData;
            } else {
                // 贴墙纸模式：无缝平铺
                console.log('🧱 快速蒙版清除：使用贴墙纸模式填充，全部旋转:', pattern.rotateAll);
                const grayTileResult = ClearHandler.createTilePatternData(
                    pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    pattern.currentAngle || pattern.angle || 0,
                    pattern.rotateAll !== false,
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
                    const docIndex: number = selectionIndices[i];
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
            
            console.log('✅ 图案填充灰度数据生成完成，长度:', grayPatternData.length);
            return grayPatternData;
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

    // ---------------------------------------------------------------------------
    // 为选区创建盖图章模式的图案数据
    static async createStampPatternData(
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
        generateAlphaData: boolean = false
    ): Promise<{ colorData: Uint8Array; alphaData?: Uint8Array }> {
        
        const resultData = new Uint8Array(targetWidth * targetHeight * (isGrayMode ? 1 : components));
        let alphaData: Uint8Array | undefined;
        
        if (generateAlphaData) {
            alphaData = new Uint8Array(targetWidth * targetHeight);
        }
        
        // 计算目标区域中心作为图案放置中心
        const targetCenterX = targetWidth / 2;
        const targetCenterY = targetHeight / 2;
        
        // 计算图案放置位置（居中）
        const patternStartX = targetCenterX - scaledPatternWidth / 2;
        const patternStartY = targetCenterY - scaledPatternHeight / 2;
        
        const angleRad = (angle * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        // 图案中心
        const patternCenterX = scaledPatternWidth / 2;
        const patternCenterY = scaledPatternHeight / 2;
        
        // 获取图案像素的函数 - 修复透明区域处理
        const getPatternPixel = (x: number, y: number) => {
            let patternX: number, patternY: number;
            
            if (angle !== 0) {
                // 计算相对于旋转中心的坐标
                const relativeX = x - (targetWidth / 2);
                const relativeY = y - (targetHeight / 2);
                
                // 反向旋转以获取原始坐标
                const originalX = relativeX * cos + relativeY * sin + (targetWidth / 2);
                const originalY = -relativeX * sin + relativeY * cos + (targetHeight / 2);
                
                // 计算在图案中的位置
                patternX = originalX - patternStartX;
                patternY = originalY - patternStartY;
            } else {
                // 无旋转的情况
                patternX = x - patternStartX;
                patternY = y - patternStartY;
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
            
            // 超出范围时返回-1表示透明区域
            return -1;
        };
        
        // 遍历目标区域的每个像素
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                const sourceIndex = getPatternPixel(x, y);
                const pixelIndex = y * targetWidth + x;
                
                if (sourceIndex >= 0) {
                    // 在图案范围内，直接复制像素数据
                    if (isGrayMode || components === 1) {
                        resultData[pixelIndex] = patternData[sourceIndex];
                        if (alphaData) {
                            alphaData[pixelIndex] = 255; // 灰度模式下图案区域为不透明
                        }
                    } else {
                        const colorIndex = pixelIndex * components;
                        // 直接复制图案像素数据，保持原始透明度信息
                        for (let c = 0; c < components; c++) {
                            resultData[colorIndex + c] = patternData[sourceIndex + c];
                        }
                        if (alphaData) {
                            alphaData[pixelIndex] = components === 4 ? patternData[sourceIndex + 3] : 255;
                        }
                    }
                } else {
                    // 超出图案范围，设置为透明
                    if (isGrayMode || components === 1) {
                        resultData[pixelIndex] = 255; // 灰度模式下透明区域为白色
                        if (alphaData) {
                            alphaData[pixelIndex] = 0; // 透明
                        }
                    } else {
                        const colorIndex = pixelIndex * components;
                        // 透明区域：RGB值设为0，alpha设为0
                        resultData[colorIndex] = 0;     // R = 0
                        resultData[colorIndex + 1] = 0; // G = 0
                        resultData[colorIndex + 2] = 0; // B = 0
                        if (components === 4) {
                            resultData[colorIndex + 3] = 0; // Alpha = 0 (完全透明)
                        }
                        if (alphaData) {
                            alphaData[pixelIndex] = 0; // 透明
                        }
                    }
                }
            }
        }
        
        return { colorData: resultData, alphaData: alphaData };
    }
    
    // ---------------------------------------------------------------------------
    // 为选区创建贴墙纸模式的图案数据
    static createTilePatternData(
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

    //-------------------------------------------------------------------------------------------------
    // 获取渐变填充的灰度数据
    static async getGradientFillGrayData(state: any, bounds: any) {
        try {
            const gradient = state.selectedGradient;
            if (!gradient) {
                // 优先使用selectionDocIndices.size，其次selectionValues.length，最后使用bounds面积
                const pixelCount = bounds.selectionDocIndices?.size || bounds.selectionValues?.length || (bounds.width * bounds.height);
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128);
                return grayData;
            }
            
            console.log('✅ 使用渐变数据计算灰度，渐变类型:', gradient.type, '角度:', gradient.angle, '反向:', gradient.reverse);
            
            // 检查是否有选区索引信息
            if (!bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('⚠️ 没有找到选区索引信息，回退到矩形边界处理');
                const pixelCount = bounds.width * bounds.height;
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128);
                return grayData;
            }
            
            // 只为选区内的像素生成灰度数据
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const grayData = new Uint8Array(selectionIndices.length);
            
            // 计算渐变的中心点和角度（基于选区边界）
            const centerX = bounds.width / 2;
            const centerY = bounds.height / 2;
            
            // 使用新的外接矩形算法计算起点和终点（与GradientFill.ts保持一致）
            const gradientPoints = this.calculateGradientBounds(0, 0, bounds.width, bounds.height, gradient.angle || 0);
            
            let startX, startY, endX, endY;
            
            // 如果reverse为true，交换起点和终点
            if (gradient.reverse) {
                startX = gradientPoints.endX;
                startY = gradientPoints.endY;
                endX = gradientPoints.startX;
                endY = gradientPoints.startY;
            } else {
                startX = gradientPoints.startX;
                startY = gradientPoints.startY;
                endX = gradientPoints.endX;
                endY = gradientPoints.endY;
            }
            
            console.log('📊 开始为选区内', selectionIndices.length, '个像素计算渐变灰度');
            
            // 遍历选区内的每个像素
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex: number = selectionIndices[i];
                
                // 将文档索引转换为选区边界内的坐标
                const docX = docIndex % bounds.docWidth;
                const docY = Math.floor(docIndex / bounds.docWidth);
                const boundsX = docX - bounds.left;
                const boundsY = docY - bounds.top;
                
                let position;
                
                if (gradient.type === 'radial') {
                    // 径向渐变
                    const dx = boundsX - centerX;
                    const dy = boundsY - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
                    position = Math.min(1, distance / maxDistance);
                } else {
                    // 线性渐变 - 使用与GradientFill.ts一致的计算方法
                    const dx = boundsX - startX;
                    const dy = boundsY - startY;
                    const gradientDx = endX - startX;
                    const gradientDy = endY - startY;
                    const gradientLengthSq = gradientDx * gradientDx + gradientDy * gradientDy;
                    
                    if (gradientLengthSq > 0) {
                        const dotProduct = dx * gradientDx + dy * gradientDy;
                        position = Math.max(0, Math.min(1, dotProduct / gradientLengthSq));
                    } else {
                        position = 0;
                    }
                }
                
                // 根据位置插值渐变颜色并转换为灰度，同时考虑透明度
                const colorWithOpacity = this.interpolateGradientColorWithOpacity(gradient.stops, position);
                
                // 计算颜色的灰度值
                const colorGrayscale = Math.round(
                    0.299 * colorWithOpacity.red + 
                    0.587 * colorWithOpacity.green + 
                    0.114 * colorWithOpacity.blue
                );
                
                // 综合考虑颜色灰度和透明度：灰度值 = (颜色灰度/255) × (不透明度/100) × 255
                const finalGrayValue = Math.round((colorGrayscale / 255) * (colorWithOpacity.opacity / 100) * 255);
                grayData[i] = finalGrayValue;
            }
            
            console.log('✅ 渐变灰度数据生成完成，数据长度:', grayData.length);
            return grayData;
        } catch (error) {
            console.error('获取渐变灰度数据失败:', error);
            // 优先使用selectionDocIndices.size，其次selectionValues.length，最后使用bounds面积
            const pixelCount = bounds.selectionDocIndices?.size || bounds.selectionValues?.length || (bounds.width * bounds.height);
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128);
            console.log('📊 错误处理：生成默认灰度数据，像素数量:', pixelCount);
            return grayData;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 计算渐变的外接矩形边界点（新算法）
    static calculateGradientBounds(left: number, top: number, right: number, bottom: number, angle: number) {
        // 计算选区中心点和尺寸
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        const width = right - left;
        const height = bottom - top;
        
        // 将角度转换为弧度，调整角度以匹配预览效果
        const adjustedAngle = angle;
        const angleRad = adjustedAngle * Math.PI / 180;
        
        // 计算渐变方向的单位向量
        const dirX = Math.cos(angleRad);
        const dirY = Math.sin(angleRad);
        
        // 计算选区矩形的四个顶点
        const corners = [
            { x: left, y: top },
            { x: right, y: top },
            { x: right, y: bottom },
            { x: left, y: bottom }
        ];
        
        // 计算每个顶点在渐变方向上的投影
        let minProjection = Infinity;
        let maxProjection = -Infinity;
        
        for (const corner of corners) {
            // 计算从中心点到顶点的向量
            const dx = corner.x - centerX;
            const dy = corner.y - centerY;
            
            // 计算在渐变方向上的投影
            const projection = dx * dirX + dy * dirY;
            
            minProjection = Math.min(minProjection, projection);
            maxProjection = Math.max(maxProjection, projection);
        }
        
        // 添加小量容差确保完全覆盖
        const tolerance = Math.max(width, height) * 0.05;
        minProjection -= tolerance;
        maxProjection += tolerance;
        
        // 计算起点和终点坐标
        const startX = centerX + minProjection * dirX;
        const startY = centerY + minProjection * dirY;
        const endX = centerX + maxProjection * dirX;
        const endY = centerY + maxProjection * dirY;
        
        return {
            startX,
            startY,
            endX,
            endY
        };
    }
    
    // 插值渐变颜色（不包含透明度）
    static interpolateGradientColor(stops: any[], position: number) {
        if (!stops || stops.length === 0) {
            return { red: 128, green: 128, blue: 128 };
        }
        
        if (stops.length === 1) {
            const color = stops[0].color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            return color ? {
                red: parseInt(color[1]),
                green: parseInt(color[2]),
                blue: parseInt(color[3])
            } : { red: 128, green: 128, blue: 128 };
        }
        
        // 找到位置两侧的stop
        let leftStop = stops[0];
        let rightStop = stops[stops.length - 1];
        
        for (let i = 0; i < stops.length - 1; i++) {
            if (stops[i].position <= position * 100 && stops[i + 1].position >= position * 100) {
                leftStop = stops[i];
                rightStop = stops[i + 1];
                break;
            }
        }
        
        const leftColor = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
         const rightColor = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
         
         if (!leftColor || !rightColor) {
             return { red: 128, green: 128, blue: 128, opacity: 100 };
         }
         
         // 解析透明度
         const leftOpacity = leftColor[4] !== undefined ? Math.round(parseFloat(leftColor[4]) * 100) : 100;
         const rightOpacity = rightColor[4] !== undefined ? Math.round(parseFloat(rightColor[4]) * 100) : 100;
         
         // 计算插值比例，考虑中点位置
         let ratio = (position * 100 - leftStop.position) / (rightStop.position - leftStop.position);
         
         // 如果存在中点信息，应用中点插值
         const midpoint = leftStop.midpoint ?? rightStop.midpoint ?? 50;
         if (midpoint !== 50) {
             const midpointRatio = midpoint / 100;
             if (ratio <= midpointRatio) {
                 // 在左侧停止点和中点之间
                 ratio = (ratio / midpointRatio) * 0.5;
             } else {
                 // 在中点和右侧停止点之间
                 ratio = 0.5 + ((ratio - midpointRatio) / (1 - midpointRatio)) * 0.5;
             }
         }
         
         return {
             red: Math.round(parseInt(leftColor[1]) * (1 - ratio) + parseInt(rightColor[1]) * ratio),
             green: Math.round(parseInt(leftColor[2]) * (1 - ratio) + parseInt(rightColor[2]) * ratio),
             blue: Math.round(parseInt(leftColor[3]) * (1 - ratio) + parseInt(rightColor[3]) * ratio),
             opacity: Math.round(leftOpacity * (1 - ratio) + rightOpacity * ratio)
         };
    }
    
    // 插值渐变颜色（包含透明度）
    static interpolateGradientColorWithOpacity(stops: any[], position: number) {
        if (!stops || stops.length === 0) {
            return { red: 128, green: 128, blue: 128, opacity: 100 };
        }
        
        if (stops.length === 1) {
            const color = stops[0].color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            const opacity = color && color[4] !== undefined ? Math.round(parseFloat(color[4]) * 100) : 100;
            return color ? {
                red: parseInt(color[1]),
                green: parseInt(color[2]),
                blue: parseInt(color[3]),
                opacity: opacity
            } : { red: 128, green: 128, blue: 128, opacity: 100 };
        }
        
        // 找到位置两侧的stop
        let leftStop = stops[0];
        let rightStop = stops[stops.length - 1];
        
        for (let i = 0; i < stops.length - 1; i++) {
            if (stops[i].position <= position * 100 && stops[i + 1].position >= position * 100) {
                leftStop = stops[i];
                rightStop = stops[i + 1];
                break;
            }
        }
        
        const leftColor = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        const rightColor = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        
        if (!leftColor || !rightColor) {
            return { red: 128, green: 128, blue: 128, opacity: 100 };
        }
        
        // 解析透明度
        const leftOpacity = leftColor[4] !== undefined ? Math.round(parseFloat(leftColor[4]) * 100) : 100;
        const rightOpacity = rightColor[4] !== undefined ? Math.round(parseFloat(rightColor[4]) * 100) : 100;
        
        // 计算插值比例，考虑中点位置
        let ratio = (position * 100 - leftStop.position) / (rightStop.position - leftStop.position);
        
        // 如果存在中点信息，应用中点插值
        const midpoint = leftStop.midpoint ?? rightStop.midpoint ?? 50;
        if (midpoint !== 50) {
            const midpointRatio = midpoint / 100;
            if (ratio <= midpointRatio) {
                // 在左侧停止点和中点之间
                ratio = (ratio / midpointRatio) * 0.5;
            } else {
                // 在中点和右侧停止点之间
                ratio = 0.5 + ((ratio - midpointRatio) / (1 - midpointRatio)) * 0.5;
            }
        }
        
        return {
            red: Math.round(parseInt(leftColor[1]) * (1 - ratio) + parseInt(rightColor[1]) * ratio),
            green: Math.round(parseInt(leftColor[2]) * (1 - ratio) + parseInt(rightColor[2]) * ratio),
            blue: Math.round(parseInt(leftColor[3]) * (1 - ratio) + parseInt(rightColor[3]) * ratio),
            opacity: Math.round(leftOpacity * (1 - ratio) + rightOpacity * ratio)
        };
    }



    //-------------------------------------------------------------------------------------------------
    // 应用新的混合公式计算最终灰度值（优化版本，避免栈溢出）
    static async calculateFinalGrayValues(
        maskData: Uint8Array, 
        fillData: Uint8Array, 
        isSelectedAreas: boolean = true, 
        opacity: number = 100,
        isEmpty: boolean = false,
        bounds?: any,
        topLeftIsEmpty: boolean = false,
        bottomRightIsEmpty: boolean = false,
        originalTopLeft: number = 0,
        originalBottomRight: number = 0,
        state?: any
    ): Promise<Uint8Array> {
        console.log('🔍 开始混合计算:', {
            maskDataLength: maskData.length,
            fillDataLength: fillData.length,
            isSelectedAreas: isSelectedAreas,
            isEmpty: isEmpty,
            topLeftIsEmpty: topLeftIsEmpty,
            bottomRightIsEmpty: bottomRightIsEmpty
        });
        
        // maskData现在是完整文档的快速蒙版数据，fillData是选区内填充的数据
        // 需要从maskData中提取出真正在选区内的像素数据
        const selectedMaskData = new Uint8Array(fillData.length);
        
        if (bounds && bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
            // 使用selectionDocIndices直接获取选区内像素
            let fillIndex = 0;
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
        
        // 预先计算选区索引数组，避免在循环中重复转换
        const selectionIndices = bounds.selectionDocIndices ? Array.from(bounds.selectionDocIndices) : null;
        
        // 检查是否有透明度信息需要处理（PNG图案自带透明区域或渐变透明度）
        // 注意：在清除模式下，只有当前正在清除的填充类型才应该生成透明度数据
        // 避免图案的透明度数据影响渐变的计算
        const isCurrentlyProcessingPattern = state?.fillMode === 'pattern';
        const isCurrentlyProcessingGradient = state?.fillMode === 'gradient';
        
        const hasPatternAlpha = isCurrentlyProcessingPattern && state?.selectedPattern && state.selectedPattern.hasAlpha && 
                               state.selectedPattern.patternRgbData && state.selectedPattern.patternComponents === 4;
        const hasGradientAlpha = isCurrentlyProcessingGradient && state?.selectedGradient;
        const hasAlpha = hasPatternAlpha || hasGradientAlpha;
        
        console.log('🔍 透明度检查:', {
            isCurrentlyProcessingPattern: isCurrentlyProcessingPattern,
            isCurrentlyProcessingGradient: isCurrentlyProcessingGradient,
            hasSelectedPattern: !!state?.selectedPattern,
            hasPatternAlpha: hasPatternAlpha,
            hasGradientAlpha: hasGradientAlpha,
            finalHasAlpha: hasAlpha
        });
        
        // 如果有透明度信息，生成对应的透明度数据
        let alphaData: Uint8Array | undefined;
        if (hasPatternAlpha && state?.selectedPattern) {
            const pattern = state.selectedPattern;
            const patternWidth = pattern.width || pattern.originalWidth || 100;
            const patternHeight = pattern.height || pattern.originalHeight || 100;
            const scale = pattern.currentScale || pattern.scale || 100;
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            const angle = pattern.currentAngle || pattern.angle || 0;
            
            if (pattern.fillMode === 'stamp') {
                // 盖图章模式：使用createStampPatternData生成透明度数据
                const stampAlphaResult = await ClearHandler.createStampPatternData(
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
                        const docIndex: number = selectionIndices[i];
                        const docX = docIndex % bounds.docWidth;
                        const docY = Math.floor(docIndex / bounds.docWidth);
                        const boundsX = docX - bounds.left;
                        const boundsY = docY - bounds.top;
                        
                        if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                            const boundsIndex = boundsY * bounds.width + boundsX;
                            if (boundsIndex < stampAlphaResult.alphaData.length) {
                                alphaData[i] = stampAlphaResult.alphaData[boundsIndex];
                            } else {
                                alphaData[i] = 0; // 图案外部为透明
                            }
                        } else {
                            alphaData[i] = 0; // 图案外部为透明
                        }
                    }
                }
            } else {
                // 贴墙纸模式：使用createTilePatternData生成透明度数据
                const alphaResult = ClearHandler.createTilePatternData(
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
                        const docIndex: number = selectionIndices[i];
                        const docX = docIndex % bounds.docWidth;
                        const docY = Math.floor(docIndex / bounds.docWidth);
                        const boundsX = docX - bounds.left;
                        const boundsY = docY - bounds.top;
                        
                        if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                            const boundsIndex = boundsY * bounds.width + boundsX;
                            if (boundsIndex < alphaResult.alphaData.length) {
                                alphaData[i] = alphaResult.alphaData[boundsIndex];
                            } else {
                                alphaData[i] = 0; // 图案外部为透明
                            }
                        } else {
                            alphaData[i] = 0; // 图案外部为透明
                        }
                    }
                }
            }
        } else if (hasGradientAlpha && state?.selectedGradient) {
            console.log('🌈 生成渐变透明度数据');
            alphaData = await this.generateGradientAlphaData(state, bounds);
        }
        
        // 如果当前不是正在处理的填充类型，不应该生成透明度数据
        if (!isCurrentlyProcessingPattern && !isCurrentlyProcessingGradient) {
            alphaData = undefined;
            console.log('⚠️ 当前不是正在处理的填充类型，跳过透明度数据生成');
        }
        
        if (hasAlpha) {
            console.log('🎨 透明度数据生成完成:', {
                hasAlphaData: !!alphaData,
                alphaDataLength: alphaData?.length,
                fillDataLength: fillData.length,
                sampleAlphaValues: alphaData ? Array.from(alphaData.slice(0, 10)) : null
            });
        }
        
        // 分批处理，避免一次性处理过多数据导致栈溢出
        const BATCH_SIZE = 10000; // 每批处理1万个像素
        
        for (let batchStart = 0; batchStart < fillData.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, fillData.length);
            
            await new Promise(resolve => {
                setTimeout(() => {
                    // 使用修正后的清除公式，支持PNG透明度处理
                    for (let i = batchStart; i < batchEnd; i++) {
                        const selectedMaskValue = selectedMaskData[i];  // 选区内快速蒙版像素值 (0-255)
                        let fillValue = fillData[i]; // 填充像素值 (0-255)
                        let effectiveOpacity = opacity; // 有效不透明度
                        
                        // 处理透明度信息（PNG图案自带透明区域或渐变透明度）
                        if (hasAlpha && alphaData && i < alphaData.length) {
                            const alpha = alphaData[i];
                            // 透明度影响有效不透明度：alpha=0时完全透明，不参与清除；alpha=255时完全不透明，正常清除
                            effectiveOpacity = Math.round(opacity * alpha / 255);
                        }
                        
                        // 应用修正后的清除公式，主面板不透明度转换为0-1范围
                        const opacityFactor = effectiveOpacity / 100;
                        
                        // 修正后的清除公式：
                        // 1. 当maskvalue=0时，结果始终为0
                        // 2. 当maskvalue>0时，根据fillvalue/255的比例删除相应百分比的灰度
                        // 3. fillvalue越大，删除的百分比越高，最终结果越小
                        // 4. 透明区域（effectiveOpacity=0）不参与清除，保持原始蒙版值
                        let finalValue;
                        if (selectedMaskValue === 0) {
                            // maskvalue为0时，结果始终为0
                            finalValue = 0;
                        } else if (effectiveOpacity === 0) {
                            // 完全透明区域，保持原始蒙版值，不参与清除
                            finalValue = selectedMaskValue;
                        } else {
                            // maskvalue>0且有效不透明度>0时，应用绝对删除公式（参考图层蒙版）
                            // 绝对公式：蒙版值 - (清除值 * 有效不透明度)
                            // 最终值 = maskValue - (fillValue * opacityFactor)
                            const subtractAmount = fillValue * opacityFactor;
                            finalValue = selectedMaskValue - subtractAmount;
                        }
                        
                        finalData[i] = Math.min(255, Math.max(0, Math.round(finalValue)));
                    }
                    resolve(void 0);
                }, 0);
            });
        }
        
        // 将计算结果映射回完整文档的newMaskValue中
        if (bounds && bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
            console.log('🎯 使用selectionDocIndices映射选区内的最终计算结果');
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            let resultIndex = 0;
            let mappedCount = 0;
            let featheredCount = 0;
            
            // 检查是否有羽化系数
            const hasFeathering = bounds.selectionCoefficients && bounds.selectionCoefficients.length > 0;
            if (hasFeathering) {
                console.log('🌟 检测到选区羽化系数，将应用羽化混合效果');
            }
            
            for (const docIndex of selectionIndices) {
                if (docIndex < newMaskValue.length && resultIndex < finalData.length) {
                    // 支持选区羽化：使用selectionCoefficients进行混合
                    if (hasFeathering && bounds.selectionCoefficients[resultIndex] !== undefined) {
                        const selectionCoefficient = bounds.selectionCoefficients[resultIndex];
                        const originalValue = isEmpty ? 0 : maskData[docIndex];
                        const newValue = finalData[resultIndex];
                        
                        // 羽化混合公式：最终值 = 原始值 * (1 - 羽化系数) + 新值 * 羽化系数
                        // 羽化系数越接近1，新值的影响越大；越接近0，原始值保持不变
                        const blendedValue = originalValue * (1 - selectionCoefficient) + newValue * selectionCoefficient;
                        newMaskValue[docIndex] = Math.round(Math.min(255, Math.max(0, blendedValue)));
                        
                        featheredCount++;
                    } else {
                        // 没有羽化信息时直接使用计算结果
                        newMaskValue[docIndex] = finalData[resultIndex];
                    }
                    
                    mappedCount++;
                    resultIndex++;
                }
            }
            
            console.log(`🎯 selectionDocIndices映射完成，映射了 ${mappedCount} 个像素`);
            if (featheredCount > 0) {
                console.log(`🌟 应用羽化效果的像素数量: ${featheredCount}`);
            }
        } else {
            return finalData;
        }
        
        // 如果是不完整蒙版，根据是否在选区内决定是否还原角落像素值
        if (topLeftIsEmpty) {
            console.log('🔄 检查是否需要还原左上角像素值');
            // 检查左上角是否在选区内
            const topLeftInSelection = maskData[0] !== 0;
            
            // 只有当像素不在选区内时，才将其还原为0
            if (!topLeftInSelection) {
                console.log('⚪ 左上角像素不在选区内，还原为0');
                newMaskValue[0] = 0;
            }
        }

        if (bottomRightIsEmpty) {
            console.log('🔄 检查是否需要还原右下角像素值');
            // 检查右下角是否在选区内
            const bottomRightInSelection = maskData[maskData.length - 1] !== 0;
            
            // 只有当像素不在选区内时，才将其还原为0
            if (!bottomRightInSelection) {
                console.log('⚪ 右下角像素不在选区内，还原为0');
                newMaskValue[newMaskValue.length - 1] = 0;
            }
        }
        
        return newMaskValue;
    }



    //-------------------------------------------------------------------------------------------------
    // 将计算后的灰度数据写回快速蒙版通道
    static async updateQuickMaskChannel(grayData: Uint8Array, bounds: any, state?: any) {
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
            
            // 根据state参数和bounds.selectionValues判断是否需要恢复选区
            if (state && state.deselectAfterFill === false && bounds && bounds.selectionValues && bounds.selectionValues.length > 0) {
                try {
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullSelectionData = new Uint8Array(finalDocWidth * finalDocHeight);
                    
                    if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                        const selectionIndices = Array.from(bounds.selectionDocIndices);
                        let valueIndex = 0;
                        
                        for (const docIndex of selectionIndices) {
                            if (docIndex < fullSelectionData.length && valueIndex < bounds.selectionValues.length) {
                                fullSelectionData[docIndex] = bounds.selectionValues[valueIndex];
                                valueIndex++;
                            } else if (valueIndex >= bounds.selectionValues.length) {
                                break; // 已经处理完所有选区值，提前退出循环
                            }
                        }
                    }
                    
                    // 创建选区ImageData
                    const selectionOptions = {
                        width: finalDocWidth,
                        height: finalDocHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: documentColorProfile,
                        colorSpace: "Grayscale"
                    };
                    
                    const selectionImageData = await imaging.createImageDataFromBuffer(fullSelectionData, selectionOptions);
                    
                    // 恢复选区
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: selectionImageData
                    });
                    
                    // 释放ImageData内存
                    selectionImageData.dispose();
                } catch (selectionError) {
                    console.error('❌ 恢复选区失败:', selectionError);
                }
            }
            
        } catch (error) {
            console.error('❌ 更新快速蒙版通道失败:', error);
        }
    }

    //-------------------------------------------------------------------------------------------------
    // 图层蒙版纯色清除
    static async clearLayerMaskSolidColor(layerInfo: any, state: any, opacity: number) {
        try {
            console.log('🎨 开始图层蒙版纯色清除');
            
            // 获取选区边界
            const bounds = await this.getSelectionData();
            if (!bounds) {
                console.log('❌ 无法获取选区边界');
                return;
            }
            
            // 获取当前图层ID
            const currentLayerId = await this.getCurrentLayerId();
            if (!currentLayerId) {
                console.log('❌ 无法获取当前图层ID');
                return;
            }
            
            // 获取图层蒙版像素数据
            const maskResult = await this.getLayerMaskPixels(bounds, currentLayerId);
            if (!maskResult) {
                console.log('❌ 无法获取图层蒙版像素数据');
                return;
            }
            
            const { maskData, selectedMaskData, stats } = maskResult;
            
            // 生成纯色灰度数据（固定为255，表示完全清除）
            const solidGrayData = new Uint8Array(selectedMaskData.length).fill(255);
            
            // 计算最终灰度值（减去模式）
            const finalGrayData = await this.calculateLayerMaskClearValues(
                selectedMaskData,
                solidGrayData,
                opacity,
                bounds,
                maskData,
                stats.isEmpty
            );
            
            // 更新图层蒙版
            await this.updateLayerMask(finalGrayData, bounds, currentLayerId, state);
        } catch (error) {
            console.error('❌ 图层蒙版纯色清除失败:', error);
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 图层蒙版图案清除
    static async clearLayerMaskPattern(layerInfo: any, state: any, opacity: number) {
        try {
            console.log('🎨 开始图层蒙版图案清除');
            
            // 获取选区边界
            const bounds = await this.getSelectionData();
            if (!bounds) {
                console.log('❌ 无法获取选区边界');
                return;
            }
            
            // 获取当前图层ID
            const currentLayerId = await this.getCurrentLayerId();
            if (!currentLayerId) {
                console.log('❌ 无法获取当前图层ID');
                return;
            }
            
            // 获取图层蒙版像素数据
            const maskResult = await this.getLayerMaskPixels(bounds, currentLayerId);
            if (!maskResult) {
                console.log('❌ 无法获取图层蒙版像素数据');
                return;
            }
            
            const { maskData, selectedMaskData, stats } = maskResult;
            
            // 获取图案灰度数据
            const patternGrayData = await this.getPatternFillGrayData(state, bounds);
            if (!patternGrayData) {
                console.log('❌ 无法获取图案灰度数据');
                return;
            }
            
            // 生成PNG透明度数据（如果图案支持透明度）
            const patternAlphaData = await this.generateLayerMaskAlphaData(state.selectedPattern, bounds);
            
            // 计算最终灰度值（减去模式，支持PNG透明度）
            const finalGrayData = await this.calculateLayerMaskClearValuesWithAlpha(
                selectedMaskData,
                patternGrayData,
                patternAlphaData,
                opacity,
                bounds,
                maskData,
                stats.isEmpty
            );
            
            // 更新图层蒙版
            await this.updateLayerMask(finalGrayData, bounds, currentLayerId, state);
        } catch (error) {
            console.error('❌ 图层蒙版图案清除失败:', error);
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 图层蒙版渐变清除
    static async clearLayerMaskGradient(layerInfo: any, state: any, opacity: number) {
        try {
            console.log('🎨 开始图层蒙版渐变清除');
            
            // 获取选区边界
            const bounds = await this.getSelectionData();
            if (!bounds) {
                console.log('❌ 无法获取选区边界');
                return;
            }
            
            // 获取当前图层ID
            const currentLayerId = await this.getCurrentLayerId();
            if (!currentLayerId) {
                console.log('❌ 无法获取当前图层ID');
                return;
            }
            
            // 获取图层蒙版像素数据
            const maskResult = await this.getLayerMaskPixels(bounds, currentLayerId);
            if (!maskResult) {
                console.log('❌ 无法获取图层蒙版像素数据');
                return;
            }
            
            const { maskData, selectedMaskData, stats } = maskResult;
            
            // 获取渐变灰度数据
            const gradientGrayData = await this.getGradientFillGrayData(state, bounds);
            if (!gradientGrayData) {
                console.log('❌ 无法获取渐变灰度数据');
                return;
            }
            
            // 为渐变生成透明度数据（基于渐变stops中的透明度信息）
            const gradientAlphaData = await this.generateGradientAlphaData(state, bounds);
            
            // 计算最终灰度值（减去模式，支持渐变透明度）
            const finalGrayData = await this.calculateLayerMaskClearValuesWithAlpha(
                selectedMaskData,
                gradientGrayData,
                gradientAlphaData,
                opacity,
                bounds,
                maskData,
                stats.isEmpty
            );
            
            // 更新图层蒙版
            await this.updateLayerMask(finalGrayData, bounds, currentLayerId, state);
        } catch (error) {
            console.error('❌ 图层蒙版渐变清除失败:', error);
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 获取当前激活图层的ID
    static async getCurrentLayerId() {
        try {
            const result = await action.batchPlay([
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
            
            return result[0]?.layerID;
        } catch (error) {
            console.error('❌ 获取当前图层ID失败:', error);
            return null;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 为渐变生成透明度数据（基于渐变stops中的透明度信息）
    static async generateGradientAlphaData(state: any, bounds: any): Promise<Uint8Array | null> {
        try {
            console.log('🌈 开始生成渐变透明度数据');
            
            const gradient = state.selectedGradient;
            if (!gradient || !gradient.stops) {
                console.log('⚠️ 没有渐变数据，返回完全不透明');
                return null;
            }
            
            // 检查是否有选区索引信息
            if (!bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('⚠️ 没有找到选区索引信息');
                return null;
            }
            
            // 只为选区内的像素生成透明度数据
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const alphaData = new Uint8Array(selectionIndices.length);
            
            // 计算渐变的中心点和角度（基于选区边界）
            const centerX = bounds.width / 2;
            const centerY = bounds.height / 2;
            
            // 使用与getGradientFillGrayData相同的算法计算起点和终点
            const gradientPoints = this.calculateGradientBounds(0, 0, bounds.width, bounds.height, gradient.angle || 0);
            
            let startX, startY, endX, endY;
            
            // 如果reverse为true，交换起点和终点
            if (gradient.reverse) {
                startX = gradientPoints.endX;
                startY = gradientPoints.endY;
                endX = gradientPoints.startX;
                endY = gradientPoints.startY;
            } else {
                startX = gradientPoints.startX;
                startY = gradientPoints.startY;
                endX = gradientPoints.endX;
                endY = gradientPoints.endY;
            }
            
            console.log('📊 开始为选区内', selectionIndices.length, '个像素计算渐变透明度');
            
            // 遍历选区内的每个像素
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex: number = selectionIndices[i];
                
                // 将文档索引转换为选区边界内的坐标
                const docX = docIndex % bounds.docWidth;
                const docY = Math.floor(docIndex / bounds.docWidth);
                const boundsX = docX - bounds.left;
                const boundsY = docY - bounds.top;
                
                let position;
                
                if (gradient.type === 'radial') {
                    // 径向渐变
                    const dx = boundsX - centerX;
                    const dy = boundsY - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
                    position = Math.min(1, distance / maxDistance);
                } else {
                    // 线性渐变
                    const dx = boundsX - startX;
                    const dy = boundsY - startY;
                    const gradientDx = endX - startX;
                    const gradientDy = endY - startY;
                    const gradientLengthSq = gradientDx * gradientDx + gradientDy * gradientDy;
                    
                    if (gradientLengthSq > 0) {
                        const dotProduct = dx * gradientDx + dy * gradientDy;
                        position = Math.max(0, Math.min(1, dotProduct / gradientLengthSq));
                    } else {
                        position = 0;
                    }
                }
                
                // 根据位置插值渐变透明度
                const colorWithOpacity = this.interpolateGradientColorWithOpacity(gradient.stops, position);
                
                // 将不透明度转换为0-255范围的透明度值
                alphaData[i] = Math.round((colorWithOpacity.opacity / 100) * 255);
            }
            
            console.log('✅ 渐变透明度数据生成完成，数据长度:', alphaData.length);
            return alphaData;
        } catch (error) {
            console.error('❌ 生成渐变透明度数据失败:', error);
            return null;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 为图层蒙版模式生成PNG透明度数据
    static async generateLayerMaskAlphaData(pattern: Pattern, bounds: any): Promise<Uint8Array | null> {
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
                alphaResult = await this.createStampPatternData(
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
                alphaResult = this.createTilePatternData(
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
                    const docIndex: number = selectionIndices[i];
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
    
    //-------------------------------------------------------------------------------------------------
    // 获取图层蒙版通道的像素数据
    static async getLayerMaskPixels(bounds: any, layerId: number) {
        try {
            console.log('🎭 开始获取图层蒙版数据，图层ID:', layerId);
            
            // 根据官方文档，使用getLayerMask获取完整文档的图层蒙版像素数据
            // 添加sourceBounds参数以符合API规范
            const pixels = await imaging.getLayerMask({
                documentID: app.activeDocument.id,
                layerID: layerId,
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
                const docIndex: number = selectionIndices[i];
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
                const docIndex: number = selectionIndices[i];
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
                console.warn(`⚠️ ${outOfRangeCount}个索引超出范围，使用默认值0`);
            }
            
            // 计算提取数据的统计信息
            let extractedMin = 255, extractedMax = 0;
            let blackPixels = 0, whitePixels = 0;
            let isEmpty = true;
            
            for (let i = 0; i < maskPixels.length; i++) {
                const value = maskPixels[i];
                if (value > 0) isEmpty = false;
                extractedMin = Math.min(extractedMin, value);
                extractedMax = Math.max(extractedMax, value);
                if (value === 0) blackPixels++;
                if (value === 255) whitePixels++;
            }
            
            const stats = {
                minValue: extractedMin,
                maxValue: extractedMax,
                blackPixels,
                whitePixels,
                isEmpty
            };
            
            console.log('🎯 图层蒙版选区内像素数量:', selectionSize);
            console.log('🎯 提取的蒙版数据统计: 最小值=', extractedMin, '最大值=', extractedMax);
            console.log('📊 图层蒙版统计信息:', stats);
            
            // 释放ImageData内存
            pixels.imageData.dispose();
            
            return {
                maskData: fullDocMaskArray,
                selectedMaskData: maskPixels,
                stats
            };
        } catch (error) {
            console.error('❌ 获取图层蒙版像素数据失败:', error);
            throw error;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 计算图层蒙版清除的最终灰度值（减去模式，支持选区羽化）
    static async calculateLayerMaskClearValues(
        selectedMaskData: Uint8Array,
        clearData: Uint8Array,
        opacity: number,
        bounds: any,
        maskData: Uint8Array,
        isEmpty: boolean
    ) {
        try {
            console.log('🧮 计算最终灰度值（减去模式，支持选区羽化）');
            
            const finalData = new Uint8Array(selectedMaskData.length);
            const newMaskValue = new Uint8Array(maskData.length);
            
            // 复制原始蒙版数据
            newMaskValue.set(maskData);
            
            // 检查是否有选区羽化系数
            const hasFeathering = bounds.selectionCoefficients && bounds.selectionCoefficients.length > 0;
            const opacityFactor = opacity / 100;
            
            // 分批处理，避免一次性处理过多数据导致栈溢出
            const BATCH_SIZE = 10000;
            
            for (let batchStart = 0; batchStart < selectedMaskData.length; batchStart += BATCH_SIZE) {
                const batchEnd = Math.min(batchStart + BATCH_SIZE, selectedMaskData.length);
                
                await new Promise(resolve => {
                    setTimeout(() => {
                        // 使用减去模式的清除公式，支持选区羽化
                        for (let i = batchStart; i < batchEnd; i++) {
                            const maskValue = selectedMaskData[i];  // 蒙版像素值 (0-255)
                            const clearValue = clearData[i]; // 清除像素值 (0-255)
                            
                            // 计算有效不透明度（考虑选区羽化系数）
                            let effectiveOpacity = opacityFactor;
                            if (hasFeathering && i < bounds.selectionCoefficients.length) {
                                effectiveOpacity *= bounds.selectionCoefficients[i];
                            }
                            
                            // 减去模式：蒙版值 - 清除值 * 有效不透明度
                            const subtractAmount = clearValue * effectiveOpacity;
                            const finalValue = maskValue - subtractAmount;
                            
                            finalData[i] = Math.min(255, Math.max(0, Math.round(finalValue)));
                        }
                        resolve(void 0);
                    }, 0);
                });
            }
            
            // 将计算结果映射回完整文档的newMaskValue中
            if (bounds && bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                const selectionIndices = Array.from(bounds.selectionDocIndices);
                let resultIndex = 0;
                
                for (const docIndex of selectionIndices) {
                    if (docIndex < newMaskValue.length && resultIndex < finalData.length) {
                        newMaskValue[docIndex] = finalData[resultIndex];
                        resultIndex++;
                    }
                }
            }
            
            return newMaskValue;
        } catch (error) {
            console.error('❌ 计算最终灰度值失败:', error);
            return null;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 计算图层蒙版清除的最终灰度值（减去模式，支持PNG透明度和选区羽化）
    static async calculateLayerMaskClearValuesWithAlpha(
        selectedMaskData: Uint8Array,
        clearData: Uint8Array,
        alphaData: Uint8Array | null,
        opacity: number,
        bounds: any,
        maskData: Uint8Array,
        isEmpty: boolean
    ) {
        try {
            console.log('🧮 计算最终灰度值（减去模式，支持PNG透明度和选区羽化）');
            
            const finalData = new Uint8Array(selectedMaskData.length);
            const newMaskValue = new Uint8Array(maskData.length);
            
            // 复制原始蒙版数据
            newMaskValue.set(maskData);
            
            // 检查是否有选区羽化系数
            const hasFeathering = bounds.selectionCoefficients && bounds.selectionCoefficients.length > 0;
            const opacityFactor = opacity / 100;
            
            // 分批处理，避免一次性处理过多数据导致栈溢出
            const BATCH_SIZE = 10000;
            
            for (let batchStart = 0; batchStart < selectedMaskData.length; batchStart += BATCH_SIZE) {
                const batchEnd = Math.min(batchStart + BATCH_SIZE, selectedMaskData.length);
                
                await new Promise(resolve => {
                    setTimeout(() => {
                        // 使用减去模式的清除公式，支持PNG透明度和选区羽化
                        for (let i = batchStart; i < batchEnd; i++) {
                            const maskValue = selectedMaskData[i];  // 蒙版像素值 (0-255)
                            const clearValue = clearData[i]; // 清除像素值 (0-255)
                            const alpha = alphaData ? alphaData[i] : 255; // PNG透明度 (0-255)
                            
                            // 如果图案完全透明，不进行清除操作
                            if (alpha === 0) {
                                finalData[i] = maskValue;
                                continue;
                            }
                            
                            // 计算有效不透明度（考虑选区羽化系数）
                            let effectiveOpacity = opacityFactor;
                            if (hasFeathering && i < bounds.selectionCoefficients.length) {
                                effectiveOpacity *= bounds.selectionCoefficients[i];
                            }
                            
                            // 减去模式：蒙版值 - (清除值 * 有效不透明度 * PNG透明度)
                            const alphaFactor = alpha / 255;
                            const subtractAmount = clearValue * effectiveOpacity * alphaFactor;
                            const finalValue = maskValue - subtractAmount;
                            
                            finalData[i] = Math.min(255, Math.max(0, Math.round(finalValue)));
                        }
                        resolve(void 0);
                    }, 0);
                });
            }
            
            // 将计算结果映射回完整文档的newMaskValue中
            if (bounds && bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                const selectionIndices = Array.from(bounds.selectionDocIndices);
                let resultIndex = 0;
                
                for (const docIndex of selectionIndices) {
                    if (docIndex < newMaskValue.length && resultIndex < finalData.length) {
                        newMaskValue[docIndex] = finalData[resultIndex];
                        resultIndex++;
                    }
                }
            }
            
            console.log('✅ 支持PNG透明度的图层蒙版清除计算完成');
            return newMaskValue;
        } catch (error) {
            console.error('❌ 计算最终灰度值失败:', error);
            return null;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 更新图层蒙版
    static async updateLayerMask(grayData: Uint8Array, bounds: any, layerId: number, state?: any) {
        try {
            
            let documentColorProfile = "Dot Gain 15%";
            
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);
            const expectedSize = finalDocWidth * finalDocHeight;
            
            
            // 验证数据大小
            if (grayData.length !== expectedSize) {
                console.error('❌ 图层蒙版数据大小不匹配');
                console.error('期望大小:', expectedSize, '实际大小:', grayData.length);
                
                // 创建正确大小的数据缓冲区
                const correctedData = new Uint8Array(expectedSize);
                
                // 如果数据太小，用0填充；如果太大，截断
                const copySize = Math.min(grayData.length, expectedSize);
                correctedData.set(grayData.subarray(0, copySize));
                
                console.log('🔧 已创建修正后的数据缓冲区，大小:', correctedData.length);
                grayData = correctedData;
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
            
            const fullImageData = await imaging.createImageDataFromBuffer(grayData, fullOptions);
            
            // 更新图层蒙版
            await imaging.putLayerMask({
                documentID: app.activeDocument.id,
                layerID: layerId,
                imageData: fullImageData
            });
            
            fullImageData.dispose();
            
            // 根据state参数和bounds.selectionValues判断是否需要恢复选区
             if (state && state.deselectAfterFill === false && bounds && bounds.selectionValues && bounds.selectionValues.length > 0) {
                try {
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullSelectionData = new Uint8Array(finalDocWidth * finalDocHeight);
                    
                    if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                        const selectionIndices = Array.from(bounds.selectionDocIndices);
                        let valueIndex = 0;
                        
                        for (const docIndex of selectionIndices) {
                            if (docIndex < fullSelectionData.length && valueIndex < bounds.selectionValues.length) {
                                fullSelectionData[docIndex] = bounds.selectionValues[valueIndex];
                                valueIndex++;
                            } else if (valueIndex >= bounds.selectionValues.length) {
                                break; // 已经处理完所有选区值，提前退出循环
                            }
                        }
                    }
                    
                    // 创建选区ImageData
                    const selectionOptions = {
                        width: finalDocWidth,
                        height: finalDocHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: documentColorProfile,
                        colorSpace: "Grayscale"
                    };
                    
                    const selectionImageData = await imaging.createImageDataFromBuffer(fullSelectionData, selectionOptions);
                    
                    // 恢复选区
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: selectionImageData
                    });
                    
                    // 释放ImageData内存
                    selectionImageData.dispose();
                    
                } catch (selectionError) {
                    console.error('❌ 恢复选区失败:', selectionError);
                }
            }
            
        } catch (error) {
            console.error('❌ 更新图层蒙版失败:', error);
        }
    }

    }
