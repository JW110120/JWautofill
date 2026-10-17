# JWautofill 项目记忆（主索引）

> 本文件 = 索引 + 铁律速查（保持精简）；明细在 `refs/`，流水在 `memory/YYYY-MM-DD.md`。
> ⛔ 违反必炸｜⚠️ 易复发。架构：套索平滑 + 键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，产物 JWautofillHost.8li）。
> **M3（2026-10-17）**：键盘钩子（WH_KEYBOARD_LL）并入同一 .8li（`keyhook.c`，WS 18923），面板开关语义 = 布防/撤防（服务不可启停）。
> **M4（2026-10-17 晚）**：.8li 改名 JWautofillHost（多功能合体）；**整个 native/HotkeyDaemon/ 项目删除**（两个 70M 级 exe + 安装/卸载脚本，仅 fix-keyboard.ps1 随迁 JWautofillHost/）；面板「卸载快捷键服务」菜单移除；`uninstall` 指令不再停服务器（可反复布防）；套索平滑文件迁 `src/hotkey/` → `src/lasso/`。

## 索引

| 要动的东西 | 先读 |
| --- | --- |
| 填充 / 描边 / 清除 | `refs/fill-and-stroke.md` |
| CSS / 布局 / 面板 / 主题 | `refs/frontend-css.md`（技能 `uxp-frontend-spec`） |
| 忙碌闸门 / 模态 / 世代号 | `refs/busy-gate.md` |
| UXP 接口 / 性能 / React | `refs/uxp-api-layer.md` |
| 像素处理器算法 | `refs/pixel-algorithms.md` |
| 构建 / IO / 部署 | `refs/toolchain-and-env.md`（M4 起原生侧只有 .8li 一个产物） |
| 平滑 / HUD / 断流 / 笔通路 | `refs/lasso-smoothing.md`（O1 断流·O2 HUD·O4 axMax·O5 补流·O6 'slct'·O7 .8li·O8 进程内模态层级/Wintab 上下文钩·**O9 'slct' 看门狗让位 0x0115**·**O10 HUD 焦点门 0x0116**） |
| 键盘热键钩子 / WS 18923 / 一键修复 | `refs/keyhook-8li.md`（M3 钩子线程模型·熔断三件套·单持有者·旧 daemon 迁移·repairKeyboard 分工·面板布防开关；**M4 uninstall 不停服务器+菜单入口已删+daemon 项目删除**） |
| modal scope 开销来源 | `docs/modal-scope-audit.md`（第五节 = 2026-10-17 复核出的遗漏 G/H） |

**校验**：改 CSS 跑 `scripts/_css_comment_guard.cjs` + `_modal_contract_guard.cjs` + `_color_picker_contract_guard.cjs`（只扫 `src/styles/*.css`，**不扫 `theme.ts`**）；`npx tsc --noEmit` 只看 `src/` 新增报错；改 `native/JWautofillHost/*.c` 跑 `build.sh`（零告警）+ 导出表解析核验 `jwwh_version`；改面板 `yarn build`。

**地图**：`app.tsx` 填充面板 · `AdjustmentPanel.tsx` 工具箱 · `psProbe.ts`+`psAccess.ts` 闸门 · `ClearAlgorithms.ts` 清除 · `adjustments/*Processor.ts` 像素算法 · `common.css`+`theme.ts` 样式 · `src/hotkey/`（WS 18923 热键） + `src/lasso/`（`LassoSmoothing.ts` 状态机 + `SmoothBridge.ts` WS 18924，**两端点都在 .8li 内**） · `native/JWautofillHost/`（`smooth_engine.c`·`plugin_main.c`·`ps_tool.c`·`ws_core.c`·`keyhook.c`·`fix-keyboard.ps1`）。

## 铁律速查

1. ⛔⛔ **提交**：代码+日志+记忆**合成一次提交**；定稿才提交（toolchain §八）。
2. ⛔⛔ **IPC 数字双防御**：`toWire()` 一律 `Math.round`；原生侧 `double?`+Round（漏则整条消息被丢，O7）。
3. ⛔⛔ **.8li**：PiPL 头 10 字节；`'8664'` 导出名=**C 字符串**；版本走导出表解析（O7）。
4. ⛔⛔ **`'slct'` 三态接管**：只有 `2` 停轮询；同步三处（停表/`applyToolGate()` return/不写 `I_TOOLGATE`，O6）。**边沿触发无心跳 ⇒ 接管带 2s 时效**，面板唯一判据 = 原生下发的 `gateOwned`，绝不自己比阈值（O9）。
5. ⛔⛔ **px 权威 = 屏幕/lcOutExt**，非 lcInExt；`axisMax` 每次标定重算（O4）。
6. ⛔⛔ **拉绳定长**：`f = 1 − rope/dist`；1px + 二次贝塞尔，**不画锥形**。
7. ⛔⛔ **HUD**：保留 `WS_EX_TRANSPARENT`；`WS_EX_TOPMOST` 写进 `CreateWindowExW`；不加可见装饰（O1）。
8. ⛔ **断流**：对 Wintab **只读不写**；判读 = `[stall]` 与 `[dead]` 差集（O1）。
9. ⛔ **闸门**：`isPsBusy()`+文档闩锁+`psRead()`；禁采信 `core.isModal()`；空闲巡检 <3.3/s。
10. ⛔ **像素常量**先问物理/逻辑，一律 ×`dpiS`；`putPixels` 默认 `replace=true` 清空整层；`theme.ts` 注释写在 `{ }` 外。
11. ⛔⛔ **进程内模态层级是三态、且禁止并进 `isPsBusy()`**：`psBusyInProc()` = `1`确定忙/`0`确定闲/`-1`不可用；后者是否定式安全闸，合并会把用户主动的填充也挡住。层级**只给巡检类入口**用（O8）。⛔ `-1` 绝不能当 `0` 用。
12. ⛔ **会改写宿主结构的开关一律外置 ini**（`%LOCALAPPDATA%\JWautofill\smooth8li\wtctx.ini`，缺文件=只观测）；改口径不以重编 .8li 为代价（O8）。
13. ⛔ **`CFG_NLONGS` 现为 58**：动槽位表时 `plugin_main.c` 与 `smooth_engine.c` **同步改**（不同步=静默截断，不报错）。
14. ⛔ **两本日志分工**：PICA/ps_tool 的一切看 `%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log`；`%TEMP%\jwwh-<pid>.log` 是引擎日志，**按设计不含 ps_tool 一行**。
15. ⛔⛔ **HUD 显隐 = 显式 AND 门，每项都是必要条件**（O10）：窗口在·有包流·工具套索∧笔尖接触·一笔之中·前台本进程·**焦点在活动文档画布**（主框 `class="Photoshop"`+`MDIClient` 子树+光标在文档区矩形）·**落笔判据已建立**（`!g_ctUnknown`）·非断流/大跳跃/帧滞后·拉绳模式·面板 bit0·总开关。Wintab 系统上下文与焦点无关 ⇒ 面板上落笔包照常进 ⇒ **必须问 Windows 要焦点**。⛔ `ctOk` 只门 HUD，不改平滑 fail-open。

## 维护约定

超限先下沉 refs 再精简本文件。技能：`uxp-frontend-spec`、`algo-param-bench`。
