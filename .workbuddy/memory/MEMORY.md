# JWautofill 项目记忆（主索引）

> 只留「编号 + 一句话 + refs 指针」；明细在 `refs/`，里程碑在 `HISTORY.md`，逐条实证在 `2026-11-*.md`。
> 架构：平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。PS 现加载 **0x0232**（已部署到 `Adobe Photoshop 2026\Plug-ins\`，382464 B / 11:16）；面板侧纯白清除 = 面板 0x0227；0x0228 文本闸门、0x022B 宽判收口、0x022C 日志编码、0x022D 停笔补齐（包路径）、0x022E 光标路径按模式推进、0x022F 面板侧删掉无条件切套索、0x0230 吞笔真根因＝僵持 tip=1、0x0231 吸附两条边缘条件＝Alt 期间「笔抬没抬起」、0x0232 抬笔点逐拍记录 + 按住拖动＝回套索、**0x0233 切回吞第一笔＝前台切回 tip 静默 + 停靠面板误显 HUD＝焦点门认命中窗口归属（已构建 383488 B，⚠️ 待部署）**。

## 索引（`refs/` 下）

`fill-and-stroke`（填充/描边/清除）｜`frontend-css`（CSS/面板/主题）｜`busy-gate`（闸门/模态）｜`uxp-api-layer`（UXP/API/性能）｜`pixel-algorithms`（像素）｜`toolchain-and-env`（构建/部署）｜`lasso-smoothing`（平滑/HUD/断流/闸门/吸管，O22–O62）｜`keyhook-8li`（键盘钩子）｜`brush-mixer-reservoir`（混合器）｜`poly-snap-0x0211-0x021F`（临时模式/冻结/吸附）｜`blend-hotkey-yield-0x0224`（混合模式让位）｜`ironrules-1-89`（旧铁律全文）

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`）；改 .c 跑 `build.sh`（须沙箱外）零告警 + 导出表 5 项；改面板 `yarn build`。全仓 ~168 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的行。

## 铁律 90–127（要改先看这一段；实证细节见 `2026-11-11.md` / `2026-11-12.md`）

90 ⛔⛔⛔ PS「临时模式」不派发任何可观测变更 ⇒ 真相只在原生：独立槽 `I_POLYALT` 每 20ms 镜像电平；⛔ 不与 `I_ALTTOOL` 合槽。
91 ⛔⛔⛔ 「按住」= 修饰键完全匹配 + 一次性起按准入 + 连两拍确认（≈40ms）；同键位不同修饰键故意共存。
92 ⛔⛔⛔ 热键前提只有两条：插件在位（`g_khPlug`）+ 布防（`g_khArmed`）；⛔ `I_POLYALT` 不受布防约束。
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
106 ⛔⛔⛔ 吸附必须有**独立总开关槽** `I_POLYSNAP`（0x0220，61 槽）：六个入口全问 `poly_snap_enabled()`；⛔ 拿 `I_POLYALT` 当开关；⛔ 瞬时兜底不许清它，只有 `services_start` 清（面板建连后重放）。
107 ⛔⛔ 面板标签宽度**按字数选档**（`label-2..6` = 20/33/47/60/73px），否则 `.slider-track { flex:1 1 auto }` 让同组滑块长短不一。
108 ⛔⛔⛔ 多边形吸附**不依赖**平滑总开关（0x0221）：包路径触发 = `en ∨ (I_POLYSNAP ∧ 心跳新鲜)`；状态机与 `g_smoothed` 仍只认 `en`；⛔ 平滑关时不冻结（why=5）、锚点取 raw 不取 `g_ox`。
109 ⛔⛔⛔ Alt 按住期间 HUD **只许画参考线**（0x0222）：`wantVisible` 只认 `polyHint`，**跳过 90ms 隐藏去抖**，且此时隐藏**不写** `s_hudHideAt`；⛔ 判据用物理 `I_POLYALT`。
110 ⛔⛔⛔ 吸附链**不许借用平滑的工具闸门供给**（0x0223）：入站 `{"type":"toolGate"}`（`pstool_owns()` 让位）、引擎 `poly_tool_ok()` 值优先、`syncSmoothToolWatch` 的 `need` 加 `snapActive`。容差 10°→**5°**（`POLY_SNAP_TOL_DEG` 与 `POLY_SNAP_TAN` 必须同时改）。
111 ⛔⛔⛔ 混合模式热键「按工具让位」必须**三处同时改**（0x0224）：LL 钩子放行、**RegisterHotKey 注册集跳过该条目**、轮询兜底与 `kh_hk_fire` 不许广播；让位位=原生原子位（入站 `blendYield`）。⛔ 工具 ID 驼峰：`artBrushTool`，无 `artHistoryBrushTool`。
112 ⛔⛔⛔ 救援链路的「宽判」不许借 HUD 显隐闸门（0x0225）：`g_canvasHitDbg` 改为每帧无条件 `canvas_hit_ok(cur)` 现算，`canvasOk`/`wantVisible` 逐字不动。
113 ⛔⛔⛔ 裸数字键热键**必须走 RegisterHotKey 系统级独占**（0x0226）：PS 前台时 LL 钩子收不到键。`kh_hk_sync` 用 `kh_combo_to_key` + `kh_is_digit_vk`（0x30–39 / 0x60–69）只圈表内绑定的数字裸键；字母符号裸键维持旧语义防文本框被摘键。
114 ⛔⛔⛔ 纯色填充 + 清除模式的公式输入**恒为纯白 F≡255**（面板 0x0227）：⛔ 不读 PS 前景色、不跑抖动；清除强度只剩面板不透明度。图案/渐变清除、非清除填充、描边清除逐字不动。
115 ⛔⛔⛔ 「H/L 在另存为对话框被摘键」真凶是 **LL 钩子**（0x0228）：新增 `g_khTextGuard`（`#32770`/`DLGMODALFRAME`/宿主禁用/焦点编辑控件/可见插入光标 + 400ms 黏滞），**四条键路一起熄火**；⛔ 探测只在 `kh_poll_step`；⛔ 别手写 `WINVER`；⛔ 录制分支必须在闸门之前。
116 ⛔⛔⛔ 宽判不许把「浮层盖在画布」当「笔离开画布」（0x022A）；⛔ 别再查工具闸门/面板供给/标定；「冷启动 20.6s 空窗」不是故障。**前台进程归属条件已被 117 推翻。**
117 ⛔⛔⛔ **功能判据不许依赖窗口 Z 序 / 前台进程**（0x022B）：`canvas_hit_ok()` **只认主框矩形** `PtInRect(s_frameRect,cur)`（未解析 fail-open 1）；删掉 `WindowFromPoint`/`GetForegroundWindow`/`GetWindowThreadProcessId`。HUD 焦点门/`fgOk`/`wantVisible`/救援链路判据逐字不动。日志 `ver=` 是引擎版本不是 .8li 版本。
118 ⛔⛔⛔ **日志编码与换行是两件事**（0x022C）：`jwwh-*.log` 为 UTF-8 无 BOM + 混入 GBK 标题字节 ⇒ `worker()` 先写 `EF BB BF`、`log_ansi_to_utf8()` 转换窗口标题。纯 LF 自首版就存在，不是回归。
119 ⛔⛔⛔ 0x0225/0x022A/0x022B 三次「宽判掐断救援链路」改码全被复测证伪：用户报「失效」时引擎一直在改写。⇒ 先确认现象定义再改。
120 ⛔⛔⛔ 包路径「停笔等线追上来」的杀手是 tip 链残留的 `moved` 守卫（0x022D）：`MSE_IDLE_MS 2000` 无条件「静止=停手」+ 续命 `s_liveMs<=1500` ⇒ 停笔 2s 后 `tip=0` ⇒ 代投停 ⇒ 线永不收敛。⇒ 双证据 `btnHeld = mDown ∨ VK_LBUTTON`、`grace = |g_snOut − g_snRaw| > 8轴 ∧ 静止 ≤4s`；解除 `!btnHeld && !grace && idle>2000`、续命 `hit && (btnHeld||grace) && idle<=15s`。⛔ 只比同域差值（铁律 105）。新增 `[catchup]` 诊断行。

121 ⛔⛔⛔ **光标路径也必须按模式推进**（0x022E，jwwh-18096 定案）：`gp_step()`（GetCursorPos）从前一律定长绳（标准 0.6·半径 / 追笔 0.25·半径）⇒ 真实包流一断、PS 退化查光标，画的就是绳：间距恒等绳长、停笔一字节不动 ⇒ 补齐构造上不可能（0x022D 修包路径对它无效）。铁证：`[catchup] 落后=60px` 纹丝不动，而同刻 `包路径滞后=(0,0)轴`。⇒ 标准=一阶低通 `k=dt/(dt+τ)`、追笔=`vmax·dt`、拉绳原样；末尾统一 `radiusPxF` 钳位；大跳跃在标准/追笔**重锚**（只有拉绳保留「本拍不推进」）；`GP_STILL_MS 120` 收尾加速；「静止」看**输入**（`s_gpInX/Y/s_gpMoveMs`）。⛔ 别再用 0.6/0.25 这类手调系数。

122 ⛔⛔ **「Shift+E 后第一笔被吞」的第一层（面板，0x022F）**：focusClear 末尾无条件 `selectLassoTool()` —— 切工具会终止正在进行的笔画，且每个面板各发一次、失败还回退 `runAsModal` 排队。**这一条被 0x0230 复测证伪为「不是根因」**（删掉仍吞），但改动本身保留：⇒ `reselectLassoIfStrayed()` 只在读到的工具**确实不是** `*lassoTool` 时才延后 700ms 切；读不到 / 不以 `Tool$` 结尾 ⇒ 一条命令都不发。⛔ 任何「热键命中后顺手切工具 / 发 batchPlay」仍要按这条审（副作用不为零）。

123 ⛔⛔⛔ **吞笔的真根因 = 断流期「僵持 tip=1」**（0x0230，jwwh-27164 定案）。用户规律是钥匙：「进清除模式前特意让笔远离数位板，第一笔照样吞；退出时笔拿回来画反而不吞」——「让笔远离」恰恰**制造断流** ⇒ 走合成包通路。铁证（笔已离开板面）：`[catchup] 断流=2750ms tip=1 hold=0 btn=0 idle=2750ms keep=0 grace=0`，四条独立证据全说「笔走了」，只有 tip 硬撑。病灶：`cursamp_thread` 的 `if (!tip && g_lastRealTip == 1) tip = 1;`（0x0126 为补流压力而写）**无阳性证据**、最长 6s；0x0126 判「抬笔后光标不动 ⇒ 坐标不变 ⇒ 无害」被真机证伪——**「没画出东西」≠「无害」**：合成包持续宣称 buttons 按下 ⇒ PS 认为这一笔没结束 ⇒ 真实包 tip 从 1 开始、**没有 0→1 边沿** ⇒ 新一笔不开始 ⇒ 整笔吞（套索「毫无现象」）。⇒ 在所有 tip 来源之后加最后一道守卫：`realAge>400 ∧ !btnHeld ∧ (realAge>2000 ∨ !grace) ∧ idleMs>400 ⇒ tip=0`（同时清 `s_hold`）。⛔ 四条缺一不可（`!grace` 保「停笔等线追上来」；`HARD_MS 2000` 防 grace 在断流期冻在 1）。诊断 `[catchup] tipDrop=` + `[raw] ★僵持 tip 清零`。

124 ⛔⛔⛔ **Alt 期间「笔抬没抬起」是吸附链的前置事实**（0x0231）：PS 的临时多边形套索**只在笔悬空之后**才成立 ⇒ ① Alt 按下时笔还压着且一直没抬 ⇒ 整条吸附链歇业（不吸、不钉包、不出 HUD）；② 「按 Alt 后继续画一段才抬笔」⇒ 折线起点 = **抬笔位置**，不是按 Alt 处。⇒ 状态位 `g_polyLift`（1 = 本轮 Alt 已见抬笔）：`poly_snap_gcp` 在工具闸门**之前**跑状态机，Alt 首拍按「笔压没压着」定初值，抬笔那拍**置位与搬锚同一处**，会话建立走 `moved` 支；`poly_snap_run`/`poly_pkt_click`/`poly_hint_live` 三处加门；`exit` why 新增 4。⛔ 接触电平 `g_pgTouch` 的维护必须**前移**到会话建立之前（否则「会话不建 ⇒ 电平不更新 ⇒ 判不出抬笔 ⇒ 会话永建」死循环）；⛔ 判「笔压着」不许用 `g_penDown`/tip（断流期僵住，同 123）；⛔ `POLYALT` 抖 0 一拍不清 `g_polyLift`（100）。诊断 `[alt] … ｜抬笔定锚 N 次` + `★抬笔定锚`。

125 ⛔⛔⛔ **0x0231 的两条收尾**（0x0232）：① 抬笔点**不许在判出抬笔时现读光标** —— 判据原来靠 `POLY_TOUCH_FRESH_MS`(120ms) 超时，手已滑走 69px，锚点落在「抬笔→当前光标」的路径上（截图取证：青线 x=436 y454→621，而黑线抬笔点 (450,385)）。⇒ 逐拍记录「仍压着」的 `s_liftX/Y`，搬锚走 `poly_anchor_push_at()`；包层另记**最新一包**电平 `g_pktLvl`，`poly_touch_step()` 里「buttons=0 且 40ms 内无按钮包 ⇒ 立刻抬笔」；`g_pgTouch` 的唯一写者收口到这个函数（⛔ 两处各写一份判据必然漂移）。② 多边形里「按下 + 拖动 > `POLY_CLICK_HOLD_PX`」⇒ PS 已切回普通套索 ⇒ `exit(5)` 整段歇业，抬笔自动复位。⛔ 冻结（`poly_hold_run`）**不加** `g_polyLift` 门（试过已撤回：冻结是平滑交接，关掉会让「画到一半按 Alt」的笔画多出一条长直线）；但抬笔那拍要**先作废** `g_polyAnchorReset`（冻结解冻推的中途锚点比抬笔点更错）。⛔ 截图取证一律**逐像素解码**（`python zlib` 手解 PNG 或 .NET），肉眼估端点会差 50px 以上。

126 ⛔⛔⛔ **「最小化 PS → 切回第一笔被吞」＝前台切回时合成包仍宣称 tip=1**（0x0233，jwwh-6072 定案）：0x0230 守卫要 `idle>400ms`，而切回必然移动光标 ⇒ idle≈0；日志 `grace=1` 与 `hold=1` 还各自护住 tip；深层是合成包 buttons 回喂 `g_penDown` 形成 `tip=g_penDown` 自锁（断流 15s 仍 penDown=1）⇒ PS 切回取到的首批包没有 0→1 边沿。⇒ HUD 线程写**未去抖** `g_fgInstNow`，`cursamp_thread` 在 0→1 边沿起（放所有 tip 来源**之后**）强制 `tip=0` + 作废 `s_hold`，直到「新左键 down 边沿 / 电平按着满 100ms / 硬上限 1500ms」。⛔ 只作用合成包通路；⛔ 别用 250ms 去抖后的 `s_fgOk`（第一笔早画完了）。诊断 `[fg]`。

127 ⛔⛔⛔ **停靠态 UXP 面板误显 HUD：0x0122「hit 在主框子树」对子窗口无效**（0x0233）：停靠面板 `IsChild=1` 全过 + Wintab 系统上下文照进包 ⇒ cheapOk 全绿。⇒ `canvas_focus_ok()` 补两条**命中窗口的直接事实**：创建者必须是本进程（UXP 独立渲染进程，SetParent 停靠后 pid 仍不同）∧ 类名不得是 `OWL./Chrome_/Qt/PSFloatC/...`；why=5。画布命中 `PSViewC/Static/Photoshop` 全放行（日志实证）。⛔ 只门 HUD 显隐，宽判 `canvas_hit_ok` 仍只认主框矩形（117/0x022B）；⛔ 判「光标底下那个窗口归谁」≠「前台进程是谁」。

## 其余铁律（1–89）—— 全文见 `refs/ironrules-1-89.md`

1–6 产物/构建｜7–13 闸门/面板（`'slct'` 三态、isPsBusy、gateAge、HUD AND 门）｜14–16 HUD/画布｜17–38 断流补流（三路输入、SYNTH_TIP_MAX_MS、`armed` 判据）｜39–44 键盘钩子/卸载｜45–53 UXP/画笔预设｜54–64 混合器储层｜65–70 在位闸｜71–73 工具闸门/光标｜74–80 HUD 门控/临时吸管｜81–83 标准滤波/文案｜84–86 HUD 坐标系/消失｜87–89 吸管键源

## 维护约定

超限先下沉 refs 再精简本文件（只留「编号 + 一句话 + refs 指针」）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ `PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，独立不许合并；Plug-ins 里的旧 .8li 直接覆盖不留备份（PS 锁文件，覆盖前必须完全退出 PS）。
