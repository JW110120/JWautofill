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
| 数字输入 | `.num-input-row` 32×24 + 描边；`input` 撑满；单位 `.num-unit` 在容器外、**定宽 16px**、`margin-left:4px` |
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

### 三列 radio（`.radio-trio`）

- 结构必须同构：`.panel-section > .radio-trio > sp-radio-group`。
- ⚠️ **防折行的关键不在 `flex-wrap`，在单项宽度**（宿主内部分配怎么都拦不住）：单项外框 ≈76px，3×76 > 内容盒 ⇒ 必折行。现口径是**从内容侧砍窄**：`sp-radio .label-2{width:22px; margin-right:0}` ⇒ 单项 ≈62px。
- 缩进走容器 `padding:0 10px`（**不用 `transform`**，它不参与布局、会算错可用宽）；紧凑填充那个是分区首元素，用 `.radio-trio-flush{margin:0 auto}` 归零纵向外边距（不要写 `body.compact-app … .radio-trio{margin:0}`，会连带命中描边子面板同名容器）。

### 定宽标签的汉字溢出

- ⚠️ `.label-N` 比汉字实际宽度**窄约 6.6px**（`20+(n-2)×13.3`），文字靠 `margin-right:10px` 遮溢出（日常视觉间隙其实只有 ~4px）。
- 凡「标签盒右缘要对齐容器右缘」的新布局（如三列 radio 末项贴右）**必须先补这 6px**（`.radio-trio sp-radio .label-2{width:26px}`），否则文字溢出压到滚动条上。

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

## 四、专注模式

- 条件：「自动关开关」+「自动切套索」同勾即成立（推导值，不存 state；共享 `utils/FocusModeBus.ts`）。
- 行为：主开关热键只开不关；圆点换星形 `FocusStarIcon(13×13)`；工具箱置顶记录文案「选区填充」。

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
- **紧凑描边行右列控件组** 总宽必须与上一行「清除模式 + 开关」**严格相等 = 94px**（= `.label-4`(47) + `margin-right`(10) + **4** + 尾控件(33)）。那 4px 来自**后代选择器** `.row-between .toggle-switch{margin-left:4px}`（`.row-start` 里的开关也命中）—— 槽内拿不到它，**必须手动补**，否则左缘错开。另：槽内 `.color-preview` 必须 `margin:0`（通用类自带 `margin:0 10px` 会撑宽）。
- **测量手法**：改版式前用像素脚本量用户截图（本仓截图恒 **1.5×**、内容盒 230px），不要目测估；用 headless 搭测量台**必须复刻完整祖先链**，少一层会让 `body.compact-*` scoped 规则静默失效（两模式测出同一组数据）。
- 浮窗内**已无 row-grid**（填充设置浮窗改成逐行 `.row-between` + 自绘 `ToggleSwitch`，开关无原生墨迹空档）⇒ 旧的 `.float-window > .panel-section > …row-grid` 那条补偿已删，勿再加回。

## 十四、CSS 编辑铁律（游离文本）

- ⛔⛔⛔ **注释块外的「游离文本」会被当成选择器，静默吃掉紧随其后的整条规则**。写中文注释时多打/挪动一个注释结束符 ⇒ 注释提前闭合 ⇒ 后面的文案跑到注释外 ⇒ 解析器把它当选择器 ⇒ `{ …声明… }` 成了那个垃圾选择器的声明块 ⇒ 规则永不命中。
  - 三条纪律：① 编辑中文注释**不要移动/重复注释结束符**，注释正文里禁止出现该结束符的字面两字符形式；② **改完机器校验** `node scripts/_css_comment_guard.cjs`（注释开/闭配对 + 注释外不得出现结束符）；③ **「反复改却毫无效果」立即停止调声明**，先验证**规则是否命中元素**（postcss 解析选择器 / headless 打印 `getComputedStyle`+`getBoundingClientRect`）。
  - ④ 修完**复查同区域注释里是否残留与新结论冲突的旧处方**——错误处方比没有注释更危险。
