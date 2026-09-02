import React from 'react';

export interface IconButtonProps {
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

/**
 * 24px 无边框自定义图标按钮（替代原生 sp-action-button）。
 *
 * 通用类：.icon-button（所有仅含一个图标的按钮，无外边框）；禁用态为自包含单类
 * .icon-button-disabled（一个元素只挂一个类，与 common.css 单一来源保持一致）。
 *
 * 为什么不用原生 sp-action-button：
 *  1. UXP / PS 升级后原生 Spectrum 组件在部分 PS 版本下渲染异常（兼容性）；
 *  2. sp-action-button 默认约 32px 高，压不到 24px，无法与旁边的图标对齐；
 *  3. 用 div + role="button" 完全可控，已接入键盘（Enter / Space），无障碍可用。
 *
 * 用法：
 *   <IconButton title="添加预设" onClick={handleAddPreset}>
 *     <AddIcon className="icon-14" />
 *   </IconButton>
 */
export default function IconButton({ onClick, title, disabled, children, style }: IconButtonProps) {
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      className={disabled ? 'icon-button-disabled' : 'icon-button'}
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
