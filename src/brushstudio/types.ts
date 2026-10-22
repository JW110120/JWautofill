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
    /** 相对本笔目录的笔尖文件名 */
    tip: string;
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
