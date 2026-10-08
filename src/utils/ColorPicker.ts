import { app, action, core } from 'photoshop';
import { rgbToHsb } from './ColorUtils';

const { executeAsModal } = core;
const { batchPlay } = action;

export interface RGBColor {
    red: number;
    green: number;
    blue: number;
}

/** RGB → PS 前景色描述符（HSBColorClass；saturation / brightness 为 0-100 的裸数字） */
function toForegroundDescriptor(rgb: RGBColor) {
    const { hue, saturation, brightness } = rgbToHsb(rgb.red, rgb.green, rgb.blue);
    return {
        _obj: 'HSBColorClass',
        hue: {
            _unit: 'angleUnit',
            _value: hue
        },
        saturation,
        brightness
    };
}

/** 读取当前前景色（HSB 描述符形式），供稍后还原 */
async function captureForegroundColor() {
    let saved: any = null;
    await executeAsModal(async () => {
        const foregroundColor = app.foregroundColor;
        saved = {
            _obj: 'HSBColorClass',
            hue: {
                _unit: 'angleUnit',
                _value: foregroundColor.hsb.hue
            },
            saturation: foregroundColor.hsb.saturation,
            brightness: foregroundColor.hsb.brightness
        };
    });
    return saved;
}

/** 写入前景色（与本文件/项目既有的「恢复前景色」写法保持同形） */
async function applyForegroundColor(descriptor: any) {
    await executeAsModal(async () => {
        await batchPlay(
            [{
                _obj: 'set',
                _target: [{
                    _ref: 'color',
                    _property: 'foregroundColor'
                }],
                to: descriptor,
                source: 'photoshopPicker',
                _options: {
                    dialogOptions: 'dontDisplay'
                }
            }],
            { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
        );
    });
}

/** 把拾色器返回值收敛成合法 RGB（PS 可能给 undefined / NaN / 越界浮点） */
function normalizeRgb(source: any): RGBColor | null {
    if (!source) return null;
    const clamp = (value: any) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return 0;
        return Math.max(0, Math.min(255, Math.round(num)));
    };
    // ⚠️ PS 的 RGB 描述符里绿色分量的历史拼写是 `grain`（Adobe 的历史包袱），
    //    但并非所有 API 分支都回 `grain` ⇒ 两个键都认。
    //    只认一个的话，拿到 undefined 会 `Math.round(undefined) = NaN`，
    //    拼出 `rgb(r, NaN, b)` 这种**非法颜色串**，色板就没有背景色（透出面板底色，
    //    看起来是一块深灰「#333333」而不是纯黑）—— 用户报的「面板显示 #333333」正是此症状。
    const green = source.grain !== undefined ? source.grain : source.green;
    return {
        red: clamp(source.red),
        green: clamp(green),
        blue: clamp(source.blue)
    };
}

/**
 * 打开 PS 原生拾色器，**并以 `initial` 作为初始色**。
 *
 * 根因（2026-10-08 修复）：`showColorPicker` 是**以「当前前景色」为初始值**的无参命令，
 * 描述符里没有任何「初始色」字段可传。旧实现直接裸调它 ⇒ 面板色板显示 A、
 * 拾色器却打开 PS 的前景色 B（用户报的 `#333333` → 打开成 `#000000`）。
 * 做法：先记下真·前景色 → 把前景色设成 `initial` → 打开拾色器 → 读返回值 →
 * **无论如何**在 finally 里还原真·前景色（拾色器是模态框，异常/取消都不能破坏用户前景色）。
 *
 * @returns 选中的颜色；用户取消或发生异常时返回 null（调用方据此跳过写回）。
 */
export async function pickColorWithInitial(initial: RGBColor, commandName: string): Promise<RGBColor | null> {
    const savedForegroundColor = await captureForegroundColor();
    try {
        await applyForegroundColor(toForegroundDescriptor(initial));

        const result = await executeAsModal(async () => {
            return await batchPlay(
                [{
                    _obj: 'showColorPicker',
                    _target: [{
                        _ref: 'application'
                    }]
                }],
                { dialogOptions: 'dontDisplayDialogs' }
            );
        }, { commandName });

        const picked = normalizeRgb(result && result[0] && result[0].RGBFloatColor);
        if (!picked) {
            return null;
        }
        return picked;
    } catch (error) {
        console.error('颜色选择器错误:', error);
        return null;
    } finally {
        if (savedForegroundColor) {
            try {
                await applyForegroundColor(savedForegroundColor);
            } catch (error) {
                console.warn('恢复前景色失败:', error);
            }
        }
    }
}
