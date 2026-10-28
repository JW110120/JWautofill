# JWautofill 项目记忆（主索引）

> 索引+铁律速查；明细在 `refs/`，里程碑史在 `HISTORY.md`。⛔ 违反必炸。
> 架构：平滑+键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。
> 现役 **0x020E**（阶段史查 HISTORY.md）：0x0201–04 合成点击｜0x0205 键盘在位闸｜0x0206 热键掉线｜0x0207 平滑过位闸｜0x0208 hostBusy 让路｜0x0209 工具闸门事实化+Alt 吸管｜0x020A `I_ALTTOOL` 硬否决+事后搬色｜0x020B hostBusy `btn`（吸同色）｜0x020C 真实笔速+尖角两级基准｜0x020D HUD 圆心防抖｜0x020E 绳向量补 half。

## 索引

填充/描边/清除 `refs/fill-and-stroke.md`｜CSS/面板/主题 `refs/frontend-css.md`｜闸门/模态 `refs/busy-gate.md`｜UXP/性能 `refs/uxp-api-layer.md`｜像素算法 `refs/pixel-algorithms.md`｜构建/部署 `refs/toolchain-and-env.md`｜平滑/HUD/断流/工具闸门 `refs/lasso-smoothing.md`｜键盘钩子 `refs/keyhook-8li.md`｜**混合器储层 `refs/brush-mixer-reservoir.md`（54–64 全档）**

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查用 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`：@types/node 的 TS5 语法让语义检查被静默跳过，"零错"是假象）；改 .c 跑 `build.sh` 零告警 + 导出表 5 项；改面板 `yarn build`。全仓 ~143 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的文件。

## 铁律速查

**产物/构建**
1 ⛔⛔ 除非用户明确要求，禁止 `git add`/`commit`；测试通过且用户发话才提交（代码+日志+记忆一次提交）。
2 ⛔⛔ IPC 双防御：`toWire()` 一律 Math.round，原生 `double?`+Round（漏=整条消息被丢）。
3 ⛔⛔ .8li：PiPL 头 10 字节；`'8664'` 导出名=C 字符串；版本走导出表（`jw8li_version`）。
4 ⛔ `CFG_NLONGS=59`（0x020A 起）：`plugin_main.c` 与 `smooth_engine.c` 同步改。
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

**断流/补流（17–38，全档 `refs/lasso-smoothing.md` O22–O46）**

17–21 判读：对 Wintab 只读不写；`[stall]`−`[dead]` 差集；「没开始画」≠「断流」（零真包用 `[boot]`，首条 `[stall]★` 前必见 `[boot]`）；停摆⇔PS 失前台（`fg=` 固化现场）；`k==0`≠驱动恢复；LNP 在环≠方案（字节级丢 `WTQueueSizeSet/WTEnable/WTPacketsPeek/WTDataGet/WTSet`）。
22–26 边界：安全窗≠接触判据（`SYNTH_TIP_MAX_MS=6000` vs `CONTACT_HOLD_SMOOTH_MS=1500`）；⛔ 不用 VK_LBUTTON 电平当抬笔证据；代投按拍节流、不挂光标/画布（`cv=0` 转冻结）；空档期落笔只由包外证据定且只加不减（`WH_MOUSE_LL`）；PS 自关 Wintab 不重开（`[ctx] WTClose` 后无 `WTOpenW`）。
27–32 通路：三路输入只钩一条等于没有（Wintab 包+系统光标+Ink；钩 SetCursor 不钩 SetCursorPos）；节拍=PS 查询同拍（外推限幅 40ms）；标定分层 n≥3/n==2/n<2（`WTPacketsPeek` 只读）；`user32` 走 IAT；起笔锚定只看 buttons 逐包 0→1（`落`>1≠抖动）；`BTN_EDGE_MIN_ZERO=16 包`（真抬笔≥260ms）。
33–38 自证：系统光标与 Wintab 同源（笔停则冻）；Raw Input 被吞；Ink 判死 `[ink]=0`；断流第二问「光标动不动」；输出不绑包（`gp_step()` 每查询推一步，`sAge<=300` 是自锁）；超 6s 用包外按钮电平+画布内+1.5s 内动过⇒tip=1（缺一不可）；交还驱动必须 `g_btnResync`；⛔⛔ **「包流健康」≠「PS 在用包画」**：判据=`armed`（cursorInject∧cfg[ENABLED]∧笔按着），笔抬着全透传，验证=`[raw] gp=` 一直涨。

39 ⛔⛔ 键盘热键必须双路：LL 钩子在 PS 前台整段收不到键 ⇒ `GetAsyncKeyState` 10ms 轮询兜底；`只有轮询涨=键没进钩子链`。
40 ⛔⛔ 钩子活性看**阳性证据**：`轮询有增量 ∧ 钩子零增量`⇒`g_khReinstall`（3/10/30s 退避，录制中不重装）；`kh_dual_mark` 只由钩子路径写。
41 ⛔⛔ unload 必须让引擎**哑火**：`services_stop`→`jwwh_set_engine_off(1)`；⛔ 不用 `jwwh_unhook()`（不可逆）；光标 `armed` 必须含 `tool_gate_ok()`。
42 ⛔⛔ PS 侧回调必须真注销：`pstool.c` 的 `s_basic` 只声明不赋值 ⇒ `pstool_uninstall()` 恒 return（判据：grep `s_basic =` 必有赋值）。
43 ⛔⛔ LL 钩子先摘再 join：`keyhook_stop()` 在任何 join 前 `kh_unhook_both_now()`，join 后补一次。
44 ⛔⛔ DETACH 日志先落再停服：排查关闭崩溃三步 → `pipl.log` 的 `DLL_PROCESS_DETACH` → `dumps\crash-*.dmp` → WER 故障模块。

**UXP / 画笔预设**
45 ⛔⛔ `_obj` 只能来自"录到过/跑通过"的样本：-25920 = 命令名 PS 不认识。全选=`set`+`channel.selection`→`allEnum`。
46 ⛔⛔ `dialogOptions` 一律 `silent`（`dontDisplay` 是「出错时仍显示 UI」）；只认描述符自己的 `_options`。
47 ⛔⛔ **改状态的动作，判据只能是「回读权威字段变了」；"命令没报错"等于什么都没说。**
48 ⛔⛔ 装笔 = 缓存整份 `currentToolOptions`：快路径 `set cto`，慢路径 define→参数→抓 cto 存盘→删预设（`psState.ts`）。
49 ⛔⛔⛔ `set` brush 的 `to` 必须带笔尖身份：只给几何键 ⇒ PS 换成 `computedBrush`（软边喷枪）。判据以 `sampledData` 为准；几何走 `set paintbrushTool to 整份 cto`。
50 ⛔⛔⛔ PS 27 换笔尖 = `select + brush _name + makeVisible:false`（`MkVs` = 应用 vs 只高亮）。`set+brush`=-1715、`set+brushPreset`=-25920；`brushes`/`presetManager` 是惰性快照，判不了删除成败。
51 ⛔⛔⛔ **失败的 batchPlay 每条都画一条黄条** ⇒ 正常路径 `failCount` 必须 0；能用「读状态」判的绝不用「试一下会不会报错」判，探测加会话级形态记忆。
52 ⛔⛔ 分清黄条是谁画的：PS=一句话（前缀「悦绘:」）；`#1 … / #2 …` 拼接整段=面板 `.notify-bar`。状态条只能一句话（`say()` 截 120 字 + 两行 clamp）。
53 ⛔⛔⛔ 判"当前是哪个工具"不能用 `get currentTool`（27 必报 -25920）⇒ 用指纹字段（`wetness`/`dryness`/`reservoirState`/`autoFill` 命中≥2）；dump 环检测只能用祖先链 `stack.includes(v)`。

**混合器浮雕笔（P3，进行中）** —— 明细全在 `refs/brush-mixer-reservoir.md`
54 ⛔⛔⛔ 储层只能靠「重新采样」装填：像素恒 `{}`、单独 get 报 -25920 ⇒ 写不进；改前景色会把储槽灌成纯色。上色在 JS 一步乘法，alpha 用**覆盖度**不是亮度。
55 ⛔⛔⛔ 「派发 AM 事件触发工具手势」不存在（手势不派通知；`loadBrush`/`cleanBrush`/`mixerBrushTool` 在 exe ID 表 0 命中）。
56 ⛔⛔ 合成点击 `canvasClick`：`alt:1` 装储层 / `alt:0` 验货（0x0204 起**只单击无 drag**）。Alt 必须先按住再按左键（PS 在 mouse down 读键态）；卸载必须 `click_join`。
57 ⛔⛔⛔ 厚涂笔走混合器储层：`mixer.pattern` ⇒ `applyBrush` 首部 `return`（defineBrush+cto 链空置但保留）。① 整段不能包一个 `runAsModal`（模态里 Alt+点被吞却全绿）；② 吸前直径=图案长边；③ 验货底必须**不透明中灰**。
58 ⛔⛔ 面板尺寸只认图案长边（`library.ts` 读 PNG 头填 `mixerSize`）。⛔ `set` 的 `_target` 必须**裸引用**（带 `_enum:"ordinal"` 或 `set property currentToolOptions` ⇒「命令"设置"当前不可用」）；直径会被 PS 换算（400→407）⇒ 只看回读值。
59 ⛔⛔⛔ 原生 JSON 助手是严格类型：`json_bool` 只认 `true`/`false`，数字 `1` 静默失败 ⇒ 数字一律 `json_num` 判非零；"发了就忘"的消息必须有 `xxxResult` 回执 + `waitHostMessage()` 核对。
60 ⛔⛔⛔ 直径不能靠 `set`，尺寸由笔尖自己带：`set brush` 会抹掉 `sampledData`（方形变计算圆笔）⇒ `defineBrush(side² 白方块)`，直径天生=边长。
61 ⛔⛔⛔ 验货判据链：有位图 ≠ 装了图案（吸空白也 `state=2`）⇒ 只能点一笔看层次；储层尺寸=直径 × **1.4325**。
62 ⛔⛔ 吸得准两条前提：`fitOnScreen` 把图像摆到视口正中（`actualPixels` 只改缩放不动滚动）；原生**点的是「命中窗口中心」不是主框客户区中心**（0x0204：后者在 3840 屏偏右 287px）。
63 ⛔⛔ 笔尖身份落地顺序：现成方笔且直径对=零命令 → 按名选方笔（名字含「方」，**数字优先匹配目标尺寸**）→ 整份 cto 改 `diameter` → `defineBrush` 新建「方形400」。⛔ 改直径必须包 `runAsModal` **且**下发前 `jsonSafe()` 剔 `ArrayBuffer`/TypedArray；defineBrush 前必须真 `putPixels` 白像素（`documents.add(fill:'white')` 不算）。
64 ⛔⛔ 笔尖尺寸不许降级：笔尖 ≠ 图案长边就抛错让人修，**绝不把图案缩到笔尖尺寸**（临时画布会小于图案，且丢分辨率）。

**键盘钩子·插件在位闸（0x0205）** —— 明细 `refs/keyhook-8li.md` N9
65 ⛔⛔⛔ 键盘钩子三路统一过 `g_khPlug`（LL 安装意图 / 键态轮询 / RegisterHotKey 同步）：18923 无面板客户端 = 插件本体不在位 ⇒ 不装钩、不注册、轮询只消沿。⛔ 不做「连过一次就粘住」；断开即卸钩放行。
66 ⛔⛔ 迁移探测必须自报身份：`kh_try_migrate` 走 `path=/jw-migrate`，非 `/` 记 `notPlugin` 不计在位——否则多开 PS 时探测会给持有端伪造在位。面板裸连即 `/`。
67 ⛔⛔⛔ WS 客户端表槽位必须真归还（0x0206）：`kh_cli_remove` 同时清 `closing`/`notPlugin`，`kh_cli_add` 准入只看 `s==INVALID_SOCKET`。旧写法每次断开永久废一格 ⇒ 8 格用完新连接全拒 ⇒ 面板永远「未连接」（判据：`pi8li.log`「客户端表已满」）。
68 ⛔⛔ `SO_RCVTIMEO` 超时 ≠ 断开（0x0206）：首帧 recv 超时（`got==0 ∧ WSAETIMEDOUT`）返 `-2=空闲` ⇒ 循环 continue+ping；只有「读到半帧才超时」算错误。旧写法让面板空闲 60s 被踹一次 = 断连循环。
69 ⛔⛔ 笔刷热键开关状态不在分区组件里：`hotkeyArmStore.ts`（单例+`useSyncExternalStore`）是唯一真相；工具箱折叠是条件渲染，开关寄生在内容组件里会随折叠消失。`store.error` **无 TTL**，只由「连接恢复/成功布防撤防」清。
70 ⛔⛔⛔ 平滑也要过位闸，判据是「已握手」不是「占槽」（0x0207）：`I_ENABLED` 会残留 1，`pstool_owns()` 只是进程内 `'slct'` 活性、**与面板加载无关** ⇒ 相乘就凭空生效。⇒ `g_cliReady`（握手成功才 ++）是唯一在位判据；三路同过闸；`plug_revoke()` 只清 enabled、不下 cmd=2、gate 置 **2**；宽限 1500ms。⛔ 握手只拒**精确 `/jw-migrate`**（"非 / 就拒"会锁死真面板）。

**工具闸门 / 光标路径（0x0209）** —— 明细 `refs/lasso-smoothing.md` O41–O43
71 ⛔⛔⛔ 工具闸门拆「事实」与「没来得及报」：只有 `GATETS 新鲜 ∧ TOOLGATE==0` 是事实 ⇒ 立即否决（闩锁压不住）；心跳过期**不许**当换工具（否则一笔之中每 3s 被劈，PS 画出「圆心→笔尖」直线）。判据收口 `tool_edit_allowed()`，**包路径与光标路径共用**（分叉 ⇒ HUD 在圆心、选区末端在笔尖）。
72 ⛔⛔ 正确性判据的巡检不许无限期让路：`hostYield` 必须传 `maxHoldMs`（工具类 900ms 强制放行）。笔尖落笔会模拟左键 ⇒ 长按绘画时让路永不结束 ⇒ `TOOLGATE` 冻在切走前的 1。
73 ⛔⛔ 光标推进器抖动时钉住不透传：任一拍判"没按着"就返回真实坐标 ⇒ 那一拍就是一条直线。⇒ 松手后 `GP_HOLD_MS=700` 内返回平滑点；`s_gpBtn` 跟**真实的手**（否则抬笔再落笔永远没有边沿）；大跳跃改「本拍不推进」，不贴合。
74 ⛔ Alt 临时吸管（0x0209）：原生只推 `altHold` 边沿（轮询、仅 PS 前台、2s 保活）；判定全在面板（工具模式 ∧ 总开关 ∧ 套索）；`altToolHold` 挡自动关，松开回套索后 `applyToolGate('lassoTool')` 乐观回绿 + `setMainToggle(true)` 兜底。

**HUD 门控 / 临时吸管取色（0x020A–0x020B）** —— 明细 `refs/lasso-smoothing.md` O44–O46
75 ⛔⛔⛔ 面板写工具闸门有时是无效的：`write_params()` 在 `pstool_owns()` 时**一个字节都不写** `I_TOOLGATE` ⇒ 想临时否决平滑必须开**独立槽**（`I_ALTTOOL`），⛔ 不能借 `toolGate=0`（反面判据：切到吸管 HUD 还在 = 借了闸门槽）。
76 ⛔⛔⛔ `I_ALTTOOL` 这类硬否决位必须三处清 0：Alt 物理松开 / 面板不在位（`plug_revoke`）/ 服务重启（`services_start`）。漏一处 = 残留 1 = 平滑整段失效**且界面看不出原因**。
77 ⛔⛔ HUD 闪现只能从「显示时机」治：`CONTACT_HOLD_MS`(250ms) 窗口不能删（轻压零段 400~600ms 会闪灭），也没有信号能在 250ms 内区分真抬笔 ⇒「刚隐藏过的 1.5s 内须连续满足 180ms 才重现」；首次仍立即。
78 ⛔⛔ `!g_calib.valid` 提前 return 必须显式归零 `g_penDown`/`g_toolOk`/`g_strokeGate`：否则冻结在 1，包流一恢复 HUD 就拿陈旧几何画一圈。
79 ⛔⛔ 别想「让 Alt 绕过 PS」：① LL 钩子在 PS 前台收不到键 ⇒ 吞不了；② 伪造 `WM_SYSKEYUP` = 全局快捷键错乱。唯一确定做法是**事后搬色**（读回背景→写前景→复原背景），松开 Alt 给 800ms 宽限。
80 ⛔⛔⛔ **「颜色没变」≠「没取色」**（0x020B）：吸到的颜色恰好等于原背景色时 PS 写的是同一个值 ⇒ `bgOld==bgNow`；旧码据此判「没取色」就 return ⇒ 白背景吸白色整段失效。判据只能是输入事实「这一轮按下里有没有**左键**」（`hostBusy` 的 `btn` → `busyHadLeft` → `releaseHandlers(hadLeft)`）；只有空格（抓手/缩放导航）⇒ 不当取色。

**标准模式滤波 / 面板文案（0x020C）** —— 明细 `refs/lasso-smoothing.md` O47
81 ⛔⛔⛔ 笔速必须用**真实位移**：`|raw − out|` 是**滞后**不是速度。拿它算 `g_speed` ⇒ 「强度越大 → 滞后越大 → 被判甩笔 → 速度适应削平滑 → 滞后又被压小」的负反馈，稳态滞后被锁在 4~6px（强度 40→100 只差 3.7→5.7px）⇒ 用户报「强度怎么拉都一样」。现按「≥6px 距离窗 / ≥4ms 窗时」结算（`SPEED_WIN_PX/MS`），冲包（`now` 同毫秒）不再造出假甩笔。判据：真机 `[stroke] 平均滞后` 必须随强度变。
82 ⛔⛔ 尖角判据必须**两级基准**：参考方向只由 ≥3px 线段推进（抗抖动）、当前方向由 ≥2px 累积位移给出。旧码要求**单包** >3px，而 205Hz 正常运笔每包仅 1~2px ⇒ 慢速画线时「尖角保护」整段不触发（参数与文案完全对不上）；反之去掉 3px 基线 ⇒ 每帧判拐角 ⇒ `kk` 抬到 0.75 ⇒ 只剩滞后、不平滑。
83 ⛔⛔⛔ **用户可见文案**（`helpTexts.ts` 等）：① 汉字与字母/数字之间一律一个半角空格；② 数字与 px/%/°/ms 不空、与「像素/度/级」空；③ 区间统一「 – 」（en dash 两侧空格），减号用「−」；④ ⛔ 禁用箭头（→）、星号强调（`**`）、警告/勾叉/星形等图标 —— UXP 的 `title` 是纯文本，缺字形就是方块/乱码；要表达因果写「对应/得到」，强调用「」。全文规则写在 `src/constants/helpTexts.ts` 头部。
84 ⛔⛔⛔ **HUD 圆心「绘在一个会漂的量上」就会一直抖**（0x020D）：圆心屏幕位置 = 光标 − 偏移，而偏移每帧都要用「上一包速度 × age」把 raw 外推到当前时刻 —— raw 是整数轴坐标，量化 ±1 屏幕 px ÷ 包间隔(≈5ms) ⇒ 速度噪声 ≈0.2px/ms，乘 age（0~8ms 逐帧变）⇒ 圆心每帧被推 1~2px（模拟峰峰 2px、4s 内反向跳 199 次）。⛔ 拉绳模式绳没绷紧时**绘制点是被冻住的**（`distPx ≤ radius` 时不改 `g_ox`）⇒ 此刻圆心就该一动不动，外推的信息量是零、噪声却是全部。判据：`snOutX/Y` 与上次提交位置时相同 ⇒ 复用上一帧窗口位置（用**绘制点**，不是光标）；再加整像素迟滞（`HUD_PX_HYST`=0.15，死区 0.3px）防停在 .5 边界上翻格。⛔ 位置一旦复用，绳末端**不能再由 `rx/ry` 反算**（窗口不动它会自己抖、还与光标脱开）⇒ 窗内坐标由 `cur − 已提交左上角` 反算。⛔⛔ 但 `put*` 是**窗口左上角**、圆心在窗内 (half,half) ⇒ 光标相对圆心的向量必须再**减 half**，漏了就是 0x020E 那根直棍（见 85）。⛔ `putValid` 必须三处失效：隐藏 / 边长变 / 首次。
85 ⛔⛔⛔ **HUD 里有两套坐标系，混用不报错、只变形**（0x020E）：`putXc/putYc` = 窗口**左上角**；圆心/受力点/笔尖点 = 窗内 `(half, half)`；`rx/ry` = 光标相对圆心的偏移。⇒ 光标相对圆心的向量 = `cur − put − half`，**不是** `cur − put`。0x020D 把绳向量从 `rx/ry` 换成 `cur − put` 时漏减 half ⇒ 实际是 `(rx+half, ry+half)`：① `vlen ≈ |(124,124)| ≈ 175 > leashPx(100)` ⇒ 绷直判据**每帧**成立 ⇒ `sag` 恒 0 ⇒ 绳变**直棍**；② 端点画在 `half + vx = 2·half + rx`（圆周外，甚至被窗口裁掉）；③ 方向被常量 `(half,half)` 主导 ⇒ 只在右下 **25°~65°** 扇形内随笔向轻摆。⛔ 为什么能躲过自检：`half = RADIUS_PX_MAX·dpiS + 24` 与 `leashPx = radius` **同量级**，观感不像「错位」而像「绳变硬了」⇒ 任何 HUD 向量改动都必须先量一条 `vlen ≤ leashPx` （日志新增 `rope=%d`，超了就是坐标系错了）。

## 维护约定

超限先下沉 refs 再精简本文件。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ 数据目录：`PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，两者独立**不许合并**；Plug-ins 里的旧 .8li 直接覆盖、**不留备份**（PS 运行时锁文件 ⇒ 覆盖前必须完全退出 PS）。
