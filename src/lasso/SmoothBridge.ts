/**
 * 套索实时平滑的 WebSocket 桥接（端口 18924）。
 *
 * ⚠️ 2026-10-14 架构变更（.8li 迁移，M2 已完成）：平滑的对端不再是外置守护进程
 *    （JWautofillSmoothDaemon.exe + 注入 WintabHook.dll 的旧链路已整体退役），
 *    而是 **Photoshop 进程内的合法插件** JWautofillHost.8li（装在 PS 的
 *    Plug-ins 目录，随 PS 启动自动加载）。它自带同一套 18924 WS 协议
 *    （plugin_main.c 是旧 Program.cs ROLE_SMOOTH 的逐字移植，协议零变化），
 *    因此本文件的连接/发送逻辑原样保留，面板无感。
 *
 *    旧链路残留（daemon exe、卸载脚本、拉起入口）已全部删除：
 *      · native/SmoothDaemon/（整个工程）、native/WintabHook/（注入 DLL）
 *      · launchSmoothDaemon / runSmoothUninstallScript / sendSmoothDaemonCommand
 *      · app.tsx 的 uninstallSmoothService 与菜单项「卸载套索平滑服务」
 *    平滑的启停现在只有一条语义：开关 = penSmooth(on/off)；.8li 常驻 PS 进程，
 *    没有"拉起服务"这一步，也没有可卸载的东西（更新 .8li = 关 PS 后覆盖文件）。
 *
 * ⚠️ 依赖方向：SmoothBridge（WebSocket 属主） → LassoSmoothing（纯状态机）。
 *    LassoSmoothing 依旧不持有 socket，发送器由本模块注入。不要反向 import。
 */

import {
  setLassoSmoothSender, setLassoSmoothConnected, resendLassoSmoothing, handleLassoSmoothMessage,
} from './LassoSmoothing';

/** 平滑 WS 端口（与 .8li 内 plugin_main.c 的监听端口一一对应）。 */
const SMOOTH_WS_URL = 'ws://127.0.0.1:18924';

let currentWs: any = null;
let connected = false;
const statusListeners: ((c: boolean) => void)[] = [];

/** 与 HotkeyBridge 同款的引用计数：两个面板（#app / #pixeladjustment）共用同一 JS 世界。 */
let connectCount = 0;
let closeFn: (() => void) | null = null;

function emitStatus(): void {
  for (const l of statusListeners) { try { l(connected); } catch { /* ignore */ } }
}

function resolveWs(): any {
  const W = (globalThis as any).WebSocket;
  return W || null;
}

// 把「往平滑模块发消息」的能力注入状态机。每次调用时读 currentWs，
// 因此连接重建后无需重新注入。
setLassoSmoothSender((msg: any) => {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) currentWs.send(JSON.stringify(msg));
  } catch { /* 连接已断：由 onclose 的重连与重放兜底 */ }
});

/** 订阅平滑模块的连接状态（首次立即回放当前值）。 */
export function onSmoothDaemonStatus(fn: (c: boolean) => void): () => void {
  statusListeners.push(fn);
  fn(connected);
  return () => { const i = statusListeners.indexOf(fn); if (i >= 0) statusListeners.splice(i, 1); };
}

export function isSmoothDaemonConnected(): boolean { return connected; }

/**
 * 连接平滑模块（幂等 + 引用计数）。
 * 由 APP 面板在挂载时调用一次；`#pixeladjustment` 面板若将来也需要，
 * 直接再调一次即可，不会建出第二条连接。
 * ⚠️ .8li 随 PS 启动即监听 18924；PS 刚启动的短暂窗口内会连不上，
 *    由下面的 1.5s 重试兜底，无需用户干预。
 */
export function connectSmoothDaemon(): () => void {
  connectCount++;
  if (closeFn) return makeUnsub();

  let closedByUs = false;
  let timer: any = null;

  const open = () => {
    const WS = resolveWs();
    if (!WS) { timer = setTimeout(open, 1500); return; }
    try {
      const ws = new WS(SMOOTH_WS_URL);
      currentWs = ws;
      ws.onopen = () => {
        connected = true; emitStatus();
        // ⚠️ 顺序很重要：先告诉状态机「连接建立了」（它会启动「对端是否支持平滑协议」的探测计时），
        //    再重放布防意图与参数。
        setLassoSmoothConnected(true);
        try { resendLassoSmoothing(); } catch { /* ignore */ }
      };
      ws.onmessage = (ev: any) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === 'smoothState') handleLassoSmoothMessage(msg);
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        connected = false; emitStatus();
        setLassoSmoothConnected(false);
        if (!closedByUs) timer = setTimeout(open, 1500);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    } catch {
      timer = setTimeout(open, 1500);
    }
  };
  open();

  closeFn = () => {
    closedByUs = true;
    if (timer) clearTimeout(timer);
    try { currentWs?.close(); } catch { /* ignore */ }
  };
  return makeUnsub();

  function makeUnsub(): () => void {
    return () => {
      connectCount--;
      if (connectCount <= 0) {
        connectCount = 0;
        closeFn?.();
        closeFn = null;
      }
    };
  }
}

/**
 * 关闭平滑（面板「服务」开关拨到关时发 `shutdown`）。
 *
 * ⚠️ .8li 收到 shutdown 只做一件事：commit(0) 关掉平滑改写，**服务常驻不解散**
 *    （它不能退出 Photoshop 宿主进程，见 plugin_main.c 的 shutdown 分支）。
 *    因此 WS 连接仍然保持，开关再拨开时 penSmooth(true) 直接生效。
 */
export function disconnectSmoothDaemon(): boolean {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'shutdown' }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 套索平滑（Wintab 笔输入层）的开关 + 参数。
 *
 * ⚠️ 实现在 .8li 进程内插件里（smooth_engine.c 在 `WTPacketsGet` 上改写包坐标，
 *    即旧 wintab_hook.c 的合并镜像），参数经命名共享内存由 WS 层下发。
 *
 * ⛔ 必须**整包带参数**：早期版本只发 `{on}`，强度恒为默认 40、
 *    半径/模式/追笔/拐角连字段都没有 ⇒ 面板调参对笔平滑毫无作用
 *    （真机复现：「已平滑 47417 包但感知不明显」）。
 *
 * 真实生效状态不靠这里乐观更新：.8li 收到后会回一帧 `smoothState`（含 `pen`），
 * 面板按**它**刷新开关与状态条 —— 避免「点了亮起来其实没生效」。
 */
export function sendPenSmooth(on: boolean, params?: {
  mode?: number; strength?: number; radius?: number;
  catchUp?: number; cornerAngle?: number; speedAdaptive?: boolean;
  hud?: number; hudColor?: number;
}): boolean {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      const msg: any = { type: 'penSmooth', on };
      if (params) {
        if (typeof params.mode === 'number') msg.mode = params.mode;
        if (typeof params.strength === 'number') msg.strength = params.strength;
        if (typeof params.radius === 'number') msg.radius = params.radius;
        if (typeof params.catchUp === 'number') msg.catchUp = params.catchUp;
        if (typeof params.cornerAngle === 'number') msg.cornerAngle = params.cornerAngle;
        if (typeof params.speedAdaptive === 'boolean') msg.speedAdaptive = params.speedAdaptive;
        if (typeof params.hud === 'number') msg.hud = params.hud;
        if (typeof params.hudColor === 'number') msg.hudColor = params.hudColor;
      }
      currentWs.send(JSON.stringify(msg));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}
