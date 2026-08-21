/**
 * UXP Performance 兼容补丁（必须在应用入口最先加载）
 * ==================================================
 *
 * 背景：React 19 development 构建在每次渲染时会调用
 *   performance.mark(name, { detail })  /  performance.measure(name, startMark, endMark)
 * 做调度性能打点（仅 dev 构建，供 React DevTools 使用）。
 * UXP 内置的 Performance 实现：
 *   - mark 不支持对象 options；
 *   - measure 要求起点 mark 必须已注册，否则抛 NotFoundError。
 * 因此在 UXP 中首次渲染即抛：
 *   "Failed to execute 'measure' on 'Performance': The mark [object Object] does not exist."
 * 该异常发生在 renderRootSync 中途，打断 React 渲染且未清理 root 状态，
 * 之后所有渲染都会报 "Should not already be working."，面板永久停止渲染
 * （yarn watch 开发模式下必现；生产构建不含这些打点，不受影响）。
 *
 * 本补丁把 mark/measure/clearMarks/clearMeasures 替换为容错版本：
 *   - mark：只把名字以字符串记录并注册，忽略 options；
 *   - measure：起点 mark 缺失时自动补注册一次，任何失败一律静默；
 *   - 不改变任何业务语义，UXP 中无 DevTools 消费这些打点，no-op 安全。
 */
(function patchUxpPerformance() {
  try {
    const perf: any = (globalThis as any).performance;
    if (!perf || typeof perf.mark !== 'function') return;
    // 防止补丁被重复执行（防御性）
    if (perf.__uxpPerfPatched) return;
    perf.__uxpPerfPatched = true;

    const marks = new Set<string>();
    const nativeMark = perf.mark.bind(perf);
    const nativeMeasure = perf.measure.bind(perf);
    const nativeClearMarks = perf.clearMarks ? perf.clearMarks.bind(perf) : null;
    const nativeClearMeasures = perf.clearMeasures ? perf.clearMeasures.bind(perf) : null;
    const toStr = (v: any): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

    perf.mark = (name: any, options?: any) => {
      const key = toStr(name);
      if (key) marks.add(key);
      // UXP 的 mark 不接受 options 对象：先带 options 尝试，失败则去掉 options 重试
      try {
        nativeMark(key, options);
      } catch {
        try {
          nativeMark(key);
        } catch { /* 忽略 */ }
      }
    };

    perf.measure = (name: any, startMark?: any, endMark?: any) => {
      const start = toStr(startMark);
      const end = endMark === undefined ? undefined : toStr(endMark);
      // UXP 要求起点 mark 已注册：缺失时补注册一次，避免 NotFoundError
      if (start && !marks.has(start)) {
        marks.add(start);
        try {
          nativeMark(start);
        } catch { /* 忽略 */ }
      }
      try {
        nativeMeasure(toStr(name), start || undefined, end);
      } catch { /* 仍失败则静默，不影响渲染 */ }
    };

    perf.clearMarks = (name?: any) => {
      try {
        if (nativeClearMarks) nativeClearMarks(name === undefined ? undefined : toStr(name));
      } catch { /* 忽略 */ }
      if (name === undefined) marks.clear();
      else marks.delete(toStr(name));
    };

    perf.clearMeasures = (name?: any) => {
      try {
        if (nativeClearMeasures) nativeClearMeasures(name === undefined ? undefined : toStr(name));
      } catch { /* 忽略 */ }
    };
  } catch { /* 补丁失败不影响插件其他功能 */ }
})();
