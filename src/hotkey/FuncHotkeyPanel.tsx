import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  HotkeyEntry, onConfig, onDaemonStatus, pushConfig, requestHotkeyRecording,
  cancelHotkeyRecording, onRecordProgress, setMainToggleCombo, setFocusLassoCombo,
  setFocusClearCombo, setAltToolCombo, armBackspaceDelete, disarmBackspaceDelete, onBackspaceDelete,
  onHotkeyState, requestHotkeyStatus,
  peekPersistedArm, getBlendHotkeyOn, setBlendHotkeyActive, isDaemonConnected,
} from './HotkeyBridge';
import { helpTexts } from '../constants/helpTexts';
import { subscribeFocusMode, peekFocusMode } from '../utils/FocusModeBus';
import { FUNC_HOTKEY_DEFS, FUNC_HOTKEY_SECTION_ORDER, getFuncHotkeyLabel } from './funcHotkeyDefs';
import ToggleSwitch from '../components/ToggleSwitch';

// 「功能快捷键」子面板：由右上角菜单打开，专门管理**非笔刷功能**的全局快捷键。
// 形态：**占满整个面板的子面板**（不是居中卡片），纵向两段：
//   滚动区（.func-hotkey-body，从面板顶端 y=0 贯通到底部）
//     ├─ 标题段 .func-hotkey-head（「功能快捷键」+ 关闭按钮 + 未连接提示，**随内容滚走**）
//     └─ 列表段 .func-hotkey-list（分组清单，横向内缩 10px 文字缩进）
//   通知段 .func-hotkey-foot（底部常驻，不参与滚动 ⇒ 任何位置录制都看得见）
//   滚动槽因此**贯通整高、贴面板最右缘**（UXP 的滚动槽压在滚动容器内容盒内部，
//   容器带任何内缩/边框都会把槽一起带偏 ⇒ 滚动容器本身零内缩，内缩全交给内层）。
// 内容分组（自上而下）：
//   1. 「选区填充」组：置顶的选区填充开关录制行（从笔刷热键分区迁移而来）；
//      工具模式下名称只显示「选区填充」（热键只开不关的既有语义不变）；
//   2. 功能分组：按功能按钮实际所在的面板分区分组展示（同区分集中、异区分容器）。
// 行内布局：功能名在左、录好的快捷键在右（与笔刷热键分区一致）。
// 交互（去掉独立的录制/删除按钮，容器窄、把宽度还给功能名）：
//   单击行 → 选中（布防）：选中后按退格键解绑该条（条目保留，显示「未绑定」）；
//   双击行 → 开始录制/重录（守护进程全局捕获组合键，行内实时显示「按下组合键…」）；
//   捕获到组合键后该行显示「XXX · 回车确认」→ 回车保存；Esc 取消；
//   关闭子面板/再次双击其它行前须先结束当前编辑。
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
  // ⛔ 初值取 bridge 的同步连接态：`useState(false)` 会让每次挂载（含折叠后展开）
  // 先渲染成「未连接」，等 onDaemonStatus 回放才翻转（同 BrushHotkeySection 的穿帮）。
  const [daemonConnected, setDaemonConnected] = useState<boolean>(() => isDaemonConnected());
  // 热键布防态（.8li 形态）：撤防时录制会被 C 侧直接取消，见 startEdit 门禁。
  // ⛔⛔ 初值必须与笔刷热键分区对齐（peekPersistedArm() ?? true，2026-10-19 修）：
  //    本子面板是用户后来才打开的（右上角菜单），而 .8li 的 hotkeyState 只在**跃变**时
  //    广播 —— armed 恒为 true 时除了建连那次 hotkeyStatus 回帧外再无状态帧，晚挂载的
  //    本面板若用 false 起头就会永远停在 false：标题下显示「热键已暂停」（与笔刷分区
  //    的「已开启」自相矛盾），startEdit 的门禁还会把录制入口一并拦住。
  //    落盘值兜底 + 连通后主动 requestHotkeyStatus 对齐 .8li 真值（见下方 effect）。
  const [hotkeyArmed, setHotkeyArmed] = useState<boolean>(() => peekPersistedArm() ?? true);
  const hotkeyArmedRef = useRef(hotkeyArmed);
  useEffect(() => { hotkeyArmedRef.current = hotkeyArmed; }, [hotkeyArmed]);
  // 工具模式：来自共享总线（APP 面板写入），只影响主开关行的显示名。
  // ⚠️ 初值取 peekFocusMode() 的内存真值（null 才是「未知」→ 退回 false）：
  //    只靠 subscribeFocusMode 的首次回调，首帧会先渲染成「选区填充开关」
  //    再闪一下纠正。两个面板共享同一模块实例，主面板启动时写入的值这里能同步读到。
  const [focusMode, setFocusMode] = useState(() => peekFocusMode() ?? false);
  // 当前编辑中的行 + 已捕获待确认的组合键（空串 = 捕获阶段，还没按到组合键）
  const [editingTarget, setEditingTarget] = useState<EditTarget>(null);
  const [capturedCombo, setCapturedCombo] = useState('');
  const [message, setMessage] = useState('');
  // 当前选中的行（单击选中）：选中即向守护进程布防「退格解绑」，再点一次取消选中
  const [selectedTarget, setSelectedTarget] = useState<EditTarget>(null);

  const msgTimerRef = useRef<any>(null);
  // 子面板根节点：面板内直捕退格用——只有按键目标落在子面板内（行被点击聚焦后）
  // 才劫持退格，避免污染子面板外的其它输入控件。
  const floatWinRef = useRef<HTMLDivElement | null>(null);
  const showMessage = useCallback((text: string, sticky: boolean = false) => {
    if (msgTimerRef.current) { clearTimeout(msgTimerRef.current); msgTimerRef.current = null; }
    setMessage(text);
    // sticky（录制 / 重录 / 已捕获待确认等状态提示）不自动消失：必须等到录制完成或用户取消，
    // 否则长时间录制时提示会先过期，用户看不出当前处于哪种状态。
    if (text && !sticky) msgTimerRef.current = setTimeout(() => { setMessage(''); msgTimerRef.current = null; }, MESSAGE_TTL_MS);
  }, []);
  useEffect(() => () => { if (msgTimerRef.current) clearTimeout(msgTimerRef.current); }, []);

  // 编辑期间关闭子面板：主动取消录制，避免守护进程一直挂着等按键；
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
  // 按键目标在子面板内 → 退格解绑选中条。与布防通路互斥不重复：
  // 新版守护进程会在低层钩子里吞掉退格并回传 backspaceDelete（此时 UXP 收不到按键事件）；
  // 旧版守护进程放行按键，由本监听兜底。
  useEffect(() => {
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace') return;
      const win = floatWinRef.current;
      if (!win || !win.contains(e.target as Node)) return; // 焦点不在子面板内不劫持
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
    const unsubStatus = onDaemonStatus((c) => {
      setDaemonConnected(c);
      // .8li 的布防态只在跃变时广播 ⇒ 晚挂载的面板必须**主动问一次**，
      // 否则 hotkeyArmed 只能靠落盘值猜测（修复 2026-10-19「显示热键已暂停」）。
      // onDaemonStatus 订阅即回放当前值：已连通会立刻走到这里，未连通则等连通。
      if (c) requestHotkeyStatus();
    });
    // .8li 形态：布防态也要跟（撤防时 C 侧会直接回 recordCancel，
    // 这里提前拦，给出可操作的提示而不是「莫名取消的录制」）
    const unsubArmed = onHotkeyState((st) => setHotkeyArmed(st.armed));
    const unsubFocus = subscribeFocusMode(setFocusMode);
    return () => { unsubConfig(); unsubStatus(); unsubArmed(); unsubFocus(); };
  }, []);

  /** 条目在冲突提示里的显示名。 */
  const entryDisplayName = (e: HotkeyEntry): string => {
    if (e.action === 'toggleMain') return focusMode ? '选区填充' : '选区填充开关';
    if (e.action === 'focusLasso') return '套索工具';
    if (e.action === 'focusClear') return '清除模式';
    if (e.action === 'altTool') return '临时吸管';
    if (e.action === 'blendHotkey') return '混合模式热键';
    if (e.action === 'runFunc') return getFuncHotkeyLabel(e.brush || '');
    return e.brush || '';
  };

  /** 编辑目标在提示语里的显示名。 */
  const targetDisplayName = (target: string): string => {
    if (target === 'main') return focusMode ? '选区填充' : '选区填充开关';
    if (target === 'focus_lasso') return '套索工具';
    if (target === 'focus_clear') return '清除模式';
    if (target === 'alt_tool') return '临时吸管';
    return getFuncHotkeyLabel(target);
  };

  // 解绑（退格通路）：主开关 = 解绑（combo 置空并落盘，不会被默认值覆盖）；
  // 功能 = 移除条目（行本身来自功能清单，始终保留，显示回到「未绑定」）
  const deleteBinding = (target: string) => {
    if (target === 'main') {
      setMainToggleCombo('');
      showMessage('已解绑' + (focusMode ? '选区填充' : '选区填充开关') + '的组合键');
      return;
    }
    if (target === 'focus_lasso') {
      // 套索工具键随工具模式自动启用/停用，不参与「退格解绑」（重录请双击）。
      showMessage('套索工具键随工具模式自动启用，无需解绑；如需更换请双击重录');
      return;
    }
    if (target === 'focus_clear') {
      // 清除模式键同样随工具模式自动启用/停用，不参与「退格解绑」（重录请双击）。
      showMessage('清除模式键随工具模式自动启用，无需解绑；如需更换请双击重录');
      return;
    }
    if (target === 'alt_tool') {
      // 临时吸管键同样随工具模式自动启用/停用，不参与「退格解绑」（重录请双击）。
      showMessage('临时吸管键随工具模式自动启用，无需解绑；如需更换请双击重录');
      return;
    }
    const next = entries.filter(e => !(e.action === 'runFunc' && e.brush === target));
    if (next.length === entries.length) { showMessage('该功能尚未绑定快捷键'); return; }
    setEntries(next);
    if (pushConfig(next)) showMessage('已解绑「' + getFuncHotkeyLabel(target) + '」的快捷键');
    else showMessage('推送配置失败：快捷键服务未连接，或配置路径尚未就绪（请重新加载插件后重试）');
  };

  // 双击进入编辑：守护进程捕获组合键（recordCaptured 实时回显到行内），
  // 回车确认（recordResult）/ Esc 取消（recordCancel）。退格不参与录制，
  // 解绑走「单击选中 + 退格」的布防通路（见上方 onBackspaceDelete）。
  const startEdit = async (target: string) => {
    if (editingTarget) return; // 已有编辑中的行
    if (!daemonConnected) { showMessage(helpTexts.funcHotkey.notConnected); return; }
    if (!hotkeyArmedRef.current) { showMessage('热键开关当前是暂停的，请先到「笔刷热键」分区的折叠标题右侧打开「热键」开关再录制'); return; }
    setEditingTarget(target);
    setCapturedCombo('');
    // sticky：录制过程中的提示常驻，直到录制完成 / 取消（见 showMessage 说明）
    showMessage('正在录制「' + targetDisplayName(target) + '」：按下组合键后回车确认，Esc 取消', true);
    // 进度订阅必须在发指令前挂好：recordCaptured 可能先于 pendingRecord 兑现到达
    const unsubProgress = onRecordProgress((combo) => setCapturedCombo(combo));
    const res = await requestHotkeyRecording(target === 'main' ? '__MAIN__' : '__FUNC__:' + target);
    unsubProgress();
    setEditingTarget(null);
    setCapturedCombo('');
    if (!res) { showMessage('已取消录制'); return; }
    const combo = res.combo;
    // 冲突检查：新组合键被其它条目（笔刷/其它功能/主开关/套索键）占用则放弃本次修改。
    // 排除目标自身：重录为原组合键不算冲突。
    const dup = entries.find(e => {
      if (target === 'main') return e.action !== 'toggleMain' && e.combo === combo;
      if (target === 'focus_lasso') return e.action !== 'focusLasso' && e.combo === combo;
      if (target === 'focus_clear') return e.action !== 'focusClear' && e.combo === combo;
      if (target === 'alt_tool') return e.action !== 'altTool' && e.combo === combo;
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
    if (target === 'focus_lasso') {
      // 套索工具键由 bridge 统一管理（生效值 combo + 记忆值 brush），不落进 entries。
      // active 传本面板看到的工具模式状态（本函数运行在绘画工具箱上下文，bridge 拿不到它）。
      setFocusLassoCombo(combo, focusMode);
      showMessage('已保存：' + combo + ' → 套索工具');
      return;
    }
    if (target === 'focus_clear') {
      // 清除模式键（默认 Shift+E）同样由 bridge 统一管理，语义与套索工具键一致：
      // 按下即确保主开关开启并切换清除模式（主开关不会被关闭）。
      setFocusClearCombo(combo, focusMode);
      showMessage('已保存：' + combo + ' → 清除模式');
      return;
    }
    if (target === 'alt_tool') {
      // 临时吸管键（默认 /）同理由 bridge 统一管理：按住切吸管、松手切回套索。
      // ⛔ 与另外两个键的区别是「按住」语义 ⇒ .8li 只轮询它的电平，不进热键表、不吞键。
      setAltToolCombo(combo, focusMode);
      showMessage('已保存：' + combo + ' → 临时吸管');
      return;
    }
    const existing = entries.find(e => e.action === 'runFunc' && e.brush === target);
    const next: HotkeyEntry[] = existing
      ? entries.map(e => (e.id === existing.id ? { ...e, combo } : e))
      : [...entries, { id: 'fk_' + Date.now(), combo, action: 'runFunc', brush: target }];
    setEntries(next);
    if (pushConfig(next)) showMessage('已保存：' + combo + ' → ' + targetDisplayName(target));
    else showMessage('推送配置失败：快捷键服务未连接，或配置路径尚未就绪（请重新加载插件后重试）');
  };

  const mainEntry = entries.find(e => e.action === 'toggleMain');
  // 工具模式下的「套索工具」键条目：由 HotkeyBridge 在工具模式开启时装载（默认 L）。
  const focusLassoEntry = entries.find(e => e.action === 'focusLasso');
  // 工具模式下的「清除模式」键条目：同样只在工具模式开启时装载（默认 Shift+E）。
  const focusClearEntry = entries.find(e => e.action === 'focusClear');
  // 工具模式下的「临时吸管」按住键条目：同样只在工具模式开启时装载（默认 /）。
  const altToolEntry = entries.find(e => e.action === 'altTool');
  // 混合模式热键开关：配置里 blendHotkey 条目的 combo 非空 = 开（.8li 见之装载
  // 内置 Alt+Shift 表）。与工具模式无关，任何时刻都显示这一行。
  const blendHotkeyOn = !!entries.find(e => e.action === 'blendHotkey')?.combo;
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
          // 行可聚焦：点击即聚焦，让随后的退格落在子面板内（面板内直捕退格的焦点依据）
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

  // 混合模式热键行（2026-10-19 用户要求）：右半列**不是录制的组合键**而是自绘 switch。
  // 行本身不挂选中/录制/退格任何 handler（没有组合键可录可解），只有 switch 可点；
  // 开关状态经共享配置直达 .8li（combo='1'/''），C 侧据此装载/卸载内置 Alt+Shift 表。
  const renderBlendSwitchRow = (key: string, on: boolean) => {
    const toggle = () => {
      if (!daemonConnected) { showMessage(helpTexts.funcHotkey.notConnected); return; }
      const nextOn = !on;
      if (setBlendHotkeyActive(nextOn)) {
        showMessage(nextOn
          ? (hotkeyArmedRef.current
            ? '混合模式热键已开启：按 Alt+Shift+字母（如 K=变暗、M=正片叠底）将改面板的选区填充混合模式'
            : '混合模式热键已开启，但热键当前暂停：请先到「笔刷热键」分区的折叠标题右侧打开热键开关才会生效')
          : '混合模式热键已关闭：Alt+Shift+字母恢复 PS 原生行为（改图层/工具混合模式）');
      } else {
        showMessage('推送配置失败：快捷键服务未连接，或配置路径尚未就绪（请重新加载插件后重试）');
      }
    };
    return (
      <div
        key={key}
        className="hotkey-entry-row hotkey-entry-row-static"
        title={helpTexts.funcHotkey.blendRow}
      >
        <span className="hotkey-entry-name">混合模式热键</span>
        <span className="divider-vertical">丨</span>
        <span className="hotkey-entry-switch">
          <ToggleSwitch
            checked={on}
            onChange={toggle}
            title={on ? '关闭混合模式热键' : '开启混合模式热键'}
            aria-label="混合模式热键"
          />
        </span>
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
          {/* 标题行与其它子面板同构：标题 + 红 × 同处 .subpanel-title-1（自带 space-between +
              align-items:center）⇒ 两者严格垂直居中。
              ⚠️ 勿用 .row-between 包一层：.subpanel-title-1 的 margin-bottom:10px 会在
              align-items:center 的外层 flex 里把标题上移 5px（错位根因）；同时 .row-between 的
              10px 下外边距会让「标题 → 选区填充」间距多出一截（见 adjustment.css 的归零规则）。 */}
          <div className="subpanel-title-1">
            <span>功能快捷键</span>
            <div role="button" tabIndex={0} className="close-button" title={helpTexts.funcHotkey.close} onClick={onClose}>×</div>
          </div>

          {!daemonConnected && (
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>{helpTexts.funcHotkey.notConnected}</div>
          )}
          {daemonConnected && !hotkeyArmed && (
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>热键已暂停：快捷键暂不生效（录制前请先到「笔刷热键」分区的折叠标题右侧打开「热键」开关）</div>
          )}
        </div>

        <div className="func-hotkey-list">
        {/* 分组：按功能所在分区展示；「选区填充」组的容器内置顶主开关行（工具模式下显示「选区填充」），
            其下紧跟纯色/图案/渐变三个子面板开关行。 */}
        {sectionGroups.map(g => (
          <React.Fragment key={'grp_' + g.title}>
            <div className="func-group-title">{g.title}</div>
            <div className="border-panel-section">
              {g.title === '选区填充' && (mainEntry
                ? renderRow(mainEntry.id, mainEntry.combo,
                    focusMode ? '选区填充' : '选区填充开关', 'main', helpTexts.funcHotkey.mainRow)
                : renderRow('main_placeholder', '', focusMode ? '选区填充' : '选区填充开关', 'main', helpTexts.funcHotkey.mainRow))}
              {/* 工具模式下：套索工具键（默认 L）——按下即关闭主开关并切回套索，使 H/L 像两个工具 */}
              {g.title === '选区填充' && focusMode &&
                renderRow('focus_lasso', focusLassoEntry?.combo || '', '套索工具', 'focus_lasso', helpTexts.funcHotkey.lassoRow)}
              {/* 工具模式下：清除模式键（默认 Shift+E）——按下即确保主开关开启并切换清除模式 */}
              {g.title === '选区填充' && focusMode &&
                renderRow('focus_clear', focusClearEntry?.combo || '', '清除模式', 'focus_clear', helpTexts.funcHotkey.clearRow)}
              {/* 工具模式下：临时吸管按住键（默认 /）——按住切吸管、松手切回套索 */}
              {g.title === '选区填充' && focusMode &&
                renderRow('alt_tool', altToolEntry?.combo || '', '临时吸管', 'alt_tool', helpTexts.funcHotkey.pickRow)}
              {/* 混合模式热键（自绘开关行，与工具模式无关）：开启后 Alt+Shift+字母改面板混合模式 */}
              {g.title === '选区填充' && renderBlendSwitchRow('blend_hotkey', blendHotkeyOn)}
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
