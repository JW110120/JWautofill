---
name: uxp-debug-trace
description: 给「跨多步宿主操作」的大型改动先铺落地日志（trace-first debugging）：每步把判据/返回值/回读值写进插件数据目录的日志文件，出问题时直接读文件定位断点，不靠猜、不靠截图。在改 UXP 填充/剪贴/合并/栅格化这类「静默失败」链路、用户报「做了但没效果」、或任何跨 3 个以上文件的行为改造时使用。
agent_created: true
---

# UXP 落地日志追踪（trace-first debugging）

**适用**：跨 3 个以上文件的行为改造；连续多步宿主操作（`batchPlay` / `imaging` / DOM 混用）；用户报「执行了但没效果」「结果不对但没报错」。
**不适用**：纯样式/文案改动；单条命令就能验证的改动（直接测更快）。
**配套**：本仓实现 `src/utils/SmDebug.ts`；读日志 `scripts/trace-tail.mjs`；模板 `templates/DebugTrace.ts`。

## 为什么必须先铺日志

UXP 有一条恶劣的失败模式：**宿主拒绝了动作却不抛异常**。`dialogOptions: 'silent'` 直接返回一个「什么都没做」的描述符；`groupEvent` 打在错误的图层上不报错；`imaging.putPixels` 对空图层返回 undefined。于是 JS 侧只剩一条 `console.warn`，而 UXP 控制台不在用户眼前 —— 用户能给的只有「不对」，我们能给的只有「我猜是 X」。一轮猜错就是一次用户重启 PS + 复现 + 截图，成本极高。

**落地日志把「猜」换成「读」**：一次复现，一份文件，断点位置一目了然。

## 铁律

1. **记判据，不记结果**。每步写「输入 id / 判据值 / 返回值 / 回读值」四项，而不是「填充成功了」。
   - 好：`交接·②删空层 | {ok:true, stillExists:true, name:'图层 1'}`
   - 坏：`删除图层成功`
2. **每步必须回读验证**。宿主的返回值不等于生效（`silent` 档尤其）。回读即日志，日志即证据。
3. **日志永不阻塞、永不抛错**。fire-and-forget + 串行写链 + 全 `try/catch`；调用方**不 await**。
4. **只留最近 ~30KB**。滚动截断，避免日志无限膨胀拖慢写入。
5. **不写像素/二进制**。只写尺寸、`bounds`、采样 alpha（如 `topA@(x,y)`），几 MB 的 Uint8Array 一旦进日志就废了。
6. **沉默的分支必须记一笔**。`跳过 / 因为 X` 比成功更值得记 —— bug 几乎都长在「被静默跳过」的分支里。
7. **每步带序号 + 中文短标签**：`交接·①收窄`、`收尾·④剪贴`。读日志时按序号串流程，按 `ok:false` / `跳过` / `✗` 筛异常。
8. **会话头**：一次操作打一行 `---- 填充 ----` + 输入快照（模式、开关、plan 对象）。没有快照就无法判断「这次和上次有何不同」。
9. **收尾快照**：最终 id / 名字 / 关键布尔（如 `isClip`）/ 图层数。用来和用户描述的现象对齐。
10. **不写敏感信息**（账号、授权码、绝对私有路径）。
11. **读日志前先确认跑的是新代码**：比对 `dist/bundle.js` 的 mtime 与日志的 mtime。UXP 插件的 JS 在 PS 启动时加载，覆盖 bundle 后不重启 PS，你分析的是旧代码的行为 —— 这是最隐蔽的一次浪费。

## 落地实现（本仓）

```ts
import { smLog, smLogSession } from '../utils/SmDebug';

// 流程入口：打快照
smLogSession('填充', { mode, createNewLayer, plan });

// 每个宿主动作：前记判据、后记回读
smLog('交接·①收窄', { ok: narrowed, boundary, content });
smLog('交接·④剪贴跳过', { reason: '紧邻下方不是边界层', below, boundary });
```

日志落点（`storage.localFileSystem.getDataFolder()` 下）：

```
%AppData%\Adobe\UXP\PluginsStorage\PHSP\<PS 版本>\<External|Developer>\<plugin-id>\PluginData\debug\special-mask.log
```

读取（本仓一键）：

```bash
node .workbuddy/skills/uxp-debug-trace/scripts/trace-tail.mjs --plugin com.listen2me.jwautofill
node .workbuddy/skills/uxp-debug-trace/scripts/trace-tail.mjs --plugin com.listen2me.jwautofill --lines 200
```

脚本会自动定位日志（在 External / Developer 与各 PS 版本之间找最新的一份）、打印文件头（路径 / mtime / 大小），并**比对 `dist/bundle.js` 的 mtime**：若 bundle 比日志新，说明用户还没重启 PS，日志里是旧代码的行为。

## 改造清单（每次大型改动照此执行）

1. **先铺 trace，再改逻辑**。顺序反了就会在「改完才发现哪一步没生效」上多烧一轮。
2. 入口打 session 头，带上所有开关与 plan。
3. 每个宿主动作前打「判据」，后打「回读」。
4. 每个早退（`return false` / `return`）前面打原因 —— 早退是静默失败的常客。
5. 每个 `catch` 里打 `String(e)`。
6. 收尾打结束快照。
7. 改完 `tsc -p tsconfig.check.json` + `webpack --mode=development` + 覆盖 `Plug-ins/dist/bundle.js`，然后**明确要求用户完全退出并重启 PS**。

## 判读方法（把日志当调用栈看）

1. 先按 `✗` / `跳过` / `ok:false` / `null` 过滤 —— 断点几乎总在这几行附近。
2. 找**相邻两条之间值对不上的位置**：例如 `③ 选中结果层 {activeId: 21, expect: 20}` ⇒ 断点就在「选不中」上，后续的剪贴必然落空。
3. 常见指纹：

| 日志里看到 | 实际含义 |
|---|---|
| `ok:true` 但紧跟 `flag:false` | 宿主假成功（`silent` 档），必须回读 |
| `targetEmpty:null` / `contentSeenInDom:false` | DOM 滞后一帧，不是真不存在 |
| `①收窄 ok:false` + `④剪贴跳过` | 两步都因 id 不对 / 层不存在而空跑 |
| `跳过删除 / 读不到状态` | 保守分支生效，功能可能只做了一半 |
| 日志最后一条是「开始」 | 中途抛异常被外层 catch 吞了 |

4. 修完立刻清空日志（或对照 mtime 只读新增段）再复测，避免旧结论污染。

## 反模式

- 只 `console.warn` 就宣布「已修复」—— 用户看不到控制台。
- 用 `core.showAlert` 传递诊断信息 —— 打断用户、且信息量极低。
- 用 DOM 读（`layerExists` / `document.layers`）当**流程门槛** —— 滞后一帧的假阴性会让整段逻辑被静默跳过，应改为「id 寻址 + 重试/等待 + 只记日志」。
- 靠用户截图反推内部状态 —— 截图只能告诉你结果，告诉不了过程。
- 日志里塞整个像素缓冲 —— 写完一次就卡顿，且无法阅读。

## 已受益的实例

2026-11-19「特殊蒙版 + 空目标层」：连续三轮靠猜（删空层 / 改名 / 建剪贴 / 像素写回），每轮都要用户重启复现。第 18 轮铺上落地日志后，改为「合并优先 + 每步回读」，断点从「不知道」变成「读一行就知道」。铁律见 `.workbuddy/memory/refs/ironrules-130-147.md` 的 162–163。
