/**
 * BlendModeBus —— 「选区填充混合模式」的跨面板共享**事件**总线
 *
 * 背景（与 ClearModeBus / FillPanelToggleBus 同款）：
 * 混合模式（blendMode，中文名，如「变暗」）是 APP 面板（#app）的 React state，
 * 填充时写进 batchPlay 描述符（app.tsx 的 fill/stroke 各处的 blendMode 字段）。
 * 触发它的入口：
 *   1) APP 面板自己的下拉选择（本上下文内，直接 setState）；
 *   2) 混合模式热键（.8li 捕获 PS 原生 Alt+Shift+<key> 后广播 action='blendMode'，
 *      HotkeyBridge 活在绘画工具箱面板的 JS 上下文，够不到 APP 面板的 state）。
 *
 * 解法：共享「事件」。命中方把 { mode, token } 写进共享文件，APP 面板轮询到
 * 新修订号后应用一次。token 按次命中生成并去重 —— 多面板同时写也只有第一次生效。
 *
 * mode 载荷 = PS 枚举值（normal/darken/…，与 constants/blendModes.ts 的 value 对齐），
 * 由 APP 面板映射回中文名再 setState（面板内部一律用中文名）。
 */

const SETTINGS_FOLDER = 'settings';
const STATE_FILE = 'blend-mode-toggle.json';

interface BlendModeEvent {
    mode: string;
    token: string;
    rev: number;
    ts: number;
}

// UXP 的 uxp 模块在 webpack 打包后用静态 import 有时拿不到，统一走 require 兜底，
// 与 PanelStateManager / MainToggleBus / FillPanelToggleBus 一致。
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

async function readRaw(): Promise<BlendModeEvent | null> {
    try {
        const folder = await getSettingsFolder();
        const file = await folder.getEntry(STATE_FILE);
        const content = await file.read({ format: getFormats().utf8 });
        const j = JSON.parse(content);
        if (!j || typeof j !== 'object' || !j.mode) return null;
        return {
            mode: String(j.mode),
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
 * 处理一次「混合模式热键命中」：把目标混合模式写进共享文件。
 * 同一次命中在所有面板上用同一个 token 调用；文件里已是该 token 则跳过，
 * 保证无论多少个面板收到 .8li 的广播，命令都只被写入/执行一次。
 */
export async function requestBlendMode(mode: string, token: string): Promise<void> {
    const run = writeChain.then(async () => {
        const cur = await readRaw();
        if (cur && cur.token === token) return; // 同一次命中已被处理过
        const next: BlendModeEvent = { mode, token, rev: (cur?.rev || 0) + 1, ts: Date.now() };
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
let cached: BlendModeEvent | null = null;
const memListeners = new Set<() => void>();
function emitMem() { memListeners.forEach((l) => { try { l(); } catch { /* ignore */ } }); }

/**
 * 订阅混合模式切换命令（默认每 250ms 轮询一次共享文件；写入后内存即时唤醒）。
 * 只有 APP 面板订阅：收到命令后由它映射中文名并 setState。
 */
export function subscribeBlendMode(
    cb: (mode: string) => void,
    intervalMs: number = 250
): () => void {
    let stopped = false;
    let busy = false;
    let last: BlendModeEvent | null = cached;

    const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
            const ev = await readRaw();
            if (ev && (!last || ev.rev !== last.rev || ev.token !== last.token)) {
                last = ev;
                cached = ev;
                try { cb(ev.mode); } catch (_) { /* 订阅方异常不影响轮询 */ }
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
