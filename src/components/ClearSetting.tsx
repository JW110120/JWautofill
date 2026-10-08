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
 * 因此复用全部通用类，只在自己的 clear.css 里补三组选项的纵向节奏。
 *
 * 三组选项对应 utils/ClearAlgorithms.ts 的三类目标 —— 之所以**分成三组而不是一个下拉**：
 *   · 三类目标的物理载体不同（背景图层无 alpha、通道是灰度、像素图层有 alpha），
 *     可选项集本来就不同（只有背景图层需要「趋白」）；
 *   · 用户一次只需要关心自己正在画的那类目标，三组并列比「先选目标再选算法」少一次操作。
 *
 * ⚠️ 选项表必须是**模块级常量**：RadioGroup 已 React.memo，但若每次 render 现造数组，
 *    浅比较必然失败 ⇒ 每次父面板 setState 都会让三个 RadioGroup 全部重渲染。
 */

/** 第一类 · 背景图层（无透明度目标）：趋白 / 减法变黑 / 乘法变黑 */
const BACKGROUND_OPTIONS: RadioOption[] = [
    { value: 'whiten', label: '提亮' },
    { value: 'subtract', label: '减黑' },
    { value: 'multiply', label: '乘黑' },
];

/** 第二类 · 黑白通道（快速蒙版 / 图层蒙版 / 单一通道） */
const CHANNEL_OPTIONS: RadioOption[] = [
    { value: 'subtract', label: '减法' },
    { value: 'multiply', label: '乘法' },
];

/** 第三类 · 普通像素图层（降低不透明度） */
const LAYER_OPTIONS: RadioOption[] = [
    { value: 'subtract', label: '减法' },
    { value: 'multiply', label: '乘法' },
];

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
                <div>清除设置</div>
                <div className="close-button" role="button" tabIndex={0} onClick={onClose}>×</div>
            </div>

            <div className="panel-section">
                <span className="label-4" title={helpTexts.clear.backgroundAlgorithm}>背景图层</span>
                <RadioGroup
                    value={backgroundAlgorithm}
                    onChange={(e) => onBackgroundAlgorithmChange(e.target.value as ClearBackgroundAlgorithm)}
                    options={BACKGROUND_OPTIONS}
                    className="radio-trio-group"
                />
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
            </div>
        </div>
    );
};

export default React.memo(ClearSetting);
