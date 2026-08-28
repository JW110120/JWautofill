import React, { useState, useEffect, useRef } from 'react';
import { storage, shell } from 'uxp';
import { HotkeyEntry, connectHotkeyDaemon, onConfig, enumerateBrushes, onDaemonStatus, launchDaemon, pushConfig } from './HotkeyBridge';
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
  // 守护进程预期安装路径（仅内部用于自动启用，不在面板上展示给用户）
  const [daemonPath, setDaemonPath] = useState<string>(() => {
    try {
      const la = (globalThis as any).process?.env?.LOCALAPPDATA;
      if (la) return la + '\\JWautofill\\daemon\\JWautofillHotkeyDaemon.exe';
    } catch { /* ignore */ }
    return '';
  });

  // refs：供自动启用轮询读取最新值，避免闭包拿到旧值
  const daemonConnectedRef = useRef(daemonConnected);
  const daemonPathRef = useRef(daemonPath);
  const recordInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { daemonConnectedRef.current = daemonConnected; }, [daemonConnected]);
  useEffect(() => { daemonPathRef.current = daemonPath; }, [daemonPath]);

  useEffect(() => {
    const unsub = connectHotkeyDaemon();
    onConfig((list)  => setEntries(list));
    onDaemonStatus(setDaemonConnected);
    enumerateBrushes().then((b) => { setBrushes(b); setUsePicker(b.length > 0); }).catch(() => {
      setBrushes([]); setUsePicker(false);
    });
    return unsub;
  }, []);

  // 录制期把焦点放到隐藏输入框：UXP 只在「面板持有键盘焦点」时才会派发 keydown，
  // 之前用 document.activeElement.blur() 把焦点整个丢掉，导致按键全跑去了 Photoshop。
  useEffect(() => {
    if (!recording) return;
    const el = recordInputRef.current;
    if (el) { try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { /* ignore */ } } }
    return () => {
      if (el && typeof el.blur === 'function') { try { el.blur(); } catch { /* ignore */ } }
    };
  }, [recording]);

  // 将插件内相对路径解析为真实 OS 路径：用 getPluginFolder().nativePath，
  // 绕开沙箱下 getEntry('native') 找不到目录的问题。
  const getBundledNativePath = async (relPath: string): Promise<string | null> => {
    const folder: any = await storage.localFileSystem.getPluginFolder();
    const root: string = folder?.nativePath;
    if (!root) return null;
    const sep = root.includes('\\') ? '\\' : '/';
    const parts = relPath.split('/').filter(Boolean);
    return [root, ...parts].join(sep);
  };

  // 用 shell.openPath 唤起插件目录内的某个文件（exe/bat）。成功返回空串，失败返回错误串。
  const openBundled = async (relPath: string): Promise<boolean> => {
    const full = await getBundledNativePath(relPath);
    if (!full) {
      setMessage('无法定位插件目录，请手动在插件目录 ' + relPath + ' 处双击运行');
      return false;
    }
    const r: any = await shell.openPath(full);
    if (typeof r === 'string' && r.length > 0) {
      setMessage('唤起失败：' + r + '（可手动双击插件目录下的 ' + relPath.split('/').pop() + '）');
      return false;
    }
    return true;
  };

  // 按钮 1：选择 install.bat -> 运行 -> 安装完成后自动启用守护进程
  const installDaemon = async () => {
    try {
      const file: any = await storage.localFileSystem.getFileForOpening({ types: ['bat'] });
      if (!file) return; // 用户取消
      const files: any[] = Array.isArray(file) ? file : [file];
      const f: any = files[0];
      const p: string = f?.nativePath || '';
      if (!p) { setMessage('无法读取所选文件路径'); return; }
      const name = p.toLowerCase().split(/[\\/]/).pop() || '';
      if (name.includes('uninstall')) { setMessage('这看起来是卸载脚本，请选择 install.bat'); return; }
      if (!name.endsWith('.bat')) { setMessage('请选择 install.bat 安装脚本'); return; }
      const r: any = await shell.openPath(p);
      if (typeof r === 'string' && r.length > 0) { setMessage('启动安装脚本失败：' + r); return; }
      setMessage('安装已开始，完成后守护进程会自动启用（最多等待约 40 秒）…');
      autoEnableDaemon();
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : (typeof e === 'string' ? e : JSON.stringify(e));
      setMessage('安装失败：' + msg);
    }
  };

  // 按钮 2：彻底卸载 install.ps1 写入的所有内容（仅本插件内容，绝不误删用户其他文件）
  const uninstallDaemon = async () => {
    if (await openBundled('native/HotkeyDaemon/uninstall.bat')) {
      setMessage('已唤起卸载程序，请按窗口提示完成卸载');
    }
  };

  // 安装脚本自身会在末尾启动守护进程；这里做兜底：未连接就周期尝试启动，连上即停（避免重复拉起实例）。
  const autoEnableDaemon = () => {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (daemonConnectedRef.current) { clearInterval(timer); setMessage('守护进程已连接 ✓'); return; }
      if (tries > 10) { clearInterval(timer); setMessage('守护进程未自动连接，可重开插件或检查安装日志'); return; }
      const p = daemonPathRef.current;
      if (p) launchDaemon(p);
    }, 4000);
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
    // 注意：这里【不要】 blur，否则会丢掉面板键盘焦点导致录制收不到按键。
    // 焦点改由录制期的隐藏输入框承接（见下方 useEffect）。
    setMessage('请按下组合键…（按 Esc 取消）');
    setRecording(true);
  };

  // 隐藏输入框的 keydown：录制时面板焦点在此输入框，keydown 稳定派发到这里
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!recording) return;
    const k = e.key;
    // 纯修饰键只用于组合，不能作为触发键，继续等待实体键
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) { e.preventDefault(); return; }
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

          {/* 录制用的隐藏输入框：仅在录制期被聚焦，承接面板键盘焦点 */}
          <input
            ref={recordInputRef}
            onKeyDown={onKey}
            aria-hidden="true"
            tabIndex={-1}
            style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0, overflow: 'hidden', pointerEvents: 'none' }}
          />

          <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              守护进程状态：
              <b style={{ color: daemonConnected ? '#4CAF50' : '#E53935' }}>
                {daemonConnected ? ' 已连接' : ' 未连接'}
              </b>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <sp-action-button onClick={installDaemon}>安装守护进程</sp-action-button>
              <sp-action-button onClick={uninstallDaemon}>卸载守护进程</sp-action-button>
            </div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
              点「安装守护进程」选择 install.bat 完成安装并自动启用；「卸载守护进程」会彻底移除本插件写入的内容（仅清理自身，不影响其他文件）。未连接时快捷键不生效。
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
