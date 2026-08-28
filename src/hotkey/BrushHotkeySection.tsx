import React, { useState, useEffect, useRef } from 'react';
import { storage, shell } from 'uxp';
import { HotkeyEntry, connectHotkeyDaemon, onConfig, enumerateBrushes, onDaemonStatus, pushConfig, requestHotkeyRecording, cancelHotkeyRecording, onHotkeyTriggered, disconnectDaemon, registerUninstallHandler } from './HotkeyBridge';
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
  const [busy, setBusy] = useState(false);
  const [daemonConnected, setDaemonConnected] = useState(false);

  // refs：供轮询读取最新值，避免闭包拿到旧值
  const daemonConnectedRef = useRef(daemonConnected);
  useEffect(() => { daemonConnectedRef.current = daemonConnected; }, [daemonConnected]);

  useEffect(() => {
    const unsub = connectHotkeyDaemon();
    const unsubConfig = onConfig((list)  => setEntries(list));
    const unsubStatus = onDaemonStatus(setDaemonConnected);
    // 热键触发即时反馈：用户按快捷键后面板直接显示是否命中、切换是否成功
    // （这是诊断「按了快捷键没反应」的关键观测点：无任何显示 = 事件根本没到达面板）
    const unsubHotkey = onHotkeyTriggered((info) => {
      if (info.action === 'applyBrush') {
        setMessage(info.ok
          ? ('热键触发 ✓ ' + (info.combo ? info.combo + ' → ' : '') + '已切换笔刷「' + info.brush + '」')
          : ('热键触发 ✗ ' + (info.combo ? info.combo + ' → ' : '') + '切换笔刷「' + info.brush + '」失败（检查笔刷名是否与 Brushes 面板完全一致）'));
      }
    });
    enumerateBrushes().then((b) => { setBrushes(b); setUsePicker(b.length > 0); }).catch(() => {
      setBrushes([]); setUsePicker(false);
    });
    return () => { unsub(); unsubConfig(); unsubStatus(); unsubHotkey(); };
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

  // 「加载守护进程」：脚本已随插件分发在固定位置，直接静默运行，不再弹文件选择框。
  // 安装成功的窗口会 5 秒倒计时自动关闭，所以这里通常不会打扰用户。
  const loadDaemon = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await openBundled('native/HotkeyDaemon/install.bat');
      if (!ok) {
        setMessage('加载失败：未找到安装脚本，请手动双击插件目录 native/HotkeyDaemon/install.bat');
        return;
      }
      setMessage('正在加载守护进程…');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (daemonConnectedRef.current) { setMessage('守护进程已就绪 ✓'); return; }
      }
      setMessage('未检测到守护进程：请在弹出的窗口中查看提示（加载失败时窗口不会自动关闭）');
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : (typeof e === 'string' ? e : JSON.stringify(e));
      setMessage('加载守护进程失败：' + msg + '（可手动双击插件目录 native/HotkeyDaemon/install.bat）');
    } finally {
      setBusy(false);
    }
  };

  // 「断开守护进程」：让守护进程自己优雅退出。
  // 这是卸载前必须的准备动作——卸载脚本要删安装目录，而运行中的 exe 会锁住目录里的日志文件。
  const stopDaemon = async () => {
    if (busy) return;
    if (!disconnectDaemon()) { setMessage('当前未连接到守护进程，无需断开'); return; }
    setBusy(true);
    setMessage('正在断开守护进程…');
    try {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!daemonConnectedRef.current) { setMessage('守护进程已断开 ✓（快捷键已停止生效，此时可安全卸载）'); return; }
      }
      setMessage('守护进程无响应，请稍后重试；若仍无法断开，请重启电脑后再卸载。');
    } finally {
      setBusy(false);
    }
  };

  // 卸载：低频操作，入口在面板右上角菜单里（见 MenuManager / AdjustmentMenu）。
  // 流程：先断连（保证 exe 不再占用文件）→ 运行卸载脚本 → 轮询确认。
  const uninstallDaemon = async (): Promise<string> => {
    setCollapsed(false);
    if (daemonConnectedRef.current) {
      setMessage('正在先断开守护进程…');
      disconnectDaemon();
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!daemonConnectedRef.current) break;
      }
    }
    let ok = false;
    try { ok = await openBundled('native/HotkeyDaemon/uninstall.bat'); } catch (err: any) {
      console.error('唤起内置卸载程序失败:', err);
    }
    if (!ok) {
      const ret = '插件目录内未找到卸载脚本，请手动双击 native/HotkeyDaemon/uninstall.bat';
      setMessage(ret);
      return ret;
    }
    setMessage('卸载程序已打开：成功时窗口会倒计时自动关闭，失败时会保留在屏幕上。');
    return '卸载程序已打开，请在弹出的窗口中查看结果。';
  };

  // 供右上角菜单调用（菜单回调注册在 AdjustmentPanel 里，具体实现留在本组件）
  useEffect(() => {
    registerUninstallHandler(uninstallDaemon);
  }, []);

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
          {/* 守护进程状态条：与「蒙版同步」的引擎状态条同一套视觉，左侧状态点+文字，右侧操作按钮 */}
          <div className="mask-sync-status-bar">
            <span className={`mask-sync-status-dot ${daemonConnected ? 'ok' : 'warn'}`} />
            <span className="mask-sync-status-ready">
              {daemonConnected ? '守护进程就绪' : (busy ? '守护进程处理中…' : '守护进程未加载')}
            </span>
            <span style={{ flex: 1 }} />
            <sp-action-button size="s" onClick={daemonConnected ? stopDaemon : loadDaemon} disabled={busy}>
              {daemonConnected ? '断开守护进程' : '加载守护进程'}
            </sp-action-button>
          </div>
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
        </div>
      )}
    </div>
  );
}
