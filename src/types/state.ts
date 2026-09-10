export interface ColorSettings {
    hueVariation: number;
    saturationVariation: number;
    brightnessVariation: number;
    opacityVariation: number;
    grayVariation?: number; // 灰度抖动，用于快速蒙版模式
}

export interface Pattern {
    id: string;
    name: string;
    preview: string;
    data?: ArrayBuffer;
    angle?: number;
    scale?: number;
    preserveTransparency?: boolean;
    fillMode?: 'stamp' | 'tile';     // 填充模式：盖图章或贴墙纸
    rotateAll?: boolean; // 全部旋转选项，仅在重复模式下有效
    // RGB/RGBA数据相关属性
    patternRgbData?: Uint8Array;     // 原始RGB/RGBA像素数据
    patternComponents?: number;      // 组件数（3=RGB, 4=RGBA）
    components?: number;             // 组件数（兼容性字段）
    hasAlpha?: boolean;              // 是否包含透明度信息
    // 灰度数据相关属性
    grayData?: Uint8Array;           // 当前变换后的灰度数据
    originalGrayData?: Uint8Array;   // 原始灰度数据（用于重新计算变换）
    width?: number;                  // 当前图案宽度
    height?: number;                 // 当前图案高度
    originalWidth?: number;          // 原始图案宽度
    originalHeight?: number;         // 原始图案高度
    currentScale?: number;           // 当前缩放比例
    currentAngle?: number;           // 当前旋转角度
    file?: any;                      // UXP文件引用
}

export interface GradientStop {
    color: string;
    position: number;
    // 扩展属性，用于支持独立的颜色和透明度位置以及中点
    colorPosition?: number;
    opacityPosition?: number;
    midpoint?: number;
}

export interface Gradient {
    type: 'linear' | 'radial';
    angle?: number;
    reverse?: boolean;
    stops: GradientStop[];
    preserveTransparency?: boolean; // 添加新的属性
    presets?: {
        preview: string;
        type: 'linear' | 'radial';
        angle?: number;
        reverse?: boolean;
        stops: GradientStop[];
    }[];
}

export interface Stroke {
    strokeWidth: number;
    strokePosition: 'inside' | 'center' | 'outside';
    strokeBlendMode: string;
    strokeOpacity: number;
  }


/**
 * 紧凑模式作用域：选区填充父面板 + 4 个子面板（纯色/图案/渐变/描边）。
 * 5 个作用域各自一个开关、互不干扰——父面板开启不会连带隐藏子面板的 divider，反之亦然。
 * 菜单项文案随「当前面板 + 该面板自身状态」变化，见 app.tsx 的 currentCompactScope。
 */
export type CompactScope = 'app' | 'color' | 'pattern' | 'gradient' | 'stroke';
export type CompactModes = Record<CompactScope, boolean>;

export const initialCompactModes: CompactModes = {
    app: false,
    color: false,
    pattern: false,
    gradient: false,
    stroke: false,
};

export interface AppState {
    opacity: number;
    feather: number;
    blendMode: string;
    autoUpdateHistory: boolean;
    isEnabled: boolean;
    deselectAfterFill: boolean;
    switchToLassoOnEnable: boolean;  // 主开关：关闭→开启时自动切换为套索工具
    autoOffOnOtherTool: boolean;     // 主开关：开启时切到其它工具则自动关闭
    isDragging: boolean;
    dragStartX: number;
    dragStartValue: number;
    dragTarget: string | null;
    selectionType: string;
    isExpanded: boolean;
    createNewLayer: boolean;  // 添加新状态
    clearMode: boolean;  // 添加清除模式状态
    compactModes: CompactModes;  // 紧凑模式：按面板作用域分别记录（app=选区填充父面板，其余=4 个子面板）
    isInQuickMask: boolean;  // 添加快速蒙版状态
    fillMode: 'foreground' | 'pattern' | 'gradient';
    colorSettings: ColorSettings;
    selectedPattern: Pattern | null;
    selectedGradient: Gradient | null;
    isColorSettingsOpen: boolean;
    isPatternPickerOpen: boolean;
    isGradientPickerOpen: boolean;
    isStrokeSettingOpen: boolean;
    strokeEnabled: boolean;
    strokeColor: {
        red: number;
        green: number;
        blue: number;
    };
     // 新增选区改造状态
     isSelectionOptionsExpanded: boolean;
     selectionSmooth: number;
     selectionContrast: number;
     selectionExpand: number; // 改名为扩散
     // 分区可见性（隐藏/显示分区浮窗控制，默认皆可见）：选区改造 / 填充选项
     selectionOptionsVisible: boolean;
     fillOptionsVisible: boolean;
     showVisibilityPanel: boolean;  // 隐藏/显示分区浮窗是否打开
     // 许可证相关状态
     isLicensed: boolean;
     isTrial: boolean;
     isLicenseDialogOpen: boolean;
     trialDaysRemaining: number;
}

export const initialState: AppState = {
    opacity: 100,
    feather: 0,
    blendMode: '正常',
    autoUpdateHistory: true,
    isEnabled: true,
    deselectAfterFill: true,
    switchToLassoOnEnable: false,
    autoOffOnOtherTool: false,
    isDragging: false,
    dragStartX: 0,
    dragStartValue: 0,
    dragTarget: null,
    selectionType: 'normal',
    isExpanded: true,
    createNewLayer: false,    // 添加初始值
    clearMode: false,    // 添加初始值
    compactModes: { ...initialCompactModes },    // 紧凑模式默认全部关闭
    isInQuickMask: false,    // 添加快速蒙版初始值
    fillMode: 'foreground',
    colorSettings: {
        hueVariation: 0,
        saturationVariation: 0,
        brightnessVariation: 0,
        opacityVariation: 0,
        grayVariation: 0,
        calculationMode: 'absolute'
    },
    selectedPattern: null,
    selectedGradient: null,
    isColorSettingsOpen: false,
    isPatternPickerOpen: false,
    isGradientPickerOpen: false,
    isStrokeSettingOpen: false, 
    strokeEnabled: false,
    strokeWidth: 2,
    strokePosition: 'center',
    strokeBlendMode: '正常',
    strokeOpacity: 100,
    strokeColor: {
        red: 0,
        green: 0,
        blue: 0
    },
    isSelectionOptionsExpanded: true,
    selectionSmooth: 0, 
    selectionContrast: 0,
    selectionExpand: 0, // 改名为扩散
    // 分区可见性（默认皆可见）
    selectionOptionsVisible: true,
    fillOptionsVisible: true,
    showVisibilityPanel: false,
    // 新增：许可证默认状态
    isLicensed: false,
    isTrial: false,
    isLicenseDialogOpen: true,
    trialDaysRemaining: 0,
};
