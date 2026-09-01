# JWautofill 项目长期记忆

## 一、设计规范
### 颜色（硬性约定）
- 禁止 HEX，一律 rgb()/rgba()；走 theme.ts 主题变量，禁止硬编码。核心变量：`--bg-color`(面板背景) / `--text-color`(文字，主题色非固定蓝) / `--entry-bg`(行/卡片背景) / `--border-color` / `--disabled-color` / `--primary-color`(恒定 `rgb(38,128,235)`) / `--hover-bg`(主色 10~35% 透明) / `--button-bg` / `--dropdown-bg-color`(四主题固定 darkest `rgb(32,32,32)`/dark `rgb(57,57,57)`/light `rgb(218,218,218)`/lightest `rgb(255,255,255)`) / `--link-color` / `--notify-{ok,fail,warn}-{fg,bg,border}`。
- **遮罩配色定稿**：不透明度恒 0.80，主题只调深浅——`darkest rgba(0,0,0,.80)` / `dark rgba(29,29,29,.80)` / `light rgba(92,92,92,.80)` / `lightest rgba(128,128,128,.80)`。字面 rgba 写进 `theme.ts` 末尾 `.license-dialog-overlay,.adjustment-lock-overlay{background-color:…}` + `@media` 块，**绝不用 `var(--overlay-scrim)`**（UXP 动态注入 var() 解析不稳→声明被丢）。
- **面板命名**：`com.listen2me.jwautofill`=选区填充主面板(`src/app.tsx`)；`com.listen2me.pixeladjustment`=绘画工具箱(`src/adjustments/AdjustmentPanel.tsx`)。「主面板」=选区填充面板。

### LicenseDialog & 授权横幅（2026-08-31 定稿）
- 激活弹窗：遮罩 `padding:10px` + 卡片 `width:100%`（面板250→卡片230，上/左/右恒10px）；按钮用原生 `<button class="license-btn">` 对齐全局 button 规则，全宽32px；间距一律 margin 不用 flex gap；标题14/600 vs 正文12；卡片圆角3px（对齐 `.slider-container`）。
- **「联系作者」链接**：必须用可点击 `<span role="button">` 绝不用 `<a>`（UXP 强制 `<a>` 用自带链接色、作者 color 被忽略、深色回退暗蓝，`<span>` 文字色才受控）；颜色字面 `rgb(38,128,235)` 四主题统一，组件 `<style>` 内**仍不得用 `var()`**；容器不设 opacity（连带压暗链接），仅普通文字 `.license-contact-dim{opacity:.7}`；外链 `shell.openExternal`；下划线用 `border-bottom`。
- **`.license-status-banner` 永远留普通文档流**，绝不塞进 `position:fixed` 遮罩（fixed 包含块比内容区宽、右缘被滚动条压住补不回）→ 宽度定稿 `width:100%`。
- 锁定遮罩 `.adjustment-lock-overlay` 从卡片下方开始：JSX 内联 `top:46px`/`height:calc(100% - 46px)`（无卡片 top:10px）；基础 CSS 只留 left/right/bottom/width/z-index。

### 双面板授权状态同步（2026-08-31 定稿）
- `LicenseManager.getLicenseState()` 带记忆化（`stateCache` 静态 Promise，同 bundle 共享）→ 启动弹窗与工具箱遮罩同刻出现；`saveLicenseInfo`/`clearLicense` 须置空缓存。
- 广播时机：激活/试用成功 → `saveLicenseInfo` **不广播**，由 app.tsx `handleLicenseVerified`/`handleTrialStarted` 在**弹窗关闭同刻** dispatch `license-updated`；注销 → `clearLicense` 立即广播。app.tsx `checkLicenseStatus` 完成也 dispatch 一次。
- 降低初始延迟：`computeLicenseState` 只做一次本地文件读取；两面板共享同一 Promise、同 tick 解出。

## 二、下拉/选择器
- 统一自绘 `src/components/Select.tsx`（`.mask-sync-select-*` 在 `adjustment.css`），不再用 `sp-picker`/`sp-menu`。弹层 `createPortal` 到面板根（`#app`/`#pixeladjustment`，`utils/popRoot.ts`），**绝不挂 body**。`.mask-sync-select-pop{position:fixed;z-index:99998;min-width:96px}`；选中项背景写死 `rgb(38,128,235)`（portal 子树 var() 不稳）。头部/内部用「两级类」防面板 `div>span` 规则覆盖。

## 三、架构
- 入口 `src/index.tsx`：`#app`+`#pixeladjustment` 同文档同 bundle；`MenuManager.setup()`；蒙版同步 `MaskSyncEngine.ts` 单例。
- 授权状态唯一来源 `LicenseManager.getLicenseState()`（返回 `{isLicensed,isTrial,trialDaysRemaining,expired,needsReverification}`），两面板禁用各自判定。`TRIAL_` 开头永算试用、只对 TRIAL 判过期、自动复验只对正式授权。
- 提交约定：每次 commit `git add -A` 纳入 `.workbuddy/memory/` 全部记忆与日志。
- 文案：代码称「守护进程/daemon」，用户可见统一叫「快捷键服务」。守护进程静默：exe WinExe 不弹控制台、日志落 `%LOCALAPPDATA%\JWautofill\daemon\daemon.log`、`EnsureSelfInstalled()` 自拷贝+注册 HKCU\Run。

## 四、UXP 避坑（硬限制）
- 原生 `<input>`：① `background:transparent` 绘成纯黑→input 与 wrap 同色 `--dropdown-bg-color`；② 原生绘制区恒高于 CSS 盒且 `overflow:hidden` 裁不掉→容器 32px + input 24px（上下各4px缓冲）；聚焦用 React `onFocus/onBlur` 切 `.is-focused` 勿 `:focus-within`；`appearance:none` 消 UA 异色外圈。
- `flex gap` 不可靠→一律 margin。容器 `opacity` 连带压暗子链接→只给文字降透明。
- `<a href>` 不唤起浏览器→`shell.openExternal`；自定义色链接一律用可点击 `<span role="button">`（UXP 强制 `<a>` 用自带链接色）。`text-decoration:underline` 不可靠→`border-bottom`。
- 遮罩下隐藏可编辑控件：`body.adjustment-lock-open #pixeladjustment input,textarea` / `body.license-dialog-open #app …` + `visibility:hidden!important;opacity:0!important;pointer-events:none!important`（须带 `!important`）。
- `flex` 列里固定高度卡片须 `flex:none`+`min-height`+`box-sizing:border-box` 防压缩。
- 面板禁止 `.xxx-item div{}`/`span{}` 通配后代选择器（命中自绘弹层）。
- sp-radio slot 内不行内流布局→自定义按钮绝对定位：容器 `position:relative` + 按钮 `position:absolute;right:0;top:50%`，文字 `margin-right` 让位；规则必须 scoped 绝不挂全局 `.radio-item`/`.radio-item-label`（颜色面板「计算方法」radio 复用 `.radio-item-label`，全局改会挤崩）。填充模式齿轮：`.fill-mode-group .radio-item{position:relative}` + 按钮 `margin-top:-9px`。
- **原生 number input 防越界定稿（2026-09-01 终版：容器32px+input24px缓冲）**：UXP 原生 number 绘制区恒高于 CSS 盒，CSS 高度压不掉、只决定缓冲；**绝不能让 input 撑满容器**（撑满必越界复发）。落点：主面板 `#app`(5)、描边 StrokeSetting(2)、工具箱 `#pixeladjustment`(13)、子面板(ColorSettingsPanel 1 + PatternPicker 2 + GradientPicker 2，JSX 包 `.num-input-row`；工具箱内层用 `input[type=number]` 覆盖无名输入)。单位符号一律在裁剪容器外（`.num-unit`/`.gradient-subtitle`/裸 span）。
- **产品决策：笔刷热键不支持同名笔刷**（多轮方案不可靠已回退）。绑定/切换只按 `_name`，同名只选最上方；下拉笔刷名去重 `Array.from(new Set(brushes))`，value 即笔刷名，(1)/(2) 角标已删。

## 五、算法
- 分块补色/渐变/线稿引导/alpha 对齐见历史日志；清像素须显式清零；扣白/扣黑公式与 N 计算见当日记录。

## 六、文档与 README 同步
- 重大版本更新：文档（docs/fill-guide.html、docs/toolbox-guide.html）与 README.md 必须同步（功能增删、菜单/快捷键/授权流程变更）。
- 文档为自包含 HTML（侧边栏导航+滚动高亮+卡片/表格/提示框，明暗主题），由「⋮」菜单「功能文档」经 `openPluginDoc()`（`src/utils/openDocs.ts`：`getPluginFolder().nativePath` + `shell.openPath`）在默认浏览器打开；webpack 已拷贝 `docs/` 进 `dist/docs/`。

## 七、布局算法（滑块标签/按钮宽度）—— 2026-09-01 定稿
- **滑块文字标签宽度**（APP 三面板统一）：以「2字=20px、5字=60px」线性插值，每字≈13.33px：**W(n)=20+(n−2)×13.33**（四舍五入）→ n=2/3/4/5/6 = 20/33/47/60/73px。由 `-2`~`-6` 修饰类给出（容器 `flex:none`）。三面板落地：选区填充 `styles.css` `.slider-text-2`~`-6`；图案 `pattern.css` `.pattern-slider-text-2`~`-6`；纯色 `colorpanel.css` `.colorsettings-slider-text-2`~`-6`（`SliderControl.tsx` 按 `label.length` 自动挂，-N clamp 2~6，1字按2字）。
- **工具箱按钮宽度**：**W = 字数×字号 + 20px，容器 padding:0**。普通档 height30/font13 → `13×n+20`（2→46/3→59/4→72/5→85/6→98/7→111/8→124）；紧凑档 height24/font12（守护进程状态条）→ `12×n+20`（7字→104）。落地：`adjustment.css` `.adjustment-button`(72默认)/`-lv2`(46)/`-wide`(124兜底)/`-5/6/7/8`(85/98/111/124)，`.auto`(去padding)/`.compact`(104)。AdjustmentPanel 宽按钮按字数挂精确档（8→-8、7→-7、5→-5、4→默认）。

## 八、说明文案（hover title）集中管理 —— 2026-09-01
- 所有面板 hover 说明收口到 `src/constants/helpTexts.ts`，按面板分组：`selectionFill`(app.tsx)/`adjustment`(AdjustmentPanel.tsx)/`hotkey`(BrushHotkeySection.tsx)/`gradient`(GradientPicker.tsx)/`pattern`(PatternPicker.tsx)。
- 调用处一律 `title={helpTexts.<section>.<key>}`，**禁止 JSX 内联长字符串**（多行 `●` 模板字符串致排版乱、须原生 `title` 才左对齐+`\n\n` 间隔）。多行说明在 helpTexts.ts 以 `\n\n` 拼接。
- import 路径：文件在 `src/` 下 `./constants/helpTexts`；`src/adjustments/`、`src/hotkey/`、`src/components/` 下均 `../constants/helpTexts`。
- 通用组件（IconButton/CustomSwitch/RangeSlider/Select/BrushSelect/MaskSyncSelect）的 `title={title}` 是 prop 透传勿动；只改调用处字面量。激活面板 LicenseDialog 与 ColorSettingsPanel/StrokeSetting 无静态 title，无需收口。
