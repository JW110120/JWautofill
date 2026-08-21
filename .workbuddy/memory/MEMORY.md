# JWautofill 项目长期记忆

## UXP / React 关键知识点（踩坑记录）

- **`action.addNotificationListener / removeNotificationListener` 第一个参数必须是字符串数组**（如 `['set','select','clearEvent','delete','make']`）。传单个字符串会抛 `Argument 1 has an invalid type. Expected type: array actual type: string`，监听完全注册失败。若要逐个注册容错，也必须包成 `[evt]` 数组。正确范例：src/app.tsx。
- **React 19 dev 构建在 UXP 中不能直接渲染**：其渲染流程调用 `performance.mark(name, {detail})` / `performance.measure(...)`，UXP 内置 Performance 不支持对象 options 且 measure 要求起点 mark 已注册 → 首次渲染抛 `NotFoundError: The mark [object Object] does not exist` → 渲染中断后 root 状态残留 → 之后全部渲染报 `Should not already be working.` 面板白屏。**解法**：入口最先 import `src/uxpPerfPatch.ts`（容错包装 mark/measure/clearMarks/clearMeasures）。Production 构建无此问题。
- **往 PS 里加载产物**：`yarn build`（production）最稳；`yarn watch`（dev）现在有 uxpPerfPatch 兜底可用，但 PS 端需手动重新加载插件才能拿到新 bundle。
- 仓库统一 LF（.gitattributes `* text=auto eol=lf` + `*.otf binary`）；改行符会引起 UXP 热重载竞态。

## 面板/入口结构

- 两个面板入口都在 src/index.tsx：`#app`（App 主面板）+ `#pixeladjustment`（AdjustmentPanel 像素调整）。菜单在 MenuManager.setup()。
- 蒙版同步引擎 src/utils/MaskSyncEngine.ts（单例，事件驱动+2s 兜底轮询，按文档名持久化到 mask-sync-state.json）。
