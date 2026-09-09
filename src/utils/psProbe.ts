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
