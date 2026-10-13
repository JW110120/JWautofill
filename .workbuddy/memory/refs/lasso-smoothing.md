# 套索实时平滑（方案 A：输入层滤波）— 明细

> 由 `MEMORY.md` 下沉而来（2026-10-12）。主索引只留导航，这里放全部细节与踩坑。
> 方案原文 / 实现状态 / 验收清单见 `docs/lasso-realtime-smoothing-plan.md`。

## 1. 定位

- UXP **无画布指针 API** ⇒ 绘制过程对插件是盲区；唯一实时入口是「PS 收到输入之前」
  = 原生钩子 + 回注。**两个独立产物**（2026-10-12 起）：
  | | 热键 | 平滑 |
  | --- | --- | --- |
  | 源码 | `native/HotkeyDaemon/Program.cs`（**同一份**，靠编译期 `ROLE_SMOOTH` 分岔） |
  | 工程 | `native/HotkeyDaemon/*.csproj` | `native/SmoothDaemon/*.csproj`（`<Compile Include="../HotkeyDaemon/Program.cs" />`） |
  | 端口 | 18923 | 18924 |
  | 安装目录 | `%LOCALAPPDATA%\JWautofill\daemon\` | `%LOCALAPPDATA%\JWautofill\smooth\` |
  | UXP 桥接 | `src/hotkey/HotkeyBridge.ts` | `src/hotkey/SmoothBridge.ts` |
  ⛔ 面板「停止 / 卸载服务」是**进程级**；此前共用一个进程 ⇒ 停热键把平滑一起带走
  （用户报的「卸载快捷键服务后平滑显示未连接」）。拆成两个 exe 后才真正解耦，
  已用 `ws-send.cjs` 双向对拍实证。
- 与「选区改造」是**两条独立路径**：本功能作用在**输入轨迹**，后者作用在**已生成的选区掩码**；
  可同时开启（效果串联）。⚠️ 2026-10-12 起「选区改造」里的**平滑滑块已删除**
  （`state.selectionSmooth` / `SelectionOptions.selectionSmooth` / `DragHandler` 配置 / 文案全清），
  该分区只剩「锐度 / 扩散」两个作用在掩码上的参数。
- UXP 侧桥接：`src/hotkey/LassoSmoothing.ts`（**不持有 WebSocket**，发送器与连接状态由
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
  - 另加载 `MouseHookPro64.8li`（Adobe 自带笔/鼠标输入插件），它也调用同一批 Wintab API
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
  产物：`analysis/_tools/spike/{jwprobe.c, jwprobe.dll, inject.py}`。
  ⇒ ②a 的重心从「能不能进」转为「inline hook 稳定性 + 杀软对**长期驻留/改代码段**是否更敏感」。
- ✅ **DPI 感知已落地**（绝对注入的坐标口径）：`native/app.manifest`（两角色共用，`PerMonitorV2`
  + Win10 `supportedOS`——缺它整条 `dpiAwareness` 被静默忽略 + 显式 `asInvoker`）+ Main 第一行
  `EnsureDpiAwareness()` 兜底。`getState` 暴露 `dpiAwareness`，真机两角色均报 `permonitor-v2`。
  ⛔ 这个差别在 100% 缩放的机器上**看不出来** ⇒ 有人报「光标画偏」先查这个字段。
- ⚠️ 判定手法（30 秒，零代码，**仍需真机用手握笔跑一次**）：`node analysis/ws-tablet-probe.cjs`，
  按提示先用鼠标划、再用笔划，看 `callbacks` 增量；笔段增量为 0 ⇒ 确认绕过鼠标通路。

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
  `Program.cs` 内 `#if ROLE_SMOOTH` 的 `PenHook`、`src/hotkey/SmoothBridge.ts` 的 `sendPenSmooth`。
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

## 8. 诊断工具（`analysis/` 已 gitignore、不跨机）

| 脚本 | 用途 |
| --- | --- |
| `ws-raw-probe.cjs` / `ws-arm-test.cjs` / `ws-tablet-probe.cjs` / `ws-send.cjs` | 都接受**端口作为第 1 个参数**（默认 18923）——拆分后热键 18923 / 平滑 18924 |
| `ws-send.cjs <port> '<json>'` | 向指定端口发任意原始指令。**验证「两个服务互不影响」的唯一手段**（面板上做不到：停掉一个就断连接）。等待时长用 `WS_WAIT_MS` 调（默认 1500ms，自检类要调大） |
| `ws-raw-probe.cjs` | 活体查询 `getState` / `smoothStatus`（**必须手写 WS 帧**：`HandleClient` 用大小写敏感正则匹配 `Sec-WebSocket-Key:`，Node undici 的小写首部会被拒） |
| `ws-arm-test.cjs` | 端到端布防验证（观测 `armed/hookInstalled/callbacks` 跃变） |
| `ws-tablet-probe.cjs` | 数位板通路探针（对比鼠标 / 笔的 `callbacks` 增量） |
| `hookprobe/` | 独立 P/Invoke 探针：用与守护进程**完全相同**的写法安装两种低层钩子（16 种组合） |
| `pe-imports.py` | 零依赖 PE 导入表解析（判定静态导入 IAT vs `GetProcAddress`） |
| `find-wintab-importer.py` | 在「PS 已加载模块」列表里找 Wintab 的引用者（配合 `_ps-modules.txt`） |
| `pointer-accel-probe.py` | 量化指针加速对相对注入的位移整形（读 `SPI_GETMOUSE`）。⚠️ **必须绕过沙箱**：沙箱会直接 SIGTERM 任何调用 `SendInput` 的进程；等效测量改用守护进程的 `pointerTest` |
| `spike/jwprobe.{c,dll}` | 最小探针 DLL：`DllMain` 只 `CreateThread` 写证据文件 `%TEMP%\jwprobe-<pid>.log`（无 Wintab 逻辑）。构建：`zig cc -target x86_64-windows-gnu -shared -O2`（用短路径的 zig.exe） |
| `spike/inject.py` | **DLL 注入器／卸载器**：`inject.py <pid> [dll]` 注入；`--eject <pid> <dll_name>` 按名卸载。⛔ **不要用 `GetExitCodeThread` 取远程 `LoadLibraryW` 的返回值**（32 位截断 ⇒ 卸载必失败且无报错）；注入是否成功看证据文件，卸载基址靠 `EnumProcessModulesEx` |
| `spike/recon_wintab.py` | **改代码段前的零风险侦察**：本进程 `LoadLibrary` 后读导出序言字节 + 与目标进程同 RVA 逐字节对照（判定「出厂代码 vs 已被 hook」），带极简 x64 长度解码 |
| `spike/recon_thunk.py` | 磁盘节表 RVA→offset + 追 `E9 rel32` 跳转链（钉死「入口桩 → 真实现体」两层） |
| `spike/wtprobe.{c,dll}` | **P2 探针**：10 个 Wintab 导出入口的 inline hook（计数）+ 改写期线程冻结 + `wtprobe_{selftest,reset,unhook,version}` 导出 |
| `spike/inject.py` 命令 | `--verify <pid>` 三层复核（入口改写 → 跳向模块外 → 转发桩 `mov rax,imm64;jmp rax`）；`--selftest` 从入口真调一次证明链路；`--reset` 清零基线；`--unhook`／`--eject`（**eject 会自动先 unhook**） |

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

### 自检工具
`analysis/gen_layout_selftest.py`：从 `wintab_hook.c` **原样抽取**标定函数编译成离线 exe，
用真机 dump 的字节验证 (stride, offSerial, offX, offY)。改标定逻辑后必跑。
`analysis/wintab_layout_probe.py` / `wintab_axis_probe.py`：WTInfo 只读侦察（不注入、不模拟输入）。

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
- 像素取证工具：`analysis/_tools/png_measure.py`（包围盒/距离测量）、`png_ascii.py`（结构图）。
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
