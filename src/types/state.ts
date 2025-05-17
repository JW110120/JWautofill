export interface ColorSettings {
    hueVariation: number;
    saturationVariation: number;
    brightnessVariation: number;
    opacityVariation: number;
}

export interface Pattern {
    id: string;
    name: string;
    preview: string;
    data?: ArrayBuffer;  // 添加图片数据字段
    angle?: number;      // 添加角度字段
    scale?: number;      // 添加缩放字段
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
    presets?: {
        preview: string;
        type: 'linear' | 'radial';
        angle?: number;
        reverse?: boolean;
        stops: GradientStop[];
    }[];
}

export interface Stroke {
    isStrokePanelOpen: boolean;
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
    fillMode: 'foreground' | 'pattern' | 'gradient';
    colorSettings: ColorSettings;
    selectedPattern: Pattern | null;
    selectedGradient: Gradient | null;
    isColorSettingsOpen: boolean;
    isPatternPickerOpen: boolean;
    isGradientPickerOpen: boolean;
    strokeEnabled: boolean;
    strokeWidth: number;
    strokeColor: {
        red: number;
        green: number;
        blue: number;
    };
    isStrokeSettingsOpen: boolean;  // 添加描边设置面板状态
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
    fillMode: 'foreground',
    colorSettings: {
        hueVariation: 0,
        saturationVariation: 0,
        brightnessVariation: 0,
        opacityVariation: 0,
    },
    selectedPattern: null,
    selectedGradient: null,
    isColorSettingsOpen: false,
    isPatternPickerOpen: false,
    isGradientPickerOpen: false,
    strokeEnabled: false,
    strokeWidth: 2,  // 默认宽度2px
    strokePosition: 'center',  // 默认位置居中
    strokeBlendMode: '正常',  // 默认混合模式
    strokeOpacity: 100,  // 默认不透明度100%
    strokeColor: {
        red: 0,
        green: 0,
        blue: 0
    },
    isStrokeSettingsOpen: false,  // 确保初始为false
};