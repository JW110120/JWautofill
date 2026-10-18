// 热键桥接：UXP 侧与 .8li（PS 进程内扩展）通信 + 直接切笔刷
// 设计要点（关键）：
// - UXP 沙箱没有 Node 的 fs/os/process，配置“不由插件读写文件”，统一由 .8li 持有。
// - 插件只通过 WebSocket 向 .8li 拉取/推送配置（getConfig / config），避免跨进程文件系统耦合。
// - .8li 全局捕获按键后广播 hotkey 事件，插件执行「总开关切换 / 直接 select 笔刷」。

import { action, app } from 'photoshop';
import { storage } from 'uxp';
import { MainToggleState, requestMainToggle, requestMainToggleOff } from '../utils/MainToggleBus';
import { requestFillPanelToggle } from '../utils/FillPanelToggleBus';
import { psRead, runAsModal } from '../utils/psAccess';
import { isPsBusy, psBusyRemain } from '../utils/psProbe';
// ⛔ 本模块**不再** import 任何 LassoSmoothing 的东西：套索平滑与热键虽同处一个 .8li，
//    但是两条独立的 WebSocket（平滑 18924 / 热键 18923）——停一侧不影响另一侧，
//    首先就得让两条连接的生命周期互不相干 —— 这里保留任何一句桥接都会把两者重新绑死。

export interface HotkeyEntry {
  id: string;
  combo: string;                 // 例如 "Ctrl+Shift+R"、"Alt+F1"
  action: 'toggleMain' | 'applyBrush' | 'runFunc' | 'focusLasso';
  brush?: string;                // applyBrush 时的笔刷名（PS 预设名，需精确匹配）。
                                  // 注意：不支持同名笔刷——PS 按 _name 只会选中 Brushes 列表最上方那支。
                                  // runFunc 时复用本字段承载功能 id（见 funcHotkeyDefs.ts），
                                  // .8li 对该字段不解释、只透传，因此无需改 .8li。
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
// 专注模式的共享状态同目录、同套路）：
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
// ===== 专注模式「套索工具键」（默认 L）=====
// 专注模式下主开关热键只开不关；为了让 H / L 像两个工具一样切换，再注册一个
// 「套索工具」键：按下即关闭主开关并把当前工具切回套索。
// 该键**只在专注模式开启时装载**（combo 非空）；关闭时把 combo 置空、由守护进程跳过注册，
// 从而完全不影响 PS 原生的 L 键（套索 → 多边形 → 磁性的循环等）。
export const FOCUS_LASSO_ID = 'focus_lasso';
export const DEFAULT_FOCUS_LASSO_COMBO = 'L';
let focusLassoActive = false;   // 专注模式是否开启（仅 APP 面板会写）
let focusLassoKnown = false;    // 是否由 APP 面板明确过专注模式状态（用于排除其它面板上下文）
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
  if (action !== 'toggleMain' && action !== 'applyBrush' && action !== 'runFunc' && action !== 'focusLasso') return null;
  // combo 为空的合法条目：主开关（'' = 已解绑）、笔刷（'' = 已解绑但条目保留在列表，
  // 单击选中后按退格即解绑，与「删除」按钮区分）、专注模式套索键（'' = 专注模式关闭时不装载）。
  // runFunc 空组合键无意义，直接丢弃。
  if (!combo && action !== 'toggleMain' && action !== 'applyBrush' && action !== 'focusLasso') return null;
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
          else if (msg?.type === 'config') {
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
              console.warn('⚠️ 守护进程的配置路径与面板不一致，已重新下发（本次不回写配置）\n  面板：'
                + requestedConfigPath + '\n  服务：' + (daemonConfigPath || '(未知)'));
              try { ws.send(JSON.stringify({ type: 'setConfigPath', path: requestedConfigPath })); } catch { /* ignore */ }
            } else if (!requestedConfigPath) {
              console.warn('⚠️ 尚未解析出插件数据目录，本次不回写配置（避免用默认值覆盖已有热键）；'
                + '守护进程当前使用：' + (daemonConfigPath || '(未知)'));
            }
            // 首次使用时补上主开关的默认快捷键 Ctrl+Q
            if (pathAligned) ensureMainToggleEntry();
            // 专注模式开启时补上/更新「套索工具键」（仅 APP 面板上下文会真正写入）
            if (pathAligned) ensureFocusLassoEntry();
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

function handleHotkey(msg: { id: string; combo?: string; action: string;  brush?: string }) {
  if (msg.action === 'toggleMain') {
    // 主开关：翻转「共享状态」而不是调用本面板内的回调。
    // token 用「组合键 + 400ms 时间桶」生成：同一次命中在所有面板上算出同一个 token，
    // 于是守护进程广播给 N 个面板也只会翻转一次（详见 MainToggleBus 头部说明）。
    const combo = msg.combo ?? '';
    const token = 'hit|' + (combo || 'toggleMain') + '|' + Math.floor(Date.now() / 400);
    void requestMainToggle(token)
      .then((st: MainToggleState) => {
        for (const l of hotkeyListeners) {
          try { l({ combo, action: 'toggleMain', ok: true, enabled: st.enabled }); } catch { /* ignore */ }
        }
      })
      .catch(() => {
        for (const l of hotkeyListeners) {
          try { l({ combo, action: 'toggleMain', ok: false }); } catch { /* ignore */ }
        }
      });
    return;
  }
  if (msg.action === 'focusLasso') {
    // 专注模式下的「套索工具」键：关闭主开关（幂等），并把当前工具切回套索，
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
    // 无论主开关结果如何都把工具切回套索（模拟 PS 的「点套索工具按钮」）
    void selectLassoTool();
    return;
  }
  if (msg.action === 'runFunc' && msg.brush?.startsWith('fillPanel:')) {
    // 选区填充子面板开关（纯色/图案/渐变）：实现权在 APP 面板（子面板展开状态是它的 React state），
    // 与 MainToggleBus 同理经共享文件分发 + token 去重——守护进程向所有面板广播同一次命中，
    // 只有第一个写文件的请求生效，APP 面板轮询到新修订号后翻一次，绝不翻两次。
    const panel = msg.brush.slice('fillPanel:'.length) as 'color' | 'pattern' | 'gradient';
    const token = 'fillPanel|' + panel + '|' + Math.floor(Date.now() / 400);
    const combo = msg.combo ?? '';
    const broadcast = (ok: boolean) => {
      for (const l of hotkeyListeners) { try { l({ combo, action: 'runFunc', brush: msg.brush!, ok }); } catch { /* ignore */ } }
    };
    void requestFillPanelToggle(panel, token).then(() => broadcast(true)).catch(() => broadcast(false));
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

// ===== 专注模式：套索工具键（默认 L，「按下即退出自动填充」）=====

/**
 * 确保配置里存在「套索工具」条目，并让它只在专注模式开启时处于装载态。
 *
 * ⚠️ 只应由 APP 面板的上下文真正写入（仅它会调用 setFocusLassoActive）——
 *    其它面板上下文里 focusLassoKnown 恒为 false，若也参与写入，两个面板会在
 *    'L' / '' 之间来回覆盖（与 MainToggleBus 的多面板「事件被重复投递」问题同源）。
 *
 * 记忆值放在 brush 字段：专注模式关闭时 combo 置空（守护进程跳过注册 ⇒ L 完全交给 PS），
 * 但用户自定义过的键仍被记住，下次开启专注模式时沿用。
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

/** APP 面板在专注模式状态变化时调用，决定套索键是否装载（其它面板绝不调用）。 */
export function setFocusLassoActive(on: boolean): void {
  focusLassoKnown = true;
  focusLassoActive = on;
  ensureFocusLassoEntry();
}

/** 当前套索键（用于提示/展示；专注模式关闭时返回记忆值）。 */
export function getFocusLassoCombo(): string {
  const e = cachedConfig.find(x => x.action === 'focusLasso');
  return e?.brush || e?.combo || DEFAULT_FOCUS_LASSO_COMBO;
}

/**
 * 重绑套索键（功能快捷键子面板用）：同时更新生效值 combo 与记忆值 brush。
 *
 * ⚠️ 该函数会在**绘画工具箱面板**的上下文里被调用（FuncHotkeyPanel 挂在那里），
 *    那里 focusLassoKnown 恒为 false，所以**不能**用 focusLassoKnown 做闸门——
 *    否则重绑会静默失效。装载与否改由调用方传入的 active（= 面板自己看到的专注模式状态）决定。
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

/** 是否已连上守护进程（菜单里「设置主开关快捷键」需要据此给出提示）。 */
export function isDaemonConnected(): boolean {
  return connected;
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

// 切回套索工具（专注模式「套索工具键」用）：写法与 app.tsx 的自动切套索一致——
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
  artHistoryBrushTool: '历史记录艺术画笔',
  colorReplacementBrushTool: '颜色替换',
  blurTool: '模糊',
  sharpenTool: '锐化',
  artBrushTool: '艺术画笔',
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
      [{ _obj: 'get', _target: [{ _property: 'tool' }, APP_TARGET], _options: { dialogOptions: 'dontDisplay' } }],
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
      [{ _obj: 'get', _target: [{ _property: 'currentToolOptions' }, APP_TARGET], _options: { dialogOptions: 'dontDisplay' } }],
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

