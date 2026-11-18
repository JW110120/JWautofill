/**
 * 自绘数字输入框（2026-11-18，第 3 版：连**编辑态**也自绘）
 *
 * ── 为什么不再用 `<input type="number">` ────────────────────────────────────
 *   PS 27.8 之前的 UXP 里，number 输入框是**原生控件**：
 *     · 滚轮写死 0.1，无视 `step`/`min`/`max`，`preventDefault()` 拦不住；
 *     · 方向不可靠（用户实测「缩小反而变大」）——只能靠 `input` 差值事后猜；
 *     · 原生绘制层压在 DOM 之上，`z-index` 对它无效（浮层被它穿透）；
 *     · 右侧自带上下箭头，吃掉 ~10px 宽度 ⇒ 34px 容器里 `14.5` 被裁。
 *   ⇒ 换成普通文本框：滚轮/键盘/夹紧全部由我们自己算，层级也回到 DOM 世界。
 *
 * ── 为什么**显示态不用 input**（第 2 版）────────────────────────────────────
 *   UXP 里原生 input 的 `text-align: center` **不生效**，文字永远左对齐。
 *   像素实测用户截图（40px 容器、`15`）：左间隙 8px、右间隙 19px ⇒ 个位数右边空白
 *   一大截，正是用户抱怨的「数字明显右侧空白太多」。
 *   ⇒ 显示态 = 普通 `<div>`（flex 居中，几何居中由我们自己保证）。
 *
 * ── 为什么**编辑态也不再用 input**（第 3 版，2026-11-18 用户第 6 次反馈后定案）──
 *   第 2 版把编辑态留给原生 `<input type="text">`，用户实测两处硬伤：
 *     ① 一点进去，原本居中的数字**跳到左上角**；
 *     ② 编辑态输入框的底边**盖住外层 `.num-input-row` 的蓝色激活边框**。
 *   同一根因：`type="text"` 在 UXP 里是原生 NSTextField 风格绘制——
 *     · 文字锚在**绘制区左上**（不吃 `line-height`，也不吃 `text-align:center`）；
 *     · 绘制区（含底色）**比 CSS 盒更大**，且原生层压在 DOM 之上，
 *       `overflow:hidden` 裁不到它 ⇒ 底色溢出去把容器的 border 盖掉。
 *   试过的绕法都不成立：`padding-top` 无效（原生绘制区不随内容盒走）、
 *   `background: transparent` 在 UXP 里渲染成**纯黑**（项目铁律），
 *   1px 隐形 input 当键盘桩同样会画出一个黑点。
 *   ⇒ 编辑态彻底自绘：**同一个 `<div>`，内部分段渲染「光标前文本 / 光标 / 光标后文本」**。
 *     居中由 flex 保证，边框只属于外层容器，不存在任何"溢出的原生底色"。
 *
 * ── 键盘从哪来（没有 input 就没有原生焦点）────────────────────────────────
 *   编辑期间在 `document` 上挂 **捕获阶段** 的 `keydown`（项目里快捷键录制、
 *   AdjustmentPanel 都是同款做法，UXP 下可用），自己实现：字符插入 / 退格 / 删除 /
 *   ←→ Home End 移光标 / Ctrl+A 全选 / ↑↓ 走格 / 回车提交 / Esc 取消。
 *   ⛔ 必须 `preventDefault()`：否则数字会被 PS 当成工具快捷键吃掉。
 *   失焦提交：`document` 的 `mousedown`（点在框外）+ 窗口 `blur` 双保险，
 *   没有原生 blur 可依赖（点画布那一下不会派发 DOM mousedown）。
 *
 * ── 对外契约（特意保持「像原生」）──────────────────────────────────────────
 *   `onChange` 收到的是**事件形状** `{ target: { value } }`，不是裸数字。
 *   这样全插件 31 个既有处理器（`Number(e.target.value)` / `parseInt(...)`）
 *   一行都不用改；范围校验仍旧由各处理器自己做（我们只做**夹紧兜底**）。
 *
 * ── 交互（对齐 PS 手感）────────────────────────────────────────────────────
 *   · 点一下 → 进入编辑态并**全选**（PS 的数值框就是这样：蓝底高亮，首个按键覆盖）。
 *   · 滚轮：按 `step` 走一格并夹紧；方向取 `deltaY`（取不到再退 `wheelDelta`）。
 *   · **Shift + 滚轮加速**（2026-11-18 用户要求）：分档数 = (max−min)/step + 1，
 *       ≥100 档 ⇒ 一次 10 倍步长（不透明度 0–100/步 1 = 101 档）；
 *       ≥20 且 <100 档 ⇒ 一次 5 倍步长（羽化 0–20/步 0.5 = 41 档）；
 *       其余维持 1 倍。↑↓ 加 Shift 同样走这个倍率。
 *   · 输入中不提交，**回车或失焦**才提交（避免每敲一个字符就触发 PS 调用）。
 *   · Esc：放弃本次编辑，回退到当前值。
 *   · 编辑中给父级 `.num-input-row` 挂 `is-focus`（外边框变主题色）。
 *
 * ⛔ 不要在组件内部渲染 `.num-input-row`：调用点都已经有那个容器，
 *    本组件只产出「显示态文本 / 编辑态文本」，容器宽度/边框/单位对齐规则沿用旧 CSS。
 * ⛔ 提交时**只夹紧、不对齐 step**：手输 3.3（step=0.5）是用户意图，不该被抹成 3.5。
 *    只有滚轮/箭头才落 step 网格。
 */
import React from 'react';

export interface NumFieldProps {
    value: number;
    min?: number | string;
    max?: number | string;
    step?: number | string;
    title?: string;
    disabled?: boolean;
    /** 额外类名（一般不用） */
    className?: string;
    /** 显示小数位；默认按 step 推，最多 2 位 */
    decimals?: number;
    /** 事件形状回调：与原生 input 的 onChange 兼容。
     *  ⚠️ 形参类型必须是 `any`：调用点大多写成
     *     `(event: React.ChangeEvent<HTMLInputElement>) => ...`（strictFunctionTypes 下
     *     逆变检查会拒绝更窄的事件形状），用 any 才能让 31 个既有处理器零改动接上。 */
    onChange: (e: any) => void;
}

function toNum(v: number | string | undefined, fb: number): number {
    const n = typeof v === 'number' ? v : parseFloat(String(v === undefined ? '' : v));
    return isFinite(n) ? n : fb;
}

function decimalsOf(n: number): number {
    const s = String(n);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
}

/** 取出按键对应的字符（数字/小数点/负号），其它键返回空串。
 *  UXP 的 `key` 在部分布局下会给 `NumpadDecimal` 这类老名字，一并兜住。 */
function charOfKey(key: string): string {
    if (key === undefined || key === null) return '';
    if (key.length === 1 && /[0-9]/.test(key)) return key;
    if (key === '.' || key === 'Decimal' || key === ',' || key === 'Comma') return '.';
    if (key === '-' || key === 'Subtract') return '-';
    return '';
}

export const NumField: React.FC<NumFieldProps> = (props) => {
    const { value, min, max, step, title, disabled, className, decimals, onChange } = props;

    const stepNum = Math.abs(toNum(step, 1)) || 1;
    const minNum = min === undefined ? -Infinity : toNum(min, -Infinity);
    const maxNum = max === undefined ? Infinity : toNum(max, Infinity);
    const dec = decimals !== undefined ? decimals : Math.min(2, decimalsOf(stepNum));

    /* 分档数（可选值个数）——Shift 加速倍率的唯一依据。
       ⛔ 不要用「量程 / step」而漏 +1：0–100/步 1 是 **101** 档（含两端），
          用户原话「有 101 级的滑块」指的就是这个数。 */
    const levels = (isFinite(minNum) && isFinite(maxNum) && maxNum > minNum)
        ? Math.floor((maxNum - minNum) / stepNum) + 1
        : 0;
    const multOf = (fast: boolean): number => {
        if (!fast) return 1;
        if (levels >= 100) return 10;
        if (levels >= 20) return 5;
        return 1;
    };

    const fmt = React.useCallback((v: number): string => {
        if (!isFinite(v)) return '0';
        return String(Number(v.toFixed(dec)));
    }, [dec]);

    const clamp = React.useCallback((v: number): number => {
        if (v < minNum) return minNum;
        if (v > maxNum) return maxNum;
        return v;
    }, [minNum, maxNum]);

    /** 落到 step 网格（以 min 为基准，与 PS 一致），再夹紧。 */
    const snap = React.useCallback((v: number): number => {
        const base = minNum !== -Infinity ? minNum : 0;
        const k = Math.round((v - base) / stepNum);
        const d = Math.max(dec, decimalsOf(stepNum));
        return clamp(Number((base + k * stepNum).toFixed(Math.min(d + 2, 6))));
    }, [minNum, stepNum, dec, clamp]);

    /** 根节点（显示态/编辑态是**同一个** div，滚轮监听只需挂一次） */
    const nodeRef = React.useRef<any>(null);
    /** 最新已提交值（滚轮连滚时 props.value 可能还没回流，用它做基准） */
    const latest = React.useRef<number>(value);
    /** 最近一次 props.value（提交后回读对齐用） */
    const propVal = React.useRef<number>(value);
    propVal.current = value;
    const [text, setText] = React.useState<string>(() => fmt(value));

    /** 编辑态三件套：草稿串 / 光标下标 / 是否全选（PS 点进去就是全选） */
    const [editing, setEditing] = React.useState<boolean>(false);
    const [draft, setDraft] = React.useState<string>('');
    const [caret, setCaret] = React.useState<number>(0);
    const [selAll, setSelAll] = React.useState<boolean>(false);
    /* ⛔ 三件套必须**同时写 ref**：commit 在 document 事件里读值，
       而 React 的 state 可能还没落盘 —— 用户敲完最后一个字符立刻回车/点别处时，
       只读 state 会把最后一位丢掉（上一版踩过）。
       ⇒ 所有修改统一走下面三个 both 函数，ref 始终是最新真值。 */
    const draftRef = React.useRef<string>('');
    const caretRef = React.useRef<number>(0);
    const selAllRef = React.useRef<boolean>(false);
    const setDraftBoth = (v: string) => { draftRef.current = v; setDraft(v); };
    const setCaretBoth = (n: number) => { caretRef.current = n; setCaret(n); };
    const setSelAllBoth = (b: boolean) => { selAllRef.current = b; setSelAll(b); };

    React.useEffect(() => {
        latest.current = value;
        if (!editing) setText(fmt(value));
    }, [value, editing, fmt]);

    /** 外边框变色：给父级 `.num-input-row` 挂类（容器的边框在父级上，节点自身没有边框）。 */
    const markParent = (on: boolean) => {
        const el = nodeRef.current;
        const p = el && el.parentElement;
        if (p && p.classList) {
            try {
                if (on) p.classList.add('is-focus');
                else p.classList.remove('is-focus');
            } catch { /* ignore */ }
        }
    };

    React.useEffect(() => () => markParent(false), []);

    const emit = (v: number) => {
        latest.current = v;
        setText(fmt(v));
        onChange({ target: { value: String(v) } });
    };

    /* ⛔ 提交后必须**回头对齐 props**：调用点的处理器可能做自己的换算
       （例：`parseInt(e.target.value)` 把 14.5 收成 14，或直接拒绝某值）。
       我们发出去的是 14.5、父级实际存的是 14，若不回读，输入框会一直显示 14.5。
       ⇒ 交给下一帧的 props 值重写一次文本（不用 0ms：要等 React 落盘）。 */
    const resync = () => {
        const g: any = globalThis as any;
        if (g && typeof g.setTimeout === 'function') {
            g.setTimeout(() => { setText(fmt(propVal.current)); }, 40);
        } else {
            setText(fmt(propVal.current));
        }
    };

    const enterEditing = () => {
        if (disabled) return;
        const t = fmt(latest.current);
        setDraftBoth(t);
        setCaretBoth(t.length);
        setSelAllBoth(true);          // PS 手感：点进去全选，首个按键覆盖
        setEditing(true);
        markParent(true);
        const el = nodeRef.current;
        const doc: any = (globalThis as any).document;
        /* ⛔ 必须先把**别的**输入控件的焦点踢掉：本组件没有 input，
           键盘靠 document 捕获；若面板里还有原生 input（如渐变面板的 `#RRGGBB`）
           仍是 activeElement，敲数字会钻进那个框，而我们这边只显示一个不动光标。 */
        try {
            const act: any = doc && doc.activeElement;
            if (act && el && act !== el && act.blur) act.blur();
        } catch { /* ignore */ }
        /* 尽力把 DOM 焦点也拿过来（UXP 对 div 的 tabIndex 聚焦不保证，
           键盘真正的兜底是 document 捕获，这里只是"能拿就拿"）。 */
        try { if (el && el.focus) el.focus(); } catch { /* ignore */ }
    };

    const leaveEditing = () => {
        setEditing(false);
        setDraftBoth('');
        setCaretBoth(0);
        setSelAllBoth(false);
        markParent(false);
    };

    const commit = () => {
        const raw = String(draftRef.current).trim();
        const t = raw === '' ? NaN : parseFloat(raw);
        if (!isFinite(t)) {
            setText(fmt(latest.current));           // 空/非法 ⇒ 回退
        } else {
            const next = clamp(t);                  // ⛔ 只夹紧不吸附
            if (Math.abs(next - latest.current) > 1e-9) emit(next);
            else setText(fmt(next));
        }
        resync();
        leaveEditing();
    };

    const cancel = () => {
        setText(fmt(latest.current));
        leaveEditing();
    };

    /** 把一个字符插到光标处（全选时等价于"替换全部"）。返回是否被接受。 */
    const insertChar = (ch: string) => {
        const sel = selAllRef.current;
        const base = sel ? '' : draftRef.current;
        const at = sel ? 0 : Math.min(caretRef.current, base.length);
        if (ch === '.') {
            if (base.indexOf('.') >= 0) return;         // 只允许一个小数点
        } else if (ch === '-') {
            if (at !== 0 || base.charAt(0) === '-') return;  // 负号只能在最前
        }
        const next = base.slice(0, at) + ch + base.slice(at);
        setDraftBoth(next);
        setCaretBoth(at + 1);
        setSelAllBoth(false);
    };

    const backspace = () => {
        if (selAllRef.current) { setDraftBoth(''); setCaretBoth(0); setSelAllBoth(false); return; }
        const d = draftRef.current;
        const at = Math.min(caretRef.current, d.length);
        if (at <= 0) return;
        setDraftBoth(d.slice(0, at - 1) + d.slice(at));
        setCaretBoth(at - 1);
    };

    const del = () => {
        if (selAllRef.current) { setDraftBoth(''); setCaretBoth(0); setSelAllBoth(false); return; }
        const d = draftRef.current;
        const at = Math.min(caretRef.current, d.length);
        if (at >= d.length) return;
        setDraftBoth(d.slice(0, at) + d.slice(at + 1));
    };

    const stepBy = (dir: number, fast: boolean) => {
        const next = snap(latest.current + dir * stepNum * multOf(fast));
        emit(next);
        if (editing) {
            const s = fmt(next);
            setDraftBoth(s);
            setCaretBoth(s.length);
            setSelAllBoth(false);
        }
    };

    /* ── 编辑态键盘：document 捕获 ────────────────────────────────────────
       ⛔ 一定要用捕获 + preventDefault/stopPropagation：
          否则数字/回车会被 PS 或面板级热键先吃掉（面板里 H/L 之类都是全局监听）。 */
    React.useEffect(() => {
        if (!editing) return () => { /* ignore */ };
        const doc: any = (globalThis as any).document;
        if (!doc || !doc.addEventListener) return () => { /* ignore */ };

        const onKey = (e: any) => {
            const key = String(e.key === undefined ? '' : e.key);
            const stop = () => {
                try { e.preventDefault(); } catch { /* ignore */ }
                try { e.stopPropagation(); } catch { /* ignore */ }
                try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch { /* ignore */ }
            };

            if (e.ctrlKey || e.metaKey) {
                if (key === 'a' || key === 'A') {
                    stop();
                    setSelAllBoth(true);
                    setCaretBoth(draftRef.current.length);
                }
                return;    // 其它 Ctrl 组合交给系统（复制/粘贴不做：数字框用不上）
            }

            if (key === 'Enter') { stop(); commit(); return; }
            if (key === 'Escape' || key === 'Esc') { stop(); cancel(); return; }
            if (key === 'Tab') { stop(); commit(); return; }
            if (key === 'Backspace') { stop(); backspace(); return; }
            if (key === 'Delete' || key === 'Del') { stop(); del(); return; }
            if (key === 'ArrowLeft') {
                stop();
                setSelAllBoth(false);
                setCaretBoth(selAllRef.current ? 0 : Math.max(0, Math.min(caretRef.current, draftRef.current.length) - 1));
                return;
            }
            if (key === 'ArrowRight') {
                stop();
                setSelAllBoth(false);
                setCaretBoth(selAllRef.current ? draftRef.current.length : Math.min(draftRef.current.length, caretRef.current + 1));
                return;
            }
            if (key === 'ArrowUp') { stop(); stepBy(1, !!e.shiftKey); return; }
            if (key === 'ArrowDown') { stop(); stepBy(-1, !!e.shiftKey); return; }
            if (key === 'Home') { stop(); setSelAllBoth(false); setCaretBoth(0); return; }
            if (key === 'End') { stop(); setSelAllBoth(false); setCaretBoth(draftRef.current.length); return; }

            const ch = charOfKey(key);
            if (ch) { stop(); insertChar(ch); }
        };

        doc.addEventListener('keydown', onKey, true);
        return () => { try { doc.removeEventListener('keydown', onKey, true); } catch { /* ignore */ } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editing, stepNum, minNum, maxNum, dec]);

    /* ── 失焦提交：没有原生 input 就没有原生 blur ────────────────────────────
       · 点在面板内别处 ⇒ document mousedown（点自己的框不算）
       · 点画布/切面板 ⇒ 不派发 DOM mousedown，靠 window 的 blur 兜底
       ⛔ 必须用**捕获**阶段：滑块的 mousedown 里有 `e.stopPropagation()`
          （RangeSlider 防止行容器抢事件），冒泡监听会被它掐断 ⇒ 点滑块不提交。
          捕获阶段在事件下达到根节点之前就执行，谁也拦不住。
       ⚠️ 监听器在"进入编辑态这一帧之后"才挂上，而触发编辑的那次 mousedown
          的捕获阶段早已走完 ⇒ 不会自己把自己提交掉。 */
    React.useEffect(() => {
        if (!editing) return () => { /* ignore */ };
        const doc: any = (globalThis as any).document;
        const win: any = globalThis as any;
        const onDown = (e: any) => {
            const el = nodeRef.current;
            const tgt = e && e.target;
            if (el && tgt && el.contains && el.contains(tgt)) return;
            commit();
        };
        const onWinBlur = () => { commit(); };
        if (doc && doc.addEventListener) doc.addEventListener('mousedown', onDown, true);
        if (win && win.addEventListener) { try { win.addEventListener('blur', onWinBlur, false); } catch { /* ignore */ } }
        return () => {
            if (doc && doc.removeEventListener) { try { doc.removeEventListener('mousedown', onDown, true); } catch { /* ignore */ } }
            if (win && win.removeEventListener) { try { win.removeEventListener('blur', onWinBlur, false); } catch { /* ignore */ } }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editing, stepNum, minNum, maxNum, dec]);

    const handleWheel = (e: any) => {
        // 自己吃掉，既不滚面板也不让任何原生控件看到
        try { e.preventDefault(); } catch { /* ignore */ }
        try { e.stopPropagation(); } catch { /* ignore */ }
        if (disabled) return;
        let dy = 0;
        if (typeof e.deltaY === 'number' && e.deltaY !== 0) dy = e.deltaY;
        else if (typeof e.wheelDelta === 'number' && e.wheelDelta !== 0) dy = -e.wheelDelta;
        else if (typeof e.detail === 'number' && e.detail !== 0) dy = e.detail;
        if (!dy) return;
        // 向下 = 减小（与 PS / 原生一致）
        const dir = dy > 0 ? -1 : 1;
        // 编辑中就以草稿为基准（用户可能刚敲了半截）；否则用已提交值
        const typed = editing ? parseFloat(draftRef.current) : NaN;
        const base = isFinite(typed) ? typed : latest.current;
        const next = snap(base + dir * stepNum * multOf(!!e.shiftKey));
        emit(next);
        if (editing) {
            const s = fmt(next);
            setDraftBoth(s);
            setCaretBoth(s.length);
            setSelAllBoth(false);
        }
    };

    /* ⛔ 滚轮**只能用原生监听**，不能用 React 的 onWheel：
       React 17+ 把 wheel 以 **passive** 方式挂在根节点上，`preventDefault()` 无效，
       面板会跟着一起滚（既有铁律：UXP 里被动的轮子事件挡不住）。
       ⇒ 在节点本身上挂 `{ passive: false }` 的监听，并走 ref 取最新闭包。
       ⚠️ 节点在两种状态下是**同一个 div** ⇒ 依赖留空即可，不必随 editing 重挂。 */
    const wheelRef = React.useRef<any>(null);
    wheelRef.current = handleWheel;
    React.useEffect(() => {
        const el = nodeRef.current;
        if (!el || !el.addEventListener) return () => { /* ignore */ };
        const h = (ev: any) => { if (wheelRef.current) wheelRef.current(ev); };
        try { el.addEventListener('wheel', h, { passive: false }); }
        catch { try { el.addEventListener('wheel', h, false); } catch { /* ignore */ } }
        return () => {
            try { el.removeEventListener('wheel', h, false); } catch { /* ignore */ }
        };
    }, []);

    /* ── 渲染：显示态与编辑态共用同一个 div ────────────────────────────────
       ⛔ 不要再出现 `<input>`：任何原生输入控件都会把文字画到左上并溢出底色
          （见文件头「第 3 版」）。居中由 flex 保证，光标位置靠**文本切段**保证。 */
    const before = selAll ? '' : draft.slice(0, caret);
    const after = selAll ? '' : draft.slice(Math.max(caret, 0));

    return (
        <div
            ref={nodeRef}
            className={'num-field-view'
                + (className ? ' ' + className : '')
                + (disabled ? ' is-disabled' : '')
                + (editing ? ' is-editing' : '')}
            title={title}
            tabIndex={disabled ? -1 : 0}
            onMouseDown={(e: any) => {
                if (disabled) return;
                // 自己接管：阻止原生可能引发的拖动选择
                try { e.preventDefault(); } catch { /* ignore */ }
                if (!editing) enterEditing();
            }}
        >
            {!editing ? text : (
                <span className="num-field-edit">
                    {before ? <span className="num-field-text">{before}</span> : null}
                    {selAll && draft
                        ? <span className="num-field-text is-selected">{draft}</span>
                        : <span className="num-field-caret" />}
                    {after ? <span className="num-field-text">{after}</span> : null}
                </span>
            )}
        </div>
    );
};

export default NumField;
