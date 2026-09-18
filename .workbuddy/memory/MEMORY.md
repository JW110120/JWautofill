# JWautofill 长期记忆

> UXP 坑清单（①–㉑）、组件类目录/尺寸公式、新面板模板在**项目技能** `.workbuddy/skills/uxp-frontend-spec/`
> （SKILL.md + references/ + assets/panel-template.tsx）。
> **改样式、调布局、新建面板前先加载它**。本文件只放「技能里没有」的铁律与算法/工具约定。

## 项目铁律
- 禁 HEX，一律 rgb()/rgba() 走 theme.ts 变量；遮罩不透明度 0.80 字面写。UXP 无 flex gap→一律 margin。数字输入 32×24、`.num-input-row` 圆角 3px。
- ⚠️ UXP 不支持 `:has()`：静默失效、构建与 DevTools 都不报错 →「按后代特征选中祖先」只能在 TSX 加显式类名（技能 ㉑）。
- 术语：APP 与 AdjustmentPanel 皆「父面板」；纯色/图案/渐变/描边=「子面板」(src/app.tsx 内 absolute)。
- ⚠️ 两块面板共用同一 `document.body` → body 状态类名按面板分（主面板 license-dialog-open/secondary-panel-open/app-visibility-panel-open；
  工具箱 visibility-panel-open/adjustment-lock-open）。**隐藏规则必须「属主类名 + 属主根节点」成对写**，否则出现代偿现象：
  只开主面板浮窗时数字浮在其上方、再开工具箱浮窗才消失（技能 ⑱）。
- ⚠️ menuItems id 插件级全局唯一：同名 → `entrypoints.setup()` 抛 "already exists"、**两块面板一起空白**。
  APP 增删项必须四处同步：`registerAppCallbacks` 类型+赋值、`handleAppFlyout` case、menuItems 数组、app.tsx 注册处（技能 ⑰）。
- ⚠️ UXP 无内置 `fs`/`os`（编译期正常、运行期才炸）；落盘只用 `localFileSystem`（URL 写 `file:/C:/…`），
  用户自选路径用 `getFileForSaving`（必须在 `executeAsModal` **之外**调）。技能 ⑲。
- ⚠️ Edit 常「报成功但没落盘」；本仓行尾不统一（blockAverageProcessor.ts CRLF、.tsx LF）→ 跨行替换别用字符串匹配，
  改用 node 脚本按行 splice + 写回前逐行断言 + 改完 grep 复核。
- ⚠️ `.git/refs/remotes/origin/` 曾缺失 → fetch 假成功、status 恒 ahead；修法 mkdir 后 git update-ref。
  推送用 `git -c credential.helper=wincred push`。dist/、analysis/、outputs/ 已 gitignore。
- 前端改完须 UDT Reload；daemon 重编 SDK 8.0.424 在 `C:\Users\Administrator\.dotnet-sdk`（永不删）。
- 构建 `node node_modules/webpack/bin/webpack.js --mode=production`；tsc 全量约 220 条既有报错（多为 `Cannot find module 'photoshop'`），验收只看改动文件是否新增。

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

## UXP / PS 接口层
- 当前工具检测：不能只靠 select 通知（切笔刷预设是 `{_ref:'brush'}`、动作回放也不广播）→ 读 `application.tool._enum`
  （HotkeyBridge.getSelectedBrushToolEnum）+ 300ms 轮询 + `/brush|eraser|stamp|smudge/`；混合器画笔内部名有 mixerBrushTool/wetBrushTool。
- `imaging.getPixels` 把 sourceBounds 裁到层 bounds 再重采样 → 先取 layer.bounds、只请求「需要区∩bounds」，
  source 与 targetSize 严格 1:1，解析用 imageData.width/height 并守 raw.length。
- 历史压缩：batchPlay+putPixels 包 `doc.suspendHistory`；内部已有则 `{skipHistorySuspend:true}`。`storage.formats` 只有 binary/utf8，
  `file.read({format:undefined})` 静默乱码。弹窗用 `core.showAlert`（`dialogs.alert` 只进控制台）。
- PS 通知在命令中途派发 → 收到 make/delete/set 立刻 get 会撞忙碌窗口 → 事件探测走 `psProbe.debouncePsProbe(200ms)`。

## 样式单一来源（common.css）
- index.tsx 顺序 uxpPerfPatch→common→app→license；严禁 @import。状态样式统一放底部「集中管理区」；选中/落点一律 border 变色，禁 outline。
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

## 像素算法
- 分块平均/对比减弱（blockAverageProcessor.ts）：「分块」= **不连通选区各自成块**，普通模式各自求均值填平。
  对比减弱 `factor=(coeff/255)·(强度×0.07)·t/(1+t)`，`t=|亮度−块均值亮度|/max(σ_L,6)`；α 用同一 factor 但不乘 φ。
  **内置混合颜色带柔化（写死、不暴露 UI、无持久化）** `φ = clamp(1−(u−1.5τ)/4.5τ, 0, 1)`，只作用于 RGB。
- 梯度修改（gradientRelaxProcessor.ts）：写回只影响原本 alpha>0 的像素；末尾反预乘 pass 对「a=0 或选区外」整像素还原原始字节
  （预乘往返有 ±1 漂移）。负值 alpha 走 blurAlpha 邻域加权均值，a=0 冻结 ⇒ 放缓只能向内摊，不回扩 alpha。
- alpha对齐（alphaAlignProcessor.ts v5）：**局部多尺度环带参照 + 参照场窗口共识 + 众对齐**（选区内 alpha>0 直方图众数为基准）。
  ①平坦判据必须用绝对数（`nearCount ≥ HIGH_CLUSTER_MIN(4)`，占比判据会被远处另一层带飞）；
  ②**上对齐**必须加「本层邻域」护栏（`bandMax > a + BRIGHT_GAP` 的尺度跳过），**下对齐不能加**；
  ③补判门槛 `REF_FILL_PROTECTED_DELTA = BRIGHT_GAP/2`，补判对象仍须 `a ≥ MIN_ALPHA`。旧 `withBg` 已删。
- edge 模式参数 = mode/edgeMedianRadius/lineSmoothStrength/lineSmoothRadius；
  `toggles.preserveDetail` 与 `highFrequencyEnhancer.intensity` 是别的功能同名物，勿误删。
- 消除锯齿（aliasSmoothProcessor.ts）：覆盖率重建 mask(alpha≥thr)→box 模糊→4×4 子采样 cov→`aRecon = 本体不透明度 × profile(cov)`。
  **四条不变量**：①阈值取「选区内 alpha 直方图众数/2」且只依赖胜出档下边界；②本体不透明度由 EDT 从「距轮廓 ≥2px」的种子传播
  （窄条 ≤5px 整段当种子）、**硬性封顶 `aRecon ≤ 本体`**、**循环里必须 `if (distOut2 >= 4) continue`**；
  ③内侧只削不抬、外侧只补不削；④锚定 mask 内 ≥thr / 外 ≤thr-1 → 输出 mask 不变 = 严格幂等。
  细线（≤4px）走几何重建：游程→链→平台中心插值→刚性带宽（众数厚度）→墨量守恒 `ink·cov/Σcov`。
  铁律：墨量跨距取几何区间 `[⌊eT⌋,⌈eB⌉-1]`（取 mask 游程会让肩部掉出 mask、墨量逐轮流失）；幂等闸门 = 以本行游程内最大 alpha
  为基准、窗口内出现 0.25~0.75 基准像素的行过半即判已平滑（只认领不改写）；「有任何中间 alpha」会被硬边毛刺全拦掉，用全链最大则压感渐变整段误判；主路径用 thinScope+thinDone 避让、认领游程 ±2px。
  ⚠️ `estimateBodyLevel` 直方图必须**按墨量投票**（`hist[a>>3] += a` 而非 `++`；细线毛刺像素比本体多 → 按个数投票 thr 会落到毛刺档）。
  ⚠️ `makePlateauInterp` 首/尾平台常被链边界截断 → 按典型平台长度重建中心；写出循环不写链外一行；被 `aRecon ≤ a0` 截断丢的墨转投外侧肩部。
  脚本 outputs/alias_smooth_test.cjs + alias_compare_old_new.cjs。

## 「仅主线条」边缘平滑（lineSmoothProcessor.ts，已窗口化重构）
- 管线：A 开运算+SDF（双 Felzenszwalb 精确 EDT）→ A.5 原线 8 连通域（面积/小杂点）→ B 高斯（σ 几何 / σ·0.55 密度抛光）→
  中值归一 → C 多源 BFS 近旁源 + `cov = smoothstep(sdB/band)` → D 去孤立点 → E.5 分量覆盖率 → E 写回。
- **窗口化**：只算「选区包围盒 + halo」，`halo = max(8, 2·kr+8)`，`kr = ceil(3σ) ≤ 10`。
  1000² 选区在 4000² 文档：旧 16M 像素 → 1.1M；实测 4000² 文档 1000×1000 选区 17.1s → **478ms（35.8×）**，2000² 文档同选区 2966→465ms（6.4×），
  1000² 全图选区 724→369ms（2.0×），5000×4000 文档 +1500×1200 选区 845ms（本机多次取最优）。
  halo 依据：截断对选区影响按 `exp(-(halo-kr)²/2σ²)≈1e-7` 衰减；截断只会让距离变小、不会变大。
- ⚠️ **已知语义代价**：E.5「分量覆盖率」是连通域级统计量，窗口化后只能按窗口内可见碎片统计 → 跨边界连通域判定可能与旧版不同。
  实测（合成交叉细线稿）：全图选区 **0 差异**（逐字节一致）；1000² 0.01%；200² 0.28%；极小选区落在密集细线区最多 ~3%。
  **方向恒为「新保留、旧清除」**（偏保守、不误删）。试过「只统计选区内分量」（更差）与 halo=96（部分场景有效且 +28% 耗时）→ 维持现状。
- ⚠️ 重构期踩过并修掉：`nearSrc` 存局部索引 → 写回取色必须换算回全图坐标（否则 RGB 全 0）；
  中位数不能取整档（medBlur 差 0.019 → 系统性压暗 1 级）→ 现用「三级直方图细化到 1/65536」。
- 回归台架：outputs/lineSmooth_perf.cjs（`equiv` 逐像素对比/`perf` 计时含预热取最优）、lineSmooth_profile.cjs（逐阶段耗时）；旧实现备份 outputs/lineSmoothProcessor.orig.ts.bak。

## 用户文案（src/constants/helpTexts.ts）
- **读者 = 精通 PS 的画师**：羽化、不透明度、通道、蒙版、中间值、混合模式、alpha 一律不解释；
  只改「PS 范围之外的词」：邻域、连通块、直方图、归一化、颜色传播源、高频/低频、事件驱动、全局键盘钩子。
- **语气 = 说明文不是教程**：禁「一句话：」「解决什么问题：」「你可以」「不用自己试」这类教程腔与第二人称；补主语只补「插件/该值/选区」。
- **改法 = 手术式修订**：只动真有问题的条目，合格句子逐字保留（曾因 117/117 全改被整体回退）；动笔前先读源码核实语义。
- 验证：key 集合/顺序 vs `git show HEAD:` + node `ts.transpileModule` 实跑导出 + 术语黑名单 grep。
- ⚠️ `git checkout .` 会连 `.workbuddy/memory/` 一起回退。

## 守护进程
- C#/.NET8 daemon（native/HotkeyDaemon/Program.cs）：WH_KEYBOARD_LL 独立线程，钩子线程严禁阻塞 I/O，焦点闸门 IsPhotoshopForeground 否则放行。
  WS 127.0.0.1:18923。冻结三形态与 ps1 七步见技能 windows-keyboard-device-reset；改 ps1 后同步 dist/。`shell.openPath` 受 manifest 扩展名白名单管控。
