import { app, action, imaging, core } from 'photoshop';
import { LayerInfoHandler } from './LayerInfoHandler';
import { BLEND_MODES } from '../constants/blendModes';
import { Pattern, Gradient } from '../types/state';
import { BLEND_MODE_CALCULATIONS } from './BlendModeCalculations';
import { calculateRandomColor, hsbToRgb, rgbToGray } from './ColorUtils';
import { PatternFill, createStampPatternData, createTilePatternData } from './PatternFill';
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
    isSingleChannel: boolean;
    isAlphaChannel: boolean;
    isRgbChannel: boolean;
}

export class SingleChannelHandler {
    
    // 主入口：单通道填充
    static async fillSingleChannel(options: SingleChannelFillOptions, fillMode: 'foreground' | 'pattern' | 'gradient', state?: any): Promise<boolean> {
        try {
            console.log('🎨 开始单通道填充操作，模式:', fillMode);
            
            // 检查是否在单通道模式
            const channelInfo = await this.getCurrentChannelInfo();
            if (!channelInfo || !channelInfo.isSingleChannel) {
                console.error('❌ 当前不在单个颜色通道模式');
                return false;
            }
            
            // 获取选区数据
            const bounds = await this.getSelectionData();
            if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('❌ 无法获取选区数据或选区为空');
                return false;
            }
            
            // 获取当前通道的灰度数据和原始图像数据
            const pixelResult = await this.getChannelPixels(bounds, channelInfo);
            const channelData = pixelResult.channelData;
            const originalRgbaData = pixelResult.originalRgbaData; // 背景图层为RGB，普通图层为RGBA
            
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
                        return false;
                    }
                    const patternResult = await this.generatePatternData(bounds, options.pattern, state);
                    fillData = patternResult.colorData;
                    alphaData = patternResult.alphaData;
                    break;
                case 'gradient':
                    if (!options.gradient) {
                        await core.showAlert({ message: '请先选择一个渐变预设' });
                        return false;
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
            if (channelInfo.isAlphaChannel) {
                await this.updateAlphaChannelPixels(finalData, bounds, channelInfo, channelData, state);
                console.log('✅ alpha通道:', channelInfo.channelName);

            } else {
                await this.updateChannelPixels(finalData, bounds, channelInfo, originalRgbaData, state);
                console.log('✅ 红绿蓝通道:', channelInfo.channelName);

            }
            return true;
        } catch (error) {
            console.error('❌ 单通道填充失败:', error);
            return false;
        }
    }
    
    // 主入口：单通道清除
    static async clearSingleChannel(options: SingleChannelFillOptions, fillMode: 'foreground' | 'pattern' | 'gradient', state?: any): Promise<boolean> {
        try {
            console.log('🧹 开始单通道清除操作，模式:', fillMode);
            
            // 检查是否在单通道模式
            const channelInfo = await this.getCurrentChannelInfo();
            if (!channelInfo || !channelInfo.isSingleChannel) {
                console.error('❌ 当前不在单个颜色通道模式');
                return false;
            }
            
            // 获取选区数据
            const bounds = await this.getSelectionData();
            if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('❌ 无法获取选区数据或选区为空');
                return false;
            }
            
            // 获取当前通道的灰度数据和原始图像数据
            const pixelResult = await this.getChannelPixels(bounds, channelInfo);
            const channelData = pixelResult.channelData;
            const originalRgbaData = pixelResult.originalRgbaData; // 背景图层为RGB，普通图层为RGBA
            
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
                        return false;
                    }
                    const patternResult = await this.generatePatternData(bounds, options.pattern, state);
                    clearData = patternResult.colorData;
                    alphaData = patternResult.alphaData;
                    break;
                case 'gradient':
                    if (!options.gradient) {
                        await core.showAlert({ message: '请先选择一个渐变预设' });
                        return false;
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
            if (channelInfo.isAlphaChannel) {
                await this.updateAlphaChannelPixels(finalData, bounds, channelInfo, channelData, state);
            } else {
                await this.updateChannelPixels(finalData, bounds, channelInfo, originalRgbaData, state);
            }
              
            console.log('✅ 单通道清除完成');
            return true;
        } catch (error) {
            console.error('❌ 单通道清除失败:', error);
            return false;
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
                const itemIndex = targetChannelInfo.itemIndex;

                
                // 检测是否为单色通道（红、绿、蓝）
                const rgbChannels = ["红", "绿", "蓝", "Red", "Grain", "Blue", "R", "G", "B"];
                const isRgbChannel = rgbChannels.includes(channelName);
                
                // 检测是否为alpha通道（包括自定义alpha通道）
                const isAlphaChannel = channelName.toLowerCase().includes('alpha') || 
                                     channelName.match(/^alpha\s*\d*$/i) ||
                                     channelName.match(/^[aα]\s*\d*$/i) || itemIndex>=4;
                
                // 对于单通道操作，支持RGB通道和Alpha通道
                const isSingleChannel = isRgbChannel || isAlphaChannel;
                
                return {
                    channelName: targetChannelInfo.channelName,
                    channelIndex: targetChannelInfo.channelIndex,
                    isSingleChannel,
                    isAlphaChannel,
                    isRgbChannel
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
            const selectionCoefficients = new Float32Array(selectionSize);
            
            // 第三步：将选区内像素的系数填入新数组
            let fillIndex = 0;
            for (let i = 0; i < width * height; i++) {
                if (tempSelectionValues[i] > 0) {
                    selectionCoefficients[fillIndex] = tempSelectionCoefficients[i];
                    fillIndex++;
                }
            }
            console.log('选区内的像素数量：', selectionDocIndices.size);
            
            // 生成稳定的索引数组，确保后续所有处理顺序一致
            const selectionIndicesArray = Array.from(selectionDocIndices);
            
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
                selectionIndicesArray,
                selectionCoefficients
            };
        } catch (error) {
            console.error('❌ 获取选区数据失败:', error);
            return null;
        }
    }
    
    // 获取通道像素数据
    private static async getChannelPixels(bounds: any, channelInfo: ChannelInfo): Promise<{ channelData: Uint8Array; originalRgbaData: Uint8Array }> {
        try {        
             const doc = app.activeDocument;
            if (!doc) {
                throw new Error('没有活动文档');
            }
            
            const activeLayer = doc.activeLayers[0];
            if (!activeLayer) {
                throw new Error('没有活动图层');
            }
            
            // 当前通道为普通用户自建的alpha通道时，其灰度无法直接通过getPixels获取，需要先新建一个临时文档，通过应用图像把该通道的灰度值给临时文档，再从临时文档获取像素数据
            const isAlphaChannel = channelInfo.isAlphaChannel;
            if (isAlphaChannel) {
            // 2. 创建获取单通道灰度值的临时图层
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
                        "name": "临时获取灰度图层"
                    },
                    "_isCommand": false
                }
            ], {});
            
            // 获取临时灰度图层ID（使用batchPlay确保准确性）

            const tempGrayLayerResult = await action.batchPlay([
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
            
            const tempGrayLayerId = tempGrayLayerResult[0]?.layerID;

            if (!tempGrayLayerId) {
                throw new Error('无法获取临时灰度图层ID');
            }

             // 选中临时灰度图层ID（使用batchPlay确保准确性）
            await action.batchPlay([
                {
                    _obj: "select",
                    _target: [
                        {
                            _ref: "layer",
                            _id: tempGrayLayerId
                        }
                    ],
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });

            // 对临时灰度图层使用应用图像。
            await action.batchPlay([
                {
                    "_obj": "applyImageEvent",
                    "with": {
                        "_obj": "calculation",
                        "to": {
                            "_ref": "channel",
                            "_name": channelInfo.channelName
                        }
                    },
                    "_isCommand": false
                }
            ], { synchronousExecution: true });

             // 使用imaging.getPixels获取文档长度的RGB图像数据，然后提取对应通道
            const tempGrayLayerPixelOptions = {
                documentID: doc.id,
                layerID: tempGrayLayerId,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: bounds.docWidth,
                    bottom: bounds.docHeight
                },
                componentSize: 8
            };

            
            const tempGrayLayerPixelData = await imaging.getPixels(tempGrayLayerPixelOptions);
            if (!tempGrayLayerPixelData || !tempGrayLayerPixelData.imageData) {
                throw new Error('无法获取临时灰度图层的像素数据');
            }
            const tempGrayLayerRgbData = tempGrayLayerPixelData.imageData.getData();
            // 由于是一个只有灰度信息的单通道把数据给RGB的图层，所以图层的三个通道都是一样的。
            // 3，从tempGrayLayerRgbData获取红通道的灰度数据作为单通道数据
            const singleChannelData = new Uint8Array(bounds.docWidth * bounds.docHeight);
            for (let i = 0; i < tempGrayLayerRgbData.length; i += 4) {
                singleChannelData[i / 4] = tempGrayLayerRgbData[i];
            }
            // 4，从singleChannelData获取选区内的像素数据 (长度: bounds.selectionDocIndices.size)
            const selectionIndices = bounds.selectionIndicesArray || Array.from(bounds.selectionDocIndices);
            const selectionChannelData = new Uint8Array(selectionIndices.length);
            for (let i = 0; i < selectionIndices.length; i++) {
                selectionChannelData[i] = singleChannelData[selectionIndices[i]];
            }

            // 5，释放资源
            tempGrayLayerPixelData.imageData.dispose();
            
            // 6，删除临时灰度图层
            await action.batchPlay([
                {
                    "_obj": "delete",
                    "_target": [
                        {
                            "_ref": "layer",
                            "_id": tempGrayLayerId
                        }
                    ],
                    "_isCommand": false
                }
            ], {});

            // 1，使用imaging.getPixels获取原图层的完整RGB图像数据作为originalRgbaData
            const originalPixelOptions = {
                documentID: doc.id,
                layerID: activeLayer.id,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: bounds.docWidth,
                    bottom: bounds.docHeight
                },
                componentSize: 8
            };
            
            const originalPixelData = await imaging.getPixels(originalPixelOptions);
            if (!originalPixelData || !originalPixelData.imageData) {
                throw new Error('无法获取原图层像素数据');
            }
            const originalRgbaData = originalPixelData.imageData.getData();
            originalPixelData.imageData.dispose();

            return {
                channelData: selectionChannelData,
                originalRgbaData: originalRgbaData
            };

            

        } else {
            // RGB通道的处理逻辑
            
            // 使用imaging.getPixels获取文档长度的RGB图像数据，然后提取对应通道
            const pixelOptions = {
                documentID: doc.id,
                layerID: activeLayer.id,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: bounds.docWidth,
                    bottom: bounds.docHeight
                },
                componentSize: 8
            };
            
            const pixelData = await imaging.getPixels(pixelOptions);
            if (pixelData && pixelData.imageData) {
                const rgbData = await pixelData.imageData.getData();
                
                // 确定通道索引（0=红，1=绿，2=蓝）
                let channelIndex = 0;
                const channelName = channelInfo.channelName.toLowerCase();
                if (channelName.includes('绿') || channelName.includes('green') || channelName === 'g') {
                    channelIndex = 1;
                } else if (channelName.includes('蓝') || channelName.includes('blue') || channelName === 'b') {
                    channelIndex = 2;
                }

                
                // 第一步：提取完整文档的单通道数据 (长度: bounds.docWidth * bounds.docHeight)
                const totalPixels = bounds.docWidth * bounds.docHeight;
                const fullDocChannelData = new Uint8Array(totalPixels);
                const components = Math.round(rgbData.length / totalPixels);
     
                // 尝试不同的提取方式
                if (components === 3 || components === 4) {
                    // 标准的RGB/RGBA格式
                    for (let i = 0; i < totalPixels; i++) {
                        const pixelStartIndex = i * components;
                        fullDocChannelData[i] = rgbData[pixelStartIndex + channelIndex];
                    }
                } 

                // 第二步：从完整文档单通道数据中提取选区内的像素数据 (长度: bounds.selectionDocIndices.size)                
                const selectionChannelData = new Uint8Array(bounds.selectionDocIndices.size);
                
                if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                    
                    // 使用稳定顺序的selectionIndicesArray直接获取选区内像素
                    let fillIndex = 0;
                    const selectionIndices = bounds.selectionIndicesArray || Array.from(bounds.selectionDocIndices);
                    
                    for (const docIndex of selectionIndices) {
                        if (docIndex >= 0 && docIndex < fullDocChannelData.length && fillIndex < selectionChannelData.length) {
                            selectionChannelData[fillIndex] = fullDocChannelData[docIndex];
                            fillIndex++;
                        }
                    }
                    
                    console.log(`📊 通过selectionDocIndices提取了【单通道数据】中 ${fillIndex} 个像素`);
                }
                
                // 释放 ImageData 资源
                pixelData.imageData.dispose();
                
                return {
                    channelData: selectionChannelData,
                    originalRgbaData: rgbData // 根据图层类型，可能是RGB(背景图层)或RGBA(普通图层)数据
                };
            } else {
                throw new Error('无法获取通道像素数据');
            }
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
        
        // 验证图案数据
        if (((!pattern.patternRgbData || pattern.patternRgbData.length === 0) && (!pattern.grayData || pattern.grayData.length === 0))) {
            console.error('❌ 图案数据为空或无效（缺少RGB和灰度数据）');
            return {
                colorData: new Uint8Array(bounds.selectionDocIndices.size),
                alphaData: undefined
            };
        }
        
        // 首先生成或获取灰度数据
        if (!pattern.grayData) {
            console.log('🔄 从RGB数据生成灰度数据');
            const rgbData = pattern.patternRgbData;
            let width = pattern.width || pattern.originalWidth || 100;
            let height = pattern.height || pattern.originalHeight || 100;
            let components = pattern.patternComponents || pattern.components || 4; // 默认RGBA
            
            // 守护：确保为有效数值
            if (typeof width !== 'number' || !isFinite(width) || width <= 0) {
                console.warn('⚠️ 图案宽度无效，使用默认值 100，当前值:', pattern.width, pattern.originalWidth);
                width = 100;
            }
            if (typeof height !== 'number' || !isFinite(height) || height <= 0) {
                console.warn('⚠️ 图案高度无效，使用默认值 100，当前值:', pattern.height, pattern.originalHeight);
                height = 100;
            }
            if (typeof components !== 'number' || !isFinite(components) || components < 1 || components > 4) {
                console.warn('⚠️ 通道数无效，使用默认值 4，当前值:', pattern.patternComponents, pattern.components);
                components = 4;
            }
            
            // 如果RGB长度与尺寸不匹配，尝试推断components
            const expectedMin = width * height; // 最小1通道长度
            if (rgbData && rgbData.length < expectedMin) {
                console.error('❌ RGB数据长度小于最小期望值，无法生成灰度。len=', rgbData.length, 'expectMin=', expectedMin);
            }
            if (rgbData && rgbData.length % (width * height) === 0) {
                const inferred = rgbData.length / (width * height);
                if (inferred >= 1 && inferred <= 4 && inferred !== components) {
                    console.warn('ℹ️ 依据数据长度推断通道数为', inferred, '替换原通道数', components);
                    components = inferred;
                }
            }
            
            const grayData = new Uint8Array(width * height);
            if (rgbData && rgbData.length >= width * height * Math.max(1, components)) {
                for (let i = 0; i < width * height; i++) {
                    const r = rgbData[i * components];
                    const g = rgbData[i * components + 1];
                    const b = rgbData[i * components + 2];
                    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                    grayData[i] = gray;
                }
            } else {
                console.warn('⚠️ RGB数据长度与尺寸/通道不匹配，使用中性灰填充');
                grayData.fill(128);
            }
            
            // 将生成的灰度数据保存到图案对象中
            pattern.grayData = grayData;
            console.log('✅ 成功从RGB数据生成灰度数据，长度:', grayData.length);
        }
        
        // 复用PatternFill中的逻辑
        let patternWidth = pattern.width || pattern.originalWidth || 100;
        let patternHeight = pattern.height || pattern.originalHeight || 100;
        let scale = pattern.currentScale || pattern.scale || 100;
        
        // 守护：确保为有效数值
        if (typeof patternWidth !== 'number' || !isFinite(patternWidth) || patternWidth <= 0) {
            console.warn('⚠️ 图案宽度无效，使用默认值 100，当前值:', pattern.width, pattern.originalWidth);
            patternWidth = 100;
        }
        if (typeof patternHeight !== 'number' || !isFinite(patternHeight) || patternHeight <= 0) {
            console.warn('⚠️ 图案高度无效，使用默认值 100，当前值:', pattern.height, pattern.originalHeight);
            patternHeight = 100;
        }
        if (typeof scale !== 'number' || !isFinite(scale) || scale <= 0) {
            console.warn('⚠️ 缩放比例无效，使用默认值 100，当前值:', pattern.currentScale, pattern.scale);
            scale = 100;
        }
        
        const scaledPatternWidth = Math.max(1, Math.round(patternWidth * scale / 100));
        const scaledPatternHeight = Math.max(1, Math.round(patternHeight * scale / 100));
        const angle = pattern.currentAngle || pattern.angle || 0;
        
        // 灰度数据一致性校验：若长度与尺寸不符，尝试从RGB重建或填充
        if (pattern.grayData && pattern.grayData.length !== patternWidth * patternHeight) {
            console.warn('⚠️ 灰度数据长度与尺寸不匹配，尝试修正。grayLen=', pattern.grayData.length, 'w*h=', patternWidth * patternHeight);
            const rgbData = pattern.patternRgbData;
            let comps = pattern.patternComponents || pattern.components || 4;
            if (rgbData && rgbData.length % (patternWidth * patternHeight) === 0) {
                const inferred = rgbData.length / (patternWidth * patternHeight);
                if (inferred >= 1 && inferred <= 4) {
                    comps = inferred;
                }
            }
            const rebuilt = new Uint8Array(patternWidth * patternHeight);
            if (rgbData && rgbData.length >= patternWidth * patternHeight * Math.max(1, comps)) {
                for (let i = 0; i < patternWidth * patternHeight; i++) {
                    const r = rgbData[i * comps];
                    const g = rgbData[i * comps + 1];
                    const b = rgbData[i * comps + 2];
                    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                    rebuilt[i] = gray;
                }
                pattern.grayData = rebuilt;
                console.log('🔧 已根据RGB数据重建匹配尺寸的灰度数据，长度:', rebuilt.length);
            } else {
                rebuilt.fill(128);
                pattern.grayData = rebuilt;
                console.warn('🔧 无法从RGB重建，使用中性灰填充匹配尺寸的数据，长度:', rebuilt.length);
            }
        }
        
        console.log('图案参数:', {
            fillMode: pattern.fillMode,
            width: patternWidth,
            height: patternHeight,
            originalWidth: pattern.originalWidth,
            originalHeight: pattern.originalHeight,
            scale: scale,
            currentScale: pattern.currentScale,
            scaledWidth: scaledPatternWidth,
            scaledHeight: scaledPatternHeight,
            angle: angle,
            currentAngle: pattern.currentAngle,
            hasAlpha: pattern.hasAlpha,
            components: pattern.patternComponents,
            boundsSize: `${bounds.width}x${bounds.height}`,
            selectionSize: bounds.selectionDocIndices.size,
            patternDataLength: pattern.patternRgbData?.length || 0,
            grayDataLength: pattern.grayData?.length || 0,
            hasPatternData: !!pattern.patternRgbData,
            hasGrayData: !!pattern.grayData
        });
        
        // 使用灰度数据生成图案
        let grayPatternData: Uint8Array;
        let patternAlphaData: Uint8Array | undefined;
        
        if (pattern.fillMode === 'stamp') {
            // 盖图章模式 - 使用灰度数据
            console.log('🎯 单通道：使用盖图章模式填充');
            const stampResult = await createStampPatternData(
                pattern.grayData,
                patternWidth,
                patternHeight,
                1, // 灰度数据只有1个组件
                bounds.width,
                bounds.height,
                scaledPatternWidth,
                scaledPatternHeight,
                angle,
                bounds,
                true, // 灰度模式
                false // 不需要生成透明度数据（灰度模式）
            );
            
            grayPatternData = stampResult.colorData;
            
            // 如果需要透明度数据，从RGB数据生成
            if (pattern.hasAlpha && (pattern.patternComponents === 4 || pattern.components === 4)) {
                const alphaStampResult = await createStampPatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    pattern.patternComponents || pattern.components || 4, // 使用原始RGB数据的组件数
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    bounds,
                    false, // 非灰度模式
                    true // 生成透明度数据
                );
                patternAlphaData = alphaStampResult.alphaData;
            }
        } else {
            // 贴墙纸模式 - 使用灰度数据
            console.log('🧱 单通道：使用贴墙纸模式填充');
            const tileResult = createTilePatternData(
                pattern.grayData,
                patternWidth,
                patternHeight,
                1, // 灰度数据只有1个组件
                bounds.width,
                bounds.height,
                scaledPatternWidth,
                scaledPatternHeight,
                angle,
                pattern.rotateAll !== false,
                bounds,
                false // 不需要生成透明度数据（灰度模式）
            );
            
            grayPatternData = tileResult.colorData;
            
            // 如果需要透明度数据，从RGB数据生成
            if (pattern.hasAlpha && (pattern.patternComponents === 4 || pattern.components === 4)) {
                const alphaTileResult = createTilePatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    pattern.patternComponents || pattern.components || 4, // 使用原始RGB数据的组件数
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    pattern.rotateAll !== false,
                    bounds,
                    true // 生成透明度数据
                );
                patternAlphaData = alphaTileResult.alphaData;
            }
        }
        
        console.log('图案数据生成结果:', {
            grayDataLength: grayPatternData?.length || 0,
            alphaDataLength: patternAlphaData?.length || 0,
            expectedSize: bounds.width * bounds.height,
            grayDataSample: grayPatternData?.slice(0, 10) || [],
            hasValidData: grayPatternData && grayPatternData.length > 0
        });
        
        // 提取选区内的图案数据
        const selectedColorData = new Uint8Array(bounds.selectionDocIndices.size);
        let selectedAlphaData: Uint8Array | undefined;
        
        if (patternAlphaData) {
            selectedAlphaData = new Uint8Array(bounds.selectionDocIndices.size);
        }
        
        // 使用在getSelectionData中生成的稳定顺序的索引数组
        const selectionIndicesArray = bounds.selectionIndicesArray || Array.from(bounds.selectionDocIndices);
        
        for (let index = 0; index < selectionIndicesArray.length; index++) {
            const docIndex = selectionIndicesArray[index];
            const docX = docIndex % bounds.docWidth;
            const docY = Math.floor(docIndex / bounds.docWidth);
            const boundsX = docX - bounds.left;
            const boundsY = docY - bounds.top;
            
            if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                const boundsIndex = boundsY * bounds.width + boundsX;
                selectedColorData[index] = grayPatternData[boundsIndex] || 0;
                
                if (selectedAlphaData && patternAlphaData) {
                    selectedAlphaData[index] = patternAlphaData[boundsIndex] || 0;
                }
            } else {
                selectedColorData[index] = 0;
                if (selectedAlphaData) {
                    selectedAlphaData[index] = 0;
                }
            }
        }
        
        const nonZeroCount = selectedColorData.length > 0 ? Array.from(selectedColorData).filter(v => v > 0).length : 0;
        const averageValue = selectedColorData.length > 0 ? Array.from(selectedColorData).reduce((a, b) => a + b, 0) / selectedColorData.length : 0;
        console.log('选区图案数据提取结果:', {
            bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, docWidth: bounds.docWidth, docHeight: bounds.docHeight },
            selectedColorDataLength: selectedColorData.length,
            selectedAlphaDataLength: selectedAlphaData?.length || 0,
            selectedColorDataSample: selectedColorData.slice(0, 10),
            firstFewIndices: (bounds.selectionIndicesArray || Array.from(bounds.selectionDocIndices)).slice(0, 10),
            nonZeroCount,
            averageValue
        });
        
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
    
    // 计算填充
    private static async calculateFillBlend(
        selectionChannelData: Uint8Array, // 选区内的单通道数据 (长度: bounds.selectionDocIndices.size)
        selectionFillData: Uint8Array,    // 选区内的填充数据 (长度: bounds.selectionDocIndices.size)
        selectionAlphaData: Uint8Array | undefined, // 选区内的填充内容的透明度数据 (长度: bounds.selectionDocIndices.size)
        opacity: number,
        blendMode: string,
        bounds: any
    ): Promise<Uint8Array> {
        
        // 输出数据：选区内混合后的单通道数据 (长度: bounds.selectionDocIndices.size)
        const blendedSelectionData = new Uint8Array(bounds.selectionDocIndices.size);
        const opacityRatio = opacity * 0.01; // 避免重复除法
        
        // 获取混合模式计算函数
        const blendFunction = BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
        
        // 检查是否有选区羽化系数
        const hasFeathering = bounds?.selectionCoefficients?.length > 0;
        const selectionCoefficients = bounds?.selectionCoefficients;
        
        for (let i = 0; i < selectionChannelData.length; i++) {
            const baseValue = selectionChannelData[i]; // 选区内原始通道值
            const fillValue = selectionFillData[i];    // 选区内填充值
            const alphaValue = selectionAlphaData ? selectionAlphaData[i] : 255; // 选区内透明度值
            
            // 计算填充内容的最终的透明度（图案/渐变透明度 × 整体不透明度）
            const finalAlpha = (alphaValue / 255) * opacityRatio;
            
            // 如果填充内容最终透明度为0，直接保持原始通道值，不进行任何混合
            if (finalAlpha === 0) {
                blendedSelectionData[i] = baseValue;
                continue;
            }
            
            // 计算混合值
            const blendedValue = blendFunction(baseValue, fillValue);
            
            // 应用透明度混合
            const invAlphaRatio = 1 - finalAlpha;
            let blendedResult = baseValue * invAlphaRatio + blendedValue * finalAlpha;
            
            // 应用羽化系数（如果存在）
            if (hasFeathering && selectionCoefficients && selectionCoefficients[i] !== undefined) {
                const featherCoeff = selectionCoefficients[i];
                // 羽化混合：原始值 * (1 - 羽化系数) + 混合结果 * 羽化系数
                const invFeatherCoeff = 1 - featherCoeff;
                blendedResult = baseValue * invFeatherCoeff + blendedResult * featherCoeff;
            }
            
            // 快速边界检查和取整
            blendedSelectionData[i] = blendedResult > 255 ? 255 : (blendedResult < 0 ? 0 : Math.round(blendedResult));
        }
        
        return blendedSelectionData;
    }
    
    // 计算清除
    private static async calculateClearBlend(
        selectionChannelData: Uint8Array, // 选区内的单通道数据 (长度: bounds.selectionDocIndices.size)
        selectionClearData: Uint8Array,   // 选区内的清除数据 (长度: bounds.selectionDocIndices.size)
        selectionAlphaData: Uint8Array | undefined, // 选区内的透明度数据 (长度: bounds.selectionDocIndices.size)
        opacity: number,
        bounds: any
    ): Promise<Uint8Array> {
        console.log('🧹 计算清除混合');
        
        // 输出数据：选区内清除后的单通道数据 (长度: bounds.selectionDocIndices.size)
        const clearedSelectionData = new Uint8Array(selectionChannelData.length);
        const opacityFactor = opacity / 100;
        
        // 检查是否有选区羽化系数
        const hasFeathering = bounds?.selectionCoefficients?.length > 0;
        const selectionCoefficients = bounds?.selectionCoefficients;
        
        for (let i = 0; i < selectionChannelData.length; i++) {
            const baseValue = selectionChannelData[i]; // 选区内原始通道值 (0-255)
            const clearValue = selectionClearData[i] || 0; // 选区内清除值 (0-255)
            const alpha = selectionAlphaData ? selectionAlphaData[i] : 255; // 选区内透明度值 (0-255)
            
            // 如果图案/渐变完全透明，不进行清除操作
            if (alpha === 0) {
                clearedSelectionData[i] = baseValue;
                continue;
            }
            
            // 计算有效不透明度（考虑选区羽化系数）
            let effectiveOpacity = opacityFactor;
            if (hasFeathering && selectionCoefficients && selectionCoefficients[i] !== undefined) {
                effectiveOpacity *= selectionCoefficients[i];
            }
            
            // 减去模式：通道值 - (清除值 * 有效不透明度 * 透明度)
            const alphaFactor = alpha / 255;
            const subtractAmount = clearValue * effectiveOpacity * alphaFactor;
            const finalValue = baseValue - subtractAmount;
            
            clearedSelectionData[i] = Math.min(255, Math.max(0, Math.round(finalValue)));
        }
        
        console.log('✅ 清除混合计算完成');
        return clearedSelectionData;
    }
    
    // 更新通道像素数据
    // originalRgbaData: 原始图像数据，背景图层为RGB格式，普通图层为RGBA格式
    private static async updateChannelPixels(finalData: Uint8Array, bounds: any, channelInfo: ChannelInfo, originalRgbaData: Uint8Array, state?: any) {
        try {
            const activeDoc = app.activeDocument;
            const activeLayer = activeDoc.activeLayers[0];
            const activeLayerID = activeLayer.id;
            if (!activeLayer) {
                throw new Error('没有活动图层');
            }
            
            // 获取原始图层信息，判断是否为背景图层
            const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
            const isBackgroundLayer = layerInfo?.isBackground || false;
            
            // 根据图层类型确定components数量：背景图层为3(RGB)，普通图层为4(RGBA)
            const components = isBackgroundLayer ? 3 : 4;
            console.log('🔍 是否为背景图层:', isBackgroundLayer, '组件数:', components);
            
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
            
            // 获取临时图层ID（使用batchPlay确保准确性）
            const tempLayerResult = await action.batchPlay([
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
            
            const tempLayerId = tempLayerResult[0]?.layerID;
            if (!tempLayerId) {
                throw new Error('无法获取临时图层ID');
            }
            
            // 3. 从原始图像数据中提取指定通道的灰度数据
            // 注意：originalRgbaData的组件数根据图层类型而定：背景图层为RGB(3)，普通图层为RGBA(4)
            const singleChannelPixelCount = bounds.docWidth * bounds.docHeight;
            const singleChannelData = new Uint8Array(singleChannelPixelCount);
            
            for (let i = 0; i < singleChannelPixelCount; i++) {
                const pixelIndex = i * components;
                // 根据通道索引提取对应通道的灰度值
                singleChannelData[i] = originalRgbaData[pixelIndex + channelIndex];
            }


            // 4. 用finalData更新单通道数据选区内的部分（保持与提取顺序一致）
            const selectionIndicesArray = Array.from(bounds.selectionDocIndices);
            for (let i = 0; i < finalData.length && i < selectionIndicesArray.length; i++) {
                const docIndex = selectionIndicesArray[i];
                singleChannelData[docIndex] = finalData[i];
            }
            
            
            // 5. 创建新的RGBA图层数组，临时图层总是RGBA格式（4个组件）
            const pixelCount = bounds.docWidth * bounds.docHeight;
            const grayRgbaData = new Uint8Array(pixelCount * 4); // 临时图层总是RGBA
            
            // 将原始数据转换为RGBA格式并更新目标通道
            for (let i = 0; i < singleChannelPixelCount; i++) {
                const originalPixelIndex = i * components; // 原始数据索引
                const rgbaPixelIndex = i * 4; // RGBA数据索引
                const channelValue = singleChannelData[i];
                
                if (components === 3) {
                    // 背景图层：RGB -> RGBA
                    grayRgbaData[rgbaPixelIndex] = originalRgbaData[originalPixelIndex]; // R
                    grayRgbaData[rgbaPixelIndex + 1] = originalRgbaData[originalPixelIndex + 1]; // G
                    grayRgbaData[rgbaPixelIndex + 2] = originalRgbaData[originalPixelIndex + 2]; // B
                    grayRgbaData[rgbaPixelIndex + 3] = 255; // A (不透明)
                    
                    // 修改目标通道
                    grayRgbaData[rgbaPixelIndex + channelIndex] = channelValue;
                } else {
                    // 普通图层：RGBA -> RGBA
                    grayRgbaData[rgbaPixelIndex] = originalRgbaData[originalPixelIndex]; // R
                    grayRgbaData[rgbaPixelIndex + 1] = originalRgbaData[originalPixelIndex + 1]; // G
                    grayRgbaData[rgbaPixelIndex + 2] = originalRgbaData[originalPixelIndex + 2]; // B
                    grayRgbaData[rgbaPixelIndex + 3] = originalRgbaData[originalPixelIndex + 3]; // A
                    
                    // 修改目标通道
                    grayRgbaData[rgbaPixelIndex + channelIndex] = channelValue;
                }
            }
            
            // 创建ImageData并写入临时图层（总是RGBA格式）
            const tempImageData = await imaging.createImageDataFromBuffer(grayRgbaData, {
                width: bounds.docWidth,
                height: bounds.docHeight,
                colorSpace: 'RGB',
                colorProfile: "sRGB IEC61966-2.1",
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
                            "_id": activeLayerID
                        }
                    ],
                    "_isCommand": false
                }
            ], {});
            
            // 4. 选择目标通道
            await action.batchPlay([
                {
                    "_obj": "select",
                    "_target": [
                        {
                            "_ref": "channel",
                            "_enum": "channel",
                            "_value": targetChannelName
                        }
                    ],
                    "_isCommand": false
                }
            ], {});
            
            // 5. 使用应用图像API将临时图层的指定通道复制到原图层的目标通道
            await action.batchPlay([
                {
                    "_obj": "applyImageEvent",
                    "with": {
                        "_obj": "calculation",
                        "to": {
                            "_ref": [
                                {
                                    "_ref": "channel",
                                    "_enum": "channel",
                                    "_value": targetChannelName
                                },
                                {
                                    "_ref": "layer",
                                    "_id": tempLayerId
                                }
                            ]
                        },
                        "preserveTransparency": true
                    },
                    "_isCommand": false
                }
            ], {});
            
            // 6. 删除临时图层
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

            // 7. 再次选择目标通道
            await action.batchPlay([
                {
                    "_obj": "select",
                    "_target": [
                        {
                            "_ref": "channel",
                            "_enum": "channel",
                            "_value": targetChannelName
                        }
                    ],
                    "_isCommand": false
                }
            ], {});
        } catch (error) {
            console.error('❌ SingleChannelHandler - 更新通道像素数据失败:', error);
            throw error;
        }
    }

    // Alpha通道专用更新方法
    private static async updateAlphaChannelPixels(finalData: Uint8Array, bounds: any, channelInfo: ChannelInfo, channelData: Uint8Array, state?: any) {
        try {
            console.log('🎯 开始更新Alpha通道像素:', channelInfo.channelName);
            
            // 创建灰度数据的完整文档数组
            const pixelCount = bounds.docWidth * bounds.docHeight;
            const grayData = new Uint8Array(pixelCount);
            // 该数组为获取的之前的红通道数组。
            grayData.set(channelData);

            // 将选区内的数据更新到对应位置
            const selectionIndicesArray = Array.from(bounds.selectionDocIndices);
            for (let i = 0; i < finalData.length && i < selectionIndicesArray.length; i++) {
                const docIndex = selectionIndicesArray[i];
                if (docIndex >= 0 && docIndex < grayData.length) {
                    grayData[docIndex] = finalData[i];
                }
            }
            
            // 创建临时图层，用于写入Alpha通道数据
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
                        "name": "Alpha通道临时图层"
                    },
                    "_isCommand": false
                }
            ], {});
            
            // 获取临时图层ID
            const tempLayerResult = await action.batchPlay([
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
            
            const tempLayerId = tempLayerResult[0]?.layerID;
            if (!tempLayerId) {
                throw new Error('无法获取临时图层ID');
            }
            
            // 将灰度数据转换为RGBA格式（灰度值作为RGB，Alpha为255）
            const rgbaData = new Uint8Array(pixelCount * 4);
            for (let i = 0; i < pixelCount; i++) {
                const grayValue = grayData[i];
                const rgbaIndex = i * 4;
                rgbaData[rgbaIndex] = grayValue;     // R
                rgbaData[rgbaIndex + 1] = grayValue; // G  
                rgbaData[rgbaIndex + 2] = grayValue; // B
                rgbaData[rgbaIndex + 3] = 255;       // A
            }
            
            // 写入临时图层
            const tempImageData = await imaging.createImageDataFromBuffer(rgbaData, {
                width: bounds.docWidth,
                height: bounds.docHeight,
                colorSpace: 'RGB',
                colorProfile: "sRGB IEC61966-2.1",
                components: 4
            });
            
            await imaging.putPixels({
                documentID: app.activeDocument.id,
                layerID: tempLayerId,
                imageData: tempImageData,
                targetBounds: {
                    left: 0,
                    top: 0,
                    right: bounds.docWidth,
                    bottom: bounds.docHeight
                }
            });
            
            tempImageData.dispose();
            
            // 选择目标Alpha通道
             await action.batchPlay([
                {
                    "_obj": "select",
                    "_target": [
                        {
                            "_ref": "channel",
                            "_name": channelInfo.channelName
                        }
                    ],
                    "_isCommand": false
                }
            ], {});
            
            // 使用应用图像API将临时图层的灰度复制到Alpha通道
            await action.batchPlay([
                {
                    "_obj": "applyImageEvent",
                    "with": {
                        "_obj": "calculation",
                        "to": {
                            "_ref": [
                                {
                                    "_ref": "channel",
                                    "_enum": "channel",
                                    "_value": "red"
                                },
                                {
                                    "_ref": "layer",
                                    "_id": tempLayerId
                                }
                            ]
                        },
                        "preserveTransparency": false
                    },
                    "_isCommand": false
                }
            ], {});
            
            // 删除临时图层
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
            
            // 重新选择目标Alpha通道
            await action.batchPlay([
                {
                    "_obj": "select",
                    "_target": [
                        {
                            "_ref": "channel",
                            "_name": channelInfo.channelName
                        }
                    ],
                    "_isCommand": false
                }
            ], {});
            
            console.log('✅ Alpha通道更新完成');
        } catch (error) {
            console.error('❌ Alpha通道更新失败:', error);
            throw error;
        }
    }
}