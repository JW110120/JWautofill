export interface ColorSettings {
    hueVariation: number;
    saturationVariation: number;
    brightnessVariation: number;
    opacityVariation: number;
    pressureVariation: number;
}

export interface Pattern {
    id: string;
    name: string;
    preview: string;
}

export interface GradientStop {
    color: string;
    position: number;
}

export interface Gradient {
    type: 'linear' | 'radial';
    angle?: number;
    stops: GradientStop[];
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
        pressureVariation: 0
    },
    selectedPattern: null,
    selectedGradient: null,
    isColorSettingsOpen: false,
    isPatternPickerOpen: false,
    isGradientPickerOpen: false
};