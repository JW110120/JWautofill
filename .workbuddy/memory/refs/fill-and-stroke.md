# 填充 / 描边 / 清除 —— API 铁律（JWautofill）

> `MEMORY.md` 的展开页。改任何填充/描边/清除相关代码前先读本文件。几乎每条都来自真机事故，务必逐条遵守。

## 一、清除算法

- ⛔ **唯一来源 = `src/utils/ClearAlgorithms.ts`**（三类：背景图层 `背景提亮|减法变黑|乘法变黑`、黑白通道 `减法|乘法`、像素图层 `减法|乘法`）。由 `state.clear{Background,Channel,Layer}Algorithm` 承载，UI 在清除设置子面板（`ClearSetting.tsx` / `clear.css`）。改公式只改这一个文件。
- ⚠️ PS 的 `multiply` 是 `C × S/255`（S 越暗删得越多），与本插件 `C × (1 − F/255 × t)` **方向相反** ⇒ 描边走乘法分支必须 `invertRgb(描边色)`（`planStrokeBlend` 是唯一裁决处）。
- ⚠️ 快速蒙版与图层蒙版**共用 `ClearHandler.computeChannelClear`**，不再各写一份。

## 二、像素读写（三条最贵重的教训）

- ⛔⛔⛔ **`imaging.putPixels` 的 `replace` 默认 `true`**（官方原文：existing pixels are **discarded**）⇒ **局部写是陷阱**：带了 `targetBounds` 又没显式给 `replace`，PS 会「**先清空整层**再放这块数据」⇒ 选区外整层像素被清空（背景图层按背景色填成白色）。**唯一正确做法 = 文档全尺寸缓冲 + 不传 `targetBounds`**（原点 (0,0)，选区外字节保持读出的原值 ⇒ 整体替换后严格恒等）。
  - 新写任何像素写回前，**先抄** `pixelDataProcessor` / `knockoutBatchProcessor` / `PatternFill` 这三处的形状，不要自创局部写。
- ⛔⛔ **`imaging.getPixels` 四条参数铁律**：
  1. 选项名是 **`sourceBounds`**，**没有 `bounds`** —— 传错 = 整个图层被重采样进选区（症状：选区外变白 / 内容错位）。
  2. **绝不传 `applyAlpha: true`** —— 它会把 RGBA 按白底压成 RGB、丢掉 alpha（症状：像素图层被判「无 alpha 通道」跳过）。
  3. **按 `layer.boundsNoEffects` 读**（不要按选区、不要按全文档）；`targetSize` 与请求同尺寸即声明不缩放；**不传 `colorProfile`**（读写都走文档工作空间才往返恒等）。
  4. **必须回读返回值的 `sourceBounds`** 定原点（PS 会裁到「真有像素」范围）；**数组形状取 `imageData.width/height`**（须在 `dispose()` 前读出）。
  - 写回时 `createImageDataFromBuffer` 的 `colorSpace/pixelFormat/components` 三项**照抄 `pixelDataProcessor` 的写回分支**。
- ⛔ **分支选择要看「数据」不要看「探测结果」**：`clearPixelLayer` 走背景族还是像素族，由 `getPixels` 返回的**分量数**（3=RGB / 4=RGBA）决定，不看 `layerInfo.isBackground`（探测与实际不一致时旧写法会静默跳过）。

## 三、背景图层（ClearHandler）

- ⛔ **走「解锁 → 清除 → 还原」**：`putPixels` 要求目标是像素图层，背景图层不是 ⇒ 先「图层来自背景」转普通图层，清除后必须 `make {_ref:"backgroundLayer"}` 还原，**还原写在 `finally` 里**（异常也要还）。还原前校验活动图层 id 未变。
- ⛔⛔ **「图层来自背景」命令会报错，但图层类型确实已改**（真机 `invalid target sheet`）⇒ 解锁成败**只能看回读的 `isBackgroundLayer`**，绝不能看有没有抛错；回读失败（null）≠ 失败。查 batchPlay 静默失败要**扫返回项里的 `{_obj:"error"}` 描述符**（目标非法时 batchPlay 多半是 resolve 而不是 reject）。
- ⛔⛔ **图层类型转换之后，一次 DOM 都不能读**：`app.activeDocument` / `activeLayers[0]` / `layer.boundsNoEffects` 撞上「刚改过类型的图层」都会抛 `invalid target sheet`，异常一逃逸就整轮静默失败 ⇒ `docId` / 目标图层 id / 读区域必须**转换前**捕获成普通数字。`readLayerPixels(layerId, docId, region)` / `writeLayerPixels(block, layerId, docId)` 是**纯函数**（不吃图层对象、不引用 `app.`）。
- ⛔ **还原必须尽力而为**：只有**明确读到**活动图层换成了别的图层才允许放弃还原；读不到也要还。读区域用 `readLayerBounds`（`boundsNoEffects` 优先）；可能抛异常的多步探测**每一步各自 try/catch**。

## 四、描边 API 形状

- ⛔⛔ **以「监听到的调用」为准，不得凭外部检索推翻**：PS 自身下发的 `stroke` 描述符 = **裸数字 `width`** + `location._enum: "strokeLength"`（真机 Alchemist 监听）。**现场证据（用户截图/监听）永远优先于 web 检索。**
- ⛔ **九处 `location._enum` 一律 `strokeLength`**（原先 5 处 `strokeLocation` 属历史遗留，已统一；之后新增分支也必须跟上）。
  - ⚠️ `width` **有意保留两种写法**：**通道上下文**四支（快速蒙版 3/4 + 单通道 7/8）为裸数字（同监听），其余五支（1/2/5/6/9）`{pixelsUnit}` —— **未经授权不要动 `width`**。
- ⛔ **描边色对象的 `_obj` 必须是 `RGBColor`**：`RGBColorClass` 是**无效类名** ⇒ PS 忽略该色 ⇒ 换任何描边色结果都一样。
- ⛔⛔ **`clearEnum` 在不透明目标上不可用**（Adobe 文档：背景图层、或开启「锁定透明像素」的图层）。PS 遇到不可用的 `clearEnum` **不抛错**：弹出原生「描边」对话框，然后按**普通填充**把描边画成描边色。
  - ⇒ 目标 `isBackground || hasTransparencyLocked` 时走**分支 9 `strokeSelectionOnOpaqueLayer`**：混合模式固定 `blendSubtraction`（减去），减去量 = 描边色灰度 × 不透明度 ⇒「以该描边的灰度删除描边内部的内容」，全程静默。
  - 同源三处（快速蒙版 4 / 单通道 8 / 不透明目标 9）**都不用 `clearEnum`**；普通像素图层**仍必须**用 `clearEnum`，别一刀切。
- ⛔ **单通道（红/绿/蓝/自建 Alpha）描边必须走专用分支 7/8，不得落到「像素图层」兜底**：
  - 分支 7（仅描边）**不 `make layer`、不合并**（新建图层会把活动通道切回 RGB 复合通道），末尾用 `readActiveChannelName` / `reselectChannel` 还原通道（红→`red`、绿→`grain`、蓝→`blue`，自建 Alpha 走 `_name`）。
  - 分支 8（描边+清除）混合模式**固定 `blendSubtraction`**。
  - 分发顺序：单通道判定必须在「像素图层」兜底**之前**。

## 五、选区 / 通道状态

- ⚠️ 「新建图层」开关的禁用条件走 `app.isCreateNewLayerDisabled()`（**唯一事实来源**，紧凑/普通两套版式共用）：清除模式 / 快速蒙版 / 图层蒙版 / 单通道编辑。新增禁用条件只改这一处。
- ⚠️ `isInLayerMask` / `isInSingleColorChannel` **必须在 state**（渲染读 state 才会刷新，只写实例字段 = 历史 bug），且 `checkMaskModes` 与选区事件两处都要回写。
- ⛔⛔ **图层蒙版识别：`doc.activeChannels` 在图层蒙版激活时会「抛异常」**（`Unknown or unsupported active channels`）⇒ 必须用**独立** try/catch 吞掉后**继续**探测。若把两处探测合并时丢掉内层 catch，异常会逃逸到外层 ⇒ `isInLayerMask` 恒为 false ⇒ 图层蒙版 12 组合里 11 组失效。
  - ⛔ **合并「可能抛异常的多步探测」时，每一步的 catch 必须原样保留**（回归高发点）。
- ⚠️ 图层蒙版是与单通道同级的「通道上下文」：`fillSelection` 的 `make layer` 分支也必须排除图层蒙版（新建图层会把活动目标从蒙版切走）。

## 六、填充路径与选区生命周期

- ⛔ **填充路径会「提前消费选区」**：`PatternFill` / `GradientFill` / `ClearHandler` / `SingleChannelHandler` 写回像素时用 `imaging.putSelection` 覆盖选区，且**仅在 `state.deselectAfterFill === false` 时才还原**。该开关默认 `true` ⇒ 填充返回后选区已空，紧随的 `strokeSelection` 无从下手（= 描边「失效」）。
  - ⇒ **只要 `needsStroke`，就必须给填充处理器传 `{...this.state, deselectAfterFill:false}`**；描边后再由 app 层统一 `deselectSelection()` 兑现用户的「自动删选区」。
- ⚠️ 隐藏的同源路径：像素图层「图案/渐变 + 清除」走 `ClearHandler.applySelectionAndDelete`，它前面的 `putSelection` 会把选区**改写成待删除掩码** ⇒ 必须同样按 `deselectAfterFill === false` 还原原选区，否则描边沿掩码走。
- ⚠️ `ClearHandler.ts` 是 **CRLF** 文件，Edit 工具多行匹配会失败 ⇒ 用脚本 LF 归一化后按锚点替换再写回 CRLF。

## 七、静默化 / 拾色器

- ⛔ **静默化只能写在 batchPlay 的 options 层**：`fill` / `stroke` 在 `clearEnum` 这类参数下**忽略描述符内的 `_options`** ⇒ 弹原生框。填充/清除/描边相关的**每个** batchPlay options 都已补 `dialogOptions: 'dontDisplayDialogs'`。
  - ⚠️ 只补 `dialogOptions` 这一项、别动描述符与数组（脚本改多行对象时曾改坏一处 ⇒ 改完必须 tsc + 逐行 diff 校验）。
- ⛔ **PS 原生拾色器 `showColorPicker` 无参、只认「当前前景色」为初始值** ⇒ **禁止裸调**！一律走 `src/utils/ColorPicker.ts` 的 `pickColorWithInitial(initial, name)`：记真前景色 → 注入 `initial` → 打开 → 读回 → **finally 还原**。
  - ⛔⛔ **初值 = 真实色，绝不是「灰色显示色」**：灰态下 `getStrokeDisplayColor()` 返回灰度值，用它当初值会连踩两坑（① 一打开就显示灰；② 用户确认后把灰度写回 `strokeColor` ⇒ 真实色被永久覆盖）。描边板初值取 `state.strokeColor`；渐变板取 `parseCssRgb(stop.color)`。
  - ⚠️ 返回值绿色分量 `grain` / `green` **两键都认** + `Number.isFinite` + 0–255 clamp：只认一个时拿到 `undefined` ⇒ `rgb(r, NaN, b)` **非法颜色串** ⇒ 色板没有背景色。
  - ✅ 守卫 `node scripts/_color_picker_contract_guard.cjs`（G1/G2/G3）。

## 八、灰色显示态

- ⛔⛔ **灰态「只影响显示」是硬边界**：任何**写回**路径都不许让灰度进入真实数据。最典型的翻车点是 PS 原生拾色器初值（见上）。
- ⚠️ 四个标志（清除模式 / 图层蒙版 / 快速蒙版 / 单通道）在 GradientPicker 里统一走 `isGrayDisplayMode()` + `getDisplayColorHex()`（**模块级纯函数**），色板与渐变预览条口径一致（0.299/0.587/0.114）；灰化只影响显示，stops 里仍存原色。
- ⛔ **灰色态必须覆盖「所有颜色显示点」**：面板里凡把颜色当背景画出来的地方都要走 `getDisplayColorHex(..., grayDisplay)` —— 曾只改「颜色」行 `.color-preview`、漏了渐变**轨道上那排方形色标**（`.color-slider-thumb`）。新增任何颜色预览点先问「灰态下它该不该灰」。

## 九、子面板入口

- ⛔ **入口有两种形态，别只做一种**：普通模式 = 控件右侧的**齿轮 IconButton**（`.stroke-mode-controls` / `.clear-mode-controls` 共用一条 8px 间距规则）；紧凑模式 = **标签本身**复合 `.text-button`。新增子面板必须同时给两种入口。
- ⛔ **紧凑模式作用域共 6 个**（app/color/pattern/gradient/stroke/**clear**）：`CompactScope` / `COMPACT_CLASS` / `COMPACT_NAME` / `compactScopeOf` / app.css 的 `body.compact-*` —— 五处同步。
- ⛔ **「控件不可用」时不要整行隐藏，改「标签 + 控件」双禁用态**（用户明确要求）：清除模式下混合模式行**始终渲染**，标签挂 `label-disabled`、`Select` 传 `disabled={clearMode}`。
  - ⚠️ `.label-4` 与 `.label-disabled` 同为 (0,1,0)，**同文件内**靠后置规则取胜（写 `className="label-4 label-disabled"` 即可）；**跨文件**（app.css 类 vs common.css）必须两级类。
- ⚠️ **同轴控件步长必须一致**：羽化滑杆 `step` 与 number-input `step` 同为 1（滑杆 0.5 会写 `X.5`，而 `.num-input-row` 定宽 34px 显示不全）。
