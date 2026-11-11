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

## N8. 0x013A（2026-10-19 下午）：**配置读写格式不闭环——保存即损坏**（用户实测三连：快捷键全失灵 / 已录条目加载后消失 / 混合模式开关秒弹回）

**根因**：`kh_items_to_json` 自 M3 移植（aead9c0）起**漏写 JSON 数组括号**，输出是裸对象逗号拼接；而 `kh_parse_items` / `kh_read_config_file` 双双严格要求 `'['` 开头 ⇒ 每次 `kh_save_config` 落盘后紧跟的 `kh_reload` 必判「解析失败」保留旧表（**面板推的新条目永远进不了热键表**），broadcast 还带空 payload 把面板已录条目清空。用户磁盘上的 hotkeys.json 即 `{"id":...},{"id":...}` 无括号实况。三个症状一个根因：A 全失灵=表从未更新+启动读坏文件；B 条目消失=空 payload 广播；C 开关秒弹=回帧无 blendHotkey 条目。

**修（0x013A，keyhook.c 五处 + plugin_main.c 一处）**：
1. `kh_items_to_json` 输出标准 `[...]`（循环内为 `]`+NUL 预留 2 字节，`cap<4` 拒绝）；
2. `kh_reload` 广播点与 `getConfig` 回帧点的**手工 `[ %s ]` 包裹同步拆除**（否则面板收到 `[[...]]` 被 `Array.isArray` 拒之门外＝另一个"条目全空"）；
3. `kh_parse_items` + `kh_read_config_file` 放行旧版无括号格式（迁移桥：救回用户已录条目，否则面板会用空视图覆盖保存重演 2026-10-13「热键全没了」）；下次保存自动转标准格式，检测到旧格式时留痕日志；
4. 附属（逻辑测试 T8 抓出的潜伏缺陷）：`json_str` 旧写法见 `"` 即停，把 `\"` 误判串尾截断字段 —— 改为成对拷贝转义序列由 `kh_unesc` 还原；对不含转义的现存输入零行为变化。

**验证**：`analysis/_t_013a.c`（逐字拷贝五函数）18/18 过：标准/旧格式解析、往返一致（含 blendHotkey 标志条目）、空数组、垃圾截断拒绝、转义往返；`_t_013a_check.py` 用 python json 严证广播帧 `Array.isArray(payload)=true`；build.sh 零告警 + PiPL 往返一致。

⛔ 排查口径：见到 `配置读取/解析失败` 与 `配置已写入` 交替振荡 = 本 bug 家族；先 `cat` 配置文件看有没有 `[`。**写文件的序列化器与读文件的解析器必须成对验收**（单测序列化产物必须能被自己的解析器读回——这次就是缺了这一条）。

## N9. 0x0205（2026-10-23）：**插件本体不在位也吞键**（用户报「没加载 UXP，但 L/NUM1 按不了」）

**根因**：`.8li` 随 PS 启动即装载、`keyhook_start` 默认布防（`g_khArmed=1`），
而 UXP 插件本体可能根本没加载（开发期没装/没启用）⇒ 钩子照装、RegisterHotKey
照注册，按键被吞后广播无处可送（零客户端）——用户画图时套索 L、NUM1 全失灵。

**修（keyhook.c + ws_core.c + plugin_main.c，jw8li_version 0x0204→0x0205）**：
1. 新全局 `g_khPlug`（0x0205）：18923 有活客户端 = 插件本体在位。与 `g_khArmed`
   正交——布防是用户开关偏好，在位是插件本体生死，两者同时为真才装钩。
2. **三条键路统一加闸**（漏一路 = 热键照样触发或键照样被吞）：
   - 钩子线程安装意图 `want = g_khBound && g_khArmed && !g_khSrvStop && g_khPlug`；
   - `kh_poll_step` 的 `armed`（轮询吞不了键，但触发无人执行 = 噪声，一并闸）；
   - `kh_hk_sync` 的 `want`（RegisterHotKey 是**真·系统级吞键**，NUM1 类裸组合键走它）。
   - `kh_install_hook` 内部也查 `g_khPlug`（双保险，防将来新增调用点漏闸）。
3. `kh_plug_recompute()`：扫客户端表（s 有效 ∧ !closing ∧ !notPlugin）重算在位；
   建连（握手后）与断连（`kh_cli_remove` 后）都调。多面板/多 JS 上下文各一条连接，
   全部消失才算不在位 ⇒ 卸钩 ≤10ms（钩子线程轮询）+ 撤注册 ≤100ms（kh_hk_sync）。
4. ⛔ **不做「连过一次就粘住」**：面板卸载/崩溃后钩子必须熄火（0x013E unload 哑火
   同族纪律）。断开即放行，重连自动装挂（面板 1.5s 重连循环天然覆盖抖动）。

**多开 PS 坑（自查发现，同批修）**：bind 18923 失败的实例每 10s 执行
`kh_try_migrate`（迁移探测）——它本身就是一条 WS 客户端连接，会被持有端计成
「插件在位」⇒ 持有端周期性假布挂。修：探测走 `path=/jw-migrate`；`wc_handshake`
  重构为 `wc_handshake_ex` + 新增 `wc_handshake_path`（抽请求行 path，仅作身份识别）；
  `KhCli` 加 `notPlugin` 标记，非 `/` 不计在位。旧版 daemon 不校验 path ⇒ 迁移链路无损。

**验收口径**：不加载插件 ⇒ pi8li.log 见「插件本体不在位…不装键盘钩子」，L/NUM1 透传；
加载插件开面板 ⇒ 「插件本体在位…按布防态装挂」+ 热键正常；关面板/卸载 ⇒ 「卸键盘钩子…
全部放行」。

**已知边界（正解留待后续，非本次范围）**：「在位」= 有面板连着。插件加载但面板全关时，
新版放行按键（旧版吞键且无人执行——严格不劣）。若要「面板关着热键也能用」，应把 WS 连接
从面板生命周期挪到**插件容器生命周期**（UXP `entrypoints.setup` 的 `plugin.create/destroy`，
Adobe 文档确认容器与面板是两套独立生命周期），C 侧闸无需再动。

---

## N10. 0x0206（2026-10-23）：**热键跑一阵子就「未连接」且无法自愈**（用户报「必须重启 PS 再 load 才恢复」）

两个独立缺陷叠在一起，才能解释「跑一阵子突然断 + reload 也没用」：

1. **空闲 60s 被自己踹掉**（`ws_core.c`）
   `wc_client_loop` 设了 `SO_RCVTIMEO=60s`，而 `wc_recv_all` 把「超时」和「对端关闭」一起返回 -1
   ⇒ 会话循环按断开处理。面板闲着时根本不发消息 ⇒ **每 60s 必断一次**，面板 1.5s 后重连，
   再 60s 又断，循环往复。
   修：`wc_recv_all` 首次 `recv` 就超时（`got==0 ∧ WSAETIMEDOUT`）返回 **-2 = 空闲**；
   `wc_read_frame` 原样上交；会话循环 `continue` 并**顺手发一次 ping**（0x9，对端按 RFC 回 pong
   被 0xA 忽略；对端 TCP 半开时 send 失败 ⇒ 照样回收，不留僵尸）。读到半帧才超时仍按错误断开。
   ⛔ 别把 -2 并进 -1，也别在 -2 时清 `acc`（续帧可能正等着后续帧）。

2. **客户端表槽位泄漏**（`keyhook.c`，真正的「reload 也救不了」）
   `kh_cli_remove` 把槽位标 `closing=1` 就返回，而 `kh_cli_add` 准入是
   `s==INVALID_SOCKET ∧ !closing` ⇒ 每次断开**永久废掉一格**。表只有 `KH_MAX_CLI=8` 格
   ⇒ 第 9 次连接起，accept 上来的新连接全被拒收 + closesocket ⇒ 面板永远「未连接」。
   表在 PS 进程里，UXP reload 只换 JS 上下文 ⇒ 只有重启 PS 才清零（与用户描述完全吻合）。
   修：归还槽位时 `s=INVALID_SOCKET; closing=0; notPlugin=0`；准入只看 `s == INVALID_SOCKET`。
   另：握手失败路径改「**先还槽位再 closesocket**」——反过来时系统可能立刻把同一 SOCKET 值
   发给下一条 accept，随后的 `remove(s)` 会按值**误删新连接**。

**诊断口径**（下次再报「未连接」先看这两行）：
- `pi8li.log` 里 `客户端表已满（8 条仍在位）⇒ 拒收新连接` → 槽位泄漏复现；
- 断连日志每 ~60s 一条 `reason=recv错误` → 空闲超时被当断开。
**验收**：挂机 >10 分钟不断；反复 reload 面板 10 次以上仍能连上。

---

## N11. 0x0226（2026-11-11）：**裸数字键笔刷热键顺带改 PS 画笔不透明度**

**用户报**：笔刷热键绑 `Num1–Num9`，按 Num5 调笔刷时画笔不透明度被改成 50%。
配置实况（External 版 `PluginData/hotkeys.json`）：`Num1–Num7 → applyBrush`，另有
`H → toggleMain`、`L → focusLasso`、`Shift+E → focusClear`、`Shift+/ → pickColor`、
`/ → altTool`；共 11 条可匹配，其中 **9 条是裸键**。

**根因（三件事实叠起来）**：
1. `kh_combo_to_hotkey()` 里有一句 `if (!m) return 0;` —— 主动把所有无修饰键的
   裸键排除在 RegisterHotKey 之外；0x013D 段的旧注释还写成「RegisterHotKey
   必须有修饰键、裸键注册不了」，**这是错的**。本机实测
   `RegisterHotKey(NULL,id,0,VK_NUMPAD5)` 与 `MOD_NOREPEAT|(mods=0)` 对
   `VK_NUMPAD5`(0x65)、主键盘 `5`(0x35)、`Num1`(0x61) 全部返回 TRUE。
2. 真机 `pi8li.log`：`[kh] 按键通路：钩子 +0 / 轮询 +1`，且反复出现
   `[kh] 钩子失活（轮询 +1 / 钩子 +0）⇒ 第 N 次强制重装` ⇒ **PS 前台时
   WH_KEYBOARD_LL 整段收不到键**（0x013C 已证），唯一能吞键的钩子通路实际上没干活。
3. 于是 9 条裸键全部由 `kh_poll_step` 的 100ms 键态轮询兜底触发，而轮询
   **只旁观、不吞键** ⇒ 数字键原样落进 PS；PS 在画笔类工具下把 1–9 当
   「不透明度 10%–90%」、0 当 100% ⇒ 切笔刷与改不透明度同一击发生。
   日志 `RegisterHotKey 接管 2 条（裸键交给钩子/轮询 9 条）` 正是证据
   （那 2 条是 `Shift+E`、`Shift+/`）。

**修（keyhook.c 四处 + plugin_main.c 版本，jw8li_version 0x0225→0x0226）**：
1. 删掉 `kh_combo_to_hotkey()`，新增 `kh_is_digit_vk(vk)`
   = `0x30–0x39`（主键盘 0–9）∨ `0x60–0x69`（小键盘 Num0–9）。
2. `kh_hk_sync()` 改用 `kh_combo_to_key()`（它本就允许裸键），循环里加一条：
   `if (!mods && !kh_is_digit_vk(vk)) { bare++; continue; }`
   ⇒ 只把**表内实际绑定的数字类裸键**纳入系统级独占；按键从输入队列摘走，
   PS 收不到 WM_KEYDOWN/WM_CHAR ⇒ 不改不透明度。
3. 命中仍由既有 `WM_HOTKEY → kh_hk_fire()` 兑现；`kh_dual_mark(combo)` 的
   400ms 指纹压住「轮询仍读到物理键态」的影子，不会双广播。
4. 日志改成 `RegisterHotKey 接管 N 条（其中裸数字键 M 条；其它裸键交钩子/轮询 K 条，
   被占用 B 条）`，M 就是验收计数。

**⛔ 边界（故意不动，别顺手扩大）**：
- 字母/符号裸键（H、L、`/`…）**仍不注册**，避免在 PS 文本框打字时被系统级
  摘键；临时吸管 `altTool` 的按住电平语义也不受影响。
- 录制期 / 失焦 / 插件不在位 / 熔断 / 0x0224 混合模式让位，这些既有
  `kh_hk_sync` 的 `want` 与跳过条件逐字未动；失焦全撤保证别的程序里 Num5 正常。
- 代价：绑了裸数字键之后，PS 内**这些数字键本身就归插件了**（含输入框里敲
  同一个数字），主键盘数字与小键盘分开，用户可用另一套输入，或给热键加修饰键。
- 若某条被别的程序抢先注册，`bad++` 并退回「不吞键」旧行为，日志会留
  `⚠️ 部分组合键已被其它程序注册为全局热键`。

**验收**：重启 PS 后看 `pi8li.log` 出现 `RegisterHotKey 接管 9 条（其中裸数字键 7 条；
其它裸键交钩子/轮询 2 条，被占用 0 条）`；按 Num5 只切「绸光涂抹」，画笔
不透明度保持原值；切到别的程序按 Num5 仍正常输入。

---

## N12 · 0x0228 文本输入闸门（H/L 在另存为对话框被摘键）

**现象**：图层名内联编辑里 H、L 能打出来；另存为图片弹出的窗口里输入 H、L
却被摘键。⚠️ 上一节（N11）写的「字母/符号裸键不注册 ⇒ 文本框安全」只对了一半。

**真因**：H/L 确实**没注册**（日志「其它裸键交钩子/轮询 2 条」= H 与 L），
但 LL 钩子在**原生对话框**里能收到键。PS 主窗口按键进不了钩子链
（`按键通路：钩子 +0 / 轮询 +1`），图层名编辑框因此只被「不吞键」的轮询碰过；
对话框里钩子一命中 H/L 就 `return 1` ⇒ 字符进不了输入框。
同一键两处结果相反 ⇒ ⛔ 别再从「注册了哪些键」推文本框行为，要看
「这一击有没有进 LL 钩子链」。

**新增 `g_khTextGuard`（`kh_text_input_probe` / `kh_text_input_update`）**
- 每 10ms 在 `kh_poll_step` 里只读探测：① 前台类 `#32770`；② `WS_EX_DLGMODALFRAME`；
  ③ `GW_OWNER` 存在且宿主 `!IsWindowEnabled`（模态）；④ 焦点控件类
  Edit/RichEdit/ComboBox/TextBox/AtlEdit/WindowsForms10.Edit；⑤ `hwndCaret` ∧
  `GUI_CARETBLINKING`（缺一不可，只认句柄会读到残留值把闸门永久钉死）。
- 400ms 黏滞盖住光标暗相；**LL 回调只读一个 volatile LONG**，零 Win32 查询。
- 诊断串 `文本输入闸门 0⇒1（fgCls=... focusCls=... why=N caret=...）` 只在翻面打；
  对话框没被识别时（`why=0`）拿这两个类名补规则即可。

**四条键路的接入点（缺一就漏）**
| 路 | 位置 |
|---|---|
| LL 钩子 | `kh_dispatch` 前台判定之后、退格删绑之前：整击 `CallNextHookEx`，⛔ 不记 `kh_dual_mark` |
| 轮询 | `kh_poll_edge` 在 `kh_ps_foreground()` 之后 `if (g_khTextGuard) return;` |
| RegisterHotKey | `kh_hk_sync` 的 `want` 加 `!text` + 新状态位 `g_khHkText`；同步 100ms→10ms；`kh_hk_fire` 压迟到 WM_HOTKEY |
| 按住键电平 | `altHold` 块加 `holdVk && g_khTextGuard` 分支，`s_altArm=0` 作废起按准入 |

**⛔ 纪律**：录制分支必须留在闸门之前；`kh_is_digit_vk`、混合模式让位、在位/布防/
失焦/熔断门逐字不动；⛔ **不要手写 `WINVER`/`_WIN32_WINNT`** —— 默认档已同时声明
`GUITHREADINFO` 与 `MOD_NOREPEAT`，显式写 0x0600 会把后者藏掉导致编译失败。

**验收**：另存为文件名框能敲 H、L、数字、退格且不触发热键；日志出现
`★诊断：文本输入闸门生效 ⇒ 整击放行 vk=0x48/0x4C`；关掉对话框回画布，
H/L / Num1–7 照常（离开输入框 ≤400ms 黏滞属预期）。详见 `2026-11-11.md`。
