# JWautofill 项目记忆（主索引）

> 索引+铁律速查；明细在 `refs/`，里程碑史在 `HISTORY.md`。⛔ 违反必炸。
> 架构：平滑+键盘钩子 = **PS 进程内 .8li**（`native/JWautofillHost/`，WS 18924 平滑 / 18923 热键）。
> 版本线：0x0128–0x0138 补流桥；0x013E 开关改意图语义；0x013F 关闭取证；0x0201–0x0204 合成点击（混合器储层）；0x0205 插件本体在位闸。

## 索引

填充/描边/清除 `refs/fill-and-stroke.md`｜CSS/面板/主题 `refs/frontend-css.md`｜闸门/模态 `refs/busy-gate.md`｜UXP/性能 `refs/uxp-api-layer.md`｜像素算法 `refs/pixel-algorithms.md`｜构建/部署 `refs/toolchain-and-env.md`｜平滑/HUD/断流/笔通路 `refs/lasso-smoothing.md`｜键盘钩子 `refs/keyhook-8li.md`｜**混合器储层/浮雕笔 `refs/brush-mixer-reservoir.md`（§59–63 全档）**

**校验**：改 CSS 跑 3 个 guard（只扫 `src/styles/*.css`）；**类型检查用 `npx tsc -p tsconfig.check.json`**（⛔ 别再用 `tsc --noEmit`：@types/node 的 TS5 语法会让语义检查被静默跳过，"src 零错"是假象）；改 .c 跑 `build.sh` 零告警 + 导出表 5 项；改面板 `yarn build`。全仓 143 条历史错误在 `app.tsx`/`adjustments`/`components`，只看自己碰过的文件。

## 铁律速查

**产物/构建**
1 ⛔⛔ **除非用户明确要求，禁止 `git add`/`commit`**。测试通过并经用户发话才提交（代码+日志+记忆一次提交）。
2 ⛔⛔ IPC 双防御：`toWire()` 一律 Math.round，原生 `double?`+Round（漏=整条消息被丢）。
3 ⛔⛔ .8li：PiPL 头 10 字节；`'8664'` 导出名=C 字符串；版本走导出表（`jw8li_version`）。
4 ⛔ `CFG_NLONGS=58`：`plugin_main.c` 与 `smooth_engine.c` 同步改。
5 ⛔ 日志分工：`.8li`→`%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log`；引擎→`%TEMP%\jwwh-<pid>.log`。
6 ⛔⛔ 卸载先全停引擎线程再返回：`jwwh_unhook()` 幂等+兜底 repatch；DETACH 只能 join。

**闸门/面板**
7 ⛔⛔ `'slct'` 三态只有 `2` 停轮询，同步三处；边沿无心跳⇒接管带 2s 时效；面板判据=原生 `gateOwned`。
8 ⛔ 闸门=`isPsBusy()`+文档闩锁+`psRead()`；禁采信 `core.isModal()`；空闲巡检 <3.3/s。
9 ⛔⛔ `psBusyInProc()` 三态禁并进 `isPsBusy()`；`-1` 绝不当 `0`。
10 ⛔⛔ 真相不靠心跳续命：面板发 `gateAge`，原生写 `I_GATETS=now−gateAge`。
11 ⛔⛔ HUD=显式 AND 门：窗口在·包流·套索∧接触·一笔之中·前台·焦点在画布·落笔判据·非断流·拉绳·面板 bit0·总开关。
12 ⛔⛔ HUD 门槛不门救援：救援用宽判 `canvas_hit_ok` 不看前台；HUD 用严判。
13 ⛔ 改宿主的开关外置 `wtctx.ini`（缺=只观测）；`cursorInject` 缺省 1。

**HUD/画布**
14 ⛔⛔ 拉绳定长 `f=1−rope/dist`，1px+二次贝塞尔；HUD 保留 `WS_EX_TRANSPARENT`，`WS_EX_TOPMOST` 写进 CreateWindowExW。
15 ⛔⛔ 悬链垂度只加重力方向：`cqy=my+2·sag·hor`，`hor=|dx|/d`。
16 ⛔ px 权威=屏幕/lcOutExt 非 lcInExt；像素常量×`dpiS`；`putPixels` 默认 replace=true。

**断流/补流**（全档 `refs/lasso-smoothing.md` O22–O40）
17 断流对 Wintab 只读不写；判读=`[stall]`与`[dead]`差集。
18 ⛔⛔ 「没开始画」≠「断流」：零真包用 `[boot]` 措辞，判据=首条 `[stall]★` 前必见 `[boot] 首包到达`。
19 停摆⇔PS 失前台，`[stall]` 行的 `fg=` 固化现场。
20 ⛔⛔ 补流状态机只看接管条件：`k==0`≠驱动恢复。
21 ⛔⛔ 停摆先问「LNP 在不在环」但别当方案；LNP 字节级丢 `WTQueueSizeSet/WTEnable/WTPacketsPeek/WTDataGet/WTSet`。
22 ⛔⛔ 安全窗≠接触判据：`SYNTH_TIP_MAX_MS=6000` vs `CONTACT_HOLD_SMOOTH_MS=1500`。
23 ⛔⛔ 不用 VK_LBUTTON 电平当抬笔证据（Wintab 独占时鼠标模拟只发边沿）。
24 ⛔⛔ 代投按拍节流，不挂光标移动/画布（`cv=0` 转喂入冻结）。
25 ⛔⛔ 空档期落笔只由包外证据定且只加不减（`WH_MOUSE_LL` 左键消息）。
26 ⛔⛔ PS 会自关 Wintab 上下文不重开：判据=`[ctx] WTClose` 后无 `WTOpenW`。
27 ⛔⛔ 输入三条路只钩一条等于没有：Wintab 包+系统光标+Windows Ink；钩 SetCursor 不钩 SetCursorPos。
28 ⛔⛔ 平滑节拍=PS 查询同拍：raw/out 双端外推限幅 40ms，只几何不改状态。
29 ⛔⛔ 标定分层 n≥3/n==2/n<2；`WTPacketsPeek` 只读⛔不用 Get；证据不足 `attempts--`。
30 ⛔⛔ `user32` 导出是真代码⇒走 IAT；自己模块不扫描。
31 ⛔⛔ 起笔锚定唯一权威=buttons 逐包 0→1 边沿；`落`>1≠抖动。
32 ⛔⛔ `BTN_EDGE_MIN_ZERO=16 包`（真抬笔实测≥260ms）。
33 ⛔⛔ 系统光标与 Wintab 同源（笔停则冻）；Raw Input 被驱动吞；Windows Ink 判死 `[ink]=0`。
34 ⛔⛔ 断流第二问：断流时系统光标动不动？（冻死 vs 跟笔）
35 ⛔⛔ 平滑输出不绑包：停摆期 `gp_step()` 每次查询推一步，`sAge<=300` 是自锁。
36 ⛔⛔ 超 6s 用包外按钮电平+画布内+1.5s 内动过⇒tip=1（三条缺一不可）。
37 ⛔⛔ 补流交还驱动必须 `g_btnResync`，否则假落笔钉回原始坐标。
38 ⛔⛔⛔ 「包流健康」≠「PS 在用包画」：判据=`armed`（cursorInject∧cfg[ENABLED]∧笔按着）；笔抬着完全透传；验证=`[raw] gp=` 一直涨。
39 ⛔⛔ 键盘热键必须双路：LL 钩子在 PS 前台整段收不到键 ⇒ `GetAsyncKeyState` 10ms 轮询兜底；`只有轮询涨=键没进钩子链`。
40 ⛔⛔ 钩子活性看**阳性证据**：`轮询有增量 ∧ 钩子零增量`⇒`g_khReinstall`（3/10/30s 退避，录制中不重装）；`kh_dual_mark` 只由钩子路径写。
41 ⛔⛔ unload 必须让引擎**哑火**：`services_stop`→`jwwh_set_engine_off(1)`；⛔ 不用 `jwwh_unhook()`（不可逆）；光标 `armed` 必须含 `tool_gate_ok()`。
42 ⛔⛔ **PS 侧回调必须真注销**：`pstool.c` 的 `s_basic` 只声明不赋值 ⇒ `pstool_uninstall()` 恒 return。判据：grep `s_basic =` 必有赋值。
43 ⛔⛔ **LL 钩子先摘再 join**：`keyhook_stop()` 在任何 join 之前 `kh_unhook_both_now()`，join 后补一次。
44 ⛔⛔ **DETACH 日志先落再停服**：排查关闭崩溃三步 → `pipl.log` 的 `DLL_PROCESS_DETACH` → `dumps\crash-*.dmp` → WER 故障模块。

**UXP / 画笔预设**
45 ⛔⛔ **`_obj` 只能来自"录到过/跑通过"的样本**：-25920 = 命令名 PS 不认识。全选=`set`+`channel.selection`→`allEnum`。
46 ⛔⛔ **`dialogOptions` 一律 `silent`**（`dontDisplay` 是「出错时仍显示 UI」）；只认描述符自己的 `_options`。
47 ⛔⛔ **改状态的动作，判据只能是「回读权威字段变了」；"命令没报错"等于什么都没说。**
48 ⛔⛔ **装笔 = 缓存整份 `currentToolOptions`**：快路径 `set cto`，慢路径 define→参数→抓 cto 存盘→删预设。实现在 `psState.ts`。
49 ⛔⛔⛔ **`set` brush 的 `to` 必须带笔尖身份**：只给几何键 ⇒ PS 换成 `computedBrush`（软边喷枪）。判据一律以 `sampledData` 为准；几何走 `set paintbrushTool to 整份 cto`。
50 ⛔⛔⛔ **PS 27 换笔尖 = `select + brush _name + makeVisible:false`**（`MkVs` 是「应用」与「只高亮」的分界）。`set+brush`=-1715、`set+brushPreset`=-25920。`brushes`/`presetManager` 是惰性快照，不能判删除成败。
51 ⛔⛔⛔ **每条失败的 batchPlay 都被 PS 画成一条黄条** ⇒ 正常路径 `failCount` 必须 0。能用「读状态」判的绝不用「试一下会不会报错」判；各探测加会话级形态记忆。
52 ⛔⛔ **分清黄条是谁画的**：PS=一句话（前缀「悦绘:」）；带 `#1 … / #2 …` 拼接的整段 = 我们面板 `.notify-bar`。状态条只能一句话（`say()` 截 120 字 + 两行 clamp）。
53 ⛔⛔⛔ **判"当前是哪个工具"不能用 `get currentTool`**（27 必报 -25920）⇒ 用指纹字段（`wetness`/`dryness`/`reservoirState`/`autoFill` 命中≥2）；dump 环检测只能用祖先链 `stack.includes(v)`。

**混合器浮雕笔（P3，进行中）** —— 明细全在 `refs/brush-mixer-reservoir.md`
54 ⛔⛔⛔ **储层只能靠「重新采样」装填**：像素恒 `{}`、单独 get 报 -25920 ⇒ 写不进；改前景色会把储槽灌成纯色（与 `autoFill` 无关）。上色在 JS 一步乘法，alpha 用**覆盖度**不是亮度。
55 ⛔⛔⛔ **「派发 AM 事件触发工具手势」不存在**（手势不派通知；`loadBrush`/`cleanBrush`/`mixerBrushTool` 在 exe ID 表 0 命中）。
56 ⛔⛔ **合成点击 `canvasClick`**：`alt:1` 装储层 / `alt:0` 验货（0x0204 起**只单击，无 drag**）。Alt 必须先按住再按左键（PS 在 mouse down 读键态）；卸载必须 `click_join`。
57 ⛔⛔⛔ **厚涂笔走混合器储层**：`mixer.pattern` ⇒ `applyBrush` 首部 `return`（defineBrush+cto 缓存链已空置，代码保留）。① 整段不能包一个 `runAsModal`（模态里 Alt+点被吞却全绿）；② 吸前直径必须 = 图案长边；③ 验货底必须**不透明中灰**（透明底混合器更不出色）。
58 ⛔⛔ **面板尺寸只认图案长边**（`library.ts` 读 PNG 头填 `mixerSize`）。⛔ `set` 的 `_target` 必须**裸引用**（`{_ref:"wetBrushTool"}` 等；带 `_enum:"ordinal"` 或 `set property currentToolOptions` 一律「命令"设置"当前不可用」）；PS 会换算直径（400→407）⇒ 只看回读值。
59 ⛔⛔⛔ **原生 JSON 助手是严格类型**：`json_bool` 只认 `true`/`false`，数字 `1` 静默失败 ⇒ 数字一律 `json_num` 判非零；"发了就忘"的消息必须有 `xxxResult` 回执 + `waitHostMessage()` 核对。
60 ⛔⛔⛔ **直径不能靠 `set`，尺寸由笔尖自己带**：`set brush` 会抹掉 `sampledData`（方形变计算圆笔）⇒ `defineBrush(side² 白方块)`，直径天生 = 边长、形状也对。
61 ⛔⛔⛔ **验货判据链**：有位图 ≠ 装了图案（吸空白也是 `state=2`）⇒ 图案只能靠点一笔看层次；储层尺寸 = 直径 × **1.4325**，别拿它判断吸歪。（旧结论"湿笔单击不出颜料"是错的：340px 是因为点落在画布外。）
62 ⛔⛔ **吸得准的两条前提**：`fitOnScreen` 把图像摆到视口正中（`actualPixels` 只改缩放不动滚动）；原生**点的是「命中窗口中心」不是主框客户区中心**（0x0204：后者在 3840 屏上偏右 287px，250 画布整个点飞）。
63 ⛔⛔ **笔尖身份落地顺序**：现成方笔且直径对=零命令 → 按名选方笔（名字含「方」，**名字里的数字优先匹配目标尺寸**）→ 整份 cto 改 `diameter` → `defineBrush` 新建「方形400」。⛔⛔ 改直径必须包 `runAsModal`（否则报 only allowed inside a modal scope）**且**下发前用 `jsonSafe()` 剔掉 `ArrayBuffer`/TypedArray（否则报 `Illegal data type. ByteArray`）；defineBrush 前必须**真把白像素 putPixels 进图层**（`documents.add(fill:'white')` 不算，会报「所选区域是空的」）。
64 ⛔⛔ **笔尖尺寸不许降级**：笔尖 ≠ 图案长边就抛错让人修，**绝不把图案缩到笔尖尺寸**——那会让临时画布小于图案（用户看到的"新建画布和我选的笔一样大"），且丢分辨率。

**键盘钩子·插件在位闸（0x0205）** —— 明细 `refs/keyhook-8li.md` N9
65 ⛔⛔⛔ **键盘钩子三路统一过 `g_khPlug`**（LL 钩子安装意图 / 键态轮询 / RegisterHotKey 同步）：18923 无面板客户端 = 插件本体不在位 ⇒ 不装钩、不注册、轮询只消沿。用户报「没加载 UXP 但 L/NUM1 被吞」即缺此闸。⛔ 不做「连过一次就粘住」；断开即卸钩放行（与 0x013E unload 哑火同族）。
66 ⛔⛔ **迁移探测连接必须自报身份**：`kh_try_migrate` 走 `path=/jw-migrate`，服务端 `wc_handshake_path` 抽 path，非 `/` 记 `notPlugin` 不计在位——否则多开 PS 时非持有实例每 10s 的探测会给持有端伪造在位。面板 `new WS('ws://127.0.0.1:18923')` 裸连即 `/`。

## 维护约定

超限先下沉 refs 再精简本文件。`scripts/`=沉淀工具（git 跟踪）；`analysis/`=草稿（gitignored）；`outputs/` 废止。
⛔ 数据目录：`PluginsStorage/PHSP/27/External/`=用户安装版、`.../Developer/`=测试，两者独立**不许合并**；Plug-ins 里的旧 .8li 直接覆盖、**不留备份**（PS 运行时锁文件 ⇒ 覆盖前必须完全退出 PS）。
