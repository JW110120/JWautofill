import { app, action, core } from 'photoshop';

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
    
    console.log('描边参数:', strokeParams);
    
    try {
        await batchPlay(
            [{
                _obj: "stroke",
                width: strokeParams.width,
                location: {
                    _enum: "strokeLength",
                    _value: state.strokePosition || "center"  // 使用设置的位置参数
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: state.strokeOpacity || 100  // 使用设置的不透明度
                },
                mode: {
                    _enum: "blendMode",
                    _value: state.strokeBlendMode || "normal"  // 使用设置的混合模式
                },
                color: {
                    _obj: "RGBColor",
                    red: state.strokeColor.red || 0,
                    green: state.strokeColor.green || 0,
                    blue: state.strokeColor.blue || 0
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
            ],
            {
                synchronousExecution: true,
                modalBehavior: "execute"
            }
        );
    } catch (error) {
        console.error('❌ 描边失败:', error);
    }
}
