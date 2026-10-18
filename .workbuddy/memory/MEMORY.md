# JWautofill 项目记忆（主索引）

> 本文件 = 索引 + 铁律速查（保持精简）；明细在 `refs/`，里程碑史在 `HISTORY.md`。
> ⛔ 违反必炸｜⚠️ 易复发。架构：套索平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/` → `JWautofillHost.8li`）。
> **M3**：键盘钩子（WH_KEYBOARD_LL）并入同一 .8li（`keyhook.c`，WS 18923）。**M4**：改名 JWautofillHost；`native/HotkeyDaemon/` 删除；`src/hotkey/` → `src/lasso/`。

## M6 版本时间线（2026-10-18，0x0128 → 0x0138）

**0x0128–0x012E = 补流桥与落笔判据的十次翻车**；**0x012F–0x0138 = 换战场**（三路输入 → 标定死锁 → 台账判据 → 上下文看门狗/闸门时效 → 重力悬链与救援门槛 → 冷启动口径 → Windows Ink 判死 + 光标路径自给自足 → **撤掉「断流才接管」门闩**）。逐版根因见 `refs/lasso-smoothing.md` **O22–O40**。

| 版本 | 关键词 | 详见 |
| --- | --- | --- |
| 0x0128 | 补发桥；真机制是「驱动停投递」 | O22 |
| 0x0129 | `wtctx_post_open()` A/W 共用；RE 定案 LNP 丢弃队列 API | O23 |
| 0x012A | 起笔锚定改 **buttons 逐包 0→1 边沿** | O24 |
| 0x012B | 补流自己先断 ⇒ tip 窗 6000ms + 防幽灵守卫 | O25 |
| 0x012C | 删「LBUTTON 抬起即停」；电平≠落笔证据 | O26 |
| 0x012D | `WH_MOUSE_LL` 左键消息做**包外证据**（只加不减） | O27 |
| 0x012E | 按拍节流 + 「喂入冻结」 | O28 |
| 0x012F | 照搬 LNP：`user32!GetCursorPos` detour | O29–O31 |
| 0x0130 | 推进节拍 = PS 查询同拍（raw/out 双端外推） | O32 |
| 0x0131 | **标定死锁**（n≥3 硬门槛）⇒ 分层取证 + IAT 接管 | O33 |
| 0x0132 | 台账加 `落间最小全零`（诊断） | O34 |
| 0x0133 | 上下文看门狗（原因码 9）；闸门时间戳改 `gateAge` | O35 |
| 0x0134 | 悬链垂度=重力方向；救援路径改用宽判 `canvasHit`（✅悬链用户已满意；断流 68%→21%） | O36 |
| 0x0135 | 冷启动空转不再记成「停摆 44 秒」；buttons 去抖 8→16 包 + 台账 `滤=` | O37 |
| 0x0136 | **三路输入只做了 1.5 路**；补 Windows Ink 主动探针（`[ink]`） | O38 |
| 0x0137 | **Windows Ink 判死**（`[ink]=0` 全场）；光标路径改 LNP 式「每次查询推一步」`gp_step()`；长停摆 tip 续命；补流交还去假落笔 | O39 |
| 0x0138 | **撤掉「断流才接管」门闩**：`armed = 笔按着`（三源并集），包/断流/前台/画布全不参与；`[raw] gp=贴合/步数` | O40 |

## 索引

| 要动的东西 | 先读 |
| --- | --- |
| 填充 / 描边 / 清除 | `refs/fill-and-stroke.md` |
| CSS / 布局 / 面板 / 主题 | `refs/frontend-css.md`（技能 `uxp-frontend-spec`） |
| 忙碌闸门 / 模态 / 世代号 | `refs/busy-gate.md` |
| UXP 接口 / 性能 / React | `refs/uxp-api-layer.md` |
| 像素处理器算法 | `refs/pixel-algorithms.md` |
| 构建 / IO / 部署 | `refs/toolchain-and-env.md`（M4 起原生侧只有 .8li 一个产物） |
| 平滑 / HUD / 断流 / 笔通路 | `refs/lasso-smoothing.md`（O1–O11 基础档；**O22–O40 = 0x0128→0x0138 全档**） |
| 键盘热键钩子 / WS 18923 / 一键修复 | `refs/keyhook-8li.md`（M3 线程模型·熔断三件套；M4 uninstall 不停服务器；M5 ps1 瘦身） |
| modal scope 开销来源 | `docs/modal-scope-audit.md` |

**校验**：改 CSS 跑 `scripts/_css_comment_guard.cjs` + `_modal_contract_guard.cjs` + `_color_picker_contract_guard.cjs`（只扫 `src/styles/*.css`，**不扫 `theme.ts`**）；`npx tsc --noEmit`；改 `native/JWautofillHost/*.c` 跑 `build.sh`（零告警）+ `analysis/verify_exports.py` 核验 `jwwh_version`；改面板 `yarn build`。

**地图**：`app.tsx` 填充面板 · `AdjustmentPanel.tsx` 工具箱 · `psProbe.ts`+`psAccess.ts` 闸门 · `ClearAlgorithms.ts` · `adjustments/*Processor.ts` · `common.css`+`theme.ts` · `src/hotkey/`（WS 18923）+ `src/lasso/`（`LassoSmoothing.ts` + `SmoothBridge.ts` WS 18924，**两端点都在 .8li 内**）· `native/JWautofillHost/`（`smooth_engine.c`·`plugin_main.c`·`ps_tool.c`·`ws_core.c`·`keyhook.c`·`fix-keyboard.ps1`）。

## 铁律速查

**产物 / 构建**
1. ⛔⛔ 提交：代码+日志+记忆**合成一次提交**；定稿才提交。
2. ⛔⛔ IPC 数字双防御：`toWire()` 一律 `Math.round`；原生侧 `double?`+Round（漏则整条消息被丢，O7）。
3. ⛔⛔ .8li：PiPL 头 10 字节；`'8664'` 导出名=**C 字符串**；版本走导出表解析。⛔ 版本史多段共用**一个** `/* … */`，**段间不能再写 `*/`**（0x0130 血案：提前闭合 ⇒ 中文引号被当标识符）。
4. ⛔ `CFG_NLONGS` 现为 58：动槽位表时 `plugin_main.c` 与 `smooth_engine.c` **同步改**（不同步=静默截断）。
5. ⛔ 两本日志分工：ps_tool 看 `%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log`；`%TEMP%\jwwh-<pid>.log` 是引擎日志，**按设计不含 ps_tool 一行**。
6. ⛔⛔ DLL 卸载必须先全停引擎线程再返回：`jwwh_unhook()`（幂等）+ 兜底 repatch；⛔ DETACH 中**只能 join 不 LoadLibrary 的线程**；`_unloaded`+0xc0000005 = 线程活过卸载的铁证。

**闸门 / 面板**
7. ⛔⛔ `'slct'` 三态接管：只有 `2` 停轮询；同步三处（停表 / `applyToolGate()` return / 不写 `I_TOOLGATE`）。**边沿触发无心跳 ⇒ 接管带 2s 时效**，面板唯一判据 = 原生下发 `gateOwned`。
8. ⛔ 闸门：`isPsBusy()`+文档闩锁+`psRead()`；禁采信 `core.isModal()`；空闲巡检 <3.3/s。
9. ⛔⛔ 进程内模态层级是三态且**禁止并进 `isPsBusy()`**：`psBusyInProc()` = `1`忙/`0`闲/`-1`不可用；层级只给巡检类入口用。⛔ `-1` 绝不能当 `0` 用。
10. ⛔⛔ **闸门/工具这类「真相」不能靠心跳续命**（0x0133）：面板 1.5s 重发 `penSmooth`，旧 `write_params` 每次写 `I_GATETS=now` ⇒ 过期「是套索」永远新鲜 ⇒ fail-closed 失效（铅笔落笔也出 HUD）。⇒ 面板发 `gateAge`（只随**真读到工具**刷新），原生写 `I_GATETS = now − gateAge`。**心跳只续参数，不续真相。**
11. ⛔⛔ HUD 显隐 = 显式 AND 门，每项都是必要条件（O10）：窗口在·有包流·工具套索∧笔尖接触·一笔之中·前台本进程·**焦点在活动文档画布**·**落笔判据已建立**·非断流/大跳跃·拉绳模式·面板 bit0·总开关。Wintab 系统上下文与焦点无关 ⇒ **必须问 Windows 要焦点**。⛔ `ctOk` 只门 HUD，不改平滑 fail-open。
12. ⛔⛔ **HUD 的门槛不许拿去门救援路径**（0x0134）：`canvas_focus_ok()` 首句是前台判据，而它同时被补流武装/喂入冻结/GetCursorPos 接管使用 ⇒ 切到别的窗口就救援全灭（线冻 58s）。⛔ **Wintab 是系统上下文：PS 在后台包照进、照绘制**（`fg=0` 下 `[gate] penDown` 与 packets 照长）。⇒ 救援路径一律用宽判 `g_canvasHitDbg = canvas_hit_ok(cur)`（只看 WindowFromPoint 在不在 PS 主框子树，**不看前台**）；HUD 仍用严格判据。
13. ⛔ 会改写宿主结构的开关一律外置 ini（`wtctx.ini`，缺文件=只观测）；例外 `cursorInject` 缺省=1。⛔ ini **缺省值要写在 `fopen` 之前**，写进「文件不存在」分支等于没写。

**HUD / 画布**
14. ⛔⛔ 拉绳定长：`f = 1 − rope/dist`；1px + 二次贝塞尔，**不画锥形**。
15. ⛔⛔ HUD：保留 `WS_EX_TRANSPARENT`；`WS_EX_TOPMOST` 写进 `CreateWindowExW`；不加可见装饰。**几何判据 = 圆心与轨迹末端是否重合**（O30）。
16. ⛔⛔ **悬链垂度只能加在重力方向**（0x0134）：旧版取「弦的法线」再翻 ny>0 ⇒ **弦一竖就横向鼓包**。⇒ `cqy = my + 2·sag·hor`，`hor = |dx|/d` 随弦变竖衰减到 0。
17. ⛔ px 权威 = **屏幕/lcOutExt**，非 lcInExt；`axisMax` 每次标定重算（O4）。
18. ⛔ 像素常量先问物理/逻辑，一律 ×`dpiS`；`putPixels` 默认 `replace=true` 清空整层；`theme.ts` 注释写在 `{ }` 外。

**断流 / 补流**
19. ⛔ 断流：对 Wintab **只读不写**；判读 = `[stall]` 与 `[dead]` 差集（O1）。
20. ⛔⛔ **「还没开始画」≠「断流」**（0x0135，jwwh-33124）：插件 reload 后前台还是 Chrome、用户看浏览器 44s、笔没上板（`g_pkReal` 全程 0），旧版记成 `[stall] 停摆 44359ms` ⇒ 排障第一分钟就被带偏成「一开局就断流」。⇒ 零真包时改用 `[boot]` 措辞、不计入停摆；首包到达另打 `[boot] 首包到达…从此刻起才算运笔`。**判据：第一条 `[stall] ★` 之前必须先见到 `[boot] 首包到达`。**
21. ⛔ **停摆 ⇔ PS 失前台**（含面板弹窗/倒计时抢前台），`[stall]` 行 `fg=` 固化现场。
22. ⛔⛔ **补流状态机只看接管条件，不看得包数**：`k==0`（采样与轮询相位错开的空转拍）≠「驱动恢复了」；假交还会把排障完全带偏。
23. ⛔⛔ **停摆先问「LNP 在不在环」，但别把 LNP 当方案**：0x012B 已证伪（LNP 在环停摆照旧）；进程内唯一可控容错 = 补流桥。**0x0129 RE 定案**：`WTQueueSizeSet`/`WTEnable`/`WTQueuePacketsEx`/`WTPacketsPeek`/`WTDataGet`/`WTSet` 被 LNP **字节级丢弃**。判据：`[dead] syn=` + 冲包量；**测试前先查挂没挂对 API 版本**（曾只挂 WTOpenA 而 PS 走 W 版）。
24. ⛔⛔ **补流安全窗与接触判据必须分开**（0x012B）：`SYNTH_TIP_MAX_MS=6000` 只管「敢不敢代投 `WT_PACKET`」，`CONTACT_HOLD_SMOOTH_MS=1500` 管「笔还在不在纸上」。⛔ 复用同一时长 ⇒ 停摆超 1.5s 后**补流自己先断**（PS 收不到 `WT_PACKET` 就退出取包/重绘循环）。**判据：长停摆中 `补发=` 必须持续增长**。
25. ⛔⛔ 守卫**不能**用 VK_LBUTTON **电平**当抬笔证据（0x012C）：Wintab 独占时鼠标模拟只发边沿、不保持电平 ⇒ 电平在笔明确按着时读 0 ⇒ 守卫每拍成立 ⇒ `补发` 恒 0。
26. ⛔⛔ **代投节流绝不能挂「光标移动」或「光标在不在画布」**（0x012E）：输出本就滞后一整根绳 ⇒ 笔一停永远追不上；`cv=0` 不能读成「用户不画了」。修法 = **按拍节流** + `cv=0` 转**喂入冻结**。
27. ⛔⛔ **空档期的落笔只能由「包外证据」决定，且只许加不许否决**（0x012D）：tip 链全来自包，空档若在**抬笔后**开始起点就是 0 ⇒ 整段喂 buttons=0 悬空包 ⇒ PS 只挪光标不落笔。唯一包外证据 = `WH_MOUSE_LL` **左键消息**（事件不是电平），只在 `realAge > RI_STALL_MS` 且光标在画布内时把 tip 抬到 1；⛔ 绝不用它把 tip 压回 0。**判据：`零包次` 涨 + `补流` 涨 + `tip=0` 同时成立。**
28. ⛔⛔ **PS 会自己关掉 Wintab 上下文且不自动重开**（0x0133）：`WTClose` 后 packets 定格、零包到结束 ⇒ 平滑/HUD/补流全无从下手。reload 有效是因为**插件重新加载时 PS 才重建上下文**。⛔ 自建/推顶上下文被禁止 ⇒ 只能定性并提示（原因码 9）。**判据：`[ctx] WTClose` 之后再也没有 `WTOpenW`。**

**输入通路 / 标定 / 落笔**
29. ⛔⛔ **输入通路有三条，只钩一条等于没有**（0x012F）：① Wintab 包 ② 系统光标查询 ③ Windows Ink 指针。驱动一停 PS **退回鼠标路径**照常画（跟手但没平滑）⇒ 只钩包路径此刻完全失手。⛔ 照搬 LNP 形态：**先调真函数**再按条件覆盖输出；`VK_LBUTTON` 只用于「开启推进」，**绝不用来判抬笔**；**不搬真实光标**（钩 `SetCursor`、不钩 `SetCursorPos`）。~~⛔ 两条写路径必须互斥（`GetCursorPos` 只在 `realAge >= RI_STALL_MS` 接管）~~ ← **0x0138 已废除**，见铁律 41；⛔ 组件内部一切读取直调真函数（`se_real_GetCursorPos`），否则自激发散。
30. ⛔⛔ **平滑节拍必须与 PS 的查询同拍**（0x0130）：引擎随**包**推进 ⇒ 断流期 PS 每秒问几百次却拿到**同一个**偏移 ⇒ 线一顿一顿。⇒ detour 内 raw/out **双端外推**到此刻（限幅 40ms、**有符号**相减）。⛔ 外推只做纯几何，绝不改引擎状态。
31. ⛔⛔ **标定取证门槛绝不能是「一批 >=3 包」**（0x0131，整机死）：真机 PS 一次只取 1~2 包 ⇒ 硬门槛让 `try_calibrate` 一次都进不去 ⇒ `state` 恒 0 ⇒ 面板「准备中」、HUD 与平滑全死。**判据：一条 `[calib]` 都没有 + `reason=8(无上下文)`。** 修法 = 分层取证：`n>=3` 盲扫独走；`n==2` 只认「掩码+盲扫」互证；`n<2` 用 `WTPacketsPeek` **只读**快照（⛔ 绝不用 `WTPacketsGet`，会真吃包）。⛔ 证据不足必须 `attempts--`，否则 8 次预算烧光后锁进 `state=2`。
32. ⛔⛔ **`user32` 导出是真代码（首字节 `BA`），不是 E9 桩 ⇒ LHOOK 那套找真函数用不了**（0x0131）：`BA` 是 `mov edx,imm32` 还是 BT 组不能猜 ⇒ 改走 **IAT**：扫本进程模块导入表把 `USER32!GetCursorPos` 槽指向 detour。⛔ **自己的模块绝不参与扫描**（否则自激）；每 30s 静默重扫。⛔ 覆盖不到 `GetProcAddress` 现取的调用方。
33. ⛔⛔ **起笔锚定唯一权威 = buttons 逐包 0→1 边沿**（0x012A）：`!g_wasEnabled` 批级锚会落到批首悬空包，1500ms 长闩让 **<1.5s 再落笔根本不锚**。⛔ 绝不盯 np/tp 边沿（0x0124：轻压掉零 ⇒ 每记恢复都拽输出点 ⇒ 整笔硬线）。**判据：`落`>1 **不等于**抖动**（一段台账常含 9~11 次真落笔）；真正的抖动判据 = `落间最小全零=N包` 是否**贴着去抖阈值**。
34. ⛔⛔ **`BTN_EDGE_MIN_ZERO` 现为 16 包**（0x0135，原 8）：jwwh-33124 四笔的 `落间最小全零` = 8/9/8/8 **全部贴着旧阈值** ⇒ 「笔还按着、buttons 只掉 8~9 包零」被当成真落笔 ⇒ 每次都把输出点钉回原始坐标 ⇒ 看得见的折角。16 包 ≈90ms@176Hz，真抬笔再落实测 ≥260ms 仍有 2.9 倍余量。台账 `滤=N` = 被去抖否决的 0→1 边沿数（改了阈值也不能看不见）。⛔ 注意 `落间最小全零` **结构上必然 ≥ 阈值**（触发点就在阈值处），别把它当独立证据。
35. ⛔⛔ **「三路输入」实际是 1.5 路 —— Windows Ink 从来没做**（0x0136，O38）：Wintab 包（真断流 `真实包=0` 全空）+ 系统光标（**与 Wintab 同源**：笔停则光标冻）+ Raw Input（`HID=0(0/s)` 三场全空，Wintab 独占时驱动吞掉 HID）。LNP 钩的是 `GetPointerInfo/History` 全家桶，与我们注册 Raw Input **不是一回事**。⛔ 消息层不用补（`gmp=0` 两场全程 0，`GetMessagePos` 不是 PS 的取坐标路径）。
36. ⛔⛔ **断流排查第二问（第一问是「LNP 在不在环」）：断流时系统光标动不动？**（O38 铁证）23344 无 LNP：`现值=(1260,1311)` × 4 次一模一样（冻死）；23992 开过 LNP：同样 `真实包=0` 的 105 秒里 `现值` 一路在变（跟笔），`gcp/rw` 涨到 60977（**是我们的引擎在喂 PS**，不是 LNP 平滑好）。⇒ **平滑引擎没坏，缺的是「断流期笔在哪」**；主泵与备泵同井，主泵停就都没水。
37. ⛔⛔ **Windows Ink 判死**（0x0137，jwwh-13664）：`[ink] 命中=0` 全场，主动枚举 `GetPointerInfo(1..32)` 一次都没命中笔 ⇒ 三路里第三路也不可用，**API 层到此为止**，别再指望补接口解决断流。
38. ⛔⛔ **平滑输出绝不能绑在包上**（0x0137，照 LNP 分支 C）：包停则 `g_snOut` 停 ⇒ PS 退回鼠标路径时只能拿到**同一个**旧偏移 ⇒ 线冻。⇒ 停摆期在 `det_GetCursorPos` 里跑**独立推进器** `gp_step()`（每次查询推进一步，参数取 `g_cfg` 绳长/模式/DPI，**不读任何包快照**）。⛔ 旧版 `sAge<=300` 快照新鲜度是**自锁**：快照只在取到包时更新，断流期必然过期 ⇒ 长停摆一次都不接管。
39. ⛔⛔ **`SYNTH_TIP_MAX_MS=6s` 是长停摆的死穴**（0x0137）：超 6s 合成包 buttons 只能写 0 ⇒ PS 收包当悬停 ⇒ 只挪光标不落笔。⇒ `realAge>6s` 改用**包外按钮电平**（`WH_MOUSE_LL` 累积电平 ∨ 系统电平）+ 画布内 + 1.5s 内动过 ⇒ tip=1（三条缺一不可，只加不减）。
40. ⛔⛔ **补流交还驱动的那一刻必须 `g_btnResync`**（0x0137）：补流写 0、真包回来是 1 ⇒ 边沿判成「真落笔」⇒ 输出点钉回原始坐标 ⇒ 线「啪」地跳到笔尖。下一批第一包前 `s_prevBtn=1; s_btnZero=0`（只压这一次）。
41. ⛔⛔⛔ **「包流健康」≠「PS 在用包画」——接管条件绝不能是「断流了没有」**（0x0138，本轮最大教训）：jwwh-22732 里包流全程 202/s、台账改写率 99%、HUD 照显，但 `gcp` 60 秒涨 **8.7 万次**而 `rw` 卡在 5938 **一动不动**（`a=0`）—— 因为门闩要求 `realAge >= RI_STALL_MS`。而用户在画布外浮窗上按一下再回画布，**PS 的绘制通路就切到鼠标侧**（包照收、不用于绘制）⇒ 包流健康 + 平滑消失同时成立 ⇒ 门闩永久失手。⇒ **判据只能是「笔按着就推」（LNP 分支 A/C）**：`armed = cursorInject ∧ cfg[ENABLED] ∧ (mseDown ∨ VK_LBUTTON ∨ g_penDown ∨ g_mseTip)`（三源并集、只加不减）；画布宽判只决定「这段坐标能不能喂」（不在 PS 窗口上就钉住输出），**不决定要不要推**。⛔ 笔抬着必须完全透传，否则系统光标被永久顶偏、点菜单点歪。**验证判据：`[raw] gp=贴合/步数` 在正常运笔时也必须一直涨。**

## 维护约定

超限先下沉 refs 再精简本文件。技能：`uxp-frontend-spec`、`algo-param-bench`。
**目录分工**：`scripts/` = 沉淀后的诊断/校验工具（git 跟踪、跨机同步；新工具须真机复核有价值才从 `analysis/` 晋升）；`analysis/` = 临时分析与未复核工具（gitignored）；`outputs/` 已废止。
