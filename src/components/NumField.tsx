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
 * ── 滚轮为什么改成「document 捕获 + 分发器」（第 4 版，2026-11-18）────────
 *   第 3 版把 `<input>` 全部删掉后，用户实测：编辑时滚轮**完全不动数值**，
 *   只有面板滚动条在滚。根因是 UXP 的第四个性情：
 *     **非滚动元素收不到 `wheel`** —— 事件目标是「最近的滚动容器」，
 *     挂在元素自身的 `{ passive: false }` 监听一次都不触发（`preventDefault` 自然也无从谈起）。
 *   对照证据：`AdjustmentPanel` 的滚轮拦截之所以有效，正是因为它挂在**滚动容器本身**上。
 *   ⇒ 在 `document` **捕获阶段**拦一次（先于滚动容器的默认动作），三级判定挑出归属：
 *       ① 坐标命中某框所在行（最准，需 `clientX/clientY`）
 *       ② `target` 落在某框内（有的版本仍派给元素）
 *       ③ 全插件只有一个框在编辑态 ⇒ 就是它（用户主诉场景：点进去再滚）
 *     命中才 `preventDefault()`，没压到数字框的滚轮照旧滚面板。
 *   ⛔ 全插件只能有**一个**分发器：每个框各挂一个会把同一次滚轮算成多格。
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

/* ═══════════════════════════════════════════════════════════════════════════
   滚轮分发器（模块级单例，见文件头「第 4 版」）
   ⛔ 不要在组件里给节点单独挂 wheel：UXP 的 wheel 目标只有滚动容器，
      非滚动元素上的监听一次都不会触发（数值不动、面板照滚）。
   ⛔ 也不要用 React 的 `onWheel`：React 17+ 以 passive 方式挂在根节点，
      `preventDefault()` 无效，照样滚面板。
   ═══════════════════════════════════════════════════════════════════════════ */
interface WheelField {
    /** 命中区：数字框所在的行容器 `.num-input-row`（34×22，位置即视觉盒） */
    row: () => any;
    isEditing: () => boolean;
    /** 真正处理一次滚轮；返回 true 表示"这次滚轮归我"，外层的 preventDefault 才生效 */
    onWheel: (e: any) => boolean;
    /** 0x023B：原生代理回来的滚轮（dir=+1 增大 / -1 减小）。返回 true = 已消费。 */
    onNative: (dir: number, shift: boolean) => boolean;
}

const WHEEL_FIELDS: WheelField[] = [];
/** 当前鼠标悬停的数字框（给"事件不带坐标"的版本兜底，见分发器④/⑤） */
let HOVER_FIELD: WheelField | null = null;
let wheelBound = false;
/** 诊断日志余量（打满 3 条就静音，避免刷屏） */
let wheelLogLeft = 3;
/** 「wheel 是否进过 DOM」只打一次 */
let wheelSawLog = 0;
/** Shift 物理键状态兜底：个别 UXP 版本的 wheel 事件里 `shiftKey` 缺失 */
let shiftHeld = false;

const swallowWheel = (e: any) => {
    try { e.preventDefault(); } catch { /* ignore */ }
    try { e.stopPropagation(); } catch { /* ignore */ }
    try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch { /* ignore */ }
};

const handleGlobalWheel = (e: any) => {
    if (!WHEEL_FIELDS.length || !e) return;
    if (e.__jwNfWheel) return;         // window / document 两处都挂，去重防跳两格
    const cx = typeof e.clientX === 'number' ? e.clientX : NaN;
    const cy = typeof e.clientY === 'number' ? e.clientY : NaN;
    const hasPt = isFinite(cx) && isFinite(cy);
    /* 一次性诊断：区分「wheel 压根没进 DOM」与「进了但命中判定不对」——
       前者一行日志都没有，后者会打出 target/坐标。 */
    if (wheelSawLog < 1) {
        wheelSawLog++;
        try {
            const t: any = e && e.target;
            console.log('[NumField] wheel 首次到达 target='
                + String(t && (t.tagName || '') + '.' + (t.className || ''))
                + ' 坐标=' + hasPt + '(' + cx + ',' + cy + ')');
        } catch { /* ignore */ }
    }
    let hit: WheelField | null = null;
    let how = '';

    /* ① 坐标命中（最准） */
    if (hasPt) {
        for (let i = 0; i < WHEEL_FIELDS.length; i++) {
            const row = WHEEL_FIELDS[i].row();
            if (!row || !row.getBoundingClientRect) continue;
            const b = row.getBoundingClientRect();
            if (b && cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom) {
                hit = WHEEL_FIELDS[i];
                how = '坐标';
                break;
            }
        }
    }
    /* ② target 落在框内（有些版本仍把 wheel 派给元素本身） */
    if (!hit) {
        const t: any = e.target;
        if (t) {
            for (let i = 0; i < WHEEL_FIELDS.length; i++) {
                const row = WHEEL_FIELDS[i].row();
                if (row && row.contains && row.contains(t)) {
                    hit = WHEEL_FIELDS[i];
                    how = 'target';
                    break;
                }
            }
        }
    }
    /* ③ 指针悬停中的框（鼠标进出由 mouseenter/mouseleave 维护，同样只在没坐标时用） */
    if (!hit && !hasPt && HOVER_FIELD && WHEEL_FIELDS.indexOf(HOVER_FIELD) >= 0) {
        hit = HOVER_FIELD;
        how = '悬停';
    }
    /* ④ 全场唯一编辑中的框（点进去再滚 —— 用户主诉场景，这条是保底）。
       ⚠️ 只在这个版本**压根没给坐标**时启用：一旦有坐标就说明①②已能精确定位，
          再开这条会让"编辑中随手滚面板"变成"数值被暗改且面板不滚"。 */
    if (!hit && !hasPt) {
        let only: WheelField | null = null;
        let cnt = 0;
        for (let i = 0; i < WHEEL_FIELDS.length; i++) {
            if (WHEEL_FIELDS[i].isEditing()) { only = WHEEL_FIELDS[i]; cnt++; }
        }
        if (cnt === 1) { hit = only; how = '编辑中'; }
    }
    if (!hit) return;

    if (!hit.onWheel(e)) return;      // 禁用态/无方向 ⇒ 不拦，面板照常滚
    swallowWheel(e);
    try { e.__jwNfWheel = true; } catch { /* ignore */ }
    if (wheelLogLeft > 0) {
        wheelLogLeft--;
        try {
            const t: any = e && e.target;
            console.log('[NumField] 滚轮 命中=' + how
                + ' 坐标=' + hasPt
                + ' shift=' + String(e && e.shiftKey) + '/物理' + String(shiftHeld)
                + ' target=' + String(t && (t.tagName || '') + '.' + (t.className || '')));
        } catch { /* ignore */ }
    }
};

const BOUND_ELS: any[] = [];

/* ═══════════════════════════════════════════════════════════════════════════
   0x023B：原生滚轮代理（面板侧入口）
   ───────────────────────────────────────────────────────────────────────────
   第 5 版把分发器挂到整条祖先链，实测**依然不动数值** ⇒ 结论：这个 UXP 版本的
   `wheel` 根本不进脚本层（连滚动容器自己的监听也拿不到——面板能滚是原生行为）。
   ⇒ 唯一可行路径：.8li 里的 `WH_MOUSE_LL` 在消息进入 PS 之前截住它，
     转成一条 `nfWheel` 投回来，并把这次滚动吞掉（面板因此不滚）。

   面板这一侧的职责只有两件：
     ① 告诉原生「指针此刻是否停在某个数字框上」（SmoothBridge 每 400ms 心跳）；
     ② 收到 `nfWheel` 时把它落到具体字段上。

   ⛔ 归属判定用**指针坐标**，不用 mouseenter 维护的 HOVER_FIELD ——
      UXP 不保证派发 enter/leave，用它当唯一依据时一旦为 null 整条链路静默失效。
      坐标来自事件本身，指针静止时仍是最后一次的位置，正好对应
      「悬停在框上不动、直接滚轮」这个主诉场景。
   ⛔ 模块内只有一个分发入口：31 个框各发一次会把一次滚轮算成多格。
   ═══════════════════════════════════════════════════════════════════════════ */
let ptX = NaN;
let ptY = NaN;
let ptTracked = false;

function trackPointer() {
    if (ptTracked) return;
    const doc: any = (globalThis as any).document;
    if (!doc || !doc.addEventListener) return;
    ptTracked = true;
    const onMove = (e: any) => {
        const x = e && e.clientX;
        const y = e && e.clientY;
        if (typeof x === 'number' && typeof y === 'number') { ptX = x; ptY = y; }
    };
    const names = ['mousemove', 'pointermove', 'mousedown', 'pointerdown'];
    for (let i = 0; i < names.length; i++) {
        try { doc.addEventListener(names[i], onMove, true); } catch { /* UXP 可能不支持某类事件 */ }
    }
}

/** 坐标命中的字段（没有坐标经验时返回 null）。 */
function fieldAtPointer(): WheelField | null {
    if (!isFinite(ptX) || !isFinite(ptY)) return null;
    for (let i = 0; i < WHEEL_FIELDS.length; i++) {
        const row = WHEEL_FIELDS[i].row();
        if (!row || !row.getBoundingClientRect) continue;
        const b = row.getBoundingClientRect();
        if (b && ptX >= b.left && ptX <= b.right && ptY >= b.top && ptY <= b.bottom) {
            return WHEEL_FIELDS[i];
        }
    }
    return null;
}

/** 指针是否正落在某个数字框上（原生侧据此决定吞不吞这次滚轮）。 */
export function numFieldHoverActive(): boolean {
    if (fieldAtPointer()) return true;
    if (!isFinite(ptX) || !isFinite(ptY)) return HOVER_FIELD !== null;   // 没坐标：退回 hover 事件
    return false;
}

/** 把一条原生 `nfWheel` 落到具体字段上。返回 true = 有人接住了。 */
export function numFieldNativeWheel(dir: number, shift: boolean): boolean {
    if (!dir) return false;
    let f = fieldAtPointer();
    if (!f) {
        /* 指针已移开但仍在编辑态 ⇒ 归那个唯一编辑中的框（与 ④ 同一条保底） */
        let only: WheelField | null = null;
        let cnt = 0;
        for (let i = 0; i < WHEEL_FIELDS.length; i++) {
            if (WHEEL_FIELDS[i].isEditing()) { only = WHEEL_FIELDS[i]; cnt++; }
        }
        if (cnt === 1) f = only;
    }
    if (!f) return false;
    return !!f.onNative(dir > 0 ? 1 : -1, !!shift);
}

/** 在某个元素上挂"分发器"（同一元素只挂一次）。 */
function bindWheelOn(el: any) {
    if (!el || !el.addEventListener) return;
    for (let i = 0; i < BOUND_ELS.length; i++) if (BOUND_ELS[i] === el) return;
    BOUND_ELS.push(el);
    try { el.addEventListener('wheel', handleGlobalWheel, { passive: false } as any); }
    catch { try { el.addEventListener('wheel', handleGlobalWheel, false); } catch { /* ignore */ } }
}

function bindWheelDispatcher() {
    if (wheelBound) return;
    const doc: any = (globalThis as any).document;
    const win: any = globalThis as any;
    if (!doc || !doc.addEventListener) return;
    wheelBound = true;
    trackPointer();
    /* ⛔ 必须捕获 + passive:false：捕获才能在滚动容器的默认动作之前拦下。
       document 与 window 各挂一次（有的 UXP 版本只在 window 上派发），
       靠 `__jwNfWheel` 标记去重 ⇒ 同一次滚轮只会处理一格。 */
    try { doc.addEventListener('wheel', handleGlobalWheel, { capture: true, passive: false } as any); }
    catch { try { doc.addEventListener('wheel', handleGlobalWheel, true); } catch { /* ignore */ } }
    try { if (win && win.addEventListener) win.addEventListener('wheel', handleGlobalWheel, { capture: true, passive: false } as any); }
    catch { try { if (win && win.addEventListener) win.addEventListener('wheel', handleGlobalWheel, true); } catch { /* ignore */ } }
    /* Shift 物理键状态（只在 wheel 事件没给 shiftKey 时才用到） */
    const onShift = (down: boolean) => (ev: any) => {
        const k = ev && ev.key;
        if (k === 'Shift' || (ev && ev.keyCode === 16)) shiftHeld = down;
    };
    try { doc.addEventListener('keydown', onShift(true), true); } catch { /* ignore */ }
    try { doc.addEventListener('keyup', onShift(false), true); } catch { /* ignore */ }
    try { if (win && win.addEventListener) win.addEventListener('blur', () => { shiftHeld = false; }, false); } catch { /* ignore */ }
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

    /** 这次滚轮是否要按"加速"走：优先信事件自带的 `shiftKey`，
     *  只有它缺失时才退到物理键状态（个别 UXP 版本不填这个字段）。 */
    const shiftFast = (e: any): boolean => {
        if (e && typeof e.shiftKey === 'boolean') return e.shiftKey;
        return shiftHeld;
    };

    /** 处理一次滚轮。返回 true = 这次滚轮归我（外层才会 preventDefault 拦住面板滚动）。 */
    const handleWheel = (e: any): boolean => {
        if (disabled) return false;
        let dy = 0;
        if (typeof e.deltaY === 'number' && e.deltaY !== 0) dy = e.deltaY;
        else if (typeof e.wheelDelta === 'number' && e.wheelDelta !== 0) dy = -e.wheelDelta;
        else if (typeof e.detail === 'number' && e.detail !== 0) dy = e.detail;
        if (!dy) return false;
        // 向下 = 减小（与 PS / 原生一致）
        const dir = dy > 0 ? -1 : 1;
        // 编辑中就以草稿为基准（用户可能刚敲了半截）；否则用已提交值
        const typed = editing ? parseFloat(draftRef.current) : NaN;
        const base = isFinite(typed) ? typed : latest.current;
        const next = snap(base + dir * stepNum * multOf(shiftFast(e)));
        emit(next);
        if (editing) {
            const s = fmt(next);
            setDraftBoth(s);
            setCaretBoth(s.length);
            setSelAllBoth(false);
        }
        return true;
    };

    const wheelRef = React.useRef<any>(null);
    wheelRef.current = handleWheel;

    /** 0x023B：原生代理回来的滚轮（不经过 DOM 事件，所以没有 preventDefault 这回事）。 */
    const handleNative = (dir: number, fast: boolean): boolean => {
        if (disabled) return false;
        const typed = editing ? parseFloat(draftRef.current) : NaN;
        const base = isFinite(typed) ? typed : latest.current;
        const next = snap(base + dir * stepNum * multOf(fast));
        emit(next);
        if (editing) {
            const s = fmt(next);
            setDraftBoth(s);
            setCaretBoth(s.length);
            setSelAllBoth(false);
        }
        return true;
    };
    const nativeRef = React.useRef<any>(null);
    nativeRef.current = handleNative;
    const editingRef = React.useRef<boolean>(false);
    editingRef.current = editing;
    /** 本框在分发器里的登记项（悬停判定用） */
    const entryRef = React.useRef<WheelField | null>(null);

    /* ── 把自己登记进模块级滚轮分发器（见文件头「第 4 版」）────────────────
       ⛔ UXP 里 wheel **不走冒泡/捕获传播**（document/window 的捕获监听实测一次没响），
          只在"目标元素自身"派发，目标是最近的滚动容器 ⇒ 必须把同一个分发器
          挂到**整条祖先链**上（下面那段循环），靠 `__jwNfWheel` 去重。
       这里先登记"我是谁、命中区在哪"，供分发器做归属判定。 */
    React.useEffect(() => {
        const entry: WheelField = {
            row: () => {
                const el = nodeRef.current;
                return el && el.parentElement ? el.parentElement : el;
            },
            isEditing: () => !!editingRef.current,
            onWheel: (ev: any) => (wheelRef.current ? !!wheelRef.current(ev) : false),
            onNative: (d: number, sh: boolean) => (nativeRef.current ? !!nativeRef.current(d, sh) : false),
        };
        WHEEL_FIELDS.push(entry);
        entryRef.current = entry;
        bindWheelDispatcher();

        const el = nodeRef.current;
        /* ⛔⛔ 关键：把分发器挂到**整条祖先链**上（含面板滚动容器）。
           UXP 的 wheel 目标是「最近的滚动容器」，而且实测**不走冒泡/捕获传播**
           （document/window 的捕获监听一次都没响），只在目标元素自身派发。
           既然目标一定是某个祖先，就把链上每一层都挂一份；同一次滚轮靠
           `__jwNfWheel` 去重，绝不会跳多格。
           这也是项目里唯一已验证可行的形状：AdjustmentPanel 的滚轮拦截正是
           挂在滚动容器自己身上。 */
        {
            let up: any = el;
            for (let depth = 0; depth < 16 && up; depth++) {
                bindWheelOn(up);
                up = up.parentElement;
            }
            bindWheelOn((globalThis as any).document);
        }
        /* 节点自身也已在上面那一圈里绑过了 ⇒ 不必再单独挂一条。 */
        return () => {
            const i = WHEEL_FIELDS.indexOf(entry);
            if (i >= 0) WHEEL_FIELDS.splice(i, 1);
            if (HOVER_FIELD === entry) HOVER_FIELD = null;
            entryRef.current = null;
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
            onMouseEnter={() => { if (entryRef.current) HOVER_FIELD = entryRef.current; }}
            onMouseLeave={() => { if (HOVER_FIELD && HOVER_FIELD === entryRef.current) HOVER_FIELD = null; }}
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
