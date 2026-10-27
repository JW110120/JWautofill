/**
 * 宿主交互态（0x0208）：让巡检在「用户正在宿主画布上拖拽/缩放」时让路
 * ==================================================================
 *
 * 要解决的问题（用户报）：加载插件后，用 PS 自带的缩放工具、或按住 Ctrl+空格 + 鼠标左键
 * 左右拖拽缩放时，原本流畅的缩放动画变得卡顿、抽搐。
 *
 * 根因（机制，先读这段再改代码）
 * ------------------------------------------------------------------
 * 缩放（含 Ctrl+空格 scrubby zoom）在 PS 里是**宿主主线程上的交互式动画**：每一帧都要
 * 重算视图并重绘画布。它不派发任何本插件注册过的 PS 通知事件
 * （见 `psAccess.PS_NOTIF_EVENTS`：set/select/delete/make/move/rename/open/close/save…），
 * 所以 `isPsBusy()` 全程为假 —— 面板那几条**常驻巡检**照常在动画期间发 `psRead()`。
 *
 * 而 `psRead()` 的本质是 `core.executeAsModal()`：它必须**独占宿主主线程**（模态作用域）。
 * 我们的巡检按 `MIN_MODAL_GAP_MS=300` 排队 ⇒ 稳态约 2.5~3 次/秒、精确每 333ms 一次
 * 模态进入；一次缩放动画只有 300~500ms ⇒ **每次缩放都会撞上 1~2 次**模态抢占。
 * 宿主为交出模态作用域必须中断当前交互 ⇒ 动画被劈成几段 ⇒ 用户看到的「卡顿、抽搐」。
 * （本仓历史上同一机制已被记录过一次：见 app.tsx `TOOL_WATCH_INTERVAL_MS` 处
 *   「生成选区后 PS 频繁读条等『获取当前工具』」——那条读条就是排不进模态队列的巡检。）
 *
 * 为什么不能让面板自己判断
 * ------------------------------------------------------------------
 * UXP 面板拿不到「宿主此刻是否在拖拽」：`document.hasFocus()` 在 PS 的停靠面板上语义
 * 不可靠，键盘/鼠标全局状态更是完全没有 API。而 .8li 在 PS 进程内本来就镜像着左键与
 * 修饰键（`keyhook.c` 的 WH_MOUSE_LL 镜像 + 键态轮询）⇒ 由它按**边沿**推送一条
 * `{"type":"hostBusy","v":0|1}`（约 30 字节，一次拖拽两帧）最省、最准。
 *
 * 判定口径（刻意窄，宁可漏判也不要误杀巡检）
 * ------------------------------------------------------------------
 *   busy = 左键按下 ∨ 空格按下
 *     · 左键：缩放工具拖拽、Ctrl+空格拖拽、任何鼠标拖拽；
 *     · 空格：PS 的抓手/缩放导航修饰键（不落笔时按空格 = 平移）。
 *   笔尖落笔**不算**（Wintab 通路里笔尖不是鼠标左键），所以正常绘画不受影响 ——
 *   绘画期的宿主忙碌由既有的 `isPsBusy()` + 通知事件负责，不在这里重复。
 *
 * 时效
 * ------------------------------------------------------------------
 * 只有边沿帧，拖拽过程中不会有新帧 ⇒ 不能给「忙」设短 TTL（长拖拽会被误判过期）。
 * 但也不能无限粘住（丢帧就永久停摆）⇒ `BUSY_MAX_MS` 兜底自愈。
 * 释放后再保持 `HOLD_AFTER_RELEASE_MS`：缩放的**动画是在松手之后才播完的**，
 * 松手瞬间立刻恢复巡检会把动画尾巴再撞一次。
 */

/** 「忙」态最长有效期：超过即视为丢帧，自动过期（自愈，绝不让巡检永久停摆）。 */
const BUSY_MAX_MS = 30000;

/**
 * 释放后的尾巴。PS 的 Animated Zoom 在松手后还要播完（约 200~400ms），
 * 留 700ms 覆盖整段动画与双击连缩。
 */
const HOLD_AFTER_RELEASE_MS = 700;

/** 观测：被让路跳过的巡检次数（排障/验收用，不进 UI）。 */
let yieldCount = 0;
let lastYieldLogAt = 0;

/** 0x0209：本轮「连续让路」的起点（0 = 当前没有在让路）。 */
let yieldChainStart = 0;

let busy = false;
let busyAt = 0;
let holdUntil = 0;

/**
 * 记录一帧宿主交互态（由 `HotkeyBridge` 的 `hostBusy` 消息驱动）。
 *
 * ⚠️ 若 .8li 是旧版（不推这条消息），本模块永远保持「不忙」⇒ 行为与改动前完全一致，
 *    不会因为缺消息而停掉任何巡检。这是刻意设计的降级路径。
 */
export function noteHostBusy(on: boolean): void {
    const now = Date.now();
    if (on) {
        busy = true;
        busyAt = now;
        holdUntil = 0;
        return;
    }
    if (busy) {
        busy = false;
        holdUntil = now + HOLD_AFTER_RELEASE_MS;
        /* 0x020A：**松开边沿**（只在此刻触发，且只触发一次）。
           用途：Alt 临时吸管下「一次吸色点击结束」= 左键（笔模拟的 down/up）走完一轮。
           判据与 busy 同源，不额外引入按键语义。 */
        for (const f of releaseHandlers) {
            try { f(); } catch { /* ignore */ }
        }
    }
}

/* ------------------------------------------------------------------ 0x020A：松开边沿订阅 */
type ReleaseHandler = () => void;
const releaseHandlers: ReleaseHandler[] = [];

/**
 * 订阅「宿主交互结束（左键/空格松开）」边沿。
 *
 * ⛔ 这是**边沿**，不是电平：一次按下-松开只回调一次。用户按住 Alt 拖动吸色时
 *    只在最后松手那一刻回调一次 —— 正是「一次取色结束」的语义。
 * ⚠️ 判据含空格（见模块头），订阅方必须自己确认「此刻我要不要响应」
 *    （临时吸管用 `altToolHold` 收口），不要把这里当精确的左键事件。
 */
export function onHostRelease(fn: ReleaseHandler): () => void {
    releaseHandlers.push(fn);
    return () => {
        const i = releaseHandlers.indexOf(fn);
        if (i >= 0) releaseHandlers.splice(i, 1);
    };
}

/** 此刻是否应当把巡检让给宿主（用户正在拖拽/缩放）。 */
export function isHostInteracting(): boolean {
    const now = Date.now();
    if (busy) {
        if (now - busyAt > BUSY_MAX_MS) {
            // 丢帧兜底：只在「太久没有任何边沿」时自愈，长拖拽不受影响
            busy = false;
            holdUntil = now;
            return false;
        }
        return true;
    }
    return holdUntil > now;
}

/**
 * 巡检入口的统一让路判据。
 *
 * @param label 巡检名（只用于节流日志，便于现场确认「到底是这条被让掉了」）
 * @param maxHoldMs 0 = 只让一次就够（默认，纯展示类巡检）；
 *                  >0 = **连续让路的上限**：超过它强制放行一轮。
 * @returns true = 本轮跳过（调用方直接 return）
 *
 * ⚠️ 跳过 ≠ 停摆：定时器照常，下一拍（≤1s）会重新判断；任何事件驱动通路
 *    （PS 通知 / 进程内 'slct' / 文档级事件）都不经过这里，时效性不受影响。
 *
 * ⛔⛔ 0x0209：`maxHoldMs` 是**修 BUG 用的**，不是调参空间。
 *    起因（用户报）：「切到涂抹工具后长按笔涂抹，HUD 仍错误显示；随后切回套索，
 *    平滑前半段正常、中途失效，停笔时 PS 自己从选区末端画一条直线到笔尖」。
 *    链条：笔尖落笔会模拟左键（`hostBusy` 判据含 VK_LBUTTON）⇒ 只要用户在画，
 *    让路就**永不结束** ⇒ 工具巡检整段停摆 ⇒ `CFG_I_TOOLGATE` 冻在切走前的 1
 *    ⇒ 引擎一直以为还在套索。而工具闸门是**正确性判据**（它决定要不要改写坐标），
 *    不能像「快速蒙版状态」那样无限期不更新。
 *    ⇒ 工具类巡检传 900ms：缩放动画只有 300~500ms，仍然一次都不会被打断；
 *      而长时间按着（涂抹/长笔）每 900ms 一定会读一次工具，1s 内纠正闸门。
 */
export function hostYield(label: string, maxHoldMs = 0): boolean {
    if (!isHostInteracting()) {
        yieldChainStart = 0;
        return false;
    }
    const now = Date.now();
    if (!yieldChainStart) yieldChainStart = now;
    if (maxHoldMs > 0 && now - yieldChainStart >= maxHoldMs) {
        // 连续让路已达上限 ⇒ 强行放行一轮，并把链起点推到现在（下一次再等这么久）
        yieldChainStart = now;
        if (now - lastYieldLogAt >= 5000) {
            lastYieldLogAt = now;
            console.log(`[交互让路] 连续让路超过 ${maxHoldMs}ms ⇒ 强制放行一轮（${label}）`);
        }
        return false;
    }
    yieldCount += 1;
    if (now - lastYieldLogAt >= 5000) {      // 节流：一次拖拽只留一行证据
        lastYieldLogAt = now;
        console.log(`[交互让路] 宿主正在拖拽/缩放 ⇒ 跳过巡检（${label}，累计 ${yieldCount} 次）`);
    }
    return true;
}

/** 观测快照（`__jwHostBusy()` 挂在 window 上，见下）。 */
export function hostInteractionStats(): { busy: boolean; holdMs: number; yields: number } {
    const now = Date.now();
    return {
        busy: isHostInteracting(),
        holdMs: busy ? Math.max(0, BUSY_MAX_MS - (now - busyAt)) : Math.max(0, holdUntil - now),
        yields: yieldCount,
    };
}

/**
 * 挂调试入口（与 psAccess 的 `__jwPs` 同款）：
 *   `__jwHostBusy()` → `{ busy, holdMs, yields }`
 *
 * 验收用法：狂拖缩放后调一次 —— `yields` 明显增长 ⇒ 让路真的在发生；
 * `busy` 若恒为 false 且 yields=0 ⇒ **.8li 没在推 hostBusy**（旧版模块 / 18923 未连上），
 * 那就说明这一层没生效，需要先查 WS 与模块版本，而不是继续调参。
 */
try {
    (globalThis as any).__jwHostBusy = hostInteractionStats;
} catch { /* 环境不支持时静默 */ }
