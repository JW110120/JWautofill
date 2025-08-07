import { app, action, core, imaging } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Pattern, Gradient } from '../types/state';
import { BLEND_MODE_CALCULATIONS } from './BlendModeCalculations';
import { calculateRandomColor, hsbToRgb, rgbToGray } from './ColorUtils';
import { PatternFill } from './PatternFill';
import { GradientFill } from './GradientFill';

interface SingleChannelFillOptions {
    opacity: number;
    blendMode: string;
    preserveTransparency?: boolean;
    pattern?: Pattern;
    gradient?: Gradient;
}

interface ChannelInfo {
    channelName: string;
    channelIndex: number;
    isColorChannel: boolean;
}

export class SingleChannelHandler {
    
    // 主入口：单通道填充
    static async fillSingleChannel(options: SingleChannelFillOptions, fillMode: 'foreground' | 'pattern' | 'gradient', state?: any) {
        try {
            console.log('🎨 开始单通道填充操作，模式:', fillMode);
            
            // 检查是否在单通道模式
            const channelInfo = await this.getCurrentChannelInfo();
            if (!channelInfo || !channelInfo.isColorChannel) {
                console.error('❌ 当前不在单个颜色通道模式');
                return;
            }
            
            // 获取选区数据
            const bounds = await this.getSelectionData();
            if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('❌ 无法获取选区数据或选区为空');
                return;
            }
            
            // 获取当前通道的灰度数据
            const channelData = await this.getChannelPixels(bounds, channelInfo);
            
            let fillData: Uint8Array;
            let alphaData: Uint8Array | undefined;
            
            // 根据填充模式生成填充数据
            switch (fillMode) {
                case 'foreground':
                    fillData = await this.generateSolidColorData(bounds, state);
                    break;
                case 'pattern':
                    if (!options.pattern) {
                        await core.showAlert({ message: '请先选择一个图案预设' });
                        return;
                    }
                    const patternResult = await this.generatePatternData(bounds, options.pattern, state);
                    fillData = patternResult.colorData;
                    alphaData = patternResult.alphaData;
                    break;
                case 'gradient':
                    if (!options.gradient) {
                        await core.showAlert({ message: '请先选择一个渐变预设' });
                        return;
                    }
                    const gradientResult = await this.generateGradientData(bounds, options.gradient, state);
                    fillData = gradientResult.colorData;
                    alphaData = gradientResult.alphaData;
                    break;
                default:
                    throw new Error('不支持的填充模式');
            }
            
            // 混合计算
            const finalData = await this.calculateFillBlend(
                channelData,
                fillData,
                alphaData,
                options.opacity,
                options.blendMode,
                bounds
            );
            
            // 写回通道数据
            await this.updateChannelPixels(finalData, bounds, channelInfo, state);
            
            console.log('✅ 单通道填充完成');
        } catch (error) {
            console.error('❌ 单通道填充失败:', error);
            throw error;
        }
    }
    
    // 主入口：单通道清除
    static async clearSingleChannel(options: SingleChannelFillOptions, fillMode: 'foreground' | 'pattern' | 'gradient', state?: any) {
        try {
            console.log('🧹 开始单通道清除操作，模式:', fillMode);
            
            // 检查是否在单通道模式
            const channelInfo = await this.getCurrentChannelInfo();
            if (!channelInfo || !channelInfo.isColorChannel) {
                console.error('❌ 当前不在单个颜色通道模式');
                return;
            }
            
            // 获取选区数据
            const bounds = await this.getSelectionData();
            if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('❌ 无法获取选区数据或选区为空');
                return;
            }
            
            // 获取当前通道的灰度数据
            const channelData = await this.getChannelPixels(bounds, channelInfo);
            
            let clearData: Uint8Array;
            let alphaData: Uint8Array | undefined;
            
            // 根据清除模式生成清除数据
            switch (fillMode) {
                case 'foreground':
                    clearData = await this.generateSolidColorData(bounds, state);
                    break;
                case 'pattern':
                    if (!options.pattern) {
                        await core.showAlert({ message: '请先选择一个图案预设' });
                        return;
                    }
                    const patternResult = await this.generatePatternData(bounds, options.pattern, state);
                    clearData = patternResult.colorData;
                    alphaData = patternResult.alphaData;
                    break;
                case 'gradient':
                    if (!options.gradient) {
                        await core.showAlert({ message: '请先选择一个渐变预设' });
                        return;
                    }
                    const gradientResult = await this.generateGradientData(bounds, options.gradient, state);
                    clearData = gradientResult.colorData;
                    alphaData = gradientResult.alphaData;
                    break;
                default:
                    throw new Error('不支持的清除模式');
            }
            
            // 混合计算（清除模式）
            const finalData = await this.calculateClearBlend(
                channelData,
                clearData,
                alphaData,
                options.opacity,
                bounds
            );
            
            // 写回通道数据
            await this.updateChannelPixels(finalData, bounds, channelInfo, state);
            
            console.log('✅ 单通道清除完成');
        } catch (error) {
            console.error('❌ 单通道清除失败:', error);
            throw error;
        }
    }
    
    // 获取当前通道信息
    private static async getCurrentChannelInfo(): Promise<ChannelInfo | null> {
        try {
            const targetChannelResult = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "channel",
                            _enum: "ordinal",
                            _value: "targetEnum"
                        }
                    ],
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
            if (targetChannelResult[0]) {
                const targetChannelInfo = targetChannelResult[0];
                const channelName = targetChannelInfo.channelName;
                
                console.log('🔍 SingleChannelHandler - 当前激活通道:', channelName);
                
                // 检测是否为单个颜色通道
                const singleColorChannels = ["红", "绿", "蓝", "Red", "Grain", "Blue", "R", "G", "B"];
                const isColorChannel = singleColorChannels.includes(channelName);
                
                return {
                    channelName,
                    channelIndex: 0, // 暂时设为0，因为我们主要通过名称识别
                    isColorChannel
                };
            }
            return null;
        } catch (error) {
            console.error('❌ SingleChannelHandler - 获取通道信息失败:', error);
            return null;
        }
    }
    
    // 获取选区数据
    private static async getSelectionData() {
        try {
            // 使用与GradientFill相同的逻辑
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
            
            // 释放 ImageData 资源
            pixels.imageData.dispose();
            
            // 处理选区数据，创建选区索引和系数
            const tempSelectionValues = new Uint8Array(width * height);
            const tempSelectionCoefficients = new Float32Array(width * height);
            const selectionDocIndices = new Set<number>();
            
            if (selectionData.length === width * height) {
                // 单通道数据
                for (let i = 0; i < width * height; i++) {
                    tempSelectionValues[i] = selectionData[i];
                    tempSelectionCoefficients[i] = selectionData[i] / 255;
                    
                    if (selectionData[i] > 0) {
                        const boundsX = i % width;
                        const boundsY = Math.floor(i / width);
                        const docX = left + boundsX;
                        const docY = top + boundsY;
                        const docIndex = docY * docWidthPixels + docX;
                        selectionDocIndices.add(docIndex);
                    }
                }
            }
            
            // 提取选区内像素的选择系数
            const selectionCoefficients = new Float32Array(selectionDocIndices.size);
            let coeffIndex = 0;
            
            for (const docIndex of selectionDocIndices) {
                const docX = docIndex % docWidthPixels;
                const docY = Math.floor(docIndex / docWidthPixels);
                const boundsX = docX - left;
                const boundsY = docY - top;
                
                if (boundsX >= 0 && boundsX < width && boundsY >= 0 && boundsY < height) {
                    const boundsIndex = boundsY * width + boundsX;
                    selectionCoefficients[coeffIndex] = tempSelectionCoefficients[boundsIndex];
                }
                coeffIndex++;
            }
            
            return {
                left,
                top,
                right,
                bottom,
                width,
                height,
                docWidth: docWidthPixels,
                docHeight: docHeightPixels,
                selectionDocIndices,
                selectionCoefficients
            };
        } catch (error) {
            console.error('❌ 获取选区数据失败:', error);
            return null;
        }
    }
    
    // 获取通道像素数据
    private static async getChannelPixels(bounds: any, channelInfo: ChannelInfo): Promise<Uint8Array> {
        try {        
            // 使用batchPlay获取通道像素数据
            const channelResult = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "channel",
                            _name: channelInfo.channelName
                        }
                    ]
                }
            ], { synchronousExecution: true });
            
            if (!channelResult[0]) {
                throw new Error(`无法获取通道信息: ${channelInfo.channelName}`);
            }
            
            // 使用imaging.getPixels获取RGB图像数据，然后提取对应通道
            const pixelOptions = {
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
                componentSize: 8
            };
            
            const pixelData = await imaging.getPixels(pixelOptions);
            if (pixelData && pixelData.imageData) {
                const dataPromise = pixelData.imageData.getData();
                let rgbData: Uint8Array;
                if (dataPromise && typeof dataPromise.then === 'function') {
                    rgbData = await dataPromise;
                } else {
                    rgbData = dataPromise;
                }
                
                // 确定通道索引（0=红，1=绿，2=蓝）
                let channelIndex = 0;
                const channelName = channelInfo.channelName.toLowerCase();
                if (channelName.includes('绿') || channelName.includes('green') || channelName === 'g') {
                    channelIndex = 1;
                } else if (channelName.includes('蓝') || channelName.includes('blue') || channelName === 'b') {
                    channelIndex = 2;
                }
                
                console.log('📊 SingleChannelHandler - 通道索引:', channelIndex, '通道名称:', channelInfo.channelName);
                
                // 提取指定通道的数据
                const channelData = new Uint8Array(bounds.width * bounds.height);
                const components = rgbData.length / (bounds.width * bounds.height);
                
                for (let i = 0; i < bounds.width * bounds.height; i++) {
                    channelData[i] = rgbData[i * components + channelIndex];
                }
                
                // 提取选区内的像素数据
                const selectedChannelData = new Uint8Array(bounds.selectionDocIndices.size);
                let index = 0;
                
                for (const docIndex of bounds.selectionDocIndices) {
                    const docX = docIndex % bounds.docWidth;
                    const docY = Math.floor(docIndex / bounds.docWidth);
                    const boundsX = docX - bounds.left;
                    const boundsY = docY - bounds.top;
                    
                    if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                        const boundsIndex = boundsY * bounds.width + boundsX;
                        selectedChannelData[index] = channelData[boundsIndex] || 0;
                    } else {
                        selectedChannelData[index] = 0;
                    }
                    index++;
                }
                
                console.log('✅ SingleChannelHandler - 成功获取通道像素数据，选区内像素数量:', selectedChannelData.length);
                
                // 释放 ImageData 资源
                pixelData.imageData.dispose();
                
                return selectedChannelData;
            } else {
                throw new Error('无法获取通道像素数据');
            }
        } catch (error) {
            console.error('❌ SingleChannelHandler - 获取通道像素数据失败:', error);
            throw error;
        }
    }
    
    // 生成纯色数据
    private static async generateSolidColorData(bounds: any, state: any): Promise<Uint8Array> {
        console.log('🎨 生成纯色数据');
        
        // 计算抖动后的颜色
        const randomColorResult = calculateRandomColor(
            {
                hueVariation: state?.hueVariation || 0,
                saturationVariation: state?.saturationVariation || 0,
                brightnessVariation: state?.brightnessVariation || 0,
                opacityVariation: state?.opacityVariation || 0,
                calculationMode: state?.calculationMode || 'absolute'
            },
            100, // 基础不透明度
            undefined, // 使用当前前景色
            false // 非快速蒙版模式
        );
        
        // 将抖动后的颜色转换为RGB
        const rgb = hsbToRgb(
            randomColorResult.hsb.hue,
            randomColorResult.hsb.saturation,
            randomColorResult.hsb.brightness
        );
        
        // 转换为灰度值
        const grayValue = rgbToGray(rgb.red, rgb.green, rgb.blue);
        
        // 创建纯色数据数组
        const colorData = new Uint8Array(bounds.selectionDocIndices.size);
        colorData.fill(grayValue);
        
        console.log('✅ 纯色数据生成完成，灰度值:', grayValue);
        return colorData;
    }
    
    // 生成图案数据
    private static async generatePatternData(bounds: any, pattern: Pattern, state: any): Promise<{ colorData: Uint8Array; alphaData?: Uint8Array }> {
        console.log('🔳 生成图案数据');
        
        // 复用PatternFill中的逻辑
        const patternWidth = pattern.width || pattern.originalWidth || 100;
        const patternHeight = pattern.height || pattern.originalHeight || 100;
        const scale = pattern.currentScale || pattern.scale || 100;
        const scaledPatternWidth = Math.round(patternWidth * scale / 100);
        const scaledPatternHeight = Math.round(patternHeight * scale / 100);
        const angle = pattern.currentAngle || pattern.angle || 0;
        
        let patternResult: { colorData: Uint8Array; alphaData?: Uint8Array };
        
        if (pattern.fillMode === 'stamp') {
            // 盖图章模式 - 需要动态导入函数
            const { createStampPatternData } = await import('./PatternFill');
            const stampResult = await createStampPatternData(
                pattern.patternRgbData,
                patternWidth,
                patternHeight,
                pattern.patternComponents || 3,
                bounds.width,
                bounds.height,
                scaledPatternWidth,
                scaledPatternHeight,
                angle,
                bounds,
                true, // 灰度模式
                pattern.hasAlpha && pattern.patternComponents === 4 // 生成透明度数据
            );
            
            patternResult = {
                colorData: stampResult.colorData,
                alphaData: stampResult.alphaData
            };
        } else {
            // 贴墙纸模式 - 需要动态导入函数
            const { createTilePatternData } = await import('./PatternFill');
            const tileResult = createTilePatternData(
                pattern.patternRgbData,
                patternWidth,
                patternHeight,
                pattern.patternComponents || 3,
                bounds.width,
                bounds.height,
                scaledPatternWidth,
                scaledPatternHeight,
                angle,
                pattern.rotateAll !== false,
                bounds,
                pattern.hasAlpha && pattern.patternComponents === 4 // 生成透明度数据
            );
            
            patternResult = {
                colorData: tileResult.colorData,
                alphaData: tileResult.alphaData
            };
        }
        
        // 提取选区内的图案数据
        const selectedColorData = new Uint8Array(bounds.selectionDocIndices.size);
        let selectedAlphaData: Uint8Array | undefined;
        
        if (patternResult.alphaData) {
            selectedAlphaData = new Uint8Array(bounds.selectionDocIndices.size);
        }
        
        let index = 0;
        for (const docIndex of bounds.selectionDocIndices) {
            const docX = docIndex % bounds.docWidth;
            const docY = Math.floor(docIndex / bounds.docWidth);
            const boundsX = docX - bounds.left;
            const boundsY = docY - bounds.top;
            
            if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                const boundsIndex = boundsY * bounds.width + boundsX;
                selectedColorData[index] = patternResult.colorData[boundsIndex] || 0;
                
                if (selectedAlphaData && patternResult.alphaData) {
                    selectedAlphaData[index] = patternResult.alphaData[boundsIndex] || 0;
                }
            } else {
                selectedColorData[index] = 0;
                if (selectedAlphaData) {
                    selectedAlphaData[index] = 0;
                }
            }
            index++;
        }
        
        console.log('✅ 图案数据生成完成');
        return {
            colorData: selectedColorData,
            alphaData: selectedAlphaData
        };
    }
    
    // 生成渐变数据
    private static async generateGradientData(bounds: any, gradient: Gradient, state: any): Promise<{ colorData: Uint8Array; alphaData?: Uint8Array }> {
        console.log('🌈 生成渐变数据');
        
        // 复用GradientFill中的逻辑生成渐变灰度数据
        const gradientGrayData = await (GradientFill as any).getGradientFillGrayData(gradient, bounds);
        
        // 生成渐变透明度数据
        const gradientAlphaData = await (GradientFill as any).generateGradientAlphaData(gradient, bounds);
        
        console.log('✅ 渐变数据生成完成');
        return {
            colorData: gradientGrayData,
            alphaData: gradientAlphaData
        };
    }
    
    // 计算填充混合
    private static async calculateFillBlend(
        channelData: Uint8Array,
        fillData: Uint8Array,
        alphaData: Uint8Array | undefined,
        opacity: number,
        blendMode: string,
        bounds: any
    ): Promise<Uint8Array> {
        console.log('🔄 计算填充混合');
        
        const finalData = new Uint8Array(channelData.length);
        const opacityFactor = opacity / 100;
        
        // 获取混合模式计算函数
        const blendFunction = BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
        
        for (let i = 0; i < channelData.length; i++) {
            const baseValue = channelData[i];
            const fillValue = fillData[i] || 0;
            
            // 计算有效不透明度
            let effectiveOpacity = opacityFactor;
            
            // 应用透明度数据
            if (alphaData && alphaData[i] !== undefined) {
                effectiveOpacity *= alphaData[i] / 255;
            }
            
            // 应用选区羽化系数
            if (bounds.selectionCoefficients && i < bounds.selectionCoefficients.length) {
                effectiveOpacity *= bounds.selectionCoefficients[i];
            }
            
            // 执行混合计算
            const blendedValue = blendFunction(baseValue, fillValue);
            
            // 应用不透明度
            finalData[i] = Math.round(baseValue + (blendedValue - baseValue) * effectiveOpacity);
        }
        
        console.log('✅ 填充混合计算完成');
        return finalData;
    }
    
    // 计算清除混合
    private static async calculateClearBlend(
        channelData: Uint8Array,
        clearData: Uint8Array,
        alphaData: Uint8Array | undefined,
        opacity: number,
        bounds: any
    ): Promise<Uint8Array> {
        console.log('🧹 计算清除混合');
        
        const finalData = new Uint8Array(channelData.length);
        const opacityFactor = opacity / 100;
        
        for (let i = 0; i < channelData.length; i++) {
            const baseValue = channelData[i];
            const clearValue = clearData[i] || 0;
            
            // 计算有效不透明度
            let effectiveOpacity = opacityFactor;
            
            // 应用透明度数据
            if (alphaData && alphaData[i] !== undefined) {
                effectiveOpacity *= alphaData[i] / 255;
            }
            
            // 应用选区羽化系数
            if (bounds.selectionCoefficients && i < bounds.selectionCoefficients.length) {
                effectiveOpacity *= bounds.selectionCoefficients[i];
            }
            
            // 清除模式：最终值 = 清除值 * 有效不透明度
            finalData[i] = Math.round(clearValue * effectiveOpacity);
        }
        
        console.log('✅ 清除混合计算完成');
        return finalData;
    }
    
    // 更新通道像素数据
    private static async updateChannelPixels(finalData: Uint8Array, bounds: any, channelInfo: ChannelInfo, state?: any) {
        try {
            const activeDoc = app.activeDocument;
            const activeLayer = activeDoc.activeLayers[0];
            if (!activeLayer) {
                throw new Error('没有活动图层');
            }
            
            // 确定通道索引和通道名称
            let channelIndex: number;
            let targetChannelName: string;
            switch (channelInfo.channelName.toLowerCase()) {
                case 'red':
                case '红':
                    channelIndex = 0;
                    targetChannelName = 'red';
                    break;
                case 'grain':
                case '绿':
                    channelIndex = 1;
                    targetChannelName = 'grain'; // PS API中绿通道被错误命名为grain
                    break;
                case 'blue':
                case '蓝':
                    channelIndex = 2;
                    targetChannelName = 'blue';
                    break;
                default:
                    throw new Error(`不支持的通道: ${channelInfo.channelName}`);
            }
            
            console.log('💾 SingleChannelHandler - 更新通道索引:', channelIndex, '通道名称:', channelInfo.channelName, '目标通道:', targetChannelName);
            
            // 1. 创建临时图层
            await action.batchPlay([
                {
                    "_obj": "make",
                    "_target": [
                        {
                            "_ref": "layer"
                        }
                    ],
                    "using": {
                        "_obj": "layer",
                        "name": "特殊单通道写回图层"
                    },
                    "_isCommand": false
                }
            ], {});
            
            // 获取临时图层ID
            const tempLayer = activeDoc.activeLayers[0];
            const tempLayerId = tempLayer.id;
            
            // 2. 创建灰度数据数组（RGBA格式，所有通道都使用相同的灰度值）
            const grayRgbaData = new Uint8Array(bounds.docWidth * bounds.docHeight * 4);
            
            // 初始化为白色背景
            for (let i = 0; i < grayRgbaData.length; i += 4) {
                grayRgbaData[i] = 255;     // R
                grayRgbaData[i + 1] = 255; // G
                grayRgbaData[i + 2] = 255; // B
                grayRgbaData[i + 3] = 255; // A
            }
            
            // 将finalData写入选区位置的所有通道
            let dataIndex = 0;
            for (const docIndex of bounds.selectionDocIndices) {
                const docX = docIndex % bounds.docWidth;
                const docY = Math.floor(docIndex / bounds.docWidth);
                const pixelIndex = (docY * bounds.docWidth + docX) * 4;
                
                const grayValue = finalData[dataIndex];
                grayRgbaData[pixelIndex] = grayValue;     // R
                grayRgbaData[pixelIndex + 1] = grayValue; // G
                grayRgbaData[pixelIndex + 2] = grayValue; // B
                grayRgbaData[pixelIndex + 3] = 255;       // A
                
                dataIndex++;
            }
            
            // 创建ImageData并写入临时图层
            const tempImageData = await imaging.createImageDataFromBuffer(grayRgbaData, {
                width: bounds.docWidth,
                height: bounds.docHeight,
                colorSpace: 'RGB',
                hasAlpha: false,
                componentSize: 8,
                components: 4
            });
            
            await imaging.putPixels({
                documentID: activeDoc.id,
                layerID: tempLayerId,
                imageData: tempImageData,
                targetBounds: {
                    left: 0,
                    top: 0,
                    right: bounds.docWidth,
                    bottom: bounds.docHeight
                }
            });
            
            // 释放 ImageData 资源
            tempImageData.dispose();
            
            // 3. 选择原始图层
            await action.batchPlay([
                {
                    "_obj": "select",
                    "_target": [
                        {
                            "_ref": "layer",
                            "_id": activeLayer.id
                        }
                    ],
                    "_isCommand": false
                }
            ], {});
            
            // 4. 使用应用图像API将临时图层的指定通道复制到原图层的目标通道
            await action.batchPlay([
                {
                    "_obj": "applyImageEvent",
                    "with": {
                        "_obj": "calculation",
                        "to": {
                            "_ref": "channel",
                            "_enum": "channel",
                            "_value": targetChannelName
                        },
                        "preserveTransparency": true
                    },
                    "_isCommand": false
                }
            ], {});
            
            // 5. 删除临时图层
            await action.batchPlay([
                {
                    "_obj": "delete",
                    "_target": [
                        {
                            "_ref": "layer",
                            "_id": tempLayerId
                        }
                    ],
                    "_isCommand": false
                }
            ], {});
            
            console.log('✅ SingleChannelHandler - 成功更新通道像素数据');
        } catch (error) {
            console.error('❌ SingleChannelHandler - 更新通道像素数据失败:', error);
            throw error;
        }
    }
}