import React from 'react';

export interface IconButtonProps {
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 24px 无边框自定义图标按钮（替代原生 sp-action-button）。
 *
 * 与垃圾桶 .hotkey-icon-button 同一套样式：透明背景、--text-color 图标、
 * hover 变蓝（--hover-icon）、点击轻微缩放、禁用态灰显 + not-allowed 光标。
 *
 * 为什么不用原生 sp-action-button：
 *  1. UXP / PS 升级后原生 Spectrum 组件在部分 PS 版本下渲染异常（兼容性）；
 *  2. sp-action-button 默认约 32px 高，压不到 24px，无法与旁边的垃圾桶对齐；
 *  3. 用 div + role="button" 完全可控，已接入键盘（Enter / Space），无障碍可用。
 *
 * 用法：
 *   <IconButton title="添加预设" onClick={handleAddPreset}>
 *     <AddIcon className="icon-15" />
 *   </IconButton>
 */
export default function IconButton({ onClick, title, disabled, children, className = '', style }: IconButtonProps) {
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      className={`hotkey-icon-button${disabled ? ' disabled' : ''}${className ? ' ' + className : ''}`}
      title={title}
      style={style}
      onClick={(e) => { if (!disabled) onClick?.(e); }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.(e);
        }
      }}
    >
      {children}
    </div>
  );
}
