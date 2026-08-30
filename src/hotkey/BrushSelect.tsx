import React, { useCallback, useEffect, useRef, useState } from 'react';

// 笔刷下拉：与调整面板里的自绘下拉（MaskSyncSelect）共用同一套 CSS
// （.mask-sync-select-*，定义在 src/adjustments/adjustment.css），
// 因此视觉上与面板其它下拉完全一致；这里额外支持每个选项右侧的类型标签。
//
// 为什么不用原生 <sp-picker>：sp-picker 的选项只能放纯文本，无法把「混合器/涂抹」
// 这类类型标注右对齐，也无法在面板内保持与 MaskSyncSelect 相同的观感。
export interface BrushSelectOption {
  value: string;          // 笔刷预设名（PS 要求精确一致）
  main: string;           // 主文本
  tag?: React.ReactNode;  // 右侧标注（笔刷类型图标或文字；空则不显示）
}

interface Props {
  value: string;
  options: BrushSelectOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  title?: string;
  style?: React.CSSProperties;
}

export default function BrushSelect({ value, options, onChange, placeholder, title, style }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const openAtRef = useRef(0);

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
  }, [options, open, reposition]);

  const sel = options.find(o => o.value === value);

  return (
    <div className="mask-sync-select-wrap" title={title} style={style}>
      <div
        ref={headRef}
        className={`mask-sync-select-head ${open ? 'open' : ''}`}
        onClick={() => {
          if (!open) { openAtRef.current = Date.now(); reposition(); }
          setOpen(o => !o);
        }}
      >
        <span className="mask-sync-select-value">
          {sel ? sel.main : (placeholder || '请选择笔刷')}
        </span>
        {sel && sel.tag && <span className="mask-sync-select-opt-tag">{sel.tag}</span>}
        <span className="mask-sync-select-caret">
          <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M4,7.01a1,1,0,0,1,1.7055-.7055l3.289,3.286,3.289-3.286a1,1,0,0,1,1.437,1.3865l-.0245.0245L9.7,11.7075a1,1,0,0,1-1.4125,0L4.293,7.716A.9945.9945,0,0,1,4,7.01Z" fill="currentColor" />
          </svg>
        </span>
      </div>
      {open && pos && (
        <div
          ref={popRef}
          className="mask-sync-select-pop"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
        >
          {options.length === 0 && (
            <div className="mask-sync-select-opt dis">无可用笔刷</div>
          )}
          {options.map(o => (
            <div
              key={o.value}
              className={`mask-sync-select-opt ${o.value === value ? 'sel' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span className="mask-sync-select-opt-main">{o.main}</span>
              {o.tag && <span className="mask-sync-select-opt-tag">{o.tag}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
