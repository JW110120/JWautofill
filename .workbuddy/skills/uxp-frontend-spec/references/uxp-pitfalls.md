# UXP 渲染 / 层叠避坑清单

每条都是本项目已复现并验证过的坑，格式：**现象 → 根因 → 正确解法**。

---

## 1. 原生可编辑控件永远画在最上层（头号坑）

**现象**：`input` / `textarea` / `sp-textfield` 浮在遮罩、下拉弹层、折叠区外面。
**根因**：UXP 官方 Known Issue —— 可编辑控件是**原生视图**，永远绘制在同面板最上层，`z-index` / `transform` / 换挂载点都压不住。
**解法**：只能**隐藏**，且保留布局占位（不用 `display:none`）：
```css
visibility: hidden !important;
opacity: 0 !important;
pointer-events: none !important;
```
**⚠️ !important 的优先级反转**：UXP 的 CSS 引擎把**样式表 `!important` 判在内联 `!important` 之上**。
`src/utils/popOverlay.ts` 靠内联 `visibility:hidden !important` 临时隐藏与弹层相交的数字输入，所以
「恢复可见」的规则（`.collapse-content-expanded input`、`.panel-section ~ .panel input` 等）
**绝不能加 `!important`**，否则遮挡逻辑失效、数字永远浮在菜单上。

**标准做法**：
- 弹层/模态打开 → 给 `body` 加状态类（`license-dialog-open` / `secondary-panel-open` / `visibility-panel-open` / `adjustment-lock-open`），用 `body.xxx` + `!important` 统一隐藏该面板内控件。
- 折叠区内容 → **React 条件渲染，收起时不进 DOM**；若必须留在 DOM，用 `.collapse-content` 三件套隐藏（不加 `!important`），展开态 `.collapse-content-expanded` 同特异性写在后面自然胜出。

---

## 2. 折叠区 `max-height:0 + overflow:hidden` 裁不住原生控件

**现象**：折叠收起后数字输入框仍浮在分区外面、盖住下方内容。
**根因**：同 ①，原生视图按布局坐标绘制，不受 overflow 裁剪。
**解法**：条件渲染优先；否则显式隐藏容器内所有 `input/textarea/sp-textfield`。

---

## 3. UXP 不支持 flex `gap`

间距一律用 `margin` / `padding` 表达。行内元素间距优先写在「后随元素」上，并用相邻选择器处理首/末项（`+` / `:last-child` / `:nth-child(4n)`）。

---

## 4. UXP 禁 `outline`（含 `outline-offset`）

一切「选中 / 落点 / 聚焦」视觉改用 **border 变化**，且基础类预挂 `1px solid|dashed transparent` 占位 → 零位移。

---

## 5. `var()` 在部分子树解析不稳定

**现象**：遮罩/下拉选中项「能拦截点击但背景完全不绘制」「选中项底回落成面板底色」。
**根因**：弹层经 `createPortal` 挂到面板根（`<Provider>` 作用域内）、或变量由 JS 动态注入时，UXP 下 `var()` 解析不可靠。
**解法**：这些位置直接写与主题等价的**字面 `rgb()`** 并注释原因：
- 遮罩 `.float-overlay` / `.adjustment-lock-overlay` → 由 `theme.ts` 按主题注入字面 `rgba(...,0.80)`
- `.select-opt-sel` → `background: var(--primary-color)`（四主题恒定 `rgb(38,128,235)`，故与字面等价）
- `.select-wrap` / `.select-pop` 内局部重声明 `--primary-color: rgb(38,128,235)`，覆盖 `<Provider>` 作用域内被改写的主色

---

## 6. `<Provider>` 会插一层 `height:auto` 的 div，截断百分比高度链

**现象**：主面板永远不出现滚动条、内容被裁掉。
**解法**：`<Provider theme={defaultTheme} colorScheme="dark" height="100%">` —— `height="100%"` **不能省**。
整条链每一层都必须有高度：`#app → Provider → .app-root → .panel(滚动) → .panel-section`。新增包裹层也要给高度并铺 `background-color: var(--bg-color)`。

---

## 7. 子面板（纯色/渐变/图案/描边）必须绝对定位铺满父面板

```css
#app .panel-section ~ .panel { position:absolute; inset:0; z-index:9999 !important; }
body.secondary-panel-open #app .app-root > .panel { overflow-y:hidden; }  /* 锁主面板滚动 */
```
定位上下文由 `.panel{position:relative}` 提供。子面板内部也挂 `.panel-section`，所以「只命中主面板内容」必须靠 `.app-root > .panel > .panel-section` 限定 —— 写成 `#app .panel-section ~ .panel .X` 会只命中子面板，把子面板自己的数字也藏了（历史故障：打开纯色/图案看不到数字）。

---

## 8. 原生 `<input type="range">` 的 step 失效

PS 27.9.1 起 UXP 换 Drover 后端，原生 range 只能在 min/max 间跳变（Adobe bug PS-204932）。
→ 一律用 `src/components/RangeSlider.tsx`（div 自绘 + 鼠标/键盘事件 + step 吸附）。

---

## 9. `sp-picker` / `sp-menu` 的展开菜单背景无法覆盖

其 flyout 在 shadow DOM / overlay 层。→ 一律用 `src/components/Select.tsx`（自绘头 + `position:fixed` 弹层，按 `getBoundingClientRect()` 定位，滚动时重定位）。

---

## 10. 不支持多层 CSS 背景 / `background-repeat` 渐变

虚线分割线用**纯 DOM span 短线序列**（`.divider-dashed` + `.divider-dashed-dash`），不要用 `repeating-linear-gradient`。

---

## 11. `sp-radio` 影子布局把 slot 排到右侧

radio 行内自绘元素走文档流，**不要绝对定位去 pin 边缘**（`.radio-pair-*` 是唯一例外，它把最后一个 `sp-radio` 绝对定位贴右缘，且必须靠父级 `.panel-section` 提权才能压过 `.panel-section sp-radio-group{justify-content:space-around}`）。

---

## 12. 特异性必须靠「父级 / 双类」提权，不能靠源码顺序

单类选择器 `(0,1,0)` 压不过 `.panel-section sp-radio-group` `(0,1,1)`。
→ 覆盖链要写成 `.panel-section sp-radio-group.radio-pair-230` 或 `.row-between.row-grid` 这种**双类**形式。

---

## 13. 原生控件的「默认外边距 / 透明盒高」会悄悄改变行距

- **原生 checkbox 自带默认外边距**：不显式写 `margin` 会被撑开（行距莫名变大）。
  → 统一挂 `.checkbox-input`（`margin:10px 0`），网格内由 `.row-grid .checkbox-input { margin-top:0; margin-bottom:0 }` 清零（行距改由行规则提供）。
- **`sp-switch` 原生盒高 32px，可见胶囊只有 14px**（上下各 ~9px 是**透明留白**）。
  后果一：含开关的状态条比纯文字状态条高 15px（40px vs 25px）→ 等高用 `.notify-bar{min-height:40px}`。
  后果二：紧凑网格行被撑到 37px（复选框行只有 21px）→ 两行的视觉间距比复选框组大一截，
  看起来像「外边距翻倍」，其实外边距早已折叠成 10px。
  → 收紧的办法是**对称负外边距**：`.row-grid sp-switch{margin-top:-6px;margin-bottom:-6px}`。
  它只让开关**盒**纵向溢出 6px，胶囊本体（盒内居中、距盒边 9px）仍落在行内 → 不会被裁切，
  行盒收缩到 21px 与复选框行同档。⚠️ 先确认行盒高度差是主因，再去改外边距（否则是 no-op）。

---

## 14. JS 测量尺寸不可靠 / 百分比产生亚像素缝

- 铺满背景：用**整数 px 格子过量渲染 + `overflow:hidden`**，不要用 `getBoundingClientRect()` 的结果去算。
- 百分比/小数坐标必出亚像素缝：棋盘格方块 **+1px 重叠**盖缝，底板用 `inset:0` + OVERSCAN。
- 缩略图/网格一律固定整数尺寸（52×52），靠 `nth-child` 清边距锁列，不靠测量结果。

---

## 15. 千万别给滚动容器加 `scrollbar-gutter: stable`

**现象**：面板高度压在某阈值（APP 面板 ≈823px）时出现「有滚动条 / 无滚动条的中间态」，
右对齐的**原生控件**（`sp-switch`、`sp-radio` 的 slot 内容）右半截被裁掉；
换到内容永远溢出、或外层带 10px 内边距的面板（绘画工具箱的 `.border-panel-section`）却完全正常。

**根因（2026-09-10 用截图像素定位）**：UXP 的 CSS 侧**会**照 `scrollbar-gutter: stable` 预留 10px 槽位
（实测：内容盒 220px、右缘 x=230，但整条右侧 14 列**没有任何滚动条像素** —— 槽位被预留却没画滚动条，
这就是用户说的「中间态」）。而 PS 宿主给原生控件排版时**不扣这份槽位**：控件按「内容盒 230px」摆位，
右缘落到 x=240，正好探出内容盒 10px，被面板右缘裁掉右半截。
（对照：`.border-panel-section` 有 10px padding，控件右缘本就内缩 10px，多出的 10px 刚好落在 padding 里，所以工具箱看不出问题。）

**解法：删掉 `scrollbar-gutter: stable`，让槽位只按需占位** —— 无滚动条内容盒 230px、有滚动条 220px，
正好是设计要的两档，CSS 与宿主始终对齐：

```css
.panel { overflow-y: auto; overflow-x: hidden; }   /* 不要写 scrollbar-gutter */
```

**⚠️ 不要用 `overflow-y: scroll` 代替**：虽然它也能消除裁切（滚动条真的常驻，宿主就会扣位），
但内容盒被钉死在 220px，无滚动条时整块内容比设计窄 10px、且与 228px 内宽链的子面板不再自洽。

---

## 16. 「间距偏大」先分清容器是块还是 flex —— 外边距折叠行为不同

**现象**：局部间距看起来比设计值大一倍（30px vs 15px），第一反应是「外边距叠加」。

**实测结论（2026-09-10 截图像素拟合）**：
- **块容器内相邻外边距会折叠**：`.collapse-content-expanded`（block）里 `.divider`(10) + `.panel-section`(15) → 取 15 ✓（既有注释正确）。
- **flex 列容器内不折叠**：`.panel-section` / `.border-panel-section` 都是 `display:flex; flex-direction:column`，
  相邻子项各 10px → 实际 **20px**。

**因此「把间距减 N px」必须同时归零一侧**，否则在会折叠的那一侧是 no-op：

```css
/* 紧凑填充两行网格之间 → 恒 10px（与复选框组 5+5 同档） */
body.compact-app #app .app-root > .panel > .panel-section .row-grid + .row-grid { margin-top: 0; }
/* 工具箱连续行内滑块 → 20px 收到 10px（对齐主面板 .slider-container 的折叠后 10px）
   ⚠️ 必须用显式类名 .slider-row 标识「行内滑块行」，不能用 `:has(.slider-track)` —— 见 ㉑ */
#pixeladjustment .border-panel-section .row-between.slider-row + .row-between.slider-row { margin-top: 0; }
```

**定位方法（可复用）**：Pillow 打开截图 → 逐行统计与背景的色差得到「内容带」（ink band），
再用窄 x 窗口做**纵向 ink profile**，直接得到每行/每个控件的中心与 pitch；
两行 pitch 减去已知盒高即得真实间距。比读 CSS 猜更快、也更可信
（本例据此才发现真凶是 sp-switch 的透明盒高，而不是外边距）。

**⚠️ 不要试图用 `padding-right` 预留槽位**：Chromium 的 scrollport = padding box − scrollbar，
加 padding 只会让内容盒再窄 10px（220 → 210），位移照旧。

**⚠️ `::-webkit-scrollbar` 在 UXP 下不生效**，滚动条不可自定义样式（Adobe 官方论坛已确认）。

---

## 17. 改完必须 Reload

前端任何改动都要 **UDT Reload** 才生效（webpack 输出的 `dist/` 与 `manifest.cssResources:["common.css"]` 一致）。新增 CSS 文件记得挂进 `index.tsx` 的引入链 / `app.css` 的 `@import` 聚合，否则不参与构建。

---

## 18. `entrypoints` 的 menuItems id 必须全局唯一（面板整块起不来）

**现象**：插件面板**完全不显示**（不是样式错乱，是白/空面板），控制台抛：

```
uxp://uxp-internal/domjs_scripts.js:2 Uncaught Error: Can't add menu item with <id> as it already exists.
```

**根因**：UXP 的菜单项 id 是**插件级全局唯一**，不按面板隔离。两个 entrypoint（`com.listen2me.jwautofill` 与
`com.listen2me.pixeladjustment`）的 `menuItems` 里出现同名 id 时，`entrypoints.setup()` 直接抛错中断，
两块面板一起挂掉。本项目曾把「隐藏/显示分区」在 APP 与绘画工具箱都写成 `showVisibilityPanel` 而复现。

**解法**：每个面板的菜单 id 加面板前缀，跨面板同功能也要区分：
`appShowVisibilityPanel` / `showVisibilityPanel`、`resetAppParameters` / `resetParameters`、`openDocsFill` / `openDocsToolbox`。
`handleXxxFlyout` 里的 `case` 必须同步改名，`setXxxLabel()` 这类按 id 取项的降级链同理
（⚠️ 改名后用 `grep '"<旧id>"'` 复核，本项目多次出现 Edit「报成功但没落盘」）。

---

## 19. 浮窗（`.float-overlay`）必须挂在滚动容器**之外**

**现象**：激活弹窗 / 「隐藏-显示分区」浮窗打开时，右侧滚动条压在浮窗右缘上，
窗口看起来被滚动条挡住或裁掉一截。

**根因**：UXP 下 `position: fixed` 的**包含块 = 面板全宽，不扣右侧 10px 滚动条槽**
（绘画工具箱里针对锁定遮罩的注释已记录同一现象）。滚动条因此正好落在窗口右缘上。

**解法**（两条一起做）：

1. **挂载点移出滚动容器**：浮窗渲染成 `.panel` 的**同级**节点（APP 挂在 `.app-root` 层、
   绘画工具箱挂在 `.pixeladjustment-root` 层），并给这两个根容器加 `position: relative`。
   外层用 `<>…</>` 片段包住 `.panel` + 浮窗。
   （⚠️ 不能用 `createPortal` 挂到 `document.body`：UXP 只显示 `<uxp-panel panelid=…>` 子树，
   body 级节点不渲染。）
2. **打开期间收起该面板滚动条**，并补 10px 右内边距保持内容盒宽度不变（零重排）：

```css
body.license-dialog-open #app .app-root > .panel,
body.app-visibility-panel-open #app .app-root > .panel,
body.visibility-panel-open #pixeladjustment .pixeladjustment-root > .panel {
  overflow-y: hidden;
  padding-right: 20px;   /* 10 基础 + 10 补回滚动条槽：内容盒仍是 W-30，不重排 */
}
```

⚠️ **光限定 `#app` / `#pixeladjustment` 不够，body 类名本身也必须按面板区分**
（主面板 `app-visibility-panel-open` / 工具箱 `visibility-panel-open`）。两块面板共用同一个
`document.body`（同一个 index.html），曾因两边都叫 `visibility-panel-open` 出现：
① 有滚动条的面板开浮窗 → 另一块（无滚动条）的内容盒被多塞 10px 内边距而变窄；
② 无滚动条的面板开浮窗 → 另一块原本正常的滚动条被一起收起；
③ 两块同时开着时**先关任意一块**，其关闭逻辑无条件 `classList.remove` → 另一块仍在开的浮窗
被打回原状（滚动条回来、数字浮到浮窗上方）。
→ 结论：**每块面板一个专属类名，开/关只动自己那一个**，并在 `componentWillUnmount` 里一并清理。

3. **浮窗打开期间同时隐藏本面板的 number 输入**（原生视图永远在最上层，否则数字会浮在浮窗之上）。
   规则必须「**本面板专属类名 + 本面板根节点**」成对出现，缺一不可：

```css
/* 主面板 → src/styles/input-fix.css */
body.app-visibility-panel-open #app input[type="number"] {
  visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;
}
/* 绘画工具箱 → src/adjustments/adjustment-input.css */
body.visibility-panel-open #pixeladjustment input[type="number"] { /* 同上三件套 */ }
```

   ⚠️ `!important` 必需：要压过 `#app .panel-section ~ .panel input[type="number"]{visibility:visible}`
   （(1,3,1) 高于 (1,2,1)），否则遮不住。
   ⚠️ **历史故障**：common.css 里曾留一条 `body.visibility-panel-open #app input[type="number"]{visibility:hidden}`
   —— 「工具箱的类名 × 主面板的作用域」写串了。后果很有迷惑性：**只开主面板浮窗时数字浮在浮窗上方（看起来没修好），
   再开一次工具箱浮窗数字才消失（看起来「问题解决了」）** —— 其实是串扰规则在代偿。
   排查时务必确认两块面板各有一条、且选择器一一对应。

---

## 20. UXP 没有内置 `fs` / `os` 模块（编译期正常、运行期才炸）

**现象**：控制台报 `…\node_modules\fs.json doesn't exist`，依赖该模块的功能（如落盘导出）**在运行期静默失败**，
编译期毫无征兆（webpack 的 `commonjs2 fs` external 只是把 `import fs from 'fs'` 原样留下成 `require("fs")`，
webpack 里当作 external 声明也不会报错）。

**根因**：Photoshop UXP 的 JS 运行时**没有** Node 内置模块，`require('fs')` / `require('os')` 会从插件目录向上找 `node_modules`。

**解法**：
- 落盘/读文件一律用 `require('uxp').storage.localFileSystem`（Entry API）。
  `require('uxp')` 与 `require('fs')` 不同：前者在 webpack 里作 external 是**合法且必需**的。
- 让用户自选保存位置：`getFileForSaving(建议文件名, { types: ['log'] })`。
  ⚠️ **必须在该命令的 `executeAsModal` 之外调用** —— 文件选择器是交互式原生对话框，
  在模态范围内调用会被 PS 拒绝（模态范围锁住交互 UI）。拿到 Entry 后在模态内 `entry.write(text, {format: formats.utf8})`。
  用户取消时部分 PS 版本是**抛错**而非返回 `null`，要 try/catch 后按「取消」静默退出。
- 需要拼 Windows 绝对路径 URL 时写成 `file:/C:/…`（`file:` 后必须有一个斜杠再写盘符；
  写成 `file:C:/…` 会被判为非法 URL 直接抛错）。
- 取用户目录用 `process.env.USERPROFILE`，兜底从 `getDataFolder().nativePath` 里截「…\AppData\」之前；
  **不要 `import os`**。文件名先替换 `\/:*?"<>|` 再截断长度。

---

## 21. UXP 的 CSS 引擎**不支持 `:has()`** —— 整条规则被静默丢弃

**现象**：用 `:has()` 写的规则**完全不起作用**，同一处换成相邻兄弟 / 后代选择器就正常；
构建不报错、DevTools 也不提示选择器非法（规则像不存在一样）。

**根因**：UXP 不是浏览器，选择器只是子集。Adobe 变更日志显示 UXP v8.1 才刚补上
`:first-child` / `:not(:first-child)` 这类基础伪类（为 Web Component 服务）；`:has()`
（2022 年后的浏览器特性，需要反向子树匹配）**未被支持 → 整条规则作废**。

**本项目实证**：`#pixeladjustment .border-panel-section .row-between:has(.slider-track) + …:has(.slider-track)`
确认已构建进 `dist/bundle.js`，Reload 后间距像素测量**毫无变化**（仍 20px）；
换成显式类名 `.row-between.slider-row + .row-between.slider-row` 立刻生效。

**解法**：改用显式类名（在 TSX 给目标元素加类），其余照旧用 `+` / 后代 / 双类提权。
批量加类可用脚本按结构特征匹配（如「`className="row-between"` 行 + 紧跟 `sliderLabelClass(` 与 `RangeSlider`」），
本项目一次性为 13 处行内滑块行加上了 `slider-row`。

**⚠️ 本项目已于 2026-09-10 清完全部 `:has()`**（当时 4 处，均改为显式类名 / 删除）：
- `common.css` 的「含禁用控件时整行置灰」两条（`.row-between:has(sp-switch[disabled]) …`、
  `.row-start:has(input:disabled) …`）→ 删除，改用既有的 `.row-between.disabled` / `.row-start.disabled`，
  由 TSX 按状态挂类（现有 4 处：app.tsx 紧凑/非紧凑 × 新建图层/清除模式）。
  ⚠️ 这个类名机制必须由 TSX 驱动，没有「自动探测子控件状态」的纯 CSS 方案（反向子树匹配无替代）。
- `gradient.css` 的 `.final-preview-container:has(> .subpanel-title-1) .preview-wrapper{overflow:visible}`
  → 删除：除 `:has()` 失效外，两个 `.final-preview-container`（渐变/图案）的首个子节点分别是
  `.subpanel-title-2` 与 `.preview-toolbar`，选择器本就不可能命中。

新增代码**一律不要写 `:has()`**；已写完的可以自查 `grep -n ':has(' src/**/*.css`，
命中项若在注释里可忽略，行内带 `{` 的就是活着的死代码。

**一句话**：UXP 里「某条 CSS 完全不起作用」→ 先看选择器里有没有 `:has()`。

---

## 22. 条件渲染的图标 / 色板槽会把行高顶起来（开关一开一关就抖）

**现象**：某个开关打开后才出现的图标按钮 / 色板，会让所在行**变高**，整段分区跟着往下挪
（紧凑模式描边模式行：关 = 22px，开 = 24px）。

**根因**：`.grid-cell + .grid-cell` 的高度 = 内容高度。关闭时 `.row-end` 为空 → 0；
打开时里面是「色板 20px + `.icon-button` 24px」→ 24px。左列（标签 22px + 开关）只有 22px，
于是行高由 `max(22, 0/24)` 决定 → 22↔24 跳变。

**解法**：让这一槽**彻底不参与行高** —— 把内容摘出文档流（右列只当定位上下文）：
```css
.row-grid-fit .grid-cell + .grid-cell { position: relative; }          /* 右列：只提供定位上下文 */
.row-grid-fit .grid-cell + .grid-cell .row-end {
  position: absolute; right: 0; top: 50%; transform: translateY(-50%);
}
```
右列没有在流子项 → 高度恒 0 → 行高完全由左列（22px）决定，开关前后一模一样。
⚠️ **不要用对称负外边距**（`margin-top/bottom:-2px`）：它只做到「让盒溢出」，
实测行高仍随内容出现与否在 22↔24 之间变，本行下方（三列 radio 行、复选框首行）照旧抖。
其他候选：给左列定高（要写死 22px 魔数，主题换字号即失效）。绝对定位改动小且无魔数。
非紧凑模式没有这个问题：那里 `sp-switch` 是原生 32px 盒，行高恒 32。

---

## 23. 定宽标签装不下汉字（溢出 ~6px，会让「贴右缘」的布局压到滚动条）

**现象**：把一排控件的**末项贴到内容盒右缘**（如三列 radio 用 `space-between`）后，
末项文字明显压到滚动条上 / 被右缘裁掉一截。

**根因**：`.label-N` 按 `W(n) = 20 + (n-2)×13.3` 定宽，但汉字在 13px 下实际 13px/字 ——
`n=2` 实际 26px 却只给 20px，**所有档位都窄约 6.6px**。文字 `white-space:nowrap` + `overflow:visible`
→ 一直溢出到盒外的 `margin-right:10px` 里（所以日常行的视觉间隙其实只有 ~4px，不易察觉）。
一旦「盒右缘」被对齐到容器右缘，这 6px 就露到滚动条上了。

**解法**：需要贴右缘的场景先把标签放宽（`.radio-trio sp-radio .label-2{width:26px}`），
或改用 `space-around` 让两端各留半个间隙。

**实测口径**：截图中「纯色 / 图案 / 渐变」的文字墨迹均为 26px 宽（13px 字宽 × 2），
而盒子按 20px 排版 → 溢出 6px。

---

## 25. PS 状态变了却「不刷新」：先查有没有通知，再查检测写的是 state 还是实例字段

**现象**：按 Q 进出快速蒙版，面板里「新建图层」开关不变灰；必须**再生成一次选区**才刷新。

**复合根因**（两个都要修，缺一不可）：
1. **渲染读的是 `state.isInQuickMask`，而检测函数只写 `this.isInQuickMask`（实例字段）+ `forceUpdate()`** ——
   通知通道即便拿到新值，界面也永远停在旧值。这类「实例字段 / state 双份状态」在本项目里很常见
   （`isInLayerMask` / `isInSingleColorChannel` 同款），新增状态判定务必顺手回写 state。
2. **PS 切换快速蒙版根本不派发通知** —— 实测 `set` / `select` / `make` / `delete` 一个都不来，
   事件通道（`addNotificationListener`）拿不到，只能等下一次选区变更顺带刷新。

**解法**：① 检测函数补 `if (this.state.X !== v) this.setState({ X: v })`；
② 加一条**只读廉价属性**的轮询兜底（`app.activeDocument.quickMaskMode`，与「选中工具巡检」同类读法），
   并**按可见性启停**（本项目：仅「填充选项」展开且可见时跑，300ms）——
   不可见时不轮询，避免无谓的 get 撞 PS 忙碌窗口。

**排查口诀**：先确认「这状态 PS 到底发不发通知」，再确认「检测结果有没有落到渲染真正读的那份状态里」。

---

## 排查顺序（遇到问题按这个走）

0. 面板**根本不出来**？→ 查 ⑱ 控制台有没有「Can't add menu item … already exists」，再看 ⑥ 高度链
1. 是不是原生控件穿透？→ 查 ①②⑦，确认隐藏规则的选择器**只命中目标面板**、`!important` 用法正确
2. 是不是高度链断？→ 查 ⑥，逐层确认 height / overflow
3. 是不是 `var()` 没解析？→ 查 ⑤，改字面色
4. 是不是间距/位置诡异？→ 查 ③⑪⑫⑬，确认没用 gap、没被通用后代规则反压
5. 是不是「某些高度下才出问题」的右侧裁切/抖动？→ 查 ⑮，确认滚动容器**没有** `scrollbar-gutter`、**没有**用 `overflow-y: scroll` 兜底
6. 浮窗被滚动条压住 / 右缘缺一截？→ 查 ⑲，确认浮窗挂载点在滚动容器之外、打开时收起了滚动条
7. 落盘失败 / 控制台报 `node_modules\fs.json doesn't exist`？→ 查 ⑳，确认没有 `require('fs')`/`('os')`、`file:` URL 是 `file:/C:/…`
8. 整条规则**完全没生效**（不是「被反压」而是压根没反应）？→ 查 ㉑，先看选择器里有没有 `:has()`
9. 行高/间距**时大时小**（组件一开一关就跳）？→ 查 ㉒（条件渲染的图标/色板槽必须**摘出文档流**，负外边距不够）+ ⑬（原生控件透明盒高）
10. 末项贴右缘后文字压到滚动条？→ 查 ㉓，先把 `.label-N` 放宽到汉字实际宽度
11. 一排 N 列**恒折行**（与滚动条无关）？→ 查 ㉔，量出单项宽度，从内容侧砍窄，别在 `flex-wrap` 上使劲
12. PS 里状态变了（如按 Q 进出快速蒙版）但面板**要等下一次操作才刷新**？→ 查 ㉕（先查有没有通知，再查检测写的是 state 还是实例字段）
13. 四套主题各看一遍 —— 主题漏写变量是最常见的「某主题下样式丢失」
