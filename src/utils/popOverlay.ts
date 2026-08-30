/**
 * 弹层遮挡「文本类控件」的处理（UXP 官方已知限制）。
 *
 * Adobe 官方 Known Issues 原文：
 *   “While z-index is supported, no element can overlay a widget that has text
 *    editing capabilities. Text fields and areas will always render the text
 *    editor above everything else in the same panel or dialog.”
 * 即：input[type=number] / textarea / sp-textfield 这类可编辑控件**无视 z-index**，
 * 永远画在同一面板内的最上层。内联样式、!important、transform 提层、portal
 * 换挂载点都无效——这是 UXP 渲染层的硬限制，不是层叠上下文问题。
 *
 * 官方给出的两条出路：① 用 popover 承载内容；② 隐藏被盖住的控件。
 * 本文件采用方案②的**精确版**：弹层打开并测量出自身矩形后，只把「真正与弹层矩形
 * 相交」的文本控件临时置为 visibility:hidden（保留占位、不触发重排、不改布局），
 * 关闭时逐个还原。
 *
 * 相比早期「打开下拉就隐藏面板内所有 number 输入」的粗暴做法：被隐藏的正是那些
 * 本来就被弹层完全遮住、用户根本看不见的输入框，因此不会出现「一堆数字凭空消失」
 * 的诡异观感。
 */

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

function intersects(a: DOMRect | ClientRect, b: DOMRect | ClientRect): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

/**
 * 隐藏与 popEl 矩形相交的所有可编辑控件。
 * @param popEl 弹层元素（已渲染、可测量）
 * @param root  查找范围（面板根容器，如 #app / #pixeladjustment）
 * @returns 还原函数，弹层关闭时调用
 */
export function hideOccludedTextFields(popEl: HTMLElement, root: HTMLElement | null): () => void {
  if (!root) return () => {};
  const popRect = popEl.getBoundingClientRect();
  const touched: Array<{ el: HTMLElement; prevVisibility: string; prevPointerEvents: string }> = [];

  let list: NodeListOf<Element>;
  try {
    list = root.querySelectorAll('input, textarea, sp-textfield, [contenteditable]');
  } catch {
    return () => {};
  }

  for (let i = 0; i < list.length; i++) {
    const el = list[i] as HTMLElement;
    if (!isTextEditingWidget(el)) continue;
    if (popEl.contains(el)) continue;
    // 正在输入的控件不隐藏，避免打断输入焦点
    if (document.activeElement === el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (!intersects(popRect, r)) continue;
    touched.push({
      el,
      prevVisibility: el.style.visibility,
      prevPointerEvents: el.style.pointerEvents,
    });
  }

  for (const t of touched) {
    t.el.style.visibility = 'hidden';
    t.el.style.pointerEvents = 'none';
  }

  return () => {
    for (const t of touched) {
      t.el.style.visibility = t.prevVisibility;
      t.el.style.pointerEvents = t.prevPointerEvents;
    }
  };
}

/**
 * 弹层内联样式：尽最大可能抬升渲染层级。
 * 说明：对「可编辑控件」无效（见文件头注释），但对滑块 thumb、sticky 面板、
 * 滚动条之外的普通 DOM 有效；translateZ(0) 额外强制生成独立合成层。
 */
export const POP_LAYER_STYLE: React.CSSProperties = {
  zIndex: 99998,
  transform: 'translateZ(0)',
  willChange: 'transform',
};
