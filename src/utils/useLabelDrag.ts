import React from 'react';
import { setDragCursorActive } from './dragCursor';

/**
 * 滑块文字标签横向拖拽调值（对齐 APP 主面板 selection-slider-label 的交互）。
 *
 * 用法：
 *   const { dragTarget, onLabelMouseDown } = useLabelDrag(CONFIGS, applyValue);
 *   <div className={`xxx-label ${dragTarget === 'radius' ? 'dragging' : 'not-dragging'}`}
 *        onMouseDown={(e) => onLabelMouseDown(e, 'radius', radius)}>半径</div>
 *
 * 说明：
 *   - 起点信息存 ref，mousemove 回调只读 ref，effect 只在「开始/结束拖拽」时解绑重绑，
 *     不会随滑块值每次变化反复 add/removeEventListener（UXP 下更稳）。
 *   - 值先按灵敏度放大位移，再吸附到 step，最后夹到 [min, max]。
 *   - configs / applyValue 每次渲染都会刷新到 ref，闭包永远拿到最新值，无需进依赖数组。
 */
export interface LabelDragConfig {
  min: number;
  max: number;
  /** 吸附步长，默认 1 */
  step?: number;
  /** 每 1px 鼠标位移对应的数值增量，默认 0.5 */
  sensitivity?: number;
}

export function useLabelDrag<T extends string>(
  configs: Record<T, LabelDragConfig>,
  applyValue: (key: T, value: number) => void
) {
  const [dragTarget, setDragTarget] = React.useState<T | null>(null);

  const dragRef = React.useRef<{ startX: number; startValue: number; target: T | null }>({
    startX: 0,
    startValue: 0,
    target: null
  });
  const configsRef = React.useRef(configs);
  configsRef.current = configs;
  const applyRef = React.useRef(applyValue);
  applyRef.current = applyValue;

  React.useEffect(() => {
    if (!dragTarget) return;

    const handleMouseMove = (event: MouseEvent) => {
      const { startX, startValue, target } = dragRef.current;
      if (!target) return;
      const config = configsRef.current[target];
      if (!config) return;

      const step = config.step ?? 1;
      const sensitivity = config.sensitivity ?? 0.5;
      const raw = startValue + (event.clientX - startX) * sensitivity;
      const snapped = Math.round(raw / step) * step;
      const newValue = Math.min(config.max, Math.max(config.min, Number(snapped.toFixed(4))));

      applyRef.current(target, newValue);
    };

    const handleMouseUp = () => setDragTarget(null);

    // 拖拽期间把全局光标锁成 grabbing（按下即抓住元素横向拖动，符合「抓取移动」语义）：
    // 鼠标移出标签后仍保持同一光标，否则光标会被鼠标下方的元素接管变成普通箭头。
    setDragCursorActive(true);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      setDragCursorActive(false);
    };
  }, [dragTarget]);

  /** 标签 onMouseDown：currentValue 传当前滑块值作为拖拽起点 */
  const onLabelMouseDown = (event: React.MouseEvent, key: T, currentValue: number) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startValue: currentValue, target: key };
    setDragTarget(key);
  };

  /** 生成标签 class：拖拽中 grabbing、常态 ew-resize（由 CSS 给出），全程光标连续 */
  const labelClass = (key: T, base: string) =>
    `${base} ${dragTarget === key ? 'dragging' : 'not-dragging'}`;

  return { dragTarget, onLabelMouseDown, labelClass };
}
