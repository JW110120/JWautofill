# 通用类目录（JWautofill）

来源：`src/styles/common.css`（通用）、`src/adjustments/adjustment.css` 与 `src/styles/pattern.css`（面板独有示例）。
**用法：先在这里找，找到就直接拼装；找不到才按 SKILL.md 的规范新建。**

---

## 1. 面板与分区

| 类 | 作用 | 关键值 |
| --- | --- | --- |
| `.panel` | 面板外壳 + 唯一滚动容器 | `position:relative; padding:10px; height:100%; overflow-y:auto; overflow-x:hidden`；自带 10px 滚动条样式 |
| `.panel-section` | 分区容器（**默认就是 flex 列**，无需加方向修饰类） | `width:100%; flex:0 0 auto; margin-bottom:15px` |
| `.border-panel-section` | 带描边分区 | `padding:10px; border:1px solid var(--border-color); radius 3; margin-bottom:10px` |
| `.main-title` | 面板主标题 | 20px bold 居中 |
| `.subpanel-title-1` / `-2` | 子面板一/二级标题 | 18 bold（space-between 行）/ 15 600 |
| `.copyright` | 底部版权 | 10px `--disabled-color`，上下 padding 10 |

### 分割线
| 类 | 说明 |
| --- | --- |
| `.divider` | 实线 1px，`margin:10px 0`；在 `.border-panel-section` 内自动 `calc(100% + 20px)` 出血 |
| `.divider-dashed` | 虚线（**纯 DOM span 序列**，规避 UXP 渐变/重复背景缺陷）：`<div className="divider-dashed">{[...Array(n)].map((_,i)=><span key={i} className="divider-dashed-dash"/>)}</div>` |
| `.divider-vertical` | 竖线（文字型，内容为「丨」），`margin:0 8px` |

### 折叠分区
```tsx
<div className="collapse-section" data-section-id="mySection">
  <div className="collapse-header" onClick={toggle}>
    <span className={open ? 'collapse-icon-expanded' : 'collapse-icon'}><ExpandIcon/></span>
    <span>分区标题</span>
  </div>
  {open && <div className="collapse-content-expanded">{/* 内容 */}</div>}
</div>
```
⚠️ **折叠内容必须 React 条件渲染（不进 DOM）**，不能靠 `max-height:0 + overflow:hidden`：UXP 下裁不住原生 input（见 pitfalls）。收起态用 `.collapse-content`，展开态用 `.collapse-content-expanded`。

---

## 2. 行容器

| 类 | 布局 |
| --- | --- |
| `.row-between` | `space-between` + `align-items:center`，上下 margin 10 |
| `.row-between-close` | 同上，下边距 2（紧凑） |
| `.row-center` | 居中 |
| `.row-start` | 左对齐（`flex:0 0 auto`） |
| `.row-end` | 右对齐 |
| `.grid-cell` | 两列网格的单元格（`flex:1 1 0; min-width:0; flex-direction:column`，内层放 `.row-start` 行）；取代旧的 `.column-default`。⚠️ 右列（`.grid-cell + .grid-cell`）`align-items:flex-end`（列是 column flex，align-items 让子行收成内容宽后贴内容盒右缘，与左列 stretch+`justify-content:flex-start` 合成「标签靠左·控件靠右」、左右各距面板外缘 10px；早先两列都 flex-start，右列停在二等分中缝上 → 整行看起来左偏） |
| `.field-grow` | 让 `sp-textfield` 等原生控件占满剩余宽（`flex:1 1 auto; min-width:0`） |

已内置的间距规则（**不要重复写 margin**）：
- `.row-between .row-between{margin:0 auto}` + 相邻 `margin-top:10px`（嵌套行不翻倍）
- 两列网格：`.row-between.row-grid{margin:10px auto}`（**必须双类**），单元格内行 `margin:0`，
  相邻网格 `.row-grid + .row-grid{margin-top:10px}`（与复选框组「行距 5+5=10」同档），
  列距由 `.grid-cell + .grid-cell{margin-left:10px}`（UXP 无 flex gap）；
  右列内容贴右缘由 **`.row-grid .grid-cell + .grid-cell{align-items:flex-end}`** 提供
  （左列不用写：默认 stretch，子行 `.row-start` 自带 `justify-content:flex-start` 即贴左缘）。
  ⚠️ **必须用相邻兄弟选择器，不能用 `:last-child`**：只有一个 `.grid-cell` 的网格（图案面板未勾选「阵列」时
  只剩「剪贴蒙版」）会同时命中 `:first-child` 与 `:last-child`，按源码顺序 `flex-end` 胜出 → 唯一那列被推到最右缘
- 网格修饰档 `.row-grid-flush{margin:0 auto}`（紧贴 divider 的复选框组），内层行 `margin:5px 0`
- 网格修饰档 `.row-grid.row-grid-fit`（**必须双类**）：整行 `justify-content:flex-start`，
  **左列** `.grid-cell:first-child{flex:0 0 auto}`（标签 + 开关按内容宽靠左）、
  **右列** `.grid-cell + .grid-cell{flex:1 1 auto; margin-left:5px}` 撑满剩余宽度，
  再由基础的 `align-items:flex-end` 把右列内容（色板 + 齿轮，TSX 用 `.row-end`）推到**内容盒右缘**
  —— 与上一行「清除模式」开关的右缘对齐，行尾不留空档（紧凑模式描边模式行）；
  纵向节奏仍走 `.row-grid` 那套，所以**保留 `.row-grid` 类名**不可替换
- `sp-switch` / `input[type=checkbox]` 在 `.row-between/.row-center/.row-end` 内自动 `margin-left:4px`
- ⚠️ **外边距折叠分两种容器**（2026-09-10 截图像素实测）：
  **块容器**内相邻外边距会折叠（`.collapse-content-expanded` 里 divider 10 + `.panel-section` 15 → 取 15）；
  **flex 列容器**（`.panel-section` / `.border-panel-section`）内**不折叠**，相邻子项各 10px 会叠成 20px。
  要「减 N px」必须**同时归零一侧**，否则在会折叠的那一侧改动是 no-op。
  既有特例：紧凑填充两行网格之间 `.row-grid + .row-grid{margin-top:0}` → 恒 10px（= 复选框组 5+5）；
  工具箱连续行内滑块 `#pixeladjustment .border-panel-section .row-between.slider-row + .row-between.slider-row{margin-top:0}`
  → 20px 收到 10px，与主面板 `.slider-container`（块容器、折叠后 10px）一致。
  ⚠️ **`.slider-row` 是显式类名**（AdjustmentPanel.tsx 13 处行内滑块行；批量加类用脚本按结构特征匹配）。
  不要图省事写成 `:has(.slider-track)` —— **UXP 不支持 `:has()`，整条规则会被静默丢弃**（坑清单 ㉑）。
- ⚠️ **`sp-switch` 原生盒高 32px，可见胶囊只有 14px**（上下各 ~9px 透明留白），会把所在容器撑高：
  含开关的 notify-bar 是 40px（32+padding6+边框2）、纯文字条只有 25px；紧凑网格行 37px vs 复选框行 21px。
  · 需要收紧时：对称负外边距把这份留白让给间距（`.row-grid sp-switch{margin-top:-6px;margin-bottom:-6px}`，
    实测按观感调到 `-10px` 更好）——只让**盒**溢出，胶囊本体（盒内居中）仍落在行内、不会裁切，
    行盒收缩到与复选框行同档；
  · 需要**等高**时：`.notify-bar{min-height:40px}`（锁到含开关那一档，不用 height 以便正文换行时增高）。
- ⚠️ **条件渲染的行内控件会让行高跳变**：紧凑 `.row-grid-fit` 行关闭时右列 `.row-end` 为空（0 高），
  开启时才渲染「色板 20px + 齿轮按钮 24px」→ 行高从 22px（左列标签决定）跳到 24px。
  做法是让这一槽**彻底不参与行高**——把内容摘出文档流：
  ```css
  .row-grid-fit .grid-cell + .grid-cell { position: relative; }
  .row-grid-fit .grid-cell + .grid-cell .row-end {
    position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  }
  ```
  右列没有在流子项 → 高度恒 0 → 行高完全由左列决定，开关前后一模一样（㉒）。
  ⚠️ **不要用对称负外边距**（`margin-top/bottom:-2px`）：它只让盒溢出，行高仍会 22↔24 变，
  本行下方（三列 radio 行、复选框首行）照旧跟着抖 —— 上一版就是踩在这里。
  非紧凑模式无此问题：那里 sp-switch 是原生 32px 盒，行高恒 32。
- **`.row-between.disabled` / `.row-start.disabled`**：整行置灰（标签 `--disabled-color` + `not-allowed`，
  内含 slider/input `opacity .5`）。**由 TSX 按状态挂 `.disabled`**，不要用 `:has()`（UXP 不支持，㉑）；
  现有 4 处：app.tsx 紧凑/非紧凑 × 新建图层/清除模式。

---

## 3. 文本与标签

| 类 | 说明 |
| --- | --- |
| `.label-2 … .label-6` | 按字数定宽：20 / 33 / 47 / 60 / 73px，13px，右 margin 10，nowrap |
| `.label-drag` | 可拖拽标签（+ `cursor:ew-resize`，配合 `src/utils/useLabelDrag.ts`） |
| `.label-disabled` | 文字置灰（也可用父级 `.row-between.disabled` 整行置灰） |
| `.notify-text` | 全插件**唯一**的通知正文定义：12px / 行高 1.4 / 允许换行 / `word-break:break-all` |
| `.copyright` | 底部版权文字 |

⚠️ **定宽公式 `20 + (n-2)×13.3` 整体比汉字实际字宽窄约 6px**（汉字 13px = 13px/字，n=2 实际 26px 却只给 20px），
文字一直靠 `.label-*` 的 `margin-right:10px` 遮着溢出（视觉间隙实际只有 ~4px）。日常行不受影响，但
**凡是要把「标签盒右缘」对齐到容器右缘的新布局（如三列 radio 末项贴右），必须先把标签放宽**
（`.radio-trio sp-radio .label-2{width:26px}`），否则文字会溢出 6px 压到滚动条上。

---

## 4. 滑块（RangeSlider）

```tsx
import RangeSlider from '../components/RangeSlider';
<RangeSlider className="slider-track" min={0} max={100} step={1}
             value={v} onChange={setV} onDragEnd={sync} disabled={false} title={helpTexts.x.slider} />
```
- DOM：`.range-slider` > `.range-slider-track` > `.range-slider-fill` + `.range-slider-thumb`
- `.range-slider`：高 12，轨道 4px 高、圆角 3，thumb 12×12 白色圆点；缩进变量 `--rs-track-inset:6px`
- `.slider-track`：行内版，`flex:1 1 auto; min-width:50px; margin-right:6px`
- 组件内部已处理：点击跳转、拖动、方向键/Home/End、step 吸附、disabled

---

## 5. 数字输入

```tsx
<div className="row-start">
  <div className="num-input-row">
    <input type="number" min={0} max={100} value={v} onChange={...} title={helpTexts.x.input} />
  </div>
  <span className="num-unit">%</span>
</div>
```
- `.num-input-row` 32×24，描边 `--border-color`，底 `--dropdown-bg-color`，`overflow:hidden`
- input 无边框（`border:none`），居中，12px；`input[type=text]` 自动 60px 宽
- **单位符号必须放在容器外**（`.num-unit`，`margin-left:4px`），放容器内会被裁

---

## 6. 按钮

| 类 | 用途 |
| --- | --- |
| `.main-button` + `.main-button-content` + `.main-button-text` | 总开关：`width:80%; height:50px; margin:10px auto 15px`；文字 16 bold |
| `.action-button-N`（N=2…8）/ `.action-button-auto`（>8字）/ `.action-button-quad`（92px 2×2 网格） | 动作按钮，高 30，宽 = 13×字数+20 |
| `.action-button-disabled` | 禁用（`opacity:0.5; cursor:not-allowed`），**必须与基础按钮类同挂** |
| `.close-button` | 子面板关闭：25×25，红底白字（带 `!important`） |
| `.icon-button` / `.icon-button-disabled` | 24×24 图标按钮；hover/禁用只改内部 `.icon-fill`，容器不动；`:active` 缩放 0.94 |
| `.record-button` / `-recording` / `-disabled` | 26×26 圆形录制按钮三态（共享盒模型组） |
| `.circle-button` | 32×32 圆形描边按钮，内含 svg 16×16 |
| `.icon-button-group-bar` | 预览区底部工具条：高 32，`border-top`，`margin-top:auto`，右对齐 |

---

## 7. 选择 / 勾选

### 下拉（唯一实现：`src/components/Select.tsx`）
```tsx
<Select value={v} options={[{value:'a',label:'A',tag:<Icon/>}]}
        groups={[[...],[...]]}   // 与 options 二选一，组间自动分隔线
        onChange={setV} disabled={false} placeholder="请选择" title="..." />
```
- `SelectOption = { value: string; label: string; disabled?: boolean; tag?: React.ReactNode }`
- 类名：`.select-wrap` > `.select-head` / `-head-open` / `-head-disabled`；弹层 `.select-pop`（`position:fixed` + JS 按 head 矩形定位，逃出 overflow 裁剪）；选项 `.select-opt` / `-opt-sel` / `-opt-dis`；`.select-divider`、`.select-value`、`.select-caret`、`.select-check`、`.select-opt-main`、`.select-opt-tag`
- 禁止 `sp-picker` / `sp-menu`

### radio
```tsx
<sp-radio-group className="radio-pair-230" value={v} onchange={...}>
  <sp-radio value="a">选项 A</sp-radio>
  <sp-radio value="b">选项 B</sp-radio>
</sp-radio-group>
```
- 通用：`.panel-section sp-radio-group` 为横向 `space-around`，`sp-radio` 高 32；
  实测 `sp-radio` 实际按**内容宽**摆放（`.panel-section sp-radio{flex:1}` 未生效），间距由父级 `space-around` 分配
- `.radio-pair-230` / `.radio-pair-210`：两列精确贴边（左选项贴左缘 10px，右选项绝对定位贴右缘；230/210 为可用宽档）
- `.radio-trio`：三列（描边「位置」/ 紧凑「填充模式」共用）。
  ⚠️ **防折行的关键不在 `flex-wrap`，在单项宽度**（㉔）：`sp-radio-group` 内部的均分/换行由宿主实现，
  外层怎么写都拦不住。实测**单项外框 76px**（内边距 15 + 圆点 14 + 圆点↔标签 11 + 标签盒 26 + 标签
  自带 10px 右外边距），3 × 76 = 228 > 内容盒 210（无滚动条）/ 200（有滚动条）→ 第三列必折行。
  所以现口径是**从内容侧砍窄**：`sp-radio .label-2{width:22px; margin-right:0}` → 单项 ≈62px、
  三项 ≈186px，两档都留有余量（窄档余 14px）。
  - 结构必须同构：`.panel-section > .radio-trio > sp-radio-group`（两处一致）。
    ⚠️ 描边子面板早期写成 `class="panel-section radio-trio"`（两类同元素），后代选择器不命中。
  - 缩进走容器 `padding:0 10px`（`box-sizing:border-box`），**不要用 `transform: translateX(10px)`**
    —— transform 不参与布局，会算错可用宽。
  - 纵向 10px 由 `.radio-trio{margin:10px auto}` 给（替代原来的 `.row-between` 包裹层）；
    紧凑填充模式那个是分区首元素，用修饰档 `.radio-trio.radio-trio-flush{margin:0 auto}`。
    ⚠️ 不要在 `body.compact-app` 下写 `.radio-trio{margin:0}` 收口：`.radio-trio` 现在也在子面板里，
    而 `#app .app-root > .panel > .panel-section …` 会连带命中描边子面板。
  - `sp-radio-group{justify-content:space-between; flex-wrap:nowrap}` + `sp-radio{flex:0 0 auto}`
    仍然保留（有剩余宽度时均匀分配 / 单项按内容宽不伸缩），但**它们不是防折行的保证**，别依赖。
  ⚠️ `.panel-section/.border-panel-section .radio-trio sp-radio{flex:0 0 auto}`（双类压过 `.panel-section sp-radio`）。
- `.radio-group-vertical`：纵向（每个 `sp-radio` 占满宽）
- ⚠️ radio 内部元素走文档流，**不要绝对定位去 pin 边缘**（sp-radio 影子布局会把 slot 排到右侧）
- ⚠️ 两列/三列 radio 的**文字标签与圆点中心对齐**由
  `sp-radio-group:not(.radio-group-vertical) > sp-radio > span{margin-top:2px}` 统一微调
  （含 `> .row-end > span` 的齿轮行；实测 trio 标签中心比圆点低 1px，2px 的 margin 即 1:1 上移量）

### 其它
- `.checkbox-input`：原生 checkbox，**必须显式给上下 margin**（默认 margin 会撑开行距），网格内被清零
- `sp-switch`：放行内右侧，自动 4px 左间距
- `.color-preview`：20×20 颜色预览，左右 margin 10

---

## 8. 预设区 / 缩略图

| 类 | 说明 |
| --- | --- |
| `.preset-area` | 预设区外壳：高 150，描边，底 `--dark-bg-color` |
| `.pattern-preset` | 预设网格容器：`flex-wrap:wrap; padding:4px; align-content:flex-start; overflow-y:auto` |
| `.thumb-box` | 52×52 方格，内 `img` 46×46 `object-fit:contain` |
| `.pattern-thumb-loading` | 加载/失败遮罩（白底 0.8 + `--black-text-`） |
| `.final-preview-container` / `.preview-wrapper` | 最终预览 300 高，顶部描边分隔 |
| `.final-preview-hint` | 预览区居中灰字提示 |

4 列网格样式（间距 M=4）：
```css
.my-preset .thumb-box { margin-right: 4px; margin-bottom: 4px; }
.my-preset .thumb-box:nth-child(4n) { margin-right: 0; }
.my-preset .thumb-box:last-child { margin-right: 0; margin-bottom: 0; }
```

---

## 9. 通知与状态

| 类 | 用途 |
| --- | --- |
| `.notify` + `.notify-ok` / `.notify-warn` / `.notify-fail` | 块状通知（内放 `.notify-text`） |
| `.notify-bar` + `.notify-bar-ok/-warn/-fail/-disabled` | 单行状态条（状态点 + 正文 + 右侧信息/开关），`min-height:40px; padding:3px 6px; margin-bottom:8px`。`-disabled`（`--disabled-color` 灰描边 + 面板底色）用于「未启用」；**橙 `-warn` 在插件语义里专指异常/待处理，不要拿它表示关闭**。⚠️ `min-height:40px` 是把高度锁到「含 `sp-switch`（32px）」那一档，让含开关的条与纯文字的条**等高**（后者原本只有 25px）；用 min-height 而非 height，正文换行时仍可增高 |
| `.mask-sync-status-spacer` | 状态条内的弹性占位（`flex:1 1 auto`），把右侧操作/开关推到最右。common.css 与 adjustment.css 各有一份定义 |
| 状态条右侧控件 | 优先放 `sp-switch`（`.notify-bar sp-switch{flex:none;margin-left:4px}`）而非文字按钮，跨面板保持一致 |
| `.status-banner` + `.status-banner-ok/-warn/-fail` | 通用横幅（`min-height:30px`，换行时自动增高；顶部激活卡片、底部通知、任务内通知共用） |
| `.notify-text` | 正文（唯一定义） |
| `.indicator` + `.indicator-lg`(13) / `-md`(8) | 状态点基础/尺寸 |
| `.indicator-ok` / `-warn` / `-fail` / `-disabled` | 状态点配色（带同色微光/灰） |
| `.slider-thumb-selected` | 色标选中（放大 1.1 + 2px 主色边） |

---

## 10. 卡片与浮层

| 类 | 说明 |
| --- | --- |
| `.task-card` | 卡片：底 `--entry-bg`，描边，`padding:8px 10px`，`+ .task-card` 自动 `margin-top:10px` |
| `.mask-sync-add-row` | 卡片底部的「+」行（上下居中，`margin:0 auto -10px` 吃掉容器下内边距） |
| `.hotkey-entry-row` | 工具箱列表行：`padding:8px`，底 `--entry-bg`，预挂 `1px solid transparent`；`.selected` 主色边框，`.pinned` 禁拖；内部 `.hotkey-entry-combo` / `.hotkey-entry-name` 各 `flex:1 1 0%` 保证竖线居中 |
| `.float-overlay` + `.float-window` | 通用遮罩 + 浮动窗口（激活弹窗、分区显隐等共用）：遮罩 `padding:10px` → 窗口距面板上/左/右恒 10px；窗口 `overflow-y:auto` + 阴影。**挂载点必须在滚动容器 `.panel` 之外**（APP 挂 `.app-root` 层、工具箱挂 `.pixeladjustment-root` 层，两者都要 `position:relative`），否则被面板滚动条压住 —— 详见 uxp-pitfalls ⑱ |
| `.adjustment-lock-overlay` | 工具箱未激活锁定遮罩 |
| `.pixeladjustment-root` | 工具箱根容器（flex 列，`overflow:hidden`） |

⚠️ 遮罩的 `background-color` **由 theme.ts 注入**，common.css 不写。

---

## 11. 交互状态类（统一收口在 common.css 底部）

| 类 | 视觉 |
| --- | --- |
| `.selected` | 主色 border（基础类预挂 transparent 占位） |
| `.thumb-selected` / `.thumb-multi-selected` | 缩略图 2px 主色 / 橙色边（带 `!important`） |
| `.dragging` | `opacity:0.5; cursor:grabbing`（缩略图 / 预设 / 列表行 / 折叠分区通用） |
| `.drop-target` | `2px dashed var(--primary-color)`（方块类与整行类已分别适配） |
| `.disabled`（挂在 `.row-between` / `.row-start` 上） | 整行置灰 + `cursor:not-allowed`；内部 label / 滑块 / input 自动 0.5 |
| `.action-button-disabled`、`.icon-button-disabled`、`.select-head-disabled`、`.select-opt-dis`、`.checkbox-input:disabled`、`.record-button-disabled` | 各控件禁用态 |

---

## 12. 面板专属文件清单（改样式时先定位）

| 文件 | 承载 |
| --- | --- |
| `src/styles/common.css` | 全局基础（`@font-face`、html/body）+ 全部通用组件 + 底部状态集中管理区 |
| `src/styles/app.css` | `#app` 主面板独有（`.app-root`、`.slider-container`、混合模式行）+ 聚合 colorpanel/gradient/pattern/stroke/input-fix |
| `src/styles/input-fix.css` | 原生可编辑控件的层叠穿透修复、子面板绝对定位铺满 |
| `src/adjustments/adjustment.css` | 工具箱独有（快捷键行、蒙版同步、锁定遮罩） |
| `src/adjustments/adjustment-input.css` | 工具箱输入控件显隐（分区显隐弹窗、未激活锁定） |
| `src/styles/license.css` | 激活弹窗（在 app.css 之后加载） |
| `src/styles/theme.ts` | 四套主题令牌 + 遮罩字面色注入 |
| `src/constants/helpTexts.ts` | 所有 hover `title` 文案 |
