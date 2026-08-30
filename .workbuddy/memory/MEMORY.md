# JWautofill 项目长期记忆

## 提交约定（硬性）
- 每次 commit 必须包含 `.workbuddy/memory/` 全部记忆与日志（已被 git 跟踪，`git add -A` 即可，提交前确认其改动纳入）。

## UXP / React 关键坑
- `action.addNotificationListener/removeNotificationListener` 首参必须字符串数组 `['set','select','clearEvent','delete','make']`，传字符串静默失败。
- React 19 dev 在 UXP 白屏（performance.mark/measure 不支持对象 options）→ 入口最优先 import `src/uxpPerfPatch.ts` 容错包装。Production 无此问题。`yarn build` 最稳，`yarn watch` 有 patch 兜底。
- 仓库统一 LF（.gitattributes）；行符不一致引 UXP 热重载竞态。
- `.info-plane`（版权条）必须 `position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:250px;height:20px;z-index:2000` 才紧贴面板底部。
- 排查「元素凭空消失」优先查祖先 `max-height`/`overflow:hidden`。

## 面板结构
- 入口 src/index.tsx：`#app` + `#pixeladjustment`；菜单 MenuManager.setup()。蒙版同步引擎 src/utils/MaskSyncEngine.ts（单例，事件+2s 轮询，按文档名持久化）。

## 底部 checkbox 选项区（src/app.tsx）
- 结构：`.bottom-options` > `.checkbox-main-container`(height:120) > 2× `.checkbox-column` > 各列 `.checkbox-label-container` + `.checkbox-input-container`（标签与勾选分容器、space-around 对齐）。4 项：取消选区/更新历史源（左列）、开启后切套索/切其它工具即关（右列）。
- handler：`toggleDeselectAfterFill`/`toggleAutoUpdateHistory`/`toggleSwitchToLassoOnEnable`/`toggleAutoOffOnOtherTool`。
- `switchToLassoOnEnable`、`autoOffOnOtherTool` 持久化于 `settings/panel-state.json`（PanelStateManager.appPanel），默认 false、opt-in；字段需三处同步（init 默认+load 合并、componentDidUpdate watchedKeys+update）。`deselectAfterFill`/`autoUpdateHistory` 同级各自管理。
- 选项二「其它工具」判定：`resolveSelectedTool` 仅当确为工具选择才返回，避免普通 select 误触发。

## 主开关联动（UXP）
- 切套索必须 先直连 `action.batchPlay` 失败再回退 `core.executeAsModal`；descriptor `{_obj:'select',_target:[{_ref:'lassoTool'}],...,_isCommand:false}` + `{synchronousExecution:true}`。收敛点 `onMainToggleChanged(prev,next)` 仅 `next&&!prev` 切。
- 两选项存 panel-state.json，**不要**放 MainToggleBus 共享文件。

## 算法要点
- 分块补色：cand 约束用 `distanceToMask`（掩码内=0）非 `distanceToBackground`；R 不排除线稿描边。
- 线条平滑：清除某类像素必须显式清零（"保留原值"会写回原杂点）。杂点=原 lineMask 8 连通域面积<10 且不连通主线。
- 扣白/扣黑：合并图 Ctrl+点 RGB 通道载亮度选区→Delete(alpha*=1−亮度)→复制 N 合并(alpha 1−(1−a)^N)。扣黑用反色法，N=ceil(ln0.005/ln(1−aMin)) clamp[3,40]。DOM 复制合并用 `Layer.duplicate()/merge()`。

## Windows 守护进程 / 全局热键
- C# `System.Text.Json` 需 `CamelCase+CaseInsensitive` 否则跨端全空。
- 推荐 WH_KEYBOARD_LL + 内存组合键表，命中 `return (IntPtr)1` 吞键；RegisterHotKey 挂 HWND_MESSAGE 不派发 WM_HOTKEY。
- 钩子回调只 Enqueue+PostThreadMessage，绝不网络/同步文件 I/O（会摘钩/冻结）。钩子须承载线程自身 SetWindowsHookEx。
- 会话沙箱回收后台子进程；需用户点「安装守护进程」或 HKCU Run 自启。
- `.ps1` 必须纯 ASCII；`System.Diagnostics.Process` 无 Stop() 用 `Stop-Process -Id`。

## 跨面板热键通讯
- 多 entrypoint 共用 `main:index.html`→同 bundle/JS 世界；模块级单例共享，但跨面板调面板内回调不可靠。
- `connectHotkeyDaemon()` 必须幂等（引用计数），否则多 WS 竞态使主开关翻转抵消。
- 主开关跨面板用 `settings/main-toggle.json`（rev 递增+token 幂等+串行锁）共享；热键只翻共享态不直接调回调。

## 笔刷热键 & 蒙版同步 UI 约定
- 主题色 = `var(--text-color)`（非固定蓝）。图标按钮无边框无背景纯图标，hover 蓝（`.icon-fill` 同步），背景不变。
- 禁用态 `.disabled`→`color:var(--disabled-color)`+`cursor:not-allowed`+onClick 拦截；录制中红 `#ef5350` 优先。
- `.hotkey-icon-group`(flex:0 0 auto)+3 `.hotkey-icon-cell`(28px) 顺序 刷新|停止|录制；停止键恒占中格。
- 快捷键条目装 `.hotkey-entry-box`（border+radius8+padding）；选中态用 `outline:2px solid transparent;outline-offset:-2px`（`.selected` 改色），零位移。多选对齐 PS 图层（单击单选/Ctrl toggle/Shift 区间）。
- 重录图标 `DataRefreshIcon` 始终可见，仅单条选中+非录制+已连时可点。
- 蒙版同步：`.mask-sync-status-bar` 在容器 A 外；容器 A `.mask-sync-card-list` 只裹 task+add-row；`.mask-sync-section{border:none;padding:0;width:100%}`。状态色 已连 `#2ecc71`/断开 `#f39c12`。

## 批量删除顺序坑
- 先删笔刷条目（setEntries+pushConfig）再解绑主开关（setMainToggleCombo('')）；反序会复原已删条目。
