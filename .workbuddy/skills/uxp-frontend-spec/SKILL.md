---
name: uxp-frontend-spec
description: JWautofill（Photoshop UXP 插件）前端 UI 设计规范。在新建面板/分区/控件、新增或改写 CSS/TSX、调整主题配色与间距、review UI 一致性、排查 UXP 渲染异常（原生控件穿透、滚动失效、样式不生效、浮窗被压）时使用。内容涵盖主题令牌、尺寸公式、通用类名目录、标准 DOM 骨架、状态样式规则、浮窗/子面板遮挡体系与 UXP 避坑清单。
agent_created: true
---

# JWautofill UXP 前端设计规范

本规范从 `src/styles/common.css` / `app.css` / `input-fix.css`、`src/adjustments/adjustment*.css`、`src/styles/theme.ts` 提炼而成。
目标：**新建任何面板/功能时，不发明新样式，只按本规范拼装既有类。**

## 何时使用

- 新建面板、子面板、折叠分区、设置区块、浮窗
- 新增/修改控件（滑块、数字输入、按钮、下拉、开关、勾选、缩略图、通知）
- 改动配色、间距、字号、圆角等视觉参数
- UI 一致性 review、样式漂移排查
- UXP 渲染异常排查（原生 input 穿透、滚动条不出现、样式不生效、浮窗被压/数字冒头）

## 四条铁律

1. **单一来源**：通用组件样式只存在于 `src/styles/common.css`。面板 CSS（`app.css`/`adjustment.css`/`pattern.css`/`clear.css` 等）**只写该面板独有的类**。新增类前先在 common.css 搜近义类。
2. **加载顺序**：`index.tsx` 顶部顺序 `uxpPerfPatch → common.css → app.css → license.css`，**严禁 `@import`**（除 `app.css` 聚合本面板的子 CSS）。新 CSS 必须挂进这条链，不能靠组件内 `<style>`。
3. **禁 HEX**：一切颜色走 `rgb()`/`rgba()` + 主题变量。唯一例外：遮罩与下拉选中项这类 UXP 下 `var()` 解析不稳定的位置，用与主题等价的字面 `rgb()` 并注释原因。
4. **跨文件的「标签随控件置灰」必须用两级类**：common.css 是静态 `<link>` 先加载、app.css 由 style-loader 运行时后注入 ⇒ 同为 (0,1,0) 时 app.css 的 `color` 会盖掉 common.css 的 `.label-disabled`（写成 `.app-xxx.label-disabled`）。同文件内（common.css 的两个类）靠后置规则即可。

## 设计令牌（src/styles/theme.ts）

四套主题：`darkest / dark / light / lightest`，由 `prefers-color-scheme` 媒体查询覆盖。**加新颜色必须四套都写**，否则某主题下退化成无样式。

| 变量 | 用途 |
| --- | --- |
| `--primary-color` | 主色蓝（滑块填充、选中、聚焦边框、落点虚线）；四套恒定 `rgb(38,128,235)` |
| `--bg-color` | 面板/页面底色 |
| `--dark-bg-color` | 预览区、预设区底（比底色深一档） |
| `--entry-bg` | 列表行/卡片行背景 |
| `--border-color` | 一切描边、分割线 |
| `--text-color` / `--disabled-color` | 正文 / 禁用文字 |
| `--button-bg` / `--button-down` | 按钮常态 / 按下 |
| `--hover-bg` / `--hover-icon` / `--active-icon` | hover 背景 / 图标 hover / 图标按下填充 |
| `--latched-bg` / `--latched-icon` | 图标常亮（胶囊底 / 图标色）；**不可复用 `--hover-icon`**（lightest 仅 2.9:1） |
| `--dropdown-bg-color` | 下拉头/弹层、数字输入框底 |
| `--control-handle-color` / `--radio-checked-color` | 滑块手柄 / radio 选中 |
| `--enabled-text-color` | 主按钮「功能开启」态文字 |
| `--link-color` | 超链接（不要复用 primary-color：中蓝在深底发暗） |
| `--notify-ok/-warn/-fail-fg/-bg/-border` | 三态通知 |
| `--scrollbar-thumb` / `--scrollbar-track` / `--slider-bg` / `--black-text-` | 滚动条 / 滑块轨道 / 深底深色字 |

**遮罩特例**：`.float-overlay` / `.adjustment-lock-overlay` 的 `background-color` **由 `theme.ts` 按主题直接注入字面 `rgba(...,0.80)`**（不透明度恒 0.80），common.css 里**绝不写**这两类的 `background-color`。改遮罩只改 theme.ts 那一处。

## 度量公式（整数像素，禁止小数）

| 对象 | 公式 / 定值 |
| --- | --- |
| 面板宽 | 250（manifest）− `.panel` padding 10×2 = **230 可用宽**（有滚动条时 220） |
| 文字标签 `.label-N` | `W(n) = 20 + (n−2)×13.3` → 2/3/4/5/6 字 = 20/33/47/60/73px；13px；右 margin 10 |
| 动作按钮 `.action-button-N` | `W = 13×字数 + 20` → 2:46 … 8:124；高 30；>8 字用 `.action-button-auto` |
| 数字输入 | 容器 `.num-input-row` **34×32**（= 1 + 32 + 1，含描边），内部 `input` **高 20px**（垂直居中修正）；text 变体走 `.num-input-row-wide` 62px |
| 单位符号 `.num-unit` | 容器**外**、紧跟输入框、**定宽 16px**（按最宽单位 `px` 取）、`margin-left:0`、右对齐 |
| 图标按钮 | `.icon-button` 24×24；`.record-button` 26×26；`.circle-button` 32×32；图标 `.icon-14` 14×14 |
| 缩略图 | `.thumb-box` 52×52（内图 46×46） |
| 间距 | 面板 padding 10；`.panel-section` 下边距 15；`.border-panel-section` padding 10 + 下边距 10；`.divider` 上下 10；行容器上下 10 |
| 圆角 / 描边 | 一律 `border-radius:3px` + `1px solid var(--border-color)` |
| 字号 | 主标题 20 / 子面板一级 18 / 二级 15 / 主开关 16 / 正文与标签 13 / 控件与通知 12 / 辅助 11 / 版权 10 |
| 预设网格 | 4 列：内宽 228 − padding 4×2 = 220 = 4×52 + 3×4（B=52、M=4），`:nth-child(4n){margin-right:0}` 锁列 |

> ⚠️ `.label-N` 比汉字实际宽度**窄约 6.6px**（靠右 margin 遮溢出）。凡「标签盒右缘要对齐容器右缘」的新布局必须先补这 6px。

## 标准骨架

### 面板高度链（滚动命脉，断一层就滚不动）

```
#app / #pixeladjustment (height:100%)
  └─ Provider height="100%"        ← 必须显式给，否则中间那层 div 是 height:auto
      └─ .app-root / .pixeladjustment-root (100%)
          └─ .panel                 ← 唯一滚动容器：height:100% + overflow-y:auto
              └─ .panel-section     ← flex 列，flex:0 0 auto
```

- 新增包裹层必须给高度并铺 `background-color: var(--bg-color)`；`.panel > *` / `.panel-section > *` 已统一 `flex-shrink:0`。
- ⚠️ 滚动容器**不要写** `scrollbar-gutter: stable`（UXP 侧会预留槽位却不画滚动条，宿主排版又不扣槽 ⇒ 右对齐原生控件右半截被裁）；**也不要用 `overflow-y: scroll` 兜底**（内容盒被钉死在 220px）。
- ⚠️ **外边距折叠分两种容器**：块容器内相邻外边距会折叠、flex 列容器（`.panel-section`）内**不折叠**。要「减 N px」必须同时归零一侧，否则在会折叠那侧是 no-op。

### 滑块行（跨面板统一 DOM）

```tsx
<div className="row-between" title={helpTexts.xxx.row}>
  <label className="label-4">不透明度</label>
  <RangeSlider className="slider-track" min={0} max={100} step={1}
               value={v} onChange={setV} title={helpTexts.xxx.slider} />
  <div className="row-start">
    <div className="num-input-row">
      <input type="number" min={0} max={100} value={v}
             onChange={(e) => setV(Number(e.target.value))} title={helpTexts.xxx.input} />
    </div>
    <span className="num-unit">%</span>
  </div>
</div>
```

- 滑块**一律用 `src/components/RangeSlider.tsx`**（div 自绘），**禁用 `<input type="range">`**（PS 27.9.1 起原生 range 的 step 失效）。
- 行内滑块用 `.slider-track`（`flex:1 1 auto; min-width:50px`），独立块级用 `.range-slider`；缩进由 `--rs-track-inset` 控制。
- 所有 hover 提示集中在 `src/constants/helpTexts.ts`。

### 浮窗 / 子面板 / 遮挡（本项目交互体系）

- **浮窗必须挂在滚动容器 `.panel` 之外**（APP 挂 `.app-root` 层、工具箱挂 `.pixeladjustment-root` 层，两者 `position:relative`）；**不能用 `createPortal` 挂 `document.body`**（UXP 只渲染 `<uxp-panel>` 子树）。打开期间收起该面板滚动条并补 10px 右内边距。
- **多浮窗 = 单遮罩 `.float-overlay` > 一个 `.float-stack` > 多个 `.float-window`**（**别给每个浮窗各挂遮罩**：会叠暗 + 靠 DOM 顺序互相盖）。顺序由 `state.floatOrder` 决定（后开的排下面），间距 10px 靠相邻兄弟 `margin-top`。
- **层级表**：子面板 9999｜真浮窗 99999（`#app` 下 100000）｜激活弹窗 100001。工具箱「功能快捷键」与浮窗同用 `.float-overlay` ⇒ 它必须显式降到 9999。
- **子面板互斥**：一个父面板可开多个浮窗，但**同时只能开一个子面板**；唯一入口 `app.tsx::setSecondaryPanel(id, open)`（一次 `setState` 写全 5 个 boolean）。
- **body 遮挡类一律「按 state 派生」**（`syncFloatPanelClasses` 在 `componentDidUpdate` toggle），**禁止 imperative add/remove**（复位会绕过 close 方法 ⇒ 悬空类）。**同一 body 类只能有一个派生点**。
- 浮窗打开时**该面板 `number` 输入无条件全量隐藏**（`input-fix.css`，须 `!important`）；规则必须「属主类名 + 属主根节点」成对写。

## 状态样式规则（common.css 底部集中管理区）

1. **状态类只写修饰差异，绝不承载盒模型**。三态写成**共享组选择器**，否则切状态瞬间布局塌陷。
   ```css
   .record-button, .record-button-recording, .record-button-disabled { /* 盒模型全部写这里 */ }
   .record-button-recording { color: rgb(239,83,80); }   /* 只写差异 */
   ```
   常亮态同理：`.icon-button` / `-disabled` / `-latched` 共享盒模型块，各自只加差异声明。
2. **选中/落点一律用 border 变化表达，UXP 禁 `outline`**（也禁 `outline-offset`）。基础类要预挂 `1px solid/dashed transparent` border 占位，保证零位移。选中 `.selected` / `.thumb-selected` / `.select-opt-sel`；落点 `.drop-target` → `2px dashed var(--primary-color)`；拖起 `.dragging` → `opacity:0.5; cursor:grabbing`。
3. **禁用态**：容器盒模型不变，只改 `color:var(--disabled-color)` / `opacity:0.5` / `cursor:not-allowed`。动作按钮的禁用类**必须与基础类同挂一个元素**（`className="action-button-auto action-button-disabled"`）。
4. **描边型图标的 `fill` 与 `stroke` 必须分两条状态规则**（合并会让高特指度的 `fill` 把开放路径填实心）。
5. 「控件不可用」时**不要整行隐藏，改「标签 + 控件」双禁用态**（标签挂 `.label-disabled`，控件传 `disabled`）。

## 新建面板 / 功能的执行清单

1. **先查目录**：打开 `references/component-catalog.md`，确认所需控件已有通用类 → 直接拼装，不新建类。
2. **确实要新类**：命名用**单破折号**，先想「通用的还是面板独有的」→ 通用进 common.css、独有进面板 CSS 并注释。
3. **配色**：只用令牌变量；新色值必须同步写进 theme.ts 四套主题（必要时含遮罩字面值）。
4. **尺寸**：套上表公式，整数像素；间距用 margin/padding，**不用 `gap`**。
5. **接骨架**：套面板高度链，确认滚动容器只有一层 `.panel`。
6. **原生控件**：出现 `input`/`textarea`/`sp-textfield` → 对照 `references/uxp-pitfalls.md` 的穿透规则加隐藏/恢复规则。
7. **状态**：hover/disabled/selected/drop-target 收口到 common.css 底部集中管理区。
8. **改完必做**：`node scripts/_css_comment_guard.cjs`；UDT Reload 实测，四套主题各看一遍。

## 反模式（看到就改）

- ❌ 写 HEX 色值、硬编码 `rgb()` 而不走令牌（遮罩/下拉选中项特例除外，须注释）
- ❌ 用 `gap` / `outline` / 多层 CSS 背景 / `background-repeat` 渐变
- ❌ 新建与既有类近义的新名（曾出现 `notify-banner` 与 `notify-bar` 并存）
- ❌ 状态类里重写 `display` / `width` / `height`
- ❌ 组件内 `<style>` 注入、CSS 里 `@import`（app.css 自身聚合除外）
- ❌ 用 `sp-picker` / `sp-menu` 做下拉 → 用 `src/components/Select.tsx`
- ❌ 用 `<input type="range">` / `sp-radio-group` / `sp-switch`（用自绘 `RangeSlider` / `RadioGroup` / `ToggleSwitch`）
- ❌ 在定高链里插 `height:auto` 的包裹层；给滚动容器加 `scrollbar-gutter`
- ❌ 用 JS `getBoundingClientRect` 结果去算铺满背景的尺寸 → 整数 px 格子过量渲染 + `overflow:hidden`
- ❌ 给每个浮窗各挂一层 `.float-overlay`；用 imperative `classList.add/remove` 管理 body 遮挡类
- ❌ CSS 里写 `:has()`（静默失效）；注释块外留游离文本（会吃掉紧随其后的整条规则）

## 参考文件

- `references/component-catalog.md` — 全量通用类目录 + 可直接复制的 TSX/CSS 片段
- `references/uxp-pitfalls.md` — UXP 渲染/层叠/原生控件坑与已验证解法
- `assets/panel-template.tsx` — 新面板骨架（高度链、分区、滑块行、折叠区、通知、浮层齐全）
