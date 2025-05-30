import { app } from 'photoshop';

interface LayerInfo {
    isBackground: boolean;
    hasTransparencyLocked: boolean;
    hasPixels: boolean;
    isInQuickMask: boolean;
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
            
            return {
                isBackground: activeLayer.isBackgroundLayer,
                hasTransparencyLocked: activeLayer.transparentPixelsLocked,
                hasPixels: this.checkLayerHasPixels(activeLayer),
                isInQuickMask: isInQuickMask
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
}