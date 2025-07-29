import { app, action, core, imaging } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Gradient, GradientStop } from '../types/state';
import { BLEND_MODE_CALCULATIONS } from './BlendModeCalculations';

// 内部类型定义
type Bounds = [number, number, number, number];


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
    static async fillGradient(options: GradientFillOptions, layerInfo: LayerInfo, state?: any) {
        // 检查是否有渐变stops
        if (!options.gradient.stops || options.gradient.stops.length === 0) {
            console.error("❌ 没有可用的渐变stops，无法填充");
            return;
        }

        // 如果在快速蒙版状态，使用简化的直接填充
        if (layerInfo.isInQuickMask) {
            await this.fillGradientDirect(options, state);
            return;
        }

        // 如果在图层蒙版编辑状态，使用蒙版填充
        if (layerInfo.isInLayerMask) {
            await this.fillLayerMask(options, state);
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
                        // 修正角度：取负值实现顺时针旋转
                        _value: -(options.gradient.angle || 0)
                    },
                    type: {
                        _enum: "gradientType",
                        _value: options.gradient.type || "linear"
                    },
                    reverse: false,
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
    // 快速蒙版渐变填充（重构版本，支持渐变不透明度）
    private static async fillGradientDirect(options: GradientFillOptions, state?: any) {
        try {
            console.log("🎨 开始快速蒙版渐变填充（支持不透明度）");                         
            
            // 1. 获取选区数据和快速蒙版数据
            const bounds = await this.getSelectionData();
            if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log("❌ 无法获取选区数据或选区为空");
                return;
            }
            
            const { quickMaskPixels, isSelectedAreas, isEmpty, topLeftIsEmpty, bottomRightIsEmpty, originalTopLeft, originalBottomRight } = await this.getQuickMaskPixels(bounds);
            
            // 2. 生成渐变数据（支持不透明度）
            const gradientGrayData = await this.getGradientFillGrayData(options.gradient, bounds);
            
            // 3. 生成渐变透明度数据
            const gradientAlphaData = await this.generateGradientAlphaData(options.gradient, bounds);
            
            // 4. 混合渐变与快速蒙版数据
            const finalData = await this.calculateFinalGrayValues(
                quickMaskPixels,
                gradientGrayData,
                gradientAlphaData,
                isSelectedAreas,
                options.opacity,
                isEmpty,
                bounds,
                options.blendMode,
                topLeftIsEmpty,
                bottomRightIsEmpty,
                originalTopLeft,
                originalBottomRight
            );
            
            // 5. 将最终数据写回快速蒙版
            await this.updateQuickMaskChannel(finalData, bounds, state);
            
            console.log("✅ 快速蒙版渐变填充完成");
        } catch (error) {
            console.error("❌ 快速蒙版渐变填充失败:", error);
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 图层蒙版渐变填充（重构版本，支持渐变不透明度）
    private static async fillLayerMask(options: GradientFillOptions, state?: any) {
        try {
            console.log("🎨 开始图层蒙版渐变填充（支持不透明度）");
            
            // 1. 获取选区数据和图层蒙版数据
            const bounds = await this.getSelectionData();
            if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log("❌ 无法获取选区数据或选区为空");
                return;
            }
            
            // 获取当前图层ID与图层蒙版信息
            const currentLayerId = await this.getCurrentLayerId();
            if (!currentLayerId) {
                console.log("❌ 无法获取当前图层ID");
                return;
            }
            const { maskData, selectedMaskData, stats } = await this.getLayerMaskPixels(bounds, currentLayerId);
            
            // 2. 生成渐变数据（支持不透明度）
            const gradientGrayData = await this.getGradientFillGrayData(options.gradient, bounds);
            
            // 3. 生成渐变透明度数据
            const gradientAlphaData = await this.generateGradientAlphaData(options.gradient, bounds);
            
            // 4. 混合渐变与图层蒙版数据
            const finalData = await this.calculateLayerMaskFillValues(
                selectedMaskData,
                gradientGrayData,
                gradientAlphaData,
                options.opacity,
                bounds,
                maskData,
                stats.isEmpty,
                options.blendMode
            );
            
            // 5. 将最终数据写回图层蒙版
            await this.updateLayerMask(finalData, bounds, currentLayerId, maskData, state);
            
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
        

        let adjustedAngle = angle; // 默认值
    
        
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

    //----------------------------------------------------------------------------------
    // 获取选区数据
    private static async getSelectionData() {
        try {

            // batchplay获取文档信息和选区信息（并行执行）
            const [docResult, selectionResult] = await Promise.all([
                action.batchPlay([
                    {
                        _obj: "get",
                        _target: [
                            {
                                _ref: "document",
                                _enum: "ordinal",
                                _value: "targetEnum"
                            }
                        ]
                    }
                ], { synchronousExecution: true }),
                action.batchPlay([
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
                        ]
                    }
                ], { synchronousExecution: true })
            ]);
            
            if (!selectionResult?.[0]?.selection) {
                console.log('❌ 没有选区');
                return null;
            }
            
            // 获取文档尺寸信息
            const docWidth = docResult[0].width._value;
            const docHeight = docResult[0].height._value;
            const resolution = docResult[0].resolution._value;
            
            // 直接转换为像素单位
            const docWidthPixels = Math.round(docWidth * resolution / 72);
            const docHeightPixels = Math.round(docHeight * resolution / 72);
            
            // 获取选区边界
            const bounds = selectionResult[0].selection;
            const left = Math.round(bounds.left._value);
            const top = Math.round(bounds.top._value);
            const right = Math.round(bounds.right._value);
            const bottom = Math.round(bounds.bottom._value);
            const width = right - left;
            const height = bottom - top;
            
            console.log('🎯 选区边界:', { left, top, right, bottom, width, height });
            console.log('📏 文档尺寸（像素）:', docWidthPixels, 'x', docHeightPixels);
            
            // 使用imaging.getSelection获取羽化选区的像素数据
            const pixels = await imaging.getSelection({
                documentID: app.activeDocument.id,
                sourceBounds: {
                    left: left,
                    top: top,
                    right: right,
                    bottom: bottom
                },
                targetSize: {
                    width: width,
                    height: height
                },
            });
            
            const selectionData = await pixels.imageData.getData();
            console.log('✅ 成功获取选区边界内的像素数据，数据类型:', selectionData.constructor.name, '长度:', selectionData.length);
            
            // 创建临时数组来存储矩形边界内的所有像素信息
            const tempSelectionValues = new Uint8Array(width * height);
            const tempSelectionCoefficients = new Float32Array(width * height);
            // 创建一个新的Set来存储选区内像素（值大于0）在文档中的索引
            const selectionDocIndices = new Set<number>();
            
            // 第一步：处理矩形边界内的所有像素，收集选区内像素的索引
            if (selectionData.length === width * height) {
                // 单通道数据
                for (let i = 0; i < width * height; i++) {
                    tempSelectionValues[i] = selectionData[i];
                    tempSelectionCoefficients[i] = selectionData[i] / 255; // 计算选择系数
                    
                    // 只有当像素值大于0时，才认为它在选区内
                    if (selectionData[i] > 0) {
                        // 计算该像素在选区边界内的坐标
                        const x = i % width;
                        const y = Math.floor(i / width);
                        
                        // 计算该像素在整个文档中的索引
                        const docX = left + x;
                        const docY = top + y;
                        const docIndex = docY * docWidthPixels + docX;
                        
                        // 将文档索引添加到集合中
                        selectionDocIndices.add(docIndex);
                    }
                }
            }
            
            // 第二步：创建只包含选区内像素的数组（长度为selectionDocIndices.size）
            const selectionSize = selectionDocIndices.size;
            const selectionValues = new Uint8Array(selectionSize);
            const selectionCoefficients = new Float32Array(selectionSize);
            
            // 第三步：将选区内像素的值和系数填入新数组
            let fillIndex = 0;
            for (let i = 0; i < width * height; i++) {
                if (tempSelectionValues[i] > 0) {
                    selectionValues[fillIndex] = tempSelectionValues[i];
                    selectionCoefficients[fillIndex] = tempSelectionCoefficients[i];
                    fillIndex++;
                }
            }
            console.log('✅ 选区内像素数量（selectionDocIndices.size）:', selectionDocIndices.size);
            
            // 释放ImageData内存
            pixels.imageData.dispose();
            
            // 取消选区
            await action.batchPlay([
                {
                    _obj: "set",
                    _target: [
                        {
                            _ref: "channel",
                            _property: "selection"
                        }
                    ],
                    to: {
                        _enum: "ordinal",
                        _value: "none"
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
            return {
                left,
                top,
                right,
                bottom,
                width,
                height,
                docWidth: docWidthPixels,  // 返回像素单位的文档宽度
                docHeight: docHeightPixels, // 返回像素单位的文档高度
                selectionPixels: selectionDocIndices, // 现在直接使用selectionDocIndices
                selectionDocIndices,       // 通过imaging.getSelection获取的选区内像素在文档中的索引
                selectionValues,           // 选区像素值（0-255）
                selectionCoefficients      // 选择系数（0-1）
            };
            
        } catch (error) {
            console.error('❌ 获取选区数据失败:', error);
            return null;
        }
    }

    //----------------------------------------------------------------------------------
    // 获取快速蒙版像素数据
    private static async getQuickMaskPixels(bounds: any) {
        try {
            console.log('🎭 开始获取快速蒙版数据');
            
            // 获取快速蒙版通道信息
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
            
            // 获取colorIndicates信息
            let isSelectedAreas = false;
            if (channelResult[0] && 
                channelResult[0].alphaChannelOptions && 
                channelResult[0].alphaChannelOptions.colorIndicates) {
                isSelectedAreas = channelResult[0].alphaChannelOptions.colorIndicates._value === "selectedAreas";
            }
            
            console.log(`🔍 检测到colorIndicates为${isSelectedAreas ? 'selectedAreas' : '非selectedAreas'}`);
            
            // 检查快速蒙版直方图状态
            const histogram = channelResult[0].histogram;
            const maskStatus = this.analyzeQuickMaskHistogram(histogram, isSelectedAreas);

            let topLeftIsEmpty = false;
            let bottomRightIsEmpty = false;
            let originalTopLeft = 0;
            let originalBottomRight = 0;

            // 获取左上角和右下角像素值
            originalTopLeft = await this.getPixelValue(0, 0);
            originalBottomRight = await this.getPixelValue(Math.round(bounds.docWidth) - 1, Math.round(bounds.docHeight) - 1);

            // 取消选区
            await action.batchPlay([
                {
                    _obj: "set",
                    _target: [
                        {
                            _ref: "channel",
                            _property: "selection"
                        }
                    ],
                    to: {
                        _enum: "ordinal",
                        _value: "none"
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
 
                // 判断左上角和右下角是否需要填充
                if ((isSelectedAreas && (originalTopLeft === 255)) ||
                    (!isSelectedAreas && (originalTopLeft === 0))) 
                    topLeftIsEmpty = true;
                
                if ((isSelectedAreas && (originalBottomRight === 255)) ||
                    (!isSelectedAreas && (originalBottomRight === 0))) 
                    bottomRightIsEmpty = true;

                // 如果两个角都不为空，则跳过后续的填充
                if (!topLeftIsEmpty && !bottomRightIsEmpty) {
                    console.log('两个角都不为空，跳过填充');
                } else {
                    // 根据isEmpty状态添加选区
                    if (topLeftIsEmpty || bottomRightIsEmpty) {
                        // 创建选区 - 只选择需要填充的像素
                        if (topLeftIsEmpty && !bottomRightIsEmpty) {
                            // 只有左上角为空，选择左上角像素
                            console.log('只有左上角为空，选择左上角像素');
                            await action.batchPlay([
                                {
                                    _obj: "set",
                                    _target: [
                                        {
                                            _ref: "channel",
                                            _property: "selection"
                                        }
                                    ],
                                    to: {
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        }
                                    }
                                }
                            ], { synchronousExecution: true });
                        } else if (!topLeftIsEmpty && bottomRightIsEmpty) {
                            // 只有右下角为空，选择右下角像素
                            console.log('只有右下角为空，选择右下角像素');
                             await action.batchPlay([
                                {
                                    _obj: "set",
                                    _target: [
                                        {
                                            _ref: "channel",
                                            _property: "selection"
                                        }
                                    ],
                                    to: {
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight) - 1
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth) - 1
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight)
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth)
                                        }
                                    }
                                }
                            ], { synchronousExecution: true });
                        } else if (topLeftIsEmpty && bottomRightIsEmpty) {
                            console.log('两个角都为空，选择两个角的像素');
                             await action.batchPlay([
                                {
                                    _obj: "set",
                                    _target: [
                                        {
                                            _ref: "channel",
                                            _property: "selection"
                                        }
                                    ],
                                    to: {
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight) - 1
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth) - 1
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight)
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth)
                                        }
                                    }
                                }
                            ], { synchronousExecution: true });
                            await action.batchPlay([
                                {
                                    _obj: "addTo",
                                    _target: [
                                        {
                                            _ref: "channel",
                                            _property: "selection"
                                        }
                                    ],
                                    to: {
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        }
                                    }
                                }
                            ], { synchronousExecution: true });
                        }

                        // 执行填充操作
                        await action.batchPlay([
                            {
                                _obj: "set",
                                _target: [
                                    {
                                        _ref: "color",
                                        _property: "foregroundColor"
                                    }
                                ],
                                to: {
                                    _obj: "HSBColorClass",
                                    hue: {
                                        _unit: "angleUnit",
                                        _value: 0
                                    },
                                    saturation: {
                                        _unit: "percentUnit",
                                        _value: 0
                                    },
                                    brightness: {
                                        _unit: "percentUnit",
                                        _value: isSelectedAreas ? 0 : 100
                                    }
                                },
                                source: "photoshopPicker",
                                _options: {
                                    dialogOptions: "dontDisplay"
                                }
                            }
                        ], { synchronousExecution: true });

                        await action.batchPlay([
                            {
                                _obj: "fill",
                                using: {
                                    _enum: "fillContents",
                                    _value: "foregroundColor"
                                },
                                opacity: {
                                    _unit: "percentUnit",
                                    _value: 100
                                },
                                mode: {
                                    _enum: "blendMode",
                                    _value: "normal"
                                },
                                _options: {
                                    dialogOptions: "dontDisplay"
                                }
                            }
                        ], { synchronousExecution: true });
                    }
                }
            
            // 撤销快速蒙版
            await this.clearQuickMask();
            
            // 如果是纯白快速蒙版（非selectedAreas模式下），需要执行全选操作
            if (!isSelectedAreas && maskStatus.isWhite) {
            await this.selectAll();
            }

            // 通过获取选区的灰度信息，间接获取完整文档的快速蒙版数据，maskValue数组
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);

            // 通过Imaging API获取快速蒙版转化的选区的黑白信息
            const pixels = await imaging.getSelection({
                documentID: app.activeDocument.id,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: finalDocWidth,
                    bottom: finalDocHeight
                },
                componentSize: 8,
                colorProfile: "Dot Gain 15%"
            });
            
            // 检查pixels和imageData是否存在
            if (!pixels || !pixels.imageData) {
                console.error('❌ 无法获取选区数据，pixels或imageData为空');
                throw new Error('无法获取选区数据');
            }
            
            const quickMaskData = await pixels.imageData.getData();
            console.log('✅ 成功获取快速蒙版像素数据，数据类型:', quickMaskData.constructor.name, '长度:', quickMaskData.length);

            // 释放ImageData内存
            pixels.imageData.dispose();
            
            // 创建固定长度的maskValue数组，初始值全为0
            const expectedPixelCount = finalDocWidth * finalDocHeight;
            let maskValue = new Uint8Array(expectedPixelCount);
            
            // 将quickMaskData转换为Uint8Array
            const quickMaskPixels = new Uint8Array(quickMaskData);
            
            // 获取quickMaskPixels中非零值的索引位置
            const nonZeroIndices: number[] = [];
            for (let i = 0; i < quickMaskPixels.length; i++) {
                if (quickMaskPixels[i] !== 0) {
                    nonZeroIndices.push(i);
                }
            }
            
            // 将非零值复制到maskValue对应位置
            for (let i = 0; i < nonZeroIndices.length; i++) {
                const sourceIndex = nonZeroIndices[i];
                maskValue[sourceIndex] = quickMaskPixels[sourceIndex];
            }
            
            console.log('快速蒙版渐变填充非零像素数量:', nonZeroIndices.length);
            
            return {
                quickMaskPixels: maskValue,
                isSelectedAreas: isSelectedAreas,
                isEmpty: maskStatus.isEmpty,  // 添加isEmpty状态信息
                topLeftIsEmpty: topLeftIsEmpty,
                bottomRightIsEmpty: bottomRightIsEmpty,
                originalTopLeft: originalTopLeft,  // 原始左上角像素值
                originalBottomRight: originalBottomRight  // 原始右下角像素值
            };
            
        } catch (error) {
            console.error('❌ 获取快速蒙版像素数据失败:', error);
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 获取指定坐标像素值的辅助方法
    private static async getPixelValue(x: number, y: number): Promise<number> {
        // 选择指定坐标的1x1像素区域
        await action.batchPlay([
            {
                _obj: "set",
                _target: [
                    {
                        _ref: "channel",
                        _property: "selection"
                    }
                ],
                to: {
                    _obj: "rectangle",
                    top: {
                        _unit: "pixelsUnit",
                        _value: y
                    },
                    left: {
                        _unit: "pixelsUnit",
                        _value: x
                    },
                    bottom: {
                        _unit: "pixelsUnit",
                        _value: y + 1
                    },
                    right: {
                        _unit: "pixelsUnit",
                        _value: x + 1
                    }
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true });

        // 获取像素的直方图
        const result = await action.batchPlay([
            {
                _obj: "get",
                _target: [
                    {
                        _ref: "channel",
                        _name: "快速蒙版"
                    }
                ]
            }
        ], { synchronousExecution: true });
        
        // 分析直方图找出数量为1的色阶值
        const histogram = result[0].histogram;
        const pixelValue = histogram.findIndex(count => count === 1);
        console.log(`坐标(${x}, ${y})的像素值：`, pixelValue);

        return pixelValue;
    }

    //----------------------------------------------------------------------------------
    // 分析快速蒙版直方图状态
    private static analyzeQuickMaskHistogram(histogram: number[], isSelectedAreas: boolean) {
        let isEmpty = false;
        let isWhite = false;
        
        if (histogram && Array.isArray(histogram)) {
            if (isSelectedAreas) {
                // selectedAreas模式：检查是否为空（除了255色阶外其他都是0）
                let nonZeroCount = 0;
                for (let i = 0; i < 255; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCount++;
                    }
                }
                isEmpty = (nonZeroCount === 0 && histogram[255] > 0);
                console.log('selectedAreas——————快速蒙版为空？', isEmpty);
            } else {
                // 非selectedAreas模式：检查是否为全选（纯白）或空白（纯黑）
                let nonZeroCountWhite = 0;
                for (let i = 0; i < 255; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCountWhite++;
                    }
                }
                isWhite = (nonZeroCountWhite === 0 && histogram[255] > 0);
                
                let nonZeroCount = 0;
                for (let i = 1; i < 256; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCount++;
                    }
                }
                isEmpty = (nonZeroCount === 0 && histogram[0] > 0);
                
                console.log('非selectedAreas模式——————快速蒙版为空？', isEmpty, '    全选？', isWhite);
            }
        }
        
        return { isEmpty, isWhite };
    }
    
    //----------------------------------------------------------------------------------
    // 撤销快速蒙版
    private static async clearQuickMask() {
        await action.batchPlay([
            {
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
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true });
    }
    
    //----------------------------------------------------------------------------------
    // 执行全选操作
    private static async selectAll() {
        await action.batchPlay([
            {
                _obj: "set",
                _target: [
                    {
                        _ref: "channel",
                        _property: "selection"
                    }
                ],
                to: {
                    _enum: "ordinal",
                    _value: "allEnum"
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true });
    }

    //----------------------------------------------------------------------------------
    // 获取图层蒙版像素数据
    private static async getLayerMaskPixels(bounds: any, layerId: number) {
        try {
            const { imaging } = require('photoshop');
            
            console.log('🎭 开始获取图层蒙版数据，图层ID:', layerId);
            
            const pixels = await imaging.getLayerMask({
                documentID: app.activeDocument.id,
                layerID: layerId,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: bounds.docWidth,
                    bottom: bounds.docHeight
                },
                componentSize: 8
            });
            
            // 检查pixels和imageData是否存在
            if (!pixels || !pixels.imageData) {
                console.error('❌ 无法获取图层蒙版数据，pixels或imageData为空');
                throw new Error('无法获取图层蒙版数据');
            }
            
            const fullDocMaskArray = await pixels.imageData.getData();
            console.log('🎯 完整文档蒙版数组长度:', fullDocMaskArray.length);
            
            // 从完整文档长度的蒙版数组中按照索引提取选区内的蒙版像素数据
            const selectionSize = bounds.selectionDocIndices.size;
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const maskPixels = new Uint8Array(selectionSize);
            
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                if (docIndex >= 0 && docIndex < fullDocMaskArray.length) {
                    maskPixels[i] = fullDocMaskArray[docIndex];
                } else {
                    maskPixels[i] = 0;
                }
            }
            
            // 计算统计信息
            let isEmpty = true;
            for (let i = 0; i < maskPixels.length; i++) {
                if (maskPixels[i] > 0) {
                    isEmpty = false;
                    break;
                }
            }
            
            const stats = { isEmpty };
            
            pixels.imageData.dispose();
            
            return {
                maskData: fullDocMaskArray,
                selectedMaskData: maskPixels,
                stats
            };
            
        } catch (error) {
            console.error('❌ 获取图层蒙版像素数据失败:', error);
            throw error;
        }
    }


    //----------------------------------------------------------------------------------
    // 生成渐变填充的灰度数据
    private static async getGradientFillGrayData(gradient: Gradient, bounds: any): Promise<Uint8Array> {
        try {
            console.log('🌈 获取渐变填充灰度数据');
            
            if (!gradient || !gradient.stops) {
                console.log('⚠️ 没有找到渐变数据，使用默认中等灰度');
                const pixelCount = bounds.selectionDocIndices?.size || (bounds.width * bounds.height);
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128);
                return grayData;
            }
            
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const grayData = new Uint8Array(selectionIndices.length);
            
            // 计算渐变的中心点和角度（基于选区边界）
            const centerX = bounds.width / 2;
            const centerY = bounds.height / 2;
            
            let startX, startY, endX, endY;
            
            if (gradient.type === 'radial') {
                // 径向渐变的起点和终点都在中心
                startX = centerX;
                startY = centerY;
                endX = centerX;
                endY = centerY;
            } else {
                // 线性渐变：计算起点和终点
                const gradientBounds = await this.calculateGradientBounds(
                    bounds.left, bounds.top, bounds.right, bounds.bottom, gradient.angle || 0
                );
                
                if (gradient.reverse) {
                    startX = gradientBounds.endX - bounds.left;
                    startY = gradientBounds.endY - bounds.top;
                    endX = gradientBounds.startX - bounds.left;
                    endY = gradientBounds.startY - bounds.top;
                } else {
                    startX = gradientBounds.startX - bounds.left;
                    startY = gradientBounds.startY - bounds.top;
                    endX = gradientBounds.endX - bounds.left;
                    endY = gradientBounds.endY - bounds.top;
                }
            }
            
            // 为选区内的每个像素计算渐变值
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                const docX = docIndex % bounds.docWidth;
                const docY = Math.floor(docIndex / bounds.docWidth);
                const boundsX = docX - bounds.left;
                const boundsY = docY - bounds.top;
                
                let position;
                
                if (gradient.type === 'radial') {
                    // 径向渐变
                    const dx = boundsX - centerX;
                    const dy = boundsY - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
                    position = Math.min(1, distance / maxDistance);
                } else {
                    // 线性渐变
                    const dx = boundsX - startX;
                    const dy = boundsY - startY;
                    const gradientDx = endX - startX;
                    const gradientDy = endY - startY;
                    const gradientLengthSq = gradientDx * gradientDx + gradientDy * gradientDy;
                    
                    if (gradientLengthSq > 0) {
                        const dotProduct = dx * gradientDx + dy * gradientDy;
                        position = Math.max(0, Math.min(1, dotProduct / gradientLengthSq));
                    } else {
                        position = 0;
                    }
                }
                
                // 根据位置插值渐变颜色并转换为灰度
                const colorWithOpacity = this.interpolateGradientColorWithOpacity(gradient.stops, position);
                
                // 转换为灰度值
                const grayValue = Math.round(
                    colorWithOpacity.red * 0.299 + 
                    colorWithOpacity.green * 0.587 + 
                    colorWithOpacity.blue * 0.114
                );
                
                grayData[i] = Math.min(255, Math.max(0, grayValue));
            }
            
            console.log('✅ 渐变灰度数据生成完成，数据长度:', grayData.length);
            return grayData;
            
        } catch (error) {
            console.error('❌ 获取渐变灰度数据失败:', error);
            const pixelCount = bounds.selectionDocIndices?.size || (bounds.width * bounds.height);
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128);
            return grayData;
        }
    }

    //----------------------------------------------------------------------------------
    // 生成渐变透明度数据
    private static async generateGradientAlphaData(gradient: Gradient, bounds: any): Promise<Uint8Array | null> {
        try {
            console.log('🌈 开始生成渐变透明度数据');
            
            if (!gradient || !gradient.stops) {
                console.log('⚠️ 没有渐变数据，返回完全不透明');
                return null;
            }
            
            if (!bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('⚠️ 没有选区索引信息');
                return null;
            }
            
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const alphaData = new Uint8Array(selectionIndices.length);
            
            // 计算渐变的中心点和角度（基于选区边界）
            const centerX = bounds.width / 2;
            const centerY = bounds.height / 2;
            
            let startX, startY, endX, endY;
            
            if (gradient.type === 'radial') {
                startX = centerX;
                startY = centerY;
                endX = centerX;
                endY = centerY;
            } else {
                const gradientBounds = await this.calculateGradientBounds(
                    bounds.left, bounds.top, bounds.right, bounds.bottom, gradient.angle || 0
                );
                
                if (gradient.reverse) {
                    startX = gradientBounds.endX - bounds.left;
                    startY = gradientBounds.endY - bounds.top;
                    endX = gradientBounds.startX - bounds.left;
                    endY = gradientBounds.startY - bounds.top;
                } else {
                    startX = gradientBounds.startX - bounds.left;
                    startY = gradientBounds.startY - bounds.top;
                    endX = gradientBounds.endX - bounds.left;
                    endY = gradientBounds.endY - bounds.top;
                }
            }
            
            // 为选区内的每个像素计算透明度值
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                const docX = docIndex % bounds.docWidth;
                const docY = Math.floor(docIndex / bounds.docWidth);
                const boundsX = docX - bounds.left;
                const boundsY = docY - bounds.top;
                
                let position;
                
                if (gradient.type === 'radial') {
                    const dx = boundsX - centerX;
                    const dy = boundsY - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
                    position = Math.min(1, distance / maxDistance);
                } else {
                    const dx = boundsX - startX;
                    const dy = boundsY - startY;
                    const gradientDx = endX - startX;
                    const gradientDy = endY - startY;
                    const gradientLengthSq = gradientDx * gradientDx + gradientDy * gradientDy;
                    
                    if (gradientLengthSq > 0) {
                        const dotProduct = dx * gradientDx + dy * gradientDy;
                        position = Math.max(0, Math.min(1, dotProduct / gradientLengthSq));
                    } else {
                        position = 0;
                    }
                }
                
                // 根据位置插值渐变透明度
                const colorWithOpacity = this.interpolateGradientColorWithOpacity(gradient.stops, position);
                
                // 将不透明度转换为0-255范围的透明度值
                alphaData[i] = Math.round((colorWithOpacity.opacity / 100) * 255);
            }
            
            console.log('✅ 渐变透明度数据生成完成，数据长度:', alphaData.length);
            return alphaData;
            
        } catch (error) {
            console.error('❌ 生成渐变透明度数据失败:', error);
            return null;
        }
    }

    //----------------------------------------------------------------------------------
    // 插值渐变颜色（包含透明度）
    private static interpolateGradientColorWithOpacity(stops: GradientStop[], position: number) {
        if (!stops || stops.length === 0) {
            return { red: 128, green: 128, blue: 128, opacity: 100 };
        }
        
        if (stops.length === 1) {
            const color = this.parseColor(stops[0].color);
            const opacity = this.parseOpacity(stops[0].color);
            return { ...color, opacity };
        }
        
        // 找到位置两侧的stop
        let leftStop = stops[0];
        let rightStop = stops[stops.length - 1];
        
        for (let i = 0; i < stops.length - 1; i++) {
            if (stops[i].position <= position * 100 && stops[i + 1].position >= position * 100) {
                leftStop = stops[i];
                rightStop = stops[i + 1];
                break;
            }
        }
        
        const leftColor = this.parseColor(leftStop.color);
        const rightColor = this.parseColor(rightStop.color);
        const leftOpacity = this.parseOpacity(leftStop.color);
        const rightOpacity = this.parseOpacity(rightStop.color);
        
        // 计算插值比例，考虑中点位置
        let ratio = (position * 100 - leftStop.position) / (rightStop.position - leftStop.position);
        
        // 如果存在中点信息，应用中点插值
        const midpoint = leftStop.midpoint ?? rightStop.midpoint ?? 50;
        if (midpoint !== 50) {
            const midpointRatio = midpoint / 100;
            if (ratio <= midpointRatio) {
                ratio = (ratio / midpointRatio) * 0.5;
            } else {
                ratio = 0.5 + ((ratio - midpointRatio) / (1 - midpointRatio)) * 0.5;
            }
        }
        
        return {
             red: Math.round(leftColor.red * (1 - ratio) + rightColor.red * ratio),
             green: Math.round(leftColor.green * (1 - ratio) + rightColor.green * ratio),
             blue: Math.round(leftColor.blue * (1 - ratio) + rightColor.blue * ratio),
             opacity: Math.round(leftOpacity * (1 - ratio) + rightOpacity * ratio)
         };
     }


    //----------------------------------------------------------------------------------
    // 获取当前图层ID
    private static async getCurrentLayerId(): Promise<number | null> {
        try {
            const result = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "layer",
                            _enum: "ordinal",
                            _value: "targetEnum"
                        }
                    ]
                }
            ], { synchronousExecution: true });
            
            return result[0]?.layerID;
        } catch (error) {
            console.error('❌ 获取当前图层ID失败:', error);
            return null;
        }
    }

    //----------------------------------------------------------------------------------
    // 计算图层蒙版填充值（支持羽化和透明度修复版）
    private static async calculateLayerMaskFillValues(
        selectedMaskData: Uint8Array,
        gradientGrayData: Uint8Array,
        gradientAlphaData: Uint8Array | null,
        opacity: number,
        bounds: any,
        maskData: Uint8Array,
        isEmpty: boolean,
        blendMode: string = 'normal'
    ): Promise<Uint8Array> {
        try {
            console.log('🎨 开始计算图层蒙版填充值（支持羽化和透明度修复版）');
            
            const length = selectedMaskData.length;
            const finalData = new Uint8Array(length);
            const opacityRatio = opacity * 0.01; // 避免重复除法
            const blendFunction = BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
            const hasAlpha = gradientAlphaData !== null;
            
            // 检查是否有羽化系数
            const hasFeathering = bounds?.selectionCoefficients?.length > 0;
            const selectionCoefficients = bounds?.selectionCoefficients;
            
            if (hasFeathering) {
                console.log('🌟 检测到选区羽化系数，将应用羽化混合效果');
            }
            
            // 批量处理，减少函数调用开销
            for (let i = 0; i < length; i++) {
                const maskValue = selectedMaskData[i];
                const gradientValue = gradientGrayData[i] || 128;
                const alphaValue = hasAlpha ? gradientAlphaData[i] : 255;
                
                // 计算最终的透明度（渐变透明度 × 整体不透明度）
                const finalAlpha = (alphaValue * 0.00392156862745098) * opacityRatio; // 1/255 = 0.00392156862745098
                
                // 如果最终透明度为0，直接保持原始蒙版值，不进行任何混合
                if (finalAlpha === 0) {
                    finalData[i] = maskValue;
                    continue;
                }
                
                // 计算混合值
                const blendedValue = blendFunction(maskValue, gradientValue);
                
                // 应用透明度混合
                const invAlphaRatio = 1 - finalAlpha;
                let blendedResult = maskValue * invAlphaRatio + blendedValue * finalAlpha;
                
                // 应用羽化系数（如果存在）
                if (hasFeathering && selectionCoefficients && selectionCoefficients[i] !== undefined) {
                    const featherCoeff = selectionCoefficients[i];
                    // 羽化混合：原始值 * (1 - 羽化系数) + 混合结果 * 羽化系数
                    const invFeatherCoeff = 1 - featherCoeff;
                    blendedResult = maskValue * invFeatherCoeff + blendedResult * featherCoeff;
                }
                
                // 快速边界检查和取整
                finalData[i] = blendedResult > 255 ? 255 : (blendedResult < 0 ? 0 : Math.round(blendedResult));
            }
            
            console.log('✅ 图层蒙版填充值计算完成，最终数据长度:', length);
            if (hasFeathering) {
                console.log('🌟 已应用羽化效果到图层蒙版填充');
            }
            return finalData;
            
        } catch (error) {
            console.error('❌ 计算图层蒙版填充值失败:', error);
            return selectedMaskData;
        }
    }

    //----------------------------------------------------------------------------------
    // 混合渐变数据与蒙版数据（支持羽化和角落像素还原）- 性能优化版
    private static async calculateFinalGrayValues(
        maskData: Uint8Array,
        gradientGrayData: Uint8Array,
        gradientAlphaData: Uint8Array | null,
        isSelectedAreas: boolean = true,
        opacity: number = 100,
        isEmpty: boolean = false,
        bounds?: any,
        blendMode: string = 'normal',
        topLeftIsEmpty: boolean = false,
        bottomRightIsEmpty: boolean = false,
        originalTopLeft: number = 0,
        originalBottomRight: number = 0
    ): Promise<Uint8Array> {
        try {
            console.log('🎨 开始混合渐变数据与蒙版数据（优化版）');
            
            const maskLength = maskData.length;
            const gradientLength = gradientGrayData.length;
            const newMaskValue = new Uint8Array(maskLength);
            
            // 优化：使用更快的数组初始化
            if (isEmpty) {
                // newMaskValue 已经默认为0，无需fill
            } else {
                newMaskValue.set(maskData);
            }
            
            // 预计算常量，避免重复计算
            const opacityRatio = opacity * 0.01;
            const blendFunction = BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
            const hasAlpha = gradientAlphaData !== null;
            const hasSelection = bounds?.selectionDocIndices?.size > 0;
            
            // 优化：预转换selectionDocIndices为数组，避免重复转换
            let selectionIndicesArray: number[] | null = null;
            if (hasSelection) {
                selectionIndicesArray = Array.from(bounds.selectionDocIndices);
            }
            
            // 计算选区内的渐变混合结果
            const finalData = new Uint8Array(gradientLength);
            
            // 优化：批量处理渐变计算
            for (let i = 0; i < gradientLength; i++) {
                let maskValue: number;
                
                if (isEmpty) {
                    maskValue = 0;
                } else if (selectionIndicesArray) {
                    maskValue = maskData[selectionIndicesArray[i]] || 0;
                } else {
                    maskValue = maskData[i] || 0;
                }
                
                const gradientValue = gradientGrayData[i] || 128;
                const alphaValue = hasAlpha ? gradientAlphaData[i] : 255;
                
                // 如果渐变完全透明，直接使用原始值
                if (alphaValue === 0) {
                    finalData[i] = maskValue;
                    continue;
                }
                
                // 计算混合值
                const blendedValue = blendFunction(maskValue, gradientValue);
                
                // 优化透明度计算
                const alphaRatio = (alphaValue * 0.00392156862745098) * opacityRatio;
                const invAlphaRatio = 1 - alphaRatio;
                let finalValue = maskValue * invAlphaRatio + blendedValue * alphaRatio;
                
                // 快速边界检查
                finalData[i] = finalValue > 255 ? 255 : (finalValue < 0 ? 0 : Math.round(finalValue));
            }
            
            // 优化：将计算结果映射回完整文档
            if (hasSelection && selectionIndicesArray) {
                console.log('🎯 使用selectionDocIndices映射选区内的最终计算结果');
                
                const hasFeathering = bounds.selectionCoefficients?.length > 0;
                if (hasFeathering) {
                    console.log('🌟 检测到选区羽化系数，将应用羽化混合效果');
                }
                
                let mappedCount = 0;
                let featheredCount = 0;
                const selectionCoefficients = bounds.selectionCoefficients;
                
                // 优化：减少边界检查，预先计算最小长度
                const maxIndex = Math.min(selectionIndicesArray.length, finalData.length);
                
                for (let i = 0; i < maxIndex; i++) {
                    const docIndex = selectionIndicesArray[i];
                    if (docIndex >= maskLength) continue;
                    
                    if (hasFeathering && selectionCoefficients?.[i] !== undefined) {
                        const selectionCoefficient = selectionCoefficients[i];
                        const originalValue = isEmpty ? 0 : maskData[docIndex];
                        const newValue = finalData[i];
                        
                        // 优化羽化混合计算
                        const invCoeff = 1 - selectionCoefficient;
                        const blendedValue = originalValue * invCoeff + newValue * selectionCoefficient;
                        newMaskValue[docIndex] = blendedValue > 255 ? 255 : (blendedValue < 0 ? 0 : Math.round(blendedValue));
                        
                        featheredCount++;
                    } else {
                        newMaskValue[docIndex] = finalData[i];
                    }
                    
                    mappedCount++;
                }
                
                console.log(`🎯 selectionDocIndices映射完成，映射了 ${mappedCount} 个像素`);
                if (featheredCount > 0) {
                    console.log(`🌟 应用羽化效果的像素数量: ${featheredCount}`);
                }
            } else {
                console.log('✅ 混合计算完成，最终数据长度:', finalData.length);
                return finalData;
            }
            
            // 优化：角落像素还原（减少重复的边界检查）
            if (topLeftIsEmpty && maskData[0] === 0) {
                console.log('⚪ 左上角像素不在选区内，还原为0');
                newMaskValue[0] = 0;
            }
            
            if (bottomRightIsEmpty && maskData[maskLength - 1] === 0) {
                console.log('⚪ 右下角像素不在选区内，还原为0');
                newMaskValue[maskLength - 1] = 0;
            }
            
            console.log('✅ 混合完成，最终数据长度:', maskLength);
            return newMaskValue;
            
        } catch (error) {
            console.error('❌ 混合数据失败:', error);
            return maskData;
        }
    }
    
    //----------------------------------------------------------------------------------
    // 更新快速蒙版通道
    private static async updateQuickMaskChannel(
        finalGrayData: Uint8Array,
        bounds: any,
        state?: any
    ): Promise<void> {
        try {
            console.log('🔄 将选区重新改回快速蒙版');
            
            const { imaging } = require('photoshop');
            
            let documentColorProfile = "Dot Gain 15%";
            
            // 使用bounds中已经获取的文档尺寸信息，确保为整数
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);
            
            // 创建完整文档尺寸的ImageData
            const fullOptions = {
                width: finalDocWidth,
                height: finalDocHeight,
                components: 1,
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            const fullImageData = await imaging.createImageDataFromBuffer(finalGrayData, fullOptions);
            
            // 使用putSelection更新整个快速蒙版
            await imaging.putSelection({
                documentID: app.activeDocument.id,
                imageData: fullImageData
            });
            
            fullImageData.dispose();
            
            // 重新进入快速蒙版
            await action.batchPlay([
                {
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
                _options: {
                    dialogOptions: "dontDisplay"
                }
                }
            ], { synchronousExecution: true });
            
            // 检查是否需要恢复选区
            if (state && !state.deselectAfterFill && bounds.selectionValues) {
                try {
                    console.log('🔄 恢复上一个选区');
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullDocArray = new Uint8Array(bounds.docWidth * bounds.docHeight);
                    const selectionIndices = Array.from(bounds.selectionDocIndices);
                    
                    for (let i = 0; i < selectionIndices.length; i++) {
                        const docIndex = selectionIndices[i];
                        if (docIndex >= 0 && docIndex < fullDocArray.length) {
                            fullDocArray[docIndex] = bounds.selectionValues[i];
                        }
                    }
                    
                    // 使用imagingAPI恢复选区
                    const selectionOptions = {
                        width: bounds.docWidth,
                        height: bounds.docHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: "Dot Gain 15%",
                        colorSpace: "Grayscale"
                    };
                    
                    const selectionImageData = await imaging.createImageDataFromBuffer(fullDocArray, selectionOptions);
                    
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: selectionImageData
                    });
                    
                    selectionImageData.dispose();
                    
                    console.log('✅ 选区恢复完成');
                } catch (error) {
                    console.error('❌ 恢复选区失败:', error);
                }
            }
            
        } catch (error) {
            console.error('❌ 更新快速蒙版通道失败:', error);
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 更新图层蒙版
    private static async updateLayerMask(
        finalGrayData: Uint8Array,
        bounds: any,
        layerId: number,
        originalMaskData: Uint8Array,
        state?: any
    ): Promise<void> {
        try {
            console.log('🔄 更新图层蒙版');
            
            const { imaging } = require('photoshop');
            
            let documentColorProfile = "Dot Gain 15%";
            
            // 创建完整文档大小的数组，先复制原始蒙版数据
            const fullDocArray = new Uint8Array(originalMaskData);
            
            // 将选区内的最终数据写入完整文档数组
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                if (docIndex >= 0 && docIndex < fullDocArray.length) {
                    fullDocArray[docIndex] = finalGrayData[i];
                }
            }
            
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);
            const expectedSize = finalDocWidth * finalDocHeight;
            
            console.log('📏 图层蒙版数据验证:');
            console.log('  - 文档宽度:', finalDocWidth);
            console.log('  - 文档高度:', finalDocHeight);
            console.log('  - 期望数据大小:', expectedSize);
            console.log('  - 实际数据大小:', fullDocArray.length);
            
            // 验证数据大小
            let grayData = fullDocArray;
            if (fullDocArray.length !== expectedSize) {
                console.error('❌ 图层蒙版数据大小不匹配');
                console.error('期望大小:', expectedSize, '实际大小:', fullDocArray.length);
                
                // 创建正确大小的数据缓冲区
                const correctedData = new Uint8Array(expectedSize);
                
                // 如果数据太小，用0填充；如果太大，截断
                const copySize = Math.min(fullDocArray.length, expectedSize);
                correctedData.set(fullDocArray.subarray(0, copySize));
                
                console.log('🔧 已创建修正后的数据缓冲区，大小:', correctedData.length);
                grayData = correctedData;
            }
            
            // 创建完整文档尺寸的ImageData
            const fullOptions = {
                width: finalDocWidth,
                height: finalDocHeight,
                components: 1,
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            const fullImageData = await imaging.createImageDataFromBuffer(grayData, fullOptions);
            
            // 更新图层蒙版
            await imaging.putLayerMask({
                documentID: app.activeDocument.id,
                layerID: layerId,
                imageData: fullImageData
            });
            
            fullImageData.dispose();
            
            console.log('✅ 图层蒙版更新完成');
            
            // 检查是否需要恢复选区
            if (state && !state.deselectAfterFill && bounds.selectionValues) {
                try {
                    console.log('🔄 恢复上一个选区');
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullDocArray = new Uint8Array(bounds.docWidth * bounds.docHeight);
                    const selectionIndices = Array.from(bounds.selectionDocIndices);
                    
                    for (let i = 0; i < selectionIndices.length; i++) {
                        const docIndex = selectionIndices[i];
                        if (docIndex >= 0 && docIndex < fullDocArray.length) {
                            fullDocArray[docIndex] = bounds.selectionValues[i];
                        }
                    }
                    
                    // 使用imagingAPI恢复选区
                    const selectionOptions = {
                        width: bounds.docWidth,
                        height: bounds.docHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: "Dot Gain 15%",
                        colorSpace: "Grayscale"
                    };
                    
                    const selectionImageData = await imaging.createImageDataFromBuffer(fullDocArray, selectionOptions);
                    
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: selectionImageData
                    });
                    
                    selectionImageData.dispose();
                    
                    console.log('✅ 选区恢复完成');
                } catch (error) {
                    console.error('❌ 恢复选区失败:', error);
                }
            }
            
        } catch (error) {
            console.error('❌ 更新图层蒙版失败:', error);
            throw error;
        }
    }

}