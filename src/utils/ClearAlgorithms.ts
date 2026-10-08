/**
 * 清除模式统一算法内核（2026-10-08 重构收口）。
 *
 * ============================ 为什么需要这个文件 ============================
 * 重构前「清除」在代码里存在**三套互不相干的数学模型**，同一个用户操作
 * （开清除、选一个内容、画一个选区）在不同目标上给出不同结果，且没有一处
 * 能回答「减法到底是什么公式」：
 *
 *   目标           重构前公式                              问题
 *   -------------  --------------------------------------  ------------------------------
 *   快速蒙版       M − F×O_eff                             与图层蒙版重复实现
 *   图层蒙版       M − F×O_eff（另有一份带 alpha 的副本）  同一公式两份代码，已发生漂移
 *   单一通道       M × (1 − F/255×O_eff)                   与蒙版口径相反，用户无从预期
 *   普通像素图层   clearEnum / putSelection+delete         交给宿主，JS 侧无公式
 *   背景图层       纯色走 levels 提亮；图案/渐变走 delete   同一目标两套语义
 *
 * ============================ 重构后的三类 ============================
 * 按**目标的物理性质**分三类，每类一个公式族；「内容」（纯色/图案/渐变/描边）
 * 只负责提供 0–255 的灰度 F 与自身透明度 α，不再影响公式形态：
 *
 *   第一类 · 背景图层（无透明度，只能改颜色）
 *       趋白 whiten   C' = C + (255 − C) × (F/255) × t
 *       减法 subtract C' = C − F × t
 *       乘法 multiply C' = C × (1 − F/255 × t)
 *
 *   第二类 · 黑白通道（快速蒙版 / 图层蒙版 / 单一通道）
 *       减法 subtract X' = X − F × t
 *       乘法 multiply X' = X × (1 − F/255 × t)
 *
 *   第三类 · 普通像素图层（降低不透明度）
 *       减法 subtract A' = A − F × t
 *       乘法 multiply A' = A × (1 − F/255 × t)
 *       ⚠️ 第二、三类是**同一个数学形式**（对 0–255 的一维标量做减法或按比例衰减），
 *          区别只在被写回的字段：通道写成灰度，像素层写进 alpha 通道。
 *
 * ============================ 统一不变量 ============================
 * 「输入越白，删除越多」——F = 255 表示 100% 删除，F = 0 表示完全不删除。
 * 这是清除模式对用户的唯一承诺，三类目标的六个公式全部满足：
 *   · subtract: F→255 时减去量最大；
 *   · multiply: F→255 时余量最小；
 *   · whiten  : F→255 时越接近纯白（背景图层的「橡皮擦」语义）。
 *
 * ============================ 有效强度 t ============================
 *   t = (面板不透明度/100) × (内容自身透明度 α/255) × (选区羽化系数 K)
 * 三者相乘，任一为 0 时 t = 0 ⇒ 该像素保持原值不变。这条同时实现了两个边界要求：
 *   · 图案/渐变的透明区（α = 0）保持目标像素不变，不参与清除；
 *   · 羽化边缘按系数渐变，而不是硬切。
 *
 * ⚠️ 重构前此处是 `Math.round(opacity × α / 255)`（把 0–100 的百分比先四舍五入成
 *    整数再除 100），实测在半透明边缘会产生 ±0.5% 的台阶。现在改为全程浮点、
 *    只在写回时取整一次 —— 公式更纯粹，也消除了「亚像素台阶」这一视觉噪声。
 */

/** 黑白通道 / 普通像素图层不透明度的清除算法 */
export type BinaryClearAlgorithm = 'subtract' | 'multiply';

/** 背景图层（无透明度目标）的清除算法 */
export type BackgroundClearAlgorithm = 'whiten' | 'subtract' | 'multiply';

/** 目标类别 —— 决定走哪一族公式与哪一条写回通道 */
export type ClearTargetKind = 'background' | 'channel' | 'layer';

function clampByte(value: number): number {
    return value < 0 ? 0 : (value > 255 ? 255 : Math.round(value));
}

function clamp01(value: number): number {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
}

/**
 * 有效清除强度 t（0–1）。三个乘数分别来自：面板不透明度、内容自身透明度、选区羽化系数。
 *
 * @param opacityPercent 面板不透明度（0–100）
 * @param contentAlpha   内容自身透明度（0–255）。不传视为完全不透明
 * @param featherCoeff   选区羽化系数（0–1）。不传视为无羽化
 */
export function clearStrength(
    opacityPercent: number,
    contentAlpha?: number,
    featherCoeff?: number
): number {
    const o = clamp01((Number.isFinite(opacityPercent) ? opacityPercent : 100) / 100);
    const a = contentAlpha === undefined ? 1 : clamp01(contentAlpha / 255);
    const k = featherCoeff === undefined ? 1 : clamp01(featherCoeff);
    return o * a * k;
}

/**
 * 一维灰度标量的清除（黑白通道的灰度值 / 普通像素图层的 alpha 值共用）。
 *
 * @param base 目标原始值（0–255）
 * @param fill 输入内容灰度（0–255）：越白删除越多
 * @param t    有效强度（0–1），见 clearStrength
 */
export function clearScalarValue(
    base: number,
    fill: number,
    t: number,
    algo: BinaryClearAlgorithm
): number {
    if (t <= 0) return clampByte(base);
    const f = clamp01(fill / 255);
    if (algo === 'multiply') return clampByte(base * (1 - f * t));
    return clampByte(base - fill * t);
}

/** 第二类 · 黑白通道（快速蒙版 / 图层蒙版 / 单一通道） */
export function clearChannelValue(
    base: number,
    fill: number,
    t: number,
    algo: BinaryClearAlgorithm
): number {
    return clearScalarValue(base, fill, t, algo);
}

/** 第三类 · 普通像素图层：按输入灰度降低不透明度 */
export function clearAlphaValue(
    baseAlpha: number,
    fill: number,
    t: number,
    algo: BinaryClearAlgorithm
): number {
    return clearScalarValue(baseAlpha, fill, t, algo);
}

/**
 * 第一类 · 背景图层的单个颜色分量。
 * 背景图层没有透明度通道，清除只能体现为「颜色向某个方向移动」：
 *   whiten   → 向白提亮（模拟「背景色为白时的橡皮擦」）
 *   subtract → 向黑方向做绝对减法
 *   multiply → 向黑方向做按比例衰减
 */
export function clearBackgroundColor(
    base: number,
    fill: number,
    t: number,
    algo: BackgroundClearAlgorithm
): number {
    if (t <= 0) return clampByte(base);
    const f = clamp01(fill / 255);
    if (algo === 'whiten') return clampByte(base + (255 - base) * f * t);
    if (algo === 'multiply') return clampByte(base * (1 - f * t));
    return clampByte(base - fill * t);
}

/**
 * 描边在各类目标上应使用的「混合模式 + 描边色处理」方案。
 *
 * 为什么需要反相：PS 的 `multiply`（正片叠底）是 `C × S/255` —— **S 越暗压得越狠**，
 * 与「输入越白删除越多」正好相反。而本项目的乘法语义是 `C × (1 − F/255 × t)`。
 * 要把后者表达成 multiply，需要上层颜色 S 满足 `S/255 = 1 − F/255 × t`；
 * 在不透明度为 100% 时即 `S = 255 − F`——也就是**反相后的描边色**。
 * 因此在乘法分支下把描边色反相后再交给 PS，两种口径即在数学上严格一致。
 *
 * ⚠️ 该反相只发生在**通道 / 背景图层**这类「颜色即灰度」的上下文；
 *    RGB 通道上的描边色会被换成反相色，但结果灰度正是用户期望的删除强度。
 */
export interface StrokeBlendPlan {
    blendMode: string;
    invertColor: boolean;
}

export function planStrokeBlend(
    kind: ClearTargetKind,
    algo: BackgroundClearAlgorithm | BinaryClearAlgorithm
): StrokeBlendPlan {
    if (kind === 'layer') {
        return { blendMode: 'clearEnum', invertColor: false };
    }
    if (algo === 'whiten') {
        return { blendMode: 'screen', invertColor: false };
    }
    if (algo === 'multiply') {
        return { blendMode: 'multiply', invertColor: true };
    }
    return { blendMode: 'blendSubtraction', invertColor: false };
}

/** 描边色是否需要反相（供 StrokeSelection 计算实际下发的 RGB 值） */
export function invertRgb(color: { red: number; green: number; blue: number }) {
    return {
        red: 255 - (color.red || 0),
        green: 255 - (color.green || 0),
        blue: 255 - (color.blue || 0),
    };
}
