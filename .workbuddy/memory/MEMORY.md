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
- ⚠️ Edit 常「报成功但没落盘」（多点修改会静默丢大半）；且本仓**行尾不统一**（如 `blockAverageProcessor.ts` 是 CRLF，`.tsx` 是 LF）
  → 含换行的多行 old_string 在 CRLF 文件里必失配，跨行替换别用字符串匹配：改用 node 脚本按行数组 splice + 写回前逐行断言 + 打印 OK/FAIL，改完 grep 逐串复核。
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
- 分块平均/对比减弱（blockAverageProcessor.ts）：「分块」= **不连通选区各自成块**（非色块），普通模式各自求均值填平。
  对比减弱：`factor = (coeff/255)·(强度×0.07)·t/(1+t)`，`t = |亮度−块均值亮度| / max(σ_L,6)`；α 用同一 factor 但不乘 φ。
  **内置混合颜色带柔化（参数写死、不暴露 UI、无持久化）**：`φ = clamp(1 − (u−1.5τ)/4.5τ, 0, 1)`，只作用于 RGB。
- lineSmoothProcessor(SDF)：全局量不被选区截断，选区只定写回范围；跨选区邻居用 effAlpha(内=平滑结果/外=原值)。任一环截断→选区边缘透明环；binaryOpen 全范围+越界跳过。
- 梯度修改（gradientRelaxProcessor.ts）：写回**只影响原本 alpha>0 的像素**（通道循环统一 `if (hasAlpha && a0===0) continue`）；
  末尾反预乘 pass 对「a=0 或选区外」像素整像素还原原始字节（预乘→反预乘往返有 ±1 漂移，只在真正改过的像素上做）。
  负值 alpha 走 blurAlpha 邻域加权均值，a=0 被冻结 ⇒ 放缓只能**向内**摊，不回扩 alpha。
- alpha对齐（alphaAlignProcessor.ts v5）：**局部多尺度环带参照 + 参照场窗口共识 + 众对齐**。
  众对齐 = 选区内 alpha>0 直方图**众数**为基准，全部 alpha>0 像素对齐到它（天然无斑驳，"对齐彻底"的正解）。
  三条铁律：①平坦判据必须用**绝对数**（`nearCount ≥ HIGH_CLUSTER_MIN(4)`）——占比判据会被远处另一层高值带飞；
  ②**上对齐**必须加"本层邻域"护栏（`bandMax > a + BRIGHT_GAP` 的尺度直接跳过），**下对齐不能加**
  （它往低处找"周围水平"，环带逸出到更暗底色层正是"把交叉凸起拉回周围"的语义）；
  ③补判门槛 `REF_FILL_PROTECTED_DELTA = BRIGHT_GAP/2`，且补判对象仍须 `a ≥ MIN_ALPHA`（否则近透明边角被抬到主体水平、凭空放大轮廓）。
  旧的 `withBg`（保底下对齐）已整体删除，由众对齐取代；`processAlphaAlign` 现在只有 `(…, isBg, direction)` 五个参数。
- edge 模式参数=mode/edgeMedianRadius/lineSmoothStrength/lineSmoothRadius；toggles.preserveDetail 与 highFrequencyEnhancer.intensity 是别的功能同名物，勿误删。
- 消除锯齿（aliasSmoothProcessor.ts，原 `pencilAASmoothProcessor` 于 `1ac1e6d` 删除、本轮还原并推广到所有色块轮廓）：
  覆盖率重建 —— mask（alpha≥thr）→ box 模糊成渐变场 → 4×4 子采样得 cov → `aRecon = 本体不透明度 × profile(cov)`。
  **四条不变量（改动前先想清楚）**：①阈值自适应（选区内 alpha 直方图众数/2，取值必须只依赖胜出档的下边界，
  用档内均值会因过渡带像素漂移而破坏幂等）；②本体不透明度由 EDT 从「距轮廓 ≥2px」的种子传播（窄条 ≤5px 整段当种子），
  并**硬性封顶 `aRecon ≤ 本体`**、**循环里必须 `if (distOut2 >= 4) continue`**（这些种子自身若被改写，本体水平会逐次下漂）；
  ③内侧 `∈[thr, 原值]` 只削不抬、外侧 `∈(原值, thr-1]` 只补不削；④锚定 mask 内 ≥thr / 外 ≤thr-1 → 输出 mask 不变 = 严格幂等。
  「湿边」= 旧版把按不透明笔触标定的绝对表当不透明度用（外围被压到 127、细线保护关掉时内侧冲到 253）。
  旧版死代码已删：`bgAlpha` 稳定背景 EDT 与 `bgAlpha > 127` 色块保护判据恒不成立（bg 种子要求 mask==0 ⇒ alpha<thr），
  「背景不被侵蚀」由不变量③从根上保证。测试脚本 `outputs/alias_smooth_test.cjs` + `alias_compare_old_new.cjs`。

## 用户文案（src/constants/helpTexts.ts）
- **读者 = 精通 PS 的画师**：羽化、不透明度、通道、蒙版、中间值、混合模式、alpha **一律不解释**（解释了反而像外行）；
  要改的只有「PS 范围之外的词」：邻域、连通块、直方图、归一化、颜色传播源、高频/低频、事件驱动、全局键盘钩子。
- **语气 = 说明文，不是教程**：禁「一句话：」「解决什么问题：」「你可以」「不用自己试」这类教程腔与第二人称；
  补主语是补「插件 / 该值 / 选区」等语法主语，且**仅在易歧义处补**。大白话＝不用生僻词 ≠ 口语化。
- **改法 = 手术式修订**：只动真有问题的条目，合格句子逐字保留（曾因 117/117 全改被整体回退）；
  动笔前先读源码核实语义（如 `blockGradient` 实为"每块填单一颜色"，原文"质心+归一化映射"会让人理解错）。
- 验证：key 集合/顺序 vs `git show HEAD:` 比对 + node `ts.transpileModule` 实跑导出 + 术语黑名单 grep。
- ⚠️ `git checkout .` 会连 `.workbuddy/memory/` 一起回退。

- 消除锯齿（aliasSmoothProcessor.ts）：粗图形走 blur+F 表覆盖率重建；**细线（线宽 ≤4px = thinFlag d2≤4）走几何重建** ——
  游程→链→平台中心插值还原亚像素边界→刚性带宽（众数厚度）+上下边界均值定心→墨量守恒 ink·cov/Σcov。
  铁律①墨量跨距取几何区间 [⌊eT⌋,⌈eB⌉-1]（取 mask 游程会让肩部掉出 mask、墨量逐轮流失）；
  ②幂等闸门 = 「边缘是否已成亚像素过渡」：以**本行**游程内最大 alpha 为基准，窗口内出现 0.25~0.75 基准的像素的行过半即判
  已平滑（只认领不改写）。**不能用"窗口内有任何中间 alpha"**（PS 铅笔/笔刷在硬边上也留一圈极淡毛刺 → 真实笔触全被拦掉，
  细线"没有任何现象"）；也**不能用全链最大当基准**（压感渐变会被整段误判成已抗锯齿而跳过整条）；③主路径用
  thinScope(认领)+thinDone(去重) 避让，认领游程 ±2px，否则 3~4px 线外侧会被主路径补出 ~107 虚边。
  ⚠️ `estimateBodyLevel` 直方图必须**按墨量投票**（`hist[a>>3] += a`，不是 `++`）：细线毛刺像素比本体多（1px 线每行 ~2:1）
  → 按个数统计众数落到毛刺档 → thr 124→4、mask 吞掉整圈毛刺，细线彻底失效（这就是"没有任何现象"的直接原因）。
  ⚠️ `makePlateauInterp` 首/尾平台常被链边界截断，观测中心≠真实中心 → 按典型平台长度（内部平台中位数）重建中心，
  否则端部十几行亚像素位置偏最多半个平台长（1:40 实测 0.38px / 7% 行）；写出循环不写链外一行（否则凭空造虚边）；
  被 `aRecon ≤ a0` 截断丢掉的墨要转投到外侧肩部像素（cap = thr-1），否则每次点击峰值降 2~3 级（爬行）。
  旧「细线保护」开关已删除（它只跳过细线、什么也不做）。
## 守护进程
- C#/.NET8 daemon(native/HotkeyDaemon/Program.cs)：WH_KEYBOARD_LL 独立线程，钩子线程严禁阻塞 I/O，焦点闸门 IsPhotoshopForeground 否则放行。WS 127.0.0.1:18923。冻结三形态与 ps1 七步见技能 windows-keyboard-device-reset；改 ps1 后同步 dist/。shell.openPath 受 manifest 扩展名白名单管控。
