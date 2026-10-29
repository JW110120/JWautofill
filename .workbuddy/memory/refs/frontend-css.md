# 前端样式 / 交互模式（JWautofill）

> `MEMORY.md` 的展开页。改样式、布局、交互模式前读本文件；UXP 通用坑清单见技能 `uxp-frontend-spec`。
> 只记**当前有效**的做法与铁律；废弃写法若值得警惕，用一行「勿再用」带过。

## 一、样式单一来源

- 通用组件样式只存在于 `src/styles/common.css`；面板 CSS（`app.css` / `adjustment.css` / `pattern.css` / `clear.css` …）只写该面板独有的类。
- `index.tsx` 引入顺序：`uxpPerfPatch → common.css → app.css → license.css`；**严禁 `@import`**（`app.css` 聚合本面板子 CSS 除外）。新 CSS 必须挂进这条链。
- 状态样式（hover / disabled / selected / drop-target）统一放 common.css 底部「集中管理区」；选中/落点一律 **border 变色**，禁 `outline`。
- 加载顺序带来的坑：`common.css` 是静态 `<link>` 先加载，`app.css` 由 style-loader 运行时后注入 ⇒ **跨文件同特指度时 app.css 的 `color` 会盖掉 common.css 的 `.label-disabled`**。跨文件必须写两级类（`.app-xxx.label-disabled`）；同文件内靠后置规则即可。

## 二、尺寸与间距（整数像素，禁小数）

| 对象 | 定值 / 公式 |
| --- | --- |
| 面板可用宽 | 250（manifest）− padding 10×2 = **230**；带滚动条时 220 |
| 文字标签 `.label-N` | `20 + (n−2)×13.3` → 2/3/4/5/6 字 = 20/33/47/60/73px，13px，右 margin 10 |
| 动作按钮 `.action-button-N` | `13×字数 + 20`，高 30；>8 字用 `.action-button-auto` |
| 数字输入 | `.num-input-row` **定宽 34px**（= border 1 + input 32 + 1）× 32px；`input` `width:100%`、`height:20px`（见 §十一）；单位 `.num-unit` 在容器外、**定宽 16px、`margin-left:0`、右对齐** |
| 缩略图 | `.thumb-box` 52×52（内图 46×46） |
| 预设网格 | 内宽 228：4 列 = 4×52 + 3×4（B=52、M=4），`:nth-child(4n){margin-right:0}` 锁列 |
| 圆角 / 描边 | 一律 `border-radius:3px` + `1px solid var(--border-color)` |

**两条经验规则**
- ⚠️ **间距令牌取「盒对齐」不取「墨迹对齐」**：墨迹偏移由控件盒高/图标尺寸决定，写进 margin 会把无关尺寸耦合进令牌（图标一改即静默失配）。
- ⚠️ **折叠分区「标题 → 内容首行」间距 = 标题 `padding-bottom`(10) + 内容首元素自身 `margin-top`**（`.collapse-content-expanded` 是块容器，首元素外边距会穿透）。首元素是 `.row-between` = 20px；是 `.panel-section`（只有 margin-bottom）= 10px ⇒ 拿 `.panel-section` 当分区首元素会少 10px，需显式补 `margin-top`。

### 两列网格（唯一容器类）

`.row-between.row-grid`（**必须双类**）+ `.grid-cell`：
- 左列 stretch、子行 `.row-start` 贴左缘；右列 `align-items:flex-end` 收成内容宽贴右缘，左右各距面板外缘 10px。
- ⚠️ **必须用相邻兄弟选择器 `.grid-cell + .grid-cell`，不能用 `:last-child`**（单格网格会同时命中 first+last，flex-end 胜出把唯一列推到最右缘）。
- 修饰档 `.row-grid-flush`（紧贴 divider 的复选框组）、`.row-grid.row-grid-fit`（**必须双类**，紧凑描边行）。
- ⚠️ **条件渲染的图标/色板槽会把行高顶起来**（开关一开一关就抖动）⇒ 把该槽**摘出文档流**（`.grid-cell + .grid-cell{position:relative}` + 内部 `.row-end{position:absolute;right:0;top:50%;transform:translateY(-50%)}`）。**不要用对称负外边距**——行高仍会 22↔24 变。

### 自绘单选组（`.radio-trio-group` / `.radio-pair-group` / `.radio-vertical`）

- 定稿版式：**项按内容宽 `flex: 0 0 auto`（不收缩） + 容器 `justify-content: space-between`**
  ⇒ 首项左缘贴容器左缘、末项右缘贴右缘（内缩天然 0）、项间空白自动均分、等宽时中项严格居中
  —— **不需要任何逐项对齐覆盖**。
- ⚠️ 容器必须显式 `width: 100%` + `box-sizing: border-box`：块级元素在 UXP 下**不被隐式拉伸**到父内容盒。
- ⚠️ **项不写 margin、不用 `flex: 1 1 0` 等分**：前者破坏贴边，后者让项盒宽于内容、内容靠格左缘 ⇒ 首末项反而内缩。
- ⚠️ 纵向版式 `.radio-vertical`：行盒 23px + 行距 10px（pitch 33）。行距用**相邻兄弟 `+`**（flex 列不折叠，末项带 margin 会撑大末段）；行盒下限 = 齿轮墨迹 16.67px。
  - 🔴 **再调只准一条路：量用户认可的目标截图的 pitch → 1:1 复刻**。从「白缝 / pitch 公式 / 行盒=内容高」反推的前几轮全被否。
- 旧原生 `sp-radio-group`、`.radio-trio` 中转包裹层、`.radio-pair-230` / `.radio-pair-210` 已全废，勿复用。

### 定宽标签的汉字溢出

- ⚠️ `.label-N` 比汉字实际宽度**窄约 6.6px**（`20+(n-2)×13.3`），文字靠 `margin-right:10px` 遮溢出（日常视觉间隙其实只有 ~4px）。
- 凡「标签文字右缘要贴容器右缘」的布局（定宽 `.label-N` + 右对齐）**必须先补这 6px**，否则文字溢出压到滚动条上。
- 自绘单选组不受影响：项按内容宽 `flex:0 0 auto`、文字用自然宽度，没有定宽字盒。

### 原生 checkbox 的墨迹空档

- ⚠️ 原生 `input[type=checkbox]` 布局盒比可见方块宽、方块**居中** ⇒ 墨迹左右各留 **≈4px**（不是 10px）。
- 贴右缘的两列复选框组补偿（`.border-panel-section` 作用域，渐变/图案共用）：
  `… > .row-between.row-grid.row-grid-flush { width: calc(100% + 4px); margin: 0 -4px 0 0; }`
- ⚠️ **必须连 `width` 一起放大**：`.row-between` 自带 `width:100%`，作 flex 子项时交叉轴被钉死，**只写 `margin-right` 毫无位移**。

## 三、紧凑模式（`body.compact-{scope}`，6 个作用域）

- 作用域：`app / color / pattern / gradient / stroke / clear`（已由 5 增至 6）。`CompactScope`、`COMPACT_CLASS`、`COMPACT_NAME`、`compactScopeOf`、`app.css` 的 `body.compact-*` —— **五处同步**。
- 状态存 `AppState.compactModes`（持久化，参数复位保留）；旧单个 `compactMode` 已废弃。
- 菜单项只作用**当前面板**，文案 `紧凑模式：{面板名} - 开/关`。
- 已校准的间距（内容盒 230px）：藏 divider 后「清除模式→填充模式」补 `margin-top:15px`；紧凑填充不渲染「填充模式」标签 ⇒ 分区首元素即三列 radio。紧凑模式由 `… .collapse-content-expanded > :first-child{margin-top:5px}` 把各类首元素**一起拉平到 15px** ⇒ 普通模式改完要在紧凑模式复测，但别重复补偿。

## 四、工具模式

- 条件：「自动关开关」+「自动切套索」同勾即成立（推导值，不存 state；共享 `utils/FocusModeBus.ts`）。
- 行为：主开关热键只开不关；圆点换 Spectrum「Target」靶心 `FocusTargetIcon(13×13)`（图标含 `<path>` 外环 + `<circle>` 内点**两个元素，都必须挂 `.icon-fill`**，否则内圈缺色）；工具箱置顶记录文案「选区填充」。

## 五、浮窗体系（APP + 工具箱共用 `.float-overlay` / `.float-window`）

### 结构与层级
- 浮窗必须挂在滚动容器 `.panel` **之外**（APP 挂 `.app-root` 层、工具箱挂 `.pixeladjustment-root` 层，两者 `position:relative`）。**不能用 `createPortal` 挂 `document.body`**（UXP 只渲染 `<uxp-panel>` 子树）。
- 打开期间收起该面板滚动条并补 10px 右内边距（内容盒不变、零重排）。
- 层级表：**子面板 / 子面板级浮层 = 9999；真·浮窗（隐藏/显示分区、填充设置）= 99999；`#app` 浮窗在 `body.app-*-open` 下再抬 100000；激活弹窗 = 100001**。
  - ⚠️ 工具箱「功能快捷键」与「隐藏/显示分区」同用 `.float-overlay`（99999）⇒ 它**必须**在 `adjustment.css` 里显式降到 `9999`（否则开了子面板再开浮窗，浮窗反被压住）。工具箱**不能**照抄 `#app` 那条抬到 100000 的规则（它的 body 类同时服务两者，抬层级等于没修）。

### 多浮窗「堆叠」模型
- 结构：**单层 `.float-overlay`（遮罩恒一层、不透明度不叠加）> 一个 `.float-stack` > 多个 `.float-window`**。
- 堆叠顺序 = `state.floatOrder: FloatWindowId[]`（`'visibility' | 'fill'`），数组顺序即 DOM 顺序 ⇒ **后开的 concat 到末尾 = 排在下面**；关闭 `filter` 掉该 id ⇒ 下方自动上移顺延。
- 间距 10px：`.float-stack > .float-window + .float-window{margin-top:10px}`。`.float-stack{width:100%;max-height:100%;overflow-y:auto;display:flex;flex-direction:column;align-items:stretch}`。
- 点遮罩空白 = `closeAllFloatWindows()`（清空 `floatOrder`）。
- ⚠️ 浮窗本体的 z-index 现在只剩 `.float-overlay` 这一档；下面的 `.float-window` 不再各自带层级。

### 高度与遮挡
- ⚠️ **浮窗高度 = 内容包裹**，末行下方不得再叠版面节奏：`.float-window > .panel-section{margin-bottom:0}` + `.float-window > .panel-section > *:last-child{margin-bottom:0}` ⇒ 底距 = 窗口自身 `padding-bottom` 10px（不归零会到 ≈40px）。
- ⛔ **浮窗打开时该面板的 `number` 输入「无条件全量隐藏」**：`input-fix.css` 的 `body.app-visibility-panel-open #app input[type="number"]` / `body.app-fill-settings-open …`（**必须带 `!important`**，压过 `.panel-section ~ .panel input[type=number]{visibility:visible}`）。`number` 是原生视图、永远画在最上层，浮窗压不住。
  - ⚠️ 隐藏规则必须「**属主 body 类名 + 属主根节点**」成对出现；两块面板共用同一个 `document.body`，写串了会出现「只开 A 的浮窗没修好、再开 B 才生效」的代偿假象。
  - `utils/popOverlay.ts` 的 `createOcclusionSession()` 仍服务「展开下拉菜单」（`Select.tsx`），**不是死代码**，勿套回浮窗。

## 六、面板 body 遮挡类：一律「按 state 派生」

- `app.tsx::syncFloatPanelClasses()` 在 `componentDidUpdate` 里 toggle `app-visibility-panel-open` / `app-fill-settings-open`。
- ⛔ **为什么不能 imperative add/remove**：`onResetParameters` 走 `...initialState` 整体覆盖，**绕过** close 方法 ⇒ 若在 close 里 `classList.remove`，复位后 body 类悬空 ⇒ 「浮窗期隐藏 number」永久生效（数字再也不显示）。reset 现值须保留 `showVisibilityPanel` / `isFillSettingsOpen` / `floatOrder`。
- ⛔ **同一 body 类只能有一个派生点**：`AdjustmentPanel` 曾有两条 effect 各自 `remove('visibility-panel-open')` ⇒ 关浮窗会误摘子面板所需的类（父面板数字冒到子面板上方）。已合并为单条派生 effect：`const anyOverlayOpen = showVisibilityPanel || showFuncHotkeyPanel`。

## 七、子面板互斥铁律

- 一个父面板可开**多个浮窗**，但**同时只能开一个子面板**。
- 唯一入口 `app.tsx::setSecondaryPanel(id: 'color'|'pattern'|'gradient'|'stroke'|'clear', open)`：**一次 `setState` 写全 5 个 boolean**（目标 true、其余 false）⇒ 开新的自动顶掉旧的。
- 所有入口（`toggleStrokeSetting` / `toggleColorSettings` / `openPatternPicker` / `openGradientPicker` / `toggleClearSetting` / `applyFillPanelHotkey`）**一律 delegate 到它**，禁止再各写各的 boolean。加新子面板时同步补该联合类型与 5 个 boolean 列表（唯一改动点）。

## 八、状态类约定

- ⛔ **自包含状态类：一个元素只挂一个类，基态盒模型写进共享选择器列表**。`.icon-button` / `-disabled` / `-latched` 共享盒模型块，各自只加差异声明；常亮态**不得**靠「同时挂基态 + 修饰类」实现（引入顺序依赖）。
- ⛔ **常亮态配色只定义一次**（`--latched-bg: rgb(38,128,235)` / `--latched-icon: rgb(255,255,255)`，基础 `:root`），各 `@media` 不重定义即继承。**不可复用 `--hover-icon`**（lightest 主题仅 2.9:1，不达标）。
- ⛔ **描边型图标的 `fill` 与 `stroke` 必须分两条状态规则**：合并成一条 `… .icon-fill, … .icon-stroke{fill:…}` 会让 (0,2,0) 的 `fill` 压过 `.icon-stroke{fill:none}`(0,1,0)，把开放路径填实心。
- ⚠️ 状态灯/辉光不要写死半透明浅色（浅底上发灰）⇒ 辉光改 `currentColor`，亮色主题把 `--notify-ok-fg` 调深。

## 九、灰度显示不得污染预览尺寸基准

- ⛔ 灰度态缩略图是**降采样**的（`PatternPicker.tsx` `GRAY_THUMB_MAX = 104`px）。其 `onLoad` **不得**无条件写 `previewNaturalRef`（只在非灰度时记）——否则最终预览 `refW/refH` 被钉成 104px、`fit = min(1, …)` 饱和为 1 ⇒ **「缩放」与预览右侧下拉「失灵」**。
- 灰度态最终预览要全尺寸：烘图 effect 触发条件含 `shouldShowGray`（角度 0 的灰度也要烘一张全尺寸灰度图）。
- 灰化**只影响显示**（模块级纯函数 `isGrayDisplayMode()` + `getDisplayColorHex()`，口径 0.299/0.587/0.114），stops 里仍存真实色；退出灰态自然恢复。**新增任何颜色预览点，先问「灰色态下它该不该灰」**。

## 十、UXP 三条「平台级不可能」——别再走第二次

- ⛔ **CSS transform 只实现 `scaleX/scaleY` + `translate` + `transform-origin`，没有 `rotate()`**：加在任何元素上的 `rotate()` 都被静默忽略。要倾斜只能**把旋转烘进像素**（本仓 `PatternPicker.tsx::rotatePatternPreview()` + `src/utils/pngEncode.ts`）。
- ⛔ **SVG 渲染器只服务「简单图标」**：`<svg><image href="data:…">` 不渲染（预览会整片空白）⇒ 按数据 URL 画图**一律用 `<img>`**。UXP 无 Canvas。
- ⛔ **`imaging.encodeImageData` 只支持 JPEG**（无 alpha）⇒ 需要透明只能**自己编码 PNG**（`src/utils/pngEncode.ts`：手写 IHDR/IDAT/IEND + CRC-32 + Adler-32，deflate 只发存储块 BTYPE=00，零依赖）。

## 十一、原生输入框的文字垂直位置：只能移动盒子

- UXP 的 `input` 是**原生视图**，文字绘制区**锚在控件盒上缘**、不按 `line-height` 做行盒居中，也**不随 padding 走**（`padding-top` 基本无效）。
- ✅ 正确杠杆 = **改 `input` 自身盒子高度**：`.num-input-row`(32px, `align-items:center`) 下，`height:24px → 20px` 让墨迹落回几何中心。**统一规律：盒高每减 2px，文字下移 1px**（同步改 `line-height` 保持一致）。
- ⛔ 不要用 `line-height` 调（原生控件忽略）；不要回到 `padding-top` 方案。

## 十二、用户文案 & 对外文档

### `src/constants/helpTexts.ts`（hover `title`）
- 读者 = **精通 PS 的画师**：羽化、不透明度、通道、蒙版、中间值、混合模式、alpha 一律不解释；只改「PS 范围之外的词」（邻域、连通块、直方图、归一化、颜色传播源、高频/低频…）。
- 语气 = **说明文不是教程**：禁「一句话：」「你可以」「不用自己试」这类教程腔与第二人称。
- 改法 = **手术式修订**：只动真有问题的条目，合格句子逐字保留；动笔前先读源码核实语义。
- ⚠️ `git checkout .` 会连 `.workbuddy/memory/` 一起回退。

### 对外《使用手册》`docs/*.html` + `README.md`
- 同一受众与口吻（有 PS 基础的画师）。README 只留用户向内容（简介 / 系统要求 / 安装 / 激活 / 快速开始 / 两块面板能力 / 全局快捷键 / 常见问题 / 许可），**不放「开发构建」等开发者段落**。
- 尺度：不给用户讲实现细节，也不抛看了没用的内部信息。已知需去掉：注册表键名与 `LowLevelHooksTimeout`、日志文件路径、内部依赖名（`imaging API`）、机制词（低层键盘钩子 / HID 管道 / ctfmon）、内部处理流程分步。「键盘卡死一键修复」只保留「症状 → 鼠标点一下即可 → 不需键盘输入 → 不删配置 → 修完回『笔刷热键』重启服务」。
- 两份手册的章节与 `<nav>` 导航、页内锚点必须一一对应；改完用脚本核对关键标签成对（`section/table/div/ul/ol/nav/main/figure/tr/th/td/h2-4/p/li/span`）。

## 十三、两处已校准的间距 / 配色共识

- **通知状态条语义**：开 = `notify-bar-ok`（绿）、关 = `notify-bar-disabled`（`--disabled-color` 描边 + 面板底色，**不用 warn 橙**，橙在插件语义里专指异常/待处理）。
- **紧凑描边行右列「色框槽」** `.stroke-color-slot`（宽 33px、`margin-left:4px`）：右列由 `.row-grid-fit` 的 `flex:1` 撑满、`.row-end` 把色框推到内容盒右缘 ⇒ **只剩「色框右缘与上一行开关右缘对齐」一条约束**。旧的「总宽 94px 与上一行严格相等」换算随「描边设置」文字按钮一起失效，**勿再采用**。槽宽是字面量（与 `.toggle-switch` 的 33px 成对），改开关宽度必须同步改；槽内 `.color-preview` 必须 `margin:0`（通用类自带 `margin:0 10px` 会撑宽）。
- **测量手法**：改版式前用像素脚本量用户截图（本仓截图恒 **1.5×**、内容盒 230px），不要目测估；用 headless 搭测量台**必须复刻完整祖先链**，少一层会让 `body.compact-*` scoped 规则静默失效（两模式测出同一组数据）。
- 浮窗内**已无 row-grid**（填充设置浮窗改成逐行 `.row-between` + 自绘 `ToggleSwitch`，开关无原生墨迹空档）⇒ 旧的 `.float-window > .panel-section > …row-grid` 那条补偿已删，勿再加回。

## 十四、CSS 编辑铁律（游离文本）

- ⛔⛔⛔ **注释块外的「游离文本」会被当成选择器，静默吃掉紧随其后的整条规则**。写中文注释时多打/挪动一个注释结束符 ⇒ 注释提前闭合 ⇒ 后面的文案跑到注释外 ⇒ 解析器把它当选择器 ⇒ `{ …声明… }` 成了那个垃圾选择器的声明块 ⇒ 规则永不命中。
  - 三条纪律：① 编辑中文注释**不要移动/重复注释结束符**，注释正文里禁止出现该结束符的字面两字符形式；② **改完机器校验** `node scripts/_css_comment_guard.cjs`（注释开/闭配对 + 注释外不得出现结束符）；③ **「反复改却毫无效果」立即停止调声明**，先验证**规则是否命中元素**（postcss 解析选择器 / headless 打印 `getComputedStyle`+`getBoundingClientRect`）。
  - ④ 修完**复查同区域注释里是否残留与新结论冲突的旧处方**——错误处方比没有注释更危险。

## 十五、UXP 渲染 / 布局坑清单（CSS 注释精简时补录）

| 写法 / 现象 | 结论与替代 |
| --- | --- |
| `background: transparent` | ⛔ 渲染成**纯黑**。要透明感用「具体色 + `opacity`」（`background-color: var(--border-color); opacity:.80`）。 |
| `border-radius: 999px` | ⛔ 未按「高度一半」解析 ⇒ 两端尖角纺锤、伪元素溢出鼓包。写**显式数值**（胶囊 16 高→8px；圆点 12→6px），并同时给 `-webkit-border-radius`。 |
| `text-decoration: underline` | ⛔ 不保证渲染 ⇒ 下划线一律用 `border-bottom` 画。 |
| 单边 border | ⛔⛔⛔ **宽度/样式是逐边的，颜色是整条共享的一个值。** 实证：`border-top: 0` 能让上边归零、另三边仍 1px ✓（宽度逐边成立），但那条声明缺 color ⇒ 共享色被刷成 currentColor=`rgb(0,0,0)`（三边变黑，2026-10-29 的 bug 就是它）。`border-<side>-color` 长属性静默无效；四条单边简写各带 color ⇒ 共享色被反复覆盖、四边同色。**「只画三条边」的正确姿势：先 `border: 1px solid var(--x)`，再 `border-<side>: 0` 归零不要的那条，最后补 `border-color: var(--x)` 把颜色刷回来**（顺序不能换；`border-color` 只写颜色、不撑回宽度）。 |
| `box-shadow` 多值 | ⛔ 整体不渲染：四条 `inset` 阴影写在一起，真机一条线都没画出来（单值可用）。 |
| 滚动条（槽 ≈16px） | ⚠️ 画在滚动容器的**内容盒内部**右侧（不像桌面浏览器贴在 padding 外侧）⇒ **滚动层不能有横向 padding / border**，否则槽永远到不了面板最右缘；同理滚动层要贯通整高，把标题段放外面就会缺顶部一段槽。 |
| `:nth-of-type` | ⛔ 统计的是**同标签名元素**在父节点里的序号，不是「第几个特定 class」⇒ 混合标签容器里绝不能用它数 class。改用相邻兄弟 / class 组合。 |
| flex 容器默认值 | ⚠️ 交叉轴隐式 `center`（不是 web 的 `stretch`）；方向未显式声明时可能退化成 `column` ⇒ `flex-direction` / `justify-content` / `align-items` **一律显式写**。 |
| 块级元素宽度 | ⚠️ **不被隐式拉伸**到父内容盒 ⇒ 凡要占满一行的容器显式 `width:100%` + `box-sizing:border-box`。 |
| flex 子项百分比 `max-height` | ⚠️ 解析不可靠（约束失效、按内容撑开 ⇒ 与内层滚动叠成「双滚动条」）⇒ 改走确定高度 `height:100%`。 |
| 运行时注入的 `var()` | ⚠️ style-loader **运行时**注入的规则里 `var()` 解析不稳定（曾「遮罩能拦点击但背景完全不绘制」）⇒ **底色 / 遮罩配色交给 `theme.ts` 与静态 `<link>` 侧**，运行时注入的 CSS 不写背景色。 |
| 外边距折叠 | ⚠️ **块容器（`.panel`）折叠取 max；flex 列容器（`.panel-section` / `.radio-vertical`）的子项不折叠**，会叠在容器自身外边距之外 ⇒ 算「行 ↔ divider」距离前先判容器类型。本仓多数算错的间距都栽在这一条。 |
| 原生 `<a>` | ⛔ 文字色由 UXP 强制接管（作者 `color` 被忽略、深主题下回退暗蓝）⇒ 可点链接改用 `<span>` + `onClick`（UXP 内 `<a href>` 本也不唤起浏览器，走 `shell.openExternal`）。 |

- ⚠️ **守卫脚本只扫 `src/styles/*.css`**：`src/adjustments/*.css`（绘画工具箱）**不在覆盖范围**，改完要手工核对注释开闭 / 括号配对（可用 `node -e` 数 `/*` 与 `*/`、`{` 与 `}`）。
- 自绘开关 `.toggle-switch`：可见胶囊 33×16、圆点 12px、占位盒高 24px（`:before` 撑起，**不用 margin/padding** 免得挤压同行）。**不要**再加负外边距（那是抵原生 `sp-switch` 32px 盒高的旧补偿）。
- 状态条 `.notify-bar` `min-height: 32px` = 自绘开关占位盒 24 + padding 6 + 边框 2（旧的 40px 按原生 sp-switch 32 算，会让含开关的条高一截）。

## 十六、由 MEMORY.md 下沉（2026-10-16）

- ⛔ flex 容器相邻子元素外边距**不合并** ⇒ 需显式 `> .row-between{margin:0}` + `+ .row-between{margin-top:10px}`。
- ⛔ **跨文件置灰必须两级类选择器**（style-loader 注入序）；`gap` / `:has()` / `rotate()` 不可靠；
  `transparent` 渲染成**纯黑**。
- ⛔ 多浮窗 = 单遮罩 + 一个 `.float-stack`；子面板互斥唯一入口 `setSecondaryPanel(id,open)` 一次写全 5 个 boolean。
- ⛔⛔ `theme.ts` 的 CSS 注释一律写在 `{ }` **外**（`style.textContent` 运行时注入，声明块内注释被当声明 ⇒ CssSyntaxError；
  guard 不扫它，靠人工）。

## 十七、自绘控件三件套改主色 + 平滑开关迁标题 + 混合模式下拉上翻（2026-10-23 用户五连要求）

**1. 滑块手柄 / radio 选中点 → `--primary-color`；手柄加投影、免描边（common.css）**
- `.range-slider-thumb`：`--control-handle-color` → `var(--primary-color)`，加 `box-shadow: 0 1px 3px rgba(0,0,0,.35)`
  （满量程时手柄压在蓝色填充上同色，没投影糊成一团）；本无 border，保持免描边。
- `.radio-option-checked .radio-option-dot`：删 `inset 0 0 0 2px var(--bg-color)`（视觉上的描边/隔离环），
  填色 `--radio-checked-color` → `var(--primary-color)`。
- ⛔ `--control-handle-color` / `--radio-checked-color` **令牌退役**（theme.ts 三处定义全删，注释留档）。

**2. 自绘开关两态配色（common.css + theme.ts 新令牌）**
- 关：手柄 `var(--control-handle-off-color)`（随主题变灰、与轨道灰 `--border-color@0.8` 反向档：
  darkest/dark `rgb(198)`、light `rgb(98)`、lightest `rgb(118)`）——用户明确要求**不再是白/黑**。
- 开：手柄 `var(--primary-color)`；轨道 `var(--switch-track-on-color)` = `rgba(38,128,235,.28)`
  （半透明蓝，notify-bar-ok 同款观感；:root 定义一次，四主题同值）。
- 禁用态仍是 `--disabled-color`；焦点环 `box-shadow` 不变。

**3. 套索平滑开关挪到折叠标题右侧 + 异常走 notify-bar（app.tsx）**
- 开关进 `.collapse-header`，右侧定位用 `.mask-sync-status-spacer` + `.collapse-header-control`（新增，只写 flex 不压缩）；
  **必须包 span `onClick stopPropagation`**——标题行整体是折叠热区，不拦拨开关会连带折叠分区（CSS 拦不了事件）。
- 内容区常驻状态条**删除**；改「仅 warn/fail 现身」的异常通知条，渲染在标题下方、折叠内容**之外**（折叠着也看得见）。
  判据收口 `smoothToneIsError(tone)`（模块级助手，JSX 与 componentDidUpdate 共用，勿写两遍）。
- 状态文案退进开关 `title`（`smoothEnabledSwitch + '\n当前状态：' + smoothStatusText()`）。
- ⚠️ 异常条显隐推动下方参数行 ⇒ componentDidUpdate 比对 `smoothErrBarVisible`（首帧 null 不补）触发
  `resyncNativeWidgets` 防原生数字残影。

**4. 混合模式下拉 `openUp` 上翻（Select.tsx 新 prop + app.tsx 启用）**
- 根因：该下拉下方就是不透明度/羽化 + 选区平滑参数行，向下展开连片盖住，且 popOverlay 遮挡逻辑
  会把被盖数字临时隐藏（用户实测「数字整排消失」）。
- ⛔⛔ **下面「实测高度校正」的做法已被同日晚间推翻（UXP 量到的是上一帧高度，会收敛到错误固定点），
  现行做法见文末「§18 下拉弹层确定性高度」。**
- ~~定位不靠估算高度：首帧估算占位，`useLayoutEffect` 按**实测高度**把底边校正到头部上沿 −2px~~
- ~~遮挡判定带同步改为「头部上沿往上实测高」的一条带~~
- ⚠️ 只给混合模式传 `openUp`（显式 prop，不做全局自动翻转——窗口空间判据在「面板 tall + 平滑区可见」场景不触发）。

---

## §18 下拉弹层「确定性高度」+ 开关投影 + 折叠分区首元素间距（2026-10-23 第四轮）

**1. `.select-pop` 上翻样式崩溃（用户截图：首项被裁半截 / 右侧 16px 滚动条 / 菜单离下拉框浮空 45px）**
- 机理（三个症状同一根因）：UXP 的 `height:auto` 按**未取整行盒**（12px 字 + 8px padding ≈ 21.4px/行）
  算总高，绘制按整像素落行 ⇒ 内容比盒高几像素 ⇒ `overflow-y:auto` 出原生滚动条 + 首行被裁；
  而「量实测高度再校正 top」拿到的 `getBoundingClientRect()` 是**上一帧**的值（151px，真实 116px），
  两次迭代读到同一个旧值就判「已稳定」⇒ top 停在按 151 算的位置 = 浮空 45px。
- 解法：**把不确定性从源头掐掉**，两侧都用同一组整数常量：
  - CSS：`.select-opt/-sel/-dis` 改 `height:22px` + `padding:0 8px` + `box-sizing:border-box`；
  - TS：`src/utils/popOverlay.ts` 新增 `POP_ROW_H=22 / POP_DIVIDER_H=5 / POP_CHROME_H=6 / POP_MAX_H=200`
    与 `popContentHeight(rows, dividers)`；`estimatePopRect` 改用它（原写死 28/8）。
  - `Select.tsx`：`reposition()` 直接用 `popContentHeight` 算 `top`；上翻时把高度**显式写进 inline style**
    （`height: pos.h`），内容装得下再写 `overflowY:hidden`；**删掉整段实测校正 useLayoutEffect**
    （含遮挡 run 里读弹层矩形的分支，判定带完全由 pos 推出）。
- ⚠️ 改 `.select-opt` 行高 / `.select-pop` padding / max-height ⇒ 必须同步改 popOverlay 常量。
- ⛔⛔ **同日第五轮：上翻本身被用户否掉，已改回向下展开（详见 §19）。** 下面 §18-1 的高度模型仍成立，
  但「上翻 + 夹底」的定位不再使用。

**2. 自绘开关：关闭态反差收敛 + 胶囊与手柄各加投影**
- `--control-handle-off-color` 四主题统一到 ≈2:1（原 darkest 4.30 / dark 2.62 / light 2.03 / lightest 3.83）：
  darkest 136、dark 176（**新增，原继承 :root 会掉到 1.2**）、light 112、lightest 138。
- ~~胶囊从 `:before` 伪元素改为**真实子元素** `.toggle-switch-track`……投影：胶囊 `0 1px 2px /0.35`、
  手柄 `0 1px 2px /0.45`~~
  ⛔⛔ **投影根本没渲染（用户回报"代码不生效"），同日已整体回退：删 box-shadow、胶囊还原 `:before`。
  颜色收敛（上一行）保留。详见 §19。**

**3. 折叠分区「标题 → 首元素」间距对齐（app.css，两个专属类）**
- `#app .smooth-mode-trio { margin-top:5px }`：非紧凑模式原为 10px（`.radio-trio-group` 无 margin），
  紧凑模式靠 `> :first-child{5px}` 是 15px ⇒ 补 5px 后两模式一致。
- `#app .selection-sharp-row { margin-top:5px }`：目标是「填充选项 → 纯色」的视觉间距。
  两区**盒间距都是 20px**，但行盒高不同（radio 行 23px vs `.row-between` 32px）⇒ 墨迹差 5px，
  故把锐度行 10px→5px 让墨迹对齐（**是「减小」，别按「盒间距算得一样」判成 no-op**）。
  ⚠️ 这是对「间距令牌取盒对齐、不取墨迹对齐」那条**一次性的破例**：用户点名要视觉一致，
  且用专属类隔离在单行上（没有把墨迹偏移写进 `.row-between` 通用值），图标/输入框尺寸改动
  只会影响这一行、不会静默漂移到别处。将来若 `.row-between` 行盒高度变了，这条要重算。
- `.smooth-params { margin-top:10px → 15px }`：radio ↔ 参数盒 +5px（紧凑/非紧凑同值）。

---

## §19 混合模式下拉开到天花板 + 开关投影回退（2026-10-23 第五轮）

**1. 上翻（`openUp`）被彻底否掉 —— 位置错乱的真因是「夹底」，不是算错**
- 用户截图现象：菜单顶到面板最上面、盖住主标题与主开关，底边反而越过了混合模式下拉框。
- 实测数据（252×444 截图逐像素扫）：下拉头部上沿 ≈210px；27 项菜单可见高度 = `POP_MAX_H` 200px
  ⇒ **头部上方根本装不下**。`top = max(r.top - 2 - h, 2)` 的兜底把 top 夹到 2 ⇒ 菜单顶到天花板，
  底边 = 2 + 200 = 202 反而向下溢出到头部所在行。
- 结论：上翻只在「头部上方空间 ≥ 菜单高度」时才成立；面板下半区一律控件密集，两头都不合算。
  ⇒ app.tsx 去掉 `openUp`，回到标准下展开。**`openUp` prop 保留但无调用点，注释里写明"别再用"。**
- 代价（用户已知并接受）：向下展开会盖住不透明度/羽化两行，popOverlay 遮挡逻辑照旧把它们临时隐藏
  （UXP 硬限制：可编辑控件无视 z-index 永远最上层，不隐藏就是数字浮在菜单上）。菜单关闭即还原。
- 顺带修正：`pos.h` 改为**始终** `min(contentH, POP_MAX_H)`（原来下翻用未封顶的 contentH ⇒ 判定带比
  真实菜单长，会多藏下方一个输入框）；渲染时 `height` 也**始终**写死（不再只在上翻写），否则
  UXP 会按小数行盒算 auto 高度、再画 16px 滚动条。遮挡矩形统一 `{top, top+h}`，`estimatePopRect`
  在 Select 里不再被调用（保留 export 作兜底工具）。

**2. 自绘开关投影：整块回退（用户："投影代码不生效，我不要了"）**
- 删 `box-shadow`（胶囊 0.35 / 手柄 0.45）**并从 DOM 撤掉 `.toggle-switch-track` 子元素**，
  胶囊选择器还原 `.toggle-switch:before` / `.toggle-switch-on:before`（真·整体回退，不留半套）。
- 保留：四主题 `--control-handle-off-color` 的 ≈2:1 收敛（那是上一轮的另一半需求）。
- ⛔ 记住：**UXP 下给开关加 box-shadow 不渲染**，别再试；`.toggle-switch:focus-visible` 的焦点环
  仍是唯一一条 box-shadow（那条能画 — 至少在键盘焦点态，未单独复核）。

---

## §20 笔刷热键开关上移到折叠标题（2026-10-23 第七轮）

**需求**：热键开关从分区内容的状态条挪到「笔刷热键」折叠标题右侧（省常态空间，与套索平滑同款），
热键无法运转时改由下方 notify bar 通知，且**这条提示不自动消失**。

**关键约束（决定实现方式）**：工具箱分区的折叠是**条件渲染**（折叠时内容不进 DOM，
见 AdjustmentPanel renderSection 注释：UXP 原生 input 无视 z-index，不能用 max-height 裁剪）
⇒ 开关若留在 BrushHotkeySection 里，一折叠就消失、点了也没人响应。而套索平滑在 APP 面板是
CSS 常驻折叠，所以那边可以直接搬。**结论：状态必须离开内容组件。**

**落地**：
- 新增 `src/hotkey/hotkeyArmStore.ts`：模块单例 store（connected / armed / busy / error）
  + `useHotkeyArm()`（`useSyncExternalStore`）+ `toggleHotkeyArm()`。连接保活、`onDaemonStatus`
  回放后主动 `requestHotkeyStatus`、落盘值兜底补读，全部集中在这里；BrushHotkeySection 不再
  自己订阅 onDaemonStatus/onHotkeyState（两处各存一份必然不同步）。
- 新增 `src/hotkey/HotkeyArmSwitch.tsx`：`HotkeyArmSwitch`（标题里那颗，checked 只吃 armed，
  ⛔ 不吃 connected —— 0x013D 老纪律）+ `HotkeyArmAlert`（warn 档告警条）。
- `AdjustmentPanel.renderSection`：标题行加 `.mask-sync-status-spacer` + `.collapse-header-control`
  包一层 span 并 stopPropagation（标题行整体是折叠热区，不拦会连带折叠）；
  **折叠态**在标题下方渲染 `BrushHotkeyArmAlert`（外面再包一层只做 `resyncNativeWidgets`，
  因为告警条出现/消失会推移下面所有分区，原生输入框不重绘会留残影）。
- `BrushHotkeySection`：删掉本地 busy/daemonConnected/hotkeyArmed 与 armHotkeys/disarmHotkeys，
  改读 store；状态条只剩「说话」，开关已被搬走；底部加「armError 常驻横幅」。
- **sticky 语义**：store.error 无计时器，只有「连接恢复」或「用户成功布防/撤防」才清；
  录制前的拦截提示（未连接 / 热键暂停）也改成 `showMessage(..., true)`。
- 文案同步：FuncHotkeyPanel 三处「请先到笔刷热键分区打开开关」改为「折叠标题右侧」。

⚠️ 已知小边界：`.collapse-header` 是 `draggable`（分区拖拽排序），从开关上按住拖也会起拖。
  没在开关上加 `preventDefault`（UXP 下可能吞掉 click，风险大于收益）。

---

## §21 笔刷热键标题行高 + 展开态告警条 + 旧状态条退役（2026-10-23 第八轮）

**1. 标题行里那颗开关仍把行高顶到 24px（`common.css`）**
- 上一轮只写了 `.collapse-header-control .toggle-switch { height:16px }`，实测工具箱「笔刷热键」
  标题仍比其它分区厚 ⇒ **行高由行内最高的 flex item 决定**，只要开关在某一处仍按 24px 出盒就白搭。
- 现在双保险：① `.collapse-header-control` 自身钉 `height:16px`（包裹盒不参与行高竞争，
  开关视觉本体 16px 不会溢出）；② `.toggle-switch` 加 `flex:0 0 auto`；
  ③ `HotkeyArmSwitch` 给 ToggleSwitch 传**内联** `style={{height:16}}`（内联是唯一不可能被抢先的一层）。
- ⛔ 别用调小 `.collapse-header` padding 的办法：label 行盒随字号变，字号一动就重新失配。

**2. 「热键无法运转」告警条折叠/展开都要显示（`BrushHotkeySection.tsx`）**
- 病根：展开态原来只在 `store.error` 有值时渲染，而「WS 断开但用户没点过开关」时 error 为空
  ⇒ 展开后什么都不显示；折叠态却按 `connected` 判，照样显示。
- 现在两处都用 `<HotkeyArmAlert />`（判据唯一：`!connected || error`），展开态放在
  **「已选中 N 条」那行的下一行**（用户指定）。工具箱折叠是条件渲染 ⇒ 同一时刻只有一处存在。

**3. 「功能开启 / 功能关闭 / 未连接」状态条退役**
- 位置：折叠标题下方、`选择笔刷` 下拉上方那条 `.notify-bar`。用户要求删除 —— 提示职责已由
  最下方常驻 notify bar 承担，开关也在标题右侧常显，重复。
- 连带：`busy` / `armError` 不再在 BrushHotkeySection 解构（避免未使用变量）；
  `daemonConnected` 仍留（录制按钮禁用态 + 底部 message 配色），`hotkeyArmed` 仍留（录制前拦截）。

---

## §22 间距四处 + 按钮文字垂直居中规范（2026-10-23 第九轮）

**1. 所有 `.notify-bar` 上方 +5px**（common.css 基类直接加 `margin-top:5px`）。
   影响面：笔刷热键展开态告警条、蒙版同步引擎条、特制笔刷状态条 —— 三处都是「上文 → 条」的关系，统一加没问题。

**2. 蒙版同步「引擎条 → 卡片容器」再 +5px**
   `.notify-bar + .border-panel-section { margin-top:5px }`（相邻兄弟选择器）。
   ⛔ 没加新类：相邻兄弟能精确只命中「紧挨着」的那处，中间夹了别的元素时自动失效。

**3. 特制笔刷面板（brush.css + common.css）**
- `.bs-tab` 文字偏上的根因：定了 `height:22px` 但**没有任何居中机制**（div 的文字从 content box 顶部排）。
  修：`display:flex + align-items:center + justify-content:center`。
  ⛔⛔ **规范：本仓所有按钮/胶囊类（`.action-button-N` / `.icon-button` / `.record-button` / `.bs-tab` …）
  必须 flex 居中，不许靠 line-height 或 padding 凑。新增按钮照此办理。**
- `.bs-tabs` 加 `border-bottom:1px solid var(--border-color)` = 分类行与画笔预设的分割线；
  `.bs-list` 上内边距 0 → 6px，否则首张卡片贴线。
- `.bs-foot > .notify-bar { margin-bottom:10px }`（原 8px）= 状态条下边缘 → 按钮行上边缘 10px。
  写在 brush.css 里作用域化，**不动 common.css 的 8px**（那是其它面板的既有节奏）。
  ⚠️ 中间若出现 `.bs-steps`，10px 落在状态条与步骤列表之间。

**4. 选项卡（2026-10-29，选区平滑三列）**
- 三列自绘 radio → 浏览器式选项卡：`app.css` 的 `#app .smooth-mode-trio` 段。
  未选中＝纯文字（无底无边）；选中＝`--entry-bg` 抬升 + 三边 1px 描边 + **无底边**，
  与下方参数盒（同底色）连通成一个轮廓，轮廓上唯一的直角＝选中项根部的凹角。
  无圆点、无主色胶囊、无顶部主色线（三条都被用户否掉）。
- ⛔⛔⛔ **构图口径（用户图）：组合体轮廓 = 选中格的上/左/右 + 相邻两格的下边缘 + 参数盒的左/下/右。**
  实现＝「宽度归零 + 补色」三连（见上表）：
  未选中格 `border:1px solid` → `border-top/left/right:0` → `border-color`（只剩底边＝盒顶边）；
  选中格 `border:1px solid` → `border-bottom:0` → `border-color`（上左右，**无底边**）；
  参数盒 `border:1px solid` → `border-top:0` → `border-color`（左下右，**无顶边**）。
  ⇒ 选中格底色直接接上盒身，凸字形缺口才是真的闭合。
  ⚠️ 底边归零 ⇒ 选中格内容区比邻居高 1px（文字约上移 0.5px），三格等分看不出，别加 padding 补偿。
- ⛔⛔ **「打通」不能靠层叠**：首版用「行 `margin-bottom:-1px` + `z-index:2` 盖住盒顶边」，
  真机证明 **UXP 里兄弟的 z-index 提不过后一个兄弟** ⇒ 盒顶边照样横穿选中项下方。
- ⛔⛔ **未选中格的三条边写 `--bg-color` 而不是 `border:none`**：为了盒模型对齐
  （否则选中项比邻居多 1px，文字基线错位）。隐形依赖底色恰为 `--bg-color`
  （`.collapse-section` 已是）。⛔ 不能写 `transparent`，UXP 渲染成黑。
- 高 26px（含 1px 边框）；等分用 `flex: 1 1 0`（与 common.css「勿改 flex:1 1 0」不冲突：
  那条针对 `space-between` + `flex-start` 的贴边版式，选项卡是「等分 + 居中」，成对改）。
- 参数盒圆角已改 `0 0 3px 3px`：顶边不可见，上角方圆看不出差别；但选中首/末格时
  盒子的左（右）描边要接上格子的竖边，圆角会内弯 3px 留缺口。
- ⚠️ **与 `.bs-tab`（笔刷分类：22px 胶囊、选中实心主色 `--primary-color`）是两套语言**。
  新做 tab 前先想清楚要哪套，别在同一面板里混。
