import { action, app, imaging } from 'photoshop';
import { BLEND_MODE_CALCULATIONS } from './BlendModeCalculations';
import { smLog } from './SmDebug';

/**
 * 「特殊剪贴蒙版」—— 渐变 / 图案填充的那个「保留不透明度 / 剪贴蒙版」复选框。
 *
 * ## 为什么不再用 PS 原生的剪贴蒙版
 *
 * 旧实现是一条 batchPlay：`groupEvent`（= 图层菜单「创建剪贴蒙版」）。它有两个硬伤：
 *
 *  ① **对「本身已经是别人的剪贴蒙版」的图层直接失败** —— PS 弹
 *     「命令"创建剪贴蒙版"当前不可用」，整次填充在 catch 里中断。
 *  ② **剪贴蒙版不能套娃** —— 即便绕过报错，第二次填充的可见范围也只受紧邻的
 *     那一层约束，不会继承它更下方基底的约束 ⇒ 表现为「左侧超出第一次渐变的范围」。
 *
 * ## 现在走像素合成
 *
 * 语义被显式定义成一句话：**只改下层像素的颜色，绝不改它的 alpha。**
 * （用户原话：原本 alpha 是 128 的像素，填充后 RGB 变了，alpha 仍然是 128。）
 * 这正是原生剪贴蒙版「向下合并」后的效果，但它对「目标层本身是剪贴层」同样成立 ——
 * 因为我们只写目标的像素，而它被更下方基底裁剪的可见性关系原封不动。
 *
 * ## ⚠️ 参数形状照抄 `ClearHandler.readLayerPixels` / `writeLayerPixels`（真机验证过）
 *
 *  · 读：`sourceBounds`（**不是** `bounds`）+ `targetSize` 同尺寸 + `componentSize: 8`；
 *        **不传 `applyAlpha`**（它会把 RGBA 白底合成成 RGB、抹掉 alpha），
 *        **不传 `colorProfile`**（读写走文档工作空间，往返才恒等）。
 *  · 写：`putPixels` 的 `replace` 默认 **true** ⇒ 只给局部块会**清空整层**。
 *        所以一律「整图写回」：缓冲必须是文档全尺寸，且**不传 `targetBounds`**。
 */

/**
 * 文档的**像素**尺寸。
 *
 * ⛔⛔ **不要读 `doc.bounds`** —— UXP 的 `Document` **没有** `bounds` 属性
 *    （只有 `Layer` 有）。旧实现读它拿到 `undefined` ⇒ 宽高变 NaN ⇒ 返回 `{0,0}`
 *    ⇒ `blendTopIntoBase` / `compositeTopIntoBase` / `multiplyTopAlphaByBase`
 *    全部在**第一行就静默 return false**（只有一条 console.warn，用户看不到），
 *    于是「特殊剪贴蒙版」永远退回合并路径：
 *      · 目标是剪贴基底 ⇒ 合并继承裁剪语义 / 触发 ungroup ⇒ 上方剪贴全被解除；
 *      · 目标是最上层剪贴蒙版 ⇒ 合并被拒 ⇒ 图案 / 渐变整个丢失。
 *    这正是 2026-11-19 用户 8 组实测里「开不开特殊剪贴都一样」的真凶。
 *
 * ✅ 官方文档：`Document.width` / `Document.height` 是**像素**数值（Number），
 *    与 `Document.resolution`（ppi）无关，不做任何单位换算。
 */
function getDocPixelSize(): { width: number; height: number } {
    try {
        const doc: any = app.activeDocument;
        const width = Math.round(Number(doc?.width));
        const height = Math.round(Number(doc?.height));
        if (Number.isFinite(width) && Number.isFinite(height) && width > 1 && height > 1) {
            return { width, height };
        }
        console.warn('⚠️ 文档像素尺寸异常:', doc?.width, doc?.height);
    } catch (e) {
        console.warn('⚠️ 读取文档像素尺寸失败:', e);
    }
    return { width: 0, height: 0 };
}

/** 文档坐标矩形，右 / 下不含。 */
export interface ClipRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface PixelBlock {
    data: Uint8Array;
    components: number;
    left: number;
    top: number;
    width: number;
    height: number;
}

/** 非像素层被选中时的提示语（渐变 / 图案共用，保持同一句话）。 */
export const NON_PIXEL_LAYER_HINT =
    '当前图层不是普通像素图层（文字 / 智能对象 / 形状 / 调整层 / 图层组）。\n' +
    '请先栅格化该图层，或在面板上打开「新建图层」后再填充。';

/**
 * 判断 `layer.kind` 是否属于「这套填充收尾链路处理不了」的图层。
 *
 * ⚠️ 读不到 kind（老版本宿主 / 探测失败）时返回 `false` —— 宁可走原有路径，
 *    也不要因为一个读不到的可选字段把正常填充挡掉。
 * ⚠️ 背景图层的 kind 同样是 `'pixel'`，不要在这里特殊对待。
 */
export function isNonPixelLayerKind(kind?: string | null): boolean {
    if (!kind) return false;
    // 背景图层在部分宿主上是独立枚举值 'background'，但它就是像素层，不要误挡。
    if (kind === 'pixel' || kind === 'background') return false;
    return true;
}

/**
 * 尝试用 PS 原生剪贴蒙版（快，且基底可以是文字层 / 智能对象等任意类型）。
 *
 * ⛔ 必须**回读验证**（2026-11-19 第 16 轮用户实测）：这条命令用的是
 *    `dialogOptions: 'silent'`，宿主拒绝时**不抛异常**、只返回一个错误描述符 ⇒
 *    旧写法 `return true` 会把「什么都没做」当成成功，调用方因此跳过像素收窄，
 *    结果就是「有剪贴箭头、但像素铺满整个选区」（用户报的「没收到约束」）。
 *
 * @returns true 表示建立成功；false 表示 PS 拒绝了这条命令（典型场景：
 *          目标下方那个图层本身已经是别的图层的剪贴蒙版），调用方应降级。
 */
export async function tryCreateNativeClippingMask(): Promise<boolean> {
    try {
        await action.batchPlay(
            [{
                _obj: 'groupEvent',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                // ⛔ `silent`：这条命令在「下方图层本身已是剪贴蒙版」时会被宿主拒绝，
                //    而**失败的命令会弹原生报错框并绕过 JS try/catch**（本仓 2026-11-16
                //    在 `get channel mask` 上吃过同一个亏）。silent 才是真正「不吭声」的那档。
                _options: { dialogOptions: 'silent' },
            }],
            { synchronousExecution: true }
        );
        return await readActiveLayerClippingFlag();
    } catch (e) {
        console.warn(
            '⚠️ 原生「创建剪贴蒙版」不可用（下方图层可能已是剪贴层），降级为像素 alpha 合成:',
            e
        );
        return false;
    }
}

/**
 * 回读活动图层的 `isClippingMask`。
 *
 * ⚠️ DOM 有时滞后一帧（刚下发完命令就立刻读会拿到旧值）⇒ 首次读不到 true 时
 *    用 `resolveActiveLayerId()` 取一次即时 id 再按 id 查节点重判。
 */
async function readActiveLayerClippingFlag(): Promise<boolean> {
    if (readActiveLayerClipState().isClippingMask) return true;
    const id = await resolveActiveLayerId();
    if (!id) return false;
    const node = findLayerNodeById((app.activeDocument as any)?.layers, id);
    return !!(node && node.isClippingMask);
}

/**
 * 把活动图层切到**文档最顶层**（`ordinal: front`）。
 *
 * 用在「不新建图层」的填充路径创建内容层**之前**：当目标层是剪贴基底时，
 * PS 会把新建的填充层**自动塞进那个剪贴组**（`isClippingMask === true`），
 * 之后无论合并还是解除剪贴都会牵连整组。放到最顶层 ⇒ 一出生就没有任何剪贴关系，
 * 收尾可以统一走「像素写回目标层 → 删掉内容层」，全程不碰 groupEvent / ungroup。
 *
 * ⚠️ 内容层最终会被删除（或者是空图层模式），所以它在栈里的位置对结果没有影响。
 */
export async function selectFrontLayer(): Promise<boolean> {
    try {
        await action.batchPlay(
            [{
                _obj: 'select',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'front' }],
                makeVisible: false,
                _options: { dialogOptions: 'silent' },
            }],
            { synchronousExecution: true }
        );
        return true;
    } catch (e) {
        console.warn('⚠️ 选中顶层图层失败（继续按原位创建）:', e);
        return false;
    }
}

/** 按 id 选中图层（收尾时把活动目标还给用户原本的图层）。 */
export async function selectLayerById(layerId: number): Promise<boolean> {
    try {
        await action.batchPlay(
            [{
                _obj: 'select',
                _target: [{ _ref: 'layer', _id: layerId }],
                makeVisible: false,
                _options: { dialogOptions: 'silent' },
            }],
            { synchronousExecution: true }
        );
        return true;
    } catch (e) {
        console.warn(`⚠️ 重新选中图层 ${layerId} 失败（不影响填充结果）:`, e);
        return false;
    }
}

/**
 * 取活动图层 id（内容层栅格化之后调用）。
 *
 * ⚠️ 为什么不用 DOM：`rasterizeLayer` 之后 UXP 的 `activeLayers` 有概率**滞后一帧**，
 *    拿到的还是刚建好的那个 fill layer 的旧 id ⇒ 用它读像素 / 删图层都会静默失败
 *    （用户 2026-11-19 的「中间结果摇摆」正是这一类时序问题的典型表现）。
 *    batchPlay 的 `get ... _property: layerID` 是同一条 IPC 往返内的即时值。
 */
export async function resolveActiveLayerId(): Promise<number | null> {
    try {
        const r = await action.batchPlay(
            [{
                _obj: 'get',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                _property: 'layerID',
                _options: { dialogOptions: 'silent' },
            }],
            { synchronousExecution: true }
        );
        const id = Number((r?.[0] as any)?.layerID);
        if (Number.isFinite(id) && id > 0) return id;
    } catch { /* 属性不被支持 ⇒ 退回 DOM */ }
    return readActiveLayerClipState().id;
}

/** 活动图层的剪贴状态快照（两个 DOM 属性读，0 次 IPC）。 */
export interface ActiveLayerClipState {
    id: number | null;
    /** 该图层**正在被别人当剪贴蒙版用**（PS 的「向下剪贴」，`false` = 普通图层）。 */
    isClippingMask: boolean;
}

/**
 * 读活动图层的 id 与剪贴状态。
 *
 * ⚠️ 两个场合必须**重新读一次**，不能用创建前的快照：
 *   ① 内容图层刚建好 —— PS 可能已经把它塞进目标的剪贴组（`isClippingMask === true`）；
 *   ② `rasterizeLayer` 之后 —— 栅格化内容图层有可能换掉图层 id，用旧 id 去读像素 /
 *      删图层都会静默失败（表现为「填充层留在原地没被收走」）。
 */
export function readActiveLayerClipState(): ActiveLayerClipState {
    try {
        const layer: any = app.activeDocument?.activeLayers?.[0];
        return {
            id: typeof layer?.id === 'number' ? layer.id : null,
            isClippingMask: !!layer?.isClippingMask,
        };
    } catch (e) {
        console.warn('⚠️ 读取活动图层剪贴状态失败:', e);
        return { id: null, isClippingMask: false };
    }
}

/** 相邻（同级）图层信息：只带剪贴判定需要的字段。 */
export interface NeighborLayerInfo {
    id: number;
    isClippingMask: boolean;
    /** 是否有像素（判据同 `LayerInfoHandler.hasPixels`：像素层 + bounds 非空）。 */
    hasPixels: boolean;
    /** `layer.kind` 原样值（`'pixel'` / `'text'` / `'group'` …）。 */
    kind?: string;
}

/** 在图层树里找到 `id` 所在的**同级列表**与它的下标（组内图层也能找到）。 */
function findSiblingList(layers: any, id: number): { list: any; index: number } | null {
    if (!layers || typeof layers.length !== 'number') return null;
    for (let i = 0; i < layers.length; i++) {
        const node: any = layers[i];
        try {
            if (node?.id === id) return { list: layers, index: i };
            const kids = node?.layers;
            if (kids && kids.length) {
                const hit = findSiblingList(kids, id);
                if (hit) return hit;
            }
        } catch { /* 单个节点读失败不影响其它节点 */ }
    }
    return null;
}

/**
 * 读某个图层**紧邻下方**那一层（同级列表里的下一个）。
 *
 * ⚠️ UXP 的 `Document.layers[i]` 是**从上往下**排的（`[0]` = 最上层），
 *    所以「下方」是 `index + 1`，不是 `index - 1`。
 * ⚠️ 只在**同一级**里找：跨出图层组的那一刻就没有「下方图层」了（返回 null）。
 */
export function readLayerBelow(layerId: number): NeighborLayerInfo | null {
    try {
        const hit = findSiblingList((app.activeDocument as any)?.layers, layerId);
        if (!hit) return null;
        const below: any = hit.list[hit.index + 1];
        if (!below || typeof below.id !== 'number') return null;
        // ⚠️ `kind` / `bounds` 都是 DOM 属性读（0 次 IPC），但**必须各自兜住异常**：
        //    图层组读 `bounds` 会抛 ⇒ 组被误判成「没有内容」，剪贴就跑偏了。
        let kind: string | undefined;
        let hasPixels = false;
        try {
            kind = below.kind;
            const bounds = below.bounds;
            hasPixels = kind === 'pixel' && !!bounds && bounds.width > 0 && bounds.height > 0;
        } catch { /* 读不到就按「非像素层」处理，由调用方叠加 kind 判断 */ }
        return { id: below.id, isClippingMask: !!below.isClippingMask, hasPixels, kind };
    } catch (e) {
        console.warn(`⚠️ 读取图层 ${layerId} 的下方图层失败:`, e);
        return null;
    }
}

/**
 * 直接把**活动图层**的剪贴标志置真（DOM 属性写，0 次 IPC）。
 *
 * 为什么必须有这条路：PS 的「创建剪贴蒙版」只能指向**紧邻下方且本身不是剪贴层**的层。
 * 目标层本身是剪贴组内成员时，`groupEvent` 一律被拒 —— 而用户要的是「结果层真的带剪贴箭头」。
 * UXP 的 `Layer.isClippingMask` 是 **R/W**，直接置真即可把该层并入下方那个剪贴组。
 *
 * ⛔⛔ **只允许置真，永不置假**：`isClippingMask = false` 会把这一组里**上方所有**
 *    剪贴层一起释放（UXP 文档原文：Releasing a clipping mask will also release the
 *    layers above），那是不可逆的结构破坏（铁律 150）。
 *
 * @returns true = 此刻该层确实是剪贴层（含本来就是的情形）
 * @param expectedId 期望被置真的图层 id（调用方刚从 batchPlay 拿到的即时值）。
 *        ⚠️ 传了且与 DOM 的活动层不一致时按 id 重新定位 —— 刚建层 / 刚栅格化之后
 *        `activeLayers[0]` 有概率滞后一帧，照旧按「活动层」写会把别人的剪贴打开。
 */
export async function enableActiveLayerClippingMask(expectedId?: number | null): Promise<boolean> {
    try {
        const doc: any = app.activeDocument;
        let layer: any = doc?.activeLayers?.[0];
        if (expectedId && (!layer || layer.id !== expectedId)) {
            layer = findLayerNodeById(doc?.layers, expectedId);
        }
        if (!layer) return false;
        if (layer.isClippingMask) return true;

        layer.isClippingMask = true;
        if (layer.isClippingMask) return true;

        // DOM 偶尔滞后一帧：按 id 重新取一次节点再判
        const id = typeof layer.id === 'number' ? layer.id : null;
        const node = id ? findLayerNodeById(doc?.layers, id) : null;
        return !!(node && node.isClippingMask);
    } catch (e) {
        console.warn('⚠️ 直接置「剪贴蒙版」标志被宿主拒绝:', e);
        return false;
    }
}

/**
 * 「特殊蒙版 + 新建图层」要做的事，被拆成四问：
 *   ① 谁**承载填充内容**（`resultLayerId`：`null` = 调用方新建一层）；
 *   ② 谁**构成边界**（`boundaryLayerId`：剪贴指向它、像素按它的 alpha 收窄）；
 *   ③ 要不要**新建图层**（`reuseTarget`：目标层是空层时直接复用它，不新建）；
 *   ④ 要不要**填内容**（`shouldFill`：边界层完全没有像素 ⇒ 只建剪贴、不填东西）。
 *
 * 规则全部来自用户 2026-11-19 的真机口径（第 16 轮又补了三条边界）：
 *
 * | 目标层（激活图层） | 结果层 | 边界 | 填内容 |
 * |---|---|---|---|
 * | 有像素 / 非像素层 / 本身是剪贴层 | **新建**一层，落在目标层上方 | 目标层自己 | 是 |
 * | 空的普通像素层 | **目标层自己**（不新建） | 紧邻下方那层 | 下方有内容才填 |
 * | 空的普通像素层 + 下方无图层 | 目标层自己 | 无（不剪贴） | 是（普通填充） |
 *
 * ⛔⛔ 为什么空目标层必须**复用**而不是新建（用户 2026-11-19 截图实证）：新建的话
 *    目标层会留成一个**空白层**悬在结果层上方 ⇒ 用户看到「空白图层 + 没约束的剪贴层 +
 *    下方图层」三个图层，而他只选了一个图层做填充。空层里本来就没有内容可保，直接拿它
 *    当结果层，图层数才和他心里的一致。
 *
 * ⛔ 为什么「下方也没有像素」时仍然建剪贴、但不填：用户口径是「仅仅是上方图层成为
 *    下方图层的剪贴蒙版，不填充任何内容」。此时若照常填，就得靠「乘一个全 0 的 alpha」
 *    把它擦掉 —— 那是把一整层的读、算、写白做一遍，而且擦完仍会留下一个
 *    「有像素壳、视觉全空」的怪层。
 *
 * ⚠️ 必须在 `make layer` **之前**调用：建层会把活动目标换人，`layerInfo.layerId`
 *    随即被覆盖成新层 id，那时再算就没有「目标层」这个概念了。
 *
 * ⚠️⚠️ 「目标层有没有内容」不能用 `hasPixels` 一个字段判：它的前提是 `kind === 'pixel'`
 *    ⇒ 文字 / 智能对象 / 形状 / 图层组**恒为 false**，而它们恰恰是很好的剪贴基底
 *    （PS 的原生剪贴对任意图层类型都成立）。漏了这一条，在文字层上填充就会被误判成
 *    「空层」而去剪贴它**下方**那一层 —— 填充会落在文字之外。
 *
 * @returns null = 没有可用的目标层 id（调用方按原行为处理）
 */
export interface SpecialClipPlan {
    /** 承载填充内容的图层：`null` = 调用方新建一层，结果层是新建的那层。 */
    resultLayerId: number | null;
    /** 边界层（剪贴指向它、像素按它的 alpha 收窄）；`null` = 没有边界（下方无图层）。 */
    boundaryLayerId: number | null;
    /** 边界层自己是不是剪贴层（决定原生剪贴是否可行）。 */
    boundaryIsClipping: boolean;
    /** 边界层是否有像素（决定要不要做像素收窄；非像素层只能靠剪贴结构裁）。 */
    boundaryHasPixels: boolean;
    /** 目标层是空层 ⇒ 直接复用目标层当结果层，**不新建图层**。 */
    reuseTarget: boolean;
    /** 是否值得填内容（边界层完全没有像素时为 false）。 */
    shouldFill: boolean;
}

/**
 * 依据**填充前**读到的目标层信息算出剪贴计划（判据见 `SpecialClipPlan` 的表）。
 */
export function planSpecialClipBase(target: {
    layerId?: number | null;
    hasPixels?: boolean;
    isClippingMask?: boolean;
    layerKind?: string | null;
}): SpecialClipPlan | null {
    const targetId = typeof target.layerId === 'number' ? target.layerId : null;
    if (!targetId) return null;

    // ① 有内容（像素层的像素 / 非像素层本身）/ 本身是剪贴层 ⇒ 新建结果层，边界是它自己
    if (target.hasPixels || target.isClippingMask || isNonPixelLayerKind(target.layerKind)) {
        return {
            resultLayerId: null,
            boundaryLayerId: targetId,
            boundaryIsClipping: !!target.isClippingMask,
            boundaryHasPixels: !!target.hasPixels,
            reuseTarget: false,
            shouldFill: true,
        };
    }

    // ② 空的普通像素层 ⇒ 复用目标层当结果层，边界取紧邻下方那一层
    const below = readLayerBelow(targetId);
    if (!below) {
        /* 下方已经没有图层（目标是同级最后一层）：没有可剪贴的对象 ⇒ 不建剪贴，
           按普通填充处理（填进这个空层，用户至少能拿到内容）。 */
        return {
            resultLayerId: targetId,
            boundaryLayerId: null,
            boundaryIsClipping: false,
            boundaryHasPixels: false,
            reuseTarget: true,
            shouldFill: true,
        };
    }
    return {
        resultLayerId: targetId,
        boundaryLayerId: below.id,
        boundaryIsClipping: below.isClippingMask,
        boundaryHasPixels: below.hasPixels,
        reuseTarget: true,
        // 下方是像素空层 ⇒ 没有边界可依，只建剪贴结构、不填内容；
        // 下方是文字 / 智能对象等非像素层 ⇒ 它本身有内容，正常填（由它裁）。
        shouldFill: below.hasPixels || isNonPixelLayerKind(below.kind),
    };
}

/** 图层此刻是否还存在于当前文档（组内也能找到）。 */
export function layerExists(layerId: number): boolean {
    try {
        return !!findLayerNodeById((app.activeDocument as any)?.layers, layerId);
    } catch {
        return false;
    }
}

/** 读图层名字（只用于「结果层接管空目标层的名字」，读不到就不改名）。 */
function readLayerNameById(layerId: number): string | undefined {
    try {
        const node = findLayerNodeById((app.activeDocument as any)?.layers, layerId);
        const name = node?.name;
        return typeof name === 'string' && name.length > 0 ? name : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 把图层改成指定名字（失败只告警 —— 改名是锦上添花，不能连累填充）。
 *
 * ⚠️ 两级：DOM 直接写（快）→ 失败再用 batchPlay 按 **id** 写。
 *    内容层刚建好时 DOM 可能还没刷新出这个节点，只走 DOM 会静默失败，
 *    用户看到的就是「图层 1 变成了 渐变填充 1」。
 */
async function renameLayerById(layerId: number, name: string): Promise<boolean> {
    try {
        const node: any = findLayerNodeById((app.activeDocument as any)?.layers, layerId);
        if (node) {
            node.name = name;
            if (node.name === name) return true;
        }
    } catch (e) {
        console.warn(`⚠️ 特殊蒙版：结果层改名为「${name}」失败（DOM 路径），改用 batchPlay:`, e);
    }
    try {
        await action.batchPlay(
            [{
                _obj: 'set',
                _target: [{ _ref: 'layer', _id: layerId }],
                to: { _obj: 'layer', name },
                _options: { dialogOptions: 'silent' },
            }],
            { synchronousExecution: true }
        );
        return true;
    } catch (e) {
        console.warn(`⚠️ 特殊蒙版：结果层改名为「${name}」失败（不影响填充结果）:`, e);
        return false;
    }
}

/** 等某个图层从 DOM 里消失（删层之后 UXP 的图层树会滞后一帧，最多等 `timeoutMs`）。 */
async function waitLayerGone(layerId: number, timeoutMs = 400): Promise<boolean> {
    const step = 40;
    for (let waited = 0; waited <= timeoutMs; waited += step) {
        if (!layerExists(layerId)) return true;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, step));
    }
    return !layerExists(layerId);
}

/** 按 id 读剪贴标志（不依赖选中状态；读不到按 false）。 */
export function readClippingFlagById(layerId: number): boolean {
    try {
        const node = findLayerNodeById((app.activeDocument as any)?.layers, layerId);
        return !!node?.isClippingMask;
    } catch {
        return false;
    }
}

/**
 * 某个像素层此刻是否**确实是空的**（没有任何像素）。
 *
 * @returns `true` = 空像素层；`false` = 有内容 / 非像素层（**不许当空层删掉**）；
 *          `null` = 找不到该图层或读不到属性（调用方自行决定，默认保守）。
 */
export function isLayerEmptyById(layerId: number): boolean | null {
    try {
        const node: any = findLayerNodeById((app.activeDocument as any)?.layers, layerId);
        if (!node) return null;
        const kind = node.kind;
        if (kind !== 'pixel' && kind !== 'background') return false;
        const b = node.bounds;
        if (!b) return true;
        return !(Number(b.width) > 0) || !(Number(b.height) > 0);
    } catch {
        return null;
    }
}

/**
 * 把**指定 id 的图层**剪到紧邻下方那一层。
 *
 * ⛔ 为什么不能沿用「先单独 select、再单独 groupEvent」（用户 2026-11-19 第 18 轮实测）：
 *    `select` 是否真的把活动目标换过去**无法保证**（组内图层 / 刚删过层的场合尤其），
 *    而 `groupEvent` 打的是「当前活动图层」—— 两者之间只要错一步，剪贴就落到别人头上
 *    （历史事故：原渐变被剪到背景上，不可逆）。所以这里把 `select` 与 `groupEvent`
 *    **放进同一个 batchPlay 数组**：同一次 IPC 往返内先选后剪，中间没有间隙。
 *    仍失败才降级成 DOM 置真（同样是 id 寻址，与选中无关）。
 */
export async function clipLayerToBelowById(layerId: number): Promise<boolean> {
    if (readClippingFlagById(layerId)) return true;
    try {
        await action.batchPlay(
            [
                {
                    _obj: 'select',
                    _target: [{ _ref: 'layer', _id: layerId }],
                    makeVisible: false,
                    _options: { dialogOptions: 'silent' },
                },
                {
                    _obj: 'groupEvent',
                    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                    _options: { dialogOptions: 'silent' },
                },
            ],
            { synchronousExecution: true }
        );
    } catch (e) {
        smLog('剪贴·批量下发异常', String(e));
    }
    if (readClippingFlagById(layerId)) return true;
    return enableActiveLayerClippingMask(layerId);
}

/**
 * 「空目标层复用」的结果层交接：**让内容层顶替那个空图层**。
 *
 * ## 为什么不能把像素直接写回空目标层（2026-11-19 用户实测）
 *
 * 渐变 / 图案的收尾是「建内容层 → 栅格化 → 应用蒙版 → `imaging.putPixels` 写回目标层」。
 * 目标层若是**空图层**（没有任何像素），这条写回会被宿主拒绝：
 * 「渐变填充未完成：目标图层拒绝了像素写入…」—— 内容层被撤回、图层一片狼藉，
 * 而调用方还以为填充成功，接着按「复用目标层」去建剪贴，把箭头建到了别人头上。
 * 纯色模式不走像素写回（原生 fill 直接落在活动层），所以只有渐变 / 图案会踩到。
 *
 * 空图层里本来就没有内容可保，因此这里换个更朴素的做法：
 *   ① 内容层的像素按**边界层 alpha** 收窄（特殊蒙版的语义，不能省）；
 *   ② 删掉那个空目标层 —— 内容层因此直接落在边界层正上方；
 *   ③ 内容层接管目标层的名字（用户看到的仍是「图层 1」，不会觉得图层凭空消失）；
 *   ④ 建剪贴关系（此刻它下方紧邻的就是边界层，groupEvent 一次到位）。
 *
 * ⛔ 只在**删除成功**后才建剪贴：删不掉就保留原结构、不建箭头，
 *    绝不把剪贴建到一个不确定的邻居上（那正是「原渐变被剪到背景上」的成因）。
 *
 * @returns true = 结构已按预期落定（改名 / 剪贴是否成功另算，失败只告警）
 */
export interface EmptyTargetReplacement {
    /** 空的、被复用的目标层（将被内容层顶替）。 */
    targetLayerId: number;
    /** 结果层（内容层）。不传则取此刻的活动图层。 */
    contentLayerId?: number | null;
    /** 边界层（像素收窄的基准、剪贴指向的对象）；`null` = 下方没有图层。 */
    boundaryLayerId: number | null;
    /** 边界层是否有像素（非像素层只能靠剪贴结构裁，不做像素收窄）。 */
    boundaryHasPixels: boolean;
}

/**
 * 把内容层**向下合并**进紧邻下方的空目标层（原生「向下合并」）。
 *
 * 为什么这是首选（用户 2026-11-19 第 18 轮）：空图层不能走 `imaging.putPixels`，
 * 但「合并」是宿主自己的像素搬运 —— 内容层融进目标层后，目标层**id / 名字 / 位置
 * 全部不变**，图层数也不变，用户看到的仍然是「我选的那个图层被填了」。
 * 相比之下「删空层 + 结果层接管名字」是三步都可能被宿主拒绝的绕路。
 *
 * ⛔ 前提：内容层紧邻下方**就是**目标层（否则合并会吃进别人的图层）。
 * ⛔ 合并后必须回读：目标层不再为空 ⇒ 才算成功。
 */
async function mergeContentIntoEmptyTarget(contentId: number, targetLayerId: number): Promise<boolean> {
    const below = readLayerBelow(contentId);
    if (!below || below.id !== targetLayerId) {
        smLog('交接·⓪合并跳过', { reason: '内容层下方不是目标层', below: below?.id ?? null });
        return false;
    }
    try {
        await action.batchPlay(
            [
                {
                    _obj: 'select',
                    _target: [{ _ref: 'layer', _id: contentId }],
                    makeVisible: false,
                    _options: { dialogOptions: 'silent' },
                },
                { _obj: 'mergeLayersNew', _options: { dialogOptions: 'silent' } },
            ],
            { synchronousExecution: true }
        );
    } catch (e) {
        smLog('交接·⓪合并异常', String(e));
        return false;
    }
    /* ⚠️ 判据只看「目标层现在有像素了」。合并后 DOM 有一帧延迟，所以先等一下再读
       （`contentGone` 常常还是 false：图层树里那个内容层还没消失）。 */
    await new Promise((r) => setTimeout(r, 120));
    const targetEmptyNow = isLayerEmptyById(targetLayerId);
    const targetFilled = targetEmptyNow === false;
    smLog('交接·⓪合并进空层', {
        ok: targetFilled,
        contentGone: !layerExists(contentId),
        targetEmptyNow,
    });
    return targetFilled;
}

export async function replaceEmptyTargetWithContent(opts: EmptyTargetReplacement): Promise<boolean> {
    const { targetLayerId, boundaryLayerId, boundaryHasPixels } = opts;

    /* ⓪ 定位结果层：优先用调用方给的「刚栅格化完的活动层 id」；不可信时按 id 自查。 */
    let contentId: number | null = opts.contentLayerId ?? null;
    if (!contentId) {
        const activeId = await resolveActiveLayerId();
        contentId = activeId && activeId > 0 ? activeId : null;
    }
    smLog('交接·开始', {
        target: targetLayerId,
        content: contentId,
        boundary: boundaryLayerId,
        boundaryHasPixels,
        targetExists: layerExists(targetLayerId),
        targetEmpty: isLayerEmptyById(targetLayerId),
        contentSeenInDom: contentId ? layerExists(contentId) : false,
        targetName: readLayerNameById(targetLayerId),
        targetIsClip: readClippingFlagById(targetLayerId),
    });
    if (!contentId) {
        smLog('交接·✗ 拿不到结果层 id，放弃');
        return false;
    }

    /* ⚠️ `contentId === targetLayerId` 是**合法**情形，不是错误：宿主建内容层时有可能
       「就地替换」那个空图层（新层接管旧层的 id 与位置）⇒ 此时目标层已经换人了，
       没有可删的空层，但收窄 / 剪贴照样要做。旧实现在这里会误判成异常直接退出，
       结果就是「填充成功、但既没约束也没箭头」。 */
    const inPlace = contentId === targetLayerId;
    let targetName = inPlace ? undefined : readLayerNameById(targetLayerId);

    /* ⓪' 首选：内容层向下合并进空目标层（见 mergeContentIntoEmptyTarget）。
       合并成功 ⇒ 结果层就是用户原来那个图层，后面的「删空层 / 改名」全部不需要。 */
    let merged = false;
    if (!inPlace) {
        merged = await mergeContentIntoEmptyTarget(contentId, targetLayerId);
        if (merged) contentId = targetLayerId;
    }

    // ① 像素收窄：先把内容裁到边界层的 alpha 以内（与剪贴结构无关，必须做）。
    if (boundaryLayerId && boundaryHasPixels) {
        const narrowed = await multiplyTopAlphaByBase({
            docId: app.activeDocument.id,
            baseLayerId: boundaryLayerId,
            topLayerId: contentId,
        });
        smLog('交接·①收窄', { ok: narrowed, boundary: boundaryLayerId, content: contentId });
        if (!narrowed) {
            console.warn('⚠️ 特殊蒙版：结果层像素未能按边界层 alpha 收窄（填充结果保持原样）');
        }
    } else {
        smLog('交接·①收窄跳过', { boundaryLayerId, boundaryHasPixels });
    }

    // ② 空目标层退场（**只在确认它确实没有像素时**才删 —— 宁可多一个空层，也不删用户内容）。
    //    ⚠️ 只在 ⓪' 合并失败时才走这一步（合并成功的话目标层就是结果层，不能删）。
    if (!inPlace && !merged) {
        const empty = isLayerEmptyById(targetLayerId);
        if (empty === false) {
            smLog('交接·②跳过删除', '目标层已不是空层（有内容或非像素层）');
        } else if (empty === null) {
            /* ⛔ 读不到状态就**不许删**：那一层这时很可能已经被合并进了内容（有像素），
               删掉就是不可逆的内容丢失。宁可留着它、只做收窄。 */
            smLog('交接·②跳过删除', '读不到目标层状态，保守不删');
        } else {
            let deleted = await deleteLayerById(targetLayerId);
            if (deleted && layerExists(targetLayerId)) {
                // 兜底：batchPlay 报成功但层还在 ⇒ 换 DOM 的 remove()
                try {
                    const node: any = findLayerNodeById((app.activeDocument as any)?.layers, targetLayerId);
                    node?.delete?.();
                } catch (e) {
                    smLog('交接·②DOM 删层异常', String(e));
                }
                deleted = !layerExists(targetLayerId);
            }
            smLog('交接·②删空层', {
                ok: deleted,
                stillExists: layerExists(targetLayerId),
                name: targetName,
            });
        }
    }

    // ③ 选中结果层（选不上也**继续** —— 剪贴改走 id 寻址，不再依赖活动图层）。
    const selected = await selectLayerById(contentId);
    const activeId = await resolveActiveLayerId();
    smLog('交接·③选中结果层', { selected, activeId, expect: contentId });

    /* ④ 建立剪贴关系。
       ⛔ 只在「结果层紧邻下方**就是**边界层」时才建：删空层万一没成功，紧邻下方就是
          那个空层（alpha 全 0），此时建剪贴会让填充**整个不可见** —— 比没有箭头更糟。
          这种情况宁可不建，交给 ① 的像素收窄保底。 */
    if (boundaryLayerId) {
        /* 删层之后 DOM 会滞后一帧（图层树还挂着已删除的空层）⇒ 先等它消失，
           再判断「紧邻下方是谁」。不等待的话读到的 below 还是那个空层，剪贴就被跳过了。 */
        const targetGone = inPlace || merged || await waitLayerGone(targetLayerId, 400);
        const below = targetGone ? readLayerBelow(contentId) : null;
        if (!targetGone) {
            smLog('交接·④剪贴跳过', { reason: '空目标层仍在（删不掉），紧邻下方不是边界层' });
        } else if (!below) {
            smLog('交接·④剪贴跳过', '结果层下方没有同级图层');
        } else if (below.id !== boundaryLayerId) {
            smLog('交接·④剪贴跳过', {
                reason: '紧邻下方不是边界层',
                below: below.id,
                boundary: boundaryLayerId,
            });
        } else {
            const clipped = await clipLayerToBelowById(contentId);
            smLog('交接·④剪贴', { ok: clipped, flag: readClippingFlagById(contentId) });
            if (!clipped) {
                console.warn(
                    '⚠️ 特殊蒙版：宿主拒绝为结果层建立剪贴关系（像素已按边界层 alpha 收窄，' +
                    '可见范围正确，但图层上没有剪贴箭头）'
                );
            }
        }
    } else {
        smLog('交接·④剪贴跳过', '没有边界层（目标层下方为空）');
    }

    /* ⑤ 改名放**最后**：前面任何一步出错都不该让用户看到「图层 1 消失了」
       （回到最初那个 bug 的观感）。改名失败只告警。 */
    if (targetName) {
        const renamed = await renameLayerById(contentId, targetName);
        smLog('交接·⑤改名', { ok: renamed, name: targetName });
    }

    smLog('交接·结束', {
        content: contentId,
        name: readLayerNameById(contentId),
        isClip: readClippingFlagById(contentId),
    });
    return true;
}

/** 按图层 ID 删除图层（不依赖「当前活动图层」是谁）。删不掉只告警，不打断填充流程。 */
export async function deleteLayerById(layerId: number): Promise<boolean> {
    try {
        await action.batchPlay(
            [{
                _obj: 'delete',
                _target: [{ _ref: 'layer', _id: layerId }],
                _options: { dialogOptions: 'dontDisplay' },
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        return true;
    } catch (e) {
        console.warn(`⚠️ 删除临时图层 ${layerId} 失败:`, e);
        return false;
    }
}

/** 按活动图层删除（id 已失效时的兜底；PS 的 `delete` 不带 target 时删的就是活动层）。 */
export async function deleteActiveLayer(): Promise<boolean> {
    try {
        await action.batchPlay(
            [{
                _obj: 'delete',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                _options: { dialogOptions: 'silent' },
            }],
            { synchronousExecution: true }
        );
        return true;
    } catch (e) {
        console.warn('⚠️ 删除活动图层失败:', e);
        return false;
    }
}

// ------------------------------------------------------------------------------------------------
// 像素读写
//
// ⛔⛔ 这一段的参数形状**必须**与 `ClearHandler.readLayerPixels` / `expandToDocument` /
//     `writeLayerPixels` 完全一致（真机验证过，铁律：按图层实有边界读 → 按索引扩充成
//     文档全尺寸缓冲 → 整图写回）。三段各自踩过的坑：
//
//      ① 读：`sourceBounds` 要**按图层自身的 `boundsNoEffects`** 传，⛔ 不要传文档矩形。
//         全文档 `sourceBounds` 在图层没画满画布时会被 PS 裁剪、甚至直接报
//         `Missing image`（`MaskSyncEngine` 实测）；而且请求区域被裁剪后返回的
//         `imageData` 尺寸与请求尺寸不一致，按请求尺寸当索引会整体错位。
//      ② 扩充：定位原点必须取**返回的** `sourceBounds.left/top`，再用它把块按索引
//         拷进 `docWidth × docHeight` 缓冲；块以外保持 0（= 透明），画布外像素丢弃。
//      ③ 写：`putPixels` 的 `replace` 默认 **true** ⇒ 只给局部块会清空整层。
//         所以一律整图写回：缓冲是文档全尺寸、**不传 `targetBounds`**
//         （官方：不传则插入到文档原点 `(0,0)`）。
// ------------------------------------------------------------------------------------------------

/** 在图层树里按 id 找图层节点（组内图层也要能找到）。 */
function findLayerNodeById(layers: any, id: number): any | null {
    if (!layers || typeof layers.length !== 'number') return null;
    for (let i = 0; i < layers.length; i++) {
        const node: any = layers[i];
        try {
            if (node?.id === id) return node;
            const kids = node?.layers;
            if (kids && kids.length) {
                const hit = findLayerNodeById(kids, id);
                if (hit) return hit;
            }
        } catch { /* 单个图层读失败不影响其它节点 */ }
    }
    return null;
}

/**
 * 图层的**实有像素**外接矩形（`boundsNoEffects` 优先 —— 带效果的外扩范围不是像素）。
 *
 * 读不到 / 退化矩形返回 null，调用方回退到文档矩形（**绝不把异常抛给主流程**）。
 */
function readLayerBoundsById(layerId: number): ClipRect | null {
    try {
        const doc: any = app.activeDocument;
        const node = findLayerNodeById(doc?.layers, layerId);
        const b: any = node && (node.boundsNoEffects || node.bounds);
        if (!b) return null;
        const left = Math.round(Number(b.left) || 0);
        const top = Math.round(Number(b.top) || 0);
        const right = Math.round(Number(b.right) || 0);
        const bottom = Math.round(Number(b.bottom) || 0);
        if (!(right > left) || !(bottom > top)) return null;
        return { left, top, right, bottom };
    } catch (e) {
        console.warn(`⚠️ 读取图层 ${layerId} 像素边界失败（回退到文档矩形）:`, e);
        return null;
    }
}

/**
 * 读一个图层的实有像素块（1:1，不缩放）。
 *
 * ⚠️ `region` **必须是图层自身的 `boundsNoEffects`**，不是文档矩形（见上方 ①②③）。
 * ⚠️ PS 仍可能把请求区域再裁剪一次（图层有像素但边缘为空），所以返回的 `left/top`
 *    必须回读 `result.sourceBounds`，否则后续按「请求原点」当地图会整体错位。
 *
 * @returns null = 没有可读像素（空图层 / 全透明 / 完全在画布外）
 */
async function readBlock(docId: number, layerId: number, region: ClipRect): Promise<PixelBlock | null> {
    const left = Math.round(region.left);
    const top = Math.round(region.top);
    const width = Math.round(region.right) - left;
    const height = Math.round(region.bottom) - top;
    if (width <= 0 || height <= 0) return null;

    try {
        const result = await imaging.getPixels({
            documentID: docId,
            layerID: layerId,
            sourceBounds: { left, top, right: left + width, bottom: top + height },
            targetSize: { width, height },
            componentSize: 8,
        });

        const data = new Uint8Array(await result.imageData.getData());
        // ⚠️ 宽高必须在 dispose() 之前读出来
        const gotW = Math.max(1, Math.round(Number(result.imageData.width) || width));
        const gotH = Math.max(1, Math.round(Number(result.imageData.height) || height));
        const sb: any = result.sourceBounds;
        result.imageData.dispose();

        const components = Math.round(data.length / (gotW * gotH));
        if (components !== 3 && components !== 4) {
            console.warn(
                `⚠️ 图层像素分量数异常（components=${components}，${gotW}x${gotH}，${data.length} 字节）`
            );
            return null;
        }

        return {
            data,
            components,
            left: sb && Number.isFinite(Number(sb.left)) ? Math.round(Number(sb.left)) : left,
            top: sb && Number.isFinite(Number(sb.top)) ? Math.round(Number(sb.top)) : top,
            width: gotW,
            height: gotH,
        };
    } catch (e) {
        // 空图层 / 图层完全在画布外时 PS 抛「No pixels in the requested area」
        console.warn('⚠️ 读取图层像素失败（可能是空图层）:', e);
        return null;
    }
}

/**
 * 按 `sourceBounds` 索引把「图层实有像素块」**扩充**成文档全尺寸缓冲。
 *
 * 起点是 `block.left / block.top`（= 读取时回读到的 `sourceBounds` 原点），
 * 逐行 `dy = block.top + y`、逐列 `dx = block.left + x` 拷进去；块以外保持 0
 * （= 透明 / 黑），落在画布外的像素丢弃。与 `ClearHandler.expandToDocument` 同一口径。
 *
 * ⛔ 不要写成「把块当成整图」—— 块只是图层实有范围那一小块，尺寸通常远小于文档。
 */
function expandToDocument(block: PixelBlock, width: number, height: number): Uint8Array {
    const components = block.components;
    const out = new Uint8Array(width * height * components);

    const right = block.left + block.width;
    const bottom = block.top + block.height;
    if (block.left < 0 || block.top < 0 || right > width || bottom > height) {
        console.warn(
            '⚠️ 图层像素范围超出画布，画布外的像素将被丢弃:',
            block.left, block.top, right, bottom, '画布', width, height
        );
    }

    for (let y = 0; y < block.height; y++) {
        const dy = block.top + y;
        if (dy < 0 || dy >= height) continue;
        const srcRow = y * block.width;
        const dstRow = dy * width;
        for (let x = 0; x < block.width; x++) {
            const dx = block.left + x;
            if (dx < 0 || dx >= width) continue;
            const s = (srcRow + x) * components;
            const d = (dstRow + dx) * components;
            for (let c = 0; c < components; c++) {
                out[d + c] = block.data[s + c];
            }
        }
    }
    return out;
}

/**
 * 读一个图层的实有像素块：**先取图层自身 `boundsNoEffects` 当 region**，再交给 `readBlock`。
 *
 * 取不到边界（空图层 / 极端权限 / DOM 滞后）时回退文档矩形 —— 那只是慢一点，
 * 不会比「不读」更糟；真正不能做的是把文档矩形**当成**块的索引。
 */
async function readLayerBlock(docId: number, layerId: number): Promise<PixelBlock | null> {
    const bounds = readLayerBoundsById(layerId);
    if (bounds) return readBlock(docId, layerId, bounds);

    // 回退：拿不到图层边界时按文档矩形读（慢一点，但语义仍然是「整层」）
    const docRect = getDocPixelSize();
    if (docRect.width <= 0 || docRect.height <= 0) return null;
    return readBlock(docId, layerId, { left: 0, top: 0, right: docRect.width, bottom: docRect.height });
}

/** 整图写回（不传 `targetBounds`，否则 `replace: true` 会清空整层）。 */
async function writeDocument(
    docId: number,
    layerId: number,
    data: Uint8Array,
    width: number,
    height: number,
    components: number
): Promise<void> {
    const imageData = await imaging.createImageDataFromBuffer(data, {
        width,
        height,
        components,
        chunky: true,
        colorSpace: 'RGB',
        pixelFormat: components === 4 ? 'RGBA' : 'RGB',
        componentSize: 8,
    });
    try {
        await imaging.putPixels({ documentID: docId, layerID: layerId, imageData });
    } finally {
        imageData.dispose();
    }
}

// ------------------------------------------------------------------------------------------------
// 对外：特殊剪贴蒙版
// ------------------------------------------------------------------------------------------------

export interface SpecialClipOptions {
    docId: number;
    /** 被裁剪的基底图层（填充目标，位于填充层下方）。**它的 alpha 不会被改动。** */
    baseLayerId: number;
    /** 填充层（渐变层 / 图案临时层）。调用前必须已经「应用图层蒙版」，让 alpha 定形为选区。 */
    topLayerId: number;
    /** 面板上的填充不透明度（0-100）。图层属性上的 opacity 在这里手动折算，因为读像素读不到它。 */
    opacity: number;
    /** 面板上的混合模式名（与 `BLEND_MODE_CALCULATIONS` 的 key 同一命名空间）。 */
    blendMode: string;
}

/**
 * 像素写回的三态结果。
 *
 * ⚠️ **必须区分 `'nothing'` 和 `'failed'`**（2026-11-19 用户实测 bug）：
 *   · `'nothing'` = 按语义**本来就不该写任何像素**（基底在选区处 alpha 全为 0 /
 *     填充层在选区处全透明）⇒ 这是一次**成功的填充**，调用方只需删掉内容层。
 *   · `'failed'` = 该写但写不进去（锁定的背景层 / 权限 / 宿主拒绝）⇒ 才允许降级。
 *   旧实现用 boolean，把 `'nothing'` 也当失败 ⇒ 降级「挪到目标层上方 + 向下合并」⇒
 *   PS 只能合到**紧邻的那一层**（往往是最上方的剪贴蒙版）⇒ 表现为
 *   「在 alpha=0 的地方也填了一块渐变」「填到了最上层的同一个位置」
 *   「弹『合并图层不可用』并在最上层剪贴蒙版上又新建一个剪贴蒙版」。
 */
export type PixelWriteResult = 'written' | 'nothing' | 'failed';

/**
 * 把填充层的颜色**合成进**基底图层，基底 alpha 严格不变。
 *
 * 逐像素：`w = topA × baseA × opacity`，`out.rgb = base.rgb×(1-w) + blend(base,top)×w`。
 * `w` 里那一项 `baseA` 就是「特殊剪贴」本身 —— 基底没有像素的地方权重为 0，
 * 填充结果自然不落上去。
 *
 * 完成后调用方应**删除填充层**（不再 `mergeLayersNew`）：合并会把两层 alpha 叠加，
 * 128 → 约 191，正是本函数要避免的事情。
 *
 * @returns `'nothing'` = 基底在选区处没有像素（alpha 全为 0）⇒ 语义上就该什么都不填，
 *          调用方删掉内容层即可，**不要降级合并**；`'failed'` = 该写但写不进去。
 */
export async function blendTopIntoBase(options: SpecialClipOptions): Promise<PixelWriteResult> {
    const { docId, baseLayerId, topLayerId, opacity, blendMode } = options;
    const { width, height } = getDocPixelSize();
    if (width <= 0 || height <= 0) {
        console.warn('⚠️ 特殊剪贴蒙版：拿不到文档像素尺寸，跳过');
        return 'failed';
    }

    // ⚠️ 按两张图各自的 `boundsNoEffects` 读（不是文档矩形），再按 sourceBounds 索引扩充。
    const baseBlock = await readLayerBlock(docId, baseLayerId);
    if (!baseBlock) {
        // 基底在整层范围内都没有可读像素 ⇒ 特殊剪贴的可见范围为空 ⇒ 什么都不填。
        console.log('ℹ️ 特殊剪贴蒙版：基底图层没有像素，本次不填充任何内容');
        return 'nothing';
    }
    const topBlock = await readLayerBlock(docId, topLayerId);
    if (!topBlock) {
        console.log('ℹ️ 特殊剪贴蒙版：填充层没有像素，本次不填充任何内容');
        return 'nothing';
    }

    // 输出缓冲以基底为底（保持它原有的 alpha / 选区外像素原样）
    const out = expandToDocument(baseBlock, width, height);
    const baseComponents = baseBlock.components;
    const topComponents = topBlock.components;
    const blendFn = BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
    const opacityRatio = Math.max(0, Math.min(100, opacity)) * 0.01;

    // ⚠️ 只遍历填充层的实有像素范围，不扫全文档：填充层之外 topA 必为 0。
    //    （渐变填充图层栅格化后通常铺满画布，所以这层优化只对图案 / 局部内容有感。）
    let touched = 0;
    for (let y = 0; y < topBlock.height; y++) {
        const dy = topBlock.top + y;
        if (dy < 0 || dy >= height) continue;
        for (let x = 0; x < topBlock.width; x++) {
            const dx = topBlock.left + x;
            if (dx < 0 || dx >= width) continue;

            const s = (y * topBlock.width + x) * topComponents;
            const topA = topComponents === 4 ? topBlock.data[s + 3] : 255;
            if (topA === 0) continue;

            const d = (dy * width + dx) * baseComponents;
            const baseA = baseComponents === 4 ? out[d + 3] : 255;
            if (baseA === 0) continue;

            const w = (topA / 255) * (baseA / 255) * opacityRatio;
            if (w <= 0) continue;

            const inv = 1 - w;
            for (let c = 0; c < 3; c++) {
                const baseC = out[d + c];
                const topC = topBlock.data[s + c];
                out[d + c] = Math.round(baseC * inv + blendFn(baseC, topC) * w);
            }
            touched++;
        }
    }

    if (touched === 0) {
        // ⚠️ 这不是失败：基底在这块选区里 alpha 全为 0（或填充层全透明）⇒
        //    「只落在基底已有像素上」的语义下，正确结果就是**一个像素都不改**。
        //    绝不能在这里降级去合并 —— 合并只认紧邻那一层，会填到别人的图层上。
        console.log('ℹ️ 特殊剪贴蒙版：选区与基底像素没有交集，本次不填充任何内容（符合预期）');
        return 'nothing';
    }

    try {
        await writeDocument(docId, baseLayerId, out, width, height, baseComponents);
    } catch (e) {
        // 背景图层 / 锁定透明像素 / 非像素图层都可能在这里被 PS 拒绝。
        // 返回 'failed' 让调用方退回「向下合并」，不要把整次填充判死。
        console.warn('⚠️ 特殊剪贴蒙版：写回基底失败，退回合并路径:', e);
        return 'failed';
    }
    console.log(`✅ 特殊剪贴蒙版合成完成，影响 ${touched} 个像素（alpha 未改动）`);
    return 'written';
}

/**
 * 把填充层**并进**基底图层，alpha 取并集（= 一次「向下合并」的像素等价物）。
 *
 * 与 `blendTopIntoBase` 只差一处：权重里**不乘** `baseA`，所以基底原本透明的
 * 地方也会被填充内容写进去 —— 这正是「不做特殊剪贴」应有的语义。
 *
 * 什么时候用它：正常的 `mergeLayersNew` 被剪贴关系搅乱的时候。PS 的两条硬规则
 *   · 往下合并到**一个剪贴蒙版**上 ⇒ 直接报「合并图层不可用」；
 *   · 新建层被自动塞进剪贴组 ⇒ 合并后继承裁剪语义（alpha 被钳住，看起来像开了特殊剪贴）。
 * 两条都绕不过去时，用本函数算准了写回，比和宿主掰扯可靠。
 *
 * @returns `'nothing'` = 填充层在选区里没有任何不透明像素（本来就没内容可写）；
 *          `'failed'` = 该写但写不进去（锁定的背景层 / 宿主拒绝）。
 */
export async function compositeTopIntoBase(options: SpecialClipOptions): Promise<PixelWriteResult> {
    const { docId, baseLayerId, topLayerId, opacity, blendMode } = options;
    const { width, height } = getDocPixelSize();
    if (width <= 0 || height <= 0) return 'failed';

    // ⚠️ 按两张图各自的 `boundsNoEffects` 读（不是文档矩形），再按 sourceBounds 索引扩充。
    const baseBlock = await readLayerBlock(docId, baseLayerId);
    const topBlock = await readLayerBlock(docId, topLayerId);
    // ⚠️ 基底读不到像素**不是**失败：目标可能是个空像素图层（「新建图层关闭 + 填充
    //    目标是空图层」那条分支就是它）。空图层按「全透明」处理，填充照样写进去。
    if (!topBlock) {
        console.log('ℹ️ 并集合成：填充层没有可读像素，本次无内容可写');
        return 'nothing';
    }

    const bc = baseBlock ? baseBlock.components : 4;
    const out = baseBlock ? expandToDocument(baseBlock, width, height) : new Uint8Array(width * height * bc);
    const tc = topBlock.components;
    const blendFn = BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
    const opacityRatio = Math.max(0, Math.min(100, opacity)) * 0.01;

    // W3C 合成公式（非预乘）：
    //   co = aT(1-aB)Cs + aT·aB·B(Cb,Cs) + (1-aT)aB·Cb
    //   ao = aT + aB(1-aT)
    let touched = 0;
    for (let y = 0; y < topBlock.height; y++) {
        const dy = topBlock.top + y;
        if (dy < 0 || dy >= height) continue;
        for (let x = 0; x < topBlock.width; x++) {
            const dx = topBlock.left + x;
            if (dx < 0 || dx >= width) continue;

            const s = (y * topBlock.width + x) * tc;
            const topA = tc === 4 ? topBlock.data[s + 3] : 255;
            const aT = (topA / 255) * opacityRatio;
            if (aT <= 0) continue;

            const d = (dy * width + dx) * bc;
            const baseA = bc === 4 ? out[d + 3] : 255;
            const aB = baseA / 255;
            const ao = aT + aB - aT * aB;
            if (ao <= 0) continue;

            for (let c = 0; c < 3; c++) {
                const cb = out[d + c] / 255;
                const cs = topBlock.data[s + c] / 255;
                const bl = blendFn(out[d + c], topBlock.data[s + c]) / 255;
                const co = aT * (1 - aB) * cs + aT * aB * bl + (1 - aT) * aB * cb;
                out[d + c] = Math.max(0, Math.min(255, Math.round((co / ao) * 255)));
            }
            if (bc === 4) {
                out[d + 3] = Math.max(0, Math.min(255, Math.round(ao * 255)));
            }
            touched++;
        }
    }

    if (touched === 0) {
        // 填充层在选区里全透明 ⇒ 本来就没有内容可写，这不是失败。
        console.log('ℹ️ 并集合成：填充层在选区里没有不透明像素，本次无内容可写');
        return 'nothing';
    }

    try {
        await writeDocument(docId, baseLayerId, out, width, height, bc);
    } catch (e) {
        console.warn('⚠️ 并集合成：写回基底失败:', e);
        return 'failed';
    }
    console.log(`✅ 并集合成完成，影响 ${touched} 个像素（alpha 取并集）`);
    return 'written';
}

/**
 * 新图层模式的降级方案：把基底的 alpha **乘进填充层的 alpha**。
 *
 * 用在新图层模式（结果层要独立保留，不能写回基底）且原生剪贴蒙版被拒的时候。
 * 只读基底**自身**的 alpha 并相乘，**不追它更下方的剪贴链** —— 与原生剪贴
 * 单层约束的范围一致，是这个降级路径的已知边界。
 *
 * @returns false = 读不到像素，调用方应放弃这一步（填充结果保持原样）。
 */
export async function multiplyTopAlphaByBase(options: {
    docId: number;
    baseLayerId: number;
    topLayerId: number;
}): Promise<boolean> {
    const { docId, baseLayerId, topLayerId } = options;
    const { width, height } = getDocPixelSize();
    if (width <= 0 || height <= 0) return false;

    // ⚠️ 按两张图各自的 `boundsNoEffects` 读（不是文档矩形），再按 sourceBounds 索引扩充。
    const baseBlock = await readLayerBlock(docId, baseLayerId);
    const topBlock = await readLayerBlock(docId, topLayerId);
    if (!baseBlock || !topBlock) return false;
    if (topBlock.components !== 4) {
        console.warn('⚠️ 填充层没有 alpha 分量，无法施加剪贴约束');
        return false;
    }

    const out = expandToDocument(topBlock, width, height);
    const bc = baseBlock.components;

    for (let y = 0; y < topBlock.height; y++) {
        const dy = topBlock.top + y;
        if (dy < 0 || dy >= height) continue;
        for (let x = 0; x < topBlock.width; x++) {
            const dx = topBlock.left + x;
            if (dx < 0 || dx >= width) continue;

            // 基底在这一点的 alpha（基底块之外一律视为 0）
            let baseA = 0;
            const bx = dx - baseBlock.left;
            const by = dy - baseBlock.top;
            if (bx >= 0 && bx < baseBlock.width && by >= 0 && by < baseBlock.height) {
                const bi = (by * baseBlock.width + bx) * bc;
                baseA = bc === 4 ? baseBlock.data[bi + 3] : 255;
            }
            if (baseA === 255) continue;

            const d = (dy * width + dx) * 4;
            const topA = out[d + 3];
            if (topA === 0) continue;
            out[d + 3] = Math.round(topA * baseA / 255);
        }
    }

    try {
        await writeDocument(docId, topLayerId, out, width, height, 4);
    } catch (e) {
        console.warn('⚠️ 收窄填充层 alpha 失败，放弃这一步:', e);
        return false;
    }
    console.log('✅ 已按基底 alpha 收窄填充层（原生剪贴不可用时的降级）');
    return true;
}
