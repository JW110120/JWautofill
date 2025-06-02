import { action, app } from "photoshop";
import { calculateRandomColor } from './ColorUtils';

export class ClearHandler {
    static async clearWithOpacity(opacity: number, state?: any) {
        try {
            const outputMin = Math.round(255 * (100 - opacity) / 100);
            
            // 获取当前文档信息
            const document = app.activeDocument;
            const isInQuickMask = document.quickMaskMode;
            
            // 如果已经在快速蒙版状态，执行特殊填充逻辑
            if (isInQuickMask && state) {
                await this.clearInQuickMask(state);
                return;
            }
            
            // 构建完整的批处理动作数组（非快速蒙版状态）
            const actions = [];
            
            // 进入快速蒙版
            actions.push({
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
                _options: { dialogOptions: "dontDisplay" }
            });
            
            // 载入选区
            actions.push({
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
                _options: { dialogOptions: "dontDisplay" }
            });
            
            // 色阶调整
            actions.push({
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
            });
            
            // 清除快速蒙版
            actions.push({
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
                _options: { dialogOptions: "dontDisplay" }
            });
            
            // 删除选区内容
            actions.push({
                _obj: "delete",
                _options: { dialogOptions: "dontDisplay" }
            });
            
            // 一次性执行所有动作
            await action.batchPlay(actions, { synchronousExecution: true });
        } catch (error) {
            console.error('清除选区失败:', error);
            throw error;
        }
    }

    // 快速蒙版状态下的特殊填充逻辑
    static async clearInQuickMask(state: any) {
        try {
            // 获取快速蒙版通道的像素信息
            const quickMaskChannelInfo = await this.getQuickMaskChannelInfo();
            
            if (state.fillMode === 'foreground') {
                // 纯色填充模式
                await this.fillWithCalculatedColor(state, quickMaskChannelInfo, 'solid');
            } else if (state.fillMode === 'pattern' && state.selectedPattern) {
                // 图案填充模式
                await this.fillWithCalculatedColor(state, quickMaskChannelInfo, 'pattern');
            } else if (state.fillMode === 'gradient' && state.selectedGradient) {
                // 渐变填充模式
                await this.fillWithCalculatedColor(state, quickMaskChannelInfo, 'gradient');
            }
        } catch (error) {
            console.error('快速蒙版特殊填充失败:', error);
            throw error;
        }
    }

    // 获取快速蒙版通道信息
    static async getQuickMaskChannelInfo() {
        try {
            // 获取快速蒙版通道的像素数据
            const result = await action.batchPlay([
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

    // 根据公式计算最终填充颜色并执行填充
    static async fillWithCalculatedColor(state: any, quickMaskInfo: any, fillType: 'solid' | 'pattern' | 'gradient') {
        try {
            // 这里简化处理，实际应该获取每个像素的快速蒙版值
            // 假设快速蒙版的平均值为A（0-255）
            const maskValue = 128; // 简化处理，实际需要从quickMaskInfo中获取
            
            if (fillType === 'solid') {
                // 纯色填充：获取面板颜色B，计算C=A*(255+B)/255
                 const panelColor = calculateRandomColor(state.colorSettings, state.opacity);
                 const finalColor = this.calculateFinalColor(maskValue, panelColor);
                
                await action.batchPlay([
                    {
                        _obj: "fill",
                        using: {
                            _obj: "RGBColor",
                            red: finalColor.red,
                            green: finalColor.green,
                            blue: finalColor.blue
                        },
                        opacity: {
                            _unit: "percentUnit",
                            _value: state.opacity || 100
                        },
                        mode: {
                            _enum: "blendMode",
                            _value: "normal" // 强制使用正常混合模式
                        },
                        _options: {
                            dialogOptions: "dontDisplay"
                        }
                    }
                ], { synchronousExecution: true });
            } else if (fillType === 'pattern') {
                // 图案填充：需要对图案的每个像素进行颜色计算
                // 这里简化处理，实际需要更复杂的像素级计算
                await action.batchPlay([
                    {
                        _obj: "fill",
                        using: {
                            _obj: "pattern",
                            name: state.selectedPattern.name || state.selectedPattern.patternName
                        },
                        opacity: {
                            _unit: "percentUnit",
                            _value: state.opacity || 100
                        },
                        mode: {
                            _enum: "blendMode",
                            _value: "normal" // 强制使用正常混合模式
                        },
                        _options: {
                            dialogOptions: "dontDisplay"
                        }
                    }
                ], { synchronousExecution: true });
            } else if (fillType === 'gradient') {
                // 渐变填充：需要对渐变的每个像素进行颜色计算
                // 这里简化处理，实际需要更复杂的像素级计算
                const gradientFill = {
                    _obj: "fill",
                    using: {
                        _obj: "gradientClassEvent",
                        gradient: {
                            _obj: "gradientClassEvent",
                            gradientForm: {
                                _enum: "gradientForm",
                                _value: state.selectedGradient.type === 'radial' ? "radial" : "linear"
                            },
                            angle: {
                                _unit: "angleUnit",
                                _value: state.selectedGradient.angle || 0
                            }
                        }
                    },
                    opacity: {
                        _unit: "percentUnit",
                        _value: state.opacity || 100
                    },
                    mode: {
                        _enum: "blendMode",
                        _value: "normal" // 强制使用正常混合模式
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                };
                
                await action.batchPlay([gradientFill], { synchronousExecution: true });
            }
        } catch (error) {
            console.error('计算颜色填充失败:', error);
            throw error;
        }
    }

    // 计算最终颜色：C = A * (255 + B) / 255
    static calculateFinalColor(maskValue: number, panelColor: any) {
        const A = maskValue; // 快速蒙版像素值 (0-255)
        const B = {
            red: panelColor.red || 0,
            green: panelColor.green || 0,
            blue: panelColor.blue || 0
        };
        
        return {
            red: Math.round(A * (255 + B.red) / 255),
            green: Math.round(A * (255 + B.green) / 255),
            blue: Math.round(A * (255 + B.blue) / 255)
        };
    }


}

