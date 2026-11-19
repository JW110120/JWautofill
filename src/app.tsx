import React from 'react';
import { storage } from 'uxp';
import { app, action, core } from 'photoshop';
import { BLEND_MODES, blendModeLabel } from './constants/blendModes';
import { BLEND_MODE_OPTIONS } from './constants/blendModeOptions';
import { AppState, initialState, Gradient, CompactModes, CompactScope, initialCompactModes, FormulaScope, initialFormulaVisibility } from './types/state';
import { DragHandler } from './utils/DragHandler';
import { FillHandler } from './utils/FillHandler';
import { LayerInfoHandler, invalidateLayerInfoCache, shouldInvalidateLayerInfo } from './utils/LayerInfoHandler';
import {
    isNonPixelLayerKind,
    multiplyTopAlphaByBase,
    readActiveLayerClipState,
    resolveActiveLayerId,
    tryCreateNativeClippingMask,
} from './utils/SpecialClipMask';
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
  getSelectedBrushToolEnum, setFocusLassoActive, setFocusClearActive, setAltToolActive, setLassoCycleActive,
  // 2026-11-16 新增三组工具键：「切换选区填充」(Shift+H) / 「矩形选框工具」(M) / 「切换选框工具」(Shift+M)
  setFillToolCycleActive, setFocusMarqueeActive, setMarqueeCycleActive,
  altToolComboHasAlt, normalizeToolId, syncToolCursors, hotkeyToolSwitchRecent,
  onAltHold, selectToolByRef, onConfig as onHotkeyConfig,
  // 热键命中反馈：**所有 APP 侧按键**的 notify 都归本面板（见 showAppHotkeyNotify）
  onHotkeyTriggered
} from './hotkey/HotkeyBridge';
// 2026-11-16：「自定义快捷键」子面板与绘画工具箱的「功能快捷键」是**同一个组件**，
// 靠 scope 区分显示哪一组内容（用户要求两处样式/交互完全一致）。
import FuncHotkeyPanel from './hotkey/FuncHotkeyPanel';
// 0x0224：混合模式热键「按当前工具临时让位」（画笔/渐变/涂抹…自带混合模式时把键还给 PS）
import { noteToolForBlendYield, blendGuardWatchNeeded } from './hotkey/blendGuard';
import {
  LassoSmoothMode, LassoSmoothParams, LassoSmoothStatus, PenSmoothStatus,
  pushLassoSmoothParams, onLassoSmoothStatus,
  initialLassoSmoothParams, setPenSmooth, setSmoothToolGate, getSmoothToolGate, noteToolReadOk,
  setAltToolOverride, setPolySnapEnabled,
  pushToolRing,
  restorePersistedPenSmooth, isPenSmoothOn,
  SMOOTH_RADIUS_MIN, SMOOTH_RADIUS_MAX,
  SMOOTH_CATCHUP_MIN, SMOOTH_CATCHUP_MAX,
} from './lasso/LassoSmoothing';
// 套索实时平滑的 WebSocket 桥接（端口 18924）。对端是 **PS 进程内的 .8li 插件**
// （JWautofillHost.8li，随 PS 启动自动加载）—— 2026-10-14 起外置 SmoothDaemon
// 与注入式 WintabHook.dll 已整体退役，见 lasso/SmoothBridge.ts 头部说明。
// ⛔ 0x0118：disconnectSmoothDaemon / isSmoothDaemonConnected 已从本文件退役
//    （toggle-off 不再双发 shutdown，见 toggleLassoSmooth），此处只留连接入口。
import { connectSmoothDaemon } from './lasso/SmoothBridge';
// 0x0208：宿主交互期（左键拖拽/空格导航）让巡检让路，根因见模块头部注释。
import { hostYield, onHostRelease } from './utils/hostInteraction';
import { seedMainToggle, setMainToggle, subscribeMainToggle } from './utils/MainToggleBus';
import { FillModeDir, subscribeFillModeCycle } from './utils/FillModeCycleBus';
import { subscribeClearModeToggle } from './utils/ClearModeBus';
import { subscribeBlendMode } from './utils/BlendModeBus';
import { setFocusMode } from './utils/FocusModeBus';
// 2026-11-16：「热键通知」开关（**两块面板各管一份**，本面板用 scope='app'）
import { subscribeHotkeyNotify, hotkeyNotifyOnSync, toggleHotkeyNotify } from './utils/HotkeyNotifyBus';
import {
  debouncePsProbe, isPsBusy, markPsBusyForEvent, runWhenIdle,
  setInProcModalLevel, psBusyInProc,
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
import NumField from './components/NumField';
import { helpTexts } from './constants/helpTexts';

/**
 * 填充失败后的降级重试冷却（毫秒）。
 *
 * 填充路径的正常冷却是 `fillReadyRemain()`（私有、约 60ms）；
 * 万一仍撞上宿主忙碌期（极长命令 / 大文档 / 刚删完图层就套索），
 * 用这个保守值再等一次再试。
 */
const FILL_RETRY_GUARD_MS = 400;

/**
 * APP 侧热键 notify 的存活时间（毫秒）。
 *
 * 与绘画工具箱其它热键提示同一口径：这是「瞬时反馈」（按了键、动作生效了没有），
 * 不是常驻说明 ⇒ 5 秒足够读完；不设「常驻」是因为它每次按键都会刷新，
 * 常驻只会让状态条一直挂着一句过期的话。
 */
const APP_HOTKEY_NOTIFY_TTL_MS = 5000;

/**
 * 选区事件的「沉降」窗口（毫秒）—— 连续到来的选区 set 事件合并成**一次**填充。
 *
 * ⛔⛔ 修复场景（2026-10-14 用户报「致命缺点」）：「用拉绳模式画一个不大的选区，
 *    就产生大量 modal scope」。机理：拉绳模式下输出点以≈光标速度前进（f=1−radius/dist），
 *    选区**每个笔尖包**都在变 ⇒ PS 以包率级（~10ms 一个）派发 selection set 事件 ⇒
 *    旧实现「来一个事件填一次」把整场拖动变成 modal scope 风暴（一次填充 = 一个
 *    executeAsModal 作用域），既卡又污染历史记录。
 *
 * 取值依据：必须**大于**笔尖包间隔（~10ms）才可能在拖动期间持续抑制；
 * 又必须小到孤立事件（Select All / 点选 / 取消选区）感知不到延迟。
 * 120ms 同时满足两者：对孤立事件只增加一次人类不可察觉的固定延迟，
 * 对包率级事件流则把整场拖动收敛为「停笔 120ms 后补一次」。
 *
 * ⚠️ 两个触发入口（通知监听器、填充结束后的 pendingSelection 补跑）**都必须**
 *    走本窗口，否则填充结束后立即补跑会把「一次填充 ⇒ 一次事件 ⇒ 再一次填充」
 *    的自激循环重新变成风暴。
 */
const SELECTION_SETTLE_MS = 120;

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

/**
 * 套索平滑的三种「滤波族」。模块级常量：保持引用稳定，
 * 免得每次渲染重建数组让 RadioGroup 的 React.memo 失效。
 * ⚠️ 必须放模块级：helpTexts 在 import 之后才可用，放组件体内会成为
 *    渲染期立即执行区的 TDZ 隐患（本项目 target=es5，const 会降级为 var）。
 */
const SMOOTH_MODE_RADIO_OPTIONS: RadioOption[] = [
    { value: 'standard', label: '标准', title: helpTexts.selectionFill.smoothModeStandard },
    { value: 'rope', label: '拉绳', title: helpTexts.selectionFill.smoothModeRope },
    { value: 'catchup', label: '追笔', title: helpTexts.selectionFill.smoothModeCatchUp },
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

/* ⛔⛔ 2026-11-18 用户报「切换平滑模式后点击整体错位 ≈45px」——根因在这里。
 *
 *   模式切换会**增删整行**（标准 3 行 / 拉绳 2 行 / 追笔 1 行），而面板常常正滚在底部：
 *   内容一变矮，滚动容器的 max 就比**旧的 scrollTop** 小一行（≈42~45px）。
 *   UXP 的原生滚动视图在这件事上分两层：布局层会自己夹紧，绘制/命中层却保留旧偏移
 *   ⇒ 看到的位置与命中的位置整体差那一行的距离（点「追笔」实际点到它下面那行滑块），
 *   而**任何一次真实滚动都会把两层对齐** —— 这正是用户说的「能自愈、条件不明」。
 *
 *   ⇒ 内容高度一变就主动写一次**夹紧后的** scrollTop（把越界量从绘制层抹掉），
 *     再 1px 抖动强制两层重排，最后按**重新读取的 max** 恢复。
 *   ⛔ 恢复时绝不能写夹紧前的旧 t：那正是把越界值塞回绘制层的动作。
 *   ⛔ 无溢出（max<=0）时只写 0 不抖动：此时正确的滚动量就是 0，抖动纯属浪费。 */
const doResyncNativeWidgets = (root: HTMLElement | null) => {
    if (!root) return;
    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    const t = Math.max(0, Math.min(root.scrollTop, max));   /* ⛔ 先夹回合法区间 */
    root.scrollTop = t;                                     /* 抹掉越界残量 */
    if (max <= 0) {
        /* ⛔ 没有溢出 ⇒ 写 0 是**空操作**，绘制层残留的偏移抹不掉。
           临时补 2px 可滚动余量，做一次**真实**滚动（真滚动才会重算绘制层），
           随后把余量撤掉 —— 全程在同一个同步块内，用户看不到滚动条闪现。 */
        const prev = root.style.paddingBottom;
        try {
            const cs = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null;
            const pad = cs ? (parseFloat(cs.paddingBottom) || 0) : 0;
            root.style.paddingBottom = (pad + 2) + 'px';
            root.scrollTop = 1;
            root.scrollTop = 0;
        } catch { /* ignore */ }
        try { root.style.paddingBottom = prev; } catch { /* ignore */ }
        return;
    }
    root.scrollTop = t < max ? t + 1 : t - 1;
    const restore = () => {
        /* 恢复前重新夹一次：这一帧里布局可能又变过（模式行增删/折叠） */
        const m2 = Math.max(0, root.scrollHeight - root.clientHeight);
        root.scrollTop = Math.max(0, Math.min(t, m2));
    };
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

/** 内容高度变化后**等布局落定**再做一次重排（rAF ×2 ≈ 提交后两帧）。
 *  只调 resyncNativeWidgets 是不够的：它可能排在 React 提交**之前**（等价于拿旧布局
 *  算 max），而这次错位的后果又是「差一行」级的。多补一帧，代价 ≈33ms 且看不见。 */
const resyncAfterLayout = (root: HTMLElement | null) => {
    resyncNativeWidgets(root);
    const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (!schedule) return;
    schedule(() => schedule(() => resyncNativeWidgets(root)));
};

/* ⛔⛔ 2026-11-18：**命中错位自愈守卫**（用户报「切换平滑模式后点哪儿都错 45px，能自愈」）。
 *
 *   机理仍未 100% 证实（无法本地复现），但现象很确定：**看到的位置与命中的位置整体差一行**，
 *   而任何一次真实滚动都会把它对齐。这类「绘制层 / 命中层不同步」的错位，脚本没有办法
 *   直接读取，只能**从事件里反推**：命中的元素必须包含鼠标落点，否则就是错位。
 *   ⇒ 在捕获阶段拦 mousedown 做一次几何校验：
 *       · 正常（99.99%）：只是读一次 rect，无感；
 *       · 错位：打一条带完整现场（偏差/矩形/scrollTop/内容高）的日志，并**立刻强制重排**，
 *         让用户的下一次点击就恢复正常，同时把现场留给我们定位。
 *   ⛔ 容差 2px：边框压线、1px 舍入不算错位（误报会让每次点击都白做一次重排）。
 *   ⛔ 只观察 + 自愈，**不改写事件**：把点击「转发」到推测的目标属于改写用户操作，
 *      一旦推测错（例如点在两个元素缝隙里）就是凭空触发一个控件。 */
const installHitTestGuard = (
    getScope: () => HTMLElement | null,
    getScrollRoot: () => HTMLElement | null
): (() => void) => {
    const doc: any = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.addEventListener) return () => { /* ignore */ };
    const onDown = (e: any) => {
        const t = e && e.target;
        const scope = getScope();
        if (!t || !scope || !t.getBoundingClientRect) return;
        if (t !== scope && scope.contains && !scope.contains(t)) return;
        const r = t.getBoundingClientRect();
        const x = Number(e.clientX);
        const y = Number(e.clientY);
        if (!isFinite(x) || !isFinite(y)) return;
        if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return;
        const dy = y < r.top ? Math.round(y - r.top) : Math.round(y - r.bottom);
        const root = getScrollRoot();
        console.warn('[命中错位] 鼠标落点不在命中元素的矩形内 ⇒ UXP 绘制/命中不同步'
            + ' | target=' + String(t.className || t.tagName || '?')
            + ' 点=(' + Math.round(x) + ',' + Math.round(y) + ')'
            + ' 矩形=(' + Math.round(r.left) + ',' + Math.round(r.top)
            + ',' + Math.round(r.right) + ',' + Math.round(r.bottom) + ')'
            + ' 纵向偏差=' + dy + 'px'
            + ' scrollTop=' + (root ? root.scrollTop : '?')
            + ' 内容高=' + (root ? root.scrollHeight : '?')
            + ' 视口高=' + (root ? root.clientHeight : '?'));
        resyncNativeWidgets(root);
    };
    doc.addEventListener('mousedown', onDown, true);
    return () => {
        try { doc.removeEventListener('mousedown', onDown, true); } catch { /* ignore */ }
    };
};

/** 套索平滑状态档是否是「错误档」（2026-10-23：决定标题下方的异常通知条是否现身）。
 *  warn = 服务没起来 / 版本过旧（要用户处置）；fail = 标定失败 / 平滑中断（要用户反馈）。
 *  「关 / 准备中 / 生效中」不是错误 —— 不占位，常态省空间。 */
const smoothToneIsError = (tone: string): boolean =>
    tone === 'notify-bar-warn' || tone === 'notify-bar-fail';

interface AppProps {}

class App extends React.Component<AppProps, AppState> {
    private unsubMainToggle: (() => void) | null = null;
    /** 命中错位守卫的卸载函数（2026-11-18，见 installHitTestGuard） */
    private uninstallHitGuard: (() => void) | null = null;
    // 0x0209：Alt 边沿（工具模式「临时吸管」）的订阅器
    private unsubAltHold: (() => void) | null = null;
    /**
     * 0x0209：此刻是否正处在「Alt 临时吸管」期间。
     *
     * 两个作用：
     *  ① 抑制「切到其它工具自动关」—— 吸管虽然不在 AUTO_OFF_TOOLS 名单里，
     *     但 `maybeAutoTurnOff` / `pollToolChange` 的判据是 `isOtherTool()` 的补集，
     *     一旦名单或判据将来变化就会误关；这个标志把它钉死。
     *  ② 让「Alt 松开」只处理一次（原生侧按住时每 2s 有保活帧，电平已去重，
     *     这里再挡一次重复进入）。
     */
    private altToolHold = false;
    /** 0x020A：进「Alt 临时吸管」之前的背景色快照（见 syncAltPickColor）。 */
    private altPickBg: { r: number; g: number; b: number; solid: any } | null = null;
    /** 0x020A：松开 Alt 之后**仍允许**完成最后一次取色的截止时刻（0 = 吸管期内不限）。 */
    private altPickUntil = 0;
    /** 0x020A：背景色快照的延时清理句柄。 */
    private altPickClearTimer: any = null;
    /** 0x020A：松开边沿订阅（一次吸色结束的触发点）。 */
    private unsubHostRelease: (() => void) | null = null;
    // 功能快捷键：「切换填充模式」订阅器（FillModeCycleBus 轮询分发，卸载时退订）
    private unsubFillModeCycle: (() => void) | null = null;
    // 工具模式「清除模式」键（Shift+E）与混合模式热键的订阅器（ClearModeBus / BlendModeBus，
    // 热键命中方写在绘画工具箱面板的 JS 上下文，经共享文件到达这里，卸载时退订）
    private unsubClearModeToggle: (() => void) | null = null;
    private unsubBlendMode: (() => void) | null = null;
    /**
     * 热键命中反馈订阅器（`onHotkeyTriggered`）。2026-11-16：**所有与 APP 面板相关的**
     * 按键反馈（开关 / 套索 / 切换套索 / 清除模式 / 填充模式 / 混合模式）都由本面板显示，
     * 位置在「选区平滑」分区上方，不再走绘画工具箱那条通用 notify。
     */
    private unsubHotkeyTrigger: (() => void) | null = null;
    /** APP 侧热键 notify 的自动消失句柄（与其它瞬时提示一致：5s）。 */
    private appNotifyTimer: any = null;
    /**
     * 「热键通知」开关的订阅器（2026-11-16，本面板 scope='app'）：只用于**同步菜单文案**。
     * 通知本身要不要显示由 `hotkeyNotifyOnSync('app')` 同步判断（通知函数是同步调用的，
     * 等不了 await），这里不必把值搬进 state（搬了反而多一次无意义的重渲染）。
     */
    private unsubHotkeyNotify: (() => void) | null = null;
    /* 0x0224：热键配置订阅器（只关心「混合模式热键开关」开关位的翻转）——
       开关一开/一关就要重新决定「要不要跑工具巡检 + 此刻要不要让位」，
       而这件事的入口不在本组件（开关住在绘画工具箱的功能快捷键子面板里）。 */
    private unsubHotkeyCfg: (() => void) | null = null;
    /** 上一轮配置帧里「混合模式热键开关」的状态（只在翻转时重算巡检）。 */
    private blendWatchOn = false;
    // 套索平滑「异常通知条」上一帧是否可见（2026-10-23，componentDidUpdate 比对用）。
    // null = 尚未记录过首帧（装载时不触发重排兜底）。
    private smoothErrBarVisible: boolean | null = null;
    private isFilling = false;
    private pendingSelection = false;
    // 选区事件沉降窗（见 SELECTION_SETTLE_MS）：timer 运行期间到来的事件只刷新
    // lastSelectionEvent 并把窗口整体后移，不另开填充。
    private selectionSettleTimer: any = null;
    private lastSelectionEvent: any = undefined;
    private maskProbeDebounced: (...args: any[]) => void = () => { };
    private isInLayerMask = false;
    private isInQuickMask = false;
    private isInSingleColorChannel = false;
    private selectionChangeListener: any = null;
    // 选区填充的忙碌顺延（见 handleSelectionChange 顶部的闸门说明）
    private selectionRetryTimer: any = null;
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
    // ===== 套索实时平滑（方案 A：输入层滤波）=====
    /** 平滑健康状态的订阅退订器（卸载时退订，避免监听器泄漏）。 */
    private unsubSmoothStatus: (() => void) | null = null;
    /**
     * 平滑模块（.8li）连接的退订器。
     * ⚠️ 与 unsubSmoothStatus 分开存：前者退订「模块回报的状态流」，
     *    后者退订「我们与 .8li 之间的连接」——两者生命周期不同（连接可能重建多次）。
     */
    private unsubSmoothDaemon: (() => void) | null = null;
    /**
     * 平滑的**工具闸门**巡检（2026-10-13 新增）。
     * ⚠️ 与上面「自动关」的工具巡检是**两套独立定时器**：那套服务主开关自动关闭，
     *    这套服务平滑闸门，启停条件不同、互不干扰，共用同一个 timer 会导致
     *    其中一条被另一条的启停条件顺带关掉（这类「共享资源被误回收」的缺陷最难查）。
     */
    private smoothToolTimer: any = null;
    private smoothToolBusy = false;
    private smoothToolBusySince = 0;
    /**
     * 最近一次**成功**读到的工具 ID（诊断用）。
     * ⛔ 为什么要留它：闸门是否生效完全取决于这一次读数，而它在界面上原本是**隐形**的 ——
     *    用户只能看到「工具闸门没起作用」的现象，看不到「读到的到底是哪个工具」。
     *    状态条把它显示出来，一次截图就能判定是「读错了」还是「没读到」。
     */
    private lastToolRead: string | null = null;
    /** 平滑取包活跃度追踪（主状态条「平滑中断」检测；见 applySmoothStatus 内注释）。 */
    private lastPenPackets = -1;
    private lastPenFlowAt = 0;
    /**
     * 平滑连接**瞬断宽限**的计时（2026-10-19，见 SMOOTH_DISCONNECT_GRACE_MS）：
     *  · smoothWasConnected —— 是否曾经连上过（冷启动不走宽限，直接报「服务未启动」）；
     *  · smoothDisconnectedAt —— 本次断连的起始时刻（0 = 未断连/已恢复）；
     *  · smoothDisconnectTimer —— 宽限到期的强制重渲染定时器（断连期间没有回帧，
     *    不补这一脚，文案会永远停在宽限内的旧状态）。
     */
    private smoothWasConnected = false;
    private smoothDisconnectedAt = 0;
    private smoothDisconnectTimer: any = null;
    // ===== 快速蒙版巡检 =====
    // 复合根因（2026-09-10 定位）：
    //   ① checkMaskModes() 原先只写 this.isInQuickMask（实例字段）+ forceUpdate，
    //      而开关的禁用态渲染读的是 state.isInQuickMask —— 通知通道即便拿到了新值，
    //      界面也永远不会变（已改为回写 state）。
    //   ② PS 按 Q 进出快速蒙版**不派发 set/select/make/delete 任何通知**，事件通道拿不到，
    //      只能等下一次选区变更（handleSelectionChange）顺带刷新。
    // 兜底：只读 activeDocument.quickMaskMode（廉价属性，与选中工具巡检同一类读法），
    // 且仅在「填充选项」展开可见时轮询 —— 不可见时没有刷新的必要。
    // ⛔⛔ 2026-10-13：300ms → **1000ms**。原因见 TOOL_WATCH_INTERVAL_MS 处
    //    「模态节流吞吐」的完整说明 —— 300ms 的巡检与 psAccess 的 300ms 全局模态
    //    节流**同频**，等于持续把请求灌进一个吞吐只有 3.3 次/秒的闸门，最终堆积成
    //    `Too many modal scope commands` + `pending promises: 40`。
    private quickMaskTimer: any = null;
    private quickMaskBusy = false;
    private static readonly QUICK_MASK_WATCH_INTERVAL_MS = 1000;
    /**
     * 活动文档身份巡检间隔（毫秒）。
     *
     * ⚠️ 2026-10-13：500ms → **2000ms**。旧注释写「代价可忽略」是**错的** ——
     *    它没计入 `psAccess` 的全局模态节流（MIN_MODAL_GAP_MS=300）：这次读虽然廉价，
     *    却同样要抢一个模态作用域，与工具/快速蒙版巡检一起排队。
     *    文档切换的时效性由**文档级事件**保证（open/close/save/select-document），
     *    轮询只是「事件未被派发」的兜底 ⇒ 可以放心放宽到 2s。
     */
    private static readonly DOC_WATCH_INTERVAL_MS = 2000;
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
     * 工具模式：APP 父面板里「自动关开关」+「自动切套索」同时勾选即自动成立，任一取消即退出。
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
     * 把工具模式结论同步到共享总线（值没变就不写，避免无谓的文件 I/O）。
     *
     * @param explicit 已知结论时直接传入，**跳过读 this.state**。
     *   ⛔ 启动期必须用它：componentDidMount 里 setState 之后紧跟着调用本方法时，
     *   React 的自动批处理让 this.state 仍是**旧值**（默认 false/false）——
     *   直接读会把 false 写进共享文件（把上次会话留下的 true 覆盖掉），
     *   随后 componentDidUpdate 才纠回 true。中间窗口里 MainToggleBus 读到的
     *   是 false ⇒ 主开关热键短暂失去「只开不关」语义（工具模式下的关键行为）。
     */
    private syncFocusMode(explicit?: boolean) {
        const on = explicit !== undefined ? explicit : this.isFocusMode();
        if (this.focusModeWritten === on) return;
        this.focusModeWritten = on;
        void setFocusMode(on).catch(e => console.warn('⚠️ 工具模式状态同步失败:', e));
        // 同步「套索工具键」的装载状态：工具模式开启时注册（默认 L）→ 按下即关闭主开关、
        // 并把工具切回套索，让 H / L 像两个工具一样切换。由本面板独占写入（其它面板不调用，
        // 详见 HotkeyBridge 的 focusLassoKnown 说明）。
        setFocusLassoActive(on);
        // 同步「切换套索工具」键（默认 Shift+L）：工具模式开启时注册 → 在套索组内
        // 循环（普通 → 多边形 → 磁性 → 普通）。PS 原生的 Shift+L 循环在 L 被本插件接管后
        // 就不再触发（用户真机确认），由这条键补上。同样由本面板独占写入。
        setLassoCycleActive(on);
        /* 2026-11-16 新增的三组工具键（全部只在工具模式开启时装载）：
           · 切换选区填充（默认 Shift+H）：五个选区工具循环 + 保证主开关开启；
           · 矩形选框工具（默认 M）：切矩形选框 + 关主开关；
           · 切换选框工具（默认 Shift+M）：矩形 ↔ 椭圆 + 关主开关。 */
        setFillToolCycleActive(on);
        setFocusMarqueeActive(on);
        setMarqueeCycleActive(on);
        // 同步「清除模式」键（默认 Shift+E）：工具模式开启时注册 → 按下即确保主开关开启
        // 并切换清除模式（主开关不会被关掉）。同样由本面板独占写入。
        setFocusClearActive(on);
        // 同步「临时吸管」按住键（默认 /）：工具模式开启时装载 → 按住切吸管、松手切回套索。
        // ⛔ 它必须跟着工具模式启停：键位在工具模式外没有意义，且裸键 ` / ` 在别的场景
        //    （输入框、其它程序）被按住时不该让 .8li 做任何事。
        setAltToolActive(on);
    }

    /**
     * 紧凑模式（右上角菜单切换，默认全关，随面板状态持久化）：
     * 5 个作用域各自独立开关、互不干扰——选区填充父面板 + 纯色/图案/渐变/描边 4 个子面板，
     * 哪一层的开关就只影响哪一层（父面板的 divider 与子面板的 divider 互不相干）。
     * 菜单项只作用于「当前面板」：有子面板打开时是那个子面板，否则是父面板，
     * 因此菜单文案只写「开还是关」（2026-11-16 用户要求去掉面板名，见 syncCompactMenuLabel）。
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

    /**
     * 菜单文案：`紧凑模式 - 开/关`。
     *
     * ⚠️ 2026-11-16 用户要求去掉面板名（原为「紧凑模式：选区填充 - 关」这种带作用域的写法）。
     *    5 个作用域仍各自独立开关、菜单项仍只作用于「当前面板」，只是文案里不再写名字 ——
     *    这一项就在当前面板自己的菜单里，读到开/关即可判断这一层此刻的状态。
     */
    private syncCompactMenuLabel() {
        const scope = this.currentCompactScope();
        const on = !!(this.state.compactModes && this.state.compactModes[scope]);
        MenuManager.setCompactModeLabel(`紧凑模式 - ${on ? '开' : '关'}`);
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
        this.toggleSpecialMask = this.toggleSpecialMask.bind(this);
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
        // 「显示公式」开关：以引用形式传给 ClearSetting / ColorSettingsPanel 的 props，
        // 必须以绑定后的方法传递（类方法裸引用会丢 this ⇒ 点击后 setState 抛错）。
        this.setFormulaVisible = this.setFormulaVisible.bind(this);
        this.setColorFormulaVisible = this.setColorFormulaVisible.bind(this);
        // 新增绑定
        this.toggleSelectionOptions = this.toggleSelectionOptions.bind(this);
        this.handleSelectionContrastChange = this.handleSelectionContrastChange.bind(this);
        this.handleSelectionExpandChange = this.handleSelectionExpandChange.bind(this);
        // 套索实时平滑：「分区折叠 / 高级项折叠 / 总开关 / 模式单选」四个入口
        // 都要以绑定后的方法传给 JSX（类方法裸引用会丢 this ⇒ 点击后 setState 抛错）。
        this.toggleSmoothOptions = this.toggleSmoothOptions.bind(this);
        this.toggleLassoSmooth = this.toggleLassoSmooth.bind(this);
        this.handleSmoothModeChange = this.handleSmoothModeChange.bind(this);
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
        // 命中错位守卫：纯观察 + 自愈，放在最前（不依赖下面任何 await 的结果）
        this.uninstallHitGuard = installHitTestGuard(
            () => document.getElementById('app'),
            () => this.panelRef.current
        );
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
            // 「切换填充模式」热键（默认 Ctrl+滚轮）：命令经共享文件 + token 去重后到达这里，
            // 改的本来就是本面板自己的 state（fillMode）。
            // ⛔ 方向不能让各面板自己猜：.8li 的鼠标钩子判定滚轮方向后随消息下发，
            //    这里只负责「按方向前进一步」。
            this.unsubFillModeCycle = subscribeFillModeCycle((dir) => {
                this.cycleFillMode(dir);
            });
            // 工具模式「清除模式」键（默认 Shift+E）：命令经 ClearModeBus 到达这里，
            // 翻本面板的 clearMode（与面板上的勾选走同一个 toggleClearMode，语义一致）。
            this.unsubClearModeToggle = subscribeClearModeToggle(() => {
                this.toggleClearMode();
            });
            // 混合模式热键（Alt+Shift+<key>）：.8li 吞掉 PS 原生按键后经 BlendModeBus
            // 把目标模式送到这里，改「选区填充」的混合模式（不再改图层/工具的混合模式）。
            this.unsubBlendMode = subscribeBlendMode((mode) => {
                this.applyBlendModeHotkey(mode);
            });
            /**
             * 热键命中反馈的**归属划分**（2026-11-16 第二轮，用户要求）。
             *
             * 「自定义快捷键」子面板里的键改的全是本面板的东西（开关 / 套索 / 清除模式 /
             * 填充模式 / 混合模式），原来的反馈却统统输出在**绘画工具箱**「笔刷热键」分区
             * 底部那条通用 notify 里 —— 用户按完键，视线在画布与本面板中段，根本看不到。
             * ⇒ 现在按「这条消息说的是谁」分流：
             *   · 本面板（APP）：toggleMain / focusLasso / lassoCycle / focusClear /
             *     blendMode / 切换填充模式 —— 全部走 showAppHotkeyNotify，
             *     位置固定在「选区平滑」分区上方（render 里有专属槽位）。
             *   · 绘画工具箱：applyBrush（切笔刷）与 runFunc 里的功能按钮（分块平均等）。
             * ⛔ 一条消息**只在一块面板出现**，绝不两边都说一遍（历史上两处各说一遍
             *    导致过「哪一条才是真的」的困惑）。
             * ⚠️ 切换填充模式的提示不在这里发：它要说出「切到了哪个模式」，而那个信息
             *    只有 cycleFillMode 里才有（见那里的说明）。
             */
            this.unsubHotkeyTrigger = onHotkeyTriggered((info) => {
                const prefix = '热键触发：' + (info.combo ? info.combo + ' → ' : '');

                if (info.action === 'blendMode') {
                    // `info.brush` 承载的是 PS 枚举值（keyhook.c 的 KH_BLEND_DEFS），转中文再上屏
                    const modeCn = blendModeLabel(info.brush) || '未知模式';
                    this.showAppHotkeyNotify(
                        prefix + '选区填充混合模式 → ' + modeCn + (info.ok ? '' : '（失败）'),
                        info.ok
                    );
                    return;
                }

                if (info.action === 'toggleMain') {
                    /* 主开关（默认 H）。`info.enabled` = 切换**之后**的状态。
                       ⭐ 2026-11-16 新逻辑①：关闭总开关时，如果当前正停在多边形/磁性套索，
                          顺手切回普通套索。真正的切换发生在 onMainToggleChanged
                          （那里才有 prev→next 的时序），这里只按**同一个判据**把结果
                          写进文案，避免用户看到「已关闭」却仍停在一个用不了的子工具上。 */
                    const backToLasso = info.enabled === false && App.isSubLassoTool(this.currentToolGuess());
                    /* ⭐ 2026-11-16 第三轮（用户报的 bug）：**开关保持开启**这一拍也要回到套索。
                       现象：工具模式（自动关 + 自动切套索）下，当前工具是多边形 / 磁性套索 /
                       矩形选框 / 椭圆选框，且总开关已经开着时，按 H 完全没有反应 ——
                       因为 MainToggleBus.doToggle 在工具模式下是「只开不关」，已开着就
                       `return cur`（什么都不做），于是连一次状态翻转都没有，
                       onMainToggleChanged 也就不会触发 ⇒ 没有任何工具动作。
                       用户要求：按 H 保持开启并**恢复为套索工具**。
                       ⛔ 只在当前工具确实是那四个之一时才发命令（铁律 132「按需切换」）：
                          已经在套索上不必再发；在画笔等工具上时「自动关」早把开关关掉了，
                          走的是上面那条关→开路径，与这里无关。
                       ⛔ 判据用 `switchToLassoOnEnable`（用户勾了「自动切套索」才替用户切工具），
                          与 onMainToggleChanged 同一条开关，避免两处语义分叉。 */
                    const keepOnToLasso = info.enabled === true
                        && this.state.switchToLassoOnEnable
                        && App.LASSO_RETURN_TOOLS.indexOf(this.currentToolGuess() || '') !== -1;
                    if (keepOnToLasso) void this.selectLassoTool();
                    const base = info.enabled === undefined
                        ? '选区填充开关切换失败'
                        : ('选区填充开关已' + (info.enabled ? '开启' : '关闭'));
                    this.showAppHotkeyNotify(
                        prefix + base + (backToLasso || keepOnToLasso ? '（切回套索工具）' : ''),
                        info.enabled !== undefined
                    );
                    return;
                }

                if (info.action === 'lassoCycle') {
                    const target = info.brush || '';
                    /* 乐观记下「新的当前工具」：组内循环是本面板发起的，事实明确；
                       1s 巡检要等下一拍，而紧跟其后的 H / Shift+E 判据马上就要用它。 */
                    if (target && info.ok) this.noteRealTool(target);
                    /* ⭐ 2026-11-16 新逻辑②：Shift+L 换的是**真工具** ⇒ 与「用鼠标点工具栏换
                       工具」同权。自动关开关开着、总开关也开着时，这里就把总开关关掉
                       （用户原话：「应视为工具切换，在自动关开关开启时应该要自动关闭总开关」）。
                       ⛔ 切换失败（info.ok=false）不关：工具没动，就不该有副作用。 */
                    const autoOffed = !!info.ok && !!this.state.autoOffOnOtherTool && this.state.isEnabled;
                    if (autoOffed) void this.autoTurnOffMain(target);
                    this.showAppHotkeyNotify(
                        prefix + (info.ok
                            ? '已切换到「' + App.toolRefLabel(target) + '」' + (autoOffed ? '（自动关已开 ⇒ 关闭选区填充）' : '')
                            : '切换套索工具失败'),
                        info.ok
                    );
                    return;
                }

                if (info.action === 'fillToolCycle') {
                    /* 「切换选区填充」（默认 Shift+H，2026-11-16）：五个选区工具循环，
                       并且**保持主开关开启**（开关的开启由 bridge 的 requestMainToggle 完成，
                       工具模式下它只开不关）。
                       ⛔ 这里绝不能调 autoTurnOffMain：用户要求「按这个键切工具不触发自动关」。
                       ⛔ 也绝不能等着「自动关」来兜底 —— 选框/套索都在白名单之外。 */
                    const target = info.brush || '';
                    if (target) this.noteRealTool(target);
                    this.showAppHotkeyNotify(
                        prefix + '选区填充已开启 → ' + App.toolRefLabel(target),
                        true
                    );
                    return;
                }

                if (info.action === 'focusMarquee' || info.action === 'marqueeCycle') {
                    /* 「矩形选框工具」(M) / 「切换选框工具」(Shift+M)：切到原本的选框 +
                       关闭主开关（关闭动作由 bridge 的 requestMainToggleOff 完成）。
                       ⛔ 这里同样不调 autoTurnOffMain：bridge 已经关了开关，再调一次只会
                          重复写共享状态（多面板各自执行一次 ⇒ 多余的文件 I/O）。 */
                    const target = info.brush || '';
                    if (target) this.noteRealTool(target);
                    this.showAppHotkeyNotify(
                        prefix + (info.ok
                            ? '已切到「' + App.toolRefLabel(target) + '」（选区填充已关闭）'
                            : '切换选框工具失败'),
                        info.ok
                    );
                    return;
                }

                if (info.action === 'focusLasso') {
                    // 工具模式「套索工具」键（默认 L）：关闭主开关并把工具切回套索
                    this.showAppHotkeyNotify(
                        prefix + (info.ok ? '已退出自动填充（切回套索工具）' : '退出自动填充失败'),
                        info.ok
                    );
                    return;
                }

                if (info.action === 'focusClear') {
                    // 工具模式「清除模式」键（默认 Shift+E）：确保主开关开启 + 切换清除模式
                    this.showAppHotkeyNotify(
                        prefix + (info.ok ? '清除模式已切换（主开关保持开启）' : '清除模式切换失败'),
                        info.ok
                    );
                    return;
                }
            });
            /* 0x0224：混合模式热键开关翻面 ⇒ 重算「谁读工具」并立刻判一次让位。
               （开关住在绘画工具箱的功能快捷键子面板，本面板只能靠配置帧知道它变了） */
            this.blendWatchOn = blendGuardWatchNeeded();
            this.unsubHotkeyCfg = onHotkeyConfig(() => {
                const on = blendGuardWatchNeeded();
                if (on === this.blendWatchOn) return;
                this.blendWatchOn = on;
                this.syncToolWatch();   /* 开⇒建表并立即读一次工具；关⇒拆表，让位位随之归零 */
            });
            // 套索实时平滑：.8li 模块回报的钩子/布防健康状态（同步回调，无 await）。
            this.unsubSmoothStatus = onLassoSmoothStatus((s) => { this.applySmoothStatus(s); });
            // 0x0209：Alt 边沿 → 工具模式下的「临时吸管」。
            // ⛔ 走 .8li 的键态轮询（UXP 面板拿不到宿主前台的全局键态），
            //    三个条件（工具模式 / 套索 / 总开关开）的判定在 handleAltHoldEdge 里。
            this.unsubAltHold = onAltHold((on) => { void this.handleAltHoldEdge(on); });
            // 0x020A：宿主「松开」边沿 = 一次吸色点击结束。用于把 PS 写进背景色的
            // 取样结果搬到前景色（根因与取舍见 syncAltPickColor 的长注释）。
            // ⛔ 判据来自 hostBusy（左键∨空格），所以回调里必须再用 altToolHold 收口。
            // ⛔ 0x020B：`hadLeft` 区分「左键点了一下」与「只按了空格平移」——
            //    后者绝不能当成一次取色（详见 hostInteraction.ts 的 busyHadLeft）。
            this.unsubHostRelease = onHostRelease((hadLeft) => { void this.syncAltPickColor(hadLeft); });
            // 平滑模块（.8li）自己的连接（18924）。刻意与 connectHotkeyDaemon 分开调用：
            // 两条 WebSocket 的生命周期必须互不相干，否则「停快捷键服务」又会把平滑带下水。
            this.unsubSmoothDaemon = connectSmoothDaemon();
            /* 0x023A：外框初始态。建连后 resendLassoSmoothing 会先发一帧 0，
               这里补一次当前值 —— 面板挂载时主开关可能已经是开着的
               （persisted 恢复比 componentDidUpdate 早）。 */
            try { pushToolRing(this.state.isEnabled); } catch { /* ignore */ }
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
                    // 特殊蒙版同属「用户选项」（开 / 关是习惯，不是数值参数）：复位时保持。
                    specialMask: this.state.specialMask,
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
                    // 浮窗同属「面板开关」而非「参数」：复位时保持开启（并同步保留堆叠顺序）。
                    // ⚠️ 若这里不保留，浮窗会随 ...initialState 一起关掉；虽然 body 类已改为
                    //    由 state 派生（不会留下悬空类），但用户正在用的窗口突然消失同样算打断操作。
                    showVisibilityPanel: this.state.showVisibilityPanel,
                    isFillSettingsOpen: this.state.isFillSettingsOpen,
                    // 「自定义快捷键」子面板同属「面板开关」：复位时保持开启，
                    // 否则用户正在里面录快捷键、点一下参数复位就被弹回主面板。
                    isAppHotkeyOpen: this.state.isAppHotkeyOpen,
                    floatOrder: this.state.floatOrder,
                    // ⛔ 平滑健康状态必须保持：它由 .8li 模块回报（是否注入 PS / 标定结果 /
                    //    已平滑包数），不是用户参数。若被 `...initialState` 打回
                    //    initialLassoSmoothStatus（connected:false），状态行会一直谎报
                    //    「平滑服务未启动」，直到下一次状态广播才自愈 —— 而广播只在
                    //    开关变化或连接变化时才发。
                    smoothStatus: this.state.smoothStatus,
                    // 授权状态不应被参数复位影响
                    isLicensed: this.state.isLicensed,
                    isTrial: this.state.isTrial,
                    isLicenseDialogOpen: this.state.isLicenseDialogOpen,
                    trialDaysRemaining: this.state.trialDaysRemaining,
                    // 紧凑模式是界面开关（5 个作用域各自独立），不属于「参数」，复位时保持用户当前选择
                    compactModes: this.state.compactModes,
                    // 「显示公式」同属界面偏好（四处独立），复位时保持当前选择
                    formulaVisible: this.state.formulaVisible,
                }, () => {
                    // 复位把 smoothParams 打回了默认值（参数类），但平滑开关状态被保留。
                    // 若此刻平滑正在生效，不重新下发的话平滑模块会继续用复位前的旧参数滤波，
                    // 面板显示与实拖效果就会不一致。参数未变化时 LassoSmoothing 内部会去重，不会白发。
                    try { pushLassoSmoothParams(this.state.smoothParams); } catch { /* ignore */ }
                });
            },
            onToggleCompactMode: () => { this.toggleCompactMode(); },
            /* 「热键通知 - 开/关」（2026-11-16，第二轮改为**本面板独占**）：只翻 scope='app'
               这一份偏好，文案由下面的订阅器统一改写。
               ⛔ 不复用 toggleCompactMode 那种「改本面板 state」的路子：开关值要落盘跨会话，
                  而且显示点（showAppHotkeyNotify）是同步函数，读不了 React state。
               ⛔ 也不再与绘画工具箱共享：用户明确要求两个面板独立管理。 */
            onToggleHotkeyNotify: () => { void toggleHotkeyNotify('app'); },
            onShowAppHotkeys: () => { this.openAppHotkeyPanel(); },
            onShowVisibilityPanel: () => { this.openVisibilityPanel(); },
            onOpenFillSettings: () => { this.openFillSettingsPanel(); }
        });
        /* 「热键通知」偏好（scope='app'）：订阅本面板那个文件 ⇒ 同步本面板菜单文案。
           ⛔ 订阅器首次 tick 必定回调一次（内部 last 从 null 起），所以插件重启/热更新后
              菜单文案不会停在上一次的旧文案上；与绘画工具箱那一份互不相干。 */
        this.unsubHotkeyNotify = subscribeHotkeyNotify('app', (on) => {
            MenuManager.setHotkeyNotifyLabel(on);
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
                    // ⚠️ 经沉降窗合并后再填充（见 SELECTION_SETTLE_MS）：拉绳拖动时
                    // PS 以包率级派发事件，来一个填一次就是 modal scope 风暴。
                    this.scheduleSelectionFill(descriptor);
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
        // 工具模式的结论直接由「合并后的两个前置选项」算出（不读 this.state）：
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
                    specialMask: this.state.specialMask,
                    clearMode: this.state.clearMode,
                    formulaVisible: this.state.formulaVisible,
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
                // 套索平滑参数：与下方 setState 里的合并规则逐字一致（逐字段回落默认）。
                // 提到局部变量是为了 setState 之后**立即**同步给 LassoSmoothing 模块
                // （setState 是异步的，那一刻还读不到 this.state.smoothParams）。
                const mergedSmoothParams: LassoSmoothParams = {
                    ...initialLassoSmoothParams,
                    ...(loaded.appPanel.smoothParams ?? {}),
                };
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
                    // 特殊蒙版：旧存档没有这个字段 ⇒ 回落到默认（关），
                    // 与旧版「图案 / 渐变子面板里的复选框默认不勾」手感一致。
                    specialMask: loaded.appPanel.specialMask ?? this.state.specialMask,
                    clearMode: loaded.appPanel.clearMode ?? this.state.clearMode,
                    // 「显示公式」四处独立开关：旧存档无此字段 ⇒ 逐项回落到默认（全关），
                    // 按作用域逐项合并，避免「整体覆盖」把用户已开启的其它处冲掉。
                    formulaVisible: {
                        background: loaded.appPanel.formulaVisible?.background ?? initialFormulaVisibility.background,
                        channel: loaded.appPanel.formulaVisible?.channel ?? initialFormulaVisibility.channel,
                        layer: loaded.appPanel.formulaVisible?.layer ?? initialFormulaVisibility.layer,
                        color: loaded.appPanel.formulaVisible?.color ?? initialFormulaVisibility.color,
                    },
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
                    // 套索实时平滑：布尔量按「缺字段回落默认」合并；
                    // ⚠️ smoothParams 必须**逐字段**合并（不能整体覆盖）——
                    //    旧存档里没有这个对象，整体覆盖会把默认值冲成 undefined，
                    //    之后下发的参数里出现 undefined 会让平滑模块解析出 NaN 半径。
                    smoothParams: mergedSmoothParams,
                    polySnapEnabled: loaded.appPanel.polySnapEnabled ?? this.state.polySnapEnabled,
                    smoothOptionsVisible: loaded.appPanel.smoothOptionsVisible ?? this.state.smoothOptionsVisible,
                    isSmoothOptionsExpanded: loaded.appPanel.isSmoothOptionsExpanded ?? this.state.isSmoothOptionsExpanded,
                });
                // ⛔⛔ 2026-10-14（用户报「刚加载插件时 HUD 不显示、平滑不生效，
                //    反复切换模式/开关拉绳提示才有机会恢复」的机理之一）：
                //    LassoSmoothing 的模块级 params 在插件重载后是**默认值**，而工具闸门
                //    心跳（pollSmoothToolGate → setSmoothToolGate → forceSendParams）会在
                //    ~1.8s 后用**模块值**整包覆盖 .8li 模块 —— 不先同步，模块里的
                //    模式/强度/半径/绳提示全被冲成默认（模式被冲成 standard ⇒ 拉绳 HUD
                //    永不显示；用户随后「切换到拉绳模式」才把真值推下去，观感就是
                //    「要反复切换模式才恢复」）。
                //    sendParams 内部对 penOn=false 静默跳过（平滑没开时无需下发）；
                //    开启开关时 setPenSmooth 会整包带当前 state，同样拿得到恢复值。
                try { pushLassoSmoothParams(mergedSmoothParams); } catch { /* ignore */ }
                /* 多边形吸附的开关同理：原生槽位初值 0（关），必须在状态合并后
                   主动下发一次 —— 否则面板上开关是开的、按住 Alt 却完全不吸，
                   而且没有任何报错可查（与上面平滑参数同族的启动期失配）。
                   ⚠️ 此刻 setState 尚未生效，必须用合并后的显式值读。 */
                try { setPolySnapEnabled(loaded.appPanel.polySnapEnabled ?? this.state.polySnapEnabled); } catch { /* ignore */ }
                /* ⛔ 0x0123：恢复上次会话的「平滑总开关」意图（settings/smooth-enabled.json）。
                   必须在这一行之后 —— 之前 params 是默认值，重放出去会把用户上次调好的
                   半径/模式用默认值整包盖掉（与上面那条注释同一个坑）。
                   传显式 mergedSmoothParams：此刻 setState 尚未生效，读 this.state 会拿到默认值。 */
                void restorePersistedPenSmooth(mergedSmoothParams).catch(() => { /* ignore */ });
            }
        } catch (e) {
            console.warn('⚠️ 面板状态加载失败，使用默认状态:', e);
        } finally {
            // 加载完成（无论成败）才允许后续的持久化保存，避免启动期默认值覆盖已存状态
            this.panelStateLoaded = true;
        }
        // 选项已从磁盘合并进来，此刻把工具模式结论推给共享总线（下次会话未打开面板也有效）。
        // ⚠️ 必须传显式值 focusAfterMerge，不能让 syncFocusMode 去读 this.state：
        //    上面那个 setState 尚未生效（自动批处理），读到的仍是默认 false/false，
        //    会把 false 写进共享文件、覆盖上次会话留下的 true，之后虽被 componentDidUpdate
        //    纠回，但那个窗口里主开关热键会失去「只开不关」的工具模式语义。
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
        // 主开关/自动关变化时同步巡检（放在最前：不受下方 panelStateLoaded 早退影响）
        if (prevState.isEnabled !== this.state.isEnabled ||
            prevState.autoOffOnOtherTool !== this.state.autoOffOnOtherTool) {
            this.syncToolWatch();
        }
        /* 0x023A：工具图标呼吸外框跟着**主开关**走。
           「H 自动填充」与「L/M 单纯选区」在画布上没有视觉差别，靠这一圈提示
           用户当前处于哪一种；画在 PS 选项栏上只能由 .8li 的独立线程做，
           面板只负责下发意图（见 smooth_engine.c 的 ring_* 段）。
           ⛔ 与平滑总开关无关：平滑关着也必须能看见。 */
        if (prevState.isEnabled !== this.state.isEnabled) {
            try { pushToolRing(this.state.isEnabled); } catch { /* ignore */ }
        }
        // 「填充选项」展开/可见状态变化时同步快速蒙版巡检（同样放在早退之前）
        if (prevState.isExpanded !== this.state.isExpanded ||
            prevState.fillOptionsVisible !== this.state.fillOptionsVisible) {
            this.syncQuickMaskWatch();
        }
        // 工具模式的两个前置选项变化时同步到共享总线（同样不受下方早退影响）
        if (prevState.autoOffOnOtherTool !== this.state.autoOffOnOtherTool ||
            prevState.switchToLassoOnEnable !== this.state.switchToLassoOnEnable) {
            this.syncFocusMode();
        }
        // 套索平滑「异常通知条」显隐（2026-10-23）：条的现身/退场会推动下方平滑参数行，
        // 补一次原生控件重排，防 UXP 数字输入留残影（与模式切换 resync 同款纪律）。
        // 首次不补（smoothErrBarVisible 初值 null）：装载时的既有布局无需抖动。
        /* 这里追踪的是「本面板是否有一条**会推动下方内容**的状态条」：
           选区平滑错误条，或 APP 侧热键的反馈条（H / L / Shift+L / Shift+E /
           Ctrl+滚轮 / Alt+Shift+字母）。
           两者出现/消失都会改变上方高度 ⇒ UXP 原生 number 的坐标需要重排，
           否则会留下残影（数字画在旧位置）。 */
        const smoothErrBar = smoothToneIsError(this.smoothBarTone()) || !!this.state.appHotkeyNotify;
        if (this.smoothErrBarVisible !== null && smoothErrBar !== this.smoothErrBarVisible) {
            resyncAfterLayout(this.panelRef.current);
        }
        this.smoothErrBarVisible = smoothErrBar;

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
            // ⚠️ 2026-10-10 起**不再**在子面板打开期间置灰「隐藏/显示分区」菜单项。
            //    旧的置灰理由是「5 个子面板内部没有分区，点了只会打开父面板分区浮窗、语义对不上」；
            //    但用户要求子面板与浮窗可以共存、且浮窗始终置顶（见 common.css「浮窗始终置顶」段），
            //    于是这条限制失去意义 —— 保留它反而让用户以为菜单坏了（点了没反应）。
            //    ⇒ 该菜单项常驻可点；直接调用 MenuManager.setAppVisibilityItemEnabled 的写法已删除。
        }

        // 浮窗 body 类：与上面「子面板」同款，**由 state 派生**（不是开关时手写）。
        // 只在「浮窗开合状态真的变了」时同步，避免每次 update 都去量一次滚动条。
        if (prevState.showVisibilityPanel !== this.state.showVisibilityPanel ||
            prevState.isFillSettingsOpen !== this.state.isFillSettingsOpen ||
            // 2026-11-16：子面板开合同样要重算「遮罩态」body 类（隐藏 number + 收滚动条）
            prevState.isAppHotkeyOpen !== this.state.isAppHotkeyOpen) {
            this.syncFloatPanelClasses();
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
            'specialMask',
            'clearMode',
            'formulaVisible',
            'clearBackgroundAlgorithm',
            'clearChannelAlgorithm',
            'clearLayerAlgorithm',
            'compactModes',
            'fillMode',
            // 套索实时平滑：参数与界面开关一并纳入持久化
            // ⚠️ smoothParams 靠**引用比较**判定变更 ⇒ 必须整体替换对象
            //    （见 updateSmoothParam），就地改字段不会触发落盘。
            'smoothParams',
            'polySnapEnabled',
            'smoothOptionsVisible',
            'isSmoothOptionsExpanded',
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
                    specialMask: this.state.specialMask,
                    clearMode: this.state.clearMode,
                    formulaVisible: this.state.formulaVisible,
                    clearBackgroundAlgorithm: this.state.clearBackgroundAlgorithm,
                    clearChannelAlgorithm: this.state.clearChannelAlgorithm,
                    clearLayerAlgorithm: this.state.clearLayerAlgorithm,
                    compactModes: this.state.compactModes,
                    fillMode: this.state.fillMode,
                    selectionOptionsVisible: this.state.selectionOptionsVisible,
                    fillOptionsVisible: this.state.fillOptionsVisible,
                    smoothParams: this.state.smoothParams,
                    polySnapEnabled: this.state.polySnapEnabled,
                    smoothOptionsVisible: this.state.smoothOptionsVisible,
                    isSmoothOptionsExpanded: this.state.isSmoothOptionsExpanded,
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
        
        if (this.uninstallHitGuard) {
            try { this.uninstallHitGuard(); } catch { /* ignore */ }
            this.uninstallHitGuard = null;
        }
        if (this.unsubMainToggle) {
            try { this.unsubMainToggle(); } catch { /* ignore */ }
            this.unsubMainToggle = null;
        }
        if (this.unsubAltHold) {
            // 0x0209：只退订监听，**不**在这里切回套索 —— 面板卸载时用户可能正按着 Alt，
            // 强行切工具会打断他手上的操作；工具归属由 PS 自己的下一次选择决定。
            try { this.unsubAltHold(); } catch { /* ignore */ }
            this.unsubAltHold = null;
        }
        if (this.unsubHostRelease) {
            try { this.unsubHostRelease(); } catch { /* ignore */ }
            this.unsubHostRelease = null;
        }
        /* 0x020A：卸载时必须**主动撤销**临时吸管的硬否决位 ——
           面板一走，原生那三处兜底（Alt 物理松开 / plug_revoke / 服务重启）都还没轮到，
           而这一位残留 = 套索平滑整段失效，界面上看不出原因。 */
        try { setAltToolOverride(false); } catch { /* ignore */ }
        this.altPickBg = null;
        this.altPickUntil = 0;
        if (this.altPickClearTimer) {
            clearTimeout(this.altPickClearTimer);
            this.altPickClearTimer = null;
        }
        if (this.unsubFillModeCycle) {
            try { this.unsubFillModeCycle(); } catch { /* ignore */ }
            this.unsubFillModeCycle = null;
        }
        if (this.unsubClearModeToggle) {
            try { this.unsubClearModeToggle(); } catch { /* ignore */ }
            this.unsubClearModeToggle = null;
        }
        if (this.unsubBlendMode) {
            try { this.unsubBlendMode(); } catch { /* ignore */ }
            this.unsubBlendMode = null;
        }
        if (this.unsubHotkeyTrigger) {
            try { this.unsubHotkeyTrigger(); } catch { /* ignore */ }
            this.unsubHotkeyTrigger = null;
        }
        if (this.unsubHotkeyNotify) {
            try { this.unsubHotkeyNotify(); } catch { /* ignore */ }
            this.unsubHotkeyNotify = null;
        }
        if (this.appNotifyTimer) {
            clearTimeout(this.appNotifyTimer);
            this.appNotifyTimer = null;
        }
        /* 0x0224：只退订配置流，**不**主动清让位位 —— 让位位活在原生内存里，
           面板一走 WS 就断，下一个客户端接手时原生会自己归零（keyhook.c kh_cli_add）。
           在这里再发一帧反而会与「另一个面板上下文仍在用」打架。 */
        if (this.unsubHotkeyCfg) {
            try { this.unsubHotkeyCfg(); } catch { /* ignore */ }
            this.unsubHotkeyCfg = null;
        }
        if (this.unsubSmoothStatus) {
            try { this.unsubSmoothStatus(); } catch { /* ignore */ }
            this.unsubSmoothStatus = null;
        }
        if (this.unsubSmoothDaemon) {
            try { this.unsubSmoothDaemon(); } catch { /* ignore */ }
            this.unsubSmoothDaemon = null;
        }
        // ⚠️ 这里**不**断开平滑模块连接、也不关平滑开关：与笔刷热键服务同语义 ——
        //    开关打开即生效，面板关闭不该把用户正在用的平滑砍掉。
        //    （unsubSmoothDaemon 只退订状态流；连接本身由引用计数管理。）
        if (this.selectionChangeListener) {
            action.removeNotificationListener(['set'], this.selectionChangeListener);
        }
        if (this.selectionRetryTimer) {
            clearTimeout(this.selectionRetryTimer);
            this.selectionRetryTimer = null;
        }
        if (this.selectionSettleTimer) {
            clearTimeout(this.selectionSettleTimer);
            this.selectionSettleTimer = null;
        }
        this.lastSelectionEvent = undefined;
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
        if (this.smoothToolTimer) {
            clearInterval(this.smoothToolTimer);
            this.smoothToolTimer = null;
            // 面板卸载后闸门必须回到「未知」：残留的 0（不是套索）会让下次
            // 插件加载后平滑迟迟不生效，而界面上看不出任何原因。
            // ⛔ 进程内正供给闸门时不放（原生侧接管后忽略面板值；且它自己会持续刷 GATETS）。
            // ⛔ 0x0115：判据从 `toolSrc !== 2` 换成带 2 秒时效的 `inProcGateOwned()` ——
            //    与 syncSmoothToolWatch / applyToolGate / 原生侧 pstool_owns() 同源。
            //    'slct 静默过 ⇒ 不让位 ⇒ 卸载时放 2（未知）让原生 fail-closed，
            //    等 .8li 下次收到通知重新接管；比留着一个冻结的错值诚实。
            if (!this.inProcGateOwned()) setSmoothToolGate(2);
        }
        if (this.smoothDisconnectTimer) {
            clearTimeout(this.smoothDisconnectTimer);
            this.smoothDisconnectTimer = null;
        }
        if (this.quickMaskTimer) {
            clearInterval(this.quickMaskTimer);
            this.quickMaskTimer = null;
        }
        // 清理CSS类（含本面板专属的可见性浮窗类，避免残留影响下次加载）
        document.body.classList.remove('secondary-panel-open');
        document.body.classList.remove('license-dialog-open');
        document.body.classList.remove('app-visibility-panel-open');
        document.body.classList.remove('app-fill-settings-open');
        document.body.classList.remove('app-panel-gutter');
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
     * 打开「自定义快捷键」子面板（右上角菜单 → 自定义快捷键）。
     *
     * 2026-11-16：它**取代**了原来的「设置主开关快捷键」菜单项 —— 后者只能录主开关一个
     * 组合键（还要走一次 core.showAlert 确认，UXP 里那个弹窗只有一句说明），
     * 用户要求把「选区填充」整组快捷键都搬进面板内统一管理，且外观/交互与绘画工具箱的
     * 「功能快捷键」子面板**完全一致**（同一个组件 FuncHotkeyPanel，scope='app'）。
     *
     * ⚠️ 但「录制」这条通路一个字节都不能改：全局按键只有 .8li 的钩子抓得到，
     *    面板侧的 requestHotkeyRecording / setMainToggleCombo 语义保持原样。
     * ⚠️ body 类 `app-hotkey-panel-open`（隐藏本面板 number + 收滚动条）由
     *    syncFloatPanelClasses() 按 state 派生 —— 单一写点，禁止在这里 classList.add：
     *    参数复位会用 ...initialState 整体覆盖 state，imperative 加的类会悬空，
     *    表现为「复位后所有数字永久消失」。
     */
    openAppHotkeyPanel() {
        this.setState({ isAppHotkeyOpen: true });
    }

    closeAppHotkeyPanel() {
        this.setState({ isAppHotkeyOpen: false });
    }

    /**
     * APP 侧热键的即时反馈：显示在「选区平滑」分区上方那条 notify-bar 里。
     * 新消息覆盖旧消息并重置计时（用户看到的永远是最近一次按键的结果）。
     *
     * ⛔ 这里只服务**「自定义快捷键」里与 APP 面板相关**的动作（开关 / 套索 /
     *    切换套索 / 清除模式 / 填充模式 / 混合模式）。绘画工具箱自己的反馈
     *    （切笔刷、跑功能按钮）仍留在 BrushHotkeySection 的 msg 条里 ——
     *    一条消息只在**用户眼睛当时所在的那块面板**出现，不在两处重复。
     */
    private showAppHotkeyNotify(text: string, ok: boolean) {
        /* 「热键通知」关掉后**本面板一条都不显示**（2026-11-16 用户要求：降低干扰）。
           ⛔ 判据同步读本面板（scope='app'）的缓存，不 await —— 通知是同步函数，
              等文件读回来消息早就该过期了；缓存由订阅器在挂载时与每次变化后刷新。
           ⛔ 与绘画工具箱那一份互不影响：那边静默不代表这边也静默。 */
        if (!hotkeyNotifyOnSync('app')) return;
        if (this.appNotifyTimer) { clearTimeout(this.appNotifyTimer); this.appNotifyTimer = null; }
        this.setState({ appHotkeyNotify: { text, ok } });
        this.appNotifyTimer = setTimeout(() => {
            this.appNotifyTimer = null;
            // 面板可能已卸载：卸载时 componentWillUnmount 会清掉定时器，这里只兜底判活
            if (this.setState) this.setState({ appHotkeyNotify: null });
        }, APP_HOTKEY_NOTIFY_TTL_MS);
    }


    // 新增方法
    toggleSelectionOptions() {
        const root = this.panelRef.current;
        // 即将折叠（当前展开）→ 先隐藏分区内原生控件，再让 React 卸载内容
        if (this.state.isSelectionOptionsExpanded) hideNativeWidgetsOfSections(root, ['selectionOptions']);
        this.setState(prevState => ({
            isSelectionOptionsExpanded: !prevState.isSelectionOptionsExpanded
        }));
        // ⛔ 必须等布局落定：折叠也会让内容变矮（同 handleSmoothModeChange 的 45px 错位）
        resyncAfterLayout(root);
    }

    handleSelectionContrastChange(value: number) {
        this.setState({ selectionContrast: value });
    }

    handleSelectionExpandChange(value: number) {
        this.setState({ selectionExpand: value });
    }

    // ===== 套索实时平滑（Wintab 笔输入通路）=====
    //
    // 为什么必须走原生插件：UXP 没有任何画布指针 API（app.tsx 里那两个
    // document.addEventListener('mousemove'/'mouseup') 监听的是**插件面板自身的 DOM**，
    // 与 PS 画布无关）。因此「套索绘制过程中」对 UXP 是盲区，唯一能介入的位置是
    // **PS 收到输入之前** —— 由 PS 进程内的 .8li 插件（smooth_engine.c）在
    // Wintab 取包处改写坐标。
    // （2026-10-12：鼠标钩子通路已按用户要求整体移除，只保留这一条笔通路。）
    // （2026-10-14：外置守护进程 + 注入 DLL 的旧链路退役，改为 .8li 进程内插件。）

    /**
     * 折叠/展开「选区平滑」分区（section id 仍为 smoothOptions，持久化键不变）。
     * 与 toggleSelectionOptions 同构：折叠前先把分区内的原生控件隐藏掉，再让 React 卸载内容，
     * 最后补一次重排（UXP 下原生控件的坐标不随重排自动更新，会出现「残留数字」）。
     */
    toggleSmoothOptions() {
        const root = this.panelRef.current;
        if (this.state.isSmoothOptionsExpanded) hideNativeWidgetsOfSections(root, ['smoothOptions']);
        this.setState(prevState => ({
            isSmoothOptionsExpanded: !prevState.isSmoothOptionsExpanded
        }));
        resyncAfterLayout(root);
    }

    /**
     * 套索平滑总开关（一条状态条：指示点 + 状态文案 + 开关，与「笔刷热键」同款）。
     *
     * ⚠️ 2026-10-14 .8li 迁移后：平滑承载在 **PS 进程内的 .8li 插件**里（随 PS 启动
     *    自动加载、常驻不解散），没有外置进程可拉起 —— 本开关就是纯粹的「开/关平滑」：
     *      开 = 下发 penSmooth(on, 整包参数)；
     *      关 = 下发 penSmooth(off)（.8li commit(0) 撤钩，服务本身常驻）。
     *    ⛔ 0x0118 起关不再双发 shutdown：penSmooth(off) 已内含 send_cmd(2)，
     *       第二条消息只会被 changed 护栏挡掉，而它走过的 cmd=2 撤钩路径
     *       正是「停摆中拨开关杀补流」的现场，少发一次是一次。
     *    旧「拉起 / 重启 / 卸载 SmoothDaemon」整条链路已随 daemon 一并删除。
     *
     * ⛔ 开关**永不禁用**（2026-10-12 真机事故：置灰 = 用户没有任何入口）：
     *    未连接（.8li 未加载）时点击 = 记下意图，penOn 会被 LassoSmoothing 记住，
     *    WS 建连后 resendLassoSmoothing 自动重放 ⇒ .8li 就绪后平滑自动跟上。
     *
     * ⛔⛔ 2026-10-19：开关位置 = **用户意图**（isPenSmoothOn），不再看 connected。
     *    旧判据 `connected && pen.enabled` 在 WS 瞬断（.8li 忙碌/重连窗口）时会把
     *    开关翻到关位并显示「服务未启动」，几秒后重连又翻回来 —— 用户报「开关偶尔
     *    自动变成服务未启动状态」。现在连接状态只影响**状态条文案**（带 2.5s 宽限，
     *    见 smoothStatusText），开关本身除非用户点击否则永不动。
     */
    toggleLassoSmooth() {
        // 「实际开着」= 用户意图（penOn）。⛔ 不要用 st.connected && st.pen.enabled：
        // 那正是 2026-10-19 修复的「瞬断时开关自己跳」根因；未连接时点击同样有效
        // （意图被记住，WS 建连后 resendLassoSmoothing 自动重放）。
        if (isPenSmoothOn()) {
            // 开着 ⇒ 关：只下发 off。⛔ 0x0118 不再双发 shutdown：
            // penSmooth(false) 内部就是 commit(0) → send_cmd(2) 撤钩，
            // 再发一次 disconnectSmoothDaemon()（shutdown）会被 changed
            // 护栏挡掉、纯属冗余；而它经过的那条 cmd=2 路径正是 0x0118
            // 修复的「停摆中拨开关即杀补流」现场 —— 少发一次是一次。
            setPenSmooth(false, this.state.smoothParams);
            return;
        }
        // 关着 ⇒ 开。未连接时发送必然失败，但意图会被记住并在建连后重放（见上）。
        setPenSmooth(true, this.state.smoothParams);
    }

    /** 模式单选：组件回传的是「原生形状」的事件对象，按 e.target.value 取值。 */
    handleSmoothModeChange(e: any) {
        const value = e?.target?.value as LassoSmoothMode;
        if (value !== 'standard' && value !== 'rope' && value !== 'catchup') return;
        this.updateSmoothParam({ mode: value });
        // 切换模式会**增删整行**（见 smoothParamApplies）⇒ 必须补一次原生控件重排：
        // UXP 的原生视图不随 DOM 重排自动更新，被移除那几行的数字输入框会在原位留下
        // 「残影数字」，比折叠分区里的同类问题更显眼（那里有 hideNativeWidgetsOfSections 兜底）。
        // ⛔⛔ 而且**必须等布局落定再补**：行被删掉后面板常正滚在底部，新的 max 比旧
        //    scrollTop 少一行；此刻拿旧布局去「抖动 + 恢复」会把越界的那一行塞回绘制层，
        //    造成「看到的位置与命中位置差 45px」（2026-11-18 用户报，见 resyncAfterLayout）。
        resyncAfterLayout(this.panelRef.current);
    }

    /**
     * 更新平滑参数。
     * ⚠️ 必须**整体替换**对象而不是就地改字段：持久化的变更检测用的是引用比较
     *    （见 componentDidUpdate 的 watchedKeys），就地修改会让引用不变 ⇒ 既不重渲染也不落盘。
     */
    updateSmoothParam(patch: Partial<LassoSmoothParams>) {
        const next: LassoSmoothParams = { ...this.state.smoothParams, ...patch };
        this.setState({ smoothParams: next });
        pushLassoSmoothParams(next);
    }

    /**
     * 某个平滑参数是否**作用于当前滤波族**（不作用 ⇒ 整行隐藏，而不是置灰）。
     *
     * ⛔ 这里刻意采用「隐藏」而非本仓默认的「整行禁用」：
     *    这几个参数属于**互斥族** —— 选了「拉绳」就同时失去强度 / 拐角 / 速度适应，
     *    留着它们就是两三行点了没反应的灰控件，既占纵向空间又容易被当成「坏了」。
     *    本仓「不隐藏只禁用」的铁律是为了防止隐藏后版式大幅塌陷（整列控件错位那种）；
     *    这里每行等高、上下行距恒定，隐藏只让后续行整体上移，不会破坏版式，
     *    因此「省空间 + 少困惑」的收益大于「控件位置恒定」的收益。
     *
     * ⚠️ 判据只有「是否作用于当前模式」这一条：开关关闭时参数依然可见可编辑 ——
     *    它们是预置值，用户完全可以先调好再开开关。
     *
     * 归属（与 smooth_engine.c（.8li 内，原 wintab_hook.c）的 smooth_packets 分支一一对应，勿凭感觉改）：
     *   半径 → **仅「拉绳」可调**（三模式半径互相独立：标准与追笔各固定 100px，
     *           由 radiusForMode() 统一下发；拉绳用自己持久化的滑杆值）
     *   强度 / 尖角保护 / 速度适应 → 仅「标准」（拉绳与追笔都不读 Strength）
     *   追笔耗时 → 仅「追笔」
     *   拉绳提示 → 仅「拉绳」
     *
     * ⚠️ 拉绳提示（HUD）为什么也归到「拉绳」：它画的就是那根绳。标准/追笔模式下
     *    显示它等于给用户看一个「此刻根本不存在」的圈（2026-10-13 用户明确指出）。
     */
    private smoothParamApplies(which: 'strength' | 'catchUp' | 'cornerAngle' | 'speedAdaptive' | 'leash' | 'radius'): boolean {
        const mode = this.state.smoothParams.mode;
        if (which === 'radius') return mode === 'rope';
        if (which === 'leash') return mode === 'rope';
        if (which === 'catchUp') return mode === 'catchup';
        return mode === 'standard'; // strength / cornerAngle / speedAdaptive
    }

    // ===== 平滑的工具闸门（2026-10-13）=====
    //
    // ⛔ 为什么需要：用户报「无论我选择什么工具，只要我用数位笔移动光标，
    //    已平滑的数字就在涨，拉绳工具的洋红圈也都会显示」。
    //    根因是原生侧此前**只判开关**：悬空移动与落笔绘制都会改写坐标。
    // ⇒ 这里按 300ms 巡检当前工具，把「是不是套索」喂给原生侧；
    //    原生侧再叠加自己的「笔尖是否接触画布」判据，两者同时成立才平滑。
    //
    // ⚠️ 读不到工具时上报 **2（未知）而不是 0**：把「读失败」当成「不是套索」
    //    会把平滑整个关掉，而面板上开关仍显示为开 —— 一个查不出原因的死结。

    /** 判定某个工具 ID 是否是「套索类」（三个套索工具：套索 / 多边形套索 / 磁性套索）。 */
    private static isLassoTool(tool: string | null): boolean {
        if (!tool) return false;
        /* ⚠️ 三个套索工具的真名是 lassoTool / **polySelTool** / magneticLassoTool
           （多边形套索 = polySelTool，不是 polygonalLassoTool —— 见
            `docs/lnp-ps64-reverse-2026-10-16.md` 里的二进制工具表）。
           ⛔ 本函数**故意只认 lasso 关键词**，因此 `polySelTool` 在这里判为 false：
              ① 平滑改写的是**连续笔迹**的坐标，多边形套索是「点击落点」式工具，
                 把闸门开给它会去改写顶点位置（点不准），比不平滑更糟；
              ② 本口径与原生侧 `ps_tool.c` 的 `ci_has(name,"lasso")` **必须逐字一致**
                 （铁律：两边口径一起改，单改一边就是静默分歧）。
           ⇒ 「是不是套索族、要不要算同族循环/别踢回去」用的是
              `HotkeyBridge.isLassoToolId()`（那边按族成员精确比较，含 polySelTool），
              两个问题、两套判据，别混用。 */
        return /lasso/i.test(tool);
    }

    /**
     * 是否是**套索组里的「子工具」**（多边形套索 / 磁性套索）。
     *
     * ⛔ 与 `isLassoTool()` 是两件事，别合并：
     *   · `isLassoTool()` = 「吃不吃平滑」的口径（只认 lasso 关键词，polySelTool 判 false）；
     *   · 本函数 = 「是不是套索组里那两个非普通套索」的口径，用于
     *     ① 关闭总开关时要不要顺手退回普通套索（用户 2026-11-16 要求）；
     *     ② 提示文案里点出用户现在停在哪个子工具。
     *   ⚠️ 名单与 `HotkeyBridge.LASSO_GROUP` 必须一致（三个真名见那边的注释）。
     */
    private static isSubLassoTool(tool: string | null): boolean {
        return tool === 'polySelTool' || tool === 'magneticLassoTool';
    }

    /** 工具引用名 → 界面文案（提示用；认不出的原样回显，绝不吞掉信息）。 */
    private static toolRefLabel(ref: string | null): string {
        switch (ref) {
            case 'lassoTool': return '套索工具';
            case 'polySelTool': return '多边形套索';
            case 'magneticLassoTool': return '磁性套索';
            case 'marqueeRectTool': return '矩形选框';
            case 'marqueeEllipTool': return '椭圆选框';
            case 'eyedropperTool': return '吸管工具';
            default: return ref || '未知工具';
        }
    }

    /**
     * 「当前工具」的**本地最佳猜测**：优先用「自动关」巡检维护的 `lastKnownTool`，
     * 退而用 .8li 的 'slct' 回调报来的 `psTool`。
     *
     * ⛔ 刻意不在这里读 `application.tool`：热键回调落在用户按键的同一拍，
     *    此刻插一条 batchPlay get 会抢模态作用域（本仓的高频读取痛点），
     *    而这两个值已经足够回答「是不是多边/磁性套索」这种粗粒度问题。
     *    读不到（两者皆空）一律当「不知道」⇒ 调用方不做任何工具动作。
     */
    private currentToolGuess(): string | null {
        return this.lastKnownTool || this.state.smoothStatus?.pen?.psTool || null;
    }

    /**
     * 面板**确认到真实工具**时统一走这里：既维护「自动关」的基准，也把
     * 「Shift+L 组内循环」的游标对齐。
     *
     * ⛔ 为什么必须同步游标：游标住在 HotkeyBridge 模块里，面板自己用 batchPlay
     *    切了工具（H 关开关退回普通套索、L 切回套索、临时吸管松开切回）时它不知道，
     *    于是下一次 Shift+L 会从**旧的那一格**往后走 —— 表现就是「偶尔跳过一格」。
     */
    private noteRealTool(tool: string | null) {
        this.lastKnownTool = tool;
        syncToolCursors(tool);
    }

    /**
     * 按「平滑是否需要工具闸门」启停巡检。
     *
     * ⛔ 只在**平滑真的开着**时才跑：闸门只服务于平滑，平滑关着时每一轮巡检都是一次
     *    白白的 batchPlay get（模态作用域）——本仓刚清理过一轮高频模态读取，不能再加回一条。
     * ⛔ 与「自动关」的巡检**互斥复用**：自动关开着时它已经在按同样的间隔读同一个工具
     *    （见 pollToolChange 末尾的顺带喂闸门），这里就不再另起一条定时器做重复读取。
     */
    private syncSmoothToolWatch() {
        const smoothActive = this.state.smoothStatus.connected && !!this.state.smoothStatus.pen.enabled;
        const autoOffActive = this.state.isEnabled && this.state.autoOffOnOtherTool;
        // ⛔⛔ 0x0115：判据从 `toolSrc === 2` 换成 `inProcGateOwned()`。
        //    差别只有一处 —— 后者带 **2 秒时效**（原生侧算好、经 gateOwned 下发）：
        //    'slct' 一旦静默，gateOwned 立刻变 0 ⇒ 本巡检**立即恢复**，闸门真相
        //    重新由面板供给。真机 pid 13428 就是死在这里：'slct' 连投 5 次后静默
        //    72 秒，而旧判据 `toolSrc === 2` 一直成立 ⇒ 闸门永久冻结在 gate=0，
        //    HUD 再不显示，开关平滑也救不回来（开关不改变闸门值）。
        //    ⇒ 现在「停轮询」从**永久状态**变成**瞬时状态**：静默了就让位，恢复了再停。
        // ⚠️ 让位时用的是**全速** TOOL_WATCH_INTERVAL_MS(1000ms) 而不降频：
        //    静默期闸门是错的，纠正速度优先于省预算；省预算的收益只在 'slct'
        //    真的在投递的那段时间拿到，那已经足够。
        const gateOwned = this.inProcGateOwned();
        /* ⛔⛔ 0x0223：**多边形吸附也吃工具闸门，而它不依赖平滑总开关**。
           旧版 `need` 只看 `smoothActive` ⇒ 平滑关着时这条 1s 巡检不建表，
           而 `setSmoothToolGate` 的心跳也绑在 penOn 上 ⇒ 两条来源同时停 ⇒
           原生 `I_GATETS` 3s 后过期 ⇒ `poly_snap_run` 的 `tool_gate_ok()` 恒 0 ⇒
           **包路径吸附整段死掉**（连 `poly_pkt_click` 的接触钉住一起），
           用户实测就是「只开吸附时经常长时间不吸、两者都开才稳」。
           ⚠️ 代价：吸附开着而平滑关着时多一条 1s 的 batchPlay 工具读 —— 与平滑
              自己开着时完全同构的一条读，不新增第二条定时器（互斥复用同一条）。 */
        const snapActive = this.state.smoothStatus.connected && this.state.polySnapEnabled;
        /* ⛔⛔ 0x0224：混合模式热键开着时，工具读数由 `syncToolWatch` 那条巡检承担
           （它同时喂闸门，见 pollToolChange）。这里必须让位，否则两条 1s 巡检
           同时读同一个工具 ⇒ 总模态读取 2.5 → 3.5 次/秒，超过 psAccess 的
           3.3 次/秒吞吐上限，队列开始积压（即用户看到的「读条卡住」）。
           ⚠️ 让位是安全的：pollToolChange 的闸门供给条件已与这里对齐
              （`pen.enabled || polySnapEnabled`），不会漏喂。 */
        const blendActive = blendGuardWatchNeeded();
        const need = (smoothActive || snapActive) && !autoOffActive && !blendActive && !gateOwned;
        if (need && !this.smoothToolTimer) {
            this.smoothToolTimer = setInterval(() => { void this.pollSmoothToolGate(); }, App.TOOL_WATCH_INTERVAL_MS);
            void this.pollSmoothToolGate();   /* ⛔ 建表时先跑一次：让位瞬间不要空等 1s */
        } else if (!need && this.smoothToolTimer) {
            clearInterval(this.smoothToolTimer);
            this.smoothToolTimer = null;
            // 停掉后把闸门放回「未知」：残留的 0（不是套索）会让下次开启时迟迟不生效，
            // 而界面上看不出任何原因。原生侧还有 3 秒过期兜底，这是双保险。
            // ⛔ 进程内正供给闸门时不放（放了也没用：原生侧接管后忽略面板值，徒增一次 WS 发送）。
            if (!gateOwned) setSmoothToolGate(2);
        }
    }

    /**
     * 此刻闸门是否**真的**由进程内 `'slct'` 供给。
     *
     * ⛔ 统一咽喉：`syncSmoothToolWatch` 与 `applyToolGate` 都必须走这里 ——
     *    原生侧 `write_params()` 的让位判据也是同一个结论（它下发的 `gateOwned`），
     *    两边读的是同一个数，不会出现「面板以为该让位、原生以为不该」的错位。
     * ⚠️ -1 = 对端是旧版 .8li（不报该字段）⇒ 退回 `toolSrc === 2` 的旧判据。
     */
    private inProcGateOwned(): boolean {
        const p = this.state.smoothStatus.pen;
        if (p.gateOwned < 0) return p.toolSrc === 2;
        return p.gateOwned === 1;
    }


    /**
     * 巡检一次当前工具并上报闸门。
     * ⚠️ 必须走 psRead（模态作用域）与忙碌闸门：这是与既有工具巡检完全同构的读，
     *    裸读会撞出宿主原生报错框。
     */
    private async pollSmoothToolGate() {
        if (this.smoothToolBusy && Date.now() - this.smoothToolBusySince < 3000) return;
        // ⛔ 0x0208：用户正在宿主画布上拖拽/缩放 ⇒ 本轮让路。
        //    缩放动画是宿主主线程上的交互，本轮的 batchPlay get 会把模态作用域从它手里
        //    抢走一次 ⇒ 动画被劈成两段（用户报的「卡顿、抽搐」）。丢一轮工具读数无副作用：
        //    下一拍（≤1s）自会补上，且 'slct' 事件通路不经过这里。
        // ⛔ 0x0209：**必须给上限**（900ms）—— 见 hostInteraction.hostYield 的长注释。
        //    笔尖落笔会模拟左键 ⇒ 绘画期间 hostBusy 恒为真 ⇒ 无限让路会把工具闸门
        //    冻在切走前的值上，切到涂抹/HUD 照旧、平滑照跑（用户报的 BUG1）。
        if (hostYield('平滑工具闸门巡检', 900)) return;
        // ⛔ 进程内模态层级 = **确定的事实**（PS 自己报「我正握着模态作用域」），
        //    比 isPsBusy() 的常数窗口外推可靠 ⇒ 确定忙时直接跳过本轮。
        if (isPsBusy() || psBusyInProc() === 1) return;
        this.smoothToolBusy = true;
        this.smoothToolBusySince = Date.now();
        try {
            const tool = await this.readCurrentToolId();
            /* 0x0224：同一份读数顺带喂「混合模式热键按工具让位」的判据。
               （本巡检在 autoOff 关闭时才会跑，是那条路之外唯一会读工具的通路。） */
            noteToolForBlendYield(tool);
            this.applyToolGate(tool);
        } catch {
            this.applyToolGate(null);
        } finally {
            this.smoothToolBusy = false;
        }
    }

    /**
     * 把一次工具读数折算成闸门值并上报。
     *
     * ⛔⛔ 读失败时**绝不能**把闸门改回「未知(2)」—— 那会把平滑整个关死（原生侧
     *    2026-10-14 起 2=阻断）。读失败时**沿用上一次的判定**（setSmoothToolGate
     *    收到同值也会在 1.8s 后续期时间戳；独立 WS 心跳兜底续期，见 LassoSmoothing）。
     *    只有**从来没读到过**（仍是初值 2）时才维持 2：冷启动后第一轮巡检（≤1s）
     *    之前套索平滑短暂待命，这是「只在套索生效」的必要代价。
     */
    private applyToolGate(tool: string | null, force = false) {
        // ⛔⛔ 此刻闸门由进程内 'slct' 供给（gateOwned===1，带 2 秒时效）⇒ 立即退出，
        //    一个字节都不写。接管后闸门值由 .8li 的 'slct' 回调独占写入（它同时刷
        //    GATETS）；面板再写就是两边互相覆盖 —— 各自都在刷时间戳，于是「谁都新鲜」，
        //    现象是工具切了不生效、或换回套索不恢复。
        //    这里是唯一咽喉：pollSmoothToolGate（平滑闸门轮询）与 pollToolChange
        //    （「自动关」的顺带喂闸门）都走它，所以只需在这里挡一次。
        // ⛔ 0x0115：判据换成带时效的 inProcGateOwned() —— 与 syncSmoothToolWatch、
        //    以及原生侧 write_params() 的让位判据**同源**（都是原生下发的 gateOwned）。
        //    'slct' 静默 ⇒ gateOwned 变 0 ⇒ 本处放行 ⇒ 面板重新喂闸门 ⇒ 自愈。
        // ⛔ 0x020A：`force` = 面板刚亲手切过工具（临时吸管进出）。此时面板的判定
        //    比进程内 'slct' 回调**更新**（回调要等 PS 派发通知），而让位规则只会
        //    让它更慢一拍 ⇒ 明确要求覆盖时跳过让位。只在临时吸管的两帧使用。
        if (!force && this.inProcGateOwned()) {
            const t = this.state.smoothStatus.pen.psTool;
            if (t && t !== this.lastToolRead) {
                console.log('[套索平滑闸门] 当前工具 = ' + t + '（进程内 slct 通知）');
                this.lastToolRead = t;
            }
            return;
        }
        if (tool) {
            // ⛔ 工具 ID 原文仍然保留，只是不再显示在状态条上（用户 2026-10-13 要求
            //    「生效中」后面不挂任何参数）。改为**读数变化时**打一条 console：
            //    闸门是否生效全取决于这一次读数，排障时看控制台就能区分
            //    「读错了工具」与「压根没读到（读数为空 ⇒ 闸门退化为放行）」。
            if (tool !== this.lastToolRead) {
                console.log('[套索平滑闸门] 当前工具 = ' + tool);
                this.lastToolRead = tool;
            }
            // 0x0133：**真读到了**才刷新闸门的「读数时刻」——原生侧拿它当时间戳，
            //    不再用 now。读失败时不刷新 ⇒ 年龄自然增长 ⇒ 3s 后 fail-closed，
            //    这样「过期的『是套索』被心跳永久续命」这条通路被彻底切断
            //    （用户实测：用铅笔时套索 HUD 意外出现）。
            noteToolReadOk();
            setSmoothToolGate(App.isLassoTool(tool) ? 1 : 0);
            return;
        }
        // 读失败：沿用上次判定（值不变，但**读数时刻也不动** ⇒ 3s 后原生侧自动阻断）。
        setSmoothToolGate(getSmoothToolGate());
    }

    /** 把平滑模块（.8li）回报的平滑状态写进 state（渲染要读它，因此不能只写实例字段）。 */
    private applySmoothStatus(s: LassoSmoothStatus) {
        this.setState({ smoothStatus: s });
        // ⛔⛔ 2026-10-19：连接瞬断宽限的计时（见 SMOOTH_DISCONNECT_GRACE_MS）。
        //    WS 瞬断（.8li 忙碌/重连窗口，1.5s 后自动重连）时**不立刻**把状态条
        //    翻成「服务未启动」——那正是用户报的「开关/状态条偶尔自动变成服务未启动」
        //    的另一半（开关已改为意图语义，这里是文案侧）。宽限内用最后一帧的 pen
        //    数据继续显示上一状态；超时仍断着才如实报告。
        //    ⚠️ 冷启动（从未连上过）不走宽限：smoothWasConnected=false 时直接放行
        //    「服务未启动」——那是「.8li 没装/没就绪」的真实提示，不该延迟。
        if (s.connected) {
            this.smoothWasConnected = true;
            this.smoothDisconnectedAt = 0;
            if (this.smoothDisconnectTimer) {
                clearTimeout(this.smoothDisconnectTimer);
                this.smoothDisconnectTimer = null;
            }
        } else if (this.smoothWasConnected && this.smoothDisconnectedAt === 0) {
            this.smoothDisconnectedAt = Date.now();
            // 宽限到期强制重渲染一次：断连期间没有回帧可达，
            // 不补这一脚，文案会永远停在宽限内的旧状态（用户报「几秒后复原」
            // 的反面——永不显示「服务未启动」，同样失真）。
            this.smoothDisconnectTimer = setTimeout(() => {
                this.smoothDisconnectTimer = null;
                this.forceUpdate();
            }, App.SMOOTH_DISCONNECT_GRACE_MS);
        }
        // ⛔ 实时活跃度追踪（notify bar「平滑中断」检测的数据源）：
        //    packets 增长 = PS 还在从钩子取包。配合 snAge（快照年龄）可把三种
        //    状态分开：取包且快照新鲜 = 正在平滑；快照变老 = 正常停笔；
        //    「取包在涨 + 快照冻结」= 断流（标定丢失等）—— 用户感知的「平滑失效」，
        //    状态条必须如实说出来，不能永远挂「生效中」（2026-10-14 用户要求）。
        const p = s.pen;
        // 进程内模态层级（PICA modalStateChanged）注入 psProbe：巡检类调用点据此
        // **确定地**跳过本轮，不再靠常数窗口猜 PS 忙不忙（2026-10-17 LNP 逆向迁移）。
        if (p) setInProcModalLevel(p.modalLevel);
        if (p && p.packets !== this.lastPenPackets) {
            this.lastPenFlowAt = Date.now();
            this.lastPenPackets = p.packets;
        }
        // 闸门巡检的启停挂在**状态回报**上，而不是开关点击上：
        // 开关状态会因模块重启/重连而变化，挂在回报里才不会漏。
        this.syncSmoothToolWatch();
    }

    /**
     * 平滑连接是否处于**瞬断宽限**内（已连上过、刚断、未超时）。
     * 宽限内状态条保持上一状态文案，避免 WS 重连窗口里的闪烁。
     */
    private smoothInDisconnectGrace(): boolean {
        return this.smoothDisconnectedAt > 0 &&
            Date.now() - this.smoothDisconnectedAt < App.SMOOTH_DISCONNECT_GRACE_MS;
    }

    /**
     * 套索平滑状态条文案（面板里唯一一条平滑状态行）。
     *
     * 判据优先级刻意如此：启动中 → 连接 → 协议不支持 → 开关 → 标定 → 注入 → 生效。
     * ⛔ 「未连接 / 模块版本过旧 / 标定失败 / 还没注入 PS」是四种完全不同的原因，
     *    必须分开说 —— 全都显示成同一句话会把排查方向彻底带偏。
     */
    private smoothStatusText(): string {
        const st = this.state.smoothStatus;
        const pen = st.pen;
        // ⛔ 顺序不可换：先判「服务在不在 / 认不认识这条通路」，再判它的实际状态。
        //    `unsupported` 只说明「套索平滑协议」不通；旧版是**通过**那条探针的，
        //    必须靠 `penUnsupported` 才能如实说出「版本过旧」，否则会误导成「点了没反应」。
        if (!st.connected) {
            // ⛔⛔ 2026-10-19：瞬断宽限（见 SMOOTH_DISCONNECT_GRACE_MS）。
            //    已建立的连接刚断（.8li 忙碌/重连窗口，1.5s 内自动恢复）时，
            //    用最后一帧的 pen 数据继续显示上一状态，不闪「服务未启动」；
            //    超过宽限仍断着（或从未连上过）才如实报告。
            if (!this.smoothInDisconnectGrace()) {
                // .8li 未加载/未监听 18924（PS 刚启动的窗口期，或模块没装进 Plug-ins）。
                return '套索平滑：服务未启动';
            }
            // 宽限内：落到下面的 pen 判定（数据是断连前最后一帧的真相）。
        }
        if (st.unsupported || st.penUnsupported) return '套索平滑：版本过旧（请更新 .8li 后重启 Photoshop）';
        if (!pen.enabled) return '套索平滑：关';
        // state=4：入口已被上一版 DLL 的转发桩占着（旧 DLL 被 PS 锁住没法覆盖，
        // 新版换了文件名注入进来，成了同一进程里的第二个副本）。本实例拒绝叠加钩子
        // （否则双重平滑），只能让用户重启 PS —— 必须说出来，否则状态条只会一直停在
        // 「注入中…」，用户无从下手。
        if (pen.state === 4) return '套索平滑：旧模块仍在生效（请重启 Photoshop）';
        if (pen.state === 2) return '套索平滑：标定失败（未生效）';
        if (pen.injectedCount === 0) return '套索平滑：等待 Photoshop…';
        // state=3：钩子已被卸载（收到过卸载命令），而面板侧开关仍是开。
        // ⛔ 必须单列：旧版没有这一档，会一直落到下面「标定中…」⇒ 用户看到的是一个
        //    永远转不完的状态，只能靠反复开关来撞。
        //    模块侧已有自愈（见 plugin_main.c 的 HealIfUnhooked 巡检），这里如实说一句即可。
        if (pen.state === 3) return '套索平滑：未生效（正在自动恢复…）';
        // ⛔ 2026-10-13 用户明确要求：生效中之后**不再显示任何参数/诊断**。
        //    模式 / 强度 / 半径 / 读到的工具 ID / 已平滑包数 / 闸门与落笔提示全部删除 ——
        //    对使用者没有信息价值，却把一条状态行撑得很长。
        //    真正需要解释的那几种情况（未连接 / 版本过旧 / 标定失败 / 未注入 / 未生效）
        //    各自都有独立分支，仍然逐条说清。
        // ⚠️ 上面提到的那几个诊断量仍在 `pen` / `lastToolRead` 里，需要排查时从
        //    控制台 `__jwPs.dump()` 或 hook 日志取，不再占界面。
        if (pen.state === 1) {
            // ⛔ 2026-10-14：state=1 只说明「标定通过」，不等于「此刻真的在改写」。
            //    唯一还要单列的是「平滑中断」：笔已落纸、闸门也成立、PS 还在持续取包
            //    （packets 在涨），但 DLL 快照已冻结 2.2s（snAge 界限含状态泵 500ms 周期
            //    + 裕量）—— 这是标定丢失/改写被跳过的「真断流」，即用户感知的
            //    「平滑失效」本体。判据刻意不用 smoothed：松弛绳下输出==原样、无改写是
            //    **正常**的。
            // ⛔ 2026-10-14 用户明确要求：**不再**按模式分叉显示（旧的「非拉绳模式」那句
            //    已删）。用户选了什么模式就是什么模式，模式本身只影响算法，不改变
            //    「生效 / 中断」这两档状态文案与配色。
            const t = Date.now();
            const flowing = (t - this.lastPenFlowAt) < 1500;   // PS 侧还有包进来
            const snStale = pen.snAge >= 0 && pen.snAge > 2200;
            if (pen.penDown === 1 && pen.gateOk === 1 && flowing && snStale) {
                return '套索平滑：平滑中断（笔已落纸但未改写，请截图反馈）';
            }
            return '套索平滑：生效中';
        }
        // state=0：已注入但标定还没通过。标定要等「序号逐包 +1」的证据：
        // 0x0131 起分层取证 —— 3 包可独走盲扫，2 包必须与驱动上报的掩码互证，
        // 1 包时用 WTPacketsPeek 只读快照凑一批（旧版硬要 3 包，而真机常态是一次
        // 只取 1 包 ⇒ 标定永远不成立、界面永远停在这一档）。
        // ⛔ 2026-10-18 用户明确要求：**隐藏标定过程**——后台静默处理，不向用户
        //    展示「待标定 / 标定中」这类中间态（它们对使用者没有信息价值，反而
        //    像卡住）。两个分支统一为中性文案，配色走 notify-bar-disabled（灰、
        //    无颜色），与「关」档同款；标定成功后自然翻到「生效中」（主色蓝）。
        //    真正需要解释的情况（未连接 / 版本过旧 / 标定失败 / 未注入 / 未生效）
        //    仍各自单列，不受本条影响。
        return '套索平滑：准备中';
    }

    /**
     * 状态条的配色档（返回 .notify-bar 的修饰类）。
     * 与 smoothStatusText 判据一一对应但分开返回：合并成「返回 {文本, 类名}」的对象
     * 会在每次渲染新建对象、且两处口径容易漂移。
     * 档位：关 = 灰 / 标定中（后台静默）= 灰 / 服务没起来 = 橙（要用户处置）/
     *      标定失败 = 红 / 生效 = 主色蓝 / 平滑中断 = 红。
     */
    private smoothBarTone(): string {
        const st = this.state.smoothStatus;
        const pen = st.pen;
        // 与 smoothStatusText 同款宽限：瞬断期间保持上一档配色，不闪橙
        // （「服务没起来」的橙色是「要用户处置」的信号，不该在自动重连窗口里误报）。
        const down = !st.connected && !this.smoothInDisconnectGrace();
        if (down || st.unsupported || st.penUnsupported) return 'notify-bar-warn';
        if (!pen.enabled) return 'notify-bar-disabled';
        if (pen.state === 2) return 'notify-bar-fail';
        if (pen.state === 1) {
            // 与 smoothStatusText 的异常分支一一对应：中断 = 红，其余 = 主色蓝。
            // ⛔ 2026-10-14：不再有「非拉绳模式 = 橙」这一档（用户要求）。
            const t = Date.now();
            const flowing = (t - this.lastPenFlowAt) < 1500;
            const snStale = pen.snAge >= 0 && pen.snAge > 2200;
            if (pen.penDown === 1 && pen.gateOk === 1 && flowing && snStale) return 'notify-bar-fail';
            return 'notify-bar-ok';
        }
        // state=0（标定中）及其它未列举态：⛔ 2026-10-18 用户要求隐藏黄色标定态
        // ⇒ 落 notify-bar-disabled（中性灰、无颜色），与「关」档一致。
        return 'notify-bar-disabled';
    }

    /**
     * 配色档 → 指示点类。
     * ⚠️ 由档位**映射**而不是重判一次：判据写两遍，漂移一次就再也对不上。
     * 「关」档用灰点：它表示「条件未满足、尚未生效」，与服务没起来的橙区分。
     */
    private static smoothDotOfTone(tone: string): string {
        if (tone === 'notify-bar-ok') return 'indicator-ok';
        if (tone === 'notify-bar-warn') return 'indicator-warn';
        if (tone === 'notify-bar-fail') return 'indicator-fail';
        return 'indicator-disabled';
    }

    // 应用选区修改
    async applySelectionModification() {
        const options: SelectionOptions = {
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
        resyncAfterLayout(root);
    }

    /**
     * 浮窗打开后的「滚动条槽补偿」按需开关。
     *
     * 背景：浮窗打开时会给 `.panel` 加 `overflow-y: hidden` 收起滚动条
     * （避免滚动条压住浮窗右缘）；收起后内容盒会宽出 10px，导致背景重排。
     * 旧做法是无条件 `padding-right: 20px` 把这 10px 补回来。
     *
     * ⛔ 无条件补的缺陷（用户报「打开浮窗后下方面板多出滚动条」）：
     *    面板**本来没有**滚动条时，内容盒本来就是 230px，这 10px 反而把它收窄成
     *    220px ⇒ 内容重排、变高 ⇒ 溢出多出一根滚动条。
     *    ⇒ 只在「面板确实有滚动条」时才补（那 10px 才真正是补偿）。
     *
     * 判据 = `scrollHeight > clientHeight`（内容高于滚动区 ⇒ 现在就有滚动条）。
     * ⚠️ 必须在加 `overflow-y: hidden` **之前**测：加了以后滚动条没了，
     *    两个值都可能变化（UXP 的滚动槽压在内容盒内部，行为不完全等同桌面浏览器）。
     * ⚠️ 面板无内容 / 未挂载时按「不补」处理（宁可少 10px 内边距，也不要凭空多出滚动条）。
     */
    private syncPanelGutter() {
        const el = this.panelRef.current;
        let needs = false;
        try {
            if (el) needs = el.scrollHeight > el.clientHeight + 1;
        } catch (_) {
            needs = false;
        }
        if (needs) document.body.classList.add('app-panel-gutter');
        else document.body.classList.remove('app-panel-gutter');
    }

    /**
     * 打开「隐藏/显示分区」浮窗（与像素调整面板同一套交互）。
     *
     * ⚠️ 多个浮窗**共用一个遮罩、纵向堆叠**（2026-10-10 用户要求）：
     *    不许各自一个 .float-overlay —— 那会让遮罩层数随窗口数增加，
     *    视觉上「越开越黑」；且后开的窗口会盖住先开的（用户明确要求「新开的排在下面」）。
     *    实现：state.floatOrder 记录开启先后（数组即 DOM 顺序），渲染时统一挂在一个
     *    .float-overlay > .float-stack 里，堆叠间距 10px（见 common.css .float-stack）。
     *    body 类不在这里挂：统一由 componentDidUpdate 按 state 派生（见 syncFloatPanelClasses），
     *    这样「参数复位」等绕过本方法的 state 变更也不会留下悬空类（悬空 = 数字永久隐藏）。
     */
    openVisibilityPanel() {
        this.setState(prev => ({
            showVisibilityPanel: true,
            floatOrder: prev.floatOrder.indexOf('visibility') >= 0
                ? prev.floatOrder
                : prev.floatOrder.concat('visibility'),
        }));
    }

    closeVisibilityPanel() {
        this.setState(prev => ({
            showVisibilityPanel: false,
            floatOrder: prev.floatOrder.filter(id => id !== 'visibility'),
        }));
    }

    /**
     * 打开「填充设置」浮窗（承载原面板底部的四个选项）。
     * 与「隐藏/显示分区」浮窗同一套机制：共用一个遮罩、纵向堆叠（后开的排在下面）。
     */
    openFillSettingsPanel() {
        this.setState(prev => ({
            isFillSettingsOpen: true,
            floatOrder: prev.floatOrder.indexOf('fill') >= 0
                ? prev.floatOrder
                : prev.floatOrder.concat('fill'),
        }));
    }

    closeFillSettingsPanel() {
        this.setState(prev => ({
            isFillSettingsOpen: false,
            floatOrder: prev.floatOrder.filter(id => id !== 'fill'),
        }));
    }

    /** 关闭全部浮窗（点遮罩空白处 = 整层取消，语义与「弹层被点掉」一致） */
    closeAllFloatWindows() {
        this.setState({ showVisibilityPanel: false, isFillSettingsOpen: false, floatOrder: [] });
    }

    /**
     * 浮窗相关 body 类**由 state 派生**（与 secondary-panel-open 同款，2026-10-10）。
     *
     * 🔴 为什么不再在 open/close 里直接 classList.add/remove：
     *   `onResetParameters` 用 `...initialState` 整体覆盖 state（把两个浮窗布尔量打回 false），
     *   但它**绕过**了 closeXxx() ⇒ 旧写法会把 body.app-visibility-panel-open 留在身上，
     *   而该类的职责是「隐藏本面板全部 number」⇒ 参数复位后所有数字**永久消失**、
     *   且再开一次浮窗才能恢复（用户可见的“数字不见了”事故）。
     *   派生式同步对「任何」state 变更都成立，天然没有这个死角。
     */
    private syncFloatPanelClasses() {
        const vis = !!this.state.showVisibilityPanel;
        const fill = !!this.state.isFillSettingsOpen;
        /**
         * 「自定义快捷键」子面板（2026-11-16）：它与两个浮窗共用同一套「遮罩态」body 类，
         * 但**类名独立**（app-hotkey-panel-open）—— 原因同「浮窗按面板拆类」那段说明：
         * 同一个 body 上，浮窗与子面板的开合生命周期不同（子面板由菜单开、
         * 浮窗由另一条菜单项开），共用一个类会让「关掉其中一个」把另一个的遮挡一起摘掉，
         * 结果是原生 number 输入重新浮到子面板之上（工具箱历史上正是两个独立 effect
         * 互相 remove 导致的事故）。
         */
        const hk = !!this.state.isAppHotkeyOpen;
        if (vis || fill || hk) this.syncPanelGutter();
        else document.body.classList.remove('app-panel-gutter');
        document.body.classList.toggle('app-visibility-panel-open', vis);
        document.body.classList.toggle('app-fill-settings-open', fill);
        document.body.classList.toggle('app-hotkey-panel-open', hk);
    }

    /**
     * 「隐藏/显示分区」浮窗内容（标题行 + 两行开关）。
     * 单独抽成方法：浮窗本体改由 floatOrder 统一渲染，内容按 id 取用（见 render 里的浮窗图层）。
     * ⚠️ 标题行必须与其它子面板同构（标题 + 红 × 同处 .subpanel-title-1，它自带
     *    justify-content:space-between + align-items:center）。勿再用 .row-between 包一层：
     *    .subpanel-title-1 自带 margin-bottom:10px，在 align-items:center 的外层 flex 里
     *    会把标题整体上移 5px（历史错位根因）。
     */
    private renderVisibilityFloatContent() {
        return (
            <>
                <div className="subpanel-title-1">
                    <span title={helpTexts.selectionFill.visibilityPanelTitle}>隐藏/显示分区</span>
                    <div role="button" tabIndex={0} className="close-button" title={helpTexts.selectionFill.floatClose} onClick={() => this.closeVisibilityPanel()}>×</div>
                </div>
                <div className="panel-section">
                    <div className="row-between">
                        <span className="label-6" title={helpTexts.selectionFill.visibilitySection} onClick={() => this.toggleSectionVisibility('smoothOptions')}>套索轨迹平滑</span>
                        <ToggleSwitch checked={this.state.smoothOptionsVisible} onChange={() => this.toggleSectionVisibility('smoothOptions')} title={helpTexts.selectionFill.visibilitySection}  />
                    </div>
                    <div className="row-between">
                        <span className="label-4" title={helpTexts.selectionFill.visibilitySection} onClick={() => this.toggleSectionVisibility('selectionOptions')}>选区改造</span>
                        <ToggleSwitch checked={this.state.selectionOptionsVisible} onChange={() => this.toggleSectionVisibility('selectionOptions')} title={helpTexts.selectionFill.visibilitySection}  />
                    </div>
                    <div className="row-between">
                        <span className="label-4" title={helpTexts.selectionFill.visibilitySection} onClick={() => this.toggleSectionVisibility('fillOptions')}>填充选项</span>
                        <ToggleSwitch checked={this.state.fillOptionsVisible} onChange={() => this.toggleSectionVisibility('fillOptions')} title={helpTexts.selectionFill.visibilitySection}  />
                    </div>
                </div>
            </>
        );
    }

    /**
     * 「填充设置」浮窗内容：承载原面板底部的四个选项。
     * 2026-10-10 改造：由「2×2 原生 checkbox」改为「四行自绘开关（row-between）」，
     * 与「隐藏/显示分区」浮窗、各面板的「标签 + 开关」行同构 —— 视觉更统一、
     * 触摸目标更大，也彻底避开 UXP 原生 checkbox 的墨迹内缩对齐问题。
     */
    private renderFillSettingsFloatContent() {
        return (
            <>
                <div className="subpanel-title-1">
                    <span title={helpTexts.selectionFill.fillSettingsTitle}>填充设置</span>
                    <div role="button" tabIndex={0} className="close-button" title={helpTexts.selectionFill.floatClose} onClick={() => this.closeFillSettingsPanel()}>×</div>
                </div>
                <div className="panel-section">
                    <div className="row-between">
                        <span className="label-5" title={helpTexts.selectionFill.deselectLabel} onClick={this.toggleDeselectAfterFill}>自动删选区</span>
                        <ToggleSwitch checked={this.state.deselectAfterFill} onChange={this.toggleDeselectAfterFill} title={helpTexts.selectionFill.deselectInput} />
                    </div>
                    <div className="row-between">
                        <span className="label-5" title={helpTexts.selectionFill.historyLabel} onClick={this.toggleAutoUpdateHistory}>更新历史源</span>
                        <ToggleSwitch checked={this.state.autoUpdateHistory} onChange={this.toggleAutoUpdateHistory} title={helpTexts.selectionFill.historyInput} />
                    </div>
                    <div className="row-between">
                        <span className="label-5" title={helpTexts.selectionFill.autoOffLabel} onClick={this.toggleAutoOffOnOtherTool}>自动关开关</span>
                        <ToggleSwitch checked={this.state.autoOffOnOtherTool} onChange={this.toggleAutoOffOnOtherTool} title={helpTexts.selectionFill.autoOffInput} />
                    </div>
                    <div className="row-between">
                        <span className="label-5" title={helpTexts.selectionFill.lassoLabel} onClick={this.toggleSwitchToLassoOnEnable}>自动切套索</span>
                        <ToggleSwitch checked={this.state.switchToLassoOnEnable} onChange={this.toggleSwitchToLassoOnEnable} title={helpTexts.selectionFill.lassoInput} />
                    </div>
                </div>
            </>
        );
    }

    /** 「显示公式」开关（四处各自独立；随面板状态持久化） */
    setFormulaVisible(scope: FormulaScope, visible: boolean) {
        this.setState(prev => ({
            formulaVisible: { ...prev.formulaVisible, [scope]: visible },
        }));
    }

    /** 纯色面板「计算方法」的公式条显隐（= setFormulaVisible('color', …)，独立引用便于传给子面板） */
    setColorFormulaVisible(visible: boolean) {
        this.setFormulaVisible('color', visible);
    }

    /** 切换某个分区的可见性（选区平滑 / 选区改造 / 填充选项）。 */
    toggleSectionVisibility(id: 'smoothOptions' | 'selectionOptions' | 'fillOptions') {
        this.setState(prev => ({
            smoothOptionsVisible: id === 'smoothOptions' ? !prev.smoothOptionsVisible : prev.smoothOptionsVisible,
            selectionOptionsVisible: id === 'selectionOptions' ? !prev.selectionOptionsVisible : prev.selectionOptionsVisible,
            fillOptionsVisible: id === 'fillOptions' ? !prev.fillOptionsVisible : prev.fillOptionsVisible,
        }));
    }

    toggleStrokeEnabled() {
        this.setState({ strokeEnabled: !this.state.strokeEnabled });
    }

    /**
     * 多边形吸附开关。
     * ⚠️ setState 与下发**必须同拍**：这个开关没有回读通道（原生侧不回传该值），
     *    所以界面上的勾选态就是唯一真相；只要漏发一次，界面开着、实际不吸。
     * ⚠️ 未连接也照发：SmoothBridge 的 `send()` 在没连上时会静默丢弃，
     *    建连后 resendLassoSmoothing 会重放模块里的 polySnapOn（见 LassoSmoothing）。
     */
    togglePolySnap() {
        const next = !this.state.polySnapEnabled;
        this.setState({ polySnapEnabled: next });
        try { setPolySnapEnabled(next); } catch { /* ignore */ }
        /* 0x0223：吸附开关决定「工具闸门巡检要不要自建」—— 平滑关着时它是闸门的
           **唯一**来源，所以必须在这里立刻启停，不能等下一帧状态回报。 */
        this.syncSmoothToolWatch();
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

    /**
     * 混合模式热键命中（BlendModeBus 送达）：把 APP 面板「选区填充」的混合模式
     * 改成目标模式。载荷是 PS 枚举值（normal/darken/…），面板内部一律用中文名
     * （constants/blendModes.ts），因此先反查；反查不到（表外模式）时忽略本次命中，
     * 绝不把 undefined 写进 state（那会让下拉显示空白、填充描述符拿到 "normal" 兜底）。
     */
    applyBlendModeHotkey(mode: string) {
        // 反查统一走 constants/blendModes 的 blendModeLabel（大小写不敏感、单一映射来源）；
        // 查不到 = 表外模式 ⇒ 忽略，绝不把 undefined 写进 state。
        const cn = blendModeLabel(mode);
        if (!cn) {
            console.warn('⚠️ 混合模式热键：未知模式 ' + mode + '，已忽略');
            return;
        }
        if (this.state.blendMode !== cn) this.setState({ blendMode: cn });
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
        this.setSecondaryPanel('stroke', true);
    }

    toggleColorSettings() {
        this.setSecondaryPanel('color', !this.state.isColorSettingsOpen);
    }

    /**
     * 子面板互斥（铁律，2026-10-10 用户要求）：
     * 同一父面板**同时只允许一个子面板**，打开新的即顶掉先前打开的。
     *
     * ⚠️ 必须写成「一次 setState 全量设定 5 个布尔量」而不是各写各的 true：
     *    旧写法（每个入口只置自己 true）会让纯色 + 图案 + 描边同时挂在面板上，
     *    而子面板都是 absolute 铺满父面板、z-index 同为 9999 ⇒ 只能看到最后渲染的那个，
     *    关掉它以后下面的又露出来，用户以为「点关闭没关干净」。
     * ⚠️ 数字遮挡（body.secondary-panel-open）由 componentDidUpdate 按这 5 个布尔量派生，
     *    所以「顶掉」与「新开的面板遮住父面板数字」两件事自动一致。
     */
    private setSecondaryPanel(id: 'color' | 'pattern' | 'gradient' | 'stroke' | 'clear', open: boolean) {
        this.setState({
            isColorSettingsOpen: id === 'color' ? open : false,
            isPatternPickerOpen: id === 'pattern' ? open : false,
            isGradientPickerOpen: id === 'gradient' ? open : false,
            isStrokeSettingOpen: id === 'stroke' ? open : false,
            isClearSettingOpen: id === 'clear' ? open : false,
        });
    }

    /**
     * 「切换填充模式」热键（默认 Ctrl+滚轮）：按方向在 纯色 → 图案 → 渐变 之间前进/后退一格。
     *
     * ⛔ 只改 fillMode（三行 radio 的选中项），**不**顺手打开对应的子面板：
     *    滚轮是连续动作，每滚一格弹一个子面板 = 面板不停闪；要改参数时点那一行的齿轮即可。
     * ⛔ 顺序必须与界面上三行的显示顺序一致（纯色 → 图案 → 渐变）。
     *    方向口径（2026-11-16 用户要求反向）：**滚轮往后转（向下）**= 纯色→图案→渐变，
     *    往上滚 = 往回退一格。符号换算只在 HotkeyBridge 的 fillModeCycle 分支里做一处。
     * ⚠️ 反馈在这里发而不是在键触发的回调里：只有这里知道「切到了哪一个」。
     */
    cycleFillMode(dir: FillModeDir) {
        const order: Array<'foreground' | 'pattern' | 'gradient'> = ['foreground', 'pattern', 'gradient'];
        const cur = this.state.fillMode;
        const i = order.indexOf(cur);
        const next = order[((i < 0 ? 0 : i) + (dir < 0 ? order.length - 1 : 1)) % order.length];
        if (next === cur) return;
        this.setState({ fillMode: next });
        this.showAppHotkeyNotify('热键触发：填充模式 → ' + App.fillModeLabel(next), true);
    }

    /** 填充模式 → 界面文案（与三行 radio 的 label 同源口径）。 */
    private static fillModeLabel(mode: 'foreground' | 'pattern' | 'gradient'): string {
        return mode === 'pattern' ? '图案' : mode === 'gradient' ? '渐变' : '纯色';
    }

    openPatternPicker() {
        this.setSecondaryPanel('pattern', true);
    }

    openGradientPicker() {
        this.setSecondaryPanel('gradient', true);
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
        this.setSecondaryPanel('clear', true);
    }

    closeClearSetting() {
        this.setState({ isClearSettingOpen: false });
    }

    /**
     * 选区变化的**沉降式**调度：把连续到来的选区 set 事件合并成一次填充。
     *
     * 语义（尾沿 debounce）：每个新事件都把窗口整体后移 SELECTION_SETTLE_MS；
     * 只有连续 120ms 没有新事件才真正触发 handleSelectionChange。
     * 触发时带上**最后一个**事件的 descriptor（feather 跳过语义不丢）。
     *
     * ⚠️ 填充结束后的 pendingSelection 补跑也走本方法（见 handleSelectionChange 的
     *    finally）：若那条路绕过沉降窗立即重入，「填充⇒事件⇒再填充」的自激循环
     *    会把本修复整体作废。
     */
    scheduleSelectionFill(event?: any) {
        this.lastSelectionEvent = event;
        if (this.selectionSettleTimer) clearTimeout(this.selectionSettleTimer);
        this.selectionSettleTimer = setTimeout(() => {
            this.selectionSettleTimer = null;
            const ev = this.lastSelectionEvent;
            this.lastSelectionEvent = undefined;
            if (this.state.isEnabled) {
                this.handleSelectionChange(ev);
            }
        }, SELECTION_SETTLE_MS);
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
            if (this.selectionRetryTimer) clearTimeout(this.selectionRetryTimer);
            // ⚠️ 事件对象要一并带过去：否则 feather 事件的「跳过」语义会丢失，
            // 可能对无意义的羽化事件也跑一次填充。
            this.selectionRetryTimer = setTimeout(() => {
                this.selectionRetryTimer = null;
                void this.handleSelectionChange(event);
            }, fillWait);
            return;
        }

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
                // ⚠️ 同样走沉降窗（2026-10-14）：旧实现这里 setTimeout(0) 立即重入，
                // 填充一结束就补跑，拉绳拖动时等于「一次填充⇒一次事件⇒再一次填充」
                // 的自激循环 —— 用户报的「画个小选区产生大量 modal scope」正源之一。
                this.scheduleSelectionFill();
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

    /**
     * 「特殊蒙版」开关。
     *
     * 语义：填充只落在当前图层**已有像素**的范围内，且不改动这些像素的 alpha。
     * 纯色 / 图案 / 渐变三种模式共用这一个开关（2026-11-19 从两个子面板收口过来）。
     */
    toggleSpecialMask() {
        this.setState(prevState => ({ specialMask: !prevState.specialMask }));
    }

    /**
     * 「特殊蒙版」的禁用条件（两套版式共用，唯一事实来源）。
     *
     * 与「新建图层」的禁用条件**完全同构**：这四种场合下填充的目标根本不是
     * 「像素图层的已有像素」，谈「保留已有像素」没有意义 ——
     *   · 清除模式：清除是减淡/趋白，不是上色；
     *   · 快速蒙版 / 图层蒙版：填充落在通道上（灰度），没有 alpha 可言；
     *   · 单通道：填充写回单色通道，同样没有 alpha。
     * ⚠️ 保留「是像素层 / 有没有像素」这类**逐次判定**不放在这里：
     *    那取决于当前活动图层，菜单状态下读不到，且填充分支自己会再判一次。
     */
    isSpecialMaskDisabled() {
        return this.isCreateNewLayerDisabled();
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

            /* 「特殊蒙版」的**基底图层 id**：新建图层会把活动目标换人，而纯色模式的
               收尾（把新层剪贴到下方原图层）要用它 ⇒ 必须在 make layer 之前记下。
               ⚠️ 下文那段 `layerInfo = {...}` 会把 layerId 覆盖成新层 id。 */
            const specialMaskBaseId = layerInfo.layerId;

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

                // ⚠️ 目标图层已经换人，下游读的是这个局部变量（非像素层拦截 / hasPixels
                //    分支 / 特殊剪贴蒙版的基底 id 都以它为准）。不同步的话，在文字层上开着
                //    「新建图层」填充会被误判成「目标是文字层」而挡掉。
                //    新建的是空白像素层 ⇒ 这些字段直接按事实覆盖（背景 / 透明锁 / 隐藏
                //    都是**旧图层**的属性，留在新层上会让后续分支判错）。
                // ⚠️ 新层可能被 PS 自动塞进剪贴组（目标层是剪贴基底时）—— 那是 PS 的
                //    原生放置语义，**不改动它**：PS 里没有任何「只释放这一层」的命令，
                //    `ungroup` / `Layer.isClippingMask = false` 都会把这组里**上方所有**
                //    剪贴层一起释放（UXP 文档原文：Releasing a clipping mask will also
                //    release the layers above；用户 2026-11-19 实测：三个箭头全没）。
                //    这里只把**真实状态**记进 layerInfo，别让下游以为它是个独立层。
                const newLayerClip = readActiveLayerClipState();

                layerInfo = {
                    ...layerInfo,
                    layerKind: 'pixel',
                    hasPixels: false,
                    isBackground: false,
                    hasTransparencyLocked: false,
                    isHidden: false,
                    isClippingMask: newLayerClip.isClippingMask,
                    blendMode: BLEND_MODES[this.state.blendMode] || 'normal',
                    layerId: app.activeDocument.activeLayers[0]?.id ?? layerInfo.layerId,
                };
            }

            const { isBackground, hasTransparencyLocked, hasPixels } = layerInfo;

            /* 「特殊蒙版」——2026-11-19 从图案 / 渐变两个子面板收口到本面板的全局开关，
               三种填充模式共用。语义一句话：**填充只落在当前图层已有像素上，且不改它的 alpha。**
               ⚠️ 这里要再判一次禁用条件：界面置灰只是提示，state 仍可能被复位/热键改到；
                  而清除模式 / 快速蒙版 / 图层蒙版 / 单通道下，填充目标根本不是像素图层的像素。
               ⚠️ 用 fillState 里的值（调用方可能传了一份改写过的 state 副本）。 */
            const specialMaskOn = !!fillState.specialMask && !this.isSpecialMaskDisabled();

            if (this.state.fillMode === 'pattern') {
                if (this.state.selectedPattern) {
                    await PatternFill.fillPattern({
                        opacity: this.state.opacity,
                        blendMode: this.state.blendMode,
                        pattern: this.state.selectedPattern,
                        // ⚠️ 不再读预设里的 preserveTransparency：那个字段只是旧版遗留，
                        //    开关已经收口到 APP 面板，读它会出现「面板上关着、填充却按开执行」。
                        preserveTransparency: specialMaskOn
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
                        preserveTransparency: specialMaskOn
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
                    color: finalColor,
                    /* 特殊蒙版（纯色）：等价于 PS 原生「保留透明像素」的填充 ——
                       只改已有像素的 RGB，alpha 一个字节不动。
                       判据与渐变/图案那条 `useSpecialClip = hasPixels && 特殊蒙版` 对齐：
                         · 空像素图层没有像素可保留 ⇒ 语义上就是普通填充（「新建图层」建出来的
                           正是这种层，它的剪贴需求由下面那段 clipNewLayerToBase 承担）；
                         · 背景层没有 alpha，「保留透明像素」在 PS 里本来就是灰的 ⇒ 排除；
                         · 文字 / 智能对象等非像素层不允许保留透明像素 ⇒ 退回普通填充。
                           （渐变/图案那边必须挡非像素层，是因为它们的收尾会 `rasterizeLayer`
                             把内容就地替换；纯色这里只是一条 fill，挡掉反而会变成功能回归。） */
                    preserveTransparency: specialMaskOn
                        && !this.state.createNewLayer
                        && !!hasPixels
                        && !isBackground
                        && !isNonPixelLayerKind(layerInfo.layerKind)
                };

    
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

                /* 特殊蒙版 + 新建图层（纯色）：新层是空的，「保留透明像素」填不出内容，
                   所以改成「填完之后把这一层剪贴到下方原图层上」—— 与渐变/图案的同名
                   分支视觉等价（它们建的是 PS 原生剪贴蒙版，再按需收窄）。
                   ⚠️ 放进 try 里：剪贴失败不能连累已经成功的填充（fillSelection 的
                      catch 会整段判失败并返回 false）。 */
                if (specialMaskOn && this.state.createNewLayer && specialMaskBaseId) {
                    await this.clipNewLayerToBase(specialMaskBaseId);
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

    /**
     * 纯色「特殊蒙版 + 新建图层」的收尾：把刚填好的新层剪贴到下方原图层上。
     *
     * 为什么需要这一步：纯色的特殊蒙版走的是 PS 原生「保留透明像素」，而新建图层是**空白**的
     * ⇒ 一个像素都没有可保留，填出来就是空的。渐变/图案的做法是建内容层后再决定
     * 「原生剪贴 / 按基底 alpha 收窄」，这里把同一套语义搬过来：
     *   ① 优先 PS 原生「创建剪贴蒙版」（快、基底可以是文字层/智能对象等任意类型）；
     *   ② 新层若是被 PS 自动塞进目标的剪贴组（`isClippingMask === true`），本来就已经剪贴了，
     *      不再重复下发 —— 对已剪贴的层再建剪贴会被宿主拒绝并弹原生报错框；
     *   ③ 原生被拒（基底本身是别人的剪贴蒙版）时，按基底 alpha 收窄新层的 alpha。
     *
     * ⚠️ 失败一律只告警：填充本身已经完成，不能因为这个收尾把整次填充判死。
     */
    private async clipNewLayerToBase(baseLayerId: number) {
        try {
            const topId = await resolveActiveLayerId();
            if (!topId || topId === baseLayerId) return;
            const nativeOk = readActiveLayerClipState().isClippingMask
                || await tryCreateNativeClippingMask();
            if (nativeOk) return;
            await multiplyTopAlphaByBase({
                docId: app.activeDocument.id,
                baseLayerId,
                topLayerId: topId,
            });
        } catch (e) {
            console.warn('⚠️ 特殊蒙版：新建图层剪贴到下方图层失败（填充结果保持原样）:', e);
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
            // 平滑参数嵌在 state.smoothParams 里，取不到 `this.state[target]` ⇒ 按前缀分岔取值。
            // 前缀口径必须与 DragHandler 的 configs 键名、handleMouseMove 的分岔保持一致。
            dragStartValue: App.isSmoothDragTarget(target)
                ? (this.state.smoothParams as any)[target.slice(7)]
                : this.state[target],
            dragTarget: target
        });
    }

    /** `smooth:` 前缀 = 「值在 state.smoothParams 内」的拖拽目标（见 DragHandler 的键名注释）。 */
    private static isSmoothDragTarget(target: string): boolean {
        return typeof target === 'string' && target.indexOf('smooth:') === 0;
    }

    // 处理鼠标移动事件
    handleMouseMove(event: MouseEvent): void {
        if (!this.state || !this.state.isDragging || !this.state.dragTarget) return;

        const target = this.state.dragTarget;
        const newValue = DragHandler.calculateNewValue(
            target,
            this.state.dragStartValue,
            this.state.dragStartX,
            event.clientX
        );

        if (App.isSmoothDragTarget(target)) {
            // 走 updateSmoothParam：它会整体替换对象、并顺带把新参数下发给平滑模块
            // （直接 setState 会漏掉下发，表现为「拖了标签、数值变了但手感没变」）。
            this.updateSmoothParam({ [target.slice(7)]: newValue } as Partial<LassoSmoothParams>);
            return;
        }

        this.setState({ [target]: newValue });
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
        // ⛔ 历史记录艺术画笔的真实工具 ID 是 artBrushTool（2026-10-30 Alchemist 现场核对），
        //    不是 artHistoryBrushTool —— 后者 PS 从不返回，列在这里等于一条死条目。
        'artBrushTool',             // 历史记录艺术画笔
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
        /* ⛔⛔ 2026-11-16：本模块自己刚切过工具（Shift+H / M / Shift+M）时，
           这里的两条「顺手切工具」一律跳过 —— 否则它们会把用户刚按出来的工具拽走：
             · 关→开 + 自动切套索 ⇒ 切回套索（会抢走 Shift+H 刚切到的选框）；
             · 开→关 + 停在多边/磁性套索 ⇒ 切回套索（会抢走 M / Shift+M 刚切到的选框）。
           两者服务的是 H 键与「用鼠标换工具」的原生场景，不该覆盖显式工具键。
           抑制位是 1.5s 时窗（不是布尔位：布尔位漏清就永久失效）。 */
        const selfSwitched = hotkeyToolSwitchRecent();
        if (nextEnabled && !prevEnabled && this.state.switchToLassoOnEnable) {
            if (selfSwitched) {
                console.log('[主开关] 开启：本次由工具键发起（已自行切工具）⇒ 不抢切套索');
                return;
            }
            await this.selectLassoTool();
            return;
        }
        /* ⭐ 2026-11-16（用户要求）：**关闭**总开关这一拍，如果当前停在多边形/磁性套索，
           顺手切回普通套索。
           为什么：这两个子工具是「点击落点」式，自动填充在它们上面没有意义；用户按 H
           的意图就是「收工」，停在多边形套索里下次要画还得手动切回来。
           ⛔ 只在「从开→关」这一拍做：开机（关→开）不做任何工具动作，免得把用户特意
              选好的子工具改掉 —— 开机切套索另有 `switchToLassoOnEnable` 那条既有逻辑。
           ⛔ 判据用 `currentToolGuess()`（巡检基准 / 'slct' 上报），读不到就**不动**：
              不知道当前工具时乱切一次会吞掉用户下一笔（见 reselectLassoIfStrayed 的说明）。 */
        if (!nextEnabled && prevEnabled && App.isSubLassoTool(this.currentToolGuess())) {
            if (selfSwitched) {
                console.log('[主开关] 关闭：本次由工具键发起（已自行切工具）⇒ 不抢切套索');
                return;
            }
            console.log('[主开关] 关闭时当前是「' + App.toolRefLabel(this.currentToolGuess()) + '」⇒ 切回套索工具');
            await this.selectLassoTool();
        }
    }

    /**
     * 0x0209 / 0x0210：临时吸管按住键的边沿 → 工具模式下的「临时吸管」。
     *
     * 需求（用户原话）：「仅当我处于工具模式下，当前工具是套索，且总开关是开时，
     * 按临时吸管键能够临时切换为吸管工具……松开后会自动变回套索工具，总开关是开的状态。」
     *
     * ⛔ 0x0210：键源从物理 Alt 换成配置里的独立键（默认 `/`）。
     *    原因是套索工具下按 Alt 是 PS 原生的「临时切多边形套索」——同一个键被两个功能
     *    抢，按下去两个都动。用户可在「功能快捷键」子面板重录该键（见 HotkeyBridge 的 altTool）。
     *
     * 三个前置条件缺一不可（按顺序判，最便宜的先判）：
     *   ① `isFocusMode()` —— 「自动关开关」+「自动切套索」同时勾选；
     *   ② `state.isEnabled` —— 总开关开；
     *   ③ 当前工具是套索 —— 用 `lastKnownTool`（「自动关」巡检维护的基准），
     *      退而用进程内 `'slct'` 报来的 `psTool`。两者都没有 ⇒ **不响应**（保守：
     *      不知道就不要动用户的工具）。
     *
     * ⛔ 为什么切吸管期间要把 `altToolHold` 立起来：它挡掉「切到其它工具自动关」的
     *    两条通路（select 通知 + 1s 巡检）。吸管本来不在 AUTO_OFF_TOOLS 名单里，
     *    但这里不能依赖名单 —— 名单是产品决策、随时可能变，而本需求的契约是
     *    「松开后总开关必须是开的」。
     * ⛔ 松开后还做一次「总开关兜底」：万一期间被别处关掉（旧版 .8li 的通知、
     *    别的面板写共享状态），这里把它拨回开 —— 这是需求字面要求的最终状态。
     * ⛔ 切回套索后**乐观喂一次闸门**：正常路径下工具闸门要等下一次巡检（≤1s）才回绿，
     *    用户「松开后立刻接着画」会感觉平滑失效 1 秒。刚执行过 select lassoTool，
     *    事实成立，直接喂 1 是安全的（`applyToolGate` 内部在 slct 接管时会自动让位）。
     */
    private async handleAltHoldEdge(on: boolean) {
        if (on) {
            if (this.altToolHold) return;
            if (!this.isFocusMode()) return;
            if (!this.state.isEnabled) return;
            const tool = this.lastKnownTool || this.state.smoothStatus?.pen?.psTool || null;
            if (!tool || !App.isLassoTool(tool)) return;
            this.altToolHold = true;
            console.log('[临时吸管] 按住键按下 ⇒ 切吸管（工具模式 · 套索 · 总开关开）');
            /* —— 0x020A ①②：先竖否决位、再切工具 ——
               ⛔ 顺序不能反：切工具要过一次 batchPlay（几十~几百 ms），这段时间里
                  工具还是套索、工具闸门还是 1（'slct' 回调还没来），用户若立刻按笔
                  吸色 ⇒ 引擎照常改写坐标并显示 HUD（用户报的两条）。
                  否决位是一帧 WS（毫秒级），引擎读到就立刻停改写/停 HUD。 */
            setAltToolOverride(true);
            this.applyToolGate('eyedropperTool', true);
            /* 记下「进吸管之前」的背景色（同步属性读，不需要模态）。用途见
               syncAltPickColor：PS 把 Alt+点击 解释为取背景色，我们事后搬到前景。
               ⛔ 0x0210：只有**触发键里含 Alt** 时才需要这一手。默认键 `/` 不含 Alt
                  ⇒ PS 的吸管单击本来就取前景色，搬色纯属多余（还会插一次模态抢宿主
                  主线程）。判据来自配置，不是猜的。 */
            this.altPickBg = altToolComboHasAlt() ? App.snapshotBackgroundColor() : null;
            this.altPickUntil = 0;                 // 吸管期内不限时
            if (this.altPickClearTimer) {
                clearTimeout(this.altPickClearTimer);
                this.altPickClearTimer = null;
            }
            await selectToolByRef('eyedropperTool');
            return;
        }
        if (!this.altToolHold) return;
        this.altToolHold = false;
        console.log('[临时吸管] 按住键松开 ⇒ 切回套索');
        await selectToolByRef('lassoTool');
        this.noteRealTool('lassoTool');
        /* 乐观回绿：**必须 force** —— 平时 `applyToolGate` 在 'slct' 接管时直接 return，
           而回调要等 PS 派发通知；不 force 的话用户松开后立刻画会卡 ~1 秒。 */
        this.applyToolGate('lassoTool', true);
        /* ⛔ 否决位放在最后清：上面两步跑完之前，工具可能还是吸管，
           提前解否决就等于允许引擎改写「吸管上的笔」的坐标。 */
        setAltToolOverride(false);
        /* ⛔⛔ 松开**不能**立刻丢掉背景色快照：最常见的操作是「吸色 → 顺手松开」——
           `hostBusy` 的 release 边沿可能比按住键的 release 边沿晚到几十毫秒，
           立刻清快照就等于把这一次取色丢掉（用户看到「背景色被改了、前景色没变」，
           正是本轮要修的现象）。⇒ 给 800ms 宽限，最后一次取色仍能完成。
           （键不含 Alt 时 altPickBg 恒为 null ⇒ syncAltPickColor 首行就返回。） */
        this.armAltPickExpiry();
        if (!this.state.isEnabled) {
            try {
                await setMainToggle(true);
            } catch (e) {
                console.warn('⚠️ 临时吸管：恢复主开关失败:', e);
            }
        }
    }

    /** 0x020A：松开临时吸管键后给最后一次取色留一段宽限，到点清空快照。
     *  ⛔ 取 400ms 而不是更长：这段窗口内若又触发一次「取色收尾」，会插一次模态。
     *     窗口越长，「用户已经回到套索开始画」被插一次模态的概率越大
     *     （那正是 0x0208 修的「模态抢占打断绘制」）。主流程里 `hostBusy` 的松开
     *     边沿**早于**按住键的松开边沿（抬笔必然在松键之前），所以正常路径
     *     根本不依赖这段宽限，它只兜「先松键后抬笔」这种少数情况。
     *  ⛔ 0x0210：键不含 Alt 时 `altPickBg` 从未被赋值 ⇒ 这段宽限空转，无害。 */
    private armAltPickExpiry() {
        this.altPickUntil = Date.now() + 400;
        if (this.altPickClearTimer) clearTimeout(this.altPickClearTimer);
        this.altPickClearTimer = setTimeout(() => {
            this.altPickClearTimer = null;
            if (this.altToolHold) return;          // 期间又按住了 ⇒ 保留
            this.altPickBg = null;
            this.altPickUntil = 0;
        }, 400);
    }

    /** 读背景色的快照（rgba 三元组 + 原对象）。失败返回 null（功能静默降级）。 */
    private static snapshotBackgroundColor(): { r: number; g: number; b: number; solid: any } | null {
        try {
            const c: any = (app as any).backgroundColor;
            const rgb = c && c.rgb;
            if (!rgb) return null;
            return { r: rgb.red, g: rgb.green, b: rgb.blue, solid: c };
        } catch {
            return null;
        }
    }

    /**
     * 0x020A：把「Alt+点击 吸到的背景色」搬到前景色，并把背景色复原。
     *
     * ⛔⛔ 为什么不按用户的设想「让 Alt 绕过 PS」（**已评估，技术上不可行**）：
     *   PS 判定「Alt+点击 = 取背景色」读的是**它自己线程的键盘状态**。要让它读不到
     *   Alt，只有两条路，两条都被否决：
     *     ① 在 Alt 按下那一刻**吞掉**按键（LL 键盘钩子返回 1）——
     *        铁律 40 已实测：PS 前台时我们装的低层键盘钩子**整段收不到键**
     *        （PS 自己的键盘钩子压在链前，而钩子链顺序不可控）⇒ 会出现
     *        「有时吞、有时不吞」，同一操作两种结果，比不吞更糟；
     *     ② 事后伪造 `WM_SYSKEYUP` 改 PS 线程键态 —— 跨进程伪造键盘状态，
     *        一旦 PS 的处理逻辑与预期不符，后果是**全局快捷键错乱**，
     *        与需求里「不影响正常吸管工具和其他快捷键逻辑」直接冲突。
     *   ⇒ 改用**确定性的事后纠正**：PS 按它自己的规则改背景色，我们在「一次取色
     *     结束」（左键/笔松开边沿）后读回那个颜色写入前景，再把背景复原。
     *     代价是一次模态（~50ms）+ 吸色期间背景色会短暂变化；
     *     收益是**零键盘风险**，且失败可见（不动就什么都不改）。
     *
     * ⛔ 只在 `altToolHold` 期间生效（**且**触发键含 Alt 才会拍过快照）⇒
     *    正常吸管工具（不按临时吸管键）完全不受影响。
     *
     * ⛔⛔ 0x020B：**不能再拿「背景色变了没有」当「有没有取色」的判据**（用户报的 bug：
     *   前景色任意非白 + 背景色为白 + 吸白色 ⇒ 前景色毫无变化）。
     *   链条：`bgOld`（进吸管前的背景色）与 `bgNow`（点完之后读回）都是白 ⇒ 旧代码
     *   认为「颜色没变 = 这一次没真的取色」⇒ 直接 return ⇒ 前景永远不动。
     *   而「吸到的颜色恰好等于原背景色」与「压根没吸」这两种事实，**在颜色上是
     *   完全无法区分的**（PS 把同样的值再写一遍，等于没写）。
     *   ⇒ 判据换成**输入事实**：这一次按下-松开里有没有真按过左键
     *     （`hadLeftBtn`，来自原生 hostBusy 的 `btn` 字段）。
     *     有左键 ⇒ 用户在画布上点了一下，按 Alt 的语义就是取色 ⇒ 一律搬运，
     *     颜色相同也搬运（同色时搬运是幂等的：前景 ← 当前背景色）。
     *     只有空格 ⇒ 那是 PS 的抓手/缩放导航，绝不当取色。
     *   ⚠️ 代价（刻意接受）：点在画布外（工具栏/面板）时 PS 不会取色，我们仍会把
     *     当前背景色搬成前景色。这比「吸了色却没反应」轻得多 —— 后者是主流程被破坏。
     */
    private async syncAltPickColor(hadLeftBtn: boolean = true) {
        const bgOld = this.altPickBg;
        if (!bgOld) return;
        /* 0x020B：这一轮只有空格（没有左键）⇒ 不是取色点击，直接放行。
           ⛔ 缺省 true：旧版 .8li 不推 btn 字段时保持 0x020A 的行为。 */
        if (!hadLeftBtn) {
            console.log('[临时吸管] 松开边沿无左键（空格导航）⇒ 不当作取色');
            return;
        }
        /* 只允许两种情况响应：① 此刻仍在临时吸管态；② 刚松开 Alt 的 800ms 宽限内
           （「吸色 → 顺手松 Alt」是主流程，release 边沿的两个来源先后不定）。
           ⛔ 没有这一层，用户回到套索后的任意一次点击都会走到下面，
              把「当时的背景色」误搬成前景色。 */
        const inWindow = this.altToolHold
            || (this.altPickUntil > 0 && Date.now() <= this.altPickUntil);
        if (!inWindow) return;
        /* 让 PS 把「取色」处理完：它在 mouse down 时取色，但笔的 up 与 PS 的
           内部收尾之间有几十毫秒。80ms 是实测手感与准确性的折中（不阻塞主线程）。 */
        await new Promise<void>((r) => setTimeout(r, 80));
        const bgNow = App.snapshotBackgroundColor();
        if (!bgNow) return;
        /* 观察用：颜色是否变化（只写日志，**不再**决定要不要搬运）。 */
        const same = bgNow.r === bgOld.r && bgNow.g === bgOld.g && bgNow.b === bgOld.b;
        try {
            await runAsModal(async () => {
                /* 前景 = 此刻的背景色（= PS 刚吸到的那个颜色）；
                   背景 = 进吸管之前记下的原色（复原）。
                   ⛔ 两次都赋 SolidColor **对象**，不走 batchPlay —— 颜色对象是值对象，
                   赋值不会失败，也就不存在「失败的 batchPlay 在 PS 里画一条黄条」的风险。
                   ⛔ 顺序不能反：`bgNow.solid` 与 `bgOld.solid` 是两个不同快照，但先写
                   前景再复原背景，即使将来某个 PS 版本让它们共享引用，前景也已落盘。 */
                (app as any).foregroundColor = bgNow.solid;
                if (!same) (app as any).backgroundColor = bgOld.solid;
            }, { commandName: '临时吸管·取前景色' });
            console.log(same
                ? '[临时吸管] 取色 → 前景色已更新（吸到的颜色与原背景色相同，背景无需复原）'
                : '[临时吸管] 取色 → 前景色已更新，背景色已复原');
        } catch (e) {
            console.warn('⚠️ 临时吸管：搬运取色结果失败:', e);
        }
    }

    // 自动切换为套索工具（主开关关闭→开启时）
    // 复用 HotkeyBridge.applyBrush 已验证的切工具写法：先直连 batchPlay，
    // 失败（某些 PS 版本/状态下要求模态作用域）再回退 executeAsModal。
    private async selectLassoTool(): Promise<boolean> {
        const descriptor: any = {
            _obj: 'select',
            _target: [{ _ref: 'lassoTool' }],
            dontRecord: true,
            forceNotify: true,
            _isCommand: false
        };
        let switched = false;
        try {
            await action.batchPlay([descriptor], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
            switched = true;
        } catch (directErr) {
            // 直连失败 → 回退模态作用域（与 applyBrush 一致）
            try {
                await runAsModal(async () => {
                    await action.batchPlay([descriptor], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
                }, { commandName: '切换套索工具' });
                switched = true;
            } catch (e) {
                console.warn('⚠️ 自动切换套索工具失败（主开关开启时）:', e);
            }
        }
        /* ⛔ 只有真的切过去才同步基准与 Shift+L 游标：失败时工具仍在原处，
           若照样把基准写成 lassoTool，后续所有「当前是不是套索」的判据都会对着
           一个不存在的现实做决定（H 键退回套索这条尤其会被带偏）。 */
        if (switched) this.noteRealTool('lassoTool');
        return switched;
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
    // 所以主开关开启期间按固定间隔轮询当前工具，只在「工具真的变了」时判定。
    //
    // ⛔⛔ 2026-10-13：300ms → **1000ms**（性能根因）。
    //    UXP 侧每次读取都要抢一个模态作用域，而 `psAccess` 有**全局**节流
    //    `MIN_MODAL_GAP_MS = 300` ⇒ 模态命令的**吞吐上限就是 3.3 次/秒**。
    //    而空闲态同时常驻的巡检是：工具 300ms(3.3/s) + 快速蒙版 300ms(3.3/s)
    //    + 文档身份 500ms(2/s) ≈ **8.7 次/秒** ⇒ 每秒净积压 ~5 个请求。
    //    结果就是用户看到的：`Too many modal scope commands` 编号持续攀升、
    //    `Large number of pending promises: 40`（约 7 秒即可堆到 40），
    //    以及「生成选区后 PS 频繁读条等『获取当前工具』」——那条读条就是本巡检
    //    排在模态队列里发不出去的请求。
    //    ⇒ 把三个巡检的总请求率压到节流吞吐之下（本项 1/s + 快速蒙版 1/s +
    //      文档 0.5/s = 2.5 次/秒 < 3.3），队列不再增长。
    //    ⚠️ 代价：切工具后闸门最坏 1s 才更新（此前 0.3s）。这是刻意的取舍 ——
    //      读条阻塞填充是常态痛点，而 1s 的闸门滞后只在「刚切走套索就又落笔」时可见。
    private static readonly TOOL_WATCH_INTERVAL_MS = 1000;

    /**
     * 平滑模块（.8li）连接**瞬断宽限**（毫秒）。
     *
     * ⛔⛔ 2026-10-19（用户报「套索平滑开关偶尔自动变成服务未启动状态，几秒后复原」）：
     *    WS 对端是 PS 进程内的 .8li，宿主忙碌/重连窗口内 onclose → 1.5s 后重连是
     *    **正常现象**。旧实现 connected 一翻 false，状态条立刻闪「服务未启动」、
     *    开关（旧判据含 connected）也跟着翻到关位 —— 用户什么都没做，界面自己跳。
     *    现在：开关位置与意图脱钩（永不动）；状态条文案在本宽限内**保持上一状态**
     *    （用最后一帧的 pen 数据继续判定），超过宽限仍断着才如实说「服务未启动」。
     *    取值 2500ms > SmoothBridge 的 1500ms 重试间隔 ⇒ 单次重连周期内不闪。
     *    ⚠️ 冷启动（从未连上过）不走宽限：第一时间就说「服务未启动」，
     *    那是「.8li 没装/没就绪」的真实提示，不该延迟。
     */
    private static readonly SMOOTH_DISCONNECT_GRACE_MS = 2500;

    /**
     * 按 H（主开关热键）时仍需「回到普通套索」的四个选区工具（2026-11-16 用户要求）：
     * 多边形套索 / 磁性套索 / 矩形选框 / 椭圆选框。
     *
     * 用途只有一处 —— 工具模式下 H 是「只开不关」，开着时按 H 不产生状态翻转，
     * 因此要靠这张名单判断「现在停在一个不是普通套索的选区工具上，要不要拉回来」。
     * ⛔ 名单必须与 HotkeyBridge 的 `FILL_TOOL_GROUP` 保持一致（同一组五个工具，
     *    去掉第一个 lassoTool）。⛔ 只收这四个：画笔等「其它工具」在名单外，
     *    因为那时「自动关」早已把总开关关掉，走的是另一条（关→开）路径。
     */
    private static readonly LASSO_RETURN_TOOLS = [
        'polySelTool',          // 多边形套索
        'magneticLassoTool',    // 磁性套索
        'marqueeRectTool',      // 矩形选框
        'marqueeEllipTool',     // 椭圆选框
    ];

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
            // ⛔ 兜底同样要走形态归一：`app.currentTool` 可能是裸串、也可能是带 id 的对象。
            return normalizeToolId(cur);
        }, { label: '读取当前工具', retries: 0 });
    }

    // 按「需要自动关 / 需要混合模式热键让位」启停巡检：都不需要时不跑，避免无谓轮询。
    //
    // ⚠️ 2026-10-12：套索平滑的鼠标钩子通路已移除，「平滑布防」不再依赖工具读数
    //    （笔通路由 .8li 模块自己判 PS 进程，与当前工具无关）⇒ 本巡检只服务「自动关」。
    // 0x0224：混合模式热键开关开着时它还要服务「按工具让位」——两个需求共用同一条
    //    1s 巡检（`syncSmoothToolWatch` 会让位给本巡检，见那里的说明）。
    private syncToolWatch() {
        const needAutoOff = this.state.isEnabled && this.state.autoOffOnOtherTool;
        // ⛔ 只在**开关开着**时才需要（关着时原生根本不装混合模式表，读工具毫无意义）。
        const needBlend = blendGuardWatchNeeded();
        const need = needAutoOff || needBlend;
        if (need && !this.toolWatchTimer) {
            if (needAutoOff) this.noteRealTool(null); // 新一轮先取基准，不追溯开开关之前的工具
            this.toolWatchTimer = setInterval(() => { void this.pollToolChange(); }, App.TOOL_WATCH_INTERVAL_MS);
            void this.pollToolChange();
        } else if (!need && this.toolWatchTimer) {
            clearInterval(this.toolWatchTimer);
            this.toolWatchTimer = null;
            this.noteRealTool(null);
        }
        // 「自动关」的启停会改变「谁在读工具」⇒ 平滑闸门要不要自建巡检随之变化。
        this.syncSmoothToolWatch();
    }

    private async pollToolChange() {
        // 「自动关」或「混合模式热键按工具让位」需要时才跑；都不需要就整轮跳过。
        // （2026-10-12 前平滑布防也依赖本轮询，鼠标钩子通路移除后不再需要。）
        const needAutoOff = this.state.isEnabled && this.state.autoOffOnOtherTool;
        const needBlend = blendGuardWatchNeeded();
        if (!needAutoOff && !needBlend) return;
        // 0x0209：Alt 临时吸管期间不许「自动关」（同 maybeAutoTurnOff）。
        // ⛔ 放在 needAutoOff 之后：不改变原本的早退顺序，只多一层闸。
        if (this.altToolHold) return;
        // 并发守卫；上一次查询若卡在模态状态里迟迟不返回，超过 3s 就放行，避免巡检永久停摆
        if (this.toolWatchBusy && Date.now() - this.toolWatchBusySince < 3000) return;
        // ⛔ 0x0208：交互期让路（同 pollSmoothToolGate）。此处额外说明为什么「自动关」
        //    可以接受这一拍的空缺：工具切换的主通路是 PS 的 select 通知（见
        //    maybeAutoTurnOff），本巡检只是**动作回放/预设带工具**这类不派发 select 的
        //    兜底通道 ⇒ 最坏延后一拍（1s）判定，不影响「切到画笔就关」的可用性。
        // ⛔ 0x0209：同上给 900ms 上限（无限让路会让「切到涂抹就自动关」在长按期间失效）。
        if (hostYield('工具巡检', 900)) return;
        // ⚠️ 忙碌闸门：readCurrentToolId 会发 batchPlay get（application.tool）。
        // 本轮询与用户操作完全异步，切文档期间落进忙碌窗口就会弹宿主原生报错框。
        // ⛔ 同上：进程内模态层级确定忙 ⇒ 本轮不发 get（丢一轮工具读数无副作用，
        //    下一轮 300ms 后自会补上）。
        if (isPsBusy() || psBusyInProc() === 1) return;
        this.toolWatchBusy = true;
        this.toolWatchBusySince = Date.now();
        try {
            const tool = await this.readCurrentToolId();
            /* 0x0224：先喂「混合模式热键按工具让位」——它只关心「现在站哪个工具上」，
               读失败（null）时 note 会原样忽略，不会把让位位闪回接管。 */
            noteToolForBlendYield(tool);
            // 顺带喂「平滑的工具闸门」：**同一份读数**，不为它再发一次 batchPlay get。
            // ⛔ 0x0224：条件从「平滑开着」放宽到「平滑或吸附开着」—— 本巡检现在可能
            //    因为混合模式让位而独跑（syncSmoothToolWatch 已让位），若仍只认 pen.enabled，
            //    「平滑关 + 吸附开 + 混合模式热键开」这个组合下闸门会整段断供（0x0223 的老病）。
            // ⛔ 走 applyToolGate（而不是直接下发）：读失败必须**沿用上次判定**，
            //    不能退回「未知/放行」—— 那会让闸门在偶发读失败时整段失守。
            if (this.state.smoothStatus.connected &&
                (this.state.smoothStatus.pen.enabled || this.state.polySnapEnabled)) {
                this.applyToolGate(tool);
            }
            if (!tool) return;
            if (!needAutoOff) return;          /* 只服务让位时到这里就结束（不碰 lastKnownTool） */
            const prev = this.lastKnownTool;
            this.noteRealTool(tool);
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
        // ⛔ 同上：文档身份巡检本身就是 500ms 轮询，确定忙时跳过一轮不影响正确性。
        // ⛔⛔ 0x0208：让路判据**必须放在闩锁分支之后**。闩锁生效期本巡检是唯一被允许
        //    运行的通道，它负责推进并释放闩锁 —— 在闩锁前面就 return 会让闩锁永不释放
        //    （自锁）。这里的让路只作用于「常规身份兜底」这一句。
        if (hostYield('文档身份巡检')) return;
        if (isPsBusy() || psBusyInProc() === 1) return;
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
        // ⛔ 同上：快速蒙版状态不要求实时，确定忙时跳过本轮最划算。
        // ⛔ 0x0208：交互期让路。快速蒙版只能轮询（PS 不派发通知），但它在拖拽/缩放期间
        //    本来也不会变 —— 这一拍纯粹是白付一个模态作用域。
        if (hostYield('快速蒙版巡检')) return;
        if (isPsBusy() || psBusyInProc() === 1) return;
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
        // 0x0209：Alt 临时吸管期间不许自动关（松开后总开关必须是「开」）。
        if (this.altToolHold) return;
        if (eventName !== 'select' && eventName !== 'set') return;
        let tool = eventName === 'select' ? this.resolveSelectedTool(descriptor) : null;
        // ⚠️ 忙碌闸门：本函数由通知回调直接调用，而 descriptor 里带工具/笔刷预设引用时
        // 需要 readCurrentToolId() 发一次 batchPlay get。通知是在命令执行【中途】派发，
        // 此刻发 get 会被宿主拒绝并弹原生报错框（绕过 try/catch）。
        // 这里直接放弃本轮：同样的判定由 pollToolChange（300ms 轮询兜底）覆盖，
        // 且它的前置条件与本函数完全一致（isEnabled + autoOffOnOtherTool），
        // 因此不存在「放弃就永远不判定」的缺口。
        if (!tool && this.isToolPresetDescriptor(descriptor)) {
            // ⛔ 同上。
            if (isPsBusy() || psBusyInProc() === 1) return;
            tool = await this.readCurrentToolId();
        }
        if (!tool) return;
        this.noteRealTool(tool); // 与巡检共享基准，避免同一件事被判两次
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

        // ===== 0x0209：工具变化事件 ⇒ **立刻**喂平滑闸门（快通路，修 BUG1）=====
        // ⛔ 为什么置在自动关之前：这是「切走套索后引擎还继续平滑/HUD 还在」的最短修复路径。
        //    轮询最坏要 1s 才纠正，而 PS 切工具会派发 select 通知 —— 事件驱动能把窗口
        //    压到一个通知周期（毫秒级）。只喂「能解析出工具名」的事件：
        //    笔刷预设这类解析不出工具的（工具是被预设间接带过去的）一律交回 1s 巡检，
        //    绝不猜（喂错值等于把闸门钉在错的工具上）。
        try {
            if (eventName === 'select') {
                const t = this.resolveSelectedTool(descriptor);
                if (t) {
                    /* 0x0224：混合模式热键「按工具让位」的快通路（**无前置条件**）：
                       纯解析 descriptor、不发任何命令，所以无论平滑/自动关开不开都能走。
                       切到画笔/渐变/涂抹等自带混合模式的工具 ⇒ 立刻让位（毫秒级），
                       不必等 1s 巡检；切回套索 ⇒ 立刻恢复接管。 */
                    noteToolForBlendYield(t);
                    if (this.state.smoothStatus.connected && this.state.smoothStatus.pen.enabled) {
                        this.noteRealTool(t);        // 与巡检共享基准，避免同一件事被判两次
                        this.applyToolGate(t);
                    }
                }
            }
        } catch { /* 单次解析失败不影响主流程，轮询兜底 */ }

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
        // 注册（激活）面板打开期间：两个父面板的 flyout 菜单只留「打开激活与试用面板 / 使用手册」
        // 可点，其余全部置灰；关闭后按各面板默认可用态还原。MenuManager 内部幂等（态未变不重复写宿主），
        // 故可安全地在此（渲染期、唯一 body 类派生点）每次调用。
        MenuManager.setLicenseDialogOpen(shouldOpen);
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
        // 同上：弹窗关闭同刻广播，工具箱同步切换到试用态（横幅变主色蓝、不锁定）
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
        // 工具模式：两个前置选项同时勾选即成立（推导值，不额外存 state）
        const focusMode = this.isFocusMode();
        // 紧凑模式（仅父面板作用域）：三行 radio 改三列、去掉齿轮，标签兼作子面板入口
        const compactApp = !!this.state.compactModes?.app;
        // 套索平滑状态档（2026-10-23）：标题右侧开关的 hover 提示与「异常通知条」共用，
        // 渲染期一次算清，避免 JSX 里多处调用漂移（判据本体在 smoothBarTone）。
        const smoothTone = this.smoothBarTone();
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
                    /* 紧凑 + 工具模式：主按钮收成单行 notify-bar——左星形 indicator、中「工具模式」、
                       右 sp-switch（开关即控制），省纵向高度。开关放右侧单独控制，点星/文案不触发切换。
                       两态配色与主按钮一致：开=ok 主色描边主色星，关=disabled 灰描边灰星（不用 warn 橙，
                       橙在本插件语义里是「异常/待处理」，关闭只是未启用）。文案沿用主按钮的
                       「功能开启/功能关闭」，并标注当前处于工具模式。 */
                    <div className={this.state.isEnabled ? 'notify-bar notify-bar-ok' : 'notify-bar notify-bar-disabled'}>
                        <FocusTargetIcon className={this.state.isEnabled ? 'indicator-icon-lg indicator-icon-ok' : 'indicator-icon-lg'} />
                        <span className="notify-text">{this.state.isEnabled ? '功能开启（工具）' : '功能关闭'}</span>
                        <span className="mask-sync-status-spacer" />
                        <ToggleSwitch checked={this.state.isEnabled} onChange={this.handleButtonClick} title={helpTexts.selectionFill.mainButtonTool}  />
                    </div>
                ) : (
                <div
                    role="button"
                    tabIndex={0}
                    className="main-button"
                    onClick={this.handleButtonClick}
                    title={focusMode ? helpTexts.selectionFill.mainButtonTool : helpTexts.selectionFill.mainButton}>
                    <div className="main-button-content">
                        {/* 工具模式下圆点换成同尺寸、同双色的靶心图标（Spectrum Target）；非工具模式仍是原来的圆点 */}
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
                            {this.state.isEnabled ? '自动填充' : '填充关闭'}
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
                        /* ⛔⛔ 2026-10-23 三次结论：**不要上翻**（曾用 openUp，已被用户否掉）。
                           实测数据：截图中该下拉头部上沿 ≈210px，27 项菜单可见高度 200px
                           ⇒ 头部上方根本装不下 ⇒ 上翻定位被 `Math.max(top,2)` 夹到面板顶部，
                           菜单于是「顶到天花板、底边反而压过下拉框」——用户看到的就是
                           「展开位置偏上，盖住主标题和主开关」。
                           上翻唯一的好处（不遮下方不透明度/羽化滑块）远小于位置错乱的代价，
                           故回到标准的下展开：遮住的那几行由 popOverlay 的遮挡逻辑临时隐藏，
                           菜单关闭即还原（UXP 硬限制：可编辑控件永远画在最上层）。 */
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
                                <NumField
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
                        {/* 2026-11-17：步长统一为 **0.5**（用户指定）。
                            ⚠️ 三处必须永远一致：本滑杆 step、下面的数字框 step、
                               DragHandler.configs.feather.step（拖「羽化」标签调值）。
                               历史上滑杆/输入框被改成 1 而 DragHandler 仍是 0.5 ⇒
                               拖标签出「X.5」、滑杆出整数，两条通路互相打架。
                            ⚠️ .num-input-row 定宽 34px：0.5 步长会出现「10.5」这种四位显示，
                               本行数字框与「px」仍在行尾，暂不加宽；若真机被裁剪再说。 */}
                        <RangeSlider
                            min={0}
                            max={20}
                            step={0.5}
                            value={this.state.feather}
                            onChange={this.handleFeatherChange}
                            className="slider-track"
                            title={helpTexts.selectionFill.featherSlider}
                        />
                        <div className="row-start">
                            <div className="num-input-row">
                                <NumField
                                    min="0"
                                    max="20"
                                    step="0.5"
                                    value={this.state.feather}
                                    onChange={(e) => this.setState({ feather: Number(e.target.value) })}
                                    title={helpTexts.selectionFill.featherInput}
                                />
                            </div>
                            <span className="num-unit">px</span>
                        </div>
                    </div>

                    {/* 多边形吸附：套索按住 Alt 临时切到多边形套索时的 8 向角度吸附。
                        ⚠️ 开关只下发**意图**（WS 18924 的 `polySnap` → 原生共享槽 I_POLYSNAP），
                           吸附、落笔冻结、青色参考线全在 .8li 里执行 —— 面板没有任何可回读的
                           状态（PS 的临时模式本身也不派发工具变更），所以这里不做「未连接置灰」：
                           未连接时记下意图，建连后 resendLassoSmoothing 自动重放。
                        ⚠️ 与「选区平滑」**完全正交**（0x0221 起才真正成立）：平滑关着时
                           按住 Alt 照样吸、照样有青色参考线。此前 .8li 只在平滑总开关为真时
                           才调包处理，吸附整条链跟着一起死 —— 现在原生侧独立驱动。
                        ⚠️ 放在本盒末尾（羽化之下）而不是外置：它描述的是「填充/选区这条
                           工作流里的一步辅助」，与上两行同属一组；行间距靠 `.row-between`
                           自带的 10px（块级容器内相邻外边距折叠），与「不透明度↔羽化」一致，
                           不再需要任何自定义 CSS。 */}
                    <div className="row-between poly-snap-row" title={helpTexts.selectionFill.polySnapRow}>
                        <span className="label-5">多边形吸附</span>
                        <ToggleSwitch
                            checked={this.state.polySnapEnabled}
                            onChange={() => this.togglePolySnap()}
                            title={helpTexts.selectionFill.polySnapSwitch}
                        />
                    </div>
                </div>

                {/* APP 侧热键的即时反馈（2026-11-16 用户要求：全部放在「选区平滑」折叠分区
                    **上方**这一条固定槽位里）。
                    ⛔ 位置是硬要求：它覆盖「自定义快捷键」子面板里与选区填充有关的每一次按键
                       （开关 H / 套索 L / 切换套索 Shift+L / 清除模式 Shift+E /
                        切换填充模式 Ctrl+滚轮 / 混合模式热键），原先这些提示统统埋在
                       绘画工具箱「笔刷热键」列表最下方 —— 用户按完键视线在画布与面板中段，
                       根本看不到。
                    ⛔ 只在有反馈时占位：通知条出现/消失会推动下方分区 ⇒ 与「选区平滑错误条」
                       同一处 resyncNativeWidgets 兜底（componentDidUpdate 里比对可见性），
                       避免 UXP 原生数字输入留残影。
                    ⚠️ 配色沿用本面板状态条口径：成功 = 主色蓝（ok），失败 = 红（fail）；
                       不使用橙色 —— 橙在本插件语义里是「待处理/未就绪」，不是「操作失败」。 */}
                {this.state.appHotkeyNotify && (
                    <div
                        className={'notify-bar ' + (this.state.appHotkeyNotify.ok ? 'notify-bar-ok' : 'notify-bar-fail')}
                        title={helpTexts.selectionFill.appHotkeyNotify}
                    >
                        <span className={'indicator indicator-md ' + (this.state.appHotkeyNotify.ok ? 'indicator-ok' : 'indicator-fail')} />
                        <span className="notify-text">{this.state.appHotkeyNotify.text}</span>
                    </div>
                )}

                {/* 选区平滑：套索**绘制过程中**的实时平滑。
                    ⚠️ 与下面「选区改造」是两条独立路径：本分区作用在**输入轨迹**
                        （PS 收到笔坐标之前，由 PS 进程内的 .8li 平滑插件改写包坐标），
                        选区改造作用在**已生成的选区掩码**。
                       因此两者可以同时开启，效果是串联的（先平滑轨迹、再改造掩码）。 */}
                {this.state.smoothOptionsVisible && (
                <div className="collapse-section" data-section-id="smoothOptions">
                    <div className="collapse-header" onClick={this.toggleSmoothOptions} title={helpTexts.selectionFill.smoothOptionsToggle}>
                        <div className={this.state.isSmoothOptionsExpanded ? 'collapse-icon-expanded' : 'collapse-icon'}>
                            <ExpandIcon expanded={this.state.isSmoothOptionsExpanded} />
                        </div>
                        <span className="label-6">套索轨迹平滑</span>
                        {/* ⛔ 2026-11-16 用户要求：标题从「选区平滑」改为「套索轨迹平滑」——
                            这条平滑只作用在**套索类**工具的绘制轨迹上（下方「选区改造」才作用
                            在已生成的掩码上），旧标题容易被理解成「对任何选区都平滑」。
                            ⚠️ 字数从 4 变 6 ⇒ 宽度档必须同步从 label-4(47px) 换到
                               label-6(73px)（铁律 107：按字数选档，否则文字溢出压到右侧开关）。 */}
                        {/* ⛔⛔ 2026-10-23 用户要求：套索平滑总开关从内容区状态条**挪到分区标题右侧**
                            —— 常态不再占「状态条 32px + 间距 8px」的一整行，省纵向空间。
                            开关语义与原状态条里那颗完全一致（下方注释整体搬迁）：
                            ⛔ 开关**永不禁用**（2026-10-12 真机事故：置灰 = 用户没有任何入口）：
                                未连接时点击会记下意图，.8li 就绪后自动重放（见 toggleLassoSmooth）。
                            ⛔⛔ 2026-10-19：checked = 用户意图（isPenSmoothOn），**不看 connected** ——
                                WS 瞬断时旧判据会把开关翻到关位、状态条闪「服务未启动」，
                                用户什么都没做开关自己跳（用户报「偶尔自动变成服务未启动状态」）。
                                现在：开关除非用户点击永不动；连接状态只在**异常时**进 notify-bar（见下）。
                            ⚠️ 包一层 span 拦截点击冒泡：标题行整体是折叠/展开热区，不拦的话
                                拨开关会连带折叠分区（CSS 拦不了事件，必须 stopPropagation）。
                            ⚠️ 状态文案退进 hover 提示（title）：常态不占位，鼠标悬停仍看得到
                                「生效中 / 关 / 服务未启动…」等全部情形（口径同 smoothStatusText）。 */}
                        <span className="mask-sync-status-spacer" />
                        <span className="collapse-header-control" onClick={(e) => e.stopPropagation()}>
                            <ToggleSwitch
                                checked={isPenSmoothOn()}
                                onChange={this.toggleLassoSmooth}
                                title={helpTexts.selectionFill.smoothEnabledSwitch + '\n当前状态：' + this.smoothStatusText()}
                            />
                        </span>
                    </div>
                    {/* 异常态通知条（2026-10-23 用户要求「当有错误发生，通过notify-bar通知用户」）：
                        只 warn / fail 两档现身 —— 服务没起来 / 版本过旧（橙，要用户去装新 .8li）、
                        标定失败 / 平滑中断（红，要用户截图反馈）；「关 / 准备中 / 生效中」不占位
                        （生效与否看标题右侧开关 + 其 hover 提示）。
                        ⚠️ 渲染在标题下方、折叠内容**之外**：分区折叠着时错误也看得见，不被藏住。
                        ⚠️ 显隐会推动下方平滑参数行 ⇒ componentDidUpdate 对「错误条可见性」
                            做了 resyncNativeWidgets 兜底（防 UXP 原生数字输入留残影）。 */}
                    {smoothToneIsError(smoothTone) && (
                        <div className={'notify-bar ' + smoothTone}>
                            <span className={'indicator indicator-md ' + App.smoothDotOfTone(smoothTone)} />
                            <span
                                className="notify-text"
                                title={this.state.smoothStatus.unsupported || this.state.smoothStatus.penUnsupported
                                    ? '当前运行的套索平滑模块（.8li）版本过旧，不认识平滑指令。\n\n处置：关闭 Photoshop，用新版 JWautofillHost.8li 覆盖 PS Plug-ins 目录里的旧文件，再重启 Photoshop。'
                                    : helpTexts.selectionFill.smoothStatusLabel}>
                                {this.smoothStatusText()}
                            </span>
                        </div>
                    )}
                    {this.state.isSmoothOptionsExpanded && (
                    <div className="collapse-content-expanded">
                        {/* 滤波族：三列（与「填充模式」紧凑态的 .radio-trio-group 同款）。
                            ⚠️ `.smooth-mode-trio` 专属类只用于间距定位（见 app.css）：
                                紧凑模式靠「内容区首元素 margin-top:5px」得到 15px，
                                非紧凑模式没有那条规则 ⇒ 旧版只有 10px，
                                与紧凑模式差 5px（用户 2026-10-23 报「间距比紧凑模式小」）。
                                现在两模式都由这条专属类的 5px 给出，同一口径。 */}
                        <RadioGroup
                            value={this.state.smoothParams.mode}
                            onChange={this.handleSmoothModeChange}
                            options={SMOOTH_MODE_RADIO_OPTIONS}
                            className="radio-trio-group smooth-mode-trio"
                        />
                        {/* 强度只被「标准」模式读取（拉绳 / 追笔的算法分支不看 Strength）⇒ 不适用时整行隐藏 */}
                        {/* 参数区：选哪个模式就在下面这个盒子里统一显示该模式的全部参数。
                            ⚠️ 2026-10-13 起**删除「高级项」二级折叠**：同屏里套两层折叠
                            会让「哪些参数此刻有效」完全看不出来（用户原话：「请确保没有多余的参数」）。
                            盒子里的行集合 = 该模式实际会被原生侧读取的行，一一对应 smooth_engine.c（.8li 内，原 wintab_hook.c）：
                              标准 = 强度 / 尖角保护 / 速度适应
                              拉绳 = 半径 / 拉绳提示
                              追笔 = 追笔耗时
                            ⛔⛔ 三模式半径互相独立：标准/追笔各固定 100px（原生侧硬上限，
                              不截断强度/追笔耗时的满量程），只有拉绳这一行可调。
                            判据统一走 smoothParamApplies()，不在 JSX 里各写 if。
                            ⚠️ 容器用全仓统一的 .border-panel-section（带描边分区盒）；
                              额外的 .smooth-params 只负责把首/末行自带的外边距归零，
                              使描边到第一个/最后一个参数**恰好 10px**（见 common.css）。 */}
                        <div className="border-panel-section smooth-params">
                        {this.smoothParamApplies('strength') && (
                        <div className="row-between">
                            <label
                                className="label-drag label-2"
                                onMouseDown={(e) => this.handleLabelMouseDown(e, 'smooth:strength')}
                                title={helpTexts.selectionFill.smoothStrength}>
                                强度
                            </label>
                            <RangeSlider
                                min={0}
                                max={100}
                                step={1}
                                value={this.state.smoothParams.strength}
                                onChange={(v) => this.updateSmoothParam({ strength: v })}
                                className="slider-track"
                                title={helpTexts.selectionFill.smoothStrengthSlider}
                            />
                            <div className="row-start">
                                <div className="num-input-row">
                                    <NumField
                                        min="0"
                                        max="100"
                                        step="1"
                                        value={this.state.smoothParams.strength}
                                        onChange={(e) => this.updateSmoothParam({ strength: Number(e.target.value) })}
                                        title={helpTexts.selectionFill.smoothStrengthInput}
                                    />
                                </div>
                                <span className="num-unit">%</span>
                            </div>
                        </div>
                        )}

                        {/* 半径：**仅「拉绳」模式**显示（三模式半径互相独立）。
                            标准/追笔各固定 100px，由 radiusForMode() 统一下发；
                            这一行只改拉绳自己的绳长，不会带着那两个模式一起变。 */}
                        {this.smoothParamApplies('radius') && (
                        <div className="row-between">
                            <label
                                className="label-drag label-2"
                                onMouseDown={(e) => this.handleLabelMouseDown(e, 'smooth:radius')}
                                title={helpTexts.selectionFill.smoothRadius}>
                                半径
                            </label>
                            <RangeSlider
                                min={SMOOTH_RADIUS_MIN}
                                max={SMOOTH_RADIUS_MAX}
                                step={1}
                                value={this.state.smoothParams.radius}
                                onChange={(v) => this.updateSmoothParam({ radius: v })}
                                className="slider-track"
                                title={helpTexts.selectionFill.smoothRadiusSlider}
                            />
                            <div className="row-start">
                                <div className="num-input-row">
                                    <NumField
                                        min={SMOOTH_RADIUS_MIN}
                                        max={SMOOTH_RADIUS_MAX}
                                        step="1"
                                        value={this.state.smoothParams.radius}
                                        onChange={(e) => this.updateSmoothParam({ radius: Number(e.target.value) })}
                                        title={helpTexts.selectionFill.smoothRadiusInput}
                                    />
                                </div>
                                <span className="num-unit">px</span>
                            </div>
                        </div>
                        )}

                        {/* ⛔ 张力行已于 2026-10-13 删除：它和「半径」改的是同一件事
                            （只在 15%~100% 之间缩放圆周半径），两个滑杆互相打架，
                            用户明确要求「去掉张力这个参数」。绳长现在恒等于半径。 */}

                        {/* 追笔耗时：仅「追笔」模式有效；其余模式整行隐藏。
                            ⛔ 2026-10-14 重映射：显示量程 1–100，**数值越大 = 平滑力度越大**
                               （与其它模式一致）。下发时由 LassoSmoothing 的
                               `catchUpToNative()` 反向映射到原生 1–50（1→50、100→1）。
                            ⚠️ 2026-10-19 标签「追笔」→「追笔速度」（用户要求）：与模式名区分，
                               数值方向不变（越大越强），语义见 helpTexts.selectionFill.smoothCatchUp。
                           ⚠️ 2026-11-16 标签「追笔速度」→「追笔耗时」+ 单位 %→「值」（用户要求）：
                               仍是 4 字 ⇒ .label-4 字盒不变；数值方向仍不变（越大越耗时=越黏）。
                           ⚠️ 2026-10-23 标签 4 个字 ⇒ 字盒按前端规范走 .label-4
                              （W(n)=20+(n-2)×13.3，4 字=47px，与「速度适应」「拉绳提示」同档）；
                              滑块 .slider-track 是 flex:1 1 auto，标签变宽后自动相应缩短，无需额外 CSS。 */}
                        {this.smoothParamApplies('catchUp') && (
                        <div className="row-between">
                            <label
                                className="label-drag label-4"
                                onMouseDown={(e) => this.handleLabelMouseDown(e, 'smooth:catchUp')}
                                title={helpTexts.selectionFill.smoothCatchUp}>
                                追笔耗时
                            </label>
                            <RangeSlider
                                min={SMOOTH_CATCHUP_MIN}
                                max={SMOOTH_CATCHUP_MAX}
                                step={1}
                                value={this.state.smoothParams.catchUp}
                                onChange={(v) => this.updateSmoothParam({ catchUp: v })}
                                className="slider-track"
                                title={helpTexts.selectionFill.smoothCatchUpSlider}
                            />
                            <div className="row-start">
                                <div className="num-input-row">
                                    <NumField
                                        min={SMOOTH_CATCHUP_MIN}
                                        max={SMOOTH_CATCHUP_MAX}
                                        step="1"
                                        value={this.state.smoothParams.catchUp}
                                        onChange={(e) => this.updateSmoothParam({ catchUp: Number(e.target.value) })}
                                        title={helpTexts.selectionFill.smoothCatchUpInput}
                                    />
                                </div>
                                <span className="num-unit">值</span>
                            </div>
                        </div>
                        )}

                        {/* 尖角保护（原「拐角」）仅「标准」模式有效。
                            ⚠️ 2026-10-19 标签「拐角」→「尖角保护」（用户要求）：它说的是
                               **转折角阈值** —— 轨迹相邻两段的转折超过该值即判定为拐角、
                               自动减弱平滑以保住尖角；数值越小 = 越容易触发保护。
                            ⛔⛔ 2026-10-14 回退定案：这里曾短暂改成「保护范围」（显示 =
                               90 − 原生阈值，数值越大保护越广）。用户实测后明确要求回退 ——
                               「现在反而更加让人迷惑了」。
                               理由：面板其它参数（强度 / 追笔耗时）**全是「越大越强」**，
                               唯独拐角被反转成「越大 = 保护越广 = 平滑越少」，方向与全体相反，
                               参数之间比较时极易误判，排障还要多做一次心算。
                            ⇒ 现在**显示值 = 原生转折角阈值**，一一对应、无换算（见
                               LassoSmoothing 的 cornerToNative，已还原为恒等）。
                            ⚠️ 语义如实呈现：数值**越小**越容易触发拐角保护（0 = 几乎每帧都保护，
                               90 = 只有掉头才保护）。
                           ⚠️ 2026-10-23 标签 4 个字 ⇒ 字盒按前端规范走 .label-4
                              （W(n)=20+(n-2)×13.3，4 字=47px；旧值 .label-2 只有 20px，
                              四字溢出字盒压在滑块上）；滑块 .slider-track 是 flex:1 1 auto，
                              标签变宽后自动相应缩短，无需额外 CSS。 */}
                        {this.smoothParamApplies('cornerAngle') && (
                        <div className="row-between">
                            <label
                                className="label-drag label-4"
                                onMouseDown={(e) => this.handleLabelMouseDown(e, 'smooth:cornerAngle')}
                                title={helpTexts.selectionFill.smoothCorner}>
                                尖角保护
                            </label>
                            <RangeSlider
                                min={0}
                                max={90}
                                step={1}
                                value={this.state.smoothParams.cornerAngle}
                                onChange={(v) => this.updateSmoothParam({ cornerAngle: v })}
                                className="slider-track"
                                title={helpTexts.selectionFill.smoothCornerSlider}
                            />
                            <div className="row-start">
                                <div className="num-input-row">
                                    <NumField
                                        min="0"
                                        max="90"
                                        step="1"
                                        value={this.state.smoothParams.cornerAngle}
                                        onChange={(e) => this.updateSmoothParam({ cornerAngle: Number(e.target.value) })}
                                        title={helpTexts.selectionFill.smoothCornerInput}
                                    />
                                </div>
                                <span className="num-unit">°</span>
                            </div>
                        </div>
                        )}

                        {/* 速度适应仅「标准」模式有效 */}
                        {this.smoothParamApplies('speedAdaptive') && (
                        <div className="row-between">
                            {/* 「速度适应」是开关而非数值：与其它开关行同构（标签 + 自绘开关）。 */}
                            <span
                                className="label-4"
                                title={helpTexts.selectionFill.smoothSpeedAdaptive}
                                onClick={() => this.updateSmoothParam({ speedAdaptive: !this.state.smoothParams.speedAdaptive })}
                            >速度适应</span>
                            <ToggleSwitch
                                checked={this.state.smoothParams.speedAdaptive}
                                onChange={() => this.updateSmoothParam({ speedAdaptive: !this.state.smoothParams.speedAdaptive })}
                                title={helpTexts.selectionFill.smoothSpeedAdaptiveSwitch}
                            />
                        </div>
                        )}

                        {/* 拉绳提示（HUD）：**仅「拉绳」模式**显示。
                            ⚠️ 旧版它常驻显示，于是标准/追笔模式下也会出现一个毫无意义的洋红圈。
                                现在与模式绑定，且只在「套索工具 + 笔尖落纸面」时由原生侧点亮
                                （见 smooth_engine.c 的 g_toolOk / g_penDown）。 */}
                        {this.smoothParamApplies('leash') && (
                        <div className="row-between">
                            <span
                                className="label-4"
                                title={helpTexts.selectionFill.smoothLeash}
                                onClick={() => this.updateSmoothParam({ showLeash: !this.state.smoothParams.showLeash })}
                            >拉绳提示</span>
                            <ToggleSwitch
                                checked={this.state.smoothParams.showLeash}
                                onChange={() => this.updateSmoothParam({ showLeash: !this.state.smoothParams.showLeash })}
                                title={helpTexts.selectionFill.smoothLeashSwitch}
                            />
                        </div>
                        )}
                        </div>
                        {/* ⛔ 2026-10-17：平滑运行诊断条（notify bar）已删除 —— 排障改看
                           %TEMP%\jwwh-<pid>.log（引擎日志）与 pi8li.log，面板不再常驻诊断条。 */}
                    </div>
                    )}
                </div>
                )}

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
                                    {/* ⚠️ `.selection-sharp-row` 专属类只用于间距定位（见 app.css）：
                                        本行盒高 32px（右列数字输入撑起），文字在盒内垂直居中 ⇒
                                        墨迹比「填充选项」首行的 radio 球（行盒 23px）低约 5px。
                                        缺省 10px 上边距会让「选区改造 → 锐度」看起来比
                                        「填充选项 → 纯色」松 5px（用户 2026-10-23 要求两者一致）。 */}
                                    <div className="row-between selection-sharp-row">
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
                                        <NumField
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
                                        className="label-drag label-2"
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
                                        <NumField
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
                                {/* 特殊蒙版（紧凑模式）：单独占一行、开关贴右。
                                    ⚠️ 不塞进上面的两列网格：它决定「填充落在哪些像素上」，
                                       属于填充层面的选项，与左右两列那些「执行期开关」不是一类；
                                       挤进网格会和「清除模式」在视觉上读成一组。
                                    ⚠️ 位置**紧跟「新建图层」那一行**（用户 2026-11-19 指定），
                                       紧凑模式下网格行与网格行之间没有分割线，靠 13px 行距分隔。 */}
                                <div className={this.isSpecialMaskDisabled() ? 'row-between disabled' : 'row-between'}>
                                    <span className="label-4" title={helpTexts.selectionFill.specialMask}>特殊蒙版</span>
                                    <ToggleSwitch checked={this.state.specialMask} onChange={this.toggleSpecialMask} disabled={this.isSpecialMaskDisabled()} title={helpTexts.selectionFill.specialMaskSwitch} />
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

                                {/* 特殊蒙版（2026-11-19 从图案 / 渐变子面板收口到这里）：
                                    语义是「填充只落在当前图层已有像素上，且不改动这些像素的 alpha」。
                                    放在「新建图层」正下方，因为它和「新建图层」一样是**填充层面**
                                    的决策（决定填充落在哪、而不是填什么），三种填充模式共用。
                                    ⚠️ 子面板里的复选框已删除：两个入口并存必然出现「这边关着、
                                       那边开着」的分歧值，而填充只认一个。
                                    ⚠️ 禁用条件与「新建图层」同构（清除模式 / 快速蒙版 / 图层蒙版 /
                                       单通道）—— 那些场合的目标不是像素图层的像素。 */}
                                <div className={this.isSpecialMaskDisabled() ? 'row-between disabled' : 'row-between'}>
                                    <span className="label-4" title={helpTexts.selectionFill.specialMask}>特殊蒙版</span>
                                    <ToggleSwitch checked={this.state.specialMask} onChange={this.toggleSpecialMask} disabled={this.isSpecialMaskDisabled()} title={helpTexts.selectionFill.specialMaskSwitch} />
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
                    </div>
                    )}

                </div>
                )}

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
                formulaVisible={this.state.formulaVisible.color}
                onFormulaVisibleChange={this.setColorFormulaVisible}
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
              formulaVisible={this.state.formulaVisible}
              onFormulaVisibleChange={this.setFormulaVisible}
              onClose={this.closeClearSetting}
            />
            </div>

            {/* 页脚版权条：常驻面板最下方、不参与 `.panel` 滚动 ⇒ 始终可见
                （与绘画工具箱「功能快捷键」的 notify 同一套「滚动区 + 常驻底栏」模型）。
                ⚠️ 必须在 `.panel` 之外（与滚动容器同级）：留在滚动内容里就会随内容滚走。
                背景在 app.css 的 .panel-footer 里显式取 var(--bg-color)，四套主题各自覆盖。 */}
            <div className="panel-footer">
                <span className="copyright">Copyright © listen2me (JW)</span>
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
            {/* 浮窗图层（隐藏/显示分区 · 填充设置）：多个浮窗**共用一个遮罩 + 纵向堆叠**。
                · 遮罩只有一层 ⇒ 开多个浮窗时暗度恒定，不会「越开越黑」（用户要求）；
                · 排列顺序取 state.floatOrder（= 开启先后）⇒ **后开的排在下面**；
                · 堆叠间距 10px、关闭上方后下方自动顺延 —— 由 .float-stack 的
                  `margin-top:10px` 相邻选择器实现（见 common.css）；
                · 点遮罩空白 = 整层收起；单个关闭走各窗口标题行右侧的 ×。
                ⚠️ 遮罩与窗口都必须在 .panel 滚动容器之外（渲染在 .app-root 层）：
                   position:fixed 的包含块在 UXP 下不扣滚动条宽，留在滚动容器内
                   会被滚动条压住右缘。 */}
            {this.state.floatOrder.length > 0 && (
                <div className="float-overlay" onClick={() => this.closeAllFloatWindows()}>
                    <div className="float-stack">
                        {this.state.floatOrder.map(id => (
                            <div key={id} className="float-window" onClick={(e) => e.stopPropagation()}>
                                {id === 'visibility'
                                    ? this.renderVisibilityFloatContent()
                                    : this.renderFillSettingsFloatContent()}
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {/* 「自定义快捷键」子面板（右上角菜单 → 自定义快捷键，2026-11-16）。
                ⛔ 与绘画工具箱的「功能快捷键」是**同一个组件**（scope='app' 只显示
                   「选区填充」这一组：主开关 / 套索 / 切换套索工具 / 清除 / 拾色器 /
                   临时吸管 / 混合模式热键 / 切换填充模式），样式、通知逻辑、
                   隐藏原生数字输入框、滚动条设计全部一致 —— 用户明确要求「完全一样」。
                ⚠️ 必须挂在本层（.app-root），不能放进 `.panel` 滚动容器：
                   它是 position:fixed 的全面板遮罩，留在滚动容器里会被滚动条压住右缘。
                ⚠️ 层级：`.func-hotkey-overlay` 显式降到子面板档 9999（见 adjustment.css），
                   于是「浮窗（99999 / 激活弹窗 100001）恒在上」的既有模型不变。 */}
            {this.state.isAppHotkeyOpen && (
                <FuncHotkeyPanel scope="app" onClose={() => this.closeAppHotkeyPanel()} />
            )}
            </>
        );
    }
}

export default App;
