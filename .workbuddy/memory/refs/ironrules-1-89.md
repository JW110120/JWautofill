# JWautofill 铁律 1–89（从 MEMORY.md 下沉，编号不变）

> 触发场景：产物/构建、闸门/面板、HUD/画布、断流补流（17–38）、UXP/画笔预设（45–53）、混合器（54–64）、键盘钩子在位闸（65–70）、工具闸门/光标（71–73）、HUD 门控/临时吸管（74–80）、标准滤波/文案（81–83）、HUD 坐标系（84–86）、临时吸管键源（87–89）。

**产物/构建**
1 ⛔⛔ 除用户明确要求，禁 `git add`/`commit`；测试通过且用户发话才提交（代码+日志+记忆一次提交）。
2 ⛔⛔ IPC 双防御：`toWire()` 一律 Math.round，原生 `double?`+Round（漏=整条消息被丢）。
3 ⛔⛔ .8li：PiPL 头 10 字节；`'8664'` 导出名=C 字符串；版本走 `jw8li_version`（改 .c 必升）。
4 ⛔ `CFG_NLONGS` 现 61（0x0220 起）：两个 .c 同步改，新增槽后 fit-check 指到最后一个槽。
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

**断流/补流（17–38，论证 `lasso-smoothing.md` O22–O46）**
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

**UXP / 画笔预设** —— `uxp-api-layer.md`
45 ⛔⛔ `_obj` 只能来自跑通过的样本；-25920 = 命令名 PS 不认识。
46 ⛔⛔ `dialogOptions` 一律 `silent`（`dontDisplay` 反义）；只认描述符自己的 `_options`。
47 ⛔⛔ 改状态的动作，判据只能是「回读权威字段变了」；"没报错"等于没说。
48 ⛔⛔ 装笔=缓存整份 `currentToolOptions`（快路径 `set cto`，慢路径 define→参数→抓 cto→删预设）。
49 ⛔⛔⛔ `set` brush 的 `to` 必须带笔尖身份（否则变 `computedBrush`）；几何走 `set paintbrushTool to 整份 cto`。
50 ⛔⛔⛔ PS 27 换笔尖=`select + brush _name + makeVisible:false`；`set+brush`=-1715、`set+brushPreset`=-25920。
51 ⛔⛔⛔ 失败的 batchPlay 每条画一条黄条 ⇒ 正常路径 `failCount`=0；能读状态判的绝不试错。
52 ⛔⛔ 黄条归属：PS=一句话（「悦绘:」前缀）；`#1 … / #2 …`=面板 `.notify-bar`；`say()` 截 120 字两行。
53 ⛔⛔⛔ 判当前工具不能用 `get currentTool`（-25920）⇒ 指纹 `wetness`/`dryness`/`reservoirState`/`autoFill` ≥2。

**混合器浮雕笔（P3）** —— `brush-mixer-reservoir.md`
54 ⛔⛔⛔ 储层只能靠重新采样装填（像素 `{}`、get 报 -25920）；改前景色会灌成纯色；上色 JS 一步乘法，alpha 用覆盖度。
55 ⛔⛔⛔ 不存在「派发 AM 事件触发工具手势」（`loadBrush`/`cleanBrush`/`mixerBrushTool` 在 exe ID 表 0 命中）。
56 ⛔⛔ `canvasClick`：`alt:1` 装储层 / `alt:0` 验货（只单击无 drag）；Alt 先按住再按左键；卸载必须 `click_join`。
57 ⛔⛔⛔ 厚涂笔走储层：`mixer.pattern` ⇒ `applyBrush` 首部 return；⛔ 不能整段 `runAsModal`；吸前直径=图案长边；验货底不透明中灰。
58 ⛔⛔ 面板尺寸只认图案长边；`set` 的 `_target` 必须裸引用；直径回读被 PS 换算（400→407）。
59 ⛔⛔⛔ 原生 JSON 严格类型：`json_bool` 只认 `true`/`false`，数字一律 `json_num`；「发了就忘」必须 `xxxResult` + `waitHostMessage()`。
60 ⛔⛔⛔ 直径不靠 `set`（会抹 `sampledData`）⇒ `defineBrush(side² 白方块)`，直径=边长。
61 ⛔⛔⛔ 有位图 ≠ 装了图案（吸空白也 `state=2`）⇒ 点一笔看层次；储层尺寸=直径×1.4325。
62 ⛔⛔ 吸得准：`fitOnScreen` 把图像摆到视口正中；原生点「命中窗口中心」。
63 ⛔⛔ 笔尖落地顺序：现成方笔且直径对=零命令 → 按名选 → 整份 cto 改 `diameter` → `defineBrush`；改直径必须 `runAsModal` + `jsonSafe()`。
64 ⛔⛔ 笔尖尺寸不许降级：≠ 图案长边就抛错。

**键盘钩子·在位闸** —— `keyhook-8li.md`
65 ⛔⛔⛔ 三路统一过 `g_khPlug`：18923 无面板客户端 = 本体不在位 ⇒ 不装钩、不注册、轮询只消沿。⛔ 不做「连过一次就粘住」。
66 ⛔⛔ 迁移探测自报身份：`kh_try_migrate` 走 `path=/jw-migrate`，非 `/` 不计在位。
67 ⛔⛔⛔ WS 槽位必须真归还：`kh_cli_remove` 同时清 `closing`/`notPlugin`，`kh_cli_add` 准入只看 `s==INVALID_SOCKET`。
68 ⛔⛔ `SO_RCVTIMEO` 超时 ≠ 断开：首帧超时（`got==0 ∧ WSAETIMEDOUT`）返 `-2=空闲` ⇒ continue+ping。
69 ⛔⛔ 笔刷热键开关状态只在 `hotkeyArmStore.ts`（单例+`useSyncExternalStore`）；工具箱折叠是条件渲染；`store.error` 无 TTL。
70 ⛔⛔⛔ 平滑也要过位闸，判据是「已握手」不是「占槽」：`g_cliReady` 唯一在位判据；`plug_revoke()` 只清 enabled、不下 cmd=2、gate 置 2；宽限 1500ms。

**工具闸门 / 光标路径** —— O41–O43
71 ⛔⛔⛔ 只有 `GATETS 新鲜 ∧ TOOLGATE==0` 是事实 ⇒ 立即否决；心跳过期不许当换工具；收口 `tool_edit_allowed()`，包/光标共用。
72 ⛔⛔ `hostYield` 必须传 `maxHoldMs`（工具类 900ms 强制放行）。
73 ⛔⛔ 光标推进器抖动时钉住：松手后 `GP_HOLD_MS=700` 内返回平滑点；`s_gpBtn` 跟真实的手；大跳跃改「本拍不推进」。

**HUD 门控 / 临时吸管** —— O44–O47
74 ⛔ 临时吸管判定全在面板（工具模式 ∧ 总开关 ∧ 套索）；`altToolHold` 挡自动关，松开回套索后 `applyToolGate('lassoTool')` + `setMainToggle(true)` 兜底。
75 ⛔⛔⛔ `write_params()` 在 `pstool_owns()` 时一个字节都不写 `I_TOOLGATE` ⇒ 必须独立槽 `I_ALTTOOL`（反面判据：切吸管后 HUD 还在 = 借了闸门槽）。
76 ⛔⛔⛔ `I_ALTTOOL` 必须四处清 0：吸管键释放 / 键源卸载 / `plug_revoke` / `services_start`。
77 ⛔⛔ HUD 闪现只能从显示时机治：`CONTACT_HOLD_MS`(250) 不能删；「刚隐藏过的 1.5s 内须连续满足 180ms 才重现」；首次仍立即。
78 ⛔⛔ `!g_calib.valid` 提前 return 必须显式归零 `g_penDown`/`g_toolOk`/`g_strokeGate`。
79 ⛔⛔ 别想让 Alt 绕过 PS（吞键/伪造 `WM_SYSKEYUP` 都不行）⇒ 只能事后搬色。
80 ⛔⛔⛔ 「颜色没变」≠「没取色」：判据只能是「这一轮有没有左键」（`busyHadLeft`）；只有空格 ⇒ 不当取色。

**标准滤波 / 面板文案** —— O47
81 ⛔⛔⛔ 笔速必须用真实位移：`|raw − out|` 是滞后不是速度（会负反馈锁死 4~6px）；按 ≥6px 距离窗 / ≥4ms 窗时结算（`SPEED_WIN_PX/MS`）。
82 ⛔⛔ 尖角判据两级基准：参考方向由 ≥3px 线段推进、当前方向由 ≥2px 累积位移给出。
83 ⛔⛔⛔ 用户可见文案（`helpTexts.ts`）：汉字与字母/数字间半角空格；数字与 px/%/°/ms 不空、与「像素/度/级」空；区间「 – 」、减号「−」；⛔ 禁箭头/`**`/勾叉图标。全文规则在文件头。

**HUD 坐标系 / 消失** —— 0x020D–0x020F
84 ⛔⛔⛔ HUD 圆心不许绘在会漂的量上：拉绳未绷紧时复用上一帧窗口位置（用绘制点判）+ 整像素迟滞 `HUD_PX_HYST`；复用后绳末端不能由 `rx/ry` 反算。
85 ⛔⛔⛔ 两套坐标系混用不报错只变形：`putXc/putYc`=窗口左上角，圆心在 `(half,half)` ⇒ 光标相对圆心向量 = `cur − put − half`；判据 `rope=%d ≤ leashPx`。
86 ⛔⛔⛔ HUD 短暂消失只有三个源头（0x020F 已修）：① `realOk` 过期（宽限 1500ms，仅「一笔进行中且未接管合成包」）；② `lagSkip`/`bigJump` 不许并进 `cheapOk`（并进去就是 `SW_HIDE`）；③ 先 `HUD_HIDE_DEBOUNCE_MS`(90) 再 `HUD_RESURF_DEBOUNCE_MS`(180)，顺序错就是「小抖→大消失」。

**临时吸管键源（0x0210）** —— O44 / `keyhook-8li.md`
87 ⛔⛔⛔ 吸管键绝不能进热键匹配表（会被 RegisterHotKey 独占，键被摘走）⇒ `action=="altTool"` 只取 combo 发布 (vk,mods)，调度线程轮询、仍推 `altHold`。
88 ⛔⛔⛔ 键源默认 `/`（裸键）：`kh_combo_to_key` 必须允许无修饰键；解析只在配置线程做一次（`kh_key_to_token` 返回 static）。
89 ⛔⛔ 事后搬色只在触发键含 Alt 时才需要（`altToolComboHasAlt()`）。
