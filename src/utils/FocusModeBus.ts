/**
 * FocusModeBus —— 「专注模式」的跨面板共享开关
 *
 * 专注模式不是用户直接勾选的选项，而是由 APP 父面板的两个选项推导出来的：
 *   「自动关开关」(autoOffOnOtherTool) 与「自动切套索」(switchToLassoOnEnable) 同时勾选 → 专注模式开启。
 * 它的消费者却在另外两个地方：
 *   1) MainToggleBus.doToggle：决定主开关热键是「翻转」还是「只开不关」；
 *   2) 绘画工具箱的笔刷热键分区：决定置顶那条记录显示「选区填充开关」还是「选区填充」。
 * 这两处的 JS 上下文与 APP 父面板都不相通（见 MainToggleBus 头部说明），
 * 所以和主开关一样，把**状态**落在插件数据目录的共享文件里，由 APP 面板单向写入、其它上下文轮询读取。
 */

const SETTINGS_FOLDER = 'settings';
const STATE_FILE = 'focus-mode.json';

type FocusModeState = {
    focus: boolean;
    /** 单调递增的修订号：订阅方据此判断「有没有变过」 */
    rev: number;
    ts: number;
};

const EMPTY: FocusModeState = { focus: false, rev: 0, ts: 0 };

// 与 MainToggleBus / PanelStateManager 一致：webpack 打包后静态 import 有时拿不到 uxp，统一 require 兜底
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

// 内存缓存：热键翻转时每次都读一遍文件，缓存只用于「读不到文件时」的兜底与订阅去重
let cached: FocusModeState | null = null;

async function readRaw(): Promise<FocusModeState | null> {
    try {
        const folder = await getSettingsFolder();
        const file = await folder.getEntry(STATE_FILE);
        const content = await file.read({ format: getFormats().utf8 });
        const j = JSON.parse(content);
        if (!j || typeof j !== 'object') return null;
        return { focus: !!j.focus, rev: Number(j.rev) || 0, ts: Number(j.ts) || 0 };
    } catch (_) {
        // 文件不存在 / 内容损坏：一律当作「未开启」
        return null;
    }
}

/** 读取当前专注模式状态（文件不存在时视为关闭） */
export async function readFocusMode(): Promise<boolean> {
    const st = await readRaw();
    if (st) cached = st;
    return cached?.focus ?? false;
}

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * 写入专注模式状态（仅 APP 父面板调用：它是两个前置选项的唯一持有者）。
 * 串行化写入，避免勾选变化与热键翻转同时发生时的交错覆盖。
 */
export function setFocusMode(on: boolean): Promise<boolean> {
    const run = writeChain.then(async () => {
        const cur = (await readRaw()) ?? cached ?? EMPTY;
        if (cur.focus === on) {
            cached = cur;
            return on;
        }
        const next: FocusModeState = { focus: on, rev: (cur.rev || 0) + 1, ts: Date.now() };
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

// 同上下文内的即时通知：写入后立刻唤醒订阅方，跨面板仍由文件轮询兜底
const memListeners = new Set<() => void>();
function emitMem() { for (const l of memListeners) { try { l(); } catch { /* ignore */ } } }

/** 订阅专注模式变化（默认每 400ms 轮询一次文件） */
export function subscribeFocusMode(
    cb: (focus: boolean) => void,
    intervalMs: number = 400
): () => void {
    let stopped = false;
    let busy = false;
    let last: boolean | null = cached?.focus ?? null;

    const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
            const st = await readRaw();
            const focus = st?.focus ?? false;
            if (st) cached = st;
            if (last === null || focus !== last) {
                last = focus;
                try { cb(focus); } catch (_) { /* 订阅方异常不影响轮询 */ }
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
