import { app, action } from 'photoshop';

interface LayerInfo {
    isBackground: boolean;
    hasTransparencyLocked: boolean;
    hasPixels: boolean;
    isInQuickMask: boolean;
    isInLayerMask: boolean;
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
            
            // 检测是否在编辑图层蒙版
            const isInLayerMask = await this.checkLayerMaskMode();
            
            return {
                isBackground: activeLayer.isBackgroundLayer,
                hasTransparencyLocked: activeLayer.transparentPixelsLocked,
                hasPixels: this.checkLayerHasPixels(activeLayer),
                isInQuickMask: isInQuickMask,
                isInLayerMask: isInLayerMask
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
    private static async checkLayerMaskMode(): Promise<boolean> {
        try {
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
                
                console.log("🎭 蒙版通道信息:", maskInfo);
                console.log("🎯 目标通道信息:", targetChannelInfo);
                
                // 简化逻辑：比较channelName参数
                const maskChannelName = maskInfo.channelName;
                const targetChannelName = targetChannelInfo.channelName;
                
                console.log("🔍 通道名称比较:", {
                    maskChannelName: maskChannelName,
                    targetChannelName: targetChannelName
                });
                
                if (maskChannelName && targetChannelName && maskChannelName === targetChannelName) {
                    console.log("✅ 正在编辑蒙版 - 通道名称匹配:", {
                        channelName: maskChannelName
                    });
                    return true;
                } else {
                    console.log("❌ 未在编辑蒙版 - 通道名称不匹配:", {
                        maskChannelName: maskChannelName,
                        targetChannelName: targetChannelName
                    });
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
}