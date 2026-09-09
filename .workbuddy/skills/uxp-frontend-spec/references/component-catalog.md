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
| `.column-default` | 纵向列容器 |
| `.field-grow` | 让 `sp-textfield` 等原生控件占满剩余宽（`flex:1 1 auto; min-width:0`） |

已内置的间距规则（**不要重复写 margin**）：
- `.row-between .row-between{margin:0 auto}` + 相邻 `margin-top:10px`（嵌套行不翻倍）
- `.row-between.checkbox-grid{margin:0 auto}`，网格内行 `margin:5px 0`、同列相邻行 `margin-top:15px`
- `sp-switch` / `input[type=checkbox]` 在 `.row-between/.row-center/.row-end` 内自动 `margin-left:4px`

---

## 3. 文本与标签

| 类 | 说明 |
| --- | --- |
| `.label-2 … .label-6` | 按字数定宽：20 / 33 / 47 / 60 / 73px，13px，右 margin 10，nowrap |
| `.label-drag` | 可拖拽标签（+ `cursor:ew-resize`，配合 `src/utils/useLabelDrag.ts`） |
| `.label-disabled` | 文字置灰（也可用父级 `.row-between.disabled` 整行置灰） |
| `.notify-text` | 全插件**唯一**的通知正文定义：12px / 行高 1.4 / 允许换行 / `word-break:break-all` |
| `.copyright` | 底部版权文字 |

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
- 通用：`.panel-section sp-radio-group` 为横向 `space-around`，`sp-radio` 高 32
- `.radio-pair-230` / `.radio-pair-210`：两列精确贴边（左选项贴左缘 10px，右选项绝对定位贴右缘；230/210 为可用宽档）
- `.radio-group-vertical`：纵向（每个 `sp-radio` 占满宽）
- ⚠️ radio 内部元素走文档流，**不要绝对定位去 pin 边缘**（sp-radio 影子布局会把 slot 排到右侧）

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
| `.notify-bar` + `.notify-bar-ok/-warn/-fail` | 单行状态条（状态点 + 正文 + 右侧信息），`padding:3px 6px; margin-bottom:8px` |
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
| `.float-overlay` + `.float-window` | 通用遮罩 + 浮动窗口（激活弹窗、分区显隐等共用）：遮罩 `padding:10px` → 窗口距面板上/左/右恒 10px；窗口 `overflow-y:auto` + 阴影 |
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
