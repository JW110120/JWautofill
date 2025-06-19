import { app } from 'photoshop';

export interface ColorSettings {
    hueVariation: number;
    saturationVariation: number;
    brightnessVariation: number;
    opacityVariation: number;
    grayVariation?: number; // 灰度抖动，用于快速蒙版模式
    calculationMode?: 'absolute' | 'relative'; // 计算模式：绝对或相对
}

export interface HSBColor {
    hsb: {
        hue: number;
        saturation: number;
        brightness: number;
    };
}

/**
 * 根据基础颜色和抖动设置计算随机颜色。
 *
 * @param settings 颜色抖动设置，包含色相、饱和度、亮度、不透明度和灰度（可选）的抖动值。
 * @param baseOpacity 基础不透明度 (0-100)。
 * @param customForegroundColor 可选的自定义前景色对象，如果未提供，则使用 Photoshop 的当前前景色。
 * @param isQuickMaskMode 布尔值，指示是否处于快速蒙版模式。在此模式下，颜色抖动行为会有所不同。
 * @returns 返回一个包含随机计算出的 HSB 颜色值和不透明度的对象。
 */
export function calculateRandomColor(settings: ColorSettings, baseOpacity: number, customForegroundColor?: any, isQuickMaskMode: boolean = false): HSBColor & { opacity: number } {
    const foregroundColor = customForegroundColor || app.foregroundColor;
    const baseHue = foregroundColor.hsb.hue;
    const baseSaturation = foregroundColor.hsb.saturation;
    const baseBrightness = foregroundColor.hsb.brightness;

    let hue, saturation, brightness;

    if (isQuickMaskMode) {
        // 快速蒙版模式：禁用色相和饱和度抖动，使用灰度抖动
        hue = baseHue;
        saturation = baseSaturation;
        
        // 将前景色转换为RGB，然后计算灰度值
        const rgb = hsbToRgb(baseHue, baseSaturation, baseBrightness);
        const baseGrayValue = rgbToGray(rgb.red, rgb.green, rgb.blue);
        
        // 根据计算模式选择灰度抖动计算方式
        let randomGrayValue: number;
        if (settings.calculationMode === 'relative') {
            // 相对模式：基于基础灰度值的百分比计算
            const grayVariation = (settings.grayVariation || 0) / 2;
            const grayMin = Math.max(0, baseGrayValue - baseGrayValue * grayVariation / 100);
            const grayMax = Math.min(255, baseGrayValue + baseGrayValue * grayVariation / 100);
            randomGrayValue = Math.floor(Math.random() * (grayMax - grayMin + 1)) + grayMin;
        } else {
            // 绝对模式：直接使用设定值计算 (范围0-255)
            const grayVariation = (settings.grayVariation || 0) * 255 / 100 / 2; // 将百分比转换为0-255范围的绝对值
            const grayMin = Math.max(0, baseGrayValue - grayVariation);
            const grayMax = Math.min(255, baseGrayValue + grayVariation);
            randomGrayValue = Math.floor(Math.random() * (grayMax - grayMin + 1)) + grayMin;
        }
        
        // 将灰度值转换回HSB（保持色相和饱和度，调整亮度）
        brightness = (randomGrayValue / 255) * 100;
    } else {
        // 正常模式：使用原有的色相、饱和度、亮度抖动
        // 根据计算模式选择色相抖动计算方式
        if (settings.calculationMode === 'relative') {
            // 相对模式：基于基础值的百分比计算色相范围
            const hueVariation = settings.hueVariation / 2;
            const relativeVariation = baseHue * hueVariation / 100;
            const hueMin = (baseHue - relativeVariation + 360) % 360;
            const hueMax = (baseHue + relativeVariation) % 360;
            
            if (hueMin <= hueMax) {
                hue = Math.random() * (hueMax - hueMin) + hueMin;
            } else {
                // 跨越0度的情况
                const range1 = 360 - hueMin;
                const range2 = hueMax;
                const totalRange = range1 + range2;
                const randomValue = Math.random() * totalRange;
                
                if (randomValue < range1) {
                    hue = hueMin + randomValue;
                } else {
                    hue = randomValue - range1;
                }
            }
        } else {
            // 绝对模式：直接使用设定值计算
            let hueRange = [];
            if (settings.hueVariation > 0) {
                const hueVariation = settings.hueVariation;
                hueRange = Array.from({ length: hueVariation + 1 }, (_, i) => 
                    (baseHue + 360 - hueVariation / 2 + i) % 360
                );
            }
            // 确保 hueRange 不为空
            hue = hueRange.length > 0 ? hueRange[Math.floor(Math.random() * hueRange.length)] : baseHue;
        }

        // 根据计算模式选择饱和度抖动计算方式
        if (settings.calculationMode === 'relative') {
            // 相对模式：基于基础值的百分比计算
            const saturationVariation = settings.saturationVariation / 2;
            const saturationMin = Math.max(0, baseSaturation - baseSaturation * saturationVariation / 100);
            const saturationMax = Math.min(100, baseSaturation + baseSaturation * saturationVariation / 100);
            saturation = Math.floor(Math.random() * (saturationMax - saturationMin + 1)) + saturationMin;
        } else {
            // 绝对模式：直接使用设定值计算
            const saturationVariation = settings.saturationVariation / 2;
            const saturationMin = Math.max(0, baseSaturation - saturationVariation);
            const saturationMax = Math.min(100, baseSaturation + saturationVariation);
            saturation = Math.floor(Math.random() * (saturationMax - saturationMin + 1)) + saturationMin;
        }

        // 根据计算模式选择亮度抖动计算方式
        if (settings.calculationMode === 'relative') {
            // 相对模式：基于基础值的百分比计算
            const brightnessVariation = settings.brightnessVariation / 2;
            const brightnessMin = Math.max(0, baseBrightness - baseBrightness * brightnessVariation / 100);
            const brightnessMax = Math.min(100, baseBrightness + baseBrightness * brightnessVariation / 100);
            brightness = Math.floor(Math.random() * (brightnessMax - brightnessMin + 1)) + brightnessMin;
        } else {
            // 绝对模式：直接使用设定值计算
            const brightnessVariation = settings.brightnessVariation / 2;
            const brightnessMin = Math.max(0, baseBrightness - brightnessVariation);
            const brightnessMax = Math.min(100, baseBrightness + brightnessVariation);
            brightness = Math.floor(Math.random() * (brightnessMax - brightnessMin + 1)) + brightnessMin;
        }
    }

    // 根据计算模式选择不透明度抖动计算方式
    let randomOpacity: number;
    if (settings.calculationMode === 'relative') {
        // 相对模式：基于基础不透明度的百分比计算
        const opacityVariation = settings.opacityVariation / 2;
        const opacityMin = Math.max(0, baseOpacity - baseOpacity * opacityVariation / 100);
        const opacityMax = Math.min(100, baseOpacity + baseOpacity * opacityVariation / 100);
        randomOpacity = Math.floor(Math.random() * (opacityMax - opacityMin + 1)) + opacityMin;
    } else {
        // 绝对模式：直接使用设定值计算
        const opacityVariation = settings.opacityVariation / 2;
        const opacityMin = Math.max(0, baseOpacity - opacityVariation);
        const opacityMax = Math.min(100, baseOpacity + opacityVariation);
        randomOpacity = Math.floor(Math.random() * (opacityMax - opacityMin + 1)) + opacityMin;
    }

    return {
        hsb: {
            hue,
            saturation,
            brightness
        },
        opacity: randomOpacity
    };
}

// HSB转RGB的辅助函数
export function hsbToRgb(hue: number, saturation: number, brightness: number): { red: number, green: number, blue: number } {
    const h = hue / 360;
    const s = saturation / 100;
    const b = brightness / 100;
    
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = b * (1 - s);
    const q = b * (1 - f * s);
    const t = b * (1 - (1 - f) * s);
    
    let r, g, bl;
    switch (i % 6) {
        case 0: r = b; g = t; bl = p; break;
        case 1: r = q; g = b; bl = p; break;
        case 2: r = p; g = b; bl = t; break;
        case 3: r = p; g = q; bl = b; break;
        case 4: r = t; g = p; bl = b; break;
        case 5: r = b; g = p; bl = q; break;
        default: r = g = bl = 0;
    }
    
    return {
        red: Math.round(r * 255),
        green: Math.round(g * 255),
        blue: Math.round(bl * 255)
    };
}

// RGB转灰度的辅助函数
const RED_LUMINANCE_COEFFICIENT = 0.299;
const GREEN_LUMINANCE_COEFFICIENT = 0.587;
const BLUE_LUMINANCE_COEFFICIENT = 0.114;

export function rgbToGray(red: number, green: number, blue: number): number {
    return Math.round(RED_LUMINANCE_COEFFICIENT * red + GREEN_LUMINANCE_COEFFICIENT * green + BLUE_LUMINANCE_COEFFICIENT * blue);
}