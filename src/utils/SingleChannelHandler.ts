import { app, action, imaging, core } from 'photoshop';
import { LayerInfoHandler } from './LayerInfoHandler';
import { Pattern, Gradient } from '../types/state';
import { BLEND_MODE_CALCULATIONS } from './BlendModeCalculations';
import { calculateRandomColor, hsbToRgb, rgbToGray } from './ColorUtils';
import { createStampPatternData, createTilePatternData } from './PatternFill';
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
    isInSingleColorChannel: boolean;
    isAlphaChannel: boolean;
    isRgbChannel: boolean;
}

export class SingleChannelHandler {
    
    // 主入口：单通道填充
    static async fillSingleChannel(options: SingleChannelFillOptions, fillMode: 'foreground' | 'pattern' | 'gradient', state?: any): Promise<boolean> {
        try {
            console.log('🎨 开始单通道填充操作，模式:', fillMode);
            
            // 预先保存前景色，防止后续操作影响前景色获取
            let savedForegroundColor = null;
            if (fillMode === 'foreground') {
                savedForegroundColor = {
                    hue: app.foregroundColor.hsb.hue,
                    saturation: app.foregroundColor.hsb.saturation,
                    brightness: app.foregroundColor.hsb.brightness
                };
                console.log('🔒 预先保存前景色:', savedForegroundColor);
            }
            
            // 检查是否在单通道模式
            const channelInfo = await this.getCurrentChannelInfo();
            if (!channelInfo || !channelInfo.isInSingleColorChannel) {
                console.error('❌ 当前不在单个颜色通道模式');
                return false;
            }

            // 新增：当在 RGB 单通道且当前图层为空时，提前提示并返回，避免 getPixels 报错
            if (channelInfo.isRgbChannel) {
                try {
                    const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                    if (!layerInfo || !layerInfo.hasPixels) {
                        const name = channelInfo.channelName || '当前';
                        await core.showAlert({ message: `因当前图层为空，故${name}通道为空，无法清除。` });
                        return false;
                    }
                } catch (e) {
                    console.warn('⚠️ 检测图层像素状态失败:', e);
                }
            }

            // Alpha 通道编辑时，若选择了图案/渐变模式但未选择预设，则直接返回，避免继续创建临时图层等操作
            if (channelInfo.isAlphaChannel && (fillMode === 'pattern' || fillMode === 'gradient')) {
                if (fillMode === 'pattern' && !options.pattern) {
                    await core.showAlert({ message: '请先选择一个图案预设' });
                    return false;
                }
                if (fillMode === 'gradient' && !options.gradient) {
                    await core.showAlert({ message: '请先选择一个渐变预设' });
                    return false;
                }
            }
            
            // 获取选区数据
            const bounds = await this.getSelectionData();
            if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('❌ 无法获取选区数据或选区为空');
                return false;
            }
            
            // 获取文档长度的当前通道的灰度数据和原始图像数据
            const pixelResult = await this.getChannelPixels(bounds, channelInfo);
            const channelData = pixelResult.channelData;
            const selectionChannelData = pixelResult.selectionChannelData || channelData; // Alpha通道为选区内数据，RGB通道 channelData 本身就是选区内数据
            const originalRgbaData = pixelResult.originalRgbaData; // 背景图层为RGB，普通图层为RGBA
            
            let fillData: Uint8Array;
            let alphaData: Uint8Array | undefined;
            
            // 根据填充模式生成选区内的填充数据
            switch (fillMode) {
                case 'foreground':
                    const solidColorResult = await this.generateSolidColorData(bounds, state, savedForegroundColor);
                    fillData = solidColorResult.colorData;
                    alphaData = solidColorResult.alphaData;
                    break;
                case 'pattern':
                    if (!options.pattern) {
                        await core.showAlert({ message: '请先选择一个图案预设' });
                        return false;
                    }
                    const patternResult = await this.generatePatternData(bounds, options.pattern, { ...state, channelData });
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
            
            // 提取当前通道在选区中的灰度值，与选区中的填充数据混合计算
            const finalData = await this.calculateFillBlend(
                selectionChannelData,
                fillData,
                alphaData,
                options.opacity,
                options.blendMode,
                bounds,
                channelData  // 传入完整的channelData，用于图案外区域获取原始值
            );
            
            // 将计算得到的选区内的最终值，写回当前通道，实现通道的填充。
            if (channelInfo.isAlphaChannel) {
                await this.updateAlphaChannelPixels(finalData, bounds, channelInfo, channelData, state);
            } else {
                await this.updateChannelPixels(finalData, bounds, channelInfo, originalRgbaData, state);
            }
            
            // 检查APP主面板的取消选区checkbox状态，如果为false则使用imagingAPI恢复选区
            console.log('🔍 检查选区恢复条件:', {
                hasState: !!state,
                deselectAfterFill: state?.deselectAfterFill,
                hasSelectionValues: !!bounds.selectionValues,
                selectionValuesLength: bounds.selectionValues?.length,
                hasSelectionDocIndices: !!bounds.selectionDocIndices,
                selectionDocIndicesSize: bounds.selectionDocIndices?.size
            });
            
            if (state && state.deselectAfterFill === false && bounds.selectionValues && bounds.selectionDocIndices) {
                console.log('🎯 取消选区checkbox为false，使用imagingAPI恢复选区');
                
                try {
                    console.log('🎯 使用传入的选区数据，压缩长度:', bounds.selectionValues.length);
                    console.log('🎯 文档尺寸:', bounds.docWidth, 'x', bounds.docHeight);
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullDocumentArray = new Uint8Array(bounds.docWidth * bounds.docHeight);
                    
                    // 将选区内像素的值填入对应的文档位置
                    const selectionIndicesArray = Array.from(bounds.selectionDocIndices);
                    for (let i = 0; i < bounds.selectionValues.length; i++) {
                        const docIndex = selectionIndicesArray[i];
                        if (docIndex < fullDocumentArray.length) {
                            fullDocumentArray[docIndex] = bounds.selectionValues[i];
                        }
                    }
                    
                    console.log('✅ 选区数组补全完成，完整数组长度:', fullDocumentArray.length);
                    
                    // 使用createImageDataFromBuffer创建ImageData
                    const imageDataOptions = {
                        width: bounds.docWidth,
                        height: bounds.docHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: "Dot Gain 15%",
                        colorSpace: "Grayscale"
                    };
                    
                    const imageData = await imaging.createImageDataFromBuffer(fullDocumentArray, imageDataOptions);
                    
                    // 使用putSelection更新选区
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: imageData
                    });
                    
                    // 释放ImageData内存
                    imageData.dispose();
                    
                    console.log('✅ 选区恢复成功');
                } catch (error) {
                    console.error('❌ 恢复选区失败:', error);
                }
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
            
            // 预先保存前景色，防止后续操作影响前景色获取
            let savedForegroundColor = null;
            if (fillMode === 'foreground') {
                savedForegroundColor = {
                    hue: app.foregroundColor.hsb.hue,
                    saturation: app.foregroundColor.hsb.saturation,
                    brightness: app.foregroundColor.hsb.brightness
                };
                console.log('🔒 预先保存前景色:', savedForegroundColor);
            }
            
            // 检查是否在单通道模式
            const channelInfo = await this.getCurrentChannelInfo();
            if (!channelInfo || !channelInfo.isInSingleColorChannel) {
                console.error('❌ 当前不在单个颜色通道模式');
                return false;
            }

            // 新增：当在 RGB 单通道且当前图层为空时，提前提示并返回，避免 getPixels 报错
            if (channelInfo.isRgbChannel) {
                try {
                    const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                    if (!layerInfo || !layerInfo.hasPixels) {
                        const name = channelInfo.channelName || '当前';
                        await core.showAlert({ message: `因当前图层为空，故${name}通道为空，无法填充。` });
                        return false;
                    }
                } catch (e) {
                    console.warn('⚠️ 检测图层像素状态失败:', e);
                }
            }

            // Alpha 通道编辑时，若选择了图案/渐变模式但未选择预设，则直接返回，避免继续创建临时图层等操作
            if (channelInfo.isAlphaChannel && (fillMode === 'pattern' || fillMode === 'gradient')) {
                if (fillMode === 'pattern' && !options.pattern) {
                    await core.showAlert({ message: '请先选择一个图案预设' });
                    return false;
                }
                if (fillMode === 'gradient' && !options.gradient) {
                    await core.showAlert({ message: '请先选择一个渐变预设' });
                    return false;
                }
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
            const selectionChannelData = pixelResult.selectionChannelData || channelData;
            const originalRgbaData = pixelResult.originalRgbaData; // 背景图层为RGB，普通图层为RGBA
            
            let clearData: Uint8Array;
            let alphaData: Uint8Array | undefined;
            
            // 根据清除模式生成清除数据
            switch (fillMode) {
                case 'foreground':
                    const solidColorResult = await this.generateSolidColorData(bounds, state, savedForegroundColor);
                    clearData = solidColorResult.colorData;
                    alphaData = solidColorResult.alphaData;
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
                selectionChannelData,
                clearData,
                alphaData,
                options.opacity,
                bounds,
                channelData  // 传入完整的channelData，用于图案外区域获取原始值
            );
            
           // 写回通道数据
            if (channelInfo.isAlphaChannel) {
                await this.updateAlphaChannelPixels(finalData, bounds, channelInfo, channelData, state);
            } else {
                await this.updateChannelPixels(finalData, bounds, channelInfo, originalRgbaData, state);
            }
            
            // 检查APP主面板的取消选区checkbox状态，如果为false则使用imagingAPI恢复选区
            console.log('🔍 检查选区恢复条件(clear):', {
                hasState: !!state,
                deselectAfterFill: state?.deselectAfterFill,
                hasSelectionValues: !!bounds.selectionValues,
                selectionValuesLength: bounds.selectionValues?.length,
                hasSelectionDocIndices: !!bounds.selectionDocIndices,
                selectionDocIndicesSize: bounds.selectionDocIndices?.size
            });
            if (state && state.deselectAfterFill === false && bounds.selectionValues && bounds.selectionDocIndices) {
                console.log('🎯 取消选区checkbox为false，使用imagingAPI恢复选区');
                
                try {
                    console.log('🎯 使用传入的选区数据，压缩长度:', bounds.selectionValues.length);
                    console.log('🎯 文档尺寸:', bounds.docWidth, 'x', bounds.docHeight);
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullDocumentArray = new Uint8Array(bounds.docWidth * bounds.docHeight);
                    
                    // 将选区内像素的值填入对应的文档位置
                    const selectionIndicesArray = Array.from(bounds.selectionDocIndices);
                    for (let i = 0; i < bounds.selectionValues.length; i++) {
                        const docIndex = selectionIndicesArray[i];
                        if (docIndex < fullDocumentArray.length) {
                            fullDocumentArray[docIndex] = bounds.selectionValues[i];
                        }
                    }
                    
                    console.log('✅ 选区数组补全完成，完整数组长度:', fullDocumentArray.length);
                    
                    // 使用createImageDataFromBuffer创建ImageData
                    const imageDataOptions = {
                        width: bounds.docWidth,
                        height: bounds.docHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: "Dot Gain 15%",
                        colorSpace: "Grayscale"
                    };
                    
                    const imageData = await imaging.createImageDataFromBuffer(fullDocumentArray, imageDataOptions);
                    
                    // 使用putSelection更新选区
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: imageData
                    });
                    
                    // 释放ImageData内存
                    imageData.dispose();
                    
                    console.log('✅ 选区恢复成功');
                } catch (error) {
                    console.error('❌ 恢复选区失败:', error);
                }
            }
            
            return true;
        } catch (error) {
            console.error('❌ 单通道清除失败:', error);
            return false;
        }
    }
    
    // 判断当前通道的类型
    private static async getCurrentChannelInfo(): Promise<ChannelInfo | null> {
        try {
            // 先检测是否多选了通道，防止 batchPlay 获取时触发"获取命令不可用"错误
            try {
                const activeChannelsCount = (app.activeDocument as any)?.activeChannels?.length || 0;
                if (activeChannelsCount > 1) {
                    console.log(`🚫 检测到多通道选择 (${activeChannelsCount} 个通道)，跳过通道信息获取`);
                    return null;
                }
            } catch (error) {
                console.log('⚠️ 无法检测多通道状态，继续通道信息获取');
            }

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
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
            if (targetChannelResult[0]) {
                const targetChannelInfo = targetChannelResult[0];
                const channelName = targetChannelInfo.channelName;
                const itemIndex = targetChannelInfo.itemIndex;

                
                // 检测是否为单色通道（红、绿、蓝）
                const rgbChannels = ["红", "绿", "蓝", "Red", "Grain", "Blue", "R", "G", "B"];
                const isRgbChannel = rgbChannels.includes(channelName);
                
                // 获取快速蒙版状态
                const document = app.activeDocument;
                const isInQuickMask = document.quickMaskMode;
                
                // 获取图层蒙版状态
                const activeLayer = document.activeLayers[0];
                const isInLayerMask = activeLayer && !activeLayer.isBackgroundLayer ? await LayerInfoHandler.checkLayerMaskMode() : false;
                
                // 检测是否为用户自建的alpha通道（是指自定义alpha通道，itemIndex>=4的那些，这是因为这些通道在Photoshop的面板中通常位于蓝通道的下方。）
                // Alpha通道为通道指数 >=4且不为快速蒙版、图层蒙版的通道（因为快速蒙版、图层蒙版也在蓝通道下方，通道索引大于3）
                const isAlphaChannel = itemIndex >= 4 && !isInQuickMask && !isInLayerMask;
                
                // 对于单通道操作，支持R、G、B通道和自定义Alpha通道
                const isInSingleColorChannel = isRgbChannel || isAlphaChannel;
                
                return {
                    channelName: targetChannelInfo.channelName,
                    channelIndex: targetChannelInfo.channelIndex,
                    isInSingleColorChannel,
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
    
    // 获取选区通道的灰度数据
    private static async getSelectionData() {
        try {
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
                ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }),
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
                ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' })
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
            
            // 使用imaging.getSelection获取羽化后选区的像素数据
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
            const selectionValues = new Uint8Array(selectionSize);
            
            // 第三步：将选区内像素的系数和值填入新数组
            let fillIndex = 0;
            for (let i = 0; i < width * height; i++) {
                if (tempSelectionValues[i] > 0) {
                    selectionCoefficients[fillIndex] = tempSelectionCoefficients[i];
                    selectionValues[fillIndex] = tempSelectionValues[i];
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
                selectionCoefficients,
                selectionValues           // 选区像素值（0-255）
            };
        } catch (error) {
            console.error('❌ 获取选区数据失败:', error);
            return null;
        }
    }
    
    // 获取当前选中通道的灰度数据
    private static async getChannelPixels(bounds: any, channelInfo: ChannelInfo): Promise<{ channelData: Uint8Array; originalRgbaData: Uint8Array; selectionChannelData?: Uint8Array }> {
        try {        
             const doc = app.activeDocument;
            if (!doc) {
                throw new Error('没有活动文档');
            }
            
            const activeLayer = doc.activeLayers[0];
            if (!activeLayer) {
                throw new Error('没有活动图层');
            }
            
            // 当前选中的通道为普通用户自建的alpha通道时，其灰度无法直接通过getPixels获取，需要先新建一个临时文档，通过应用图像把该通道的灰度值给临时文档，再从临时文档获取像素数据。
            const isAlphaChannel = channelInfo.isAlphaChannel;
            if (isAlphaChannel) {
            // 1. 创建获取单通道灰度值的临时空图层，创建后系统会默认自动选中这个图层，无需手动选择。
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
            // 2. 获取该临时灰度图层ID，以备后续重新选中它。
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
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
            const tempGrayLayerId = tempGrayLayerResult[0]?.layerID;

            if (!tempGrayLayerId) {
                throw new Error('无法获取临时灰度图层ID');
            }

            // 取消选区，为之后的应用图像操作腾出空间，避免应用图像的作用范围只生成在选区中。
            await action.batchPlay([
                {
                "_obj": "set",
                "_target": [
                    {
                        "_ref": "channel",
                        "_property": "selection"
                    }
                ],
                "to": {
                    "_enum": "ordinal",
                    "_value": "none"
                }
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

            // 对临时灰度图层使用应用图像，将目标【自定义alpha通道】的灰度值给临时灰度图层的RGB复合通道，此时临时灰度图层的R、G、B通道的灰度与目标【自定义alpha通道】的灰度一样。
            // 通过应用图像，临时灰度图层的RGB复合通道的不透明度通道默认为255。
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
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

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
            const tempGrayLayerRgbData = await tempGrayLayerPixelData.imageData.getData();

            // 3，从tempGrayLayerRgbData获取红通道的灰度数据，由于应有图像的关系，该红通道值等价于目标【自定义alpha】的通道值。
            // 红通道的长度为文档长度bounds.docWidth * bounds.docHeight。
            const singleChannelData = new Uint8Array(bounds.docWidth * bounds.docHeight);
            for (let i = 0; i < tempGrayLayerRgbData.length; i += 4) {
                singleChannelData[i / 4] = tempGrayLayerRgbData[i];
            }
            
            // 创建channelData的深度拷贝，防止数据被释放
            const channelDataCopy = new Uint8Array(singleChannelData.length);
            channelDataCopy.set(singleChannelData);
            
            // 4，从singleChannelData获取选区内的像素数据 (长度: bounds.selectionDocIndices.size)
            const selectionIndices = bounds.selectionIndicesArray || Array.from(bounds.selectionDocIndices);
            const selectionChannelData = new Uint8Array(selectionIndices.length);
            for (let i = 0; i < selectionIndices.length; i++) {
                selectionChannelData[i] = channelDataCopy[selectionIndices[i]]; // 使用拷贝的数据
            }

            // 5，释放资源
            tempGrayLayerPixelData.imageData.dispose();
            
            // 6，删除临时灰度图层，此时会系统会默认自动选择下个图层的RGB复合通道。
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
            ], { dialogOptions: 'dontDisplayDialogs' });

            // 7，使用imaging.getPixels获取原图层的完整RGB图像数据作为originalRgbaData。对于目标【自定义alpha通道】，获取原图层的完整RGBA图像数据是不必要的。
            // 因为目标【自定义alpha通道】的灰度值已经被提取到singleChannelData中了，无需再获取原图层的完整RGBA图像数据，只是由于getChannelPixels需要返回两个参数：channelData、originalRgbaData。
            // 自定义 Alpha 通道不依赖当前图层像素，避免在空白图层上触发 "No pixels in the requested area" 错误
            const originalRgbaData = new Uint8Array(0);

            return {
                channelData: channelDataCopy, // 返回拷贝的完整文档Alpha通道数据，用于updateAlphaChannelPixels
                originalRgbaData: originalRgbaData,
                selectionChannelData: selectionChannelData // 返回选区内的Alpha通道数据，用于混合计算
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
                    channelData:  fullDocChannelData,
                    originalRgbaData: rgbData, // 根据图层类型，可能是RGB(背景图层)或RGBA(普通图层)数据
                    selectionChannelData: selectionChannelData // RGB通道的选区内数据直接就是 channelData
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
    private static async generateSolidColorData(bounds: any, state: any, savedForegroundColor?: any): Promise<{ colorData: Uint8Array; alphaData: Uint8Array }> {
        console.log('🎨 生成纯色数据');
        
        // 获取当前前景色的不透明度，使用实际的不透明度值而不是硬编码100
        const currentOpacity = state?.opacity || 100;
        
        // 使用保存的前景色（如果提供）或当前前景色
        let currentForegroundColor;
        if (savedForegroundColor) {
            currentForegroundColor = {
                hsb: savedForegroundColor
            };
            console.log('🔓 使用预先保存的前景色:', savedForegroundColor);
        } else {
            currentForegroundColor = app.foregroundColor;
            console.log('🔍 使用当前实时前景色:', {
                hue: currentForegroundColor.hsb.hue,
                saturation: currentForegroundColor.hsb.saturation,
                brightness: currentForegroundColor.hsb.brightness
            });
        }
        
        // 计算抖动后的颜色
        const randomColorResult = calculateRandomColor(
            {
                hueVariation: state?.hueVariation || 0,
                saturationVariation: state?.saturationVariation || 0,
                brightnessVariation: state?.brightnessVariation || 0,
                opacityVariation: state?.opacityVariation || 0,
                calculationMode: state?.calculationMode || 'absolute'
            },
            currentOpacity, // 使用实际的不透明度而不是硬编码100
            currentForegroundColor, // 传入前景色
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
        
        // 创建alpha数据数组，纯色填充默认alpha为255（完全不透明）
        const alphaData = new Uint8Array(bounds.selectionDocIndices.size);
        alphaData.fill(255);
        
        console.log('✅ 纯色数据生成完成，灰度值:', grayValue, '基于前景色RGB:', rgb, '不透明度:', currentOpacity, 'alpha值:', 255);
        return { colorData, alphaData };
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
            } else {
                rebuilt.fill(128);
                pattern.grayData = rebuilt;
                console.warn('🔧 无法从RGB重建，使用中性灰填充匹配尺寸的数据，长度:', rebuilt.length);
            }
        }
        
        
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
                false, // 不需要生成透明度数据（灰度模式）
                state.channelData // 传入原始通道数据作为背景
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
            
            // 保存图案掩码用于生成正确的alpha覆盖掩码
            (grayPatternData as any).patternMask = stampResult.patternMask;
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
        
        // 提取选区内的图案数据
        const selectedColorData = new Uint8Array(bounds.selectionDocIndices.size);
        let selectedAlphaData: Uint8Array | undefined;
        
        // 强制生成alpha覆盖掩码，确保图案外部区域不参与混合
        selectedAlphaData = new Uint8Array(bounds.selectionDocIndices.size);
        
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
                
                // 修正alpha掩码生成逻辑和填充数据选择逻辑
                let isInPattern = false;
                if (patternAlphaData) {
                    // 如果图案有alpha数据，直接使用
                    const alphaVal = patternAlphaData[boundsIndex] || 0;
                    selectedAlphaData[index] = alphaVal;
                    isInPattern = alphaVal > 0;
                } else {
                    // 当没有alpha数据时，根据填充模式决定alpha掩码策略
                    if (pattern.fillMode === 'stamp') {
                        // 优先使用createStampPatternData提供的patternMask
                        const patternMask: Uint8Array | undefined = (grayPatternData as any).patternMask;
                        if (patternMask && patternMask.length === bounds.width * bounds.height) {
                            const maskVal = patternMask[boundsIndex] || 0;
                            selectedAlphaData[index] = maskVal > 0 ? 255 : 0;
                            isInPattern = maskVal > 0;
                        } else {
                            // 回退：计算是否在图案范围内
                            const patternX = boundsX % scaledPatternWidth;
                            const patternY = boundsY % scaledPatternHeight;
                            isInPattern = patternX < scaledPatternWidth && patternY < scaledPatternHeight;
                            selectedAlphaData[index] = isInPattern ? 255 : 0;
                        }
                    } else {
                        // 贴墙纸模式：所有位置都参与混合
                        selectedAlphaData[index] = 255;
                        isInPattern = true;
                    }
                }
                
                // 关键修正：对于图案外区域，设置为0，配合alpha=0确保不参与清除
                if (isInPattern) {
                    const patternColorValue = grayPatternData[boundsIndex] || 0;
                    selectedColorData[index] = patternColorValue;
                } else {
                    // 图案外区域：设置为0，确保不参与清除操作
                    // 这样配合alpha=0，可以完全避免图案外区域被清除
                    selectedColorData[index] = 0;
                }
            } else {
                // 超出边界的区域
                selectedColorData[index] = 0;
                selectedAlphaData[index] = 0;
            }
        }
        
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
        bounds: any,
        channelData?: Uint8Array  // 添加完整的channelData参数，用于获取图案外区域的原始值
    ): Promise<Uint8Array> {
        
        // 最终输出的数据，是两个选区长度 (bounds.selectionDocIndices.size)的数组计算得到的，分别是选区内的原始通道值和选区内的填充值
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
            // 修复透明度处理：
            // 1) 如果提供了 alphaData，直接使用；
            // 2) 如果没有 alphaData，默认为0，只有明确的alpha数据才参与清除
            //    在generatePatternData中我们已确保图案范围外的像素alpha=0。
            const alphaValue = selectionAlphaData ? selectionAlphaData[i] : 0;
            
            // 计算填充内容的最终的透明度（图案/渐变透明度 × 整体不透明度）
            const finalAlpha = (alphaValue / 255) * opacityRatio;
            
            // 如果填充内容最终透明度为0，直接保持原始通道值，不进行任何混合
            if (finalAlpha === 0) {
                // 对于盖图章模式，当alpha为0时（图案外区域），应该从完整的channelData中获取对应位置的原始值
                if (channelData && bounds.selectionDocIndices) {
                    const selectionIndicesArray = bounds.selectionIndicesArray || Array.from(bounds.selectionDocIndices);
                    const globalIndex = selectionIndicesArray[i];
                    if (globalIndex !== undefined && globalIndex < channelData.length) {
                        blendedSelectionData[i] = channelData[globalIndex];
                    } else {
                        blendedSelectionData[i] = baseValue;
                    }
                } else {
                    blendedSelectionData[i] = baseValue;
                }
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
    // 计算清除混合
    private static async calculateClearBlend(
        selectionChannelData: Uint8Array, // 选区内的单通道数据 (长度: bounds.selectionDocIndices.size)
        selectionClearData: Uint8Array,   // 选区内的清除数据 (长度: bounds.selectionDocIndices.size)
        selectionAlphaData: Uint8Array | undefined, // 选区内的清除内容的透明度数据 (长度: bounds.selectionDocIndices.size)
        opacity: number,
        bounds: any,
        channelData?: Uint8Array  // 添加完整的channelData参数，用于获取图案外区域的原始值
    ): Promise<Uint8Array> {
        
        // 最终输出的数据，是两个选区长度 (bounds.selectionDocIndices.size)的数组计算得到的，分别是选区内的原始通道值和选区内的清除值
        const clearedSelectionData = new Uint8Array(bounds.selectionDocIndices.size);
        const opacityRatio = opacity * 0.01; // 避免重复除法
        
        // 检查是否有选区羽化系数
        const hasFeathering = bounds?.selectionCoefficients?.length > 0;
        const selectionCoefficients = bounds?.selectionCoefficients;
        
        for (let i = 0; i < selectionChannelData.length; i++) {
            const baseValue = selectionChannelData[i]; // 选区内原始通道值
            const clearValue = selectionClearData[i];  // 选区内清除值（图案灰度值）
            
            // 关键修复：优先检查alpha值，如果alpha为0（图案外区域），直接跳过清除操作
            const alphaValue = selectionAlphaData ? selectionAlphaData[i] : 0;
            
            // 如果alpha为0，说明该像素位于图案外区域，直接保持原始值，不参与任何清除计算
            if (alphaValue === 0) {
                clearedSelectionData[i] = baseValue;
                continue;
            }
            
            // 计算清除内容的最终的透明度（图案/渐变透明度 × 整体不透明度）
            const finalAlpha = (alphaValue / 255) * opacityRatio;
            
            // 双重保险：如果最终透明度为0，也直接保持原始值
            if (finalAlpha === 0) {
                clearedSelectionData[i] = baseValue;
                continue;
            }
            
            // 修正清除算法：根据图案灰度值计算清除强度
            // clearValue是图案的灰度值(0-255)，需要转换为清除强度(0-1)
            // 灰度值越高，清除强度越大；灰度值为0时不清除，灰度值为255时完全清除
            const clearIntensity = (clearValue / 255) * finalAlpha;
            
            // 计算清除后的结果：原始值 × (1 - 清除强度)
            let clearedResult = baseValue * (1 - clearIntensity);
            
            // 应用羽化系数（如果存在）
            if (hasFeathering && selectionCoefficients && selectionCoefficients[i] !== undefined) {
                const featherCoeff = selectionCoefficients[i];
                // 羽化混合：原始值 * (1 - 羽化系数) + 清除结果 * 羽化系数
                const invFeatherCoeff = 1 - featherCoeff;
                clearedResult = baseValue * invFeatherCoeff + clearedResult * featherCoeff;
            }
            
            // 快速边界检查和取整
            clearedSelectionData[i] = clearedResult < 0 ? 0 : (clearedResult > 255 ? 255 : Math.round(clearedResult));
        }
        
        return clearedSelectionData;
    }
    
    // 更新通道像素数据
    // originalRgbaData: 背景图层为RGB，普通图层为RGBA
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
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
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
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
            const selectionIndicesArray = bounds.selectionIndicesArray || Array.from(bounds.selectionDocIndices);
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
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
            ], { dialogOptions: 'dontDisplayDialogs' });

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
            ], { dialogOptions: 'dontDisplayDialogs' });
        } catch (error) {
            console.error('❌ SingleChannelHandler - 更新通道像素数据失败:', error);
            throw error;
        }
    }

    // Alpha通道专用更新方法
    private static async updateAlphaChannelPixels(finalData: Uint8Array, bounds: any, channelInfo: ChannelInfo, channelData: Uint8Array, state?: any) {
        try {
            console.log('🎯 开始更新Alpha通道像素:', channelInfo.channelName);
            
            // 验证传入的channelData是否有效
            console.log('🔍 传入的channelData长度:', channelData.length, '预期长度:', bounds.docWidth * bounds.docHeight);
            const nonZero = channelData.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0);
            console.log('🔍 传入的channelData非零值数量:', nonZero);
            
            // 创建灰度数据的完整文档数组
            const pixelCount = bounds.docWidth * bounds.docHeight;
            const grayData = new Uint8Array(pixelCount);
            // channelData 现在是完整文档的 Alpha 通道数据，进行安全拷贝
            if (channelData && channelData.length) {
                if (channelData.length >= pixelCount) {
                    grayData.set(channelData.subarray(0, pixelCount));
                } else {
                    grayData.set(channelData); // 拷贝已有部分
                    console.warn('⚠️ channelData长度小于文档像素数，将未覆盖部分保持为0。实际长度:', channelData.length, '期望长度:', pixelCount);
                }
            } else {
                console.warn('⚠️ channelData为空或无效，grayData将保持全0');
            }
            
            
            // 将选区长度的最终计算数据更新到对应位置
            const selectionIndicesArray = bounds.selectionIndicesArray || Array.from(bounds.selectionDocIndices);
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
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
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
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
            
            // 置入临时图层
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
            // 使用应用图像API将临时图层的红通道复制到目标Alpha通道
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
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
            ], { dialogOptions: 'dontDisplayDialogs' });
            
            console.log('✅ Alpha通道更新完成');
        } catch (error) {
            console.error('❌ Alpha通道更新失败:', error);
            throw error;
        }
    }
}