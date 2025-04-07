import { action } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';

interface FillOptions {
    opacity: number;
    blendMode: string;
}

export class FillHandler {
    private static createBasicFillCommand(options: FillOptions) {
        return {
            _obj: 'fill',
            using: { _enum: 'fillContents', _value: 'foregroundColor' },
            opacity: options.opacity,
            mode: { _enum: 'blendMode', _value: BLEND_MODES[options.blendMode] || 'normal' }
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