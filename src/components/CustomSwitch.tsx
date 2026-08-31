import React from 'react';

export interface CustomSwitchProps {
  checked: boolean;
  /** 直接回调、不带事件对象：本项目所有 switch handler 均为无参、内部自行翻转 state */
  onChange: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}

/**
 * 自定义开关（替代原生 sp-switch，规避 PS 升级后原生 Spectrum 组件的兼容性问题）。
 *
 * 视觉：轨道 + 圆点，开启态轨道变主题色（--primary-color）、圆点右移；4px 圆角与面板主按钮统一。
 * 圆形圆点 + 胶囊轨道的「开关感」由 .custom-switch-* 提供（见 styles.css）。
 *
 * 与原生 sp-switch 的差异：
 *  - onChange 直接回调、不带事件对象（本项目的 toggle handler 都是无参、内部翻转 state）；
 *    若需兼容「读 e.target.checked」的旧 handler，可在 onChange 内自行构造事件对象。
 *  - 接入键盘（Enter / Space 切换）、role="switch" + aria-checked，无障碍可用。
 *  - 不依赖任何 Spectrum 运行时，UXP / 新版本 PS 下渲染稳定。
 *
 * 迁移示例（app.tsx 原 sp-switch）：
 *   原：<sp-switch checked={s.x} onChange={this.toggleX} disabled={d} />
 *   新：<CustomSwitch checked={s.x} onChange={this.toggleX} disabled={d} />
 *   （toggleX 保持原样：this.setState({ x: !this.state.x })）
 */
export default function CustomSwitch({ checked, onChange, disabled, title, className = '' }: CustomSwitchProps) {
  return (
    <div
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      title={title}
      className={`custom-switch${checked ? ' on' : ''}${disabled ? ' disabled' : ''}${className ? ' ' + className : ''}`}
      onClick={() => { if (!disabled) onChange(); }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onChange();
        }
      }}
    >
      <span className="custom-switch-track">
        <span className="custom-switch-thumb" />
      </span>
    </div>
  );
}
