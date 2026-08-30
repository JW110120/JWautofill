# JWautofill 项目长期记忆

## 一、设计语言与设计规范

### 颜色表示法（硬性约定）
- **禁止 HEX，一律用 rgb()/rgba()**（2026-08-30 全量转换 src 下 .css/.ts/.tsx 完成）。新增颜色代码不得再写 #xxxxxx。
- 所有颜色走 theme.ts 主题变量，禁止硬编码：
  - `--bg-color` 面板背景；`--text-color` 文字（主题色，非固定蓝）；`--entry-bg` 行/卡片背景（深主题比 bg 浅、浅主题比 bg 深）；`--border-color`；`--disabled-color`；`--primary-color` 主色。
  - **下拉背景** `--dropdown-bg-color` 四主题固定值：darkest `rgb(32,32,32)` / dark `rgb(57,57,57)` / light `rgb(218,218,218)` / lightest `rgb(255,255,255)`。
  - **状态/文字通知** `--notify-{ok,fail,warn}-{fg,bg,border}`：深主题用亮色（ok `rgb(74,222,128)`/fail `rgb(255,107,107)`/warn `rgb(255,183,77)`），浅主题用深色（ok `rgb(21,128,61)`/fail `rgb(198,40,40)`/warn `rgb(180,83,9)`）。状态通知容器背景=`var(--bg-color)`。

### 下拉/选择器规范
- 统一用自绘组件 `src/components/Select.tsx`（BrushSelect 同款），CSS `.mask-sync-select-*` 定义在 `src/adjustments/adjustment.css`、全局可用。
- 主面板 4 个下拉（app.tsx 混合模式 / GradientPicker 渐变类型 / PatternPicker 缩放 / StrokeSetting 混合模式）已统一改用 Select。**不再用 `sp-picker`/`sp-menu`**（其展开菜单背景在 UXP 下无法用 CSS 覆盖）。
- **下拉弹层必须 `createPortal` 到「所在面板的根容器」（渲染在最上层）**：`.mask-sync-select-pop` 现为 `position:fixed; z-index:99998`（高于滑块 thumb 10000~10001 与标准 `input[type=number]`，低于模态遮罩 99999）+ `display:block` + `min-width:96px` + 显式 `font-family`（脱离面板后不再继承面板字体）。
  - **挂载点用 `src/utils/popRoot.ts` 的 `getPopRoot(from)`**：从下拉头部沿 `parentElement` 上溯找 `#app` / `#pixeladjustment`，兜底 `uxp-panel`，最后才 body。
  - **绝不能挂 `document.body`（血泪坑）**：index.html 里 body 下有两个 `<uxp-panel>`，**UXP 只渲染当前激活的那个 panel 子树**，挂到 body 的弹层落在所有 uxp-panel 之外、根本不绘制——表现为「所有下拉菜单都打不开」。挂到面板根容器既脱离面板内层叠上下文（仍能盖在最上层、不受 `overflow` 裁剪），又仍在被渲染的子树内。
  - **为什么必须 portal（硬性）**：面板容器 `.pattern-picker{z-index:9999;position:sticky}`、`.gradient-picker{z-index:10;position:sticky}` 都创建层叠上下文，弹层 z-index 再高也被困在上下文内，盖不住上下文之外的元素。
  - `Select.tsx` 与 `AdjustmentPanel.tsx` 的 `MaskSyncSelect` 两处实现必须保持一致。
- **下拉头部必须撑满 wrap**：`.mask-sync-select-wrap > .mask-sync-select-head{flex:1 1 auto;width:100%;min-width:0}`（adjustment.css）。因为面板里大量存在 `.xxx-setting-item div{display:flex}` 这类规则，会把 wrap 变成 flex 容器，head 作为 flex item 会退化到内容宽度（几十 px），导致下拉框异常窄、弹层（宽度=head 宽度）跟着变窄、选项文字换行看着像两列。

### 排版规范（通用布局）
- **一行两个「标签 + 控件(checkbox/switch/input)」统一用 `.field-row-two`**（定义在 `src/styles/styles.css`，全局类）：`.field-row-two > .field-cell`(flex:1 等宽，可多个) `> .field-cell-label`(标签容器) + `.field-cell-control`(控件小容器)。参考主面板底部 checkbox 区结构。**今后此类排版一律用此结构，禁止临时 inline 拼凑。**
- 下拉「标签 + 下拉同行、下拉自适应宽度、二者占满整行」参考边缘平滑「平滑模式」：容器 `flex-direction:row; align-items:center`；**标签取内容宽度 `flex:0 0 auto;white-space:nowrap`**（不要用 `flex:1 1 auto` 撑满，也不要给下拉设 px 上限——UXP 下会把下拉压窄到选项换行/横排），下拉（`.mask-sync-select-wrap`）`flex:1 1 auto; min-width:0` 自适应占满剩余整行。例：渐变「样式」下拉 `.gradient-type-setting`；其标签与下方「角度：」标签用同一条 `.gradient-setting-item > label` 规则，保证两行控件左端对齐。与「标签占满整行 + 下拉全宽」纵向堆叠是两套不同需求，按需选用。
- **一行两组 checkbox 的对齐**：整行用 `.field-row-two`，左组内容靠行左端、右组内容靠行右端——`.xxx.field-row-two > .field-cell:first-child{justify-content:flex-start}` + `> .field-cell:last-child:not(:only-child){justify-content:flex-end}`（`:not(:only-child)` 保证只有一组时仍左对齐）。例：图案面板平铺态 `.pattern-checkbox-container`。

### UI 约定（笔刷热键 & 蒙版同步）
- 主题色=`var(--text-color)`；图标按钮无边框无背景纯图标，hover 蓝；禁用态 `.disabled`→`color:var(--disabled-color)`+`cursor:not-allowed`+onClick 拦截；录制中红 `rgb(239,83,80)` 优先。
- 蒙版同步：`status-bar` 在容器外；卡片列表只裹 task+add-row；状态色 已连 `rgb(46,204,113)`/断开 `rgb(243,156,18)`。

### 架构/结构规范
- 入口 `src/index.tsx`：`#app`+`#pixeladjustment` 同文档同 bundle；`MenuManager.setup()`；蒙版同步引擎 `MaskSyncEngine.ts` 单例。
- 底部 checkbox 区（app.tsx）：4 项；`switchToLassoOnEnable`/`autoOffOnOtherTool` 持久化 `settings/panel-state.json`，默认 false opt-in。
- 主开关联动：切套索先直连 `action.batchPlay` 失败再回退 `core.executeAsModal`；两选项存 panel-state.json，勿放 MainToggleBus。
- 提交约定（硬性）：每次 commit 必须 `git add -A` 纳入 `.workbuddy/memory/` 全部记忆与日志。

## 二、避坑指南

- **UXP/React**：`addNotificationListener` 首参须字符串数组；React19 dev 白屏→入口最优先 import `uxpPerfPatch.ts`；仓库统一 LF；`.info-plane` 须 `position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:250px;height:20px;z-index:2000`；元素凭空消失先查祖先 `max-height`/`overflow:hidden`。
- **算法**：分块补色 cand 用 `distanceToMask`；清像素须显式清零；扣白/扣黑公式与 N 计算见历史日志。
- **Windows 守护进程/全局热键**：C# `System.Text.Json` 须 CamelCase+CaseInsensitive；钩子回调只 Enqueue+PostThreadMessage，绝不网络/同步 I/O；`.ps1` 纯 ASCII；会话沙箱回收后台子进程需 HKCU Run 自启。
- **跨面板热键**：`connectHotkeyDaemon()` 须幂等；主开关跨面板用 `settings/main-toggle.json` 共享，热键只翻共享态不直接调回调。
- **批量删除顺序**：先删笔刷条目（setEntries+pushConfig）再解绑主开关（setMainToggleCombo('')），反序会复原已删条目。
- **sp-menu 不可 CSS 改背景** → 一律用自绘 Select，勿再引入 sp-picker。
- **自绘下拉弹层用 `createPortal` 到「面板根容器」解决层级，绝不用「隐藏数字」的 hack**：靠 z-index（曾 10002）不够——面板容器自身创建层叠上下文会把弹层困住。打开弹层时给 `body` 加 `mask-sync-pop-open` 类、再靠 CSS `visibility:hidden` 隐藏数字输入的旧方案已废弃（观感诡异）。`Select.tsx` 与调整面板 `MaskSyncSelect` 均已移除该 class 开关，对应 CSS 规则已删除。
- **面板内禁止写 `.xxx-item div{}` 这类通配后代选择器**：`.gradient-setting-item div{display:flex}` 曾命中下拉弹层（弹层当时为面板内 div 且未声明 display），把弹层变成 flex 行容器，导致「线性/径向」两个选项并排成两列。通用样式一律用子选择器 `>` 限定层级，或给组件根/内部元素显式声明 `display`。
- **同理禁止 `.xxx-item span{}` 这类后代规则**：`.gradient-setting-item span{font-size:13px;margin-left:-4px}`（特异性 0,1,1）会盖掉自绘下拉内部的 `.mask-sync-select-caret{margin-left:auto}`（0,1,0），表现为箭头紧贴文字、字号与其它下拉不一致。**防御手段**：下拉头部内部元素一律用「两级类」写（`.mask-sync-select-wrap .mask-sync-select-value/.mask-sync-select-caret`，特异性 0,2,0），面板级规则就盖不住。
- **【UXP 硬限制】可编辑控件永远画在最上层，z-index 无效**：Adobe 官方 Known Issues——"no element can overlay a widget that has text editing capabilities. Text fields and areas will always render the text editor above everything else in the same panel or dialog"。`input[type=number]`/`textarea`/`sp-textfield` 无视 z-index、portal、transform 提层。**内联样式提层救不了**，官方只给两条路：① 用 popover 承载内容；② 隐藏被盖住的控件。
  - 本项目采用②的精确版：`src/utils/popOverlay.ts` 的 `hideOccludedTextFields(popEl, root)` —— 弹层在 `useLayoutEffect([open,pos])` 里按实际矩形只隐藏**与弹层相交**的可编辑控件（`visibility:hidden` 保留占位、跳过 `document.activeElement`），关闭时还原。绝不要再退回「打开下拉就隐藏面板内所有 number 输入」的粗暴做法（观感诡异）。
  - 弹层内联样式仍用 `POP_LAYER_STYLE`（`zIndex:99998` + `transform:translateZ(0)` + `willChange:transform`），对滑块 thumb、sticky 面板等普通 DOM 有效。
