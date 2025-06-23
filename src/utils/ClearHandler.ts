import { action, app, core, imaging } from "photoshop";
import { calculateRandomColor, hsbToRgb, rgbToGray } from './ColorUtils';

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
    // 处于清除模式，并且文档状态为快速蒙版状态下，修改快速蒙版通道像素的方法
    static async clearInQuickMask(state: any) {
        try {
            
            // 只有在纯色填充模式下才获取前景色
            // 这必须在getQuickMaskPixels调用之前，因为该方法会撤销快速蒙版
            let quickMaskForegroundColor = null;
            if (state.fillMode === 'foreground') {
                quickMaskForegroundColor = app.foregroundColor;
                console.log('🎨 获取快速蒙版状态下的前景色:', {
                    hue: quickMaskForegroundColor.hsb.hue,
                    saturation: quickMaskForegroundColor.hsb.saturation,
                    brightness: quickMaskForegroundColor.hsb.brightness
                });
            } else {
                console.log('🔄 非纯色填充模式，跳过前景色获取，当前模式:', state.fillMode);
            }
            
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
                fillGrayData = await this.getSolidFillGrayData(state, selectionBounds, quickMaskForegroundColor);
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

            // 应用新的混合公式计算最终灰度值
            const finalGrayData = await this.calculateFinalGrayValues(quickMaskPixels, fillGrayData, isSelectedAreas, state.opacity);
            
            // 将计算后的灰度数据写回快速蒙版通道
            await this.updateQuickMaskChannel(finalGrayData, selectionBounds);
            
        } catch (error) {
            console.error('❌ 快速蒙版特殊填充失败:', error);
            throw error;
        }
    }

  
    //-------------------------------------------------------------------------------------------------
    // 获取选区边界信息和文档信息
    static async getSelectionBounds() {
        try {
            // 获取文档信息和选区信息
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
            
            // 步骤1: 将选区转换为路径
            const pathResult = await action.batchPlay([
                {
                    _obj: "make",
                    _target: [
                        {
                            _ref: "path"
                        }
                    ],
                    from: {
                        _ref: "selectionClass",
                        _property: "selection"
                    },
                    tolerance: {
                        _unit: "pixelsUnit",
                        _value: 2
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
            // 步骤2: 获取路径的边缘点坐标信息
            const pathPointsResult = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "path",
                            _name: "工作路径"
                        }
                    ]
                }
            ], { synchronousExecution: true });
            
            // 提取路径的anchor点坐标
            let pathPoints = [];
            if (pathPointsResult[0] && pathPointsResult[0].pathContents && pathPointsResult[0].pathContents.pathComponents) {
                const pathComponents = pathPointsResult[0].pathContents.pathComponents;
                for (const component of pathComponents) {
                    if (component.subpathListKey) {
                        for (const subpath of component.subpathListKey) {
                            if (subpath.points) {
                                for (const point of subpath.points) {
                                    if (point.anchor && point.anchor.horizontal && point.anchor.vertical) {
                                        pathPoints.push({
                                            x: point.anchor.horizontal._value,
                                            y: point.anchor.vertical._value
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            // 步骤3: 将路径重新转回选区
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
                        _ref: "path",
                        _property: "workPath"
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
            // 步骤4: 删除工作路径
            await action.batchPlay([
                {
                    _obj: "delete",
                    _target: [
                        {
                            _ref: "path",
                            _property: "workPath"
                        }
                    ],
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });
            
            // 获取文档尺寸信息
            const docWidth = docResult[0].width._value;
            const docHeight = docResult[0].height._value;
            const resolution = docResult[0].resolution._value;
            
            // 转换为像素单位
            const docWidthPixels = Math.round(docWidth * resolution / 72);
            const docHeightPixels = Math.round(docHeight * resolution / 72);
            
            // 优先使用路径点数据
            if (pathPoints && pathPoints.length > 0) {
                
                // 计算路径点的边界
                const xCoords = pathPoints.map(p => p.x);
                const yCoords = pathPoints.map(p => p.y);
                
                const left = Math.min(...xCoords);
                const right = Math.max(...xCoords);
                const top = Math.min(...yCoords);
                const bottom = Math.max(...yCoords);
                
                // 使用射线法计算选区内的所有像素位置
                const selectionPixels = await this.getPixelsInPolygon(pathPoints, left, top, right, bottom, docWidthPixels);
                
                return {
                    left: left,
                    top: top,
                    right: right,
                    bottom: bottom,
                    width: right - left,
                    height: bottom - top,
                    docWidth: docWidthPixels,
                    docHeight: docHeightPixels,
                    polygonPoints: pathPoints,
                    selectionPixels: selectionPixels
                };
            }
            
            // 回退到基本选区信息
            if (selectionResult[0] && selectionResult[0].selection) {
                const selection = selectionResult[0].selection;
                
                // 检查是否有精确的选区点数据
                if (selection.points && selection.points.horizontal && selection.points.vertical) {
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
                    
                    // 构建选区轮廓点坐标数组
                    const polygonPoints = [];
                    for (let i = 0; i < horizontal.length; i += 2) {
                        polygonPoints.push({
                            x: horizontal[i],
                            y: vertical[i]
                        });
                    }
                    
                    // 使用射线法计算选区内的所有像素位置
                const selectionPixels = await this.getPixelsInPolygon(polygonPoints, left, top, right, bottom, docWidthPixels);
                    
                    return {
                        left: left,
                        top: top,
                        right: right,
                        bottom: bottom,
                        width: right - left,
                        height: bottom - top,
                        docWidth: docWidthPixels,
                        docHeight: docHeightPixels,
                        points: {
                            horizontal: horizontal,
                            vertical: vertical
                        },
                        polygonPoints: polygonPoints,
                        selectionPixels: selectionPixels
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
                        height: selection.bottom._value - selection.top._value,
                        docWidth: docWidthPixels,
                        docHeight: docHeightPixels
                    };
                }
            }
            return null;
        } catch (error) {
            console.error('获取选区边界失败:', error);
            return null;
        }
    }
    
    // 收集在多边形选区内的像素（优化版本，避免栈溢出）
    static async getPixelsInPolygon(polygonPoints: Array<{x: number, y: number}>, left: number, top: number, right: number, bottom: number, docWidth: number): Promise<Set<number>> {
        const selectionPixels = new Set<number>();
        
        const startY = Math.floor(top);
        const endY = Math.ceil(bottom);
        const startX = Math.floor(left);
        const endX = Math.ceil(right);
        
        // 分批处理，避免一次性处理过多像素导致栈溢出
        const BATCH_SIZE = 1000; // 每批处理1000行
        
        for (let batchStartY = startY; batchStartY <= endY; batchStartY += BATCH_SIZE) {
            const batchEndY = Math.min(batchStartY + BATCH_SIZE - 1, endY);
            
            // 使用setTimeout让出控制权，避免阻塞主线程
            await new Promise(resolve => {
                setTimeout(() => {
                    this.processBatchPixels(polygonPoints, startX, endX, batchStartY, batchEndY, docWidth, selectionPixels);
                    resolve(void 0);
                }, 0);
            });
        }
        
        console.log('🎯 射线法计算完成，选区内像素数量:', selectionPixels.size);
        return selectionPixels;
    }
    
    // 分批处理像素，避免栈溢出
    static processBatchPixels(polygonPoints: Array<{x: number, y: number}>, startX: number, endX: number, startY: number, endY: number, docWidth: number, selectionPixels: Set<number>) {
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                if (this.isPointInPolygon(x, y, polygonPoints)) {
                    // 计算像素在整个文档数组中的位置：docWidth * (y - 1) + x
                    const pixelIndex = docWidth * (y - 1) + x;
                    selectionPixels.add(pixelIndex);
                }
            }
        }
    }

    // 射线法判断像素是否在多边形内
    static isPointInPolygon(x: number, y: number, polygonPoints: Array<{x: number, y: number}>): boolean {
        let intersectionCount = 0;
        const n = polygonPoints.length;
        
        for (let i = 0; i < n; i++) {
            const p1 = polygonPoints[i];
            const p2 = polygonPoints[(i + 1) % n];
            
            // 检查射线是否与边相交
            if (((p1.y > y) !== (p2.y > y)) && 
                (x < (p2.x - p1.x) * (y - p1.y) / (p2.y - p1.y) + p1.x)) {
                intersectionCount++;
            }
        }
        
        // 奇数个交点表示在多边形内
        return intersectionCount % 2 === 1;
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
            
            console.log(`🔍 检测到colorIndicates为${isSelectedAreas ? 'selectedAreas' : '非selectedAreas'}`);
            
            // 检查快速蒙版直方图状态
            const histogram = channelResult[0].histogram;
            const maskStatus = this.analyzeQuickMaskHistogram(histogram, isSelectedAreas);
            
            if (maskStatus.isEmpty) {
                await core.showAlert({ message: '您的快速蒙版已经为空！' });
                console.log('⚠️ 检测到快速蒙版为空，跳过特殊处理流程');
                const pixelCount = bounds.width * bounds.height;
                return {
                    quickMaskPixels: new Uint8Array(pixelCount),
                    isSelectedAreas: isSelectedAreas
                };
            }
            
            // 撤销快速蒙版
            await this.clearQuickMask();
            
            // 如果是纯白快速蒙版（非selectedAreas模式下），需要执行全选操作
            if (!isSelectedAreas && maskStatus.isWhite) {
                await this.selectAll();
            }

            // 通过Imaging API获取选区的黑白信息
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
            console.log('✅ 成功获取选区像素数据，数据类型:', selectionData.constructor.name, '长度:', selectionData.length);
            
            // 根据获取的选区信息构建MaskValue数组
            const pixelCount = bounds.width * bounds.height;
            const maskValue = new Uint8Array(pixelCount);
            
            // 处理选区数据，转换为maskValue数组
            if (selectionData.length === pixelCount) {
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
            
            return {
                quickMaskPixels: maskValue,
                isSelectedAreas: isSelectedAreas
            };
            
        } catch (error) {
            console.error('❌ 获取快速蒙版像素数据失败:', error);
            throw error;
        }
    }
    
    // 分析快速蒙版直方图状态
    static analyzeQuickMaskHistogram(histogram: number[], isSelectedAreas: boolean) {
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
                console.log('📊 selectedAreas模式 - 快速蒙版为空？', isEmpty);
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
                
                console.log('📊 非selectedAreas模式 - 全选？=', isWhite, ', 空白？=', isEmpty);
            }
        }
        
        return { isEmpty, isWhite };
    }
    
    // 撤销快速蒙版
    static async clearQuickMask() {
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
    
    // 执行全选操作
    static async selectAll() {
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

    //-------------------------------------------------------------------------------------------------
    // 获取纯色填充的灰度数据
    static async getSolidFillGrayData(state: any, bounds: any, quickMaskForegroundColor?: any) {
        console.log('🔍 调试getSolidFillGrayData - state.opacity:', state.opacity);
        
        // 使用传入的快速蒙版前景色，如果没有则实时获取当前前景色
        const currentForegroundColor = quickMaskForegroundColor || app.foregroundColor;
        
        const pixelCount = bounds.width * bounds.height;
        const grayData = new Uint8Array(pixelCount);
        
        // 在快速蒙版模式下，使用灰度抖动而不是HSB颜色抖动
        const isQuickMaskMode = true; // 在getSolidFillGrayData中，我们总是处于快速蒙版模式
        const panelColor = calculateRandomColor(state.colorSettings, state.opacity, currentForegroundColor, isQuickMaskMode);
        console.log('🔍 填充的纯色 - panelColor:', panelColor);
        
        // 将HSB颜色转换为灰度值
        const rgb = hsbToRgb(panelColor.hsb.hue, panelColor.hsb.saturation, panelColor.hsb.brightness);
        const grayValue = rgbToGray(rgb.red, rgb.green, rgb.blue);
        grayData.fill(grayValue);
        
        return grayData;
    }
    
    //-------------------------------------------------------------------------------------------------
    // 获取图案填充的灰度数据
    static async getPatternFillGrayData(state: any, bounds: any) {
        try {
            console.log('🔳 获取图案填充灰度数据 - selectedPattern:', {
                hasPattern: !!state.selectedPattern,
                hasGrayData: !!(state.selectedPattern?.grayData),
                patternSize: state.selectedPattern ? `${state.selectedPattern.width}x${state.selectedPattern.height}` : 'N/A',
                boundsSize: `${bounds.width}x${bounds.height}`,
                fillMode: state.selectedPattern?.fillMode || 'tile',
                rotateAll: state.selectedPattern?.rotateAll
            });
            
            // 检查是否有有效的图案数据
            if (state.selectedPattern && state.selectedPattern.grayData && 
                state.selectedPattern.width > 0 && state.selectedPattern.height > 0) {
                
                console.log('✅ 使用图案灰度数据，图案尺寸:', state.selectedPattern.width, 'x', state.selectedPattern.height);
                console.log('📊 图案参数:', {
                    scale: state.selectedPattern.currentScale || 100,
                    angle: state.selectedPattern.currentAngle || 0,
                    fillMode: state.selectedPattern.fillMode || 'tile',
                    rotateAll: state.selectedPattern.rotateAll !== false,
                    dataLength: state.selectedPattern.grayData.length
                });
                
                // 根据填充模式选择不同的处理方法
                const fillMode = state.selectedPattern.fillMode || 'tile';
                const scale = state.selectedPattern.currentScale || 100;
                const angle = state.selectedPattern.currentAngle || 0;
                const rotateAll = state.selectedPattern.rotateAll !== false;
                
                if (fillMode === 'stamp') {
                    // 单次填充模式：图案居中显示，不重复
                    console.log('🎯 使用单次填充模式（盖图章）');
                    return await this.stampPatternToFitBounds(
                        state.selectedPattern.grayData,
                        state.selectedPattern.width,
                        state.selectedPattern.height,
                        bounds,
                        scale,
                        angle
                    );
                } else {
                    // 平铺填充模式：无缝平铺
                    console.log('🧱 使用平铺填充模式（贴墙纸），全部旋转:', rotateAll);
                    return await this.tilePatternToFitBounds(
                        state.selectedPattern.grayData, 
                        state.selectedPattern.width, 
                        state.selectedPattern.height, 
                        bounds,
                        scale,
                        angle,
                        rotateAll
                    );
                }
            }
            
            console.log('⚠️ 没有找到有效的图案灰度数据，使用默认中等灰度');
            
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

    // 将图案平铺到指定边界（支持缩放和旋转）- 优化版本
    static async tilePatternToFitBounds(patternGrayData: Uint8Array, patternWidth: number, patternHeight: number, bounds: any, scale: number = 100, angle: number = 0, rotateAll: boolean = true): Promise<Uint8Array> {
        console.log('🔳 开始图案平铺（优化版本）:', {
            patternSize: `${patternWidth}x${patternHeight}`,
            boundsSize: `${bounds.width}x${bounds.height}`,
            scale: scale,
            angle: angle,
            rotateAll: rotateAll,
            selectionPixelsCount: bounds.selectionPixels ? bounds.selectionPixels.size : 0,
            patternDataLength: patternGrayData.length
        });
        
        // 优化：直接计算选区内的图案，避免创建整个文档大小的数组
        return await this.createOptimizedPatternForSelection(patternGrayData, patternWidth, patternHeight, bounds, scale, angle, rotateAll);
    }

    // 优化的图案创建方法，只处理选区内的像素
    static async createOptimizedPatternForSelection(patternGrayData: Uint8Array, patternWidth: number, patternHeight: number, bounds: any, scale: number, angle: number, rotateAll: boolean = true): Promise<Uint8Array> {
        console.log('⚡ 使用优化的图案创建方法，全部旋转:', rotateAll);
        
        // 计算缩放后的图案尺寸
        const scaleFactor = scale / 100;
        const scaledWidth = Math.max(1, Math.round(patternWidth * scaleFactor));
        const scaledHeight = Math.max(1, Math.round(patternHeight * scaleFactor));
        
        // 创建缩放后的图案数据
        const scaledPatternData = await this.scalePatternData(patternGrayData, patternWidth, patternHeight, scaledWidth, scaledHeight);
        
        // 如果有旋转角度且启用了全部旋转，应用旋转变换
        let transformedPatternData = scaledPatternData;
        let transformedWidth = scaledWidth;
        let transformedHeight = scaledHeight;
        
        if (angle !== 0 && rotateAll) {
            console.log('🔄 应用图案旋转变换，角度:', angle);
            const rotationResult = await this.rotatePatternData(scaledPatternData, scaledWidth, scaledHeight, angle);
            transformedPatternData = rotationResult.data;
            transformedWidth = rotationResult.width;
            transformedHeight = rotationResult.height;
        } else if (angle !== 0 && !rotateAll) {
            console.log('⏸️ 跳过图案旋转变换（全部旋转已禁用）');
        }
        
        // 只为选区创建数据
        const selectionData = new Uint8Array(bounds.width * bounds.height);
        const BATCH_ROWS = 200; // 增加每批处理的行数
        let processedRows = 0;
        
        for (let batchStart = 0; batchStart < bounds.height; batchStart += BATCH_ROWS) {
            const batchEnd = Math.min(batchStart + BATCH_ROWS, bounds.height);
            
            await new Promise<void>(resolve => {
                setImmediate(() => {
                    for (let y = batchStart; y < batchEnd; y++) {
                        for (let x = 0; x < bounds.width; x++) {
                            const globalX = bounds.left + x;
                            const globalY = bounds.top + y;
                            
                            // 计算在变换后图案中的位置
                            const patternX = globalX % transformedWidth;
                            const patternY = globalY % transformedHeight;
                            const patternIndex = patternY * transformedWidth + patternX;
                            
                            const targetIndex = y * bounds.width + x;
                            
                            if (patternIndex < transformedPatternData.length && targetIndex < selectionData.length) {
                                selectionData[targetIndex] = transformedPatternData[patternIndex];
                            }
                        }
                    }
                    
                    processedRows += (batchEnd - batchStart);
                    if (processedRows % 1000 === 0 || processedRows >= bounds.height) {
                        console.log(`🔄 图案处理进度: ${processedRows}/${bounds.height} 行 (${((processedRows / bounds.height) * 100).toFixed(1)}%)`);
                    }
                    
                    resolve();
                });
            });
        }
        
        return selectionData;
    }
    
    // 单次填充模式：图案居中显示，不重复（盖图章模式）
    static async stampPatternToFitBounds(patternGrayData: Uint8Array, patternWidth: number, patternHeight: number, bounds: any, scale: number = 100, angle: number = 0): Promise<Uint8Array> {
        console.log('🎯 开始单次填充（盖图章模式）:', {
            patternSize: `${patternWidth}x${patternHeight}`,
            boundsSize: `${bounds.width}x${bounds.height}`,
            scale: scale,
            angle: angle,
            patternDataLength: patternGrayData.length
        });
        
        // 计算缩放后的图案尺寸
        const scaleFactor = scale / 100;
        const scaledWidth = Math.max(1, Math.round(patternWidth * scaleFactor));
        const scaledHeight = Math.max(1, Math.round(patternHeight * scaleFactor));
        
        // 创建缩放后的图案数据
        const scaledPatternData = await this.scalePatternData(patternGrayData, patternWidth, patternHeight, scaledWidth, scaledHeight);
        
        // 如果有旋转角度，应用旋转变换
        let transformedPatternData = scaledPatternData;
        let transformedWidth = scaledWidth;
        let transformedHeight = scaledHeight;
        
        if (angle !== 0) {
            console.log('🔄 应用图案旋转变换，角度:', angle);
            const rotationResult = await this.rotatePatternData(scaledPatternData, scaledWidth, scaledHeight, angle);
            transformedPatternData = rotationResult.data;
            transformedWidth = rotationResult.width;
            transformedHeight = rotationResult.height;
        }
        
        // 创建选区大小的数据数组，默认填充透明（0）
        const selectionData = new Uint8Array(bounds.width * bounds.height);
        selectionData.fill(0); // 默认透明
        
        // 计算图案在选区中的居中位置
        const offsetX = Math.floor((bounds.width - transformedWidth) / 2);
        const offsetY = Math.floor((bounds.height - transformedHeight) / 2);
        
        console.log('📍 图案居中位置:', {
            offsetX: offsetX,
            offsetY: offsetY,
            transformedSize: `${transformedWidth}x${transformedHeight}`
        });
        
        // 将图案数据复制到选区数据中（居中位置）
        for (let y = 0; y < transformedHeight; y++) {
            for (let x = 0; x < transformedWidth; x++) {
                const targetX = offsetX + x;
                const targetY = offsetY + y;
                
                // 检查目标位置是否在选区范围内
                if (targetX >= 0 && targetX < bounds.width && targetY >= 0 && targetY < bounds.height) {
                    const sourceIndex = y * transformedWidth + x;
                    const targetIndex = targetY * bounds.width + targetX;
                    
                    if (sourceIndex < transformedPatternData.length && targetIndex < selectionData.length) {
                        selectionData[targetIndex] = transformedPatternData[sourceIndex];
                    }
                }
            }
        }
        
        console.log('✅ 单次填充完成');
        return selectionData;
    }
    
    // 创建整个文档大小的平铺图案数组（优化版本，避免创建过大数组）
    static async createDocumentTiledPattern(patternGrayData: Uint8Array, patternWidth: number, patternHeight: number, docWidth: number, docHeight: number, scale: number, angle: number): Promise<Uint8Array> {
        console.log('🌐 创建文档级平铺图案（优化版本）');
        
        // 计算缩放后的图案尺寸
        const scaleFactor = scale / 100;
        const scaledWidth = Math.max(1, Math.round(patternWidth * scaleFactor));
        const scaledHeight = Math.max(1, Math.round(patternHeight * scaleFactor));
        
        console.log('📏 缩放后图案尺寸:', {
            original: `${patternWidth}x${patternHeight}`,
            scaled: `${scaledWidth}x${scaledHeight}`,
        });
        
        // 创建缩放后的图案数据
        const scaledPatternData = await this.scalePatternData(patternGrayData, patternWidth, patternHeight, scaledWidth, scaledHeight);
        
        // 如果有旋转角度，应用旋转变换
        let transformedPatternData = scaledPatternData;
        let transformedWidth = scaledWidth;
        let transformedHeight = scaledHeight;
        
        if (angle !== 0) {
            const rotationResult = await this.rotatePatternData(scaledPatternData, scaledWidth, scaledHeight, angle);
            transformedPatternData = rotationResult.data;
            transformedWidth = rotationResult.width;
            transformedHeight = rotationResult.height;
            
            console.log('🔄 图案旋转完成', {
                rotated: `${transformedWidth}x${transformedHeight}`,
                angle: angle
            });
        }
        
        // 优化：避免创建过大的数组，分批处理
        const docTiledData = new Uint8Array(docWidth * docHeight);
        const BATCH_ROWS = 100; // 每批处理100行
        
        for (let batchStart = 0; batchStart < docHeight; batchStart += BATCH_ROWS) {
            const batchEnd = Math.min(batchStart + BATCH_ROWS, docHeight);
            
            // 分批处理，让出控制权
            await new Promise(resolve => {
                setTimeout(() => {
                    for (let y = batchStart; y < batchEnd; y++) {
                        for (let x = 0; x < docWidth; x++) {
                            const docIndex = y * docWidth + x;
                            
                            // 计算在变换后图案中的位置
                            const patternX = x % transformedWidth;
                            const patternY = y % transformedHeight;
                            const patternIndex = patternY * transformedWidth + patternX;
                            
                            if (patternIndex < transformedPatternData.length) {
                                docTiledData[docIndex] = transformedPatternData[patternIndex];
                            }
                        }
                    }
                    resolve(void 0);
                }, 0);
            });
        }
        
        return docTiledData;
    }
    
    // 缩放图案数据（优化版本，避免栈溢出）
    static async scalePatternData(patternData: Uint8Array, originalWidth: number, originalHeight: number, newWidth: number, newHeight: number): Promise<Uint8Array> {
        const scaledData = new Uint8Array(newWidth * newHeight);
        const BATCH_ROWS = 500; // 增加每批处理的行数
        let processedRows = 0;
        
        for (let batchStart = 0; batchStart < newHeight; batchStart += BATCH_ROWS) {
            const batchEnd = Math.min(batchStart + BATCH_ROWS, newHeight);
            
            await new Promise<void>(resolve => {
                setImmediate(() => {
                    for (let y = batchStart; y < batchEnd; y++) {
                        for (let x = 0; x < newWidth; x++) {
                            // 使用双线性插值进行缩放
                            const srcX = (x / newWidth) * originalWidth;
                            const srcY = (y / newHeight) * originalHeight;
                            
                            const x1 = Math.floor(srcX);
                            const y1 = Math.floor(srcY);
                            const x2 = Math.min(x1 + 1, originalWidth - 1);
                            const y2 = Math.min(y1 + 1, originalHeight - 1);
                            
                            const fx = srcX - x1;
                            const fy = srcY - y1;
                            
                            // 获取四个邻近像素的值
                            const p1 = patternData[y1 * originalWidth + x1];
                            const p2 = patternData[y1 * originalWidth + x2];
                            const p3 = patternData[y2 * originalWidth + x1];
                            const p4 = patternData[y2 * originalWidth + x2];
                            
                            // 双线性插值
                            const interpolated = p1 * (1 - fx) * (1 - fy) +
                                               p2 * fx * (1 - fy) +
                                               p3 * (1 - fx) * fy +
                                               p4 * fx * fy;
                            
                            scaledData[y * newWidth + x] = Math.round(interpolated);
                        }
                    }
                    
                    processedRows += (batchEnd - batchStart);
                    if (processedRows % 1000 === 0 || processedRows >= newHeight) {
                        console.log(`🔄 图案缩放进度: ${processedRows}/${newHeight} 行 (${((processedRows / newHeight) * 100).toFixed(1)}%)`);
                    }
                    
                    resolve();
                });
            });
        }
        
        return scaledData;
    }
    
    // 旋转图案数据（优化版本，避免栈溢出）
    static async rotatePatternData(patternData: Uint8Array, width: number, height: number, angle: number): Promise<{ data: Uint8Array, width: number, height: number }> {
        const angleRad = (angle * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        // 计算旋转后的边界框
        const corners = [
            { x: 0, y: 0 },
            { x: width, y: 0 },
            { x: width, y: height },
            { x: 0, y: height }
        ];
        
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        
        corners.forEach(corner => {
            const rotatedX = corner.x * cos - corner.y * sin;
            const rotatedY = corner.x * sin + corner.y * cos;
            minX = Math.min(minX, rotatedX);
            maxX = Math.max(maxX, rotatedX);
            minY = Math.min(minY, rotatedY);
            maxY = Math.max(maxY, rotatedY);
        });
        
        const newWidth = Math.ceil(maxX - minX);
        const newHeight = Math.ceil(maxY - minY);
        const rotatedData = new Uint8Array(newWidth * newHeight);
        
        const centerX = width / 2;
        const centerY = height / 2;
        const newCenterX = newWidth / 2;
        const newCenterY = newHeight / 2;
        
        const BATCH_ROWS = 500; // 增加每批处理的行数
        let processedRows = 0;
        
        for (let batchStart = 0; batchStart < newHeight; batchStart += BATCH_ROWS) {
            const batchEnd = Math.min(batchStart + BATCH_ROWS, newHeight);
            
            await new Promise<void>(resolve => {
                setImmediate(() => {
                    for (let y = batchStart; y < batchEnd; y++) {
                        for (let x = 0; x < newWidth; x++) {
                            // 将新坐标转换回原始坐标
                            const relativeX = x - newCenterX;
                            const relativeY = y - newCenterY;
                            
                            const originalX = relativeX * cos + relativeY * sin + centerX;
                            const originalY = -relativeX * sin + relativeY * cos + centerY;
                            
                            // 检查是否在原始图案范围内
                            if (originalX >= 0 && originalX < width && originalY >= 0 && originalY < height) {
                                // 使用双线性插值
                                const x1 = Math.floor(originalX);
                                const y1 = Math.floor(originalY);
                                const x2 = Math.min(x1 + 1, width - 1);
                                const y2 = Math.min(y1 + 1, height - 1);
                                
                                const fx = originalX - x1;
                                const fy = originalY - y1;
                                
                                const p1 = patternData[y1 * width + x1];
                                const p2 = patternData[y1 * width + x2];
                                const p3 = patternData[y2 * width + x1];
                                const p4 = patternData[y2 * width + x2];
                                
                                const interpolated = p1 * (1 - fx) * (1 - fy) +
                                                   p2 * fx * (1 - fy) +
                                                   p3 * (1 - fx) * fy +
                                                   p4 * fx * fy;
                                
                                rotatedData[y * newWidth + x] = Math.round(interpolated);
                            }
                        }
                    }
                    
                    processedRows += (batchEnd - batchStart);
                    if (processedRows % 1000 === 0 || processedRows >= newHeight) {
                        console.log(`🔄 图案旋转进度: ${processedRows}/${newHeight} 行 (${((processedRows / newHeight) * 100).toFixed(1)}%)`);
                    }
                    
                    resolve();
                });
            });
        }
        
        return { data: rotatedData, width: newWidth, height: newHeight };
    }
    
    // 从文档平铺数组中截取选区部分（优化版本，避免栈溢出）
    static async extractSelectionFromDocumentTiled(docTiledData: Uint8Array, bounds: any): Promise<Uint8Array> {
        console.log('✂️ 从文档平铺中截取选区（优化版本）:', {
            boundsSize: `${bounds.width}x${bounds.height}`,
            boundsPosition: `(${bounds.left}, ${bounds.top})`,
        });
        
        const selectionData = new Uint8Array(bounds.width * bounds.height);
        let processedPixels = 0;
        const BATCH_ROWS = 200; // 增加每批处理的行数
    
        for (let batchStart = 0; batchStart < bounds.height; batchStart += BATCH_ROWS) {
            const batchEnd = Math.min(batchStart + BATCH_ROWS, bounds.height);
            
            await new Promise<void>(resolve => {
                setImmediate(() => {
                    for (let y = batchStart; y < batchEnd; y++) {
                        for (let x = 0; x < bounds.width; x++) {
                            const globalX = bounds.left + x;
                            const globalY = bounds.top + y;
                            
                            if (globalX >= 0 && globalX < bounds.docWidth && 
                                globalY >= 0 && globalY < bounds.docHeight) {
                                
                                const docIndex = globalY * bounds.docWidth + globalX;
                                const targetIndex = y * bounds.width + x;
                                
                                if (docIndex >= 0 && docIndex < docTiledData.length && 
                                    targetIndex >= 0 && targetIndex < selectionData.length) {
                                    selectionData[targetIndex] = docTiledData[docIndex];
                                    processedPixels++;
                                }
                            }
                        }
                    }
                    
                    if (processedPixels % 10000 === 0 || batchStart + BATCH_ROWS >= bounds.height) {
                        console.log(`🔄 文档提取进度: ${batchStart + BATCH_ROWS}/${bounds.height} 行 (${(((batchStart + BATCH_ROWS) / bounds.height) * 100).toFixed(1)}%)`);
                    }
                    
                    resolve();
                });
            });
        }
        
        console.log('✅ 选区截取完成:', {
            processedPixels: processedPixels,
            totalPixels: selectionData.length,
            selectionSample: selectionData.slice(0, 5)
        });
        
        return selectionData;
    }



    //-------------------------------------------------------------------------------------------------
    // 获取渐变填充的灰度数据
    static async getGradientFillGrayData(state: any, bounds: any) {
        try {
            console.log('🌈 获取渐变填充灰度数据 - selectedGradient:', state.selectedGradient);
            
            const gradient = state.selectedGradient;
            if (!gradient) {
                console.log('⚠️ 没有找到渐变数据，使用默认中等灰度');
                const pixelCount = bounds.width * bounds.height;
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128);
                return grayData;
            }
            
            console.log('✅ 使用渐变数据计算灰度，渐变类型:', gradient.type, '角度:', gradient.angle, '反向:', gradient.reverse);
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
                    
                    // 应用反向参数
                    if (gradient.reverse) {
                        position = 1 - position;
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
    // 应用新的混合公式计算最终灰度值（优化版本，避免栈溢出）
    static async calculateFinalGrayValues(maskData: Uint8Array, fillData: Uint8Array, isSelectedAreas: boolean = true, opacity: number = 100): Promise<Uint8Array> {
        console.log('🔍 开始混合计算（优化版本）:', {
            maskDataLength: maskData.length,
            fillDataLength: fillData.length,
            isSelectedAreas: isSelectedAreas
        });
        
        const finalData = new Uint8Array(maskData.length);
        
        // 优化：计算fillData统计信息时避免使用扩展运算符
        let fillMin = 255, fillMax = 0, fillSum = 0;
        for (let i = 0; i < fillData.length; i++) {
            const val = fillData[i];
            if (val < fillMin) fillMin = val;
            if (val > fillMax) fillMax = val;
            fillSum += val;
        }
        
        const fillStats = {
            min: fillMin,
            max: fillMax,
            avg: fillSum / fillData.length,
        };
        
        console.log('📊 fillData统计信息:', fillStats);
        console.log('🔍 混合计算样本数据 (前10个像素):');
        
        // 分批处理，避免一次性处理过多数据导致栈溢出
        const BATCH_SIZE = 10000; // 每批处理1万个像素
        
        for (let batchStart = 0; batchStart < maskData.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, maskData.length);
            
            await new Promise(resolve => {
                setTimeout(() => {
                    // 两种情况使用相同的公式：255 - (maskValue + fillValue - (maskValue * fillValue) / 255)
                    for (let i = batchStart; i < batchEnd; i++) {
                        const maskValue = maskData[i];  // 快速蒙版像素值 (0-255)
                        
                        // 安全获取fillValue，如果超出范围则使用默认值128
                        const fillValue = i < fillData.length ? fillData[i] : 128;
                        
                        // 应用统一公式，主面板不透明度转换为0-1范围
                        const opacityFactor = opacity / 100;
                        const finalValue = 255 - (maskValue + fillValue - (maskValue * fillValue) / 255) * opacityFactor;
                        finalData[i] = Math.min(255, Math.max(0, Math.round(finalValue)));
                        
                        // 输出前10个像素的详细信息
                        if (i < 10) {
                            console.log(`像素 ${i} (${isSelectedAreas ? 'selectedAreas' : '非selectedAreas'}): maskValue=${maskValue}, fillValue=${fillValue}, finalValue=${finalValue.toFixed(2)}`);
                        }
                    }
                    resolve(void 0);
                }, 0);
            });
        }
        
        console.log('✅ 混合计算完成，最终数据长度:', finalData.length);
        return finalData;
    }



    //-------------------------------------------------------------------------------------------------
    // 将计算后的灰度数据写回快速蒙版通道
    static async updateQuickMaskChannel(grayData: Uint8Array, bounds: any) {
        try {
            console.log('🔄 开始更新快速蒙版通道');
            
            let documentColorProfile = "Dot Gain 15%"; // 默认值
            
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

            // 使用bounds中已经获取的文档尺寸信息
            const finalDocWidth = bounds.docWidth;
            const finalDocHeight = bounds.docHeight;
            
            console.log('📄 使用已获取的文档尺寸(像素):', finalDocWidth, 'x', finalDocHeight);
            
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
            
            // 根据射线法计算的选区内像素来更新数据
            if (bounds.selectionPixels && bounds.selectionPixels.size > 0) {
                
                // 遍历选区边界内的每个像素
                for (let y = 0; y < bounds.height; y++) {
                    for (let x = 0; x < bounds.width; x++) {
                        const sourceIndex = y * bounds.width + x;
                        const targetX = bounds.left + x;
                        const targetY = bounds.top + y;
                        const targetIndex = targetY * finalDocWidth + targetX;
                        
                        // 检查该像素是否在射线法计算的选区内
                        if (bounds.selectionPixels.has(targetIndex) && 
                            targetIndex < fullMaskArray.length && 
                            sourceIndex < grayscaleData.length) {
                            fullMaskArray[targetIndex] = grayscaleData[sourceIndex];
                        }
                    }
                }
            } else {
                console.log('📦 直接更新选区边界内的所有像素');
                // 回退方式：直接更新选区边界内的所有像素
                for (let y = 0; y < bounds.height; y++) {
                    for (let x = 0; x < bounds.width; x++) {
                        const sourceIndex = y * bounds.width + x;
                        const targetX = bounds.left + x;
                        const targetY = bounds.top + y;
                        const targetIndex = targetY * finalDocWidth + targetX;
                        
                        // 更新边界内的所有像素
                        if (targetIndex < fullMaskArray.length && 
                            sourceIndex < grayscaleData.length) {
                            fullMaskArray[targetIndex] = grayscaleData[sourceIndex];
                        }
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
                imageData: fullImageData
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

    }
