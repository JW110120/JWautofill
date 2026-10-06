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
 */
export function debouncePsProbe<A extends any[]>(
    fn: (...args: A) => any,
    wait = 200
): ((...args: A) => void) & { cancel: () => void } {
    let timer: any = 0;
    const wrapped = (...args: A) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = 0;
            try {
                const r = fn(...args);
                if (r && typeof r.catch === 'function') r.catch(() => { });
            } catch {
                // 忙碌窗口内的探测直接放弃，等下一次事件重新调度
            }
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
