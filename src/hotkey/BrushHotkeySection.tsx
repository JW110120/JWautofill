import React, { useState, useEffect, useRef, useCallback } from 'react';
import { storage, shell } from 'uxp';
import {
  HotkeyEntry, connectHotkeyDaemon, onConfig, enumerateBrushes, enumerateBrushTypes,
  onDaemonStatus, pushConfig, requestHotkeyRecording, cancelHotkeyRecording,
  onHotkeyTriggered, disconnectDaemon, registerUninstallHandler,
  setMainToggleCombo, getMainToggleCombo
} from './HotkeyBridge';
import { ExpandIcon, DeleteIcon, RefreshIcon, RecordCircleIcon, StopSquareIcon } from '../styles/Icons';
import BrushSelect, { BrushSelectOption } from './BrushSelect';

// 笔刷热键分区：在调整面板内录制「笔刷 + 快捷键」，持久化到共享配置，
// 由本地守护进程在全局捕获按键后直接切换笔刷（仿 Brusherator，不录制动作）。
// 注意：组合键的「录制」由 native 守护进程用 Windows 全局键盘钩子完成，
// UXP 面板只负责选笔刷 + 发指令 + 等结果；面板本身无法稳定捕获键盘事件。
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', marginTop: 8 };

// 通知自动消失时间：提示是「瞬时反馈」而非常驻说明，5 秒足够读完，
// 也避免下一次操作后还挂着上一条早已过期的提示（例如刷新完笔刷还显示"请选择"）。
const MESSAGE_TTL_MS = 5000;

export default function BrushHotkeySection() {
  const [collapsed, setCollapsed] = useState(false);
  const [brushes, setBrushes] = useState<string[]>([]);
  const [brushTypes, setBrushTypes] = useState<Record<string, string>>({});
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

  // 通知：统一走这里，5 秒后自动清空。有新通知时重置计时，
  // 保证用户看到的永远是「最近一条操作」的结果。
  const msgTimerRef = useRef<any>(null);
  const showMessage = useCallback((text: string) => {
    if (msgTimerRef.current) { clearTimeout(msgTimerRef.current); msgTimerRef.current = null; }
    setMessage(text);
    if (text) msgTimerRef.current = setTimeout(() => { setMessage(''); msgTimerRef.current = null; }, MESSAGE_TTL_MS);
  }, []);
  useEffect(() => () => { if (msgTimerRef.current) clearTimeout(msgTimerRef.current); }, []);

  useEffect(() => {
    const unsub = connectHotkeyDaemon();
    const unsubConfig = onConfig((list)  => setEntries(list));
    const unsubStatus = onDaemonStatus(setDaemonConnected);
    // 热键触发即时反馈：用户按快捷键后面板直接显示是否命中、切换是否成功
    // （这是诊断「按了快捷键没反应」的关键观测点：无任何显示 = 事件根本没到达面板）
    const unsubHotkey = onHotkeyTriggered((info) => {
      if (info.action === 'applyBrush') {
        showMessage(info.ok
          ? ('热键触发：' + (info.combo ? info.combo + ' → ' : '') + '已切换笔刷「' + info.brush + '」')
          : ('热键触发失败：' + (info.combo ? info.combo + ' → ' : '') + '切换笔刷「' + info.brush + '」失败，请检查笔刷名是否与 Brushes 面板完全一致'));
      } else if (info.action === 'toggleMain') {
        showMessage('热键触发：' + (info.combo ? info.combo + ' → ' : '') + '已切换选区填充开关');
      }
    });
    void loadBrushes(false);
    return () => { unsub(); unsubConfig(); unsubStatus(); unsubHotkey(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重新枚举笔刷列表。notify=false 用于初始化静默加载（不弹通知）。
  const loadBrushes = async (notify: boolean) => {
    if (notify) showMessage('正在刷新笔刷列表…');
    try {
      const [names, types] = await Promise.all([enumerateBrushes(), enumerateBrushTypes()]);
      setBrushes(names);
      setBrushTypes(types);
      setUsePicker(names.length > 0);
      // 只陈述结果，不再附加「请选择」这类会被下一次操作立刻推翻的引导语
      if (notify) {
        showMessage(names.length
          ? ('已刷新笔刷列表，共 ' + names.length + ' 支')
          : '仍未枚举到笔刷，已切换为手动输入');
      }
    } catch {
      setBrushes([]); setUsePicker(false);
      if (notify) showMessage('枚举笔刷失败，可手动输入笔刷名（需与 PS 完全一致）');
    }
  };

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
      showMessage('无法定位插件目录，请手动在插件目录 ' + relPath + ' 处双击运行');
      return false;
    }
    const r: any = await shell.openPath(full);
    if (typeof r === 'string' && r.length > 0) {
      showMessage('唤起失败：' + r + '（可手动双击插件目录下的 ' + relPath.split('/').pop() + '）');
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
        showMessage('加载失败：未找到安装脚本，请手动双击插件目录 native/HotkeyDaemon/install.bat');
        return;
      }
      showMessage('正在加载守护进程…');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (daemonConnectedRef.current) { showMessage('守护进程已就绪'); return; }
      }
      showMessage('未检测到守护进程：请在弹出的窗口中查看提示（加载失败时窗口不会自动关闭）');
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : (typeof e === 'string' ? e : JSON.stringify(e));
      showMessage('加载守护进程失败：' + msg + '（可手动双击插件目录 native/HotkeyDaemon/install.bat）');
    } finally {
      setBusy(false);
    }
  };

  // 「断开守护进程」：让守护进程自己优雅退出。
  // 这是卸载前必须的准备动作——卸载脚本要删安装目录，而运行中的 exe 会锁住目录里的日志文件。
  const stopDaemon = async () => {
    if (busy) return;
    if (!disconnectDaemon()) { showMessage('当前未连接到守护进程，无需断开'); return; }
    setBusy(true);
    showMessage('正在断开守护进程…');
    try {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!daemonConnectedRef.current) { showMessage('守护进程已断开（快捷键已停止生效，此时可安全卸载）'); return; }
      }
      showMessage('守护进程无响应，请稍后重试；若仍无法断开，请重启电脑后再卸载。');
    } finally {
      setBusy(false);
    }
  };

  // 卸载：低频操作，入口在面板右上角菜单里（见 MenuManager / AdjustmentMenu）。
  // 流程：先断连（保证 exe 不再占用文件）→ 运行卸载脚本 → 轮询确认。
  const uninstallDaemon = async (): Promise<string> => {
    setCollapsed(false);
    if (daemonConnectedRef.current) {
      showMessage('正在先断开守护进程…');
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
      showMessage(ret);
      return ret;
    }
    showMessage('卸载程序已打开：成功时窗口会倒计时自动关闭，失败时会保留在屏幕上。');
    return '卸载程序已打开，请在弹出的窗口中查看结果。';
  };

  // 供右上角菜单调用（菜单回调注册在 AdjustmentPanel 里，具体实现留在本组件）
  useEffect(() => {
    registerUninstallHandler(uninstallDaemon);
  }, []);

  // 录制由 native 守护进程完成（Windows 全局键盘钩子），UXP 只发指令并等待结果。
  const startRecord = async () => {
    if (!selectedBrush) { showMessage('请先在左侧选择一支笔刷'); return; }
    if (!daemonConnected) { showMessage('守护进程未连接，无法录制（请先加载守护进程）'); return; }
    const mainCombo = getMainToggleCombo();
    setRecording(true);
    showMessage('正在录制：请在任意位置按下要绑定的组合键，Esc 取消');
    const res = await requestHotkeyRecording(selectedBrush);
    setRecording(false);
    if (!res) { showMessage('已取消录制'); return; }
    const combo = res.combo;
    if (mainCombo && combo === mainCombo) {
      showMessage('该组合键已被选区填充开关占用，请换一个');
      return;
    }
    const entry: HotkeyEntry = { id: 'bk_' + Date.now(), combo, action: 'applyBrush', brush: selectedBrush };
    // 覆盖同组合键的旧映射，但主开关条目必须原样保留（它不参与笔刷热键的覆盖）
    const next = [...entries.filter(x => x.action === 'toggleMain' || x.combo !== combo), entry];
    setEntries(next);
    if (pushConfig(next)) showMessage('已保存：' + combo + ' → ' + selectedBrush);
    else showMessage('推送配置失败（守护进程未运行？）');
  };

  // 用户主动取消当前录制
  const cancelRecord = () => {
    cancelHotkeyRecording();
    setRecording(false);
    showMessage('已取消录制');
  };

  const removeEntry = (id: string) => {
    const target = entries.find(e => e.id === id);
    if (!target) return;
    if (target.action === 'toggleMain') {
      // 主开关不真正删除，改为「解绑」（combo 置空并落盘），
      // 这样下次打开插件不会又把默认的 Ctrl+Q 补回来；需要时可到主面板菜单重新指定。
      setMainToggleCombo('');
      showMessage('已解绑选区填充开关快捷键，可在主面板菜单「设置主开关快捷键」重新指定');
      return;
    }
    const next = entries.filter(e => e.id !== id);
    setEntries(next);
    pushConfig(next);
  };

  const brushOptions: BrushSelectOption[] = brushes.map(b => ({
    value: b,
    main: b,
    // 笔刷类型（混合器/涂抹…）尽力而为：取不到时该项为空，下拉不显示类型列
    tag: brushTypes[b] || ''
  }));

  return (
    <div className="adjust-expand-section">
      <div className="adjust-expand-header" onClick={() => setCollapsed(c => !c)}
           title="通过本地守护进程实现全局快捷键，直接在画布上按快捷键切换笔刷（无需录制动作）。">
        <div className={`adjust-expand-icon ${collapsed ? '' : 'expanded'}`}>
          <ExpandIcon expanded={!collapsed} />
        </div>
        <div>笔刷热键</div>
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
            <div
              role="button"
              tabIndex={0}
              className={`adjustment-button auto compact${busy ? ' disabled' : ''}`}
              title={daemonConnected
                ? '让守护进程退出。卸载插件前必须先断开，否则安装目录里的文件被占用删不掉'
                : '安装并启动随插件分发的守护进程（默认的选区填充开关 Ctrl+Q 也由它驱动）'}
              onClick={(e) => {
                e.stopPropagation(); // 避免冒泡到分区头部触发折叠
                if (!busy) { if (daemonConnected) void stopDaemon(); else void loadDaemon(); }
              }}
            >
              {daemonConnected ? '断开守护进程' : '加载守护进程'}
            </div>
          </div>

          <div style={rowStyle}>
            {usePicker ? (
              <>
                <BrushSelect
                  value={selectedBrush}
                  options={brushOptions}
                  onChange={setSelectedBrush}
                  placeholder="选择笔刷"
                  title="选择要绑定快捷键的笔刷预设（名称需与 Brushes 面板一致）"
                  style={{ flex: '0 1 200px', minWidth: 0 }}
                />
                {/* 亲密性：刷新紧贴下拉（4px），下拉宽度受约束不再撑满整行，
                    录制圆形 icon 用 marginLeft:auto 推到最右，二者之间自然拉开距离 */}
                <div
                  className="hotkey-icon-button"
                  style={{ marginLeft: 4 }}
                  onClick={() => void loadBrushes(true)}
                  title="刷新笔刷列表"
                >
                  <RefreshIcon style={{ width: 14, height: 14, display: 'block' }} />
                </div>
              </>
            ) : (
              <sp-textfield size="s" placeholder="输入笔刷预设名（需与 PS 完全一致）" style={{ flex: '1 1 auto', minWidth: 0 }}
                value={selectedBrush} onInput={(e: any) => setSelectedBrush(e.target.value)} />
            )}
            {/* 录制键 + 停止键作为一个整体推到最右，二者紧挨（停止键 marginLeft:4）；
                刷新按钮始终在左侧下拉旁，与右侧录制/停止键组保持间距 */}
            <div style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto' }}>
              <div
                role="button"
                tabIndex={0}
                className={`hotkey-circle-button${recording ? ' recording' : ''}${!selectedBrush ? ' disabled' : ''}`}
                title={
                  '选中一支笔刷后点这个圆点，然后在任意位置按下要绑定的组合键即可。\n' +
                  '可绑定的键：字母 A-Z、数字 0-9、F1-F24，以及 ; \' , . / - = ` [ ] \\ 等符号键，\n' +
                  '还有方向键 / 空格 / 回车 / 退格 / Tab / Insert / Delete / Home / End / PageUp / PageDown\n' +
                  '以及小键盘 Num0-Num9。录制由守护进程的全局键盘钩子完成，无需面板获得焦点。\n' +
                  '录制中按 Esc 取消。'
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (!recording && selectedBrush) void startRecord();
                }}
              >
                <RecordCircleIcon style={{ width: 16, height: 16, display: 'block' }} />
              </div>
              {recording && (
                <div
                  role="button"
                  tabIndex={0}
                  className="hotkey-circle-button"
                  style={{ marginLeft: 4 }}
                  title="放弃本次录制（等同于在录制过程中按 Esc）"
                  onClick={(e) => { e.stopPropagation(); cancelRecord(); }}
                >
                  <StopSquareIcon style={{ width: 16, height: 16, display: 'block' }} />
                </div>
              )}
            </div>
          </div>
          {!usePicker && (
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
              未能自动枚举笔刷，已切换为手动输入；点「录制快捷键」前请先填好笔刷名（需与 PS 完全一致）。
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            {entries.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>尚未绑定任何快捷键</div>}
            {entries.map(e => {
              const isMainToggle = e.action === 'toggleMain';
              // 选区填充开关解绑（combo 为空）时，右侧删除图标禁用
              const delDisabled = isMainToggle && !e.combo;
              return (
                <div key={e.id} className="hotkey-entry-row">
                  {/* 快捷键列定宽：不同长度的组合键不再把名称挤得不对齐；分隔线因此跨条目对齐 */}
                  <span className="hotkey-entry-combo">{e.combo || '未绑定'}</span>
                  <span className="hotkey-entry-sep">丨</span>
                  <span className="hotkey-entry-name">
                    {isMainToggle ? '选区填充开关' : e.brush}
                  </span>
                  <span className="hotkey-entry-sep">丨</span>
                  <div
                    className={`hotkey-icon-button hotkey-entry-del${delDisabled ? ' disabled' : ''}`}
                    title={isMainToggle ? (delDisabled ? '选区填充开关已解绑' : '解绑选区填充开关快捷键') : '删除此快捷键'}
                    onClick={() => { if (!delDisabled) removeEntry(e.id); }}
                  >
                    <DeleteIcon style={{ width: 13, height: 13, display: 'block' }} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* 底部说明文字：颜色随守护进程状态变化（已连接=绿，断开=红），不再恒为绿色 */}
          {message && (
            <div style={{ fontSize: 12, color: daemonConnected ? '#4CAF50' : '#ef5350', marginTop: 8 }}>
              {message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
