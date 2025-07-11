/**
 * 混合模式计算公式
 * 用于快速蒙版中的灰度值混合计算
 * 所有值都是0-255范围内的灰度值
 */

export type BlendModeFunction = (base: number, blend: number) => number;

/**
 * 将0-255范围的值标准化到0-1
 */
function normalize(value: number): number {
    return Math.max(0, Math.min(255, value)) / 255;
}

/**
 * 将0-1范围的值转换回0-255
 */
function denormalize(value: number): number {
    return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

/**
 * 混合模式计算函数映射
 */
export const BLEND_MODE_CALCULATIONS: Record<string, BlendModeFunction> = {
    // 正常模式
    'normal': (base: number, blend: number) => blend,
    '正常': (base: number, blend: number) => blend,

    // 变暗模式
    'darken': (base: number, blend: number) => Math.min(base, blend),
    '变暗': (base: number, blend: number) => Math.min(base, blend),

    // 正片叠底
    'multiply': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(baseNorm * blendNorm);
    },
    '正片叠底': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(baseNorm * blendNorm);
    },

    // 颜色加深
    'colorBurn': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (blendNorm === 0) return 0;
        return denormalize(Math.max(0, 1 - (1 - baseNorm) / blendNorm));
    },
    '颜色加深': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (blendNorm === 0) return 0;
        return denormalize(Math.max(0, 1 - (1 - baseNorm) / blendNorm));
    },

    // 线性加深
    'linearBurn': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(Math.max(0, baseNorm + blendNorm - 1));
    },
    '线性加深': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(Math.max(0, baseNorm + blendNorm - 1));
    },

    // 变亮模式
    'lighten': (base: number, blend: number) => Math.max(base, blend),
    '变亮': (base: number, blend: number) => Math.max(base, blend),

    // 滤色
    'screen': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(1 - (1 - baseNorm) * (1 - blendNorm));
    },
    '滤色': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(1 - (1 - baseNorm) * (1 - blendNorm));
    },

    // 颜色减淡
    'colorDodge': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (blendNorm === 1) return 255;
        return denormalize(Math.min(1, baseNorm / (1 - blendNorm)));
    },
    '颜色减淡': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (blendNorm === 1) return 255;
        return denormalize(Math.min(1, baseNorm / (1 - blendNorm)));
    },

    // 线性减淡
    'linearDodge': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(Math.min(1, baseNorm + blendNorm));
    },
    '线性减淡': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(Math.min(1, baseNorm + blendNorm));
    },

    // 叠加
    'overlay': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (baseNorm < 0.5) {
            return denormalize(2 * baseNorm * blendNorm);
        } else {
            return denormalize(1 - 2 * (1 - baseNorm) * (1 - blendNorm));
        }
    },
    '叠加': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (baseNorm < 0.5) {
            return denormalize(2 * baseNorm * blendNorm);
        } else {
            return denormalize(1 - 2 * (1 - baseNorm) * (1 - blendNorm));
        }
    },

    // 柔光
    'softLight': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (blendNorm < 0.5) {
            return denormalize(2 * baseNorm * blendNorm + baseNorm * baseNorm * (1 - 2 * blendNorm));
        } else {
            return denormalize(2 * baseNorm * (1 - blendNorm) + Math.sqrt(baseNorm) * (2 * blendNorm - 1));
        }
    },
    '柔光': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (blendNorm < 0.5) {
            return denormalize(2 * baseNorm * blendNorm + baseNorm * baseNorm * (1 - 2 * blendNorm));
        } else {
            return denormalize(2 * baseNorm * (1 - blendNorm) + Math.sqrt(baseNorm) * (2 * blendNorm - 1));
        }
    },

    // 强光
    'hardLight': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (blendNorm < 0.5) {
            return denormalize(2 * baseNorm * blendNorm);
        } else {
            return denormalize(1 - 2 * (1 - baseNorm) * (1 - blendNorm));
        }
    },
    '强光': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        if (blendNorm < 0.5) {
            return denormalize(2 * baseNorm * blendNorm);
        } else {
            return denormalize(1 - 2 * (1 - baseNorm) * (1 - blendNorm));
        }
    },

    // 差值
    'difference': (base: number, blend: number) => Math.abs(base - blend),
    '差值': (base: number, blend: number) => Math.abs(base - blend),

    // 排除
    'exclusion': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(baseNorm + blendNorm - 2 * baseNorm * blendNorm);
    },
    '排除': (base: number, blend: number) => {
        const baseNorm = normalize(base);
        const blendNorm = normalize(blend);
        return denormalize(baseNorm + blendNorm - 2 * baseNorm * blendNorm);
    },

    // 减去
    'subtract': (base: number, blend: number) => Math.max(0, base - blend),
    '减去': (base: number, blend: number) => Math.max(0, base - blend),

    // 划分
    'divide': (base: number, blend: number) => {
        if (blend === 0) return 255;
        return Math.min(255, Math.round((base / blend) * 255));
    },
    '划分': (base: number, blend: number) => {
        if (blend === 0) return 255;
        return Math.min(255, Math.round((base / blend) * 255));
    }
};

/**
 * 获取混合模式计算函数
 * @param blendMode 混合模式名称
 * @returns 混合计算函数
 */
export function getBlendModeCalculation(blendMode: string): BlendModeFunction {
    return BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
}

/**
 * 应用混合模式计算
 * @param baseValue 基础灰度值 (0-255)
 * @param blendValue 混合灰度值 (0-255)
 * @param blendMode 混合模式
 * @param opacity 不透明度 (0-100)
 * @returns 计算后的灰度值 (0-255)
 */
export function applyBlendMode(
    baseValue: number,
    blendValue: number,
    blendMode: string,
    opacity: number = 100
): number {
    const blendFunction = getBlendModeCalculation(blendMode);
    const blendedValue = blendFunction(baseValue, blendValue);
    
    // 应用不透明度
    const opacityFactor = Math.max(0, Math.min(100, opacity)) / 100;
    return Math.round(baseValue + (blendedValue - baseValue) * opacityFactor);
}

/**
 * 图层蒙版与图案混合计算
 * @param maskValue 图层蒙版灰度值 (0-255) 作为 baseNorm
 * @param patternValue 图案灰度值 (0-255) 作为 blendNorm
 * @param patternAlpha 图案不透明度 (0-255)
 * @param blendMode 混合模式
 * @param opacity 整体不透明度 (0-100)
 * @returns 计算后的蒙版灰度值 (0-255)
 */
export function blendLayerMaskWithPattern(
    maskValue: number,
    patternValue: number,
    patternAlpha: number,
    blendMode: string,
    opacity: number = 100
): number {
    // 首先应用图案的不透明度
    const alphaFactor = Math.max(0, Math.min(255, patternAlpha)) / 255;
    const effectivePatternValue = Math.round(patternValue * alphaFactor + 255 * (1 - alphaFactor));
    
    // 应用混合模式计算，图层蒙版作为base，图案作为blend
    const blendFunction = getBlendModeCalculation(blendMode);
    const blendedValue = blendFunction(maskValue, effectivePatternValue);
    
    // 应用整体不透明度
    const opacityFactor = Math.max(0, Math.min(100, opacity)) / 100;
    return Math.round(maskValue + (blendedValue - maskValue) * opacityFactor);
}