# JWautofill 项目记忆（主索引）

> 细节全在 `refs/`。⛔ 违反必炸｜⚠️ 易复发｜✅ 有 guard。流水账见 `memory/YYYY-MM-DD.md`。
> ⛔⛔ **2026-10-14 架构**：套索平滑 = **PS 进程内 .8li 插件**（`native/PiSmooth8li/`）；
> 旧 SmoothDaemon / 注入式 WintabHook.dll 已整体删除（M3）。平滑引擎算法细节仍见
> `refs/lasso-smoothing.md`（已加变更横幅），当前架构一手记录 = `docs/lasso-pipl-8li-migration-plan.md`。

## 我要改什么 → 读哪里

| 要动的东西 | 先读 |
| --- | --- |
| 填充 / 描边 / 清除 | `refs/fill-and-stroke.md` |
| CSS / 布局 / 新建面板 / 主题 | 技能 **uxp-frontend-spec** → `refs/frontend-css.md` |
| 忙碌闸门 / 模态 / 世代号 | `refs/busy-gate.md`（唯一权威） |
| UXP 接口 / 性能 / React | `refs/uxp-api-layer.md` |
| 像素处理器算法 | `refs/pixel-algorithms.md` |
| 构建 / 菜单 / 文件 IO / 守护进程 | `refs/toolchain-and-env.md` |
| 套索平滑（引擎算法仍有效） | `refs/lasso-smoothing.md` + .8li 迁移计划 |

**改完必备校验**：改过 CSS 必跑 `node scripts/_css_comment_guard.cjs`（⚠️ 只扫 `src/styles/*.css`，不扫 `theme.ts`）+ `_modal_contract_guard.cjs` + `_color_picker_contract_guard.cjs`；`npx tsc --noEmit` 只看 `src/` 新增报错（`'uxp'`/`'photoshop'`、`ffi.d.ts` 语法错为基线）。

## 仓库地图（要点）

`src/app.tsx` 选区填充父面板 · `AdjustmentPanel.tsx` 工具箱父面板 · `psProbe.ts`+`psAccess.ts` 闸门与模态 · `ClearAlgorithms.ts` 清除算法唯一来源 · `adjustments/*Processor.ts` 像素处理器（零 import）· `common.css`+`theme.ts` 样式主题唯一来源 · `helpTexts.ts` hover 文案 · `src/hotkey/` = `HotkeyBridge.ts`(18923 笔刷热键 daemon)+`SmoothBridge.ts`(18924 对端=.8li)+`LassoSmoothing.ts`（纯状态机无 WS）· `native/` 现存：`HotkeyDaemon/`（唯一 daemon，Program.cs 仅热键角色）+ `PiSmooth8li/`（平滑插件，`build.sh` 用 zig）+ `app.manifest` + `get-zig.sh` · `analysis/`、`outputs/` gitignore 不跨机。

## 铁律（速查；细节在 refs/）

- **dist 红线**：⛔ docs 进 dist 走**白名单**（仅 fill-guide.html + toolbox-guide.html + img/，webpack 逐个列；计划书/分析报告一概不进）。历史教训：黑名单 ignore `*plan*.md` 漏放了 modal-scope-audit.md（2026-10-15 用户发现）⇒ 追不上新文件。webpack 不清旧产物 ⇒ 改规则后手删残留复验。当前 dist≈148M：native 只剩 HotkeyDaemon（daemon+publish+卸载 bat/ps1+FixKeyboard）。
- ⛔⛔ **.8li 真机铁律**：① PiPL 头部=10 字节；② `'8664'` 入口导出名属性=**C 字符串**（Pascal 串 ⇒ GetProcAddress 失败 ⇒ attach 后 1ms 静默卸载）；③ 加载消息=`"SP Access"/"Reload"`，卸载=`"SP Access"/"Unload"`；④ 引擎+WS 层合并镜像，**无 daemon 无注入**；⑤ 自写 SHA1 必须用已知向量实测（RFC6455 App.A），JSON 内 Windows 路径转义反斜杠。⛔ PS 运行时锁 Plug-ins 里的 .8li ⇒ 覆盖部署必须先关 PS；Plug-ins **只能有一个** JWautofillSmooth.8li。⛔ 旧 SmoothDaemon 若在跑会占 18924 ⇒ .8li bind 失败（本机已于 M3 卸载）。
- ⛔ **GATETS 由 pump 接管**：有 WS 客户端连接即每 500ms 刷（面板 1500ms 心跳实测不可靠 ⇒ reason=4 fail-closed）；全断 ⇒ 停刷 ⇒ 3s 过期语义保留。⛔ 独立实测必须关 PS（旧副本占 18924，SO_REUSEADDR 双绑定会接走测试连接）。
- ⛔⛔ **包流断供 = 「易失效」深层根因**：PS 空轮询 WTPacketsGet 但同 hCtx 恒返 0 包数分钟、penDown 卡 1 ⇒ 驱动侧断流、PS 走非 Wintab 回退（笔迹在、平滑死）。⛔⛔ **自愈演进 + 证伪（2026-10-16 真机判决）**：0x0106 把主杠杆换成 `WTOverlap(hCtx,TRUE)` + 前台期每 500ms「保持顶层」预防 ⇒ **被真机证伪**：`自愈 #1…#120` 全返 1（请求被接受）却一包未回，「保持顶层」跑满 199 次也拦不住；永久断流仍在（jwwh-25000 冻 **385s+**）；开关卸载重挂也救不回（重挂只换钩子、不动 PS 的 hCtx）。恢复时长确有改善：~9s(0x0105) → 2.9/4.2/5.8s(0x0106 前 3 次)。**⇒「被挤出重叠序」至少不是全部真相**；新嫌疑（待验）：① WTEnable(FALSE) 翻转对上下文**累积损伤**（678s 与 385s 两次永久断流都发生在多轮翻转之后）；② PS 在 Wintab 与系统级输入间切换（笔迹在、Wintab 恒 0 包、`单包=0`）。⚠️ 断流频发是**长期现象**（0x0102 曾 11 次/场），真正的病是**永久断流**。⛔ **HUD pktAge 无符号下溢**（`smooth_engine.c:3217/3173/2762`）：`(DWORD)(now - g_snMs)` 在 g_snMs 略超前（跨线程竞态）时下溢成 ~4.29e9 ⇒ `activeNow=0` ⇒ **笔正落纸面 HUD 却不显示**（日志 `active=0(t=4294967280ms) gate=1`）；改用 `(LONG)(DWORD)(…)` 有符号比较。⛔ Y 符号投票翻转 ⇒ AXCAL.signLocked **首达即锁**。⛔ **落笔锁存超时**（2026-10-15）：`penDown` 只在来包时更新 ⇒ 包流一断就永久卡 1（实测 4 分 17 秒）⇒ 无包 >5000ms(TIME_GAP_RESET_MS) 强制清 penDown/contact/strokeGate + 报 RS_HOVER；**不动 g_wasEnabled**（动会引入「圆忽然闪现」回归）。⛔ **DPI/分辨率适配**：PS 实测 PER_MONITOR_AWARE ⇒ 进程内 SM_CXVIRTUALSCREEN / GetCursorPos / 驱动 lcOutExt **全是物理像素**，坐标口径没错，缺的是**尺度** ⇒ 统一 `g_dpiScaleMilli`（整数毫倍，detour 读 LONG 原子；`dpi_scale()` 只在 worker/HUD 用；shcore!GetDpiForMonitor **动态**取，取不到退 1.0×）；半径/绳长、追笔 vmax、SPEED_FULL、CORNER_MIN_PX、jumpPx、CUR_SAMPLE_MIN、看门狗 6/8px、HUD 边长**一律 ×dpiS**（150% 屏半径 100 ⇒ 150 物理 px）。新增像素常量必须先问「逻辑还是物理」。⛔ 换显示器/缩放/映射重标定 = 比对 **屏幕尺寸 ‖ DPI 缩放 ‖ 驱动 lcOut* 指纹**（只比尺寸会漏）；指纹**每拍刷新**。📌 **PS 插件目录 = `C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\`**（2026-10-16 实测；旧记录写的「E 盘」**是错的**，E 盘根本无此目录）。目录内只有**一个** `JWautofillSmooth.8li` ⇒ 部署只需覆盖这一个（历史提到的 `.ready.8li` 已不在）。⛔ PS 运行时锁该文件 ⇒ 覆盖前必须**全部退出** PS 进程（本机常有 3 个同时存在）。⛔ shutdown 消息 = 开关 OFF ⇒ commit(0)，**绝不退出宿主进程**。HUD 显隐必须判 CFG_I_ENABLED。
- ⛔ `putPixels` 的 `replace` 默认 true ⇒ 局部写清空整层；写回 = 全尺寸缓冲 + 不传 targetBounds。背景层解锁→清除→finally 还原；类型转换后一次 DOM 都不能读。
- ⛔ `clearEnum` 在背景/锁透明层不可用 ⇒ 分支 9 `blendSubtraction`；单通道描边走 7/8；静默化只认 batchPlay **options 层**；`needsStroke` 时填充传 `deselectAfterFill:false`。
- ⛔ CSS 注释块外游离文本被当选择器、静默吃掉紧随整条规则 ⇒ 改完必跑 guard。⛔⛔ `theme.ts` 的 CSS 注释一律写在 `{ }` 外（`style.textContent` 运行时注入，声明块内注释被当声明 ⇒ CssSyntaxError；guard 不扫它，靠人工）。
- ⛔ flex 容器相邻子元素外边距不合并（`.smooth-params` 两行 10+10=20px vs 块级合并 10px）⇒ 需显式 `> .row-between{margin:0}` + `+ .row-between{margin-top:10px}`。⛔ 跨文件置灰必须两级类选择器（style-loader 注入序）；`gap`/`:has()`/`rotate()` 不可靠；`transparent` 渲染成纯黑。
- ⛔ 多浮窗 = 单遮罩 + 一个 `.float-stack`；子面板互斥唯一入口 `setSecondaryPanel(id,open)` 一次写全 5 个 boolean。
- ⛔ 闸门三件套 `isPsBusy()`+文档级闩锁+`psAccess.psRead()`；禁采信 `core.isModal()`（判据 `getOwnModalDepth()>0`）；`runAsModal` 绝不直接传第二实参。⛔ modal 告警 = 请求率 > 节流吞吐（`MIN_MODAL_GAP_MS=300` 全局 ⇒ 上限 3.3/s；空闲巡检合计须 <3.3）。⛔ **参与渲染的判据一律按 state 派生**。
- ⛔ 无原生编译器 ⇒ zig 走便携工具链（`native/get-zig.sh`→`%USERPROFILE%\zig-toolchain`，现用于 .8li 构建）；编译须沙箱外跑。⛔ 改 `Program.cs`（热键 daemon 唯一源码）后：`dotnet publish -o publish` → `yarn build`；更新已装副本只有「服务开关先关再开」。
- ⛔⛔ **IPC 数字字段双防御**（2026-10-14 真机定案）：面板 `toWire()` 出口对所有数字一律 `Math.round`（唯一咽喉）；原生侧字段用 `double?`+赋值 Round。漏一个浮点 ⇒ 整条消息被丢 ⇒ 「切换模式后平滑就断」。**新增 IPC 数字字段必须同时做这两件事**。
- ⛔ **卸载脚本只删自己那份安装目录**；绝不 `Remove-Item -Recurse` 整个 `%LOCALAPPDATA%\JWautofill`（会删 `configpath.txt` ⇒ 热键配置被默认值冲掉）。面板卸载兜底唤起 `native/HotkeyDaemon/uninstall.bat`（→ 同目录 uninstall.ps1）。⛔ 2026-10-14 用户决定**回退** 98cc3e9 的 JWUninstall.exe 启动器方案（dist +76M 不划算）⇒ UninstallLauncher 项目已删，勿再引入；若实测 .bat 唤起不稳定（窗口一闪而过）再评估别的通路。`.bat` 用 `if errorlevel 9009 pause`，倒计时成功 5s/失败 15s。
- ⚠️ **环境坑：genie-trash**：对多文件目录报 "Some operations were aborted" 但**实际已移动**（包装器 fail-closed 误报），且会**延迟回滚重建空目录**。对策：逐文件删容忍报错 + 空壳用 `[System.IO.Directory]::Delete(p,$false)` 收尾 + 删后复验。

## 套索平滑（速记）→ `refs/lasso-smoothing.md` + .8li 迁移计划

- 唯一通路 = Wintab 笔通路，实现 = **PS 进程内 .8li**（smooth_engine.c inline-hook `WTPacketsGet`；plugin_main.c 承载 WS 18924，协议与旧 daemon 逐字兼容）。⛔ 换 .8li 必须重启 PS（PS 锁文件）。状态周期推送（SmoothStatePump 500ms）。
- 状态机 `CFG_I_STATE`：0 未挂 · 1 生效 · 2 标定失败 · 3 已卸载 · 4 入口被占（须重启 PS）。
- ⛔⛔ **坐标口径**：系统光标 = 原始笔 ⇒ HUD 圆钉「光标−(raw−out)·px」。⛔⛔ **px 唯一权威 =
  屏幕/lcOutExt**（2026-10-15 [gap] 回归定案，rms 3.8/4.2px；本机=1/16 px/轴，包坐标与 lcOutExt
  同单位；标准驱动下公式自动得 1.0）。**旧权威 屏幕/lcInExt 是错的**（X 高估 22.9%/Y 低估 22.0%
  = 「横领先/竖落后」残差根因）；「lcOutExt/lcInExt 再搜 2^n 定标」错上加错（1.2286/0.7784 本身
  就是误差系数）。N1 悬案「光标实测 Δ 偏低且漂 −40%」昭雪：那是真实尺度，不是噪声。axisMax 亦改
  用 lcOutExt（同源口径）。符号仍由光标投票裁决。
- ⛔⛔ **HUD 外推两端对称**：`光标(此刻) − offset(时刻) = 绘制点(时刻)`；raw 与 out 用同一 `age/pktDt` 同时外推（只外推 raw ⇒ 圆心恒差 15px/100px 绳）。
- ⛔⛔ **`TIME_GAP_RESET_MS` 假复位**：停笔不再出包 ⇒ 旧 120ms 把「停一下再画」误判新一笔；现值 **5000ms** + `HUD_HOLD_MS=3000`。
- ⛔⛔ **拉绳 = 定长绳**：`dist ≤ rope` ⇒ 输出点不动；`> rope` ⇒ 跟随量 `dist − rope`（**`f = 1 − rope/dist`**；写成 `rope/dist` ⇒ 输出点直接跳光标）。绳长 ≡ 半径；绳 = 统一 2px + 二次贝塞尔（垂度 `sag=sqrt(3(L−d)d/8)`）；**绝不画 4→1px 锥形**。
- ⛔⛔ **落笔判据 = 多信号并联**：`buttons(&0x07)/pkNormalPressure/pkTangentPressure` 任一非零 = 落笔；三者全零持续 `CONTACT_HOLD_MS=250ms` 才算抬笔。⛔ 每个信号必须「同时见过 0 与非 0」才有投票权（恒 0/恒非 0 字段自动出局，消灭「悬空也在平滑」）。判据未建立：冷启动宽限 600 包，之后按未落笔阻断。
- ⛔ **诊断条只认原生侧原因码**（`RS_*` ↔ C `CFG_I_REASON` ↔ TS `SmoothReason`，三处逐项对应）：0 改写 · 1 开关未开 · 2 非套索 · 3 工具未知 · 4 心跳过期 · 5 悬空 · 6 判据未建立 · 7 未标定 · 8 无上下文。⛔ 禁止面板自己拼 `toolOk/penDown/gateOk`（闸门不成立时原生侧主动把 penDown 写 0）。非正常原因粘住 `SMOOTH_REASON_STICKY_MS=8000`；`gateOpen/gateClose` 是累计值 ⇒ 判抖动只能用**增量**。
- ⛔ **状态条** `state===1` 只有两档：「生效中」(绿)/「平滑中断」(红，判据 `penDown=1 && gateOk=1 && 有包 && snAge>2.2s`)；不按模式分叉；「生效中」后不挂参数；`state===3` → 「未生效（正在自动恢复…）」。
- ⛔ **量程落在人的运笔区间（0.05~1.5 px/ms）**：`SPEED_FULL=3.0`、强度 τ(100)=250ms、追笔 vmax 上限 3.0 px/ms；改上限同步搜 `RADIUS_PX_MAX`/`SMOOTH_RADIUS_MAX`/C 侧 Clamp。⛔ **拐角=转折角**；`cornerToNative` 反向映射已回退为**恒等**，别再引入。⛔ 追笔映射 `catchUpToNative(d)=round(50−(d−1)·49/99)`（d=1→50 跟手，d=100→1 最黏；下限 1 不是 0）。
- 共享内存槽位 **保留空洞、绝不重编号**（与 C `I_*` 逐项对应，错位不报错）；改 NLONGS 必读 refs 的「扩容升级陷阱」（旧节占着 ⇒ fail-closed，重启 PS 自愈）。
- ⛔ **.8li 安装/更新通路尚未面板化**（M3 遗留）：「服务未启动」= .8li 没装进 PS Plug-ins，需手动部署。
- ⛔⛔ **部署只认 `build/JWautofillSmooth.8li`**（build.sh 唯一产物，2026-10-15 定案）；`.ready.8li`
  是历史手工残留（已从 build/ 删除），Plug-ins 里若还有必须删 —— 3440 机就因它测了一下午旧版。
  核验：日志头 `ver=0x0102`（≥10-15 下午）、`[status]` 含 `dpi=N‰`。
- ⛔ **断流（g_streamDead）期 HUD = 红圈钉光标 + 不画绳**（deadShow，penDown 清零后收起），不是隐藏；
  断流根因在**驱动侧**（本机 WTEnable 自愈 0/12 全败），daemon 注入方案同死 —— 非平滑算法缺陷。

## 记忆维护约定

- `MEMORY.md`=索引+铁律（≤3000 字）；`refs/*.md`=明细；`YYYY-MM-DD.md`=当日流水（append-only）。技能：`uxp-frontend-spec`、`algo-param-bench`。
