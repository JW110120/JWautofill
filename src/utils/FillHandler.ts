import { action } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';

interface FillOptions {
    opacity: number;
    blendMode: string;
    color: { hsb: { hue: number; saturation: number; brightness: number } }; // 添加颜色参数
}

/**
 * 「取消选区」命令 —— 可与 fill 一起塞进同一个 batchPlay 数组。
 *
 * 性能要点（2026-10-08）：batchPlay 的**数组元素在同一次宿主往返内按序执行完**，
 * 所以「填充 + 取消选区」合成一次下发，能省掉一整次同步 IPC 往返
 * （低端机5~15ms）。两者无数据依赖，语义完全等价。
 */
function createDeselectCommand() {
    return {
        _obj: 'set',
        _target: [{ _ref: 'channel', _property: 'selection' }],
        to: { _enum: 'ordinal', _value: 'none' },
        _options: { dialogOptions: 'dontDisplay' as const }
    };
}

/**
 * 统一的执行入口：把 fill 命令与可选的「取消选区」命令合成**一次** batchPlay。
 *
 * ⚠️ 为什么不用 `_isCommand: true` 的分开下发：那会把两次 IPC 拆成两次往返，
 * 而 PS 的 batchPlay 数组本身就是顺序执行的一次性批处理，合并零成本。
 */
async function playFillSequence(command: any, withDeselect: boolean): Promise<void> {
    const seq: any[] = withDeselect ? [command, createDeselectCommand()] : [command];
    await action.batchPlay(seq, {
        synchronousExecution: true,
        dialogOptions: 'dontDisplayDialogs'
    });
}

export class FillHandler {
    private static createBasicFillCommand(options: FillOptions) {
        return {
            _obj: 'fill',
            using: { _enum: 'fillContents', _value: 'color' },
            opacity: options.opacity,
            mode: { _enum: 'blendMode', _value: BLEND_MODES[options.blendMode] || 'normal' },
            color: {
                _obj: 'HSBColorClass', // 修改为Photoshop识别的HSB颜色类名
                hue: options.color.hsb.hue,
                saturation: options.color.hsb.saturation,
                brightness: options.color.hsb.brightness
            }
        };
    }

    /**
     * @param withDeselect 是否把「取消选区」合并进同一次 batchPlay。
     *   调用方（app.tsx 填充路径）在自己已经发过一次 deselect 时必须传 false，
     *   否则会重复取消（语义上无害但会多一条历史记录）。
     */
    static async fillBackground(options: FillOptions, withDeselect = false) {
        const command = {
            ...this.createBasicFillCommand(options),
            _isCommand: true
        };
        await playFillSequence(command, withDeselect);
    }

    static async fillLockedWithPixels(options: FillOptions, withDeselect = false) {
        const command = {
            ...this.createBasicFillCommand(options),
            preserveTransparency: true,
            _isCommand: false
        };
        await playFillSequence(command, withDeselect);
    }

    static async fillLockedWithoutPixels(
        options: FillOptions,
        unlockFn: () => Promise<void>,
        lockFn: () => Promise<void>,
        withDeselect = false
    ) {
        await unlockFn();

        const command = {
            ...this.createBasicFillCommand(options),
            _isCommand: true
        };

        await playFillSequence(command, withDeselect);

        await lockFn();
    }

    static async fillUnlocked(options: FillOptions, withDeselect = false) {
        const command = {
            ...this.createBasicFillCommand(options),
            _isCommand: false
        };
        await playFillSequence(command, withDeselect);
    }

    static createColorFillCommand(options: FillOptions) {
        return {
            ...this.createBasicFillCommand(options),
            using: { _enum: 'fillContents', _value: 'color' },
            color: options.color,
            _isCommand: true
        };
    }
}