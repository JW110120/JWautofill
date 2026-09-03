# JWautofill 长期记忆（精简）

## 设计规范
- 禁止 HEX，一律 rgb()/rgba() 走 theme.ts 主题变量（--bg-color/--text-color/--entry-bg/--border-color/--primary-color:rgb(38,128,235)/--hover-bg/--dropdown-bg-color/--notify-*）。遮罩 0.80 不透明度字面写 theme.ts，绝不用 var(--overlay-scrim)。
- 面板：选区填充=com.listen2me.jwautofill(src/app.tsx)；绘画工具箱=com.listen2me.pixeladjustment(src/adjustments/AdjustmentPanel.tsx)。
- 术语（2026-09-03）：APP/AdjustmentPanel 均「父面板」；描边/渐变/纯色/图案四者=「子面板」（APP 内 absolute 面板）；激活面板与工具箱分区统称「浮动窗口」。单行滑块=整行独占（标签+数字+单位上行两行式）；行内滑块=标签+滑块+数字+单位同一行。UXP 不支持 flex gap，一律 margin。

## LicenseDialog（2026-08-31）
- 遮罩 padding:10px + 卡片 width:100%，按钮原生 <button class="license-btn"> 全宽32px。
- 联系作者用 <span role="button">（非 <a>），色字面 rgb(38,128,235)，border-bottom 下划线，shell.openExternal。
- .license-status-banner 普通文档流 width:100%。授权状态唯一来源 LicenseManager.getLicenseState()（stateCache 记忆化，save/clear 置空）；激活/试用成功由 app.tsx 关弹窗同刻 dispatch license-updated。

## 分区系统（AdjustmentPanel）
- SectionConfig[]（order/isCollapsed/isVisible）驱动；renderSection 头部长按拖拽排序，.dragging(0.45)/.drop-target(虚线 outline var(--primary-color))。笔刷热键并入 sections（brushHotkey, order:4），BrushHotkeySection 只返回 Fragment。

## 滑块标签横向拖拽
- useLabelDrag(configs, applyValue)，灵敏度=step/5。APP 走 utils/DragHandler.configs（新标签须注册否则静默失效），工具箱走 SLIDER_DRAG_CONFIGS。
- 双行滑块 onMouseDown/title 挂行容器整行可拖，handler 须排除 INPUT/TEXTAREA。拖拽光标锁 body.label-drag-cursor *{ew-resize!important} 在 common.css（引用计数防误摘）。非滑块拖拽（热键排序/渐变停靠点/图案预览平移）保持 grabbing/grab。

## 下拉/选择器
- 全插件下拉统一 src/components/Select.tsx（自绘，createPortal 到 #app/#pixeladjustment 面板根，绝不挂 body；选中背景写死 rgb(38,128,235)）；样式 .mask-sync-select-* 只在 adjustment.css。支持 depth/showCheck/onOpen。
- 下拉行标签 6px 间距规则在 common.css（.adjustment-slider-label-static + .gradient-setting-item>label + .stroke-blende-mode label）；标签必须内容宽度，绝不套固定宽度档。
- .adjustment-smooth-mode-select / .gradient-type-setting .mask-sync-select-wrap 均 flex:1 1 0%；基类 .mask-sync-select-wrap flex:1 1 120px。
- ⚠️ Select.tsx 的态类全是「独占类名」：head-open/head-disabled/opt-sel/opt-dis 不含基础类。基础样式必须写「三态共享组」（.head,.head-open,.head-disabled / .opt,.opt-sel,.opt-dis 合写 display/font-size/padding），否则展开瞬间退化成块（2026-09-03 修复：头部多一行/选中项字号变小/对勾不右对齐）。新加态类必须照此办理。

## UXP 避坑
- 原生 input 容器高32px+input高24px 缓冲（input 绝不撑满容器，上下各4px缓冲）；单位符号放裁剪容器外（.num-unit）。⚠️ 跨 PS 版本：27.9+ 会裁剪原生控件无越界；≤27.8 旧版不裁剪，容器必须与 input 等高(24=24) 才会下越界——故容器必须高于 input 留缓冲。字段宽 32px（2026-09-03 由 24 改 32）。
- number-input appearance:none 由 common.css 全局 input[type="number"] 单条提供；input-fix.css 的 #app input z-index:1!important 是功能性修复不能动。
- 「框里框」：视觉边框由外层 .num-input-row 提供，input 本体严禁 border/border-radius；新数字输入一律放 .num-input-row。
- flex gap 不可靠→margin；<a> 不唤起浏览器→shell.openExternal。
- **原生 input 是 UXP 原生视图永远画同面板最上层，overflow:hidden/max-height 裁不住（官方 Known Issue）。两面板折叠分区必须条件渲染**（折叠态不进 DOM：AdjustmentPanel renderSection / app.tsx `{expanded && <div className="collapse-content-expanded">}`）。
- 面板禁止 .xxx-item div{} 通配后代选择器（命中自绘弹层）。

## 父面板滚动（2026-09-03 定稿；2026-09-03 当晚 + 收口修正）
- APP 主面板滚动容器链（全用通用 .panel，无 .app-shell / .subpanel 类）：
  .app-root > .panel（App.render 最外层 <div className="panel">，flex 列 + height:100% + padding:0 + position:relative）
  > .panel-section（原 .selection-fill-container，flex:1 1 auto; min-height:0，作为 .app-root>.panel 的 flex 子项填满高度）
  > .panel（height:100%; min-height:0; overflow-y:auto; display:flex; flex-direction:column）即滚动容器；
  4 子面板也是 .panel，靠上下文选择器 `#app .panel-section ~ .panel`（绝对定位铺满、z-index:9999 在 input-fix.css）识别，无独立 .subpanel 类。
  工具箱 .pixeladjustment-root（flex 列）> .panel（flex 子项 + min-height:0）同款——**两者都靠 flex 列 + min-height:0 把高度可靠往下传**，不依赖易碎的百分比高度链。
- ⚠️ 历史根因：App.render 最外层 <div> 原本「无 className、无高度」，是 .app-root 与 .selection-fill-container 之间的额外包裹层且 height:auto，导致链塌缩 → 主面板滚动条消失。改法：该层挂通用 .panel（由 .app-root > .panel 提供 flex 列+定高），并把 .selection-fill-container 由 height:100% 改为 flex:1 + min-height:0，再收口为 .panel-section。
- .panel 必须带 min-height:0（与工具箱 .panel 同款）：作为 flex 列滚动容器，min-height:0 保证内容超高时自身被父级约束、由 overflow-y:auto 出滚动条，而非随内容撑高把高度链顶塌。
- 外壳 flex 列 ⇒ 子项默认 flex-shrink:1 被压扁。收口 common.css：`.panel > * { flex-shrink: 0 }`，超高交由外壳滚动条。
- info-plane（版权条）是 .panel 最后子项（margin-top:10px）随滚动走，不固定底部。
- ⚠️ 次级面板打开时 `body.secondary-panel-open #app .panel-section > .panel { overflow-y:hidden }` 禁主面板滚动；绝不能写成 `#app .panel`（会一并锁住正在打开的子面板 .panel，使其自身无法滚动）。

## 面板高度链（滚动命脉）
- APP 逐级闭合：uxp-panel → #app → **Provider 那层 div**(height="100%") → .app-root(display:block;height:100%) → **.app-root > .panel**(flex 列;height:100%，App.render 最外层 <div className="panel">) → .panel-section(flex:1 1 auto;min-height:0) → .panel(height:100%;min-height:0;overflow-y:auto)。断一层 → height 退化成 auto → 内容截断无滚动条。子面板=.panel 且为 .panel-section 的后续同级（#app .panel-section ~ .panel，absolute 铺满）。
- 工具箱逐级闭合：uxp-panel → #pixeladjustment → Provider div → .pixeladjustment-root(flex 列;height:100%) → .panel(flex 子项;height:100%;min-height:0;overflow-y:auto)。
- index.tsx 两处 <Provider> 必须都传 height="100%"（Provider 默认插 height:auto div；历史上主面板漏传→不滚）。common.css 兜底 uxp-panel{height:100%} + #app,#pixeladjustment{height:100%}。
- APP 次级面板打开时 body.secondary-panel-open #app .panel-section > .panel{overflow-y:hidden} 禁主面板滚（绝不锁 #app .panel，否则正在打开的子面板 .panel 也无法滚）。
- ⚠️ **背景兜底（防原生层漏出）**：UXP 宿主原生底色 rgb(29,29,29)，内容塌缩区若透明即透出。面板根链每一层都要铺 var(--bg-color)：工具箱 .pixeladjustment-root 自带（安全）；APP 侧已给 #app/.app-root/.app-root>.panel/.panel-section/.panel 全铺。改高度链/新增包裹层时须同步补背景兜底。
- ⚠️ **新增/改动包裹层一定要带高度**：App.render 最外层曾是无类无高 <div>，硬生生在 .app-root 与 .selection-fill-container 间插入一层 height:auto，把百分比高度链打断——这是「主面板滚动条消失」的真正根因。任何包裹层要么 flex 列 + height:100%（如 .app-shell），要么显式 flex:1/min-height:0，绝不可裸 height:auto 夹在定高链中间。

## 折叠区原生控件残留（UXP 硬限制）
- 三道防线：① 分区条件渲染；② 折叠/隐藏前 hideNativeWidgetsOfSections(ids) 按 [data-section-id] 写分区内 input/textarea/sp-textfield 内联 visibility/opacity/pointer-events !important 再卸载；③ 折叠后 resyncNativeWidgets() rAF 滚动1px 再还原逼 UXP 重排。
- 折叠容器（.collapse-content）内可编辑控件由 input-fix.css 双面板统一隐藏（#app+#pixeladjustment，不加 !important 以便 popOverlay 内联仍生效）；展开恢复规则在 input-fix（#app）/adjustment-input.css（#pixeladjustment）。

## 布局宽度（定稿）
- 滑块文字标签 W(n)=20+(n-2)×13.33（2..6字=20/33/47/60/73px），common.css 宽度档收口；.wide/.wider-* 为内容宽（flex:none）不在档内。
- 按钮宽=字数×字号+20px，common .adjustment-button 系列（默认72/-lv2 46/-wide 124/-5~8/-quad 92）。
- 数字输入全插件统一：字段宽32px×高24px、容器高32px留4px上下缓冲（common .num-input-row）；gradient.css 剩的 35px 是 .preset-item 预设格尺寸（非输入，保留）。

## 通用组件 CSS 单一来源（common.css）
- 2026-09-03：styles.css→app.css（仅 #app 主面板+4子面板+input-fix @import 组）；common.css 接管整体（全局基础：@font-face+html,body），并成静态入口（index.html <link>、manifest cssResources、webpack 拷贝均指 common.css）。index.tsx import 顺序：uxpPerfPatch→common→app→license。
- common.css 严禁 @import（会插到面板规则之前破坏「common 最先」，回归 stroke 45px/pattern 105px 覆盖问题）。目标「改一处全跟着改」，面板 CSS 只留真独有组件 + 「↳ 已收口」注释。
- 已收口：滑块单行块/行内（.slider-stack 已废弃移出 TSX）、标签宽度档与间距、range-slider、数字输入+单位、全局 input appearance、图标按钮（.icon-button + .icon-button-group[--bar]）、按钮族+宽度档+关闭（.close-button）、动作按钮（.action-button-2 原 lv2；wide/compact 死样式已删）、开关行、radio（.panel-section/.pattern-fillmode-container/sp-radio-group[flex row space-around]/sp-radio[flex:1 space-between]，选项间距 110px；描边 .position-radio-group 45px 覆盖）、checkbox（.checkbox-row 原 checkbox-inline 删除）、radio-item-label 13px、父/子面板外壳（.panel 单一样式收口：padding:10+overflow-y:auto+min-height:0+flex列；子面板即 .panel，由 #app .panel-section ~ .panel 上下文选择器补 absolute 铺满、z-index:9999 在 input-fix.css；标题 .subpanel-title-1 已合并原 -text 的字体样式、.subpanel-title-2 为二级标题；滚动条唯一一套含浮动窗口）、折叠区（.collapse-section/-header/-icon/-content/-content-expanded 原 expand-*/adjust-expand-*，条件渲染+data-section-id）、通知区（.notify-ok/-warn/-fail/-icon/-text 原 mask-sync-result-*）、拖拽光标锁、预览灰字（.final-preview-hint）、.icon-14/15/16。
- 已删：CustomSwitch.tsx、.gradient-setting-item select（无原生 <select>）。TSX 类名：标签 .slider-text（可拖拽加 .draggable-label）；描边 .stroke-label-2/-4 已删改 common 类。
- 级联陷阱：① .adjustment-slider-item .adjustment-slider-label 10px(0,2,0) 压 static 6px(0,1,0)→common 用 :not() 豁免；② #app 作用域(1,1,1) 压 common(0,1,1)→app.css 子面板滚动条选择器已删；③ 子面板 z-index:9999!important 真值在 input-fix.css（选择器 #app .panel-section ~ .panel），功能性规则绝不能动。
- 命名：common.css 权威类+别名（.selection-* 权威，.adjustment-* 别名）。

## 说明文案
- hover title 收口 src/constants/helpTexts.ts，title={helpTexts.x.y}，禁止 JSX 内联长字符串。

## 其它
- 守护进程：代码 daemon，用户可见「快捷键服务」；exe 静默、日志 %LOCALAPPDATA%\JWautofill\daemon\daemon.log、自拷贝+注册 HKCU\Run。笔刷热键按 _name 绑定。
- 蒙版同步：MaskSyncEngine.ts 单例；无活动文档静默（opacity:0.45）。
- 重大变更须同步 docs/fill-guide.html、docs/toolbox-guide.html、README.md；git add -A 纳入 .workbuddy/memory/。
- 算法：分块补色/渐变/线稿引导/alpha 对齐见历史日志；清像素须显式清零。
