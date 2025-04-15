import { action } from 'photoshop';

export class ClearHandler {
    static async clearWithOpacity(opacity: number) {
        try {
            const outputMin = Math.round(255 * (100 - opacity) / 100);
            
            await action.batchPlay([
                // 进入快速蒙版
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
                    _options: { dialogOptions: "dontDisplay" }
                },
                // 载入选区
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
                        _value: "previous"
                    },
                    _options: { dialogOptions: "dontDisplay" }
                },
                // 色阶调整
                {
                    _obj: "levels",
                    presetKind: {
                        _enum: "presetKindType",
                        _value: "presetKindCustom"
                    },
                    adjustment: [
                        {
                            _obj: "levelsAdjustment",
                            channel: {
                                _ref: "channel",
                                _enum: "ordinal",
                                _value: "targetEnum"
                            },
                            output: [
                                outputMin,
                                255
                            ]
                        }
                    ],
                    _options: { dialogOptions: "dontDisplay" }
                },
                // 清除快速蒙版
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
                    _options: { dialogOptions: "dontDisplay" }
                },
                // 删除选区内容
                {
                    _obj: "delete",
                    _options: { dialogOptions: "dontDisplay" }
                }
            ], { synchronousExecution: true });
        } catch (error) {
            console.error('清除选区失败:', error);
            throw error;
        }
    }
}