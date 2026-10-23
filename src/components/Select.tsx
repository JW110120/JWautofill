import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPopRoot } from '../utils/popRoot';
import {
  createOcclusionSession,
  popContentHeight,
  POP_MAX_H,
} from '../utils/popOverlay';

// 通用自绘下拉：与各面板里的自绘下拉（BrushSelect 等）共用同一套
// CSS（.select-*，定义在 src/styles/common.css「通用自绘下拉组件」区），因此视觉上
// 全插件下拉完全一致，且背景/文字都走主题变量（--dropdown-bg-color 等），
// 不再依赖 sp-picker / sp-menu（其展开菜单背景在 UXP 下无法被 CSS 覆盖）。
//
// 原调整面板的 MaskSyncSelect 已收敛到本组件：图层树 depth 缩进走 SelectOption.depth，
// 选中对勾由 showCheck 控制，展开前刷新（蒙版同步重新枚举图层）由 onOpen 钩子负责。
//
// 弹层通过 createPortal 挂到「所在面板的根容器」（#app / #pixeladjustment，见
// utils/popRoot.ts），原因：
//   1) 面板容器（.subpanel-fill z-index:9999）会创建
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
  style?: React.CSSProperties;
  /** 选中项右侧打勾（与蒙版同步下拉统一）。默认开启；实际绘制还要求「该项无右侧标注」。 */
  showCheck?: boolean;
  /** 展开前钩子：蒙版同步用它刷新图层树；刷新期间（及完成后 600ms 缓冲）抑制一切自动关闭。 */
  onOpen?: () => void;
  /**
   * 向上展开（弹层底边贴在头部上沿上方 2px）。默认向下。
   *
   * ⛔⛔⛔ 2026-10-23 末次结论：**本 prop 目前没有任何调用点，实测也不可用，别再用**。
   *    曾给 app 面板的混合模式下拉打开过（目的：不遮下方不透明度/羽化滑块），用户回报
   *    「展开位置偏上，反而盖住主标题和主开关」。实测数据：该下拉头部上沿 ≈210px，
   *    而 27 项菜单的可见高度 200px ⇒ 头部上方根本装不下 ⇒ 定位被底部的
   *    `Math.max(top, 2)` 兜底夹到面板顶边，菜单于是顶到天花板、底边反而越过了下拉框
   *    —— 所谓「偏上」不是算错，是**装不下被夹**。
   *    ⇒ 结论：上翻只在「头部上方空间 ≥ 菜单高度」时才正确，而这类面板下半区一定是
   *      控件密集区，两头都不合算。保留代码仅为记录，不要再传 true。
   *
   * 以下为当初引入时的理由（已作废）：
   *   头部下方是不透明度/羽化滑块与模式参数行，向下展开会盖住它们，且遮挡逻辑会把被盖住的
   *   数字输入临时隐藏。现在改回向下展开 —— 遮挡隐藏是 UXP 硬限制下的正确行为
   *   （否则数字会浮在菜单之上），菜单关闭即还原。
   *
   * ⛔ 弹层高度/位置**只由 popOverlay 的整数常量算出**，绝不来自 getBoundingClientRect：
   *   UXP 的 height:auto 按未取整行盒算（12px 字 ≈21.4px/行），绘制按整像素落行 ⇒
   *   内容比盒高 ⇒ 原生滚动条 + 首行被裁；而 gBCR 又常返回上一帧高度 ⇒ 「量一次再校正」
   *   会收敛到错误的固定点（菜单浮空 45px）。行高已在 common.css 钉成整数 22px。
   */
  openUp?: boolean;
}

function Select({
  value,
  options,
  groups,
  onChange,
  disabled = false,
  placeholder = '请选择',
  title,
  style,
  showCheck = true,
  onOpen,
  openUp = false,
}: Props) {  const [open, setOpen] = useState(false);
  /**
   * pos：弹层的定位与尺寸。`h` 只在上翻时有意义 = 弹层**显式**高度（内容自然高度，
   * 超过 POP_MAX_H 时封顶并退回滚动），`contentH` = 内容自然高度（判断是否需要滚动）。
   * ⛔ 这两个值全部由常量算出，**绝不来自 getBoundingClientRect**（理由见 openUp 注释）。
   */
  const [pos, setPos] = useState<{
    left: number; top: number; width: number;
    up: boolean; headTop: number; h: number; contentH: number;
  } | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const openAtRef = useRef(0);
  // 自动关闭抑制截止时间：onOpen 刷新期间置 Infinity，刷新完成保留 600ms 缓冲，
  // 盖住 re-render/滚动/输入重放导致的「打开后立刻自动关闭」。
  const suppressCloseUntilRef = useRef(0);
  // 遮挡会话的当前 run（供滚动回调复用）。**必须声明在 onScroll 之前**：
  // const 存在暂存区，在同一次渲染中先于声明处调用会抛 ReferenceError(TDZ)。
  const occlusionRunRef = useRef<(() => void) | null>(null);

  const allOptions = useMemo(
    () => (groups ? groups.flat() : (options ?? [])),
    [groups, options]
  );
  // 选中项查表：图层下拉动辄数百项，旧实现每次渲染都 O(N) 线性 find。
  const sel = useMemo(
    () => allOptions.find(o => o.value === value),
    [allOptions, value]
  );

  /**
   * 选项内容签名：用于在「菜单已展开、用户增删/重命名图层」时驱动遮挡重算。
   *
   * ⚠️ 必须同时包含 value 与 label：
   *   · value（=图层 id）变化 ⇒ 增删图层 ⇒ 菜单项数/高度变；
   *   · label 变化        ⇒ 重命名/移动图层 ⇒ 行文本变，但项数可能不变，
   *     而高度仍可能因换行/缩进变化（depth 也会影响），故一并纳入。
   * 只用 length 不足以覆盖「改名但数量不变」的场景。
   *
   * ⚠️ 性能（2026-10-06）：旧实现是**无 memo 的每次渲染全量重建**。
   * 图层下拉有数百项，而父组件（面板分区内容）每次折叠/展开都会重渲染，
   * 于是「折叠一个分区」要为每个 Select 重建一遍全量签名（N 次 map + join），
   * 多个任务 × 2 个下拉 ⇒ 数千次字符串分配。这正是「大量图层下折叠变卡」的一环。
   * 现在用 useMemo：仅当选项内容真正变化时才重算，折叠引发的无关重渲染直接复用。
   */
  const optionsSignature = useMemo(
    () => allOptions.map(o => `${o.value}|${o.label}|${o.depth ?? ''}`).join('~'),
    [allOptions]
  );

  // 分组下拉的分隔线条数（参与弹层高度计算：每条 1px + 上下 margin 2px）
  const dividerCount = useMemo(
    () => (groups ? Math.max(groups.length - 1, 0) : 0),
    [groups]
  );

  const reposition = useCallback(() => {
    const r = headRef.current?.getBoundingClientRect();
    if (!r) return;
    // 内容自然高度：行高与 padding/描边全部来自 popOverlay 的整数常量（与 CSS 同步）。
    // **可见高度** = min(内容高, max-height)：超长列表（如混合模式 27 项）会被 CSS 的
    // max-height 裁到 200 后滚动，超出部分不在屏幕上 ⇒ 判定带与定位都必须按可见高度算，
    // 否则会多圈住下方一整个输入框（误藏）。
    const contentH = popContentHeight(allOptions.length, dividerCount);
    const h = Math.min(contentH, POP_MAX_H);
    // 上翻：弹层底边贴头部上沿上方 2px。底部贴近面板顶边时（极窄窗口）兜个底，不让它跑出可视区。
    const top = openUp ? Math.max(r.top - 2 - h, 2) : r.bottom + 2;
    setPos(prev =>
      prev &&
      Math.abs(prev.left - r.left) < 1 &&
      Math.abs(prev.top - top) < 1 &&
      Math.abs(prev.width - r.width) < 1 &&
      prev.up === !!openUp &&
      Math.abs(prev.headTop - r.top) < 1 &&
      prev.h === h &&
      prev.contentH === contentH
        ? prev
        : { left: r.left, top, width: r.width, up: !!openUp, headTop: r.top, h, contentH }
    );
  }, [openUp, allOptions.length, dividerCount]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (Date.now() < suppressCloseUntilRef.current) return; // 刷新期/缓冲期：绝不关闭
      if (Date.now() - openAtRef.current < 300) return; // 打开瞬间的点击不关闭
      if (headRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    let popScrollRaf = 0;
    const onScroll = (e: Event) => {
      // ⚠️ 菜单**自身**滚动（.select-pop overflow-y:auto，选项多到 7+ 层时必然出现）
      //   同样必须重算遮挡：滚动会改变「哪些选项真正可见」，进而改变下方输入框
      //   是否被覆盖。旧实现对 pop 内部滚动直接 return，导致
      //   「离菜单底边最近的边缘强度」在滚动后显隐不实时（用户实测）。
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) {
        // 按帧合并：scroll 触发频率高，逐次重算会白跑 DOM 测量
        if (popScrollRaf) return;
        const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
        if (!schedule) {
          occlusionRunRef.current?.();
          return;
        }
        popScrollRaf = schedule(() => {
          popScrollRaf = 0;
          occlusionRunRef.current?.();
        });
        return;
      }
      if (Date.now() - openAtRef.current < 200) return;
      reposition();
      // 面板滚动 → 头部位置变了 → pos 变化会触发 effect 重算；
      // 但位移不足 1px 时 reposition 会去重（返回同一引用），故这里直接补一次遮挡重算，
      // 避免「面板轻微滚动后遮挡状态停留在旧值」。
      occlusionRunRef.current?.();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('scroll', onScroll, true);
      if (popScrollRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(popScrollRaf);
      }
    };
  }, [open, reposition]);

  useEffect(() => {
    if (open) reposition();
  }, [open, reposition, value, options, groups]);

  // ⛔ 这里**曾经**有一段「量实测高度再校正 top」的 useLayoutEffect（2026-10-23 上午版）。
  //    已删除，原因是它在 UXP 下会收敛到错误的固定点：getBoundingClientRect 返回的是
  //    上一帧（行盒未取整）的高度，两次迭代都读到同一个旧值就判定「稳定」⇒ 菜单浮空 45px；
  //    而 auto 高度按小数行盒算出来又比实际内容矮几像素 ⇒ 原生滚动条 + 首行被裁。
  //    现在 top 与 height 全部由 popOverlay 的整数常量算出（见 reposition），
  //    前后两帧必然一致，不需要也没法「校正」。

  // UXP 限制：可编辑控件（滑块旁的 number 输入等）无视 z-index 永远画在最上层。
  // 弹层渲染出来后按实际矩形，只把与弹层相交的那些临时隐藏，关闭时还原。
  // 用「会话」管理：定位变化（滚动/重排）时 update 重算，不再相交的立即还原。
  //
  // ⚠️ 依赖里必须含 optionsSignature（2026-10-06 修正，实时性缺陷）：
  //   展开状态下用户增删图层时，选项数组变了 ⇒ 菜单高度变了 ⇒ 遮挡集合也应随之变化。
  //   但 reposition() 对 pos 做了 <1px 的去抖（头部位置几乎不动），**pos 引用不变**，
  //   若依赖只有 [open, pos]，本 effect 根本不会重跑 ⇒ 数字框的显隐停留在展开那一刻，
  //   必须折叠再展开才刷新（用户实测症状）。
  //   改成签名后：选项内容/数量一变就重算，遮挡与菜单实际覆盖范围实时一致。
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const session = createOcclusionSession();
    const root = getPopRoot(headRef.current);
    const run = () => {
      const pop = popRef.current;
      if (!pop) return;
      // 判定矩形完全由 pos 推出（pos.top 是算出来的整数，pos.h = min(内容高, max-height)
      // = 屏幕上真实可见的那块），**不再读弹层实测矩形**：UXP 的 fixed 弹层在首帧经常
      // 返回 0 尺寸或错乱坐标，读它是历史上多起「数字浮在菜单上」/「菜单浮空」的根源。
      const rect = {
        left: pos.left,
        top: pos.top,
        right: pos.left + pos.width,
        bottom: pos.top + pos.h,
      };
      session.update(pop, root, rect);
    };
    run();
    // 暴露给滚动回调：菜单自身滚动时也要能即时重算遮挡（见 onScroll 注释）
    occlusionRunRef.current = run;
    // UXP 偶发在插入 DOM 当帧拿不到弹层尺寸，下一帧再补一次，避免漏隐藏
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : 0;
    // 选项变化后 UXP 的布局可能滞后一帧再稳定，补第二拍确保高度已更新
    const raf2 = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => requestAnimationFrame(run))
      : 0;
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (raf2) cancelAnimationFrame(raf2);
      occlusionRunRef.current = null;
      session.restore();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos, optionsSignature, dividerCount]);

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
        className={o.value === value ? 'select-opt-sel' : o.disabled ? 'select-opt-dis' : 'select-opt'}
        style={o.depth != null ? { paddingLeft: 8 + o.depth * 16 } : undefined}
        onClick={() => handleOptClick(o)}
      >
        <span className="select-opt-main">{o.label}</span>
        {o.tag && <span className="select-opt-tag">{o.tag}</span>}
        {/* 选中项右侧对勾：仅在该项没有右侧标记（笔刷图标 / 图层标记）时显示，
            与蒙版同步下拉的样式一致。勾的颜色继承 .select-opt-sel 的白色前景，落在主色（蓝）背景上。 */}
        {showCheck && !o.tag && o.value === value && (
          <span className="select-check">
            <svg viewBox="0 0 36 36" width="12" height="12" aria-hidden="true" focusable="false">
              <path d="M9 16.4L14.6 22.1L27.4 9.6L29.4 11.6L14.6 26.3L9 20.4Z" fill="currentColor" />
            </svg>
          </span>
        )}
      </div>
    ));

  return (
    <div className="select-wrap" title={title} style={style}>
      <div
        ref={headRef}
        className={disabled ? 'select-head-disabled' : open ? 'select-head-open' : 'select-head'}
        onClick={handleHeadClick}
      >
        <span className="select-value">
          {sel ? sel.label : placeholder}
        </span>
        {sel?.tag && <span className="select-opt-tag">{sel.tag}</span>}
        <span className="select-caret">
          <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M4,7.01a1,1,0,0,1,1.7055-.7055l3.289,3.286,3.289-3.286a1,1,0,0,1,1.437,1.3865l-.0245.0245L9.7,11.7075a1,1,0,0,1-1.4125,0L4.293,7.716A.9945.9945,0,0,1,4,7.01Z" fill="currentColor" />
          </svg>
        </span>
      </div>
      {open && pos && popRoot && !disabled && createPortal(
        <div
          ref={popRef}
          className="select-pop"
          style={{
            left: pos.left,
            top: pos.top,
            width: pos.width,
            // 高度/滚动：**一律**写死成算出来的整数（= min(内容高, max-height)）——
            // ① UXP 的 height:auto 按小数行盒算（21.4px/行），比内容矮几像素 ⇒ 滚动条+首行被裁；
            // ② 交给 overflow-y:auto 时 UXP 还会画出 16px 原生滚动条，短菜单上非常显眼。
            // 装得下就 hidden（高度=内容高，滚动容器纯属多余），只有超长列表才 auto。
            height: pos.h,
            overflowY: pos.h < pos.contentH ? 'auto' : 'hidden',
          }}
        >
          {groups ? (
            groups.map((g, gi) => (
              <React.Fragment key={gi}>
                {gi > 0 && <div className="select-divider" />}
                {renderOpts(g)}
              </React.Fragment>
            ))
          ) : allOptions.length === 0 ? (
            <div className="select-opt-dis">无可用选项</div>
          ) : (
            renderOpts(allOptions)
          )}
        </div>,
        popRoot
      )}
    </div>
  );
}

/**
 * ⚠️ 性能（2026-10-06）：用 React.memo 包一层。
 *
 * 面板的分区内容（AdjustmentPanel / app.tsx）都是「一个大组件返回全部 JSX」，
 * 折叠任一分区都会让**所有**已展开分区重渲染，其中包含若干图层下拉。
 * 图层下拉的 options 有数百项，重渲染一次的成本并不低。
 * memo 让「选项数组引用未变」的下拉整体跳过重渲染。
 *
 * ⚠️ 依赖此优化的前提：**调用方传入的 options 必须是 memo 化的稳定引用**。
 * 若调用方写 `options={rawArray.map(...)}`（每次新建数组），memo 会因引用
 * 变化而失效（不会更差，但也没有收益）。调用方请配合 useMemo。
 */
export default React.memo(Select);
