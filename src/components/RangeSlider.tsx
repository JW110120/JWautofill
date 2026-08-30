import React, { useRef } from 'react';

/**
 * 自定义滑块组件。
 *
 * PS 27.9.1 起 UXP 换了新的 UI 渲染后端（Drover），原生 <input type="range">
 * 的 step 步进功能失效，滑块只能在 min / max 之间切换（Adobe 已知 bug PS-204932）。
 * 本组件用普通 div + 鼠标事件实现同等交互（点击轨道跳转、拖动滑块、键盘方向键微调），
 * 完全绕开原生 range 控件，步进按 step 精确吸附。
 */
interface RangeSliderProps {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (value: number) => void;
    className?: string;
    title?: string;
    /** 拖动结束时回调（如需要拖拽结束后再同步一次外部状态） */
    onDragEnd?: () => void;
    /** 禁用态：不可拖动 / 键盘调节，视觉置灰 */
    disabled?: boolean;
}

const RangeSlider: React.FC<RangeSliderProps> = ({
    value,
    min,
    max,
    step = 1,
    onChange,
    className,
    title,
    onDragEnd,
    disabled = false,
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);

    // 用 ref 保存最新回调，避免拖拽期间 document 级监听器捕获到过期的闭包
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onDragEndRef = useRef(onDragEnd);
    onDragEndRef.current = onDragEnd;

    const snapToStep = (raw: number): number => {
        const s = Math.abs(step) || 1;
        const stepped = min + Math.round((raw - min) / s) * s;
        const clamped = Math.max(min, Math.min(max, stepped));
        const decimals = (String(s).split('.')[1] || '').length;
        return Number(clamped.toFixed(decimals));
    };

    const valueFromClientX = (clientX: number): number => {
        const el = trackRef.current;
        if (!el) return value;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0) return value;
        // 读取 CSS 变量中的轨道两端缩进，让点击位置与可见轨道严格对应
        let inset = 6;
        try {
            const cs = window.getComputedStyle(el);
            const raw = cs.getPropertyValue('--rs-track-inset');
            if (raw) {
                const parsed = parseFloat(raw);
                if (!isNaN(parsed)) inset = parsed;
            }
        } catch (e) { /* 忽略，使用默认缩进 */ }
        const trackWidth = rect.width - inset * 2;
        if (trackWidth <= 0) return value;
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left - inset) / trackWidth));
        return snapToStep(min + ratio * (max - min));
    };

    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        draggingRef.current = true;
        onChangeRef.current(valueFromClientX(e.clientX));

        const handleMouseMove = (ev: MouseEvent) => {
            if (!draggingRef.current) return;
            onChangeRef.current(valueFromClientX(ev.clientX));
        };

        const handleMouseUp = () => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            if (onDragEndRef.current) onDragEndRef.current();
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        let next: number | null = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step;
        else if (e.key === 'Home') next = min;
        else if (e.key === 'End') next = max;
        else return;
        e.preventDefault();
        onChangeRef.current(snapToStep(next));
    };

    const safeValue = Number.isNaN(value) ? min : value;
    const percent = max === min ? 0 : ((safeValue - min) / (max - min)) * 100;

    return (
        <div
            ref={trackRef}
            className={`${className || ''} range-slider ${disabled ? 'disabled' : ''}`}
            title={title}
            role="slider"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={safeValue}
            tabIndex={disabled ? -1 : 0}
            onMouseDown={handleMouseDown}
            onKeyDown={handleKeyDown}
        >
            <div className="range-slider-track">
                <div className="range-slider-fill" style={{ width: `${percent}%` }} />
                <div className="range-slider-thumb" style={{ left: `${percent}%` }} />
            </div>
        </div>
    );
};

export default RangeSlider;
