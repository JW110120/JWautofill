# JWautofill 项目记忆（主索引）

> 索引 + 铁律速查；**明细一律在 `refs/`，里程碑史在 `HISTORY.md`**。⛔ 违反必炸。
> 架构：平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。
> 现役 **0x021E**。近十版：0x0212 拾色器+修饰键完全匹配（91）｜0x0213 按住键补布防门（92）｜0x0214 Alt 落笔冻结（93）｜0x0215–1D 多边形吸附（94–103：15 改包=看不见、16 搬光标仍不可见、17 上探针、18 消息层生效、19 修边沿被吃+参考线、1A 修会话被抖动销毁、1B 解冻补线要搬锚、1C 预览与落点是两条通道、1D 三条通道一起钉）｜**0x021E 冻结圆心验真身（104）**。

## 索引

填充/描边/清除 `fill-and-stroke.md`｜CSS/面板/主题 `frontend-css.md`｜闸门/模态 `busy-gate.md`｜UXP/API/性能 `uxp-api-layer.md`｜像素 `pixel-algorithms.md`｜构建/部署 `toolchain-and-env.md`｜平滑/HUD/断流/闸门/吸管 `lasso-smoothing.md`（O22–O62）｜键盘钩子 `keyhook-8li.md`｜混合器 `brush-mixer-reservoir.md`（均在 `refs/`）

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`，语义检查会被静默跳过）；改 .c 跑 `build.sh`（须沙箱外）零告警 + 导出表 5 项；改面板 `yarn build`。全仓 ~168 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的行。

## 现役焦点（0x021D · 2026-10-29）

Alt 临时多边形套索 = **冻结**（93）+ **8 方向吸附**（94/97）+ **青色参考线**（99/100）。吸附换三次通道才对，最终落在**鼠标消息**（97）；19 修边沿被吃，1A 修会话被抖动销毁，1B 解冻补线要搬锚，1C 修「橡皮筋读消息、落点读包」的错位（102），**1D 改「别猜 PS 读哪条通道，光标/消息/包三条一起钉」（103）**。

## 铁律速查

**产物/构建**
1 ⛔⛔ 除非用户明确要求，禁止 `git add`/`commit`；测试通过且用户发话才提交（代码+日志+记忆一次提交）。
2 ⛔⛔ IPC 双防御：`toWire()` 一律 Math.round，原生 `double?`+Round（漏=整条消息被丢）。
3 ⛔⛔ .8li：PiPL 头 10 字节；`'8664'` 导出名=C 字符串；版本走 `jw8li_version`（改 .c 必升）。
4 ⛔ `CFG_NLONGS=60`（0x0211 起）：两个 .c 同步改，新增槽后 fit-check 指到最后一个槽。
5 ⛔ 日志：`.8li`→`%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log`；引擎→`%TEMP%\jwwh-<pid>.log`。
6 ⛔⛔ 卸载先全停引擎线程再返回：`jwwh_unhook()` 幂等+兜底 repatch；DETACH 只能 join。

**闸门/面板**
7 ⛔⛔ `'slct'` 三态只有 `2` 停轮询，同步三处；边沿无心跳⇒接管带 2s 时效；面板判据=原生 `gateOwned`。
8 ⛔ 闸门=`isPsBusy()`+文档闩锁+`psRead()`；禁采信 `core.isModal()`；空闲巡检 <3.3/s。
9 ⛔⛔ `psBusyInProc()` 三态禁并进 `isPsBusy()`；`-1` 绝不当 `0`。
10 ⛔⛔ 真相不靠心跳续命：面板发 `gateAge`，原生写 `I_GATETS=now−gateAge`。
11 ⛔⛔ HUD=显式 AND 门：窗口·包流·套索∧接触·一笔之中·前台·画布焦点·落笔判据·非断流·拉绳·面板 bit0·总开关。
12 ⛔⛔ HUD 门槛不门救援：救援用宽判 `canvas_hit_ok`（不看前台），HUD 用严判。
13 ⛔ 宿主开关外置 `wtctx.ini`（缺=只观测）；`cursorInject` 缺省 1。

**HUD/画布**
14 ⛔⛔ 拉绳定长 `f=1−rope/dist`，1px+二次贝塞尔；HUD 留 `WS_EX_TRANSPARENT`，`WS_EX_TOPMOST` 写进 CreateWindowExW。
15 ⛔⛔ 悬链垂度只加重力方向：`cqy=my+2·sag·hor`，`hor=|dx|/d`。
16 ⛔ px 权威=屏幕/lcOutExt 非 lcInExt；像素常量×`dpiS`；`putPixels` 默认 replace=true。

**断流/补流（17–38，论证查 `refs/lasso-smoothing.md` O22–O46）**
17–21 对 Wintab 只读不写；「没开始画」≠断流；停摆⇔PS 失前台（`fg=`）；`k==0`≠驱动恢复；LNP 在环≠方案。
22–26 `SYNTH_TIP_MAX_MS=6000` ≠ `CONTACT_HOLD_SMOOTH_MS=1500`；⛔ 不用 VK_LBUTTON 电平当抬笔证据；空档期落笔只由包外证据定且只加不减。
27–32 三路输入只钩一条等于没有（Wintab+光标+Ink）；节拍=PS 查询同拍（外推限幅 40ms）；标定分层 n≥3/n==2/n<2；起笔锚定只看 buttons 逐包 0→1；`BTN_EDGE_MIN_ZERO=16`。
33–38 系统光标与 Wintab 同源；Ink 判死 `[ink]=0`；输出不绑包（`gp_step()` 每查询推一步）；超 6s 靠「包外按钮电平+画布内+1.5s 内动过」；交还必须 `g_btnResync`；⛔⛔ 「包流健康」≠「PS 在用包画」：判据 `armed`，验证 `[raw] gp=` 一直涨。

39 ⛔⛔ 键盘热键必须双路：LL 钩子在 PS 前台整段收不到键 ⇒ `GetAsyncKeyState` 10ms 轮询兜底。
40 ⛔⛔ 钩子活性看阳性证据：轮询有增量 ∧ 钩子零增量 ⇒ `g_khReinstall`（3/10/30s 退避，录制中不重装）。
41 ⛔⛔ unload 必须让引擎哑火：`services_stop`→`jwwh_set_engine_off(1)`；⛔ 不用 `jwwh_unhook()`；光标 `armed` 必须含 `tool_gate_ok()`。
42 ⛔⛔ `pstool.c` 的 `s_basic` 只声明不赋值 ⇒ `pstool_uninstall()` 恒 return（判据 grep `s_basic =`）。
43 ⛔⛔ `keyhook_stop()` 在 join 前 `kh_unhook_both_now()`，join 后补一次。
44 ⛔⛔ DETACH 日志先落再停服：`pipl.log` 的 `DLL_PROCESS_DETACH` → `dumps\crash-*.dmp` → WER 故障模块。

**UXP / 画笔预设** —— 全档 `refs/uxp-api-layer.md`
45 ⛔⛔ `_obj` 只能来自跑通过的样本；-25920 = 命令名 PS 不认识。
46 ⛔⛔ `dialogOptions` 一律 `silent`（`dontDisplay` 反义）；只认描述符自己的 `_options`。
47 ⛔⛔ 改状态的动作，判据只能是「回读权威字段变了」；"没报错"等于没说。
48 ⛔⛔ 装笔=缓存整份 `currentToolOptions`（快路径 `set cto`，慢路径 define→参数→抓 cto→删预设）。
49 ⛔⛔⛔ `set` brush 的 `to` 必须带笔尖身份（否则变 `computedBrush`）；几何走 `set paintbrushTool to 整份 cto`。
50 ⛔⛔⛔ PS 27 换笔尖=`select + brush _name + makeVisible:false`；`set+brush`=-1715、`set+brushPreset`=-25920。
51 ⛔⛔⛔ 失败的 batchPlay 每条画一条黄条 ⇒ 正常路径 `failCount`=0；能读状态判的绝不试错。
52 ⛔⛔ 黄条归属：PS=一句话（「悦绘:」前缀）；`#1 … / #2 …`=面板 `.notify-bar`；`say()` 截 120 字两行。
53 ⛔⛔⛔ 判当前工具不能用 `get currentTool`（-25920）⇒ 指纹字段 `wetness`/`dryness`/`reservoirState`/`autoFill` ≥2。

**混合器浮雕笔（P3）** —— 全档 `refs/brush-mixer-reservoir.md`
54 ⛔⛔⛔ 储层只能靠重新采样装填（像素 `{}`、get 报 -25920）；改前景色会灌成纯色；上色 JS 一步乘法，alpha 用覆盖度。
55 ⛔⛔⛔ 不存在「派发 AM 事件触发工具手势」（`loadBrush`/`cleanBrush`/`mixerBrushTool` 在 exe ID 表 0 命中）。
56 ⛔⛔ `canvasClick`：`alt:1` 装储层 / `alt:0` 验货（只单击无 drag）；Alt 先按住再按左键；卸载必须 `click_join`。
57 ⛔⛔⛔ 厚涂笔走储层：`mixer.pattern` ⇒ `applyBrush` 首部 return；⛔ 不能整段 `runAsModal`；吸前直径=图案长边；验货底不透明中灰。
58 ⛔⛔ 面板尺寸只认图案长边；`set` 的 `_target` 必须裸引用；直径回读被 PS 换算（400→407）。
59 ⛔⛔⛔ 原生 JSON 严格类型：`json_bool` 只认 `true`/`false`，数字一律 `json_num`；「发了就忘」必须 `xxxResult` + `waitHostMessage()`。
60 ⛔⛔⛔ 直径不靠 `set`（会抹掉 `sampledData`）⇒ `defineBrush(side² 白方块)`，直径=边长。
61 ⛔⛔⛔ 有位图 ≠ 装了图案（吸空白也 `state=2`）⇒ 点一笔看层次；储层尺寸=直径×1.4325。
62 ⛔⛔ 吸得准：`fitOnScreen` 把图像摆到视口正中；原生点「命中窗口中心」。
63 ⛔⛔ 笔尖落地顺序：现成方笔且直径对=零命令 → 按名选 → 整份 cto 改 `diameter` → `defineBrush`；改直径必须 `runAsModal` + `jsonSafe()`。
64 ⛔⛔ 笔尖尺寸不许降级：≠ 图案长边就抛错。

**键盘钩子·插件在位闸** —— 明细 `refs/keyhook-8li.md`
65 ⛔⛔⛔ 三路统一过 `g_khPlug`：18923 无面板客户端 = 本体不在位 ⇒ 不装钩、不注册、轮询只消沿。⛔ 不做「连过一次就粘住」。
66 ⛔⛔ 迁移探测自报身份：`kh_try_migrate` 走 `path=/jw-migrate`，非 `/` 不计在位。
67 ⛔⛔⛔ WS 槽位必须真归还：`kh_cli_remove` 同时清 `closing`/`notPlugin`，`kh_cli_add` 准入只看 `s==INVALID_SOCKET`。
68 ⛔⛔ `SO_RCVTIMEO` 超时 ≠ 断开：首帧超时（`got==0 ∧ WSAETIMEDOUT`）返 `-2=空闲` ⇒ continue+ping。
69 ⛔⛔ 笔刷热键开关状态只在 `hotkeyArmStore.ts`（单例+`useSyncExternalStore`）；工具箱折叠是条件渲染；`store.error` 无 TTL。
70 ⛔⛔⛔ 平滑也要过位闸，判据是「已握手」不是「占槽」：`g_cliReady` 唯一在位判据；`plug_revoke()` 只清 enabled、不下 cmd=2、gate 置 2；宽限 1500ms；握手只拒精确 `/jw-migrate`。

**工具闸门 / 光标路径** —— 明细 O41–O43
71 ⛔⛔⛔ 只有 `GATETS 新鲜 ∧ TOOLGATE==0` 是事实 ⇒ 立即否决；心跳过期不许当换工具；收口 `tool_edit_allowed()`，包路径与光标路径共用。
72 ⛔⛔ `hostYield` 必须传 `maxHoldMs`（工具类 900ms 强制放行）。
73 ⛔⛔ 光标推进器抖动时钉住：松手后 `GP_HOLD_MS=700` 内返回平滑点；`s_gpBtn` 跟真实的手；大跳跃改「本拍不推进」。

**HUD 门控 / 临时吸管取色** —— 明细 O44–O47
74 ⛔ 临时吸管判定全在面板（工具模式 ∧ 总开关 ∧ 套索）；`altToolHold` 挡自动关，松开回套索后 `applyToolGate('lassoTool')` + `setMainToggle(true)` 兜底。
75 ⛔⛔⛔ `write_params()` 在 `pstool_owns()` 时一个字节都不写 `I_TOOLGATE` ⇒ 必须独立槽 `I_ALTTOOL`（反面判据：切吸管后 HUD 还在 = 借了闸门槽）。
76 ⛔⛔⛔ `I_ALTTOOL` 必须四处清 0：吸管键释放 / 键源卸载 / `plug_revoke` / `services_start`。
77 ⛔⛔ HUD 闪现只能从显示时机治：`CONTACT_HOLD_MS`(250) 不能删；「刚隐藏过的 1.5s 内须连续满足 180ms 才重现」；首次仍立即。
78 ⛔⛔ `!g_calib.valid` 提前 return 必须显式归零 `g_penDown`/`g_toolOk`/`g_strokeGate`。
79 ⛔⛔ 别想让 Alt 绕过 PS（吞键/伪造 `WM_SYSKEYUP` 都不行）⇒ 只能事后搬色。
80 ⛔⛔⛔ 「颜色没变」≠「没取色」：判据只能是「这一轮有没有左键」（`busyHadLeft`）；只有空格 ⇒ 不当取色。

**标准滤波 / 面板文案** —— 明细 O47
81 ⛔⛔⛔ 笔速必须用真实位移：`|raw − out|` 是滞后不是速度（会负反馈锁死在 4~6px）；按 ≥6px 距离窗 / ≥4ms 窗时结算（`SPEED_WIN_PX/MS`）。
82 ⛔⛔ 尖角判据两级基准：参考方向由 ≥3px 线段推进、当前方向由 ≥2px 累积位移给出。
83 ⛔⛔⛔ 用户可见文案（`helpTexts.ts`）：汉字与字母/数字间半角空格；数字与 px/%/°/ms 不空、与「像素/度/级」空；区间「 – 」、减号「−」；⛔ 禁箭头/`**`/勾叉图标（`title` 纯文本）。全文规则在文件头。

**HUD 坐标系 / 消失** —— 明细 0x020D–0x020F
84 ⛔⛔⛔ HUD 圆心不许绘在会漂的量上：拉绳未绷紧时复用上一帧窗口位置（用绘制点判）+ 整像素迟滞 `HUD_PX_HYST`；复用后绳末端不能由 `rx/ry` 反算。
85 ⛔⛔⛔ 两套坐标系混用不报错只变形：`putXc/putYc`=窗口左上角，圆心在 `(half,half)` ⇒ 光标相对圆心向量 = `cur − put − half`；判据 `rope=%d ≤ leashPx`。
86 ⛔⛔⛔ HUD 短暂消失只有三个源头（0x020F 已修）：① `realOk` 过期（宽限 1500ms，仅「一笔进行中且未接管合成包」）；② `lagSkip`/`bigJump` 不许并进 `cheapOk`（并进去就是 `SW_HIDE`）；③ 先 `HUD_HIDE_DEBOUNCE_MS`(90) 再 `HUD_RESURF_DEBOUNCE_MS`(180)，顺序错就是「小抖→大消失」。

**临时吸管键源（0x0210）** —— 明细 O44 / `refs/keyhook-8li.md`
87 ⛔⛔⛔ 吸管键绝不能进热键匹配表（会被 RegisterHotKey 独占，键被摘走）⇒ `action=="altTool"` 只取 combo 发布 (vk,mods)，调度线程轮询、仍推 `altHold`。
88 ⛔⛔⛔ 键源默认 `/`（裸键）：`kh_combo_to_key` 必须允许无修饰键；解析只在配置线程做一次（`kh_key_to_token` 返回 static）。
89 ⛔⛔ 事后搬色只在触发键含 Alt 时才需要（`altToolComboHasAlt()`）。

**PS 临时模式（0x0211）** —— 明细 O51
90 ⛔⛔⛔ 「PS 临时模式」不派发任何可观测变更（`application.tool` 仍 `lassoTool`、无通知、无 `'slct'`）⇒ 真相只有原生有：`GetAsyncKeyState(VK_MENU) ∧ 前台是本进程` ⇒ 独立槽 `I_POLYALT`，每 20ms **镜像电平**（⛔ 不是边沿）。⛔ 不许与 `I_ALTTOOL` 合槽；HUD `gateOk` 单独再压一次。

**按住键 vs 同键位热键（0x0212）** —— 明细 O52
91 ⛔⛔⛔ 「按住」= 修饰键完全匹配 + 一次性起按准入 + 连两拍确认（≈40ms）：没列出的修饰键必须抬着；出现过一拍不匹配就作废，须等键真抬起再按。⛔ 同键位不同修饰键是故意允许的共存（只有完全相同才算冲突）。⛔ `pickerBusy` 期间丢弃 altHold 按下边沿。⛔ 「按一下」的键要进表并吞键。

**热键生效前提（0x0213）** —— 明细 O53
92 ⛔⛔⛔ 必备前提只两条：插件在位（`g_khPlug`）+ 布防（`g_khArmed`）。表内热键过 `kh_hk_sync` 与 `kh_poll_step`；钩子安装 = `bound ∧ plug ∧ armed`。⛔ 不进表的通路必须自己补布防门。⛔ `I_POLYALT` 故意不受布防约束。附加：`g_khSafeMode` 熔断期热键静默。

**Alt 落笔冻结（0x0214）** —— 明细 O54
93 ⛔⛔⛔ Alt 期间不**平滑**但可能把点**钉住**（立刻停改写 ⇒ PS 拿真实光标接滞后的圆心，那段差被画成直线并落第一个锚点）。`poly_hold_run()` 每包写同一点；抬笔那包仍写圆心；移开 >14 逻辑 px 或按住 >420ms 解冻补线。⛔ 只在 `g_strokeGate==1` 进场；⛔ 一轮只冻一次；⛔ 解冻后 `g_wasEnabled=0` 重锚（例外：Alt 松开且仍在一笔之中）。

**多边形角度吸附（0x0215–18）** —— 明细 O55–O58
94 ⛔⛔⛔ 多边形吸附的通道演化（0x0215→18，明细 refs O55–O58）：改 Wintab 包=看不见 ⇒ 改 `GetCursorPos` 返回值=仍看不见（样本证明方向已掰正）⇒ 改**鼠标消息**才生效。⛔ 教训：先定「PS 从哪读这个量」再写算法；「代码跑了」≠「用户看得见」。⛔ 吸附做在 `det_GetCursorPos`、**`tool_edit_allowed()` 之前**（POLYALT 硬否决在那里面）。`poly_proj()` 三路共用，⛔ 比值判定不调 `atan2`（水平 `|dy|/|dx|`、垂直 `|dx|/|dy|`、45° `||dy|−|dx||/(|dx|+|dy|)`，阈值 tan10°）。⛔ 吸附**接替**平滑（进/出置 `s_gpOn=0`），否则落差被追成反向斜线。附：临时多边形套索**第一次点击前没有折线预览**，只按住 Alt 移动无可吸附对象。
97 ⛔⛔⛔ 0x0218：`gcp`/包都改了仍看不见 ⇒ PS 折线读**鼠标消息**。挂 `DispatchMessageW` 导入表槽，进门之前改 `MSG.pt` + 由 pt 经 `ScreenToClient` 重算的 `lParam`，只碰 MOUSEMOVE/LBUTTONDOWN/LBUTTONUP（点击落点一起吸）；同批挂 `GetPhysicalCursorPos`（owner=2）。⛔ 锚点只能有一个推进者（`poly_owner_may_advance`）。判据：`[msg] … N 槽`、退出行「消息层 见/改」。
98 ⛔⛔⛔ 0x0219「只吸附一次」= 按钮电平被三路共用（且 `WM_MOUSEMOVE` 的 btn 恒 0）⇒ prev **按 owner 各记一份**、**被拒绝推进的 owner 连 prev 都不写**；包路径在消息路径活着时整体让位。判据：退出行「锚点推进 N 次」应 ≈ 点击数，吸附多而推进 0~1 = 边沿被吃。
99 ⛔⛔ 吸附参考线不并进 `cheapOk`（那串要「一笔之中 · 拉绳模式 · 包流」，逐点点击时笔常悬空）⇒ HUD 独立旁路 `poly_hint_live()`（主开关 ∧ POLYALT ∧ ≤150ms）且不受重现去抖；`polyHint` 时圆/绳/笔尖点都不画。
100 ⛔⛔⛔ 吸附「会话」只许被**真事件**收摊：`POLYALT` **连续归零 ≥250ms** 或主开关关。⛔ `tool_gate_ok()` 心跳过期（3s fail-closed）与 `POLYALT` 抖成 0 一拍（原生 20ms 镜像电平）都**只是瞬时抖动**，拿来 `exit()` 会销毁锚点，而重建只认「一笔之中」或「点击」⇒ 笔一悬空就**永久失效**（症状：头几秒能吸、转一圈回来不吸）。⇒ 工具闸门**值优先**（`TOOLGATE==1` 即认，过期只否本拍改写），归零抖动期间返回 0 正常透传（返回 1 会把套索钉住 250ms，更糟）。退出行必带「收摊原因」。附：参考线改画「锚点 → 吸附点」**整段**（用户要起点=折线起点），窗口中心取线段中点、边长按段长量化到 128 倍数、`hud_resize` 必须支持**缩小**（只增不减会停在 1024 白烧带宽）；段长超 `HUD_SIZE_MAX` 时中心退回吸附点——宁可丢起点不能丢终点。
101 ⛔⛔⛔ 冻结解冻（补线）把**折线起点**搬到光标，吸附锚点必须跟着搬：PS 从圆心补一条直线到光标，那条线算套索笔迹收尾，折线从光标处重新起。错误做法是建会话时一律 `s_pgAx = s_gpX`（= 圆心）——只对 why=1「立刻抬笔」正确。⇒ `poly_hold_run` 判出 why=2/3 时 `poly_anchor_push()` **解冻后下一包**的 raw（⛔ 不是判定解冻那一包，那包仍写圆心；批末则 `s_polyNeedAnchor` 留到下一批顶部取），轴 → 屏幕像素 `*px_x()`；`poly_snap_gcp` 在「会话已建立」支与「刚建立」支都要 `poly_anchor_take()`（会话在冻结期间就已建立），⛔「还没开始画」不许消费标志、「悬空第一次点击」要作废标志；`exit` 必须清标志与 `s_polyNeedAnchor`。判据：退出行「搬锚 N 次」> 0。
102 ⛔⛔⛔ 落笔瞬间**预览与落点是两条通道**：橡皮筋读鼠标消息（97 已证），而 PS 在笔落那一刻用 **Wintab 包**确认节点 ⇒ 只改预览会得到「预览在 A、节点落在 B」，PS 再从 A 补一根短直线到 B。⇒ 两处互补：`poly_pkt_click()` 把**接触第一包**（buttons 0→1，`s_pkBtnPrev`）坐标改成当前吸附点（屏幕 `/px` 回轴；⛔ 只改这一包，连续改会污染平滑重锚），以及接触期间 `s_pgClickHold` **锁定输出**在吸附点（移动 >20 逻辑 px 或接触结束才解除，0x0214 补线场景要能跟随）。⛔ 两者都以 `g_polyHintMs` 新鲜为前提。⛔ 搬锚时必须同步 `g_polyHintAx/Ay`，否则「搬了锚但这一拍没吸附」时参考线仍显示旧起点（1B 被判无效的原因之一）。判据：退出行「接触包改写 N 次」——N>0 但节点仍在真实位 ⇒ 包不是落点通道。
103 ⛔⛔⛔ **别猜 PS 读哪条通道：要钉就三条一起钉**（0x021D 实证 102 的四条错法）。① 解锁定长的基准必须是**落笔那一刻的真实光标**（`g_pgHoldRx/Ry`、`s_pkPinRx/Ry`）—— 拿锁定点当基准，因锁定点天生带吸附偏移 ⇒ 落笔即超距、锁当场自解（102 完全失效的直接原因）。② 接触是**独立共享电平** `g_pgTouch`（消息层按/抬 + 包层按包 + 光标层「物理键 ∨ 包新鲜」），⛔ 不许用「本条消息 `btn`」判接触（消息路径 btn 只在 LBUTTONDOWN 为 1，下一条 MOUSEMOVE 就是 0）。③ 事件类改写覆盖**整个接触区间**并含抬笔包（PS 取包线程有滞后，读的是更晚那包）；`poly_snap_run` 在 `g_pgHoldOn` 时整批让位。④ 冻结（93）也要三通道一致：`g_polyHoldX/Y`（屏幕像素）在冻结进场发布，`poly_snap_gcp` 的冻结分支放在「会话建立之后、吸附计算之前」（前者保锚点=圆心，后者跳过投影）——只钉包会回归「圆心→A 补线」。⑤ `POLY_TOUCH_OFF_GRACE_MS=100` 宽限：包层先清 0、`WM_LBUTTONUP` 后到，不宽限就把未钉住的点交给了抬笔那条消息。判据：退出行「接触锁定 N 次 / 解锁 N 次｜冻结打回 N 次」。
104 ⛔⛔⛔ 冻结钉的「圆心」必须**先验真身**（0x021E）。冻结点取自 `g_ox/g_oy`＝平滑**上一批**输出，而本机包流**高频断供**（`[dead] ★包流断供 … 已冻结 2625ms`；`[frz] 无包但仍在轮询 movedTot` 一路涨）——断供期间没有包 ⇒ `g_ox/g_oy` 一动不动，PS 却靠补流跟着光标走 ⇒ 按 Alt 钉住的是**很久以前那个输出点**，症状＝「圆心向正上方远处拉一条线，按住不抬再从远处补回光标」。⇒ 两道**只放弃不猜值**的闸：① 进场验 `|g_ox−批首raw|` 的屏幕距离 > `POLY_HOLD_ENTER_MAX_PX`(120 逻辑 px) ⇒ 本轮不冻结（`s_polyUsed=1` 透传，交主循环 `RST_ANCHOR` 把锚点搬到真实笔尖）；② 生效验（`poly_snap_gcp` 冻结分支）钉住点离真实光标 > `POLY_HOLD_SANE_PX`(260) 或超 `POLY_HOLD_STALE_MS`(820) ⇒ 停钉（同时兜住「没包就没人调 `poly_hold_finish` ⇒ 光标被永久钉死」）；③ `poly_hold_finish` 一并清 `g_polyHoldX/Y`，不留陈旧值。判据：退出行「冻结打回 N 次 / 拒绝 N 次」——拒绝数大即圆心陈旧；拒绝为 0 而现象照旧 ⇒ 另有源头。⚠️ `|g_ox−raw|` 只含平滑滞后（换算常量偏移在差值里抵消），所以这道闸能区分「陈旧」与「换算错」。

## 维护约定

超限先下沉 refs 再精简本文件（只留「编号 + 一句话 + refs 指针」）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ `PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，独立不许合并；Plug-ins 里的旧 .8li 直接覆盖不留备份（PS 锁文件，覆盖前必须完全退出 PS）。
