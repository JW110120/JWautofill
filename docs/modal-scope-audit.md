# 高频 modal scope 来源清单（2026-10-13 建，2026-10-17 复核）

> 现象：UXP 控制台 `[蒙版同步] 收到事件: set` 后紧跟红色 `821 Too many modal scope commands`。
> 判读：这是 UXP **内部计数器告警**，不是宿主报错框。它统计 `core.executeAsModal`
> 的调用频次。红色 ⇒ 短时间内模态命令过密。本文档列出全部产生点与量级。
>
> **复核记录**：2026-10-17 全量复扫（第五节 G/H/I）——彼时起原生守护进程已退役
> （M3/M4，热键与平滑合入 PS 进程内 `JWautofillHost.8li`），面板侧行号与轮询归属
> 已按当时代码校正；H 项复扫确认仍未处置。后续改动代码后，行号类引用以 grep 实地为准。

## 量级换算（先立尺子）

| 动作 | 模态作用域数 | 宿主 get 次数 |
| --- | --- | --- |
| `psTryRead` / `psRead`（`psAccess.ts`） | 1 | 回调内全部 |
| `probeHostIdle`（空模态，只拿锁） | 1 | **0** |
| `refreshLayerSnapshot()` 冷读（N 层树） | 1 | ≈ 5N |
| `buildLayerTree()` | 1 + 2×ceil(N/40) | 5N + 2N |
| `syncTask()` 一次完整同步 | 1 | 全文档像素 + 蒙版 |
| `pollDocIdentity` / `pollQuickMask` / `pollToolChange` 各一轮 | 1 | 1~2 |

`MIN_MODAL_GAP_MS = 300`（`psAccess.ts`）只约束**本模块的读**；写路径与
`runAsModal` 直调不受约束。

---

## 一、蒙版同步引擎（`MaskSyncEngine.ts`）— 本次主要修复对象

### 修复前的浪费（无任何任务时）

每条 `set` 事件走完 **4 个模态作用域**才走到「没任务」短路：

1. `scheduleSync` → `refreshActiveDoc()` → `psTryRead` = 1
2. `doTimedSync` → `psRead(app.activeDocument)` = 1
3. `doTimedSync` → `refreshActiveDoc()` = 1（**与第 1 步读同一件事**）
4. `doTimedSync` → `checkUndoGate` → `readActiveHistoryId` = 1
5. → 才执行 `if (list.length === 0) return`

2s 兜底轮询再重复一遍这 4 个。`set` 是最高频事件（画一笔、改一个滑块、
拖一次选区各一条），于是「一个任务都没有」反而是模态命令最密的状态。

### 已实施的修复

| 位置 | 措施 |
| --- | --- |
| `handleNotification` | 全局无任务时，只在**文档级事件**（open/close/save/切文档）唤醒身份刷新；普通事件直接 return |
| `doTimedSync` ① | 全局无任务 → **0 次读取**短路，排在所有 `psRead` 之前 |
| `doTimedSync` ② | 当前文档无任务 → 只做身份跟踪，跳过历史指针/结构/像素 |
| `doTimedSync` ③ | 有任务但无「启用且配置完整」的任务 → 只跑 `reconcileStructureIfNeeded()`，跳过取文档 + 读历史 + 像素比对 |
| `doTimedSync` 顺序 | 「取活动文档」与 `refreshActiveDoc` **两读合一**（都读 id+name），`d` 延后到真的要跑像素同步时才取 |
| `startPolling` | 节奏随空闲态切换：有任务 2s / 无任务 6s |
| `addTask`/`updateTask`/`removeTask` | 调 `syncPollingCadence()`，新建任务立刻拉回 2s、删空立刻放缓 |

**净效果**：无任务稳态下，每条 `set` 的模态作用域 **4 → 0**；轮询 2→6s。

⚠️ 为什么空闲态仍保留身份跟踪（1 次模态作用域）：面板状态条要显示文档名，
且 `addTask()` 用文档名做持久化键 —— 判错会把任务存到上一个文档名下（功能性 bug）。

---

## 二、线稿参考下拉（`AdjustmentPanel.tsx`）— 本次已修复

### 触发来源

`addPsNotificationListeners` 注册 **全部 20 个**事件名
（`PS_NOTIF_EVENTS`），回调对**每一条**通知都执行
`invalidateLayerSnapshot()` + `scheduleRefresh()` → `refreshLineReferenceOptions()`
→ `refreshLayerSnapshot()`。

### 高频原因（两个缺陷叠加）

1. **打脏无条件**：`invalidateLayerSnapshot()` 对包括纯选区 `set` 在内的所有事件
   都调用 ⇒ 快照每次都被判脏。
2. **读取无 maxAge**：`refreshLineReferenceOptions` 里的 `refreshLayerSnapshot()`
   **没有传 maxAgeMs** ⇒ 不走缓存复用，每次事件都真做一次全树遍历。

⇒ 每条 `set` = **1 个模态作用域 + ≈5N 次宿主往返**（N=300 ⇒ ≈1500 次）。
`scheduleStructureProbe` 里那句 `if (!isLayerSnapshotDirty()) return` 的守卫，
因为上一行刚把快照打脏而**永远为真**，形同虚设。

### 已实施的修复

- 打脏/刷新收窄为**仅结构事件**：`make`/`delete`/`move`/`rename`、文档级事件、
  以及 `shouldInvalidateLayerInfo` 判定为真的 `set`（target 含 layer/document/channel）。
  纯选区 `set`、`clearEvent`、切图层/通道的 `select` → **不打脏、不刷新**。
- `Select` 加 `onOpen={refreshLineReferenceOptions}`：**用户展开下拉的那一刻
  一定拿到最新数据**，时效性由交互保证而非后台轮询。

**净效果**：稳态下 `set` 事件对该下拉的模态作用域 **1 → 0**。

---

## 三、蒙版同步面板侧文件树刷新（`AdjustmentPanel.tsx`）

### 触发来源

独立 effect 注册 `make`/`delete`/`set`/`rename`/`move` **5 个**事件
（`AdjustmentPanel.tsx:1138`），防抖 300ms 后跑 `refreshMaskSyncAndReconcile()`。

### 高频原因

`refreshMaskSyncOptions()` → `refreshLayerSnapshot()`（1 个模态作用域 + 5N 次 get）
+ `maskSyncEngine.buildLayerTree()`（再 + 2×ceil(N/40) 个模态作用域 /
`fetchLayerNamesByIds` 与 `fillUserMaskFlags` 各一批 batchPlay）。

零任务时这一切**全部无意义**：面板只渲染「点击 + 新建同步任务」一行，没有任何下拉。

### 已实施的修复

`refreshMaskSyncAndReconcile()` 开头加 `if (!maskSyncEngine.hasAnyTask()) return;`。
⚠️ 只挡通知驱动这条通路；用户点开下拉的 `onOpen` 仍走 `refreshMaskSyncOptions`，行为不变。

---

## 四、仍存在的高频项（未改动，供后续处置决策）

### A. `set` 事件 → `handleSelectionChange` → 填充（`app.tsx:1829`）
- **触发**：主开关开启时的每条选区 `set`（`channel`/`selection`）。
- **成本**：整条填充链路，模态作用域按分支数从 1 到十余个不等，另有全文档像素读写。
- **判定**：**用户主动功能，不是浪费**。已有 `isFilling` 同步锁 + `pendingSelection`
  合并连续事件、`fillReadyRemain()` 私有 60ms 冷却。不建议动。

### B. `app.tsx` `pollDocIdentity`（500ms，`DOC_WATCH_INTERVAL_MS`）
- **触发**：无条件常驻，**每 500ms 一次** `psTryRead` = 1 个模态作用域。
- **原因**：它是文档级事件的兜底通路 —— 万一某宿主版本不派发 `open`/`close`，
  只有它能发现文档换了。
- **判定**：**正确性通路，不宜简单停掉**。若要降频，方向是「文档级事件正常时
  放宽轮询、事件缺失时才加密」，而不是固定 500ms。

### C. `app.tsx` `pollQuickMask`（300ms）
- **触发**：`fillOptionsVisible && isExpanded` 时常驻。
- **成本**：每轮 1 个模态作用域（`doc.id` + `quickMaskMode`）。
- **判定**：已按可见性启停，属合理轮询。若面板长期展开，300ms 可放宽到 500ms。

### D. `app.tsx` `pollToolChange`（300ms）
- **触发**：`isEnabled && autoOffOnOtherTool`（「切到其它工具即关」开启时）。
- **成本**：每轮 1 个模态作用域（`getSelectedBrushToolEnum` + `app.currentTool`）。
- **判定**：已按开关启停。300ms 偏激进，可考虑 500ms。

### E. 三个子面板的 `checkMaskModes` 监听（`PatternPicker` / `GradientPicker` / `ColorSettingsPanel`）
- **触发**：各自 `addPsNotificationListeners` 注册全部 20 个事件；
  effect 依赖 `[isOpen]`，**面板一开就挂**。
- **成本**：每条通知一次 `debouncePsProbe` → `checkMaskModes()` →
  `LayerInfoHandler.getActiveLayerInfo()` → `psRead` = 1 个模态作用域。
  有 300ms TTL 缓存，纯选区 `set` 不打脏 ⇒ 多数命中缓存。
- **放大机制**：三个面板**同时打开**时，1 条通知 ⇒ 3 次探测调用（缓存共享，
  但调度点有 3 个）。历史上曾因 `removeNotificationListener` 引用不匹配
  导致监听器泄漏、回调随开合次数累加（`psAccess.ts:184-226` 已用 WeakMap 修复）。
- **判定**：可考虑把「mask/通道状态」收敛为**一个共享订阅者**（发布-订阅），
  而不是每个子面板各挂一份。改动面较大，需评估。

### F. 跨面板共享状态的轮询（原「守护进程轮询」，M4 起改属 `utils/` 总线）
- `MainToggleBus` / `FillPanelToggleBus` / `FocusModeBus`（`src/utils/`）用共享文件
  分发状态，各订阅方 `setInterval` 轮询（`MainToggleBus.ts:229`）。这些是**文件系统**
  IO，不进 `executeAsModal` ⇒ **不计入本告警**，但会占主线程。
- ⚠️ 2026-10-13 原文写的是 `BrushHotkeySection` / `FuncHotkeyPanel` 各自轮询
  「守护进程广播的共享文件」。守护进程已随 M4 退役，轮询逻辑收敛进总线模块，
  热键命中改由进程内 `.8li` 经 WS 18923 送达 `HotkeyBridge` 再进总线 —— 机制
  （文件 IO、非模态）不变，属位变了不是消除。

---

---

## 五、2026-10-17 复核：清单的遗漏项

复核方式：`src/` 全量扫描 `executeAsModal / runAsModal / psRead( / psTryRead( /
probeHostIdle / debouncePsProbe / refreshLayerSnapshot( / buildLayerTree( /
getActiveLayerInfo( / refreshActiveDoc(`，逐文件计数后与上文四节对账。

### G. `app.tsx` 自身的常驻探测（**清单完全没列**）

- **触发**：`app.tsx:679` 注册 `addPsNotificationListeners(this.handleNotification)`
  —— 与三个子面板同款的全 20 事件订阅；`handleNotification`（:2989）对**每一条**
  通知都执行 `this.maskProbeDebounced()`（:3000）⇒ `checkMaskModes()` ⇒
  `LayerInfoHandler.getActiveLayerInfo()` ⇒ 1 个模态作用域。
- **为什么比 E 更该先管**：E 列的三个子面板是**按需挂载**（面板开了才注册），
  而 `app.tsx` 是主面板、**从插件加载起就挂着、永不卸载**。即三个子面板全关着，
  这一条照样对每条 `set` 打一次探测。清单里 E 的「放大机制」只算了子面板数量，
  漏了基数里还有这个常驻项。
- **成本**：每条通知 1 个模态作用域（有 300ms TTL 缓存，多数命中缓存 ⇒ 实际
  IPC 少，但 `debouncePsProbe` 的**调度点**与告警计数仍按次发生）。
- **本轮处置（已实施）**：`checkMaskModes` 路径未动（它要跟手），改为在**巡检类**入口
  加进程内模态层级判据（见下节，已入 MEMORY.md 铁律 11）。

### H. 两个下拉的 `refreshLayerSnapshot()` 仍无 `maxAgeMs`

- `refreshLineReferenceOptions`（AdjustmentPanel.tsx:1631）与
  `refreshMaskSyncOptions`（:1056）都调 `refreshLayerSnapshot()` ——
  **默认 `maxAgeMs = 0` ⇒ 每次都真做全树遍历**（1 模态 + ≈5N 次宿主 get）。
- 清单二/三的修复只**收窄了触发源**（不打脏、不刷），没有改读取本身的缓存口径。
  后果：用户反复开合下拉（这是常用动作）⇒ 每次都是一次全量遍历，与「收窄触发源」
  的收益方向相反。
- **建议（低风险）**：这两处传 `maxAgeMs`（如 1500ms）。语义与「用户刚点开要最新」
  不冲突 —— TTL 比一次交互间隔短即可。
- ⚠️ 2026-10-17 复扫确认：**仍未处置**（两处 `refreshLayerSnapshot()` 依旧无参）。

### I. 未列入但确认**不是**遗漏的项（已逐个核对）

| 文件 | 判定 |
| --- | --- |
| `utils/StrokeSelection.ts`(13) | 描边，用户主动；不常驻 |
| `utils/ColorPicker.ts`(8) | 拾色器弹窗，用户主动 |
| `hotkey/HotkeyBridge.ts`(7) | `setTimeout` 是 WS 重连，不进模态；扫描按键走一次性 `runAsModal` |
| `utils/commandProgress.ts`(5) | `setInterval` 跑在**已有**模态作用域内，不额外计数 |
| `utils/SingleChannelHandler.ts`(3) / `knockoutBatchProcessor.ts`(3) / `ClearHandler.ts`(1) | 用户主动 |
| `utils/layerTreeSnapshot.ts`(7) / `utils/psAccess.ts`(39) | 被上面各条**间接**计入，不是独立来源 |

### 本轮新增的降频手段（借 LNP 逆向结果）

PICA `modalStateChanged` 把 PS **自己的模态嵌套层级**报进进程（`'Lvl '` 键，
零 batchPlay），面板因此有了**肯定式**的忙碌证据，不必再靠常数窗口外推：

- `.8li`：读描述符键 `'Lvl '` → `I_MODALLVL`；`smoothState.pen.modalLevel` 下发。
  另有 `toolModal`（工具模态，只取证）、`docEpoch`（`'Opn '/'Cls '` 累计）。
- `psProbe.ts`：新增 `setInProcModalLevel()` / `psBusyInProc()`（**三态**返回：
  1=确定忙 / 0=确定闲 / -1=不可用）。⛔ 故意**不并进 `isPsBusy()`** —— 那是否定式
  安全闸，若被层级接管，用户主动的填充/描边也会被挡住（更糟的回归）。
- `app.tsx`：在 5 个**巡检类**入口加了 `|| psBusyInProc() === 1` ——
  `pollSmoothToolGate`(300ms) / `pollToolChange`(300ms) / `pollDocIdentity`(500ms) /
  `pollQuickMask`(300ms) / `maybeAutoTurnOff` 的补读。丢一轮无副作用，下一轮自补。
- 叠加已有的 `toolSrc===2`（进程内 'slct' 接管 ⇒ 停掉 `pollSmoothToolGate`），
  B/C/D 三条常驻轮询在「PS 忙」或「平滑已接管」两种情形下都会真正停摆，
  而不再是「名义上有开关、实际上一直读」。

## 优先级建议

| 优先级 | 项 | 理由 |
| --- | --- | --- |
| ✅ 已修 | 蒙版同步引擎（4 → 0） | 零任务时纯浪费，且 `set` 频率最高 |
| ✅ 已修 | 线稿参考下拉（1 → 0） | 每条 `set` 一次全树遍历，N 越大越痛 |
| ✅ 已修 | 蒙版同步面板侧刷新 | 零任务时 buildLayerTree 全套无意义 |
| ✅ 已处置 | G（`app.tsx` 常驻探测） | 巡检类入口已加进程内模态层级判据（0x0113，铁律 11）；`checkMaskModes` 保留跟手 |
| 🔶 待评估 | H（两个下拉无 `maxAgeMs`） | 一行改动，收窄触发源的收益才不会被动线抵掉；10-17 复扫仍开放 |
| 🔶 待评估 | E（三子面板各自挂监听） | 结构性收敛，收益随「常开子面板数」放大 |
| 🔶 待评估 | B / C / D 轮询间隔 | 低风险微调，需权衡「切文档发现延迟」 |
| ⛔ 不动 | A（选区填充） | 用户主动功能 |
