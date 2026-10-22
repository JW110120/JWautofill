/**
 * 特制笔刷 ↔ Photoshop 的桥。整条链只有一件事：
 *
 *   定义笔尖 → 选中它 → 下发参数 → **把预设删掉**
 *
 * 最后那一步是 2026-10-22 用户口径的核心：画笔预设里不该留下我们的痕迹。
 * 用户真机验证：删掉当前选中的预设后，画笔工具**仍停在那支笔上**，不会跳回别的笔。
 * ⇒ 所以对用户来说，点一下笔就能直接画，画笔面板里干干净净 —— 「像没装过」。
 *
 * ⚠️ 为什么不用 .tpl 工具预设（被逆向样本的做法）：二进制黑盒、无法评审、
 *    跨 PS 大版本极易碎。这里走的是**公开脚本接口**：defineBrush + set brush。
 *
 * ⚠️ 参数键名的真相只有真机知道。PS 的画笔描述符有大版本差异，所以：
 *    · 每个键名都有 2 个候选（现代长键 / 4 字符 charID），逐个试，成功即停；
 *    · 每一步独立 try/catch，**一步失败不影响其它步**（绝不让整包 set 一起死）。
 *
 * ⛔⛔ 2026-10-22 第三次真机修正（这一版的中心思想：**别问 PS，自己定名**）
 * ----------------------------------------------------------------------------
 * ① **`dialogOptions` 的值选错了，这才是弹框的真凶。**
 *    Adobe 文档（batchPlay → Command execution options）：
 *      · `silent`（默认）  ：不出 UI；**命令需要额外参数时返回脚本错误**；
 *      · `dontDisplay`    ：不出 UI，**但出错或命令需要额外参数时仍会显示 UI**；
 *      · `display`        ：出 UI。
 *    前两版一路在加 `dontDisplay` —— 那恰恰是**唯一允许弹框**的档位。
 *    `defineBrush` 需要「画笔名称」这个参数，PS 就按条款把「新建画笔」框弹了出来。
 *    ⇒ 全仓改用 `silent`。附带解开老坑：`select` + `dontDisplay` 为什么"弹宿主错误框
 *      且不进 catch" —— 因为出错时要显示 UI。`silent` 下它是普通可捕获异常。
 *
 * ② **预设名不靠差集，靠我们自己定。**
 *    老实现「定义前后各读一次清单、差集里新增的就是真名」—— 这条路依赖
 *    `presetManager` / `app.brushes` 的**缓存新鲜度**，真机表现为差集恒空
 *    （于是抛"定义命令返回成功，但画笔清单里没有新增笔尖"，预设却真的建出来了）。
 *    现在：笔尖文件名就是 `BRS-<id>.png`，PS 拿**文档名**当预设名 ⇒ 名字**确定**。
 *
 * ③ **删除必须在 finally 里。**
 *    老实现如果参数下发抛错，函数直接跳出，`delete` 永远不执行 ⇒ 预设留在面板里，
 *    就是用户说的"留下了把柄"。现在只要**确认选中过我们自己的笔尖**，无论中途怎么错
 *    都会尝试删一次。⚠️ 确认 = select 成功 + 名字校验；没确认过绝不删
 *    （否则删掉的是用户当前的笔）。
 *
 * ⛔⛔ 2026-10-22 第四次真机修正（中心思想：**先问面板有没有，再决定建不建**）
 * ----------------------------------------------------------------------------
 * ① **`defineBrush` 在 PS 27 上无法静默**，`dialogOptions` 三档都挡不住：
 *    用户点「取消」时它回 `-128`；`make` 回 `-32005`。这是新版的命名交互，不是参数问题。
 *    ⇒ 现在候选表只剩两条，且 A 是**菜单命令的 4 字符 OSType `DflB`**
 *      （ExtendScript 时代静默建笔的老写法，与 stringID `defineBrush` **不保证同一条处理器**）。
 *      A 不认才轮到 B，所以最坏情况也只会弹**一个**框。
 *
 * ② **"明明有预设，为什么还要再建一次" —— 探针本身坏了。**
 *    旧实现拿「按名 select 能否成功」当存在性探针，两个变量都是猜的：
 *    猜名字（`BRS-<id>.png` 或 `BRS-<id>`）、且只试过 `_ref:'brush'` **一种**引用形态。
 *    任一不对 ⇒ 探针恒判"不存在" ⇒ 每次点击都重建、都多留一个预设、都弹一次框。
 *    ⇒ 现在先 `listBrushNames()` 读**真实清单**拿真名，再用 `brushPreset` / `brush`
 *      **两种**形态去选（成功过的那条记在会话里）。
 *
 * ③ **存在就绝不重建。** 复用链路：选中已有预设 → 下发参数 → **抓工具状态存缓存**
 *    → 删掉预设。用户手工留下的残留预设因此从"包袱"变成"资产"：
 *    它同时提供可用笔尖和一份缓存，从此不必再走 define。
 *    若清单里有却选不中 ⇒ **停手报错**，不再重建（重建只会多出「拷贝」）。
 */
import { action, app, core } from 'photoshop';
import { storage } from 'uxp';
import { runAsModal } from '../utils/psAccess';
import { reloadReservoir } from './psMixer';
import {
    currentBrushName,
    dropState,
    dumpRun,
    listStates,
    loadState,
    readToolOptions,
    readToolOptionsRaw,
    restoreState,
    sampledId,
    saveState
} from './psState';
import type { ApplyStep, BrushDef, BrushParams } from './types';

const lfs = storage.localFileSystem;

/** PS 画笔预设名前缀：纯 ASCII，避免早期版本对预设名的编码处理差异 */
export const TIP_PREFIX = 'BRS-';

/** 命令执行档位。见文件头 ①：**默认就该是 silent**，不是 dontDisplay。 */
type DialogMode = 'silent' | 'dontDisplay' | 'display';

function px(v: number) {
    return { _unit: 'pixelsUnit', _value: Math.max(1, Math.round(v)) };
}

/**
 * 比例(0~1) → PS 的 percentUnit(0~100)。
 *
 * ⛔⛔ 2026-10-22 真机事故：老实现写的是 `Math.round(v * 100) / 100`，
 *    于是 `pct(1.0)` 得到 **1**（= 1%），`pct(0.1)` 得到 0.1（= 0.1%）。
 *    结果每一支笔都被下发成「圆度 1%、不透明度 1%、流量 1%、间距 0.1%」——
 *    用户看到的是一支"喷枪虚边细线"，完全货不对版。
 *    正确换算是 `v * 100`，保留两位小数足够（PS 的滑块本身没有更高精度）。
 */
function pct(v: number) {
    const p = Math.max(0, Math.min(100, v * 100));
    return { _unit: 'percentUnit', _value: Math.round(p * 100) / 100 };
}

function deg(v: number) {
    return { _unit: 'angleUnit', _value: v };
}

function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
}

const DOC_TARGET = [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }];
const BRUSH_TARGET = [{ _ref: 'brush', _enum: 'ordinal', _value: 'targetEnum' }];
const APP_TARGET = [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }];

/**
 * 本次运行期间执行过的**每条** Action Manager 命令 + PS 的原始返回，只给排障用。
 *
 * 为什么要它：用户点一下笔，PS 会**闪一条黄色通知条**（来不及截图）。
 * 那条 UI 提示有两种来源：① 某条命令的返回里带 `message`/`text`；
 * ② PS 自己派发的 notification 事件（见 `startNotifySniff`）。
 * 两种都要抓，只抓一种就会漏。
 */
const cmdLog: any[] = [];

/** 把 PS 的返回精简到"可能承载提示文案"的字段，避免把整份 cto 塞进日志 */
function slimResult(d: any): any {
    if (!d || typeof d !== 'object') return d;
    const keys = Object.keys(d);
    if (keys.length <= 10) return d;
    const o: any = { _obj: d._obj };
    for (const k of ['message', 'result', 'text', 'title', 'name', 'error', 'notification', 'level', 'kind']) {
        if (d[k] !== undefined) o[k] = d[k];
    }
    o._keys = keys.length;
    return o;
}

/** PS 派发的 notification 事件（黄条多半在这里） */
const notifLog: any[] = [];
let notifListener: number | null = null;

/**
 * 开始监听 PS 的 Action Manager 通知。
 *
 * ⛔ 必须包 try：`addNotificationListener` 在部分版本/权限下不存在或直接抛，
 *    监听失败不能影响主链 —— 抓不到提示顶多算排障信息缺失。
 */
function startNotifySniff(): void {
    if (notifListener !== null) return;
    const cb = (evt: string, desc: any) => {
        if (notifLog.length >= 80) return;
        try {
            notifLog.push({ evt, desc });
        } catch {
            notifLog.push({ evt, desc: '[无法序列化]' });
        }
    };
    for (const api of [action as any, core as any]) {
        try {
            if (api && typeof api.addNotificationListener === 'function') {
                notifListener = api.addNotificationListener(['all'], cb);
                return;
            }
        } catch {
            /* 换下一个 API */
        }
    }
}

function stopNotifySniff(): void {
    if (notifListener === null) return;
    for (const api of [action as any, core as any]) {
        try {
            if (api && typeof api.removeNotificationListener === 'function') {
                api.removeNotificationListener(notifListener);
            }
        } catch {
            try {
                (api as any).removeNotificationListener([notifListener]);
            } catch {
                /* 忽略 */
            }
        }
    }
    notifListener = null;
}

/**
 * batchPlay 的薄封装。PS 用 `_obj:"error"` 表达失败，这里统一抛出去。
 *
 * ⛔ `_options.dialogOptions` 我们**一律显式写 `silent`**（见文件头 ①）。
 *    注意它必须写在**每条描述符自己的 `_options`** 里 —— 那是文档化的位置；
 *    batchPlay 第二个参数只认 synchronousExecution / continueOnError /
 *    immediateRedraw / modalBehavior 这几个键，写 dialogOptions 进去是无效的
 *    （前两版以为它"会盖掉描述符里的设置"，其实是那一处根本没生效）。
 */
async function bp(
    descriptor: any | any[],
    commandName: string,
    options?: { dialogOptions?: DialogMode }
) {
    const dialogOptions: DialogMode = options?.dialogOptions ?? 'silent';
    const list = (Array.isArray(descriptor) ? descriptor : [descriptor]).map((d: any) => ({
        ...d,
        _options: { ...(d?._options || {}), dialogOptions }
    }));
    const res = await action.batchPlay(list as any, { synchronousExecution: true } as any);
    const first: any = Array.isArray(res) ? res[0] : res;
    if (cmdLog.length < 120) {
        cmdLog.push({
            cmd: commandName,
            desc: list.map((d: any) => ({ _obj: d._obj, target: d._target, to: d.to ? Object.keys(d.to) : undefined })),
            res: slimResult(first)
        });
    }
    if (first && first._obj === 'error') {
        throw new Error(
            `${commandName}: ${first.message || first.result || 'PS 拒绝了该动作'}（${first.result || ''}）`
        );
    }
    return first;
}

/** 跑一步，把成败写进报告 */
async function step(name: string, fn: () => Promise<any>, onStep?: (s: ApplyStep) => void): Promise<ApplyStep> {
    try {
        await fn();
        const s: ApplyStep = { name, ok: true };
        onStep?.(s);
        return s;
    } catch (e: any) {
        const s: ApplyStep = { name, ok: false, msg: e?.message || String(e) };
        onStep?.(s);
        return s;
    }
}

// ------------------------------------------------------------------ 画笔清单（仅用于体检）

/** 「读画笔清单」用过的、成功的形态下标（0=`brushes` 属性，1=`presetManager`）。会话内记住 */
let listForm = -1;

/**
 * 读当前 PS 里的**画笔预设名**。⚠️ 只用于「体检/报垃圾」，**不再用于定名**（见文件头 ②）。
 *
 * 三条路，按可靠性排序：
 *   ① `get property:'brushes'` —— 新版（Adobe 论坛 Jarda 给法），结果在 `result[0].brush`；
 *   ② `get property:'presetManager'` —— 老版本兜底，第 0 组的 `name` 就是名字列表；
 *   ③ `app.brushes.get()` —— DOM 集合（本仓别的模块用过，但 PS 27 上可能不存在）。
 * 失败一律返回空数组，不阻断主链。
 */
async function listBrushNames(): Promise<string[]> {
    // ⛔ 同样要记住「哪条读法能用」（2026-10-22 黄条）：失败的那条每撞一次，
    //    PS 就在文档顶部画一条「悦绘: 命令"获取"当前不可用」。这条路径每次点击都跑。
    const order = listForm >= 0 ? [listForm] : [0, 1];

    // ① / ② 都是 batchPlay，一次拿两种属性，谁有就用谁
    for (const idx of order) {
        const prop = idx === 0 ? 'brushes' : 'presetManager';
        try {
            const res: any = await action.batchPlay(
                [
                    {
                        _obj: 'get',
                        _target: [{ _ref: 'property', _property: prop }, ...APP_TARGET],
                        _options: { dialogOptions: 'silent' }
                    }
                ] as any,
                { synchronousExecution: true } as any
            );
            const desc: any = Array.isArray(res) ? res[0] : res;
            if (!desc || desc._obj === 'error') continue;

            // brushes 那条：result[0].brush 是采样画笔数组或单个描述符
            const rawBrush = desc.brush ?? desc.brushes;
            if (prop === 'brushes' && rawBrush) {
                const arr = Array.isArray(rawBrush) ? rawBrush : [rawBrush];
                const names = arr.map((b: any) => b?.name).filter((n: any) => typeof n === 'string' && !!n);
                if (names.length) {
                    listForm = idx;
                    return names;
                }
            }

            // presetManager 那条：group[0].name 是字符串数组
            let pm: any = desc.presetManager;
            if (!pm && (desc._obj === 'presetManager' || Array.isArray(desc.preset) || Array.isArray(desc.brushPreset))) {
                pm = desc;
            }
            if (!pm) continue;
            const groups: any[] = [];
            if (Array.isArray(pm)) groups.push(...pm);
            else if (Array.isArray(pm.preset)) groups.push(...pm.preset);
            else if (Array.isArray(pm.brushPreset)) groups.push(...pm.brushPreset);
            const group = groups[0];
            if (!group) continue;
            const rawNames: any = group.name ?? group.names;
            if (!rawNames) continue;
            const arr: any[] = Array.isArray(rawNames) ? rawNames : [rawNames];
            const names = arr
                .map((n: any) => (typeof n === 'string' ? n : (n?.name ?? n?._value ?? '')))
                .filter((x: any): x is string => typeof x === 'string' && !!x);
            if (names.length) {
                listForm = idx;
                return names;
            }
        } catch {
            /* 换下一条 */
        }
    }

    // ③ DOM 集合兜底
    try {
        const api: any = (app as any)?.brushes;
        if (api && typeof api.get === 'function') {
            const list: any = await api.get();
            if (Array.isArray(list)) {
                const names = list
                    .map((b: any) => b?.name)
                    .filter((x: any): x is string => typeof x === 'string' && !!x);
                if (names.length) return names;
            }
        }
    } catch {
        /* 放弃 */
    }
    return [];
}

/**
 * 检测上一版 bug 遗留的垃圾笔刷（预设名被误定成文档名 `tip.png`）。
 *
 * ⛔⛔ **只检测、不自动删除**（2026-10-20 真机改口）。
 *    原版用 `{_obj:'delete', _target:[{_ref:'brushPreset',...}]}` 去批量清，
 *    PS 直接弹宿主错误框「删除不可用」—— 那条描述符根本不合法。
 *    实测可用的删除命令只能删**当前选中的画笔**。所以「按名删」必须先按名选中，
 *    一旦选中静默失败，被删的就是用户当前正在用的笔刷。
 *    ⇒ 检测到就明确告知，让用户在画笔面板里框选删掉（一次性）。
 */
async function detectJunkTips(onLog?: (m: string) => void): Promise<number> {
    const names = await listBrushNames();
    const junk = names.filter((n) => /^tip\.png$/i.test(n)).length;
    if (junk) {
        onLog?.(`⚠️ 画笔面板里有 ${junk} 个误建的「tip.png」，请在 PS 画笔面板里框选删除（一次性）`);
    }
    return junk;
}

// ------------------------------------------------------------------ 笔尖安装

/**
 * 定义单个笔尖。只做「开文档 → defineBrush → 关文档」。
 *
 * 预设名 = **文档名**（PS 的 defineBrush 交互路径就是这么取名的），
 * 所以笔尖文件名必须是 `BRS-<id>.png` —— 名字因此**确定**，不用再靠差集去猜。
 *
 * ⛔ 不要在这里加「全选」：defineBrush 无选区时取整层内容，与全选结果一致；
 *     而 `selectAll` 这个 stringID 会直接换来 -25920（见文末踩坑记录 ①）。
 * ⛔ `dialogOptions` 必须 `silent`（见文件头 ①）——`dontDisplay` 会在
 *     "命令需要额外参数"时照样弹「新建画笔」框。
 * ⚠️ 关闭必须按 **_id** 定位，绝不能用 targetEnum —— 一旦定位失手就会关掉
 *     用户正在画的稿子（这是本文件里唯一能造成真实损失的写法）。
 */
async function defineOneTip(brush: BrushDef, onLog?: (m: string) => void): Promise<string> {
    const folder = await lfs.getPluginFolder();
    const entry = await folder.getEntry(`brushes/${brush.id}/${brush.tip}`);
    const name = TIP_PREFIX + brush.id;

    onLog?.(`① 打开笔尖图 ${brush.tip} …`);
    const doc: any = await app.open(entry as any);

    // 两条写法，**顺序有讲究**：
    //   A `DflB` = 「定义画笔预设」这条菜单命令的 4 字符 OSType。ExtendScript 时代
    //     大量脚本用 `executeAction(charIDToTypeID("DflB"), desc, DialogModes.NO)` 静默建笔，
    //     从来没见它弹名称框 —— 它和 stringID 的 `defineBrush` **不保证是同一条处理器**。
    //   B `defineBrush` = 现代 stringID。真机三次证明它会弹「新建画笔」框，
    //     `dialogOptions` 三档都挡不住（它就是新版的命名交互）。
    // ⛔ 只留这两条：每多一条候选，用户就可能多挨一个弹框。A 不认 ⇒ 才轮到 B。
    const variants: { label: string; desc: any }[] = [
        { label: 'DflB 字符ID', desc: { _obj: 'DflB', 'Nm  ': name, _target: DOC_TARGET } },
        { label: 'defineBrush', desc: { _obj: 'defineBrush', name, _target: DOC_TARGET } }
    ];

    const errors: string[] = [];
    let ok = '';
    try {
        try {
            if (doc && (app as any).activeDocument?.id !== doc.id) {
                (app as any).activeDocument = doc;
            }
        } catch {
            /* 设不了活动文档不致命：targetEnum 通常已经指向新文档 */
        }

        for (const v of variants) {
            onLog?.(`② 定义画笔（${v.label}）…`);
            try {
                await bp(v.desc, `定义笔尖（${v.label}）`);
                ok = v.label;
                onLog?.(`② 定义命令已接受（${v.label}）`);
                break;
            } catch (e: any) {
                const msg = e?.message || String(e);
                errors.push(`${v.label} → ${msg}`);
                onLog?.(`② ${v.label} 被拒：${msg.slice(0, 90)}`);
                // -128 = 用户在弹框上点了「取消」。别再试下一条，否则连弹
                if (/-128|cancel|取消|abort/i.test(msg)) {
                    errors.push('（-128）画笔名称弹框被取消，已停止后续尝试');
                    break;
                }
            }
        }
    } finally {
        await closeQuietly(doc);
    }
    if (!ok) throw new Error(`定义笔尖失败：${errors.join('；')}`);
    return ok;
}

/** 关临时文档：优先按 id 精确关闭；两条路都失败也不抛（不能让关闭失败盖住真实错误） */
async function closeQuietly(doc: any): Promise<void> {
    const id = doc?.id;
    if (typeof id === 'number') {
        try {
            await bp({ _obj: 'close', _target: [{ _ref: 'document', _id: id }], _options: { dontSave: true } } as any, '关闭临时文档');
            return;
        } catch {
            /* 落到下面用 UXP API 关 */
        }
    }
    try {
        await doc?.close?.();
    } catch {
        /* 关不掉就留给用户手动关，不阻断主链 */
    }
}

// ------------------------------------------------------------------ 选中 / 探测 / 删除

/** 「切画笔工具」用过的、成功的形态下标。会话内记住，避免每次都先撞一条失败 */
let toolForm = -1;

/**
 * 切到画笔工具（best-effort）。
 *
 * ⛔ 这一步比看起来重要：`set + brush` 是「把预设装到**当前工具**上」，
 *    如果当前是移动工具/抓手，笔尖装到哪儿去都说不清。
 *    Action Manager 切工具的写法是 `slct` + `Tool`（ordinal = 工具 ID），
 *    旧代码只有 `_ref:'paintbrushTool'` 一种，失败了还被 catch 吞掉 ⇒ 静默留在移动工具上。
 */
async function ensureBrushTool(): Promise<void> {
    // ⛔⛔ 每失败一条，PS 就在文档顶部刷一条**黄色通知**「悦绘: 命令"选择"当前不可用」。
    //    而 `{_ref:'tool', _enum:'ordinal', _value:'paintbrushTool'}` 在 PS 27 上**必然失败**。
    //    旧实现每次点击都先撞这条 ⇒ 用户看到那条一闪而过的长黄条，第一段就是它。
    //    ⇒ ① 会话内记住成功的形态，只发那一条；② 第一条默认就用 PS 27 认识的裸引用。
    const forms: any[] = [
        { _obj: 'select', _target: [{ _ref: 'paintbrushTool' }] },
        { _obj: 'select', _target: [{ _ref: 'tool', _enum: 'ordinal', _value: 'paintbrushTool' }] }
    ];
    const idxs = toolForm >= 0 ? [toolForm] : forms.map((_, i) => i);
    for (const i of idxs) {
        try {
            await bp(forms[i], '切画笔工具');
            toolForm = i;
            return;
        } catch {
            /* 试下一条；两条都失败也不致命（用户多半本来就在画笔工具上） */
        }
    }
}

/** 名字归一化：去扩展名、压空白、转小写。PS 给预设追加「 拷贝」时靠它认出来 */
function normName(s: string): string {
    return String(s || '')
        .replace(/\.png$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * 这个预设名是不是「<id> 这支笔」的。
 *
 * 匹配面故意放窄（不写 `startsWith(TIP_PREFIX)`）：
 * `BRS-impasto` 用宽前缀会吃掉 `BRS-impasto-detail`，那正是 2026-10-21「点堆叠细描拿到别人笔」的成因。
 * 允许的后缀只有 PS 自己会追加的「 拷贝 / 副本 / copy」。
 */
function sameTip(name: string, id: string): boolean {
    const n = normName(name);
    const base = normName(TIP_PREFIX + id);
    return n === base || n.startsWith(base + ' ') || n.startsWith(base + '副本');
}

/**
 * 选中形态候选表（**仅用于定位删除目标**）。
 *
 * ⛔ 别拿它来「换画笔」—— 它只是把画笔预设面板里的那一格高亮，
 *    当前工具画出来的东西一点没变。换笔请用 `applyPreset`（set）。
 *    这里保留它，是因为 `delete` 只能删「当前选中」，删之前得让面板高亮对准我们那支。
 */
const SELECT_FORMS: ((n: string) => any)[] = [
    (n) => ({ _obj: 'select', _target: [{ _ref: 'brushPreset', _name: n }], _isCommand: false }),
    (n) => ({ _obj: 'select', _target: [{ _ref: 'brush', _name: n }], _isCommand: false })
];
let selectForm = -1;
/** 每种形态最近一次的报错，失败时拼进日志（否则"选不中"永远是黑箱） */
const selectErr: string[] = [];

/**
 * 把画笔预设面板高亮到某个名字上。**返回是否成功**，不抛。
 *
 * ⚠️ 只影响面板高亮，**不影响工具笔尖**（见上面注释）。
 *    用途：`delete targetEnum` 删的是高亮项，所以删前用它对准。
 * 前提是 `dialogOptions: 'silent'`（`dontDisplay` 下它是宿主错误框、不进 catch）。
 */
async function trySelect(name: string, onLog?: (m: string) => void): Promise<boolean> {
    const idxs = selectForm >= 0 ? [selectForm] : SELECT_FORMS.map((_, i) => i);
    for (const i of idxs) {
        try {
            await bp(SELECT_FORMS[i](name), `选中预设「${name}」`);
            if (selectForm !== i) {
                selectForm = i;
                onLog?.(`选预设用「${i === 0 ? 'brushPreset' : 'brush'}」写法`);
            }
            return true;
        } catch (e: any) {
            selectErr[i] = e?.message || String(e);
        }
    }
    return false;
}

/** 选中失败的现场描述（拼给用户看，避免只报"没找到"） */
function selectFailure(): string {
    return selectErr.filter(Boolean).map((m, i) => `#${i + 1} ${m}`).join(' / ') || '未尝试';
}

/**
 * 「应用」画笔预设 —— 把笔尖**真正装到当前画笔工具上**。
 *
 * ⛔⛔ 2026-10-22 最大的一次认知修正，一个 bug 解释三个症状。
 *
 *    `select`（`{_obj:'select', _ref:'brush'|'brushPreset', _name}`）在 PS 里
 *    只是**把画笔预设面板里的那一格高亮**，当前画笔画出来的东西一点没变。
 *    所以「select 没报错」被当成了「笔已经换好了」，回读 `cto.brush.name`
 *    仍然是「喷枪」⇒ 于是：
 *      · 用户看到的还是喷枪（他要的笔尖没上）；
 *      · `capture` 抓到的不是这支笔的状态 → 「缓存笔尖状态」黄；
 *      · 删除安全阀判定名字不符 → 「清理预设」黄（保守不删）。
 *
 *    真正换笔尖的是 Action Manager 的 `setd`（set）+ `Brsh` 引用，
 *    也就是下面第 ① 条 `set + brush`。
 *
 * 判据铁律：**只看回读的画笔名有没有变**，绝不信"命令没报错"。
 */
const APPLY_FORMS: { label: string; make: (n: string) => any }[] = [
    // ① ExtendScript 时代的标准写法：setd + Brsh（按名把预设装到当前画笔）
    { label: 'set+brush', make: (n) => ({ _obj: 'set', _target: [{ _ref: 'brush', _name: n }] }) },
    // ② 同一动作的另一个类名
    { label: 'set+brushPreset', make: (n) => ({ _obj: 'set', _target: [{ _ref: 'brushPreset', _name: n }] }) },
    // ③ ExtendScript 里"选画笔预设"的原始形态：slct + Brsh + MkVs:false。
    //    与 ⑤ 的差别只在 `makeVisible` —— 少了它 PS 往往只高亮面板格子，
    //    带上它才是"应用"。AM 里 `MkVs` 的字符串键就是 `makeVisible`。
    {
        label: 'select+brush+MkVs',
        make: (n) => ({ _obj: 'select', _target: [{ _ref: 'brush', _name: n }], makeVisible: false })
    },
    // ④ 同一形态的另一个类名（部分版本只认 brushPreset）
    {
        label: 'select+brushPreset+MkVs',
        make: (n) => ({ _obj: 'select', _target: [{ _ref: 'brushPreset', _name: n }], makeVisible: false })
    },
    // ⑤⑥ 旧写法兜底：至少把面板格子选中（不保证换笔尖）
    { label: 'select+brush', make: (n) => ({ _obj: 'select', _target: [{ _ref: 'brush', _name: n }], _isCommand: false }) },
    {
        label: 'select+brushPreset',
        make: (n) => ({ _obj: 'select', _target: [{ _ref: 'brushPreset', _name: n }], _isCommand: false })
    }
];
let applyForm = -1;
const applyErr: string[] = [];

/**
 * 按名把一支画笔**应用到当前工具**。返回是否真的换上了。
 *
 * 成功一次就记住那条写法（`applyForm`），后续只试它，避免每次都 4 连问。
 */
async function applyPreset(
    name: string,
    onLog?: (m: string) => void
): Promise<{ ok: boolean; got: string | null; how: string; detail: string; tip: string | null }> {
    const idxs = applyForm >= 0 ? [applyForm] : APPLY_FORMS.map((_, i) => i);
    let got: string | null = null;
    /** 换之前工具上的笔尖句柄：名字读不到时，靠"笔尖变没变"当证据 */
    const tipBefore = sampledId(await readToolOptions());

    for (const i of idxs) {
        const f = APPLY_FORMS[i];
        try {
            await bp(f.make(name), `应用画笔「${name}」（${f.label}）`);
        } catch (e: any) {
            applyErr[i] = e?.message || String(e);
            continue;
        }

        // ⛔ 命令成功 ≠ 笔换上了。必须回读，这是本函数存在的全部意义。
        got = await currentBrushName();
        if (got && normName(got) === normName(name)) {
            if (applyForm !== i) {
                applyForm = i;
                onLog?.(`应用画笔用「${f.label}」写法`);
            }
            const tip = sampledId(await readToolOptions());
            return { ok: true, got, how: f.label, detail: `「${got}」`, tip };
        }

        // 名字读不到（工具上是 computedBrush）时的第二判据：
        // `set brush _name:X` 若 X 不存在会直接报错，所以"命令被接受 + 采样笔尖换了"
        // 足以证明换成了一支采样笔刷；名字待下次能读时再核。
        const tipNow = sampledId(await readToolOptions());
        if (!got && tipNow && tipNow !== tipBefore) {
            if (applyForm !== i) {
                applyForm = i;
                onLog?.(`应用画笔用「${f.label}」写法（按笔尖变更判定）`);
            }
            return {
                ok: true,
                got: name,
                how: `${f.label}·笔尖判`,
                detail: `笔尖已换（${tipNow.slice(0, 8)}…）`,
                tip: tipNow
            };
        }

        applyErr[i] = `命令成功，但工具上仍是「${got ?? '未知'}」`;
    }

    return { ok: false, got, how: '', detail: applyFailure(), tip: null };
}

/** 应用失败的现场描述（四条写法的报错原文，避免黑箱） */
function applyFailure(): string {
    return applyErr.filter(Boolean).map((m, i) => `#${i + 1} ${m}`).join(' / ') || '未尝试';
}

/**
 * 给**面板状态条**看的短版失败说明。
 *
 * ⛔⛔ 2026-10-22 12:08 用户录屏截图：状态条里出现整屏长的报错（6 种写法 × 完整中文报错），
 *    看起来就像"插件炸了"。原因是 `applyFailure()` 把每一条都拼了进去，
 *    而状态条 `.notify-text` 会换行铺满 —— 这是**我们必须避免的自我惊吓**。
 *    ⇒ 状态条只给一句话；完整原文继续写进 `brushstate/_last-run.json` 的 `applyErr`。
 */
function applyFailureBrief(): string {
    const n = applyErr.filter(Boolean).length;
    if (!n) return '未尝试任何写法';
    const first = String(applyErr.filter(Boolean)[0] || '');
    // 只取报错尾部的错误码/短句，去掉「应用画笔「xx」（方式）: 」这段重复前缀
    const tail = first.replace(/^.*?[）)]:\s*/, '').replace(/^.*?[:：]\s*/, '');
    return `${n} 种写法都被拒（${tail.slice(0, 40)}）`;
}

/**
 * 删掉**当前选中**的画笔预设。
 *
 * 这是「无痕」的最后一步：预设从画笔面板消失，但画笔工具仍停在这支笔上继续可用
 * （2026-10-22 用户真机验证）。于是用户点一下笔就能画，面板里不留任何我们的东西。
 *
 * ⛔ PS 没有「按名删除预设」的命令，只能删当前选中的 —— 所以调用前必须**确认当前
 *    选中的是我们自己的笔尖**（`trySelect` 成功），否则删掉的是用户正在用的笔。
 * ⚠️ 两种 `_ref` 形态都试；给了 `expectName` 就删完用清单核对一次
 *    （PS 有"命令报成功但没删掉"的先例，不核对会以为干净了）。
 */
async function deleteCurrentBrush(expectName?: string) {
    // ⚠️ `delete` 删的是**面板里高亮的那一格**。`applyPreset` 走 set 时不一定同步高亮，
    //    所以删前先按名高亮一次，把删除目标对准。这一条失败了不阻断（有的版本不认）。
    if (expectName) await trySelect(expectName);

    const forms: any[] = [
        { _obj: 'delete', _target: BRUSH_TARGET, _isCommand: false },
        { _obj: 'delete', _target: [{ _ref: 'brushPreset', _enum: 'ordinal', _value: 'targetEnum' }], _isCommand: false }
    ];
    const errs: string[] = [];

    for (const d of forms) {
        try {
            await bp(d, '删除画笔预设');
        } catch (e: any) {
            // 命令**被拒** ⇒ 什么都没删掉，换一种 `_ref` 重试是安全的
            errs.push(e?.message || String(e));
            continue;
        }

        // ⛔⛔ 别用 `listBrushNames()` 核对删除结果：`brushes` / `presetManager`
        //    这两个属性是**惰性快照**，删掉的预设照样列在里面。
        //    2026-10-22 11:41 就因此把一次成功的删除误判成"没删掉"，用户看到黄点。
        //    ⇒ 可靠判据是**按名 select**：名字不存在时 PS 必然报错（silent 下是普通异常）。
        if (expectName) {
            const still = await trySelect(expectName);
            if (still) {
                throw new Error(
                    `删除命令已被接受，但「${expectName}」仍能按名选中 —— 可能没删掉。` +
                        `已停止重试（再按 targetEnum 删一次会删到邻居）。请关掉画笔面板重开确认`
                );
            }
        }
        return;
    }

    throw new Error(errs.join(' / ') || '删除画笔预设失败');
}

// ------------------------------------------------------------------ 参数下发

/**
 * 从当前 `brush` 描述符里抄一份**完整**副本（只去掉 `_options`）。
 *
 * ⛔⛔ 2026-10-22 两次真机铁证：
 *    ① `set` 一个只含几何的 `brush`，PS 会把当前笔刷**整体替换成 `computedBrush`**
 *       （无 `name`、无 `sampledBrush.sampledData`）= 软边喷枪；
 *    ② 只挑 `_obj/name/sampledBrush/sampledData` 几个键带过去**仍然会丢笔尖** ——
 *       PS 缺字段就当成"一支新笔"重建（`_last-run` 里「笔尖守门」绿了，
 *       但缓存里的直径从 820 掉回预设默认的 399，就是它重建过的痕迹）。
 *    ⇒ 必须**整份拷回来、只覆盖要改的几何键**，PS 才认得出是同一支笔。
 */
function brushCopy(src: any): any {
    const out: any = {};
    if (!src || typeof src !== 'object') return out;
    for (const k of Object.keys(src)) {
        if (k === '_options') continue;
        out[k] = src[k];
    }
    return out;
}

/**
 * 几何参数：直径 / 间距 / 角度 / 圆度 / 流量 / 不透明度。
 * 返回第一个"PS 接受"的写法标签，便于日志定位。
 *
 * ⚠️ 必须在预设**还活着**的时候下发（删掉预设之后就没有写入对象了），
 *    所以整条链的顺序固定为：选中 → 下发 → 删除。
 *
 * ⛔⛔ 2026-10-22 三条路线都试过，顺序不能乱：
 *    ① `set paintbrushTool to 整份 cto（brush 只改几何）` —— **首选**。
 *       和 `setToolOpacity` 完全同一套路，而那条用户真机验证过「不丢笔尖」。
 *    ② `set brush targetEnum to 整份 brush` —— 回退。实测仍可能被 PS 重建（丢笔尖）。
 *    ③ 只发几何 6 键 —— **禁用**，那等于亲手把毛刷换成喷枪（见 `brushCopy`）。
 *    每一步写完都回读，判据是 `sampledData` 没变 **且** 直径真的改了。
 */
async function setBrushGeometry(p: BrushParams): Promise<string> {
    const geom = {
        diameter: px(p.diameter.base),
        spacing: pct(p.spacing),
        angle: deg(p.angle),
        roundness: pct(p.roundness),
        flow: pct(p.flow.base),
        opacity: pct(p.opacity.base)
    };

    const cto = await readToolOptions();
    if (!cto) throw new Error('读不到当前工具选项');
    const base = brushCopy(cto?.brush);
    const wantTip = sampledId({ brush: base });

    /** 写完必须回读：笔尖还在不在 + 直径到底改了没有 */
    const verify = async (label: string): Promise<string> => {
        const after = await readToolOptions();
        if (wantTip) {
            const got = sampledId(after);
            if (got !== wantTip) {
                throw new Error(
                    `${label} 之后采样笔尖被冲掉了（${wantTip.slice(0, 8)}… → ${got ?? '空'}）`
                );
            }
        }
        const d = after?.brush?.diameter?._value;
        if (typeof d === 'number' && Math.abs(d - p.diameter.base) > 2) {
            throw new Error(`${label} 之后回读直径 ${d}px ≠ ${p.diameter.base}px`);
        }
        return label;
    };

    // ① 整份工具状态回写（首选）
    let err1 = '';
    try {
        const to = brushCopy(cto);
        to.brush = { ...base, ...geom };
        await bp({ _obj: 'set', _target: [{ _ref: 'paintbrushTool' }], to } as any, '下发几何参数');
        return await verify(wantTip ? '工具状态(带笔尖)' : '工具状态');
    } catch (e: any) {
        err1 = e?.message || String(e);
    }

    // ② 回退：按画笔对象整份写
    try {
        await bp({ _obj: 'set', _target: BRUSH_TARGET, to: { ...base, ...geom } } as any, '下发几何参数');
        return await verify(wantTip ? '画笔(带笔尖)' : '画笔');
    } catch (e2: any) {
        throw new Error(`两种写法都没成：${err1} / ${e2?.message || e2}`);
    }
}

/*
 * 读工具选项 / 读当前画笔名已移到 psState.ts（`readToolOptions` / `currentBrushName`）。
 * 那边同时是「完整工具状态缓存」的宿主，两处共用一个实现，避免读法分叉。
 */

/**
 * 工具级不透明度/流量（画笔选项栏那两格）。
 *
 * PS 的语义：**流量 = 单个笔尖印章的不透明度**，**不透明度 = 一整笔的上限**。
 * 流量 30% 时每个印章只有三成实心，印章重叠处才累积到 100%。
 *
 * 写法（Adobe 论坛验证过的形态）：**读整份 cto → 改两个值 → `set` 到
 * `paintbrushTool`**。比"只 set 两个键"稳，因为它交回去的是 PS 自己刚吐出来的结构。
 * 成功后回读校验；读不到就跳过校验，不假失败。
 */
async function setToolOpacity(p: BrushParams): Promise<string> {
    const cto = await readToolOptions();
    if (!cto) throw new Error('读不到当前工具选项');

    const to: any = { ...cto, opacity: pct(p.opacity.base), flow: pct(p.flow.base) };
    await bp({ _obj: 'set', _target: [{ _ref: 'paintbrushTool' }], to } as any, '下发工具不透明度');

    const after = await readToolOptions();
    const gotFlow: any = after?.flow?._value;
    const wantFlow = Math.round(p.flow.base * 100 * 100) / 100;
    if (typeof gotFlow === 'number' && Math.abs(gotFlow - wantFlow) > 2) {
        throw new Error(`回读流量 ${gotFlow}% ≠ ${wantFlow}%`);
    }
    return typeof gotFlow === 'number' ? `回读流量 ${gotFlow}%` : '已下发（未回读校验）';
}

/**
 * 下发全部参数（画笔几何 + 工具级不透明度/流量）。
 *
 * 快路径（复用缓存）和慢路径（完整安装）都调它 —— **参数以 brush.json 为准，
 * 每次点击都重刷一遍**，这样改了 brush.json 立刻生效，不会被旧缓存盖住。
 * 缓存只负责"把笔尖恢复出来"，不负责参数。
 *
 * ⛔⛔ 现在是「笔尖优先」：参数下发**不许**把采样笔尖弄丢。丢了就立刻用预设名
 *    重装一次把笔尖找回来 —— 宁可几个几何值没生效，也不能让用户拿到一支喷枪。
 *    返回 `tipOk=false` 时上层**不许删预设**（预设是唯一的笔尖来源）。
 */
async function applyParams(
    p: BrushParams,
    push: (s: ApplyStep) => void,
    onLog?: (m: string) => void,
    /** 当前装着的预设名：笔尖被参数冲掉时用它重装 */
    presetName?: string
): Promise<{ tipOk: boolean }> {
    const cur = await readToolOptions();
    const tipBefore = sampledId(cur);

    // ⛔⛔ 没有采样笔尖时**绝不下发几何**：那会把笔刷整体换成 `computedBrush`（喷枪）。
    //     宁可几个参数没生效，也不能把用户刚装上的毛刷换成一支软边圆笔。
    if (!tipBefore) {
        push({
            name: '下发画笔参数',
            ok: false,
            warn: true,
            msg: '工具上还没有采样笔尖 —— 此时下发几何只会把笔刷换成计算笔刷（喷枪），已跳过'
        });
        return { tipOk: false };
    }

    try {
        const mode = await setBrushGeometry(p);
        onLog?.(`画笔参数已下发（${mode} 写法）`);
        push({ name: '下发画笔参数', ok: true, msg: mode });
    } catch (e: any) {
        push({ name: '下发画笔参数', ok: false, warn: true, msg: e?.message || String(e) });
    }
    try {
        const t = await setToolOpacity(p);
        push({ name: '下发工具不透明度', ok: true, msg: t });
    } catch (e: any) {
        push({ name: '下发工具不透明度', ok: false, warn: true, msg: e?.message || String(e) });
    }

    // ── 笔尖守门：下发前有采样笔尖，下发后必须有，且必须是同一个
    if (!tipBefore) return { tipOk: true };
    const tipAfter = sampledId(await readToolOptions());
    if (tipAfter === tipBefore) return { tipOk: true };

    let fixed = false;
    if (presetName) {
        const r = await applyPreset(presetName, onLog);
        fixed = r.ok && !!sampledId(await readToolOptions());
        onLog?.(fixed ? `笔尖被参数冲掉，已用预设「${presetName}」重装回来` : `笔尖被参数冲掉，重装也失败：${r.detail}`);
    }
    push({
        name: '笔尖守门',
        ok: fixed,
        warn: !fixed,
        msg: fixed
            ? '参数下发把采样笔尖换成了计算笔刷，已重装预设恢复（个别几何值可能没生效）'
            : '参数下发把采样笔尖换掉了，且没能恢复 —— 本轮保留预设'
    });
    return { tipOk: fixed };
}

// ------------------------------------------------------------------ 主入口

export type ApplySource = 'cache' | 'preset' | 'define' | 'mixer';

export interface ApplyResult {
    steps: ApplyStep[];
    ok: boolean;
    /** 检测到的误建笔刷数（>0 时面板要提示用户去画笔面板手删） */
    junk: number;
    /** 本次实际选中的预设名（删除前），便于用户对照 */
    preset?: string;
    /**
     * true = 没有重新定义笔尖（走缓存或复用已有预设）。
     * 面板据此换措辞：这两种情况下**没有创建过预设**，
     * 不该再提示"预设已移除"之类的自责话。
     */
    restored?: boolean;
    /** 本次实际走的路径，详见 applyBrush 里的注释 */
    source?: ApplySource;
    /** 非空 = 这一次是**降级**完成的（混合器笔刷直径改不动，图案被等比缩到笔刷尺寸） */
    degraded?: string;
}

/**
 * 应用一支笔。整条链在**一个模态作用域**里跑完：
 *
 *   切画笔工具 → 清残留 → 定义 → 选中(探针) → 校验 → 下发参数 → 删除预设
 *
 * ⛔ 每次点击都完整走一遍，**不做任何"已装过"缓存**。
 *    老实现的 `tipReady` 缓存是"点同一支笔第二次拿到别人笔刷"的元凶：
 *    预设每轮都被删掉了，缓存却还说它在，于是跳过了 define/select。
 * ⛔ 删除放在 finally 里（见文件头 ③）。
 */
export async function applyBrush(
    brush: BrushDef,
    /** @deprecated 2026-10-21 起按需单支安装，不再需要整份清单；保留形参只为兼容调用方 */
    _all: BrushDef[],
    onStep?: (s: ApplyStep) => void,
    onLog?: (msg: string) => void
): Promise<ApplyResult> {
    const steps: ApplyStep[] = [];
    let junk = 0;
    let preset = '';
    const push = (s: ApplyStep) => {
        steps.push(s);
        onStep?.(s);
    };

    /**
     * 这条链走的是哪一种路径：
     *   cache  = 缓存整份工具状态（不建、不删任何预设）
     *   preset = 面板里已经有我们的预设，直接用它（选中 → 参数 → 抓缓存 → 删预设）
     *   define = 真的定义了一次（会弹「新建画笔」框，一次性）
     */
    let source: ApplySource = 'define';

    /** capture 失败时的 PS 原始响应，最后统一落盘（排障用，不影响主链） */
    let debugRaw: any = null;

    /* ── ⓿ 混合器路线（2026-10-22 用户定案：「装储层」并入这一下点击）────────
     *
     * 带 `mixer` 字段的笔**不走** defineBrush + cto 缓存那条链。原因不是那条链不好，
     * 而是它造出来的是「一支带采样笔尖的普通画笔」—— 普通画笔一笔只有一个亮度，
     * 而厚涂要的是**一笔多亮度**，PS 里只有混合器的储层能做到（储层是位图，落笔按位置取色）。
     *
     * ⛔ 三条不能动的：
     *   ① **整段不能包在一个 runAsModal 里**。装储层靠原生合成 Alt+左键，
     *      模态作用域里 PS 会挡住工具输入 —— 点被吞掉，日志却全绿。
     *      `reloadReservoir` 自己按需开小而短的模态作用域（开文档/读像素/写像素）。
     *   ② 笔刷直径必须等于图案长边（178×400 ⇒ 400），否则吸的区域与图案尺寸不一致，
     *      图案会被裁掉或缩放 —— 用户说的"严丝合缝"就是这个。
     *   ③ 换前景色后储层会变成纯前景色（PS 内部行为），所以**每次点击都要重装一次**，
     *      这正是"点一次堆叠细描就装一次储层"的原因。
     */
    if (brush.mixer?.pattern) {
        const rel = `brushes/${brush.id}/${brush.mixer.pattern}`;
        onLog?.(`「${brush.name}」走混合器储层路线（图案 ${brush.mixer.pattern}）…`);
        /** 降级说明（笔刷直径改不动、图案被缩放）—— step 里写，step 外要用 */
        let degraded = '';
        const st = await step(
            '安装并应用笔刷',
            async () => {
                const rr = await reloadReservoir((m) => onLog?.(m), {
                    pattern: rel,
                    side: brush.mixer!.side
                });
                if (rr.stage === 'not-mixer') throw new Error('切不到混合器画笔（候选 wetBrushTool / mixerBrushTool 都被拒）');
                if (rr.stage === 'no-ws') throw new Error('原生宿主没连上（WS 18924）—— 请重载插件');
                if (rr.err) throw new Error(rr.err);
                /* ⛔ 两层判据分开说，别混成一句（16:16 那句「储层装上了但没验上」就是把
                   两层揉在一起，结果两个都没说清，用户只能看到一条红条）：
                     · `!rr.loaded`  ⇒ 储层里根本没位图，Alt+点击没生效
                     · `!rr.ok`      ⇒ 位图装进去了，但那一笔画出来不是多亮度
                 */
                if (!rr.loaded) {
                    throw new Error(
                        `储层没装上（${rr.after ?? '读不到储层'}）—— Alt+点击没有把图案装进去，` +
                            `现在还是纯色。详见 brushstate/_mixer-reload.json`
                    );
                }
                if (!rr.ok && rr.dab) {
                    /* ⛔ 别再把三种完全不同的失败写成一句「画出来是纯色」：
                       16:33 那次 `opaque` 只有 340px（混合器单击本来就几乎不出颜料），
                       却被报成"纯色"，用户只能一头雾水。三类分开说：
                         · 颜料太少 ⇒ Alt 那一枪吸到了空白（视图没居中）
                         · 颜料够但没层次 ⇒ 储层里确实是纯色
                         · 有层次但色相不对 ⇒ 图案没跟着前景色走 */
                    const d = rr.dab;
                    const why =
                        d.opaque <= rr.side * 6
                            ? '这一笔几乎没落下颜料（Alt 那枪多半吸到了空白）'
                            : d.lumaStd < 6
                              ? '画出来是一片纯色（储层里装的不是图案）'
                              : '颜色没跟着前景色走';
                    throw new Error(
                        `储层装上了（${rr.after}），但${why}（拖笔 ${d.opaque}px、亮度 ±${d.lumaStd}、` +
                            `色相 cos=${d.tintCos}） —— 详见 brushstate/_mixer-reload.json`
                    );
                }
                if (!rr.ok) throw new Error('储层没装成功 —— 详见 brushstate/_mixer-reload.json');
                degraded = rr.degraded;
                push({
                    name: rr.degraded ? '装储层（降级）' : '装储层',
                    ok: true,
                    warn: !!rr.degraded,
                    msg:
                        `${rr.patSize} 图案 → ${rr.side}×${rr.side} 方块，笔刷直径 ${rr.diaBefore}→${rr.diaAfter}；` +
                        `储层 ${rr.after ?? '—'}；dab 亮度 ±${rr.dab?.lumaStd ?? 0}、色相 cos=${rr.dab?.tintCos ?? 0}` +
                        (rr.degraded ? `；⚠️ ${rr.degraded}` : '')
                });
            },
            push
        );
        // 换过的工具/直径对用户是"看不见的状态"，成功也要留一行说明；失败由 step 自己标红
        if (st.ok) onLog?.(`「${brush.name}」储层已就位${degraded ? `（降级：${degraded}）` : ''}`);
        return {
            steps,
            ok: steps.every((s) => s.ok || s.warn),
            junk: 0,
            preset: '',
            source: 'mixer',
            restored: false,
            degraded: degraded || undefined
        };
    }

    /**
     * 抓当前工具状态存成缓存。
     *
     * `stored` = 状态**真的落盘了**；`tip` = 笔尖句柄（`sampledData`），普通圆笔没有。
     * 两者分开是因为它们决定两件不同的事：
     *   · stored=false ⇒ 下次点击没退路 ⇒ **这一轮不许删预设**（预设是唯一的笔尖来源）；
     *   · tip=null     ⇒ 缓存里没有采样笔尖，复灌后会是空心圆 ⇒ 同样别指望它。
     */
    /**
     * 抓当前工具状态存成缓存。
     *
     * `stored` = 状态**真的落盘了**；`tip` = 笔尖句柄（`sampledData`），普通圆笔没有。
     *
     * ⛔ 判据是**有没有采样笔尖**，不是有没有画笔名。
     *    2026-10-22 真机：工具上若挂的是 `computedBrush`（纯几何计算笔刷），
     *    `brush` 字段照样存在，但既没有 `name` 也没有 `sampledBrush` ——
     *    旧实现拿 `currentBrushName()` 当门槛，于是"读到了却永远没有名字"，
     *    缓存恒失败、预设恒不删，两个黄点一起亮。
     *    现在按笔尖判：没有 `sampledData` 就说清楚"挂的是计算笔刷、缓存救不回来"。
     */
    const capture = async (note: string): Promise<{ stored: boolean; tip: string | null }> => {
        try {
            const cto = await readToolOptions();
            const tip = cto ? sampledId(cto) : null;
            const nm = cto ? await currentBrushName(cto) : null;

            // 名字能读到、却不是这支笔 ⇒ 说明前面那步其实没换上，别把别人的笔尖存成缓存
            if (cto && tip && nm && !sameTip(nm, brush.id)) {
                push({
                    name: '缓存笔尖状态',
                    ok: false,
                    warn: true,
                    msg: `工具上挂的是「${nm}」，不是这支笔 —— 不存缓存`
                });
                return { stored: false, tip: null };
            }

            if (cto && tip) {
                await saveState(brush.id, cto);
                push({ name: '缓存笔尖状态', ok: true, msg: `含采样笔尖「${nm ?? '未命名'}」（${note}）` });
                onLog?.(`已缓存工具状态：含采样笔尖 ${tip.slice(0, 8)}…`);
                return { stored: true, tip };
            }

            debugRaw = await readToolOptionsRaw();
            const obj = cto?.brush?._obj ?? cto?._obj ?? '未知';
            push({
                name: '缓存笔尖状态',
                ok: false,
                warn: true,
                msg: cto
                    ? `工具上是计算笔刷（brush._obj=${obj}），没有采样笔尖 —— 缓存救不回来`
                    : '读不到工具状态，下次仍需安装'
            });
        } catch (e: any) {
            push({ name: '缓存笔尖状态', ok: false, warn: true, msg: e?.message || String(e) });
        }
        return { stored: false, tip: null };
    };

    /**
     * 删完预设后核对：笔尖句柄变了 ⇒ 缓存已经失效（下次点击必然要重新定义）。
     * 不核对就会出现"面板显示缓存成功、下次还是弹框"的黑箱，所以这一步必须做。
     */
    const checkTipLives = async (want: string | null) => {
        if (!want) return;
        const now = sampledId(await readToolOptions());
        if (now === want) return;
        push({
            name: '缓存自检',
            ok: false,
            warn: true,
            msg: '预设删除后笔尖句柄变了，缓存已失效 —— 下次点击会重新安装（需点一次确定）'
        });
        await dropState(brush.id);
    };

    const job = async () => {
        // 历史遗留的误建 tip.png：只报不删（见 detectJunkTips 注释）
        junk = await detectJunkTips(onLog);

        // 预设名的**权威**：笔尖文件名（PS 用文档名当预设名）
        const main = `${TIP_PREFIX}${brush.id}.png`;
        const alt = TIP_PREFIX + brush.id;

        // ⓪ 切画笔工具：后面 select 预设才有意义
        await ensureBrushTool();

        // ── ① 快路径：缓存里存着这支笔的**完整工具状态**，直接整份灌回画笔工具。
        //
        // ⛔⛔ 这一步必须排在**任何预设探测之前**（2026-10-22 12:00 的"长黄条"根因）。
        //    问"预设到底在不在"只有按名 `select` 这一条路 —— 而名字不存在时 PS **必报 -25920**，
        //    并且把**每一条失败的 batchPlay 都画成一条黄色通知**「悦绘: 命令"选择"当前不可用」。
        //    走缓存时我们压根不碰预设，却仍然先探了 2 个名字 × 2 种形态、再试 2 个名字 × 6 种装法
        //    ⇒ 十几条失败糊成一片长黄条。功能全绿，用户却以为出错了。
        //    ⇒ 顺序最终定为：**先缓存（零失败零通知）→ 缓存不行再查面板 → 最后才 define**。
        //
        // 这条路完全不碰 defineBrush ⇒ 不弹「新建画笔」框；
        //                      → 不建画笔预设 ⇒ 面板里零痕迹；
        //                      → 也就没有"删不干净"的可能。
        // 依据：用户真机验证过"预设删掉后画笔仍停在上面且可用"——
        //      说明笔尖数据活在工具状态里，不靠预设续命（详见 psState.ts 文件头）。
        const cached = await loadState(brush.id);
        if (cached) {
            try {
                const r = await restoreState(cached, [main, alt], onLog);
                if (r.verdict === 'ok') {
                    source = 'cache';
                    push({ name: '复用已缓存的笔尖', ok: true, msg: r.detail });
                    onLog?.(`「${brush.name}」直接恢复，未创建任何预设`);
                    const par = await applyParams(brush.params, push, onLog);
                    // 复灌后笔尖没能保住 ⇒ 缓存本身有问题（里面没有可用的笔尖数据）
                    // ⇒ 立刻清掉，下次点击走完整安装，别让一份坏缓存在这儿反复出错。
                    if (!par.tipOk) {
                        await dropState(brush.id);
                        onLog?.('缓存复灌后笔尖没保住，已清掉缓存 —— 下次点击会完整重装一次');
                    }
                    return;
                }
                onLog?.(`缓存不可用（${r.detail}），需要重新定义笔尖`);
                if (r.verdict === 'tip-lost' || r.verdict === 'name-mismatch') {
                    await dropState(brush.id);
                }
            } catch (e: any) {
                onLog?.(`缓存复灌失败（${e?.message || e}），需要重新定义笔尖`);
                await dropState(brush.id);
            }
        }

        // ── ② 缓存走不通，才去面板里找这支笔的预设。
        //
        // ⛔ 只用**清单**定真名，**不再按名 `select` 试存在性**。
        //    上次那版按名探测，是为了绕开清单的惰性快照（删掉的预设仍列着）；
        //    代价是名字不存在时每条 `select` 都失败 ⇒ 每失败一条 PS 就画一条黄色通知。
        //    现在方向反过来：清单里**有**我们的名字 ⇒ 直接拿去装（装不上再说）；
        //                  清单里**没有** ⇒ 本来就没有可用预设，不去探。
        //    "多报"在这个方向上古无害：最多多一条通知，而真删掉的情况只可能发生在
        //    同一轮里我们刚删完自己的预设（那时下一轮走缓存，根本到不了这里）。
        const listed = await listBrushNames();
        const ours = listed.filter((n) => sameTip(n, brush.id));
        push({
            name: '扫描已有预设',
            ok: true,
            msg: listed.length
                ? `清单 ${listed.length} 项，${ours.length ? `有「${ours.join('、')}」` : '没有我们的笔尖'}`
                : '读不到画笔清单'
        });

        // ── ③ 清单里真有 ⇒ 拿它装笔，装完抓缓存 → 删预设，**绝不重建**
        //
        // ⛔ 这里必须用 `applyPreset`（set），不能用 `trySelect`（select）。
        //    select 只是高亮面板格子；用户"还是喷枪"就是它造成的。
        // 清单读不到（空数组）时退回猜名 —— 否则会白白 define 出一份「拷贝」。
        const candidates = listed.length ? ours : [main, alt];
        for (const n of candidates) {
            const r = await applyPreset(n, onLog);
            if (!r.ok) {
                // 状态条只给一句话，完整 6 条原文进 `_last-run.json` 的 applyErr（见 applyFailureBrief）
                onLog?.(`「${n}」装不上：${applyFailureBrief()}`);
                continue;
            }

            preset = n;
            source = 'preset';
            push({ name: '复用已有预设', ok: true, msg: `「${r.got}」（${r.how}，未重新定义）` });
            const par = await applyParams(brush.params, push, onLog, n);
            // ⚠️ 先抓缓存再删预设：删掉之后工具上的名字会变，那时抓到的就不是"这支笔"了
            const cap = await capture('取自已有预设');

            // ⛔ 缓存没建成 或 笔尖已被参数冲掉 ⇒ **不删预设**。预设是这支笔唯一的来源，
            //    删了下次点击就只剩 define 一条路（必弹框）。宁可面板里留一格，
            //    也不能为了"无痕"把下次的退路拆掉。
            if (!cap.stored || !par.tipOk) {
                push({
                    name: '清理预设',
                    ok: false,
                    warn: true,
                    msg: !par.tipOk
                        ? '采样笔尖没能保住 —— 预设是它唯一的来源，本轮保留'
                        : '缓存没建成 —— 预设是这支笔唯一的来源，删了下次又要弹框，所以本轮保留它'
                });
                return;
            }

            try {
                await deleteCurrentBrush(n);
                onLog?.('预设已从画笔面板移除（画笔仍可用）');
            } catch (e: any) {
                push({ name: '清理预设', ok: false, warn: true, msg: e?.message || String(e) });
            }
            // 删完核对笔尖句柄是否还活着：决定"下次点击是否真的不用再定义"
            await checkTipLives(cap.tip);
            return;
        }
        if (ours.length) {
            push({
                name: '复用已有预设',
                ok: false,
                warn: true,
                msg: `清单里有「${ours[0]}」，但装不到工具上：${applyFailureBrief()}`
            });
            onLog?.(`清单里明明有「${ours.join('、')}」，却装不上 —— 本轮**不重建**（重建只会多出重复预设）`);
        }

        // 清单明明有、却装不上 ⇒ 停在这里。继续 define 只会在面板里堆出「拷贝」
        if (ours.length) {
            throw new Error(
                `画笔面板里已有「${ours[0]}」，但装不到工具上（${applyFailureBrief()}）。` +
                    `为避免重复创建，本轮停止。请确认当前工具是画笔工具后重试。`
            );
        }

        // ── ④ 慢路径：真去定义一次（这是唯一会弹框的一步，一支笔一辈子一次）
        //
        // ⚠️ 先记下"定义前工具上是哪支笔"：`DflB` 若被 PS 接受，它会顺手把新笔设为当前笔，
        //    哪怕名字不是我们给的 `BRS-xxx`。有这个名字变化当证据，就不必死磕清单。
        const nameBefore = await currentBrushName();
        onLog?.(`安装笔尖 ${brush.name} …`);
        const how = await defineOneTip(brush, onLog);
        onLog?.(`定义用了「${how}」`);
        push({
            name: '定义笔尖',
            ok: true,
            msg: how === 'DflB 字符ID' ? '静默通过（DflB）' : '通过（defineBrush，弹了名称框）'
        });

        // ⑤ 应用：定义完再读一次清单拿真名（PS 可能不叫文档名），再 set 到工具上
        //
        // ⛔ 同 step ②：这里也只能用 `applyPreset`。`select` 只会高亮面板格子，
        //    工具上仍是喷枪 —— 那正是"点了半天笔尖没变"的现场。
        let picked: string | null = null;
        let appliedHow = '';
        const auto = await currentBrushName();
        if (auto && auto !== nameBefore) {
            picked = auto;
            appliedHow = 'PS 自动应用';
            onLog?.(
                `定义后工具上已变成「${auto}」${sameTip(auto, brush.id) ? '' : '（PS 自己取的名，不是我们给的）'}`
            );
        }
        // 窗口 ~3s：如果 PS 弹了「画笔名称」框而用户点了确定，预设要等那一瞬间才落盘
        for (let i = 0; i < 15 && !picked; i++) {
            const names = (await listBrushNames()).filter((n) => sameTip(n, brush.id));
            for (const n of names.length ? names : [main, alt]) {
                const r = await applyPreset(n, onLog);
                if (r.ok) {
                    picked = n;
                    appliedHow = r.how;
                    break;
                }
            }
            if (!picked) {
                if (i === 0) onLog?.(`⑤ 等 PS 落盘「${main}」…`);
                await sleep(200);
            }
        }
        if (!picked) {
            throw new Error(
                `定义命令执行了，但「${main}」既不在清单里、也装不到工具上（${applyFailureBrief()}）；` +
                    `工具上仍是「${auto ?? '未知'}」`
            );
        }
        preset = picked;
        if (appliedHow !== 'PS 自动应用') onLog?.(`已应用画笔「${picked}」（${appliedHow}）`);

        // ⑤b 校验：工具上挂的到底是不是我们这支（"货不对版"的现场判据）
        //
        // ⚠️ 这一步只作为**删除安全阀**，不当作硬失败：
        //    · 名字对得上 → 放心删；
        //    · 读不到名字（老版本 / cto 里没有 brush.name）→ 只能信 select 的结果，也删；
        //    · 名字对不上 → **不删**。宁可留一个预设（用户可手删），
        //      也不能删掉用户自己那支笔 —— 这个方向的风险不对称，不能赌。
        let verified: 'match' | 'unknown' | 'mismatch' = 'unknown';
        for (let i = 0; i < 2; i++) {
            const got = await currentBrushName();
            if (!got) {
                verified = 'unknown';
                break;
            }
            if (normName(got) === normName(picked)) {
                verified = 'match';
                break;
            }
            onLog?.(`⚠️ 应用后工具上仍是「${got}」，不是「${picked}」，重试应用…`);
            verified = 'mismatch';
            await applyPreset(picked, onLog);
            await sleep(120);
        }
        onLog?.(`已应用画笔「${picked}」${verified === 'unknown' ? '（无条件回读校验）' : ''}`);

        // ⑥ 下发参数。⛔ 一步失败不许跳出：清理在 finally 里等着
        let cap: { stored: boolean; tip: string | null } = { stored: false, tip: null };
        let tipOk = true;
        try {
            const par = await applyParams(brush.params, push, onLog, picked);
            tipOk = par.tipOk;
            // ⑥b 存缓存 —— **必须在 delete 之前**：此刻工具上确实挂着我们这支笔，
            //     抓到的 cto 才是"这支笔"的状态。这份缓存是下次点击走快路径的唯一依据，
            //     也是「以后不再弹框」的全部本钱。
            cap = await capture('取自新建预设');
        } finally {
            // ⑦ 收尾。三种情形分开，别用一句"删了"糊过去：
            //    · 笔尖没保住 ⇒ 不删（预设是唯一来源）
            //    · 缓存没建成 ⇒ 不删（删了下次必弹框）
            //    · 名字对不上 ⇒ 不删（删错就是删用户的笔）
            //    · 其余       ⇒ 删（这才是"无痕"）
            if (!tipOk) {
                push({
                    name: '清理预设',
                    ok: false,
                    warn: true,
                    msg: `采样笔尖没能保住 —— 预设「${picked}」留着当来源（删了这支笔就没了）`
                });
            } else if (!cap.stored) {
                push({
                    name: '清理预设',
                    ok: false,
                    warn: true,
                    msg: `缓存没建成 —— 预设「${picked}」留着当退路（删了下次又要弹框）`
                });
            } else if (verified === 'mismatch') {
                push({
                    name: '清理预设',
                    ok: false,
                    warn: true,
                    msg: `工具上的画笔名与「${picked}」不符，为免删错已保留预设 —— 请在画笔面板手动删掉「${picked}」`
                });
            } else {
                try {
                    await deleteCurrentBrush(picked);
                    onLog?.('预设已从画笔面板移除（画笔仍可用）');
                } catch (e: any) {
                    push({ name: '清理预设', ok: false, warn: true, msg: e?.message || String(e) });
                }
            }
            await checkTipLives(cap.tip);
        }
    };

    // 清掉上一轮的现场（模块级数组会跨点击累积，混在一起就读不出因果了）
    cmdLog.length = 0;
    notifLog.length = 0;
    applyErr.length = 0;
    selectErr.length = 0;
    startNotifySniff();

    await step('安装并应用笔刷', () =>
        // ⚠️ 不要传 `interactive: false`：它会让 PS 在模态期间禁掉一切交互，
        //    万一 defineBrush 还是弹了名称框，用户点不动反而卡死。
        runAsModal(job, { commandName: '应用特制笔刷' }).then(() => undefined), push);

    // PS 的黄色通知条多半在命令**之后**异步派发，稍等一下再收网（否则抓到的永远是空的）
    await sleep(400);
    stopNotifySniff();

    // 每次点击落一份现场到 `brushstate/_last-run.json`：步骤、成败、每条命令的原始返回、
    // PS 派发的通知、以及工具状态原文。面板一行显示不完，用户也没法把日志发过来。
    await dumpRun({
        at: new Date().toISOString(),
        brush: { id: brush.id, name: brush.name, tip: brush.tip, params: brush.params },
        source,
        preset,
        steps,
        applyForm: applyForm >= 0 ? APPLY_FORMS[applyForm]?.label : null,
        selectForm: selectForm >= 0 ? selectForm : null,
        applyErr: applyErr.filter(Boolean),
        selectErr: selectErr.filter(Boolean),
        /**
         * 本轮**失败的命令条数**。PS 每失败一条 batchPlay 就在文档顶部画一条黄色通知
         * 「悦绘: 命令"xx"当前不可用」，多条会连成一片。
         * ⇒ 判据：**正常点击（走缓存）必须是 0**。>0 就一定会有黄条，看 `commands` 定位是哪条。
         */
        failCount: cmdLog.filter((c: any) => c?.res && c.res._obj === 'error').length,
        /**
         * ⭐ 排查"一闪而过的黄色通知"就看这两段：
         *   · `notifications` = PS 派发的 AM 通知事件（原样，含 `evt` 名）
         *   · `commands`      = 每条命令的返回精简（`message`/`text`/`result` 通常就是黄条文案）
         */
        notifications: notifLog,
        commands: cmdLog,
        /**
         * 一句话版"提示候选"：把命令返回里的 `message`/`text` 与通知事件里的文案挑出来。
         * 排障时先看这一段 —— PS 那条一闪而过的黄条在这里必定现形。
         */
        hints: [
            ...notifLog.map((n: any) => ({
                from: 'notification',
                evt: n.evt,
                text: n.desc?.message ?? n.desc?.text ?? n.desc?.notification ?? n.desc
            })),
            ...cmdLog
                .filter((c: any) => c.res && (c.res.message || c.res.text))
                .map((c: any) => ({ from: 'command', cmd: c.cmd, text: c.res.message ?? c.res.text }))
        ],
        rawToolOptions: debugRaw
    });

    return { steps, ok: steps.every((s) => s.ok || s.warn), junk, preset, source, restored: source !== 'define' };
}

/**
 * 丢掉某支笔的状态缓存，强制下次点击走完整安装（会弹一次「新建画笔」框）。
 *
 * 什么时候需要：换了笔尖图 / 改了笔尖尺寸 / 从别的机器搬来缓存。
 * 参数改动**不需要**清缓存 —— 参数每次下发，缓存只存笔尖。
 */
export async function rebuildState(id: string): Promise<void> {
    await dropState(id);
}

/** 现有的笔尖状态缓存清单（诊断用） */
export async function cachedBrushIds(): Promise<string[]> {
    return listStates();
}

// ------------------------------------------------------------------ 校准

/**
 * 读出**当前画笔描述符**的原始 JSON。
 *
 * 这是解决"参数键名靠猜"的唯一正确做法：先让用户在 PS 里手动把这支笔该有的
 * 动力学/纹理设好，点「校准」把描述符贴回来，我们按真值把 psBrush.ts 的映射表
 * 补成确定值。
 *
 * ⚠️ 2026-10-20 真机两个坑：
 *   ① `{_ref:'brush', targetEnum}` 直接 get 换来 -25920「命令"获取"当前不可用」
 *      ⇒ 改成优先读 `application.currentToolOptions`，`brush` 那条降为兜底；
 *   ② 原实现直接 `JSON.stringify(res)`，**把 `_obj:'error'` 当成功回给面板**，
 *      于是面板显示"已读取"、框里却是一段错误 JSON ⇒ 现在统一走 `bp` 抛错。
 */
export async function readCurrentBrush(): Promise<string> {
    const candidates: { label: string; target: any[] }[] = [
        { label: 'currentToolOptions', target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET] },
        { label: 'brush(targetEnum)', target: [{ _ref: 'brush', _enum: 'ordinal', _value: 'targetEnum' }] },
        { label: 'application.brush', target: [{ _ref: 'property', _property: 'brush' }, ...APP_TARGET] }
    ];

    return await runAsModal(
        async () => {
            const errors: string[] = [];
            for (const c of candidates) {
                try {
                    const res: any = await action.batchPlay(
                        [{ _obj: 'get', _target: c.target, _options: { dialogOptions: 'silent' } }] as any,
                        { synchronousExecution: true } as any
                    );
                    const first: any = Array.isArray(res) ? res[0] : res;
                    if (!first || first._obj === 'error') {
                        errors.push(`${c.label}: ${first?.message || first?.result || '空结果'}`);
                        continue;
                    }
                    return JSON.stringify(first, null, 2);
                } catch (e: any) {
                    errors.push(`${c.label}: ${e?.message || e}`);
                }
            }
            throw new Error(`读取画笔描述符失败（${errors.join(' / ')}）`);
        },
        { commandName: '读取画笔参数' }
    );
}

/* ============================================================================
 * 踩坑记录（真机）
 * ----------------------------------------------------------------------------
 * ① 2026-10-20 -25920「命令"<未知的>"当前不可用」
 *    `_obj:'selectAll'` 不是合法命令名。全选的正确写法是
 *    `set` + `channel.selection` → `allEnum`，而 defineBrush 本身不需要选区 ⇒ 删掉。
 *
 * ② 2026-10-20 每点一次笔刷弹一个「画笔名称」框，默认名 tip.png
 *    缺 `_options.dialogOptions`；PS 走交互路径时**忽略 name 参数**，
 *    预填的是文档名。
 *
 * ③ 2026-10-22 补了 dontDisplay **还是弹框**
 *    真正的解释在 2026-10-22 第三次修正：`dontDisplay` 的条款就是
 *    "出错或命令需要额外参数时**仍会显示 UI**"，而 defineBrush 需要"画笔名称"。
 *    ⇒ 改 `silent`。这也是本文件所有 `dontDisplay` 被清掉的原因。
 *
 * ④ 2026-10-22「圆度 1%」
 *    `pct()` 把 0~1 的比例又除了一次 100 ⇒ 1.0 变成 1%。所有 0~1 语义的参数
 *    （圆度/不透明度/流量/间距）全被砍成百分之一，笔刷看起来像"喷枪虚边细线"。
 *
 * ⑤ 2026-10-22「点堆叠细描却拿到别的笔刷」
 *    三个叠加原因：`pct`、`tipReady` 缓存、`pickExact` 用 startsWith 吃掉
 *    `BRS-impasto-detail.png`。三者都已拆掉。
 *
 * ⑥ 2026-10-22 第三次「还弹框 + 每次都让我重装 + 选中还是喷枪」
 *    ① 弹框 = dontDisplay 语义（见 ③）；
 *    ② "每次都让我重装" = 差集定名失败后抛错、`delete` 永远不执行 ⇒ 预设留在面板；
 *    ③ "首次选中是喷枪、第二次才对" = 首次差集为空提前抛错、根本没走到 select。
 *    ⇒ 现在的顺序（用户口径一致）：**定义 → 选中 → 下发 → 删除**，
 *      名字不猜不算，直接由笔尖文件名决定。
 * ========================================================================== */
