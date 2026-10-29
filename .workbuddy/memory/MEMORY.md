# JWautofill 项目记忆（主索引）

> 索引+铁律速查；**明细一律在 `refs/`，里程碑史在 `HISTORY.md`**。⛔ 违反必炸。
> 架构：平滑+键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。
> 现役 **0x0213**（阶段史查 HISTORY.md；01–0F 为合成点击/在位闸/掉线/位闸/让路/工具闸门/硬否决/`btn`/笔速/圆心防抖/绳向量/隐藏去抖）。
> 0x0210 = 临时吸管键源可重录（默认 `/`），见 87–89；0x0211 = 物理 Alt（PS 临时多边形套索）硬否决，见 90；
> 0x0212 = 前景色拾色器（默认 `Shift+/`）+ 按住键的修饰键完全匹配，见 91；0x0213 = 按住键补布防门，见 92。

## 索引

填充/描边/清除 `refs/fill-and-stroke.md`｜CSS/面板/主题 `refs/frontend-css.md`｜闸门/模态 `refs/busy-gate.md`｜UXP/API/性能 `refs/uxp-api-layer.md`｜像素算法 `refs/pixel-algorithms.md`｜构建/部署 `refs/toolchain-and-env.md`｜平滑/HUD/断流/工具闸门/吸管 `refs/lasso-smoothing.md`（O22–O53 全档）｜键盘钩子 `refs/keyhook-8li.md`｜混合器储层 `refs/brush-mixer-reservoir.md`

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查用 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`：@types/node 的 TS5 语法让语义检查被静默跳过，"零错"是假象）；改 .c 跑 `build.sh` 零告警 + 导出表 5 项；改面板 `yarn build`。全仓 ~168 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的行范围。

## 现役焦点（0x0212 · 2026-10-29）

「前景色拾色器」= 功能快捷键子面板「选区填充」区新条目（默认 `Shift+/`，`action == "pickColor"`），
**普通热键**（进表、RegisterHotKey 吞键、与工具模式无关、始终装载）；按下走 `utils/ColorPicker.pickForegroundColor()`。
它与按住键 `/` 的共存全靠原生 **91**。上一条 0x0211 见 **90**（物理 Alt 硬否决 `I_POLYALT`）。

## 铁律速查

**产物/构建**
1 ⛔⛔ 除非用户明确要求，禁止 `git add`/`commit`；测试通过且用户发话才提交（代码+日志+记忆一次提交）。
2 ⛔⛔ IPC 双防御：`toWire()` 一律 Math.round，原生 `double?`+Round（漏=整条消息被丢）。
3 ⛔⛔ .8li：PiPL 头 10 字节；`'8664'` 导出名=C 字符串；版本走导出表 `jw8li_version`（改 .c 必升）。
4 ⛔ `CFG_NLONGS=60`（0x0211 起）：`plugin_main.c` 与 `smooth_engine.c` 同步改，新增槽后 fit-check 指到最后一个槽。
5 ⛔ 日志：`.8li`→`%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log`；引擎→`%TEMP%\jwwh-<pid>.log`。
6 ⛔⛔ 卸载先全停引擎线程再返回：`jwwh_unhook()` 幂等+兜底 repatch；DETACH 只能 join。

**闸门/面板**
7 ⛔⛔ `'slct'` 三态只有 `2` 停轮询，同步三处；边沿无心跳⇒接管带 2s 时效；面板判据=原生 `gateOwned`。
8 ⛔ 闸门=`isPsBusy()`+文档闩锁+`psRead()`；禁采信 `core.isModal()`；空闲巡检 <3.3/s。
9 ⛔⛔ `psBusyInProc()` 三态禁并进 `isPsBusy()`；`-1` 绝不当 `0`。
10 ⛔⛔ 真相不靠心跳续命：面板发 `gateAge`，原生写 `I_GATETS=now−gateAge`。
11 ⛔⛔ HUD=显式 AND 门：窗口在·包流·套索∧接触·一笔之中·前台·焦点在画布·落笔判据·非断流·拉绳·面板 bit0·总开关。
12 ⛔⛔ HUD 门槛不门救援：救援用宽判 `canvas_hit_ok` 不看前台；HUD 用严判。
13 ⛔ 改宿主的开关外置 `wtctx.ini`（缺=只观测）；`cursorInject` 缺省 1。

**HUD/画布**
14 ⛔⛔ 拉绳定长 `f=1−rope/dist`，1px+二次贝塞尔；HUD 保留 `WS_EX_TRANSPARENT`，`WS_EX_TOPMOST` 写进 CreateWindowExW。
15 ⛔⛔ 悬链垂度只加重力方向：`cqy=my+2·sag·hor`，`hor=|dx|/d`。
16 ⛔ px 权威=屏幕/lcOutExt 非 lcInExt；像素常量×`dpiS`；`putPixels` 默认 replace=true。

**断流/补流（17–38，逐条论证查 `refs/lasso-smoothing.md` O22–O46）**
17–21 判读：对 Wintab 只读不写；「没开始画」≠「断流」（零真包看 `[boot]`）；停摆⇔PS 失前台（`fg=`）；`k==0`≠驱动恢复；LNP 在环≠方案。
22–26 边界：安全窗≠接触判据（`SYNTH_TIP_MAX_MS=6000` vs `CONTACT_HOLD_SMOOTH_MS=1500`）；⛔ 不用 VK_LBUTTON 电平当抬笔证据；空档期落笔只由包外证据定且只加不减；PS 自关 Wintab 不重开。
27–32 通路：三路输入只钩一条等于没有（Wintab+光标+Ink）；节拍=PS 查询同拍（外推限幅 40ms）；标定分层 n≥3/n==2/n<2；起笔锚定只看 buttons 逐包 0→1；`BTN_EDGE_MIN_ZERO=16 包`。
33–38 自证：系统光标与 Wintab 同源；Ink 判死 `[ink]=0`；输出不绑包（`gp_step()` 每查询推一步，`sAge<=300` 是自锁）；超 6s 靠「包外按钮电平+画布内+1.5s 内动过」三条；交还驱动必须 `g_btnResync`；⛔⛔ **「包流健康」≠「PS 在用包画」**：判据=`armed`，验证=`[raw] gp=` 一直涨。

39 ⛔⛔ 键盘热键必须双路：LL 钩子在 PS 前台整段收不到键 ⇒ `GetAsyncKeyState` 10ms 轮询兜底；`只有轮询涨=键没进钩子链`。
40 ⛔⛔ 钩子活性看**阳性证据**：`轮询有增量 ∧ 钩子零增量`⇒`g_khReinstall`（3/10/30s 退避，录制中不重装）；`kh_dual_mark` 只由钩子路径写。
41 ⛔⛔ unload 必须让引擎**哑火**：`services_stop`→`jwwh_set_engine_off(1)`；⛔ 不用 `jwwh_unhook()`（不可逆）；光标 `armed` 必须含 `tool_gate_ok()`。
42 ⛔⛔ PS 侧回调必须真注销：`pstool.c` 的 `s_basic` 只声明不赋值 ⇒ `pstool_uninstall()` 恒 return（判据：grep `s_basic =`）。
43 ⛔⛔ LL 钩子先摘再 join：`keyhook_stop()` 在任何 join 前 `kh_unhook_both_now()`，join 后补一次。
44 ⛔⛔ DETACH 日志先落再停服：排查关闭崩溃三步 → `pipl.log` 的 `DLL_PROCESS_DETACH` → `dumps\crash-*.dmp` → WER 故障模块。

**UXP / 画笔预设** —— 全档 `refs/uxp-api-layer.md`
45 ⛔⛔ `_obj` 只能来自"录到过/跑通过"的样本：-25920 = 命令名 PS 不认识。
46 ⛔⛔ `dialogOptions` 一律 `silent`（`dontDisplay` 是「出错时仍显示 UI」）；只认描述符自己的 `_options`。
47 ⛔⛔ **改状态的动作，判据只能是「回读权威字段变了」；"命令没报错"等于什么都没说。**
48 ⛔⛔ 装笔 = 缓存整份 `currentToolOptions`（快路径 `set cto`，慢路径 define→参数→抓 cto 存盘→删预设）。
49 ⛔⛔⛔ `set` brush 的 `to` 必须带笔尖身份（否则变 `computedBrush`）；几何走 `set paintbrushTool to 整份 cto`。
50 ⛔⛔⛔ PS 27 换笔尖 = `select + brush _name + makeVisible:false`；`set+brush`=-1715、`set+brushPreset`=-25920。
51 ⛔⛔⛔ **失败的 batchPlay 每条都画一条黄条** ⇒ 正常路径 `failCount` 必须 0；能用「读状态」判的绝不用「试一下会不会报错」判。
52 ⛔⛔ 黄条归属：PS=一句话（前缀「悦绘:」）；`#1 … / #2 …` 拼接=面板 `.notify-bar`。状态条只能一句话（`say()` 截 120 字 + 两行 clamp）。
53 ⛔⛔⛔ 判"当前工具"不能用 `get currentTool`（27 必报 -25920）⇒ 用指纹字段（`wetness`/`dryness`/`reservoirState`/`autoFill` 命中≥2）。

**混合器浮雕笔（P3）** —— 11 条全档在 `refs/brush-mixer-reservoir.md`（编号与 refs 一致）
54 ⛔⛔⛔ 储层只能靠「重新采样」装填：像素恒 `{}`、单独 get 报 -25920 ⇒ 写不进；改前景色会把储槽灌成纯色。上色在 JS 一步乘法，alpha 用**覆盖度**不是亮度。
55 ⛔⛔⛔ 「派发 AM 事件触发工具手势」不存在（`loadBrush`/`cleanBrush`/`mixerBrushTool` 在 exe ID 表 0 命中）。
56 ⛔⛔ 合成点击 `canvasClick`：`alt:1` 装储层 / `alt:0` 验货（**只单击无 drag**）；Alt 必须先按住再按左键；卸载必须 `click_join`。
57 ⛔⛔⛔ 厚涂笔走混合器储层：`mixer.pattern` ⇒ `applyBrush` 首部 `return`；⛔ 整段不能包一个 `runAsModal`（模态里 Alt+点被吞却全绿）；吸前直径=图案长边；验货底必须**不透明中灰**。
58 ⛔⛔ 面板尺寸只认图案长边；⛔ `set` 的 `_target` 必须**裸引用**；直径回读会被 PS 换算（400→407）。
59 ⛔⛔⛔ 原生 JSON 助手是严格类型：`json_bool` 只认 `true`/`false`，数字一律 `json_num`；"发了就忘"的消息必须有 `xxxResult` 回执 + `waitHostMessage()`。
60 ⛔⛔⛔ 直径不能靠 `set`：`set brush` 会抹掉 `sampledData`（方形变计算圆笔）⇒ `defineBrush(side² 白方块)`，直径天生=边长。
61 ⛔⛔⛔ 验货判据链：有位图 ≠ 装了图案（吸空白也 `state=2`）⇒ 只能点一笔看层次；储层尺寸=直径 × **1.4325**。
62 ⛔⛔ 吸得准两条前提：`fitOnScreen` 把图像摆到视口正中；原生**点的是「命中窗口中心」**（不是主框客户区中心）。
63 ⛔⛔ 笔尖身份落地顺序：现成方笔且直径对=零命令 → 按名选方笔 → 整份 cto 改 `diameter` → `defineBrush` 新建。⛔ 改直径必须包 `runAsModal` **且**先 `jsonSafe()`；defineBrush 前必须真 `putPixels` 白像素。
64 ⛔⛔ 笔尖尺寸不许降级：笔尖 ≠ 图案长边就抛错，**绝不把图案缩到笔尖尺寸**。

**键盘钩子·插件在位闸** —— 明细 `refs/keyhook-8li.md`
65 ⛔⛔⛔ 键盘钩子三路统一过 `g_khPlug`：18923 无面板客户端 = 插件本体不在位 ⇒ 不装钩、不注册、轮询只消沿。⛔ 不做「连过一次就粘住」。
66 ⛔⛔ 迁移探测必须自报身份：`kh_try_migrate` 走 `path=/jw-migrate`，非 `/` 不计在位；面板裸连即 `/`。
67 ⛔⛔⛔ WS 客户端表槽位必须真归还：`kh_cli_remove` 同时清 `closing`/`notPlugin`，`kh_cli_add` 准入只看 `s==INVALID_SOCKET`（否则 8 格用完永远「未连接」）。
68 ⛔⛔ `SO_RCVTIMEO` 超时 ≠ 断开：首帧 recv 超时（`got==0 ∧ WSAETIMEDOUT`）返 `-2=空闲` ⇒ continue+ping；只有「读到半帧才超时」算错误。
69 ⛔⛔ 笔刷热键开关状态只在 `hotkeyArmStore.ts`（单例+`useSyncExternalStore`）；工具箱折叠是条件渲染，开关寄生在内容组件里会随折叠消失。`store.error` **无 TTL**。
70 ⛔⛔⛔ 平滑也要过位闸，判据是「已握手」不是「占槽」：`g_cliReady` 是唯一在位判据；三路同过闸；`plug_revoke()` 只清 enabled、不下 cmd=2、gate 置 **2**；宽限 1500ms。⛔ 握手只拒**精确 `/jw-migrate`**。

**工具闸门 / 光标路径** —— 明细 `refs/lasso-smoothing.md` O41–O43
71 ⛔⛔⛔ 工具闸门拆「事实」与「没来得及报」：只有 `GATETS 新鲜 ∧ TOOLGATE==0` 是事实 ⇒ 立即否决；心跳过期**不许**当换工具。判据收口 `tool_edit_allowed()`，**包路径与光标路径共用**。
72 ⛔⛔ 正确性判据的巡检不许无限期让路：`hostYield` 必须传 `maxHoldMs`（工具类 900ms 强制放行）。
73 ⛔⛔ 光标推进器抖动时钉住不透传：松手后 `GP_HOLD_MS=700` 内返回平滑点；`s_gpBtn` 跟**真实的手**；大跳跃改「本拍不推进」。

**HUD 门控 / 临时吸管取色** —— 明细 `refs/lasso-smoothing.md` O44–O47
74 ⛔ 临时吸管判定全在面板（工具模式 ∧ 总开关 ∧ 套索）；`altToolHold` 挡自动关，松开回套索后 `applyToolGate('lassoTool')` 乐观回绿 + `setMainToggle(true)` 兜底。
75 ⛔⛔⛔ 面板写工具闸门有时无效：`write_params()` 在 `pstool_owns()` 时**一个字节都不写** `I_TOOLGATE` ⇒ 必须开**独立槽** `I_ALTTOOL`（反面判据：切到吸管 HUD 还在 = 借了闸门槽）。
76 ⛔⛔⛔ `I_ALTTOOL` 必须四处清 0：吸管键物理松开 / 键源被卸载（0x0210 新增）/ `plug_revoke` / `services_start`。漏一处 = 残留 1 = 平滑整段失效**且界面看不出原因**。
77 ⛔⛔ HUD 闪现只能从「显示时机」治：`CONTACT_HOLD_MS`(250ms) 不能删；「刚隐藏过的 1.5s 内须连续满足 180ms 才重现」；首次仍立即。
78 ⛔⛔ `!g_calib.valid` 提前 return 必须显式归零 `g_penDown`/`g_toolOk`/`g_strokeGate`。
79 ⛔⛔ 别想「让 Alt 绕过 PS」（吞键/伪造 `WM_SYSKEYUP` 都不可行）⇒ 唯一确定做法是**事后搬色**。
80 ⛔⛔⛔ **「颜色没变」≠「没取色」**：判据只能是输入事实「这一轮有没有**左键**」（`hostBusy` 的 `btn` → `busyHadLeft`）；只有空格 ⇒ 不当取色。

**标准模式滤波 / 面板文案** —— 明细 `refs/lasso-smoothing.md` O47
81 ⛔⛔⛔ 笔速必须用**真实位移**：`|raw − out|` 是**滞后**不是速度（拿它算会负反馈，滞后被锁死在 4~6px）。现按「≥6px 距离窗 / ≥4ms 窗时」结算（`SPEED_WIN_PX/MS`）。判据：真机 `[stroke] 平均滞后` 必须随强度变。
82 ⛔⛔ 尖角判据必须**两级基准**：参考方向由 ≥3px 线段推进、当前方向由 ≥2px 累积位移给出（单包 >3px 在 205Hz 下永不成立；去掉基线则每帧判拐角 ⇒ `kk` 抬到 0.75）。
83 ⛔⛔⛔ **用户可见文案**（`helpTexts.ts` 等）：① 汉字与字母/数字之间一个半角空格；② 数字与 px/%/°/ms 不空、与「像素/度/级」空；③ 区间「 – 」、减号用「−」；④ ⛔ 禁用箭头（→）、`**` 强调、勾叉星形等图标 —— UXP 的 `title` 是纯文本，缺字形就是方块。全文规则在该文件头部。

**HUD 坐标系 / 消失** —— 明细 `refs/lasso-smoothing.md` 的 0x020D–0x020F
84 ⛔⛔⛔ HUD 圆心不许绘在「会漂的量」上：拉绳未绷紧时绘制点被冻住 ⇒ 复用上一帧窗口位置（用**绘制点**判）+ 整像素迟滞 `HUD_PX_HYST`；位置复用后绳末端**不能**由 `rx/ry` 反算（会自己抖、还与光标脱开）。
85 ⛔⛔⛔ HUD 里两套坐标系混用不报错、只变形：`putXc/putYc`=**窗口左上角**，圆心在窗内 `(half,half)` ⇒ 光标相对圆心的向量 = `cur − put − half`。漏减 half ⇒ `vlen≈175 > leashPx` ⇒ 绳成直棍。判据：日志 `rope=%d` ≤ `leashPx`。
86 ⛔⛔⛔ HUD「短暂消失又出现」只有三个源头（0x020F 已修）：① `realOk` 过期（宽限 `HUD_REAL_SLACK_MS`=1500，仅「一笔中进行且未接管合成包」）；② `lagSkip`/`bigJump` 不许并进 `cheapOk`（并进去就是 `ShowWindow(SW_HIDE)`）；③ 先 `HUD_HIDE_DEBOUNCE_MS`(90ms) 才轮到 `HUD_RESURF_DEBOUNCE_MS`(180ms)，顺序错就是「小抖→大消失」。排查先看隐藏行的 `ck/cv/gate/stroke/penDown` 与 `real=%ldms`。

**临时吸管键源（0x0210）** —— 明细 `refs/lasso-smoothing.md` O44 / `refs/keyhook-8li.md`
87 ⛔⛔⛔ 吸管键**绝不能进热键匹配表**：进去就被 RegisterHotKey 注册成本系统独占热键（带修饰键时）⇒ 键被从输入队列摘走，PS 收不到、`GetAsyncKeyState` 的「按住」也失去意义；且命中会广播一次 hit 被当成功能触发。⇒ `kh_map_apply` 里 `action=="altTool"` 只取 combo 发布成 (vk, mods)，调度线程轮询电平、仍推 `altHold`（消息名不变）。
88 ⛔⛔⛔ 键源默认 `/`（裸键）：`kh_combo_to_key` 必须允许无修饰键（`kh_combo_to_hotkey` 才要求有）；解析只在配置线程做一次 —— `kh_key_to_token` 返回 static 缓冲，放进 20ms 循环会与钩子线程抢内存。
89 ⛔⛔ 换键源后「事后搬色」只在**触发键含 Alt** 时才需要（`altToolComboHasAlt()`）：默认 `/` 不含 Alt 时 PS 的吸管单击本来就取前景色，多搬一次只会插一次模态抢宿主主线程。

**PS 临时模式（0x0211）** —— 明细 `refs/lasso-smoothing.md` O51
90 ⛔⛔⛔ **「PS 临时模式」不派发任何可观测的变更**：套索下按 Alt 切多边形套索时 `application.tool` 仍是 `lassoTool`（图标不变）、无通知、无 `'slct'` ⇒ 面板闸门 / 巡检全看不出 ⇒ 引擎照常改写 ⇒ 折线预览抖、点击处 HUD 闪。真相只有原生有：`GetAsyncKeyState(VK_MENU) ∧ 前台是本进程` ⇒ 独立槽 `I_POLYALT`，keyhook 每 20ms **镜像**电平（⛔ 不是边沿：被别处清 0 会永久停）。⛔ 不许与 `I_ALTTOOL` 合槽（面板意图 vs 原生事实，会互清）；HUD `gateOk` 必须单独再压一次（`g_toolOk` 标定失效时会冻在 1）。

**按住键 vs 同键位热键（0x0212）** —— 明细 `refs/lasso-smoothing.md` O52
91 ⛔⛔⛔ 「按住」判定必须**修饰键完全匹配 + 一次性起按准入**：旧写法只查 combo 里**列出的**修饰键按着没 ⇒ 裸键 `/` 等于什么都没查 ⇒ 按 `Shift+/` 开拾色器时同时触发临时吸管。① 没列出的修饰键必须抬着；② 只加完全匹配还不够（Shift 比 `/` 先松/后按会剩一拍「键按着 ∧ 无修饰键」）⇒ 出现过一拍不匹配就作废，必须等键真的抬起再按；③ 起按再**连两拍确认**（≈40ms），杀掉两键几乎同时按下时先落地那个键的单拍误判。⛔ 同键位、修饰键不同是**故意允许**的共存（`Shift+/` 与裸 `/`），只有**完全相同**的组合键才算冲突（面板录制时拦住、工具模式关着时用记忆值 `getAltToolCombo()` 兜底）。⛔ 拾色器是宿主模态框：`pickerBusy` 期间**丢弃 altHold 的按下边沿**（松开照常放行），否则对话框背后会切工具。⛔ 「按一下」的键要**进表并吞键**（漏给 PS 会触发它自己的绑定），与按住键的「不进表」正相反。

**热键生效前提（0x0213）** —— 明细 `refs/lasso-smoothing.md` O53
92 ⛔⛔⛔ 快捷键必备前提只有两条：**插件在位**（`g_khPlug`）+ **布防**（`g_khArmed`）。表内热键两道门都过：`kh_hk_sync`（RegisterHotKey）与 `kh_poll_step`（轮询兜底）；钩子安装 = `bound ∧ plug ∧ armed`。⛔ **不进表的通路必须自己补布防门**：临时吸管的按住键走调度线程电平轮询，绕过前两处 ⇒ 总开关关着照样切吸管（0x0213 修）。新增任何「不走 map」的输入通路（按住键/手势/轮询特例）先问「过没过 `g_khArmed`」。⛔ `I_POLYALT` **故意不受布防约束**（PS 原生 Alt 的事实，与热键开关无关）。附加（非用户开关）：`g_khSafeMode` 熔断期间热键全静默。

## 维护约定

超限先下沉 refs 再精简本文件（本文件只留「编号 + 一句话结论 + refs 指针」，推导过程写 refs）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ 数据目录：`PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，两者独立**不许合并**；Plug-ins 里的旧 .8li 直接覆盖、**不留备份**（PS 运行时锁文件 ⇒ 覆盖前必须完全退出 PS）。
