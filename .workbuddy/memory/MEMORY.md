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

**改完必备校验**：改过 CSS 必跑 `node scripts/_css_comment_guard.cjs`（⚠️ 只扫 `src/styles/*.css`，不扫 `theme.ts`）+ `_modal_contract_guard.cjs` + `_color_picker_contract_guard.cjs`；`npx tsc --noEmit` 只看 `src/` 新增报错（`'uxp'`/`'photoshop'`、`ffi.d.ts` 语法错为基线）。

## 仓库地图（要点）

`src/app.tsx` 选区填充父面板 · `AdjustmentPanel.tsx` 工具箱父面板 · `psProbe.ts`+`psAccess.ts` 闸门与模态 · `ClearAlgorithms.ts` 清除算法唯一来源 · `adjustments/*Processor.ts` 像素处理器（零 import）· `common.css`+`theme.ts` 样式主题唯一来源 · `helpTexts.ts` hover 文案 · `src/hotkey/` = `HotkeyBridge.ts`(18923 笔刷热键 daemon)+`SmoothBridge.ts`(18924 对端=.8li)+`LassoSmoothing.ts`（纯状态机无 WS）· `native/` 现存：`HotkeyDaemon/`（唯一 daemon，Program.cs 仅热键角色）+ `PiSmooth8li/`（平滑插件，`build.sh` 用 zig）+ `app.manifest` + `get-zig.sh` · `analysis/`、`outputs/` gitignore 不跨机。

## 铁律（速查；细节在 refs/）

- ⛔⛔ **提交/推送纪律（2026-10-16 用户定，强制）**：① 用户说「推送到远端」时，**项目代码 + 日志 + 记忆（docs/memory）必须合成一次提交**，绝不许拆成「代码一条、docs/memory 再一条」；② **代码彻底定稿后才提交** —— 不许「先提交、随后发现 bug 又改两行补一条」；③ 提交前先自问「这版接下来还会不会再改？」，答案是「会」就先别提交、别推。
- **dist 红线**：⛔ docs 进 dist 走**白名单**（仅 fill-guide.html + toolbox-guide.html + img/）。历史教训：黑名单 `*plan*.md` 漏放 modal-scope-audit.md ⇒ 追不上新文件。webpack 不清旧产物 ⇒ 改规则后手删残留复验。
- ⛔⛔ **.8li 真机铁律**：① PiPL 头部=10 字节；② `'8664'` 入口导出名属性=**C 字符串**（Pascal 串 ⇒ GetProcAddress 失败 ⇒ attach 后 1ms 静默卸载）；③ 加载消息=`"SP Access"/"Reload"`，卸载=`"SP Access"/"Unload"`；④ 引擎+WS 层合并镜像，**无 daemon 无注入**；⑤ 自写 SHA1 必须用已知向量实测（RFC6455 App.A）。
- 📌 **PS 插件目录按测试机分叉**：① 双 4K 机 ⇒ `E:\Program Files\Adobe Photoshop 2026\Plug-ins\`；② **本机（3440×1440 带鱼屏）⇒ `C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\`**。两机都只有**一个** `JWautofillSmooth.8li`。⛔ PS 运行时锁该文件 ⇒ 覆盖前**全部退出** PS（本机常有 3 个进程）。
- ⛔⛔ 部署只认 `build/JWautofillSmooth.8li`；核验 = 日志头 `ver=0x0XXX` + `[status]` 含 `dpi=N‰`。⛔ 版本号核验要**走导出表解析**读 `jwwh_version` 函数体前 10 字节（裸搜 `B8 xx 01 00 00 C3` 会漏 —— 函数序言是 `55 48 89 E5`）。
- ⛔ **GATETS 由 pump 接管**：有 WS 客户端连接即每 500ms 刷（面板 1500ms 心跳不可靠 ⇒ reason=4 fail-closed）；全断 ⇒ 停刷 ⇒ 3s 过期语义保留。⛔ 独立实测必须关 PS（旧副本占 18924）。
- ⛔⛔ **IPC 数字字段双防御**：面板 `toWire()` 出口对所有数字一律 `Math.round`（唯一咽喉）；原生侧字段用 `double?`+赋值 Round。漏一个浮点 ⇒ 整条消息被丢 ⇒「切换模式后平滑就断」。**新增字段必须同时做这两件事**。
- ⛔ 无原生编译器 ⇒ zig 走便携工具链（`native/get-zig.sh`→`%USERPROFILE%\zig-toolchain`）；编译须沙箱外跑。⛔ 改 `Program.cs`（热键 daemon 唯一源码）后：`dotnet publish -o publish` → `yarn build`；更新已装副本只有「服务开关先关再开」。
- ⛔ **卸载脚本只删自己那份安装目录**；绝不 `Remove-Item -Recurse` 整个 `%LOCALAPPDATA%\JWautofill`（会删 `configpath.txt` ⇒ 热键配置被冲掉）。面板卸载兜底唤起 `native/HotkeyDaemon/uninstall.bat`。⛔ 已**回退** JWUninstall.exe 启动器方案（dist +76M 不划算），UninstallLauncher 已删，勿再引入。
- ⚠️ **环境坑：genie-trash**：对多文件目录报 "Some operations were aborted" 但**实际已移动**（fail-closed 误报），且会**延迟回滚重建空目录**。对策：逐文件删容忍报错 + 空壳用 `[System.IO.Directory]::Delete(p,$false)` 收尾 + 删后复验。

## 套索平滑（速记）→ `refs/lasso-smoothing.md`

- 唯一通路 = Wintab 笔通路，实现 = **PS 进程内 .8li**（`smooth_engine.c` inline-hook `WTPacketsGet`；`plugin_main.c` 承载 WS 18924）。⛔ 换 .8li 必须重启 PS。状态周期推送（`SmoothStatePump` 500ms）。状态机 `CFG_I_STATE`：0 未挂 · 1 生效 · 2 标定失败 · 3 已卸载 · 4 入口被占（须重启 PS）。
- ⛔⛔ **坐标口径**：系统光标 = 原始笔 ⇒ HUD 圆钉「光标−(raw−out)·px」。⛔⛔ **px 唯一权威 = 屏幕/lcOutExt**（2026-10-15 [gap] 回归定案，rms 3.8/4.2px；本机=1/16 px/轴）。**旧权威 屏幕/lcInExt 是错的**（「横领先/竖落后」残差根因）。⛔⛔ **axisMax 亦用 lcOutExt，且每次标定都要重算**（详见 refs **O4**）。⛔ Y 符号**不在标定里猜**，由光标投票裁决（Y 本机实测反向）；投票翻转 ⇒ `AXCAL.signLocked` **首达即锁**。
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
- ⛔ **独立笔通路**：Raw Input **已弃用**（设备在列表里却零 WM_INPUT ⇒ 注册成功 ≠ 收得到）；**采样源 = 系统光标**（`GetCursorPos` 250Hz，依据「包冻结而光标仍在动」）。拟合**必须两趟**（粗拟合→剔离群→重拟合），判据 = 保留集 ≥150 + 逐轴 rms ≤8 + 跨度 ≥1000，不成立则**一个字节都不写**。补流门控 = `enNow` + `realAge ≥250ms` + `rawAge ≤150ms`；**必须丢冲包**（否则弧线倒着画回）。

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
