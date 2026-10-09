import React from 'react';
import { interaction, storage } from 'uxp';
import { app, action, core } from 'photoshop';
import { BLEND_MODES } from './constants/blendModes';
import { BLEND_MODE_OPTIONS } from './constants/blendModeOptions';
import { AppState, initialState, Gradient, CompactModes, CompactScope, initialCompactModes } from './types/state';
import { DragHandler } from './utils/DragHandler';
import { FillHandler } from './utils/FillHandler';
import { LayerInfoHandler, invalidateLayerInfoCache, shouldInvalidateLayerInfo } from './utils/LayerInfoHandler';
import { ClearHandler } from './utils/ClearHandler';
import ColorSettingsPanel from './components/ColorSettingsPanel';
import PatternPicker from './components/PatternPicker';
import GradientPicker from './components/GradientPicker';
import StrokeSetting from './components/StrokeSetting';
import ClearSetting from './components/ClearSetting';
import Select from './components/Select';
import LicenseDialog from './components/LicenseDialog';
import RangeSlider from './components/RangeSlider';
import IconButton from './components/IconButton';
import { LicenseManager } from './utils/LicenseManager';
import { ExpandIcon, SettingsIcon, FocusTargetIcon } from './styles/Icons';
import { calculateRandomColor, hsbToRgb, rgbToGray } from './utils/ColorUtils';
import { pickColorWithInitial } from './utils/ColorPicker';
import { strokeSelection } from './utils/StrokeSelection';
import { PatternFill } from './utils/PatternFill';
import { GradientFill } from './utils/GradientFill';
import { SingleChannelHandler } from './utils/SingleChannelHandler';
import { SelectionHandler, SelectionOptions } from './utils/SelectionHandler';
import { LayerInfo } from './utils/LayerInfoHandler';
import { ColorSettings, Pattern } from './types/state';
import { MenuManager } from './utils/MenuManager';
import { PresetManager } from './utils/PresetManager';
import { PanelStateManager } from './utils/PanelStateManager';
import {
  connectHotkeyDaemon,
  isDaemonConnected, getMainToggleCombo, setMainToggleCombo, requestHotkeyRecording,
  getSelectedBrushToolEnum
} from './hotkey/HotkeyBridge';
import { seedMainToggle, setMainToggle, subscribeMainToggle } from './utils/MainToggleBus';
import { FillPanelId, subscribeFillPanelToggle } from './utils/FillPanelToggleBus';
import { setFocusMode } from './utils/FocusModeBus';
import {
  debouncePsProbe, isPsBusy, markPsBusyForEvent, psBusyRemain, runWhenIdle,
  markPsBusy, fillReadyRemain,
  // 文档级变化（打开/关闭/切文档）的显式登记入口：供「活动文档 id 巡检」兜底通路使用。
  noteDocLevelEvent,
  // 文档级「持续忙碌」闩锁：时间常数堵不住「打开/关闭大文档要好几秒」，
  // 闩锁期间粗筛恒为真 ⇒ 连未走 psRead 的裸读也一起退避；释放靠模态探测。
  isDocLatchActive, endDocLatch, extendDocLatch,
  // 闩锁的「最短保持」判定：打开大文档是**分阶段**的，宿主可能在阶段间隙里
  // 短暂松开模态锁 ⇒ 光靠一次成功的探测不足以放行（见 advanceDocLatch）。
  isDocLatchMinHoldElapsed
} from './utils/psProbe';
import {
  // PS 访问层：所有「失败即弹宿主原生框」的读取都必须经它（模态作用域兜底正确性）。
  psRead, psTryRead,
  // 进入本插件模态作用域的**唯一入口**：它维护「自家模态计数」，是 psRead 直读分支
  // 的判据来源（不能再依赖 core.isModal()，见 psAccess.isInOwnModalScope 的取证说明）。
  runAsModal,
  // 宿主空闲探测：**只拿锁不读数据**，是文档级闩锁唯一的释放判据。
  probeHostIdle,
  // 通知注册：逐事件名容错，且事件名单含 open/close/save（见 PS_NOTIF_EVENTS 的根因说明）。
  addPsNotificationListeners, removePsNotificationListeners
} from './utils/psAccess';
import { invalidateLayerSnapshot } from './utils/layerTreeSnapshot';
import ToggleSwitch from './components/ToggleSwitch';
import RadioGroup, { RadioOption } from './components/RadioGroup';
import { helpTexts } from './constants/helpTexts';

const { batchPlay } = action;

/**
 * 填充失败后的降级重试冷却（毫秒）。
 *
 * 填充路径的正常冷却是 `fillReadyRemain()`（私有、约 60ms）；
 * 万一仍撞上宿主忙碌期（极长命令 / 大文档 / 刚删完图层就套索），
 * 用这个保守值再等一次再试。
 */
const FILL_RETRY_GUARD_MS = 400;

/**
 * 「填充模式」三列 radio 的选项表：模块级常量（保持引用稳定，
 * 免得每次渲染重建数组让 React.memo 失效）。
 * ⚠️ 必须放模块级：helpTexts 在 import 之后才可用，
 *    放组件体内会成为「渲染期立即执行区」的 TDZ 隐患（本项目 target=es5）。
 */
const FILL_MODE_RADIO_OPTIONS: RadioOption[] = [
    { value: 'foreground', label: '纯色', title: helpTexts.selectionFill.fgCompact },
    { value: 'pattern', label: '图案', title: helpTexts.selectionFill.patternCompact },
    { value: 'gradient', label: '渐变', title: helpTexts.selectionFill.gradientCompact },
];

/* --------------------------------------------------------------------------
   UXP 原生控件收口（与绘画工具箱 AdjustmentPanel 同一套机制）
   原生 input / textarea / sp-textfield 永远绘制在同面板最上层，z-index /
   overflow / max-height 都压不住，只能隐藏。折叠前先就地写内联
   visibility/opacity/pointer-events !important，再让 React 卸载内容，
   即便 UXP 残留旧原生视图，残留的也是隐藏态；折叠/展开后再轻滚 1px 逼重排。
   -------------------------------------------------------------------------- */
const NATIVE_WIDGET_SELECTOR = 'input, textarea, sp-textfield, [contenteditable="true"]';

const hideNativeWidgetsIn = (container: Element | null | undefined) => {
  if (!container) return;
  let list: NodeListOf<Element>;
  try { list = container.querySelectorAll(NATIVE_WIDGET_SELECTOR); } catch { return; }
  for (let i = 0; i < list.length; i++) {
    const s = (list[i] as HTMLElement).style;
    s.setProperty('visibility', 'hidden', 'important');
    s.setProperty('opacity', '0', 'important');
    s.setProperty('pointer-events', 'none', 'important');
  }
};

const hideNativeWidgetsOfSections = (root: HTMLElement | null, ids: string[]) => {
  if (!root) return;
  ids.forEach(id => {
    try { hideNativeWidgetsIn(root.querySelector(`[data-section-id="${id}"]`)); } catch { /* 选择器异常忽略 */ }
  });
};

// ⚠️ 性能（2026-10-06）：读 scrollHeight/clientHeight 会触发**强制同步布局**。
// 旧实现每次调用都排一个 rAF，同一帧内多次触发会重复强制重排
// （例如「折叠/展开所有分区」会连续调用两次）。这里做帧内幂等合并。
let resyncScheduled = 0;

const doResyncNativeWidgets = (root: HTMLElement | null) => {
    if (!root) return;
    const max = root.scrollHeight - root.clientHeight;
    if (max <= 0) return; /* 无溢出时跳过，避免抖动 */
    const t = root.scrollTop;
    root.scrollTop = t < max ? t + 1 : Math.max(0, t - 1);
    const restore = () => { root.scrollTop = t; };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else restore();
};

const resyncNativeWidgets = (root: HTMLElement | null) => {
    if (resyncScheduled) return;
    const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (!schedule) { doResyncNativeWidgets(root); return; }
    resyncScheduled = schedule(() => {
        resyncScheduled = 0;
        doResyncNativeWidgets(root);
    });
};

interface AppProps {}

class App extends React.Component<AppProps, AppState> {
    private unsubMainToggle: (() => void) | null = null;
    // 功能快捷键：纯色/图案/渐变子面板开关注订器（FillPanelToggleBus 轮询分发，卸载时退订）
    private unsubFillPanelToggle: (() => void) | null = null;
    private isFilling = false;
    private pendingSelection = false;
    private maskProbeDebounced: (...args: any[]) => void = () => { };
    private isInLayerMask = false;
    private isInQuickMask = false;
    private isInSingleColorChannel = false;
    private selectionChangeListener: any = null;
    // 选区填充的忙碌顺延（见 handleSelectionChange 顶部的闸门说明）
    private selectionRetryTimer: any = null;
    private selectionBusyDeferrals = 0;
    // 「撞上宿主忙碌期 → 长窗口重试」的闸门，防止缩短忙碌窗口后偶发丢填充。
    // ⚠️ 上限 1 次：必须是**有界**重试，否则宿主持续忙碌时会变成无限重试循环
    // （每次失败都再排一个 timer，永远停不下来）。
    private selectionRetryCount = 0;
    // ===== 活动文档身份巡检（文档级事件覆盖的**兜底通路**）=====
    // 为什么需要：`open` / `close` 这两个事件名是唯一无法在本仓离线验证的假设
    // （UXP 的事件名存在重命名先例）。万一某宿主版本不派发它们，切文档期间
    // `isPsBusy()` 会恒为 false ⇒ 轮询照常发 get ⇒ 弹框。
    // 巡检每 500ms 读一次 `app.activeDocument.id`（一次廉价属性读，经 psRead 保护），
    // 发现 id 变了就按「文档级变化」处理：世代号 ++ / 打长静默窗口 / 清缓存。
    // ⚠️ 2026-10-08 第二轮起它还承担**第二个职责**：文档级闩锁生效期间，它是唯一被
    // 允许继续跑的通路，负责用「空模态请求」探测宿主是否已空闲，从而**释放**闩锁
    // （见 advanceDocLatch）。两条职责共用这一个定时器，避免多一个轮询源。
    private docWatchTimer: any = null;
    private lastDocId: number | null = null;
    /** 闩锁探测的并发守卫（探测可能排队 300ms，防重叠）。 */
    private docLatchProbeBusy = false;
    /** 闩锁探测的自调度定时器（同一个时刻只允许一个 pending）。 */
    private docLatchProbeTimer: any = null;
    /** 上一次「探测成功」的时刻（0 = 尚无）；用于要求**连续多次**成功才放行。 */
    private docLatchLastOkAt = 0;
    /** 连续成功的**次数**（任一失败即清零）。见 DOC_LATCH_CONFIRM_COUNT。 */
    private docLatchOkStreak = 0;
    /** 探测**连续失败**的次数（成功即清零）——驱动探测间隔的指数退避。 */
    private docLatchProbeFailures = 0;
    // 面板状态持久化门闩：componentDidMount 里 PanelStateManager.initialize 异步读取完成之前，
    // MainToggleBus 轮询（250ms）等来源就可能 setState isEnabled 触发 componentDidUpdate 的
    // 「有变更即保存」逻辑——用默认值整体覆盖 panel-state.json，把用户已保存的
    // 自动关开关/自动切套索等选项冲掉（表现为这些开关重启后不持久化）。加载完成前禁止保存。
    private panelStateLoaded = false;
    // 主面板滚动容器（挂 .panel 类）引用，用于折叠/展开后逼 UXP 重排原生控件坐标
    private panelRef = React.createRef<HTMLDivElement>();
    // ===== 工具巡检（「自动关」的兜底通道，详见 pollToolChange 注释）=====
    private toolWatchTimer: any = null;
    private toolWatchBusy = false;
    private toolWatchBusySince = 0;
    private lastKnownTool: string | null = null;
    // ===== 快速蒙版巡检 =====
    // 复合根因（2026-09-10 定位）：
    //   ① checkMaskModes() 原先只写 this.isInQuickMask（实例字段）+ forceUpdate，
    //      而开关的禁用态渲染读的是 state.isInQuickMask —— 通知通道即便拿到了新值，
    //      界面也永远不会变（已改为回写 state）。
    //   ② PS 按 Q 进出快速蒙版**不派发 set/select/make/delete 任何通知**，事件通道拿不到，
    //      只能等下一次选区变更（handleSelectionChange）顺带刷新。
    // 兜底：只读 activeDocument.quickMaskMode（廉价属性，与选中工具巡检同一类读法），
    // 且仅在「填充选项」展开可见时轮询 —— 不可见时没有刷新的必要。
    private quickMaskTimer: any = null;
    private quickMaskBusy = false;
    private static readonly QUICK_MASK_WATCH_INTERVAL_MS = 300;
    /**
     * 活动文档身份巡检间隔（毫秒）。
     * 500ms ⇒ 每秒 2 次廉价属性读，代价可忽略；而它兜住的是「文档级事件
     * 未被派发/未被识别」这一最坏情况 —— 那条路径一旦漏掉就是必弹框。
     */
    private static readonly DOC_WATCH_INTERVAL_MS = 500;
    /**
     * 闩锁期间「宿主空闲探测」的排队时限（毫秒）。
     *
     * 探测本身就是一次 `executeAsModal` 空请求（**不读任何数据**）：
     *   · 拿得到锁 ⇒ 宿主已可控 ⇒ 释放闩锁；
     *   · 拿不到（排队超时）⇒ 宿主仍在自己的模态作用域里 ⇒ 续期闩锁。
     * 取 300ms 是为了「快速失败、下一个周期再来」：巡检间隔 500ms，
     * 两者叠加相当于每半秒问一次，既不会堆积请求，也能在大文档就绪后迅速放行。
     */
    private static readonly DOC_LATCH_PROBE_TIMEOUT_MS = 300;
    /**
     * 两次「探测成功」的间隔上限（毫秒）：只有在该时限内的**连续两次**成功
     * 才认定宿主真的空闲。超过 ⇒ 视为新的探测序列，再确认一次。
     */
    private static readonly DOC_LATCH_CONFIRM_MS = 1200;
    /**
     * 闩锁期间两次探测之间的间隔（毫秒）。
     * 400ms ⇒ 一次快速切文档最多被多压 ~0.8s（首探 + 确认），而大文档打开期间
     * 相当于每 0.4s 问一次「好了吗」，既不会堆积请求，也能在就绪后迅速放行。
     */
    private static readonly DOC_LATCH_PROBE_MS = 400;
    /**
     * 闩锁探测的**指数退避**上限档位。
     *
     * 探测本身就是一次 `executeAsModal`（只拿锁不读数据）。固定 400ms 间隔在
     * 「打开 400MB PSD 要几十秒」的场景下 = 几十次模态命令，UXP 会打内部警告
     * 「Too many modal scope commands」（uxp-internal/ps-common.js，真机已复现 60 次）。
     * 对策：探测连续失败时把间隔翻倍（400→800→1600→3200 封顶）；一旦某次成功
     * 立即清零退避 —— 确认阶段（连续 3 次、间隔 ≤1200ms）回到 400ms 快速连测，
     * 放行延迟几乎不受影响。
     */
    private static readonly DOC_LATCH_PROBE_MAX_SHIFT = 3;

    /**
     * 闩锁放行所需的**连续成功探测次数**。
     *
     * ⚠️ 为什么不是 1：打开大文档是**分阶段**的（解析 → 建树 → 生成缩略图 → 建窗口），
     * 宿主完全可能在某些阶段之间短暂松开模态锁 —— 那一刻探测会成功，但紧接着发起的
     * 读取照样撞回忙碌窗口。要求连续多次成功（任一次失败即清零）才能过滤掉这类间隙。
     */
    private static readonly DOC_LATCH_CONFIRM_COUNT = 3;
    /**
     * 闩锁的**最短保持时长**（毫秒）。
     *
     * 只有「文档级事件」或「读取失败」进入的闩锁才要求它（那两种情况都有正在跑的
     * 重命令）。「身份巡检首次发现文档」进入的闩锁不要求 —— 那时我们刚成功读到
     * 宿主的回答，宿主并不忙，强制多等只是白白拖慢插件启动后的首次刷新。
     */
    private static readonly DOC_LATCH_MIN_HOLD_MS = 1500;

    /**
     * 专注模式：APP 父面板里「自动关开关」+「自动切套索」同时勾选即自动成立，任一取消即退出。
     * 它不是用户直接勾选的选项，而是一个推导结论：
     *   1. 主开关的圆点换成星形图标；
     *   2. 主开关热键变成「只开不关」（MainToggleBus 里读共享状态决定）；
     *   3. 绘画工具箱笔刷热键分区里置顶那条记录的文案改为「选区填充」。
     * 后两项发生在别的 JS 上下文，所以结论要写进共享文件（FocusModeBus）供它们读取。
     */
    private focusModeWritten: boolean | null = null;

    private isFocusMode(): boolean {
        return this.state.autoOffOnOtherTool && this.state.switchToLassoOnEnable;
    }

    /**
     * 把专注模式结论同步到共享总线（值没变就不写，避免无谓的文件 I/O）。
     *
     * @param explicit 已知结论时直接传入，**跳过读 this.state**。
     *   ⛔ 启动期必须用它：componentDidMount 里 setState 之后紧跟着调用本方法时，
     *   React 的自动批处理让 this.state 仍是**旧值**（默认 false/false）——
     *   直接读会把 false 写进共享文件（把上次会话留下的 true 覆盖掉），
     *   随后 componentDidUpdate 才纠回 true。中间窗口里 MainToggleBus 读到的
     *   是 false ⇒ 主开关热键短暂失去「只开不关」语义（专注模式下的关键行为）。
     */
    private syncFocusMode(explicit?: boolean) {
        const on = explicit !== undefined ? explicit : this.isFocusMode();
        if (this.focusModeWritten === on) return;
        this.focusModeWritten = on;
        void setFocusMode(on).catch(e => console.warn('⚠️ 专注模式状态同步失败:', e));
    }

    /**
     * 紧凑模式（右上角菜单切换，默认全关，随面板状态持久化）：
     * 5 个作用域各自独立开关、互不干扰——选区填充父面板 + 纯色/图案/渐变/描边 4 个子面板，
     * 哪一层的开关就只影响哪一层（父面板的 divider 与子面板的 divider 互不相干）。
     * 菜单项只作用于「当前面板」：有子面板打开时是那个子面板，否则是父面板，
     * 因此菜单文案必须写明是「哪个面板」以及它「此刻开还是关」。
     * 实现走 body 上的 compact-{scope} 类（与本文件既有的 secondary-panel-open /
     * license-dialog-open 同一套做法），具体隐藏规则见 app.css。
     */
    private static readonly COMPACT_CLASS: Record<CompactScope, string> = {
        app: 'compact-app',
        color: 'compact-color',
        pattern: 'compact-pattern',
        gradient: 'compact-gradient',
        stroke: 'compact-stroke',
        clear: 'compact-clear',
    };

    /** 各作用域在菜单文案里的面板名 */
    private static readonly COMPACT_NAME: Record<CompactScope, string> = {
        app: '选区填充',
        color: '纯色',
        pattern: '图案',
        gradient: '渐变',
        stroke: '描边',
        clear: '清除',
    };

    /** 给定状态下菜单项应作用的作用域：任一子面板打开时是它，否则是父面板 */
    private compactScopeOf(s: AppState): CompactScope {
        if (s.isStrokeSettingOpen) return 'stroke';
        if (s.isClearSettingOpen) return 'clear';
        if (s.isPatternPickerOpen) return 'pattern';
        if (s.isGradientPickerOpen) return 'gradient';
        if (s.isColorSettingsOpen) return 'color';
        return 'app';
    }

    private currentCompactScope(): CompactScope {
        return this.compactScopeOf(this.state);
    }

    /** 切换「当前面板」的紧凑模式（同一时刻只动一个作用域） */
    toggleCompactMode() {
        const scope = this.currentCompactScope();
        this.setState(prev => {
            const next: CompactModes = { ...prev.compactModes };
            next[scope] = !next[scope];
            return { compactModes: next };
        });
    }

    /** 把 5 个作用域的开/关逐一落到 body 类上（幂等，可重复调用） */
    private syncCompactModeClasses() {
        const scopes = Object.keys(App.COMPACT_CLASS) as CompactScope[];
        for (const scope of scopes) {
            const cls = App.COMPACT_CLASS[scope];
            if (this.state.compactModes && this.state.compactModes[scope]) {
                document.body.classList.add(cls);
            } else {
                document.body.classList.remove(cls);
            }
        }
    }

    /** 菜单文案：`紧凑模式：{面板名}·{开/关}`（如「紧凑模式：图案·开」） */
    private syncCompactMenuLabel() {
        const scope = this.currentCompactScope();
        const on = !!(this.state.compactModes && this.state.compactModes[scope]);
        MenuManager.setCompactModeLabel(
            `紧凑模式：${App.COMPACT_NAME[scope]} - ${on ? '开' : '关'}`
        );
    }

    constructor(props: AppProps) {
        super(props);
        this.state = initialState;
        
        this.handleSelectionChange = this.handleSelectionChange.bind(this);
        this.handleOpacityChange = this.handleOpacityChange.bind(this);
        this.handleFeatherChange = this.handleFeatherChange.bind(this);
        this.handleBlendModeChange = this.handleBlendModeChange.bind(this);
        this.toggleAutoUpdateHistory = this.toggleAutoUpdateHistory.bind(this);
        this.handleButtonClick = this.handleButtonClick.bind(this);
        this.toggleDeselectAfterFill = this.toggleDeselectAfterFill.bind(this);
        this.toggleSwitchToLassoOnEnable = this.toggleSwitchToLassoOnEnable.bind(this);
        this.toggleAutoOffOnOtherTool = this.toggleAutoOffOnOtherTool.bind(this);
        this.handleLabelMouseDown = this.handleLabelMouseDown.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.toggleCreateNewLayer = this.toggleCreateNewLayer.bind(this);
        this.toggleClearMode = this.toggleClearMode.bind(this);
        this.toggleCompactMode = this.toggleCompactMode.bind(this);
        this.toggleColorSettings = this.toggleColorSettings.bind(this);
        this.openPatternPicker = this.openPatternPicker.bind(this);
        this.openGradientPicker = this.openGradientPicker.bind(this);
        this.handleColorSettingsSave = this.handleColorSettingsSave.bind(this);
        this.handlePatternSelect = this.handlePatternSelect.bind(this);
        this.handleGradientSelect = this.handleGradientSelect.bind(this);
        this.handleFillModeChange = this.handleFillModeChange.bind(this);
        this.toggleExpand = this.toggleExpand.bind(this);
        this.closeColorSettings = this.closeColorSettings.bind(this);
        this.closePatternPicker = this.closePatternPicker.bind(this);
        this.closeGradientPicker = this.closeGradientPicker.bind(this);
        this.closeStrokeSetting = this.closeStrokeSetting.bind(this);
        this.toggleStrokeEnabled = this.toggleStrokeEnabled.bind(this);
        this.toggleStrokeSetting = this.toggleStrokeSetting.bind(this);
        this.closeClearSetting = this.closeClearSetting.bind(this);
        this.toggleClearSetting = this.toggleClearSetting.bind(this);
        // 新增绑定
        this.toggleSelectionOptions = this.toggleSelectionOptions.bind(this);
        this.handleSelectionSmoothChange = this.handleSelectionSmoothChange.bind(this);
        this.handleSelectionContrastChange = this.handleSelectionContrastChange.bind(this);
        this.handleSelectionExpandChange = this.handleSelectionExpandChange.bind(this);
        this.handleNotification = this.handleNotification.bind(this);
        // 事件触发的蒙版/通道状态探测改为防抖执行（见 utils/psProbe.ts 根因说明）：
        // 合并图层等 PS 命令中途派发的事件若立刻 get 会撞忙碌窗口，弹出宿主报错框
        this.maskProbeDebounced = debouncePsProbe(async () => {
            await this.checkMaskModes();
            this.forceUpdate();
        });
        // 许可证相关方法绑定
        this.handleLicenseVerified = this.handleLicenseVerified.bind(this);
        this.handleTrialStarted = this.handleTrialStarted.bind(this);
        this.closeLicenseDialog = this.closeLicenseDialog.bind(this);
        this.checkLicenseStatus = this.checkLicenseStatus.bind(this);
        this.openLicenseDialog = this.openLicenseDialog.bind(this);
        this.resetLicenseForTesting = this.resetLicenseForTesting.bind(this);
 
    }

    async componentDidMount() {
        // ===== 全局快捷键链路：必须最先建立 =====
        // 这段绝不能放在任何 await 之后。componentDidMount 下面还有一连串 await
        // （文件系统探测、事件监听注册、蒙版模式检测…），任何一个抛错或卡住，
        // 后面的代码都不会执行——历史上正是因此出现「笔刷面板有热键提示、
        // 主面板开关纹丝不动」：面板看起来完全正常，实际上连守护进程都没连上。
        // 另外，UXP 各面板是独立 JS 上下文，热键可能只被绘画工具箱面板收到，
        // 所以主开关统一改由 MainToggleBus（共享文件）同步，不依赖本面板的 WebSocket。
        try {
            connectHotkeyDaemon();
            this.unsubMainToggle = subscribeMainToggle((st) => {
                if (typeof st?.enabled === 'boolean' && st.enabled !== this.state.isEnabled) {
                    const prev = this.state.isEnabled;
                    this.setState({ isEnabled: st.enabled });
                    void this.onMainToggleChanged(prev, st.enabled);
                }
            });
            // 功能快捷键：三个子面板开关（纯色/图案/渐变）的热键通路。
            // 命令经共享文件 + token 去重后到达这里，翻的本来就是本面板自己的 state。
            this.unsubFillPanelToggle = subscribeFillPanelToggle((panel) => {
                this.applyFillPanelHotkey(panel);
            });
        } catch (e) {
            console.error('⚠️ 建立热键链路失败:', e);
        }

        // 测试文件系统访问权限（禁用自动写入测试以避免干扰首次加载）
        console.log('🔍 开始测试文件系统访问权限...');
        try {
            const hasFileAccess = await PresetManager.testFileSystemAccess();
            if (!hasFileAccess) {
                console.error('❌ 文件系统访问权限测试失败，预设功能可能无法正常工作');
            } else {
                // 🚫 暂时禁用：避免在启动阶段对预设文件进行写入测试，干扰加载顺序
                // console.log('🧪 文件系统访问正常，开始测试预设保存功能...');
                // await PresetManager.testPresetSaving();
            }
        } catch (error) {
            console.error('❌ 文件系统访问权限测试异常:', error);
        }
        
        // 注册主面板菜单回调
        MenuManager.registerAppCallbacks({
            onOpenLicenseDialog: this.openLicenseDialog,
            onResetLicense: this.resetLicenseForTesting,
            onResetParameters: () => {
                // 保留图案与渐变预设，仅复位其它参数
                const keepPattern = this.state.selectedPattern;
                const keepGradient = this.state.selectedGradient;
                // 使用 initialState 作为基准，保留需要保留的项
                this.setState({
                    ...initialState,
                    selectedPattern: keepPattern,
                    selectedGradient: keepGradient,
                    // 选项类开关不属于「参数」，复位时保持用户当前选择（含持久化语义，勿回默认值）
                    deselectAfterFill: this.state.deselectAfterFill,
                    autoUpdateHistory: this.state.autoUpdateHistory,
                    switchToLassoOnEnable: this.state.switchToLassoOnEnable,
                    autoOffOnOtherTool: this.state.autoOffOnOtherTool,
                    strokeEnabled: this.state.strokeEnabled,
                    createNewLayer: this.state.createNewLayer,
                    // 清除算法属于「用户选项」而非「参数」：复位不应把用户选好的
                    // 减法 / 乘法 / 趋白打回默认值（与 deselectAfterFill 等同理）。
                    clearBackgroundAlgorithm: this.state.clearBackgroundAlgorithm,
                    clearChannelAlgorithm: this.state.clearChannelAlgorithm,
                    clearLayerAlgorithm: this.state.clearLayerAlgorithm,
                    // 复位信号自增：纯色/图案/渐变三个子面板的参数在它们各自的组件
                    // 内部 state 里（父面板复位管不到），靠这个信号通知它们回到默认值。
                    // ⚠️ 必须写在 ...initialState 之后：initialState.resetToken 恒为 0，
                    //    放在展开之前会被覆盖成 0，三个子面板收到 0 而不触发复位。
                    resetToken: this.state.resetToken + 1,
                    // UI 相关展开/面板开关保持为当前值以避免打断用户操作
                    isColorSettingsOpen: this.state.isColorSettingsOpen,
                    isPatternPickerOpen: this.state.isPatternPickerOpen,
                    isGradientPickerOpen: this.state.isGradientPickerOpen,
                    isStrokeSettingOpen: this.state.isStrokeSettingOpen,
                    isExpanded: this.state.isExpanded,
                    // 授权状态不应被参数复位影响
                    isLicensed: this.state.isLicensed,
                    isTrial: this.state.isTrial,
                    isLicenseDialogOpen: this.state.isLicenseDialogOpen,
                    trialDaysRemaining: this.state.trialDaysRemaining,
                    // 紧凑模式是界面开关（5 个作用域各自独立），不属于「参数」，复位时保持用户当前选择
                    compactModes: this.state.compactModes,
                });
            },
            onToggleCompactMode: () => { this.toggleCompactMode(); },
            onSetMainHotkey: () => { void this.setMainHotkey(); },
            onShowVisibilityPanel: () => { this.openVisibilityPanel(); }
        });
        this.selectionChangeListener = (eventName, descriptor) => {
            // ⚠️ 事件到达瞬间先打忙碌标记（回调内唯一允许做的事，不碰 DOM）：
            // 后面 handleSelectionChange 会读 app.activeDocument / 选区，必须知道 PS 正忙。
            markPsBusyForEvent(eventName, descriptor);
            // 检查是否是选区相关的set事件
            if (descriptor && descriptor._target && Array.isArray(descriptor._target)) {
                const isSelectionEvent = descriptor._target.some(target =>
                    target._ref === 'channel' && target._property === 'selection'
                );

                if (isSelectionEvent) {
                    this.handleSelectionChange(descriptor);
                } else {
                    console.log('🔍 非选区设置事件，跳过处理');
                }
            }
        };
        await action.addNotificationListener(['set'], this.selectionChangeListener);
        document.addEventListener('mousemove', this.handleMouseMove);
        document.addEventListener('mouseup', this.handleMouseUp);
        
        // 初始化状态检测
        // ⚠️ 走 runWhenIdle（有限顺延）：插件挂载瞬间 PS 正在创建面板与初始化文档，
        // 是忙碌峰值；此处直接 get 会弹宿主「命令"获取"当前不可用」。
        //顺延到空闲后再读；上限 12 次保证不会永远不执行。
        const initialMaskProbe = runWhenIdle(() => { void this.checkMaskModes(); }, 300, 12);
        initialMaskProbe();
        // 快速蒙版巡检（PS 不派发通知，只能轮询兜底；按展开/可见状态启停）
        this.syncQuickMaskWatch();
        // 活动文档身份巡检（文档级事件的兜底通路，见 docWatchTimer 字段注释）
        this.startDocWatch();
        
        // 监听Photoshop事件来检查状态变化
        // ⚠️ 事件名单与注册方式统一走 psAccess（唯一事实来源）：名单里含 `open` /
        // `close`（历史上全仓无人注册 ⇒ 开关文档全程无闸门，必弹框），并且**逐个
        // 注册**——UXP 对数组里的非法事件名会整体抛错，逐个注册可保证「某版本不
        // 认识 open/close」时其余事件仍生效。
        addPsNotificationListeners(this.handleNotification);

        // 许可证：检查当前状态并尝试自动重新验证
        await this.checkLicenseStatus();

        // ========= 面板状态：加载并合并 =========
        // 专注模式的结论直接由「合并后的两个前置选项」算出（不读 this.state）：
        // 下面的 setState 是异步的，此刻 this.state 仍是默认值 false/false。
        let focusAfterMerge = this.isFocusMode();
        try {
            const loaded = await PanelStateManager.initialize({
                appPanel: {
                    isEnabled: this.state.isEnabled,
                    isExpanded: this.state.isExpanded,
                    isSelectionOptionsExpanded: this.state.isSelectionOptionsExpanded,
                    autoUpdateHistory: this.state.autoUpdateHistory,
                    deselectAfterFill: this.state.deselectAfterFill,
                    switchToLassoOnEnable: this.state.switchToLassoOnEnable,
                    autoOffOnOtherTool: this.state.autoOffOnOtherTool,
                    strokeEnabled: this.state.strokeEnabled,
                    createNewLayer: this.state.createNewLayer,
                    clearMode: this.state.clearMode,
                    clearBackgroundAlgorithm: this.state.clearBackgroundAlgorithm,
                    clearChannelAlgorithm: this.state.clearChannelAlgorithm,
                    clearLayerAlgorithm: this.state.clearLayerAlgorithm,
                    compactModes: this.state.compactModes,
                    fillMode: this.state.fillMode,
                },
            });
            if (loaded && loaded.appPanel) {
                // 合并后的两个前置选项真值（与下面 setState 里写的合并规则逐字一致）：
                // 存档缺字段时回落到当前 this.state（即 initialState 默认）。
                const mergedLasso = loaded.appPanel.switchToLassoOnEnable ?? this.state.switchToLassoOnEnable;
                const mergedAutoOff = loaded.appPanel.autoOffOnOtherTool ?? this.state.autoOffOnOtherTool;
                focusAfterMerge = !!(mergedAutoOff && mergedLasso);
                this.setState({
                    isEnabled: loaded.appPanel.isEnabled ?? this.state.isEnabled,
                    isExpanded: loaded.appPanel.isExpanded ?? this.state.isExpanded,
                    isSelectionOptionsExpanded: loaded.appPanel.isSelectionOptionsExpanded ?? this.state.isSelectionOptionsExpanded,
                    autoUpdateHistory: loaded.appPanel.autoUpdateHistory ?? this.state.autoUpdateHistory,
                    deselectAfterFill: loaded.appPanel.deselectAfterFill ?? this.state.deselectAfterFill,
                    switchToLassoOnEnable: loaded.appPanel.switchToLassoOnEnable ?? this.state.switchToLassoOnEnable,
                    autoOffOnOtherTool: loaded.appPanel.autoOffOnOtherTool ?? this.state.autoOffOnOtherTool,
                    strokeEnabled: loaded.appPanel.strokeEnabled ?? this.state.strokeEnabled,
                    createNewLayer: loaded.appPanel.createNewLayer ?? this.state.createNewLayer,
                    clearMode: loaded.appPanel.clearMode ?? this.state.clearMode,
                    // 清除算法：旧存档没有这三个字段 ⇒ 回落到 initialState 的默认
                    // （趋白 / 减法 / 乘法），与重构前的既有行为一致。
                    clearBackgroundAlgorithm: loaded.appPanel.clearBackgroundAlgorithm ?? this.state.clearBackgroundAlgorithm,
                    clearChannelAlgorithm: loaded.appPanel.clearChannelAlgorithm ?? this.state.clearChannelAlgorithm,
                    clearLayerAlgorithm: loaded.appPanel.clearLayerAlgorithm ?? this.state.clearLayerAlgorithm,
                    fillMode: loaded.appPanel.fillMode ?? this.state.fillMode,
                    // 紧凑模式按作用域合并：旧存档缺字段时逐项回落到默认（全关），
                    // 避免「整体覆盖」把用户已开启的其它作用域冲掉
                    compactModes: {
                        app: loaded.appPanel.compactModes?.app ?? initialCompactModes.app,
                        color: loaded.appPanel.compactModes?.color ?? initialCompactModes.color,
                        pattern: loaded.appPanel.compactModes?.pattern ?? initialCompactModes.pattern,
                        gradient: loaded.appPanel.compactModes?.gradient ?? initialCompactModes.gradient,
                        stroke: loaded.appPanel.compactModes?.stroke ?? initialCompactModes.stroke,
                        clear: loaded.appPanel.compactModes?.clear ?? initialCompactModes.clear,
                    },
                    selectionOptionsVisible: loaded.appPanel.selectionOptionsVisible ?? this.state.selectionOptionsVisible,
                    fillOptionsVisible: loaded.appPanel.fillOptionsVisible ?? this.state.fillOptionsVisible,
                });
            }
        } catch (e) {
            console.warn('⚠️ 面板状态加载失败，使用默认状态:', e);
        } finally {
            // 加载完成（无论成败）才允许后续的持久化保存，避免启动期默认值覆盖已存状态
            this.panelStateLoaded = true;
        }
        // 选项已从磁盘合并进来，此刻把专注模式结论推给共享总线（下次会话未打开面板也有效）。
        // ⚠️ 必须传显式值 focusAfterMerge，不能让 syncFocusMode 去读 this.state：
        //    上面那个 setState 尚未生效（自动批处理），读到的仍是默认 false/false，
        //    会把 false 写进共享文件、覆盖上次会话留下的 true，之后虽被 componentDidUpdate
        //    纠回，但那个窗口里主开关热键会失去「只开不关」的专注模式语义。
        this.syncFocusMode(focusAfterMerge);
        // 紧凑模式持久化状态恢复：把加载到的 5 个作用域逐一落到 body 类上，并同步菜单文案
        this.syncCompactModeClasses();
        this.syncCompactMenuLabel();

        // ========= 主开关：与跨面板共享状态对齐 =========
        // 共享文件存在（上次会话留下来的真实状态）就以它为准；不存在才用本面板持久化的值播种。
        // 这样无论热键是被本面板还是被绘画工具箱面板接到的，两边的开关显示始终一致。
        try {
            const shared = await seedMainToggle(this.state.isEnabled);
            if (shared.enabled !== this.state.isEnabled) {
                this.setState({ isEnabled: shared.enabled });
            }
        } catch (e) {
            console.warn('⚠️ 主开关共享状态初始化失败，仅使用面板本地状态:', e);
        }

        // 主开关此刻已是最终值（可能来自共享状态），据此启停工具巡检
        this.syncToolWatch();
    }

    componentDidUpdate(prevProps, prevState) {
        // 主开关/自动关选项变化时同步巡检（放在最前：不受下方 panelStateLoaded 早退影响）
        if (prevState.isEnabled !== this.state.isEnabled ||
            prevState.autoOffOnOtherTool !== this.state.autoOffOnOtherTool) {
            this.syncToolWatch();
        }
        // 「填充选项」展开/可见状态变化时同步快速蒙版巡检（同样放在早退之前）
        if (prevState.isExpanded !== this.state.isExpanded ||
            prevState.fillOptionsVisible !== this.state.fillOptionsVisible) {
            this.syncQuickMaskWatch();
        }
        // 专注模式的两个前置选项变化时同步到共享总线（同样不受下方早退影响）
        if (prevState.autoOffOnOtherTool !== this.state.autoOffOnOtherTool ||
            prevState.switchToLassoOnEnable !== this.state.switchToLassoOnEnable) {
            this.syncFocusMode();
        }

        // 检查次级面板状态变化，添加或移除CSS类
        const isAnySecondaryPanelOpen = this.state.isColorSettingsOpen || 
                                       this.state.isPatternPickerOpen || 
                                       this.state.isGradientPickerOpen || 
                                       this.state.isStrokeSettingOpen ||
                                       this.state.isClearSettingOpen;
        
        const wasAnySecondaryPanelOpen = prevState.isColorSettingsOpen || 
                                        prevState.isPatternPickerOpen || 
                                        prevState.isGradientPickerOpen || 
                                        prevState.isStrokeSettingOpen ||
                                        prevState.isClearSettingOpen;
        
        if (isAnySecondaryPanelOpen !== wasAnySecondaryPanelOpen) {
            if (isAnySecondaryPanelOpen) {
                document.body.classList.add('secondary-panel-open');
            } else {
                document.body.classList.remove('secondary-panel-open');
            }
            // 5 个子面板内部没有分区 ⇒ 期间把菜单里的「隐藏/显示分区」置灰，
            // 否则点了只会打开一个「父面板分区」浮窗，语义对不上。
            // ⚠️ 只改 enabled、绝不 removeAt/insertAt（会损坏整个菜单，见 MenuManager 注释）。
            MenuManager.setAppVisibilityItemEnabled(!isAnySecondaryPanelOpen);
        }

        // 紧凑模式：开关变化 → 同步 body 类 + 重写菜单文案（面板名与状态都可能变）
        if (prevState.compactModes !== this.state.compactModes) {
            this.syncCompactModeClasses();
            this.syncCompactMenuLabel();
        } else if (this.compactScopeOf(prevState) !== this.currentCompactScope()) {
            // 仅切换了当前面板（打开/关闭某个子面板）：文案里的面板名要跟着换
            this.syncCompactMenuLabel();
        }

        // ========= 面板状态：有变更则保存 =========
        // 初始加载完成前不保存：此时 state 还是默认值，任何 setState（如 MainToggleBus
        // 轮询到的 isEnabled）都会以默认值覆盖 panel-state.json 里用户已保存的选项。
        if (!this.panelStateLoaded) return;
        const watchedKeys: Array<keyof typeof this.state> = [
            'isEnabled',
            'isExpanded',
            'isSelectionOptionsExpanded',
            'autoUpdateHistory',
            'deselectAfterFill',
            'switchToLassoOnEnable',
            'autoOffOnOtherTool',
            'strokeEnabled',
            'createNewLayer',
            'clearMode',
            'clearBackgroundAlgorithm',
            'clearChannelAlgorithm',
            'clearLayerAlgorithm',
            'compactModes',
            'fillMode',
        ];
        const changed = watchedKeys.some(k => prevState[k] !== this.state[k]);
        if (changed) {
            PanelStateManager.update({
                appPanel: {
                    isEnabled: this.state.isEnabled,
                    isExpanded: this.state.isExpanded,
                    isSelectionOptionsExpanded: this.state.isSelectionOptionsExpanded,
                    autoUpdateHistory: this.state.autoUpdateHistory,
                    deselectAfterFill: this.state.deselectAfterFill,
                    switchToLassoOnEnable: this.state.switchToLassoOnEnable,
                    autoOffOnOtherTool: this.state.autoOffOnOtherTool,
                    strokeEnabled: this.state.strokeEnabled,
                    createNewLayer: this.state.createNewLayer,
                    clearMode: this.state.clearMode,
                    clearBackgroundAlgorithm: this.state.clearBackgroundAlgorithm,
                    clearChannelAlgorithm: this.state.clearChannelAlgorithm,
                    clearLayerAlgorithm: this.state.clearLayerAlgorithm,
                    compactModes: this.state.compactModes,
                    fillMode: this.state.fillMode,
                    selectionOptionsVisible: this.state.selectionOptionsVisible,
                    fillOptionsVisible: this.state.fillOptionsVisible,
                },
            }, { debounceMs: 400 }).catch(e => console.warn('⚠️ 保存面板状态失败:', e));
        }
    }

    async componentWillUnmount() {
        // 在应用关闭前强制保存所有预设
        try {
            await PresetManager.forceSaveAllPresets();
            console.log('✅ 应用关闭前预设保存完成');
        } catch (error) {
            console.error('❌ 应用关闭前预设保存失败:', error);
        }
        
        if (this.unsubMainToggle) {
            try { this.unsubMainToggle(); } catch { /* ignore */ }
            this.unsubMainToggle = null;
        }
        if (this.unsubFillPanelToggle) {
            try { this.unsubFillPanelToggle(); } catch { /* ignore */ }
            this.unsubFillPanelToggle = null;
        }
        if (this.selectionChangeListener) {
            action.removeNotificationListener(['set'], this.selectionChangeListener);
        }
        if (this.selectionRetryTimer) {
            clearTimeout(this.selectionRetryTimer);
            this.selectionRetryTimer = null;
        }
        this.selectionRetryCount = 0;
        invalidateLayerInfoCache();
        removePsNotificationListeners(this.handleNotification);
        document.removeEventListener('mousemove', this.handleMouseMove);
        document.removeEventListener('mouseup', this.handleMouseUp);
        if (this.docWatchTimer) {
            clearInterval(this.docWatchTimer);
            this.docWatchTimer = null;
        }
        if (this.docLatchProbeTimer) {
            clearTimeout(this.docLatchProbeTimer);
            this.docLatchProbeTimer = null;
        }
        if (this.toolWatchTimer) {
            clearInterval(this.toolWatchTimer);
            this.toolWatchTimer = null;
        }
        if (this.quickMaskTimer) {
            clearInterval(this.quickMaskTimer);
            this.quickMaskTimer = null;
        }
        // 清理CSS类（含本面板专属的可见性浮窗类，避免残留影响下次加载）
        document.body.classList.remove('secondary-panel-open');
        document.body.classList.remove('license-dialog-open');
        document.body.classList.remove('app-visibility-panel-open');
    }

    handleButtonClick() {
        const prevEnabled = this.state.isEnabled;
        const nextEnabled = !prevEnabled;
        this.setState({ isEnabled: nextEnabled }, () => {
            PanelStateManager.update({
                appPanel: { isEnabled: this.state.isEnabled }
            }, { debounceMs: 0 }).catch(e => console.warn('⚠️ 主开关状态持久化失败:', e));
            // 同步到跨面板共享状态：不写的话，下次热键翻转是基于旧值算的，
            // 手动点开关之后按 Ctrl+Q 会得到「反直觉」的结果。
            setMainToggle(nextEnabled).catch(e => console.warn('⚠️ 主开关共享状态写入失败:', e));
        });
        // 主开关关闭→开启：按选项自动切换为套索工具
        void this.onMainToggleChanged(prevEnabled, nextEnabled);
    }

    /**
     * 重新指定「选区填充」主开关的全局快捷键（默认 Ctrl+Q）。
     * 录制由本地守护进程的全局键盘钩子完成：UXP 面板拿不到全局按键，
     * 这里只负责弹提示、发指令、把结果写回共享配置。
     */
    async setMainHotkey() {
        try {
            if (!isDaemonConnected()) {
                await core.showAlert({ message: '快捷键服务未连接，无法录制快捷键。\n请到「像素调整」面板的「笔刷热键」分区点一下「启动快捷键服务」。' });
                return;
            }
            const current = getMainToggleCombo();
            await core.showAlert({
                message: `点「确定」后，请直接按下要绑定的组合键（按 Esc 取消）。\n\n` +
                    `当前主开关快捷键：${current || '未绑定'}`
            });
            const res = await requestHotkeyRecording('选区填充主开关');
            if (!res) {
                await core.showAlert({ message: '已取消，主开关快捷键保持不变。' });
                return;
            }
            const ok = setMainToggleCombo(res.combo);
            await core.showAlert({
                message: ok
                    ? `主开关快捷键已设为：${res.combo}`
                    : '设置失败：快捷键服务未响应，请重新启动快捷键服务后重试。'
            });
        } catch (e) {
            console.error('❌ 设置主开关快捷键失败:', e);
            try { await core.showAlert({ message: '设置主开关快捷键时出错，详见控制台日志。' }); } catch { /* ignore */ }
        }
    }


    // 新增方法
    toggleSelectionOptions() {
        const root = this.panelRef.current;
        // 即将折叠（当前展开）→ 先隐藏分区内原生控件，再让 React 卸载内容
        if (this.state.isSelectionOptionsExpanded) hideNativeWidgetsOfSections(root, ['selectionOptions']);
        this.setState(prevState => ({
            isSelectionOptionsExpanded: !prevState.isSelectionOptionsExpanded
        }));
        resyncNativeWidgets(root);
    }

    handleSelectionSmoothChange(value: number) {
        this.setState({ selectionSmooth: value });
    }

    handleSelectionContrastChange(value: number) {
        this.setState({ selectionContrast: value });
    }

    handleSelectionExpandChange(value: number) {
        this.setState({ selectionExpand: value });
    }

    // 应用选区修改
    async applySelectionModification() {
        const options: SelectionOptions = {
            selectionSmooth: this.state.selectionSmooth,
            selectionContrast: this.state.selectionContrast,
            selectionExpand: this.state.selectionExpand
        };
        
        try {
            await SelectionHandler.applySelectionModification(options);
        } catch (error) {
            console.error('选区修改失败:', error);
        }
    }

    toggleExpand() {
        const root = this.panelRef.current;
        // 即将折叠（当前展开）→ 先隐藏分区内原生控件，再让 React 卸载内容
        if (this.state.isExpanded) hideNativeWidgetsOfSections(root, ['fillOptions']);
        this.setState(prevState => {
            const isExpanded = !prevState.isExpanded;
            return { isExpanded };
        });
        resyncNativeWidgets(root);
    }

    /** 打开「隐藏/显示分区」浮窗（与像素调整面板同一套交互） */
    openVisibilityPanel() {
        // 与绘画工具箱同机制：浮窗打开时收起本面板滚动条 + 隐藏背后 number 输入，
        // 避免浮窗被滚动条压住、以及遮挡下仍可点穿。
        // ⚠️ 类名必须与工具箱的 `.visibility-panel-open` 区分开：两块面板共用同一个
        //    document.body，同名类会让「一块面板开浮窗」连带把另一块面板的滚动条
        //    收起、数字隐藏；且任何一块关闭时无条件移除，还会把另一块仍在开的浮窗
        //    打回原状（数字浮到浮窗上方）。
        document.body.classList.add('app-visibility-panel-open');
        this.setState({ showVisibilityPanel: true });
    }

    closeVisibilityPanel() {
        document.body.classList.remove('app-visibility-panel-open');
        this.setState({ showVisibilityPanel: false });
    }

    /** 切换某个分区的可见性（选区改造 / 填充选项） */
    toggleSectionVisibility(id: 'selectionOptions' | 'fillOptions') {
        this.setState(prev => ({
            selectionOptionsVisible: id === 'selectionOptions' ? !prev.selectionOptionsVisible : prev.selectionOptionsVisible,
            fillOptionsVisible: id === 'fillOptions' ? !prev.fillOptionsVisible : prev.fillOptionsVisible,
        }));
    }

    toggleStrokeEnabled() {
        this.setState({ strokeEnabled: !this.state.strokeEnabled });
    }

    /** 描边色板：打开 PS 颜色选择器，选完写回 strokeColor（前景色的保存/还原由 pickColorWithInitial 负责） */
    openStrokeColorPicker = async () => {
        // ⚠️ 初始色必须是「真实描边色 strokeColor」，**不能**用灰色显示色 getStrokeDisplayColor()：
        //    灰色显示态（清除/图层蒙版/快速蒙版/单通道）下后者返回的是灰度值，用它当初值会连踩两坑
        //    （用户 2026-10-09 报的「先点开拾色器就再也回不到原色」）：
        //      ① 拾色器一打开就显示灰（#b34d4d → #6b6b6b）；
        //      ② 用户确认后把那个灰度 setState 回 strokeColor ⇒ 真实色被永久覆盖，
        //         退出灰色态也恢复不了（灰色态本应只影响显示）。
        //    showColorPicker 无参、只认当前前景色 ⇒ 仍需先把前景色设成真实色，这由 pickColorWithInitial 负责。
        const { strokeColor } = this.state;
        const initial = strokeColor
            ? { red: strokeColor.red, green: strokeColor.green, blue: strokeColor.blue }
            : { red: 0, green: 0, blue: 0 };
        const picked = await pickColorWithInitial(initial, '选择描边颜色');
        if (picked) {
            this.setState({ strokeColor: picked });
        }
    }
    
    toggleClearMode() {
        this.setState(prevState => ({
            clearMode: !prevState.clearMode,
            createNewLayer: prevState.clearMode ? prevState.createNewLayer : false // 如果开启清除模式，关闭新建图层模式
        }));
    }

    handleFillModeChange(event: CustomEvent) {
        try {
            if (!this || !this.state || !event || !event.target) {
                return;
            }
            const value = event.target.selected;
            this.setState({ fillMode: value });
        } catch (error) {
        }
    }

    toggleStrokeSetting() {
        this.setState({ isStrokeSettingOpen: true });
    }

    toggleColorSettings() {
        this.setState(prev => ({ isColorSettingsOpen: !prev.isColorSettingsOpen }));
    }

    /**
     * 功能快捷键通路：切换纯色/图案/渐变子面板的开关。
     * 与面板里齿轮/标签入口的语义一致——开就关、关就开；
     * 图案/渐变的既有入口只开不关，热键这里是真正的开关（用户按同键可收起）。
     */
    applyFillPanelHotkey(panel: FillPanelId) {
        this.setState(prev => {
            if (panel === 'color') return { isColorSettingsOpen: !prev.isColorSettingsOpen };
            if (panel === 'pattern') return { isPatternPickerOpen: !prev.isPatternPickerOpen };
            if (panel === 'gradient') return { isGradientPickerOpen: !prev.isGradientPickerOpen };
            return null;
        });
    }

    openPatternPicker() {
        this.setState({ isPatternPickerOpen: true });
    }

    openGradientPicker() {
        this.setState({ isGradientPickerOpen: true });
    }

    handleColorSettingsSave(settings: ColorSettings) {
        try {
            // 验证设置值是否在有效范围内
            const validatedSettings = {
                hueVariation: Math.min(360, Math.max(0, settings.hueVariation)),
                saturationVariation: Math.min(100, Math.max(0, settings.saturationVariation)),
                brightnessVariation: Math.min(100, Math.max(0, settings.brightnessVariation)),
                opacityVariation: Math.min(100, Math.max(0, settings.opacityVariation)),
                pressureVariation: Math.min(100, Math.max(0, settings.pressureVariation)),
                grayVariation: Math.min(100, Math.max(0, settings.grayVariation || 0)),
                calculationMode: settings.calculationMode || 'absolute'
            };

            // 只保存设置，不关闭面板
            this.setState({
                colorSettings: validatedSettings
            });
        } catch (error) {
            console.error('保存颜色设置失败:', error);
            // 可以添加错误提示UI
        }
    }

    handlePatternSelect(pattern: Pattern) {
        this.setState({
            selectedPattern: pattern
        });
    }

    handleGradientSelect(gradient: Gradient | null) {
        this.setState({
            selectedGradient: gradient
        });
        PanelStateManager.update(
            { appPanel: { selectedGradient: gradient } },
            { debounceMs: 200 }
        ).catch(e => console.warn('⚠️ 保存当前渐变设置失败:', e));
    }

    closeColorSettings() {
        this.setState({ isColorSettingsOpen: false });
    }

    closePatternPicker() {
        this.setState({ isPatternPickerOpen: false });
    }

    closeGradientPicker() {
        this.setState({ isGradientPickerOpen: false });
    }

    closeStrokeSetting() {
        this.setState({ isStrokeSettingOpen: false });
    }

    /** 打开清除设置子面板（紧凑模式下由「清除模式」label 触发，普通模式下由齿轮触发） */
    toggleClearSetting() {
        this.setState({ isClearSettingOpen: true });
    }

    closeClearSetting() {
        this.setState({ isClearSettingOpen: false });
    }

    async handleSelectionChange(event?: any) {
        if (!this.state.isEnabled) return;
        // 检查事件中是否包含feather项，如果包含则直接返回
        if (event && event.feather) {
            return;
        }

        // ⚠️ 填充路径的**私有**冷却（不是 `isPsBusy()`）：
        // `isPsBusy()` 是全局共享粗筛闸门，被 pollQuickMask / pollToolChange /
        // MaskSyncEngine / debouncePsProbe / runWhenIdle 等 9 处依赖 ——
        // **绝不为「填充更快」而缩短**（2026-10-08 已付过代价：缩短后那些轮询在
        // PS 仍忙时提前放闸 ⇒ 四类弹框）。
        // 填充要的「快」走这份私有冷却：纯选区事件只等 ~60ms；只有「最近 600ms
        // 内发生过重命令」（删除/新建/打开/关闭/切文档）时才服从全局静默剩余时间。
        //
        // ⚠️⚠️ 正确性**不再**由这里保证：等待只为「少在模态里排队」，真正防弹框的是
        // 下面 `executeAsModal` 的模态作用域（详见 psAccess.psRead 的长注释）。
        // 因此顺延**上不封顶** —— 旧实现「第 11 次顺延就硬闯」本身就是弹框出口之一。
        // 忙碌窗口是时间驱动的有限值，不会出现「永远等不到」。
        const fillWait = fillReadyRemain();
        if (fillWait > 0) {
            this.selectionBusyDeferrals++;
            if (this.selectionRetryTimer) clearTimeout(this.selectionRetryTimer);
            // ⚠️ 事件对象要一并带过去：否则 feather 事件的「跳过」语义会丢失，
            // 可能对无意义的羽化事件也跑一次填充。
            this.selectionRetryTimer = setTimeout(() => {
                this.selectionRetryTimer = null;
                void this.handleSelectionChange(event);
            }, fillWait);
            return;
        }
        this.selectionBusyDeferrals = 0;

        // 【同步锁】检查是否正在处理；必须在任何 await 之前完成，避免竞态
        if (this.isFilling) {
            // 已有正在进行的填充，把"需要再处理一次"标记上，
            // 等当前这一轮结束后由 finally 重新触发一次（而非并发覆盖）
            this.pendingSelection = true;
            return;
        }

        try {
            // 上锁（在任何 await 之前同步置位，让后续事件被 pendingSelection 捕获）
            this.isFilling = true;

            // ⚠️ 优化（2026-10-08）：外层**不再**做任何 PS 读取。
            //   · 选区是否存在 → 由模态内的校验负责（它更靠近真正的 fill，语义更准）；
            //   · 快速蒙版状态 → 由 layerInfo.isInQuickMask 带回（本次填充本来就要取 layerInfo）；
            //   · **活动文档** → 一并移入模态作用域（见下）。它是填充路径上模态外
            //     **唯一**的 PS 访问，也正是「删完图层立刻套索并填充」弹
            //     「命令"获取"当前不可用」的直接触发点：闸门一旦判断失误（忙碌期超过
            //     顺延上限），第一个撞上 PS 的读就发生在模态作用域**之外**。
            // ⇒ 移入后填充路径在模态外**零 PS 访问**，于是「抢时间」的快速通道彻底
            //   不再需要：安静路径几乎立即开填，忙碌路径在模态内排队而不是弹框。

            const featherAmount = Number(this.state.feather);
            const needsFeather = featherAmount > 0;
            const options: SelectionOptions = {
                selectionSmooth: this.state.selectionSmooth,
                selectionContrast: this.state.selectionContrast,
                selectionExpand: this.state.selectionExpand
            };
            const needsSelectionMod = SelectionHandler.shouldApplySelectionModification(options);
            const needsStroke = this.state.strokeEnabled;
            const needsDeselect = this.state.deselectAfterFill;
            const needsHistory = this.state.autoUpdateHistory;

            // ⚠️ 经 `runAsModal` 进入（不是裸 core.executeAsModal）：本段内部调用
            //    `LayerInfoHandler.getActiveLayerInfo()` → `psRead`，而 psRead 的
            //    「已在模态内 ⇒ 直读」判据是**本插件自己的模态计数**。用裸 API 会让
            //    计数为 0 ⇒ psRead 去嵌套 executeAsModal ⇒ UXP 不允许嵌套 ⇒ 读取失败。
            await runAsModal(async () => {
                // ⚠️ 模态作用域内的第一件事：取活动文档。
                // 原先这一步在模态**外**（填充路径上唯一的模态外 PS 访问）——
                // 闸门判断失误时它第一个撞上忙碌的宿主，直接换回一个原生报错框。
                // 现在模态态由本插件持有，宿主不会拒 get。
                const doc = app.activeDocument;
                if (!doc) return;

                // 【关键防御】校验选区非空 —— 前一次填充若开了 deselectAfterFill，
                // 选区可能已在排队期间被清空；空选区下 fill 整个图层
                // 表现为"填充整个文档"。直接放弃本轮，避免误伤整张画布。
                // ⚠️ 这一句是**唯一**的选区校验（原实现内外各查一次，重复）。
                // 它必须在 executeAsModal 作用域内：模态态由本插件持有，宿主不会拒 get。
                const selection = await this.getSelection();
                if (!selection) {
                    return;
                }

                // 把整次填充（历史画笔源 / 选区修改 / 羽化 / 填充 / 描边 / 取消选区）
                // 合并成【一条】历史记录，方便整体撤回。suspendHistory 本身是
                // executeAsModal 的封装，可直接嵌套在当前 executeAsModal 作用域内使用。
                const modeLabel =
                    this.state.fillMode === 'pattern' ? '选区图案填充'
                    : this.state.fillMode === 'gradient' ? '选区渐变填充' : '选区纯色填充';
                await doc.suspendHistory(async () => {
                    if (needsHistory) {
                        await this.setHistoryBrushSource();
                    }
                    // 只有当选区改造值不为初始值时才执行选区修改
                    if (needsSelectionMod) {
                        await this.applySelectionModification();
                    }
                    // feather=0 时整段 applyFeather 都是无效工作，直接跳过
                    if (needsFeather) {
                        await this.applyFeather(featherAmount);
                    }
                    const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                    if (!layerInfo) return;

                    // 快速蒙版 / 单通道状态随layerInfo 一起带回，替代原先外层的独立读取
                    // ⚠️ 单通道必须一并回写 state：它决定「新建图层」开关的禁用态与
                    //    描边色板的灰度显示（只写实例字段会漏刷新）。
                    const maskPatch: any = {};
                    if (this.state.isInQuickMask !== layerInfo.isInQuickMask) {
                        maskPatch.isInQuickMask = layerInfo.isInQuickMask;
                    }
                    // 图层蒙版：决定「新建图层」开关的禁用态（填充图层蒙版时该项无意义且会破坏蒙版编辑）
                    this.isInLayerMask = !!layerInfo.isInLayerMask;
                    if (this.state.isInLayerMask !== this.isInLayerMask) {
                        maskPatch.isInLayerMask = this.isInLayerMask;
                    }
                    this.isInSingleColorChannel = !!layerInfo.isInSingleColorChannel;
                    if (this.state.isInSingleColorChannel !== this.isInSingleColorChannel) {
                        maskPatch.isInSingleColorChannel = this.isInSingleColorChannel;
                    }
                    if (Object.keys(maskPatch).length > 0) {
                        this.setState(maskPatch);
                    }

                    // ⚠️ 「取消选区」并入 fill 的同一次 batchPlay（省一次同步 IPC）。
                    // ⚠️ 三个前置条件缺一不可，否则 deselect 会被**静默丢掉**：
                    //   ① fillMode 必须是「纯色」—— 图案/渐变走各自的 Handler，
                    //      不接受 withDeselect，也不会顺手取消选区；
                    //   ② 不能是清除模式（ClearHandler 独立实现）；
                    //   ③ 不能是单通道模式（SingleChannelHandler 独立实现）。
                    //   ④ 不能描边：描边依赖选区存在，必须排在 deselect 之前。
                    const mergeDeselect = needsDeselect
                        && !needsStroke
                        && this.state.fillMode === 'foreground'
                        && !this.state.clearMode
                        && !layerInfo.isInSingleColorChannel;

                    // ⚠️⚠️ 需要描边时，必须让填充**保留下选区**：
                    // PatternFill / GradientFill / ClearHandler / SingleChannelHandler 写回像素时
                    // 会用 imaging.putSelection 覆盖选区，且只在 `deselectAfterFill === false` 时还原。
                    // 而「自动删选区」默认是开（true）⇒ 以前这 5 种组合都在填充后把选区清空了，
                    // 紧随的 strokeSelection 无选区可描 ⇒ 表现为「描边失效」。
                    // 这里给填充下发一份把 deselectAfterFill 固定为 false 的状态副本；
                    // 用户「自动删选区」的原意由下面的 stroke 之后统一兑现（needsDeselect 分支）。
                    const stateForFill = needsStroke
                        ? { ...this.state, deselectAfterFill: false }
                        : this.state;

                    const fillSuccess = await this.fillSelection(layerInfo, mergeDeselect, stateForFill);
                    if (needsStroke && fillSuccess) {
                        await strokeSelection(this.state, layerInfo);
                        if (needsDeselect) {
                            await this.deselectSelection();
                        }
                    } else if (needsDeselect && !mergeDeselect) {
                        // 未被合并（含填充失败）⇒ 照常单独取消选区，保持旧语义
                        await this.deselectSelection();
                    }
                }, modeLabel);
            }, { commandName: '正在处理选区中......' });
        } catch (error) {
            // ⚠️ 降级重试：填充在模态内排队/被拒（宿主忙碌）时，打一段保守窗口再试一次。
            // ⚠️⚠️ 新设计下本分支**不再是弹框路径**：模态作用域把「不可捕获的宿主
            //   原生框」降级成了「可捕获的 rejection」—— 走到这里只表示这一轮没填上，
            //   用户不会被打扰。重试是为了让这次填充最终落地。
            // ⚠️ 只重试一次（selectionRetryCount 上限）：不能无界重试，
            //    否则宿主持续忙碌时它变成永不停止的循环；而且「填充已跑了一半才抛错」
            //    的场合，多次重试有重复填充的风险。
            if (this.selectionRetryCount < 1) {
                this.selectionRetryCount++;
                markPsBusy(FILL_RETRY_GUARD_MS);
                if (this.selectionRetryTimer) clearTimeout(this.selectionRetryTimer);
                this.selectionRetryTimer = setTimeout(() => {
                    this.selectionRetryTimer = null;
                    void this.handleSelectionChange(event);
                }, FILL_RETRY_GUARD_MS);
                return;
            }
            console.error('❌ 处理失败:', error);
        } finally {
            this.isFilling = false;
            // 本轮（含降级重试）正常走完 ⇒ 允许下次失败时再次降级重试
            if (!this.selectionRetryTimer) {
                this.selectionRetryCount = 0;
            }
            // 若填充期间又有新的选区事件进来，再处理一次，
            // 这样套索连点也不会丢选区
            if (this.pendingSelection) {
                this.pendingSelection = false;
                // 用 setTimeout(0) 把递归触发推到下一个事件循环，
                // 避免在 finally 里直接重入导致栈过深
                setTimeout(() => {
                    if (this.state.isEnabled) {
                        this.handleSelectionChange();
                    }
                }, 0);
            }
        }
    }

    async getSelection() {
        try {
            const result = await action.batchPlay(
                [
                    {
                        _obj: 'get',
                        _target: [
                            { _property: 'selection' },
                            { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' },
                        ],
                        _options: { dialogOptions: 'dontDisplay' }
                    },
                ],
                { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
            );
            if (result && result.length > 0 && result[0].selection) {
                return result[0].selection;
            } else {
                return null;
            }
        } catch (error) {
            console.error('❌ 获取选区失败:', error);
            return null;
        }
    }

    async setHistoryBrushSource() {
        // ⚠️ 优化（2026-10-08）：原实现先读 `doc.historyStates` 判空，代价是一次
        // 同步 get，且返回的是**整条历史记录数组**（大文档上可能有上百条，
        // 序列化开销明显）。历史栈为空时 set 会直接抛错，已被下面的 catch 覆盖，
        // 因此判空步骤纯属多余 IPC —— 删掉。行为等价（空栈 → 抛错 → catch 忽略）。
        try {
            await action.batchPlay(
                [
                    {
                        _obj: 'set',
                        _target: [
                            {
                                _ref: 'historyState',
                                _property: 'historyBrushSource'
                            }
                        ],
                        to: {
                             _ref: "historyState",
                            _property: "currentHistoryState"
                        },
                        _options: {
                            dialogOptions: 'dontDisplay'
                        }
                    }
                ],
                { dialogOptions: 'dontDisplayDialogs' }
            );
        } catch (error) {
            // 历史栈为空（新建文档尚未落笔）时 PS 会拒绝该命令，属预期情况，静默忽略
        }
    }

    async applyFeather(featherAmount: number) {
        // 调用方已保证 featherAmount > 0；负值/0 不应进入此函数
        if (featherAmount <= 0) return;
        await action.batchPlay(
            [
                {
                    _obj: 'feather',
                    radius: featherAmount,
                    _isCommand: true
                },
            ],
            { synchronousExecution: true, modalBehavior: 'execute', dialogOptions: 'dontDisplayDialogs' }
        );
    }

     // 修改新建图层模式切换函数
     toggleCreateNewLayer() {
        this.setState(prevState => ({
            createNewLayer: !prevState.createNewLayer,
            clearMode: prevState.createNewLayer ? prevState.clearMode : false 
        }));
    }

    /**
     * 「新建图层」开关的禁用条件 —— **唯一事实来源**（两套版式共用，避免两处条件漂移）。
     *   · 清除模式：清除是就地减淡，不产生新图层；
     *   · 快速蒙版：快速蒙版编辑的是通道，不是图层；
     *   · 图层蒙版：填充/描边都直接落在蒙版通道上，新建图层既无意义，也会把
     *     活动目标从蒙版切走 ⇒ 必须禁用（2026-10-08 用户要求）；
     *   · **单通道（红/绿/蓝/Alpha）**：填充经 SingleChannelHandler 写回当前通道，
     *     新建图层既无意义、又会把活动通道切回 RGB 复合通道 ⇒ 必须禁用（2026-10-08 用户要求）。
     */
    isCreateNewLayerDisabled() {
        return this.state.clearMode
            || this.state.isInQuickMask
            || this.state.isInLayerMask
            || this.state.isInSingleColorChannel;
    }

    async fillSelection(layerInfo?: LayerInfo | null, withDeselect = false, stateForFill?: AppState) {
        // 统一处理：若当前目标图层被隐藏，在操作前临时显示，操作后恢复隐藏
        // 注意：当选择"新建图层"时，目标会变为新图层（可见），无需临时显示原图层
        let needToggleVisibility = false;
        const showTargetLayer = {
            _obj: "show",
            null: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            _isCommand: false
        };
        const hideTargetLayer = {
            _obj: "hide",
            null: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            _isCommand: false
        };
        try {
            // 授权门控：未授权且非试用，打开授权窗口并阻止功能
            if (!this.state.isLicensed && !this.state.isTrial) {
                this.setState({ isLicenseDialogOpen: true });
                // ⚠️ 提前返回前必须兑现「已合并的取消选区」，否则调用方会以为
                // deselect 已经下发而不再单独补一次 ⇒ 选区被留在画布上（行为回归）。
                if (withDeselect) await this.deselectSelection();
                return false;
            }

            // 先确保拿到 layerInfo：可见性、单通道状态都从这里取，避免重复查询
            if (!layerInfo) {
                layerInfo = await LayerInfoHandler.getActiveLayerInfo();
            }
            if (!layerInfo) {
                if (withDeselect) await this.deselectSelection();
                return false;
            }

            // 记录原始活动图层的可见性（当不新建图层时需要临时显示隐藏图层以避免合并/删除警告）
            // ⚠️ 优化（2026-10-08）：可见性已随 layerInfo 带回（旧实现在这里额外
            // 读 activeLayers[0].visible，白花 2 次同步 IPC）。
            needToggleVisibility = !!(layerInfo.isHidden && !this.state.createNewLayer);
            if (needToggleVisibility) {
                try {
                    await action.batchPlay([showTargetLayer], { dialogOptions: 'dontDisplayDialogs' });
                } catch (e) {
                    console.warn('切换图层可见性失败，继续执行填充流程:', e);
                }
            }

            // ⚠️⚠️ 描边需要选区「活到 strokeSelection 之后」，但四个填充处理器
            // （PatternFill / GradientFill / ClearHandler / SingleChannelHandler）在写回像素时
            // 会用 `imaging.putSelection` **覆盖当前选区**，且**仅当 `state.deselectAfterFill === false`**
            // 才把原选区还原回去；该开关默认 `true`（=「自动删选区」默认开）
            // ⇒ 填充一返回选区就空了，紧随的描边无从下手（表现为「描边未生效」）。
            // 因此调用方在 `needsStroke` 时会传一份 `{...this.state, deselectAfterFill:false}`；
            // 用户「自动删选区」的原意由 handleSelectionChange 在**描边之后**统一兑现，语义不变。
            // 无描边（无描边 / 仅清除）时调用方传 undefined ⇒ 这里退回 this.state，行为与旧版完全一致。
            const fillState: AppState = stateForFill || this.state;

            // 单通道模式判定同样直接用 layerInfo（字段含义与旧 checkSingleColorChannelMode 一致）
            const isInSingleChannel = !!layerInfo.isInSingleColorChannel;
            if (isInSingleChannel) {

                const fillOptions = {
                    opacity: this.state.opacity,
                    blendMode: this.state.blendMode,
                    pattern: this.state.selectedPattern,
                    gradient: this.state.selectedGradient
                };

                if (this.state.clearMode) {
                    const ok = await SingleChannelHandler.clearSingleChannel(fillOptions, fillState.fillMode, fillState);
                    return ok === undefined ? true : !!ok; // 若内部未显式返回，视为成功
                } else {
                    const ok = await SingleChannelHandler.fillSingleChannel(fillOptions, fillState.fillMode, fillState);
                    return ok === undefined ? true : !!ok;
                }
            }

            if (this.state.clearMode) {
                await ClearHandler.clearWithOpacity(fillState.opacity, fillState, layerInfo);
                return true;
            }

            // ⚠️ 图层蒙版下**不得**新建图层：`make layer` 会立刻把活动目标从蒙版通道切到新图层，
            //    紧随的 fill 就落到新图层而不是蒙版（第一类失效的另一半原因）。
            //    与「新建图层」开关在图层蒙版下被禁用的语义一致（见 isCreateNewLayerDisabled）。
            if (this.state.createNewLayer && this.state.fillMode !== 'gradient' && !layerInfo.isInLayerMask) {
                await action.batchPlay(
                    [{
                        _obj: "make",
                        _target: [{ _ref: "layer" }],
                        using: {
                            _obj: "layer",
                            mode: {
                                _enum: "blendMode",
                                _value: BLEND_MODES[this.state.blendMode] || "normal"
                            }
                        },
                        _options: { dialogOptions: "dontDisplay" }
                    }],
                    { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' }
                );
                // 新建图层后活动图层已改变 ⇒ 必须让layerInfo 缓存失效，
                // 否则下一次填充会拿到「新建之前那个图层」的信息。
                invalidateLayerInfoCache();
            }

            const { isBackground, hasTransparencyLocked, hasPixels } = layerInfo;
    
            if (this.state.fillMode === 'pattern') {
                if (this.state.selectedPattern) {
                    await PatternFill.fillPattern({
                        opacity: this.state.opacity,
                        blendMode: this.state.blendMode,
                        pattern: this.state.selectedPattern,
                        preserveTransparency: this.state.selectedPattern.preserveTransparency
                    }, layerInfo, fillState);
                    return true;
                } else {
                    // 缺少图案预设，显示警告并跳过填充
                    await core.showAlert({ message: '请先选择一个图案预设' });
                    return false;
                }
            } else if (this.state.fillMode === 'gradient') {
                if (this.state.selectedGradient) {
                    await GradientFill.fillGradient({
                        opacity: this.state.opacity,
                        blendMode: this.state.blendMode,
                        gradient: this.state.selectedGradient,
                        preserveTransparency: this.state.selectedGradient.preserveTransparency
                    }, layerInfo, fillState, fillState.createNewLayer);
                    return true;
                } else {
                    // 缺少渐变预设，显示警告并跳过填充
                    await core.showAlert({ message: '请先选择一个渐变预设' });
                    return false; 
                } 
            } else {
                // 检测是否在快速蒙版状态
                const isInQuickMask = layerInfo.isInQuickMask;
                const randomColor = calculateRandomColor(this.state.colorSettings, this.state.opacity, undefined, isInQuickMask);
                
                // 只有在快速蒙版状态且为selectedAreas模式时，才反转灰度值
                let finalColor = randomColor;
                if (isInQuickMask) {
                    // 获取快速蒙版的isSelectedAreas属性
                    try {
                        const channelResult = await action.batchPlay([
                            {
                                _obj: "get",
                                _target: [
                                    {
                                        _ref: "channel",
                                        _name: "快速蒙版"
                                    }
                                ]
                            }
                        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                        
                        let isSelectedAreas = false;
                        if (channelResult[0] && 
                            channelResult[0].alphaChannelOptions && 
                            channelResult[0].alphaChannelOptions.colorIndicates) {
                            isSelectedAreas = channelResult[0].alphaChannelOptions.colorIndicates._value === "selectedAreas";
                        }
                        
                        // 只有在selectedAreas模式下才反转灰度值
                        if (isSelectedAreas) {
                            // 将HSB转换为RGB，计算灰度值，然后反转
                            const rgb = hsbToRgb(randomColor.hsb.hue, randomColor.hsb.saturation, randomColor.hsb.brightness);
                            const originalGrayValue = rgbToGray(rgb.red, rgb.green, rgb.blue);
                            const invertedGrayValue = 255 - originalGrayValue;
                            
                            // 将反转后的灰度值转换回HSB（亮度值）
                            const invertedBrightness = (invertedGrayValue / 255) * 100;
                            
                            finalColor = {
                                ...randomColor,
                                hsb: {
                                    ...randomColor.hsb,
                                    brightness: invertedBrightness
                                }
                            };
                        }
                    } catch (error) {
                        console.error('获取快速蒙版属性失败:', error);
                    }
                }
                
                const fillOptions = {
                    opacity: finalColor.opacity,
                    blendMode: this.state.blendMode,
                    color: finalColor
                };

                // 更新填充命令以使用随机颜色
                const command = FillHandler.createColorFillCommand(fillOptions);
    
                if (isBackground) {
                    await FillHandler.fillBackground(fillOptions, withDeselect);
                }
                else if (hasTransparencyLocked && hasPixels) {
                    await FillHandler.fillLockedWithPixels(fillOptions, withDeselect);
                }
                else if (hasTransparencyLocked && !hasPixels) {
                    await FillHandler.fillLockedWithoutPixels(
                        fillOptions,
                        () => this.unlockLayerTransparency(),
                        () => this.lockLayerTransparency(),
                        withDeselect
                    );
                }
                else if (!hasTransparencyLocked && !isBackground) {
                    await FillHandler.fillUnlocked(fillOptions, withDeselect);
                }
                return true;
            }
        } catch (error) {
            console.error('填充选区失败:', error);
            return false;
        } finally {
            try {
                if (needToggleVisibility) {
                    await action.batchPlay([hideTargetLayer], { dialogOptions: 'dontDisplayDialogs' });
                }
            } catch (e) {
                console.warn('恢复图层隐藏状态失败:', e);
            }
        }
    }

    // 设置图层透明度锁定
    async lockLayerTransparency() {
        try {
            await action.batchPlay([
                {
                    _obj: "applyLocking",
                    _target: [
                        { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
                    ],
                    layerLocking: {
                        _obj: "layerLocking",
                        protectTransparency: true
                    },
                    _options: { dialogOptions: "dontDisplay" }
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
        } catch (error) {}
    }

    // 设置图层透明度不锁定
    async unlockLayerTransparency() {
        try {
            await action.batchPlay([
                {
                    _obj: "applyLocking",
                    _target: [
                        { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
                    ],
                    layerLocking: {
                        _obj: "layerLocking",
                        protectNone: true
                    },
                    _options: { dialogOptions: "dontDisplay" }
                }
            ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
        } catch (error) {}
    }

    async deselectSelection() {
        await action.batchPlay([
           {
            _obj: "set",
            _target: [
               {
                  _ref: "channel",
                  _property: "selection"
               }
            ],
            to: {
               _enum: "ordinal",
               _value: "none"
            },
            _options: {
               dialogOptions: "dontDisplay"
            }
         }
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
    }

    // 处理标签鼠标按下事件
    // 事件挂在「参数集合行容器」上（双行滑块的第一行整行可拖，含标签与中间空白），
    // 因此必须排除落在数字输入框上的按下，否则输入框无法聚焦/编辑。
    handleLabelMouseDown(event, target) {
        if (!this || !this.state) return;
        const el = event.target as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        event.preventDefault();
        this.setState({
            isDragging: true,
            dragStartX: event.clientX,
            dragStartValue: this.state[target],
            dragTarget: target
        });
    }

    // 处理鼠标移动事件
    handleMouseMove(event: MouseEvent): void {
        if (!this.state || !this.state.isDragging || !this.state.dragTarget) return;
        
        const newValue = DragHandler.calculateNewValue(
            this.state.dragTarget,
            this.state.dragStartValue,
            this.state.dragStartX,
            event.clientX
        );
        
        this.setState({ [this.state.dragTarget]: newValue });
    }

    // 处理鼠标释放事件
    handleMouseUp(): void {
        if (!this || !this.state) return;
        this.setState({ isDragging: false });
    }

    handleOpacityChange(value: number) {
        this.setState({ opacity: value });
    }

    handleFeatherChange(value: number) {
        this.setState({ feather: value });
    }

    handleBlendModeChange(event) {
        const newBlendMode = event.target.value;
        this.setState({ blendMode: newBlendMode });
    }

    toggleAutoUpdateHistory() {
        this.setState({ autoUpdateHistory: !this.state.autoUpdateHistory });
    }
    
    toggleDeselectAfterFill() {
        this.setState({ deselectAfterFill: !this.state.deselectAfterFill });
    }

    // ===== 新增：主开关的两个联动选项 =====
    // 开启主开关时，若用户把当前工具切到这些「其它工具」，则自动关闭主开关
    // ⚠️ 吸管工具已从名单剔除：取样时临时切到吸管属于常规操作，不应关闭主开关。
    private static readonly AUTO_OFF_TOOLS = [
        'paintbrushTool',           // 画笔
        'pencilTool',               // 铅笔
        'eraserTool',               // 橡皮
        'backgroundEraserTool',     // 背景橡皮
        'magicEraserTool',          // 魔术橡皮
        'wetBrushTool',             // 混合器画笔
        'artBrushTool',             // 艺术画笔
        'bucketTool',               // 油漆桶
        'gradientTool',             // 渐变
        'moveTool',                 // 移动
        'smudgeTool',               // 涂抹
        'historyBrushTool',         // 历史画笔
        'blurTool',                 // 模糊
        'magicWandTool',            // 魔棒
        'cloneStampTool',           // 仿制图章
        'patternStampTool',         // 图案图章
        'penTool',                  // 钢笔
        'freeformPenTool',          // 自由钢笔（磁性钢笔是它的子模式）
        'curvaturePenTool',         // 曲率钢笔
        'lineTool',                 // 直线
        'spotHealingBrushTool',     // 污点修复画笔
        'healingBrushTool',         // 修复画笔
        'patchTool',                // 修补
        'redEyeTool',               // 红眼
        'contentAwareMoveTool',     // 内容感知移动
        'colorReplacementBrushTool',// 颜色替换
        'artHistoryBrushTool',      // 历史记录艺术画笔
        'sharpenTool',              // 锐化
        'dodgeTool',                // 减淡
        'burnTool',                 // 加深
        'spongeTool',               // 海绵
    ];

    toggleSwitchToLassoOnEnable() {
        this.setState({ switchToLassoOnEnable: !this.state.switchToLassoOnEnable });
    }

    toggleAutoOffOnOtherTool() {
        this.setState({ autoOffOnOtherTool: !this.state.autoOffOnOtherTool });
    }

    /**
     * 主开关状态发生「实际翻转」时的副作用。
     * 只在 关闭→开启 的瞬间按选项自动切换为套索工具。
     * 注意：本方法既被 handleButtonClick（点开关）调用，也被
     * subscribeMainToggle 的回调（热键/其它面板翻转）调用——两条路径都会收敛到这里，
     * 但开关已经是新值（已 setState），所以不会因为重复触发而重复切工具。
     */
    private async onMainToggleChanged(prevEnabled: boolean, nextEnabled: boolean) {
        if (nextEnabled && !prevEnabled && this.state.switchToLassoOnEnable) {
            await this.selectLassoTool();
        }
    }

    // 自动切换为套索工具（主开关关闭→开启时）
    // 复用 HotkeyBridge.applyBrush 已验证的切工具写法：先直连 batchPlay，
    // 失败（某些 PS 版本/状态下要求模态作用域）再回退 executeAsModal。
    private async selectLassoTool() {
        const descriptor: any = {
            _obj: 'select',
            _target: [{ _ref: 'lassoTool' }],
            dontRecord: true,
            forceNotify: true,
            _isCommand: false
        };
        try {
            await action.batchPlay([descriptor], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
        } catch (directErr) {
            // 直连失败 → 回退模态作用域（与 applyBrush 一致）
            try {
                await runAsModal(async () => {
                    await action.batchPlay([descriptor], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                }, { commandName: '切换套索工具' });
            } catch (e) {
                console.warn('⚠️ 自动切换套索工具失败（主开关开启时）:', e);
            }
        }
    }

    // 从 select 通知的 descriptor 解析被选中的工具 key；非工具选择返回 null
    private resolveSelectedTool(descriptor: any): string | null {
        const target = descriptor?._target;
        if (Array.isArray(target)) {
            for (const t of target) {
                if (!t) continue;
                if (t._ref === 'tool' && typeof t._value === 'string') return t._value;
                if (typeof t._ref === 'string' && /Tool$/.test(t._ref)) return t._ref;
            }
        }
        return null;
    }

    // 自动关闭主开关（切到其它工具时）
    private async autoTurnOffMain(tool?: string) {
        console.log('ℹ️ 自动关：当前工具已切到「' + (tool || '未知') + '」，主开关自动关闭');
        this.setState({ isEnabled: false }, () => {
            PanelStateManager.update({
                appPanel: { isEnabled: false }
            }, { debounceMs: 0 }).catch(e => console.warn('⚠️ 主开关状态持久化失败:', e));
            setMainToggle(false).catch(e => console.warn('⚠️ 主开关共享状态写入失败:', e));
        });
    }

    // ===== 工具巡检：「切到其它工具自动关」的兜底通道 =====
    // 只靠 select 通知不够——以下切工具路径 PS 不会以「带工具名」的形式广播 select：
    //  1) 按快捷键/动作切出笔刷：通知里只有 { _ref:'brush' }（笔刷预设），工具是被预设
    //     间接带过去的；混合器/涂抹类预设还会连工具一起换，通知里压根没有工具名；
    //  2) 回放录好的 PS 动作（Action）切工具：回放链路不保证向 UXP 广播工具 select。
    // 所以主开关开启期间按 300ms 轮询一次当前工具，只在「工具真的变了」时判定。
    private static readonly TOOL_WATCH_INTERVAL_MS = 300;

    // 判定某个工具是否属于「其它工具」（主开关开启时切到它就自动关）。
    // 名单之外再按关键词兜底：绘制类工具的内部 ID 在不同 PS 版本下会变（混合器画笔就有
    // mixerBrushTool / wetBrushTool 两种），穷举名单必然漏，带 brush/eraser/stamp/smudge
    // 字样的 ID 一定属于「动笔」的工具，不会误伤选区类工具。
    private static isOtherTool(tool: string | null): boolean {
        if (!tool) return false;
        if (App.AUTO_OFF_TOOLS.indexOf(tool) !== -1) return true;
        return /brush|eraser|stamp|smudge/i.test(tool);
    }

    // 读取当前工具 ID：优先用 HotkeyBridge 里已验证过的 application.tool._enum，
    // 读不到再退到 UXP 的 app.currentTool。
    //
    // ⚠️ 两次读取都必须走 psRead（模态作用域）：本函数既被 300ms 巡检调用，
    // 也被通知回调（maybeAutoTurnOff）调用 —— 后者落在 PS 忙碌窗口内时，
    // 裸读会直接换回一个宿主原生报错框（绕过 try/catch）。
    private async readCurrentToolId(): Promise<string | null> {
        // ⚠️ 两次读取都放进**同一个**模态作用域（2026-10-08 第二轮）：
        // `getSelectedBrushToolEnum()` 是裸 batchPlay get（`application.tool`），
        // 而本函数由 300ms 工具巡检与通知回调共同调用 —— 它落在文档级忙碌窗口里
        // 就是一次宿主原生弹框（本轮用户实测「打开/关闭超大文档连点八下」的来源之一）。
        // 以前只把 `app.currentTool` 那一步包进了 psRead，第一条仍然是裸读。
        // retries:0 —— 巡检每 300ms 一轮，丢一轮无副作用，不值得为它排队。
        return await psRead<string | null>(async () => {
            try {
                const t = await getSelectedBrushToolEnum();
                if (t) return t;
            } catch { /* 退到 UXP API */ }
            const cur: any = (app as any)?.currentTool;
            const id = typeof cur === 'string' ? cur : cur?.id;
            return typeof id === 'string' && id ? id : null;
        }, { label: '读取当前工具', retries: 0 });
    }

    // 按「主开关开启 + 选项开启」启停巡检：不需要时不跑，避免无谓轮询。
    private syncToolWatch() {
        const need = this.state.isEnabled && this.state.autoOffOnOtherTool;
        if (need && !this.toolWatchTimer) {
            this.lastKnownTool = null; // 新一轮先取基准，不追溯开开关之前的工具
            this.toolWatchTimer = setInterval(() => { void this.pollToolChange(); }, App.TOOL_WATCH_INTERVAL_MS);
            void this.pollToolChange();
        } else if (!need && this.toolWatchTimer) {
            clearInterval(this.toolWatchTimer);
            this.toolWatchTimer = null;
            this.lastKnownTool = null;
        }
    }

    private async pollToolChange() {
        if (!this.state.isEnabled || !this.state.autoOffOnOtherTool) return;
        // 并发守卫；上一次查询若卡在模态状态里迟迟不返回，超过 3s 就放行，避免巡检永久停摆
        if (this.toolWatchBusy && Date.now() - this.toolWatchBusySince < 3000) return;
        // ⚠️ 忙碌闸门：readCurrentToolId 会发 batchPlay get（application.tool）。
        // 本轮询与用户操作完全异步，切文档期间落进忙碌窗口就会弹宿主原生报错框。
        if (isPsBusy()) return;
        this.toolWatchBusy = true;
        this.toolWatchBusySince = Date.now();
        try {
            const tool = await this.readCurrentToolId();
            if (!tool) return;
            const prev = this.lastKnownTool;
            this.lastKnownTool = tool;
            // 首轮只记基准；工具没变也不判，避免「开关一开就被自己关掉」
            if (prev === null || prev === tool) return;
            if (App.isOtherTool(tool)) await this.autoTurnOffMain(tool);
        } catch { /* 单次失败不影响下一轮 */ } finally {
            this.toolWatchBusy = false;
        }
    }

    // ===== 活动文档身份巡检（文档级事件的兜底通路）=====
    // 与「快速蒙版巡检」不同，本巡检**始终开启**：它守的是正确性（文档换了却没人
    // 知道 ⇒ 缓存/快照指向已销毁的文档、闸门不生效），而不是某个可选功能的刷新。
    private startDocWatch() {
        if (this.docWatchTimer) return;
        this.docWatchTimer = setInterval(() => { void this.pollDocIdentity(); }, App.DOC_WATCH_INTERVAL_MS);
        void this.pollDocIdentity();
    }

    /**
     * 读一次活动文档 id，与上次比对；变了就按「文档级变化」处理。
     *
     * ⚠️ 必须用 `psTryRead` 而不是 `psRead`：后者把「读失败」与「读到 null」
     * 都压成 null，而这两者语义完全相反 —— 读失败（忙碌期）**不能**当作
     * 「文档没了」（否则会误判成切文档、白白作废在途任务与缓存）。
     */
    private async pollDocIdentity() {
        // ① 闩锁生效期间：本巡检是**唯一**被允许继续跑的通路，负责推进并释放闩锁。
        //    ⚠️ 必须先于粗筛判断 —— 闩锁本身就让 isPsBusy() 恒为真，先判粗筛会导致
        //    「闩锁一开就再也没人去关它」（自锁）。
        if (isDocLatchActive()) {
            await this.advanceDocLatch();
            return;
        }
        // ② 常规分支：粗筛 + 一次模态作用域内的身份读。
        // 粗筛：明显还在忙就不去读（本轮跳过，下一轮再看）。文档级事件本身也会
        // 打长窗口，因此忙碌期通常正是「刚发生文档级变化」的时段。
        if (isPsBusy()) return;
        const r = await psTryRead<number | null>(() => {
            const d = app.activeDocument;
            return d ? (typeof d.id === 'number' ? d.id : null) : null;
        }, { label: '检测活动文档', retries: 0 });
        if (!r.ok) return;                       // 没读到 ⇒ 不做任何判定
        this.applyDocIdentity(r.value);
    }

    /**
     * 推进文档级闩锁：用「**只拿锁、不读数据**」的空模态请求问宿主是否已可控。
     *
     * 为什么必须是「不读数据」的探测：任何 get 在宿主忙碌期都会弹一次原生
     * 「命令"获取"当前不可用」，探测本身就会变成用户看到的那堆警告窗口。
     * `executeAsModal` 的锁语义是官方的互斥原语：PS 自己握着模态作用域时请求
     * 只会排队到超时（可捕获的异常），拿到锁则说明 PS 已把控制权交出来。
     *
     * 连续两次成功才放行（`DOC_LATCH_CONFIRM_MS` 内）：单次成功可能只是宿主在
     * 两个阶段之间短暂松手，此时放行会让图层树快照 / 蒙版同步那几条**裸读**
     * 撞回忙碌窗口 —— 那正是本轮要修的现象。
     */
    private async advanceDocLatch() {
        if (this.docLatchProbeBusy) return;
        this.docLatchProbeBusy = true;
        let released = false;
        try {
            const now = Date.now();
            const free = await probeHostIdle(App.DOC_LATCH_PROBE_TIMEOUT_MS);
            if (!free) {
                // 宿主仍在自己的模态作用域里（打开 / 关闭 / 保存大文档尚未结束）
                // ⇒ 续期闩锁：所有读取（含未走 psRead 的裸读）继续一起退避。
                // 同时拉长下一次探测的间隔（指数退避，见 DOC_LATCH_PROBE_MAX_SHIFT）：
                // 打开大文档动辄几十秒，固定 400ms 会打出几十次模态命令，
                // 触发 UXP 内部警告「Too many modal scope commands」。
                this.docLatchLastOkAt = 0;
                this.docLatchOkStreak = 0;   // 失败即清零：成功必须**连续**
                this.docLatchProbeFailures = Math.min(this.docLatchProbeFailures + 1, App.DOC_LATCH_PROBE_MAX_SHIFT);
                extendDocLatch();
            } else {
                // ✅ 探测成功 ⇒ 退避立即清零：随后的确认连测回到 400ms 快速节奏，
                // 「连续 3 次、间隔 ≤1200ms」的放行判据不受退避拖累。
                this.docLatchProbeFailures = 0;
                const prevOkAt = this.docLatchLastOkAt;
                this.docLatchLastOkAt = now;
                this.docLatchOkStreak = (prevOkAt > 0 && now - prevOkAt <= App.DOC_LATCH_CONFIRM_MS)
                    ? this.docLatchOkStreak + 1
                    : 1;
                // 三个条件**同时**成立才允许放行（任一不满足就继续压）：
                //   ① 连续成功探测次数达标 —— 过滤「阶段间隙里的偶发松手」；
                //   ② 闩锁已保持够久 —— 打开大文档是分阶段的，阶段数越多间隙越多；
                //   ③ 补一次**受保护的数据读取**并真的读到 —— 拿到锁 ≠ 拿得到数据。
                //      这是最关键的一条：它把「宿主愿意给锁」和「宿主真能回答 get」
                //      区分开来，而后者才是我们真正需要的许可。
                if (this.docLatchOkStreak >= App.DOC_LATCH_CONFIRM_COUNT
                    && isDocLatchMinHoldElapsed(App.DOC_LATCH_MIN_HOLD_MS)) {
                    // 用 bypassCoarseGate 穿透闩锁自身的粗筛（闩锁期间恒为真）。
                    // 读取本身在模态作用域内 ⇒ 即使判断错也只是可捕获的失败，不会弹框。
                    const r = await psTryRead<number | null>(() => {
                        const d = app.activeDocument;
                        return d ? (typeof d.id === 'number' ? d.id : null) : null;
                    }, { label: '闩锁放行前确认', retries: 0, bypassCoarseGate: true });
                    if (r.ok) {
                        // ✅ 宿主既给了锁、也答了 get ⇒ 真正可控。
                        released = true;
                        endDocLatch();
                        this.docLatchLastOkAt = 0;
                        this.docLatchOkStreak = 0;
                        // 这次确认读取本身就是一次身份采样，直接落账（省一轮 500ms 巡检）。
                        this.applyDocIdentity(r.value);
                    } else {
                        // 拿得到锁却读不到 ⇒ 宿主还在忙（典型：解析中但未持锁）。
                        // 这是「持续忙碌」的直接证据 ⇒ 清零并续期，等下一轮重来。
                        this.docLatchLastOkAt = 0;
                        this.docLatchOkStreak = 0;
                        extendDocLatch();
                    }
                }
            }
        } finally {
            this.docLatchProbeBusy = false;
        }
        // 放行后的身份采样若又登记了一次文档级变化（闩锁被重新开启），
        // 立刻补一次探测把它收掉 —— 此时宿主刚确认空闲，不会无限递归。
        // 未放行 ⇒ 按连续失败次数指数退避（400→800→1600→3200 封顶）。
        const nextDelay = released
            ? 0
            : App.DOC_LATCH_PROBE_MS * (1 << this.docLatchProbeFailures);
        if (isDocLatchActive()) this.scheduleDocLatchProbe(nextDelay);
    }

    /** 排一次闩锁探测（同一时刻只允许一个 pending）。 */
    private scheduleDocLatchProbe(delay: number) {
        if (this.docLatchProbeTimer) return;
        this.docLatchProbeTimer = setTimeout(() => {
            this.docLatchProbeTimer = null;
            void this.advanceDocLatch();
        }, Math.max(0, delay));
    }

    /** 把一次身份采样结果落到状态上（两条分支共用，避免逻辑漂移）。 */
    private applyDocIdentity(id: number | null) {
        if (this.lastDocId === null && id === null) return;   // 双方都「没有文档」⇒ 无事
        if (this.lastDocId === null && id !== null) {
            // ⚠️⚠️ 2026-10-08 第三轮修正：这里**必须**登记文档级变化。
            //
            // 旧写法认为「新开文档的 open 事件通路已经覆盖了」，于是只记基准就返回。
            // 但**冷启动**（PS 刚启动 / 插件刚重载 / 第一份文档正在打开）恰恰是
            // open 事件最不可靠的时刻 —— 兜底通路于是在它唯一被需要的场景里静默失效：
            // 整个解析/建树期间既没有闩锁、也不推进世代号，所有读取照常发出去。
            // 用户实测「每次重开 PS、重载插件、打开 400MB PSD ⇒ 触发率 100%」正是它。
            //
            // 代价核算：若事件通路已登记过一次，这里只是**再**推进一次世代号 + 续期
            // 静默窗口（多等一点、多作废一份缓存）；而漏登记的代价是宿主原生弹框。
            // ⇒ 重复登记是安全侧，一律登记。
            //
            // ⚠️ requireMinHold=false：本分支意味着我们**刚刚成功读到**宿主的回答
            // （正是这次读取告诉我们「有文档了」），宿主并不忙，不必强制多等。
            this.lastDocId = id;
            this.onDocumentLevelChange(false);
            return;
        }
        if (id === this.lastDocId) return;
        this.lastDocId = id;
        this.onDocumentLevelChange(true);
    }

    /**
     * 文档级变化的统一善后：作废在途读取与缓存。
     *
     * ⚠️ 必须「先登记世代号（== 打长静默窗口 + 开闩锁）、再清缓存」：
     *   · `noteDocLevelEvent()` ⇒ `docGeneration++`，让 `psAccess.psTryRead` 作废
     *     **在途**读取的返回值（防止用已销毁文档的数据回写 UI）；
     *   · 清 layerInfo 短 TTL 缓存与图层树快照 ⇒ 防止**新**读取吃到旧文档的数据。
     *
     * @param requireMinHold 是否要求闩锁至少保持 `DOC_LATCH_MIN_HOLD_MS` 才允许放行
     *   （见 `DOC_LATCH_MIN_HOLD_MS` 的说明）。
     */
    private onDocumentLevelChange(requireMinHold = true) {
        noteDocLevelEvent(requireMinHold);
        invalidateLayerInfoCache();
        invalidateLayerSnapshot();
    }

    // ===== 快速蒙版巡检（详见字段注释里的复合根因）=====
    // 按「填充选项展开且可见」启停：不可见时没有刷新的必要，不跑无谓轮询。
    private syncQuickMaskWatch() {
        const need = this.state.fillOptionsVisible && this.state.isExpanded;
        if (need && !this.quickMaskTimer) {
            this.quickMaskTimer = setInterval(() => { void this.pollQuickMask(); }, App.QUICK_MASK_WATCH_INTERVAL_MS);
            void this.pollQuickMask();
        } else if (!need && this.quickMaskTimer) {
            clearInterval(this.quickMaskTimer);
            this.quickMaskTimer = null;
        }
    }

    // 只读两个属性（id / quickMaskMode），经 psRead 进模态作用域；
    // 单次失败（撞忙碌窗口）不影响下一轮。
    private async pollQuickMask() {
        if (this.quickMaskBusy) return;
        // ⚠️ 粗筛：本函数是**无条件 300ms 轮询**，与用户操作完全异步，切文档这类
        // 长命令期间必然有机会落进忙碌窗口。忙碌时跳过本轮（快速蒙版状态不要求实时）。
        if (isPsBusy()) return;
        this.quickMaskBusy = true;
        try {
            const r = await psTryRead<{ id: number | null; isInQuickMask: boolean } | null>(() => {
                const doc = app.activeDocument;
                if (!doc) return null;
                return {
                    id: typeof doc.id === 'number' ? doc.id : null,
                    isInQuickMask: !!doc.quickMaskMode,
                };
            }, { label: '读取快速蒙版状态', retries: 0 });
            if (!r.ok || !r.value) return;
            const { id, isInQuickMask } = r.value;
            // 顺带承担「活动文档身份」的一次采样：多读的只是一个已经读到的属性。
            if (id !== null && this.lastDocId !== null && id !== this.lastDocId) {
                this.lastDocId = id;
                this.onDocumentLevelChange();
                return;   // 文档刚换 ⇒ 本轮的 quickMask 结论属于上一份文档，丢弃
            }
            if (id !== null) this.lastDocId = id;
            // 实例字段与 state 双写：前者供描边色板灰度判定，后者驱动开关禁用态。
            this.isInQuickMask = isInQuickMask;
            if (this.state.isInQuickMask !== isInQuickMask) {
                this.setState({ isInQuickMask });
            }
        } finally {
            this.quickMaskBusy = false;
        }
    }

    // 通知里出现「笔刷/工具预设」引用：切预设通常会把工具一起带过去，
    // 但 descriptor 里没有工具名，只能回查当前工具再判定。
    private isToolPresetDescriptor(descriptor: any): boolean {
        const target = descriptor?._target;
        if (!Array.isArray(target)) return false;
        return target.some((t: any) => {
            const ref = t?._ref;
            return typeof ref === 'string' && (ref === 'brush' || ref === 'toolPreset' || ref === 'preset');
        });
    }

    // 事件通道判定：select 通知能解析出工具就直接判；解析不出但本次事件确实动了
    // 笔刷/工具预设，就回查当前工具再判。
    private async maybeAutoTurnOff(eventName?: string, descriptor?: any) {
        if (!this.state.isEnabled || !this.state.autoOffOnOtherTool) return;
        if (eventName !== 'select' && eventName !== 'set') return;
        let tool = eventName === 'select' ? this.resolveSelectedTool(descriptor) : null;
        // ⚠️ 忙碌闸门：本函数由通知回调直接调用，而 descriptor 里带工具/笔刷预设引用时
        // 需要 readCurrentToolId() 发一次 batchPlay get。通知是在命令执行【中途】派发，
        // 此刻发 get 会被宿主拒绝并弹原生报错框（绕过 try/catch）。
        // 这里直接放弃本轮：同样的判定由 pollToolChange（300ms 轮询兜底）覆盖，
        // 且它的前置条件与本函数完全一致（isEnabled + autoOffOnOtherTool），
        // 因此不存在「放弃就永远不判定」的缺口。
        if (!tool && this.isToolPresetDescriptor(descriptor)) {
            if (isPsBusy()) return;
            tool = await this.readCurrentToolId();
        }
        if (!tool) return;
        this.lastKnownTool = tool; // 与巡检共享基准，避免同一件事被判两次
        if (App.isOtherTool(tool)) await this.autoTurnOffMain(tool);
    }

    // 检测蒙版模式状态
    async checkMaskModes() {
        try {
            const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
            this.isInLayerMask = layerInfo?.isInLayerMask || false;
            this.isInQuickMask = layerInfo?.isInQuickMask || false;
            this.isInSingleColorChannel = layerInfo?.isInSingleColorChannel || false;
            // ⚠️ 必须回写 state：开关的禁用态渲染读的是 state.isInQuickMask，
            // 只写实例字段再 forceUpdate 的话界面永远停在旧值（历史 bug：
            // 进入快速蒙版后「新建图层」开关不变灰，直到下一次选区变更才刷新）。
            // 单通道同理：它的禁用态（「新建图层」）与描边色板灰度都读 state。
            // 图层蒙版同理：它的禁用态（「新建图层」）也读 state。
            const patch: any = {};
            if (this.state.isInQuickMask !== this.isInQuickMask) {
                patch.isInQuickMask = this.isInQuickMask;
            }
            if (this.state.isInLayerMask !== this.isInLayerMask) {
                patch.isInLayerMask = this.isInLayerMask;
            }
            if (this.state.isInSingleColorChannel !== this.isInSingleColorChannel) {
                patch.isInSingleColorChannel = this.isInSingleColorChannel;
            }
            if (Object.keys(patch).length > 0) {
                this.setState(patch);
            }
        } catch (error) {
            console.error('检测蒙版模式失败:', error);
            this.isInLayerMask = false;
            this.isInQuickMask = false;
            this.isInSingleColorChannel = false;
        }
    }

    // 处理Photoshop通知事件
    async handleNotification(eventName?: string, descriptor?: any) {
        // ⚠️ 事件到达瞬间打忙碌标记（切文档用更长的窗口，见 psProbe）。
        // 必须在这里打、且不能打到探测函数体内，否则窗口自我延长成自锁。
        markPsBusyForEvent(eventName, descriptor);
        // 图层结构/ 通道选择可能变了 ⇒ 让 layerInfo 缓存失效（纯内存，零 IPC）。
        // ⚠️ 纯选区 set事件**不**失效（见 shouldInvalidateLayerInfo 的注释）：
        // 那会让每次套索都丢掉缓存命中率，正好抵消这次优化的收益。
        if (shouldInvalidateLayerInfo(eventName, descriptor)) {
            invalidateLayerInfoCache();
        }
        // 状态探测走防抖（不能立刻 get：PS 命令执行中途派发的事件会撞忙碌窗口）
        this.maskProbeDebounced();

        // 主开关处于开启状态，且开启了「切到其它工具即关」选项时，
        // 若本次事件确实把工具切到了画笔/铅笔/橡皮等其它工具，则自动关闭主开关。
        try {
            await this.maybeAutoTurnOff(eventName, descriptor);
        } catch (e) {
            console.warn('⚠️ 工具切换自动关闭主开关判断失败:', e);
        }
    }

    /**
     * 描边色板当前**显示**的 RGB —— 唯一事实来源。
     * 色板渲染与拾色器初始色都取自这里，保证「面板显示什么，拾色器就打开什么」。
     * 蒙版/单通道/清除模式下描边只用灰度 ⇒ 色板显示灰度值。
     */
    getStrokeDisplayColor() {
        const { strokeColor, clearMode } = this.state;
        if (!strokeColor) {
            return { red: 0, green: 0, blue: 0 };
        }
        // 四个标志一律读 state（而非实例字段）：它们是渲染期唯一事实来源，
        // 三层蒙版/单通道的灰度显示与「新建图层」禁用都靠 state 变化触发重渲染。
        const shouldShowGray = clearMode
            || this.state.isInLayerMask
            || this.state.isInQuickMask
            || this.state.isInSingleColorChannel;
        if (!shouldShowGray) {
            return { red: strokeColor.red, green: strokeColor.green, blue: strokeColor.blue };
        }
        const grayValue = Math.round(strokeColor.red * 0.299 + strokeColor.green * 0.587 + strokeColor.blue * 0.114);
        return { red: grayValue, green: grayValue, blue: grayValue };
    }

    // 获取描边颜色预览样式
    getStrokeColorPreviewStyle() {
        const { red, green, blue } = this.getStrokeDisplayColor();
        return { backgroundColor: `rgb(${red}, ${green}, ${blue})` };
    }  

    // ===== 许可证相关方法 =====

    /**
     * 把「授权对话框是否打开」同步到 body 的 `license-dialog-open` 类。
     *
     * 由 render() 每次调用（幂等）：先按目标态 add/remove，再回读校验，
     * 修掉「宿主/CSSOM 把类弄丢了却没人补」的不一致（唯一写点，不与其它副作用打架）。
     *
     * 为什么必须渲染期同步而不是 componentDidUpdate 的 `!==` 判断：
     * isLicenseDialogOpen 初始值就是 true（types/state.ts），首次加载时
     * prevState === state ⇒ `!==` 恒假 ⇒ 类加不上 ⇒ number 输入穿透覆盖授权面板。
     */
    syncLicenseDialogClass() {
        const shouldOpen = !!this.state.isLicenseDialogOpen;
        const has = document.body.classList.contains('license-dialog-open');
        if (shouldOpen === has) return;
        if (shouldOpen) document.body.classList.add('license-dialog-open');
        else document.body.classList.remove('license-dialog-open');
    }

    async checkLicenseStatus() {
        try {
            // 统一判定（唯一事实来源）：TRIAL_ 密钥只算试用，永不计入正式授权。
            // 早期版本这里直接取 status.isValid，导致试用态被误判为「已激活」，
            // 重载后「注销激活状态」菜单项在试用态下依然可点。
            const { isLicensed, isTrial, trialDaysRemaining } = await LicenseManager.getLicenseState();

            // 控制对话框打开逻辑：首次启动若未授权则打开
            this.setState({
                isLicensed,
                isTrial,
                trialDaysRemaining,
                isLicenseDialogOpen: !(isLicensed || isTrial)
            });
            // 「注销激活状态」只有正式激活（非试用）才可点击
            MenuManager.setLicenseLogoutEnabled(isLicensed && !isTrial);
            // 检查完成后广播一次：绘画工具箱监听此事件、经 getLicenseState 的
            // 记忆化缓存立即拿到同一份结果 —— 两面板的锁定遮罩/弹窗同刻出现。
            document.dispatchEvent(new Event('license-updated'));
        } catch (e) {
            console.warn('检查许可证状态失败:', e);
            this.setState({ isLicensed: false, isTrial: false, isLicenseDialogOpen: true });
            MenuManager.setLicenseLogoutEnabled(false);
        }
    }

    handleLicenseVerified() {
        this.setState({ isLicensed: true, isTrial: false, isLicenseDialogOpen: false });
        // body 类由 render() 里的 syncLicenseDialogClass() 按 state 派生，无需手动 remove。
        // 在弹窗关闭的同刻广播：绘画工具箱的锁定遮罩随之解除，两遮罩同步消失。
        // （广播不能更早 —— LicenseDialog 验证成功后还要停留 800ms 展示「激活成功！」）
        document.dispatchEvent(new Event('license-updated'));
        // 正式激活后可注销
        MenuManager.setLicenseLogoutEnabled(true);
    }

    handleTrialStarted() {
        // 试用7天
        this.setState({ isLicensed: false, isTrial: true, isLicenseDialogOpen: false, trialDaysRemaining: 7 });
        // body 类同上，由 render() 派生
        // 同上：弹窗关闭同刻广播，工具箱同步切换到试用态（横幅变绿、不锁定）
        document.dispatchEvent(new Event('license-updated'));
        // 试用状态不允许注销
        MenuManager.setLicenseLogoutEnabled(false);
    }

    closeLicenseDialog() {
        this.setState({ isLicenseDialogOpen: false });
        // body 类同上，由 render() 派生
    }

    // 新增：手动打开授权对话框
    openLicenseDialog() {
        // ⚠️ 这里**不要**再手动 add body 类：class 与 state 的对应关系由
        // render() → syncLicenseDialogClass() 单点维护（曾因初始 state 即 true
        // 而 componentDidUpdate 的 `!==` 判断恒假，导致首次加载时类加不上）。
        this.setState({ isLicenseDialogOpen: true });
    }

    // 临时调试方法：重置许可证状态
    async resetLicenseForTesting() {
        try {
            await LicenseManager.clearLicense();
            // 也清除试用记录
            try {
                const localFileSystem = storage.localFileSystem;
                const dataFolder = await localFileSystem.getDataFolder();
                const trialFile = await dataFolder.getEntry('trial.json');
                await trialFile.delete();
            } catch (e) {
                // 试用文件可能不存在，忽略错误
            }
            
            // 重置状态并显示对话框
            this.setState({
                isLicensed: false,
                isTrial: false,
                isLicenseDialogOpen: true,
                trialDaysRemaining: 0
            });
            // 注销后回到未激活态，菜单项重新禁用
            MenuManager.setLicenseLogoutEnabled(false);
            
            console.log('许可证状态已重置，可重新测试授权流程');
        } catch (error) {
            console.error('重置许可证状态失败:', error);
        }
    }

    render() {
        // 「授权对话框打开」的 body 类：**渲染期由 state 单向派生**（幂等、每次渲染都对齐）。
        // ⚠️ 为什么必须放在这里，不能靠 componentDidUpdate 的 `!==` 判断：
        //      isLicenseDialogOpen 的**初始值就是 true**（types/state.ts），首次加载时
        //      prevState === state（都是 true）⇒ `!==` 恒假 ⇒ 类永远加不上 ⇒ 面板出现但
        //      下方 number 输入（原生视图，永远画在最上层）穿透覆盖在面板之上。
        //      再次点击入口时 state 由 false→true，`!==` 才成立 ⇒ 类正常加上 ⇒ 表现为
        //      「首次加载有 bug、再次唤出正常」。派生式写法对「初始即 true」和后续
        //      任意切换都成立，同时天然覆盖首次加载 / 自动激活后 / 注销后重开三条路径。
        //      （原 componentDidUpdate 里那段 add/remove、以及各处的 remove 调用均已删除，
        //        避免多写点互相打架；本行是唯一写点。）
        this.syncLicenseDialogClass();
        // 专注模式：两个前置选项同时勾选即成立（推导值，不额外存 state）
        const focusMode = this.isFocusMode();
        // 紧凑模式（仅父面板作用域）：三行 radio 改三列、去掉齿轮，标签兼作子面板入口
        const compactApp = !!this.state.compactModes?.app;
        return (
            <>
            <div className="panel" ref={this.panelRef}>
            <div className="panel-section">
                {/* 主面板滚动容器即最外层 .panel（同绘画工具箱父面板同款外壳）：
                    所有分区都放在 .panel-section 内，由它产生滑动条；4 个子面板是 absolute，
                    挂在 .panel-section 之后的同级节点上、不随滚动。
                    ⚠️ 不再额外套一层 .panel（之前 1354 内层 .panel 与外壳 .panel 各带 10px
                    内边距，叠加成 20px，与工具箱 10px 不一致），现仅外壳 .panel 提供 10px。 */}
                <h3 className="main-title" title={helpTexts.selectionFill.panelTitle}>
                    选区填充2.0
                </h3>
                <div className="divider"></div>
                {compactApp && focusMode ? (
                    /* 紧凑 + 专注模式：主按钮收成单行 notify-bar——左星形 indicator、中「专注模式」、
                       右 sp-switch（开关即控制），省纵向高度。开关放右侧单独控制，点星/文案不触发切换。
                       两态配色与主按钮一致：开=ok 绿描边绿星，关=disabled 灰描边灰星（不用 warn 橙，
                       橙在本插件语义里是「异常/待处理」，关闭只是未启用）。文案沿用主按钮的
                       「功能开启/功能关闭」，并标注当前处于专注模式。 */
                    <div className={this.state.isEnabled ? 'notify-bar notify-bar-ok' : 'notify-bar notify-bar-disabled'}>
                        <FocusTargetIcon className={this.state.isEnabled ? 'indicator-icon-lg indicator-icon-ok' : 'indicator-icon-lg'} />
                        <span className="notify-text">{this.state.isEnabled ? '功能开启（专注）' : '功能关闭'}</span>
                        <span className="mask-sync-status-spacer" />
                        <ToggleSwitch checked={this.state.isEnabled} onChange={this.handleButtonClick} title={helpTexts.selectionFill.mainButtonFocus}  />
                    </div>
                ) : (
                <div
                    role="button"
                    tabIndex={0}
                    className="main-button"
                    onClick={this.handleButtonClick}
                    title={focusMode ? helpTexts.selectionFill.mainButtonFocus : helpTexts.selectionFill.mainButton}>
                    <div className="main-button-content">
                        {/* 专注模式下圆点换成同尺寸、同双色的靶心图标（Spectrum Target）；非专注模式仍是原来的圆点 */}
                        {focusMode ? (
                            <FocusTargetIcon
                                className={this.state.isEnabled ? 'indicator-icon-lg indicator-icon-ok' : 'indicator-icon-lg'}
                            />
                        ) : (
                            <div className={this.state.isEnabled ? 'indicator indicator-lg indicator-ok' : 'indicator indicator-lg indicator-disabled'}></div>
                        )}
                        {/* 文案两态共用定宽槽位 .main-button-label：切换开关时圆点不再左右位移 */}
                        <span className={!this.state.isEnabled
                            ? 'label-disabled main-button-label'
                            : 'main-button-text main-button-label'}>
                            {this.state.isEnabled ? '功能开启' : '功能关闭'}
                        </span>
                    </div>
                </div>
                )}

                <div className="app-blendmode-container">
                    <span className={this.state.clearMode ? 'app-blendmode-label label-disabled' : 'app-blendmode-label'} 
title={helpTexts.selectionFill.blendMode}>
                    混合模式
                    </span>

                    <Select
                        value={this.state.blendMode || "正常"}
                        groups={BLEND_MODE_OPTIONS}
                        disabled={this.state.clearMode}
                        onChange={(v) => this.handleBlendModeChange({ target: { value: v } } as React.ChangeEvent<HTMLSelectElement>)}
                        title={helpTexts.selectionFill.blendModeSelect}
                    />
                </div>

                <div className="slider-container">
                    <div className="row-between"
                        title={helpTexts.selectionFill.opacity}>
                        <label
                            className="label-drag label-4"
                            onMouseDown={(e) => this.handleLabelMouseDown(e, 'opacity')}
                            title={helpTexts.selectionFill.opacity}>
                            不透明度
                        </label>
                        <RangeSlider
                            min={0}
                            max={100}
                            step={1}
                            value={this.state.opacity}
                            onChange={this.handleOpacityChange}
                            className="slider-track"
                            title={helpTexts.selectionFill.opacitySlider}
                        />
                        <div className="row-start">
                            <div className="num-input-row">
                                <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    value={this.state.opacity}
                                    onChange={(e) => this.setState({ opacity: Number(e.target.value) })}
                                    title={helpTexts.selectionFill.opacityInput}
                                />
                            </div>
                            <span className="num-unit">%</span>
                        </div>
                    </div>

                    <div className="row-between"
                        title={helpTexts.selectionFill.feather}>
                        <label
                            className="label-drag label-2"
                            onMouseDown={(e) => this.handleLabelMouseDown(e, 'feather')}
                            title={helpTexts.selectionFill.feather}>
                            羽化
                        </label>
                        {/* ⚠️ 步长必须与数字输入框一致为 1：滑杆若仍走 0.5，会写入「X.5」，
                            而 .num-input-row 是定宽 34px，小数位显示不下（只显出「1…」）。 */}
                        <RangeSlider
                            min={0}
                            max={20}
                            step={1}
                            value={this.state.feather}
                            onChange={this.handleFeatherChange}
                            className="slider-track"
                            title={helpTexts.selectionFill.featherSlider}
                        />
                        <div className="row-start">
                            <div className="num-input-row">
                                <input
                                    type="number"
                                    min="0"
                                    max="20"
                                    step="1"
                                    value={this.state.feather}
                                    onChange={(e) => this.setState({ feather: Number(e.target.value) })}
                                    title={helpTexts.selectionFill.featherInput}
                                />
                            </div>
                            <span className="num-unit">px</span>
                        </div>
                    </div>
                </div>

 {/* 新增选区改造区域 */}
                {this.state.selectionOptionsVisible && (
                <div className="collapse-section" data-section-id="selectionOptions">
                            <div className="collapse-header" onClick={this.toggleSelectionOptions} title={helpTexts.selectionFill.selectionOptionsToggle}>

                                <div className={this.state.isSelectionOptionsExpanded ? 'collapse-icon-expanded' : 'collapse-icon'}>
                                    <ExpandIcon expanded={this.state.isSelectionOptionsExpanded} />
                                </div>
                                <span className="label-4">选区改造</span>
                            </div>
                            {this.state.isSelectionOptionsExpanded && (
                            <div className="collapse-content-expanded">
                                <div className="row-between">
                                    <label
                                        className="label-drag label-2"
                                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'selectionSmooth')}
title={helpTexts.selectionFill.selectionSmooth}>
                                        平滑
                                    </label>
                                    <RangeSlider
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={this.state.selectionSmooth}
                                        onChange={this.handleSelectionSmoothChange}
                                        className="slider-track"
                                        title={helpTexts.selectionFill.selectionSmoothSlider}
                                    />
                                    <div className="row-start">
                                        <div className="num-input-row">
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={this.state.selectionSmooth}
                                            onChange={(e) => this.setState({ selectionSmooth: Number(e.target.value) })}
                                                                title={helpTexts.selectionFill.selectionSmoothInput}
                                        />
                                        </div>
                                        <span className="num-unit">%</span>
                                    </div>
                                    </div>
                            
                                    <div className="row-between">
                                    <label
                                        className="label-drag label-2"
                                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'selectionContrast')}
title={helpTexts.selectionFill.selectionContrast}>
                                        锐度

                                    </label>
                                    <RangeSlider
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={this.state.selectionContrast}
                                        onChange={this.handleSelectionContrastChange}
                                        className="slider-track"
                                        title={helpTexts.selectionFill.selectionContrastSlider}
                                    />
                                    <div className="row-start">
                                        <div className="num-input-row">
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={this.state.selectionContrast}
                                            onChange={(e) => this.setState({ selectionContrast: Number(e.target.value) })}
                                                                title={helpTexts.selectionFill.selectionContrastInput}
                                        />
                                        </div>
                                        <span className="num-unit">%</span>
                                    </div>
                                    </div>

                                    <div className="row-between">
                                    <label
                                        className="label-drag"
                                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'selectionExpand')}
title={helpTexts.selectionFill.selectionExpand}>
                                        扩散
                                    </label>
                                    <RangeSlider
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={this.state.selectionExpand}
                                        onChange={this.handleSelectionExpandChange}
                                        className="slider-track"
                                        title={helpTexts.selectionFill.selectionExpandSlider}
                                    />
                                    <div className="row-start">
                                        <div className="num-input-row">
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={this.state.selectionExpand}
                                            onChange={(e) => this.setState({ selectionExpand: Number(e.target.value) })}
                                                                title={helpTexts.selectionFill.selectionExpandInput}
                                        />
                                        </div>
                                        <span className="num-unit">%</span>
                                    </div>
                                    </div>
                            </div>
                            )}
                </div>
                )}


                {this.state.fillOptionsVisible && (
                <div className="collapse-section" data-section-id="fillOptions">
                    <div className="collapse-header" onClick={this.toggleExpand} title={helpTexts.selectionFill.fillOptionsToggle}>
                        <div className={this.state.isExpanded ? 'collapse-icon-expanded' : 'collapse-icon'}>
                            <ExpandIcon expanded={this.state.isExpanded} />
                        </div>
                        <span className="label-4">填充选项</span>
                    </div>
                    {this.state.isExpanded && (
                    <div className="collapse-content-expanded">

                        {/* 填充模式选择：置于「填充选项」内容区首位（普通/紧凑模式一致）。
                            逻辑理由：它是本分区的主决策项——决定后续按纯色/图案/渐变哪条链路执行，
                            应当先于「新建图层 / 描边模式 / 清除模式」这几个执行期开关出现。
                            ⚠️ .fill-mode-section 是给 app.css 定位用的显式类名：UXP 不支持 :has()，
                               不能靠「.panel-section 是首元素」这类结构关系反推定位。 */}
                        <div className="panel-section fill-mode-section">
                            {/* ⚠️ 2026-10-07 删除「填充模式」标签（用户反馈不美观）：
                                三行圆点 + 「纯色 / 图案 / 渐变」文字本身已自解释，
                                再加一行同义的标题纯属冗余，且让本区块凭空多占一行高度。
                                原生时代那个标签还兼作 tooltip 载体，现在每个选项自己都有 title。 */}
                            {compactApp ? (
                                /* 紧凑模式：3 行 radio → 3 列（与描边子面板「位置」共用 .radio-trio-group）。
                                   齿轮不渲染，改由点击文字打开对应子面板（见 labelRenderer）。 */
                                /* 🔴 2026-10-07 移除 .radio-trio 包裹层，理由同 StrokeSetting：
                                   两层嵌套在 UXP 下算不出正确容器宽度，导致三列竖排。 */
                                <RadioGroup
                                        value={this.state.fillMode}
                                        onChange={this.handleFillModeChange}
                                        options={FILL_MODE_RADIO_OPTIONS}
                                        className="radio-trio-group"
                                        // 紧凑模式下文字兼作子面板入口：点文字开面板，点圆点只切模式。
                                        // ⚠️ stopPropagation 不可省 —— 否则点文字会连带触发外层 radio-option
                                        //    的选中（父面板的 handleFillModeChange），出现「开面板同时切模式」。
                                        labelRenderer={(label, opt) => (
                                            <span
                                                className="radio-option-label radio-option-label-link"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (opt.value === 'foreground') this.toggleColorSettings();
                                                    else if (opt.value === 'pattern') this.openPatternPicker();
                                                    else this.openGradientPicker();
                                                }}
                                            >
                                                {label}
                                            </span>
                                        )}
                                    />
                            ) : (
                                /* 普通模式：纵向三行，每行右侧带齿轮（原 .radio-group-vertical + .row-end 的替代）。
                                   选项表在 render 内构造：齿轮要绑 this 的方法与 title，无法提到模块级。 */
                                <RadioGroup
                                    value={this.state.fillMode}
                                    onChange={this.handleFillModeChange}
                                    className="radio-vertical"
                                    options={[
                                        {
                                            value: 'foreground',
                                            label: '纯色',
                                            title: helpTexts.selectionFill.fgRadio,
                                            suffix: (
                                                <IconButton onClick={this.toggleColorSettings} title={helpTexts.selectionFill.fgSettings}>
                                                    <SettingsIcon/>
                                                </IconButton>
                                            ),
                                        },
                                        {
                                            value: 'pattern',
                                            label: '图案',
                                            title: helpTexts.selectionFill.patternRadio,
                                            suffix: (
                                                <IconButton onClick={this.openPatternPicker} title={helpTexts.selectionFill.patternSettings}>
                                                    <SettingsIcon/>
                                                </IconButton>
                                            ),
                                        },
                                        {
                                            value: 'gradient',
                                            label: '渐变',
                                            title: helpTexts.selectionFill.gradientRadio,
                                            suffix: (
                                                <IconButton onClick={this.openGradientPicker} title={helpTexts.selectionFill.gradientSettings}>
                                                    <SettingsIcon/>
                                                </IconButton>
                                            ),
                                        },
                                    ]}
                                />
                            )}
                        </div>

                        {compactApp ? (
                            /* 紧凑模式：两列网格——新建图层/清除模式 同一行、描边模式/色板 同一行，省出一行纵向高度 */
                            <>
                                <div className="row-between row-grid">
                                    <div className="grid-cell">
                                        <div className={this.isCreateNewLayerDisabled() ? 'row-start disabled' : 'row-start'}>
                                            <span className="label-4" title={helpTexts.selectionFill.createNewLayer}>新建图层</span>
                                            <ToggleSwitch checked={this.state.createNewLayer} onChange={this.toggleCreateNewLayer} disabled={this.isCreateNewLayerDisabled()} title={helpTexts.selectionFill.createNewLayerSwitch}  />
                                        </div>
                                    </div>
                                    <div className="grid-cell">
                                        <div className={this.state.createNewLayer ? 'row-start disabled' : 'row-start'}>
                                            {/* 紧凑模式下清除模式**没有**齿轮按钮（横向没有位置），
                                                入口交给 label 本身：开启后 label 复合 .text-button
                                                拿到 hover/按下三态，点击进入清除设置子面板（2026-10-08 用户要求）。
                                                ⚠️ onClick 仅在该开关可交互时挂上：关闭态 / 被「新建图层」禁用时
                                                   一律传 undefined，避免点到一个「看起来是标签」的死按钮。 */}
                                            <span
                                                className={this.state.clearMode ? 'label-4 text-button' : 'label-4'}
                                                title={helpTexts.selectionFill.clearMode}
                                                onClick={this.state.clearMode ? this.toggleClearSetting : undefined}
                                            >清除模式</span>
                                            <ToggleSwitch checked={this.state.clearMode} onChange={this.toggleClearMode} disabled={this.state.createNewLayer} title={helpTexts.selectionFill.clearModeSwitch}  />
                                        </div>
                                    </div>
                                </div>
                                {/* 描边模式行（.row-grid-fit）：左列「标签 + 开关」按内容宽靠左，
                                    右列撑满剩余宽度、内部用 row-end 把色板推到内容盒右缘。
                                    ⚠️ 2026-10-08 删除「描边设置」文字按钮（用户要求），功能交给
                                       「描边模式」label 本身承载 —— 与上一行「清除模式」label 完全同构：
                                       开启后复合 .text-button，点击进入对应子面板。
                                    对齐关系随之简化：右列只剩色板（槽宽 33 + 左外边距 4 = 37px），
                                       靠 .row-end 右对齐 ⇒ 色板右缘与「清除模式」开关右缘严格对齐。
                                       （原来那套「47+10+4+33 = 94px 两组同宽才能左右缘双对齐」的
                                        换算随文字按钮一起失效，见 app.css 的 .stroke-color-slot 注释。） */}
                                <div className="row-between row-grid row-grid-fit">
                                    <div className="grid-cell">
                                        <div className="row-start">
                                            <span
                                                className={this.state.strokeEnabled ? 'label-4 text-button' : 'label-4'}
                                                title={helpTexts.selectionFill.strokeModeLabel}
                                                onClick={this.state.strokeEnabled ? this.toggleStrokeSetting : undefined}
                                            >描边模式</span>
                                            <ToggleSwitch checked={this.state.strokeEnabled} onChange={this.toggleStrokeEnabled} title={helpTexts.selectionFill.strokeEnabledSwitch}  />
                                        </div>
                                    </div>
                                    <div className="grid-cell">
                                        <div className="row-end">
                                            {this.state.strokeEnabled && (
                                                /* 色框右对齐，与上一行「清除模式」开关右缘对齐。
                                                   外层槽宽 33px = .toggle-switch 宽，槽内右对齐。 */
                                                <div className="stroke-color-slot">
                                                    <div
                                                        className="color-preview"
                                                        style={this.getStrokeColorPreviewStyle()}
                                                        title={helpTexts.selectionFill.strokeColorPreview}
                                                        onClick={this.openStrokeColorPicker}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <>
                                {/* ⚠️ 分割线随「填充模式」移位而重排（2026-10-07）：
                                    填充模式分区已提到内容区首位，原来夹在「清除模式」与
                                    「填充模式」之间、以及「填充模式」与 checkbox 组之间的两条分割线
                                    随该块一起移走了。若这里不补一条，「新建图层」会紧贴上方
                                    「填充模式」的 radio 组、视觉上黏成一块。
                                    三行开关彼此之间、以及与下方 checkbox 组之间的分割线保持原样。 */}
                                <div className="divider" />

                                {/* 新建图层开关（禁用态给行挂 .disabled：`:has()` 已确认在 UXP 下无效）
                                    禁用条件走 isCreateNewLayerDisabled()：清除模式 / 快速蒙版 / 单通道编辑 */}
                                <div className={this.isCreateNewLayerDisabled() ? 'row-between disabled' : 'row-between'}>
                                    <span className="label-4"
title={helpTexts.selectionFill.createNewLayer}>
                            新建图层
                            </span>
                                    <ToggleSwitch checked={this.state.createNewLayer} onChange={this.toggleCreateNewLayer} disabled={this.isCreateNewLayerDisabled()} title={helpTexts.selectionFill.createNewLayerSwitch}  />
                                </div>
                                <div className="divider" />

                               {/* 描边模式开关：label 在左，color-preview + 设置图标 + 开关整体收进右侧的 row-start（作为一个单元右对齐） */}
                               <div className="row-between">
                                    <label className="label-4" title={helpTexts.selectionFill.strokeModeLabel}>描边模式</label>
                                    <div className="row-start stroke-mode-controls">
                                    {this.state.strokeEnabled && (
                                        <div 
                                            className="color-preview"
                                            style={this.getStrokeColorPreviewStyle()}
                                            title={helpTexts.selectionFill.strokeColorPreview}
                                            onClick={this.openStrokeColorPicker}
                                        />
                                    )}
                                    {this.state.strokeEnabled && (
                                        <IconButton
                                            onClick={this.toggleStrokeSetting}
                                            title={helpTexts.selectionFill.strokeSettingsButton}
                                        >
                                            <SettingsIcon/>
                                        </IconButton>
                                    )}
                                    <ToggleSwitch checked={this.state.strokeEnabled} onChange={this.toggleStrokeEnabled} title={helpTexts.selectionFill.strokeEnabledSwitch}  />
                                    </div>
                                </div>
                                <div className="divider" />

                                {/* 清除模式开关（禁用态给行挂 .disabled，同上）。
                                    齿轮按钮的挂载方式与「描边模式」完全同构：开启后
                                    「齿轮 + 开关」作为一个整体收进右侧 .row-start 右对齐
                                    （2026-10-08 用户要求：清除模式子面板入口）。
                                    清除模式没有色板，所以控件组只有齿轮 + 开关。
                                    ⚠️ 与紧凑模式的区别：紧凑模式横向没有位置，入口改挂在 label 上。 */}
                                <div className={this.state.createNewLayer ? 'row-between disabled' : 'row-between'}>
                                    <label className="label-4" 
title={helpTexts.selectionFill.clearMode}>
                            清除模式
                            </label>
                                    <div className="row-start clear-mode-controls">
                                        {this.state.clearMode && (
                                            <IconButton
                                                onClick={this.toggleClearSetting}
                                                title={helpTexts.selectionFill.clearSettingsButton}
                                            >
                                                <SettingsIcon/>
                                            </IconButton>
                                        )}
                                        <ToggleSwitch checked={this.state.clearMode} onChange={this.toggleClearMode} disabled={this.state.createNewLayer} title={helpTexts.selectionFill.clearModeSwitch}  />
                                    </div>
                                </div>
                            </>
                        )}

                        {/* 底部 checkbox 组与上方开关行之间的分割线。
                            ⚠️ 紧凑模式下上方没有这三行开关，紧凑模式自己的纵向节奏见 app.css；
                               此处的 divider 在紧凑模式下被 `display:none` 隐藏（仍在文档流）。 */}
                        <div className="divider"></div>
                        <div className="row-between row-grid row-grid-flush">
                                {/* 左列：取消选区 / 更新历史源 */}
                                <div className="grid-cell">
                                    <div className="row-start">
                                        <label
                                            htmlFor="deselectCheckbox"
                                            className="label-5"
                                            onClick={this.toggleDeselectAfterFill}
                                            title={helpTexts.selectionFill.deselectLabel}
                                        >
                                            自动删选区
                                        </label>
                                        <input
                                            type='checkbox'
                                            id="deselectCheckbox"
                                            checked={this.state.deselectAfterFill}
                                            onChange={this.toggleDeselectAfterFill}
                                            className="checkbox-input"
                                            title={helpTexts.selectionFill.deselectInput}
                                        />
                                    </div>
                                    <div className="row-start">
                                        <label
                                            htmlFor="historyCheckbox"
                                            className="label-5"
                                            onClick={this.toggleAutoUpdateHistory}
                                            title={helpTexts.selectionFill.historyLabel}
                                        >
                                            更新历史源
                                        </label>
                                        <input
                                            type='checkbox'
                                            id="historyCheckbox"
                                            checked={this.state.autoUpdateHistory}
                                            onChange={this.toggleAutoUpdateHistory}
                                            className="checkbox-input"
                                            title={helpTexts.selectionFill.historyInput}
                                        />
                                    </div>
                                </div>
                                {/* 右列：开启后切套索 / 切其它工具即关 */}
                                <div className="grid-cell">
                                    <div className="row-start">
                                        <label
                                            htmlFor="autoOffOnToolCheckbox"
                                            className="label-5"
                                            onClick={this.toggleAutoOffOnOtherTool}
                                            title={helpTexts.selectionFill.autoOffLabel}
                                        >
                                            自动关开关
                                        </label>
                                        <input
                                            type='checkbox'
                                            id="autoOffOnToolCheckbox"
                                            checked={this.state.autoOffOnOtherTool}
                                            onChange={this.toggleAutoOffOnOtherTool}
                                            className="checkbox-input"
                                            title={helpTexts.selectionFill.autoOffInput}
                                        />
                                    </div>
                                    <div className="row-start">
                                        <label
                                            htmlFor="lassoOnEnableCheckbox"
                                            className="label-5"
                                            onClick={this.toggleSwitchToLassoOnEnable}
                                            title={helpTexts.selectionFill.lassoLabel}
                                        >
                                            自动切套索
                                        </label>
                                        <input
                                            type='checkbox'
                                            id="lassoOnEnableCheckbox"
                                            checked={this.state.switchToLassoOnEnable}
                                            onChange={this.toggleSwitchToLassoOnEnable}
                                            className="checkbox-input"
                                            title={helpTexts.selectionFill.lassoInput}
                                        />
                                    </div>
                                </div>
                        </div>
                    </div>
                    )}

                {/* info 条：滚动内容的最后一个元素（不再固定在面板底部），
                    滚到底才出现；父/子容器因此都铺满 100%，不再给底部留 20px。
                    ⚠️ 挂 .panel-footer 以便紧凑模式整块隐藏（只藏版权文字会留下
                    该分区 15px 的下外边距，底部凭空多出一段空白）。 */}
                </div>
                )}

                <div className="panel-section panel-footer">
                    <div className="divider"></div>
                    <span className="copyright">Copyright © listen2me (JW)</span>
                </div>

            </div>

            {/* 颜色设置面板 */}
            <ColorSettingsPanel 
                isOpen={this.state?.isColorSettingsOpen ?? false} 
                onClose={this.closeColorSettings} 
                onSave={this.handleColorSettingsSave} 
                initialSettings={this.state?.colorSettings ?? {
                    hueVariation: 0,
                    saturationVariation: 0,
                    brightnessVariation: 0,
                    opacityVariation: 0,
                    grayVariation: 0,
                    calculationMode: 'absolute'
                }}
                isClearMode={this.state.clearMode}
                isQuickMaskMode={false}
                resetToken={this.state.resetToken}
            />

            {/* 图案选择器 */}
            <PatternPicker 
                isOpen={this.state?.isPatternPickerOpen ?? false} 
                onClose={this.closePatternPicker} 
                onSelect={this.handlePatternSelect} 
                isClearMode={this.state.clearMode}
                resetToken={this.state.resetToken}
            />

            {/* 渐变选择器 */}
            <GradientPicker 
                isOpen={this.state?.isGradientPickerOpen ?? false}    
                onClose={this.closeGradientPicker} 
                onSelect={this.handleGradientSelect} 
                isClearMode={this.state.clearMode}
                resetToken={this.state.resetToken}
            />

                {/* 描边设置面板 */}
            <StrokeSetting
              isOpen={this.state.isStrokeSettingOpen ?? false}
              width={this.state.strokeWidth}
              position={this.state.strokePosition}
              blendMode={this.state.strokeBlendMode}
              opacity={this.state.strokeOpacity}
              clearMode={this.state.clearMode}
              onWidthChange={(width) => this.setState({ strokeWidth: width })}
              onPositionChange={(position) => this.setState({ strokePosition: position })}
              onBlendModeChange={(blendMode) => this.setState({ strokeBlendMode: blendMode })}
              onOpacityChange={(opacity) => this.setState({ strokeOpacity: opacity })}
              onClose={this.closeStrokeSetting}
            />

                {/* 清除设置面板（结构与描边设置同构） */}
            <ClearSetting
              isOpen={this.state.isClearSettingOpen ?? false}
              backgroundAlgorithm={this.state.clearBackgroundAlgorithm}
              channelAlgorithm={this.state.clearChannelAlgorithm}
              layerAlgorithm={this.state.clearLayerAlgorithm}
              onBackgroundAlgorithmChange={(v) => this.setState({ clearBackgroundAlgorithm: v })}
              onChannelAlgorithmChange={(v) => this.setState({ clearChannelAlgorithm: v })}
              onLayerAlgorithmChange={(v) => this.setState({ clearLayerAlgorithm: v })}
              onClose={this.closeClearSetting}
            />
            </div>

            {/* 授权对话框 / 隐藏-显示分区浮窗：
                ⚠️ 必须挂在 `.panel` 滚动容器之外（渲染在 `.app-root` 层）。
                   两者都是 position: fixed 的全屏遮罩，若留在滚动容器内部，
                   面板滚动条会压在窗口右缘之上（UXP 下 fixed 的包含块不扣滚动条宽）。 */}
            <LicenseDialog
                isOpen={this.state.isLicenseDialogOpen}
                isLicensed={this.state.isLicensed}
                isTrial={this.state.isTrial}
                trialDaysRemaining={this.state.trialDaysRemaining}
                onLicenseVerified={this.handleLicenseVerified}
                onTrialStarted={this.handleTrialStarted}
                onClose={this.closeLicenseDialog}
            />
            {this.state.showVisibilityPanel && (
                <div className="float-overlay" onClick={() => this.closeVisibilityPanel()}>
                    <div className="float-window" onClick={(e) => e.stopPropagation()}>
                        <div className="row-between">
                            <span className="subpanel-title-1">隐藏/显示分区</span>
                            <div role="button" tabIndex={0} className="close-button" onClick={() => this.closeVisibilityPanel()}>×</div>
                        </div>
                        <div className="panel-section">
                            <div className="row-between">
                                <span className="label-4" onClick={() => this.toggleSectionVisibility('selectionOptions')}>选区改造</span>
                                <ToggleSwitch checked={this.state.selectionOptionsVisible} onChange={() => this.toggleSectionVisibility('selectionOptions')}  />
                            </div>
                            <div className="row-between">
                                <span className="label-4" onClick={() => this.toggleSectionVisibility('fillOptions')}>填充选项</span>
                                <ToggleSwitch checked={this.state.fillOptionsVisible} onChange={() => this.toggleSectionVisibility('fillOptions')}  />
                            </div>
                        </div>
                    </div>
                </div>
            )}
            </>
        );
    }
}

export default App;
