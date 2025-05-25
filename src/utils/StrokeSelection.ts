import { app, action, core } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';

const { executeAsModal } = core;
const { batchPlay } = action;

export async function strokeSelection(state: AppState) {
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

    const halfWidth = strokeParams.width / 2;
    const strokeWidthFix = Math.floor(halfWidth);

    try {
        // 1. 根据位置调整选区
        if (strokeParams.position === "inside") {
            await batchPlay(
                [{
                    _obj: "contract",
                    by: {
                        _unit: "pixelsUnit",
                        _value: strokeWidthFix
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
                        _value: strokeWidthFix
                    },
                    selectionModifyEffectAtCanvasBounds: false,
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true }
            );
        }


      

        
        // 2. 选择画笔工具
          await batchPlay(
            [{
                _obj: "select",
                _target: [{
                    _ref: "paintbrushTool"
                }],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        // 3. 设置画笔大小
        await batchPlay(
            [{
                _obj: "set",
                _target: [{
                    _ref: "brush",
                    _enum: "ordinal",
                    _value: "targetEnum"
                }],
                to: {
                    _obj: "brush",
                    masterDiameter: {
                        _unit: "pixelsUnit",
                        _value: strokeParams.width
                    }
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        // 4. 新建特制描边笔刷
        const brushName = `描边_${strokeParams.width}_${Date.now()}`;
        await batchPlay(
            [{
                _obj: "make",
                _target: [{
                    _ref: "brush"
                }],
                name: brushName,
                using: {
                    _ref: [{
                        _ref: "property",
                        _property: "currentToolOptions"
                    }, {
                        _ref: "application",
                        _enum: "ordinal",
                        _value: "targetEnum"
                    }]
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }], 
            { synchronousExecution: true }
        );

        // 5. 选中特制笔刷
        await batchPlay(
            [{
                _obj: "select",
                _target: [{
                    _ref: "brush",
                    _name: brushName
                }],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        // 6. 从选区新建路径
        await batchPlay(
            [{
                _obj: "make",
                _target: [{
                    _ref: "path"
                }],
                from: {
                    _ref: "selectionClass",
                    _property: "selection"
                },
                tolerance: {
                    _unit: "pixelsUnit",
                    _value: 0.3
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        
        // 7. 选择钢笔工具
        await batchPlay(
            [{
                _obj: "select",
                _target: [{
                    _ref: "penTool"
                }],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        // 8.新建描边图层
        const layerName = `描边图层_${Date.now()}`;
        await batchPlay(
            [{
                _obj: "make",
                _target: [{
                    _ref: "layer"
                }],
                name: layerName,
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        // 9.设置描边图层参数
        await batchPlay(
            [{
                _obj: "set",
                _target: [{
                    _ref: "layer",
                    _enum: "ordinal",
                    _value: "targetEnum"
                }],
                to: {
                    _obj: "layer",
                    mode: {
                        _enum: "blendMode",
                        _value: BLEND_MODES[strokeParams.blendMode] || "normal"
                    },
                    opacity: {
                        _unit: "percentUnit",
                        _value: strokeParams.opacity
                    }
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { 
                synchronousExecution: true,
                modalBehavior: "execute"
            }
        );


         // 10. 描边路径
        await batchPlay(
            [{
                _obj: "stroke",
                _target: [{
                    _ref: "path",
                    _property: "workPath"
                }],
                using: {
                    _class: "paintbrushTool"
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        await batchPlay(
            [{
                _obj: "fill",
                using: {
                    _enum: "fillContents",
                    _value: "color"
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                preserveTransparency: true,
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        
        // 11. 向下合并图层
        await batchPlay(
            [{
                _obj: "mergeLayersNew",
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );


        // 12. 将路径还原为选区
        await batchPlay(
            [{
                _obj: "set",
                _target: [{
                    _ref: "channel",
                    _property: "selection"
                }],
                to: {
                    _ref: "path",
                    _property: "workPath"
                },
                version: 1,
                vectorMaskParams: true,
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );


        // 13. 删除特制描边笔刷
        await batchPlay(
            [{
                _obj: "delete",
                _target: [{
                    _ref: "brush",
                    _name: brushName
                }],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );

        // 14. 选择套索工具
        await batchPlay(
            [{
                _obj: "select",
                _target: [{
                    _ref: "lassoTool"
                }],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );


        // 15. 删除工作路径
        await batchPlay(
            [{
                _obj: "delete",
                _target: [{
                    _ref: "path",
                    _property: "workPath"
                }],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true }
        );


    } catch (error) {
        console.error('描边失败:', error);
    }
}