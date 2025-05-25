import { app, action, core } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Pattern } from '../types/state';

interface PatternFillOptions {
    opacity: number;
    blendMode: string;
    pattern: Pattern;
    preserveTransparency?: boolean; // 添加新的选项
}

interface LayerInfo {
    isBackground: boolean;
    hasTransparencyLocked: boolean;
    hasPixels: boolean;
}

export class PatternFill {
    static async fillPattern(options: PatternFillOptions, layerInfo: LayerInfo) {
        const { isBackground, hasTransparencyLocked, hasPixels } = layerInfo;

        try {
            // 检查是否有选区
            const hasSelection = await this.checkSelection();
            if (!hasSelection) {
                console.error("❌ 没有活动选区");
                return;
            }

            // 检查是否有patternName
            if (!options.pattern.patternName) {
                console.error("❌ 没有可用的图案名称，无法填充");
                return;
            }

            // 修改patternCommand的构建逻辑
            const patternCommand = {
                _obj: "fill",
                using: { _enum: "fillContents", _value: "pattern" },
                opacity: { _unit: "percentUnit", _value: options.opacity },
                mode: { _enum: "blendMode", _value: BLEND_MODES[options.blendMode] || "normal" },
                Pattern: {
                    _obj: "pattern",
                    name: options.pattern.patternName,
                    angle: { _unit: "angleUnit", _value: options.pattern.angle || 0 },
                    scale: { _unit: "percentUnit", _value: options.pattern.scale || 100 }
                },
                _options: {
                    dialogOptions: "dontDisplay"
                }
            };

            // 根据preserveTransparency选项决定是否添加preserveTransparency属性
            if (options.preserveTransparency) {
                patternCommand.preserveTransparency = true;
            }

            // 根据图层状态执行填充
            if (isBackground) {
                await action.batchPlay([patternCommand], { synchronousExecution: true });
            } else if (hasTransparencyLocked && hasPixels) {
                await action.batchPlay([{
                    ...patternCommand,
                    preserveTransparency: true
                }], { synchronousExecution: true });
            } else if (hasTransparencyLocked && !hasPixels) {
                await this.unlockLayerTransparency();
                await action.batchPlay([patternCommand], { synchronousExecution: true });
                await this.lockLayerTransparency();
            } else {
                await action.batchPlay([patternCommand], { synchronousExecution: true });
            }

            console.log("✅ 图案填充成功");
        } catch (error) {
            console.error("❌ 图案填充失败:", error);
            throw error;
        }
    }

    // 添加检查选区的方法
    private static async checkSelection(): Promise<boolean> {
        try {
            const bounds = app.activeDocument.selection.bounds;
            return bounds !== undefined && bounds !== null;
        } catch (error) {
            return false;
        }
    }

    private static async lockLayerTransparency() {
        await action.batchPlay([
            {
                _obj: "applyLocking",
                _target: [
                    { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
                ],
                layerLocking: {
                    _obj: "layerLocking",
                    protectTransparency: true
                },
                _options: { dialogOptions: "dontDisplay" }
            }
        ], { synchronousExecution: true });
    }

    private static async unlockLayerTransparency() {
        await action.batchPlay([
            {
                _obj: "applyLocking",
                _target: [
                    { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
                ],
                layerLocking: {
                    _obj: "layerLocking",
                    protectNone: true
                },
                _options: { dialogOptions: "dontDisplay" }
            }
        ], { synchronousExecution: true });
    }
}
