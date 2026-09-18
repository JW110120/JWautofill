# 前端样式 / 模式详述（JWautofill）

> MEMORY.md 的展开页。改样式、布局、交互模式前先读本文件；UXP 通用坑（①–㉑）在项目技能 `uxp-frontend-spec`。

## 紧凑模式（5 个作用域独立：app/color/pattern/gradient/stroke）
- `AppState.compactModes`（PanelStateManager 持久化，参数复位保留）；旧单个 compactMode 已废弃。
- 菜单项只作用当前面板(compactScopeOf)，文案 `紧凑模式：{面板名} - 开/关`。app.tsx：toggleCompactMode +
  syncCompactModeClasses（挂/摘 5 个 `body.compact-{scope}`）+ syncCompactMenuLabel（状态变或面板切换都要重写）。
- CSS：父面板 `body.compact-app #app .main-title/.panel-footer/.app-root>.panel>.panel-section .divider`；
  子面板靠根钩子 `.subpanel-*` 配 `body.compact-* … .divider`。`.subpanel-title-1` 不可隐藏；底部 info 条挂 `.panel-footer` 整块隐藏。
- ⚠️ 间距基准：**行盒 32px**（sp-switch/sp-radio 都是）、标签盒 22px → 半差 5px。藏 divider 后「清除模式→填充模式」补 `margin-top:15px`；
  紧凑填充不渲染「填充模式」标签 → 分区首元素即 32px 三列 radio → `.row-grid + .panel-section` = **10px**，
  相邻 `.row-grid + .row-grid` 也 = 10px（app.css 同步）。子面板不适用，选择器收窄在主面板滚动区内。

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
  紧凑描边行右侧「色板+齿轮」槽条件渲染会撑行高 → `.row-end{margin-top:-2px;margin-bottom:-2px}` 让行高恒 22px。
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
