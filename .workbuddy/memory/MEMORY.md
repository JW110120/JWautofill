# JWautofill 项目长期记忆

## 一、设计规范

### 颜色（硬性约定）
- 禁止 HEX，一律 rgb()/rgba()；走 theme.ts 主题变量，禁止硬编码：
  `--bg-color` 面板背景；`--text-color` 文字（主题色，非固定蓝）；`--entry-bg` 行/卡片背景（深比 bg 浅、浅比 bg 深）；`--border-color`；`--disabled-color`；`--primary-color` 恒定 `rgb(38,128,235)`；`--hover-bg` 主色 10~35% 透明；`--button-bg`；`--dropdown-bg-color` 四主题固定值 darkest `rgb(32,32,32)`/dark `rgb(57,57,57)`/light `rgb(218,218,218)`/lightest `rgb(255,255,255)`；`--link-color` 深底亮蓝/浅底深蓝；`--notify-{ok,fail,warn}-{fg,bg,border}` 深主题亮色、浅主题深色。
- **遮罩配色（定稿）**：不透明度恒 0.80，主题只调颜色深浅——`darkest rgba(0,0,0,.80)` / `dark rgba(29,29,29,.80)` / `light rgba(92,92,92,.80)` / `lightest rgba(128,128,128,.80)`。
  **写法硬性要求**：字面 rgba 写在 `src/styles/theme.ts` 末尾 `.license-dialog-overlay,.adjustment-lock-overlay{background-color:…}` + `@media (prefers-color-scheme:…)` 块，**绝不用 `var(--overlay-scrim)`**（UXP 对动态注入 var() 解析不稳定→整条声明被丢，遮罩能拦点击却背景不绘制）。
- **面板命名**：`com.listen2me.jwautofill`=选区填充主面板(`src/app.tsx`，激活弹窗 LicenseDialog 在此)；`com.listen2me.pixeladjustment`=绘画工具箱(`src/adjustments/AdjustmentPanel.tsx`，激活横幅在此)。「主面板」=选区填充面板。

### LicenseDialog（激活/试用弹窗）
- 遮罩 `padding:10px` + 卡片 `width:100%`（面板250px→卡片230px，上/左/右恒10px）；按钮用原生 `<button class="license-btn">` 对齐全局 button 规则（`--button-bg`+`--border-color`+圆角4），全宽32px；间距一律 margin、不用 flex gap；标题14/600 vs 正文12；卡片圆角3px（对齐 `.slider-container`）。
- **「联系作者」链接**：① 必须用**可点击 `<span role="button">`，绝不用 `<a>`**——UXP 强制用自带链接色渲染 `<a>` 文字（作者 color 被忽略、深色主题回退默认暗蓝、比下划线深一截），`<span>` 文字色才完全受 CSS 控制；**`<a>` 才是致色差的根因**（2026-08-31 实测），不是 var()；② 颜色用**字面 `rgb(38,128,235)`（即 `--primary-color` 恒定值）、四主题统一**，不再分四主题写 `@media`：组件 `<style>` 内**仍不得用 `var()`**（UXP 对动态子树 var() 解析不稳、整条声明被丢，字面量等价且零风险）；③ 容器不设 opacity（连带压暗链接），仅普通文字用 `.license-contact-dim{opacity:.7}`；④ 外链 `onClick` 调 `shell.openExternal`；下划线用 `border-bottom`，勿 `text-decoration`。

### 激活横幅对齐（2026-08-31 二次定稿，推翻上一版）
- **`.license-status-banner` 永远留在普通文档流渲染，绝不能塞进 `position:fixed` 遮罩内部**：fixed 遮罩包含块比普通内容区宽（不扣滚动条），卡片进遮罩后右缘整体右移被滚动条压住，`margin-right`/`width` 都补不回来（实测 50% 宽度也异常右移）。文档流里的边距实测正确 → 宽度定稿 `width:100%`。
- 锁定遮罩 `.adjustment-lock-overlay` **从卡片下方开始**：JSX 内联 `top:46px`（容器 padding-top 10 + 卡片 30 + 下边距 6）、`height:calc(100% - 46px)`（无卡片的边缘情形 top:10px）；基础 CSS 只留 left/right/bottom/width/z-index。遮罩不装任何内容 → 无需任何 `--adjust-scrollbar-w` 补偿（该方案已废弃）。

### 双面板授权状态同步（2026-08-31 定稿）
- `LicenseManager.getLicenseState()` 带**记忆化**（`stateCache` 静态 Promise；同 bundle 共享 JS 上下文，两面板共享同一次存储读取）→ 启动时弹窗与工具箱遮罩同刻出现；`saveLicenseInfo`/`clearLicense` 必须置空缓存。
- **广播时机**：激活/试用成功 → `saveLicenseInfo` **不广播**（否则工具箱比弹窗早 800ms 解锁），由 app.tsx `handleLicenseVerified`/`handleTrialStarted` 在**弹窗关闭同刻** dispatch `license-updated`；注销 → `clearLicense` 立即广播（弹窗同 tick 打开，天然同步）。app.tsx `checkLicenseStatus` 完成后也 dispatch 一次。
- **降低初始延迟**：`getLicenseState` 的 `computeLicenseState` 只做一次本地文件读取（不再 checkLicenseStatus + isTrialExpired 读两遍），把异步延迟减半；两面板共享同一 Promise、同 tick 解出 → 初始载入时弹窗与工具箱遮罩同时出现、几乎无延迟。

## 二、下拉/选择器
- 统一自绘 `src/components/Select.tsx`，CSS `.mask-sync-select-*` 在 `adjustment.css`；不再用 `sp-picker`/`sp-menu`。弹层 `createPortal` 到面板根容器（`#app`/`#pixeladjustment`，`utils/popRoot.ts`），**绝不挂 body**（UXP 只渲染当前激活 uxp-panel 子树）。`.mask-sync-select-pop{position:fixed;z-index:99998;min-width:96px}`。选中项背景**写死 `rgb(38,128,235)`**（portal 子树 var() 不稳，勿用 `var(--primary-color)`）。头部/内部元素用「两级类」(`.mask-sync-select-wrap .xxx`) 防面板 `div>span` 规则覆盖。

## 三、架构
- 入口 `src/index.tsx`：`#app`+`#pixeladjustment` 同文档同 bundle；`MenuManager.setup()`；蒙版同步 `MaskSyncEngine.ts` 单例。
- **授权状态唯一来源 `LicenseManager.getLicenseState()`**（返回 `{isLicensed,isTrial,trialDaysRemaining,expired,needsReverification}`）：`app.tsx` 与 `AdjustmentPanel.tsx` 都必须用它，禁止各自判定。`TRIAL_` 开头永远算试用、永不正式；只对 TRIAL 判过期；自动复验只对正式授权。
- 提交约定：每次 commit `git add -A` 纳入 `.workbuddy/memory/` 全部记忆与日志。
- 面向画师文案：代码称「守护进程/daemon」，用户可见文案统一叫「快捷键服务」（状态栏/按钮/通知/菜单）。守护进程静默架构：exe WinExe 不弹控制台、日志落 `%LOCALAPPDATA%\JWautofill\daemon\daemon.log`、`EnsureSelfInstalled()` 自拷贝+注册 HKCU\Run。

## 四、UXP 避坑（硬限制）
- 原生 `<input>`：① `background:transparent` 绘制成纯黑→input 与 wrap 同色 `--dropdown-bg-color`；② 原生绘制区高于 CSS 盒且 `overflow:hidden` 裁不掉→input 26px in wrap 34px（上下各留4px缓冲）。聚焦态用 React `onFocus/onBlur` 切 `.is-focused`，勿 `:focus-within`。`appearance:none` 消 UA 异色外圈。
- `flex gap` 不可靠→一律 margin。容器 `opacity` 会连带压暗子链接→只给文字降透明。
- `<a href>` 不唤起浏览器→`shell.openExternal`；且 UXP **强制用自带链接色渲染 `<a>` 文字、作者 color 被忽略**（深色主题下回退暗蓝）→ 自定义色链接一律用可点击 `<span role="button">`。`text-decoration:underline` 不可靠→`border-bottom`。
- 锁定/模态遮罩下隐藏可编辑控件：`body.adjustment-lock-open #pixeladjustment input,textarea` / `body.license-dialog-open #app …` + `visibility:hidden!important;opacity:0!important;pointer-events:none!important`（写在 `adjustment-input.css`/`input-fix.css`，必须带 `!important`）。
- `flex` 列里固定高度卡片须 `flex:none`+`min-height`+`box-sizing:border-box` 防压缩。
- 面板禁止写 `.xxx-item div{}`/`span{}` 通配后代选择器（会命中自绘弹层）。
- **sp-radio 的 slot 内不要指望行内流布局**（display:flex/inline-flex 的 div 按钮都会被挤到下一行）→ 自定义按钮放 radio 行内时一律绝对定位：容器 `position:relative` + 按钮 `position:absolute;right:0;top:50%`，文字标签 `margin-right` 让位。**规则必须 scoped，绝不挂全局 `.radio-item`/`.radio-item-label`**——颜色面板「计算方法」radio 复用了 `.radio-item-label`，全局加 margin-right 会把它的单行布局挤崩成两行（2026-09-01 实测）。填充模式齿轮定稿：`.fill-mode-group .radio-item{position:relative}` + 按钮 `margin-top:-9px`（几何中心 -12px 偏高 3px，视觉实测 -9px 才与文字/radio 符号对齐）。
- **原生 number input 防越界+尺寸定稿（2026-09-01 终版：容器 32px + input 24px 缓冲）**：UXP 原生 number 的实际绘制区**恒高于 input 的 CSS 盒**（CSS 高度压不掉原生绘制高度，input 的 CSS 高度只决定留多少缓冲、不改变视觉）。**绝不能让 input 撑满容器**（撑满实测下越界复发）。定稿 = 激活码 `.license-input-wrap` 缓冲方案：容器（视觉输入框，含边框背景）`.num-input-row` 32px + input 24px（上下各留 4px 缓冲吃掉原生溢出）+ `line-height:24px` + flex align-items:center。**全部落点**：主面板 `#app`（5 处）、描边面板 StrokeSetting（2 处）、绘画工具箱 `#pixeladjustment`（13 处）、纯色/图案/渐变子面板（ColorSettingsPanel 1 处 + PatternPicker 2 处 + GradientPicker 2 处，JSX 已包 `.num-input-row`；工具箱内层选择器用 `input[type=number]` 而非类名以覆盖子面板无名输入）。单位符号一律在裁剪容器外（`.num-unit`/`.gradient-subtitle`/裸 span）；stroke.css `.stroke-wide-container span` 的旧负边距会用 `​.stroke-wide-container .num-unit{margin:0 0 0 4px}` 归零。
- **产品决策：笔刷热键不支持同名笔刷**（多轮 _index/_id 方案均不可靠已全部回退）。绑定/切换只按 `_name`，同名只选 Brushes 列表最上方那支；README 与 docs/toolbox-guide.html 已注明。下拉里每个笔刷名**只显示一次**（`Array.from(new Set(brushes))` 去重，value 即笔刷名），(1)/(2) 角标已一并删除。

## 五、算法
- 分块补色/渐变/线稿引导/alpha 对齐见历史日志；清像素须显式清零；扣白/扣黑公式与 N 计算见当日记录。

## 六、文档与README同步约定
- **每当重大版本更新，文档（docs/fill-guide.html、docs/toolbox-guide.html）与 README.md 必须同步跟进**：功能增删、菜单项变化、快捷键/授权流程变更都要同步到两处面板文档与 README，避免说明与功能脱节。
- 文档为自包含 HTML（侧边栏导航 + 滚动高亮 + 卡片/表格/提示框，支持明暗主题），由面板右上角「⋮」菜单「功能文档」经 `openPluginDoc()`（`src/utils/openDocs.ts`：`getPluginFolder().nativePath` + `shell.openPath`）在默认浏览器打开；webpack 已把 `docs/` 拷贝进 `dist/docs/`。

## 七、布局算法（滑块标签宽度 / 按钮宽度）—— 2026-09-01 定稿

### 滑块文字标签容器宽度（APP 三面板统一）
- 算法源自工具箱 `src/adjustments/adjustment.css`：以「2字=20px、5字=60px」为锚点按字数线性插值，每字≈13.33px：
  **W(n) = 20 + (n−2) × 13.33**（四舍五入），n=2/3/4/5/6 → 20/33/47/60/73px。
- 标签只承载文字，宽度由 `-2`~`-6` 修饰类给出（容器 `flex:none`）；数字输入+单位符号是行容器的另两个子元素，行容器 `.slider-parameter-collection` 负责布局与 ew-resize 光标。
- 三面板均已落地（类名前缀不同）：
  - 选区填充 `styles.css` → `.slider-text-2`~`-6`，app.tsx 不透明度(4字)挂 `-4`、羽化(2字)挂 `-2`。
  - 图案 `pattern.css` → `.pattern-slider-text-2`~`-6`，PatternPicker 角度：/缩放：(各3字含全角冒号)挂 `-3`。
  - 纯色 `colorpanel.css` → `.colorsettings-slider-text-2`~`-6`，`SliderControl.tsx` 按 `label.length` 自动挂 `-N`（clamp 2~6，1字按2字=20px）。

### 工具箱按钮容器宽度（高度维持两档现状）
- 算法：**width = 字数 × 字号 + 20px，按钮容器无内边距（padding:0）**。
  - 普通档 height 30px / font 13 → **W = 13×n + 20**（n=2→46、3→59、4→72、5→85、6→98、7→111、8→124px）。
  - 紧凑档 height 24px / font 12（守护进程状态条，如「启动/停止快捷键服务」7字）→ **W = 12×n + 20**（7字→104px）。
- 落地（`src/adjustments/adjustment.css`）：`.adjustment-button`=72(4字默认)、`.adjustment-button-lv2`=46(2字)、`.adjustment-button-wide`=124(8字兜底)；新增 `.adjustment-button-5/6/7/8`=85/98/111/124；`.auto` 仅与 compact 同用（去 padding）；`.compact`=104(7字,font12)。所有档 padding:0。
- AdjustmentPanel.tsx 的 wide 按钮已按实际字数改挂精确档：alpha下/上对齐(8)→-8、浅/深线同层补色(7)→-7、保底下对齐(5)→-5、线条加黑(4)→默认（去掉 wide）。

## 八、说明文案（hover title）集中管理 —— 2026-09-01
- **所有面板 hover 说明统一收口到 `src/constants/helpTexts.ts`**，按面板分组：`selectionFill`（选区填充主面板 app.tsx）、`adjustment`（绘画工具箱 AdjustmentPanel.tsx）、`hotkey`（快捷键区 BrushHotkeySection.tsx）、`gradient`（渐变子面板 GradientPicker.tsx）、`pattern`（图案子面板 PatternPicker.tsx）。
- 调用方一律 `title={helpTexts.<section>.<key>}`，**禁止在 JSX 内联长字符串**（之前多行 `●` 模板字符串正是导致排版乱、且必须用原生 `title` 属性才能左对齐+`\n\n` 间隔一行的根因）。
- 多行 `●` 说明在 helpTexts.ts 里以 `\n\n` 拼接（保证 hover 时每条一行、间隔一行、左对齐）；单行短提示也一并收口以保持统一。
- import 相对路径：**文件在 `src/` 下用 `./constants/helpTexts`**；在 `src/adjustments/`、`src/hotkey/` 下用 `../constants/helpTexts`；在 `src/components/` 下用 `../constants/helpTexts`（注意 components 只上一层到 src，不是 `../../`）。
- 通用组件（IconButton/CustomSwitch/RangeSlider/Select/BrushSelect/MaskSyncSelect）的 `title={title}` 是 prop 透传，**不要动**；只改调用处传入的字面量 title。
- 激活面板（LicenseDialog）与 ColorSettingsPanel/StrokeSetting 无 `title=` 静态说明，无需收口。
