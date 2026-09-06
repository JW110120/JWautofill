import { core } from 'photoshop';

/**
 * 包装一次阻塞式 PS 命令执行：让 PS 原生进度条显示「正在执行：<命令> n%」。
 * - options.commandName 提供初始字样（官方语义：耗时操作会显示在进度条上）；
 * - 进入模态后用 setInterval 每 0.5s 经 ec.reportProgress 刷新文字 + value
 *   （命令内部没有天然的细分进度数据，故用渐近爬升的模拟百分比：越接近 95% 越慢，
 *   执行结束立即置 100%，不谎报完成）。
 * - setInterval 在 executeAsModal 作用域内可用（UXP 事件循环照常运行，命令 await 间隙即触发）。
 */
export async function runCommand(command: string, fn: () => Promise<void> | void): Promise<void> {
  let pct = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const report = (ec: { reportProgress: (params: { value?: number; commandName?: string }) => void }) => {
    try {
      ec.reportProgress({
        commandName: `正在执行：${command} ${Math.round(pct)}%`,
        value: Math.min(1, pct / 100),
      });
    } catch {
      // 旧版本 PS 不支持 reportProgress 时静默忽略（commandName 仍由 options 提供）
    }
  };

  await core.executeAsModal(async (ec) => {
    report(ec);
    timer = setInterval(() => {
      // 每次爬升剩余差距的 3%（+0.5 保底），渐进逼近 95%
      pct = Math.min(95, pct + Math.max(0.5, (95 - pct) * 0.03));
      report(ec);
    }, 500);
    try {
      await fn();
    } finally {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      pct = 100;
      report(ec);
    }
  }, { commandName: `正在执行：${command}` });
}
