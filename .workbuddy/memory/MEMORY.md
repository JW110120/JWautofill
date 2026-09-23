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
- alpha 对齐 **v10 三档整片归一**（`alphaAlignProcessor.ts`；v1~v9 五条路线——逐像素多尺度环带参照 / 参照场共识 / 全局平台基准 /
  单侧写回 / 同侧最强档——**已全部推倒，勿重走**。⚠️ **例外（2026-09-23）**：v5 的「多尺度环带参照」已以
  **「极值微调」两个新按钮的形式复活**，专给线条污渍用，见下面那条；v10 三档归一继续只服务色块）。**语义（用户 2026-09-23 二次纠正）：三个按钮共用同一次「选区直方图」，
  只是取的统计量不同，都是整片归一到该水平**：
  ① **上对齐 = 选区内 `a` 的最大值**；② **下对齐 = 选区内 `a` 的最小值**（"与之对应"）；③ 众对齐 = 众数（另一个函数，未改）。
  直方图 = **选区本身**（v10 起不再用 halo；halo 是旧"环带找周围水平"路线的残留，已删 `ALPHA_ALIGN_HALO`），只统计 `a ≥ MIN_ALPHA(32)`。
  写回**无条件、覆盖选区内所有 `a ≥ 32` 像素**：`na = round(a + (target-a)×rate×fade)` ⇒ 结构上不可能有遗留；目标只依赖直方图
  ⇒ 同一 alpha 处处同一结果（完全空间一致，无斑驳/条纹）。唯一跳过 `a<32`。常量只剩 `MIN_ALPHA / FEATHER_RADIUS / EXTREME_WARN_SHARE`。
  ⚠️ **为什么最小值/最大值必须从 `a≥32` 起算**：低于 32 的是没擦干净的残留与 AA 尘埃；若让它们参与"最小值"，下对齐会把整片压到
  近乎全透明（实测恢复素材：min=32 只有 116px ⇒ 整片 mean 74.2 → **29.5**，等于擦掉画面）。用户自己的稿子 AA 全在 32 以下
  （域内全 ≥82）⇒ 该下限对他无副作用。若某稿 AA 落在 32~80，最小值就会落在 AA 尾上——日志会打 ⚠️（`EXTREME_WARN_SHARE 1%`）。
  ⚠️ **已知取舍（用户选定的语义，勿擅自加门槛）**：极值档可能是**孤立极值**（实测 `_real` 代理素材 max=168 只有 **1 px**、`_aa_like` max=207 有 48px）
  ⇒ 整片会被它带走；v9 曾用"该侧计数最多 + 规模门槛"规避，但那是**用户明确否掉的方向**（他要的就是极值）。所以 v10 不加门槛，
  只在 console 里对 <1% 的基准档打 ⚠️ 提示。真要排除就缩小选区。
  ⚠️ **硬事实**：内容全在众数之上时（用户稿：域内 30642 像素全 ≥82、众数 87）任何"只抬偏淡像素"的语义恒为空转 —— 这是 v8 的根因。
  ⚠️ **v7 教训（核心）**：v7"平台保护 + 渐变带保护"合起来吃光 100% 候选 ⇒ 修改=0（① 平台 = 连续达标段，真实稿直方图连片 ⇒
  覆盖 65%；② `区间填充 ≥ hist[a]×2` 在真实稿**恒真**）。**"区间填充/占用量"型判据与"连续达标段选目标"都不要再用**；
  保护规则越少越好（v10 只剩 `a<32`）。详细实测见 refs；台架 `outputs/aa_run.cjs`（每次用唯一 outPrefix）。
  📷 **素材恢复法**：截图 → 非白 bbox 与外接矩形比值定缩放 → 块中心 NN 采样 + 3×3 中值（`_aa_recover*.py`；`_aa_like.py` 造同构合成稿）。
  ⚠️ 恢复素材是**AA 饱和**的（137 个不同档），真实画稿只有 4~8 档 ⇒ 恢复素材的 min/max 会落在 AA 尾/孤立极值上，**不能当作
  用户真实稿的极值代理**，只可用于对齐 console 的平台列表/计数。
- **极值微调**（`alphaAlignProcessor.ts` 的 `processExtremeAlign`，2026-09-23 新立）：**线条上的污渍**专用，
  按钮在 APP 面板「**边缘处理**」分区最下方 —— **提升下极值** = d648017 版 v5「上对齐」（只增不减）/
  **削弱上极值** = v5「下对齐」（只减不增），即逐像素多尺度环带参照（k=1/4/14/42/112 + 高端平台簇 + 平坦拦截 +
  中位数回退 + 两遍 + 参照场共识 R=6 + 漏判补判）。**与 v5 的唯一差别：作用通道 alpha → RGBA**（四通道同一套算法各跑一遍；
  "属于线条"的闸门恒为 `alpha ≥ MIN_ALPHA(32)`，各通道用自己的值 ⇒ **alpha 通道与 v5 逐字节一致，已实测验证**）。
  ⚠️ 两处刻意取舍（通道语义决定）：① v5「本层邻域」护栏 `bandMax > v+BRIGHT_GAP(60)` 的尺度跳过**只对 alpha 生效**
  （RGB 没有"层"语义，通道落差本身就是污渍）；② 参照高端区间下界由 minAlpha 改 **0**（否则深色线条 RGB=30 找不到参照）。
  ⚠️ 护栏的可测边界：alpha 只能修 `(线水平−60, 线水平)` 内的偏低值，**落差 >60 的坑不动**（console 打 `护栏拦下=N`）。
  实测（台架 `outputs/ex_run.cjs` / `ex_real.cjs`）：合成 5 类污渍语义全对、「污渍块之外 0 改动」、纯平直线与同水平十字交叉
  两个方向都 **0 改动**；"不激进"对照（同素材全图选区，改动像素数）——`_aa_like` 0/2116 vs v10 23350/4063、
  `_real` 5647/6424 vs v10 32730/32615，档位数 5→5 / 169→169&141（v10 抹到 2 档）⇒ 只动离群点、保留层次。
  ⚠️ 软笔刷素材的改动里约 85% 来自 v5 的「参照场补判」（`REF_FILL_PROTECTED_DELTA=30` 越过平坦保护把羽化档抬到 core）；
  要"只修坑不动羽化"就让补判也受护栏约束。详见 refs。
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
