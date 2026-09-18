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
⇒ 事件探测统一走 `psProbe.debouncePsProbe(200ms)`。
