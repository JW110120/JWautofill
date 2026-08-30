/**
 * MainToggleBus —— 「选区填充」主开关的跨面板共享总线
 *
 * 背景（本文件存在的唯一理由）：
 * UXP 的**每个面板都是各自独立的 JS 上下文**，模块级变量、闭包、React state 全都不共享。
 * `#app`（选区填充）与 `#pixeladjustment`（绘画工具箱）虽然共用同一个 index.html / bundle.js，
 * 但运行时是两份互不相通的 JS 世界。因此：
 *   - 在 app.tsx 里 `registerMainToggleHandler(...)` 注册的回调，只有 App 面板自己的那份
 *     HotkeyBridge 模块能看到；绘画工具箱面板收到的热键事件里它是 null，压根不会被执行；
 *   - 反过来，只要 App 面板的 componentDidMount 在建立热键链路之前被任何 await 卡住/抛错，
 *     它就连守护进程的 WebSocket 都建不起来，热键广播根本到不了它。
 * 两者都会表现为「笔刷面板有文字提示、主面板开关纹丝不动」。
 *
 * 解法：把开关**状态**而不是**事件**放到两个面板都够得着的地方——
 * 插件数据目录（PluginData）下的一个 JSON 文件。该目录由 UXP 按插件 id 分配，
 * 同一插件的所有面板共用（PanelStateManager 的 panel-state.json 早已验证这一点：
 * 同一份文件里同时存着 appPanel 与 adjustmentPanel 两棵状态树）。
 *
 * 为什么共享「状态」而不是共享「切换命令」：
 * 事件在多面板下会被重复投递（守护进程是向所有客户端广播的），重复执行一次 toggle
 * 就等于「切了又切回来」，表现仍然是「没反应」。而状态是幂等的：
 *   - 两个面板同时读到 {enabled:false} → 都算出 true → 写进文件的值一致 → 应用一次；
 *   - 后读到的面板发现文件里的 token 已经是本次命中的 token → 直接跳过，不再翻转。
 * 两种交错顺序下都只会翻一次，这是本设计的关键。
 */

export type MainToggleState = {
    enabled: boolean;
    /** 单调递增的修订号：订阅方据此判断「有没有变过」 */
    rev: number;
    /**
     * 本次写入的令牌。同一次热键命中在所有面板上生成相同的 token，
     * 用来防止同一个命中被多个面板各翻转一次（详见文件头说明）。
     */
    token: string;
    ts: number;
};

const SETTINGS_FOLDER = 'settings';
const STATE_FILE = 'main-toggle.json';

// UXP 的 uxp 模块在 webpack 打包后用静态 import 有时拿不到，统一走 require 兜底，
// 与 PanelStateManager 一致。
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

async function readRaw(): Promise<MainToggleState | null> {
    try {
        const folder = await getSettingsFolder();
        const file = await folder.getEntry(STATE_FILE);
        const content = await file.read({ format: getFormats().utf8 });
        const j = JSON.parse(content);
        if (!j || typeof j !== 'object') return null;
        return {
            enabled: !!j.enabled,
            rev: Number(j.rev) || 0,
            token: typeof j.token === 'string' ? j.token : '',
            ts: Number(j.ts) || 0,
        };
    } catch (_) {
        // 文件不存在 / 内容损坏：一律当作「还没有共享状态」
        return null;
    }
}

async function writeRaw(next: MainToggleState): Promise<void> {
    const folder = await getSettingsFolder();
    const file = await folder.createFile(STATE_FILE, { overwrite: true });
    await file.write(JSON.stringify(next), { format: getFormats().utf8 });
}

// 内存缓存：避免订阅轮询期间反复回读同一个修订
let cached: MainToggleState | null = null;

// 同一上下文内对「翻转」做串行化：把 read-modify-write 锁进一条 promise 链，
// 即便将来又出现并发调用（例如仍是多连接），也不会因 await 让出线程而读到同一个旧值、各翻一次。
let toggleChain: Promise<unknown> = Promise.resolve();
async function doToggle(token: string): Promise<MainToggleState> {
    const cur = (await readRaw()) ?? cached ?? EMPTY;
    if (cur.token && cur.token === token) return cur; // 同一次命中已被处理过
    return setMainToggle(!cur.enabled, token);
}

const EMPTY: MainToggleState = { enabled: false, rev: 0, token: '', ts: 0 };

// 同上下文内的「即时通知」：写入成功后立刻唤醒订阅方，无需等下一轮文件轮询。
// 跨面板/跨会话的兜底仍由文件轮询负责；两者走同一套 tick 逻辑，幂等无副作用。
const memListeners = new Set<() => void>();
function emitMem() { for (const l of memListeners) { try { l(); } catch { /* ignore */ } } }

/** 读取当前共享状态（文件不存在时返回 rev=0 的空状态） */
export async function readMainToggle(): Promise<MainToggleState> {
    const st = await readRaw();
    if (st) cached = st;
    return cached ?? EMPTY;
}

/**
 * 播种：文件不存在时用面板自己持久化的值初始化，文件已存在则直接返回既有值。
 * App 面板启动后调用一次，保证「共享状态」与「面板持久化状态」在首次使用时对齐，
 * 且不会用面板的初值覆盖掉上一次会话留下来的真实状态。
 */
export async function seedMainToggle(enabled: boolean): Promise<MainToggleState> {
    const existing = await readRaw();
    if (existing) {
        cached = existing;
        return existing;
    }
    const next: MainToggleState = { enabled, rev: 1, token: 'seed', ts: Date.now() };
    try {
        await writeRaw(next);
        cached = next;
    } catch (_) {
        cached = { ...next, rev: 0 };
    }
    return cached;
}

/** 直接把共享状态写成指定值（用户手动点开关时用，主面板是唯一的人工写入方） */
export async function setMainToggle(enabled: boolean, token?: string): Promise<MainToggleState> {
    const cur = (await readRaw()) ?? cached ?? EMPTY;
    const next: MainToggleState = {
        enabled,
        rev: (cur.rev || 0) + 1,
        token: token ?? ('manual:' + Date.now()),
        ts: Date.now(),
    };
    await writeRaw(next);
    cached = next;
    emitMem(); // 同上下文内即时通知，不等文件轮询
    return next;
}

/**
 * 处理一次「热键命中」：翻转共享状态。
 * 同一次命中在所有面板上用同一个 token 调用；已经在文件里看到该 token 的面板直接跳过，
 * 因此无论有多少个面板收到了守护进程的广播，状态都只翻一次。
 */
export async function requestMainToggle(token: string): Promise<MainToggleState> {
    const run = toggleChain.then(() => doToggle(token));
    // 即使某次失败也不能让锁链断裂，否则后续翻转全部卡死
    toggleChain = run.then(() => {}, () => {});
    return run;
}

/**
 * 订阅共享状态变化（默认每 250ms 轮询一次文件）。
 * 这是 App 面板不依赖自身 WebSocket 也能收到其它面板热键的兜底通道。
 */
export function subscribeMainToggle(
    cb: (st: MainToggleState) => void,
    intervalMs: number = 250
): () => void {
    let stopped = false;
    let busy = false;
    let last: MainToggleState | null = cached;

    const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
            const st = await readRaw();
            if (st && (!last || st.rev !== last.rev || st.token !== last.token)) {
                last = st;
                cached = st;
                try { cb(st); } catch (_) { /* 订阅方异常不影响轮询 */ }
            }
        } catch (_) {
            /* 读失败保持上一状态，下一次再试 */
        } finally {
            busy = false;
        }
    };

    // 同上下文内：写入后即时唤醒（不等文件轮询）；同时保留兜底文件轮询（跨面板/会话）。
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
