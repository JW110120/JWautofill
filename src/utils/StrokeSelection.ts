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

        await strokeSelectionDirect(strokeParams);
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

