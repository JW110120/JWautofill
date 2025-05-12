import { app } from 'photoshop';

export interface ColorSettings {
    hueVariation: number;
    saturationVariation: number;
    brightnessVariation: number;
    opacityVariation: number;
}

export interface HSBColor {
    hsb: {
        hue: number;
        saturation: number;
        brightness: number;
    };
}

export function calculateRandomColor(settings: ColorSettings, baseOpacity: number): HSBColor & { opacity: number } {
    const foregroundColor = app.foregroundColor;
    const baseHue = foregroundColor.hsb.hue;
    const baseSaturation = foregroundColor.hsb.saturation;
    const baseBrightness = foregroundColor.hsb.brightness;

    // 计算色相抖动范围
    let hueRange = [];
    if (settings.hueVariation > 0) {
        const hueVariation = settings.hueVariation;
        hueRange = [
            ...Array.from({ length: hueVariation / 2 }, (_, i) => (baseHue + 360 - hueVariation / 2 + i) % 360),
            ...Array.from({ length: hueVariation / 2 }, (_, i) => (baseHue + i) % 360)
        ];
    }

    // 确保 hueRange 不为空
    const hue = hueRange.length > 0 ? hueRange[Math.floor(Math.random() * hueRange.length)] : baseHue;

    // 计算饱和度抖动范围
    const saturationVariation = settings.saturationVariation / 2;
    const saturationMin = Math.max(0, baseSaturation - baseSaturation * saturationVariation);
    const saturationMax = Math.min(100, baseSaturation + baseSaturation * saturationVariation);
    const saturation = Math.floor(Math.random() * (saturationMax - saturationMin + 1)) + saturationMin;

    // 计算亮度抖动范围
    const brightnessVariation = settings.brightnessVariation / 2;
    const brightnessMin = Math.max(0, baseBrightness - baseBrightness * brightnessVariation);
    const brightnessMax = Math.min(100, baseBrightness + baseBrightness * brightnessVariation);
    const brightness = Math.floor(Math.random() * (brightnessMax - brightnessMin + 1)) + brightnessMin;

    // 计算不透明度抖动范围
    const opacityVariation = settings.opacityVariation / 2;
    const opacityMin = Math.max(0, baseOpacity - baseOpacity * opacityVariation);
    const opacityMax = Math.min(100, baseOpacity + baseOpacity * opacityVariation);
    const randomOpacity = Math.floor(Math.random() * (opacityMax - opacityMin + 1)) + opacityMin;

    return {
        hsb: {
            hue,
            saturation,
            brightness
        },
        opacity: randomOpacity
    };
}