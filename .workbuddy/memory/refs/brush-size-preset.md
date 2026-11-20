# 笔刷大小预设（Shift+[ / Shift+] 三档，2026-11-20）

> 代码：`src/utils/BrushSizePreset.ts` + `HotkeyBridge`（开关/分发）+ `FuncHotkeyPanel`（第 ⑥ 块开关行）。
> 逐条实证：`2026-11-20.md`。

## 一句话

开关住 APP 面板「自定义快捷键」；开启后当前工具能改笔尖时，Shift+[ 减一档 / Shift+] 增一档，
档位随文档像素数缩放（A4@300ppi = 4/50/100 px 为锚点）。

## 三条别丢的结论

1. **不需要改 .8li**：`.8li` 对非 `blendHotkey` 的 action 只透传、按配置逐条注册热键 ⇒
   往配置里写两条 `combo='Shift+[' / 'Shift+]'`、`action='brushSizeStep'`、`brush='down'/'up'`
   的条目就够了（`kh_key_to_token` 已把 0xDB/0xDD 映射成 `[`/`]`）。改这个功能不必重编 .8li。
2. **改直径只能「整份 cto + 只改 brush.diameter」，且必须 `runAsModal`**：`set brush to {直径}`
   会把笔尖换成 computedBrush（铁律 49/60）；裸 batchPlay 的 `set` 还会被宿主直接拒
   （`set may modify the state…only allowed from inside a modal scope`，2026-11-20 真机）。
   判据 = 回读直径到位 ∧ `sampledData` 不变；**set + 回读放同一个模态作用域**
   （模态内 `psRead` 自动降级直读，不会嵌套）。三种 set 写法按验证通过的顺序记忆
   （工具 ref → property.currentToolOptions → brush targetEnum）。
3. **两个面板都会收到热键广播**：`settings/brush-size-step.lock`（`createFile(overwrite:false)`
   当互斥量）+ 状态文件 `{token=原生 seq, tier}` 幂等重放，两道一起用才不会「按一下跳两档」。
4. ⛔ **工具读数不能用 `app.currentTool`**（2026-11-20 真机翻车）：PS 27 上它是空/不可用
   ⇒ 日志里 `tool: 未知`、功能整体不动作。唯一可靠来源是 `get application.tool._enum`
   （`_target:[{_property:'tool'}, {_ref:'application',_enum:'ordinal',_value:'targetEnum'}]`，
   经 `psRead`，`dialogOptions:'silent'`），形态归一后只接受 `/Tool$/i` 的串。

## 档位公式

`k` 分段对数插值：≤1MP⇒0.5×；1MP…A4(2480×3508)⇒0.5→1.0；A4…40MP(8000×5000)⇒1.0→4.0；≥40MP⇒4×。
三锚点（2/25/50、4/50/100、16/200/400）全部精确命中；只改 `BASE_TIERS`/三个 px 常量即可调参。

## 工具名单口径

画笔/铅笔/橡皮擦/背景橡皮擦/混合器(wetBrushTool|mixerBrushTool)/涂抹/模糊/锐化/减淡/加深/海绵/
仿制图章/图案图章/历史记录画笔/历史记录艺术画笔/颜色替换/污点修复/修复画笔。
⛔ 不含魔术橡皮擦（没有笔尖）、快速选择、修补、红眼、魔棒。
