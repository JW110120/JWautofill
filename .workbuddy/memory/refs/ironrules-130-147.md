# 铁律 130–148 全文

> 从 MEMORY.md 下沉（2026-11-16，MEMORY 超限整治）。147 条已于同日回退，仅作「勿重蹈」记录；148 同日新增。

130 快捷键 UI 分两处但**共用** `FuncHotkeyPanel` 的 `scope`（工具箱=功能快捷键 / APP=自定义快捷键）；两面板各有 `cachedConfig` 且原生 `config` **不广播** ⇒ 子面板打开即 `requestConfigRefresh()`。菜单：参数复位独占一组，「自定义快捷键 + 填充设置」同组；混合模式热键 notify 归 APP（「选区平滑」上方）。

131 滚轮组合没有 vk ⇒ 只能由 `WH_MOUSE_LL` 的 `WM_MOUSEWHEEL` 处理（伪 vk `KH_VK_WHEEL`）；吞滚动的条件是**五条全与**（有条目 ∧ 修饰键完全匹配 ∧ 布防 ∧ 非文本 ∧ 前台），**裸滚轮永不装载**（那是 PS 的缩放画布）。

132 「切回某工具」一律**按需**：先同步读 `app.currentTool`，已在目标族就别发 `select` —— 无条件切会迟到落地，把用户随后的 Shift+某键原生循环（如 Shift+L 切多边形/磁性套索）拽回去。

133 PS 原生「Shift+字母循环同组工具」在 L 上不生效（其它字母都正常，首选项已勾选）⇒ L 被插件接管后这一组的循环只能由插件补：新建配置条目 `lasso_cycle`（默认 Shift+L，仅工具模式装载）→ RegisterHotKey 独占 ⇒ PS 收不到、不会双跳；游标在桥接侧维护（`app.currentTool` 不可靠，见 0x0211）。**多边形套索的引用名是 `polySelTool`**（`polygonalLassoTool` 是猜的、`select` 静默无效 ⇒ 表现为「只在套索与磁性之间跳」）；族判定用 `LASSO_GROUP` 精确比较，⛔ 别用 `/lassoTool$/` 后缀正则（判不出 polySelTool，会把多边形误判成跑偏而踢回普通套索）。`App.isLassoTool`（平滑闸门）**故意**仍只认 `lasso` 关键词，与原生 `ci_has` 逐字一致，两套判据别混用。

134 子套索（`polySelTool`/`magneticLassoTool`）与主开关的双向联动（2026-11-16）：**关**总开关那一拍若停在子套索 ⇒ 切回 `lassoTool`（`onMainToggleChanged` 里做，只在开→关这一拍，开机不动工具）；**Shift+L 切到子套索 ＝ 换工具** ⇒ `autoOffOnOtherTool` 开且总开关开时自动关（在 `lassoCycle` 的广播回调里做，桥接拿不到 state）。三者由此闭环。面板侧任何自切工具（H/L/临时吸管/巡检/`slct`）**必须**走 `App.noteRealTool()` 同步 `lastKnownTool` 与三条循环游标（`syncToolCursors()`，旧名 `syncLassoCycleCursor` 仍保留为别名），否则 Shift+L 会从旧游标跳过一格。

135 热键反馈**按归属分流**：APP 侧（toggleMain/focusLasso/lassoCycle/focusClear/blendMode/切换填充模式）全部走 `appHotkeyNotify`，位置固定「选区平滑」分区**上方**；工具箱只留 applyBrush + 功能按钮（`runFunc` 里 `fillModeCycle` 已排除）。一条消息只在一块面板出现。`cycleFillMode` 的通知在**那里**发（才知道切到哪个模式），不在触发回调里发。

136 滚轮方向的**唯一换算点**是 `HotkeyBridge` 的 `fillModeCycle` 分支：原生 `dir` 是物理方向（+1=向上），语义方向取反 ⇒ **向下滚（往后转）= 纯色→图案→渐变**。⛔ 别去改 .8li 的符号，否则旧面板配新 .8li 会反过来。

137 0x0236 三组工具键（`fillToolCycle` Shift+H＝五工具循环且 `requestMainToggle` 只开不关；`focusMarquee` M / `marqueeCycle` Shift+M＝切选框并 `requestMainToggleOff`）**必须**在切工具前打 `noteSelfToolSwitch()` 抑制位（1.5s 时窗），否则 `onMainToggleChanged` 的「顺手切套索」会把刚切出的工具拽走；这三键**无条件**发 `select`（与铁律 132 相反：裸键 M 不被吞、PS 原生同步循环在先，队列里的 select 永远最后落地 ⇒ 结果确定；「已在目标就跳过」反而被迟到命令拽回）。选框**不在** `AUTO_OFF_TOOLS` ⇒「自动关」永不触发，关开关只能由桥接主动做。游标统一走 `syncToolCursors()`（`noteRealTool` 是唯一调用点）。面板 APP 侧改成 `appBlocks` 五块 + 单卡片内分隔线（0x0237 起改用通用 `.divider`），**不再渲染分组标题**（首块标题与首行同名＝用户说的「多余的选区填充」）。

138 **H 的「保持开启」这一拍也要回套索**（0x0237）：工具模式下 `MainToggleBus.doToggle` 是「只开不关」，已开着就 `return cur`、**不写状态** ⇒ 无翻转 ⇒ `onMainToggleChanged` 不触发 ⇒ 停在多边形/磁性/矩形/椭圆选框上按 H 毫无反应。修复点只能在 **app.tsx 的 `toggleMain` 广播分支**（那里才有权威的 `info.enabled`）：`enabled===true ∧ switchToLassoOnEnable ∧ 工具 ∈ LASSO_RETURN_TOOLS`（四个：poly/magnetic/marqueeRect/marqueeEllip）⇒ `selectLassoTool()`。⛔ 已在套索 / 工具未知都不发命令（铁律 132）；⛔ 别改 doToggle 让它「已开着也翻」——那会把 H 变成关开关。

139 **面板级偏好按 scope 各存一份文件**（0x0238 起）：用户明确要求「两个面板独立管理，不要跨面板共享」⇒ `HotkeyNotifyBus` 从单文件改为 `settings/hotkey-notify-app.json` / `-toolbox.json`，API 首参一律带 `HotkeyNotifyScope`（`hotkeyNotifyOnSync(scope)` / `toggleHotkeyNotify(scope)` / `subscribeHotkeyNotify(scope, cb)`），缓存、写链、监听器都按 scope 各一份。⛔ 别再引入「一边改了广播另一边」的联动；⛔ 旧的共享文件 `hotkey-notify.json` 故意不迁移（两个面板各自回默认开）。仍适用的三条：`subscribeXxx` 的 `last` **从 null 起**（首次必回调，否则后打开的面板菜单文案永远停旧值）；`toggleXxx()` 里**不能**再调同一条 `writeChain` 上的 `setXxx()`（自己等自己，菜单点了永不返回）；两个面板的菜单项 id 必须不同（UXP 全局唯一），动态改文案只有一份兼容写法（`utils/panelMenu.ts` 的 `updatePanelMenuItem`）。

140 卡片内「分块分隔线」**必须复用通用 `.divider`**，别自绘：`.border-panel-section .divider` 已把宽度补成 `calc(100% + 20px)` 并左右各 `-10px` ⇒ 两端正好压在卡片左右边框上，颜色 `var(--border-color)` 随主题与边框同源。⛔ 旧写法 `border-top + currentColor + opacity .16` 既不是边框色、也到不了边框（0x0236 的错误示范，0x0237 已按用户要求改掉）。

141 子面板里的分隔线要与**折叠分区内的真实位置**对齐（0x0238）：对照表是 `funcHotkeyDefs.FUNC_HOTKEY_DIVIDERS`（key=功能 id，value=该行**下方**的线型），实线用 `.divider`、虚线用公共组件 `components/DashedDivider`。⛔ 同一行里的两颗按钮（如 浅线/深线同层补色、消除锯齿/线条加黑、提升下极值/削弱上极值）在子面板是两行，**两者之间不画线**——否则把「一个操作组」切碎。⛔ 分隔线必须跟行走在同张卡片内，卡片外会被边框截断、压不到左右边框。

142 **关闭入口 / 隐藏菜单项都别删代码**（0x0238）：关闭「特制笔刷」＝删 `manifest.json` 里 `com.listen2me.brushstudio` 那个 entrypoint（`src/index.tsx` 的渲染与 `src/brushstudio/` 全留；⚠️ 需**重启 PS** 才从增效工具消失，因为 manifest 只在加载时读）；隐藏菜单项＝从 `APP_MENU_ITEMS`/`ADJUSTMENT_MENU_ITEMS` 数组里去掉条目，`AdjustmentMenu.handleMenuAction` 的 case 与 `registerCallbacks` 一律保留（本次隐藏的是 `alphaSample` / `repairKeyboard`）。

143 页签「文字上下缝相等」只能靠**改偶数高度**（0x0238）：`.smooth-mode-trio > .radio-option` 26→28px 后居中项上下各 +1px、正好相等；想再松继续按 2px 一档加。⛔ 别用不对称 padding：选中格底边宽度为 0、未选中格只有底边，三种状态会被推歪。

144 中文墨迹在 13px 行盒里天然偏下约 1px（0x0238 实测：26px 时上缝 6 / 下缝 5）。凡「文字看起来贴底」的等高盒子，先量上/下缝再动，别凭感觉加 margin。

145 折叠分区的按下态**只加在共用的 `.collapse-header:active`** 上（四处标题全用它：工具箱每个分区 + APP 的套索轨迹平滑/选区改造/填充选项），别逐个组件加。取值对齐总开关 `.main-button:active`：`--button-down` + `scale(0.98)`，四档主题里它都比 `--bg-color` 深一档，无需分主题。⚠️ `:active` 里**必须**重写 `transition`（60ms）——基础规则那条 `background-color 0.3s` 是给 hover 的，80~150ms 的点击里慢了等于看不见反馈；松手仍走 0.3s 淡出 = 按下脆、回弹柔。⛔ 缩放别低于 0.95：整行全宽，缩太狠标题与箭头会明显位移。

146 **「追笔」只能是滞后驱动，不能是定速追赶**（0x023A）：`step = vmax·dt` 只有「贴合 / 退到半径钳位」两个稳态，人速与 vmax 同区间 ⇒ 滑杆中段全是死区（实测「10–70 无感、80 以上才有」）。现在 `k = dt/(dt+τc)`、`τc = 2.2·radiusPxF·u`、`u = (50-原生catchUp)/49`，稳态滞后 = 笔速×τc，力度 100 ≈ 一个半径。⛔ τc 必须**按半径归一**（否则小半径用户在中段撞钳位）；⛔ 包路径 `smooth_packets` 与光标路径 `gp_step` 必须**逐字同源**，光标路径只多一条 `still` 时 k≥0.5。

147 ⛔ **【2026-11-16 已回退，勿重蹈】面板自绘 `.panel-tip` 替换原生 `title`**：当时在 `pointerover` 捕获阶段摘掉 `title`（文案存 WeakMap）+ 面板内 fixed 层显示（`pointer-events:none`、`z-index:100000`、`white-space:pre-line`），理由是「PS 28.0 宿主提示窗漏关」。**真机证伪**：28.0 上悬停他处显示主开关 helptext（取错带 title 的祖先元素），27.8 上任何位置都不显示（title 已摘、自绘层未成功）⇒ 四处改动全部回退（`panelTooltip.ts` 删除 / `index.tsx` 安装调用 / `common.css` 的 `.panel-tip` / `smooth_engine.c` 的 hud_wndproc 鼠标消息拦截）。原生 `title` 提示是可靠路径，⛔ 不要再改成自绘。详见 `2026-11-16.md`。

148 **标准模式强度必须线性映射 τ，不能指数**（0x023B，2026-11-16）：旧律 `τ = 8ms·(e^(3.4735·t/100)−1)` 把势能挤在 75–100 段，稳态滞后 v·τ 在 t=30 仅 5.9px、t=50 仅 15px（满量程 100px）⇒ 用户实测「1–70 几乎无感知」，与 146 追笔的死区同类。现改 `τ = TAU_MAX_MS·t/100`（250ms 满量程不变，只重分布 1–99），t 与滞后成正比、全程单调可辨。⛔ 满量程 t=100 必须仍是 250ms（上端手感不变）；⛔ 与 146 一样，包路径/光标路径都调 `tau_from_strength()`，改函数体即逐字同源；⛔ 删掉随之失效的 `exp_series()` 否则 -Wall 报 unused-function。面板「追笔速度」标签已改「追笔耗时」、单位 %→「值」（helpTexts 术语同步），语义仍是「数值越大越黏」。详见 `2026-11-16.md`。

149 ⛔ **UXP 的 `Document` 没有 `bounds`**（2026-11-19，0x02 填充线）：只有 `Layer` 才有 `bounds`。`Document.width` / `Document.height` 官方文档写明**就是像素**（Number），`Document.resolution` 是 ppi、与本值无关。⛔ 也别用 `width._value`（batchPlay 那条路，是标尺单位，需要 ×resolution/72，单位一换就算错）。踩坑后果不是报错而是**全链路静默失效**：`getDocPixelSize()` 拿不到尺寸 ⇒ 返回 `{0,0}` ⇒ `blendTopIntoBase` / `compositeTopIntoBase` / `multiplyTopAlphaByBase` 第一行 `return false` ⇒ 特殊剪贴永远退回合并路径（用户实测「开不开选项结果一样」+「上方剪贴被解除」）。

150 ⛔ **PS 里不存在「只释放某一层剪贴」**（2026-11-19）：`ungroup` 与 `Layer.isClippingMask = false`（UXP 里 R/W）都会释放**整组**——官方文档原话 *Releasing a clipping mask will also release the layers above*。ExtendScript 圈传的 `setd → T:{Lyr:{UsrM:false}}` 是**图层蒙版开关**（`userMaskEnabled`），与剪贴无关，别当剪贴用。✅ 正道是**从源头避开**：需要「不参与剪贴的临时层」时，建层前先 `select` 到 `ordinal: front`（最顶层一出生就无剪贴关系），收尾用像素写回 + 删层，全程不碰 `groupEvent` / `ungroup` / `mergeLayersNew`。

151 **填充收尾统一走「写回目标层」而非合并**（2026-11-19）：`rasterize → 严格 applyMask → imaging 写回目标层 → 删内容层 → 选回目标层`。特殊剪贴 = 权重乘基底 alpha（alpha 一字节不动），普通填充 = alpha 取并集（等价一次向下合并）。这样结果与剪贴关系彻底解耦：不再有「合并图层不可用」、不再为纠正裁剪语义去动别人的剪贴层，也不会出现「同一组操作两次结果不同」。⚠️ `applyMask` **必须成功**才允许写回（`imaging` 看不到图层蒙版，蒙版没应用掉等于按整层糊上去）；失败则放弃写回、退回「移到目标层上方 + 合并」。⚠️ 代价是每次填充多 2 次整图 `getPixels` + 1 次 `putPixels`。

152 ⛔ **像素读的 `sourceBounds` 必须按「图层自身 `boundsNoEffects`」，⛔ 不是文档矩形**（2026-11-19 第 6 轮，用户当场纠正）：这和 149（`Document` 没有 `bounds`）是**两件不同的事** —— 149 说的是「文档尺寸怎么取」，本条说的是「读像素时请求哪块区域」。铁律 ③ 的原文（`ClearHandler.readLayerPixels` 注释）写明：按选区读会漏「图层有像素但在选区外」的部分；**全文档 `sourceBounds` 在图层没画满画布时会被 PS 裁剪、甚至直接报 `Missing image`**（`MaskSyncEngine` 实测）⇒ 必须「读图层实有块 → 按**返回的** `sourceBounds.left/top` 索引扩充成 `docWidth × docHeight` 缓冲（块外填 0）→ 整图写回、不传 `targetBounds`」。本仓正确样板 = `ClearHandler` 三件套 `readLayerPixels` / `expandToDocument` / `writeLayerPixels`；`SpecialClipMask` 的 `readBlock` / `expandToDocument` / `writeDocument` 必须与之逐条同口径，改任一侧前先对照另一侧。取不到图层边界时**只允许回退文档矩形并 warn**，绝不把「请求区域」当「块形状」用（那会整体错位）。

153 **像素写回必须三态，`'nothing'` 不许降级合并**（2026-11-19 第 7 轮，用户实测）：`blendTopIntoBase` / `compositeTopIntoBase` 返回 `'written' | 'nothing' | 'failed'`。`'nothing'` = 按语义本来就不该写任何像素（特殊剪贴：基底在选区处 alpha 全为 0；普通填充：填充层在选区里全透明）⇒ 这是一次**成功**的填充，调用方只删内容层。旧实现用 boolean 把 `'nothing'` 当失败 ⇒ 降级「`moveActiveLayerAbove` + `mergeIntoBase`」⇒ `mergeLayersNew`/`groupEvent` 只认**紧邻那一层**，于是出现三种乱象：① 在 alpha=0 处也填了一块渐变（落在最上方的剪贴蒙版上）；② 对最上方剪贴蒙版填充弹「合并图层不可用」并在其上又新建一个剪贴蒙版；③ 图案填充一律糊到最上层同位置。判据：只有 `putPixels` 抛错（锁定的背景层 / 权限）才是 `'failed'`；读不到图层像素、`touched === 0` 一律 `'nothing'`。⛔ **`'failed'` 也不再降级合并**（2026-11-19 第 8 轮，用户拍板）：降级的 `mergeLayersNew` / `groupEvent` 只认**紧邻那一层**，内容层在文档最顶层时必然合到别人的图层上 ⇒ 现在一律「撤回内容层（`deleteLayerById` → 失败再 `deleteActiveLayer`）+ `core.showAlert` 说明原因」，文档回到填充前状态。随之删除 `mergeIntoBase` / `moveActiveLayerAbove`（已无调用方，留着只会诱导后人重新走上降级老路）。

154 **「特殊蒙版」只能有一个入口，且在填充层面判定**（2026-11-19 第 9 轮）：它原是图案 / 渐变子面板各一个「特殊剪贴蒙版」复选框（`Pattern/Gradient.preserveTransparency`，只对当次预设生效、旧值还会被写进预设），现收口成 APP 面板「填充选项 · 新建图层」下方的 `AppState.specialMask` 全局开关，**三种填充模式共用**。⛔ 别再往子面板加第二个入口：两个入口必然出现分歧值，而填充只认一个（`fillSelection` 里 `specialMaskOn = !!fillState.specialMask && !isSpecialMaskDisabled()`）。落地方式三选一：渐变/图案走既有的像素合成（`blendTopIntoBase` / `compositeTopIntoBase`，`useSpecialClip = hasPixels && preserve`）；**纯色**没有临时层可写回 ⇒ 直接用 PS 原生 `fill` 的 `preserveTransparency: true`（= 填充对话框「保留透明像素」，一次 IPC、零读像素），且只在 `!createNewLayer && hasPixels && !isBackground && !isNonPixelLayerKind(kind)` 时挂它（背景层无 alpha / 空层无像素可留 / 非像素层不允许）。纯色 + 新建图层（新层是空的，保留透明像素等于什么都不填）⇒ 填完再 `clipNewLayerToBase()`：原生 `groupEvent` 优先，`isClippingMask` 为真则跳过，被拒才 `multiplyTopAlphaByBase`。禁用条件与「新建图层」同构（清除模式 / 快速蒙版 / 图层蒙版 / 单通道）。
