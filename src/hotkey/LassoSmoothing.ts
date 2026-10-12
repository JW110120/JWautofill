/**
 * 套索实时平滑（方案 A：输入层滤波）的 UXP 侧桥接。
 *
 * 背景（为什么必须走原生）：UXP 插件没有任何画布指针 API，
 * `document.addEventListener('mousemove')` 监听的是**插件面板自身 DOM**，
 * 与 PS 画布无关。也就是说「套索绘制过程中」这段时间对 UXP 是完全盲区 ——
 * 唯一能介入的位置在 **PS 收到鼠标输入之前**，只能由原生守护进程
 * （native/HotkeyDaemon，低层鼠标钩子 + 回注）承担。
 *
 * 因此本模块的职责刻意很窄，只做三件事：
 *   ① 把「是否布防 + 参数」下发给守护进程（smoothArm / smoothParams）；
 *   ② 接收守护进程回传的健康状态（smoothState），供面板显示与排障；
 *   ③ 连接（重）建立时把当前意图重放一次，避免「daemon 重启后平滑无声失效」。
 *
 * ⚠️ 本模块**不持有** WebSocket：发送器由 SmoothBridge 注入（它是 **18924** 那条
 *    连接的唯一属主）。2026-10-12 起平滑已拆成独立守护进程，连接不再挂在 HotkeyBridge 上
 *    —— 否则「停止快捷键服务」会连带把平滑的连接一起断掉。
 *    这样依赖方向仍是单向的（SmoothBridge → LassoSmoothing），不会形成循环 import。
 */

export type LassoSmoothMode = 'standard' | 'rope' | 'catchup';

/** 参数面（与 Program.cs 的 LassoSmoothSettings 一一对应）。 */
export interface LassoSmoothParams {
  /** 滤波族：标准（一阶低通）/ 拉绳 / 追笔。 */
  mode: LassoSmoothMode;
  /** 平滑强度 0–100（标准模式的主轴：越大越黏）。 */
  strength: number;
  /** 最大滞后距离 px（三种模式统一收口的硬上限，同时是拉绳的绳长基准）。 */
  radius: number;
  /** 拉绳松紧 0–100。 */
  tension: number;
  /** 追笔速度 0–100。 */
  catchUp: number;
  /** 拐角判定角度 0–90：夹角超过它即减弱平滑，保住尖角。 */
  cornerAngle: number;
  /** 甩笔时自动减弱平滑（减少快速拖拽的滞后）。 */
  speedAdaptive: boolean;
  /** 最小注入间距 px（抽稀）。 */
  minSampleDist: number;
}

/**
 * 默认值。
 * ⚠️ 总开关默认**关闭**：平滑会改变所有存量用户的套索手感，
 *    必须由用户主动开启，不能默认接管。
 */
export const initialLassoSmoothParams: LassoSmoothParams = {
  mode: 'standard',
  strength: 40,
  radius: 8,
  tension: 50,
  catchUp: 50,
  cornerAngle: 45,
  speedAdaptive: true,
  minSampleDist: 1,
};

/** 守护进程回传的健康状态（用于面板显示与排障）。 */
export interface LassoSmoothStatus {
  /** 与守护进程的连接是否建立。 */
  connected: boolean;
  /**
   * 连上的守护进程**不支持**套索平滑协议（旧版本）。
   *
   * ⛔ 为什么必须有这个判据：旧版守护进程收到未知的 `smoothArm` 会**静默忽略**，
   *    本模块因此永远收不到 `smoothState`，`hookInstalled` 恒为 false ⇒ 面板会把
   *    一个「版本过旧」问题显示成「启动失败（被安全软件拦截）」，
   *    把用户的排查方向完全带偏（真机已复现：安装目录里跑的是 9 月的旧 exe）。
   *    现在的判据是「建连后发起 smoothStatus 询问，超时窗口内一帧都没回来」。
   */
  unsupported: boolean;
  /** 守护进程侧是否已布防。 */
  armed: boolean;
  /** 守护进程是否正处于一次被接管的拖拽中。 */
  dragging: boolean;
  /** 低层鼠标钩子是否已安装（armed 为真但此项为假 ⇒ 钩子被安全软件拦截或安装失败）。 */
  hookInstalled: boolean;
  /** 回调用时超预算已熔断（此后只放行、不平滑；键盘热键不受影响）。 */
  safeMode: boolean;
  /** 累计钩子回调次数（不增长 ⇒ 钩子已被系统静默摘除）。 */
  callbacks: number;
  /** 累计注入次数。 */
  injected: number;
  /** 最近一次拖拽的原始点数 / 注入点数（「吞了却没注入」这类异常最直接的判据）。 */
  lastDragRaw: number;
  lastDragInjected: number;
  /**
   * 连上的守护进程**不认识笔平滑**（旧版本）。
   *
   * ⛔ 与 `unsupported` 是**两层**判据，不能合并：套索平滑的探针（有没有回 `smoothState`）
   *    对旧版守护进程是**通过**的 —— 它支持套索平滑、会正常回帧，只是帧里没有 `pen`。
   *    若只看 `unsupported`，笔平滑开关会显示成**可点**，点下去 `penSmooth` 被静默丢弃、
   *    开关弹回 ⇒ 又是一个「点了没反应」。判据因此下沉一层：**回帧里有没有出现过 `pen`**。
   */
  penUnsupported: boolean;
  /** 笔输入层平滑（Wintab 通路）的状态；旧版守护进程不回该字段 ⇒ 落到默认值。 */
  pen: PenSmoothStatus;
}

/**
 * 笔输入层平滑（Wintab 通路）的状态。
 *
 * ⚠️ 与上面的鼠标通路**完全独立**：那条改的是**光标**（`WH_MOUSE_LL` + 回注），
 *    这条改的是 **PS 进程内的包坐标** —— 守护进程把 hook DLL 注入 PS，DLL 在
 *    `Wintab32!WTPacketsGet` 的 detour 里就地改写 X/Y。
 *    数位板在 PS 里走 Wintab 时笔**不产生** `WM_MOUSEMOVE`，鼠标钩子够不着，所以必须两条路。
 *
 * 旧版守护进程不回 `pen` ⇒ 保持原值（默认 enabled=false），不会把「不认识」显示成「已开」。
 */
export interface PenSmoothStatus {
  enabled: boolean;
  /** 平滑强度 0–100。 */
  strength: number;
  /** 已注入 hook DLL 的 PS 进程数（0 ⇒ 还没注入成功或 PS 未运行）。 */
  injectedCount: number;
  /** hook 侧状态：0=未挂载 1=生效 2=标定失败 3=已卸载。 */
  state: number;
  /** 累计取到的包数 / 被改写的包数（生效与否最直接的证据）。 */
  packets: number;
  smoothed: number;
}

/** 笔平滑状态的初值（也是「对端不回该字段」时的兜底值）。 */
export const initialPenSmoothStatus: PenSmoothStatus = {
  enabled: false,
  strength: 40,
  injectedCount: 0,
  state: 0,
  packets: 0,
  smoothed: 0,
};

const initialStatus: LassoSmoothStatus = {
  connected: false,
  unsupported: false,
  armed: false,
  dragging: false,
  hookInstalled: false,
  safeMode: false,
  callbacks: 0,
  injected: 0,
  lastDragRaw: 0,
  lastDragInjected: 0,
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
/** 最近一次「布防意图」。重连时据此重放，避免 daemon 重启后静默失效。 */
let armedIntent = false;
let params: LassoSmoothParams = { ...initialLassoSmoothParams };
let status: LassoSmoothStatus = { ...initialStatus };

let pendingParams: LassoSmoothParams | null = null;
let paramTimer: any = null;
/** 能力探测：本轮连接是否至少收到过一帧 smoothState。 */
let sawSmoothState = false;
/** 能力探测（第二层）：本轮连接是否至少有一帧带 `pen` 字段 ⇒ 对端认识笔平滑。 */
let sawPenFrame = false;
let probeTimer: any = null;
/**
 * 上一次真正发出去的参数线格式签名。
 * ⚠️ 必须有它：本模块的一个调用方是 **300ms 工具巡检**（幂等地重算布防意图时顺带同步参数），
 *    没有这层去重就会每 300ms 打一条 WS 消息。
 */
let lastSentParamsSig: string | null = null;

const statusListeners: ((s: LassoSmoothStatus) => void)[] = [];

function send(msg: any): void {
  if (!sender) return;
  try { sender(msg); } catch { /* 发送失败由 HotkeyBridge 的重连机制兜底 */ }
}

function toWire(p: LassoSmoothParams) {
  return {
    mode: MODE_TO_WIRE[p.mode] ?? 0,
    strength: p.strength,
    radius: p.radius,
    tension: p.tension,
    catchUp: p.catchUp,
    cornerAngle: p.cornerAngle,
    speedAdaptive: p.speedAdaptive,
    minSampleDist: p.minSampleDist,
  };
}

/** 发送参数（线格式未变化则跳过）。 */
function sendParams(p: LassoSmoothParams): void {
  const wire = toWire(p);
  const sig = JSON.stringify(wire);
  if (sig === lastSentParamsSig) return;
  lastSentParamsSig = sig;
  send({ type: 'smoothParams', params: wire });
}

function emitStatus(): void {
  for (const l of statusListeners) { try { l(status); } catch { /* ignore */ } }
}

/** 由 HotkeyBridge 在模块初始化时注入（它是 WebSocket 的唯一属主）。 */
export function setLassoSmoothSender(fn: (msg: any) => void): void {
  sender = fn;
}

/** 连接状态变化（HotkeyBridge 的 onopen / onclose 调用）。 */
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
          // 对端支持套索平滑但不认识笔平滑（版本过旧）⇒ 单独标记，别让笔开关看起来可点。
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
 * 布防 / 撤防。
 * 幂等：意图未变化且无需重发参数时直接返回（避免 300ms 工具巡检每轮都打一次 WS）。
 */
export function armLassoSmoothing(on: boolean, p?: LassoSmoothParams): void {
  if (p) pushLassoSmoothParams(p);
  if (on === armedIntent) return;
  armedIntent = on;
  send({ type: 'smoothArm', on });
}

/** 卸载 / 长时离开时的强制撤防。 */
export function disarmLassoSmoothing(): void {
  armedIntent = false;
  send({ type: 'smoothArm', on: false });
}

/**
 * 重放当前意图（由 HotkeyBridge 在每次 WebSocket 建连后调用）。
 *
 * 为什么必须重放：守护进程是独立进程，插件重载或 daemon 重启都会让
 * 「面板以为已布防、daemon 其实没有」—— 表现为平滑无声失效。
 * 这里无条件下发一次 arm（含 on=false，顺带清掉上一会话可能残留的布防）+ 一次状态查询。
 */
export function resendLassoSmoothing(): void {
  // 新的一轮连接：能力探测重新开始（对端可能刚从旧版更新过）
  sawSmoothState = false;
  sawPenFrame = false;
  // 刚建连：先无条件把参数推一遍（对端可能是刚启动的新进程，它那边的参数缓存是空的），
  // 因此这里刻意清掉签名去重。
  lastSentParamsSig = null;
  sendParams(params);
  send({ type: 'smoothArm', on: armedIntent });
  // 主动询问一次状态：这是「对端支不支持本协议」的探针 —— 支持则必回一帧 smoothState，
  // 不支持（旧版守护进程把未知 type 静默丢弃）则什么都不回，由 PROBE_TIMEOUT_MS 判定。
  send({ type: 'smoothStatus' });
}

/** 处理守护进程回传的 smoothState（由 HotkeyBridge 的 onmessage 分发）。 */
export function handleLassoSmoothMessage(msg: any): void {
  if (!msg) return;
  // 收到任何一帧即可判定对端支持本协议（即便此刻字段还是布防前的初始值）。
  sawSmoothState = true;
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  const penRaw = msg.pen;
  if (penRaw) sawPenFrame = true;
  status = {
    ...status,
    connected: true,
    unsupported: false,
    // 只要有一帧带 pen 就说明对端认识笔平滑（无论此刻开没开）。
    penUnsupported: penRaw ? false : status.penUnsupported,
    armed: !!msg.armed,
    dragging: !!msg.dragging,
    hookInstalled: !!msg.hookInstalled,
    safeMode: !!msg.safeMode,
    callbacks: Number(msg.callbacks) || 0,
    injected: Number(msg.injected) || 0,
    lastDragRaw: Number(msg.lastDragRaw) || 0,
    lastDragInjected: Number(msg.lastDragInjected) || 0,
    // ⚠️ 对端不回 pen（旧版守护进程）时保持原值 —— 不能把「不认识」当成「已关闭」后
    //    又把开关显示成可点，那会造出「点了没反应」。
    pen: penRaw ? {
      enabled: !!penRaw.enabled,
      strength: Number(penRaw.strength) || 0,
      injectedCount: Array.isArray(penRaw.injectedPids) ? penRaw.injectedPids.length : 0,
      state: Number(penRaw.state) || 0,
      packets: Number(penRaw.packets) || 0,
      smoothed: Number(penRaw.smoothed) || 0,
    } : status.pen,
  };
  emitStatus();
}
