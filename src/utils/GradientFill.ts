import { app, action, core } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Gradient, GradientStop } from '../types/state';

interface GradientFillOptions {
    opacity: number;
    blendMode: string;
    gradient: Gradient;
    preserveTransparency?: boolean; // 添加新的选项
}

interface LayerInfo {
    hasPixels: boolean;
}

export class  GradientFill {
    static async fillGradient(options: GradientFillOptions, layerInfo: LayerInfo) {
        // 获取选区边界
        const bounds = app.activeDocument.selection.bounds;
        if (!bounds) {
            console.error("❌ 无法获取选区边界数据");
            return;
        }


        // 检查是否有patternName
        if (!options.gradient.gradientStops || options.gradient.gradientStops.length === 0) {
            console.error("❌ 没有可用的图案名称，无法填充");
            return;
        }

        // 第一步：创建图案图层的配置
        const createPatternLayer = {
            _obj: "make",
            _target: [
               {
                  _ref: "contentLayer"
               }
            ],
            using: {
               _obj: "contentLayer",
               type: {
                  _obj: "gradientLayer",
                  gradientsInterpolationMethod: {
                     _enum: "gradientInterpolationMethodType",
                     _value: "smooth"
                  },
                  angle: {
                     _unit: "angleUnit",
                     _value: 90
                  },
                  type: {
                     _enum: "gradientType",
                     _value: "linear"
                  },
                  gradient: {
                     _obj: "gradientClassEvent",
                     gradientForm: {
                        _enum: "gradientForm",
                        _value: "customStops"
                     },
                     interfaceIconFrameDimmed: 4096,
                     colors: [
                        {
                           _obj: "colorStop",
                           color: {
                              _obj: "RGBColor",
                              red: 251.00000023841858,
                              grain: 0.0038910505827516317,
                              blue: 0.0038910505827516317
                           },
                           type: {
                              _enum: "colorStopType",
                              _value: "userStop"
                           },
                           location: 0,
                           midpoint: 50
                        },
                        {
                           _obj: "colorStop",
                           color: {
                              _obj: "RGBColor",
                              red: 251.00000023841858,
                              grain: 0.0038910505827516317,
                              blue: 0.0038910505827516317
                           },
                           type: {
                              _enum: "colorStopType",
                              _value: "userStop"
                           },
                           location: 4096,
                           midpoint: 50
                        }
                     ],
                     transparency: [
                        {
                           _obj: "transferSpec",
                           opacity: {
                              _unit: "percentUnit",
                              _value: 100
                           },
                           location: 0,
                           midpoint: 50
                        },
                        {
                           _obj: "transferSpec",
                           opacity: {
                              _unit: "percentUnit",
                              _value: 0
                           },
                           location: 4096,
                           midpoint: 50
                        }
                     ]
                  }
               }
            },
            _options: {
               dialogOptions: "dontDisplay"
            }
        };

        // 第二步：设置图层属性的配置
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

        // 第三步：剪贴蒙版的配置
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

        // 第四步：根据图层类型选择操作
        const rasterizeLayer = {
            _obj: "rasterizeLayer",
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
            // 执行操作
            await action.batchPlay([createPatternLayer], {});
            await action.batchPlay([setLayerProperties], {});
            
            if (options.preserveTransparency) {
                await action.batchPlay([createClippingMask], {});
            }
            
            // 根据图层是否有像素来决定最后的操作
            if (!layerInfo.hasPixels) {
                await action.batchPlay([rasterizeLayer], {});
                await action.batchPlay([applyMask], {});
            } else {
                await action.batchPlay([mergeLayers], {});
            }
        } catch (error) {
            console.error("❌ 执行渐变填充时发生错误:", error);
        }
    }
}