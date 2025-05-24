import { app, action, core } from 'photoshop';
import { BLEND_MODES } from '../constants/blendModes';
import { Pattern } from '../types/state';

interface PatternFillOptions {
    opacity: number;
    blendMode: string;
    pattern: Pattern;
}

interface LayerInfo {
    isBackground: boolean;
    hasTransparencyLocked: boolean;
    hasPixels: boolean;
}

export class PatternFill {
    static async fillPattern(options: PatternFillOptions, layerInfo: LayerInfo) {
        const { isBackground, hasTransparencyLocked, hasPixels } = layerInfo;

        // 获取选区边界
        const bounds = app.activeDocument.selection.bounds;

        console.log("📐 选区信息:", bounds);

        if (!bounds) {
            console.error("❌ 无法获取选区边界数据");
            return;
        }

        const { left, top, right, bottom } = bounds;
        console.log("📏 选区边界:", { left, top, right, bottom });
        
        const width = right - left;
        const height = bottom - top;
        console.log("📐 选区尺寸:", { width, height });
        
        const centerX = left + width / 2;
        const centerY = top + height / 2;
        console.log("🎯 选区中心点:", { centerX, centerY });
        
        // 检查是否有patternName
        if (!options.pattern.patternName) {
            console.error("❌ 没有可用的图案名称，无法填充");
            return;
        }

        // 修复后的patternCommand定义
        const patternCommand = {
            _obj: "fill",
            using: { _enum: "fillContents", _value: "pattern" },
            opacity: { _unit: "percentUnit", _value: options.opacity },
            mode: { _enum: "blendMode", _value: BLEND_MODES[options.blendMode] || "normal" },
            pattern: {
                _obj: "pattern",
                _ref: "pattern",
                _name: options.pattern.patternName,
                scale: options.pattern.scale || 100,
                angle: options.pattern.angle || 0,
                width: width,
                height: height,
                offset: {
                    _obj: "offset",
                    horizontal: centerX,
                    vertical: centerY
                }
            },
            patternTransform: {
                _obj: "transform",
                xx: options.pattern.scale ? options.pattern.scale / 100 : 1,
                xy: 0,
                yx: 0,
                yy: options.pattern.scale ? options.pattern.scale / 100 : 1,
                tx: 0,
                ty: 0
            },
            _options: {
                dialogOptions: "dontDisplay"
            }
        };

        // 如果有角度设置，添加旋转变换
        if (options.pattern.angle && options.pattern.angle !== 0) {
            const angleRad = (options.pattern.angle * Math.PI) / 180;
            const cos = Math.cos(angleRad);
            const sin = Math.sin(angleRad);
            const scale = options.pattern.scale ? options.pattern.scale / 100 : 1;
            
            patternCommand.patternTransform = {
                _obj: "transform",
                xx: cos * scale,
                xy: -sin * scale,
                yx: sin * scale,
                yy: cos * scale,
                tx: 0,
                ty: 0
            };
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
