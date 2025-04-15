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
    isExpanded: false,
    createNewLayer: false,    // 添加初始值
    clearMode: false,    // 添加初始值
};