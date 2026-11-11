# JWautofill 项目记忆（主索引）

> 只留「编号 + 一句话 + refs 指针」；**明细一律在 `refs/`**，里程碑史在 `HISTORY.md`。⛔ 违反必炸。
> 架构：平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。现役 **0x0228**（文本输入闸门，115；0x0227 是面板侧纯白清除，`.8li` 未动）。

## 索引（`refs/` 下）

`fill-and-stroke`（填充/描边/清除）｜`frontend-css`（CSS/面板/主题）｜`busy-gate`（闸门/模态）｜`uxp-api-layer`（UXP/API/性能）｜`pixel-algorithms`（像素）｜`toolchain-and-env`（构建/部署）｜`lasso-smoothing`（平滑/HUD/断流/闸门/吸管，O22–O62）｜`keyhook-8li`（键盘钩子）｜`brush-mixer-reservoir`（混合器）｜`poly-snap-0x0211-0x021F`（临时模式/冻结/吸附）｜`blend-hotkey-yield-0x0224`（混合模式让位）｜`ironrules-1-89`（旧铁律全文）

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`）；改 .c 跑 `build.sh`（须沙箱外）零告警 + 导出表 5 项；改面板 `yarn build`。全仓 ~168 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的行。

## 最新铁律（0x0211–0x0228，要改先看这一段）

90 ⛔⛔⛔ 「PS 临时模式」不派发任何可观测变更（`application.tool` 仍 `lassoTool`）⇒ 真相只在原生：独立槽 `I_POLYALT` 每 20ms **镜像电平**；⛔ 不与 `I_ALTTOOL` 合槽。
91 ⛔⛔⛔ 「按住」= 修饰键完全匹配 + 一次性起按准入 + 连两拍确认（≈40ms）；同键位不同修饰键故意共存。
92 ⛔⛔⛔ 热键前提只两条：插件在位（`g_khPlug`）+ 布防（`g_khArmed`）；⛔ `I_POLYALT` 不受布防约束。
93 ⛔⛔⛔ Alt 期间不平滑但可把点**钉住**；移开 >14 逻辑 px 或按住 >420ms 解冻补线；⛔ 只在 `g_strokeGate==1` 进场。
94 ⛔⛔⛔ 吸附通道演化：改包=看不见 ⇒ 改 `GetCursorPos` 仍看不见 ⇒ 改**鼠标消息**才生效。先定「PS 从哪读这个量」再写算法。
97 ⛔⛔⛔ 挂 `DispatchMessageW` 改 `MSG.pt`+`lParam`，只碰 MOUSEMOVE/LBUTTONDOWN/LBUTTONUP；⛔ 锚点只能有一个推进者。
98 ⛔⛔⛔ 「只吸附一次」= 按钮电平被三路共用 ⇒ prev **按 owner 各记一份**，被拒推进的 owner 连 prev 都不写。
99 ⛔⛔ 吸附参考线走 HUD 独立旁路 `poly_hint_live()`，⛔ 不并进 `cheapOk`。
100 ⛔⛔⛔ 会话只许被**真事件**收摊（`POLYALT` 连续归零 ≥250ms 或主开关关）；心跳过期与抖成一拍都只是抖动；工具闸门**值优先**。
101 ⛔⛔⛔ 解冻补线把折线起点搬到光标 ⇒ 吸附锚点必须跟着搬（取**解冻后下一包**的 raw）。
102 ⛔⛔⛔ 预览读消息、落点读包 ⇒ 两条通道都要改；搬锚必须同步 `g_polyHintAx/Ay`。
103 ⛔⛔⛔ 别猜 PS 读哪条通道：**光标/消息/包三条一起钉**；锁定基准=落笔那一刻的真实光标；接触是独立共享电平 `g_pgTouch`。
104 ⛔⛔⛔ 冻结钉的圆心先验真身：进场 `POLY_HOLD_ENTER_MAX_PX`(120)、生效 `POLY_HOLD_SANE_PX`(260) ∧ `POLY_HOLD_STALE_MS`(820)，只放弃不猜值。
105 ⛔⛔⛔ `px_x/px_y` 是**比例**不是坐标 ⇒ 跨域只许「差值 + 同一时刻一对真值基准」，屏幕→轴一律不做。
106 ⛔⛔⛔ 吸附必须有**独立总开关槽** `I_POLYSNAP`（0x0220，60→61 槽）：六个入口 `poly_hold_run`/`poly_snap_run`/`poly_pkt_click`/`poly_snap_gcp`/`poly_hint_live`/`poly_msg_apply` 全问 `poly_snap_enabled()`；⛔ 拿 `I_POLYALT` 当开关；⛔ 瞬时兜底（Alt 松开/`plug_revoke`/`services_stop`）不许清它，只有 `services_start` 清（面板建连后重放）。
107 ⛔⛔ 面板标签宽度**按字数选档**（`label-2..6` = 20/33/47/60/73px），否则 `.slider-track { flex:1 1 auto }` 让同组滑块长短不一（0x0220：漏 `label-2`，比锐度长 13px）。
108 ⛔⛔⛔ 多边形吸附**不依赖**平滑总开关（0x0221）：包路径触发 = `en ∨ (I_POLYSNAP ∧ 心跳新鲜)`，状态机与 `g_smoothed` 仍只认 `en`；「一笔之中」由 `smooth_packets` 的 poly 分支自备 `contact_update` 写 `g_strokeGate`；⛔ 平滑关时不冻结（why=5）、锚点取 raw 不取 `g_ox`（已停更）。
109 ⛔⛔⛔ Alt 按住期间 HUD **只许画参考线**（0x0222）：`wantVisible` 在 `I_POLYALT` 为真时只认 `polyHint`，**跳过 90ms 隐藏去抖**（正是它让窗口多撑 90ms 而绘制分支只判 `!polyHint` ⇒ 画成圆），且此时隐藏**不写** `s_hudHideAt`（否则松 Alt 起笔首笔圆白等 180ms）；⛔ 判据用物理 `I_POLYALT` 而非吸附开关。
110 ⛔⛔⛔ 吸附链**不许借用平滑的工具闸门供给**（0x0223）：GATETS 与闸门值的两条来源（`pollSmoothToolGate` 1s 巡检、`setSmoothToolGate` 1.8s 心跳）都绑在 `penOn` ⇒ 平滑一关全停 ⇒ 包路径整段死。⇒ ① 新增入站 `{"type":"toolGate","gate":0|1|2,"gateAge"?}`（`pstool_owns()` 时让位，⛔ 不能拿 penSmooth 顶替）；② 引擎 `poly_tool_ok()`=值优先，包/光标共用；③ `syncSmoothToolWatch` 的 `need` 加 `snapActive`。容差 10°→**5°**（`POLY_SNAP_TOL_DEG` 与 `POLY_SNAP_TAN` 必须同时改）。
111 ⛔⛔⛔ 混合模式热键「按工具让位」必须**三处同时改**（0x0224）：LL 钩子命中放行、**RegisterHotKey 注册集跳过 blendMode 条目**（注册即独占摘键，钩子放行没用）、轮询兜底与 `kh_hk_fire` 不许再广播；让位位=原生原子位（入站 `blendYield`，不落盘、不进共享槽）；面板唯一喂点 `noteToolForBlendYield`（null 不喂）、巡检归 `syncToolWatch`（`syncSmoothToolWatch` 必须让位）。⛔ 工具 ID 一律驼峰：历史记录艺术画笔=`artBrushTool`，不存在 `artHistoryBrushTool`。
112 ⛔⛔⛔ 救援链路的「宽判」不许借 HUD 显隐闸门（0x0225）：`g_canvasHitDbg` 原与 `canvasOk` 一起写在 `cheapOk` 分支、跳帧沿用旧值，而 `cheapOk` 含 `ropeMode`(仅拉绳)+`fgOk` ⇒ 标准/追笔下恒冻初值 0 ⇒ 停笔喂入被钉死、代投停 ⇒「描边不补齐」，最小化/切回恰好是它偶尔重算的一帧 ⇒ 同动作结果相反。⇒ 每帧无条件 `canvas_hit_ok(cur)` 现算（不看前台/模式），`canvasOk`/`wantVisible` 逐字不动。详见 `2026-11-09.md`。
113 ⛔⛔⛔ 裸数字键热键**必须走 RegisterHotKey 系统级独占**（0x0226）：PS 前台时 LL 钩子实际收不到键（pi8li.log `钩子 +0 / 轮询 +1`），而旧 `kh_combo_to_hotkey` 主动 `if(!m) return 0` 把**所有裸键**排除注册 ⇒ 全靠「不吞键」轮询触发 ⇒ Num1–9 原样落进 PS 改画笔不透明度（按 5=50%）。⛔「RegisterHotKey 不接受裸键」是错的：实测 `mods=0` / `MOD_NOREPEAT` 对 `VK_NUMPAD5`、主键盘 `5` 均 TRUE。⇒ `kh_hk_sync` 改用 `kh_combo_to_key` + `kh_is_digit_vk`（0x30–39 / 0x60–69）只圈**表内实际绑定的数字类裸键**；字母符号裸键（H/L/`/`）维持旧语义防文本框被摘键；`kh_hk_fire` 的 `kh_dual_mark` 压轮询影子，录制/失焦/不在位/让位撤注册门逐字不动。详见 `refs/keyhook-8li.md` N11、`2026-11-11.md`。

114 ⛔⛔⛔ 纯色填充 + 清除模式的公式输入**恒为纯白 F≡255**（0x0227 面板侧变更；`.8li` 仍 0x0226）：旧 `ClearHandler.getSolidFillGrayData` 拿 `app.foregroundColor` 经抖动算灰度，红色 F≈76 ⇒ `A'=179` 只降不透明度、与套索 Delete 不符。⇒ ① `buildSolidClearWhite` 与 `SingleChannelHandler.clearSingleChannel` 纯色分支都给全 255，**不读不写 PS 前景色、不跑颜色抖动**；② 清除强度只剩面板不透明度（`clearStrength`），想半透明自己调；③ 图案/渐变清除、非清除纯色填充、描边清除、`fillSingleChannel` 逐字不动；④ 快速蒙版纯色清除补「进入保存前景色 → finally 还原」（`getQuickMaskPixels` 会临时 set 前景色），图案/渐变不加这层。详见 `2026-11-11.md`。

115 ⛔⛔⛔ 「H/L 在另存为对话框被摘键」**不是** RegisterHotKey 干的（0x0228）：H/L 属「其它裸键」根本没注册，真凶是 **LL 钩子**——PS 主窗口按键进不了钩子链（`钩子 +0 / 轮询 +1`），原生对话框按键却能进 ⇒ `kh_dispatch` 命中即 `return 1`。⇒ 新增 `g_khTextGuard` 文本输入闸门（`#32770` / `DLGMODALFRAME` / 宿主被禁用 / 焦点编辑控件类 / 可见插入光标 + 400ms 黏滞），**四条键路一起熄火**：钩子整击放行（含退格删绑）、轮询不触发、`kh_hk_sync` 全撤注册（全局独占不看焦点，否则 Num1–7 在文件名框照样摘键）、按住键电平不算按住；同步 100ms→10ms。⛔ 探测只在 `kh_poll_step` 做，LL 回调只读一个 volatile LONG；⛔ 别手写 `WINVER`（写 0x0600 会把 `MOD_NOREPEAT` 藏掉）；⛔ 录制分支必须在闸门之前。版本 0x0227 被面板侧占用，`.8li` 顺延 0x0228。详见 `2026-11-11.md`、`refs/keyhook-8li.md` N12。

## 其余铁律（1–89）—— 全文见 `refs/ironrules-1-89.md`（编号不变，按场景查）

1–6 产物/构建（禁自动 commit、IPC round、.8li 版本、CFG_NLONGS 61、日志路径、卸载顺序）｜7–13 闸门/面板（`'slct'` 三态、isPsBusy、gateAge、HUD AND 门）｜14–16 HUD/画布（拉绳定长、悬链垂度、px 权威=屏幕）｜17–38 断流补流（三路输入、SYNTH_TIP_MAX_MS、btns 边沿、`armed` 判据）｜39–44 键盘钩子/卸载（双路热键、阳性证据重装、DETACH 日志先落）｜45–53 UXP/画笔预设（`_obj` 只取样本、`silent`、回读判据、装笔缓存 cto、换笔尖、黄条、工具指纹）｜54–64 混合器储层（重新采样装填、canvasClick、defineBrush 定直径）｜65–70 键盘钩子·在位闸（`g_khPlug`/`g_cliReady`、槽位归还、超时≠断开）｜71–73 工具闸门/光标（GATETS 新鲜、hostYield maxHoldMs、GP_HOLD_MS）｜74–80 HUD 门控/临时吸管（`I_ALTTOOL` 独立槽、闪现看显示时机、事后搬色）｜81–83 标准滤波/文案（真实位移算笔速、两级尖角基准、helpTexts 文案规则）｜84–86 HUD 坐标系/消失（圆心不绘在会漂的量、putXc 语义、三个消失源头）｜87–89 吸管键源（不进热键表、裸键 `/`、含 Alt 才搬色）

## 维护约定

超限先下沉 refs 再精简本文件（只留「编号 + 一句话 + refs 指针」）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ `PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，独立不许合并；Plug-ins 里的旧 .8li 直接覆盖不留备份（PS 锁文件，覆盖前必须完全退出 PS）。
