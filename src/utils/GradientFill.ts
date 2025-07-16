import { app, action, core } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Gradient, GradientStop } from '../types/state';

interface GradientFillOptions {
    opacity: number;
    blendMode: string;
    gradient: Gradient;
    preserveTransparency?: boolean;
}

interface LayerInfo {
    hasPixels: boolean;
    isInQuickMask: boolean;
    isInLayerMask: boolean;
}

export class GradientFill {
    static async fillGradient(options: GradientFillOptions, layerInfo: LayerInfo) {
        // 检查是否有渐变stops
        if (!options.gradient.stops || options.gradient.stops.length === 0) {
            console.error("❌ 没有可用的渐变stops，无法填充");
            return;
        }

        // 如果在快速蒙版状态，使用简化的直接填充
        if (layerInfo.isInQuickMask) {
            await this.fillGradientDirect(options);
            return;
        }

        // 如果在图层蒙版编辑状态，使用蒙版填充
        if (layerInfo.isInLayerMask) {
            await this.fillLayerMask(options);
            return;
        }

        // 获取选区边界
        const bounds = app.activeDocument.selection.bounds;
        if (!bounds) {
            console.error("❌ 无法获取选区边界数据");
            return;
        }

        // 生成颜色stops
        const colorStops = this.generateColorStops(options.gradient.stops, options.gradient.reverse);
        
        // 生成透明度stops
        const transparencyStops = this.generateTransparencyStops(options.gradient.stops, options.gradient.reverse);

        // 第一步：创建渐变图层的配置
        const createGradientLayer = {
            _obj: "make",
            _target: [{
                _ref: "contentLayer"
            }],
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
                        _value: options.gradient.angle || 0
                    },
                    type: {
                        _enum: "gradientType",
                        _value: options.gradient.type || "linear"
                    },
                    reverse: options.gradient.reverse || false,
                    gradient: {
                        _obj: "gradientClassEvent",
                        gradientForm: {
                            _enum: "gradientForm",
                            _value: "customStops"
                        },
                        interfaceIconFrameDimmed: 4096,
                        colors: colorStops,
                        transparency: transparencyStops
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
            await action.batchPlay([createGradientLayer], {});
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

            // 选中上一个选区
            await action.batchPlay([{
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
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }], { synchronousExecution: true });

            console.log("✅ 渐变填充完成");
        } catch (error) {
            console.error("❌ 渐变填充失败:", error);
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 生成颜色stops
    private static generateColorStops(stops: GradientStop[], reverse: boolean = false) {
        return stops.map((stop, index) => {
            // 解析颜色
            const color = this.parseColor(stop.color);
            
            // 如果reverse为true，反转位置
            const position = reverse ? (100 - stop.position) : stop.position;
            
            return {
                _obj: "colorStop",
                color: {
                    _obj: "RGBColor",
                    red: color.red,
                    green: color.green,
                    blue: color.blue
                },
                type: {
                    _enum: "colorStopType",
                    _value: "userStop"
                },
                location: Math.round((position / 100) * 4096),
                // 使用stop中的midpoint属性，如果没有则默认为50
                midpoint: stop.midpoint !== undefined ? stop.midpoint : 50
            };
        });
    }

    //----------------------------------------------------------------------------------
    // 生成透明度stops
    private static generateTransparencyStops(stops: GradientStop[], reverse: boolean = false) {
        return stops.map((stop, index) => {
            // 解析透明度
            const opacity = this.parseOpacity(stop.color);
            
            // 如果reverse为true，反转位置
            const position = reverse ? (100 - stop.position) : stop.position;
            
            return {
                _obj: "transferSpec",
                opacity: {
                    _unit: "percentUnit",
                    _value: opacity
                },
                location: Math.round((position / 100) * 4096),
                // 使用stop中的midpoint属性，如果没有则默认为50
                midpoint: stop.midpoint !== undefined ? stop.midpoint : 50
            };
        });
    }

    //----------------------------------------------------------------------------------
    // 生成图层蒙版专用的灰度stops
    private static generateGrayscaleStops(stops: GradientStop[], reverse: boolean = false) {
        return stops.map((stop, index) => {
            // 解析颜色并转换为灰度
            const color = this.parseColor(stop.color);
            // 使用标准的灰度转换公式：0.299*R + 0.587*G + 0.114*B
            const grayscale = Math.round(color.red * 0.299 + color.green * 0.587 + color.blue * 0.114);
            
            // 如果reverse为true，反转位置
            const position = reverse ? (100 - stop.position) : stop.position;
            
            return {
                _obj: "colorStop",
                color: {
                    _obj: "grayscale",
                    gray: {
                        _unit: "percentUnit",
                        _value: Math.round((grayscale / 255) * 100)
                    }
                },
                type: {
                    _enum: "colorStopType",
                    _value: "userStop"
                },
                location: Math.round((position / 100) * 4096),
                // 使用stop中的midpoint属性，如果没有则默认为50
                midpoint: stop.midpoint !== undefined ? stop.midpoint : 50
            };
        });
    }

    //----------------------------------------------------------------------------------
    // 解析颜色
    private static parseColor(colorString: string) {
        // 处理rgba格式
        const rgbaMatch = colorString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (rgbaMatch) {
            return {
                red: parseInt(rgbaMatch[1]),
                green: parseInt(rgbaMatch[2]),
                blue: parseInt(rgbaMatch[3])
            };
        }

        // 处理hex格式
        const hexMatch = colorString.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
        if (hexMatch) {
            return {
                red: parseInt(hexMatch[1], 16),
                green: parseInt(hexMatch[2], 16),
                blue: parseInt(hexMatch[3], 16)
            };
        }

        // 默认返回黑色
        return { red: 0, green: 0, blue: 0 };
    }

    //----------------------------------------------------------------------------------
    // 解析透明度
    private static parseOpacity(colorString: string) {
        const rgbaMatch = colorString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (rgbaMatch && rgbaMatch[4] !== undefined) {
            return Math.round(parseFloat(rgbaMatch[4]) * 100);
        }
        return 100; // 默认完全不透明
    }

    //----------------------------------------------------------------------------------
    // 快速蒙版渐变填充
    private static async fillGradientDirect(options: GradientFillOptions) {
        try {
            // 获取快速蒙版通道的边界信息
            const result = await action.batchPlay([
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
                    ],
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
            // 修改边界提取逻辑
            let bounds;
            if (result[0] && result[0].selection && result[0].selection.bottom !== undefined) {
                // 从selection对象中提取边界信息，注意获取_value属性
                const selection = result[0].selection;
                bounds = [
                    selection.left._value,
                    selection.top._value, 
                    selection.right._value,
                    selection.bottom._value
                ];
                await this.processGradientFill(options, bounds);
            } else {
                // 如果没有获取到边界，尝试获取整个文档尺寸作为fallback
                const docInfo = await action.batchPlay([
                    {
                        _obj: "get",
                        _target: [
                            {
                                _property: "width"
                            },
                            {
                                _property: "height"
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
                ], { synchronousExecution: true });
                
                // 使用整个文档作为填充区域
                const docWidth = docInfo[0].width;
                const docHeight = docInfo[0].height;
                
                bounds = [0, 0, docWidth, docHeight];
                
                // 继续处理渐变填充逻辑...
                await this.processGradientFill(options, bounds);
            }
            
        } catch (error) {
            console.error("❌ 快速蒙版渐变填充失败:", error);
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 处理渐变填充的辅助方法
    private static async processGradientFill(options: GradientFillOptions, bounds: number[]) {
        const left = bounds[0];
        const top = bounds[1];
        const right = bounds[2];
        const bottom = bounds[3];
    
        // 计算选区中心点和尺寸
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        const width = right - left;
        const height = bottom - top;
        
        let fromX, fromY, toX, toY;
        
        if (options.gradient.type === 'radial') {
            // 径向渐变：from和to都在中心点，通过半径控制 
            fromX = toX = centerX;
            fromY = toY = centerY;
        } else {
            // 线性渐变：使用新的外接矩形算法计算起点和终点
            const gradientPoints = this.calculateGradientBounds(left, top, right, bottom, options.gradient.angle || 0);
            
            // 如果reverse为true，交换起点和终点
            if (options.gradient.reverse) {
                fromX = gradientPoints.endX;
                fromY = gradientPoints.endY;
                toX = gradientPoints.startX;
                toY = gradientPoints.startY;
            } else {
                fromX = gradientPoints.startX;
                fromY = gradientPoints.startY;
                toX = gradientPoints.endX;
                toY = gradientPoints.endY;
            }
        }

        // 生成颜色stops
        const colorStops = this.generateColorStops(options.gradient.stops, options.gradient.reverse);
        
        // 生成透明度stops
        const transparencyStops = this.generateTransparencyStops(options.gradient.stops, options.gradient.reverse);

        const fillGradient = {
            _obj: "gradientClassEvent",
            type: {
                _enum: "gradientType",
                _value: options.gradient.type || "linear"
            },
            reverse: options.gradient.reverse || false,
            gradientsInterpolationMethod: {
                _enum: "gradientInterpolationMethodType",
                _value: "smooth"
            },
            gradient: {
                _obj: "gradientClassEvent",
                gradientForm: {
                    _enum: "gradientForm",
                    _value: "customStops"
                },
                interfaceIconFrameDimmed: 4096,
                colors: colorStops,
                transparency: transparencyStops
            },
            from: {
                _obj: "paint",
                horizontal: {
                   _unit: "pixelsUnit",
                   _value: Math.round(fromX)
                },
                vertical: {
                   _unit: "pixelsUnit",
                   _value: Math.round(fromY)
                }
             },
             to: {
                _obj: "paint",
                horizontal: {
                   _unit: "pixelsUnit",
                   _value: Math.round(toX)
                },
                vertical: {
                   _unit: "pixelsUnit",
                   _value: Math.round(toY)
                }
             },
            opacity: {
                _unit: "percentUnit",
                _value: options.opacity
            },
            mode: {
                _enum: "blendMode",
                _value: BLEND_MODES[options.blendMode] || "normal"
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        await action.batchPlay([fillGradient], { synchronousExecution: true });
    }

    //----------------------------------------------------------------------------------
    // 计算渐变的外接矩形边界点（新算法）
    private static calculateGradientBounds(left: number, top: number, right: number, bottom: number, angle: number) {
        // 计算选区中心点和尺寸
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        const width = right - left;
        const height = bottom - top;
        
        // 将角度转换为弧度，调整角度以匹配预览效果
        const adjustedAngle = angle + 180;
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

    //----------------------------------------------------------------------------------
    // 图层蒙版渐变填充
    private static async fillLayerMask(options: GradientFillOptions) {
        try {
            // 获取图层蒙版的边界信息
            const result = await action.batchPlay([
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
                    ],
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
            // 修改边界提取逻辑
            let bounds;
            if (result[0] && result[0].selection && result[0].selection.bottom !== undefined) {
                // 从selection对象中提取边界信息，注意获取_value属性
                const selection = result[0].selection;
                bounds = [
                    selection.left._value,
                    selection.top._value, 
                    selection.right._value,
                    selection.bottom._value
                ];
                await this.processLayerMaskGradientFill(options, bounds);
            } else {
                // 如果没有获取到边界，尝试获取整个文档尺寸作为fallback
                const docInfo = await action.batchPlay([
                    {
                        _obj: "get",
                        _target: [
                            {
                                _property: "width"
                            },
                            {
                                _property: "height"
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
                ], { synchronousExecution: true });
                
                // 使用整个文档作为填充区域
                const docWidth = docInfo[0].width;
                const docHeight = docInfo[0].height;
                
                bounds = [0, 0, docWidth, docHeight];
                
                // 继续处理渐变填充逻辑...
                await this.processLayerMaskGradientFill(options, bounds);
            }
            
        } catch (error) {
            console.error("❌ 图层蒙版渐变填充失败:", error);
            throw error;
        }
    }
            
    // 处理图层蒙版渐变填充的辅助方法
    private static async processLayerMaskGradientFill(options: GradientFillOptions, bounds: number[]) {
        try {
            const left = bounds[0];
            const top = bounds[1];
            const right = bounds[2];
            const bottom = bounds[3];
        
            // 计算选区中心点和尺寸
            const centerX = (left + right) / 2;
            const centerY = (top + bottom) / 2;
            
            let fromX, fromY, toX, toY;
            
            if (options.gradient.type === 'radial') {
                // 径向渐变：from和to都在中心点，通过半径控制 
                fromX = toX = centerX;
                fromY = toY = centerY;
            } else {
                // 线性渐变：使用新的外接矩形算法计算起点和终点
                const gradientPoints = this.calculateGradientBounds(left, top, right, bottom, options.gradient.angle || 0);
                
                // 如果reverse为true，交换起点和终点
                if (options.gradient.reverse) {
                    fromX = gradientPoints.endX;
                    fromY = gradientPoints.endY;
                    toX = gradientPoints.startX;
                    toY = gradientPoints.startY;
                } else {
                    fromX = gradientPoints.startX;
                    fromY = gradientPoints.startY;
                    toX = gradientPoints.endX;
                    toY = gradientPoints.endY;
                }
            }
            
            // 图层蒙版使用灰度stops而不是RGB颜色stops
            const colorStops = this.generateGrayscaleStops(options.gradient.stops, options.gradient.reverse);
            
            // 生成透明度stops
        const transparencyStops = this.generateTransparencyStops(options.gradient.stops, options.gradient.reverse);

            const fillGradient = {
                _obj: "gradientClassEvent",
                type: {
                    _enum: "gradientType",
                    _value: options.gradient.type || "linear"
                },
                useMask: false,
                reverse: options.gradient.reverse || false,
                gradientsInterpolationMethod: {
                    _enum: "gradientInterpolationMethodType",
                    _value: "smooth"
                },
                gradient: {
                    _obj: "gradientClassEvent",
                    gradientForm: {
                        _enum: "gradientForm",
                        _value: "customStops"
                    },
                    interfaceIconFrameDimmed: 4096,
                    colors: colorStops,
                    transparency: transparencyStops
                },
                from: {
                    _obj: "paint",
                    horizontal: {
                       _unit: "pixelsUnit",
                       _value: Math.round(fromX)
                    },
                    vertical: {
                       _unit: "pixelsUnit",
                       _value: Math.round(fromY)
                    }
                 },
                 to: {
                    _obj: "paint",
                    horizontal: {
                       _unit: "pixelsUnit",
                       _value: Math.round(toX)
                    },
                    vertical: {
                       _unit: "pixelsUnit",
                       _value: Math.round(toY)
                    }
                 },
                opacity: {
                    _unit: "percentUnit",
                    _value: options.opacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: BLEND_MODES[options.blendMode] || "normal"
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            };

            await action.batchPlay([fillGradient], { synchronousExecution: true });
            console.log("✅ 图层蒙版渐变填充完成");
        } catch (error) {
            console.error("❌ 图层蒙版渐变填充失败:", error);
            throw error;
        }
    }
}