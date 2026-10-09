import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  HotkeyEntry, onConfig, onDaemonStatus, pushConfig, requestHotkeyRecording,
  cancelHotkeyRecording, onRecordProgress, setMainToggleCombo,
  armBackspaceDelete, disarmBackspaceDelete, onBackspaceDelete,
} from './HotkeyBridge';
import { helpTexts } from '../constants/helpTexts';
import { subscribeFocusMode } from '../utils/FocusModeBus';
import { FUNC_HOTKEY_DEFS, FUNC_HOTKEY_SECTION_ORDER, getFuncHotkeyLabel } from './funcHotkeyDefs';

// 「功能快捷键」浮窗面板：由右上角菜单打开，专门管理**非笔刷功能**的全局快捷键。
// 形态：**占满整个面板的子面板**（不是居中卡片），纵向两段：
//   滚动区（.func-hotkey-body，从面板顶端 y=0 贯通到底部）
//     ├─ 标题段 .func-hotkey-head（「功能快捷键」+ 关闭按钮 + 未连接提示，**随内容滚走**）
//     └─ 列表段 .func-hotkey-list（分组清单，横向内缩 10px 文字缩进）
//   通知段 .func-hotkey-foot（底部常驻，不参与滚动 ⇒ 任何位置录制都看得见）
//   滚动槽因此**贯通整高、贴面板最右缘**（UXP 的滚动槽压在滚动容器内容盒内部，
//   容器带任何内缩/边框都会把槽一起带偏 ⇒ 滚动容器本身零内缩，内缩全交给内层）。
// 内容分组（自上而下）：
//   1. 「选区填充」组：置顶的选区填充开关录制行（从笔刷热键分区迁移而来）；
//      专注模式下名称只显示「选区填充」（热键只开不关的既有语义不变）；
//   2. 功能分组：按功能按钮实际所在的面板分区分组展示（同区分集中、异区分容器）。
// 行内布局：功能名在左、录好的快捷键在右（与笔刷热键分区一致）。
// 交互（去掉独立的录制/删除按钮，容器窄、把宽度还给功能名）：
//   单击行 → 选中（布防）：选中后按退格键解绑该条（条目保留，显示「未绑定」）；
//   双击行 → 开始录制/重录（守护进程全局捕获组合键，行内实时显示「按下组合键…」）；
//   捕获到组合键后该行显示「XXX · 回车确认」→ 回车保存；Esc 取消；
//   关闭浮窗/再次双击其它行前须先结束当前编辑。
//   ⚠️ 标题随内容滚走 ⇒ 关闭按钮会滚出视野，Esc 作为退路关闭本子面板
//      （录制期间不接管 Esc —— 那时归守护进程的「取消录制」）。
// 录制/选中期间该行高亮（复用 .selected 边框）。
// 行高与笔刷热键分区完全同款（.hotkey-entry-row：8px 内边距 + 12px 字号），压缩纵向高度。

// 通知自动消失时间：与笔刷热键分区一致（瞬时反馈 5 秒足够）。
const MESSAGE_TTL_MS = 5000;

/** 正在编辑（录制）的行：'main' = 选区填充开关；其余值为功能 id。 */
type EditTarget = string | null;

export default function FuncHotkeyPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<HotkeyEntry[]>([]);
  const [daemonConnected, setDaemonConnected] = useState(false);
  // 专注模式：来自共享总线（APP 面板写入），只影响主开关行的显示名。
  const [focusMode, setFocusMode] = useState(false);
  // 当前编辑中的行 + 已捕获待确认的组合键（空串 = 捕获阶段，还没按到组合键）
  const [editingTarget, setEditingTarget] = useState<EditTarget>(null);
  const [capturedCombo, setCapturedCombo] = useState('');
  const [message, setMessage] = useState('');
  // 当前选中的行（单击选中）：选中即向守护进程布防「退格解绑」，再点一次取消选中
  const [selectedTarget, setSelectedTarget] = useState<EditTarget>(null);

  const msgTimerRef = useRef<any>(null);
  // 浮窗根节点：面板内直捕退格用——只有按键目标落在浮窗内（行被点击聚焦后）
  // 才劫持退格，避免污染浮窗外的其它输入控件。
  const floatWinRef = useRef<HTMLDivElement | null>(null);
  const showMessage = useCallback((text: string) => {
    if (msgTimerRef.current) { clearTimeout(msgTimerRef.current); msgTimerRef.current = null; }
    setMessage(text);
    if (text) msgTimerRef.current = setTimeout(() => { setMessage(''); msgTimerRef.current = null; }, MESSAGE_TTL_MS);
  }, []);
  useEffect(() => () => { if (msgTimerRef.current) clearTimeout(msgTimerRef.current); }, []);

  // 编辑期间关闭浮窗：主动取消录制，避免守护进程一直挂着等按键；
  // 卸载/关闭时同步撤防「退格解绑」（面板都没了，布防必须归还）。
  const editingRef = useRef<EditTarget>(null);
  useEffect(() => { editingRef.current = editingTarget; }, [editingTarget]);
  const selectedRef = useRef<EditTarget>(null);
  useEffect(() => { selectedRef.current = selectedTarget; }, [selectedTarget]);
  // onClose 走 ref：Esc 监听是空依赖 effect，直接闭包捕获会锁住首次渲染的 onClose
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => () => {
    if (editingRef.current) cancelHotkeyRecording();
    disarmBackspaceDelete('func');
  }, []);

  // 选中态 ⇄ 布防同步：选中某行后按退格 = 解绑该条；取消选中/开始编辑前先撤防。
  // owner 固定 'func'；与笔刷热键分区的 'brush' 布防互斥（后布防者覆盖，见 HotkeyBridge）。
  useEffect(() => {
    if (selectedTarget && !editingTarget) armBackspaceDelete('func');
    else disarmBackspaceDelete('func');
  }, [selectedTarget, editingTarget]);

  // 退格解绑的执行体：deleteBinding 依赖 entries/focusMode，经 ref 取最新闭包
  const deleteBindingRef = useRef<(target: string) => void>(() => {});
  useEffect(() => { deleteBindingRef.current = deleteBinding; });
  useEffect(() => onBackspaceDelete((owner) => {
    if (owner !== 'func') return; // 只认领自己的布防
    const target = selectedRef.current;
    if (!target || editingRef.current) return;
    deleteBindingRef.current(target);
    setSelectedTarget(null);
  }), []);

  // 面板内直捕退格（不依赖守护进程布防，reload 即生效）：行被点击聚焦后，
  // 按键目标在浮窗内 → 退格解绑选中条。与布防通路互斥不重复：
  // 新版守护进程会在低层钩子里吞掉退格并回传 backspaceDelete（此时 UXP 收不到按键事件）；
  // 旧版守护进程放行按键，由本监听兜底。
  useEffect(() => {
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace') return;
      const win = floatWinRef.current;
      if (!win || !win.contains(e.target as Node)) return; // 焦点不在浮窗内不劫持
      const target = selectedRef.current;
      if (!target || editingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      deleteBindingRef.current(target);
      setSelectedTarget(null);
    };
    document.addEventListener('keydown', onDocKeyDown, { capture: true } as any);
    return () => document.removeEventListener('keydown', onDocKeyDown, { capture: true } as any);
  }, []);

  // Esc 关闭子面板（标题随内容滚走 ⇒ 关闭按钮可能已滚出视野，必须有键盘/遮罩之外的退路）。
  // 录制期间**不接管** Esc：那时 Esc 归守护进程（取消录制），抢过来会导致取消录制失效。
  useEffect(() => {
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editingRef.current) return; // 录制中：让给「Esc 取消录制」
      onCloseRef.current();
    };
    document.addEventListener('keydown', onDocKeyDown, { capture: true } as any);
    return () => document.removeEventListener('keydown', onDocKeyDown, { capture: true } as any);
  }, []);

  useEffect(() => {
    const unsubConfig = onConfig((list) => setEntries(list));
    const unsubStatus = onDaemonStatus(setDaemonConnected);
    const unsubFocus = subscribeFocusMode(setFocusMode);
    return () => { unsubConfig(); unsubStatus(); unsubFocus(); };
  }, []);

  /** 条目在冲突提示里的显示名。 */
  const entryDisplayName = (e: HotkeyEntry): string => {
    if (e.action === 'toggleMain') return focusMode ? '选区填充' : '选区填充开关';
    if (e.action === 'runFunc') return getFuncHotkeyLabel(e.brush || '');
    return e.brush || '';
  };

  /** 编辑目标在提示语里的显示名。 */
  const targetDisplayName = (target: string): string =>
    target === 'main' ? (focusMode ? '选区填充' : '选区填充开关') : getFuncHotkeyLabel(target);

  // 解绑（退格通路）：主开关 = 解绑（combo 置空并落盘，不会被默认值覆盖）；
  // 功能 = 移除条目（行本身来自功能清单，始终保留，显示回到「未绑定」）
  const deleteBinding = (target: string) => {
    if (target === 'main') {
      setMainToggleCombo('');
      showMessage('已解绑' + (focusMode ? '选区填充' : '选区填充开关') + '的组合键');
      return;
    }
    const next = entries.filter(e => !(e.action === 'runFunc' && e.brush === target));
    if (next.length === entries.length) { showMessage('该功能尚未绑定快捷键'); return; }
    setEntries(next);
    if (pushConfig(next)) showMessage('已解绑「' + getFuncHotkeyLabel(target) + '」的快捷键');
    else showMessage('推送配置失败（快捷键服务未运行？）');
  };

  // 双击进入编辑：守护进程捕获组合键（recordCaptured 实时回显到行内），
  // 回车确认（recordResult）/ Esc 取消（recordCancel）。退格不参与录制，
  // 解绑走「单击选中 + 退格」的布防通路（见上方 onBackspaceDelete）。
  const startEdit = async (target: string) => {
    if (editingTarget) return; // 已有编辑中的行
    if (!daemonConnected) { showMessage(helpTexts.funcHotkey.notConnected); return; }
    setEditingTarget(target);
    setCapturedCombo('');
    showMessage('正在录制「' + targetDisplayName(target) + '」：按下组合键后回车确认，Esc 取消');
    // 进度订阅必须在发指令前挂好：recordCaptured 可能先于 pendingRecord 兑现到达
    const unsubProgress = onRecordProgress((combo) => setCapturedCombo(combo));
    const res = await requestHotkeyRecording(target === 'main' ? '__MAIN__' : '__FUNC__:' + target);
    unsubProgress();
    setEditingTarget(null);
    setCapturedCombo('');
    if (!res) { showMessage('已取消录制'); return; }
    const combo = res.combo;
    // 冲突检查：新组合键被其它条目（笔刷/其它功能/主开关）占用则放弃本次修改。
    // 排除目标自身：重录为原组合键不算冲突。
    const dup = entries.find(e => {
      if (target === 'main') return e.action !== 'toggleMain' && e.combo === combo;
      const isSelf = e.action === 'runFunc' && e.brush === target;
      return !isSelf && e.combo === combo;
    });
    if (dup) {
      showMessage('该组合键已被「' + entryDisplayName(dup) + '」占用，请换一个');
      return;
    }
    if (target === 'main') {
      // 主开关不新增条目，只更新共享配置里的 combo（'' 即解绑，由 bridge 落盘）
      setMainToggleCombo(combo);
      showMessage('已保存：' + combo + ' → ' + targetDisplayName(target));
      return;
    }
    const existing = entries.find(e => e.action === 'runFunc' && e.brush === target);
    const next: HotkeyEntry[] = existing
      ? entries.map(e => (e.id === existing.id ? { ...e, combo } : e))
      : [...entries, { id: 'fk_' + Date.now(), combo, action: 'runFunc', brush: target }];
    setEntries(next);
    if (pushConfig(next)) showMessage('已保存：' + combo + ' → ' + targetDisplayName(target));
    else showMessage('推送配置失败（快捷键服务未运行？）');
  };

  const mainEntry = entries.find(e => e.action === 'toggleMain');
  const funcEntryOf = (funcId: string): HotkeyEntry | undefined =>
    entries.find(e => e.action === 'runFunc' && e.brush === funcId);

  // 行结构：功能名 | 丨 | 快捷键（名称在左、快捷键在右，与笔刷热键分区一致）。
  // 无独立按钮：单击行 = 选中（选中后按退格解绑）；双击行 = 录制/重录（见文件头说明）。
  const renderRow = (key: string, combo: string, name: string, target: string, title: string) => {
    const editing = editingTarget === target;
    const selected = selectedTarget === target;
    // 编辑态显示实时状态：捕获阶段提示待按键，捕获后显示组合键 + 待确认
    const comboText = editing
      ? (capturedCombo ? capturedCombo + ' · 回车确认' : '按下组合键…')
      : (combo || '未绑定');
    return (
      <div
        key={key}
        className={'hotkey-entry-row' + ((editing || selected) ? ' selected' : '')}
        title={title}
        tabIndex={0}
        onClick={(ev) => {
          // 行可聚焦：点击即聚焦，让随后的退格落在浮窗内（面板内直捕退格的焦点依据）
          (ev.currentTarget as HTMLElement).focus();
          if (editingTarget) return;
          // 单击选中 / 再击取消；选中即布防（按退格解绑），由上方 effect 同步给守护进程
          setSelectedTarget(prev => (prev === target ? null : target));
        }}
        onDoubleClick={(ev) => { ev.stopPropagation(); if (!editingTarget) void startEdit(target); }}
      >
        <span className="hotkey-entry-name">{name}</span>
        <span className="divider-vertical">丨</span>
        <span className="hotkey-entry-combo">{comboText}</span>
      </div>
    );
  };

  // 分组：主开关「选区填充」固定最上方单独成组，其后按功能按钮实际所在分区分组。
  // 同一分区的行集中在一个边框容器里，不同分区用标题 + 容器分开。
  const sectionGroups = FUNC_HOTKEY_SECTION_ORDER
    .map(sec => ({ title: sec, defs: FUNC_HOTKEY_DEFS.filter(d => d.section === sec) }))
    .filter(g => g.defs.length > 0);
  const unordered = FUNC_HOTKEY_DEFS.filter(d => !FUNC_HOTKEY_SECTION_ORDER.includes(d.section));

  return (
    <div className="float-overlay func-hotkey-overlay" onClick={onClose}>
      <div className="float-window func-hotkey-window" ref={floatWinRef} onClick={(e) => e.stopPropagation()}>
        {/* 滚动区：**从面板顶端 y=0 贯通到底部**，标题段与列表段都在这一层，
            所以滚动槽也贯通整高（标题随内容一起滚走）。
            底部通知段在滚动区之外、恒定可见 —— 录制任意位置的快捷键都看得见。
            本层零横向内缩 ⇒ 滚动槽落在面板最右缘；文字缩进由内层 .func-hotkey-list 承担。 */}
        <div className="func-hotkey-body">
        {/* 标题段（含守护进程未连接提示）：随内容滚动 */}
        <div className="func-hotkey-head">
          <div className="row-between">
            <span className="subpanel-title-1">功能快捷键</span>
            <div role="button" tabIndex={0} className="close-button" onClick={onClose}>×</div>
          </div>

          {!daemonConnected && (
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>{helpTexts.funcHotkey.notConnected}</div>
          )}
        </div>

        <div className="func-hotkey-list">
        {/* 分组：按功能所在分区展示；「选区填充」组的容器内置顶主开关行（专注模式下显示「选区填充」），
            其下紧跟纯色/图案/渐变三个子面板开关行。 */}
        {sectionGroups.map(g => (
          <React.Fragment key={'grp_' + g.title}>
            <div className="func-group-title">{g.title}</div>
            <div className="border-panel-section">
              {g.title === '选区填充' && (mainEntry
                ? renderRow(mainEntry.id, mainEntry.combo,
                    focusMode ? '选区填充' : '选区填充开关', 'main', helpTexts.funcHotkey.mainRow)
                : renderRow('main_placeholder', '', focusMode ? '选区填充' : '选区填充开关', 'main', helpTexts.funcHotkey.mainRow))}
              {g.defs.map(def =>
                renderRow('fk_' + def.id, funcEntryOf(def.id)?.combo || '', def.label, def.id, helpTexts.funcHotkey.rowHint)
              )}
            </div>
          </React.Fragment>
        ))}
        {unordered.length > 0 && (
          <>
            <div className="func-group-title">其它</div>
            <div className="border-panel-section">
              {unordered.map(def =>
                renderRow('fk_' + def.id, funcEntryOf(def.id)?.combo || '', def.label, def.id, helpTexts.funcHotkey.rowHint)
              )}
            </div>
          </>
        )}
        </div>
        </div>

        {/* 通知段：常驻底部槽位，仅文案变化——避免消息出现/消失时滚动区高度跳动。 */}
        <div className="func-hotkey-foot">
          {message && (
            <div className={daemonConnected ? 'status-banner status-banner-ok' : 'status-banner status-banner-warn'}>
              <span className={daemonConnected ? 'indicator indicator-md indicator-ok' : 'indicator indicator-md indicator-warn'} />
              <span className="notify-text">{message}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
