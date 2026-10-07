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

## 用户文案（src/constants/helpTexts.ts）
- **读者 = 精通 PS 的画师**：羽化、不透明度、通道、蒙版、中间值、混合模式、alpha 一律不解释；
  只改「PS 范围之外的词」：邻域、连通块、直方图、归一化、颜色传播源、高频/低频、事件驱动、全局键盘钩子。
- **语气 = 说明文不是教程**：禁「一句话：」「解决什么问题：」「你可以」「不用自己试」这类教程腔与第二人称；补主语只补「插件/该值/选区」。
- **改法 = 手术式修订**：只动真有问题的条目，合格句子逐字保留（曾因 117/117 全改被整体回退）；动笔前先读源码核实语义。
- 验证：key 集合/顺序 vs `git show HEAD:` + node `ts.transpileModule` 实跑导出 + 术语黑名单 grep。
- ⚠️ `git checkout .` 会连 `.workbuddy/memory/` 一起回退。
