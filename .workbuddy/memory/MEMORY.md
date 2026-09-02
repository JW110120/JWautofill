# JWautofill 长期记忆（精简）

## 设计规范
- 颜色：禁止 HEX，一律 rgb()/rgba() 走 theme.ts 主题变量（--bg-color/--text-color/--entry-bg/--border-color/--primary-color:rgb(38,128,235)/--hover-bg/--dropdown-bg-color/--notify-*）。遮罩 0.80 不透明度字面写 theme.ts（darkest/dark/light/lightest 四档），绝不用 var(--overlay-scrim)。
- 面板：选区填充=com.listen2me.jwautofill(src/app.tsx)；绘画工具箱=com.listen2me.pixeladjustment(src/adjustments/AdjustmentPanel.tsx)。

## LicenseDialog（2026-08-31）
- 激活弹窗遮罩 padding:10px + 卡片 width:100%（面板250→卡片230），按钮原生 <button class="license-btn"> 全宽32px，间距用 margin。
- 联系作者：可点击 <span role="button">（非 <a>），色字面 rgb(38,128,235)，下划线用 border-bottom，外链 shell.openExternal。
- .license-status-banner 永远普通文档流，width:100%。
- 双面板授权状态唯一来源 LicenseManager.getLicenseState()（带 stateCache 记忆化）；saveLicenseInfo/clearLicense 须置空缓存。激活/试用成功由 app.tsx 弹窗关闭同刻 dispatch license-updated；注销 clearLicense 立即广播。

## 分区系统（AdjustmentPanel）
- SectionConfig[]（order/isCollapsed/isVisible）驱动渲染；renderSection 头部 draggable + onDragStart/Over/Drop 长按拖拽排序，dragSourceId/dragOverId 控制 .dragging(透明0.45)/.drop-target(虚线 outline:2px dashed var(--primary-color))。
- 笔刷热键已并入 sections（id:'brushHotkey', order:4），内容由 renderSectionContent 分发；BrushHotkeySection 只返回 Fragment（无外层 section 包裹），头部/折叠/拖拽归父分区所有。
- 可见性弹窗遍历 sections，新增分区自动支持隐藏/显示。

## 滑块标签横向拖拽
- 通用 hook useLabelDrag(configs, applyValue)；灵敏度 = step/5。APP 主面板走 utils/DragHandler.configs（新标签须注册，否则静默失效），工具箱走 SLIDER_DRAG_CONFIGS。
- 双行滑块：onMouseDown/title 挂上层行容器整行可拖；单行滑块只挂标签。容器 handler 须排除 INPUT/TEXTAREA 防吞聚焦。
- 拖拽中光标统一 ew-resize：setDragCursorActive(true/false) + body.label-drag-cursor *{cursor:ew-resize!important}（引用计数防多面板叠加误摘）。工具箱样式在 src/adjustments/adjustment.css（勿改已删的 src/styles/adjustment.css）。全插件 6 处全局规则（adjustment/colorpanel/gradient/pattern/stroke/styles 的 .label-drag-cursor）+ 各滑块 .xxx.dragging 均 ew-resize；非滑块拖拽（笔刷热键记录排序 .hotkey-entry-row.dragging、渐变停靠点 thumb、图案预览平移）保持 grabbing/grab 不动。

## 下拉/选择器（2026-09-02 收敛定稿）
- 全插件下拉统一用 src/components/Select.tsx（自绘，createPortal 到面板根 #app/#pixeladjustment，绝不挂 body；选中项背景写死 rgb(38,128,235)）。
- 原 AdjustmentPanel 内联 MaskSyncSelect 已收敛删除：Select 现支持 SelectOption.depth（图层树缩进 padding-left:8+depth*16）、showCheck（选中对勾，默认开）、onOpen（展开前刷新钩子，刷新期 Infinity 抑制自动关闭 + 完成后 600ms 缓冲）。5 处蒙版同步下拉（样本/通道/蒙版/平滑模式/线稿参考）与 app/gradient/pattern/stroke/brush 全部走 Select。
- 样式集中在 src/adjustments/adjustment.css 的 .mask-sync-select-*（全插件共享，子面板同 bundle 同文档吃这份 CSS）。
- 下拉文字标签 margin-right 统一 6px：下拉行标签用 .adjustment-slider-label-static（仅平滑模式/线稿参考，不动真实滑块 .adjustment-slider-label-drag）；.mask-sync-label/.selection-fill-blend-mode-label 已 6px；.gradient-setting-item>label 与 .stroke-blende-mode label 改 6px。
- 下拉行标签必须内容宽度（.adjustment-slider-label-static 已设 flex:0 0 auto）且**绝不能套滑块固定宽度修饰类（-4/-wide 等）**：4 字标签(~52px)会溢出 47/50px 固定框，把 margin-right:6px 吃掉，肉眼像紧贴。线稿参考原用 wide-adjustment-slider-label 也已去掉。
- 容器宽度不固定：flex 填充行剩余宽度（标签宽 + 行容器宽度共同决定）。.adjustment-smooth-mode-select 已改 flex:1 1 0%（原固定 190px）；gradient 用 .gradient-type-setting .mask-sync-select-wrap{flex:1 1 0%}；其余基类 .mask-sync-select-wrap{flex:1 1 120px}。

## UXP 避坑
- 原生 input：background:transparent + 容器32px/input24px 缓冲 + onFocus/onBlur 切 .is-focused + appearance:none。
- flex gap 不可靠→margin；容器 opacity 压暗子链接→只降文字透明。<a> 不唤起浏览器→shell.openExternal；自定义色链接用 <span role="button">。
- number input 防越界：容器32px+input24px（input 绝不能撑满容器），单位符号放裁剪容器外（.num-unit 等）。
- 全插件 number-input 统一 appearance:none 消原生边框内套边框：#app 由 styles.css `#app input[type="number"]`（仅 appearance，不动 input-fix.css 的 z-index 修复），#pixeladjustment 由 adjustment.css `#pixeladjustment input[type="number"]` 全局覆盖；新增数字输入自动继承，无需单独加。
- 「框里框」根因 = 双层 CSS 边框：外层 .num-input-row（styles.css 带 border）已提供视觉输入框，故子面板 input[type=number] 规则（.colorsettings-slider-item/.pattern-setting-item/.gradient-setting-item/.opacity-input）严禁再写 border/border-radius（否则与外层叠成框里框）。描边子面板 .stroke-wide-container 的 .num-input-row 与 input 本就不写 border，故天然无此问题——新增数字输入一律放进 .num-input-row 且 input 不带 border。
- 遮罩下隐藏控件：body.adjustment-lock-overlay #pixeladjustment input,textarea / body.license-dialog-open #app … + visibility:hidden!important;opacity:0!important;pointer-events:none!important。
- 面板禁止 .xxx-item div{} 通配后代选择器（命中自绘弹层）；radio 自定义按钮绝对定位，规则 scoped 不挂全局。

## 布局宽度（定稿）
- 滑块文字标签宽度：W(n)=20+(n-2)×13.33（n=2..6 → 20/33/47/60/73px），由 -2~-6 修饰类，容器 flex:none。
- 按钮宽度：字数×字号+20px（普通 height30/font13；紧凑 height24/font12）。落点 adjustment.css .adjustment-button 系列（默认72/-lv2 46/-wide 124/-5~8 精确档）。

## 说明文案
- 所有 hover title 收口 src/constants/helpTexts.ts（selectionFill/adjustment/hotkey/gradient/pattern），调用处 title={helpTexts.x.y}，禁止 JSX 内联长字符串（多行用 \n\n 拼接）。

## 其它
- 守护进程：代码称 daemon，用户可见「快捷键服务」；exe 静默、日志 %LOCALAPPDATA%\JWautofill\daemon\daemon.log、自拷贝+注册 HKCU\Run。笔刷热键不支持同名笔刷（按 _name 绑定，PS 选最上方）。
- 蒙版同步：MaskSyncEngine.ts 单例；无活动文档时状态条显示静默（不弹警告），"未打开文档" opacity:0.45 省去告警观感。
- 文档/README 同步：重大变更须同步 docs/fill-guide.html、docs/toolbox-guide.html、README.md。
- 提交约定：git add -A 纳入 .workbuddy/memory/ 全部记忆与日志。
- 算法：分块补色/渐变/线稿引导/alpha 对齐见历史日志；清像素须显式清零。
