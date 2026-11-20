import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  HotkeyEntry, onConfig, onDaemonStatus, pushConfig, requestHotkeyRecording,
  cancelHotkeyRecording, onRecordProgress, setMainToggleCombo, setFocusLassoCombo,
  setFocusClearCombo, setAltToolCombo, setPickColorCombo, getAltToolCombo, getPickColorCombo,
  setLassoCycleCombo,
  setFillToolCycleCombo, setFocusMarqueeCombo, setMarqueeCycleCombo,
  armBackspaceDelete, disarmBackspaceDelete, onBackspaceDelete,
  onHotkeyState, requestHotkeyStatus,
  peekPersistedArm, getBlendHotkeyOn, setBlendHotkeyActive, isDaemonConnected,
  requestConfigRefresh, setBrushSizePresetActive,
} from './HotkeyBridge';
import { describeActiveDocTiers } from '../utils/BrushSizePreset';
import { helpTexts } from '../constants/helpTexts';
import { useBlendGuard, blendYieldHint } from './blendGuard';
import { subscribeFocusMode, peekFocusMode } from '../utils/FocusModeBus';
import { FUNC_HOTKEY_DEFS, FUNC_HOTKEY_SECTION_ORDER, FUNC_HOTKEY_DIVIDERS, getFuncHotkeyLabel } from './funcHotkeyDefs';
import ToggleSwitch from '../components/ToggleSwitch';
import DashedDivider from '../components/DashedDivider';

// 快捷键子面板（**一个组件，两个面板共用**，2026-11-16 扩展）：
//   scope='toolbox' → 绘画工具箱「功能快捷键」（快捷操作 / 细节调整 / 边缘处理）
//   scope='app'     → 选区填充「自定义快捷键」（五块内容，见下方 appBlocks）
//   ⛔ 两处必须是**同一个组件**：用户要求「完全一样的样式、相同的通知逻辑、相同的
//     隐藏数字输入框设计、相同的滚动条设计」。复制一份实现必然漂移（历史上
//     notify-banner / notify-bar 并存就是先例）⇒ 差异只允许来自 scope 的**内容**过滤
//     与标题文案，其余一律共用。
// 形态：**占满整个面板的子面板**（不是居中卡片），纵向两段：
//   滚动区（.func-hotkey-body，从面板顶端 y=0 贯通到底部）
//     ├─ 标题段 .func-hotkey-head（「功能快捷键」+ 关闭按钮 + 未连接提示，**随内容滚走**）
//     └─ 列表段 .func-hotkey-list（分组清单，横向内缩 10px 文字缩进）
//   通知段 .func-hotkey-foot（底部常驻，不参与滚动 ⇒ 任何位置录制都看得见）
//   滚动槽因此**贯通整高、贴面板最右缘**（UXP 的滚动槽压在滚动容器内容盒内部，
//   容器带任何内缩/边框都会把槽一起带偏 ⇒ 滚动容器本身零内缩，内缩全交给内层）。
// 内容分组（按 scope 分工，同一台机器上两块面板各管一段、互不重复）：
//   scope='toolbox'：功能分组 —— 按功能按钮实际所在的面板分区分组
//                    （快捷操作 / 细节调整 / 边缘处理；同区分集中、异区分容器）。
//   scope='app'    ：五块，块间用通用 `.divider` 隔开、**不出现分组标题**，
//                    自上而下为
//                    ① 选区填充（工具模式下名称只显示「选区填充」）/ 切换选区填充（Shift+H）
//                    ② 套索工具 / 切换套索工具（仅工具模式）
//                    ③ 矩形选框工具 / 切换选框工具（仅工具模式）
//                    ④ 混合模式热键（自绘开关行，无组合键）/ 前景色拾色器 / 临时吸管
//                    ⑤ 切换填充模式（默认 Ctrl+滚轮）/ 清除模式（仅工具模式）。
//                    ⑥ 笔刷大小预设（自绘开关行，无组合键；Shift+[ / Shift+] 两条键由
//                       HotkeyBridge 依开关写入配置，2026-11-20 新增）。
//                    ⛔ 原来首块上的「选区填充」分组标题已删除：它与首行同名，属于
//                      用户指出的「多余的选区填充」（2026-11-16）。
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

/** 本组件的使用位置：决定标题文案与显示哪一组内容（见文件头说明）。 */
export type HotkeyPanelScope = 'toolbox' | 'app';

export default function FuncHotkeyPanel({ onClose, scope = 'toolbox' }: { onClose: () => void; scope?: HotkeyPanelScope }) {
  const forApp = scope === 'app';
  /** 子面板标题：工具箱「功能快捷键」/ 选区填充「自定义快捷键」。 */
  const panelTitle = forApp ? '自定义快捷键' : '功能快捷键';
  /**
   * 「热键开关是暂停的」时的行动指引。
   * ⚠️ 开关本体住在**绘画工具箱**的「笔刷热键」分区标题右侧 —— APP 面板这一侧必须
   *    说清「去哪开」，否则用户在本面板里找不到开关会以为功能坏了。
   */
  const armHint = forApp
    ? '请先在绘画工具箱「笔刷热键」分区标题右侧打开「热键」开关'
    : '请先到「笔刷热键」分区的折叠标题右侧打开「热键」开关';
  /** 关闭按钮的 hover 文案：面板名要跟着 scope 走（否则 APP 面板会自称「功能快捷键面板」）。 */
  const closeTitle = forApp
    ? '关闭自定义快捷键面板（录制过程中按 Esc 只取消本次录制，不会关闭面板）。'
    : helpTexts.funcHotkey.close;

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
    /* 订阅就位后再拉一次真值（2026-11-16）：两块面板各有自己的 cachedConfig，
       而原生侧收到 `config` 只落盘、**不广播**给其它客户端 ⇒ 不主动拉就可能拿着
       旧列表回写，把另一块面板刚录好的条目整份抹掉（见 requestConfigRefresh 注释）。
       ⚠️ 顺序不能反：先订阅再发，否则回帧可能早于订阅、UI 永远拿不到新列表。 */
    requestConfigRefresh();
    return () => { unsubConfig(); unsubStatus(); unsubArmed(); unsubFocus(); };
  }, []);

  /** 条目在冲突提示里的显示名。 */
  const entryDisplayName = (e: HotkeyEntry): string => {
    if (e.action === 'toggleMain') return focusMode ? '选区填充' : '选区填充开关';
    if (e.action === 'focusLasso') return '套索工具';
    if (e.action === 'lassoCycle') return '切换套索工具';
    if (e.action === 'fillToolCycle') return '切换选区填充';
    if (e.action === 'focusMarquee') return '矩形选框工具';
    if (e.action === 'marqueeCycle') return '切换选框工具';
    if (e.action === 'focusClear') return '清除模式';
    if (e.action === 'altTool') return '临时吸管';
    if (e.action === 'pickColor') return '前景色拾色器';
    if (e.action === 'blendHotkey') return '混合模式热键';
    if (e.action === 'brushSizePreset') return '笔刷大小预设';
    if (e.action === 'brushSizeStep') return e.brush === 'down' ? '笔刷大小减小' : '笔刷大小增大';
    if (e.action === 'runFunc') return getFuncHotkeyLabel(e.brush || '');
    return e.brush || '';
  };

  /** 编辑目标在提示语里的显示名。 */
  const targetDisplayName = (target: string): string => {
    if (target === 'main') return focusMode ? '选区填充' : '选区填充开关';
    if (target === 'focus_lasso') return '套索工具';
    if (target === 'lasso_cycle') return '切换套索工具';
    if (target === 'fill_tool_cycle') return '切换选区填充';
    if (target === 'marquee_tool') return '矩形选框工具';
    if (target === 'marquee_cycle') return '切换选框工具';
    if (target === 'focus_clear') return '清除模式';
    if (target === 'alt_tool') return '临时吸管';
    if (target === 'pick_color') return '前景色拾色器';
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
    if (target === 'lasso_cycle') {
      // 「切换套索工具」键同样随工具模式自动启用/停用，不参与「退格解绑」（重录请双击）。
      showMessage('切换套索工具键随工具模式自动启用，无需解绑；如需更换请双击重录');
      return;
    }
    if (target === 'fill_tool_cycle') {
      // 2026-11-16 新增的三条工具键同规矩：条目删了也会按默认值补回来 ⇒ 只能重录。
      showMessage('切换选区填充键随工具模式自动启用，无需解绑；如需更换请双击重录');
      return;
    }
    if (target === 'marquee_tool') {
      showMessage('矩形选框工具键随工具模式自动启用，无需解绑；如需更换请双击重录');
      return;
    }
    if (target === 'marquee_cycle') {
      showMessage('切换选框工具键随工具模式自动启用，无需解绑；如需更换请双击重录');
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
    if (target === 'pick_color') {
      // 拾色器键始终装载（与工具模式无关），同样不参与「退格解绑」（重录请双击）。
      showMessage('前景色拾色器键始终启用，无需解绑；如需更换请双击重录');
      return;
    }
    if (target === 'fillModeCycle') {
      // 切换填充模式键同理：条目一旦被删就会在下一次配置帧里被 ensureFillModeCycleEntry
      // 按默认值补回来（Ctrl+滚轮），「解绑」留不住 ⇒ 直接说明只能重录。
      showMessage('切换填充模式键始终启用（默认 Ctrl+滚轮），无需解绑；如需更换请双击重录');
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
    if (!hotkeyArmedRef.current) { showMessage('热键开关当前是暂停的，' + armHint + '，再录制'); return; }
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
      if (target === 'lasso_cycle') return e.action !== 'lassoCycle' && e.combo === combo;
      if (target === 'fill_tool_cycle') return e.action !== 'fillToolCycle' && e.combo === combo;
      if (target === 'marquee_tool') return e.action !== 'focusMarquee' && e.combo === combo;
      if (target === 'marquee_cycle') return e.action !== 'marqueeCycle' && e.combo === combo;
      if (target === 'focus_clear') return e.action !== 'focusClear' && e.combo === combo;
      if (target === 'alt_tool') return e.action !== 'altTool' && e.combo === combo;
      if (target === 'pick_color') return e.action !== 'pickColor' && e.combo === combo;
      const isSelf = e.action === 'runFunc' && e.brush === target;
      return !isSelf && e.combo === combo;
    });
    if (dup) {
      showMessage('该组合键已被「' + entryDisplayName(dup) + '」占用，请换一个');
      return;
    }
    // 0x0212：与「临时吸管」按住键**完全相同**的组合键必须拦住 —— 同一键位 + 同一修饰键
    // ⇒ 按一下两个功能同时触发。⛔ 只拦「完全相同」：不同修饰键（`Shift+/` 与裸 `/`）
    // 是**故意允许**的共存，原生侧按「修饰键完全匹配 + 一次性起按准入」已经分开
    // （见 keyhook.c 的 0x0212 段）。
    // ⚠️ 这条额外检查是为了「工具模式关着」的情况：那时 altTool 条目的 combo 为空、
    //    只是被 `entries` 里的空值藏起来了，记忆值仍在 getAltToolCombo() 里。
    {
      const holdCombo = getAltToolCombo();
      const pickerCombo = getPickColorCombo();
      if (target === 'pick_color' && combo === holdCombo) {
        showMessage('该组合键已是「临时吸管」的按住键，请换一个');
        return;
      }
      if (target === 'alt_tool' && combo === pickerCombo) {
        showMessage('该组合键已被「前景色拾色器」占用，请换一个');
        return;
      }
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
    if (target === 'lasso_cycle') {
      // 与套索键同款：bridge 统一管理（生效值 combo + 记忆值 brush），不落进 entries。
      setLassoCycleCombo(combo, focusMode);
      showMessage('已保存：' + combo + ' → 切换套索工具');
      return;
    }
    if (target === 'fill_tool_cycle') {
      // 2026-11-16：五工具循环键（默认 Shift+H），与套索键同款由 bridge 统一管理。
      // active 传本面板看到的工具模式状态（bridge 在绘画工具箱上下文里拿不到它）。
      setFillToolCycleCombo(combo, focusMode);
      showMessage('已保存：' + combo + ' → 切换选区填充');
      return;
    }
    if (target === 'marquee_tool') {
      // 矩形选框工具键（默认 M）：bridge 统一管理，工具模式关闭时只记记忆值。
      setFocusMarqueeCombo(combo, focusMode);
      showMessage('已保存：' + combo + ' → 矩形选框工具');
      return;
    }
    if (target === 'marquee_cycle') {
      // 选框组循环键（默认 Shift+M）：同上。
      setMarqueeCycleCombo(combo, focusMode);
      showMessage('已保存：' + combo + ' → 切换选框工具');
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
    if (target === 'pick_color') {
      // 前景色拾色器键（默认 Shift+/）：普通热键（按一下），与工具模式无关、始终装载。
      setPickColorCombo(combo);
      showMessage('已保存：' + combo + ' → 前景色拾色器');
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
  const lassoCycleEntry = entries.find(e => e.action === 'lassoCycle');
  // 2026-11-16 新增：五工具循环键（默认 Shift+H）/ 矩形选框键（默认 M）/ 选框组循环键（默认 Shift+M）
  const fillToolCycleEntry = entries.find(e => e.action === 'fillToolCycle');
  const focusMarqueeEntry = entries.find(e => e.action === 'focusMarquee');
  const marqueeCycleEntry = entries.find(e => e.action === 'marqueeCycle');
  // 工具模式下的「清除模式」键条目：同样只在工具模式开启时装载（默认 Shift+E）。
  const focusClearEntry = entries.find(e => e.action === 'focusClear');
  // 工具模式下的「临时吸管」按住键条目：同样只在工具模式开启时装载（默认 /）。
  const altToolEntry = entries.find(e => e.action === 'altTool');
  // 「前景色拾色器」键（默认 Shift+/）：与工具模式无关，始终装载。
  const pickColorEntry = entries.find(e => e.action === 'pickColor');
  // 混合模式热键开关：配置里 blendHotkey 条目的 combo 非空 = 开（.8li 见之装载
  // 内置 Alt+Shift 表）。与工具模式无关，任何时刻都显示这一行。
  const blendHotkeyOn = !!entries.find(e => e.action === 'blendHotkey')?.combo;
  /* 0x0224：「按工具临时让位」——当前工具自带混合模式（画笔/渐变/涂抹…）时原生会让位，
     开关**显示成关位**并把副标题换成让位说明，但用户的开关值一个字节都没动
     （配置仍是开的；切回套索立刻显示回开位）。 */
  const blendGuard = useBlendGuard();
  const blendShownOn = blendHotkeyOn && !blendGuard.yielded;
  /* 笔刷大小预设开关（2026-11-20）：配置里 brushSizePreset 条目 combo 非空 = 开。
     ⛔ 与混合模式热键同一套编码（'1' / ''），不进「让位」机制：它本来就是给动笔类工具用的。 */
  const brushSizeOn = !!entries.find(e => e.action === 'brushSizePreset')?.combo;
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
  // 0x0224：`yielded` = 当前工具自带混合模式 ⇒ 原生让位、开关显示成关位并置灰。
  //   ⛔ 置灰而不是「假装关掉再点一下」：此刻显示的值不来自配置（配置仍是开的），
  //      让用户在这里点一下会写出「半真半假」的配置，切回套索后开关还会自己跳回来。
  const renderBlendSwitchRow = (key: string, on: boolean, yielded: boolean, toolCn: string | null) => {
    const toggle = () => {
      if (yielded) return;                       /* 置灰已拦一层，这里兜底 */
      if (!daemonConnected) { showMessage(helpTexts.funcHotkey.notConnected); return; }
      const nextOn = !on;
      if (setBlendHotkeyActive(nextOn)) {
        showMessage(nextOn
          ? (hotkeyArmedRef.current
            ? '混合模式热键已开启：按 Alt+Shift+字母（如 K=变暗、M=正片叠底）将改面板的选区填充混合模式'
            : '混合模式热键已开启，但热键当前暂停：' + armHint + '，才会生效')
          : '混合模式热键已关闭：Alt+Shift+字母恢复 PS 原生行为（改图层/工具混合模式）');
      } else {
        showMessage('推送配置失败：快捷键服务未连接，或配置路径尚未就绪（请重新加载插件后重试）');
      }
    };
    const rowTitle = yielded
      ? blendYieldHint(toolCn) + ' ' + helpTexts.funcHotkey.blendRow
      : helpTexts.funcHotkey.blendRow;
    return (
      <div
        key={key}
        className="hotkey-entry-row hotkey-entry-row-static"
        title={rowTitle}
      >
        <span className="hotkey-entry-name">混合模式热键</span>
        <span className="divider-vertical">丨</span>
        <span className="hotkey-entry-switch">
          <ToggleSwitch
            checked={on}
            onChange={toggle}
            disabled={yielded}
            title={yielded ? blendYieldHint(toolCn) : (on ? '关闭混合模式热键' : '开启混合模式热键')}
            aria-label="混合模式热键"
          />
        </span>
      </div>
    );
  };

  // 笔刷大小预设行（2026-11-20 用户要求）：与混合模式热键同为「自绘开关行」——
  // 右半列不是组合键而是 switch。⛔ 刻意不渲染任何副标题/说明行：
  //   · 用户同轮要求删掉混合热键那条让位说明（同一块面板的既有风格就是「一条开关只有一行」）；
  //   · 需要展开解释的口径全部放进 title（悬浮）与底部 notify-bar（点开关时的反馈）。
  const renderBrushSizeSwitchRow = (key: string, on: boolean) => {
    const toggle = () => {
      if (!daemonConnected) { showMessage(helpTexts.funcHotkey.notConnected); return; }
      const nextOn = !on;
      if (!setBrushSizePresetActive(nextOn)) {
        showMessage('推送配置失败：快捷键服务未连接，或配置路径尚未就绪（请重新加载插件后重试）');
        return;
      }
      if (!nextOn) {
        showMessage('笔刷大小预设已关闭：Shift+[ / Shift+] 恢复 Photoshop 原生行为（改笔尖硬度）');
        return;
      }
      const tiers = describeActiveDocTiers();
      const head = '笔刷大小预设已开启：Shift+[ 减小、Shift+] 增大'
        + (tiers ? '（当前文档档位 ' + tiers + '，随文档像素数缩放）' : '（档位随文档像素数缩放）');
      showMessage(hotkeyArmedRef.current
        ? head
        : head + '；但热键当前暂停：' + armHint + '，才会生效');
    };
    return (
      <div
        key={key}
        className="hotkey-entry-row hotkey-entry-row-static"
        title={helpTexts.funcHotkey.brushSizeRow}
      >
        <span className="hotkey-entry-name">笔刷大小预设</span>
        <span className="divider-vertical">丨</span>
        <span className="hotkey-entry-switch">
          <ToggleSwitch
            checked={on}
            onChange={toggle}
            title={on ? '关闭笔刷大小预设' : '开启笔刷大小预设'}
            aria-label="笔刷大小预设"
          />
        </span>
      </div>
    );
  };

  // 工具箱（scope='toolbox'）：按功能按钮实际所在的面板分区分组，标题 + 边框容器分开。
  // ⛔ 2026-11-16：按 scope 分工 ——「选区填充」整组归 APP 面板的「自定义快捷键」，
  //    其余分组留在绘画工具箱的「功能快捷键」。两边的行互不重复出现（移植而非复制）。
  const sectionGroups = FUNC_HOTKEY_SECTION_ORDER
    .map(sec => ({ title: sec, defs: FUNC_HOTKEY_DEFS.filter(d => d.section === sec) }))
    .filter(g => g.defs.length > 0)
    .filter(g => g.title !== '选区填充');
  const unordered = FUNC_HOTKEY_DEFS.filter(d => !FUNC_HOTKEY_SECTION_ORDER.includes(d.section));

  /* ===== APP 面板（scope='app'）：显式分块 =====
     用户 2026-11-16 指定的顺序（每块内部保持从上到下的语义顺序）：
       ① 选区填充两行（选区填充 H / 切换选区填充 Shift+H）
       ② 套索工具两行（套索工具 L / 切换套索工具 Shift+L）
       ③ 框选工具两行（矩形选框工具 M / 切换选框工具 Shift+M）
       ④ 混合模式热键 / 前景色拾色器 / 临时吸管
       ⑤ 切换填充模式 / 清除模式
     ⛔ 不再渲染 .func-group-title：面板标题已经是「自定义快捷键」，而首块标题「选区填充」
        与首行**同名**（用户截图圈出的「多余的选区填充」就是它）⇒ 块与块之间改用一条
        通用 `.divider`（与工具箱折叠分区内那条实线一致），信息量不减、纵向高度更省。
     ⚠️ 空块直接丢弃（②③⑤ 里的几行只在工具模式下存在）：不能留下孤立的分隔线。 */
  const renderFuncDefRow = (id: string, title: string) => {
    const def = FUNC_HOTKEY_DEFS.find(d => d.id === id);
    if (!def) return null;
    return renderRow('fk_' + def.id, funcEntryOf(def.id)?.combo || '', def.label, def.id, title);
  };
  const appBlocks: Array<{ key: string; rows: React.ReactElement[] }> = [];
  const pushBlock = (key: string, rows: Array<React.ReactElement | null | false>) => {
    const list = rows.filter((r): r is React.ReactElement => !!r);
    if (list.length) appBlocks.push({ key, rows: list });
  };
  // ① 选区填充：主开关行固定在最上，其后是五工具循环键（保持主开关开启）
  pushBlock('fill', [
    mainEntry
      ? renderRow(mainEntry.id, mainEntry.combo,
          focusMode ? '选区填充' : '选区填充开关', 'main', helpTexts.funcHotkey.mainRow)
      : renderRow('main_placeholder', '', focusMode ? '选区填充' : '选区填充开关', 'main', helpTexts.funcHotkey.mainRow),
    focusMode && renderRow('fill_tool_cycle', fillToolCycleEntry?.combo || '', '切换选区填充', 'fill_tool_cycle',
      helpTexts.funcHotkey.fillToolCycleRow),
  ]);
  // ② 套索工具：按下即关主开关并切回套索（使 H / L 像两个工具）；Shift+L 在套索组内循环
  pushBlock('lasso', [
    focusMode && renderRow('focus_lasso', focusLassoEntry?.combo || '', '套索工具', 'focus_lasso',
      helpTexts.funcHotkey.lassoRow),
    focusMode && renderRow('lasso_cycle', lassoCycleEntry?.combo || '', '切换套索工具', 'lasso_cycle',
      helpTexts.funcHotkey.lassoCycleRow),
  ]);
  // ③ 框选工具：矩形选框键（强制矩形）/ 选框组循环（矩形 ↔ 椭圆），两者都关主开关
  pushBlock('marquee', [
    focusMode && renderRow('marquee_tool', focusMarqueeEntry?.combo || '', '矩形选框工具', 'marquee_tool',
      helpTexts.funcHotkey.marqueeRow),
    focusMode && renderRow('marquee_cycle', marqueeCycleEntry?.combo || '', '切换选框工具', 'marquee_cycle',
      helpTexts.funcHotkey.marqueeCycleRow),
  ]);
  // ④ 混合模式热键（自绘开关行）/ 前景色拾色器 / 临时吸管
  pushBlock('picking', [
    renderBlendSwitchRow('blend_hotkey', blendShownOn, blendGuard.yielded, blendGuard.toolCn),
    renderRow('pick_color', pickColorEntry?.combo || '', '前景色拾色器', 'pick_color', helpTexts.funcHotkey.pickerRow),
    focusMode && renderRow('alt_tool', altToolEntry?.combo || '', '临时吸管', 'alt_tool', helpTexts.funcHotkey.pickRow),
  ]);
  // ⑤ 填充模式轮换（默认 Ctrl+滚轮）/ 清除模式（默认 Shift+E，确保主开关开启）
  pushBlock('mode', [
    renderFuncDefRow('fillModeCycle', helpTexts.funcHotkey.fillModeRow),
    focusMode && renderRow('focus_clear', focusClearEntry?.combo || '', '清除模式', 'focus_clear',
      helpTexts.funcHotkey.clearRow),
  ]);
  /* ⑥ 笔刷大小预设（2026-11-20）：Shift+[ / Shift+] 按档位改笔尖直径。
     单独成块排在最后：它服务的是「动笔类工具」，与上面五块的选区/填充/拾色语义无关，
     混进 ④⑤ 会让「这一块在讲什么」变得说不清。 */
  pushBlock('brushSize', [
    renderBrushSizeSwitchRow('brush_size_preset', brushSizeOn),
  ]);

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
            <span>{panelTitle}</span>
            <div role="button" tabIndex={0} className="close-button" title={closeTitle} onClick={onClose}>×</div>
          </div>

          {!daemonConnected && (
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>{helpTexts.funcHotkey.notConnected}</div>
          )}
          {daemonConnected && !hotkeyArmed && (
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>热键已暂停：快捷键暂不生效（录制前{armHint}）</div>
          )}
        </div>

        <div className="func-hotkey-list">
        {/* 两块面板两种排法（同一个组件，差异只来自 scope）：
            · APP「自定义快捷键」：显式分块 + 分隔线（顺序由用户指定，见 appBlocks 说明）；
            · 工具箱「功能快捷键」：按功能所在分区分组，保留分组标题。
            ⛔ 2026-11-16：原来紧随其后的「纯色 / 图案 / 渐变面板开关」三行已删除，
               改为单行「切换填充模式」（默认 Ctrl+滚轮）——单独开关某个子面板没有意义。 */}
        {forApp && (
          /* 单张卡片 + 卡内分隔线（不是五张带边框的卡片）：
             用户要的是「同一个列表按顺序排好、块与块之间有条线」，五张卡各带边框会变成
             「框-线-框-线」的双重装饰，纵向也更挤。
             行距沿用 .hotkey-entry-row + .hotkey-entry-row 的 6px；跨块处由分隔线自身的
             上下外边距（10px）接管 —— 相邻选择器被分隔元素隔断，不会叠加成 16px。 */
          <div className="border-panel-section">
            {appBlocks.map((b, i) => (
              <React.Fragment key={'blk_' + b.key}>
                {/* 块间分隔线：直接用通用 `.divider`（2026-11-16 用户要求改成与绘画工具箱
                    折叠分区内那条实线完全一致的外观）。
                    ⛔ 为什么不再自绘 `.func-group-sep`：那条用的是 currentColor + opacity，
                       半透明叠在卡片底色上，既不是边框色、也到不了卡片左右边框；
                       `.divider` 是 1px `background-color: var(--border-color)`，
                       而 `.border-panel-section .divider` 会把宽度补成 calc(100% + 20px)
                       并向左右各拉 -10px ⇒ **两端正好压在卡片左右边框上**，颜色随主题
                       与边框完全同色。一份样式两处复用，不必再维护第二套。 */}
                {i > 0 && <div className="divider" />}
                {b.rows}
              </React.Fragment>
            ))}
          </div>
        )}
        {!forApp && sectionGroups.map(g => (
          <React.Fragment key={'grp_' + g.title}>
            <div className="func-group-title">{g.title}</div>
            <div className="border-panel-section">
              {/* 行 + 行的分隔线（2026-11-16 用户要求）：
                  位置与折叠分区内功能按钮之间的分割线一一对应、样式也一样
                  （实线用通用 `.divider`，虚线用 DashedDivider）—— 对照表是
                  funcHotkeyDefs.ts 的 FUNC_HOTKEY_DIVIDERS，改那边布局就要同步那张表。
                  ⚠️ 分隔线**跟着行走**放在同一张卡片里：卡片外的线会被卡片边框截断，
                     两端压不到容器左右边框上（上一轮 APP 侧踩过这个）。 */}
              {g.defs.map(def => {
                const row = renderRow('fk_' + def.id, funcEntryOf(def.id)?.combo || '', def.label, def.id,
                  def.id === 'fillModeCycle' ? helpTexts.funcHotkey.fillModeRow : helpTexts.funcHotkey.rowHint);
                const sep = FUNC_HOTKEY_DIVIDERS[def.id];
                if (!sep) return row;
                return (
                  <React.Fragment key={'fk_sep_' + def.id}>
                    {row}
                    {sep === 'dashed' ? <DashedDivider /> : <div className="divider" />}
                  </React.Fragment>
                );
              })}
            </div>
          </React.Fragment>
        ))}
        {!forApp && unordered.length > 0 && (
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
