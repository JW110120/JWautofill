# JWautofill 长期记忆

> 展开页：`refs/pixel-algorithms.md`（像素处理器算法详述+实测）、`refs/frontend-css.md`（紧凑/专注模式、折叠分区纵向节奏、common.css 单一来源、helpTexts 文案规范）、
> `refs/uxp-api-layer.md`（UXP/PS 接口层实测行为）。
> UXP 坑清单（①–㉕）、组件类目录/尺寸公式、新面板模板在**项目技能** `.workbuddy/skills/uxp-frontend-spec/`。
> **改样式/布局/新建面板前先加载技能；改像素处理器前先读 refs**。本文件只放铁律与索引（细则请下沉到 refs，勿在本文堆实测数据）。

## CSS / 样式铁律
- ⛔⛔⛔ **【血泪，2026-10-07】注释块外的「游离文本」会被当成选择器，静默吃掉紧随其后的整条规则。**
  `common.css` 里 `.radio-trio-group` 与 `.radio-vertical` 两条规则**被同一手法连坐吃掉**，
  导致「三列 radio 竖排成三行」连查 5 轮、前 4 轮所有 CSS 修复全是空转（规则根本没挂上去）。
  机制：写中文注释时多打/挪动了一个注释结束符 ⇒ 注释提前闭合 ⇒ 后面的文案跑到注释外 ⇒
  解析器把它当选择器 ⇒ `{ …声明… }` 成了那个垃圾选择器的声明块 ⇒ 规则永不命中。
  三条纪律：
  ① 编辑中文注释**不要移动/重复注释结束符**，且**注释正文里禁止出现该结束符的字面两字符形式**
  （写「注释结束符」这个说法），否则连「提醒后人」的注释本身都会再次踩坑（本轮已自踩一次）；
  ② **改完 CSS 必须机器校验**：注释开/闭计数相等，且逐字符扫描「注释外不得出现结束符」。
  ⚠️ 校验要区分「未闭合」与「游离结束符」——`pattern.css` 的 `/* … /* … */` 是**嵌套写法的假警报**（内层 `/*` 在 CSS 里只是文本）。
  ③ **「反复改却毫无效果」时立即停止调声明**，先验证**规则是否命中元素**（postcss 解析出选择器 / 浏览器实测 rect）。
  本 bug 曾被误读为「容器塌缩成 52.5px」——那其实是「每项占满整行时文字墨迹的右缘」（详见 2026-10-07 日志）。
  实证手法：`postcss.parse(css)` 后 `walkRules` 打印选择器；或 headless 浏览器注入探针打印
  `getComputedStyle + getBoundingClientRect`（修复前 `三项各 w=230@x=20`，修复后 `w=44@x=20/113/206`）。
  ④ **修完必须复查同区域注释里是否残留「与新结论冲突的旧处方」** —— 错误处方比没有注释更危险，
  后来者会当权威照抄（本轮同一段里就并存过「必须 `flex:1 1 0` 等分」与「必须 `flex:0 0 auto`」两套对立说法）。
- ⚠️ **状态灯/辉光不要写死半透明浅色**：`.indicator-ok` 的 `box-shadow: rgba(46,204,113,0.6)` 在浅色底上冲淡成灰绿（用户反馈"发灰"）
  ⇒ 辉光改 `currentColor`（自动跟随令牌）+ 亮色主题 `--notify-ok-fg` 调深为 `rgb(15,109,52)`。专注模式靶心 `drop-shadow` 同理。
- ⚠️ UXP 不支持 `:has()`：静默失效、构建与 DevTools 都不报错 ⇒「按后代特征选中祖先」只能在 TSX 加显式类名（技能 ㉑）。
  （`:last-child` / `:nth-child()` **可用**，pattern.css 已实测。）
- ⚠️ **替换原生控件时，必须核对「调用方从事件对象的哪个属性取值」**（2026-10-07 血泪）：
  自绘 radio「怎么点都没反应」= `app.tsx` 从 **`event.target.selected`** 取值，而自绘组件回传裸字符串 ⇒ `event.target` undefined，
  **异常又被函数体 `try/catch{}` 静默吞掉** ⇒ 不报错、点了没反应。
  ⇒ ① 只看类型签名（都是 `(e)=>void`）会漏判；② **`try/catch` 吞异常会把 bug 伪装成「点击无响应」**，
  排查此类问题先 grep 调用方取值属性，别怀疑布局/层叠；③ `onChange` 回传 `{target:{value, selected}}` **两个键都给** ⇒ 两条路径都能工作、调用方零改动；
  ④ **替换组件后必须逐个复核调用点签名**，不能只改 JSX 标签名。
- ⚠️ **原生 `sp-radio-group` 不可控，一律用自绘 `components/RadioGroup.tsx`**（自绘后原生已清零）。
  原生两条硬伤：内部排版由宿主实现（`flex-wrap:nowrap`/`justify-content` 拦不住折行）；自带 **15px 水平内边距**。
  ⚠️ 自绘版版式要点：`.radio-trio-group`/`.radio-pair-group` 容器 `space-between` + **项按内容宽 `flex: 0 0 auto`**
  ⇒ 首末项贴边（内缩 0）、三项等宽时中项**精确**落在容器中心。**不要再改成 `flex:1 1 0` 等分**（项盒宽于内容 ⇒ 内容靠格左缘 ⇒ 首末项反而内缩）。
  ⚠️ 历史上「容器两边有大空隙」的真因是**两层 padding 叠加**（`.radio-trio` 包装层 `padding:0 10px` + 父容器已有 10px；
  包装层已删除，现行结构是 `.panel-section > .radio-trio-group`）。另一因：`margin:auto` 的**横向 auto 会禁用 stretch**。
  ⚠️ **通用教训：「元素没占满容器」要查整条祖先链上每层的 padding/border/margin（尤其两层都有的叠加）**，
  只盯目标元素加 width 会连续无效。
  ⚠️ `.radio-option` 必须显式写 `justify-content: flex-start`：**UXP 的 flex 容器隐式默认是 `center`**（非 web 的 flex-start），
  凡「盒宽大于内容宽」的版式都会把内容居中、看起来像被加了左右 padding（`.radio-vertical` 早先就踩过）。
- ⚠️ **「两组控件要双向对齐」的唯一可靠做法是让两组总宽相等**，而不是给某一组加 padding 去凑
  （2026-10-07 实例：紧凑描边行右列组 = `.label-4`(47) + 其 `margin-right`(10) + **4** + 尾控件槽(33) = **94px**，
  与上一行「清除模式 + 开关」严格同宽 ⇒ 右对齐后左右缘偏差实测均为 0）。
  ⚠️ 那 4px 来自**后代选择器**型通用规则 `.row-between .toggle-switch{margin-left:4px}`
  （`.row-start` 里的开关也会命中）—— 排查「莫名差 N px」先怀疑这类规则在异地生效。
- ⚠️ **折叠分区「标题 → 内容首行」的间距 = 标题 `padding-bottom`(10) + 内容首元素自身的 `margin-top`**
  （`.collapse-content-expanded` 是块容器，首元素外边距会折叠穿透到它身上）。
  ⇒ 首元素是 `.row-between` = 20px；是 `.panel-section`（**只有 margin-bottom、无 margin-top**）= 10px
  ⇒ **拿 `.panel-section` 当分区首元素必然比 `.row-between` 少 10px**（2026-10-07「填充选项→纯色」实测）。
  紧凑模式由 `… .collapse-content-expanded > :first-child{margin-top:5px}` 把两类一起拉平（皆 15px），**别重复补偿**。
  ⚠️ **间距令牌一律取「盒对齐」不取「墨迹对齐」**：墨迹偏移由控件盒高/图标尺寸决定，
  写进 margin 会把无关尺寸耦合进令牌（本轮若按墨迹对齐要写 7.5px，图标一改即静默失配）。细则见 `refs/frontend-css.md`。
- ⚠️ **改版式前先用像素脚本量用户截图**，不要目测估：缩放（用已知尺寸控件反推，本仓截图为 **1.5×**）、
  内容盒宽（父面板 **230px** = 250 − padding 10×2）、行 pitch、控件几何都能量出来。
  ⚠️ 用 headless 浏览器搭测量台时**必须复刻完整祖先链**（`.panel > .panel-section > …`）：
  少一层就会让整族 `body.compact-app …` scoped 规则静默失效，两模式测出同一组数据（本轮白跑一次）。
- ⚠️ **数字输入框与单位符号必须定宽**（29 处调用点）：
  ① `.num-input-row { width: 34px }`（border 1px×2 + input 32px）；② `.num-input-row input { width: 100% }`；
  ③ `.num-unit { margin-left: 0; width: 16px; flex: 0 0 16px; justify-content: flex-end }`
  （`%`/`px`/`°` 字符宽不同 ⇒ 不定宽则单位右缘随内容漂移；16px 按最宽单位 `px` 的字身宽上限取）。
  ⚠️ 不要写 `.num-input-row:has(input[type="text"])`（`:has()` 静默失效）⇒ 更宽变体（渐变 `#RRGGBB`）
  走显式类 `.num-input-row-wide{width:62px}` 由 TSX 挂上。⚠️ `align-items: right` **不是合法值**、会被忽略 ⇒ 用 `center`。

## 性能 / React 铁律
- ⚠️ **UXP 图层树只有一份快照，别让每个消费者各自遍历**（`utils/layerTreeSnapshot.ts`）：
  `layer.id/name/kind/layers/isBackgroundLayer` **每读一次都是一次同步宿主 IPC** ⇒ 遍历 N 层树 ≈ 3N~5N 次往返。
  三处并发遍历（引擎 2s 轮询签名 / 面板结构探针 / 线稿参考选项）在 500 图层时每 2 秒约 1500 次同步 IPC
  ⇒ **主线程占满，折叠标题 click 排队 = 「点击无响应」**。
  ① 读树一律 `getLayerSnapshot(maxAgeMs?)`；② 通知回调里只调 `invalidateLayerSnapshot()`（纯内存零 IPC，唯一允许在回调内做的）；
  ③ 判断「结构变没变」先问 `isLayerSnapshotDirty()`，别为了确认没变化而遍历一次。
  签名 = 先序顺序+id+kind+name+depth 参与 FNV-1a（顺序敏感才能识别「移动图层」）；只在会话内自比较、不持久化。
- ⚠️ **大列表下拉的 `options` 必须 `useMemo` + 组件必须 `React.memo`**：`Select` 已 memo，靠**引用比较**跳过重渲染 ⇒
  调用方写 `options={raw.map(...)}` 会让 memo 完全失效。配套：① 选项数组一律 `useMemo`/模块级常量，**永远不要在 JSX 里现 map**；
  ② `Select` 内 `allOptions`/`sel`/`optionsSignature` 必须 `useMemo`；③ **`useMemo` 绝不能放进 `.map()` 回调**（Hooks 数随长度变化会崩）；
  ④ 渲染路径上的 `arr.find(...)` 换成模块级 `Map` 索引（O(N·M)→O(N+M)）。
  ⚠️ 背景：面板是「3800 行单组件、全部 JSX 一个 return」，折叠任一分区会让**所有**已展开分区重渲染
  （含 UXP 原生 `input[type=number]`，同步成本极高）⇒ 折叠代价按 O(分区数 × 控件数) 估，不是 O(1)。
- ⛔⛔ **【血泪】组件内 `useMemo`/JSX 里调用了组件体内更下方才声明的 `const` ⇒ 整块面板白屏**
  （真实事故：`TypeError: Xxx is not a function`，堆栈 `Array.map` → `[as useMemo]`）。
  ⚠️ **报错不是 TDZ 的 "Cannot access before initialization"，而是 "is not a function"** ——
  因为 target=**es5**，ts-loader 把 `const` 降级为 `var`（**提升但值为 undefined**），拿 undefined 调用就是这个报错。
  ⚠️ **编译期与 webpack 全都查不出来**（`transpileOnly` 无类型检查 + TDZ 违反在 es5 下不报错），只能靠人工核对声明顺序。
  铁律：① **纯函数（只依赖入参、不读组件 state）一律放模块级**，永不放组件体内；
  ② 在组件体内新增 `useMemo`/`useState` 初始值/`return` 前的同步语句前，先确认它调用的每个 `const` 都已在**更早的行**声明；
  ③ **发现 TDZ 隐患时修法选「提到模块级」**，不要「把 Hook 挪到声明之后」（会让 Hooks 远离相关 state、后人极易再插错）。
  ⚠️ 验证：不能用 `grep` 生产 bundle（已 mangle）⇒ 用 `ts.transpileModule(src,{target:ES5})` 产出未压缩 es5 核对声明行号；
  更进一步把函数原样抽出丢进 `vm` 按真实调用方式执行。AST 检测器要点：
  ① 组件内辅助函数**只有被渲染期真正「调用」**才算立即执行区，仅被引用（`onClick={handleX}` 传值）不算；
  ② `AdjustmentPanel.tsx` 组件体是**零缩进**，缩进启发式失效，必须用 AST 括号配对定边界。
  （渲染期立即执行区 = 组件体顶层语句 + useMemo/useState 初始值回调体含 `.map()` 同步迭代器；`useEffect`/事件处理器/`setTimeout` 不受影响。）
- ⚠️ **`ts-loader transpileOnly:true` ⇒ 类型缺陷永不阻塞构建，只在跑 tsc 时才暴露**
  （实例：`ColorSettings` 接口缺 `calculationMode`，三处在读写它，长期挂 3 条 TS2339/TS2322 无人发现）
  ⇒ **新增跨组件共享字段必须同步补进 `types/state.ts` 接口**。
  ⚠️ 排查手法：先 `git stash` 跑 tsc 存**基线行数**（本仓约 731 行，多为 es5 lib 报错），改完对比，只看新增标识符是否出现在报错里。
- ⚠️ **父面板复位/批量操作要覆盖子面板内部 state，必须发「自增信号」**：纯色/图案/渐变参数活在各自 state 里，
  父面板 `...initialState` 管不到（描边正常是因为其参数本就在父面板 state）。解法：`AppState.resetToken` 自增 → prop →
  子面板 `prevResetTokenRef` 跳过首次、变化时回默认值。
  ⚠️ `resetToken` 必须写在 `...initialState` **之后**（`initialState` 里恒为 0，放展开前会被覆盖）。
  ⚠️ **复位前必须先清「选中预设」**（GradientPicker 有「参数变→回写选中预设」的 effect，保留会把用户预设改写成默认值 = 悄悄毁预设）。
  ⚠️ 复位**不动 presets/patterns 列表** —— 预设是用户资产，不是参数。
- ⚠️ **启动期一次性 PS 加载（笔刷枚举 / presetManager / 文档尺寸等 `batchPlay get`）必须走 `runWhenIdle` 守卫**，不可裸调：
  插件挂载瞬间 PS 正在处理面板创建与文档初始化，正是忙碌峰值（表现「启动时列表空，点一下刷新就好」）。卸载时 `.cancel()`。
  ⚠️ 第 3 参 `maxDeferrals`（0=不限）：忙碌时无上限顺延会让任务**永不执行** ⇒ **一次性加载必须传有限值**（如 5）；
  「周期性探测」才可传 0。⚠️ 调度器用 `useRef` + 懒初始化（`runWhenIdle` 每次渲染返回新函数 ⇒ const 会丢调度、且 TDZ）；
  循环里判断 setState 结果要读镜像 ref（如 `brushesRef`）而非闭包旧 state。
  ⚠️ 排查「刷新一下才好」先分清**枚举失败**（列表空）vs **下游数据缺失**（有名字无内容）——根因与修法完全不同
  （笔刷无图标属后者，且是刻意设计：类型检测会逐支切换用户当前笔刷，仅手动刷新才做）。
- ⚠️ **通知回调内禁止任何同步 DOM 读取**（`app.activeDocument`/`doc.layers`/`layer.name` 每次读都发 `get`）：
  PS 的 set/delete/make 通知在命令**中途**派发，此刻读文档必撞忙碌窗口 → 宿主弹「命令"获取"当前不可用」。
  **该原生弹框绕过 JS try/catch 与 `_options.dialogOptions`，唯一有效防护是「不发 get」** ⇒ 防护必须在读取动作**之前**（加在 try/catch 之后无效）。
  统一走 `utils/psProbe.ts`（`debouncePsProbe` / `markPsBusy`+`isPsBusy`），静默期 **300ms**。
  三条反直觉细则：① `markPsBusy` 只在**事件到达瞬间**打，**不可**放探测函数体内（否则窗口自我延长、永远等不到空闲）；
  ② 被守卫函数与调用方**不可**互相 `markPsBusy`（= 自锁、功能永不执行）；③ `const` 探测器必须定义在监听回调**之前**（TDZ）。
  **「节流(`if(timer) return`)」会丢弃后续事件、让刷新落在忙碌期 ⇒ 必须真防抖。**
- ⚠️ **GradientPicker 两套插值函数不可合并**（`interpolate*AtPosition` vs `...ForPreset`）：算法同构但入参类型不同，
  且**透明度正则的 alpha 组语义不同**（ForPreset 版 alpha **可选**、兼容无 alpha 的 `rgb()`；组件版 alpha **必需**、不匹配回退 1）——
  合并会改掉 `rgb()` 兜底行为。四个已全部提到模块级。

## 环境 / 工具链
- ⚠️ 两块面板共用同一 `document.body` ⇒ body 状态类名按面板分（主面板 license-dialog-open / secondary-panel-open / app-visibility-panel-open；
  工具箱 visibility-panel-open / adjustment-lock-open）。**隐藏规则必须「属主类名 + 属主根节点」成对写**，否则出现代偿现象（技能 ⑱）。
- ⚠️ **menuItems id 插件级全局唯一，且菜单项只能置灰、绝不能删**：
  同名 id → `entrypoints.setup()` 抛 "already exists"、**两块面板一起空白**。
  🔴 **`removeAt()` 与宿主内部状态不同步**（官方论坛确认）：「removeAt + insertAt 挂回」反复执行后**菜单项越来越少**。
  ⇒ **只能用 `enabled` 做隐藏/禁用，绝不 removeAt/insertAt**；找项按 id 遍历（不能按固定下标）。
  ⚠️ 工具箱改 `id` 同样撞 "already exists" ⇒ 只改 label。APP 增删项必须四处同步：
  `registerAppCallbacks` 类型+赋值、`handleAppFlyout` case、menuItems 数组、app.tsx 注册处（技能 ⑰）。
- ⚠️ UXP 无内置 `fs`/`os`（编译期正常、运行期才炸）；落盘只用 `localFileSystem`（URL 写 `file:/C:/…`）；
  用户自选路径用 `getFileForSaving`（必须在 `executeAsModal` **之外**调）。技能 ⑲。
- ⚠️ **写文件禁用不可见控制字符做分隔符**：用可见分隔符（`|`），别用 U+0000/U+0001
  （会变成模板字符串里的字面分隔符，且让 grep 把源码当 binary 报误导性行数）。改完用 `node -e` 扫字节确认 NUL/控制符为 0。
- ⚠️ Edit 常「报成功但没落盘」；本仓行尾不统一（部分文件 CRLF、.tsx LF）⇒ 改前确认行尾，**改完必须 grep 复核**。
  ⚠️ 大段中文注释的改动，用脚本按锚点精确替换比反复试 Edit 快（Edit 对空格/全角半角差异会匹配失败）。
- ⚠️ `.git/refs/remotes/origin/` 曾缺失 → fetch 假成功、status 恒 ahead；修法 mkdir 后 `git update-ref`。
  推送用 `git -c credential.helper=wincred push`。dist/、analysis/、outputs/ 已 gitignore。
- 前端改完须 UDT Reload；daemon 重编 SDK 8.0.424 在 `C:\Users\Administrator\.dotnet-sdk`（**永不删**）。
- 构建 `node node_modules/webpack/bin/webpack.js --mode=production`（或 `yarn build`）。
  ⚠️ `transpileOnly:true` ⇒ 只转译不做类型检查，漏加接口字段/漏转发**不报错、只静默失效**。
  类型校验用 `tsc -p analysis/line_vis/tsconfig.tc.json`（必须 `types:[]` 绕开 `@types/node/ffi.d.ts` 的 TS1109，否则 tsc 提前中止 = **假通过**）。
- ⚠️ 本机工具：**bash（Git Bash）现可用**（历史上曾 PATH 损坏）；`dangerouslyDisableSandbox` 之外的普通命令一律走 bash 更省事。
  PowerShell 工具 **stdout 不回显** ⇒ 需读输出时显式 `Out-File` 再用 Read（UTF-8 落盘，避免 GBK 乱码）。
- 术语：APP 与 AdjustmentPanel 皆「父面板」；纯色/图案/渐变/描边 = 「子面板」（`src/app.tsx` 内 absolute）。

## 像素算法（**细则、推导与实测数据一律下沉到 `refs/pixel-algorithms.md`**）
- ⚠️ 写回型处理器两条边界铁律（高频增强白边）：区域判定**只用选区掩码>0**（= 写回范围 `selectionDocIndices`）；
  采样到「RGBA 全 0」的数据缺失点必须**用中心像素边缘延拓**。否则选区边缘 + 图层 alpha 轮廓齐出白边，且伪影会**劫持 maxIntensity**。
- alpha 对齐 `alphaAlignProcessor.ts` 现为 **v10 三档整片归一**（v1~v9 五条路线已全部推倒，**勿重走**）；
  唯一例外：v5「多尺度环带参照」以「**极值微调**」两个按钮复活（线条污渍专用，作用通道 alpha→RGBA）。
  语义：三档 = 上对齐(选区 a 最大值) / 下对齐(最小值) / 众对齐(众数)，共用同一次选区直方图，写回**无条件覆盖选区内所有 `a ≥ 32`**。
  ⚠️ 极值档可能是**孤立极值**带走整片 —— **用户选定的语义，勿擅自加门槛**（只在 console 对 <1% 的基准档打 ⚠️）。
  ⚠️ **v7 教训**：「区间填充/占用量」型判据与「连续达标段选目标」**都不要再用**；保护规则越少越好（v10 只剩 `a<32`）。
- 消除锯齿 `aliasSmoothProcessor.ts`：覆盖率重建 + EDT 本体传播 + 墨量守恒；细线 ≤4px 走几何重建。
  ⚠️ 「厚度置信度」必须按**距边界的半径**判定，不能用「局部 3×3 反差」（内缩会让粗线在 7px 处被误判成细线 ⇒ 宽度 -2px；2026-10-06 修）。
- 分块平均/对比减弱：分块 = 不连通选区各自成块；φ 颜色带柔化写死不暴露。
- 梯度修改：写回只影响原 alpha>0；反预乘 pass 整像素还原 a=0/选区外。
- 「仅主线条」`lineSmoothProcessor.ts`（**现为 V7 中轴重建**）：四参数 = 平滑力度 / 曲率平滑(radius) / 宽度平滑(flattenRadius,默认0关) /
  不透明度平滑(opacityRadius,默认250)；加新参数必须同步 **10 处**（接口、转发、`defaultSmartEdgeSmoothParams`、面板状态/加载/保存+依赖/复位/转发/SLIDER_DRAG_CONFIGS/分派 case/UI 行/handler）。
  ⚠️ **两条保墨铁律**（缺一则逐遍墨量单向漂移）：① 密度源用横截面**保墨平均** `mp`，绝不用峰值 `ap`；
  ② 未覆盖像素的密度抛光必须**掩码归一** `bodyBlur = blur(alpha·m)/blur(m)`，绝不用 `max(alpha, blur·scale)`。
  ⚠️ ⑧「首要不伤害」护栏阈值 `0.35` **不可放松**；新代码**禁用 `Math.hypot`**（target es5 无、且不被 TS 转译）⇒ 用 `Math.sqrt(x*x+y*y)`。
  ⚠️ 宽度拉平两条量纲铁律：去趋势通道**必须平行于轴**；中轴重分配量**必须封顶为 |Δ|**。
- ⚠️ **构建不做类型检查 ⇒ 像素算法的参数/转发缺陷只会静默失效**（改完必须端到端跑一遍台架）。
- 台架均在 `analysis/line_vis/`（`accept_v7.mjs`/`perf_v7.mjs`/`verify_flatten.mjs`/`repro_hf_edge.mjs`…）：
  ⚠️ **`accept_v7.mjs` 产出路径相对 CWD** ⇒ **必须从仓库根运行**，否则写进嵌套目录并读到旧文件（曾误读一次验收数据）。
- ⚠️ 改完必须同时报「回归 diff vs 旧版」与「作用量 vs 原图」；判「不该动的笔画有没有被动」看**墨迹外沿（alpha≥32）位移**，不是字节差。

## 守护进程
- C#/.NET8 daemon（`native/HotkeyDaemon/Program.cs`）：WH_KEYBOARD_LL 独立线程，钩子线程严禁阻塞 I/O，
  焦点闸门 `IsPhotoshopForeground` 否则放行。WS 127.0.0.1:18923。冻结三形态与 ps1 七步见技能
  `windows-keyboard-device-reset`；改 ps1 后同步 dist/。`shell.openPath` 受 manifest 扩展名白名单管控。
