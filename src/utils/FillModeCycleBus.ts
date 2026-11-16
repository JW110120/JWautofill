/**
 * FillModeCycleBus —— 「切换填充模式」快捷键（默认 Ctrl+滚轮）的跨面板命令总线
 *
 * 为什么需要总线（与 MainToggleBus / ClearModeBus 同源的面板隔离问题）：
 * 热键命中发生在 .8li（PS 进程内）→ 经 WebSocket 广播给**所有** UXP 面板。
 * 任何面板都能收到 `runFunc / fillModeCycle`，但填充模式（fillMode）是 APP 面板
 * （#app）的 React state —— 别的面板改不了，也不该改。
 *
 * 解法与 ClearModeBus 完全一致：共享「事件」而不是共享「状态」。
 * 命中方把 {dir, token} 写进共享文件，APP 面板轮询到新修订号后**翻一次**；
 * 同一次命中在所有面板上算出同一个 token，先写者生效、后写者跳过，
 * 因此 N 个面板同时收到广播也只会切一格（不会按面板数量连跳）。
 *
 * ⚠️ 与 ClearModeBus 的区别只在载荷：那边是「开/关某个模式」，
 *    这边是「按方向前进一步」。⛔ 不复用同一个文件 —— 两个功能的写入频率、
 *    语义、订阅方都不同，混在一个修订号上会互相顶掉（一次滚轮吃掉一次面板开关）。
 */

/** 轮换方向：+1 = 下一个（滚轮向下），-1 = 上一个（滚轮向上）。 */
export type FillModeDir = 1 | -1;

const SETTINGS_FOLDER = 'settings';
const STATE_FILE = 'fill-mode-cycle.json';

interface FillModeCycleEvent {
    dir: number;
    token: string;
    rev: number;
    ts: number;
}

// UXP 的 uxp 模块在 webpack 打包后用静态 import 有时拿不到，统一走 require 兜底，
// 与 PanelStateManager / MainToggleBus 一致。
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

async function readRaw(): Promise<FillModeCycleEvent | null> {
    try {
        const folder = await getSettingsFolder();
        const file = await folder.getEntry(STATE_FILE);
        const content = await file.read({ format: getFormats().utf8 });
        const j = JSON.parse(content);
        if (!j || typeof j !== 'object' || !j.token) return null;
        return {
            dir: Number(j.dir) < 0 ? -1 : 1,
            token: typeof j.token === 'string' ? j.token : '',
            rev: Number(j.rev) || 0,
            ts: Number(j.ts) || 0,
        };
    } catch (_) {
        return null;
    }
}

// 同一上下文内串行化读-改-写：并发命中也不会写出两个不同的修订号
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * 处理一次「热键命中」：把轮换命令写进共享文件。
 * 同一次命中在所有面板上用同一个 token 调用；文件里已是该 token 则跳过。
 */
export async function requestFillModeCycle(dir: FillModeDir, token: string): Promise<void> {
    const run = writeChain.then(async () => {
        const cur = await readRaw();
        if (cur && cur.token === token) return; // 同一次命中已被处理过
        const next: FillModeCycleEvent = { dir, token, rev: (cur?.rev || 0) + 1, ts: Date.now() };
        const folder = await getSettingsFolder();
        const file = await folder.createFile(STATE_FILE, { overwrite: true });
        await file.write(JSON.stringify(next), { format: getFormats().utf8 });
        cached = next;
        emitMem();
    });
    // 即使某次失败也不能让锁链断裂
    writeChain = run.then(() => {}, () => {});
    return run;
}

// 内存缓存 + 同上下文即时通知（写入后立刻唤醒订阅方，不等下一轮文件轮询）
// 注意：用 forEach 而不是 for...of —— tsconfig target 是 es5 且未开 downlevelIteration，
// 直接迭代 Set 会报 TS2802（MainToggleBus 同位置已有一个同类预存错误，新文件不再重蹈）。
let cached: FillModeCycleEvent | null = null;
const memListeners = new Set<() => void>();
function emitMem() { memListeners.forEach((l) => { try { l(); } catch { /* ignore */ } }); }

/**
 * 订阅轮换命令（默认每 250ms 轮询一次共享文件；写入后内存即时唤醒）。
 * 只有 APP 面板订阅：收到命令后由它前进一步。
 */
export function subscribeFillModeCycle(
    cb: (dir: FillModeDir) => void,
    intervalMs: number = 250
): () => void {
    let stopped = false;
    let busy = false;
    let last: FillModeCycleEvent | null = cached;
    /* ⛔ 首次读取只「对表」不执行：文件里躺着的永远是**上一次会话**留下的最后一条命令，
       直接执行等于「每开一次面板 / 每重载一次插件，填充模式自己跳一格」。
       第一拍把 rev/token 记下来当作基线，之后只有**修订号变化**才算新命令。 */
    let primed = false;

    const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
            const ev = await readRaw();
            if (ev && !primed) {
                primed = true;
                last = ev;
                cached = ev;
            } else if (ev && (!last || ev.rev !== last.rev || ev.token !== last.token)) {
                last = ev;
                cached = ev;
                try { cb(ev.dir < 0 ? -1 : 1); } catch (_) { /* 订阅方异常不影响轮询 */ }
            } else if (!ev) {
                primed = true;   /* 文件还不存在：后续第一次出现就是真命令 */
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
