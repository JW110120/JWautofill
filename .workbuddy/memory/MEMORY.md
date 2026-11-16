# JWautofill 项目记忆（主索引）

> 只留「编号 + 一句话 + refs 指针」；明细在 `refs/`，里程碑在 `HISTORY.md`，逐条实证在 `2026-11-*.md`。
> 架构：平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。PS 现加载 **0x0234**（已部署到 `Adobe Photoshop 2026\Plug-ins\`，385024 B / 13:11；面板 `Plug-ins\dist` 同步为 **development** 构建 5211683 B）；面板侧纯白清除 = 面板 0x0227；0x0228 文本闸门、0x022B 宽判收口、0x022C 日志编码、0x022D 停笔补齐（包路径）、0x022E 光标路径按模式推进、0x022F 面板侧删掉无条件切套索、0x0230 吞笔真根因＝僵持 tip=1、0x0231 吸附两条边缘条件＝Alt 期间「笔抬没抬起」、0x0232 抬笔点逐拍记录 + 按住拖动＝回套索、0x0233 切回吞第一笔＝前台切回 tip 静默（✅ 用户复测通过）＋停靠面板误显 HUD 首修（❌ 复测证伪）、**0x0234 停靠面板误显 HUD 二修＝面板 pointer 心跳 + 命中窗口「直接父」（已部署，⚠️ 待复测）**。

## 索引（`refs/` 下）

`fill-and-stroke`（填充/描边/清除）｜`frontend-css`（CSS/面板/主题）｜`busy-gate`（闸门/模态）｜`uxp-api-layer`（UXP/API/性能）｜`pixel-algorithms`（像素）｜`toolchain-and-env`（构建/部署）｜`lasso-smoothing`（平滑/HUD/断流/闸门/吸管，O22–O62）｜`keyhook-8li`（键盘钩子）｜`brush-mixer-reservoir`（混合器）｜`poly-snap-0x0211-0x021F`（临时模式/冻结/吸附）｜`blend-hotkey-yield-0x0224`（混合模式让位）｜`ironrules-1-89`（1–89 全文）｜`ironrules-90-129`（90–129 全文）

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`）；改 .c 跑 `build.sh`（须沙箱外）零告警 + 导出表 5 项；改面板**别跑 `yarn build`**（那会产出 production 覆盖 `yarn watch` 的 dev 构建）—— watch 会自动重编，再把 `dist/bundle.js` 复制到 `Plug-ins\dist\` 即可。全仓 ~168 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的行。

## 铁律 90–130（**全文**见 `refs/ironrules-90-129.md` 与 `refs/ironrules-1-89.md`；本表只给一句话）

90 临时模式不派发任何可观测变更 ⇒ 真相只在原生 `I_POLYALT`（20ms 镜像），⛔ 不与 `I_ALTTOOL` 合槽。
91 「按住」= 修饰键完全匹配 + 一次性起按准入 + 连两拍确认（≈40ms）；同键位不同修饰键故意共存。
92 热键前提只有 `g_khPlug` + `g_khArmed`；`I_POLYALT` 不受布防约束。
93 Alt 期间不平滑但可钉点；移开 >14px 或按住 >420ms 解冻补线；只在 `g_strokeGate==1` 进场。
94 吸附通道：改包看不见 → 改光标仍看不见 → 改**鼠标消息**才生效。先定「PS 从哪读」再写算法。
97 挂 `DispatchMessageW` 改 `MSG.pt`+`lParam`，只碰 MOUSEMOVE/LBUTTONDOWN/UP；锚点只一个推进者。
98 按钮电平三路共用 ⇒ prev **按 owner 各记一份**；被拒推进的 owner 连 prev 都不写。
99 吸附参考线走 HUD 独立旁路 `poly_hint_live()`，⛔ 不并进 `cheapOk`。
100 会话只被**真事件**收摊（POLYALT 归零 ≥250ms / 主开关关）；心跳过期只是抖动；工具闸门值优先。
101 解冻补线搬折线起点 ⇒ 锚点必须跟着搬（取解冻后下一包 raw）。
102 预览读消息、落点读包 ⇒ 两条通道都要改；搬锚同步 `g_polyHintAx/Ay`。
103 别猜 PS 读哪条通道：光标/消息/包三条一起钉；锁定基准=落笔那刻真光标；接触是 `g_pgTouch`。
104 冻结钉圆心先验真身：进场 120px / 生效 260px ∧ 820ms，只放弃不猜值。
105 `px_x/px_y` 是**比例**不是坐标 ⇒ 只许「差值 + 同一刻一对真值基准」，屏幕→轴不做。
106 吸附有独立开关槽 `I_POLYSNAP`：六入口都问 `poly_snap_enabled()`；只有 `services_start` 清它。
107 面板标签宽度**按字数选档**（`label-2..6`），否则同组滑块长短不一。
108 吸附**不依赖**平滑总开关：包路径触发 = `en ∨ (I_POLYSNAP ∧ 心跳新鲜)`；平滑关时不冻结。
109 Alt 期间 HUD **只画参考线**：`wantVisible` 只认 `polyHint`，跳过 90ms 去抖，隐藏不写 `s_hudHideAt`。
110 吸附**不借**平滑工具闸门：入站 `toolGate`、`poly_tool_ok()`、`syncSmoothToolWatch` 的 need 加 `snapActive`；容差 **5°**（两个常量同时改）。
111 混合模式让位**三处同时改**：LL 钩子放行、RegisterHotKey 跳过、轮询与 `kh_hk_fire` 不广播。
112 救援链路宽判**不许借** HUD 闸门：`g_canvasHitDbg` 每帧现算 `canvas_hit_ok(cur)`。
113 裸数字键**必须** RegisterHotKey 独占（PS 前台 LL 钩子收不到）；字母符号裸键维持旧语义。
114 纯色填充 + 清除模式公式**恒为纯白 F≡255**：不读前景色、不跑抖动。
115 「H/L 在另存为被摘键」真凶是 **LL 钩子** ⇒ `g_khTextGuard` 四条键路一起熄火。
116 宽判**不许**把「浮层盖画布」当「笔离开画布」；前台进程条件已被 117 推翻。
117 功能判据**不许**依赖 Z 序 / 前台进程：`canvas_hit_ok()` 只认主框矩形（未解析 fail-open 1）。
118 日志编码与换行是**两件事**：`worker()` 先写 BOM + `log_ansi_to_utf8()`；纯 LF 自首版就是。
119 0x0225/0x022A/0x022B 三次「宽判掐断救援」全被复测证伪 ⇒ **先确认现象定义再改码**。
120 包路径「停笔等线追上来」的杀手是 tip 链 `moved` 守卫 ⇒ 双证据 `btnHeld`/`grace` + `[catchup]` 诊断。
121 光标路径**也必须按模式推进**：标准一阶低通、追笔 `vmax·dt`、拉绳原样；⛔ 别用手调 0.6/0.25。
122 focusClear **不许**无条件 `selectLassoTool()`（切工具会掐断笔画）⇒ `reselectLassoIfStrayed()`。
123 吞笔真根因 = 断流期僵持 `tip=1`（合成包无 0→1 边沿）⇒ 四条守卫缺一不可（细节见 refs）。
124 Alt 期间「笔抬没抬起」是吸附前置事实：`g_polyLift` 三处加门；接触电平维护**必须前移**。
125 `g_polyLift` 两收尾：抬笔点**逐拍记录**（不许现读光标）、按住拖动超阈值 ⇒ `exit(5)`；截图逐像素解码。
126 切回吞第一笔 = 切回时合成包仍宣称 tip=1 ⇒ `g_fgInstNow`（**未去抖**）边沿强制 `tip=0`。
127 停靠面板误显 HUD 的两条判据已被 0x0234 证伪 ⇒ ⛔ 勿再复用「UXP 独立渲染进程」假设。
128 HUD「是不是画布」**不许靠猜窗口身份**：面板 pointer 心跳 + 只看**直接父**；`MSG.hwnd` 只进日志。
129 `-25920` 两个成因：模态碰撞（能挡）+ **get 目标失效**（挡不住）⇒ 只读探测一律 `silent`、命中 `_obj:'error'` 立即 `break`、快照带 `fresh`。
130 快捷键 UI 分两处但**共用** `FuncHotkeyPanel` 的 `scope`（工具箱=功能快捷键 / APP=自定义快捷键）；两面板各有 `cachedConfig` 且原生 `config` **不广播** ⇒ 子面板打开即 `requestConfigRefresh()`。菜单：参数复位独占一组，「自定义快捷键 + 填充设置」同组；混合模式热键 notify 归 APP（「选区平滑」上方）。

## 其余铁律（1–89）—— 全文见 `refs/ironrules-1-89.md`

1–6 产物/构建｜7–13 闸门/面板（`'slct'` 三态、isPsBusy、gateAge、HUD AND 门）｜14–16 HUD/画布｜17–38 断流补流（三路输入、SYNTH_TIP_MAX_MS、`armed` 判据）｜39–44 键盘钩子/卸载｜45–53 UXP/画笔预设｜54–64 混合器储层｜65–70 在位闸｜71–73 工具闸门/光标｜74–80 HUD 门控/临时吸管｜81–83 标准滤波/文案｜84–86 HUD 坐标系/消失｜87–89 吸管键源

## 维护约定

超限先下沉 refs 再精简本文件（只留「编号 + 一句话 + refs 指针」）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ `PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，独立不许合并；Plug-ins 里的旧 .8li 直接覆盖不留备份（PS 锁文件，覆盖前必须完全退出 PS）。
