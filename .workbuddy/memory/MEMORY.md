# JWautofill 项目记忆（主索引）

> 只留「编号 + 一句话 + refs 指针」；明细在 `refs/`，里程碑在 `HISTORY.md`，逐条实证在 `2026-11-*.md`。
> 架构：平滑+键盘钩子＝PS 进程内 .8li（`native/JWautofillHost/`，WS 18924/18923）。里程碑与逐条实证见 `HISTORY.md` 与 `2026-11-*.md`。

## 索引（`refs/` 下）

`fill-and-stroke`（填充/描边/清除）｜`frontend-css`（CSS/面板/主题）｜`busy-gate`（闸门/模态）｜`uxp-api-layer`（UXP/API/性能）｜`pixel-algorithms`（像素）｜`toolchain-and-env`（构建/部署）｜`lasso-smoothing`（平滑/HUD/断流/闸门/吸管，O22–O62）｜`keyhook-8li`（键盘钩子/滚轮热键 0x0235）｜`brush-mixer-reservoir`（混合器）｜`brush-size-preset`（Shift+[ / Shift+] 三档改笔尖，**无需改 .8li**，档位=像素数分段对数插值）｜`poly-snap-0x0211-0x021F`（临时模式/冻结/吸附）｜`blend-hotkey-yield-0x0224`（混合模式让位）｜`tool-ring-0x023A`（工具图标呼吸外框 → 0x023B 流光/重定标 → 0x023E `RING_DX_NUDGE=3`/`RING_DY_NUDGE=1` **固化进常量**，⛔ 产品位置禁止靠 ring.ini；见 `2026-11-18.md` 第 8–12 轮）｜`ironrules-1-89`（1–89 全文）｜`ironrules-90-129`（90–129 全文）

**UXP 坑（2026-11-18 实证）**：`wheel` **不沿冒泡/捕获传播**，只在"最近的滚动容器/该元素自身"派发 ⇒ 要给元素滚轮就必须挂到整条祖先链（见 `NumField` 分发器）。

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`）；改 .c 跑 `build.sh`（须沙箱外）零告警 + 导出表 5 项；改面板**别跑 `yarn build`**（那会产出 production 覆盖 `yarn watch` 的 dev 构建）—— watch 会自动重编，再把 `dist/bundle.js` 复制到 `Plug-ins\dist\` 即可。全仓 ~168 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的行。

## 铁律 90–163（**全文**见 `refs/ironrules-90-129.md` 与 `refs/ironrules-130-147.md`；本表不重复）

90–129：`refs/ironrules-90-129.md`（临时模式/吸附/HUD/断流/编码/模态等，逐条一句话）。
130–163：`refs/ironrules-130-147.md`（快捷键面板/工具键/菜单/样式/追笔/提示；**147 已回退**勿重蹈，148 标准强度线性化；**149–153 填充线**：`Document` 无 `bounds`、剪贴无法单层释放、收尾统一像素写回、**像素读必须按图层 `boundsNoEffects` 再按索引扩充成全文档**、**写回三态 `nothing` 不许降级合并**；**154 特殊蒙版收口到 APP 面板、纯色走原生 `preserveTransparency`**；**155「选区修正」分区=套索平滑（开关降级到首行、参数随开关渲染）+多边形吸附，divider 与填充选项同源**；**156 描边剪贴组安全：特殊蒙版走像素链、普通描边走 silent merge 三级兜底**；**157 特殊蒙版+新建图层遇剪贴目标 ⇒ `targetIsClipping` 分支做像素收窄（描边自然继承）；清除模式↔特殊蒙版双向互斥**；**158 剪贴结构三级链（read → groupEvent → DOM `isClippingMask=true`）、空目标层改剪贴下方那层、`layers[0]` 是最上层**；**159 特殊蒙版四问模型：空目标层复用不新建、收窄一律做、`groupEvent` 必须回读验证**；**160 「空目标层复用」不许写回空层（`putPixels` 被拒）⇒ `replaceEmptyTargetWithContent`（收窄→删空层→改名→剪贴）；`clipResultLayerToBoundary` 必须 `layerExists` + 回读活动层，绝不把 groupEvent 发到未验证的图层**；**161 当前图案/渐变跨会话持久化：渐变整份存 panel-state（先校验）、图案只存 id+transform（本体在预设文件、延后 1s 恢复），两个选择器按「初始选中」种一次**；**162 空目标层首选「内容层 select+mergeLayersNew 向下合并进空层」（id/名字/位置不变），删层只作降级且 `isLayerEmptyById===null` 一律不删；⛔ 不许用 `layerExists` 当流程门槛（DOM 滞后一帧）；剪贴走 `clipLayerToBelowById` 且只在「紧邻下方就是边界层」时建**；**163 静默失败链必须落地日志：`src/utils/SmDebug.ts` → `PluginData/debug/special-mask.log`**；**164 读「当前工具」只能用 `get application.tool._enum`（经 `psRead`、`silent`、只认 `/Tool$/i`）—— PS 27 上 `app.currentTool` 为空、`get currentTool` 报 -25920，2026-11-20 因此整支功能静默失灵**）。

## 其余铁律（1–89）—— 全文见 `refs/ironrules-1-89.md`

1–6 产物/构建｜7–13 闸门/面板（`'slct'` 三态、isPsBusy、gateAge、HUD AND 门）｜14–16 HUD/画布｜17–38 断流补流（三路输入、SYNTH_TIP_MAX_MS、`armed` 判据）｜39–44 键盘钩子/卸载｜45–53 UXP/画笔预设｜54–64 混合器储层｜65–70 在位闸｜71–73 工具闸门/光标｜74–80 HUD 门控/临时吸管｜81–83 标准滤波/文案｜84–86 HUD 坐标系/消失｜87–89 吸管键源

## 工作方式（技能）

大型改动（跨 3+ 文件 / 连续多步宿主操作 / 用户报「做了但没效果」）**默认先铺落地日志**：
`.workbuddy/skills/uxp-debug-trace/`（模板 `templates/DebugTrace.ts`；本仓实现 `src/utils/SmDebug.ts`）。
读日志一行命令：`node .workbuddy/skills/uxp-debug-trace/scripts/trace-tail.mjs`（自动找最新日志 + 比对 bundle mtime，产物比日志新说明还没重启 PS）。铁律 163。

## 维护约定

超限先下沉 refs 再精简本文件（只留「编号 + 一句话 + refs 指针」）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ `PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，独立不许合并；Plug-ins 里的旧 .8li 直接覆盖不留备份（PS 锁文件，覆盖前必须完全退出 PS）。
