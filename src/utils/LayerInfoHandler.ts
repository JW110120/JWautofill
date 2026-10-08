import { app, action } from 'photoshop';

export interface LayerInfo {
    isBackground: boolean;
    hasTransparencyLocked: boolean;
    hasPixels: boolean;
    isInQuickMask: boolean;
    isInLayerMask: boolean;
    isInSingleColorChannel: boolean;
    /**
     * 活动图层当前是否被隐藏。
     * 填充路径需要它来决定「要不要临时 show → 填充 → 恢复 hide」；
     * 旧实现在 fillSelection 里单独再读一次 `activeLayers[0].visible`（2 次 IPC），
     * 现在随 layerInfo 一起带回，零额外往返。
     */
    isHidden?: boolean;
}

/**
 * 图层信息的缓存有效期（毫秒）。
 *
 * 为什么需要缓存：`getActiveLayerInfo` 的消费方遍布多处（填充 / 图案 / 渐变 /
 * 颜色面板的每个 effect），而每次调用都要打若干次**同步**宿主 get。
 * 同一次填充流程里它会被连续调用多次（填充路径 + 面板巡检 tick），
 * 而这些调用之间图层结构/通道选择**不可能变化**（都发生在同一次 executeAsModal 内）。
 *
 * 取 300ms：要大于「一次填充 + 紧随其后的巡检 tick」的间隔，又要小到用户
 * 手动改通道 / 切图层后不会看到过期状态（那种操作本身也会派发通知，会主动失效缓存）。
 */
const CACHE_TTL_MS = 300;

/**
 * 缓存条目：key = 活动图层 id（PS 会在换图层 / 换文档时换id ⇒ 自动 miss）。
 */
let cacheKey: string | null = null;
let cacheValue: LayerInfo | null = null;
let cacheStamp = 0;

function nowMs(): number {
    return Date.now();
}

/**
 * 主动失效缓存。
 *
 * 必须在「图层结构 / 通道选择可能变了」的时机调用：
 *   · 收到 make / delete / select 通知（新建、删除、切图层、切通道、切文档）；
 *   · 填充/ 描边 / 蒙版同步等会改动图层的命令**之后**；
 *   · 插件挂载与卸载时。
 *
 * ⚠️ 不要在纯选区 set 事件里失效：选区变化**不影响**本缓存的任何一个字段
 *（isBackground / transparentPixelsLocked / kind / bounds / 通道索引），
 * 失效只会白白丢掉缓存命中率，正好抵消这次优化的收益。
 */
export function invalidateLayerInfoCache(): void {
    cacheKey = null;
    cacheValue = null;
    cacheStamp = 0;
}

/** 判断某个事件是否需要让图层信息缓存失效。 */
export function shouldInvalidateLayerInfo(eventName?: string, descriptor?: any): boolean {
    if (eventName === 'make' || eventName === 'delete' || eventName === 'clearEvent') {
        return true;
    }
    if (eventName === 'select') {
        // 切活动文档 / 图层 / 通道都会改变 layerInfo 的内容
        return true;
    }
    if (eventName === 'set') {
        const target = descriptor?._target;
        if (!Array.isArray(target)) return false;
        // ⚠️ channel/selection 是**选区**变化，与本缓存无关 ⇒ 不失效（保留命中率）。
        return target.some(
            (t: any) => t && (t._ref === 'layer' || t._ref === 'document' || t._ref === 'channel')
                && !(t._ref === 'channel' && t._property === 'selection')
        );
    }
    return false;
}

/** 从 DOM 属性读出「不需要 batchPlay」的那部分字段。 */
function readLayerDomInfo(doc: any): LayerInfo | null {
    const activeLayer = doc.activeLayers && doc.activeLayers.length > 0 ? doc.activeLayers[0] : null;
    if (!activeLayer) return null;

    const isBackgroundLayer = !!activeLayer.isBackgroundLayer;
    // ⚠️ bounds 只读一次并复用：bounds 本身是一次宿主 get，
    // 再对它取 .width/.height 会各多一次（旧代码里 checkLayerHasPixels 就是这么写的）。
    //
    // ⚠️⚠️ 背景图层**也必须**读 bounds：旧 checkLayerHasPixels 对所有图层一视同仁，
    // 而 hasPixels 是 app.tsx 里 `hasTransparencyLocked && hasPixels` 这个分支的判据。
    // 若对背景图层跳过 bounds 而硬给 false，背景图层就会被误判成「无像素」
    // ⇒ 走进 fillLockedWithoutPixels（解锁→填充→重锁）而不是 fillBackground，
    // 属于**功能行为回归**（多两次 applyLocking、锁定状态可能被改写）。
    const bounds = activeLayer.bounds;
    const hasPixels = activeLayer.kind === 'pixel'
        && !!bounds && bounds.width > 0 && bounds.height > 0;

    return {
        isBackground: isBackgroundLayer,
        hasTransparencyLocked: !!activeLayer.transparentPixelsLocked,
        hasPixels,
        isHidden: !activeLayer.visible,
        // ⚠️ 快速蒙版 / 图层蒙版 / 单通道三个字段在 probeChannelState() 里补齐
        isInQuickMask: false,
        isInLayerMask: false,
        isInSingleColorChannel: false
    };
}

/**
 * 一次 batchPlay 同时取「目标通道」与「图层蒙版通道」两条信息。
 *
 * 优化前checkLayerMaskMode + checkSingleColorChannelMode 是**两个独立方法**，
 * 且后者内部又完整调了一次前者 ⇒ 单次 getActiveLayerInfo 里
 * 「取蒙版通道」这组get 被跑了两遍（4 次同步 get）。合并后只跑一遍（2 次），
 * 且两次 get 放在**同一个 batchPlay 数组**里，一次 IPC 往返拿全。
 */
/**
 * 探测「是否在编辑图层蒙版/ 单个颜色通道」。
 *
 * ⚠️⚠️ 快速蒙版下**必须跳过 mask 通道 get**（2026-10-08 用户实测报错）：
 *  快速蒙版时 PS 的 mask 通道语义与常规不同，`get channel mask` 是本函数里
 *  唯一会失败的一条命令。而 2026-10-08 之前它被单独调用、且外面包着 try/catch；
 *  合并成「两条 get 同批下发」之后，**第一条失败会连带整批失败**，
 *  且宿主对失败命令的原生报错框**绕过 JS try/catch** ⇒ 快速蒙版下三种填充
 *  （含打开图案/渐变面板时的灰色预览）全部报「命令"获取"当前不可用」。
 *  快速蒙版下 `isInLayerMask` 本来就无意义（`inQuickMask` 会把单通道判定排除），
 *  所以直接跳过这条 get —— 既修掉报错，又少一次 IPC。
 *
 * 另外两条 get 也**分开下发**（而非同批）：保持「一条失败不影响另一条」的语义，
 * 这与合并前的旧行为一致。
 */
async function probeChannelState(): Promise<{ inLayerMask: boolean; inSingleChannel: boolean }> {
    const result = { inLayerMask: false, inSingleChannel: false };
    try {
        const doc0: any = app.activeDocument;

        // ---- 多通道保护（必须**独立** try/catch，见下方根因说明）----
        // ⚠️⚠️ 图层蒙版激活时读取 `doc.activeChannels` 会**抛异常**
        //   （"Unknown or unsupported active channels"，PS 官方论坛与 UXP 文档均确认：
        //    图层蒙版/快速蒙版激活时该属性不可用）。这**不是**「多通道选择」，恰恰是
        //    「正在编辑蒙版」的强信号 —— 必须吞掉异常**继续往下探测**，否则整段探测
        //    直接 return 两个 false ⇒ `isInLayerMask` 恒为 false：
        //      · 图案/渐变填充落到常规分支 ⇒ 写进新建的 RGB 图层而非图层蒙版；
        //      · 「仅描边」落到像素图层分支（还会 make layer）⇒ 描在 RGB 图层上；
        //      · 「仅清除」落到像素清除分支 ⇒ 纯色走 clearEnum 的 fill，弹原生「填充」框；
        //      · 「描边+清除」落到像素清除分支 ⇒ clearEnum 的 stroke，弹原生「描边」框。
        //    ⇒ 图层蒙版 12 组合里 11 组失效，全由这一处引起（2026-10-08 用户实测）。
        //    ⚠️ 旧实现本就把这段包在内层 try/catch 里；9a909c0 把两个探测合并成
        //       probeChannelState 时**丢掉了内层 catch**，异常逃逸到外层 ⇒ 属**回归**。
        try {
            const activeChannelsCount = doc0?.activeChannels?.length || 0;
            if (activeChannelsCount > 1) return result;
        } catch (e) {
            // 吞掉即可：图层蒙版/快速蒙版激活 ⇒ 继续原样探测（与旧实现一致）
        }

        const inQuickMask = !!doc0?.quickMaskMode;

        // ---- 目标通道（两条判定都要它）----
        let targetChannelInfo: any = null;
        try {
            const r = await action.batchPlay(
                [
                    {
                        _obj: 'get',
                        _target: [{ _ref: 'channel', _enum: 'ordinal', _value: 'targetEnum' }],
                        _options: { dialogOptions: 'dontDisplay' }
                    }
                ],
                { synchronousExecution: true }
            );
            targetChannelInfo = r?.[0] || null;
        } catch {
            // 目标通道取不到 ⇒ 按「非单通道/非蒙版」处理（与旧实现一致）
            return result;
        }

        // ---- 图层蒙版通道（快速蒙版下跳过，见上方说明）----
        if (!inQuickMask) {
            try {
                const r = await action.batchPlay(
                    [
                        {
                            _obj: 'get',
                            _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
                            _options: { dialogOptions: 'dontDisplay' }
                        }
                    ],
                    { synchronousExecution: true }
                );
                const maskChannelName = r?.[0]?.channelName;
                const targetChannelName = targetChannelInfo?.channelName;
                // 图层蒙版：目标通道就是 mask 通道
                if (maskChannelName && targetChannelName && maskChannelName === targetChannelName) {
                    result.inLayerMask = true;
                }
            } catch {
                // 取不到 mask 通道 ⇒ 视为「不在图层蒙版」（旧实现同样catch 后返回 false）
            }
        }

        const targetChannelName = targetChannelInfo?.channelName;
        const itemIndex = typeof targetChannelInfo?.itemIndex === 'number' ? targetChannelInfo.itemIndex : -1;

        // RGB 单通道：通道名命中红/绿/蓝（R/G/B 及中英文各拼写都收，兼容旧逻辑的名单）
        const rgbChannels = ["红", "绿", "蓝", "Red", "Grain", "Blue", "R", "G", "B"];
        const isRgbChannel = !!targetChannelName && rgbChannels.indexOf(targetChannelName) >= 0;
        // Alpha 通道：索引 >= 4，且既不在快速蒙版也不在图层蒙版
        const isAlphaChannel = itemIndex >= 4 && !inQuickMask && !result.inLayerMask;

        result.inSingleChannel = isRgbChannel || isAlphaChannel;
    } catch {
        // 取不到就按「普通像素图层」处理，不阻断主流程（旧逻辑同样是 catch 后返回 false）
    }
    return result;
}

export class LayerInfoHandler {
    /**
     * 取当前活动图层信息。
     *
     * 性能契约（2026-10-08）：
     *   · 缓存命中 → **0 次** IPC；
     *   · 缓存未命中 → **1 次** batchPlay（内部两条 get 同批下发）+ 少量 DOM 属性读。
     * 优化前是 6~7 次独立的同步 batchPlay get（约 18 次 IPC 往返）。
     */
    static async getActiveLayerInfo(): Promise<LayerInfo | null> {
        try {
            const doc = app.activeDocument;
            if (!doc) return null;

            const activeLayer = doc.activeLayers && doc.activeLayers.length > 0 ? doc.activeLayers[0] : null;
            if (!activeLayer) return null;

            // 缓存 key 用活动图层 id：PS 的图层 id 在**整个宿主会话内唯一**，
            // 因此不必再读 doc.id（那也是一次宿主 get）。换图层 / 换文档都会自动 miss。
            const key = `${activeLayer.id}`;
            if (cacheKey === key && cacheValue && nowMs() - cacheStamp < CACHE_TTL_MS) {
                return cacheValue;
            }

            const domInfo = readLayerDomInfo(doc);
            if (!domInfo) return null;

            const channelState = await probeChannelState();
            const info: LayerInfo = {
                isBackground: domInfo.isBackground,
                hasTransparencyLocked: domInfo.hasTransparencyLocked,
                hasPixels: domInfo.hasPixels,
                isHidden: domInfo.isHidden,
                isInQuickMask: !!doc.quickMaskMode,
                isInLayerMask: channelState.inLayerMask,
                isInSingleColorChannel: channelState.inSingleChannel
            };

            cacheKey = key;
            cacheValue = info;
            cacheStamp = nowMs();
            return info;
        } catch (error) {
            return null;
        }
    }

    /**
     * 检测是否在编辑图层蒙版（保留旧签名，旧调用点无需改动）。
     * ⚠️ 现在只做一次通道探测，不再像旧实现那样额外跑两遍 get。
     */
    static async checkLayerMaskMode(): Promise<boolean> {
        const info = await this.getActiveLayerInfo();
        return !!info?.isInLayerMask;
    }

    /**
     * 检测是否选中了单个颜色通道（红/绿/蓝/Alpha）。
     * ⚠️ 现在复用 getActiveLayerInfo 的缓存 —— 旧实现里每次调用都重新跑一遍
     * 「取mask 通道 + 取目标通道 + 取快速蒙版 + 再取一次蒙版」共约 7 次 IPC。
     */
    static async checkSingleColorChannelMode(): Promise<boolean> {
        const info = await this.getActiveLayerInfo();
        return !!info?.isInSingleColorChannel;
    }
}