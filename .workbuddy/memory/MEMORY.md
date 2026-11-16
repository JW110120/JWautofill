# JWautofill 项目记忆（主索引）

> 只留「编号 + 一句话 + refs 指针」；明细在 `refs/`，里程碑在 `HISTORY.md`，逐条实证在 `2026-11-*.md`。
> 架构：平滑+键盘钩子＝PS 进程内 .8li（`native/JWautofillHost/`，WS 18924/18923）。里程碑与逐条实证见 `HISTORY.md` 与 `2026-11-*.md`。

## 索引（`refs/` 下）

`fill-and-stroke`（填充/描边/清除）｜`frontend-css`（CSS/面板/主题）｜`busy-gate`（闸门/模态）｜`uxp-api-layer`（UXP/API/性能）｜`pixel-algorithms`（像素）｜`toolchain-and-env`（构建/部署）｜`lasso-smoothing`（平滑/HUD/断流/闸门/吸管，O22–O62）｜`keyhook-8li`（键盘钩子/滚轮热键 0x0235）｜`brush-mixer-reservoir`（混合器）｜`poly-snap-0x0211-0x021F`（临时模式/冻结/吸附）｜`blend-hotkey-yield-0x0224`（混合模式让位）｜`ironrules-1-89`（1–89 全文）｜`ironrules-90-129`（90–129 全文）

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；类型检查 `npx tsc -p tsconfig.check.json`（⛔ 别用 `tsc --noEmit`）；改 .c 跑 `build.sh`（须沙箱外）零告警 + 导出表 5 项；改面板**别跑 `yarn build`**（那会产出 production 覆盖 `yarn watch` 的 dev 构建）—— watch 会自动重编，再把 `dist/bundle.js` 复制到 `Plug-ins\dist\` 即可。全仓 ~168 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的行。

## 铁律 90–148（**全文**见 `refs/ironrules-90-129.md` 与 `refs/ironrules-130-147.md`；本表不重复）

90–129：`refs/ironrules-90-129.md`（临时模式/吸附/HUD/断流/编码/模态等，逐条一句话）。
130–148：`refs/ironrules-130-147.md`（快捷键面板/工具键/菜单/样式/追笔/提示；**147 已回退**勿重蹈，148 标准强度线性化）。

## 其余铁律（1–89）—— 全文见 `refs/ironrules-1-89.md`

1–6 产物/构建｜7–13 闸门/面板（`'slct'` 三态、isPsBusy、gateAge、HUD AND 门）｜14–16 HUD/画布｜17–38 断流补流（三路输入、SYNTH_TIP_MAX_MS、`armed` 判据）｜39–44 键盘钩子/卸载｜45–53 UXP/画笔预设｜54–64 混合器储层｜65–70 在位闸｜71–73 工具闸门/光标｜74–80 HUD 门控/临时吸管｜81–83 标准滤波/文案｜84–86 HUD 坐标系/消失｜87–89 吸管键源

## 维护约定

超限先下沉 refs 再精简本文件（只留「编号 + 一句话 + refs 指针」）。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ `PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，独立不许合并；Plug-ins 里的旧 .8li 直接覆盖不留备份（PS 锁文件，覆盖前必须完全退出 PS）。
