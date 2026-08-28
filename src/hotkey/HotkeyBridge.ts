// 热键桥接：UXP 侧与本地守护进程通信 + 直接切笔刷
// 设计要点（关键）：
// - UXP 沙箱没有 Node 的 fs/os/process，配置“不由插件读写文件”，统一由守护进程持有。
// - 插件只通过 WebSocket 向守护进程拉取/推送配置（getConfig / config），避免跨进程文件系统耦合。
// - 守护进程全局捕获按键后广播 hotkey 事件，插件执行「总开关切换 / 直接 select 笔刷」。

import { action, core, app } from 'photoshop';
import { shell } from 'uxp';

export interface HotkeyEntry {
  id: string;
  combo: string;                 // 例如 "Ctrl+Shift+R"、"Alt+F1"
  action: 'toggleMain' | 'applyBrush';
  brush?: string;                // applyBrush 时的笔刷名（PS 预设名，需精确匹配）
}

const WS_URL = 'ws://127.0.0.1:18923';

type ConfigListener = (entries: HotkeyEntry[]) => void;

let cachedConfig: HotkeyEntry[] = [];
const configListeners: ConfigListener[] = [];
let mainToggleHandler: (() => void) | null = null;
let currentWs: any = null;
let connected = false;
// 当前挂起的录制请求（守护进程回传 recordResult/recordCancel 时兑现）
let pendingRecord: ((r: { combo: string } | null) => void) | null = null;
const statusListeners: ((c: boolean) => void)[] = [];

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

export function registerMainToggleHandler(fn: () => void) {
  mainToggleHandler = fn;
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
        try { ws.send(JSON.stringify({ type: 'getConfig' })); } catch { /* ignore */ }
      };
      ws.onmessage = (ev: any) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === 'hotkey') handleHotkey(msg);
          else if (msg?.type === 'config') {
            cachedConfig = Array.isArray(msg.payload) ? (msg.payload as HotkeyEntry[]) : [];
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

function handleHotkey(msg: { id: string; action: string;  brush?: string }) {
  if (msg.action === 'toggleMain') {
    if (mainToggleHandler) mainToggleHandler();
    return;
  }
  if (msg.action === 'applyBrush' && msg.brush) {
    applyBrush(msg.brush);
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

// ===== 直接切笔刷（不依赖录制动作，仿 Brusherator）=====
// 正确的 descriptor（UXP 论坛 7168 帖 #12 与 2127 帖 IanBarber 实例双重确认）：
//   { _obj:'select', _target:[{ _ref:'brush', _name:'笔刷名' }] }
// 注意两点：
// 1) 引用里必须用 _name 携带笔刷名；不能像旧写法那样用 _enum/_value:'preset' +
//    顶层 name: 字段——那种引用 PS 无法解析，batchPlay 静默无效（不报错但也不切笔刷）。
// 2) 不要加 _options:{dialogOptions:'dontDisplay'}——该选项实际效果相反：会弹 PS 错误框
//    且异常不进 catch；去掉后笔刷名不存在时会正常 throw，可被下方 catch 捕获并打日志。
export async function applyBrush(brushName: string): Promise<boolean> {
  try {
    await core.executeAsModal(async () => {
      // 先确保当前是画笔工具（用标准 select 切工具；工具已是画笔时可能报错，忽略）
      try {
        await action.batchPlay([
          { _obj: 'select', _target: [{ _ref: 'paintbrushTool' }] }
        ], { synchronousExecution: false });
      } catch { /* 已是画笔工具 */ }
      // 按名称选中笔刷预设（选中的是 Brushes 面板里的预设，全局生效）
      await action.batchPlay([
        { _obj: 'select', _target: [{ _ref: 'brush', _name: brushName }] }
      ], { synchronousExecution: false });
    }, { commandName: '切换笔刷' });
    return true;
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
