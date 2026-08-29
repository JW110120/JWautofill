// 热键桥接：UXP 侧与本地守护进程通信 + 直接切笔刷
// 设计要点（关键）：
// - UXP 沙箱没有 Node 的 fs/os/process，配置“不由插件读写文件”，统一由守护进程持有。
// - 插件只通过 WebSocket 向守护进程拉取/推送配置（getConfig / config），避免跨进程文件系统耦合。
// - 守护进程全局捕获按键后广播 hotkey 事件，插件执行「总开关切换 / 直接 select 笔刷」。

import { action, core, app } from 'photoshop';
import { shell, storage } from 'uxp';

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
let mainToggleHandler: (() => void) | null = null;
let currentWs: any = null;
let connected = false;
// 当前挂起的录制请求（守护进程回传 recordResult/recordCancel 时兑现）
let pendingRecord: ((r: { combo: string } | null) => void) | null = null;
const statusListeners: ((c: boolean) => void)[] = [];
// 热键触发监听（供面板显示触发反馈，也便于用户确认事件链路是否打通）
const hotkeyListeners: ((info: { combo: string; action: string; brush?: string; ok: boolean }) => void)[] = [];

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

export function registerMainToggleHandler(fn: () => void) {
  mainToggleHandler = fn;
}

// 卸载动作由面板右上角的菜单触发，但真正的实现（含状态提示）在 BrushHotkeySection 里，
// 这里做一个简单的注册/转发，避免把面板内部状态暴露给菜单层。
let uninstallHandler: (() => Promise<string>) | null = null;
export function registerUninstallHandler(fn: () => Promise<string>) {
  uninstallHandler = fn;
}
export async function requestUninstall(): Promise<string> {
  if (!uninstallHandler) return '卸载功能尚未就绪（请展开「笔刷热键（全局）」分区后重试）';
  try { return await uninstallHandler(); }
  catch (e: any) { return '卸载失败：' + (e?.message || String(e)); }
}

// 订阅热键触发事件（无论成败都会回调，ok=false 表示执行 batchPlay 失败）
export function onHotkeyTriggered(fn: (info: { combo: string; action: string; brush?: string; ok: boolean }) => void): () => void {
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
export function connectHotkeyDaemon(): () => void {
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

  return () => {
    closedByUs = true;
    if (timer) clearTimeout(timer);
    try { currentWs?.close(); } catch { /* ignore */ }
  };
}

function handleHotkey(msg: { id: string; combo?: string; action: string;  brush?: string }) {
  if (msg.action === 'toggleMain') {
    if (mainToggleHandler) mainToggleHandler();
    for (const l of hotkeyListeners) { try { l({ combo: msg.combo ?? '', action: 'toggleMain', ok: true }); } catch { /* ignore */ } }
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

// ===== 笔刷类型（尽力而为）=====
// 理想效果：下拉里每个笔刷名右侧显示「混合器 / 涂抹 / 喷枪…」这类类型。
// 现实限制：presetManager 的 Brush Presets 分组只暴露 name 列表，不含笔刷类型；
// 逐支选中去读类型会破坏用户当前的笔刷状态，不可接受。因此这里只做「尽力而为」：
// 若 PS 的 app.brushes 集合里带了类型字段就用，取不到就返回空表（下拉不显示类型列）。
// 桌面端 Photoshop 的部分版本确实不带该字段，此时按需求文档「如不能则忽略」处理。
const BRUSH_TYPE_CN: Record<string, string> = {
  computedbrush: '圆形',
  sampledbrush: '取样',
  mixerbrush: '混合器',
  smudgebrush: '涂抹',
  bristlebrush: '硬毛刷',
  erodebrush: '侵蚀',
  airbrush: '喷枪',
  charcoalbrush: '炭笔',
  watercolorbrush: '水彩',
  inkbrush: '墨水',
  oilbrush: '油画',
  pastelbrush: '蜡笔',
  pencilbrush: '铅笔',
  markerbrush: '马克笔',
  flatbrush: '平头',
  roundbrush: '圆头',
  fanbrush: '扇形',
  calligraphicbrush: '书法',
  brushtip: '笔尖',
  dualbrush: '双重画笔',
  bristle: '硬毛刷',
  erode: '侵蚀',
  air: '喷枪',
  mixer: '混合器',
  smudge: '涂抹'
};

export async function enumerateBrushTypes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const brushesApi: any = (app as any)?.brushes;
    if (!brushesApi || typeof brushesApi.get !== 'function') return out;
    const list: any[] = await brushesApi.get();
    if (!Array.isArray(list)) return out;
    for (const b of list) {
      const name: string = (b?.name ?? '').toString();
      if (!name) continue;
      const raw: any = b?.type ?? b?.brushType ?? b?.kind ?? b?.presetKind ?? b?.brushKind;
      if (typeof raw !== 'string' || !raw) continue;
      const key = raw.toLowerCase();
      out[name] = BRUSH_TYPE_CN[key] || raw;
    }
  } catch { /* 取不到就不显示类型 */ }
  return out;
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
