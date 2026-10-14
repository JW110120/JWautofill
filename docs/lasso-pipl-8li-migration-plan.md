# 套索平滑架构迁移：.8li 进程内插件（实施计划）

> 2026-10-14 启动。目标：把「外置 SmoothDaemon(18924) + 注入 WintabHook DLL」链路
> 迁移为 **PS 进程内合法插件**，从类别上消灭问题一（易失效）的整类故障面：
> 注入/state=4 须重启/DLL 锁自安装/守护进程心跳/跨进程状态撕裂。
> 背景：本机 `MouseHookPro64.8li` 实为 **Lazy Nezumi Pro** 的进程内模块（PiPL 明文可证），
> 证明「PS 进程内 hook 输入」是 LN 级成熟工具走通的路。

## 0. 已破解的关键事实（勿凭记忆改动，全部来自真机逆向/官方文档）

| 事实 | 来源 |
| --- | --- |
| Automation(.8li) 入口：`SPAPI SPErr AutoPluginMain(const char* caller, const char* selector, void* message)` | Adobe UXP bridging 官方文档；MaterialSuite.8li 同款导出 |
| `SPMessageData { int32 SPCheck; SPPlugin* self; void* globals; SPBasicSuite* basic; }`（x64 布局 0/8/16/24） | Adobe Programmer's Guide |
| 消息常量：caller `"SP Interface"` + selector `"Startup"/"Shutdown"`；caller `"SP Access"` + selector `"Reload"/"Unload"` | 同上（Illustrator/PS 共用 SP 层，待 M1 真机日志实证） |
| PiPL 二进制格式：头 `01 00 | 00 00 00 00 | count`；属性 = `8BIM` + 反转四字属性名 + `00000000` + len + 数据（4 字节对齐 Pascal 串） | MouseHookPro64.8li/MaterialSuite.8li 逆向，标本 `native/PiSmooth8li/build/sample_*.bin` |
| kind 值 `'8LIZ'` = Automation 类；`'8664'` 属性 = **x64 入口导出名**（PS 靠它找入口）；`catg = "**Hidden**"` 隐藏 | 同上（两标本均为 `8LIZ` + `4668`→入口名） |
| 新版可用 `'JSON'` 资源（名 `JSON_PIPL`）替代二进制 PiPL；二进制 PiPL 在 PS2026 仍有效 | CropPhotosAuto.8li（JSON）vs MouseHookPro64.8li（二进制） |
| 后续可走 `PIUXPSuite` 与 UXP 面板**进程内直连消息**（替代 WS） | Adobe UXP bridging 文档：`SendUXPMessage` ↔ `require('photoshop').messaging` |

工具链：zig cc（无 MSVC/rc.exe）→ PiPL 用 `tools/embed_res.py`（ctypes `UpdateResourceW`）后注入，
`tools/pe_res_extract.py` 为 PE 资源/导出表自验器。构建 `bash native/PiSmooth8li/build.sh`。

## 1. 里程碑

- **M1（本轮）加载验证**：`build/JWautofillSmooth.8li`（kind 8LIZ/Hidden/AutoPluginMain）。
  行为 = 记录一切消息到 `%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log` + 起 WS 骨架（18924，
  被旧 daemon 占用则记录退出）。**验收 = 重启 PS 后日志出现 Startup、面板无异常**。
  ⚠️ M1 与 SmoothDaemon 并存无害（bind 失败即退）。
- **M2 hook 移植**：`wintab_hook.c` 以源码级并入（`-DPI8LI_BUILD` 跳过 DllMain 自启动、
  共享内存段改为进程内直读；HUD 渲染线程原样保留），AutoPluginMain Startup/Unload
  直接调 hook init/teardown。WS 协议对 SmoothBridge.ts 保持逐字兼容（面板零改动）。
- **M3 安装/卸载与分发**：安装 = 拷 `.8li` 进 PS `Plug-ins\`（各版本路径探测）；更新 = 关 PS 拷贝
  （PS 锁已加载模块，与旧 DLL 同律）；卸载脚本回收；SmoothDaemon 从分发包移除。
- **M4（可选）PIUXPSuite 直连**：面板 `addSDKMessagingListener` ↔ `.8li` `AddUXPMessageListener`，
  去 WS 化；工具状态经 SDK suite 读取，绕开 batchPlay 巡检（对问题三有附带收益）。

## 2. 风险与对策

- **消息常量措辞**：文档来自 Illustrator 手册，PS 可能大小写/用词不同 ⇒ M1 入口对所有消息
  逐字落日志，`_stricmp` 兜底；实测为准后回填常量。
- **SPCheck 值**：`kSPValidSPMessageData` 具体值未确证 ⇒ M1 只记录不校验。
- **卸载顺序**：PS 进程内模块不可强卸 ⇒ 只做「停线程 + 日志」，等 PS 退出自然回收。
- **与旧链路并存**：M2 验收前 SmoothDaemon 保持可用；迁移切换 = 面板服务开关（旧 daemon
  停用 + 新插件生效），不做运行时双写。

---

## M1 完成记录（2026-10-14 真机）

- `JWautofillSmooth.8li` 已驻留 Photoshop.exe 27.8.0（tasklist /m 实证），入口 `AutoPluginMain` 被调用。
- **一手消息协议**（与 SDK 文档不同，以此为准）：
  - 加载：`caller="SP Access" selector="Reload"`（文档写的 "SP Interface"/"Startup" **不会出现**）
  - 卸载：`caller="SP Access" selector="Unload"`
  - `SPCheck=0x5350436B`（'SPCk'），`self` = SPMessageData 指针，x64 布局 0/8/16/24 实测成立。
- 排障史（防复发）：① PiPL 头部必须 10 字节；② `'8664'`（入口导出名）属性是 **C 字符串**（NUL 结尾），写成 Pascal 串 ⇒ PS 读到脏名 ⇒ GetProcAddress 失败 ⇒ attach 后 1ms 静默卸载。
- 对照实验结论：PS 加载器认 PiPL+导出内容，不认文件路径/签名（MouseHookPro 逐字节拷贝改名照样驻留）。
- PiPL 生成器：`tools/gen_pipl.py`（pstr/cstr 分立）；资源注入 `tools/embed_res.py`（ctypes UpdateResource，id=16000）；PE 自验 `tools/pe_res_extract.py`。

---

## M2 完成记录（2026-10-14 真机部署）

- **合并镜像**：`plugin_main.c`（WS 协议层，Program.cs ROLE_SMOOTH 的 C 移植）+ `smooth_engine.c`（`wintab_hook.c` 整体编入，仅两处补丁：cfg_open 的 CreateFileMappingW 兜底、DllMain→engine_dllmain 由插件入口转发）。产物 233,984 字节，导出 AutoPluginMain / jwwh_version / jwwh_unhook / jw8li_version。**不再有守护进程、不再注入**；命名共享内存节保留为模块内两半的传导介质（槽位表逐项不变）。
- 独立实测（不依赖 PS，python 手写 WS 客户端）：RFC6455 附录 A 已知向量握手 ✅、smoothStatus 探针回帧全字段 ✅、penSmooth 参数逐项落槽 ✅、开关跃变 cmd=1/2 ✅、off 归零 ✅。
- 过程中抓到并修复的三个真 bug：
  1. SHA1 轮函数状态轮换写错（c=b / b=rotl30(b)）⇒ accept 错误、真实 UXP WebSocket 会拒握手。⛔ 教训：自写密码学原语必须用**已知向量**实测（RFC6455 Appendix A）。
  2. smoothState 的 `dll` 字段未转义反斜杠 ⇒ JSON 非法、面板 JSON.parse 整帧被丢。
  3. commit() 漏写本地 g_enabled 副本 ⇒ smoothState 的 enabled 恒 0（槽位已写但 JSON 读本地）。
- WS 层职责映射：penSmooth→CFG 槽（含 toolGate/GATETS 同写）、smoothState 500ms 差分推送（SmoothStatePump）、心跳 500ms 写 I_HEARTBEAT（引擎 >3000ms 判死）、cmd 去重（只在开关跃变下令，防 toolGate 心跳反复重置标定）、HealIfUnhooked 同款自愈（state==3 或 state==0&&calls==0 → cmd=1，冷却 2s，零调用自愈限 8 次）。
- ⛔ 部署：PS 运行时锁 Plug-ins 里的 .8li ⇒ 覆盖前必须完全退出 PS。旧 SmoothDaemon 不再需要；若它仍在运行会占 18924 ⇒ .8li bind 失败（日志有明确提示）。
- 待真机验收：PS 重启后日志出现 Reload + M2 服务已启动 + 面板连接；开启平滑后套索运笔应生效且 HUD 显示（引擎在进程内，免注入免心跳链路）。
