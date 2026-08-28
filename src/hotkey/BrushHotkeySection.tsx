import React, { useState, useEffect } from 'react';
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
    // 默认安装位置（install.ps1 会放到这里）
    return 'C:\\Users\\Administrator\\AppData\\Local\\JWautofill\\daemon\\JWautofillHotkeyDaemon.exe';
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
    if (!path) { setMessage('请先填写守护进程 exe 路径'); return; }
    const lower = path.toLowerCase();
    if (lower.endsWith('.ps1') || lower.endsWith('.bat')) {
      setMessage('这是安装脚本，请右键「使用 PowerShell 运行」或双击 install.bat 安装；安装后请把生成的 exe 路径填到这里');
      return;
    }
    try { localStorage.setItem('jwauto_daemon_path', path); } catch { /* ignore */ }
    if (launchDaemon(path)) setMessage('已尝试启动守护进程，请稍候…');
    else setMessage('启动失败：请确认 exe 路径正确，或先用 install.bat 安装');
  };

  const startRecord = () => {
    if (!selectedBrush) { setMessage('请先在上方选择一支笔刷'); return; }
    setMessage('请按下组合键…');
    setRecording(true);
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
    // 注意：不能用 once:true —— 组合键的第一个 keydown 往往是修饰键，需持续监听直到实体键
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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
              <sp-picker size="s" selects="single" selected={selectedBrush}
                onChange={(e: any) => setSelectedBrush(e.target.selected)}>
                <sp-menu>
                  {brushOptions.map(b => (
                    <sp-menu-item key={b} value={b} selected={b === selectedBrush}>{b}</sp-menu-item>
                  ))}
                </sp-menu>
              </sp-picker>
            ) : (
              <sp-textfield size="s" placeholder="输入笔刷预设名（需与 PS 完全一致）"
                value={selectedBrush} onInput={(e: any) => setSelectedBrush(e.target.value)} />
            )}
            <sp-action-button onClick={startRecord} disabled={recording}>
              {recording ? '按下组合键…' : '录制快捷键'}
            </sp-action-button>
          </div>

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
            <div style={rowStyle}>
              <sp-textfield size="s" placeholder="守护进程 exe 路径" value={daemonPath}
                onInput={(e: any) => setDaemonPath(e.target.value)} style={{ flex: 1 }} />
              <sp-action-button onClick={startDaemon}>启动</sp-action-button>
            </div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
              未连接时快捷键不生效。双击项目里的 install.bat（或右键 install.ps1「使用 PowerShell 运行」）可自动编译并安装 exe，再把它填到这里点「启动」；也可由安装器加入开机自启。
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
