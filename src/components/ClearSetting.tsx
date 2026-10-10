import React from 'react';
import RadioGroup, { RadioOption } from './RadioGroup';
import FormulaToggle from './FormulaToggle';
import {
    ClearBackgroundAlgorithm,
    ClearBinaryAlgorithm,
    FormulaScope,
    FormulaVisibility,
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
 *
 * 「显示公式」开关（2026-10-10 改造）：三组标题行右侧各一个**斜体 fx 图标按钮**
 * （components/FormulaToggle.tsx，常亮态 = .icon-button-latched 实心主色胶囊），
 * 三组状态**互相独立**（types/state.ts 的 FormulaVisibility），互不联动。
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
 * 排版（2026-10-10 优化为 markdown 式层次，详见 common.css 的公式条注释）：
 *   主公式（加粗 = 重点）→ 分隔线 → 辅助说明（强度系数公式 / 羽化系数释义）。
 * ⚠️「羽化系数」拆成「术语 + 释义」两段，术语加粗（markdown 的 **term**）；
 *    术语 / 释义文案见 helpTexts.clear.formulaGlossTerm / formulaGloss。
 */
const FormulaHint: React.FC<{ formula: string }> = ({ formula }) => (
    <div className="formula-hint" title={helpTexts.clear.formulaNote}>
        <div className="formula-hint-main">{formula}</div>
        <div className="formula-hint-notes">
            <div className="formula-hint-note">{helpTexts.clear.formulaStrength}</div>
            <div className="formula-hint-note">
                <span className="formula-hint-term">{helpTexts.clear.formulaGlossTerm}：</span>
                {helpTexts.clear.formulaGloss}
            </div>
        </div>
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
    /** 「显示公式」：三组各自的显隐状态（默认全关，逐项持久化） */
    formulaVisible: FormulaVisibility;
    onFormulaVisibleChange: (scope: FormulaScope, visible: boolean) => void;
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
    formulaVisible,
    onFormulaVisibleChange,
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
                <div className="row-between">
                    <span className="label-4" title={helpTexts.clear.backgroundAlgorithm}>背景图层</span>
                    <FormulaToggle
                        visible={formulaVisible.background}
                        onToggle={() => onFormulaVisibleChange('background', !formulaVisible.background)}
                        title={helpTexts.clear.showFormulaBackground}
                    />
                </div>
                <RadioGroup
                    value={backgroundAlgorithm}
                    onChange={(e) => onBackgroundAlgorithmChange(e.target.value as ClearBackgroundAlgorithm)}
                    options={BACKGROUND_OPTIONS}
                    className="radio-trio-group"
                />
                {formulaVisible.background && <FormulaHint formula={BACKGROUND_FORMULA[backgroundAlgorithm]} />}
            </div>

            <div className="divider"></div>

            <div className="panel-section">
                <div className="row-between">
                    <span className="label-4 clear-group-label" title={helpTexts.clear.channelAlgorithm}>蒙版&通道</span>
                    <FormulaToggle
                        visible={formulaVisible.channel}
                        onToggle={() => onFormulaVisibleChange('channel', !formulaVisible.channel)}
                        title={helpTexts.clear.showFormulaChannel}
                    />
                </div>
                <RadioGroup
                    value={channelAlgorithm}
                    onChange={(e) => onChannelAlgorithmChange(e.target.value as ClearBinaryAlgorithm)}
                    options={CHANNEL_OPTIONS}
                    className="radio-pair-group"
                />
                {formulaVisible.channel && <FormulaHint formula={CHANNEL_FORMULA[channelAlgorithm]} />}
            </div>

            <div className="divider"></div>

            <div className="panel-section">
                <div className="row-between">
                    <span className="label-4" title={helpTexts.clear.layerAlgorithm}>像素图层</span>
                    <FormulaToggle
                        visible={formulaVisible.layer}
                        onToggle={() => onFormulaVisibleChange('layer', !formulaVisible.layer)}
                        title={helpTexts.clear.showFormulaLayer}
                    />
                </div>
                <RadioGroup
                    value={layerAlgorithm}
                    onChange={(e) => onLayerAlgorithmChange(e.target.value as ClearBinaryAlgorithm)}
                    options={LAYER_OPTIONS}
                    className="radio-pair-group"
                />
                {formulaVisible.layer && <FormulaHint formula={LAYER_FORMULA[layerAlgorithm]} />}
            </div>
        </div>
    );
};

export default React.memo(ClearSetting);
