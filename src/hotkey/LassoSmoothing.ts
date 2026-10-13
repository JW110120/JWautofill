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
export type SmoothToolGate = 0 | 1 | 2;   // 0=不是套索 1=是套索 2=未知（放行）

/** 参数面（与 Program.cs 的 PenHook.PenParams 一一对应；鼠标通路字段已移除）。 */
export interface LassoSmoothParams {
  /** 滤波族：标准（一阶低通）/ 拉绳 / 追笔。 */
  mode: LassoSmoothMode;
  /** 平滑强度 0–100（标准模式的主轴：越大越黏）。 */
  strength: number;
  /**
   * 最大滞后距离 px。**三种模式统一的硬上限，同时也是拉绳的绳长**。
   *  ⛔ 上限 100：与 PS 自家平滑一致，也与原生侧 RADIUS_PX_MAX 一致。
   *    旧的 40 会把强度调出来的滞后硬截断 ⇒ 「拉满也没感觉」。
   *  ⛔ 2026-10-13：原先还有一个「张力」滑杆，只在 15%~100% 之间缩放这个半径 ——
   *    两个参数改的是同一件事（圆周大小），用户实测后要求删除。现在一个参数一个语义。
   */
  radius: number;
  /** 追笔速度 0–100。 */
  catchUp: number;
  /** 拐角判定角度 0–90：夹角超过它即减弱平滑，保住尖角。 */
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
  /** 追笔速度 0–100。 */
  catchUp: number;
  /** 拐角判定角度 0–90。 */
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
    toolGate: 2,
    toolOk: 0,
    penDown: 0,
    gateOk: 0,
    contactUnknown: 0,
  pxPerAxis: 0,
  pxPerAxisY: 0,
  injectedCount: 0,
  state: 0,
  packets: 0,
  smoothed: 0,
};

const initialStatus: LassoSmoothStatus = {
  connected: false,
  unsupported: false,
  penUnsupported: false,
  pen: { ...initialPenSmoothStatus },
};

/** 供面板 state 初始化用（AppState.smoothStatus 的初值）。 */
export const initialLassoSmoothStatus: LassoSmoothStatus = { ...initialStatus };

const MODE_TO_WIRE: Record<LassoSmoothMode, number> = { standard: 0, rope: 1, catchup: 2 };

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
        strength: p.strength,
        radius: p.radius,
        catchUp: p.catchUp,
        cornerAngle: p.cornerAngle,
        speedAdaptive: p.speedAdaptive,
        // 拉绳提示的位域（bit0=弹性画笔带 bit1=绳长圆 bit2=笔尖点）
        hud: p.showLeash ? 7 : 0,
        // 工具闸门搭车同一条消息：与参数同源同节流，杜绝「界面显示套索、
        // 原生侧还按画笔处理」的错位窗口。
        toolGate,
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
 * 为什么必须有②：原生侧只认「新鲜」的闸门值（超过 3 秒未刷新就按「未知」放行，
 * 见 wintab_hook.c 的 GATE_STALE_MS）。若只在变化时发，那么「切到画笔」这个 0
 * 会一直留在共享内存里 —— 用户随后关掉面板、再用 PS 切回套索时，没有任何人
 * 会把那个 0 改回来 ⇒ 平滑与 HUD 静默失效，而且面板不在场时毫无线索。
 * 每 ~2 秒重刷一次，既让「0」保持有效（正在用画笔时不会被误放行），
 * 又能在面板消失后自然过期（不会把功能永久锁死）。
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
 */
export function setPenSmooth(on: boolean, p?: LassoSmoothParams): void {
  penOn = on;
  send({ type: 'penSmooth', on, ...(p ? toWire(p) : {}) });
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
    // 记住套索平滑的真实开关：后续每次调参都要同步推给它（sendParams 里的 penOn 判据）。
    // ⚠️ 对端不回 pen（旧版守护进程）时**不动** —— 不能把「不认识」当成「已关闭」，
    //    否则会把一个版本过旧的问题显示成开关关了。
    if (typeof penRaw.enabled === 'boolean') penOn = penRaw.enabled;
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
      toolGate: penRaw.toolGate === undefined
          ? status.pen.toolGate
          : (Number(penRaw.toolGate) === 0 ? 0 : (Number(penRaw.toolGate) === 1 ? 1 : 2)),
      toolOk: Number(penRaw.toolOk) || 0,
      penDown: Number(penRaw.penDown) || 0,
      gateOk: Number(penRaw.gateOk) || 0,
      contactUnknown: Number(penRaw.contactUnknown) || 0,
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
    } : status.pen,
  };
  emitStatus();
}
