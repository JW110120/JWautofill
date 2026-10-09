# JWautofill 长期记忆

> 展开页（**细节一律下沉到 refs，勿在本文堆实测数据**）：
> - `refs/fill-and-stroke.md` —— 填充/描边/清除 API 铁律（putPixels/getPixels 语义、背景图层解锁还原、
>   clearEnum 不可用面、通道上下文分支 7/8/9、选区生命周期、静默化、拾色器、灰色显示态、子面板入口）
> - `refs/frontend-css.md` —— CSS 铁律细则、紧凑/专注模式、折叠分区纵向节奏、common.css 单一来源、helpTexts 文案规范
> - `refs/uxp-api-layer.md` —— UXP/PS 接口层实测行为 + 性能/React 铁律细则
> - **`refs/busy-gate.md`** —— 忙碌闸门/模态作用域/文档世代号 2026-10-08 重构后的**唯一权威**（先读它）
> - `refs/toolchain-and-env.md` —— 构建/类型检查/菜单/文件 IO/守护进程
> - `refs/pixel-algorithms.md` —— 像素处理器算法详述 + 实测数据
>
> UXP 坑清单（①–㉕）、组件类目录/尺寸公式、新面板模板在**项目技能** `.workbuddy/skills/uxp-frontend-spec/`。
> **改样式/布局/新建面板前先加载技能；改像素处理器前先读 refs；改填充/描边/清除前先读 refs/fill-and-stroke.md。**

## 铁律速查（一句话版；详述一律见 refs）

### 填充 / 描边 / 清除 → `refs/fill-and-stroke.md`
- 清除算法唯一来源 `src/utils/ClearAlgorithms.ts`；PS 的 `multiply` 与插件方向相反 ⇒ 描边走乘法须反相。
- ⛔ `imaging.putPixels` 的 `replace` 默认 `true` ⇒ **局部写会清空整层**；写回一律**文档全尺寸缓冲、不传 `targetBounds`**。
- ⛔ `imaging.getPixels` 四参数：`sourceBounds`（不是 `bounds`）、**不传 `applyAlpha`**、按 `boundsNoEffects` 读、
  回读返回的 `sourceBounds` 定原点、数组形状取 `imageData.width/height`（dispose 前）、不传 `colorProfile`。
- ⛔ 背景图层走「解锁 → 清除 → **finally 还原**」；解锁成败**只信回读 `isBackgroundLayer`**，不看抛错；
  **图层类型转换后一次 DOM 都不能读**（`docId`/图层 id/读区域必须转换前捕获成数字）。
- ⛔ `clearEnum` 在**背景图层 / 锁透明像素**的图层上不可用（PS 弹原生框后按普通填充处理）⇒ 走分支 9 `blendSubtraction`。
- ⛔ 单通道描边必须走分支 7/8（不 `make layer`、还原通道、`blendSubtraction`），分发顺序在像素图层兜底**之前**。
- ⛔ 全部九处 `location._enum` 一律 `strokeLength`；`width` 有意保留两种写法（通道上下文为裸数字），**未经授权不要动**。
- ⛔ 描边色 `color._obj` 必须是 `RGBColor`（`RGBColorClass` 是无效类名）。
- ⛔ `needsStroke` 时必须给填充处理器传 `deselectAfterFill:false`（否则填充提前消费选区 ⇒ 描边失效）。
- ⛔ 静默化只认 batchPlay 的 **options 层**（描述符内 `_options` 会被 `fill`/`stroke` 忽略）。
- ⛔ `showColorPicker` 无参、只认前景色 ⇒ 一律走 `ColorPicker.pickColorWithInitial()`（finally 还原前景色）。
- ⛔ `doc.activeChannels` 在图层蒙版激活时**抛异常** ⇒ 必须独立 try/catch 吞掉后继续（合并探测时勿丢内层 catch）。
- ⛔ 灰色显示态必须覆盖**所有**颜色显示点（含渐变轨道色标），统一走 `getDisplayColorHex(..., grayDisplay)`。
- ⛔ 子面板入口两种形态（普通模式齿轮 / 紧凑模式 label），紧凑作用域 5 → **6**（+clear）五处同步。
- ⛔ 控件不可用时**不要整行隐藏**，改「标签 + 控件」双禁用态。

### CSS / 样式 → `refs/frontend-css.md`
- ⛔⛔⛔ CSS 注释块外**游离文本**会被当成选择器、静默吃掉紧随其后的整条规则 ⇒ 改完必须机器校验
  （`node outputs/_css_comment_guard.cjs`）；**「反复改却毫无效果」立即停手，先验证规则是否命中元素**。
- ⛔ 「标签随控件同步置灰」**跨文件时必须用两级类**：`common.css` 是静态 `<link>`，`app.css` 由 style-loader
  运行时后注入 ⇒ 同为 (0,1,0) 时 app.css 的 `color` 会盖掉 `.label-disabled`（写成 `.app-xxx.label-disabled`）。
  同文件内（如 common.css 的 `.label-4` + `.label-disabled`）靠后置规则即可，无需两级。
- ⚠️ UXP 不支持 `:has()`（静默失效）；UXP flex 容器隐式 `center`；间距统一用 margin+padding（`gap` 不可靠）。
- ⚠️ 原生 `sp-radio-group` / `sp-switch` 不可控 ⇒ 一律用自绘 `RadioGroup.tsx` / `ToggleSwitch`；
  替换原生控件必须核对调用方从事件对象取哪个属性（`try/catch` 会把异常伪装成「点击无响应」）。
- ⚠️ 「元素没占满容器」要查**整条祖先链每层的 padding/border/margin（尤其两层叠加）**；
  「两组控件双向对齐」的唯一可靠做法 = **让两组总宽相等**（不是加 padding 去凑）。
- ⚠️ 间距令牌取「**盒对齐**」不取「墨迹对齐」；折叠分区「标题→首行」间距 = 标题 `padding-bottom` + 首元素自身 `margin-top`。
- ⚠️ 改版式前用像素脚本量用户截图（本仓截图 1.5×、内容盒 230px）；headless 测量台必须复刻完整祖先链。
- ⚠️ 数字输入框与单位符号必须定宽（`.num-input-row` 34px / `.num-unit` 16px；更宽变体走显式类）。
- ⚠️ 颜色一律走 CSS 令牌（`--primary-color` / `--entry-bg` / `--border-color` / `--text-color` / `--hover-bg` /
  `--bg-color` / `--notify-*` / `--spectrum-global-color-*`），**禁硬编码 HEX**；对比度 ≥ WCAG 4.5:1；三档主题 darkest/dark/light。

### 跨面板共享状态（专注模式 / 主开关）→ `refs/uxp-api-layer.md`
- ⛔ **两个面板同上下文**：`#app` 与 `#pixeladjustment` 在**同一 HTML 文档、同一个 bundle**
  ⇒ `FocusModeBus` / `MainToggleBus` 的模块级 `cached` 是**跨面板共享**的（设计前提，改动前务必确认）。
- ⛔⛔ **订阅/轮询的去重基线绝不能用共享缓存播种**：`let last = cached?.focus ?? null` 会让
  「缓存值恰好 == 文件值」时首次回调永不触发 ⇒ 订阅方 `useState` 初值成为最终值且**永不纠正**
  （曾致「专注模式已开但功能快捷键面板显示『选区填充开关』」）。必须从 `null` 起（=「未知」）。
- ⛔ **读不到 ≠ 为false**：`readRaw()` 返回 null 时**本轮不表态**（不更新 `last`），
  否则会把订阅方从 true 硬拽回 false。
- ⛔ **`setState` 之后立刻读 `this.state` 拿到的是旧值**（React 19 自动批处理）：
  启动期算派生结论必须由「合并后的局部变量」显式传入（`syncFocusMode(explicit)`），别读 `this.state`。
- ⚠️ 共享状态台架（`analysis/focus-mode/repro.mjs`，tsc 就地转译 + 内存 UXP FS 跑真实代码）：
  **每场景必须独立模块实例**（模块级 `cached`/`writeChain` 会跨场景造假失败）；
  内存 FS 必须实现 `folder.createFile`（缺了被源码 `catch` 吞掉、只更内存不落盘）。
  支持 `node repro.mjs <旧版路径>` 做**对照实验**验台架有鉴别力。

### 性能 / React / 闸门 → `refs/uxp-api-layer.md` + **`refs/busy-gate.md`**（闸门 2026-10-08 重构，先读它）
- ⛔⛔ UXP 交互延迟的主因是**串行同步 IPC 往返**，不是像素计算（`app.activeDocument` / `layer.bounds` 每次读 = 一次往返；
  **batchPlay 数组整体只算一次**）。填充提速只能来自「读一次复用 + 合并无依赖命令」，**不能来自缩短等待**。
- ⛔⛔⛔ **闸门是三件套**：① 粗筛 `isPsBusy()`（快速失败）；② **文档级「持续忙碌」闩锁**
  （`beginDocLatch` / `extendDocLatch` / `endDocLatch`；**闩锁期间 `isPsBusy()` 恒为真**）——
  时间常数堵不住「打开/关闭/保存大文档要好几秒」；③ `psAccess.psRead()` 的模态作用域兜底。
  **会打断用户操作、失败即弹框的读取必须走 `psRead`**；后台轮询可只用粗筛。填充的「快」走 `fillReadyRemain()`。
- ⛔⛔ **闩锁的释放判据是「能不能拿到模态锁」，不是时间**：`psAccess.probeHostIdle()`
  = 一次**只拿锁、不读任何数据**的空 `executeAsModal`（拿不到只是可捕获异常，不会弹框）。
  触发入口 = `pollDocIdentity`（闩锁期间唯一允许继续跑的通路）。`DOC_LATCH_MAX_MS`(30s) 兜底 + 5s 冷却防活锁。
- ⛔⛔ **`psRead` 遇宿主模态冲突（`error.number === 9` 或消息含 `modal`）⇒ 延长闩锁 + 返回失败，
  绝不降级裸读**（旧 `already in a modal` 直读兜底**已删除**——宿主忙碌期的裸 get 正是弹框来源）。
- ⛔⛔ **同步裸读必须在入口判 `isPsBusy()`**（闩锁期间它们就靠这一句被挡住）：
  `getLayerSnapshot()` 返回缓存不遍历、`MaskSyncEngine.refreshActiveDoc()` 返回 false、
  `buildLayerTree` 无快照时返回 `[]`、`AdjustmentPanel` 的刷新回调保持现状（**别清空下拉**）。
- ⛔⛔ **禁止把多条「可能失败」的 get 合并进同一 batchPlay**（一条失败连带整批；宿主原生弹框绕过 JS try/catch）。
- ⛔ **「顺延上限用尽即硬闯」禁止**（三旧出口已铲，台架 B1 盯着）；读取方**不得** `markPsBusy` 自我预留（自锁来源）；
  `executeAsModal` **不可嵌套** ⇒ `psRead` 先判 `core.isModal()`（文档语义 = **本插件**是否在模态态，含 `readonlyDepth` 兜底）。
- ⛔ 宿主原生「命令"获取"当前不可用」绕过 try/catch 与 dialogOptions ⇒ 防护两层：① **通知回调内零 IPC**
  （只允许 `invalidate*`）；② **模态作用域内读取**。⛔ **`open` / `close` / `save` 必须监听**（曾无人注册 ⇒ 开关/保存文档全程无闸门）；
  注册一律走 `addPsNotificationListeners`（逐名容错）。⛔ 文档级变化两入口：事件通路 + `pollDocIdentity` 兜底巡检。
- ⛔ 宿主事实（Adobe 文档 + 论坛现场证据）：`executeAsModal` 25.10 起是**排队重试**（`timeOut` **默认 1 秒**）而非立即拒绝，
  冲突错误码 = `9`；**PS 执行 `open`/`close`/`save` 时握着模态作用域，而 `open` 正是在该作用域内派发的** ⇒ 收到即读必被拒。
- ⚠️ 无条件 `setInterval` 读文档/get 的轮询必须 `if (isPsBusy()) return`；防抖必须**真防抖**（节流会丢弃事件）。
  `readCurrentToolId` 里的 `getSelectedBrushToolEnum`（裸 batchPlay get）已移进 `psRead`。
- ⚠️ 图层树只读一份快照（`getLayerSnapshot`）；`getActiveLayerInfo` = 世代号 + 300ms TTL 缓存（满读取走 `psRead`）。
- ⚠️ 大列表 `options` 必须 `useMemo` + 组件 `React.memo`（**永远不要在 JSX 里现 map**）。
- ⛔⛔ 组件内 `useMemo`/JSX 调用**组件体内更下方**声明的 `const` ⇒ 白屏（es5 下 `const`→`var` 提升；编译/webpack 都查不出）
  ⇒ **纯函数一律放模块级**。
- ⚠️ `ts-loader transpileOnly:true` ⇒ 类型缺陷永不阻塞构建 ⇒ **新增跨组件共享字段必须同步补 `types/state.ts` 接口**。
- ⚠️ 父面板复位要覆盖子面板内部 state ⇒ 用 `resetToken` 自增（写在 `...initialState` **之后**）；复位前先清「选中预设」。
- ⚠️ 启动期一次性 PS 加载必须走 `runWhenIdle`。

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
