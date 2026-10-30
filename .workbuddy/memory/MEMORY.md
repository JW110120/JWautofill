# JWautofill 项目记忆（主索引）

> 只留「编号 + 一句话 + refs 指针」；**明细一律在 `refs/`**，里程碑史在 `HISTORY.md`。⛔ 违反必炸。
> 架构：平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。现役 **0x0224**（混合模式热键按工具让位，111）。

## 索引（`refs/` 下）

`fill-and-stroke`（填充/描边/清除）｜`frontend-css`（CSS/面板/主题）｜`busy-gate`（闸门/模态）｜`uxp-api-layer`（UXP/API/性能）｜`pixel-algorithms`（像素）｜`toolchain-and-env`（构建/部署）｜`lasso-smoothing`（平滑/HUD/断流/闸门/吸管，O22–O62）｜`keyhook-8li`（键盘钩子）｜`brush-mixer-reservoir`（混合器）｜`poly-snap-0x0211-0x021F`（临时模式/冻结/吸附）｜`blend-hotkey-yield-0x0224`（混合模式让位）｜`ironrules-1-89`（旧铁律全文）

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`）；改 .c 跑 `build.sh`（须沙箱外）零告警 + 导出表 5 项；改面板 `yarn build`。全仓 ~168 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的行。

## 最新铁律（0x0211–0x0224，要改先看这一段）

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

## 其余铁律（1–89）—— 全文见 `refs/ironrules-1-89.md`（编号不变，按场景查）

1–6 产物/构建（禁自动 commit、IPC round、.8li 版本、CFG_NLONGS 61、日志路径、卸载顺序）｜7–13 闸门/面板（`'slct'` 三态、isPsBusy、gateAge、HUD AND 门）｜14–16 HUD/画布（拉绳定长、悬链垂度、px 权威=屏幕）｜17–38 断流补流（三路输入、SYNTH_TIP_MAX_MS、btns 边沿、`armed` 判据）｜39–44 键盘钩子/卸载（双路热键、阳性证据重装、DETACH 日志先落）｜45–53 UXP/画笔预设（`_obj` 只取样本、`silent`、回读判据、装笔缓存 cto、换笔尖、黄条、工具指纹）｜54–64 混合器储层（重新采样装填、canvasClick、defineBrush 定直径）｜65–70 键盘钩子·在位闸（`g_khPlug`/`g_cliReady`、槽位归还、超时≠断开）｜71–73 工具闸门/光标（GATETS 新鲜、hostYield maxHoldMs、GP_HOLD_MS）｜74–80 HUD 门控/临时吸管（`I_ALTTOOL` 独立槽、闪现看显示时机、事后搬色）｜81–83 标准滤波/文案（真实位移算笔速、两级尖角基准、helpTexts 文案规则）｜84–86 HUD 坐标系/消失（圆心不绘在会漂的量、putXc 语义、三个消失源头）｜87–89 吸管键源（不进热键表、裸键 `/`、含 Alt 才搬色）

## 维护约定

超限先下沉 refs 再精简本文件（只留「编号 + 一句话 + refs 指针」）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ `PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，独立不许合并；Plug-ins 里的旧 .8li 直接覆盖不留备份（PS 锁文件，覆盖前必须完全退出 PS）。
