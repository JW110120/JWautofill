import { action, core } from 'photoshop';
import {
    extendDocLatch, getDocGeneration, isPsBusy, noteHostResponsive, noteHostUnresponsive,
    isDocLevelDescriptor, isDocLatchActive, getDocLatchAgeMs, getHostLeaseState
} from './psProbe';

/**
 * PS 访问层（Photoshop Access Layer）
 * ============================================================================
 * 为什么存在
 * ----------------------------------------------------------------------------
 * 宿主弹出的「命令"获取"当前不可用」原生报错框**绕过 JS try/catch 与
 * `dialogOptions`**，因此历史上唯一可靠的防护是「不发出 get」—— 于是全仓把
 * 正确性寄托在「等得够久」（`isPsBusy()` 的时间窗口）上。凡是缩短等待、减少
 * 往返、改变读取时机的优化，都会让报错按比例复现。
 *
 * 本模块把这条隐藏依赖**从时序里解耦**：所有 PS 读取经由 `psRead()` 进入
 * `core.executeAsModal()` 的**模态作用域**。`executeAsModal` 是 PS 官方的
 * 互斥/序列化原语（本仓写路径早已依赖它）：
 *   · PS 空闲 ⇒ 立即授予，读取照常；
 *   · PS 正忙 ⇒ 排队等待，或 reject 一个 Promise ——
 *     无论哪种，**都是可捕获的**，绝不会变成宿主原生弹框。
 * ⇒ 「不可捕获的宿主弹框」被降级为「可捕获的失败」，正确性不再依赖时间常数。
 *
 * ⚠️ 已确认的宿主语义（Adobe 文档，2026-10-08 核对）
 * ----------------------------------------------------------------------------
 *   · `executeAsModal` 自 25.10 起是「**排队等待**」而非「立即拒绝」：请求会重试直到
 *     阻塞的模态状态结束，或超出 `timeOut`（**默认 1 秒**）才报错；
 *   · 冲突时报错码固定为 `error.number === 9`（消息在不同版本间变过）；
 *   · PS 自己执行 `open` / `close` / `save` 等命令时会握着模态作用域，而 `open`
 *     事件正是在**这个作用域之内**派发给插件的 ⇒ 收到 `open` 时立刻读必被拒。
 * ⇒ 失败即失败：**绝不**降级为裸读（裸 get 才是原生弹框的来源），改为延长
 *   文档级闩锁 + 有界退避（见 `psProbe.extendDocLatch`）。
 *
 * 分层职责（不要混淆）
 * ----------------------------------------------------------------------------
 *   · `psProbe.isPsBusy()` = **粗筛**：明显还在忙 ⇒ 快速失败、不排队（省一次
 *     模态进出的开销）。它是优化，**不是**正确性依据。
 *   · 本模块 `psRead()` = **正确性兜底**：即使粗筛判断失误，宿主也不会弹框。
 *   · 本模块 `probeHostIdle()` = **闩锁出口**：只拿锁不读数据，用来判定
 *     「宿主是否已可控」，是文档级闩锁唯一的释放判据。
 *   · 写路径（fill / stroke / 蒙版同步）继续用自己的 `executeAsModal`，不走本模块。
 */

/** 一次读取所需的最小配置。省略即用默认值。 */
export interface PsReadOptions {
    /** 模态命令名（PS 会在状态栏/历史中显示，便于用户理解「插件在读什么」）。 */
    label?: string;
    /** `executeAsModal` 被拒后的重发次数（有界退避）。默认 2（共 3 次尝试）。 */
    retries?: number;
    /** 首次退避时长（ms），每次翻倍。默认 120。 */
    retryDelayMs?: number;
    /**
     * 是否校验「文档世代号」。默认 `true`。
     * 读取期间若发生了文档级变化（切文档/打开/关闭），结果可能来自已销毁的文档
     * ⇒ 返回失败，由调用方在下一个空闲窗口重读。
     */
    guardGeneration?: boolean;
    /**
     * 跳过粗筛（`isPsBusy()`）直接进模态作用域。默认 `false`。
     *
     * ⚠️ 只给「宿主空闲探测」这类**必须穿透闩锁**的通路用：闩锁期间粗筛恒为真，
     * 否则探测永远出不去、闩锁永远不释放（自锁）。
     */
    bypassCoarseGate?: boolean;
    /**
     * 交给 `executeAsModal` 的排队时限（毫秒）。默认 1000（宿主默认值）。
     *
     * 宿主语义（Adobe 文档，25.10 起）：请求先**排队**重试，直到阻塞的模态状态
     * 结束或超出该时限才报错。所以这个值越大越容易「等到」宿主空闲，越小越快失败。
     * 轮询类读取用小值（快速失败、下一轮再来），用户操作类读取用默认值。
     */
    timeOutMs?: number;
}

/** 读取结果：`ok:false` 表示「没读到」，**不等同于**「读到的值是 null」。 */
export type PsReadResult<T> = { ok: true; value: T } | { ok: false };

/* ------------------------------------------------------------------ *
 * 通知监听（逐事件名容错注册）
 * ------------------------------------------------------------------ */

/**
 * 本插件关心的 PS 通知事件（**唯一事实来源**，各面板统一从这里取）。
 *
 * ⚠️ 为什么必须包含 `open` / `close`（2026-10-08 根因 R2）：
 * 打开大 PSD、关闭文档是全流程里**耗时最长**的两条命令，而历史上没有任何
 * 监听器注册它们 ⇒ 整个解析/建树/teardown 期间 `isPsBusy()` 恒为 false，
 * 300ms 轮询照常发 get ⇒ 必弹框。这解释了「首次切换报错 → 速切不报错 →
 * **关闭再打开来回切又报错**」的诡异模式（关闭路径根本没有闸门）。
 *
 * 事件名取自 Action 事件表；若某宿主版本不支持某个名字，**逐名注册**（见下）
 * 保证它不会拖垮其余监听。
 *
 * `save` 与 `open` / `close` 同类（2026-10-08 第二轮补）：保存大文档同样是「PS 自己
 * 握着模态作用域、长达数秒」的命令，插件期间的 get 会被拒 —— 论坛上的复现条件正是
 * 「保存 / 拼合 / 打开时随机弹框」。
 */
export const PS_NOTIF_EVENTS: readonly string[] = [
    'set',
    'select',
    'clearEvent',
    'delete',
    'make',
    'open',
    'close',
    'save',
];

/**
 * 逐个注册通知监听。
 *
 * ⚠️ UXP 对**数组**中的非法事件名会**整体抛错**（`Argument 1 has an invalid
 * type` 一类），使整批监听全部失效。逐个注册 + 各自 try/catch 后，即使某个
 * 宿主版本不认识 `open` / `close`，其余事件仍然生效。
 */
export function addPsNotificationListeners(
    handler: (eventName?: any, descriptor?: any) => void,
    events: readonly string[] = PS_NOTIF_EVENTS
): void {
    const wrapped = wrapDocLevelLogger(handler);
    for (const evt of events) {
        try {
            action.addNotificationListener([evt] as any, wrapped as any);
        } catch (e) {
            console.warn(`⚠️ 通知监听注册失败（已跳过）: ${evt}`, e);
        }
    }
}

/** `addPsNotificationListeners` 的对称操作（同样逐名容错）。 */
export function removePsNotificationListeners(
    handler: (eventName?: any, descriptor?: any) => void,
    events: readonly string[] = PS_NOTIF_EVENTS
): void {
    const wrapped = wrapDocLevelLogger(handler);
    for (const evt of events) {
        try {
            action.removeNotificationListener([evt] as any, wrapped as any);
        } catch (e) {
            console.warn(`⚠️ 通知监听注销失败（已跳过）: ${evt}`, e);
        }
    }
}

/**
 * 给通知回调套一层「文档级事件固定日志」。
 *
 * ⚠️ 为什么固定开（不是 trace 开关下才开）：`open` / `close` / `save` 三个事件名
 * 是本仓库唯一**无法离线验证**的假设（UXP 的事件名存在重命名先例）。它们是文档级
 * 闩锁的唯一触发源，一旦不被派发就是「打开/关闭文档全程无闸门」。三者的派发频率
 * 极低（只有开关/保存文档时各一次），因此无条件打印一行日志是**零噪声**的，
 * 而它换来的是「真机上到底有没有收到、事件名长什么样」这一决定性证据：
 *   · 控制台出现 `📂 [PS事件] open` ⇒ 事件通路正常，问题在闩锁的保持/释放；
 *   · 完全不出现 ⇒ 事件名不对（或未被派发），兜底巡检是唯一防线。
 */
function wrapDocLevelLogger(
    handler: (eventName?: any, descriptor?: any) => void
): (eventName?: any, descriptor?: any) => void {
    return (eventName?: any, descriptor?: any) => {
        try {
            if (isDocLevelDescriptor(eventName, descriptor)) {
                console.log(`📂 [PS事件] ${String(eventName)} @${Date.now()}（文档级）`);
            }
        } catch { /* 日志失败绝不能影响通知处理 */ }
        handler(eventName, descriptor);
    };
}

/* ------------------------------------------------------------------ *
 * 诊断面包屑（真机取证）
 * ------------------------------------------------------------------ *
 * 宿主原生「命令"获取"当前不可用」弹框**绕过 JS try/catch**：我们能捕获到异常，
 * 但框已经弹出来了。因此排查方向只有一个 —— 看「**在框出现之前，插件最后发出的
 * 那次读取是什么**」。这里维护一个环形缓冲，记录每次读取的标签与结果。
 *
 * 用法（UXP Developer Tool 控制台）：
 *   `__jwPs.dump()`   → 打印最近 60 条读取面包屑（含失败原因）
 *   `__jwPs.state()`  → 打印闸门当前状态（粗筛剩余 / 闩锁年龄 / 租约连击）
 *   `__jwPs.trace(true)` → 之后每次读取都实时打印一行
 */
const ACCESS_LOG_MAX = 240;
const accessLog: string[] = [];
let accessSeq = 0;
let traceEnabled = false;

/** 记一条「即将/刚刚发起 PS 读取」的面包屑（同步、零 IPC、开销可忽略）。 */
export function markPsAccess(label: string, result?: 'ok' | 'fail' | 'skip'): void {
    accessSeq++;
    const line = `#${accessSeq} +${Date.now()} ${result ? `[${result}]` : '[→]'} ${label}`;
    accessLog.push(line);
    if (accessLog.length > ACCESS_LOG_MAX) accessLog.splice(0, accessLog.length - ACCESS_LOG_MAX);
    if (traceEnabled) {
        console.log(`[PS访问] ${line}`);
    } else if (result === 'fail') {
        // 失败一律留痕（节流 1s，避免文档级忙碌期刷屏）：
        // 若宿主真的弹了「命令"获取"当前不可用」，这一行就是**框之前最后的自述**。
        const now = Date.now();
        if (now - lastFailWarnAt > 1000) {
            lastFailWarnAt = now;
            console.warn(`⚠️ [PS访问失败] ${label}（完整面包屑：控制台执行 __jwPs.dump()）`);
        }
    }
}
let lastFailWarnAt = 0;

/** 打印最近 `limit` 条读取面包屑。 */
export function dumpPsAccessLog(limit = 60): void {
    console.log(accessLog.slice(-Math.max(1, limit)).join('\n'));
}

/** 打印闸门与租约的当前状态。 */
export function dumpPsGateState(): void {
    const lease = getHostLeaseState();
    console.log(
        `[PS闸门] busy=${isPsBusy()} latch=${isDocLatchActive()} latchAge=${getDocLatchAgeMs()}ms ` +
        `okStreak=${lease.streak} lastOk=${lease.lastOkAt < 0 ? 'never' : `${Date.now() - lease.lastOkAt}ms ago`} ` +
        `leaseValid=${lease.valid}`
    );
}

/** 开关实时 trace（排查时打开，平时关着以免刷屏）。 */
export function setPsTrace(on: boolean): void {
    traceEnabled = !!on;
    console.log(`[PS访问] trace = ${traceEnabled}`);
}

// 挂到 globalThis：UXP 控制台可直接调用 `__jwPs.dump()`。
try {
    (globalThis as any).__jwPs = {
        dump: dumpPsAccessLog,
        state: dumpPsGateState,
        trace: setPsTrace,
    };
} catch { /* 环境不支持时静默 */ }

/* ------------------------------------------------------------------ *
 * 模态作用域
 * ------------------------------------------------------------------ */

/**
 * 当前是否**已经**处于本插件的模态作用域内。
 *
 * ⚠️ 为什么必须先判断：UXP 的 `executeAsModal` **不可嵌套**（在模态作用域内
 * 再次调用会抛错）。凡是会被「外层已持模态作用域」的调用方复用的读取
 * （最典型：填充路径在 `executeAsModal` 内调 `getActiveLayerInfo()`），
 * 都必须走这里的直读分支，否则会在改造后立刻报错。
 *
 * 退化路径：宿主未提供 `core.isModal` 时用本模块自己的重入计数兜底。
 */
export function isInOwnModalScope(): boolean {
    const isModal = (core as any)?.isModal;
    if (typeof isModal === 'function') {
        try {
            return !!isModal.call(core);
        } catch {
            /* 落到计数兜底 */
        }
    }
    return readonlyDepth > 0;
}

/** 兜底用的重入深度（仅在宿主没有 `core.isModal` 时参与判断）。 */
let readonlyDepth = 0;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 在**受保护的模态作用域**内执行一次 PS 读取。
 *
 * 语义（务必整段读完再调用）：
 *   ① 已在自家模态作用域内 ⇒ 直读。此刻宿主不会拒 get，且嵌套会抛错，**必须**直读；
 *   ② 粗筛判定仍忙碌 ⇒ 立刻返回 `{ok:false}`（**不排队**）。调用方应把「没读到」
 *      当作正常结果处理（跳过本轮，等下一次事件/轮询），而不是错误；
 *   ③ 否则进 `executeAsModal`；被拒 ⇒ 有界退避重发；仍失败 ⇒ `{ok:false}`。
 *
 * @returns `{ok:true,value}` 或 `{ok:false}`；**永不抛异常**。
 *          ⚠️ 需要区分「没读到」与「读到的值是 null」时用本函数（如活动文档 id）；
 *          只关心值时用 `psRead` 更省事。
 */
export async function psTryRead<T>(
    fn: () => Promise<T> | T,
    opts: PsReadOptions = {}
): Promise<PsReadResult<T>> {
    const label = opts.label || '读取 Photoshop 状态';
    const retries = Math.max(0, opts.retries ?? 2);
    const guard = opts.guardGeneration !== false;

    // ① 已在模态作用域内：直读（嵌套 executeAsModal 会被宿主拒绝）
    if (isInOwnModalScope()) {
        try {
            const value = await fn();
            noteHostResponsive();
            return { ok: true, value };
        } catch {
            noteHostUnresponsive();
            return { ok: false };
        }
    }

    // ② 粗筛：明显还在忙 ⇒ 快速失败，本轮不做无谓的等待
    //    （宿主空闲探测刻意用 bypassCoarseGate 穿透它，否则闩锁无法释放）
    if (!opts.bypassCoarseGate && isPsBusy()) return { ok: false };

    const gen = getDocGeneration();
    let delay = Math.max(0, opts.retryDelayMs ?? 120);

    // ③ 模态作用域内读取 + 有界退避重发
    readonlyDepth++;
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                const value = await core.executeAsModal(
                    async () => await fn(),
                    {
                        commandName: label,
                        interactive: false,
                        timeOut: Math.max(0, opts.timeOutMs ?? 1000),
                    } as any
                );
                // 读取期间若发生文档级变化（切文档/打开/关闭）⇒ 数据可能来自
                // 已销毁的文档，作废本次结果（根因 R2 的直接后果）。
                if (guard && getDocGeneration() !== gen) {
                    noteHostResponsive();   // 宿主确实答了（只是世代号变了）
                    markPsAccess(`${label}（世代号已变，作废）`, 'skip');
                    return { ok: false };
                }
                // ✅ 宿主答了 ⇒ 这是**肯定式证据**：get 通道刚才畅通。
                //    同步裸读的租约据此续期（见 psProbe.canSyncReadHost）。
                noteHostResponsive();
                markPsAccess(label, 'ok');
                return { ok: true, value };
            } catch (e) {
                // ⚠️⚠️ 宿主「有自己的模态作用域在跑」（打开/关闭/保存大文档、
                // 拼合、其它插件持锁）时的正确反应是**退避，而不是降级裸读**。
                // 判据：error.number === 9（官方文档给的就是这个码），或消息里出现
                // modal（"host is in a modal state" / "…is running a modal command"）。
                // 曾经的「消息命中 ⇒ 直读兜底」写法在这里是**危险的**：宿主忙碌期的
                // 裸 get 正是原生「命令"获取"当前不可用」弹框的来源，越兜越弹。
                // 现在改为：作废租约 + 延长文档级闩锁（让所有读取一起退避）并返回失败。
                noteHostUnresponsive();
                if (isHostModalError(e)) {
                    markPsAccess(`${label}：宿主模态冲突`, 'fail');
                    extendDocLatch();
                    return { ok: false };
                }
                if (attempt >= retries) {
                    markPsAccess(`${label}：${accessErrText(e)}`, 'fail');
                    return { ok: false };
                }
                await sleep(delay);
                delay *= 2;
            }
        }
    } finally {
        readonlyDepth--;
    }
}

/** 把异常压成一行短文本，供面包屑使用。 */
function accessErrText(e: any): string {
    const msg = String((e && (e.message || e)) || 'unknown');
    return msg.length > 60 ? `${msg.slice(0, 60)}…` : msg;
}

/**
 * 判定异常是否属于「宿主此刻无法授予模态作用域」。
 *
 * Adobe 文档：模态作用域冲突时 `executeAsModal` 抛错，`error.number === 9`
 * （25.10 起消息里会带上持锁的插件名）。消息文本在不同版本间变过
 * （"host is in a modal state" → "Plugin: X is running a modal command"），
 * 所以**两个口径都认**，宁可多判一次退避。
 */
function isHostModalError(e: any): boolean {
    if (e && typeof e.number === 'number' && e.number === 9) return true;
    const msg = String((e && (e.message || e)) || '');
    return /modal/i.test(msg);
}

/**
 * `psTryRead` 的便捷形式：只关心值，失真与失败统一返回 `null`。
 *
 * ⚠️ 返回值是 `T | null`，**不要**用 `=== null` 去区分「读到 null」和「没读到」；
 * 需要区分时用 `psTryRead`。
 */
export async function psRead<T>(
    fn: () => Promise<T> | T,
    opts: PsReadOptions = {}
): Promise<T | null> {
    const r = await psTryRead<T>(fn, opts);
    return r.ok ? r.value : null;
}

/* ------------------------------------------------------------------ *
 * 宿主空闲探测（文档级闩锁的唯一释放判据）
 * ------------------------------------------------------------------ */

/**
 * 探测「宿主此刻是否已可控」，**全程不发任何 get**。
 *
 * 原理：`executeAsModal` 是 PS 官方的互斥原语 —— 只要 PS 自己还握着自己的模态
 * 作用域（打开 / 关闭 / 保存大文档、拼合…），请求就会排队直到超时；能拿到作用域
 * 就说明 PS 已经把控制权交出来了。因此「能不能拿锁」本身就是最可靠的忙碌信号，
 * 而且**拿不到锁只是抛一个可捕获的异常**，绝不会变成宿主原生弹框。
 *
 * ⚠️ 为什么不用读一个属性来探测（例如读 `activeDocument.id`）：任何 get 在宿主
 * 忙碌期都会弹「命令"获取"当前不可用」，探测本身就会制造用户看到的那堆警告窗口。
 * 本函数刻意**只拿锁、不读数据**，因此每个探测周期都是零风险。
 *
 * ⚠️ 这是社区验证过的既有模式（Adobe 论坛：监听 `open` 事件后要在模态里改图层，
 * 只能「retry until it works」）。
 *
 * @returns `true` = 宿主可控（调用方应释放闩锁）；`false` = 仍在忙（续期闩锁）。
 */
export async function probeHostIdle(timeOutMs = 300): Promise<boolean> {
    if (isInOwnModalScope()) return true;
    try {
        await core.executeAsModal(
            async () => { /* 空操作：只为拿一次锁，刻意不读任何数据 */ },
            {
                commandName: '检测 Photoshop 空闲',
                interactive: false,
                timeOut: Math.max(0, timeOutMs),
            } as any
        );
        // ✅ 拿到锁 ⇒ 宿主可控。这对同步裸读是**肯定式证据**（见 psProbe.canSyncReadHost）。
        noteHostResponsive();
        return true;
    } catch {
        noteHostUnresponsive();
        return false;
    }
}
