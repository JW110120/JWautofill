import { app, action, imaging, core } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Gradient, GradientStop } from '../types/state';
import { BLEND_MODE_CALCULATIONS } from './BlendModeCalculations';
import {
    blendTopIntoBase,
    compositeTopIntoBase,
    deleteActiveLayer,
    deleteLayerById,
    EmptyTargetReplacement,
    enableActiveLayerClippingMask,
    isNonPixelLayerKind,
    multiplyTopAlphaByBase,
    NON_PIXEL_LAYER_HINT,
    PixelWriteResult,
    planSpecialClipBase,
    readActiveLayerClipState,
    replaceEmptyTargetWithContent,
    resolveActiveLayerId,
    selectFrontLayer,
    selectLayerById,
    tryCreateNativeClippingMask,
} from './SpecialClipMask';
import { smLog } from './SmDebug';



interface GradientFillOptions {
    opacity: number;
    blendMode: string;
    gradient: Gradient;
    preserveTransparency?: boolean;
    /**
     * 「特殊蒙版 + 新建图层」撞上**空目标层**时的交接信息（见
     * `SpecialClipMask.replaceEmptyTargetWithContent`）。
     *
     * ⛔⛔ 有这个字段就**不能**走「像素写回目标层」那条收尾：空图层没有像素，
     *    `imaging.putPixels` 会被宿主拒绝（用户 2026-11-19 实测弹
     *    「目标图层拒绝了像素写入」）。这里改成让建好的渐变内容层**顶替**那个空层。
     */
    replaceEmptyTarget?: EmptyTargetReplacement;
}

interface LayerInfo {
    hasPixels: boolean;
    isInQuickMask: boolean;
    isInLayerMask: boolean;
    /** 图层种类（`'pixel'` / `'text'` / `'smartObject'` / …），见 LayerInfoHandler。 */
    layerKind?: string;
    /** 图层自身的混合模式（PS 原生枚举值），新分支2 还原用。 */
    blendMode?: string;
    /** 填充前的活动图层 id —— 特殊剪贴蒙版的基底。 */
    layerId?: number;
    /** 填充前的活动图层是否正在被当作别人的剪贴蒙版（决定合并要不要先 groupEvent）。 */
    isClippingMask?: boolean;
}

export class GradientFill {
    static async fillGradient(options: GradientFillOptions, layerInfo: LayerInfo, state?: any, createNewLayer?: boolean) {
        // 检查是否有渐变stops
        if (!options.gradient.stops || options.gradient.stops.length === 0) {
            console.error("❌ 没有可用的渐变stops，无法填充");
            return;
        }

        // 如果在快速蒙版状态，使用简化的直接填充
        if (layerInfo.isInQuickMask) {
            await this.fillGradientDirect(options, state);
            return;
        }

        // 如果在图层蒙版编辑状态，使用蒙版填充
        if (layerInfo.isInLayerMask) {
            await this.fillLayerMask(options, state);
            return;
        }

        // ⚠️ 下面整条收尾链路（`rasterizeLayer` → 删蒙版 apply → `mergeLayersNew` /
        //    像素写回）**只对普通像素图层成立**：
        //      · 文字层 / 智能对象 / 形状层 / 调整层：栅格化会把自己的内容换成渐变像素，
        //        等于「就地替换」而不是「填充」；
        //      · 图层组：`rasterizeLayer` 的语义完全不同（栅格化组），结果不可预期。
        //    「新建图层」模式放行 —— 那条路的结果层是新建的内容图层本身，不碰原图层。
        //    判据不能用 `hasPixels`：它的前提就是 `kind === 'pixel'`，非像素层恒为 false。
        if (!createNewLayer && isNonPixelLayerKind(layerInfo.layerKind)) {
            await core.showAlert({ message: NON_PIXEL_LAYER_HINT });
            return;
        }

        // 填充前的活动图层就是「特殊剪贴蒙版的基底」—— 再往下走活动图层会变成
        // 渐变内容图层，那时就取不到基底 id 了。
        // ⚠️ 混合模式不再需要提前记录：空图层分支现在**保留那个空图层本身**
        //    （内容层建在最顶层），`setLayerProperties` 作用的是内容层而不是空图层，
        //    所以「空图层被顶替导致混合模式被盖掉」这件事从根上消失了。
        const baseLayerId = layerInfo.layerId ?? app.activeDocument.activeLayers[0]?.id;

        /* 【新图层模式 + 特殊蒙版】的边界计划要在建渐变层**之前**算好（建层后
           `layerInfo.layerId` 就不再是目标层了）。判据与纯色 / 图案完全同源
           （SpecialClipMask.planSpecialClipBase），别在这里另写一套。
           ⚠️ 空目标层（复用目标层）那条路由上层传 `options.replaceEmptyTarget`
              显式接管，这里算出来的 `clipPlan` 只用于「目标层有内容 / 本身是剪贴层」。 */
        const clipPlan = (createNewLayer && options.preserveTransparency)
            ? planSpecialClipBase({
                layerId: baseLayerId,
                hasPixels: layerInfo.hasPixels,
                isClippingMask: layerInfo.isClippingMask,
                layerKind: layerInfo.layerKind,
            })
            : null;

        // 获取选区边界
        const bounds = app.activeDocument.selection.bounds;
        if (!bounds) {
            console.error("❌ 无法获取选区边界数据");
            return;
        }

        // 生成颜色stops
        const colorStops = this.generateColorStops(options.gradient.stops, options.gradient.reverse);
        
        // 生成透明度stops
        const transparencyStops = this.generateTransparencyStops(options.gradient.stops, options.gradient.reverse);

        // 第一步：创建渐变图层的配置
        const createGradientLayer = {
            _obj: "make",
            _target: [{
                _ref: "contentLayer"
            }],
            using: {
                _obj: "contentLayer",
                type: {
                    _obj: "gradientLayer",
                    gradientsInterpolationMethod: {
                        _enum: "gradientInterpolationMethodType",
                        _value: "smooth"
                    },
                    angle: {
                        _unit: "angleUnit",
                        // 修正角度：取负值实现顺时针旋转
                        _value: -(options.gradient.angle || 0)
                    },
                    type: {
                        _enum: "gradientType",
                        _value: options.gradient.type || "linear"
                    },
                    reverse: false,
                    gradient: {
                        _obj: "gradientClassEvent",
                        gradientForm: {
                            _enum: "gradientForm",
                            _value: "customStops"
                        },
                        interfaceIconFrameDimmed: 4096,
                        colors: colorStops,
                        transparency: transparencyStops
                    }
                }
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        // 第二步：设置图层属性的配置
        const setLayerProperties = {
            _obj: "set",
            _target: [{
                _ref: "layer",
                _enum: "ordinal",
                _value: "targetEnum"
            }],
            to: {
                _obj: "layer",
                opacity: {
                    _unit: "percentUnit",
                    _value: options.opacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: BLEND_MODES[options.blendMode] || "normal"
                }
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        // 第三步：收尾用的两条命令
        // ⚠️ 这里**没有**「创建剪贴蒙版」也没有「向下合并」常驻命令了：两者的合法性
        //    都取决于剪贴关系（见 SpecialClipMask.mergeIntoBase），统一过去了。
        //    「特殊剪贴蒙版」由 SpecialClipMask 用 imaging 做像素合成，见下方分支 3a。
        const rasterizeLayer = {
                _obj: "rasterizeLayer",
                _target: [{
                    _ref: "layer",
                    _enum: "ordinal",
                    _value: "targetEnum"
                }],
                _options: {
                    dialogOptions: "dontDisplay"
                }
        };
    
        const applyMask = {
                   _obj: "delete",
                   _target: [
                      {
                         _ref: "channel",
                         _enum: "channel",
                         _value: "mask"
                      }
                   ],
                   apply: true,
                   _isCommand: false
        };

        try {
            // ⚠️⚠️ 「不新建图层」时**先把活动目标切到文档最顶层**，再创建内容层。
            //    理由（用户 2026-11-19 实测）：目标是剪贴基底（A 上面挂着若干剪贴层）时，
            //    PS 会把新建的渐变层**自动塞进那个剪贴组** ⇒ 读它的像素 / 删它都带裁剪
            //    语义，而唯一的解法 `ungroup` 会把**整组**剪贴一起解除（一次填充，三个
            //    箭头全没）。放到最顶层 ⇒ 一出生就没有任何剪贴关系，收尾统一走
            //    「像素写回目标层 → 删掉内容层」，全程不碰 groupEvent / ungroup / 合并。
            if (options.replaceEmptyTarget) {
                /* 【空目标层复用】把活动目标切到那个空层：内容层必须落在**它正上方**的
                   紧邻位置 —— 交接时删掉空层，内容层下方紧邻的就是边界层，剪贴一次到位。
                   ⛔ 这里不能走 `selectFrontLayer()`：内容层若建在文档最顶层，删掉空层的
                      那一刻它下面紧邻的是「原来最上层那个图层」，剪贴就会建错对象。 */
                await selectLayerById(options.replaceEmptyTarget.targetLayerId);
            } else if (!createNewLayer) {
                await selectFrontLayer();
            }
            /* ⚠️ 这里原本还有一条「目标层没像素 ⇒ 先把活动目标挪到紧邻下方那层，渐变层建在
               两者之间」的支路（`clipPlan.insertBelow`）。现在由 `replaceEmptyTarget`
               （空目标层交接）承担：内容层建在空层**正上方**，交接时把空层删掉。 */

            await action.batchPlay([createGradientLayer], { dialogOptions: 'dontDisplayDialogs' });
            await action.batchPlay([setLayerProperties], { dialogOptions: 'dontDisplayDialogs' });

            if (createNewLayer) {
                // 【分支 1】新图层模式：内容图层本身就是结果层，不向下合并
                // （`mergeLayersNew` 会跳过新建的空白图层、把渐变合并进原图层）。
                // 先把选区定形进 alpha，再按需施加特殊剪贴；结果层独立保留。
                await action.batchPlay([rasterizeLayer], { dialogOptions: 'dontDisplayDialogs' });
                await action.batchPlay([applyMask], { dialogOptions: 'dontDisplayDialogs' });

                if (options.replaceEmptyTarget) {
                    /* 【特殊蒙版 + 空目标层】内容层顶替那个空层（用户 2026-11-19 实测）：
                       ⛔ 绝不把像素写回空层（`putPixels` 会被宿主拒绝，见
                          `EmptyTargetReplacement` 的注释）；这里直接做
                          「收窄 → 删空层 → 改名 → 建剪贴」这一套交接。 */
                    const contentId = await resolveActiveLayerId();
                    smLog('渐变·交接前', {
                        contentId,
                        baseLayerId,
                        replaceEmptyTarget: options.replaceEmptyTarget,
                        preserve: !!options.preserveTransparency,
                    });
                    const ok = await replaceEmptyTargetWithContent({
                        ...options.replaceEmptyTarget,
                        contentLayerId: contentId,
                    });
                    smLog('渐变·交接返回', ok);
                } else if (options.preserveTransparency) {
                    // ⚠️⚠️ 「建立剪贴关系」和「按基底自身 alpha 收窄」是**两件事**，都得做：
                    //    · 目标层本身是剪贴层时，原生剪贴只能让它被**组基底**裁，组基底 ≠
                    //      目标层 ⇒ 内容会渲染在目标层 alpha=0 的位置；
                    //    · 目标层在剪贴组内**最上层**时，PS 并不保证把新建层自动放进同组
                    //      （实测它会落到组外）⇒ 不能因为「基底是剪贴层」就跳过建剪贴，
                    //      否则收尾后图层上没有剪贴箭头（用户 2026-11-19 实测）。
                    //    所以：① 先争取剪贴关系（已在组内则只读判据，不重复下发）；
                    //          groupEvent 被拒时直接写 DOM 的剪贴标志（只置真）；
                    //         ② 剪贴指向的是组基底 / ① 失败 ⇒ 再做一次像素收窄。
                    let clipped = readActiveLayerClipState().isClippingMask;
                    if (!clipped) clipped = await tryCreateNativeClippingMask();

                    // ⚠️ 栅格化有可能换掉图层 id ⇒ 收窄 / 写剪贴标志都用**此刻**的活动图层
                    //    （batchPlay 的即时值），别拿创建前那个 id（读不到就静默白跑）。
                    let topId: number | null = null;
                    if (!clipped) {
                        topId = await resolveActiveLayerId();
                        clipped = await enableActiveLayerClippingMask(topId);
                    }

                    /* ⛔ 像素收窄**一律要做**（用户 2026-11-19 第 16 轮实测）：原生剪贴只是
                       渲染期裁剪，越界的像素物理上还在 ⇒ 只建箭头会出现「有剪贴符号、
                       但像素铺满整个选区」。边界层是像素层才收窄（非像素层只能靠箭头裁）。 */
                    const boundaryId = clipPlan?.boundaryLayerId ?? baseLayerId;
                    if (boundaryId && (clipPlan ? clipPlan.boundaryHasPixels : true)) {
                        if (!topId) topId = await resolveActiveLayerId();
                        if (topId && topId !== boundaryId) {
                            await multiplyTopAlphaByBase({
                                docId: app.activeDocument.id,
                                baseLayerId: boundaryId,
                                topLayerId: topId,
                            });
                        }
                    }
                }
                // ⚠️ 「新层模式 + 不做特殊剪贴」**不做任何剪贴处理**：PS 把新建层插在
                //    剪贴基底正上方时会自动给它打上剪贴标志，而 PS 里没有任何「只释放
                //    这一层」的命令 —— `ungroup` 与 `Layer.isClippingMask = false` 都会
                //    把这组里**上方所有**剪贴层一起释放（UXP 文档原文：Releasing a
                //    clipping mask will also release the layers above）。宁可让它按 PS
                //    的原生位置/关系存在，也绝不牵连用户其它剪贴层。
            } else {
                // 【分支 2 / 3】内容层位于最顶层（无剪贴关系）：
                // 栅格化 + 应用蒙版把「选区」定形进 alpha，然后把颜色按语义**写回目标层**，
                // 最后删掉内容层。三种目标共用这一条收尾，差别只在写回的权重：
                //   · 目标有像素 + 特殊剪贴 → 权重乘基底 alpha，**基底 alpha 一个字节不动**；
                //   · 目标有像素 + 普通填充 → alpha 取并集（= 一次「向下合并」）；
                //   · 目标是空图层       → 同上（读不到基底像素就按全透明算，整块写进去）。
                // 这样做的收益：结果与剪贴关系完全解耦 —— 不会再出现「合并图层不可用」，
                // 也不会为了纠正裁剪语义去动同组的其它剪贴层。
                await action.batchPlay([rasterizeLayer], { dialogOptions: 'dontDisplayDialogs' });

                // ⚠️ 「应用图层蒙版」是像素写回路径的**前提**：`imaging` 读写看不到图层
                //    蒙版 —— 蒙版没被应用掉就写回，等于把渐变按整层（而不是选区）糊上去。
                //    所以这里**不吞错就当没事**：失败 ⇒ 关掉像素写回、走下面的合并降级
                //    （合并会正常吃蒙版，结果至少是对的，只是要跟剪贴关系打交道）。
                let maskApplied = true;
                try {
                    await action.batchPlay([applyMask], { dialogOptions: 'dontDisplayDialogs' });
                } catch (e) {
                    maskApplied = false;
                    console.warn('⚠️ 应用图层蒙版失败 ⇒ 放弃像素写回，改走合并降级:', e);
                }

                const contentId = await resolveActiveLayerId();
                const useSpecialClip = !!layerInfo.hasPixels && !!options.preserveTransparency;

                const writeResult: PixelWriteResult = (maskApplied && contentId && baseLayerId)
                    ? (useSpecialClip
                        ? await blendTopIntoBase({
                            docId: app.activeDocument.id,
                            baseLayerId,
                            topLayerId: contentId,
                            opacity: options.opacity,
                            blendMode: options.blendMode,
                        })
                        : await compositeTopIntoBase({
                            docId: app.activeDocument.id,
                            baseLayerId,
                            topLayerId: contentId,
                            opacity: options.opacity,
                            blendMode: options.blendMode,
                        }))
                    : 'failed';

                if (writeResult !== 'failed') {
                    // `'written'` = 已写回；`'nothing'` = 按语义本来就不该写
                    // （特殊剪贴：基底在选区处 alpha 全为 0 ⇒ 一个像素都不该填）。
                    // ⚠️ 两者都必须只**删掉内容层**：`'nothing'` 尤其不能降级合并 ——
                    //    合并只认紧邻的那一层，会填到别人的图层上（用户实测：在
                    //    alpha=0 处填充，结果落在最上方的剪贴蒙版上）。
                    if (contentId) {
                        if (!(await deleteLayerById(contentId))) await deleteActiveLayer();
                    } else {
                        await deleteActiveLayer();
                    }
                } else {
                    // 【写回被拒】像素写回走不通（蒙版没能应用 / 目标锁了「透明像素」/
                    // 背景层或非像素层拒绝写入）。⛔ **不做任何降级合并**：
                    //   `mergeLayersNew` / `groupEvent` 只认**紧邻的那一层**，而内容层此刻
                    //   在文档最顶层，合并会把渐变糊到别人的图层上（用户 2026-11-19 实测：
                    //   填到了最上方的剪贴蒙版上，还顺手新建了一个剪贴蒙版）。
                    // ⇒ 撤回内容层，让文档回到填充前的样子，然后明确报失败。
                    if (contentId) {
                        if (!(await deleteLayerById(contentId))) await deleteActiveLayer();
                    } else {
                        await deleteActiveLayer();
                    }

                    const reason = !maskApplied
                        ? '无法把选区应用成图层蒙版'
                        : (!contentId || !baseLayerId)
                            ? '找不到内容图层或目标图层'
                            : '目标图层拒绝了像素写入（可能锁定了「透明像素」，或该图层类型不支持写入）';
                    // 报错前先把手上的图层还给用户：删层会让 PS 自动选中相邻层，
                    // 用户点掉弹框后看到的应该是自己原本那个图层。
                    if (baseLayerId) await selectLayerById(baseLayerId);
                    await core.showAlert({
                        message: `渐变填充未完成：${reason}。\n临时图层已撤回，原有图层未被改动。`
                    });
                }

                // 收尾：把活动目标还给用户原本的图层（删层 / 合并都会把活动层换掉）
                if (baseLayerId) await selectLayerById(baseLayerId);
            }

            // 选中上一个选区（为主面板的「清除选区」留后路）。
            // ⚠️ 单独 try/catch + silent：没有上一个选区时这条 `set` 会被宿主拒绝，
            //    而失败的命令**会弹原生「设置不可用」框并绕过外层 catch** ——
            //    它只是「留后路」，绝不能因此把一次已经成功的填充判死。
            try {
                await action.batchPlay([{
                    _obj: "set",
                    _target: [
                        {
                            _ref: "channel",
                            _property: "selection"
                        }
                    ],
                    to: {
                        _enum: "ordinal",
                        _value: "previous"
                    },
                    _options: {
                        dialogOptions: "silent"
                    }
                }], { synchronousExecution: true });
            } catch (e) {
                console.warn('⚠️ 还原上一个选区失败（不影响本次填充）:', e);
            }

        } catch (error) {
            console.error("❌ 渐变填充失败:", error);
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 生成颜色stops
    private static generateColorStops(stops: GradientStop[], reverse: boolean = false) {
        return stops.map((stop, index) => {
            // 解析颜色
            const color = this.parseColor(stop.color);
            
            // 如果reverse为true，反转位置
            const position = reverse ? (100 - stop.position) : stop.position;
            
            return {
                _obj: "colorStop",
                color: {
                    _obj: "RGBColor",
                    red: color.red,
                    green: color.green,
                    blue: color.blue
                },
                type: {
                    _enum: "colorStopType",
                    _value: "userStop"
                },
                location: Math.round((position / 100) * 4096),
                // 使用stop中的midpoint属性，如果没有则默认为50
                midpoint: stop.midpoint !== undefined ? stop.midpoint : 50
            };
        });
    }

    //----------------------------------------------------------------------------------
    // 生成透明度stops
    private static generateTransparencyStops(stops: GradientStop[], reverse: boolean = false) {
        return stops.map((stop, index) => {
            // 解析透明度
            const opacity = this.parseOpacity(stop.color);
            
            // 如果reverse为true，反转位置
            const position = reverse ? (100 - stop.position) : stop.position;
            
            return {
                _obj: "transferSpec",
                opacity: {
                    _unit: "percentUnit",
                    _value: opacity
                },
                location: Math.round((position / 100) * 4096),
                // 不透明度停靠点用独立的 opacityMidpoint，颜色停靠点用 midpoint
                midpoint: stop.opacityMidpoint !== undefined ? stop.opacityMidpoint : 50
            };
        });
    }

    //----------------------------------------------------------------------------------
    // 解析颜色
    private static parseColor(colorString: string) {
        // 处理rgba格式
        const rgbaMatch = colorString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (rgbaMatch) {
            return {
                red: parseInt(rgbaMatch[1]),
                green: parseInt(rgbaMatch[2]),
                blue: parseInt(rgbaMatch[3])
            };
        }

        // 处理hex格式
        const hexMatch = colorString.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
        if (hexMatch) {
            return {
                red: parseInt(hexMatch[1], 16),
                green: parseInt(hexMatch[2], 16),
                blue: parseInt(hexMatch[3], 16)
            };
        }

        // 默认返回黑色
        return { red: 0, green: 0, blue: 0 };
    }

    //----------------------------------------------------------------------------------
    // 解析透明度
    private static parseOpacity(colorString: string) {
        const rgbaMatch = colorString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (rgbaMatch && rgbaMatch[4] !== undefined) {
            return Math.round(parseFloat(rgbaMatch[4]) * 100);
        }
        return 100; // 默认完全不透明
    }




    //----------------------------------------------------------------------------------
    // 快速蒙版渐变填充（重构版本，支持渐变不透明度）
    private static async fillGradientDirect(options: GradientFillOptions, state?: any) {
        try {
            console.log("🎨 开始快速蒙版渐变填充（支持不透明度）");                         
            
            // 1. 获取选区数据和快速蒙版数据
            const bounds = await this.getSelectionData();
            if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log("❌ 无法获取选区数据或选区为空");
                return;
            }
            
            const { quickMaskPixels, isSelectedAreas, isEmpty, topLeftIsEmpty, bottomRightIsEmpty, originalTopLeft, originalBottomRight } = await this.getQuickMaskPixels(bounds);
            
            // 2. 生成渐变数据（支持不透明度）
            const gradientGrayData = await this.getGradientFillGrayData(options.gradient, bounds);
            
            // 3. 生成渐变透明度数据
            const gradientAlphaData = await this.generateGradientAlphaData(options.gradient, bounds);
            
            // 4. 混合渐变与快速蒙版数据
            const finalData = await this.calculateFinalGrayValues(
                quickMaskPixels,
                gradientGrayData,
                gradientAlphaData,
                isSelectedAreas,
                options.opacity,
                isEmpty,
                bounds,
                options.blendMode,
                topLeftIsEmpty,
                bottomRightIsEmpty,
                originalTopLeft,
                originalBottomRight
            );
            
            // 5. 将最终数据写回快速蒙版
            await this.updateQuickMaskChannel(finalData, bounds, state);
        } catch (error) {
            console.error("❌ 快速蒙版渐变填充失败:", error);
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 图层蒙版渐变填充（重构版本，支持渐变不透明度）
    private static async fillLayerMask(options: GradientFillOptions, state?: any) {
        try {
            console.log("🎨 开始图层蒙版渐变填充（支持不透明度）");
            
            // 1. 获取选区数据和图层蒙版数据
            const bounds = await this.getSelectionData();
            if (!bounds || !bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log("❌ 无法获取选区数据或选区为空");
                return;
            }
            
            // 获取当前图层ID与图层蒙版信息
            const currentLayerId = await this.getCurrentLayerId();
            if (!currentLayerId) {
                console.log("❌ 无法获取当前图层ID");
                return;
            }
            const { maskData, selectedMaskData, stats } = await this.getLayerMaskPixels(bounds, currentLayerId);
            
            // 2. 生成渐变数据（支持不透明度）
            const gradientGrayData = await this.getGradientFillGrayData(options.gradient, bounds);
            
            // 3. 生成渐变透明度数据
            const gradientAlphaData = await this.generateGradientAlphaData(options.gradient, bounds);
            
            // 4. 混合渐变与图层蒙版数据
            const finalData = await this.calculateLayerMaskFillValues(
                selectedMaskData,
                gradientGrayData,
                gradientAlphaData,
                options.opacity,
                bounds,
                maskData,
                stats.isEmpty,
                options.blendMode
            );
            
            // 5. 将最终数据写回图层蒙版
            await this.updateLayerMask(finalData, bounds, currentLayerId, maskData, state);
        } catch (error) {
            console.error("❌ 图层蒙版渐变填充失败:", error);
            throw error;
        }
    }


    //----------------------------------------------------------------------------------
    // 计算渐变的外接矩形边界点（新算法）
    private static async calculateGradientBounds(left: number, top: number, right: number, bottom: number, angle: number) {
        // 计算选区中心点和尺寸
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        const width = right - left;
        const height = bottom - top;
        

        let adjustedAngle = angle; // 默认值
    
        
        // 将角度转换为弧度
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

    //----------------------------------------------------------------------------------
    // 获取选区数据
    private static async getSelectionData() {
        try {

            // batchplay获取文档信息和选区信息（并行执行）
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
            
            if (!selectionResult?.[0]?.selection) {
                console.log('❌ 没有选区');
                return null;
            }
            
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
            
            console.log('🎯 选区边界:', { left, top, right, bottom, width, height });
            console.log('📏 文档尺寸（像素）:', docWidthPixels, 'x', docHeightPixels);
            
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
            console.log('✅ 成功获取选区边界内的像素数据，数据类型:', selectionData.constructor.name, '长度:', selectionData.length);
            
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
            console.error('❌ 获取选区数据失败:', error);
            return null;
        }
    }

    //----------------------------------------------------------------------------------
    // 获取快速蒙版像素数据
    private static async getQuickMaskPixels(bounds: any) {
        try {
            console.log('🎭 开始获取快速蒙版数据');
            
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
            originalTopLeft = await this.getPixelValue(0, 0);
            originalBottomRight = await this.getPixelValue(Math.round(bounds.docWidth) - 1, Math.round(bounds.docHeight) - 1);

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
            
 
                // 判断左上角和右下角是否需要填充
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
            
            // 撤销快速蒙版
            await this.clearQuickMask();
            
            // 如果是纯白快速蒙版（非selectedAreas模式下），需要执行全选操作
            if (!isSelectedAreas && maskStatus.isWhite) {
            await this.selectAll();
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
            
            // 检查pixels和imageData是否存在
            if (!pixels || !pixels.imageData) {
                console.error('❌ 无法获取选区数据，pixels或imageData为空');
                throw new Error('无法获取选区数据');
            }
            
            const quickMaskData = await pixels.imageData.getData();
            console.log('✅ 成功获取快速蒙版像素数据，数据类型:', quickMaskData.constructor.name, '长度:', quickMaskData.length);

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
            
            console.log('快速蒙版渐变填充非零像素数量:', nonZeroIndices.length);
            
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

    //----------------------------------------------------------------------------------
    // 获取指定坐标像素值的辅助方法
    private static async getPixelValue(x: number, y: number): Promise<number> {
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
        console.log(`坐标(${x}, ${y})的像素值：`, pixelValue);

        return pixelValue;
    }

    //----------------------------------------------------------------------------------
    // 分析快速蒙版直方图状态
    private static analyzeQuickMaskHistogram(histogram: number[], isSelectedAreas: boolean) {
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
    
    //----------------------------------------------------------------------------------
    // 撤销快速蒙版
    private static async clearQuickMask() {
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
    
    //----------------------------------------------------------------------------------
    // 执行全选操作
    private static async selectAll() {
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

    //----------------------------------------------------------------------------------
    // 获取图层蒙版像素数据
    private static async getLayerMaskPixels(bounds: any, layerId: number) {
        try {
            const { imaging } = require('photoshop');
            
            console.log('🎭 开始获取图层蒙版数据，图层ID:', layerId);
            
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
            
            // 检查pixels和imageData是否存在
            if (!pixels || !pixels.imageData) {
                console.error('❌ 无法获取图层蒙版数据，pixels或imageData为空');
                throw new Error('无法获取图层蒙版数据');
            }
            
            const fullDocMaskArray = await pixels.imageData.getData();
            console.log('🎯 完整文档蒙版数组长度:', fullDocMaskArray.length);
            
            // 从完整文档长度的蒙版数组中按照索引提取选区内的蒙版像素数据
            const selectionSize = bounds.selectionDocIndices.size;
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const maskPixels = new Uint8Array(selectionSize);
            
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                if (docIndex >= 0 && docIndex < fullDocMaskArray.length) {
                    maskPixels[i] = fullDocMaskArray[docIndex];
                } else {
                    maskPixels[i] = 0;
                }
            }
            
            // 计算统计信息
            let isEmpty = true;
            for (let i = 0; i < maskPixels.length; i++) {
                if (maskPixels[i] > 0) {
                    isEmpty = false;
                    break;
                }
            }
            
            const stats = { isEmpty };
            
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


    //----------------------------------------------------------------------------------
    // 生成渐变填充的灰度数据
    private static async getGradientFillGrayData(gradient: Gradient, bounds: any): Promise<Uint8Array> {
        try {
            console.log('🌈 获取渐变填充灰度数据');
            
            if (!gradient || !gradient.stops) {
                console.log('⚠️ 没有找到渐变数据，使用默认中等灰度');
                const pixelCount = bounds.selectionDocIndices?.size || (bounds.width * bounds.height);
                const grayData = new Uint8Array(pixelCount);
                grayData.fill(128);
                return grayData;
            }
            
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const grayData = new Uint8Array(selectionIndices.length);
            
            // 计算渐变的中心点和角度（基于选区边界）
            const centerX = bounds.width / 2;
            const centerY = bounds.height / 2;
            
            let startX, startY, endX, endY;
            
            if (gradient.type === 'radial') {
                // 径向渐变的起点和终点都在中心
                startX = centerX;
                startY = centerY;
                endX = centerX;
                endY = centerY;
            } else {
                // 线性渐变：计算起点和终点
                const gradientBounds = await this.calculateGradientBounds(
                    bounds.left, bounds.top, bounds.right, bounds.bottom, gradient.angle || 0
                );
                
                if (gradient.reverse) {
                    startX = gradientBounds.endX - bounds.left;
                    startY = gradientBounds.endY - bounds.top;
                    endX = gradientBounds.startX - bounds.left;
                    endY = gradientBounds.startY - bounds.top;
                } else {
                    startX = gradientBounds.startX - bounds.left;
                    startY = gradientBounds.startY - bounds.top;
                    endX = gradientBounds.endX - bounds.left;
                    endY = gradientBounds.endY - bounds.top;
                }
            }
            
            // 为选区内的每个像素计算渐变值
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
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
                
                // 根据位置插值渐变颜色并转换为灰度
                const colorWithOpacity = this.interpolateGradientColorWithOpacity(gradient.stops, position);
                
                // 转换为灰度值
                const grayValue = Math.round(
                    colorWithOpacity.red * 0.299 + 
                    colorWithOpacity.green * 0.587 + 
                    colorWithOpacity.blue * 0.114
                );
                
                grayData[i] = Math.min(255, Math.max(0, grayValue));
            }
            
            console.log('✅ 渐变灰度数据生成完成，数据长度:', grayData.length);
            return grayData;
            
        } catch (error) {
            console.error('❌ 获取渐变灰度数据失败:', error);
            const pixelCount = bounds.selectionDocIndices?.size || (bounds.width * bounds.height);
            const grayData = new Uint8Array(pixelCount);
            grayData.fill(128);
            return grayData;
        }
    }

    //----------------------------------------------------------------------------------
    // 生成渐变透明度数据
    private static async generateGradientAlphaData(gradient: Gradient, bounds: any): Promise<Uint8Array | null> {
        try {
            console.log('🌈 开始生成渐变透明度数据');
            
            if (!gradient || !gradient.stops) {
                console.log('⚠️ 没有渐变数据，返回完全不透明');
                return null;
            }
            
            if (!bounds.selectionDocIndices || bounds.selectionDocIndices.size === 0) {
                console.log('⚠️ 没有选区索引信息');
                return null;
            }
            
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            const alphaData = new Uint8Array(selectionIndices.length);
            
            // 计算渐变的中心点和角度（基于选区边界）
            const centerX = bounds.width / 2;
            const centerY = bounds.height / 2;
            
            let startX, startY, endX, endY;
            
            if (gradient.type === 'radial') {
                startX = centerX;
                startY = centerY;
                endX = centerX;
                endY = centerY;
            } else {
                const gradientBounds = await this.calculateGradientBounds(
                    bounds.left, bounds.top, bounds.right, bounds.bottom, gradient.angle || 0
                );
                
                if (gradient.reverse) {
                    startX = gradientBounds.endX - bounds.left;
                    startY = gradientBounds.endY - bounds.top;
                    endX = gradientBounds.startX - bounds.left;
                    endY = gradientBounds.startY - bounds.top;
                } else {
                    startX = gradientBounds.startX - bounds.left;
                    startY = gradientBounds.startY - bounds.top;
                    endX = gradientBounds.endX - bounds.left;
                    endY = gradientBounds.endY - bounds.top;
                }
            }
            
            // 为选区内的每个像素计算透明度值
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                const docX = docIndex % bounds.docWidth;
                const docY = Math.floor(docIndex / bounds.docWidth);
                const boundsX = docX - bounds.left;
                const boundsY = docY - bounds.top;
                
                let position;
                
                if (gradient.type === 'radial') {
                    const dx = boundsX - centerX;
                    const dy = boundsY - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
                    position = Math.min(1, distance / maxDistance);
                } else {
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

    //----------------------------------------------------------------------------------
    // 插值渐变颜色（包含透明度）
    private static interpolateGradientColorWithOpacity(stops: GradientStop[], position: number, forOpacity: boolean = false) {
        if (!stops || stops.length === 0) {
            return { red: 128, green: 128, blue: 128, opacity: 100 };
        }
        
        if (stops.length === 1) {
            const color = this.parseColor(stops[0].color);
            const opacity = this.parseOpacity(stops[0].color);
            return { ...color, opacity };
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
        
        const leftColor = this.parseColor(leftStop.color);
        const rightColor = this.parseColor(rightStop.color);
        const leftOpacity = this.parseOpacity(leftStop.color);
        const rightOpacity = this.parseOpacity(rightStop.color);
        
        // 计算插值比例，考虑中点位置
        let ratio = (position * 100 - leftStop.position) / (rightStop.position - leftStop.position);
        
        // 如果存在中点信息，应用中点插值（灰度/颜色用 midpoint，不透明度用 opacityMidpoint）
        const midpoint = forOpacity
            ? (leftStop.opacityMidpoint ?? rightStop.opacityMidpoint ?? 50)
            : (leftStop.midpoint ?? rightStop.midpoint ?? 50);
        if (midpoint !== 50) {
            const midpointRatio = midpoint / 100;
            if (ratio <= midpointRatio) {
                ratio = (ratio / midpointRatio) * 0.5;
            } else {
                ratio = 0.5 + ((ratio - midpointRatio) / (1 - midpointRatio)) * 0.5;
            }
        }
        
        return {
             red: Math.round(leftColor.red * (1 - ratio) + rightColor.red * ratio),
             green: Math.round(leftColor.green * (1 - ratio) + rightColor.green * ratio),
             blue: Math.round(leftColor.blue * (1 - ratio) + rightColor.blue * ratio),
             opacity: Math.round(leftOpacity * (1 - ratio) + rightOpacity * ratio)
         };
     }


    //----------------------------------------------------------------------------------
    // 获取当前图层ID
    private static async getCurrentLayerId(): Promise<number | null> {
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

    //----------------------------------------------------------------------------------
    // 计算图层蒙版填充值（支持羽化和透明度修复版）
    private static async calculateLayerMaskFillValues(
        selectedMaskData: Uint8Array,
        gradientGrayData: Uint8Array,
        gradientAlphaData: Uint8Array | null,
        opacity: number,
        bounds: any,
        maskData: Uint8Array,
        isEmpty: boolean,
        blendMode: string = 'normal'
    ): Promise<Uint8Array> {
        try {
            console.log('🎨 开始计算图层蒙版填充值（支持羽化和透明度修复版）');
            
            const length = selectedMaskData.length;
            const finalData = new Uint8Array(length);
            const opacityRatio = opacity * 0.01; // 避免重复除法
            const blendFunction = BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
            const hasAlpha = gradientAlphaData !== null;
            
            // 检查是否有羽化系数
            const hasFeathering = bounds?.selectionCoefficients?.length > 0;
            const selectionCoefficients = bounds?.selectionCoefficients;
            
            if (hasFeathering) {
                console.log('🌟 检测到选区羽化系数，将应用羽化混合效果');
            }
            
            // 批量处理，减少函数调用开销
            for (let i = 0; i < length; i++) {
                const maskValue = selectedMaskData[i];
                const gradientValue = gradientGrayData[i] || 128;
                const alphaValue = hasAlpha ? gradientAlphaData[i] : 255;
                
                // 计算最终的透明度（渐变透明度 × 整体不透明度）
                const finalAlpha = (alphaValue * 0.00392156862745098) * opacityRatio; // 1/255 = 0.00392156862745098
                
                // 如果最终透明度为0，直接保持原始蒙版值，不进行任何混合
                if (finalAlpha === 0) {
                    finalData[i] = maskValue;
                    continue;
                }
                
                // 计算混合值
                const blendedValue = blendFunction(maskValue, gradientValue);
                
                // 应用透明度混合
                const invAlphaRatio = 1 - finalAlpha;
                let blendedResult = maskValue * invAlphaRatio + blendedValue * finalAlpha;
                
                // 应用羽化系数（如果存在）
                if (hasFeathering && selectionCoefficients && selectionCoefficients[i] !== undefined) {
                    const featherCoeff = selectionCoefficients[i];
                    // 羽化混合：原始值 * (1 - 羽化系数) + 混合结果 * 羽化系数
                    const invFeatherCoeff = 1 - featherCoeff;
                    blendedResult = maskValue * invFeatherCoeff + blendedResult * featherCoeff;
                }
                
                // 快速边界检查和取整
                finalData[i] = blendedResult > 255 ? 255 : (blendedResult < 0 ? 0 : Math.round(blendedResult));
            }
            
            console.log('✅ 图层蒙版填充值计算完成，最终数据长度:', length);
            if (hasFeathering) {
                console.log('🌟 已应用羽化效果到图层蒙版填充');
            }
            return finalData;
            
        } catch (error) {
            console.error('❌ 计算图层蒙版填充值失败:', error);
            return selectedMaskData;
        }
    }

    //----------------------------------------------------------------------------------
    // 混合渐变数据与蒙版数据（支持羽化和角落像素还原）- 性能优化版
    private static async calculateFinalGrayValues(
        maskData: Uint8Array,
        gradientGrayData: Uint8Array,
        gradientAlphaData: Uint8Array | null,
        isSelectedAreas: boolean = true,
        opacity: number = 100,
        isEmpty: boolean = false,
        bounds?: any,
        blendMode: string = 'normal',
        topLeftIsEmpty: boolean = false,
        bottomRightIsEmpty: boolean = false,
        originalTopLeft: number = 0,
        originalBottomRight: number = 0
    ): Promise<Uint8Array> {
        try {
            console.log('🎨 开始混合渐变数据与蒙版数据（优化版）');
            
            const maskLength = maskData.length;
            const gradientLength = gradientGrayData.length;
            const newMaskValue = new Uint8Array(maskLength);
            
            // 优化：使用更快的数组初始化
            if (isEmpty) {
                // newMaskValue 已经默认为0，无需fill
            } else {
                newMaskValue.set(maskData);
            }
            
            // 预计算常量，避免重复计算
            const opacityRatio = opacity * 0.01;
            const blendFunction = BLEND_MODE_CALCULATIONS[blendMode] || BLEND_MODE_CALCULATIONS['normal'];
            const hasAlpha = gradientAlphaData !== null;
            const hasSelection = bounds?.selectionDocIndices?.size > 0;
            
            // 优化：预转换selectionDocIndices为数组，避免重复转换
            let selectionIndicesArray: number[] | null = null;
            if (hasSelection) {
                selectionIndicesArray = Array.from(bounds.selectionDocIndices);
            }
            
            // 计算选区内的渐变混合结果
            const finalData = new Uint8Array(gradientLength);
            
            // 优化：批量处理渐变计算
            for (let i = 0; i < gradientLength; i++) {
                let maskValue: number;
                
                if (isEmpty) {
                    maskValue = 0;
                } else if (selectionIndicesArray) {
                    maskValue = maskData[selectionIndicesArray[i]] || 0;
                } else {
                    maskValue = maskData[i] || 0;
                }
                
                const gradientValue = gradientGrayData[i] || 128;
                const alphaValue = hasAlpha ? gradientAlphaData[i] : 255;
                
                // 如果渐变完全透明，直接使用原始值
                if (alphaValue === 0) {
                    finalData[i] = maskValue;
                    continue;
                }
                
                // 计算混合值
                const blendedValue = blendFunction(maskValue, gradientValue);
                
                // 优化透明度计算
                const alphaRatio = (alphaValue * 0.00392156862745098) * opacityRatio;
                const invAlphaRatio = 1 - alphaRatio;
                let finalValue = maskValue * invAlphaRatio + blendedValue * alphaRatio;
                
                // 快速边界检查
                finalData[i] = finalValue > 255 ? 255 : (finalValue < 0 ? 0 : Math.round(finalValue));
            }
            
            // 优化：将计算结果映射回完整文档
            if (hasSelection && selectionIndicesArray) {
                console.log('🎯 使用selectionDocIndices映射选区内的最终计算结果');
                
                const hasFeathering = bounds.selectionCoefficients?.length > 0;
                if (hasFeathering) {
                    console.log('🌟 检测到选区羽化系数，将应用羽化混合效果');
                }
                
                let mappedCount = 0;
                let featheredCount = 0;
                const selectionCoefficients = bounds.selectionCoefficients;
                
                // 优化：减少边界检查，预先计算最小长度
                const maxIndex = Math.min(selectionIndicesArray.length, finalData.length);
                
                for (let i = 0; i < maxIndex; i++) {
                    const docIndex = selectionIndicesArray[i];
                    if (docIndex >= maskLength) continue;
                    
                    if (hasFeathering && selectionCoefficients?.[i] !== undefined) {
                        const selectionCoefficient = selectionCoefficients[i];
                        const originalValue = isEmpty ? 0 : maskData[docIndex];
                        const newValue = finalData[i];
                        
                        // 优化羽化混合计算
                        const invCoeff = 1 - selectionCoefficient;
                        const blendedValue = originalValue * invCoeff + newValue * selectionCoefficient;
                        newMaskValue[docIndex] = blendedValue > 255 ? 255 : (blendedValue < 0 ? 0 : Math.round(blendedValue));
                        
                        featheredCount++;
                    } else {
                        newMaskValue[docIndex] = finalData[i];
                    }
                    
                    mappedCount++;
                }
                
                console.log(`🎯 selectionDocIndices映射完成，映射了 ${mappedCount} 个像素`);
                if (featheredCount > 0) {
                    console.log(`🌟 应用羽化效果的像素数量: ${featheredCount}`);
                }
            } else {
                console.log('✅ 混合计算完成，最终数据长度:', finalData.length);
                return finalData;
            }
            
            // 优化：角落像素还原（减少重复的边界检查）
            if (topLeftIsEmpty && maskData[0] === 0) {
                console.log('⚪ 左上角像素不在选区内，还原为0');
                newMaskValue[0] = 0;
            }
            
            if (bottomRightIsEmpty && maskData[maskLength - 1] === 0) {
                console.log('⚪ 右下角像素不在选区内，还原为0');
                newMaskValue[maskLength - 1] = 0;
            }
            
            console.log('✅ 混合完成，最终数据长度:', maskLength);
            return newMaskValue;
            
        } catch (error) {
            console.error('❌ 混合数据失败:', error);
            return maskData;
        }
    }
    
    //----------------------------------------------------------------------------------
    // 更新快速蒙版通道
    private static async updateQuickMaskChannel(
        finalGrayData: Uint8Array,
        bounds: any,
        state?: any
    ): Promise<void> {
        try {
            console.log('🔄 将选区重新改回快速蒙版');
            
            const { imaging } = require('photoshop');
            
            let documentColorProfile = "Dot Gain 15%";
            
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
            
            const fullImageData = await imaging.createImageDataFromBuffer(finalGrayData, fullOptions);
            
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
            
            // 检查是否需要恢复选区
            if (state && !state.deselectAfterFill && bounds.selectionValues) {
                try {
                    console.log('🔄 恢复上一个选区');
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullDocArray = new Uint8Array(bounds.docWidth * bounds.docHeight);
                    const selectionIndices = Array.from(bounds.selectionDocIndices);
                    
                    for (let i = 0; i < selectionIndices.length; i++) {
                        const docIndex = selectionIndices[i];
                        if (docIndex >= 0 && docIndex < fullDocArray.length) {
                            fullDocArray[docIndex] = bounds.selectionValues[i];
                        }
                    }
                    
                    // 使用imagingAPI恢复选区
                    const selectionOptions = {
                        width: bounds.docWidth,
                        height: bounds.docHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: "Dot Gain 15%",
                        colorSpace: "Grayscale"
                    };
                    
                    const selectionImageData = await imaging.createImageDataFromBuffer(fullDocArray, selectionOptions);
                    
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: selectionImageData
                    });
                    
                    selectionImageData.dispose();
                    
                    console.log('✅ 选区恢复完成');
                } catch (error) {
                    console.error('❌ 恢复选区失败:', error);
                }
            }
            
        } catch (error) {
            console.error('❌ 更新快速蒙版通道失败:', error);
            throw error;
        }
    }

    //----------------------------------------------------------------------------------
    // 更新图层蒙版
    private static async updateLayerMask(
        finalGrayData: Uint8Array,
        bounds: any,
        layerId: number,
        originalMaskData: Uint8Array,
        state?: any
    ): Promise<void> {
        try {
            console.log('🔄 更新图层蒙版');
            
            const { imaging } = require('photoshop');
            
            let documentColorProfile = "Dot Gain 15%";
            
            // 创建完整文档大小的数组，先复制原始蒙版数据
            const fullDocArray = new Uint8Array(originalMaskData);
            
            // 将选区内的最终数据写入完整文档数组
            const selectionIndices = Array.from(bounds.selectionDocIndices);
            for (let i = 0; i < selectionIndices.length; i++) {
                const docIndex = selectionIndices[i];
                if (docIndex >= 0 && docIndex < fullDocArray.length) {
                    fullDocArray[docIndex] = finalGrayData[i];
                }
            }
            
            const finalDocWidth = Math.round(bounds.docWidth);
            const finalDocHeight = Math.round(bounds.docHeight);
            const expectedSize = finalDocWidth * finalDocHeight;
            
            console.log('📏 图层蒙版数据验证:');
            console.log('  - 文档宽度:', finalDocWidth);
            console.log('  - 文档高度:', finalDocHeight);
            console.log('  - 期望数据大小:', expectedSize);
            console.log('  - 实际数据大小:', fullDocArray.length);
            
            // 验证数据大小
            let grayData = fullDocArray;
            if (fullDocArray.length !== expectedSize) {
                console.error('❌ 图层蒙版数据大小不匹配');
                console.error('期望大小:', expectedSize, '实际大小:', fullDocArray.length);
                
                // 创建正确大小的数据缓冲区
                const correctedData = new Uint8Array(expectedSize);
                
                // 如果数据太小，用0填充；如果太大，截断
                const copySize = Math.min(fullDocArray.length, expectedSize);
                correctedData.set(fullDocArray.subarray(0, copySize));
                
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
            
            console.log('✅ 图层蒙版更新完成');
            
            // 检查是否需要恢复选区
            if (state && !state.deselectAfterFill && bounds.selectionValues) {
                try {
                    console.log('🔄 恢复上一个选区');
                    
                    // 将压缩的selectionValues数组补全为整个文档大小的数组
                    const fullDocArray = new Uint8Array(bounds.docWidth * bounds.docHeight);
                    const selectionIndices = Array.from(bounds.selectionDocIndices);
                    
                    for (let i = 0; i < selectionIndices.length; i++) {
                        const docIndex = selectionIndices[i];
                        if (docIndex >= 0 && docIndex < fullDocArray.length) {
                            fullDocArray[docIndex] = bounds.selectionValues[i];
                        }
                    }
                    
                    // 使用imagingAPI恢复选区
                    const selectionOptions = {
                        width: bounds.docWidth,
                        height: bounds.docHeight,
                        components: 1,
                        chunky: true,
                        colorProfile: "Dot Gain 15%",
                        colorSpace: "Grayscale"
                    };
                    
                    const selectionImageData = await imaging.createImageDataFromBuffer(fullDocArray, selectionOptions);
                    
                    await imaging.putSelection({
                        documentID: app.activeDocument.id,
                        imageData: selectionImageData
                    });
                    
                    selectionImageData.dispose();
                    
                    console.log('✅ 选区恢复完成');
                } catch (error) {
                    console.error('❌ 恢复选区失败:', error);
                }
            }
            
        } catch (error) {
            console.error('❌ 更新图层蒙版失败:', error);
            throw error;
        }
    }

}