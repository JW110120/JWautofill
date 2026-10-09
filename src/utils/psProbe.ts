/**
 * PS 忙碌闸门 + 事件静默阈值 + 文档世代号（单一事实来源）
 * ============================================================================
 * 设计（2026-10-08 重构，取代「常数窗口」时代）
 * ----------------------------------------------------------------------------
 * 旧实现在**收到通知的那一刻**打一个固定窗口（普通 300ms / 切文档 1200ms），
 * 把「命令还要跑多久」当成一个可以猜的常数。但 PS 的通知是在命令执行**中途**
 * 派发的，它只给出忙碌区间的一个采样点 —— 命令尾部那段「不再派发通知、但 PS
 * 仍在忙」的时间**不可观测**，只能靠常数堵。弱机 + 大文档必然不够。
 *
 * 现在改成三个**可观测事实**：
 *   · F1 事件是否还在来  ⇒ 窗口 = 「最后一条通知之后再静默 QUIET」。
 *     删除风暴期间事件持续刷新 ⇒ 窗口自动续期；安静期立即放行。**无需知道命令多长。**
 *   · F2 是否持有模态作用域 ⇒ 见 `psAccess.psRead()`。**正确性由它兜底**，
 *     本模块的 `isPsBusy()` 因此降级为**粗筛**（快速失败、不排队）。
 *   · F3 文档世代号是否变了 ⇒ `docGeneration`。文档级事件即 ++，
 *     用于作废在途读取与缓存（防「关闭再打开后仍用旧文档数据」）。
 *
 * ⚠️ 由此得到一条**新的**、必须遵守的分工铁律：
 *   · 后台轮询/探测 ⇒ 可以只依赖 `isPsBusy()` 粗筛（它们丢一轮无副作用）；
 *   · **任何会打断用户操作、失败即弹框的读取（填充/描边/面板交互）⇒ 必须同时走
 *     `psAccess.psRead()`**，因为粗筛只降低概率、不保证正确。
 *   · 「把全局窗口缩短以给填充提速」依旧是**禁止**的（粗筛失效时，那些没走
 *     `psRead` 的调用点会直接暴露给宿主）—— 提速请走 `fillReadyRemain()`。
 */

/** 「普通」PS 通知（set/select/make/delete…）之后的**静默阈值**（毫秒）。 */
export const QUIET_AFTER_EVENT_MS = 300;

/**
 * 「结构类命令」（删图层 / 合并 / 拼合 / 栅格化 / 新建 / 移动 / 改名 / 盖印…）
 * 之后的**静默阈值**（毫秒）—— 比普通事件长，比文档级事件短。
 *
 * ⚠️ 为什么必须与「选区事件」分开（2026-10-09 补）：
 * 这些命令的**共同后果是图层数/结构变化**，而 README 里那套「读图层树」的消费方
 * （图层下拉、蒙版同步、线稿参考层解析）正是**逐层 5 次 get** 的重消费者 ——
 * 一次误判不是弹一个框，是弹一屏框。尤其：
 *   · `Delete Layer`、`Ctrl+E 合并图层`、`Ctrl+Shift+E 合并可见图层`、
 *     `拼合图像`、`盖印可见图层`、`栅格化图层/所有图层`、多选合并、组内的合并 ——
 *     **凡是让图层数减少的操作，都会在命令中途派发 `delete`（并常伴随 `make`）**，
 *     而合并/拼合往往比单次删除更慢（要重算合成结果）。
 *   · 事件到达时命令**还没结束**（通知是在命令执行中途派的），所以窗口必须比
 *     单次删除更宽，否则窗口一到期、命令尾部那几百毫秒就完全暴露。
 *
 * ⚠️ 只影响**非选区**事件：纯选区变更（`set` + channel/selection）继续用
 * `QUIET_AFTER_EVENT_MS`，**不得**被本常数拖慢 —— 填充的「快」依赖它。
 *
 * ⚠️ 取值刻意与下方 `HEAVY_EVENT_NEIGHBOR_MS`（= 填充路径用来判断「最近有重命令」的
 * 窗口）保持一致：两者回答的是同一个问题（「结构类命令大概还要跑多久」），
 * 用同一个数字就不会出现「闸门以为忙、填充以为闲」的错位。未合并成同一个常量是因为
 * 本常数在文件顶部导出、而 `HEAVY_EVENT_NEIGHBOR_MS` 是私有且声明在后（TDZ）。
 */
export const QUIET_AFTER_STRUCTURAL_EVENT_MS = 600;

/**
 * 「文档级重命令」（切文档 / 打开 / 关闭）之后的**静默阈值**（毫秒）。
 *
 * 为什么必须比普通事件长：切文档不是一次瞬时命令 —— PS 要重建文档窗口、
 * 图层面板、历史状态；打开大 PSD 要整棵解析建树；关闭要 teardown 并激活下一份
 * 文档。期间任何 `app.activeDocument` / `doc.layers` / batchPlay get 都会被宿主
 * 拒绝并弹「命令"获取"当前不可用」。
 */
export const QUIET_AFTER_DOC_EVENT_MS = 1200;

/**
 * 文档级「持续忙碌」闩锁的最长保持时间（毫秒）—— 兜底防死锁。
 *
 * 闩锁的释放条件不是时间，而是「一次成功的模态探测」（见 psAccess.probeHostIdle）。
 * 这个上限只在探测行为本身出问题（例如宿主永久握着模态作用域）时才生效。
 */
export const DOC_LATCH_MAX_MS = 30000;

/**
 * 「重命令邻居」的判定窗口（毫秒）—— **只给填充路径**的私有冷却用。
 *
 * 最近这么久内发生过非选区事件（make/delete/打开/关闭/切文档）⇒ 说明 PS 可能
 * 仍在处理重命令，填充宁可服从全局静默阈值；否则只等 `FILL_COOLDOWN_MS`。
 */
const HEAVY_EVENT_NEIGHBOR_MS = 600;

/**
 * 填充路径的**私有**冷却（毫秒）—— 纯选区事件之后只需等这么久即可开填。
 *
 * 这是「填充要快」与「全局闸门必须保守」两个矛盾的解法：全局窗口不动，
 * 填充只等自己的短冷却；剩余风险由 `psAccess.psRead()` 的模态作用域兜底
 * （最坏是排队/可捕获的失败，而不是宿主原生弹框）。
 */
const FILL_COOLDOWN_MS = 60;

/**
 * 判断一个通知是否是「在已打开文档之间切换」。
 *
 * PS 派发 `select`，descriptor 形如
 * `{ _obj:'select', _target:[{ _ref:'document', … }] }`；而选区/图层选择
 * 的 `_ref` 分别是 `channel` / `layer`。因此「事件是 select」+「target 里有
 * document」两个条件即可精确命中，**纯对象判断、不碰 DOM**（通知回调内唯一
 * 允许做的事）。
 *
 * ⚠️ 为什么要限定 select：`set` 事件的 `_target` 里也可能出现 document 引用
 *（改文档级属性），若不限定事件名会把普通 set 也误判成切文档 ⇒ 平白多等 900ms。
 *
 * ⚠️ 依据：Adobe 官方 Action/Core 事件表里都**没有** `currentDocumentChanged`
 *（那是 ExtendScript Generator 的网络事件，UXP 用不了），UXP 只能靠
 * `select` + descriptor 识别切文档 —— 官方论坛结论一致。
 */
export function isDocSwitchDescriptor(eventName?: string, descriptor?: any): boolean {
    if (eventName !== 'select') return false;
    const target = descriptor?._target;
    if (!Array.isArray(target)) return false;
    return target.some((t: any) => t && t._ref === 'document');
}

/**
 * 判断一个通知是否是「文档级重命令」（打开 / 关闭 / 保存 / 切文档）—— 命中即用长静默阈值。
 *
 * ⚠️ `open` / `close` / `save` 一律按文档级处理，**不做更细的判别**：即使某个宿主
 * 版本对别的对象也派发同名事件（误判为文档级），代价只是多等一段静默期（性能），
 * 而漏判的代价是宿主原生弹框（正确性）。两害相权，宁多等。
 *
 * ⚠️ 为什么把 `save` 也算进来（2026-10-08 第二轮）：Adobe 论坛上「命令"获取"当前
 * 不可用」的复现条件被归纳为「保存 / 拼合 / 打开时随机出现」——保存大 PSD 与打开
 * 大 PSD 同样是「PS 自己握着模态作用域且长达数秒」的命令，插件期间的任何 get 都会
 * 被拒。它此前不在名单里，属于与 `open`/`close` 同源的覆盖缺口。
 */
export function isDocLevelDescriptor(eventName?: string, descriptor?: any): boolean {
    if (eventName === 'open' || eventName === 'close' || eventName === 'save' || eventName === 'saveAs') {
        return true;
    }
    return isDocSwitchDescriptor(eventName, descriptor);
}

/**
 * 「智能对象 / 置入图层」类事件名 —— 本仓事件命名口径下，**事件名即描述符 `_obj`**。
 *
 * ⚠️ 为什么必须单列一类（2026-10-09 用户真机报障）：
 * 「转换为智能对象」派发的描述符是 `{ _obj: 'newPlacedLayer', _isCommand: false }`
 * （`_isCommand: false` = 通知型描述符，即通知回调收到的那个）。
 * 该名字**不在** `PS_NOTIF_EVENTS` 里 ⇒ 这条重命令**全程没有任何忙碌窗口**，
 * 与 `open` / `close` 的历史缺口（根因 R2）**完全同型**：
 * 命令执行期间闸门恒为 false，各轮询/事件驱动读取照常发起，有几率撞上宿主
 * 的模态作用域 ⇒ 宿主原生「命令"获取"当前不可用」。用户实测「对若干图层执行
 * 转换为智能对象时有几率复现」。
 *
 * 为什么按**文档级**处理（而不是普通结构类 600ms）：宿主执行「转换为智能对象」
 * 时内部要「新建临时文档 → 合成 → 置入 → 关闭临时文档」，是与 `open` / `save`
 * 同型的「宿主自己握着模态作用域、可能达数秒」的重命令 —— 任何常数窗口都堵不住
 * 它尾部那段不可观测的忙碌期（这正是 `QUIET_AFTER_DOC_EVENT_MS` 当年不够用的原因）。
 *
 * 名字来源：`newPlacedLayer` 由用户真机描述符直接给出；其余为 Photoshop 动作
 * 事件表里同族的置入图层命令名，属于「宁可多听一个」——注册是**逐名容错**的，
 * 宿主不认识的名字只被跳过，不会拖垮其余监听。
 */
export const PLACED_LAYER_EVENTS: readonly string[] = [
    // 「转换为智能对象」（用户真机取证的确切名字）
    'newPlacedLayer',
    // 同族：编辑内容 / 转为链接智能对象 / 重新链接 / 替换内容
    'placedLayerEditContents',
    'placedLayerConvertToLinked',
    'placedLayerRelinkToFile',
    'placedLayerReplaceContents',
];

/** 通知名是否属于「智能对象 / 置入图层」类（见 `PLACED_LAYER_EVENTS`）。 */
export function isPlacedLayerEvent(eventName?: string): boolean {
    if (!eventName) return false;
    return PLACED_LAYER_EVENTS.indexOf(eventName) >= 0;
}

/**
 * 判断一个通知是否是「选区变更」。
 *
 * PS 在套索/魔棒/选区修改/取消选区后派发 `set`，descriptor 形如
 * `{ _obj:'set', _target:[{ _ref:'channel', _property:'selection', … }] }`。
 */
export function isSelectionDescriptor(descriptor?: any): boolean {
    const target = descriptor?._target;
    if (!Array.isArray(target)) return false;
    return target.some(
        (t: any) => t && t._ref === 'channel' && t._property === 'selection'
    );
}

/* ------------------------------------------------------------------ *
 * 事件记忆（纯内存，零 IPC；通知回调内可安全调用）
 * ------------------------------------------------------------------ */

// ⚠️ 用 -1 而不是 0 表示「从未发生」：0 是 falsy，会让 `if (lastXxxAt && …)`
// 短路 ⇒ 在时间戳恰为 0 的场景（测试台/时钟回拨）下保护失效。
let lastEventAt = -1;          // 最近一次「任何事件」的时刻
let lastHeavyEventAt = -1;     // 最近一次「非选区事件」的时刻
let lastSelectionEventAt = -1; // 最近一次「选区事件」的时刻
let docGeneration = 0;         // 文档世代号（文档级事件即 ++）

/** 仅供测试/诊断：重置事件记忆与世代号。 */
export function resetLongEventMemory(): void {
    lastEventAt = -1;
    lastHeavyEventAt = -1;
    lastSelectionEventAt = -1;
    docGeneration = 0;
    psBusyUntil = 0;
    docLatchActive = false;
    docLatchDeadline = 0;
    docLatchCooldownUntil = 0;
    docLatchStartedAt = 0;
    lastHostOkAt = -1;
    hostOkStreak = 0;
}

/**
 * 当前文档世代号。任何文档级事件（打开/关闭/切文档）都会 +1。
 *
 * 用法：读取**前后**各取一次，若不等 ⇒ 结果可能来自已销毁的文档 ⇒ 作废重读。
 * `psAccess.psTryRead()` 已内置该校验；缓存模块（LayerInfoHandler /
 * layerTreeSnapshot）也应把世代号纳入 key。
 */
export function getDocGeneration(): number {
    return docGeneration;
}

/**
 * 显式登记一次「文档级变化」（供 `open`/`close` 之外的通路使用）。
 *
 * 入口有两个：
 *   · `markPsBusyForEvent` 命中文档级描述符时（事件通路）；
 *   · app 层的「活动文档 id 巡检」发现 id 变了时（**兜底通路**：万一某宿主
 *     版本不派发 `open`/`close`，巡检仍能发现文档换了）。
 */
export function noteDocLevelEvent(requireMinHold = true): void {
    const now = Date.now();
    docGeneration++;
    lastEventAt = now;
    lastHeavyEventAt = now;
    psBusyUntil = Math.max(psBusyUntil, now + QUIET_AFTER_DOC_EVENT_MS);
    // 时间常数堵不住「打开/关闭大文档要好几秒」这件事 ⇒ 同时开启闩锁，
    // 由模态探测（psAccess.probeHostIdle）决定何时真正放行。
    beginDocLatch(requireMinHold);
}

/* ------------------------------------------------------------------ *
 * 文档级「持续忙碌」闩锁（F1 盲区的闭合）
 * ------------------------------------------------------------------ *
 * 为什么还要闩锁：静默阈值回答的是「**通知**是否还在来」，而 PS 自己握着的模态
 * 作用域（打开 / 关闭 / 保存大文档）可以远超任何一个常数窗口 —— 期间通知可能早已
 * 停发、PS 却仍在忙。旧写法在窗口到期后就把读取放行，于是**裸读**（未走
 * `psRead` 的同步读：图层树快照、蒙版同步的 refreshActiveDoc、笔刷工具枚举…）
 * 直接撞进宿主的模态作用域，每发一次 get 就弹一次「命令"获取"当前不可用」——
 * 这就是用户实测「打开/关闭超大文档要连点八下警告窗口」的机制。
 *
 * 闩锁语义：
 *   · 进入：文档级事件（或 app 层巡检发现文档换了）；
 *   · 保持：`isPsBusy()` 恒为真 ⇒ 所有读取（含未走 `psRead` 的裸读）一起退避；
 *   · 释放：**只能**由一次成功的模态探测释放（时间不是判据），另有 `DOC_LATCH_MAX_MS`
 *     兜底防死锁。
 */
let docLatchActive = false;
let docLatchDeadline = 0;
/**
 * 闩锁**首次**开启的时刻（毫秒）。`beginDocLatch` 是幂等的（重复调用只重置上限），
 * 因此这里只在「从关闭态转入开启态」时写入 —— 语义是「这一轮文档级操作从何时开始」。
 *
 * 用途：app 层的释放判定要求闩锁至少已保持 `DOC_LATCH_MIN_HOLD_MS` 才允许放行。
 * 单靠「探测成功」是不够的：**打开大文档是分阶段的**，宿主完全可能在某些阶段之间
 * 短暂松开模态锁 —— 那时探测会成功、但立刻发起的读取照样撞回忙碌窗口（2026-10-08
 * 真机实测「打开 400MB PSD 必然弹框」的直接机制）。
 */
let docLatchStartedAt = 0;
/**
 * 闩锁冷却期（触顶后的强制「正常工作窗口」）。
 *
 * 防的是**活锁**：若探测机制本身失效（例如某宿主/某插件长期占着模态作用域，
 * 使 `probeHostIdle` 永远失败），闩锁会「触顶 ⇒ 释放 ⇒ 立刻被下一次失败重新开启」
 * ⇒ 插件实际永远处于忙碌态、面板再也不刷新。触顶后强制冷却一段时间再允许开启，
 * 保证插件始终有可工作的窗口（代价只是那段时间内可能再弹框，而这是极端场景）。
 */
let docLatchCooldownUntil = 0;
const DOC_LATCH_COOLDOWN_MS = 5000;

/** 开启（或续期）文档级闩锁。幂等：重复调用只会重置上限。 */
export function beginDocLatch(requireMinHold = true): void {
    const now = Date.now();
    if (now < docLatchCooldownUntil) return;   // 触顶后的冷却期：先让插件正常工作一会儿
    // 只在「首次进入」时记录起始时刻。
    // ⚠️ 两种进入方式的意义不同，必须区分：
    //   · 文档级事件 / 读取失败 ⇒ 有**正在跑的重命令** ⇒ 要求最短保持（防「阶段间隙」骗过探测）；
    //   · 身份巡检刚发现「原来有文档」（插件启动时文档已打开）⇒ 我们刚刚**成功读到**
    //     了宿主的回答，宿主并非忙碌 ⇒ 不必再强制多等（否则插件启动后白等一轮）。
    if (!docLatchActive) docLatchStartedAt = requireMinHold ? now : 0;
    docLatchActive = true;
    docLatchDeadline = now + DOC_LATCH_MAX_MS;
    psBusyUntil = Math.max(psBusyUntil, now + QUIET_AFTER_DOC_EVENT_MS);
    // 文档级事件 = 宿主忙碌的**证据** ⇒ 立即作废「宿主可读租约」，
    // 让无法异步化的同步裸读立刻停手（不必等租约自然过期）。
    noteHostUnresponsive();
}

/** 闩锁已保持的毫秒数（未生效 / 不要求最短保持时返回 0）。 */
export function getDocLatchAgeMs(): number {
    if (!docLatchActive || docLatchStartedAt <= 0) return 0;
    return Math.max(0, Date.now() - docLatchStartedAt);
}

/**
 * 闩锁的「最短保持」是否已满足。
 *
 * `docLatchStartedAt <= 0` 表示本轮**不要求**最短保持（见 beginDocLatch 的说明）。
 */
export function isDocLatchMinHoldElapsed(minHoldMs: number): boolean {
    if (!docLatchActive) return true;
    if (docLatchStartedAt <= 0) return true;
    return Date.now() - docLatchStartedAt >= minHoldMs;
}

/** 闩锁是否生效中（app 层的文档巡检据此决定是否继续跑模态探测）。 */
export function isDocLatchActive(): boolean {
    return docLatchActive;
}

/**
 * 登记「宿主仍在忙」的证据：**没有闩锁就开一个**，有就续期。
 *
 * 语义上它比名字更宽 —— 之所以叫 extend 而不是 begin，是因为主要调用点是
 * 「模态探测/读取失败」：那既可能是闩锁期间的正常续期，也可能是**首次**撞上
 * 宿主模态作用域（例如别的插件持锁、或闩锁恰好刚被判定释放）。两种情形都该
 * 让所有读取一起退避，所以统一在这里「开或续」。
 *
 * ⚠️ 不会造成永久停摆：闩锁的关闭由模态探测负责（`psAccess.probeHostIdle`
 * 成功即释放），另有 `DOC_LATCH_MAX_MS` 兜底。
 *
 * @returns 闩锁是否仍然有效。`false` 表示已达上限、闩锁已强制释放
 *          （此时调用方必须恢复常规节流，不能再阻塞读取）。
 */
export function extendDocLatch(): boolean {
    const now = Date.now();
    // 「宿主还在忙」是**证据**，不是猜测：同步裸读的租约必须立刻作废。
    noteHostUnresponsive();
    if (!docLatchActive) {
        beginDocLatch();
        return docLatchActive;   // 冷却期内 beginDocLatch 不会生效 ⇒ 如实返回
    }
    if (now >= docLatchDeadline) {
        // 兜底：探测方式本身失效（宿主永久模态）时不能让插件永久停摆。
        // 同时进入冷却期，避免「触顶 ⇒ 释放 ⇒ 立刻重开」的活锁。
        docLatchActive = false;
        docLatchCooldownUntil = now + DOC_LATCH_COOLDOWN_MS;
        return false;
    }
    psBusyUntil = Math.max(psBusyUntil, now + QUIET_AFTER_DOC_EVENT_MS);
    return true;
}

/** 释放闩锁（模态探测成功 ⇒ 宿主已可控）。 */
export function endDocLatch(): void {
    docLatchActive = false;
}

/**
 * 通知到达瞬间打**全局**忙碌标记（**通知回调内唯一允许做的事**，不碰 DOM）。
 *
 * ⚠️ 必须在事件到达时调用，不能放到探测函数体内 —— 否则忙碌窗口会被探测自身
 * 反复延长，形成「永远等不到空闲」的自锁。
 *
 * ⚠️⚠️ 窗口现在有**三档**（2026-10-09 起），且**都不得为「填充更快」而缩短**：
 * 本函数产出的是全局共享粗筛闸门，被 9 处轮询/探测依赖。缩短它 ⇒ 那些调用点在
 * PS 忙碌期提前放闸 ⇒ 宿主弹框（2026-10-08 已付过代价）。填充要的「快」走
 * `fillReadyRemain()`（它只看**选区**事件的短冷却）。
 *   · 文档级（open/close/save/切文档）⇒ 长阈值 + 闩锁 + 世代号 ++；
 *   · 结构类（delete/make/move/rename/合并/拼合/栅格化…）⇒ 中阈值 + 作废宿主租约；
 *   · 纯选区（set + channel/selection）⇒ 短阈值，不作废租约。
 */
export function markPsBusyForEvent(eventName?: string, descriptor?: any): void {
    if (isDocLevelDescriptor(eventName, descriptor)) {
        // 文档级：长静默阈值 + 世代号 ++（作废在途读取与缓存）
        noteDocLevelEvent();
        return;
    }
    const now = Date.now();
    lastEventAt = now;

    if (isSelectionDescriptor(descriptor)) {
        lastSelectionEventAt = now;
        // ⚠️ 纯选区变更**不**作废宿主租约：它不代表「宿主刚执行过重命令」，
        //    而且填充要紧接着读 PS（`fillReadyRemain` 的短冷却就建立在这条上）。
        psBusyUntil = Math.max(psBusyUntil, now + QUIET_AFTER_EVENT_MS);
        return;
    }

    // ---- 智能对象 / 置入图层类：按**文档级**重命令处理（见 PLACED_LAYER_EVENTS）----
    // 这条分支补的是一个「事件覆盖缺口」：名字不在监听名单里 ⇒ 以前根本没有窗口。
    // 命中后与 open/save 同待遇：长窗口 + 文档级闩锁 + 作废宿主租约。
    // ⚠️ 不调 `noteDocLevelEvent()`（它会 `docGeneration++`）：这里文档实例并没有换
    //    （只是图层结构变了），推进世代号会让在途读取被无谓作废。
    if (isPlacedLayerEvent(eventName)) {
        lastEventAt = now;
        lastHeavyEventAt = now;
        beginDocLatch();
        return;
    }

    // ---- 结构类事件：删图层 / 合并 / 拼合 / 栅格化 / 新建 / 移动 / 改名 ----
    // 记录「重命令邻居」供填充路径的私有冷却判断（纯内存，不影响窗口语义）。
    lastHeavyEventAt = now;
    // ⚠️ 这里是**不对称补齐**（2026-10-09）：此前 `noteHostUnresponsive()` 只在
    //    `beginDocLatch()` / `extendDocLatch()` 里被调，而 `delete`/`make` 这类
    //    结构事件**既不在文档级名单里、也不开闩锁** ⇒ 它们从不作废「宿主可读租约」。
    //    稳态下 3 个 300/500ms 的轮询会让 `hostOkStreak` 长期 ≥2、`lastHostOkAt`
    //    永远新鲜 ⇒ `canSyncReadHost()` 实际退化成只看 `isPsBusy()`（与设计意图相反）。
    //    现在：一次结构事件就是「宿主刚忙过」的**证据**，立即作废租约。
    noteHostUnresponsive();
    psBusyUntil = Math.max(psBusyUntil, now + QUIET_AFTER_STRUCTURAL_EVENT_MS);
}

// ---------------- 忙碌窗口（F1 静默阈值的落地形式） ----------------

let psBusyUntil = 0;

/**
 * 手工标记一段忙碌窗口。
 *
 * ⚠️ **读取方不要再调用它**：读取不产生通知，自我延长只会让整个面板持续
 * 处于「忙」态、把填充的冷却无谓地拉长（这正是历史上「自锁」的来源）。
 * 仅两类调用点保留：① 通知回调（走 `markPsBusyForEvent`，已封装）；
 * ② 写路径在开始改动前为自己预留窗口，避免与他方读取互撞。
 */
export function markPsBusy(ms = 300): void {
    psBusyUntil = Math.max(psBusyUntil, Date.now() + ms);
}

/** 当前是否仍处于 PS 忙碌窗口（Date.now() 驱动，避免残留计时器）。 */
export function isPsBusy(): boolean {
    // ⚠️⚠️ 闩锁期间**必须**恒为真：静默阈值只是一个常数，而「打开/关闭/保存大文档」
    // 可以让 PS 连着忙好几秒 —— 若这里只看时间戳，闩锁与阈值到期之间的空档里，
    // 那些**未走 psRead 的裸读**（图层树快照 / 蒙版同步 refreshActiveDoc / 工具枚举）
    // 会照常发 get，等于闩锁白做。闩锁的关闭由模态探测负责（psAccess.probeHostIdle），
    // 因此「恒为真」不会造成永久停摆。
    if (docLatchActive) return true;
    return Date.now() < psBusyUntil;
}

/**
 * 忙碌窗口剩余毫秒数（0 表示已空闲）。
 *
 * ⚠️ 闩锁期间返回的是「下次该回来看看」的节流值（`QUIET_AFTER_DOC_EVENT_MS`），
 * **不是**闩锁上限：调用方普遍把它当 `setTimeout` 的延迟用，返回上限会让面板
 * 在闩锁释放后仍被推迟十几秒才刷新。
 */
export function psBusyRemain(): number {
    if (docLatchActive) {
        return Math.max(QUIET_AFTER_DOC_EVENT_MS, psBusyUntil - Date.now());
    }
    return Math.max(0, psBusyUntil - Date.now());
}

/* ------------------------------------------------------------------ *
 * 宿主「可读租约」（Host Read Lease）—— 同步裸读的最后一道闸
 * ------------------------------------------------------------------ *
 * 为什么需要它：闩锁与静默阈值都是**否定式**判断（「大概不忙了」）。仍有一类读取
 * 无法异步化、只能同步发 get（图层树快照遍历、蒙版同步的 refreshActiveDoc），
 * 它们的正确性只能寄托在这类判断上 —— 判断错一次就是**一次宿主原生弹框**。
 *
 * 这里补一条**肯定式**证据：任何一次**经模态作用域成功返回**的读取，都证明
 * 「宿主的 get 通道在刚才那一刻是通的」。记下它的时间戳，同步裸读只在
 * 「最近 `HOST_LEASE_MS` 内有过成功往返」且「连续成功 ≥ 2 次」时才允许发 get：
 *   · 宿主空闲 ⇒ 巡检每 500ms 一次成功 ⇒ 租约长期有效，行为与改前一致；
 *   · 宿主忙碌 ⇒ 读取失败 ⇒ 连击清零 ⇒ 租约立即失效 ⇒ 同步裸读自动全部冻结。
 *
 * ⇒ 关键性质：**不需要知道宿主为什么忙**。「打开大文档期间没有任何事件、
 *   `open` 事件名又不被派发」这种最坏情况，也会被这条肯定式证据兜住。
 *
 * ⚠️ 租约只是**同步裸读**的最后一道闸，不是正确性依据：异步路径一律走
 * `psAccess.psRead()` 的模态作用域（官方互斥原语，最坏也只是可捕获的失败）。
 * ⚠️ 现状（2026-10-09）：本仓**已不再有同步裸读** —— `getLayerSnapshot()` 与
 * `MaskSyncEngine.buildLayerTree` 的同步遍历路径都已删除（理由见各自注释：
 * 同步遍历是 5N 次 get 的**乘法放大器**，判据再准也不该留着）。因此租约目前的
 * 消费者只剩**诊断**（`dumpPsGateState` / `__jwPs.state()`）。保留它是因为
 * 「肯定式证据」这个思路本身仍是排查时的关键信息，且未来若新增同步读取可直接复用。
 */
const HOST_LEASE_MS = 800;
let lastHostOkAt = -1;
let hostOkStreak = 0;

/** 登记一次「宿主刚刚回答了我们」的成功往返（由 psAccess 的成功路径调用）。 */
export function noteHostResponsive(): void {
    lastHostOkAt = Date.now();
    hostOkStreak++;
}

/** 登记一次「宿主没能回答我们」（失败/模态冲突/文档级事件）—— 立即冻结同步裸读。 */
export function noteHostUnresponsive(): void {
    hostOkStreak = 0;
}

/**
 * 同步裸读现在是否可以安全地发 get。
 *
 * `false` 时调用方必须**返回缓存或跳过本轮**，绝不降级为「照发一次试试」——
 * 那个「试试」就是弹框本身。
 */
export function canSyncReadHost(): boolean {
    if (isPsBusy()) return false;          // 粗筛 + 闩锁
    if (hostOkStreak < 2) return false;    // 连续两次成功才算「稳」：单次可能只是阶段间隙
    if (lastHostOkAt < 0) return false;
    return Date.now() - lastHostOkAt <= HOST_LEASE_MS;
}

/** 仅供测试/诊断：读出租约内部状态。 */
export function getHostLeaseState(): { streak: number; lastOkAt: number; valid: boolean } {
    return { streak: hostOkStreak, lastOkAt: lastHostOkAt, valid: canSyncReadHost() };
}

/**
 * 填充路径的**私有**冷却剩余毫秒数（0 = 现在就可以进填充）。
 *
 * 判定：
 *   · 最近 `HEAVY_EVENT_NEIGHBOR_MS` 内发生过**非选区**事件（删除/新建/打开/
 *     关闭/切文档）⇒ PS 可能仍在处理重命令 ⇒ 服从**全局**静默剩余时间；
 *   · 否则（纯选区事件 / 刚启动）⇒ 只等私有的 `FILL_COOLDOWN_MS`。
 *
 * ⚠️ 本函数只回答「**愿不愿意现在开始**」，不回答「**能不能安全读**」。
 * 后者由 `psAccess.psRead()` 的模态作用域保证 —— 所以这里的常数可以很小，
 * 不会再出现「猜错就弹框」。
 */
export function fillReadyRemain(): number {
    const now = Date.now();
    if (lastHeavyEventAt >= 0 && now - lastHeavyEventAt < HEAVY_EVENT_NEIGHBOR_MS) {
        return psBusyRemain();
    }
    if (lastEventAt >= 0) {
        return Math.max(0, lastEventAt + FILL_COOLDOWN_MS - now);
    }
    return 0;
}

/**
 * 忙碌顺延超过上限后改用的「慢速重查」节奏（毫秒）。
 *
 * ⚠️ 存在的意义：忙碌窗口**可能很长**（打开大文档可达十几秒，且由闩锁+模态探测
 * 决定何时结束）。事件驱动的一次性刷新（`debouncePsProbe`）与启动首刷
 * （`runWhenIdle`）都**不能**因为「顺延次数用尽」就放弃 —— 放弃了就再没有下一次
 * 调度，面板会永远停在旧数据（典型症状：打开文档后图层下拉一直显示上一个文档）。
 * 因此上限用尽只是**放慢重查**，绝不放弃、也绝不硬闯。
 */
const SLOW_RECHECK_MS = 500;

/** `runWhenIdle` 执行期连续失败的重试上限（防`fn` 永久抛异常时死循环）。 */
const MAX_EXEC_FAILURES = 20;

/**
 * PS 事件触发的「状态探测」防抖器。
 *
 * 根因：Photoshop 的通知是在命令执行【中途】派发的——例如 Ctrl+E 合并图层时，
 * delete/make 事件在合并命令尚未结束时就到达各面板监听器。若监听器立刻发起
 * batchPlay get，会撞上 PS 的忙碌窗口。
 *
 * 对策：事件触发的探测统一走此防抖——默认 200ms 内无新事件才真正执行；
 * 到期后若 `isPsBusy()` 仍为真则继续顺延。
 *
 * ⚠️⚠️ **绝不硬闯、也绝不放弃**（2026-10-08 修正）：旧实现在顺延次数用尽后
 * **直接执行**，于是「忙碌时间 > 上限 × 单次等待」时，探测从「跳过」变成「硬闯」——
 * 这是宿主弹框的最终出口之一。第三轮进一步发现：改成「用尽即放弃」同样不行 ——
 * 文档级闩锁可能压住十几秒，12 次顺延用尽后放弃，而这类刷新是**事件驱动的一次性
 * 调度**，放弃后就再没有人来重新调度（面板永远停在旧数据）。现在改为：
 * 超过上限 ⇒ 改用 `SLOW_RECHECK_MS` 的慢速重查节奏，一直等到真正空闲为止
 * （忙碌窗口有限 ⇒ 终会执行）。
 *
 * ⚠️ 本函数只判断、**不打**忙碌标记（打标记会自我延长成自锁）。
 */
export function debouncePsProbe<A extends any[]>(
    fn: (...args: A) => any,
    wait = 200,
    maxBusyDeferrals = 12
): ((...args: A) => void) & { cancel: () => void } {
    let timer: any = 0;
    let busyDeferrals = 0;
    const run = (args: A) => {
        if (isPsBusy()) {
            busyDeferrals++;
            const slow = busyDeferrals > maxBusyDeferrals;
            timer = setTimeout(() => {
                timer = 0;
                run(args);
            }, slow ? Math.max(wait, psBusyRemain(), SLOW_RECHECK_MS) : Math.max(wait, psBusyRemain()));
            return;
        }
        busyDeferrals = 0;
        try {
            const r = fn(...args);
            if (r && typeof r.catch === 'function') r.catch(() => { });
        } catch {
            // 本轮读失败（宿主忙碌/模态被拒）⇒ 记一次顺延并按同一节奏重试。
            // ⚠️ 不能就此结束：事件驱动的一次性调度没有「下一次」，
            //    结束就等于永远停在旧数据（打开文档后图层下拉不刷新）。
            busyDeferrals++;
            timer = setTimeout(() => {
                timer = 0;
                run(args);
            }, Math.max(wait, psBusyRemain(), SLOW_RECHECK_MS));
        }
    };
    const wrapped = (...args: A) => {
        if (timer) clearTimeout(timer);
        busyDeferrals = 0;   // 新事件重新起算顺延次数
        timer = setTimeout(() => {
            timer = 0;
            run(args);
        }, wait);
    };
    (wrapped as any).cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = 0;
        }
    };
    return wrapped as any;
}

/**
 * 「空闲后单次执行」调度器：把一个会发起 PS 查询的函数推迟到忙碌窗口之后，
 * 且同一时刻只允许一个实例在跑（重入调用直接丢弃本轮，不排队）。
 *
 * 与 debouncePsProbe 的分工：
 * - debouncePsProbe：用于「连续事件只关心最后一次状态」的场景（末尾静默即执行）；
 * - runWhenIdle：用于「必须真正执行一次」的场景（如轮询兜底同步、启动首刷）。
 *
 * ⚠️⚠️ **绝不硬闯**（2026-10-08 修正）：旧实现「因忙碌顺延 maxDeferrals 次后
 * 直接执行」—— 这是宿主弹框的最终出口之一。现在改为：**只要忙就永远顺延**。
 * 由于忙碌窗口是**时间驱动、必然有限**的，无限顺延不会导致「任务永不执行」；
 * 超过 `maxDeferrals` 后只是改用更慢的重查节奏（`SLOW_RECHECK_MS`），
 * 纯粹为了减少定时器抖动。
 *
 * ⚠️ 旧实现还会在真正执行前 `markPsBusy(wait)`（为自己预留窗口）。**已删除**：
 * 读取不产生通知，自我延长只会让整个面板持续处在忙态、把填充的冷却无谓拉长。
 *
 * ⚠️ **执行期抛错也必须重试**（2026-10-08 第三轮）：`fn` 内部读 PS 失败时抛错，
 * 旧实现直接吞掉 ⇒ 本轮静默丢弃。而本函数的语义就是「必须真正执行一次」
 * （启动首刷 / 兜底轮询），丢弃即等于**任务永久丢失**（面板永远停在旧数据）。
 * 现在按慢速节奏重试，最多 `MAX_EXEC_FAILURES` 次（防`fn` 永久抛异常时死循环）。
 *
 * @param maxDeferrals 超过该次数后改用慢速重查节奏（**不再有「硬闯」语义**）。
 *   0 = 不限（一直用正常节奏）。
 */
export function runWhenIdle<A extends any[]>(
    fn: (...args: A) => any,
    wait = 300,
    maxDeferrals = 0
): ((...args: A) => void) & { cancel: () => void } {
    let timer: any = 0;
    let running = false;
    let deferrals = 0;   // 已因忙碌顺延的次数
    let failures = 0;    // 已因执行期抛错而重试的次数

    const requeue = (args: A, delay: number) => {
        timer = setTimeout(() => {
            timer = 0;
            void attempt(args);
        }, delay);
    };

    const attempt = async (args: A) => {
        if (running) return;
        if (isPsBusy()) {
            // 仍然忙碌 → 顺延重试（**不硬闯**）。忙碌窗口有限 ⇒ 终会执行。
            deferrals++;
            const slow = maxDeferrals > 0 && deferrals > maxDeferrals;
            requeue(args, slow
                ? Math.max(psBusyRemain(), SLOW_RECHECK_MS)
                : Math.max(wait, psBusyRemain()));
            return;
        }
        running = true;
        deferrals = 0;
        try {
            const r = fn(...args);
            if (r && typeof r.catch === 'function') await r;
            failures = 0;
        } catch {
            // ⚠️ 本轮失败（宿主忙碌 / 模态被拒）**不能就此结束**：本函数用于
            // 「必须真正执行一次」的场景（启动首刷、兜底轮询），结束即等于
            // 任务丢失（面板永远停在旧数据）。改为慢速重试，但设上限以防
            // 「fn 永久抛异常」时变成永不停歇的定时器。
            if (++failures > MAX_EXEC_FAILURES) return;
            requeue(args, Math.max(wait, psBusyRemain(), SLOW_RECHECK_MS));
        } finally {
            running = false;
        }
    };

    const wrapped = (...args: A) => {
        if (running) return;            // 正在跑：本轮直接丢弃，不排队堆积
        if (timer) clearTimeout(timer); // 顺延而非丢弃
        deferrals = 0;
        timer = setTimeout(() => {
            timer = 0;
            void attempt(args);
        }, Math.max(wait, psBusyRemain()));
    };
    (wrapped as any).cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = 0;
        }
    };
    return wrapped as any;
}
