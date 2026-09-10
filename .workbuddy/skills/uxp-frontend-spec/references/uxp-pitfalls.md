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
→ 覆盖链要写成 `.panel-section sp-radio-group.radio-pair-230` 或 `.row-between.checkbox-grid` 这种**双类**形式。

---

## 13. 原生 checkbox 自带默认外边距

不显式写 `margin` 会被撑开（行距莫名变大）。→ 统一挂 `.checkbox-input`（`margin:10px 0`），网格内由 `.checkbox-grid` 清零。

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

**⚠️ 不要试图用 `padding-right` 预留槽位**：Chromium 的 scrollport = padding box − scrollbar，
加 padding 只会让内容盒再窄 10px（220 → 210），位移照旧。

**⚠️ `::-webkit-scrollbar` 在 UXP 下不生效**，滚动条不可自定义样式（Adobe 官方论坛已确认）。

---

## 16. 改完必须 Reload

前端任何改动都要 **UDT Reload** 才生效（webpack 输出的 `dist/` 与 `manifest.cssResources:["common.css"]` 一致）。新增 CSS 文件记得挂进 `index.tsx` 的引入链 / `app.css` 的 `@import` 聚合，否则不参与构建。

---

## 排查顺序（遇到问题按这个走）

1. 是不是原生控件穿透？→ 查 ①②⑦，确认隐藏规则的选择器**只命中目标面板**、`!important` 用法正确
2. 是不是高度链断？→ 查 ⑥，逐层确认 height / overflow
3. 是不是 `var()` 没解析？→ 查 ⑤，改字面色
4. 是不是间距/位置诡异？→ 查 ③⑪⑫⑬，确认没用 gap、没被通用后代规则反压
5. 是不是「某些高度下才出问题」的右侧裁切/抖动？→ 查 ⑮，确认滚动容器**没有** `scrollbar-gutter`、**没有**用 `overflow-y: scroll` 兜底
6. 四套主题各看一遍 —— 主题漏写变量是最常见的「某主题下样式丢失」
