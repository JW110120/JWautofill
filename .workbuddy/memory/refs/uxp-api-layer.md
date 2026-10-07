# UXP / PS 接口层行为备忘（JWautofill）

> 从 `.workbuddy/memory/MEMORY.md` 拆出（2026-09-18，控制 MEMORY.md 体积）。
> 都是「接口层实测行为」，不是样式规则；样式/面板相关见 `refs/frontend-css.md` 与项目技能 `uxp-frontend-spec`。

## 当前工具检测
不能只靠 select 通知：切笔刷预设派发的是 `{_ref:'brush'}`（没有 tool 变更）、动作回放也不广播。
⇒ 读 `application.tool._enum`（`HotkeyBridge.getSelectedBrushToolEnum`）+ 300ms 轮询 + `/brush|eraser|stamp|smudge/` 匹配。
⚠️ 混合器画笔的内部名不是 brush：有 `mixerBrushTool` / `wetBrushTool`。

## 像素读写
`imaging.getPixels` 会把 `sourceBounds` **裁到层 bounds 再重采样** ⇒ 直接按选区请求会拿到错位/缩放过的数据。
正确姿势：先取 `layer.bounds`，只请求「需要区 ∩ bounds」，并保证 source 与 targetSize **严格 1:1**；
解析时用 `imageData.width/height`（不要用请求尺寸），并守 `raw.length`。

## 历史与 IO
- 历史压缩：`batchPlay + putPixels` 外面包 `doc.suspendHistory`；若已在内部历史中，传 `{skipHistorySuspend:true}` 避免嵌套。
- `storage.formats` 只有 `binary` / `utf8`；⚠️ `file.read({format: undefined})` **静默乱码**（不报错）。
- 弹窗必须用 `core.showAlert`：`dialogs.alert` 只写控制台、用户看不见。

## 事件节奏
PS 通知常在**命令中途**派发 ⇒ 收到 make/delete/set 立刻 get 会撞上「忙碌窗口」。
⇒ 事件探测统一走 `psProbe.debouncePsProbe(200ms)`，且**必须带忙碌感知**（见下）。

## 切换活动文档 = 长命令（2026-10-07 定位，弹「易修: 命令"获取"当前不可用」根因）
- **UXP 没有 `currentDocumentChanged` 事件**。Adobe 官方 Action 事件表（eventcodes）与 Core 事件表里都没有它 ——
  那是 ExtendScript / Generator 的网络事件，UXP 用不了。`app.on()` 也不在官方 Photoshop 类文档里，别指望。
  唯一可行的识别方式：**`select` 事件+ `descriptor._target` 里有 `{_ref:'document'}`**（官方论坛确认「已打开文档之间切换会派发 select」）。
  ⇒ `psProbe.isDocSwitchDescriptor(eventName, descriptor)`（**必须同时限定 eventName==='select'**，
  否则改文档级属性的 `set` 也会命中 → 平白多等 900ms）。
- **切文档的忙碌窗口远长于普通事件**：PS 要重建文档窗口 + 图层面板 + 历史状态，大文档明显更久。
  故 `BUSY_AFTER_DOC_SWITCH_MS = 1200` vs `BUSY_AFTER_EVENT_MS = 300`，由 `markPsBusyForEvent` 统一裁定。
  ⚠️ 固定 300ms 窗口 + 固定 200~300ms 防抖 = **必然**在切文档时弹框（事件后 200ms PS 还在切）。
- **无守卫的周期性轮询是首要缺口**：`pollQuickMask`（300ms 读 activeDocument.quickMaskMode）、
  `pollToolChange`（300ms 发 batchPlay get tool）原本**完全不查 `isPsBusy()`**，与用户操作完全异步 ⇒ 必落进忙碌窗口。
  凡「无条件 setInterval + 读文档/get」的轮询，都必须先 `if (isPsBusy()) return;`。
- 蒙版同步的 `scheduleSync` 定时器：**忙碌闸门必须放在定时器最开头**，因为 `checkDocFirst` 分支的
  `refreshActiveDoc()`（读 activeDocument + name）不受 `doTimedSync` 的守卫保护。
- ⚠️ 面板挂载瞬间（componentDidMount / useEffect 首跑）也是忙碌峰值：所有启动期一次性 PS 读取
  （`checkMaskModes` / `refreshLineReferenceOptions` / `refreshMaskSyncOptions` / `maskSyncEngine.init` 里的
  `refreshActiveDoc`）都要包 `runWhenIdle(fn, 300, 12)`。
- ⚠️ 依赖里含父面板回写 prop 的 effect（如 `[isOpen, propIsQuickMaskMode]`）会被「切文档探测完成后的 setState」
  连带触发 ⇒ 同样要 `runWhenIdle`，否则等于绕过了通知防抖。

## 文档切换判定用 id，不能只用名字
`refreshActiveDoc()` 原按 `d.name` 判定切换 ⇒ **两个同名文档互切判成「没变」**，
currentDocKey/文件树/任务列表全部指向旧文档。现改为 `docId + name` 双口径（`currentDocId` 字段），
`notify()` 的 `docChanged` 同样改用 `lastNotifiedDocId` 比对。⚠️ 持久化 key 仍用名字（保持既有存档兼容）。
