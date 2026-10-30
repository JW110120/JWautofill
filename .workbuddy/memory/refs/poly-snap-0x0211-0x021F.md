# PS 临时模式 → Alt 落笔冻结 → 多边形吸附（0x0211–0x021F）

> 从 `MEMORY.md` 铁律 90–105 下沉的**原文全档**（2026-10-29 按「维护约定」搬迁，内容一字未改）。
> `MEMORY.md` 里只留「编号 + 一句话 + 本文指针」。改代码前必须读本文件对应编号。
> 相关：`lasso-smoothing.md`（O51–O58 与本文重叠，当时是过程稿）、`keyhook-8li.md`（键源/热键通路）。

## PS 临时模式（0x0211）—— 明细 O51

90 ⛔⛔⛔ 「PS 临时模式」不派发任何可观测变更（`application.tool` 仍 `lassoTool`、无通知、无 `'slct'`）⇒ 真相只有原生有：`GetAsyncKeyState(VK_MENU) ∧ 前台是本进程` ⇒ 独立槽 `I_POLYALT`，每 20ms **镜像电平**（⛔ 不是边沿）。⛔ 不许与 `I_ALTTOOL` 合槽；HUD `gateOk` 单独再压一次。

## 按住键 vs 同键位热键（0x0212）—— 明细 O52

91 ⛔⛔⛔ 「按住」= 修饰键完全匹配 + 一次性起按准入 + 连两拍确认（≈40ms）：没列出的修饰键必须抬着；出现过一拍不匹配就作废，须等键真抬起再按。⛔ 同键位不同修饰键是故意允许的共存（只有完全相同才算冲突）。⛔ `pickerBusy` 期间丢弃 altHold 按下边沿。⛔ 「按一下」的键要进表并吞键。

## 热键生效前提（0x0213）—— 明细 O53

92 ⛔⛔⛔ 必备前提只两条：插件在位（`g_khPlug`）+ 布防（`g_khArmed`）。表内热键过 `kh_hk_sync` 与 `kh_poll_step`；钩子安装 = `bound ∧ plug ∧ armed`。⛔ 不进表的通路必须自己补布防门。⛔ `I_POLYALT` 故意不受布防约束。附加：`g_khSafeMode` 熔断期热键静默。

## Alt 落笔冻结（0x0214）—— 明细 O54

93 ⛔⛔⛔ Alt 期间不**平滑**但可能把点**钉住**（立刻停改写 ⇒ PS 拿真实光标接滞后的圆心，那段差被画成直线并落第一个锚点）。`poly_hold_run()` 每包写同一点；抬笔那包仍写圆心；移开 >14 逻辑 px 或按住 >420ms 解冻补线。⛔ 只在 `g_strokeGate==1` 进场；⛔ 一轮只冻一次；⛔ 解冻后 `g_wasEnabled=0` 重锚（例外：Alt 松开且仍在一笔之中）。

## 多边形角度吸附（0x0215–18）—— 明细 O55–O58

94 ⛔⛔⛔ 多边形吸附的通道演化（0x0215→18，明细 refs O55–O58）：改 Wintab 包=看不见 ⇒ 改 `GetCursorPos` 返回值=仍看不见（样本证明方向已掰正）⇒ 改**鼠标消息**才生效。⛔ 教训：先定「PS 从哪读这个量」再写算法；「代码跑了」≠「用户看得见」。⛔ 吸附做在 `det_GetCursorPos`、**`tool_edit_allowed()` 之前**（POLYALT 硬否决在那里面）。`poly_proj()` 三路共用，⛔ 比值判定不调 `atan2`（水平 `|dy|/|dx|`、垂直 `|dx|/|dy|`、45° `||dy|−|dx||/(|dx|+|dy|)`，阈值 tan10°）。⛔ 吸附**接替**平滑（进/出置 `s_gpOn=0`），否则落差被追成反向斜线。附：临时多边形套索**第一次点击前没有折线预览**，只按住 Alt 移动无可吸附对象。

97 ⛔⛔⛔ 0x0218：`gcp`/包都改了仍看不见 ⇒ PS 折线读**鼠标消息**。挂 `DispatchMessageW` 导入表槽，进门之前改 `MSG.pt` + 由 pt 经 `ScreenToClient` 重算的 `lParam`，只碰 MOUSEMOVE/LBUTTONDOWN/LBUTTONUP（点击落点一起吸）；同批挂 `GetPhysicalCursorPos`（owner=2）。⛔ 锚点只能有一个推进者（`poly_owner_may_advance`）。判据：`[msg] … N 槽`、退出行「消息层 见/改」。

98 ⛔⛔⛔ 0x0219「只吸附一次」= 按钮电平被三路共用（且 `WM_MOUSEMOVE` 的 btn 恒 0）⇒ prev **按 owner 各记一份**、**被拒绝推进的 owner 连 prev 都不写**；包路径在消息路径活着时整体让位。判据：退出行「锚点推进 N 次」应 ≈ 点击数，吸附多而推进 0~1 = 边沿被吃。

99 ⛔⛔ 吸附参考线不并进 `cheapOk`（那串要「一笔之中 · 拉绳模式 · 包流」，逐点点击时笔常悬空）⇒ HUD 独立旁路 `poly_hint_live()`（主开关 ∧ POLYALT ∧ ≤150ms）且不受重现去抖；`polyHint` 时圆/绳/笔尖点都不画。

100 ⛔⛔⛔ 吸附「会话」只许被**真事件**收摊：`POLYALT` **连续归零 ≥250ms** 或主开关关。⛔ `tool_gate_ok()` 心跳过期（3s fail-closed）与 `POLYALT` 抖成 0 一拍（原生 20ms 镜像电平）都**只是瞬时抖动**，拿来 `exit()` 会销毁锚点，而重建只认「一笔之中」或「点击」⇒ 笔一悬空就**永久失效**（症状：头几秒能吸、转一圈回来不吸）。⇒ 工具闸门**值优先**（`TOOLGATE==1` 即认，过期只否本拍改写），归零抖动期间返回 0 正常透传（返回 1 会把套索钉住 250ms，更糟）。退出行必带「收摊原因」。附：参考线改画「锚点 → 吸附点」**整段**（用户要起点=折线起点），窗口中心取线段中点、边长按段长量化到 128 倍数、`hud_resize` 必须支持**缩小**（只增不减会停在 1024 白烧带宽）；段长超 `HUD_SIZE_MAX` 时中心退回吸附点——宁可丢起点不能丢终点。

101 ⛔⛔⛔ 冻结解冻（补线）把**折线起点**搬到光标，吸附锚点必须跟着搬：PS 从圆心补一条直线到光标，那条线算套索笔迹收尾，折线从光标处重新起。错误做法是建会话时一律 `s_pgAx = s_gpX`（= 圆心）——只对 why=1「立刻抬笔」正确。⇒ `poly_hold_run` 判出 why=2/3 时 `poly_anchor_push()` **解冻后下一包**的 raw（⛔ 不是判定解冻那一包，那包仍写圆心；批末则 `s_polyNeedAnchor` 留到下一批顶部取），轴 → 屏幕像素 `*px_x()`；`poly_snap_gcp` 在「会话已建立」支与「刚建立」支都要 `poly_anchor_take()`（会话在冻结期间就已建立），⛔「还没开始画」不许消费标志、「悬空第一次点击」要作废标志；`exit` 必须清标志与 `s_polyNeedAnchor`。判据：退出行「搬锚 N 次」> 0。

102 ⛔⛔⛔ 落笔瞬间**预览与落点是两条通道**：橡皮筋读鼠标消息（97 已证），而 PS 在笔落那一刻用 **Wintab 包**确认节点 ⇒ 只改预览会得到「预览在 A、节点落在 B」，PS 再从 A 补一根短直线到 B。⇒ 两处互补：`poly_pkt_click()` 把**接触第一包**（buttons 0→1，`s_pkBtnPrev`）坐标改成当前吸附点（屏幕 `/px` 回轴；⛔ 只改这一包，连续改会污染平滑重锚），以及接触期间 `s_pgClickHold` **锁定输出**在吸附点（移动 >20 逻辑 px 或接触结束才解除，0x0214 补线场景要能跟随）。⛔ 两者都以 `g_polyHintMs` 新鲜为前提。⛔ 搬锚时必须同步 `g_polyHintAx/Ay`，否则「搬了锚但这一拍没吸附」时参考线仍显示旧起点（1B 被判无效的原因之一）。判据：退出行「接触包改写 N 次」——N>0 但节点仍在真实位 ⇒ 包不是落点通道。

103 ⛔⛔⛔ **别猜 PS 读哪条通道：要钉就三条一起钉**（0x021D 实证 102 的四条错法）。① 解锁定长的基准必须是**落笔那一刻的真实光标**（`g_pgHoldRx/Ry`、`s_pkPinRx/Ry`）—— 拿锁定点当基准，因锁定点天生带吸附偏移 ⇒ 落笔即超距、锁当场自解（102 完全失效的直接原因）。② 接触是**独立共享电平** `g_pgTouch`（消息层按/抬 + 包层按包 + 光标层「物理键 ∨ 包新鲜」），⛔ 不许用「本条消息 `btn`」判接触（消息路径 btn 只在 LBUTTONDOWN 为 1，下一条 MOUSEMOVE 就是 0）。③ 事件类改写覆盖**整个接触区间**并含抬笔包（PS 取包线程有滞后，读的是更晚那包）；`poly_snap_run` 在 `g_pgHoldOn` 时整批让位。④ 冻结（93）也要三通道一致：`g_polyHoldX/Y`（屏幕像素）在冻结进场发布，`poly_snap_gcp` 的冻结分支放在「会话建立之后、吸附计算之前」（前者保锚点=圆心，后者跳过投影）——只钉包会回归「圆心→A 补线」。⑤ `POLY_TOUCH_OFF_GRACE_MS=100` 宽限：包层先清 0、`WM_LBUTTONUP` 后到，不宽限就把未钉住的点交给了抬笔那条消息。判据：退出行「接触锁定 N 次 / 解锁 N 次｜冻结打回 N 次」。

104 ⛔⛔⛔ 冻结钉的「圆心」必须**先验真身**（0x021E）。冻结点取自 `g_ox/g_oy`＝平滑**上一批**输出，而本机包流**高频断供**（`[dead] ★包流断供 … 已冻结 2625ms`；`[frz] 无包但仍在轮询 movedTot` 一路涨）——断供期间没有包 ⇒ `g_ox/g_oy` 一动不动，PS 却靠补流跟着光标走 ⇒ 按 Alt 钉住的是**很久以前那个输出点**，症状＝「圆心向正上方远处拉一条线，按住不抬再从远处补回光标」。⇒ 两道**只放弃不猜值**的闸：① 进场验 `|g_ox−批首raw|` 的屏幕距离 > `POLY_HOLD_ENTER_MAX_PX`(120 逻辑 px) ⇒ 本轮不冻结（`s_polyUsed=1` 透传，交主循环 `RST_ANCHOR` 把锚点搬到真实笔尖）；② 生效验（`poly_snap_gcp` 冻结分支）钉住点离真实光标 > `POLY_HOLD_SANE_PX`(260) 或超 `POLY_HOLD_STALE_MS`(820) ⇒ 停钉（同时兜住「没包就没人调 `poly_hold_finish` ⇒ 光标被永久钉死」）；③ `poly_hold_finish` 一并清 `g_polyHoldX/Y`，不留陈旧值。判据：退出行「冻结打回 N 次 / 拒绝 N 次」——拒绝数大即圆心陈旧；拒绝为 0 而现象照旧 ⇒ 另有源头。⚠️ `|g_ox−raw|` 只含平滑滞后（换算常量偏移在差值里抵消），所以这道闸能区分「陈旧」与「换算错」。

105 ⛔⛔⛔ **`px_x/px_y` 是「比例」，不是「坐标」**（0x021F 实证：`pxY=-0.0625`）。轴→屏幕还差**原点偏移**，直接 `轴 × px` 会让点落到屏幕外（日志：锚点 (1406,**-807**)、包锚点 (22496,**INT_MIN**)，症状＝选区往远端飞 + 参考线从屏外拉进来）。⇒ 跨域换算只许**差值 + 同一时刻的一对真值基准**：`屏幕 = 光标(se_real_GetCursorPos) + (轴 − 同包raw) × px`；屏幕→轴**一律不做**（留在轴域用 `poly_proj(cX,cY)` 算）。落地：`poly_anchor_push` 直接取真实光标；冻结钉住点用「光标 + (圆心轴 − 进场raw轴) × px」；`poly_pkt_click` 改**轴域**（接触边沿 `poly_proj` 出轴吸附点 `s_pkPinAx/Ay`，每包写同一个轴点，`pk_put` 只收轴坐标）。附：`poly_snap_run` 在消息层活着时只**不改包**（`writePkt=0`）但**仍推进锚点**；`g_pkPinOn` 让位时**不许清 `s_snapOn/锚点`**。HUD 交替闪＝`fits` 每帧翻转（中心在「线段中点」与「吸附点」二选一）⇒ 96/8px 滞回 + `POLY_HINT_KEEP_MS=350` + `POLY_HINT_MAX_SPAN=4000`。

---

## 0x0220：多边形吸附总开关（铁律 106）

> 用户原话：「增加一个自绘 switch，标签是多边形吸附，当开启后，套索按 alt 临时切为多边形套索的
> 8 向吸附功能才能生效」。此前 0x0211–0x021F 的整条吸附链路**没有开关** —— .8li 一在，按 Alt 就改。

**槽位**：`I_POLYSNAP`（plugin_main.c 与 smooth_engine.c 的 `CFG_NLONGS` **60 → 61**，两边同时改）。
入站消息 `{"type":"polySnap","on":0|1}`（`json_num` 判非零，⛔ 不用 `json_bool`，铁律 59）。

**为什么不能复用 `I_POLYALT`**：那位是「Alt 物理按着」的**事实镜像**，keyhook 每 20ms 覆写一次
⇒ 拿它当开关会在松开 Alt 的一瞬间被镜像抹掉；两者写者/语义都不同（事实 vs 意图）。
`I_POLYALT` 的硬否决**保留**：不论开关状态，Alt 期间平滑一律停（PS 那时在画直线段）。

**五个入口统一问 `poly_snap_enabled()`**（少问一处＝「关了还在改坐标」，界面上完全看不出来）：
| 函数 | 关掉时的行为 |
|---|---|
| `poly_hold_run` | 先 `poly_hold_finish(4)` 收尾再 return -1（否则 `s_polyHold` 停在 1、钉住点留在槽里） |
| `poly_snap_run` | 清 `s_snapOn/s_snapBtn` 后 return -1（包路径一个字节不改） |
| `poly_pkt_click` | 清 `s_pkPin`/`g_pkPinOn` 后 return 0 |
| `poly_snap_gcp` | `poly_snap_gcp_exit(2)` 后 return 0（光标/消息两条通道都从这里过） |
| `poly_hint_live` | return 0（参考线不画） |

**清零策略**：瞬时兜底（Alt 松开 / `plug_revoke` / `services_stop`）**不清** —— 它是用户**设置**，
清了等于抖一下就偷偷关用户的开关；只有 `services_start` 清（每个服务会话都要面板重新声明），
面板建连后 `resendLassoSmoothing` 重放 `polySnap`。

**契约**：面板 `LassoSmoothing.ts` 的 `polySnapOn`（默认 true）+ `setPolySnapEnabled()`；
app 侧 `state.polySnapEnabled` 持久化在 `panel-state.json` 的 `appPanel`，
启动合并状态后**主动下发一次**（与 `pushLassoSmoothParams` 同族的启动期失配坑）。

---

## 0x0221：多边形吸附与选区平滑**解耦**（铁律 108）

> 用户原话：「多边形吸附现在是必须要开启选区平滑才生效，这与我设想不符。
> 它们应该分开的，可以同时生效，也能各自独立生效（所以我才没把多边形吸附放进选区平滑里）。」

### 根因链（三环，缺一不成立）

| 环 | 事实 | 后果 |
|---|---|---|
| ① | `det_WTPacketsGet` 里 `if (en) { smooth_packets(...) }`，`en = CFG_I_ENABLED ∧ 心跳新鲜` | 平滑一关，**整条吸附链一次都跑不到**（它全长在 `smooth_packets` 内部） |
| ② | `smooth_packets` 的 `!useGate` 分支每批 `g_strokeGate = -1`（`tool_edit_allowed()` 在 ENABLED=0 时恒 0） | 就算跑到了，冻结的进场判据 `g_strokeGate == 1` 永远不成立 |
| ③ | 五处入口各写了 `!g_cfg[CFG_I_ENABLED]` | 包吸附 / 接触钉住 / 光标吸附 / 参考线 / 消息层 全部早退 |

### 改法

| 位置 | 改动 |
|---|---|
| `det_WTPacketsGet` | 触发条件 `en ∨ polyOn`，其中 `polyOn = I_POLYSNAP ∧ 心跳 ≤3s`（面板崩了槽位会停在 1）。⛔ `g_state` 与 `g_smoothed` **仍只认 en**，否则面板「生效中 / 已平滑包数」被纯吸附污染 |
| `smooth_packets` | 新增「poly 自备证据」块（在 `poly_hold_run` **之前**）：`!ENABLED ∧ POLYSNAP` ⇒ `contact_update()` + 写回同一个 `g_strokeGate`。⛔ 不碰 `g_penDown` |
| `poly_snap_run` | 删 ENABLED；锚点判据改 `g_strokeGate == 1 && g_cfg[CFG_I_ENABLED]` —— 平滑关时 `g_ox` 已停更，是**陈旧圆心**，必须用 raw |
| `poly_pkt_click` / `poly_snap_gcp` / `poly_hint_live` | 删 ENABLED，其余把关不动 |
| `poly_msg_apply` | 条件改 `I_POLYALT ∧ poly_snap_enabled()`。⛔ `g_msgLastMs` **必须照常写**，否则包路径以为消息层不在 ⇒ `writePkt=1` ⇒ 两条通道各写一份坐标（0x021D 的老毛病） |
| `poly_hold_run` | 新增早退：`!CFG_I_ENABLED` ⇒ 收尾（why=**5**，新码）后 return -1 |

### 为什么「平滑关着就不该冻结」

冻结（0x0214）是为平滑服务的：原始成因是「平滑让输出点滞后于笔尖，按 Alt 那一刻 PS 从圆心拉线」。
平滑关着时输出点 = 笔尖本身，没有滞后 ⇒ 冻结点 = 本批真实笔尖 ⇒ 钉住 ≡ 零改写。
更要紧的是它会**算错**：`g_ox/g_oy` 此刻不再更新，拿它当圆心必然被 `POLY_HOLD_ENTER_MAX_PX`
拒掉，白刷 `g_polyHoldRej`，排障时看到一堆「冻结被拒」而真因在别处。

### 前端（同版）

开关行从「容器外、紧贴选区平滑」移进 `.slider-container`（混合模式盒）**羽化之下**：
行间距靠 `.row-between` 自带的 10px（块级容器内相邻外边距折叠），与「不透明度↔羽化」一致，
**不需要任何自定义 CSS**。`.slider-container` 有 `border` ⇒ 末行 `margin-bottom` 不穿透。

---

## 0x0222：Alt 期间 HUD 只许是参考线（铁律 109）

> 用户原话：「开启吸附，不论平滑是否打开，我按 alt 将套索临时切为多边形套索，在我落笔前，
> 我移动光标从一个吸附方向前往另一个吸附方向的过程中，发现平滑的 hud 会短暂出现，随后消失。」

### 根因（两根因叠加，缺一不成立，全在 HUD 线程显隐层）

| # | 事实 | 后果 |
|---|---|---|
| ① | `wantVisible = (cheapOk && canvasOk) \|\| polyHint` | Alt 期间 `gateOk` 已被强制归零 ⇒ 主门槛必假 —— 但它**管不住已经可见的窗口** |
| ② | 参考线靠 `g_polyHintMs` 衰减（`POLY_HINT_KEEP_MS`=**350ms**），一超出 `polyHint`=0；而 90ms **隐藏去抖**会把窗口「维持显示」 | 绘制分支判据只有 `!polyHint` ⇒ 立刻转去画**圆/绳**，且 `putValid=0` ⇒ 圆心取当下光标 ⇒ 光标处闪出一个圆，90ms 后隐藏 |

⇒ 一句话：「隐藏去抖是为**圆**的帧间抖动设计的，对『参考线掉线』毫无意义」——
   而它维持的这段时间里，绘制路径已经换成圆了。

### 改法（三行，全在 HUD 线程）

```c
int polyAltHold = (g_cfg && g_cfg[CFG_I_POLYALT]) ? 1 : 0;
int wantVisible = polyAltHold ? polyHint : (((cheapOk && canvasOk) || polyHint) ? 1 : 0);
...
} else if (s_hudVisible && !polyAltHold) {   /* 隐藏去抖 */
...
if (!polyAltHold) s_hudHideAt = now;        /* 隐藏边沿 */
```

- 第三条的用途：`s_hudHideAt` 只服务「刚隐藏过 ⇒ 重现要等 180ms」。Alt 期间的隐藏是
  **参考线掉线的正常节拍**（每次脱离吸附都会发生），记进去会让「松开 Alt 立刻起笔」的
  第一笔圆白等 180ms（手感变钝），而它压根不是抖动。
- ⛔ 判据用**物理 Alt** 而不是吸附开关：吸附关掉时 Alt 期间同样不该出圆（0x0211 的硬否决），
  这条只是把「不画圆」落到显隐层 ⇒ 不会出现「关了吸附反而闪得更多」。
- ⛔ 别改成「保留窗口但什么都不画」：窗口虽透明，`s_hudVisible`/去抖状态仍按「显示中」累积，
  下一轮真实起笔的首次显示会被误判成「刚隐藏过」。
- ⛔ 别为了修这个去掉 90ms 去抖本身：它治的是圆在门槛边界上的 1~2 帧抖动，Alt 之外仍有效。

### 排障判读

`# [hud] 显示:` 行末的 `hint=%d` 是唯一证据：
- `hint=1 poly=1` ⇒ 正常（参考线）；
- `hint=0 poly=1` ⇒ **不该出现**（本版起不可能；出现即回归）。

---

## 0x0223：吸附链自备工具闸门 + 容差 10°→5°（铁律 110）

> 用户原话：「① 仅开启吸附容易长时间失效，只有吸附和平滑同时开启后才比较稳定触发吸附。
> ② 目前吸附范围比较大，我希望只有 ±5° 的范围才吸附。」

### ① 为什么「只开吸附就不吸」

**吸附链仍借了平滑的三样东西，前两样就是这次的主犯：**

| 借的东西 | 平滑关着时的实际状态 | 后果 |
|---|---|---|
| `poly_snap_run` 用 `tool_gate_ok()`（**要求 GATETS 新鲜**） | 面板两条闸门来源都绑 `penOn`：`syncSmoothToolWatch` 的 1s 巡检只在平滑开着时建表；`setSmoothToolGate` 开头 `if (!penOn) return` | 闸门值**冻结**在最后一次读数（常是 0 或 2=未知），包路径**整段死** |
| 包路径一死 ⇒ `s_snapOn` 建不起来 | `poly_pkt_click` 的进门判据是 `s_pgOn && s_snapOn` | **接触钉住**一起死 ⇒ 预览吸了、落点没吸（用户说「不吸了」） |
| 面板巡检 | 平滑关闭 ⇒ 0 次工具读 | 闸门值再也没有纠正机会 ⇒ **长时间**不恢复 |

`poly_snap_gcp` 早就用「值优先」，所以在闸门值为 1 时它还能跑 —— 正是「有时能吸、
大部分时间不吸」的断续来源。

### 改法（三处，跨端）

1. **原生新消息** `{"type":"toolGate","gate":0|1|2,"gateAge"?}`：
   只写 `I_TOOLGATE` + `I_GATETS`，不碰 `I_ENABLED`；`pstool_owns()` 时整段让位
   （与 `write_params()` 同规则）。
   ⛔ **不能拿 `penSmooth` 顶替**：那条消息的 `on` 就是平滑总开关，
   平滑关着时发心跳会把 `I_ENABLED` 反复写 0（`commit()` 还会发 cmd=2 卸钩）。
2. **引擎** `poly_tool_ok()`：`I_TOOLGATE==1` 即放行，否则退回 `tool_gate_ok()`
   （`GATETS==0` 时它放行，保住「.8li 刚装、面板没连」的场景）。包/光标两条路共用。
   ⛔ 依据铁律 71：心跳过期只说明面板没刷新，**不是换工具的证据**。
3. **面板** `syncSmoothToolWatch` 的 `need` 加 `snapActive`
   （`connected && state.polySnapEnabled`）⇒ 吸附开着就跑 1s 巡检（与平滑开着时同一条，
   不新增第二条定时器）；`togglePolySnap()` 里立刻调一次，不等状态回报。

### ② 容差 5°

```c
#define POLY_SNAP_TOL_DEG  5.0
#define POLY_SNAP_TAN      0.087489   /* tan(5°) */
```

⛔ 两个常量**必须同时改**：判据用的是 `POLY_SNAP_TAN`，`POLY_SNAP_TOL_DEG` 只进日志 ——
只改前者会让日志写 10° 而实际吸 5°，排障被误导。
`poly_proj` 的三个比值（水平 `|dy|/|dx|`、垂直 `|dx|/|dy|`、45° `||dy|−|dx||/(|dx|+|dy|)`）
都是 tan 形式，所以只换阈值即可，算法零改动。面板文案 `polySnapRow` 同步改成 5 度。
