# JWautofill 项目记忆（主索引）

> 细节全在 `refs/`。⛔ 违反必炸｜⚠️ 易复发｜✅ 有机 guard。流水账见 `HISTORY.md` 与 `memory/YYYY-MM-DD.md`。

## 我要改什么 → 读哪里

| 要动的东西 | 先读 |
| --- | --- |
| 填充 / 描边 / 清除 | `refs/fill-and-stroke.md` |
| CSS / 布局 / 新建面板 / 主题 | 技能 **uxp-frontend-spec** → `refs/frontend-css.md` |
| 忙碌闸门 / 模态 / 世代号 | `refs/busy-gate.md`（唯一权威） |
| UXP 接口 / 性能 / React | `refs/uxp-api-layer.md` |
| 像素处理器算法 | `refs/pixel-algorithms.md` |
| 构建 / 菜单 / 文件 IO / 守护进程 | `refs/toolchain-and-env.md` |
| 套索实时平滑 | `refs/lasso-smoothing.md`（唯一权威） |

**改完必备校验**：改过 CSS 必跑 `node scripts/_css_comment_guard.cjs`（⚠️ 只扫 `src/styles/*.css`）+ `_modal_contract_guard.cjs` + `_color_picker_contract_guard.cjs`；`npx tsc --noEmit` 只看 `src/` 新增报错（`'uxp'`/`'photoshop'`、`ffi.d.ts` 语法错为基线）。

## 仓库地图（要点）

`src/app.tsx` 选区填充父面板 · `AdjustmentPanel.tsx` 工具箱父面板 · `psProbe.ts`+`psAccess.ts` 闸门与模态 · `ClearAlgorithms.ts` 清除算法唯一来源 · `adjustments/*Processor.ts` 像素处理器（零 import）· `common.css`+`theme.ts` 样式主题唯一来源 · `helpTexts.ts` hover 文案 · `src/hotkey/` = `HotkeyBridge.ts`(18923)+`SmoothBridge.ts`(18924)+`LassoSmoothing.ts`（无 WS）· `native/HotkeyDaemon/Program.cs` 两守护进程唯一源码（`#if ROLE_SMOOTH`）· `native/UninstallLauncher/` 卸载启动器 · `analysis/`、`outputs/` gitignore 不跨机。

## 铁律（速查；细节在 refs/）

- **dist 红线**：⛔ 实现计划/设计文档（`*plan*.md`）不进 dist（webpack globOptions ignore，2026-10-12 铁律）；webpack 不清旧产物 ⇒ 改规则后手删残留复验。
- ⛔ `putPixels` 的 `replace` 默认 true ⇒ 局部写清空整层；写回 = 全尺寸缓冲 + 不传 targetBounds。背景层解锁→清除→finally 还原；类型转换后一次 DOM 都不能读。
- ⛔ `clearEnum` 在背景/锁透明层不可用 ⇒ 分支 9 `blendSubtraction`；单通道描边走 7/8；静默化只认 batchPlay **options 层**；`needsStroke` 时填充传 `deselectAfterFill:false`。
- ⛔ CSS 注释块外游离文本被当选择器、静默吃掉紧随整条规则 ⇒ 改完必跑 guard；「反复改没效果」立即停手验证命中。
- ⛔⛔ **`theme.ts` 的 CSS 注释一律写在 `{ }` 外**：它用 `style.textContent` 运行时注入，UXP devtools 把**声明块内注释当一条声明**解析 ⇒ 后台刷 `CssSyntaxError: Unknown word / Missed semicolon`（`source` = 注释原文）。⚠️ `_css_comment_guard.cjs` **只扫 `src/styles/*.css`，不扫 `theme.ts`** ⇒ 这里要靠人工对照（refs/lasso-smoothing.md §N6）。
- ⛔ **flex 容器相邻子元素外边距不合并**：`.smooth-params`（`flex-direction:column`）两行间隔 = 10+10=20px，而块级 `.slider-container` 合并成 10px ⇒ 对齐「不透明度/羽化」必须显式 `> .row-between{margin:0}` + `+ .row-between{margin-top:10px}`。
- ⛔ 跨文件置灰必须两级类选择器（style-loader 注入序）；`gap`/`:has()`/`rotate()` 不可靠；`transparent` 渲染成纯黑。
- ⛔ 多浮窗 = 单遮罩 + 一个 `.float-stack`；子面板互斥唯一入口 `setSecondaryPanel(id,open)` 一次写全 5 个 boolean；遮挡类按 state 派生。
- ⛔ 闸门三件套 `isPsBusy()`+文档级闩锁+`psAccess.psRead()`；禁采信 `core.isModal()`（判据 `getOwnModalDepth()>0`）；`runAsModal` 绝不直接传第二实参。
- ⛔ **参与渲染的判据一律按 state 派生**（异步写入不重渲染 ⇒ 界面停旧判定）。
- ⛔ 无原生编译器 ⇒ 注入 DLL 靠便携 zig（`native/get-zig.sh`→`%USERPROFILE%\zig-toolchain`）；编译须沙箱外跑。
- ⛔ 改 `Program.cs` 后三步：两角色分别 `dotnet publish -o publish` → `yarn build`；更新已装副本只有「服务开关先关再开」。
- ⛔⛔ **`penSmooth` 整帧丢失 = 一个字段类型不符**（2026-10-14 真机定案）：`PenWire` 数字字段原先全是 `int?`，面板只要漏出一个浮点（如 `radius:95.5`）就会让 System.Text.Json **抛异常**，外层 catch 把**整条 `penSmooth`**（含 on/mode/toolGate/heal/broadcast）一起丢掉 —— 现象正是用户感知的「切换模式后平滑就断」（`daemon.log` 137 条 `could not be converted to Nullable<int>`）。两层防御：① 面板 `toWire()` 出口对所有数字一律 `Math.round`（唯一咽喉）；② daemon `PenWire` 数字字段用 `double?` + 赋值时 Round。**新增 IPC 数字字段必须同时做这两件事**。

## 套索实时平滑（速记）→ `refs/lasso-smoothing.md`（唯一权威）

- 唯一通路 = Wintab 笔通路（`SmoothDaemon` 经共享内存注入 `JWautofillWintabHook.dll`，inline-hook `WTPacketsGet`）；面板「平滑选项」是一条 notify-bar；装目录 `%LOCALAPPDATA%\JWautofill\smooth`。⛔ **换 DLL 必须重启 PS**（旧 DLL 被锁）；状态必须**周期推送**（`SmoothStatePump`）。
- 状态机 `CFG_I_STATE`：0 未挂 · 1 生效 · 2 标定失败 · 3 已卸载 · 4 入口被旧副本占（须重启 PS）。「已平滑 N 包」只计真实改写包。
- ⛔⛔ **坐标口径**：系统光标 = **原始笔** ⇒ HUD 圆钉在「光标−(raw−out)·px」= 绘制点。⛔⛔ **px 的唯一权威 = 驱动 `lcOutExt / lcInExt`**（`g_pxSrc=1`，含符号、无需测量；合理性判据 `|drv| ∈ (0.15·标称, 1.02·标称]`，否则退回屏幕标称）；光标测的 `Δ光标/Δraw` **偏低且漂**（真机 [status] 0.0466~0.0676 vs 屏幕标称 3440/44800=0.076786，最差偏低 40%），已**降级为日志对照**。**逐轴带符号**（lcInExtX=44800 / lcInExtY=29600，比差 1.58 倍，单标量不成立）。⛔ 曾有一条**标定断链真 bug**（`calib_axis` 写 `g_axCal*.px`，`px_x/px_y` 却读 `g_pxAxisX/Y`）⇒ 查「调参无感 / HUD 位置不对」必先查它；日志 `calX/calY=1` 才是实测。
- ⛔⛔ **HUD 外推必须两端对称**（2026-10-14 第五轮真 bug）：`光标(此刻) − offset(此刻) = 绘制点(此刻)`。只把 raw 外推到当前帧、out 停在**包时刻** ⇒ 圆心离真实绘制点恒差 **15px**（100px 绳）。`sn_publish` 记 `g_snPrevOutX/Y`，HUD 用同一 `age/pktDt` 同时外推 raw 与 out；一致快照校验字段 8 → **10** 个。
- HUD 老根因（已修）：`LOGCONTEXT` 漏 `lcDevice`；`layout_of` 把 ORIENTATION/ROTATION 当 4B；驱动报的 `lcPktData` ≠ 真实布局 ⇒ 必须**盲扫定解**（本机 stride=52 offX=20 offY=24）。
- ⛔ **示意图 ≠ 测量数据**（用户纠错）：几何量化只能来自日志/实测，或用户**明确确认为真实**的截图。
- ⛔⛔ **`TIME_GAP_RESET_MS` 假复位**：数位板停笔**不再出包** ⇒ 旧 120ms 把「停一下再画」误判成新一笔、输出点拽回笔尖；现值 **5000ms** + `HUD_HOLD_MS=3000`；`rst=a/g/j` 正常运笔不增长。
- ⛔⛔ **拉绳 = 定长绳**：`dist ≤ rope` ⇒ 输出点不动；`> rope` ⇒ 跟随量 `dist − rope`，即 **`f = 1 − rope/dist`**（写成 `rope/dist` 会让输出点**直接跳到光标** ⇒ 选区成一段段直线）。绳长 ≡ 半径（「张力」已删）。绳 = 统一 **2px** + 二次贝塞尔，垂度 `sag=sqrt(3(L−d)d/8)`（d→L 自然拉直）；**绝不画 4→1px 锥形**。
- ⛔⛔ **平滑「时有时无」** = DLL 被 `cmd=2` 卸钩（`RequestUnhook` 也会发）而守护进程以为还开着 ⇒ 必须自愈：`PenHook.HealIfUnhooked`（`_enabled` 真 且 `I_STATE==3` ⇒ `SendCommand(1)`，冷却 2s；state==4 不自愈）。
- ⛔⛔ **拉绳「圆心与受力点分离」= 标定器形状，不是参数**（2026-10-14 真机定案）：旧版把**比值的 EMA** 当估计量（等效窗口仅 3~20 样本）⇒ `pxX/pxY` 抖动 19 种、偏 ±25% ⇒ 圆心偏 = 滞后×px ⇒ 100px 绳偏约 25px，肉眼即「分离」。已改**位移加和** `px = s·Σ|Δ光标|/Σ|Δ原始轴|`（窗口 `PX_WIN=256`，噪声按 √N；判据 `PX_TRUST_N=24` 才 `done=1`，之前回标称兜底）。⛔ 别再加「离群丢弃/整值作废」——那本身就是抖动源。⚠️ **第五轮起 px 的主来源改为驱动 `lcOut*`（见上一段），标定器只在驱动不可用时兜底、且仅作日志对照**。
- ⛔⛔ **落笔判据 = 多信号并联**（2026-10-14 第五轮，**单字段版已废**）：`buttons(&0x07) / pkNormalPressure / pkTangentPressure` **任一非零 = 落笔**；三者全零且持续 `CONTACT_HOLD_MS=250ms` 才算抬笔。旧版只认一个字段（真机 `ctOff=32`=NP），轻触运笔时 NP **成段**读到 0 ⇒ 闸门反复闭合 ⇒ 每次 `g_wasEnabled=0`（重新锚定）+ 同判据驱动 HUD ⇒ **平滑与 HUD 同时失灵**（诊断条 `判据 +32=0`）。⛔⛔ **每个信号必须「同时见过 0 与非 0」才有投票权** ⇒ 恒 0 字段（部分驱动的 pkButtons）/ 恒非 0 字段（pkCursor/Orientation/pkZ）**自动出局**，不需要盲扫猜字段，也消灭「悬空也在平滑」。判据未建立：冷启动宽限 600 包放行，之后**按未落笔阻断**（`RS_CT_UNKNOWN`）。判读用新日志行 `# [ct] 信号=+16* +32* +36 生效=7 本批命中=2 连续全零=37 包`（`*`=有投票权；**连续全零 ×5ms = 闸门被压住多久**，运笔中 >20 包 = 判据成段失效）。
- ⛔ **HUD 显隐六条件** = `wnd && mem && activeNow && gateOk && ropeMode && (hf&1)`；不显示时先读日志 `[hud] 未显示: …`（2s 节流，逐项打出 `wnd/mem/active/gate/rope/hudBits`）。
- ⛔⛔ **卸载脚本只删自己那份安装目录**；第 7 步**只能回收空目录** —— 绝不 `Remove-Item -Recurse` 整个 `%LOCALAPPDATA%\JWautofill`：它会删掉 `configpath.txt` ⇒ 守护进程回落默认路径、读到空配置 ⇒ 面板按「首次使用」回写默认值，把用户热键冲掉；还会删掉另一角色的 `smooth\`。热键配置回写护栏 `canPersistConfig`：daemon 回帧的 `path` 与面板下发的必须**逐字相同**（只判「非空」不够 —— 默认路径字符串也非空）；守护进程覆盖前留 `<配置>.bak`。
- ⛔ **卸载必须唤起 `.exe` 启动器**（`native/UninstallLauncher/JWUninstall.exe` → 同目录 `uninstall.ps1`）：`shell.openPath` 对 `.bat` 不稳定（不出现 / 闪退）。钩子 DLL 落 `%TEMP%\JWautofill\hooks\`（PS 会锁住安装目录 ⇒ 卸载删不掉）。重试 8×500ms、失败**不 throw**、倒计时 **15s**（两边一致）、`.bat` 用 **`if errorlevel 9009 pause`**。
- ⛔⛔ **modal 告警 = 请求率 > 节流吞吐**：`MIN_MODAL_GAP_MS=300` 是**全局**节流 ⇒ 上限 **3.3/s**，空闲巡检合计必须 < 3.3（工具 1000 + 快速蒙版 1000 + 文档身份 2000 = 2.5/s）。定位用 **`__jwPs.sources()`**。
- ⛔ **工具闸门 fail-closed**：工具 ID 走 `normalizeToolId()`；面板**读失败沿用上次判定**，绝不退回 `2`（原生侧 2 = 放行）。工具 ID 原文只在读数变化时打 console。
- ⛔ **状态条**：`state===1` 只有两档 —— 「生效中」(绿) / 「平滑中断」(红，判据 `penDown=1 && gateOk=1 && 有包 && snAge>2.2s`)。**不再按模式分叉**（旧的「非拉绳模式」橙档已于 2026-10-14 删除，用户要求「选中啥模式就是啥模式」）；用户明确要求「生效中」后面不挂任何参数；`state===3` → 「未生效（正在自动恢复…）」。参数与受阻原因全部下沉到**诊断条**（`.border-panel-section.smooth-params` 盒**下方**，`smoothDiagText()/smoothDiagTone()`，复用 `.notify-bar` 零新 CSS）。
- ⛔ **量程必须落在人的运笔区间（0.05~1.5 px/ms）**：`SPEED_FULL=3.0`、强度 τ(100)=**250ms**（`TAU_LN=3.473500`）、追笔 vmax 上限 **3.0 px/ms**；改上限必须同时搜 `RADIUS_PX_MAX` / `SMOOTH_RADIUS_MAX` / `Program.cs:Clamp`。
- ⛔ **「拐角」是转折角**（`dot < cos(cornerDeg)` ⟺ `转折角 > cornerDeg`）⇒ 原生 cornerDeg 越小越容易触发保护。⛔⛔ **2026-10-14 回退**：曾有 `cornerToNative(d)=90−d` 的「保护范围」反向映射，用户明确要求回退（「反而更加让人迷惑」）⇒ 现已**恒等**（显示值=原生阈值）。回退理由：面板其它参数全是「越大越强」，唯独拐角反向 ⇒ 比较时误判；**别再重新引入**。
- ⛔ **追笔**保留重映射：面板显示「力度」1–100，`catchUpToNative(d) = round(50 − (d−1)·49/99)`（d=1→原生 50 跟手，d=100→原生 1 最黏）；原生 `vmax=0.02+t/100·3.0` 不动。映射都在 `toWire()` 出口换算，滑杆量程同步 `app.tsx` + `DragHandler 'smooth:catchUp'`（**下限 1，不是 0**）。
- ⛔⛔ **诊断条只认原生侧原因码**（`CFG_I_REASON`/`RS_*` ↔ C# `I_REASON` ↔ TS `SmoothReason`/`smoothReasonText()`，**三处逐项对应**）：0 改写 · 1 开关未开 · 2 非套索 · 3 工具未知 · 4 心跳过期 · 5 悬空 · **6 判据尚未建立**（第五轮改义，旧「判据退化」已废）· 7 未标定 · 8 无上下文。⛔ **禁止面板自己拼** `toolOk/penDown/gateOk` —— DLL 在闸门不成立时会主动把 `penDown` 写成 0，「心跳过期」与「真悬空」长得一样（用户原投诉）。非正常原因按 `SMOOTH_REASON_STICKY_MS=8000` **粘住**（治「绿条一闪来不及截图」）。`gateOpen/gateClose` 是**累计值** ⇒ 判抖动只能用**两次回报的增量**。判据尾巴现为 `smoothCtText()`：`判据 +16* +32* +36 生效2/3 命中1 值0`。
- 共享内存槽位 21 **保留空洞、绝不重编号**（与 C# `I_*` 逐项对应，错位不报错）。**2026-10-14：40 → 48**（35~41 = reason/gateOpen/gateClose/ctOff/ctVal/pxNx/pxNy；**42~44 = ctMask/ctElig/ctOffs**）⇒ 改 NLONGS 必读 refs 的 M5「扩容升级陷阱」（旧 DLL 占着旧尺寸节 ⇒ fail-closed，重启 PS 自愈）。

## 记忆维护约定

- `MEMORY.md`=索引+铁律（≤3000 字）；`refs/*.md`=明细；`HISTORY.md`=历程；`YYYY-MM-DD.md`=当日流水（append-only）。技能：`uxp-frontend-spec`、`algo-param-bench`。
