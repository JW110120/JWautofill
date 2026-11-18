/**
 * 数字输入框的滚轮步长修正（2026-11-17，第 2 版）
 *
 * ── 现象（用户报，两次）────────────────────────────────────────────────────
 *   PS 27.8 之前的 UXP：`<input type="number">` 上的滚轮**写死 0.1**，
 *   无视 `step`、无视 `min`（羽化能滚成 -0.3）。
 *   第 1 版只在 `document` 上挂了一个 `wheel` 拦它 —— 真机无效：
 *   值仍按 0.1 变、仍能越界。说明 UXP 的滚轮改值是**原生控件内部行为**，
 *   `preventDefault()` 拦不住，甚至 `wheel` 派发的字段也可能拿不到方向。
 *
 * ── 策略：三层，任何一层生效都能纠正 ──────────────────────────────────────
 *   ① `wheel`（document + 元素级双绑）：能拿到方向就自己 ±step 并 clamp，
 *      顺手记下「滚轮窗口」时间戳（供 ② 用）。
 *   ② `input`（滚轮窗口内 150ms）：原生已经把值改成 0.1 的倍数，
 *      这里按「上一次合法值 ± step」纠正回来 —— **不依赖方向字段**，
 *      方向由「新值 vs 上次合法值」推出来。
 *   ③ `input`（无滚轮窗口时）：差值恰为 ±0.1 且 step≠0.1 ⇒ 判为原生滚轮，
 *      同样按 ±step 纠正。这一层治的是「连 wheel 事件都收不到」的环境。
 *
 *   ⛔ 必须保住「用户手动键入」：键入不产生 0.1 差值（逐字符输入是 3→3.→3.3），
 *      只有 ③ 可能误判「从 3.2 改成 3.3」这种极小概率动作。
 *   ⛔ 写回值走「原生 value setter + input 事件」：React 的 valueTracker 只认
 *      原生 setter，直接赋值 el.value 会被当成「值没变」。
 *   ⛔ 自己写回时会再触发 input，必须用 `ourWrite` 标记跳过，否则无限递归。
 */

type AnyEl = any;

/** 每个输入框「最后一次合法值」（写回过的、或用户正常编辑过的）。 */
const lastGood = new WeakMap<object, number>();
/** 滚轮窗口：最后一次 wheel 的时刻（ms）。窗口内的 input 事件按滚轮处理。 */
let wheelUntil = 0;
/** 自己写回时打的标记，避免 input 递归。 */
let ourWriteAt = 0;
let ourWriteEl: AnyEl = null;
let ourWriteVal = NaN;
/** 键盘输入窗口：最近 500ms 内有按键 ⇒ 这次 input 是键入，绝不纠正。 */
let typingUntil = 0;

const EPS = 1e-6;

function isNumInput(el: AnyEl): boolean {
    if (!el) return false;
    const tag = el.tagName ? String(el.tagName).toUpperCase() : '';
    if (tag !== 'INPUT') return false;
    const t = (el.getAttribute && el.getAttribute('type')) || el.type || '';
    return String(t).toLowerCase() === 'number';
}

function numOf(el: AnyEl): number {
    const v = Number(el.value);
    return isFinite(v) ? v : 0;
}

function stepOf(el: AnyEl): number {
    const raw = (el.getAttribute && el.getAttribute('step')) ?? el.step;
    const s = Math.abs(Number(raw));
    return isFinite(s) && s > 0 ? s : 1;
}

function boundOf(el: AnyEl, name: 'min' | 'max'): number {
    const raw = (el.getAttribute && el.getAttribute(name)) ?? el[name];
    if (raw === '' || raw === null || raw === undefined) return name === 'min' ? -Infinity : Infinity;
    const v = Number(raw);
    return isFinite(v) ? v : (name === 'min' ? -Infinity : Infinity);
}

function decimalsOf(n: number): number {
    const s = String(n);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
}

/** 从 base 按 dir(±1) 走一格 step，并夹在 [min,max] 内。 */
function stepped(el: AnyEl, base: number, dir: number): number {
    const step = stepOf(el);
    const min = boundOf(el, 'min');
    const max = boundOf(el, 'max');
    const d = Math.max(decimalsOf(step), decimalsOf(base));
    let next = Number((base + dir * step).toFixed(Math.min(d + 2, 6)));
    if (next < min) next = min;
    if (next > max) next = max;
    return next;
}

function writeValue(el: AnyEl, next: number): void {
    const text = String(next);
    ourWriteAt = Date.now();
    ourWriteEl = el;
    ourWriteVal = next;
    try {
        const proto = (globalThis as AnyEl).HTMLInputElement
            && (globalThis as AnyEl).HTMLInputElement.prototype;
        const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && typeof desc.set === 'function') desc.set.call(el, text);
        else el.value = text;
    } catch {
        el.value = text;
    }
    lastGood.set(el, next);
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* ignore */ }
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch { /* ignore */ }
}

/** 从滚轮事件里取方向：-1 = 减小（滚轮向下），+1 = 增大，0 = 无法判断。 */
function wheelDir(e: AnyEl): number {
    const candidates = [e.deltaY, e.wheelDelta, e.detail];
    for (const c of candidates) {
        if (typeof c === 'number' && c !== 0) return c > 0 ? -1 : 1;
    }
    return 0;   // 取不到方向 ⇒ 交给 ② 按差值推
}

/** 键按下 ⇒ 开键入窗口（供 onInput 让路）：手输的值一律不许被纠正。 */
function onKey(): void {
    typingUntil = Date.now() + 500;
}

/** ① 滚轮：能判方向就自己改；判不出也记窗口，交给 ② 纠正。 */function onWheel(e: AnyEl): void {
    const el: AnyEl = e && e.target;
    if (!isNumInput(el)) return;
    if (el.disabled || el.readOnly) return;

    // ⛔ 无论能否改值都先挡：UXP 拦不住也不吃亏；能拦住就少一次纠正。
    try { e.preventDefault(); } catch { /* ignore */ }
    try { e.stopPropagation(); } catch { /* ignore */ }

    wheelUntil = Date.now() + 150;
    const cur = numOf(el);
    if (!lastGood.has(el)) lastGood.set(el, cur);

    const dir = wheelDir(e);
    if (!dir) return;                 // 方向未知 ⇒ 由 ② 按差值纠

    const base = lastGood.get(el) ?? cur;
    const next = stepped(el, base, dir);
    if (Math.abs(next - base) > EPS) writeValue(el, next);
}

/** ②③ input：把原生滚轮造成的 0.1 变化纠正为 ±step，并夹紧到 [min,max]。 */
function onInput(e: AnyEl): void {
    const el: AnyEl = e && e.target;
    if (!isNumInput(el)) return;

    const now = Date.now();
    const cur0 = numOf(el);
    // 自己刚写进去的：只更新基线，别再纠正。
    // ⛔ 必须连值一起比：原生若在我们写回后 60ms 内又改了 0.1，值就不等于
    //    `ourWriteVal`，要照常纠正（只按时间窗跳过会把它当成「自己写的」而漏掉）。
    if (ourWriteEl === el && now - ourWriteAt < 200
        && Math.abs(cur0 - ourWriteVal) <= EPS) {
        lastGood.set(el, cur0);
        return;
    }
    // 键盘刚按过 ⇒ 这是键入，不是滚轮；滚轮纠正一律让路（否则「手输 3.3」会被改成 3.5）
    if (now <= typingUntil) { lastGood.set(el, cur0); return; }

    const cur = cur0;
    const last = lastGood.get(el);
    if (last === undefined) { lastGood.set(el, cur); return; }
    if (Math.abs(cur - last) <= EPS) return;

    const inWheelWindow = now <= wheelUntil;
    const delta = cur - last;
    const step = stepOf(el);
    // ③ 无滚轮窗口时，只认「恰好 0.1」这个原生特征，别碰正常键入
    const looksLikeNativeWheel = !inWheelWindow
        && Math.abs(Math.abs(delta) - 0.1) < 1e-6
        && Math.abs(step - 0.1) > 1e-6;

    if (!inWheelWindow && !looksLikeNativeWheel) {
        lastGood.set(el, cur);        // 正常键入 ⇒ 接受并更新基线
        return;
    }

    const dir = delta > 0 ? 1 : -1;
    const next = stepped(el, last, dir);
    if (Math.abs(next - cur) > EPS) writeValue(el, next);
    else lastGood.set(el, next);
}

let installed = false;

/**
 * 安装全局接管（幂等；由 index.tsx 在首次渲染前调用一次）。
 * @returns 卸载函数
 */
export function installNumberInputWheel(): () => void {
    if (installed) return () => { /* 已装 */ };
    const doc: AnyEl = (globalThis as AnyEl).document;
    if (!doc || typeof doc.addEventListener !== 'function') return () => { /* 环境不支持 */ };

    const opts: AnyEl = { capture: true, passive: false };
    const listened: Array<[string, AnyEl, AnyEl]> = [];

    const bind = (target: AnyEl, type: string, fn: AnyEl) => {
        if (!target || typeof target.addEventListener !== 'function') return;
        try {
            target.addEventListener(type, fn, opts);
            listened.push([type, target, fn]);
        } catch {
            try {
                target.addEventListener(type, fn, true);
                listened.push([type, target, fn]);
            } catch { /* 该目标不支持事件 */ }
        }
    };

    bind(doc, 'wheel', onWheel);
    bind(doc, 'input', onInput);
    bind(doc, 'keydown', onKey);
    const win: AnyEl = (globalThis as AnyEl).window;
    if (win && win !== doc) bind(win, 'wheel', onWheel);

    /* ④ 元素级兜底：UXP 里 `wheel` 有可能不冒泡到 document（第 1 版就是这样失效的）。
       用 MutationObserver 给每个 number 输入框直接挂一份；节点增删自动跟上。 */
    const attached = new WeakSet<object>();
    const attachOne = (el: AnyEl) => {
        if (!el || attached.has(el) || !isNumInput(el)) return;
        attached.add(el);
        try { el.addEventListener('wheel', onWheel, { capture: true, passive: false }); }
        catch {
            try { el.addEventListener('wheel', onWheel, true); } catch { /* ignore */ }
        }
    };
    const scan = (root: AnyEl) => {
        if (!root || !root.querySelectorAll) return;
        try {
            const list = root.querySelectorAll('input');
            for (let i = 0; i < list.length; i++) attachOne(list[i]);
        } catch { /* ignore */ }
    };
    scan(doc);
    try {
        const MO = (globalThis as AnyEl).MutationObserver;
        if (MO) {
            const mo = new MO((records: AnyEl[]) => {
                for (const r of records) {
                    if (!r.addedNodes) continue;
                    for (let i = 0; i < r.addedNodes.length; i++) {
                        const n = r.addedNodes[i];
                        attachOne(n);
                        scan(n);
                    }
                }
            });
            mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
        }
    } catch { /* ignore */ }

    installed = true;

    return () => {
        for (const [type, target, fn] of listened) {
            try { target.removeEventListener(type, fn, true); } catch { /* ignore */ }
        }
        listened.length = 0;
        installed = false;
    };
}
