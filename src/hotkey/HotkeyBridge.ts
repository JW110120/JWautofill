// 热键桥接：UXP 侧与本地守护进程通信 + 直接切笔刷
// 设计要点（关键）：
// - UXP 沙箱没有 Node 的 fs/os/process，配置“不由插件读写文件”，统一由守护进程持有。
// - 插件只通过 WebSocket 向守护进程拉取/推送配置（getConfig / config），避免跨进程文件系统耦合。
// - 守护进程全局捕获按键后广播 hotkey 事件，插件执行「总开关切换 / 直接 select 笔刷」。

import { action, core } from 'photoshop';

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

function resolveWs(): any {
  if ((globalThis as any).WebSocket) return (globalThis as any).WebSocket;
  try { return require('ws'); } catch { return null; }
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
        } catch { /* ignore */ }
      };
      ws.onclose = () => { if (!closedByUs) timer = setTimeout(open, 1500); };
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
// 依据 Alchemist 录制「在笔刷面板选择预设」得到的描述符：select + brush(preset) + 顶层 name。
export async function applyBrush(brushName: string) {
  try {
    await core.executeAsModal(async () => {
      // 先确保当前是画笔工具（避免在非画笔工具下切笔刷无效）
      try {
        await action.batchPlay([
          {
            _obj: 'set',
            _target: [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }],
            to: { _obj: 'application', currentTool: 'paintbrush' }
          }
        ], { synchronousExecution: true });
      } catch { /* 工具已是画笔时可能报错，忽略 */ }
      await action.batchPlay([
        {
          _obj: 'select',
          _target: [
            { _ref: 'brush', _enum: 'brush', _value: 'preset' },
            { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }
          ],
          name: brushName
        }
      ], { synchronousExecution: true });
    }, { commandName: '切换笔刷' });
  } catch (e) {
    console.error('⚠️ 切换笔刷失败:', e);
  }
}

// ===== 枚举当前可用笔刷预设（供面板下拉使用；失败返回空，不影响核心功能）=====
export async function enumerateBrushes(): Promise<string[]> {
  try {
    const res = await action.batchPlay([
      { _obj: 'get', _target: [{ _ref: 'brushPreset', _enum: 'ordinal', _value: 'all' }] }
    ], { synchronousExecution: true });
    const items: any[] = Array.isArray(res) ? res : [];
    const names = items
      .map((it: any) => it.name || it.localID || it.ID)
      .filter((x: any) => !!x);
    return Array.from(new Set(names)) as string[];
  } catch (e) {
    console.warn('⚠️ 枚举笔刷失败（可手动输入笔刷名）:', e);
    return [];
  }
}
