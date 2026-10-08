/**
 * 「普通」PS 通知（set/select/make/delete…）之后的忙碌窗口时长。
 */
export const BUSY_AFTER_EVENT_MS = 300;

/**
 * 「选区变更」事件的**填充专用**冷却时长（毫秒）—— 只给填充路径用。
 *
 * ⚠️⚠️ **不要拿它去调 markPsBusyForEvent 的全局窗口**（2026-10-08 血泪）：
 * `isPsBusy()` 是**全局共享闸门**，被 9 处消费方依赖 ——
 * `pollQuickMask`(300ms 轮询) / `pollToolChange`(300ms 轮询) / MaskSyncEngine 的
 * 轮询与两处同步入口 / AdjustmentPanel 的探测 / `debouncePsProbe` / `runWhenIdle`。
 * 一旦把选区事件的全局窗口从 300ms 缩短，这些**轮询与探测**就会在PS 仍处于
 * 忙碌期时提前放闸 ⇒ 集体发出 `get` ⇒ 宿主弹「命令"获取"当前不可用」。
 * 症状：①快速删图层必报错 ②删完立刻套索必报错 ③切文档首次报错
 * ④**快速蒙版下三种填充全报错**（快速蒙版会持续派发选区 set ⇒ 闸门反复被压到 60ms）。
 * ⇒ 正确做法：**全局窗口一律保持 300/1200ms 不动**，只给填充路径一份**私有冷却**，
 * 见 `fillReadyRemain()`。
 */
export const BUSY_AFTER_SELECTION_EVENT_MS = 60;

/**
 * 选区填充失败后的降级重试窗口（毫秒）。
 * 首次尝试走短窗口（抢时间），失败才用这个长窗口顺延重试（保正确）。
 */
export const BUSY_AFTER_SELECTION_RETRY_MS = 400;

/**
 * 切换活动文档之后的忙碌窗口时长（毫秒）。
 *
 * 为什么必须比普通事件长：切文档不是一次瞬时命令 —— PS 要重建文档窗口、
 * 图层面板、历史状态，大文档（PSD/PSB、上千图层）明显更久，300ms 远远不够。
 * 期间任何 `app.activeDocument` / `doc.layers` / batchPlay get 都会被宿主拒绝，
 * 弹出「易修: 命令"获取"当前不可用」。这里取1200ms 覆盖切文档的实际耗时。
 */
export const BUSY_AFTER_DOC_SWITCH_MS = 1200;

/**
 * 判断一个通知是否是「切换了活动文档」。
 *
 * PS 在两个已打开文档间切换时派发 `select`，descriptor 形如
 * `{ _obj:'select', _target:[{ _ref:'document', … }] }`；而选区/图层选择
 * 的 `_ref` 分别是 `channel` / `layer`。因此「事件是 select」+「target 里有
 * document」两个条件即可精确命中，**纯对象判断、不碰 DOM**（通知回调内唯一
 * 允许做的事）。
 *
 * ⚠️ 为什么要限定 select：`set` 事件的 `_target` 里也可能出现 document 引用
 *（改文档级属性），若不限定事件名会把普通 set 也误判成切文档 ⇒ 平白多等 900ms。
 *
 * ⚠️ 依据：Adobe 官方 Action/Core 事件表里都**没有** `currentDocumentChanged`
 *（那是 ExtendScript Generator 的网络事件，UXP 用不了），UXP 只能靠
 * `select` + descriptor 识别切文档 —— 官方论坛结论一致：「在已打开文档之间
 * 切换会派发 select，descriptor._target[0]._ref === 'document'」。
 */
export function isDocSwitchDescriptor(eventName?: string, descriptor?: any): boolean {
    if (eventName !== 'select') return false;
    const target = descriptor?._target;
    if (!Array.isArray(target)) return false;
    return target.some((t: any) => t && t._ref === 'document');
}

/**
 * 判断一个通知是否是「选区变更」。
 *
 * PS 在套索/魔棒/选区修改/取消选区后派发 `set`，descriptor 形如
 * `{ _obj:'set', _target:[{ _ref:'channel', _property:'selection', … }] }`。
 * 这类事件**在孤立发生时**用短忙碌窗口（见 BUSY_AFTER_SELECTION_EVENT_MS 的说明）。
 */
export function isSelectionDescriptor(descriptor?: any): boolean {
    const target = descriptor?._target;
    if (!Array.isArray(target)) return false;
    return target.some(
        (t: any) => t && t._ref === 'channel' && t._property === 'selection'
    );
}

/**
 * 「刚刚发生过非选区事件」的时间戳（0 = 从未）。
 *
 * 用途：**只**给填充路径的私有冷却做「邻居判断」——
 * 若最近发生过 make/delete/select 等事件，说明 PS 可能还在处理重命令，
 * 此时填充宁可多等一会儿，也不要在忙碌期发 get。
 *
 * ⚠️ 这个变量**不参与**全局 `markPsBusy` 的窗口计算（全局窗口一律 300/1200ms），
 * 缩短全局窗口会让 9 处轮询/探测提前放闸并弹宿主原生报错框（见上方血泪说明）。
 */
const LONG_EVENT_NEIGHBOR_MS = 600;
// ⚠️ 用 -1 而不是 0 表示「从未发生」：0 是falsy，会让下面的 `if (lastLongEventAt && …)`
// 短路 ⇒ 在时间戳恰为 0 的场景（测试台/时钟回拨）下保护失效。
let lastLongEventAt = -1;      // 最近一次「非选区事件」时刻
let lastSelectionEventAt = -1; // 最近一次「选区事件」时刻

/** 仅供测试/诊断：重置事件记忆。 */
export function resetLongEventMemory(): void {
    lastLongEventAt = -1;
    lastSelectionEventAt = -1;
}

/**
 * 通知到达瞬间打**全局**忙碌标记（**唯一允许在通知回调内做的重活之外的动作**）。
 *
 * ⚠️ 必须在事件到达时调用，不能放到探测函数体内 —— 否则忙碌窗口会被探测自身
 * 反复延长，形成「永远等不到空闲」的自锁。
 *
 * ⚠️⚠️ **全局窗口只有两档，且不得为「填充更快」而缩短**（2026-10-08 血泪）：
 *本函数产出的是**全局共享**闸门（`isPsBusy()`），被 9 处轮询/探测依赖。
 * 一旦按事件类型缩短选区窗口，那些轮询会在PS 忙碌期提前发 get ⇒ 宿主原生报错框。
 *   · 切文档（select + document）→ BUSY_AFTER_DOC_SWITCH_MS：PS 要重建文档窗口 /
 *     图层面板 / 历史状态，1s+。
 *   · **其它一切（含选区 set）→ BUSY_AFTER_EVENT_MS：保守，不动。**
 *
 * 填充路径要的「快」不走这里，而走 `fillReadyRemain()`（私有冷却）。
 */
export function markPsBusyForEvent(eventName?: string, descriptor?: any): void {
    if (isDocSwitchDescriptor(eventName, descriptor)) {
        // ⚠️ 切文档必须**同时**记成「重命令邻居」：否则「切文档 → 立刻套索」时，
        // 选区事件会走「纯选区」分支只等60ms，而此时文档切换仍在进行（窗口 1200ms）
        // ⇒ 在切换中途发 get ⇒ 宿主原生报错框。用户实测「切文档后必报错」即此。
        lastLongEventAt = Date.now();
        markPsBusy(BUSY_AFTER_DOC_SWITCH_MS);
        return;
    }
    if (isSelectionDescriptor(descriptor)) {
        lastSelectionEventAt = Date.now();
    } else {
        // 记录「重命令邻居」供填充路径的私有冷却判断（纯内存，不影响全局窗口）
        lastLongEventAt = Date.now();
    }
    // ⚠️ 全局窗口一律保守：选区事件也用 300ms，绝不为了填充更快而缩短（见上方血泪）
    markPsBusy(BUSY_AFTER_EVENT_MS);
}

/**
 * 填充路径的**私有**冷却剩余毫秒数（0 = 现在就可以进填充）。
 *
 * 这是「填充要快」与「全局闸门必须保守」两个矛盾的解法：
 *   · **全局** `isPsBusy()` 保持 300/1200ms 不动 ⇒ 9 处轮询/探测不再提前放闸，
 *     「快速删图层 / 删完立刻套索 / 切文档 / 快速蒙版」四类弹框回归修复；
 *   · **填充路径**单独看自己的冷却 ⇒ 套索这类轻量命令不必等满 300ms。
 *
 * 判定（返回「还要等多少 ms」）：
 *   · 最近 600ms 内发生过任何**非选区**事件（make/delete/**切文档**…）
 *     ⇒ PS 可能还在处理重命令 ⇒ 服从**全局**剩余时间（保守，可高达 1200ms）；
 *   · 否则（纯选区变更）⇒ 只等私有的 60ms 冷却。
 */
export function fillReadyRemain(): number {
    const now = Date.now();
    if (lastLongEventAt >= 0 && now - lastLongEventAt < LONG_EVENT_NEIGHBOR_MS) {
        return psBusyRemain();
    }
    return Math.max(0, lastSelectionEventAt + BUSY_AFTER_SELECTION_EVENT_MS - now);
}

/**
 * PS 事件触发的「状态探测」防抖器。
 *
 * 根因：Photoshop 的通知（set/select/make/delete 等）是在命令执行【中途】派发的——
 * 例如 Ctrl+E 合并图层时，delete/make 事件在合并命令尚未结束时就到达各面板监听器。
 * 若监听器立刻发起 batchPlay get（如蒙版模式检测），会撞上 PS 的忙碌窗口，宿主
 * 直接弹出「易修: 命令"获取"当前不可用」原生报错框。该弹框由 PS 宿主弹出，
 * JS try/catch 与 _options.dialogOptions 都拦不住（runWithTemporaryUnlock 处
 * 的 applyLocking 先例相同）；同一次合并的多个事件 × 多个监听器即表现为弹 2~3 次。
 *
 * 对策：事件触发的探测统一走此防抖——默认 200ms 内无新事件才真正执行，
 * 此时 PS 命令已结束、忙碌窗口已过，get 正常返回，弹框不再出现。
 *
 * ⚠️ 忙碌感知（2026-10-07 修「切换活动文档时弹『命令"获取"当前不可用』）：
 * 固定等待对「切文档」这种长命令不够 —— 200ms 后PS 可能仍在切换。
 * 因此到期后先问 `isPsBusy()`：仍忙碌就顺延到忙碌窗口结束再执行，
 * 最多顺延 maxBusyDeferrals 次（防止忙碌持续时探测永不执行）。
 */
export function debouncePsProbe<A extends any[]>(
    fn: (...args: A) => any,
    wait = 200,
    maxBusyDeferrals = 12
): ((...args: A) => void) & { cancel: () => void } {
    let timer: any = 0;
    let busyDeferrals = 0;
    const run = (args: A) => {
        //仍处于忙碌窗口（切文档 / 长命令）⇒ 顺延，绝不硬闯。
        // ⚠️ 这里只判断、不打标记（打标记会自我延长成自锁）。
        if (isPsBusy() && busyDeferrals < maxBusyDeferrals) {
            busyDeferrals++;
            timer = setTimeout(() => {
                timer = 0;
                run(args);
            }, Math.max(wait, psBusyRemain()));
            return;
        }
        busyDeferrals = 0;
        try {
            const r = fn(...args);
            if (r && typeof r.catch === 'function') r.catch(() => { });
        } catch {
            // 忙碌窗口内的探测直接放弃，等下一次事件重新调度
        }
    };
    const wrapped = (...args: A) => {
        if (timer) clearTimeout(timer);
        busyDeferrals = 0;   // 新事件重新起算顺延次数
        timer = setTimeout(() => {
            timer = 0;
            run(args);
        }, wait);
    };
    (wrapped as any).cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = 0;
        }
    };
    return wrapped as any;
}

/**
 * 全局「PS 忙碌」守卫。
 *
 * 根因补充：删除/新建等命令会派发多个通知，每个通知各自触发一处探测；
 * 单点200ms 防抖在连续快速删除时很难等到真正的静默期（事件一直在来），
 * 于是探测反复落在忙碌窗口内 → 宿主弹「易修: 命令"获取"当前不可用」。
 * 这里由markPsBusy 记录「最后一次事件之后 PS 仍不可查」的时长，
 * 供各探测点在真正发起 get 之前自查，从而**主动跳过**而不是硬闯。
 *
 * ⚠️ 硬约束：宿主弹框绕过了 JS 异常与 dialogOptions，**唯一可靠的防护是不发出 get**。
 * 因此守卫只能加在读取动作之前，加在 try/catch 之后是无效的。
 */
let psBusyUntil = 0;

/** 标记 PS 进入/仍处于忙碌状态，默认覆盖事件派发后的静默期。 */
export function markPsBusy(ms = 300): void {
    psBusyUntil = Math.max(psBusyUntil, Date.now() + ms);
}

/** 当前是否仍处于 PS 忙碌窗口（Date.now() 驱动，避免残留计时器）。 */
export function isPsBusy(): boolean {
    return Date.now() < psBusyUntil;
}

/** 忙碌窗口剩余毫秒数（0 表示已空闲）。 */
export function psBusyRemain(): number {
    return Math.max(0, psBusyUntil - Date.now());
}

/**
 * 「空闲后单次执行」调度器：把一个会发起 PS 查询的函数推迟到忙碌窗口之后，
 * 且同一时刻只允许一个实例在跑（重入调用直接丢弃本轮，不排队）。
 *
 * 与 debouncePsProbe 的分工：
 * - debouncePsProbe：用于「连续事件只关心最后一次状态」的场景（末尾静默即执行）；
 * - runWhenIdle：用于「必须真正执行一次」的场景（如轮询兜底同步、启动首刷），
 *   忙碌时顺延到下一轮而不是丢弃，保证功能不丢。
 *
 * @param maxDeferrals 因忙碌最多顺延几次。**0 = 不限**（会一直重排到空闲为止）。
 *   ⚠️ 凡是「不做就永久缺功能」的调用（启动加载、一次性初始化）都应传有限值
 *   （如 5），否则忙碌持续时任务永不执行；「周期性探测」可传 0。
 */
export function runWhenIdle<A extends any[]>(
    fn: (...args: A) => any,
    wait = 300,
    maxDeferrals = 0
): ((...args: A) => void) & { cancel: () => void } {
    let timer: any = 0;
    let running = false;
    let deferrals = 0;   // 已因忙碌顺延的次数
    const wrapped = (...args: A) => {
        if (running) return;            // 正在跑：本轮直接丢弃，不排队堆积
        if (timer) clearTimeout(timer); // 顺延而非丢弃
        timer = setTimeout(async () => {
            timer = 0;
            if (isPsBusy()) {           // 仍然忙碌 → 顺延重试
                // ⚠️ 必须有上限：否则忙碌持续时会无限自我重排、任务**永不执行**，
                //   表现为「启动后某个功能一直不加载」（如笔刷列表始终为空）。
                //   超限后直接执行：宁可承担一次被拒绝的风险，也不能不做事。
                if (maxDeferrals > 0 && deferrals < maxDeferrals) {
                    deferrals++;
                    wrapped(...args);
                    return;
                }
                deferrals = 0;
            }
            running = true;
            deferrals = 0;
            markPsBusy(wait);           // 本次读取自身也占一段窗口，避免与他方查询互撞
            try {
                const r = fn(...args);
                if (r && typeof r.catch === 'function') await r;
            } catch {
                // 忙碌窗口内的探测直接放弃，等下一次事件/轮询重新调度
            } finally {
                running = false;
            }
        }, Math.max(wait, psBusyRemain()));
    };
    (wrapped as any).cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = 0;
        }
    };
    return wrapped as any;
}
