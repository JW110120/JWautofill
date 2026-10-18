# 套索实时平滑（方案 A：输入层滤波）— 明细

> 由 `MEMORY.md` 下沉而来（2026-10-12）。主索引只留导航，这里放全部细节与踩坑。
> ⛔ 2026-10-17 大整理：方案原文与迁移计划（`docs/lasso-realtime-smoothing-plan.md` /
> `lasso-pipl-8li-migration-plan.md`）已随本地清理删除 —— 二者均属「执行期计划」，
> 结论全部沉淀在本文件与 `HISTORY.md`；本文件即唯一现存权威。

> ⛔⛔ **2026-10-14 架构变更横幅（M3）**：平滑已从「外置 SmoothDaemon(18924) + 注入
> JWautofillWintabHook.dll」迁到 **PS 进程内 .8li 插件**（native/JWautofillHost/，
> smooth_engine.c = 旧 wintab_hook.c 整体编入，plugin_main.c = 旧 Program.cs
> ROLE_SMOOTH 的 C 移植，WS 协议逐字兼容）。native/SmoothDaemon/ 与 native/WintabHook/
> 已删除，面板的 daemon 拉起/卸载链路已删。**本文档中引擎/算法层细节（HUD、标定、
> 拉绳、落笔判据、槽位表、诊断码）依然有效**（代码原样搬入 .8li）；但凡涉及
> 「两个守护进程 / 注入 DLL / 安装目录 %LOCALAPPDATA%\JWautofill\smooth / 卸载脚本」
> 的 daemon 专属内容已作废（迁移记录见 `HISTORY.md`「套索实时平滑：从鼠标钩子到 .8li」）。

## 1. 定位

- UXP **无画布指针 API** ⇒ 绘制过程对插件是盲区；唯一实时入口是「PS 收到输入之前」
  = 原生钩子 + 回注。**两个独立产物**（2026-10-12 起，⛔ M4 起下表左列全部作废——
  `native/HotkeyDaemon/` 与 `native/SmoothDaemon/` 两个工程项目已删除，两端点
  合入 `native/JWautofillHost/` 一个 .8li：`plugin_main.c`（平滑）+ `keyhook.c`（热键））：
  | | 热键 | 平滑 |
  | --- | --- | --- |
  | 源码 | `native/HotkeyDaemon/Program.cs`（**同一份**，靠编译期 `ROLE_SMOOTH` 分岔） |
  | 工程 | `native/HotkeyDaemon/*.csproj` | `native/SmoothDaemon/*.csproj`（`<Compile Include="../HotkeyDaemon/Program.cs" />`） |
  | 端口 | 18923 | 18924 |
  | 安装目录 | `%LOCALAPPDATA%\JWautofill\daemon\` | `%LOCALAPPDATA%\JWautofill\smooth\` |
  | UXP 桥接 | `src/hotkey/HotkeyBridge.ts` | `src/lasso/SmoothBridge.ts` |
  ⛔ 面板「停止 / 卸载服务」是**进程级**；此前共用一个进程 ⇒ 停热键把平滑一起带走
  （用户报的「卸载快捷键服务后平滑显示未连接」）。拆成两个 exe 后才真正解耦
  （当时用本地 WS 探针双向对拍实证，脚本已随 2026-10-17 清理删除）。
- 与「选区改造」是**两条独立路径**：本功能作用在**输入轨迹**，后者作用在**已生成的选区掩码**；
  可同时开启（效果串联）。⚠️ 2026-10-12 起「选区改造」里的**平滑滑块已删除**
  （`state.selectionSmooth` / `SelectionOptions.selectionSmooth` / `DragHandler` 配置 / 文案全清），
  该分区只剩「锐度 / 扩散」两个作用在掩码上的参数。
- UXP 侧桥接：`src/lasso/LassoSmoothing.ts`（**不持有 WebSocket**，发送器与连接状态由
  **`SmoothBridge`** 注入 —— 它是 18924 那条连接的唯一属主）。

## 2. 拦截层与闸门

- ⛔ 防回环双判据：`LLMHF_INJECTED` + `dwExtraInfo` 签名（`0x4A574155` / 'JWAU'）。
- 四道布防闸门：已布防 + PS 前台 + 左键按下 + 按下点在 PS 窗口（`IsPhotoshopWindowAt`）。
- ⛔⛔ **回注必须用绝对坐标**（`MOUSEEVENTF_ABSOLUTE|VIRTUALDESK`）。曾经的「相对移动 +
  每帧 `GetCursorPos` 自校正」被否决（理由是躲多屏/缩放归一化坑），但它会吃**指针加速**
  且闭环过冲 ⇒ 现已实测推翻，改用绝对坐标（见 §4.1）。
- ⛔ **回注必须在独立线程**，绝不在钩子回调里 —— 见 §4.1（这是本轮最重要的一条）。

## 3. 面板与状态

- ⛔ `smoothStatus` 是守护进程回报的**实时状态**，必须列入「参数复位」的保持项 ——
  被 `...initialState` 打回 `connected:false` 后状态行会谎报「未连接」，且**不会自愈**
  （广播只在布防/撤防/连接变化时发）。
- 复位语义：**保留** `smoothEnabled`（功能开关，与 `strokeEnabled` 同理）、复位 `smoothParams`，
  并在复位回调里**重新下发**参数（否则面板显示默认值、daemon 仍用旧值）。
- ⛔ 参数下发：90ms 节流 + **线格式签名去重**（否则 300ms 工具巡检每轮打一条 WS）；拖动首个值必须立即发。
- ⛔ **「不适用就整行隐藏」（而非置灰）**：`smoothParamApplies()` 取代早先的 `smoothParamDisabled()`。
  归属（与 `LassoMouseSmoother` 分支一一对应，勿凭感觉改）：
  | 参数 | 适用模式 |
  | --- | --- |
  | 半径 / 间距 | 三种都用到（恒显示） |
  | 强度 / 拐角 / 速度适应 | 仅「标准」（拉绳与追笔都不读 `Strength`） |
  | 张力 | 仅「拉绳」 |
  | 追笔 | 仅「追笔」 |
  ⚠️ 这是对本仓「不隐藏只禁用」铁律的**局部豁免**：该铁律的目的是防止隐藏后版式大幅塌陷，
  而这里每行等高、只让后续行整体上移 ⇒ 省空间的收益更大。
  ⚠️ 切换模式会增删整行 ⇒ `handleSmoothModeChange` 末尾必须 `resyncNativeWidgets()`，
  否则 UXP 在原位留「残影数字」。
- ⛔⛔ **参与渲染的判据必须放在 `state` 里（`smoothArmed` 取代实例字段 `lassoArmed`）**：
  布防是在 300ms 工具巡检里**异步**完成的 ⇒ 那一刻没有 `setState` ⇒ 不重渲染 ⇒
  状态行停在布防前算出的过期判定（真机：套索下打开总开关仍显示「待命（当前不是套索工具）」，画一笔才跳）。
  **「实例字段被异步写入」是「界面不刷新」的通用根因**；写入方按跃变 `setState`，判据只读 state。
- ⛔ **「读不到工具」≠「不是套索工具」**：`pollToolChange` 失败置 `smoothToolErr`，
  文案区分「待命（无法读取当前工具）」与「待命（当前工具：多边形套索）」（未知 ID 原样显示枚举名）。
  把两种失败混成一句话会直接把排查带偏（真机「被安全软件拦截」就是这样被骗出来的）。
- ⛔ 状态上报只能由 `SmoothWatchdog` 做（120ms 采样、2s 健康检查、跨两轮稳定的跃变才播）：
  `SetSmoothArm` 返回时钩子**还没装上**（`SetWindowsHookEx` 在钩子线程异步执行）⇒
  在那里广播会让面板每次启用都闪一下红色「启动失败」；拖拽跃变发生在钩子线程内，而钩子线程严禁 I/O。
- ⛔ **总开关与「平滑服务」开关已二合一**（2026-10-12）：原先三行 `启用平滑 / 状态 / 平滑服务`
  造成「要先开服务再开平滑、且服务没开时点平滑开关毫无反应」的困惑。现只剩**一条状态条**
  （`.notify-bar` + `.indicator` + `.notify-text` + `.mask-sync-status-spacer` + `ToggleSwitch`），
  形态与「笔刷热键」分区（`BrushHotkeySection`）的服务条完全同款。
  语义：开 = 拉起平滑服务 + 布防；关 = 撤防 + 让平滑服务退出（**仍只停平滑自己那一个进程**）。
  - 四档色：灰（未启用）/ 橙（服务没起来、协议过旧，**要用户处置**）/ 红（钩子被拦、熔断）/
    绿（就绪、绘制中）；「待命（当前不是套索工具）」走**中性**（无修饰类 + 灰点）——不是故障，别染警告色。
  - `smoothStatusTone()` → `smoothBarTone()`（返回 `notify-bar-*`），指示点由 `smoothDotOfTone()`
    **映射**得到，不重判一次判据（判据写两遍，漂移一次就再也对不上）。
  - 新增中间态文案「平滑服务启动中…」（判据 `smoothEnabled && !connected`）：守护进程自安装 + 建连要 1~3 秒，
    此前只能显示「未启动」，看起来像开关失灵。
  - 顺带删掉 `.smooth-state` 三档样式与 helpTexts 的 `smoothEnabled` / `smoothService` /
    `smoothServiceSwitch`（二合一后已无对应 UI）。

## 4. 回注架构 与 熔断（**2026-10-12 第四轮定案，已重构**）

### 4.1 真凶：`SendInput` 绝不能在低层钩子回调里调用

- ⛔⛔⛔ **根因（实测，不是推测）**：在 `WH_MOUSE_LL` 回调里**同步** `SendInput`，注入事件要等本回调
  返回才能入队，而系统又在等回调返回 ⇒ 卡到 Windows 的 `LowLevelHooksTimeout`（默认 **300ms**）才解开。
  真机每一笔拖拽的日志都是同一形状（304/305/309/310/312/314/315ms，**100% 是回注耗时**）：
  `本次拖拽原始 519 点 / 注入 306 点（最差一帧 305ms，其中回注占 305ms）`
  ⇒ 每笔拖拽都可能**冻结整个系统输入队列数百毫秒**，观感就是「拖很长、画一小段、还抖」。
- ⛔ **该阻塞不可中断**：一旦卡住，进程**永远停不下来**（真机复现两个进程停在
  「`HasExited=True` 但对象不回收、端口一直被占、`TerminateProcess` 返回 ACCESS_DENIED(5)」）。
  清干净只能重启。
- ✅ **收口**：回注整体搬到独立线程（`InjectThreadProc`）。
  - 钩子回调：只写 `_injectTargetX/Y` + `_injectSignal.Set()`，微秒级返回，**永不阻塞**。
  - 回注线程：独占 `SendInput`；连续多帧只补最新位置 ⇒ **天然合并 / 自适应抽稀**。
  - 注入方式改为 **绝对坐标**（`MOUSEEVENTF_ABSOLUTE|VIRTUALDESK`）：相对移动会被
    **指针加速**整形（本机 `SPI_GETMOUSE=[6,10,1]`，即「提高指针精确度」开启）⇒ 位移不守恒，
    而注入是闭环的（每帧 `GetCursorPos` 取差）⇒ 过冲会在下一帧变成反向修正 ⇒ 光标来回抖。
    绝对坐标不经加速，位移严格等于请求值，两个问题一起消失。

### 4.2 熔断与耗时预算

- 现为：鼠标回调预算 **`50ms`**（回注搬走后才敢收紧）+ `SafeModeStrikes=**3**` **连续**超预算才熔断，
  任一回落到预算内即清零；熔断由**本侧**看护线程冷却后复位并重挂。
  （历史：曾因「回调里必然含一次 300ms 级 `SendInput`」而把预算放宽到 120ms —— **那是错的**，
  等于用放宽预算去迁就一个不该存在的阻塞，结果熔断形同虚设：每笔只超 1 帧，连续计数总被清零。）
- ⛔⛔ **新增安全网 `_injectBusySince`**：回注线程进入 `SendInput` 前盖时间戳、返回后清零；
  钩子每帧检查，超过 `InjectStallGuardMs=400ms` 未归还 ⇒ **立即熔断 + 放行原始事件**。
  理由：接管中我们会**吞掉**原始移动，回注一卡光标就彻底不动（用户只会以为鼠标坏了）。
  ⛔ 这类熔断 **不自动复位**（`SendInput` 卡住不会自己回来，自动复位只会再冻一次）。
  `smoothState` 新增 `injectCalls / injectLastMs / injectMaxMs / injectOver100Ms / injectBusyMs`。
- ⛔⛔ **钩子回调内绝不写日志**（哪怕 `Console.WriteLine` 已重定向）。热路径统一
  「钩子内只置 volatile 标志 + 看护线程下一轮代打」；本笔汇总日志改由**回注线程排空后**转交，
  这样计数才是最终值（`_smoothDragLogArmed`）。
- ✅ **耗时拆解**：`maxCb*` 随每一笔清零、`worstOver*` 永不重置。
  ⚠️ 回注搬走后 `maxCbMs` 应当长期为 **0~2ms**；若再飙高 ⇒ 有人在回调里又混进重活。
  **诊断只看 `smoothStatus`，别靠改预算去试。**
- ⛔ `{"type":"pointerTest"}` 是自检命令：对拍 `相对 / 绝对 / SetCursorPos` 的位移守恒率并回读
  `SPI_GETMOUSE`。⚠️ 它自身会 `SendInput`；**输入队列若已被别的进程占住，它会让本进程也卡死**，
  只在确认输入通路健康时用。

## 5. 算法现状与已知弱点（标准模式）

```csharp
double k = Math.Pow(0.18, Clamp01(s.Strength / 100.0));   // 强度 40 ⇒ k ≈ 0.50
if (s.SpeedAdaptive) { double boost = Math.Min(1.0, _speed / 1.2) * 0.5; k += (1.0 - k) * boost; }
if (corner) k = Math.Max(k, 0.75);                        // ← 拐角守卫
_ox += distX * k;
```

- ⚠️ **拐角守卫是「有延迟却不平滑」的主要嫌疑**：`cornerAngle` 默认 45°，慢速手抖时相邻两帧
  夹角经常 > 45° ⇒ `k` 被抬到 0.75 ⇒ 平滑几乎被关掉，只剩一阶低通的滞后。
- ⚠️ **速度适应方向相反**：为减少甩笔滞后而在**快速移动时减弱平滑**，而那正是抖动最明显的时候。
- ⚠️ **停笔不收敛**：`Step()` 只在有鼠标事件时被调用，手一停就没有事件 ⇒ 残余滞后要等
  `WM_LBUTTONUP` 那次回注才抹平（末段被「拽直」）。
- ✅ 已于 §4.1 定案：相对移动确实吃**指针加速**（`SPI_GETMOUSE=[6,10,1]`），已改绝对坐标。
  但真正的大头是「回调内 `SendInput` 卡 300ms」，两者叠加才是用户看到的「拖很长、画很短、还抖」。
- 仍待做（等 ②a 一起排期）：拐角守卫加**位移门限**（抖动的段长通常 <3px）、加**噪声死区**、
  抬高速度适应门槛、停笔后由看护线程补一次收敛回注。

## 6. 数位板（Wintab）通路

- ✅✅ **本机 PS 走 Wintab —— 已有配置级铁证（2026-10-12 补测，不再依赖推断）**：
  `%APPDATA%\Adobe\Adobe Photoshop 2026\Adobe Photoshop 2026 Settings\PSUserConfig.txt`
  内容为 `# Use WinTab` + `UseSystemStylus 0`（2021/2024/2025/2026 **四个版本都在、内容一致**）。
  `UseSystemStylus 0` = 强制 **Wintab**（走 Windows Ink 是 `1`）；而 **PS v25+ 的默认恰恰是
  Windows Ink** ⇒ 这是显式写下的开关，不是默认值。
  ⛔ **由此得出一条 ②a 的硬约束**：该文件**用户可改**。一旦被改成 `1`，PS 立刻切回 Windows Ink
  （`WM_POINTER`），届时 inline-hook Wintab **会静默失效** ⇒ ②a 必须能识别「当前生效的笔通路」
  并在面板上如实提示，不能假定 Wintab 永远成立。
- ⚠️ 反面教训：**「PS 加载了 `WinTab32.dll`」不构成「PS 在用 Wintab」的证据** ——
  PS 对它是**静态导入**，该 DLL 与 `Wacom_Tablet.dll` 在进程里**永远存在**，与是否生效无关。
  判据只能看配置面（`PSUserConfig.txt`）或行为面（实际调用哪套 API）。
- ⛔ **低层鼠标钩子只能看到 Windows 鼠标消息**。数位板两种模式：
  - **鼠标模式 / Windows Ink**：笔输入经 Windows 合成鼠标消息 ⇒ 钩子能看到 ⇒ 现方案有效；
  - **Wintab 模式**：驱动直接把报文交给客户端，**PS 走的是 Wintab 报文而不是 `WM_MOUSEMOVE`**
    ⇒ 我们吞掉并回注鼠标消息，PS 根本不吃这条数据流 ⇒ **完全没效果**。
- ⛔ 这不是 bug，是**拦截层选错了**。Wintab **没有系统级钩子 API**，要拦只有：
  ① 注入 Photoshop 钩 `Wintab32`（高侵入、易被杀软针对、PS 升级即可能失效）；
  ② 写虚拟 HID / 驱动（内核态、需签名）；③ 让数位板走鼠标模式（零代码，失去压感 —— 套索不需要压感）。
- ✅ **模块层面佐证**（枚举 PS 已加载模块 + 扫其字符串表；⛔ 注意它**只证明代码在手边**，
  「PS 在用 Wintab」这一结论由上面那条 `PSUserConfig.txt` 负责）：
  - `Photoshop.exe` 自身含 `WinTab32.dll` 导入名与 `WTPacket / WTPacketsGet / WTOpen / WTInfo`
    ⇒ **静态导入（IAT）**，不是 `GetProcAddress`；
  - `C:\WINDOWS\SYSTEM32\WinTab32.dll` + `Wacom_Tablet.dll` 均已加载进 PS 地址空间
    （`Wacom_Tablet.dll` 是真正的实现体，`WinTab32.dll` 是转发壳）；
  - 另加载 `MouseHookPro64.8li`（⛔ **实为 LNP 自己的 PS 插件**，路径 `E://Program Files\Lazy Nezumi Pro\plugins\ps64\MouseHookPro64.8li`；2026-10-18 REA 取证定案 —— 此前误记为「Adobe 自带」，见 O30）。它不仅调 Wintab API，还钩 `GetCursorPos` / `GetMessage*` / `PeekMessage*` / `GetPointer*`（Windows Ink）⇒ 三路输入全覆盖
    ⇒ ⛔ **光钩某一处 IAT 不够**，实现上应 inline-hook `WinTab32.dll` / `Wacom_Tablet.dll`
    的**函数本体**，这样 IAT 与 `GetProcAddress` 两条路都会经过我们。
  - 本机 `HKLM\SOFTWARE\Wintab`（含 WOW6432Node）不存在、`WinTab32.dll` 也不在 KnownDLLs
    ⇒ 理论上「代理 DLL 放进 PS 安装目录」可行，但属 DLL 种植且会被 PS 升级覆盖，**不作主方案**。
- ✅ **②a 的工具链阻塞已解除（2026-10-12）**：本机原本没有任何原生编译器（无 MSVC / Windows Kits /
  gcc / clang / zig，NativeAOT 也要 MSVC 的 `link.exe`）⇒ 已装**便携 zig**：
  `bash native/get-zig.sh` → `%USERPROFILE%\zig-toolchain\zig.exe`（0.16.0，~35 秒；详见
  `refs/toolchain-and-env.md` 的「原生工具链：便携 zig」）。
  已验证 `zig cc -target x86_64-windows-gnu -shared` 产出 x64 PE DLL 且可 `LoadLibrary` 调通导出。
  ⚠️ 两个坑：① 别把 zig 放在过深路径（会退化成相对 `lib_dir` ⇒ 报 `AccessDenied`）；
  ② 下载走 PyPI + 清华镜像，不走官网（18KB/s）。
- ✅✅ **P1 注入 spike 已通过（2026-10-12 第六轮）：DLL 能注入 Photoshop，安全软件不拦。**
  实测 `CreateRemoteThread` + `LoadLibraryW` 注入 PS 2026（PID 19284）成功，探针 DLL 在 PS 进程内
  写下证据文件 `%TEMP%\jwprobe-<pid>.log`，PS `Responding=True` 未崩；随后远程 `FreeLibrary`
  卸载成功、模块表恢复干净。**`QQPCRTP`（实时防护，Session 0）+ `MsMpEng` 全程在跑，未拦截。**
  实验含**无害对照组**（先注入一个 `python.exe` 长驻进程，也成功）⇒ 排除「注入器写错」。
  ⛔ **三个坑**：① `GetExitCodeThread` 只回传 32 位 ⇒ 用它取远程 `LoadLibraryW` 的 HMODULE 会
  **静默截断高位**，拿截断值 `FreeLibrary` 必返回 FALSE 且无任何报错 ⇒ 判定成功改用证据文件、
  卸载改用 `EnumProcessModulesEx` 按名字查真实基址；② 十六进制地址**不要手算**；
  ③ `kernel32.dll` 是共享映像 ⇒ 本进程 `GetProcAddress` 的地址在目标进程同样有效，无需远程解析。
  产物：本地一次性探针（最小证据 DLL + 注入/卸载器，gitignored，2026-10-17 已清理；
  复用结论 = 成功判定看证据文件、卸载按名查真实基址）。
  ⇒ ②a 的重心从「能不能进」转为「inline hook 稳定性 + 杀软对**长期驻留/改代码段**是否更敏感」。
- ✅ **DPI 感知已落地**（绝对注入的坐标口径）：`native/app.manifest`（两角色共用，`PerMonitorV2`
  + Win10 `supportedOS`——缺它整条 `dpiAwareness` 被静默忽略 + 显式 `asInvoker`）+ Main 第一行
  `EnsureDpiAwareness()` 兜底。`getState` 暴露 `dpiAwareness`，真机两角色均报 `permonitor-v2`。
  ⛔ 这个差别在 100% 缩放的机器上**看不出来** ⇒ 有人报「光标画偏」先查这个字段。
- ⚠️ 判定手法（30 秒，零代码，**仍需真机用手握笔跑一次**）：当时用
  `analysis/ws-tablet-probe.cjs`（已随本地清理删除，需要时按同协议重写：向平滑服务
  问一次状态即可）—— 按提示先用鼠标划、再用笔划，看 `callbacks` 增量；
  笔段增量为 0 ⇒ 确认绕过鼠标通路。

### 6.1 P3 最小可用版：注入 PS 改写 Wintab 包坐标（2026-10-12 落地）

- **架构**：面板 —WS(18924)→ `SmoothDaemon` —命名共享内存→ `JWautofillWintabHook.dll`（**在 PS 进程内**）。
  平滑**不在守护进程里**：坐标只在 PS 进程内的 `WTPacketsGet` 缓冲区，进程外拿不到 ⇒ 只能注入就地改写。
- **配置通道** = `Local\JWautofillWintabSmooth`（32 个 32 位槽；C# 侧 `PenHook` 槽位表必须与 C 侧
  `enum CFG_I_*` **逐项对应**）。detour 里读配置只是**普通内存读** ⇒ 守住「detour 零 I/O」。
- ⛔⛔ **心跳防呆**：守护进程每秒写 `GetTickCount()`（**必须自开机起的毫秒口径**，两侧同源才能相减），
  DLL 侧 3 秒无更新即**自动停手**。否则守护进程被强杀后共享内存不消失、`enabled` 永远停在 1，
  PS 会被一段「没人管」的平滑一直改着坐标。
- ⛔ **标定必须交叉验证后才允许写**：`WTGetA` 读 `lcPktData` 掩码推算布局（`pkContext` 8/4 两种尺寸
  都用**真实数据**裁决）＋「序号逐包 +1」验数据；另有**盲扫**独立找同一对 `(stride, offSerial)`，
  两者必须一致。不一致 ⇒ `state=2`、**只 dump 原始字节绝不改写**（写错偏移会污染 buttons ⇒ 幽灵按键）。
- ⛔ **线程冻结表溢出 ⇒ 放弃改写**（只冻一部分等于没冻，撕裂会跳野地址）。
- ⛔ **`try_calibrate` 是从 detour 里调的 ⇒ 绝不能落盘**：`logf` 会 `WriteFile + FlushFileBuffers`
  跑在 PS 取包线程上，且 `log_write` 还会自旋抢日志锁。改为只拼内存缓冲（`calib_logf`），
  由 worker 补写（`calib_publish` 统一抬 ready）。
- **算法（C 版）**：与守护进程 Mode 0 同源，两处刻意差异 —— `k = 1.0 - 0.85·(t/100)`（线性，避免 libm 的
  `pow`）；**不做 `MinSampleDist` 抽稀**（Wintab 包必须原样写回，抽掉会打乱 PS 时间轴）。
  保留速度低通 / 拐角守卫 / 速度自适应 / 滞后上限 / 起笔锚定。输出恒为「上一输出」与「本包输入」的
  凸组合 ⇒ **数学上有界**，不会产生越界坐标。
- ⛔⛔ **两层能力探测不可合并**：套索平滑的探针（「有没有回 `smoothState`」）对**旧版守护进程是通过的**
  ——它支持套索平滑、会正常回帧，只是帧里没有 `pen`。只看 `unsupported` ⇒ 笔开关显示成**可点**，
  点下去指令被静默丢弃、开关弹回 ⇒ 又一个「点了没反应」。判据因此下沉一层：
  **回帧里有没有出现过 `pen` 字段** ⇒ `LassoSmoothStatus.penUnsupported`。
- ⛔ **已装副本不会自己更新**：换新版只有「面板平滑开关**先关再开**」（关=发 `shutdown` 杀进程，
  开=从**插件目录**拉起 → 自安装覆盖 `%LOCALAPPDATA%\JWautofill\smooth\` → 从安装目录重跑）。
  改 `Program.cs` 后同样是**两步**：先 `dotnet publish` 再 `yarn build`（**顺序不能反**）。
- **产物**：`native/WintabHook/{wintab_hook.c,build.sh}`（`-Wall -Wextra` 零告警）、
  `Program.cs` 内 `#if ROLE_SMOOTH` 的 `PenHook`、`src/lasso/SmoothBridge.ts` 的 `sendPenSmooth`。
  诊断日志：`%TEMP%\jwwh-<Photoshop 的 pid>.log`（注意是 **PS** 的 pid，不是守护进程的）。

## 7. 与安全软件的相互干扰

- ⛔ 遇到「钩子装不上 / 输入卡顿 / 进程杀不掉」，**第一步查安全软件**：
  本机「关了电脑管家」只关了托盘界面，`QQPCRTP.exe`（Session 0 实时防护）**仍在跑**。
  它 ① 过滤 / 节流注入的输入（曾是 300ms 抖动的候选根因 —— **现已由 §4.1 用更紧的解释替代**：
  300ms 恰好是 `LowLevelHooksTimeout`，且日志显示耗时 100% 落在回注）
  ② 自保护会拦截对「带全局输入钩子进程」的 `taskkill /F`（报「成功」但进程仍在）与 `Stop-Process`（静默失败）。
  自检：`tasklist | grep -iE "QQPC|MsMpEng"`。
- ⚠️ 2026-10-12 又见「杀不掉」的另一种形态：`HasExited=True`、端口仍占、
  `taskkill` 报「没有此任务的实例」、`TerminateProcess` 返回 `ACCESS_DENIED(5)`。
  两种解释都成立且不互斥（① 安全软件自保护；② 进程真的卡在内核调用里 ⇒ 停在「已终止但不回收」）。
  **处置结论：重启清干净，别在旧进程上继续试。**

## 8. 诊断工具（scripts/ 沉淀区，git 跟踪）

> ⛔ 2026-10-17 大整理：原 §8 表格列的探针工具（`ws-*-probe.cjs` / `pe-imports.py` /
> `spike/` / `hookprobe/` 等）全部是 gitignored 的本地一次性脚本，已随清理删除 ⇒
> **记忆不再按文件名引用它们**（跨机必然悬空）。
> **目录分工（2026-10-17 定）**：`scripts/` = 沉淀后的诊断工具（git 跟踪、跨机同步，
> 复核后才从 `analysis/` 晋升）；`analysis/` = 临时分析报告与未复核工具（gitignored）。
>
> **已沉淀工具（scripts/，随仓库同步）**：
> - `wintab_axis_probe.py` / `wintab_layout_probe.py`：WTInfo 只读侦察（不注入、不模拟
>   输入）；低配机复测 Wintab 行为时可直接跑。
> - 截图取证链：`img2bmp.ps1`（任意图→24bpp BMP）→ `bmp_measure.py`（HUD/UI 几何测量：
>   Kasa 圆拟合 + 连通域 + 端点距离，纯标准库）→ `img_crop_zoom.ps1`（裁剪+最近邻放大）、
>   `img2ascii.ps1`（ASCII 概览，不看图判断结构）。⛔ 测量源仅限用户确认为真实的截图。
>
> 方法论教训保留：① 「从实现**原样抽取**函数编离线自检」——手抄会与实现漂移，
> 「测试通过」即成假证据（标定函数的 stride/offX/offY 结论见 §9，勿重新猜）；
> ② 注入类实验在沙箱里会被 SIGTERM（见下方沙箱限制）。

### ★ 可复用结论：Wintab 系 DLL 的导出入口 = 5 字节 `E9` 桩（2026-10-12 实测）

`WinTab32.dll` / `Wacom_Tablet.dll` 的**每个导出入口本体只有一条 5 字节 `E9 rel32`**，
磁盘 == 内存（出厂代码，连 Wacom 自带的 `MouseHookPro64.8li` 都没动它），`E9` 的目标是真实现体。

⇒ **想做输入层拦截，这里是近乎零风险的落点**：
① 一条独立完整的指令被覆盖 ⇒ **不需要长度解码器、不需要搬迁指令**；
② `impl` 就是跳转终点 ⇒ **直接 call impl 与原语义逐位等价，不需要跳板**；
③ 入口是所有调用方的必经之路（静态 IAT / `GetProcAddress` / 插件）⇒ **只钩这一处就够**。
唯一约束是 `E9 rel32` 只有 ±2GB 射程 ⇒ 必须在目标附近扫一块地皮放 `mov rax,imm64;jmp rax` 转发桩。

⛔ 但三条硬约束不能省：
- 动手前**必须**验 `entry[0]==0xE9` 且 `impl` 在同一映像内，不满足就跳过（别假定将来 PS/驱动不改编译方式）。
- 改写 5 字节**不是原子操作** ⇒ 必须挂起其它线程（PS **151** 个线程、轮询 50+Hz），
  否则撕裂读会跳野地址。窗口内**只放不需要 loader lock 的调用**，`LoadLibrary`/`GetProcAddress` 放窗口外。
- 卸载前**必须先还原字节**再 `FreeLibrary`，否则入口里留着指向已卸载模块的 `jmp`，进程必崩。

⛔ **`Wintab32` 是 `Wacom_Tablet` 的上层包装**（实测：只调 `Wintab32!WTInfoA` 会让
`Wacom_Tablet!WTInfoA` 计数先变 1）⇒ 同时钩两层会**双计数**，实际处理只能放一层（实测两者 `pkts` **严格相等** 3158=3158）。

★ **PS 的笔通路 = 轮询 `WTPacketsGet`（唯一咽喉）**：注入后用户没碰笔，500ms 内 PS 已调
`WTPacketsGet` ~29 次（`cMaxPkts=128`）⇒ 是**轮询取包队列**，不是事件推送。
**2026-10-12 笔测（P2 终验）**：复位后**只有 `WTPacketsGet` 被调用**
（`WTPacket` / `WTPacketsPeek` / `WTDataGet` / `WTInfoA` 调用数**全 0**）；空转 **5.2 分钟 `pkts=0`**
→ 用笔划几笔，30.6 秒内 `pkts` **0→3158**（≈204 包/秒，5 段 0.8~8.2s）→ 停笔后 **129 秒 `pkts` 冻结**
⇒ **钩子确凿落在笔的数据流上且不假阳性**。
⇒ **P3 只钩 `WTPacketsGet` 一个函数、只钩外层 `Wintab32` 一层**，在 detour `call impl` 之后改写 `lpPkts`。
卸载复核：`unhook` 还原 **10/10**，两 DLL ×5 入口逐字节 **== 磁盘**。PS 全程存活。

⚠️ **沙箱限制（本轮踩到）**：本地 agent 沙箱会 **SIGTERM 掉任何尝试注入输入的进程**，
并**屏蔽 `reg.exe` / `wsl.exe` / 从 bash 调用 PowerShell**。
⇒ 需要注入输入 / 读注册表的实验，要么改用守护进程自检命令，要么换 `PowerShell` 工具。

---

## 6.2 P3.1 参数链路修复 + 拉绳 HUD（2026-10-12，待真机验证）

### ⛔ 根因：笔通路只接到一个参数，而且那个也接不通
| 面板参数 | 鼠标通路 | 笔通路（P3 时） |
| --- | --- | --- |
| 强度 | ✅ | ⚠️ `togglePenSmooth()` 只发 `{on}` ⇒ 恒为 daemon 默认 **40** |
| 半径 | ✅ | ❌ `_radiusPct` **零写入点**，恒 25（轴上界 0.25%） |
| 张力/追笔 | ✅ | ❌ DLL **无模式分发**，永远走标准低通 |
| 拐角 | ✅ | ❌ C 侧硬编码 45° |
| 速度自适应 | ✅ 可关 | ⚠️ `_flags` 零写入点 ⇒ 常开 |
| 采样间距 | ✅ | ❌ 刻意不做（Wintab 包必须原样写回） |

**第二层根因**：笔实测 **205Hz**，旧 C 版 `k=1−0.85t/100` ⇒ 强度 40 时 k≈0.73，
稳态滞后 `v·dt·(1−k)/k ≈ 0.9px` ⇒ **亚像素，客观上无法感知**。
（用户真机现象「已平滑 47417 包但各种参数组合感知不明显」由此完全解释。）

### 修法
- `penSmooth` WS 指令扩为**整包参数**（字段全可空 = 缺省保持原值）；
  面板 `setPenSmooth(on, params)` 记住 `penOn`，`sendParams` 里**笔开着就同步推一份**。
- 共享内存槽扩到 **28 项**（新增 MODE/TENSION/CATCHUP/CORNER/RADIUSPX/HUD/HUDCOLOR/PXPERAXIS，
  **删掉已死的 RADIUSPCT**）。⛔ 槽位表 C 与 C# **两处手写**，错位不报错只静默失效
  ⇒ C 侧编译期断言 + C# 侧 `EnsureInit` 运行时越界抛错，**两侧都要有**。
- **强度改按时间常数定义**：`τ = 8ms·(0.18^(−t/100) − 1)`、`k = dt/(dt+τ)`
  ⇒ 稳态滞后 = v·τ，**与采样率解耦**，两条通路同数字同手感。强度 40 的笔通路滞后
  0.9px → **3.65px**。`exp`/`cos` 用 Maclaurin 自己算，**不引 libm**。
- 半径单位改为**屏幕像素**（与面板 1–40px 一致），经 `pxPerAxis` 换算。

### ⛔ 轴→像素比：不猜 Wintab 语义，用真实光标标定
屏幕上看到的光标**就是**平滑后的输出点 ⇒ `pxPerAxis = |Δ光标| / |Δ输出轴|`（低通 0.85/0.15）。
标定值经 `CFG_I_PXPERAXIS`（×1000）上报：**1.0** = 包坐标即屏幕像素；**0.0586** = 数位板逻辑单位。
 leash 长度/位置不对时第一个看它。

### 拉绳 HUD（overlay 形态，用户 2026-10-12 明确决定走这条）
- **为什么只能 overlay**：UXP 无画布绘制 API；PS 原生画笔绳线只由**它自己**的画笔平滑触发，
  我们在 Wintab 层改写 ⇒ PS 不会替我们画。
- ⛔ **detour 铁律没有被违背**：detour 只多写 5 个普通内存字段，零系统调用；
  建窗/标定/绘制/消息循环全在**独立渲染线程**。被放松的只有「DLL 不碰 UI」这一条。
- 风险最小化：192×192 **跟随光标**（不是全屏顶层窗）、空闲 250ms 隐藏、
  `NOACTIVATE+TRANSPARENT+NCHITTEST→HTTRANSPARENT`、`TOOLWINDOW` 不进任务栏、
  `CFG_I_HUD=0` 时窗口根本不出现。
- ⛔ **卸载顺序**：窗口过程在本模块内 ⇒ 必须**先 join 渲染线程再 FreeLibrary**。
  `hud_stop()` 由 worker 退出路径 + `jwwh_unhook` 双重保障（幂等，3s 上限）。
- 依赖从 `KERNEL32+UCRT` 增至 **`+GDI32+USER32`** —— **本轮主要杀软风险增量**。
- 面板新增「拉绳提示」开关（`showLeash` → hud 位域 bit0|bit1）；
  状态条文案改为显示**此刻真正生效的**模式/强度/半径（防「调了没反应却看不出原因」）。

---

## 9. 真机包布局的**实测结论**（2026-10-12 深夜，排障用，别再猜）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 真实包 stride | **52** | 盲扫「序号逐包 +1」+ 人工读 dump |
| offSerial | **8** | 同上 |
| offX / offY | **20 / 24** | 位移判据定解（与人工读字节一致） |
| 真实掩码 | **0x1FFC**（TIME\|CHANGED\|SERIAL\|CURSOR\|BUTTONS\|X\|Y\|Z\|NP\|TP\|ORIENTATION） | 由 (52,8,20,24) 反解 |
| 驱动 `WTGetA` 报的 lcPktData | **0x00C8**（CHANGED\|BUTTONS\|X，**缺 PK_Y**） | jwwh-1988.log |
| LOGCONTEXT: lcPktData / lcInExtX / lcInExtY | **64 / 96 / 100** | WTInfoA(cat=3/4) 实测回读，与 wintab.h 吻合 |
| 默认上下文输入量程 | X=44800, Y=29600 | 同上 |

⛔ **驱动上报的 lcPktData 与它实际吐出的包布局不是一回事**（本机实证）。所以：
- 掩码只能当**参考**，定解必须以**盲扫 + 数据判据**为准；
- `WTI_DEVICES` 的真值是 **6**（本文件曾写 0），且本机探测不到 DVC_X ⇒ 别再指望 WTInfo 取量程，
  **量程一律从 LOGCONTEXT 的 lcInExtX/lcInExtY 取**。

### ⛔ 三个「改了代码却不生效」的坑（都踩过）
1. **PS 锁住旧 DLL** ⇒ 自安装覆盖失败 ⇒ 安装目录里永远是第一版。
   修法：DLL 文件名带**内容戳**（`JWautofillWintabHook.<hash8>.dll`），且同步逻辑**不能**放进
   `if (needCopy)`（exe 未变 / DLL 变 时旧代码根本不同步）。
   ⇒ 即便如此，PS 里已加载的旧模块仍在生效：**换 DLL 必须重启 Photoshop**（新 DLL 会报 state=4）。
2. **状态只在收到 penSmooth 时广播一次** ⇒ 面板状态永久冻结（「切模式才变生效中」）。
   修法：`SmoothStatePump` 周期推送（500ms + payload 变化才发）。
3. **标定失败后 `tried=1` 永不重试**，且盲扫要求 n>=3 而真机首批常是 n=2 ⇒ 一次判死。
   修法：证据不足就放过整批，等下一批；最多试 8 次才认命。

### 参数「没感觉」的四层原因（已全部修）
① 标定失败 ⇒ 零改写；② 标称 pxPerAxis 恒为 1.0 ⇒ 半径 8px 被算成 0.34 屏幕像素，滞后上限把平滑压成 0；
③ `dt` 整批取一次 ⇒ 第 2 包起 dt=1ms，k 与追笔 step 全部失真；④ 追笔 vmax 上限 12.2px/ms（12200px/s）
远超人手速度 ⇒ 恒走「贴合」分支。另：拐角守卫加了 3px 位移门限（否则 205Hz 下每帧都判拐角 ⇒ 平滑被关掉）。

### 自检工具（结论沉淀，脚本已随本地清理删除）

- **包布局结论（勿重新猜）**：`stride=52  offSerial=8  offX=20  offY=24` —— 当初用
  「从 `wintab_hook.c` 原样抽取标定函数编译成离线 exe + 真机 dump 字节喂入」验证，
  该方法论（原样抽取而非手抄）保留；脚本本身已删。
- `scripts/wintab_layout_probe.py` / `scripts/wintab_axis_probe.py`：WTInfo 只读侦察
  （不注入、不模拟输入），已沉淀（git 跟踪），低配机复测可直接跑。

---

## 2026-10-13 第二轮：拉绳语义 / 张力删除 / 工具闸门 的根因与铁律

### A. 拉绳（mode==1）必须是**定长绳**，不得写成逐包比例跟随
真机现象：套索光标与洋红点（HUD 的绘制点标记）**始终重合**，毫无拉绳感。
读数：截图里洋红点相对圆心偏移 ≈ 0 ⇒ 输出点与原始点几乎相等 ⇒ **算法没产生滞后**。

根因：`mode==1` 的「绳未绷紧」分支写的是
```c
} else { g_ox += dx*0.25; g_oy += dy*0.25; }   /* 错 */
```
205Hz ⇒ 包间隔 ~5ms ⇒ 一阶系统 τ = dt·(1−α)/α ≈ 15ms ⇒ 稳态滞后 = v·τ（500px/s 时 ≈7px），
再被半径上限一夹就归零。

⛔ **正确实现（现已落地）**：`dist ≤ rope` ⇒ 输出点**一字节不动**；`dist > rope` ⇒ 拖到恰好 `rope` 处。
这才是用户描述的 PS 原生语义三连：「绳没绷紧 ⇒ 光标在圈内自由走、绘制点钉在圆心」/
「绷紧 ⇒ 圈被光标拖着走」/「光标永远出不了圈」（因为圈就是硬上限本身）。
⚠️ 固有副作用（不是缺陷）：**半径很大时短笔画会先只画一个点** —— 绳真没绷紧就真不动。半径调小即恢复。

### B. 「张力」已删除（并入「半径」）
根因：`leash_px()` 里张力只在 `15%~100%` 之间**缩放半径** ⇒ 半径 100 + 张力 50 ⇒ 圈只有 58px。
两个滑杆改的是同一件事，用户实测后要求删除。现在 **绳长 ≡ 半径**，一个参数一个语义。

⛔⛔ **槽位 21（`CFG_I_TENSION`）刻意保留空洞，绝不重编号**：
它与 C# 的 `I_*` 常量逐项对应，少写一项就让后面 11 个槽整体错位 —— 而**错位不报错**，只静默出怪事。
（C 侧还有编译期断言 `cfg_slot_fit_check` 只兜住「总长够不够」，兜不住错位。）

### C. 工具闸门必须 **fail-closed**，且工具 ID 必须做形态归一
真机现象：用铅笔等非套索工具**落笔也弹出套索 HUD**。原生侧 `tool_gate_ok()` 只在
「值是 0 且 3s 内新鲜」时禁止、否则放行 ⇒ 只要面板下发的不是 0，闸门就等于不存在。两个来源：

1. ⛔ `application.tool` 的返回形态**不固定**：裸串 `"lassoTool"` / `{_enum}` / `{_obj}` 都出现过。
   旧实现只看 `_enum`/`_value` ⇒ 回裸串时恒为 null ⇒ 上报「未知(2)」⇒ **放行**。
   ⇒ 统一走 `HotkeyBridge.normalizeToolId()`（吃 `string / _enum / _value / _obj / tool / id / name`）。
2. ⛔ 面板**读失败时不得把闸门改回 2**（2 = 放行）。一次偶发失败（宿主忙、世代号刚变）就整段失守。
   ⇒ `app.tsx` 的 `applyToolGate()`：读失败**沿用上次判定**（`setSmoothToolGate(同值)` 仍会续期时间戳，
   于是「不是套索」的 0 保持新鲜有效）；只有「从未读到过」才维持初值 2。
3. 诊断：状态条**常驻显示读到的工具 ID 原文**（`App.lastToolRead`）。「读错了工具」与
   「压根没读到」处置完全不同，而这两态在界面上原本不可分辨。

### D. 平滑「感知」被两个量程杀死（同第二轮修）
- ⛔⛔ `SPEED_FULL` 原为 1.2px/ms，而**人的常规运笔区间是 0.05~1.5px/ms**
  ⇒ 常规画线也被判成「甩笔」：500px/s 时 boost=0.42 ⇒ k 被抬到 τ_eff≈15ms ⇒ 滞后只剩 ~8px。
  这正是「强度拉满也没感觉」的主因之一。现为 **3.0px/ms**，混合系数 0.5→0.4。
- `tau_from_strength` 上限 36ms → **100ms**（`TAU_LN = ln(13.5)`，`TAU_BASE_MS = 8`）。
- 顺手真 bug：`utils/DragHandler.ts` 的 `'smooth:radius'` 上限仍是 **40**（半径上限改 100 时漏改），
  拖标签最多只能到 40。⛔ 改任何「上限」必须同时搜 `DragHandler` / `SMOOTH_RADIUS_MAX` / `RADIUS_PX_MAX`。

### E. 参数盒容器
`.param-group` 已删除，改用全仓统一的 `.border-panel-section` + 修饰类 `.smooth-params`。
修饰类只做一件事：**首行 `margin-top:0` / 末行 `margin-bottom:0`** ——
因为 `.row-between` 自带 `margin: 10px auto`、`.border-panel-section` 自带 `padding: 10px`，
叠加后描边到第一个参数变 20px，归零后才恰好 10px（用户要求）。

### F. HUD 几何与坐标口径（⛔⛔ 2026-10-13 第三轮真机定案，勿再猜）

- ⛔ **系统光标跟随的是原始笔，不是输出点**：Wintab 系统上下文（CXO_SYSTEM）由**驱动侧**
  移动光标，detour 改写的只是交给 PS 的那份副本 ⇒ `GetCursorPos()` = 原始笔尖。
  真机反证：旧版把 HUD 窗钉在 GetCursorPos() 上（=钉在笔尖），洋红偏移 (raw−out)
  从笔尖出发成了**镜像点** ⇒ 用户看到「光标钉死在圆心、洋红点延伸到圆周又弹回」。
- ✅ 正确几何：窗口钉在 **cur − (raw−out)·px**（= 绘制点/输出点），圆心 = 绘制点
  （描边画在圆心），绳带/笔尖点画在 +(raw−out)·px —— 末端恰好压住系统光标。
- ⛔ **标定分母必须用原始轴**：s = Δ光标/Δ**raw**。用 Δ输出做分母会被低通/拉绳的
  跟随系数放大 1/k 倍（≈10 倍）⇒ pxPerAxis 虚胖 ⇒ 真实绳长只剩 drawn/10
  ⇒「圆很大、拉绳没感觉」。旧拉绳「绷紧才动」绷紧期 Δ输出≈Δraw 才侥幸没暴露。
- ⛔ **pxPerAxis 兜底标称 = screenW/axisMax**（≈0.077），绝不是 RANGE_NOMINAL/axisMax
  （32767/44800≈0.73，大 10 倍）；`g_pxPerAxis` 初值必须 0（=未标定走兜底），不能 1.0。
- 排障第一看 jwwh 日志 `[status]` 行的 `pxPerAxis=`（真机真值应 ≈0.077）。
- 若真机出现「圆心飘离选区边缘、绳带压不住光标」⇒ 「光标=输出」假设才成立，
  把窗口钉靠点对调回去（`SetWindowPos(... cur.x - rx - half ...)` 改回 cur）即可。

### G. 第四轮：逐轴标定 / 假复位 / DLL 落位 / **标定断链真 bug**（⛔⛔ 别再退回单标量）

- ⛔ **X/Y 两轴的比例不同**（真机 `[calib]` 日志：`lcInExtX=44800 lcInExtY=29600`，差 **1.58 倍**；
  屏幕 `SM_CXVIRTUALSCREEN`=3440 ⇒ 标称 X=3440/44800=**0.0768**、Y=1440/29600=**0.0486**）
  ⇒ 单标量 `g_pxPerAxis` **不成立**，必须 `g_pxAxisX / g_pxAxisY` 逐轴。
  ✅ 这条依据是**日志硬数据**，与截图无关。
- ⛔⛔ **符号不猜，只测**：`calib_axis()` 的 `s = Δ光标/Δraw` **天然带符号**，是符号的唯一权威来源。
  兜底 `px_x()/px_y()` 一律**中性（与 X 同号）**，**绝不硬编码「Y 取负」**。
  符号投票 `SIGN_VOTE 4` 防启动初期坏样本锁反。
  ⚠️ **已撤回的错误依据**：上一轮我写的「Y 必须取负」来源是一张 251×308 截图里
  「折线末端落后光标 27px vs HUD 偏移 34px、其比≈Y 逐轴比 1.389」——
  用户澄清**前两张截图只是现象示意、并非真实截图** ⇒ 该量化证据作废，**不得再引用**。
  ⛔ 教训：**示意图不能当测量数据**。几何量化只能来自(1)日志/接口实测，(2)用户确认为真实的截图。
- ⛔⛔ **真 bug：标定断链**（2026-10-13 发现）。`calib_axis()` 写 `g_axCalX.px / g_axCalY.px`，
  但 `px_x()/px_y()` 原先只读 `g_pxAxisX / g_pxAxisY`（**只在初始化写一次的标称值**）
  ⇒ **标定结果从未被 HUD 使用过**，HUD 一直用几何标称值。
  ⇒ 任何人改标定器都"看起来没效果"，这是排查"调参无感 / HUD 不准"时**必须第一个查的链路**。
  修复：`AXCAL` 加 `done` 标志，`px_x()/px_y()` **优先返回标定值**，`done=0` 才回落标称。
- ⛔ **`TIME_GAP_RESET_MS` 是假复位陷阱**：数位板**停笔时不再出包**（jwwh 日志实证 packets
  长时间冻结，而 PS 仍 ~660 次/秒空轮询 `WTPacketsGet`）⇒ 旧值 120ms 时「停一下再画」必超阈值
  ⇒ 输出点被拽回笔尖 ⇒ 「圆闪回光标 / 折线从冻结点直连笔尖」这一类现象。
  ⚠️ 该现象描述来自用户（配图仅示意）——**现象可信度中等，但"停笔无包"是日志硬事实**，
  逻辑上必然导致输出点回跳，故此修成立。现值 **5000ms** + `HUD_HOLD_MS=3000` 保活。
- ✅ **复位原因计数器**：`g_rstAnchor / g_rstGap / g_rstJump / g_lastGapMs`，
  `[status]` 行输出 `pxX= pxY= calX= calY= rst=a/g/j lastGap=`。
  **正常运笔时 rst 计数不应增长**（`g` 频繁 ⇒ 假复位；`j` 频繁 ⇒ 跳变阈值过紧）。
  `calX/calY=1` ⇒ 该轴 px 是**测出来**的（符号可信）；`=0` ⇒ 仍是中性兜底，**别把兜底值当结论**。
- ⛔ **hook DLL 绝不落安装目录**：PS 加载 DLL 会锁住其**所在目录** ⇒ 卸载删不掉
  （实证：13:32:35 起 `Remove-DirWithRetry` 12 次全失败，而进程已退）。现落
  `%TEMP%\JWautofill\hooks\`（`PenHook.HookStageDir`）；安装目录只留 exe + 日志。
- 卸载脚本铁律：删除重试 **8×500ms**（最长 4s）；失败处**不 throw**（throw 会跳过残留清理
  与钩子超时重置）；倒计时 **15s**（两边逐字一致）；`uninstall.bat` 用
  **`if errorlevel 9009 pause`**，绝不 `if errorlevel 1 pause`（否则失败永远停在「按任意键」）。
- 像素取证手法：对用户截图做**包围盒/距离测量**与** ASCII 结构图**（本地小工具，
  2026-10-17 已随清理删除，需要时按同功能重写：PIL 裁剪统计 + 阈值转字符画）。
  ⛔ **仅可用于用户确认为真实的截图**；示意图绝不可作测量源。

### H. 第六轮：拉绳公式 / 绳的形态 / modal 节流吞吐（⛔⛔ 三条都别再写错）

#### H1. 拉绳的跟随量必须就是「收回绳长的那一段」（⛔ 公式极易写反）
- ❌ 错误写法 `f = radiusPxF / distPx`：每包沿 dx 走 `distPx·f = radiusPxF`，
  新距离 = `distPx − radiusPxF`。光标刚越过圆周（`distPx ≈ radiusPxF`）时新距离 ≈ 0
  ⇒ **输出点被直接搬到光标上** ⇒ 用户看到「光标到圆周、圆心立刻跃迁到光标」，
  选区被画成**一段段直线**（每个越圈点都成为新锚点）。
- ✅ 正确写法 `f = 1.0 − radiusPxF / distPx`：移动量 = `distPx − radiusPxF`
  ⇒ **新距离恒等于 radiusPxF** ⇒ 光标与圆周**相对静止**，圆心沿光标方向连续前进。
  这是用户对「拉绳」的准确定义：**圆周和光标保持相对静止**。
- 两侧都连续：`distPx→radiusPxF⁺` 时移动量→0（不跳变）；此后 distPx 每 +Δ，输出点同步走 Δ
  （绳不可拉伸）。判据仍是 `distPx > radiusPxF` 才进入该分支（未绷紧 ⇒ 输出点一字节不动）。

#### H2. 绳的形态：统一细线 + 悬链曲线（⛔ 不要画锥形）
- ❌ 锥形折线（`wdt = 4→1px`、`NSEG=12`）：用户明确否掉 ——「一头粗一头细、始终是直线，
  没有一种绳子的感觉」。
- ✅ 统一 **2px** 细线 + **二次贝塞尔**。垂度用**小垂度悬链线**：
  `sag = sqrt(3·(L−d)·d / 8)`，L = 绳长(= 圆周半径，`leash_px()`)、d = 圆心到光标的距离。
  `d → L` 时 `sag → 0` ⇒ **自然拉直**，不需要写特判分支；`d → 0` 时同样 → 0。
- 控制点 = 中点 + `2·sag·n`（二次贝塞尔在 t=0.5 处的偏移正好是控制点偏移的一半）。
  `n` = 「圆心→光标」的垂直方向，**取 y ≥ 0 的那一侧**（一律朝屏幕下方弓，像绳的自重）；
  绳恰好水平时取右侧。
  ⛔ 不要按运动方向定弯曲侧 —— 停笔时方向未定义，绳会突然翻面。
- 语义：光标在圈内 ⇒ 绳弯；光标拉到圈上 ⇒ 绳直。**「由松到直」就是「描边末端被牵着
  前进」的反馈来源**，这是用户要的观感本体，不是装饰。

#### H3. modal 告警的根因是「请求率 > 节流吞吐」（⛔ 排查顺序）
- `psAccess.MIN_MODAL_GAP_MS = 300` 是**全局**模态节流 ⇒ **吞吐上限 3.3 次/秒**。
  它只约束「两次模态命令的最小间隔」，**不约束谁在发**。
- 空闲态常驻巡检与它的冲突（2026-10-13 实测数值）：
  工具 300ms(3.3/s) + 快速蒙版 300ms(3.3/s) + 文档身份 500ms(2/s) ≈ **8.7 次/秒**
  ⇒ **每秒净积压约 5 个** ⇒ 约 7 秒堆到 40。
  症状完全吻合：`Too many modal scope commands`（编号递增 = 计数器累积）、
  `Large number of pending promises: 40`、以及「生成选区后 PS 读条等**获取当前工具**」
  （那条读条就是 `readCurrentToolId()` 的请求排不上队）。
- ✅ 对策：把**总请求率压到节流吞吐之下**。现值：工具 **1000ms**、快速蒙版 **1000ms**、
  文档身份 **2000ms**（合计 2.5 次/秒 < 3.3）。代价：切工具后闸门最坏 **1s** 更新。
- ⛔ 排查手段（下一步不要靠猜）：`__jwPs.sources()` 打印按 label 聚合的**进过模态**的
  读取次数（只有 ok/fail 计入；直读与 skip 不计），降序 + 次/秒；
  `__jwPs.trace(true)` 后每 5s 自动打印。
  另：`__jwPs.dump()` 面包屑、`__jwPs.state()` 闸门状态。
  空闲态下的常驻来源清单见 `docs/modal-scope-audit.md`（已修项 + 待评估项）。
- ⚠️ 改任何巡检间隔**必须回头核对这条吞吐账**：单个间隔看着无害，加总超过 3.3/秒
  就会重新积累排队。

### I. 第七轮：热键配置被冲 / 卸载窗口 / HUD 诊断 / 平滑自愈 / 参数上限（2026-10-13 晚）

#### I1. ⛔⛔ 卸载脚本的「清扫一切」会毁掉用户配置与另一角色
- 症状：关掉 PS 重载后**热键全没了**，`hotkeys.json` 里只剩 `main_toggle` + `focus_lasso`
  （正是 `ensureMainToggleEntry`/`ensureFocusLassoEntry` 补出的默认值）。
- 链路（现场证据：`%LOCALAPPDATA%\JWautofill\` 下既无 `configpath.txt` 也无 `daemon\`；
  HKCU Run 里 JWautofillHotkeyDaemon 已被删）：
  `uninstall.ps1` 第 7 步原来是 `Get-ChildItem $jwRoot | Remove-Item -Recurse -Force`，
  它删掉了 **`configpath.txt`**（「用户的配置存在哪」的唯一指针）
  ⇒ 守护进程下次启动回落到默认路径、读到**空列表** ⇒ 面板按「首次使用」补默认条目
  并**回写落盘** ⇒ 用户的笔刷热键被整份冲掉。
  它同时会删掉**另一角色的安装目录**（`daemon\` 与 `smooth\` 互为兄弟），
  直接违背「两个服务互不影响」。
- ✅ 铁律：**卸载脚本只允许删除自己那份安装目录（第 3 步），第 7 步只能回收空目录，
  绝不 `Remove-Item -Recurse` 整个 `%LOCALAPPDATA%\JWautofill`；`configpath.txt` 永不删除。**

#### I2. ⛔ 面板「收到空配置就回写默认值」必须加护栏
- `canPersistConfig() = configLoaded && requestedConfigPath !== '' && daemonConfigPath === requestedConfigPath`
  （配置帧新增 `path` 字段 = 守护进程**实际读写**的文件）。
- ⛔ 只判「路径非空」**不够**：默认路径字符串同样非空，但它指向的文件往往不存在
  ⇒ 正是上面的空配置来源。**必须逐字相同**才允许落盘；不一致就重发 setConfigPath 并跳过本次写入。
- ⛔ 守护进程 `SaveConfig` 覆盖前复制一份 `<配置>.bak`：用户手工录的热键冲掉就无法重建。

#### I3. ⛔ 唤起 `.bat` 不可靠 ⇒ 卸载走 `.exe` 启动器
> ⛔⛔ **2026-10-14 已整体回退（用户决定）**：`.exe` 启动器方案（`native/UninstallLauncher/`，JWUninstall.exe）已删除，面板退回了 `.bat` 唤起（`BrushHotkeySection.uninstallDaemon` → `openBundled('native/HotkeyDaemon/uninstall.bat')`）—— 用户不愿为卸载窗口多付 dist 76M。以下为当时（2026-10-13）的决策记录，仅存史；`.bat` 收尾由 ps1 倒计时保证（成功 5s/失败 15s）。SmoothBridge.runSmoothUninstallScript 已随 M3 删除。
> ⛔⛔ **2026-10-17 M4 再进一步**：`uninstall.bat/ps1` 与整个 `native/HotkeyDaemon/` 已删除，面板「卸载快捷键服务」菜单项移除（.8li 无常驻可卸之物）——本节的 `.bat`/`.exe` 唤起链路**两端都已不存在**，纯存史。
- `shell.openPath` 实测：对 `.bat` 热键侧**什么都不出现**、平滑侧**窗口一闪而过**；
  对 `.exe` 才稳定（FixKeyboard.exe 已走通）。
- ✅ `native/UninstallLauncher/`（`JWUninstall.exe`，控制台程序）：在自带控制台里跑
  **同目录**的 `uninstall.ps1` 并等它结束；脚本缺失时自行倒计时 15s。
  webpack 复制到 `native/HotkeyDaemon/` 与 `native/SmoothDaemon/` **同层**
  （启动器按 `AppContext.BaseDirectory` 找 ps1）。`.bat` 保留供手动双击。
- 面板入口：`BrushHotkeySection.uninstallDaemon`、`SmoothBridge.runSmoothUninstallScript`。

#### I4. 状态条文案：生效中之后**不挂任何参数**（用户明确要求）
- `state===1` → 只返回 `套索平滑：生效中`。模式/强度/半径/工具 ID/已平滑包数/闸门提示全删。
- 另补 `state===3`（钩子已卸载但仍显示开启）→ `未生效（正在自动恢复…）`；
  旧版没有这一档，会一直落到「标定中…」⇒ 用户只能反复开关去撞。
- 工具 ID 原文改为「读数变化时打一条 console」（`[套索平滑闸门] 当前工具 = …`），
  排障仍可看控制台，但不再占状态行。

#### I5. ⛔ 平滑「时有时无」= DLL 被卸钩而守护进程以为还开着 ⇒ 必须自愈
- `cmd=2`（卸载）除「用户关开关」外还有两条通路：`RequestUnhook`（服务重启 /
  自更新重拉 / 面板 onclose）与重置路径。卸钩后**只有再来一条 `cmd=1` 才重挂**，
  于是「开关是开的、界面不报错、就是没有平滑」，用户只能反复开关去撞那条 cmd=1。
- ✅ `PenHook.HealIfUnhooked()`：`_enabled` 为真且 `I_STATE==3` ⇒ `SendCommand(1)`
  （冷却 2s）。调用点：`SyncInjection()`（PS 在跑时每 3s）与每次 `penSmooth` 处理之后。
  **state==4 不自愈**（需要重启 PS，反复发命令只会刷日志）。

#### I6. HUD 显隐的六个条件 + 诊断
`wantVisible = wnd && mem && activeNow && gateOk && ropeMode && (hf & 1)`
| 条件 | 含义 | 常见成因 |
| --- | --- | --- |
| `wnd` / `mem` | 建窗 / DIB 成功 | 建窗失败（日志 `[hud] …失败`） |
| `activeNow` | 有包流或在保活窗口内 | 钩子没挂（`g_patched=0` ⇒ t 一直涨） |
| `gateOk` | `toolOk && penDown` | 工具不是套索 / 笔悬空 / 落笔判据不可用 |
| `ropeMode` | `g_cfg[CFG_I_MODE]==1` | 不在「拉绳」模式（HUD 只在拉绳出现） |
| `hf & 1` | 面板「拉绳提示」开着 | 该开关是**持久值**，可能上次被关掉了 |
- ✅ DLL 渲染线程现在节流 2s 打印 `[hud] 未显示: wnd= mem= active=(t) gate=(toolOk penDown) rope= hudBits=`
  —— 真机复现「HUD 不显示」时先读这一行，别再猜。

#### I7. 参数上限（用户要求「拉到最大更有感」）
| 参数 | 旧 | 新 | 位置 |
| --- | --- | --- | --- |
| 强度 τ(100) | 100ms（`TAU_LN=2.602690`） | **250ms**（`TAU_LN=3.473500`，=ln 32.25） | `wintab_hook.c` |
| 追笔 vmax 上限 | 1.5 px/ms | **3.0 px/ms**（人手极限≈1.5 ⇒ 拉满≈1:1 跟手） | `wintab_hook.c` |
- ⛔ 改上限必须同时核对：`RADIUS_PX_MAX`（全局滞后夹钳）、面板 `SMOOTH_RADIUS_MAX`、
  `Program.cs` 的 `Clamp(p.RadiusPx,1,100)` —— 强度再大也会被半径夹住，帮助文案里已写明。

#### I8. 「拐角」帮助文案：是**转折角**，不是角度本身的夹角
- 判据 `dot < cos(cornerDeg)`（dot = 相邻两段方向的余弦）⇒ **转折越大越判为拐角**。
  原文「转折超过该角度时减弱平滑」**语义正确**；用户按「角的夹角」理解所以以为写反了。
- ✅ 文案已重写：明确「是转折角不是夹角」、给「方形直角 = 转折 90°」的例子，并写明
  **数值越小越容易触发保护**（`cornerDeg→0` 几乎每帧都算拐角 ⇒ 几乎不平滑；
  `90` 只有掉头才保护 ⇒ 平滑最完整）。⛔ 不要照直觉写成「数值越大越容易」。

### J. 第八轮（2026-10-14 深夜）：三问题联修 —— 闸门 fail-closed / 起笔闩锁 / hCtx 缓存 / 绳滞回

#### J1. ⛔⛔ 工具闸门改 **fail-closed**，1 是唯一放行值（推翻 C 节的「陈旧放行」）
- 日志实证（jwwh-3376）：`toolOk` 在 0/1 间反复翻转 ⇒ 心跳断 >3s ⇒ 旧版对陈旧值放行
  ⇒「任何工具落笔都出 HUD」（转换点/旋转工具截图）。
- 心跳断的根因：旧心跳**寄生在 batchPlay 工具巡检里**，巡检有三条提前 return
  （isPsBusy / 读挂起≤3s / 模态节流）⇒ 连续挡 3 秒 GATETS 就过期。
- ✅ 三层修：① 原生 `tool_gate_ok()`：ts==0（从未写过，钩子必未工作）放行；
  过期阻断；**新鲜 2（未知）也阻断**，只有新鲜 1 放行。
  ② 面板 `syncGateHeartbeat()`：独立 1.5s 定时器纯 WS `forceSendParams`，
  不碰 batchPlay/忙碌闸门 —— 面板 JS 活着心跳就在跳。
  ③ `applyToolGate(null)` 读失败沿用上次判定的语义保留（2 现在是阻断，不再有放行漏洞）。

#### J2. ⛔⛔ 起笔闩锁 `g_strokeGate`（一笔之内闸门抖动 = 坐标流劈两半）
- 一笔之中「这批判定放行、下一批阻断」交替 ⇒ PS 收到一半原始坐标一半平滑坐标
  ⇒ 选区末端忽而跟光标忽而钉圆心（用户报的「紊乱」形态之一）。
- ✅ 悬空时现判并闩住；笔画进行中沿用闩锁；笔起（接触消失）解闩；
  `CFG_I_ENABLED`（面板总开关）**保持实时**不受闩锁影响。

#### J3. ⛔⛔ per-hCtx 标定布局缓存（问题 3「平滑+HUD 同时紊乱」的直接根因）
- jwwh-3376 整场 [calib] 块反复出现 ⇒ **hCtx 频繁变更**；旧版每次变更都
  tried=0/valid=0 + wasEnabled=0 + 清接触判据 ⇒ ①重标定窗口漏原始包
  ②锚定复位（圆心瞬移、折线直连）③gateOk 残留 1（HUD 显旧几何）。
- ✅ `g_ctxCache[4]`（stride/offSerial/offX/offY/axisMax/axisMaxY）按句柄缓存；
  命中即零窗口切换（不重标定、不清轨迹、不清接触）。未命中走重标定，
  成功后**只有布局真变**（stride/offY 不同）才清轨迹与接触判据，并 `ctx_cache_put`。
- 诊断：[status] 行新增 `ctxN=<次数> last=0x<old>->0x<new>`；hCtx 用 LONG_PTR 存。
  ⛔ 若 ctxN 在一场会话里持续增长且 rst=a 同步涨，就是「切上下文引发复位」还在发生。

#### J4. 绳渲染滞回死区（问题 2「绷直⇄微弯跳变」）
- 物理成因：绷直边界 d≈L 抖 ±1~2px（手颤+包量化），sag=sqrt(3(L−d)d/8) 在 d→L⁻
  灵敏度 ≈2px sag / 1px d ⇒ 无死区必然高频交替。
- ✅ 渲染侧：`g_ropeTaut` 滞回 —— d ≥ L−2px 画直线；d < L−6px 才恢复悬链。
  ⛔ 只改渲染，平滑侧定长约束一字不动。

#### J5. HUD 颜色 → `#E07F0D`
- 用户要求与 PS 原生洋红区分。改 `Program.cs PenState.HudColor` 默认值
  （面板不下发该字段）；`CFG_I_HUDCOLOR` 注释同步。三元素（绳/圆/受力点）同源一色。

### K. 第九轮（2026-10-14 凌晨二轮）：漂移 / 绳闪弯 / 中断可视化

#### K1. ⛔⛔ 「问题 3 仍复现」的真凶：**模式被静默改掉**（daemon.log 硬证据）
- `$LOCALAPPDATA/JWautofill/smooth/daemon.log` 里夹着 `模式 2`×4 帧 + `模式 0`×6 帧
  （其余全为模式 1）——模式变成追笔/标准后 HUD 消失、手感突变，而面板一直挂「生效中」。
  疑似写入源：**「复位设置」会把 smoothParams 打回默认 standard 并 pushLassoSmoothParams**。
- jwwh-24528 整场 `ctxN=0` ⇒ 本轮复现与 hCtx 无关（J3 修复未背锅）。
- ✅ notify bar 拆出两档异常（不能永远「生效中」，用户明确要求）：
  ① `平滑中断`（红）：penDown=1 + gateOk=1 + packets 在涨(1.5s 内) + snAge>2.2s；
  ② `非拉绳模式`（橙）：mode≠1，提示平滑仍在、HUD 已停显。
- ⛔ 中断判据**刻意不用 smoothed 冻结**：松弛绳下输出==原样、零改写是正常态（误报）。
  用新槽位 `CFG_I_SNTS=34`（sn_publish 回写，C#/C 两侧同步追加）：packets 在涨而
  快照冻结 ⇒ 真断流（标定丢失等）。旧版 daemon 无此字段 ⇒ snAge=-1 ⇒ 不触发。

#### K2. ⛔⛔ 受力点漂移（几像素）+ 绳闪弯的共同根因：标定比例波动 ±10%
- [status] 实测 pxX 0.058~0.069 反复横跳。根因 = calib_axis 小位移样本的
  **光标量化噪声**（旧 CUR_SAMPLE_MIN=3px，±1px 量化 = ±33% 样本噪声）。
  比例 ±10% ⇒ 偏移差 ±10% 绳长（用户半径 100px ⇒ 10px 漂移）；绷直边界
  vlen=L 被比例噪声穿越 ⇒ 绳闪弯。
- ✅ calib_axis 三道闸：Δ光标≥10px；EMA 权重按 Δ光标 加权（0.05~0.30）；
  离群（相对已收敛值 >20%）丢弃，连续 24 个离群才整值作废重标（防配置真变被冻死）。
- ✅ 光标外推：快照加 prev 帧（`sn_publish` 统一三处写点），HUD 按前两包速度把 raw
  外推到当前帧时刻（限幅 40ms）——「偏移 ↔ GetCursorPos」两端同刻，消除 v·Δt 相位差。
- ✅ 绳滞回二版：解除绷直改**相对阈值**（<85% 绳长）+ 90ms 时间滞回
  （单帧拐角回摆不再点亮悬链）。只改渲染，平滑语义不动。

---

### L. 第十轮（2026-10-14 上午）：状态条去模式分叉 / 切模式中断真凶 / 诊断条 / 两参数重映射

用户一次提 5 条，全部落地。

#### L1. ⛔⛔ 「切换模式后平滑中断」= 一个浮点字段让**整帧** `penSmooth` 被丢
- 硬证据：`%LOCALAPPDATA%\JWautofill\smooth\daemon.log` 137 条
  `处理消息失败: The JSON value could not be converted to System.Nullable\`1[System.Int32].`
  （115 条 `$.catchUp` + 22 条 `$.radius`）。逐字节复算 `BytePositionInLine`，正好落在
  小数点后的那一位（如 `95.5` 的 `.5`）。
- 机理（**必须记住**）：`Program.cs` 的 HandlerClient 里
  `JsonSerializer.Deserialize<PenHook.PenWire>(...)` 抛异常 ⇒ 被**同一层**的
  `catch (Exception ex) { 处理消息失败 }` 吞掉 ⇒ 之后那句 `PenHook.Set(on, p)`、
  `HealIfUnhooked()`、`BroadcastSmoothState()` **一次都没执行**。
  即：**一个字段类型不符 = 整条消息（on/mode/toolGate/heal/broadcast）全部消失**。
  用户按「切换模式」，那一帧里恰好带着上一次拖动留下的 `radius` 小数 ⇒ 模式切换
  彻底没送达 ⇒ 感知为「一切模式，平滑就断」。
- ✅ 两层防御（缺一不可，新增 IPC 数字字段照此办理）：
  ① **面板唯一咽喉**：`LassoSmoothing.toWire()` 对 `strength/radius` 一律 `Math.round`，
     `catchUp/cornerAngle` 经映射函数（内部已 round）；
  ② **daemon 抗性**：`PenWire` 的数字字段声明为 `double?`（不是 `int?`），
     赋值时 `(int)Math.Round(...)` ⇒ 最坏只降级成「该字段被取整」，不再整帧失败。
- ✅ 附带闭环：`setPenSmooth(on, p)` 带参时同步模块 `params = {...p}`。
  否则 1.5s 一次的**闸门心跳**（`forceSendParams` 用模块值整包覆盖）会把刚改的模式/参数
  无声冲回（K1 里那条「模式被写入源不明」的另一半）。

#### L2. ✅ 状态条不再按模式分叉（用户要求「选中啥模式就是啥模式」）
- `smoothStatusText()` / `smoothBarTone()` 里 `pen.mode !== 1` 的两条分支**删除**
  （旧文案「非拉绳模式（拉绳提示已停显，平滑仍在）」与橙色档一并作废，**取代 K1 的 ②**）。
- state===1 只剩**两档**：`生效中`(notify-bar-ok 绿) / `平滑中断`(notify-bar-fail 红)。
  中断判据不变：`penDown===1 && gateOk===1 && (now-lastPenFlowAt)<1500 && snAge>2200`。

#### L3. ✅ 新增「平滑运行诊断条」（调试用）
- 位置：`.border-panel-section.smooth-params`（用户口中的「笔刷参数」盒 —— 全仓**没有**
  任何叫「笔刷参数」的分区，唯一 `.border-panel-section` 在平滑上下文里就是它）
  **下方**，属 `collapse-content-expanded` 的直接子节点。
- 方法：`smoothDiagText()` / `smoothDiagTone()`（与状态条同样的「文案/配色分开」惯例）。
  逐项回答「此刻**为什么**没在改写坐标」，顺序与原生判据一致：
  未连 → 版本过旧 → 开关关 → state 4/2/3 → 未注入 → state 0（等包/标定中）
  → `toolOk!==1`（工具不是套索）→ `penDown!==1`（等落笔）→ 断流 / 正在改写
  （尾附 `packets/smoothed/radiusPx/snAge`）。
- 配色：绿=真的在改写 · 橙=就绪但闸门未成立 · 灰=开关未开 · 红=标定失败/断流。
- **零新 CSS**：复用 `.notify-bar` + `.indicator` + `.notify-text`（`margin-bottom:8px`，
  与盒子的 `margin-bottom:10px` 叠加）。

#### L4. ⛔ 追笔 / 拐角 显示值重映射（方向必须与用户直觉一致）
- **追笔**：面板显示「追笔力度」**1–100，数值越大越黏**。
  `catchUpToNative(d) = round(50 − (d−1)·49/99)`：
  d=1 → 原生 50（vmax 1.52 px/ms，跟手）｜d=100 → 原生 1（vmax 0.05 px/ms，最黏）。
  原生公式 `vmax = 0.02 + (catchUp/100)·3.0` **不动**，clamp 仍 0–100。
- **拐角**：面板显示「保护范围」**0–90，数值越大保护越广**。
  `cornerToNative(d) = 90 − d`。
  依据（**从源码复核，别再凭记忆**）：`dot = 前/当前单位方向内积`，
  `dot < cos(cornerDeg)` ⟺ `转折角 > cornerDeg` ⇒ **原生 cornerDeg 越小越容易触发保护**。
  d=0 → 原生 90（只有掉头才保护）｜d=90 → 原生 0（几乎每帧都保护）。原生判据不动。
- 量程同步点（**改一处必查另几处**）：`SMOOTH_CATCHUP_MIN/MAX`(1/100) 新导出 ·
  `app.tsx` 追笔 RangeSlider + number input（`min` 由 0 改 1）·
  `DragHandler.configs['smooth:catchUp'] = {min:1,max:100,step:1}` ·
  `helpTexts.smoothCatchUp/Slider/Input` 与 `smoothCorner/Slider/Input` 全部重写 ·
  新增 `helpTexts.selectionFill.smoothDiagLabel`。
- ⚠️ **存量持久化值不做迁移**（`appPanel.smoothParams` 里 `catchUp:100 / cornerAngle:22`
  会按新刻度重解释：100→原生 1 最黏、22→原生 68 保护变窄）。已向用户说明并留选项。

#### L5. 构建链（本轮全过）
- `npx tsc --noEmit`：改动文件零新增错误（`src/lasso/LassoSmoothing.ts`、
  `src/constants/helpTexts.ts`、`src/utils/DragHandler.ts` 均 0；`app.tsx` 仅既有基线）。
- 三护栏全过（本轮**未改任何 CSS**，`dist/common.css` mtime 仍 09:59）。
- `dotnet publish` 两角色（SmoothDaemon / HotkeyDaemon）→ `yarn build`（dist 拾取新 exe）。
- ⚠️ 生效条件：daemon 加固要**平滑开关先关再开**；本轮**未改 DLL 源逻辑**（只改注释），
  故不需要重启 PS。


---

## P3.5（2026-10-14 第三轮）：拉绳圆心分离 · 拐角回退 · 诊断重做 · 选区延迟

用户一次报 4 条（附 5 张真机截图）。**5 张图的几何都可量化**（纯 stdlib Kåsa 圆拟合）：
三张图的圆半径都精确 = **99.4px**（= 半径参数 100px），橙色非圆分量团距圆心
**37.7 / 39.0 / 39.5px** —— 高度一致 ⇒ 不是「示意」，是可量化的一致偏移。

### M1. ⛔⛔ 拉绳「受力点（选区末端）与圆心分离」= 标定值剧烈抖动（真 bug）
- 证据：`%TEMP%\jwwh-<pid>.log` 的 `[status]` 里 `pxX/pxY` 组合有 **19 种**
  （`0.0571/−0.0473` 出现 238 次、`0.0536/−0.0518` 51 次、`0.0556/−0.0638` 41 次、
  `0.0623/−0.0739` 26 次、`0.0689/−0.0457` …）。同一台机器同一显示器，**真值只能是常数**。
- 机理：HUD 圆心偏移 = 滞后 × px ⇒ **px 偏 25% 圆心就离选区末端 25% 绳长**
  （100px 绳 ≈ 25px，肉眼一眼可见）。
- 病根**不是**单样本噪声，而是**估计器的形状**：旧版把「比值的 EMA」当估计量，
  等效窗口只有 3~20 个样本 ⇒ 比值本身的逐样本方差不被平均掉。
  （旧版三道闸 CUR_SAMPLE_MIN=10px / EMA 权重 0.05~0.30 / 离群 ±20% 丢弃
   治的是单样本噪声，对「估计量选错」无效。）
- 修法 ⇒ **位移加和**估计器：`px = s · Σ|Δ光标| / Σ|Δ原始轴|`（指数衰减窗口 `PX_WIN=256`）。
  · 噪声按 √N 收敛（256 样本 ⇒ ±1%）；
  · **天然按位移加权**：慢速/抖动样本位移小、贡献小；
  · 即便驱动把系统光标跟着**输出**走（旧分母争议），绳被拉住的样本 Δ输出≈0
    ⇒ 对分子贡献≈0，估计值仍收敛到真实映射（旧实现会被拽向 0）；
  · 不再需要「离群丢弃 + 整值作废」（那本身就是抖动源）。
- 采信门槛 `PX_TRUST_N=24`：**样本数不够时 done=0，一律回落到标称兜底**
  （量级合理、**符号中性**）。符号仍由 `Δ光标/Δ原始轴` 投票 `SIGN_VOTE=4` 定，
  首次/符号翻转时清空累积器重来（EMA 穿越 0 会让 HUD 镜像一段时间）。
- `AX_SAMPLE_MIN=120`（≈7 屏幕像素）、`CUR_SAMPLE_MIN=5`（**别抬到 10**：门限越高样本越稀疏）。

### M2. ⛔⛔ 拐角「保护范围」映射**回退**（用户：「现在反而更加让人迷惑了」）
- 回退 = `cornerToNative()` 由 `90 − display` 改回**恒等**（保留函数只为显式表达 clamp+取整）。
- 回退理由（结构性，不是口味）：面板其它参数（强度 / 半径 / 追笔力度）**全是「越大越强」**，
  唯独拐角被反转成「越大 = 保护越广 = 平滑越少」，方向与全体相反；
  参数之间比较极易误判，排障还要多做一次心算。
- 现状：**显示值 = 原生转折角阈值**，一一对应；`0 = 几乎每帧都保护`，
  `90 = 只有掉头（转折 > 90°）才保护`。原生判据本身不动。
- 文案 / 注释同步回退：`helpTexts.smoothCorner/Slider/Input`、
  `app.tsx` 拐角行注释、`DragHandler` 注释（量程数值本来就一致，未变）。
- ⚠️ **追笔的重映射保留**（用户未要求回退，且它方向与全体一致「越大越黏」）。

### M3. ⛔⛔ 诊断重做：原因码必须由**原生侧报**，面板禁止自己拼
- 用户三症状：① 落笔很久仍显示「等笔尖落纸」；② 提笔瞬闪绿条 <1s 来不及截图；
  ③ 绿条只报「取包/改写」等无意义数字。
- 根因①：`smooth_packets` 在**任一**闸门不成立时都写 `g_penDown = 0`
  （工具闸门分支 + 悬空分支）⇒「闸门心跳过期」与「笔尖真的悬空」在面板上**长得一模一样**。
- 修法：DLL 在**裁决的同一处**写下原因码，面板只做展示。
  C 侧 `CFG_I_REASON` + `RS_*` 枚举，C# `Snapshot().reason`，TS `SmoothReason` +
  `smoothReasonText()`（**三处逐项对应，改一处必须同步另两处**）。
  ```
  0 正在改写 · 1 总开关未开 · 2 非套索 · 3 工具未知 · 4 心跳过期
  5 悬空 · 6 **判据尚未建立** · 7 未标定 · 8 无上下文
  ```
  ⛔ 第 6 档在第五轮**改了语义**：旧义「判据退化（仍在改写）」已废，改为
  「落笔判据尚未建立」—— 冷启动宽限内仍按落笔放行，宽限后**按未落笔阻断**（见 N2）。
  这一档必须与 `5 悬空` 分开说：两者过去都显示成「等笔尖落纸」，用户落着笔看那句只能更迷惑。
- 面板诊断条改为**只按 `reason` 说话**；`smoothDiagTone()` 与文案**同源同判据**：
  `reason∈{0,6}` = 绿，其余未满足 = 橙。`reason` 是**上次裁决的结论**，
  空闲时会停在最后一个值 ⇒ 必须结合 `snAge` / `state` 判断新鲜度（断流判定优先）。
- 根因③ ⇒ 尾巴只留**能直接定位故障的量**（旧版「取包/改写」与故障无关，用户说「莫名其妙」很准）：
  · `判据 +off=val`（`ctOff/ctVal`）——**「笔压恒读到 0」与「闸门被阻断」的唯一区分依据**；
  · `标定 Nx/Ny`（`pxNx/pxNy`）——< 24 时仍用标称兜底、方向不可信（M1 的第一判据）；
  · `闸门 Δ开/Δ关`（`gateOpen/gateClose` 的**每次回报增量**）。
- 根因② ⇒ **粘滞原因**：`app.tsx` 的 `lastPenReason/lastPenReasonAt`
  （窗口 `SMOOTH_REASON_STICKY_MS=8000`）。当前已恢复正常但上一次异常在窗口内，
  就写成「正在改写坐标（前一瞬：<原因>，N 秒前）」⇒ 一次截图就能看到刚才为什么没改写。
  ⛔ 只在**出现新的非正常原因**时记录时刻（每次回报都刷新会让异常永远粘住）。
- ⛔⛔ `gateOpen/gateClose` 是**累计值** ⇒ 判抖动**必须用两次回报的增量**，
  不能看两个总数的差额（画一百笔后两者都接近 100、差额恒为 0）。
  `app.tsx` 用 `lastGateOpen/lastGateDeltaOpen` 算增量。

### M4. ⛔⛔ 巨大选区生成延迟 = 落笔判据逐包归零 + 反复重新锚定
- 机理：`contact_update` 原本逐包 `v==0` 即置 `contact=0` ⇒ 本批走「未落笔」分支
  （坐标原样放过，PS 立刻跟手，观感=选区突然前进）+ 置 `g_wasEnabled=0`
  ⇒ 下一批**重新锚定**（输出点被拽到笔尖）+ 拉绳 100px 死区被重新灌满 ⇒ 选区又停住。
  一笔中反复 ⇒ 「画很久不出选区、然后突然出现一大段」。
- 修法：`CONTACT_HOLD_MS` **滞回**（最近一次非零时刻 `g_contactMs`；
  只有**持续**为 0 才算抬笔）。抬笔是物理动作、不可能只中断几十毫秒。
  ⛔ 只影响「何时算抬笔」，**不改判据字段/证伪规则**。
  ⚠️ 第五轮把窗口 **120 → 250ms**，并把单字段判据换成多信号并联 —— **见 N2（权威）**。

### M5. 槽位表 40 → **48**（新增 7 个诊断槽，只能往后追加）
```
35 CFG_I_REASON    36 CFG_I_GATEOPEN  37 CFG_I_GATECLOSE
38 CFG_I_CTOFF     39 CFG_I_CTVAL     40 CFG_I_PXNX  41 CFG_I_PXNY
```
- `publish_status()` **一次性回写**全部新槽（散落写会让同一帧里 reason 与计数自相矛盾）。
- `ctVal` 只写**全局** `g_ctVal`，由 worker 统一回写共享内存
  （detour 与 worker 各写一次同一槽会互相覆盖 ⇒ 诊断数字必须单一写入者）。
- `gate_set(int on)` 成了闸门状态迁移的**唯一入口**（只有真跳变才计数）；
  例外：`do_unhook` 用裸 `InterlockedExchange` 清 `g_gateOk`（撤钩不是一次「收笔」）。
- C# `NLONGS=48`、`I_REASON=35…I_PXNY=41`、`Snapshot()` 暴露 7 个字段
  （`reason/gateOpen/gateClose/ctOff/ctVal/pxNx/pxNy`）；运行时兜底校验改为 `I_PXNY >= NLONGS`。
- ⛔⛔ **扩容的升级陷阱（改 NLONGS 必读）**：命名映射是 Windows **节对象**，
  只要还有进程持有句柄就继续存在，**尺寸以最先创建者为准**。PS 里已加载的旧 DLL 持有它 ⇒
  新 daemon `CreateOrOpen` 拿到的仍是旧 160 字节节，`CreateViewAccessor(0, 192)` 越界抛异常。
  **不会出错行为**：旧/新 DLL 的 `MapViewOfFile` 都按 `CFG_NLONGS*4` 请求尺寸，
  尺寸不够即失败 ⇒ `g_cfg=NULL` ⇒ 全程一个字节都不改（fail-closed，PS 拿到原始坐标）。
  重启 PS 释放旧节后，下一次 `Set/心跳` 的 `EnsureInit` 会建出正确尺寸并自动恢复。
  ⇒ daemon 的 catch 里已写清处置指引（「重启 Photoshop 后再开关一次」）。
- 日志新增一行 `# [why] reason=<n>(<名>) gate/open=… close=… penDown=… toolOk=…
  ctUnknown=… ctOff=… ctVal=… pxN=…/…`（= 面板诊断条的日志版）。

---

## 第五轮（2026-10-14 12:00~12:50）—— 四条反馈的根因与定案

### N1. ⛔⛔ 轴→像素比 `px` 的**唯一权威来源 = 驱动 `lcOutExt / lcInExt`**（别再靠光标测）
- 数学恒等式：**光标 = 绘制点 + 偏移**，即 `px = (Δ光标)/(Δraw)`；而 raw 侧被「帧外推」放大
  ⇒ 光标测出来的 px **偏低且漂**。真机对照：
  `[status] pxX=0.0466~0.0676`（漂） vs `[calib]` 屏幕整屏映射标称 `3440/44800 = 0.076786`
  ⇒ **最差偏低 40%**。圆心偏移 = 滞后 × px ⇒ px 偏低多少圆心就离真实绘制点差多少
  （实测深色折线端点与圆心恒差 **15px**，100px 绳）。
  ⚠️ `lcOutExt/lcInExt` 的实际读数**要等新 DLL 的 `[calib] lcOut*:` 日志**（本轮尚未见）；
  上面那个 0.076786 是**屏幕标称**（= 驱动整屏映射时的值），不是驱动声明的实测值。
- 修法：`LOGCONTEXT` 读 `lcOutOrgX/Y(±108/112)`、`lcOutExtX/Y(±120/124)`（`lcInExt*±?` 同处），
  `drv = outExt / inExt` **含符号**（Y 通常为负），合理性判据 `|drv| ∈ (0.15·标称, 1.02·标称]`
  ⇒ `g_pxAxisX/Y = drv`、`g_pxSrc = 1`；不满足退回屏幕标称（`g_pxSrc = 0`）。
- `px_x()/px_y()` 取值优先级：**`g_pxSrc==1` 的驱动值 → 光标标定值（`done`） → 屏幕标称**。
  光标标定**降级为日志对照**，不再参与几何。
- ⛔ 别退回「光标测量当权威」：它把两个误差（外推放大 + 光标量化）叠在一起，永不稳定。

### N2. ⛔⛔ 落笔判据 = **多信号并联**（单字段版已废）
- 旧版只认**一个**候选（真机 = `ctOff=32` = `pkNormalPressure`）。套索是**轻触**运笔，
  NP 会**成段**读到 0（不是单包抖动）⇒ 闸门反复闭合 ⇒ 每次闭合 `g_wasEnabled=0`
  （重新锚定、输出点被拽到笔尖）+ 同一判据驱动 HUD 显隐 ⇒ **平滑与 HUD 同时失灵**。
  现场证据：诊断条 `判据 +32=0`；日志 `reason=5(悬空) gate/open=48 close=47 penDown=0 toolOk=1`。
- 现判据：**buttons / pkNormalPressure / pkTangentPressure 任一非零 = 落笔**；
  三者全零且持续 **`CONTACT_HOLD_MS = 250ms`** 才算抬笔。
- ⛔⛔ **每个信号必须「同时见过 0 与非 0」才有投票权**（`g_ctZeroSeen/g_ctNzSeen → g_ctElig`）。
  这一条同时解决两件事：① 恒 0 字段（部分驱动的 pkButtons）与恒非 0 字段
  （`pkCursor` 恒 1 / `Orientation` / `pkZ` 悬空 160）**自动出局**，再不需要「猜哪个字段才是压力」
  的盲扫；② 「悬空时字段也非零 ⇒ 全程都在平滑」的老缺陷结构性消失。
- 信号表来源（`contact_signals_build`）：
  · **src=1（掩码+数据双证据）**：直接取 `offBtn`（掩码里的 `pkButtons`）/`offNP`/`offTP`。
    buttons **只取低三位**（`& 0x07`）—— 高位是 cursor number，某些驱动填成非 0 常量。
  · **src≠1（盲扫定解）**：`offBtn = offX − 4`（固定字段顺序里 Buttons 恒紧邻 X 之前）+
    沿用旧的 `(offY, stride)` 反推枚举。取错由「双状态资格审查」兜住。
- 判据未建立时：**冷启动宽限 600 包（≈3s）按旧行为放行**，之后**按未落笔阻断**
  （宁可功能看起来没生效，也不要「悬空也在平滑」）。原因码 `RS_CT_UNKNOWN`。
- 表的重建走**布局指纹** `ct_sig_needs_rebuild(stride, offX, offY, btn, np, tp)`：
  `try_calibrate`（新标定）与 `ctx` 缓存命中**两条路共用同一判据**，避免一条重建另一条不重建。
  指纹含 btn/np/tp ⇒ 换设备必重建、同设备换句柄必不重建（重建会清零已攒的证据）。

### N3. ⛔⛔ `[ct]` 诊断日志行（下一轮排障的**第一现场**）
```
# [ct] 信号=+16* +32* +36  生效=7 本批命中=2 连续全零=37 包
```
- `+off` 后的 `*` = 该信号**已取得投票权**（同时见过 0 与非 0）。一个 `*` 都没有 ⇒ 判据压根没建立。
- `生效` = 有投票权的信号位掩码（十进制）；`本批命中` = 本批非零的信号位掩码（0 = 本批全零）。
- **`连续全零` 包数 × ≈5ms = 闸门被压住多久**：运笔中 >20 包即判据在真实绘制中**成段失效**；
  只有停笔/换工具时它才该变大。**这一个数就能给本轮问题定性。**
- 面板诊断条尾巴同步改为 `判据 +16* +32* +36 生效2/3 命中1 值0`
  （`smoothCtText()`；`ctOffs` 每 8 位一个偏移、`0xFF`=无信号；只展示前 4 个）。
- `reason=6` 的配色改看 `penDown`（它既可能是「宽限内仍在改写」也可能是「宽限后已阻断」）。

### N4. ⛔⛔ HUD 外推必须**两端对称**：raw 与 out 都要外推
- 几何恒等式：`光标(此刻) − offset(此刻) = 绘制点(此刻)`。旧版只把 raw 外推到当前帧，
  out 仍停在**包时刻** ⇒ 圆心落在「out 的包时刻位置」，实测与真实绘制点恒差 **15px**（100px 绳）。
- 修法：`sn_publish` 增加 `g_snPrevOutX/g_snPrevOutY`（与 prev raw 同构），HUD 用**同一 `age`、同一 `pktDt`**
  把 `axX/axY`（raw）与 `aoX/aoY`（out）一起外推，`rx/ry` 用外推后的**两端**相减。
  一致快照的值全等校验从 8 个字段扩到 **10 个**（少检查一个字段就可能拿到撕裂组合）。

### N5. ⛔⛔ 槽位 42~44（`NLONGS` 仍 48，42~47 本就空闲）
```
42 CFG_I_CTMASK  本批命中的信号位掩码（0 = 全零）
43 CFG_I_CTELIG  有投票权的信号位掩码（只覆盖前 4 个信号）
44 CFG_I_CTOFFS  前 4 个信号的偏移打包（第 i 个占第 i×8 位；0xFF = 该位无信号）
```
- C#：`I_CTMASK=42, I_CTELIG=43, I_CTOFFS=44`；`Snapshot()` 暴露 `ctElig / ctHit / ctOffs`。
- TS：`PenSmoothStatus.ctElig / ctHit / ctOffs`（逐个 `=== undefined ? 旧值 : …` 回落）。
- ⛔ `CFG_I_CTOFF` 语义也变了：现在是「**首选**信号偏移」（`g_ctOff[0]`；无信号 = -1），
  不再是「唯一采用的候选」。

### N6. ⛔ `theme.ts` 的 CSS 注释**一律写在块外**
- 症状：UXP 后台反复 `Error while parsing 'inline' CSS style sheet … Unknown word / Missed semicolon`，
  `source` 字段是注释原文。
- 根因：该文件用 `style.textContent = \`…\`` 运行时注入，UXP devtools 的 `parseCSSDeclaration`
  会把 **`{ }` 内的注释**当成一条声明去解析 ⇒ 每个注释一条 `CssSyntaxError`。
- 修法：注释全部上提到顶层 / 每个 `@media` 之前，**文字保留、变量声明逐字不动**。
- ⚠️ `scripts/_css_comment_guard.cjs` **只扫 `src/styles/*.css`，不扫 `theme.ts`** ⇒ 这类错不会被拦。
  改 `theme.ts` 必须人工确认「注释都在块外」，或手动跑一段括号/注释深度检查。

---

## O. 断流 / HUD / 独立笔通路（0x0109–0x010F 定案，2026-10-16）

> MEMORY.md 只留一句话摘要，全部细节在此。

### O1. 断流（0x0102 起长期现象，非某版引入）

- 形态 = `calls` 仍涨（PS 在轮询）而 `packets` 冻结数分钟、笔迹照画、平滑死。
- ⛔⛔ **杠杆已全部证伪**：`WTEnable` 翻转（12/12 返 1 却一包未回）/ `WTOverlap(hCtx,TRUE)`
  （#1…#120 全返 1 一包未回）/ 前台期每 500ms「保持顶层」（199 次拦不住）/ 开关卸载重挂
  （只换钩子、不动 PS 的 hCtx）—— **全无效**。⇒ 0x010B 起 `dead_heal()` **整个删除**，
  本版对 Wintab **只读不写**。⛔ 旧日志 `[dead] 恢复：…⇒ WTOverlap 生效` 是**假归因**
  （恢复只是驱动随机回摆）⇒ 恢复行改打**冲包量**。
- ✅ **冲包量 ≈ 驱动队列容量**：真机 **+125（6080→6205）/ +117（10816→10933）包
  ≈ `WTQueueSizeGet` 的 128** ⇒ 停摆期驱动是「**攒着**」不是「丢」；PS 一帧拿到上百点
  ⇒ **一帧画完整根弧线**。⛔ 断流恢复**必须强制锚定**：`g_deadRecovered` ⇒ `RST_ANCHOR`
  （**覆盖** 5s/跳跃判定，否则那批 ~128 包被当「连续移动」把输出点硬拽回来）。
- ⛔ **探针判决（决定性）**：插件**自建**新上下文 + 推顶 + `8×40ms` 连读 ⇒ **共读 0 包**
  （`[relay]`，0x010C/0x010E 两度复现）⇒ Wintab 通路整体无数据 ⇒「中继」方案不成立。
  ⛔ 别误读 `open=N close=N` 逐次 +1 —— 那是**我们自己的探针**（hCtx=0x803 的 WTOpenA/WTClose）。
- ⛔ **当前唯一自洽解释**：Wacom 驱动 WinTab 采样停摆，PS 降级到 Windows Ink/指针取坐标
  （笔迹照画、`calls` 照涨、任意 Wintab 上下文皆无包）；「一会儿自己好」= 切回 WinTab 的
  随机延迟，且**断级式恶化** 0.3s→5s→67s→160s+ 永久。
- ⛔⛔ **`[dead]` 曾严重漏报（0x010D 修）**：`s_movedTot += |cur − s_cur0|`，`s_cur0` 是
  **冻结起点**坐标 ⇒ 逐拍累加把同一段位移**反复计入** ⇒ 只要偏离过 2px 就永不清零
  （真机：用户报 5 次冲包，日志只打出 **1 条 `[dead]`**）。改为 **`s_lastCur` 逐拍增量求和**，
  且只有**连续 3 拍**位移都 <2px（真停笔）才清零。`[frz]` 的 `基线=` 相应改 `上拍=`。
- ⛔⛔ **`[dead]` 还会被落笔判据遮蔽 ⇒ 0x010E 加无前置条件的 `[stall]`**：`[dead]` 前置是
  「最近 `PEN_RECENT_MS` 内落笔过 + 光标累计移动过门限」；真机 `jwwh-22288` 里
  `[ct] 连续全零=3049 包` ⇒ 闸门判「悬空」⇒ **13:45:56~13:46:47 整整 50s 停摆被完全遮蔽**
  （期间 `smoothed` 冻在 4969 不动而 `packets` 从 7706 涨到 10950）。⇒ `[stall]`
  （`STALL_LOG_MS=400`）**只按「多久没新包」记**，连带打 `penDown/toolOk/contact/ctZeroRun/
  ctUnknown/光标/calls`。⛔ **`[stall]` 与 `[dead]` 的差集 = 被遮蔽的停摆**，这是判读核心。
- ⛔ **看门狗用 `g_pkReal`（只含真实包）**，不是 `g_packets` —— 合成补流会把后者一直抬高
  ⇒ 等于把断流**藏起来**。
- ⛔ `[pk]` 冲包计量有盲区：`最大单次` 只量「**一次调用**取回多少包」，而 PS 等输入时会
  **忙轮询**（真机 `PS取包次=1681/2s` = 821 次/s，此时每调用 ≈0.2 包）⇒ 驱动哪怕攒了几百包
  也会被几十次调用快速抽干 ⇒ `最大单次` 恒 ≤5。判断冲包要看 `[dead] 恢复` 的冲包量或
  `[stall]` 时长分布。
- ⛔⛔ **「画弧线但选区轮廓不出现、按住几秒后整根弧一次性出现」= 断流 + 恢复冲包**（0x010B 更正）：
  断流期驱动不派包 ⇒ PS 拿到 0 点、什么都没画；恢复瞬间一次涌进 ~125 包 ⇒ PS 在**一帧**里
  拿到上百点 ⇒ 整根弧一次性出现。⚠️ 曾误判为「拉绳固有行为」—— 代码核实
  `distPx = |原始笔 − 输出点|`、`f = 1 − rope/distPx` ⇒ 拉绳是**恒定滞后 rope 的连续跟随，
  会连续出线**。⇒ 与断流**同一个病**。

### O2. HUD 三条血案 + 定案（0x0106–0x010E）

- ⛔⛔ **绝不可去掉 `WS_EX_TRANSPARENT`**（第十四轮，血案）：分层窗口命中测试**按像素 alpha** 走
  （alpha=0 穿透、**画了东西的像素会吃掉鼠标消息**），而 HUD 拉绳曲线**终点恒画在光标上**
  （绘制段 `(half+vx, half+vy)`）⇒ 光标下永远压着不透明像素 ⇒ **HUD 恒抢走笔按下事件**，
  PS 收不到拖拽。真机形态：**HUD 可见时什么都画不出来；断流期（HUD 被 `SW_HIDE`）反而能画出
  未平滑的选区**。⛔ `WM_NCHITTEST→HTTRANSPARENT` **救不了**：MSDN 明写它只在**同一线程内**
  向下传递，而 HUD 跑在 `hud_thread`。正解 = `WS_EX_TRANSPARENT`（MSDN「Layered Windows」：
  the shape of the layered window will be ignored and the mouse events will be passed to other
  windows underneath）。⛔ 它**不影响** ULW 显示（ULW 直提 DWM、不走 `WM_PAINT`，且
  `hud_wndproc` 已吞 `WM_ERASEBKGND/WM_PAINT`）；✅ 旁证 0x0106/0x0107 带着它时 HUD 可见
  **且**能正常绘制。正常 `ex` 必须含 **0x20**，正常值 `0x080800A0`。
- ⛔⛔ **`WS_EX_TOPMOST` 必须直接写进 `CreateWindowExW`（建窗即置顶）**（第十五轮，统计定案）：
  `raise=1` **不可信** —— 四场真机日志统计 `ex=` 的 0x08 位：`21876`(0x010B) **0/40** 看不见
  → `21904`(0x010B) **56/56** 看得见 → `13772`(0x010C) **31/31** 看得见 → `22288`(0x010D)
  **0/36** 看不见（五项自检全绿）。该位**会话内恒定、跨会话不同** ⇒ 取决于建窗那一刻，
  不是每帧 `SetWindowPos(HWND_TOPMOST)` 决定的（那句恒返 TRUE 却不设位）。另加兜底：
  读不到该位就 `SetWindowLongW(GWL_EXSTYLE, |WS_EX_TOPMOST)` 强制钉上，并把 raise 调用改回
  0x0107 的已知能见形状（位置 + z 序**同一次调用**，不带 `SWP_NOMOVE`）。✅ **0x010E 起真机确认可见**。
- ⛔ **内容走 `UpdateLayeredWindow` + 32bpp 预乘 alpha**（`ULW_ALPHA`，`hdcDst=NULL`）；顺序 =
  `memset(bits,0)` → GDI 画（**不写 alpha**）→ alpha 化（`v&0x00FFFFFF` 非零 ⇒ `v|0xFF000000`）
  → ULW。⛔ **ULW 只提交内容与位置、完全不碰 z 序** ⇒ 必须另有每帧
  `SetWindowPos(HWND_TOPMOST,…|SWP_SHOWWINDOW)`。⛔ 去掉 `SetLayeredWindowAttributes`
  （与 ULW 互斥，且是「画笔色=黑 ⇒ 整窗透明」的来源）。⛔⛔ **以后任何调试都不要加屏幕可见的
  临时装饰**（曾加 1px 白框当判决器，用户明确要求删除）。
- ⛔ HUD 其他定案：`POINT cur` 必须 `{0,0}` 初始化后交 `GetCursorPos`（失败时该 API **不写出参**）。
  ⛔ **pktAge 无符号下溢**：`(DWORD)(now - g_snMs)` 在 `g_snMs` 略超前（跨线程竞态）时下溢成
  ~4.29e9 ⇒ `activeNow=0` ⇒ 笔正落纸面 HUD 却不显示（日志 `active=0(t=4294967280ms)`）。
  统一走 `sn_age_ms()`（先 DWORD 相减、再按 LONG 解释），三处：HUD 显隐 / 圆心外推 / 落笔锁存。
- ⛔⛔ **断流期一律不画 HUD**：用户判定「圆心钉光标、不画绳、改红」是**错误显示** ——
  「受力点施力点重合」；圆心本该是选区末端，钉到光标上语义正好相反，**画一个语义相反的圆
  比不画更糟**。⇒ `wantVisible` 用 `!deadNow` 挡掉，断流状态只由面板状态条承担。
- ⛔ 显示路径必须自检可判：`[hud] 显示:`（2s 节流）落盘
  `vis/ex/exb/top/raise/ulw/rect/cur/off/size/col/px[ctr ring far]（**%08lX 含 alpha** ——
  alpha=0 在 `ULW_ALPHA` 下就是完全透明，是除 z 序外唯一能让「内容对却看不见」的路径）/
  reShow/z/err`；ULW 失败另打 ★ 行（只报一次）；另有一次性 `★z 链`（HUD 之上 8 个窗口的
  类名/rect/可见/topmost/pid/是否覆盖光标 ⇒ 一眼定位遮挡者）。

### O3. 独立笔通路：Raw Input 已弃用 ⇒ **采样源 = 系统光标**（0x010F）

- ⛔⛔ **Raw Input 两轮真机零输入**：设备（Wacom `VID_056A&PID_0357` 三个 collection）
  **在 `GetRawInputDeviceList` 里**、三条 usage 注册全 OK（`注册=0b111`），却整场
  `HID=0 / 绝对鼠标=0`、**一条 WM_INPUT 都没有**（状态行只打一次是设计使然：无增量不重复打）
  ⇒ **弃用**。⛔ **注册成功 ≠ 收得到**。0x010F 起加 `01/06 键盘` 当**对照项** +
  `全部WM_INPUT`/`键盘` 计数 ⇒ 判「通道/窗口有问题」vs「笔设备不在 Raw Input 队列」
  （Wacom WinTab 模式下就是后者）。
- ⛔⛔ **改用 `GetCursorPos`（`cursamp_thread`，`CS_PERIOD_MS=4` ≈250Hz）**：依据 =
  `[dead] ★包流断供: 包冻结 516ms 而光标仍移动(Δ累计509px)` ⇒ **光标在停摆期是活的**，
  它是唯一独立于 Wintab 的笔位置来源。采样值直接 `ri_push` 进 raw 环 ⇒「配对 → 逐轴仿射
  拟合 → 补流」**一行都不用改**（拟合自适应：采样坐标是屏幕像素还是 HID 原始值，它自己会算出
  a/b；`penraw_synth` 本来就按样本序号消费、不重复 ⇒ **天然节流，无需另加**）。⛔ HID/绝对鼠标
  哪天真有数据，本线程**立即让位**（不混源）。
- ⛔⛔ **拟合必须两趟**：配对的采样坐标与平板坐标**取自不同时刻**（窗口内可差
  `RI_PAIR_GAP_MS=10`）⇒ 残差里天然混**运动噪声**（1000px/s 下 10ms ≈ 160 平板单位）
  ⇒ 一趟最小二乘的 rms 被撑到几百单位 ⇒ 拿「绝对很小」的阈值去卡会把**正确**映射也判失败。
  做法：粗拟合 → 按绝对残差 `RI_FIT_OUT_KEEP=96`（6px）剔离群 → 只用保留集重拟合，对保留集
  rms 下狠手。**唯一有效性判据** = 保留集 ≥ `RI_FIT_MIN_N=150` 且逐轴 rms ≤ `RI_FIT_MAX_RMS=8`
  （0.5px）且跨度 ≥ `RI_FIT_MIN_SPAN=1000`（防病态）。映射整体错（错轴/错比例/错符号）⇒
  残差几百~几万单位 ⇒ 保留集几乎为空 ⇒ 判失败 ⇒ 判据仍然决定性。不成立 ⇒ 本模块
  **一个字节都不写**（与旧版逐位相同）。
- ⛔⛔ **补流门控（0x010F 收紧）**：① `enNow`（面板开关 + 心跳防呆）**必须在补流之前算出来**
  —— 补流会**往调用方缓冲里写坐标**，比平滑更「越界」，用户关掉开关就该一个字节都不动
  （旧版没检查 ⇒ 关掉也照补，自查出的漏洞）；② `realAge >= RI_STALL_MS(250)`（**真实包**
  已空转，凭据 = `g_lastRealMs`，只在 `!synth && r>0` 时刷新）；③ `rawAge <= RI_FRESH_MS(150)`
  （采样源还活着）。⛔ **缺 ② 会在驱动正常时也一直补流** —— 光标源把 raw 环喂得太饱，
  旧「raw 新鲜」判据恒真。
- ⛔⛔ **落笔死锁（0x010F 修）**：断流 >5s 时 `[pen] 落笔锁存超时` 会清 `penDown` ⇒ 合成包
  压力=0 ⇒ 被判悬空 ⇒ 补流白做（且**死锁**：0 压力 ⇒ `penDown` 仍 0）。⇒ 用 **`g_lastRealTip`**
  （最后一个**真实包**结束时的落笔态，在 `smooth_packets` 之后、`if(g_cfg)` 之外记录）补位，
  外加「最近补流过 ≤3000ms」自持。⛔ 副作用（真抬笔后仍补流）**无害**：抬笔后**光标不动**
  ⇒ 合成包坐标一成不变 ⇒ PS 画不出任何新东西。
- ⛔⛔ **`cfg_open()` 低频重试必须无条件**（旧版关在 `if (r > 0)` 里 ⇒ 若「插件一上电就断流」
  则 `r` 恒 0、永不重试 ⇒ `g_cfg` 永远 NULL ⇒ **补流与平滑一起失效**）。
- ⛔⛔ **必须丢冲包**：刚补过流（≤2000ms）而真实通路一次吐回 ≥`RI_BIG_BURST=25` 包 ⇒ 丢弃并计
  `g_dropBurst`。不丢的话 PS 先按补流画到光标、再把几十个**旧**坐标重放一遍 ⇒ 整根弧线
  **倒着**画回去。
- ⛔ **合成包用模板**（真包最后一包原样留存 ⇒ 所有不认识的字段保持合法），克隆后改
  X/Y/压力/buttons/time/serial。**落笔必须给非零压力**（闸门判据靠它）。`offTime`/`offChanged`
  进 LAYOUT/CALIB/ctx_cache，**只在 src=1（掩码+数据双证据）采信**。
- ⚠️ **已知局限**：拟合要求保留集**跨度 ≥1000px**（屏幕像素）⇒ 只在很小范围内画时拟合建不
  起来（保守设计，宁可不补）。

### O4. `axMax` 守卫 bug（0x010F 修）

- `if (g_pxSrc != 1)` 把「上界口径」整块关住 ⇒ 首次标定置位后**每次标定都跳过** ⇒
  真机 `jwwh-9252`：`[calib] lcOut* ext=(55040,23040)` 两次不变，`[status] axMax` 却从
  **55040 退回 44800**（= 退回 lcInExt）⇒ `jumpPx` 等位移门限的分母缩 **19%**。
  ⇒ **上界口径每次标定都重算**（移出守卫），并加 `[calib] 轴上界最终 = N（应 = lcOutExtX）` 一行。

### O5. 0x0110 / 0x0111→0x0112 补流与陈旧判据（2026-10-16 真机定案，由 MEMORY.md 下沉）

- ✅ **补流的自锁已修（0x0110）**：补流（250Hz `GetCursorPos` → 配对 → 两趟拟合 → 合成包）原先只认
  **强拟合**（保留集≥150 + rms≤8 + 跨度≥1000），而配对**只在真实包到达时产生** ⇒ 「刚挂上就断流」时
  拟合永远建不起来 = **最需要补流时恰恰建不起来**。新增 `ana_update()` **解析兜底**：
  `平板 = 屏幕/px + 原点`，只需 ① 标定成立 ② `g_pxSrc==1`（驱动 lcOut 权威，**不依赖配对**）
  ③ 两轴符号已投票 ④ ≥1 对配对定原点；配对≥16 时用近 64 对核对 rms ≤ `RI_ANA_MAX_RMS`(48 单位=3px)。
  `g_synOn` 改为 `syn_set()` 统一发布（**强拟合 ∨ 解析**）；`penraw_synth` 系数循环外取一次、强拟合优先。
  ⛔ 系数跨线程走 **seqlock `g_anaVer`**（detour 与 worker）。
- ⛔ **真机实测：强拟合判据在本机永远达不到**（rms 9.7~19.4 ≫ 8.0，跨度常卡 572）
  ⇒ 补流 **100% 靠解析兜底**在扛，`拟合=未建立` 是常态、**不是故障**。
- ⛔⛔ **过冲根因**：`[dead] 恢复：★冲包量=48 包`（≈驱动队列容量；48÷200Hz ≈ **240ms** 位移一瞬间灌入）。
  旧守卫「单次 ≥ `RI_BIG_BURST`(25) 包 = 冲包」是**死代码** —— 真机 `最大单次∈{0,1,3,4,5}`、
  `≥25包次数` 与 `丢冲包` **恒 0**（PS 每拍只取 1~5 包 ⇒ 48 包被拆成十几拍，任何「单次包数」门限都拦不住）。
  ⇒ 补流已把笔尖喂到**当下**，驱动再把 240ms 前的旧坐标**追加**在它后面 ⇒ 选区**倒退再猛追** = 过冲。
  ⛔ **判据按时间不按包数**：真实包早于**补流前沿 `g_synFrontT`** 即陈旧，只丢**队首连续**段、追上前沿就停手。
  ⛔⛔ **连带修复**：`g_lastRealMs` 必须按 **`rRaw`（驱动原始返回）**记 —— 按丢包后的 `r` 记会**自锁**。
- ⛔⛔ **0x0111→0x0112 陈旧判据重做（第十八轮）**。0x0111 是**死代码**（真机 150/151 采样 `陈旧包=0` 恒成立），
  根因两条：① **护栏「用陈旧幅度反推时间基」**（`|now−pkTime| ≤ 5000`）—— 停摆 13s/111s 时恢复包**天生**那么旧
  ⇒ 判「不同基」⇒ **整条放弃**（**量纲混淆：「包有多旧」≠「时间基是否一致」**）；② 窗口以「补流结束」为起点（3s），
  而真机补流 `18:33:51.077` 结束、恢复 `18:34:01.610` = **10.5s 后** ⇒ 窗口早过。
  ⇒ 0x0112 三条修法：① `g_pkBaseOk` 改**正面证据**（见过 `age ≤ 400ms` 的包 ⇒ 同基，此后前沿比较**不受幅度限制**）；
  ② `g_lastRecovMs` 窗口改「**停摆恢复**后 4s」（`prevRealAge >= RI_STALL_MS(250)` 打点，⛔ 必须在更新 `g_lastRealMs` **之前**取）；
  ③ 新增**按包龄**判据（`age > RI_PKT_STALE_MS(1500)`）覆盖「停摆期没补流」。两条判据**并列**，
  三道护栏任一不成立**一个字节都不动**。⛔ **铁律：判定能力不能建立在「待证明的前提」上。**

### O6. 进程内工具闸门（`'slct'`，0x0112 新增，`native/JWautofillHost/ps_tool.c`）

- `SPBasicSuite=md+0x18`、`self=md+0x08`；三 suite `df135117-…ec47`/`bc1e4d70-…f7ee`/`df135115-…ec47`，
  **version=整数 2**；注册 `ctrl+0x20(refcon,'slct'=0x736c6374,proc)`、注销 `ctrl+0x28(refcon,'All ')`、
  释放 `basic+0x08(uuid,2)`；偏移 `desc+0x28`GetCount/`+0x18`GetKey/`+0x10`GetType/`+0x100`GetReference/
  `ref+0x18`GetDesiredClass/`ctrl+0x18`TypeIDToStringID；判据 `GetType()=='obj '(0x6f626a20)` → 类名 `strstr(buf,"Tool")`。
- ⛔ 方法指针返回类型**一律 `short`**（LNP 只读 `ax`）；引用槽**给足 16 字节**（少给=栈越界写）。
- ⛔⛔ **三态接管**（宁可不用不可误用）：`0`不可用 / `1`已注册未读数 / `2`已接管 —— **只有 2 才让面板停轮询**，
  任一步失败退回旧行为（fail-open）。
- ⛔ **接管后三处必须同步**：① 面板 `syncSmoothToolWatch()` 停表；② `applyToolGate()` 开头 `return`
  （**唯一咽喉**：`pollSmoothToolGate` 与 `pollToolChange` 都走它）；③ 原生 `write_params()` **不再写 `I_TOOLGATE`**
  —— 两边都写就是互相覆盖（各自刷戳 ⇒「谁都新鲜」⇒ 切了不生效/换回不恢复）。
- ⛔ 有效性实测：LNP `log_photoshop.txt` `setPSTool(): PS tool name: lassoTool` 于 **PS 2026/27.8 今天跑通**。
  ⛔ 新字段 `toolSrc`/`psTool`（`-1`=对端不报 ⇒ 面板保持轮询）。
- ⛔ **变参日志的 tag 陷阱**：`pstool_log` 是**单 `fmt` 变参**（tag 写死在 `log_line("ps_tool",…)` 内部）
  ⇒ 调用点多传一个首实参会被当 `fmt`，**真文案与占位符全废**、只打出一行 `ps_tool`，而**编译器不报错**（变参合法）
  = 静默缺陷。新增变参日志接口时先看清它收不收 tag。

### O7. `.8li` 真机铁律与部署（由 MEMORY.md 下沉）

- ⛔⛔ **.8li 真机铁律**：① PiPL 头部=10 字节；② `'8664'` 入口导出名属性=**C 字符串**
  （Pascal 串 ⇒ GetProcAddress 失败 ⇒ attach 后 1ms 静默卸载）；③ 加载消息=`"SP Access"/"Reload"`，
  卸载=`"SP Access"/"Unload"`；④ 引擎+WS 层合并镜像，**无 daemon 无注入**；
  ⑤ 自写 SHA1 必须用已知向量实测（RFC6455 App.A）。
- 📌 **PS 插件目录按测试机分叉**：① 双 4K 机 ⇒ `E:\Program Files\Adobe Photoshop 2026\Plug-ins\`；
  ② **本机（3440×1440 带鱼屏）⇒ `C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\`**。
  两机都只有**一个** `JWautofillHost.8li`。⛔ PS 运行时锁该文件 ⇒ 覆盖前**全部退出** PS（本机常有 3 个进程）。
- ⛔ **JWA 的 .8li 部署位置**：本机 = `C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\`
  （`PSUserConfig.txt` 确认 `UseSystemStylus 0` ⇒ 走 WinTab）。**全机只能有一份** —— 两份同名会被 PS 都加载，
  第二实例检测到「入口已被占用」⇒ state=4（须重启 PS）。⛔ 换 .8li 必须重启 PS。
- ⛔⛔ 部署只认 `build/JWautofillHost.8li`；核验 = 日志头 `ver=0x0XXX` + `[status]` 含 `dpi=N‰`。
  ⛔ 版本号核验要**走导出表解析**读 `jwwh_version` 函数体前 10 字节（裸搜 `B8 xx 01 00 00 C3` 会漏 —— 函数序言是 `55 48 89 E5`）。
- ⛔⛔ **IPC 数字字段双防御**：面板 `toWire()` 出口对所有数字一律 `Math.round`（唯一咽喉）；
  原生侧字段用 `double?`+赋值 Round。漏一个浮点 ⇒ 整条消息被丢 ⇒「切换模式后平滑就断」。
  **新增字段必须同时做这两件事**。
- ⛔ **GATETS 由 pump 接管**：`cli_count()>0 || pstool_owns()` 即每 500ms 刷（面板 1500ms 心跳不可靠
  ⇒ reason=4 fail-closed；⚠️ 进程内闸门接管后**必须**带上后半条 —— `'slct'` 只在工具变化时来，
  不续期就 3s 过期 fail-closed）；全断且未接管 ⇒ 停刷 ⇒ 3s 过期语义保留。⛔ 独立实测必须关 PS（旧副本占 18924）。

### O8. 进程内模态层级 + Wintab 上下文钩子（0x0113，2026-10-17 LNP 逆向迁移）

- **`modalStateChanged` 读 `'Lvl '`**（`0x4c766c20`，整数）= **PS 模态嵌套层级**。
  这是 `isPsBusy()` + `MIN_MODAL_GAP_MS` 那套**猜测式**忙碌闸门的**进程内替身**（零 batchPlay）：
  `-1`不可用 / `0`空闲 / `>0`宿主握着模态作用域。
  ⛔ `StringIDToTypeID` 在 `sPSActionControl+0x10`（`+0x18` TypeIDToStringID、`+0x20` AddNotify 已在用）。
  ⛔ 顺序：**先 `StringIDToTypeID` 取 ID，再 `AddNotify`**（LNP `initInstance` → `initCallbacks` 同款）。
- ⛔⛔ **面板侧三态、禁止并进 `isPsBusy()`**：`psBusyInProc()` 返回 `1`确定忙 / `0`确定闲 / `-1`不可用。
  `isPsBusy()` 是**否定式**安全闸（宁可多等，漏判=弹框）；层级是**肯定式**事实。
  若合并，用户主动的填充/描边也会被挡 ⇒ 更糟的回归。⇒ **只给巡检类入口用**（丢一轮无副作用）。
- ⛔ **`modalTs` 不可与 `Date.now()` 比**（GetTickCount 口径，进程内）。面板侧只用 `modalLevel` 当前值。
- ⛔ **`CFG_NLONGS` 48 → 56**（2026-10-17）：新增 `I_MODALLVL/MODALTS/TMODAL/TMODALK/DOCEPOCH`。
  `plugin_main.c` 与 `smooth_engine.c` **必须同步**（谁先建节谁定尺寸，不一致静默截断）。
- ⛔ **`toolModalStateChanged` 极性未证明 ⇒ 不门控**：LNP 自己的这个回调是**空函数**（`FUN_180007d60`
  反编译为 `return;`）。本版只取证（`toolModal` / `toolModalKnown`），等真机见过 0 与 1 两种值才接逻辑。
- **④⑤ 改写类开关一律外置**（`%LOCALAPPDATA%\JWautofill\smooth8li\wtctx.ini`，缺文件=全 0=只观测）：
  `clearLocks`（清 `lcLocks(+48)` 的 `CXL_SYSOUT=0x10`）/ `fixDpi`（改 `lcSysExt`）/ `queueSize`（`WTQueueSizeSet`）。
  ⛔ 改口径不该以重编 + 重部署 .8li 为代价（PS 锁文件，覆盖要先完全退出 PS）。
- ⚠️ **⑤ 的 `lcSysExt` 偏移存疑**：本仓 `[calib]` 实测 = `144/148`；LNP 报告给 `+0xA0/+0xA4`(160/164)。
  差 16 字节无法静态定案 ⇒ `wtinfo_observe()` **两套都打**，真机日志里谁等于 `SM_CXVIRTUALSCREEN` 谁对。
- **⑧ `WTSanityCheck`**：`se_wt_moved()` 比对 wintab32 的 `AllocationBase`（`prepare_hook` 时记录），
  pump 每 500ms 一次，变了落 `[wt] ★wintab32 已重载` 并重挂（`send_cmd(2)` 后 `send_cmd(1)`）。
  ⛔ 以前看 state/calls 的自愈**不留痕** ⇒ 断流无法归因。
- **⑨ 工具白名单外置** `%LOCALAPPDATA%\JWautofill\psTools.xml`（照 LNP 的逐工具布尔形态）。
  ⛔ 缺文件回退 `ci_has(name,"lasso")` —— **逐字等价于**原口径，这是"不引入回归"的依据。

### O9. `'slct'` 活性看门狗 + 面板统一判据（0x0115，2026-10-17 午后 pid 13428 真机定案）

**现象（用户报）**：频繁切换工具后再切回套索，平滑**永久失效**；开关套索平滑开关救不回。

**证据链**（`jwwh-13428.log` + `pi8li.log`，全部可复算）：

- 06:53:13 `.8li` 首读 pencilTool ⇒ `state=2` 接管、面板停轮询（**单点供给形成**）。
- 06:53:13–06:53:36 `'slct'` 连投 5 次（pencil→gradient→wetBrush→smudge→marqueeEllip）正常。
- **06:53:36 起 `'slct'` 彻底静默 72 秒**直到进程结束；同期 `toolModalStateChanged`
  照常投递 40 次（n=52→92）、`modalStateChanged` 也投递 ⇒ **停的只是 `'slct'` 这一路**。
- 引擎侧 06:53:14 起 `toolOk=0 / reason=2(非套索)` 冻结在 marqueeEllipTool、闸门 `gate=0`。
- 用户 06:54:10 / 06:54:23 两次开关平滑无效 —— **开关只切 `g_enabled`，不碰 ps_tool 状态**。

**根因（架构层，非偶发）**：⛔⛔ **`'slct'` 是边沿触发、无心跳** —— 只在工具改变时投递，
而「当前工具」是**持续量**。0x0112 起把它单点押注（`state=2` ⇒ 面板永久停轮询）
⇒ 通道静默 = 真相永久丢失。**PS 为什么停投未知，但修复不依赖该答案。**
对比 LNP：同样只注册 `'slct'` 无兜底，但其平滑主链**不依赖工具闸门** ⇒ 故障被掩盖。

**修复（0x0115，已构建核验）**：

- `ps_tool.c`：`s_lastNotifyMs` 记回调时刻（`GetTickCount`，卸载时清零作废心跳）；
  `pstool_notify_age()` 返回距上次回调 ms（`-1`=从未投递）。
- ⛔⛔ **`pstool_owns()` = `state==2 ∧ 0 ≤ age < PS_NOTIFY_FRESH_MS(2000)`** ——
  接管**带时效**，超时即让位面板轮询；`'slct'` 恢复即重新接管。
- pump 每 500ms 写 `I_NOTIFYAGE` / `I_GATEOWNED`；JSON 字段 **`notifyAge` / `gateOwned`**。
- ⛔⛔ **单一判据原则**：阈值**只在原生侧算**，面板读 `gateOwned` 这个**结论**，
  **绝不自己拿 notifyAge 比阈值**（两边各存一份阈值迟早不同步）。
- 面板 `inProcGateOwned()`（`app.tsx`）：`gateOwned < 0`（旧版 .8li 不报）⇒ 回落
  `toolSrc === 2`；否则 `gateOwned === 1`。替换 `syncSmoothToolWatch` / `applyToolGate`
  入口 / 卸载路径三处的裸 `toolSrc` 判据。
- `LassoSmoothing.ts`：`notifyAge`/`gateOwned` 默认 `-1`，逐个 `=== undefined` 回落，
  ⛔ 禁 `|| 0`（`notifyAge` 的 -1=从未投递、`gateOwned` 的 -1=对端不报，洗成 0 全读反）。
- ⛔ **`CFG_NLONGS` 56 → 58**（`CFG_I_NOTIFYAGE` / `CFG_I_GATEOWNED`，两个文件手写同步）。
- 诊断行 `回调龄=%ds` **按秒取整** + `★陈旧⇒让位面板` 标记：毫秒值每拍都变，会让
  「diag 变了才打」在静默期每 500ms 一行（实测 72s 静默 = 144 行刷屏）。
- **2s 阈值理由**：GATETS 续期窗口本就是 ~3s 过期语义；2s 让位后面板轮询接管，
  与既有节奏同量级，不新造时序假设。
- **验收判据**：频繁切工具 ≥6 次后切回套索，**HUD 须 ~3s 内恢复**；pi8li.log 应出现
  `回调龄=…★陈旧⇒让位面板`；日志头 `ver=0x0115`。
- **遗留（记账）**：P2 冷启动缺口不变（不切工具 ⇒ 永远 `state=1`，功能正常只是没省预算）；
  P3 根治 = 给 PICA 补同步查询当前工具（`sPSActionControl->Get` 偏移逆向），风险大于收益未做。

### O10. HUD 焦点门（0x0116，2026-10-17 午后二轮 pid 36628 真机定案）

**用户铁律（原话）**：「焦点不在活动文档的画布上 & 未在画布上落笔时，避免生成 hud」。
第十七轮 AND 门（strokeOk/drawOk/fgOk）后用户复测**同样两条抱怨依然存在**：

- **② 面板调参出 HUD**（套索工具 + 浮动态 UXP 面板 + 数位笔拖滑块）：
  Wintab 是**系统上下文**（CXO_SYSTEM 驱动侧移动光标），笔落在面板上包**照常进 detour**
  （用户截图诊断：取包 18495 / 改写 5966）⇒ 压力/按钮非零 ⇒ 接触判据必然为真 ⇒
  起笔闩锁闩住 ⇒ 旧门控全过。**引擎从 Wintab 数据分辨不了笔在画布还是面板** ⇒ 必须问
  Windows 要焦点。manifest 该面板 `type:"panel"` 且可浮动。
- **① 加载没落笔出 HUD**：`contact_update` 有两条**刻意 fail-open**（判据不可用
  `g_ctN<=0` / 冷启动宽限 `CT_GRACE_PKT=600`），jwwh-36628 实测 **07:28:45–07:29:46
  共 61 秒 `信号=（无）生效=0`**，期间 `g_contact` 恒 1、penDown 随包流置 1。
  本场因 toolOk=0 没扣扳机；用户此前会话已实见 ⇒ **时序依赖的必然，不是偶发**。

**修复（0x0116，两处门 + 全景取证）**：

- **canvasOk**（`canvas_focus_ok()`，每帧求值）：主框 `class="Photoshop"`（EnumWindows
  按 PID 实测，2s 退避重解析）+ `MDIClient`（`FindWindowEx`）= 文档区。四子条件：
  ① `GetForegroundWindow()==主框`（挡浮出面版/对话框/别的 app）；
  ② `GetGUIThreadInfo(前台线程).hwndFocus` 在 MDIClient 子树内（`IsChild`，挡**框内停靠
  面板**/工具条抢焦点）；③ 光标（原始笔尖，`PtInRect` +1px 兜边）在文档区矩形内
  （挡不抢焦点的面板）。任一不过 ⇒ `cv=0`，子原因 why=2/3/4。
  ⚠️ 解析不出主框 ⇒ **fail-open 保功能** + 一次告警日志；无 MDIClient ⇒ 退粗判
  （焦点根窗口须为框）。类名假设万一不成立，日志有**本进程顶层窗口全景转储**可一次修对。
- **ctOk**（`!g_ctUnknown`）：落笔判据**已建立**才准出 HUD，堵死两条 fail-open 对 HUD
  的泄漏。⛔ 只门 HUD **不改平滑路径**——fail-open 是防「一开就是死的」的刻意取舍，
  悬空期改写不可见（没落笔 PS 不画）。
- 诊断：`[hud] 未显示` 行加 `cv=`/`ctU=`；焦点门结论**边沿触发**打一行（带 fg/focus 的
  类名与 cur）⇒ 用户日志可与操作逐条对齐。冒烟测试（合成窗口树）12/12 过。
- **验收判据**：① 加载后不碰笔 ⇒ 全程无 HUD；② 套索 + 拉绳模式下用数位笔拖面板滑块
  ⇒ 无 HUD（日志 `焦点门: why=2/3/4`）；③ 画布上正常作画 ⇒ HUD ~2 帧内恢复
  （`焦点门恢复` 行）；④ 日志头 `ver=0x0116`。

---

## O11. 0x0117 定案（2026-10-17 深夜）：「断流率升高」是测量假象 + 353s 冻结真凶 = 开关循环

> 完整报告（含全部日志引用与修复方案代码）：`analysis/stall-regression-0x0117.md`。

**结论一：断流率没有因 0x0116→0x0117 升高。** 0x0116 三个对照会话
（jwwh-7232/8692/8832）全程 `packets=0`（8832：31.4 万次轮询零包、calib=否、
pkt1=0）⇒ stall 检测按包数变化边缘触发，无包则永远只有一条启动良性线。
"当时未出现断流" = 当时根本没在画画。0x0116→0x0117 的 smooth_engine.c 仅 68 行
差异、3 处语义变更（synth=1 移出 k>0 / [stall] 加 fg= / DETACH 调 jwwh_unhook），
无一触碰驱动交互与停摆判据。

**结论二：0x0117 会话（jwwh-36936，9645 包）的停摆分两类**：
① 3 次落笔中短停摆（2.4s/6.4s/2.1s）= **PS 失前台**（DroverLord×2 / Shell_Tray /
Chrome 抢前台），驱动只给前台上下文派包（M5/O1 定案，两版本相同）；
② **353.6s 永久冻结** = 插件状态机缺陷，四因叠加：
  1. `do_unhook` 清 `g_synOn/g_anaOk/g_synFrontT/g_lastRecovMs`（3657-3660 行）
     ⇒ 停摆中用户拨开关 OFF = 亲手杀掉正在救场的补流（16:01:33.574 卸载时
     补流已接管喂了 118 包）；
  2. cmd=1 重挂**无条件** `g_calib.valid=0`（4383 行）⇒ `ana_update` 早退 +
     接管条件要 `g_calib.valid`（3370 行）⇒ 补流永远无法重新武装，直到用户重新
     画出真实包——而冻结期 PS 不在前台、驱动零包 ⇒ 永远等不到；
  3. 退出日志说假话：`g_synExit` 含 enNow=0（开关被关）路径，却恒打印
     「真实通路已回包」（16:01:34.879 同帧 [pk] 真实包=0）；
  4. 面板拨开关本身抢前台（16:01:38 fg=()→本进程=0），每次自救都在添柴。

**修复方案（✅ 已实施并构建核验 = 0x0118，2026-10-17 17:30；用户批准后落地）**：
- Fix 1a：`do_unhook` 删掉四行清零（`g_gateOk=0` 保留）；`s_synWas`/`s_synT0`
  上提文件级 `g_synWas`/`g_synT0L` 供 do_unhook 复位 + 撤钩时若正接管直接按
  why=1 落账（否则重挂后再接管不打「★接管」日志、两段接管拼成一段）。
- Fix 1b：cmd=1 只复位 `tried/attempts`，**保留 valid**（环境变化归 worker
  250ms 指纹段管；未标定过时 valid 本就是 0，行为零变化）。
- Fix 2：新增 `g_synExitWhy` 五档分类码（0 真包回 / 1 引擎被关 / 2 面板开关关 /
  3 标定失效 / 4 采样源死），detour 分类置位、worker 按码打文案；do_unhook
  撤钩杀接管也走 why=1。
- Fix 3（面板 app.tsx）：toggle-off 去掉冗余 `disconnectSmoothDaemon()`
  （penSmooth(false) 已内含 commit(0)→send_cmd(2)），import 同步退役。
- ⛔ 版本号 **0x0117→0x0118**（原计划"仍 0x0117"作废——0x0117 已在 pid 36936
  实测部署过，不升版本则日志头无法区分新旧二进制）；构建：build.sh 零告警 +
  PiPL 往返一致 + 字节核验 `mov eax,0x118` 在 / 0x117 消失；tsc src/ 0 报错、
  yarn build 通过（3 个既有体积 warning）。
- ⛔ **未部署**（PS 运行中锁文件）：`build/JWautofillHost.8li`（317,952 B）待用户
  退出 PS 后拷入 Plug-ins 目录。
- LNP 逆向报告已复核：无可直接借鉴机制（LNP 无补流通路；CXL_SYSOUT/WTSanityCheck
  0x0113 已落地且与本案无关；§4.4 自证无冲包），仅 §10 看门狗哲学同构。

**M6 面板改动（2026-10-17 深夜已实施，用户三项要求之二：套索平滑隐藏标定态）**：
- `smoothStatusText()`：state=0 两分支（待标定/标定中…）合并为 `套索平滑：准备中`；
- `smoothBarTone()`：末档 `notify-bar-warn` → `notify-bar-disabled`（灰、无颜色，
  与"关"档同款）；state=2 标定失败（红）按用户只说黄色予以保留。
- ⛔ 标定过程仍在后台照常跑（try_calibrate / ana_update 未动），只是不再展示。

---

## O12. 0x0119（2026-10-17 18:00）：补流武装加固——落笔点 PS UI 的秒级断流

> 样本：`jwwh-32560.log`（0x0118 首场，843 行）+ `pi8li.log`。用户报「依然严重
> 断流，第一次出现在新建图层之后」。✅ 已实施并构建核验（零告警 + 0x0119 字节），
> ⛔ 未部署。

**新断流形态（与 M5「失前台」同源、粒度更细）**：**落笔状态下把笔尖划到 PS 的
UI（图层面板「新建图层」按钮 / 工具栏）并点击 ⇒ Wintab 驱动只给持有焦点的窗口
派包 ⇒ 画布上下文（hCtx=0x803）停收包 1.3~3.1s**。PS 进程仍是前台（全程 fg=1，
所以失前台判据看不到这一类），驱动继续采样把包攥在队列里（恢复时冲包 19 包
≈ 队列容量），笔尖保持接触（penDown=1 contact=1）。证据：17:49:47 停摆前 cv=0
（焦点已离画布）、光标 (3751,2069) 屏幕底部 = 图层面板位置、[rst]+jump。

**补流为何没救场（三重障碍，0x0119 修前两重）**：
1. `RI_FIT_MAX_RMS=8`（0.5px）**运笔场景永不达标**：映射系数实测 a=16.003/-16.012
   （真值 ±16 全对），保留集 rms 持续 18~35 单位（1.1~2.2px）——残差全部来自
   raw 光标 64Hz 与 wintab 包 66Hz 的配对时间错位（函数注释自己预言的 10ms≈160
   单位）⇒ **g_fit.valid 全程 0，强映射从未武装**；
2. **恢复冲包污染配对环**：17:49:48.66 恢复吐 19 包旧坐标，RI_PKT_STALE_MS=1500
   管不到 1.3s 停摆（一个没丢）⇒ 解析残差 42→128、17:51:52 → 172/411 ⇒
   g_anaOk 也时通时断 ⇒ synOn 断续，真停摆来时补流是死的。

**0x0119 两改**：① `RI_FIT_MAX_RMS` 8→48（3px，与 RI_ANA_MAX_RMS 对齐；错误
映射残差几百起仍差一个量级，RI_FIT_OUT_KEEP=96 剔除在前）；② `penraw_maybe_pair`
新增 `RI_PAIR_MAX_AGE=400ms` 包龄过滤（offTime 未标定 pt=0 时放行），停摆恢复
冲包不进环。

**另记（非 bug）**：17:50:19 的 3.1s「停摆」是用户落笔按住不动（[frz] movedTot=0），
驱动对静止笔尖不派包属正常行为——[stall] 记录但非用户可感知断流。

## O13. 0x0120（2026-10-17 18:15）：补流救援生存性——救援被自家复验拆台

真机 jwwh-37300（0x0119 部署后首场，用户对照 aab32f1/0x0116「数十笔不断流，
现在断流严重」）。12.9s 大断流（18:12:21.792–34.143，penDown=1 fg=1）实锤链：

1. 22.582 补流接管（当时解析刚在 20.485 复验过 ★可用）；
2. worker 每 2s 的 `ana_update()` **先清 g_anaOk 再按最近 64 对复验**，运笔中
   残差在 31↔71 震荡（配对时间错位随速度波动），下一次复验 70.9>48 ⇒
   `syn_set()` ⇒ g_synOn=0；
3. 24.687 救援按 why=1「引擎已关闭」退出 —— **接管被自家复验拆台**；
4. 断流期配对环冻结（无真包）⇒ 复验恒失败 ⇒ 补流永远无法重新武装，
   冻结到 34.143 驱动自愈（恢复冲包 30≈队列容量，攒着不是丢）；
5. 25.7–26.3 PS 自身重开 Wintab 上下文（0x802→0x803）⇒ 我方撤钩+重挂
   （诊断钩还原/卸载/挂载三连日志），进一步推迟恢复。

**0x0120 三改**：
① detour 门 `(g_synOn ∨ g_synWas)`（接管保持）：已接管期间不再逐拍复验总闸；
   首次接管仍要求 g_synOn；calib.valid/enNow/真路空转/采样源新鲜照旧硬把关。
② `penraw_synth` 快照兜底（`g_holdAx…`+`g_holdOk`，**声明必须先于该函数**，
   放 g_synOn 旁）：live 两路全灭时沿用某刻通过验证的系数继续喂包；快照只在
   live 来源可用时刷新，错映射（残差数百起）进不了快照。
③ ana 复验滞回：启用 48 不变、已启用后 `RI_ANA_OFF_RMS=96` 才判失效 ——
   治「映射时通时断」的本源，让救援在停摆到来时大概率已武装。

附带：do_unhook 清 g_synWas 改 Interlocked（g_synWas volatile LONG 化）。
验收口径：断流中 ★补流接管 后不应再出现 why=1/why=3 退出；[raw] 解析应稳定 ★可用。

## O14. 0x0121（2026-10-17 20:00）：HUD 焦点门补漏（拖面板仍出 HUD）+ penSmooth 可观测性

真机 jwwh-26156（用户部署 0x0120 后）：① 套索下拖插件面板仍出 HUD；
② 减小拉绳半径 HUD 圆不变。

**Bug 1 根因**：PS 2026 是 OWL 架构、**无 MDIClient**（日志全程 mdi=0，全景转储
实见 `class=OWL.WindowGroup title=Document Layer` 顶层窗口）⇒ 0x0116 的
`canvas_focus_ok` 走「焦点根窗口=主框」粗判，**该分支没有光标校验**。套索下在
浮动 UXP 面板上用笔调参：Wintab 系统上下文包照常进 detour ⇒ 接触判据真；面板
WS_EX_NOACTIVATE 不抢焦点、前台仍是主框 ⇒ 粗判恒过 ⇒ HUD 泄漏（违反铁律）。

**0x0121 改动**：
① `frame_resolve` 增 Document Layer 采集回调（A 版 API 读类名/标题，最多 4 个，
   逐个 IsWindow 验活，2s 退避；⛔ 仅 `!s_psMdi` 时启用，与 MDI 路径互斥）；
② `canvas_focus_ok` 粗判分支增 `WindowFromPoint(cur)` 子树判据
   （`hit==docLayer ∨ IsChild(docLayer, hit)`，why=4）；⛔ 解析不出时**只保留
   0x0116 粗判**，不回归；WindowFromPoint 自动跳过 WS_EX_TRANSPARENT 的 HUD 自身。
③ plugin_main penSmooth handler 增留痕（变化门+250ms 节流，落 pi8li.log）+
   [hud] 显示行补 `leash=`（物理圆半径）。

**Bug 2 结论（半径链路无代码断点，勿再盲改）**：面板三条入口（滑杆/标签拖拽/
数字框）→ updateSmoothParam → pushLassoSmoothParams（90ms 节流+尾随，末值必达）
→ sendParams → toWire → json_num("radius") → g_pen.radiusPx → I_RADIUSPX →
HUD 每帧读 `leash_px(rpx)*dpiS`（恒等函数）。截图像素 R≈131.5 物理 px ⇒ rpx≈88
≠ 默认 40 ⇒ 推送确实到过；与滑杆 91 的 3% 偏差在测量误差内。**新增留痕后三态判据**：
无 penSmooth 行=面板没发（!penOn 早退/WS 断）；行值不对=面板侧状态/映射；
行值对而 leash 不变=槽位→HUD 段。⚠️ hudColor 面板无 UI、toWire 无字段
⇒ 引擎恒默认橙 E07F0D（功能缺失，非回归）。⚠️ [hud] 显示行 `col=` 是 COLORREF
（0x00bbggrr）：`col=0D7FE0` = 橙，别误读成蓝。

## O15. 0x0122（2026-10-17 22:55）：修 0x0121 HUD 恒不显示回归（判据反转：docLayer 子树⇒主框子树）+ 断流行补 syn=

真机 jwwh-38216（用户部署 0x0121 后报「HUD 都不能显示、断流 reload 修不好」）：

**回归根因**：0x0121 的 Document Layer 子树判据在**画布上作笔时恒失败**
（46 条未显示里 11 次 why=4 全在作笔中，gate/toolOk/penDown/stroke/ctU/fg 全绿）。
Document Layer（OWL.WindowGroup, **vis=0**）是 OWL「层」概念窗，画布视图不在其下。

**判据反转依据**（全景转储地面真相）：OWL.Dock / OWL.WindowGroup×3 /
OWL.ShadowView / PSFloatC / PSToolTip / ComboLBox 全是**独立顶层窗口**；
画布窗从不在顶层枚举 ⇒ 画布必在主框子树内 ⇒ 改判
`hit==s_psFrame ∨ IsChild(s_psFrame, hit)`（hit==NULL 放过）。why=4 时 2s 限流打
hit 类名/标题（`焦点门·挡:` 行）⇒ 判据再错一轮按类名修对。

**断流叙事修正**：`[pk] 真实包` / `[dead]` / `[stall]` 冻结判据都只看真实驱动包
（g_pkReal，`if(!synth)` 才计）⇒ **补流救场期这些行照打「平滑实质中断」——
是假话**。jwwh-38216 三段停摆期补流实喂 134 包/2.1s 而日志零字段可证。
0x0122 给 [stall]/[dead]持续中 补 `syn=`（g_synWas）：syn=1=救场中（体感断流若仍在
⇒ 几何层：陈旧回包追赶/HUD deadHide），syn=0=武装链真断。

**pi8li.log 零 penSmooth 留痕 = 面板一次都没推参数**（22:32 全 Session；22:33:11
WS 断开重连=用户 reload 后也无重放）⇒ 引擎 g_pen 保持默认（radius 恒 40）。
「调参不生效」下一轮判据：无行=面板没发（!penOn 早退/WS 断）——**先查面板侧**。

⚠️ 环境坑（新）：WorkBuddy 沙箱 shell（即使 High IL）EnumWindows 看不到 PS 窗口、
.NET MainWindowHandle 也拿不到（UIPI/桌面隔离）⇒ **窗口结构真相只能靠引擎进程内
日志**，外部探针（ctypes/PS 工具）全部走不通，别再浪费时间。

## O16. 0x0123（2026-10-17 23:20）：**断流「永久化」的唯一真凶 = dead_relay_probe()**（已整段删除）

> 样本：`jwwh-9616.log`（0x0122 部署后首场，用户报「前三笔正常、第四笔起断流、
> reload 不恢复」）。✅ 已实施并构建核验（零告警 + PiPL 往返 + `mov eax,0x123`），
> ⛔ 未部署（PS 运行中锁文件）。

**证据链（时间分界线精确到毫秒）**：
| 时刻 | 事件 |
| --- | --- |
| 22:58:39.241 | [stall] 515ms → 22:58:40.031 恢复（1.3s，正常） |
| 22:58:52.041 | [stall] → 52.306 恢复（0.8s，正常） |
| 22:58:59.108 | [stall] → 59.639 恢复（1.1s，正常） |
| 22:59:00.947 | [stall] → 02.251 恢复（1.8s，正常） |
| **22:59:14.343** | **`dead_relay_probe()`：WTOpenA 出 0x803 → WTOverlap 推顶 → 8×40ms 读包** |
| 22:59:14.722 | `WTClose(0x803) ret=1`（[relay] 判读「通路活着」，实际只读到 1 包 x=0 y=0） |
| **22:59:21.546** | [stall] 起，此后 `真实包=0`、`peek=0`、`单包=0` 持续到卸载 |
| 23:01:26.723 | 卸载（用户 reload）—— **105 秒内零真实包** |

**机制**：`WTOverlap(hc, TRUE)` 把外来上下文推到 Wintab 重叠序顶层并占用 ~320ms；
`WTClose` 之后 Wacom 驱动**没有把 PS 的 0x802 推回顶层** ⇒ PS 上下文被永久饿死。
`peek=0` 是关键判据：队列是**空**的（驱动根本不排包），不是溢出（满）。
这是驱动内部状态，**reload 插件不可能修好** —— 与用户观察完全一致（此前的
「永久冻结」以及「reload 修不好」全部由此解释）。

**0x0123 动作**：删除 `dead_relay_probe()` / `g_relayProbeDone` / `probe_pick_cb` /
`probe_pick_hwnd`；worker 里 `if (nowW - s_dead0 > 2000) dead_relay_probe();` 一并删除；
`[dead]` 文案去掉「插件自建上下文同样读包=0」（已不成立）。
**⛔ 铁律扩充**：断流期对本进程外的 Wintab 状态**只读**（WTPacketsGet 转发 /
WTPacketsPeek 只读）；**任何**会改变重叠序归属的实验（WTOpen / WTClose / WTOverlap /
WTEnable）都不得进主流程，哪怕「每进程只做一次」。

**未动**：补流几何（`penraw_synth`）一行未改。若 0x0123 仍有体感断流，判据顺序是：
`补流=` 计数在涨 + `syn=1` ⇒ 合成包在喂但 PS 不买账 ⇒ 查映射残差 / 模板字段，
继续查进程内，**不要再碰驱动**。

## O17. 0x0124（2026-10-17 23:55）：「断流」= **平滑失效（硬线）**，不是没笔迹 —— 接触判据把轻压判成悬空

> 样本：`jwwh-36348.log`（0x0123 部署后首场，933 行）。**用户定性（本轮最关键的一句）**：
> 「画出来选区是没平滑的硬线，同时 HUD 以错误形态显示（受力点与施力点重合）」
> 「断流前刚碰过面板/工具栏/其它窗口」。⇒ 前六轮全按「笔迹不出」排查，方向错。

**先确认 0x0123 的成绩**（别再回头改）：探针删除**生效** —— 全程 `open=0 close=0`、
零 `[relay]` 行、5 次停摆（5.2/8.4/1.3/9.7/15s）**全部自愈**，105s 永久断流不再出现。

**真凶（本项目自己的判据就写着）**：`[ct] 连续全零` >20 包 = 判据在真实运笔中成段失效。
真机实录 **90 / 39 / 121 包**（≈450~600ms @200Hz），紧跟在「碰面板/切窗口」之后的
驱动停摆（O12 已实锤：驱动只给焦点窗口派包）附近。链条：
1. `contact_update` 三信号（btn/np/tp）成段全零 → 250ms 保持到期 → `g_contact=0`；
2. 闸门② `if (!down) { g_wasEnabled=0; snapshot_only(); return 0; }`
   ⇒ **整批原样放行** ⇒ 输出点 = 笔尖 ⇒ **硬线**；
3. 同时 `g_wasEnabled=0` ⇒ 下一包 `RST_ANCHOR` ⇒ 拉绳死区重新灌满；
4. HUD 吃同一个 `g_penDown`，`snapshot_only` 又把 out 写成 raw ⇒ **受力点==施力点**。

**0x0124 四项**：
① 接触判据**拆两个窗口**：`g_contact` 250ms（HUD/面板/落笔角标，手感不变）+
   `g_contactSmooth` **800ms**（只决定「坐标改不改」）。依据 = 实测最长零段 600ms ×1.3。
   ⛔ 抬笔后多撑 550ms **无可见副作用**：PS 自己不画，我们改的只是它用不到的坐标。
② `g_wasHover` **边沿锚定**：长闩会把 `g_wasEnabled` 拖到抬笔 800ms 后仍为 1，
   不补的话「抬笔→立刻落笔」会从上一笔输出点续画（选区线从旧位置硬拽过来）
   ⇒ 悬空→落笔边沿强制 `RST_ANCHOR`（与旧行为逐位等价）。
③ HUD `deadNow` 加 `!g_synWas`：**救场期不藏 HUD**。合成包坐标 = 系统光标 +
   已标定映射，实测 `a=16.000000 b=8`（`cur=(1812,1257)` ↔ `raw=(28998,41326)`），
   合成包坐标比停摆前快照**更新**，藏圈才是误导（且体感就是断流）。
④ 每笔台账 `# [stroke] 笔收尾: 时长/包/改写/复位/悬空批/末段全零/半径/模式`
   —— detour 内零 I/O，只搬原子槽，worker 250ms 落盘。
   **判据**：`复位>1` = 笔中被复位（硬线直接来源）；`悬空批>0` = 轻压零段真的发生
   且被新长闩接住；`末段全零` >20 包 = 收笔时判据仍失效。

**未解**：末段 42.162→57 的 15s 停摆里 `[ct]` 全绿（连续全零=0）、`[why] reason=0`
⇒ 那一程塌陷与闸门无关，只剩「合成包 64Hz 粗糙 + HUD 被藏」。HUD 已修；
64Hz 是 PS 每拍只取 1~2 包的硬上限（`penraw_synth` 超出即丢），本轮未动。
⚠️ `WTPacketsPeek` 由 worker 线程调用，而 Wintab 上下文有**线程亲和**（非 owner
线程读不到队列）⇒ 日志里 `peek=0` **不能**证明驱动队列为空，0x0123 的定案依据
只用「WTClose 后 105s 零包」那一条，勿再引用 peek。

## O18. 0x0125（2026-10-18 07:20）：修 0x0124 的倒退 —— `g_wasHover` 同批置位同批消费，整笔又变硬线

> 样本：`jwwh-12388.log`（0x0124 首场，870 行）。用户报：断流发生率仍高；
> 「点开平滑开关后连画三笔全断，后面恢复几笔又断；没点 reload 也见过自己恢复」。

**0x0124 判对了什么**：接触判据的确是硬线来源；`[stroke]` 台账一次就把话说清了。

**0x0124 判错了什么（本轮教训）**：`g_wasHover` 在 `contact_update` 之后**同一批**
就置位，而循环里第一包立刻 `InterlockedExchange` 消费 ⇒ 短闩（250ms）每垂一拍
= 一次锚定 = 输出点拽回笔尖。台账实录 **复位 19~173 / 笔**，`[status] rst=1471/0/2`
（全是 anchor）⇒ 800ms 长闩被抵消，硬线照旧。

| 笔 | 时长 | 包 | 改写 | 复位 | 悬空批 | 末段全零 |
| --- | --- | --- | --- | --- | --- | --- |
| #1 | 4094ms | 657 | 607 | 49 | 48 | 102 包 |
| #2 | 6984ms | 560 | 451 | 109 | 105 | 162 包 |
| #3 | 18015ms | 1997 | 1801 | 173 | 168 | 160 包 |
| #14 | 2813ms | 566 | 463 | 103 | 101 | 161 包 |

**0x0125 三改**：
1. 删 `g_wasHover`。起笔锚定回归 `!downS`（长闩过期）⇒ `g_wasEnabled=0`；另加
   **位移门** `hoverEdge && distPx > 4×radiusPxF` ⇒ 另起一笔。
   依据：长闩在撑时，运笔零段恢复的位移 ≈ 绳长（56px）；真实抬笔移位几十上百 px。
   ⛔ 旧 `RST_JUMP` 门限 = `0.15·axMax·px ≈ 1350px`，接不住抬笔移位（本场 jump 只 2 次）。
2. 长闩 `CONTACT_HOLD_SMOOTH_MS` 800 → **1500ms**（抬笔零段实测 1.0~1.5s）。
3. 台账 `复位=N(锚a/gap g/jump j)` + `最长全零`（全程最大值）。
   **下一轮判据**：`复位` 应降到 ~1~3/笔；`最长全零` >20 包且笔仍是硬线 ⇒ 零段超过
   1500ms，继续抬 `CONTACT_HOLD_SMOOTH_MS`；`最长全零` 很小 ⇒ 硬线与接触判据无关，
   转向「复位/绳长/闸门①」。

**未解 · 加载后 41.5s 零包**：`[stall] 停摆 41469ms`（07:18:08.65→07:18:49.60），
期间 `state=0 packets=0 calib=否`、PS 轮询 8852 次、光标在全屏范围移动。
历史每场都有 20~41s 的同类窗口（20.5/21.2/25.6/25.6/30.8/32.4/41.5s），
此前判成「笔不在板上」——本场光标横跨全屏，该解释不成立。
若再现且用户确认在用笔 ⇒ 怀疑**挂载本身**（freeze_threads 152~223 线程 + 5 个钩）
掐死 Wintab 一段时间；对照实验：延迟挂载 / 只挂主钩不挂 WTInfo 诊断钩。
⚠️ 读日志时 `[status] state` 与 `[why] reason` 必须一起看：`state=0` = 根本没在改写，
此时 `reason=0(改写中)` 是 0x0125 才修掉的假话（初值改 `RS_NOCAL`）。

## O19. 0x0126（2026-10-18 07:40）：**补流喂包 PS 却不画的根因 = 合成包 pkChanged 写成 0**

> 样本：`jwwh-2024.log`（0x0125 首场）。用户报：10 几笔仍大部分断流 + **新 BUG 悬空时 HUD
> 冒出几秒再消失**。另确认：日志开头 40s 是 PS 开屏动画 + 笔还没拿起来（**不是挂载问题**，
> 撤回 O18 的怀疑）。

**0x0125 确认有效**：`复位=1~2/笔`（0x0124 为 49~173）、`rst` 只剩 1~2 次 anchor/笔、
`改写/包=99.7%` ⇒ **锚定 churn 这条线彻底结案，别再回头动它**。

**决定性证据（判据从此固定为「停摆窗口里 PS 的取包速率」）**：
| 时刻 | PS取包次/2s | 含义 |
| --- | --- | --- |
| 07:30:08 | 2472 | 绘画中 |
| 07:30:12 | **162** | 停摆中 = **空闲速率**，PS 已退出绘制循环 |
| 07:30:14 | **161** | 我方每拍都返回合成包，PS 仍不画 |
| 07:30:18 | 2550 | 真实包回来，立刻恢复 |

**根因**：`penraw_synth` 把 `pkChanged`（offset 4）**强制写 0**。pkChanged 的语义是
「本包相对上一包变了哪些字段」，写 0 = 告诉读包方「什么都没变」⇒ PS 不把该包当作
绘制输入。反证：`smooth_packets` 改写真包 x/y 时**从不碰** pkChanged（保留驱动的非零值），
而平滑一直有效 —— 两者唯一的字段级差别就是它。
（⚠️ 之前我一度用「平滑改 x/y 不动 pkChanged 但平滑有效」反证「PS 不看 pkChanged」，
那条推理错在：**平滑是保留非零值，合成是清零**，两种情况的 pkChanged 取值不同。）

**0x0126 改动**：
1. `pkChanged = 底本值 | 0x5D4`（PK_TIME|SERIAL_NUMBER|BUTTONS|X|Y|NORMAL_PRESSURE），
   底本为 0 时退 `0x1FFC`（= PS 订阅的轴掩码）。
2. HUD 增 `realOk`（`g_lastRealMs` ≤ `HUD_REAL_MS=400ms`）—— **合成包不负责点亮 HUD**。
   修用户第 3 条新 BUG（悬空时 HUD 冒出几秒）：断流中抬笔没有真实包来报 0，
   合成包 sticky tip 把我方判据喂成落笔。HUD 是视觉承诺，只能建立在真实证据上。
3. `cursamp_thread` tip 回退链加「最后真实包 + CONTACT_HOLD_SMOOTH_MS(1500ms)」上限。
4. 台账 `最长全零` 跳过本笔第一批（0x0125 把它记成 599 包 = 起笔前的悬空）。
5. `[hud] 未显示` 行补 `real=NNNms`，直接看出是否被 realOk 挡住。

**下一轮唯一判据**：停摆窗口里的 `PS取包次`。
· 回升到 500+/2s ⇒ pkChanged 就是那把锁，补流从此能续笔，收工。
· 仍是 ~160/2s ⇒ PS 真的退出了画笔循环（收到 tip=1 的包也不会重开一笔），
  进程内无法续笔 ⇒ 只剩「阻止驱动停摆」一条路（那要另立项：驱动/焦点派包）。

## O20. 0x0127（2026-10-18 07:52）：pkChanged 不是锁；序号倒退成第二嫌疑 + WTOpenW 只读钩

> 样本：`jwwh-5204.log`（无 yarn watch）+ `jwwh-30328.log`（有 yarn watch），**均 0x0126**，
> 用户均报「全部断流」⇒ 与面板构建无关，纯引擎侧。

**0x0126 的 pkChanged 改动被证伪（至少不充分）**：停摆期 PS 取包速率仍掉到空闲
（5204 141/143/134；30328 147/145/142/134 次/2s），同理补流每 2s 涨 ~130 包
（65/s，与 PS 67 次/2s 一一对应）⇒ **包确实送到了 PS 手里，PS 仍然不画**。

**第二嫌疑：`pkSerialNumber` 倒退**。本项目自己的标定就用「序号逐包 +1」当硬判据
（`try_calibrate ③`）⇒ 真包序号严格递增、步长 1；而合成包原先用独立计数器从 1 起算
⇒ 在 PS 眼里是「序号倒退十几万」。若 PS 按序号判新/判重（这正是该字段唯一的用途），
整批合成包会被丢弃。0x0127 改为「先跟上底本序号，再 +1」。

**新增 WTOpenW 只读钩**（历史 `open=0` = 我们只挂了 A 版，PS 用 W 版，一次没被调用）：
读 PS 自己那份 LOGCONTEXTW —— `lcOptions`（★`CXO_MESSAGES=0x4`）、`lcMsgBase`、
`lcPktData`、`lcInExt/lcOutExt`、`lcBtnDn/UpMask`。
判读：**opt 带 CXO_MESSAGES ⇒ PS 是消息驱动**，停摆期没有 WT_PACKET 消息它就不会来取包
（「取包速率掉到空闲」的第二种解释），且可解：我方在补流期间向 PS 的画布窗口补发
`lcMsgBase + 0`（WT_PACKET）消息把它叫醒。⛔ 本钩只读，不改 LOGCONTEXT 一个字节。
LOGCONTEXTW 偏移（相对 A 版 +40）：options 80 / status 84 / locks 88 / msgBase 92 /
device 96 / rate 100 / pktData 104 / pktMode 108 / move 112 / dn 116 / up 120 /
inOrg 124.. / inExt 136.. / outOrg 148.. / outExt 160..

**台账再升级（把观感变成数字）**：`平均滞后=x.xpx`、`贴笔=N%`（滞后<3px = 硬线包）、
`死区=N%`（绳没绷紧，本包输出没动）。
**判读口径**：`贴笔%` > 30 ⇒ 用户说的「硬线」属实且可量化；< 10 且 `平均滞后≈绳长` ⇒
引擎这侧没问题，嫌疑转向 PS 侧（未采用我方坐标 / 画笔循环退出）。

**两次会话其它事实**：`改写/包≈99.7%`、`复位=1~3（全 anchor）`、`半径=69px`（用户调大）、
HUD `off` 12 次采样里 3 次为 0（输出压在笔尖上 ⇒ 那几刻是硬线形态）。

## O21. 0x0128（2026-10-18 08:00）：**PS 的 Wintab 上下文是消息驱动（CXO_MESSAGES）⇒ 补流必须代投 WT_PACKET**

> 样本：`jwwh-28756.log`（0x0127 首场）。用户报仍全断流，并提示「断流后拿笔**悬空**乱挥等恢复」。

**一、引擎侧结案（0x0127 台账判的）**：`贴笔=0~3%`、`平均滞后=54.9~83.5px ≈ 绳长`、
`死区=12~71%` ⇒ 写出的坐标确实带整段绳长滞后。**「没平滑」不可能出自平滑数学**，
别再回来改滤波/闸门。`死区` 高（绳没绷紧、输出不动）是半径 69（绳 104px）偏大的参数问题。

**二、机制（本轮定案）**：`[ctx] WTOpenW hCtx=0x802 opt=0x801D ★CXO_MESSAGES msgBase=0x7FF0`
⇒ PS 的画布**不轮询**，只在收到驱动投递的 `WT_PACKET`（msgBase+0，0x7FF0）时才去
`WTPacketsGet` 并重绘。驱动停投递 ⇒ PS 只剩空闲定时器（实测 134~147 次/2s）⇒
**我方合成包堆着没人读**。这一条同时解释了：0x0126 改 pkChanged 无效（PS 根本没来取）、
「补流计数照涨但 PS 不画」、「真实包一回来立刻恢复」（驱动重新投递消息）。

**三、0x0128 改法**：补流期间由 `cursamp_thread`（250Hz，**不在 detour**，可安全调 Win32）
代 `PostMessageW(hwnd, msgBase, hCtx, serial)` 补发 WT_PACKET，节流 ~62Hz（与 PS 空闲
67 次/s 同量级，单队列上限 1 万条）。`WTOpenW` 钩里捕获 hwnd / lcMsgBase / lcOptions（只读）。
⛔ 只在 `tip=1` 时补发：悬空挥手不投，避免幽灵笔画。
⛔ 内建副作用：断流中**抬笔后最长 1500ms** 内仍会补发 ⇒ 可能多画一小段跟着手走的线。
   **这反而是「桥在工作」的可判据现象**，让用户据此反馈。

**四、硬限制（回答用户「能不能从日志看出我在悬空乱挥」）**：
能看出**笔在动**（`[dead]` 的 `Δ累计px` 持续增长），但**看不出是悬空还是落笔** ——
断流期没有真实包，`[gate] penDown 1→0` 的时间点恰好等于 sticky tip 的 1500ms 到期，
不是识别到抬笔。若下一轮仍然要靠 tip，可加 `WTInfoA(WTI_STATUS=2, hCtx, &st)` 只读探针
（STATUS.status 的 WT_STATUS_INOMPROXIMITY / PRESSED 位）来获得断流期真实接触态。

**下一轮判据**：`[dead] 持续中` 的 `补发=` 增长 + 停摆期 `PS取包次` 从 ~140 跳到 500+。

## O22. 0x0128 对照实验（2026-10-18 08:30）：**停摆的真正变量 = LNP 在不在环，不是引擎代码版本**

> 样本（同机、同 PS 27.11.0、同 Wacom 驱动 6.4.15-1、同一天、同 0x0128 二进制、同 wtctx 无 ini、同上下文参数 0x802/opt=0x801D/pktData=0x1FFC）：
> - `jwwh-3336`（0x0127，无 LNP）：[dead] 断流 6.8s/13.9s/1.0s+，冲包 54/45
> - `jwwh-19848`（0x0128，无 LNP）：[dead] 5.7s/4.7s/2.5s+，冲包 42/20；**约每 1~2 笔一次**
> - `jwwh-31980`（0x0128，**LNP 启动进驻后关闭**）：12+ 笔 / 19s 连续运笔 **0 次 [stall]/[dead]**
>
> 31980 唯一一次 dead 在 08:28:59 结尾 = **PS 失前台**（光标移到副屏 Chrome x=4281，`焦点门·挡 Chrome_RenderWidgetHostHWND`）⇒ O10/0x0117 已定性的焦点门控派包，不是神秘停摆；且此后 PS 再没回前台（用户直接关 PS）。

**LNP 侧实证（`%LOCALAPPDATA%\Lazy Nezumi Pro\logs\log_photoshop.txt`，t0=PS 启动）**：
- 00:00:00.4 以 **PS 插件形态进驻**（MouseHookPro64.8li v26.10.14.1720，psPlugin:1，PID 0x7CEC=31980），hooked Wintab32；设备 = **WACOM Tablet**（WintabDLL 1.0.5-10 / driver 6.4.15-1）
- 00:00:01.1 hookedWTInfoW WTI_DEFSYSCTX（DPI 侦测）；**PS 开上下文 0x802 时（引擎 [ctx] WTOpenW）LNP 钩子已在链上**
- 00:00:14.25 用户关 LNP：`Going to sleep` + `Overlay disabled`（ini 落盘 08:28:38 吻合）⇒ **钩子不卸载，活到 PS 退出**（00:00:58.8 shutdown）
- 00:00:16.1 首包到达，LNP 在 **PS 的上下文 0x802** 上 `initContextA`（搭车读取；全场无 WTClose ⇒ 0x802 全程属 PS）；同帧 dump：lcPktRate=200、pktData=0x1FFC、**lcLocks=0x0**、Packet size=52
- 其它：`ForceWacomMouseToPen: 1`、`PSJitterBugfix=true`、`WinInkPenLagFix=false`

**结论**：0x0116「看起来 OK」是 LNP 的功劳（10/16 23:26 装 LNP 26.10；0x0113 的 LNP 迁移轮次本身就在跑 LNP 取日志）。LNP 出环后，底层一直存在的驱动侧停摆浮出水面 ⇒ 0x0117~0x0128 修的都是真 bug（DETACH 四连崩/补流假交还/接触判据/pkChanged/序号/CXO_MESSAGES 桥），但**没有一个碰到这个变量**，所以表现为「毫无进展」。⛔ **断流排查第一问：LNP 在不在环。**

**机制（分层，确证度递减）**：
1. （已证）停摆本体 = Wacom 驱动侧派送停摆：自建上下文同样 0 包 + WTOverlap 恒 1 + 恢复冲包≈队列容量；进程内写杠杆（第八/九/十轮 + 0x0123 探针事故）全部证伪 ⇒ 引擎修不动。（⚠️ O17 起 `peek=0` 因线程亲和不可作证据。）
2. （已证）LNP 改的是 **Wintab 派送层配置/路径**，不是平滑质量——关 UI（sleep）后效果仍在 ⇒ 排除「LNP 平滑更好所以好看」。
3. （推断，与 LNP 迁移笔记一致）持久项 = WTOpen 链清 lcLocks(CXL_SYSOUT)（本场 0x0 未触发）+ **WTQueueSizeSet 扩驱动队列** + 留钩在排包路径 + ForceWacomMouseToPen（Wacom 驱动级）。佐证：旧会话 `jwwh-9304` 冲包 ~125/127 ≈ **128 = WTQueueSizeGet 实测量**（队列被扩容过），新无 LNP 会话冲包仅 20~54（默认）⇒ 两个时代队列配置不同。
4. （未定死）31980 同时含「持久配置」与「活钩子」两个变量，尚未分离。

**下一步（按序）**：
① 无 LNP，`wtctx.ini` 写 `queueSize=128`（引擎 ⑥ 已实现，会打 `[ctx] ⑥ WTQueueSizeSet` 日志）⇒ 一枪验证队列假设；
② `WTOpenW` 钩日志加 `WTQueueSizeGet` 实测量（每会话记录真实队列容量，旧 128 vs 新默认立刻变证据）；
③ 分离实验：LNP 进驻启动 PS 后从托盘**彻底退出**（确认 log_photoshop.txt 出现 shutdown / MouseHookPro64 不在 PS 进程）再画：仍干净 ⇒ 持久配置是主因；断流回来 ⇒ 活钩子是主因；
④ 代码侧与 LNP 无关的真洞：无 LNP 两场 `[dead]` 有 `syn=0`（补流未武装 ⇒ 平滑实质中断）⇒ 武装判据提前（停摆签名一出现就武装，不等接管条件全集齐）；
⑤ 要彻底定死 LNP 的写动作：REA+Ghidra 逆 MouseHookPro64.dll 26.10 的 Wintab 路径（WTQueueSizeSet/WTEnable/WTOverlap/Wacom 私有调用）。

**与 O21 的关系**（兼容而非互斥）：O21 定案「PS 消息驱动、驱动停投递 WT_PACKET ⇒ PS 退出绘制循环」是停摆的*直接*机制；O22 定案「LNP 驻扎让驱动不停摆」是*触发条件*层。0x0128 的补发桥解决「PS 不来取」的一半，O22 解决「驱动为何停」的一半。

---

## O23（2026-10-18，0x0129）：queueSize 复测无效之谜 + LNP 逆向定案

### ① jwwh-5288（用户按指引建 wtctx.ini queueSize=128 复测）：**测试无效**

日志第 2 行 `[wtctx] ... queueSize=128` 确认读到、WTOpenW hCtx=0x802 成功，但**全场无
`⑥ WTQueueSizeSet` 行**。根因：⑥ 的代码块只挂在 `det_WTOpenA` 里，而 PS 一直走
**WTOpenW**（历次日志 open=0）⇒ 扩容一次都没执行。修法（0x0129）：抽成
`wtctx_post_open(HCTX)`，A/W 两入口都调；新增 ⑦ `WTQueueSizeGet` 实测量（无开关也打，
每会话留存真实队列容量）。判据更新：以后看到 `⑦ WTQueueSizeGet(hCtx=0x802) = N` 才是真容量。

### ② syn=0 根因（jwwh-5288）：解析映射准入线坐在噪声带里

拟合全程卡跨度（小笔画保留集跨度 191/661 < `RI_FIT_MIN_SPAN=1000`，设计如此）；解析卡
残差（52.1 > 48）——而同场**错映射**量级是 840/1073（陈旧冲包污染拍），42~128 分明是
运笔时间错位噪声（raw 光标 64Hz vs wintab 包 ~66Hz，0x0119 已为拟合认过同笔账）。
⇒ `RI_ANA_MAX_RMS` 48→**96**、`RI_ANA_OFF_RMS` 96→**160**（0x0129）。按该场回放：
09:03:09 即可武装 ⇒ 09:03:16.5 的 [dead] 将是 syn=1 + 补流接管 + WT_PACKET 补发。

### ③ REA+Ghidra 逆 MouseHookPro64.8li 26.10.14.1720（完整取证见 analysis/lnp/RE-findings.md）

- **O22 第 3 条的「WTQueueSizeSet 扩队列」作废**：init（FUN_18002f860）里
  WTQueueSizeSet/WTEnable/WTOverlap/WTQueuePacketsEx/WTPacketsPeek/WTDataGet/WTSetW
  的 GetProcAddress **结果被丢弃**（字节级：call 后无 `mov [rip],rax`；全二进制仅一处
  引用该字符串）⇒ LNP 根本不调用它们。jwwh-9304 的 128 另有原因或假设本就不确。
- 钩子登记表（FUN_18003b730 → FUN_1800313d0 统一 E9 安装）：基础 17 项 + 按配置追加
  {WTPacket, WTPacketsGet, GetCursorPos}。已反编：`hookedWTOpenA/W`（lcLocks 带 0x10 时
  **整个字段清零** `*(u32*)(ctx+0x58)=0`，日志串 "CXL_SYSOUT lock present! Unsetting."）、
  `hookedWTInfoW`（DPI 修复）、WTPacket 钩子（旁路喂包 FUN_18005a500，返回值原样）、
  **WTPacketsGet 钩子（先排干真队列，再用 FUN_18005a0d0 替换 buf 内容与返回值 ⇒ 平滑注入点）**。
- **31980 决定性对照**：我方真实包持续 94~202/s（驱动自己没停）；LNP 自带日志证明该场
  **上下文钩子双空转**（无 CXL_SYSOUT 警告 ⇒ lcLocks 不带 0x10；lcSys==vrect ⇒ 无 DPI 差）
  ⇒ 救命的是**包路径交互**，不是上下文改写。O22 的「清 lcLocks / 扩队列」在该场均未生效。

### ④ 下一步（更新）

1. 装 0x0128→0x0129（用户构建/部署），无 LNP 重画同一套笔画：看 `⑦ WTQueueSizeGet` 实测量 +
   `syn=` 是否转 1 + `[dead]` 是否消失/被补流接住；
2. queueSize=128 现在会真执行了（⑥ 修好）——作为受控变量再测一轮（期望：不断也证明不了
   LNP 机制，但能量化队列容量对恢复冲包的影响）；
3. LNP 的哪个包路径动作让驱动不停摆仍未定死（候选：WTPacketsGet 替换使 PS 不再直接消费
   驱动队列；消息循环改变时序避开驱动 bug）——需带 LNP 对照实验或驱动层深挖；
4. 我方 ④ clearLocks=1 只清 0x10、LNP 是全零；若重启 lcLocks 线索需先确认当场 PS 的
   lcLocks 带不带 0x10（31980 不带）。

---

## O24（2026-10-18 上午，0x012A）：落笔瞬间「受力点与施力点分离」= 起笔锚定从不落在真落笔包上

用户报（jwwh-5912，LNP 在环、平滑生效前提下）：「红虚线圈里的折线不是我画的 —— 按理落笔时
选区边缘长度为 0、圆心（受力点）应与施力点重合，实际却差一个**圆半径内的不固定值**，位置与
偏移似乎与落笔时轻微位移有关；于是一移动，落笔点就瞬间向那个偏移的受力点画出这段折线，然后
再从偏移点出发画平滑选区。」

### ① 两场日志先结算旧账

| 日志 | LNP | [dead] | syn=1 | 备注 |
| --- | --- | --- | --- | --- |
| jwwh-9316 | 无 | 18 | 15/20 | 0x0129 的 RI_ANA 96 门槛生效 ⇒ 补流已武装，但停摆照旧 ⇒ 与 O22「根因在派送层」一致 |
| jwwh-5912 | 有 | 13 | 15/17 | 平滑生效；⑥ `WTQueueSizeSet(128) ⇒ 1（实测原容量 50）` |

- **0x0129 的 A/W 共用修复实证生效**：queueSize=128 这次真执行了；原容量 **50** 与历次恢复
  冲包 20~54 逐发吻合 ⇒ 「队列容量 ≈ 冲包量」从反推变成日志直证。
- queueSize=128 仍未治断流（9316 照断）⇒ 与 RE 结论（LNP 不调 WTQueueSizeSet）自洽。

### ② 根因（机制层）：两条起笔锚定路都不落在真正的落笔包上

1. **场景 A**：`!g_wasEnabled` 锚在「整批第一个包」——落笔边沿落在一批中段时，第一个包还是
   **悬空包** ⇒ 锚到悬空位，偏移 = 落笔瞬间那点位移（用户原话「圆半径内不固定值、与落笔时
   轻微位移有关」逐字吻合）。
2. **场景 F（主形态）**：1500ms 长闩一直撑着 `g_wasEnabled` ⇒ **<1.5s 的「抬笔→再落笔」
   根本不锚** ⇒ 输出点还停在悬空跟随的位置，最多差整整一根绳。
   jwwh-5912 实证：`[gate] penDown 0→1` 间隔低至 **0.26s/0.5s**（用户连续画圆、圆距 <1.5s），
   三个台账各跨多次起笔（悬空批=80/954/792）而复位仅 1~2 次/台账 ⇒ 长闩把多次真起笔并成了
   一条「笔」。
   （悬空批 = 圆与圆之间的真悬空被长闩桥接；笔中 buttons 保持 1 —— 与 PS 路径不中断一致。）

### ③ 修复（0x012A）：buttons 逐包 0→1 边沿 = 唯一的起笔锚定权威

- **为什么是 buttons**：它是 **PS 自己用来起/收套索路径的字段**（我们从不改写它，PS 读到的与
  驱动逐字节一致）⇒ 它的 0→1 边沿就是 PS 的路径边界。在那里把输出点钉到**本包原始坐标**，
  选区就从落笔点起画 = 用户要求的「边缘长度为 0、受力点与施力点重合」。
- 标定实证（5912）：`btn=16 z=28 np=32 tp=36`，src=1 掩码+数据双证据；buttons 取掩码 0x07
  低三位（高位是 cursor number，某些驱动填常量）。
- **带去抖**：连续 buttons=0 不足 `BTN_EDGE_MIN_ZERO=8` 包（≈40ms@205Hz）不当真抬笔 —— 防
  电子弹跳/掉样本；真抬笔（physically 离纸再落下）不可能短于几十 ms。
- ⛔ **为什么不盯 np/tp 边沿**：0x0124 教训 —— np/tp 轻压下成段掉零，盯它们等于每记掉零恢复
  都拽一次输出点，整笔退回硬线；且 buttons 在 np/tp 掉零时保持 1（多信号并联后 np/tp 掉零
  被 buttons 覆盖，5912 全场笔中无 >250ms 接触缺口可证）。
- ⛔ **buttons 不可用则机制整体静默**（s_ctBtnIdx=-1，行为同 0x0129，不赌）。
- 边沿状态机：`s_prevBtn`/`s_btnZero` 跨批保持；闸门关（非套索）/长闩过期（!downS）/信号表
  重建三处复位成「已抬升」⇒ 下一个 buttons=1 包即边沿。
- 台账 `复位` 加 `落` 计数（g_lgRP/g_rstPenDown，[status] rst=a/g/j/p）：**每笔正常 =1**；
  =0 ⇒ 边沿没抓到（偏移会原样复现）；>1 ⇒ buttons 笔中抖动（去抖失灵）。
- hoverEdge 4×绳长位移门（0x0125）退化为 buttons 不可用时的兜底，目的相同判据不同。

### ④ 验证与下一轮判据

build.sh 零告警 + PiPL 往返一致 + 导出表 `mov eax,0x12A` PASS + 已部署 Plug-ins（0x129→0x12A）。
下一轮：① 台账每笔 `落=1`（=0 ⇒ 修复没生效，查 buttons 投票权）；② 落笔瞬间 HUD 圆心与笔尖
重合、无起始折线；③ 运笔中 `落` 不 >1（>1 ⇒ 抬 BTN_EDGE_MIN_ZERO）；④ 圆距 <1.5s 连续起笔
时每圆都从落笔点起画（用户原用例）。

---

## O25 · 0x012B：长停摆中途「补流自己先断了」+ LNP 在环仍停摆（2026-10-18）

用户验收 0x012A（`jwwh-20708.log`，18 笔）原话：「这次前几次画笔效果很好，我一度以为要成了，
但是后几笔就稳不住开始断流了。」结论：**落笔锚定修复本身生效**（`落` 每笔 1~16 次，共 18 笔
逐笔都有），坏掉的是**补流桥自己**。

### ① 停摆判据与时序

判据 = 包冻结 **且** 系统光标仍在动（排除「用户真的停手」）。本场 3 次真停摆：
`2361ms`（2.36s）、`3951ms`（3.95s）、`9703ms`（>9.7s，直到日志结束仍未恢复）。

### ② 根因：tip 断言窗口 1500ms 到期 ⇒ 不再代投 WT_PACKET ⇒ PS 消息循环下线

关键证据 = `补发=` **固定冻结**而非缓慢增长：

| 时刻 | 补发 | 说明 |
| --- | --- | --- |
| 2641ms | 51 | 第一次停摆结束后的值 |
| 3422ms~9703ms | 142（恒定） | 第二次停摆起就不再动 |

机制链：`cursamp_thread` 里 `if (tip && g_ctxHwnd ...)` → tip 来自
`if (realAge <= CONTACT_HOLD_SMOOTH_MS(1500ms))` ⇒ 停摆超过 1.5s 后 tip 归 0 ⇒
不再 `PostMessageW(WT_PACKET)` ⇒ **PS 是消息驱动的**（`opt=0x801D ★CXO_MESSAGES msgBase=0x7FF0`），
没有 WT_PACKET 就退出取包/重绘循环（`[pk]` 真实包=0/s、PS 取包 78~300/2s）⇒
合成包照发但**不重绘** ⇒ 用户看到线冻住 ⇒ 只能抬笔 ⇒ 整笔报废。

最后一次停摆更直接：tip 窗口到期（≈36.07s）与用户抬笔（36.15s）**几乎同刻** —— 用户就是被
冻住的线逼停的（不是他先停手才断）。

### ③ 修复

- `SYNTH_TIP_MAX_MS = 6000`（与接触判据的 `CONTACT_HOLD_SMOOTH_MS=1500` **刻意分开**：
  后者是「笔还在纸上」的判据，前者只是「还敢代投消息」的安全窗）。
- ⛔ 0x0126 的幽灵顾虑已由 `realOk` 独立堵死（HUD 必须 400ms 内有真实包），本窗口只管
  合成包与消息投递。抬笔期的幽灵线再用**三道守卫**收窄：
  1. 光标必须仍在活动文档画布矩形内（`g_canvasOkDbg`）——点到面板/菜单即刻停；
  2. 光标必须**真的移动过**（`s_lastX/Y` 比较）——静止 = 没有新笔画可画，抬笔停住即停；
  3. 本次会话内 VK_LBUTTON 已被证明可用（`g_csBtnOn > 0`）且当前**抬起** ⇒ 停发。
     停摆期我方看不见抬笔（`g_penDown` 卡在 1），①②都拦不住「抬笔后悬空移动」这个
     最常见的放弃形态；笔尖在 Windows 层面就是左键。⛔ 反向安全：`g_csBtnOn` 恒 0
     （该驱动不产生左键）时本条永不生效，退回 ①② 老行为，绝不误杀补流。
- 只每 4 拍投一次（`(++s_tk & 3) == 0`），并只在移动后投，避免停手时刷消息。

### ④ 笔尖映射诊断（0x012B ②）

`[raw]` 增 `btn=状态/on=0→1次数`（`GetAsyncKeyState(VK_LBUTTON)`，**只观测不改写**）。
若 `on ≈ 起笔次数`，说明笔尖在 Windows 眼里就是一个左键 ⇒ 下一版可直接用它做断流期的
**真实落笔证据**，把 6s 补发窗与幽灵风险一并去掉。

### ⑤ ⛔ O22 的重要修正：LNP 在环 ≠ 0 断流

本场 LNP 插件**确在环**（LNP 自己的 `logs/log_photoshop.txt`：11:14:04 随 PS 进驻并建 Wintab
上下文、11:15:44 随 PS 退出），而停摆照旧发生且时长更长（>9.7s）。
⇒ 「LNP 在环 ⇒ 0 断流」（jwwh-31980）**不可复现**。LNP 至多是**概率性缓解**，不能作为方案
依赖；进程内唯一可控的容错手段就是补流桥（本条修的）。

### ⑥ 验证与下一轮判据

build.sh 零告警 + PiPL 往返一致 + 导出表 `mov eax,0x12B` PASS + 已部署 Plug-ins（0x12A→0x12B）。
下一轮：① `补发=` 在长停摆里**持续增长**（冻结 ⇒ 窗口仍不够或守卫误杀）；② `btn=/on=`
次数是否≈起笔次数；③ 线不再中途冻住（用户不必抬笔救）；④ 抬笔后**无**幽灵线残留
（有三道守卫，若仍出现 ⇒ 查 `g_canvasOkDbg` 矩形判据是否过宽、`g_csBtnOn` 是否恒 0）。

---

## O26 · 0x012C：0x012B 的第三道守卫把补发判死（jwwh-6468 全场 `补发=0`）（2026-10-18 下午）

用户反馈：「第一次断流是我用笔调整平滑的半径，之后出现断流，随后我 reload，平滑恢复；期间再次
尝试用笔调半径没有断流，但接着画了几笔后断流再次出现且**没有自愈**。」

### ① 铁证：`补发=` 全场为 0

本场五段停摆（13.9s 启动期 idle / 796ms / 1313ms / 6328ms / 最后一段 1031ms→>13.6s 未恢复），
`[dead] 持续中` 的 `补发=` 恒为 0 —— 补流**一次都没代投过 WT_PACKET**。而 `syn=1`（已武装）、
`补流=1419次/1741包`（合成包确实喂进去了）、PS 轮询 350~550 次/s（PS 确实在取包）。

⇒ 结论：**PS 取到了合成包却没有重绘**，缺的正是「代投 WT_PACKET 把它叫醒」这一步。
（对比 jwwh-20708：补发涨到 142，线就能继续走 —— 说明机制本身成立，是这一版把它关掉了。）

### ② 根因：0x012B 新增的第三道守卫「VK_LBUTTON 已证明可用且当前抬起 ⇒ 停发」

它基于一个看似合理但**错误的前提**——「笔尖在 Windows 里就是一个左键，所以左键抬起=抬笔」。
jwwh-6468 实测把这个前提否掉了：

| 采样时刻 | 引擎判定 | VK_LBUTTON |
| --- | --- | --- |
| 12:06:29.436 | tip=1 penDown=1（笔在纸上） | **btn=1** |
| 12:06:31.519 | tip=1 penDown=1 | **btn=0** |
| 12:06:33.614 | tip=1 penDown=1 | **btn=0** |
| 12:06:35.719 | tip=1 penDown=1 | **btn=0** |

`on`（0→1 次数）一路涨到 **36**，与起笔次数同量级 ⇒ 笔尖**确实**映射成左键、**边沿可靠**；
但 `btn`（电平）在笔明确还按着时成段读 0 ⇒ **电平不可靠**。

机制解释：Wintab 独占时笔尖走 Wintab 按钮通路，驱动的鼠标模拟只**发按下/抬起的边沿**，
不长期保持「左键按下」电平（PS 侧还开着「笔尖不产生鼠标点击」一类选项）。
⇒ 断流期每一拍 `g_csBtnOn>0 && !g_csBtn` 都成立 ⇒ 停发，一次也不投。

**定性（写进铁律）**：左键**电平**不能当「笔还在纸上」的证据；左键**边沿**可以当「起笔」用。
0x012B 想用它消掉 6s 幽灵窗口的计划因此作废。

### ③ 修复（0x012C）

1. **删掉第三道守卫**，只保留 ①光标在活动文档画布内 ②光标真的移动过。
2. **代投目标加固**：`g_ctxHwnd`（WTOpenW 收到的窗口）→ 空则 `s_psFrame`（PS 主框，焦点门
   已实测解析）→ 再空则前台窗口；A 版 WTOpen 也补记目标（lcMsgBase 在 LOCTA +52）。
   主目标不是 `g_ctxHwnd` 时**追加**一条 `PostThreadMessageW` 给该窗口所在线程
   （标准 GetMessage 循环同样会被叫醒；线程消息不会被 DispatchMessage 派给窗口过程 ⇒ 无副作用）。
3. **诊断补齐**（本轮无法从日志区分「hwnd 为空」与「守卫拦死」，必须一次消掉）：
   - `[ctx] WTOpenW ... hwnd=%p`；
   - `[post] ★首个代投: ctxHwnd= psFrame= 用= msg= ret= err= synSerial=`（只打一次）；
   - `[dead] 持续中 ... pre=(tip/syn/hw/cv/btn)` —— 补发仍为 0 时一眼看到哪一项不成立。

### ④ 本场顺带观察（未定性，留待后续）

- 「用笔调半径」现场：12:05:30.087 前台变成 `DroverLord - Window Class`（插件面板），
  12:05:30.212 笔在面板里按下 ⇒ 5 秒后（12:05:35）出现 1313ms 停摆。是否「笔在面板上操作」
  会诱发驱动停摆，本场只有一次样本，**不作结论**。
- 停摆恢复时的冲包量只有 4 包（即使队列已 128）⇒ 驱动停摆期是「暂停投递」而不是「攒一堆」
  （与 O22/O23 的 20~54 冲包量不同，值得下一轮留意）。
- 平滑质量侧数据（非断流）：`平均滞后=78~123px`、`死区 34~74%`、`贴笔 0~4%` —— 半径 56/75/100px
  三档都如此，滞后接近一整根绳，属于「跟手性」范畴的既有形态。

### ⑤ 验证与下一轮判据

build.sh 零告警 + PiPL 往返 + 导出表 `mov eax,0x12C` PASS + 已部署（md5 `949c7c34…`）。
下一轮看三行：
1. `[post] ★首个代投` 是否出现、`ctxHwnd` 是否有值、`ret` 是否为 1；
2. `[dead] 持续中` 的 `补发=` 是否**持续增长**（仍为 0 ⇒ 看同行的 `pre=(…)` 哪一项是 0）；
3. 长停摆中**线是否不再冻住**（用户不必抬笔救）。

---

## O27 · 0x012D：空档在「笔抬着」时开始 ⇒ 整段盲区（jwwh-21032，12 笔）（2026-10-18 下午）

用户原话：「本次测试 12 笔，1-3 正常，4-7 断流，重启后断流自愈，8-12 正常。」

### ① 0x012C 的敲门机制已确认可用

`[post] ★首个代投: ctxHwnd=…1B0F7E psFrame=…1B0F7E 用=…1B0F7E msg=0x7FF0 ret=1 err=0
synSerial=816`（12:43:08.532）—— 目标非空、PostMessageW 返回 1。0x012C 那三样（删第三道
守卫 / 代投目标兜底 / 首投留痕）**全部按预期工作**。

### ② 本场唯一的长时间空白：13.1s 没有一次落笔（其中包流冻结 9.9s）

| 时刻 | 事件 |
| --- | --- |
| 12:43:54.496 | `[gate] penDown 1→0`（用户抬笔，第 10 个落笔周期结束） |
| 12:43:56.9 | 驱动最后一次给包（此后 `零包次` 一路涨） |
| 12:43:57.389 | `[stall] ★包流停摆 ≥531ms：penDown=0 … syn=1` |
| 12:44:06.768 | `[stall] 结束：停摆 9922ms（PS 轮询 1803 次）` |
| 12:44:07.561 | `[gate] penDown 0→1`（下一次成功落笔） |

空档内**同时成立**的四件事（缺一不可地锁死结论）：

| 事实 | 数值 | 含义 |
| --- | --- | --- |
| `零包次` | 735（`真实包=0`） | PS 取包 735 次全部拿到 0 ⇒ 驱动力零输出 |
| `补流` | 127 → 695 次 / 869 包 | 我方一直在喂合成包 |
| `现值=(…,tip=0,…)` | 整段为 0 | 喂进去的全是 **buttons=0 的悬空包** |
| `[dead]` | **一条都没有** | 看门狗（要求 1500ms 内落过笔）也跟着瞎了 |

⇒ PS 只挪光标、不落笔（buttons=0 不会延长套索路径）⇒ 用户连画几笔一笔都出不来、
且**不会自愈**（in-process 没有任何东西能让驱动重新投递）。用户描述的「4-7 断流」
与这 13.1 秒的时长/次数吻合（4 笔 × ~2-3s）。

### ③ 根因：tip 链 100% 依赖包证据 ⇒ 「空档从抬笔开始」= 构造性盲区

空档起点（12:43:56.9）比抬笔（54.5）晚 2.4s ⇒ 断流发生时 `g_penDown=0`、
`g_lastRealTip=0` ⇒ `tip` 恒 0（0x012B 的 6s 窗口也只是"保持"，起点为 0 就没得保持）。
之后用户按下笔尖，**没有任何真包能告诉他 0→1** ⇒ 合成包自称悬空 ⇒ 整段空档报废。
0x012B/0x012C 修的都是「停摆中途补发自己断」，没碰过「停摆开始时笔是抬着的」。

### ④ 修复（0x012D）：唯一可行的包外证据 = 笔尖 → 左键**消息**

- `keyhook.c` 在既有钩子线程（进程内唯一常驻消息泵）挂 `WH_MOUSE_LL`，
  镜像 `WM_LBUTTONDOWN/UP` 的状态/坐标/时刻/累计次数，导出
  `keyhook_mouse_state()`；⛔ 与布防无关（平滑不是热键功能），并进 5s 看护重挂。
- 平滑侧（`cursamp_thread`）**只在 `realAge > RI_STALL_MS`** 时用它把 `tip` 抬到 1：
  武装 = 见到按下 **且光标在活动文档画布内**（`g_canvasOkDbg`）；
  解除 = 见到抬起 / 离开画布 / 停手 2s / 单次按下 15s 硬上限 / 真包回来。
  · 按下后 `MSE_MIN_DOWN_MS=800` 内不因「抬起」解除 —— 有的驱动按下即补一条抬起
    消息（鼠标模拟只做边沿），照单全收就一次也画不出来。
  · 按下时刻回看 `MSE_ARM_LOOKBACK_MS=600` —— 空档判据本身滞后 250ms，
    「笔刚落纸、驱动就死」这种最常见形态不能漏。
- ⛔⛔ **只加不减**：本段只会把 tip 从 0 抬到 1，**绝不否决**包证据 —— 否决就是
  0x012B 第三道守卫的老路（6468 全场 `补发=0` 已判死）。
- ⛔ 镜像无数据（该驱动/笔不产生鼠标消息，`keyhook_mouse_state` 返 0）⇒ 本段静默，
  行为与 0x012C 逐位相同。
- 诊断：`[mse] ★武装 / ·解除：<原因>` 边沿各一行；`[raw]` 加 `mse=状态/arm=/rel=`。

### ⑤ 顺带确认的两件事

- 本场 `tip=1` 的 33 个采样里 `btn=0` 只有 4 个（12%），而 jwwh-6468 是 15/29（52%）
  ⇒ **电平的相关性因场而异**，再次证明不能拿电平当判据（事件镜像才是正确形态）。
- 本场 18 个落笔周期里 PS 真正在画的 12 个（`[pk]` 轮询 ≥800/s）、短促点按 4 个
  （PS 近空转）、日志缺采样 2 个 ⇒ 用户数出来的「12 笔」很可能就是这 12 个。
- **本场没有 PS 重启**：全日志只有 12:42:51 一次 `WTOpenW`、12:45:11 一次 `WTClose`
  （= 关闭 PS）。若用户的「重启」是重开 PS，那 8–12 笔写在另一个
  `%TEMP%\jwwh-<新pid>.log` 里，需另行取日志。

### ⑥ 验证与下一轮判据

`build.sh` 零告警 + PiPL 往返一致 + `mov eax,0x12D` PASS + 已部署（md5 `9b6c7875…`）。
下一轮看四行：
1. `鼠标左键镜像已安装（WH_MOUSE_LL…）` 是否出现在 pi8li.log（没出现 ⇒ 钩子被策略拦）；
2. `[mse] ★武装` 的次数是否 ≈ 空档期真正下笔的次数；`(%d,%d)` 坐标是否在画布内；
3. 解除原因分布：`见到抬起事件` ⇒ 该驱动的抬起消息可靠（可据此把 2s 停手兜底放宽）；
   全是 `停手(光标静止)` ⇒ 该驱动不发抬起，靠静止收尾；
4. **长空档里线是否继续画**（这是这一版的全部目的）；抬笔后是否**无**幽灵线。

---

## O28 · 0x012E：代投节流口径错了 —— `moved` 把「用户停住等线追上来」判死（jwwh-2200）（2026-10-18 下午）

用户原话：「本次测试 15 笔，前 1-4 笔正常，5-6 笔断流，于是 reload 之后自愈，7-15 笔都正常。」
并纠正上一轮：**「重启自愈」其实是 UXP reload，不是 PS 重启**。

### ① reload 自愈的机制（重要认知）

`jwwh-2200.log` 结尾就是一次完整的卸载：`[ctx] WTClose hCtx=0x802` → 六个诊断钩
`还原: OK` → `# 卸载: OK（原字节 E9 7C A8 0E 00 已写回）`。⇒ reload 把 .8li 整块
拆掉再装回：**hooks / 会话状态 / 合成环 / 平滑器全部重建**，并且随后 PS 会重新
`WTOpenW` 拿一个新上下文。这解释了为什么 reload 一定能救 —— 它修的不是驱动，
是**我们自己的进程内状态**。（LNP 自己的 `log_photoshop.txt` 在同一刻也记录了
`WM_QUIT for main thread` + `pluginUnloading`；若真是 UXP reload 而 PS 未退，
这条 WM_QUIT 的来源待查，见 ⑤。）

### ② 致命停摆的铁证：**喂得进、叫不醒**

13:01:25.703 起停摆 9.9s（止于 reload），窗口内三个数字同时成立：

| 时刻 | 补流（次/包） | 补发（唤醒） | PS 取包次 |
| --- | --- | --- | --- |
| 13:01:25.187 | 463 / 672 | 30 | 2546 / 2.1s（≈1200/s） |
| 13:01:27.272 | 594 / 828 | ~30 | 825 / 2.1s |
| 13:01:29.378 | 730 / 964 | 43 | 1330 / 2.1s |
| 13:01:31.481 | 849 / 1094 | 44 | 491 / 2.1s |
| 13:01:33.596 | 982 / 1230 | 44 | 136 / 2.1s |
| 13:01:35.691 | 1105 / 1356 | 46 | 127 / 2.1s |

⇒ 合成包稳定 ~65 包/s 喂进去，但代投 10 秒只有 46 次 ⇒ **PS 是消息驱动的，唤醒
次数直接决定它取包/重绘的节拍**，取包次从 1200/s 崩到 60/s ⇒ 线冻住。
（jwwh-20708 那次 补发 涨到 142，线就能继续走 —— 机制本身早就成立，是节流口径在
这一版把它关掉了。）

### ③ 根因：两道守卫**先后**拦，把 9.9 秒全覆盖（归因已修正）

⛔ 本节初版写成「moved 最致命、用户看到线不动就停住笔等它」—— 用户 2026-10-18 反馈
「没有出现过线不动、性能高也没冲包」后重核日志：**主次说反了**。按实际时序：

| 时段 | 光标在做什么 | 生效的门 | 时长 |
| --- | --- | --- | --- |
| 25.703 → 26.9 | 停在 (1530,1049) 不动（`Δ累计14px/1.3s`） | **moved**（坐标未变 ⇒ 不投） | ≈1.2s |
| 27.0 → 35.5 | 跳到画布外右上 (3267,283)/(3828,85)… 再回中部 | **cv=0**（画布外 ⇒ 停发） | ≈8.5s |

- **旧① cv=0（画布外 ⇒ 停发）—— 本场主因**，判死约 8.5 秒。⛔ 关键认知：用户移出画布
  **不是自然起笔动作，是被冻住的线逼出来的反应**（去戳面板/看设置；同期 `why=4 光标不在
  文档区矩形`、`mse 武装点 (3782,18)` 落在标题栏）⇒ **cv=0 绝不能读成「用户不画了」**。
- **旧② moved（光标必须动过才投）—— 只判死开头 1.2 秒，但仍是必须删的一条**：补流输出
  滞后一整根绳（本场平均 38.8px），笔一停虚拟笔尖就永远差这 38.8px，而 `moved` 恰在此时
  （且只在此时）说不投 ⇒ 「停住笔反而更画不出来」的悖论。轻停（没移出画布）的场景里，
  它就是唯一生效的门，也是 `[frz] movedTot=0/12` 那行的出处。

### ④ 修复（0x012E）

1. **删 moved**，代投改**按拍节流**：62Hz（`&3`），冻结期 15Hz（`&15`）。
2. **cv=0 不再停发**，改为**喂入冻结**：把喂入位置钉在最后一个画布内点
   （`s_csGoodX/Y`，`[post] 喂入冻结` 一行留痕）。位置钉住 ⇒ 画不出幽灵线；
   唤醒不断 ⇒ PS 的取包/重绘循环不倒，笔一回到画布立刻接着画。
3. 诊断：`[raw]` 加 `补发=N/frz=0|1`（停摆期直接看代投速率）；`[dead] pre=` 加 `frz`。

### ⑤ 顺带记录（本场）

- **本会话的 Wintab 上下文 0x802 是 LNP 的**：LNP 日志 00:00:12.625 明确
  `initContextA New WT context: 0x802`、`lcMsgBase: 0x7FF0`、`lcPktRate: 200`、
  `lcOptions: CXO_SYSTEM|CXO_MESSAGES|CXO_MARGIN|CXO_CSRMESSAGES`、`Packet size: 52`
  —— 与我们的 `[ctx] WTOpenW hCtx=0x802 ... msgBase=0x7FF0 pktData=0x1FFC` 完全一致。
  即：**我们的 ⑥ `WTQueueSizeSet(0x802,128)` 改的是 LNP 的上下文**。本场队列 128
  仍然断流，恢复时冲包量只有 17 包 ⇒ 驱动是「暂停投递」不是「攒满」。
- 反复出现 `[mse] ★武装 → 解除：光标离开画布`（本场 arm=8 / rel=6），全部由 cv 触发，
  说明该路径在停摆期基本只在「用户把笔移出画布乱晃」时活着 —— 与 0x012D 的设想
  （断流期用户仍在画布上下笔）不符，下一轮再看是否需要把「离画布」改成「冻结」而非
  「解除」。

### ⑥ 验证与下一轮判据

build.sh 零告警 + PiPL 往返一致 + `mov eax,0x12E` PASS + 已部署（md5 `1c6bc44a…`）。
下一轮看四处：
1. 长停摆中 `补发` **是否持续增长**（≈62/s；仍冻结在某个数 ⇒ 还有别的门）；
2. PS 取包次是否**不再崩到 60/s**（崩 ⇒ 唤醒没真正叫醒它，回到 `[post] ret=`）；
3. 线是否不再中途冻住、`[post] 喂入冻结/解冻` 是否成对出现；
4. 抬笔后**无**幽灵线（冻结坐标是否真的钉住）。

---

## O29 · 断流的真实现场是「平滑失效」，不是「线冻住」（2026-10-18 用户反馈，重要认知修正）

用户原话：「这种情况在我实验中没出现过，断流的情况下就是**平滑失效、HUD 显示错误**，但是我还是能用
**没平滑过的套索工具正常画出选区**，至于平滑正常的时候，也没有出现过[线不动]。」

### ① 认知修正

O24–O28 一律把断流描述成「线冻住 ⇒ 用户被迫抬笔 ⇒ 整笔报废」。用户的现场是：
**笔一动画得出来（跟手），只是没有平滑**，同时 HUD 显示不对。⇒ 两套描述必须分清：

| 现象 | 谁在画 | 平滑 | 用户感受 |
| --- | --- | --- | --- |
| 正常 | PS 走 Wintab 包路径（我方改写） | 有 | 渐变、跟手 |
| **断流（真实形态）** | PS 退化成 **Windows 鼠标消息**路径 | **无** | 能画，但没有平滑；HUD 异常 |
| 「线冻住」（旧描述） | 仅当合成包 buttons=0 或坐标被钉住时 | 无 | 极少出现 |

### ② 与日志如何自洽

jwwh-2200 断流窗口：`PS取包次=2546 真实包=0 零包次=2546`（2.1s）⇒ **Wintab 包通路确实死**
（驱动不投）。而 PS 的套索在 Wintab 空转时会退化为鼠标消息（LNP 走 `MouseHookPro64`
的也是同一层）⇒ 用户看到的就是**未平滑的原始轨迹**，跟手。
HUD 显隐门的 `real`（400ms 内有无真实包）失守 ⇒ `[hud] 未显示 … real=2422ms` ⇒ 与「HUD 显示错误」吻合。

### ③ 判据必须改

- ❌ 「线是否冻住」不是可靠判据 —— 用户看不到冻住，他看到的是「没平滑」。
- ✅ 判据 = **平滑是否回来**：HUD 是否恢复 + 线的过渡是渐变而非硬折。
- ⚠️ **待验证假设**：PS 一旦切到鼠标模式，给它包它会不会切回 Wintab 路径？若不会，
  则补流「喂合成包」方向本身无效（喂进去不被消费），必须另找把 PS 拉回包路径的手段；
  **reload 能自愈正好符合「整块重建 / 重新 WTOpen」这一解释**，但不能单独证明它。
  验证方法：断流期 `[pk]` 里 PS 取到合成包（`补流` 涨）之后，若线条仍无平滑，
  说明包被取走但没被用于绘制。

### ④ 连带修正

- O28 ③ 的措辞「用户见线不动就停住笔等它」已在用户反馈后改写为时序归因（moved 1.2s / cv=0 8.5s）。
- `moved` 仍然是必须删的门（笔一停虚拟笔尖差 38.8px 走不完），但它救的是**平滑质量**，
  不是「救活一条冻住的线」——两者别混。

---

## O30 · LNP 的「MouseHook」到底钩什么 —— 三路输入全覆盖（2026-10-18，字符串级取证）

用户提问：「如果给鼠标语和笔语都加上平滑，能否保证断流时也平滑？LNP 的钩子叫 MouseHookPro，
它到底勾的是鼠标的什么？」—— 直觉方向**正确**，且 LNP 正是这么干的。

### ① 归属纠错

`MouseHookPro64.8li` **不是 Adobe 自带**，是 **LNP 自己的 PS 插件**
（`E:/Program Files\Lazy Nezumi Pro\plugins\ps64\`，v26.10.14.1720，psPlugin:1）。
旧记忆（refs 第 179 行）误记为 Adobe 自带，已改。

### ② 钩子清单（样本字符串实测，`analysis/lnp/MouseHookPro64.8li`）

| 层 | 被钩 API | 作用 |
| --- | --- | --- |
| 笔语（Wintab 包） | `WTPacket`（旁路喂包）、`WTPacketsGet`（替换 buf + 返回值） | 平滑注入 |
| 上下文 | `WTOpenA/W`（清 lcLocks 0x10）、`WTInfoW`（DPI） | 见 O22/O23 |
| **光标查询** | **`GetCursorPos`**、`SetCursor`、`SetCapture`、`GetMessagePos` | PS 主动问「光标在哪」时给平滑后的坐标 |
| **消息层** | **`PeekMessageA/W`、`GetMessageA/W`、`GetMessageTime`** | 改写 `WM_MOUSEMOVE` 里的 `pt` |
| **Windows Ink** | `GetPointerInfo/History`、`GetPointerPenInfo/History`、`GetPointerFrameInfo*`、`GetPointerDeviceRects/Properties`、`GetPointerType` | PS v25+ 默认走 Ink 时接管 |
| 坐标换算 | `WindowFromPoint`、`ScreenToClient`、`ClientToScreen` | 保证上述替换后坐标自洽 |
| 窗口过程 | `DefWindowProcA/W` | 兜底 |

⛔ 注意是 **`SetCursor`（光标形状）不是 `SetCursorPos`** ⇒ LNP **不搬动真实光标**，
它只在「读」的层面篡改：用户的光标（施力点）保持真实，PS 看到的（受力点）是平滑后的。
这正是我们要的“施力点/受力点分离”语义，无需对抗驱动。

### ③ 结论：我们只钩了 1/3

我方只钩 Wintab 包路径。驱动一停，PS **回退到鼠标路径**（用户实测：断流当下能用未平滑套索
正常画，reload 后平滑回来）⇒ 我们彻底插不上手 = “平滑失效”。
⇒ **补上 `GetCursorPos` / 消息层是正确方向**，不是追加补流包的力度。

### ④ HUD 语义（用户两次纠正后定稿，重要）

⛔ 初版写的「断流时环停在原地」**是错的**（用户 2026-10-18 二次纠正 + 两张截图）。
几何真相（代码即 `rx=(axX-aoX)*px_x(); 圆心=光标−r`）：

| 状态 | 圆心 | 光标（施力点） | 轨迹末端（受力点） |
| --- | --- | --- | --- |
| 正常 | = 受力点（平滑输出） | 在圆内；距离 ≥ 绳长时被“拽”在**圆周上** | 吊在光标后 ≈38.8px |
| **断流** | 由 `光标 − (raw−out)·px` 算出，而 raw/out 已不代表真实绘制点 ⇒ **相对光标偏一个错误/漂移的量 ⇒ “圆心飘忽不定”** | 仍在圆周上（拉绳模型照旧把圆心拖着跑） | **= 光标**（无滞后 ⇒ 施力点与受力点重合） |

⇒ 所以用户看到的是：**环跟着笔跑、光标始终在圆内/圆周上，但圆心位置不对**，
而不是环冻结。⛔ 这不是“虚拟笔尖失效”，是 **HUD 的坐标来源（我们的平滑输出）
与 PS 的实际绘制（鼠标透传）分家了**。
⇒ ✅ 免费判据：**圆心与轨迹末端是否重合**——重合 = 平滑在管这条线；分离 = 两个世界。
（不是“环跟不跟得住”，环永远跟得住：圆心本来就是相对光标算出来的。）

### ⑤ 下一步（待用户拍板）

先做**零风险观测版**：给 `GetCursorPos` / `GetMessagePos` / `PeekMessageW` 各装一个
**只计数不改写**的 detour（沿用现有 E9 补丁器 + `wtctx.ini` 外置开关，铁律 12），
在 `[raw]` 里报增量。断流期哪个计数飙升 ⇒ 就是 PS 回退后真正的取坐标入口 ⇒
下一版只改那一条（返回平滑坐标），即可实现“断流也平滑”。

---

## O31 · 0x012F：照搬 LNP 的 `GetCursorPos` 通路（完整逆向 + 落地）（2026-10-18 下午）

用户指令：「给鼠标路加平滑，技术入口你先别试，就逆向 LNP，它怎么做的你就先照搬。」
样本 `analysis/lnp/MouseHookPro64.8li`（v26.10.14.1720，sha256 dc01be2b…b0cb）。

### ① 逆向：钩子本体与调用链

```
user32!GetCursorPos  →  钩子 FUN_18002c440：
    ① (*DAT_180180a38)()                  ← 先调真 GetCursorPos（真实光标先落袋）
    ② if (state+0x2eee1 != 0)             ← 该 app 是否启用替换
           EnterCriticalSection(state+0x30668)
           FUN_180058310(state+0x2c0, pt)  ← 加工/覆盖输出
           LeaveCriticalSection
    ③ return 1
```

`FUN_180058310` 三分支（`pt` 是 int[2]，会被整 8 字节改写）：

| 分支 | 条件 | 动作 |
| --- | --- | --- |
| A | `GetAsyncKeyState(VK_LBUTTON) < 0`（**VK=1，实测数据 `DAT_18017f1e0 = 0x00000001`**） | 真实坐标 → float → `FUN_18002bd40`（`WindowFromPoint` 判窗口 → `FUN_180057a30` 初始化笔画）→ 成功则 `*(u64*)pt = state+0x2ab10` |
| B | 回放模式 | 从预录数组 `state+0x26e70` 按索引 `0x26e88` 顺序取点覆盖；空格键跳到末尾 |
| C | 笔画进行中 `state+0x26e18 != 0` | `FUN_180058500(state, pt)` → 引擎步进 → `*(u64*)pt = state+0x2aae8` |

`FUN_180058500`（逐拍推进的核心）：

```c
if (!state->b2aadd) return;                    // 未启用 ⇒ 透传
EnterCriticalSection(state+0x26e48);
if (state->b26e18) {                           // 笔画进行中
    FUN_180058e90(state, &local);              // ★ 平滑引擎吃真实点（float x,y）
    state->n2ea1c++;                           // 步数
    state->u2aae8 = pack((int)f26e90, (int)f26e94);   // ★ 平滑点 → int 对
}
LeaveCriticalSection(...);
*(u64*)pt = state->u2aae8;                     // ★ 覆盖 GetCursorPos 的输出
```

⇒ **平滑推进的节拍由“PS 查询光标的次数”决定**，不是独立线程 —— 天然与 PS 同拍，
     且完全不依赖 Wintab 包。这就是它断流也不失平滑的根本原因。

### ② 两个可直接抄的细节

1. **`VK_LBUTTON` 只用来“开启推进”，不用来“判定抬笔”**：
   左键电平读 0 但 `b26e18`（笔画进行中）时，它返回的是**缓存的平滑点**（`0x2aae8`），
   **绝不透传真实坐标** ⇒ 完美规避 0x012B「用电平判抬笔 ⇒ 补发恒 0」那个坑。
2. **不搬光标**：钩 `SetCursor`（改形状）但**没有** `SetCursorPos` ⇒ 只改「PS 读到的那份副本」，
   系统光标（施力点）保持真实 —— 与 HUD「圆心=绘制点、光标在圈内」同一语义。

### ③ 我方落地（0x012F）

- `LHOOK` 加 `mod` 字段（默认 `Wintab32.dll`），`lhook_prepare` 按它取模块；
  新增 `g_lhGcp`（`user32!GetCursorPos`）与 `g_lhGmp`（`user32!GetMessagePos`，只计数）。
- `det_GetCursorPos`：先调真 → 判接管 → `pt += (snOut − snRaw) × px`（与 HUD 圆心同一换算、反号）。
- 接管条件（缺一不可）：`cursorInject=1` ∧ 面板开 ∧ `g_penDown` ∧ `g_canvasOkDbg`
  ∧ `realAge >= RI_STALL_MS`（**只在包通路停摆时**，否则与 Wintab 路径双重滞后）
  ∧ `sn_age_ms <= 300`（快照必须新鲜，否则 snOut 是死值 ⇒ 线被钉在固定位移，比不平滑更糟）。
- 幅度保险 ±3000px；内部四处 `GetCursorPos`（补流输入 / `[dead]` 判据 / HUD / DPI）
  全改走 `se_real_GetCursorPos()` 直调真函数 —— **否则“输入吃自己的滞后输出”会自激发散**。
- `cursorInject` **缺文件时默认 1**（刻意偏离铁律 12：它不搬光标、不改 PS 结构、
  不写驱动，且有上述三重保险）；ini 写 `cursorInject=0` 即退回纯观测。
- 诊断：`[raw]` 加 `gcp=调用/rw=改写/a=接管态 gmp=调用`。

### ④ 验证

`build.sh` 零告警 + PiPL 往返一致 + `mov eax,0x12F` **PASS** + 已部署
（md5 `5934d7a1…`，PS 未运行）。

下一轮判据：
1. `诊断钩 … GetCursorPos=挂`（不挂 ⇒ user32 导出不是 E9 桩，日志会写明首字节）；
2. 断流期 `gcp` **在涨** ⇒ PS 确实在问光标；
3. `rw` 随 `gcp` 一同涨 ⇒ 真改写了；
4. **断流期线恢复平滑**（本版唯一目的）；正常运笔时 `a` 必须恒 0；
5. HUD 圆心与轨迹末端重新重合（不再是“施力点=受力点、圆心乱飘”）。

## O32 · 0x0130：核对「两个值得抄的细节」到底抄了几个 —— ②已等价具备，①确实漏了（2026-10-18 晚）

用户提问：「你刚才提到两个特别值得抄的细节你抄了吗，我看了一下觉得很值得我也落地」。
逐条核对结论：**② 已经等价具备（不是抄的，是原有机制刚好等价），① 真的漏了**。

### ① 推进节拍 = PS 的查询次数（**漏了**）

| | LNP | 我方 0x012F（补齐前） |
| --- | --- | --- |
| 引擎由谁推进 | PS **每调一次** `GetCursorPos` → `FUN_180058500` → 引擎 `FUN_180058e90` 走一步 + `n2ea1c++` | 由**包**推进（`smooth_engine` 的主循环跟包/采样拍走） |
| 断流期表现 | 每问一次就前进一点 ⇒ 手感连续 | 包几乎为 0 ⇒ 引擎几乎不前进 ⇒ PS 在几十拍里拿到**同一个**偏移量 |

**为什么这会表现成「一顿一顿」**：平滑输出是一条吊在笔后面一整根绳的点（实测滞后 38.8px）。
正常时包以 133~200Hz 灌进来，引擎一直往前走，PS 每拍问到的位置都在变 ⇒ 看起来连续。
断流后引擎不走了，但 PS 仍然每秒钟问几百次 —— 于是那几百次拿到的是**同一张静止画面**，
直到我们下一拍（或下一个合成包）才挪一格。**问得越快、画面越像卡帧**。

这不是「平滑量不对」，是**时间轴没有跟着查询走**：我们只在有包的时刻推动时间，
PS 却在没有包的时刻也在问。

**修法（0x0130）**：在 `det_GetCursorPos` 里把 **raw 与 out 两端都外推到此刻**，
用的是 HUD 2026-10-14 第五轮验证过的那套 `v·Δt`：

```
pktDt = g_snMs - g_snPrevMs          /* 上一拍包间隔 */
age   = now - g_snMs                 /* 距离最后一次包的时长 */
aRaw  = raw + (raw - prevRaw)/pktDt * age     /* 同样对待 out */
dx    = (aOut - aRaw) * px
```

- 限幅 `age ∈ [1, 40]`ms：太旧（>40ms）就不外推，宁可给原值 —— 外推越远越不准。
- ⛔ 必须**有符号**相减：`g_snMs` 由包线程写，用无符号会下溢成 4.29e9。
- ⛔ 只做**纯几何外推**，绝不改引擎状态（不推进滤波、不改 `g_snOut`）——
  否则等于每被问一次就替用户画一笔，状态机立刻被问崩。

### ② 左键只作开启、笔画中返回缓存平滑点（**已等价具备**）

LNP 的做法：`GetAsyncKeyState(VK_LBUTTON)` 按着 ⇒ 推进；电平读 0 但笔画进行中 ⇒
返回 `state+0x2aae8` 的**缓存点**，绝不透传。

我方等价物：`armed` 条件里的 `g_penDown` 自带接触闩 ——
`CONTACT_HOLD_SMOOTH_MS=1500` / `SYNTH_TIP_MAX_MS=6000`（0x012A/0x012B 定的）。
电平掉落期间 `g_penDown` 仍为 1 ⇒ `armed` 仍成立 ⇒ 仍然返回平滑点而非透传。
**语义完全一致**，只是我们用的判据是「接触闩」而不是「笔画进行中标志」。

另外复核 `g_canvasOkDbg`：它在 `wantVisible` 判定**之前**无条件每帧更新
（`smooth_engine.c` 第 6063 行 `InterlockedExchange(&g_canvasOkDbg, canvasOk ? 1 : 0);`）
⇒ 断流期不会冻结，可以安全当接管条件用（不会出现「断流了画布判据还停在旧值」）。

### ③ 构建 / 部署

首编踩了注释坑：0x0130 版本史文本被**上一段的 `*/` 提前闭合**（第 6815 行末尾的 `*/`），
后面整段中文被当代码 ⇒ `character <U+300C> not allowed in an identifier`。
删掉那个中间 `*/` 后：`build.sh` **零告警** + `✅ PiPL 往返校验一致` +
`mov eax, 0x130 @+4 => PASS` + 已部署 `E:/Program Files\Adobe Photoshop 2026\Plug-ins\`
（md5 `c748fa5db7ebf3ce76eab0d0bc8bad6f`，PS 未运行）。

⛔ 教训：版本史是多段共用**一个** `/* … */`，每段之间**不能**再写 `*/`。

## O33 · 0x0131：整场「准备中」、HUD 与平滑全死 —— 标定被 `n>=3` 卡成死锁（jwwh-39120）

用户反馈：「本次测试开关一直卡在准备中，hud 和平滑都失效」。**这不是断流，是整机失效**，
比断流严重一个数量级（用户连平滑都没见过）。

### ① 现场（jwwh-39120，19:12:35 → 19:14:03，ver=0x0130）

| 证据 | 值 | 含义 |
| --- | --- | --- |
| `[status] state=` | **恒 0** | 面板文案 `state===0 ⇒ 「准备中」`（`src/app.tsx:1411`）⇒ 用户看到的就是它 |
| `calib=` | 恒 `否`，`stride=0 offX/offY=0→-1` | 一次标定都没成功 |
| `[calib]` 行 | **全场零条** | `try_calibrate()` 压根没被调用过 |
| `[why] reason=` | `7(未标定)` → 持续 `8(无上下文)` | `RS_NOCTX` 只在「`!tried` 且 `n<3`」这一条分支里出现 |
| `[status] calls/packets` | 42835 / 6537（都在涨） | **驱动没问题**，PS 一直在取包 |
| `[pk] 最大单次=` | 整场上限 **2** | 致命：真机一次只取 1~2 个包 |
| `[ctx] WTOpenW` | `hCtx=0x802 … pktData=0x1FFC` | 上下文正常，掩码正常 |
| `[mse]` | `真实通路已静默 2147483647ms` | 早期 `g_lastRealMs==0`，正常 |

### ② 根因：把「防巧合」写成了「硬门槛」

`smooth_packets()` 里旧代码：

```c
if (!g_calib.tried) {
    if (n >= 3) try_calibrate(hCtx, buf, n);
    else { reason = RS_NOCTX; return 0; }      /* ← 一次只给 1~2 包时永远走到这里 */
}
```

「盲扫序号逐包 +1 需要 3 个包才不是巧合」本身是对的（2 个包能凑出大量假的
`stride/offSerial` 组合），但它被写成了**唯一入口条件**。真机上 PS 走
`CXO_MESSAGES` 消息驱动、一次取 1 个包（整场 `最大单次=2`）⇒ 永远进不了标定
⇒ `tried` 恒 0 ⇒ `state` 恒 0 ⇒ 面板恒「准备中」、HUD 全部门闩失守、平滑零改写。

⛔ 这是**构造性死锁**：与驱动状态、LNP 在不在环、补流有没有接管都无关。
之前几场能标定，是因为那几场恰好出现过 `n>=3` 的批次（36148 场 13:38:45 `n=3` 一次就过）
—— 靠运气过的关，运气一没就全死。

### ③ 修法：分层取证 + 队列只读快照 + 心跳

| 批次 n | 取证标准 |
| --- | --- |
| `n>=3` | 老规矩：掩码+数据双证据优先，盲扫可独走 |
| `n==2` | **只认「掩码 + 盲扫」互证**（`src==1`）。两路独立证据互相印证 ≈ n=3 强度；盲扫单独定案在 n=2 上不可信 |
| `n<2` | 走 `WTPacketsPeek` **只读**快照凑一批（每 32 拍探一次）。⛔ 绝不用 `WTPacketsGet`（会真把包从 PS 手里吃掉） |

⛔ 两个配套细节，缺一个都会让修法自己失效：
1. `n==2` 但掩码未印证时，`ok=0` 且 **`g_calib.attempts--`** —— 否则一次只给 2 包的机器会连烧
   8 次「裁决失败」预算，直接锁进 `tried=1 / state=2（标定失败）`，把后面真正够证据的批次挡在门外。
2. 新增 `[calib] 等证据 2s: 本批 n=… peek=… 最大单次=… 累计包=… 尝试=…` 心跳 ——
   标定不成立时旧日志里**一行 calib 都没有**，只能靠 `reason=8` 反推（本轮就是这样查的）。

### ④ 同场另外两个洞（一起修）

- **`cursorInject` 缺省值放错了分支**：旧版只在「ini 文件不存在」时置 1；真实 ini 只有
  `queueSize=128` 一行，走的是「文件存在」分支 ⇒ 数组第 4 位保持 0 ⇒ 日志打
  `cursorInject=0`，0x012F 的 GetCursorPos 接管**从头到尾没开过**。
  修法 = `fopen` 之前无条件置 1，再由文件里的 `cursorInject=0` 覆盖。
- **`user32!GetCursorPos` 根本挂不上**：`诊断钩 … GetCursorPos=GetCursorPos 入口首字节=BA（非 E9 桩）⇒ 不挂`。
  LHOOK 的模型是「顺着 E9 找到真函数再直调」，真代码入口不适用；硬打 5 字节必须造
  trampoline，而 `BA` 到底是 `mov edx,imm32`（5 字节）还是 BT/BTS/BTR/BTC 组（3 字节）
  **没有反汇编器就不能猜**（猜错 = 把 PS 代码从中间劈开 = 当场崩）。
  ⇒ 改走**导入表（IAT）**：扫本进程所有已加载模块，把 `USER32!GetCursorPos` 的槽指向 detour。
  好处：user32 代码一个字节不动、无指令长度问题、写时复制只影响本进程；
  ⛔ 自己的模块**不参与扫描** ⇒ `se_real_GetCursorPos()` 里那句 `GetCursorPos(p)`
  仍是系统真函数（不会自己吃自己）。模块陆续加载 ⇒ 每 30s 静默重扫。
  ⛔ 覆盖不到的只有「GetProcAddress 现取」的调用方；真机上 `gcp=` 恒 0 就说明是这种情况，
  那时才需要考虑入口 trampoline（且必须有真正的长度反汇编）。

### ⑤ 产物与判据

`build.sh` 零告警 + `✅ PiPL 往返一致` + `mov eax,0x131 => PASS` + 已部署
（md5 `2f6cd10f…`，PS 未运行）。版本 0x0130 → **0x0131**。

下一轮看四件事：
1. `[calib] hCtx=… n=2` 或 `n=3` 出现，且紧接着 `结论: ★启用改写`；
2. 面板离开「准备中」，翻「生效中」（绿）；
3. `[gcp] 导入表接管 GetCursorPos: …（N 槽）`，N>0 ⇒ 下一版才算真正接上光标通路；
4. 断流期 `[raw] gcp=` / `rw=` 同步增长。

## O34 · 0x0131 首场验收：14 笔全绿（jwwh-9020，19:25:10 → 19:26:57）—— 数据层体检

用户：「本次我测试时 14 笔全部正常，似乎已经成了，从数据层面看看有没有问题」。
结论：**通了，且数据自洽**。下面逐项列出可核对的数字，以及三处「看着像问题、其实不是」。

### ① 标定（0x0131 的修法当场生效）

```
[calib] 等证据 2s: 本批 n=1 peek=0 最大单次=1 累计包=1 尝试=0     ← 心跳打得出来
[calib] hCtx=0x802  n=2                                        ← 用 n=2 定案
[calib] 掩码=有 mask=0x1FFC 推算 stride=52 offSerial=8 offX=20 offY=24
[calib] 盲扫=无 stride=0 …
[calib] 结论: ★启用改写（依据=掩码+数据）                        ← src=1，双证据
```
- `[status] state=1` 从 19:25:25 起**全程保持**，无抖动，面板「准备中」消失。
- `stride=52 offX=20 offY=24 pxX=0.0625 pxY=-0.0625 calX=1 calY=1` —— 与历史好场
  （36148：同 mask/同 stride/同偏移，pxY 为负）**逐字段一致**。
- ⛔ 关键：这一场 `最大单次=1` 持续了 15s（心跳里看得见），`n=2` 是唯一机会 ——
  如果还是 0x0130 的 `n>=3` 硬门槛，这一场必然又是整场「准备中」。

### ② 改写率与复位台账

| 项 | 值 | 判读 |
| --- | --- | --- |
| `packets / smoothed` | 17256 / 16493 = **95.6%** | 绝大多数包真被改写 |
| `rst` | `4/0/2/27`（锚/gap/jump/落） | gap=0（没有假复位）；锚 4 次**全在前两段**；jump 2 次都在停摆前后 |
| `[why]` | 9 次全部 `reason=0(改写中)`，仅开场 2 次 `7(未标定)` | 没有再掉回未标定/标定失败 |
| `open/close` | 8 / 7 | PS 开场重建过多次上下文；末次被卸载吃掉，无害 |
| `ctxN` | 0 | 标定绑在 hCtx=0x802 上，全程没换过 |

### ③ 断流仍在，但全部被接住

三段停摆：**1515ms / 750ms / 1750ms**，全程 `syn=1`（补流已接管），期间
`[post] ★首个代投 … ret=1`、`补流=627次/1505包`（= 真实包的 8.7%）。
第三段（19:26:50.7 起）与用户**关开关**（19:26:54.58 `卸载: OK`、`补流结束：面板开关已关闭`）
重叠，不算有效样本。

### ④ 三处「看着像问题、其实不是」

**1. `落` 在一段台账里出现 9/6/3 次（铁律 19 说 >1 就是抖动）**
七段台账的 `落` = 1 / 9 / 6 / 3 / 3 / 2 / 1；对应 `悬空批` 247~844、`最长全零` 247~305 包。
⇒ 同段内存在**成百个** buttons=0 的包，说明笔真的离开过纸面 —— 是
`CONTACT_HOLD_MS=1500` 把「1.5 秒内的多次真落笔」合并成了一段台账，
**不是抖动**（抖动只有几包，会被 `BTN_EDGE_MIN_ZERO=8` 滤掉，且会看见折角，用户没看到）。
⛔ 0x0132 为此加了直接证据 `落间最小全零=N包(共M次)`（见 O35 预留位）。

**2. `rw` 只有 4276，而 `gcp`=126302（改写率 3.4%）**
不是坏了：接管窗口 = 「真实包停 ≥500ms」之后的每一拍，而三段停摆只有 1.5/0.75/1.75s
⇒ 可改写窗口 ≈ 1.0s + 0.25s + 1.25s。按 gcp≈1200/s 算，期望值同量级。
第一段停摆 605 次、第三段 3542 次，与窗口长短成正比 ⇒ **数学自洽**。
`gmp=0` ⇒ PS 完全不走 `GetMessagePos`，坐标只从 `GetCursorPos` 取。

**3. `平均滞后` 125.7px 而 `半径` 只有 100px（看着像超了上限）**
量纲不同：`半径` 是**逻辑 px**（配置值），`平均滞后` 是**屏幕 px**，`dpi=1500‰` ⇒ ×1.5。
125.7/1.5 = 83.8 逻辑 px < 100 ✓。三段半径 100/48/23 对应滞后 125.7 / 62~77 / 27.9~33.2，
比例一致（都在绳长的 81~85%）。

补充：`解析 rms=41.5/59.2` 是**原始单位**（16 raw/px，见 `ax=16`）⇒ 2.6 / 3.7 屏幕 px，
与历史好场同量级，不是退化。

### ⑤ 这场唯一值得记的隐患

`jump=2`（19:25:28.77、19:25:35.29）都发生在**停摆恢复瞬间**：驱动恢复时会一次性
吐回一段积压包，位置突变 ⇒ 触发复位 ⇒ 输出点被拽回笔尖（一瞬间直条）。
两次/14 笔，用户未察觉。下一版若要做，方向是「恢复瞬间用补流前沿对齐，不要复位」。
