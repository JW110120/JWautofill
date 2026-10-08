# JWautofill 长期记忆

> 展开页（**细节一律下沉到 refs，勿在本文堆实测数据**）：
> - `refs/frontend-css.md` —— CSS 铁律细则、紧凑/专注模式、折叠分区纵向节奏、common.css 单一来源、helpTexts 文案规范
> - `refs/uxp-api-layer.md` —— UXP/PS 接口层实测行为 + 性能/React 铁律细则（同步 IPC、忙碌闸门、缓存、memo、TDZ）
> - `refs/toolchain-and-env.md` —— 构建/类型检查/菜单/文件 IO/守护进程
> - `refs/pixel-algorithms.md` —— 像素处理器算法详述 + 实测数据
>
> UXP 坑清单（①–㉕）、组件类目录/尺寸公式、新面板模板在**项目技能** `.workbuddy/skills/uxp-frontend-spec/`。
> **改样式/布局/新建面板前先加载技能；改像素处理器前先读 refs。**

## 铁律速查（详述见 refs）

### 填充 / 描边（2026-10-08 新增）
- ⛔ **填充路径会「提前消费选区」**：`PatternFill` / `GradientFill` / `ClearHandler` / `SingleChannelHandler`
  写回像素时用 `imaging.putSelection` 覆盖选区，且**仅在 `state.deselectAfterFill === false` 时才还原**。
  该开关默认 `true` ⇒ 填充返回后选区已空，紧随的 `strokeSelection` 无从下手（= 描边「失效」）。
  ⇒ **只要 `needsStroke`，就必须给填充处理器传 `{...this.state, deselectAfterFill:false}`**（填充保留选区，
  描边后再由 app 层统一 `deselectSelection()` 兑现用户的「自动删选区」）。
- ⛔⛔ **描边 API 形状以「监听到的调用」为准，不得凭外部检索推翻**：PS **自身**下发的 `stroke`
  描述符 = **裸数字 `width`** + `location._enum: "strokeLength"`（Alchemist 监听截图，PS 27.8.0 r13 /
  UXP 9.3.0；图存 `.workbuddy/clipboard-images/`）。**现场证据（用户截图/监听）永远优先于 web 检索。**
- ⛔ **`StrokeSelection.ts` 全部九处 `location._enum` 一律 `strokeLength`**（2026-10-08 用户拍板；
  原先 5 处 `strokeLocation` 属历史遗留，已统一；之后新增分支也必须跟上）。
  ⚠️ `width` **有意保留两种写法**：**通道上下文**四支（快速蒙版 3/4 + 单通道 7/8）为裸数字（同监听），
  其余五支（1/2/5/6/9）`{pixelsUnit}` —— **未经授权不要动 `width`**。核对台 ① 组为**逐分支快照**，不要求同形。
- ⛔⛔ **`clearEnum`（清除混合模式）在不透明目标上不可用** —— Adobe 文档原文：
  「The Clear blending mode will be unavailable for a **background layer**, or if
  **preserve transparency** is enabled on the target layer」。
  PS 遇到不可用的 `clearEnum` **不抛错**：弹出原生「描边」对话框，然后按**普通填充**把描边画成描边色
  （用户实测：背景图层 12 组合里 3 种「填充 + 描边 + 清除」失效）。
  ⇒ 目标 `isBackground || hasTransparencyLocked` 时走**分支 9 `strokeSelectionOnOpaqueLayer`**：
  混合模式固定 `blendSubtraction`（减去），减去量 = 描边色灰度 × 不透明度
  ⇒ 「以该描边的灰度删除描边内部的内容」，且全程静默。
  同源三处（快速蒙版 4 / 单通道 8 / 不透明目标 9）**都不用 `clearEnum`**；
  普通像素图层**仍必须**用 `clearEnum`（核对台 ⑮ 有回归护栏，别一刀切）。
- ⛔ **单通道（红/绿/蓝/自建 Alpha）描边必须走专用分支 7/8，不得落到「像素图层」兜底**：
  · 分支 7（仅描边）**不 `make layer`、不合并** —— 新建图层会把活动通道切回 RGB 复合通道
    （= 用户实测「单通道填充+描边后跳回 RGB」）；末尾用 `readActiveChannelName` / `reselectChannel` 还原通道
    （红→`red`、绿→`grain`、蓝→`blue`，自建 Alpha 走 `_name`）。
  · 分支 8（描边+清除）混合模式**固定 `blendSubtraction`（减去）**，同快速蒙版描边删除；
    `clearEnum` 在无透明度的通道上下文里 PS 不接受 ⇒ 弹原生描边框 + 按面板色**直接填充**（用户实测第 2 类失效）。
  · 分发顺序：单通道判定必须在「像素图层」兜底**之前**（核对台 ⑧ 盯这条）。
- ⚠️ 「新建图层」开关的禁用条件走 `app.isCreateNewLayerDisabled()`（**唯一事实来源**，紧凑/普通两套版式共用）：
  清除模式 / 快速蒙版 / **图层蒙版** / **单通道编辑**。新增禁用条件只改这一处，杜绝两处漂移。
  ⚠️ `isInLayerMask` / `isInSingleColorChannel` **必须在 state**（渲染读 state 才会刷新；只写实例字段 = `isInQuickMask` 那次历史 bug），
  且 `checkMaskModes` 与选区事件两处都要回写。
- ⛔ **描边色对象的 `_obj` 必须是 `RGBColor`**：`RGBColorClass` 是**无效类名**
  （2025-07 起只在「快速蒙版 · 描边+清除」一支误用）⇒ PS 忽略该色 ⇒ 换任何描边色结果都一样。
- ⛔ **PS 原生拾色器 `showColorPicker` 无参、只认「当前前景色」为初始值** ⇒ **禁止裸调**！
  一律走 `src/utils/ColorPicker.ts` 的 `pickColorWithInitial(initial, name)`：
  记真前景色 → 注入 `initial` → 打开 → 读回 → **finally 还原**（不还原就会改掉用户前景色）。
  面板「显示色 ↔ 拾色器初值」必须**同源**（描边色板：`getStrokeDisplayColor()` 是唯一事实来源）。
  ⚠️ 返回值绿色分量 `grain` / `green` **两键都认** + `Number.isFinite` + 0–255 clamp：
  只认一个时拿到 `undefined` ⇒ `Math.round(undefined)=NaN` ⇒ `rgb(r, NaN, b)` **非法颜色串**
  ⇒ 色板没有背景色、透出面板底色（看着像一块 `#333333`，而非纯黑）。
- ⛔⛔ **图层蒙版识别：`doc.activeChannels` 在图层蒙版激活时会「抛异常」**
  （`Unknown or unsupported active channels`，PS 官方论坛 + UXP 文档均确认）⇒ 必须用**独立**
  try/catch 吞掉后**继续**探测。9a909c0 把两处探测合并成 `probeChannelState` 时丢掉了内层 catch，
  异常逃逸到外层 ⇒ `isInLayerMask` **恒为 false** ⇒ 图层蒙版 12 组合里 **11 组**失效
  （图案/渐变填到新建的 RGB 图层；「仅描边」描在新建的 RGB 图层；清除/描边落像素分支并弹原生框）。
  ⛔ **合并「可能抛异常的多步探测」时，每一步的 catch 必须原样保留**（回归高发点）。
  核对台 ⑪ 组用**变异测试**盯这条（去掉内层 catch ⇒ 断言必须退化为 `false`）。
- ⛔ **静默化只能写在 batchPlay 的 options 层**：`fill` / `stroke` 在 `clearEnum` 这类参数下
  **忽略描述符内的 `_options`** ⇒ 弹原生「填充」「描边」框（用户截图）。9 个填充/清除/描边相关文件的
  **每个** batchPlay options 都已补 `dialogOptions: 'dontDisplayDialogs'`（核对台 ⑫ 组全仓扫这条）。
  ⚠️ 只补 `dialogOptions` 这一项、别动描述符与数组（脚本改多行对象时曾把一处改坏 ⇒ 改完必须 tsc + 逐行 diff 校验）。
- ⚠️ 图层蒙版是与单通道同级的「通道上下文」：`isInLayerMask` 必须**进 state** 且并入
  `isCreateNewLayerDisabled()`；`fillSelection` 的 `make layer` 分支也必须排除图层蒙版
  （新建图层会把活动目标从蒙版切走 ⇒ 填充落到新图层而不是蒙版）。
- ⚠️ 「灰色显示态」四标志（清除模式 / 图层蒙版 / 快速蒙版 / 单通道）在 GradientPicker 里统一走
  `isGrayDisplayMode()` + `getDisplayColorHex()`（**模块级纯函数**）：色板与渐变预览条口径必须一致
  （0.299/0.587/0.114）；灰化**只影响显示**，stops 里仍存原色，退出灰色态自然恢复。
  ⛔ **灰色态必须覆盖「所有颜色显示点」**：面板里凡是把颜色当背景色画出来的地方都要走
  `getDisplayColorHex(..., grayDisplay)` —— 上一轮只改了「颜色」行 `.color-preview`，漏了渐变
  **轨道上那排方形色标**（`.color-slider-thumb`）⇒ 预览条已灰、色标仍是彩色（2026-10-08 用户指出）。
  新增任何颜色预览点时，一律先问「灰色态下它该不该灰」。
- ⚠️ **同轴控件步长必须一致**：羽化滑杆 `step` 与 number-input `step` 同为 **1**
  （滑杆 0.5 会写 `X.5`，而 `.num-input-row` 定宽 34px 显示不全 ⇒ 只显出「1…」）。
- ⚠️ 隐藏的一条同源路径：像素图层「图案/渐变 + 清除」走 `ClearHandler.applySelectionAndDelete`，
  它前面的 `putSelection` 会把选区**改写成待删除掩码**（`getSelectionData()` 内部还先取消一次）
  ⇒ 必须同样按 `deselectAfterFill === false` 还原原选区，否则描边沿掩码走。
  ⚠️ `ClearHandler.ts` 是 **CRLF** 文件，Edit 工具多行匹配会失败 ⇒ 用脚本 LF 归一化后按锚点替换再写回 CRLF。
  核对台：`outputs/stroke_mode_matrix_verify.cjs`（**184 项**；**从真实源码切出编排片段执行，不复刻逻辑**）。
- ⛔ **「控件不可用」时不要整行隐藏，改「标签 + 控件」双禁用态**（用户明确要求）：
  `StrokeSetting` 的混合模式原为 `{!clearMode && (...)}`（清除模式下整行消失），现改为**始终渲染**，
  清除模式时标签挂 `label-disabled`、`Select` 传 `disabled={clearMode}` —— 与主面板
  `.app-blendmode-container` 的处理完全一致（那边早就是 `disabled={this.state.clearMode}`）。
  ⚠️ `.label-4`（common.css ~140 行）与 `.label-disabled`（common.css ~1839 行）**同为 (0,1,0)**，
  靠**同文件内后置规则**取胜 ⇒ 写成 `className="label-4 label-disabled"` 即可；
  但**跨文件**（app.css 的类 vs common.css 的 `.label-disabled`）就必须用两级类（见 CSS 段）。

### CSS / 样式
- ⛔⛔⛔ CSS 注释块外的**游离文本**会被当成选择器、静默吃掉紧随其后的整条规则
  ⇒ ① 编辑中文注释不移动/重复注释结束符，注释正文禁出现其字面两字符形式；
  ② 改完 CSS 必须机器校验注释开/闭配对；③ **「反复改却毫无效果」立即停手，先验证规则是否命中元素**。
  ✅ 机器校验：`node outputs/css_comment_check.cjs`（扫 `src/styles/*.css`，报未闭合 + 注释体内开启符）。
- ⛔ **「标签随控件同步置灰」必须用两级类**（如 `.app-blendmode-label.label-disabled`）：
  `common.css` 是 `index.html` 里的**静态 `<link>`**，而 `app.css` 由 style-loader **运行时后注入**
  ⇒ 两者同为 (0,1,0) 单类时，**app.css 自带的 `color` 会盖掉 `.label-disabled`**，
  标签看着根本没禁用（2026-10-08 用户实测「混合模式下拉禁用但标签不变灰」）。
  同源写法参照 `.select-wrap .select-value`；**别改结构**（改 TSX 加 `.disabled` 类与惯例不符）。
- ⚠️ UXP 不支持 `:has()`（静默失效、不报错）；UXP flex 容器隐式 `center`；间距统一用 margin+padding（`gap` 不可靠）。
- ⚠️ 原生 `sp-radio-group` / `sp-switch` 不可控 ⇒ 一律用自绘 `RadioGroup.tsx` / `ToggleSwitch`。
- ⚠️ 替换原生控件必须核对**调用方从事件对象取哪个属性**（`try/catch` 会把异常伪装成「点击无响应」）。
- ⚠️ 「元素没占满容器」要查**整条祖先链每层的 padding/border/margin（尤其两层叠加）**；
  「两组控件双向对齐」的唯一可靠做法 = **让两组总宽相等**（不是加 padding 去凑）。
- ⚠️ 折叠分区「标题→首行」间距 = 标题 `padding-bottom` + 首元素自身 `margin-top`
  （`.panel-section` 无 margin-top ⇒ 当首元素必少 10px）；**间距令牌取「盒对齐」不取「墨迹对齐」**。
- ⚠️ 改版式前用像素脚本量用户截图（本仓截图 1.5×、内容盒 230px）；headless 测量台必须复刻完整祖先链。
- ⚠️ 数字输入框与单位符号必须定宽（`.num-input-row` 34px / `.num-unit` 16px；更宽变体走显式类）。
- ⚠️ 颜色一律走 CSS 令牌（`--primary-color` / `--entry-bg` / `--border-color` / `--text-color` / `--hover-bg` /
  `--bg-color` / `--notify-*` / `--spectrum-global-color-*`），**禁硬编码 HEX**；对比度 ≥ WCAG 4.5:1；三档主题 darkest/dark/light。

### 性能 / React
- ⛔⛔ UXP 交互延迟的主因是**串行同步 IPC 往返**，不是像素计算
  （每次 `app.activeDocument` / `layer.bounds` 属性读 = 一次往返；**batchPlay 数组整体只算一次**）。
- ⛔⛔⛔ **`isPsBusy()` 是全局共享闸门（9 处消费者）** ⇒ 全局窗口恒 300/1200ms、**永不为提速缩短**；
  填充提速只能走私有 `fillReadyRemain()`（不变量 `fillReadyRemain() ≤ psBusyRemain()`）。
- ⛔⛔ **禁止把多条「可能失败」的 get 合并进同一 batchPlay**（一条失败连带整批；宿主原生报错框绕过 JS try/catch）。
- ⚠️ PS 原生对话框只认 batchPlay 的 **options 层**，**不认描述符内 `_options`**
  ⇒ 填充/清除/描边相关文件（`StrokeSelection` / `ClearHandler` / `PatternFill` / `GradientFill` /
  `SingleChannelHandler` / `SelectionHandler` / `MaskSyncEngine` / `ColorPicker` / `app.tsx`）的
  **每个** batchPlay 都要写 `dialogOptions: 'dontDisplayDialogs'`（核对台 ⑫ 组全仓扫）。
- ⚠️ 改 `LayerInfo` 禁止为某个 kind 特例跳过读取（省 IPC 只能靠「读一次复用」）。
- ⚠️ 图层树只读一份快照（`getLayerSnapshot`）；**通知回调内零 IPC**（只允许 `invalidateLayerSnapshot()`）。
- ⚠️ `getActiveLayerInfo` 有 300ms TTL 缓存（key = 活动图层 id；**纯选区 set 刻意不失效**）。
- ⚠️ 大列表 `options` 必须 `useMemo` + 组件 `React.memo`（**永远不要在 JSX 里现 map**）；
  面板是「单组件 + 一个 return」⇒ 折叠代价按 O(分区数 × 控件数) 估。
- ⛔⛔ 组件内 `useMemo`/JSX 调用**组件体内更下方**声明的 `const` ⇒ 白屏
  （es5 下 `const`→`var` 提升，报 `is not a function`；编译/webpack 都查不出）⇒ **纯函数一律放模块级**。
- ⚠️ `ts-loader transpileOnly:true` ⇒ 类型缺陷永不阻塞构建 ⇒ **新增跨组件共享字段必须同步补 `types/state.ts` 接口**。
- ⚠️ 父面板复位要覆盖子面板内部 state ⇒ 用 `resetToken` 自增（写在 `...initialState` **之后**）；
  复位前先清「选中预设」，**不动 presets/patterns 列表**。
- ⚠️ 启动期一次性 PS 加载必须走 `runWhenIdle`（一次性加载传**有限** `maxDeferrals`）；
  通知回调内禁任何同步 DOM 读取（原生弹框绕过 try/catch，唯一防护是「不发 get」）。

### 环境 / 工具链
- 见 `refs/toolchain-and-env.md`（构建命令、tsc 校验、菜单项「只置灰不删」、UXP 无 `fs`、Edit 假成功、守护进程）。

## 像素算法（细则、推导与实测数据一律见 `refs/pixel-algorithms.md`）
- 写回型处理器两条边界铁律：区域判定**只用选区掩码>0**；采样到「RGBA 全 0」的数据缺失点必须**用中心像素边缘延拓**。
- alpha 对齐 `alphaAlignProcessor.ts` 现为 **v10 三档整片归一**（v1~v9 五条路线已全部推倒，**勿重走**）；
  唯一例外：v5「多尺度环带参照」以「极值微调」按钮复活（线条污渍专用）。
- 消除锯齿 `aliasSmoothProcessor.ts`：覆盖率重建 + EDT 本体传播 + 墨量守恒；细线 ≤4px 走几何重建。
- 「仅主线条」`lineSmoothProcessor.ts` 现为 **V7 中轴重建**；加新参数必须同步 **10 处**（清单见 refs）。
- ⚠️ 构建不做类型检查 ⇒ 像素算法的参数/转发缺陷只会**静默失效**（改完必须端到端跑一遍台架）。
- 台架均在 `analysis/line_vis/`（⚠️ `accept_v7.mjs` 产出路径相对 CWD ⇒ **必须从仓库根运行**）；
  改完必须同时报「回归 diff vs 旧版」与「作用量 vs 原图」。
