import React from 'react';
import RadioGroup, { RadioOption } from './RadioGroup';
import {
    ClearBackgroundAlgorithm,
    ClearBinaryAlgorithm,
} from '../types/state';
import { helpTexts } from '../constants/helpTexts';

/**
 * 清除设置子面板（2026-10-08）。
 *
 * 结构与 StrokeSetting 同构（.panel + .subpanel-title-1 + .panel-section + .divider），
 * 因此复用全部通用类，只在自己的 clear.css 里补三组选项的纵向节奏与公式提示条。
 *
 * 三组选项对应 utils/ClearAlgorithms.ts 的三类目标 —— 之所以**分成三组而不是一个下拉**：
 *   · 三类目标的物理载体不同（背景图层无 alpha、通道是灰度、像素图层有 alpha），
 *     可选项集本来就不同（只有背景图层需要「趋白」）；
 *   · 用户一次只需要关心自己正在画的那类目标，三组并列比「先选目标再选算法」少一次操作。
 *
 * ⚠️ 选项表 / 公式表必须是**模块级常量**：RadioGroup 已 React.memo，但若每次 render 现造数组，
 *    浅比较必然失败 ⇒ 每次父面板 setState 都会让三个 RadioGroup 全部重渲染。
 *    （helpTexts 在 import 之后才可用，放组件体内还会因 es5 的 const 提升产生 TDZ 隐患。）
 *
 * 公式文案：与 utils/ClearAlgorithms.ts 的 clearBackgroundColor / clearScalarValue 严格对应，
 * 参数一律用中文（原值 / 输入灰度 / 强度 / 不透明度），随所选模式实时切换。
 */

/** 第一类 · 背景图层（无透明度目标）：趋白 / 减法变黑 / 乘法变黑 */
const BACKGROUND_OPTIONS: RadioOption[] = [
    { value: 'whiten', label: '提亮', title: helpTexts.clear.optWhiten },
    { value: 'subtract', label: '减黑', title: helpTexts.clear.optBgSubtract },
    { value: 'multiply', label: '乘黑', title: helpTexts.clear.optBgMultiply },
];

/** 第二类 · 黑白通道（快速蒙版 / 图层蒙版 / 单一通道） */
const CHANNEL_OPTIONS: RadioOption[] = [
    { value: 'subtract', label: '减法', title: helpTexts.clear.optChannelSubtract },
    { value: 'multiply', label: '乘法', title: helpTexts.clear.optChannelMultiply },
];

/** 第三类 · 普通像素图层（降低不透明度） */
const LAYER_OPTIONS: RadioOption[] = [
    { value: 'subtract', label: '减法', title: helpTexts.clear.optLayerSubtract },
    { value: 'multiply', label: '乘法', title: helpTexts.clear.optLayerMultiply },
];

/** 背景图层 · 所选算法 → 公式 */
const BACKGROUND_FORMULA: Record<ClearBackgroundAlgorithm, string> = {
    whiten: helpTexts.clear.formulaBackgroundWhiten,
    subtract: helpTexts.clear.formulaBackgroundSubtract,
    multiply: helpTexts.clear.formulaBackgroundMultiply,
};

/** 黑白通道 · 所选算法 → 公式 */
const CHANNEL_FORMULA: Record<ClearBinaryAlgorithm, string> = {
    subtract: helpTexts.clear.formulaChannelSubtract,
    multiply: helpTexts.clear.formulaChannelMultiply,
};

/** 普通像素图层 · 所选算法 → 公式 */
const LAYER_FORMULA: Record<ClearBinaryAlgorithm, string> = {
    subtract: helpTexts.clear.formulaLayerSubtract,
    multiply: helpTexts.clear.formulaLayerMultiply,
};

/**
 * 公式提示条：紧贴对应选项组下方，实时显示所选模式的计算公式。
 * 「强度」是三条公式共用的系数，参数名同样用中文（不透明度 / 内容不透明度 / 羽化系数）。
 */
const FormulaHint: React.FC<{ formula: string }> = ({ formula }) => (
    <div className="formula-hint" title={helpTexts.clear.formulaNote}>
        <div className="formula-hint-main">{formula}</div>
        <div className="formula-hint-sub">{helpTexts.clear.formulaStrength}</div>
    </div>
);

interface ClearSettingProps {
    isOpen: boolean;
    backgroundAlgorithm: ClearBackgroundAlgorithm;
    channelAlgorithm: ClearBinaryAlgorithm;
    layerAlgorithm: ClearBinaryAlgorithm;
    onBackgroundAlgorithmChange: (algorithm: ClearBackgroundAlgorithm) => void;
    onChannelAlgorithmChange: (algorithm: ClearBinaryAlgorithm) => void;
    onLayerAlgorithmChange: (algorithm: ClearBinaryAlgorithm) => void;
    onClose: () => void;
}

const ClearSetting: React.FC<ClearSettingProps> = ({
    isOpen,
    backgroundAlgorithm,
    channelAlgorithm,
    layerAlgorithm,
    onBackgroundAlgorithmChange,
    onChannelAlgorithmChange,
    onLayerAlgorithmChange,
    onClose,
}) => {
    if (!isOpen) return null;

    return (
        <div className="panel subpanel-clear">
            <div className="subpanel-title-1">
                <div title={helpTexts.clear.panelTitle}>清除设置</div>
                <div className="close-button" role="button" tabIndex={0} onClick={onClose} title={helpTexts.selectionFill.floatClose}>×</div>
            </div>

            <div className="panel-section">
                <span className="label-4" title={helpTexts.clear.backgroundAlgorithm}>背景图层</span>
                <RadioGroup
                    value={backgroundAlgorithm}
                    onChange={(e) => onBackgroundAlgorithmChange(e.target.value as ClearBackgroundAlgorithm)}
                    options={BACKGROUND_OPTIONS}
                    className="radio-trio-group"
                />
                <FormulaHint formula={BACKGROUND_FORMULA[backgroundAlgorithm]} />
            </div>

            <div className="divider"></div>

            <div className="panel-section">
                <span className="label-4 clear-group-label" title={helpTexts.clear.channelAlgorithm}>蒙版&通道</span>
                <RadioGroup
                    value={channelAlgorithm}
                    onChange={(e) => onChannelAlgorithmChange(e.target.value as ClearBinaryAlgorithm)}
                    options={CHANNEL_OPTIONS}
                    className="radio-pair-group"
                />
                <FormulaHint formula={CHANNEL_FORMULA[channelAlgorithm]} />
            </div>

            <div className="divider"></div>

            <div className="panel-section">
                <span className="label-4" title={helpTexts.clear.layerAlgorithm}>像素图层</span>
                <RadioGroup
                    value={layerAlgorithm}
                    onChange={(e) => onLayerAlgorithmChange(e.target.value as ClearBinaryAlgorithm)}
                    options={LAYER_OPTIONS}
                    className="radio-pair-group"
                />
                <FormulaHint formula={LAYER_FORMULA[layerAlgorithm]} />
            </div>
        </div>
    );
};

export default React.memo(ClearSetting);
