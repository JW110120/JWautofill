import React from 'react';
import IconButton from './IconButton';
import { FxIcon } from '../styles/Icons';

/**
 * 「显示公式」开关：单个斜体 fx 图标按钮（2026-10-10 替换原「文字标签 + 自绘 ToggleSwitch」）。
 *
 * 为什么换成图标按钮：原先这一行右侧要占掉「47px 文字标签 + 4px 间距 + 开关」约 80px，
 * 而它只是公式条的显隐开关、不参与任何计算 ⇒ 收成一个 24px 图标按钮，把横向空间还给标题，
 * 与同行左侧的分组标题（背景图层 / 蒙版&通道 / 像素图层 / 计算方法）不再抢位。
 *
 * ⚠️ 四处（清除设置三组 + 纯色「计算方法」）的开启状态**互相独立**
 *    （types/state.ts 的 FormulaVisibility）—— 任一处切换只影响本组公式条，
 *    不再像旧版那样共用一个布尔、四处同步。
 * ⚠️ 常亮态由自包含单类 .icon-button-latched 提供（实心主色胶囊 + --latched-icon 图标，
 *    四主题对比度 3.9:1），关闭态就是普通 .icon-button，见 common.css。
 * ⚠️ latched 会同时落到 aria-pressed，读屏读作「已按下」（切换按钮语义）。
 */
const FormulaToggle: React.FC<{
    visible: boolean;
    onToggle: () => void;
    title: string;
}> = ({ visible, onToggle, title }) => (
    <IconButton latched={visible} title={title} onClick={onToggle}>
        <FxIcon className="icon-16" />
    </IconButton>
);

export default React.memo(FormulaToggle);
