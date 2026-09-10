# JWautofill 长期记忆

## 设计规范
- 禁 HEX，一律 rgb()/rgba() 走 theme.ts 主题变量（--bg-color/--text-color/--entry-bg/--border-color/--primary-color/--hover-bg/--notify-*）。遮罩 0.80 字面写，禁 var(--overlay-scrim)。
- 术语：APP(src/app.tsx) 与 AdjustmentPanel 均「父面板」；描边/渐变/纯色/图案=「子面板」(APP 内 absolute)。UXP 不支持 flex gap→一律 margin。

## 面板高度链（滚动命脉）
- APP：uxp-panel→#app→Provider(100%)→.app-root→.app-root>.panel（最外层滚动容器）→.panel-section（flex:0 0 auto；纵向须挂 panel-section--col，否则继承 flex-row）。内层滚动 .panel 已删；common.css 对 .panel>* 统一 flex-shrink:0 兜底。
- 4 子面板=同层 .panel，靠 input-fix.css `#app .panel-section ~ .panel`(absolute+z9999) 识别；子面板开时 body.secondary-panel-open 只锁 .app-root>.panel。工具箱：#pixeladjustment→.pixeladjustment-root(flex列)→.panel(min-height:0;overflow-y:auto)。
- 新增包裹层必须带高度，不可裸 height:auto 夹定高链；每层铺 --bg-color。
- ⚠️ 滚动条：**绝不能给 .panel 加 `scrollbar-gutter: stable`**（2026-09-10 用截图像素定位）。UXP 的 CSS 侧**会**照它预留 10px 槽位（实测内容盒 220px、右缘 x=230，而右侧 14 列**没有任何滚动条像素** —— 槽位预留了却没画滚动条，即用户说的「有/无滚动条的中间态」）；但 PS 宿主给原生控件（sp-switch / sp-radio 的 slot 内容）排版时**不扣**这份槽位 → 控件按「内容盒 230」摆位、右缘落到 x=240 探出 10px，被面板右缘裁掉右半截（面板高 ≈823px 时最明显）。删掉该属性 → 槽位只按需占位（无滚动条 230 / 有滚动条 220，正是设计要的两档），CSS 与宿主始终对齐。
- 反面方案：`overflow-y: scroll` 也能消除裁切（滚动条真常驻、宿主就扣位），但内容盒被钉死 220 → 无滚动条时整块内容比设计窄 10px，且与 228px 内宽链的子面板不再自洽，已废弃。`padding-right` 预留也无效（scrollport = padding box − scrollbar，加 padding 内容盒更窄）。`::-webkit-scrollbar` 在 UXP 下同样不生效。
- 为什么工具箱（#pixeladjustment）看不出这个坑：它的行都在 `.border-panel-section`（padding 10px）里，控件右缘本就内缩 10px，多出的 10px 刚好落进 padding。

## 菜单（右上角 flyout）
- `MenuManager.setup()` 里按面板 id 配 menuItems；APP 增删项要同步四处：`registerAppCallbacks` 的 callbacks 类型与赋值、`handleAppFlyout` 的 case、menuItems 数组、app.tsx 注册处的回调。
- 已有：注销激活状态 / 打开激活与试用面板 / 参数复位 / 紧凑模式（文案动态）/ 设置选区填充主开关快捷键 / 使用手册。
- 动态改菜单项：`getPanel(id).menuItems.getItem(id)` 拿项后直接改属性（label/enabled）；UXP 各版本 API 名不统一，须备 updateItem 与直接改数组两条降级。

## 紧凑模式（Compact Mode）— 5 个作用域各自独立
- `AppState.compactModes: CompactModes`（`types/state.ts` 定义 `CompactScope='app'|'color'|'pattern'|'gradient'|'stroke'`，`initialCompactModes` 全 false；`PanelStateManager.AppPanelState` 同步持久化；参数复位时保留）。⚠️ 旧的单个 `compactMode: boolean` 已废弃（存档字段名不同，无需迁移）。
- 作用域 = 选区填充父面板 + 纯色/图案/渐变/描边 4 个子面板；互不干扰，父面板的 divider 与子面板的 divider 各管各的。
- 菜单项只作用于「当前面板」（`compactScopeOf(state)`：任一子面板打开→它，否则父面板），文案动态：`${面板名}面板紧凑模式——已开启/已关闭`（面板名 app=选区填充 / color=纯色 / pattern=图案 / gradient=渐变 / stroke=描边）。改写走 `MenuManager.setCompactModeLabel()`，降级链 getItem→updateItem→直接改数组项（与 setLicenseLogoutEnabled 同款）。
- app.tsx：`toggleCompactMode()`（只翻当前作用域）+ `syncCompactModeClasses()`（把 5 个 `body.compact-{scope}` 类逐一挂/摘）+ `syncCompactMenuLabel()`；componentDidUpdate 里 compactModes 变化或当前面板切换都要重写文案。
- CSS（app.css）：父面板 `body.compact-app #app .main-title / .panel-footer / #app .app-root > .panel > .panel-section .divider`；子面板靠根节点钩子 `.subpanel-color / .subpanel-pattern / .subpanel-gradient / .subpanel-stroke`（4 个组件根 `<div className="panel subpanel-*">`）配 `body.compact-* #app .subpanel-* .divider`。
- 子面板标题栏是 `.subpanel-title-1`（带关闭按钮）不可隐藏；底部 info 条挂 `.panel-footer` 整块隐藏（只藏文字会留下该分区 15px 下外边距）。
- ⚠️ 隐藏 divider 后「清除模式」行 →「填充模式」分区的间距会变紧，需补 `margin-top: 15px`（选择器 `#app .app-root > .panel > .panel-section .divider + .panel-section`）。换算：行盒 32px（sp-switch 32px）、分区首行标签盒 22px，半个高度差 (32−22)/2 = 5px；行的外边距 10px 折叠后取 max(10,15)=15。**子面板里的 divider 后分区首个子元素是自带 10px 上边距的 .row-between，不适用该换算，必须把选择器收窄在主面板滚动区内。**


## 专注模式（Focus Mode）
- 条件：APP 父面板「自动关开关」+「自动切套索」同时勾选即成立（推导值，不额外存 state）。
- 共享：`utils/FocusModeBus.ts`（settings/focus-mode.json），跨面板同 MainToggleBus 机制；APP 面板写入、其它上下文只读。
- 行为：主开关热键「只开不关」（MainToggleBus.doToggle 分支），关闭只能靠切工具走 autoTurnOffMain；主开关圆点换星形图标（FocusStarIcon，13×13，与 indicator 同双色）；工具箱热键置顶记录文案改「选区填充」。

## UXP 避坑
- 当前工具检测：不能只靠 select 通知——切笔刷预设的通知是 {_ref:'brush'}（工具被预设间接带过去，混合器/涂抹预设还会连工具一起换）、动作回放切工具也不保证广播工具 select。可靠读法是 application.tool._enum（HotkeyBridge.getSelectedBrushToolEnum）；需要时按 300ms 轮询兜底 + 关键词 /brush|eraser|stamp|smudge/ 判定。混合器画笔内部名有 mixerBrushTool 与 wetBrushTool 两种。
- 原生 input 画最上层、overflow 裁不住→折叠分区条件渲染；数字输入 32×24、单位在容器外(.num-unit)。
- JS 测量尺寸不可靠→铺满背景用整数 px 格子过量渲染+overflow:hidden；% 小数坐标必出亚像素缝；棋盘格方块+1px 重叠盖缝、底板 inset:0+OVERSCAN。
- imaging.getPixels 把 sourceBounds 裁到图层 bounds 再重采样到 targetSize（小图层按大区域请求=拉伸）。正确：滤镜后取 layer.bounds→只请求「需要区∩bounds」→source 与 targetSize 严格 1:1；解析用 imageData.width/height 并守卫 raw.length。
- 历史压缩：batchPlay+putPixels 包 doc.suspendHistory；内部已有则传 {skipHistorySuspend:true}。
- storage.formats 只有 binary/utf8 无 base64；file.read({format:undefined}) 静默乱码，读图 binary→btoa。
- 弹窗用 core.showAlert（dialogs.alert 在 PS 只进控制台）；跨分区回调折叠即 null，bridge 层兜底。
- PS 通知事件在命令执行中途派发：监听器收到 make/delete/set 立刻 batchPlay get 会撞忙碌窗口，宿主弹「易修: 命令"获取"当前不可用」原生框，try/catch 与 dontDisplay 都拦不住。事件触发的探测必须走 psProbe.ts debouncePsProbe（200ms 防抖）延迟到命令结束后。
- sp-radio 影子布局把 slot 排行右侧：radio 行内自绘元素走文档流，勿绝对定位 pin 边缘。

## common.css 单一来源
- index.tsx 顺序 uxpPerfPatch→common→app→license；严禁 @import。滑块/数字输入/按钮/radio/checkbox/折叠/通知/滚动条均已收口。.panel=外壳(padding10+overflow)、.panel-section=区块(row，列加 --col)。
- 状态样式统一放 common.css 最底部「集中管理区」；状态类只写修饰差异，盒模型与基础类共享。选中/落点视觉一律 border 变色（基础类挂 transparent 占位），禁 outline。
- 通知：.status-banner=通用横幅(min-height:30px 不定高)、.notify-bar=单行状态条、.notify-text 唯一定义。hover title 收口 helpTexts.ts。

- 布局：标签 W(n)=20+(n-2)×13.33(2..6字)；按钮宽=字数×字号+20；数字输入 32×24、容器 `.num-input-row` 圆角 3px（2026-09-10 用户指定）。两列 radio margin 下限 40px、三列 20px。
- ⚠️ 居中 flex 行（width:100%+justify-content:center）里若两态字号不同，组宽变化会让左侧固定元素（圆点/图标）位移半个差值；文字中心反而不动，易误判。解法：文案给定宽居中槽（n 字×字号 px，flex:none），见 .main-button-label。

## 像素算法
- lineSmoothProcessor(SDF)：全局量绝不被选区截断，选区只定写回范围；跨选区邻居判定用 effAlpha（选区内=平滑结果、外=原值）。任一环截断→选区边缘透明环。binaryOpen 全范围+越界跳过。
- edge 模式参数=mode/edgeMedianRadius/lineSmoothStrength/lineSmoothRadius 四字段。toggles.preserveDetail 与 highFrequencyEnhancer.intensity 是别的功能同名物，勿误删。

## 守护进程与键盘冻结
- C#/.NET8 daemon（native/HotkeyDaemon/Program.cs）：WH_KEYBOARD_LL 独立线程；钩子线程严禁阻塞 I/O（日志 QueueTextWriter、SendToClient 走 Task.Run）；焦点闸门 IsPhotoshopForeground 否则放行。WS 127.0.0.1:18923；日志 %LOCALAPPDATA%\JWautofill\daemon\daemon.log。
- 冻结三形态与 ps1 七步详见技能 windows-keyboard-device-reset。③「按键不停重复」=设备层键卡按下态，应急先按同一键；改 ps1 后同步 dist/（exe 无哈希校验即生效）。
- shell.openPath 受 manifest 扩展名白名单管控。前端改完须 UDT Reload。
- daemon 重编：SDK 8.0.424 在 C:\Users\Administrator\.dotnet-sdk（永不删）；坑见技能 dotnet-publish-windows。

## 技能（项目级 .workbuddy/skills/）
- `uxp-frontend-spec`：UXP 前端规范（主题令牌/尺寸公式/通用类目录/状态样式/UXP 坑/新面板骨架）。新建面板或改样式前先加载；已取代并删除旧的 `uxp-themeable-dropdown`（内容并入前者）。

## Git/环境
- ⚠️ .git/refs/remotes/origin/ 曾缺失→fetch 报成功但 origin/main 不更新（假成功），status 恒显 ahead；修法 mkdir 后 git update-ref。推送用 `git -c credential.helper=wincred push`（凭据在管理器 JW110120）。
- dist/、analysis/、outputs/ 均 gitignore；入库大文件 FixKeyboard.exe(73MB)、daemon publish exe(64MB)，<100MB 上限。
