// 热键桥接：UXP 侧与本地守护进程通信 + 直接切笔刷
// 设计要点（关键）：
// - UXP 沙箱没有 Node 的 fs/os/process，配置“不由插件读写文件”，统一由守护进程持有。
// - 插件只通过 WebSocket 向守护进程拉取/推送配置（getConfig / config），避免跨进程文件系统耦合。
// - 守护进程全局捕获按键后广播 hotkey 事件，插件执行「总开关切换 / 直接 select 笔刷」。

import { action, app } from 'photoshop';
import { shell, storage } from 'uxp';
import { MainToggleState, requestMainToggle } from '../utils/MainToggleBus';
import { requestFillPanelToggle } from '../utils/FillPanelToggleBus';
import { psRead, runAsModal } from '../utils/psAccess';

export interface HotkeyEntry {
  id: string;
  combo: string;                 // 例如 "Ctrl+Shift+R"、"Alt+F1"
  action: 'toggleMain' | 'applyBrush' | 'runFunc';
  brush?: string;                // applyBrush 时的笔刷名（PS 预设名，需精确匹配）。
                                  // 注意：不支持同名笔刷——PS 按 _name 只会选中 Brushes 列表最上方那支。
                                  // runFunc 时复用本字段承载功能 id（见 funcHotkeyDefs.ts），
                                  // 守护进程对该字段不解释、只透传，因此无需改守护进程。
}

const WS_URL = 'ws://127.0.0.1:18923';

// ===== 主开关（选区填充面板的总开关）快捷键 =====
// 默认绑定 Ctrl+Q。该条目在配置里「长期存在」：
// - combo 为 '' 表示用户已解绑（此时不再自动补回默认值，尊重用户选择）；
// - 配置里完全找不到该条目 = 首次使用，写入默认 Ctrl+Q 并推送。
// 这样做的好处是「解绑」状态能随配置持久化，插件重载后不会又把 Ctrl+Q 塞回来。
export const MAIN_TOGGLE_ID = 'main_toggle';
export const DEFAULT_MAIN_TOGGLE_COMBO = 'Ctrl+Q';
let mainToggleCombo: string | null = null; // null = 尚未从配置里读到过

type ConfigListener = (entries: HotkeyEntry[]) => void;

// 配置文件统一放在 PS 的 PluginData 目录（与密钥、图案等持久化数据同一个位置），
// 路径由本模块解析后告知守护进程，用户不再需要去 %LOCALAPPDATA% 里翻找。
const CONFIG_FILE_NAME = 'hotkeys.json';
let resolvedConfigPath = '';
let configPathPromise: Promise<string> | null = null;

async function resolveConfigPath(): Promise<string> {
  if (resolvedConfigPath) return resolvedConfigPath;
  if (configPathPromise) return configPathPromise;
  configPathPromise = (async () => {
    try {
      const folder: any = await storage.localFileSystem.getDataFolder();
      const p: string = folder?.nativePath || '';
      if (p) {
        const sep = p.indexOf('\\') >= 0 ? '\\' : '/';
        resolvedConfigPath = p + sep + CONFIG_FILE_NAME;
      }
    } catch (e) {
      console.warn('⚠️ 解析插件数据目录失败，守护进程将回落到默认配置路径:', e);
    }
    return resolvedConfigPath;
  })();
  return configPathPromise;
}

let cachedConfig: HotkeyEntry[] = [];
const configListeners: ConfigListener[] = [];
let currentWs: any = null;
let connected = false;
// 当前挂起的录制请求（守护进程回传 recordResult/recordCancel 时兑现）
let pendingRecord: ((r: { combo: string } | null) => void) | null = null;
// 录制进度监听（两段式录制第一阶段）：守护进程捕获到组合键后广播 recordCaptured，
// 面板据此把该行显示为「已捕获 XXX，待确认」。录制的确认/取消仍由 recordResult/recordCancel 兑现。
const recordProgressListeners: ((combo: string) => void)[] = [];
const statusListeners: ((c: boolean) => void)[] = [];
// 热键触发监听（供面板显示触发反馈，也便于用户确认事件链路是否打通）
// enabled 仅对 toggleMain 有效，取自共享总线翻转后的真实状态——
// 提示文字必须说真话：以前无条件显示「已切换」，实际上什么都没切换。
const hotkeyListeners: ((info: { combo: string; action: string; brush?: string; ok: boolean; enabled?: boolean }) => void)[] = [];

function emitStatus() {
  for (const l of statusListeners) { try { l(connected); } catch { /* ignore */ } }
}

// 订阅守护进程连接状态
export function onDaemonStatus(fn: (c: boolean) => void): () => void {
  statusListeners.push(fn);
  fn(connected);
  return () => { const i = statusListeners.indexOf(fn); if (i >= 0) statusListeners.splice(i, 1); };
}

// 从插件拉起守护进程（UXP shell.openPath 可直接启动本地 exe）。
// 注意：对 .ps1/.bat 等脚本，openPath 会用编辑器打开而非执行，调用方应先校验扩展名。
export function launchDaemon(exePath: string): boolean {
  const p = (exePath || '').trim().toLowerCase();
  if (!p) return false;
  if (p.endsWith('.ps1') || p.endsWith('.bat') || p.endsWith('.cmd')) {
    console.warn('⚠️ 启动路径不是 exe，请改用安装器或手动运行 exe');
    return false;
  }
  try {
    shell.openPath(exePath);
    return true;
  } catch (e) {
    console.error('⚠️ 启动守护进程失败:', e);
    return false;
  }
}

// 让守护进程优雅退出（面板「断开守护进程」用）。
// 直接杀死进程在 UXP 里做不到，而卸载脚本又要求进程先停掉才能删安装目录，
// 所以由守护进程自己退出是最干净的做法。
export function disconnectDaemon(): boolean {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'shutdown' }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// 通过 WebSocket 向守护进程发送一条指令（如 "uninstall"）。
// 用于「卸载」等需要进程自身完成清理并退出的动作，全程无窗口。
export function sendDaemonCommand(type: string): boolean {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ⚠️ 历史坑（2026-08-30）：这里曾经是「注册一个面板内回调，热键到达时直接调用」。
// 但 UXP 的每个面板都是独立 JS 上下文，本模块在每个面板里都有一份实例：
// App 面板注册的那份回调，绘画工具箱面板根本看不见。于是热键在绘画工具箱面板里被收到，
// 回调是 null → 什么都不做 → 主面板开关纹丝不动（而提示文字照常显示，极具迷惑性）。
// 现在改走 MainToggleBus：热键只负责翻转「共享状态」，由 App 面板订阅并应用。
// 保留此导出仅为兼容旧调用，已不再参与任何逻辑。
export function registerMainToggleHandler(_fn: () => void) {
  console.warn('⚠️ registerMainToggleHandler 已废弃：主开关现由 MainToggleBus 跨面板同步');
}

// 卸载动作由面板右上角的菜单触发，但真正的实现（含状态提示）在 BrushHotkeySection 里，
// 这里做一个简单的注册/转发，避免把面板内部状态暴露给菜单层。
let uninstallHandler: (() => Promise<string>) | null = null;
export function registerUninstallHandler(fn: () => Promise<string>) {
  uninstallHandler = fn;
}
export async function requestUninstall(): Promise<string> {
  if (!uninstallHandler) return '卸载功能尚未就绪（请展开「笔刷热键」分区后重试）';
  try { return await uninstallHandler(); }
  catch (e: any) { return '卸载失败：' + (e?.message || String(e)); }
}

// 「键盘卡死一键修复」：同样由面板右上角菜单触发，实现留在 BrushHotkeySection。
// 存在的意义：一旦系统的全局键盘钩子把输入拖死，用户连字都打不出来，
// 唯一还能操作的就是鼠标——此时从菜单点一下即可自救，且脚本全程不需要任何键盘输入。
let repairKeyboardHandler: (() => Promise<string>) | null = null;
export function registerRepairKeyboardHandler(fn: () => Promise<string>) {
  repairKeyboardHandler = fn;
}
export async function requestRepairKeyboard(): Promise<string> {
  // ⚠️ 兜底（2026-09-06）：「笔刷热键」分区折叠时组件未挂载 → 没有任何实现注册进来，
  // 旧版只会返回一句提示然后被吞掉（dialogs.alert 在 PS 里不显示）→ 用户点了毫无反应。
  // 键盘卡死是自救场景，任何时候都必须可用：这里直接唤起内置修复脚本（会弹出 CMD 窗口显示结果）。
  if (!repairKeyboardHandler) {
    try {
      const folder: any = await storage.localFileSystem.getPluginFolder();
      const root: string = folder?.nativePath;
      if (root) {
        const sep = root.includes('\\') ? '\\' : '/';
        // ⚠️ 必须唤起 .exe 而非 .bat：UXP 的 shell.openPath 对 .bat/.ps1 只会「用编辑器打开而非执行」，
        // 对 .exe 才会真正运行并弹出可见控制台窗口（守护进程 JWautofillHotkeyDaemon.exe 即此方式启动）。
        const full = root + sep + 'native' + sep + 'HotkeyDaemon' + sep + 'FixKeyboard.exe';
        const r: any = await shell.openPath(full);
        if (typeof r === 'string' && r.length > 0) {
          // 兜底：直接唤起失败时打开脚本所在目录（manifest launchProcess.extensions 含 ""），
          // 用户鼠标双击 FixKeyboard.exe 即可——键盘卡死场景只有鼠标可用，不能让用户自己找路径。
          try { await shell.openPath(root + sep + 'native' + sep + 'HotkeyDaemon'); } catch { }
          return '唤起键盘修复工具失败：' + r + '。已打开工具所在目录，请双击 FixKeyboard.exe。';
        }
        return '已打开键盘修复窗口（CMD），请按窗口内提示查看结果；修复完成后请立即测试键盘。';
      }
    } catch (e: any) {
      return '键盘修复失败：' + (e?.message || String(e));
    }
    return '键盘修复功能尚未就绪（请展开「笔刷热键」分区后重试）';
  }
  try { return await repairKeyboardHandler(); }
  catch (e: any) { return '键盘修复失败：' + (e?.message || String(e)); }
}

// 订阅热键触发事件（无论成败都会回调，ok=false 表示执行 batchPlay 失败）
export function onHotkeyTriggered(fn: (info: { combo: string; action: string; brush?: string; ok: boolean; enabled?: boolean }) => void): () => void {
  hotkeyListeners.push(fn);
  return () => { const i = hotkeyListeners.indexOf(fn); if (i >= 0) hotkeyListeners.splice(i, 1); };
}

// 守护进程回传的配置条目字段归一化：
// 旧版守护进程落盘为 PascalCase（Combo/Action/Brush），UXP 端统一用小写驼峰读取。
// 这里做双向兜底，避免版本错位时列表显示成 undefined / 快捷键不匹配。
function normalizeEntry(e: any): HotkeyEntry | null {
  if (!e || typeof e !== 'object') return null;
  const combo: string = e.combo ?? e.Combo ?? '';
  const action = (e.action ?? e.Action ?? '') as HotkeyEntry['action'];
  const brush: string | undefined = e.brush ?? e.Brush ?? undefined;
  const id: string = e.id ?? e.Id ?? ('bk_' + Math.random().toString(36).slice(2));
  if (action !== 'toggleMain' && action !== 'applyBrush' && action !== 'runFunc') return null;
  // combo 为空的合法条目：主开关（'' = 已解绑）、笔刷（'' = 已解绑但条目保留在列表，
  // 单击选中后按退格即解绑，与「删除」按钮区分）。runFunc 空组合键无意义，直接丢弃。
  if (!combo && action !== 'toggleMain' && action !== 'applyBrush') return null;
  // runFunc 必须携带功能 id（复用 brush 字段），缺了就无法执行，丢弃。
  if (action === 'runFunc' && !brush) return null;
  return { id, combo, action, brush };
}

function emitConfig() {
  for (const l of configListeners) {
    try { l(cachedConfig); } catch { /* ignore */ }
  }
}

// 订阅配置变化（首次立即回放当前缓存）
export function onConfig(fn: ConfigListener): () => void {
  configListeners.push(fn);
  if (cachedConfig.length) fn(cachedConfig);
  return () => {
    const i = configListeners.indexOf(fn);
    if (i >= 0) configListeners.splice(i, 1);
  };
}

// UXP 运行环境自带全局 WebSocket（Adobe UXP 标准 API），无需任何 npm 依赖。
// 之前这里还有一行 Node 版的 `require('ws')` 作为回退，会被 webpack 在构建期静态分析并试图打包，
// 从而报 “Can't resolve 'ws'”。UXP 里 globalThis.WebSocket 必定存在，删掉该回退即可消除警告。
function resolveWs(): any {
  const W = (globalThis as any).WebSocket;
  return W || null;
}

// ===== 连接守护进程 =====
// ⚠️ 幂等 + 引用计数（关键修复）：
// UXP 的 #app 与 #pixeladjustment 两个面板共用同一个 bundle.js / 同一个 JS 世界，
// 它们各自在挂载时都会调用本函数。若不防重，就会建出「两条 WebSocket」。
// 守护进程是向所有已连接客户端广播的，于是同一条 toggleMain 热键会被投递两份；
// 两份 handleHotkey 各自执行一次「读-改-写」翻转，因 await 让出线程而读到同一个旧值，
// 结果被翻转两次、互相抵消，表现正是用户看到的「按下有文字提示、主面板开关纹丝不动」。
// 因此同一上下文只允许一条连接：第二次调用直接复用，退订时按引用计数关闭。
let daemonConnectCount = 0;
let daemonCloseFn: (() => void) | null = null;

export function connectHotkeyDaemon(): () => void {
  daemonConnectCount++;
  // 已有连接：直接返回带引用计数的退订器，不再重复建连
  if (daemonCloseFn) return makeDaemonUnsub();

  let closedByUs = false;
  let timer: any = null;

  const open = () => {
    const WS = resolveWs();
    if (!WS) { timer = setTimeout(open, 1500); return; }
    try {
      const ws = new WS(WS_URL);
      currentWs = ws;
      ws.onopen = () => {
        connected = true; emitStatus();
        // 先告知配置文件的统一存放位置（PS PluginData），再拉配置，
        // 保证守护进程读写的就是面板展示的那一份。
        void (async () => {
          try {
            const cp = await resolveConfigPath();
            if (cp) ws.send(JSON.stringify({ type: 'setConfigPath', path: cp }));
          } catch { /* ignore */ }
          try { ws.send(JSON.stringify({ type: 'getConfig' })); } catch { /* ignore */ }
          // 重连后同步布防状态：守护进程在客户端断开时会撤防，
          // 若本上下文仍持有布防权（选中未变），这里重发一次 armDelete。
          if (armedDeleteOwner) {
            try { ws.send(JSON.stringify({ type: 'armDelete', owner: armedDeleteOwner })); } catch { /* ignore */ }
          }
        })();
      };
      ws.onmessage = (ev: any) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === 'hotkey') handleHotkey(msg);
          else if (msg?.type === 'config') {
            const raw: any[] = Array.isArray(msg.payload) ? msg.payload : [];
            cachedConfig = raw.map(normalizeEntry).filter((x): x is HotkeyEntry => !!x);
            // 首次使用时补上主开关的默认快捷键 Ctrl+Q
            ensureMainToggleEntry();
            emitConfig();
          }
          else if (msg?.type === 'recordCaptured') {
            const captured: string = typeof msg.combo === 'string' ? msg.combo : '';
            for (const l of recordProgressListeners) { try { l(captured); } catch { /* ignore */ } }
          }
          else if (msg?.type === 'recordResult') {
            if (pendingRecord) { const r = pendingRecord; pendingRecord = null; r({ combo: msg.combo }); }
          }
          else if (msg?.type === 'recordCancel') {
            if (pendingRecord) { const r = pendingRecord; pendingRecord = null; r(null); }
          }
          else if (msg?.type === 'backspaceDelete') {
            // 布防通路命中：用户在 PS 前台按了退格。分发给所有监听方，
            // 由监听方自行核对 owner（只有当前布防的 UI 会认领）。
            const owner: string = typeof msg.owner === 'string' ? msg.owner : '';
            for (const l of backspaceDeleteListeners) { try { l(owner); } catch { /* ignore */ } }
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        connected = false; emitStatus();
        // 连接断开时若仍有挂起的录制，直接取消，避免 UI 永远停在「录制中」
        if (pendingRecord) { const r = pendingRecord; pendingRecord = null; r(null); }
        if (!closedByUs) timer = setTimeout(open, 1500);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    } catch {
      timer = setTimeout(open, 1500);
    }
  };
  open();

  daemonCloseFn = () => {
    closedByUs = true;
    if (timer) clearTimeout(timer);
    try { currentWs?.close(); } catch { /* ignore */ }
  };
  return makeDaemonUnsub();

  function makeDaemonUnsub(): () => void {
    return () => {
      daemonConnectCount--;
      if (daemonConnectCount <= 0) {
        daemonConnectCount = 0;
        daemonCloseFn?.();
        daemonCloseFn = null;
      }
    };
  }
}

// ===== 功能快捷键（runFunc）=====
// 功能按钮（分块平均/扣除纯白等）的执行权在调整面板里，这里只做转发：
// 面板挂载后 registerFuncRunner 注册一个「功能 id → handler」的分发器，
// 热键命中 runFunc 时按 id 调用。分发器内部持有 ref 读取最新 handler（handler 每次渲染重建）。
let funcRunner: ((funcId: string) => void) | null = null;
export function registerFuncRunner(fn: (funcId: string) => void) {
  funcRunner = fn;
}

function handleHotkey(msg: { id: string; combo?: string; action: string;  brush?: string }) {
  if (msg.action === 'toggleMain') {
    // 主开关：翻转「共享状态」而不是调用本面板内的回调。
    // token 用「组合键 + 400ms 时间桶」生成：同一次命中在所有面板上算出同一个 token，
    // 于是守护进程广播给 N 个面板也只会翻转一次（详见 MainToggleBus 头部说明）。
    const combo = msg.combo ?? '';
    const token = 'hit|' + (combo || 'toggleMain') + '|' + Math.floor(Date.now() / 400);
    void requestMainToggle(token)
      .then((st: MainToggleState) => {
        for (const l of hotkeyListeners) {
          try { l({ combo, action: 'toggleMain', ok: true, enabled: st.enabled }); } catch { /* ignore */ }
        }
      })
      .catch(() => {
        for (const l of hotkeyListeners) {
          try { l({ combo, action: 'toggleMain', ok: false }); } catch { /* ignore */ }
        }
      });
    return;
  }
  if (msg.action === 'runFunc' && msg.brush?.startsWith('fillPanel:')) {
    // 选区填充子面板开关（纯色/图案/渐变）：实现权在 APP 面板（子面板展开状态是它的 React state），
    // 与 MainToggleBus 同理经共享文件分发 + token 去重——守护进程向所有面板广播同一次命中，
    // 只有第一个写文件的请求生效，APP 面板轮询到新修订号后翻一次，绝不翻两次。
    const panel = msg.brush.slice('fillPanel:'.length) as 'color' | 'pattern' | 'gradient';
    const token = 'fillPanel|' + panel + '|' + Math.floor(Date.now() / 400);
    const combo = msg.combo ?? '';
    const broadcast = (ok: boolean) => {
      for (const l of hotkeyListeners) { try { l({ combo, action: 'runFunc', brush: msg.brush!, ok }); } catch { /* ignore */ } }
    };
    void requestFillPanelToggle(panel, token).then(() => broadcast(true)).catch(() => broadcast(false));
    return;
  }
  if (msg.action === 'runFunc' && msg.brush) {
    // 功能快捷键：先广播触发反馈（面板据此显示「热键触发：执行…」），再执行对应功能。
    // ok 取决于分发器是否注册了该功能 id；未注册时只打日志，不抛错。
    let ok = false;
    if (funcRunner) {
      try { funcRunner(msg.brush); ok = true; }
      catch (e) { console.error('⚠️ 功能快捷键执行失败（' + msg.brush + '）:', e); }
    } else {
      console.warn('⚠️ 功能快捷键命中但调整面板尚未注册执行器（' + msg.brush + '）');
    }
    for (const l of hotkeyListeners) { try { l({ combo: msg.combo ?? '', action: 'runFunc', brush: msg.brush, ok }); } catch { /* ignore */ } }
    return;
  }
  if (msg.action === 'applyBrush' && msg.brush) {
    // 守护进程按组合键命中后回传笔刷名，按名称选中对应笔刷预设。
    applyBrush(msg.brush).then((ok) => {
      // 把触发结果广播给 UI：用户按快捷键后面板立刻显示是否命中、切换是否成功
      for (const l of hotkeyListeners) { try { l({ combo: msg.combo ?? '', action: 'applyBrush', brush: msg.brush, ok }); } catch { /* ignore */ } }
    });
  }
}

export function getConfig(): HotkeyEntry[] {
  return cachedConfig.slice();
}

// 推送整套配置给守护进程（由它落盘并热更新热键）
export function pushConfig(list: HotkeyEntry[]): boolean {
  cachedConfig = list.slice();
  emitConfig();
  const WS = resolveWs();
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'config', payload: list }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ===== 主开关快捷键 =====

/**
 * 保证配置里始终存在「主开关」条目。
 * - 已有该条目：仅同步内部的 combo 缓存（combo 为 '' 表示已解绑，不再补回默认）。
 * - 没有该条目：判定为首次使用，写入默认的 Ctrl+Q 并推送给守护进程。
 * 只在收到守护进程配置后调用，因此不会在守护进程未连接时空转。
 */
function ensureMainToggleEntry(): void {
  const existing = cachedConfig.find(e => e.action === 'toggleMain');
  if (existing) {
    mainToggleCombo = existing.combo || '';
    return;
  }
  mainToggleCombo = DEFAULT_MAIN_TOGGLE_COMBO;
  const entry: HotkeyEntry = {
    id: MAIN_TOGGLE_ID,
    combo: DEFAULT_MAIN_TOGGLE_COMBO,
    action: 'toggleMain'
  };
  cachedConfig = [entry, ...cachedConfig];
  pushConfig(cachedConfig);
}

/** 当前主开关快捷键；'' 表示未绑定，null 表示还没读到过配置。 */
export function getMainToggleCombo(): string {
  return mainToggleCombo ?? '';
}

/** 是否已连上守护进程（菜单里「设置主开关快捷键」需要据此给出提示）。 */
export function isDaemonConnected(): boolean {
  return connected;
}

/**
 * 重新指定主开关快捷键。combo 传 '' 表示解绑。
 * 若该组合键已被某个笔刷热键占用，会覆盖掉那条笔刷映射（主开关优先级更高）。
 */
export function setMainToggleCombo(combo: string): boolean {
  const others = cachedConfig.filter(e =>
    e.action !== 'toggleMain' && !(combo && e.combo === combo)
  );
  const entry: HotkeyEntry = { id: MAIN_TOGGLE_ID, combo, action: 'toggleMain' };
  cachedConfig = [entry, ...others];
  mainToggleCombo = combo;
  return pushConfig(cachedConfig);
}

// ===== 直接切笔刷（不依赖录制动作）=====
// 正确的 descriptor（UXP 论坛 7168 帖 #12 与 2127 帖 IanBarber 实例双重确认）：
//   { _obj:'select', _target:[{ _ref:'brush', _name:'笔刷名' }] }
// 注意两点：
// 1) 引用里必须用 _name 携带笔刷名；不能像旧写法那样用 _enum/_value:'preset' +
//    顶层 name: 字段——那种引用 PS 无法解析，batchPlay 静默无效（不报错但也不切笔刷）。
// 2) 不要加 _options:{dialogOptions:'dontDisplay'}——该选项实际效果相反：会弹 PS 错误框
//    且异常不进 catch；去掉后笔刷名不存在时会正常 throw，可被下方 catch 捕获并打日志。
// 一次完整的「切到画笔工具 + 选中笔刷预设」调用。
// 注意：不支持同名笔刷——按 _name 选中时 PS 只会命中 Brushes 列表最上方那支同名项。
async function selectBrushCommands(brushName: string) {
  // 先确保当前是画笔工具（用标准 select 切工具；工具已是画笔时可能报错，忽略）
  try {
    await action.batchPlay([
      { _obj: 'select', _target: [{ _ref: 'paintbrushTool' }] }
    ], { synchronousExecution: true });
  } catch { /* 已是画笔工具 */ }
  // 按名称选中笔刷预设（选中的是 Brushes 面板里的预设，全局生效）
  return await action.batchPlay([
    { _obj: 'select', _target: [{ _ref: 'brush', _name: brushName }] }
  ], { synchronousExecution: true });
}

export async function applyBrush(brushName: string): Promise<boolean> {
  try {
    // 首选直连 batchPlay：切换工具/笔刷属于「应用状态」而非文档修改，
    // 多数情况下不需要模态作用域，且不打断用户当前操作（无进度条、无状态抢占）。
    try {
      await selectBrushCommands(brushName);
      return true;
    } catch (directErr) {
      // 某些 PS 版本/某些状态下会要求 batchPlay 必须在模态作用域里执行，
      // 这里做一次回退；两条路都不通才判定失败。
      await runAsModal(async () => {
        await selectBrushCommands(brushName);
      }, { commandName: '切换笔刷' });
      return true;
    }
  } catch (e) {
    console.error('⚠️ 切换笔刷失败（笔刷名「' + brushName + '」可能不存在，需与 Brushes 面板名称完全一致）:', e);
    return false;
  }
}

// ===== 枚举当前可用笔刷预设（供面板下拉使用；失败返回空，不影响核心功能）=====
// 正确路径：读取 application 描述符里的 presetManager（第 0 组 = Brush Presets，
// 第 7 组 = Tool Presets）。这是 UXP 下枚举笔刷名最可靠的方式（论坛 How-to-get-all-
// brush-or-tool-presets 确认）。老写法用 get + brushPreset ordinal all 取到的结构里
// 拿不到 name 列表，所以一直枚举为空。
export async function enumerateBrushes(): Promise<string[]> {
  try {
    // 1) 优先用现代 app.brushes 集合（部分较新 PS 版本提供）
    const brushesApi: any = (app as any)?.brushes;
    if (brushesApi && typeof brushesApi.get === 'function') {
      try {
        // ⚠️ DOM 集合的 get 同样是一次宿主往返 ⇒ 走 psRead（模态作用域）。
        const list: any[] = await psRead<any[]>(
          () => brushesApi.get(),
          { label: '枚举笔刷预设', retries: 0 }
        ) as any;
        if (Array.isArray(list)) {
          const names = list.map((b: any) => (b?.name ?? '')).filter((x: any) => !!x);
          if (names.length) return names as string[];
        }
      } catch { /* 退回到 batchPlay */ }
    }

    // 2) 读取 application 描述符里的 presetManager（⚠️ 走 psRead，原为裸 batchPlay get）
    const res: any = await psRead<any>(
      () => action.batchPlay([
        {
          _obj: 'get',
          _target: [
            { _ref: 'property', _property: 'presetManager' },
            { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }
          ],
          _options: { dialogOptions: 'dontDisplay' }
        }
      ], { synchronousExecution: true }),
      { label: '读取笔刷预设表', retries: 0 }
    );
    if (!res) return [];

    const appDesc: any = Array.isArray(res) ? res[0] : res;
    let pm: any = appDesc?.presetManager;
    // 有些版本直接把 presetManager 描述符作为返回值（而不是包在 application 里）
    if (!pm && (appDesc?._obj === 'presetManager' || Array.isArray(appDesc?.preset) || Array.isArray(appDesc?.brushPreset))) {
      pm = appDesc;
    }
    if (!pm) return [];

    // presetManager 可能是「分组数组」，也可能是带 preset/brushPreset 的容器
    const groups: any[] = [];
    if (Array.isArray(pm)) groups.push(...pm);
    else if (Array.isArray(pm.preset)) groups.push(...pm.preset);
    else if (Array.isArray(pm.brushPreset)) groups.push(...pm.brushPreset);

    // 第 0 组是 Brush Presets
    const group = groups[0];
    if (!group) return [];
    const rawNames: any = group.name ?? group.names;
    if (!rawNames) return [];
    const arr: any[] = Array.isArray(rawNames) ? rawNames : [rawNames];
    const names = arr
      .map((n: any) => (typeof n === 'string' ? n : (n?.name ?? n?._value ?? '')))
      .filter((x: any) => !!x && typeof x === 'string');
    return names as string[];
  } catch (e) {
    console.warn('⚠️ 枚举笔刷失败（可手动输入笔刷名）:', e);
    return [];
  }
}


// ===== 请求守护进程录制组合键（UXP 不再自行监听键盘）=====
// 两段式录制：守护进程先捕获组合键（recordCaptured 实时回显，订阅 onRecordProgress），
// 用户按回车确认后回传 {type:'recordResult',combo}；Esc 取消回传 recordCancel。
// 退格不参与录制（录制期既不绑定为组合键、也不删除绑定）；
// 删除绑定走「单击选中 + 退格」的 backspaceDelete 布防通路（见 armBackspaceDelete）。
// 返回 Promise：{combo} 或 null(取消/失败)。
export function requestHotkeyRecording(brush: string): Promise<{ combo: string } | null> {
  return new Promise((resolve) => {
    const WS = resolveWs();
    if (!currentWs || currentWs.readyState !== (currentWs.OPEN ?? 1)) { resolve(null); return; }
    pendingRecord = resolve;
    try {
      currentWs.send(JSON.stringify({ type: 'recordStart', brush }));
    } catch {
      pendingRecord = null;
      resolve(null);
    }
  });
}

// 主动取消录制（UXP 端用户点「取消」时调用）
export function cancelHotkeyRecording(): boolean {
  const WS = resolveWs();
  if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
    try { currentWs.send(JSON.stringify({ type: 'recordCancel' })); return true; } catch { /* ignore */ }
  }
  return false;
}

// 订阅录制进度（捕获到组合键、尚未确认时回调；确认/取消后不再有进度）。
// 返回退订函数。录制会话同一时刻只有一个，所有订阅方都会收到同一份进度。
export function onRecordProgress(fn: (combo: string) => void): () => void {
  recordProgressListeners.push(fn);
  return () => { const i = recordProgressListeners.indexOf(fn); if (i >= 0) recordProgressListeners.splice(i, 1); };
}

// ===== 退格删除绑定（「单击选中条目 + 非录制态按退格 = 解绑」通路）=====
// 守护进程布防后，在 PS 前台按退格会回传 backspaceDelete（按键被守护进程吞掉，
// 不会唤出 PS 的「填充」对话框）；具体解绑哪条由布防的 UI 自己决定。
// 同一时刻只有一个 UI 持有布防权：armedOwner 幂等去重，重复布防/撤防不重发指令。
const backspaceDeleteListeners: ((owner: string) => void)[] = [];
let armedDeleteOwner: string | null = null;

export function onBackspaceDelete(fn: (owner: string) => void): () => void {
  backspaceDeleteListeners.push(fn);
  return () => { const i = backspaceDeleteListeners.indexOf(fn); if (i >= 0) backspaceDeleteListeners.splice(i, 1); };
}

/** 布防：当前 UI 选中了条目，此后 PS 前台按退格 = 请求解绑（守护进程吞掉该按键）。 */
export function armBackspaceDelete(owner: string): void {
  if (armedDeleteOwner === owner) return; // 幂等：同一 UI 重复布防不重发
  armedDeleteOwner = owner;
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'armDelete', owner }));
    }
  } catch { /* ignore */ }
}

/** 撤防：仅当 owner 仍是当前布防方才生效（后布防的 UI 不被先前的撤防误伤）。 */
export function disarmBackspaceDelete(owner: string): void {
  if (armedDeleteOwner !== owner) return;
  armedDeleteOwner = null;
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'disarmDelete' }));
    }
  } catch { /* ignore */ }
}

// ============================================================================
// 当前工具 / 笔刷读取（非破坏性，只读）：供「检测类型」扫描与下拉展示复用。
// 关键认知（已通过诊断验证）：
//   · { _ref:'brush', _enum:'ordinal', _value:'targetEnum' } 这个目标 PS 不支持 get，
//     会返回 { _obj:'error', result:-128 }。判定成功必须检查 _obj !== 'error'。
//   · application.tool._enum 才是可靠的「当前工具类别」信号（paintbrushTool /
//     mixerBrushTool / wetBrushTool / smudgeTool …）。
// ============================================================================

/** get 应用级属性时固定的尾部引用。 */
const APP_TARGET = { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' };

/**
 * 判断 batchPlay 的 get 是否【真正成功】。
 * PS 失败时不抛异常，而是返回 [{ _obj:'error', message:'', result:-128 }]，
 * 所以必须显式识别这种「假成功」。
 */
function isGetOk(res: any): boolean {
  const first = Array.isArray(res) ? res[0] : res;
  if (!first || typeof first !== 'object') return false;
  if (first._obj === 'error') return false;
  if (typeof first.result === 'number' && first.result < 0) return false;
  return Object.keys(first).length > 0;
}

/** Photoshop 工具 _enum → 中文名（用于笔刷/工具类型显示，例如 paintbrushTool → 画笔）。 */
const TOOL_TYPE_CN: Record<string, string> = {
  paintbrushTool: '画笔',
  pencilTool: '铅笔',
  mixerBrushTool: '混合器画笔',
  wetBrushTool: '混合器画笔', // 混合器画笔预设在部分 PS 版本下 tool._enum 返回 wetBrushTool
  smudgeTool: '涂抹',
  eraserTool: '橡皮擦',
  backgroundEraserTool: '背景橡皮擦',
  magicEraserTool: '魔术橡皮擦',
  cloneStampTool: '仿制图章',
  patternStampTool: '图案图章',
  healingBrushTool: '修复画笔',
  spotHealingBrushTool: '污点修复画笔',
  patchTool: '修补',
  redEyeTool: '红眼工具',
  historyBrushTool: '历史记录画笔',
  artHistoryBrushTool: '历史记录艺术画笔',
  colorReplacementBrushTool: '颜色替换',
  blurTool: '模糊',
  sharpenTool: '锐化',
  artBrushTool: '艺术画笔',
};

/**
 * 读取当前工具类型（_enum），例如 paintbrushTool；读不到返回 null。
 *
 * ⚠️ 2026-10-09 收口：此前是**裸 batchPlay get**（记忆里登记的残余缺口）。
 * application 级 get 在宿主忙碌期（删除 / 合并 / 拼合 / 打开 / 保存大文档…）
 * 会弹出宿主原生「命令"获取"当前不可用」—— 而本函数的调用点之一是
 * 「笔刷类型扫描」，那段整包在模态作用域里，命中概率不低。现在统一走 `psRead`。
 * （`psRead` 在自家模态作用域内会自动降级为直读，因此不会嵌套报错。）
 */
export async function getSelectedBrushToolEnum(): Promise<string | null> {
  const r: any = await psRead<any>(
    () => action.batchPlay(
      [{ _obj: 'get', _target: [{ _property: 'tool' }, APP_TARGET], _options: { dialogOptions: 'dontDisplay' } }],
      { synchronousExecution: true }
    ),
    { label: '读取当前工具', retries: 0 }
  );
  if (!r || !isGetOk(r)) return null;
  const d = Array.isArray(r) ? r[0] : r;
  const tool = d?.tool?._enum || d?.tool?._value || null;
  return typeof tool === 'string' ? tool : null;
}

/** 当前笔刷的聚合信息（类型 / 名称 / 直径），用于下拉展示。 */
export interface BrushNameId {
  toolEnum: string | null;   // 原始 _enum，如 paintbrushTool
  type: string | null;      // 中文类型名，未知时回退为原始 _enum
  name: string | null;      // 当前笔刷名（来自 currentToolOptions.brush.name）
  diameter: number | null;  // 笔尖直径（px）
}

/**
 * 读取当前选中笔刷的聚合信息（非破坏性，只读）。
 * ⚠️ 同样已收口到 `psRead`（原为裸 batchPlay get，见 getSelectedBrushToolEnum 的说明）。
 */
export async function getSelectedBrushNameId(): Promise<BrushNameId> {
  const info: BrushNameId = { toolEnum: null, type: null, name: null, diameter: null };
  const r: any = await psRead<any>(
    () => action.batchPlay(
      [{ _obj: 'get', _target: [{ _property: 'currentToolOptions' }, APP_TARGET], _options: { dialogOptions: 'dontDisplay' } }],
      { synchronousExecution: true }
    ),
    { label: '读取当前笔刷', retries: 0 }
  );
  if (r && isGetOk(r)) {
    const d = Array.isArray(r) ? r[0] : r;
    const brush = d?.currentToolOptions?.brush;
    if (brush && typeof brush === 'object') {
      info.name = typeof brush.name === 'string' ? brush.name : null;
      const dia = brush.diameter;
      if (dia && typeof dia._value === 'number') info.diameter = dia._value;
    }
  }
  info.toolEnum = await getSelectedBrushToolEnum();
  info.type = info.toolEnum ? (TOOL_TYPE_CN[info.toolEnum] || info.toolEnum) : null;
  return info;
}

// ===== 方案 B：扫描全部笔刷预设的类型 =====
// 思路（已在诊断中验证可行）：选中某支预设后读 application.tool._enum，
// 混合器/涂抹等预设会连带把当前工具切到 mixerBrushTool/smudgeTool，从而反推出类型。
// 关键实现点：
//   1) 选中预设时【不强制切到画笔工具】——否则会掩盖真实工具类型，全标成「画笔」。
//   2) 扫描前记录用户当前笔刷，扫描后【尽力还原】（finally 中），避免丢失用户状态。
//   3) 整段包在 runAsModal（≡ core.executeAsModal）里，作为一次逻辑操作，扫描期间不穿插其它命令。
//   4) 每支独立 try/catch：一支失败不影响其余；读不到类型就留空（下拉不显示类型列）。
//   5) 并发守卫：防止用户连点触发多轮扫描互相干扰。
let brushTypeDetecting = false;

/** 仅按名称选中笔刷预设（不强切工具，以暴露真实工具类型）。 */
async function selectBrushForDetection(name: string): Promise<void> {
  await action.batchPlay([
    { _obj: 'select', _target: [{ _ref: 'brush', _name: name }] }
  ], { synchronousExecution: true });
}

/** 记录用户当前笔刷，供扫描后还原。 */
async function captureCurrentBrush(): Promise<{ toolEnum: string | null; brushName: string | null }> {
  const info = await getSelectedBrushNameId();
  return { toolEnum: info.toolEnum, brushName: info.name };
}

/** 尽力还原用户原本的笔刷与工具。 */
async function restoreCurrentBrush(saved: { toolEnum: string | null; brushName: string | null } | null): Promise<void> {
  if (!saved) return;
  try {
    if (saved.brushName) {
      // applyBrush 会切回画笔工具并选中该笔刷；若该笔刷本身是混合器/涂抹预设，
      // 选中动作通常会把工具重新切回对应类型，达到还原目的。
      await applyBrush(saved.brushName);
    } else if (saved.toolEnum) {
      await action.batchPlay(
        [{ _obj: 'select', _target: [{ _ref: saved.toolEnum }] }],
        { synchronousExecution: true }
      );
    }
  } catch (e) {
    console.warn('⚠️ 检测笔刷类型：还原原笔刷失败，请手动切回你之前的笔刷', e);
  }
}

/**
 * 扫描全部笔刷预设，返回 { 笔刷名: 中文类型 } 映射。
 * @param onProgress 进度回调 (已检测数, 总数, 当前笔刷名)，可用于 UI 反馈。
 * @returns 映射；值可能是空串（读不到类型，表示该预设在当前工具下不暴露类型，按「画笔」处理）。
 */
export async function detectAllBrushTypes(
  onProgress?: (done: number, total: number, current: string) => void
): Promise<Record<string, string>> {
  if (brushTypeDetecting) { console.warn('⚠️ 笔刷类型检测已在进行，忽略重复触发'); return {}; }
  brushTypeDetecting = true;
  const out: Record<string, string> = {};
  try {
    const names = await enumerateBrushes();
    if (!names.length) { console.warn('⚠️ 未枚举到笔刷，无法检测类型'); return out; }
    const saved = await captureCurrentBrush();
    const total = names.length;
    try {
      await runAsModal(async () => {
        for (let i = 0; i < total; i++) {
          const name = names[i];
          if (onProgress) onProgress(i, total, name);
          try {
            await selectBrushForDetection(name);
            const tool = await getSelectedBrushToolEnum();
            out[name] = tool ? (TOOL_TYPE_CN[tool] || tool) : '';
          } catch {
            out[name] = ''; // 该预设选中失败，跳过
          }
        }
      }, { commandName: '检测笔刷类型' });
    } finally {
      await restoreCurrentBrush(saved);
    }
    const known = Object.values(out).filter(Boolean).length;
    console.log(`[笔刷类型检测] 完成：共 ${total} 支，识别到类型 ${known} 支`);
  } catch (e) {
    console.error('⚠️ 检测笔刷类型失败：', e);
  } finally {
    brushTypeDetecting = false;
  }
  return out;
}

