# JWautofill 项目长期记忆

## 提交约定（硬性，2026-08-29 起）

- 每次 commit 必须包含 `.workbuddy/memory/` 下所有记忆与日志。该目录已被 git 跟踪，`git add -A` 即可，但提交前务必确认其改动已纳入本次 commit。

## UXP / React 关键坑

- `action.addNotificationListener / removeNotificationListener` 首参必须是**字符串数组**（`['set','select','clearEvent','delete','make']`），传字符串会抛 `Argument 1 has an invalid type` 并监听静默失败。范例 src/app.tsx。
- **React 19 dev 构建在 UXP 不能渲染**：渲染流程调用 `performance.mark/measure(name,{detail})`，UXP 的 Performance 不支持对象 options 且 measure 要求起点 mark 已注册 → 首次渲染抛 `The mark [object Object] does not exist` → root 状态残留 → 之后全部渲染报 `Should not already be working.` 面板白屏。**解法**：入口最优先 import `src/uxpPerfPatch.ts`（容错包装 mark/measure/clearMarks/clearMeasures）。Production 构建无此问题。
- 加载产物：`yarn build`（production）最稳；`yarn watch`（dev）有 patch 兜底可用，但 PS 端需手动重新加载插件。
- 仓库统一 LF（.gitattributes `* text=auto eol=lf` + `*.otf binary`）；行符不一致会引起 UXP 热重载竞态。

## 面板结构

- 入口 src/index.tsx：`#app`（App 主面板）+ `#pixeladjustment`（AdjustmentPanel）；菜单在 MenuManager.setup()。
- 蒙版同步引擎 src/utils/MaskSyncEngine.ts（单例，事件驱动 + 2s 兜底轮询，按文档名持久化 mask-sync-state.json）。

## 算法要点（细节见各源文件与 analysis/ 原型）

- **分块补色 blockColorPatchProcessor.ts**（v5，2026-08-22）：同层/分层兼顾。**距离语义坑**——cand 约束必须用 `distanceToMask`（掩码内=0），不能用 `distanceToBackground`（背景=0）；Python 原型验证时禁用 `if good==fill: continue`（ground truth 作弊）。**R 不能排除线稿描边**（尖角头部在描边内）。指标：补全区 100% / 背景 ~99% / 尖角 100%。
- **线条平滑 lineSmoothProcessor.ts**：**「保留原值」写回陷阱**——Phase E 里 `na==0` 不写会保留原值防主线被打成孔洞，但也会把原图游离杂点原样写回。**任何"清除某类像素"的逻辑必须显式清零**。杂点 = 对原 lineMask 做 8 连通域，面积 <10 且不与主线条连通。测试指标须单独统计「原杂点是否存活」（只统计新增像素的指标检测不到）。
- **扣白/扣黑 knockoutBatchProcessor.ts**（2026-08-26 重构 batchPlay 版）：核心 = 合并图 Ctrl+点 RGB 复合通道载入亮度选区 → Delete（alpha *= 1−亮度）→ 复制 N 份合并（alpha 按 1−(1−a)^N 增强）。**像素级无法还原原图层（欠定）**，实质是"放回原背景视觉一致"。**扣黑必须反色法**：Z → Invert → 扣白流程 → Invert，份数 N = ceil(ln0.005 / ln(1−aMin))，aMin = 选区灰度对应 alpha 的 5% 分位，clamp [3,40]。batchPlay 速查：通道选区 `{_obj:'set',_target:[{_ref:'channel',_property:'selection'}],to:{_ref:'channel',_enum:'channel',_value:'RGB'}}`；Delete `{_obj:'clear'}`；反色 `{_obj:'invert'}`（只反 RGB 不动 alpha）；复制+向下合并用 UXP DOM `Layer.duplicate()/Layer.merge()`（比 batchPlay mergeLayers 稳）。适用性由对比度决定（信息论极限）：扣白适深/中色，扣黑适浅/中色。

## Windows 守护进程 / 全局热键（2026-08-29）

- **C# `System.Text.Json` 默认大小写敏感**：UXP 推小写 JSON 键到 PascalCase 属性会静默全空 → 跨端通信必须 `JsonSerializerOptions{CamelCase, CaseInsensitive=true}`。
- daemon 是无窗口 console，Console.WriteLine 全被吞；排查配置路径类 bug 用前台重定向 stdout + analysis/hotkey/ws_raw_test.mjs（原始 TCP WS 客户端）。
- daemon Broadcast 曾硬编码单字节帧长（>125B 发坏帧），已统一走 SendToClient。
- 面板通过 `getPluginFolder` 定位文件：dist 必须由 webpack 拷入 daemon 脚本/exe，copy-webpack-plugin 的 glob `from` 需配 `to:[name][ext]`。
- 会话沙箱会回收后台子进程（Start-Process/setsid/schtasks 都不持久），需用户点「安装守护进程」或重启（HKCU Run 自启）；schtasks 在安全策略黑名单。
- **RegisterHotKey 不能挂在 message-only window（HWND_MESSAGE）**：注册成功返回 true，但 WM_HOTKEY 永不派发 →「注册成功、按下无反应」。**推荐：常驻 WH_KEYBOARD_LL + 内存组合键表**，命中后 `return (IntPtr)1` 吞掉按键（宿主 PS 不再抢该快捷键），也不存在「注册冲突=静默失效」。
- 钩子必须由承载线程自己 SetWindowsHookEx（别的线程 PostThreadMessage 通知它安装会失败——线程消息队列在首次 GetMessage 前不存在）；**PostThreadMessage 的线程消息不进 WndProc**，必须在 GetMessage 循环里按 `msg.hwnd==IntPtr.Zero` 显式处理。
- **钩子回调里绝不能做网络 I/O，也不能做同步文件 I/O**（含 `Console.WriteLine` 写日志）：前者超时被系统静默摘钩，后者卡顿会冻结整个低层键盘钩子（表现「日志停更、按键全无反应」）。正确做法：回调只 Enqueue + PostThreadMessage，主线程出队后做日志与广播。
- Windows 脚本坑：`System.Diagnostics.Process` 没有 `Stop()`（用 `Stop-Process -Id`，否则进程残留锁住日志文件）；`Start-Process` 在环境同时存在 `Path`/`PATH` 键时崩；`Read-Host` 非交互时抛异常需 try/catch；删除刚被进程占用的目录要重试；**.ps1 必须纯 ASCII**（WinPS 5.1 无 BOM 按 GBK 读，中文注释致语法错误）。

## 跨面板热键通讯（2026-08-30，重要）

- **UXP 多 entrypoint 共用同一个 `main: index.html` → 同一 bundle / 同一 JS 世界**。因此：①模块级单例（HotkeyBridge、MainToggleBus）在所有面板间共享；②但「注册面板内回调再被另一面板调用」不可靠。
- **致命坑：`connectHotkeyDaemon()` 被多处调用会建出多条 WebSocket**。守护进程向所有客户端广播，同一条 toggleMain 被投递 N 份，N 次「读-改-写」翻转在 await 间竞态读到同一旧值 → 互相抵消 → 表现「按下有提示、主开关不动」。
  **规则：`connectHotkeyDaemon` 必须幂等（引用计数，同上下文只一条连接）。**
- **主开关跨面板同步解法**：用插件数据目录 `settings/main-toggle.json` 作共享状态（rev 递增 + token 幂等 + `requestMainToggle` 串行锁），App 面板 `subscribeMainToggle` 订阅应用；热键只翻转共享状态，不直接调面板回调。`registerMainToggleHandler` 已废弃。
- 提示文字必须反映真实结果（已开启/已关闭），不能无条件显示「已切换」。

## 笔刷热键 & 蒙版同步 UI 约定（2026-08-30）

- **"主题色"的准确定义 = `var(--text-color)`**（深色主题白 / 浅色主题黑），**不是**固定蓝 `var(--primary-color)`。
- **图标按钮**：`.hotkey-icon-button`（刷新/删除/同步）与 `.hotkey-circle-button`（录制/停止）均**无边框无背景**纯图标，色用 `--text-color` / `currentColor`。**hover 统一 APP 齿轮风**（src/styles/pattern.css 的 `.icon-button:hover`）：`color: var(--hover-icon)`（蓝）+ `.icon-fill { fill: var(--hover-icon) }`，**背景不变**（不要 `background-color: var(--hover-bg)`）。
- **禁用态通用写法**：加 `.disabled` → `color: var(--disabled-color)`（#848484，与 APP 总开关 `sp-switch[disabled]` 一致）+ `cursor:not-allowed` + **在 onClick 里拦截**（div 无原生 disabled）；`.icon-fill` 也要灰。录制中（`.recording`）hover 仍红 `#ef5350`，优先于 disabled。
- **录制/停止键**：`RecordCircleIcon`（实心圆）+ `StopSquareIcon`（**方形** stop，用户嫌圆形 stop-circle 不和谐），各 16px，无文字无边框；录制中圆点变红 `#ef5350`；未选笔刷时禁用灰。
- **图标组防位移固定布局**：`.hotkey-icon-group`（`flex:0 0 auto`）+ 3 个 `.hotkey-icon-cell`（各 `flex:0 0 28px`，按钮格内居中），顺序 **刷新 | 停止 | 录制**，录制键恒在最右格。**停止键不再条件渲染**——始终占用中间格（未录制时 `.disabled` 灰显），刷新与录制零位移、三者间距恒定。`BrushSelect` 传 `style={{ flex:'1 1 auto', minWidth:0 }}` 撑满剩余宽度把图标组顶到最右。
- **快捷键条目（现行版）**：`.hotkey-entry-row` 内只留【快捷键 `.hotkey-entry-combo`(110px 定宽) 丨 `.hotkey-entry-sep` 丨 名字 `.hotkey-entry-name`(flex:1, text-align:right)】，名字独占剩余宽度（"选区填充开关"六字不再截断）。**所有条目装进 `.hotkey-entry-box`（边框可见大容器，风格同 `.mask-sync-task`：border + radius 8 + padding + bg）**；列表自身 `.hotkey-entry-list` 在外框内、外间距由 box 提供。删除键移到容器外 `.hotkey-entry-actions`（`space-between`：**「已选中 N 条」左对齐**、删除键最右）。
- **列表容器通用布局原则（新，2026-08-30 第八轮确立）**：①**上下边距相等**——box 用对称 padding，首行上边距归零（仅后续行 `margin-top`），使「首条上边↔框上边界」与「末条下边↔框下边界」距离相等；②**横竖分割线颜色一致**——纵向 丨 `.hotkey-entry-sep` 与横向行分割线、外框全部用同一 `--border-color`，不要各自用不同色/透明度；③**选中态零位移**——用 `outline:2px solid transparent; outline-offset:-2px`（`.selected` 时 `outline-color:var(--primary-color)`），不要再用 `border:2px solid transparent`（会与横向 `border-bottom` 分割线冲突导致位移/描边错位）。
- **条目选中态 = 图案子面板风格**：参考 `.photo-container.selected` → `border: 2px solid var(--primary-color)`；为防位移，常态行写 `border: 2px solid transparent`，选中只改 `border-color`。**多选逻辑对齐 PS 原生图层**：普通单击=单选并把锚点设为该条；Ctrl/Meta+单击=对该单条加选/减选（toggle）并刷新锚点；Shift+单击=选中「锚点~当前」之间所有记录（含两端），锚点不变可继续延伸。锚点用 `anchorIndexRef`（基于 `entries` 当前顺序索引），`useEffect([entries])` 剔除已消失的选中项。
- **重录选中单条（始终可见）**：「重录」图标按钮（`DataRefreshIcon`，PS「S DataRefresh 18 N」，`currentColor`/14px，无边框 `--text-color`）**不再条件渲染**——始终显示在「已选中 N 条」与删除键之间；仅当 `selectedIds.length===1 && !recording && daemonConnected` 时可点，否则 `.disabled` 灰显（title 提示"选中单条快捷键后可重录"）。`reRecordEntry()`：对选中条记录的笔刷或选区填充开关直接发起新录制（主开关占位 `__MAIN__`，回传 combo 后 `setMainToggleCombo`；笔刷则 `entries.map` 改该条 combo + `pushConfig`），无需回上方下拉再选；重录前检查新 combo 是否被其它记录（含主开关）占用，占用则放弃并提示。
- **刷新图标已换 PS「S Refresh 18 N」**：下拉右侧刷新按钮的 `RefreshIcon` 改为双向环形箭头（`.fill`→`currentColor`），与同步/删除同色系（--text-color / hover 蓝）。
- **批量删除顺序坑**：笔刷条目走 `setEntries+pushConfig`；主开关条目只能 `setMainToggleCombo('')` 解绑（不能删）。**必须先删笔刷再解绑**——`pushConfig` 会同步 bridge 的 `cachedConfig`，而 `setMainToggleCombo` 基于 `cachedConfig` 重建，顺序反了会把刚删的条目复原。
- **状态色（与指示灯一致）**：笔刷热键区底部 `message` 颜色随 `daemonConnected`——已连接 `#2ecc71`（= `.mask-sync-status-dot.ok`）、断开/未加载 `#f39c12`（= `.warn`）。
- **蒙版同步容器结构（最终版）**：引擎状态条 `.mask-sync-status-bar`（自带 border）在最上方、容器 A 之外；容器 A = `.mask-sync-card-list`（border+radius 8+padding 8+bg）只裹 `.mask-sync-task` + `.mask-sync-add-row`；**不再套任何有边框外层**（已弃用 `.adjustment-section` 包裹，它带 border+限宽 280px 且被 4 分区共用不可改），改 `.mask-sync-section`：`border:none;padding:0;width:100%`（与笔刷热键通栏等宽）。容器 A 与 `.hotkey-entry-box` 同盒模型；卡片间距 6px、`.mask-sync-empty` 移入容器内、状态条 padding 8px 与卡片左对齐。⚠️ 教训：改分区外观前务必确认元素挂的**全部**类名（曾误删容器 A、误以为 `.mask-sync-section` 无边框实则挂 `.adjustment-section`）。
- **蒙版同步「立即同步」禁用条件**：`!task.sampleLayerId || !task.channel || !task.targetLayerId`。

## 主开关联动选项（2026-08-30）

- 主面板底部选项区（`.bottom-options`，src/app.tsx）新增两个 checkbox 开关，**持久化于 `settings/panel-state.json`（PanelStateManager 的 appPanel）**，默认均为 `false`（opt-in）。字段：`switchToLassoOnEnable`、`autoOffOnOtherTool`（AppState/initialState/PanelStateManager.AppPanelState 三处都要加，并在 `componentDidMount` 的 initialize 默认值 + load 合并、以及 `componentDidUpdate` 的 watchedKeys + update 中同步）。
- **选项一 `switchToLassoOnEnable`（开启后切套索）**：主开关 **关闭→开启** 的瞬间自动切到套索工具。
  - 切工具写法必须**先直连 `action.batchPlay`，失败再回退 `core.executeAsModal`**（与 `HotkeyBridge.applyBrush` 同款）。⚠️**曾踩坑**：旧实现只直连、未带模态回退，某些 PS 状态下直连抛 "command not available" 被 `catch` 静默吞掉 → 工具没切、表现「没实现」。
  - descriptor 用用户给定：`{_obj:'select',_target:[{_ref:'lassoTool'}],dontRecord:true,forceNotify:true,_isCommand:false}`，`batchPlay` 选项 `{synchronousExecution:true}`。
  - 触发收敛点：`handleButtonClick`（点开关）与 `subscribeMainToggle` 回调（热键/其它面板翻转）都调用同一私有方法 `onMainToggleChanged(prev,next)`；仅在 `next && !prev` 时切套索，且开关已 setState 为新值，故不会重复切。
  - 套索 `lassoTool` **不在**选项二的「其它工具」列表里，所以切套索不会反向触发选项二自动关闭。
- **选项二 `autoOffOnOtherTool`（切其它工具即关）**：主开关**开启**时，若 `handleNotification` 收到 `select` 事件且解析出的工具属于列表（paintbrushTool/pencilTool/eraserTool/wetBrushTool/bucketTool/gradientTool/moveTool/smudgeTool），则 `autoTurnOffMain()` 关闭主开关并同步 PanelStateManager + MainToggleBus。
  - 工具判定：`resolveSelectedTool(descriptor)` 解析 descriptor `_target`，仅当确为工具选择（_ref==='tool' 取 _value，或 _ref 以 'Tool' 结尾）才返回，避免普通 select 事件误触发。
- **UI 位移**：「更新历史源」那一行（含其 checkbox）整体 `marginLeft:-2px` 左移 2px；`.bottom-options` 已加 `flex-wrap:wrap;gap:4px 10px` 容纳 4 个选项不溢出。
- 这两选项本质是「主开关的联动偏好」，存 panel-state.json（与 deselectAfterFill/autoUpdateHistory 同级），**不要**放进 MainToggleBus 的共享文件（那是跨面板的主开关状态本身）。
