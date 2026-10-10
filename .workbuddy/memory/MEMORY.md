# JWautofill 项目记忆（主索引）

> 这是主入口。**细节全部下沉到 `refs/`**，本文件只放「一眼能用」的铁律与导航，不堆实测数据、不写历史版本。
> 2026-10-10 整理：逐日流水账蒸馏为 `HISTORY.md`，规则按主题归位到 `refs/`。
> 约定：⛔ = 违反必炸（多来自真机事故）｜⚠️ = 容易踩、易复发｜✅ = 有机器守卫盯着。

## 先看这里：我要改什么 → 读哪里

| 要动的东西 | 先读 |
| --- | --- |
| 填充 / 描边 / 清除 | `refs/fill-and-stroke.md` |
| CSS / 布局 / 新建面板 / 主题 | 技能 **uxp-frontend-spec** → `refs/frontend-css.md` |
| 忙碌闸门 / 模态作用域 / 文档世代号 | `refs/busy-gate.md`（唯一权威） |
| UXP 接口行为 / 性能 / React | `refs/uxp-api-layer.md` |
| 像素处理器算法 | `refs/pixel-algorithms.md` |
| 构建 / 菜单 / 文件 IO / 守护进程 | `refs/toolchain-and-env.md` |
| 「当初为什么这么设计」 | `HISTORY.md` |

**改完必备校验**：`node scripts/_css_comment_guard.cjs`（改过 CSS；⚠️ 它**只扫 `src/styles/*.css`**，`src/adjustments/*.css` 要手工核对注释/括号配对）、`node scripts/_modal_contract_guard.cjs`、`node scripts/_color_picker_contract_guard.cjs`；类型校验 `npx tsc --noEmit`（只看 `src/` 有无**新增**报错）。

## 仓库地图

| 路径 | 作用 |
| --- | --- |
| `src/app.tsx` | 选区填充父面板（APP）：浮窗、5 个子面板、填充路径编排 |
| `src/adjustments/AdjustmentPanel.tsx` | 绘画工具箱父面板（单组件，约 3800 行） |
| `src/utils/psProbe.ts` · `utils/psAccess.ts` | 忙碌闸门 · 模态作用域（见 `refs/busy-gate.md`） |
| `src/utils/ClearAlgorithms.ts` | 清除算法唯一来源 |
| `src/adjustments/*Processor.ts` | 像素处理器（自包含、零 import，便于离线对拍） |
| `src/styles/common.css` | 通用样式唯一来源（+ 底部「状态集中管理区」） |
| `src/styles/theme.ts` | 四套主题令牌 darkest/dark/light/lightest + 遮罩字面色 |
| `src/constants/helpTexts.ts` | 全部 hover 文案 |
| `scripts/` | 契约守卫脚本（CSS 注释 / 模态 / 取色器） |
| `.workbuddy/memory/`、`.workbuddy/skills/` | 本套记忆与技能 |
| `analysis/`、`outputs/` | 本地临时产物，**已 gitignore、不跨机同步**——记忆与技能**不得**依赖其内容 |

---

## 铁律（按主题）

### 填充 / 描边 / 清除 → `refs/fill-and-stroke.md`
- ⛔ `imaging.putPixels` 的 `replace` 默认 `true` ⇒ **局部写会清空整层**。写回一律「文档全尺寸缓冲 + 不传 `targetBounds`」。
- ⛔ `imaging.getPixels` 四参数：用 `sourceBounds`（不是 `bounds`）；不传 `applyAlpha`；按 `layer.boundsNoEffects` 读；用回读的 `sourceBounds` 定原点；数组形状取 `imageData.width/height`（dispose 前）；不传 `colorProfile`。
- ⛔ 背景图层：解锁 → 清除 → **finally 还原**；解锁成败只信回读 `isBackgroundLayer`；**图层类型转换后一次 DOM 都不能读**（`docId`/图层 id/读区域必须转换前捕获成数字）。
- ⛔ `clearEnum` 在背景图层 / 锁透明像素的图层上不可用（PS 静默弹原生框、按普通填充处理）⇒ 走「分支 9 `blendSubtraction`」。
- ⛔ 单通道描边必须走分支 7/8（不 `make layer`、还原通道、`blendSubtraction`），分发顺序放在像素图层兜底**之前**。
- ⛔ 九处 `location._enum` 一律 `strokeLength`；`width` 有意保留两种写法（通道上下文为裸数字），**未经授权不要动**。
- ⛔ 描边色 `color._obj` 必须是 `RGBColor`（`RGBColorClass` 是无效类名）。
- ⛔ `needsStroke` 时必须给填充处理器传 `deselectAfterFill:false`（否则填充提前消费选区 ⇒ 描边失效）。
- ⛔ 静默化只认 batchPlay 的 **options 层**（描述符内的 `_options` 会被 `fill`/`stroke` 忽略）。
- ⛔ PS 原生拾色器 `showColorPicker` 无参、只认前景色 ⇒ 一律走 `ColorPicker.pickColorWithInitial()`（finally 还原前景色）；**初值必须是真实色，绝不是灰色显示色**。
- ⛔ `doc.activeChannels` 在图层蒙版激活时**抛异常** ⇒ 必须独立 try/catch 吞掉后继续（合并多步探测时勿丢内层 catch）。
- ⛔ 灰色显示态必须覆盖**所有**颜色显示点（含渐变轨道色标），统一走 `getDisplayColorHex(..., grayDisplay)`；灰态**只影响显示**、不写回真实数据。
- ⛔ 子面板入口两种形态（普通模式齿轮 / 紧凑模式 label）；紧凑作用域共 6 个（app/color/pattern/gradient/stroke/clear）。
- ⛔ 控件不可用时**不要整行隐藏**，改「标签 + 控件」双禁用态。

### UXP CSS / 布局 → `refs/frontend-css.md` + 技能 **uxp-frontend-spec**
- ⛔⛔⛔ CSS 注释块外的**游离文本**会被当成选择器、静默吃掉紧随其后的整条规则 ⇒ 改完必须机器校验 `node scripts/_css_comment_guard.cjs`。**「反复改却毫无效果」立即停手，先验证规则是否命中元素**。
- ⛔ 「标签随控件同步置灰」跨文件必须用**两级类**：`common.css` 静态 `<link>` 先加载、`app.css` 由 style-loader 后注入 ⇒ 同为 (0,1,0) 时 app.css 的 `color` 会盖掉 `.label-disabled`（写成 `.app-xxx.label-disabled`）；同文件内靠后置规则即可。
- ⛔ UXP 渲染雷区：`background: transparent` 渲染成**纯黑**（要透明感用「具体色 + opacity」）；`border-radius: 999px` 不按半高解析（写**显式数值** + `-webkit-` 前缀）；`text-decoration: underline` 不可靠（改 `border-bottom`）；原生 `<a>` 文字色被宿主接管（改 `<span>` + onClick）。
- ⛔ **滚动槽画在滚动容器的内容盒内部** ⇒ 滚动层**不能有横向 padding / border**，否则槽永远到不了面板最右缘（标题段放滚动层外还会缺顶部一段槽）。
- ⛔ `:nth-of-type` 按**标签名**计数而非「第几个 class」⇒ 混合标签容器里禁用，改相邻兄弟选择器。
- ⚠️ UXP 不支持 `:has()`（静默失效）、不支持 `rotate()`（transform 只有 scale/translate）；flex 容器隐式 `center`、**方向不显式写会退化成 column**；块级元素不被隐式拉伸（占满一行要显式 `width:100%` + border-box）；间距统一用 margin+padding（`gap` 不可靠）。
- ⚠️ 外边距折叠：块容器**取 max**、flex 列容器**子项不折叠**（算「行 ↔ divider」前先判容器类型）；flex 子项的百分比 `max-height` 解析不可靠 ⇒ 用 `height:100%`。
- ⚠️ 原生不可控控件一律自绘：`RadioGroup.tsx`（替 `sp-radio-group`）、`ToggleSwitch`（替 `sp-switch`）、`Select.tsx`（替 `sp-picker`）、`RangeSlider.tsx`（替 `input[type=range]`）；替换时必须核对调用方从**事件对象的哪个属性**取值。
- ⚠️「元素没占满容器」查**整条祖先链每层的 padding/border/margin（尤其两层叠加）**；「两组控件双向对齐」的唯一可靠做法 = 让两组**总宽相等**。
- ⚠️ 间距令牌取「**盒对齐**」不取「墨迹对齐」；折叠分区「标题→首行」间距 = 标题 `padding-bottom` + 首元素 `margin-top`。
- ⚠️ 数字输入框与单位符号必须定宽（`.num-input-row` 34px / `.num-unit` 16px）；原生 checkbox 布局盒比可见方块宽、方块居中 ⇒ 墨迹左右各留 ≈4px。
- ⚠️ 颜色一律走 CSS 令牌，禁硬编码 HEX（遮罩例外，由 `theme.ts` 注入字面色）；对比度 ≥ WCAG 4.5:1；四套主题都要写。

### 浮窗 / 子面板 / 面板遮挡 → `refs/frontend-css.md`
- ⛔ **多浮窗 = 单遮罩 + 一个 `.float-stack`**：别再给每个浮窗各挂 `.float-overlay`（会叠遮罩变暗 + 靠 DOM 顺序互相盖）。堆叠顺序取 `state.floatOrder`（数组顺序 = DOM 顺序，**后开的排下面**），间距 10px 靠相邻兄弟 `margin-top`，关上方自动上移。
- ⛔ **子面板互斥铁律（一个父面板同时只开一个）**：唯一入口 `app.tsx::setSecondaryPanel(id, open)`，**一次 `setState` 写全 5 个 boolean**；所有入口方法一律 delegate 过去。
- ⛔ **面板 body 遮挡类一律「按 state 派生」，禁止 imperative add/remove**：`onResetParameters` 的 `...initialState` 会绕过 close 方法 ⇒ 手写 add/remove 必留悬空类。同一 body 类只能有**一个**派生点。
- ⛔ **浮窗始终置顶**：子面板 9999、真浮窗 99999（`#app` 下再抬 100000）、激活弹窗 100001；工具箱「功能快捷键」与浮窗同用 `.float-overlay` ⇒ 它必须显式降到 9999。
- ⛔ **灰度显示不得污染预览的真实尺寸基准**：降采样灰度缩略图的 `onLoad` **不得**写 `previewNaturalRef`（只在非灰度时记），否则预览被钉在缩略图尺寸、缩放/预览下拉「失灵」。

### 跨面板共享状态 → `refs/uxp-api-layer.md`
- ⛔ 两个面板（`#app` / `#pixeladjustment`）**同 HTML 文档、同 bundle** ⇒ `FocusModeBus`/`MainToggleBus` 的模块级 `cached` 是**跨面板共享**的。
- ⛔ 订阅/轮询的去重基线**绝不能用共享缓存播种**（`let last = cached?.focus ?? null`）⇒ 首次回调可能永不触发、订阅方初值成为最终值且永不纠正。必须从 `null`（=未知）起。
- ⛔ **读不到 ≠ 为 false**：`readRaw()` 返回 null 时本轮不表态（不更新 `last`）。
- ⛔ `setState` 之后立刻读 `this.state` 拿到的是旧值（React 19 批处理）⇒ 启动期派生结论必须由合并后的局部变量显式传入。

### 闸门 / 模态 / 性能 → `refs/busy-gate.md`（先读它）+ `refs/uxp-api-layer.md`
- ⛔⛔ 交互延迟的主因是**串行同步 IPC 往返**，不是像素计算（每次属性读 = 一次宿主往返；**batchPlay 数组整体只算一次**）。提速只能来自「读一次复用 + 合并无依赖命令」，不能来自缩短等待。
- ⛔⛔⛔ 闸门是三件套：粗筛 `isPsBusy()` + **文档级持续忙碌闩锁**（闩锁期间 `isPsBusy()` 恒真）+ `psAccess.psRead()` 模态作用域兜底。会打断用户操作、失败即弹框的读取必须走 `psRead`。
- ⛔⛔ **禁采信 `core.isModal()`**（会算上宿主模态）⇒ 唯一判据 `psAccess.getOwnModalDepth() > 0`；**任何进入模态的代码都必须走 `psAccess.runAsModal()`**（自检：`grep -rn "core.executeAsModal" src/` 只应剩注释）。
- ⛔⛔ `runAsModal` **绝不把可能为 undefined 的 `opts` 传作第二实参**（UXP 严格校验会抛 `Argument 2 has an invalid type`）⇒ 必须按 `opts == null` 分岔。
- ⛔⛔ 通知包装器必须按 handler 记忆化（`WeakMap`），否则 `removeNotificationListener` 按引用找不到目标 ⇒ 注销失败 + 监听器泄漏（本仓唯一的「无上限累加」模态命令放大器）。
- ⛔⛔ **同步接口永不遍历**（`getLayerSnapshot()` 只读缓存）——「同步裸读 + N 层遍历」是乘法放大器；要新数据走 `refreshLayerSnapshot()`。
- ⛔ **禁止把多条「可能失败」的 get 合并进同一 batchPlay**（一条失败连带整批，且宿主原生弹框绕过 JS try/catch）。
- ⛔ 事件窗口三档（**不得为提速缩短**）：文档级 open/close/save/切文档 = 长窗口 + 闩锁 + 世代号++；结构类（delete/make/move/rename/合并/拼合/栅格化）= 600ms 且作废宿主租约；纯选区 = 300ms 且不动租约。
- ⚠️ 无条件 `setInterval` 读文档/get 的轮询必须 `if (isPsBusy()) return`；防抖必须**真防抖**（节流会丢事件）。
- ⚠️ 启动期一次性 PS 加载必须走 `runWhenIdle`（一次性加载要传有限 `maxDeferrals`）。
- ⚠️ `ts-loader transpileOnly:true` ⇒ 类型缺陷永不阻塞构建 ⇒ **新增跨组件共享字段必须同步补 `types/state.ts` 接口**。
- ⚠️ 组件内 `useMemo`/JSX 调用**组件体内更下方**声明的 `const` ⇒ 白屏（es5 下 `const`→`var` 提升）⇒ **纯函数一律放模块级**。
- ⚠️ 大列表 `options` 必须 `useMemo` + 组件 `React.memo`（永远不要在 JSX 里现 map）。
- ⚠️ 父面板复位要覆盖子面板内部 state ⇒ 用 `resetToken` 自增（写在 `...initialState` 之后），复位前先清「选中预设」。

### 像素算法 → `refs/pixel-algorithms.md`
- 写回型处理器两条边界铁律：区域判定**只用选区掩码 > 0**；采样到「RGBA 全 0」的数据缺失点必须**用中心像素边缘延拓**。
- alpha 对齐 `alphaAlignProcessor.ts` = **v10 三档整片归一**（上=max / 下=min / 众=众数）；另有两个「极值微调」按钮（v5 环带参照复活，线条污渍专用）。
- 消除锯齿 `aliasSmoothProcessor.ts`：覆盖率重建 + EDT 本体传播 + 墨量守恒；细线 ≤4px 走几何重建。
- 「仅主线条」`lineSmoothProcessor.ts` = **V7 中轴重建**；加新参数必须同步「面板 → 转发 → 处理器」整条链（约 10 处）。
- ⚠️ 构建不做类型检查 ⇒ 参数/转发缺陷只会**静默失效**（改完必须端到端跑一遍对拍）。
- ⚠️ 像素算法的对拍台架是本地草稿（见技能 `algo-param-bench`）；改完必须同时报「回归 vs 旧版」与「作用量 vs 原图」。

### 工具链 / 环境 → `refs/toolchain-and-env.md`
- ⛔⛔ 文件落盘必须「临时文件 + `moveTo` 原子替换」；`Entry.moveTo(folder, {newName, overwrite})` 第二参是**选项对象**，传字符串会抛错且被 `try/catch` 静默吞掉。统一走 `PresetManager.moveEntryTo`。
- ⛔ 两份 flyout 菜单的数组是**唯一来源**（`MenuManager` 顶部常量）；按 id 遍历的字段都从它派生；菜单项**只能置灰不能删**（UXP id 插件级全局唯一，同名会整块面板起不来）。
- ⛔ 注册（激活）面板打开期「整菜单门控」：`MenuManager.setLicenseDialogOpen(open)` 按白名单写 `enabled`（APP 留 `openLicenseDialog`+`openDocsFill`；工具箱留 `openDocsToolbox`），其余全灰；关闭后按默认还原。
- ⚠️ UXP 无 `fs`/`os`；落盘只用 `localFileSystem`；`getFileForSaving` 必须在 `executeAsModal` 之外调。
- ⚠️ Edit 工具偶发「报成功但没落盘」⇒ 改完必须 grep 复核。

---

## 记忆维护约定
- `MEMORY.md`（本文件）= 索引 + 铁律；`refs/*.md` = 主题明细；`HISTORY.md` = 精简项目历程。
- 新知识按主题归入对应 refs；只有「一眼要用」的才上提到本文件。
- **不写「某次改了什么」的流水账**，只留结论 / 铁律 / 踩坑点；废弃版本仅在「防止重走」时留一行。
- 配套技能：`.workbuddy/skills/uxp-frontend-spec`（前端规范）、`.workbuddy/skills/algo-param-bench`（算法对拍）。
