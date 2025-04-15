interface BlendModeOption {
    value: string;
    label: string;
    disabled?: boolean;
    isDivider?: boolean;
}

export const BLEND_MODE_OPTIONS: BlendModeOption[][] = [
    [
        { value: '正常', label: '正常' },
        { value: '溶解', label: '溶解' },
        { value: '背后', label: '背后' },  // 添加背后模式
    ],
    [
        { value: '变暗', label: '变暗' },
        { value: '正片叠底', label: '正片叠底' },
        { value: '颜色加深', label: '颜色加深' },
        { value: '线性加深', label: '线性加深' },
        { value: '深色', label: '深色' },
    ],
    [
        { value: '变亮', label: '变亮' },
        { value: '滤色', label: '滤色' },
        { value: '颜色减淡', label: '颜色减淡' },
        { value: '线性减淡', label: '线性减淡' },
        { value: '浅色', label: '浅色' },
    ],
    [
        { value: '叠加', label: '叠加' },
        { value: '柔光', label: '柔光' },
        { value: '强光', label: '强光' },
        { value: '亮光', label: '亮光' },
        { value: '线性光', label: '线性光' },
        { value: '点光', label: '点光' },
        { value: '实色混合', label: '实色混合' },
    ],
    [
        { value: '差值', label: '差值' },
        { value: '排除', label: '排除' },
        { value: '减去', label: '减去' },
        { value: '划分', label: '划分' }, 
    ],
    [
        { value: '色相', label: '色相' },
        { value: '饱和度', label: '饱和度' },
        { value: '颜色', label: '颜色' },
        { value: '明度', label: '明度' },
    ],
];