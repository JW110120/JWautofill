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
 *       .gradient-picker input[type="number"] { visibility: visible ... }
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
 * ⚠️ UXP 已知坑：原生 number / text 输入控件（尤其次级面板 .gradient-picker 这类
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
    const measuredH = measured && measured.height >= 24 ? measured.height : 0;
    const measuredW = measured && measured.width > 0 ? measured.width : 0;

    // 原点（X/Y）与宽度：优先用 fallbackRect（=pos，可靠）；measured 不可信时降级。
    const baseLeft = fallbackRect ? fallbackRect.left : (measured ? measured.left : 0);
    const baseTop = fallbackRect ? fallbackRect.top : (measured ? measured.top : 0);
    const w = measuredW || (fallbackRect ? fallbackRect.right - fallbackRect.left : 0);

    // 高度取「实测高度」与「兜底高度」的较大值：实测往往偏短（UXP 偶发只量到部分
    // 选项），兜底高度（来自 pos + 充裕估算）保证盖住头部正下方那一列的文本控件
    // （UXP 下文本控件无视 z-index 永远画在最上层，头部正下方的 number 会透过菜单
    // 显示出来，必须纳入遮挡带）。
    const fallbackH = fallbackRect ? fallbackRect.bottom - fallbackRect.top : 0;
    const h = Math.max(measuredH, fallbackH);
    if (w <= 0 || h <= 0) return;

    const popRect: Rect = {
      left: baseLeft,
      top: baseTop,
      right: baseLeft + w,
      bottom: baseTop + h,
    };

    // 对判定矩形做小幅外扩，避免「菜单边缘刚好压在数字框 1~2px 上」时被判定为不相交。
    const PAD = 8;
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
 * 弹层内联样式：尽最大可能抬升渲染层级。
 * 说明：对「可编辑控件」无效（见文件头注释），但对滑块 thumb、sticky 面板等
 * 普通 DOM 有效；translateZ(0) 额外强制生成独立合成层。
 */
export const POP_LAYER_STYLE: React.CSSProperties = {
  zIndex: 99998,
  transform: 'translateZ(0)',
  willChange: 'transform',
};

/**
 * 兜底矩形：UXP 偶发在刚插入 DOM 时 getBoundingClientRect 返回 0 尺寸，
 * 此时用「已知定位 + 估算高度」代替，保证遮挡判断不至于整体失效。
 */
export function estimatePopRect(
  pos: { left: number; top: number; width: number },
  optionCount: number
): Rect {
  // 高度给足：UXP 里 getBoundingClientRect 经常取不到真实高度，此时只能靠兜底。
  // 下限 90px 足以覆盖「下拉头部 → 正下方数字框」的常见下间距（如渐变「样式」下拉
  // 与「角度」输入框）；上限仍为 CSS 的 max-height(200)。
  const h = Math.min(200, Math.max(90, optionCount * 24 + 12));
  return { left: pos.left, top: pos.top, right: pos.left + pos.width, bottom: pos.top + h };
}
