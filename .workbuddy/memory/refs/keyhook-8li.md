# keyhook-8li：键盘钩子并入 .8li（M3，2026-10-17；M4/M6 收尾同日）

> HotkeyDaemon(65M) + FixKeyboard(76.5M) 已退役；WH_KEYBOARD_LL 改由
> `native/JWautofillHost/keyhook.c` 在 PS 进程内承载。面板协议零改（WS 18923 原样连）。
> 常量：`KH_PORT 18923` / `KH_VERSION "2026-10-17.1"` / `KH_BUDGET_MS 100` /
> `KH_STRIKES 3` / `KH_COOLDOWN_MS 30000` / `KH_MAX_ITEMS 256`。
>
> ⛔ **M4（2026-10-17 晚）**：① .8li 改名 **JWautofillHost.8li**（PiPL 名 "JWautofill Host"，
> 多功能合体后原名 Smooth 不再贴切）；② **整个 `native/HotkeyDaemon/` 项目已删除**
> （含两个 exe 与安装/卸载脚本，仅 `fix-keyboard.ps1` 随迁至 `native/JWautofillHost/`）；
> ③ **面板「卸载快捷键服务」菜单项已删**（.8li 无常驻可卸之物，旧 daemon 清理由
> .8li 启动时自动迁移完成）；④ `uninstall` 指令**不再停 WS 服务器**（见下）。
>
> ⛔ **M6（2026-10-17 深夜，用户三项要求）**：① **布防开关本地持久化**——
> `g_khArmed` 仍无磁盘态（.8li 侧零改），改由面板落盘
> `PluginData/settings/hotkey-arm.json`（`HotkeyBridge.ts` 的
> `loadPersistedArm/peekPersistedArm/persistArm`，串行写链）；hotkeyState 帧到达
> 即落盘（只写变化）；WS onopen 时若持久值为 **false** 补发一次 `hotkeyArm(false)`
> 恢复用户上次的关闭（.8li 重启后默认布防=true，不补发就自动重开）；持久值为
> true 但服务实际撤防（键盘修复后）时**不自动重挂**（修复流程约定"保持撤防"），
> 以 hotkeyStatus 回帧为准并顺势落盘。② 开关处文案去"服务"字样（状态条
> 「热键已开启 / 热键已暂停 / 未连接」；未连接引导改「JWautofill Host 未连接」）；
> ③ **暂停态去黄色**：`notify-bar-disabled`（中性灰+面板底色，与"关"档同款），
> 仅"未连接"保留 warn 橙；④ 开关 on/off **不再弹底部通知**（颜色变化即提示），
> 只保留未连接引导与发送失败错误。**开关持久化不依赖 .8li 改动**——`hotkeyArm`
> 消息 .8li 侧早已支持（keyhook.c:1780 kh_set_arm）。

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
`disarmDelete` / `repairKeyboard{script}`。
（`uninstall` / `shutdown` 为旧版面板遗留指令：M4 起新面板不再发送，服务端保留处理。）
服务端帧：`config` / `state`(getState) / `hotkeyState`(跃变广播+status回帧：
armed/hookInstalled/safeMode/active/comboCount/recording/timeoutMs/budgetMs/strikes) /
`hotkey`(命中) / `recordCaptured` / `recordResult` / `recordCancel` /
`backspaceDelete` / `bye` / `repairResult{ok,launched,message}`。

⛔ **shutdown 语义已降级**：撤防 + bye + 断连，**不退出宿主**（.8li 与 PS 共命运）。
⛔ **uninstall（M4 改）**：清旧 daemon 遗留（自启项+安装目录）+ 撤防 + bye + 关本连接；
**不再停 WS 服务器**（M3 旧行为：`g_khSrvStop=1` + shutdown listen ⇒ 要重启 PS 才恢复，
用户报「卸载后服务再也开不了」。根因 = .8li 不能退出宿主。现在 1.5s 内重连即恢复，
布防态由面板重发；面板入口已删，此指令只剩旧版兼容价值）。

## 一键修复（repairKeyboard）分工

| 步骤 | 执行者 | 权限 |
| --- | --- | --- |
| ① 卸钩（必须先做，不等 UAC） | .8li 客户端线程直卸 | 无 |
| ② 复位 LowLevelHooksTimeout（>5000ms 删值） | .8li（HKCU） | 无 |
| ③ 释放 Ctrl/Alt/Shift/Win（keybd_event KEYUP ×8） | .8li | 无 |
| ④ 重启 ctfmon（toolhelp 枚举结束 + System32 重启） | .8li | 无 |
| ⑤⑥ pnputil 软重置键盘设备链 / 关 USB 省电 | `fix-keyboard.ps1`（ShellExecuteExW **runas**，`-JwElevated` 防循环） | 提权 |

⛔ .8li 装在 PS `Plug-ins\`，**推导不出插件根** ⇒ ps1 全路径必须由面板
（`resolveRepairScriptPath`：getPluginFolder + `native/JWautofillHost/fix-keyboard.ps1`）
随消息传参。修复后**不自动重挂**（防再冻），面板开关保持关。

## 面板侧（.8li 形态的新语义）

- 服务就绪 = WS 18923 可连；**不可启停**（.8li 常驻）。
- ToggleSwitch = 布防/撤防（`setHotkeyArm`）；checked = `connected && armed`；
  未连接时点击 ⇒ 引导「窗口 → 插件启用 JWautofill Host」。
- 状态条三态配色（M6 改）：未连接（橙 warn）/ **已连接·开关关闭（中性灰
  `notify-bar-disabled`+`indicator-disabled`，暂停态不呈现任何颜色）** / 热键已开启（绿）。
- 开关初值 = `peekPersistedArm() ?? true`（无落盘值时按 .8li 默认布防），
  挂载时再 `loadPersistedArm()` 兜底补读；真实状态以 hotkeyState 回帧为准。
- 录制门禁：connected ∧ armed（撤防态 C 侧直接回 recordCancel，面板提前拦）。
- 安装/更新通路**未面板化**（M3 遗留）：.8li 需关 PS 后手动拷入 Plug-ins。
  ⚠️ M4 改名后部署 = **先删旧名 JWautofillSmooth.8li**，再拷 JWautofillHost.8li
  （两个同名不同名的 .8li 同时在场会抢 18923/18924 端口，必须二选一）。
- ⛔ M4 起面板**没有**「卸载快捷键服务」入口（MenuManager / AdjustmentMenu /
  AdjustmentPanel / HotkeyBridge / BrushHotkeySection 五处已清）；旧 daemon 的
  自启项+安装目录清理改由 .8li 启动时的 bind 失败迁移自动完成。

## 构建/部署

- `bash native/JWautofillHost/build.sh`（zig，须沙箱外）：5 个 .c 零告警；
  PiPL **162** 字节往返一致（M4 改名 "JWautofill Host" 后比旧名少 4 字节）；
  版本仍 **0x0116**（keyhook 不动 PiPL/导出表）。
- 部署：关 PS → 拷 `build/JWautofillHost.8li` 进 PS `Plug-ins\` → 重启 PS。
  ⚠️ 旧名 `JWautofillSmooth.8li` 必须同时删掉（见上一节）。
- dist 瘦身：M3 删两个 exe 拷贝、M4 删整个 daemon 项目 ⇒ dist 11M，
  `native/` 下只剩 `JWautofillHost/fix-keyboard.ps1` 一个随包脚本；
  ⛔ copyWebpackPlugin 不清 stale ⇒ 改规则后**手删 dist 残留**并复验
  （M3 148M→11M；M4 清 `dist/native/HotkeyDaemon/` 6 个旧脚本）。

## N7. 0x0123（2026-10-17 晚）：**首次加载热键全失效**（用户报「开关持久化为开、按旧快捷键无效、重录一条才恢复」）

**根因**：热键表（`g_khMap`）此前**只有两条路会重建** —— `kh_save_config()`（面板保存）
与 `kh_set_config_path()`（路径真的变了）。而 `keyhook_init()` 里那次 `kh_reload()` 若
撞上配置暂时不可读 / 路径尚未对齐（失败分支按设计**保留旧表**=保留空表），
之后面板建连的 `setConfigPath` 因路径相同直接 `if (!changed) return;` 早退、
`getConfig` 分支**只读文件回帧、根本不碰热键表** ⇒ 空表一直留到用户重录一条
（重录 → kh_save_config → kh_reload 才填上）。这解释了「重录一个，全部恢复」。

**三处修（0x0123）**：
1. 抽出 `kh_map_apply(items, n)`（过滤空 combo / 重复键 → `kh_map_publish`），
   `kh_reload` 与 `getConfig` 共用；
2. `getConfig` 分支读文件后补 `kh_map_apply`（解析失败仍保留旧表，与 kh_reload 同语义）；
3. `kh_set_config_path` **路径未变也 `kh_reload()`**（握手时一次文件读，成本可忽略）；
4. watchdog 新增 ⑦：启动 1.5s 后「`kh_map_count()==0` 且配置文件存在」强制补载一次。

⛔ 排查口径：以后遇到「热键静默全失效」，先看 keyhook 日志有无
`热键表已装载：配置 N 条 / 可匹配 M 条`（N>0 但 M=0 ⇒ 键名规范化问题，不是本 bug）。
