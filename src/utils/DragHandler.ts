import { calcDragValue } from './dragSensitivity';

interface DragConfig {
    min: number;
    max: number;
    /** 吸附步长，默认 1（须与 UI 上 RangeSlider 的 step 一致） */
    step?: number;
}

export class DragHandler {
    /**
     * 只声明量程与步长，灵敏度由 calcDragValue 按量程归一化，
     * 与 AdjustmentPanel / 纯色 / 图案 / 渐变面板共用同一套手感。
     */
    private static configs: Record<string, DragConfig> = {
        opacity: {
            min: 0,
            max: 100,
            step: 1
        },
        // ⚠️ 上限必须与 UI 滑块一致（0~20, step 0.5）；旧值 10 会把拖拽值卡死在 10
        feather: {
            min: 0,
            max: 20,
            step: 0.5
        },
        selectionContrast: {
            min: 0,
            max: 100,
            step: 1
        },
        // 扩散：0~100，与「锐度」同为选区改造的百分比滑块
        selectionExpand: {
            min: 0,
            max: 100,
            step: 1
        },
        selectionShiftEdge: {
            min: -100,
            max: 100,
            step: 1
        },
        // ===== 套索实时平滑 =====
        // 键名一律带 `smooth:` 前缀：这些值嵌在 state.smoothParams 里，
        // 无法用 `{ [target]: v }` 的展开式写法直接写回 ⇒ app.tsx 的 handleLabelMouseDown /
        // handleMouseMove 按前缀分岔。前缀口径两处必须一致。
        'smooth:strength': { min: 0, max: 100, step: 1 },
        // ⛔ 上限必须与 SMOOTH_RADIUS_MAX / 原生 RADIUS_PX_MAX 一致：这里曾是 40，
        //    在半径上限抬到 100 之后被漏改 ⇒ 拖标签最多只能拖到 40（滑杆却能到 100）。
        'smooth:radius': { min: 1, max: 100, step: 1 },
        'smooth:catchUp': { min: 0, max: 100, step: 1 },
        'smooth:cornerAngle': { min: 0, max: 90, step: 1 }
    };

    static calculateNewValue(
        dragTarget: string,
        startValue: number,
        startX: number,
        currentX: number
    ): number {
        const config = this.configs[dragTarget];
        if (!config) return startValue;

        return calcDragValue(
            startValue,
            currentX - startX,
            config.min,
            config.max,
            config.step ?? 1
        );
    }
}
