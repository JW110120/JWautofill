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

## 切换活动文档 = 长命令（2026-10-07 定位，弹「悦绘: 命令"获取"当前不可用」根因）
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

---

# 性能 / React 铁律细则（2026-10-08 由 MEMORY.md 下沉，正文逐字保留）

- ⛔⛔ **【血泪，2026-10-08】UXP 交互延迟的主因是「串行同步 IPC 往返」，不是像素计算。**
  选区纯色填充实测 0.5s 里 **0.3s 是人为固定等待 + 67 次同步 IPC**；真正的颜色写入是 PS 原生
  `fill` 命令（宿主多线程，几毫秒），JS 侧**没有**像素循环。
  ⚠️ **UXP 里每一次 `app.activeDocument` / `doc.layers` / `layer.bounds` / `layer.visible` 属性读取
  都是一次同步宿主往返**（与读`layerTreeSnapshot` 同源机制），**batchPlay 数组整体只算一次往返**
  （数组内命令按序执行 ⇒ 无数据依赖的 get、set 应合并进同一批）。
  三条铁律：① **同一份状态绝不允许查两遍** —— `getActiveLayerInfo` 曾因
  `checkSingleColorChannelMode` 内部**又调一次** `checkLayerMaskMode` 而膨胀到 ~18 次 IPC；
  ② **属性只读一次再复用**：读`bounds` 后不要再取 `bounds.width` / `bounds.height`（各多一次往返）；
  ③ **无数据依赖的 batchPlay 一律合并**：`fill` + `set selection none` 可合成一次下发。
  ⚠️ 改动「合并下发」时必须核对**每个消费分支都真的消费了该参数** —— 我曾无条件传
  `withDeselect`，而图案/渐变/清除/单通道分支不消费它 ⇒ **deselect 被静默丢掉**（选区留在画布上），
  编译与类型检查都发现不了。合并参数只能在**确认走该分支时**才传。
  ⚠️ 忙碌窗口缩短必须配**有界**降级重试（`selectionRetryCount < 1`，上限 1 次）：
  用布尔标志会变成宿主持续忙碌时的**无限重试循环**。
  ⚠️ 核对台：`outputs/fill_ipc_audit.cjs`（逐项列出每次同步 IPC + 硬等待，新旧对照）。
- ⛔⛔⛔ **【最严重血泪，2026-10-08 真机实测】`isPsBusy()` 是「全局共享闸门」，动它之前必须数清所有消费者。**
  为提速把「选区事件的全局窗口」从 300ms 压到 60ms ⇒ 用户实测报出 4 类新问题：
  ①快速删图层必报错 ②删完立刻套索必报错 ③切文档首次报错 ④**快速蒙版下三种填充全报错**。
  根因：该窗口有**9 处消费者**（`pollQuickMask` 300ms 轮询 / `pollToolChange` 300ms 轮询 /
  MaskSyncEngine 的 2s 轮询 + 两处同步入口 / AdjustmentPanel 探测 / `debouncePsProbe` /
  `runWhenIdle` / `handleSelectionChange`）——窗口一缩，**那 9 处在 PS 仍忙碌时提前放闸、
  集体发 `get`** ⇒ 宿主弹「命令"获取"当前不可用」。
  ⚠️ **教训：我曾「逐项核对」后断言无影响，是错的** —— 我只核对了「填充路径会不会发 get」，
  **没核对「缩短窗口后别的消费者会不会提前发 get」**。共享闸门改动必须先 grep 出全部消费者。
  ⇒ **正确解法：全局闸门与调用方冷却「解耦」**。`psProbe` 现有两套：
  `markPsBusyForEvent`（全局，两档 300/1200ms，**任何情况都不为提速而缩短**）
  + `fillReadyRemain()`（**只**给填充路径的私有冷却 60ms；「最近 600ms 有过任何非选区事件
  （含**切文档**）」时自动退回全局剩余时间）。
  不变量（已机械断言）：`fillReadyRemain() ≤ psBusyRemain()`，填充永不放宽于全局。
  ⚠️ 两个配套坑：① 切文档事件**必须**同时记「重命令邻居」，否则「切文档→立刻套索」会走
  60ms 快路径撞上 1200ms 窗口；② 哨兵值用 `-1` 不用 `0`（`0` 是 falsy，`if (lastLong && …)`
  会短路，保护在时刻恰为 0 时失效）。
  ⚠️ 核对台 `outputs/gate_verify.cjs`：用 `ts.transpileModule` 加载**真实 psProbe 源码**
  + 注入可控时钟，逐场景断言。**这类回归编译/类型检查/UI 全都看不出来，只能靠场景断言。**
- ⛔⛔ **【血泪】禁止把多条 get 合并进同一个 batchPlay 数组**（2026-10-08，快速蒙版报错根因）：
  「取 mask 通道」+「取目标通道」合并后，快速蒙版下 `get channel mask` 失败
  ⇒ **第一条失败连带整批失败**，而宿主对失败命令的原生报错框**绕过 JS try/catch**
  ⇒ 图层面板调 `getActiveLayerInfo` 的所有路径（三种填充 + 图案/渐变灰色预览）全部报错。
  ⇒ **合并 batchPlay 只在「全部命令都必然成功」时才安全**（如 fill + set selection none）；
  有可能失败的就**分开下发 + 各自 try/catch**。另外快速蒙版下应直接**跳过 mask 通道 get**。
- ⚠️ **PS 原生对话框不认描述符内的 `_options.dialogOptions`，只认 batchPlay 的 options**：
  `stroke` 命令在 `mode=clearEnum` 下会忽略描述符内的 `_options` ⇒ 弹原生「描边」框
  （清除模式必现）。⇒ `StrokeSelection.ts` 全部 16 处 batchPlay 的 options
  都补了 `dialogOptions: 'dontDisplayDialogs'`。**新增 batchPlay 必须两处都写。**
- ⛔⛔ **【此条已于 2026-10-08 作废，勿照做】「给选区事件加邻居护栏」是不够的。**
  曾以为「删除风暴末事件是选区 set」是唯一风险，用 `lastLongEventAt` +
  `LONG_EVENT_NEIGHBOR_MS=600` 做了邻居护栏 —— **但那只是护住了填充路径自己**，
  共享该闸门的另 8 处轮询/探测仍会提前放闸 ⇒ 真机实测 4 类弹框。
  ✅ 现正确形态见上方⛔⛔⛔ 条目：**全局窗口一律 300/1200ms，缩短窗口这条路整体作废。**
  ⚠️ 仍然有效的只有一条底层认知：`markPsBusy` 是 `Math.max` **并集**语义，
  **短窗口永远无法缩短已存在的长窗口** ⇒ 风险只可能来自「短窗口是最后一个事件」。
- ⚠️ **改 `LayerInfo` / 图层属性读取时禁止为某个 kind 加特例跳过读取**：
  `hasPixels` 有 6 处消费（含PatternFill/GradientFill/SingleChannelHandler/StrokeSelection），
  我曾为省一次 `bounds` 读取而对背景图层返回 `hasPixels=false`
  ⇒ 背景图层误走 `fillLockedWithoutPixels`（多两次 applyLocking、可能改写用户锁定状态）。
  旧的 `checkLayerHasPixels` 是对**所有**图层一视同仁的。**省 IPC 必须来自「读一次复用」，
  不能来自「不读就假定某个值」。**
- ⚠️ **UXP 图层树只有一份快照，别让每个消费者各自遍历**（`utils/layerTreeSnapshot.ts`）：
  `layer.id/name/kind/layers/isBackgroundLayer` **每读一次都是一次同步宿主 IPC** ⇒ 遍历 N 层树 ≈ 3N~5N 次往返。
  三处并发遍历（引擎 2s 轮询签名 / 面板结构探针 / 线稿参考选项）在 500 图层时每 2 秒约 1500 次同步 IPC
  ⇒ **主线程占满，折叠标题 click 排队 = 「点击无响应」**。
  ① 读树一律 `getLayerSnapshot(maxAgeMs?)`；② 通知回调里只调 `invalidateLayerSnapshot()`（纯内存零 IPC，唯一允许在回调内做的）；
  ③ 判断「结构变没变」先问 `isLayerSnapshotDirty()`，别为了确认没变化而遍历一次。
  签名 = 先序顺序+id+kind+name+depth 参与 FNV-1a（顺序敏感才能识别「移动图层」）；只在会话内自比较、不持久化。
- ⚠️ **`getActiveLayerInfo` 有 300ms 短 TTL 缓存**（key = 活动图层 id，PS 内全局唯一，换文档/图层自动 miss）：
  导出 `invalidateLayerInfoCache()` / `shouldInvalidateLayerInfo(evt, descriptor)`。
  失效时机：`make`/`delete`/`select`/`clearEvent`，以及 `set` 中 target 引用 layer/document/通道者；
  ⚠️ **纯选区 `set`（channel + _property:'selection'）刻意不失效** —— 它不影响任何缓存字段，
  失效只会丢掉命中率、抵消优化收益。`createNewLayer` 与蒙版同步写回后必须手动失效。
- ⚠️ **大列表下拉的 `options` 必须 `useMemo` + 组件必须 `React.memo`**：`Select` 已 memo，靠**引用比较**跳过重渲染 ⇒
  调用方写 `options={raw.map(...)}` 会让 memo 完全失效。配套：① 选项数组一律 `useMemo`/模块级常量，**永远不要在 JSX 里现 map**；
  ② `Select` 内 `allOptions`/`sel`/`optionsSignature` 必须 `useMemo`；③ **`useMemo` 绝不能放进 `.map()` 回调**（Hooks 数随长度变化会崩）；
  ④ 渲染路径上的 `arr.find(...)` 换成模块级 `Map` 索引（O(N·M)→O(N+M)）。
  ⚠️ 背景：面板是「3800 行单组件、全部 JSX 一个 return」，折叠任一分区会让**所有**已展开分区重渲染
  （含 UXP 原生 `input[type=number]`，同步成本极高）⇒ 折叠代价按 O(分区数 × 控件数) 估，不是 O(1)。
- ⛔⛔ **【血泪】组件内 `useMemo`/JSX 里调用了组件体内更下方才声明的 `const` ⇒ 整块面板白屏**
  （真实事故：`TypeError: Xxx is not a function`，堆栈 `Array.map` → `[as useMemo]`）。
  ⚠️ **报错不是 TDZ 的 "Cannot access before initialization"，而是 "is not a function"** ——
  因为 target=**es5**，ts-loader 把 `const` 降级为 `var`（**提升但值为 undefined**），拿 undefined 调用就是这个报错。
  ⚠️ **编译期与 webpack 全都查不出来**（`transpileOnly` 无类型检查 + TDZ 违反在 es5 下不报错），只能靠人工核对声明顺序。
  铁律：① **纯函数（只依赖入参、不读组件 state）一律放模块级**，永不放组件体内；
  ② 在组件体内新增 `useMemo`/`useState` 初始值/`return` 前的同步语句前，先确认它调用的每个 `const` 都已在**更早的行**声明；
  ③ **发现 TDZ 隐患时修法选「提到模块级」**，不要「把 Hook 挪到声明之后」（会让 Hooks 远离相关 state、后人极易再插错）。
  ⚠️ 验证：不能用 `grep` 生产 bundle（已 mangle）⇒ 用 `ts.transpileModule(src,{target:ES5})` 产出未压缩 es5 核对声明行号；
  更进一步把函数原样抽出丢进 `vm` 按真实调用方式执行。AST 检测器要点：
  ① 组件内辅助函数**只有被渲染期真正「调用」**才算立即执行区，仅被引用（`onClick={handleX}` 传值）不算；
  ② `AdjustmentPanel.tsx` 组件体是**零缩进**，缩进启发式失效，必须用 AST 括号配对定边界。
  （渲染期立即执行区 = 组件体顶层语句 + useMemo/useState 初始值回调体含 `.map()` 同步迭代器；`useEffect`/事件处理器/`setTimeout` 不受影响。）
- ⚠️ **`ts-loader transpileOnly:true` ⇒ 类型缺陷永不阻塞构建，只在跑 tsc 时才暴露**
  （实例：`ColorSettings` 接口缺 `calculationMode`，三处在读写它，长期挂 3 条 TS2339/TS2322 无人发现）
  ⇒ **新增跨组件共享字段必须同步补进 `types/state.ts` 接口**。
  ⚠️ 排查手法：先 `git stash` 跑 tsc 存**基线行数**（本仓约 731 行，多为 es5 lib 报错），改完对比，只看新增标识符是否出现在报错里。
- ⚠️ **父面板复位/批量操作要覆盖子面板内部 state，必须发「自增信号」**：纯色/图案/渐变参数活在各自 state 里，
  父面板 `...initialState` 管不到（描边正常是因为其参数本就在父面板 state）。解法：`AppState.resetToken` 自增 → prop →
  子面板 `prevResetTokenRef` 跳过首次、变化时回默认值。
  ⚠️ `resetToken` 必须写在 `...initialState` **之后**（`initialState` 里恒为 0，放展开前会被覆盖）。
  ⚠️ **复位前必须先清「选中预设」**（GradientPicker 有「参数变→回写选中预设」的 effect，保留会把用户预设改写成默认值 = 悄悄毁预设）。
  ⚠️ 复位**不动 presets/patterns 列表** —— 预设是用户资产，不是参数。
- ⚠️ **启动期一次性 PS 加载（笔刷枚举 / presetManager / 文档尺寸等 `batchPlay get`）必须走 `runWhenIdle` 守卫**，不可裸调：
  插件挂载瞬间 PS 正在处理面板创建与文档初始化，正是忙碌峰值（表现「启动时列表空，点一下刷新就好」）。卸载时 `.cancel()`。
  ⚠️ 第 3 参 `maxDeferrals`（0=不限）：忙碌时无上限顺延会让任务**永不执行** ⇒ **一次性加载必须传有限值**（如 5）；
  「周期性探测」才可传 0。⚠️ 调度器用 `useRef` + 懒初始化（`runWhenIdle` 每次渲染返回新函数 ⇒ const 会丢调度、且 TDZ）；
  循环里判断 setState 结果要读镜像 ref（如 `brushesRef`）而非闭包旧 state。
  ⚠️ 排查「刷新一下才好」先分清**枚举失败**（列表空）vs **下游数据缺失**（有名字无内容）——根因与修法完全不同
  （笔刷无图标属后者，且是刻意设计：类型检测会逐支切换用户当前笔刷，仅手动刷新才做）。
- ⚠️ **通知回调内禁止任何同步 DOM 读取**（`app.activeDocument`/`doc.layers`/`layer.name` 每次读都发 `get`）：
  PS 的 set/delete/make 通知在命令**中途**派发，此刻读文档必撞忙碌窗口 → 宿主弹「命令"获取"当前不可用」。
  **该原生弹框绕过 JS try/catch 与 `_options.dialogOptions`，唯一有效防护是「不发 get」** ⇒ 防护必须在读取动作**之前**（加在 try/catch 之后无效）。
  统一走 `utils/psProbe.ts`（`debouncePsProbe` / `markPsBusyForEvent`+`isPsBusy`）。
  ⚠️ **忙碌窗口只有两档（切文档 1200ms / 其它一律 300ms），不得为提速缩短** ——
  选区事件也用 300ms。缩短全局窗口会让 9 处共享该闸门的轮询/探测提前放闸并弹宿主原生框，
  详见本文件「性能 / React 铁律细则」节的⛔⛔⛔ 头号血泪。填充路径的「快」走 `fillReadyRemain()` 私有冷却。
  四条反直觉细则：① `markPsBusyForEvent` 只在**事件到达瞬间**打，**不可**放探测函数体内（否则窗口自我延长、永远等不到空闲）；
  ② 被守卫函数与调用方**不可**互相 `markPsBusy`（= 自锁、功能永不执行）；③ `const` 探测器必须定义在监听回调**之前**（TDZ）；
  ④ **固定等待不够**：切文档是长命令（忙碌窗口 ~1.2s），`debouncePsProbe` 与各定时器都必须**在回调里再查 `isPsBusy()` 并顺延**，
  且**任何无条件 `setInterval` 读文档/get 的轮询都必须 `if (isPsBusy()) return`** —— 这是「切文档必弹框」的首要缺口。
  **「节流(`if(timer) return`)」会丢弃后续事件、让刷新落在忙碌期 ⇒ 必须真防抖。**
- ⚠️ **GradientPicker 两套插值函数不可合并**（`interpolate*AtPosition` vs `...ForPreset`）：算法同构但入参类型不同，
  且**透明度正则的 alpha 组语义不同**（ForPreset 版 alpha **可选**、兼容无 alpha 的 `rgb()`；组件版 alpha **必需**、不匹配回退 1）——
  合并会改掉 `rgb()` 兜底行为。四个已全部提到模块级。
