export async function strokeSelection(state: AppState) {
    if (!state.strokeEnabled) return;
    
    try {
        await batchPlay(
            [
                {
                    _obj: "stroke",
                    width: state.strokeWidth || 3,
                    location: {
                        _enum: "strokeLength",
                        _value: "center"
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
                        _obj: "RGBColorClass",
                        red: state.strokeColor.red || 0,
                        green: state.strokeColor.green || 0,
                        blue: state.strokeColor.blue || 0
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ],
            {}
        );
    } catch (error) {
        console.error('❌ 描边失败:', error);
    }
}