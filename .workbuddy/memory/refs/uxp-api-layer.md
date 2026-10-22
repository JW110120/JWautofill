# UXP / PS 接口层 + 性能 / React（JWautofill）

> `MEMORY.md` 的展开页。都是「接口层实测行为」与性能铁律，不是样式规则。
> 样式/面板见 `refs/frontend-css.md` 与技能 `uxp-frontend-spec`；闸门/模态见 `refs/busy-gate.md`。

## 一、接口层实测行为

### 当前工具检测
- 不能只靠 `select` 通知：切笔刷预设派发的是 `{_ref:'brush'}`（没有 tool 变更），动作回放也不广播。
- ⇒ 读 `application.tool._enum`（`HotkeyBridge.getSelectedBrushToolEnum`）+ 300ms 轮询 + `/brush|eraser|stamp|smudge/` 匹配。
- ⚠️ 混合器画笔的内部名不是 `brush`：有 `mixerBrushTool` / `wetBrushTool`。

### 像素读写
- `imaging.getPixels` 会把 `sourceBounds` **裁到层 bounds 再重采样** ⇒ 直接按选区请求会拿到错位/缩放过的数据。正确姿势：先取 `layer.bounds`，只请求「需要区 ∩ bounds」，保证 source 与 targetSize **严格 1:1**；解析用 `imageData.width/height`（不要用请求尺寸），并守 `raw.length`。
- （完整四参数铁律见 `refs/fill-and-stroke.md`。）

### 历史与 IO
- 历史压缩：`batchPlay + putPixels` 外面包 `doc.suspendHistory`；若已在内部历史中，传 `{skipHistorySuspend:true}` 避免嵌套。
- `storage.formats` 只有 `binary` / `utf8`；⚠️ `file.read({format: undefined})` **静默乱码**（不报错）。
- 弹窗必须用 `core.showAlert`（`dialogs.alert` 只写控制台、用户看不见）。

### 事件节奏
- PS 通知常在**命令中途**派发 ⇒ 收到 make/delete/set 立刻 get 会撞上忙碌窗口。事件探测统一走 `psProbe.debouncePsProbe`，且**必须带忙碌感知**。

### 文档切换 = 长命令
- **UXP 没有 `currentDocumentChanged` 事件**（那是 ExtendScript 的东西）。识别方式：**`select` 事件 + `descriptor._target` 里有 `{_ref:'document'}`**（`psProbe.isDocSwitchDescriptor`，**必须同时限定 `eventName==='select'`**，否则改文档级属性的 `set` 也会命中→平白多等）。
- 切文档的忙碌窗口远长于普通事件（PS 重建窗口 + 图层面板 + 历史）⇒ 按文档级处理（长窗口 + 闩锁）。
- ⚠️ **无守卫的周期性轮询是首要缺口**：`pollQuickMask`(300ms 读 quickMaskMode) / `pollToolChange`(300ms 发 get tool) 原本完全不查忙 ⇒ **凡「无条件 setInterval + 读文档/get」的轮询都必须先 `if (isPsBusy()) return;`**。
- ⚠️ 面板挂载瞬间也是忙碌峰值：所有启动期一次性 PS 读取都要包 `runWhenIdle`（详见「性能 / React」节）。

### 文档切换判定用 id，不能只用名字
- 按 `d.name` 判定 ⇒ **两个同名文档互切判成「没变」**。改用 `docId + name` 双口径（`currentDocId`）。⚠️ 持久化 key 仍用名字（保持存档兼容）。

## 二、性能 / React 铁律

### 核心事实：延迟来自同步 IPC，不来自像素计算
- ⛔⛔ 选区纯色填充 0.5s 里 **0.3s 是人为固定等待 + 67 次同步 IPC**；真正的颜色写入是 PS 原生 `fill`（多线程、几毫秒），JS 侧没有像素循环。
- ⛔ **UXP 里每一次 `app.activeDocument` / `doc.layers` / `layer.bounds` / `layer.visible` 属性读都是一次同步宿主往返**；**batchPlay 数组整体只算一次**（数组内按序执行，无数据依赖的 get/set 应合并）。
- 三条铁律：① **同一份状态绝不查两遍**；② **属性只读一次再复用**（读 `bounds` 后不要再取 `bounds.width` / `.height`）；③ **无数据依赖的 batchPlay 一律合并**。
- ⚠️ 合并下发时必须核对**每个消费分支都真的消费了该参数**：曾无条件传 `withDeselect`，而图案/渐变/清除/单通道分支不消费 ⇒ deselect 被静默丢掉（选区留在画布上），编译与类型检查都发现不了。
- ⚠️ 忙碌窗口缩短必须配**有界**降级重试（用布尔标志会变成无限重试循环）。
- ⚠️ 省 IPC **必须来自「读一次复用」，不能来自「不读就假定某个值」**：曾为省一次 `bounds` 而对背景图层返回 `hasPixels=false` ⇒ 背景图层误走错误分支（`hasPixels` 有 6 处消费）。

### 共享闸门（`isPsBusy()`）动之前要数清消费者
- ⛔⛔⛔ 它影响 9 处消费者（两处 300ms 轮询 / 蒙版同步 2s 轮询 + 两处同步入口 / 面板探测 / 防抖 / `runWhenIdle` / 选区变更）。缩短全局窗口 ⇒ 那 9 处在 PS 仍忙时提前放闸、集体发 `get` ⇒ 宿主弹「命令"获取"当前不可用」。
- ⇒ **全局窗口一律 300 / 1200ms，不得为提速缩短**；填充的「快」走独立的 `fillReadyRemain()` 私有冷却（不变量 `fillReadyRemain() ≤ psBusyRemain()`）。详见 `refs/busy-gate.md`。

### 匹配规则
- 禁止把多条 get 合并进同一 batchPlay（见 `refs/uxp-api-layer` 上文与 `refs/busy-gate.md`）。
- ⚠️ PS 原生对话框不认描述符内的 `_options.dialogOptions`，只认 batchPlay 的 options ⇒ 静默化必须写在 options 层（`fill`/`stroke`/`stroke`+`clearEnum` 必现）。新增 batchPlay **两处都写**。

### 图层树 / 缓存
- ⚠️ **图层树只读一份快照**（`utils/layerTreeSnapshot.ts`）：`layer.id/name/kind/layers/isBackgroundLayer` 每读一次都是同步 IPC ⇒ 遍历 N 层 ≈ 3N~5N 次。三处并发遍历（引擎轮询签名 / 面板探针 / 线稿参考）在 500 图层时每 2 秒约 1500 次 ⇒ 主线程占满、点击无响应。
  - ① 读树一律 `getLayerSnapshot(maxAgeMs?)`；② 通知回调里**只**调 `invalidateLayerSnapshot()`（纯内存零 IPC，唯一允许）；③ 判断「结构变没变」先问 `isLayerSnapshotDirty()`，别为确认没变而遍历。
  - 签名 = 先序「顺序 + id + kind + name + depth」参与 FNV-1a（顺序敏感才能识别「移动图层」），只在会话内自比较、不持久化。
- `getActiveLayerInfo` 有 **300ms 短 TTL 缓存**（key = 活动图层 id）。失效时机：`make`/`delete`/`select`/`clearEvent`，以及 `set` 中 target 引用 layer/document/通道者；⚠️ **纯选区 `set`（channel + `_property:'selection'`）刻意不失效**。`createNewLayer` 与蒙版同步写回后必须手动失效。

### React
- ⚠️ **大列表 `options` 必须 `useMemo` + 组件 `React.memo`**（`Select` 靠引用比较跳过重渲染 ⇒ 调用方写 `options={raw.map(...)}` 会让 memo 完全失效）。配套：选项数组一律 `useMemo`/模块级常量，**永远不要在 JSX 里现 map**；`useMemo` 绝不能放进 `.map()` 回调；渲染路径上的 `arr.find(...)` 换成模块级 `Map` 索引。
  - 背景：面板是「单组件、全部 JSX 一个 return」，折叠任一分区会让**所有已展开分区**重渲染（含原生 `input[type=number]`，同步成本极高）⇒ 折叠代价按 O(分区数 × 控件数) 估。
- ⛔⛔ **组件内 `useMemo`/JSX 调用组件体内更下方才声明的 `const` ⇒ 整块面板白屏**（报错不是 TDZ 的「Cannot access before initialization」，而是「`Xxx` is not a function」——因为 target=**es5**，`const` 降级为 `var`：提升但值为 undefined）。**编译期与 webpack 都查不出来**。
  - 铁律：① **纯函数一律放模块级**；② 组件体内新增同步语句前先确认它调用的每个 `const` 都在更早的行；③ 发现隐患时修法选「提到模块级」，不要「把 Hook 挪到声明之后」。
- ⚠️ **父面板复位要覆盖子面板内部 state** ⇒ `AppState.resetToken` 自增 → prop → 子面板 `prevResetTokenRef` 变化时回默认值。`resetToken` 必须写在 `...initialState` **之后**；**复位前先清「选中预设」**（否则「参数变→回写选中预设」的 effect 会把用户预设改写成默认值）；复位**不动 presets/patterns 列表**。

### 启动期一次性加载
- ⚠️ 笔刷枚举 / presetManager / 文档尺寸等 `batchPlay get` 必须走 `runWhenIdle`（挂载瞬间正是忙碌峰值，表现「启动时列表空、点一下刷新就好」）。卸载时 `.cancel()`。
- ⚠️ 第 3 参 `maxDeferrals`：**一次性加载必须传有限值**（如 5），「周期性探测」才可传 0。调度器用 `useRef` + 懒初始化；循环里判断 setState 结果要读镜像 ref 而非闭包旧 state。
- ⚠️ 排查「刷新一下才好」先分清**枚举失败**（列表空）vs **下游数据缺失**（有名字无内容）——根因与修法完全不同。

### 通知回调
- ⚠️ **通知回调内禁止任何同步 DOM 读取**（每次读都发 `get`）：PS 的 set/delete/make 通知在命令**中途**派发，此刻读文档必撞忙碌窗口 → 宿主弹「命令"获取"当前不可用」。该弹框绕过 JS try/catch 与 `_options.dialogOptions`，**唯一防护是「不发 get」**（加在 try/catch 之后无效）。
- ⚠️ `GradientPicker` 两套插值函数不可合并（`interpolate*AtPosition` vs `...ForPreset`）：入参类型不同，且透明度正则的 alpha 组语义不同（ForPreset 版 alpha 可选）。四个已全部提到模块级。

## 三、派生缓存的键必须覆盖「全部影响输出的输入」

- 凡把「环境/主题/尺寸/DOM 实测值」烘进输出的派生结果，**要么进键、要么从输出里去掉**。本仓旋转图缓存曾因把预览区底色烘进输出而换主题不失效 ⇒ 现改为输出真透明（比加键更根本）。
- 同理 `previewNaturalRef` 在灰度模式下会被降采样缩略图覆盖、污染建图案尺寸与预览显示尺寸（详见 `refs/frontend-css.md` 第九节）。排查「预览/图案尺寸不对」先看这里。

## batchPlay 命令名：只能来自「录到过 / 跑通过」的样本（2026-10-20）

⛔⛔ 症状：面板操作弹 `{我们的步骤名}: 悦绘: 命令"<未知的>"当前不可用。(-25920)`。
含义 = **PS 解析不到这个 action 命令名**（所以连本地化命令名都是"未知的"），不是缺参数、不是缺模态。

| 需求 | ❌ 凭语义猜 | ✅ 项目已验证写法 |
| --- | --- | --- |
| 全选 | `{_obj:'selectAll', _target:[document targetEnum]}` | `{_obj:'set', _target:[{_ref:'channel',_property:'selection'}], to:{_enum:'ordinal',_value:'allEnum'}}`（`AdjustmentPanel.tsx::selectAllDocument`） |
| 选中画笔预设 | `{_obj:'slct', null:{_ref:'Brsh',_name}}` | `{_obj:'select', _target:[{_ref:'brush', _name:'名字'}]}`（`HotkeyBridge.ts::selectBrushCommands`） |
| 定义笔尖 | 不带 `dialogOptions`（会弹「画笔名称」框） | `{_obj:'defineBrush', name, _target:[document targetEnum], _options:{dialogOptions:'dontDisplay'}}`（`brushstudio/psBrush.ts`） |

补充纪律：
- 需要「有没有真的生效」的判断时，**改完复查一次真实状态**（读预设清单 / 读描述符）。`defineBrush` 存在
  「返回成功但笔尖没出现」的静默失败，只信回报不信现场就会给用户一个绿勾 + 空画笔面板。
- ⚠️ `_options:{dialogOptions:'dontDisplay'}` **不是通用开关，按命令区分**（2026-10-20 修正旧口径）：
  · `defineBrush` **必须带** —— 不带就弹「画笔名称」对话框，等于每装一支笔要用户点一次确定，
    且同一批 N 支会留下 N 个同名垃圾笔刷；
  · `select`（选中画笔预设）**不要带** —— HotkeyBridge 实测它会反向弹宿主错误框且异常不进 catch。
- ⛔⛔ **一条命令只留一条写法**。多写法"逐个试成功即停"在会弹对话框的命令上是灾难：
  三种写法 × 6 支笔 = 用户要点 18 次确定，还留下 18 个垃圾笔刷。写法不确定就只跑一条，
  把真实报错回给用户，别用重试掩盖。
- ⛔⛔ `defineBrush` 的预设名**不要靠 name 参数认定**：交互路径下 PS 忽略 name、用**文档名**当默认名。
  可靠做法 = 定义前后各读一次画笔清单，**差集新增的那一项**就是真实名（`psBrush.ts::ensureTips`）；
  同时笔尖文件命名成 `BRS-<id>.png`，让文档名天然唯一，差集才判得出来。
- 关闭临时文档一律按 `{_ref:'document', _id:doc.id}` 定位；用 `targetEnum` 会在「文档没开起来」时
  关掉用户正在画的稿子。

## 「改状态」类命令必须在模态作用域内（2026-10-20 真机）

⛔⛔ 症状：`两种写法都被拒：Event: set may modify the state of Photoshop. Such events are only
allowed from inside a modal scope. See https://www.adobe.com/go/ps_executeasmodal`
含义 = **命令本身没错、参数也没错，缺的是 `executeAsModal` 包裹**。

| 命令 | 裸调用 | 说明 |
| --- | --- | --- |
| `set` brush / tool（改画笔参数） | ❌ 被拒 | 必须 `runAsModal(...)`，`psBrush.ts::applyBrush` 已包 |
| `select` paintbrushTool / brush（选工具、选预设） | ✅ 可过 | PS 允许非模态，本项目实测成功 |
| `get`（读描述符） | ✅ 可过 | 只读 |
| `defineBrush` | — | 已在 ensureTips 的模态内 |
| `delete` | ❌ | 同 set |

⚠️ 报错文案里带 `Event: xxx may modify the state` 的，一律先查模态，不要去改描述符。

## 删除画笔预设：只有「删当前选中画笔」这一条路（2026-10-20 用户监听实录）

```json
{"_obj":"delete","_target":[{"_ref":"brush","_enum":"ordinal","_value":"targetEnum"}],"_isCommand":false}
```
- 这是**删当前选中的那支画笔**。想删指定预设只能「先按名 select 再 delete 当前」。
- ⛔ 不要写 `{_ref:'brushPreset', _name:'x'} + {_ref:'presetManager'}`（或加 `_index`）：PS 直接弹宿主
  错误框「删除不可用」，且异常不进 catch —— 用户看到的是一个弹窗，不是面板上的一行红字。
- ⛔ 因此「批量自动清垃圾预设」不划算：select 若静默失败，被删的是用户正在用的笔刷。
  正确姿势 = 只检测 + 提示用户去画笔面板手动删。

## 读「当前画笔」不能用 `get brush targetEnum`（2026-10-20 真机）

⛔ 症状：`{"_obj":"error","message":"悦绘: 命令"获取"当前不可用。","result":-25920}`。
`get` 是合法命令，被拒的是**这个引用** —— `_ref:'brush'` 不能当 get 的 target。
✅ 正确读法（优先序）：
1. `{_obj:'get', _target:[{_ref:'property',_property:'currentToolOptions'},{_ref:'application',targetEnum}]}`
   —— 工具选项描述符，含 opacity / flow / 画笔设置；
2. `{_ref:'brush', targetEnum}`（老版本兜底）；
3. `{_ref:'property', _property:'brush'} + application`。
`psBrush.ts::readCurrentBrush` 已按这三条依次试，全败才抛错。

⛔⛔ **batchPlay 返回值必须判 `_obj === 'error'`**。原 `readCurrentBrush` 直接
`JSON.stringify(res)` 回面板 ⇒ 面板显示「已读取」、框里却是一段错误 JSON，白跑一轮。
凡是没有走 `bp()` 封装的裸 batchPlay，都要自己判。

## UXP 没有 `navigator.clipboard`（2026-10-20）

⛔ 症状：复制按钮恒提示「复制失败，请手动选中」。
✅ `import { clipboard } from 'uxp'` → `await clipboard.copy(text)`（webpack externals 已含 uxp）。

## set 画笔参数：`set brush` 已生效，工具选项栏那两格待校准（2026-10-20）

- `{_obj:'set',_target:[{_ref:'brush',targetEnum}],to:{_obj:'brush',diameter/spacing/angle/roundness/...}}`
  在模态内**成功**（真机绿点），几何参数已生效。
- 但 `to.brush.opacity/flow` 写进去后，选项栏显示仍停在旧值（真机 30/30）⇒ 这两个键在本版
  可能不落到工具选项上。`setToolOpacity` 现有两条候选：
  `currentToolOptions`（首选）/ `tool(targetEnum)`（兜底）。失败**只标黄**（`ApplyStep.warn`），
  不影响「笔刷已就绪」的结论。
- 校准方式：点面板「读当前画笔」拿 `currentToolOptions` 描述符，按里面的真名补映射表。

## 图层样式只能用 batchPlay：`set` + `layer` + `layerEffects`（2026-10-22）

UXP **没有**暴露图层样式 API（`Layer` 上没有 effects 相关成员），斜面/浮雕/投影/描边
一律只能走 batchPlay。已录制过的形态只有一条，两条候选：

```
{ _obj:'set',
  _target:[{_ref:'layer',_enum:'ordinal',_value:'targetEnum'}],
  to:{ _obj:'layer',
       layerEffects:{ _obj:'layerEffects',
         scale:{_unit:'percentUnit',_value:100},
         bevelEmboss:{ _obj:'bevelEmboss',
           bevelStyle:{_enum:'bevelEmbossStyle',_value:'innerBevel'},
           bevelTechnique:{_enum:'bevelTechnique',_value:'softRound'},
           strength:{_unit:'percentUnit',_value:75},
           bevelSize:{_unit:'pixelsUnit',_value:2},
           blur:{_unit:'pixelsUnit',_value:3},
           soften:{_unit:'pixelsUnit',_value:1},
           localLightingAngle:{_unit:'angleUnit',_value:120},
           localLightingAltitude:{_unit:'angleUnit',_value:30},
           useGlobalAngle:false,
           highlightMode:{_enum:'blendMode',_value:'screen'},
           highlightColor:{_obj:'RGBColor',red:255,grain:255,blue:255},
           highlightOpacity:{_unit:'percentUnit',_value:55},
           shadowMode:{_enum:'blendMode',_value:'multiply'},
           shadowColor:{_obj:'RGBColor',red:0,grain:0,blue:0},
           shadowOpacity:{_unit:'percentUnit',_value:60} } } } }
```

charID 兜底键：`ebbl` / `Styl`(BESl=InrB) / `bvlT`(SfBL) / `Dpth` / `Angl` / `lagl` / `uglg` /
`hglM`(BlnM=Scrn) / `hglC`(RGBC) / `hglO` / `sdwM`(BlnM=Mltp) / `sdwC` / `sdwO` / `Sftn`。
⛔ 不写 `bevelDirection`（默认就是「上」）—— 少一个可能拼错的键，少一次排查。

验证：PS 对不认识的键**静默忽略**、命令照样返回成功 ⇒ 必须读回
`{_obj:'get',_target:[{_ref:'layer',targetEnum}]}` 看 `layerEffects.bevelEmboss`（或 `ebbl`）
是否真的存在。读不回来（老版本拒 get）才退化为「按命令成功算，日志标注未校验」。

## 图层级操作走 DOM，不猜 batchPlay（2026-10-22）

以下都是 UXP 文档化的 `Layer` / `Document` 方法，**不需要任何键名校准**，
凡是"建层/复制/位移/调亮度/改混合模式"优先用它们：
`doc.createLayer({name})` · `layer.duplicate()` · `layer.translate(dx,dy)` ·
`layer.adjustBrightnessContrast(b,d)` · `layer.blendMode = 'multiply'|'screen'` ·
`layer.opacity` · `layer.name` · `layer.delete()` · `doc.activeLayers = [layer]`。
`activeLayers` 赋值失败时退 `layer.selected = true`，再退
`{_obj:'select',_target:[{_ref:'layer',_id}]}`。

⚠️ 顺序陷阱：`adjustBrightnessContrast` 作用于**活动层** ⇒ 复制后必须先选中复制层再调；
位移要放在调色**之后**，否则扩散到新区域的边缘还是原色，会露白边。

## ⛔⛔ `dialogOptions` 三档语义：`dontDisplay` 是**允许弹框**的那一档（2026-10-22）

Adobe 文档（batchPlay → Command execution options）原文：

| 取值 | 行为 |
|---|---|
| `silent`（**默认**） | 不出 UI；命令需要额外参数 / 出错 ⇒ **返回脚本错误** |
| `dontDisplay` | 不出 UI，**但出错或命令需要额外参数时仍会显示 UI** |
| `display` | 出 UI |

后果链（本项目三次返工都是它）：
- `defineBrush` 需要"画笔名称"这个参数 ⇒ `dontDisplay` 照章弹「新建画笔」框；
- `select` 目标不存在时 `dontDisplay` 弹**宿主原生错误框**、且不进 JS catch；
- 改 `silent` 后两者都变成**普通可捕获异常** ⇒ 于是「按名 select 能不能成功」
  可以直接当**存在性探针**用（PS 没有按名查预设是否存在的可靠 API）。

⚠️ 位置：`dialogOptions` **只认描述符自己的 `_options`**。
batchPlay 第二参数只认 `synchronousExecution` / `continueOnError` /
`immediateRedraw` / `modalBehavior`；写 `dialogOptions` 进去无效
（历史误判："全局 options 会盖掉描述符里的设置"，其实那一处从来没生效）。

## 画笔预设三条实用接口（2026-10-22 真机/论坛交叉验证）

- **定名**：`defineBrush` 用**文档名**当预设名 ⇒ 笔尖文件名直接取 `BRS-<id>.png`，
  名字就确定了，**不要**用"定义前后差集"去反射真名（缓存不新鲜，差集恒空）。
- **选中**：`{_obj:'select', _target:[{_ref:'brush', _name:'<完整名>'}], _isCommand:false}`。
- **读当前画笔名**：`get property:'currentToolOptions'` → `result[0].currentToolOptions.brush.name`。
- **设工具选项**（选项栏的不透明度/流量）：先 `get currentToolOptions`，改字段，
  再 `set` 到 `{_ref:'paintbrushTool'}`、`to` 整份 cto —— 比只 set 两个键稳，
  因为交回去的是 PS 自己刚吐出来的结构。
- **删除预设**：只有「删当前选中」这一条
  （`{_obj:'delete',_target:[{_ref:'brush',_enum:'ordinal',_value:'targetEnum'}],_isCommand:false}`），
  ⇒ 删之前**必须确认选中的是自己那支**，否则删的是用户的笔。

## ⛔⛔ 笔尖数据活在「工具运行时状态」里，不靠预设续命（2026-10-22）

用户真机：**删掉当前画笔预设后，画笔工具仍停在那支笔上、仍能画。**
⇒ `sampledBrush` 的采样笔尖存在于工具状态（`currentToolOptions`），预设只是它的一个"入口"。

推论（本项目的核心手法）：
- `get currentToolOptions` → 整份描述符（含 `brush.sampledBrush.sampledData`）
- `set` 回 `{_ref:'paintbrushTool'}`（`to` 用**展开的 cto**，已被 setToolOpacity 验证）
⇒ **可以完全不建预设地"复活"一支笔**，只要那份 cto 还在。

⚠️ `sampledData` 是 **UUID 字符串**，不是像素本体 ⇒ 跨会话是否有效无保证。
   必须三层校验：`set` 不抛 / `brush.name` 对 / `sampledData` 与缓存一致。
   第三层缺了就会出现"名字对、笔尖却是空心圆"。实现在 `src/brushstudio/psState.ts`。

## 样本（CEP）的静默装笔链：工具预设 ≠ 画笔预设（2026-10-22）

被逆向样本的做法（ExtendScript，**UXP 无等价 API**）：
```jsx
ref.putName(charIDToTypeID("toolPreset"), "<n>-<m>");
executeAction(stringIDToTypeID("select"), desc, DialogModes.NO);   // 清上次残留
executeAction(stringIDToTypeID("delete"), desc, DialogModes.NO);
app.load(new File("...<n>-<m>.tpl"));                              // 静默载入
```
- 载入的是 **tool preset**，所以「从不弹新建画笔框」「画笔预设里一个不多」。
- `.tpl` = `8BTP` + `8BIM/tppa` + `8BIM/tpbd` + PS descriptor；
  descriptor 里 `sampledData` 是 UUID，像素在 `8BIM/tpbd` 私有资源里。
- PS 2026 自带 `Legacy Brushes.abr` 与样本 `.abr` 都是新块结构 `00 0a 00 02` + `8BIM`/`samp`，
  **不是**公开文档里的 `8BAM` v6 ⇒ 自造 abr 需另做格式逆向。
- UXP 侧若要复刻，只剩 `batchPlay` 发载入命令这一条，命令形态无公开文档（未验证）。

## JSXBIN 解码规律（2026-10-22，读样本 .jsx 用）

`@JSXBIN@ES@2.0@` 之后：**每两个字符一组，取第二个字符 + 0x1F 即原文字节**。
第一字符是类别标记（`j`/`i`/`h`/`E`/`F`/`X`/`z`…），不影响解码。
所以 `jTjFjMjFjDjU` → `select`、`jEjFjMjFjUjF` → `delete`、`jQjVjUiOjBjNjF` → `putName`。
⚠️ 只对 ASCII 有效；带参数的字符串（`Fe...`）会把长度前缀一起编进去，需按段切分。

## ⛔⛔ 画笔预设 `select` 有两种引用形态，只试一种会「恒判不存在」（2026-10-22）

```js
{_obj:'select', _target:[{_ref:'brushPreset', _name:'<完整名>'}], _isCommand:false}   // ①
{_obj:'select', _target:[{_ref:'brush',       _name:'<完整名>'}], _isCommand:false}   // ②
```
只试 ② 时，真机上恒失败 ⇒ 所有以「能不能选中」为存在性判据的逻辑全部误判"不存在"，
后果链：**每次都重新 define（弹框）→ 每次都留一个新预设 → 下次还是认不出**。
一个 bug 解释三种现象。⇒ 两种都试，把成功的那条记在会话里。

配套的**存在性正解**：先 `get` 出真实预设清单，用真名去选；
猜名字（`BRS-<id>.png` / `BRS-<id>`）只能当兜底。
PS 给重复定义会自动追加「 拷贝」后缀 ⇒ 匹配要允许后缀，但**不许用宽前缀**
（`BRS-impasto` 会吃掉 `BRS-impasto-detail`）。

## ⛔ PS 错误码速查（本项目已踩到）

| 码 | 含义 | 典型现场 |
|---|---|---|
| `-128` | **用户取消**（弹框上点了取消） | `defineBrush` 弹「新建画笔」框 → 用户取消 |
| `-32005` | 程序错误 | `{_obj:'make',_target:[{_ref:'brush'}]}` 非法 |
| `-25920` | 命令不存在/当前不可用 | `_obj` 猜错（如 `selectAll`） |
| `8007` | 找不到元素 | 按名引用不存在的对象 |

## ⛔ `defineBrush` 在 PS 27 无法静默；`DflB` 是下一步候选（2026-10-22）

`dialogOptions` 的 `silent` / `dontDisplay` 都挡不住「新建画笔」名称框（真机三次复现）。
- 兜底写法：`{_obj:'DflB', 'Nm  ':'<名>', _target:[{_ref:'document',_enum:'ordinal',_value:'targetEnum'}]}`
  —— 菜单「定义画笔预设」的 4 字符 OSType，ExtendScript 时代脚本用它静默建笔。
  ⚠️ 与 stringID `defineBrush` **不保证同一条处理器**，需真机验证。
- 若 `DflB` 成功，PS 可能用**自己取的名字**（不一定是文档名）⇒ 成功判据改成
  「定义后 `cto.brush.name` 与定义前不同」+ 清单里出现 `sampledBrush`，别死磕 `BRS-*`。

## ⛔ 删预设的二次删除会误删用户的笔（2026-10-22）

`delete` 只能删「当前选中」。第一次删成功后 PS 会把当前画笔挪到邻居上，
若为了"确认删干净"再删一次，删掉的是邻居 = 用户自己的笔。
⇒ 清单仍列着该名时，只有**当前画笔名仍是它**才允许换形态重试，否则抛错停手。

## ⛔⛔ `select` 画笔预设 = 高亮格子；换笔尖必须 `set`（2026-10-22）

```js
// ✗ 只是把画笔预设面板里的那一格高亮，当前工具画出来的一点没变
{_obj:'select', _target:[{_ref:'brush'|'brushPreset', _name:'<名>'}], _isCommand:false}

// ✓ 真正把预设装到当前画笔工具上（= ExtendScript 的 setd + Brsh）
{_obj:'set', _target:[{_ref:'brush', _name:'<名>'}]}
{_obj:'set', _target:[{_ref:'brushPreset', _name:'<名>'}]}
```

症状链（一个 bug 三个症状）：select 不报错 ⇒ 以为笔已就位 ⇒ 回读 `cto.brush.name`
仍是旧笔 ⇒ 缓存抓到旧笔（黄）⇒ 删除安全阀判定不符（黄）⇒ 用户看到的还是旧笔。

⚠️ `set + brush` 装的是**当前工具**。当前若是移动工具，笔尖就装歪了 ⇒
切工具用 `{_obj:'select', _target:[{_ref:'tool',_enum:'ordinal',_value:'paintbrushTool'}]}`。

⚠️ `delete` 删的是**面板高亮项**，不是"当前工具的笔"。set 不一定同步高亮 ⇒
删前先按名 `select` 一次把目标对准。

## ⛔ 总纲：PS 里"改状态"的动作，判据只能是「回读状态变了」

本项目已因此返工五次（dialogOptions 档位、defineBrush、差集定名、select 形态、select vs set）。
统一写法：**先调真函数 → 再回读权威字段 → 对不上就当失败**。
- 换笔尖：回读 `currentToolOptions.brush.name`
- 换笔尖数据：回读 `currentToolOptions.brush.sampledBrush.sampledData`
- 写参数：回读 `currentToolOptions` 对应字段
- 删预设：回读画笔清单（`presetManager` / `app.brushes`）
**"命令没报错"在 PS 里等于什么都没说。**
