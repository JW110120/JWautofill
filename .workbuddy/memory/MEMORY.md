# JWautofill 项目记忆（主索引）

> 主入口：**只放「一眼能用」的判定句**，细节全在 `refs/`。
> ⛔ 违反必炸（多来自真机事故）｜⚠️ 易复发｜✅ 有机器守卫。
> 不写流水账（历史见 `HISTORY.md` 与 `.workbuddy/memory/YYYY-MM-DD.md`）。

## 我要改什么 → 读哪里

| 要动的东西 | 先读 |
| --- | --- |
| 填充 / 描边 / 清除 | `refs/fill-and-stroke.md` |
| CSS / 布局 / 新建面板 / 主题 | 技能 **uxp-frontend-spec** → `refs/frontend-css.md` |
| 忙碌闸门 / 模态作用域 / 文档世代号 | `refs/busy-gate.md`（唯一权威） |
| UXP 接口 / 性能 / React | `refs/uxp-api-layer.md` |
| 像素处理器算法 | `refs/pixel-algorithms.md` |
| 构建 / 菜单 / 文件 IO / 守护进程 | `refs/toolchain-and-env.md` |
| 套索实时平滑 / 双钩子守护进程 | `refs/lasso-smoothing.md`（唯一权威） |
| 「当初为什么这么设计」 | `HISTORY.md` |

**改完必备校验**：`node scripts/_css_comment_guard.cjs`（改过 CSS；⚠️ **只扫 `src/styles/*.css`**，`src/adjustments/*.css` 手工核对）、`_modal_contract_guard.cjs`、`_color_picker_contract_guard.cjs`；`npx tsc --noEmit`（只看 `src/` 有无**新增**报错；`'uxp'`/`'photoshop'` 不可解析是**基线例外**）。

## 仓库地图（要点）

`src/app.tsx` 选区填充父面板 · `src/adjustments/AdjustmentPanel.tsx` 绘画工具箱父面板 ·
`utils/psProbe.ts`+`psAccess.ts` 闸门与模态 · `utils/ClearAlgorithms.ts` 清除算法唯一来源 ·
`adjustments/*Processor.ts` 像素处理器（自包含零 import）· `styles/common.css`+`theme.ts` 样式与主题唯一来源 ·
`constants/helpTexts.ts` 全部 hover 文案 · `scripts/` 契约守卫 ·
`src/hotkey/` = `HotkeyBridge.ts`(18923) + `SmoothBridge.ts`(18924) + `LassoSmoothing.ts`（无 WS）·
`native/HotkeyDaemon/Program.cs` 两个守护进程**唯一源码**（`#if ROLE_SMOOTH` 分岔）·
`docs/lasso-realtime-smoothing-plan.md` 平滑方案与验收清单（v5 §12）·
`analysis/`、`outputs/` **已 gitignore、不跨机** —— 记忆与技能**不得**依赖其内容。

---

## 铁律

### 填充 / 描边 / 清除 → `refs/fill-and-stroke.md`
- ⛔ `putPixels` 的 `replace` 默认 `true` ⇒ **局部写清空整层**。写回一律「文档全尺寸缓冲 + 不传 `targetBounds`」。
- ⛔ `getPixels` 四参数：用 `sourceBounds`（不是 `bounds`）；不传 `applyAlpha`；按 `boundsNoEffects` 读；用回读的 `sourceBounds` 定原点；数组形状取 `imageData.width/height`（dispose 前）；不传 `colorProfile`。
- ⛔ 背景图层：解锁 → 清除 → **finally 还原**；解锁成败只信回读 `isBackgroundLayer`；**图层类型转换后一次 DOM 都不能读**（`docId`/图层 id/读区域必须转换前捕获成数字）。
- ⛔ `clearEnum` 在背景图层 / 锁透明像素的图层上不可用（PS 静默弹原生框）⇒ 走「分支 9 `blendSubtraction`」。
- ⛔ 单通道描边必须走分支 7/8（不 `make layer`、还原通道、`blendSubtraction`），分发顺序在像素图层兜底**之前**。
- ⛔ 九处 `location._enum` 一律 `strokeLength`；`width` 有意保留两种写法，**未经授权不要动**。
- ⛔ 描边色 `color._obj` 必须是 `RGBColor`（`RGBColorClass` 无效）。
- ⛔ `needsStroke` 时填充处理器必须传 `deselectAfterFill:false`（否则填充提前消费选区 ⇒ 描边失效）。
- ⛔ 静默化只认 batchPlay 的 **options 层**。
- ⛔ PS 原生拾色器 `showColorPicker` 无参、只认前景色 ⇒ 一律走 `ColorPicker.pickColorWithInitial()`（finally 还原前景色）；**初值必须是真实色，绝不是灰色显示色**。
- ⛔ `doc.activeChannels` 在图层蒙版激活时**抛异常** ⇒ 独立 try/catch 吞掉后继续。
- ⛔ 灰色显示态必须覆盖**所有**颜色显示点（含渐变轨道色标），统一走 `getDisplayColorHex(..., grayDisplay)`；灰态**只影响显示**。
- ⛔ 子面板入口两种形态（齿轮 / 紧凑 label）；紧凑作用域共 6 个（app/color/pattern/gradient/stroke/clear）。
- ⛔ 控件不可用时**不隐藏整行**，改「标签+控件」双禁用态。⚠️ 唯一豁免：套索平滑「当前模式不适用」的参数（见文末）。
- ⛔ 行内滑块传的是 `slider-track` 而非 `range-slider` ⇒ 禁用态必须靠 `.slider-track` 命中；组件 `disabled` 只改 tabIndex、不改视觉。

### UXP CSS / 布局 → `refs/frontend-css.md` + 技能 **uxp-frontend-spec**
- ⛔⛔⛔ CSS 注释块外的**游离文本**会被当选择器、静默吃掉紧随其后的整条规则 ⇒ 改完必跑 `_css_comment_guard.cjs`。**「反复改却毫无效果」立即停手，先验证规则命中元素**。
- ⛔ 「标签随控件同步置灰」跨文件必须两级类（`common.css` 先加载、`app.css` 后注入 ⇒ 同为 (0,1,0) 时后者盖前者）；同文件内靠后置规则即可。
- ⛔ 渲染雷区：`background: transparent` 渲染成**纯黑**（改「具体色 + opacity」）；`border-radius` 写**显式数值** + `-webkit-` 前缀；`underline` 不可靠（改 `border-bottom`）；原生 `<a>` 文字色被宿主接管（改 `<span>`）。
- ⛔ **滚动槽画在滚动容器的内容盒内** ⇒ 滚动层**不能有横向 padding / border**（标题段放滚动层外还会缺顶部一段槽）。
- ⛔ `:nth-of-type` 按**标签名**计数 ⇒ 混合标签容器禁用，改相邻兄弟选择器。
- ⚠️ 不支持 `:has()`（静默失效）与 `rotate()`；flex 隐式 `center`、**方向不显式写会退化成 column**；块级不被隐式拉伸（`width:100%` + border-box）；间距统一 margin+padding（`gap` 不可靠）。
- ⚠️ 外边距折叠：块容器取 max、flex 列容器子项不折叠；flex 子项百分比 `max-height` 不可靠 ⇒ 用 `height:100%`。
- ⚠️ 原生不可控控件一律自绘：`RadioGroup` / `ToggleSwitch` / `Select` / `RangeSlider`；替换时核对调用方取哪个属性。
- ⚠️「元素没占满容器」查**整条祖先链每层的 padding/border/margin**；「两组控件双向对齐」唯一可靠做法 = 总宽相等。
- ⚠️ 间距取「**盒对齐**」；折叠分区「标题→首行」= 标题 `padding-bottom` + 首元素 `margin-top`。
- ⚠️ `.num-input-row` 34px / `.num-unit` 16px 定宽；原生 checkbox 布局盒比可见方块宽 ⇒ 墨迹左右各留 ≈4px。
- ⚠️ 颜色一律走 CSS 令牌、禁硬编码 HEX（遮罩例外）；对比度 ≥ WCAG 4.5:1；四套主题都要写。

### 浮窗 / 子面板 / 遮挡 → `refs/frontend-css.md`
- ⛔ **多浮窗 = 单遮罩 + 一个 `.float-stack`**（别给每个浮窗各挂遮罩）。顺序取 `state.floatOrder`（**后开的排下面**），间距靠相邻兄弟 `margin-top`。
- ⛔ **子面板互斥**：唯一入口 `setSecondaryPanel(id, open)`，**一次 setState 写全 5 个 boolean**。
- ⛔ **面板 body 遮挡类一律按 state 派生，禁止 imperative add/remove**（`...initialState` 会绕过 close）。同一类只能有一个派生点。
- ⛔ **浮窗始终置顶**：子面板 9999、真浮窗 99999（`#app` 下再抬 100000）、激活弹窗 100001；工具箱「功能快捷键」必须显式降到 9999。
- ⛔ 灰度缩略图的 `onLoad` **不得**写 `previewNaturalRef`（否则缩放/预览下拉失灵）。

### 跨面板共享状态 → `refs/uxp-api-layer.md`
- ⛔ 两个面板**同文档同 bundle** ⇒ `FocusModeBus`/`MainToggleBus` 的模块级 `cached` **跨面板共享**。
- ⛔ 订阅/轮询的去重基线**不能用共享缓存播种**（`cached?.x ?? null`）⇒ 首次回调可能永不触发；必须从 `null`（=未知）起。
- ⛔ **读不到 ≠ 为 false**：`readRaw()` 返回 null 时本轮不表态。
- ⛔ `setState` 后立刻读 `this.state` 是旧值（React 19 批处理）⇒ 启动期结论由局部变量显式传入。
- ⛔ 专注模式套索键：`combo` 仅专注模式开启时非空，记忆值存 `brush`。
  `ensureFocusLassoEntry` 只由 **APP 面板**触发（`focusLassoKnown` 闸门），否则两面板互覆盖；
  但 `setFocusLassoCombo` **不可**加该闸门（调用方在工具箱侧）。守护进程对 `action` 只透传 ⇒ 新增 action **无需重编**。

### 闸门 / 模态 / 性能 → `refs/busy-gate.md`（先读）+ `refs/uxp-api-layer.md`
- ⛔⛔ 延迟主因是**串行同步 IPC 往返**，不是像素计算（**batchPlay 数组整体只算一次**）⇒ 提速只能靠「读一次复用 + 合并无依赖命令」。
- ⛔ 「当前工具」类新功能必须**复用** 300ms 工具巡检，**不得另起定时器**。
- ⛔⛔⛔ 闸门三件套：`isPsBusy()` + **文档级持续忙碌闩锁** + `psAccess.psRead()`。会打断用户操作、失败即弹框的读取必须走 `psRead`。
- ⛔⛔ **禁采信 `core.isModal()`** ⇒ 唯一判据 `getOwnModalDepth() > 0`；进模态必须走 `runAsModal()`（`grep -rn "core.executeAsModal" src/` 只应剩注释）。
- ⛔⛔ `runAsModal` 的 `opts` 可能为 undefined，**绝不直接传第二实参**（UXP 抛 `Argument 2 has an invalid type`）⇒ 按 `null` 分岔。
- ⛔⛔ 通知包装器必须按 handler 记忆化（`WeakMap`），否则注销失败 + 监听器泄漏（唯一的「无上限累加」模态放大器）。
- ⛔⛔ **同步接口永不遍历**（`getLayerSnapshot()` 只读缓存）；要新数据走 `refreshLayerSnapshot()`。
- ⛔ **禁止把多条「可能失败」的 get 合并进同一 batchPlay**。
- ⛔ 事件窗口三档（**不得为提速缩短**）：文档级 = 长窗口+闩锁+世代号++；结构类 = 600ms 且作废宿主租约；纯选区 = 300ms 不动租约。
- ⚠️ 无条件轮询必须 `if (isPsBusy()) return`；防抖必须**真防抖**；启动期一次性 PS 加载走 `runWhenIdle`（有限 `maxDeferrals`）。
- ⚠️ `transpileOnly:true` ⇒ 类型缺陷不阻塞构建 ⇒ **新增跨组件共享字段必须补 `types/state.ts`**。
- ⛔⛔ **参与渲染的判据一律按 state 派生**：字段被**异步**写入时没有 state 变化 ⇒ 不重渲染 ⇒ 界面停在旧判定。修法 = 进 state + **仅跃变时 setState**。真机事故：`lassoArmed` 写成实例字段 ⇒ 套索下一直显示「待命（当前不是套索工具）」。
- ⚠️ `useMemo`/JSX 引用**下方声明的 `const`** ⇒ 白屏（es5 下 `const`→`var`）⇒ **纯函数一律放模块级**。
- ⚠️ 大列表 `options` 必须 `useMemo` + `React.memo`；父面板复位要覆盖子面板 state ⇒ `resetToken` 自增（写在 `...initialState` 之后）。

### 像素算法 → `refs/pixel-algorithms.md`
- 写回型处理器：区域判定**只用选区掩码 > 0**；采样到「RGBA 全 0」的缺失点必须**用中心像素边缘延拓**。
- `alphaAlignProcessor` = v10 三档整片归一 + 两个「极值微调」按钮；`aliasSmoothProcessor` = 覆盖率重建 + EDT + 墨量守恒；
  `lineSmoothProcessor` = **V7 中轴重建**（加新参数要同步「面板→转发→处理器」约 10 处）。
- ⚠️ 构建不做类型检查 ⇒ 参数/转发缺陷**静默失效**（改完必须端到端对拍）；台架见技能 `algo-param-bench`，必须同时报「回归 vs 旧版」与「作用量 vs 原图」。

### 守护进程双钩子 → `refs/lasso-smoothing.md` + `refs/toolchain-and-env.md`
- ⛔⛔⛔ **`SendInput` 绝不在低层钩子回调里调用**：注入要等回调返回、系统又在等回调 ⇒ 卡到 `LowLevelHooksTimeout`（默认 **300ms**）才解开，冻结整个输入队列；且**不可中断**，会让进程永远停不下来（只能重启）。必须由独立线程独占回注。
- ⛔⛔ **回注必须绝对坐标**（`MOUSEEVENTF_ABSOLUTE|VIRTUALDESK`）：相对移动吃**指针加速**且闭环过冲 ⇒ 位移不守恒 + 抖动。
- ⛔ 结构对称、状态零共享；**进程级 ≠ 子系统级**（停/卸载服务是进程级 ⇒ 要「关服务但平滑继续」**只能拆两个进程**）。
- ⛔ 钩子线程消息循环**必须逐轮 try/catch**（否则整条线程消失 ⇒ 钩子被连带摘除）；熔断必须可自愈；**能力协商**（旧 daemon 对未知 type 静默丢弃 ⇒ 别把「版本过旧」误报成「被拦截」）。
- ⛔ 改 `Program.cs` 后**两步**：`dotnet publish … -o <各自 publish>` → `yarn build`；更新已装副本只有「服务开关先关再开」一条路；`Process.Kill()` 异步，必须 `WaitForExit`。
- ⛔「钩子装不上 / 输入卡顿 / 进程杀不掉」**第一步查安全软件**（关托盘 ≠ 关实时防护）；杀不掉的另一种形态见 `refs/lasso-smoothing.md` §7。

### 工具链 / 环境 → `refs/toolchain-and-env.md`
- ⛔⛔ 落盘必须「临时文件 + `moveTo` 原子替换」；`moveTo(folder, {newName, overwrite})` 第二参是**选项对象**（传字符串抛错且被 try/catch 吞掉）。统一走 `PresetManager.moveEntryTo`。
- ⛔ 两份 flyout 菜单数组是**唯一来源**；菜单项**只能置灰不能删**（UXP id 插件级唯一，同名整块面板起不来）；注册面板打开期「整菜单门控」按白名单，关闭后还原。
- ⚠️ UXP 无 `fs`/`os`，落盘只用 `localFileSystem`；`getFileForSaving` 必须在 `executeAsModal` 之外调。
- ⚠️ Edit 工具偶发「报成功但没落盘」⇒ 改完必须 grep 复核。
- ⛔ 本机**没有任何原生编译器**（无 MSVC / Windows Kits / gcc / clang）；NativeAOT 也需 MSVC 的 `link.exe` ⇒ 写注入 DLL 靠**便携 zig**（2026-10-12 已装：`bash native/get-zig.sh` → `%USERPROFILE%\zig-toolchain`）。⛔ 别把 zig 放在**过深路径**（`lib_dir` 退化成相对路径 ⇒ 其子编译报 `std.zig: AccessDenied`，看着像杀软其实是路径）；下载走 **PyPI + 清华镜像**（官网 18KB/s）。
- ⚠️ 本地 agent 沙箱会 **SIGTERM 任何尝试注入输入的进程**；`reg.exe`/`wsl.exe` 在黑名单；从 bash 内联调另一套终端工具会被拦；**zig 的子编译读标准库也会被拦** ⇒ 编译类命令须在沙箱外跑。

---

## 套索实时平滑（速记）→ `refs/lasso-smoothing.md`（唯一权威）

- UXP **无画布指针 API** ⇒ 唯一实时入口在「PS 收到输入之前」。与「选区改造」是两条独立路径
  （后者的**平滑滑块已于 2026-10-12 删除**）。**数位板无效的根因是拦截层选错**：PS 走 **Wintab**
  （实测：PS 静态导入 `WinTab32.dll`，`Wacom_Tablet.dll` 已在其地址空间）⇒ 鼠标钩子够不着。
- 两个独立产物：热键 18923 / `%LOCALAPPDATA%\JWautofill\daemon\`；平滑 18924 / `…\smooth\`；
  UXP 侧分别 `HotkeyBridge.ts` / `SmoothBridge.ts`。
- 一眼要用的四条：① `SendInput` 出回调；② 回注用绝对坐标；③ 参与渲染的判据进 `state`；
  ④ 不适用当前模式的参数**整行隐藏**（`smoothParamApplies()`，切换模式后要 `resyncNativeWidgets()`）
  —— 这是对「不隐藏只禁用」铁律的**局部豁免**。
- 面板**只有一条状态条**（`notify-bar` + `indicator` + `notify-text` + 开关）：总开关与「平滑服务」开关
  已二合一（2026-10-12），与「笔刷热键」服务条同款；四档色 + 中性待命，判据只写一处、指示点靠映射。
- ✅ **②a 注入可行性已实测通过（2026-10-12）**：`CreateRemoteThread`+`LoadLibraryW` 能进 PS 2026，
  `QQPCRTP`+`MsMpEng` 不拦，注入后 PS 存活、可 `FreeLibrary` 卸干净（工具见 `analysis/_tools/spike/`）。
  ⛔ 远程 `LoadLibraryW` 的 HMODULE **不能用 `GetExitCodeThread` 取**（32 位截断，静默失效）。
- ✅ **DPI 感知已落地**：`native/app.manifest`（两角色共用，`PerMonitorV2` + Win10 `supportedOS`
  + `asInvoker`）+ Main 首行 `EnsureDpiAwareness()` 兜底；`getState` 报 `dpiAwareness` 字段。
  ⛔ 100% 缩放的机器**看不出差别** —— 有人报「光标画偏」先查它。
- 诊断只看 `smoothStatus`（`worstOver*` 永不重置）；**别靠改预算去试**。

## 记忆维护约定
- `MEMORY.md` = 索引 + 铁律；`refs/*.md` = 主题明细；`HISTORY.md` = 精简历程；`YYYY-MM-DD.md` = 当日流水。
- 配套技能：`uxp-frontend-spec`（前端规范）、`algo-param-bench`（算法对拍）。
