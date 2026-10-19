# JWautofill 项目记忆（主索引）

> 索引+铁律速查；明细在 `refs/`，里程碑史在 `HISTORY.md`。⛔ 违反必炸。
> 架构：套索平滑+键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`）。M3 键盘钩子并入（WS 18923）；M4 改名 JWautofillHost、HotkeyDaemon 源码删除、`src/hotkey/`→`src/lasso/`。
> 版本线 2026-10-18（0x0128→0x0138）：补流桥十次翻车 → 三路输入/标定死锁/闸门时效/重力悬链/冷启动口径/Ink 判死 → 撤掉「断流才接管」门闩。逐版根因见 `refs/lasso-smoothing.md` O22–O40。
> 2026-10-19 面板线（0x013E）：平滑开关改**意图语义**（`isPenSmoothOn`，回帧不覆写 penOn）+ 断连宽限 2.5s；标准/追笔**去半径**（toWire 非 rope 固定下发 100）；标签 保角下限/追笔速度；`.dragging` 加主色蓝框。明细见当日日志。

## 索引

填充/描边/清除 `refs/fill-and-stroke.md`｜CSS/面板/主题 `refs/frontend-css.md`｜闸门/模态 `refs/busy-gate.md`｜UXP/性能 `refs/uxp-api-layer.md`｜像素算法 `refs/pixel-algorithms.md`｜构建/部署 `refs/toolchain-and-env.md`｜平滑/HUD/断流/笔通路 `refs/lasso-smoothing.md`（O1–O11 基础；O22–O40 全档）｜键盘钩子/WS 18923 `refs/keyhook-8li.md`

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css` 不扫 theme.ts）；`npx tsc --noEmit`；改 .c 跑 `build.sh` 零告警+`analysis/verify_exports.py`；改面板 `yarn build`。

## 铁律速查

**产物/构建**
1 ⛔⛔ **除非用户明确要求，禁止 `git add`/`commit`**（2026-10-19 用户重申：未测试前不提交，上次违规已上传远端）。改动+日志留在工作区，测试通过并经用户发话才提交；提交时=代码+日志+记忆一次提交。
2 ⛔⛔ IPC 双防御：`toWire()` 一律 Math.round，原生 `double?`+Round（漏=整条消息被丢）。
3 ⛔⛔ .8li：PiPL 头 10 字节；`'8664'` 导出名=C 字符串；版本走导出表；版本史多段共用一个 `/* */`，段间禁写 `*/`。
4 ⛔ `CFG_NLONGS=58`：动槽位表 `plugin_main.c` 与 `smooth_engine.c` 同步改（不同步=静默截断）。
5 ⛔ 日志分工：ps_tool→`%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log`；`%TEMP%\jwwh-<pid>.log`=引擎日志（无 ps_tool 行）。
6 ⛔⛔ 卸载先全停引擎线程再返回：`jwwh_unhook()` 幂等+兜底 repatch；DETACH 只能 join 不 LoadLibrary 的线程。

**闸门/面板**
7 ⛔⛔ `'slct'` 三态只有 `2` 停轮询，同步三处；边沿无心跳⇒接管带 2s 时效；面板判据=原生 `gateOwned`。
8 ⛔ 闸门=`isPsBusy()`+文档闩锁+`psRead()`；禁采信 `core.isModal()`；空闲巡检 <3.3/s。
9 ⛔⛔ `psBusyInProc()` 三态禁并进 `isPsBusy()`；`-1` 绝不当 `0`。
10 ⛔⛔ 真相不靠心跳续命（0x0133）：面板发 `gateAge`，原生写 `I_GATETS=now−gateAge`；心跳只续参数。
11 ⛔⛔ HUD=显式 AND 门（O10）：窗口在·包流·套索∧接触·一笔之中·前台·焦点在文档画布·落笔判据·非断流·拉绳·面板 bit0·总开关；`ctOk` 只门 HUD。
12 ⛔⛔ HUD 门槛不门救援（0x0134）：救援用宽判 `canvas_hit_ok` 不看前台；HUD 用严判。
13 ⛔ 改宿主的开关外置 `wtctx.ini`（缺=只观测）；`cursorInject` 缺省 1；缺省值写 `fopen` 前。

**HUD/画布**
14 ⛔⛔ 拉绳定长 `f=1−rope/dist`，1px+二次贝塞尔不画锥形；HUD 保留 `WS_EX_TRANSPARENT`，`WS_EX_TOPMOST` 写进 CreateWindowExW；几何判据=圆心与轨迹末端重合。
15 ⛔⛔ 悬链垂度只加重力方向（0x0134）：`cqy=my+2·sag·hor`，`hor=|dx|/d` 弦竖则衰到 0。
16 ⛔ px 权威=屏幕/lcOutExt 非 lcInExt，`axisMax` 每次标定重算；像素常量×`dpiS`；`putPixels` 默认 replace=true；theme.ts 注释写 `{ }` 外。

**断流/补流**
17 ⛔ 断流对 Wintab 只读不写；判读=`[stall]`与`[dead]`差集。
18 ⛔⛔ 「没开始画」≠「断流」（0x0135）：零真包用 `[boot]` 措辞；判据=首条 `[stall]★` 前必见 `[boot] 首包到达`。
19 ⛔ 停摆⇔PS 失前台，`[stall]` 行 `fg=` 固化现场。
20 ⛔⛔ 补流状态机只看接管条件：`k==0`≠驱动恢复，假交还带偏排障。
21 ⛔⛔ 停摆先问「LNP 在不在环」但别当方案；LNP 字节级丢 `WTQueueSizeSet/WTEnable/WTPacketsPeek/WTDataGet/WTSet`（0x0129 RE）；测试前查 A/W 版本。
22 ⛔⛔ 安全窗与接触判据分开：`SYNTH_TIP_MAX_MS=6000` vs `CONTACT_HOLD_SMOOTH_MS=1500`；判据=长停摆 `补发=` 持续增长。
23 ⛔⛔ 不用 VK_LBUTTON 电平当抬笔证据（0x012C）：Wintab 独占时鼠标模拟只发边沿。
24 ⛔⛔ 代投节流不挂光标移动/画布（0x012E）：按拍节流+`cv=0` 转喂入冻结。
25 ⛔⛔ 空档期落笔只由包外证据定且只加不减（0x012D）：`WH_MOUSE_LL` 左键消息（事件非电平）；判据=`零包次`涨+`补流`涨+`tip=0`。
26 ⛔⛔ PS 会自关 Wintab 上下文不重开（0x0133）：判据=`[ctx] WTClose` 后无 `WTOpenW`；只定性（原因码 9）。

**输入/标定/落笔**
27 ⛔⛔ 输入三条路只钩一条等于没有（0x012F）：Wintab 包+系统光标+Windows Ink；先调真函数再按条件覆盖；`VK_LBUTTON` 只开推进；钩 SetCursor 不钩 SetCursorPos。
28 ⛔⛔ 平滑节拍=PS 查询同拍（0x0130）：raw/out 双端外推限幅 40ms 有符号；只几何不改状态。
29 ⛔⛔ 标定不是「一批≥3 包」（0x0131 整机死）：分层 n≥3/n==2/n<2，`WTPacketsPeek` 只读⛔不用 Get；证据不足 `attempts--`。
30 ⛔⛔ `user32` 导出是真代码（BA 头）非 E9 桩⇒走 IAT（0x0131）；自己模块不扫描。
31 ⛔⛔ 起笔锚定唯一权威=buttons 逐包 0→1 边沿（0x012A）；绝不盯 np/tp 边沿；`落`>1≠抖动。
32 ⛔⛔ `BTN_EDGE_MIN_ZERO=16 包`（0x0135）：真抬笔实测≥260ms；`落间最小全零` 结构上必≥阈值别当独立证据。
33 ⛔⛔ 系统光标与 Wintab 同源（笔停则冻）；Raw Input 被驱动吞（HID=0）；Windows Ink 判死 `[ink]=0` 全场（0x0136/0x0137）——API 层到此为止。
34 ⛔⛔ 断流第二问：断流时系统光标动不动？（O38：冻死 vs 跟笔）。
35 ⛔⛔ 平滑输出不绑包（0x0137）：停摆期 `gp_step()` 每次查询推一步不读包快照；`sAge<=300` 是自锁。
36 ⛔⛔ 超 6s 用包外按钮电平+画布内+1.5s 内动过⇒tip=1（三条缺一不可，只加不减）。
37 ⛔⛔ 补流交还驱动必须 `g_btnResync`（0x0137）：否则假落笔钉回原始坐标。
38 ⛔⛔⛔ 「包流健康」≠「PS 在用包画」（0x0138 最大教训，jwwh-22732：包流 202/s 但 `rw` 卡 5938）。判据=`armed=笔按着`：cursorInject∧cfg[ENABLED]∧(mseDown∨VK_LBUTTON∨g_penDown∨g_mseTip)；画布宽判只定「坐标能不能喂」不定「要不要推」；笔抬着完全透传。验证=`[raw] gp=贴合/步数` 正常运笔也一直涨。
39 ⛔⛔ **键盘热键必须双路**（0x013C）：LL 钩子在 PS 前台时会整段收不到键（14:02 录制 17s 零回调零日志，非闸门拦）⇒ 加 `GetAsyncKeyState` 10ms 轮询兜底，与钩子共用录制状态机与热键表；钩子可吞键、轮询不能。判读日志 `按键通路：钩子 +N / 轮询 +M`，**只有轮询涨=键没进钩子链**。
40 ⛔⛔ 钩子活性看**阳性证据**（0x013D）：`!g_khHook` 判不出「被摘/被压链尾」（句柄仍非空）⇒ 判据=`轮询有增量 ∧ 钩子零增量` ⇒ `g_khReinstall` 卸装重抢链头（3/10/30s 退避，**录制中不重装**）。`kh_dual_mark` **只由钩子路径写**，轮询自记账会吞掉 400ms 内第二次同键（连按 Shift+E 第二下失效）。
41 ⛔⛔ unload 必须让引擎**哑火**（0x013D）：`services_stop` → `jwwh_set_engine_off(1)`（两个 detour 首行透传 + HUD 藏），`services_start` 清零复机；⛔ 不用 `jwwh_unhook()`（`g_stop=1` 不可逆，Reload 就没平滑）。⛔ 光标路径 `armed` 必须含 `tool_gate_ok()` —— 0x0138 撤的是断流门闩，不是工具闸门。
42 ⛔⛔ **PS 侧回调必须真注销**（0x013F）：`pstool.c` 的 `s_basic` 曾只声明不赋值 ⇒ `pstool_uninstall()` 首行恒 return，5 个通知回调与 3 个 suite 从未释放，PS 长期持有指向本 DLL 的指针（`_unloaded` 同族崩溃）。判据：改动 pstool 后 grep `s_basic =` 必有赋值；uninstall 判据只看 `s_ctrlSuite`。
43 ⛔⛔ **LL 钩子先摘再 join**（0x013F）：`keyhook_stop()` 必须在任何 join 之前 `kh_unhook_both_now()`（ExchangePointer 置空+Unhook），join 之后再补一次；绝不能靠钩子线程自己的退出路径去卸 —— 超时就把「回调地址在本模块」的活线程留给卸载后的系统。
44 ⛔⛔ **DETACH 日志先落再停服**（0x013F）：停服里任何 join 卡住都会让日志既无 Unload 也无 DETACH（2026-10-19 21:39 现场）。排查关闭崩溃三步：`pi8li.log` 有无 `[dll] DLL_PROCESS_DETACH ... reserved=` → `%LOCALAPPDATA%\JWautofill\dumps\crash-*.dmp`（0x013F 起内置取证）→ WER `AppCrash_Photoshop*` 的 `故障模块`。

## 维护约定

超限先下沉 refs 再精简本文件。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
2026-10-19 清收尾：Run 键 `JWautofillHotkeyDaemon`+`%LOCALAPPDATA%\JWautofill\daemon\` 已删（保留 smooth8li/configpath.txt）；native/ 四旧项目+analysis/+outputs/ 已删；备份 `../JWautofill-backup-20261019-pre-cleanup/`（715MB 核验）+回收站双保险。
2026-10-19 用户口径：`PluginsStorage/PHSP/27/External/`=用户安装版数据、`.../Developer/`=测试数据，两者独立**不许合并**；Plug-ins 里的旧 .8li 直接覆盖、**不留备份**。
