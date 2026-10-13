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
- ⛔ 跨文件置灰必须两级类选择器（style-loader 注入序）；`gap`/`:has()`/`rotate()` 不可靠；`transparent` 渲染成纯黑。
- ⛔ 多浮窗 = 单遮罩 + 一个 `.float-stack`；子面板互斥唯一入口 `setSecondaryPanel(id,open)` 一次写全 5 个 boolean；遮挡类按 state 派生。
- ⛔ 闸门三件套 `isPsBusy()`+文档级闩锁+`psAccess.psRead()`；禁采信 `core.isModal()`（判据 `getOwnModalDepth()>0`）；`runAsModal` 绝不直接传第二实参。
- ⛔ **参与渲染的判据一律按 state 派生**（异步写入不重渲染 ⇒ 界面停旧判定）。
- ⛔ 无原生编译器 ⇒ 注入 DLL 靠便携 zig（`native/get-zig.sh`→`%USERPROFILE%\zig-toolchain`）；编译须沙箱外跑。
- ⛔ 改 `Program.cs` 后三步：两角色分别 `dotnet publish -o publish` → `yarn build`；更新已装副本只有「服务开关先关再开」。

## 套索实时平滑（速记）→ `refs/lasso-smoothing.md`（唯一权威）

- 唯一通路 = Wintab 笔通路（`SmoothDaemon` 经共享内存注入 `JWautofillWintabHook.dll`，inline-hook `WTPacketsGet`）；面板「平滑选项」是一条 notify-bar；装目录 `%LOCALAPPDATA%\JWautofill\smooth`。⛔ **换 DLL 必须重启 PS**（旧 DLL 被锁）；状态必须**周期推送**（`SmoothStatePump`）。
- 状态机 `CFG_I_STATE`：0 未挂 · 1 生效 · 2 标定失败 · 3 已卸载 · 4 入口被旧副本占（须重启 PS）。「已平滑 N 包」只计真实改写包。
- ⛔⛔ **坐标口径**：系统光标 = **原始笔** ⇒ HUD 圆钉在「光标−(raw−out)·px」= 绘制点；标定分母用 **Δ原始轴**。**逐轴带符号**（真机 lcInExtX=44800 / lcInExtY=29600，两轴比差 1.58 倍，单标量不成立）；**符号只测不猜**（`calib_axis` 的 Δ光标/Δraw 是唯一权威，兜底一律中性）。⛔ 曾有一条**标定断链真 bug**（`calib_axis` 写 `g_axCal*.px`，`px_x/px_y` 却读 `g_pxAxisX/Y`）⇒ 查「调参无感 / HUD 位置不对」必先查它；日志 `calX/calY=1` 才是实测。
- HUD 老根因（已修）：`LOGCONTEXT` 漏 `lcDevice`；`layout_of` 把 ORIENTATION/ROTATION 当 4B；驱动报的 `lcPktData` ≠ 真实布局 ⇒ 必须**盲扫定解**（本机 stride=52 offX=20 offY=24）。
- ⛔ **示意图 ≠ 测量数据**（用户纠错）：几何量化只能来自日志/实测，或用户**明确确认为真实**的截图。
- ⛔⛔ **`TIME_GAP_RESET_MS` 假复位**：数位板停笔**不再出包** ⇒ 旧 120ms 把「停一下再画」误判成新一笔、输出点拽回笔尖；现值 **5000ms** + `HUD_HOLD_MS=3000`；`rst=a/g/j` 正常运笔不增长。
- ⛔⛔ **拉绳 = 定长绳**：`dist ≤ rope` ⇒ 输出点不动；`> rope` ⇒ 跟随量 `dist − rope`，即 **`f = 1 − rope/dist`**（写成 `rope/dist` 会让输出点**直接跳到光标** ⇒ 选区成一段段直线）。绳长 ≡ 半径（「张力」已删）。绳 = 统一 **2px** + 二次贝塞尔，垂度 `sag=sqrt(3(L−d)d/8)`（d→L 自然拉直）；**绝不画 4→1px 锥形**。
- ⛔⛔ **平滑「时有时无」** = DLL 被 `cmd=2` 卸钩（`RequestUnhook` 也会发）而守护进程以为还开着 ⇒ 必须自愈：`PenHook.HealIfUnhooked`（`_enabled` 真 且 `I_STATE==3` ⇒ `SendCommand(1)`，冷却 2s；state==4 不自愈）。
- ⛔ **HUD 显隐六条件** = `wnd && mem && activeNow && gateOk && ropeMode && (hf&1)`；不显示时先读日志 `[hud] 未显示: …`（2s 节流，逐项打出 `wnd/mem/active/gate/rope/hudBits`）。
- ⛔⛔ **卸载脚本只删自己那份安装目录**；第 7 步**只能回收空目录** —— 绝不 `Remove-Item -Recurse` 整个 `%LOCALAPPDATA%\JWautofill`：它会删掉 `configpath.txt` ⇒ 守护进程回落默认路径、读到空配置 ⇒ 面板按「首次使用」回写默认值，把用户热键冲掉；还会删掉另一角色的 `smooth\`。热键配置回写护栏 `canPersistConfig`：daemon 回帧的 `path` 与面板下发的必须**逐字相同**（只判「非空」不够 —— 默认路径字符串也非空）；守护进程覆盖前留 `<配置>.bak`。
- ⛔ **卸载必须唤起 `.exe` 启动器**（`native/UninstallLauncher/JWUninstall.exe` → 同目录 `uninstall.ps1`）：`shell.openPath` 对 `.bat` 不稳定（不出现 / 闪退）。钩子 DLL 落 `%TEMP%\JWautofill\hooks\`（PS 会锁住安装目录 ⇒ 卸载删不掉）。重试 8×500ms、失败**不 throw**、倒计时 **15s**（两边一致）、`.bat` 用 **`if errorlevel 9009 pause`**。
- ⛔⛔ **modal 告警 = 请求率 > 节流吞吐**：`MIN_MODAL_GAP_MS=300` 是**全局**节流 ⇒ 上限 **3.3/s**，空闲巡检合计必须 < 3.3（工具 1000 + 快速蒙版 1000 + 文档身份 2000 = 2.5/s）。定位用 **`__jwPs.sources()`**。
- ⛔ **工具闸门 fail-closed**：工具 ID 走 `normalizeToolId()`；面板**读失败沿用上次判定**，绝不退回 `2`（原生侧 2 = 放行）。工具 ID 原文只在读数变化时打 console。
- ⛔ **状态条**：`state===1` 只显示「套索平滑：生效中」（用户明确要求后面不挂任何参数）；`state===3` → 「未生效（正在自动恢复…）」。
- ⛔ **量程必须落在人的运笔区间（0.05~1.5 px/ms）**：`SPEED_FULL=3.0`、强度 τ(100)=**250ms**（`TAU_LN=3.473500`）、追笔 vmax 上限 **3.0 px/ms**；改上限必须同时搜 `RADIUS_PX_MAX` / `SMOOTH_RADIUS_MAX` / `Program.cs:Clamp`。
- ⛔ **「拐角」是转折角**（判据 `dot < cos(cornerDeg)`）⇒ **数值越小越容易触发保护**。共享内存槽位 21 **保留空洞、绝不重编号**（与 C# `I_*` 逐项对应，错位不报错）。

## 记忆维护约定

- `MEMORY.md`=索引+铁律（≤3000 字）；`refs/*.md`=明细；`HISTORY.md`=历程；`YYYY-MM-DD.md`=当日流水（append-only）。技能：`uxp-frontend-spec`、`algo-param-bench`。
