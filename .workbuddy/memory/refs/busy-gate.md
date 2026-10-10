# 忙碌闸门 / 模态作用域 / 文档世代号（JWautofill）

> `MEMORY.md` 的展开页。**改闸门相关代码前先读本文件**——这是唯一权威，其余记忆里的旧说法一律以此为准。

## 一、它解决什么

三类操作必弹宿主原生「命令"获取"当前不可用」：**切文档**（含新开/关闭后自动切换）、**快速删图层**、**删完立刻选区填充**。本质是「在 PS 忙的时候发了 `get`」。

旧设计的病根（一句话）：**闸门是开环的时长估计**——通知在命令**中途**派发，只给出忙碌区间的一个采样点，命令尾部「不派发通知但仍忙」是盲区。凡是缩短等待、减少往返、调整读取时机的改动，都会让问题按比例复现。所以现在的设计**不靠等待时长，靠三个可观测事实**。

## 二、三个可观测事实（新架构的基础）

| 事实 | 载体 | 取代 |
| --- | --- | --- |
| F1 事件是否还在来 | `psProbe`：窗口 = 「最后一条通知之后再静默 QUIET」 | 事件时刻 + 常数窗口 |
| F2 是否持有模态作用域 | `psAccess.psRead()` → `core.executeAsModal` | 「猜 PS 何时空闲」 |
| F3 文档世代号是否变了 | `psProbe.getDocGeneration()` | 「关闭/切文档后缓存指向旧文档」 |

### 铁律

- ⛔⛔ **`isPsBusy()` 已降级为「粗筛」**：只负责快速失败、不排队；**正确性由 `psAccess.psRead()` 的模态作用域兜底**。任何**会打断用户操作、失败即弹框**的读取（填充/描边/面板交互）都必须走 `psRead`；后台轮询可只用粗筛（丢一轮无副作用）。
- ⛔ **全局窗口依旧不得为提速缩短**（没走 `psRead` 的调用点仍暴露在宿主面前）。提速走 `fillReadyRemain()`。
- ⛔ **禁止任何「顺延上限用尽即硬闯」**：上限用尽只能「放弃本轮/慢速重查，等下一次事件重新调度」。
- ⛔ **读取方不得 `markPsBusy` 为自己预留窗口**（历史自锁来源）：读取不派发通知，自我预留只会把面板长期钉在忙态。
- ⛔ **`executeAsModal` 不可嵌套**；宿主忙碌（`error.number===9`）时**没有**「直读兜底」——正确反应是**延长闩锁 + 返回失败**，绝不降级裸读（那正是弹框来源）。
- ⛔ **通知注册一律走 `psAccess.add/removePsNotificationListeners`**（名单 = `PS_NOTIF_EVENTS`）：UXP 对数组里的非法事件名会**整体抛错** ⇒ 必须**逐事件名容错注册**。

## 三、文档级「持续忙碌」闩锁（闭合 F1 盲区）

| 环节 | 载体 |
| --- | --- |
| 进入 | `noteDocLevelEvent()` ⇒ `beginDocLatch()`（`open`/`close`/`save`/`select+document`/置入图层事件 任一命中） |
| 保持 | **闩锁期间 `isPsBusy()` 恒为真** ⇒ 所有读取（含未走 `psRead` 的裸读）一起退避 |
| 释放 | `psAccess.probeHostIdle()`：一次**只拿锁、不读任何数据**的空 `executeAsModal`，**连续成功**（配合最小保持时长）才放行 |
| 兜底 | `DOC_LATCH_MAX_MS`(30s) 触顶强制释放 + 冷却防活锁 |

- ⛔ **释放判据是「能不能拿到模态锁」，不是时间**。探测本身**必须零读取**（任何 get 在忙碌期都会弹框）；拿锁失败只是可捕获的异常。
- ⛔ **`extendDocLatch()` 是「开或续」**（无闩锁时也会开——读取失败本身就是忙碌证据）。
- ⛔ **`save` 也按文档级处理**（保存大文档同样是「宿主握着模态作用域数秒」），已进 `PS_NOTIF_EVENTS` 与 `isDocLevelDescriptor`。
- ⛔ **任何新增的同步裸读都必须在入口判 `isPsBusy()`**，否则闩锁对它无效。
- ⛔ **闩锁探测必须指数退避**（连续失败间隔翻倍，封顶；任一成功立即清零），否则确认阶段「连续成功」会被退避拖爆。

### 文档级变化的两个入口（都要）

1. **事件通路**：`markPsBusyForEvent` 命中文档级描述符 ⇒ `noteDocLevelEvent()`（世代号 ++ / 长窗口）。
2. **兜底通路**：`app.tsx` 的活动文档身份巡检 `pollDocIdentity`（500ms 读 `app.activeDocument.id`）。万一某宿主版本不派发 `open`/`close`，靠 id 变化仍能识别 ⇒ 命中后**先** `noteDocLevelEvent()`（作废在途读取）**再**清 layerInfo 缓存 + 图层树快照。
   - ⚠️ 「读失败」与「读到 null」语义相反：巡检必须用 `psTryRead`（区分 `ok:false`），**不能**用 `psRead`（会把忙碌期误判成「文档没了」⇒ 白白作废在途任务）。
   - ⛔ **身份巡检的任何「状态变化」分支都必须走 `onDocumentLevelChange()`**，不允许「只记基准就 return」（否则冷启动「无文档→有文档」时世代号不加、闩锁不开）。
   - `pollDocIdentity` 兼第二职责：闩锁期间它是**唯一**允许继续跑的通路，负责推进探测。

## 四、肯定式租约（同步裸读的最后一道闸）

- `psProbe.noteHostResponsive()` / `noteHostUnresponsive()` / `canSyncReadHost()`：「最近 800ms 内 ≥2 次经模态作用域的成功往返」才发租约；文档级事件到达即作废。
- **同步裸读的放行判据从「猜不忙」（否定式）换成「有近期成功证据」（肯定式）**——粗筛被冷启动/假阳性骗过时租约兜住。
- 同步裸读守卫（闩锁期间靠入口那一句挡住）：

| 位置 | 守卫 |
| --- | --- |
| `layerTreeSnapshot.getLayerSnapshot()` | 只返回缓存，**不遍历** |
| `MaskSyncEngine.refreshActiveDoc()` | `if (isPsBusy()) return false;` |
| `MaskSyncEngine.buildLayerTree()`（无快照兜底） | `if (isPsBusy()) return [];`（**别清空下拉**） |
| `AdjustmentPanel` 的 `refreshLineReferenceOptions` / `refreshMaskSyncOptions` | `isPsBusy()` ⇒ 保持现状（避免 UI 闪烁） |
| `app.readCurrentToolId()` | `getSelectedBrushToolEnum`（裸 get）已**移进 `psRead` 回调** |

## 五、事件窗口三档（都不得为填充提速而缩短）

| 类别 | 事件 | 窗口 | 附加动作 |
| --- | --- | --- | --- |
| 文档级 | `open` / `close` / `save` / `select+document` / 置入图层事件 | 长窗口 | 闩锁 + **世代号 ++** |
| 结构类 | `delete` / `make` / `move` / `rename` / 合并 / 拼合 / 栅格化 | 600ms | **作废宿主租约**（`noteHostUnresponsive`） |
| 纯选区 | `set`(channel/selection) | 300ms | 不动租约 |

- ⚠️ 图层数减少的所有操作（Delete / Ctrl+E / Ctrl+Shift+E / 拼合 / 盖印 / 栅格化）在事件层都表现为 `delete`(+`make`)，统一按结构类处理即可。
- ⛔ **禁止把多条「可能失败」的 get 合并进同一 batchPlay**（一条失败连带整批；宿主原生弹框绕过 JS try/catch）。

## 六、模态作用域的唯一入口：`runAsModal`（头号支点）

整套「不弹框」只靠一个结构：`psAccess.psTryRead()` 的直读分支「若在本插件自己的模态里就直接调 `fn`」。判据曾经是 `core.isModal()`。

- ⛔⛔ **禁采信 `core.isModal()`**：真机探针已定性——让 PS 处于**非本插件**的模态态（打开大 PSD / 唤出「存储为」），它照样返回 true（会算上**宿主**的模态）⇒ 直读分支在宿主繁忙时**就是裸读**（弹框源），且会让闩锁提前释放。
- ✅ 唯一判据 = `psAccess.getOwnModalDepth() > 0`，由 **`psAccess.runAsModal()` 维护**（在**回调体内**维护计数——不能包在 `executeAsModal` 外面，宿主忙碌时它会先排队、排队期我们并没握锁）。
- ⛔⛔ **任何进入模态的代码都必须走 `psAccess.runAsModal()`**：漏一处 ⇒ 该写路径内部的 `psRead`/`getLayerSnapshot`/`getActiveLayerInfo` 会看到 depth=0 ⇒ 去嵌套 `executeAsModal` ⇒ UXP 拒绝嵌套 ⇒ **读取静默失败**（症状「点了没反应」，不是弹框，更难查）。
  - 自检：`grep -rn "core.executeAsModal" src/` 只应剩注释。
- ⛔⛔ **`runAsModal` 绝不把可能为 `undefined` 的 `opts` 传作第二实参**：UXP 原生绑定对「显式 undefined 的 object 形参」严格校验 ⇒ 抛 `Argument 2 has an invalid type. Expected type: object actual type: undefined`。实现必须分岔：`opts == null ? executeAsModal(wrapped) : executeAsModal(wrapped, opts)`。
- ⛔ **全局模态命令最小间隔**（`psAccess`）：`psTryRead` 进模态前整形间隔；`probeHostIdle` 太近**跳过本轮**——跳过 ≠ 忙，**绝不能在跳过路径调 `noteHostUnresponsive()`**（会白合作废租约）。
- ⛔ 写路径（填充/描边）**不受**该节流（用户主动触发，直接调 `core.executeAsModal`）。
- ⛔ 写路径内部的直读不得加 `&& isPsBusy()`：窗口到期后它已是 false，判不出「宿主仍忙」。

## 七、通知包装器必须按 handler 记忆化

- ⛔⛔ `removeNotificationListener` 按**引用**匹配，而 `wrapDocLevelLogger` 每次新建闭包 ⇒ add/remove 拿到不同对象 ⇒ 注销失败（`Notifications could not be registered`）+ **监听器泄漏**（子面板按 `[isOpen]` 每开合泄漏一批）。
- 这是本仓**唯一「无上限累加」的模态命令放大器**（「Too many modal scope commands」红色计数持续上涨的机制）。⇒ 包装器必须用 `WeakMap` 记忆化，add/remove 走同一入口。
- ✅ 静态守卫 `node scripts/_modal_contract_guard.cjs` 盯 G1-B（opts 分岔）/ G2-A（WeakMap）/ G2-B（同入口）/ G3-A（置入图层事件名已注册）/ G3-B（该事件按文档级开闩锁）。

## 八、智能对象 / 置入图层事件

- ⛔ 事件名**必须注册**（`psProbe.PLACED_LAYER_EVENTS`，含真机给出的 `newPlacedLayer` = 「转换为智能对象」），并按**文档级**处理（`beginDocLatch`，但**不**推进世代号）：宿主内部要「新建临时文档 → 合成 → 置入 → 关闭」，与 open/save 同型。名字未注册 = 该重命令全程无闸门。

## 九、缓存

- `LayerInfoHandler` 缓存 = `cacheGen === getDocGeneration()` + 300ms TTL。快路径**不再**校验「活动图层 id」（那需要一次 DOM 读，比省下的开销更贵）；图层切换必然派发 `select` ⇒ `shouldInvalidateLayerInfo` 失效，TTL 再兜底。
- 满读取下沉为 `probeLayerInfo()`，**必须在模态作用域内**（`activeLayer.bounds` 是无法异步化的 DOM 属性读）。

## 十、真机取证（弹框再现时第一步就是它）

- `__jwPs.dump()`：最近 60 条读取面包屑（含失败原因）；`__jwPs.state()`：闸门状态（含 `ownModalDepth`）；`__jwPs.trace(true)`：实时逐条。
- 文档级事件有固定日志 `📥 文档级事件: <名字>`。

## 十一、残余缺口（知情即可，别顺手补）

- `HotkeyBridge.getSelectedBrushToolEnum/getSelectedBrushNameId/enumerateBrushes` 本体仍是裸 get（现由 `readCurrentToolId` 统一包进 `psRead` 后再调；`HotkeyBridge` 内其它调用点尚未收口）。
- `AdjustmentPanel` / `pixelDataProcessor` / `ClearHandler` 等在**用户触发的写路径**里仍直接读 `app.activeDocument` —— 那些路径本就各有自己的 `executeAsModal`，且用户不会在「文档正在打开」的瞬间点它们，暂不迁移。
- 写路径（fill / stroke / 蒙版同步 / 清除）继续各自持有 `executeAsModal`，未合并。

## 十二、离线验收与台架纪律

- 离线台架思路：用 `typescript.transpileModule` 就地转译 `psProbe.ts` **真源码**，配可控假时钟，逐场景断言；再加一组静态契约扫描。这类回归**编译 / 类型检查 / UI 全都看不出来，只能靠场景断言**。
- ⚠️ **台架补丁不要猜转译后的模块别名**（命名导入会被包成 `(0, psProbe_1.canSyncReadHost)()`），应额外注入形参供补丁调用，否则断言「检查的是空串」= 假通过。
- ⚠️ **提取函数体的工具必须稳健**（对泛型/箭头函数签名不能切出假片段），并配**提取器自检**。
- ⚠️ 台架断言要容忍「样本不足 / 两段 busy」的真实形状，别写「必须接近整段忙期」这类断言。
- ⚠️ 本机 **Node 嵌套 `spawnSync` 会被静默拦截**（`status=null` 无报错）⇒ 变异测试须由 bash 脚本驱动。
