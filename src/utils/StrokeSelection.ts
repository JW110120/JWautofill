import { app, action, core, imaging } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { AppState } from '../types/state';

// 计算RGB颜色的灰度值
function rgbToGray(red: number, green: number, blue: number): number {
    // 使用标准的灰度转换公式：0.299*R + 0.587*G + 0.114*B
    return Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
}

const { executeAsModal } = core;
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

    // 如果在快速蒙版状态，使用简化的直接描边
    if (layerInfo?.isInQuickMask) {
        // 如果同时开启了清除模式，使用特殊的颜色计算描边
        if (state.clearMode) {
            await strokeSelectionWithColorCalculation(strokeParams, state);
        } else {
            await strokeSelectionDirect(strokeParams);
        }
        return;
    }

    // 如果在图层蒙版状态，使用图层蒙版描边
    if (layerInfo?.isInLayerMask) {
        // 如果同时开启了清除模式，使用图层蒙版清除模式描边
        if (state.clearMode) {
            await strokeSelectionInLayerMaskWithClearMode(strokeParams);
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
            await strokeSelectionInSingleChannelWithClearMode(strokeParams);
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
        //    ⇒ 这类上下文改用 `blendSubtraction`（减去），与快速蒙版 / 单通道的
        //      描边删除同构：减去量正比于描边色的灰度 ⇒「以该描边的灰度删除描边内部的内容」。
        if (layerInfo?.isBackground || layerInfo?.hasTransparencyLocked) {
            await strokeSelectionOnOpaqueLayer(strokeParams);
            return;
        }
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

// 2.像素图层的清除模式的特殊描边√
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

        // 获取当前前景色的RGB值并计算灰度值
        let foregroundRGB;
        await executeAsModal(async () => {
            const foregroundColor = app.foregroundColor;
            foregroundRGB = {
                red: foregroundColor.rgb.red,
                green: foregroundColor.rgb.green,
                blue: foregroundColor.rgb.blue
            };
        });
        
        // 计算前景色灰度值
        const foregroundGrayValue = rgbToGray(foregroundRGB.red, foregroundRGB.green, foregroundRGB.blue);
        console.log('🎨 前景色RGB:', foregroundRGB, '灰度值:', foregroundGrayValue);
        
        // 计算清除模式描边的不透明度：(前景色灰度值/255) * .subpanel-fill 中的不透明度
        const clearModeOpacity = (foregroundGrayValue / 255) * strokeParams.opacity;
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
async function strokeSelectionWithColorCalculation(strokeParams: any, state: any) {
    try {
        console.log('🔄 开始清除模式快速蒙版描边，描边参数:', strokeParams);
        
        // 1. 获取快速蒙版通道信息，判断是否为selectedAreas
        const channelResult = await batchPlay([
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

        let isSelectedAreas = false;
        if (channelResult[0] && 
            channelResult[0].alphaChannelOptions && 
            channelResult[0].alphaChannelOptions.colorIndicates) {
            isSelectedAreas = channelResult[0].alphaChannelOptions.colorIndicates._value === "selectedAreas";
        }
        console.log(`🔍 检测到colorIndicates为${isSelectedAreas ? 'selectedAreas' : '非selectedAreas'}`);
        
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
        console.log('✅ 已保存前景色');

        // 3. 根据selectedAreas状态选择混合模式执行描边
        const blendMode = isSelectedAreas ? "linearDodge" : "blendSubtraction";
        console.log(`🎨 使用混合模式: ${blendMode}`);
        
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
                    _value: blendMode
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

        // 4. 恢复前景色
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
                    _value: "blendSubtraction"  // 固定为减去模式
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
                    _value: "blendSubtraction"  // 固定为减去模式（与快速蒙版描边删除一致）
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
                    // 固定「减去」：不透明目标上 clearEnum 不可用（见上方说明）
                    _value: "blendSubtraction"
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
