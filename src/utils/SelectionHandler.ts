import { action, app, imaging } from "photoshop";

// 选区选项参数接口
export interface SelectionOptions {
    selectionSmooth: number;
    selectionContrast: number;
    selectionExpand: number; // 改名为扩散
}

// 选区处理器类
export class SelectionHandler {
    static async applySelectAndMask(options: SelectionOptions): Promise<void> {
        try {
            await action.batchPlay([
                {
                    _obj: "smartBrushWorkspace",
                    presetKind: {
                        _enum: "presetKindType",
                        _value: "presetKindCustom"
                    },
                    smartBrushRadius: 0,
                    smartBrushSmooth: options.selectionSmooth,
                    smartBrushFeather: {
                        _unit: "pixelsUnit",
                        _value: 0
                    },
                    smartBrushContrast: {
                        _unit: "percentUnit",
                        _value: options.selectionContrast
                    },
                    smartBrushShiftEdge: {
                        _unit: "percentUnit",
                        _value: 0
                    },
                    sampleAllLayers: false,
                    smartBrushUseSmartRadius: false,
                    smartBrushUseDeepMatte: false,
                    autoTrimap: false,
                    smartBrushDecontaminate: false,
                    smartBrushDeconAmount: {
                        _unit: "percentUnit",
                        _value: 100
                    },
                    refineEdgeOutput: {
                        _enum: "refineEdgeOutput",
                        _value: "selectionOutputToSelection"
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], {});
        } catch (error) {
            console.error('选择并遮住失败:', error);
            throw error;
        }
    }


    static async applyExpand(expandValue: number): Promise<void> {
        if (expandValue === 0) return;
        
        try {
            console.log('🎯 开始应用扩散效果:', expandValue);
            
            // 获取选区数据和文档信息
            const selectionData = await this.getSelectionData();
            if (!selectionData) {
                console.log('没有选区，跳过扩散处理');
                return;
            }
            
            // 应用扩散算法
            const expandedData = this.applyDiffusionEffect(selectionData, expandValue);
            
            // 应用扩散后的选区
            await this.putExpandedSelection(expandedData, selectionData.docWidth, selectionData.docHeight);
            
            console.log('✅ 扩散效果应用完成');
        } catch (error) {
            console.error('❌ 应用扩散效果失败:', error);
            throw error;
        }
    }




    
    static shouldApplySelectionModification(options: SelectionOptions): boolean {
        return options.selectionSmooth !== 0 || 
               options.selectionContrast !== 0 || 
               options.selectionExpand !== 0;
    }

    

    private static async getSelectionData() {
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
            
            // 获取文档尺寸信息
            const docWidth = docResult[0].width._value;
            const docHeight = docResult[0].height._value;
            const resolution = docResult[0].resolution._value;
            
            // 转换为像素单位
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
            
            // 调试：检查原始选区数据
            const originalNonZeroCount = selectionData.filter(val => val > 0).length;
            console.log(`🔍 原始选区数据: 总像素=${selectionData.length}, 非零像素=${originalNonZeroCount}`);
            console.log(`📐 选区边界: left=${left}, top=${top}, width=${width}, height=${height}`);
            console.log(`📄 文档尺寸: ${docWidthPixels}x${docHeightPixels}`);
            
            return {
                selectionData,
                bounds: { left, top, right, bottom, width, height },
                docWidth: docWidthPixels,
                docHeight: docHeightPixels
            };
        } catch (error) {
            console.error('获取选区数据失败:', error);
            return null;
        }
    }
    

    private static applyDiffusionEffect(data: any, expandValue: number): Uint8Array {
        const { selectionData, bounds, docWidth, docHeight } = data;
        const { left, top, width, height } = bounds;
        
        // 创建文档大小的数组
        const fullDocumentData = new Uint8Array(docWidth * docHeight);
        fullDocumentData.fill(0);
        
        console.log(`🌟 开始像素移动式喷溅算法: 扩散值=${expandValue}`);
        
        // 收集所有有效像素用于移动
        const allPixels = [];
        let processedPixels = 0;
        
        for (let i = 0; i < selectionData.length; i++) {
            if (selectionData[i] > 0) {
                const x = i % width;
                const y = Math.floor(i / width);
                const docX = left + x;
                const docY = top + y;
                
                allPixels.push({ x: docX, y: docY, value: selectionData[i] });
                processedPixels++;
            }
        }
        
        console.log(`📊 收集到有效像素: ${processedPixels}个`);
        
        if (allPixels.length === 0) {
            console.warn('⚠️ 没有有效像素，返回空数组');
            return fullDocumentData;
        }
        
        // 应用像素移动式喷溅效果
        if (expandValue > 0) {
            // 增强强度一倍
            const splashIntensity = (expandValue / 100) * 2; // 0-2的强度
            const maxSplashDistance = Math.max(10, Math.round(expandValue / 2.5)); // 增大最大喷溅距离
            
            console.log(`🎨 喷溅参数: 强度=${splashIntensity.toFixed(2)}, 最大距离=${maxSplashDistance}`);
            
            const movedPixels = [];
            let totalMoved = 0;
            
            // 为每个像素计算移动位置
            for (const pixel of allPixels) {
                // 根据强度决定是否移动这个像素
                const moveChance = Math.min(0.9, splashIntensity * 0.5); // 最多90%的像素会移动
                
                if (Math.random() < moveChance) {
                    // 随机生成移动方向和距离
                    const angle = Math.random() * 2 * Math.PI;
                    const distance = Math.random() * maxSplashDistance * splashIntensity;
                    
                    // 添加随机性让移动更不规则
                    const randomFactor = 0.3 + Math.random() * 0.7;
                    const actualDistance = distance * randomFactor;
                    
                    const newX = Math.round(pixel.x + Math.cos(angle) * actualDistance);
                    const newY = Math.round(pixel.y + Math.sin(angle) * actualDistance);
                    
                    // 检查边界
                    if (newX >= 0 && newX < docWidth && newY >= 0 && newY < docHeight) {
                        movedPixels.push({ x: newX, y: newY, value: pixel.value });
                        totalMoved++;
                    }
                } else {
                    // 不移动的像素保持原位
                    movedPixels.push({ x: pixel.x, y: pixel.y, value: pixel.value });
                }
            }
            
            console.log(`🚀 像素移动完成: 移动了${totalMoved}个像素`);
            
            // 将移动后的像素放置到新位置
            for (const pixel of movedPixels) {
                const index = pixel.y * docWidth + pixel.x;
                if (index >= 0 && index < fullDocumentData.length) {
                    // 使用最大值混合，避免覆盖更亮的像素
                    fullDocumentData[index] = Math.max(fullDocumentData[index], pixel.value);
                }
            }
            
            // 增加15%的额外像素来增强视觉效果
            const extraPixelCount = Math.round(movedPixels.length * 0.15);
            let extraPixelsAdded = 0;
            
            console.log(`✨ 开始添加${extraPixelCount}个额外像素增强效果`);
            
            for (let i = 0; i < extraPixelCount && extraPixelsAdded < extraPixelCount; i++) {
                // 随机选择一个已移动的像素作为基础
                const basePixel = movedPixels[Math.floor(Math.random() * movedPixels.length)];
                
                // 在其周围小范围内添加额外像素
                const extraRange = 3; // 额外像素的范围
                const extraX = basePixel.x + Math.round((Math.random() - 0.5) * extraRange * 2);
                const extraY = basePixel.y + Math.round((Math.random() - 0.5) * extraRange * 2);
                
                // 检查边界
                if (extraX >= 0 && extraX < docWidth && extraY >= 0 && extraY < docHeight) {
                    const extraIndex = extraY * docWidth + extraX;
                    if (extraIndex >= 0 && extraIndex < fullDocumentData.length) {
                        // 额外像素的强度稍弱
                        const extraValue = Math.round(basePixel.value * (0.3 + Math.random() * 0.4));
                        fullDocumentData[extraIndex] = Math.max(fullDocumentData[extraIndex], extraValue);
                        extraPixelsAdded++;
                    }
                }
            }
            
            console.log(`🎯 喷溅完成: 主要像素=${movedPixels.length}个, 额外像素=${extraPixelsAdded}个`);
        } else {
            // 如果扩散值为0，直接复制原始像素
            for (const pixel of allPixels) {
                const index = pixel.y * docWidth + pixel.x;
                if (index >= 0 && index < fullDocumentData.length) {
                    fullDocumentData[index] = pixel.value;
                }
            }
        }
        
        return fullDocumentData;
    }
    

    private static async putExpandedSelection(expandedData: Uint8Array, docWidth: number, docHeight: number): Promise<void> {
        try {
            const documentColorProfile = "Dot Gain 15%";
            
            // 调试：检查扩散后的数据
            const nonZeroCount = expandedData.filter(val => val > 0).length;
            console.log(`🔍 扩散后数据统计: 总像素=${expandedData.length}, 非零像素=${nonZeroCount}`);
            
            if (nonZeroCount === 0) {
                console.warn('⚠️ 扩散后的数据全为0，选区将为空');
                return;
            }
            
            // 创建ImageData选项
            const selectionOptions = {
                width: docWidth,
                height: docHeight,
                components: 1,
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            // 使用createImageDataFromBuffer创建ImageData
            const imageData = await imaging.createImageDataFromBuffer(expandedData, selectionOptions);
            
            // 使用putSelection应用新的选区
            await imaging.putSelection({
                documentID: app.activeDocument.id,
                imageData: imageData,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: docWidth,
                    bottom: docHeight
                }
            });
            
            imageData.dispose();
            console.log('✅ 选区应用成功');
        } catch (error) {
            console.error('应用扩散选区失败:', error);
            throw error;
        }
    }
    

    static async applySelectionModification(options: SelectionOptions): Promise<void> {
        try {
            // 先应用选择并遮住（包含平滑和对比）
            if (options.selectionSmooth !== 0 || options.selectionContrast !== 0) {
                await this.applySelectAndMask(options);
            }
            
            // 再应用扩散效果（使用当前选区数据）
            if (options.selectionExpand !== 0) {
                await this.applyExpand(options.selectionExpand);
            }
        } catch (error) {
            console.error('应用选区修改失败:', error);
            throw error;
        }
    }
}