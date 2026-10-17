# LNP 26.10.14.1720（PS 27.11）PS 插件逆向提取报告

> 目标：`E:\Program Files\Lazy Nezumi Pro\plugins\ps64\MouseHookPro64.8li`
> sha256 `dc01be2b7c8d8f8fd0d8add4a310b37226858623cdd5f99abad98510b362b0cb`
> PE x86-64 / DLL（PS 插件），image base `0x180000000`，2868 个函数、2634 条字符串
> 工具链：REA 6.5.0 + Ghidra 12.1.4（无 PDB，符号为 `FUN_xxxx`，模块名来自**内嵌日志格式串**）
> 配套数据：`E:\Program Files\Lazy Nezumi Pro\psTools.xml`
>
> ⚠️ 合规与判读约定：本文只提取**机制与设计**（事件名、suite 偏移、结构体字段、判据、配置项），
> 不复制任何专有代码。所有结论标注为 **[观察]**（静态证据直接可见）/ **[推断]**（由证据推得，需真机验证）。

---

## 0. 一句话结论

LNP 与本项目是**同一种形态**：把整个引擎做成 PS 进程内的 `.8li` 插件（不是注入 DLL），
在插件里同时完成 ① Wintab 取包与坐标改写 ② 工具/模态状态感知 ③ 透明覆盖层（HUD/辅助线）渲染。
它在**三个方向**都有本项目缺的现成机制：

| 你的诉求 | LNP 对应机制（可迁移） | 状态 |
| --- | --- | --- |
| ① 一致性（加载即 HUD / 非绘制时也出 HUD） | PICA `AddNotify` 事件族 + `psTools.xml` 逐工具开关 + `LNP::Overlay` 的显示门控（前台窗口去抖、z-order 顶升、大跳跃阈值） | **[观察]** 事件与配置；Overlay 门控 **[观察]** |
| ② 稳定性（modal 溢出 / 断流） | `modalStateChanged` 读 `'Lvl '` 拿**进程内模态层级**；`hookedWTOpenA/W` 清 `lcLocks(CXL_SYSOUT)`；`hookedWTInfoW` 做 **DPI 虚拟化修正**；`WTSanityCheck` 检测 wintab32 重载重挂 | **[观察]** |
| ③ 性能（冲包） | `WTPktUtil::setMaxPkts` **高水位缓冲**（只增不减）+ `WTQueueSizeSet/Peek/QueuePacketsEx` + `overlay.maxMsgLagForRender / renderSleep / offWhileDrawing` | **[观察]** |

**反直觉的一点（必须先说）**：LNP 注册的 `toolModalStateChanged` 回调在本版本里是**空函数**（`FUN_180007d60` 反编译为 `return;`）。
也就是说「工具进入/退出绘制态」这条通知 LNP **只注册、未使用**。它对我们仍然是最有价值的线索
（说明 PS 27.11 的 PICA 里**存在**这个键），但"LNP 靠它实现了 XX"是**没有证据的推断**，必须自己真机验证。

---

## 1. 模块地图（从内嵌日志串反推，[观察]）

| 模块 | 代表性日志串 | 职责 |
| --- | --- | --- |
| `PICA::PSPluginInterface` | `initInstance / initCallbacks / getClassProperty / onSelectEvent / getCurDocViewTransform / initPSVer "Photoshop ver: %d.%d.%d"` | PS 进程内 PICA suite 封装（工具/文档/视图变换） |
| `LNP::MouseHook` | `init Wintab32 loaded.` / `hookedWTInfoW` / `hookedWTOpenA/W` / `setPSTool PS tool name: %s, type: %d, enabled: %d` / `loadPSTools` | Wintab 钩子 + PS 工具识别 |
| `LNP::WTPktUtil` | `setMaxPkts Max packets: %d` / `computePktSize Packet size: %d` / `setPenOffsetFix pen offset fix: %s` | 包缓冲与包布局计算 |
| `LNP::WTSanityCheck` | `ERROR Wintab32 dll reloaded!` | 驱动模块被重载的自检/自愈 |
| `LNP::Overlay` | `initWindow / reinitWindow / checkWindowPos / checkZOrder / foregroundWindowChange / makeWindowTransparent / setRenderPerf / enable` | 透明覆盖层（HUD / 辅助线 / 提示条） |
| `LNP::RendererDirect2D` | `mDirect2DFactory->CreateHwndRenderTarget(...)` | D2D HWND 渲染目标 |

窗口类名：`LNPOverlayWindow`（`0x180129670`）；窗口透明用 `SetWindowLongPtr`（`makeWindowTransparent`）。

---

## 2. 需求① 一致性：让 HUD 只在「套索正在画布上绘制」时出现

### 2.1 事件层的正确入口：PICA `AddNotify`，不是只有 `'slct'`

`initCallbacks`（`FUN_180007500`，证据 `ev_86cc2374…`）**逐条**注册：

```c
// suite = *(void**)(self + 0x18)   // sPSActionControl
// refcon = *(void**)(self + 8)     // 插件 self
suite->fn[0x20]  /*AddNotify*/ (refcon, eventTypeID, callback);
```

| 事件 | 常量 / 取得方式 | 回调 |
| --- | --- | --- |
| `eventSelect` | **硬编码 `0x736c6374`（`'slct'`）** | `0x180007780` |
| `eventFlip` | 硬编码 `0x466c6970`（`'Flip'`） | `0x180007790` |
| `eventOpen` | 硬编码 `0x4f706e20`（`'Opn '`） | `0x1800078e0` |
| `eventClose` | 硬编码 `0x436c7320`（`'Cls '`） | `0x180007970` |
| `eventMake` | 硬编码 `0x4d6b2020`（`'Mk  '`） | `0x180007980` |
| `eventNotify` | 硬编码 `0x4e746679`（`'Ntfy'`） | `0x180007a40` |
| `eventPlay` | 硬编码 `0x506c7920`（`'Ply '`） | `0x180007b20` |
| `mKeyIds.invokeCommand` | `StringIDToTypeID("invokeCommand")` | `0x180007c70` |
| `mKeyIds.modalStateChanged` | `StringIDToTypeID("modalStateChanged")` | `0x180007ce0` |
| **`mKeyIds.toolModalStateChanged`** | **`StringIDToTypeID("toolModalStateChanged")`** | **`0x180007d60`（空实现）** |

### 2.2 关键：`StringIDToTypeID` 就在我们已经在用的那套 suite 上，偏移 `+0x10`

`initInstance`（`FUN_180006f50`，证据 `ev_d1bb7f6b…`）里是这样取键的：

```c
(**(code **)(*(longlong *)(param_1 + 6) + 0x10))("invokeCommand",        param_1 + 0x2c);
(**(code **)(*(longlong *)(param_1 + 6) + 0x10))("modalStateChanged",    param_1 + 0x40);
(**(code **)(*(longlong *)(param_1 + 6) + 0x10))("toolModalStateChanged",param_1 + 0x44);
(**(code **)(*(longlong *)(param_1 + 6) + 0x10))("smoothing",            param_1 + 0x48);
(**(code **)(*(longlong *)(param_1 + 6) + 0x10))("viewTransform",        param_1 + 0x34); // PS 版本 > 0x12 才取
(**(code **)(*(longlong *)(param_1 + 6) + 0x10))("rulersVisibility",     param_1 + 0x28);
```

**这与 `native/PiSmooth8li/ps_tool.c` 里已经在用的 `sPSActionControl` 是同一套结构体**，四条偏移自洽：

| 偏移 | 语义 | 本项目的用法 |
| --- | --- | --- |
| `+0x10` | `StringIDToTypeID(const char*, uint32*)` | **尚未使用** ← 本次新增收益点 |
| `+0x18` | `TypeIDToStringID(uint32, char*, uint32)` | `ps_tool.c` 已在用（取工具类名） |
| `+0x20` | `AddNotify(refcon, uint32 event, void* cb)` | `ps_tool.c` 已在用（只注册了 `'slct'`） |
| `+0x28` | `RemoveNotify(refcon, uint32 event)` | 卸载时（`'All '`）已在用 |

> [推断] 返回值按 `short` 读（LNP 全部用 `short sVar2` 接），与 `ps_tool.c` 现有做法一致，无需改动。

### 2.3 工具白名单用**外置 XML**，不写死在代码里 [观察]

`psTools.xml`（安装目录根，随插件读 `\psTools.xml`）是**逐工具布尔表**：

```xml
<lassoTool>true</lassoTool>          <!-- 只有这 6 个是 true -->
<paintbrushTool>true</paintbrushTool>
<pencilTool>true</pencilTool>
<eraserTool>true</eraserTool>
<freeformPenTool>true</freeformPenTool>
<pathComponentSelectTool>true</pathComponentSelectTool>
<magneticLassoTool>false</magneticLassoTool>
<polySelTool>false</polySelTool>
…其余 40+ 个工具全部 false
```

日志串 `setPSTool PS tool name: %s, type: %d, enabled: %d` 与之对应：
`type` 来自二进制里的硬编码分类表（`paintbrushTool / pencilTool / cloneStampTool / eraserTool / magneticLassoTool / lassoTool / polySelTool / eyedropperTool / rotateTool / artboardTool …`，`0x180127f10~0x180128040`），
`enabled` 来自 XML。

**可迁移点**：把「哪些工具吃平滑」变成**数据**而不是 `/lasso/i` 硬编码字符串判断，改白名单不用重编插件。

### 2.4 HUD 的显示门控：`LNP::Overlay` 的四道闸 [观察]

```
overlay.timer.render / overlay.renderSleep       渲染定时器周期（setRenderPerf "Render timer period set to %d ms."）
overlay.timer.offWhileDrawing                   绘制中关掉某些定时器（省渲染）
overlay.timer.checkTopWindow                    周期性检查顶层窗口
overlay.maxMsgLagForRender                      消息滞后超过阈值就不渲染（防"卡住一帧画一堆"）
overlay.mouseMoveMinTimeDelta                   鼠标移动的最小节流间隔
overlay.postUpTimeDelta                         抬笔后的收尾时间窗
overlay.bigJumpSqDist                           ★ 光标一次跳跃超过该平方距离 ⇒ 不画（防瞬移拉长线）
overlay.stringInertia / overlay.textBoxTopOffset 文本惯性/位置
overlay.debugPSViewTransform                    PS 视图变换调试
```

配合行为日志：

- `foregroundWindowChange Showing Overlay - fg: 0x%X (%s) style: 0x%X %s pid: %d`
- `foregroundWindowChange Hiding Overlay - …`
- **`foregroundWindowChange Very fast fg change (%d ms), ignoring: …`** ← **前台切换去抖**：PS 面板/对话框抢焦点导致的快速前后台抖动被忽略，避免 HUD 闪烁
- `checkZOrder Higher window: 0x%X (style: 0x%X %s, class: %s), bumping overlay` ← 发现更高窗口**主动把 overlay 顶上去**（本项目 HUD 的 z 链问题正是这个）
- `makeWindowTransparent` 用 `SetWindowLongPtr` 切分层属性（有失败日志与回滚路径）

**可迁移点（直接对应你的两个抱怨）**：
1. **"程序刚加载时没有落笔就产生 HUD"** → LNP 的 overlay 是 `enable(显示)` 与 `initWindow(创建)` 分离的：
   窗口先建好但**默认不显示**，只有 `foregroundWindowChange` + 工具/使能条件都成立才 `Showing Overlay`。
   本项目应把「HUD 显示条件」从"有任何笔输入"改成**显式 AND 门**，且初值必须是"不显示"。
2. **"套索工具下调面板参数落笔也意外出 HUD"** → 需要**"正在绘制"这一维**。
   LNP 本版本没用它，但 PICA 提供了 `toolModalStateChanged`（2.1/2.2 已给坐标）。
   落地判据：HUD 显示 = `工具∈白名单` **AND** `toolModalState==drawing` **AND** `笔尖接触` **AND** `前台是 PS`。

---

## 3. 需求② 稳定性：不断流、HUD 始终正确

### 3.1 `modalStateChanged` = 进程内模态层级，零 batchPlay [观察]

`FUN_180007ce0`（证据 `ev_34784433…`）反编译结果：

```c
void onModalStateChanged(refcon, descriptor) {
    uint32 lvl = 0;
    short err = (*(code **)(descSuite + 0xb0))(descriptor, 0x4c766c20 /* 'Lvl ' */, &lvl);
    if (err == 0 && g->fn_0x90) g->fn_0x90(lvl);   // 把层级报给上层
}
```

`0x4c766c20` = `'Lvl '`。**PS 的 modalStateChanged 通知里带 `'Lvl '` 整数 = 模态嵌套层级（0 = 空闲，>0 = 处于模态作用域）**。

> 意义：这是本项目 `isPsBusy()` + `MIN_MODAL_GAP_MS` 节流那整套东西的**进程内替身**——
> 不用 batchPlay、不进模态作用域、不吃 3.3/s 预算。可以直接喂给 `psProbe.ts` 的忙碌闸门语义。
> [推断] 是否在我们关心的"自动填充弹模态"场景也会置位，需真机打日志验证。

### 3.2 `hookedWTOpenA/W`：清掉 `CXL_SYSOUT` 锁 [观察]

`FUN_18002e9f0`（证据 `ev_0178224a…`）：

```c
// LOGCONTEXTA: lcLocks 在 +0x30（lcName[40] + lcOptions + lcStatus）
if (ctx->byte[0x30] & 0x10) {              // CXL_SYSOUT（按本二进制的位定义）
    log("WARNING: CXL_SYSOUT lock present! Unsetting.");
    *(DWORD*)(ctx + 0x30) = 0;             // 整个 lcLocks 清零
}
return real_WTOpenA(hWnd, ctx, enable);    // 再交给真函数
```

`WTOpenA` 与 `WTOpenW` **各挂一份**（两条日志串 `0x180125c50` / `0x180125cf0`）。

> [推断] 用途：PS 开的上下文若带"系统输出锁"，笔的系统光标输出会被锁住/旁路，
> 这正是"取包还在但坐标不再更新 / 光标不动"这一类断流的形态之一。
> 本项目在 `jwwh-10904.log` 里已经出现过 `[ctx] WTOpenA hCtx=0x803 …` 与 `WTClose` 反复开合，
> 值得**照抄这个钩子**：在把 LOGCONTEXT 交给真 `WTOpen` 前检查并清 `lcLocks`。

### 3.3 `hookedWTInfoW`：DPI 虚拟化修正（HUD 坐标错误的根因候选）[观察]

`FUN_18002e520`（证据 `ev_cfbbe969…`），只在 `WTInfoW(4 /*WTI_DEFSYSCTX*/, 0, buf)` 时介入：

```c
UINT ret = real_WTInfoW(cat, idx, buf);            // ⚠ 先调真函数，再改 buf
if (cat == 4 && idx == 0 && buf) {
    // 读 lcIn / lcOut / lcSys 三组范围（日志）
    HDC hdc = GetDC(NULL); GetClipBox(hdc, &r);    // r = 当前进程的 DPI 虚拟化视口
    int   clipW = r.right - r.left,  clipH = r.bottom - r.top;
    int   vw = GetSystemMetrics(0x4E /*SM_CXVIRTUALSCREEN*/);
    int   vh = GetSystemMetrics(0x4F /*SM_CYVIRTUALSCREEN*/);
    int  vx  = GetSystemMetrics(0x4C /*SM_XVIRTUALSCREEN*/);
    int  vy  = GetSystemMetrics(0x4D /*SM_YVIRTUALSCREEN*/);
    int   n  = GetSystemMetrics(0x50 /*SM_CMONITORS*/);

    if (n == 1
        && *(int*)(buf + 0xA0) == clipW            // lcSysExtX == 虚拟化宽度
        && vw != clipW                              // 与真实虚拟屏不一致
        && *(int*)(buf + 0xA4) == clipH && vh != clipH
        && r.left == 0 && r.top == 0 && vx == 0 && vy == 0) {
        float dpiRatio = floorf((float)clipW / (float)vw * 100.0f + 0.5f) / 100.0f;
        log("dpiRatio applied: %.2f", dpiRatio);
        *(int*)(buf + 0xA0) = vw;                  // ★ 把 lcSysExtX/Y 改写成真实虚拟屏尺寸
        *(int*)(buf + 0xA4) = vh;
        g->dpiFixApplied = 1;
        log("WTPktUtil::setPenOffsetFix pen offset fix: %s", ...);
    }
}
```

另有：`WTInfoW(0,0,NULL)`（"wintab 是否存在"的探针）结果被**缓存**在全局变量（初值 `-1`），只查一次。

> 对照本项目：`smooth_engine.c` 的 `[calib] lcOut*: org=(0,13408) ext=(96000,61440) ⇒ px=屏幕/lcOutExt`，
> 以及铁律 4「px 权威 = 屏幕/lcOutExt」——LNP 的做法是再向前一步：
> **用 `GetClipBox` 与 `SM_C*VIRTUALSCREEN` 的差值识别 DPI 虚拟化，并把系统范围改写回真实值**。
> 这能解释"HUD 圆心与受力点分离 / 换显示器后偏移"这类"HUD 不正确"。

### 3.4 `WTSanityCheck`：wintab32 被重载 ⇒ 重挂 [观察]

日志串 `LNP::WTSanityCheck ERROR Wintab32 dll reloaded!`（`0x1801265b0`）。
[推断] 周期性检查 `wintab32` 的模块基址/HMODULE 是否变化；变了说明驱动侧被重新加载，
钩子函数指针与上下文状态失效 ⇒ 重新挂钩。这与本项目 `heal_if_unhooked()` 是同一意图，
但 LNP 把它做成**独立的显式自检项并打日志**，值得照抄（我们现在的自愈没有留痕，断流后无法归因）。

### 3.5 覆盖层窗口的健壮性 [观察]

- 窗口重建：`reinitWindow` + `checkWindowPos`（"Active window on new monitor: …"）——跨显示器/分辨率变化后重建
- z 序：`checkZOrder … bumping overlay`
- 前台：`foregroundWindowChange` + `SetWinEventHook`（导入表里只有 `SetWinEventHook/UnhookWinEvent` 这一对钩子 API）
- 透明：`makeWindowTransparent` 有**加/去**两条路径与失败日志

---

## 4. 需求③ 性能：抗冲包 / 连续套索填充的流畅度

### 4.1 `WTPktUtil::setMaxPkts` 是**高水位缓冲**，不是限流 [观察]

`FUN_1800cfd70`（证据 `ev_2e4c0dfd…`）：

```c
void WTPktUtil::setMaxPkts(uint n) {
    if (mMaxPkts < n) {                       // 只增不减
        free(mBuf);
        mBuf = alloc(mPktSize * n);           // 一次分配够大
        mMaxPkts = n;
    }
    if (n != mLastLogged) log("Max packets: %d", n);
}
```

配套 `WTPktUtil::computePktSize Packet size: %d`。
**结论：LNP 不节流，它把"历史上最大的一次批量"当作缓冲上限，一次性预分配到高水位**，
从而消掉每次取包都可能发生的 realloc。这是"抗冲包"的性能侧答案：**先把缓冲做够，再谈算法**。

### 4.2 队列相关的 Wintab API 全部被挂/被用 [观察]

导入/挂钩名单（`0x1801261c8~0x1801262a0`）：
`WTOpenW / WTOpenA / WTPacketsPeek / WTPacket / WTPacketsGet / WTQueuePacketsEx / WTInfoW / WTInfoA / WTEnable / WTQueueSizeSet / WTOverlap`

其中 **`WTQueueSizeSet(hCtx, nPkts, fEnable)`** 是 Wintab 的"包队列深度/是否排队"开关——
队列深度决定 `WTPacketsGet` 一次能吐多少包（即"冲包"的直接来源）。
[推断] LNP 用它把队列深度调到"刚好够平滑、又不积压"的档位；具体数值在配置里，本轮未取到。

### 4.3 渲染侧节流 [观察]

`overlay.maxMsgLagForRender`（消息滞后超阈值就不渲染）、`overlay.renderSleep`、`overlay.mouseMoveMinTimeDelta`、
`overlay.timer.offWhileDrawing`、`Overlay::setRenderPerf "Render timer period set to %d ms."`

> 这是"连续套索填充不卡"的另一半：HUD 用**独立定时器 + 滞后/节流阈值**渲染，
> 而不是"来一个包画一次"。本项目 HUD 目前是随包驱动（日志里 `[hud] 显示` 每 1s 左右一次），
> 可以引入同样的 `maxMsgLag` 与固定渲染周期。

### 4.4 对照本项目实测：目前其实**没有冲包** [观察]

`jwwh-10904.log` 全程 `[pk]` 记录：`最大单次=1~4 包`、`≥25包次数=0`、`累计冲包峰值=0`。
即：**真正的瓶颈不在冲包，而在断流**（23:33:12 起 `[dead] ★包流断供`，`packets` 冻结在 7672，
`dead=1`，此后 `reason=5(悬空)` 持续 4 分钟）。
⇒ 需求③的投入应该放在"缓冲预分配 + 渲染节流"这两件便宜的事上，
主力仍应放在需求②的第 3.2/3.3/3.4 条。

---

## 5. 落地清单（按性价比排序，均为**设计**而非代码复制）

| # | 动作 | 落在哪里 | 预期收益 | 风险 / 验证点 |
| --- | --- | --- | --- | --- |
| 1 | 在 `ps_tool.c` 的同一套 `sPSActionControl` 上加 `StringIDToTypeID`（`+0x10`），注册 `modalStateChanged`，回调里读 `'Lvl '`（`0x4c766c20`）整数 | `native/PiSmooth8li/ps_tool.c` + `plugin_main.c` | 进程内拿到 PS 模态层级 ⇒ 可替换 `isPsBusy()` 的部分轮询，直接缓解 modal scope 预算吃紧 | 需真机验证 `'Lvl '` 在"自动填充弹模态"时是否置位；suite `+0x10` 需与 `+0x18/+0x20` 行为互相印证 |
| 2 | 注册 `toolModalStateChanged` 并打点（回调先留空，只计次 + 记值），确认 PS 27.11 到底发不发、发几次 | `ps_tool.c`（新增事件，参照 2.1/2.2） | 拿到"正在绘制"这一维 ⇒ 需求①里"调面板参数落笔也出 HUD"的唯一根治入口 | **LNP 自己的回调是空的**，没有"它有效"的证据；必须自己打点确认后再接逻辑 |
| 3 | HUD 显示改成显式 AND 门，初值=隐藏：白名单工具 ∧ 绘制中 ∧ 笔尖接触 ∧ 前台=PS；加"快速前台切换去抖"（参考 `Very fast fg change (%d ms), ignoring`） | `smooth_engine.c` 的 HUD 显示分支 | 消除"刚加载就出 HUD"与"误触发 HUD" | 要同步 O1 铁律（`WS_EX_TRANSPARENT` 保留、`WS_EX_TOPMOST` 写在 `CreateWindowExW`） |
| 4 | 挂 `WTOpenA/W`：交给真函数前检查 `lcLocks`（`+0x30`）是否带 `CXL_SYSOUT` 位（`0x10`），有则清零 | `native/PiSmooth8li/`（新增钩子） | 消除"上下文带输出锁 ⇒ 取包在但坐标不更新"类断流 | 位定义以本二进制为准；改 LOGCONTEXT 有风险，只在检测到位时动，并留日志 |
| 5 | 挂 `WTInfoW`：单显示器 + `lcSysExt == GetClipBox 尺寸 != SM_CXVIRTUALSCREEN` 时，把 `lcSysExt` 改写为真实虚拟屏尺寸并记录 `dpiRatio` | 同上 | 修"HUD 位置/半径不对、换屏后偏移" | 必须与铁律 4（px 权威 = 屏幕/lcOutExt）一起回归 |
| 6 | 包缓冲改**高水位预分配**（只增不减），并落一条 `Max packets: %d` 日志 | `smooth_engine.c` 取包路径 | 消掉批量取包时的 realloc 抖动 | 简单、低风险 |
| 7 | HUD 渲染加节流：`maxMsgLagForRender` 式的滞后阈值 + 固定渲染周期（替代"来包即画"） | HUD 线程 | 连续填充时的帧稳定 | 注意 O1：HUD 只是不重画，**不要**改成不显示 |
| 8 | `WTSanityCheck` 式自检：周期性比对 `wintab32` 模块基址，变了就重挂**并打日志** | 自愈路径 | 断流后可归因 | 与现有 `heal_if_unhooked()` 合并，别做双份 |
| 9 | 逐工具白名单外置成 XML/JSON（照 `psTools.xml` 的形态，但只保留我们支持的三个套索） | 面板 + `.8li` | 改白名单不重编 | 与 `/lasso/i` 口径必须同步（现有铁律已要求） |

---

## 6. 证据索引

| 证据 ID | 内容 |
| --- | --- |
| `ev_ccf0c9ed…` | binary_overview：段表 / 2868 函数 / 2634 字符串 |
| `ev_5ab347ca…` | 字符串：`slct\|lasso\|tool`（工具名表、`setPSTool` 日志、`psTools.xml`） |
| `ev_32024006…` | 字符串：`modal\|AddNotify\|PICA\|notify`（PICA 事件族全表） |
| `ev_7152b42d…` | 字符串：`WTPacket\|WTOpen\|WTQueueSizeSet\|wintab…`（钩子清单） |
| `ev_00e235e1…` | 字符串：`overlay\|guide\|smooth\|radius\|rope\|lasso`（Overlay 模块与配置项） |
| `ev_d1bb7f6b…` | 伪代码 `0x180006f50`（initInstance：`StringIDToTypeID @ +0x10` 逐键取 ID） |
| `ev_86cc2374…` | 伪代码 `0x180007500`（initCallbacks：10 条 `AddNotify @ +0x20` 与事件常量） |
| `ev_c0a479d8…` | 伪代码 `0x180007d60`（`toolModalStateChanged` 回调 = 空函数） |
| `ev_34784433…` | 伪代码 `0x180007ce0`（`modalStateChanged` 回调：读 `'Lvl '` = `0x4c766c20`） |
| `ev_2e4c0dfd…` | 伪代码 `0x1800cfd70`（`WTPktUtil::setMaxPkts` 高水位缓冲） |
| `ev_0178224a…` | 伪代码 `0x18002e9f0`（`hookedWTOpenA`：清 `lcLocks` 的 `CXL_SYSOUT`） |
| `ev_cfbbe969…` | 伪代码 `0x18002e520`（`hookedWTInfoW`：DPI 虚拟化修正 + `WTInfo(0,0,0)` 缓存） |

## 7. 局限与未知

1. **无 PDB**：函数名全部来自内嵌日志串，控制流归属是 Ghidra 的推断。
2. **静态分析不证明运行时行为**：`toolModalStateChanged` 是否在 PS 27.11 上真的投递、投递频率、
   以及 `'Lvl '` 在哪些场景置位，**都未在本次证据中观察到**，必须真机打点。
3. `WTQueueSizeSet` 的具体参数值、`overlay.*` 各项的默认数值本轮未取（在配置/预设文件里，
   可再查 `presets/`、`toolbar.xml`、或主程序 `LazyNezumiPro.exe`）。
4. 主程序 `LazyNezumiPro.exe`（2.4 MB）与 `plugins/ps32/MouseHookPro.8li` **未分析**；
   平滑算法本体（拉绳/追笔/贝塞尔等，`bezier2.render.distPerCurveRadius`、`smoothStep/smootherStep`）
   可能在主程序里，也可能就在这个 .8li 里（本 .8li 已含 `LNP::RendererDirect2D`）。
5. 本报告只取机制，不含任何 LNP 源码片段；所有"落地"条目均需按本项目架构自行实现。

---

# 8. 落地状态（2026-10-17 凌晨，版本 0x0113）

> 本节记录 9 条清单的**实际落点**。构建：`bash native/PiSmooth8li/build.sh` 零告警，
> PiPL 往返校验一致，导出表 `AutoPluginMain / jw8li_version / jwwh_unhook / jwwh_version` 齐备；
> `npx tsc --noEmit` 的 `src/` 报错 **0**；`yarn build` 通过（仅既有的体积告警）。

## 8.1 变更清单（change manifest）

| # | 文件 | 改动 | 默认状态 |
| --- | --- | --- | --- |
| ①② | `native/PiSmooth8li/ps_tool.c` | 加 `StringIDToTypeID(@+0x10)`；注册 `modalStateChanged`（读 `'Lvl '=0x4c766c20`）、`toolModalStateChanged`（只取证）、`'Opn '/'Cls '`；新增 `pstool_modal_level/tool_modal/doc_epoch` 等 getter | 注册失败只记日志，不影响 `'slct'` |
| ①② | `native/PiSmooth8li/plugin_main.c` | `CFG_NLONGS 48→56`，新增 `I_MODALLVL/MODALTS/TMODAL/TMODALK/DOCEPOCH`；pump 每 500ms 搬到共享内存；`smoothState` 新增 5 个 JSON 字段；`jw_log_dir()` 导出 | 全程零 batchPlay |
| ③ | `native/PiSmooth8li/smooth_engine.c` | HUD 改**显式 AND 门**（工具白名单 ∧ 一笔之中 ∧ 笔尖接触 ∧ 前台=PS ∧ 无大跳跃 ∧ 未滞后 ∧ 拉绳模式 ∧ HUD 位）；初值隐藏；`HUD_FG_DEBOUNCE_MS=250` 前台去抖；`HUD_BIG_JUMP_PX=400` 大跳跃丢弃 | 生效 |
| ④ | 同上 `det_WTOpenA` | 观测 `lcLocks(+48)` 的 `CXL_SYSOUT(0x10)`，按开关**清该位**后再交真 `WTOpenA` | **只观测**（`clearLocks=0`） |
| ⑤ | 同上 `det_WTInfoA/W`（新增两个只读钩） | DPI 虚拟化检测：`lcSysExt` vs `SM_CXVIRTUALSCREEN`，算 `dpiRatio`，按开关改写 | **只观测**（`fixDpi=0`） |
| ⑥ | 同上 `det_WTOpenA` | `WTQueueSizeSet(hCtx, N)` 调大驱动队列 | **不动**（`queueSize=0`） |
| ⑦ | 同上 `hud_frame_wait` | 运笔中（`penDown && gateOk`）帧间隔 8→16ms（`offWhileDrawing` 语义）；`HUD_MAX_LAG_MS=60` 滞后跳帧 | 生效 |
| ⑧ | 同上 `se_wt_moved()` + `plugin_main.c` pump | wintab32 模块基址周期比对，变了**落痕**并重挂（先 2 后 1） | 生效 |
| ⑨ | 同上 `ps_tool.c` | 工具白名单外置到 `%LOCALAPPDATA%\JWautofill\psTools.xml`（照 `E:/…/psTools.xml` 的逐工具布尔形态）；缺文件回退 `ci_has(name,"lasso")` | 生效（回退口径逐字等价） |
| 接线 | `src/hotkey/LassoSmoothing.ts` `src/utils/psProbe.ts` `src/app.tsx` | `PenSmoothStatus` 新增 5 字段；`setInProcModalLevel()/psBusyInProc()` 三态；5 个巡检入口加 `|| psBusyInProc() === 1` | 生效 |

## 8.2 三条刻意的"默认不开"

④⑤ 会**改写 PS 传进来的结构体**，判错直接动到笔的坐标；⑥ 调大队列会**加剧**延迟
（与"治冲包"的目标方向相反）。三者都做成外置开关，缺文件 = 全 0：

```
%LOCALAPPDATA%\JWautofill\smooth8li\wtctx.ini
    clearLocks=0     ; ④ 1=清 lcLocks 的 CXL_SYSOUT
    fixDpi=0         ; ⑤ 1=把 lcSysExt 改写成真实虚拟屏尺寸
    queueSize=0      ; ⑥ >0 时在 WTOpen 后调 WTQueueSizeSet
```

⛔ 判读顺序：先只看 `pi8li.log` / `jwwh-<pid>.log` 里的 `[ctx] ④…` 与 `[dpi] ⑤…` 行，
**证据成立**再改 ini（改口径不必重编 .8li，下次加载生效）。

## 8.3 ⚠️ ⑤ 的偏移存疑（必须真机定案）

- 本仓库 `[calib]` 段实测的 LOGCONTEXTA 布局：`lcSysOrg=132/136/140`、`lcSysExt=144/148/152`。
- 本轮 LNP 逆向报告给的是 `+0xA0/+0xA4`（=160/164），与本仓布局**差 16 字节**。
- 两者的静态证据都没有强到能互相否决 ⇒ `wtinfo_observe()` **两套都打**，
  真机日志里谁等于 `SM_CXVIRTUALSCREEN` 谁就是对的。

## 8.4 验收时该看的日志（另一台 PS 27.11 机器）

| 想确认的事 | 看哪本日志 | 期望出现 |
| --- | --- | --- |
| 'slct' 是否真的接管 | `%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log` | `闸门状态 state=2 回调≥1 读到≥1`（切一次工具后） |
| 模态层级是否投递 | 同上 | `PS 模态层级 N ⇒ …（modalStateChanged 第 n 次）` |
| 工具模态是否投递 | 同上 | `toolModalStateChanged 已投递…`（**极性待证** ⇒ 未证明前不门控） |
| ④ lcLocks | `%TEMP%\jwwh-<pid>.log` | `# [ctx] ④ lcLocks=0x… 带 CXL_SYSOUT` |
| ⑤ DPI | 同上 | `# [dpi] ⑤ WTInfoA cat=… 虚拟屏=(w,h) …` |
| ⑧ 重载 | `pi8li.log` | `[wt] ★wintab32 已重载` = 0 次为佳 |
| 版本 | `jwwh-<pid>.log` 头部 | `0x0113` |

⛔ 两本日志的分工别搞混：判 PICA / ps_tool 的一切看 `pi8li.log`（plugin_main.c 写）；
`%TEMP%\jwwh-<pid>.log` 是 `smooth_engine.c` 的引擎日志，**按设计不含 ps_tool 任何一行**。

---

# 9. 首次真机验收（0x0113）与 0x0114 修复（2026-10-17 06:33 会话，pid 3064）

> 样本：`%TEMP%\jwwh-3064.log`（引擎，601 行）+ `%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log`（插件，175 行）
> ⚠️ 引擎日志含二进制字节 ⇒ grep 必须带 `-a`。

## 9.1 正面结论：三项 PICA 通知**全部验证成功**

| 通知 | 证据 | 判定 |
| --- | --- | --- |
| `'slct'` | 10 次回调与 10 次工具切换 **1:1 对应**（pencil→eyedropper→convertKnot→wetBrush→smudge→wetBrush→move→typeCreateOrEdit→rotate→eraser），`state=1 ⇒ 2` 正常接管 | ✅ **完全工作** |
| `modalStateChanged` | 4 次投递，06:31:25 `-1⇒1`、06:31:27 `1⇒0`、06:33:41 `0⇒1`+`1⇒0` | ✅ 工作 |
| `'Opn '/'Cls '` | 06:33:42 第 1 次 ⇒ `docEpoch=1`（与 PS 退出时机吻合） | ✅ 工作 |
| `toolModalStateChanged` | 64 次投递，但**全部是 1ms 内 `1→0` 成对翻转** | ⚠️ **证伪（见 9.3）** |

这是本项目第一次在真机上证实「PS 27.11 的 PICA 会向 .8li 投递 `slct`」——
昨天（0x0112）那场只有注册成功、回调 0 次。

## 9.2 用户报的「HUD 失效」：一半是正确行为，一半是真 bug

**时间线（两本日志对齐）**

| 时刻 | 引擎侧 | 插件侧 |
| --- | --- | --- |
| 06:31:52.249 | `[gate] penDown 0→1` packets=129 smoothed=5 | state=1（面板轮询喂 `gate=1`） |
| 06:31:52~57 | `[hud] 显示` ×3 | |
| 06:31:55.215 | `toolOk=1`（面板读到套索） | |
| **06:31:57.989** | | **★接管闸门（首次读到 `pencilTool` ⇒ gate=0）** ⇒ state=2 |
| 06:31:58 起 | `toolOk=0`、`reason=2(非套索)` **全程** | |
| 06:32:02 起 | `draw=0(tm=0,k=1)` **一路到日志末尾** | |

**① 正确的一半**：用户切换的 10 个工具**没有一个是套索**（pencil / eyedropper /
convertKnot / wetBrush / smudge / move / typeCreateOrEdit / rotate / eraser）⇒
`gate=0` ⇒ HUD 隐藏。**这正是诉求①「只在套索绘制时出 HUD」生效的直接证据。**

**② 真 bug 的一半**：见下。

## 9.3 ⛔ 真 bug：`drawOk` 把 HUD **永久挡死**（0x0114 已修）

原实现：`drawOk = 极性已证 ? (最后一次值 == 1) : 放行`。

真机证据：
```
06:32:00.072 工具模态 -1 ⇒ 1（键=0x4C766C20，第 1 次）
06:32:00.073 工具模态 1 ⇒ 0（键=0x4C766C20，第 2 次；★极性已证明）
```
- `toolModalStateChanged` 的键是 **`0x4C766C20` = `'Lvl '`**，与 `modalStateChanged`
  **同一个键** —— 它不是「工具是否在绘制态」，而是 PS 每次工具操作的**模态瞬时起落**。
- 64 次投递**全部**是 1ms 内 `1→0` 翻转 ⇒ **最后一次值恒为 0**，而极性一经那两次
  翻转就被判「已证明」⇒ `drawOk` 从 06:32:02 起恒为 0。
- 后果：**即使切回套索，HUD 也再不会显示** —— 这就是用户说的「失效」里那条本不该有的。

**修复**：`drawOk` 恒放行（只保留 `tm=` / `k=` 在诊断行里继续取证）。
①诉求由 `gateOk`（工具闸门）∧ `strokeOk`（一笔之中，含 penDown）**完全覆盖** ——
真机 06:31:57 之前的三次正常显示正是这两项在工作。

> 📌 教训：昨天我判断"LNP 的这个回调是空函数 ⇒ 只取证不门控"，但代码里
> `tmK=1` 后**仍然**拿它挡了。`pstool_tool_modal_known()` 的「极性已证明」只要求
> 见过 0 与 1 各一次 —— 对一个 1ms 翻转的信号来说，这个门槛**形同虚设**。

## 9.4 ⑤ 的偏移已由真机定案（昨天标的两套**都错**）

```
[06:31:00.953] # [dpi] ⑤ WTInfoW cat=4 虚拟屏=(6000,3840) 显示器=2
  本仓库布局 lcSysOrg=(-1023,44800) lcSysExt=(2047,0)
  LNP报告布局 lcSysExt=(6000,3840)   dpiRatio=2931/1000
```

拿同一份字节按「W 版 = A 版 + 40（`lcName` 从 `char[40]` 变 `WCHAR[40]`）」回填，
**六个字段全部自洽** ⇒ 结论唯一：

| 用 A 偏移读 | 实际字段 | 值 | 合理性 |
| --- | --- | --- | --- |
| 132 / 136 | `lcInOrgZ` / `lcInExtX` | -1023 / 44800 | ✅ 笔 Z 原点、X 量程 |
| 144 / 148 | `lcInExtZ` / `lcOutOrgX` | 2047 / 0 | ✅ Z 量程、输出原点 |
| 160 / 164 | **`lcOutExtX` / `lcOutExtY`** | 6000 / 3840 | ⚠️ **只是恰好等于虚拟屏** —— 昨天据此误判成「LNP 的 +0xA0 是对的」 |

⇒ 真正的 `lcSysExt` 在 **W 版 = 184/188**、**A 版 = 144/148**。
0x0114 已按 A/W 分别取，并且**只拿 X 判**（多显示器上下排列时 `lcSysExtY` 本就可能
≠ 虚拟屏高度）。另：`dpiRatio=2931/1000` 是拿 `lcInExtZ=2047` 算的，无意义 —— 已修。

## 9.5 本场余留（不是 bug，但要记账）

- **`smoothed` 停在 649 不动**：packets 从 1777 涨到 17235，但 `smoothed` 冻结。
  原因 = `reason=2(非套索)` ⇒ 闸门 fail-closed ⇒ 一个包都没改写。**正确行为**。
- **整场 `真实包=0`（PS 取包 172 次全零包）**：本次会话前期 Wintab 通路无数据，
  HUD 是靠**系统光标**（`[raw] 源=★系统光标`）渲染的；06:32:01 起 `state=1 calib=OK`
  后才真正有包。⇒ 本场前半段不能用来评估平滑质量。
- **冷启动缺口仍未消除**（P2，本轮未改）：`'slct'` 只在工具**变化**时投递 ⇒
  用户若不切工具就永远停在 `state=1`，面板继续轮询 ⇒ **功能正常、只是没省到预算**。
  要填这个缺口得在 install 时同步查一次当前工具（新增 PICA 查询能力），
  风险大于收益，暂不动。

## 9.6 验收 0x0114 时重点看

1. 日志头 `ver=0x0114`（⚠️ 版本号**不要**用静态反汇编核验 —— 编译器序言是
   `55 48 83 EC 20` 且 `mov eax` 后会插 `xchg`，裸搜 `B8 xx 01 00 00 C3` 必漏）。
2. **切回套索工具后 HUD 必须恢复** —— 这是 9.3 那条 bug 的回归判据。
   期望：`[hud] 未显示` 行里 `gate=1(toolOk=1 …)` 且 `stroke=1`，随后出现 `[hud] 显示`。
3. `[hud] 未显示` 行里 `draw=` 应恒为 1（不再参与门控），`tm=` / `k=` 继续观察。
4. `[dpi]` 行应出现 `W版 lcSysExt(+184)=(…)`，看它是否等于虚拟屏 X。

---

# 10. 0x0115：`'slct'` 静默停投与「永久失效」（2026-10-17 07:00 会话，pid 13428）

> 样本：`%TEMP%\jwwh-13428.log`（引擎，922 行）+ `pi8li.log`（插件，265 行）
> 用户报告：不切工具时高配机已稳定；**频繁切工具再切回套索后永久失效，
> 开关平滑开关无法修复**。本章给出完整证据链、根因判定与 0x0115 的修复。

## 10.1 证据链（两本日志对齐，全部可复算）

| 时刻 | 插件侧（pi8li.log） | 引擎侧（jwwh-13428.log） |
| --- | --- | --- |
| 06:51:38~06:53:06 | state=1，闸门由**面板轮询**供给 | `toolOk=1`，`[hud] 显示` ×7，penDown 循环正常 |
| 06:53:13.068 | ★接管（首读 `pencilTool`）⇒ state=2 | — |
| 06:53:13~06:53:36 | `'slct'` 连投 **5 次**：pencil→gradient→wetBrush→smudge→marqueeEllip | — |
| **06:53:36.444 起** | **回调冻结在 5**（72 秒零投递） | **06:53:14.394 起 `toolOk=0 / reason=2(非套索)` 直到进程结束（95s）** |
| 06:53:36~06:54:44 | `toolModalStateChanged` 照常投递 **40 次**（n=52→92）；`modalStateChanged` 于 06:54:48 也投递 | 光标持续移动（[gap] 行），penDown 全程 0 |
| 06:54:10 / 06:54:23 | `shutdown ⇒ 平滑已关` ×2（用户开关平滑试图自救） | 诊断钩卸载/重挂各一轮 |
| 06:54:48 | doc 事件 + Unload | — |

**三条硬事实**：

1. **静默的只是 `'slct'` 这一路**：同期 `toolModalStateChanged`（n 52→92）与
   `modalStateChanged`（n=4）都正常投递 ⇒ 不是 PS 通知系统整体罢工，
   也不是我们的 notifier 被批量注销（`pstool_uninstall` 只在 Unload 调，
   日志里没有提前出现的注销行）。
2. **闸门被永久冻结**：`.8li` 在 06:53:36 最后一次写入 `gate=0`（marqueeEllipTool），
   此后 72 秒没有任何写入者 —— 面板已在 state=2 时停止轮询（0x0114 设计），
   `'slct'` 不再来 ⇒ **共享内存里的 I_TOOLGATE 永远是 0**。
3. **开关平滑救不回来**：`shutdown/enable` 只切 `g_enabled`，不碰 `ps_tool` 的
   state/lastGate/gate —— 与用户报告的「开关无法修复」逐字一致。

## 10.2 根因判定：架构缺陷，不是偶发

`'slct'` 是**边沿触发、无心跳**的通道：它只在「工具改变」时有真相。
而「当前工具是什么」是一个**持续量**。0x0113/0x0114 的接管设计
（`state==2 ⇒ 面板完全停轮询、闸门由 .8li 独占）把这个持续量
**单点押注**在一条事件通道的持续可靠上 —— 通道一旦静默，真相永久丢失，
且没有任何一侧能发现。

> 对比 LNP：它同样只注册 `'slct'`（无心跳、无兜底轮询，见 §2.1 表），
> 但 LNP 的平滑主链不依赖工具闸门（Wintab 包照常改写），闸门只影响
> 辅助线显隐 ⇒ 同类静默在 LNP 身上表现为「辅助线不更新」而非「平滑全死」，
> 用户不易感知。**本项目的闸门是平滑的总闸 ⇒ 单点故障被放大成功能死亡。**

**PS 为什么停投 `'slct'——未知**（无法从进程外归因）；但修复**不依赖**这个答案：
给「接管」加时效，静默即让位。这也是止损而非根治 —— 根治要等 §10.5 的 Pull 化。

## 10.3 0x0115 修复（已落地并构建核验）

**设计**：`pstool_owns()` 从「曾经读到过工具」（`state==2`）改为
「**最近 2 秒内真的收到过 `'slct'`**」：

```
pstool_owns() = (state==2) ∧ (notifyAge ≥ 0 ∧ notifyAge < PS_NOTIFY_FRESH_MS=2000)
```

- 超时 ⇒ `.8li` 立刻让位：面板的 `toolGate` 写入恢复生效
  （`write_params` 里 `if (!pstool_owns()) Wr(I_TOOLGATE, …)`），
  且 `syncSmoothToolWatch` 用**同一个结论**重启 1s 巡检。
- `'slct'` 恢复（用户再切一次工具）⇒ 立即重新接管，面板停轮询。
- 判据只有一份：原生侧算好，经 CFG 新槽 `I_GATEOWNED` + JSON `gateOwned`
  下发给面板；面板**绝不自己拿 notifyAge 比阈值**（两边各存一份迟早不同步）。

**改动清单**：

| 文件 | 改动 |
| --- | --- |
| `ps_tool.c` | `s_lastNotifyMs` 心跳（回调入口第一行，任何提前 return 之前）；`pstool_notify_age()`；diag 加 `回调龄=` + `★陈旧⇒让位面板`（按秒取整防刷屏）；`pstool_uninstall` 作废心跳 |
| `plugin_main.c` | `pstool_owns()` 加 2s 时效；`CFG_NLONGS 56→58`；新槽 `I_NOTIFYAGE`/`I_GATEOWNED`；JSON 加 `notifyAge`/`gateOwned`；卸载时 `s_lastNotifyMs=0` |
| `smooth_engine.c` | `CFG_NLONGS 58` + enum 补两个槽（槽位表同步铁律）；`cfg_slot_fit_check` 改断言到 `CFG_I_GATEOWNED+1`；`jwwh_version 0x0114→0x0115` |
| `app.tsx` | `syncSmoothToolWatch` / `applyToolGate` / 卸载路径统一走 `inProcGateOwned()`（= `gateOwned`，旧版 .8li 回落 `toolSrc===2`） |
| `LassoSmoothing.ts` | `PenSmoothStatus` 加 `notifyAge`/`gateOwned`（默认 **-1**，`=== undefined` 逐个回落，**禁用 `\|\| 0`** —— -1 是合法值） |

**为什么阈值取 2s**：它是「闸门陈旧的最大容忍窗口」。太小 ⇒ 稳态
（用户不切工具）频繁让位，省不到预算；太大 ⇒ 通道静默后 HUD 错得久。
2s 是折中：正常切工具后闸门立刻由事件更新；静默 ≤2s+1s 巡检即自愈。

**已知取舍（记账）**：2s 窗口意味着「用户长时间不切工具」时面板恢复 1s 巡检
（= 0x0112 以前的频率，3.3/s → 1/s 仍省 2/3）；预算完全省掉只发生在
切工具后的 2s 内。彻底消除要靠 §10.5。

## 10.4 构建与部署核验（2026-10-17 07:17）

- `bash build.sh`：zig cc `-Wall -Wextra` **零告警**；PiPL 往返一致（166B）。
- 导出表解析（PE32+，4 个导出）：`AutoPluginMain@0x13b0`、`jw8li_version@0x1920`
  （= `mov eax,0x200`，与 plugin_main.c:1015 一致）、`jwwh_unhook@0x5700`、
  `jwwh_version@0x56f0` = **`55 48 89 E5 B8 15 01 00 00 5D C3` ⇒ 0x0115** ✓。
  - ⚠️ 教训补充：§9.6 说「不要静态反汇编核验版本」——本次定位到原因：
    带 `55 48 83 EC 20` 序言的是 **`jwwh_unhook`**（其体内有
    `mov eax,1; xchg eax,[rip+…]`），版本函数实际是 `55 48 89 E5 …`。
    裸搜 `55 48 83 EC 20` 必定位到错函数。按导出表 RVA 取址再解。
- `npx tsc --noEmit`：`src/` **0 报错**（`node_modules/@types/node/ffi.d.ts`
  的既有语法噪音与本次无关）。
- `yarn build`：通过（3 个 warning 均为既有资源体积提示）。
- ⛔ **未部署**：PS 正在运行（锁文件），`build/JWautofillSmooth.8li`（278,528 B，
  含 0x0115）待用户完全退出 PS 后拷入
  `E:/Program Files\Adobe Photoshop 2026\Plug-ins\`。

## 10.5 验收 0x0115 时重点看 + 遗留

1. 日志头 `ver=0x0115`。
2. **回归判据**：频繁切工具 ≥6 次后切回套索，**HUD 必须在 ~3s 内恢复**
   （`[hud] 未显示` 行转 `gate=1(toolOk=1…)` → `[hud] 显示`）。
   pi8li.log 应出现 `回调龄=…★陈旧⇒让位面板` 行（证明看门狗触发过），
   随后面板巡检把闸门改回 1。
3. `gateOwned` 在 JSON / 面板诊断里应随切工具 1↔0 翻转。
4. 低配机（3400G）复测：看门狗让位后面板 1s 巡检的模态开销是否可接受。
5. **P2 冷启动缺口依旧**（§9.5）：`'slct'` 无心跳 ⇒ install 时查不到当前工具。
6. **P3（根治方向，本轮未做）**：把 `.8li` 的工具获取从**事件推进**改成
   **Pull 化**——看门狗超时后由 `.8li` 自己经 PICA 拉一次当前工具
   （需补 `sPSActionControl->Get` 偏移的逆向，LNP 对 viewTransform 就有
    Pull 路径可参照）。Pull 成功后连面板兜底都不需要，模态预算全省。
