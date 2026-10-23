import { useSyncExternalStore } from 'react';
import {
  connectHotkeyDaemon,
  isDaemonConnected,
  loadPersistedArm,
  onDaemonStatus,
  onHotkeyState,
  peekPersistedArm,
  requestHotkeyStatus,
  setHotkeyArm,
} from './HotkeyBridge';

/**
 * 笔刷热键「布防开关」的共享状态源（2026-10-23 新增）。
 *
 * 为什么要把状态搬出 BrushHotkeySection：
 *   用户要求把「热键开关」从分区内容里的状态条挪到**折叠标题右侧**（省常态空间，与套索平滑同款）。
 *   而工具箱分区的折叠是**条件渲染**（折叠时内容不进 DOM，见 AdjustmentPanel renderSection 的说明），
 *   标题却永远在 ⇒ 开关若继续住在内容组件里，一折叠就消失、点了也没人响应。
 *   所以连接态 / 布防态 / 忙碌态 / 失败文案必须有一个**不随组件挂载生死**的宿主：
 *   本模块的单例 store。标题里的开关与内容区的状态条都从它读，两处永远同一份真相。
 *
 * 语义（沿用 0x013D 定下的规矩，别改）：
 *   · armed 只表达**用户意图**（用户把热键打开/关掉了），**不跟着连接态跳** ——
 *     否则 WS 抖一下开关就自己关一次，用户会看到「运行中短暂关闭」。
 *   · 连接状态只走 error/connected，用来在 notify-bar 里说话，不参与 checked。
 *
 * ⛔ error 不自动消失（用户明确要求：「笔刷热键无法运转时的 notify bar 不会自然消失」）。
 *    它只在两种情况下清空：① 用户操作成功（布防/撤防真的生效）；② 连接恢复。
 *    绝不给它加 TTL —— 无法运转时的提示一旦自然消失，用户就失去了唯一的解释。
 */

export interface HotkeyArmState {
  /** WS 18923（.8li 热键服务）是否连上 */
  connected: boolean;
  /** 用户意图：热键是否布防 */
  armed: boolean;
  /** 正在下发布防/撤防指令（期间开关置灰，防连点） */
  busy: boolean;
  /** 无法运转的原因；空串 = 正常。⚠️ 不自动消失，见文件头说明 */
  error: string;
}

/** 未连接时的固定文案（面板侧唯一的「热键用不了」解释来源） */
export const HOTKEY_ARM_MSG_NOT_CONNECTED =
  '「JWautofill Host」未连接：热键当前无法使用。请在 Photoshop 菜单「窗口 → 插件」中启用该扩展，然后重新加载本面板。';
const MSG_SEND_FAILED = '热键指令发送失败：请重新加载插件后重试。';

let state: HotkeyArmState = {
  // 初值取 bridge 的同步缓存：`false` 会让每次挂载先渲染成「未连接」，等回帧再翻转
  // ⇒ 用户看到的就是「开关/状态条先闪一下未连接」（0x013D 已踩过的坑）。
  connected: isDaemonConnected(),
  armed: peekPersistedArm() ?? true,
  busy: false,
  error: '',
};

const listeners = new Set<() => void>();

function publish(patch: Partial<HotkeyArmState>) {
  const next: HotkeyArmState = { ...state, ...patch };
  if (next.connected === state.connected && next.armed === state.armed &&
      next.busy === state.busy && next.error === state.error) return;
  state = next;
  // 复制一份再遍历：订阅回调里可能同步触发退订（组件卸载）
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch { /* 单个订阅抛错不影响其它订阅者 */ }
  }
}

let inited = false;
function ensureInit() {
  if (inited) return;
  inited = true;
  // 面板任何一个入口挂上（标题开关或分区内容）就保活连接：refcount 只在内部计数，
  // 这里刻意**不**退订 —— 标题开关常驻，连接理应一直保活（与 App 面板保活平滑 WS 同思路）。
  connectHotkeyDaemon();
  onDaemonStatus((c) => {
    // 连上即清掉「未连接」类错误：条件已消失，提示必须跟着走。
    // （指令失败类错误保留，等用户成功操作再清 —— 那是「不能运转」的现场证据。）
    publish(c ? { connected: true, error: state.error === HOTKEY_ARM_MSG_NOT_CONNECTED ? '' : state.error }
              : { connected: false });
    // .8li 只在布防态**跃变**时广播 hotkeyState ⇒ 无论晚挂载还是切回前台，
    // 都必须主动问一次真实布防态，否则 armed 只能靠落盘值猜（2026-10-19 闪烁根因）。
    if (c) requestHotkeyStatus();
  });
  onHotkeyState((st) => publish({ armed: st.armed }));
  // 落盘值兜底补读：读到 null（用户从未表过态）就维持默认布防态。
  void loadPersistedArm().then((v) => { if (v !== null) publish({ armed: v }); });
}

function subscribe(fn: () => void) {
  ensureInit();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getSnapshot() { return state; }

/** 订阅布防状态（组件卸载自动退订；同值不重渲染） */
export function useHotkeyArm(): HotkeyArmState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 拨开关：下发布防/撤防。
 * ⛔ 不再是「拉起 exe」—— .8li 在 PS 进程内承载、不可启停，这里只做布防/撤防。
 * 未连接时**不禁用开关**（置灰 = 用户没有任何入口），改为记下一条不消失的错误提示。
 */
export async function toggleHotkeyArm(): Promise<void> {
  if (state.busy) return;
  if (!isDaemonConnected()) {
    publish({ connected: false, error: HOTKEY_ARM_MSG_NOT_CONNECTED });
    return;
  }
  publish({ busy: true });
  try {
    const want = !state.armed;
    if (setHotkeyArm(want)) publish({ armed: want, error: '' });
    else publish({ error: MSG_SEND_FAILED });
  } finally {
    publish({ busy: false });
  }
}

/** 手动清掉错误提示（暂停态等「非故障」场景切换时用） */
export function clearHotkeyArmError(): void {
  if (state.error) publish({ error: '' });
}

/** 只读当前快照（供非组件逻辑判断，如录制前的布防检查） */
export function hotkeyArmSnapshot(): HotkeyArmState {
  return state;
}
