/**
 * ⛔⛔ 已停用（2026-11-18）：全插件数字框已改为自绘 `src/components/NumField.tsx`
 *   （`type="text"` + 自己接管滚轮/键盘/夹紧），本模块不再被任何入口 import。
 *   保留文件只为留档：这里记录了「UXP 27.8 之前的 `input[type=number]` 滚轮写死 0.1、
 *   无视 step/min/max、`preventDefault` 拦不住」这三个坑的完整推理过程。
 *   ⛔ 以后不要为了「修滚轮」再把它引回来 —— 组件级接管（元素级 `wheel` + `{passive:false}`）
 *      才是能自证有效的做法；事后靠 `input` 差值反推，方向与格数都会被合成序列打乱。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 数字输入框的滚轮步长修正 + 范围夹紧（2026-11-17 第 3 版）
 *
 * ── 现象（用户三次反馈）───────────────────────────────────────────────────
 *   ① PS 27.8 之前的 UXP：`<input type="number">` 上的滚轮**写死 0.1**，
 *      无视 `step`、无视 `min`（羽化能滚成 -0.3、能滚到 50）。
 *   ② 第 2 版之后：**慢慢一格一格滚是对的，一旦快速滚就又回到 0.1**。
 *   ③ 手输能突破 `max`（截图：羽化 max=20，输入框里是 50）。
 *
 * ── ② 的根因（本次修的就是这个）────────────────────────────────────────────
 *   滚轮改值是**原生控件内部行为**，我们只能事后看 `input` 里的差值。
 *   慢滚时一次 `input` 的差值恰好是 ±0.1 ⇒ 命中「原生特征」⇒ 被纠正成 ±step。
 *   快滚时原生一次攒了好几格再派发 `input` ⇒ 差值是 ±0.2 / ±0.3 / …，
 *   旧的「必须**恰好** 0.1」判据不成立 ⇒ **完全不纠正**，值就停在 0.1 网格上；
 *   更糟的是基线（lastGood）被更新成那个 0.1 值 ⇒ 之后连慢滚也被当成「正常」
 *   ⇒ 用户看到的正是「又变成 0.1 开始滚动」。
 *   ⇒ 判据从「恰好 0.1」改成「**0.1 的整数倍**」，倍数 k 就是攒下的格数，
 *     直接换算成 k×step（快滚 5 格就是 5×step，一次到位）。
 *
 * ── ③ 的根因 ─────────────────────────────────────────────────────────────
 *   滚轮路径有夹紧，**键入路径没有**：用户把 50 敲进去，我们没有理由去改它。
 *   ⇒ 新增 `change` / `blur` 两个时机做**范围夹紧**（只夹范围、不动步长，
 *     所以手输 3.3 这种「不在 step 网格上但合法」的值不会被抹平）。
 *
 * ── 分层（任何一层生效都能纠正）──────────────────────────────────────────
 *   ① `wheel`（document + window + 元素级）：能判方向就 ±step 并夹紧，
 *      同时记「滚轮窗口」时间戳（供 ② 判断后续 input 是不是滚轮回声）。
 *   ② `input`（滚轮窗口内）：原生已把值改成 0.1 的倍数 ⇒ 按「上次合法值 ± k×step」
 *      纠正；方向与格数都由**差值**推出来，不依赖事件的 delta 字段。
 *   ③ `input`（无滚轮窗口）：差值恰为 0.1 的整数倍且 step 不是 0.1 ⇒ 判为原生
 *      滚轮（这个环境里 wheel 事件根本没派发到脚本），同样按 k×step 纠正。
 *   ④ `change` / `blur`：范围夹紧（治手输越界）。
 *
 *   ⛔ 必须保住「用户手动键入」：`keydown` 开 500ms 键入窗口，窗口内一律不纠正。
 *   ⛔ 写回值走「原生 value setter + input/change 事件」：React 的 valueTracker
 *      只认原生 setter，直接赋值 el.value 会被当成「值没变」。
 *   ⛔ 自己写回时会再触发 input，必须用「元素 + 值 + 时间」三重标记跳过，否则无限递归。
 */

type AnyEl = any;

/** 每个输入框「最后一次合法值」（写回过的、或用户正常编辑过的）。 */
const lastGood = new WeakMap<object, number>();
/** 滚轮窗口：最后一次 wheel 的时刻（ms）。窗口内的 input 视为滚轮回声。 */
let wheelUntil = 0;
/** 自己写回时的标记（元素 + 值 + 时刻），防递归、也防把自己写的当成原生改的。 */
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

function clampTo(el: AnyEl, v: number): number {
    const min = boundOf(el, 'min');
    const max = boundOf(el, 'max');
    let next = v;
    if (next < min) next = min;
    if (next > max) next = max;
    return next;
}

/** 从 base 按 dir(±1) 走一格 step，并夹在 [min,max] 内。 */
function stepped(el: AnyEl, base: number, dir: number): number {
    const step = stepOf(el);
    const d = Math.max(decimalsOf(step), decimalsOf(base));
    const next = Number((base + dir * step).toFixed(Math.min(d + 2, 6)));
    return clampTo(el, next);
}

/** 从 base 走 k 格（k 可负、可 >1），并夹在 [min,max] 内。 */
function steppedBy(el: AnyEl, base: number, k: number): number {
    const step = stepOf(el);
    const d = Math.max(decimalsOf(step), decimalsOf(base));
    const next = Number((base + k * step).toFixed(Math.min(d + 2, 6)));
    return clampTo(el, next);
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

/** ① 滚轮：能判方向就自己改；判不出也记窗口，交给 ② 纠正。 */
function onWheel(e: AnyEl): void {
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
    if (Math.abs(next - cur) > EPS) writeValue(el, next);
    else lastGood.set(el, next);
}

/** ②③ input：把原生滚轮造成的 0.1 倍数变化纠正为 k×step，并夹紧到 [min,max]。 */
function onInput(e: AnyEl): void {
    const el: AnyEl = e && e.target;
    if (!isNumInput(el)) return;

    const now = Date.now();
    const cur = numOf(el);
    // 自己刚写进去的：只更新基线，别再纠正。
    // ⛔ 必须连值一起比：原生若在我们写回后 200ms 内又改了 0.1，值就不等于
    //    `ourWriteVal`，要照常纠正（只按时间窗跳过会把它当成「自己写的」而漏掉）。
    if (ourWriteEl === el && now - ourWriteAt < 200 && Math.abs(cur - ourWriteVal) <= EPS) {
        lastGood.set(el, cur);
        return;
    }
    // 键盘刚按过 ⇒ 这是键入，不是滚轮；滚轮纠正一律让路（否则「手输 3.3」会被改成 3.5）
    if (now <= typingUntil) { lastGood.set(el, cur); return; }

    const last = lastGood.get(el);
    if (last === undefined) { lastGood.set(el, cur); return; }
    const delta = cur - last;
    if (Math.abs(delta) <= EPS) return;

    const step = stepOf(el);
    const inWheelWindow = now <= wheelUntil;

    /* ⛔⛔ 自家写入的回声：我们刚把值写成 `last`（= step 网格上的值），原生又在上面
       叠了 0.1（快滚时可能叠好几格）。此时 `delta` 恰好是 0.1 的倍数
       （例：step=0.5、原生叠 0.3 ⇒ delta=0.8 = 8×0.1）—— 若按「8 格」换算就变成
       +4.0，严重过冲。⇒ 这种情况**只能拉回权威值**，绝不能再按格数推进。 */
    if (inWheelWindow && ourWriteEl === el && now - ourWriteAt < 200) {
        writeValue(el, last);
        return;
    }

    /* ⛔⛔ 0.1 的**整数倍**都算原生滚轮（第 3 版的关键修正）。
       慢滚 ⇒ 差 0.1 ⇒ k=1；快滚 ⇒ 原生攒了几格才派发 ⇒ 差 0.2/0.3/… ⇒ k=2/3/…
       k 就是「攒下的格数」，直接换算成 k×step ⇒ 快滚一次到位，不再退回 0.1 网格。
       ⛔ `step` 本身就是 0.1 时不做任何事（差值天然合法）。 */
    let k = 0;
    if (Math.abs(step - 0.1) > 1e-9) {
        const units = delta / 0.1;
        const r = Math.round(units);
        if (r !== 0 && Math.abs(units - r) < 1e-3) k = r;
    }
    const nativeWheel = k !== 0;

    if (!inWheelWindow && !nativeWheel) {
        lastGood.set(el, cur);        // 正常键入（或别的来源）⇒ 接受并更新基线
        return;
    }

    if (!nativeWheel) k = delta > 0 ? 1 : -1;   // 差值是 step 的倍数（自家写入回声）⇒ 走一格
    // ⛔ 上限保护：异常大的差值（比如窗口被拖出来的假事件）不要让值瞬移
    if (k > 50) k = 50;
    if (k < -50) k = -50;

    const next = steppedBy(el, last, k);
    if (Math.abs(next - cur) > EPS) writeValue(el, next);
    else lastGood.set(el, next);
}

/** ④ 范围夹紧：只夹 [min,max]，不动 step（手输 3.3 这种合法值保持原样）。 */
function clampNow(e: AnyEl): void {
    const el: AnyEl = e && e.target;
    if (!isNumInput(el)) return;
    if (el.disabled || el.readOnly) return;
    const raw = el.value;
    if (raw === '' || raw === null || raw === undefined) return;
    const v = Number(raw);
    if (!isFinite(v)) return;
    // 自己刚写的值本来就是夹紧过的，跳过
    if (ourWriteEl === el && Math.abs(v - ourWriteVal) <= EPS) return;

    const next = clampTo(el, v);
    if (Math.abs(next - v) > EPS) writeValue(el, next);
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
    bind(doc, 'change', clampNow);      // ④ 提交时夹紧（键入 50 → 20）
    bind(doc, 'blur', clampNow);        // ④ 失焦时兜底（type=number 的 change 有时不派发）
    bind(doc, 'keydown', onKey);
    const win: AnyEl = (globalThis as AnyEl).window;
    if (win && win !== doc) {
        bind(win, 'wheel', onWheel);
        bind(win, 'input', onInput);
        bind(win, 'change', clampNow);
        bind(win, 'blur', clampNow);
    }

    /* ⑤ 元素级兜底：UXP 里 `wheel` 有可能不冒泡到 document（第 1 版就是这样失效的）。
       用 MutationObserver 给每个 number 输入框直接挂一份；节点增删自动跟上。
       ⛔ 只挂 wheel：input/change/blur 在 capture 阶段一定能从 document 拿到，
          元素级重复挂会让同一个事件跑两遍纠正。 */
    const attached = new WeakSet<object>();
    const attachOne = (el: AnyEl) => {
        if (!el || attached.has(el) || !isNumInput(el)) return;
        attached.add(el);
        try { el.addEventListener('wheel', onWheel, { capture: true, passive: false }); }
        catch {
            try { el.addEventListener('wheel', onWheel, true); } catch { /* ignore */ }
        }
        // 元素级再挂一次 blur（blur 不冒泡，某些 UXP 版本 capture 也拿不到）
        try { el.addEventListener('blur', clampNow, true); } catch { /* ignore */ }
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
