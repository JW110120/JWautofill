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
- **下拉头部必须撑满 wrap**：`.mask-sync-select-wrap > .mask-sync-select-head{flex:1 1 auto;width:100%;min-width:0}`（adjustment.css）。
- **选中项样式（全项目统一，基准=de61f56 的调整面板）**：选中行 `.mask-sync-select-opt.sel` 背景=`rgb(38, 128, 235)`（字面色值，不要用 `var(--primary-color)`——UXP portal 子树里解析不稳定会回退成面板底色）前景白；**仅当该项没有右侧标记（笔刷图标 / （像素）等图层 tag）时**在行尾渲染对勾 `.mask-sync-select-check`（svg `fill="currentColor"` 自动变白，`margin-left:auto` 右对齐）。有 tag 时不画勾，避免与标记打架。头部（闭合态）只显示 value + tag + 箭头，不画勾。
- **下拉头部内部元素防覆盖**：`.mask-sync-select-wrap .mask-sync-select-value / .mask-sync-select-caret` 用「两级类」写（特异性 0,2,0），否则会被面板级 `.xxx-item span{...}`（0,1,1）覆盖导致箭头不右对齐、字号不一致。面板里给 span 定样式一律写成 `.xxx > div > span` 这类精确子选择器。因为面板里大量存在 `.xxx-setting-item div{display:flex}` 这类规则，会把 wrap 变成 flex 容器，head 作为 flex item 会退化到内容宽度（几十 px），导致下拉框异常窄、弹层（宽度=head 宽度）跟着变窄、选项文字换行看着像两列。

### 排版规范（通用布局）
- **一行两个「标签 + 控件(checkbox/switch/input)」统一用 `.field-row-two`**（定义在 `src/styles/styles.css`，全局类）：`.field-row-two > .field-cell`(flex:1 等宽，可多个) `> .field-cell-label`(标签容器) + `.field-cell-control`(控件小容器)。参考主面板底部 checkbox 区结构。**今后此类排版一律用此结构，禁止临时 inline 拼凑。**
- 下拉「标签 + 下拉同行、下拉自适应宽度、二者占满整行」参考边缘平滑「平滑模式」：容器 `flex-direction:row; align-items:center`；**标签取内容宽度 `flex:0 0 auto;white-space:nowrap`**（不要用 `flex:1 1 auto` 撑满，也不要给下拉设 px 上限——UXP 下会把下拉压窄到选项换行/横排），下拉（`.mask-sync-select-wrap`）`flex:1 1 auto; min-width:0` 自适应占满剩余整行。例：渐变「样式」下拉 `.gradient-type-setting`；其标签与下方「角度：」标签用同一条 `.gradient-setting-item > label` 规则，保证两行控件左端对齐。与「标签占满整行 + 下拉全宽」纵向堆叠是两套不同需求，按需选用。
- **渐变「角度」行约定（用户拍板）**：径向模式下**置 disabled 而非隐藏**（行始终渲染、保留占位高度），以保持 `.gradient-settings-area` 容器高度在线性/径向两种模式下恒定，避免切换时下拉相对容器上移/间距变化的观感。禁用态：RangeSlider/input 传 `disabled`、`label` 去掉拖拽 `onMouseDown` + 光标 `not-allowed`，样式见 `.gradient-angle-setting.disabled`（label 用 `--disabled-color`、滑块/数字 `opacity:0.4`）。`gradient-settings-area` 基础块恒定 `height:18%;min-height:80px;overflow-y:auto`，不要再加 `radial-mode`/`linear-mode`/`compact` 这类按模式改高度的死样式。
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

- **改内联样式想覆盖 CSS 时，先查对方有没有 `!important`（血泪坑）**：`src/styles/input-fix.css` 里有 `.gradient-picker/.pattern-picker/.color-settings-panel/.stroke-setting input[type="number"]{visibility:visible!important;opacity:1!important}`，**普通内联样式（author 普通声明）层叠顺序低于 author `!important`，写了也白写**。必须 `el.style.setProperty(prop, val, 'important')` —— important 内联与 author important 同 origin 层，再靠内联最高特异性取胜。还原时要用 `getPropertyValue` + `getPropertyPriority` 记录原始值+优先级，空则 `removeProperty`。
- **UXP 可编辑控件穿透弹层是硬限制**（官方 Known Issues：text field 永远画在同面板最上层，z-index/transform/portal 都无效）。当前方案：`utils/popOverlay.ts` 的 `createOcclusionSession()`（`{update(popEl,root,fallbackRect), restore()}`），按弹层**实际矩形**只隐藏与其相交的 input/textarea/sp-textfield，`visibility:hidden!important + opacity:0!important + pointer-events:none!important`，跳过 `document.activeElement`，关闭时逐个还原。调用约定：`useLayoutEffect([open,pos])` 跑一次 + `requestAnimationFrame` 补一次（UXP 偶发插入当帧量不到尺寸，用 `estimatePopRect` 兜底），cleanup 里 `cancelAnimationFrame` + `restore()`。**绝不可退回「打开下拉就隐藏面板内所有数字输入」**（观感诡异，用户明确否决）。
- **UXP/React**：`addNotificationListener` 首参须字符串数组；React19 dev 白屏→入口最优先 import `uxpPerfPatch.ts`；仓库统一 LF；`.info-plane` 须 `position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:250px;height:20px;z-index:2000`；元素凭空消失先查祖先 `max-height`/`overflow:hidden`。
- **算法**：分块补色 cand 用 `distanceToMask`；清像素须显式清零；扣白/扣黑公式与 N 计算见历史日志。
- **Windows 守护进程/全局热键**：C# `System.Text.Json` 须 CamelCase+CaseInsensitive；钩子回调只 Enqueue+PostThreadMessage，绝不网络/同步 I/O；`.ps1` 纯 ASCII；会话沙箱回收后台子进程需 HKCU Run 自启。
- **跨面板热键**：`connectHotkeyDaemon()` 须幂等；主开关跨面板用 `settings/main-toggle.json` 共享，热键只翻共享态不直接调回调。
- **批量删除顺序**：先删笔刷条目（setEntries+pushConfig）再解绑主开关（setMainToggleCombo('')），反序会复原已删条目。
- **sp-menu 不可 CSS 改背景** → 一律用自绘 Select，勿再引入 sp-picker。
- **【UXP 坑·已纠正】选中项背景不要用 `var(--primary-color)`**：自绘下拉弹层 `createPortal` 到 `#app`（`<Provider>` 根容器内）后，实测 `.sel` 的 `background: var(--primary-color, ...)` 在该子树里解析不到主色蓝、回退成面板底色（`--bg-color` 观感），CSS/JS 都正确也救不了。已确认 **Spectrum 的 `<Provider>` 根本没定义 `--primary-color`**（最初猜测是它覆盖，后经 `grep -rno` 验证为假），真凶是 **UXP 在 portal 子树里对 `var()` 的解析不稳定**。**最终修复**：`.mask-sync-select-opt.sel` 与 `.mask-sync-select-head.open` 的背景/边框直接写**字面色值 `rgb(38, 128, 235)`**（四套主题里 `--primary-color` 本就恒定为此值，故与主题完全一致、且不依赖变量解析）。`.mask-sync-select-pop`/`.wrap` 上的局部 `--primary-color` 声明保留作冗余兜底。
- **自绘下拉弹层用 `createPortal` 到「面板根容器」解决层级，绝不用「隐藏数字」的 hack**：靠 z-index（曾 10002）不够——面板容器自身创建层叠上下文会把弹层困住。打开弹层时给 `body` 加 `mask-sync-pop-open` 类、再靠 CSS `visibility:hidden` 隐藏数字输入的旧方案已废弃（观感诡异）。`Select.tsx` 与调整面板 `MaskSyncSelect` 均已移除该 class 开关，对应 CSS 规则已删除。
- **面板内禁止写 `.xxx-item div{}` 这类通配后代选择器**：`.gradient-setting-item div{display:flex}` 曾命中下拉弹层（弹层当时为面板内 div 且未声明 display），把弹层变成 flex 行容器，导致「线性/径向」两个选项并排成两列。通用样式一律用子选择器 `>` 限定层级，或给组件根/内部元素显式声明 `display`。
- **同理禁止 `.xxx-item span{}` 这类后代规则**：`.gradient-setting-item span{font-size:13px;margin-left:-4px}`（特异性 0,1,1）会盖掉自绘下拉内部的 `.mask-sync-select-caret{margin-left:auto}`（0,1,0），表现为箭头紧贴文字、字号与其它下拉不一致。**防御手段**：下拉头部内部元素一律用「两级类」写（`.mask-sync-select-wrap .mask-sync-select-value/.mask-sync-select-caret`，特异性 0,2,0），面板级规则就盖不住。
- **popOverlay 三个关键坑（UXP 下缺一不可，渐变「样式」下拉漏检即此三连）**：
  1. **【决定性根因·渐变等次级面板下拉漏检】`input-fix.css` 的次级面板 input 规则绝不能带 `!important`**：该文件有 `.gradient-picker/.pattern-picker/.color-settings-panel/.stroke-setting input[type=number]{visibility:visible!important;...}`，本意“确保次级面板输入可见”。**但 UXP 的 CSS 引擎在 important 级会把「样式表 !important」判在「内联 !important」之上（与标准层叠相反）**——于是遮挡逻辑的内联 `visibility:hidden!important` 永远赢不了它，表现就是「次级面板的下拉菜单下方数字始终浮在菜单上、其它（主面板 #app 下无此规则）下拉却正常」。隐藏本身仍用 `el.style.setProperty('visibility','hidden','important')`（连同 opacity/pointer-events）+ 逐字还原；**但根治手段是去掉那条 `!important`**（降级为普通声明），使内联 important 正常胜出、且不引起布局位移（visibility 保留占位）。
  2. **遮挡矩形必须锚定 `pos`，绝不信任 measured.top/left**：UXP 下刚 portal 出的 `position:fixed` 弹层 `getBoundingClientRect()` 坐标（top/left）常错乱（0 或远超真实值），只有高宽偶尔可信。弹层 `left/top/width` 本就由我们写成 `pos`（下拉头部 rect + head.bottom+2），故 `update()` 用 `estimatePopRect(pos,…)` 的 `fallbackRect`（X/Y/width 全来自 pos）锚定，**高度取 `max(measuredH, fallbackH)`**（兜底 `min(200, max(90, n*24+12))`，足以盖住短菜单正下方 number 输入）。
  3. **候选控件自身矩形会退化（0 尺寸）**：UXP 原生 number/text 输入（尤其次级面板 `.gradient-picker` 这类 `z-index:9999` 作用域）常返回 0 宽高——画得出来但 JS 量不到。旧逻辑 `r.width<=0||r.height<=0` 就 `continue` 跳过，导致「角度」数字压在弹层上却不隐藏。用 `robustRect(el)` 逐级向上（自身→父包裹 div→更上层容器，≤4 级）取第一个有效尺寸矩形做相交判定。
  - 调用侧：`useLayoutEffect([open,pos])` 跑一次 + `requestAnimationFrame` 补一次（UXP 插入当帧常量不到尺寸），cleanup `cancelAnimationFrame`+`restore()`。绝不再用「打开下拉就隐藏所有 number 输入」的 hack。
