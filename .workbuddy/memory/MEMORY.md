# JWautofill 长期记忆

> 展开页（**细节一律下沉到 refs，勿在本文堆实测数据**）：
> - `refs/frontend-css.md` —— CSS 铁律细则、紧凑/专注模式、折叠分区纵向节奏、common.css 单一来源、helpTexts 文案规范
> - `refs/uxp-api-layer.md` —— UXP/PS 接口层实测行为 + 性能/React 铁律细则（同步 IPC、忙碌闸门、缓存、memo、TDZ）
> - `refs/toolchain-and-env.md` —— 构建/类型检查/菜单/文件 IO/守护进程
> - `refs/pixel-algorithms.md` —— 像素处理器算法详述 + 实测数据
>
> UXP 坑清单（①–㉕）、组件类目录/尺寸公式、新面板模板在**项目技能** `.workbuddy/skills/uxp-frontend-spec/`。
> **改样式/布局/新建面板前先加载技能；改像素处理器前先读 refs。**

## 铁律速查（详述见 refs）

### 填充 / 描边（2026-10-08 新增）
- ⛔ **填充路径会「提前消费选区」**：`PatternFill` / `GradientFill` / `ClearHandler` / `SingleChannelHandler`
  写回像素时用 `imaging.putSelection` 覆盖选区，且**仅在 `state.deselectAfterFill === false` 时才还原**。
  该开关默认 `true` ⇒ 填充返回后选区已空，紧随的 `strokeSelection` 无从下手（= 描边「失效」）。
  ⇒ **只要 `needsStroke`，就必须给填充处理器传 `{...this.state, deselectAfterFill:false}`**（填充保留选区，
  描边后再由 app 层统一 `deselectSelection()` 兑现用户的「自动删选区」）。
- ⛔⛔ **描边 API 形状以「监听到的调用」为准，不得凭外部检索推翻**：PS **自身**下发的 `stroke`
  描述符 = **裸数字 `width`** + `location._enum: "strokeLength"`（Alchemist 监听截图，PS 27.8.0 r13 /
  UXP 9.3.0；图存 `.workbuddy/clipboard-images/`）。**现场证据（用户截图/监听）永远优先于 web 检索。**
- ⛔ **`StrokeSelection.ts` 六处 `location._enum` 一律 `strokeLength`**（2026-10-08 用户拍板；
  原先 5 处 `strokeLocation` 属历史遗留，已统一 5 处）。⚠️ `width` **有意保留两种写法**：快速蒙版两支
  （分支 3/4）为裸数字（同监听），其余四支 `{pixelsUnit}` —— **未经授权不要动 `width`**。
  核对台 `outputs/stroke_matrix_verify.cjs` / `stroke_mode_matrix_verify.cjs` 的 ① 组为**逐分支快照**
  （枚举已统一，`width` 不要求同形）。
- ⚠️ 隐藏的一条同源路径：像素图层「图案/渐变 + 清除」走 `ClearHandler.applySelectionAndDelete`，
  它前面的 `putSelection` 会把选区**改写成待删除掩码**（`getSelectionData()` 内部还先取消一次）
  ⇒ 必须同样按 `deselectAfterFill === false` 还原原选区，否则描边沿掩码走。
  ⚠️ `ClearHandler.ts` 是 **CRLF** 文件，Edit 工具多行匹配会失败 ⇒ 用脚本 LF 归一化后按锚点替换再写回 CRLF。
  核对台：`outputs/stroke_mode_matrix_verify.cjs`（67 项；**从真实源码切出编排片段执行，不复刻逻辑**）。

### CSS / 样式
- ⛔⛔⛔ CSS 注释块外的**游离文本**会被当成选择器、静默吃掉紧随其后的整条规则
  ⇒ ① 编辑中文注释不移动/重复注释结束符，注释正文禁出现其字面两字符形式；
  ② 改完 CSS 必须机器校验注释开/闭配对；③ **「反复改却毫无效果」立即停手，先验证规则是否命中元素**。
- ⚠️ UXP 不支持 `:has()`（静默失效、不报错）；UXP flex 容器隐式 `center`；间距统一用 margin+padding（`gap` 不可靠）。
- ⚠️ 原生 `sp-radio-group` / `sp-switch` 不可控 ⇒ 一律用自绘 `RadioGroup.tsx` / `ToggleSwitch`。
- ⚠️ 替换原生控件必须核对**调用方从事件对象取哪个属性**（`try/catch` 会把异常伪装成「点击无响应」）。
- ⚠️ 「元素没占满容器」要查**整条祖先链每层的 padding/border/margin（尤其两层叠加）**；
  「两组控件双向对齐」的唯一可靠做法 = **让两组总宽相等**（不是加 padding 去凑）。
- ⚠️ 折叠分区「标题→首行」间距 = 标题 `padding-bottom` + 首元素自身 `margin-top`
  （`.panel-section` 无 margin-top ⇒ 当首元素必少 10px）；**间距令牌取「盒对齐」不取「墨迹对齐」**。
- ⚠️ 改版式前用像素脚本量用户截图（本仓截图 1.5×、内容盒 230px）；headless 测量台必须复刻完整祖先链。
- ⚠️ 数字输入框与单位符号必须定宽（`.num-input-row` 34px / `.num-unit` 16px；更宽变体走显式类）。
- ⚠️ 颜色一律走 CSS 令牌（`--primary-color` / `--entry-bg` / `--border-color` / `--text-color` / `--hover-bg` /
  `--bg-color` / `--notify-*` / `--spectrum-global-color-*`），**禁硬编码 HEX**；对比度 ≥ WCAG 4.5:1；三档主题 darkest/dark/light。

### 性能 / React
- ⛔⛔ UXP 交互延迟的主因是**串行同步 IPC 往返**，不是像素计算
  （每次 `app.activeDocument` / `layer.bounds` 属性读 = 一次往返；**batchPlay 数组整体只算一次**）。
- ⛔⛔⛔ **`isPsBusy()` 是全局共享闸门（9 处消费者）** ⇒ 全局窗口恒 300/1200ms、**永不为提速缩短**；
  填充提速只能走私有 `fillReadyRemain()`（不变量 `fillReadyRemain() ≤ psBusyRemain()`）。
- ⛔⛔ **禁止把多条「可能失败」的 get 合并进同一 batchPlay**（一条失败连带整批；宿主原生报错框绕过 JS try/catch）。
- ⚠️ PS 原生对话框只认 batchPlay 的 options，**不认描述符内 `_options`**（`StrokeSelection.ts` 全部 16 处两处都写）。
- ⚠️ 改 `LayerInfo` 禁止为某个 kind 特例跳过读取（省 IPC 只能靠「读一次复用」）。
- ⚠️ 图层树只读一份快照（`getLayerSnapshot`）；**通知回调内零 IPC**（只允许 `invalidateLayerSnapshot()`）。
- ⚠️ `getActiveLayerInfo` 有 300ms TTL 缓存（key = 活动图层 id；**纯选区 set 刻意不失效**）。
- ⚠️ 大列表 `options` 必须 `useMemo` + 组件 `React.memo`（**永远不要在 JSX 里现 map**）；
  面板是「单组件 + 一个 return」⇒ 折叠代价按 O(分区数 × 控件数) 估。
- ⛔⛔ 组件内 `useMemo`/JSX 调用**组件体内更下方**声明的 `const` ⇒ 白屏
  （es5 下 `const`→`var` 提升，报 `is not a function`；编译/webpack 都查不出）⇒ **纯函数一律放模块级**。
- ⚠️ `ts-loader transpileOnly:true` ⇒ 类型缺陷永不阻塞构建 ⇒ **新增跨组件共享字段必须同步补 `types/state.ts` 接口**。
- ⚠️ 父面板复位要覆盖子面板内部 state ⇒ 用 `resetToken` 自增（写在 `...initialState` **之后**）；
  复位前先清「选中预设」，**不动 presets/patterns 列表**。
- ⚠️ 启动期一次性 PS 加载必须走 `runWhenIdle`（一次性加载传**有限** `maxDeferrals`）；
  通知回调内禁任何同步 DOM 读取（原生弹框绕过 try/catch，唯一防护是「不发 get」）。

### 环境 / 工具链
- 见 `refs/toolchain-and-env.md`（构建命令、tsc 校验、菜单项「只置灰不删」、UXP 无 `fs`、Edit 假成功、守护进程）。

## 像素算法（细则、推导与实测数据一律见 `refs/pixel-algorithms.md`）
- 写回型处理器两条边界铁律：区域判定**只用选区掩码>0**；采样到「RGBA 全 0」的数据缺失点必须**用中心像素边缘延拓**。
- alpha 对齐 `alphaAlignProcessor.ts` 现为 **v10 三档整片归一**（v1~v9 五条路线已全部推倒，**勿重走**）；
  唯一例外：v5「多尺度环带参照」以「极值微调」按钮复活（线条污渍专用）。
- 消除锯齿 `aliasSmoothProcessor.ts`：覆盖率重建 + EDT 本体传播 + 墨量守恒；细线 ≤4px 走几何重建。
- 「仅主线条」`lineSmoothProcessor.ts` 现为 **V7 中轴重建**；加新参数必须同步 **10 处**（清单见 refs）。
- ⚠️ 构建不做类型检查 ⇒ 像素算法的参数/转发缺陷只会**静默失效**（改完必须端到端跑一遍台架）。
- 台架均在 `analysis/line_vis/`（⚠️ `accept_v7.mjs` 产出路径相对 CWD ⇒ **必须从仓库根运行**）；
  改完必须同时报「回归 diff vs 旧版」与「作用量 vs 原图」。
