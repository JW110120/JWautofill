import React from 'react';
import { calcDragValue } from './dragSensitivity';

/**
 * 滑块文字标签横向拖拽调值（对齐 APP 主面板 .label 的交互）。
 *
 * 用法：
 *   const { dragTarget, onLabelMouseDown } = useLabelDrag(CONFIGS, applyValue);
 *   <div className="label-drag" onMouseDown={(e) => onLabelMouseDown(e, 'radius', radius)}>半径</div>
 *
 * 说明：
 *   - 起点信息存 ref，mousemove 回调只读 ref，effect 只在「开始/结束拖拽」时解绑重绑，
 *     不会随滑块值每次变化反复 add/removeEventListener（UXP 下更稳）。
 *   - 灵敏度不手写、由 calcDragValue 按量程归一化（见 utils/dragSensitivity.ts），
 *     保证不同量程/不同长度的滑块拖拽手感一致。
 *   - configs / applyValue 每次渲染都会刷新到 ref，闭包永远拿到最新值，无需进依赖数组。
 */
export interface LabelDragConfig {
  min: number;
  max: number;
  /** 吸附步长，默认 1 */
  step?: number;
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
      const newValue = calcDragValue(
        startValue,
        event.clientX - startX,
        config.min,
        config.max,
        step
      );

      applyRef.current(target, newValue);
    };

    const handleMouseUp = () => setDragTarget(null);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragTarget]);

  /** 标签 onMouseDown：currentValue 传当前滑块值作为拖拽起点 */
  const onLabelMouseDown = (event: React.MouseEvent, key: T, currentValue: number) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startValue: currentValue, target: key };
    setDragTarget(key);
  };

  /** 生成标签 class：单类名 */
  const labelClass = (key: T, base: string) => base;

  return { dragTarget, onLabelMouseDown, labelClass };
}
