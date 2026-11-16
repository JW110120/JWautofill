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

/**
 * PS 枚举值 → 中文名（**面向用户的文案唯一出口**）。
 *
 * ⛔ 为什么必须有它：`.8li` 的混合模式热键广播的是 **PS 枚举值**
 *    （`keyhook.c` 的 `KH_BLEND_DEFS`，如 `multiply` / `colorBurn`），
 *    面板内部一律用中文名。提示文案里若直接打印枚举值，用户看到的就是
 *    「选区填充混合模式 → multiply」这种半英半中的句子 —— 2026-11-16 用户报的
 *    「notify 汉化不完整」正是这一处（`BrushHotkeySection` 的 blendMode 分支）。
 *
 * ⛔ 反查必须**大小写不敏感**：原生侧是驼峰，人手写配置时大小写随手
 *    （与 `blendGuard.ts` 的工具 ID 归一化同一口径）。
 * ⛔ 查不到一律返回空串，由调用方给「未知模式」——**绝不**返回枚举值本身，
 *    那等于把没汉化的原文又漏回界面。
 */
export function blendModeLabel(mode: string | null | undefined): string {
    if (!mode) return '';
    const want = String(mode).toLowerCase();
    for (const cn of Object.keys(BLEND_MODES) as BlendModeKey[]) {
        if (String(BLEND_MODES[cn]).toLowerCase() === want) return cn;
    }
    return '';
}

/** 中文名 → PS 枚举值（面板写描述符用；查不到返回 `'normal'`，与既有兜底一致）。 */
export function blendModeValue(cn: string | null | undefined): string {
    if (cn && Object.prototype.hasOwnProperty.call(BLEND_MODES, cn)) {
        return BLEND_MODES[cn as BlendModeKey];
    }
    return BLEND_MODES['正常'];
}