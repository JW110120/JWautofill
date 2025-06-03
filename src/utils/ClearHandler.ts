import { action, app, imaging } from "photoshop";
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
            console.log('🔄 开始快速蒙版清除操作，填充模式:', state.fillMode);
            
            // 获取当前选区边界信息
            const selectionBounds = await this.getSelectionBounds();
            if (!selectionBounds) {
                console.warn('❌ 没有选区，无法执行快速蒙版清除操作');
                return;
            }
            console.log('✅ 获取选区边界成功:', selectionBounds);

            // 获取快速蒙版通道的像素数据
            const quickMaskPixels = await this.getQuickMaskPixels(selectionBounds);
            console.log('✅ 获取快速蒙版像素数据成功，数据长度:', quickMaskPixels.length);
            
            // 根据填充模式获取填充内容的灰度数据
            let fillGrayData;
            if (state.fillMode === 'foreground') {
                console.log('🎨 使用纯色填充模式');
                fillGrayData = await this.getSolidFillGrayData(state, selectionBounds);
            } else if (state.fillMode === 'pattern' && state.selectedPattern) {
                console.log('🔳 使用图案填充模式');
                fillGrayData = await this.getPatternFillGrayData(state, selectionBounds);
            } else if (state.fillMode === 'gradient' && state.selectedGradient) {
                console.log('🌈 使用渐变填充模式');
                fillGrayData = await this.getGradientFillGrayData(state, selectionBounds);
            } else {
                console.warn('❌ 未知的填充模式或缺少填充数据，填充模式:', state.fillMode);
                return;
            }
            console.log('✅ 获取填充灰度数据成功，数据长度:', fillGrayData.length);

            // 应用新的混合公式计算最终灰度值
            const finalGrayData = this.calculateFinalGrayValues(quickMaskPixels, fillGrayData);
            console.log('✅ 计算最终灰度值成功，数据长度:', finalGrayData.length);
            
            // 将计算后的灰度数据写回快速蒙版通道
            await this.updateQuickMaskChannel(finalGrayData, selectionBounds);
            console.log('✅ 快速蒙版清除操作完成');
            
        } catch (error) {
            console.error('❌ 快速蒙版特殊填充失败:', error);
            throw error;
        }
    }

    // 获取选区边界信息
    static async getSelectionBounds() {
        try {
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
                    ]
                }
            ], { synchronousExecution: true });
            
            if (result[0] && result[0].selection && result[0].selection.bottom !== undefined) {
                const selection = result[0].selection;
                return {
                    left: selection.left._value,
                    top: selection.top._value,
                    right: selection.right._value,
                    bottom: selection.bottom._value,
                    width: selection.right._value - selection.left._value,
                    height: selection.bottom._value - selection.top._value
                };
            }
            return null;
        } catch (error) {
            console.error('获取选区边界失败:', error);
            return null;
        }
    }

    // 获取快速蒙版通道的像素数据
    static async getQuickMaskPixels(bounds: any) {
        try {
            console.log('🔍 尝试获取快速蒙版像素数据，边界:', bounds);
            // 使用imaging API获取快速蒙版通道的像素数据
            const pixels = await imaging.getPixels({
                documentID: app.activeDocument.id,
                sourceBounds: {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom
                },
                targetSize: {
                    width: bounds.width,
                    height: bounds.height
                },
                channelID: "mask" // 获取快速蒙版通道
            });
            
            const data = await pixels.imageData.getData();
            console.log('✅ 成功获取快速蒙版像素数据，数据类型:', data.constructor.name, '长度:', data.length);
            return data;
        } catch (error) {
            console.error('❌ 获取快速蒙版像素数据失败:', error);
            console.log('🔄 使用备用方法获取快速蒙版数据');
            // 如果无法直接获取快速蒙版，尝试通过其他方式
            return this.getFallbackQuickMaskData(bounds);
        }
    }

    // 备用方法：通过其他方式获取快速蒙版数据
    static async getFallbackQuickMaskData(bounds: any) {
        // 创建一个默认的灰度数组，假设选区内都是0（黑色）
        const pixelCount = bounds.width * bounds.height;
        const grayData = new Uint8Array(pixelCount);
        // 初始化为0，表示完全选中的区域
        grayData.fill(0);
        return grayData;
    }

    // 获取纯色填充的灰度数据
    static async getSolidFillGrayData(state: any, bounds: any) {
        const panelColor = calculateRandomColor(state.colorSettings, state.opacity);
        console.log('🎨 获取到的面板颜色 (HSB):', panelColor);
        
        // 将HSB转换为RGB
        const rgbColor = this.hsbToRgb(panelColor.hsb.hue, panelColor.hsb.saturation, panelColor.hsb.brightness);
        console.log('🎨 转换后的RGB颜色:', rgbColor);
        
        // 将RGB转换为灰度值：Gray = 0.299*R + 0.587*G + 0.114*B
        const grayValue = Math.round(
            0.299 * rgbColor.red + 
            0.587 * rgbColor.green + 
            0.114 * rgbColor.blue
        );
        console.log('🎨 计算得到的灰度值:', grayValue);
        
        const pixelCount = bounds.width * bounds.height;
        const grayData = new Uint8Array(pixelCount);
        grayData.fill(grayValue);
        return grayData;
    }

    // 获取图案填充的灰度数据
    static async getPatternFillGrayData(state: any, bounds: any) {
        try {
            // 如果图案有预先计算的灰度数据，使用它
            if (state.selectedPattern.grayData) {
                return this.tilePatternToFitBounds(state.selectedPattern.grayData, 
                    state.selectedPattern.width, state.selectedPattern.height, bounds);
            }
            
            // 否则创建一个默认的灰度值
            const pixelCount = bounds.width * bounds.height;
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128); // 中等灰度
            return grayData;
        } catch (error) {
            console.error('获取图案灰度数据失败:', error);
            const pixelCount = bounds.width * bounds.height;
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128);
            return grayData;
        }
    }

    // 获取渐变填充的灰度数据
    static async getGradientFillGrayData(state: any, bounds: any) {
        try {
            const gradient = state.selectedGradient;
            const pixelCount = bounds.width * bounds.height;
            const grayData = new Uint8Array(pixelCount);
            
            // 计算渐变的中心点和角度
            const centerX = bounds.width / 2;
            const centerY = bounds.height / 2;
            const angleRad = (gradient.angle || 0) * Math.PI / 180;
            
            for (let y = 0; y < bounds.height; y++) {
                for (let x = 0; x < bounds.width; x++) {
                    const index = y * bounds.width + x;
                    let position;
                    
                    if (gradient.type === 'radial') {
                        // 径向渐变
                        const dx = x - centerX;
                        const dy = y - centerY;
                        const distance = Math.sqrt(dx * dx + dy * dy);
                        const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
                        position = Math.min(1, distance / maxDistance);
                    } else {
                        // 线性渐变
                        const dx = x - centerX;
                        const dy = y - centerY;
                        const projectedDistance = dx * Math.cos(angleRad) + dy * Math.sin(angleRad);
                        const maxProjectedDistance = Math.abs(centerX * Math.cos(angleRad)) + Math.abs(centerY * Math.sin(angleRad));
                        position = Math.max(0, Math.min(1, (projectedDistance + maxProjectedDistance) / (2 * maxProjectedDistance)));
                    }
                    
                    // 根据位置插值渐变颜色并转换为灰度
                    const color = this.interpolateGradientColor(gradient.stops, position);
                    const grayValue = Math.round(
                        0.299 * color.red + 
                        0.587 * color.green + 
                        0.114 * color.blue
                    );
                    grayData[index] = grayValue;
                }
            }
            
            return grayData;
        } catch (error) {
            console.error('获取渐变灰度数据失败:', error);
            const pixelCount = bounds.width * bounds.height;
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128);
            return grayData;
        }
    }

    // 将图案平铺到指定边界
    static tilePatternToFitBounds(patternGrayData: Uint8Array, patternWidth: number, patternHeight: number, bounds: any) {
        const pixelCount = bounds.width * bounds.height;
        const tiledData = new Uint8Array(pixelCount);
        
        for (let y = 0; y < bounds.height; y++) {
            for (let x = 0; x < bounds.width; x++) {
                const targetIndex = y * bounds.width + x;
                const sourceX = x % patternWidth;
                const sourceY = y % patternHeight;
                const sourceIndex = sourceY * patternWidth + sourceX;
                tiledData[targetIndex] = patternGrayData[sourceIndex];
            }
        }
        
        return tiledData;
    }

    // 插值渐变颜色
    static interpolateGradientColor(stops: any[], position: number) {
        if (!stops || stops.length === 0) {
            return { red: 128, green: 128, blue: 128 };
        }
        
        if (stops.length === 1) {
            const color = stops[0].color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            return color ? {
                red: parseInt(color[1]),
                green: parseInt(color[2]),
                blue: parseInt(color[3])
            } : { red: 128, green: 128, blue: 128 };
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
        
        const leftColor = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        const rightColor = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        
        if (!leftColor || !rightColor) {
            return { red: 128, green: 128, blue: 128 };
        }
        
        const ratio = (position * 100 - leftStop.position) / (rightStop.position - leftStop.position);
        
        return {
            red: Math.round(parseInt(leftColor[1]) * (1 - ratio) + parseInt(rightColor[1]) * ratio),
            green: Math.round(parseInt(leftColor[2]) * (1 - ratio) + parseInt(rightColor[2]) * ratio),
            blue: Math.round(parseInt(leftColor[3]) * (1 - ratio) + parseInt(rightColor[3]) * ratio)
        };
    }

    // 应用新的混合公式计算最终灰度值
    static calculateFinalGrayValues(maskData: Uint8Array, fillData: Uint8Array) {
        const finalData = new Uint8Array(maskData.length);
        
        for (let i = 0; i < maskData.length; i++) {
            const maskValue = maskData[i];  // 快速蒙版像素值 (0-255)
            const fillValue = fillData[i];  // 填充内容像素灰度值 (0-255)
            
            // 应用公式：maskValue + fillValue - (maskValue * fillValue) / 255
            const finalValue = maskValue + fillValue - (maskValue * fillValue) / 255;
            finalData[i] = Math.min(255, Math.max(0, Math.round(finalValue)));
        }
        
        return finalData;
    }

    // 将计算后的灰度数据写回快速蒙版通道
    static async updateQuickMaskChannel(grayData: Uint8Array, bounds: any) {
        try {
            console.log('🔄 开始更新快速蒙版通道，数据长度:', grayData.length, '边界:', bounds);
            
            // 创建PhotoshopImageData对象，快速蒙版是选区，使用putSelection API
            const options = {
                width: bounds.width,
                height: bounds.height,
                components: 1,
                chunky: false,  // 对于单通道灰度图像使用false
                colorSpace: "Grayscale",
                colorProfile: "Dot Gain 15%"  // 根据示例代码添加颜色配置文件
            };
            
            console.log('🔧 创建ImageData选项:', options);
            const imageData = await imaging.createImageDataFromBuffer(grayData, options);
            console.log('✅ 成功创建ImageData对象');
            
            // 快速蒙版实际上是选区，使用putSelection而不是putPixels
            const putSelectionOptions = {
                documentID: app.activeDocument.id,
                imageData: imageData
            };
            
            console.log('🔧 putSelection选项:', putSelectionOptions);
            await imaging.putSelection(putSelectionOptions);
            console.log('✅ 成功更新快速蒙版选区');
            
            // 释放图像数据
            imageData.dispose();
            console.log('✅ 已释放ImageData对象');
            
        } catch (error) {
            console.error('❌ 更新快速蒙版通道失败:', error);
            console.log('🔄 尝试使用备用方法更新快速蒙版');
            // 如果直接写入失败，尝试通过其他方式
            await this.fallbackUpdateQuickMask(grayData, bounds);
        }
    }

    // 备用方法：通过其他方式更新快速蒙版
    static async fallbackUpdateQuickMask(grayData: Uint8Array, bounds: any) {
        try {
            console.log('🔄 执行备用快速蒙版更新方法');
            
            // 计算平均灰度值作为色阶调整的参考
            const avgGray = grayData.reduce((sum, val) => sum + val, 0) / grayData.length;
            const outputMin = Math.round(avgGray);
            
            console.log('📊 计算得到的平均灰度值:', avgGray, '输出最小值:', outputMin);
            console.log('⚠️  注意：备用方法只能模拟效果，无法实现精确的像素级混合');
            
            // 使用色阶调整来模拟效果
            await action.batchPlay([
                {
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
                }
            ], { synchronousExecution: true });
            
            console.log('✅ 备用快速蒙版更新成功，使用色阶调整模拟效果');
            console.log('💡 建议：如果需要精确效果，请检查imaging API的使用是否正确');
        } catch (error) {
            console.error('❌ 备用快速蒙版更新方法也失败:', error);
        }
    }

    // 将RGB颜色转换为灰度值
    static rgbToGray(red: number, green: number, blue: number) {
        return Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
    }

    // 将HSB颜色转换为RGB
    static hsbToRgb(hue: number, saturation: number, brightness: number) {
        const h = hue / 360;
        const s = saturation / 100;
        const v = brightness / 100;
        
        const c = v * s;
        const x = c * (1 - Math.abs((h * 6) % 2 - 1));
        const m = v - c;
        
        let r, g, b;
        
        if (h >= 0 && h < 1/6) {
            r = c; g = x; b = 0;
        } else if (h >= 1/6 && h < 2/6) {
            r = x; g = c; b = 0;
        } else if (h >= 2/6 && h < 3/6) {
            r = 0; g = c; b = x;
        } else if (h >= 3/6 && h < 4/6) {
            r = 0; g = x; b = c;
        } else if (h >= 4/6 && h < 5/6) {
            r = x; g = 0; b = c;
        } else {
            r = c; g = 0; b = x;
        }
        
        return {
            red: Math.round((r + m) * 255),
            green: Math.round((g + m) * 255),
            blue: Math.round((b + m) * 255)
        };
    }
}

