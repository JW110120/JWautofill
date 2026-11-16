/**
 * HotkeyNotifyBus —— 「热键通知」开关（2026-11-16，**按面板各管一份**）
 *
 * 需求（用户原话，两轮）：
 *   ① 在 APP 面板菜单的「紧凑模式」下方、以及绘画工具箱菜单的「复位分区顺序」下方
 *      各加一个开关；关掉后不再显示热键触发的通知，降低干扰，默认开启。
 *   ② 2026-11-16 第二轮：菜单文案改为「热键通知 - 开/关」（去掉「显示」两字），
 *      并且**两个面板独立管理，不要跨面板共享**。
 *
 * 为什么必须分两份状态（第二轮的关键改动）：
 *   「热键通知」有两处显示点，分属两个 JS 世界，各自说各自的按键：
 *     · APP 面板（scope='app'）    ：showAppHotkeyNotify —— 主开关 / 套索 / 选框 /
 *                                    清除模式 / 混合模式 / 切换填充模式这些**选区填充**的键；
 *     · 绘画工具箱（scope='toolbox'）：BrushHotkeySection 的通用 msg 条 —— 切笔刷 / 跑功能按钮。
 *   第一版把两者做成一份共享偏好，用户随后明确要求拆开：工具箱里画画时不想被提示打扰，
 *   但选区填充那套键的反馈仍要看 ⇒ 一个开关管不了两个诉求。
 *   ⛔ 因此**每个 scope 一个文件**（settings/hotkey-notify-app.json /
 *      hotkey-notify-toolbox.json），各自写、各自轮询、各自同步菜单文案。
 *      切勿再引入「任一 scope 变了就广播给另一个」的联动。
 *
 * ⛔ 默认值必须是**开**：这是「降低干扰」的偏好项，用户没表过态时显示通知是原有的
 *    既有行为；文件不存在 / 内容损坏一律按开处理（读失败不能变成「静默吞掉全部反馈」，
 *    那会让「按键没反应」重新变成不可诊断的问题）。
 * ⚠️ 第一版的共享文件（settings/hotkey-notify.json）故意**不迁移**：那份值是
 *    「两个面板一起关」，拆开后无法判定用户想让哪一个静默 ⇒ 各自回到默认开，
 *    用户在新菜单里各点一下即可。旧文件留着不读不写，不影响启动。
 */

const SETTINGS_FOLDER = 'settings';

/** 两个作用域：app = 选区填充面板，toolbox = 绘画工具箱。 */
export type HotkeyNotifyScope = 'app' | 'toolbox';

/** 作用域 → 落盘文件名（**必须互不相同**，这是「独立管理」的物理边界）。 */
const STATE_FILE: Record<HotkeyNotifyScope, string> = {
    app: 'hotkey-notify-app.json',
    toolbox: 'hotkey-notify-toolbox.json',
};

type HotkeyNotifyState = {
    /** true = 显示热键通知（默认） */
    on: boolean;
    /** 单调递增的修订号：订阅方据此判断「有没有变过」 */
    rev: number;
    ts: number;
};

const EMPTY: HotkeyNotifyState = { on: true, rev: 0, ts: 0 };

// 与 MainToggleBus / FocusModeBus / PanelStateManager 一致：webpack 打包后静态 import
// 有时拿不到 uxp，统一 require 兜底。
function getLfs(): any {
    try {
        return require('uxp').storage.localFileSystem;
    } catch (_) {
        return (window as any)?.uxp?.storage?.localFileSystem;
    }
}

function getFormats(): any {
    try {
        return require('uxp').storage.formats;
    } catch (_) {
        return { utf8: 'utf8' };
    }
}

async function getSettingsFolder(): Promise<any> {
    const lfs = getLfs();
    if (!lfs) throw new Error('无法获取 UXP localFileSystem');
    const dataFolder = await lfs.getDataFolder();
    let folder: any;
    try {
        folder = await dataFolder.getEntry(SETTINGS_FOLDER);
    } catch (_) {
        folder = await dataFolder.createFolder(SETTINGS_FOLDER);
    }
    return folder;
}

// 内存缓存 / 写链 / 同上下文监听器：**按 scope 各一份**（这是「独立管理」的内存侧）。
const cachedMap: Record<HotkeyNotifyScope, HotkeyNotifyState | null> = {
    app: null,
    toolbox: null,
};
const writeChains: Record<HotkeyNotifyScope, Promise<unknown>> = {
    app: Promise.resolve(),
    toolbox: Promise.resolve(),
};
const memListeners: Record<HotkeyNotifyScope, Set<() => void>> = {
    app: new Set(),
    toolbox: new Set(),
};

function emitMem(scope: HotkeyNotifyScope) {
    for (const l of memListeners[scope]) { try { l(); } catch { /* ignore */ } }
}

async function readRaw(scope: HotkeyNotifyScope): Promise<HotkeyNotifyState | null> {
    try {
        const folder = await getSettingsFolder();
        const file = await folder.getEntry(STATE_FILE[scope]);
        const content = await file.read({ format: getFormats().utf8 });
        const j = JSON.parse(content);
        if (!j || typeof j !== 'object') return null;
        // ⛔ `on` 缺字段 ⇒ 按默认开（不是按 false）：旧文件/半截写入都当作「没表过态」
        return {
            on: j.on === undefined ? true : !!j.on,
            rev: Number(j.rev) || 0,
            ts: Number(j.ts) || 0,
        };
    } catch (_) {
        // 文件不存在 / 内容损坏：一律当作「显示通知」（默认开）
        return null;
    }
}

/** 写入开关状态（每个 scope 一条独立串行链，避免连点时交错覆盖）。 */
export function setHotkeyNotify(scope: HotkeyNotifyScope, on: boolean): Promise<boolean> {
    const run = writeChains[scope].then(async () => {
        const cur = (await readRaw(scope)) ?? cachedMap[scope] ?? EMPTY;
        if (cur.on === on) {
            cachedMap[scope] = cur;
            return on;
        }
        const next: HotkeyNotifyState = { on, rev: (cur.rev || 0) + 1, ts: Date.now() };
        try {
            const folder = await getSettingsFolder();
            const file = await folder.createFile(STATE_FILE[scope], { overwrite: true });
            await file.write(JSON.stringify(next), { format: getFormats().utf8 });
            cachedMap[scope] = next;
        } catch (_) {
            // 落盘失败：内存仍按用户意图生效（本次会话可用），下次启动回默认
            cachedMap[scope] = { ...next, rev: cur.rev || 0 };
        }
        emitMem(scope);
        return on;
    });
    writeChains[scope] = run.then(() => {}, () => {});
    return run;
}

/**
 * 翻转开关（各面板菜单项点击的唯一入口，只翻**自己那一个 scope**）。
 * ⛔ 这里**不能**写成 `writeChain.then(() => setHotkeyNotify(...))`：
 *    setHotkeyNotify 会往同一条串行链上再排一次队，而那条链正等着本次任务结束
 *    ⇒ 自己等自己，永远不返回（菜单点了没反应）。写法与 setHotkeyNotify 同构。
 */
export function toggleHotkeyNotify(scope: HotkeyNotifyScope): Promise<boolean> {
    const run = writeChains[scope].then(async () => {
        const cur = (await readRaw(scope)) ?? cachedMap[scope] ?? EMPTY;
        const on = !cur.on;
        const next: HotkeyNotifyState = { on, rev: (cur.rev || 0) + 1, ts: Date.now() };
        try {
            const folder = await getSettingsFolder();
            const file = await folder.createFile(STATE_FILE[scope], { overwrite: true });
            await file.write(JSON.stringify(next), { format: getFormats().utf8 });
            cachedMap[scope] = next;
        } catch (_) {
            cachedMap[scope] = { ...next, rev: cur.rev || 0 };
        }
        emitMem(scope);
        return on;
    });
    writeChains[scope] = run.then(() => {}, () => {});
    return run;
}

/**
 * **同步**读某个 scope 的开关：供「要不要显示这条通知」的即时判断使用
 * （通知是同步函数，等不了 await）。
 * ⛔ 未知（从未读过文件）时返回 **true**：默认开，绝不静默吞掉反馈。
 */
export function hotkeyNotifyOnSync(scope: HotkeyNotifyScope): boolean {
    const st = cachedMap[scope];
    return st ? st.on : true;
}

/** 读取某个 scope 的开关（文件不存在时按默认开） */
export async function readHotkeyNotify(scope: HotkeyNotifyScope): Promise<boolean> {
    const st = await readRaw(scope);
    if (st) cachedMap[scope] = st;
    const cur = cachedMap[scope];
    return cur ? cur.on : true;
}

/**
 * 订阅某个 scope 的开关变化（默认每 400ms 轮询一次文件），用于同步菜单文案。
 *
 * ⛔ `last` 必须从 `null` 起（**不能**用缓存播种）：面板是后打开的，
 *    若用缓存播种，只要值没变就永远不回调 ⇒ 该面板的菜单文案停在上一次的文案上。
 *    从 null 起 ⇒ 首次读到有效值必回调一次，新订阅者一定拿到当前状态。
 * ⛔ 读不到文件时本轮不表态（不推 false，也不推 true）：文件不存在等于「没表过态」，
 *    由调用方的默认值兜底，不要用轮询结果覆盖它。
 */
export function subscribeHotkeyNotify(
    scope: HotkeyNotifyScope,
    cb: (on: boolean) => void,
    intervalMs: number = 400
): () => void {
    let stopped = false;
    let busy = false;
    let last: boolean | null = null;

    const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
            const st = await readRaw(scope);
            if (!st) return;
            cachedMap[scope] = st;
            if (last === null || st.on !== last) {
                last = st.on;
                try { cb(st.on); } catch (_) { /* 订阅方异常不影响轮询 */ }
            }
        } catch (_) {
            /* 读失败保持上一状态，下一次再试 */
        } finally {
            busy = false;
        }
    };

    const memNotify = () => { void tick(); };
    memListeners[scope].add(memNotify);
    const timer = setInterval(() => { void tick(); }, intervalMs);
    void tick();
    return () => {
        stopped = true;
        clearInterval(timer);
        memListeners[scope].delete(memNotify);
    };
}
