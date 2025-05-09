import { action } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';

interface FillOptions {
    opacity: number;
    blendMode: string;
    color: { hsb: { hue: number; saturation: number; brightness: number } }; // 添加颜色参数
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

    static async fillBackground(options: FillOptions) {
        const command = {
            ...this.createBasicFillCommand(options),
            _isCommand: true
        };
        
        await action.batchPlay([command], { 
            synchronousExecution: true, 
            dialogOptions: 'dontDisplayDialogs' 
        });
    }

    static async fillLockedWithPixels(options: FillOptions) {
        const command = {
            ...this.createBasicFillCommand(options),
            preserveTransparency: true,
            _isCommand: false
        };
        
        await action.batchPlay([command], { 
            synchronousExecution: true, 
            dialogOptions: 'dontDisplayDialogs' 
        });
    }

    static async fillLockedWithoutPixels(
        options: FillOptions, 
        unlockFn: () => Promise<void>,
        lockFn: () => Promise<void>
    ) {
        await unlockFn();
        
        const command = {
            ...this.createBasicFillCommand(options),
            _isCommand: true
        };
        
        await action.batchPlay([command], { 
            synchronousExecution: true, 
            dialogOptions: 'dontDisplayDialogs' 
        });
        
        await lockFn();
    }

    static async fillUnlocked(options: FillOptions) {
        const command = {
            ...this.createBasicFillCommand(options),
            _isCommand: false
        };
        
        await action.batchPlay([command], { 
            synchronousExecution: true, 
            dialogOptions: 'dontDisplayDialogs' 
        });
    }
}