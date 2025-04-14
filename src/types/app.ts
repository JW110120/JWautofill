export interface AppProps {
    // 目前没有props，但为了未来扩展预留
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
    isExpanded: true
};