// 热键桥接：UXP 侧与 .8li（PS 进程内扩展）通信 + 直接切笔刷
// 设计要点（关键）：
// - UXP 沙箱没有 Node 的 fs/os/process，配置“不由插件读写文件”，统一由 .8li 持有。
// - 插件只通过 WebSocket 向 .8li 拉取/推送配置（getConfig / config），避免跨进程文件系统耦合。
// - .8li 全局捕获按键后广播 hotkey 事件，插件执行「总开关切换 / 直接 select 笔刷」。

import { action, app } from 'photoshop';
import { storage } from 'uxp';
import { MainToggleState, requestMainToggle, requestMainToggleOff } from '../utils/MainToggleBus';
import { requestFillModeCycle, FillModeDir } from '../utils/FillModeCycleBus';
import { requestClearModeSet } from '../utils/ClearModeBus';
import { requestBlendMode } from '../utils/BlendModeBus';
import { psRead, runAsModal } from '../utils/psAccess';
import { pickForegroundColor } from '../utils/ColorPicker';
import { isPsBusy, psBusyRemain } from '../utils/psProbe';
import { noteHostBusy } from '../utils/hostInteraction';
// 2026-11-20：笔刷大小预设（Shift+[ / Shift+] 三档步进）的执行体
import { stepBrushSize } from '../utils/BrushSizePreset';
// 2026-11-17：五种选区工具的「选区模式 / 羽化」快照与强制（自动填充进入/退出时守护）
import { enterAutoFill, restoreOne } from '../utils/SelectionToolGuard';
// ⛔ 本模块**不再** import 任何 LassoSmoothing 的东西：套索平滑与热键虽同处一个 .8li，
//    但是两条独立的 WebSocket（平滑 18924 / 热键 18923）——停一侧不影响另一侧，
//    首先就得让两条连接的生命周期互不相干 —— 这里保留任何一句桥接都会把两者重新绑死。

export interface HotkeyEntry {
  id: string;
  combo: string;                 // 例如 "Ctrl+Shift+R"、"Alt+F1"
  // action 语义（.8li 对除 toggleMain 外的 action 均不解释、只透传，新增动作无需改 C）：
  //   toggleMain  主开关（共享总线翻转）
  //   applyBrush  按笔刷名选中预设
  //   runFunc     功能按钮（brush 承载功能 id，见 funcHotkeyDefs.ts）
  //   focusLasso  工具模式「套索工具」键（关主开关 + 切套索）
  //   focusClear  工具模式「清除模式」键（确保主开关开 + 切换清除模式，2026-10-19 新增）
  //   altTool     工具模式「临时吸管」按住键（切吸管 / 松手切回套索，2026-10-28 新增）
  //   pickColor   前景色拾色器（呼出 PS 原生拾色器并写回前景色，2026-10-29 新增）
  //   blendHotkey 混合模式热键总开关（combo 非空=开；.8li 见之装载内置 Alt+Shift 表）
  //   fillToolCycle 五个选区工具循环（默认 Shift+H，保证主开关开启，2026-11-16 新增）
  //   focusMarquee 工具模式「矩形选框工具」键（默认 M，关主开关 + 切矩形选框）
  //   marqueeCycle 选框组循环（默认 Shift+M，矩形 ↔ 椭圆，关主开关）
  //   brushSizePreset 笔刷大小预设开关（combo 非空=开，2026-11-20 新增）
  //   brushSizeStep   笔刷大小档位步进（brush = 'down'/'up'，由开关写入的两条键触发）
  action: 'toggleMain' | 'applyBrush' | 'runFunc' | 'focusLasso' | 'focusClear' | 'altTool' | 'pickColor' | 'blendHotkey'
        | 'lassoCycle'       // 套索组循环（默认 Shift+L，2026-11-16 新增）
        | 'fillToolCycle'    // 五工具循环（默认 Shift+H，2026-11-16 新增）
        | 'focusMarquee'     // 矩形选框工具键（默认 M，2026-11-16 新增）
        | 'marqueeCycle'     // 选框组循环（默认 Shift+M，2026-11-16 新增）
        | 'brushSizePreset'  // 笔刷大小预设开关（2026-11-20 新增）
        | 'brushSizeStep';   // 笔刷大小档位步进（Shift+[ / Shift+]，2026-11-20 新增）
  brush?: string;                // applyBrush 时的笔刷名（PS 预设名，需精确匹配）。
                                  // 注意：不支持同名笔刷——PS 按 _name 只会选中 Brushes 列表最上方那支。
                                  // runFunc 时复用本字段承载功能 id（见 funcHotkeyDefs.ts），
                                  // .8li 对该字段不解释、只透传，因此无需改 .8li。
                                  // focusLasso/focusClear 时复用本字段承载「记忆值」（用户自定义过的键，
                                  // 工具模式关闭时 combo 置空但记忆不丢）。
}

const WS_URL = 'ws://127.0.0.1:18923';

// ===== 主开关（选区填充面板的总开关）快捷键 =====
// 默认绑定 Ctrl+Q。该条目在配置里「长期存在」：
// - combo 为 '' 表示用户已解绑（此时不再自动补回默认值，尊重用户选择）；
// - 配置里完全找不到该条目 = 首次使用，写入默认 Ctrl+Q 并推送。
// 这样做的好处是「解绑」状态能随配置持久化，插件重载后不会又把 Ctrl+Q 塞回来。
export const MAIN_TOGGLE_ID = 'main_toggle';
export const DEFAULT_MAIN_TOGGLE_COMBO = 'Ctrl+Q';
let mainToggleCombo: string | null = null; // null = 尚未从配置里读到过

type ConfigListener = (entries: HotkeyEntry[]) => void;

// 配置文件统一放在 PS 的 PluginData 目录（与密钥、图案等持久化数据同一个位置），
// 路径由本模块解析后告知 .8li，用户不再需要去 %LOCALAPPDATA% 里翻找。
const CONFIG_FILE_NAME = 'hotkeys.json';
let resolvedConfigPath = '';
let configPathPromise: Promise<string> | null = null;

async function resolveConfigPath(): Promise<string> {
  if (resolvedConfigPath) return resolvedConfigPath;
  if (configPathPromise) return configPathPromise;
  configPathPromise = (async () => {
    try {
      const folder: any = await storage.localFileSystem.getDataFolder();
      const p: string = folder?.nativePath || '';
      if (p) {
        const sep = p.indexOf('\\') >= 0 ? '\\' : '/';
        resolvedConfigPath = p + sep + CONFIG_FILE_NAME;
      }
    } catch (e) {
      console.warn('⚠️ 解析插件数据目录失败，.8li 将回落到默认配置路径:', e);
    }
    return resolvedConfigPath;
  })();
  return configPathPromise;
}

/**
 * 守护进程**离线**时直接读 PluginData 里的配置文件供面板显示。
 *
 * ⛔⛔ 修复场景（2026-10-14 用户报）：「卸载笔刷热键服务 → 重载插件 → 面板显示未绑定
 *    任何笔刷快捷键 → 一开服务开关，之前的笔刷又回来了，像冲突」。
 *    成因不是数据丢失，而是**显示与服务实际行为脱节**：卸载按铁律刻意保留
 *    hotkeys.json（绝不删用户数据），但无守护进程就没有配置帧 ⇒ 面板缓存为空 ⇒
 *    显示「未绑定」；服务一开，守护进程按 configpath.txt 读回同一份文件 ⇒ 旧笔刷
 *    集体「复活」。面板此时读的必须是**同一份文件**，显示才可能与服务行为一致。
 *
 * ⛔ 只做「预种子」，三条边界必须守住：
 *    1) 守护进程的配置帧是权威来源 —— 它到达后以它为准（读取窗口内到达则丢弃本次结果）；
 *    2) 绝不在此置 `configLoaded` —— 那会绕过 canPersistConfig 的回写护栏
 *       （2026-10-13「热键全没了」的防护不能拆）；
 *    3) 绝不写文件 —— 本函数只读，文件不存在/损坏一律静默保持空列表。
 */
export async function loadOfflineConfig(): Promise<void> {
  if (configLoaded || cachedConfig.length) return;
  let text = '';
  try {
    const folder: any = await storage.localFileSystem.getDataFolder();
    const entry: any = await folder.getEntry(CONFIG_FILE_NAME);
    if (!entry || entry.isFolder) return;
    text = await entry.read({ format: (storage as any).formats?.utf8 ?? 'utf8' });
  } catch {
    return; // 文件不存在 / 读失败：保持空列表（与旧行为一致）
  }
  if (!text || !text.trim()) return;
  let arr: any;
  try { arr = JSON.parse(text); } catch { return; }
  if (!Array.isArray(arr)) return;
  // 异步读取窗口里守护进程的配置帧可能刚到：以它为准，丢弃本次预种子
  if (configLoaded || cachedConfig.length) return;
  cachedConfig = arr.map(normalizeEntry).filter((x): x is HotkeyEntry => !!x);
  // 同步主开关显示值（只读，不补条目、不推送 —— 补条目是 ensureMainToggleEntry 的职责）
  const mt = cachedConfig.find(e => e.action === 'toggleMain');
  if (mt) mainToggleCombo = mt.combo || '';
  emitConfig();
}

let cachedConfig: HotkeyEntry[] = [];
// 是否已从守护进程收到过配置文件：避免「配置尚未加载」时对配置做读-改-写
// （那会把整份配置用空列表覆盖掉）。
let configLoaded = false;
/**
 * 守护进程**实际读写**的那个配置文件路径（由配置帧带回）。
 *
 * ⛔⛔ 为什么必须有它（2026-10-13 用户报「关掉 PS 重新加载后热键全没了，
 *    hotkeys.json 已被初始化」）：
 *    守护进程在「还没收到面板下发的配置路径」时，会回落到默认路径
 *    （%LOCALAPPDATA%\JWautofill\hotkeys.json）。若那个文件不存在（例如卸载脚本
 *    把指向真实配置的指针 configpath.txt 一起删了），守护进程就会回一帧**空配置**。
 *    面板拿到空列表后按「首次使用」补上主开关/套索键两个默认条目并**回写落盘** ——
 *    用户的笔刷热键就这样被整份冲掉了。
 *    ⇒ 现在只有**守护进程明确报出了它读写的文件路径**时才允许回写：
 *      路径为空说明它连自己该读哪份配置都还不知道，此时回写等于拿默认值覆盖真配置。
 */
let daemonConfigPath = '';
/**
 * 面板**主动下发**的配置路径（`resolveConfigPath()` 的解析结果）。
 * 与 `daemonConfigPath` 一起构成「回写许可」的判据，见 `canPersistConfig`。
 */
let requestedConfigPath = '';
/** 上一次重发 setConfigPath 的时刻（路径未对齐时的节流闸，见 onmessage config 分支）。 */
let lastPathResendMs = 0;
/**
 * 是否允许把面板侧的改动回写落盘。
 *
 * ⛔⛔ 判据 = 「守护进程正在读写的文件，正是面板指定的那一份」。
 *    只判「路径非空」不够：守护进程在拿不到面板路径时会回落到**默认路径**
 *    （%LOCALAPPDATA%\JWautofill\hotkeys.json），那个字符串同样非空 ——
 *    而它指向的文件往往不存在 ⇒ 守护进程读到空列表 ⇒ 面板按「首次使用」补默认值
 *    并回写 ⇒ 用户的笔刷热键被整份冲掉（2026-10-13 报的「关掉 PS 重载后热键全没了」）。
 *    ⇒ 只有两边**逐字相同**时才允许落盘；不一致说明守护进程还在别处，先由面板
 *      重新下发路径（见 onmessage 里的 config 分支），这一轮一律不写。
 */
function canPersistConfig(): boolean {
  return configLoaded && !!requestedConfigPath && daemonConfigPath === requestedConfigPath;
}
// ===== 布防开关（hotkeyArm）的本地持久化 =====
// 背景（2026-10-18 用户要求「笔刷热键开关状态本地持久化」）：布防状态此前只活在
// .8li 内存里（keyhook.c 的 g_khArmed，PS 启动时默认 true，无任何磁盘持久化）
// ⇒ PS 重启后面板上次「关闭」的选择丢失，开关自己弹回开启态。
// 现在由面板把开关状态落盘到 PluginData（settings/hotkey-arm.json，与主开关 /
// 工具模式的共享状态同目录、同套路）：
//   · hotkeyState 帧到达即落盘（权威来源 = .8li 的跃变广播 / hotkeyStatus 回帧，
//     看护线程 120ms 轮询保证撤防/重挂/熔断都会在 ~240ms 内播出来）；
//   · WS 建连后若持久值为 false，补发一次 hotkeyArm(false) —— .8li 重启后默认
//     布防，不补发就会「自动重开」，正是用户抱怨的场景；
//   · 持久值为 null（从未落盘）= 用户没表过态，默认布防即真相，不干预；
//   · 持久值为 true 但服务实际已撤防（如键盘修复后刻意保持关闭）时**不自动重挂**
//     —— 真实状态以 hotkeyStatus 回帧为准并顺势落盘，修复的「保持撤防」意图
//     不会被一次重连推翻（kh_do_repair 的注释同样要求「自动重挂等于再冻一次」）。
const ARM_FILE_NAME = 'hotkey-arm.json';
// 内存镜像：null = 尚未落过盘（此时 .8li 默认布防 true 是唯一真相）
let armPersisted: boolean | null = null;
// 串行写链：跃变广播与面板点击可能并发落盘，避免 read-modify-write 交错覆盖
let armWriteChain: Promise<unknown> = Promise.resolve();

function armFormats(): string {
  return (storage as any).formats?.utf8 ?? 'utf8';
}

async function getArmFolder(): Promise<any> {
  const dataFolder: any = await storage.localFileSystem.getDataFolder();
  try {
    return await dataFolder.getEntry('settings');
  } catch {
    return await dataFolder.createFolder('settings');
  }
}

/**
 * 读一次布防开关的持久值（模块级缓存，重复调用无 I/O）。
 * 文件缺失 / 损坏 / 内容不含布尔 armed 一律返回 null —— 调用方按「默认布防」处理。
 */
export async function loadPersistedArm(): Promise<boolean | null> {
  if (armPersisted !== null) return armPersisted;
  try {
    const folder = await getArmFolder();
    const entry: any = await folder.getEntry(ARM_FILE_NAME);
    if (!entry || entry.isFolder) return null;
    const text = await entry.read({ format: armFormats() });
    if (!text || !text.trim()) return null;
    const j = JSON.parse(text);
    if (j && typeof j.armed === 'boolean') {
      armPersisted = j.armed;
      return armPersisted;
    }
  } catch { /* 不存在 / 损坏：当作无持久值 */ }
  return null;
}

/** 同步 peek（供 useState 初值，避免「先渲染一帧再纠正」的闪烁）；未读过返回 null。 */
export function peekPersistedArm(): boolean | null {
  return armPersisted;
}

/** 把布防开关状态落盘（异步串行；写失败只告警——内存值仍驱动本次会话的 UI）。 */
export function persistArm(on: boolean): Promise<void> {
  const run = armWriteChain.then(async () => {
    armPersisted = on;
    try {
      const folder = await getArmFolder();
      const file = await folder.createFile(ARM_FILE_NAME, { overwrite: true });
      await file.write(JSON.stringify({ armed: on, ts: Date.now() }), { format: armFormats() });
    } catch (e) {
      console.warn('⚠️ 布防状态落盘失败（本次会话仍按新状态生效）:', e);
    }
  });
  armWriteChain = run.then(() => {}, () => {});
  return run;
}
// ===== 工具模式「套索工具键」（默认 L）=====
// 工具模式下主开关热键只开不关；为了让 H / L 像两个工具一样切换，再注册一个
// 「套索工具」键：按下即关闭主开关并把当前工具切回套索。
// 该键**只在工具模式开启时装载**（combo 非空）；关闭时把 combo 置空、由守护进程跳过注册，
// 从而完全不影响 PS 原生的 L 键（套索 → 多边形 → 磁性的循环等）。
export const FOCUS_LASSO_ID = 'focus_lasso';
export const DEFAULT_FOCUS_LASSO_COMBO = 'L';
let focusLassoActive = false;   // 工具模式是否开启（仅 APP 面板会写）
let focusLassoKnown = false;    // 是否由 APP 面板明确过工具模式状态（用于排除其它面板上下文）
const configListeners: ConfigListener[] = [];
let currentWs: any = null;
let connected = false;
// 当前挂起的录制请求（守护进程回传 recordResult/recordCancel 时兑现）
let pendingRecord: ((r: { combo: string } | null) => void) | null = null;
// 录制进度监听（两段式录制第一阶段）：守护进程捕获到组合键后广播 recordCaptured，
// 面板据此把该行显示为「已捕获 XXX，待确认」。录制的确认/取消仍由 recordResult/recordCancel 兑现。
const recordProgressListeners: ((combo: string) => void)[] = [];
const statusListeners: ((c: boolean) => void)[] = [];
// 热键布防状态监听（.8li 形态新增）：服务就绪（WS 可达）≠ 热键生效，
// 「布防/撤防」是独立开关（hotkeyArm）。帧来源有二：
//   ① 看护线程的跃变广播 hotkeyState（状态变化后约 240ms 内）；
//   ② 面板主动请求 hotkeyStatus 的回帧（连上后要一次，供开关对齐真实状态）。
export interface HotkeyStateInfo {
  armed: boolean;          // 是否已布防（钩子是否允许安装/生效）
  hookInstalled: boolean;  // 钩子句柄当前是否真的装着
  safeMode: boolean;       // 是否处于熔断降级（连续超预算，纯放行）
  active: boolean;         // 配置里是否有非空组合键（装载态）
  comboCount: number;      // 已注册组合键数
  recording: boolean;      // 是否正在录制
}
const hotkeyStateListeners: ((st: HotkeyStateInfo) => void)[] = [];
export function onHotkeyState(fn: (st: HotkeyStateInfo) => void): () => void {
  hotkeyStateListeners.push(fn);
  return () => { const i = hotkeyStateListeners.indexOf(fn); if (i >= 0) hotkeyStateListeners.splice(i, 1); };
}
function emitHotkeyState(st: HotkeyStateInfo) {
  for (const l of hotkeyStateListeners) { try { l(st); } catch { /* ignore */ } }
}
// 「键盘卡死一键修复」的待兑现回帧（.8li 完成进程内基础修复 + 提权唤起设备层
// 脚本后回 repairResult；提权窗口是异步的，回帧只确认「已唤起」）。
let pendingRepair: ((msg: string) => void) | null = null;
// 热键触发监听（供面板显示触发反馈，也便于用户确认事件链路是否打通）
// enabled 仅对 toggleMain 有效，取自共享总线翻转后的真实状态——
// 提示文字必须说真话：以前无条件显示「已切换」，实际上什么都没切换。
const hotkeyListeners: ((info: { combo: string; action: string; brush?: string; ok: boolean; enabled?: boolean }) => void)[] = [];

function emitStatus() {
  for (const l of statusListeners) { try { l(connected); } catch { /* ignore */ } }
}

// 订阅守护进程连接状态
export function onDaemonStatus(fn: (c: boolean) => void): () => void {
  statusListeners.push(fn);
  fn(connected);
  return () => { const i = statusListeners.indexOf(fn); if (i >= 0) statusListeners.splice(i, 1); };
}

/**
 * 布防 / 撤防热键钩子（.8li 形态的「热键总开关」）。
 *
 * ⚠️ 与旧版「起停守护进程」的本质区别：服务（.8li 内的 WS 18923）不可启停，
 *    这个开关只控制**钩子要不要装**。撤防后：
 *      · 已装的钩子立即卸掉（按键不再被拦截，PS 恢复原生行为）；
 *      · 配置/连接原样保留，重新打开即恢复，无需重载插件。
 *    未连接时返回 false（调用方应引导用户确认扩展已启用）。
 */
export function setHotkeyArm(on: boolean): boolean {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'hotkeyArm', on }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** 主动询问布防状态（回帧 hotkeyState，见 onHotkeyState）。 */
export function requestHotkeyStatus(): boolean {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'hotkeyStatus' }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 解析内置修复脚本 fix-keyboard.ps1 的全路径。
 *
 * ⛔ 为什么必须由面板解析后**传参**给 .8li：.8li 装在 Photoshop 的 Plug-ins
 *    目录（不是 UXP 面板插件的根目录），无法从自身路径推导插件根 ⇒ 拿不到
 *    脚本位置。面板经 getPluginFolder() 解析后随 repairKeyboard 消息下发。
 */
export async function resolveRepairScriptPath(): Promise<string> {
  try {
    const folder: any = await storage.localFileSystem.getPluginFolder();
    const root: string = folder?.nativePath || '';
    if (!root) return '';
    const sep = root.includes('\\') ? '\\' : '/';
    return root + sep + 'native' + sep + 'JWautofillHost' + sep + 'fix-keyboard.ps1';
  } catch {
    return '';
  }
}

/**
 * 「键盘卡死一键修复」：经 WS 让 .8li 在**进程内**完成基础修复
 * （卸钩 → 复位 LowLevelHooksTimeout → 释放卡住的修饰键 → 重启 ctfmon），
 * 再提权唤起设备层脚本（pnputil 软重置键盘设备链 / 关闭 USB 省电策略，
 * 脚本自含 UAC，鼠标点「是」即可，不依赖键盘输入）。
 *
 * 修复后快捷键**保持撤防**：若冻结真是钩子造成的，自动重挂等于再冻一次；
 * 用户确认键盘恢复后在面板重新打开开关即可。
 *
 * @param script fix-keyboard.ps1 全路径（resolveRepairScriptPath 的解析结果）
 * @returns repairResult.message；未连接/超时返回诊断文案
 */
export function requestKeyboardRepair(script: string): Promise<string> {
  return new Promise((resolve) => {
    if (!currentWs || currentWs.readyState !== (currentWs.OPEN ?? 1)) {
      resolve('快捷键服务未连接：请确认 Photoshop 已启用「JWautofill Host」扩展'
        + '（菜单：窗口 → 插件），然后重新加载本面板再试。');
      return;
    }
    let settled = false;
    const done = (m: string) => {
      if (settled) return;
      settled = true;
      if (pendingRepair === done) pendingRepair = null;
      resolve(m);
    };
    pendingRepair = done;
    try {
      currentWs.send(JSON.stringify({ type: 'repairKeyboard', script }));
    } catch {
      done('发送修复指令失败：请重新加载插件后重试。');
      return;
    }
    // 回帧兜底：.8li 侧是同步基础步骤 + 异步唤起提权窗口，15s 足够；
    // 超时按「已发出」提示（旧版服务迁移窗口内指令会被旧 daemon 吞掉，也会落到这里）。
    setTimeout(() => done(
      '修复指令已发出，但未收到确认。若刚刚迁移过旧版快捷键服务，请等几秒重试；'
      + '若键盘仍异常，请重启 Photoshop。'), 15000);
  });
}

// ⚠️ 历史坑（2026-08-30）：这里曾经是「注册一个面板内回调，热键到达时直接调用」。
// 但 UXP 的每个面板都是独立 JS 上下文，本模块在每个面板里都有一份实例：
// App 面板注册的那份回调，绘画工具箱面板根本看不见。于是热键在绘画工具箱面板里被收到，
// 回调是 null → 什么都不做 → 主面板开关纹丝不动（而提示文字照常显示，极具迷惑性）。
// 现在改走 MainToggleBus：热键只负责翻转「共享状态」，由 App 面板订阅并应用。
// 保留此导出仅为兼容旧调用，已不再参与任何逻辑。
export function registerMainToggleHandler(_fn: () => void) {
  console.warn('⚠️ registerMainToggleHandler 已废弃：主开关现由 MainToggleBus 跨面板同步');
}

// 「键盘卡死一键修复」：同样由面板右上角菜单触发，实现留在 BrushHotkeySection。
// 存在的意义：一旦系统的全局键盘钩子把输入拖死，用户连字都打不出来，
// 唯一还能操作的就是鼠标——此时从菜单点一下即可自救，且脚本全程不需要任何键盘输入。
let repairKeyboardHandler: (() => Promise<string>) | null = null;
export function registerRepairKeyboardHandler(fn: () => Promise<string>) {
  repairKeyboardHandler = fn;
}
export async function requestRepairKeyboard(): Promise<string> {
  // ⚠️ 兜底（2026-09-06）：「笔刷热键」分区折叠时组件未挂载 → 没有任何实现注册进来，
  // 旧版只会返回一句提示然后被吞掉（dialogs.alert 在 PS 里不显示）→ 用户点了毫无反应。
  // 键盘卡死是自救场景，任何时候都必须可用。
  //
  // ⚠️ .8li 形态（2026-10-17）：FixKeyboard.exe 已随守护进程一起退役，兜底改走
  //    同一条 WS 修复链路（进程内基础修复 + 提权跑 fix-keyboard.ps1）——
  //    未连接时只能给引导（脚本无法经 shell.openPath 直接执行，见下方说明）。
  if (!repairKeyboardHandler) {
    if (!connected) {
      return '快捷键服务未连接：请确认 Photoshop 已启用「JWautofill Host」扩展'
        + '（菜单：窗口 → 插件），然后重新加载本面板再试。';
    }
    const script = await resolveRepairScriptPath();
    if (!script) {
      return '未找到内置修复脚本 fix-keyboard.ps1（应位于插件目录 native/JWautofillHost 下），请重新安装插件。';
    }
    return requestKeyboardRepair(script);
  }
  try { return await repairKeyboardHandler(); }
  catch (e: any) { return '键盘修复失败：' + (e?.message || String(e)); }
}

// 订阅热键触发事件（无论成败都会回调，ok=false 表示执行 batchPlay 失败）
// ============ 0x0209：按住键边沿总线（工具模式下的「临时吸管」） ============
//
// 需求（用户）：**仅当** ①工具模式 ②当前工具是套索 ③总开关开着 时，按住临时吸管键
// 切到吸管工具取样；松开自动切回套索，且总开关必须保持「开」。
//
// 键源（0x0210）：配置里 action === 'altTool' 的那条 combo，默认 `/`。
// ⛔ 原来是物理 Alt，但套索工具下 Alt 是 PS 原生的「切多边形套索」⇒ 同一个键被两个
//    功能抢，按下时两个都触发。换成独立键后互不干扰（用户在功能快捷键子面板可重录）。
//
// 分工：
//   · .8li（`keyhook.c`）只负责把「该键的键态电平」按**边沿**推上来（它才看得见全局键态，
//     UXP 面板在停靠面板里完全拿不到宿主前台的键盘状态）；
//   · 三个条件的判定、以及切工具/保总开关，全部在 `app.tsx` 的订阅方做 ——
//     那里才有 `isFocusMode()` / `state.isEnabled` / `lastKnownTool`。
//
// ⛔ 消息名仍是 `altHold`（历史名，只表示「临时吸管按住键的电平」）：
//    改名要同时动 .8li 与面板两侧，收益只是好看，风险是漏改一处就整段失灵。
// ⛔ 为什么电平要去重（`altHeld === on` 直接返回）：原生侧按住时每 2s 会发一帧保活
//    （防丢帧/重连），若不去重，用户按住 3 秒就会反复触发两次「切吸管」。
const altHoldListeners: ((on: boolean) => void)[] = [];
let altHeld = false;

/** 订阅临时吸管键的按下/松开边沿（去重后的真正边沿）。返回取消订阅函数。 */
export function onAltHold(fn: (on: boolean) => void): () => void {
  altHoldListeners.push(fn);
  return () => { const i = altHoldListeners.indexOf(fn); if (i >= 0) altHoldListeners.splice(i, 1); };
}

/** 临时吸管键当前是否按着（诊断/调试用）。 */
export function isAltHeld(): boolean { return altHeld; }

// 0x0212：拾色器正在开着（含关闭后 300ms 宽限）。
// ⛔ 为什么需要：拾色器是宿主模态框，开着的这段时间里用户几乎必然要按 Esc/回车，
//    手指也可能顺手带过 `/`；那一拍若被当成「临时吸管按住」，会在对话框背后切工具
//    （切过去失败又会留下一条「切换工具失败」告警），关掉对话框后还可能剩一次
//    「切回套索」——用户看到的是一次莫名其妙的工具抖动。
// ⇒ 拾色器期间**丢弃「按下」边沿**；「松开」边沿照常放行，保证任何残留状态都能解掉。
let pickerBusy = false;
let pickerBusyTimer: any = null;

function emitAltHold(on: boolean) {
  if (on && pickerBusy) return;        // 拾色器期间不认「按下」
  if (altHeld === on) return;          // 边沿去重（原生有 2s 保活帧）
  altHeld = on;
  for (const l of altHoldListeners) { try { l(on); } catch { /* ignore */ } }
}

/**
 * 切到指定工具（0x0209 从 app.tsx 的同名实现泛化而来，`_ref` 换成目标工具）。
 *
 * 写法与 `selectLassoTool` 逐字一致：先直连 batchPlay，失败（某些 PS 版本/状态下
 * 要求模态作用域）再回退 `runAsModal`。
 * ⛔ 不抛错：临时吸管是「按下就做」的交互，失败最多是工具没切过去，
 *    绝不能因为一次 batchPlay 报错在控制台刷屏或打断用户。
 */
/* ⛔⛔ 工具引用名必须逐字取 PS 内部 ID，**不能按英文意思猜**：
   多边形套索是 `polySelTool`（polygon **Sel**ection 的缩写），不是 `polygonalLassoTool`。
   猜错时 `select` **不报错、只是静默无效** —— 2026-11-16 用户实测「Shift+L 只在
   套索与磁性套索之间跳」，正是因为中间那一格发给了不存在的引用（游标照走、工具不动）。
   证据：`docs/lnp-ps64-reverse-2026-10-16.md` 记录的 PS 二进制硬编码工具表
   `paintbrushTool / pencilTool / cloneStampTool / eraserTool / magneticLassoTool /
    lassoTool / polySelTool / eyedropperTool …`。 */
export type ToolRef = 'lassoTool' | 'polySelTool' | 'magneticLassoTool' | 'eyedropperTool'
  // 2026-11-16 新增（选框组）：椭圆选框 `marqueeEllipTool` 已由真机 `'slct'` 日志实证
  // （docs/lnp-ps64-reverse-2026-10-16.md 第 515 行）；矩形选框中位名同族 ⇒ `marqueeRectTool`。
  // ⚠️ 名字错时 `select` 是**静默无效**（不抛错），所以切换函数一律留 warn 日志。
  | 'marqueeRectTool' | 'marqueeEllipTool';
export async function selectToolByRef(ref: ToolRef): Promise<boolean> {
  const descriptor: any = {
    _obj: 'select',
    _target: [{ _ref: ref }],
    dontRecord: true,
    forceNotify: true,
    _isCommand: false
  };
  try {
    await action.batchPlay([descriptor], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
    return true;
  } catch {
    try {
      await runAsModal(async () => {
        await action.batchPlay([descriptor], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
      }, { commandName: '切换工具' });
      return true;
    } catch (e) {
      console.warn('⚠️ 切换工具失败（' + ref + '）:', e);
      return false;
    }
  }
}

export function onHotkeyTriggered(fn: (info: { combo: string; action: string; brush?: string; ok: boolean; enabled?: boolean }) => void): () => void {
  hotkeyListeners.push(fn);
  return () => { const i = hotkeyListeners.indexOf(fn); if (i >= 0) hotkeyListeners.splice(i, 1); };
}

// 守护进程回传的配置条目字段归一化：
// 旧版守护进程落盘为 PascalCase（Combo/Action/Brush），UXP 端统一用小写驼峰读取。
// 这里做双向兜底，避免版本错位时列表显示成 undefined / 快捷键不匹配。
function normalizeEntry(e: any): HotkeyEntry | null {
  if (!e || typeof e !== 'object') return null;
  const combo: string = e.combo ?? e.Combo ?? '';
  const action = (e.action ?? e.Action ?? '') as HotkeyEntry['action'];
  const brush: string | undefined = e.brush ?? e.Brush ?? undefined;
  const id: string = e.id ?? e.Id ?? ('bk_' + Math.random().toString(36).slice(2));
  if (action !== 'toggleMain' && action !== 'applyBrush' && action !== 'runFunc'
      && action !== 'focusLasso' && action !== 'focusClear' && action !== 'altTool'
      && action !== 'pickColor' && action !== 'blendHotkey'
      && action !== 'lassoCycle' && action !== 'fillToolCycle'
      && action !== 'focusMarquee' && action !== 'marqueeCycle'
      && action !== 'brushSizePreset' && action !== 'brushSizeStep') return null;
  // combo 为空的合法条目：主开关（'' = 已解绑）、笔刷（'' = 已解绑但条目保留在列表，
  // 单击选中后按退格即解绑，与「删除」按钮区分）、工具模式套索键（'' = 工具模式关闭时不装载）、
  // 临时吸管键（'' = 工具模式关闭时不装载）、
  // 混合模式热键开关（'' = 关闭，条目保留供开关回显）。
  // runFunc 空组合键无意义，直接丢弃。
  if (!combo && action !== 'toggleMain' && action !== 'applyBrush' && action !== 'focusLasso'
      && action !== 'focusClear' && action !== 'altTool' && action !== 'blendHotkey'
      && action !== 'lassoCycle' && action !== 'fillToolCycle'
      && action !== 'focusMarquee' && action !== 'marqueeCycle'
      && action !== 'brushSizePreset' && action !== 'brushSizeStep') return null;
  // runFunc 必须携带功能 id（复用 brush 字段），缺了就无法执行，丢弃。
  if (action === 'runFunc' && !brush) return null;
  return { id, combo, action, brush };
}

function emitConfig() {
  for (const l of configListeners) {
    try { l(cachedConfig); } catch { /* ignore */ }
  }
}

// 订阅配置变化（首次立即回放当前缓存）
export function onConfig(fn: ConfigListener): () => void {
  configListeners.push(fn);
  if (cachedConfig.length) fn(cachedConfig);
  return () => {
    const i = configListeners.indexOf(fn);
    if (i >= 0) configListeners.splice(i, 1);
  };
}

// UXP 运行环境自带全局 WebSocket（Adobe UXP 标准 API），无需任何 npm 依赖。
// 之前这里还有一行 Node 版的 `require('ws')` 作为回退，会被 webpack 在构建期静态分析并试图打包，
// 从而报 “Can't resolve 'ws'”。UXP 里 globalThis.WebSocket 必定存在，删掉该回退即可消除警告。
function resolveWs(): any {
  const W = (globalThis as any).WebSocket;
  return W || null;
}

// ===== 连接守护进程 =====
// ⚠️ 幂等 + 引用计数（关键修复）：
// UXP 的 #app 与 #pixeladjustment 两个面板共用同一个 bundle.js / 同一个 JS 世界，
// 它们各自在挂载时都会调用本函数。若不防重，就会建出「两条 WebSocket」。
// 守护进程是向所有已连接客户端广播的，于是同一条 toggleMain 热键会被投递两份；
// 两份 handleHotkey 各自执行一次「读-改-写」翻转，因 await 让出线程而读到同一个旧值，
// 结果被翻转两次、互相抵消，表现正是用户看到的「按下有文字提示、主面板开关纹丝不动」。
// 因此同一上下文只允许一条连接：第二次调用直接复用，退订时按引用计数关闭。
let daemonConnectCount = 0;
let daemonCloseFn: (() => void) | null = null;

export function connectHotkeyDaemon(): () => void {
  daemonConnectCount++;
  // 守护进程缺席（已卸载 / 尚未启动）时，先把磁盘上的配置预种子进缓存供面板显示，
  // 消除「面板显示未绑定、服务一开旧笔刷又回来」的观感冲突（详见 loadOfflineConfig 注释）。
  // 自守卫：已有守护进程配置帧或缓存时立即返回，不产生任何 I/O。
  void loadOfflineConfig();
  // 已有连接：直接返回带引用计数的退订器，不再重复建连
  if (daemonCloseFn) return makeDaemonUnsub();

  let closedByUs = false;
  let timer: any = null;

  const open = () => {
    const WS = resolveWs();
    if (!WS) { timer = setTimeout(open, 1500); return; }
    try {
      const ws = new WS(WS_URL);
      currentWs = ws;
      ws.onopen = () => {
        connected = true; emitStatus();
        // 先告知配置文件的统一存放位置（PS PluginData），再拉配置，
        // 保证守护进程读写的就是面板展示的那一份。
        void (async () => {
          try {
            const cp = await resolveConfigPath();
            if (cp) {
              requestedConfigPath = cp;
              ws.send(JSON.stringify({ type: 'setConfigPath', path: cp }));
            }
          } catch { /* ignore */ }
          try { ws.send(JSON.stringify({ type: 'getConfig' })); } catch { /* ignore */ }
          // .8li 形态：拉一次布防状态，让面板开关对齐服务真实状态
          // （g_khArmed 默认 true，但迁移/修复后可能被改过，不能想当然）。
          try { ws.send(JSON.stringify({ type: 'hotkeyStatus' })); } catch { /* ignore */ }
          /* 0x0224：重放「混合模式热键按工具让位」位。原生侧在**新客户端接手**时
             会把这一位归零（keyhook.c 的 kh_cli_add），而面板的结论往往没变
             ⇒ 不重放就会在「面板重载后仍站在画笔上」时被吞键（用户报的正是这个）。 */
          sendBlendYieldFrame();
          // 本地持久化对齐：PS 重启后 .8li 默认布防（keyhook.c g_khArmed 初值 1），
          // 用户上次的「关闭」只活在面板落盘值里 ⇒ 补发一次撤防把它恢复出来。
          // persisted 为 null（从未落盘）说明用户没表过态，默认布防即真相，不动；
          // persisted 为 true 时同样不发——若服务此刻实际已撤防（修复后保持关闭），
          // 自动重挂会违背修复流程「保持撤防」的约定，交给 hotkeyStatus 回帧定夺。
          const persistedArm = await loadPersistedArm();
          if (persistedArm === false) {
            try { ws.send(JSON.stringify({ type: 'hotkeyArm', on: false })); } catch { /* ignore */ }
          }
          // 重连后同步布防状态：守护进程在客户端断开时会撤防，
          // 若本上下文仍持有布防权（选中未变），这里重发一次 armDelete。
          if (armedDeleteOwner) {
            try { ws.send(JSON.stringify({ type: 'armDelete', owner: armedDeleteOwner })); } catch { /* ignore */ }
          }
        })();
      };
      ws.onmessage = (ev: any) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === 'hotkey') handleHotkey(msg);
          // 0x0208：宿主交互态边沿（左键/空格）。只喂给「巡检让路」判据，
          // 不参与热键逻辑；详见 utils/hostInteraction.ts 的根因说明。
          else if (msg?.type === 'hostBusy') {
            /* 0x020B：`btn` = 这一帧里左键是否按着（1/0）。缺字段 ⇒ undefined，
               hostInteraction 按「有左键」兜底（旧版 .8li 兼容）。 */
            noteHostBusy(msg.v === true || msg.v === 1,
                         msg.btn === undefined ? undefined : (msg.btn === true || msg.btn === 1));
          }
          // 0x0209 / 0x0210：临时吸管按住键的电平边沿（键源见配置的 altTool 条目）。
          // 同样只做「电平转事件」，判定（工具模式 + 套索 + 总开关开）由 app.tsx 订阅方负责。
          else if (msg?.type === 'altHold') {
            emitAltHold(msg.v === true || msg.v === 1);
          } else if (msg?.type === 'config') {
            const raw: any[] = Array.isArray(msg.payload) ? msg.payload : [];
            cachedConfig = raw.map(normalizeEntry).filter((x): x is HotkeyEntry => !!x);
            configLoaded = true;
            // 记下守护进程读写的文件路径：与面板指定的不一致 ⇒ 后面一律不回写
            // （见 canPersistConfig），并顺手把路径重发一次让它对齐。
            daemonConfigPath = typeof msg.path === 'string' ? msg.path : '';
            // 路径未对齐（不一致 / 尚未解析出插件数据目录）⇒ 这一帧的 payload 来自**错误的
            // 配置文件**（默认路径或尚未切换完的旧路径），内容马上就会被 setConfigPath 生效后
            // 的修正帧替换。此时若跑 ensure*，会把空/旧 payload 误判成「首次使用」补上默认
            // 条目并尝试回写 —— 回写又被 canPersistConfig 护栏拦截，只留下两条吓人的告警。
            // 修正帧到达时路径已对齐，ensure* 自然会补该补的条目。
            const pathAligned = !!requestedConfigPath && daemonConfigPath === requestedConfigPath;
            if (!pathAligned && requestedConfigPath) {
              // ⛔⛔ 0x0139 防御（2026-10-19）：重发必须**节流**。
              //   根因事故里这里每帧都重发 ⇒ C 侧「路径没变也重载」⇒ 再广播 ⇒
              //   无线速回路把面板 JS 线程淹死（热键集体失灵的直接死因）。
              //   C 侧已修 json_str 反转义（根因），正常情况下根本走不到这里；
              //   保留 1s 最小间隔是第二道闸：即便将来别的原因导致路径再次不一致，
              //   最坏也是 1 次/秒的重发，绝不再是无线速风暴。
              const nowMs = Date.now();
              if (nowMs - lastPathResendMs >= 1000) {
                lastPathResendMs = nowMs;
                console.warn('⚠️ 守护进程的配置路径与面板不一致，已重新下发（本次不回写配置）\n  面板：'
                  + requestedConfigPath + '\n  服务：' + (daemonConfigPath || '(未知)'));
                try { ws.send(JSON.stringify({ type: 'setConfigPath', path: requestedConfigPath })); } catch { /* ignore */ }
              }
            } else if (!requestedConfigPath) {
              console.warn('⚠️ 尚未解析出插件数据目录，本次不回写配置（避免用默认值覆盖已有热键）；'
                + '守护进程当前使用：' + (daemonConfigPath || '(未知)'));
            }
            // 首次使用时补上主开关的默认快捷键 Ctrl+Q
            if (pathAligned) ensureMainToggleEntry();
            // 工具模式开启时补上/更新「套索工具键」（仅 APP 面板上下文会真正写入）
            if (pathAligned) ensureFocusLassoEntry();
            // 工具模式开启时补上/更新「切换套索工具」键（默认 Shift+L，同上仅 APP 面板写）
            if (pathAligned) ensureLassoCycleEntry();
            // 工具模式开启时补上/更新「清除模式」键（默认 Shift+E，同上仅 APP 面板写）
            if (pathAligned) ensureFocusClearEntry();
            // 工具模式开启时补上/更新「临时吸管」按住键（默认 /，同上仅 APP 面板写）
            if (pathAligned) ensureAltToolEntry();
            // 「前景色拾色器」键（默认 Shift+/）：与工具模式无关，始终装载
            if (pathAligned) ensurePickColorEntry();
            // 「切换填充模式」键（默认 Ctrl+滚轮）：同上，与工具模式无关，始终装载
            if (pathAligned) ensureFillModeCycleEntry();
            emitConfig();
          }
          else if (msg?.type === 'recordCaptured') {
            const captured: string = typeof msg.combo === 'string' ? msg.combo : '';
            for (const l of recordProgressListeners) { try { l(captured); } catch { /* ignore */ } }
          }
          else if (msg?.type === 'recordResult') {
            if (pendingRecord) { const r = pendingRecord; pendingRecord = null; r({ combo: msg.combo }); }
          }
          else if (msg?.type === 'recordCancel') {
            if (pendingRecord) { const r = pendingRecord; pendingRecord = null; r(null); }
          }
          else if (msg?.type === 'backspaceDelete') {
            // 布防通路命中：用户在 PS 前台按了退格。分发给所有监听方，
            // 由监听方自行核对 owner（只有当前布防的 UI 会认领）。
            const owner: string = typeof msg.owner === 'string' ? msg.owner : '';
            for (const l of backspaceDeleteListeners) { try { l(owner); } catch { /* ignore */ } }
          }
          else if (msg?.type === 'hotkeyState') {
            // 布防状态（跃变广播 / hotkeyStatus 回帧）：驱动面板的「热键开关」
            const armed = msg.armed === true;
            emitHotkeyState({
              armed,
              hookInstalled: msg.hookInstalled === true,
              safeMode: msg.safeMode === true,
              active: msg.active === true,
              comboCount: typeof msg.comboCount === 'number' ? msg.comboCount : 0,
              recording: msg.recording === true,
            });
            // 本地持久化：值真的变了才写盘（同值回帧/重复广播不产生 I/O）。
            // ⛔ 必须落在 emit 之后由 bridge 统一写，不能指望 UI 组件——
            //    「笔刷热键」分区折叠时组件未挂载，但 WS 由 App 面板保活，
            //    那时到来的状态跃变（如键盘修复后的撤防）同样要落盘。
            if (armPersisted !== armed) void persistArm(armed);
          }
          else if (msg?.type === 'repairResult') {
            if (pendingRepair) {
              const r = pendingRepair;
              pendingRepair = null;
              r(typeof msg.message === 'string' && msg.message
                ? msg.message
                : '修复已完成，请立即测试键盘；快捷键暂保持关闭，确认正常后可在面板重新打开。');
            }
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        connected = false; emitStatus();
        // ⛔ 这里**刻意不**再去动平滑的连接状态：两者已是两个独立进程 / 两条独立 WebSocket。
        //    历史教训：这一行曾经同时把平滑标记为「未连接」，导致「停止快捷键服务」
        //    看上去像是把平滑也一起停掉了。
        // 连接断开时若仍有挂起的录制，直接取消，避免 UI 永远停在「录制中」
        if (pendingRecord) { const r = pendingRecord; pendingRecord = null; r(null); }
        // 修复回帧同样不能挂起：连接断了就再等不到 repairResult，
        // 立刻兑现超时文案（避免 UI 卡 15s 才知道失败）。
        if (pendingRepair) { const r = pendingRepair; pendingRepair = null; r('连接已断开，修复未收到确认；请重新加载插件后重试。'); }
        if (!closedByUs) timer = setTimeout(open, 1500);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    } catch {
      timer = setTimeout(open, 1500);
    }
  };
  open();

  daemonCloseFn = () => {
    closedByUs = true;
    if (timer) clearTimeout(timer);
    try { currentWs?.close(); } catch { /* ignore */ }
  };
  return makeDaemonUnsub();

  function makeDaemonUnsub(): () => void {
    return () => {
      daemonConnectCount--;
      if (daemonConnectCount <= 0) {
        daemonConnectCount = 0;
        daemonCloseFn?.();
        daemonCloseFn = null;
      }
    };
  }
}

// ===== 功能快捷键（runFunc）=====
// 功能按钮（分块平均/扣除纯白等）的执行权在调整面板里，这里只做转发：
// 面板挂载后 registerFuncRunner 注册一个「功能 id → handler」的分发器，
// 热键命中 runFunc 时按 id 调用。分发器内部持有 ref 读取最新 handler（handler 每次渲染重建）。
let funcRunner: ((funcId: string) => void) | null = null;
export function registerFuncRunner(fn: (funcId: string) => void) {
  funcRunner = fn;
}

/**
 * 关闭「清除模式」（幂等，重复调用无副作用）。
 *
 * 2026-11-20 用户要求：Shift+E 改成「只开不关」之后，清除模式失去了用快捷键退出的路。
 * ⇒ 用「回到选区填充」的两条键兼任出口：
 *   · H（主开关 = 选区填充开关）
 *   · Shift+H（切换选区填充 / 五工具循环）
 * 两条都代表「我要回去正常填充」，此时清除模式必须落下来，否则下一笔仍是清除。
 *
 * ⛔ 用独立的 token 前缀 `clearOff|`：不能和 focusClear 那条「开启」命令共用 token，
 *    否则 file 里的 token 相同会被 ClearModeBus 当成「同一次命中已处理」而跳过。
 * ⛔ 400ms 时间桶与其它命令同一套：同一次命中广播给 N 个面板只执行一次。
 */
function requestClearModeOff(token: string) {
  void requestClearModeSet('clearOff|' + token, false)
    .catch((e) => console.error('⚠️ 关闭清除模式命令写入失败:', e));
}

function handleHotkey(msg: { id: string; combo?: string; action: string;  brush?: string; dir?: number }) {
  if (msg.action === 'toggleMain') {
    // 主开关：翻转「共享状态」而不是调用本面板内的回调。
    // token 用「组合键 + 400ms 时间桶」生成：同一次命中在所有面板上算出同一个 token，
    // 于是守护进程广播给 N 个面板也只会翻转一次（详见 MainToggleBus 头部说明）。
    const combo = msg.combo ?? '';
    const token = 'hit|' + (combo || 'toggleMain') + '|' + Math.floor(Date.now() / 400);
    /* 按 H 关闭清除模式（2026-11-20 用户要求，见 requestClearModeOff 的说明）。
       ⛔ 放在守护之前：清除模式是面板 state，走文件轮询，早发一拍就能早一拍落下。 */
    requestClearModeOff(token);
    void (async () => {
      /* 2026-11-17（v2 用户确认）：守护顺序合并成一条「先到位，再拍照」——
         目标不是当前工具就先切过去，然后才逐个拍照片、逐个拧旋钮（见 enterAutoFill）。
         「入口就是普通套索」时目标等于当前工具 ⇒ 不切、直接拍，即用户的情况二。
         ⚠️ token 同时充当多面板去重令牌：同一次命中在所有面板上算出同一个串，
            只有一个面板会真的拍照，其余面板只按需上锁。
         抑制位由守护内部打；本分支要让 H「保持开启回套索」生效，故守护后清位。 */
      try {
        await enterAutoFill('lassoTool', token, noteSelfToolSwitch,
          (t) => selectToolByRef(t as ToolRef));
      }
      catch (e) { console.warn('[选区工具守护] 进入自动填充失败:', e); }
      clearSelfToolSwitch();
      try {
        const st = await requestMainToggle(token);
        for (const l of hotkeyListeners) {
          try { l({ combo, action: 'toggleMain', ok: true, enabled: st.enabled }); } catch { /* ignore */ }
        }
      } catch {
        for (const l of hotkeyListeners) {
          try { l({ combo, action: 'toggleMain', ok: false }); } catch { /* ignore */ }
        }
      }
    })();
    return;
  }
  if (msg.action === 'focusLasso') {
    // 工具模式下的「套索工具」键：关闭主开关（幂等），并把当前工具切回套索，
    // 让 H / L 分别对应「自动填充」与「普通套索」两个工具。
    // 与 toggleMain 同理用 token 去重：守护进程向所有面板广播，只关一次。
    const combo = msg.combo ?? '';
    const token = 'focusLasso|' + (combo || FOCUS_LASSO_ID) + '|' + Math.floor(Date.now() / 400);
    void requestMainToggleOff(token)
      .then((st: MainToggleState) => {
        for (const l of hotkeyListeners) { try { l({ combo, action: 'focusLasso', ok: true, enabled: st.enabled }); } catch { /* ignore */ } }
      })
      .catch(() => {
        for (const l of hotkeyListeners) { try { l({ combo, action: 'focusLasso', ok: false }); } catch { /* ignore */ } }
      });
    // 工具切回套索 —— 但**只在真的跑偏时**才发命令（0x0235，见 selectLassoIfStrayed 说明）。
    selectLassoIfStrayed();
    // 2026-11-17：退出自动填充 ⇒ 只把「当前这一个」套索工具恢复成用户原值，不碰其它工具。
    // ⚠️ 抑制位必须传：restoreOne 内部可能补一次 select 确认工具已落地，
    //    不抑制就会被巡检当成「用户换工具」而误关主开关（虽然这里本来就要关）。
    void restoreOne('lassoTool', noteSelfToolSwitch);
    return;
  }
  if (msg.action === 'lassoCycle') {
    /* 「切换套索工具」键（默认 Shift+L，2026-11-16）：在套索组内循环一格。
       ⛔ 不做 token 去重：它没有「读-改-写」共享状态（对比 toggleMain），
          各面板共用一份订阅表 ⇒ 一次广播只走到这里一次。
       ⛔ 这里**不**顺手关主开关、也不切回普通套索 —— 但**面板会关**：
          「换工具 ⇒ 自动关」是面板的产品决策（要读 autoOffOnOtherTool / isEnabled），
          本模块拿不到 state。所以广播里必须带上目标工具（`brush`），
          面板据此更新「当前工具」基准并决定要不要关总开关。
       ⚠️ 2026-11-16 用户明确要求：Shift+L 换的算**真工具切换**，自动关开关开着时
          要自动关闭总开关（不再是「只在组里换子工具、主开关不受影响」）。 */
    const combo = msg.combo ?? '';
    const target = cycleLassoTool();
    for (const l of hotkeyListeners) { try { l({ combo, action: 'lassoCycle', brush: target, ok: true }); } catch { /* ignore */ } }
    // 2026-11-17：只恢复本次调出的这一个套索子工具（各归各，绝不加载别的工具的）。
    void restoreOne(target, noteSelfToolSwitch);
    return;
  }
  if (msg.action === 'fillToolCycle') {
    /* 「切换选区填充」键（默认 Shift+H，2026-11-16）：五个选区工具循环一格，
       **并且保证主开关开启**（工具模式下 requestMainToggle 只开不关，与清除模式键同一套）。
       ⛔ 与 Shift+L 的关键差异：这里绝不走「自动关」——
          用户要求「按切换选区填充切换工具时不触发自动关，总开关始终保证开启」。
          所以就算工具切到了选框，面板侧也不会关开关（选框不在 AUTO_OFF_TOOLS 里，
          见 App.isOtherTool；本键更不会主动调 autoTurnOffMain）。
       ⛔ 顺序：**先切工具，再开开关**。反过来的话，面板的 onMainToggleChanged
          「关→开且勾了自动切套索」会在工具还没落地时抢着切回套索（那条逻辑服务 H 键，
          不该覆盖用户刚按下的工具键）。切工具由 enterAutoFill 串行完成后，本分支补打抑制位。 */
    const combo = msg.combo ?? '';
    const token = 'fillToolCycle|' + (combo || FILL_TOOL_CYCLE_ID) + '|' + Math.floor(Date.now() / 400);
    /* 按 Shift+H 关闭清除模式（2026-11-20 用户要求）：这条键的语义是「回到正常选区填充并
       循环工具」，清除模式若还亮着，切过去的选区一做填充就变成清除，与用户按下这条键的意图相反。 */
    requestClearModeOff(token);
    void (async () => {
      /* 2026-11-17（v2 用户确认）：Shift+H 属「激活自动填充」，同样走「先到位，再拍照」
         这一条合并规则（见 enterAutoFill）。
         ⚠️ 循环目标必须在守护**之前**算好：它会按当前工具校准游标，而守护会连切工具。
         ⚠️ 切工具由 enterAutoFill 统一串行完成（不能再用 cycleFillTool 的异步 switchToolTo，
            否则与守护内部的 select 并发打架）；这里只调用「算目标+推进游标」的纯函数。 */
      const target = nextFillToolTarget();
      try {
        await enterAutoFill(target, token, noteSelfToolSwitch,
          (t) => selectToolByRef(t as ToolRef));
      }
      catch (e) { console.warn('[选区工具守护] 进入自动填充失败:', e); }
      // Shift+H 要护住刚切到的循环目标，别被 onMainToggleChanged 拽回套索 ⇒ 补打抑制位。
      noteSelfToolSwitch();
      try {
        const st = await requestMainToggle(token);
        for (const l of hotkeyListeners) { try { l({ combo, action: 'fillToolCycle', brush: target, ok: true, enabled: st.enabled }); } catch { /* ignore */ } }
      } catch {
        /* 开关写失败也要把「已切到哪个工具」告诉面板：工具是真切了，提示不能吞掉。 */
        for (const l of hotkeyListeners) { try { l({ combo, action: 'fillToolCycle', brush: target, ok: true }); } catch { /* ignore */ } }
      }
    })();
    return;
  }
  if (msg.action === 'focusMarquee' || msg.action === 'marqueeCycle') {
    /* 「矩形选框工具」(默认 M) / 「切换选框工具」(默认 Shift+M)，2026-11-16。
       两者语义相同、只有目标工具不同：**切到「原本的选框」并关闭主开关**
       （用户原话「确保它们都是原本的选框，不会触发自动填充」）。
       ⛔ 必须**主动关**开关（requestMainToggleOff 幂等），不能指望「自动关」：
          选框工具既不在 AUTO_OFF_TOOLS 里、也不匹配 brush|eraser|stamp|smudge，
          自动关这条路对它们完全不会触发。
       ⛔ 抑制位（noteSelfToolSwitch，在 focusRectMarquee/cycleMarqueeTool 里打）不能少：
          关开关这一拍面板会执行「当前停在多边/磁性套索 ⇒ 切回普通套索」，
          那条逻辑会把刚切到的选框拽回套索。 */
    const combo = msg.combo ?? '';
    const isRectKey = msg.action === 'focusMarquee';
    const target = isRectKey ? focusRectMarquee() : cycleMarqueeTool();
    // 2026-11-17：只恢复本次调出的这一个选框工具（各归各，绝不加载别的工具的）。
    // ⚠️ 这个键的切工具是异步发出去的（focusRectMarquee/cycleMarqueeTool 内部 switchToolTo），
    //    restoreOne 会自己补一次 select 确认，避免读到的还是切换前的那个工具的选项。
    void restoreOne(target, noteSelfToolSwitch);
    const token = msg.action + '|' + (combo || (isRectKey ? FOCUS_MARQUEE_ID : MARQUEE_CYCLE_ID))
      + '|' + Math.floor(Date.now() / 400);
    void requestMainToggleOff(token)
      .then((st: MainToggleState) => {
        for (const l of hotkeyListeners) { try { l({ combo, action: msg.action, brush: target, ok: true, enabled: st.enabled }); } catch { /* ignore */ } }
      })
      .catch(() => {
        for (const l of hotkeyListeners) { try { l({ combo, action: msg.action, brush: target, ok: true }); } catch { /* ignore */ } }
      });
    return;
  }
  if (msg.action === 'focusClear') {
    // 工具模式下的「清除模式」键（默认 Shift+E）：两件事，互不干扰——
    //   ① 确保主开关开启：MainToggleBus.doToggle 在工具模式下本就是「只开不关」
    //      （已开着则什么都不做）⇒ 无论此前开关是开是关，按下即保证开启；
    //   ② **开启**清除模式（置位，不是翻转）：写 ClearModeBus，APP 面板订阅后把
    //      clearMode 置成 true。⛔ 2026-11-20 用户要求：连按 Shift+E 必须一直是开启，
    //      旧实现（toggle）连按两次会关掉，与「这个键的作用是进入清除模式」相悖。
    //      关闭清除模式走面板上的勾选/开关。
    // ⚠️ 绝不在这一步关主开关 —— 用户明确要求「按 Shift+E 开/关清除模式都不会关主开关」。
    // token 去重同上：同一次命中在所有面板上只各执行一次。
    const combo = msg.combo ?? '';
    const token = 'focusClear|' + (combo || FOCUS_CLEAR_ID) + '|' + Math.floor(Date.now() / 400);
    void requestMainToggle(token)
      .then((st: MainToggleState) => {
        for (const l of hotkeyListeners) { try { l({ combo, action: 'focusClear', ok: true, enabled: st.enabled }); } catch { /* ignore */ } }
      })
      .catch(() => {
        for (const l of hotkeyListeners) { try { l({ combo, action: 'focusClear', ok: false }); } catch { /* ignore */ } }
      });
    void requestClearModeSet('clear|' + token, true)
      .catch((e) => console.error('⚠️ 清除模式命令写入失败:', e));
    // ⛔⛔ 0x022F：**不再无条件切套索** —— 那正是「Shift+E 之后第一笔被吞」的元凶。
    //   0x013D 写这段时（钩子时代）Shift+E 会漏给 PS，PS 自己把工具循环成橡皮擦，
    //   所以「命中即切回套索」是必要补救。现在 Shift+E 带 MOD_SHIFT ⇒
    //   `kh_hk_sync` 走 RegisterHotKey **系统级独占**（pi8li.log 实测「接管 9 条」，
    //   且整场「钩子 +0 / 轮询 +N」= 钩子从未收到过键 ⇒ PS 根本收不到这个键）
    //   ⇒ 漏键前提已不存在，这条 batchPlay 退化成**纯副作用**：
    //     ① 每个面板各发一次：`handleHotkey` 由 N 个面板各自执行，这行没有 token 去重；
    //     ② 直连 batchPlay 被宿主拒时回退 `runAsModal` —— 排队等宿主空闲，
    //        常常在用户抬笔/落笔那一拍才拿到模态锁；
    //     ③ 用户按 Shift+E 时笔经常还搭在板上（jwwh-24148 五次命中全是
    //        `penDown=1 contact=1` + 光标静止），而切工具会**终止正在进行的笔画**，
    //        笔又没抬起 ⇒ 没有新的 pen-down 边沿 ⇒ 接下来那一笔 PS 完全不响应
    //        （套索画圈「毫无现象」），抬笔再落才恢复 = 用户报的「吞笔」。
    //   ⇒ 改成「只在读到的工具确实不是套索时才补救，且延后一拍」，见该函数说明。
    //   ⛔ 不在这里改主开关：用户要求「反复按 Shift+E 只在清除模式间来回切换」。
    reselectLassoIfStrayed();
    return;
  }
  if (msg.action === 'pickColor') {
    // 0x0212：前景色拾色器（功能快捷键子面板的「前景色拾色器」条目，默认 Shift+/）。
    // 直接呼出宿主原生拾色器：初始值就是当前前景色，确认后写回前景色，取消则一动不动。
    // ⛔ 不做 token 去重：这里没有「读-改-写」共享状态（对比 toggleMain），
    //    各面板共用一份订阅表 ⇒ 一次广播只会走到这里一次；重复触发只会开第二个对话框。
    // ⛔ 拾色器是宿主模态框：期间把「临时吸管按住」的按下边沿挡掉（见 pickerBusy）。
    const combo = msg.combo ?? '';
    if (pickerBusy) return;
    pickerBusy = true;
    const broadcast = (ok: boolean) => {
      for (const l of hotkeyListeners) { try { l({ combo, action: 'pickColor', ok }); } catch { /* ignore */ } }
    };
    void pickForegroundColor()
      .then((picked) => broadcast(!!picked))
      .catch(() => broadcast(false))
      .finally(() => {
        if (pickerBusyTimer) clearTimeout(pickerBusyTimer);
        pickerBusyTimer = setTimeout(() => { pickerBusy = false; pickerBusyTimer = null; }, 300);
      });
    return;
  }
  if (msg.action === 'blendMode') {
    // 混合模式热键命中（.8li 装载内置 Alt+Shift 表后广播）：把目标模式写进
    // BlendModeBus，APP 面板据此改「选区填充」的混合模式。PS 原生的改图层/
    // 改工具混合模式已被 C 侧吞键替换，不会同时发生。
    const mode = msg.brush || '';
    if (!mode) return;
    const token = 'blendMode|' + mode + '|' + Math.floor(Date.now() / 400);
    const combo = msg.combo ?? '';
    void requestBlendMode(mode, token)
      .then(() => {
        for (const l of hotkeyListeners) { try { l({ combo, action: 'blendMode', brush: mode, ok: true }); } catch { /* ignore */ } }
      })
      .catch(() => {
        for (const l of hotkeyListeners) { try { l({ combo, action: 'blendMode', brush: mode, ok: false }); } catch { /* ignore */ } }
      });
    return;
  }
  if (msg.action === 'runFunc' && msg.brush === 'fillModeCycle') {
    // 「切换填充模式」快捷键（默认 Ctrl+滚轮）：执行权在 APP 面板（fillMode 是它的 React state），
    // 与 MainToggleBus 同理经共享文件分发 + token 去重——守护进程向所有面板广播同一次命中，
    // 只有第一个写文件的请求生效，APP 面板轮询到新修订号后前进一步，绝不按面板数量连跳。
    //
    // ⛔⛔ 方向口径（2026-11-16 用户要求「反向」）：**滚轮往后转（向下）= 纯色→图案→渐变**，
    //    往上滚 = 往回退一格。
    //    原生 `dir` 是**物理方向**：+1 = 滚轮向上（WHEEL_DELTA 为正）、-1 = 向下。
    //    ⇒ 语义方向 = 物理方向取反，换算**只写在这一行**；要再翻一次就改这一处，别去动 .8li
    //      （那边一旦改，旧面板配新 .8li 就会反过来，A/B 两个版本都不好解释）。
    // ⚠️ 缺省（键盘重录成普通组合键、没有方向）仍按「下一个」处理。
    const rawDir = Number((msg as any).dir);
    const dir: FillModeDir = rawDir > 0 ? -1 : 1;
    /* token 必须**一次命中一个**（而不是「组合键 + 时间桶」）：
       滚轮连续滚动时两格很容易落进同一个 400ms 桶，用时间桶会把第二格误判成
       重复而丢掉（表现就是「快速滚动漏步」）。`seq` 是 .8li 给这条命中编的绝对
       序号，同一命中在所有面板上完全一致 ⇒ 既去重又不会吞掉相邻的两次滚动。
       老 .8li 不带 seq ⇒ 退回时间桶（行为与以前一致，最坏是快速滚动偶有漏步）。 */
    const seq = Number((msg as any).seq);
    const token = isFinite(seq) && seq > 0
      ? 'fillMode|seq|' + seq
      : 'fillMode|' + dir + '|' + Math.floor(Date.now() / 400);
    const combo = msg.combo ?? '';
    void requestFillModeCycle(dir, token)
      .then(() => {
        for (const l of hotkeyListeners) { try { l({ combo, action: 'runFunc', brush: msg.brush!, ok: true }); } catch { /* ignore */ } }
      })
      .catch(() => {
        for (const l of hotkeyListeners) { try { l({ combo, action: 'runFunc', brush: msg.brush!, ok: false }); } catch { /* ignore */ } }
      });
    return;
  }
  if (msg.action === 'brushSizeStep') {
    /* 笔刷大小档位步进（Shift+[ / Shift+]）。
       ⛔⛔ 这里**必须去重**：.8li 把命中广播给所有客户端（#app 与 #pixeladjustment
          各一条 WS），两个 JS 上下文都会走到这里 —— 不去重就是「按一下跳两档」。
          token 用原生的 `seq`（一次命中一个绝对序号，两块面板算出的值必然相同），
          没有 seq 的老 .8li 退回时间桶（与 fillMode 同款兜底）。
          真正的互斥/幂等在 BrushSizePreset 里做（锁文件 + token 状态），
          这里只负责把「同一次命中」翻译成同一个 token。 */
    const dir = msg.brush === 'down' ? -1 : 1;
    const seq = Number((msg as any).seq);
    const token = isFinite(seq) && seq > 0
      ? 'brushSize|seq|' + seq
      : 'brushSize|' + (msg.combo || '') + '|' + Math.floor(Date.now() / 400);
    const combo = msg.combo ?? '';
    void stepBrushSize(dir, token)
      .then((r) => {
        /* 反馈本身不发 notify：画布上的笔尖圆圈当场变大变小就是最直接的反馈，
           每次按键都往通知条灌一行反而在画图时碍眼（用户没要求）。
           事件照发，面板若想做提示可以直接订阅。 */
        for (const l of hotkeyListeners) {
          try { l({ combo, action: 'brushSizeStep', brush: msg.brush, ok: r.ok }); } catch { /* ignore */ }
        }
      })
      .catch((e) => { console.warn('⚠️ 笔刷大小步进失败:', e); });
    return;
  }
  if (msg.action === 'runFunc' && msg.brush) {
    // 功能快捷键：先广播触发反馈（面板据此显示「热键触发：执行…」），再执行对应功能。
    // ok 取决于分发器是否注册了该功能 id；未注册时只打日志，不抛错。
    let ok = false;
    if (funcRunner) {
      try { funcRunner(msg.brush); ok = true; }
      catch (e) { console.error('⚠️ 功能快捷键执行失败（' + msg.brush + '）:', e); }
    } else {
      console.warn('⚠️ 功能快捷键命中但调整面板尚未注册执行器（' + msg.brush + '）');
    }
    for (const l of hotkeyListeners) { try { l({ combo: msg.combo ?? '', action: 'runFunc', brush: msg.brush, ok }); } catch { /* ignore */ } }
    return;
  }
  if (msg.action === 'applyBrush' && msg.brush) {
    // 守护进程按组合键命中后回传笔刷名，按名称选中对应笔刷预设。
    applyBrush(msg.brush).then((ok) => {
      // 把触发结果广播给 UI：用户按快捷键后面板立刻显示是否命中、切换是否成功
      for (const l of hotkeyListeners) { try { l({ combo: msg.combo ?? '', action: 'applyBrush', brush: msg.brush, ok }); } catch { /* ignore */ } }
    });
  }
}

export function getConfig(): HotkeyEntry[] {
  return cachedConfig.slice();
}

// 推送整套配置给守护进程（由它落盘并热更新热键）
export function pushConfig(list: HotkeyEntry[]): boolean {
  cachedConfig = list.slice();
  emitConfig();
  // ⛔ 路径未就绪时**绝不落盘**：守护进程此刻还不知道该写哪份配置（会落到默认路径），
  //    写下去就是把用户真配置覆盖成默认值 —— 2026-10-13「热键全没了」的实际成因。
  if (!canPersistConfig()) {
    console.warn('⚠️ 配置文件路径尚未就绪，已跳过本次落盘（界面仍会显示你刚做的改动，服务就绪后请再确认一次）');
    return false;
  }
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'config', payload: list }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 主动向 .8li 重新拉取一次配置（`getConfig`）。
 *
 * ⛔ 为什么需要它（2026-11-16）：热键录制 UI 现在有**两处**（绘画工具箱「功能快捷键」、
 *    选区填充「自定义快捷键」），而两块面板跑在**各自的 JS 上下文**里，各存一份
 *    `cachedConfig`；原生侧收到 `config` 只落盘、**不广播**给其它客户端
 *    （keyhook.c 的 config 分支）。于是「在一块里改了、另一块的缓存还是旧的」——
 *    若那块接着回写，就等于用旧列表整份覆盖，把刚才的改动抹掉。
 *    ⇒ 每次打开子面板先拉一次真值，把「陈旧窗口」压到「两块面板同时开着且交替编辑」
 *      这个本来就自相矛盾的场景（那种场景下最后一笔为准，与旧版行为一致）。
 * ⚠️ 原生 getConfig 会顺带重建热键表（幂等），代价可忽略；不在定时器里调用。
 */
export function requestConfigRefresh(): boolean {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'getConfig' }));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ===== 主开关快捷键 =====

/**
 * 保证配置里始终存在「主开关」条目。
 * - 已有该条目：仅同步内部的 combo 缓存（combo 为 '' 表示已解绑，不再补回默认）。
 * - 没有该条目：判定为首次使用，写入默认的 Ctrl+Q 并推送给守护进程。
 * 只在收到守护进程配置后调用，因此不会在守护进程未连接时空转。
 */
function ensureMainToggleEntry(): void {
  const existing = cachedConfig.find(e => e.action === 'toggleMain');
  if (existing) {
    mainToggleCombo = existing.combo || '';
    return;
  }
  mainToggleCombo = DEFAULT_MAIN_TOGGLE_COMBO;
  const entry: HotkeyEntry = {
    id: MAIN_TOGGLE_ID,
    combo: DEFAULT_MAIN_TOGGLE_COMBO,
    action: 'toggleMain'
  };
  cachedConfig = [entry, ...cachedConfig];
  pushConfig(cachedConfig);
}

/** 当前主开关快捷键；'' 表示未绑定，null 表示还没读到过配置。 */
export function getMainToggleCombo(): string {
  return mainToggleCombo ?? '';
}

// ===== 工具模式：套索工具键（默认 L，「按下即退出自动填充」）=====

/**
 * 确保配置里存在「套索工具」条目，并让它只在工具模式开启时处于装载态。
 *
 * ⚠️ 只应由 APP 面板的上下文真正写入（仅它会调用 setFocusLassoActive）——
 *    其它面板上下文里 focusLassoKnown 恒为 false，若也参与写入，两个面板会在
 *    'L' / '' 之间来回覆盖（与 MainToggleBus 的多面板「事件被重复投递」问题同源）。
 *
 * 记忆值放在 brush 字段：工具模式关闭时 combo 置空（守护进程跳过注册 ⇒ L 完全交给 PS），
 * 但用户自定义过的键仍被记住，下次开启工具模式时沿用。
 */
function ensureFocusLassoEntry(): void {
  if (!configLoaded || !focusLassoKnown) return;
  const idx = cachedConfig.findIndex(e => e.action === 'focusLasso');
  const existing = idx >= 0 ? cachedConfig[idx] : undefined;
  const remembered = (existing && (existing.brush || existing.combo)) || DEFAULT_FOCUS_LASSO_COMBO;
  const desiredCombo = focusLassoActive ? remembered : '';
  if (existing && existing.id === FOCUS_LASSO_ID && existing.combo === desiredCombo && existing.brush === remembered) return;
  const desired: HotkeyEntry = { id: FOCUS_LASSO_ID, combo: desiredCombo, action: 'focusLasso', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

/** APP 面板在工具模式状态变化时调用，决定套索键是否装载（其它面板绝不调用）。 */
export function setFocusLassoActive(on: boolean): void {
  focusLassoKnown = true;
  focusLassoActive = on;
  ensureFocusLassoEntry();
}

/** 当前套索键（用于提示/展示；工具模式关闭时返回记忆值）。 */
export function getFocusLassoCombo(): string {
  const e = cachedConfig.find(x => x.action === 'focusLasso');
  return e?.brush || e?.combo || DEFAULT_FOCUS_LASSO_COMBO;
}

/**
 * 重绑套索键（功能快捷键子面板用）：同时更新生效值 combo 与记忆值 brush。
 *
 * ⚠️ 该函数会在**绘画工具箱面板**的上下文里被调用（FuncHotkeyPanel 挂在那里），
 *    那里 focusLassoKnown 恒为 false，所以**不能**用 focusLassoKnown 做闸门——
 *    否则重绑会静默失效。装载与否改由调用方传入的 active（= 面板自己看到的工具模式状态）决定。
 */
export function setFocusLassoCombo(combo: string, active: boolean): void {
  if (!configLoaded) return;
  const remembered = combo || DEFAULT_FOCUS_LASSO_COMBO;
  const idx = cachedConfig.findIndex(e => e.action === 'focusLasso');
  const desired: HotkeyEntry = { id: FOCUS_LASSO_ID, combo: active ? remembered : '', action: 'focusLasso', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

// ===== 工具模式：「切换套索工具」键（默认 Shift+L，2026-11-16 新增）=====
// 语义（用户要求）：在套索组内循环 —— 普通套索 → 多边形套索 → 磁性套索 → 普通套索。
//
// ⛔ 为什么由插件自己做，而不是交给 PS 原生的 Shift+L：
//    PS 的「按 Shift+字母循环同组工具」在 L 上不生效（用户真机确认：其它工具的
//    Shift+字母都能循环，只有 L 不动；首选项「使用 Shift 键切换工具」已勾选）。
//    而 L 恰好是本插件**全程接管**的键（工具模式：按 L 关主开关 + 切回套索）
//    ⇒ 这一组工具的原生循环在接管之后就不存在了，只能由插件补上。
//
// ⛔ 为什么做成**普通配置条目**（而不是原生侧硬编码）：
//    ① 它和其它工具模式键（L / Shift+E / `/`）同规矩：只在工具模式开启时装载，
//       关闭时 combo 置空 ⇒ 不注册、不摘键，PS 原生行为原样保留；
//    ② 有条目才会被 `.8li` 的 RegisterHotKey **系统级独占**（PS 前台时），
//       于是 PS 收不到这个键 ⇒ 不会出现「PS 循环一次 + 插件再循环一次」的双跳；
//    ③ 用户能在本子面板里重录（换成别的组合键）。
//
// ⛔ 循环游标由本模块维护，**不依赖** `app.currentTool`：
//    PS 的多边形/磁性套索在某些版本里是「临时模式」——`application.tool` 仍报
//    `lassoTool`（见 keyhook.c 的 0x0211 段实证），拿它当游标会永远停在第二格。
//    ⇒ 只在「游标未初始化」时用它校准，之后一律按游标推进。
export const LASSO_CYCLE_ID = 'lasso_cycle';
export const DEFAULT_LASSO_CYCLE_COMBO = 'Shift+L';
/** 组内顺序必须与 PS 工具栏的下拉顺序一致（Shift+L 的语义就是「下一个」）。 */
const LASSO_GROUP: ToolRef[] = ['lassoTool', 'polySelTool', 'magneticLassoTool'];
let lassoCycleActive = false;   // 工具模式是否开启（仅 APP 面板会写）
let lassoCycleKnown = false;    // 是否由 APP 面板明确过工具模式状态
/** 循环游标：组内下标；-1 = 未初始化（下一次按键时按当前工具校准）。 */
let lassoCycleIdx = -1;

/**
 * 确保配置里存在「切换套索工具」条目，并让它只在工具模式开启时处于装载态。
 * 与 `ensureFocusLassoEntry` 同款的多面板写护栏（`lassoCycleKnown` 门禁）：
 * 只有 APP 面板的上下文会真正写入，别的面板只读不改。
 */
function ensureLassoCycleEntry(): void {
  if (!configLoaded || !lassoCycleKnown) return;
  const idx = cachedConfig.findIndex(e => e.action === 'lassoCycle');
  const existing = idx >= 0 ? cachedConfig[idx] : undefined;
  const remembered = (existing && (existing.brush || existing.combo)) || DEFAULT_LASSO_CYCLE_COMBO;
  const desiredCombo = lassoCycleActive ? remembered : '';
  if (existing && existing.id === LASSO_CYCLE_ID && existing.combo === desiredCombo && existing.brush === remembered) return;
  const desired: HotkeyEntry = { id: LASSO_CYCLE_ID, combo: desiredCombo, action: 'lassoCycle', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

/** APP 面板在工具模式状态变化时调用，决定「切换套索工具」键是否装载（其它面板绝不调用）。 */
export function setLassoCycleActive(on: boolean): void {
  lassoCycleKnown = true;
  lassoCycleActive = on;
  // 工具模式一翻面就重新校准游标：用户可能已经用鼠标换了组内工具。
  lassoCycleIdx = -1;
  ensureLassoCycleEntry();
}

/** 当前「切换套索工具」键（用于提示/展示；工具模式关闭时返回记忆值）。 */
export function getLassoCycleCombo(): string {
  const e = cachedConfig.find(x => x.action === 'lassoCycle');
  return e?.brush || e?.combo || DEFAULT_LASSO_CYCLE_COMBO;
}

/**
 * 重绑「切换套索工具」键（自定义快捷键子面板用）：同时更新生效值 combo 与记忆值 brush。
 * ⚠️ 与 `setFocusLassoCombo` 同理：本函数会在**绘画工具箱面板**的上下文里被调用，
 *    那里 `lassoCycleKnown` 恒为 false ⇒ 装载与否由调用方传入的 active 决定。
 */
export function setLassoCycleCombo(combo: string, active: boolean): void {
  if (!configLoaded) return;
  const remembered = combo || DEFAULT_LASSO_CYCLE_COMBO;
  const idx = cachedConfig.findIndex(e => e.action === 'lassoCycle');
  const desired: HotkeyEntry = { id: LASSO_CYCLE_ID, combo: active ? remembered : '', action: 'lassoCycle', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

/**
 * 组内循环一格（Shift+L 命中时调用）。
 *
 * ⛔ 只发一次 `select`，不做任何「先检查再决定」的兜底：这个键由我们独占，
 *    PS 收不到 ⇒ 不存在「PS 也切了一次」的可能，多发一次就等于跳一格。
 * ⛔ 读不到工具时**不放弃**（与「不知道就别碰工具」的其它路径不同）：
 *    这里的语义就是「用户按了循环键」，什么都不做才是 bug；游标会给出确定的下一格。
 */
function cycleLassoTool(): ToolRef {
  if (lassoCycleIdx < 0) {
    const cur = readToolIdSync();
    const i = cur ? LASSO_GROUP.indexOf(cur as ToolRef) : -1;
    lassoCycleIdx = i >= 0 ? i : 0;
  }
  lassoCycleIdx = (lassoCycleIdx + 1) % LASSO_GROUP.length;
  const target = LASSO_GROUP[lassoCycleIdx];
  console.log('[套索组循环] ⇒ ' + target);
  /* ⛔ 失败必须留痕：`select` 遇到**不存在的引用名**是静默无效（不抛错、工具不动），
     「Shift+L 少一格」正是这样藏了一轮没人发现。留一行 warn，下次一眼就能分出
     是名字错还是命令被宿主拒绝。 */
  void selectToolByRef(target).then(ok => {
    if (!ok) console.warn('[套索组循环] 切换失败（' + target + '）：引用名可能不被当前 PS 版本接受');
  });
  /* 返回值 = 这次要切到的工具。面板侧要拿它做两件事：
     ① 记下「新的当前工具」（H / Shift+E 的判据马上要用，等不到 1s 巡检）；
     ② 提示文案里说清「切到了哪一个」。 */
  return target;
}

/**
 * 把组内循环游标与「外部已经发生的工具切换」对齐（面板切了工具就调一次）。
 *
 * ⛔ 为什么需要：游标住在本模块里，而**面板自己**也会切工具 —— 关总开关时退回普通套索
 *    （`App.selectLassoTool`）、按 L 切回套索、临时吸管松开切回、用户用鼠标点工具栏。
 *    这些都不经过 `cycleLassoTool`，游标就会停在旧的一格上，下一次 Shift+L 直接跳过一格。
 * ⚠️ 传 null（当前工具未知）⇒ 游标置 -1，下一次按键按当时的真实工具重新校准。
 *
 * 2026-11-16：本函数升格为**三条工具循环**的统一校准点（套索组 / 五工具组 / 选框组）。
 * 三组游标各自独立，但都由同一次「面板确认到的真实工具」对齐 —— 面板只调这一个入口
 * （`App.noteRealTool`），免得哪天多加一组忘了同步而出现「偶发跳一格」。
 * ⚠️ 某组不含当前工具时该组游标置 -1（下次按键按真实工具重新校准），不是停在旧值。
 */
export function syncToolCursors(tool: string | null): void {
  const low = tool ? tool.toLowerCase() : '';
  const idxOf = (group: ToolRef[]): number =>
    low ? group.findIndex(r => r.toLowerCase() === low) : -1;
  const li = idxOf(LASSO_GROUP);       lassoCycleIdx = li >= 0 ? li : -1;
  const fi = idxOf(FILL_TOOL_GROUP);   fillToolCycleIdx = fi >= 0 ? fi : -1;
  const mi = idxOf(MARQUEE_GROUP);     marqueeCycleIdx = mi >= 0 ? mi : -1;
}

/** 旧名保留：套索组循环游标的单独同步（新代码一律用 `syncToolCursors`）。 */
export function syncLassoCycleCursor(tool: string | null): void {
  syncToolCursors(tool);
}

/* ⛔⛔ 2026-11-16：本模块**自己**切工具时的「抑制位」。
 *
 * 场景：新加的两组工具键（Shift+H / M / Shift+M）会在切工具的同时改主开关。
 * 而 APP 面板的 `onMainToggleChanged` 里有两处「顺手切工具」的既有逻辑：
 *   ① 关→开且勾了「自动切套索」⇒ 切回套索（这会把 Shift+H 刚切到的工具拽走）；
 *   ② 开→关且当前停在多边/磁性套索 ⇒ 切回套索（这会把 M / Shift+M 刚切到的选框拽走）。
 * 两条逻辑本身都对（它们服务的是 H 键与鼠标换工具），但**不该覆盖用户刚按下的工具键**。
 *
 * ⇒ 凡本模块主动切工具，先在这里打一记时间戳；面板在 1.5s 内跳过上面两条。
 * ⚠️ 用时窗而不是布尔位：布尔位一旦漏清就会永久失效（本项目吃过的亏），
 *    时窗最坏是多一次「没顺手切回套索」，用户下一条命令就会自愈。
 */
let selfToolSwitchAt = 0;
function noteSelfToolSwitch(): void { selfToolSwitchAt = Date.now(); }
/** 最近 1.5s 内本模块是否自己切过工具（面板据此跳过「顺手切工具」）。 */
export function hotkeyToolSwitchRecent(ms: number = 1500): boolean {
  return selfToolSwitchAt > 0 && (Date.now() - selfToolSwitchAt) < ms;
}
/** 2026-11-17：拍照片内部的连续 select 会刷新上面的抑制位；拍完必须清掉，
 *  否则 H 键「关→开切套索」会被这 1.5s 时窗误挡，停在画笔上不回套索。 */
function clearSelfToolSwitch(): void { selfToolSwitchAt = 0; }

/* ==========================================================================
   工具模式：新增三组「工具键」（2026-11-16，用户要求）
   --------------------------------------------------------------------------
   ① fillToolCycle（默认 Shift+H）「切换选区填充」：五个选区工具按顺序循环 ——
      套索 → 多边形套索 → 磁性套索 → 椭圆选框 → 矩形选框 → 套索…
      并按一次就**确保选区填充主开关开启**（工具模式下 requestMainToggle 只开不关）。
      ⛔ 绝不走「自动关」：用户原话「按切换选区填充这个快捷键切换工具，不会触发
         自动关开关，自动填充总开关始终保证开启」。
   ② focusMarquee（默认 M）「矩形选框工具」：切到矩形选框 + **关闭**主开关
      （确保停在「原本的选框」上，不会触发自动填充）。
   ③ marqueeCycle（默认 Shift+M）「切换选框工具」：矩形 ↔ 椭圆之间来回，同样关主开关。
   --------------------------------------------------------------------------
   三者的共同约定（与 L / Shift+L 完全一致）：
   · **只在工具模式开启时装载**（combo 非空）；关闭时 combo 置空 ⇒ 不注册、不摘键，
     PS 原生 M / Shift+M 原样保留；
   · 用户自定义过的键记忆在 `brush` 字段（工具模式关闭时 combo 为空、记忆不丢）；
   · 条目必须真实存在于配置里，才会被 `.8li` 的 RegisterHotKey 系统级独占
     （否则 PS 会同时处理 Shift+M，出现双跳）。
   ⛔ 三个键的「条目装载」逻辑完全同构 ⇒ 抽成 ToolKeySpec + 一组公共函数，
      不再复制第三、第四份 ensure/get/set（复制必然漂移）。
   ========================================================================== */
export const FILL_TOOL_CYCLE_ID = 'fill_tool_cycle';
export const DEFAULT_FILL_TOOL_CYCLE_COMBO = 'Shift+H';
export const FOCUS_MARQUEE_ID = 'marquee_tool';
export const DEFAULT_FOCUS_MARQUEE_COMBO = 'M';
export const MARQUEE_CYCLE_ID = 'marquee_cycle';
export const DEFAULT_MARQUEE_CYCLE_COMBO = 'Shift+M';

/** 五个选区工具的循环顺序（用户指定：套索 → 多边形 → 磁性 → 椭圆选框 → 矩形选框）。 */
const FILL_TOOL_GROUP: ToolRef[] = [
  'lassoTool', 'polySelTool', 'magneticLassoTool', 'marqueeEllipTool', 'marqueeRectTool',
];
/** 选框组（矩形 ↔ 椭圆，M / Shift+M 的组内循环只有这两格）。 */
const MARQUEE_GROUP: ToolRef[] = ['marqueeRectTool', 'marqueeEllipTool'];

let fillToolCycleIdx = -1;   // -1 = 未初始化（下一次按键按当前工具校准）
let marqueeCycleIdx = -1;

interface ToolKeySpec {
  id: string;
  action: HotkeyEntry['action'];
  def: string;
  /** 记录「哪个面板明确过工具模式状态」⇒ 只有 APP 面板会真正写配置（多面板写护栏）。 */
  known: boolean;
  active: boolean;
  /** 面板上那一行的显示名（提示文案用，与 FuncHotkeyPanel 保持一致）。 */
  label: string;
}

const TOOL_KEY_FILL_CYCLE: ToolKeySpec = {
  id: FILL_TOOL_CYCLE_ID, action: 'fillToolCycle', def: DEFAULT_FILL_TOOL_CYCLE_COMBO,
  known: false, active: false, label: '切换选区填充',
};
const TOOL_KEY_MARQUEE: ToolKeySpec = {
  id: FOCUS_MARQUEE_ID, action: 'focusMarquee', def: DEFAULT_FOCUS_MARQUEE_COMBO,
  known: false, active: false, label: '矩形选框工具',
};
const TOOL_KEY_MARQUEE_CYCLE: ToolKeySpec = {
  id: MARQUEE_CYCLE_ID, action: 'marqueeCycle', def: DEFAULT_MARQUEE_CYCLE_COMBO,
  known: false, active: false, label: '切换选框工具',
};

/** 确保某条工具键条目存在，并让它只在工具模式开启时处于装载态。 */
function ensureToolKeyEntry(spec: ToolKeySpec): void {
  if (!configLoaded || !spec.known) return;
  const idx = cachedConfig.findIndex(e => e.action === spec.action);
  const existing = idx >= 0 ? cachedConfig[idx] : undefined;
  const remembered = (existing && (existing.brush || existing.combo)) || spec.def;
  const desiredCombo = spec.active ? remembered : '';
  if (existing && existing.id === spec.id && existing.combo === desiredCombo && existing.brush === remembered) return;
  const desired: HotkeyEntry = { id: spec.id, combo: desiredCombo, action: spec.action, brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

function setToolKeyActive(spec: ToolKeySpec, on: boolean): void {
  spec.known = true;
  spec.active = on;
  ensureToolKeyEntry(spec);
}

/** 当前生效键（工具模式关闭时返回记忆值，供面板显示）。 */
function readToolKeyCombo(spec: ToolKeySpec): string {
  const e = cachedConfig.find(x => x.action === spec.action);
  return e?.brush || e?.combo || spec.def;
}

/** 重绑（自定义快捷键子面板用）：同时更新生效值 combo 与记忆值 brush。 */
function writeToolKeyCombo(spec: ToolKeySpec, combo: string, active: boolean): void {
  if (!configLoaded) return;
  const remembered = combo || spec.def;
  const idx = cachedConfig.findIndex(e => e.action === spec.action);
  const desired: HotkeyEntry = { id: spec.id, combo: active ? remembered : '', action: spec.action, brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

// ——「切换选区填充」键 ——
export function setFillToolCycleActive(on: boolean): void {
  setToolKeyActive(TOOL_KEY_FILL_CYCLE, on);
  fillToolCycleIdx = -1;   // 工具模式翻面就重新校准（用户可能已用鼠标换了工具）
}
export function getFillToolCycleCombo(): string { return readToolKeyCombo(TOOL_KEY_FILL_CYCLE); }
export function setFillToolCycleCombo(combo: string, active: boolean): void {
  writeToolKeyCombo(TOOL_KEY_FILL_CYCLE, combo, active);
}

// ——「矩形选框工具」键 ——
export function setFocusMarqueeActive(on: boolean): void {
  setToolKeyActive(TOOL_KEY_MARQUEE, on);
}
export function getFocusMarqueeCombo(): string { return readToolKeyCombo(TOOL_KEY_MARQUEE); }
export function setFocusMarqueeCombo(combo: string, active: boolean): void {
  writeToolKeyCombo(TOOL_KEY_MARQUEE, combo, active);
}

// ——「切换选框工具」键 ——
export function setMarqueeCycleActive(on: boolean): void {
  setToolKeyActive(TOOL_KEY_MARQUEE_CYCLE, on);
  marqueeCycleIdx = -1;
}
export function getMarqueeCycleCombo(): string { return readToolKeyCombo(TOOL_KEY_MARQUEE_CYCLE); }
export function setMarqueeCycleCombo(combo: string, active: boolean): void {
  writeToolKeyCombo(TOOL_KEY_MARQUEE_CYCLE, combo, active);
}

/**
 * 切到指定工具（**无条件发一条 `select`**，只做失败留痕）。
 *
 * ⛔⛔ 为什么不像 `selectLassoIfStrayed()` 那样「已经是目标工具就跳过」（0x0235 的反面）：
 *    这里的键与 PS **原生键同组**：
 *      · 裸键 `M` 不被我们吞（裸字母走钩子/轮询，PS 前台时钩子收不到）⇒ PS 会**同步**
 *        把选框组循环一格（矩形 → 椭圆），而我们的 `select` 是**排队**的 ⇒ 永远落在
 *        PS 之后，于是「无条件发 rect」的结果是确定的「矩形」；
 *      · 而「已在矩形就跳过」会在 `Shift+M → M` 这种连击里出错：Shift+M 的 select(椭圆)
 *        还在队列里，PS 已把工具循环回矩形，此刻读到的正是矩形 ⇒ 跳过 ⇒ 队列里的椭圆
 *        最后落地 ⇒ 用户按了 M 却停在椭圆上。
 *    ⇒ 结论：本键必须在**每次按键**都发一条明确的目标命令（命令 FIFO 保证最后一格是
 *      用户最后按下的那个键），这也是「确保它们都是原本的选框」的字面要求。
 *    ⚠️ 代价只有一条幂等命令，不会吞笔（切工具本身仍会终止笔画，这是 PS 的行为，
 *      与本函数的写法无关）。
 */
function switchToolTo(target: ToolRef, tag: string): void {
  void selectToolByRef(target).then(ok => {
    if (!ok) console.warn('[' + tag + '] 切换失败（' + target + '）：引用名可能不被当前 PS 版本接受');
  });
}

/**
 * 五工具循环「算目标 + 推进游标」的纯函数（Shift+H 命中时调用）。
 * ⛔ 2026-11-17：**只算目标、不切工具** —— 实际切工具交给 enterAutoFill 按用户指定的
 *    「切套索/拍照」顺序串行完成。若这里再异步 switchToolTo，会与拍照片内部的 select 并发打架。
 * ⛔ 必须在拍照片**之前**调用：它按当前工具校准游标；拍照片会连切五种工具改写当前工具。
 * ⛔ 循环顺序固定为 FILL_TOOL_GROUP（用户指定），不读工具栏图标顺序 —— 选框与套索
 *    在工具栏里分属两个组，没有「自然顺序」可言，只能按需求写死一份。
 */
function nextFillToolTarget(): ToolRef {
  if (fillToolCycleIdx < 0) {
    const cur = readToolIdSync();
    const i = cur ? FILL_TOOL_GROUP.findIndex(r => r.toLowerCase() === cur.toLowerCase()) : -1;
    fillToolCycleIdx = i >= 0 ? i : 0;
  }
  fillToolCycleIdx = (fillToolCycleIdx + 1) % FILL_TOOL_GROUP.length;
  const target = FILL_TOOL_GROUP[fillToolCycleIdx];
  console.log('[选区填充工具循环] ⇒ ' + target);
  return target;
}

/**
 * 选框组循环一格（Shift+M 命中时调用）：矩形 ↔ 椭圆。
 * ⚠️ 当前工具不在选框组里时（未知 / 停在套索上）从**椭圆**起步：
 *    用户按 M 已经落到矩形（矩形选框工具键），紧接着按 Shift+M 的意图就是「换另一个」。
 */
function cycleMarqueeTool(): ToolRef {
  if (marqueeCycleIdx < 0) {
    const cur = readToolIdSync();
    marqueeCycleIdx = (cur && cur.toLowerCase() === 'marqueeellipTool') ? 1 : 0;
  }
  marqueeCycleIdx = (marqueeCycleIdx + 1) % MARQUEE_GROUP.length;
  const target = MARQUEE_GROUP[marqueeCycleIdx];
  console.log('[选框组循环] ⇒ ' + target);
  noteSelfToolSwitch();
  switchToolTo(target, '选框组循环');
  return target;
}

/** 工具模式「矩形选框工具」键：强制落到矩形选框（不循环 —— 用户要的就是「原本的矩形选框」）。 */
function focusRectMarquee(): ToolRef {
  const target: ToolRef = 'marqueeRectTool';
  marqueeCycleIdx = 0;      // 已落到矩形 ⇒ 组内游标同步（下一次 Shift+M 去椭圆）
  noteSelfToolSwitch();
  switchToolTo(target, '矩形选框工具键');
  return target;
}

/** 是否已连上守护进程（菜单里「设置主开关快捷键」需要据此给出提示）。 */
export function isDaemonConnected(): boolean {
  return connected;
}

// ===== 工具模式：「清除模式」键（默认 Shift+E，2026-10-19 新增）=====
// 语义（用户原话）：无论主开关是关闭或开启，按下 Shift+E 都会开启主开关；
// 主开关开启时按 Shift+E **只开启清除模式**（置位，不翻转 —— 2026-11-20 改），
// 绝不关闭主开关，也不会把清除模式关掉。
// 实现走两条既有总线：
//   ① requestMainToggle —— MainToggleBus.doToggle 在工具模式下本就是「只开不关」
//      （见该文件 focus 分支），已开着则什么都不做，完美匹配「确保开启」；
//   ② requestClearModeSet(token, true) —— 清除模式置位命令（APP 面板订阅后写 state）。
// 该键与套索工具键同规矩：**只在工具模式开启时装载**（combo 非空），关闭时置空、
// 由守护进程跳过注册，从而完全不影响 PS 原生的 Shift+E（正常是「反选」的变体键位，
// 工具模式外绝不拦截）。用户自定义过的键记忆在 brush 字段。
export const FOCUS_CLEAR_ID = 'focus_clear';
export const DEFAULT_FOCUS_CLEAR_COMBO = 'Shift+E';
let focusClearActive = false;   // 工具模式是否开启（仅 APP 面板会写）
let focusClearKnown = false;    // 是否由 APP 面板明确过工具模式状态

/**
 * 确保配置里存在「清除模式」条目，并让它只在工具模式开启时处于装载态。
 * 只应由 APP 面板的上下文真正写入（仅它会调用 setFocusClearActive）——
 * 与套索工具键同款的多面板写护栏（focusClearKnown 门禁）。
 */
function ensureFocusClearEntry(): void {
  if (!configLoaded || !focusClearKnown) return;
  const idx = cachedConfig.findIndex(e => e.action === 'focusClear');
  const existing = idx >= 0 ? cachedConfig[idx] : undefined;
  const remembered = (existing && (existing.brush || existing.combo)) || DEFAULT_FOCUS_CLEAR_COMBO;
  const desiredCombo = focusClearActive ? remembered : '';
  if (existing && existing.id === FOCUS_CLEAR_ID && existing.combo === desiredCombo && existing.brush === remembered) return;
  const desired: HotkeyEntry = { id: FOCUS_CLEAR_ID, combo: desiredCombo, action: 'focusClear', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

/** APP 面板在工具模式状态变化时调用，决定清除模式键是否装载（其它面板绝不调用）。 */
export function setFocusClearActive(on: boolean): void {
  focusClearKnown = true;
  focusClearActive = on;
  ensureFocusClearEntry();
}

/** 当前清除模式键（用于提示/展示；工具模式关闭时返回记忆值）。 */
export function getFocusClearCombo(): string {
  const e = cachedConfig.find(x => x.action === 'focusClear');
  return e?.brush || e?.combo || DEFAULT_FOCUS_CLEAR_COMBO;
}

/**
 * 重绑清除模式键（功能快捷键子面板用）：同时更新生效值 combo 与记忆值 brush。
 * ⚠️ 该函数会在**绘画工具箱面板**的上下文里被调用（FuncHotkeyPanel 挂在那里），
 *    那里 focusClearKnown 恒为 false，所以**不能**用 focusClearKnown 做闸门；
 *    装载与否由调用方传入的 active（= 面板自己看到的工具模式状态）决定。
 */
export function setFocusClearCombo(combo: string, active: boolean): void {
  if (!configLoaded) return;
  const remembered = combo || DEFAULT_FOCUS_CLEAR_COMBO;
  const idx = cachedConfig.findIndex(e => e.action === 'focusClear');
  const desired: HotkeyEntry = { id: FOCUS_CLEAR_ID, combo: active ? remembered : '', action: 'focusClear', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

// ===== 工具模式：「临时吸管」按住键（默认 /，2026-10-28 新增）=====
// 语义（用户原话）：工具模式下、当前工具是套索、总开关开着时，**按住**该键临时切到
// 吸管取样，松开自动切回套索，总开关保持「开」。
//
// ⛔ 为什么从 Alt 换成 `/`：套索工具下按 Alt 是 PS 原生的「临时切多边形套索」，
//    和临时吸管抢同一个键 —— 按下 Alt 时两个功能同时生效，谁都不对。
//
// 与套索 / 清除键同规矩：只在工具模式开启时装载（combo 非空），关闭时置空，
// 用户自定义过的键记忆在 brush 字段。**语义差别**：那两个键是「按一下」，
// 这个是「按住」⇒ .8li 侧不把它放进热键匹配表（不吞键、不注册 RegisterHotKey），
// 只按电平轮询后推 `altHold` 边沿（见 keyhook.c 的 0x0210）。
export const ALT_TOOL_ID = 'alt_tool';
export const DEFAULT_ALT_TOOL_COMBO = '/';
let altToolActive = false;      // 工具模式是否开启（仅 APP 面板会写）
let altToolKnown = false;       // 是否由 APP 面板明确过工具模式状态

/**
 * 确保配置里存在「临时吸管」条目，并让它只在工具模式开启时处于装载态。
 * 只应由 APP 面板的上下文真正写入（仅它会调用 setAltToolActive）。
 */
function ensureAltToolEntry(): void {
  if (!configLoaded || !altToolKnown) return;
  const idx = cachedConfig.findIndex(e => e.action === 'altTool');
  const existing = idx >= 0 ? cachedConfig[idx] : undefined;
  const remembered = (existing && (existing.brush || existing.combo)) || DEFAULT_ALT_TOOL_COMBO;
  const desiredCombo = altToolActive ? remembered : '';
  if (existing && existing.id === ALT_TOOL_ID && existing.combo === desiredCombo && existing.brush === remembered) return;
  const desired: HotkeyEntry = { id: ALT_TOOL_ID, combo: desiredCombo, action: 'altTool', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

/** APP 面板在工具模式状态变化时调用，决定临时吸管键是否装载（其它面板绝不调用）。 */
export function setAltToolActive(on: boolean): void {
  altToolKnown = true;
  altToolActive = on;
  ensureAltToolEntry();
}

/** 当前临时吸管键（用于提示/展示；工具模式关闭时返回记忆值）。 */
export function getAltToolCombo(): string {
  const e = cachedConfig.find(x => x.action === 'altTool');
  return e?.brush || e?.combo || DEFAULT_ALT_TOOL_COMBO;
}

/**
 * 重绑临时吸管键（功能快捷键子面板用）：同时更新生效值 combo 与记忆值 brush。
 * ⚠️ 该函数会在**绘画工具箱面板**的上下文里被调用（FuncHotkeyPanel 挂在那里），
 *    那里 altToolKnown 恒为 false，所以**不能**用 altToolKnown 做闸门；
 *    装载与否由调用方传入的 active（= 面板自己看到的工具模式状态）决定。
 */
export function setAltToolCombo(combo: string, active: boolean): void {
  if (!configLoaded) return;
  const remembered = combo || DEFAULT_ALT_TOOL_COMBO;
  const idx = cachedConfig.findIndex(e => e.action === 'altTool');
  const desired: HotkeyEntry = { id: ALT_TOOL_ID, combo: active ? remembered : '', action: 'altTool', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

/**
 * 触发键里是否含 Alt —— 决定「取色结果要不要事后搬色」。
 *
 * 临时吸管原来按的是物理 Alt，PS 会把「Alt + 点击」解释成**取背景色**，
 * 所以要读回背景色写进前景、再把背景复原（见 app.tsx 的 syncAltPickColor）。
 * 默认键 `/` 不含 Alt ⇒ PS 的吸管单击本来就取前景色，一次搬运都不需要
 * （多一次模态只会在用户已经开始画的时候抢宿主主线程）。
 * 只有用户把键重录成含 Alt 的组合时，才恢复那条搬运通路。
 */
export function altToolComboHasAlt(): boolean {
  return /(^|\+)alt(\+|$)/i.test(getAltToolCombo());
}

// ===== 前景色拾色器键（默认 Shift+/，2026-10-29 新增）=====
// 语义（用户原话）：按下即呼出前景色拾色器。**与工具模式无关** —— 它是通用工具，
// 任何时候都该能用（对照：套索 / 清除 / 临时吸管三者只在工具模式下装载）。
//
// ⛔ 它是**普通热键**（「按一下」），照常进热键匹配表、由 RegisterHotKey 接管并吞键 ——
//    与 altTool 那条「按住键不进表」恰好相反：按住键要自己读电平，按一下的键越早吞越好，
//    否则 Shift+/ 漏给 PS 会顺带触发 PS 自己的绑定。
// ⛔ 与按住键 `/` 的共存由**原生侧**保证（0x0212：修饰键完全匹配 + 一次性起按准入），
//    面板这里只额外拦一种真冲突：把它录成与临时吸管**完全相同**的组合键。
export const PICK_COLOR_ID = 'pick_color';
export const DEFAULT_PICK_COLOR_COMBO = 'Shift+/';

/**
 * 确保配置里存在「前景色拾色器」条目，且**始终**处于装载态（combo 恒为记忆值）。
 *
 * ⚠️ 这是本文件里唯一不按工具模式启停的 ensure*：各面板的配置帧都会走到它，
 *    但内容完全由缓存帧算出、写回的也是同一份 ⇒ 多个面板同帧写入等价
 *    （不涉及「读-改-写」竞态，与 toggleMain 那类翻转型热键不同）。
 */
function ensurePickColorEntry(): void {
  if (!configLoaded) return;
  const idx = cachedConfig.findIndex(e => e.action === 'pickColor');
  const existing = idx >= 0 ? cachedConfig[idx] : undefined;
  const remembered = (existing && (existing.brush || existing.combo)) || DEFAULT_PICK_COLOR_COMBO;
  if (existing && existing.id === PICK_COLOR_ID && existing.combo === remembered && existing.brush === remembered) return;
  const desired: HotkeyEntry = { id: PICK_COLOR_ID, combo: remembered, action: 'pickColor', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

/** 当前前景色拾色器键（用于提示/展示）。 */
export function getPickColorCombo(): string {
  const e = cachedConfig.find(x => x.action === 'pickColor');
  return e?.brush || e?.combo || DEFAULT_PICK_COLOR_COMBO;
}

/** 重绑前景色拾色器键（功能快捷键子面板用）：同时更新生效值 combo 与记忆值 brush。 */
export function setPickColorCombo(combo: string): void {
  if (!configLoaded) return;
  const remembered = combo || DEFAULT_PICK_COLOR_COMBO;
  const idx = cachedConfig.findIndex(e => e.action === 'pickColor');
  const desired: HotkeyEntry = { id: PICK_COLOR_ID, combo: remembered, action: 'pickColor', brush: remembered };
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

// ===== 切换填充模式（默认 Ctrl+滚轮，2026-11-16 新增）=====
/**
 * 「切换填充模式」条目的默认组合键。
 *
 * ⛔ 这是一个**滚轮**组合，不是按键组合：`.8li` 的键盘钩子注册不了它
 *    （RegisterHotKey 只认 vk），必须由 `WH_MOUSE_LL` 的 WM_MOUSEWHEEL 分支处理
 *    （见 keyhook.c 的 0x0235 段）。界面上照样当普通热键显示/重录。
 * ⛔ 修饰键必须**完全匹配**：只有「Ctrl 按着 ∧ Alt/Shift/Win 全抬着」的滚轮才会被
 *    接管并吞掉；裸滚轮、Shift+滚轮、Alt+滚轮一律原样透传给 PS
 *    —— 用户明确要求「不要让我无法使用滚轮缩放画布」。
 */
export const FILL_MODE_CYCLE_ID = 'fill_mode_cycle';
export const DEFAULT_FILL_MODE_CYCLE_COMBO = 'Ctrl+Wheel';

/**
 * 确保配置里存在「切换填充模式」条目（默认 Ctrl+滚轮）。
 * 语义与 ensurePickColorEntry 一致：条目已被用户改过就原样保留，只在**完全没有**该
 * 条目时补默认值 —— 于是「用户改成 Alt+Wheel」这类选择不会被默认值覆写。
 */
function ensureFillModeCycleEntry(): void {
  if (!configLoaded) return;
  if (cachedConfig.some(e => e.action === 'runFunc' && e.brush === 'fillModeCycle')) return;
  const desired: HotkeyEntry = {
    id: FILL_MODE_CYCLE_ID,
    combo: DEFAULT_FILL_MODE_CYCLE_COMBO,
    action: 'runFunc',
    brush: 'fillModeCycle',
  };
  const next = [...cachedConfig, desired];
  cachedConfig = next;
  pushConfig(next);
}

/** 当前「切换填充模式」组合键（用于提示/展示）。 */
export function getFillModeCycleCombo(): string {
  const e = cachedConfig.find(x => x.action === 'runFunc' && x.brush === 'fillModeCycle');
  return e?.combo || DEFAULT_FILL_MODE_CYCLE_COMBO;
}

// ===== 混合模式热键总开关（2026-10-19 新增）=====
// 开启后 .8li 把内置的 PS 原生混合模式快捷键（Alt+Shift+N/K/M/… 共 25 条，
// 见 keyhook.c KH_BLEND_DEFS）装进热键匹配表：命中即吞键 + 广播
// action='blendMode'，由本桥接写 BlendModeBus，APP 面板据此改「选区填充」
// 的混合模式 —— PS 原生的「改图层/工具混合模式」被静默替换。
// 开关状态即配置里 blendHotkey 条目的存在性与 combo（'1'=开 / ''=关）：
// 不另设录制（快捷键固定为 PS 原生表），UI 上是一个自绘 switch。
// ⛔ 生效还需「笔刷热键」分区处于布防态（钩子装着才拦得到键）——两者是与关
//    系，任缺一都不会改任何混合模式（UI 提示里会写明）。
export const BLEND_HOTKEY_ID = 'blend_hotkey';

/** 读取混合模式热键开关当前状态（配置帧驱动；未连接时以本地缓存为准）。 */
export function getBlendHotkeyOn(): boolean {
  const e = cachedConfig.find(x => x.action === 'blendHotkey');
  return !!e && !!e.combo;
}

/** 设置混合模式热键开关（写入共享配置，.8li 收 config 帧即热更新热键表）。 */
export function setBlendHotkeyActive(on: boolean): boolean {
  if (!configLoaded) return false;
  const idx = cachedConfig.findIndex(e => e.action === 'blendHotkey');
  const desired: HotkeyEntry = { id: BLEND_HOTKEY_ID, combo: on ? '1' : '', action: 'blendHotkey', brush: '' };
  if (idx >= 0 && cachedConfig[idx].id === BLEND_HOTKEY_ID && cachedConfig[idx].combo === desired.combo) return true;
  const next = idx >= 0 ? cachedConfig.map((e, i) => (i === idx ? desired : e)) : [...cachedConfig, desired];
  cachedConfig = next;
  emitConfig();
  return pushConfig(next);
}

// ===== 笔刷大小预设（2026-11-20 新增）=====
// 需求：APP 面板「自定义快捷键」里一个开关，开启后 Shift+[ 减小 / Shift+] 增大，
// 按「小/中/大」三档跳（划线条 / 铺块面 / 刷背景），档位随文档像素数缩放。
//
// 实现口径（为什么是「写入两条 brushSizeStep 条目」而不是再改一次 .8li）：
//   · .8li 对除 blendHotkey 外的 action **一律不解释、只透传**，热键表是照配置逐条
//     注册的 —— 所以只要把 combo 写成 "Shift+[" / "Shift+]"，原生侧会自动把它们
//     注册成系统级独占热键并广播回来（action 原样带回，brush 承载方向）。
//   · 这样本次功能**不需要重编 .8li、不需要重启 PS**，迭代只在 JS 侧。
//   · 代价：这两条键在开关打开期间由插件独占（PS 原生的 Shift+[ = 减硬度 让位），
//     这正是用户要的语义。名单外的工具按了不做事（见 BrushSizePreset 的工具闸门）。
// 编码与混合模式热键同款：开关条目 combo = '1'（开）/ ''（关），两条步进条目
// 也保留在配置里（combo 置空 = 已解绑，原生跳过注册），开关再打开时无需重建。
export const BRUSH_SIZE_PRESET_ID = 'brush_size_preset';
export const BRUSH_SIZE_STEP_DOWN_ID = 'brush_size_down';
export const BRUSH_SIZE_STEP_UP_ID = 'brush_size_up';
export const DEFAULT_BRUSH_SIZE_DOWN_COMBO = 'Shift+[';
export const DEFAULT_BRUSH_SIZE_UP_COMBO = 'Shift+]';

/** 笔刷大小预设当前是否开启（配置帧驱动；未连接时以本地缓存为准）。 */
export function getBrushSizePresetOn(): boolean {
  const e = cachedConfig.find(x => x.action === 'brushSizePreset');
  return !!e && !!e.combo;
}

/** 两条步进键的当前组合键（提示/展示用；关着时仍回显默认值）。 */
export function getBrushSizeStepCombos(): { down: string; up: string } {
  const d = cachedConfig.find(x => x.action === 'brushSizeStep' && x.brush === 'down');
  const u = cachedConfig.find(x => x.action === 'brushSizeStep' && x.brush === 'up');
  return {
    down: d?.combo || DEFAULT_BRUSH_SIZE_DOWN_COMBO,
    up: u?.combo || DEFAULT_BRUSH_SIZE_UP_COMBO,
  };
}

/**
 * 开关笔刷大小预设（写入共享配置，.8li 收 config 帧即重建热键表）。
 * 返回 false = 配置尚未就绪 / 推送失败（UI 据此提示「服务未连接」）。
 */
export function setBrushSizePresetActive(on: boolean): boolean {
  if (!configLoaded) return false;
  const desired: HotkeyEntry[] = [
    { id: BRUSH_SIZE_PRESET_ID, combo: on ? '1' : '', action: 'brushSizePreset', brush: '' },
    { id: BRUSH_SIZE_STEP_DOWN_ID, combo: on ? DEFAULT_BRUSH_SIZE_DOWN_COMBO : '', action: 'brushSizeStep', brush: 'down' },
    { id: BRUSH_SIZE_STEP_UP_ID, combo: on ? DEFAULT_BRUSH_SIZE_UP_COMBO : '', action: 'brushSizeStep', brush: 'up' },
  ];
  const ids = [BRUSH_SIZE_PRESET_ID, BRUSH_SIZE_STEP_DOWN_ID, BRUSH_SIZE_STEP_UP_ID];
  const rest = cachedConfig.filter(e => ids.indexOf(e.id) < 0 && e.action !== 'brushSizePreset' && e.action !== 'brushSizeStep');
  const next = [...rest, ...desired];
  cachedConfig = next;
  emitConfig();
  return pushConfig(next);
}

// ===== 混合模式热键「按工具让位」（0x0224，2026-10-30 新增）=====
// 与上面的开关**完全分离**：开关是用户意图（落盘、进配置），让位位是瞬时事实
// （只在原生内存里，进程重启即消失、面板建连后由 blendGuard 重放）。
// ⛔⛔ 别用 setBlendHotkeyActive(false) 冒充「临时关」：配置会落盘（用户在画笔工具下
//    关掉面板就永久变关）、每次切工具都要整表重建、且配置路径未对齐时 pushConfig
//    根本不会发送 —— 那条路拦不住键。详见 keyhook.c 的 g_khBlendYield 注释。
let blendYieldWanted = false;

/** 下发「按工具让位」位（`on=true` ⇒ 原生不吞混合模式键，交回 PS）。 */
export function setBlendHotkeyYield(on: boolean): void {
  blendYieldWanted = !!on;
  sendBlendYieldFrame();
}

/** 当前已下发的让位位（排障/重放用）。 */
export function getBlendHotkeyYield(): boolean {
  return blendYieldWanted;
}

/** 强制重发当前让位位：原生侧在新客户端接手/卸载时会把这一位归零。 */
export function replayBlendHotkeyYield(): void {
  sendBlendYieldFrame();
}

function sendBlendYieldFrame(): void {
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      // ⛔ 必须发 JSON 布尔：原生 json_bool 只认 true/false（发 1/0 会被当成 false）。
      currentWs.send(JSON.stringify({ type: 'blendYield', on: blendYieldWanted }));
    }
  } catch { /* 未连接：连上时 onopen 会重放 */ }
}

/**
 * 重新指定主开关快捷键。combo 传 '' 表示解绑。
 * 若该组合键已被某个笔刷热键占用，会覆盖掉那条笔刷映射（主开关优先级更高）。
 */
export function setMainToggleCombo(combo: string): boolean {
  const others = cachedConfig.filter(e =>
    e.action !== 'toggleMain' && !(combo && e.combo === combo)
  );
  const entry: HotkeyEntry = { id: MAIN_TOGGLE_ID, combo, action: 'toggleMain' };
  cachedConfig = [entry, ...others];
  mainToggleCombo = combo;
  return pushConfig(cachedConfig);
}

// ===== 直接切笔刷（不依赖录制动作）=====
// 正确的 descriptor（UXP 论坛 7168 帖 #12 与 2127 帖 IanBarber 实例双重确认）：
//   { _obj:'select', _target:[{ _ref:'brush', _name:'笔刷名' }] }
// 注意两点：
// 1) 引用里必须用 _name 携带笔刷名；不能像旧写法那样用 _enum/_value:'preset' +
//    顶层 name: 字段——那种引用 PS 无法解析，batchPlay 静默无效（不报错但也不切笔刷）。
// 2) 不要加 _options:{dialogOptions:'dontDisplay'}——该选项实际效果相反：会弹 PS 错误框
//    且异常不进 catch；去掉后笔刷名不存在时会正常 throw，可被下方 catch 捕获并打日志。
// 一次完整的「切到画笔工具 + 选中笔刷预设」调用。
// 注意：不支持同名笔刷——按 _name 选中时 PS 只会命中 Brushes 列表最上方那支同名项。
async function selectBrushCommands(brushName: string) {
  // 先确保当前是画笔工具（用标准 select 切工具；工具已是画笔时可能报错，忽略）
  try {
    await action.batchPlay([
      { _obj: 'select', _target: [{ _ref: 'paintbrushTool' }] }
    ], { synchronousExecution: true });
  } catch { /* 已是画笔工具 */ }
  // 按名称选中笔刷预设（选中的是 Brushes 面板里的预设，全局生效）
  return await action.batchPlay([
    { _obj: 'select', _target: [{ _ref: 'brush', _name: brushName }] }
  ], { synchronousExecution: true });
}

export async function applyBrush(brushName: string): Promise<boolean> {
  try {
    // 首选直连 batchPlay：切换工具/笔刷属于「应用状态」而非文档修改，
    // 多数情况下不需要模态作用域，且不打断用户当前操作（无进度条、无状态抢占）。
    try {
      await selectBrushCommands(brushName);
      return true;
    } catch (directErr) {
      // 某些 PS 版本/某些状态下会要求 batchPlay 必须在模态作用域里执行，
      // 这里做一次回退；两条路都不通才判定失败。
      await runAsModal(async () => {
        await selectBrushCommands(brushName);
      }, { commandName: '切换笔刷' });
      return true;
    }
  } catch (e) {
    console.error('⚠️ 切换笔刷失败（笔刷名「' + brushName + '」可能不存在，需与 Brushes 面板名称完全一致）:', e);
    return false;
  }
}

// 切回套索工具（工具模式「套索工具键」用）：写法与 app.tsx 的自动切套索一致——
// 首选直连 batchPlay，失败再回退模态作用域。
async function selectLassoTool(): Promise<void> {
  const descriptor: any = {
    _obj: 'select',
    _target: [{ _ref: 'lassoTool' }],
    dontRecord: true,
    forceNotify: true,
    _isCommand: false
  };
  try {
    await action.batchPlay([descriptor], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
  } catch {
    try {
      await runAsModal(async () => {
        await action.batchPlay([descriptor], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
      }, { commandName: '切换套索工具' });
    } catch (e) {
      console.warn('⚠️ 套索工具键：切换套索失败:', e);
    }
  }
  // 切到的是「普通套索」⇒ 组内循环游标归零（下一次 Shift+L 从多边形开始，与 PS 同序）。
  lassoCycleIdx = 0;
}

/* ⛔⛔ 0x022F：按 Shift+E 之后的「工具兜底」——只在确实跑偏时才动手。
 *
 * 为什么还要兜底：万一 Shift+E 没能被 RegisterHotKey 独占（被别的程序抢占 /
 * 注册失败 / 文本闸门撤注册的那一拍），PS 会按自己的快捷键把工具循环到橡皮擦组，
 * 而工具模式检到「工具不是套索」会关主开关 ⇒ 用户看到「按 Shift+E 反而退出工具模式」。
 *
 * 为什么不能像 0x013D 那样**无条件**切：切工具会终止正在进行的笔画，而用户按
 * Shift+E 时笔往往还搭在板上（没有新的 down 边沿）⇒ 接下来那一笔被整笔吞掉。
 * 详细因果链与证据见 `handleHotkey` 的 focusClear 分支注释。
 *
 * 三步走，任何一步「不知道」都不动手（保守：不知道就别碰用户的工具）：
 *   ① 同步读 `app.currentTool`（属性直读，**零宿主往返**、不产生任何模态）；
 *      读不到、或认不出是 PS 工具枚举（本地化名称「套索工具」之类）⇒ 直接返回；
 *   ② 已经是套索族（lassoTool / polySelTool / magneticLassoTool）⇒ 返回，
 *      正常场景因此**一条命令都不发**；
 *   ③ 否则延后 `LASSO_RECHECK_MS` 再核一次，仍不是套索才切 —— 给用户留出抬笔的时间，
 *      避免在「笔还按着」的窗口里把笔画打断。
 * ⛔ 工具 ID 一律驼峰（历史记录艺术画笔=artBrushTool 那套教训），别照字面猜。 */
const LASSO_RECHECK_MS = 700;
function readToolIdSync(): string | null {
  try { return normalizeToolId((app as any)?.currentTool); } catch { return null; }
}
function isLassoToolId(id: string | null): boolean {
  /* ⛔ 必须按**族成员精确比较**，不能用 `/lassoTool$/i`：
     多边形套索的 ID 是 `polySelTool`，不以 lassoTool 结尾 —— 后缀正则会把它判成
     「工具跑偏了」，于是 Shift+E 的兜底逻辑又把用户刚切到的多边形套索踢回普通套索。
     ⚠️ 与 `LASSO_GROUP` 共用同一份名单：名单只有一处，改循环顺序就只改那一行。 */
  if (!id) return false;
  const low = id.toLowerCase();
  return LASSO_GROUP.some(r => r.toLowerCase() === low);
}
/* PS 工具内部 ID 一律以 `Tool` 结尾（lassoTool / paintbrushTool / eraserTool…）。
   ⛔ 不满足这个形状的串（本地化名称「套索工具」、空串、乱码）一律当作**读不到**：
      错切一次就会吞掉用户下一笔，比不纠正严重得多。 */
function isToolEnumLike(id: string | null): boolean {
  return !!id && /Tool$/.test(id);
}
function reselectLassoIfStrayed(): void {
  const cur = readToolIdSync();
  if (!isToolEnumLike(cur) || isLassoToolId(cur)) return;
  setTimeout(() => {
    const again = readToolIdSync();
    if (!isToolEnumLike(again) || isLassoToolId(again)) return;
    console.log('[清除模式键] 工具不是套索（' + again + '）⇒ 兜底切回套索');
    void selectLassoTool();
  }, LASSO_RECHECK_MS);
}

/* ⛔⛔ 0x0235：套索工具键的**按需切换** —— 已经是套索族就一条命令都不发。
 *
 * 用户 2026-11-16 报：「套索工具由 L 全程接管，Shift+L 在多边形/磁性套索之间的
 * 循环切不动了」。
 *
 * 根因（不是钩子吞键，也不是 PS 的快捷键）：这里原来**无条件** `select lassoTool`。
 * 每按一次 L 就发一条 `select`，而这条命令是异步的 —— 直连 batchPlay 撞上忙碌窗口时
 * 会退回 `runAsModal` **排队等宿主空闲**，落地时刻可能晚到几百毫秒。用户按 L 之后
 * 紧接着按 Shift+L，PS 已经按原生语义把工具循环到多边形套索了，那条**迟到**的
 * `select lassoTool` 才落地，又把工具拽回普通套索 ⇒ 表现就是「Shift+L 完全没反应」。
 * （`.8li` 侧已核对：裸键表精确比较 "L" ≠ "Shift+L"，Shift+L 从来不会被吞；
 *   见 keyhook.c 的 0x0235 段新增的「裸键因修饰键不匹配放行」诊断日志。）
 *
 * 修法：先同步读 `app.currentTool`（属性直读，零宿主往返、零模态）
 *   ① 已经是套索族 ⇒ 直接返回（L 的语义「关主开关」由调用方单独完成，与切工具无关）；
 *   ② 读不到 / 认不出工具枚举 ⇒ 返回（不知道就别碰用户的工具）;
 *   ③ 确实跑偏 ⇒ 这才发一次 `select`。
 * 副带收益：工具模式下反复按 L 不再每次都付一条 batchPlay 的代价。
 *
 * ⛔ 与 `reselectLassoIfStrayed()`（Shift+E 之后的兜底）的区别只在**时机**：
 *    那边必须延后 700ms 给用户抬笔，这边是用户**主动**按 L 要求切套索，立即执行。 */
function selectLassoIfStrayed(): void {
  const cur = readToolIdSync();
  if (!isToolEnumLike(cur)) return;      /* 读不到工具 ⇒ 不动手 */
  if (isLassoToolId(cur)) return;        /* 已经是套索族 ⇒ 不发命令（这正是本次修复） */
  console.log('[套索工具键] 当前工具是 ' + cur + ' ⇒ 切回套索');
  void selectLassoTool();
  lassoCycleIdx = 0;      /* 已切到普通套索 ⇒ 组内循环游标同步归零 */
}

// ===== 枚举当前可用笔刷预设（供面板下拉使用；失败返回空，不影响核心功能）=====
// 正确路径：读取 application 描述符里的 presetManager（第 0 组 = Brush Presets，
// 第 7 组 = Tool Presets）。这是 UXP 下枚举笔刷名最可靠的方式（论坛 How-to-get-all-
// brush-or-tool-presets 确认）。老写法用 get + brushPreset ordinal all 取到的结构里
// 拿不到 name 列表，所以一直枚举为空。
//
// ⚠️ 本函数是**单次尝试**（不做等待/重试），仅供同文件的 `enumerateBrushes()` 内部调用；
//    外部一律走 `enumerateBrushes()`（带等闸门放行的有界重试，见其说明）。
async function enumerateBrushesOnce(): Promise<string[]> {
  try {
    // 1) 优先用现代 app.brushes 集合（部分较新 PS 版本提供）
    const brushesApi: any = (app as any)?.brushes;
    if (brushesApi && typeof brushesApi.get === 'function') {
      try {
        // ⚠️ DOM 集合的 get 同样是一次宿主往返 ⇒ 走 psRead（模态作用域）。
        const list: any[] = await psRead<any[]>(
          () => brushesApi.get(),
          { label: '枚举笔刷预设', retries: 0 }
        ) as any;
        if (Array.isArray(list)) {
          const names = list.map((b: any) => (b?.name ?? '')).filter((x: any) => !!x);
          if (names.length) return names as string[];
        }
      } catch { /* 退回到 batchPlay */ }
    }

    // 2) 读取 application 描述符里的 presetManager（⚠️ 走 psRead，原为裸 batchPlay get）
    const res: any = await psRead<any>(
      () => action.batchPlay([
        {
          _obj: 'get',
          _target: [
            { _ref: 'property', _property: 'presetManager' },
            { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }
          ],
          _options: { dialogOptions: 'dontDisplay' }
        }
      ], { synchronousExecution: true }),
      { label: '读取笔刷预设表', retries: 0 }
    );
    if (!res) return [];

    const appDesc: any = Array.isArray(res) ? res[0] : res;
    let pm: any = appDesc?.presetManager;
    // 有些版本直接把 presetManager 描述符作为返回值（而不是包在 application 里）
    if (!pm && (appDesc?._obj === 'presetManager' || Array.isArray(appDesc?.preset) || Array.isArray(appDesc?.brushPreset))) {
      pm = appDesc;
    }
    if (!pm) return [];

    // presetManager 可能是「分组数组」，也可能是带 preset/brushPreset 的容器
    const groups: any[] = [];
    if (Array.isArray(pm)) groups.push(...pm);
    else if (Array.isArray(pm.preset)) groups.push(...pm.preset);
    else if (Array.isArray(pm.brushPreset)) groups.push(...pm.brushPreset);

    // 第 0 组是 Brush Presets
    const group = groups[0];
    if (!group) return [];
    const rawNames: any = group.name ?? group.names;
    if (!rawNames) return [];
    const arr: any[] = Array.isArray(rawNames) ? rawNames : [rawNames];
    const names = arr
      .map((n: any) => (typeof n === 'string' ? n : (n?.name ?? n?._value ?? '')))
      .filter((x: any) => !!x && typeof x === 'string');
    return names as string[];
  } catch (e) {
    console.warn('⚠️ 枚举笔刷失败（可手动输入笔刷名）:', e);
    return [];
  }
}

// 等闸门放行的总预算与最大尝试次数（见 enumerateBrushes 说明）。
// 4000ms 是权衡：足够跨过普通静默窗口（300~1200ms）与文档级闩锁释放，又不至于让
// 「点刷新」长时间无反馈；超限即放弃，由上层（启动首刷 / 用户再点刷新）继续。
const BRUSH_ENUM_TOTAL_WAIT_MS = 4000;
const BRUSH_ENUM_ATTEMPTS = 4;

/**
 * 枚举笔刷预设（对外唯一入口）—— 带「等闸门放行 + 有界重试」的健壮版本。
 *
 * ⚠️ 为什么需要它（2026-10-10，自 0f996ce 起的高频枚举失败）：
 *   0f996ce 把本函数的读取收口到 `psRead()`（模态作用域），这是**正确**的
 *   —— 裸 get 撞上宿主忙碌窗口会弹宿主原生「命令"获取"当前不可用」框。
 *   但 `psRead` → `psTryRead` 的第一道关是**粗筛** `isPsBusy()`：一旦命中就
 *   **立即返回失败**（设计如此：后台轮询丢一轮无副作用）。而本函数的消费方却是
 *   「启动首刷 / 用户点刷新」这类**一次性**动作：
 *     · PS 里任何一次选区变更 / 图层操作都会点亮 300~1200ms 的忙碌窗口；
 *     · 切文档 / 打开 / 关闭 / 保存会点亮**文档级闩锁**（可长达数秒）。
 *   ⇒ 「点刷新时恰好撞上某个窗口」的概率极高，表现为**可复现的枚举失败**。
 *
 * ⚠️ 修法（不违背「避免触发获取失败」策略）：
 *   粗筛命中时**不发 get**，只**顺延等待**其放行（保持原策略：忙碌期绝不裸读），
 *   放行后再尝试；等待有**总预算**上限，超限即放弃并交给上层重试。
 *   ⚠️ 绝不使用 `bypassCoarseGate` 硬闯：那条路会在闩锁期把读取排进模态队列，
 *      与「等闸门」的既有语义相悖，且会加剧 "Too many modal scope commands"。
 *
 * @param opts.totalWaitMs 等闸门放行的总预算（ms）。默认 4000。
 * @param opts.attempts    最多尝试次数（含等待后的首次）。默认 4。
 */
export async function enumerateBrushes(
  opts: { totalWaitMs?: number; attempts?: number } = {}
): Promise<string[]> {
  const totalWaitMs = Math.max(0, opts.totalWaitMs ?? BRUSH_ENUM_TOTAL_WAIT_MS);
  const attempts = Math.max(1, opts.attempts ?? BRUSH_ENUM_ATTEMPTS);
  const deadline = Date.now() + totalWaitMs;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // 等闸门放行：忙碌期只顺延、绝不发 get（保持「避免触发获取失败」策略）。
    // ⚠️ 每次最多睡 400ms —— 闩锁一释放就能立刻重试，而不是被一次长睡眠越过去
    //    （psBusyRemain 在闩锁期返回的是节流值，可能远小于真实剩余时间）。
    while (isPsBusy() && Date.now() < deadline) {
      const step = Math.min(Math.max(psBusyRemain(), 100), 400);
      await new Promise<void>(r => setTimeout(r, step));
    }
    const names = await enumerateBrushesOnce();
    if (names.length) {
      if (attempt > 1) {
        console.log(`[笔刷列表] 枚举成功（第 ${attempt} 次尝试，共 ${names.length} 支）`);
      }
      return names;
    }
    if (Date.now() >= deadline) break;
    // 空结果且仍有预算：短暂停顿后再来一轮（可能是刚清空/刚启动的瞬时态）。
    await new Promise<void>(r => setTimeout(r, 200));
  }
  return [];
}


// ===== 请求守护进程录制组合键（UXP 不再自行监听键盘）=====
// 两段式录制：守护进程先捕获组合键（recordCaptured 实时回显，订阅 onRecordProgress），
// 用户按回车确认后回传 {type:'recordResult',combo}；Esc 取消回传 recordCancel。
// 退格不参与录制（录制期既不绑定为组合键、也不删除绑定）；
// 删除绑定走「单击选中 + 退格」的 backspaceDelete 布防通路（见 armBackspaceDelete）。
// 返回 Promise：{combo} 或 null(取消/失败)。
export function requestHotkeyRecording(brush: string): Promise<{ combo: string } | null> {
  return new Promise((resolve) => {
    if (!currentWs || currentWs.readyState !== (currentWs.OPEN ?? 1)) { resolve(null); return; }
    pendingRecord = resolve;
    try {
      currentWs.send(JSON.stringify({ type: 'recordStart', brush }));
    } catch {
      pendingRecord = null;
      resolve(null);
    }
  });
}

// 主动取消录制（UXP 端用户点「取消」时调用）
export function cancelHotkeyRecording(): boolean {
  if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
    try { currentWs.send(JSON.stringify({ type: 'recordCancel' })); return true; } catch { /* ignore */ }
  }
  return false;
}

// 订阅录制进度（捕获到组合键、尚未确认时回调；确认/取消后不再有进度）。
// 返回退订函数。录制会话同一时刻只有一个，所有订阅方都会收到同一份进度。
export function onRecordProgress(fn: (combo: string) => void): () => void {
  recordProgressListeners.push(fn);
  return () => { const i = recordProgressListeners.indexOf(fn); if (i >= 0) recordProgressListeners.splice(i, 1); };
}

// ===== 退格删除绑定（「单击选中条目 + 非录制态按退格 = 解绑」通路）=====
// 守护进程布防后，在 PS 前台按退格会回传 backspaceDelete（按键被守护进程吞掉，
// 不会唤出 PS 的「填充」对话框）；具体解绑哪条由布防的 UI 自己决定。
// 同一时刻只有一个 UI 持有布防权：armedOwner 幂等去重，重复布防/撤防不重发指令。
const backspaceDeleteListeners: ((owner: string) => void)[] = [];
let armedDeleteOwner: string | null = null;

export function onBackspaceDelete(fn: (owner: string) => void): () => void {
  backspaceDeleteListeners.push(fn);
  return () => { const i = backspaceDeleteListeners.indexOf(fn); if (i >= 0) backspaceDeleteListeners.splice(i, 1); };
}

/** 布防：当前 UI 选中了条目，此后 PS 前台按退格 = 请求解绑（守护进程吞掉该按键）。 */
export function armBackspaceDelete(owner: string): void {
  if (armedDeleteOwner === owner) return; // 幂等：同一 UI 重复布防不重发
  armedDeleteOwner = owner;
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'armDelete', owner }));
    }
  } catch { /* ignore */ }
}

/** 撤防：仅当 owner 仍是当前布防方才生效（后布防的 UI 不被先前的撤防误伤）。 */
export function disarmBackspaceDelete(owner: string): void {
  if (armedDeleteOwner !== owner) return;
  armedDeleteOwner = null;
  try {
    if (currentWs && currentWs.readyState === (currentWs.OPEN ?? 1)) {
      currentWs.send(JSON.stringify({ type: 'disarmDelete' }));
    }
  } catch { /* ignore */ }
}

// ============================================================================
// 当前工具 / 笔刷读取（非破坏性，只读）：供「检测类型」扫描与下拉展示复用。
// 关键认知（已通过诊断验证）：
//   · { _ref:'brush', _enum:'ordinal', _value:'targetEnum' } 这个目标 PS 不支持 get，
//     会返回 { _obj:'error', result:-128 }。判定成功必须检查 _obj !== 'error'。
//   · application.tool._enum 才是可靠的「当前工具类别」信号（paintbrushTool /
//     mixerBrushTool / wetBrushTool / smudgeTool …）。
// ============================================================================

/** get 应用级属性时固定的尾部引用。 */
const APP_TARGET = { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' };

/**
 * 判断 batchPlay 的 get 是否【真正成功】。
 * PS 失败时不抛异常，而是返回 [{ _obj:'error', message:'', result:-128 }]，
 * 所以必须显式识别这种「假成功」。
 */
function isGetOk(res: any): boolean {
  const first = Array.isArray(res) ? res[0] : res;
  if (!first || typeof first !== 'object') return false;
  if (first._obj === 'error') return false;
  if (typeof first.result === 'number' && first.result < 0) return false;
  return Object.keys(first).length > 0;
}

/** Photoshop 工具 _enum → 中文名（用于笔刷/工具类型显示，例如 paintbrushTool → 画笔）。 */
const TOOL_TYPE_CN: Record<string, string> = {
  paintbrushTool: '画笔',
  pencilTool: '铅笔',
  mixerBrushTool: '混合器画笔',
  wetBrushTool: '混合器画笔', // 混合器画笔预设在部分 PS 版本下 tool._enum 返回 wetBrushTool
  smudgeTool: '涂抹',
  eraserTool: '橡皮擦',
  backgroundEraserTool: '背景橡皮擦',
  magicEraserTool: '魔术橡皮擦',
  cloneStampTool: '仿制图章',
  patternStampTool: '图案图章',
  healingBrushTool: '修复画笔',
  spotHealingBrushTool: '污点修复画笔',
  patchTool: '修补',
  redEyeTool: '红眼工具',
  historyBrushTool: '历史记录画笔',
  // ⛔ 历史记录艺术画笔的真实 ID 是 artBrushTool（2026-10-30 Alchemist 现场核对）；
  //    旧表里写的 artHistoryBrushTool 是凭字面猜的，PS 从不返回它 ⇒ 那条分支永远走不到。
  artBrushTool: '历史记录艺术画笔',
  colorReplacementBrushTool: '颜色替换',
  blurTool: '模糊',
  sharpenTool: '锐化',
};

/**
 * 把「当前工具」的各种返回形态统一成一个枚举串；认不出返回 null。
 *
 * ⛔ 为什么必须容错（2026-10-13 根因）：`{_obj:'get', _target:[{_property:'tool'}]}`
 *    在不同 PS 版本 / 不同批次里回的是**不同形状** —— 裸串 `"lassoTool"`、
 *    `{_enum:"lassoTool"}`、`{_obj:"lassoTool"}` 都出现过。旧实现只看 `_enum`/`_value`，
 *    宿主一回裸串就恒为 null ⇒ 上层把「读不到」判成「未知」而**放行**闸门
 *    ⇒ 平滑与 HUD 的工具闸门静默失效（真机现象：用铅笔落笔也弹出套索的 HUD）。
 *    所以这里把 4 种形态一并吃掉，且**导出**出去给面板的兜底通路复用。
 */
export function normalizeToolId(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v ? v : null;
  if (typeof v === 'object') {
    const s = v._enum ?? v._value ?? v._obj ?? v.tool ?? v.id ?? v.name;
    return typeof s === 'string' && s ? s : null;
  }
  return null;
}

/**
 * 读取当前工具类型（_enum），例如 paintbrushTool；读不到返回 null。
 *
 * ⚠️ 2026-10-09 收口：此前是**裸 batchPlay get**（记忆里登记的残余缺口）。
 * application 级 get 在宿主忙碌期（删除 / 合并 / 拼合 / 打开 / 保存大文档…）
 * 会弹出宿主原生「命令"获取"当前不可用」—— 而本函数的调用点之一是
 * 「笔刷类型扫描」，那段整包在模态作用域里，命中概率不低。现在统一走 `psRead`。
 * （`psRead` 在自家模态作用域内会自动降级为直读，因此不会嵌套报错。）
 */
export async function getSelectedBrushToolEnum(): Promise<string | null> {
  const r: any = await psRead<any>(
    () => action.batchPlay(
      // ⛔ 2026-11-16：`silent`（不是 `dontDisplay`）。`dontDisplay` 只挡对话框；
      // 这条 get 一旦被宿主拒绝（删除/合并/拼合期间 `application.tool` 可能短暂不可取），
      // PS 会在文档顶部刷一条「命令"获取"当前不可用」。本函数由 1s 巡检与
      // **每条通知**的自动关判定调用 ⇒ 是最高频的只读探测，必须静默。
      [{ _obj: 'get', _target: [{ _property: 'tool' }, APP_TARGET], _options: { dialogOptions: 'silent' } }],
      { synchronousExecution: true }
    ),
    { label: '读取当前工具', retries: 0 }
  );
  if (!r || !isGetOk(r)) return null;
  const d = Array.isArray(r) ? r[0] : r;
  return normalizeToolId(d?.tool);
}

/** 当前笔刷的聚合信息（类型 / 名称 / 直径），用于下拉展示。 */
export interface BrushNameId {
  toolEnum: string | null;   // 原始 _enum，如 paintbrushTool
  type: string | null;      // 中文类型名，未知时回退为原始 _enum
  name: string | null;      // 当前笔刷名（来自 currentToolOptions.brush.name）
  diameter: number | null;  // 笔尖直径（px）
}

/**
 * 读取当前选中笔刷的聚合信息（非破坏性，只读）。
 * ⚠️ 同样已收口到 `psRead`（原为裸 batchPlay get，见 getSelectedBrushToolEnum 的说明）。
 */
export async function getSelectedBrushNameId(): Promise<BrushNameId> {
  const info: BrushNameId = { toolEnum: null, type: null, name: null, diameter: null };
  const r: any = await psRead<any>(
    () => action.batchPlay(
      // ⛔ 同上：只读探测一律 `silent`，失败不刷黄条。
      [{ _obj: 'get', _target: [{ _property: 'currentToolOptions' }, APP_TARGET], _options: { dialogOptions: 'silent' } }],
      { synchronousExecution: true }
    ),
    { label: '读取当前笔刷', retries: 0 }
  );
  if (r && isGetOk(r)) {
    const d = Array.isArray(r) ? r[0] : r;
    const brush = d?.currentToolOptions?.brush;
    if (brush && typeof brush === 'object') {
      info.name = typeof brush.name === 'string' ? brush.name : null;
      const dia = brush.diameter;
      if (dia && typeof dia._value === 'number') info.diameter = dia._value;
    }
  }
  info.toolEnum = await getSelectedBrushToolEnum();
  info.type = info.toolEnum ? (TOOL_TYPE_CN[info.toolEnum] || info.toolEnum) : null;
  return info;
}

// ===== 方案 B：扫描全部笔刷预设的类型 =====
// 思路（已在诊断中验证可行）：选中某支预设后读 application.tool._enum，
// 混合器/涂抹等预设会连带把当前工具切到 mixerBrushTool/smudgeTool，从而反推出类型。
// 关键实现点：
//   1) 选中预设时【不强制切到画笔工具】——否则会掩盖真实工具类型，全标成「画笔」。
//   2) 扫描前记录用户当前笔刷，扫描后【尽力还原】（finally 中），避免丢失用户状态。
//   3) 整段包在 runAsModal（≡ core.executeAsModal）里，作为一次逻辑操作，扫描期间不穿插其它命令。
//   4) 每支独立 try/catch：一支失败不影响其余；读不到类型就留空（下拉不显示类型列）。
//   5) 并发守卫：防止用户连点触发多轮扫描互相干扰。
let brushTypeDetecting = false;

/** 仅按名称选中笔刷预设（不强切工具，以暴露真实工具类型）。 */
async function selectBrushForDetection(name: string): Promise<void> {
  await action.batchPlay([
    { _obj: 'select', _target: [{ _ref: 'brush', _name: name }] }
  ], { synchronousExecution: true });
}

/** 记录用户当前笔刷，供扫描后还原。 */
async function captureCurrentBrush(): Promise<{ toolEnum: string | null; brushName: string | null }> {
  const info = await getSelectedBrushNameId();
  return { toolEnum: info.toolEnum, brushName: info.name };
}

/** 尽力还原用户原本的笔刷与工具。 */
async function restoreCurrentBrush(saved: { toolEnum: string | null; brushName: string | null } | null): Promise<void> {
  if (!saved) return;
  try {
    if (saved.brushName) {
      // applyBrush 会切回画笔工具并选中该笔刷；若该笔刷本身是混合器/涂抹预设，
      // 选中动作通常会把工具重新切回对应类型，达到还原目的。
      await applyBrush(saved.brushName);
    } else if (saved.toolEnum) {
      await action.batchPlay(
        [{ _obj: 'select', _target: [{ _ref: saved.toolEnum }] }],
        { synchronousExecution: true }
      );
    }
  } catch (e) {
    console.warn('⚠️ 检测笔刷类型：还原原笔刷失败，请手动切回你之前的笔刷', e);
  }
}

/**
 * 扫描全部笔刷预设，返回 { 笔刷名: 中文类型 } 映射。
 * @param onProgress 进度回调 (已检测数, 总数, 当前笔刷名)，可用于 UI 反馈。
 * @returns 映射；值可能是空串（读不到类型，表示该预设在当前工具下不暴露类型，按「画笔」处理）。
 */
export async function detectAllBrushTypes(
  onProgress?: (done: number, total: number, current: string) => void
): Promise<Record<string, string>> {
  if (brushTypeDetecting) { console.warn('⚠️ 笔刷类型检测已在进行，忽略重复触发'); return {}; }
  brushTypeDetecting = true;
  const out: Record<string, string> = {};
  try {
    const names = await enumerateBrushes();
    if (!names.length) { console.warn('⚠️ 未枚举到笔刷，无法检测类型'); return out; }
    const saved = await captureCurrentBrush();
    const total = names.length;
    try {
      await runAsModal(async () => {
        for (let i = 0; i < total; i++) {
          const name = names[i];
          if (onProgress) onProgress(i, total, name);
          try {
            await selectBrushForDetection(name);
            const tool = await getSelectedBrushToolEnum();
            out[name] = tool ? (TOOL_TYPE_CN[tool] || tool) : '';
          } catch {
            out[name] = ''; // 该预设选中失败，跳过
          }
        }
      }, { commandName: '检测笔刷类型' });
    } finally {
      await restoreCurrentBrush(saved);
    }
    const known = Object.values(out).filter(Boolean).length;
    console.log(`[笔刷类型检测] 完成：共 ${total} 支，识别到类型 ${known} 支`);
  } catch (e) {
    console.error('⚠️ 检测笔刷类型失败：', e);
  } finally {
    brushTypeDetecting = false;
  }
  return out;
}

