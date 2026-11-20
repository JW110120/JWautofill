/**
 * 笔刷大小预设 —— Shift+[ / Shift+] 按「档位」立刻改笔尖直径（2026-11-20 新增）
 *
 * ================================================================ 用户口径
 *   「APP 面板自定义快捷键新增一个【笔刷大小预设】开关；开启后，凡是当前工具为
 *     笔刷、混合器、涂抹、橡皮、历史记录画笔…等**能改笔尖大小**的工具时，
 *     Shift+[ 立刻减小、Shift+] 立刻增大，步长比 PS 原生的 [ / ] 大得多。
 *     档位按用途分三档：最小档画线、中间档铺块面、最大档涂背景。
 *     以 A4 文档为基准是 4 / 50 / 100 px；最小缩放系数下 2 / 25 / 50；
 *     最大缩放系数下 16 / 200 / 400；横向/竖向文档不作区分 ⇒ 用**像素数**算系数。」
 *
 * 一句话比喻：这功能就是「笔尖的三档变速箱」。PS 原生的 [ / ] 是连续微调（一档一档
 *   挪 1px），这里换成三个固定的「停车位」——按一下就整支笔跳到上一个/下一个车位，
 *   画线、铺块面、刷背景三种活各有一个不假思索的尺寸。
 *
 * ================================================================ 档位怎么算
 *   基准锚点（用户给定，三个都必须**精确命中**）：
 *     A4 @300ppi = 2480×3508 ≈ 8.70 Mpx  ⇒ 系数 1.0  ⇒ 4 / 50 / 100 px
 *     系数下限 0.5（1 Mpx 及以下）      ⇒ 2 / 25 / 50 px
 *     系数上限 4.0（40 Mpx 及以上）      ⇒ 16 / 200 / 400 px
 *   三段式对数插值（**不用一条直线**：一条直线过不了 A4 这个锚点 ——
 *   0.5→4 摊在 1Mpx→40Mpx 上时，8.7Mpx 处只能落到 ≈1.7，A4 就不是 4/50/100 了）。
 *   对数而不是线性：画布面积翻倍时，「感觉上同一支笔」需要放大 √2 倍，
 *   所以系数按 2 的幂次插值，最大/最小档位之间的视觉跨度才均匀。
 *
 * ================================================================ 为什么改直径要这么绕
 *   ⛔ `set brush to {直径}` 会让 PS 把当前笔**整体换成 computedBrush**
 *      —— 直径对了，毛刷笔尖变成一支软边圆珠笔（本仓 2026-10-22 两次真机铁证，
 *      见 brushstudio/psBrush.ts 的 brushCopy / setBrushGeometry 注释）。
 *   ⇒ 唯一安全的写法与 `setToolOpacity` 同一套路：
 *      读整份 `currentToolOptions` → **只覆盖 brush.diameter** → 整份 set 回当前工具
 *      → 回读校验（直径到位 **且** sampledData 没变）才算成功。
 *   三种 set 形态按「验证通过」的顺序记在 `applyForm` 里，下一次直接用它。
 *
 * ================================================================ 两个面板会同时收到热键
 *   .8li 把热键广播给**所有** UXP 客户端（#app 与 #pixeladjustment 各一条 WS），
 *   同一次按键会在两个 JS 上下文里各跑一遍 `handleHotkey`。「跳两档」就是这么来的。
 *   两道闸一起用（单用哪一道都有缝）：
 *     ① `brush-size-step.lock`：用 `createFile(..., {overwrite:false})` 的**创建即独占**
 *        当互斥量，抢到的那个上下文才动手；退出时删锁；1.5s 没删视为残留可抢占。
 *     ② 状态文件里的 `token`：token 来自原生广播的 `seq`（一次命中一个号），
 *        后到的那个即便抢到了锁，也只会把**同一个目标档位**再写一遍（幂等，不会跳两档）。
 *   ⛔ 绝不用「当前直径 +1 档」这种纯自增判据：两个上下文一前一后读到「已改过的直径」
 *      就会连跳两次 —— 必须让目标档位由 token 固定下来。
 *
 * ================================================================ 日志
 *   走 SmDebug（debug/special-mask.log），每步记「判据 + 返回值 + 回读值」。
 *   命中但没反应时读日志即可定位：是工具不在名单、还是锁被抢、还是 PS 拒绝了 set。
 */

import { action, app } from 'photoshop';
import { storage } from 'uxp';
import { smLog, smLogSession } from './SmDebug';
import { psRead, runAsModal } from './psAccess';

/* ================================================================ 档位换算 */

/** A4 @300ppi 的像素数：用户指定的「基准文档」。 */
export const A4_PIXELS = 2480 * 3508;
/** 系数下限（0.5×）对应的文档像素数：1000×1000 及以下都按 0.5× 算。 */
export const MIN_SCALE_PIXELS = 1000 * 1000;
/** 系数上限（4×）对应的文档像素数：8000×5000 及以上都按 4× 算。 */
export const MAX_SCALE_PIXELS = 8000 * 5000;
/** 基准档位（A4、系数 1.0）：小/中/大。 */
export const BASE_TIERS: readonly number[] = [4, 50, 100];
/** 系数区间（用户给定）。 */
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 4;

const LOG2 = Math.LN2;

/**
 * 文档像素数 → 缩放系数（0.5 … 4）。
 *
 * 三段：
 *   ≤1 Mpx  ⇒ 0.5（钳住）
 *   1 Mpx … A4（含）⇒ 0.5 → 1.0 对数插值
 *   A4 … ≥40 Mpx   ⇒ 1.0 → 4.0 对数插值
 *   ≥40 Mpx ⇒ 4.0（钳住）
 */
export function scaleForPixels(pixels: number): number {
    const px = Math.max(1, Number(pixels) || 0);
    if (px <= MIN_SCALE_PIXELS) return SCALE_MIN;
    if (px >= MAX_SCALE_PIXELS) return SCALE_MAX;
    if (px <= A4_PIXELS) {
        const t = Math.log(px / MIN_SCALE_PIXELS) / LOG2;
        const span = Math.log(A4_PIXELS / MIN_SCALE_PIXELS) / LOG2;
        return SCALE_MIN * Math.pow(2, span > 0 ? t / span : 0);
    }
    const t = Math.log(px / A4_PIXELS) / LOG2;
    const span = Math.log(MAX_SCALE_PIXELS / A4_PIXELS) / LOG2;
    return Math.pow(2, span > 0 ? 2 * (t / span) : 0);
}

/** 像素数 → 三档直径（px，整数，最小 1）。 */
export function tierValuesForPixels(pixels: number): number[] {
    const k = scaleForPixels(pixels);
    return BASE_TIERS.map((v) => Math.max(1, Math.round(v * k)));
}

/** 文档宽高（px）→ 三档直径。⛔ 横向/竖向不作区分：只看像素数。 */
export function tierValuesForDoc(width: number, height: number): number[] {
    return tierValuesForPixels(Math.max(1, width) * Math.max(1, height));
}

/** 当前文档的三档直径；没有打开文档 / 读不到尺寸时返回 null（不抛）。 */
export function activeDocTiers(): number[] | null {
    try {
        const doc: any = (app as any).activeDocument;
        if (!doc) return null;
        const w = Number(doc.width);
        const h = Number(doc.height);
        if (!(w > 0) || !(h > 0)) return null;
        return tierValuesForDoc(w, h);
    } catch {
        return null;
    }
}

/** 给面板提示用的一行文案（「4 / 50 / 100 px」）；无文档返回 null。 */
export function describeActiveDocTiers(): string | null {
    const t = activeDocTiers();
    return t ? t.join(' / ') + ' px' : null;
}

/* ================================================================ 工具名单 */

/**
 * 自带笔尖、能用 [ / ] 改笔尖大小的工具（PS 内部工具 ID，驼峰）。
 *
 * ⛔ 命名口径与 blendGuard.ts 一致：除第一个词外每个词首字母大写 ——
 *   历史记录艺术画笔是 `artBrushTool`（**不是** artHistoryBrushTool，后者 PS 里根本不存在）。
 * ⛔ 刻意**不含**快速选择 / 修补 / 红眼 / 魔棒 / **魔术橡皮擦**：它们的「大小」
 *    不是笔尖直径（魔术橡皮擦只有容差、根本没有笔尖），写进来只会变成
 *    「按了没反应」的死条目。
 * ⚠️ 名单外的工具按 Shift+[ 什么也不做（键仍被插件吞掉）—— 这是刻意的：
 *    宁可无动作，也不要在套索/移动工具上悄悄改掉画笔的尺寸。
 */
export const BRUSH_SIZE_TOOLS: readonly string[] = [
    'paintbrushTool',              // 画笔
    'pencilTool',                  // 铅笔
    'eraserTool',                  // 橡皮擦
    'backgroundEraserTool',        // 背景橡皮擦
    'wetBrushTool',                // 混合器画笔（PS 内部名）
    'mixerBrushTool',              // 混合器画笔（同义兜底，个别版本用它）
    'smudgeTool',                  // 涂抹
    'blurTool',                    // 模糊
    'sharpenTool',                 // 锐化
    'dodgeTool',                   // 减淡
    'burnTool',                    // 加深
    'spongeTool',                  // 海绵
    'cloneStampTool',              // 仿制图章
    'patternStampTool',            // 图案图章
    'historyBrushTool',            // 历史记录画笔
    'artBrushTool',                // 历史记录艺术画笔
    'colorReplacementBrushTool',   // 颜色替换画笔
    'spotHealingBrushTool',        // 污点修复画笔
    'healingBrushTool',            // 修复画笔
];

const BRUSH_SIZE_SET = (() => {
    const s: Record<string, boolean> = {};
    for (let i = 0; i < BRUSH_SIZE_TOOLS.length; i++) s[BRUSH_SIZE_TOOLS[i].toLowerCase()] = true;
    return s;
})();

/** 归一化工具 ID（只比较用，不上屏）。 */
export function normToolId(id: string | null | undefined): string {
    return String(id || '').trim().toLowerCase();
}

/** 当前工具是否「能改笔尖大小」。传 null ⇒ false（读不到工具时不猜）。 */
export function isBrushSizeTool(toolId: string | null | undefined): boolean {
    const t = normToolId(toolId);
    return !!t && !!BRUSH_SIZE_SET[t];
}

/** 把工具读数归一化成 ID 串（裸串 / `{_enum}` / `{_value}` 三种形态都认）。 */
function toolIdOf(v: any): string | null {
    if (!v) return null;
    if (typeof v === 'string') return v || null;
    if (typeof v === 'object') {
        const s = v._enum ?? v._value ?? v._obj ?? v.tool ?? v.id ?? v.name;
        return typeof s === 'string' && s ? s : null;
    }
    return null;
}

/**
 * 读当前工具 ID；读不到返回 null。
 *
 * ⛔⛔ 2026-11-20 真机纠错（用户报「按了没反应」，日志里 `tool: 未知`）：
 *    **不能**用 `app.currentTool` —— PS 27 上这个 UXP 属性是空/不可用
 *    （`get currentTool` 那条 batchPlay 更是直接报 -25920，见 brushstudio/psMixer.ts
 *     的注释）。原来这里把它当唯一来源 ⇒ 每次都是 null ⇒ 工具闸门永远判「未知」
 *    ⇒ 功能整体失灵（日志里连续 40 多条 `当前工具不能改笔尖大小`）。
 *    ⇒ 改走仓里**已被真机验证过多轮**的那条：`get application.tool._enum`
 *      （HotkeyBridge.getSelectedBrushToolEnum / app.tsx 的工具巡检同源）。
 *    ⛔ 必须经 `psRead` 进模态作用域：热键命中常常落在用户正落笔/抬笔的一拍上，
 *       裸 get 撞上宿主忙碌窗口会弹出不可捕获的原生报错框（psAccess 头部说明）。
 *       retries:0 —— 按键是即时动作，丢一次不值得排队等模态；用户再按一下即可。
 *    `app.currentTool` 只作最后兜底（某些版本它有值），形态同样归一。
 */
export async function readToolId(): Promise<string | null> {
    const id = await psRead<string | null>(async () => {
        try {
            const res: any = await action.batchPlay(
                [{
                    _obj: 'get',
                    _target: [{ _property: 'tool' }, ...APP_TARGET],
                    _options: { dialogOptions: 'silent' }
                }] as any,
                { synchronousExecution: true } as any
            );
            const d: any = Array.isArray(res) ? res[0] : res;
            /* 只认「形如工具 ID」的串（全部以 Tool 结尾）：
               `get application.tool` 可能回 { tool: {_enum} }，也可能直接回工具描述符本身；
               其他垃圾值（比如 application）不能当工具 ID，否则日志会被误导。 */
            const t1 = toolIdOf(d?.tool);
            if (t1 && /Tool$/i.test(t1)) return t1;
            const t2 = toolIdOf(d);
            if (t2 && /Tool$/i.test(t2)) return t2;
        } catch {
            /* 退到 UXP 属性兜底 */
        }
        try {
            return toolIdOf((app as any)?.currentTool);
        } catch {
            return null;
        }
    }, { label: '读取当前工具', retries: 0 });
    return id ?? null;
}

/** 工具 ID → 中文名（提示/日志用，名单外原样返回）。 */
const TOOL_CN: Record<string, string> = {
    paintbrushtool: '画笔',
    penciltool: '铅笔',
    erasertool: '橡皮擦',
    backgrounderasertool: '背景橡皮擦',
    magicerasertool: '魔术橡皮擦',
    wetbrushtool: '混合器画笔',
    mixerbrushtool: '混合器画笔',
    smudgetool: '涂抹',
    blurtool: '模糊',
    sharpentool: '锐化',
    dodgetool: '减淡',
    burntool: '加深',
    spongetool: '海绵',
    clonestamptool: '仿制图章',
    patternstamptool: '图案图章',
    historybrushtool: '历史记录画笔',
    artbrushtool: '历史记录艺术画笔',
    colorreplacementbrushtool: '颜色替换画笔',
    spothealingbrushtool: '污点修复画笔',
    healingbrushtool: '修复画笔',
};

export function toolCnName(toolId: string | null | undefined): string {
    const t = normToolId(toolId);
    return TOOL_CN[t] || String(toolId || '');
}

/* ================================================================ 宿主命令 */

const APP_TARGET = [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }];

/** 一条 batchPlay（silent：失败的写法不弹黄条）。返回第一个描述符；error 抛错。 */
async function bp(desc: any): Promise<any> {
    const res: any = await action.batchPlay([{ ...desc, _options: { dialogOptions: 'silent' } }] as any, {
        synchronousExecution: true
    } as any);
    const first: any = Array.isArray(res) ? res[0] : res;
    if (!first) throw new Error('空响应');
    if (first._obj === 'error') throw new Error(String(first.message || 'PS 拒绝了命令'));
    return first;
}

/** 读工具状态的形态下标（会话级记忆：失败形态只撞一次，别把黄条刷满）。 */
let readForm = -1;

/**
 * 读当前工具的完整选项描述符。拿不到返回 null，不抛。
 * 三条形态与 brushstudio/psState.ts 完全同源（那条已被真机验证过多轮）。
 */
async function readCto(toolRef: string | null): Promise<any | null> {
    const tries: any[] = [
        { _obj: 'get', _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET] },
    ];
    if (toolRef) {
        tries.push({ _obj: 'get', _target: [{ _ref: toolRef }], property: 'currentToolOptions' });
        tries.push({ _obj: 'get', _target: [{ _ref: toolRef }] });
    }
    const order: number[] = readForm >= 0 ? [readForm] : [];
    for (let i = 0; i < tries.length; i++) if (order.indexOf(i) < 0) order.push(i);
    const errs: string[] = [];
    for (let k = 0; k < order.length; k++) {
        const idx = order[k];
        try {
            const first = await bp(tries[idx]);
            const cto = first.currentToolOptions ?? first;
            if (!cto || typeof cto !== 'object') { errs.push(idx + ': 无 currentToolOptions'); continue; }
            if (!cto.brush) { errs.push(idx + ': 无 brush 字段（keys=' + Object.keys(cto).slice(0, 6).join(',') + '）'); continue; }
            if (readForm !== idx) {
                readForm = idx;
                smLog('笔刷大小·读工具状态形态', { form: idx, keys: Object.keys(cto).slice(0, 8) });
            }
            return cto;
        } catch (e: any) {
            errs.push(idx + ': ' + (e?.message || String(e)));
        }
    }
    /* ⛔ 失败必须留痕：静默失败是本仓历史上的头号坑（铁律 163）。 */
    smLog('笔刷大小·读工具状态失败', { toolRef, errs: errs.join(' / ') });
    return null;
}

/** 递掉任何不能过 JSON 的字段（ByteArray / TypedArray）—— 整份回灌会被 PS 以类型错误拒收。 */
function jsonSafe(v: any): any {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    const g: any = globalThis as any;
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return undefined;
    if (g.ArrayBuffer?.isView && g.ArrayBuffer.isView(v)) return undefined;
    if (Array.isArray(v)) {
        const arr: any[] = [];
        for (let i = 0; i < v.length; i++) {
            const r = jsonSafe(v[i]);
            if (r !== undefined) arr.push(r);
        }
        return arr;
    }
    const out: any = {};
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
        const r = jsonSafe(v[keys[i]]);
        if (r !== undefined) out[keys[i]] = r;
    }
    return out;
}

/** 抄一份 brush 描述符的**完整**副本（只去掉 _options）。
 *  ⛔ 少带一个键，PS 就把当前笔当成「一支新笔」重建 —— 直径对了、采样笔尖没了。 */
function brushCopy(src: any): any {
    const out: any = {};
    if (!src || typeof src !== 'object') return out;
    const keys = Object.keys(src);
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] === '_options') continue;
        out[keys[i]] = src[keys[i]];
    }
    return out;
}

function diameterOf(cto: any): number {
    const d = cto?.brush?.diameter?._value;
    const n = typeof d === 'number' ? d : Number(d);
    return isFinite(n) ? n : 0;
}

/** 采样笔尖句柄（「笔尖还在不在」的唯一硬证据）。 */
function tipOf(cto: any): string {
    const b = cto?.brush ?? {};
    const s = b?.sampledBrush?.sampledData ?? b?.sampledData;
    return typeof s === 'string' ? s : '';
}

/** 上次验证通过的 set 形态下标（-1 = 还不知道，按顺序试）。 */
let applyForm = -1;

/**
 * 把当前笔尖的直径改成 `target`，笔尖身份必须原样保住。
 *
 * 判据（缺一不算成功）：回读直径到目标值 **且** 采样笔尖句柄没变。
 * 返回实际生效的形态下标，便于日志定位。
 *
 * ⛔⛔ 2026-11-20 第二次真机纠错：`set` **必须**在 `runAsModal` 里发。
 *    裸 batchPlay 的 `set` 会被宿主直接拒：`Event: set may modify the state of
 *    Photoshop. Such events are only allowed from inside a modal scope.` —— 三种写法
 *    全部同一个错（日志里 `set 全部被拒` 三条一模一样就是这么来的）。
 *    这和 brushstudio/psMixer.ts 的 `setTipDiameter` 完全一致（它也是经 `cmd` → `runAsModal`）。
 */
async function applyDiameter(target: number, cto0: any, toolRef: string | null): Promise<{ ok: boolean; form: number; err: string }> {
    const base = brushCopy(cto0.brush);
    const tip0 = tipOf(cto0);
    const to = jsonSafe(cto0);
    to.brush = { ...jsonSafe(base), diameter: { _unit: 'pixelsUnit', _value: target } };
    /* `_options` 不属于工具状态：混在 `to` 里会让 PS 把整份描述符当「另一份数据」处理 */
    delete to._options;

    const forms: { label: string; desc: any }[] = [];
    if (toolRef) {
        forms.push({ label: 'set ' + toolRef, desc: { _obj: 'set', _target: [{ _ref: toolRef }], to } });
    }
    forms.push({
        label: 'set property.currentToolOptions',
        desc: { _obj: 'set', _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET], to }
    });
    forms.push({
        label: 'set brush targetEnum',
        desc: { _obj: 'set', _target: [{ _ref: 'brush', _enum: 'ordinal', _value: 'targetEnum' }], to: to.brush }
    });

    const order: number[] = applyForm >= 0 ? [applyForm] : forms.map((_f, i) => i);
    const errs: string[] = [];
    for (let k = 0; k < order.length; k++) {
        const i = order[k];
        if (i >= forms.length) continue;
        const f = forms[i];
        /* ⛔ set + 回读放在**同一个**模态作用域里：
           ① `set` 必须在模态内（见本函数头部的两次纠错），否则宿主直接拒；
           ② 回读放在同一个模态里，既不会被 `psRead` 的「宿主忙」粗筛挡掉
              （刚写完的一瞬常被判忙，那会把成功误判成「回读 0px」），
              也避免了「写完 → 出模态 → 再进模态读」的三次往返。
           ⚠️ 模态内的 `psRead` 会自动降级为直读（psAccess 的 ownModalDepth），
              因此 readCto 在这里不会尝试嵌套模态（UXP 不允许嵌套）。 */
        let after: any = null;
        try {
            after = await runAsModal(async () => {
                await bp(f.desc);
                return await readCto(toolRef);
            }, { commandName: '笔刷大小档位' });
        } catch (e: any) {
            errs.push(f.label + ': ' + (e?.message || String(e)));
            continue;
        }
        if (!after) {
            errs.push(f.label + ': 写完读不回来（currentToolOptions 为空）');
            continue;
        }
        const dia = diameterOf(after);
        const tip = tipOf(after);
        if (tip0 && tip !== tip0) {
            errs.push(f.label + ': 笔尖被冲掉了（' + tip0.slice(0, 8) + '… → ' + (tip || '空') + '）');
            continue;
        }
        if (Math.abs(dia - target) > 1) {
            errs.push(f.label + ': 回读 ' + dia + 'px，没到 ' + target + 'px');
            continue;
        }
        if (applyForm !== i) {
            applyForm = i;
            smLog('笔刷大小·生效写法', { form: i, label: f.label });
        }
        return { ok: true, form: i, err: '' };
    }
    return { ok: false, form: -1, err: errs.join(' / ') || '三种写法都被拒' };
}

/* ================================================================ 状态 / 互斥（setting 目录） */

const SETTINGS_FOLDER = 'settings';
const STATE_FILE = 'brush-size-step.json';
const LOCK_FILE = 'brush-size-step.lock';
/** 锁超过这个时间没被删，视为上一个持有者崩了 ⇒ 允许抢占一次。 */
const LOCK_STALE_MS = 1500;
/**
 * 两档之间的最小间隔。
 *
 * ⛔ 为什么需要：`RegisterHotKey` 带 MOD_NOREPEAT（按住不重复投递），但 LL 钩子那条
 *    路对**键盘自动重复**的 keydown 不保证过滤 —— 按住 Shift+] 不放可能连跳三档。
 *    180ms 比人手两次独立按键的间隔短（正常连按 ≈ 200ms+），只挡重复不挡连按。
 */
const STEP_MIN_GAP_MS = 180;

function formats(): string {
    try {
        return (storage as any).formats?.utf8 ?? 'utf8';
    } catch {
        return 'utf8';
    }
}

async function settingsFolder(): Promise<any> {
    const dataFolder: any = await storage.localFileSystem.getDataFolder();
    try {
        return await dataFolder.getEntry(SETTINGS_FOLDER);
    } catch {
        return await dataFolder.createFolder(SETTINGS_FOLDER);
    }
}

interface StepState {
    /** 一次命中的唯一号（原生的 seq），用来把「重复执行」变成幂等 */
    token: string;
    /** 本次命中算出的目标档位 0/1/2 */
    tier: number;
    /** 文档指纹（id + 宽高）：换文档就不用上一份档位了 */
    docKey: string;
    ts: number;
}

async function readState(): Promise<StepState | null> {
    try {
        const folder = await settingsFolder();
        const file = await folder.getEntry(STATE_FILE);
        const text = await file.read({ format: formats() });
        const j = JSON.parse(text);
        if (!j || typeof j !== 'object') return null;
        const tier = Number(j.tier);
        return {
            token: typeof j.token === 'string' ? j.token : '',
            tier: isFinite(tier) ? tier : -1,
            docKey: typeof j.docKey === 'string' ? j.docKey : '',
            ts: Number(j.ts) || 0
        };
    } catch {
        return null;
    }
}

async function writeState(st: StepState): Promise<void> {
    try {
        const folder = await settingsFolder();
        const file = await folder.createFile(STATE_FILE, { overwrite: true });
        await file.write(JSON.stringify(st), { format: formats() });
    } catch {
        /* 写不进去只影响「并发重放」这一层，主链照旧 */
    }
}

/**
 * 抢占本次命中的执行权。
 *
 * `createFile(name, {overwrite:false})` 在文件已存在时抛错 —— 借它当跨上下文的互斥量
 * （两个面板几乎同时按键时，只有一个能创建成功）。抢不到就直接跳过本次动作：
 * 另一个上下文正在做同一件事，再跳一档就是「按一下动两格」。
 */
async function claimStep(token: string): Promise<boolean> {
    const folder = await settingsFolder();
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const f = await folder.createFile(LOCK_FILE, { overwrite: false });
            await f.write(JSON.stringify({ token, ts: Date.now() }), { format: formats() });
            return true;
        } catch {
            /* 已存在：可能是「另一个面板正在执行」，也可能是上次崩溃的残留 */
        }
        let stale = false;
        try {
            const e = await folder.getEntry(LOCK_FILE);
            const text = await e.read({ format: formats() });
            const j = JSON.parse(text);
            const ts = Number(j?.ts) || 0;
            stale = !ts || Date.now() - ts > LOCK_STALE_MS;
        } catch {
            /* 内容读不出（可能刚被删）⇒ 允许重试一次创建 */
            stale = true;
        }
        if (!stale || attempt > 0) return false;
        try {
            const e = await folder.getEntry(LOCK_FILE);
            await e.delete();
            smLog('笔刷大小·锁残留已清', {});
        } catch {
            return false;
        }
    }
    return false;
}

async function releaseStep(): Promise<void> {
    try {
        const folder = await settingsFolder();
        const e = await folder.getEntry(LOCK_FILE);
        await e.delete();
    } catch {
        /* 已经不在 / 删不掉：靠 LOCK_STALE_MS 兜底 */
    }
}

/* ================================================================ 主入口 */

export interface BrushSizeStepResult {
    ok: boolean;
    /** 为什么没做（ok=false 时） */
    reason?: 'no-doc' | 'tool' | 'dup' | 'no-brush' | 'apply' | 'error';
    tool?: string | null;
    from?: number;
    to?: number;
    tier?: number;
    /** 本次文档的三档值 */
    tiers?: number[];
    err?: string;
}

/** 方向：+1 = 下一档（增大，Shift+]），-1 = 上一档（减小，Shift+[）。 */
export type BrushSizeDir = 1 | -1;

/** 由当前直径算「站在哪一档」，再走一格。
 *  ⛔ 不做「直径 +1 档」的纯自增：必须从**实际直径**推出所在台阶，
 *     否则手改过尺寸之后第一次按键会跳两档。 */
function baseTierFor(tiers: number[], cur: number, dir: BrushSizeDir): number {
    const tol = 1; // PS 会做取整，1px 之内算「正好在这一档上」
    if (dir > 0) {
        let base = -1;
        for (let i = 0; i < tiers.length; i++) if (tiers[i] <= cur + tol) base = i;
        return base; // cur 比最小档还小 ⇒ -1 ⇒ 目标是最小档
    }
    let base = tiers.length;
    for (let i = tiers.length - 1; i >= 0; i--) if (tiers[i] >= cur - tol) base = i;
    return base; // cur 比最大档还大 ⇒ length ⇒ 目标是最大档
}

function clampTier(t: number): number {
    return t < 0 ? 0 : t > 2 ? 2 : t;
}

/**
 * 执行一次「笔刷大小档位」步进。
 *
 * @param dir   +1 增大 / -1 减小
 * @param token 一次命中的唯一号（原生广播的 seq；同一次命中在两个面板里必须相同）
 */
export async function stepBrushSize(dir: BrushSizeDir, token: string): Promise<BrushSizeStepResult> {
    smLogSession('笔刷大小', { dir, token });

    /* ① 必须有打开的文档（尺寸是唯一输入） */
    const tiers = activeDocTiers();
    if (!tiers) {
        smLog('笔刷大小·跳过', { reason: '没有打开的文档 / 读不到尺寸' });
        return { ok: false, reason: 'no-doc' };
    }

    /* ② 工具闸门：名单外的工具一律不动（套索/移动/文字…） */
    const tool = await readToolId();
    if (!isBrushSizeTool(tool)) {
        smLog('笔刷大小·跳过', { reason: '当前工具不能改笔尖大小', tool: tool || '未知（读不到工具 ID）' });
        return { ok: false, reason: 'tool', tool, tiers };
    }

    /* ③ 抢占执行权（另一块面板可能同时在处理同一次命中） */
    let claimed = false;
    try {
        claimed = await claimStep(token);
    } catch (e: any) {
        smLog('笔刷大小·锁异常', { err: String(e) });
    }
    if (!claimed) {
        smLog('笔刷大小·跳过', { reason: '另一块面板已接手本次命中', token });
        return { ok: false, reason: 'dup', tool, tiers };
    }

    let st: StepState | null = null;
    try {
        /* ④ 读工具状态（拿到当前直径与完整 cto，后面回写要整份给回去） */
        const cto0 = await readCto(tool);
        if (!cto0) {
            smLog('笔刷大小·失败', { reason: '读不到 currentToolOptions', tool });
            return { ok: false, reason: 'no-brush', tool, tiers };
        }
        const from = diameterOf(cto0);
        let docKey = '';
        try {
            const doc: any = (app as any).activeDocument;
            docKey = String(doc?.id ?? '') + ':' + Math.round(Number(doc?.width) || 0) + 'x' + Math.round(Number(doc?.height) || 0);
        } catch {
            docKey = '';
        }

        st = await readState();

        /* ⑤a 重复抑制：上一次步进刚刚发生过（<180ms）⇒ 这次多半是键盘自动重复 */
        if (st && st.token !== token && st.docKey === docKey && st.ts && Date.now() - st.ts < STEP_MIN_GAP_MS) {
            smLog('笔刷大小·跳过', { reason: '距上次步进不足 ' + STEP_MIN_GAP_MS + 'ms（自动重复）', gap: Date.now() - st.ts });
            return { ok: false, reason: 'dup', tool, tiers };
        }

        /* ⑤b 已经越过最大/最小档时，「继续往同一方向」不做任何事。
           ⛔ 不能直接 clamp：那是「按增大反而变小」（从 800px 掉到 100px），
              在画布上就是一次莫名其妙的笔尖骤缩。 */
        const overMax = from > tiers[2] + 1;
        const underMin = from < tiers[0] - 1;
        if ((dir > 0 && overMax) || (dir < 0 && underMin)) {
            smLog('笔刷大小·跳过', { reason: '已超出档位范围', from, tiers, dir });
            return { ok: true, tool, from, to: from, tiers };
        }

        /* ⑤ 定目标档位：token 相同 ⇒ 直接复用它记下的档位（并发重放 = 幂等） */
        let tier: number;
        if (st && st.token === token && st.tier >= 0 && st.tier <= 2) {
            tier = st.tier;
            smLog('笔刷大小·重放同一命中', { tier, token });
        } else {
            const base = baseTierFor(tiers, from, dir);
            tier = clampTier(base + dir);
        }

        const target = tiers[tier];
        smLog('笔刷大小·判据', {
            tool: tool + '(' + toolCnName(tool) + ')',
            from, target, tier, tiers, dir,
            docKey
        });

        /* ⑥ 先把「本次命中的结论」落盘，再动手 —— 后到的上下文据此幂等重放 */
        if (!st || st.token !== token) {
            await writeState({ token, tier, docKey, ts: Date.now() });
        }

        if (Math.abs(from - target) <= 1) {
            smLog('笔刷大小·已在档上', { from, target, tier });
            return { ok: true, tool, from, to: from, tier, tiers };
        }

        /* ⑦ 改直径 + 回读校验 */
        const r = await applyDiameter(target, cto0, tool);
        if (!r.ok) {
            smLog('笔刷大小·失败', { reason: 'set 全部被拒', err: r.err, target });
            return { ok: false, reason: 'apply', tool, from, to: target, tier, tiers, err: r.err };
        }
        smLog('笔刷大小·完成', { from, to: target, tier, form: r.form });
        return { ok: true, tool, from, to: target, tier, tiers };
    } catch (e: any) {
        smLog('笔刷大小·异常', { err: String(e?.message || e) });
        return { ok: false, reason: 'error', tool, tiers, err: String(e?.message || e) };
    } finally {
        await releaseStep();
    }
}
