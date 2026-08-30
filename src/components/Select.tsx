import React, { useCallback, useEffect, useRef, useState } from 'react';

// 通用自绘下拉：与调整面板里的自绘下拉（MaskSyncSelect / BrushSelect）共用同一套
// CSS（.mask-sync-select-*，定义在 src/adjustments/adjustment.css），因此视觉上
// 与主面板其它下拉完全一致，且背景/文字都走主题变量（--dropdown-bg-color 等），
// 不再依赖 sp-picker / sp-menu（其展开菜单背景在 UXP 下无法被 CSS 覆盖）。
//
// 支持：扁平列表（options）或分组带分隔线（groups）；禁用态（disabled）；
// 选中项高亮（.sel，背景=主题主色）。
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  tag?: React.ReactNode; // 右侧标注（如图标/文字），仅 brush 下拉使用
}

interface Props {
  value: string;
  options?: SelectOption[];
  groups?: SelectOption[][];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

export default function Select({
  value,
  options,
  groups,
  onChange,
  disabled = false,
  placeholder = '请选择',
  title,
  className = '',
  style,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const openAtRef = useRef(0);

  const allOptions = groups ? groups.flat() : (options ?? []);
  const sel = allOptions.find(o => o.value === value);

  const reposition = useCallback(() => {
    const r = headRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos(prev =>
      prev &&
      Math.abs(prev.left - r.left) < 1 &&
      Math.abs(prev.top - (r.bottom + 2)) < 1 &&
      Math.abs(prev.width - r.width) < 1
        ? prev
        : { left: r.left, top: r.bottom + 2, width: r.width }
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    // 弹层打开期间隐藏面板内的 number 输入（UXP 下原生控件 z-index 无效，会盖住弹层）
    document.body.classList.add('mask-sync-pop-open');
    const onDocClick = (e: MouseEvent) => {
      if (Date.now() - openAtRef.current < 300) return; // 打开瞬间的点击不关闭
      if (headRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      if (Date.now() - openAtRef.current < 200) return;
      reposition();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.body.classList.remove('mask-sync-pop-open');
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (open) reposition();
  }, [open, reposition, value]);

  const handleHeadClick = () => {
    if (disabled) return;
    if (!open) { openAtRef.current = Date.now(); reposition(); }
    setOpen(o => !o);
  };

  const handleOptClick = (o: SelectOption) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  const renderOpts = (opts: SelectOption[]) =>
    opts.map(o => (
      <div
        key={o.value}
        className={`mask-sync-select-opt ${o.value === value ? 'sel' : ''} ${o.disabled ? 'dis' : ''}`}
        onClick={() => handleOptClick(o)}
      >
        <span className="mask-sync-select-opt-main">{o.label}</span>
        {o.tag && <span className="mask-sync-select-opt-tag">{o.tag}</span>}
      </div>
    ));

  return (
    <div className={`mask-sync-select-wrap ${className}`} title={title} style={style}>
      <div
        ref={headRef}
        className={`mask-sync-select-head ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={handleHeadClick}
      >
        <span className="mask-sync-select-value">
          {sel ? sel.label : placeholder}
        </span>
        {sel?.tag && <span className="mask-sync-select-opt-tag">{sel.tag}</span>}
        <span className="mask-sync-select-caret">
          <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M4,7.01a1,1,0,0,1,1.7055-.7055l3.289,3.286,3.289-3.286a1,1,0,0,1,1.437,1.3865l-.0245.0245L9.7,11.7075a1,1,0,0,1-1.4125,0L4.293,7.716A.9945.9945,0,0,1,4,7.01Z" fill="currentColor" />
          </svg>
        </span>
      </div>
      {open && pos && !disabled && (
        <div
          ref={popRef}
          className="mask-sync-select-pop"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
        >
          {groups ? (
            groups.map((g, gi) => (
              <React.Fragment key={gi}>
                {gi > 0 && <div className="mask-sync-select-divider" />}
                {renderOpts(g)}
              </React.Fragment>
            ))
          ) : allOptions.length === 0 ? (
            <div className="mask-sync-select-opt dis">无可用选项</div>
          ) : (
            renderOpts(allOptions)
          )}
        </div>
      )}
    </div>
  );
}
