/**
 * HotkeyNotifyBus —— 「显示热键通知」的跨面板共享开关（2026-11-16）
 *
 * 需求（用户原话）：在 APP 面板菜单的「紧凑模式」下方、以及绘画工具箱菜单的
 * 「复位分区顺序」下方各加一个开关，开启时显示「显示热键通知 - 开」，关闭时显示
 * 「显示热键通知 - 关」；关闭后不再显示热键触发的通知，降低干扰。默认开启。
 *
 * 为什么用共享文件而不是各自存一份 state：
 *   「热键通知」有两处显示点，分属两个 JS 世界 ——
 *     · APP 面板：showAppHotkeyNotify（「选区平滑」分区上方那条 notify-bar）；
 *     · 绘画工具箱：BrushHotkeySection 的通用 msg 条（切笔刷 / 跑功能按钮）。
 *   两个菜单项改的是**同一个偏好**（用户不会认为「在 A 面板关掉了、B 面板还响」是
 *   合理行为）。做法与 MainToggleBus / FocusModeBus 完全一致：状态落插件数据目录，
 *   谁写谁落盘，另一方靠文件轮询 + 同上下文内存通知跟上，菜单文案随之同步。
 *
 * ⛔ 默认值必须是**开**：这是「降低干扰」的偏好项，用户没表过态时显示通知是原有的
 *    既有行为；文件不存在 / 内容损坏一律按开处理（读失败不能变成「静默吞掉全部反馈」，
 *    那会让「按键没反应」重新变成不可诊断的问题）。
 */

const SETTINGS_FOLDER = 'settings';
const STATE_FILE = 'hotkey-notify.json';

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

// 内存缓存：两个面板（若真的处在不同上下文）各自持有一份，靠轮询对齐
let cached: HotkeyNotifyState | null = null;

async function readRaw(): Promise<HotkeyNotifyState | null> {
    try {
        const folder = await getSettingsFolder();
        const file = await folder.getEntry(STATE_FILE);
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

let writeChain: Promise<unknown> = Promise.resolve();

/** 写入开关状态（串行化，避免两个菜单项几乎同时点击时交错覆盖）。 */
export function setHotkeyNotify(on: boolean): Promise<boolean> {
    const run = writeChain.then(async () => {
        const cur = (await readRaw()) ?? cached ?? EMPTY;
        if (cur.on === on) {
            cached = cur;
            return on;
        }
        const next: HotkeyNotifyState = { on, rev: (cur.rev || 0) + 1, ts: Date.now() };
        try {
            const folder = await getSettingsFolder();
            const file = await folder.createFile(STATE_FILE, { overwrite: true });
            await file.write(JSON.stringify(next), { format: getFormats().utf8 });
            cached = next;
        } catch (_) {
            // 落盘失败：内存仍按用户意图生效（本次会话可用），下次启动回默认
            cached = { ...next, rev: cur.rev || 0 };
        }
        emitMem();
        return on;
    });
    writeChain = run.then(() => {}, () => {});
    return run;
}

/**
 * 翻转开关（菜单项点击的唯一入口；两个面板的菜单项都调它）。
 * ⛔ 这里**不能**写成 `writeChain.then(() => setHotkeyNotify(!cur.on))`：
 *    setHotkeyNotify 会往同一条串行链上再排一次队，而那条链正等着本次任务结束
 *    ⇒ 自己等自己，永远不返回（菜单点了没反应）。写法与 setHotkeyNotify 同构。
 */
export function toggleHotkeyNotify(): Promise<boolean> {
    const run = writeChain.then(async () => {
        const cur = (await readRaw()) ?? cached ?? EMPTY;
        const on = !cur.on;
        const next: HotkeyNotifyState = { on, rev: (cur.rev || 0) + 1, ts: Date.now() };
        try {
            const folder = await getSettingsFolder();
            const file = await folder.createFile(STATE_FILE, { overwrite: true });
            await file.write(JSON.stringify(next), { format: getFormats().utf8 });
            cached = next;
        } catch (_) {
            cached = { ...next, rev: cur.rev || 0 };
        }
        emitMem();
        return on;
    });
    writeChain = run.then(() => {}, () => {});
    return run;
}

/**
 * **同步**读当前开关：供「要不要显示这条通知」的即时判断使用（通知是同步函数，
 * 等不了 await）。
 * ⛔ 未知（从未读过文件）时返回 **true**：默认开，绝不静默吞掉反馈。
 */
export function hotkeyNotifyOnSync(): boolean {
    return cached ? cached.on : true;
}

/** 读取当前开关（文件不存在时按默认开） */
export async function readHotkeyNotify(): Promise<boolean> {
    const st = await readRaw();
    if (st) cached = st;
    return cached ? cached.on : true;
}

// 同上下文内的即时通知：写入后立刻唤醒订阅方（跨面板仍由文件轮询兜底）
const memListeners = new Set<() => void>();
function emitMem() { for (const l of memListeners) { try { l(); } catch { /* ignore */ } } }

/**
 * 订阅开关变化（默认每 400ms 轮询一次文件），用于同步菜单文案。
 *
 * ⛔ `last` 必须从 `null` 起（**不能**用 `cached` 播种）：面板是后打开的，
 *    若用缓存播种，只要值没变就永远不回调 ⇒ 该面板的菜单文案停在上一次的文案上。
 *    从 null 起 ⇒ 首次读到有效值必回调一次，新订阅者一定拿到当前状态。
 * ⛔ 读不到文件时本轮不表态（不推 false，也不推 true）：文件不存在等于「没表过态」，
 *    由调用方的默认值兜底，不要用轮询结果覆盖它。
 */
export function subscribeHotkeyNotify(
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
            const st = await readRaw();
            if (!st) return;
            cached = st;
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
    memListeners.add(memNotify);
    const timer = setInterval(() => { void tick(); }, intervalMs);
    void tick();
    return () => {
        stopped = true;
        clearInterval(timer);
        memListeners.delete(memNotify);
    };
}
