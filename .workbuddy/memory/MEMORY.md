# JWautofill 项目记忆（主索引）

> 本文件 = 索引 + 铁律速查；**细节一律在 `refs/`**，流水账在 `memory/YYYY-MM-DD.md`。
> ⛔ 违反必炸｜⚠️ 易复发｜✅ 有 guard。
> ⛔⛔ **架构**：套索平滑 = **PS 进程内 .8li 插件**（`native/PiSmooth8li/`）；旧 SmoothDaemon /
> 注入式 WintabHook.dll 已整体删除。算法明细 = `refs/lasso-smoothing.md` + `docs/lasso-pipl-8li-migration-plan.md`。

## 我要改什么 → 读哪里

| 要动的东西 | 先读 |
| --- | --- |
| 填充 / 描边 / 清除 | `refs/fill-and-stroke.md` |
| CSS / 布局 / 新建面板 / 主题 | 技能 **uxp-frontend-spec** → `refs/frontend-css.md` |
| 忙碌闸门 / 模态 / 世代号 | `refs/busy-gate.md`（唯一权威） |
| UXP 接口 / 性能 / React | `refs/uxp-api-layer.md` |
| 像素处理器算法 | `refs/pixel-algorithms.md` |
| 构建 / 菜单 / 文件 IO / 守护进程 | `refs/toolchain-and-env.md` |
| 套索平滑 / HUD / 断流 / 独立笔通路 | `refs/lasso-smoothing.md`（**O1 断流 · O2 HUD · O3 系统光标 · O4 axMax**）+ .8li 迁移计划 |

**改完必备校验**：改过 CSS 必跑 `node scripts/_css_comment_guard.cjs`（⚠️ 只扫 `src/styles/*.css`，不扫 `theme.ts`）+ `_modal_contract_guard.cjs` + `_color_picker_contract_guard.cjs`；`npx tsc --noEmit` 只看 `src/` 新增报错（`'uxp'`/`'photoshop'`、`ffi.d.ts` 语法错为基线）。改过 `native/PiSmooth8li/*.c` 必跑 `bash native/PiSmooth8li/build.sh`（须零告警）+ **导出表解析**核验 `jwwh_version`；改过面板再 `yarn build`。

## 仓库地图（要点）

`src/app.tsx` 选区填充父面板 · `AdjustmentPanel.tsx` 工具箱父面板 · `psProbe.ts`+`psAccess.ts` 闸门与模态 · `ClearAlgorithms.ts` 清除算法唯一来源 · `adjustments/*Processor.ts` 像素处理器（零 import）· `common.css`+`theme.ts` 样式主题唯一来源 · `helpTexts.ts` hover 文案 · `src/hotkey/` = `HotkeyBridge.ts`(18923 笔刷热键 daemon)+`SmoothBridge.ts`(18924 对端=.8li)+`LassoSmoothing.ts`（纯状态机无 WS）· `native/` 现存：`HotkeyDaemon/`（唯一 daemon，Program.cs 仅热键角色）+ `PiSmooth8li/`（平滑插件，`build.sh` 用 zig；`smooth_engine.c`=钩子+算法 · `plugin_main.c`=entry/WS/共享内存 · **`ps_tool.c`=`'slct'` 进程内工具闸门**）+ `app.manifest` + `get-zig.sh` · `analysis/`、`outputs/` gitignore 不跨机。

## 铁律（速查；细节在 refs/）

- ⛔⛔ **提交/推送纪律（2026-10-16 用户定，强制）**：① 用户说「推送到远端」时，**项目代码 + 日志 + 记忆（docs/memory）必须合成一次提交**，绝不许拆成「代码一条、docs/memory 再一条」；② **代码彻底定稿后才提交** —— 不许「先提交、随后发现 bug 又改两行补一条」；③ 提交前先自问「这版接下来还会不会再改？」，答案是「会」就先别提交、别推。
- **dist 红线**：⛔ docs 进 dist 走**白名单**（仅 fill-guide.html + toolbox-guide.html + img/）。历史教训：黑名单 `*plan*.md` 漏放 modal-scope-audit.md ⇒ 追不上新文件。webpack 不清旧产物 ⇒ 改规则后手删残留复验。
- ⛔⛔ **.8li 真机铁律**：① PiPL 头部=10 字节；② `'8664'` 入口导出名属性=**C 字符串**（Pascal 串 ⇒ GetProcAddress 失败 ⇒ attach 后 1ms 静默卸载）；③ 加载消息=`"SP Access"/"Reload"`，卸载=`"SP Access"/"Unload"`；④ 引擎+WS 层合并镜像，**无 daemon 无注入**；⑤ 自写 SHA1 必须用已知向量实测（RFC6455 App.A）。
- 📌 **PS 插件目录按测试机分叉**：① 双 4K 机 ⇒ `E:\Program Files\Adobe Photoshop 2026\Plug-ins\`；② **本机（3440×1440 带鱼屏）⇒ `C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\`**。两机都只有**一个** `JWautofillSmooth.8li`。⛔ PS 运行时锁该文件 ⇒ 覆盖前**全部退出** PS（本机常有 3 个进程）。
- ⛔⛔ 部署只认 `build/JWautofillSmooth.8li`；核验 = 日志头 `ver=0x0XXX` + `[status]` 含 `dpi=N‰`。⛔ 版本号核验要**走导出表解析**读 `jwwh_version` 函数体前 10 字节（裸搜 `B8 xx 01 00 00 C3` 会漏 —— 函数序言是 `55 48 89 E5`）。
- ⛔ **GATETS 由 pump 接管**：`cli_count()>0 || pstool_owns()` 即每 500ms 刷（面板 1500ms 心跳不可靠 ⇒ reason=4 fail-closed；⚠️ 进程内闸门接管后**必须**带上后半条 —— `'slct'` 只在工具变化时来，不续期就 3s 过期 fail-closed）；全断且未接管 ⇒ 停刷 ⇒ 3s 过期语义保留。⛔ 独立实测必须关 PS（旧副本占 18924）。
- ⛔⛔ **IPC 数字字段双防御**：面板 `toWire()` 出口对所有数字一律 `Math.round`（唯一咽喉）；原生侧字段用 `double?`+赋值 Round。漏一个浮点 ⇒ 整条消息被丢 ⇒「切换模式后平滑就断」。**新增字段必须同时做这两件事**。
- ⛔ 无原生编译器 ⇒ zig 走便携工具链（`native/get-zig.sh`→`%USERPROFILE%\zig-toolchain`）；编译须沙箱外跑。⛔ 改 `Program.cs`（热键 daemon 唯一源码）后：`dotnet publish -o publish` → `yarn build`；更新已装副本只有「服务开关先关再开」。
- ⛔ **卸载脚本只删自己那份安装目录**；绝不 `Remove-Item -Recurse` 整个 `%LOCALAPPDATA%\JWautofill`（会删 `configpath.txt` ⇒ 热键配置被冲掉）。面板卸载兜底唤起 `native/HotkeyDaemon/uninstall.bat`。⛔ 已**回退** JWUninstall.exe 启动器方案（dist +76M 不划算），UninstallLauncher 已删，勿再引入。
- ⚠️ **环境坑：genie-trash**：对多文件目录报 "Some operations were aborted" 但**实际已移动**（fail-closed 误报），且会**延迟回滚重建空目录**。对策：逐文件删容忍报错 + 空壳用 `[System.IO.Directory]::Delete(p,$false)` 收尾 + 删后复验。

## 套索平滑（速记）→ `refs/lasso-smoothing.md`

- 唯一通路 = Wintab 笔通路，实现 = **PS 进程内 .8li**（`smooth_engine.c` inline-hook `WTPacketsGet`；`plugin_main.c` 承载 WS 18924）。⛔ 换 .8li 必须重启 PS。状态周期推送（`SmoothStatePump` 500ms）。状态机 `CFG_I_STATE`：0 未挂 · 1 生效 · 2 标定失败 · 3 已卸载 · 4 入口被占（须重启 PS）。
- ⛔⛔ **坐标口径**：系统光标 = 原始笔 ⇒ HUD 圆钉「光标−(raw−out)·px」。⛔⛔ **px 唯一权威 = 屏幕/lcOutExt**（2026-10-15 [gap] 回归定案，rms 3.8/4.2px；本机=1/16 px/轴）。**旧权威 屏幕/lcInExt 是错的**（「横领先/竖落后」残差根因）。⛔⛔ **2026-10-16 代码级铁证**：LNP `prepareCoordTransform` = `SM_CXSCREEN/lcOutExt.x`、`SM_CYSCREEN/(−lcOutExt.y)` —— `lcInExt` **在变换里完全不出现**（只在日志里），且**两轴独立 + Y 取负翻转**、每次比对标尺寸并告警。⇒ 与 JWautofill 铁律**逐项同构**，可当第二权威引用（`analysis/lnp/LNP-wintab-hook-analysis.md` §11）。⛔⛔ **axisMax 亦用 lcOutExt，且每次标定都要重算**（详见 refs **O4**）。⛔ Y 符号**不在标定里猜**，由光标投票裁决（Y 本机实测反向）；投票翻转 ⇒ `AXCAL.signLocked` **首达即锁**。
- ⛔⛔ **HUD 外推两端对称**：`光标(此刻) − offset(时刻) = 绘制点(时刻)`；raw 与 out 用同一 `age/pktDt` 同时外推（只外推 raw ⇒ 圆心恒差 15px/100px 绳）。
- ⛔⛔ **拉绳 = 定长绳**：`dist ≤ rope` ⇒ 输出点不动；`> rope` ⇒ 跟随量 `dist − rope`（**`f = 1 − rope/dist`**；写成 `rope/dist` ⇒ 输出点直接跳光标）。绳长 ≡ 半径；绳 = **1px** 统一线宽 + 二次贝塞尔（垂度 `sag=sqrt(3(L−d)d/8)`，绷直带滞回死区）；**绝不画 4→1px 锥形**。
- ⛔⛔ **落笔判据 = 多信号并联**：`buttons(&0x07)/pkNormalPressure/pkTangentPressure` 任一非零 = 落笔；三者全零持续 `CONTACT_HOLD_MS=250ms` 才算抬笔。⛔ 每信号必须「同时见过 0 与非 0」才有投票权。判据未建立：冷启动宽限 `CT_GRACE_PKT=600`；期间无条件放行 ⇒ 表现为「加载后几秒 HUD 自己冒头再消失」（用户经验：**没这个现象的那一场 HUD 全程不显示**）。
- ⛔ `TIME_GAP_RESET_MS=5000`（假复位：停笔 120ms 被判新一笔）+ `HUD_HOLD_MS=3000`。⛔ **落笔锁存超时**：无包 >5000ms 强制清 `penDown/contact/strokeGate` + 报 `RS_HOVER`；**不动 `g_wasEnabled`**（动会引入「圆忽然闪现」回归）。
- ⛔ **诊断条只认原生侧原因码**（`RS_*` ↔ C `CFG_I_REASON` ↔ TS `SmoothReason` 三处逐项对应）：0 改写 · 1 开关未开 · 2 非套索 · 3 工具未知 · 4 心跳过期 · 5 悬空 · 6 判据未建立 · 7 未标定 · 8 无上下文。⛔ 禁止面板自己拼 `toolOk/penDown/gateOk`。非正常原因粘住 `SMOOTH_REASON_STICKY_MS=8000`；`gateOpen/gateClose` 是**累计值** ⇒ 判抖动只能用**增量**。
- ⛔ **状态条** `state===1` 只有两档：「生效中」(绿) / 「平滑中断」(红，判据 `penDown=1 && gateOk=1 && 有包 && snAge>2.2s`)；不按模式分叉；「生效中」后不挂参数；`state===3` → 「未生效（正在自动恢复…）」。
- ⛔ **量程落在人的运笔区间（0.05~1.5 px/ms）**：`SPEED_FULL=3.0`、强度 τ(100)=250ms、追笔 vmax 上限 3.0 px/ms；改上限同步搜 `RADIUS_PX_MAX`/`SMOOTH_RADIUS_MAX`/C 侧 Clamp。⛔ 追笔映射 `catchUpToNative(d)=round(50−(d−1)·49/99)`（d=1→50 跟手，d=100→1 最黏）。
- ⛔ **DPI/分辨率适配**：PS 实测 PER_MONITOR_AWARE ⇒ `SM_CXVIRTUALSCREEN` / `GetCursorPos` / `lcOutExt` **全是物理像素**，口径没错、缺的是**尺度** ⇒ 统一 `g_dpiScaleMilli`（整数毫倍；`shcore!GetDpiForMonitor` **动态**取，取不到退 1.0×）；半径/绳长、追笔 vmax、`SPEED_FULL`、`CORNER_MIN_PX`、`jumpPx`、`CUR_SAMPLE_MIN`、看门狗 6/8px、HUD 边长**一律 ×dpiS**。新增像素常量必须先问「逻辑还是物理」。⛔ 重标定 = 比对 **屏幕尺寸 ‖ DPI 缩放 ‖ 驱动 lcOut\* 指纹**（只比尺寸会漏）；指纹**每拍刷新**。
- 共享内存槽位 **保留空洞、绝不重编号**（与 C `I_*` 逐项对应）；改 NLONGS 必读 refs 的「扩容升级陷阱」（旧节占着 ⇒ fail-closed，重启 PS 自愈）。

## HUD / 断流 / 独立笔通路（**细节全在 `refs/lasso-smoothing.md` O1–O4**，此处只留判决）

- ⛔⛔ **HUD 三条血案**：① **绝不可去掉 `WS_EX_TRANSPARENT`**（分层窗口按像素 alpha 命中测试 + 拉绳终点恒画在光标上 ⇒ 恒抢笔按下事件）；② **`WS_EX_TOPMOST` 必须直接写进 `CreateWindowExW`**（`raise=1` 不可信，该位会话内恒定、跨会话不同）；③ **不要加任何屏幕可见的临时装饰**（白框事件）。✅ 0x010E 起真机确认可见。
- ⛔ **断流**（长期现象，非某版引入）：形态 = `calls` 涨而 `packets` 冻结数分钟、笔迹照画、平滑死。**进程内无杠杆**（`WTEnable`/`WTOverlap`/保顶层/卸载重挂全证伪 ⇒ 对 Wintab **只读不写**）。恢复冲包 ≈ 驱动队列 128 ⇒ 停摆期是「攒着」不是「丢」⇒「按几秒后整根弧一次性出现」= 断流+恢复冲包，**不是拉绳**. ⛔ 判读核心 = **`[stall]`（无前置）与 `[dead]`（有前置）的差集 = 被遮蔽的停摆**；看门狗只看 `g_pkReal`。
- ⛔⛔ **断流根因（2026-10-16 LNP 逆向定案）**：本机 `SM_PENWINDOWS=0` ⇒ **PS 的笔输入实走 Windows Ink**；LNP 同时挂 **Wintab×7 + `GetPointerPenInfo`/`GetPointerPenInfoHistory`/`GetPointerFramePenInfoHistory` + `GetCursorPos` + 消息泵**，三条收敛同一滤波 ⇒ 断一条不断平滑。**JWautofill 只挂 `WTPacketsGet` ⇒ Wintab 一停就彻底瞎**，这是**架构上只押一条通道**。⛔ LNP **无「0 包造包」机制**（`WTPacketsGet` 返回 0 时 detour 直接 return），纯靠多通道。
- ⛔⛔ **不能照搬 LNP 的多通路（2026-10-16 实测本机）**：`user32!GetPointerPenInfo*` / `GetPointerInfo` / `GetCursorPos` / `SetCursor` 入口**全是真实函数序言**（`4C 8B DC 48 83 EC` / `48 FF 25`），**不是 `E9` 桩** ⇒ 挂钩必须长度解码器 + trampoline 搬迁（LNP 用 Mhook，且连 `SetCursor` 都挂不上）。**只有 Wintab32 全是 `E9` 桩** ⇒ 现成 `prepare_hook` 那套只能用于它。
- ✅ **补流的自锁已修（0x0110）**：补流（250Hz `GetCursorPos` → 配对 → 两趟拟合 → 合成包）原先只认**强拟合**（保留集≥150 + rms≤8 + 跨度≥1000），而配对**只在真实包到达时产生** ⇒ 「刚挂上就断流」时拟合永远建不起来 = **最需要补流时恰恰建不起来**。新增 `ana_update()` **解析兜底**：`平板 = 屏幕/px + 原点`，只需 ① 标定成立 ② `g_pxSrc==1`（驱动 lcOut 权威，**不依赖配对**）③ 两轴符号已投票 ④ ≥1 对配对定原点；配对≥16 时用近 64 对核对 rms ≤ `RI_ANA_MAX_RMS`(48 单位=3px)。`g_synOn` 改为 `syn_set()` 统一发布（**强拟合 ∨ 解析**）；`penraw_synth` 系数循环外取一次、强拟合优先。⛔ 系数跨线程走 **seqlock `g_anaVer`**（detour 与 worker）。
- ⛔⛔ **`Plug-ins` 两个 `.8li` 已逆完（2026-10-16）⇒ 与注入 DLL **字节相同**（MD5 一致：`MouseHookPro64.8li`=`c1f0817e…`、`MouseHookPro.8li`=`2e79955f…`）⇒ **没有第二份代码**，上一轮「那条通路空白」的怀疑被证伪**。但它们**同时是正式 PS 插件**：导出 `PluginMain`+`init`；PiPL `name="Lazy Nezumi Pro"` / `catg="**Hidden**"`（所以 PS 菜单里根本看不见）/ `8664=PluginMain`。`PluginMain` 协议 = `"SP Access"` + `"Reload"`/`"Unload"`（**与我们 `plugin_main.c` 逐字相同**）。⇒ **`-25920` = `AcquireSuite` 返回码**。✅ **`'slct'` 工具闸门已于 0x0112 移植完成**（`ps_tool.c`；偏移/证据/三态见下条 + `analysis/lnp/…-analysis.md` §17）。
- ⛔ **JWA 的 .8li 部署位置**：本机 = `C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\`（`PSUserConfig.txt` 确认 `UseSystemStylus 0` ⇒ 走 WinTab）。**全机只能有一份** —— 两份同名会被 PS 都加载，第二实例检测到「入口已被占用」⇒ state=4（须重启 PS）。
- ⛔ **独立笔通路**：Raw Input **已弃用**（设备在列表里却零 WM_INPUT ⇒ 注册成功 ≠ 收得到）；**采样源 = 系统光标**（`GetCursorPos` 250Hz，依据「包冻结而光标仍在动」）。拟合**必须两趟**（粗拟合→剔离群→重拟合），判据 = 保留集 ≥150 + 逐轴 rms ≤8 + 跨度 ≥1000，不成立则**一个字节都不写**。补流门控 = `enNow` + `realAge ≥250ms` + `rawAge ≤150ms`；**必须丢冲包**（否则弧线倒着画回）。⛔ **真机实测（2026-10-16）：强拟合判据在本机永远达不到**（rms 9.7~19.4 ≫ 8.0，跨度常卡 572）⇒ 补流 **100% 靠解析兜底**在扛，`拟合=未建立` 是常态、不是故障。
- ⛔⛔ **过冲根因（2026-10-16 真机定案）**：`[dead] 恢复：★冲包量=48 包`（≈驱动队列容量；48÷200Hz ≈ **240ms** 位移一瞬间灌入）。旧守卫「单次 ≥ `RI_BIG_BURST`(25) 包 = 冲包」是**死代码** —— 真机 `最大单次∈{0,1,3,4,5}`、`≥25包次数` 与 `丢冲包` **恒 0**（PS 每拍只取 1~5 包 ⇒ 48 包被拆成十几拍，任何「单次包数」门限都拦不住）。⇒ 补流已把笔尖喂到**当下**，驱动再把 240ms 前的旧坐标**追加**在它后面 ⇒ 选区**倒退再猛追** = 过冲 ⇒ 紧随收笔 + 选区一次生成 + 自动填充。⛔ **判据按时间不按包数**：真实包早于**补流前沿 `g_synFrontT`** 即陈旧，只丢**队首连续**段、追上前沿就停手。⛔⛔ **连带修复**：`g_lastRealMs` 必须按 **`rRaw`（驱动原始返回）**记 —— 按丢包后的 `r` 记会**自锁**（r 被丢成 0 ⇒ realAge 继续涨 ⇒ 补流永不停）。
- ⛔⛔ **0x0111→0x0112：陈旧判据重做（2026-10-16 第十八轮）**。0x0111 是**死代码**（真机 150/151 采样 `陈旧包=0` 恒成立、日志一次没触发），根因两条：① **护栏「用陈旧幅度反推时间基」**（`|now−pkTime| ≤ 5000`）—— 停摆 13s/111s 时恢复包**天生**那么旧 ⇒ 判「不同基」⇒ **整条放弃**（**量纲混淆：「包有多旧」≠「时间基是否一致」**）；② 窗口以「补流结束」为起点（3s），而真机补流 `18:33:51.077` 结束、恢复 `18:34:01.610` = **10.5s 后** ⇒ 窗口早过。⇒ 0x0112 三条修法：① `g_pkBaseOk` 改**正面证据**（见过 `age ≤ 400ms` 的包 ⇒ 同基，此后前沿比较**不受幅度限制**）；② `g_lastRecovMs` 窗口改「**停摆恢复**后 4s」（`prevRealAge >= RI_STALL_MS(250)` 打点，⛔ 必须在更新 `g_lastRealMs` **之前**取 `prevRealAge`）；③ 新增**按包龄**判据（`age > RI_PKT_STALE_MS(1500)`）覆盖「停摆期没补流」。两条判据**并列**，三道护栏任一不成立**一个字节都不动**。⛔ **铁律：判定能力不能建立在「待证明的前提」上。**
- ⛔⛔ **进程内工具闸门（`'slct'`，0x0112 新增，文件 `native/PiSmooth8li/ps_tool.c`）**：`SPBasicSuite=md+0x18`、`self=md+0x08`；三 suite `df135117-…ec47`/`bc1e4d70-…f7ee`/`df135115-…ec47`，**version=整数 2**；注册 `ctrl+0x20(refcon,'slct'=0x736c6374,proc)`、注销 `ctrl+0x28(refcon,'All ')`、释放 `basic+0x08(uuid,2)`；偏移 `desc+0x28`GetCount/`+0x18`GetKey/`+0x10`GetType/`+0x100`GetReference/`ref+0x18`GetDesiredClass/`ctrl+0x18`TypeIDToStringID；判据 `GetType()=='obj '(0x6f626a20)` → 类名 `strstr(buf,"Tool")`。⛔ 方法指针返回类型**一律 `short`**（LNP 只读 `ax`）；引用槽**给足 16 字节**（少给=栈越界写）。⛔⛔ **三态接管**（宁可不用不可误用）：`0`不可用 / `1`已注册未读数 / `2`已接管 —— **只有 2 才让面板停轮询**，任一步失败退回旧行为（fail-open）。⛔ **接管后三处必须同步**：① 面板 `syncSmoothToolWatch()` 停表；② `applyToolGate()` 开头 `return`（**唯一咽喉**：`pollSmoothToolGate` 与 `pollToolChange` 都走它）；③ 原生 `write_params()` **不再写 `I_TOOLGATE`** —— 两边都写就是互相覆盖（各自刷戳 ⇒「谁都新鲜」⇒ 切了不生效/换回不恢复）。⛔ 有效性实测：LNP `log_photoshop.txt` `setPSTool(): PS tool name: lassoTool` 于 **PS 2026/27.8 今天跑通**。⛔ 新字段 `toolSrc`/`psTool`（`-1`=对端不报 ⇒ 面板保持轮询）。
- ⛔⛔ **modal scope 暴涨根因 = 面板 300ms 工具巡检恰好吃满预算**：`MIN_MODAL_GAP_MS=300` ⇒ 上限 **3.3/s**，而巡检间隔**就是 300ms** ⇒ 请求率 ≈ 上限；叠加自动填充（本身必弹模态）即超吞吐，低配机填充更久 ⇒ 窗口更长。停掉巡检即解除。
- ⛔ **变参日志的 tag 陷阱**：`pstool_log` 是**单 `fmt` 变参**（tag 写死在 `log_line("ps_tool",…)` 内部）⇒ 调用点多传一个首实参会被当 `fmt`，**真文案与占位符全废**、只打出一行 `ps_tool`，而**编译器不报错**（变参合法）= 静默缺陷。新增变参日志接口时先看清它收不收 tag。

## 其他 UI / 构建铁律

- ⛔ `putPixels` 的 `replace` 默认 true ⇒ 局部写清空整层；写回 = 全尺寸缓冲 + 不传 targetBounds。背景层解锁→清除→finally 还原；类型转换后一次 DOM 都不能读。
- ⛔ `clearEnum` 在背景/锁透明层不可用 ⇒ 分支 9 `blendSubtraction`；单通道描边走 7/8；静默化只认 batchPlay **options 层**；`needsStroke` 时填充传 `deselectAfterFill:false`。
- ⛔ CSS 注释块外游离文本被当选择器、静默吃掉紧随整条规则 ⇒ 改完必跑 guard。⛔⛔ `theme.ts` 的 CSS 注释一律写在 `{ }` 外（`style.textContent` 运行时注入，声明块内注释被当声明 ⇒ CssSyntaxError；guard 不扫它，靠人工）。
- ⛔ flex 容器相邻子元素外边距不合并 ⇒ 需显式 `> .row-between{margin:0}` + `+ .row-between{margin-top:10px}`。⛔ 跨文件置灰必须两级类选择器（style-loader 注入序）；`gap`/`:has()`/`rotate()` 不可靠；`transparent` 渲染成纯黑。
- ⛔ 多浮窗 = 单遮罩 + 一个 `.float-stack`；子面板互斥唯一入口 `setSecondaryPanel(id,open)` 一次写全 5 个 boolean。
- ⛔ 闸门三件套 `isPsBusy()`+文档级闩锁+`psAccess.psRead()`；禁采信 `core.isModal()`（判据 `getOwnModalDepth()>0`）；`runAsModal` 绝不直接传第二实参。⛔ modal 告警 = 请求率 > 节流吞吐（`MIN_MODAL_GAP_MS=300` 全局 ⇒ 上限 3.3/s；空闲巡检合计须 <3.3）。⛔ **参与渲染的判据一律按 state 派生**。
- ⛔ **.8li 安装/更新通路尚未面板化**（M3 遗留）：「服务未启动」= .8li 没装进 PS Plug-ins，需手动部署。

## 记忆维护约定

- `MEMORY.md` = 索引 + 铁律（**保持精简**，超限必先精简）；`refs/*.md` = 明细；`YYYY-MM-DD.md` = 当日流水（append-only）。技能：`uxp-frontend-spec`、`algo-param-bench`。
