/**
 * 套索实时平滑的**独立**守护进程桥接。
 *
 * 为什么要有这个文件（而不是继续挂在 HotkeyBridge 上）：
 * 平滑与热键过去共用同一个守护进程，于是「停止 / 卸载快捷键服务」一执行，
 * 平滑的 WebSocket 也随之断开 —— 面板立刻显示「未连接快捷键服务」。
 * 拆成两个进程后，这里独占 **18924** 端口那条连接，生命周期与热键完全无关：
 * 停掉/卸载热键服务不会碰到它，反之亦然。
 *
 * ⚠️ 依赖方向：SmoothBridge（WebSocket 属主） → LassoSmoothing（纯状态机）。
 *    LassoSmoothing 依旧不持有 socket，发送器由本模块注入。不要反向 import。
 */

import { storage, shell } from 'uxp';
import {
  setLassoSmoothSender, setLassoSmoothConnected, resendLassoSmoothing, handleLassoSmoothMessage,
} from './LassoSmoothing';

/** 平滑守护进程的端口（与 Program.cs 的 ROLE_SMOOTH 角色常量一一对应）。 */
const SMOOTH_WS_URL = 'ws://127.0.0.1:18924';

/**
 * 插件包内平滑守护进程的相对路径。
 * ⚠️ 与热键守护进程**不同目录**：两者是独立产物（同源码 + 编译期角色开关）。
 */
const SMOOTH_EXE_REL = 'native/SmoothDaemon/publish/JWautofillSmoothDaemon.exe';

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

// 把「往平滑守护进程发消息」的能力注入状态机。每次调用时读 currentWs，
// 因此连接重建后无需重新注入。
setLassoSmoothSender((msg: any) => {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) currentWs.send(JSON.stringify(msg));
  } catch { /* 连接已断：由 onclose 的重连与重放兜底 */ }
});

/** 订阅平滑守护进程的连接状态（首次立即回放当前值）。 */
export function onSmoothDaemonStatus(fn: (c: boolean) => void): () => void {
  statusListeners.push(fn);
  fn(connected);
  return () => { const i = statusListeners.indexOf(fn); if (i >= 0) statusListeners.splice(i, 1); };
}

export function isSmoothDaemonConnected(): boolean { return connected; }

/**
 * 连接平滑守护进程（幂等 + 引用计数）。
 * 由 APP 面板在挂载时调用一次；`#pixeladjustment` 面板若将来也需要，
 * 直接再调一次即可，不会建出第二条连接。
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

/** 让平滑守护进程优雅退出（面板「服务」开关关闭时用）。 */
export function disconnectSmoothDaemon(): boolean {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'shutdown' }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** 发一条需要守护进程自己完成清理的指令（如 `uninstall`）。 */
export function sendSmoothDaemonCommand(type: string): boolean {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 套索平滑（Wintab 笔输入层）的开关 + 参数。
 *
 * ⚠️ 实现在被注入 Photoshop 的 hook DLL 内（`WTPacketsGet` detour 改写包坐标），
 *     参数经命名共享内存由守护进程下发 —— 面板与 DLL 之间不直接通信。
 *
 * ⛔ 必须**整包带参数**：早期版本只发 `{on}`，守护进程侧的强度恒为默认 40、
 *     半径/模式/张力/追笔/拐角连字段都没有 ⇒ 面板调参对笔平滑毫无作用
 *     （真机复现：「已平滑 47417 包但感知不明显」）。
 *
 * 真实生效状态不靠这里乐观更新：守护进程收到后会回一帧 `smoothState`（含 `pen`），
 * 面板按**它**刷新开关与状态条 —— 避免「点了亮起来其实没生效」。
 */
export function sendPenSmooth(on: boolean, params?: {
  mode?: number; strength?: number; radius?: number; tension?: number;
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
        if (typeof params.tension === 'number') msg.tension = params.tension;
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

/**
 * 解析插件目录内的相对路径为真实 OS 路径。
 * 与 BrushHotkeySection 里的同名工具逻辑一致（用插件根目录拼接，绕开沙箱下
 * `getEntry('native')` 找不到目录的问题）。
 */
async function resolvePluginPath(relPath: string): Promise<string | null> {
  try {
    const folder: any = await storage.localFileSystem.getPluginFolder();
    const root: string = folder?.nativePath;
    if (!root) return null;
    const sep = root.includes('\\') ? '\\' : '/';
    const parts = relPath.split('/').filter(Boolean);
    return [root, ...parts].join(sep);
  } catch { return null; }
}

/**
 * 拉起平滑守护进程。
 *
 * 守护进程自身会「拷贝到安装目录 + 注册开机自启 + 从安装目录重新拉起」，
 * 因此这里只需把插件目录里的副本点一下即可（已编译为 GUI 子系统，全程无窗口）。
 */
export async function launchSmoothDaemon(): Promise<{ ok: boolean; message: string }> {
  if (connected) return { ok: true, message: '平滑服务已在运行' };
  const full = await resolvePluginPath(SMOOTH_EXE_REL);
  if (!full) {
    return { ok: false, message: '无法定位插件目录，请手动双击插件目录 ' + SMOOTH_EXE_REL };
  }
  try {
    const r: any = await shell.openPath(full);
    if (typeof r === 'string' && r.length > 0) {
      return { ok: false, message: '唤起失败：' + r + '（可手动双击 ' + SMOOTH_EXE_REL + '）' };
    }
    return { ok: true, message: '正在启动平滑服务…' };
  } catch (e: any) {
    return { ok: false, message: '启动平滑服务失败：' + (e?.message || String(e)) };
  }
}

/** 卸载平滑守护进程（移除开机自启 + 删除它自己的安装目录），与热键服务互不影响。 */
export function uninstallSmoothDaemon(): boolean {
  return sendSmoothDaemonCommand('uninstall');
}
