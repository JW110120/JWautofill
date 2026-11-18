/**
 * 选区工具选项守护 v2 —— 自动填充的「旋钮保管员」
 * ============================================================================
 * 需求（用户 2026-11-17，v2 逐条确认）：
 *   ① H / Shift+H 进自动填充时，五种选区工具的「选区模式 + 羽化」要被强制成
 *      「新建 + 羽化0」，否则自动填充不触发；用户原来的两个旋钮位置要保护下来。
 *   ② L / Shift+L / M / Shift+M 调出普通选区时，只把**当前这一个**工具恢复成它
 *      自己的原值，绝不加载别的工具的。
 *   ③ 用户手动调单纯选区工具的参数要能持久化；但「自动填充开着时」手改的参数
 *      不许写进快照（那是临时的，退出时会被恢复覆盖掉）。
 *
 * ── v1 → v2 修掉的三件事（每条都有真机证据）────────────────────────────────
 *  1. 字段名错了。真机 dump（PluginData/settings/selection-tool-options-raw.json）：
 *       套索族羽化 = `$DrwR`，选框族羽化 = `$MrqF`，都带 `$` 前缀，值形如
 *       `{ _unit:'pixelsUnit', _value:5 }`；模式统一是 `selectionEnum`（**新建 = 0**，
 *       左起 0/1/2/3 = 新建/添加/减去/交叉；v2 曾误写成 1 ⇒ 按 H 落在"添加到选区"）。
 *     v1 候选名里没有 `$DrwR` ⇒ 套索族全部 featherKey=null，兜底又写了不存在的
 *     `MrqF` ⇒ 套索羽化永远清不掉，用户看到的就是「羽化没被改」。
 *  2. 写完不校验。v1 写失败与写成功在日志里长得一样。v2 每次写入都回读比对，
 *     不一致就换一种 target 形态重试，仍不一致则明确告警。
 *  3. 快照被「值相等」启发式污染。v1「读到 新建+羽化0 就不覆盖」既保不住脏数据，
 *     又会把「用户真的想设成 新建+0」的意图拒之门外。v2 换成会话闸门 + 强制哨兵：
 *     判据是「现在是谁的状态」，不是「数值等于多少」。
 *
 * ── 快照保护：三把锁（对应需求③）──────────────────────────────────────────
 *  ① 会话闸门：只有「主开关关着」这一侧才允许写纯值（也就是进自动填充前那一瞬）。
 *    自动填充开着时一律不拍 —— 那会儿的旋钮可能正是我们拧的。
 *  ② 强制哨兵：每个工具记一份 `forced`（我写下去的值）。哨兵非空 = 我还欠它一次
 *    恢复 ⇒ 它的实时值不可信 ⇒ 不写纯值。哨兵落盘，面板重载 / 多面板广播 /
 *    进程崩溃都认得。
 *  ③ 回读校验：写了就回读，不一致就当没写成（不落哨兵），并留痕。
 *  ⇒ 连按 H 不会被污染（第一次之后闸门已开）；多面板重复执行天然幂等（哨兵闸门）；
 *    用户想改基准：按 L/M 退出（恢复 + 清哨兵）→ 调参数 → 再按 H。
 *
 * ── 顺序：先到位，再拍照（用户逐字确认）────────────────────────────────────
 *  拍照片的循环本来就是「切到某个工具 → 读它的旋钮」，所以「拍照永远在切工具之后」
 *  天然成立；需要特别处理的只有**入口**这一次切换：目标不是当前工具 ⇒ 先切过去。
 *  于是「入口是画笔」与「入口是矩形选框」走同一条路；「入口就是普通套索」时目标
 *  等于当前工具 ⇒ 不切、直接拍 —— 与用户的情况二完全一致。
 *
 * ── 一次遍历 = 拍 + 改 + 验（用户确认的第 2 条）────────────────────────────
 *  五个工具在一趟里各走一遍：切过去 → 读整份 currentToolOptions → 判定纯值 →
 *  只改两个字段 → 整份写回 → 回读校验。整份写回是用户真机验证过的形态
 *  （brushstudio/psState.ts 的 writeToolOptions 就是同一种写法）。
 *  整趟只进**一次**模态作用域；`psRead` 在自家作用域内是直读，不触发 300ms 节流。
 *
 * ── 多面板 ────────────────────────────────────────────────────────────────
 *  .8li 把一次热键广播给所有面板，本模块会在每个面板各跑一遍。因此 enterAutoFill
 *  收一个 `claim`（同一次命中在所有面板上算出来相同）：拍过照片的面板把 claim 写进
 *  快照，其余面板看到一致就跳过拍照（只按需上锁）。哨兵是第二道保险。
 */
import { action, app } from 'photoshop';
import { storage } from 'uxp';
import { psRead, runAsModal } from './psAccess';
import { readMainToggle } from './MainToggleBus';

/** 五种选区工具，顺序与 HotkeyBridge.FILL_TOOL_GROUP 保持一致。 */
export const SELECTION_TOOLS = [
    'lassoTool', 'polySelTool', 'magneticLassoTool', 'marqueeEllipTool', 'marqueeRectTool'
] as const;
export type SelectionToolRef = typeof SELECTION_TOOLS[number];

/** selectionEnum 里「新建选区」的整数值 = **0**（选项栏四个按钮左起 0/1/2/3）。
 *  ⛔ 曾经写成 1：那是「添加到选区」（左数第二个），真机上按 H 出来的是"加选"而不是"新建"，
 *    自动填充因此拿不到干净的新选区。证据是 v2 快照里用户亲手设的基准——
 *    lassoTool=1（添加到）、polySelTool=2（减去）、magneticLassoTool=3（交叉）、
 *    marqueeRect/Ellip=0（新建），与选项栏按钮顺序一一对应 ⇒ 新建只能是 0。
 *  ⚠️ 写入后由回读校验保证「值确实落地」；值的**语义**最终由选项栏第几个按钮亮着来验收。 */
const NEW_SELECTION_MODE = 0;

/** 模式字段：selectionEnum 已真机确认，后两个是其它 PS 版本的候选名。 */
const MODE_KEYS = ['selectionEnum', 'selectionMode', 'selMode'];
/** 羽化字段：带 `$` 的是 PS 27 的实际名字（真机 dump 逐个确认过），不带 `$` 的留给变体。 */
const FEATHER_KEYS = ['$DrwR', 'DrwR', '$MrqF', 'MrqF', '$LscF', 'LscF', '$Fthr', 'Fthr'];
const FEATHER_RE = /^\$?(DrwR|MrqF|LscF|Fthr)$/i;

const SETTINGS_FOLDER = 'settings';
const SNAP_FILE = 'selection-tool-options.json';
const RAW_FILE = 'selection-tool-options-raw.json';
const SNAP_VERSION = 2;

const APP_TARGET = [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }];

/** 每个工具的记录：纯值（要保护的）+ 哨兵（我欠的恢复）。 */
interface ToolRec {
    /** 模式字段真名（selectionEnum） */
    mkey: string;
    /** 羽化字段真名（$DrwR / $MrqF），拿不到就是 null —— 此时不写羽化，也不写纯值 */
    fkey: string | null;
    /** 羽化单位（pixelsUnit），写回时沿用 */
    funit: string | null;
    /** 纯值是否已知。未知时绝不伪造（否则恢复会把强制值当成用户的设置写回去） */
    pureKnown: boolean;
    /** 纯值：用户原来的选区模式 */
    mode: number;
    /** 纯值：用户原来的羽化 */
    feather: number;
    /** 纯值的拍摄时刻（诊断用） */
    pureAt: number;
    /** 哨兵：我写下去的强制值；null = 不欠恢复 ⇒ 该工具的实时值可信 */
    forced: null | { mode: number; feather: number };
}

interface Snap {
    v: number;
    ts: number;
    /** 拍过照片的那一次热键命中（多面板去重用） */
    claim: string;
    tools: { [tool: string]: ToolRec };
}

// ---------------------------------------------------------------- 文件读写

function getLfs(): any {
    return (storage as any)?.localFileSystem || (window as any)?.uxp?.storage?.localFileSystem;
}
function getFormats(): any {
    return (storage as any)?.formats || { utf8: 'utf8' };
}
async function getSettingsFolder(): Promise<any> {
    const lfs = getLfs();
    if (!lfs) throw new Error('无法获取 UXP localFileSystem');
    const data = await lfs.getDataFolder();
    try { return await data.getEntry(SETTINGS_FOLDER); }
    catch (_) { return await data.createFolder(SETTINGS_FOLDER); }
}

let cached: Snap | null = null;

function emptySnap(): Snap { return { v: SNAP_VERSION, ts: 0, claim: '', tools: {} }; }

/** 读快照。`fresh` = 绕开内存缓存重读文件（每次进入自动填充都要 fresh：
 *  多面板、另一面板刚写过、上个会话留下的哨兵，都必须看到磁盘上的真相）。 */
async function readSnap(fresh: boolean): Promise<Snap> {
    if (!fresh && cached) return cached;
    try {
        const folder = await getSettingsFolder();
        const file = await folder.getEntry(SNAP_FILE);
        const j = JSON.parse(await file.read({ format: getFormats().utf8 }));
        if (j && j.v === SNAP_VERSION && j.tools && typeof j.tools === 'object') {
            cached = {
                v: SNAP_VERSION,
                ts: Number(j.ts) || 0,
                claim: typeof j.claim === 'string' ? j.claim : '',
                tools: j.tools,
            };
            return cached;
        }
        // v1 已污染（套索模式存成 0、矩形羽化存成别的工具的值）⇒ 直接丢弃重建
        console.log('[选区工具守护] 快照版本不符（v' + (j && j.v) + '）⇒ 丢弃并按 v' + SNAP_VERSION + ' 重建');
    } catch (_) { /* 还没生成 / 内容损坏：当作空快照 */ }
    cached = emptySnap();
    return cached;
}

async function writeSnap(snap: Snap): Promise<void> {
    cached = snap;
    try {
        const folder = await getSettingsFolder();
        const file = await folder.createFile(SNAP_FILE, { overwrite: true });
        await file.write(JSON.stringify(snap), { format: getFormats().utf8 });
    } catch (e) {
        console.warn('⚠️ [选区工具守护] 快照落盘失败:', e);
    }
}

/** 一次进入的完整取证（原始 cto + 每个工具的决策 + 校验结果）。失败绝不影响主链。 */
async function dumpDiagFile(diag: any): Promise<void> {
    try {
        const folder = await getSettingsFolder();
        const file = await folder.createFile(RAW_FILE, { overwrite: true });
        await file.write(JSON.stringify(diag, null, 2), { format: getFormats().utf8 });
    } catch (_) { /* 诊断写不进去无所谓 */ }
}

// ---------------------------------------------------------------- 基础工具

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function wait(ms: number): Promise<void> {
    return new Promise<void>(r => setTimeout(r, Math.max(0, ms)));
}

function numOf(v: any): number {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (v && typeof v === 'object' && typeof v._value === 'number' && isFinite(v._value)) return v._value;
    return NaN;
}

function unitOf(v: any): string | null {
    return (v && typeof v === 'object' && typeof v._unit === 'string') ? v._unit : null;
}

/** 同步读当前工具（`app.currentTool` 属性直读：零宿主往返、零模态）。 */
function currentToolId(): string | null {
    try {
        const v: any = (app as any)?.currentTool;
        if (!v) return null;
        if (typeof v === 'string') return v;
        if (typeof v === 'object') {
            const s = v._enum ?? v._value ?? v._obj ?? v.tool ?? v.id ?? v.name;
            return typeof s === 'string' ? s : null;
        }
        return null;
    } catch { return null; }
}

function sameTool(a: string | null, b: string | null): boolean {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** 从一份 currentToolOptions 里找出模式字段与羽化字段的**真名**。 */
function detectKeys(cto: any): { mkey: string | null; fkey: string | null; funit: string | null } {
    let mkey: string | null = null;
    let fkey: string | null = null;
    let funit: string | null = null;
    if (cto && typeof cto === 'object') {
        for (const k of MODE_KEYS) {
            if (!isNaN(numOf(cto[k]))) { mkey = k; break; }
        }
        for (const k of FEATHER_KEYS) {
            if (!isNaN(numOf(cto[k]))) { fkey = k; funit = unitOf(cto[k]); break; }
        }
        if (!fkey) {
            for (const k of Object.keys(cto)) {
                if (!FEATHER_RE.test(k)) continue;
                if (isNaN(numOf(cto[k]))) continue;
                fkey = k; funit = unitOf(cto[k]); break;
            }
        }
    }
    return { mkey, fkey, funit };
}

/** 当前 cto 是否已经是「新建 + 羽化0」。
 *  ⚠️ 只用于判断「还要不要写」，**绝不**用于判断快照可不可信（那是 v1 的病根）。 */
function isForcedCto(cto: any): boolean {
    if (!cto) return false;
    const k = detectKeys(cto);
    if (!k.mkey && !k.fkey) return false;
    if (k.mkey && numOf(cto[k.mkey]) !== NEW_SELECTION_MODE) return false;
    if (k.fkey && numOf(cto[k.fkey]) !== 0) return false;
    return true;
}

// ------------------------------------------------- PS 交互（必须在模态作用域内调用）

/**
 * 切到一个工具。
 * @returns 'ok'   已确认切到（`app.currentTool` 同步属性对上了）
 *          'lag'  命令发出去了、但 `app.currentTool` 还没跟上 —— **照常继续**：
 *                 同一批 batchPlay 是同步执行的，读到的就是刚切过去的那个工具
 *                 （v1 真机 raw dump 里磁性套索独有的 $MgLP/$MgEd 只出现在磁性套索
 *                  名下，已证明「select → get」的配对是对的）。这里只留痕，不阻断，
 *                 否则一旦这个属性刷新滞后，整个功能就静默死掉。
 *          'fail' PS 直接拒绝，无法继续。
 */
async function stepSelect(tool: string): Promise<'ok' | 'lag' | 'fail'> {
    if (sameTool(currentToolId(), tool)) return 'ok';
    try {
        await action.batchPlay([{
            _obj: 'select', _target: [{ _ref: tool }],
            dontRecord: true, forceNotify: true, _isCommand: false,
            _options: { dialogOptions: 'silent' },
        }], { synchronousExecution: true } as any);
    } catch (e) {
        console.warn('⚠️ [选区工具守护] 切换失败（' + tool + '）:', e);
        return 'fail';
    }
    for (let i = 0; i < 6; i++) {
        if (sameTool(currentToolId(), tool)) return 'ok';
        await wait(25);
    }
    console.warn('[选区工具守护] 已发出切换到 ' + tool + '，但 app.currentTool 仍是 '
        + (currentToolId() || '（读不到）') + ' ⇒ 继续执行（同步命令顺序可靠），仅留痕');
    return 'lag';
}

/** 读当前工具的整份 currentToolOptions。
 *  ⚠️ 在自家模态作用域内 psRead 是**直读**（不排 300ms 节流队列），所以整趟只有一次开销。 */
async function stepReadCto(): Promise<any | null> {
    const cto = await psRead<any>(async () => {
        const res: any = await action.batchPlay([{
            _obj: 'get',
            _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET],
            _options: { dialogOptions: 'silent' },
        }], { synchronousExecution: true } as any);
        const first: any = Array.isArray(res) ? res[0] : res;
        if (!first || first._obj === 'error') return null;
        const c = first.currentToolOptions ?? first;
        return (c && typeof c === 'object') ? c : null;
    }, { label: '读取选区工具选项', retries: 1, guardGeneration: false });
    return cto ?? null;
}

/** 会话内记住「哪种 target 形态**回读校验通过**」（照 psState.readForm 的做法，少发无效命令）。 */
let writeForm = -1;

/** 两种 target 形态：
 *   #0 直接对工具 class 写（brushstudio/psState.ts 已在真机验证过的形状）；
 *   #1 对「当前工具」的 currentToolOptions 写（我们整趟都停在该工具上，语义最直白）。 */
function writeDescriptor(form: number, tool: string, to: any): any {
    return form === 0
        ? { _obj: 'set', _target: [{ _ref: tool }], to }
        : { _obj: 'set', _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET], to };
}

/** 发一次 set。返回「PS 没有拒绝」（**不等于**写进去了 —— 落地由回读校验判定）。 */
async function stepWriteCtoAs(form: number, tool: string, to: any): Promise<boolean> {
    try {
        const res: any = await action.batchPlay(
            [{ ...writeDescriptor(form, tool, to), _options: { dialogOptions: 'silent' } }],
            { synchronousExecution: true } as any
        );
        const first: any = Array.isArray(res) ? res[0] : res;
        if (first && first._obj === 'error') {
            console.warn('[选区工具守护] 写入形态#' + form + '被 PS 拒绝（' + tool + '）：'
                + (first.message || first._obj || '未知'));
            return false;
        }
        return true;
    } catch (e) {
        console.warn('[选区工具守护] 写入形态#' + form + '抛错（' + tool + '）:', e);
        return false;
    }
}

/**
 * 写 + **回读校验**：一种形态没落地就换另一种再试，都不过才算失败。
 * ⛔ 只认「PS 没报错」是 v1 的老毛病（不报错≠写进去了）—— 判据必须是回读。
 */
async function writeUntil(tool: string, to: any, check: (back: any) => boolean): Promise<boolean> {
    const idxs = writeForm >= 0 ? [writeForm, 1 - writeForm] : [0, 1];
    for (const i of idxs) {
        if (!(await stepWriteCtoAs(i, tool, to))) continue;
        const back = await stepReadCto();
        if (!back) continue;                       // 读不到就不能宣称成功
        if (check(back)) { writeForm = i; return true; }
        console.warn('[选区工具守护] 写入形态#' + i + '回读不一致（' + tool + '）⇒ 换另一种形态再试');
    }
    return false;
}

// ---------------------------------------------------------------- 核心：一次遍历

function blankRec(mkey: string, fkey: string | null, funit: string | null): ToolRec {
    return {
        mkey: mkey || 'selectionEnum', fkey, funit,
        pureKnown: false, mode: -1, feather: -1, pureAt: 0, forced: null,
    };
}

/**
 * 拍 + 改 + 验：对传入的工具各走一遍。
 * ⚠️ 必须整段在 `runAsModal` 内调用（内部直接 batchPlay；psRead 在此直读）。
 *
 * @param tools    要走的工具（已按「目标在前」排好序）
 * @param target   本次热键最终要停的工具
 * @param snap     快照（就地修改）
 * @param capture  写纯值的许可档位：
 *                 'all'     = 主开关关着（正常进场）⇒ 没欠账的工具都可以更新纯值；
 *                 'missing' = 主开关本来开着但快照不全（插件重启 / 首装）⇒ **只**给
 *                             完全没有记录的工具补一张，有记录的一律不动（避免把
 *                             上一次会话强制下来的值当成用户意图）；
 *                 'none'    = 自动填充开着且快照齐全 ⇒ 一张都不拍。
 * @param diag     诊断记录（逐工具追加）
 * @param raw      原始 cto 收集（诊断用）
 */
async function pass(
    tools: string[], target: string, snap: Snap, capture: 'all' | 'missing' | 'none',
    diag: any[], raw: any, touch?: () => void
): Promise<void> {
    for (const tool of tools) {
        /* 每切一次都续一次「本次切换是自己干的」时窗：整趟要切五个工具，
           面板侧那个 1.5s 抑制窗必须全程有效，否则巡检会把我们当成用户换工具。 */
        try { touch?.(); } catch (_) { /* ignore */ }
        const sel = await stepSelect(tool);
        if (sel === 'fail') {
            diag.push({ tool, action: 'switch-fail' });
            console.warn('[选区工具守护] 切不到 ' + tool + '（当前=' + currentToolId() + '）⇒ 跳过它，不写任何值');
            continue;
        }
        if (sel === 'lag') diag.push({ tool, action: 'switch-unconfirmed' });
        const cto = await stepReadCto();
        if (!cto) {
            diag.push({ tool, action: 'read-fail' });
            console.warn('[选区工具守护] 读不到 ' + tool + ' 的选项 ⇒ 跳过');
            continue;
        }
        raw[tool] = cto;
        const k = detectKeys(cto);
        const old = snap.tools[tool];
        const liveMode = k.mkey ? numOf(cto[k.mkey]) : NaN;
        const liveFeather = k.fkey ? numOf(cto[k.fkey]) : NaN;

        // —— 定纯值：只有「允许拍」且「这个工具没欠账」时，实时值才等于用户意图 ——
        const mayWrite = capture === 'all' ? !(old && old.forced)
            : capture === 'missing' ? !old
                : false;
        if (mayWrite) {
            if (!k.mkey) {
                diag.push({ tool, action: 'pure-skip', note: '找不到模式字段' });
            } else {
                const rec = old ?? blankRec(k.mkey, k.fkey, k.funit);
                rec.mkey = k.mkey;
                if (k.fkey) { rec.fkey = k.fkey; rec.funit = k.funit; }
                rec.mode = liveMode;
                rec.feather = isNaN(liveFeather) ? 0 : liveFeather;
                rec.pureKnown = true;
                rec.pureAt = Date.now();
                snap.tools[tool] = rec;
                diag.push({ tool, action: 'pure', mode: liveMode, feather: rec.feather });
            }
        } else if (capture !== 'none') {
            diag.push({ tool, action: 'pure-keep', note: '欠恢复/已有记录 ⇒ 不覆盖纯值', mode: liveMode, feather: liveFeather });
        }

        // —— 上锁：只改两个字段，整份写回，然后回读校验 ——
        const rec = snap.tools[tool] ?? blankRec(k.mkey || 'selectionEnum', k.fkey, k.funit);
        if (!k.mkey) {
            snap.tools[tool] = rec;
            diag.push({ tool, action: 'force-skip', note: '找不到模式字段' });
            continue;
        }
        rec.mkey = k.mkey;
        if (k.fkey) { rec.fkey = k.fkey; rec.funit = k.funit; }
        if (isForcedCto(cto)) {
            rec.forced = { mode: NEW_SELECTION_MODE, feather: 0 };
            snap.tools[tool] = rec;
            diag.push({ tool, action: 'force-skip', note: '已经是新建+羽化0' });
            continue;
        }
        const to = clone(cto);
        to[k.mkey] = NEW_SELECTION_MODE;
        if (k.fkey) to[k.fkey] = { _unit: k.funit || 'pixelsUnit', _value: 0 };
        const ok = await writeUntil(tool, to, isForcedCto);
        // 只有**校验通过**才落哨兵（= 我确实改过它，欠一次恢复）。
        // ⛔ 失败时保持原样、**不清**旧哨兵：之前欠的账不能因为这次没写成就抹掉
        //    （抹掉就等于把「欠恢复」的证据丢了，后面可能把强制值当成用户意图拍进纯值）。
        if (ok) rec.forced = { mode: NEW_SELECTION_MODE, feather: 0 };
        snap.tools[tool] = rec;
        if (ok) {
            diag.push({ tool, action: 'force-ok', feather: k.fkey ? 0 : '无羽化字段' });
        } else {
            diag.push({ tool, action: 'force-fail', note: '两种写法回读都不是 新建+羽化0' });
            console.warn('[选区工具守护] ⚠️ ' + tool + ' 上锁未生效（两种写法回读都不是 新建+羽化0）'
                + '⇒ 自动填充可能不触发；原始选项已落盘 selection-tool-options-raw.json');
        }
    }

    // 整趟结束停在最后一个被访问的工具上 ⇒ 回到目标
    const backSel = await stepSelect(target);
    diag.push({ tool: target, action: backSel === 'fail' ? 'final-target-fail' : 'final-target' });
}

// ---------------------------------------------------------------- 对外入口

/** 判定一个工具引用名是否属于五种选区工具（大小写不敏感）。 */
export function isSelectionTool(tool: string | null | undefined): boolean {
    if (!tool) return false;
    const low = tool.toLowerCase();
    return SELECTION_TOOLS.some(t => t.toLowerCase() === low);
}

/** 进自动填充前的「先到位」：目标不是当前工具就先切过去（拍照永远在切工具之后）。 */
async function ensureTarget(
    target: string, beforeSelect?: () => void, switchTool?: (tool: string) => Promise<boolean>
): Promise<void> {
    if (sameTool(currentToolId(), target)) return;
    try { beforeSelect?.(); } catch (_) { /* ignore */ }
    try {
        if (switchTool) await switchTool(target);
        else await runAsModal(async () => { await stepSelect(target); }, { commandName: '切换到选区工具' });
    } catch (e) {
        console.warn('[选区工具守护] 切到目标失败（' + target + '）:', e);
    }
}

/**
 * 进入自动填充：先到位 → 拍五张照片 → 五个工具全部拧到「新建 + 羽化0」。
 *
 * 会话闸门（主开关）已经开着时走**廉价路径**：不拍照，只把目标摆到位、按需重新上锁
 * —— 连按 H / 循环 Shift+H 因此只有两三次往返，而不是整趟五个工具。
 *
 * @param target       本次热键最终要停的工具（H=lassoTool；Shift+H=循环目标）
 * @param claim        同一次命中在所有面板上相同的去重令牌（拍过照片的面板会记住它）
 * @param beforeSelect 切工具前调用（HotkeyBridge 传 noteSelfToolSwitch，抑制自动关）
 * @param switchTool   切工具函数（HotkeyBridge.selectToolByRef，注入以免循环依赖）
 */
export async function enterAutoFill(
    target: string,
    claim: string,
    beforeSelect?: () => void,
    switchTool?: (tool: string) => Promise<boolean>,
): Promise<void> {
    const gate = await readMainToggle();
    const snap = await readSnap(true);
    const diag: any = {
        ts: Date.now(), target, claim, gateEnabled: gate.enabled,
        claimHit: !!claim && snap.claim === claim, path: '', steps: [], raw: {},
    };

    await ensureTarget(target, beforeSelect, switchTool);

    /* 快照齐不齐：五个工具纯值都有记录才算齐。
       ⛔ 为什么必须查这个：主开关状态会跨会话持久化 —— 插件重启 / PS 重启后
          「开关本来就开着、快照却第一次生成」。若此时还盲目走廉价路径，就一个工具
          都拍不到，L/M 恢复时只会得到「纯值未知」。 */
    const snapshotComplete = SELECTION_TOOLS.every((t) => {
        const r = snap.tools[t];
        return !!r && r.pureKnown;
    });

    const lightPath = (why: string, cap: 'none' | 'missing') => {
        diag.path = why;
        return runAsModal(async () => {
            await pass([target], target, snap, cap, diag.steps, diag.raw, beforeSelect);
        }, { commandName: '选区工具上锁', interactive: false, timeOut: 2000 });
    };

    try {
        if (gate.enabled && snapshotComplete) {
            await lightPath('gate-on：不拍照，只按需上锁目标', 'none');
        } else if (!gate.enabled && claim && snap.claim === claim) {
            await lightPath('gate-off：claim 命中（别的面板已拍过）⇒ 只上锁目标', 'none');
        } else {
            /* 整趟：先到位 → 拍（许可档位见 pass 注释）→ 五个全部上锁 */
            const cap: 'all' | 'missing' = gate.enabled ? 'missing' : 'all';
            diag.path = gate.enabled
                ? 'gate-on 但快照不全（重启/首装）⇒ 只补拍没记录的工具，然后全部上锁'
                : 'gate-off：先到位 → 拍五张 → 五个全部上锁';
            const order = [target, ...SELECTION_TOOLS.filter(t => t !== target)];
            await runAsModal(async () => {
                await pass(order, target, snap, cap, diag.steps, diag.raw, beforeSelect);
            }, { commandName: '选区工具快照与上锁', interactive: false, timeOut: 3000 });
            if (claim && !gate.enabled) snap.claim = claim;
        }
    } catch (e) {
        console.warn('[选区工具守护] 拍照/上锁失败:', e);
    }

    snap.ts = Date.now();
    await writeSnap(snap);
    await dumpDiagFile(diag);
    const pure = diag.steps.filter((s: any) => s.action === 'pure').map((s: any) => s.tool);
    const forced = diag.steps.filter((s: any) => s.action === 'force-ok').map((s: any) => s.tool);
    console.log('[选区工具守护] ' + diag.path
        + ' ⇒ 拍照: ' + (pure.length ? pure.join(', ') : '（无）')
        + ' ｜ 上锁: ' + (forced.length ? forced.join(', ') : '（无）'));
}

/**
 * 恢复单个工具的用户原始旋钮（只动传入的这一个，不碰其它工具）。
 * ⚠️ 只在「哨兵非空」时才写：没欠账说明它现在就是用户的值，多写一次会覆盖用户的
 *    实时调整（这也是用户要求的「各归各」）。
 *
 * @param tool         要恢复的工具
 * @param beforeSelect 切工具前调用（抑制「自动关」误判）
 */
export async function restoreOne(tool: string, beforeSelect?: () => void): Promise<boolean> {
    const snap = await readSnap(true);
    const rec = snap.tools[tool];
    if (!rec) {
        console.log('[选区工具守护] ' + tool + ' 没有快照 ⇒ 不动它的旋钮');
        return false;
    }
    if (!rec.forced) {
        console.log('[选区工具守护] ' + tool + ' 没欠恢复 ⇒ 不写（避免覆盖你当前的设置）');
        return false;
    }
    if (!rec.pureKnown) {
        console.warn('[选区工具守护] ' + tool + ' 的纯值未知（当时没拍到）⇒ 跳过恢复；'
            + '先手动调好它再按一次 H，或控制台 __jwSelTools.recapture() 重建');
        return false;
    }
    let ok = false;
    try {
        if (!sameTool(currentToolId(), tool)) {
            try { beforeSelect?.(); } catch (_) { /* ignore */ }
        }
        await runAsModal(async () => {
            if ((await stepSelect(tool)) === 'fail') return;
            const cto = await stepReadCto();
            if (!cto) return;
            const k = detectKeys(cto);
            const mkey = rec.mkey || k.mkey;
            const fkey = rec.fkey || k.fkey;
            if (!mkey && !fkey) return;
            const to = clone(cto);
            if (mkey) to[mkey] = rec.mode;
            if (fkey) to[fkey] = { _unit: rec.funit || k.funit || 'pixelsUnit', _value: rec.feather };
            ok = await writeUntil(tool, to, (back) => {
                const bk = detectKeys(back);
                const modeOk = bk.mkey ? numOf(back[bk.mkey]) === rec.mode : true;
                const fOk = bk.fkey ? numOf(back[bk.fkey]) === rec.feather : true;
                return modeOk && fOk;
            });
        }, { commandName: '恢复选区工具设置', interactive: false, timeOut: 2000 });
    } catch (e) {
        console.warn('[选区工具守护] 恢复失败（' + tool + '）:', e);
    }
    if (ok) {
        rec.forced = null;          // 账结清了 ⇒ 下次拍照可以信任它的实时值
        snap.ts = Date.now();
        await writeSnap(snap);
        console.log('[选区工具守护] 已恢复 ' + tool + '：模式=' + rec.mode + ' 羽化=' + rec.feather);
    } else {
        console.warn('[选区工具守护] ⚠️ ' + tool + ' 恢复未生效（保持欠账，下次再试）');
    }
    return ok;
}

/**
 * 逃生门：把快照彻底重建 —— 清掉全部纯值与哨兵，按当前五个工具的实时状态重拍一张。
 * 只应在「快照确实错了」或「想让当前设置成为新基准」时用
 * （控制台 `__jwSelTools.recapture()`）。
 */
export async function recaptureAll(): Promise<void> {
    const snap = emptySnap();
    cached = snap;
    const cur = currentToolId();
    const target = isSelectionTool(cur) ? String(cur) : 'lassoTool';
    const diag: any = {
        ts: Date.now(), target, action: 'recapture', gateEnabled: false,
        path: '手动重建', steps: [], raw: {},
    };
    if (!isSelectionTool(cur)) {
        try { await runAsModal(async () => { await stepSelect(target); }, { commandName: '切换到套索' }); }
        catch (_) { /* ignore */ }
    }
    const order = [target, ...SELECTION_TOOLS.filter(t => t !== target)];
    try {
        await runAsModal(async () => {
            await pass(order, target, snap, 'all', diag.steps, diag.raw);
        }, { commandName: '重建选区工具快照', interactive: false, timeOut: 3000 });
    } catch (e) {
        console.warn('[选区工具守护] 重建失败:', e);
    }
    snap.claim = '';
    snap.ts = Date.now();
    await writeSnap(snap);
    await dumpDiagFile(diag);
    console.log('[选区工具守护] 快照已重建：' + Object.keys(snap.tools).join(', '));
}

/** 诊断入口：控制台 `__jwSelTools.dump()` 打印快照与最近一次进场记录。 */
export function dumpDiagConsole(): void {
    console.log('[选区工具守护] 快照:', JSON.stringify(cached));
    getSettingsFolder().then(async (folder) => {
        for (const name of [SNAP_FILE, RAW_FILE]) {
            try {
                const f = await folder.getEntry(name);
                console.log('[选区工具守护] ' + name + ':', await f.read({ format: getFormats().utf8 }));
            } catch (_) { /* 文件还没生成 */ }
        }
    }).catch(() => { /* ignore */ });
}

try {
    (globalThis as any).__jwSelTools = {
        dump: dumpDiagConsole,
        recapture: () => void recaptureAll(),
        restore: (tool: string) => void restoreOne(tool),
    };
} catch (_) { /* ignore */ }
