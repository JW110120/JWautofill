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
- ⚠️ **`imaging.getPixels` 会把 `sourceBounds` 裁剪到图层 bounds，再把裁剩下的内容重采样到 `targetSize`**。因此「图层只有一小块、却按大区域尺寸请求」= 内容被**拉伸**铺满请求区域，写回后图层外接矩形撑满文档（2026-09-05 边缘平滑「仅色块边界」实测）。正确口径（与 `pixelDataProcessor.processPixelData` 一致）：先取图层实时 bounds（`layer.bounds`，滤镜可能改变它，要在滤镜之后再取）→ 只请求「需要区域 ∩ 图层 bounds」→ **source 尺寸与 targetSize 严格 1:1** → 再按文档坐标摆进大缓冲。另：`getPixels` 返回尺寸可能被 UXP 取整/裁剪，解析一律用 `imageData.width/height`，并守卫 `raw.length === w*h*4 || w*h*3`，否则返回 null 而不是写脏数据。透明像素不计入图层 bounds，写透明不会撑大图层。
- ⚠️ **历史记录压缩**：一串 batchPlay（全选/复制图层/滤镜/删除图层/选回原层）+ putPixels 会各自留一条历史项。把整段包进 `doc.suspendHistory(async()=>{...}, '名称')` 即可合并为一条（可嵌套在 `executeAsModal` 内，见 `knockoutBatchProcessor.runKnockoutBatch`）。若内部 `applyProcessedPixels` 也自带 suspendHistory，需传 `{ skipHistorySuspend: true }` 跳过，避免嵌套多出第二条。
- ⚠️ **UXP `storage.formats` 只有 `binary` / `utf8`，没有 `base64`**。任何 `file.read({format: formats.base64})` 都是 undefined，且 `file.read({format:undefined})` 不报错、静默按 UTF-8 解码返回乱码字符串（不是抛异常），用来拼 data URL 必黑屏。读图转预览一律 `file.read({format: formats.binary})` 取 ArrayBuffer → `btoa`。这是 2026-09-05 图案面板新加载全黑回归的根因。

## 像素算法架构（2026-09-05 定稿）
- ⚠️ **lineSmoothProcessor（仅主线条，SDF）：全局量绝不能被选区截断**。lineMask/SDF/strokeAlpha 一律全图计算，选区只决定「写回范围」；跨选区边界的邻居判定用 effAlpha（选区内=平滑结果、选区外=原值 alpha，即「实际最终输出」）。四环（lineMask/SDF/Phase C/Phase D+E 邻居判定）任一被 sel 截断 → 选区边缘一圈像素被误删（透明环，2026-09-05 用户实报）。binaryOpen 等形态学必须全范围循环+越界邻居跳过，否则画布边缘 r px 条带整体被挖空。
- edge 模式参数已精简至 mode/edgeMedianRadius/lineSmoothStrength/lineSmoothRadius 四字段；旧预设字段（backgroundSmoothRadius/linePreserveDetail/lineStrength/lineWidthScale/lineHardness 等）已从接口与面板 state 全删，不再兼容。PanelStateManager.ts 里 toggles.preserveDetail（加权平均）与 highFrequencyEnhancer 的 intensity 是别的功能的同名物，勿误删。

## 通用组件 CSS 单一来源（common.css）
- index.tsx 顺序：uxpPerfPatch→common→app→license。common.css 严禁 @import。已收口：滑块块/标签档/range-slider/数字输入+单位/input appearance/图标按钮/按钮族/主标题(.main-title 去 border-bottom 改 .divider)/开关行/radio/checkbox/折叠区/通知区/滚动条/拖拽光标锁。
- .panel(外壳：padding:10+overflow-y:auto+min-height:0) 与 .panel-section(区块：row 布局，label+控件同行；列布局加 .panel-section--col) 全插件通用。
- ⚠️ **状态样式集中区（2026-09-06 定稿）**：所有禁用/hover/active/选中/多选/dragging/drop-target 规则统一放 common.css **文件最底部**「通用状态样式（集中管理区）」（分 悬停按下/禁用/选中/拖拽交换 四小节）；基础样式留在各组件段。新增状态规则一律进该区，不改别处。状态类只写修饰差异，盒模型必须与基础类共享（否则切换瞬间塌陷）。
- ⚠️ **一切「选中/落点」视觉一律 border 变化，禁 outline（UXP 无 outline-offset 且 outline 需基线才可见）**：需要状态描边的元素基础类挂 `border:1px solid/dashed transparent` 占位，状态类只变色 → 零位移。.hotkey-entry-row/.mask-sync-task-name 均已如此（2026-09-06：selected 只写 outline-color 但无基线=完全无效，用户实报）。
- 通知体系定稿：`.status-banner`=通用通知横幅（顶部激活卡片 license-status-banner-* 只剩状态配色 + 笔刷热键底部 + 蒙版同步内部，三处共同挂载；**min-height:30px 不写死 height**，换行时容器增高保边距）；`.notify-bar`=单行状态条（引擎状态/快捷键服务状态，挂 notify-bar-ok/warn/fail 状态描边）；`.notify-text` 全项目**唯一定义**（12px/可换行/word-break）。勿再起 notify-banner 之类近似名。
- Select.tsx 态类是独占类名(head-open/head-disabled/opt-sel/opt-dis 不含基础类)，基础样式须三态共享组(.head,.head-open,.head-disabled 合写)否则展开退化成块。
- ⚠️ **UXP 弹窗用 `core.showAlert({message})`（PS 原生弹窗）；`dialogs.alert`（uxp 模块）在 PS 里只打印 UXP 控制台、界面无弹窗**（2026-09-06 实测）。且若跨分区注册回调（如笔刷热键分区的 handler），分区折叠=组件未挂载=回调为 null → 必须在 bridge 层兜底（参考 HotkeyBridge.requestRepairKeyboard 无 handler 时直接 shell.openPath 修复脚本）。

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
- daemon 重编：SDK 8.0.424 已装于 `C:\Users\Administrator\.dotnet-sdk`（**用户要求永久保留，绝不删 SDK/安装包**）；编译命令与 Git Bash 环境变量坑（NuGet path1 null / ProgramFiles(x86) 须 env 前缀 / System32 tar 解 zip）见技能 dotnet-publish-windows（~/.workbuddy/skills/）。编译后用户在面板停止→启动快捷键服务换版。
- ⚠️ UXP `shell.openPath` 受 manifest `launchProcess.extensions` 扩展名白名单管控：已声明 `[".exe",".bat",".cmd",".ps1",""]`（""=开文件夹）。改任何 openPath 目标类型前先核对白名单。前端改完必须 UDT Reload/重启 PS 才生效，UXP 不热更新 bundle。
- 一键修复链路定稿（2026-09-06）：菜单→requestRepairKeyboard→openPath **FixKeyboard.exe**（UXP openPath 对 .bat/.ps1 只「编辑器打开」不执行，.exe 才真跑；bat 仅双击兜底）→exe 唤起同目录 fix-keyboard.ps1；openPath 失败则 core.showAlert+打开脚本目录；CMD 15 秒自动关；日志 %TEMP%\jwautofill_fixkeyboard.log。反馈一律 core.showAlert（dialogs.alert 在 PS 里只进 UXP 控制台）。
- ⚠️ **键盘冻结分两类，修法相反（2026-09-06 定性）**：①钩子层=LL 钩子线程被阻塞 I/O 卡死 → 杀 daemon 即恢复，重插键盘无效；②设备层=HID 中断管道卡死/USB 选择性挂起唤醒失败 → 软件层全正常、钩子全释放仍打不了字，**只有重插键盘（重新枚举设备）才恢复**。修复脚本必须同时覆盖两类。daemon 只有钩子+WebSocket、无设备 I/O，设备层冻结非它肇因。
- fix-keyboard.ps1 已扩 7 步（dist 同步哈希校验）：0=自提权（ps1 内 param([switch]$JwElevated)+IsInRole，非管理员 Start-Process -Verb RunAs 重跑自己，JwElevated 防 UAC 死循环；exe/bat/直跑三入口通用，exe 无需重编）；6=pnputil /restart-device 程序化重插（键盘 COL01→USB&MI_xx→复合父逐层重启、跳过 ROOT_HUB；pnputil 需 19041+，本机 Win11 25H2 可用；退路 Disable→Enable 用 finally 保证重新启用）；7=关 USB 省电（WMI MSPower_DeviceEnable **Win11 25H2 返回 0 实例是坑**→退注册表 HKLM\SYSTEM\CurrentControlSet\Services\USB DisableSelectiveSuspend=1 重启生效；powercfg 选择性挂起 GUID 2a737441…/48e6b7a6… AC+DC=0 立即生效）。脚本结尾明示「仍不能输入=硬件/接口层」。
