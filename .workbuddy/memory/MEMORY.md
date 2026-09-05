# JWautofill 长期记忆

## 设计规范
- 禁止 HEX，一律 rgb()/rgba() 走 theme.ts 主题变量（--bg-color/--text-color/--entry-bg/--border-color/--primary-color:rgb(38,128,235)/--hover-bg/--dropdown-bg-color/--notify-*）。遮罩 0.80 不透明度字面写 theme.ts，绝不用 var(--overlay-scrim)。
- 面板：选区填充=com.listen2me.jwautofill(src/app.tsx)；绘画工具箱=com.listen2me.pixeladjustment(src/adjustments/AdjustmentPanel.tsx)。
- 术语：APP/AdjustmentPanel 均「父面板」；描边/渐变/纯色/图案=「子面板」（APP 内 absolute）；激活面板与工具箱分区统称「浮动窗口」。单行滑块=标签+数字+单位上行两行式；行内滑块=同行。UXP 不支持 flex gap→一律 margin。

## 面板高度链（滚动命脉，2026-09-03 定稿）
- APP 当前为 2 级结构：uxp-panel → #app → Provider div(height="100%") → .app-root(display:block;height:100%) → .app-root>.panel(App.render 最外层 <div className="panel">，即滚动容器：block+height:100%+overflow-y:auto) → .panel-section(原 selection-fill-container，flex:0 0 auto 已定稿；必须挂 panel-section--col 才纵向堆叠，否则继承 common.css 的 flex-row 把全部内容挤成一行)。
  ⚠️ 内层滚动 .panel 已删（避免与外壳 .panel 双层 10px padding 叠加成 20px）。`.panel-section` 必须是 flex:0 0 auto（固有高度、绝不收缩）：面板被压缩时容器不缩、内部组件保持固有高度、由 .panel 出滚动条；绝不能用旧 flex:1 1 auto（flex-shrink:1 会随面板压扁、组件被纵向挤压缩）。common.css 已对 `.panel > *` 与 `.panel-section--col > *` 统一 flex-shrink:0 兜底。
- 4 子面板=.panel 且为 .panel-section 后续同级，靠 `#app .panel-section ~ .panel`(input-fix.css，absolute 铺满+z-index:9999!important)识别；次级面板打开时 body.secondary-panel-open #app .app-root>.panel{overflow-y:hidden} 禁主面板滚（绝不锁 #app .panel，否则正在开的子面板也无法滚）。
- 工具箱：uxp-panel→#pixeladjustment→Provider div→.pixeladjustment-root(flex 列;height:100%)→.panel(flex 子项;height:100%;min-height:0;overflow-y:auto)。
- 新增/改动包裹层必须带高度，绝不可裸 height:auto 夹在定高链中间（曾致滚动条消失）。背景兜底：每层铺 var(--bg-color) 防原生层 rgb(29,29,29) 透出。

## UXP 避坑
- sp-radio 影子布局会把 slot 内容排到行右侧：radio 行内放自绘元素（如齿轮）绝不要绝对定位 pin 边缘（必与标签重叠）；用「.radio-item space-between + 内层 .row-end(flex-end) 文档流排布」。

- 原生 input 是原生视图永远画最上层，overflow 裁不住→折叠分区必须条件渲染（折叠态不进 DOM）。容器高32px+input高24px 缓冲；单位符号放容器外(.num-unit)；字段宽32px。number-input appearance:none 由 common.css 全局提供。
- flex gap 不可靠→margin；<a> 不唤起浏览器→shell.openExternal。面板禁止 .xxx-item div{} 通配后代选择器（命中自绘弹层）。
- ⚠️ **UXP 内 JS 测量容器尺寸（offsetWidth/offsetHeight + useLayoutEffect）不可靠**：面板组件关闭时 return null、打开时才挂载，测量时机难保证，两轮实测均失败。凡「铺满容器」的平铺背景（棋盘格等）一律用**整数 px 坐标格子过量渲染 + 容器 overflow:hidden 裁剪**（如模块级常量 FINAL_PREVIEW_CHECKER_TILES：8px 格铺满 240×320，一次生成零 reconcile）；⚠️ 百分比/% 小数坐标在 UXP 必产生亚像素缝隙，+0.25% 重叠也盖不住，禁用。
- 棋盘格「格子间缝隙/描边」根因与修法（2026-09-05 渐变面板排查）：相邻整数 px 方块在 UXP/CEF 仍会出 ~1px 亚像素缝；渐变条看似无缝是因为 gradient-fill-layer(opaque) 盖住了，而最终预览渐变含 alpha 让缝隙透出。修法=① 每个方块 `width/height = tileSize+1` 与右侧/下行方块 1px 重叠（后绘制者覆盖缝，任意 DPR 生效）；② 棋盘格底板 `.opacity-checkerboard{position:absolute;inset:0;width/height:100%}` 铺满父容器 + 渲染时多铺 64px OVERSCAN，消除「硬写 240px 但父级 width:100% 更宽」导致的右侧漏底缝。父级须 overflow:hidden。
- ⚠️ **UXP `storage.formats` 只有 `binary` / `utf8`，没有 `base64`**。任何 `file.read({format: formats.base64})` 都是 undefined，且 `file.read({format:undefined})` 不报错、静默按 UTF-8 解码返回乱码字符串（不是抛异常），用来拼 data URL 必黑屏。读图转预览一律 `file.read({format: formats.binary})` 取 ArrayBuffer → `btoa`。这是 2026-09-05 图案面板新加载全黑回归的根因。

## 通用组件 CSS 单一来源（common.css）
- index.tsx 顺序：uxpPerfPatch→common→app→license。common.css 严禁 @import。已收口：滑块块/标签档/range-slider/数字输入+单位/input appearance/图标按钮/按钮族/主标题(.main-title 去 border-bottom 改 .divider)/开关行/radio/checkbox/折叠区/通知区/滚动条/拖拽光标锁。
- .panel(外壳：padding:10+overflow-y:auto+min-height:0) 与 .panel-section(区块：row 布局，label+控件同行；列布局加 .panel-section--col) 全插件通用。
- 状态类收口 common.css「通用状态类」区（约 .thumb-box img 之后）：通用类名 .thumb-selected / .thumb-multi-selected（共享 border-width:2px 归组，仅色不同）、拖起 .thumb-box/.hotkey-entry-row/.collapse-section.dragging 三家族分组一条（(0,2,0) 压各家 base cursor）、落点分两族——.thumb-box.drop-target(border 虚线族) 与 .hotkey-entry-row/.collapse-section.drop-target(outline 虚线族，归组一条)。UXP 禁 outline-offset。TSX 只挂通用类名。
- Select.tsx 态类是独占类名(head-open/head-disabled/opt-sel/opt-dis 不含基础类)，基础样式须三态共享组(.head,.head-open,.head-disabled 合写)否则展开退化成块。

## 布局宽度
- 标签 W(n)=20+(n-2)×13.33(2..6字=20/33/47/60/73px)。按钮宽=字数×字号+20px。数字输入统一 32×24(容器32留4缓冲)。
- 两列 radio 间距：space-around 会摊开剩余空间，margin 只是「最窄容器不换行」的下限——通用两列 40px、描边位置三列 20px（最窄处=图案面板 border-panel-section ≈200px，label-N 定宽后 110px/45px 必换行）。divider 在 border-panel-section 内用负 margin ±10px 撑满容器宽。

## 其它
- 守护进程：C#/.NET8 代码 daemon（native/HotkeyDaemon/Program.cs），用户可见「快捷键服务」；exe 静默、日志 %LOCALAPPDATA%\JWautofill\daemon\daemon.log、自拷贝+HKCU\Run。常驻 WH_KEYBOARD_LL 低层钩子装在独立录制线程（带消息循环）；命中后入队交主线程广播，并以 return 1 吞键防 PS 抢键。配置经 127.0.0.1:18923 本地 WebSocket 与 UXP 面板通信。
  ⚠️ 低层键盘钩子线程**绝对禁止任何阻塞 I/O**：
  ① 钩子线程（承载钩子的录制线程）一旦在钩子回调/消息循环里做同步网络写(SendToClient)或文件写(Console.WriteLine)，写阻塞即卡死钩子消息循环 → **全键盘失灵、只有杀进程/卸载才恢复**（用户实报「运行一段时间后打不出字」）。
  ② 修复（2026-09-04）：日志统一经 QueueTextWriter 入 BlockingCollection，由专门 LoggerThread 落盘（钩子线程只入队）；录制结果 SendToClient 移交 Task.Run，绝不阻塞钩子线程；客户端 socket 设 SendTimeout=2000 兜底。
  ③ 焦点闸门：LowLevelKeyboardProc 首行 `if (!IsPhotoshopForeground()) return CallNextHookEx(...)`——焦点不在 PS 时直接放行（暂停监听），避免吞掉其它程序的按键。WatchPhotoshop 周期刷新 `_psPids`（PS 进程 PID 集合），钩子线程按前台窗口 PID 比对，避免每次按键 new Process。
- 重大变更同步 docs/*.html、README.md。hover title 收口 helpTexts.ts，禁止 JSX 内联长字符串。
