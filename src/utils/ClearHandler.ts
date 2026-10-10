import { action, app, core, imaging } from "photoshop";
import { calculateRandomColor, hsbToRgb, rgbToGray } from './ColorUtils';
import { Pattern } from '../types/state';
import {
    clearStrength,
    clearChannelValue,
    clearAlphaValue,
    clearBackgroundColor,
    BackgroundClearAlgorithm,
    BinaryClearAlgorithm,
} from './ClearAlgorithms';

/**
 * 清除内容的灰度数据包：F（灰度）与可选 α（内容自身透明度）。
 * 四类内容（纯色/图案/渐变/描边）在本文件里都归约成这个形状，
 * 后面的写回路径不再区分内容类型 —— 这正是「合并多余算法」的落点。
 */
/**
 * 一个文档坐标下的矩形（左/上/右/下，右/下不含）。
 * 用于「读区域」与「图层像素边界」两处 —— 抽成具名类型是为了让
 * 回归台架能干净地切出这些方法执行（见 outputs/clear_pixel_geometry_verify.cjs）。
 */
type PixelRect = { left: number; top: number; right: number; bottom: number };

/**
 * 背景图层解锁结果。⛔ 必须一起带出 `layerId`：真机上该转换可能换掉图层 id，
 * 用旧 id 继续读写会命中 `invalid target sheet`。
 */
interface BackgroundUnlockResult {
    converted: boolean;
    layerId: number;
}

/** 活动图层最小快照（只取 id 与背景标记；任一项读不到即 null） */
interface ActiveLayerSnapshot {
    id: number | null;
    isBackgroundLayer: boolean | null;
}

interface ClearFillData {
    gray: Uint8Array;
    alpha?: Uint8Array;
}

/**
 * 一次「读像素 → 改写 → 写回」的数据块。
 *
 * ⚠️ 数据与几何必须**成对传递**：`left/top/width/height` 是数据真正覆盖的文档矩形，
 *    由 `imaging.getPixels` 的**返回值 `sourceBounds`** 给出，**不是**我们请求的区域
 *    （PS 会把请求区域裁剪到「真有像素」的范围）。下标换算一律走这块几何。
 */
interface LayerPixelBlock {
    data: Uint8Array;
    /** 每像素分量数：3 = RGB（无 alpha，背景式目标）/ 4 = RGBA（普通像素图层） */
    components: number;
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * **文档全尺寸**的写回缓冲（不是图层边界，也不是选区外接矩形）。
 *
 * ⚠️⚠️ 这个「全文档」不是性能取舍，而是正确性的**硬要求**，理由见
 *    `writeLayerPixels` 的注释（`putPixels` 的 `replace` 默认为 true）。
 *    缓冲区里「选区外」的字节就是读取时的原值 ⇒ 写回后严格恒等，
 *    这就是用户要求的「选区外部不受影响」。
 */
interface DocumentPixelBlock {
    data: Uint8Array;
    components: number;
    width: number;
    height: number;
}

/**
 * 背景图层 → 普通图层（PS 菜单「图层来自背景」/ Layer From Background）。
 *
 * ⛔ 描述符**逐字取自用户真机监听到的 PS 自身下发内容**，不得凭外部检索改写；
 *    唯一的改动是把记录里的 `layerID: 4` 换成运行时的目标图层 id。
 *
 * ⚠️ 必须在 `core.executeAsModal` 作用域内调用（本项目所有像素/图层写操作的要求）。
 * ⚠️ 该描述符会把不透明度/混合模式置为 100 / normal —— 这是记录里 PS 自己下发的值，
 *    背景图层在 PS 中恒为「100% + 正常」，故正常路径下不会丢失用户设置。
 *
 * ⛔⛔ **这个命令在真机上「报错但生效」**（2026-10-08 用户实测 + 控制台证据链）：
 *    它会把背景图层真的变成普通像素图层，**同时**命令以 `invalid target sheet` 报错。
 *    ⇒ **绝不能用「有没有抛错」判定解锁成功**，必须以回读 `isBackgroundLayer` 为准
 *      （见 `unlockBackgroundLayer`）。旧实现把它当失败 ⇒ 既不还原背景图层，
 *      又在「刚被改过类型」的图层上继续读像素而失败。
 */
const BACKGROUND_TO_LAYER_DESCRIPTOR = {
    _obj: "set",
    _target: [{ _ref: "layer", _property: "background" }],
    to: {
        _obj: "layer",
        opacity: { _unit: "percentUnit", _value: 100 },
        mode: { _enum: "blendMode", _value: "normal" },
    },
    _isCommand: false,
};

/**
 * 普通图层 → 背景图层（PS 菜单「背景来自图层」/ Background From Layer）。
 *
 * ⛔ 同上，描述符逐字取自用户真机监听，不得改写。
 * ⚠️ 该命令会把图层的透明区**按背景色合成掉**（默认白）—— 这正是「橡皮擦背景图层」
 *    观感的来源；本文件在背景族算法下 alpha 恒为 255，故合成是恒等操作，
 *    它的作用只是把图层类型还给用户（不清除模式不该永久改动用户的图层结构）。
 */
const LAYER_TO_BACKGROUND_DESCRIPTOR = {
    _obj: "make",
    _target: [{ _ref: "backgroundLayer" }],
    using: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
    _isCommand: false,
};

export class ClearHandler {
    /**
     * 清除模式总入口（由 app.tsx 的 fillSelection 调用）。
     *
     * 分发只剩三级，与 utils/ClearAlgorithms.ts 的三类目标一一对应：
     *   快速蒙版 / 图层蒙版 → 第二类「黑白通道」；像素图层与背景图层 → 第三类/第一类。
     *   （单一通道另有 SingleChannelHandler，它在 app.tsx 就更早分流，不经过这里。）
     */
    static async clearWithOpacity(opacity: number, state?: any, layerInfo?: any) {
        try {
            const document = app.activeDocument;

            if (document.quickMaskMode && state) {
                await this.clearInQuickMask(state);
                return;
            }

            if (layerInfo && layerInfo.isInLayerMask && state) {
                await this.clearLayerMask(state, opacity);
                return;
            }

            if (state) {
                await this.clearPixelLayer(state, opacity, layerInfo);
            }
        } catch (error) {
            console.error('清除选区失败:', error);
            throw error;
        }
    }

    //=================================================================================
    // 第一类（背景图层）/ 第三类（普通像素图层）—— 读像素 → 改 → 写回
    //=================================================================================

    /**
     * 背景图层与普通像素图层的统一清除入口。
     *
     * 两类目标共用同一条「读取 → 逐像素改写 → 写回」的流水线：
     *   · 背景图层      ⇒ 先转成普通像素图层，再改写 R/G/B（提亮 / 减黑 / 乘黑），最后转回背景图层；
     *   · 普通像素图层  ⇒ RGB 不动、只改写 A（减法 / 乘法降低不透明度）。
     * 重构前这两类目标分别走 levels / clearEnum / putSelection+delete 三条宿主路径，
     * 结果不可预测（背景图层图案清除会变成「填背景色」）；现在全部由本文件算出结果。
     *
     * ⚠️⚠️ 2026-10-08 真机二次修复（用户报告：普通像素图层与背景图层都会把**选区外**
     *     整层像素变成透明 / 变白）。根因见 `writeLayerPixels` 的注释 —— `putPixels` 的
     *     `replace` 默认为 true，局部写会把整层内容先清空。现在统一改为
     *     「文档全尺寸缓冲 + 原点写回」，与 MaskSyncEngine / pixelDataProcessor /
     *     knockoutBatchProcessor 三处已验证的整图写回完全一致。
     *
     * ⚠️ 走哪一类由 `layer.isBackgroundLayer`（DOM 实测）决定；`layerInfo` 只是探测快照，
     *    可能滞后于刚刚发生的图层类型变化，仅在 DOM 读不到该属性时兜底。
     *
     * ⛔⛔ 2026-10-08 真机**第三次**修复（背景图层：解锁后什么都没发生、也没还原成背景图层，
     *    控制台报 `invalid target sheet`）—— 关键结论：**图层类型转换之后一次 DOM 都不要读**，
     *    docId / 目标图层 id / 读区域必须前置捕获；解锁成败以**回读图层类型**为准。
     *    完整证据链与推演见方法体首段注释。
     */
    static async clearPixelLayer(state: any, opacity: number, layerInfo?: any) {
        try {
            const bounds = await this.getSelectionData();
            if (!bounds) {
                console.warn('❌ 没有选区，无法执行清除操作');
                return;
            }

            const fill = await this.buildClearFillData(state, bounds);
            if (!fill) return;

            // ⛔⛔ 2026-10-08 真机第三次修复（用户报告：背景图层「解锁后什么都没发生、
            //     也没有还原成背景图层」，控制台报 `invalid target sheet`）。证据链：
            //       ① 报错上方那行是 `⚠️ 背景图层解锁失败（将按背景图层原样处理）`
            //          —— 该文案全仓只出现在 `unlockBackgroundLayer` 的 catch 里；
            //       ② 用户同时看到「背景图层已经变成普通像素图层」。
            //     ⇒ 真相：**解锁命令确实把图层类型改掉了，但命令本身报错**。
            //       旧实现把「抛错」当「没解锁」⇒ 不还原背景图层；而且紧接着
            //       `app.activeDocument.activeLayers[0]` / `layer.boundsNoEffects`
            //       又一次读取「刚被改过类型」的图层 ⇒ 抛 `invalid target sheet`，
            //       而 `boundsNoEffects` 那处在 try 之外 ⇒ 异常直接逃逸、整轮静默失败。
            //     ⇒ 现在：**转换后一次 DOM 都不读**。docId / 目标图层 id / 读区域
            //       全部在转换前取好，像素读写只吃这些数字。
            let layer: any = app.activeDocument.activeLayers[0];
            if (!layer) {
                console.warn('⚠️ 取不到活动图层，跳过清除');
                return;
            }
            // ① 前置捕获（**必须在图层类型转换之前**，见上方说明）：
            //    docId / 文档尺寸 / 目标图层 id / 读区域。
            const docId = app.activeDocument.id;
            const docW = Math.max(1, Math.round(Number(bounds.docWidth) || 1));
            const docH = Math.max(1, Math.round(Number(bounds.docHeight) || 1));
            let targetLayerId = layer.id;

            // 背景图层判定以 DOM 实测为准（layerInfo 可能滞后于图层类型变化）
            const isBackground = typeof layer.isBackgroundLayer === 'boolean'
                ? layer.isBackgroundLayer
                : !!(layerInfo && layerInfo.isBackground);

            // 读区域：按**图层实有像素边界**（`boundsNoEffects`）取，与普通图层同口径 ——
            // 本仓已记录过「全文档 sourceBounds 在图层没画满画布时会被裁剪甚至报
            // `Missing image`」（`MaskSyncEngine` 实测），所以不改成读文档矩形。
            // ⚠️ 这一次读必须在**图层类型转换之前**完成（转换后读图层属性可能抛
            //    `invalid target sheet`）；背景图层恒铺满画布，转换也不会改动像素范围。
            const layerBounds = this.readLayerBounds(layer);
            const readRegion: PixelRect = layerBounds || { left: 0, top: 0, right: docW, bottom: docH };
            if (!layerBounds) {
                console.warn('⚠️ 取不到图层像素边界，退回按文档矩形读取:', readRegion);
            }

            // ② 边界处理③：若锁了「透明像素」，写回 alpha 会被 PS 静默忽略
            //    ⇒ 必须先解锁、清除完再还原锁定状态。
            // ⚠️ 这一读必须放在**图层类型转换之前**：转换后旧代理可能失效，
            //    而且背景图层本来就不可能有这个锁（needUnlockPixels 对背景恒为 false）。
            let transparencyLocked = !!(layerInfo && layerInfo.hasTransparencyLocked);
            try {
                if (typeof layer.transparentPixelsLocked === 'boolean') {
                    transparencyLocked = layer.transparentPixelsLocked;
                }
            } catch (e) {
                // 探测失败不能影响主流程（回归高发点：多步探测的每一步都要自带 catch）
                console.warn('⚠️ 读取「锁定透明像素」状态失败，回退到 layerInfo:', e);
            }
            const needUnlockPixels = !isBackground && transparencyLocked;

            // ③ 背景图层 → 普通像素图层（「图层来自背景」）。
            //    为什么必须解锁：`putPixels` 的契约原文是「The target layer must be a pixel layer」，
            //    背景图层上写会报 `invalid target sheet`（真机实测）。
            //    ⚠️ 成败以**回读图层类型**为准（命令会报错但生效），且回读顺带刷新图层 id。
            let backgroundUnlocked = false;
            if (isBackground) {
                const unlock = await this.unlockBackgroundLayer(targetLayerId);
                backgroundUnlocked = unlock.converted;
                targetLayerId = unlock.layerId;
                if (!backgroundUnlocked) {
                    console.warn('⛔ 背景图层未能转为普通像素图层，本轮不写回（背景图层无法被 putPixels 写入）');
                }
            }

            if (needUnlockPixels) {
                await this.setTransparencyLock(false);
            }

            try {
                // ⚠️ 这里**不允许**再读 `app.activeDocument` / 图层属性：转换后这些读取
                //    可能抛 `invalid target sheet`，用前置捕获的 docId / targetLayerId / 读区域。
                if (backgroundUnlocked || !isBackground) {
                    const block = await this.readLayerPixels(targetLayerId, docId, readRegion);
                    if (!block) {
                        console.warn('⚠️ 目标图层没有可读像素（空图层 / 全透明），跳过清除');
                    } else if (block.components !== 3 && block.components !== 4) {
                        console.warn(`⚠️ 目标像素分量数异常（${block.components}），跳过清除`);
                    } else {
                        // 摊平成文档全尺寸缓冲：图层没有像素的地方保持全 0（透明），
                        // 选区外的字节 = 读出来的原值 ⇒ 写回后严格恒等。
                        const docBlock = this.expandToDocument(block, bounds);
                        if (isBackground) {
                            this.applyBackgroundClear(docBlock, fill, opacity, bounds, state);
                        } else {
                            this.applyLayerAlphaClear(docBlock, fill, opacity, bounds, state);
                        }
                        await this.writeLayerPixels(docBlock, targetLayerId, docId);
                    }
                }
            } finally {
                if (needUnlockPixels) {
                    await this.setTransparencyLock(true);
                }
                // ④ 还原背景图层。放在 finally 里：即使上面抛错也要还，
                //    否则用户的图层结构被永久改动（不清除模式不该有这种副作用）。
                //    ⚠️ 目标校验在 lockBackgroundLayer 内部做，且是**尽力而为**的：
                //    读不到活动图层也照常还原（不还原才是更糟的结果）。
                if (backgroundUnlocked) {
                    await this.lockBackgroundLayer(targetLayerId);
                }
            }

            // ⚠️ 无条件还原选区：`getSelectionData` 内部已把选区取消，
            //    若因「无像素可改」提前跳过写回，用户会白丢一次选区。
            await this.restoreSelectionIfKept(bounds, state);
        } catch (error) {
            console.error('❌ 像素图层清除失败:', error);
            throw error;
        }
    }

    /**
     * 把当前「内容」归约成选区内的灰度 F 与可选透明度 α。
     * 三种内容共用一个出口，缺预设时弹原生提示并返回 null（调用方据此放弃本轮）。
     *
     * @param foregroundColor 快速蒙版必须在**退出快速蒙版之前**抓取前景色后传入
     * @param quickMask       快速蒙版的纯色抖动走灰度通道口径（与像素图层不同）
     */
    static async buildClearFillData(
        state: any,
        bounds: any,
        foregroundColor?: any,
        quickMask: boolean = false
    ): Promise<ClearFillData | null> {
        if (state.fillMode === 'pattern') {
            if (!state.selectedPattern) {
                await core.showAlert({ message: '请先选择一个图案预设' });
                return null;
            }
            const gray = await this.getPatternFillGrayData(state, bounds);
            // 边界处理②：图案自带透明区（α = 0）的位置必须保持目标像素不变。
            // 透传 α 后由 clearStrength 归零 t，语义即为「该处不参与清除」。
            const alpha = await this.generateLayerMaskAlphaData(state.selectedPattern, bounds);
            return { gray, alpha: alpha || undefined };
        }

        if (state.fillMode === 'gradient') {
            if (!state.selectedGradient) {
                await core.showAlert({ message: '请先选择一个渐变预设' });
                return null;
            }
            const gray = await this.getGradientFillGrayData(state, bounds);
            // 边界处理④：渐变透明度**只在这里**生效一次。
            // 重构前 getGradientFillGrayData 已把 stop 不透明度乘进灰度，这里又乘一次 α
            // ⇒ 半透明区段被平方衰减。现在灰度是纯颜色灰度，α 独立承载不透明度。
            const alpha = await this.generateGradientAlphaData(state, bounds);
            return { gray, alpha: alpha || undefined };
        }

        const gray = await this.getSolidFillGrayData(state, bounds, foregroundColor, quickMask);
        return { gray };
    }

    /**
     * 第一类 · 背景图层：改写 R/G/B（提亮 / 减法变黑 / 乘法变黑）。
     *
     * 缓冲区是**文档全尺寸**的，下标直接用文档坐标换算（`docY * docWidth + docX`），
     * 与 `selectionDocIndices` 的构造口径（同一个 `docWidth`）严格一致 —— 不再有任何
     * 「块内偏移」环节，也就不存在偏移错位这一类缺陷。
     *
     * ⚠️ **只改写落在选区内的像素**：遍历的是 `selectionDocIndices`（选区掩码 > 0 的文档索引），
     *    选区外的字节在缓冲区里保持读出来的原值 ⇒ 用户要求的「选区外部不受影响」由此保证。
     *    （这是第二道保险；第一道在 `writeLayerPixels` 的整图写回。）
     */
    static applyBackgroundClear(
        block: DocumentPixelBlock,
        fill: ClearFillData,
        opacity: number,
        bounds: any,
        state: any
    ) {
        const algo: BackgroundClearAlgorithm = state?.clearBackgroundAlgorithm || 'whiten';
        const { data, components, width, height } = block;

        const indices = bounds.selectionDocIndices ? Array.from<number>(bounds.selectionDocIndices) : [];
        const coeffs = bounds.selectionCoefficients;
        const docWidth = Math.round(bounds.docWidth);

        for (let i = 0; i < indices.length && i < fill.gray.length; i++) {
            const docIndex = indices[i];
            const docX = docIndex % docWidth;
            const docY = (docIndex - docX) / docWidth;
            if (docX < 0 || docY < 0 || docX >= width || docY >= height) continue;

            const t = clearStrength(opacity, fill.alpha && fill.alpha[i], coeffs && coeffs[i]);
            if (t <= 0) continue;

            const base = (docY * width + docX) * components;
            const gray = fill.gray[i];
            // 背景族只动 R/G/B：即便解锁后缓冲区是 RGBA，alpha 也保持 255（还原背景图层时无需合成）
            for (let c = 0; c < 3 && c < components; c++) {
                data[base + c] = clearBackgroundColor(data[base + c], gray, t, algo);
            }
        }
    }

    /** 第三类 · 普通像素图层：只改写 alpha（减法 / 乘法降低不透明度），RGB 原封不动 */
    static applyLayerAlphaClear(
        block: DocumentPixelBlock,
        fill: ClearFillData,
        opacity: number,
        bounds: any,
        state: any
    ) {
        const algo: BinaryClearAlgorithm = state?.clearLayerAlgorithm || 'multiply';
        const { data, components, width, height } = block;
        if (components < 4) {
            // 目标没有 alpha（读不到第 4 分量），无从「降低不透明度」
            console.warn('⚠️ 目标像素无 alpha 分量，跳过像素图层清除');
            return;
        }

        const indices = bounds.selectionDocIndices ? Array.from<number>(bounds.selectionDocIndices) : [];
        const coeffs = bounds.selectionCoefficients;
        const docWidth = Math.round(bounds.docWidth);

        for (let i = 0; i < indices.length && i < fill.gray.length; i++) {
            const docIndex = indices[i];
            const docX = docIndex % docWidth;
            const docY = (docIndex - docX) / docWidth;
            if (docX < 0 || docY < 0 || docX >= width || docY >= height) continue;

            const t = clearStrength(opacity, fill.alpha && fill.alpha[i], coeffs && coeffs[i]);
            if (t <= 0) continue;

            const aIndex = (docY * width + docX) * components + 3;
            data[aIndex] = clearAlphaValue(data[aIndex], fill.gray[i], t, algo);
        }
    }

    /**
     * 读取目标图层的**实有像素块**（1:1，不缩放、不重采样）。
     *
     * ⚠️⚠️ 改这里之前先把下面 6 条读完 —— 前两轮的真机缺陷全部出自这一类「参数级」踩坑：
     *
     *  ① **参数名是 `sourceBounds`，不是 `bounds`**。`GetPixelsOptions` 里没有 `bounds`
     *     字段 ⇒ 传它等于没传，PS 会按「整个图层」取值，再把整层**重采样**到 `targetSize`
     *     ⇒ 整幅画面被压进一个小矩形里。（`smartEdgeSmoothProcessor.ts` 早有同源记录。）
     *  ② **绝不传 `applyAlpha: true`**。官方原文：「If true, then RGBA pixels will be converted
     *     to RGB by matting on **white**. The returned imageData property will **not contain an
     *     alpha channel**.」⇒ 它专门抹掉普通像素图层最需要的 α，正是旧版那条
     *     「目标图层无 alpha 通道，跳过像素图层清除」的来源。
     *  ③ **按「图层实有像素边界」读**（`boundsNoEffects`，由调用方在转换图层类型**之前**
     *     取好并作为 `region` 传入），不要按选区、也不要按全文档：
     *     · 按选区读会漏掉「图层有像素但在选区外」的部分，而那些像素**必须原样写回**；
     *     · 全文档 `sourceBounds` 在图层没画满画布时会被裁剪甚至报 `Missing image`
     *       （`MaskSyncEngine` 的实测结论）。
     *     用 `boundsNoEffects` 而非 `bounds`：含效果的外扩范围不是像素。
     *  ④ **`targetSize` 与 `sourceBounds` 同尺寸** ⇒ 明确声明「不缩放」，数据 1:1。
     *  ⑤ **回读返回值**：`sourceBounds` 定原点（PS 会把请求区域裁剪到实有像素范围），
     *     `imageData.width/height` 定数组形状。用「请求值」当地图就会整体错位。
     *  ⑥ **不传 `colorProfile`**：读写都走文档自己的工作空间，往返即恒等；强行指定 sRGB
     *     会在读、写两侧各做一次色彩转换，留下舍入残差。
     *  ⑦ **本函数不做任何 DOM 读取**（`documentID` / `layerID` / `region` 全部由调用方传入）：
     *     背景图层解锁后读取图层/DOM 可能抛 `invalid target sheet`（真机实测）⇒
     *     像素读写只吃数字，这条是把「转换后零 DOM 读取」落地的关键一环。
     *
     * @returns null 表示没有可读像素（空图层 / 全透明 / 完全落在画布之外）
     */
    static async readLayerPixels(
        layerId: number,
        docId: number,
        region: PixelRect
    ): Promise<LayerPixelBlock | null> {
        const left = Math.round(Number(region.left) || 0);
        const top = Math.round(Number(region.top) || 0);
        const width = Math.round(Number(region.right) || 0) - left;
        const height = Math.round(Number(region.bottom) || 0) - top;
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
            // ⚠️ 宽高必须在 dispose() 之前读出来；数组形状以 imageData 实际宽高为准
            //    （请求尺寸可能被 UXP 取整/裁剪）
            const gotW = Math.max(1, Math.round(Number(result.imageData.width) || width));
            const gotH = Math.max(1, Math.round(Number(result.imageData.height) || height));
            const sb: any = result.sourceBounds;
            result.imageData.dispose();

            const components = Math.round(data.length / (gotW * gotH));
            if (components !== 3 && components !== 4) {
                console.warn(
                    `⚠️ 目标图层像素分量数异常（components=${components}，` +
                    `${gotW}x${gotH}，${data.length} 字节），放弃清除`
                );
                return null;
            }

            // 原点优先取返回的 sourceBounds（可能被裁剪），缺失时退回请求值
            const bLeft = sb && Number.isFinite(Number(sb.left)) ? Math.round(Number(sb.left)) : left;
            const bTop = sb && Number.isFinite(Number(sb.top)) ? Math.round(Number(sb.top)) : top;

            return { data, components, left: bLeft, top: bTop, width: gotW, height: gotH };
        } catch (e) {
            // PS 在「请求区域内没有任何像素」时会抛错（No pixels in the requested area）
            console.warn('⚠️ 读取目标图层像素失败（图层可能为空）:', e);
            return null;
        }
    }

    /**
     * 把「按图层边界读到的像素块」摊平成**文档全尺寸**的写回缓冲。
     *
     * 图层没有像素的地方保持全 0（= 透明）；落在画布之外的像素被丢弃 ——
     * 画布外像素不参与显示，本仓 `pixelDataProcessor` / `knockoutBatchProcessor`
     * 的整图写回也是这个口径（这里额外留一条 warn，让越界情形可被察觉）。
     */
    static expandToDocument(block: LayerPixelBlock, bounds: any): DocumentPixelBlock {
        const width = Math.max(1, Math.round(Number(bounds.docWidth) || 1));
        const height = Math.max(1, Math.round(Number(bounds.docHeight) || 1));
        const { components } = block;
        const data = new Uint8Array(width * height * components);

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
                    data[d + c] = block.data[s + c];
                }
            }
        }
        return { data, components, width, height };
    }

    /**
     * 整图写回：**文档全尺寸**缓冲 + 原点定位，不带 `targetBounds`。
     *
     * ⛔⛔ 这里是本轮两个真机缺陷（普通像素图层 / 背景图层都会把**选区外**整层像素
     *    变成透明或白色）的**唯一根因**，改之前务必读完官方原文：
     *
     *   `putPixels` → `replace`：
     *   「If true, then existing pixels in the layer are **discarded** before adding new
     *     pixels. If false, then the new pixels are added to the existing pixel content
     *     in the layer. **The default value is true.**」
     *
     *   ⇒ 只要给了 `targetBounds` 又没显式给 `replace`，PS 的语义就是
     *     **「先把整层内容清空，再把这块数据放到 targetBounds 处」**。
     *     原先在「选区外接矩形」上写回 ⇒ 选区外的整层像素被清空成透明
     *     （背景图层不能透明，PS 就按背景色填成白色）—— 与算法毫无关系。
     *
     *   本仓 `MaskSyncEngine` 早记过同源结论（「局部写 targetBounds + replace:false 不可靠，
     *   改用整图写回」）；`pixelDataProcessor` / `knockoutBatchProcessor` 的写回也都是整图。
     *
     * ⚠️ 因此本函数的契约是：`block` 必须是**文档全尺寸**（由 `expandToDocument` 产出），
     *    其中「选区外」的字节保持读取时的原值 ⇒ 整层被这份缓冲完整替换后严格恒等，
     *    这就是用户要求的「选区外部不受影响」。
     * ⚠️ 刻意**不传 `targetBounds`**：官方说明「If the value is not provided, then pixels are
     *    inserted at the origin `(0, 0)` of the document」，正是我们要的整图覆盖；
     *    而且 `targetBounds` 只认 `left` / `top`（「Dimension keys width and height are
     *    not used.」），尺寸一律取自 `imageData` 自身，传它只会让意图变得含混。
     * ⚠️ `colorSpace` / `pixelFormat` / `components` 三项组合与 `pixelDataProcessor` 的
     *    写回分支保持一致 —— 那是本仓已验证可用的像素写回实现。
     * ⚠️ 与 `readLayerPixels` 同理：**不做任何 DOM 读取**，`documentID` / `layerID`
     *    由调用方在图层类型转换**之前**取好并传入（转换后读 DOM 可能抛
     *    `invalid target sheet`）。
     */
    static async writeLayerPixels(block: DocumentPixelBlock, layerId: number, docId: number) {
        const imageData = await imaging.createImageDataFromBuffer(block.data, {
            width: block.width,
            height: block.height,
            components: block.components,
            chunky: true,
            colorSpace: 'RGB',
            pixelFormat: block.components === 4 ? 'RGBA' : 'RGB',
            componentSize: 8,
        });
        await imaging.putPixels({
            documentID: docId,
            layerID: layerId,
            imageData,
        });
        imageData.dispose();
    }

    /**
     * 边界处理③配套：设置 / 撤销「锁定透明像素」。
     * 描述符形状与 app.tsx 的 lockLayerTransparency / unlockLayerTransparency 完全一致
     * （必须走 `layerLocking` 子对象，不能写成 `transparency: true` —— 后者 PS 会静默忽略）。
     */
    static async setTransparencyLock(locked: boolean) {
        try {
            await action.batchPlay([{
                _obj: "applyLocking",
                _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                layerLocking: {
                    _obj: "layerLocking",
                    ...(locked ? { protectTransparency: true } : { protectNone: true }),
                },
                _options: { dialogOptions: "dontDisplay" },
            }], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
        } catch (e) {
            console.warn('⚠️ 切换透明像素锁定失败:', e);
        }
    }

    /**
     * 背景图层 → 普通像素图层（PS 菜单「图层来自背景」/ Layer From Background）。
     *
     * ⚠️ 为什么必须解锁：
     *   · `putPixels` 的契约原文是「`layerID` — The id of the target layer.
     *     **The target layer must be a pixel layer.**」，背景图层不是像素图层；
     *   · 解锁后读取恒为 RGBA（4 分量），彻底消除「3 分量 / 4 分量」的分歧，
     *     也让背景族算法与像素族算法共用同一条读写流水线。
     * ⚠️ 清除完成后**必须**用 `lockBackgroundLayer` 还原 —— 不清除模式不该永久改动
     *    用户的图层结构（这一步在 `clearPixelLayer` 的 finally 里，异常也会还）。
     *
     * ⛔⛔ **判定标准是「回读到的图层类型」，不是「有没有抛错」**（真机实测）：
     *      该命令会报 `invalid target sheet`，但图层类型**确实已经改掉**。
     *      旧实现把抛错当失败（返回 false）⇒ ① 不还原背景图层；
     *      ② 后续仍按「背景图层」继续，读像素/写像素全部失败。
     *
     * @returns `converted` = 图层类型是否**确认**已是普通图层（读不到类型时按「继续尝试」处理，
     *          只有明确读到「仍是背景图层」才判失败）；
     *          `layerId` = 转换后的目标图层 id（PS 内部实现可能换掉 id，必须用回读值）
     */
    static async unlockBackgroundLayer(layerId: number): Promise<BackgroundUnlockResult> {
        try {
            const result = await action.batchPlay(
                [{ ...BACKGROUND_TO_LAYER_DESCRIPTOR, layerID: layerId }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
            const err = this.batchPlayError(result);
            if (err) {
                console.warn('⚠️ 背景图层解锁命令回报了错误（可能仍然生效，下面回读图层类型确认）:', err);
            }
        } catch (e) {
            console.warn('⚠️ 背景图层解锁命令被拒绝（可能仍然生效，下面回读图层类型确认）:', e);
        }

        // ⛔ 只信回读结果。读不到（null）不等于失败：真机上「刚改过图层类型」的窗口里
        //    读取本身就可能失败，若据此判失败，用户会永远清不掉背景图层。
        const cur = await this.readActiveLayer();
        if (cur && cur.isBackgroundLayer === true) {
            console.warn('⚠️ 回读结果：目标仍是背景图层 ⇒ 解锁未生效，跳过本轮清除');
            return { converted: false, layerId };
        }
        if (!cur || cur.isBackgroundLayer === null) {
            console.warn('⚠️ 回读不到图层类型 ⇒ 无法确认解锁是否生效，仍按「已解锁」继续（写回失败会另行报错）');
        } else {
            console.log(`✅ 背景图层已解锁（目标图层 id ${cur.id ?? layerId}）`);
        }
        return { converted: true, layerId: cur && cur.id !== null ? cur.id : layerId };
    }

    /**
     * 普通图层 → 背景图层（PS 菜单「背景来自图层」）：`unlockBackgroundLayer` 的还原步骤。
     *
     * ⛔ 描述符形状逐字取自用户真机监听（`make {_ref:"backgroundLayer"}` + `using: {layer, targetEnum}`），不得改写。
     * ⚠️ 还原打的是 `targetEnum` = **活动图层**，理论上应先确认活动图层仍是目标图层；
     *    但真机实测「刚改过图层类型」的窗口里读活动图层可能抛错，所以这里的校验是**尽力而为**：
     *    读不到也照常还原并 warn —— 不还原才是更糟的结果（用户的图层结构被永久改成普通图层，
     *    正是上一轮的真机缺陷）。只有**明确读到**活动图层已换成别的图层时才放弃还原。
     */
    static async lockBackgroundLayer(expectedLayerId?: number) {
        if (expectedLayerId !== undefined) {
            const cur = await this.readActiveLayer();
            if (cur && cur.id !== null && cur.id !== expectedLayerId) {
                console.warn(
                    `⚠️ 活动图层已改变（期望 id ${expectedLayerId}，实际 ${cur.id}），` +
                    '跳过还原背景图层以免误改其他图层'
                );
                return;
            }
        }
        try {
            const result = await action.batchPlay(
                [{ ...LAYER_TO_BACKGROUND_DESCRIPTOR }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
            const err = this.batchPlayError(result);
            if (err) {
                console.warn('⚠️ 还原为背景图层：命令回报错误（图层可能停留在普通图层）:', err);
            } else {
                console.log('✅ 已还原为背景图层');
            }
        } catch (e) {
            console.warn('⚠️ 还原为背景图层失败（图层结构可能停留在普通图层）:', e);
        }
    }

    /**
     * batchPlay 在「命令无法处理」时**不一定抛错**：官方文档说明多数情况下会成功 resolve，
     * 并把错误放在返回列表里（`{_obj: "error", message, result}`）。
     * 只看 try/catch 会把这类**静默失败**当成成功 ⇒ 图层类型转换这类关键命令必须查返回项。
     */
    static batchPlayError(result: any): string | null {
        if (!Array.isArray(result)) return null;
        for (const item of result) {
            if (!item) continue;
            if (item._obj === 'error' || item._obj === 'Error') {
                const code = item.result !== undefined ? ` (result=${item.result})` : '';
                return `${item.message || '未知错误'}${code}`;
            }
        }
        return null;
    }

    /**
     * 安全读取活动图层的 id 与「是否背景图层」。
     *
     * ⚠️ 两步探测**各自独立 try/catch**（本仓铁律：可能抛异常的多步探测，每一步的 catch
     *    都必须原样保留，否则异常会逃逸成「整段失效」）；任一失败返回 null，不打断主流程。
     */
    static async readActiveLayer(): Promise<ActiveLayerSnapshot> {
        let layer: any = null;
        try {
            layer = app.activeDocument.activeLayers[0];
        } catch (e) {
            console.warn('⚠️ 读取活动图层失败:', e);
            return { id: null, isBackgroundLayer: null };
        }
        if (!layer) return { id: null, isBackgroundLayer: null };

        let id: number | null = null;
        try {
            id = typeof layer.id === 'number' ? layer.id : null;
        } catch (e) {
            // 单步兜底：读不到 id 不影响后面读背景标记
        }
        let isBackgroundLayer: boolean | null = null;
        try {
            isBackgroundLayer = typeof layer.isBackgroundLayer === 'boolean' ? layer.isBackgroundLayer : null;
        } catch (e) {
            // 单步兜底（同上）
        }
        return { id, isBackgroundLayer };
    }

    /**
     * 安全读取图层的像素外接矩形（`boundsNoEffects` 优先：含效果的范围不是像素）。
     * 读失败返回 null，由调用方回退到文档矩形 —— **绝不把异常抛给主流程**。
     */
    static readLayerBounds(layer: any): PixelRect | null {
        try {
            const b = (layer && (layer.boundsNoEffects || layer.bounds)) || null;
            if (!b) return null;
            const left = Math.round(Number(b.left) || 0);
            const top = Math.round(Number(b.top) || 0);
            const right = Math.round(Number(b.right) || 0);
            const bottom = Math.round(Number(b.bottom) || 0);
            if (!(right > left) || !(bottom > top)) return null;
            return { left, top, right, bottom };
        } catch (e) {
            console.warn('⚠️ 读取图层边界失败（回退到文档矩形）:', e);
            return null;
        }
    }

    /** 「自动删选区」关闭时还原原选区（所有写回路径的统一收尾） */
    static async restoreSelectionIfKept(bounds: any, state: any) {
        if (!state || state.deselectAfterFill !== false) return;
        if (!bounds || !bounds.selectionValues || bounds.selectionValues.length === 0) return;
        try {
            const docW = Math.round(bounds.docWidth);
            const docH = Math.round(bounds.docHeight);
            const fullSelectionData = new Uint8Array(docW * docH);
            if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                const selectionIndices = Array.from<number>(bounds.selectionDocIndices);
                let valueIndex = 0;
                for (const docIndex of selectionIndices) {
                    if (docIndex < fullSelectionData.length && valueIndex < bounds.selectionValues.length) {
                        fullSelectionData[docIndex] = bounds.selectionValues[valueIndex];
                        valueIndex++;
                    } else if (valueIndex >= bounds.selectionValues.length) {
                        break;
                    }
                }
            }
            const selectionImageData = await imaging.createImageDataFromBuffer(fullSelectionData, {
                width: docW,
                height: docH,
                components: 1,
                chunky: true,
                colorProfile: "Dot Gain 15%",
                colorSpace: "Grayscale",
            });
            await imaging.putSelection({
                documentID: app.activeDocument.id,
                imageData: selectionImageData,
            });
            selectionImageData.dispose();
        } catch (selectionError) {
            console.error('恢复选区失败:', selectionError);
        }
    }

    // 收集左上角和右下角像素的值，并且做处理
    static async getPixelValue(action: any, x: number, y: number): Promise<number> {
        // 选择指定坐标的1x1像素区域
        await action.batchPlay([
            {
                _obj: "set",
                _target: [
                    {
                        _ref: "channel",
                        _property: "selection"
                    }
                ],
                to: {
                    _obj: "rectangle",
                    top: {
                        _unit: "pixelsUnit",
                        _value: y
                    },
                    left: {
                        _unit: "pixelsUnit",
                        _value: x
                    },
                    bottom: {
                        _unit: "pixelsUnit",
                        _value: y + 1
                    },
                    right: {
                        _unit: "pixelsUnit",
                        _value: x + 1
                    }
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

        // 获取像素的直方图
        const result = await action.batchPlay([
            {
                _obj: "get",
                _target: [
                    {
                        _ref: "channel",
                        _name: "快速蒙版"
                    }
                ]
            }
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
        
        // 分析直方图找出数量为1的色阶值
        const histogram = result[0].histogram;
        const pixelValue = histogram.findIndex(count => count === 1);

        return pixelValue;
    }


    //-------------------------------------------------------------------------------------------------
    // 第二类 · 黑白通道 · 快速蒙版
    //   清除 = 从蒙版里「减去」内容。重构前本路径与图层蒙版各写一份公式、
    //   且另一处描边路径还按 colorIndicates 做了方向反转 ⇒ 同一操作两种结果。
    //   现在与图层蒙版共用 computeChannelClear，方向统一为「减少蒙版覆盖」。
    static async clearInQuickMask(state: any) {
        try {
            // ⚠️ 纯色模式的前景色必须在 getQuickMaskPixels **之前**抓取 —— 该方法会退出快速蒙版，
            //    退出后 app.foregroundColor 读到的已不是用户操作时的前景色。
            const quickMaskForegroundColor = state.fillMode === 'foreground' ? app.foregroundColor : null;

            const bounds = await this.getSelectionData();
            if (!bounds) {
                console.warn('❌ 没有选区，无法执行快速蒙版清除操作');
                return;
            }

            const { quickMaskPixels, isEmpty } = await this.getQuickMaskPixels(bounds);
            if (isEmpty) {
                console.log('⚠️ 快速蒙版为空，跳过后续清除操作');
                return;
            }

            const fill = await this.buildClearFillData(state, bounds, quickMaskForegroundColor, true);
            if (!fill) return;

            const newMask = this.computeChannelClear(
                quickMaskPixels,
                fill,
                state.opacity,
                bounds,
                state.clearChannelAlgorithm
            );
            await this.updateQuickMaskChannel(newMask, bounds, state);
        } catch (error) {
            console.error('❌ 快速蒙版清除失败:', error);
            throw error;
        }
    }

    /**
     * 第二类 · 黑白通道的**唯一**计算公式（快速蒙版 / 图层蒙版共用）。
     *
     * 与重构前两份实现相比，这里同时收掉了三处冗余特例：
     *   · `mask === 0 → 0`：减法在 0 处本来就被 clamp 到 0，乘法 0×k 也是 0，特例多余；
     *   · `alpha === 0 → 保持原值`：已由 clearStrength 把 t 归零统一表达；
     *   · 选区内值需要先「提取」成压缩数组：现在直接用文档索引就地读写，省一次拷贝。
     *
     * @param maskData 完整文档尺寸的通道灰度
     * @returns 新的完整文档尺寸灰度数组（未选中区域保持原值）
     */
    static computeChannelClear(
        maskData: Uint8Array,
        fill: ClearFillData,
        opacity: number,
        bounds: any,
        algorithm?: BinaryClearAlgorithm
    ): Uint8Array {
        const algo: BinaryClearAlgorithm = algorithm || 'subtract';
        const out = new Uint8Array(maskData.length);
        out.set(maskData);

        if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
            return out;
        }

        const indices = Array.from<number>(bounds.selectionDocIndices);
        const coeffs = bounds.selectionCoefficients;

        for (let i = 0; i < indices.length && i < fill.gray.length; i++) {
            const docIndex = indices[i];
            if (docIndex < 0 || docIndex >= out.length) continue;
            const t = clearStrength(opacity, fill.alpha && fill.alpha[i], coeffs && coeffs[i]);
            if (t <= 0) continue;
            out[docIndex] = clearChannelValue(maskData[docIndex], fill.gray[i], t, algo);
        }

        return out;
    }

    //-------------------------------------------------------------------------------------------------
    // 第二类 · 黑白通道 · 图层蒙版（与快速蒙版同一公式，仅写回 API 不同）
    static async clearLayerMask(state: any, opacity: number) {
        try {
            const bounds = await this.getSelectionData();
            if (!bounds) {
                console.log('❌ 无法获取选区边界');
                return;
            }

            const layerId = await this.getCurrentLayerId();
            if (!layerId) {
                console.log('❌ 无法获取当前图层ID');
                return;
            }

            const maskResult = await this.getLayerMaskPixels(bounds, layerId);
            if (!maskResult) {
                console.log('❌ 无法获取图层蒙版像素数据');
                return;
            }

            const fill = await this.buildClearFillData(state, bounds);
            if (!fill) return;

            const newMask = this.computeChannelClear(
                maskResult.maskData,
                fill,
                opacity,
                bounds,
                state.clearChannelAlgorithm
            );
            await this.updateLayerMask(newMask, bounds, layerId, state);
        } catch (error) {
            console.error('❌ 图层蒙版清除失败:', error);
        }
    }

  
    //-------------------------------------------------------------------------------------------------
    // 获取选区边界信息和文档信息
    static async getSelectionData() {
        try {
            // batchplay获取文档信息和选区信息
            const [docResult, selectionResult] = await Promise.all([
                action.batchPlay([
                    {
                        _obj: "get",
                        _target: [
                            {
                                _ref: "document",
                                _enum: "ordinal",
                                _value: "targetEnum"
                            }
                        ]
                    }
                ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }),
                action.batchPlay([
                    {
                        _obj: "get",
                        _target: [
                            {
                                _property: "selection"
                            },
                            {
                                _ref: "document",
                                _enum: "ordinal",
                                _value: "targetEnum"
                            }
                        ]
                    }
                ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' })
            ]);
            
           // 获取文档尺寸信息
            const docWidth = docResult[0].width._value;
            const docHeight = docResult[0].height._value;
            const resolution = docResult[0].resolution._value;
            
            // 直接转换为像素单位
            const docWidthPixels = Math.round(docWidth * resolution / 72);
            const docHeightPixels = Math.round(docHeight * resolution / 72);    
            // 获取选区边界
            const bounds = selectionResult[0].selection;
            const left = Math.round(bounds.left._value);
            const top = Math.round(bounds.top._value);
            const right = Math.round(bounds.right._value);
            const bottom = Math.round(bounds.bottom._value);
            const width = right - left;
            const height = bottom - top;
            
            // 使用imaging.getSelection获取羽化选区的像素数据
        const pixels = await imaging.getSelection({
            documentID: app.activeDocument.id,
            sourceBounds: {
                left: left,
                top: top,
                right: right,
                bottom: bottom
            },
            targetSize: {
                width: width,
                height: height
            },
        });
        
        const selectionData = await pixels.imageData.getData();
        
        // 创建临时数组来存储矩形边界内的所有像素信息
        const tempSelectionValues = new Uint8Array(width * height);
        const tempSelectionCoefficients = new Float32Array(width * height);
        // 创建一个新的Set来存储选区内像素（值大于0）在文档中的索引
        const selectionDocIndices = new Set<number>();
        
        // 第一步：处理矩形边界内的所有像素，收集选区内像素的索引
        if (selectionData.length === width * height) {
            // 单通道数据
            for (let i = 0; i < width * height; i++) {
                tempSelectionValues[i] = selectionData[i];
                tempSelectionCoefficients[i] = selectionData[i] / 255; // 计算选择系数
                
                // 只有当像素值大于0时，才认为它在选区内
                if (selectionData[i] > 0) {
                    // 计算该像素在选区边界内的坐标
                    const x = i % width;
                    const y = Math.floor(i / width);
                    
                    // 计算该像素在整个文档中的索引
                    const docX = left + x;
                    const docY = top + y;
                    const docIndex = docY * docWidthPixels + docX;
                    
                    // 将文档索引添加到集合中
                    selectionDocIndices.add(docIndex);
                }
            }
        }
        
        // 第二步：创建只包含选区内像素的数组（长度为selectionDocIndices.size）
        const selectionSize = selectionDocIndices.size;
        const selectionValues = new Uint8Array(selectionSize);
        const selectionCoefficients = new Float32Array(selectionSize);
        
        // 第三步：将选区内像素的值和系数填入新数组
        let fillIndex = 0;
        for (let i = 0; i < width * height; i++) {
            if (tempSelectionValues[i] > 0) {
                selectionValues[fillIndex] = tempSelectionValues[i];
                selectionCoefficients[fillIndex] = tempSelectionCoefficients[i];
                fillIndex++;
            }
        }
        console.log('✅ 选区内像素数量（selectionDocIndices.size）:', selectionDocIndices.size);
        
        // 释放ImageData内存
        pixels.imageData.dispose();
        
        // 取消选区
        await action.batchPlay([
            {
                _obj: "set",
                _target: [
                    {
                        _ref: "channel",
                        _property: "selection"
                    }
                ],
                to: {
                    _enum: "ordinal",
                    _value: "none"
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
        
        return {
            left,
            top,
            right,
            bottom,
            width,
            height,
            docWidth: docWidthPixels,  // 返回像素单位的文档宽度
            docHeight: docHeightPixels, // 返回像素单位的文档高度
            selectionPixels: selectionDocIndices, // 现在直接使用selectionDocIndices
            selectionDocIndices,       // 通过imaging.getSelection获取的选区内像素在文档中的索引
            selectionValues,           // 选区像素值（0-255）
            selectionCoefficients      // 选择系数（0-1）
        };
        
    } catch (error) {
        console.error('获取选区边界失败:', error);
        return null;
    }
}

    //-------------------------------------------------------------------------------------------------
    // 获取快速蒙版通道的像素数据
    static async getQuickMaskPixels(bounds: any) {
        try {  
            // 获取快速蒙版通道信息
            const channelResult = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "channel",
                            _name: "快速蒙版"  // 快速蒙版通道名称
                        }
                    ]
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
            // 获取colorIndicates信息
            let isSelectedAreas = false;
            if (channelResult[0] && 
                channelResult[0].alphaChannelOptions && 
                channelResult[0].alphaChannelOptions.colorIndicates) {
                isSelectedAreas = channelResult[0].alphaChannelOptions.colorIndicates._value === "selectedAreas";
            }
            
            console.log(`🔍 检测到colorIndicates为${isSelectedAreas ? 'selectedAreas' : '非selectedAreas'}`);
            
            // 检查快速蒙版直方图状态
            const histogram = channelResult[0].histogram;
            const maskStatus = this.analyzeQuickMaskHistogram(histogram, isSelectedAreas);

            let topLeftIsEmpty = false;
            let bottomRightIsEmpty = false;
            let originalTopLeft = 0;
            let originalBottomRight = 0;

            // 获取左上角和右下角像素值
            originalTopLeft = await ClearHandler.getPixelValue(action, 0, 0);
            originalBottomRight = await ClearHandler.getPixelValue(action, Math.round(bounds.docWidth) - 1, Math.round(bounds.docHeight) - 1);

            // 取消选区
            await action.batchPlay([
                {
                    _obj: "set",
                    _target: [
                        {
                            _ref: "channel",
                            _property: "selection"
                        }
                    ],
                    to: {
                        _enum: "ordinal",
                        _value: "none"
                    },
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
            if (maskStatus.isEmpty) {
                await core.showAlert({ message: '您的快速蒙版已经为空！' });
                console.log('⚠️ 检测到快速蒙版为空，跳过修改蒙版流程！');
                const pixelCount = bounds.width * bounds.height;
                return {
                    quickMaskPixels: new Uint8Array(pixelCount),
                    isSelectedAreas: isSelectedAreas,
                    isEmpty: maskStatus.isEmpty,  // 添加isEmpty状态信息
                    topLeftIsEmpty: topLeftIsEmpty,
                    bottomRightIsEmpty: bottomRightIsEmpty,
                    originalTopLeft: originalTopLeft,  // 原始左上角像素值
                    originalBottomRight: originalBottomRight  // 原始右下角像素值
                };
            } else {
                // 判断是否需要填充
                if ((isSelectedAreas && (originalTopLeft === 255)) ||
                    (!isSelectedAreas && (originalTopLeft === 0))) 
                    topLeftIsEmpty = true;
                
                if ((isSelectedAreas && (originalBottomRight === 255)) ||
                    (!isSelectedAreas && (originalBottomRight === 0))) 
                    bottomRightIsEmpty = true;

                // 如果两个角都不为空，则跳过后续的填充
                if (!topLeftIsEmpty && !bottomRightIsEmpty) {
                    console.log('两个角都不为空，跳过填充');
                } else {
                    // 根据isEmpty状态添加选区
                    if (topLeftIsEmpty || bottomRightIsEmpty) {
                        // 创建选区 - 只选择需要填充的像素
                        if (topLeftIsEmpty && !bottomRightIsEmpty) {
                            // 只有左上角为空，选择左上角像素
                            console.log('只有左上角为空，选择左上角像素');
                            await action.batchPlay([
                                {
                                    _obj: "set",
                                    _target: [
                                        {
                                            _ref: "channel",
                                            _property: "selection"
                                        }
                                    ],
                                    to: {
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        }
                                    }
                                }
                            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                        } else if (!topLeftIsEmpty && bottomRightIsEmpty) {
                            // 只有右下角为空，选择右下角像素
                            console.log('只有右下角为空，选择右下角像素');
                             await action.batchPlay([
                                {
                                    _obj: "set",
                                    _target: [
                                        {
                                            _ref: "channel",
                                            _property: "selection"
                                        }
                                    ],
                                    to: {
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight) - 1
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth) - 1
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight)
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth)
                                        }
                                    }
                                }
                            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                        } else if (topLeftIsEmpty && bottomRightIsEmpty) {
                            console.log('两个角都为空，选择两个角的像素');
                             await action.batchPlay([
                                {
                                    _obj: "set",
                                    _target: [
                                        {
                                            _ref: "channel",
                                            _property: "selection"
                                        }
                                    ],
                                    to: {
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight) - 1
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth) - 1
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docHeight)
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: Math.round(bounds.docWidth)
                                        }
                                    }
                                }
                            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                            await action.batchPlay([
                                {
                                    _obj: "addTo",
                                    _target: [
                                        {
                                            _ref: "channel",
                                            _property: "selection"
                                        }
                                    ],
                                    to: {
                                        _obj: "rectangle",
                                        top: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        left: {
                                            _unit: "pixelsUnit",
                                            _value: 0
                                        },
                                        bottom: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        },
                                        right: {
                                            _unit: "pixelsUnit",
                                            _value: 1
                                        }
                                    }
                                }
                            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                        }

                        // 执行填充操作
                        await action.batchPlay([
                            {
                                _obj: "set",
                                _target: [
                                    {
                                        _ref: "color",
                                        _property: "foregroundColor"
                                    }
                                ],
                                to: {
                                    _obj: "HSBColorClass",
                                    hue: {
                                        _unit: "angleUnit",
                                        _value: 0
                                    },
                                    saturation: {
                                        _unit: "percentUnit",
                                        _value: 0
                                    },
                                    brightness: {
                                        _unit: "percentUnit",
                                        _value: isSelectedAreas ? 0 : 100
                                    }
                                },
                                source: "photoshopPicker",
                                _options: {
                                    dialogOptions: "dontDisplay"
                                }
                            }
                        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

                        await action.batchPlay([
                            {
                                _obj: "fill",
                                using: {
                                    _enum: "fillContents",
                                    _value: "foregroundColor"
                                },
                                opacity: {
                                    _unit: "percentUnit",
                                    _value: 100
                                },
                                mode: {
                                    _enum: "blendMode",
                                    _value: "normal"
                                },
                                _options: {
                                    dialogOptions: "dontDisplay"
                                }
                            }
                        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                    }
                }
            }
            
            // 撤销快速蒙版
            await ClearHandler.clearQuickMask();
            
            // 如果是纯白快速蒙版（非selectedAreas模式下），需要执行全选操作
            if (!isSelectedAreas && maskStatus.isWhite) {
                await ClearHandler.selectAll();
            }

            // 通过获取选区的灰度信息，间接获取完整文档的快速蒙版数据，maskValue数组
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);

            // 通过Imaging API获取快速蒙版转化的选区的黑白信息
            const pixels = await imaging.getSelection({
                documentID: app.activeDocument.id,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: finalDocWidth,
                    bottom: finalDocHeight
                },
                componentSize: 8,
                colorProfile: "Dot Gain 15%"
            });
            
            const quickMaskData = await pixels.imageData.getData();

            // 释放ImageData内存
            pixels.imageData.dispose();
            
            // 创建固定长度的maskValue数组，初始值全为0
            const expectedPixelCount = finalDocWidth * finalDocHeight;
            let maskValue = new Uint8Array(expectedPixelCount);
            
            // 将quickMaskData转换为Uint8Array
            const quickMaskPixels = new Uint8Array(quickMaskData);
            
            // 获取quickMaskPixels中非零值的索引位置
            const nonZeroIndices: number[] = [];
            for (let i = 0; i < quickMaskPixels.length; i++) {
                if (quickMaskPixels[i] !== 0) {
                    nonZeroIndices.push(i);
                }
            }
            
            // 将非零值复制到maskValue对应位置
            for (let i = 0; i < nonZeroIndices.length; i++) {
                const sourceIndex = nonZeroIndices[i];
                maskValue[sourceIndex] = quickMaskPixels[sourceIndex];
            }
            
            return {
                quickMaskPixels: maskValue,
                isSelectedAreas: isSelectedAreas,
                isEmpty: maskStatus.isEmpty,  // 添加isEmpty状态信息
                topLeftIsEmpty: topLeftIsEmpty,
                bottomRightIsEmpty: bottomRightIsEmpty,
                originalTopLeft: originalTopLeft,  // 原始左上角像素值
                originalBottomRight: originalBottomRight  // 原始右下角像素值
            };
            
        } catch (error) {
            console.error('❌ 获取快速蒙版像素数据失败:', error);
            throw error;
        }
    }
    // 分析快速蒙版直方图状态
    static analyzeQuickMaskHistogram(histogram: number[], isSelectedAreas: boolean) {
        let isEmpty = false;
        let isWhite = false;
        
        if (histogram && Array.isArray(histogram)) {
            if (isSelectedAreas) {
                // selectedAreas模式：检查是否为空（除了255色阶外其他都是0）
                let nonZeroCount = 0;
                for (let i = 0; i < 255; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCount++;
                    }
                }
                isEmpty = (nonZeroCount === 0 && histogram[255] > 0);
                console.log('selectedAreas——————快速蒙版为空？', isEmpty);
            } else {
                // 非selectedAreas模式：检查是否为全选（纯白）或空白（纯黑）
                let nonZeroCountWhite = 0;
                for (let i = 0; i < 255; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCountWhite++;
                    }
                }
                isWhite = (nonZeroCountWhite === 0 && histogram[255] > 0);
                
                let nonZeroCount = 0;
                for (let i = 1; i < 256; i++) {
                    if (histogram[i] > 0) {
                        nonZeroCount++;
                    }
                }
                isEmpty = (nonZeroCount === 0 && histogram[0] > 0);
                
                console.log('非selectedAreas模式——————快速蒙版为空？', isEmpty, '    全选？', isWhite);
            }
        }
        
        return { isEmpty, isWhite };
    }
    
    // 撤销快速蒙版
    static async clearQuickMask() {
        await action.batchPlay([
            {
                _obj: "clearEvent",
                _target: [
                    {
                        _ref: "property",
                        _property: "quickMask"
                    },
                    {
                        _ref: "document",
                        _enum: "ordinal",
                        _value: "targetEnum"
                    }
                ],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
    }
    
    // 执行全选操作
    static async selectAll() {
        await action.batchPlay([
            {
                _obj: "set",
                _target: [
                    {
                        _ref: "channel",
                        _property: "selection"
                    }
                ],
                to: {
                    _enum: "ordinal",
                    _value: "allEnum"
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
    }

    //-------------------------------------------------------------------------------------------------
    // 获取纯色填充的灰度数据（第一/二/三类目标共用）
    //
    // ⚠️ 本函数此前**恒按快速蒙版口径**取抖动（isQuickMaskMode = true），
    //    而像素图层的纯色清除走的是另一条「设前景色 + fill clearEnum」的宿主路径。
    //    统一到本函数后必须把口径参数化：快速蒙版用灰度抖动，其它目标用 HSB 抖动再转灰度。
    // ⚠️ 数组长度改用「选区内像素数」：旧实现用外接矩形面积（width×height），
    //    与 computeChannelClear 的下标语义不一致（下标是第 i 个**选区像素**）。
    static async getSolidFillGrayData(
        state: any,
        bounds: any,
        foregroundColor?: any,
        quickMask: boolean = false
    ) {
        const currentForegroundColor = foregroundColor || app.foregroundColor;
        const pixelCount = bounds.selectionDocIndices
            ? bounds.selectionDocIndices.size
            : bounds.width * bounds.height;
        const grayData = new Uint8Array(pixelCount);

        const panelColor = calculateRandomColor(
            state.colorSettings,
            state.opacity,
            currentForegroundColor,
            quickMask
        );

        const rgb = hsbToRgb(panelColor.hsb.hue, panelColor.hsb.saturation, panelColor.hsb.brightness);
        grayData.fill(rgbToGray(rgb.red, rgb.green, rgb.blue));
        return grayData;
    }
    
    //-------------------------------------------------------------------------------------------------
    // 获取图案填充的灰度数据（支持羽化选区和PNG透明度）
    static async getPatternFillGrayData(state: any, bounds: any): Promise<Uint8Array> {
        try {
            
            // 检查是否有有效的图案数据
            if (!state.selectedPattern || !state.selectedPattern.grayData) {
                console.error('缺少图案灰度数据');
                let pixelCount = 0;
                
                // 根据可用的选区信息确定像素数量
                if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                    pixelCount = bounds.selectionDocIndices.size;
                } else if (bounds.selectionValues && bounds.selectionValues.length > 0) {
                    pixelCount = bounds.selectionValues.length;
                } else {
                    pixelCount = bounds.width * bounds.height;
                }
                
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128);
                console.log('⚠️ 使用默认灰度数据，像素数:', pixelCount);
                return grayData;
            }
            
            // 优先使用width和height，这些是PatternPicker中设置的当前尺寸
            const pattern = state.selectedPattern;
            const patternWidth = pattern.width || pattern.originalWidth || 100;
            const patternHeight = pattern.height || pattern.originalHeight || 100;
                
            // 使用当前的缩放和角度设置
            const scale = pattern.currentScale || pattern.scale || 100;
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            
            // 根据填充模式选择算法
            const fillMode = pattern.fillMode || 'tile'; // 默认为贴墙纸模式
            let grayPatternData: Uint8Array;
            
            if (fillMode === 'stamp') {
                // 盖图章模式：图案居中显示，不重复
                console.log('🎯 快速蒙版清除：使用盖图章模式填充');
                const grayStampResult = await ClearHandler.createStampPatternData(
                    pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    pattern.currentAngle || pattern.angle || 0,
                    bounds,
                    true, // 灰度模式
                    false // 不需要生成透明度数据（灰度模式）
                );
                grayPatternData = grayStampResult.colorData;
            } else {
                // 贴墙纸模式：无缝平铺
                console.log('🧱 快速蒙版清除：使用贴墙纸模式填充，全部旋转:', pattern.rotateAll);
                const grayTileResult = ClearHandler.createTilePatternData(
                    pattern.grayData,
                    patternWidth,
                    patternHeight,
                    1, // 灰度数据只有1个组件
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    pattern.currentAngle || pattern.angle || 0,
                    pattern.rotateAll !== false,
                    bounds,
                    false // 不需要生成透明度数据（灰度模式）
                );
                grayPatternData = grayTileResult.colorData;
            }
            
            if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                // 使用selectionDocIndices（选区内像素在文档中的索引）
                // 创建与选区内像素数量相同的数组
                const selectionSize = bounds.selectionDocIndices.size;
                const selectionGrayData = new Uint8Array(selectionSize);
                
                // 将selectionDocIndices转换为数组以便按顺序遍历
                const selectionIndices = Array.from(bounds.selectionDocIndices);
                
                // 遍历选区内的每个像素，从完整图案数据中提取对应的值
                for (let i = 0; i < selectionIndices.length; i++) {
                    const docIndex: number = selectionIndices[i];
                    // 计算该像素在选区边界内的坐标
                    const docX = docIndex % bounds.docWidth;
                    const docY = Math.floor(docIndex / bounds.docWidth);
                    const boundsX = docX - bounds.left;
                    const boundsY = docY - bounds.top;
                    
                    // 检查坐标是否在选区边界内
                    if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                        const boundsIndex = boundsY * bounds.width + boundsX;
                        if (boundsIndex < grayPatternData.length) {
                            selectionGrayData[i] = grayPatternData[boundsIndex];
                        } else {
                            selectionGrayData[i] = 128; // 默认中灰值
                        }
                    } else {
                        selectionGrayData[i] = 128; // 默认中灰值
                    }
                }
                
                console.log('🎯 selectionDocIndices提取完成，【图案】在选区内像素数:', selectionSize);
                return selectionGrayData;
            }
            
            console.log('✅ 图案填充灰度数据生成完成，长度:', grayPatternData.length);
            return grayPatternData;
        } catch (error) {
            console.error('获取图案灰度数据失败:', error);
            let pixelCount = 0;
            
            // 根据可用的选区信息确定像素数量
            if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                pixelCount = bounds.selectionDocIndices.size;
            } else if (bounds.selectionValues && bounds.selectionValues.length > 0) {
                // 注意：selectionValues现在是选区内像素的数组，长度等于selectionDocIndices.size
                pixelCount = bounds.selectionValues.length;
            } else {
                // 如果没有选区信息，使用选区边界的面积作为默认值
                pixelCount = bounds.width * bounds.height;
            }
            
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128); // 填充中灰色
            console.log('⚠️ 使用默认灰度数据，像素数:', pixelCount);
            return grayData;
        }
    }

    // ---------------------------------------------------------------------------
    // 为选区创建盖图章模式的图案数据
    static async createStampPatternData(
        patternData: Uint8Array,
        patternWidth: number,
        patternHeight: number,
        components: number,
        targetWidth: number,
        targetHeight: number,
        scaledPatternWidth: number,
        scaledPatternHeight: number,
        angle: number,
        bounds: any,
        isGrayMode: boolean = false,
        generateAlphaData: boolean = false
    ): Promise<{ colorData: Uint8Array; alphaData?: Uint8Array }> {
        
        const resultData = new Uint8Array(targetWidth * targetHeight * (isGrayMode ? 1 : components));
        let alphaData: Uint8Array | undefined;
        
        if (generateAlphaData) {
            alphaData = new Uint8Array(targetWidth * targetHeight);
        }
        
        // 计算目标区域中心作为图案放置中心
        const targetCenterX = targetWidth / 2;
        const targetCenterY = targetHeight / 2;
        
        // 计算图案放置位置（居中）
        const patternStartX = targetCenterX - scaledPatternWidth / 2;
        const patternStartY = targetCenterY - scaledPatternHeight / 2;
        
        const angleRad = (angle * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        
        // 获取图案像素的函数 - 修复透明区域处理
        const getPatternPixel = (x: number, y: number) => {
            let patternX: number, patternY: number;
            
            if (angle !== 0) {
                // 计算相对于旋转中心的坐标
                const relativeX = x - (targetWidth / 2);
                const relativeY = y - (targetHeight / 2);
                
                // 反向旋转以获取原始坐标
                const originalX = relativeX * cos + relativeY * sin + (targetWidth / 2);
                const originalY = -relativeX * sin + relativeY * cos + (targetHeight / 2);
                
                // 计算在图案中的位置
                patternX = originalX - patternStartX;
                patternY = originalY - patternStartY;
            } else {
                // 无旋转的情况
                patternX = x - patternStartX;
                patternY = y - patternStartY;
            }
            
            // 检查是否在图案范围内
            if (patternX >= 0 && patternX < scaledPatternWidth && patternY >= 0 && patternY < scaledPatternHeight) {
                // 映射到原始图案坐标
                const sourceX = Math.floor(patternX * patternWidth / scaledPatternWidth);
                const sourceY = Math.floor(patternY * patternHeight / scaledPatternHeight);
                
                if (sourceX >= 0 && sourceX < patternWidth && sourceY >= 0 && sourceY < patternHeight) {
                    return (sourceY * patternWidth + sourceX) * components;
                }
            }
            
            // 超出范围时返回-1表示透明区域
            return -1;
        };
        
        // 遍历目标区域的每个像素
        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                const sourceIndex = getPatternPixel(x, y);
                const pixelIndex = y * targetWidth + x;
                
                if (sourceIndex >= 0) {
                    // 在图案范围内，直接复制像素数据
                    if (isGrayMode || components === 1) {
                        resultData[pixelIndex] = patternData[sourceIndex];
                        if (alphaData) {
                            alphaData[pixelIndex] = 255; // 灰度模式下图案区域为不透明
                        }
                    } else {
                        const colorIndex = pixelIndex * components;
                        // 直接复制图案像素数据，保持原始透明度信息
                        for (let c = 0; c < components; c++) {
                            resultData[colorIndex + c] = patternData[sourceIndex + c];
                        }
                        if (alphaData) {
                            alphaData[pixelIndex] = components === 4 ? patternData[sourceIndex + 3] : 255;
                        }
                    }
                } else {
                    // 超出图案范围，设置为透明
                    if (isGrayMode || components === 1) {
                        resultData[pixelIndex] = 255; // 灰度模式下透明区域为白色
                        if (alphaData) {
                            alphaData[pixelIndex] = 0; // 透明
                        }
                    } else {
                        const colorIndex = pixelIndex * components;
                        // 透明区域：RGB值设为0，alpha设为0
                        resultData[colorIndex] = 0;     // R = 0
                        resultData[colorIndex + 1] = 0; // G = 0
                        resultData[colorIndex + 2] = 0; // B = 0
                        if (components === 4) {
                            resultData[colorIndex + 3] = 0; // Alpha = 0 (完全透明)
                        }
                        if (alphaData) {
                            alphaData[pixelIndex] = 0; // 透明
                        }
                    }
                }
            }
        }
        
        return { colorData: resultData, alphaData: alphaData };
    }
    
    // ---------------------------------------------------------------------------
    // 为选区创建贴墙纸模式的图案数据
    static createTilePatternData(
        patternData: Uint8Array,
        patternWidth: number,
        patternHeight: number,
        components: number,
        targetWidth: number,
        targetHeight: number,
        scaledPatternWidth: number,
        scaledPatternHeight: number,
        angle: number,
        rotateAll: boolean = true,
        bounds?: any,  // 添加bounds参数以支持全局坐标平铺
        generateAlphaData: boolean = false  // 是否生成透明度数据
    ): { colorData: Uint8Array; alphaData?: Uint8Array } {
        
        // 创建最终结果数据
        const resultData = new Uint8Array(targetWidth * targetHeight * components);
        
        if (angle === 0) {
            // 无旋转的情况，直接平铺
            for (let y = 0; y < targetHeight; y++) {
                for (let x = 0; x < targetWidth; x++) {
                    // 如果有bounds参数，使用全局坐标进行平铺
                    let globalX, globalY;
                    if (bounds) {
                        globalX = bounds.left + x;
                        globalY = bounds.top + y;
                    } else {
                        globalX = x;
                        globalY = y;
                    }
                    
                    const patternX = Math.floor((globalX % scaledPatternWidth) * patternWidth / scaledPatternWidth);
                    const patternY = Math.floor((globalY % scaledPatternHeight) * patternHeight / scaledPatternHeight);
                    
                    const sourceX = Math.min(patternX, patternWidth - 1);
                    const sourceY = Math.min(patternY, patternHeight - 1);
                    
                    const sourceIndex = (sourceY * patternWidth + sourceX) * components;
                    const targetIndex = (y * targetWidth + x) * components;
                    
                    for (let c = 0; c < components; c++) {
                        resultData[targetIndex + c] = patternData[sourceIndex + c];
                    }
                }
            }
            
            // 如果需要生成透明度数据，创建对应的alpha数组
            let alphaData: Uint8Array | undefined;
            if (generateAlphaData && components === 4) {
                alphaData = new Uint8Array(targetWidth * targetHeight);
                
                // 提取alpha通道数据
                for (let i = 0; i < targetWidth * targetHeight; i++) {
                    const sourceIndex = i * components;
                    alphaData[i] = resultData[sourceIndex + 3] || 0;
                }
            }
            
            return { colorData: resultData, alphaData };
        }
        
        if (rotateAll) {
            // 全部旋转模式：先平铺再整体旋转
            console.log('🔄 全部旋转模式：先平铺再整体旋转');
            
            const diagonal = Math.sqrt(targetWidth * targetWidth + targetHeight * targetHeight);
            const expandedSize = Math.ceil(diagonal);
            
            // 计算目标区域在扩展区域中的偏移，确保目标区域居中
            const offsetX = (expandedSize - targetWidth) / 2;
            const offsetY = (expandedSize - targetHeight) / 2;
            
            // 创建扩展的平铺数据
            const expandedData = new Uint8Array(expandedSize * expandedSize * components);
            
            // 先在扩展区域进行平铺（不旋转）
            for (let y = 0; y < expandedSize; y++) {
                for (let x = 0; x < expandedSize; x++) {
                    // 将扩展区域坐标映射到目标区域坐标系
                    const targetX = x - offsetX;
                    const targetY = y - offsetY;
                    
                    // 如果有bounds参数，使用全局坐标进行平铺
                    let globalX, globalY;
                    if (bounds) {
                        globalX = bounds.left + targetX;
                        globalY = bounds.top + targetY;
                    } else {
                        globalX = targetX;
                        globalY = targetY;
                    }
                    
                    // 使用连续平铺逻辑，确保无缝衔接
                    const tileX = ((globalX % scaledPatternWidth) + scaledPatternWidth) % scaledPatternWidth;
                    const tileY = ((globalY % scaledPatternHeight) + scaledPatternHeight) % scaledPatternHeight;
                    
                    const patternX = Math.floor(tileX * patternWidth / scaledPatternWidth);
                    const patternY = Math.floor(tileY * patternHeight / scaledPatternHeight);
                    
                    const sourceX = Math.min(Math.max(0, patternX), patternWidth - 1);
                    const sourceY = Math.min(Math.max(0, patternY), patternHeight - 1);
                    
                    const sourceIndex = (sourceY * patternWidth + sourceX) * components;
                    const targetIndex = (y * expandedSize + x) * components;
                    
                    for (let c = 0; c < components; c++) {
                        expandedData[targetIndex + c] = patternData[sourceIndex + c];
                    }
                }
            }
            
            // 然后对整个平铺结果进行旋转
            const angleRad = (angle * Math.PI) / 180;
            const cos = Math.cos(angleRad);
            const sin = Math.sin(angleRad);
            
            const centerX = targetWidth / 2;
            const centerY = targetHeight / 2;
            const expandedCenterX = expandedSize / 2;
            const expandedCenterY = expandedSize / 2;
            
            for (let y = 0; y < targetHeight; y++) {
                for (let x = 0; x < targetWidth; x++) {
                    const relativeX = x - centerX;
                    const relativeY = y - centerY;
                    
                    // 反向旋转以获取扩展区域中的坐标
                    const expandedX = relativeX * cos + relativeY * sin + expandedCenterX;
                    const expandedY = -relativeX * sin + relativeY * cos + expandedCenterY;
                    
                    const targetIndex = (y * targetWidth + x) * components;
                    
                    // 简化边界检查，只在安全范围内使用双线性插值
                    if (expandedX >= 0 && expandedX < expandedSize - 1 && 
                        expandedY >= 0 && expandedY < expandedSize - 1) {
                        const x1 = Math.floor(expandedX);
                        const y1 = Math.floor(expandedY);
                        const x2 = x1 + 1;
                        const y2 = y1 + 1;
                        
                        // 双重检查确保采样点有效
                        if (x1 >= 0 && x2 < expandedSize && y1 >= 0 && y2 < expandedSize) {
                            const fx = expandedX - x1;
                            const fy = expandedY - y1;
                            
                            for (let c = 0; c < components; c++) {
                                const p1 = expandedData[(y1 * expandedSize + x1) * components + c];
                                const p2 = expandedData[(y1 * expandedSize + x2) * components + c];
                                const p3 = expandedData[(y2 * expandedSize + x1) * components + c];
                                const p4 = expandedData[(y2 * expandedSize + x2) * components + c];
                                
                                const interpolated = p1 * (1 - fx) * (1 - fy) +
                                                   p2 * fx * (1 - fy) +
                                                   p3 * (1 - fx) * fy +
                                                   p4 * fx * fy;
                                
                                resultData[targetIndex + c] = Math.round(interpolated);
                            }
                        } else {
                            // 使用最近邻采样作为安全回退
                            const nearestX = Math.max(0, Math.min(expandedSize - 1, Math.round(expandedX)));
                            const nearestY = Math.max(0, Math.min(expandedSize - 1, Math.round(expandedY)));
                            const sourceIndex = (nearestY * expandedSize + nearestX) * components;
                            
                            for (let c = 0; c < components; c++) {
                                resultData[targetIndex + c] = expandedData[sourceIndex + c];
                            }
                        }
                    } else {
                        // 超出扩展区域时，使用扩展区域边界的像素（避免产生异常图案）
                        const clampedX = Math.max(0, Math.min(expandedSize - 1, Math.round(expandedX)));
                        const clampedY = Math.max(0, Math.min(expandedSize - 1, Math.round(expandedY)));
                        const sourceIndex = (clampedY * expandedSize + clampedX) * components;
                        
                        for (let c = 0; c < components; c++) {
                            resultData[targetIndex + c] = expandedData[sourceIndex + c];
                        }
                    }
                }
            }
        } else {
            // 单独旋转模式：先旋转图案再平铺
            console.log('🔄 单独旋转模式：先旋转图案再平铺');
            
            const angleRad = (angle * Math.PI) / 180;
            const cos = Math.cos(angleRad);
            const sin = Math.sin(angleRad);
            
            // 计算旋转后图案的边界框
            const corners = [
                { x: 0, y: 0 },
                { x: scaledPatternWidth, y: 0 },
                { x: scaledPatternWidth, y: scaledPatternHeight },
                { x: 0, y: scaledPatternHeight }
            ];
            
            const patternCenterX = scaledPatternWidth / 2;
            const patternCenterY = scaledPatternHeight / 2;
            
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            corners.forEach(corner => {
                const relX = corner.x - patternCenterX;
                const relY = corner.y - patternCenterY;
                const rotX = relX * cos - relY * sin + patternCenterX;
                const rotY = relX * sin + relY * cos + patternCenterY;
                
                minX = Math.min(minX, rotX);
                maxX = Math.max(maxX, rotX);
                minY = Math.min(minY, rotY);
                maxY = Math.max(maxY, rotY);
            });
            
            const rotatedWidth = Math.ceil(maxX - minX);
            const rotatedHeight = Math.ceil(maxY - minY);
            const offsetX = -minX;
            const offsetY = -minY;
            
            // 创建旋转后的图案数据
            const rotatedPatternData = new Uint8Array(rotatedWidth * rotatedHeight * components);
            
            // 生成旋转后的图案
            for (let y = 0; y < rotatedHeight; y++) {
                for (let x = 0; x < rotatedWidth; x++) {
                    const targetIndex = (y * rotatedWidth + x) * components;
                    
                    // 计算在旋转前图案中的坐标
                    const adjustedX = x - offsetX;
                    const adjustedY = y - offsetY;
                    
                    const relativeX = adjustedX - patternCenterX;
                    const relativeY = adjustedY - patternCenterY;
                    
                    // 反向旋转获取原始坐标
                    const originalX = relativeX * cos + relativeY * sin + patternCenterX;
                    const originalY = -relativeX * sin + relativeY * cos + patternCenterY;
                    
                    // 检查是否在原始图案范围内（不使用模运算，保持图案独立性）
                    if (originalX >= 0 && originalX < scaledPatternWidth && originalY >= 0 && originalY < scaledPatternHeight) {
                        // 映射到原始图案像素
                        const sourceX = Math.floor(originalX * patternWidth / scaledPatternWidth);
                        const sourceY = Math.floor(originalY * patternHeight / scaledPatternHeight);
                        
                        // 确保索引在有效范围内
                        const clampedSourceX = Math.max(0, Math.min(patternWidth - 1, sourceX));
                        const clampedSourceY = Math.max(0, Math.min(patternHeight - 1, sourceY));
                        
                        const sourceIndex = (clampedSourceY * patternWidth + clampedSourceX) * components;
                        
                        for (let c = 0; c < components; c++) {
                            rotatedPatternData[targetIndex + c] = patternData[sourceIndex + c];
                        }
                    } else {
                        // 超出原始图案范围的部分设为透明（灰度值0），与ClearHandler保持一致
                        for (let c = 0; c < components; c++) {
                            rotatedPatternData[targetIndex + c] = 0;
                        }
                    }
                }
            }
            
            // 使用旋转后的图案进行无缝平铺
            console.log(`🔄 开始平铺旋转后的图案`);
            
            for (let y = 0; y < targetHeight; y++) {
                for (let x = 0; x < targetWidth; x++) {
                    const targetIndex = (y * targetWidth + x) * components;
                    
                    // 如果有bounds参数，使用全局坐标进行平铺（与ClearHandler保持一致）
                    let globalX, globalY;
                    if (bounds) {
                        globalX = bounds.left + x;
                        globalY = bounds.top + y;
                    } else {
                        globalX = x;
                        globalY = y;
                    }
                    
                    // 计算在旋转后图案中的位置（确保无缝平铺）
                    const tileX = ((globalX % rotatedWidth) + rotatedWidth) % rotatedWidth;
                    const tileY = ((globalY % rotatedHeight) + rotatedHeight) % rotatedHeight;
                    
                    const sourceIndex = (tileY * rotatedWidth + tileX) * components;
                    
                    // 检查源索引是否有效
                    if (sourceIndex >= 0 && sourceIndex < rotatedPatternData.length - components + 1) {
                        for (let c = 0; c < components; c++) {
                            resultData[targetIndex + c] = rotatedPatternData[sourceIndex + c];
                        }
                    } else {
                        // 如果索引无效，使用透明像素
                        for (let c = 0; c < components; c++) {
                            resultData[targetIndex + c] = 0; // 透明
                        }
                    }
                }
            }
        }
        
        // 如果需要生成透明度数据，创建对应的alpha数组
        let alphaData: Uint8Array | undefined;
        if (generateAlphaData && components === 4) {
            alphaData = new Uint8Array(targetWidth * targetHeight);
            
            // 提取alpha通道数据
            for (let i = 0; i < targetWidth * targetHeight; i++) {
                const sourceIndex = i * components;
                alphaData[i] = resultData[sourceIndex + 3] || 0;
            }
        }
        
        return { colorData: resultData, alphaData };
    }

    //-------------------------------------------------------------------------------------------------
    // 获取渐变填充的灰度数据
    static async getGradientFillGrayData(state: any, bounds: any) {
        try {
            const gradient = state.selectedGradient;
            if (!gradient) {
                // 优先使用selectionDocIndices.size，其次selectionValues.length，最后使用bounds面积
                const pixelCount = bounds.selectionDocIndices?.size || bounds.selectionValues?.length || (bounds.width * bounds.height);
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128);
                return grayData;
            }
            
            console.log('✅ 使用渐变数据计算灰度，渐变类型:', gradient.type, '角度:', gradient.angle, '反向:', gradient.reverse);
            
            // 检查是否有选区索引信息
            if (!bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('⚠️ 没有找到选区索引信息，回退到矩形边界处理');
                const pixelCount = bounds.width * bounds.height;
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128);
                return grayData;
            }
            
            // 只为选区内的像素生成灰度数据
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const grayData = new Uint8Array(selectionIndices.length);
            
            // 计算渐变的中心点和角度（基于选区边界）
            const centerX = bounds.width / 2;
            const centerY = bounds.height / 2;
            
            // 使用新的外接矩形算法计算起点和终点（与GradientFill.ts保持一致）
            const gradientPoints = this.calculateGradientBounds(0, 0, bounds.width, bounds.height, gradient.angle || 0);
            
            let startX, startY, endX, endY;
            
            // 如果reverse为true，交换起点和终点
            if (gradient.reverse) {
                startX = gradientPoints.endX;
                startY = gradientPoints.endY;
                endX = gradientPoints.startX;
                endY = gradientPoints.startY;
            } else {
                startX = gradientPoints.startX;
                startY = gradientPoints.startY;
                endX = gradientPoints.endX;
                endY = gradientPoints.endY;
            }
            
            console.log('📊 开始为选区内', selectionIndices.length, '个像素计算渐变灰度');
            
            // 遍历选区内的每个像素
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex: number = selectionIndices[i];
                
                // 将文档索引转换为选区边界内的坐标
                const docX = docIndex % bounds.docWidth;
                const docY = Math.floor(docIndex / bounds.docWidth);
                const boundsX = docX - bounds.left;
                const boundsY = docY - bounds.top;
                
                let position;
                
                if (gradient.type === 'radial') {
                    // 径向渐变
                    const dx = boundsX - centerX;
                    const dy = boundsY - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
                    position = Math.min(1, distance / maxDistance);
                } else {
                    // 线性渐变 - 使用与GradientFill.ts一致的计算方法
                    const dx = boundsX - startX;
                    const dy = boundsY - startY;
                    const gradientDx = endX - startX;
                    const gradientDy = endY - startY;
                    const gradientLengthSq = gradientDx * gradientDx + gradientDy * gradientDy;
                    
                    if (gradientLengthSq > 0) {
                        const dotProduct = dx * gradientDx + dy * gradientDy;
                        position = Math.max(0, Math.min(1, dotProduct / gradientLengthSq));
                    } else {
                        position = 0;
                    }
                }
                
                // 根据位置插值渐变颜色并转换为灰度。
                // ⚠️ 边界处理④：这里**只取颜色灰度**，不乘停止点不透明度。
                //    重构前此处是 `(色灰度/255) × (不透明度/100) × 255`，而调用方
                //    （buildClearFillData）随后又通过 generateGradientAlphaData 把同一个
                //    不透明度作为 α 应用一次 ⇒ 半透明区段的清除量被**平方衰减**
                //    （50% 不透明的色标只清除 25% 的量）。现在不透明度只由 α 承载一次。
                const colorWithOpacity = this.interpolateGradientColorWithOpacity(gradient.stops, position);

                grayData[i] = Math.round(
                    0.299 * colorWithOpacity.red +
                    0.587 * colorWithOpacity.green +
                    0.114 * colorWithOpacity.blue
                );
            }
            
            console.log('✅ 渐变灰度数据生成完成，数据长度:', grayData.length);
            return grayData;
        } catch (error) {
            console.error('获取渐变灰度数据失败:', error);
            // 优先使用selectionDocIndices.size，其次selectionValues.length，最后使用bounds面积
            const pixelCount = bounds.selectionDocIndices?.size || bounds.selectionValues?.length || (bounds.width * bounds.height);
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128);
            console.log('📊 错误处理：生成默认灰度数据，像素数量:', pixelCount);
            return grayData;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 计算渐变的外接矩形边界点（新算法）
    static calculateGradientBounds(left: number, top: number, right: number, bottom: number, angle: number) {
        // 计算选区中心点和尺寸
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        const width = right - left;
        const height = bottom - top;
        
        // 将角度转换为弧度，调整角度以匹配预览效果
        const adjustedAngle = angle;
        const angleRad = adjustedAngle * Math.PI / 180;
        
        // 计算渐变方向的单位向量
        const dirX = Math.cos(angleRad);
        const dirY = Math.sin(angleRad);
        
        // 计算选区矩形的四个顶点
        const corners = [
            { x: left, y: top },
            { x: right, y: top },
            { x: right, y: bottom },
            { x: left, y: bottom }
        ];
        
        // 计算每个顶点在渐变方向上的投影
        let minProjection = Infinity;
        let maxProjection = -Infinity;
        
        for (const corner of corners) {
            // 计算从中心点到顶点的向量
            const dx = corner.x - centerX;
            const dy = corner.y - centerY;
            
            // 计算在渐变方向上的投影
            const projection = dx * dirX + dy * dirY;
            
            minProjection = Math.min(minProjection, projection);
            maxProjection = Math.max(maxProjection, projection);
        }
        
        // 添加小量容差确保完全覆盖
        const tolerance = Math.max(width, height) * 0.05;
        minProjection -= tolerance;
        maxProjection += tolerance;
        
        // 计算起点和终点坐标
        const startX = centerX + minProjection * dirX;
        const startY = centerY + minProjection * dirY;
        const endX = centerX + maxProjection * dirX;
        const endY = centerY + maxProjection * dirY;
        
        return {
            startX,
            startY,
            endX,
            endY
        };
    }
    
    // 插值渐变颜色（不包含透明度）
    static interpolateGradientColor(stops: any[], position: number) {
        if (!stops || stops.length === 0) {
            return { red: 128, green: 128, blue: 128 };
        }
        
        if (stops.length === 1) {
            const color = stops[0].color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            return color ? {
                red: parseInt(color[1]),
                green: parseInt(color[2]),
                blue: parseInt(color[3])
            } : { red: 128, green: 128, blue: 128 };
        }
        
        // 找到位置两侧的stop
        let leftStop = stops[0];
        let rightStop = stops[stops.length - 1];
        
        for (let i = 0; i < stops.length - 1; i++) {
            if (stops[i].position <= position * 100 && stops[i + 1].position >= position * 100) {
                leftStop = stops[i];
                rightStop = stops[i + 1];
                break;
            }
        }
        
        const leftColor = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
         const rightColor = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
         
         if (!leftColor || !rightColor) {
             return { red: 128, green: 128, blue: 128, opacity: 100 };
         }
         
         // 解析透明度
         const leftOpacity = leftColor[4] !== undefined ? Math.round(parseFloat(leftColor[4]) * 100) : 100;
         const rightOpacity = rightColor[4] !== undefined ? Math.round(parseFloat(rightColor[4]) * 100) : 100;
         
         // 计算插值比例，考虑中点位置
         let ratio = (position * 100 - leftStop.position) / (rightStop.position - leftStop.position);
         
         // 如果存在中点信息，应用中点插值
         const midpoint = leftStop.midpoint ?? rightStop.midpoint ?? 50;
         if (midpoint !== 50) {
             const midpointRatio = midpoint / 100;
             if (ratio <= midpointRatio) {
                 // 在左侧停止点和中点之间
                 ratio = (ratio / midpointRatio) * 0.5;
             } else {
                 // 在中点和右侧停止点之间
                 ratio = 0.5 + ((ratio - midpointRatio) / (1 - midpointRatio)) * 0.5;
             }
         }
         
         return {
             red: Math.round(parseInt(leftColor[1]) * (1 - ratio) + parseInt(rightColor[1]) * ratio),
             green: Math.round(parseInt(leftColor[2]) * (1 - ratio) + parseInt(rightColor[2]) * ratio),
             blue: Math.round(parseInt(leftColor[3]) * (1 - ratio) + parseInt(rightColor[3]) * ratio),
             opacity: Math.round(leftOpacity * (1 - ratio) + rightOpacity * ratio)
         };
    }
    
    // 插值渐变颜色（包含透明度）
    static interpolateGradientColorWithOpacity(stops: any[], position: number, forOpacity: boolean = false) {
        if (!stops || stops.length === 0) {
            return { red: 128, green: 128, blue: 128, opacity: 100 };
        }
        
        if (stops.length === 1) {
            const color = stops[0].color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            const opacity = color && color[4] !== undefined ? Math.round(parseFloat(color[4]) * 100) : 100;
            return color ? {
                red: parseInt(color[1]),
                green: parseInt(color[2]),
                blue: parseInt(color[3]),
                opacity: opacity
            } : { red: 128, green: 128, blue: 128, opacity: 100 };
        }
        
        // 找到位置两侧的stop
        let leftStop = stops[0];
        let rightStop = stops[stops.length - 1];
        
        for (let i = 0; i < stops.length - 1; i++) {
            if (stops[i].position <= position * 100 && stops[i + 1].position >= position * 100) {
                leftStop = stops[i];
                rightStop = stops[i + 1];
                break;
            }
        }
        
        const leftColor = leftStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        const rightColor = rightStop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        
        if (!leftColor || !rightColor) {
            return { red: 128, green: 128, blue: 128, opacity: 100 };
        }
        
        // 解析透明度
        const leftOpacity = leftColor[4] !== undefined ? Math.round(parseFloat(leftColor[4]) * 100) : 100;
        const rightOpacity = rightColor[4] !== undefined ? Math.round(parseFloat(rightColor[4]) * 100) : 100;
        
        // 计算插值比例，考虑中点位置
        let ratio = (position * 100 - leftStop.position) / (rightStop.position - leftStop.position);
        
        // 如果存在中点信息，应用中点插值（灰度/颜色用 midpoint，不透明度用 opacityMidpoint）
        const midpoint = forOpacity
            ? (leftStop.opacityMidpoint ?? rightStop.opacityMidpoint ?? 50)
            : (leftStop.midpoint ?? rightStop.midpoint ?? 50);
        if (midpoint !== 50) {
            const midpointRatio = midpoint / 100;
            if (ratio <= midpointRatio) {
                // 在左侧停止点和中点之间
                ratio = (ratio / midpointRatio) * 0.5;
            } else {
                // 在中点和右侧停止点之间
                ratio = 0.5 + ((ratio - midpointRatio) / (1 - midpointRatio)) * 0.5;
            }
        }
        
        return {
            red: Math.round(parseInt(leftColor[1]) * (1 - ratio) + parseInt(rightColor[1]) * ratio),
            green: Math.round(parseInt(leftColor[2]) * (1 - ratio) + parseInt(rightColor[2]) * ratio),
            blue: Math.round(parseInt(leftColor[3]) * (1 - ratio) + parseInt(rightColor[3]) * ratio),
            opacity: Math.round(leftOpacity * (1 - ratio) + rightOpacity * ratio)
        };
    }



    //-------------------------------------------------------------------------------------------------
    // 将计算后的灰度数据写回快速蒙版通道
    static async updateQuickMaskChannel(grayData: Uint8Array, bounds: any, state?: any) {
        try {
            console.log('🔄 将选区重新改回快速蒙版');
            
            let documentColorProfile = "Dot Gain 15%"; // 默认值
            
            // 使用bounds中已经获取的文档尺寸信息，确保为整数
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);
            
            // 创建完整文档尺寸的ImageData
            const fullOptions = {
                width: finalDocWidth,
                height: finalDocHeight,
                components: 1,
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            const fullImageData = await imaging.createImageDataFromBuffer(grayData, fullOptions);
            
            // 使用putSelection更新整个快速蒙版
            await imaging.putSelection({
                documentID: app.activeDocument.id,
                imageData: fullImageData
            });
            
            fullImageData.dispose();
            
            // 重新进入快速蒙版
            await action.batchPlay([
                {
                _obj: "set",
                _target: [
                    {
                        _ref: "property",
                        _property: "quickMask"
                    },
                    {
                        _ref: "document",
                        _enum: "ordinal",
                        _value: "targetEnum"
                    }
                ],
                _options: {
                    dialogOptions: "dontDisplay"
                }
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
            // 根据state参数和bounds.selectionValues判断是否需要恢复选区
            if (state && state.deselectAfterFill === false && bounds && bounds.selectionValues && bounds.selectionValues.length > 0) {
                try {
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullSelectionData = new Uint8Array(finalDocWidth * finalDocHeight);
                    
                    if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                        const selectionIndices = Array.from(bounds.selectionDocIndices);
                        let valueIndex = 0;
                        
                        for (const docIndex of selectionIndices) {
                            if (docIndex < fullSelectionData.length && valueIndex < bounds.selectionValues.length) {
                                fullSelectionData[docIndex] = bounds.selectionValues[valueIndex];
                                valueIndex++;
                            } else if (valueIndex >= bounds.selectionValues.length) {
                                break; // 已经处理完所有选区值，提前退出循环
                            }
                        }
                    }
                    
                    // 创建选区ImageData
                    const selectionOptions = {
                        width: finalDocWidth,
                        height: finalDocHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: documentColorProfile,
                        colorSpace: "Grayscale"
                    };
                    
                    const selectionImageData = await imaging.createImageDataFromBuffer(fullSelectionData, selectionOptions);
                    
                    // 恢复选区
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: selectionImageData
                    });
                    
                    // 释放ImageData内存
                    selectionImageData.dispose();
                } catch (selectionError) {
                    console.error('❌ 恢复选区失败:', selectionError);
                }
            }
            
        } catch (error) {
            console.error('❌ 更新快速蒙版通道失败:', error);
        }
    }

    //-------------------------------------------------------------------------------------------------
    // 获取当前激活图层的ID
    static async getCurrentLayerId() {
        try {
            const result = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [
                        {
                            _ref: "layer",
                            _enum: "ordinal",
                            _value: "targetEnum"
                        }
                    ]
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            
            return result[0]?.layerID;
        } catch (error) {
            console.error('❌ 获取当前图层ID失败:', error);
            return null;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 为渐变生成透明度数据（基于渐变stops中的透明度信息）
    static async generateGradientAlphaData(state: any, bounds: any): Promise<Uint8Array | null> {
        try {
            console.log('🌈 开始生成渐变透明度数据');
            
            const gradient = state.selectedGradient;
            if (!gradient || !gradient.stops) {
                console.log('⚠️ 没有渐变数据，返回完全不透明');
                return null;
            }
            
            // 检查是否有选区索引信息
            if (!bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('⚠️ 没有找到选区索引信息');
                return null;
            }
            
            // 只为选区内的像素生成透明度数据
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const alphaData = new Uint8Array(selectionIndices.length);
            
            // 计算渐变的中心点和角度（基于选区边界）
            const centerX = bounds.width / 2;
            const centerY = bounds.height / 2;
            
            // 使用与getGradientFillGrayData相同的算法计算起点和终点
            const gradientPoints = this.calculateGradientBounds(0, 0, bounds.width, bounds.height, gradient.angle || 0);
            
            let startX, startY, endX, endY;
            
            // 如果reverse为true，交换起点和终点
            if (gradient.reverse) {
                startX = gradientPoints.endX;
                startY = gradientPoints.endY;
                endX = gradientPoints.startX;
                endY = gradientPoints.startY;
            } else {
                startX = gradientPoints.startX;
                startY = gradientPoints.startY;
                endX = gradientPoints.endX;
                endY = gradientPoints.endY;
            }
            
            console.log('📊 开始为选区内', selectionIndices.length, '个像素计算渐变透明度');
            
            // 遍历选区内的每个像素
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex: number = selectionIndices[i];
                
                // 将文档索引转换为选区边界内的坐标
                const docX = docIndex % bounds.docWidth;
                const docY = Math.floor(docIndex / bounds.docWidth);
                const boundsX = docX - bounds.left;
                const boundsY = docY - bounds.top;
                
                let position;
                
                if (gradient.type === 'radial') {
                    // 径向渐变
                    const dx = boundsX - centerX;
                    const dy = boundsY - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
                    position = Math.min(1, distance / maxDistance);
                } else {
                    // 线性渐变
                    const dx = boundsX - startX;
                    const dy = boundsY - startY;
                    const gradientDx = endX - startX;
                    const gradientDy = endY - startY;
                    const gradientLengthSq = gradientDx * gradientDx + gradientDy * gradientDy;
                    
                    if (gradientLengthSq > 0) {
                        const dotProduct = dx * gradientDx + dy * gradientDy;
                        position = Math.max(0, Math.min(1, dotProduct / gradientLengthSq));
                    } else {
                        position = 0;
                    }
                }
                
                // 根据位置插值渐变透明度
                const colorWithOpacity = this.interpolateGradientColorWithOpacity(gradient.stops, position, true);
                
                // 将不透明度转换为0-255范围的透明度值
                alphaData[i] = Math.round((colorWithOpacity.opacity / 100) * 255);
            }
            
            console.log('✅ 渐变透明度数据生成完成，数据长度:', alphaData.length);
            return alphaData;
        } catch (error) {
            console.error('❌ 生成渐变透明度数据失败:', error);
            return null;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 为图层蒙版模式生成PNG透明度数据
    static async generateLayerMaskAlphaData(pattern: Pattern, bounds: any): Promise<Uint8Array | null> {
        try {
            if (!pattern.patternRgbData || !pattern.components || pattern.components !== 4) {
                console.log('⚠️ 图案不支持透明度或缺少RGBA数据');
                return null;
            }

            const patternWidth = pattern.width || pattern.originalWidth || 100;
            const patternHeight = pattern.height || pattern.originalHeight || 100;
            const scale = pattern.currentScale || pattern.scale || 100;
            const scaledPatternWidth = Math.round(patternWidth * scale / 100);
            const scaledPatternHeight = Math.round(patternHeight * scale / 100);
            const angle = pattern.currentAngle || pattern.angle || 0;
            const fillMode = pattern.fillMode || 'tile';

            let alphaResult: { alphaData?: Uint8Array };

            if (fillMode === 'stamp') {
                // 盖图章模式：生成透明度数据
                console.log('🎯 图层蒙版：使用盖图章模式生成透明度数据');
                alphaResult = await this.createStampPatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    4, // RGBA数据
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    bounds,
                    false, // 非灰度模式
                    true // 生成透明度数据
                );
            } else {
                // 贴墙纸模式：生成透明度数据
                console.log('🧱 图层蒙版：使用贴墙纸模式生成透明度数据');
                alphaResult = this.createTilePatternData(
                    pattern.patternRgbData,
                    patternWidth,
                    patternHeight,
                    4, // RGBA数据
                    bounds.width,
                    bounds.height,
                    scaledPatternWidth,
                    scaledPatternHeight,
                    angle,
                    pattern.rotateAll !== false,
                    bounds,
                    true // 生成透明度数据
                );
            }

            if (!alphaResult.alphaData) {
                console.log('⚠️ 无法生成透明度数据');
                return null;
            }

            // 如果有选区索引，提取选区内的透明度数据
            if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                const selectionIndices = Array.from(bounds.selectionDocIndices);
                const selectionAlphaData = new Uint8Array(selectionIndices.length);

                for (let i = 0; i < selectionIndices.length; i++) {
                    const docIndex: number = selectionIndices[i];
                    const docX = docIndex % bounds.docWidth;
                    const docY = Math.floor(docIndex / bounds.docWidth);
                    const boundsX = docX - bounds.left;
                    const boundsY = docY - bounds.top;

                    if (boundsX >= 0 && boundsX < bounds.width && boundsY >= 0 && boundsY < bounds.height) {
                        const boundsIndex = boundsY * bounds.width + boundsX;
                        if (boundsIndex < alphaResult.alphaData.length) {
                            selectionAlphaData[i] = alphaResult.alphaData[boundsIndex];
                        } else {
                            selectionAlphaData[i] = 255; // 默认不透明
                        }
                    } else {
                        selectionAlphaData[i] = 255; // 默认不透明
                    }
                }

                console.log('✅ 成功生成图层蒙版透明度数据，选区内像素数:', selectionAlphaData.length);
                return selectionAlphaData;
            }

            console.log('✅ 成功生成图层蒙版透明度数据，总像素数:', alphaResult.alphaData.length);
            return alphaResult.alphaData;

        } catch (error) {
            console.error('❌ 生成图层蒙版透明度数据失败:', error);
            return null;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 获取图层蒙版通道的像素数据
    static async getLayerMaskPixels(bounds: any, layerId: number) {
        try {
            console.log('🎭 开始获取图层蒙版数据，图层ID:', layerId);
            
            // 根据官方文档，使用getLayerMask获取完整文档的图层蒙版像素数据
            // 添加sourceBounds参数以符合API规范
            const pixels = await imaging.getLayerMask({
                documentID: app.activeDocument.id,
                layerID: layerId,
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: bounds.docWidth,
                    bottom: bounds.docHeight
                },
                componentSize: 8
            });
            
            const fullDocMaskArray = await pixels.imageData.getData();
            console.log('🎯 完整文档蒙版数组长度:', fullDocMaskArray.length);
            
            // 从完整文档长度的蒙版数组中按照索引提取选区内的蒙版像素数据
            const selectionSize = bounds.selectionDocIndices.size;
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            
            // 提取选区内的图层蒙版值并计算统计信息
            const selectionMaskValues = [];
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex: number = selectionIndices[i];
                if (docIndex >= 0 && docIndex < fullDocMaskArray.length) {
                    selectionMaskValues.push(fullDocMaskArray[docIndex]);
                }
            }
            
            let minVal = 255, maxVal = 0, zeroCount = 0, fullCount = 0;
            for (const val of selectionMaskValues) {
                minVal = Math.min(minVal, val);
                maxVal = Math.max(maxVal, val);
                if (val === 0) zeroCount++;
                if (val === 255) fullCount++;
            }
            console.log('🎯 选区内图层蒙版值统计: 最小值=', minVal, '最大值=', maxVal, '黑色像素=', zeroCount, '白色像素=', fullCount);
            
            const maskPixels = new Uint8Array(selectionSize);
            console.log('🎯 选区索引数量:', selectionIndices.length, '第一个索引:', selectionIndices[0], '最后一个索引:', selectionIndices[selectionIndices.length - 1]);
            
            let outOfRangeCount = 0;
            // 遍历选区内的每个像素，从完整文档蒙版数组中提取对应的值
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex: number = selectionIndices[i];
                if (docIndex >= 0 && docIndex < fullDocMaskArray.length) {
                    maskPixels[i] = fullDocMaskArray[docIndex];
                } else {
                    outOfRangeCount++;
                    maskPixels[i] = fullDocMaskArray[docIndex] || 0; // 保持原始像素值或默认黑色
                }
                
                // 只输出前3个像素的提取过程
                if (i < 3) {
                    console.log(`🎯 提取像素${i}: 文档索引=${docIndex}, 蒙版值=${maskPixels[i]}`);
                }
            }
            
            if (outOfRangeCount > 0) {
                console.warn(`⚠️ ${outOfRangeCount}个索引超出范围，使用默认值0`);
            }
            
            // 计算提取数据的统计信息
            let extractedMin = 255, extractedMax = 0;
            let blackPixels = 0, whitePixels = 0;
            let isEmpty = true;
            
            for (let i = 0; i < maskPixels.length; i++) {
                const value = maskPixels[i];
                if (value > 0) isEmpty = false;
                extractedMin = Math.min(extractedMin, value);
                extractedMax = Math.max(extractedMax, value);
                if (value === 0) blackPixels++;
                if (value === 255) whitePixels++;
            }
            
            const stats = {
                minValue: extractedMin,
                maxValue: extractedMax,
                blackPixels,
                whitePixels,
                isEmpty
            };
            
            console.log('🎯 图层蒙版选区内像素数量:', selectionSize);
            console.log('🎯 提取的蒙版数据统计: 最小值=', extractedMin, '最大值=', extractedMax);
            console.log('📊 图层蒙版统计信息:', stats);
            
            // 释放ImageData内存
            pixels.imageData.dispose();
            
            return {
                maskData: fullDocMaskArray,
                selectedMaskData: maskPixels,
                stats
            };
        } catch (error) {
            console.error('❌ 获取图层蒙版像素数据失败:', error);
            throw error;
        }
    }
    
    //-------------------------------------------------------------------------------------------------
    // 更新图层蒙版
    static async updateLayerMask(grayData: Uint8Array, bounds: any, layerId: number, state?: any) {
        try {
            
            let documentColorProfile = "Dot Gain 15%";
            
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);
            const expectedSize = finalDocWidth * finalDocHeight;
            
            
            // 验证数据大小
            if (grayData.length !== expectedSize) {
                console.error('❌ 图层蒙版数据大小不匹配');
                console.error('期望大小:', expectedSize, '实际大小:', grayData.length);
                
                // 创建正确大小的数据缓冲区
                const correctedData = new Uint8Array(expectedSize);
                
                // 如果数据太小，用0填充；如果太大，截断
                const copySize = Math.min(grayData.length, expectedSize);
                correctedData.set(grayData.subarray(0, copySize));
                
                console.log('🔧 已创建修正后的数据缓冲区，大小:', correctedData.length);
                grayData = correctedData;
            }
            
            // 创建完整文档尺寸的ImageData
            const fullOptions = {
                width: finalDocWidth,
                height: finalDocHeight,
                components: 1,
                chunky: true,
                colorProfile: documentColorProfile,
                colorSpace: "Grayscale"
            };
            
            const fullImageData = await imaging.createImageDataFromBuffer(grayData, fullOptions);
            
            // 更新图层蒙版
            await imaging.putLayerMask({
                documentID: app.activeDocument.id,
                layerID: layerId,
                imageData: fullImageData
            });
            
            fullImageData.dispose();
            
            // 根据state参数和bounds.selectionValues判断是否需要恢复选区
             if (state && state.deselectAfterFill === false && bounds && bounds.selectionValues && bounds.selectionValues.length > 0) {
                try {
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullSelectionData = new Uint8Array(finalDocWidth * finalDocHeight);
                    
                    if (bounds.selectionDocIndices && bounds.selectionDocIndices.size > 0) {
                        const selectionIndices = Array.from(bounds.selectionDocIndices);
                        let valueIndex = 0;
                        
                        for (const docIndex of selectionIndices) {
                            if (docIndex < fullSelectionData.length && valueIndex < bounds.selectionValues.length) {
                                fullSelectionData[docIndex] = bounds.selectionValues[valueIndex];
                                valueIndex++;
                            } else if (valueIndex >= bounds.selectionValues.length) {
                                break; // 已经处理完所有选区值，提前退出循环
                            }
                        }
                    }
                    
                    // 创建选区ImageData
                    const selectionOptions = {
                        width: finalDocWidth,
                        height: finalDocHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: documentColorProfile,
                        colorSpace: "Grayscale"
                    };
                    
                    const selectionImageData = await imaging.createImageDataFromBuffer(fullSelectionData, selectionOptions);
                    
                    // 恢复选区
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: selectionImageData
                    });
                    
                    // 释放ImageData内存
                    selectionImageData.dispose();
                    
                } catch (selectionError) {
                    console.error('❌ 恢复选区失败:', selectionError);
                }
            }
            
        } catch (error) {
            console.error('❌ 更新图层蒙版失败:', error);
        }
    }

    }
