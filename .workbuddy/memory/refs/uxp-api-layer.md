# UXP / PS 接口层 + 性能 / React（JWautofill）

> `MEMORY.md` 的展开页。都是「接口层实测行为」与性能铁律，不是样式规则。
> 样式/面板见 `refs/frontend-css.md` 与技能 `uxp-frontend-spec`；闸门/模态见 `refs/busy-gate.md`。

## 一、接口层实测行为

### 当前工具检测
- 不能只靠 `select` 通知：切笔刷预设派发的是 `{_ref:'brush'}`（没有 tool 变更），动作回放也不广播。
- ⇒ 读 `application.tool._enum`（`HotkeyBridge.getSelectedBrushToolEnum`）+ 300ms 轮询 + `/brush|eraser|stamp|smudge/` 匹配。
- ⚠️ 混合器画笔的内部名不是 `brush`：有 `mixerBrushTool` / `wetBrushTool`。

### 像素读写
- `imaging.getPixels` 会把 `sourceBounds` **裁到层 bounds 再重采样** ⇒ 直接按选区请求会拿到错位/缩放过的数据。正确姿势：先取 `layer.bounds`，只请求「需要区 ∩ bounds」，保证 source 与 targetSize **严格 1:1**；解析用 `imageData.width/height`（不要用请求尺寸），并守 `raw.length`。
- （完整四参数铁律见 `refs/fill-and-stroke.md`。）

### 历史与 IO
- 历史压缩：`batchPlay + putPixels` 外面包 `doc.suspendHistory`；若已在内部历史中，传 `{skipHistorySuspend:true}` 避免嵌套。
- `storage.formats` 只有 `binary` / `utf8`；⚠️ `file.read({format: undefined})` **静默乱码**（不报错）。
- 弹窗必须用 `core.showAlert`（`dialogs.alert` 只写控制台、用户看不见）。

### 事件节奏
- PS 通知常在**命令中途**派发 ⇒ 收到 make/delete/set 立刻 get 会撞上忙碌窗口。事件探测统一走 `psProbe.debouncePsProbe`，且**必须带忙碌感知**。

### 文档切换 = 长命令
- **UXP 没有 `currentDocumentChanged` 事件**（那是 ExtendScript 的东西）。识别方式：**`select` 事件 + `descriptor._target` 里有 `{_ref:'document'}`**（`psProbe.isDocSwitchDescriptor`，**必须同时限定 `eventName==='select'`**，否则改文档级属性的 `set` 也会命中→平白多等）。
- 切文档的忙碌窗口远长于普通事件（PS 重建窗口 + 图层面板 + 历史）⇒ 按文档级处理（长窗口 + 闩锁）。
- ⚠️ **无守卫的周期性轮询是首要缺口**：`pollQuickMask`(300ms 读 quickMaskMode) / `pollToolChange`(300ms 发 get tool) 原本完全不查忙 ⇒ **凡「无条件 setInterval + 读文档/get」的轮询都必须先 `if (isPsBusy()) return;`**。
- ⚠️ 面板挂载瞬间也是忙碌峰值：所有启动期一次性 PS 读取都要包 `runWhenIdle`（详见「性能 / React」节）。

### 文档切换判定用 id，不能只用名字
- 按 `d.name` 判定 ⇒ **两个同名文档互切判成「没变」**。改用 `docId + name` 双口径（`currentDocId`）。⚠️ 持久化 key 仍用名字（保持存档兼容）。

## 二、性能 / React 铁律

### 核心事实：延迟来自同步 IPC，不来自像素计算
- ⛔⛔ 选区纯色填充 0.5s 里 **0.3s 是人为固定等待 + 67 次同步 IPC**；真正的颜色写入是 PS 原生 `fill`（多线程、几毫秒），JS 侧没有像素循环。
- ⛔ **UXP 里每一次 `app.activeDocument` / `doc.layers` / `layer.bounds` / `layer.visible` 属性读都是一次同步宿主往返**；**batchPlay 数组整体只算一次**（数组内按序执行，无数据依赖的 get/set 应合并）。
- 三条铁律：① **同一份状态绝不查两遍**；② **属性只读一次再复用**（读 `bounds` 后不要再取 `bounds.width` / `.height`）；③ **无数据依赖的 batchPlay 一律合并**。
- ⚠️ 合并下发时必须核对**每个消费分支都真的消费了该参数**：曾无条件传 `withDeselect`，而图案/渐变/清除/单通道分支不消费 ⇒ deselect 被静默丢掉（选区留在画布上），编译与类型检查都发现不了。
- ⚠️ 忙碌窗口缩短必须配**有界**降级重试（用布尔标志会变成无限重试循环）。
- ⚠️ 省 IPC **必须来自「读一次复用」，不能来自「不读就假定某个值」**：曾为省一次 `bounds` 而对背景图层返回 `hasPixels=false` ⇒ 背景图层误走错误分支（`hasPixels` 有 6 处消费）。

### 共享闸门（`isPsBusy()`）动之前要数清消费者
- ⛔⛔⛔ 它影响 9 处消费者（两处 300ms 轮询 / 蒙版同步 2s 轮询 + 两处同步入口 / 面板探测 / 防抖 / `runWhenIdle` / 选区变更）。缩短全局窗口 ⇒ 那 9 处在 PS 仍忙时提前放闸、集体发 `get` ⇒ 宿主弹「命令"获取"当前不可用」。
- ⇒ **全局窗口一律 300 / 1200ms，不得为提速缩短**；填充的「快」走独立的 `fillReadyRemain()` 私有冷却（不变量 `fillReadyRemain() ≤ psBusyRemain()`）。详见 `refs/busy-gate.md`。

### 匹配规则
- 禁止把多条 get 合并进同一 batchPlay（见 `refs/uxp-api-layer` 上文与 `refs/busy-gate.md`）。
- ⚠️ PS 原生对话框不认描述符内的 `_options.dialogOptions`，只认 batchPlay 的 options ⇒ 静默化必须写在 options 层（`fill`/`stroke`/`stroke`+`clearEnum` 必现）。新增 batchPlay **两处都写**。

### 图层树 / 缓存
- ⚠️ **图层树只读一份快照**（`utils/layerTreeSnapshot.ts`）：`layer.id/name/kind/layers/isBackgroundLayer` 每读一次都是同步 IPC ⇒ 遍历 N 层 ≈ 3N~5N 次。三处并发遍历（引擎轮询签名 / 面板探针 / 线稿参考）在 500 图层时每 2 秒约 1500 次 ⇒ 主线程占满、点击无响应。
  - ① 读树一律 `getLayerSnapshot(maxAgeMs?)`；② 通知回调里**只**调 `invalidateLayerSnapshot()`（纯内存零 IPC，唯一允许）；③ 判断「结构变没变」先问 `isLayerSnapshotDirty()`，别为确认没变而遍历。
  - 签名 = 先序「顺序 + id + kind + name + depth」参与 FNV-1a（顺序敏感才能识别「移动图层」），只在会话内自比较、不持久化。
- `getActiveLayerInfo` 有 **300ms 短 TTL 缓存**（key = 活动图层 id）。失效时机：`make`/`delete`/`select`/`clearEvent`，以及 `set` 中 target 引用 layer/document/通道者；⚠️ **纯选区 `set`（channel + `_property:'selection'`）刻意不失效**。`createNewLayer` 与蒙版同步写回后必须手动失效。

### React
- ⚠️ **大列表 `options` 必须 `useMemo` + 组件 `React.memo`**（`Select` 靠引用比较跳过重渲染 ⇒ 调用方写 `options={raw.map(...)}` 会让 memo 完全失效）。配套：选项数组一律 `useMemo`/模块级常量，**永远不要在 JSX 里现 map**；`useMemo` 绝不能放进 `.map()` 回调；渲染路径上的 `arr.find(...)` 换成模块级 `Map` 索引。
  - 背景：面板是「单组件、全部 JSX 一个 return」，折叠任一分区会让**所有已展开分区**重渲染（含原生 `input[type=number]`，同步成本极高）⇒ 折叠代价按 O(分区数 × 控件数) 估。
- ⛔⛔ **组件内 `useMemo`/JSX 调用组件体内更下方才声明的 `const` ⇒ 整块面板白屏**（报错不是 TDZ 的「Cannot access before initialization」，而是「`Xxx` is not a function」——因为 target=**es5**，`const` 降级为 `var`：提升但值为 undefined）。**编译期与 webpack 都查不出来**。
  - 铁律：① **纯函数一律放模块级**；② 组件体内新增同步语句前先确认它调用的每个 `const` 都在更早的行；③ 发现隐患时修法选「提到模块级」，不要「把 Hook 挪到声明之后」。
- ⚠️ **父面板复位要覆盖子面板内部 state** ⇒ `AppState.resetToken` 自增 → prop → 子面板 `prevResetTokenRef` 变化时回默认值。`resetToken` 必须写在 `...initialState` **之后**；**复位前先清「选中预设」**（否则「参数变→回写选中预设」的 effect 会把用户预设改写成默认值）；复位**不动 presets/patterns 列表**。

### 启动期一次性加载
- ⚠️ 笔刷枚举 / presetManager / 文档尺寸等 `batchPlay get` 必须走 `runWhenIdle`（挂载瞬间正是忙碌峰值，表现「启动时列表空、点一下刷新就好」）。卸载时 `.cancel()`。
- ⚠️ 第 3 参 `maxDeferrals`：**一次性加载必须传有限值**（如 5），「周期性探测」才可传 0。调度器用 `useRef` + 懒初始化；循环里判断 setState 结果要读镜像 ref 而非闭包旧 state。
- ⚠️ 排查「刷新一下才好」先分清**枚举失败**（列表空）vs **下游数据缺失**（有名字无内容）——根因与修法完全不同。

### 通知回调
- ⚠️ **通知回调内禁止任何同步 DOM 读取**（每次读都发 `get`）：PS 的 set/delete/make 通知在命令**中途**派发，此刻读文档必撞忙碌窗口 → 宿主弹「命令"获取"当前不可用」。该弹框绕过 JS try/catch 与 `_options.dialogOptions`，**唯一防护是「不发 get」**（加在 try/catch 之后无效）。
- ⚠️ `GradientPicker` 两套插值函数不可合并（`interpolate*AtPosition` vs `...ForPreset`）：入参类型不同，且透明度正则的 alpha 组语义不同（ForPreset 版 alpha 可选）。四个已全部提到模块级。

## 三、派生缓存的键必须覆盖「全部影响输出的输入」

- 凡把「环境/主题/尺寸/DOM 实测值」烘进输出的派生结果，**要么进键、要么从输出里去掉**。本仓旋转图缓存曾因把预览区底色烘进输出而换主题不失效 ⇒ 现改为输出真透明（比加键更根本）。
- 同理 `previewNaturalRef` 在灰度模式下会被降采样缩略图覆盖、污染建图案尺寸与预览显示尺寸（详见 `refs/frontend-css.md` 第九节）。排查「预览/图案尺寸不对」先看这里。
