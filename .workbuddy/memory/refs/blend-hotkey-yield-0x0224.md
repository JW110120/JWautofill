# 0x0224：混合模式热键「按当前工具临时让位」

> 用户 2026-10-30 原话：混合模式热键要接管 Alt+Shift 表，但「画笔工具时按 alt+shift+J 线性光，
> 改的是 APP 面板上的混合模式，而没有改变笔刷工具的混合模式」。要求：开关开着时，当前工具是
> 画笔/铅笔/渐变/油漆桶/涂抹/模糊/锐化/仿制图章/图案图章/历史画笔/历史记录艺术画笔 → 临时关闭；
> 切回套索 → 恢复；**原本关着的开关不许被自动打开**。

## 一、结论先看：为什么让位位必须落在原生

| 方案 | 后果 |
|---|---|
| 面板调 `setBlendHotkeyActive(false)` 冒充临时关 | ① 配置落盘 ⇒ 用户在画笔下关面板，开关永久变关；② 每次切工具整表重建（RegisterHotKey 同步）；③ `pushConfig` 在配置路径未对齐时**静默不发送**，根本拦不住键 |
| 新增共享槽 `I_BLENDYIELD` | 能工作，但共享槽是给「引擎看不到的物理事实」用的；这里只是面板的判定结论，走 WS 更省（`CFG_NLONGS` 不必动） |
| **原生原子位 `g_khBlendYield` + 入站 `blendYield`** ✅ | 不落盘、不整表重建、断电方向安全（置 1 只会让键回到 PS 原生行为） |

## 二、三处必须同时改（漏一处就「键还是被吃」）

1. **LL 钩子**（`kh_dispatch` 热键匹配段）：命中 `action=="blendMode"` 且让位 ⇒
   `CallNextHookEx` 放行，**不入命中环、不广播**。
2. **RegisterHotKey 注册集**（`kh_hk_sync`）：让位期间**不许注册** blendMode 条目。
   ⛔⛔ 这条最容易被漏：注册成功后组合键被系统从输入队列里**摘走**，钩子那层再放行也没用
   （PS 收不到）。`g_khHkYield` 记上一轮的让位位，翻面必须重同步（约 100ms 内生效）。
3. **轮询兜底**（`kh_poll_step` 命中段）与 **WM_HOTKEY 兑现**（`kh_hk_fire`）：
   让位期间不许广播 blendMode —— 轮询吞不了键，PS 已按原生语义改了工具混合模式，
   再广播一次就是「同一击改两处」。

## 三、面板侧

- `src/hotkey/blendGuard.ts`（单例 store + `useSyncExternalStore`）：
  - 名单 `BLEND_YIELD_TOOLS`（**驼峰真实工具 ID**）+ `TOOL_CN` 中文名（提示文案）；
    匹配走归一化集合 `BLEND_YIELD_SET`（两侧 `toLowerCase()`），中文名查 `TOOL_CN_NORM`；
  - ⛔⛔ 工具 ID 一律驼峰（2026-10-30 用户用 Alchemist 抓 API 核对）：除第一个单词外每个单词
    首字母大写 —— `gradientTool` / `cloneStampTool` / `patternStampTool`。
    **历史记录艺术画笔 = `artBrushTool`**，`artHistoryBrushTool` 在 PS 里根本不存在
    （旧代码凭字面猜的，写进三处：`blendGuard` / `HotkeyBridge` 的 `TOOL_TYPE_CN` /
    `app.tsx` 的 `AUTO_OFF_TOOLS`）；写成全小写或错词 = 永远匹配不上，表现是
    「站在该工具上按 Alt+Shift+J 还是改面板」；
  - `noteToolForBlendYield(tool)` 是**唯一喂点**，tool 为 null（读失败）时**什么都不做**
    （读失败 ≠ 换工具；当成「不是动笔类」会让让位在偶发读失败时闪回接管）；
  - `recompute(resend)`：`want = getBlendHotkeyOn() && isBlendYieldTool(lastTool)`；
    `resend=true` 只在配置帧（= 重连/落盘对齐）时用，`false` 用于工具读数（工具没变直接 return，避免每秒一帧 WS）。
- 喂点三处（app.tsx）：`handleNotification` 的 `select` 快通路（**无前置条件**，纯解析 descriptor）、
  `pollToolChange`、`pollSmoothToolGate`。
- 巡检归属：`blendGuardWatchNeeded()`（= 开关开着）让 `syncToolWatch` 建 1s 巡检；
  `syncSmoothToolWatch` 的 `need` 加 `!blendActive` **让位**，否则两条 1s 巡检同时读工具 ⇒
  2.5 → 3.5 次/秒，超 psAccess 的 3.3 次/秒吞吐上限（用户看到的「读条卡住」）。
  让位前必须把 `pollToolChange` 的闸门供给条件放宽到 `pen.enabled || polySnapEnabled`，否则
  「平滑关 + 吸附开 + 混合模式开」组合下 `poly_snap_run` 的闸门会断供（0x0223 的老病）。
- UI（`FuncHotkeyPanel` 的混合模式开关行）：`blendShownOn = blendHotkeyOn && !yielded`，
  让位时**置灰 + 一行 11px 说明**。⛔ 不做「看起来关了还能点」：那时显示值不来自配置，
  点一下会写出半真半假的配置，切回套索开关还会自己跳回来。

## 四、语义边界（用户可改的两处）

- 让位判断是**无状态**的：`让位 ⇔ 当前工具在名单里`。所以「画笔 → 移动工具」也会恢复接管
  （不是只有「切回套索」才恢复）。好处是显示永远与实际一致；若用户要求「只在套索恢复」，
  就得改成带记忆的状态机（`wasOn` 锁存 + 只在 lasso 释放）。
- 名单**不含橡皮/混合器画笔**：用户没点名，多算一个就是悄悄取消他要的功能。

## 五、排障判据（`pi8li.log`）

- `混合模式热键临时让出` / `恢复接管`：面板推过来的翻面（客户端线程打）。
- `★诊断：混合模式热键让位（当前工具自带混合模式）⇒ 放行 Alt+Shift+J`：钩子真的走到放行分支（首次一次）。
- `混合模式热键让位中：N 条 Alt+Shift 键不注册，交回 PS`：RegisterHotKey 侧真的撤了。
- `hotkeyState.blendYield`：原生当下的让位位（`hotkeyStatus` 回帧即可读到）。
- 三条里少了「不注册」那条 = 键仍被系统摘走，现象是「按了完全没反应」（比原来的「改错地方」更迷惑）。
