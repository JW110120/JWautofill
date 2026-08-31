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

## 五、算法
- 分块补色/渐变/线稿引导/alpha 对齐见历史日志；清像素须显式清零；扣白/扣黑公式与 N 计算见当日记录。
