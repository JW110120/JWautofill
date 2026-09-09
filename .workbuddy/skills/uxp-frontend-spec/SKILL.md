---
name: uxp-frontend-spec
description: JWautofill（Photoshop UXP 插件）前端 UI 设计规范。在新建面板/分区/控件、新增或改写 CSS/TSX、调整主题配色与间距、review UI 一致性、排查 UXP 渲染异常（原生控件穿透、滚动失效、样式不生效）时使用。内容涵盖主题令牌、尺寸公式、通用类名目录、标准 DOM 骨架、状态样式规则与 UXP 避坑清单。
agent_created: true
---

# JWautofill UXP 前端设计规范

本规范从 `src/styles/common.css`、`src/styles/app.css`、`src/styles/input-fix.css`、
`src/adjustments/adjustment.css`、`src/adjustments/adjustment-input.css`、`src/styles/theme.ts`
提炼而成，目标是：**新建任何面板/功能时，不发明新样式，只按本规范拼装既有类。**

## 何时使用

- 新建面板、子面板、折叠分区、设置区块
- 新增/修改任何控件（滑块、数字输入、按钮、下拉、开关、勾选、缩略图、通知）
- 改动配色、间距、字号、圆角等视觉参数
- UI 一致性 review、样式漂移排查
- UXP 渲染异常排查（原生 input 穿透、滚动条不出现、var() 不解析、子面板被压）

## 三条铁律

1. **单一来源**：通用组件样式只存在于 `src/styles/common.css`。面板 CSS（`app.css` / `adjustment.css` / `pattern.css` 等）**只写该面板独有的类**。发现通用样式散落在面板文件 → 收口回 common.css 并改通用类名。新增类前先在 common.css 里搜近义类（历史上出现过 `notify-banner` 与 `notify-bar` 并存的坑）。
2. **加载顺序**：`index.tsx` 顶部顺序为 `uxpPerfPatch → common.css → app.css → license.css`，**严禁 `@import`**（除 `app.css` 聚合本面板的 colorpanel/gradient/pattern/stroke/input-fix）。新 CSS 必须挂进这条链，不能靠组件内 `<style>`（注入时机最晚，层叠失控）。
3. **禁 HEX**：一切颜色走 `rgb()` / `rgba()` + 主题变量。唯一例外：遮罩与下拉选中项这类 UXP 下 `var()` 解析不稳定的位置，用与主题等价的字面 `rgb()`，并在注释里写明原因。

## 设计令牌（src/styles/theme.ts）

四套主题：`darkest / dark / light / lightest`，由 `prefers-color-scheme` 媒体查询覆盖。加新颜色**必须四套都写**，否则某主题下会退化成无样式。

| 变量 | 用途 | darkest / dark / light / lightest |
| --- | --- | --- |
| `--primary-color` | 主色蓝（滑块填充、选中、聚焦边框、落点虚线） | 四套恒定 `rgb(38,128,235)` |
| `--bg-color` | 面板/页面底色 | 50 / 83 / 184 / 240 |
| `--dark-bg-color` | 预览区、预设区底（比底色更深一档） | 30 / 63 / 164 / 220 |
| `--entry-bg` | 列表行/卡片行背景（与底色形成反差） | 64 / 97 / 168 / 222 |
| `--border-color` | 一切描边、分割线 | 95 / 128 / 140 / 196 |
| `--text-color` | 正文文字 | 214 / 215 / 37 / 48 |
| `--disabled-color` | 禁用文字/图标 | 80 / 100 / 151 / 194 |
| `--button-bg` / `--button-down` | 按钮常态 / 按下 | 60-40 / 93-73 / 194-174 / 250-230 |
| `--hover-bg` | hover 背景（主色低透明） | 0.1 / 0.2 / 0.3 / 0.35 |
| `--hover-icon` | 图标 hover 填充 | 见 theme.ts |
| `--dropdown-bg-color` | 下拉头/弹层、数字输入框底 | 32 / 57 / 218 / 255 |
| `--enabled-text-color` | 主按钮「功能开启」态文字（深主题白、浅主题黑） | 白 / 白 / 黑 / 黑 |
| `--link-color` | 超链接（不要复用 primary-color：中蓝在深底发暗） | 122,190,255 / 140,200,255 / 0,90,200 / 0,82,190 |
| `--notify-ok-fg/-bg/-border` | 成功态（文字/底/边） | 四套见 theme.ts |
| `--notify-warn-fg/-bg/-border` | 警告态 | 同上 |
| `--notify-fail-fg/-bg/-border` | 失败态 | 同上 |
| `--scrollbar-thumb` / `--scrollbar-track` | 滚动条 | 见 theme.ts |
| `--slider-bg` / `--black-text-` | 滑块轨道 / 深底上的深色字 | 见 theme.ts |

**遮罩特例**：`.float-overlay` / `.adjustment-lock-overlay` 的背景**由 theme.ts 按主题直接注入字面 rgba，不透明度恒为 0.80**（darkest 纯黑 → dark/light/lightest 逐级中性灰）。common.css 里**绝不写**这两类的 `background-color`，也不要用 `var(--overlay-scrim)`（该变量仅作文档同步，实际不参与渲染）。改遮罩只改 theme.ts 那一处。

## 度量公式（整数像素，禁止小数）

| 对象 | 公式 / 定值 |
| --- | --- |
| 面板宽 | 250（manifest）− `.panel` padding 10×2 = **230 可用宽** |
| 行容器宽 | `calc(100% - 20px)` 或 `width:100%` 挂在带 10px padding 的容器内 |
| 文字标签 `.label-N` | W(n) = 20 + (n−2)×13.3 → 2/3/4/5/6 字 = 20/33/47/60/73px；`font-size:13px`，右 margin 10px |
| 动作按钮 `.action-button-N` | W = 13×字数 + 20 → 2:46 3:59 4:72 5:85 6:98 7:111 8:124；高 30px |
| 超长按钮 | `.action-button-auto`（>8 字，`width:auto; padding:0 10px`） |
| 数字输入 | 容器 `.num-input-row` 32×24（含 1px 描边）；`input` 32×24，文字型 60 宽；单位 `.num-unit` 在容器外，`margin-left:4px` |
| 图标按钮 | `.icon-button` 24×24；`.record-button` 26×26 圆；`.circle-button` 32×32 圆；图标 `.icon-14` 14×14 |
| 缩略图 | `.thumb-box` 52×52（内图 46×46） |
| 间距 | 面板 padding 10；`.panel-section` 下边距 15；`.border-panel-section` padding 10 + 下边距 10；`.divider` 上下 10；行容器 `.row-*` 上下 10（紧凑版 `.row-between-close` 下 2） |
| 圆角 / 描边 | 一律 `border-radius:3px`、`border:1px solid var(--border-color)` |
| 字号 | 主标题 20 / 子面板一级 18 / 二级 15 / 主开关 16 / 正文与标签 13 / 控件与通知 12 / 辅助信息 11 / 版权 10 |
| 预设网格 | 4 列：内宽 228 − 容器 padding 4×2 = 220 = 4×52 + 3×4（B=52、M=4），`:nth-child(4n){margin-right:0}` 锁列 |

## 标准骨架

### 面板高度链（滚动命脉，断一层就滚不动）

```
#app / #pixeladjustment (height:100%)
  └─ Provider height="100%"        ← 必须显式给，否则中间那层 div 是 height:auto
      └─ .app-root / .pixeladjustment-root (100%)
          └─ .panel                 ← 唯一滚动容器：height:100% + overflow-y:auto
              └─ .panel-section     ← flex 列，flex:0 0 auto
```

- 新增任何包裹层都必须给高度，不能裸 `height:auto` 夹在定高链中间；每层铺 `background-color: var(--bg-color)`，否则露出下层。
- `.panel > *` / `.panel-section > *` 已统一 `flex-shrink:0`，不需要自己再写。

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

- 滑块**一律用 `src/components/RangeSlider.tsx`**（div 自绘），**禁用 `<input type="range">`**：PS 27.9.1 起 UXP 换 Drover 后端，原生 range 的 step 失效（只在 min/max 间跳变）。
- 行内滑块用 `.slider-track`（`flex:1 1 auto; min-width:50px`），独立块级滑块用 `.range-slider`。轨道缩进由 `--rs-track-inset`（默认 6px）控制。
- 所有 hover 提示文案集中在 `src/constants/helpTexts.ts`，不要散写字符串。

## 状态样式规则（common.css 底部「通用状态样式」集中管理区）

1. **状态类只写修饰差异，绝不承载盒模型**。三态（基础/展开/禁用、基础/选中/禁用…）必须写成**共享组选择器**，否则切状态瞬间布局塌陷（历史上踩过两次：录制按钮退化成 `display:block`、下拉头高度失控）。
   ```css
   .record-button, .record-button-recording, .record-button-disabled { /* 盒模型全部写这里 */ }
   .record-button-recording { color: rgb(239,83,80); }   /* 只写差异 */
   ```
2. **选中/落点一律用 border 变化表达，UXP 禁 outline（也禁 outline-offset）**。基础类要预先挂 `1px solid/dashed transparent` border 占位，保证零位移。
   - 选中：`.selected`（主色边框）、`.thumb-selected`（2px 主色）、`.select-opt-sel`（主色底+白字）
   - 落点：`.drop-target` → `2px dashed var(--primary-color)`
   - 拖起：`.dragging` → `opacity:0.5; cursor:grabbing`
3. **禁用态**：容器盒模型不变，只改 `color:var(--disabled-color)` / `opacity:0.5` / `cursor:not-allowed`。动作按钮的禁用类必须与基础按钮类**同挂一个元素**（`className="action-button-auto action-button-disabled"`），单挂会丢盒模型。
4. hover 图标类只改内部 `.icon-fill` 的 `fill`，容器尺寸不动。

## 新建面板 / 功能的执行清单

1. **先查目录**：打开 `references/component-catalog.md`，确认所需控件已有通用类 → 直接拼装，不新建类。
2. **确实要新类**：命名用**单破折号**（`my-thing`），禁双破折号；先问自己「这是通用的还是面板独有的」→ 通用进 common.css，独有进对应面板 CSS，并在文件头注释里写明。
3. **配色**：只用令牌变量；新色值必须同步写进 theme.ts 的四套主题（必要时含遮罩那处字面值）。
4. **尺寸**：套用上表公式，整数像素；间距用 margin/padding，**不用 gap**（UXP 不可靠）。
5. **接骨架**：套上面板高度链，确认滚动容器只有一层 `.panel`。
6. **原生控件**：面板里出现 `input` / `textarea` / `sp-textfield` → 立刻对照 `references/uxp-pitfalls.md` 的穿透规则加隐藏/恢复规则。
7. **状态**：hover/disabled/selected/drop-target 全部收口到 common.css 底部集中管理区。
8. **改完必做**：UDT Reload 实测，四套主题各看一遍。

## 反模式（看到就改）

- ❌ 写 HEX 色值、硬编码 `rgb()` 而不走令牌（除遮罩/下拉选中项特例并带注释）
- ❌ 用 `gap` / `outline` / 多层 CSS 背景 / `background-repeat` 渐变
- ❌ 新建 `notify-banner`、`panel-box` 这类与既有类近义的新名
- ❌ 状态类里重写 `display` / `width` / `height`
- ❌ 组件内 `<style>` 注入、CSS 里 `@import`（app.css 自身聚合除外）
- ❌ 用 `sp-picker` / `sp-menu` 做下拉（弹层背景在 UXP 下无法覆盖）→ 用 `src/components/Select.tsx`
- ❌ 用 `<input type="range">`
- ❌ 在定高链里插 `height:auto` 的包裹层
- ❌ 用 JS `getBoundingClientRect` 结果去算铺满背景的尺寸（不可靠）→ 整数 px 格子过量渲染 + `overflow:hidden`

## 参考文件

- `references/component-catalog.md` — 全量通用类目录 + 可直接复制的 TSX/CSS 片段
- `references/uxp-pitfalls.md` — UXP 渲染/层叠/原生控件坑与已验证解法
- `assets/panel-template.tsx` — 新面板骨架（高度链、分区、滑块行、折叠区、通知、浮层齐全）
