/**
 * 行内滑块「拖拽标签」的灵敏度归一化（单一来源）
 *
 * 背景：原先每个滑块的 sensitivity 都是手写常量（0.05 ~ 1 不等），与量程无关，
 * 导致「鼠标横移多少 px 才能把滑块从 min 扫到 max」各处相差十几倍——
 * 短量程（如 sigma 1~5，40px 扫完）特别飘，长量程（如边缘阈值 0~255，510px）特别难拖。
 *
 * 归一化：把「扫完整个量程的行程」统一成常量，反过来算灵敏度。
 */

/**
 * 归一化参考行程：鼠标横移这么多 px = 滑块从 min 扫到 max。
 * 取 200 ≈ 250 宽面板里行内滑块轨道的实际可用宽度，
 * 即「拖标签」的行程与「直接拖滑块拇指」基本一致。
 */
export const DRAG_TRAVEL_PX = 200;

/**
 * 灵敏度 = 每 1px 鼠标位移对应的数值增量。
 *
 *   sensitivity = min(range / DRAG_TRAVEL_PX, step)
 *
 * - 主项 range / DRAG_TRAVEL_PX：任何量程扫完都是同一段行程，手感一致。
 * - 上限夹到 step：1px 最多走 1 步。clientX 是整数，若 1px 跨过 1 个 step，
 *   就会有可取值永远拖不到（例：0~255 用 1.275/px 会跳过约 21% 的整数）。
 *   代价是量程 > 200 的滑块行程退化为 range px（如 0~360 → 360px），
 *   这是保住「每个值都拖得到」的必要代价，仍远短于旧的手写值。
 */
export function calcDragSensitivity(min: number, max: number, step: number = 1): number {
    const range = Math.abs(max - min);
    const safeStep = step > 0 ? step : 1;
    if (!(range > 0)) return safeStep;
    return Math.min(range / DRAG_TRAVEL_PX, safeStep);
}

/**
 * 拖拽取值：起点值 + 横向位移 → 按归一化灵敏度换算，吸附到 step，再夹到 [min, max]。
 * 各面板的标签拖拽统一走这里，避免换算/吸附/夹取三件套在每处重复实现。
 */
export function calcDragValue(
    startValue: number,
    deltaX: number,
    min: number,
    max: number,
    step: number = 1
): number {
    const safeStep = step > 0 ? step : 1;
    const raw = startValue + deltaX * calcDragSensitivity(min, max, safeStep);
    const snapped = Math.round(raw / safeStep) * safeStep;
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.min(hi, Math.max(lo, Number(snapped.toFixed(4))));
}
