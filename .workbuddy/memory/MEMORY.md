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
- 原生 input 容器32px+input24px 缓冲（input 绝不撑满容器）；单位符号放裁剪容器外（.num-unit）。
- number-input appearance:none 由 common.css 全局 input[type="number"] 单条提供；input-fix.css 的 #app input z-index:1!important 是功能性修复不能动。
- 「框里框」：视觉边框由外层 .num-input-row 提供，input 本体严禁 border/border-radius；新数字输入一律放 .num-input-row。
- flex gap 不可靠→margin；<a> 不唤起浏览器→shell.openExternal。
- **原生 input 是 UXP 原生视图永远画同面板最上层，overflow:hidden/max-height 裁不住（官方 Known Issue）。两面板折叠分区必须条件渲染**（折叠态不进 DOM：AdjustmentPanel renderSection / app.tsx `{expanded && <div className="collapse-content-expanded">}`）。
- 面板禁止 .xxx-item div{} 通配后代选择器（命中自绘弹层）。

## 父面板滚动（2026-09-03 定稿）
- 滚动容器 height 须对定高块级父级解析（父级非 flex），容器再 height:100%。APP：.selection-fill-container（块级）> .panel（height:100%;display:flex;flex-direction:column）即滚动容器（app-scroll-area 已删）；4 子面板 absolute 不占流。工具箱 .panel 同款。**绝不给 flex 子项叠 height:100%**（会内容截断无滚动条）；.subpanel/.panel 一律 height:100%，取消「高度-20」。
- 外壳 flex 列 ⇒ 子项默认 flex-shrink:1 被压扁。收口 common.css：`.panel > *, .subpanel > * { flex-shrink: 0 }`，超高交由外壳滚动条。
- info-plane（版权条）是 .panel 最后子项（margin-top:10px）随滚动走，不固定底部。

## 面板高度链（滚动命脉）
- 逐级闭合：uxp-panel → #app/#pixeladjustment → **Provider 那层 div** → .app-root/.pixeladjustment-root → .selection-fill-container/.panel。断一层 → height 退化成 auto → 内容截断无滚动条。
- index.tsx 两处 <Provider> 必须都传 height="100%"（Provider 默认插 height:auto div；历史上主面板漏传→不滚）。common.css 兜底 uxp-panel{height:100%} + #app,#pixeladjustment{height:100%}。
- APP 次级面板打开时 body.secondary-panel-open #app .panel{overflow-y:hidden} 禁滚。
- ⚠️ **背景兜底（防原生层漏出）**：UXP 宿主原生底色 rgb(29,29,29)，内容塌缩区若透明即透出（全收起后 info 下方占近半面板高的断层，四主题同色）。面板根链每一层都要铺 var(--bg-color)：工具箱 .pixeladjustment-root 自带（安全）；APP 侧 app.css 已给 #app/.app-root/容器/.panel 全铺（.app-root 必须 display:block——flex 子项叠 height:100% 解析不可靠会塌缩；水平居中用容器 margin:0 auto）。改高度链/新增包裹层时须同步补背景兜底。

## 折叠区原生控件残留（UXP 硬限制）
- 三道防线：① 分区条件渲染；② 折叠/隐藏前 hideNativeWidgetsOfSections(ids) 按 [data-section-id] 写分区内 input/textarea/sp-textfield 内联 visibility/opacity/pointer-events !important 再卸载；③ 折叠后 resyncNativeWidgets() rAF 滚动1px 再还原逼 UXP 重排。
- 折叠容器（.collapse-content）内可编辑控件由 input-fix.css 双面板统一隐藏（#app+#pixeladjustment，不加 !important 以便 popOverlay 内联仍生效）；展开恢复规则在 input-fix（#app）/adjustment-input.css（#pixeladjustment）。

## 布局宽度（定稿）
- 滑块文字标签 W(n)=20+(n-2)×13.33（2..6字=20/33/47/60/73px），common.css 宽度档收口；.wide/.wider-* 为内容宽（flex:none）不在档内。
- 按钮宽=字数×字号+20px，common .adjustment-button 系列（默认72/-lv2 46/-wide 124/-5~8/-quad 92）。
- 数字输入全插件统一 24px（common .num-input-row/.adjustment-number-input）；gradient.css 剩的 35px 是 .preset-item 预设格尺寸（非输入，保留）。

## 通用组件 CSS 单一来源（common.css）
- 2026-09-03：styles.css→app.css（仅 #app 主面板+4子面板+input-fix @import 组）；common.css 接管整体（全局基础：@font-face+html,body），并成静态入口（index.html <link>、manifest cssResources、webpack 拷贝均指 common.css）。index.tsx import 顺序：uxpPerfPatch→common→app→license。
- common.css 严禁 @import（会插到面板规则之前破坏「common 最先」，回归 stroke 45px/pattern 105px 覆盖问题）。目标「改一处全跟着改」，面板 CSS 只留真独有组件 + 「↳ 已收口」注释。
- 已收口：滑块单行块/行内（.slider-stack 已废弃移出 TSX）、标签宽度档与间距、range-slider、数字输入+单位、全局 input appearance、图标按钮（.icon-button + .icon-button-group[--bar]）、按钮族+宽度档+关闭（.close-button）、动作按钮（.action-button-2 原 lv2；wide/compact 死样式已删）、开关行、radio（.subpanel-section/.pattern-fillmode-container/sp-radio-group[flex row space-around]/sp-radio[flex:1 space-between]，选项间距 110px；描边 .position-radio-group 45px 覆盖）、checkbox（.checkbox-row 原 checkbox-inline 删除）、radio-item-label 13px、父/子面板外壳（.panel padding:10+overflow-y:auto、.subpanel absolute+height:100%+flex 列、标题 .subpanel-title-1[-text] 原 subpanel-header/h3、滚动条唯一一套含浮动窗口）、折叠区（.collapse-section/-header/-icon/-content/-content-expanded 原 expand-*/adjust-expand-*，条件渲染+data-section-id）、通知区（.notify-ok/-warn/-fail/-icon/-text 原 mask-sync-result-*）、拖拽光标锁、预览灰字（.final-preview-hint）、.icon-14/15/16。
- 已删：CustomSwitch.tsx、.gradient-setting-item select（无原生 <select>）。TSX 类名：标签 .slider-text（可拖拽加 .draggable-label）；描边 .stroke-label-2/-4 已删改 common 类。
- 级联陷阱：① .adjustment-slider-item .adjustment-slider-label 10px(0,2,0) 压 static 6px(0,1,0)→common 用 :not() 豁免；② #app 作用域(1,1,1) 压 common(0,1,1)→app.css 子面板滚动条选择器已删；③ 子面板 z-index:9999!important 真值在 input-fix.css，功能性规则绝不能动。
- 命名：common.css 权威类+别名（.selection-* 权威，.adjustment-* 别名）。

## 说明文案
- hover title 收口 src/constants/helpTexts.ts，title={helpTexts.x.y}，禁止 JSX 内联长字符串。

## 其它
- 守护进程：代码 daemon，用户可见「快捷键服务」；exe 静默、日志 %LOCALAPPDATA%\JWautofill\daemon\daemon.log、自拷贝+注册 HKCU\Run。笔刷热键按 _name 绑定。
- 蒙版同步：MaskSyncEngine.ts 单例；无活动文档静默（opacity:0.45）。
- 重大变更须同步 docs/fill-guide.html、docs/toolbox-guide.html、README.md；git add -A 纳入 .workbuddy/memory/。
- 算法：分块补色/渐变/线稿引导/alpha 对齐见历史日志；清像素须显式清零。
