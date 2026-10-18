# JWautofill 项目记忆（主索引）

> 本文件 = 索引 + 铁律速查（保持精简）；明细在 `refs/`，里程碑史在 `HISTORY.md`（逐日流水账已于 2026-10-17 大整理蒸馏删除）。
> ⛔ 违反必炸｜⚠️ 易复发。架构：套索平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/` → `JWautofillHost.8li`）。
> **M3**：键盘钩子（WH_KEYBOARD_LL）并入同一 .8li（`keyhook.c`，WS 18923），面板开关 = 布防/撤防（服务不可启停）。
> **M4**：改名 JWautofillHost（多功能合体）；`native/HotkeyDaemon/` 整项目删除（仅 `fix-keyboard.ps1` 随迁）；面板「卸载快捷键服务」菜单移除；`uninstall` 不停服务器（可反复布防）；`src/hotkey/` → `src/lasso/`。

## M6 版本时间线（2026-10-18，0x0128 → 0x0130）

| 版本 | 一句话结论 | 详见 |
| --- | --- | --- |
| 0x0128 | 补发桥（采样线程代投 `WT_PACKET`）；实测直接机制是「**驱动停投递**」而非「PS 不取包」 | O22 |
| 0x0129 | `wtctx_post_open()` 抽 A/W 共用（曾只挂 WTOpenA ⇒ queueSize 测试没真跑）；`RI_ANA` 48→96 / 96→160 修 `syn=0` 洞；RE 定案：`WTQueueSizeSet` 等被 LNP **丢弃**，救命在包路径 | O23 |
| 0x012A | 落笔偏移根因 = 起笔锚定从不落在真落笔包上 ⇒ 改 **buttons 逐包 0→1 边沿**强制锚定（`落` 每笔=1） | O24 |
| 0x012B | 「前几笔好、后几笔断」= **补流自己先断**（tip 窗 1500ms 到期 ⇒ 停投 ⇒ PS 循环下线）⇒ `SYNTH_TIP_MAX_MS=6000` + 防幽灵守卫 | O25 |
| 0x012C | 第 3 道守卫（LBUTTON 抬起即停）把补发判死 ⇒ 删除；左键**电平**不可当落笔证据（边沿可以） | O26 |
| 0x012D | tip 链全靠包证据 ⇒ 空档从「笔抬着」开始就是盲区 ⇒ `WH_MOUSE_LL` 左键**消息**做包外证据（只加不减） | O27 |
| 0x012E | 代投被 `moved` / `cv=0` 判死 ⇒ 改**按拍节流** + 「喂入冻结」；reload 自愈 = .8li 整包重建 | O28 |
| 0x012F | **只钩 Wintab = 只覆盖 1/3 输入通路** ⇒ 照搬 LNP 装 `user32!GetCursorPos` detour（先调真 → 按条件覆盖） | O29–O31 |
| 0x0130 | 补齐「**推进节拍 = PS 查询同拍**」：detour 内 raw/out **双端外推**（`v·Δt`，限 40ms） | O32 |

## 索引

| 要动的东西 | 先读 |
| --- | --- |
| 填充 / 描边 / 清除 | `refs/fill-and-stroke.md` |
| CSS / 布局 / 面板 / 主题 | `refs/frontend-css.md`（技能 `uxp-frontend-spec`） |
| 忙碌闸门 / 模态 / 世代号 | `refs/busy-gate.md` |
| UXP 接口 / 性能 / React | `refs/uxp-api-layer.md` |
| 像素处理器算法 | `refs/pixel-algorithms.md` |
| 构建 / IO / 部署 | `refs/toolchain-and-env.md`（M4 起原生侧只有 .8li 一个产物） |
| 平滑 / HUD / 断流 / 笔通路 | `refs/lasso-smoothing.md`（O1–O11 基础档：断流判读·HUD·axMax·补流·`'slct'`·.8li·进程内模态层级·DETACH·焦点门；**O22–O32 = 0x0128→0x0130 全档，逐版根因与修法**） |
| 键盘热键钩子 / WS 18923 / 一键修复 | `refs/keyhook-8li.md`（M3 钩子线程模型·熔断三件套·单持有者·repairKeyboard 分工·面板布防开关；**M4 uninstall 不停服务器+菜单入口已删+daemon 项目删除**；**M5 ps1 瘦身设备层两步+倒计时 5s**） |
| modal scope 开销来源 | `docs/modal-scope-audit.md`（第五节 = 2026-10-17 复核出的遗漏 G/H） |

**校验**：改 CSS 跑 `scripts/_css_comment_guard.cjs` + `_modal_contract_guard.cjs` + `_color_picker_contract_guard.cjs`（只扫 `src/styles/*.css`，**不扫 `theme.ts`**）；`npx tsc --noEmit` 只看 `src/` 新增报错；改 `native/JWautofillHost/*.c` 跑 `build.sh`（零告警）+ `analysis/verify_exports.py` 核验 `jwwh_version`；改面板 `yarn build`。

**地图**：`app.tsx` 填充面板 · `AdjustmentPanel.tsx` 工具箱 · `psProbe.ts`+`psAccess.ts` 闸门 · `ClearAlgorithms.ts` 清除 · `adjustments/*Processor.ts` 像素算法 · `common.css`+`theme.ts` 样式 · `src/hotkey/`（WS 18923 热键）+ `src/lasso/`（`LassoSmoothing.ts` 状态机 + `SmoothBridge.ts` WS 18924，**两端点都在 .8li 内**）· `native/JWautofillHost/`（`smooth_engine.c`·`plugin_main.c`·`ps_tool.c`·`ws_core.c`·`keyhook.c`·`fix-keyboard.ps1`）。

## 铁律速查

1. ⛔⛔ **提交**：代码+日志+记忆**合成一次提交**；定稿才提交（toolchain §八）。
2. ⛔⛔ **IPC 数字双防御**：`toWire()` 一律 `Math.round`；原生侧 `double?`+Round（漏则整条消息被丢，O7）。
3. ⛔⛔ **.8li**：PiPL 头 10 字节；`'8664'` 导出名=**C 字符串**；版本走导出表解析（O7）。⛔ 版本史是多段共用**一个** `/* … */`，**段间不能再写 `*/`**（0x0130 血案：提前闭合 ⇒ 中文引号被当标识符）。
4. ⛔⛔ **`'slct'` 三态接管**：只有 `2` 停轮询；同步三处（停表 / `applyToolGate()` return / 不写 `I_TOOLGATE`，O6）。**边沿触发无心跳 ⇒ 接管带 2s 时效**，面板唯一判据 = 原生下发的 `gateOwned`，绝不自己比阈值（O9）。
5. ⛔⛔ **px 权威 = 屏幕/lcOutExt**，非 lcInExt；`axisMax` 每次标定重算（O4）。
6. ⛔⛔ **拉绳定长**：`f = 1 − rope/dist`；1px + 二次贝塞尔，**不画锥形**。
7. ⛔⛔ **HUD**：保留 `WS_EX_TRANSPARENT`；`WS_EX_TOPMOST` 写进 `CreateWindowExW`；不加可见装饰（O1）。**几何判据 = 圆心与轨迹末端是否重合**（不是「环跟不跟得住」，O30）。
8. ⛔ **断流**：对 Wintab **只读不写**；判读 = `[stall]` 与 `[dead]` 差集（O1）。
9. ⛔ **闸门**：`isPsBusy()`+文档闩锁+`psRead()`；禁采信 `core.isModal()`；空闲巡检 <3.3/s。
10. ⛔ **像素常量**先问物理/逻辑，一律 ×`dpiS`；`putPixels` 默认 `replace=true` 清空整层；`theme.ts` 注释写在 `{ }` 外。
11. ⛔⛔ **进程内模态层级是三态、且禁止并进 `isPsBusy()`**：`psBusyInProc()` = `1`确定忙/`0`确定闲/`-1`不可用；后者是否定式安全闸，合并会把用户主动的填充也挡住。层级**只给巡检类入口**用（O8）。⛔ `-1` 绝不能当 `0` 用。
12. ⛔ **会改写宿主结构的开关一律外置 ini**（`%LOCALAPPDATA%\JWautofill\smooth8li\wtctx.ini`，缺文件=只观测）；改口径不以重编 .8li 为代价（O8）。例外：`cursorInject` 缺省=1（不搬光标、不改 PS 结构，O31）。
13. ⛔ **`CFG_NLONGS` 现为 58**：动槽位表时 `plugin_main.c` 与 `smooth_engine.c` **同步改**（不同步=静默截断，不报错）。
14. ⛔ **两本日志分工**：PICA/ps_tool 的一切看 `%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log`；`%TEMP%\jwwh-<pid>.log` 是引擎日志，**按设计不含 ps_tool 一行**。
15. ⛔⛔ **HUD 显隐 = 显式 AND 门，每项都是必要条件**（O10）：窗口在·有包流·工具套索∧笔尖接触·一笔之中·前台本进程·**焦点在活动文档画布**（主框 `class="Photoshop"`+`MDIClient` 子树+光标在文档区矩形）·**落笔判据已建立**（`!g_ctUnknown`）·非断流/大跳跃/帧滞后·拉绳模式·面板 bit0·总开关。Wintab 系统上下文与焦点无关 ⇒ 面板上落笔包照常进 ⇒ **必须问 Windows 要焦点**。⛔ `ctOk` 只门 HUD，不改平滑 fail-open。
16. ⛔⛔ **DLL 卸载（DETACH/FreeLibrary）必须先全停引擎线程再返回**：`jwwh_unhook()`（幂等）+ 兜底 repatch；⛔ DETACH 中**只能 join 不 LoadLibrary 的线程**（loader lock 约束）；`_unloaded`+0xc0000005 = 线程活过卸载的铁证（0x0117 修）。
17. ⛔ **补流状态机只看接管条件，不看得包数**：`k==0`（64Hz 采样与 PS 轮询相位错开的空转拍）≠「驱动恢复了」；假交还会把排障完全带偏（0x0117 修）。**停摆 ⇔ PS 失前台**（含面板自身弹窗/倒计时抢前台），`[stall]` 行 `fg=` 即固化此现场。
18. ⛔⛔ **停摆/断流排查先问「LNP 在不在环」，但别把 LNP 当方案**：同 0x0128 二进制无 LNP 时每 1~2 笔一次 `[dead]`，LNP 驻扎过则 12 笔 0 断流 ⇒ 曾误判为「真变量」。⛔⛔ **0x012B 已证伪**：jwwh-20708 场 LNP 确在环（自日志 11:14:04 进驻、11:15:44 退出），停摆照旧且更长（2.36/3.95/>9.7s）⇒ LNP 至多概率性缓解，**不能当依赖**；进程内唯一可控容错 = 补流桥（铁律 20）。**0x0129 RE 定案**：`WTQueueSizeSet`/`WTEnable`/`WTQueuePacketsEx`/`WTPacketsPeek`/`WTDataGet`/`WTSet` 被 LNP 解析后**字节级丢弃**（队列假设作废），上下文钩子在 31980 场**双空转**；真写动作在**包路径**（WTPacket 旁路喂包 / WTPacketsGet 替换 buf 与返回值）。判据：`[dead] syn=` + 冲包量；**测试有效性先查挂没挂对 API 版本**（曾只挂 WTOpenA 而 PS 走 W 版 ⇒ 测试白跑；5912 实测 `WTQueueSizeSet(128)⇒1`，原容量 50）。
19. ⛔⛔ **起笔锚定的唯一权威 = buttons（笔尖开关）逐包 0→1 边沿**（0x012A，用户报「落笔瞬间受力点与施力点分离、画出一段没画的折线」）：`!g_wasEnabled` 批级锚会落到**批首悬空包**（场景 A），1500ms 长闩更会让 **<1.5s 的再落笔根本不锚**（场景 F，实测间隔低至 0.26s）。buttons 是 **PS 自己起/收套索路径的字段**（我们从不改写）⇒ 边沿即 PS 路径边界，必须在该包把输出点钉到原始坐标。⛔ 绝不盯 np/tp 边沿（0x0124 教训：轻压掉零 ⇒ 每记恢复都拽输出点 ⇒ 整笔硬线；buttons 在 np/tp 掉零时保持 1）。带去抖（连续抬升 <8 包不当真）；buttons 不可用则机制静默。**判据：台账 `落` 每笔必须=1**（=0 ⇒ 边沿没抓到、偏移复现；>1 ⇒ buttons 笔中抖动）。
20. ⛔⛔ **补流安全窗与接触判据必须分开**（0x012B）：`SYNTH_TIP_MAX_MS=6000` 只管「还敢不敢代投 `WT_PACKET`」，`CONTACT_HOLD_SMOOTH_MS=1500` 才管「笔还在不在纸上」。⛔ 两者复用同一时长 = 停摆超 1.5s 后**补流自己先断**（PS 是消息驱动 0x801D/0x7FF0，收不到 `WT_PACKET` 就退出取包/重绘循环 ⇒ 合成包照发也不重绘）。⛔ 拉长窗口必须配防幽灵守卫（光标在活动文档画布内 + 光标真移动）。⛔⛔ 守卫**不能**用 VK_LBUTTON **电平**当抬笔证据（0x012C）：Wintab 独占时鼠标模拟只发按下/抬起**边沿**、不保持电平 ⇒ 电平在笔明确按着时成段读 0 ⇒ 守卫每拍成立 ⇒ `补发` 恒 0 ⇒ 断流永不自愈。**判据：长停摆中 `补发=` 必须持续增长**。⛔⛔ **代投节流绝不能挂「光标移动」，也不能挂「光标在不在画布」**（0x012E）：输出本就滞后一整根绳（实测 38.8px）⇒ 笔一停永远追不上；`cv=0` 也不能读成「用户不画了」（用户移出画布是被冻住的线逼出来的反应）。jwwh-2200 两道门先后覆盖 9.9s ⇒ `补发` 冻在 46、PS 取包 1200/s→60/s。修法 = **按拍节流** + `cv=0` 转**喂入冻结**（位置钉在最后画布内点）。
21. ⛔⛔ **空档期的落笔只能由「包外证据」决定，且包外证据只许加不许否决**（0x012D）：tip 链（`g_penDown`/`g_lastRealTip`）全部来自包，空档若在**抬笔后**开始，起点就是 0 ⇒ 用户随后按下笔尖也没有任何真包能报 0→1 ⇒ 整段空档喂 buttons=0 的悬空包 ⇒ PS 只挪光标不落笔（jwwh-21032：13.1s、`补流` 695 包、`tip=0` 整段、`[dead]` 一条未打）。唯一可用的包外证据 = `WH_MOUSE_LL` 的**左键消息**（`keyhook_mouse_state`，事件不是电平），只在 `realAge > RI_STALL_MS` 且光标在活动文档画布内时把 tip 抬到 1；⛔ 绝不拿它把 tip 从 1 压回 0（= 0x012B 第三道守卫的死路）。**判据：`零包次` 涨 + `补流` 涨 + `tip=0` 三者同时成立 ⇒ 就是这个盲区。**
22. ⛔⛔ **输入通路有三条，只钩一条等于没有**（0x012F）：PS 拿笔数据的入口有 ① Wintab 包、② 系统光标查询（`GetCursorPos`/`GetMessagePos`/`GetMessageW`）、③ Windows Ink 指针（`GetPointerInfo` 系列）。驱动一停，PS **退回鼠标路径**照常画（跟手、但没平滑）⇒ 只钩包路径的实现此刻**完全失手**（这不是「线冻住」，是 O29 的认知修正）。LNP 三路全钩而稳定，我们只钩一条才「一断就没」。⛔ 照搬它的形态：**先调真函数**再按条件覆盖输出；`VK_LBUTTON` 只用于「开启推进」，**绝不用来判抬笔**（笔画中电平读 0 时要返回**缓存的平滑点**，不是透传 —— 0x012B 的解药；我方由 `g_penDown` 的接触闩等价实现）；**不搬真实光标**（`SetCursor` 钩、`SetCursorPos` 不钩）。⛔ 两条写路径必须互斥：正常运笔由包路径改写，`GetCursorPos` 只在 `realAge >= RI_STALL_MS` 时接管，否则双重滞后。⛔ 组件内部一切读取必须直调真函数（`se_real_GetCursorPos`），**否则输入吃自己的滞后输出 ⇒ 自激发散**。
23. ⛔⛔ **平滑的「节拍」必须与 PS 的查询同拍，不能只跟包**（0x0130）：LNP 是「PS 每问一次 `GetCursorPos` 就推进引擎一步」；我方引擎随**包**推进 ⇒ 断流期包≈0 而 PS 每秒问几百次 ⇒ 几百拍拿到**同一个**偏移量 ⇒ 线「一顿一顿」（不是平滑量错，是**时间轴没跟着查询走**）。修法 = detour 内把 raw/out **双端外推**到此刻（`v·Δt`，限幅 40ms，**有符号**相减，`g_snMs` 由包线程写、无符号会下溢成 4.29e9）。⛔ 外推只做**纯几何**，绝不改引擎状态 —— 否则等于每被问一次就替用户画一笔。

## 维护约定

超限先下沉 refs 再精简本文件。技能：`uxp-frontend-spec`、`algo-param-bench`。

**目录分工（2026-10-17 定）**：`scripts/` = 沉淀后的诊断/校验工具（git 跟踪、跨机同步；新工具须真机复核有价值才从 `analysis/` 晋升）；`analysis/` = 临时分析报告与未复核工具（gitignored，不跨机）；`outputs/` 已清空废止。
