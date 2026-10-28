/**
 * 套索实时平滑（Wintab 笔输入通路）的 UXP 侧桥接。
 *
 * 背景（为什么必须走原生）：UXP 插件没有任何画布指针 API，
 * `document.addEventListener('mousemove')` 监听的是**插件面板自身 DOM**，
 * 与 PS 画布无关。也就是说「套索绘制过程中」这段时间对 UXP 是完全盲区 ——
 * 唯一能介入的位置在 **PS 收到输入之前**。
 *
 * ⚠️ 2026-10-12：鼠标钩子通路（WH_MOUSE_LL + SendInput 回注，改光标轨迹）已按用户要求
 *    **整体移除**，只保留笔/Wintab 通路：守护进程把 hook DLL 注入 PS，DLL 在
 *    `Wintab32!WTPacketsGet` 的 detour 里就地改写包坐标（数位板在 PS 里走 Wintab，
 *    笔不产生 WM_MOUSEMOVE，鼠标钩子本来就够不着）。因此本模块的职责收缩为两件事：
 *   ① 把「开关 + 参数」下发给守护进程（penSmooth）；
 *   ② 接收守护进程回传的状态（smoothState），供面板显示与排障；
 *   另有一件隐藏职责：连接（重）建立时把当前意图重放一次，避免「daemon 重启后平滑无声失效」。
 *
 * ⚠️ 本模块**不持有** WebSocket：发送器由 SmoothBridge 注入（它是 **18924** 那条
 *    连接的唯一属主）。平滑与热键拆成两个独立守护进程后，连接不再挂在 HotkeyBridge 上
 *    —— 否则「停止快捷键服务」会连带把平滑的连接一起断掉。
 *    这样依赖方向仍是单向的（SmoothBridge → LassoSmoothing），不会形成循环 import。
 */

import { loadPersistedSmoothOn, persistSmoothOn } from './SmoothPersist';

export type LassoSmoothMode = 'standard' | 'rope' | 'catchup';

/**
 * 工具闸门（2026-10-13 新增）。
 *
 * ⛔ 为什么要它：用户反馈「无论我选择什么工具，只要我用数位笔移动光标，已平滑的数字
 *    就在涨，拉绳工具的洋红圈也都会显示」。根因是 DLL 之前**只判开关**，
 *    悬空移动与落笔绘制都会改写坐标。于是工具一换、笔一抬，平滑与 HUD 依然生效。
 * ⇒ 现在必须由面板 300ms 巡检当前工具，把结果经 penSmooth 搭车下发，
 *    DLL 侧再叠加「笔尖是否接触画布」的判据，两者同时成立才平滑。
 */
export type SmoothToolGate = 0 | 1 | 2;   // 0=不是套索 1=是套索（唯一放行值） 2=未知（原生侧阻断，等首次读数）

/**
 * 「此刻为什么没在改写坐标」——原生侧（hook DLL）在**裁决的同一处**写下的原因码。
 *
 * ⛔⛔ 2026-10-14 第三轮定案（用户原话：「现在诊断不具备可用性……我落笔的时候，
 *    已经画了一段选区了，面板仍然显示已就绪，等笔尖落纸，我早就已经落了！」）：
 *    面板**不允许**自己从 toolGate / penDown / gateOk 拼原因 —— DLL 在闸门不成立时
 *    会主动把 penDown 写成 0（见 smooth_engine.c 的阻断分支），于是
 *    「闸门心跳过期」与「笔尖真的悬空」在面板上长得一模一样，诊断永远吐
 *    「等笔尖落纸」。唯一可行的做法是**原生侧报原因码**，面板只做展示。
 *
 * ⚠️ 与 C 侧 `RS_*`、C# 侧 `reason` 注释**三处逐项对应**，改一处必须同步另两处。
 */
export type SmoothReason =
    | 0   // 正在改写坐标（正常）
    | 1   // 总开关未开
    | 2   // 工具闸门：当前工具不是套索
    | 3   // 工具闸门：面板从未上报过（未知 ⇒ fail-closed 阻断）
    | 4   // 工具闸门：心跳过期（面板 >3s 未上报）
    | 5   // 笔尖未落纸（悬空移动）
    | 6   // 落笔判据**尚未建立**（无信号，或还没有信号同时见过 0 与非 0）；
          //   冷启动宽限（≈3s）内仍按「落笔」放行，宽限之后按「未落笔」阻断
    | 7   // 标定未完成 / 失败
    | 8;  // 还没取到包 / 上下文未知

/** 原因码 → 面板文案（唯一文案表；诊断条与状态条都从这里取，禁止各写一份）。 */
export function smoothReasonText(r: number): string {
    switch (r) {
        case 0:  return '正在改写坐标';
        case 1:  return '平滑总开关未开';
        case 2:  return '当前工具不是套索';
        case 3:  return '尚未收到面板的工具上报';
        case 4:  return '工具上报已超时（超过 3 秒没有心跳）';
        case 5:  return '笔尖未落纸（悬空）';
        case 6:  return '落笔判据尚未建立（信号还没攒够证据）';
        case 7:  return '原生侧标定未完成';
        case 8:  return '尚未取到数位板数据包';
        default: return '未知状态（' + r + '）';
    }
}

/** 参数面（与 Program.cs 的 PenHook.PenParams 一一对应；鼠标通路字段已移除）。 */
export interface LassoSmoothParams {
  /** 滤波族：标准（一阶低通）/ 拉绳 / 追笔。 */
  mode: LassoSmoothMode;
  /** 平滑强度 0–100（标准模式的主轴：越大越黏）。 */
  strength: number;
  /**
   * 最大滞后距离 px。**拉绳模式的绳长**（2026-10-19 起标准/追笔模式的面板不再暴露此参数）。
   *  ⛔ 上限 100：与 PS 自家平滑一致，也与原生侧 RADIUS_PX_MAX 一致。
   *    旧的 40 会把强度调出来的滞后硬截断 ⇒ 「拉满也没感觉」。
   *  ⛔ 2026-10-13：原先还有一个「张力」滑杆，只在 15%~100% 之间缩放这个半径 ——
   *    两个参数改的是同一件事（圆周大小），用户实测后要求删除。现在一个参数一个语义。
   *  ⛔⛔ 2026-10-19：标准/追笔模式下 toWire 固定下发 SMOOTH_RADIUS_MAX（见 toWire），
   *    强度/追笔速度因此满量程生效；本字段在那些模式下只是「切到拉绳时恢复的绳长记忆」。
   */
  radius: number;
  /**
   * 追笔速度「平滑力度」1–100（**显示值**，数值越大 = 平滑越强）。
   * ⚠️ 2026-10-19 标签「追笔」→「追笔速度」（用户要求，与模式名区分）；
   *    数值方向不变（越大越强），帮助文案已同步解释「追赶越慢 = 越黏」。
   *
   * ⛔ 2026-10-14 重映射：原生侧的有效区间本来是 1–50
   *    （`vmax = 0.02 + t/100·3.0` ⇒ t=1 → 0.05 px/ms、t=50 → 1.52 px/ms，
   *    正好覆盖人的运笔速度区间 0.05~1.5 px/ms）。用户实测后要求
   *    「数值越大 = 平滑力度越大」，与其它模式一致 ⇒ 面板显示 1–100 **反向**映射：
   *      显示 1   → 原生 50（跟手，几乎不平滑）
   *      显示 100 → 原生 1 （最黏，平滑最强）
   *    换算见 `catchUpToNative()`；下发前一律取整（见 `toWire` 的 ⛔）。
   */
  catchUp: number;
  /**
   * 尖角保护（原「拐角」）判定角度 0–90（**原生单位，面板不做任何映射**）。
   * ⚠️ 2026-10-19 标签改为「尖角保护」（用户要求）：轨迹相邻两段的**转折角**超过
   *    该值即判定为拐角、自动减弱平滑以保住尖角；数值越小 = 越容易触发保护。
   *
   * ⛔⛔ 2026-10-14 回退定案：这里曾短暂改成「保护范围」（显示 = 90 − 原生阈值，
   *    数值越大保护越广）。用户实测后明确要求回退 —— 「现在反而更加让人迷惑了」。
   *    回退理由（结构性，不是口味问题）：面板上**其它每一个参数都是「越大越强」**，
   *    唯独拐角被反转成「越大 = 保护越广 = 平滑越少」，与「强度」「半径」「力度」
   *    的直觉方向相反；参数之间相互比较时极易误判，而且与原生单位不一致，
   *    排障时要多做一次心算。现在**显示值 = 原生阈值**，一一对应、无需换算。
   *
   * ⚠️ 语义提醒（面板文案已按此写）：这里说的是**转折角**不是夹角 ——
   *    相邻两段方向的夹角超过该值即判为「拐角」并减弱平滑。
   *    ⇒ **数值越小越容易触发保护**（0 = 几乎每帧都保护）。
   *    这是原生判据本身的方向，不改；面板如实呈现，不再反向。
   */
  cornerAngle: number;
  /** 甩笔时自动减弱平滑（减少快速拖拽的滞后）。 */
  speedAdaptive: boolean;
  /**
   * 是否在屏幕上画出「笔尖 ↔ 平滑输出点」的拉绳提示（HUD overlay）。
   * ⚠️ 只对**笔通路**有意义：UXP 无法在 PS 画布上绘制，PS 原生的画笔绳线又只由
   *    它自己的画笔平滑触发，所以这根绳由注入 PS 的 hook DLL 自己画。
   *    映射到共享内存的 hud 位域：bit0=绳 bit1=半径圆。
   */
  showLeash: boolean;
}

/** 参数的取值范围（面板滑杆与原生侧共用同一套上下限，勿各写一份）。 */
export const SMOOTH_RADIUS_MIN = 1;
export const SMOOTH_RADIUS_MAX = 100;

/** 追笔「平滑力度」的显示量程（1–100，越大越黏）。原生有效区间见下。 */
export const SMOOTH_CATCHUP_MIN = 1;
export const SMOOTH_CATCHUP_MAX = 100;
/** 原生追笔速度的有效区间（与 smooth_engine.c 的 `vmax = 0.02 + t/100·3.0` 一致）。 */
const CATCHUP_NATIVE_MIN = 1;
const CATCHUP_NATIVE_MAX = 50;

/**
 * 拐角判定角度的量程（0–90，**原生单位**）。
 * ⛔ 2026-10-14 随「保护范围」回退一并恢复：显示值就是原生阈值，不再有反向映射。
 */
export const SMOOTH_CORNER_MIN = 0;
export const SMOOTH_CORNER_MAX = 90;

function clampNum(v: number, lo: number, hi: number): number {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * 追笔：显示力度(1–100) → 原生速度(1–50)。**数值越大 = 平滑越强**。
 * ⛔ 端点严格对齐用户口径：显示 1 → 原生 50（跟手）、显示 100 → 原生 1（最黏）。
 */
export function catchUpToNative(display: number): number {
    const d = clampNum(display, SMOOTH_CATCHUP_MIN, SMOOTH_CATCHUP_MAX);
    const t = (d - SMOOTH_CATCHUP_MIN) / (SMOOTH_CATCHUP_MAX - SMOOTH_CATCHUP_MIN);   // 0..1
    const native = CATCHUP_NATIVE_MAX - t * (CATCHUP_NATIVE_MAX - CATCHUP_NATIVE_MIN);
    return Math.round(clampNum(native, CATCHUP_NATIVE_MIN, CATCHUP_NATIVE_MAX));
}

/**
 * 拐角：显示值 = 原生转折角阈值，**恒等**（保留函数只为让 `toWire` 的换算意图显式可见）。
 * ⛔⛔ 2026-10-14 回退定案：这里曾做过 `90 − display` 的反向映射（显示「保护范围」），
 *    用户实测后要求回退 —— 「现在反而更加让人迷惑了」。
 *    回退理由：面板其它参数全是「越大越强」，唯独拐角被反转成「越大 = 平滑越少」，
 *    方向与全体不一致，比较参数时极易误判。现在**显示值与原生值一一对应**。
 */
export function cornerToNative(display: number): number {
    const d = clampNum(display, SMOOTH_CORNER_MIN, SMOOTH_CORNER_MAX);
    return Math.round(d);
}

/**
 * 默认值。
 * ⚠️ 开关默认**关闭**：平滑会改变所有存量用户的套索手感，
 *    必须由用户主动开启，不能默认接管。
 */
export const initialLassoSmoothParams: LassoSmoothParams = {
    mode: 'standard',
    strength: 40,
    radius: 12,
    catchUp: 50,
    cornerAngle: 45,
    speedAdaptive: true,
    showLeash: true,
};

/** 守护进程回传的状态（用于面板显示与排障）。 */
export interface LassoSmoothStatus {
  /** 与守护进程的连接是否建立。 */
  connected: boolean;
  /**
   * 连上的守护进程**不支持**套索平滑协议（旧版本）。
   *
   * ⛔ 为什么必须有这个判据：旧版守护进程收到未知的 `smoothStatus` 会**静默忽略**，
   *    本模块因此永远收不到 `smoothState` ⇒ 面板必须把「版本过旧」与「没连上」区分开，
   *    否则会把用户的排查方向完全带偏（真机已复现：安装目录里跑的是旧 exe）。
   *    现在的判据是「建连后发起 smoothStatus 询问，超时窗口内一帧都没回来」。
   */
  unsupported: boolean;
  /**
   * 连上的守护进程**不认识笔平滑**（旧版本）。
   *
   * ⛔ 与 `unsupported` 是**两层**判据，不能合并：套索平滑的探针（有没有回 `smoothState`）
   *    对旧版守护进程是**通过**的 —— 它支持套索平滑、会正常回帧，只是帧里没有 `pen`。
   *    若只看 `unsupported`，套索平滑开关会显示成**可点**，点下去 `penSmooth` 被静默丢弃、
   *    开关弹回 ⇒ 又是一个「点了没反应」。判据因此下沉一层：**回帧里有没有出现过 `pen`**。
   */
  penUnsupported: boolean;
  /** 笔输入层平滑（Wintab 通路）的状态；旧版守护进程不回该字段 ⇒ 落到默认值。 */
  pen: PenSmoothStatus;
}

/**
 * 笔输入层平滑（Wintab 通路）的状态。
 *
 * 守护进程把 hook DLL 注入 PS，DLL 在 `Wintab32!WTPacketsGet` 的 detour 里
 * 就地改写 X/Y —— 改的是 **PS 进程内的包坐标**。
 *
 * 旧版守护进程不回 `pen` ⇒ 保持原值（默认 enabled=false），不会把「不认识」显示成「已开」。
 */
export interface PenSmoothStatus {
  enabled: boolean;
  /** 平滑强度 0–100。 */
  strength: number;
  /** 滤波族：0=标准 1=拉绳 2=追笔（与面板模式下拉同序）。 */
  mode: number;
  /** 最大滞后（屏幕像素）。 */
  radiusPx: number;
    /**
     * 闸门来源：0=进程内读取不可用（面板必须继续自己轮询工具）
     *           1=已注册 PS 'slct' 通知但**还没读到过**工具（面板继续轮询）
     *           2=已读到过 ⇒ **通知已接管**（面板**必须停止**轮询，否则两边互相覆盖）
     *
     * ⛔ 为什么必须有它：旧实现由面板每 300ms 用 batchPlay 读一次工具。每次读都要进
     *    一次模态作用域，而全工程的模态请求共用 `MIN_MODAL_GAP_MS=300` 的节流预算
     *    （上限 3.3/s）—— 300ms 一轮的巡检**恰好把预算吃满**，于是「自动填充」这类
     *    本来就要弹模态的操作一叠加，请求率立刻超过吞吐 ⇒ 告警风暴（用户报的
     *    「modal scope 暴涨」）。.8li 在 PS 进程内注册 'slct' 通知后即可零成本取到
     *    当前工具，面板这条轮询就整条不需要了。
     * ⚠️ -1 = 对端是旧版（无此字段）⇒ 保持轮询。
     */
    toolSrc: number;
    /** 进程内读到的工具类名（如 lassoTool）；空串 = 还没读到。仅用于诊断展示。 */
    psTool: string;
    /**
     * 进程内观测：PS **模态嵌套层级**（2026-10-17，来自 PICA `modalStateChanged`
     * 回调读描述符键 `'Lvl '`）。-1 = 对端不报/从未投递；0 = 宿主空闲；>0 = 宿主
     * 正握着模态作用域。
     *
     * ⛔ 这是 `isPsBusy()` + `MIN_MODAL_GAP_MS` 那整套**猜测式**忙碌闸门的**进程内
     *    替身**：面板以前只能靠「我上次请求是多久之前」间接猜 PS 忙不忙，现在 PS
     *    自己把层级报出来了，而且**零 batchPlay**。面板据此在 `>0` 时跳过自己的
     *    巡检类模态请求 —— 既省预算，也避免与 PS 自己的模态叠加触发告警风暴。
     * ⚠️ 观测时刻见 `modalTs`（GetTickCount 口径，与 `snAge` 不同源）：
     *    层级只在**变化**时投递，值本身可能很旧 ≠ 此刻仍忙。判「此刻忙」必须
     *    结合 modalTs 的新鲜度（面板侧用 MODAL_STALE_MS=3000）。
     */
    modalLevel: number;
    /** 上条层级的观测时刻（GetTickCount 口径，0=从未观测）。 */
    modalTs: number;
    /**
     * 进程内观测：工具模态（`toolModalStateChanged`）。-1 = 从未投递。
     * ⛔ LNP 自己的这个回调是**空函数**，「工具进入绘制态」能否在 PS 27.11 上真
     *    的投递**未经证明**。因此这里只取证、不门控：等真机日志证明极性后再接。
     */
    toolModal: number;
    /** 上条的极性是否已证明（见过 0 与 1 两种值）。 */
    toolModalKnown: number;
    /** 进程内观测：文档开/关累计（'Opn '/'Cls '）——文档级变化的进程内副本。 */
    docEpoch: number;
    /**
     * 进程内观测：距上次 `'slct'` 回调的毫秒数（**-1 = 从未投递过**）。纯诊断。
     *
     * ⛔ **不要**拿它自己算「闸门该不该由进程内供给」—— 阈值在原生侧，用
     *    `gateOwned` 那个**结论**。两边各存一份阈值迟早不同步，而不同步的表现
     *    正好是「两边都以为自己该写闸门」（真机 pid 13428 的教训）。
     */
    notifyAge: number;
    /**
     * 进程内观测：**此刻**闸门是否真的由 `'slct'` 供给（1/0）。-1 = 对端不报（旧版）。
     *
     * ⛔ 这是面板「要不要给闸门让位」的**唯一判据**，取代了原来裸用 `toolSrc === 2`。
     *
     * 起因（真机 pid 13428）：`'slct'` 连投 5 次后彻底静默 72 秒，而 `state` 仍是 2
     * ⇒ 闸门被永久冻结在最后一次的值、面板已停轮询、开关平滑也救不回来。
     * 现在原生侧给「接管」加了 2 秒时效：静默超时即 `gateOwned = 0`，面板据此
     * **按 2 秒降频兜底轮询**（而不是完全停、也不是回到 300ms 全速）。
     */
    gateOwned: number;
    /** 工具闸门：0=当前不是套索 1=是套索 2=未知/读数失败（放行）。 */
    toolGate: SmoothToolGate;
    /** 原生侧回报：工具闸门是否成立（0=当前工具不是套索，正在禁止平滑）。 */
    toolOk: number;
    /** 原生侧回报：笔尖是否接触画布（0=悬空，正在禁止平滑）。 */
    penDown: number;
    /** 原生侧回报：两个闸门都成立（1=此刻真的在改写坐标）。 */
    gateOk: number;
    /**
     * 原生侧回报：落笔判据是否**不可用**（1=不可用）。
     *
     * ⛔ 为什么必须暴露它：落笔判据是从 (offY, stride) 反推候选偏移、再用真实数据
     *    证伪/校验出来的。若本机驱动的包布局不在预期内，判据会退化为「按落笔处理」
     *    （= 恢复旧行为：悬空移动也会被平滑）。这种退化**必须看得见** ——
     *    否则用户只会觉得「这个开关没用」，而排查的人连「判据没生效」都不知道。
     */
    contactUnknown: number;
  /**
   * 原生侧回报：**此刻为什么没在改写坐标**（见 `SmoothReason`）。
   *
   * ⛔ 这是诊断条的唯一权威判据。绝不能退回成「面板自己拼 toolGate/penDown/gateOk」：
   *    那样必然把「心跳过期」显示成「等笔尖落纸」（真机复现的原始投诉）。
   * ⚠️ 它是**上一次裁决的结论**，空闲时会停在最后一个值 —— 必须结合 `snAge` / `state`
   *    判断这条结论是否还新鲜（见面板 smoothDiagText 的处理）。
   * ⚠️ **-1 = 对端不报该字段**（旧版守护进程）⇒ 面板必须退回旧的
   *    toolOk/penDown/gateOk 判据，不能把 -1 当成一个真实原因显示。
   */
  reason: number;
  /**
   * 原生侧回报：闸门「关→开」/「开→关」的累计次数（**累计值**）。
   *
   * ⛔ 判抖动必须用**两次回报之间的增量**，不能直接看这两个总数的差额 ——
   *    画了一百笔之后两者都接近 100、差额恒为 0，光看总数永远看不出抖动。
   *    正确判据 = 一次回报内 Δopen 就涨了好几次：闸门在一笔之中反复开合，
   *    选区就被劈成一段一段（见 app.tsx 的 lastGateDeltaOpen）。
   */
  gateOpen: number;
  gateClose: number;
  /**
   * 原生侧回报的落笔判据信号表（**多信号并联**，2026-10-14 第五轮）。
   *
   * 判据 = buttons / pkNormalPressure / pkTangentPressure **任一非零**即「落笔」；
   * 三者全零且持续 CONTACT_HOLD_MS(250ms) 才算抬笔。旧版只认**一个**字段
   * （真机取到 pkNormalPressure=32），而套索是轻触运笔、笔压会成段读到 0 ⇒
   * 闸门反复闭合 ⇒ 重新锚定 + HUD 隐藏（用户报的「平滑和 HUD 一起失灵」）。
   *
   * ⛔ 判读：
   *   · `ctOff`   = **首选**信号偏移（-1 = 无信号）；
   *   · `ctVal`   = 首选信号最近一包的原始值；
   *   · `ctElig`  = **有投票权**的信号位掩码（bit i = 第 i 个信号同时见过 0 与非 0）；
   *   · `ctHit`   = **本批命中**的信号位掩码（bit i = 第 i 个信号非零，把闸门顶上去了）；
   *   · `ctOffs`  = 信号偏移打包（第 i 个占第 i×8 位）⇒ 能看出「到底在盯哪几个字节」。
   *   `ctElig === 0` 意味着判据**压根没建立**（宽限之后会阻断一切平滑）。
   */
  ctElig: number;
  ctHit: number;
  ctOffs: number;
  /**
   * 原生侧回报：落笔判据**首选**信号偏移 + 它最近一包读到的值（`ctOff = -1` ⇒ 无信号）。
   *
   * ⛔ 「判据字段一直读到 0」与「闸门被其他条件阻断」的唯一区分依据 ——
   *    前者 ctOff 有效而 ctVal=0，后者原因码会先报闸门。
   */
  ctOff: number;
  ctVal: number;
  /**
   * 原生侧回报：逐轴「轴→像素」标定的**样本数**。
   *
   * ⛔ 为什么必须暴露：标定器改成了「位移加和」（等效窗口 256 样本、噪声按 √N 收敛），
   *    采信门槛是 24 个样本。样本数不够时 pxPerAxis 仍用标称兜底，**方向信息不可信** ——
   *    「圆心与受力点分离」这类问题的第一判据就是它够不够。
   */
  pxNx: number;
  pxNy: number;
  /** 原生侧回报：追笔速度（**原生单位 1–50**，面板显示值是它的反向映射）。 */
  catchUp: number;
  /** 原生侧回报：拐角转折角阈值（**原生单位 0–90**，面板显示值是它的反向映射）。 */
  cornerAngle: number;
  /** 速度自适应是否开启。 */
  speedAdaptive: boolean;
  /** HUD 显隐位：bit0=绳 bit1=半径圆 bit2=原始点。 */
  hud: number;
  /** ×1000 的「轴坐标 → 屏幕像素」比，由 hook DLL 用真实光标标定后上报。
   *  1.0 ⇒ 包坐标本身就是屏幕像素；0.0586 ⇒ 数位板逻辑单位（1920/32767）。
   *  leash 长度/位置不对时第一个该看的就是它。 */
  pxPerAxis: number;
  /**
   * ×1000 的 **Y 轴**「轴坐标 → 屏幕像素」比（**带符号**，通常是负的）。
   *
   * ⛔ 为什么必须单独上报 Y：数位板到屏幕的映射是**逐轴**的 ——
   *    两个轴的比例不同（本机 X 0.0768 / Y 0.0486，差 1.58 倍），
   *    而且 Y 的符号与屏幕相反（Wintab 的 Y 向上为正、屏幕 Y 向下为正）。
   *    旧版只有一个不带符号的标量，HUD 的圆心因此被渲染成光标的**镜像**
   *    （向右上运笔、圆心跑到左上方）。排障时这两个值必须一起看。
   */
  pxPerAxisY: number;
  /** 已注入 hook DLL 的 PS 进程数（0 ⇒ 还没注入成功或 PS 未运行）。 */
  injectedCount: number;
  /** hook 侧状态：0=未挂载/未标定 1=生效 2=标定失败 3=已卸载 4=入口被旧副本占用（须重启 Photoshop）。 */
  state: number;
  /** 累计取到的包数 / 被改写的包数（生效与否最直接的证据）。 */
  packets: number;
  smoothed: number;
  /**
   * 「快照年龄」(ms)：距 hook DLL 最后一次发布 HUD 快照的时间。
   * ⛔ 面板「平滑中断」检测的数据源：packets 在涨而它 >2s = 断流
   * （标定丢失/改写被跳过）；停笔时它与 packets 年龄同步增长（正常）。
   * -1 = 对端是旧版守护进程（无此字段）。
   */
  snAge: number;
}

/** 笔平滑状态的初值（也是「对端不回该字段」时的兜底值）。 */
export const initialPenSmoothStatus: PenSmoothStatus = {
  enabled: false,
  strength: 40,
  mode: 0,
  radiusPx: 12,
    catchUp: 50,
    cornerAngle: 45,
    speedAdaptive: true,
    hud: 3,
    toolSrc: -1,        // -1 = 对端不报该字段（旧版）⇒ 面板保持自己轮询
    psTool: '',
    // 进程内观测（PICA 通知）。-1 = 对端不报 ⇒ 面板退回自己的猜测式忙碌闸门。
    modalLevel: -1,
    modalTs: 0,
    toolModal: -1,
    toolModalKnown: 0,
    docEpoch: 0,
    notifyAge: -1,
    gateOwned: -1,      // -1 = 对端（旧版 .8li）不报 ⇒ 面板退回按 toolSrc===2 判
    toolGate: 2,
    toolOk: 0,
    penDown: 0,
    gateOk: 0,
    contactUnknown: 0,
    reason: -1,         // -1 = 对端（旧版守护进程）不报原因码 ⇒ 面板退回旧判据
    gateOpen: 0,
    gateClose: 0,
    ctOff: -1,
    ctVal: 0,
    ctElig: 0,
    ctHit: 0,
    ctOffs: 0,
    pxNx: 0,
    pxNy: 0,
  pxPerAxis: 0,
  pxPerAxisY: 0,
  injectedCount: 0,
  state: 0,
  packets: 0,
  smoothed: 0,
  snAge: -1,
};

const initialStatus: LassoSmoothStatus = {
  connected: false,
  unsupported: false,
  penUnsupported: false,
  pen: { ...initialPenSmoothStatus },
};

/** 供面板 state 初始化用（AppState.smoothStatus 的初值）。 */
export const initialLassoSmoothStatus: LassoSmoothStatus = { ...initialStatus };

/** 面板 UI 模式 → 线格式数值。⛔ 导出给诊断条：比对「面板模式 vs 引擎模式」用。 */
export const MODE_TO_WIRE: Record<LassoSmoothMode, number> = { standard: 0, rope: 1, catchup: 2 };

/** 参数下发的节流窗口（毫秒）：拖动滑杆时合并中间值，松手后必然落到最终值。 */
const PARAM_THROTTLE_MS = 90;

/**
 * 「对端是否支持平滑协议」的探测窗口（毫秒）。
 * 取值理由：本地回环 WebSocket 的往返是亚毫秒级，2.5s 足够覆盖 GC/冷启动抖动；
 * 又不至于让用户在开启开关后等太久才看到「版本过旧」的结论。
 */
const PROBE_TIMEOUT_MS = 2500;

let sender: ((msg: any) => void) | null = null;
/**
 * 套索平滑（Wintab 笔通路）的开关意图。
 * ⛔ 必须有它：面板每次调参都要同步推给笔通路 —— 否则调参只改面板自己的 state，
 *    笔通路永远停在旧值（真机复现：「已平滑 47417 包但各种参数组合感知不明显」的根因之一）。
 */
let penOn = false;
let params: LassoSmoothParams = { ...initialLassoSmoothParams };
let status: LassoSmoothStatus = { ...initialStatus };

let pendingParams: LassoSmoothParams | null = null;
let paramTimer: any = null;
/**
 * 当前工具闸门（模块级，与 penOn 同生命周期）。
 * ⚠️ 初值 2（未知）而不是 0：读不到工具时**必须放行** —— 把「读失败」当成
 *    「不是套索」会把平滑整个关掉，而面板上看不出任何区别（开关还是开着）。
 */
let toolGate: SmoothToolGate = 2;
/** 0x0133：最后一次**成功读到工具**的时刻（0 = 从未读到）。
 *  ⛔ 只在真读到工具时更新：读失败/被忙碌闸门挡住时**不更新** ⇒ 年龄自然增长 ⇒
 *     原生侧 3s 后 fail-closed。这是「闸门值可以过期」的唯一实现点。 */
let lastToolReadAt = 0;

/** 0x0133：面板**真的读到**了当前工具（不论是不是套索）时调用。 */
export function noteToolReadOk(): void { lastToolReadAt = Date.now(); }
/** 上一次把闸门（连同整包参数）推给守护进程的时刻 —— 闸门心跳的计时基准。 */
let lastGateSentAt = 0;
/** 能力探测：本轮连接是否至少收到过一帧 smoothState。 */
let sawSmoothState = false;
/** 能力探测（第二层）：本轮连接是否至少有一帧带 `pen` 字段 ⇒ 对端认识笔平滑。 */
let sawPenFrame = false;
let probeTimer: any = null;
/**
 * 上一次真正发出去的参数线格式签名。
 * ⚠️ 必须有它：调参可能被高频触发（拖滑杆、节流尾随），没有这层去重就会打重复消息。
 */
let lastSentParamsSig: string | null = null;

const statusListeners: ((s: LassoSmoothStatus) => void)[] = [];

function send(msg: any): void {
  if (!sender) return;
  try { sender(msg); } catch { /* 发送失败由 SmoothBridge 的重连机制兜底 */ }
}

function toWire(p: LassoSmoothParams) {
    return {
        mode: MODE_TO_WIRE[p.mode] ?? 0,
        // ⛔⛔ 一律取整（**第一道防线，唯一咽喉**）。
        //   起因（真机事故）：这里曾原样透传面板值，而 RangeSlider / 标签拖拽 / 持久化
        //   任一条路径都可能漏出小数（如 radius=95.5）。旧版守护进程的 PenWire 字段是
        //   `int?`，System.Text.Json 把 "95.5" 读进 int? 会**抛异常** ⇒ 外层 catch 把
        //   **整条 penSmooth**（连同 on / mode / toolGate / heal / broadcast）整包丢弃，
        //   用户看到的现象就是「切换模式后平滑中断」（真实日志有 137 条
        //   `The JSON value could not be converted to System.Nullable\`1[System.Int32]`）。
        //   现在两端都设防：这里取整；守护进程侧 PenWire 也改用 `double?` 接收（第二道
        //   防线）。但**这道不能撤** —— 旧版 daemon 仍在野生环境里跑。
        strength: Math.round(p.strength),
        // ⛔⛔ 2026-10-19：半径 = **拉绳模式的绳长**；标准/追笔模式面板已去掉该参数
        //   （用户要求「一个模式一个参数」），这两个模式下固定下发 SMOOTH_RADIUS_MAX
        //   当原生侧的硬上限 —— 否则隐藏的默认值（12px）会把强度/追笔速度的满量程
        //   截断（τ(100)=250ms 在 500px/s 下势能 ≈125px，被 12px 一夹就「强度拉满没感觉」）。
        //   ⚠️ 拉绳模式仍下发用户设定值（绳长 = 半径，语义不变）。
        radius: p.mode === 'rope' ? Math.round(p.radius) : SMOOTH_RADIUS_MAX,
        catchUp: catchUpToNative(p.catchUp),
        cornerAngle: cornerToNative(p.cornerAngle),
        speedAdaptive: p.speedAdaptive,
        // 拉绳提示的位域（bit0=弹性画笔带 bit1=绳长圆 bit2=笔尖点）
        hud: p.showLeash ? 7 : 0,
        // 工具闸门搭车同一条消息：与参数同源同节流，杜绝「界面显示套索、
        // 原生侧还按画笔处理」的错位窗口。
        toolGate,
        // 0x0133：闸门读数**有多旧**（ms）。原生侧用它当 I_GATETS 的写入值，
        //    不再写 now —— 否则 1.5s 心跳会把一个过期的「是套索」永久续命
        //    （用户实测：用铅笔时套索 HUD 意外出现）。
        // ⛔ 0 = 「还没有读数」⇒ 原生侧按旧行为处理（不把老面板打死）。
        gateAge: lastToolReadAt > 0 ? Math.round(Math.max(0, Math.min(60000, Date.now() - lastToolReadAt))) : 0,
    };
}

/** 发送参数（线格式未变化则跳过；仅在套索平滑开着时才需要推给守护进程）。 */
function sendParams(p: LassoSmoothParams): void {
  if (!penOn) return;   // 关着的时候守护进程不需要参数（开启时会整包下发）
  const wire = toWire(p);
  const sig = JSON.stringify(wire);
  if (sig === lastSentParamsSig) return;
  lastSentParamsSig = sig;
  send({ type: 'penSmooth', on: true, ...wire });
}

function emitStatus(): void {
  for (const l of statusListeners) { try { l(status); } catch { /* ignore */ } }
}

/** 由 SmoothBridge 在模块初始化时注入（它是 WebSocket 的唯一属主）。 */
export function setLassoSmoothSender(fn: (msg: any) => void): void {
  sender = fn;
}

/** 连接状态变化（SmoothBridge 的 onopen / onclose 调用）。 */
export function setLassoSmoothConnected(connected: boolean): void {
  if (status.connected === connected) return;
  status = { ...status, connected };
  if (connected) {
    // 建连（或重连）后开始等第一帧：resendLassoSmoothing 会主动发一条 smoothStatus 询问，
    // 支持该协议的守护进程必然回一帧 smoothState。超时未回 ⇒ 对端是旧版本，如实标记。
    // ⚠️ 每次重连都重新计时并把上一轮的 unsupported 结论清掉（daemon 可能刚被更新过）。
    status = { ...status, unsupported: false, penUnsupported: false };
    if (typeof setTimeout === 'function') {
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = setTimeout(() => {
        probeTimer = null;
        if (status.connected && !sawSmoothState) {
          status = { ...status, unsupported: true };
          emitStatus();
        } else if (status.connected && !sawPenFrame) {
          // 对端会回 smoothState、但帧里从来没有 pen 字段（版本过旧）⇒ 单独标记，
          // 别让开关看起来可点。与上一层（unsupported）分开：旧版是**通过**smoothStatus 探针的。
          status = { ...status, penUnsupported: true };
          emitStatus();
        }
      }, PROBE_TIMEOUT_MS);
    }
  }
  emitStatus();
}

export function getLassoSmoothParams(): LassoSmoothParams {
  return { ...params };
}

export function getLassoSmoothStatus(): LassoSmoothStatus {
  return { ...status };
}

export function onLassoSmoothStatus(fn: (s: LassoSmoothStatus) => void): () => void {
  statusListeners.push(fn);
  fn(status);
  return () => {
    const i = statusListeners.indexOf(fn);
    if (i >= 0) statusListeners.splice(i, 1);
  };
}

/**
 * 下发参数（节流 + 尾随合并）。
 *
 * ⚠️ 首个值**立即**发送：拖动滑杆的第一下必须马上生效，
 *    否则用户会感到「拖了没反应」。之后 90ms 内的多次调用只更新待发值，
 *    由尾随定时器统一发出 ⇒ 速率上限约 12 次/秒（计划里的验收口径）。
 */
export function pushLassoSmoothParams(p: LassoSmoothParams): void {
  params = { ...p };
  pendingParams = params;
  if (paramTimer) return;
  const flush = () => {
    const q = pendingParams;
    pendingParams = null;
    if (q) sendParams(q);
  };
  flush();
  if (typeof setTimeout === 'function') paramTimer = setTimeout(() => { paramTimer = null; flush(); }, PARAM_THROTTLE_MS);
}

/**
 * 重放当前意图（由 SmoothBridge 在每次 WebSocket 建连后调用）。
 *
 * 为什么必须重放：守护进程是独立进程，插件重载或 daemon 重启都会让
 * 「面板以为开着、daemon 其实没有」—— 表现为平滑无声失效。
 * 这里重放一次 penSmooth（含开关状态）+ 一次状态查询。
 */
export function resendLassoSmoothing(): void {
  // 新的一轮连接：能力探测重新开始（对端可能刚从旧版更新过）
  sawSmoothState = false;
  sawPenFrame = false;
  // 刚建连：先无条件把参数推一遍（对端可能是刚启动的新进程，它那边的参数缓存是空的），
  // 因此这里刻意清掉签名去重。
  lastSentParamsSig = null;
  if (penOn) send({ type: 'penSmooth', on: true, ...toWire(params) });
  // 主动询问一次状态：这是「对端支不支持本协议」的探针 —— 支持则必回一帧 smoothState，
  // 不支持（旧版守护进程把未知 type 静默丢弃）则什么都不回，由 PROBE_TIMEOUT_MS 判定。
  send({ type: 'smoothStatus' });
}

/**
 * 上报当前工具闸门（面板 300ms 巡检调用）。
 *
 * ⛔ 两条触发条件缺一不可：
 *   ① 值变了 —— 常规通路；
 *   ② 距上次上报超过 GATE_REFRESH_MS —— **心跳**。
 * 为什么必须有②：原生侧只认「新鲜」的闸门值——超过 3 秒未刷新一律**阻断**
 * （fail-closed，见 smooth_engine.c 的 GATE_STALE_MS；2026-10-14 起过期不再放行）。
 * 若只在变化时发，「0/1」会一直留在共享内存里无人续期。每 ~1.8s 重刷一次
 * （另有 syncGateHeartbeat 的 1.5s 纯 WS 心跳兜底，不依赖 batchPlay 读数）。
 */
export function setSmoothToolGate(g: SmoothToolGate): void {
  const now = Date.now();
  const changed = toolGate !== g;
  if (changed) toolGate = g;
  if (!penOn) return;              // 关着时不必发；开启时会整包带上
  if (!changed && (now - lastGateSentAt) < GATE_REFRESH_MS) return;
  // ⛔ 心跳必须**绕过线格式签名去重**：内容完全一样，签名必然相同，
  //    走 sendParams 会被它直接吞掉 ⇒ 心跳形同不存在（这正是最容易被写错的一步）。
  forceSendParams();
}

/** 闸门心跳间隔（ms）。必须显著小于原生侧的 GATE_STALE_MS(3000)。 */
const GATE_REFRESH_MS = 1800;

/** 无条件把当前「开关 + 整包参数」推一次（跳过去重）。 */
function forceSendParams(): void {
  lastGateSentAt = Date.now();
  const wire = toWire(params);
  lastSentParamsSig = JSON.stringify(wire);
  send({ type: 'penSmooth', on: true, ...wire });
}

/**
 * 0x020A：Alt 临时吸管的**硬否决位**（发往 18924，与 `penSmooth` 同一条通道）。
 *
 * 置 1 ⇒ 引擎立刻停止坐标改写、停止显示 HUD，**不看**闩锁、不看心跳、不看 gateOwned。
 *
 * ⛔⛔ 为什么不能拿 `setSmoothToolGate(0)` 顶替：
 *    原生 `write_params()` 在 `pstool_owns()`（进程内 'slct' 回调已接管）时
 *    **一个字节都不写** `I_TOOLGATE` —— 面板下发的 0 会被静默丢弃。
 *    于是切到吸管后引擎仍按「套索」放行：吸管按笔吸色时冒出 HUD，
 *    而且取色点被拉绳偏移（用户报的两条正是这个）。
 *    ⇒ 必须是一条**独立槽位**，且不受任何让位规则影响。
 *
 * ⛔ 不受 `penOn` 限制：这是「撤销」通路，关着也必须能发出去
 *    （残留 1 会让套索平滑整段失效，而界面上看不出原因）。
 */
export function setAltToolOverride(on: boolean): void {
  send({ type: 'altTool', on: on ? 1 : 0 });
}

/**
 * 闸门心跳定时器（⛔⛔ 2026-10-14：与 batchPlay 工具读**彻底解耦**）。
 *
 * 为什么必须独立于 pollSmoothToolGate：旧版心跳寄生在工具巡检里，而巡检有三条
 * 提前 return（isPsBusy / 读挂起 ≤3s / 模态节流）—— 任何一条连续挡住 3 秒，
 * 原生侧 GATETS 就过期。旧原生侧对过期是 fail-open ⇒「任何工具落笔都出 HUD」；
 * 新原生侧改为 fail-closed 后，心跳再断就会把套索平滑也误杀。
 * ⇒ 心跳必须是**纯 WS 发送**（不碰 batchPlay、不查忙碌闸门），面板 JS 活着就在跳。
 * 间隔 1500ms < GATE_STALE_MS(3000)，留一倍裕量。
 */
let gateHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

function syncGateHeartbeat(): void {
  if (penOn && gateHeartbeatTimer == null) {
    gateHeartbeatTimer = setInterval(() => {
      if (!penOn) return;
      forceSendParams();   // 内容不变也会刷新守护进程侧的 GATETS（心跳本体）
    }, 1500);
  } else if (!penOn && gateHeartbeatTimer != null) {
    clearInterval(gateHeartbeatTimer);
    gateHeartbeatTimer = null;
  }
}

export function getSmoothToolGate(): SmoothToolGate {
  return toolGate;
}

/**
 * 套索平滑（Wintab 通路）开关 + 参数。
 *
 * ⛔ 与 `sendPenSmooth`（SmoothBridge 的原始发送器）的分工：本函数是**参数面的属主**，
 *    负责记住 `penOn` 以便后续每次调参都同步推给笔通路；原始发送只认线格式。
 * ⛔ 必须整包带参数：早期只发 `{on}`，守护进程侧强度恒为默认 40、半径/模式/张力/
 *    追笔/拐角连槽位都没有 ⇒ 面板调参对笔平滑零作用（真机复现）。
 *
 * ⛔⛔ 2026-10-19：开关位置 = **用户意图**（penOn），不再由 WS 连接状态驱动。
 *    起因（用户报）：WS 瞬断（.8li 忙碌/重连窗口，onclose → 1.5s 后重连）时
 *    `connected` 翻 false，旧版开关判据 `connected && pen.enabled` 把开关
 *    显示成「服务未启动」并翻到关位，几秒后重连又翻回来 —— 用户什么都没做，
 *    开关自己跳了两下。现在：
 *      · 开关显示 penOn（用户意图）：连接瞬断**不翻开关**，只影响状态条文案；
 *      · 点击立即乐观更新 status.pen.enabled 并 emitStatus（不等回帧），
 *        .8li 的 commit() 收到 penSmooth 会立刻广播一帧 smoothState 确认；
 *      · 回帧**不再覆写 penOn**（见 handleLassoSmoothMessage）：.8li 的 enabled
 *        唯一写入源就是本函数的指令流，两边同源不会失真。
 */
export function setPenSmooth(on: boolean, p?: LassoSmoothParams): void {
  const intentChanged = penOn !== on;
  penOn = on;
  // ⛔ 带参数调用时必须**同步模块副本**：模块级 `params` 是心跳（forceSendParams）与
  //    重连重放（resendLassoSmoothing）的数据源，若只发不改，之后 1.5s 一次的心跳会用
  //    陈旧的模块值整包覆盖守护进程 ⇒ 用户刚改的模式/参数被无声冲回（真机复现过
  //    「拖完滑杆过一两秒又弹回」）。pushLassoSmoothParams 也写同一份，两处保持一致。
  if (p) params = { ...p };
  syncGateHeartbeat();
  send({ type: 'penSmooth', on, ...(p ? toWire(p) : {}) });
  /* 用户意图落盘（0x0123）：只在**开关真的变了**时写，避免心跳/调参把同一状态
     反复刷盘。⛔ 2026-10-19 起回帧不再赋值 penOn（见 handleLassoSmoothMessage），
     「用户意图」与「原生状态」因此彻底分离：前者只在这里写，后者只进 status.pen。 */
  if (intentChanged) {
    void persistSmoothOn(on);
    // 乐观更新：点击即刻反馈（含未连接时的意图记录），回帧只做确认/纠正。
    // ⚠️ 只动 pen.enabled 一个字段：其余诊断字段保持最后一帧的值，
    //    状态条在断连宽限内正是靠它们继续显示上一状态（见 app.tsx 的宽限逻辑）。
    status = { ...status, pen: { ...status.pen, enabled: on } };
    emitStatus();
  }
}

/** 开关的显示位置 = 用户意图（penOn）。⛔ 不要用 connected && pen.enabled 判「开没开」：
 *  连接瞬断时那个判据会把开关翻到关位（2026-10-19 用户报的自动跳变）。 */
export function isPenSmoothOn(): boolean {
  return penOn;
}

/**
 * 恢复上次会话的平滑开关意图（0x0123，面板在 state 恢复完成后调用）。
 *
 * ⛔ 时机要求：必须在 smoothParams 已从 panel-state.json 恢复之后调用，
 *    否则重放出去的参数是默认值（半径 40 / 标准模式），用户上次调好的参数会被
 *    心跳整包覆盖。见 App 的 panelStateLoaded 分支。
 * ⛔ 未连接也安全：penOn 会被记住，WS 建连后 resendLassoSmoothing 自动重放。
 * 文件缺失（用户从未表过态）⇒ 什么都不做，保持原有「默认关」。
 */
export async function restorePersistedPenSmooth(p?: LassoSmoothParams): Promise<void> {
  const want = await loadPersistedSmoothOn();
  if (want === true && !penOn) setPenSmooth(true, p ?? params);
}

/** 处理守护进程回传的 smoothState（由 SmoothBridge 的 onmessage 分发）。 */
export function handleLassoSmoothMessage(msg: any): void {
  if (!msg) return;
  // 收到任何一帧即可判定对端支持本协议（即便此刻字段还是开关前的初始值）。
  sawSmoothState = true;
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  const penRaw = msg.pen;
  if (penRaw) {
    sawPenFrame = true;
    // ⛔⛔ 2026-10-19：**不再**用回帧的 enabled 覆写 penOn。
    //    旧版在这里 `penOn = penRaw.enabled`，本意是「与原生真实状态对齐」，
    //    实际制造了开关自动跳变：.8li 重启/重连后accept线程会先推一帧**重启前的
    //    旧值**（enabled=false），面板收到就把开关翻到关位，随后 resend 重放
    //    penOn=true、commit 再推一帧又翻回来 —— 用户什么都没做，开关跳了两下。
    //    现在 penOn 只由**用户意图**驱动（setPenSmooth / restorePersistedPenSmooth）：
    //    .8li 的 enabled 唯一写入源就是面板的 penSmooth 指令流（shutdown 入口已退役），
    //    两边同源 ⇒ 不会失真；重连时 resendLassoSmoothing 负责把意图重放给新进程。
    //    回帧仍然更新 status.pen（状态条文案/配色的数据源），只是不碰开关位置。
    syncGateHeartbeat();
  }
  status = {
    ...status,
    connected: true,
    unsupported: false,
    // 只要有一帧带 pen 就说明对端认识笔平滑（无论此刻开没开）。
    penUnsupported: penRaw ? false : status.penUnsupported,
    // ⚠️ 对端不回 pen（旧版守护进程）时保持原值 —— 不能把「不认识」当成「已关闭」后
    //    又把开关显示成可点，那会造出「点了没反应」。
    pen: penRaw ? {
      enabled: !!penRaw.enabled,
      strength: Number(penRaw.strength) || 0,
      mode: Number(penRaw.mode) || 0,
      radiusPx: Number(penRaw.radiusPx) || 0,
      catchUp: Number(penRaw.catchUp) || 0,
      cornerAngle: Number(penRaw.cornerAngle) || 0,
      speedAdaptive: !!penRaw.speedAdaptive,
      hud: Number(penRaw.hud) || 0,
      // 闸门三态：旧版守护进程不回这几个字段 ⇒ Number(undefined)=NaN ⇒ 用 ? 回落初值，
      // 不能让 NaN 进 state（「开着却不平滑」的排查会先被 NaN 污染）。
      // 闸门来源（进程内 'slct' 通知）。⚠️ 旧版对端不回 ⇒ 保持 -1（继续自己轮询）。
      //   ⛔ 这里**不能**用 `|| 0` 兜：0 的含义是「进程内读取不可用，面板必须继续轮询」，
      //      把「字段不存在」洗成 0 只是恰好同向，但一旦将来语义变化就会静默失效。
      toolSrc: penRaw.toolSrc === undefined ? status.pen.toolSrc : (Number(penRaw.toolSrc) || 0),
      psTool: typeof penRaw.psTool === 'string' ? penRaw.psTool : status.pen.psTool,
      // 进程内观测（PICA 通知，2026-10-17）。⛔ 逐个 `=== undefined` 回落、绝不用 `|| 0`：
      //   modalLevel 的 -1 是**合法值**（对端不报 / 从未投递），洗成 0 会被面板读成
      //   「宿主空闲」⇒ 恰好在最该省预算的时候把预算放出去。toolModal 同理（-1=未知，
      //   0 却是「工具不在绘制态」，语义相反）。
      modalLevel: penRaw.modalLevel === undefined ? status.pen.modalLevel : (Number(penRaw.modalLevel) || 0),
      modalTs: penRaw.modalTs === undefined ? status.pen.modalTs : (Number(penRaw.modalTs) || 0),
      toolModal: penRaw.toolModal === undefined ? status.pen.toolModal : (Number(penRaw.toolModal) || 0),
      toolModalKnown: penRaw.toolModalKnown === undefined ? status.pen.toolModalKnown : (Number(penRaw.toolModalKnown) || 0),
      docEpoch: penRaw.docEpoch === undefined ? status.pen.docEpoch : (Number(penRaw.docEpoch) || 0),
      // ⛔ 同样逐个回落到 -1，不能用 `|| 0`：notifyAge 的 -1 是「从未投递」，
      //    gateOwned 的 -1 是「对端不报」—— 洗成 0 会让面板读成「回调刚发生 /
      //    进程内未接管」，恰好在两个方向上把判据拧反。
      notifyAge: penRaw.notifyAge === undefined ? status.pen.notifyAge : (Number(penRaw.notifyAge) || 0),
      gateOwned: penRaw.gateOwned === undefined ? -1 : (Number(penRaw.gateOwned) || 0),
      toolGate: penRaw.toolGate === undefined
          ? status.pen.toolGate
          : (Number(penRaw.toolGate) === 0 ? 0 : (Number(penRaw.toolGate) === 1 ? 1 : 2)),
      toolOk: Number(penRaw.toolOk) || 0,
      penDown: Number(penRaw.penDown) || 0,
      gateOk: Number(penRaw.gateOk) || 0,
      contactUnknown: Number(penRaw.contactUnknown) || 0,
      // P3.5 诊断字段。⚠️ 旧版守护进程不回它们 ⇒ 用 `=== undefined ? 旧值 : …`
      //    逐个回落，绝不能让 undefined/NaN 进 state（诊断文字会先被 NaN 污染，
      //    而那正是「诊断不可用」的复现路径）。
      //   ⛔ reason 的回落值是 **-1（对端不报原因）**，不是 0：0 的含义是
      //      「正在改写」，把「不认识」当成「正在改写」会让诊断条说假话。
      reason: penRaw.reason === undefined ? -1 : (Number(penRaw.reason) || 0),
      gateOpen: penRaw.gateOpen === undefined ? status.pen.gateOpen : (Number(penRaw.gateOpen) || 0),
      gateClose: penRaw.gateClose === undefined ? status.pen.gateClose : (Number(penRaw.gateClose) || 0),
      // ctOff 的 -1 是**合法值**（尚无信号）⇒ 不能用 `|| 0` 兜（会把 -1 洗成 0）。
      ctOff: penRaw.ctOff === undefined ? status.pen.ctOff : (Number.isFinite(Number(penRaw.ctOff)) ? Number(penRaw.ctOff) : status.pen.ctOff),
      ctVal: penRaw.ctVal === undefined ? status.pen.ctVal : (Number(penRaw.ctVal) || 0),
      // P3.6 落笔判据信号表（多信号并联）。同样逐个回落：旧版守护进程不回这三个字段，
      // 回落成 0 只表示「没有投票信号」，不会污染诊断文字（文案里有专门措辞）。
      ctElig: penRaw.ctElig === undefined ? status.pen.ctElig : (Number(penRaw.ctElig) || 0),
      ctHit: penRaw.ctHit === undefined ? status.pen.ctHit : (Number(penRaw.ctHit) || 0),
      ctOffs: penRaw.ctOffs === undefined ? status.pen.ctOffs : (Number(penRaw.ctOffs) || 0),
      pxNx: penRaw.pxNx === undefined ? status.pen.pxNx : (Number(penRaw.pxNx) || 0),
      pxNy: penRaw.pxNy === undefined ? status.pen.pxNy : (Number(penRaw.pxNy) || 0),
      pxPerAxis: Number(penRaw.pxPerAxis) || 0,
      // ⛔ Y 那一份**不能**用 `|| 0` 兜 NaN —— 负数是合法值（真机应是负的）。
      //    旧版守护进程不回该字段 ⇒ 保持原值（初值 0 = 未标定）。
      pxPerAxisY: (penRaw.pxPerAxisY === undefined || Number.isNaN(Number(penRaw.pxPerAxisY)))
          ? status.pen.pxPerAxisY
          : Number(penRaw.pxPerAxisY),
      injectedCount: Array.isArray(penRaw.injectedPids) ? penRaw.injectedPids.length : 0,
      state: Number(penRaw.state) || 0,
      packets: Number(penRaw.packets) || 0,
      smoothed: Number(penRaw.smoothed) || 0,
      // 旧版守护进程不回 snAge ⇒ Number(undefined)=NaN ⇒ 回落 -1（=「对端无此字段」）
      snAge: penRaw.snAge === undefined ? -1 : (Number(penRaw.snAge) || 0),
    } : status.pen,
  };
  emitStatus();
}
