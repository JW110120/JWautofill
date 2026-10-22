/**
 * 混合器浮雕笔刷的**颜色算法**：把一张灰阶浮雕上色成「前景色 × 笔尖亮度」。
 *
 * ── 目标（对齐 Krita 的印章笔）──────────────────────────────────────
 *   Krita:  out_rgb = tip_luma × fg_color      （乘法）
 *           out_alpha = tip_alpha
 *   也就是：笔尖越亮的地方，画出来越接近前景色；越暗越接近黑。
 *
 * ── PS 里怎么做到乘法 ────────────────────────────────────────────────
 *   通道混合器（`channelMixer`）的每个输出通道是一条**线性式**：
 *
 *       out_ch = ( r% · src_R + g% · src_G + b% · src_B ) / 100 + constant / 100
 *
 *   （百分比单位 percentUnit，constant 也是百分比；结果按 0..1 裁切。）
 *
 *   我们的图案层是**灰度**的（R=G=B=v，v∈[0,1]），于是上式塌成：
 *
 *       out_ch = v · (r% + g% + b%) / 100 + constant/100
 *
 *   要让 out_ch = v · F_ch（F 为前景色，0..1），只需：
 *
 *       (r% + g% + b%) = F_ch · 100        ← 系数
 *       constant       = 0                 ← 常量
 *
 *   即：**红输出的红色系数 = 前景色的红分量**。干净、精确、无裁切。
 *
 * ── ⛔⛔ 为什么"只调常量"是错的（2026-10-22 用户初版方案）──────────────
 *   只给常量时 out_ch = v + c，是**加法**，不是乘法。后果：
 *
 *     · 亮部整片顶到 255 被裁切 ⇒ 高光里的笔丝细节全部消失（一片死红）
 *     · 暗部整片压到 0 被裁切   ⇒ 沟槽里的过渡变成硬边
 *     · 中间调被整体平移
 *   = 浮雕的"明暗层次"被两侧各切掉一块，只剩一条硬边 —— 立体感来源就没了。
 *
 *   所以：**上色用系数，常量只用来"抬黑位"**（把最暗处从纯黑抬到一点灰，
 *   让沟槽不至于死黑一片）。默认 0，需要时给 3~12。
 *
 * ── 什么时候用 ──────────────────────────────────────────────────────
 *   用户改前景色 → 对**图案母版副本**应用本模块产出的描述符 → 重新采样进混合器。
 *   全程只动 RGB，不动 alpha ⇒ 换色不改笔尖形状。
 */

/** 0..255 的 sRGB 三元组 */
export interface Rgb255 {
    r: number;
    g: number;
    b: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** percentUnit 描述符的薄封装（AM 里所有百分比都长这样） */
function pctUnit(value: number) {
    return { _unit: 'percentUnit', _value: Math.round(value * 10) / 10 };
}

/**
 * 一个输出通道的矩阵：三个源通道系数 + 常量。
 *
 * ⚠️ 三个源系数必须**显式写 0**，不能省略：通道混合器的默认值是"同通道 100%"，
 *    省略等于继承默认值 ⇒ 灰度源上会得到 v·(1 + 额外系数)，越调越亮。
 */
function matrix(self: number, constant: number) {
    return {
        _obj: 'channelMatrix',
        red: pctUnit(self),
        grain: pctUnit(0),
        blue: pctUnit(0),
        constant: pctUnit(constant)
    };
}

/** 绿通道输出在 AM 里叫 `grain`（charID `Grn`），不是 `green` —— 写错就静默不生效 */
function matrixG(self: number, constant: number) {
    return {
        _obj: 'channelMatrix',
        red: pctUnit(0),
        grain: pctUnit(self),
        blue: pctUnit(0),
        constant: pctUnit(constant)
    };
}

function matrixB(self: number, constant: number) {
    return {
        _obj: 'channelMatrix',
        red: pctUnit(0),
        grain: pctUnit(0),
        blue: pctUnit(self),
        constant: pctUnit(constant)
    };
}

export interface TintOptions {
    /**
     * 黑位抬升（百分比，可负）。
     * 0 = 精确乘算（Krita 行为）。给 3~12 能把沟槽从死黑抬成深灰，
     * 代价是最暗处不再是纯黑 —— 浮雕的"最深沟"会用颜色而不是黑来表现。
     */
    lift?: number;
}

/**
 * 生成"把灰阶浮雕上色成前景色"的通道混合器描述符。
 *
 * @param fg  前景色（0..255 sRGB）
 * @param opt lift 见上，默认 0
 *
 * 例：fg = (197, 42, 42)
 *   red  → self = 77.3, constant = 0
 *   grain→ self = 16.5, constant = 0
 *   blue → self = 16.5, constant = 0
 *   于是 out = v · (0.773, 0.165, 0.165) —— 半调红，亮度跟着笔尖走。
 */
export function channelMixerFor(fg: Rgb255, opt?: TintOptions): any {
    const lift = clamp(opt?.lift ?? 0, -100, 100);
    const r = clamp(fg.r, 0, 255) / 255 * 100;
    const g = clamp(fg.g, 0, 255) / 255 * 100;
    const b = clamp(fg.b, 0, 255) / 255 * 100;
    return {
        _obj: 'channelMixer',
        presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
        red: matrix(r, lift),
        grain: matrixG(g, lift),
        blue: matrixB(b, lift),
        _isCommand: false
    };
}

/**
 * 仅用常量的上色方式 —— **只用于对照实验，不要用于正式路径**。
 *
 * 存在的意义：让"为什么系数法更好"这件事可以在同一张图上肉眼 A/B。
 * 调用方式与 `channelMixerFor` 相同，判据看画面高光里是否还有笔丝。
 */
export function channelMixerByConstantOnly(fg: Rgb255): any {
    // 把目标色相对"中灰 0.5"的差距全部压进常量：out = v + (F - 0.5)
    const c = (v: number) => (clamp(v, 0, 255) / 255 - 0.5) * 100;
    const m = (self: number, constant: number) => ({
        _obj: 'channelMatrix',
        red: pctUnit(self),
        grain: pctUnit(0),
        blue: pctUnit(0),
        constant: pctUnit(constant)
    });
    return {
        _obj: 'channelMixer',
        presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
        red: m(100, c(fg.r)),
        grain: { ...m(100, c(fg.g)), red: pctUnit(0), grain: pctUnit(100) },
        blue: { ...m(100, c(fg.b)), red: pctUnit(0), grain: pctUnit(0), blue: pctUnit(100) },
        _isCommand: false
    };
}

/**
 * 浮雕滤镜（烘焙进图案母版，一支笔只做一次）。
 *
 * ⚠️ 必须开"锁定透明像素"再做：否则透明的方角也会被填成中灰，
 *    400×400 的方框就会跟着笔迹一起出现在画布上。
 * ⚠️ 顺序：先 emboss，紧接着 fade —— `fade` 只能作用于**上一条**滤镜。
 */
export function embossDesc(p?: { angle?: number; height?: number; amount?: number }): any {
    return {
        _obj: 'emboss',
        angle: p?.angle ?? 135,
        height: Math.max(1, Math.round(p?.height ?? 3)),
        amount: Math.max(1, Math.round(p?.amount ?? 100)),
        _isCommand: false
    };
}

/**
 * 渐隐（编辑 > 渐隐）。紧跟 emboss 之后，用叠加模式把浮雕"压"在原图上，
 * 得到"只加光影、不改颜色"的立体感。
 */
export function fadeDesc(p?: { opacity?: number; mode?: string }): any {
    return {
        _obj: 'fade',
        opacity: pctUnit(clamp(p?.opacity ?? 60, 0, 100)),
        mode: { _enum: 'blendMode', _value: p?.mode ?? 'overlay' },
        _isCommand: false
    };
}

/**
 * 完整着色链（一次前景色变更要发的命令）。
 *
 * ⚠️ 不动 emboss：浮雕已经烘焙在母版里了。每次换色只重发这一条，
 *    既省时间，也避免反复 emboss 把细节越磨越平。
 */
export function tintChain(fg: Rgb255, opt?: TintOptions): any[] {
    return [channelMixerFor(fg, opt)];
}

/**
 * 自检：按 PS 的公式预测某个亮度值上色后的输出。
 *
 * 用途不是给用户看，是给"算法改坏了"设一道闸 —— 见 `assertTintMath()`。
 */
export function predictChannel(v: number, coeffPct: number, constantPct: number): number {
    const out = (v * coeffPct) / 100 + constantPct / 100;
    return clamp(out, 0, 1);
}

/**
 * 断言「k×v + 0」这条式子在关键点上与 Krita 的乘法一致。
 * 六个采样点：纯黑、1/4、半、3/4、纯白、以及一个真实的沟槽值 0.375。
 * 容差 1/255（8 位量化误差）。
 */
export function assertTintMath(fg: Rgb255 = { r: 197, g: 42, b: 42 }): string[] {
    const fails: string[] = [];
    const coeff = [fg.r / 255 * 100, fg.g / 255 * 100, fg.b / 255 * 100];
    const out = (v: number, i: number) => predictChannel(v, coeff[i], 0);
    const want = (v: number, i: number) => v * ([fg.r, fg.g, fg.b][i] / 255);
    for (const v of [0, 0.25, 0.5, 0.75, 1, 0.375]) {
        for (let i = 0; i < 3; i++) {
            // 系数在描述符里被量化到 0.1% ⇒ 预测值允许 0.001 的偏差
            if (Math.abs(out(v, i) - want(v, i)) > 0.001 + 1 / 255) {
                fails.push(`v=${v} ch=${i} 期望 ${want(v, i).toFixed(4)} 实得 ${out(v, i).toFixed(4)}`);
            }
        }
    }
    return fails;
}
