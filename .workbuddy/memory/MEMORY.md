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

`src/app.tsx` 选区填充父面板 · `AdjustmentPanel.tsx` 工具箱父面板 · `psProbe.ts`+`psAccess.ts` 闸门与模态 · `ClearAlgorithms.ts` 清除算法唯一来源 · `adjustments/*Processor.ts` 像素处理器（零 import）· `common.css`+`theme.ts` 样式主题唯一来源 · `helpTexts.ts` hover 文案 · `src/hotkey/` = `HotkeyBridge.ts`(18923)+`SmoothBridge.ts`(18924)+`LassoSmoothing.ts`（无 WS）· `native/HotkeyDaemon/Program.cs` 两守护进程唯一源码（`#if ROLE_SMOOTH`）· `analysis/`、`outputs/` gitignore 不跨机。

## 铁律（速查；细节在 refs/）

- **dist 红线**：⛔ 实现计划/设计文档（`*plan*.md`）不进 dist（webpack globOptions ignore，2026-10-12 铁律）；webpack 不清旧产物 ⇒ 改规则后手删残留复验。
- ⛔ `putPixels` 的 `replace` 默认 true ⇒ 局部写清空整层；写回 = 全尺寸缓冲 + 不传 targetBounds。背景层解锁→清除→finally 还原；类型转换后一次 DOM 都不能读。
- ⛔ `clearEnum` 在背景/锁透明层不可用 ⇒ 分支 9 `blendSubtraction`；单通道描边走 7/8；静默化只认 batchPlay **options 层**；`needsStroke` 时填充传 `deselectAfterFill:false`。
- ⛔ CSS 注释块外游离文本被当选择器、静默吃掉紧随整条规则 ⇒ 改完必跑 guard；「反复改没效果」立即停手验证命中。
- ⛔ 跨文件置灰必须两级类选择器（style-loader 注入序）；`gap`/`:has()`/`rotate()` 不可靠；`transparent` 渲染成纯黑。
- ⛔ 多浮窗 = 单遮罩 + 一个 `.float-stack`；子面板互斥唯一入口 `setSecondaryPanel(id,open)` 一次写全 5 个 boolean；遮挡类按 state 派生。
- ⛔ 闸门三件套 `isPsBusy()`+文档级闩锁+`psAccess.psRead()`；禁采信 `core.isModal()`（判据 `getOwnModalDepth()>0`）；`runAsModal` 绝不直接传第二实参。
- ⛔ **参与渲染的判据一律按 state 派生**（异步写入不重渲染 ⇒ 界面停旧判定）。
- ⛔ 无原生编译器 ⇒ 注入 DLL 靠便携 zig（`native/get-zig.sh`→`%USERPROFILE%\zig-toolchain`，清华镜像）；勿放过深路径；编译须沙箱外跑。
- ⛔ 改 `Program.cs` 后两步：两角色分别 `dotnet publish -o publish` → `yarn build`；更新已装副本只有「服务开关先关再开」。

## 套索实时平滑（速记）→ `refs/lasso-smoothing.md`（唯一权威）

- **2026-10-12 鼠标钩子通路整体移除** ⇒ 唯一通路 = Wintab 笔通路：`SmoothDaemon` 经命名共享内存配置注入 PS 的 `JWautofillWintabHook.dll`（inline-hook `WTPacketsGet`）。
- 面板「平滑选项」= **一条 notify-bar**（笔刷热键同款服务语义：开=拉起 daemon+发 penSmooth，关=优雅退出）；「笔平滑」更名**套索平滑**；minSampleDist/smoothEnabled/smoothArmed/smoothTool* 已删；模式不适用参数**整行隐藏**（`smoothParamApplies()`，「不隐藏只禁用」铁律唯一豁免）。
- APP 菜单「卸载套索平滑服务」（id `uninstallSmoothDaemon`；装目录 `%LOCALAPPDATA%\JWautofill\smooth`）。
- HUD 不显示根因（已修，且不止一条）：① `LOGCONTEXT` 漏 `lcDevice` ⇒ 偏移 60 读到 `lcPktRate` ⇒ 掩码无 PK_X ⇒ 标定永败；改 256B 缓冲 + `lcPktData@64`。② **标定根本没过**（`layout_of` 把 PK_ORIENTATION/ROTATION 当 4 字节，真为 12）⇒ 全链路零改写。③ 驱动报的 `lcPktData` 与真实包布局**不是一回事**，必须以盲扫+数据判据定解（本机 stride=52 offSerial=8 offX=20 offY=24）。
- 状态机 `CFG_I_STATE`：0 未挂 · 1 生效 · 2 标定失败 · 3 已卸载 · **4 入口被旧副本占用（须重启 PS）**；「已平滑 N 包」只计真实改写包。两层能力探测不可合并；参数整包下发（强度按 `k=dt/(dt+τ)`）。
- ⛔ ⛔ **换 DLL 必须重启 Photoshop**：旧 DLL 被 PS 锁住 ⇒ 自安装覆盖不了（现改为带内容戳文件名，但仍需重启）。⛔ **状态必须周期推送**（`SmoothStatePump`），只在收到指令时广播会让状态条永久冻结。
- ✅ 注入可行（`CreateRemoteThread`+`LoadLibraryW` 进 PS 2026）；⛔ 远程 HMODULE 不能用 `GetExitCodeThread` 取；✅ DPI 感知已落地（`app.manifest`）。
- 诊断只看 `smoothStatus`（`worstOver*` 永不重置）；别靠改预算去试。

## 记忆维护约定

- `MEMORY.md`=索引+铁律（≤3000 字）；`refs/*.md`=明细；`HISTORY.md`=历程；`YYYY-MM-DD.md`=当日流水（append-only）。技能：`uxp-frontend-spec`、`algo-param-bench`。
