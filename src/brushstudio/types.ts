/**
 * 第三入口「特制笔刷」的数据类型。
 *
 * 设计原则（对齐 docs/brush-panel-plan-2026-10-20.md §3）：
 *   1. 一支笔 = 一个目录（brush.json + tip.png + preview.png），代码里零硬编码；
 *   2. 字段名用**语义**（diameter / spacing / pressure），不直接写 PS 内部键名 ——
 *      内部键名随 PS 大版本变，语义不变，映射表收在 psBrush.ts 一处；
 *   3. engineVersion 用于将来迁移：解释器升级时按版本号决定怎么读老数据。
 */

/** 带压力控制的标量参数（尺寸 / 不透明度 / 流量） */
export interface PressureValue {
    /** 基准值：diameter 为像素，其余为 0~1 比例 */
    base: number;
    /** 是否受笔压控制 */
    pressure: boolean;
    /** 压感最小时的剩余比例（0~1），对应 PS 的「最小直径/最小不透明度」 */
    min: number;
}

export interface BrushParams {
    diameter: PressureValue;
    /** 笔尖间距，0~1（相对直径的比例，0.1 = 10%） */
    spacing: number;
    /** 笔尖角度（度） */
    angle: number;
    /** 圆度 0~1 */
    roundness: number;
    /** 笔尖是否跟随运笔方向旋转（PS 侧对应「角度动力学·方向」） */
    angleFollowsDirection: boolean;
    opacity: PressureValue;
    flow: PressureValue;
    scatter: {
        on: boolean;
        /** 散布幅度 0~1（相对直径） */
        amount: number;
        bothAxes: boolean;
        pressure: boolean;
    };
    /**
     * 纹理。第一版**只记录不应用**：PS 的纹理画笔要先把图案装进图案库再引用，
     * 键名也需要真机校准（见计划书 §4.2）。apply=false 时应用链路会跳过这一项。
     */
    texture: {
        apply: boolean;
        src: string;
        patternName: string;
        brightness: number;
        contrast: number;
    };
}

export interface BrushDef {
    id: string;
    index: number;
    name: string;
    category: string;
    /** 相对本笔目录的笔尖文件名（灰度遮罩：黑=不透明） */
    tip: string;
    /**
     * 相对本笔目录的**亮度图案**文件名（P3 方案 A，供 PS 画笔「纹理」通道使用）。
     * ⛔ 与 `tip` 是两个不同通道：tip 走 alpha（形状/透明），pattern 走亮度（凸凹）。
     *    Krita 的图像笔尖本来就是双通道，PS 只有一条 ⇒ 用纹理补第二条。
     * ⚠️ 尚未接入主链：PS 纹理是否影响**颜色**（而不仅透明度）需真机验证。
     */
    pattern?: string;
    /**
     * 相对本笔目录的**凹槽**笔尖文件名（P3 方案 B，= `tip` 反相）。
     *
     * 两支笔尖互为补集：`tip` 把「凸起」涂实，`shade` 把「凹槽」涂实。
     * 用途是「阴影 + 高光」两次描边：先拿 shade 配深色铺一层暗部，
     * 再拿 tip 配亮色盖一层高光，两层一叠才有立体。
     * ⚠️ 目前**没有接进主链**：两次描边要用户手画两遍，体验代价太大。
     *    浮雕的图层方案（斜面和浮雕）已被用户否决 —— 那样在图层蒙版上画不出同样效果。
     *    shade 留给「多遍描边」这条唯一不依赖图层结构的路线。
     */
    shade?: string;
    /**
     * **混合器画笔（储层）路线**的开关与参数（2026-10-22 定案）。
     *
     * 有这个字段 = 点这支笔**不走** `defineBrush + cto 缓存` 那条链，
     * 而是：切混合器 → 把方形笔刷直径设成图案长边 → 建同样大小的临时文档
     * → 铺上按前景色上过色的图案 → 合成 Alt+左键把图案吸进储层。
     * 详见 `psMixer.ts` 的 `reloadReservoir`。
     *
     * ⛔ 为什么不能用普通画笔：PS 里只有混合器能**一笔画出多个亮度**
     *    （储层是一张位图，落笔时按位置取色），普通画笔的笔尖只有一条 alpha。
     */
    mixer?: {
        /** 图案文件名（相对本笔目录）。灰度 `PAT-*` 或已带透明底的 `MIX-*` 都吃 */
        pattern: string;
        /** 强制方形边长；不写就取图案的**长边**（178×400 ⇒ 400） */
        side?: number;
    };
    /**
     * **运行时**算出来的混合器方形边长 = 图案的长边（178×400 ⇒ 400）。
     *
     * ⛔ 只由 `library.ts` 装载时解析 PNG 头部填入，**不写进 brush.json**：
     *    图案换尺寸时必须自动跟着变，写死就成了第二个真相。
     * 面板显示尺寸只认这个字段（混合器笔的 `params.diameter.base` 是作废值，
     * 真实直径每次装储层都会被改成它）。
     */
    mixerSize?: number;
    /** 笔尖在画布上的基准直径（px），由原设定的尺寸换算而来 */
    tipSize: number;
    params: BrushParams;
    source?: { preset: string; tipFile: string };
    engineVersion: number;
}

export interface LibraryEntry {
    id: string;
    name: string;
    category: string;
}

export interface BrushLibrary {
    version: number;
    categories: string[];
    brushes: LibraryEntry[];
}

/** 应用链路的一步一报，面板底部直接显示 */
export interface ApplyStep {
    name: string;
    ok: boolean;
    msg?: string;
    /** 非致命失败：显示**黄点**而不是红点（例：工具不透明度待校准，笔刷本体已生效） */
    warn?: boolean;
}
