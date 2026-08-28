import React, { useState, useEffect } from 'react';
import { HotkeyEntry, connectHotkeyDaemon, onConfig, pushConfig, enumerateBrushes } from './HotkeyBridge';
import { ExpandIcon } from '../styles/Icons';

// 笔刷热键分区：在调整面板内录制「笔刷 + 快捷键」，持久化到共享配置，
// 由本地守护进程在全局捕获按键后直接切换笔刷（仿 Brusherator，不录制动作）。
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 };
const itemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '6px 8px', marginTop: 6, borderRadius: 6,
  background: 'rgba(255,255,255,0.06)', fontSize: 12
};

export default function BrushHotkeySection() {
  const [collapsed, setCollapsed] = useState(false);
  const [brushes, setBrushes] = useState<string[]>([]);
  const [entries, setEntries] = useState<HotkeyEntry[]>([]);
  const [selectedBrush, setSelectedBrush] = useState('');
  const [usePicker, setUsePicker] = useState(true);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const unsub = connectHotkeyDaemon();
    onConfig((list) => setEntries(list));
    enumerateBrushes().then((b) => { setBrushes(b); setUsePicker(b.length > 0); }).catch(() => {
      setBrushes([]); setUsePicker(false);
    });
    return unsub;
  }, []);

  const startRecord = () => {
    if (!selectedBrush) { setMessage('请先在上方选择一支笔刷'); return; }
    setMessage('请按下组合键…');
    setRecording(true);
  };

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      if (e.metaKey) parts.push('Win');
      let key = e.key;
      if (key === ' ') key = 'Space';
      else if (key.length === 1) key = key.toUpperCase();
      else if (/^F\d+$/.test(key)) { /* F1..F24 直接保留 */ }
      else if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return; // 仅修饰键不作为触发码
      parts.push(key);
      const combo = parts.join('+');
      // 冲突检测
      if (entries.some(x => x.combo === combo)) {
        setMessage('该组合键已存在，已覆盖旧映射');
      }
      const entry: HotkeyEntry = { id: 'bk_' + Date.now(), combo, action: 'applyBrush', brush: selectedBrush };
      const next = [...entries.filter(x => x.combo !== combo), entry];
      setEntries(next);
      if (pushConfig(next)) setMessage('已保存：' + combo + ' → ' + selectedBrush);
      else setMessage('推送配置失败（守护进程未运行？）');
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, { once: true, capture: true } as any);
    return () => window.removeEventListener('keydown', onKey, { once: true, capture: true } as any);
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
        </div>
      )}
    </div>
  );
}
