import React, { useState, useEffect } from 'react';
import { storage, shell } from 'uxp';
import { HotkeyEntry, connectHotkeyDaemon, onConfig, pushConfig, enumerateBrushes, onDaemonStatus, launchDaemon } from './HotkeyBridge';
import { ExpandIcon } from '../styles/Icons';

// 笔刷热键分区：在调整面板内录制「笔刷 + 快捷键」，持久化到共享配置，
// 由本地守护进程在全局捕获按键后直接切换笔刷（仿 Brusherator，不录制动作）。
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 };
const itemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '6px 8px', marginTop: 6, borderRadius: 6,
  background: 'rgba(255,255,255,0.06)', fontSize: 12
};

// 命名键 -> 与守护进程 ParseCombo 一致的 token（避免依赖字符首字母误判）
const NAMED_KEYS: Record<string, string> = {
  Backspace: 'Backspace', Tab: 'Tab', Enter: 'Enter', Escape: 'Escape',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
};

export default function BrushHotkeySection() {
  const [collapsed, setCollapsed] = useState(false);
  const [brushes, setBrushes] = useState<string[]>([]);
  const [entries, setEntries] = useState<HotkeyEntry[]>([]);
  const [selectedBrush, setSelectedBrush] = useState('');
  const [usePicker, setUsePicker] = useState(true);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState('');
  const [daemonConnected, setDaemonConnected] = useState(false);
  const [daemonPath, setDaemonPath] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('jwauto_daemon_path');
      if (saved) return saved;
    } catch { /* ignore */ }
    // 动态解析真实安装路径（install.ps1 会把 exe 装到 %LOCALAPPDATA%\JWautofill\daemon\）。
    // 换机器/换用户时不再写死，避免“在家默认路径不对”的问题；取不到则留空，由「选择文件」补。
    try {
      const la = (globalThis as any).process?.env?.LOCALAPPDATA;
      if (la) return la + '\\JWautofill\\daemon\\JWautofillHotkeyDaemon.exe';
    } catch { /* ignore */ }
    return '';
  });

  useEffect(() => {
    const unsub = connectHotkeyDaemon();
    onConfig((list)  => setEntries(list));
    onDaemonStatus(setDaemonConnected);
    enumerateBrushes().then((b) => { setBrushes(b); setUsePicker(b.length > 0); }).catch(() => {
      setBrushes([]); setUsePicker(false);
    });
    return unsub;
  }, []);

  const startDaemon = () => {
    const path = daemonPath.trim();
    if (!path) { setMessage('请先选择守护进程 exe（点「选择 exe」或「运行安装器」）'); return; }
    const lower = path.toLowerCase();
    if (lower.endsWith('.ps1') || lower.endsWith('.bat')) {
      setMessage('这是安装脚本，请点「运行安装器」；安装后点「选择 exe」选取生成的 exe');
      return;
    }
    try { localStorage.setItem('jwauto_daemon_path', path); } catch { /* ignore */ }
    if (launchDaemon(path)) setMessage('已尝试启动守护进程，请稍候…');
    else setMessage('启动失败：请确认 exe 路径正确，或先「运行安装器」');
  };

  // 在插件目录内按相对路径定位文件（逐层 getEntry，兼容不同 UXP 版本对嵌套路径的支持差异）
  const getBundledEntry = async (relPath: string) => {
    const folder = await storage.localFileSystem.getPluginFolder();
    let cur: any = folder;
    for (const seg of relPath.split('/')) {
      if (!seg) continue;
      cur = await cur.getEntry(seg);
      if (!cur) return null;
    }
    return cur as any;
  };

  // 直接唤起安装器 install.bat（无需手动输入路径）。
  // UXP 下 .bat 经 shell.openPath 会以「运行」方式执行，弹出安装窗口。
  const runInstaller = async () => {
    try {
      const bat = await getBundledEntry('native/HotkeyDaemon/install.bat');
      if (!bat) { setMessage('找不到 install.bat，请用资源管理器双击它'); return; }
      shell.openPath(bat.nativePath);
      setMessage('已唤起安装器 install.bat，请按窗口提示完成安装；安装后点「选择 exe」');
    } catch (e: any) {
      setMessage('唤起安装器失败：' + (e?.message || e));
    }
  };

  // 直接唤起卸载程序 uninstall.bat（安全卸载，详见 uninstall.ps1）
  const uninstallDaemon = async () => {
    try {
      const bat = await getBundledEntry('native/HotkeyDaemon/uninstall.bat');
      if (!bat) { setMessage('找不到 uninstall.bat'); return; }
      shell.openPath(bat.nativePath);
      setMessage('已唤起卸载程序，请按窗口提示完成卸载');
    } catch (e: any) {
      setMessage('唤起卸载程序失败：' + (e?.message || e));
    }
  };

  // 重新枚举笔刷列表（枚举失败时可手动重试）
  const refreshBrushes = () => {
    setMessage('正在刷新笔刷列表…');
    enumerateBrushes().then((b) => {
      setBrushes(b);
      setUsePicker(b.length > 0);
      setMessage(b.length ? ('已刷新笔刷列表：' + b.length + ' 个，请选择') : '仍未枚举到笔刷，可手动输入笔刷名');
    }).catch(() => {
      setBrushes([]); setUsePicker(false);
      setMessage('枚举笔刷失败，可手动输入笔刷名（需与 PS 完全一致）');
    });
  };

  const startRecord = () => {
    if (!selectedBrush) { setMessage('请先在上方选择一支笔刷'); return; }
    // 失焦当前元素：否则录制时按下的 Space/Enter 可能被仍在焦点的「录制」按钮再次捕获
    try { (document.activeElement as HTMLElement | null)?.blur(); } catch { /* ignore */ }
    setMessage('请按下组合键…（按 Esc 取消）');
    setRecording(true);
  };

  // 用系统文件选择框定位守护进程，避免手动输入路径（仅允许 exe / install.bat）。
  const pickDaemonFile = async () => {
    try {
      const file: any = await storage.localFileSystem.getFileForOpening({
        types: [{ description: 'JWautofill 守护进程', accept: ['exe', 'bat'] }]
      });
      if (!file) return; // 用户取消
      const p: string = file.nativePath || '';
      if (!p) { setMessage('无法读取所选文件路径'); return; }
      const name = p.toLowerCase().split('\\').pop() || '';
      if (name === 'install.bat') {
        setMessage('install.bat 是安装脚本：请用资源管理器双击它（会自动编译并启动）；或选择已生成的 JWautofillHotkeyDaemon.exe');
        return;
      }
      if (name !== 'jwautofillhotkeydaemon.exe') {
        setMessage('请选择 JWautofillHotkeyDaemon.exe（或在资源管理器双击 install.bat 安装）');
        return;
      }
      try { localStorage.setItem('jwauto_daemon_path', p); } catch { /* ignore */ }
      setDaemonPath(p);
      setMessage('已定位守护进程：' + p);
    } catch (e: any) {
      setMessage('选择文件失败：' + (e?.message || e));
    }
  };

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      // 纯修饰键（Ctrl/Shift/Alt/Win）只用于组合，不能作为触发键，继续等待实体键
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return;
      if (k === 'Escape') { setRecording(false); setMessage('已取消录制'); return; }

      e.preventDefault();
      e.stopPropagation();

      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      if (e.metaKey) parts.push('Win');

      let key = '';
      if (k === ' ') key = 'Space';
      else if (k.length === 1) key = k.toUpperCase();      // 单字符（字母/数字/符号）
      else if (/^F\d+$/.test(k)) key = k;                  // F1..F24
      else if (NAMED_KEYS[k]) key = NAMED_KEYS[k];         // 其余命名键
      if (!key) return;                                    // 未知键，忽略

      const combo = [...parts, key].join('+');
      if (entries.some(x => x.combo === combo)) setMessage('该组合键已存在，已覆盖旧映射');
      const entry: HotkeyEntry = { id: 'bk_' + Date.now(), combo, action: 'applyBrush', brush: selectedBrush };
      const next = [...entries.filter(x => x.combo !== combo), entry];
      setEntries(next);
      if (pushConfig(next)) setMessage('已保存：' + combo + ' → ' + selectedBrush);
      else setMessage('推送配置失败（守护进程未运行？）');
      setRecording(false);
    };
    // 注意：不能用 once:true —— 组合键的第一个 keydown 往往是修饰键，需持续监听直到实体键。
    // 关键：UXP 面板里 keydown 必须挂在 document 上（window 上的监听器在 UXP 中不会可靠触发），
    // 这正是「不管怎么按都录不了」的根因。
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [recording, selectedBrush, entries]);

  const removeEntry = (id: string) => {
    const next = entries.filter(e => e.id !== id);
    setEntries(next);
    pushConfig(next);
  };

  const brushOptions = brushes.length ? brushes : [];

  return (
    <div className="adjust-expand-section">
      <div className="adjust-expand-header" onClick={() => setCollapsed(c => !c)}
           title="通过本地守护进程实现全局快捷键，直接在画布上按快捷键切换笔刷（无需录制动作）。">
        <div className={`adjust-expand-icon ${collapsed ? '' : 'expanded'}`}>
          <ExpandIcon expanded={!collapsed} />
        </div>
        <div>笔刷热键（全局）</div>
      </div>
      {!collapsed && (
        <div className="adjust-expand-content expanded">
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
            选中一支笔刷 → 点「录制」→ 按下组合键。守护进程会在任意焦点下触发，直接切换该笔刷。
          </div>
          <div style={rowStyle}>
            {usePicker ? (
              <>
                <sp-picker size="s" selects="single" selected={selectedBrush}
                  onChange={(e: any) => setSelectedBrush(e.target.value)}>
                  <sp-menu>
                    {brushOptions.map(b => (
                      <sp-menu-item key={b} value={b} selected={b === selectedBrush}>{b}</sp-menu-item>
                    ))}
                  </sp-menu>
                </sp-picker>
                <sp-action-button quiet onClick={refreshBrushes} title="刷新笔刷列表">↻</sp-action-button>
              </>
            ) : (
              <sp-textfield size="s" placeholder="输入笔刷预设名（需与 PS 完全一致）"
                value={selectedBrush} onInput={(e: any) => setSelectedBrush(e.target.value)} />
            )}
            <sp-action-button onClick={startRecord} disabled={recording || !selectedBrush}>
              {recording ? '按下组合键…' : '录制快捷键'}
            </sp-action-button>
          </div>
          {!usePicker && (
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
              未能自动枚举笔刷，已切换为手动输入；点「录制快捷键」前请先填好笔刷名（需与 PS 完全一致）。
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            {entries.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>尚未绑定任何快捷键</div>}
            {entries.map(e => (
              <div key={e.id} style={itemStyle}>
                <span style={{ fontWeight: 500 }}>{e.combo}</span>
                <span style={{ opacity: 0.8 }}>{e.action === 'applyBrush' ? e.brush : '总开关'}</span>
                <sp-action-button quiet onClick={() => removeEntry(e.id)}>删除</sp-action-button>
              </div>
            ))}
          </div>

          {message && <div style={{ fontSize: 12, color: '#4CAF50', marginTop: 8 }}>{message}</div>}

          <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              守护进程状态：
              <b style={{ color: daemonConnected ? '#4CAF50' : '#E53935' }}>
                {daemonConnected ? ' 已连接' : ' 未连接'}
              </b>
            </div>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, wordBreak: 'break-all' }}>
              守护进程路径：{daemonPath || '（未选择，点「选择 exe」或「运行安装器」）'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <sp-action-button onClick={pickDaemonFile}>选择 exe</sp-action-button>
              <sp-action-button onClick={runInstaller}>运行安装器</sp-action-button>
              <sp-action-button onClick={startDaemon} disabled={!daemonPath}>启动</sp-action-button>
              <sp-action-button onClick={uninstallDaemon}>卸载守护进程</sp-action-button>
            </div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
              点「运行安装器」可自动编译并安装 exe（加入开机自启）；「选择 exe」用于已有安装；「卸载守护进程」可彻底移除。未连接时快捷键不生效。
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
