import React, { useEffect, useState } from 'react';

/**
 * 虚线分割线（2026-11-16 从 AdjustmentPanel 抽成公共组件）。
 *
 * 原用途：「快捷操作」分区里 同层补色 与 分层补色 之间那一条。
 * 现在「功能快捷键」子面板要按**与折叠分区内完全相同的样式**画分隔线
 * （该实线的地方实线、虚线的地方虚线）⇒ 两处共用这一个组件，避免各自实现漂移。
 *
 * UXP 对 CSS 背景/边框高级特性支持不可靠（linear-gradient+var() 整条不渲染、
 * background-repeat: repeat-x 只渲染一次），因此改用纯 DOM 方案：
 * 一段 6px 短线 + 6px 空（12px 周期）的 span 序列 + flex 排列 + overflow 裁剪，
 * 短线颜色读取主题 --border-color（换主题后重新取一次）。
 */
const DashedDivider: React.FC<{ className?: string }> = ({ className }) => {
  const [borderColor, setBorderColor] = useState('rgb(128, 128, 128)');
  useEffect(() => {
    try {
      const bc =
        (getComputedStyle(document.documentElement).getPropertyValue('--border-color') || '').trim();
      if (bc) setBorderColor(bc);
    } catch {
      // 读取失败：保持默认灰
    }
  }, []);
  // 60 段 × 12px = 720px，足以覆盖任意面板宽度（多余部分被 overflow 裁掉）
  return (
    <div className={className ? 'divider-dashed ' + className : 'divider-dashed'}>
      {Array.from({ length: 60 }, (_, i) => (
        <span key={i} className="divider-dashed-dash" style={{ backgroundColor: borderColor }} />
      ))}
    </div>
  );
};

export default DashedDivider;
