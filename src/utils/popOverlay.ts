/**
 * 弹层遮挡「文本类控件」的处理（UXP 官方已知限制）。
 *
 * Adobe 官方 Known Issues 原文：
 *   “While z-index is supported, no element can overlay a widget that has text
 *    editing capabilities. Text fields and areas will always render the text
 *    editor above everything else in the same panel or dialog.”
 * 即：input[type=number] / textarea / sp-textfield 这类可编辑控件**无视 z-index**，
 * 永远画在同一面板内的最上层。内联样式、transform 提层、portal 换挂载点都不解决
 * 这个穿透——这是 UXP 渲染层的硬限制，不是层叠上下文问题。
 *
 * 官方给出的两条出路：① 用 popover 承载内容；② 隐藏被盖住的控件。
 * 本文件采用方案②的**精确版**：弹层打开并测量出自身矩形后，只把「真正与弹层矩形
 * 相交」的文本控件临时置为 visibility:hidden + opacity:0（保留占位、不触发重排），
 * 关闭时逐个还原。
 *
 * ⚠️ 关键实现细节（踩过的坑）：
 *  1. 必须用 setProperty(prop, val, 'important') 写**带 !important 的内联样式**，
 *     以便压过任何“普通声明”的样式表规则。
 *  2. ⚠️ 与之配套：src/styles/input-fix.css 里那条
 *       .subpanel-fill input[type="number"] { visibility: visible ... }
 *     次级面板输入框“确保可见”的规则**绝不可加 !important**。UXP 的 CSS 引擎在
 *     important 级会把「样式表 !important」判在「内联 !important」之上（与标准
 *     层叠相反），一旦它带 !important，本遮挡逻辑的内联 visibility:hidden !important
 *     就赢不了，表现就是「代码跑了但数字还浮在弹层上面」。保持普通声明后，内联
 *     important 正常胜出，遮挡生效且不引起布局位移（visibility 保留占位）。
 *  3. visibility 与 opacity 一起写：UXP Drover 下部分原生控件只吃 opacity。
 *  3. 用「会话」而非一次性隐藏：弹层滚动/重定位后矩形会变，需要 update() 重算，
 *     把不再相交的还原、新相交的隐藏，避免残留隐藏状态。
 */

type CssProp = 'visibility' | 'opacity' | 'pointer-events';

interface StyleSnapshot {
  el: HTMLElement;
  visibility: string;
  visibilityPrio: string;
  opacity: string;
  opacityPrio: string;
  pointerEvents: string;
  pointerEventsPrio: string;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const TEXTISH_INPUT_TYPES = new Set([
  'text',
  'number',
  'search',
  'email',
  'password',
  'tel',
  'url',
  '', // input 未指定 type 时默认为 text
]);

const WIDGET_SELECTOR = 'input, textarea, sp-textfield, [contenteditable]';

function isTextEditingWidget(el: Element): boolean {
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'sp-textfield') return true;
  if (el.hasAttribute && el.hasAttribute('contenteditable')) {
    // contenteditable="false" 不算可编辑
    if (el.getAttribute('contenteditable') !== 'false') return true;
  }
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return TEXTISH_INPUT_TYPES.has(type);
  }
  return false;
}

function intersects(a: Rect, b: Rect): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

/**
 * 取一个元素在视口中的有效矩形。
 *
 * ⚠️ UXP 已知坑：原生 number / text 输入控件（尤其次级面板 .subpanel-fill 这类
 * z-index:9999 的作用域内）对 getBoundingClientRect() 常常返回**尺寸为 0** 的退化矩形
 * （控件本身画得出来、用户也看得到，但 JS 量到 0 宽/高）。旧逻辑一旦量到 0 就直接
 * `continue` 跳过该控件，导致「控件明明压在弹层上、却没被隐藏、数字浮在菜单上」——
 * 这正是渐变「样式」下拉下方角度数字始终盖不住的根因（主面板输入框能正常量到尺寸，
 * 故只有渐变这种次级面板会触发）。
 *
 * 兜底策略：逐级向上取「第一个能取到有效尺寸的矩形」（自身 → 父包裹 div → 更上层
 * 容器）。普通 DOM 容器在 UXP 下通常能返回有效矩形，用它来判定相交即可。
 */
function robustRect(el: HTMLElement): Rect | null {
  let node: HTMLElement | null = el;
  for (let i = 0; i < 4 && node; i++) {
    const b = node.getBoundingClientRect();
    if (b && b.width > 0 && b.height > 0) {
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    node = node.parentElement;
  }
  return null;
}

/** 读取一条内联声明的「值 + 优先级」，用于之后逐字还原（含 !important） */
function readDecl(el: HTMLElement, prop: CssProp): { value: string; prio: string } {
  const s = el.style;
  const value = s.getPropertyValue(prop) || '';
  const prio =
    typeof s.getPropertyPriority === 'function' ? s.getPropertyPriority(prop) || '' : '';
  return { value, prio };
}

function writeDecl(el: HTMLElement, prop: CssProp, value: string, prio: string): void {
  const s = el.style;
  if (value) s.setProperty(prop, value, prio);
  else s.removeProperty(prop);
}

export interface OcclusionSession {
  /**
   * 重新计算并应用遮挡隐藏。
   * @param popEl 弹层元素（已渲染、可测量）
   * @param root  查找范围（面板根容器，如 #app / #pixeladjustment）
   * @param fallbackRect 弹层自身矩形测量失败（UXP 偶发返回 0 尺寸）时的兜底矩形
   */
  update(popEl: HTMLElement | null, root: HTMLElement | null, fallbackRect?: Rect): void;
  /** 还原全部被隐藏过的控件（弹层关闭/卸载时调用） */
  restore(): void;
}

export function createOcclusionSession(): OcclusionSession {
  const snapshots = new Map<HTMLElement, StyleSnapshot>();

  const capture = (el: HTMLElement): StyleSnapshot => {
    const v = readDecl(el, 'visibility');
    const o = readDecl(el, 'opacity');
    const p = readDecl(el, 'pointer-events');
    return {
      el,
      visibility: v.value,
      visibilityPrio: v.prio,
      opacity: o.value,
      opacityPrio: o.prio,
      pointerEvents: p.value,
      pointerEventsPrio: p.prio,
    };
  };

  const restoreOne = (snap: StyleSnapshot): void => {
    writeDecl(snap.el, 'visibility', snap.visibility, snap.visibilityPrio);
    writeDecl(snap.el, 'opacity', snap.opacity, snap.opacityPrio);
    writeDecl(snap.el, 'pointer-events', snap.pointerEvents, snap.pointerEventsPrio);
  };

  const hideOne = (el: HTMLElement): void => {
    // 必须带 'important'：压过任何普通声明的样式表规则。
    // （src/styles/input-fix.css 里次级面板的“确保可见”规则已刻意保持普通声明，
    //  一旦它带 !important，UXP 引擎会把样式表 !important 判在内联 !important 之上。）
    const s = el.style;
    s.setProperty('visibility', 'hidden', 'important');
    s.setProperty('opacity', '0', 'important');
    s.setProperty('pointer-events', 'none', 'important');
  };

  const restore = (): void => {
    snapshots.forEach(snap => restoreOne(snap));
    snapshots.clear();
  };

  const update = (popEl: HTMLElement | null, root: HTMLElement | null, fallbackRect?: Rect): void => {
    if (!popEl || !root) {
      restore();
      return;
    }

    // UXP 硬限制（血泪坑，本轮真凶）：
    //   position:fixed 的 portal 弹层在 useLayoutEffect / requestAnimationFrame 阶段，
    //   getBoundingClientRect() 经常返回**坐标错乱**（top/left 为 0 或远超真实值），
    //   只有 height/width 偶尔可信。但我们**亲手**把弹层的 left/top/width 写成了
    //   pos（下拉头部的 measured rect，含 head.bottom+2 的垂直偏移），所以 pos 才是
    //   唯一可靠的原点。fallbackRect 正是 estimatePopRect(pos,…) —— 它的 X/Y/width
    //   全部来自 pos。因此**必须用 fallbackRect 锚定弹层矩形，绝不能直接信任
    //   measured.top/left**：否则矩形被定位到错误位置，正下方的 number input 永远判
    //   不到「相交」，数字就一直浮在菜单上（短菜单如渐变「样式」下拉尤易触发，因为
    //   它只 2 个选项、矩形又小，坐标稍微错乱就彻底漏检）。
    const measured = popEl.getBoundingClientRect();
    // 阈值 24 只是「量到了没有」的探测下限，不代表真实行高（真实 ≈28，见 estimatePopRect）
    const measuredH = measured && measured.height >= 8 ? measured.height : 0;
    const measuredW = measured && measured.width > 0 ? measured.width : 0;

    // 原点（X/Y）与宽度：优先用 fallbackRect（=pos，可靠）；measured 不可信时降级。
    const baseLeft = fallbackRect ? fallbackRect.left : (measured ? measured.left : 0);
    const baseTop = fallbackRect ? fallbackRect.top : (measured ? measured.top : 0);
    // ⚠️ 宽度同理不可只信实测：UXP 偶发返回 0 宽，叠加 PAD 后横向会漏判
    //（输入框在菜单右侧时尤其明显）。故实测优先、退化时用 pos.width（写入时已知）。
    const w = measuredW || (fallbackRect ? fallbackRect.right - fallbackRect.left : 0);

    // 高度：实测优先，退化时用 estimatePopRect 的兜底估算。
    //
    // ⚠️ 这里**刻意不做上限裁剪**（曾按 CSS max-height:200px 硬裁，导致 7+ 层
    //   明明被挡住却不隐藏 —— 用户实测反推菜单真实高度 ≈218px > 200px）。
    //   也**不再取 max(实测, 兜底)**：兜底已按实测行高 28 校准，取 max 会在
    //   实测偏短的帧里把判定带撑大、误藏刚好在菜单边缘外的输入框。
    //   判据：实测够大就用实测（贴合真实菜单），够小才用估算（宁可略高）。
    const MIN_TRUSTED_H = 8; // 低于此值视为「没量到」，改用兜底
    let h: number;
    if (measuredH >= MIN_TRUSTED_H) {
        h = measuredH;
    } else {
        h = fallbackRect ? fallbackRect.bottom - fallbackRect.top : 0;
    }

    // ⚠️ 不要再按CSS max-height 硬裁到 200px（2026-10-06 二次修正，7+ 层仍不隐藏）。
    //   上一轮我加了 `if (h > 200) h = 200`，本意是「菜单被滚动容器裁掉的部分不算遮挡」，
    //   但实测证明 **UXP 下菜单并没有被 200px 裁掉**：按用户截图反推，7 层（含背景，
    //   8 个选项）时菜单真实高度约 218px > 200px，且确实盖住了边缘强度的数字框。
    //   硬裁到 200 会让判定带比真实菜单短 ≈18px ⇒ 边缘强度恰好落在带外 ⇒ 判为不相交
    //   ⇒ 数字不被隐藏（用户实测：菜单明明挡住输入框，数字却始终显示）。
    //   ⇒ 判定必须以【实测高度】为准，不做上限裁剪；滚动裁剪由浏览器自己负责，
    //   我们只需保证判定带 ⊇ 屏幕上真实存在的菜单区域。
    if (w <= 0 || h <= 0) {
      restore();
      return;
    }

    const popRect: Rect = {
      left: baseLeft,
      top: baseTop,
      right: baseLeft + w,
      bottom: baseTop + h,
    };

    // 对判定矩形做**极小**外扩，仅用于吸收「菜单边缘刚好压在数字框描边上」的亚像素误差。
    // ⚠️ 不可放大（2026-10-06 修正）：PAD 曾为 8px，加上判定矩形本身的过宽，
    // 会把菜单下方明明露在外面的数字框也圈进遮挡带 → 无谓隐藏（Bug 1 的 2/4/6 层现象）。
    // 取 2px 足以覆盖描边级别的误差，又不会多吃掉一整行的可见区域。
    const PAD = 2;
    const testRect: Rect = {
      left: popRect.left - PAD,
      top: popRect.top - PAD,
      right: popRect.right + PAD,
      bottom: popRect.bottom + PAD,
    };

    let list: NodeListOf<Element>;
    try {
      list = root.querySelectorAll(WIDGET_SELECTOR);
    } catch {
      // 同上：退化路径也必须还原，不能把输入框留在隐藏态
      restore();
      return;
    }

    const next = new Set<HTMLElement>();
    for (let i = 0; i < list.length; i++) {
      const el = list[i] as HTMLElement;
      if (!isTextEditingWidget(el)) continue;
      if (popEl.contains(el)) continue;
      // 正在输入的控件不隐藏，避免打断输入焦点
      if (document.activeElement === el) continue;
      const r = robustRect(el);
      if (!r) continue;
      if (!intersects(testRect, r)) {
        continue;
      }
      next.add(el);
    }

    // 不再与弹层相交的：立即还原
    snapshots.forEach((snap, el) => {
      if (!next.has(el)) {
        restoreOne(snap);
        snapshots.delete(el);
      }
    });
    // 新相交的：隐藏（先记录原始内联值，便于精确还原）
    next.forEach(el => {
      if (snapshots.has(el)) return;
      const snap = capture(el);
      hideOne(el);
      snapshots.set(el, snap);
    });
  };

  return { update, restore };
}

/**
 * 兜底矩形：UXP 偶发在刚插入 DOM 时 getBoundingClientRect 返回 0 尺寸，
 * 此时用「已知定位 + 估算高度」代替，保证遮挡判断不至于整体失效。
 *
 * ⚠️ 高度公式（2026-10-06 二次修正）：
 *   · **不按 200px 封顶**。实测（用户截图反推）7 层 / 8 选项时菜单真实高度约 218px，
 *     已超 CSS max-height:200px —— UXP 下该上限并未把菜单裁到 200。
 *     旧兜底再套一层 min(200,…) 会让判定带短于真实菜单 ⇒ 边缘强度的数字框
 *     落在带外判为不相交 ⇒ 明明被挡住却不隐藏（用户实测）。
 *   · **行高按 28 而非 24**：`.select-opt` 是 font-size:12 + padding 4×2，但 UXP
 *     下 12px 文字的实际行盒高于 12（实测 ≈27~28px/行）。沿用 24 会整体低估，
 *     菜单越长低估越多（8 项就差 ≈32px），同样导致末端输入框漏判。
 *   · 保留一点余量（CHROME）覆盖 padding 与描边，宁可略高不可略低：
 *     判定带略高只是多藏一个刚出界的输入框（下一帧即还原），略低则直接穿帮。
 */
export function estimatePopRect(
    pos: { left: number; top: number; width: number },
    optionCount: number
): Rect {
    const ROW_H = 28;   // 实测每选项行高（含 padding 4×2）
    const CHROME = 8;   // .select-pop 上下 padding 2×2 + 描边 1×2 + 余量
    const h = optionCount * ROW_H + CHROME;
    return { left: pos.left, top: pos.top, right: pos.left + pos.width, bottom: pos.top + h };
}
