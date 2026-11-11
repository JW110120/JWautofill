# JWautofill 项目记忆（主索引）

> 只留「编号 + 一句话 + refs 指针」；明细在 `refs/`，里程碑在 `HISTORY.md`，逐条实证在 `2026-11-*.md`。
> 架构：平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。PS 现加载 **0x022E**（已部署到 `Adobe Photoshop 2026\Plug-ins\`，379904 B / 18:05）；面板侧纯白清除 = 面板 0x0227；0x0228 文本闸门、0x022B 宽判收口、0x022C 日志编码、0x022D 停笔补齐（包路径）、0x022E 光标路径按模式推进。

## 索引（`refs/` 下）

`fill-and-stroke`（填充/描边/清除）｜`frontend-css`（CSS/面板/主题）｜`busy-gate`（闸门/模态）｜`uxp-api-layer`（UXP/API/性能）｜`pixel-algorithms`（像素）｜`toolchain-and-env`（构建/部署）｜`lasso-smoothing`（平滑/HUD/断流/闸门/吸管，O22–O62）｜`keyhook-8li`（键盘钩子）｜`brush-mixer-reservoir`（混合器）｜`poly-snap-0x0211-0x021F`（临时模式/冻结/吸附）｜`blend-hotkey-yield-0x0224`（混合模式让位）｜`ironrules-1-89`（旧铁律全文）

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`）；改 .c 跑 `build.sh`（须沙箱外）零告警 + 导出表 5 项；改面板 `yarn build`。全仓 ~168 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的行。

## 铁律 90–121（要改先看这一段；实证细节见 `2026-11-11.md`）

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
120 ⛔⛔⛔ **「停笔等线追上来」的杀手是 tip 链里残留的 `moved` 守卫**（0x022D，只管**包路径**）：`MSE_IDLE_MS 2000` 无条件「静止=停手」+ 续命 `s_liveMs<=1500` 两处漏网 ⇒ 停笔 2s 后 `tip=0` ⇒ 代投停 ⇒ 线永不收敛。⇒ 双证据 `btnHeld = mDown ∨ VK_LBUTTON`、`grace = |g_snOut − g_snRaw| > 8轴 ∧ 静止 ≤4s`。⛔ 只比同域差值（铁律 105）。新增 `[catchup]` 诊断行。

121 ⛔⛔⛔ **两条通道都要按模式推进：`gp_step()`（GetCursorPos = 光标路径）从前根本不看 `mode`，一律定长绳**（0x022E，jwwh-18096 定案）。铁证：`[catchup]` 里 `idle=1546~2391ms` 三条样本 `落后=60px` 纹丝不动，**同一时刻** `包路径滞后=(0,0)轴` ⇒ 屏幕那条线不是包路径画的；60 = 半径 100×**0.6**（标准模式的绳长）；`[stroke] 平均滞后=18.0px 模式=0` 证明包路径是 18px。真实包流一断 PS 就退化成鼠标通路、每帧查 `GetCursorPos` ⇒ 画出来就是绳：间距恒等于绳长、停笔「绳没绷紧」一字节不动 ⇒ 补齐**构造上不可能**（所以 0x022D 修包路径对这条无用）。⇒ 三种模式各归其位（标准 `k=dt/(dt+τ)`、追笔 `vmax·dt`、拉绳定长绳原样）+ 统一末尾 `radiusPxF` 钳位 + 大跳跃在标准/追笔下**重锚**（只有拉绳保留「本拍不推进」，旧行为会把输出永久冻在 3193px 外）+ `GP_STILL_MS 120` 收尾加速（静止时 `k≥0.5` / `step×3`，语义同 120 的 `grace`）。⛔ 别再用 0.6/0.25 这类手调系数——它们让同一条曲线在两个通道永远差一截，正是本故障形态。⛔ 光标路径的「静止」必须看**输入**（`s_gpInX/Y/s_gpMoveMs`），不能用输出点判。详见 `2026-11-11.md`、`smooth_engine.c` gp_step 函数头。

## 其余铁律（1–89）—— 全文见 `refs/ironrules-1-89.md`

1–6 产物/构建｜7–13 闸门/面板（`'slct'` 三态、isPsBusy、gateAge、HUD AND 门）｜14–16 HUD/画布｜17–38 断流补流（三路输入、SYNTH_TIP_MAX_MS、`armed` 判据）｜39–44 键盘钩子/卸载｜45–53 UXP/画笔预设｜54–64 混合器储层｜65–70 在位闸｜71–73 工具闸门/光标｜74–80 HUD 门控/临时吸管｜81–83 标准滤波/文案｜84–86 HUD 坐标系/消失｜87–89 吸管键源

## 维护约定

超限先下沉 refs 再精简本文件（只留「编号 + 一句话 + refs 指针」）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ `PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，独立不许合并；Plug-ins 里的旧 .8li 直接覆盖不留备份（PS 锁文件，覆盖前必须完全退出 PS）。
