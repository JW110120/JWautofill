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
                        _value: 0 // 始终设为0，按用户要求
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
        
        // 将选区数据映射到文档坐标
        const selectionMap = new Map<string, number>();
        for (let i = 0; i < selectionData.length; i++) {
            if (selectionData[i] > 0) {
                const x = i % width;
                const y = Math.floor(i / width);
                const docX = left + x;
                const docY = top + y;
                const key = `${docX},${docY}`;
                selectionMap.set(key, selectionData[i]);
            }
        }
        
        console.log(`🗺️ 选区映射: 有效像素=${selectionMap.size}`);
        
        if (selectionMap.size === 0) {
            console.warn('⚠️ 选区映射为空，返回空数组');
            const finalNonZeroCount = fullDocumentData.filter(val => val > 0).length;
            console.log(`🎯 最终结果: 非零像素=${finalNonZeroCount}`);
            return fullDocumentData;
        }
        
        // 计算选区中心点（加权平均）
        let centerX = 0, centerY = 0, totalWeight = 0;
        for (const [key, value] of selectionMap) {
            const [x, y] = key.split(',').map(Number);
            const weight = value / 255; // 归一化权重
            centerX += x * weight;
            centerY += y * weight;
            totalWeight += weight;
        }
        
        if (totalWeight > 0) {
            centerX /= totalWeight;
            centerY /= totalWeight;
        } else {
            // 如果没有权重，使用几何中心
            let sumX = 0, sumY = 0, count = 0;
            for (const [key] of selectionMap) {
                const [x, y] = key.split(',').map(Number);
                sumX += x;
                sumY += y;
                count++;
            }
            centerX = count > 0 ? sumX / count : 0;
            centerY = count > 0 ? sumY / count : 0;
        }
        
        // 应用扩散效果
        const expandFactor = expandValue / 100; // 将0到100转换为0到1
        
        // 先保留原始选区
        for (const [key, value] of selectionMap) {
            const [x, y] = key.split(',').map(Number);
            const index = y * docWidth + x;
            if (index >= 0 && index < fullDocumentData.length) {
                fullDocumentData[index] = value;
            }
        }
        
        // 如果有扩散值，则添加扩散效果
        let diffusedPixels = 0;
        if (expandValue > 0) {
            console.log(`🌟 开始扩散: 中心点(${centerX.toFixed(1)}, ${centerY.toFixed(1)}), 扩散因子=${expandFactor}`);
            
            for (const [key, value] of selectionMap) {
                const [x, y] = key.split(',').map(Number);
                
                // 计算距离中心的向量
                const dx = x - centerX;
                const dy = y - centerY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                // 避免除零错误
                if (distance === 0) continue;
                
                // 归一化方向向量
                const dirX = dx / distance;
                const dirY = dy / distance;
                
                // 计算扩散距离（基于原始距离和扩散因子）
                const expandDistance = expandFactor * (1 + distance * 0.01); // 距离越远扩散越强
                
                // 计算扩散偏移
                const offsetX = Math.round(dirX * expandDistance);
                const offsetY = Math.round(dirY * expandDistance);
                
                // 计算新位置
                const newX = x + offsetX;
                const newY = y + offsetY;
                
                // 检查边界并应用扩散
                if (newX >= 0 && newX < docWidth && newY >= 0 && newY < docHeight) {
                    const newIndex = newY * docWidth + newX;
                    const oldValue = fullDocumentData[newIndex];
                    
                    // 计算扩散强度（距离越远强度越弱）
                    const intensity = Math.max(0.3, 1 - (expandDistance / 100));
                    const expandedValue = Math.round(value * intensity);
                    
                    // 使用最大值混合
                    fullDocumentData[newIndex] = Math.max(fullDocumentData[newIndex], expandedValue);
                    if (fullDocumentData[newIndex] > oldValue) {
                        diffusedPixels++;
                    }
                }
            }
            
            console.log(`✨ 扩散完成: 新增/更新像素=${diffusedPixels}`);
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
            
            // 再应用扩散效果
            if (options.selectionExpand !== 0) {
                await this.applyExpand(options.selectionExpand);
            }
        } catch (error) {
            console.error('应用选区修改失败:', error);
            throw error;
        }
    }
}