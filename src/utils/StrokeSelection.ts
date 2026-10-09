import { app, action, imaging } from 'photoshop';
import { runAsModal } from './psAccess';
import { BLEND_MODES } from '../constants/blendModes';
import { AppState } from '../types/state';
import {
    planStrokeBlend,
    invertRgb,
    ClearTargetKind,
    BackgroundClearAlgorithm,
    BinaryClearAlgorithm,
} from './ClearAlgorithms';

// 计算RGB颜色的灰度值
function rgbToGray(red: number, green: number, blue: number): number {
    // 使用标准的灰度转换公式：0.299*R + 0.587*G + 0.114*B
    return Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
}

// runAsModal ≡ core.executeAsModal，但会维护「本插件自己的模态计数」（见 psAccess）。
const executeAsModal = runAsModal;
const { batchPlay } = action;

/**
 * ⚠️ 本文件所有 batchPlay 的 options **必须**带 `dialogOptions: 'dontDisplayDialogs'`
 * （2026-10-08 用户实测修「清除模式下自动弹出 PS 原生描边对话框」）。
 *
 * 根因：原先只在**描述符内部**写了 `_options: { dialogOptions: "dontDisplay" }`，
 * 而 batchPlay 的**第二参数**（options）没有声明。PS 的 `stroke` 命令在
 * 「混合模式 = 清除(clearEnum)」这类参数下会**忽略描述符内的 _options**，
 * 转而弹出原生「描边」对话框（就是用户截图那个带确定/取消的窗口）。
 *描述符内保留 `_options.dialogOptions` 无害，两层都写最稳。
 *
 * ⚠️ 顺带：本文件有 16 处 batchPlay，统一带上options 层的 dialogOptions
 * 可杜绝同类问题（任何一条命令弹原生框都会打断交互）。
 */

interface LayerInfo {
    hasPixels: boolean;
    isInQuickMask: boolean;
    isInLayerMask: boolean;
    // 单通道（红/绿/蓝 / 自建 Alpha）编辑态：走专用描边分支，见 strokeSelection 末尾两条分发。
    isInSingleColorChannel?: boolean;
    /**
     * 目标图层是不是**背景图层**（`activeLayers[0].isBackgroundLayer`）。
     * 背景图层不支持透明度 ⇒ `clearEnum`（清除）在该图层上**不可用** ⇒ 清除描边必须换分支。
     */
    isBackground?: boolean;
    /**
     * 目标图层是否开启了「锁定透明像素」（preserve transparency）。
     * 它同样会让 `clearEnum` 不可用，与背景图层是**同一个根因**，故共用一条分支。
     */
    hasTransparencyLocked?: boolean;
}

/**
 * 读取当前活动通道名 —— 供单通道描边「描完回到原通道」使用。
 * PS 的中文版返回「红/绿/蓝」，英文版返回「Red/Grain/Blue」，自建 Alpha 返回用户起的名字。
 */
async function readActiveChannelName(): Promise<string | null> {
    try {
        const r = await batchPlay(
            [{
                _obj: "get",
                _target: [{ _ref: "channel", _enum: "ordinal", _value: "targetEnum" }],
                _options: { dialogOptions: "dontDisplay" }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        return (r && r[0] && r[0].channelName) || null;
    } catch (e) {
        console.warn('⚠️ 读取当前通道名失败:', e);
        return null;
    }
}

/**
 * 把活动通道还原为指定通道（单通道描边的收尾步骤）。
 *
 * 根因背景：单通道「填充 + 描边」原先落到「像素图层普通描边」分支，那支会 `make layer`
 * ⇒ 新建图层把活动通道切回 **RGB 复合通道**，用户看到的就是「填充后自动跳回 RGB 通道」。
 * 专用分支不建图层，这里再兜底把通道选择还原回去。
 *
 * RGB 三通道走 `_enum:'channel'` 的枚举值 red/grain/blue（PS 把绿通道拼作 `grain`，历史拼写）；
 * 自建 Alpha 等其它通道按 `_name` 选择。⚠️ 先按小写查表，中英文（红/绿/蓝 与 Red/Grain/Blue）都收。
 */
async function reselectChannel(channelName: string | null) {
    if (!channelName) return;
    const key = channelName.toLowerCase();
    const rgbEnum: { [k: string]: string } = {
        '红': 'red', 'red': 'red', 'r': 'red',
        '绿': 'grain', 'grain': 'grain', 'g': 'grain',
        '蓝': 'blue', 'blue': 'blue', 'b': 'blue'
    };
    const enumValue = rgbEnum[key] || rgbEnum[channelName];
    const target: any = enumValue
        ? { _ref: "channel", _enum: "channel", _value: enumValue }
        : { _ref: "channel", _name: channelName };
    try {
        await batchPlay(
            [{ _obj: "select", _target: [target], _isCommand: false }],
            { dialogOptions: 'dontDisplayDialogs' }
        );
    } catch (e) {
        console.warn('⚠️ 恢复通道选择失败:', e);
    }
}

export async function strokeSelection(state: AppState, layerInfo?: LayerInfo) {
    if (!state.strokeEnabled) return;
    
    const strokeParams = {
        width: state.strokeWidth || 2,
        position: state.strokePosition || "center",
        opacity: state.strokeOpacity || 100,
        blendMode: state.strokeBlendMode || "normal",
        color: {
            red: state.strokeColor.red || 0,
            green: state.strokeColor.green || 0,
            blue: state.strokeColor.blue || 0
        }
    };

    /**
     * 清除模式下把「用户选的算法」翻译成「PS 混合模式 + 描边色处理」。
     *
     * 为什么需要这一层：填充（纯色/图案/渐变）由插件逐像素算，公式可以随便定；
     * 而描边的**形状**（宽度/内中外/羽化）只有 PS 原生 `stroke` 命令算得准，
     * 插件只能选它的混合模式 ⇒ 必须证明「某个混合模式 ≡ 某个算法公式」。
     * 证明见 ClearAlgorithms.planStrokeBlend 的注释：
     *   · 减法 X − F×t            ⟺ blendSubtraction
     *   · 乘法 X × (1 − F/255×t)  ⟺ multiply + 描边色反相（因 PS 的 multiply 是 S 越暗压得越狠）
     *   · 趋白 C + (255−C)×F/255×t ⟺ screen
     * 三者在不透明度为 100% 时与填充侧严格等价，任意不透明度下也一致（PS 的混合模式
     * 本身即「结果 = lerp(底色, 混合结果, opacity)」）。
     */
    const withClearPlan = (
        kind: ClearTargetKind,
        algo: BackgroundClearAlgorithm | BinaryClearAlgorithm
    ) => {
        const plan = planStrokeBlend(kind, algo);
        return {
            ...strokeParams,
            blendMode: plan.blendMode,
            color: plan.invertColor ? invertRgb(strokeParams.color) : strokeParams.color,
        };
    };

    // 如果在快速蒙版状态，使用简化的直接描边
    if (layerInfo?.isInQuickMask) {
        // 如果同时开启了清除模式，使用特殊的颜色计算描边
        if (state.clearMode) {
            await strokeSelectionWithColorCalculation(
                withClearPlan('channel', state.clearChannelAlgorithm)
            );
        } else {
            await strokeSelectionDirect(strokeParams);
        }
        return;
    }

    // 如果在图层蒙版状态，使用图层蒙版描边
    if (layerInfo?.isInLayerMask) {
        // 如果同时开启了清除模式，使用图层蒙版清除模式描边
        if (state.clearMode) {
            await strokeSelectionInLayerMaskWithClearMode(
                withClearPlan('channel', state.clearChannelAlgorithm)
            );
        } else {
            await strokeSelectionInLayerMask(strokeParams);
        }
        return;
    }

    // 单通道（红/绿/蓝 或 自建 Alpha）编辑态：必须走专用分支。
    // ⚠️ 不能落到下面的「像素图层」分支 —— 那两支都会 `make layer`（普通描边）或
    //    用 `clearEnum` 清除混合模式（清除描边）：
    //      · 新建图层 ⇒ 活动通道被切回 RGB 复合通道（用户实测「填充后跳回 RGB」）；
    //      · clearEnum 在无透明度的通道上下文里不被 PS 接受 ⇒ 弹原生描边对话框，
    //        并按面板色直接填充，而不是「减去」（用户实测第二类失效）。
    //    专用分支 = 直接在当前通道描边 + 末尾还原通道，语义对齐快速蒙版的描边。
    if (layerInfo?.isInSingleColorChannel) {
        if (state.clearMode) {
            await strokeSelectionInSingleChannelWithClearMode(
                withClearPlan('channel', state.clearChannelAlgorithm)
            );
        } else {
            await strokeSelectionInSingleChannel(strokeParams);
        }
        return;
    }

    // 如果在像素图层且开启了清除模式，使用清除模式描边
    if (state.clearMode) {
        // ⚠️ 目标不透明（**背景图层** / 开启「锁定透明像素」的图层）时 `clearEnum` 不可用：
        //    Adobe 官方文档明确写「The Clear blending mode will be unavailable for a
        //    background layer, or if preserve transparency is enabled on the target layer」。
        //    PS 遇到不可用的 clearEnum **不报错**，而是弹出原生「描边」对话框、
        //    随后按普通填充把描边画成描边色 —— 就是用户实测的背景图层 12 组合里
        //    那 3 种「填充 + 描边 + 清除」失效（2026-10-08）。
        //    这类目标只能改颜色（无 alpha 可控），因此使用第一类「背景图层」的三个算法。
        if (layerInfo?.isBackground || layerInfo?.hasTransparencyLocked) {
            await strokeSelectionOnOpaqueLayer(
                withClearPlan('background', state.clearBackgroundAlgorithm)
            );
            return;
        }
        // 普通像素图层：清除 = 降低不透明度（第三类）。
        // ⚠️ 受 PS 原生限制，这里只能用 clearEnum —— 它的语义是 A' = A×(1−opacity)，
        //    对应「乘法」式降低；「减法」（A−k）需要按像素改写 alpha，原生 stroke 做不到。
        //    在不透明区域（A = 255）两者数值完全等价，差异只出现在半透明边缘。
        await strokeSelectionWithClearMode(strokeParams);
        return;
    }

    // 像素图层的普通描边
    await strokeSelectionNormal(strokeParams);
}

// 1.像素图层的普通描边√
async function strokeSelectionNormal(strokeParams: any) {
    try {
        console.log('🔄 开始非快速蒙版普通描边，描边参数:', strokeParams);
        
        // 1. 新建准备描边的空白图层
        await batchPlay(
            [{
                _obj: "make",
                _target: [
                    {
                        _ref: "layer"
                    }
                ],
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        console.log("✅ 新建图层成功");

        // 2. 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });

        // 3. 描边
        await batchPlay(
            [{
                _obj: "stroke",
                width: {
                    _unit: "pixelsUnit",
                    _value: strokeParams.width
                },
                location: {
                    _enum: "strokeLength",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: 100
                },
                mode: {
                    _enum: "blendMode",
                    _value: "normal"
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );

        // 4. 根据用户描边面板的不透明度和混合模式修改描边图层不透明度和混合模式
        await batchPlay(
            [{
                _obj: "set",
                _target: [
                    {
                        _ref: "layer",
                        _enum: "ordinal",
                        _value: "targetEnum"
                    }
                ],
                to: {
                    _obj: "layer",
                    opacity: {
                        _unit: "percentUnit",
                        _value: strokeParams.opacity
                    },
                    mode: {
                        _enum: "blendMode",
                        _value: BLEND_MODES[strokeParams.blendMode] || "normal"
                    }
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        
        // 5. 向下合并图层
        await batchPlay(
            [{
                _obj: "mergeLayersNew",
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );

        // 6. 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: savedForegroundColor.hue,
                        saturation: savedForegroundColor.saturation,
                        brightness: savedForegroundColor.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
        }

        console.log("✅ 普通描边完成");
    } catch (error) {
        console.error("❌ 普通描边失败:", error);
        throw error;
    }
}

// 2.普通像素图层的清除模式描边（第三类 · 降低不透明度）
//   语义 = 按描边色的灰度降低选区边缘区域的不透明度，等价于「乘法」式降低：
//     A' = A × (1 − opacity)，其中 opacity = 描边色灰度/255 × 面板不透明度。
//   ⚠️ 受 PS 原生限制这是本类唯一可用的实现：`clearEnum`（清除）在带透明度的普通
//      图层上正好就是「按比例降低 alpha」。用户的「减法」选项（A − k）需要逐像素
//      改写 alpha，原生 stroke 表达不了；在不透明区域（A = 255）两者数值等价。
async function strokeSelectionWithClearMode(strokeParams: any) {
    try {
        console.log('🔄 开始非快速蒙版清除模式描边，描边参数:', strokeParams);
        
        // 1. 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });
        console.log('✅ 已保存前景色');

        // 计算描边色的灰度 —— 清除强度以**描边色**为准。
        // ⚠️ 重构前这里取的是**前景色**的灰度：改描边色不影响删除强度，改前景色反而会，
        //    与「输入端（描边色）的灰度决定删除量」的定义相反。现已修正。
        const colorGrayValue = rgbToGray(strokeParams.color.red, strokeParams.color.green, strokeParams.color.blue);

        // 清除模式描边的不透明度 = (描边色灰度 / 255) × 面板不透明度
        // = clearEnum 的「乘法」式降低：A' = A × (1 − opacity)
        const clearModeOpacity = (colorGrayValue / 255) * strokeParams.opacity;
        console.log('🔧 清除模式不透明度:', clearModeOpacity);

        // 2. 以清除模式描边
        await batchPlay(
            [{
                _obj: "stroke",
                width: {
                    _unit: "pixelsUnit",
                    _value: strokeParams.width
                },
                location: {
                    _enum: "strokeLength",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: clearModeOpacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: "clearEnum"
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        console.log('✅ 清除模式描边完成');

        // 3. 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: savedForegroundColor.hue,
                        saturation: savedForegroundColor.saturation,
                        brightness: savedForegroundColor.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
            console.log('✅ 已恢复前景色');
        }

        console.log('✅ 非快速蒙版清除模式描边完成');
    } catch (error) {
        console.error('❌ 非快速蒙版清除模式描边失败:', error);
        throw error;
    }
}

// 3.快速蒙版状态下的普通描边√
async function strokeSelectionDirect(strokeParams: any) {
    try {
        // 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });

        const strokeDirect = {
            _obj: "stroke",
            width: strokeParams.width,
            location: {
                _enum: "strokeLength",
                _value: strokeParams.position
            },
            opacity: {
                _unit: "percentUnit",
                _value: strokeParams.opacity
            },
            mode: {
                _enum: "blendMode",
                _value: BLEND_MODES[strokeParams.blendMode] || "normal"
            },
            color: {
                _obj: "RGBColor",
                red: strokeParams.color.red,
                green: strokeParams.color.green,
                blue: strokeParams.color.blue
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        await batchPlay([strokeDirect], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });

        // 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: savedForegroundColor.hue,
                        saturation: savedForegroundColor.saturation,
                        brightness: savedForegroundColor.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
        }

    } catch (error) {
        console.error("❌ 快速蒙版描边失败:", error);
        throw error;
    }
}

// 4.快速蒙版状态且清除模式下的特殊描边
//   ⚠️ 重构前本分支的混合模式由「快速蒙版 colorIndicates」决定：
//      selectedAreas → linearDodge（加亮）、其余 → blendSubtraction（减暗）。
//      而**同一目标的填充路径**（ClearHandler.clearInQuickMask）从头到尾按「减少蒙版值」
//      计算，根本不看 colorIndicates ⇒ 同一个「快速蒙版 + 清除」，填充与描边方向相反。
//      现在两条路径统一：方向恒为「减少蒙版覆盖」，算法由用户选的减法/乘法决定。
//      （同时省掉一次 `get channel 快速蒙版` 的同步 IPC。）
async function strokeSelectionWithColorCalculation(strokeParams: any) {
    try {
        console.log('🔄 开始清除模式快速蒙版描边，描边参数:', strokeParams);

        // 记录前景色（stroke 描述符自带 color，这里只为保持与其它分支一致的手感）
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });

        await batchPlay(
            [{
                _obj: "stroke",
                width: strokeParams.width,
                location: {
                    _enum: "strokeLength",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: strokeParams.opacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: strokeParams.blendMode
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        console.log('✅ 描边执行完成');

        // 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: savedForegroundColor.hue,
                        saturation: savedForegroundColor.saturation,
                        brightness: savedForegroundColor.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
            console.log('✅ 已恢复前景色');
        }

    } catch (error) {
        console.error("❌ 清除模式快速蒙版描边失败:", error);
        throw error;
    }
}

// 5.图层蒙版状态下的普通描边
async function strokeSelectionInLayerMask(strokeParams: any) {
    try {
        console.log('🔄 开始图层蒙版普通描边，描边参数:', strokeParams);
        
        // 1. 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });
        console.log('✅ 已保存前景色');

        // 2. 根据获取的描边参数与颜色，描边
        await batchPlay(
            [{
                _obj: "stroke",
                width: {
                    _unit: "pixelsUnit",
                    _value: strokeParams.width
                },
                location: {
                    _enum: "strokeLength",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: strokeParams.opacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: BLEND_MODES[strokeParams.blendMode] || "normal"
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        console.log('✅ 图层蒙版描边执行完成');

        // 3. 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: savedForegroundColor.hue,
                        saturation: savedForegroundColor.saturation,
                        brightness: savedForegroundColor.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
            console.log('✅ 已恢复前景色');
        }

        console.log('✅ 图层蒙版普通描边完成');
    } catch (error) {
        console.error('❌ 图层蒙版普通描边失败:', error);
        throw error;
    }
}

// 6.图层蒙版状态下的清除模式特殊描边
//   混合模式来自用户选择的算法（减法 → blendSubtraction，乘法 → multiply + 反相描边色）；
//   ⚠️ 不用 clearEnum —— 通道上下文里 PS 不接受该混合模式（会弹原生框并按面板色直接填充）。
async function strokeSelectionInLayerMaskWithClearMode(strokeParams: any) {
    try {
        console.log('🔄 开始图层蒙版清除模式描边，描边参数:', strokeParams);
        
        // 1. 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });
        console.log('✅ 已保存前景色');

        // 2. 根据获取的描边参数与颜色，描边，混合模式固定为减去
        await batchPlay(
            [{
                _obj: "stroke",
                width: {
                    _unit: "pixelsUnit",
                    _value: strokeParams.width
                },
                location: {
                    _enum: "strokeLength",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: strokeParams.opacity
                },
                mode: {
                    _enum: "blendMode",
                    // 由用户选的算法决定：减法 → 减去；乘法 → 正片叠底（描边色已在入口反相）
                    _value: strokeParams.blendMode
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        console.log('✅ 图层蒙版清除模式描边执行完成');

        // 3. 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: savedForegroundColor.hue,
                        saturation: savedForegroundColor.saturation,
                        brightness: savedForegroundColor.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
            console.log('✅ 已恢复前景色');
        }

        console.log('✅ 图层蒙版清除模式描边完成');
    } catch (error) {
        console.error('❌ 图层蒙版清除模式描边失败:', error);
        throw error;
    }
}

// 7.单通道（红/绿/蓝 / 自建 Alpha）的普通描边
//   ⚠️ 与「像素图层普通描边」的两条关键差别：
//     · **不新建图层、也不向下合并** —— 新建图层会把活动通道切回 RGB 复合通道
//       （用户实测：单通道填充 + 描边后自动跳回 RGB）；单通道填充本就写回当前图层/通道，
//       也不需要另起图层；
//     · 末尾把通道选择还原回描边前的通道。
//   width 沿用快速蒙版两支的**裸数字**写法（同为「直接编辑通道」的上下文，对齐 Alchemist
//   监听到的 PS 自身描述符形状）；location 枚举为全局统一的 `strokeLength`。
async function strokeSelectionInSingleChannel(strokeParams: any) {
    try {
        console.log('🔄 开始单通道普通描边，描边参数:', strokeParams);

        // 1. 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });

        // 2. 记下当前通道名（描边后要回到同一通道）
        const channelName = await readActiveChannelName();

        // 3. 直接在当前通道描边（不新建图层）
        await batchPlay(
            [{
                _obj: "stroke",
                width: strokeParams.width,
                location: {
                    _enum: "strokeLength",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: strokeParams.opacity
                },
                mode: {
                    _enum: "blendMode",
                    _value: BLEND_MODES[strokeParams.blendMode] || "normal"
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        console.log('✅ 单通道描边执行完成');

        // 4. 回到描边前的通道
        await reselectChannel(channelName);

        // 5. 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: savedForegroundColor.hue,
                        saturation: savedForegroundColor.saturation,
                        brightness: savedForegroundColor.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
        }

        console.log('✅ 单通道普通描边完成');
    } catch (error) {
        console.error('❌ 单通道普通描边失败:', error);
        throw error;
    }
}

// 8.单通道（红/绿/蓝 / 自建 Alpha）的清除模式描边
//   ⚠️ 语义 = 「从当前通道里**减去**描边色」，与快速蒙版「被蒙版区域 + 描边清除」一致：
//      混合模式固定 `blendSubtraction`（减去），不用 `clearEnum`。
//      根因：`clearEnum`（清除）要求图层带透明度才成立，单通道上下文里 PS 不接受它 ⇒
//      会弹原生描边对话框，并按面板色**直接填充**而不是减去（用户实测缺陷）。
//   同样不新建图层，并在末尾还原通道；width 同样是裸数字（见分支 7 说明）。
async function strokeSelectionInSingleChannelWithClearMode(strokeParams: any) {
    try {
        console.log('🔄 开始单通道清除模式描边，描边参数:', strokeParams);

        // 1. 记录前景色
        let savedForegroundColor;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            savedForegroundColor = {
                hue: {
                    _unit: "angleUnit",
                    _value: foregroundColor.hsb.hue
                },
                saturation: foregroundColor.hsb.saturation,
                brightness: foregroundColor.hsb.brightness
            };
        });

        // 2. 记下当前通道名（描边后要回到同一通道）
        const channelName = await readActiveChannelName();

        // 3. 以「减去」混合模式在当前通道描边（不新建图层）
        await batchPlay(
            [{
                _obj: "stroke",
                width: strokeParams.width,
                location: {
                    _enum: "strokeLength",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: strokeParams.opacity
                },
                mode: {
                    _enum: "blendMode",
                    // 同上：由算法决定（乘法时描边色已反相）
                    _value: strokeParams.blendMode
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
        console.log('✅ 单通道清除模式描边执行完成');

        // 4. 回到描边前的通道
        await reselectChannel(channelName);

        // 5. 恢复前景色
        if (savedForegroundColor) {
            await batchPlay(
                [{
                    _obj: "set",
                    _target: [{
                        _ref: "color",
                        _property: "foregroundColor"
                    }],
                    to: {
                        _obj: "HSBColorClass",
                        hue: savedForegroundColor.hue,
                        saturation: savedForegroundColor.saturation,
                        brightness: savedForegroundColor.brightness
                    },
                    source: "photoshopPicker",
                    _options: {
                        dialogOptions: "dontDisplay"
                    }
                }],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
        }

        console.log('✅ 单通道清除模式描边完成');
    } catch (error) {
        console.error('❌ 单通道清除模式描边失败:', error);
        throw error;
    }
}

// 9.不透明目标（背景图层 / 开启「锁定透明像素」的图层）的清除模式描边
//   ⚠️ 与分支 2（`strokeSelectionWithClearMode`）的**唯一**差别是混合模式：
//      `clearEnum` → `blendSubtraction`（减去）。
//   根因：`clearEnum`（清除）要求目标带透明度。背景图层不支持透明度、
//      「锁定透明像素」也等于禁止透明度 ⇒ 这两类目标上 clearEnum **不可用**
//      （Adobe 官方文档原话：The Clear blending mode will be unavailable for a
//        background layer, or if preserve transparency is enabled on the target layer）。
//      PS 对此**不抛错**，而是弹出原生「描边」对话框并按普通填充执行
//      —— 用户实测现象：背景图层「填充 + 描边 + 清除」弹出描边命令框、
//      随后把描边画成了描边色（2026-10-08）⇒ 12 组合里这 3 种失效。
//   改用 `blendSubtraction` 后：减去量 = 描边色灰度 × 不透明度，
//      即「以该描边的灰度删除描边内部的内容」，且全程静默。
//   ⚠️ 描述符形状与分支 2 完全一致（width 带 pixelsUnit / 枚举 strokeLength / color RGBColor），
//      不引入新的形状变体；本分支不修改前景色，因此**不做**无用的保存-恢复（省 2 次同步 IPC）。
async function strokeSelectionOnOpaqueLayer(strokeParams: any) {
    try {
        console.log('🔄 开始不透明目标（背景图层 / 锁定透明像素）清除模式描边，描边参数:', strokeParams);

        await batchPlay(
            [{
                _obj: "stroke",
                width: {
                    _unit: "pixelsUnit",
                    _value: strokeParams.width
                },
                location: {
                    _enum: "strokeLength",
                    _value: strokeParams.position
                },
                opacity: {
                    _unit: "percentUnit",
                    _value: strokeParams.opacity
                },
                mode: {
                    _enum: "blendMode",
                    // 由用户选的第一类算法决定：趋白 → 滤色；减法 → 减去；乘法 → 正片叠底（色已反相）
                    _value: strokeParams.blendMode
                },
                color: {
                    _obj: "RGBColor",
                    red: strokeParams.color.red,
                    green: strokeParams.color.green,
                    blue: strokeParams.color.blue
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );

        console.log('✅ 不透明目标清除模式描边完成');
    } catch (error) {
        console.error('❌ 不透明目标清除模式描边失败:', error);
        throw error;
    }
}
