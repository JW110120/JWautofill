import React, { useCallback } from 'react';

/**
 * 自绘开关（替代原生 sp-switch）。
 *
 * 为什么不用原生 sp-switch：
 *  1. **颜色不可控**：sp-switch 内部胶囊颜色由 PS Spectrum 主题接管，UXP 下无法用 CSS
 *     覆盖background。在 darkest / lightest 这类极端主题下，Spectrum 给的关闭态胶囊色
 *     恰好接近面板底色 → 用户看到的只是一个"圆点"，完全不像开关（2026-10-06 实测）。
 *  2. 开启态也无法改成 --primary-color，与滑块（RangeSlider 自绘、纯 div 走主题令牌）
 *     的视觉语言不统一。
 *  本组件与 RangeSlider 同为纯 div 自绘 ⇒ 四套主题全部可控、开启态即主色蓝。
 *
 * 尺寸（对齐原生视觉，套用 common.css 既有度量）：
 *  - 胶囊轨道 33×16，圆点 12px，开启时圆点移到 right（left 19px），圆角均为 8px（=高的一半，
 *    端部为完美半圆）；圆角**不写999px**——UXP 下未按高度一半解析，实测会渲染成尖角纺锤。
 *  - 视觉盒 16px，但**占位盒高 24px**（靠绝对定位的伪元素居中），保证行内垂直居中
 *    与滑块、数字输入（24px）同基线 —— 原生 sp-switch 靠 32px 透明留白实现，
 *    自绘不需要那圈留白。占位盒宽必须= 胶囊宽，否则伪元素溢出会让两端鼓包。
 *
 * 无障碍：role="switch" + aria-checked + tabIndex + Enter/Space 触发，
 * 与项目内 IconButton 的键盘处理方式一致。
 *
 * 兼容原生调用形态：`onChange` 仍回传一个带 `target.checked` 的对象，
 * 因此现有 `onChange={(e) => setX((e.target as HTMLInputElement).checked)}`
 * 这类写法**无需改动**（见 onChange 的合成事件构造）。
 */
export interface ToggleSwitchProps {
    checked: boolean;
    /** 与原生 sp-switch 保持同样的签名：回传带 target.checked 的事件对象 */
    onChange: (e: { target: { checked: boolean } }) => void;
    disabled?: boolean;
    title?: string;
    /** 无障碍标签（title 已有时仍建议提供 screen-reader 文本） */
    'aria-label'?: string;
    className?: string;
    style?: React.CSSProperties;
}

export default function ToggleSwitch({
    checked,
    onChange,
    disabled = false,
    title,
    'aria-label': ariaLabel,
    className,
    style,
}: ToggleSwitchProps) {
    const handleToggle = useCallback(() => {
        if (disabled) return;
        // 构造与原生一致的最小事件形状，避免调用方为自定义组件改写 onChange
        onChange({ target: { checked: !checked } });
    }, [checked, disabled, onChange]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
        }
    }, [disabled, handleToggle]);

    const cls = [
        'toggle-switch',
        checked ? 'toggle-switch-on' : '',
        disabled ? 'toggle-switch-disabled' : '',
        className || '',
    ].filter(Boolean).join(' ');

    return (
        <div
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel || title}
            aria-disabled={disabled || undefined}
            tabIndex={disabled ? -1 : 0}
            className={cls}
            title={title}
            style={style}
            onClick={handleToggle}
            onKeyDown={handleKeyDown}
        >
            <span className="toggle-switch-knob" />
        </div>
    );
}
