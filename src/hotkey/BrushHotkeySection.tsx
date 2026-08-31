import React, { useState, useEffect, useRef, useCallback } from 'react';
import { storage, shell } from 'uxp';
import {
  HotkeyEntry, connectHotkeyDaemon, onConfig, enumerateBrushes,
  onDaemonStatus, pushConfig, requestHotkeyRecording, cancelHotkeyRecording,
  onHotkeyTriggered, disconnectDaemon, sendDaemonCommand, registerUninstallHandler,
  setMainToggleCombo, getMainToggleCombo,
  detectAllBrushTypes
} from './HotkeyBridge';
import { ExpandIcon, DeleteIcon, RefreshIcon, DataRefreshIcon, RecordCircleIcon, StopSquareIcon, BrushToolIcon, SmudgeToolIcon, MixerToolIcon } from '../styles/Icons';
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
  // 已录快捷键的选中集合：单击单选，Ctrl/Shift + 单击加选或减选，用于单个/批量删除
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 多选锚点（shift 延伸的基准）：普通单击或 Ctrl 单击后更新为该条索引
  const anchorIndexRef = useRef<number>(-1);

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
        // 提示必须反映共享总线的真实结果：以前无条件显示「已切换」，
        // 实际上回调在另一个面板上下文里是 null，什么都没切换，误导性极强。
        showMessage('热键触发：' + (info.combo ? info.combo + ' → ' : '') + (info.enabled === undefined
          ? '选区填充开关切换失败'
          : ('选区填充开关已' + (info.enabled ? '开启' : '关闭'))));
      }
    });
    void loadBrushes(false);
    return () => { unsub(); unsubConfig(); unsubStatus(); unsubHotkey(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重新枚举笔刷列表 + 自动检测每支预设的类型（混合器/涂抹/画笔…）。
  // detectAllBrushTypes 会短暂切换当前笔刷并自动还原；纯画笔笔尖预设不暴露类型会标「画笔」。
  // notify=false 用于初始化静默加载（不弹通知）。
  const loadBrushes = async (notify: boolean) => {
    if (notify) showMessage('正在刷新笔刷列表…');
    try {
      const names = await enumerateBrushes();
      setBrushes(names);
      setUsePicker(names.length > 0);
      if (names.length) {
        const types = await detectAllBrushTypes();
        setBrushTypes(types);
      } else {
        setBrushTypes({});
      }
      // 只陈述结果，不再附加「请选择」这类会被下一次操作立刻推翻的引导语
      if (notify) {
        showMessage(names.length
          ? ('已刷新笔刷列表，共 ' + names.length + ' 支（已自动检测类型）')
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

  // 「加载守护进程」：直接静默拉起守护进程 exe（已编译为 Windows GUI 子系统，无控制台窗口）。
  // 守护进程自身完成「拷贝到安装目录 + 注册开机自启」，全程无窗口；
  // 加载进度与结果一律走面板文字通知（下方 showMessage），不再弹任何 cmd/PowerShell 窗口。
  const loadDaemon = async () => {
    if (busy) return;
    if (daemonConnectedRef.current) { showMessage('快捷键服务已在运行'); return; }
    setBusy(true);
    try {
      const ok = await openBundled('native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe');
      if (!ok) {
        showMessage('启动失败：未找到快捷键服务，请手动双击插件目录 native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe');
        return;
      }
      showMessage('正在启动快捷键服务…');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (daemonConnectedRef.current) { showMessage('快捷键服务已就绪'); return; }
      }
      showMessage('未检测到快捷键服务：请稍后重试，或手动双击插件目录 native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe');
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : (typeof e === 'string' ? e : JSON.stringify(e));
      showMessage('启动快捷键服务失败：' + msg + '（可手动双击插件目录 native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe）');
    } finally {
      setBusy(false);
    }
  };

  // 「断开守护进程」：让守护进程自己优雅退出。
  // 这是卸载前必须的准备动作——卸载脚本要删安装目录，而运行中的 exe 会锁住目录里的日志文件。
  const stopDaemon = async () => {
    if (busy) return;
    if (!disconnectDaemon()) { showMessage('当前未连接到快捷键服务，无需停止'); return; }
    setBusy(true);
    showMessage('正在停止快捷键服务…');
    try {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!daemonConnectedRef.current) { showMessage('快捷键服务已停止（快捷键已停止生效，此时可安全卸载）'); return; }
      }
      showMessage('快捷键服务无响应，请稍后重试；若仍无法停止，请重启电脑后再卸载。');
    } finally {
      setBusy(false);
    }
  };

  // 卸载：低频操作，入口在面板右上角菜单里（见 MenuManager / AdjustmentMenu）。
  // 优先走静默通道：直接让守护进程自删（移除开机自启 + 删除安装目录 + 退出），无窗口；
  // 仅在未连接守护进程（无法发指令）时，才退回到会弹窗的脚本方式。
  const uninstallDaemon = async (): Promise<string> => {
    setCollapsed(false);
    if (daemonConnectedRef.current) {
      showMessage('正在卸载快捷键服务…');
      const sent = sendDaemonCommand('uninstall');
      if (sent) {
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (!daemonConnectedRef.current) {
            const ret = '已卸载快捷键服务：开机自启已移除，安装目录已删除。';
            showMessage(ret);
            return ret;
          }
        }
        const ret = '卸载指令已发送但快捷键服务未退出，请稍后重试，或手动删除安装目录。';
        showMessage(ret);
        return ret;
      }
      // 已连接却发指令失败：落到脚本兜底
    }
    showMessage('未连接到快捷键服务，改用脚本卸载…');
    let ok = false;
    try { ok = await openBundled('native/HotkeyDaemon/uninstall.bat'); } catch (err: any) {
      console.error('唤起内置卸载程序失败:', err);
    }
    if (!ok) {
      const ret = '插件目录内未找到卸载脚本，请手动双击 native/HotkeyDaemon/uninstall.bat';
      showMessage(ret);
      return ret;
    }
    showMessage('卸载程序已打开，请在弹出的窗口中查看结果。');
    return '卸载程序已打开，请在弹出的窗口中查看结果。';
  };

  // 供右上角菜单调用（菜单回调注册在 AdjustmentPanel 里，具体实现留在本组件）
  useEffect(() => {
    registerUninstallHandler(uninstallDaemon);
  }, []);

  // 录制由 native 守护进程完成（Windows 全局键盘钩子），UXP 只发指令并等待结果。
  const startRecord = async () => {
    if (!selectedBrush) { showMessage('请先在左侧选择一支笔刷'); return; }
    if (!daemonConnected) { showMessage('快捷键服务未连接，无法录制（请先启动快捷键服务）'); return; }
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
    else showMessage('推送配置失败（快捷键服务未运行？）');
  };

  // 用户主动取消当前录制
  const cancelRecord = () => {
    cancelHotkeyRecording();
    setRecording(false);
    showMessage('已取消录制');
  };

  // 多选逻辑对齐 PS 原生图层：
  // - 普通单击：仅选中该条，并把锚点设为它；
  // - Ctrl/Meta + 单击：在已选集合里对该单条加选/减选（toggle），并把锚点设为它；
  // - Shift + 单击：选中「锚点 ~ 当前」之间的所有记录（含两端），锚点保持不变以便继续延伸。
  const handleEntryClick = (id: string, ev: React.MouseEvent) => {
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0) return;
    if (ev.shiftKey && anchorIndexRef.current >= 0) {
      const a = anchorIndexRef.current;
      const [lo, hi] = a <= idx ? [a, idx] : [idx, a];
      setSelectedIds(entries.slice(lo, hi + 1).map(e => e.id));
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
      anchorIndexRef.current = idx;
      return;
    }
    setSelectedIds([id]);
    anchorIndexRef.current = idx;
  };

  // 重录选中单条：直接对该记录的笔刷（或选区填充开关）发起一次新的录制，
  // 无需回到上方下拉菜单重新选择。仅当恰好选中一条时可用。
  const reRecordEntry = async () => {
    if (selectedIds.length !== 1) return;
    const target = entries.find(e => e.id === selectedIds[0]);
    if (!target) return;
    if (!daemonConnected) { showMessage('快捷键服务未连接，无法录制（请先启动快捷键服务）'); return; }
    const isMain = target.action === 'toggleMain';
    setRecording(true);
    showMessage('正在重录：请按下新的组合键，Esc 取消');
    const res = await requestHotkeyRecording(isMain ? '__MAIN__' : target.brush);
    setRecording(false);
    if (!res) { showMessage('已取消录制'); return; }
    const combo = res.combo;
    // 冲突检查：新组合键是否被其它记录（含主开关）占用？占用则提示并放弃本次重录
    const dup = entries.find(e => e.id !== target.id && e.combo === combo);
    if (dup) {
      showMessage('该组合键已被「' + (dup.action === 'toggleMain' ? '选区填充开关' : dup.brush) + '」占用，请换一个');
      return;
    }
    if (isMain) {
      setMainToggleCombo(combo);
      showMessage('已重录选区填充开关：' + combo);
    } else {
      const next = entries.map(e => (e.id === target.id ? { ...e, combo } : e));
      setEntries(next);
      if (pushConfig(next)) showMessage('已重录：' + combo + ' → ' + target.brush);
      else showMessage('推送配置失败（快捷键服务未运行？）');
    }
  };

  // 条目被删除/解绑/守护进程回灌配置后，剔除已不存在的选中项，避免选中数虚高
  useEffect(() => {
    setSelectedIds(prev => {
      const next = prev.filter(id => entries.some(e => e.id === id));
      return next.length === prev.length ? prev : next; // 无变化则返回原引用，避免无谓重渲染
    });
  }, [entries]);

  // 选中项里真正"可处理"的条数：笔刷条目可删除；
  // 选区填充开关只能解绑不能删除，且已解绑（combo 为空）时不可再操作
  const deletableCount = selectedIds.filter(id => {
    const e = entries.find(x => x.id === id);
    return !!e && (e.action !== 'toggleMain' || !!e.combo);
  }).length;

  // 批量删除选中项：先删笔刷条目并落盘，再解绑主开关（两者都靠 pushConfig 同步 bridge 缓存）
  const removeSelectedEntries = () => {
    if (selectedIds.length === 0) return;
    const sel = new Set(selectedIds);
    const unbindMain = entries.some(e => sel.has(e.id) && e.action === 'toggleMain' && e.combo);
    const brushIds = entries.filter(e => sel.has(e.id) && e.action !== 'toggleMain').map(e => e.id);
    if (!unbindMain && brushIds.length === 0) { showMessage('选中的条目无需处理'); return; }
    setSelectedIds([]);
    // 先删笔刷条目：pushConfig 会同步 bridge 内缓存，保证随后的 setMainToggleCombo 基于最新列表
    if (brushIds.length) {
      const next = entries.filter(e => !brushIds.includes(e.id));
      setEntries(next);
      pushConfig(next);
    }
    // 主开关不真正删除，改为「解绑」（combo 置空并落盘），
    // 这样下次打开插件不会又把默认的 Ctrl+Q 补回来；需要时可到主面板菜单重新指定。
    if (unbindMain) setMainToggleCombo('');
    const parts: string[] = [];
    if (brushIds.length) parts.push('已删除 ' + brushIds.length + ' 条快捷键');
    if (unbindMain) parts.push('已解绑选区填充开关');
    showMessage(parts.join('，'));
  };

  // 把检测到的中文类型渲染成对应图标；其它类型（橡皮擦等）无专用图标则回退显示文字，
  // 空串则不显示任何 tag。
  const brushTypeTag = (type: string): React.ReactNode => {
    switch (type) {
      case '画笔': return <BrushToolIcon />;
      case '混合器画笔': return <MixerToolIcon />;
      case '涂抹': return <SmudgeToolIcon />;
      case '': return '';
      default: return type;
    }
  };

  const brushOptions: BrushSelectOption[] = brushes.map(b => ({
    value: b,
    main: b,
    // 笔刷类型（混合器/涂抹/画笔…）渲染为图标；取不到类型则该项无 tag
    tag: brushTypeTag(brushTypes[b] || '')
  }));

  return (
    <div className="adjust-expand-section">
      <div className="adjust-expand-header" onClick={() => setCollapsed(c => !c)}
           title="通过本地快捷键服务实现全局快捷键，直接在画布上按快捷键切换笔刷（无需录制动作）。">
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
              {daemonConnected ? '快捷键服务已就绪' : (busy ? '快捷键服务处理中…' : '快捷键服务未启动')}
            </span>
            <span style={{ flex: 1 }} />
            <div
              role="button"
              tabIndex={0}
              className={`adjustment-button auto compact${busy ? ' disabled' : ''}`}
              title={daemonConnected
                ? '让快捷键服务退出。卸载插件前必须先停止，否则安装目录里的文件被占用删不掉'
                : '安装并启动随插件分发的快捷键服务（默认的选区填充开关 Ctrl+Q 也由它驱动）'}
              onClick={(e) => {
                e.stopPropagation(); // 避免冒泡到分区头部触发折叠
                if (!busy) { if (daemonConnected) void stopDaemon(); else void loadDaemon(); }
              }}
            >
              {daemonConnected ? '停止快捷键服务' : '启动快捷键服务'}
            </div>
          </div>

          <div style={rowStyle}>
            {usePicker ? (
              <BrushSelect
                value={selectedBrush}
                options={brushOptions}
                onChange={setSelectedBrush}
                placeholder="选择笔刷"
                title="选择要绑定快捷键的笔刷预设（名称需与 Brushes 面板一致）"
                style={{ flex: '1 1 auto', minWidth: 0 }}
              />
            ) : (
              <sp-textfield size="s" placeholder="输入笔刷预设名（需与 PS 完全一致）" style={{ flex: '1 1 auto', minWidth: 0 }}
                value={selectedBrush} onInput={(e: any) => setSelectedBrush(e.target.value)} />
            )}
            {/* 三个图标共用一个固定宽度大容器：下拉自由伸缩，图标组恒为 3×28px，
                录制键恒在最右格；停止键出现/消失在预留的中间格子内，
                因此刷新与录制都不会位移，三者间距也始终一致 */}
            <div className="hotkey-icon-group">
              <div className="hotkey-icon-cell">
                {usePicker && (
                  <div
                    className="hotkey-icon-button"
                    onClick={() => void loadBrushes(true)}
                    title="刷新笔刷列表"
                  >
                    <RefreshIcon style={{ width: 14, height: 14, display: 'block' }} />
                  </div>
                )}
              </div>
              <div className="hotkey-icon-cell">
                <div
                  role="button"
                  tabIndex={0}
                  className={`hotkey-circle-button${recording ? '' : ' disabled'}`}
                  title={recording ? '放弃本次录制（等同于在录制过程中按 Esc）' : '仅在录制过程中可取消本次录制'}
                  onClick={(e) => { e.stopPropagation(); if (recording) cancelRecord(); }}
                >
                  <StopSquareIcon style={{ width: 16, height: 16, display: 'block' }} />
                </div>
              </div>
              <div className="hotkey-icon-cell">
                <div
                  role="button"
                  tabIndex={0}
                  className={`hotkey-circle-button${recording ? ' recording' : ''}${!selectedBrush ? ' disabled' : ''}`}
                  title={
                    '选中一支笔刷后点这个圆点，然后在任意位置按下要绑定的组合键即可。\n' +
                    '可绑定的键：字母 A-Z、数字 0-9、F1-F24，以及 ; \' , . / - = ` [ ] \\ 等符号键，\n' +
                    '还有方向键 / 空格 / 回车 / 退格 / Tab / Insert / Delete / Home / End / PageUp / PageDown\n' +
                    '以及小键盘 Num0-Num9。录制由快捷键服务的全局键盘钩子完成，无需面板获得焦点。\n' +
                    '录制中按 Esc 取消。'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!recording && selectedBrush) void startRecord();
                  }}
                >
                  <RecordCircleIcon style={{ width: 16, height: 16, display: 'block' }} />
                </div>
              </div>
            </div>
          </div>
          {!usePicker && (
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
              未能自动枚举笔刷，已切换为手动输入；点「录制快捷键」前请先填好笔刷名（需与 PS 完全一致）。
            </div>
          )}

          {/* 所有录好的快捷键都装在一个边框可见的大容器里（参考蒙版同步卡片外部的大容器）；
              删除键移到容器外的右下角，见下方 .hotkey-entry-actions */}
          <div className="hotkey-entry-box">
            <div className="hotkey-entry-list">
              {entries.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>尚未绑定任何快捷键</div>}
              {entries.map(e => (
                <div
                  key={e.id}
                  className={`hotkey-entry-row${selectedIds.includes(e.id) ? ' selected' : ''}`}
                  title="单击选中；Ctrl + 单击 加选/减选；Shift + 单击 选中从锚点到本条的所有记录"
                  onClick={(ev) => handleEntryClick(e.id, ev)}
                >
                  {/* 快捷键列定宽：分隔线紧贴它，因此跨条目始终对齐 */}
                  <span className="hotkey-entry-combo">{e.combo || '未绑定'}</span>
                  <span className="hotkey-entry-sep">丨</span>
                  <span className="hotkey-entry-name">
                    {e.action === 'toggleMain' ? '选区填充开关' : e.brush}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 选中条数提示 + 重录 + 删除：列表大容器外右下角，说明文字上方。
              左侧「已选中 N 条」左对齐；右侧重录（仅选中单条时）与删除图标按钮相邻 */}
          <div className="hotkey-entry-actions">
            <span className="hotkey-selected-count">已选中 {selectedIds.length} 条</span>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div
                role="button"
                tabIndex={0}
                className={`hotkey-icon-button${(selectedIds.length !== 1 || recording || !daemonConnected) ? ' disabled' : ''}`}
                style={{ marginRight: 4 }}
                title={selectedIds.length === 1 ? '重录选中的这一条（无需再从上方下拉菜单选择）' : '选中单条快捷键后可重录'}
                onClick={() => { if (selectedIds.length === 1 && !recording && daemonConnected) void reRecordEntry(); }}
              >
                <DataRefreshIcon style={{ width: 14, height: 14, display: 'block' }} />
              </div>
              <div
                role="button"
                tabIndex={0}
                className={`hotkey-icon-button${deletableCount ? '' : ' disabled'}`}
                title={deletableCount
                  ? ('删除选中的 ' + deletableCount + ' 条（选区填充开关为解绑而非删除）')
                  : '请先在上方单击选中要删除的快捷键'}
                onClick={() => removeSelectedEntries()}
              >
                <DeleteIcon style={{ width: 14, height: 14, display: 'block' }} />
              </div>
            </div>
          </div>

          {/* 底部文字通知：与「蒙版同步」的 .mask-sync-result 同一套样式（ok 绿 / warn 橙） */}
          {message && (
            <div className={`mask-sync-result ${daemonConnected ? 'ok' : 'warn'}`}>
              {message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
