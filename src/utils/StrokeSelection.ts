import { app, action, core, imaging } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { AppState } from '../types/state';

// 计算RGB颜色的灰度值
function rgbToGray(red: number, green: number, blue: number): number {
    // 使用标准的灰度转换公式：0.299*R + 0.587*G + 0.114*B
    return Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
}

const { executeAsModal } = core;
const { batchPlay } = action;

interface LayerInfo {
    hasPixels: boolean;
    isInQuickMask: boolean;
    isInLayerMask: boolean;
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

    // 如果在图层蒙版状态，使用图层蒙版描边
    if (layerInfo?.isInLayerMask) {
        // 如果同时开启了清除模式，使用图层蒙版清除模式描边
        if (state.clearMode) {
            await strokeSelectionInLayerMaskWithClearMode(strokeParams);
        } else {
            await strokeSelectionInLayerMask(strokeParams);
        }
        return;
    }

    // 如果在像素图层且开启了清除模式，使用清除模式描边
    if (state.clearMode) {
        await strokeSelectionWithClearMode(strokeParams);
        return;
    }

    // 像素图层的普通描边
    await strokeSelectionNormal(strokeParams);
}

// 1.像素图层的普通描边√
async function strokeSelectionNormal(strokeParams: any) {
    try {
        console.log('🔄 开始非快速蒙版普通描边，描边参数:', strokeParams);
        
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

        // 2. 记录前景色
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

        // 3. 描边
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

        // 4. 根据用户描边面板的不透明度和混合模式修改描边图层不透明度和混合模式
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
        
        // 5. 向下合并图层
        await batchPlay(
            [{
                _obj: "mergeLayersNew",
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        // 6. 恢复前景色
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

        console.log("✅ 普通描边完成");
    } catch (error) {
        console.error("❌ 普通描边失败:", error);
        throw error;
    }
}

// 2.像素图层的清除模式的特殊描边√
async function strokeSelectionWithClearMode(strokeParams: any) {
    try {
        console.log('🔄 开始非快速蒙版清除模式描边，描边参数:', strokeParams);
        
        // 1. 记录前景色
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

        // 获取当前前景色的RGB值并计算灰度值
        let foregroundRGB;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            foregroundRGB = {
                red: foregroundColor.rgb.red,
                green: foregroundColor.rgb.green,
                blue: foregroundColor.rgb.blue
            };
        });
        
        // 计算前景色灰度值
        const foregroundGrayValue = rgbToGray(foregroundRGB.red, foregroundRGB.green, foregroundRGB.blue);
        console.log('🎨 前景色RGB:', foregroundRGB, '灰度值:', foregroundGrayValue);
        
        // 计算清除模式描边的不透明度：(前景色灰度值/255) * .subpanel-fill 中的不透明度
        const clearModeOpacity = (foregroundGrayValue / 255) * strokeParams.opacity;
        console.log('🔧 清除模式不透明度:', clearModeOpacity);

        // 2. 以清除模式描边
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
                    _value: clearModeOpacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: "clearEnum"
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
        console.log('✅ 清除模式描边完成');

        // 3. 恢复前景色
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
            console.log('✅ 已恢复前景色');
        }

        console.log('✅ 非快速蒙版清除模式描边完成');
    } catch (error) {
        console.error('❌ 非快速蒙版清除模式描边失败:', error);
        throw error;
    }
}

// 3.快速蒙版状态下的普通描边√
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

// 4.快速蒙版状态且清除模式下的特殊描边
async function strokeSelectionWithColorCalculation(strokeParams: any, state: any) {
    try {
        console.log('🔄 开始清除模式快速蒙版描边，描边参数:', strokeParams);
        
        // 1. 获取快速蒙版通道信息，判断是否为selectedAreas
        const channelResult = await batchPlay([
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

        let isSelectedAreas = false;
        if (channelResult[0] && 
            channelResult[0].alphaChannelOptions && 
            channelResult[0].alphaChannelOptions.colorIndicates) {
            isSelectedAreas = channelResult[0].alphaChannelOptions.colorIndicates._value === "selectedAreas";
        }
        console.log(`🔍 检测到colorIndicates为${isSelectedAreas ? 'selectedAreas' : '非selectedAreas'}`);
        
        // 2. 记录前景色
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

        // 3. 根据selectedAreas状态选择混合模式执行描边
        const blendMode = isSelectedAreas ? "linearDodge" : "blendSubtraction";
        console.log(`🎨 使用混合模式: ${blendMode}`);
        
        await batchPlay(
            [{
                _obj: "stroke",
                width: strokeParams.width,
                location: {
                    _enum: "strokeLength",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: strokeParams.opacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: blendMode
                },
                color: {
                    _obj: "RGBColorClass",
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
        console.log('✅ 描边执行完成');

        // 4. 恢复前景色
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
            console.log('✅ 已恢复前景色');
        }

    } catch (error) {
        console.error("❌ 清除模式快速蒙版描边失败:", error);
        throw error;
    }
}

// 5.图层蒙版状态下的普通描边
async function strokeSelectionInLayerMask(strokeParams: any) {
    try {
        console.log('🔄 开始图层蒙版普通描边，描边参数:', strokeParams);
        
        // 1. 记录前景色
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

        // 2. 根据获取的描边参数与颜色，描边
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
            }],
            { synchronousExecution: true }
        );
        console.log('✅ 图层蒙版描边执行完成');

        // 3. 恢复前景色
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
            console.log('✅ 已恢复前景色');
        }

        console.log('✅ 图层蒙版普通描边完成');
    } catch (error) {
        console.error('❌ 图层蒙版普通描边失败:', error);
        throw error;
    }
}

// 6.图层蒙版状态下的清除模式特殊描边
async function strokeSelectionInLayerMaskWithClearMode(strokeParams: any) {
    try {
        console.log('🔄 开始图层蒙版清除模式描边，描边参数:', strokeParams);
        
        // 1. 记录前景色
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

        // 2. 根据获取的描边参数与颜色，描边，混合模式固定为减去
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
                    _value: strokeParams.opacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: "blendSubtraction"  // 固定为减去模式
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
        console.log('✅ 图层蒙版清除模式描边执行完成');

        // 3. 恢复前景色
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
            console.log('✅ 已恢复前景色');
        }

        console.log('✅ 图层蒙版清除模式描边完成');
    } catch (error) {
        console.error('❌ 图层蒙版清除模式描边失败:', error);
        throw error;
    }
}
