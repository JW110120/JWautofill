export const BLEND_MODES = {
    '正常': 'normal',
    '溶解': 'dissolve',
    '背后': 'behind',  // 添加背后模式
    '变暗': 'darken',
    '正片叠底': 'multiply',
    '颜色加深': 'colorBurn',
    '线性加深': 'linearBurn',
    '深色': 'darkerColor',
    '变亮': 'lighten',
    '滤色': 'screen',
    '颜色减淡': 'colorDodge',
    '线性减淡': 'linearDodge',
    '浅色': 'lighterColor',
    '叠加': 'overlay',
    '柔光': 'softLight',
    '强光': 'hardLight',
    '亮光': 'vividLight',
    '线性光': 'linearLight',
    '点光': 'pinLight',
    '实色混合': 'hardMix',
    '差值': 'difference',
    '排除': 'exclusion',
    '减去': 'subtract',
    '划分': 'divide',
    '色相': 'hue',
    '饱和度': 'saturation',
    '颜色': 'color',
    '明度': 'luminosity',
} as const;

export type BlendModeKey = keyof typeof BLEND_MODES;
export type BlendModeValue = typeof BLEND_MODES[BlendModeKey];