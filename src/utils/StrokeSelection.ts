import { app, action, core, imaging } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { AppState } from '../types/state';

const { executeAsModal } = core;
const { batchPlay } = action;

interface LayerInfo {
    hasPixels: boolean;
    isInQuickMask: boolean;
}

export async function strokeSelection(state: AppState, layerInfo?: LayerInfo) {
    if (!state.strokeEnabled) return;
    
    const strokeParams = {
        width: state.strokeWidth || 2,
        position: state.strokePosition || "center",
        opacity: state.strokeOpacity || 100,
        blendMode: state.strokeBlendMode || "normal",
        color: {
            red: state.strokeColor.red || 0,
            green: state.strokeColor.green || 0,
            blue: state.strokeColor.blue || 0
        }
    };

    // 如果在快速蒙版状态，使用简化的直接描边
    if (layerInfo?.isInQuickMask) {
        // 如果同时开启了清除模式，使用特殊的颜色计算描边
        if (state.clearMode) {
            await strokeSelectionWithColorCalculation(strokeParams, state);
        } else {
            await strokeSelectionDirect(strokeParams);
        }
        return;
    }

    try {
        // 1. 新建准备描边的空白图层
        await batchPlay(
            [{
                _obj: "make",
                _target: [
                    {
                        _ref: "layer"
                    }
                ],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );
        console.log("✅ 新建图层成功");

        // 2. 根据位置调整选区
        if (strokeParams.position === "inside") {
            await batchPlay(
                [{
                    _obj: "contract",
                    by: {
                        _unit: "pixelsUnit",
                        _value: strokeParams.width / 2
                    },
                    selectionModifyEffectAtCanvasBounds: false,
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true }
            );
        } else if (strokeParams.position === "outside") {
            await batchPlay(
                [{
                    _obj: "expand",
                    by: {
                        _unit: "pixelsUnit",
                        _value: strokeParams.width / 2
                    },
                    selectionModifyEffectAtCanvasBounds: false,
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true }
            );
        }

        // 3. 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });

        // 4. 描边
        await batchPlay(
            [{
                _obj: "stroke",
                width: {
                    _unit: "pixelsUnit",
                    _value: strokeParams.width
                },
                location: {
                    _enum: "strokeLocation",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: 100
                },
                mode: {
                    _enum: "blendMode",
                    _value: "normal"
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        // 5. 根据用户描边面板的不透明度和混合模式修改描边图层不透明度和混合模式
        await batchPlay(
            [{
                _obj: "set",
                _target: [
                    {
                        _ref: "layer",
                        _enum: "ordinal",
                        _value: "targetEnum"
                    }
                ],
                to: {
                    _obj: "layer",
                    opacity: {
                        _unit: "percentUnit",
                        _value: strokeParams.opacity
                    },
                    mode: {
                        _enum: "blendMode",
                        _value: BLEND_MODES[strokeParams.blendMode] || "normal"
                    }
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );
        
        // 6. 向下合并图层
        await batchPlay(
            [{
                _obj: "mergeLayersNew",
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        // 7. 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
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
                }],
                { synchronousExecution: true }
            );
        }

        console.log("✅ 描边完成");
    } catch (error) {
        console.error("❌ 描边失败:", error);
        throw error;
    }
}

// 快速蒙版状态下的直接描边
async function strokeSelectionDirect(strokeParams: any) {
    try {
        // 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });

        const strokeDirect = {
            _obj: "stroke",
            width: strokeParams.width,
            location: {
                _enum: "strokeLocation",
                _value: strokeParams.position
            },
            opacity: {
                _unit: "percentUnit",
                _value: strokeParams.opacity
            },
            mode: {
                _enum: "blendMode",
                _value: BLEND_MODES[strokeParams.blendMode] || "normal"
            },
            color: {
                _obj: "RGBColor",
                red: strokeParams.color.red,
                green: strokeParams.color.green,
                blue: strokeParams.color.blue
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        await batchPlay([strokeDirect], { synchronousExecution: true });

        // 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
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
                }],
                { synchronousExecution: true }
            );
        }

    } catch (error) {
        console.error("❌ 快速蒙版描边失败:", error);
        throw error;
    }
}

// 清除模式下快速蒙版状态的特殊描边（使用颜色计算）
async function strokeSelectionWithColorCalculation(strokeParams: any, state: any) {
    try {
        console.log('🔄 开始清除模式快速蒙版描边，描边参数:', strokeParams);
        
        // 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });
        console.log('✅ 已保存前景色');

        // 获取选区边界信息
        const selectionBounds = await getSelectionBounds();
        if (!selectionBounds) {
            console.warn('❌ 没有选区，无法执行清除模式描边');
            return;
        }
        console.log('✅ 获取选区边界成功:', selectionBounds);

        // 获取快速蒙版通道的像素数据
        const quickMaskPixels = await getQuickMaskPixels(selectionBounds);
        console.log('✅ 获取快速蒙版像素数据成功，数据长度:', quickMaskPixels.length);
        
        // 计算描边颜色的灰度值
        const strokeGrayValue = rgbToGray(strokeParams.color.red, strokeParams.color.green, strokeParams.color.blue);
        console.log('🎨 描边颜色灰度值:', strokeGrayValue, 'RGB:', strokeParams.color);
        
        // 创建描边区域的灰度数据
        const strokeGrayData = await createStrokeGrayData(selectionBounds, strokeParams, strokeGrayValue);
        console.log('✅ 创建描边灰度数据成功，数据长度:', strokeGrayData.length);
        
        // 应用新的混合公式计算最终灰度值
        const finalGrayData = calculateFinalGrayValues(quickMaskPixels, strokeGrayData);
        console.log('✅ 计算最终灰度值成功，数据长度:', finalGrayData.length);
        
        // 将计算后的灰度数据写回快速蒙版通道
        await updateQuickMaskChannel(finalGrayData, selectionBounds);

        // 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
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
                }],
                { synchronousExecution: true }
            );
        }

    } catch (error) {
        console.error("❌ 清除模式快速蒙版描边失败:", error);
        throw error;
    }
}

// 获取选区边界信息
async function getSelectionBounds() {
    try {
        const result = await batchPlay([
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
        ], { synchronousExecution: true });
        
        if (result[0] && result[0].selection && result[0].selection.bottom !== undefined) {
            const selection = result[0].selection;
            return {
                left: selection.left._value,
                top: selection.top._value,
                right: selection.right._value,
                bottom: selection.bottom._value,
                width: selection.right._value - selection.left._value,
                height: selection.bottom._value - selection.top._value
            };
        }
        return null;
    } catch (error) {
        console.error('获取选区边界失败:', error);
        return null;
    }
}

// 获取快速蒙版通道的像素数据
async function getQuickMaskPixels(bounds: any) {
    try {
        console.log('🔍 尝试获取快速蒙版像素数据，边界:', bounds);
        // 使用imaging API获取快速蒙版通道的像素数据
        const pixels = await imaging.getPixels({
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
            channelID: "mask" // 获取快速蒙版通道
        });
        
        const data = await pixels.imageData.getData();
        console.log('✅ 成功获取快速蒙版像素数据，数据类型:', data.constructor.name, '长度:', data.length);
        return data;
    } catch (error) {
        console.error('❌ 获取快速蒙版像素数据失败:', error);
        console.log('🔄 使用默认数据替代');
        // 如果无法直接获取快速蒙版，创建默认数据
        const pixelCount = bounds.width * bounds.height;
        const grayData = new Uint8Array(pixelCount);
        grayData.fill(0); // 假设选区内都是0（黑色）
        console.log('✅ 创建默认快速蒙版数据，长度:', grayData.length);
        return grayData;
    }
}

// 创建描边区域的灰度数据
async function createStrokeGrayData(bounds: any, strokeParams: any, strokeGrayValue: number) {
    const pixelCount = bounds.width * bounds.height;
    const strokeData = new Uint8Array(pixelCount);
    
    // 根据描边位置创建描边蒙版
    const strokeWidth = strokeParams.width;
    
    for (let y = 0; y < bounds.height; y++) {
        for (let x = 0; x < bounds.width; x++) {
            const index = y * bounds.width + x;
            let isStrokePixel = false;
            
            // 简化的描边检测：检查是否在边界附近
            if (strokeParams.position === "inside") {
                // 内描边：距离边界strokeWidth像素内
                if (x < strokeWidth || y < strokeWidth || 
                    x >= bounds.width - strokeWidth || y >= bounds.height - strokeWidth) {
                    isStrokePixel = true;
                }
            } else if (strokeParams.position === "outside") {
                // 外描边：扩展选区边界
                isStrokePixel = true; // 简化处理，整个选区都是描边
            } else {
                // 居中描边：边界两侧各strokeWidth/2像素
                const halfWidth = strokeWidth / 2;
                if (x < halfWidth || y < halfWidth || 
                    x >= bounds.width - halfWidth || y >= bounds.height - halfWidth) {
                    isStrokePixel = true;
                }
            }
            
            strokeData[index] = isStrokePixel ? strokeGrayValue : 0;
        }
    }
    
    return strokeData;
}

// 将RGB颜色转换为灰度值
function rgbToGray(red: number, green: number, blue: number) {
    return Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
}

// 应用新的混合公式计算最终灰度值
function calculateFinalGrayValues(maskData: Uint8Array, fillData: Uint8Array) {
    const finalData = new Uint8Array(maskData.length);
    
    for (let i = 0; i < maskData.length; i++) {
        const maskValue = maskData[i];  // 快速蒙版像素值 (0-255)
        const fillValue = fillData[i];  // 填充内容像素灰度值 (0-255)
        
        // 应用公式：maskValue + fillValue - (maskValue * fillValue) / 255
        const finalValue = maskValue + fillValue - (maskValue * fillValue) / 255;
        finalData[i] = Math.min(255, Math.max(0, Math.round(finalValue)));
    }
    
    return finalData;
}

// 将计算后的灰度数据写回快速蒙版通道
async function updateQuickMaskChannel(grayData: Uint8Array, bounds: any) {
    try {
        console.log('🔄 开始更新快速蒙版通道，数据长度:', grayData.length, '边界:', bounds);
        
        // 创建PhotoshopImageData对象，快速蒙版是选区，使用putSelection API
        const options = {
            width: bounds.width,
            height: bounds.height,
            components: 1,
            chunky: false,  // 对于单通道灰度图像使用false
            colorSpace: "Grayscale",
            colorProfile: "Dot Gain 15%"  // 根据示例代码添加颜色配置文件
        };
        
        console.log('🔧 创建ImageData选项:', options);
        const imageData = await imaging.createImageDataFromBuffer(grayData, options);
        console.log('✅ 成功创建ImageData对象');
        
        // 快速蒙版实际上是选区，使用putSelection而不是putPixels
        const putSelectionOptions = {
            documentID: app.activeDocument.id,
            imageData: imageData
        };
        
        console.log('🔧 putSelection选项:', putSelectionOptions);
        await imaging.putSelection(putSelectionOptions);
        console.log('✅ 成功更新快速蒙版选区');
        
        // 释放图像数据
        imageData.dispose();
        console.log('✅ 已释放ImageData对象');
        
    } catch (error) {
        console.error('❌ 更新快速蒙版通道失败:', error);
        console.log('🔄 尝试使用备用方法更新快速蒙版');
        // 如果直接写入失败，尝试通过其他方式
        await fallbackUpdateQuickMask(grayData, bounds);
    }
}

// 备用方法：通过其他方式更新快速蒙版
async function fallbackUpdateQuickMask(grayData: Uint8Array, bounds: any) {
    try {
        console.log('🔄 执行备用快速蒙版更新方法');
        
        // 计算平均灰度值作为色阶调整的参考
        const avgGray = grayData.reduce((sum, val) => sum + val, 0) / grayData.length;
        const outputMin = Math.round(avgGray);
        
        console.log('📊 计算得到的平均灰度值:', avgGray, '输出最小值:', outputMin);
        console.log('⚠️  注意：备用方法只能模拟效果，无法实现精确的像素级混合');
        
        // 使用色阶调整来模拟效果
        await batchPlay([
            {
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
                            _enum: "ordinal",
                            _value: "targetEnum"
                        },
                        output: [
                            outputMin,
                            255
                        ]
                    }
                ],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], { synchronousExecution: true });
        
        console.log('✅ 备用快速蒙版更新成功，使用色阶调整模拟效果');
        console.log('💡 建议：如果需要精确效果，请检查imaging API的使用是否正确');
    } catch (error) {
        console.error('❌ 备用快速蒙版更新方法也失败:', error);
    }
}

