# JWautofill 项目记忆（主索引）

> 只留「编号 + 一句话 + refs 指针」；明细在 `refs/`，里程碑在 `HISTORY.md`，逐条实证在 `2026-11-*.md`。
> 架构：平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。PS 现加载 **0x0235**（已部署到 `Adobe Photoshop 2026\Plug-ins\`，387072 B / 13:24；面板 `Plug-ins\dist` 同步为 **development** 构建 5259119 B）；面板侧纯白清除 = 面板 0x0227；0x0228 文本闸门、0x022B 宽判收口、0x022C 日志编码、0x022D 停笔补齐（包路径）、0x022E 光标路径按模式推进、0x022F 面板侧删掉无条件切套索、0x0230 吞笔真根因＝僵持 tip=1、0x0231 吸附两条边缘条件＝Alt 期间「笔抬没抬起」、0x0232 抬笔点逐拍记录 + 按住拖动＝回套索、0x0233 切回吞第一笔＝前台切回 tip 静默（✅ 用户复测通过）＋停靠面板误显 HUD 首修（❌ 复测证伪）、0x0234 停靠面板误显 HUD 二修＝面板 pointer 心跳 + 命中窗口「直接父」、0x0235 滚轮热键（Ctrl+滚轮切填充模式）+ 套索工具键改「按需切换」（✅ 已部署，用户复测通过）、**0x0236 三组新工具键（Shift+H 五工具循环保总开关开 / M 矩形选框 / Shift+M 框选循环，后两者关总开关）+ 自定义快捷键面板重排（五块 + 分隔线、去掉多余分组标题）（已部署 5305628 B / 16:04）**、**0x0237 H 在「开关已开」这一拍也回套索（`LASSO_RETURN_TOOLS`）+ 菜单文案「紧凑模式 - 开/关」/「套索选区平滑」+ 新增「显示热键通知 - 开/关」（`HotkeyNotifyBus`，两面板共用）+ 分块线改用 `.divider`**、**0x0238 通知开关改名「热键通知」并**拆成面板各自一份**（app/toolbox 两个文件）+ 工具箱菜单隐藏 alpha 采样/键盘修复 + 关闭「特制笔刷」入口（删 manifest entrypoint）+ 功能快捷键按折叠分区加实线/虚线 + 平滑页签 26→28px（面板 5343998 B / 17:18，manifest 3532 B，未改 .c，⚠️ 需重启 PS 生效）**。

## 索引（`refs/` 下）

`fill-and-stroke`（填充/描边/清除）｜`frontend-css`（CSS/面板/主题）｜`busy-gate`（闸门/模态）｜`uxp-api-layer`（UXP/API/性能）｜`pixel-algorithms`（像素）｜`toolchain-and-env`（构建/部署）｜`lasso-smoothing`（平滑/HUD/断流/闸门/吸管，O22–O62）｜`keyhook-8li`（键盘钩子/滚轮热键 0x0235）｜`brush-mixer-reservoir`（混合器）｜`poly-snap-0x0211-0x021F`（临时模式/冻结/吸附）｜`blend-hotkey-yield-0x0224`（混合模式让位）｜`ironrules-1-89`（1–89 全文）｜`ironrules-90-129`（90–129 全文）

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
131 滚轮组合没有 vk ⇒ 只能由 `WH_MOUSE_LL` 的 `WM_MOUSEWHEEL` 处理（伪 vk `KH_VK_WHEEL`）；吞滚动的条件是**五条全与**（有条目 ∧ 修饰键完全匹配 ∧ 布防 ∧ 非文本 ∧ 前台），**裸滚轮永不装载**（那是 PS 的缩放画布）。
132 「切回某工具」一律**按需**：先同步读 `app.currentTool`，已在目标族就别发 `select` —— 无条件切会迟到落地，把用户随后的 Shift+某键原生循环（如 Shift+L 切多边形/磁性套索）拽回去。
133 PS 原生「Shift+字母循环同组工具」在 L 上不生效（其它字母都正常，首选项已勾选）⇒ L 被插件接管后这一组的循环只能由插件补：新建配置条目 `lasso_cycle`（默认 Shift+L，仅工具模式装载）→ RegisterHotKey 独占 ⇒ PS 收不到、不会双跳；游标在桥接侧维护（`app.currentTool` 不可靠，见 0x0211）。**多边形套索的引用名是 `polySelTool`**（`polygonalLassoTool` 是猜的、`select` 静默无效 ⇒ 表现为「只在套索与磁性之间跳」）；族判定用 `LASSO_GROUP` 精确比较，⛔ 别用 `/lassoTool$/` 后缀正则（判不出 polySelTool，会把多边形误判成跑偏而踢回普通套索）。`App.isLassoTool`（平滑闸门）**故意**仍只认 `lasso` 关键词，与原生 `ci_has` 逐字一致，两套判据别混用。
134 子套索（`polySelTool`/`magneticLassoTool`）与主开关的双向联动（2026-11-16）：**关**总开关那一拍若停在子套索 ⇒ 切回 `lassoTool`（`onMainToggleChanged` 里做，只在开→关这一拍，开机不动工具）；**Shift+L 切到子套索 ＝ 换工具** ⇒ `autoOffOnOtherTool` 开且总开关开时自动关（在 `lassoCycle` 的广播回调里做，桥接拿不到 state）。三者由此闭环。面板侧任何自切工具（H/L/临时吸管/巡检/`slct`）**必须**走 `App.noteRealTool()` 同步 `lastKnownTool` 与三条循环游标（`syncToolCursors()`，旧名 `syncLassoCycleCursor` 仍保留为别名），否则 Shift+L 会从旧游标跳过一格。
135 热键反馈**按归属分流**：APP 侧（toggleMain/focusLasso/lassoCycle/focusClear/blendMode/切换填充模式）全部走 `appHotkeyNotify`，位置固定「选区平滑」分区**上方**；工具箱只留 applyBrush + 功能按钮（`runFunc` 里 `fillModeCycle` 已排除）。一条消息只在一块面板出现。`cycleFillMode` 的通知在**那里**发（才知道切到哪个模式），不在触发回调里发。
136 滚轮方向的**唯一换算点**是 `HotkeyBridge` 的 `fillModeCycle` 分支：原生 `dir` 是物理方向（+1=向上），语义方向取反 ⇒ **向下滚（往后转）= 纯色→图案→渐变**。⛔ 别去改 .8li 的符号，否则旧面板配新 .8li 会反过来。
137 0x0236 三组工具键（`fillToolCycle` Shift+H＝五工具循环且 `requestMainToggle` 只开不关；`focusMarquee` M / `marqueeCycle` Shift+M＝切选框并 `requestMainToggleOff`）**必须**在切工具前打 `noteSelfToolSwitch()` 抑制位（1.5s 时窗），否则 `onMainToggleChanged` 的「顺手切套索」会把刚切出的工具拽走；这三键**无条件**发 `select`（与铁律 132 相反：裸键 M 不被吞、PS 原生同步循环在先，队列里的 select 永远最后落地 ⇒ 结果确定；「已在目标就跳过」反而被迟到命令拽回）。选框**不在** `AUTO_OFF_TOOLS` ⇒「自动关」永不触发，关开关只能由桥接主动做。游标统一走 `syncToolCursors()`（`noteRealTool` 是唯一调用点）。面板 APP 侧改成 `appBlocks` 五块 + 单卡片内分隔线（0x0237 起改用通用 `.divider`），**不再渲染分组标题**（首块标题与首行同名＝用户说的「多余的选区填充」）。
138 **H 的「保持开启」这一拍也要回套索**（0x0237）：工具模式下 `MainToggleBus.doToggle` 是「只开不关」，已开着就 `return cur`、**不写状态** ⇒ 无翻转 ⇒ `onMainToggleChanged` 不触发 ⇒ 停在多边形/磁性/矩形/椭圆选框上按 H 毫无反应。修复点只能在 **app.tsx 的 `toggleMain` 广播分支**（那里才有权威的 `info.enabled`）：`enabled===true ∧ switchToLassoOnEnable ∧ 工具 ∈ LASSO_RETURN_TOOLS`（四个：poly/magnetic/marqueeRect/marqueeEllip）⇒ `selectLassoTool()`。⛔ 已在套索 / 工具未知都不发命令（铁律 132）；⛔ 别改 doToggle 让它「已开着也翻」——那会把 H 变成关开关。
139 **面板级偏好按 scope 各存一份文件**（0x0238 起）：用户明确要求「两个面板独立管理，不要跨面板共享」⇒ `HotkeyNotifyBus` 从单文件改为 `settings/hotkey-notify-app.json` / `-toolbox.json`，API 首参一律带 `HotkeyNotifyScope`（`hotkeyNotifyOnSync(scope)` / `toggleHotkeyNotify(scope)` / `subscribeHotkeyNotify(scope, cb)`），缓存、写链、监听器都按 scope 各一份。⛔ 别再引入「一边改了广播另一边」的联动；⛔ 旧的共享文件 `hotkey-notify.json` 故意不迁移（两个面板各自回默认开）。仍适用的三条：`subscribeXxx` 的 `last` **从 null 起**（首次必回调，否则后打开的面板菜单文案永远停旧值）；`toggleXxx()` 里**不能**再调同一条 `writeChain` 上的 `setXxx()`（自己等自己，菜单点了永不返回）；两个面板的菜单项 id 必须不同（UXP 全局唯一），动态改文案只有一份兼容写法（`utils/panelMenu.ts` 的 `updatePanelMenuItem`）。
140 卡片内「分块分隔线」**必须复用通用 `.divider`**，别自绘：`.border-panel-section .divider` 已把宽度补成 `calc(100% + 20px)` 并左右各 `-10px` ⇒ 两端正好压在卡片左右边框上，颜色 `var(--border-color)` 随主题与边框同源。⛔ 旧写法 `border-top + currentColor + opacity .16` 既不是边框色、也到不了边框（0x0236 的错误示范，0x0237 已按用户要求改掉）。
141 子面板里的分隔线要与**折叠分区内的真实位置**对齐（0x0238）：对照表是 `funcHotkeyDefs.FUNC_HOTKEY_DIVIDERS`（key=功能 id，value=该行**下方**的线型），实线用 `.divider`、虚线用公共组件 `components/DashedDivider`。⛔ 同一行里的两颗按钮（如 浅线/深线同层补色、消除锯齿/线条加黑、提升下极值/削弱上极值）在子面板是两行，**两者之间不画线**——否则把「一个操作组」切碎。⛔ 分隔线必须跟行走在同张卡片内，卡片外会被边框截断、压不到左右边框。
142 **关闭入口 / 隐藏菜单项都别删代码**（0x0238）：关闭「特制笔刷」＝删 `manifest.json` 里 `com.listen2me.brushstudio` 那个 entrypoint（`src/index.tsx` 的渲染与 `src/brushstudio/` 全留；⚠️ 需**重启 PS** 才从增效工具消失，因为 manifest 只在加载时读）；隐藏菜单项＝从 `APP_MENU_ITEMS`/`ADJUSTMENT_MENU_ITEMS` 数组里去掉条目，`AdjustmentMenu.handleMenuAction` 的 case 与 `registerCallbacks` 一律保留（本次隐藏的是 `alphaSample` / `repairKeyboard`）。
143 页签「文字上下缝相等」只能靠**改偶数高度**（0x0238）：`.smooth-mode-trio > .radio-option` 26→28px 后居中项上下各 +1px、正好相等；想再松继续按 2px 一档加。⛔ 别用不对称 padding：选中格底边宽度为 0、未选中格只有底边，三种状态会被推歪。
144 中文墨迹在 13px 行盒里天然偏下约 1px（0x0238 实测：26px 时上缝 6 / 下缝 5）。凡「文字看起来贴底」的等高盒子，先量上/下缝再动，别凭感觉加 margin。

145 折叠分区的按下态**只加在共用的 `.collapse-header:active`** 上（四处标题全用它：工具箱每个分区 + APP 的套索选区平滑/选区改造/填充选项），别逐个组件加。取值对齐总开关 `.main-button:active`：`--button-down` + `scale(0.98)`，四档主题里它都比 `--bg-color` 深一档，无需分主题。⚠️ `:active` 里**必须**重写 `transition`（60ms）——基础规则那条 `background-color 0.3s` 是给 hover 的，80~150ms 的点击里慢了等于看不见反馈；松手仍走 0.3s 淡出 = 按下脆、回弹柔。⛔ 缩放别低于 0.95：整行全宽，缩太狠标题与箭头会明显位移。

## 其余铁律（1–89）—— 全文见 `refs/ironrules-1-89.md`

1–6 产物/构建｜7–13 闸门/面板（`'slct'` 三态、isPsBusy、gateAge、HUD AND 门）｜14–16 HUD/画布｜17–38 断流补流（三路输入、SYNTH_TIP_MAX_MS、`armed` 判据）｜39–44 键盘钩子/卸载｜45–53 UXP/画笔预设｜54–64 混合器储层｜65–70 在位闸｜71–73 工具闸门/光标｜74–80 HUD 门控/临时吸管｜81–83 标准滤波/文案｜84–86 HUD 坐标系/消失｜87–89 吸管键源

## 维护约定

超限先下沉 refs 再精简本文件（只留「编号 + 一句话 + refs 指针」）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ `PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，独立不许合并；Plug-ins 里的旧 .8li 直接覆盖不留备份（PS 锁文件，覆盖前必须完全退出 PS）。
