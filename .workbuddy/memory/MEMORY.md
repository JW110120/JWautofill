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

### UI 约定（笔刷热键 & 蒙版同步）
- 主题色=`var(--text-color)`；图标按钮无边框无背景纯图标，hover 蓝；禁用态 `.disabled`→`color:var(--disabled-color)`+`cursor:not-allowed`+onClick 拦截；录制中红 `rgb(239,83,80)` 优先。
- 蒙版同步：`status-bar` 在容器外；卡片列表只裹 task+add-row；状态色 已连 `rgb(46,204,113)`/断开 `rgb(243,156,18)`。

### 架构/结构规范
- 入口 `src/index.tsx`：`#app`+`#pixeladjustment` 同文档同 bundle；`MenuManager.setup()`；蒙版同步引擎 `MaskSyncEngine.ts` 单例。
- 底部 checkbox 区（app.tsx）：4 项；`switchToLassoOnEnable`/`autoOffOnOtherTool` 持久化 `settings/panel-state.json`，默认 false opt-in。
- 主开关联动：切套索先直连 `action.batchPlay` 失败再回退 `core.executeAsModal`；两选项存 panel-state.json，勿放 MainToggleBus。
- 提交约定（硬性）：每次 commit 必须 `git add -A` 纳入 `.workbuddy/memory/` 全部记忆与日志。

## 二、避坑指南

- **UXP/React**：`addNotificationListener` 首参须字符串数组；React19 dev 白屏→入口最优先 import `uxpPerfPatch.ts`；仓库统一 LF；`.info-plane` 须 `position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:250px;height:20px;z-index:2000`；元素凭空消失先查祖先 `max-height`/`overflow:hidden`。
- **算法**：分块补色 cand 用 `distanceToMask`；清像素须显式清零；扣白/扣黑公式与 N 计算见历史日志。
- **Windows 守护进程/全局热键**：C# `System.Text.Json` 须 CamelCase+CaseInsensitive；钩子回调只 Enqueue+PostThreadMessage，绝不网络/同步 I/O；`.ps1` 纯 ASCII；会话沙箱回收后台子进程需 HKCU Run 自启。
- **跨面板热键**：`connectHotkeyDaemon()` 须幂等；主开关跨面板用 `settings/main-toggle.json` 共享，热键只翻共享态不直接调回调。
- **批量删除顺序**：先删笔刷条目（setEntries+pushConfig）再解绑主开关（setMainToggleCombo('')），反序会复原已删条目。
- **sp-menu 不可 CSS 改背景** → 一律用自绘 Select，勿再引入 sp-picker。
