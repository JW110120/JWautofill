# 混合器浮雕笔 / 储层重装（P3 线，2026-10-22 起）

> 从 `MEMORY.md` 铁律 54–57 下沉（2026-10-22 16:1x）。主索引只留一句话摘要，
> 踩坑细节、取证招法、判据全在这里。方案书：`docs/brush-mixer-emboss-plan-2026-10-22.md`。

## 54 ⛔⛔⛔ 储层只能靠「重新采样」装填

- `reservoir*` 元数据可读（`State` / `ImageMode` / `Cols` / `Rows` / `ChannelNumber`），
  但 `reservoirChannels` / `reservoirSampleData` **恒 `{}`**，单独 get 报 **-25920** ⇒ **写不进、也存不了盘回灌**。
- ⛔ **改前景色 ⇒ 储槽被 PS 灌成纯色，与 `autoFill` 无关**。我曾判 `autoFill` 是真凶，被用户真机推翻。
  ⇒ 通用教训：**字段名"正好解释现象"时最容易过度推断，先问真机**。
- ⛔ 上色在 **JS** 里一步乘法（`fg × luma^0.6`）；alpha 用**覆盖度**不是亮度（亮度当 alpha = 暗红泥）。
  **通道混合器方案已废**（只在"图案由 PS 自己生成"时才需要）。
- 图案必须 **RGB 模式、白底转透明**；K×K 方形混合器 + 同尺寸图案，在正中 (50%,50%) 吸一下即严丝合缝。

## 55 ⛔⛔⛔ 「派发 AM 事件触发工具手势」这条路不存在（10-22 定案）

两条硬证据：

1. **手势不派发通知**：监听 8s 只抓到 30 条（`modalJavaScriptScopeEnter/Exit`、
   `toolModalStateChanged`、`historyStateChanged`），**零条带储层字段**。
2. **AM 里没有这个命令**：反查 `Photoshop.exe` 的 AM ID 表 ——
   `reservoirState` / `wetness` / `autoFill` / `loadSolidColorOnly` 各命中，
   而 `loadBrush` / `cleanBrush` / `mixerBrushTool` **0 命中** ⇒ 没有对应 command id。
   同表附近捞到 `FillReservoirWithForegroundColorAndInitializeWells` 与
   `$$$/WBrushTool/Help/Alt=Click to load brush with colors from canvas.`，
   证明装储层是**纯输入层手势**。

**取证招法**（可复用）：正则扫 exe 里的候选 AM ID 串，**用已知存在的 ID 校准**，
比盲试 batchPlay 便宜得多且零黄条。

## 56 ⛔⛔ 合成点击 `canvasClick`（原生 0x0201）的约束

- 语义：`alt:1` = 装储层、`alt:0` = 画 dab 验货。
- 原生从主框客户区中心向外试探挑点，**必须判窗口面积**（dock / 工具条 / 选项栏也在主框子树里）。
- ⛔ **Alt 必须先按住再按下左键** —— PS 在 mouse down 那一刻读键态，顺序错了就变成画一笔。
- 卸载必须 `click_join`（活线程的 `SendInput` 会打到卸载后的系统）。
- 面板侧 `psMixer.reloadReservoir` 流程：临时文档边长 = **图案长边**（178×400 ⇒ 400）
  → 铺图案 → `actualPixels` → 合成 Alt+点 → **先清空画布** → 再补一枪 dab
  → `getPixels` 判货（opaque、亮度 std>3、色相 cosine>0.8；前景近灰时不看色相）。
- `sendHostMessage` 依赖 WS 18924，**每个面板各自 `connectSmoothDaemon()`**（幂等引用计数）。

## 57 ⛔⛔⛔ 厚涂笔走混合器储层，不走普通画笔链（10-22 定案）

- `brush.json` 有 `mixer.pattern` ⇒ `applyBrush` 首部分支直接 `reloadReservoir` 并 `return`。
- **defineBrush + cto 缓存那条链在当前库上已空置**（用户已把其余 5 支笔移出 `library.json`，
  只剩 `impasto-detail`）—— 代码整段保留不动（用户口径：以后可能还有别的笔刷路线），
  但要知道它**一行都跑不到**。

三条死规矩：

1. **整段不能包在一个 `runAsModal` 里** —— 模态作用域里 PS 挡工具输入，Alt+点被吞却全绿。
   只把「开/读/写文档」「set 工具选项」开小而短的模态，点击前后是裸的。
2. **吸之前笔刷直径必须 = 图案长边**（"严丝合缝"的唯一前提）。工具上没采样笔尖
   （`computedBrush`）就先用白方块文档 `defineBrush` 建一次方形笔尖，建完**要确认还站在混合器上**
   （PS 可能顺手换工具）。
3. **验货前必须清空临时文档**，否则读到的是我们自己铺的图案，永远"验上"。

其它：

- 图案由 **PS 自己解码**（`app.open` → `getPixels` → 关）：UXP 没有 zlib，别手写 inflate。
  读不到就退回程序化浮雕**并在日志写明**（不静默降级）。
- `app.currentTool` **只读** ⇒ 切工具只能 `select tool wetBrushTool`。
- 落盘 `brushstate/_mixer-reload.json`（`stage` / `patSize` / `side` / `diaBefore→diaAfter` /
  `tipName` / `dab` / `cmds[]`）。`cmds` 里 `ok:false` 的条数 = PS 会画出来的黄条数。

## 58 ⛔⛔ 面板显示的尺寸只认「图案长边」，不认 `params.diameter.base`

- `library.ts` 的 `readPngSize()` 只读 PNG 头部（`entry.read({format: storage.formats.binary})`，
  IHDR 宽高在 16..24 字节大端）⇒ 装载时给 mixer 笔填 `BrushDef.mixerSize`。
- `params.diameter.base`（820）对混合器笔**作废**，只是普通链的遗留字段（类型必填，不删）。
- 按钮名与宽度**随笔的路线动态变**：mixer ⇒「重装储层」+`action-button-4`；
  普通 ⇒「修复当前笔尖」+`action-button-6`。mixer 笔**跳过** `rebuildState`（它不写 cto 缓存）。
- `brushstate/impasto-detail.json`（旧链缓存）已按用户要求删除、不备份。

## 59 ⛔⛔⛔ `set` 工具选项的 `_target` 必须裸引用（PS 27）

- ❌ `{_ref:'property',_property:'currentToolOptions'}` + `{_ref:'application',...}` → 「命令"设置"当前不可用」
- ❌ `{_ref:'wetBrushTool',_enum:'ordinal',_value:'targetEnum'}` → 同上
- ✅ `{_ref:'brush',_enum:'ordinal',_value:'targetEnum'}`（`to` = 整份 brush，带 `sampledData`）
- ✅ `{_ref:'paintbrushTool'}` / `{_ref:'wetBrushTool'}`（**裸引用**）

与铁律 51（切工具不能带 `{_ref:'tool',_enum:'ordinal'}`）是同一个坑。

**直径判据**：PS 会把写入值**换算**（400 → 407）⇒ 只能看回读值。
`|回读−目标|≤1` 或「回读值变了」都算成功；**后续所有尺寸用回读值**（407 的方块配 407 的笔刷）。
改不动时降级：`scalePat()` 把图案等比缩到当前直径（`DEGRADE_MIN_SIDE=64` 以下直接报错）。
⛔ 降级不许静默（`degraded` / `diaTried` / 步骤名 / 状态条都要写）。

## 62 0x0202：alt 被吞 / 直径抹掉笔尖（两次真机返工）

| 现象 | 根因 | 修法 |
|---|---|---|
| 日志两条全 `alt=0`，储层 `1→1` 不动，dab 是纯前景色 | `json_bool` 只认 `true/false`，面板发的是数字 `1` | 改 `json_num` 判非零；每枪等 `canvasClickResult`，`alt/ok` 当场核对 |
| `diaTried.tip` = 「无采样笔尖」，方形笔尖变圆笔 | `set brush` 接受写入但抹掉 `sampledData` | 删掉整套 `setMixerDiameter`；改 `defineBrush(side×side 白方块)`，直径天生=边长 |
| 面板报「储层装上了但没验上」 | 两层判据揉在一句 | 拆成 `!loaded`（没位图）/ `!ok`（画出来是纯色） |

**储层判定**：`reservoirState` + `reservoirCols/Rows` 是否在场 —— 有位图才序列化尺寸。纯色 `state=1` 无尺寸，图案 `state=2` + 尺寸齐（用户手动吸那次 361×362×4）。

**原生取证**：`[alt]` 日志行新增 `hit=<窗口类名> <w>x<h>`，用来区分"点在画布上"和"点在主框空白处"（后者点击什么也不发生，`ok` 照样是 1）。

**类型检查门禁**：`tsconfig.check.json` + `scripts/typecheck/shims.d.ts`（把 `photoshop`/`uxp` 垫成 any、`types: []` 挡掉坏掉的 @types/node、`lib: es2020`）。
已有的历史错误集中在 `src/adjustments/*`（约 143 条，改动前就在），只看自己碰过的文件。

## 63 0x0203：吸歪 / 选不中方形笔 / 改不了直径（三条用户反馈）

**三个新认知（都来自 16:33 那次 `_mixer-reload.json`）**

1. **储层尺寸 = 笔尖直径 × 1.4325**，不是直径本身。
   `400×1.4325=573`（dab 那次 `before=after=573×574`）、`252×1.4325=361`（14:53 手动吸那次 `361×362`）。
   ⇒ 看到 `573` 不能推"笔尖是 573"；**更不能拿储层尺寸判断吸没吸歪**（它只是内部缓冲）。
2. **「有位图」≠「图案装上了」**：Alt 点在空白/透明处，PS 照样给 `state=2 + Cols/Rows/ChannelNumber`
   —— 那是一张全透明位图。`reservoirSnap().bitmap` 只能证明"这一枪被当成载入画笔"，
   "装的是不是图案"必须拖一笔看层次。
3. **混合器是"湿笔"，单击几乎落不下颜料**：400×400 画布上单击只落 **340px**（旧判据 `opaque>side*8`
   直接判负，报成"纯色"，冤枉储层）。而且**清空画布**（全透明底）是错的验货条件。
   ⇒ 验货统一成：铺**不透明中灰 128** → **按住拖 90px** → 数"与底色差异 >18 的像素"。

**"吸歪"的根因**：只发 `actualPixels` 只改缩放、**不动滚动位置**。修法 = 先 `fitOnScreen`
（把图像摆到视口正中）再 `actualPixels`（钉 100%，1 屏幕像素 = 1 文档像素）。
原生那一点永远是主框客户区中心 ⇒ 只有图像居中它才落在图案中心。

**笔尖身份（用户三条诉求的落地顺序）**

| 步 | 条件 | 动作 |
|---|---|---|
| ① | 工具上已是方形笔尖（名含「方」）且 `|dia−side|≤1` | 零命令复用 |
| ② | 不是方形 | `listTipNames()` → `pickSquareName()`（精确「方形」> 含「方」最短名）→ 按名装 |
| ③ | 是方形但直径不对 | `setTipDiameter()`：整份 cto 只换 `brush.diameter`，判据=`sampledData` 未变 **且** 回读直径到位 |
| ④ | 一支方形都没有 | `defineBrush` 一张 `side×side` 白方块，**文档名就叫「方形」**（预设名取文档名） |

装笔的形态顺序：`select+brush+MkVs` → `select+brushPreset+MkVs` → `set+brush`（27 上 -1715，放最后）。
`synthetic click` 新增 `drag=N`（0x0203）：按下后 8 步移动共 N px 再抬起，才能模拟真实笔迹。

## 64 0x0204：画布=笔尖尺寸 / 吸歪 / 去拖动

**三条命令级铁证**（`_mixer-reload.json` 的 `cmds`，16:53 那轮）：

```
set wetBrushTool 直径=400   → Illegal data type. ByteArray is not supported for this operation
set brush targetEnum 直径=400 → Event: set may modify ... only allowed from inside a modal scope
defineBrush                 → 无法完成请求，因为所选区域是空的
```

⇒ 笔尖停在 250 ⇒ 旧降级分支把图案缩到 250、临时文档建 250 ⇒ 用户："画布和我选的笔一样大"。

**逐条根因与修法**

| 症状 | 根因 | 修法 |
|---|---|---|
| 改不了直径 | ①`set` 不在模态里；②`currentToolOptions` 里有 ByteArray 字段 | 整段包 `runAsModal` + `jsonSafe()` 递归剔 `ArrayBuffer`/TypedArray 后再下发 |
| 建不了方形笔尖 | `documents.add(fill:'white')` **不算图层像素** | 先 `imaging.putPixels` 铺 side² 全白 RGBA，再 `defineBrush` |
| 画布比图案小 | 旧「降级」把图案缩到笔尖尺寸 | **删降级**：笔尖 ≠ 图案长边直接抛错 |
| 吸在画布外 | 原生点的是**主框客户区中心**，不是文档区中心 | `click_pick_point` 取命中窗口中心并**往里钻**最多 5 层；落点必须仍在窗口内 |

**坐标账**（3840 屏、PS 最大化）：命中 `Static 3140x1924@(63,139)` ⇒ 文档区中心 (1633,1101)；
旧点 (1920,1038) 偏右 287px —— 右侧 637px 是浮动面板、顶部 139px 是选项栏，客户区中心天生不在画布上。

**笔尖命名**：新建的方形笔尖叫 `方形<边长>`（`方形400`），预设名取文档名；
`pickSquareName(names, side)` 先按「名字里的数字 ≈ 目标边长」挑，再退回精确「方形」、含「方」最短名。

**drag 已删**（用户裁定）：单击即可，320 那次 `opaque=340` 是点落在画布外，不是"湿笔不出颜料"。
