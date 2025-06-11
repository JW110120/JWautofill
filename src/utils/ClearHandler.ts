import { action, app, core, imaging } from "photoshop";
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




    //-------------------------------------------------------------------------------------------------
    // 快速蒙版状态下的特殊填充逻辑
    static async clearInQuickMask(state: any) {
        try {
            
            // 获取当前选区边界信息
            const selectionBounds = await this.getSelectionBounds();
            if (!selectionBounds) {
                console.warn('❌ 没有选区，无法执行快速蒙版清除操作');
                return;
            }

            // 获取快速蒙版通道的像素数据和colorIndicates信息
            const { quickMaskPixels, isSelectedAreas } = await this.getQuickMaskPixels(selectionBounds);
            
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
            const finalGrayData = this.calculateFinalGrayValues(quickMaskPixels, fillGrayData, isSelectedAreas);
            
            // 将计算后的灰度数据写回快速蒙版通道
            await this.updateQuickMaskChannel(finalGrayData, selectionBounds);
            
        } catch (error) {
            console.error('❌ 快速蒙版特殊填充失败:', error);
            throw error;
        }
    }

  
    //-------------------------------------------------------------------------------------------------
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
            
            if (result[0] && result[0].selection) {
                const selection = result[0].selection;
                
                // 检查是否有精确的选区点数据
                if (selection.points && selection.points.horizontal && selection.points.vertical) {
                    console.log('🎯 获取到精确选区点数据');
                    const horizontal = selection.points.horizontal.list;
                    const vertical = selection.points.vertical.list;
                    
                    // 计算选区的实际边界
                    const leftPoints = horizontal.filter((_, index) => index % 2 === 0);
                    const rightPoints = horizontal.filter((_, index) => index % 2 === 1);
                    const topPoints = vertical.filter((_, index) => index % 2 === 0);
                    const bottomPoints = vertical.filter((_, index) => index % 2 === 1);
                    
                    const left = Math.min(...leftPoints);
                    const right = Math.max(...rightPoints);
                    const top = Math.min(...topPoints);
                    const bottom = Math.max(...bottomPoints);
                    
                    return {
                        left: left,
                        top: top,
                        right: right,
                        bottom: bottom,
                        width: right - left,
                        height: bottom - top,
                        points: {
                            horizontal: horizontal,
                            vertical: vertical
                        }
                    };
                } else if (selection.bottom !== undefined) {
                    // 回退到基本边界信息
                    console.log('📦 使用基本选区边界信息');
                    return {
                        left: selection.left._value,
                        top: selection.top._value,
                        right: selection.right._value,
                        bottom: selection.bottom._value,
                        width: selection.right._value - selection.left._value,
                        height: selection.bottom._value - selection.top._value
                    };
                }
            }
            return null;
        } catch (error) {
            console.error('获取选区边界失败:', error);
            return null;
        }
    }



    
    //-------------------------------------------------------------------------------------------------
    // 获取快速蒙版通道的像素数据
    static async getQuickMaskPixels(bounds: any) {
            try {  
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
                
                console.log('📊 快速蒙版通道信息:', channelResult);

                // 获取colorIndicates信息
                let isSelectedAreas = false;
                if (channelResult[0] && 
                    channelResult[0].alphaChannelOptions && 
                    channelResult[0].alphaChannelOptions.colorIndicates) {
                    isSelectedAreas = channelResult[0].alphaChannelOptions.colorIndicates._value === "selectedAreas";
                }
                
                // 情况一：检查alphaChannelOptions中的colorIndicates的_value是否为selectedAreas
                if (isSelectedAreas) {
                    
                    console.log('🔍 检测到colorIndicates为selectedAreas，检查快速蒙版是否为空');
                    
                    // 检查快速蒙版是否为空：如果histogram中除了255色阶外其他都是0，则认为快速蒙版为空
                    const histogram = channelResult[0].histogram;
                    let isQuickMaskEmpty = false;
                    
                    if (histogram && Array.isArray(histogram)) {
                        // 检查0-254色阶是否都为0，只有255有值
                        let nonZeroCount = 0;
                        for (let i = 0; i < 255; i++) {
                            if (histogram[i] > 0) {
                                nonZeroCount++;
                            }
                        }
                        
                        // 如果0-254色阶都为0，且255色阶有值，则认为快速蒙版为空
                        isQuickMaskEmpty = (nonZeroCount === 0 && histogram[255] > 0);
                        
                        console.log('📊 快速蒙版直方图分析: 蒙版空白？', isQuickMaskEmpty, ', 0-254色阶非零数量=', nonZeroCount, ', 255色阶值=', histogram[255]);
                    }
                    
                    if (isQuickMaskEmpty) {
                        await core.showAlert({ message: '您的快速蒙版已经为空！' });
                        console.log('⚠️ 检测到快速蒙版为空，跳过特殊处理流程');
                        // 跳过后续步骤，返回空数组
                        const pixelCount = bounds.width * bounds.height;
                        return {
                            quickMaskPixels: new Uint8Array(pixelCount),
                            isSelectedAreas: isSelectedAreas
                        };
                    } else {
                        console.log('✅ 快速蒙版不为空，执行特殊处理流程');
                    
                    //第一步：撤销快速蒙版
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
                    
                    console.log('✅ 第一步：已撤销快速蒙版');

                    //第二步：通过Imaging API获取选区的黑白信息
                    const pixels = await imaging.getSelection({
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
                    });
                    
                    const selectionData = await pixels.imageData.getData();
                    console.log('✅ 第二步：成功获取选区像素数据，数据类型:', selectionData.constructor.name, '长度:', selectionData.length);
                    
                    //第三步：根据第二步获取的选区信息构建MaskValue数组
                    const pixelCount = bounds.width * bounds.height;
                    const maskValue = new Uint8Array(pixelCount);
                    
                    // 处理选区数据，转换为maskValue数组（情况一：255-Value）
                    if (selectionData.length === pixelCount) {
                        // 单通道数据，计算255-Value
                        console.log('📋 检测到单通道选区数据，计算255-Value');
                        for (let i = 0; i < pixelCount; i++) {
                            maskValue[i] = 255 - selectionData[i];
                        }
                    } else {
                        console.warn('⚠️ getSelection应该只返回单通道数据，实际数据长度:', selectionData.length, '预期:', pixelCount);
                        // 按单通道处理，取第一个字节
                        for (let i = 0; i < pixelCount; i++) {
                            const index = Math.min(i, selectionData.length - 1);
                            maskValue[i] = 255 - selectionData[index];
                        }
                    }
                    
                    console.log('🎯 第三步：构建maskValue数组成功，长度:', maskValue.length);
                    console.log('📊 maskValue样本值 (前10个):', Array.from(maskValue.slice(0, 10)));
                    
                    return {
                        quickMaskPixels: maskValue,
                        isSelectedAreas: isSelectedAreas
                    };
                    }
                }
                
                // 情况二：默认处理流程（colorIndicates不是selectedAreas或快速蒙版为空）
                console.log('🔍 使用情况二处理流程，检查快速蒙版直方图');
                
                // 检查快速蒙版直方图
                const histogram2 = channelResult[0].histogram;
                let isQuickMaskEmpty2 = false;
                let isQuickMaskWhite = false;
                
                if (histogram2 && Array.isArray(histogram2)) {
                    // 检查是否为全选，即纯白（除了255色阶外其他都是0）
                    let nonZeroCountWhite = 0;
                    for (let i = 0; i < 255; i++) {
                        if (histogram2[i] > 0) {
                            nonZeroCountWhite++;
                        }
                    }
                    isQuickMaskWhite = (nonZeroCountWhite === 0 && histogram2[255] > 0);
                    
                    // 检查是否为空，即纯黑（除了0色阶外其他都是0）
                    let nonZeroCount2 = 0;
                    for (let i = 1; i < 256; i++) {
                        if (histogram2[i] > 0) {
                            nonZeroCount2++;
                        }
                    }
                    isQuickMaskEmpty2 = (nonZeroCount2 === 0 && histogram2[0] > 0);
                    
                    console.log('📊 情况二直方图分析: 全选？=', isQuickMaskWhite, ', 空白？=', isQuickMaskEmpty2);
                }
                
                if (isQuickMaskEmpty2) {
                    console.log('⚠️ 情况二检测到快速蒙版为空白');
                    await core.showAlert({ message: '您的快速蒙版已经为空！' });
                    // 跳过后续步骤，返回空数组或默认值
                    const pixelCount = bounds.width * bounds.height;
                    return {
                        quickMaskPixels: new Uint8Array(pixelCount),
                        isSelectedAreas: isSelectedAreas
                    };
                }
                
                console.log('✅ 情况二执行处理流程');
                
                //第一步：撤销快速蒙版
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
                
                console.log('✅ 情况二第一步：已撤销快速蒙版');
                
                // 如果是纯白快速蒙版，需要执行全选操作
                if (isQuickMaskWhite) {
                    console.log('🔍 检测到纯白快速蒙版，执行全选操作');
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
                    console.log('✅ 已执行全选操作');
                }

                //第二步：通过Imaging API获取选区的黑白信息
                const pixels2 = await imaging.getSelection({
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
                });
                
                const selectionData2 = await pixels2.imageData.getData();
                console.log('✅ 情况二第二步：成功获取选区像素数据，数据类型:', selectionData2.constructor.name, '长度:', selectionData2.length);
                
                //第三步：根据第二步获取的选区信息构建MaskValue数组（情况二：正常Value）
                const pixelCount = bounds.width * bounds.height;
                const maskValue = new Uint8Array(pixelCount);
                
                // 处理选区数据，转换为maskValue数组（情况二：正常Value）
                if (selectionData2.length === pixelCount) {
                    // 单通道数据，直接使用Value
                    console.log('📋 情况二检测到单通道选区数据，使用正常Value');
                    for (let i = 0; i < pixelCount; i++) {
                        maskValue[i] = selectionData2[i];
                    }
                } else {
                    console.warn('⚠️ getSelection应该只返回单通道数据，实际数据长度:', selectionData2.length, '预期:', pixelCount);
                    // 按单通道处理，取第一个字节
                    for (let i = 0; i < pixelCount; i++) {
                        const index = Math.min(i, selectionData2.length - 1);
                        maskValue[i] = selectionData2[index];
                    }
                }
                
                console.log('🎯 情况二第三步：构建maskValue数组成功，长度:', maskValue.length);
                console.log('📊 情况二maskValue样本值 (前10个):', Array.from(maskValue.slice(0, 10)));
                
                return {
                    quickMaskPixels: maskValue,
                    isSelectedAreas: isSelectedAreas
                };
            
        } catch (error) {
            console.error('❌ 获取快速蒙版像素数据失败:', error);
            throw error;
        }
    }



    
    //-------------------------------------------------------------------------------------------------
    // 获取纯色填充的灰度数据
    static async getSolidFillGrayData(state: any, bounds: any) {
        console.log('🔍 调试getSolidFillGrayData - state.colorSettings:', state.colorSettings);
        console.log('🔍 调试getSolidFillGrayData - state.opacity:', state.opacity);
        
        const panelColor = calculateRandomColor(state.colorSettings, state.opacity);
        console.log('🔍 调试getSolidFillGrayData - panelColor:', panelColor);
        
        // 将HSB转换为RGB
        const rgbColor = this.hsbToRgb(panelColor.hsb.hue, panelColor.hsb.saturation, panelColor.hsb.brightness);
        console.log('🔍 调试getSolidFillGrayData - rgbColor:', rgbColor);
        
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
    
    //-------------------------------------------------------------------------------------------------
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

    
    //-------------------------------------------------------------------------------------------------
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

    
    //-------------------------------------------------------------------------------------------------
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

    
    //-------------------------------------------------------------------------------------------------
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


    
    //-------------------------------------------------------------------------------------------------
    // 应用新的混合公式计算最终灰度值
    static calculateFinalGrayValues(maskData: Uint8Array, fillData: Uint8Array, isSelectedAreas: boolean = true) {
        const finalData = new Uint8Array(maskData.length);
        
        // 输出前10个像素的样本数据用于调试
        console.log('🔍 混合计算样本数据 (前10个像素):');
        
        if (isSelectedAreas) {
            // 第一种情况：colorIndicates为selectedAreas
            for (let i = 0; i < maskData.length; i++) {
                const maskValue = maskData[i];  // 快速蒙版像素值 (0-255)
                const fillValue = fillData[i];  // 填充内容像素灰度值 (0-255)
                
                // 应用公式：maskValue + fillValue - (maskValue * fillValue) / 255
                const finalValue = maskValue + fillValue - (maskValue * fillValue) / 255;
                finalData[i] = Math.min(255, Math.max(0, Math.round(finalValue)));
                // 输出前10个像素的详细信息
                if (i < 10) {
                    console.log(`像素 ${i}: maskValue=${maskValue}, fillValue=${fillValue}, finalValue=${finalValue.toFixed(2)} `);
                }
            }
        } else {
            // 第二种情况：colorIndicates不是selectedAreas
            for (let i = 0; i < maskData.length; i++) {
                const maskValue = maskData[i];  // 快速蒙版像素值 (0-255)
                const fillValue = fillData[i];  // 填充内容像素灰度值 (0-255)
                
                // 应用公式：maskValue - fillValue + (maskValue * fillValue) / 255
                const finalValue2 = maskValue - fillValue + (maskValue * fillValue) / 255;
                finalData[i] = Math.min(255, Math.max(0, Math.round(finalValue2)));
                // 输出前10个像素的详细信息
                if (i < 10) {
                    console.log(`像素 ${i}: maskValue=${maskValue}, fillValue=${fillValue}, finalValue=${finalValue2.toFixed(2)} `);
                }
            }
        }
        
        return finalData;
    }



    //-------------------------------------------------------------------------------------------------
    // 将计算后的灰度数据写回快速蒙版通道
    static async updateQuickMaskChannel(grayData: Uint8Array, bounds: any) {
        try {
            console.log('🔄 开始更新快速蒙版通道，数据长度:', grayData.length, '边界:', bounds);
            
            // 获取当前活动文档的色彩档案
            let documentColorProfile = "Dot Gain 15%"; // 默认值
            try {
                const docInfo = await action.batchPlay([
                    {
                        _obj: "get",
                        _target: [
                            {
                                _property: "colorProfileName"
                            },
                            {
                                _ref: "document",
                                _enum: "ordinal",
                                _value: "targetEnum"
                            }
                        ]
                    }
                ], { synchronousExecution: true });
                
                if (docInfo[0] && docInfo[0].colorProfileName) {
                    documentColorProfile = docInfo[0].colorProfileName;
                    console.log('📄 获取到文档色彩档案:', documentColorProfile);
                }
            } catch (error) {
                console.warn('⚠️ 获取文档色彩档案失败，使用默认值:', error);
            }
            
            // 创建计算后的Grayscale数据
            const options = {
                width: bounds.width,
                height: bounds.height,
                components: 1,  
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            const grayscaleData = new Uint8Array(bounds.width * bounds.height);
            for (let i = 0; i < grayData.length; i++) {
                grayscaleData[i] = grayData[i]; 
            }

            // 获取当前文档的完整尺寸（像素单位）
            const docInfoResult = await action.batchPlay([
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
            ], { synchronousExecution: true });
            
            // 从文档信息中获取像素尺寸
            const docWidth = docInfoResult[0].width._value;
            const docHeight = docInfoResult[0].height._value;
            const resolution = docInfoResult[0].resolution._value;
            
            // 如果获取的是点单位，转换为像素（1英寸 = 72点，像素 = 点 * 分辨率 / 72）
            const docWidthPixels = Math.round(docWidth * resolution / 72);
            const docHeightPixels = Math.round(docHeight * resolution / 72);
            
            console.log('📄 文档尺寸(点):', docWidth, 'x', docHeight);
            console.log('📄 文档分辨率:', resolution, 'DPI');
            console.log('📄 文档尺寸(像素):', docWidthPixels, 'x', docHeightPixels);
            
            // 使用像素尺寸
            const finalDocWidth = docWidthPixels;
            const finalDocHeight = docHeightPixels;
            
            // 获取当前快速蒙版的完整数据
            const fullMaskData = await imaging.getSelection({
                documentID: app.activeDocument.id,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: finalDocWidth,
                    bottom: finalDocHeight
                },
                targetSize: {
                    width: finalDocWidth,
                    height: finalDocHeight
                },
            });
            
            const fullMaskDataArray = await fullMaskData.imageData.getData();
            const fullMaskArray = new Uint8Array(fullMaskDataArray);
            console.log('📊 获取完整快速蒙版数据，长度:', fullMaskArray.length);
            
            // 将计算后的数据合并到完整的蒙版数据中（只更新选区范围内的像素）
            for (let y = 0; y < bounds.height; y++) {
                for (let x = 0; x < bounds.width; x++) {
                    const sourceIndex = y * bounds.width + x;
                    const targetX = bounds.left + x;
                    const targetY = bounds.top + y;
                    const targetIndex = targetY * finalDocWidth + targetX;
                    
                    if (targetIndex < fullMaskArray.length && sourceIndex < grayscaleData.length) {
                        fullMaskArray[targetIndex] = grayscaleData[sourceIndex];
                    }
                }
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
            
            const fullImageData = await imaging.createImageDataFromBuffer(fullMaskArray, fullOptions);
            
            // 使用putSelection更新整个快速蒙版
            await imaging.putSelection({
                documentID: app.activeDocument.id,
                targetBounds: {
                    left: 0,
                    top: 0,
                    right: finalDocWidth,
                    bottom: finalDocHeight
                },
                imageData: fullImageData,
            });
            
            fullMaskData.imageData.dispose();
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
            
            console.log('✅ 已重新进入快速蒙版');
            
        } catch (error) {
            console.error('❌ 更新快速蒙版通道失败:', error);
        }
    }


    
    //-------------------------------------------------------------------------------------------------
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

