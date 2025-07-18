import { app, action, core } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Gradient, GradientStop } from '../types/state';

// 内部类型定义
type Bounds = [number, number, number, number];

interface GradientCoordinates {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
}

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
    // 获取边界信息的公共方法
    private static async getBounds(): Promise<Bounds> {
        try {
            // 获取选区边界信息
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
            
            // 尝试从选区获取边界
            if (result?.[0]?.selection?.bottom !== undefined) {
                const selection = result[0].selection;
                const bounds: Bounds = [
                    selection.left._value || 0,
                    selection.top._value || 0, 
                    selection.right._value || 0,
                    selection.bottom._value || 0
                ];
                
                // 验证边界有效性
                if (bounds[2] > bounds[0] && bounds[3] > bounds[1]) {
                    return bounds;
                }
            }
            
            // 如果没有选区或选区无效，使用整个文档尺寸作为fallback
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
            
            const docWidth = docInfo?.[0]?.width || 1920;
            const docHeight = docInfo?.[0]?.height || 1080;
            
            return [0, 0, docWidth, docHeight];
            
        } catch (error) {
            console.error("❌ 获取边界信息失败:", error);
            // 返回默认边界而不是抛出错误
            return [0, 0, 1920, 1080];
        }
    }

    //----------------------------------------------------------------------------------
    // 计算渐变坐标的公共方法
    private static async calculateGradientCoordinates(
        bounds: Bounds, 
        options: GradientFillOptions
    ): Promise<GradientCoordinates> {
        const [left, top, right, bottom] = bounds;
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        
        if (options.gradient.type === 'radial') {
            // 径向渐变：from和to都在中心点
            return {
                fromX: centerX,
                fromY: centerY,
                toX: centerX,
                toY: centerY
            };
        }
        
        // 线性渐变：计算起点和终点
        // 确保角度在有效范围内
        const angle = typeof options.gradient.angle === 'number' 
            ? options.gradient.angle % 360 
            : 0;
            
        const gradientPoints = await this.calculateGradientBounds(
            left, top, right, bottom, angle
        );
        
        // 处理reverse选项
        if (options.gradient.reverse) {
            return {
                fromX: gradientPoints.endX,
                fromY: gradientPoints.endY,
                toX: gradientPoints.startX,
                toY: gradientPoints.startY
            };
        }
        
        return {
            fromX: gradientPoints.startX,
            fromY: gradientPoints.startY,
            toX: gradientPoints.endX,
            toY: gradientPoints.endY
        };
    }

    //----------------------------------------------------------------------------------
    // 统一的渐变填充执行方法
    private static async executeGradientFill(
        options: GradientFillOptions, 
        bounds: Bounds, 
        isMaskMode: boolean = false
    ): Promise<void> {
        try {
            // 输入验证
            if (!options?.gradient?.stops || options.gradient.stops.length < 2) {
                throw new Error("渐变至少需要2个颜色停止点");
            }
            
            if (options.opacity < 0 || options.opacity > 100) {
                throw new Error("不透明度必须在0-100之间");
            }
            
            // 验证边界有效性
            const [left, top, right, bottom] = bounds;
            if (right <= left || bottom <= top) {
                throw new Error("无效的边界范围");
            }
            
            // 计算渐变坐标
            const coordinates = await this.calculateGradientCoordinates(bounds, options);
            
            // 生成stops
            const colorStops = isMaskMode 
                ? this.generateGrayscaleStops(options.gradient.stops, options.gradient.reverse)
                : this.generateColorStops(options.gradient.stops, options.gradient.reverse);
            
            // 对于蒙版模式（快速蒙版和图层蒙版），不透明度stop和灰度stop是独立的
            const transparencyStops = this.generateTransparencyStops(options.gradient.stops, options.gradient.reverse);

            // 构建渐变填充对象
            const fillGradient = {
                _obj: "gradientClassEvent",
                type: {
                    _enum: "gradientType",
                    _value: options.gradient.type || "linear"
                },
                ...(isMaskMode && { useMask: true }),
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
                       _value: Math.round(coordinates.fromX)
                    },
                    vertical: {
                       _unit: "pixelsUnit",
                       _value: Math.round(coordinates.fromY)
                    }
                 },
                 to: {
                    _obj: "paint",
                    horizontal: {
                       _unit: "pixelsUnit",
                       _value: Math.round(coordinates.toX)
                    },
                    vertical: {
                       _unit: "pixelsUnit",
                       _value: Math.round(coordinates.toY)
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
            
        } catch (error) {
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 快速蒙版渐变填充
    private static async fillGradientDirect(options: GradientFillOptions) {
        try {
            console.log("🎨 开始快速蒙版渐变填充（基于透明度）");
            const bounds = await this.getBounds();
            // 快速蒙版也应该基于透明度信息，使用灰度渐变
            await this.executeGradientFill(options, bounds, true);
            console.log("✅ 快速蒙版渐变填充完成");
        } catch (error) {
            console.error("❌ 快速蒙版渐变填充失败:", error);
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 图层蒙版渐变填充
    private static async fillLayerMask(options: GradientFillOptions) {
        try {
            console.log("🎨 开始图层蒙版渐变填充（基于透明度）");
            const bounds = await this.getBounds();
            await this.executeGradientFill(options, bounds, true);
            console.log("✅ 图层蒙版渐变填充完成");
        } catch (error) {
            console.error("❌ 图层蒙版渐变填充失败:", error);
            throw error;
        }
    }


    //----------------------------------------------------------------------------------
    // 计算渐变的外接矩形边界点（新算法）
    private static async calculateGradientBounds(left: number, top: number, right: number, bottom: number, angle: number) {
        // 计算选区中心点和尺寸
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        const width = right - left;
        const height = bottom - top;
        
        // 检测快速蒙版状态和selectedArea参数
        let adjustedAngle = angle + 180; // 默认值
        
        try {
            // 检查是否处于快速蒙版状态
            const isInQuickMask = app.activeDocument.quickMaskMode;
            
            if (isInQuickMask) {
                // 获取快速蒙版通道信息，判断是否为selectedAreas
                const channelResult = await action.batchPlay([
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
                
                const isSelectedAreas = channelResult?.[0]?.alphaChannelOptions?.colorIndicates?._value === "selectedAreas";
                
                // 当处于快速蒙版且快速蒙版参数为selectedArea时，adjustedAngle直接等于angle
                if (isSelectedAreas) {
                    adjustedAngle = angle;
                    console.log('调整角度完毕');
                }
            }
        } catch (error) {
            console.warn('⚠️ 检测快速蒙版状态失败，使用默认角度调整:', error);
        }
        
        // 将角度转换为弧度
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

}