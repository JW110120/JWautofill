# JWautofill 长期记忆（精简）

## 设计规范
- 颜色：禁止 HEX，一律 rgb()/rgba() 走 theme.ts 主题变量（--bg-color/--text-color/--entry-bg/--border-color/--primary-color:rgb(38,128,235)/--hover-bg/--dropdown-bg-color/--notify-*）。遮罩 0.80 不透明度字面写 theme.ts，绝不用 var(--overlay-scrim)。
- 面板：选区填充=com.listen2me.jwautofill(src/app.tsx)；绘画工具箱=com.listen2me.pixeladjustment(src/adjustments/AdjustmentPanel.tsx)。

## LicenseDialog（2026-08-31）
- 激活弹窗遮罩 padding:10px + 卡片 width:100%（面板250→卡片230），按钮原生 <button class="license-btn"> 全宽32px。
- 联系作者：可点击 <span role="button">（非 <a>），色字面 rgb(38,128,235)，下划线 border-bottom，外链 shell.openExternal。
- .license-status-banner 永远普通文档流 width:100%。授权状态唯一来源 LicenseManager.getLicenseState()（stateCache 记忆化；saveLicenseInfo/clearLicense 置空缓存）；激活/试用成功由 app.tsx 弹窗关闭同刻 dispatch license-updated。

## 分区系统（AdjustmentPanel）
- SectionConfig[]（order/isCollapsed/isVisible）驱动渲染；renderSection 头部 draggable 长按拖拽排序，.dragging(0.45)/.drop-target(虚线 outline var(--primary-color))。笔刷热键并入 sections（id:'brushHotkey', order:4），BrushHotkeySection 只返回 Fragment。

## 滑块标签横向拖拽
- useLabelDrag(configs, applyValue)，灵敏度=step/5。APP 主面板走 utils/DragHandler.configs（新标签须注册否则静默失效），工具箱走 SLIDER_DRAG_CONFIGS。
- 双行滑块 onMouseDown/title 挂行容器整行可拖；容器 handler 须排除 INPUT/TEXTAREA。拖拽光标锁 body.label-drag-cursor *{ew-resize!important} 在 common.css（引用计数防误摘）。非滑块拖拽（热键记录排序/渐变停靠点/图案预览平移）保持 grabbing/grab。

## 下拉/选择器
- 全插件下拉统一 src/components/Select.tsx（自绘，createPortal 到 #app/#pixeladjustment，绝不挂 body；选中背景写死 rgb(38,128,235)）；样式 .mask-sync-select-* 在 adjustment.css。支持 depth/showCheck/onOpen。
- 下拉行标签 6px 间距规则在 common.css（.adjustment-slider-label-static + .gradient-setting-item>label + .stroke-blende-mode label）；标签必须内容宽度，绝不套 -4/-wide 固定宽度档。
- .adjustment-smooth-mode-select / .gradient-type-setting .mask-sync-select-wrap 均 flex:1 1 0%；基类 .mask-sync-select-wrap flex:1 1 120px。

## UXP 避坑
- 原生 input：容器32px+input24px 缓冲（input 绝不能撑满容器）；单位符号放裁剪容器外（.num-unit）。
- number-input appearance:none 已由 common.css 全局 input[type="number"] 单条提供（原 #app/#pixeladjustment 两份作用域副本已删）；input-fix.css 的 #app input z-index:1!important 是功能性修复，不能动。
- 「框里框」=双层边框：视觉边框由外层 .num-input-row 提供，input 本体严禁再写 border/border-radius；新增数字输入一律放进 .num-input-row。
- flex gap 不可靠→margin；<a> 不唤起浏览器→shell.openExternal；遮罩下隐藏控件走 body.xxx + visibility/opacity/pointer-events !important（input-fix.css/adjustment-input.css 功能性规则禁改）。
- 面板禁止 .xxx-item div{} 通配后代选择器（命中自绘弹层）。

## 布局宽度（定稿）
- 滑块文字标签宽度 W(n)=20+(n-2)×13.33（2..6字=20/33/47/60/73px），common.css 宽度档统一收口；.wide/.wider-adjustment-slider-label 为内容宽（flex:none），不在宽度档。
- 按钮宽度=字数×字号+20px，落点 common.css .adjustment-button 系列（默认72/-lv2 46/-wide 124/-5~8/-quad 92）。
- 数字输入全插件统一 24px（common .num-input-row/.adjustment-number-input）；gradient.css 剩的 35px 是 .preset-item 预设格尺寸（非数字输入，保留）。

## 通用组件 CSS 单一来源（common.css，2026-09-02 定稿）
- 单一来源=src/styles/common.css，index.tsx 在 uxpPerfPatch 后、React 前首行 import（import 顺序=级联顺序，须最先）。目标「改一处全跟着改」：面板/工具箱 CSS 只留真独有组件/容器 + 「↳ 已收口」注释标记；样式漂移=改漏了，一律按 common 对齐，不留面板副本。
- 已收口：滑块行容器/标签宽度档/10px 与 6px 标签间距、可拖拽标签别名组（.draggable-label+.adjustment-slider-label-drag：ew-resize+user-select:none）、下拉行静态标签（.adjustment-slider-label-static）、描边行标签间距（.stroke-wide-container/.stroke-opacity-control .slider-text 10px）、range-slider、数字输入(.num-input-row/.adjustment-number-input 24px)+单位符号(.num-unit,.adjustment-unit)、全局 input[type=number] appearance 复位、icon 按钮、按钮族+宽度档+close-button、开关行、双列 radio（本体别名 + 两列布局块：.colorsettings-calculation-mode/.position-radio-group/.pattern-fillmode-container 前缀的 sp-radio-group[flex row space-around]/sp-radio[flex:1 space-between]，面板只留组 margin 与选项间距 110/45/105px）、双列/单列 checkbox（.pattern-checkbox-container 吃 common padding:10/height:100，图案原紧凑覆盖已删）、radio-item-label 13px、子面板外壳（padding:10/自定义滚动条/布局 absolute+calc(100%-20px)+flex 列+> * flex-shrink:0，标题 .subpanel-header）、拖拽光标锁、.final-preview-hint、.icon-14/15/16。
- TSX 类名约定：标签一律 .slider-text（可拖拽再加 .draggable-label）；描边 .stroke-label-2/-4 已删（StrokeSetting.tsx 已改用 common 类名）。
- 已删：CustomSwitch.tsx、死规则 .gradient-setting-item select（全项目无原生 <select>）。
- 级联陷阱：① .adjustment-slider-item .adjustment-slider-label 10px(0,2,0) 压过 static 6px(0,1,0)→common 用 :not() 豁免；② #app 作用域选择器(1,1,1) 压过 common 无作用域(0,1,1)→styles.css 的 4 个 #app 子面板滚动条选择器已删，仅留 #app .container；③ 子面板 z-index:9999!important 真值在 input-fix.css（styles.css @import 加载，manifest cssResources 全插件生效），其功能性可见/遮挡规则绝不能动。
- 命名约定：common.css 定权威类+别名（.selection-* 权威，.adjustment-* 别名）。

## 说明文案
- hover title 收口 src/constants/helpTexts.ts，title={helpTexts.x.y}，禁止 JSX 内联长字符串。

## 其它
- 守护进程：代码称 daemon，用户可见「快捷键服务」；exe 静默、日志 %LOCALAPPDATA%\JWautofill\daemon\daemon.log、自拷贝+注册 HKCU\Run。笔刷热键按 _name 绑定。
- 蒙版同步：MaskSyncEngine.ts 单例；无活动文档时静默（opacity:0.45）。
- 重大变更须同步 docs/fill-guide.html、docs/toolbox-guide.html、README.md；git add -A 纳入 .workbuddy/memory/。
- 算法：分块补色/渐变/线稿引导/alpha 对齐见历史日志；清像素须显式清零。
