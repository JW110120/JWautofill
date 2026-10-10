# 前端样式 / 模式详述（JWautofill）

> MEMORY.md 的展开页。改样式、布局、交互模式前先读本文件；UXP 通用坑（①–㉑）在项目技能 `uxp-frontend-spec`。

## 紧凑模式（5 个作用域独立：app/color/pattern/gradient/stroke）
- `AppState.compactModes`（PanelStateManager 持久化，参数复位保留）；旧单个 compactMode 已废弃。
- 菜单项只作用当前面板(compactScopeOf)，文案 `紧凑模式：{面板名} - 开/关`。app.tsx：toggleCompactMode +
  syncCompactModeClasses（挂/摘 5 个 `body.compact-{scope}`）+ syncCompactMenuLabel（状态变或面板切换都要重写）。
- CSS：父面板 `body.compact-app #app .main-title/.panel-footer/.app-root>.panel>.panel-section .divider`；
  子面板靠根钩子 `.subpanel-*` 配 `body.compact-* … .divider`。`.subpanel-title-1` 不可隐藏；底部 info 条挂 `.panel-footer` 整块隐藏。
- ⚠️ 间距基准（2026-10-07 实测校准，**内容盒 230px**＝面板 250 − padding 10×2）：藏 divider 后「清除模式→填充模式」补
  `margin-top:15px`；紧凑填充不渲染「填充模式」标签 → 分区首元素即三列 radio。
  **「填充选项」内容区 4 处行距现统一 13px**（原 10px，用户要求 +3px）：
  ① `.fill-mode-section + .row-grid` margin-top 13 / ② 同一元素 margin-bottom 13
  （第 2 行 margin-top 已被 `.row-grid + .row-grid` 归零）/ ③ `.row-grid-fit` 下边距 8 + 复选组首行 5
  / ④ `.row-grid-flush .row-start + .row-start` margin-top 8（+ 逐行 5px 下边距）。
  ⚠️ 只动这 4 处、全部 `body.compact-app` + 主面板滚动区链限定；common.css 通用 10px 档不动。
  ⚠️ 行盒实测：自绘开关占位盒 **24px**（原生 sp-switch 的 32px 已作废），标签盒 22px。

## 折叠分区（.collapse-section）纵向节奏
- 结构：`.collapse-section > .collapse-header + .collapse-content-expanded`，两者都是块级。
  `.collapse-header{padding:10px 0}`；`.collapse-content-expanded{max-height:1400px}`（无 padding/border ⇒ 首元素外边距会折叠穿透到它身上）。
- **「标题 → 内容首行」间距 = 标题 `padding-bottom`(10) + 内容首元素自身的 `margin-top`**。
  ⇒ 首元素是 `.row-between` 时 = 10 + **10** = 20px；首元素是 `.panel-section` 时 = 10 + **0** = 10px。
  ⚠️ `.panel-section` 只定义 `margin-bottom:15px`、**没有 margin-top** —— 拿它当分区首元素就会出现 10px 落差
  （2026-10-07 实例：`选区改造`→`平滑` 20px vs `填充选项`→`纯色` 10px，用户直接报出来）。
  修法：`#app .fill-mode-section{margin-top:10px; margin-bottom:10px}`（上下同值、与 `.row-between` 同档）。
- 紧凑模式：`body.compact-app … .collapse-content-expanded > :first-child{margin-top:5px}` 把两类首元素**一起拉平**，
  ⇒ 两区都是 **15px**，所以「普通模式改完仍要在紧凑模式复测」——紧凑模式本来就对，别重复补偿。
- ⚠️ **间距取「盒对齐」而不是「墨迹对齐」**：本仓滑块行首元素是 32px 数字框（墨迹就在盒顶，偏移 0），
  radio 行首元素是 `.radio-vertical .radio-option`（盒高 23px、`.icon-button` 24px 溢出 0.5px、svg 18px）
  ⇒ 齿轮墨迹比盒顶低 **2.5px**。按墨迹对齐要写 `margin-top:7.5px`，那就把「图标 18px」耦合进了间距令牌，
  图标一改静默失配。**按盒对齐写 10px**，残留 2.5px 内缩是控件高度决定的、不写进间距。
- 已校准的固定档：普通模式「渐变行 ↔ divider」= 「divider ↔ 新建图层行」= 10px（靠 `.fill-mode-section` 上下各 10px + 折叠取 max）。

## 专注模式
- 条件：「自动关开关」+「自动切套索」同勾即成立（推导值，不存 state；共享 `utils/FocusModeBus.ts`）。
- 行为：主开关热键只开不关；圆点换星形 FocusStarIcon(13×13)；工具箱置顶记录文案「选区填充」。

## 样式单一来源（src/styles/common.css）
- index.tsx 顺序 uxPerfPatch→common→app→license；严禁 @import。状态样式统一放底部「集中管理区」；选中/落点一律 border 变色，禁 outline。
- 通知：`.status-banner`(横幅)/`.notify-bar`(单行状态条)/`.notify-text`(唯一定义)；title 收口 helpTexts.ts。
  开=notify-bar-ok(绿)、关=notify-bar-disabled(描边 --disabled-color + 底色 --bg-color，**不用 warn 橙**)。
- 两列网格（唯一容器类）：
  `.row-between.row-grid`(**必须双类**) + `.grid-cell` + `.grid-cell + .grid-cell{margin-left:10px; align-items:flex-end}`
  （左列 stretch+子行 `.row-start` 贴左缘；右列 flex-end 收成内容宽贴右缘，左右各距面板外缘 10px）。
  ⚠️ **必须相邻兄弟选择器，不能用 `:last-child`**（单格网格同时命中 first+last，flex-end 胜出把唯一列推到最右缘）。
  修饰档 `.row-grid-flush`（紧贴 divider 的复选框组，内层 `margin:5px 0`）与 `.row-grid.row-grid-fit`
  （**必须双类**，两列 `flex:0 0 auto` + flex-start + 列距 5px；纵向节奏靠 `.row-grid + .panel-section` 命中）。
  ⚠️ 紧凑描边行右侧控件条件渲染会撑行高 → 现用 `.row-grid-fit .grid-cell + .grid-cell{position:relative}`
  + 其 `.row-end{position:absolute;right:0;top:50%;translateY(-50%)}` 把内容**摘出文档流**（行高恒由左列决定）；
  早期那套 `.row-end{margin-top:-2px;margin-bottom:-2px}` 已废弃。
- 紧凑描边行右列控件组（2026-10-07 由「色板+齿轮」改为「描边设置文字按钮 + 色框」，色框在右）：
  **总宽必须与上一行「清除模式 + 开关」严格相等 = 94px**，两组才在右对齐下左右缘同时对齐。
  94 = `.label-4`(47) + 其 `margin-right`(10) + **4px** + 尾控件(33)。
  ⚠️ 那 4px 来自通用规则 `.row-between .toggle-switch{margin-left:4px}` —— 它是**后代**选择器，
  `.row-start` 里的开关也会命中；槽是 `<div class="stroke-color-slot">`（33px + `margin-left:4px`、
  内右对齐）拿不到它，**必须手动补那 4px**，否则整组差 4px、左缘错开。
  ⚠️ 槽内 `.color-preview` 必须 `margin:0`（通用类自带 `margin:0 10px`，会撑宽槽并让右缘缩进 10px）。
  ⚠️ 文字按钮复用 `.label-4`（而非自定义宽度）就是为了拿到与「清除模式」同一套字盒 → 左缘天然对齐。
- ⚠️ **`.label-N` 定宽比汉字窄约 6.6px**（`20+(n-2)×13.3`），文字靠 `margin-right:10px` 遮溢出；
  「标签盒右缘要对齐容器右缘」的新布局必须先补这 6px（例 `.radio-trio sp-radio .label-2{width:26px}`）。
- 三列 radio `.radio-trio` 容器级自适应：`sp-radio-group{justify-content:space-between;flex-wrap:nowrap}` + `sp-radio{flex:0 0 auto}`；
  缩进走容器 `padding:0 10px`（**不用 transform**，不参与布局会被推出右缘）；两处 DOM 同构 `.panel-section > .radio-trio > sp-radio-group`；
  紧凑填充用 `.radio-trio-flush{margin:0 auto}` 归零纵向外边距（⚠️ 不能用 `body.compact-app … .radio-trio{margin:0}`，会连带命中描边子面板同名容器）。
- 滑块行统一 DOM：行容器 `calc(100% - 20px)`、`ew-resize`，70px 文案标签 + 数字输入框 + `.num-unit` 单位符号。
- ⚠️ **UXP 原生 `input[type="checkbox"]` 的布局盒比可见方块宽，方块居中画在盒内**
  ⇒ 墨迹与盒子边缘之间**左右各 ≈4px 空档**（2026-10-10 第三次真机复测，**推翻了旧版
  「盒 ≈28px、方块贴盒子左侧 ⇒ 右侧空 9–10px」的假设**——那条按 headless 标定，实机不成立）。
  实测口径（用户截图，**本仓截图恒 1.5×**）：渐变「反向 / 保留不透明度」行，容器内缘右 = 行右缘
  = x345.5，右列 checkbox 墨迹右缘 = x339 ⇒ 空档 6.5px@1.5× ≈ 4.3px。
  两条补偿规则（`.border-panel-section` 作用域，渐变 + 图案共用）：
  `… > .row-between.row-grid.row-grid-flush { width: calc(100% + 4px); margin: 0 -4px 0 0; }`
  ⚠️ 必须连 `width` 一起放大：`.row-between` 自带 `width:100%`，作 flex 子项时交叉轴被钉死，
  **只写 `margin-right` 无任何视觉位移**（已确认的根因）。
  ⚠️ 补偿值 = 原生盒内空档实测值（4px），**不是 10px**；写 10px 会把复选框多推 6px，
  墨迹右缘距容器内缘只剩 4.3px（用户报「偏小」）。
  ⚠️ 左列本来就对：内容盒左缘距容器内缘 10px（「反向」墨迹 10.3px，差的 0.3 是字形左边距）。
  ⚠️ 浮窗内**已无 row-grid**（填充设置浮窗改成逐行 `.row-between` + 自绘 `ToggleSwitch`，
  开关无原生墨迹空档）⇒ 旧的 `.float-window > .panel-section > …row-grid` 那条已删，勿再加回。
- ⛔ **自包含状态类：一个元素只挂一个类，基态盒模型写进共享选择器列表**。
  `.icon-button` / `.icon-button-disabled` / `.icon-button-latched` 共享盒模型块，各自只加差异声明；
  常亮态不得靠「同时挂基态 + 修饰类」实现（会引入顺序依赖）。
- ⛔ **常亮态配色只定义一次（`--latched-bg` / `--latched-icon`，基础 `:root`）**，各 `@media` 不重定义即继承。
  `--latched-bg: rgb(38,128,235)` + `--latched-icon: rgb(255,255,255)`（对比度 3.9:1 ≥ 非文本 3:1）。
  ⚠️ **不可复用 `--hover-icon`**（lightest 主题仅 2.9:1，不达标）。
- ⛔ **描边型图标的 `fill` 与 `stroke` 必须分两条状态规则**：
  `.icon-button:active .icon-fill{fill:…}` 与 `.icon-button:active .icon-stroke{stroke:…}` 分开写。
  合并成一条 `… .icon-fill, … .icon-stroke { fill:… }` 会让 (0,2,0) 的 `fill` 压过 `.icon-stroke{fill:none}`(0,1,0)，
  把开放路径 fill 成实心。
- ⛔ **浮窗打开时：`number` 输入一律「无条件全量隐藏」**（2026-10-10 用户要求回退，
  **作废**「按矩形相交精确隐藏」那版）：`input-fix.css` 的
  `body.app-visibility-panel-open #app input[type="number"]` / `body.app-fill-settings-open …`
  （**必须带 `!important`**，压过 `.panel-section ~ .panel input[type=number]{visibility:visible}` 的 (1,3,1)）。
  原因：`number` 是原生视图，永远画在面板最上层，浮窗压不住；「只藏相交者」实测效果差。
  `utils/popOverlay.ts` 的 `createOcclusionSession()` **仍服务「展开下拉菜单」**（Select.tsx），
  不是死代码；其语义/兜底/内联 `!important` 规则见文件内注释，勿套回浮窗。
- ⚠️ **浮窗高度 = 内容包裹**，末行下方不得再叠「版面节奏」外边距：
  `.float-window > .panel-section{margin-bottom:0}` +
  `.float-window > .panel-section > *:last-child{margin-bottom:0}`
  ⇒ 底距 = 窗口自身 `padding-bottom` 10px。
  不归零时 = 10(窗口 padding) + 15(`.panel-section` 下边距) + 10(末行 `.row-between` 下边距)
  + ≈5(行盒下沿) ≈ **40px**（用户截图实测 60px@1.5×）。
  ⚠️ 只作用 `.float-window` 直接子级——普通面板的 `.panel-section` 仍需 15px 节奏
  （同款手法见 `clear.css` 的 `.subpanel-clear > .panel-section:last-child`）。
- ⛔ **浮窗「始终置顶」：浮窗与子面板可以共存，浮窗必须在上**（2026-10-10）。
  层级表：子面板/子面板级浮层 = **9999**；真·浮窗（隐藏/显示分区 / 填充设置）= **99999**；
  `#app` 浮窗在 `body.app-{visibility-panel,fill-settings}-open` 下再抬 **100000**；
  激活弹窗 = **100001**（专属类 `.license-dialog-overlay`，仅 LicenseDialog 用）。
  · 主面板 5 个子面板的 9999 来自 `input-fix.css` 的 `#app .panel-section ~ .panel`；
  · 工具箱「功能快捷键」**必须**在 `adjustment.css` 里显式降到 9999
    （`.float-overlay.func-hotkey-overlay{z-index:9999 !important}`）——
    它与「隐藏/显示分区」同用 `.float-overlay`（99999），同档时靠源码顺序决胜，
    而它写在浮窗**之后** ⇒ 开了子面板再开浮窗，浮窗反被压住（用户报的形态）。
  ⚠️ ⛔ **工具箱不能照抄 `#app` 那条抬到 100000 的规则**：它的 body 类
    `visibility-panel-open` 同时服务浮窗与功能快捷键子面板，抬层级会把两者一起抬
    ⇒ 同档后又退回 DOM 顺序决胜，等于没修。工具箱只靠「子面板降 9999」区分。
  ⚠️ 子面板 / 浮窗共存时，下层子面板的原生 `number` 输入同样被隐藏
    （`#app` 由 input-fix.css 的 body 类规则覆盖到全部后代，含 5 个子面板；
     工具箱由 adjustment-input.css 的 `body.visibility-panel-open #pixeladjustment …`）。
  ⚠️ `MenuManager.setAppVisibilityItemEnabled` **已删除**：子面板打开期间不再置灰
    「隐藏/显示分区」菜单项（浮窗可共存且置顶后，那条限制失去意义）。

### ⛔ 多浮窗「堆叠」模型（2026-10-10 重构，取代「每窗一层遮罩」）
- **旧实现的病**：每个浮窗各挂一层 `.float-overlay`（z=99999）⇒ 开两个时
  ① 两层半透明遮罩叠加 ⇒ 视觉变暗；② 两个 `.float-window` 同档靠源码顺序决胜 ⇒ 后开的盖住先开的。
- **新结构**：**单层 `.float-overlay`（遮罩恒一层，不透明度不叠加）> 一个 `.float-stack` > 多个 `.float-window`**。
  - 堆叠顺序 = `state.floatOrder: FloatWindowId[]`（类型 `'visibility' | 'fill'`，见 `types/state.ts`），
    数组顺序即 DOM 顺序 ⇒ **后开的 concat 到末尾 = 排在下面**（用户要的「新开的在下面」）。
  - 关闭 = `filter` 掉该 id ⇒ 数组缩短、下方自动**上移顺延**（无需手写位移）。
  - 间距 10px 靠 `.float-stack > .float-window + .float-window{margin-top:10px}`（**相邻兄弟**，只给 2 个以上时）。
  - `.float-stack{width:100%;max-height:100%;overflow-y:auto;display:flex;flex-direction:column;align-items:stretch}`
    —— 单列纵向、可滚动；宽度/高度继承遮罩，浮窗自身 `padding` 与 `max-height` 语义不变。
  - 点遮罩空白 = `closeAllFloatWindows()`（清空 `floatOrder` + 关两浮窗 = 整层关闭）。
- ⚠️ 浮窗本体的 `z-index` 现在只剩 `.float-overlay` 这一档（99999 / `#app` 下 100000），
  下面的 `.float-window` 不再各自带层级（同层内靠 flex 顺序排布，不再需要 z 决胜）。

### ⛔ body 遮挡类一律「按 state 派生」（消除悬空类）
- `app.tsx` 新增 `syncFloatPanelClasses()`，只在 `componentDidUpdate` 里、且两个浮窗 boolean 变化时跑：
  `toggle('app-visibility-panel-open', vis)` / `toggle('app-fill-settings-open', fill)`。
- **为什么不能 imperative add/remove**：`onResetParameters` 走 `...initialState` 整体覆盖，**绕过**
  `closeVisibilityPanel/closeFillSettingsPanel` ⇒ 若在 close 里 `classList.remove`，复位后 body 类**悬空**
  ⇒ `input-fix.css` 的「浮窗期隐藏 number」永久生效（数字再也不显示）。
- reset 现值须保留 `showVisibilityPanel` / `isFillSettingsOpen` / `floatOrder`（浮窗不属于「参数」，不复位）。
- ⛔ **共用 body 类只能有一个派生点**：工具箱 `AdjustmentPanel.tsx` 曾有**两条独立 effect** 都无条件
  `classList.remove('visibility-panel-open')`（一条管浮窗、一条管「功能快捷键」子面板）⇒ 关浮窗时前一条
  cleanup 摘掉类 ⇒ 子面板仍在开、数字重新冒到它上方（用户报的「工具箱有、APP 无」形态，根因即此）。
  已合并为**单条派生 effect**：`const anyOverlayOpen = showVisibilityPanel || showFuncHotkeyPanel` 才 add，
  cleanup 才 remove，依赖 `[showVisibilityPanel, showFuncHotkeyPanel]`。

### ⛔ 子面板互斥铁律（一个父面板同时只能开一个子面板）
- 唯一入口 `app.tsx::setSecondaryPanel(id: 'color'|'pattern'|'gradient'|'stroke'|'clear', open: boolean)`：
  **一次 `setState` 同时写全部 5 个 boolean**（`id===open` 者 true，其余 false）⇒ 天然互斥，开新的顶掉旧的。
- 所有入口（`toggleStrokeSetting` / `toggleColorSettings` / `openPatternPicker` / `openGradientPicker` /
  `toggleClearSetting` / `applyFillPanelHotkey`）**一律 delegate 到它**，**禁止**再各写各的 boolean。
- 加新子面板时：在 `setSecondaryPanel` 的 id 联合类型与 5 个 boolean 列表里同步补一处（**唯一改动点**）。
- 浮窗不受此限（一个父面板可**多个浮窗**并存）；只有「子面板」互斥。

### ⚠️ 灰度显示不得污染预览的「真实尺寸基准」
- 灰度态缩略图是**降采样**的（`PatternPicker.tsx` `GRAY_THUMB_MAX = 104`px，为 52px 缩略框服务）。
  其 `onLoad` 曾**无条件**写 `previewNaturalRef.current[id] = {w,h}` ⇒ 把最终预览的基准钉成 104px
  ⇒ 预览 `fit = min(1, refW/…)` 饱和为 1 ⇒ **「缩放」参数与预览右侧下拉「失灵」**（需求 3 的根因）。
- 铁律：`previewNaturalRef` **只记真实（非灰度）图片的自然尺寸** —
  `if (!grayPreviewUrlsRef.current[pattern.id]) previewNaturalRef.current[pattern.id] = {w,h}`。
- 灰度态最终预览要「全尺寸」：烘图 effect 触发条件由 `previewAngleDeg !== 0`
  放宽为 `previewAngleDeg !== 0 || shouldShowGray`（角度 0 的灰度也要烘一张全尺寸灰度图）。

## 用户文案（src/constants/helpTexts.ts）
- **读者 = 精通 PS 的画师**：羽化、不透明度、通道、蒙版、中间值、混合模式、alpha 一律不解释；
  只改「PS 范围之外的词」：邻域、连通块、直方图、归一化、颜色传播源、高频/低频、事件驱动、全局键盘钩子。
- **语气 = 说明文不是教程**：禁「一句话：」「解决什么问题：」「你可以」「不用自己试」这类教程腔与第二人称；补主语只补「插件/该值/选区」。
- **改法 = 手术式修订**：只动真有问题的条目，合格句子逐字保留（曾因 117/117 全改被整体回退）；动笔前先读源码核实语义。
- 验证：key 集合/顺序 vs `git show HEAD:` + node `ts.transpileModule` 实跑导出 + 术语黑名单 grep。
- ⚠️ `git checkout .` 会连 `.workbuddy/memory/` 一起回退。

### 对外的《使用手册》与 README（docs/*.html + README.md）
- **同一受众与口吻**：写给「有 PS 基础的画师」，不是软件设计师、也不是作者本人。说明文，不写教程腔；
  PS 术语直接使用，**不解释实现原理**。README 只留用户向内容（简介 / 系统要求 / 安装 / 激活 / 快速开始 /
  两块面板的能力 / 全局快捷键 / 常见问题 / 许可），**不再放「开发构建」等开发者段落**。
- **尺度（2026-10-10 用户明确要求）**：不给用户讲实现细节，也不抛「看了没用」的内部信息。已知需**去掉**的：
  注册表键名与 `LowLevelHooksTimeout`、日志文件路径、`imaging API` 之类的内部依赖名、
  「全局低层键盘钩子 / HID 中断管道 / ctxtmon」等机制词、内部处理流程分步。
  「键盘卡死一键修复」只保留：症状 → 鼠标点一下即可 → 不需要键盘输入 → 不删配置 → 修完回「笔刷热键」重启服务。
- **两份手册的章节与其导航必须一一对应**（改内容时同步改 `<nav>` 与页内锚点）；
  改完用脚本核对关键标签成对（`section/table/div/ul/ol/nav/main/figure/tr/th/td/h2-4/p/li/span`）。

---

# CSS 铁律细则（2026-10-08 由 MEMORY.md 下沉，正文逐字保留）

- ⛔⛔⛔ **【血泪，2026-10-07】注释块外的「游离文本」会被当成选择器，静默吃掉紧随其后的整条规则。**
  `common.css` 里 `.radio-trio-group` 与 `.radio-vertical` 两条规则**被同一手法连坐吃掉**，
  导致「三列 radio 竖排成三行」连查 5 轮、前 4 轮所有 CSS 修复全是空转（规则根本没挂上去）。
  机制：写中文注释时多打/挪动了一个注释结束符 ⇒ 注释提前闭合 ⇒ 后面的文案跑到注释外 ⇒
  解析器把它当选择器 ⇒ `{ …声明… }` 成了那个垃圾选择器的声明块 ⇒ 规则永不命中。
  三条纪律：
  ① 编辑中文注释**不要移动/重复注释结束符**，且**注释正文里禁止出现该结束符的字面两字符形式**
  （写「注释结束符」这个说法），否则连「提醒后人」的注释本身都会再次踩坑（本轮已自踩一次）；
  ② **改完 CSS 必须机器校验**：注释开/闭计数相等，且逐字符扫描「注释外不得出现结束符」。
  ⚠️ 校验要区分「未闭合」与「游离结束符」——`pattern.css` 的嵌套写法是**假警报**（内层开标记在 CSS 里只是文本）。
  ③ **「反复改却毫无效果」时立即停止调声明**，先验证**规则是否命中元素**（postcss 解析出选择器 / 浏览器实测 rect）。
  本 bug 曾被误读为「容器塌缩成 52.5px」——那其实是「每项占满整行时文字墨迹的右缘」（详见 2026-10-07 日志）。
  实证手法：`postcss.parse(css)` 后 `walkRules` 打印选择器；或 headless 浏览器注入探针打印
  `getComputedStyle + getBoundingClientRect`（修复前 `三项各 w=230@x=20`，修复后 `w=44@x=20/113/206`）。
  ④ **修完必须复查同区域注释里是否残留「与新结论冲突的旧处方」** —— 错误处方比没有注释更危险，
  后来者会当权威照抄（本轮同一段里就并存过「必须 `flex:1 1 0` 等分」与「必须 `flex:0 0 auto`」两套对立说法）。
- ⚠️ **状态灯/辉光不要写死半透明浅色**：`.indicator-ok` 的 `box-shadow: rgba(46,204,113,0.6)` 在浅色底上冲淡成灰绿（用户反馈"发灰"）
  ⇒ 辉光改 `currentColor`（自动跟随令牌）+ 亮色主题 `--notify-ok-fg` 调深为 `rgb(15,109,52)`。专注模式靶心 `drop-shadow` 同理。
- ⚠️ UXP 不支持 `:has()`：静默失效、构建与 DevTools 都不报错 ⇒「按后代特征选中祖先」只能在 TSX 加显式类名（技能 ㉑）。
  （`:last-child` / `:nth-child()` **可用**，pattern.css 已实测。）
- ⚠️ **替换原生控件时，必须核对「调用方从事件对象的哪个属性取值」**（2026-10-07 血泪）：
  自绘 radio「怎么点都没反应」= `app.tsx` 从 **`event.target.selected`** 取值，而自绘组件回传裸字符串 ⇒ `event.target` undefined，
  **异常又被函数体 `try/catch{}` 静默吞掉** ⇒ 不报错、点了没反应。
  ⇒ ① 只看类型签名（都是 `(e)=>void`）会漏判；② **`try/catch` 吞异常会把 bug 伪装成「点击无响应」**，
  排查此类问题先 grep 调用方取值属性，别怀疑布局/层叠；③ `onChange` 回传 `{target:{value, selected}}` **两个键都给** ⇒ 两条路径都能工作、调用方零改动；
  ④ **替换组件后必须逐个复核调用点签名**，不能只改 JSX 标签名。
- ⚠️ **原生 `sp-radio-group` 不可控，一律用自绘 `components/RadioGroup.tsx`**（自绘后原生已清零）。
  原生两条硬伤：内部排版由宿主实现（`flex-wrap:nowrap`/`justify-content` 拦不住折行）；自带 **15px 水平内边距**。
  ⚠️ 自绘版版式要点：`.radio-trio-group`/`.radio-pair-group` 容器 `space-between` + **项按内容宽 `flex: 0 0 auto`**
  ⇒ 首末项贴边（内缩 0）、三项等宽时中项**精确**落在容器中心。**不要再改成 `flex:1 1 0` 等分**（项盒宽于内容 ⇒ 内容靠格左缘 ⇒ 首末项反而内缩）。
  ⚠️ 历史上「容器两边有大空隙」的真因是**两层 padding 叠加**（`.radio-trio` 包装层 `padding:0 10px` + 父容器已有 10px；
  包装层已删除，现行结构是 `.panel-section > .radio-trio-group`）。另一因：`margin:auto` 的**横向 auto 会禁用 stretch**。
  ⚠️ **通用教训：「元素没占满容器」要查整条祖先链上每层的 padding/border/margin（尤其两层都有的叠加）**，
  只盯目标元素加 width 会连续无效。
  ⚠️ `.radio-option` 必须显式写 `justify-content: flex-start`：**UXP 的 flex 容器隐式默认是 `center`**（非 web 的 flex-start），
  凡「盒宽大于内容宽」的版式都会把内容居中、看起来像被加了左右 padding（`.radio-vertical` 早先就踩过）。
- ⚠️ **「两组控件要双向对齐」的唯一可靠做法是让两组总宽相等**，而不是给某一组加 padding 去凑
  （2026-10-07 实例：紧凑描边行右列组 = `.label-4`(47) + 其 `margin-right`(10) + **4** + 尾控件槽(33) = **94px**，
  与上一行「清除模式 + 开关」严格同宽 ⇒ 右对齐后左右缘偏差实测均为 0）。
  ⚠️ 那 4px 来自**后代选择器**型通用规则 `.row-between .toggle-switch{margin-left:4px}`
  （`.row-start` 里的开关也会命中）—— 排查「莫名差 N px」先怀疑这类规则在异地生效。
- ⚠️ **折叠分区「标题 → 内容首行」的间距 = 标题 `padding-bottom`(10) + 内容首元素自身的 `margin-top`**
  （`.collapse-content-expanded` 是块容器，首元素外边距会折叠穿透到它身上）。
  ⇒ 首元素是 `.row-between` = 20px；是 `.panel-section`（**只有 margin-bottom、无 margin-top**）= 10px
  ⇒ **拿 `.panel-section` 当分区首元素必然比 `.row-between` 少 10px**（2026-10-07「填充选项→纯色」实测）。
  紧凑模式由 `… .collapse-content-expanded > :first-child{margin-top:5px}` 把两类一起拉平（皆 15px），**别重复补偿**。
  ⚠️ **间距令牌一律取「盒对齐」不取「墨迹对齐」**：墨迹偏移由控件盒高/图标尺寸决定，
  写进 margin 会把无关尺寸耦合进令牌（本轮若按墨迹对齐要写 7.5px，图标一改即静默失配）。
- ⚠️ **改版式前先用像素脚本量用户截图**，不要目测估：缩放（用已知尺寸控件反推，本仓截图为 **1.5×**）、
  内容盒宽（父面板 **230px** = 250 − padding 10×2）、行 pitch、控件几何都能量出来。
  ⚠️ 用 headless 浏览器搭测量台时**必须复刻完整祖先链**（`.panel > .panel-section > …`）：
  少一层就会让整族 `body.compact-app …` scoped 规则静默失效，两模式测出同一组数据（本轮白跑一次）。
- ⚠️ **数字输入框与单位符号必须定宽**（29 处调用点）：
  ① `.num-input-row { width: 34px }`（border 1px×2 + input 32px）；② `.num-input-row input { width: 100% }`；
  ③ `.num-unit { margin-left: 0; width: 16px; flex: 0 0 16px; justify-content: flex-end }`
  （`%`/`px`/`°` 字符宽不同 ⇒ 不定宽则单位右缘随内容漂移；16px 按最宽单位 `px` 的字身宽上限取）。
  ⚠️ 不要写 `.num-input-row:has(input[type="text"])`（`:has()` 静默失效）⇒ 更宽变体（渐变 `#RRGGBB`）
  走显式类 `.num-input-row-wide{width:62px}` 由 TSX 挂上。⚠️ `align-items: right` **不是合法值**、会被忽略 ⇒ 用 `center`。

## ⛔ 三条「平台级不可能」——别再走第二次（2026-10-10 实测定论）
- ⛔⛔⛔ **UXP 的 CSS transform 只实现 `scaleX/scaleY` + `translate` + `transform-origin`，没有 `rotate()`。**
  依据：UXP Changelog v8.0.1（`CSSNextSupport`）新增能力清单只有这三项；Adobe 论坛官方回复
  「Rotate a div 90 degrees… **Rotation is not currently supported**」。
  ⇒ **加在任何元素上的 `rotate()` 都被静默忽略**（不只 `<img>`；加 `translate()` 定位却生效，
  所以「图片位置对、只是不倾斜」正是这个组合的症状）。
  需要倾斜只能**把旋转烘进像素**（本仓 `PatternPicker.tsx` 的 `rotatePatternPreview()`：
  反向映射 **双线性 + 预乘 alpha** 重采样 → **输出取旋转矩形的外接矩形、矩形外 alpha=0**
  → 自己编码 PNG（`src/utils/pngEncode.ts`）→ 普通 `<img>`）。
  ⚠️ 推论：**不要把 `rotate()` 写进内联 style 后期待它生效**——会静默失效且无任何报错。
- ⛔⛔ **UXP 的 SVG 渲染器只服务「简单图标」，`<svg><image href|xlink:href="data:…">` 不渲染。**
  依据：官方 Known Issues「UXP's SVG renderer is targeted for simple icons and the like」；
  本仓把图案预览从 `<img>` 改成 `<svg><image>` 后**预览整片空白**（实测）。
  ⇒ 需要「按数据 URL 画一张图」时**一律用 `<img>`**，不要绕 SVG/`foreignObject`（后者必然不支持）。
  另注：UXP 无 Canvas（官方 unsupported 清单），像素改写只能走 `imaging.*`。
- ⛔⛔ **`imaging.encodeImageData` 只支持 JPEG**（官方类型定义原文：*With the current version of UXP you
  must use jpeg/base64 encoding when assigning to an image element*）⇒ **JPEG 无 alpha ⇒ UXP 里「透明」
  无法由该 API 表达**。「矩形外要透明」这类需求只有一条路：**自己编码 PNG**。
  本仓 `src/utils/pngEncode.ts`：手写 IHDR/IDAT/IEND + CRC-32 + Adler-32，deflate 只发**存储块(BTYPE=00)**
  （零依赖、零算法风险，膨胀 ~0.008%，数据量由调用方封顶 `MAX_ROTATED_PX`）；
  `bytesToBase64` = 分块 `String.fromCharCode` + 一次 `btoa`（UXP **有** `btoa`）。
  ⇒ 别再试 `format:'png'`；也别指望 Canvas（UXP 无）或 node 的 zlib（UXP 无）。

## ⛔ 原生输入框的文字垂直位置：**只能移动盒子，padding 无效**
- UXP 的 `input` 是**原生视图**，其文字绘制区**锚在控件盒上缘**、不按 CSS `line-height` 做行盒居中，
  也**不随 `padding` 的内盒变化走**（`padding-top` 实测基本无效，只会「好一点点」）。
- 实测数据（1× 截图，`.num-input-row` 行容器）：容器 y6..37（32px，几何中心 21.5），
  12px 思源黑体的「100」墨迹 y15..23（中心 19）⇒ **偏上 2.5px**；
  反推「墨迹顶 = 绘制区上缘 + 5.1px」⇒ 绘制区上缘必须落在容器 12px 处。
- ✅ 正确杠杆 = **改 `input` 自身盒子**：`.num-input-row`(32px, `align-items:center`) 下，
  `height: 24px → 20px` 让上下留白 4px→6px、盒顶 10→12px，墨迹即落回几何中心。
  **统一规律：盒高每减 2px，文字下移 1px。** 微调就按这个 1px 步进走（同步改 `line-height` 保持一致）。
- ⛔ 不要用 `line-height` 调（原生控件忽略）；不要再回到 `padding-top` 方案（已验证无效）。
