/**
 * panelTooltip —— 面板自绘 tooltip（PS 2027 / 28.0 兼容补丁）
 * ==================================================================
 *
 * 症状（用户 2026-11-16 报）：升级到 PS 28.0（2027）后，在画布上画画时会
 *   「异常显示出光标悬停在某个元素上时的那条 helptext」，而且会挂在那里不消失。
 *
 * 根因（本补丁的前提）：本插件所有提示文字都走 **HTML 原生 `title` 属性**
 *   （287 处，文案集中在 src/constants/helpTexts.ts）。UXP 把 `title` 渲染成
 *   **宿主实现的独立提示窗**（不是我们 DOM 里的一层），这块窗由 UXP 自己负责
 *   「指针离开就关掉」。PS 28 换上新的 UXP 运行时后，这套悬停/关闭时序在
 *   「指针从面板移到画布」时不可靠：提示窗没被回收，就停在屏幕最上层，
 *   于是用户看到的是「一条本该跟着悬停出现的 helptext 赖在画布上」。
 *   ⛔ 我们既拿不到那块窗的句柄，也没有「关闭 tooltip」的 UXP API ⇒
 *      **只能从源头不让它创建**。
 *
 * 做法：把 `title` 换成**面板内自绘**的一层（.panel-tip）。
 *   · 指针进入任意带 `title` 的元素时，先把该属性**摘掉**（文案存进 WeakMap），
 *     原生提示窗因此永远不会被创建 —— 连第一次都不会；
 *   · 同时用我们自己的 div 显示同样文案：它活在面板窗口的 DOM 里，
 *     **物理上不可能浮到画布上**（面板窗口就那么大），最坏情况也只是在面板里多留一瞬；
 *   · 指针离开 / 按下 / 滚轮 / 按键 / 面板失焦 / 8 秒超时 ⇒ 一律收起
 *     （多重保险：哪怕某个事件在 UXP 里没派发，也不会形成「挂住」）。
 *
 * 为什么不用「全局 CSS 去掉 title」或逐个改 TSX：
 *   · 287 处调用点、且 React 重渲染会不断把 title 写回来 ⇒ 只能运行时拦截；
 *   · 拦截放在 document 的 pointerover 捕获阶段，一处覆盖全仓（三个面板同一 document）。
 *
 * ⛔ 三个面板（#app / #pixeladjustment / #brushstudio）共用同一个 document，
 *    本模块**只安装一次**（installPanelTooltips 自带幂等保护）。
 * ⛔ 不要试图在 pointerout 里把 title 装回去：装回去 = 原生提示窗又回来。
 *    文案留在 stash 里，后续 hover 直接从 stash 取。
 */

/** 悬停多久才显示（与系统 tooltip 的观感对齐；太短会在扫过行列表时乱闪）。 */
const HOVER_DELAY_MS = 260;
/** 兜底：无论如何最多显示这么久（防「某个事件没派发」导致挂住）。 */
const MAX_VISIBLE_MS = 8000;
/** 距窗口边缘的最小留白。 */
const CLAMP_PX = 6;

type AnyEl = any;

let tipEl: AnyEl = null;
let showTimer: any = null;
let hideTimer: any = null;
let curEl: AnyEl = null;
let installed = false;

/** 元素 → 被摘下来的 title 文案（React 重渲染写回新 title 时会覆盖成同一份文字）。 */
const stash: WeakMap<AnyEl, string> = new WeakMap();

function clearTimers() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function ensureTip(): AnyEl {
  if (tipEl) return tipEl;
  const el = document.createElement('div');
  el.className = 'panel-tip';
  el.setAttribute('role', 'presentation');
  // ⛔ 必须不吃事件：否则提示层会截走底下控件的 hover/click（UXP 里 pointer-events
  //    在 createElement 出来的 div 上生效，但写法仍显式落到 CSS 类里，见 common.css）。
  (document.body || document.documentElement).appendChild(el);
  tipEl = el;
  return el;
}

/** 收起提示（隐藏而非卸载：面板里反复 hover，重建节点会抖）。 */
export function hidePanelTip() {
  clearTimers();
  curEl = null;
  if (tipEl) tipEl.style.display = 'none';
}

/** 从事件目标向上找「带 title / 曾经带 title」的元素（最多 6 层，够覆盖行内 span）。 */
function findTitled(target: AnyEl): AnyEl {
  let el = target;
  for (let i = 0; i < 6 && el && el.nodeType === 1; i++) {
    if (stash.has(el)) return el;
    if (el.getAttribute && el.getAttribute('title')) return el;
    el = el.parentElement;
  }
  return null;
}

/** 取文案并把 title 摘掉（摘掉 = 原生提示窗永远不会被创建）。 */
function takeText(el: AnyEl): string {
  let text = stash.get(el) || '';
  if (el.getAttribute) {
    const attr = el.getAttribute('title');
    if (attr) {
      text = attr;
      stash.set(el, attr);
      // ⚠️ 必须 removeAttribute 而不是置空串：UXP 对 title="" 是否创建提示窗不确定，
      //    摘掉属性才是确定的「没有提示」。
      el.removeAttribute('title');
    }
  }
  return text || '';
}

function place(el: AnyEl) {
  const tip = tipEl;
  if (!tip) return;
  let r: any;
  try { r = el.getBoundingClientRect(); } catch (_) { return; }
  const vw = (window as any).innerWidth || 300;
  const vh = (window as any).innerHeight || 400;
  const tw = tip.offsetWidth || 0;
  const th = tip.offsetHeight || 0;

  // 默认贴元素左下；右/下溢出就翻到另一侧，再不行就贴边框内侧。
  let left = r.left + 2;
  if (left + tw > vw - CLAMP_PX) left = vw - tw - CLAMP_PX;
  if (left < CLAMP_PX) left = CLAMP_PX;

  let top = r.bottom + 6;
  if (top + th > vh - CLAMP_PX) {
    const above = r.top - th - 6;
    top = above >= CLAMP_PX ? above : Math.max(CLAMP_PX, vh - th - CLAMP_PX);
  }
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}

function showTip(el: AnyEl, text: string) {
  const tip = ensureTip();
  // ⛔ 用 textContent（文案里带 \n 的是分段说明，CSS 用 white-space: pre-line 还原）
  tip.textContent = text;
  tip.style.display = 'block';
  place(el);
  hideTimer = setTimeout(() => { hidePanelTip(); }, MAX_VISIBLE_MS);
}

function onPointerOver(ev: AnyEl) {
  const el = findTitled(ev.target);
  if (!el) return;
  /* ⛔ 只在「同元素且已经显示出来」时提前返回：Chromium 里 pointerover 与 mouseover
     都会派发（两者都必须绑，见 installPanelTooltips），不去重会把计时期重置两次。
     但**不能**只看 `el === curEl`：万一 UXP 漏派 pointerout（正是要修的那类毛病），
     curEl 会卡住，再回到同一元素就永远不出提示了 —— 以「是否正在显示」为判据，
     两种情况都对。 */
  if (el === curEl && tipEl && tipEl.style.display === 'block') return;
  const text = takeText(el);
  if (!text) return;
  clearTimers();
  curEl = el;
  if (tipEl) tipEl.style.display = 'none';   // 换目标：先收起旧的一瞬，避免停在旧位置
  showTimer = setTimeout(() => {
    // 计时到点时指针可能已经移到别处：再看一眼当前目标
    if (curEl === el) showTip(el, text);
  }, HOVER_DELAY_MS);
}

function onPointerOut(ev: AnyEl) {
  if (!curEl) return;
  const to = ev && ev.relatedTarget;
  if (to && curEl.contains && curEl.contains(to)) return;   // 还在同一元素内部
  hidePanelTip();
}

/**
 * 安装补丁。幂等：三个面板共用同一个 document，只装一次。
 * ⛔ 用**捕获阶段**监听 pointerover：React 的合成事件不阻止冒泡也能命中，
 *    且行内元素（span/div）都走同一条路。
 * ⚠️ pointer* 与 mouse* **两条都绑**（同一个 handler）：UXP 各版本对 pointer 事件的
 *    支持并不一致，`SmoothBridge` 的面板 hover 心跳也是这么兜底的 —— 只绑 pointer
 *    时若某个版本不派发，全部提示会一起消失（比原来的 bug 更糟）。重复触发由
 *    handler 里的 `el === curEl` 去重。
 */
export function installPanelTooltips(): void {
  if (installed) return;
  if (typeof document === 'undefined' || !document.addEventListener) return;
  installed = true;

  const on = (name: string, fn: (ev: AnyEl) => void, opts: any) => {
    try { document.addEventListener(name, fn as any, opts); } catch (_) { /* UXP 可能不支持某类事件 */ }
  };
  on('pointerover', onPointerOver, true);
  on('mouseover', onPointerOver, true);
  on('pointerout', onPointerOut, true);
  on('mouseout', onPointerOut, true);
  // 「一定收起」的多重保险：任何一次真实操作都先把提示清掉
  const hide = () => hidePanelTip();
  on('pointerdown', hide, true);
  on('mousedown', hide, true);
  on('wheel', hide, { capture: true, passive: true });
  on('keydown', hide, true);
  on('scroll', hide, { capture: true, passive: true });
  try {
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', hide);
  } catch (_) { /* UXP 极端情况下可能没有这些事件，忽略 */ }
}
