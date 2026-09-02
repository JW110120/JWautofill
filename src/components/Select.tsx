import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPopRoot } from '../utils/popRoot';
import {
  createOcclusionSession,
  estimatePopRect,
} from '../utils/popOverlay';

// 通用自绘下拉：与各面板里的自绘下拉（BrushSelect 等）共用同一套
// CSS（.mask-sync-select-*，定义在 src/adjustments/adjustment.css），因此视觉上
// 全插件下拉完全一致，且背景/文字都走主题变量（--dropdown-bg-color 等），
// 不再依赖 sp-picker / sp-menu（其展开菜单背景在 UXP 下无法被 CSS 覆盖）。
//
// 原调整面板的 MaskSyncSelect 已收敛到本组件：图层树 depth 缩进走 SelectOption.depth，
// 选中对勾由 showCheck 控制，展开前刷新（蒙版同步重新枚举图层）由 onOpen 钩子负责。
//
// 弹层通过 createPortal 挂到「所在面板的根容器」（#app / #pixeladjustment，见
// utils/popRoot.ts），原因：
//   1) 面板容器（.gradient-picker z-index:10 / .pattern-picker z-index:9999）会创建
//      层叠上下文，弹层再高的 z-index 也被困在该上下文里，无法盖住面板外的元素；
//   2) 弹层留在面板内会被 .gradient-setting-item div{display:flex} 之类的通用规则
//      命中，导致选项横向排成两列；也会被设置区的 overflow(裁剪)/sticky 影响；
//   3) 因此不需要再靠「展开时隐藏滑块数字」这类 hack 规避穿透——弹层永远在最上层。
//   注意：不能直接挂 document.body —— UXP 只渲染当前激活的 <uxp-panel> 子树，
//   挂到 body 的弹层不会被绘制（表现为下拉完全打不开）。
//
// 支持：扁平列表（options）或分组带分隔线（groups）；禁用态（disabled）；
// 选中项高亮（.sel，背景=主题主色、前景白）；无右侧标记时再补一个白色对勾。
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  tag?: React.ReactNode; // 右侧标注（如图标/文字），仅 brush 下拉使用
  depth?: number; // 图层树层级缩进（蒙版同步下拉使用）：padding-left = 8 + depth*16
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
  /** 选中项右侧打勾（与蒙版同步下拉统一）。默认开启；实际绘制还要求「该项无右侧标注」。 */
  showCheck?: boolean;
  /** 展开前钩子：蒙版同步用它刷新图层树；刷新期间（及完成后 600ms 缓冲）抑制一切自动关闭。 */
  onOpen?: () => void;
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
  showCheck = true,
  onOpen,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const openAtRef = useRef(0);
  // 自动关闭抑制截止时间：onOpen 刷新期间置 Infinity，刷新完成保留 600ms 缓冲，
  // 盖住 re-render/滚动/输入重放导致的「打开后立刻自动关闭」。
  const suppressCloseUntilRef = useRef(0);

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
    const onDocClick = (e: MouseEvent) => {
      if (Date.now() < suppressCloseUntilRef.current) return; // 刷新期/缓冲期：绝不关闭
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
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (open) reposition();
  }, [open, reposition, value, options, groups]);

  // UXP 限制：可编辑控件（滑块旁的 number 输入等）无视 z-index 永远画在最上层。
  // 弹层渲染出来后按实际矩形，只把与弹层相交的那些临时隐藏，关闭时还原。
  // 用「会话」管理：定位变化（滚动/重排）时 update 重算，不再相交的立即还原。
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const session = createOcclusionSession();
    const root = getPopRoot(headRef.current);
    const run = () => {
      const pop = popRef.current;
      if (!pop) return;
      session.update(pop, root, estimatePopRect(pos, Math.max(allOptions.length, 1)));
    };
    run();
    // UXP 偶发在插入 DOM 当帧拿不到弹层尺寸，下一帧再补一次，避免漏隐藏
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : 0;
    return () => {
      if (raf) cancelAnimationFrame(raf);
      session.restore();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos]);

  const handleHeadClick = () => {
    if (disabled) return;
    if (!open) {
      openAtRef.current = Date.now();
      if (onOpen) {
        // 展开前刷新（蒙版同步重新枚举图层）：刷新期间禁止一切自动关闭；
        // 刷新完成后保留 600ms 缓冲，盖住 re-render/滚动/输入重放导致的闪关。
        suppressCloseUntilRef.current = Number.MAX_SAFE_INTEGER;
        Promise.resolve()
          .then(() => onOpen())
          .catch(() => {})
          .finally(() => {
            suppressCloseUntilRef.current = Date.now() + 600;
          });
      }
      reposition();
    }
    setOpen(o => !o);
  };

  const handleOptClick = (o: SelectOption) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  // 挂载点：从下拉头部往上找到所属面板的根容器（#app / #pixeladjustment）。
  const popRoot = open && pos ? getPopRoot(headRef.current) : null;

  const renderOpts = (opts: SelectOption[]) =>
    opts.map((o, i) => (
      <div
        key={i}
        className={`mask-sync-select-opt ${o.value === value ? 'sel' : ''} ${o.disabled ? 'dis' : ''}`}
        style={o.depth != null ? { paddingLeft: 8 + o.depth * 16 } : undefined}
        onClick={() => handleOptClick(o)}
      >
        <span className="mask-sync-select-opt-main">{o.label}</span>
        {o.tag && <span className="mask-sync-select-opt-tag">{o.tag}</span>}
        {/* 选中项右侧对勾：仅在该项没有右侧标记（笔刷图标 / 图层标记）时显示，
            与蒙版同步下拉的样式一致。勾的颜色继承 .sel 的白色前景，落在主色（蓝）背景上。 */}
        {showCheck && !o.tag && o.value === value && (
          <span className="mask-sync-select-check">
            <svg viewBox="0 0 36 36" width="12" height="12" aria-hidden="true" focusable="false">
              <path d="M9 16.4L14.6 22.1L27.4 9.6L29.4 11.6L14.6 26.3L9 20.4Z" fill="currentColor" />
            </svg>
          </span>
        )}
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
      {open && pos && popRoot && !disabled && createPortal(
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
        </div>,
        popRoot
      )}
    </div>
  );
}
