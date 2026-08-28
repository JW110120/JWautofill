import React, { useState, useEffect, useRef } from 'react';
import { storage, shell } from 'uxp';
import { HotkeyEntry, connectHotkeyDaemon, onConfig, enumerateBrushes, onDaemonStatus, launchDaemon, pushConfig, requestHotkeyRecording, cancelHotkeyRecording } from './HotkeyBridge';
import { ExpandIcon, DeleteIcon } from '../styles/Icons';

// 笔刷热键分区：在调整面板内录制「笔刷 + 快捷键」，持久化到共享配置，
// 由本地守护进程在全局捕获按键后直接切换笔刷（仿 Brusherator，不录制动作）。
// 注意：组合键的「录制」由 native 守护进程用 Windows 全局键盘钩子完成，
// UXP 面板只负责选笔刷 + 发指令 + 等结果；面板本身无法稳定捕获键盘事件。
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

  // 按钮 2：彻底卸载 install.ps1 写入的所有内容（仅本插件内容，绝不误删用户其他文件）。
  // 反馈策略：唤起卸载程序后轮询连接状态——卸载脚本第一步就会停掉守护进程，
  // 因此「已连接 → 未连接」即可判定卸载成功；超时未断开则提示用户去弹窗确认。
  const uninstallDaemon = async () => {
    const wasConnected = daemonConnectedRef.current;
    const ok = await openBundled('native/HotkeyDaemon/uninstall.bat');
    if (!ok) { setMessage('卸载失败：无法唤起卸载程序，请手动双击插件目录 native/HotkeyDaemon/uninstall.bat'); return; }
    if (!wasConnected) {
      setMessage('卸载程序已打开：请在弹出的窗口中按提示完成卸载');
      return;
    }
    setMessage('正在卸载…（卸载完成后守护进程会停止）');
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (!daemonConnectedRef.current) { setMessage('卸载完成 ✓（守护进程已停止、开机自启与安装目录已移除）'); return; }
    }
    setMessage('尚未检测到卸载完成：请在弹出的卸载窗口中确认操作（完成后状态会变为「未连接」）');
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

  // 录制由 native 守护进程完成（Windows 全局键盘钩子），UXP 只发指令并等待结果。
  const startRecord = async () => {
    if (!selectedBrush) { setMessage('请先在上方选择一支笔刷'); return; }
    if (!daemonConnected) { setMessage('守护进程未连接，无法录制（请先安装并启用守护进程）'); return; }
    setRecording(true);
    setMessage('正在录制… 请在任意位置按下组合键（按 Esc 取消）');
    const res = await requestHotkeyRecording(selectedBrush);
    setRecording(false);
    if (!res) { setMessage('已取消录制'); return; }
    const combo = res.combo;
    if (entries.some(x => x.combo === combo)) setMessage('该组合键已存在，已覆盖旧映射');
    const entry: HotkeyEntry = { id: 'bk_' + Date.now(), combo, action: 'applyBrush', brush: selectedBrush };
    const next = [...entries.filter(x => x.combo !== combo), entry];
    setEntries(next);
    if (pushConfig(next)) setMessage('已保存：' + combo + ' → ' + selectedBrush);
    else setMessage('推送配置失败（守护进程未运行？）');
  };

  // 用户主动取消当前录制
  const cancelRecord = () => {
    cancelHotkeyRecording();
    setRecording(false);
    setMessage('已取消录制');
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
            选中一支笔刷 → 点「录制」→ 在任意位置按下组合键（由守护进程全局键盘钩子捕获，无需面板聚焦）。录制成功后守护进程会在全局触发并直接切换该笔刷。
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
              {recording ? '录制中…' : '录制快捷键'}
            </sp-action-button>
            {recording && <sp-action-button onClick={cancelRecord}>取消</sp-action-button>}
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
                {/* 快捷键列定宽：不同长度的组合键不再把笔刷名挤得不对齐 */}
                <span style={{ fontWeight: 500, width: 110, flexShrink: 0 }}>{e.combo}</span>
                <span style={{ opacity: 0.8, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.action === 'applyBrush' ? e.brush : '总开关'}
                </span>
                <sp-action-button quiet onClick={() => removeEntry(e.id)} title="删除此快捷键">
                  <DeleteIcon style={{ width: '15px', height: '15px', display: 'block' }} />
                </sp-action-button>
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
