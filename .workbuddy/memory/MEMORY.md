# JWautofill 长期记忆

> 展开页：`refs/pixel-algorithms.md`（像素处理器算法详述）、`refs/frontend-css.md`（紧凑/专注模式、common.css 单一来源、helpTexts 文案规范）、
> `refs/uxp-api-layer.md`（UXP/PS 接口层实测行为）。
> UXP 坑清单（①–㉑）、组件类目录/尺寸公式、新面板模板在**项目技能** `.workbuddy/skills/uxp-frontend-spec/`。
> **改样式/布局/新建面板前先加载技能；改像素处理器前先读 refs**。本文件只放铁律与索引。

## 项目铁律
- 禁 HEX，一律 rgb()/rgba() 走 theme.ts 变量；遮罩不透明度 0.80 字面写。UXP 无 flex gap→一律 margin。数字输入 32×24、`.num-input-row` 圆角 3px。
- ⚠️ UXP 不支持 `:has()`：静默失效、构建与 DevTools 都不报错 →「按后代特征选中祖先」只能在 TSX 加显式类名（技能 ㉑）。
- 术语：APP 与 AdjustmentPanel 皆「父面板」；纯色/图案/渐变/描边=「子面板」(src/app.tsx 内 absolute)。
- ⚠️ 两块面板共用同一 `document.body` → body 状态类名按面板分（主面板 license-dialog-open/secondary-panel-open/
  app-visibility-panel-open；工具箱 visibility-panel-open/adjustment-lock-open）。**隐藏规则必须「属主类名 + 属主根节点」成对写**，
  否则出现代偿现象（技能 ⑱）。
- ⚠️ menuItems id 插件级全局唯一：同名 → `entrypoints.setup()` 抛 "already exists"、**两块面板一起空白**。
  APP 增删项必须四处同步：`registerAppCallbacks` 类型+赋值、`handleAppFlyout` case、menuItems 数组、app.tsx 注册处（技能 ⑰）。
- ⚠️ UXP 无内置 `fs`/`os`（编译期正常、运行期才炸）；落盘只用 `localFileSystem`（URL 写 `file:/C:/…`），
  用户自选路径用 `getFileForSaving`（必须在 `executeAsModal` **之外**调）。技能 ⑲。
- ⚠️ Edit 常「报成功但没落盘」；本仓行尾不统一（blockAverageProcessor.ts CRLF、.tsx LF、`analysis/line_vis/*.mjs` LF）
  → 改前先确认行尾，改完必须 grep 复核。
- ⚠️ `.git/refs/remotes/origin/` 曾缺失 → fetch 假成功、status 恒 ahead；修法 mkdir 后 git update-ref。
  推送用 `git -c credential.helper=wincred push`。dist/、analysis/、outputs/ 已 gitignore。
- 前端改完须 UDT Reload；daemon 重编 SDK 8.0.424 在 `C:\Users\Administrator\.dotnet-sdk`（永不删）。
- 构建 `node node_modules/webpack/bin/webpack.js --mode=production`；⚠️ **ts-loader `transpileOnly:true` ⇒ 只转译、不做类型检查**，
  漏加接口字段/漏写转发**不报错、只静默失效**。类型校验用 `tsc -p analysis/line_vis/tsconfig.tc.json`
  （必须 `types:[]` 绕开 `@types/node/ffi.d.ts` 的 TS1109 ⇒ 否则 tsc 提前中止 = **假通过**）；判据只看新增标识符是否出现在报错里。
- ⚠️ 本机工具坑：**bash 的 PATH 已损坏**（dirname/ls/tail 全 not found）⇒ 一律 PowerShell；**PowerShell 工具 stdout 不回显**
  ⇒ 命令里显式 `Out-File` 到文件再用 Read 读（UTF-8 落盘，避免 GBK 管道乱码）。

## 像素算法（细节、推导与实测数据见 refs/pixel-algorithms.md）
- ⚠️ 写回型处理器两条边界铁律（高频增强白边，2026-09-19）：区域判定**只用选区掩码>0**（= 写回范围
  `selectionDocIndices`；用 alpha>0 会让统计口径 ≠ 写回口径）；采样到「RGBA 全 0」的数据缺失点必须
  **用中心像素边缘延拓**。否则卷积/方差把 0 当真实像素 ⇒ 选区边缘 + 图层 alpha 轮廓齐出白边，
  且伪影会**劫持 maxIntensity** 让功能对选区内部失效。台架 `analysis/line_vis/repro_hf_edge.mjs`。
- 分块平均/对比减弱：分块=不连通选区各自成块；φ 颜色带柔化写死不暴露。
- 梯度修改：写回只影响原 alpha>0；反预乘 pass 整像素还原 a=0/选区外。
- alpha 对齐 v5：局部多尺度环带参照+窗口共识+众对齐；平坦判据用绝对数；上对齐要护栏、下对齐不要。
- 消除锯齿：覆盖率重建+EDT 本体传播+墨量守恒；细线 ≤4px 走几何重建。
- 「仅主线条」lineSmoothProcessor.ts（**现为 V7 中轴重建**，见下辖小节）早期已修四个缺陷（详见 refs）：①细线失效 → 面积开运算 + 逐像素自适应 σ（σ ≤ 0.56×线宽）；
  ②连点变细/断裂「棘轮」→ `BAND_LATTICE=0.30` 定值 + `SIGMA_THICK_RATIO=1.80` + density 取 `max(原 alpha, 抛光值)`
  （三条同时改，缺一无效）；③「宽度拉平」凹陷无补偿 → 门槛参照改**双侧邻域最大半宽 Href**；
  ④「宽度拉平」单侧凸起把平缓侧推成凹陷 → **中轴跟随**（δh ± δc 按 ∇half 分侧）。
- ⚠️ 「宽度拉平」两条量纲铁律（都踩过、代价大）：去趋势的通道**必须平行于轴**（`k=gy·gw+gx` ⇒ alongY 时 stride=gw）；
  中轴重分配量**必须封顶为 |Δ|**（`|δc| ≤ |δh|` 恒成立；不封顶则等宽长弧横移 5px）。
- 参数命名：「仅主线条」四参数 = 平滑力度(strength,0~100%) / **曲率平滑**(radius,3~9px) / **宽度平滑**(flattenRadius,0~700,默认0关) /
  **不透明度平滑**(opacityRadius,0~700,默认250)。链路 `edgeLineFlatten`→`lineSmoothFlatten`→`flattenRadius`，加新参数必须同步 4 处：
  接口(`EdgeDetectionParams`/`LineSmoothParams`)、转发、`defaultSmartEdgeSmoothParams`、面板（状态/加载/保存+依赖/复位/转发/SLIDER_DRAG_CONFIGS/分派 case/UI 行/handler——共 10 处）。
- 改完必须同时报「回归 diff vs 旧版」与「作用量 vs 原图」；判「不该动的笔画有没有被动」要看**墨迹外沿（alpha≥32）位移**，不是字节差。

### 「仅主线条」V7 中轴重建：两条保墨铁律（缺一则逐遍墨量单向漂移）
- ① **密度源用横截面「保墨平均」`mp = Σalpha·step/(wl+wr)`，绝不用峰值 `ap`**。峰值作密度源 ⇒ 每个横截面被抬到自身峰值、**只升不降**
  （实测 img1 逐遍 +8.87/+4.86/+1.34%，93% 增量落在内部 [64,127] 像素、边界仅 1/14）。改 `mp` 后 `Σ(tl+tr)/Σ(wl+wr)=1.0000`、`ta/mp=1.0000`。
  `ap` 现仅用于半高交点几何（`penalizedSmooth(mp,…)`）。
- ② **未覆盖（aValid=0）像素的密度抛光必须「掩码归一」`bodyBlur = blur(alpha·m)/blur(m)`**，绝不用 `max(alpha, blur·scale)`。
  `max` 单向 ⇒ 保墨后残留棘轮主因（该分支 +148394/15987/−562）。掩码归一自带「边缘不压暗」故 max 不再需要，且对称 ⇒ 幂等。
  用 `gaussianBlurPair`（两通道同核一次遍历）把代价从 +10% 降到 +5%。
  ⚠️ 解析近似 `blur(m)≈Φ(sd/σBody)` **不可用**：曲率处 sdB<sd ⇒ w 高估 ⇒ 逐遍 −1.67%（vs 精确 −0.11%）。
  A/B（img1 flat0/250 峰RMS）：掩码归一 3.84/3.23 ≪ 不归一 5.04/4.22 ≪ 不抛光 5.40/4.42（V5 5.00/5.89）⇒ 必须保抛光**且**必须归一。
- ⚠️ ⑧「首要不伤害」护栏阈值 `0.35` **不可放松**（0.55/0.75 ⇒ flat450 棘轮 −1.94%→−5.03%）；放松剔除阈值会重现锥形伪影。
- ⚠️ 新代码禁用 `Math.hypot`（本仓 target es5 默认 lib 无 hypot，且它**不被 TS 转译** ⇒ UXP 运行期风险）→ 一律 `Math.sqrt(x*x+y*y)`。
- 最终站位（`_accept_v7.txt`）：峰RMS 3.84/3.36/3.23/3.20/3.25（flat0/150/250/450/700）、横截断崖 141/82‰（V5 134‰）、
  棘轮 flat0 **−0.11%** / flat450 −2.47%、性能 **1.237/1.076/1.192**、粗线墨量偏差 ≤1.6%、宽二阶 5.9/6.5/3.0。
  **未达标**：峰RMS（目标 3.0）、横截断崖（目标 45‰）、flat450 棘轮（目标 0.5%）。线索：flat450 第 3 遍 ① 重建覆盖 0 像素（疑 ⑧ 触发）、② 各 −0.9%/遍。
- 台架：`accept_v7.mjs`（8 组验收）、`perf_v7.mjs`（V5/V7 交替 9 轮取 min/med，抗抖动）、`ab_polish.mjs`、`diag_v7_ink.mjs`
  （按输入 alpha 分 bin + 边界/内部归属）、`diag_v7_branch.mjs`（按密度分支归属，可传 flattenRadius）、`diag_v7_recon.mjs`、`opac_test.mjs`。
- ⚠️ **`accept_v7.mjs` 的产出路径相对 CWD**（`analysis/line_vis/_accept_v7.txt`、`out_v7/`）⇒ **必须从仓库根运行**，
  否则写进嵌套目录并读到旧文件（本次因此误读一次验收数据）。

## 守护进程
- C#/.NET8 daemon（native/HotkeyDaemon/Program.cs）：WH_KEYBOARD_LL 独立线程，钩子线程严禁阻塞 I/O，
  焦点闸门 IsPhotoshopForeground 否则放行。WS 127.0.0.1:18923。冻结三形态与 ps1 七步见技能
  windows-keyboard-device-reset；改 ps1 后同步 dist/。`shell.openPath` 受 manifest 扩展名白名单管控。
