# PS 忙碌闸门 / 模态作用域 / 文档世代号（2026-10-08 重构后；含当晚第二轮）

> 方案与落地记录：`outputs/busy-gate-fix-plan.md`、`outputs/busy-gate-fix-rollout.md`
> 离线台架：`node outputs/busy_gate_verify.cjs`（**139 项**；A 组把 `psProbe.ts` 真源码
> transpile 后配假时钟跑，B 组扫静态契约）

## 症状与旧设计的病根

三类操作必弹宿主原生「命令"获取"当前不可用」：**切文档**（含新开 / 关闭后自动切换）、
**快速删图层**、**删完立刻选区填充**。早期靠「长等待」规避（f556e3e），为填充性能做的
优化（300→60ms、合并 batchPlay、删冗余读）又让它复现。

⚠️ **复盘结论：旧设计从来没有「修复」过它，只是把正确性寄托在「等待足够长」上。**
凡是缩短等待、减少往返、调整读取时机的改动，都会让问题按比例复现。

四条根因：
- **R1 闸门是开环的时长估计**：通知在命令**中途**派发 ⇒ 只给出忙碌区间的一个采样点；
  命令尾部「不再派发通知但仍忙」是盲区，常数窗口就是拿来堵它的（必然不够）。**且不可观测。**
- **R2 事件覆盖缺口**：`open` / `close` **全仓无人注册**（旧 `NOTIF_EVENTS` 里没有）
  ⇒ 打开大 PSD / 关闭文档全程 `isPsBusy()` 恒 false ⇒ 轮询照常发 get。
  这解释了「首次切换报错 → 速切不报错 → **关闭再打开来回切又报错**」。
- **R3 三处「顺延上限用尽即硬闯」**（`debouncePsProbe` / `runWhenIdle` / `selectionBusyDeferrals<10`）
  ⇒ 忙碌时间超过「上限 × 单次等待」就从「跳过」变「硬闯」；而硬闯后的第一个动作
  `app.activeDocument` 恰在 `executeAsModal` **之外** ⇒ 弹框出口。
- **R4 优化为何复现**：① 300→60ms 直接压缩边际；② 改造前单次填充 ≈**67 次串行同步 IPC**
  自身耗时数十至数百 ms，**客观上充当了没人设计的等待**；③ 新增「事件 ⇒ 缓存失效 ⇒
  紧随探测必然 miss 并发 get」的耦合；④ 缩短共享闸门导致 9 处消费者连带提前放闸。

## 新架构：三个可观测事实

| 事实 | 载体 | 取代 |
|---|---|---|
| F1 事件是否还在来 | `psProbe`：窗口 = 「最后一条通知之后再静默 QUIET」 | 事件时刻 + 常数窗口 |
| F2 是否持有模态作用域 | `psAccess.psRead()` → `core.executeAsModal` | 「猜 PS 何时空闲」 |
| F3 文档世代号是否变了 | `psProbe.getDocGeneration()` | 「关闭/切文档后缓存指向旧文档」 |

### 铁律（改之前先读）

- ⛔⛔ **`isPsBusy()` 已降级为「粗筛」**：它只负责快速失败、不排队；**正确性由
  `psAccess.psRead()` 的模态作用域兜底**。任何**会打断用户操作、失败即弹框**的读取
  （填充/描边/面板交互）都必须走 `psRead`；后台轮询可只用粗筛（丢一轮无副作用）。
- ⛔ **全局窗口依旧不得为提速缩短**：没走 `psRead` 的调用点依然暴露在宿主面前
  （残余清单见 rollout 文档第 5 节）。提速走 `fillReadyRemain()`。
- ⛔⛔ **任何「顺延上限用尽即硬闯」的写法都是禁止的**。忙碌窗口是时间驱动的有限值 ⇒
  无限顺延不会导致「永不执行」；上限用尽只能「放弃本轮，等下一次事件重新调度」。
- ⛔ **读取方不得 `markPsBusy` 为自己预留窗口**（历史自锁来源）：读取不派发通知，
  自我预留只会把面板长期钉在忙态、把填充冷却无谓拉长。`runWhenIdle` 与
  `MaskSyncEngine.doTimedSync` 里的两处已删。
- ⛔ **`executeAsModal` 不可嵌套**：`psTryRead` 必须先判 `core.isModal()` 并直读
  （`core.isModal` 文档语义 = **本插件**是否正处在模态态；宿主自己的模态**不算**）。
  ⚠️ 宿主忙碌（`error.number===9`）时**不再**有「直读兜底」——那是弹框的来源，
  正确反应是延长闩锁 + 返回失败（见下）。
- ⛔ **常数窗口只有两档**：普通 `QUIET_AFTER_EVENT_MS`(300) / 文档级 `QUIET_AFTER_DOC_EVENT_MS`(1200)。
  但**文档级还有一个不靠时间的闩锁**（见第二轮一节）：阈值只决定「通知静默多久」，
  闩锁决定「宿主真正放开控制权没有」——两者都要有。
  旧的 `BUSY_AFTER_EVENT_MS` / `BUSY_AFTER_DOC_SWITCH_MS` / `BUSY_AFTER_SELECTION_EVENT_MS` **已删除**。
- ⛔ **`open` / `close` / `save` 一律按文档级处理**（不做更细判别）：误判代价是多等一段静默期（性能），
  漏判代价是宿主原生弹框（正确性）。
- ⛔⛔ **闩锁期间 `isPsBusy()` 恒为真**，释放只认模态探测；`extendDocLatch()` 是「开或续」
  （无闩锁时也会开——读取失败本身就是忙碌证据）。任何**新增的同步裸读**都必须在入口判 `isPsBusy()`，
  否则闩锁对它无效。
- ⛔ **通知注册一律走 `psAccess.add/removePsNotificationListeners`**（名单 = `PS_NOTIF_EVENTS`）：
  UXP 对数组里的非法事件名会**整体抛错** ⇒ 必须**逐事件名容错注册**。
  ⚠️ 全仓不再有内联事件数组（台架 B3 盯着这条）。

### 文档级变化的两个入口（都要）

1. **事件通路**：`markPsBusyForEvent` 命中文档级描述符（`open` / `close` / `select+document`）
   ⇒ `noteDocLevelEvent()`（世代号 ++ / 长窗口）。
2. **兜底通路**：`app.tsx` 的**活动文档身份巡检**（`pollDocIdentity`，500ms 读一次
   `app.activeDocument.id`）。万一某宿主版本不派发 `open`/`close`，靠 id 变化仍能识别。
   ⇒ 命中后必须「**先** `noteDocLevelEvent()`（作废在途读取）**再**清 layerInfo 缓存 +
   图层树快照」。

⚠️ 「读失败」与「读到 null」语义相反：巡检必须用 `psTryRead`（区分 `ok:false`），
**不能**用 `psRead`（把两者都压成 null ⇒ 忙碌期误判成「文档没了」⇒ 白白作废在途任务）。

### 缓存

- `LayerInfoHandler` 缓存 = `cacheGen === getDocGeneration()` + 300ms TTL。
  快路径**不再**校验「活动图层 id」（那需要一次 DOM 读，比它省下的开销更贵）；
  图层切换必然派发 `select` ⇒ `shouldInvalidateLayerInfo` 失效，TTL 再兜底。
- 满读取下沉为 `probeLayerInfo()`，**必须在模态作用域内**（`activeLayer.bounds` 是
  无法异步化的 DOM 属性读）。

## 第二轮（2026-10-08 晚）：删图层修好了，**开/关文档仍高频弹框**

用户真机反馈：快速删除、删完立刻选区填充**已不报错**；但**打开 / 关闭文档仍高频弹框**，
**超大文档概率更高**，有时要**连点八下**警告窗口。

### 定位（三条硬事实 + 一条结构性缺口）

1. **Adobe 文档**：`executeAsModal` 自 **25.10** 起是「**排队重试**」而非立即拒绝
   ——「During this time, the request will enter a queue to attempt again. The attempts
   will continue until the blocking modal state concludes or **time expires**」，
   `timeOut` **默认 1 秒**；冲突错误码 = **`error.number === 9`**（消息跨版本变过）。
2. **论坛现场证据**（同一故障的同款复现）：500ms 轮询读 `app.activeDocument` + 批量 get，
   「usually when Photoshop is **saving / flattening / opening**」就弹
   「The command 'Get' is not currently available」。
3. **PS 执行 `open` 时握着模态作用域，而 `open` 事件正是在该作用域之内派发给插件的**
   （论坛原话：「it fails with error number 9 – I assume because Photoshop fires the open
   event while it's still in a modal scope for opening the document」）
   ⇒ 收到 `open` 立刻读，**必被拒**；而大文档要好几秒 ⇒ 1200ms 静默阈值早就过期。
4. **结构性缺口**：`isPsBusy()` 在阈值到期后就放行，于是那些**没走 `psRead` 的同步裸读**
   照常发 get —— 而**每一次被拒的 get = 一次原生弹窗**，
   `getLayerSnapshot()` 一棵 N 层的树就是 N 次 ⇒ **「连点八下」就是树遍历**。

### 修法：文档级「持续忙碌」闩锁（F1 盲区的闭合）

| 环节 | 载体 |
|---|---|
| 进入 | `noteDocLevelEvent()` ⇒ **`beginDocLatch()`**（`open`/`close`/`save`/`select+document` 任一命中） |
| 保持 | **`isPsBusy()` 在闩锁期间恒为真** ⇒ 所有读取（含未走 `psRead` 的裸读）一起退避 |
| 释放 | **`psAccess.probeHostIdle()`**：一次「**只拿锁、不读任何数据**」的空 `executeAsModal`，**连续两次成功**才放行 |
| 兜底 | `DOC_LATCH_MAX_MS`(30s) 触顶强制释放 + `DOC_LATCH_COOLDOWN_MS`(5s) 冷却防活锁 |

- ⛔ **探测本身必须零读取**：任何 get 在宿主忙碌期都会弹框，用「读一个属性」当探测
  等于自己制造那堆警告窗口。拿锁失败只是**可捕获的异常**。
- ⛔ **连续两次成功才放行**：单次成功可能只是宿主在两个阶段之间短暂松手。
- ⛔ **`psRead` 遇 `error.number===9` / 消息含 modal ⇒ 延长闩锁 + 返回失败**，
  **绝不降级裸读**（旧的 `already in a modal` 直读兜底**已删** —— 它正是弹框来源之一）。
- ⛔ **`save` 也按文档级处理**（保存大文档同样是「宿主握着模态作用域数秒」），
  已加进 `PS_NOTIF_EVENTS` 与 `isDocLevelDescriptor`。
- `pollDocIdentity` 兼第二职责：闩锁期间它是**唯一**允许继续跑的通路，负责推进探测；
  释放后立刻做一次身份采样（`bypassCoarseGate:true`，读取本身在模态内 ⇒ 不会弹框）。

### 同步裸读守卫（闩锁期间靠这一句挡住）

| 位置 | 守卫 |
|---|---|
| `layerTreeSnapshot.getLayerSnapshot()` | `if (isPsBusy()) return cached;`（返回缓存，**不遍历**） |
| `MaskSyncEngine.refreshActiveDoc()` | `if (isPsBusy()) return false;` |
| `MaskSyncEngine.buildLayerTree()`（无快照兜底） | `if (isPsBusy()) return [];` |
| `AdjustmentPanel` 的 `refreshLineReferenceOptions` / `refreshMaskSyncOptions` | `isPsBusy()` ⇒ 保持现状（**别清空下拉**，那会造成 UI 闪烁） |
| `app.readCurrentToolId()` | `getSelectedBrushToolEnum`（裸 batchPlay get）已**移进 `psRead` 回调** |

## 离线验收（139 项）

`node outputs/busy_gate_verify.cjs` → 全部通过。A 组覆盖：普通阈值边界 / 删除风暴续期 /
文档级四事件（含 `save`）长窗口 + 闩锁 / 闩锁「时间不是释放判据」/ 闩锁上限与冷却 /
`extendDocLatch` 可在无闩锁时开启 / 世代号只被文档级事件推进 / `set+document` 不误判 /
私有冷却三态 / 两个调度器的「不硬闯」+「终会执行」/ 自锁已消除。
B 组为静态契约（含「`handleSelectionChange` 内 `app.activeDocument` 必在
`core.executeAsModal` 之后」、「`probeHostIdle` 内零 `app.*` / 零 `batchPlay`」、
「`psAccess` 不再含 `already in a modal` 裸读兜底」、四项裸读守卫）。

## ⚠️ 仍需真机确认（别当成已修好）

1. `save` 的**实际事件名与描述符形状**（`open` / `close` 已由 Adobe 文档 + 论坛现场
   证据双确认；`save` 属按同类推断）。同时建议顺手确认 `open` 在真机上是否真的派发
   （论坛里既有「会派发」也有「零通知」两种说法）—— 兜底通路能覆盖不派发的情形。
2. `probeHostIdle`（空 `executeAsModal`）在真机上能否可靠区分「宿主在自己模态里」
   与「已可控」。语义依据是 Adobe 文档的 `timeOut` 排队说明；**主判据仍是四场景是否还弹框**。
3. 若真机 Console 出现「选区填充本轮未完成」之类，说明走的是 reject 路径（正常，有退避）。

## 残余缺口（知情即可，别顺手补）

- `HotkeyBridge.getSelectedBrushToolEnum()` 本体仍是裸 `batchPlay get`，但现在由
  `readCurrentToolId` 统一包进 `psRead` 后再调（`HotkeyBridge` 内其它调用点尚未收口）。
- `AdjustmentPanel` / `pixelDataProcessor` / `ClearHandler` 等在**用户触发的写路径**里
  仍直接读 `app.activeDocument` —— 那些路径本就各有自己的 `executeAsModal`，且用户不会
  在「文档正在打开」的瞬间点它们，暂不迁移。
- 写路径（fill / stroke / 蒙版同步 / 清除）继续各自持有 `executeAsModal`，未合并。

---

## 第三轮（2026-10-08 深夜）：冷启动 + 400MB PSD 仍 100% 弹框 ⇒ 肯定式租约

### 两个机制缺陷（都已在源码修掉）
- **D1 冷启动哑火**：`applyDocIdentity` 的「无文档→有文档」分支旧版**只记基准不登记**
  ⇒ 首次打开文档世代号不加、闩锁不开；`open` 事件若又没派发（论坛证实存在），
  事件+兜底两通路全哑。**铁律：身份巡检的任何「状态变化」分支都必须走
  `onDocumentLevelChange()`，不允许「只记基准就 return」。**
- **D2 假阳性放行**：闩锁释放旧判据「连续 2 次探测成功」太弱，大文档打开中途
  间隙可假阳性。现需**三条件同时成立**：连击 3（间隔≤1200ms）+ 闩锁保持 ≥1.5s
  （`DOC_LATCH_MIN_HOLD_MS`）+ 一次受保护身份读取成功；任一失败连击清零。

### 肯定式租约（同步裸读的最后一道闸）
- `psProbe.noteHostResponsive()/noteHostUnresponsive()/canSyncReadHost()`：
  「最近 800ms（`HOST_LEASE_MS`）内 ≥2 次经模态作用域的成功往返」才发租约；
  文档级事件到达即作废。**同步裸读的放行判据从「猜不忙」（否定式）换成
  「有近期成功证据」（肯定式）**——粗筛被 D1/D2 骗过时租约兜住。
- `layerTreeSnapshot.refreshLayerSnapshot()`（async，遍历在 psRead 内）= 默认路径；
  同步 `getLayerSnapshot()` 无租约**只返回缓存、绝不遍历**。

### 调度器语义（第二轮「放弃本轮」已再次修正）
- `debouncePsProbe` 顺延用尽 ⇒ **慢速重查**（`SLOW_RECHECK_MS`=500），不再放弃
  （放弃会让大文档操作后的事件驱动刷新永久丢失）。
- `runWhenIdle` 执行失败 ⇒ 慢速重试，上限 `MAX_EXEC_FAILURES`=20（防 fn 永久抛异常死循环）。

### 真机取证（弹框再现时第一步就是它）
- `__jwPs.dump()` 最近 60 条读取面包屑（含失败原因）；`__jwPs.state()` 闸门状态；
  `__jwPs.trace(true)` 实时逐条。文档级事件有固定日志 `📥 文档级事件: <名字>`。

### 台架可信度教训（⚠️ 重要）
旧 `extractMethod` 对**泛型/箭头函数签名**会切出 ~20 字符假片段 ⇒ B 组多条断言
「检查的是空串」= **假通过**。已换稳健 `extractFnBody`（签名内左括号定位 + 同行末
候选 `{` 试配）+ **B0 提取器自检**（含真源码锚定）。**改台架断言前先确认提取器
真的切到了函数体。** 变异测试：`node outputs/busy_gate_mutate.cjs`（生成）+
`bash outputs/busy_gate_mutation.sh`（驱动，6/6 捕获）；本机 **Node 嵌套 spawnSync
被静默拦截**（status=null 无报错）⇒ 变异测试必须 bash 驱动，不能用 Node 一把跑。

---

## 第四轮：模态命令节流（「Too many modal scope commands」对策）

- ⚠️ **UXP 会对过密的 `executeAsModal` 打内部警告**（`uxp-internal/ps-common.js`，
  真机 60 次）——不是宿主报错框，但意味着调度开销 + 未来可能升级为限流。
  闩锁探测固定 400ms × 几十秒大文档打开 = 主要来源。
- ⛔ **闩锁探测必须指数退避**：连续失败间隔翻倍（400→800→1600→3200 封顶，
  `DOC_LATCH_PROBE_MAX_SHIFT=3`）；**任一成功立即清零**——否则确认阶段
  「连续 3 次、间隔 ≤1200ms」会被退避拖爆（成功间隔超过 1200ms 连击就断）。
- ⛔ **全局模态命令最小间隔 `MIN_MODAL_GAP_MS=300`**（psAccess）：`psTryRead` 进模态前
  `spaceModalEntry()` 整形；`probeHostIdle` 太近**跳过本轮**——跳过 ≠ 忙，
  **绝不能在跳过路径调 `noteHostUnresponsive()`**（会白合作废同步裸读的租约）。
- ⛔ 写路径（填充/描边）**不受**该节流——用户主动触发，直接调 `core.executeAsModal`。
- 真机证据：`[蒙版同步] 收到事件: open` ⇒ **open 事件确实被派发**（此前只是文档+论坛推断）。
