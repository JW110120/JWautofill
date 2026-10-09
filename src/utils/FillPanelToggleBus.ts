/**
 * FillPanelToggleBus —— 选区填充「纯色 / 图案 / 渐变」三个子面板开关的跨面板切换总线
 *
 * 背景（与 MainToggleBus 相同的面板隔离问题）：
 * UXP 每个面板都是独立 JS 上下文。子面板的展开状态（isColorSettingsOpen /
 * isPatternPickerOpen / isGradientPickerOpen）是 APP 面板（#app）的 React state，
 * 而功能快捷键浮窗挂在绘画工具箱面板（#pixeladjustment）——热键命中后广播到所有面板，
 * 任何面板都不能直接改 APP 面板的 state。
 *
 * 解法：共享「事件」而不是共享「状态」。热键命中方把 {panel, token} 写进共享文件，
 * APP 面板轮询到新修订号后执行一次开/关。token 按次命中生成（同一命中在所有面板上相同），
 * 已见过的 token 直接跳过——多面板同时写也只有第一次生效，事件绝不重复执行。
 *
 * 与 MainToggleBus（共享状态、幂等翻转）不同：这里翻的是 APP 面板自己的 state，
 * 文件里没有状态只有「命令」，所以必须靠 token 去重而不是靠状态幂等。
 */

export type FillPanelId = 'color' | 'pattern' | 'gradient';

const SETTINGS_FOLDER = 'settings';
const STATE_FILE = 'fill-panel-toggle.json';

interface FillPanelToggleEvent {
    panel: string;
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

async function readRaw(): Promise<FillPanelToggleEvent | null> {
    try {
        const folder = await getSettingsFolder();
        const file = await folder.getEntry(STATE_FILE);
        const content = await file.read({ format: getFormats().utf8 });
        const j = JSON.parse(content);
        if (!j || typeof j !== 'object' || !j.panel) return null;
        return {
            panel: String(j.panel),
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
 * 处理一次「热键命中」：把子面板切换命令写进共享文件。
 * 同一次命中在所有面板上用同一个 token 调用；文件里已是该 token 则跳过，
 * 保证无论多少个面板收到守护进程的广播，命令都只被写入/执行一次。
 */
export async function requestFillPanelToggle(panel: FillPanelId, token: string): Promise<void> {
    const run = writeChain.then(async () => {
        const cur = await readRaw();
        if (cur && cur.token === token) return; // 同一次命中已被处理过
        const next: FillPanelToggleEvent = { panel, token, rev: (cur?.rev || 0) + 1, ts: Date.now() };
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
// 注意：用 forEach 而不是 for...of——tsconfig target 是 es5 且未开 downlevelIteration，
// 直接迭代 Set 会报 TS2802（MainToggleBus 同位置已有一个同类预存错误，新文件不再重蹈）。
let cached: FillPanelToggleEvent | null = null;
const memListeners = new Set<() => void>();
function emitMem() { memListeners.forEach((l) => { try { l(); } catch { /* ignore */ } }); }

/**
 * 订阅子面板切换命令（默认每 250ms 轮询一次共享文件；写入后内存即时唤醒）。
 * 只有 APP 面板订阅：收到命令后由它翻自己的 state。
 */
export function subscribeFillPanelToggle(
    cb: (panel: FillPanelId) => void,
    intervalMs: number = 250
): () => void {
    let stopped = false;
    let busy = false;
    let last: FillPanelToggleEvent | null = cached;

    const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
            const ev = await readRaw();
            if (ev && (!last || ev.rev !== last.rev || ev.token !== last.token)) {
                last = ev;
                cached = ev;
                try { cb(ev.panel as FillPanelId); } catch (_) { /* 订阅方异常不影响轮询 */ }
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
