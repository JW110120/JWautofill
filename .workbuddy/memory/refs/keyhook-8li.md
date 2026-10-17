# keyhook-8li：键盘钩子并入 .8li（M3，2026-10-17）

> HotkeyDaemon(65M) + FixKeyboard(76.5M) 已退役；WH_KEYBOARD_LL 改由
> `native/PiSmooth8li/keyhook.c` 在 PS 进程内承载。面板协议零改（WS 18923 原样连）。
> 常量：`KH_PORT 18923` / `KH_VERSION "2026-10-17.1"` / `KH_BUDGET_MS 100` /
> `KH_STRIKES 3` / `KH_COOLDOWN_MS 30000` / `KH_MAX_ITEMS 256`。

## 线程模型（keyhook.c 内四线程 + plugin_main 的服务器线程）

| 线程 | 职责 | 纪律 |
| --- | --- | --- |
| 钩子线程 | WH_KEYBOARD_LL + 两段式录制状态机；100ms 轮询兜底「安装意图」 | 回调 O(1)、零 I/O、零锁（除引用快照）；posts 只降延迟，丢消息不死人 |
| 调度线程 | 命中广播 / 出站环代发 / 钩子日志代打（≤20ms） | 三环均为 **SPSC：单生产者=钩子线程**；⛔ 别的线程push=破纪律 |
| 看护线程（120ms） | 存活探针（线程死⇒重建）/ 熔断冷却自愈 / **跃变广播 hotkeyState**（连续两轮一致才播，消安装中间帧）/ 2s 句柄看护 / 3s 刷 psPids / 1s 配置 mtime | 只读+广播，不直接装钩 |
| 服务器线程 | accept → 每客户端一线程走 `wc_client_loop` | WS 帧 → `kh_handle_message` |

⛔ **`g_khRecPending` 仅钩子线程读写**（两段式录制的待确认键）。跨线程要取消录制
只能 `InterlockedExchange(&g_khRecReq,2)` + `PostThreadMessage(WM_KH_RECSTOP)`，
让钩子线程自己跑 `kh_finish_recording`（它负责回 recordCancel 帧 + 清 pending）。

## 装/卸钩的跨线程规则

- `kh_uninstall_hook()` 设计为**钩子线程调用**（内部会碰录制态）。
- 别的线程要「立即卸钩」（修复场景，冻结期每毫秒都珍贵）⇒ 只做
  `InterlockedExchangePointer(&g_khHook,NULL)` + `UnhookWindowsHookEx`（线程安全，
  在途回调会跑完再摘链），录制取消按上节回钩子线程。
- 安装意图三判据：`g_khBound && g_khArmed && !g_khSrvStop`（钩子线程每轮自校）。

## 单持有者 + 旧 daemon 迁移

- 只有 **bind 18923 成功**（`g_khBound`）的 .8li 实例才装钩子（多 PS 实例语义
  与 daemon「一个进程一套钩子」等价）。
- bind 失败 ⇒ 客户端连 18923 发 `getState`，`"version":"2026-10-12" 前缀确认是
  **旧版 daemon** ⇒ 发 `uninstall` 令其自清（自启项+目录）后退出 ⇒ 3s 后重试 bind。
  面板无感（重连循环 1.5s）。
- ⚠️ 迁移窗口（几秒）内面板若发 `repairKeyboard`，旧 daemon 不识该消息会吞掉
  ⇒ 面板 15s 超时文案已覆盖此情形（「若刚迁移过旧版服务请稍等重试」）。

## WS 18923 消息协议（面板 ⇄ .8li）

面板发：`setConfigPath` / `getConfig` / `config` / `getState` / `hotkeyArm{on}` /
`hotkeyStatus` / `recordStart{brush}` / `recordCancel` / `armDelete{owner}` /
`disarmDelete` / `uninstall` / `shutdown` / `repairKeyboard{script}`。
服务端帧：`config` / `state`(getState) / `hotkeyState`(跃变广播+status回帧：
armed/hookInstalled/safeMode/active/comboCount/recording/timeoutMs/budgetMs/strikes) /
`hotkey`(命中) / `recordCaptured` / `recordResult` / `recordCancel` /
`backspaceDelete` / `bye` / `repairResult{ok,launched,message}`。

⛔ **shutdown 语义已降级**：撤防 + bye + 断连，**不退出宿主**（.8li 与 PS 共命运）。
⛔ **uninstall**：清旧 daemon 遗留（自启项+安装目录）+ 撤防 + 停 WS 服务器；
重启 PS 后 .8li 自行恢复监听且 `g_khArmed` 复位为 1。

## 一键修复（repairKeyboard）分工

| 步骤 | 执行者 | 权限 |
| --- | --- | --- |
| ① 卸钩（必须先做，不等 UAC） | .8li 客户端线程直卸 | 无 |
| ② 复位 LowLevelHooksTimeout（>5000ms 删值） | .8li（HKCU） | 无 |
| ③ 释放 Ctrl/Alt/Shift/Win（keybd_event KEYUP ×8） | .8li | 无 |
| ④ 重启 ctfmon（toolhelp 枚举结束 + System32 重启） | .8li | 无 |
| ⑤⑥ pnputil 软重置键盘设备链 / 关 USB 省电 | `fix-keyboard.ps1`（ShellExecuteExW **runas**，`-JwElevated` 防循环） | 提权 |

⛔ .8li 装在 PS `Plug-ins\`，**推导不出插件根** ⇒ ps1 全路径必须由面板
（`resolveRepairScriptPath`：getPluginFolder + `native/HotkeyDaemon/fix-keyboard.ps1`）
随消息传参。修复后**不自动重挂**（防再冻），面板开关保持关。

## 面板侧（.8li 形态的新语义）

- 服务就绪 = WS 18923 可连；**不可启停**（.8li 常驻）。
- ToggleSwitch = 布防/撤防（`setHotkeyArm`）；checked = `connected && armed`；
  未连接时点击 ⇒ 引导「窗口 → 插件启用 JWautofill Smooth」。
- 状态条三态：未连接（橙）/ 服务已就绪·热键已暂停（橙）/ 热键已开启（绿）。
- 录制门禁：connected ∧ armed（撤防态 C 侧直接回 recordCancel，面板提前拦）。
- 安装/更新通路**未面板化**（M3 遗留）：.8li 需关 PS 后手动拷入 Plug-ins。

## 构建/部署

- `bash native/PiSmooth8li/build.sh`（zig，须沙箱外）：5 个 .c 零告警；
  PiPL 166 字节往返一致；版本仍 **0x0116**（keyhook 不动 PiPL/导出表）。
- 部署：关 PS → 拷 `build/JWautofillSmooth.8li` 进 PS `Plug-ins\` → 重启 PS。
- dist 瘦身：`webpack.config.js` 已删两个 exe 拷贝；⛔ copyWebpackPlugin 不清 stale
  ⇒ 改规则后**手删 dist 残留**并复验（本次 148M→11M）。
