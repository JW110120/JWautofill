// 热键桥接：UXP 侧与本地守护进程通信 + 直接切笔刷
// 设计要点（关键）：
// - UXP 沙箱没有 Node 的 fs/os/process，配置“不由插件读写文件”，统一由守护进程持有。
// - 插件只通过 WebSocket 向守护进程拉取/推送配置（getConfig / config），避免跨进程文件系统耦合。
// - 守护进程全局捕获按键后广播 hotkey 事件，插件执行「总开关切换 / 直接 select 笔刷」。

import { action, core, app } from 'photoshop';
import { shell, storage } from 'uxp';
import { MainToggleState, requestMainToggle } from '../utils/MainToggleBus';

export interface HotkeyEntry {
  id: string;
  combo: string;                 // 例如 "Ctrl+Shift+R"、"Alt+F1"
  action: 'toggleMain' | 'applyBrush';
  brush?: string;                // applyBrush 时的笔刷名（PS 预设名，需精确匹配）
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
  if (action !== 'toggleMain' && action !== 'applyBrush') return null;
  // 主开关允许 combo 为空（表示用户已解绑，不能再被补回默认值）；
  // 其余条目没有组合键就没有意义，直接丢弃。
  if (!combo && action !== 'toggleMain') return null;
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
          else if (msg?.type === 'recordResult') {
            if (pendingRecord) { const r = pendingRecord; pendingRecord = null; r({ combo: msg.combo }); }
          }
          else if (msg?.type === 'recordCancel') {
            if (pendingRecord) { const r = pendingRecord; pendingRecord = null; r(null); }
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
  if (msg.action === 'applyBrush' && msg.brush) {
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

// ===== 直接切笔刷（不依赖录制动作，仿 Brusherator）=====
// 正确的 descriptor（UXP 论坛 7168 帖 #12 与 2127 帖 IanBarber 实例双重确认）：
//   { _obj:'select', _target:[{ _ref:'brush', _name:'笔刷名' }] }
// 注意两点：
// 1) 引用里必须用 _name 携带笔刷名；不能像旧写法那样用 _enum/_value:'preset' +
//    顶层 name: 字段——那种引用 PS 无法解析，batchPlay 静默无效（不报错但也不切笔刷）。
// 2) 不要加 _options:{dialogOptions:'dontDisplay'}——该选项实际效果相反：会弹 PS 错误框
//    且异常不进 catch；去掉后笔刷名不存在时会正常 throw，可被下方 catch 捕获并打日志。
// 一次完整的「切到画笔工具 + 选中笔刷预设」调用
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
      await core.executeAsModal(async () => {
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
        const list: any[] = await brushesApi.get();
        if (Array.isArray(list)) {
          const names = list.map((b: any) => (b?.name ?? '')).filter((x: any) => !!x);
          if (names.length) return Array.from(new Set(names)) as string[];
        }
      } catch { /* 退回到 batchPlay */ }
    }

    // 2) 读取 application 描述符里的 presetManager
    const res: any = await action.batchPlay([
      {
        _obj: 'get',
        _target: [
          { _ref: 'property', _property: 'presetManager' },
          { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }
        ],
        _options: { dialogOptions: 'dontDisplay' }
      }
    ], { synchronousExecution: true });

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
    return Array.from(new Set(names)) as string[];
  } catch (e) {
    console.warn('⚠️ 枚举笔刷失败（可手动输入笔刷名）:', e);
    return [];
  }
}


// ===== 请求守护进程录制组合键（UXP 不再自行监听键盘）=====
// 守护进程用 Windows 全局键盘钩子捕获，捕获到后回传 {type:'recordResult',combo}，
// 或被用户按 Esc 取消回传 {type:'recordCancel'}。返回 Promise：{combo} 或 null(取消/失败)。
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

/** 读取当前工具类型（_enum），例如 paintbrushTool；读不到返回 null。 */
export async function getSelectedBrushToolEnum(): Promise<string | null> {
  try {
    const r: any = await action.batchPlay(
      [{ _obj: 'get', _target: [{ _property: 'tool' }, APP_TARGET], _options: { dialogOptions: 'dontDisplay' } }],
      { synchronousExecution: true }
    );
    if (!isGetOk(r)) return null;
    const d = Array.isArray(r) ? r[0] : r;
    const tool = d?.tool?._enum || d?.tool?._value || null;
    return typeof tool === 'string' ? tool : null;
  } catch {
    return null;
  }
}

/** 当前笔刷的聚合信息（类型 / 名称 / 直径），用于下拉展示。 */
export interface BrushInfo {
  toolEnum: string | null;   // 原始 _enum，如 paintbrushTool
  type: string | null;      // 中文类型名，未知时回退为原始 _enum
  name: string | null;      // 当前笔刷名（来自 currentToolOptions.brush.name）
  diameter: number | null;  // 笔尖直径（px）
}

/** 读取当前选中笔刷的聚合信息（非破坏性，只读）。 */
export async function getSelectedBrushInfo(): Promise<BrushInfo> {
  const info: BrushInfo = { toolEnum: null, type: null, name: null, diameter: null };
  try {
    const r: any = await action.batchPlay(
      [{ _obj: 'get', _target: [{ _property: 'currentToolOptions' }, APP_TARGET], _options: { dialogOptions: 'dontDisplay' } }],
      { synchronousExecution: true }
    );
    if (isGetOk(r)) {
      const d = Array.isArray(r) ? r[0] : r;
      const brush = d?.currentToolOptions?.brush;
      if (brush && typeof brush === 'object') {
        info.name = typeof brush.name === 'string' ? brush.name : null;
        const dia = brush.diameter;
        if (dia && typeof dia._value === 'number') info.diameter = dia._value;
      }
    }
  } catch { /* 非关键 */ }
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
//   3) 整段包在 core.executeAsModal 里，作为一次逻辑操作，扫描期间不穿插其它命令。
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
  const info = await getSelectedBrushInfo();
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
      await core.executeAsModal(async () => {
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

