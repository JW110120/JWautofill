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