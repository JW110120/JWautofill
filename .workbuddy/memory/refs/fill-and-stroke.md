# 填充 / 描边 / 清除 —— API 铁律详述（JWautofill）

> 从 `MEMORY.md` 下沉（2026-10-08，控制体积）。改任何填充/描边/清除相关代码前先读本文件。
> 相关台架：`outputs/clear_pixel_geometry_verify.cjs`（203 项）、`outputs/stroke_mode_matrix_verify.cjs`（184 项）、
> `outputs/stroke_matrix_verify.cjs`（25 项）、`outputs/fill_ipc_audit.cjs`（信息性）、`outputs/gate_verify.cjs`（忙碌闸门场景断言）。

## 清除算法

- ⛔ **清除算法的唯一来源 = `src/utils/ClearAlgorithms.ts`**（三类：背景图层 `背景提亮|减法变黑|乘法变黑`、
  黑白通道 `减法|乘法`、像素图层 `减法|乘法`）。三者由 `state.clear{Background,Channel,Layer}Algorithm`
  承载，UI 在**清除设置子面板**（`ClearSetting.tsx` / `clear.css`）。改公式只改这一个文件。
  ⚠️ PS 的 `multiply` 是 `C × S/255`（S 越暗删得越多），与本插件 `C × (1 − F/255 × t)` **方向相反**
  ⇒ 描边走乘法分支必须 `invertRgb(描边色)` 才等价（`planStrokeBlend` 是唯一裁决处）。
  ⚠️ 快速蒙版与图层蒙版**共用 `ClearHandler.computeChannelClear`**，不再各写一份（历史上已漂移过）。

## 像素读写（三条最贵重的教训）

- ⛔⛔⛔ **`imaging.putPixels` 的 `replace` 默认为 `true`（官方原文：existing pixels in the layer are
  **discarded** before adding new pixels）** ⇒ **局部写是陷阱**：带了 `targetBounds` 又没显式给 `replace`，
  PS 的语义就是「**先把整层清空**，再把这块数据放到 targetBounds 处」。2026-10-08 用「选区外接矩形」
  写回 ⇒ **选区外整层像素被清空成透明**（背景图层不能透明，PS 按背景色填成**白色**），
  与算法完全无关。**唯一正确做法 = 文档全尺寸缓冲 + 不传 `targetBounds`**（原点 (0,0)，
  「Dimension keys width and height are not used」），选区外字节保持读出的原值 ⇒ 整体替换后严格恒等。
  ⚠️ `MaskSyncEngine` 头部早有同源结论（「局部写 targetBounds+replace:false 不可靠 ⇒ 整图写回」）；
  `pixelDataProcessor` / `knockoutBatchProcessor` / `PatternFill` 的写回也都是整图/整层。
  ⇒ 新写任何像素写回前，先抄这三处的形状，不要自创局部写。
- ⛔⛔ **`imaging.getPixels` 四条参数铁律（改任何「读像素→改→写回」前先背下来）**：
  ① 选项名是 **`sourceBounds`**，**没有 `bounds`** —— 传错 = 整个图层被 `targetSize` 重采样进选区
  （症状：选区外变白 / 内容错位；`smartEdgeSmoothProcessor` 早已记录过，2026-10-08 又踩一次）；
  ② **绝不传 `applyAlpha: true`** —— 它会把 RGBA **按白底压成 RGB、丢掉 alpha**
  （症状：普通像素图层被判「无 alpha 通道」直接跳过）；
  ③ **按 `layer.boundsNoEffects` 读**（不要按选区、不要按全文档）：按选区会漏掉「有像素但在选区外」
  的部分；全文档在图层没画满画布时会被裁剪甚至报 `Missing image`（MaskSyncEngine 实测）。
  `targetSize` 与请求同尺寸即声明不缩放；**不传 `colorProfile`**（读写都走文档工作空间才往返恒等）；
  ④ **必须回读返回值的 `sourceBounds`**定原点（PS 会裁到「真有像素」范围），
  **数组形状取 `imageData.width/height`**（须在 `dispose()` 前读出）。
  写回时 `createImageDataFromBuffer` 的 `colorSpace/pixelFormat/components` 三项组合
  **照抄 `pixelDataProcessor` 的写回分支**（本仓已验证）。
  ⇒ 台架：`node outputs/clear_pixel_geometry_verify.cjs`（**203 项**；T1/T7 是**全缓冲逐字节 oracle**，
  T11 静态契约扫 `writeLayerPixels`/`readLayerPixels`/`clearPixelLayer`，T12 注入假 `imaging`
  真跑 `readLayerPixels`；`CLEAR_HANDLER_SRC` 指向变异副本做变异测试，10 个变异全部被抓）。
- ⛔ **分支选择要看「数据」不要看「探测结果」**：`clearPixelLayer` 走背景族还是像素族，
  由 `getPixels` 返回的**分量数**（3=RGB / 4=RGBA）决定，不看 `layerInfo.isBackground` ——
  探测与实际不一致时旧写法会静默跳过，用户看不到任何解释。

## 背景图层（ClearHandler）

- ⛔ **背景图层走「解锁 → 清除 → 还原」**：`putPixels` 契约要求目标**必须是像素图层**，
  背景图层不是 ⇒ 先「图层来自背景」转普通图层（描述符逐字取自用户真机监听：
  `set {_target:[{_ref:"layer",_property:"background"}]}` + 顶层 `layerID`），
  清除后必须 `make {_ref:"backgroundLayer"}` 还原，**还原写在 `finally` 里**（异常也要还，否则永久改动
  用户图层结构）。还原前要校验活动图层 id 未变（描述符打的是 `targetEnum`）。
  解锁后读取恒为 RGBA，3/4 分量歧义随之消失；后台族算法只动 R/G/B、alpha 恒 255 ⇒ 还原是恒等操作。
- ⛔⛔ **「图层来自背景」命令会报错，但图层类型确实已改**（真机 `invalid target sheet`）。
  ⇒ 解锁成败**只能看回读的 `isBackgroundLayer`**，绝不能看有没有抛错；回读失败（null）≠ 失败
  （否则背景图层永远清不掉）。查 batchPlay 静默失败要**扫返回项里的 `{_obj:"error"}` 描述符**
  （`batchPlayError(result)`），因为目标非法时 batchPlay 多半是 resolve 而不是 reject。
- ⛔⛔ **图层类型转换之后，一次 DOM 都不能读**：`app.activeDocument` / `activeLayers[0]` /
  `layer.boundsNoEffects` 撞上「刚改过类型的图层」都会抛 `invalid target sheet`，异常一逃逸就整轮静默失败
  ⇒ `docId` / 目标图层 id / 读区域必须**转换前**捕获成普通数字；`readLayerPixels(layerId, docId, region)` /
  `writeLayerPixels(block, layerId, docId)` 是**纯函数**（不吃图层对象、不引用 `app.`）。
- ⛔ **还原背景图层必须尽力而为**：只有**明确读到**活动图层换成了别的图层才允许放弃还原；
  读不到也要还（skip 会把用户图层结构永久改成普通图层）。读区域用 `readLayerBounds`（`boundsNoEffects` 优先，
  含效果的外扩范围不是像素）；可能抛异常的多步探测**每一步各自 try/catch**。
- ⚠️ 台架自身坑：`extractMethod` 返回的是**源码字符串**（要 `new Function` 编译才能当函数用）；
  静态扫描前必须 `stripComments`（文档注释会引用 `app.` 反例字样）。

## 描边 API 形状

- ⛔⛔ **描边 API 形状以「监听到的调用」为准，不得凭外部检索推翻**：PS **自身**下发的 `stroke`
  描述符 = **裸数字 `width`** + `location._enum: "strokeLength"`（Alchemist 监听截图，PS 27.8.0 r13 /
  UXP 9.3.0；图存 `.workbuddy/clipboard-images/`）。**现场证据（用户截图/监听）永远优先于 web 检索。**
- ⛔ **`StrokeSelection.ts` 全部九处 `location._enum` 一律 `strokeLength`**（2026-10-08 用户拍板；
  原先 5 处 `strokeLocation` 属历史遗留，已统一；之后新增分支也必须跟上）。
  ⚠️ `width` **有意保留两种写法**：**通道上下文**四支（快速蒙版 3/4 + 单通道 7/8）为裸数字（同监听），
  其余五支（1/2/5/6/9）`{pixelsUnit}` —— **未经授权不要动 `width`**。核对台 ① 组为**逐分支快照**，不要求同形。
- ⛔ **描边色对象的 `_obj` 必须是 `RGBColor`**：`RGBColorClass` 是**无效类名**
  （2025-07 起只在「快速蒙版 · 描边+清除」一支误用）⇒ PS 忽略该色 ⇒ 换任何描边色结果都一样。
- ⛔⛔ **`clearEnum`（清除混合模式）在不透明目标上不可用** —— Adobe 文档原文：
  「The Clear blending mode will be unavailable for a **background layer**, or if
  **preserve transparency** is enabled on the target layer」。
  PS 遇到不可用的 `clearEnum` **不抛错**：弹出原生「描边」对话框，然后按**普通填充**把描边画成描边色
  （用户实测：背景图层 12 组合里 3 种「填充 + 描边 + 清除」失效）。
  ⇒ 目标 `isBackground || hasTransparencyLocked` 时走**分支 9 `strokeSelectionOnOpaqueLayer`**：
  混合模式固定 `blendSubtraction`（减去），减去量 = 描边色灰度 × 不透明度
  ⇒ 「以该描边的灰度删除描边内部的内容」，且全程静默。
  同源三处（快速蒙版 4 / 单通道 8 / 不透明目标 9）**都不用 `clearEnum`**；
  普通像素图层**仍必须**用 `clearEnum`（核对台 ⑮ 有回归护栏，别一刀切）。
- ⛔ **单通道（红/绿/蓝/自建 Alpha）描边必须走专用分支 7/8，不得落到「像素图层」兜底**：
  · 分支 7（仅描边）**不 `make layer`、不合并** —— 新建图层会把活动通道切回 RGB 复合通道
    （= 用户实测「单通道填充+描边后跳回 RGB」）；末尾用 `readActiveChannelName` / `reselectChannel` 还原通道
    （红→`red`、绿→`grain`、蓝→`blue`，自建 Alpha 走 `_name`）。
  · 分支 8（描边+清除）混合模式**固定 `blendSubtraction`（减去）**，同快速蒙版描边删除；
    `clearEnum` 在无透明度的通道上下文里 PS 不接受 ⇒ 弹原生描边框 + 按面板色**直接填充**（用户实测第 2 类失效）。
  · 分发顺序：单通道判定必须在「像素图层」兜底**之前**（核对台 ⑧ 盯这条）。

## 选区 / 通道状态

- ⚠️ 「新建图层」开关的禁用条件走 `app.isCreateNewLayerDisabled()`（**唯一事实来源**，紧凑/普通两套版式共用）：
  清除模式 / 快速蒙版 / **图层蒙版** / **单通道编辑**。新增禁用条件只改这一处，杜绝两处漂移。
  ⚠️ `isInLayerMask` / `isInSingleColorChannel` **必须在 state**（渲染读 state 才会刷新；只写实例字段 = `isInQuickMask` 那次历史 bug），
  且 `checkMaskModes` 与选区事件两处都要回写。
- ⛔⛔ **图层蒙版识别：`doc.activeChannels` 在图层蒙版激活时会「抛异常」**
  （`Unknown or unsupported active channels`，PS 官方论坛 + UXP 文档均确认）⇒ 必须用**独立**
  try/catch 吞掉后**继续**探测。9a909c0 把两处探测合并成 `probeChannelState` 时丢掉了内层 catch，
  异常逃逸到外层 ⇒ `isInLayerMask` **恒为 false** ⇒ 图层蒙版 12 组合里 **11 组**失效
  （图案/渐变填到新建的 RGB 图层；「仅描边」描在新建的 RGB 图层；清除/描边落像素分支并弹原生框）。
  ⛔ **合并「可能抛异常的多步探测」时，每一步的 catch 必须原样保留**（回归高发点）。
  核对台 ⑪ 组用**变异测试**盯这条（去掉内层 catch ⇒ 断言必须退化为 `false`）。
- ⚠️ 图层蒙版是与单通道同级的「通道上下文」：`isInLayerMask` 必须**进 state** 且并入
  `isCreateNewLayerDisabled()`；`fillSelection` 的 `make layer` 分支也必须排除图层蒙版
  （新建图层会把活动目标从蒙版切走 ⇒ 填充落到新图层而不是蒙版）。

## 填充路径与选区生命周期

- ⛔ **填充路径会「提前消费选区」**：`PatternFill` / `GradientFill` / `ClearHandler` / `SingleChannelHandler`
  写回像素时用 `imaging.putSelection` 覆盖选区，且**仅在 `state.deselectAfterFill === false` 时才还原**。
  该开关默认 `true` ⇒ 填充返回后选区已空，紧随的 `strokeSelection` 无从下手（= 描边「失效」）。
  ⇒ **只要 `needsStroke`，就必须给填充处理器传 `{...this.state, deselectAfterFill:false}`**（填充保留选区，
  描边后再由 app 层统一 `deselectSelection()` 兑现用户的「自动删选区」）。
- ⚠️ 隐藏的一条同源路径：像素图层「图案/渐变 + 清除」走 `ClearHandler.applySelectionAndDelete`，
  它前面的 `putSelection` 会把选区**改写成待删除掩码**（`getSelectionData()` 内部还先取消一次）
  ⇒ 必须同样按 `deselectAfterFill === false` 还原原选区，否则描边沿掩码走。
  ⚠️ `ClearHandler.ts` 是 **CRLF** 文件，Edit 工具多行匹配会失败 ⇒ 用脚本 LF 归一化后按锚点替换再写回 CRLF。

## 静默化 / 拾色器

- ⛔ **静默化只能写在 batchPlay 的 options 层**：`fill` / `stroke` 在 `clearEnum` 这类参数下
  **忽略描述符内的 `_options`** ⇒ 弹原生「填充」「描边」框（用户截图）。9 个填充/清除/描边相关文件的
  **每个** batchPlay options 都已补 `dialogOptions: 'dontDisplayDialogs'`（核对台 ⑫ 组全仓扫这条）。
  ⚠️ 只补 `dialogOptions` 这一项、别动描述符与数组（脚本改多行对象时曾把一处改坏 ⇒ 改完必须 tsc + 逐行 diff 校验）。
- ⛔ **PS 原生拾色器 `showColorPicker` 无参、只认「当前前景色」为初始值** ⇒ **禁止裸调**！
  一律走 `src/utils/ColorPicker.ts` 的 `pickColorWithInitial(initial, name)`：
  记真前景色 → 注入 `initial` → 打开 → 读回 → **finally 还原**（不还原就会改掉用户前景色）。
  面板「显示色 ↔ 拾色器初值」必须**同源**（描边色板：`getStrokeDisplayColor()` 是唯一事实来源）。
  ⚠️ 返回值绿色分量 `grain` / `green` **两键都认** + `Number.isFinite` + 0–255 clamp：
  只认一个时拿到 `undefined` ⇒ `Math.round(undefined)=NaN` ⇒ `rgb(r, NaN, b)` **非法颜色串**
  ⇒ 色板没有背景色、透出面板底色（看着像一块 `#333333`，而非纯黑）。

## 灰色显示态

- ⚠️ 「灰色显示态」四标志（清除模式 / 图层蒙版 / 快速蒙版 / 单通道）在 GradientPicker 里统一走
  `isGrayDisplayMode()` + `getDisplayColorHex()`（**模块级纯函数**）：色板与渐变预览条口径必须一致
  （0.299/0.587/0.114）；灰化**只影响显示**，stops 里仍存原色，退出灰色态自然恢复。
  ⛔ **灰色态必须覆盖「所有颜色显示点」**：面板里凡是把颜色当背景色画出来的地方都要走
  `getDisplayColorHex(..., grayDisplay)` —— 上一轮只改了「颜色」行 `.color-preview`，漏了渐变
  **轨道上那排方形色标**（`.color-slider-thumb`）⇒ 预览条已灰、色标仍是彩色（2026-10-08 用户指出）。
  新增任何颜色预览点时，一律先问「灰色态下它该不该灰」。

## 子面板入口

- ⛔ **子面板入口有两种形态，别只做一种**：普通模式 = 控件右侧的**齿轮 IconButton**
  （`.stroke-mode-controls` / `.clear-mode-controls`，两者**共用一条 8px 间距规则**）；
  紧凑模式 = **标签本身**复合 `.text-button`（横向没有位置），点击进子面板。
  ⇒ 新增子面板必须同时给「普通模式齿轮 + 紧凑模式标签入口」。
  ⛔ **紧凑模式作用域已从 5 个增到 6 个**（app/color/pattern/gradient/stroke/**clear**）：
  `CompactScope` / `COMPACT_CLASS` / `COMPACT_NAME` / `compactScopeOf` / app.css 的 `body.compact-*` 五处同步。
- ⛔ **「控件不可用」时不要整行隐藏，改「标签 + 控件」双禁用态**（用户明确要求）：
  `StrokeSetting` 的混合模式原为 `{!clearMode && (...)}`（清除模式下整行消失），现改为**始终渲染**，
  清除模式时标签挂 `label-disabled`、`Select` 传 `disabled={clearMode}` —— 与主面板
  `.app-blendmode-container` 的处理完全一致（那边早就是 `disabled={this.state.clearMode}`）。
  ⚠️ `.label-4`（common.css ~140 行）与 `.label-disabled`（common.css ~1839 行）**同为 (0,1,0)**，
  靠**同文件内后置规则**取胜 ⇒ 写成 `className="label-4 label-disabled"` 即可；
  但**跨文件**（app.css 的类 vs common.css 的 `.label-disabled`）就必须用两级类（见 CSS 段）。
- ⚠️ **同轴控件步长必须一致**：羽化滑杆 `step` 与 number-input `step` 同为 **1**
  （滑杆 0.5 会写 `X.5`，而 `.num-input-row` 定宽 34px 显示不全 ⇒ 只显出「1…」）。
