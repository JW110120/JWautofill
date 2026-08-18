import { app, action } from 'photoshop';

export interface LayerInfo {
    isBackground: boolean;
    hasTransparencyLocked: boolean;
    hasPixels: boolean;
    isInQuickMask: boolean;
    isInLayerMask: boolean;
    isInSingleColorChannel: boolean;
}

export class LayerInfoHandler {
    static async getActiveLayerInfo(): Promise<LayerInfo | null> {
        try {
            const doc = app.activeDocument;
            if (!doc) {
                return null;
            }
            
            const activeLayer = doc.activeLayers[0];
            if (!activeLayer) {
                return null;
            }
            
            const document = app.activeDocument;
            const isInQuickMask = document.quickMaskMode;
            
            // 检测是否在编辑图层蒙版（背景图层跳过此检测）
            const isInLayerMask = activeLayer.isBackgroundLayer ? false : await this.checkLayerMaskMode();
            
            // 检测是否选中了单个颜色通道
            const isInSingleColorChannel = await this.checkSingleColorChannelMode();
            
            return {
                isBackground: activeLayer.isBackgroundLayer,
                hasTransparencyLocked: activeLayer.transparentPixelsLocked,
                hasPixels: this.checkLayerHasPixels(activeLayer),
                isInQuickMask: isInQuickMask,
                isInLayerMask: isInLayerMask,
                isInSingleColorChannel: isInSingleColorChannel
            };
        } catch (error) {
            return null;
        }
    }

    private static checkLayerHasPixels(layer: any): boolean {
        if (layer.kind !== 'pixel') {
            return false;
        }
        
        return !!(layer.bounds && 
                 layer.bounds.width > 0 && 
                 layer.bounds.height > 0);
    }

    // 检测是否在编辑图层蒙版
    static async checkLayerMaskMode(): Promise<boolean> {
        try {
            // 多通道保护：如果当前选择了多个通道，直接返回 false，避免 batchPlay 获取报错
            try {
                const activeChannelsCount = (app.activeDocument as any)?.activeChannels?.length || 0;
                if (activeChannelsCount > 1) {
                    console.log(`🚫 检测到多通道选择 (${activeChannelsCount} 个通道)，跳过图层蒙版检测`);
                    return false;
                }
            } catch (error) {
                console.log('⚠️ 无法检测多通道状态，继续图层蒙版检测');
            }

            // 第一步：获取图层蒙版信息
            const maskResult = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "channel",
                            _enum: "channel",
                            _value: "mask"
                        }
                    ],
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true });

            // 第二步：获取当前激活的通道（使用 batchPlay）            
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

            // 第三步：比对蒙版通道与当前目标通道
            if (maskResult[0] && targetChannelResult[0]) {
                const maskInfo = maskResult[0];
                const targetChannelInfo = targetChannelResult[0];
                
                // 简化逻辑：比较channelName参数
                const maskChannelName = maskInfo.channelName;
                const targetChannelName = targetChannelInfo.channelName;
                
                if (maskChannelName && targetChannelName && maskChannelName === targetChannelName) {
                    console.log("✅ 正在编辑图层蒙版");
                    return true;
                } else {
                    return false;
                }
            }
            
            console.log("❌ 未找到蒙版信息或激活通道信息");
            return false;
        } catch (error) {
            console.error("❌ 检测图层蒙版模式失败:", error);
            return false;
        }
    }

    // 检测是否选中了单个颜色通道（红、绿、蓝、Alpha）
    static async checkSingleColorChannelMode(): Promise<boolean> {
        try {
            // 先检测是否多选了通道
            try {
                const activeChannelsCount = (app.activeDocument as any)?.activeChannels?.length || 0;
                if (activeChannelsCount > 1) {
                    console.log(`🚫 检测到多通道选择 (${activeChannelsCount} 个通道)，跳过单通道操作`);
                    return false;
                }
            } catch (error) {
                console.log('⚠️ 无法检测多通道状态，继续单通道检测');
            }

            // 获取当前激活的通道信息
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
                
                console.log("🔍 当前激活通道:", channelName);
                console.log("🔍 当前激活通道的索引:", itemIndex);

                // 获取快速蒙版状态
                const document = app.activeDocument;
                const isInQuickMask = document.quickMaskMode;
                
                // 获取图层蒙版状态
                const activeLayer = document.activeLayers[0];
                const isInLayerMask = activeLayer && !activeLayer.isBackgroundLayer ? await this.checkLayerMaskMode() : false;
                
                // 检测是否为RGB颜色通道（红、绿、蓝）
                // 通常这些通道的名称为 "红"、"绿"、"蓝" 或 "Red"、"Grain"、"Blue"
                const rgbChannels = ["红", "绿", "蓝", "Red", "Grain", "Blue", "R", "G", "B"];
                const isRgbChannel = rgbChannels.includes(channelName);
                
                // Alpha通道为通道指数 >=4且不为快速蒙版、图层蒙版的通道（因为快速蒙版、图层蒙版也在蓝通道下方，通道索引大于3）
                const isAlphaChannel = itemIndex >= 4 && !isInQuickMask && !isInLayerMask;
                
                // 对于单通道操作，支持RGB通道和Alpha通道
                const isInSingleColorChannel = isRgbChannel || isAlphaChannel;
                
                console.log(`🎯 当前通道是RGB复合通道吗: ${isRgbChannel}, 是单通道吗: ${isInSingleColorChannel}`);


                return isInSingleColorChannel;
            }
            
            return false;
        } catch (error) {
            console.error("❌ 检测单个颜色通道模式失败:", error);
            return false;
        }
    }
}