# JWautofill 长期记忆

> UXP 坑清单（现象→根因→解法，①–㉑）、组件类目录 / 尺寸公式、新面板模板都在**项目技能**
> `.workbuddy/skills/uxp-frontend-spec/`（SKILL.md + references/uxp-pitfalls.md + references/component-catalog.md + assets/panel-template.tsx）。
> **改样式、调布局、新建面板前先加载它**。本文件只放「技能里没有」的项目铁律与算法/工具约定。

## 项目铁律（高频踩）
- 禁 HEX，一律 rgb()/rgba() 走 theme.ts 变量；遮罩不透明度 0.80 字面写。UXP 无 flex gap→一律 margin。数字输入 32×24、`.num-input-row` 圆角 3px。
- ⚠️ **UXP 的 CSS 引擎不支持 `:has()`**：写了不生效、且构建与 DevTools 都不报错（整条规则被丢弃）。
  「按后代特征选中祖先」的需求只能在 TSX 加显式类名（如工具箱行内滑块行的 `.slider-row`）。详见技能 ㉑。
- 术语：APP(src/app.tsx) 与 AdjustmentPanel 皆「父面板」；纯色/图案/渐变/描边=「子面板」(APP 内 absolute)。
- ⚠️ 两块面板共用同一个 `document.body`（同一个 index.html）→ body 状态类名必须按面板分：
  主面板 `license-dialog-open` / `secondary-panel-open` / `app-visibility-panel-open`；
  工具箱 `visibility-panel-open` / `adjustment-lock-open`。开/关只动自己那一个，unmount 一并清理。
  **隐藏规则要「属主类名 + 属主根节点」成对写**（`body.app-visibility-panel-open #app input[type=number]`）；
  写成「工具箱的类名 × 主面板的作用域」会造成极有迷惑性的代偿现象 —— 只开主面板浮窗时数字浮在浮窗上方，
  再开一次工具箱浮窗才消失（详见技能 ⑱）。
- ⚠️ menuItems id 插件级全局唯一：同名 → `entrypoints.setup()` 抛 "already exists" 并中断，**两块面板一起空白**。
  APP 增删项必须**四处同步**：`registerAppCallbacks` 类型+赋值、`handleAppFlyout` 的 case、menuItems 数组、app.tsx 注册处（技能 ⑰）。
- ⚠️ UXP 无内置 `fs`/`os`（编译期正常、运行期才炸，`node_modules\fs.json doesn't exist`）；落盘只用 `localFileSystem`，
  URL 写 `file:/C:/…`；让用户自选路径用 `getFileForSaving`（必须在 `executeAsModal` **之外**调）。见技能 ⑲。
- ⚠️ Repo/Edit 偶发「报成功但没落盘」→ 每次编辑后用 grep / 脚本逐串复核。
- ⚠️ `.git/refs/remotes/origin/` 曾缺失 → fetch 假成功、status 恒 ahead；修法 mkdir 后 git update-ref。推送用 `git -c credential.helper=wincred push`。dist/、analysis/、outputs/ 已 gitignore。
- 前端改完须 **UDT Reload**；daemon 重编 SDK 8.0.424 在 `C:\Users\Administrator\.dotnet-sdk`（永不删）。

## 紧凑模式（5 个作用域各自独立：app / color / pattern / gradient / stroke）
- `AppState.compactModes`（PanelStateManager 持久化，参数复位保留）；旧的单个 compactMode 已废弃。
- 菜单项只作用「当前面板」(compactScopeOf)，文案 `紧凑模式：{面板名} - 开/关`。app.tsx：toggleCompactMode +
  syncCompactModeClasses（挂/摘 5 个 `body.compact-{scope}`）+ syncCompactMenuLabel（componentDidUpdate 里状态变或面板切换都要重写）。
- CSS：父面板 `body.compact-app #app .main-title/.panel-footer/.app-root>.panel>.panel-section .divider`；
  子面板靠根钩子 `.subpanel-*` 配 `body.compact-* … .divider`。`.subpanel-title-1` 不可隐藏；底部 info 条挂 `.panel-footer` 整块隐藏。
- ⚠️ 间距换算基准：**行盒 32px（sp-switch 与 sp-radio 都是 32px）**、标签盒 22px → 半个高度差 = 5px。
  · 藏 divider 后「清除模式→填充模式」补 `margin-top:15px`。
  · 紧凑填充选项**不渲染「填充模式」标签** → 分区首元素就是 32px 三列 radio，故 `.row-grid + .panel-section` = **10px**
    （与「行→行」同档，不再需要 +5 补偿）；相邻网格 `.row-grid + .row-grid` 也 = **10px**（与复选框组 5+5 同档；app.css 里那条紧凑规则同步为 10px）。
  · 子面板不适用（首元素是自带 10px 上边距的 .row-between），选择器必须收窄在主面板滚动区内。

## 专注模式
- 条件：「自动关开关」+「自动切套索」同勾即成立（推导值，不存 state）。共享 `utils/FocusModeBus.ts`（同 MainToggleBus 机制）。
- 行为：主开关热键「只开不关」；圆点换星形 FocusStarIcon(13×13)；工具箱置顶记录文案「选区填充」。

## UXP / PS 接口与算法层（技能里没有的）
- 当前工具检测：不能只靠 select 通知（切笔刷预设通知是 {_ref:'brush'}，动作回放也不广播）→ 读 `application.tool._enum`
  （HotkeyBridge.getSelectedBrushToolEnum）+ 300ms 轮询 + `/brush|eraser|stamp|smudge/` 判定；混合器画笔内部名有 mixerBrushTool / wetBrushTool。
- imaging.getPixels 把 sourceBounds 裁到层 bounds 再重采样 → 先取 layer.bounds、只请求「需要区∩bounds」，source 与 targetSize 严格 1:1，解析用 imageData.width/height 并守 raw.length。
- 历史压缩：batchPlay+putPixels 包 doc.suspendHistory；内部已有则 {skipHistorySuspend:true}。storage.formats 只有 binary/utf8（无 base64），
  file.read({format:undefined}) 会静默乱码。弹窗用 core.showAlert（dialogs.alert 在 PS 只进控制台）。
- PS 通知在命令中途派发 → 收到 make/delete/set 立刻 batchPlay get 会撞忙碌窗口；事件探测必须走 psProbe.debouncePsProbe(200ms)。

## 样式单一来源（common.css）
- index.tsx 顺序 uxpPerfPatch→common→app→license；严禁 @import。状态样式统一放底部「集中管理区」；选中/落点一律 border 变色，禁 outline。
- 通知：`.status-banner`(横幅) / `.notify-bar`(单行状态条) / `.notify-text`(唯一定义)；title 收口 helpTexts.ts。
  两态：开=notify-bar-ok(绿)、关=notify-bar-disabled(描边 --disabled-color + 底色 --bg-color，**不用 warn 橙**)。
  条内 `.notify-bar sp-switch{flex:none}`，右侧定位交 `.mask-sync-status-spacer`。
- 两列网格（唯一容器类，已取代 .checkbox-grid/.column-default/.fill-grid/.fill-cell）：
  `.row-between.row-grid`(**必须双类**) + `.grid-cell` + `.grid-cell + .grid-cell{margin-left:10px; align-items:flex-end}`
  （左列默认 stretch + 子行 `.row-start` 的 `justify-content:flex-start` = 贴左缘；右列 flex-end = 子行收成内容宽后贴右缘，
  左右各距面板外缘 10px。修「右列停在二等分中缝、整行左偏」。
  ⚠️ **必须用相邻兄弟选择器，不能用 `:last-child`**：单格网格（图案面板未勾「阵列」只剩「剪贴蒙版」）会同时命中
  `:first-child`+`:last-child`，源码顺序让 flex-end 胜出 → 唯一那列被推到最右缘）
  + `.row-grid + .row-grid{margin-top:10px}`；
  修饰档 `.row-grid-flush`（紧贴 divider 的复选框组，内层行 `margin:5px 0`）
  与 `.row-grid.row-grid-fit`（**必须双类**：两列 `flex:0 0 auto` + 整行 `justify-content:flex-start` + 列距 5px）。
  `.row-grid-fit` 必须**保留 `.row-grid` 类名**（纵向节奏靠 `.row-grid + .panel-section` 命中）。
  ⚠️ 紧凑描边模式行（`.row-grid-fit`）右侧「色板+齿轮」槽是条件渲染 → 关时空、开时 24px 撑行高。
  已用 `.row-end{margin-top:-2px;margin-bottom:-2px}` 让该槽不参与行高（行高恒 22px）。
- ⚠️ **`.label-N` 定宽比汉字实际宽度窄约 6.6px**（公式 `20+(n-2)×13.3`；n=2 实际 26px 只给 20px），
  文字靠 `margin-right:10px` 遮着溢出（视觉间隙实为 ~4px）。凡「标签盒右缘要对齐容器右缘」的新布局必须
  先补这 6px（例：`.radio-trio sp-radio .label-2{width:26px}`）。
- 三列 radio `.radio-trio`：间距写死会造成「阔时太散/窄时换行」，已改为容器级自适应 ——
  `sp-radio-group{justify-content:space-between;flex-wrap:nowrap}` + `sp-radio{flex:0 0 auto}`
  （首项贴左、末项贴右，滚动条 230↔220 自动重算）。缩进走容器 `padding:0 10px`（**不用 transform**，
  它不参与布局会被推出右缘）；两处 DOM 必须同构 `.panel-section > .radio-trio > sp-radio-group`；
  紧凑填充那个用 `.radio-trio-flush{margin:0 auto}` 归零纵向外边距
  （⚠️ 不能用 `body.compact-app … .radio-trio{margin:0}` 收口：会连带命中描边子面板的同名容器）。

## 像素算法
- lineSmoothProcessor(SDF)：全局量不被选区截断，选区只定写回范围；跨选区邻居用 effAlpha(内=平滑结果/外=原值)。任一环截断→选区边缘透明环；binaryOpen 全范围+越界跳过。
- edge 模式参数=mode/edgeMedianRadius/lineSmoothStrength/lineSmoothRadius；toggles.preserveDetail 与 highFrequencyEnhancer.intensity 是别的功能同名物，勿误删。

## 守护进程
- C#/.NET8 daemon(native/HotkeyDaemon/Program.cs)：WH_KEYBOARD_LL 独立线程，钩子线程严禁阻塞 I/O，焦点闸门 IsPhotoshopForeground 否则放行。WS 127.0.0.1:18923。冻结三形态与 ps1 七步见技能 windows-keyboard-device-reset；改 ps1 后同步 dist/。shell.openPath 受 manifest 扩展名白名单管控。
