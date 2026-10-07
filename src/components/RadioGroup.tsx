import React, { useCallback } from 'react';

/**
 * 自绘单选组（替代原生 sp-radio-group）。
 *
 * 为什么不用原生 sp-radio（2026-10-07）：
 *  1. **无法控制内部布局**：sp-radio 的 slot 内容排版由宿主实现，外层写
 *     `justify-content: space-between` 也拦不住它按自己的方式摆放与换行
 *     （实测三项在窄档必然折行，且 `flex-wrap: nowrap` 完全无效）。
 *  2. **盒模型不可控**：sp-radio 自带 15px 水平内边距，三项就是 45px 被吞进盒内，
 *     想让「首项贴左 / 末项贴右 / 中项居中」就只能反过来砍标签宽度，
 *     文字溢出盒外、版式局促。
 *  自绘后三项就是三个普通 div：布局完全由 CSS 说了算。
 *
 * 🔴 **onChange 必须回传「原生形状」的事件对象**（`{ target: { value, selected } }`），
 * 而不是裸字符串。原因：调用方（app.tsx 的 handleFillModeChange）是从
 * `event.target.selected` 取值的 —— 那是原生 sp-radio-group 的取值路径。
 * 早期版本这里直接回传字符串，导致点不动（`event.target` 为 undefined）。
 * 与 ToggleSwitch 刻意回传 `{target:{checked}}` 是同一套「兼容原生事件形状」的设计。
 *
 * 版式（由容器类名决定，CSS 全在 common.css）：
 *  - `.radio-trio-group`：三列等宽，首项居左、末项居右、中项正中，项间自动均分。
 *  - `.radio-pair-group`：两列贴容器两端（首项左缘、末项右缘）。
 *  - `.radio-vertical`：纵向排列，每行「圆点 + 文字 + 右侧后缀（如齿轮按钮）」，
 *    用于父面板普通模式的填充模式（原 sp-radio + 齿轮的替代）。
 *
 * 尺寸/配色全部走主题令牌，四套主题一致；圆角写**显式像素 6px**（= 高的一半）
 * 而非 999px —— UXP 下未按高度一半解析 999px，实测会渲染成尖角纺锤。
 */
export interface RadioOption {
    value: string;
    label: string;
    title?: string;
    disabled?: boolean;
    /** 右侧后缀节点（如齿轮图标按钮）。仅 .radio-vertical 版式使用。 */
    suffix?: React.ReactNode;
}

export interface RadioGroupProps {
    value: string;
    options: RadioOption[];
    /** 回传原生形状的事件对象：`{ target: { value, selected } }` */
    onChange: (e: { target: { value: string; selected: string } }) => void;
    /** 追加在容器上的类名（.radio-trio-group / .radio-pair-group / .radio-vertical） */
    className?: string;
    /**
     * 自定义文字节点（可选）。用于「点文字打开子面板」这类交互：
     * 返回的节点应自行 `e.stopPropagation()`，避免连带触发外层选项的选中。
     * 不传则渲染纯文字 `<span className="radio-option-label">`。
     */
    labelRenderer?: (label: string, option: RadioOption) => React.ReactNode;
}

const RadioGroup: React.FC<RadioGroupProps> = ({
    value,
    options,
    onChange,
    className,
    labelRenderer,
}) => {
    const handleSelect = useCallback((v: string, disabled?: boolean) => {
        if (disabled) return;
        // 兼容原生事件形状：调用方按 `e.target.value` / `e.target.selected` 取值都能工作。
        onChange({ target: { value: v, selected: v } });
    }, [onChange]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent, v: string, disabled?: boolean) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onChange({ target: { value: v, selected: v } });
        }
    }, [onChange]);

    return (
        <div role="radiogroup" className={className}>
            {options.map((opt) => {
                const checked = opt.value === value;
                const cls = [
                    'radio-option',
                    checked ? 'radio-option-checked' : '',
                    opt.disabled ? 'radio-option-disabled' : '',
                ].filter(Boolean).join(' ');
                return (
                    <div
                        key={opt.value}
                        role="radio"
                        aria-checked={checked}
                        aria-disabled={opt.disabled || undefined}
                        aria-label={opt.title || opt.label}
                        tabIndex={opt.disabled ? -1 : 0}
                        className={cls}
                        title={opt.title}
                        onClick={() => handleSelect(opt.value, opt.disabled)}
                        onKeyDown={(e) => handleKeyDown(e, opt.value, opt.disabled)}
                    >
                        <span className="radio-option-dot" />
                        {labelRenderer
                            ? labelRenderer(opt.label, opt)
                            : <span className="radio-option-label">{opt.label}</span>}
                        {opt.suffix}
                    </div>
                );
            })}
        </div>
    );
};

export default React.memo(RadioGroup);