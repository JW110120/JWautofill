import { useSyncExternalStore } from 'react';
import { getBlendHotkeyOn, onConfig, setBlendHotkeyYield } from './HotkeyBridge';

/**
 * 混合模式热键「按当前工具临时让位」（0x0224，2026-10-30 新增）。
 *
 * 用户要求（原话）：
 *   「若混合模式热键的开关开着，当我的当前工具是画笔/铅笔/渐变/油漆桶/涂抹/模糊/
 *     锐化/仿制图章/图案图章/历史画笔/历史记录艺术画笔时，临时关闭混合模式热键的开关；
 *     从这些工具切回套索时临时关闭结束、重新自动打开。若之前开关是关的，切回套索
 *     不会自动打开。」
 *
 * 一句话比喻：这些工具**自己带一个混合模式旋钮**，Alt+Shift+字母在 PS 里的原意是
 *   「拧我这个旋钮」。插件把它抢过去拧了选区填充的旋钮 —— 站在画笔上想调画笔，
 *   结果调的是别处的旋钮。所以站在这些工具上时先把旋钮**让回去**，站回套索再抢回来。
 *
 * ⛔⛔ 实现纪律（三条都别改）：
 *   ① **只让位、不改用户意图**：本模块一个字节都不写配置（不调 setBlendHotkeyActive）。
 *      让位位只活在原生内存里（`blendYield` 入站消息）。
 *      为什么：配置是落盘的 —— 按工具来回写 = 用户在画笔工具下关掉面板，混合模式热键
 *      就永久变成「关」；而且每切一次工具就是一次整表重建（RegisterHotKey 同步）。
 *   ② 「之前是关的，切回套索不自动开」这条**天然成立**：开关状态从来没人碰过，
 *      面板显示的仍是用户意图；这里只决定「此刻要不要让位」。
 *   ③ 工具读数只有**一个喂点**（`noteToolForBlendYield`），由 app.tsx 在每次读到工具时
 *      调用（select 通知快通路 + 1s 巡检兜底）。⛔ 不要在这里自建轮询：本仓的模态读取
 *      吞吐有硬上限（≈3.3 次/秒），多加一条巡检就是给「读条卡住」加一条来源。
 */

/**
 * 自带混合模式、需要让位的工具（PS 内部工具 ID）。
 *
 * ⛔⛔ 命名口径（2026-10-30 用 Alchemist 抓 API 现场核对）：工具 ID 一律是**驼峰**，
 *   除第一个单词外每个单词首字母大写 —— `gradientTool` / `cloneStampTool` /
 *   `patternStampTool`。写成 `arthistorybrushtool` 这种全小写是**错 ID**，
 *   永远匹配不上（真机上表现就是「站在历史记录艺术画笔上按 Alt+Shift+J 还是改面板」）。
 *   ⚠️ 历史记录艺术画笔 = **`artBrushTool`**，不是 `artHistoryBrushTool`
 *   （后者在 PS 里根本不存在，旧代码里那条是凭字面猜的）。
 *   ⇒ 下面的名单按**真实 ID**写；匹配时两侧都归一化成小写，
 *     所以即便某个 PS 版本回的大小写有出入也不会漏判。
 *
 * ⚠️ 名单抄自用户 2026-10-30 的原话，**刻意不含**橡皮/混合器画笔/颜色替换画笔 ——
 *    用户没点名，多算一个就等于在那些工具下悄悄取消了他要的功能（要加请让用户确认）。
 */
export const BLEND_YIELD_TOOLS: readonly string[] = [
  'paintbrushTool',        // 画笔
  'pencilTool',            // 铅笔
  'gradientTool',          // 渐变
  'bucketTool',            // 油漆桶
  'smudgeTool',            // 涂抹
  'blurTool',              // 模糊
  'sharpenTool',           // 锐化
  'cloneStampTool',        // 仿制图章
  'patternStampTool',      // 图案图章
  'historyBrushTool',      // 历史记录画笔
  'artBrushTool',          // 历史记录艺术画笔
];

/** 中文名（只用于提示文案）。键必须与上面名单的写法**逐字一致** —— 归一化表就是按名单取值建的。 */
const TOOL_CN: Record<string, string> = {
  paintbrushTool: '画笔',
  pencilTool: '铅笔',
  gradientTool: '渐变',
  bucketTool: '油漆桶',
  smudgeTool: '涂抹',
  blurTool: '模糊',
  sharpenTool: '锐化',
  cloneStampTool: '仿制图章',
  patternStampTool: '图案图章',
  historyBrushTool: '历史记录画笔',
  artBrushTool: '历史记录艺术画笔',
};

/** 归一化：只用来比较/查表，不上屏（上屏用原始 ID 或 TOOL_CN）。
 *  ⛔ 匹配必须做这一步：PS 回的是驼峰，人写字面时大小写随手，一处不一致就静默失效。 */
function normTool(tool: string): string {
  return tool.toLowerCase();
}

/** 小写集合（比较用，构造一次）。 */
const BLEND_YIELD_SET = new Set(BLEND_YIELD_TOOLS.map(normTool));

export interface BlendGuardState {
  /** 此刻是否让位（= 开关开着 ∧ 当前工具在名单里） */
  yielded: boolean;
  /** 触发让位的工具原始 ID；null = 没读到过工具 */
  tool: string | null;
  /** 触发让位的工具中文名（提示文案用；不在名单里为 null，文案退回「当前工具」） */
  toolCn: string | null;
}

export function isBlendYieldTool(tool: string | null): boolean {
  if (!tool) return false;
  return BLEND_YIELD_SET.has(normTool(tool));
}

/** 归一化后的中文名表（键与名单同源，避免两处串行维护走偏）。 */
const TOOL_CN_NORM: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const t of BLEND_YIELD_TOOLS) {
    const cn = TOOL_CN[t];
    if (cn) m[normTool(t)] = cn;
  }
  return m;
})();

/** 工具 ID → 中文名（只给提示文案用；不在名单里返回 null）。 */
export function blendYieldToolCn(tool: string | null): string | null {
  if (!tool) return null;
  return TOOL_CN_NORM[normTool(tool)] || null;
}

let state: BlendGuardState = { yielded: false, tool: null, toolCn: null };
/** 最近一次读到的工具（null = 还没读到过）。⛔ 读失败传 null 时**不改**它。 */
let lastTool: string | null = null;

const listeners = new Set<() => void>();

function publish(next: BlendGuardState) {
  if (next.yielded === state.yielded && next.tool === state.tool && next.toolCn === state.toolCn) return;
  state = next;
  // 复制一份再遍历：订阅回调里可能同步退订（组件卸载）
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch { /* 单个订阅抛错不影响其它订阅者 */ }
  }
}

/**
 * 重算「此刻要不要让位」并把结论推给原生。
 *
 * @param resend 原生侧可能已被归零（新客户端接手 / 卸载 / .8li 重载）⇒ 结论没变也必须重发。
 *               ⛔ 工具读数每秒来一次，那条路 resend=false：只在结论**变了**时才发一帧，
 *                  否则就是每秒一帧无意义的 WS 往返。
 */
function recompute(resend: boolean) {
  const want = getBlendHotkeyOn() && isBlendYieldTool(lastTool);
  if (resend || want !== state.yielded) setBlendHotkeyYield(want);
  publish({
    yielded: want,
    tool: lastTool,
    toolCn: blendYieldToolCn(lastTool),
  });
}

let inited = false;
function ensureInit() {
  if (inited) return;
  inited = true;
  // 开关被拨动（含「配置文件帧到达 / 路径对齐后补条目」）⇒ 结论要立刻跟着变：
  // 例如用户正站在画笔上打开开关，必须马上让位，而不是等下一次切工具。
  // ⛔ resend=true：配置帧也是「重连后重新对齐」的唯一信号，此时原生可能刚被归零。
  onConfig(() => recompute(true));
}

function subscribe(fn: () => void) {
  ensureInit();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getSnapshot() { return state; }

/** 订阅「让位」状态（面板开关行据此把开关显示成临时的关位）。 */
export function useBlendGuard(): BlendGuardState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 只读快照（非组件逻辑用）。 */
export function blendGuardSnapshot(): BlendGuardState {
  return state;
}

/**
 * 唯一喂点：每次**真的读到**工具时调用（app.tsx 的三条读数通路）。
 * ⛔ tool 为 null（读失败）时**什么也不做**：读失败不等于换了工具，
 *    把它当成「不是动笔类」会让让位位在偶发读失败时闪回接管（键又被吞掉）。
 */
export function noteToolForBlendYield(tool: string | null): void {
  if (!tool) return;
  ensureInit();
  // 工具没变 ⇒ 结论不可能变（开关变化由 onConfig 那条路负责），零开销返回。
  if (tool === lastTool) return;
  lastTool = tool;
  recompute(false);
}

/** 混合模式热键开关开着时，工具巡检才有意义（app.tsx 用它决定要不要跑 1s 巡检）。 */
export function blendGuardWatchNeeded(): boolean {
  return getBlendHotkeyOn();
}

/** 让位提示文案（功能快捷键子面板的开关行下方）。 */
export function blendYieldHint(toolCn: string | null): string {
  const head = toolCn ? '当前工具「' + toolCn + '」' : '当前工具';
  return head + '自带混合模式：混合模式热键已临时让出，Alt+Shift+字母 改的是它自己的混合模式；切回套索工具后自动恢复。';
}
