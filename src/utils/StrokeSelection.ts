import { app, action, core } from 'photoshop';
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

        // 获取快速蒙版通道信息
        const quickMaskChannelInfo = await getQuickMaskChannelInfo();
        
        // 计算特殊颜色：C = A * (255 + B) / 255
        const maskValue = 128; // 简化处理，实际需要从quickMaskChannelInfo中获取
        const panelColor = strokeParams.color;
        const finalColor = calculateFinalStrokeColor(maskValue, panelColor);

        const strokeWithCalculation = {
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
                _value: "normal" // 强制使用正常混合模式
            },
            color: {
                _obj: "RGBColor",
                red: finalColor.red,
                green: finalColor.green,
                blue: finalColor.blue
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        await batchPlay([strokeWithCalculation], { synchronousExecution: true });

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

// 获取快速蒙版通道信息
async function getQuickMaskChannelInfo() {
    try {
        const result = await batchPlay([
            {
                _obj: "get",
                _target: [
                    {
                        _ref: "channel",
                        _name: "Quick Mask"
                    }
                ]
            }
        ], { synchronousExecution: true });
        
        return result[0] || {};
    } catch (error) {
        console.error('获取快速蒙版通道信息失败:', error);
        return {};
    }
}

// 计算描边的最终颜色：C = A * (255 + B) / 255
function calculateFinalStrokeColor(maskValue: number, panelColor: any) {
    const A = maskValue; // 快速蒙版像素值 (0-255)
    const B = {
        red: panelColor.red || 0,
        green: panelColor.green || 0,
        blue: panelColor.blue || 0
    };
    
    return {
        red: Math.min(255, Math.round(A * (255 + B.red) / 255)),
        green: Math.min(255, Math.round(A * (255 + B.green) / 255)),
        blue: Math.min(255, Math.round(A * (255 + B.blue) / 255))
    };
}

