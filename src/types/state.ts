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


export interface AppState {
    opacity: number;
    feather: number;
    blendMode: string;
    autoUpdateHistory: boolean;
    isEnabled: boolean;
    deselectAfterFill: boolean;
    isDragging: boolean;
    dragStartX: number;
    dragStartValue: number;
    dragTarget: string | null;
    selectionType: string;
    isExpanded: boolean;
    createNewLayer: boolean;  // 添加新状态
    clearMode: boolean;  // 添加清除模式状态
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
     // 新增选区选项状态
     isSelectionOptionsExpanded: boolean;
     selectionSmooth: number;
     selectionContrast: number;
     selectionShiftEdge: number;
}

export const initialState: AppState = {
    opacity: 100,
    feather: 0,
    blendMode: '正常',
    autoUpdateHistory: true,
    isEnabled: true,
    deselectAfterFill: true,
    isDragging: false,
    dragStartX: 0,
    dragStartValue: 0,
    dragTarget: null,
    selectionType: 'normal',
    isExpanded: true,
    createNewLayer: false,    // 添加初始值
    clearMode: false,    // 添加初始值
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
    selectionShiftEdge: 0,
};
