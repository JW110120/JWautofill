/**
 * 特制笔刷 ↔ Photoshop 的桥。两件事：
 *   1. ensureTip —— 把 brushes/<id>/BRS-<id>.png 变成 PS 画笔面板里的一个笔尖预设（按需单支）；
 *   2. applyBrush —— 选中该笔尖 + 把 brush.json 的参数下发下去。
 *
 * ⚠️ 为什么不用 .tpl 工具预设（被逆向样本的做法）：二进制黑盒、无法评审、
 *    跨 PS 大版本极易碎。这里走的是**公开脚本接口**：defineBrush + set brush。
 *
 * ⚠️ 参数键名的真相只有真机知道。PS 的画笔描述符有大版本差异，所以：
 *    · 每个键名都有 2 个候选（现代长键 / 4 字符 charID），逐个试，成功即停；
 *    · 每一步独立 try/catch，**一步失败不影响其它步**（绝不让整包 set 一起死）。
 *
 * ⚠️⛔ 2026-10-20 二次真机修正（三条同时命中，见文件末「三次踩坑记录」）：
 *    ① defineBrush **必须**带 `_options:{dialogOptions:'dontDisplay'}`，否则 PS 弹
 *       「画笔名称」框，等于每装一支笔要用户点一次确定；
 *    ② 弹框里预填的名字是**文档名**（当时文件叫 tip.png），不是我们传的 name ——
 *       所以笔尖文件名改成 `BRS-<id>.png`，让文档名天然唯一且可辨识；
 *    ③ 预设名的真相**不靠猜**：定义前后各读一次画笔清单，差集里新增的那个就是
 *       真实名字，记进 nameMap 供选中使用（PS 若把名字改成文档名，也能对上）。
 */
import { action, app } from 'photoshop';
import { storage } from 'uxp';
import { runAsModal } from '../utils/psAccess';
import type { ApplyStep, BrushDef, BrushParams } from './types';

const lfs = storage.localFileSystem;

/** PS 画笔预设名前缀：纯 ASCII，避免早期版本对预设名的编码处理差异 */
export const TIP_PREFIX = 'BRS-';

/**
 * 本次 PS 会话里**已确认存在**的笔尖 id。
 *
 * 2026-10-21 改：原来是全局 `tipsInstalled: boolean`（一次装 6 支、全部就绪才置位）。
 * 用户真机反馈「点一支笔就往列表里塞 6 支」，改成**按需单支**：点哪支装哪支，
 * 别人的不碰；配合 `pruneOtherTips()` 把历史遗留的 BRS-* 收干净，
 * 画笔面板里最多只有当前这一支。
 */
const tipReady: Record<string, boolean> = {};

/**
 * id → 画笔面板里的**真实**预设名。
 * ⛔ 不要用 `TIP_PREFIX + id` 直接去选：PS 在 defineBrush 时可能把预设名定成
 *    文档名（带 .png 后缀）。这里存的是实测结果，selectTip 优先用它。
 */
const tipNameMap: Record<string, string> = {};

export function resetTipsFlag() {
    for (const k of Object.keys(tipReady)) delete tipReady[k];
}

function px(v: number) {
    return { _unit: 'pixelsUnit', _value: Math.max(1, Math.round(v)) };
}
function pct(v: number) {
    return { _unit: 'percentUnit', _value: Math.max(0, Math.min(100, Math.round(v * 100) / 100)) };
}
function deg(v: number) {
    return { _unit: 'angleUnit', _value: v };
}

const DOC_TARGET = [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }];

/** batchPlay 的薄封装：PS 用 `_obj:"error"` 表达失败，这里统一抛出去 */
async function bp(descriptor: any | any[], commandName: string) {
    const list = Array.isArray(descriptor) ? descriptor : [descriptor];
    const res = await action.batchPlay(list as any, {} as any);
    const first: any = Array.isArray(res) ? res[0] : res;
    if (first && first._obj === 'error') {
        throw new Error(`${commandName}: ${first.message || first.result || 'PS 拒绝了该动作'}（${first.result || ''}）`);
    }
    return first;
}

/** 跑一步，把成败写进报告 */
async function step(
    name: string,
    fn: () => Promise<any>,
    onStep?: (s: ApplyStep) => void
): Promise<ApplyStep> {
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

// ------------------------------------------------------------------ 画笔清单

/**
 * 读当前 PS 里的**画笔预设名**。
 *
 * 两条路，按可靠性排序（照搬 hotkey/HotkeyBridge.ts::enumerateBrushesOnce）：
 *   ① `app.brushes.get()` —— DOM 集合，PS 23+ 提供，名字最准；
 *   ② batchPlay 读 `application.presetManager` 第 0 组（老版本兜底）。
 * ⚠️ 本函数**必须在模态作用域内调用**（DOM 集合 get 是一次宿主往返）。
 * 失败一律返回空数组，不阻断主链。
 */
async function listBrushNames(): Promise<string[]> {
    // ① DOM 集合
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
        /* 落 ② */
    }

    // ② presetManager
    try {
        const res: any = await action.batchPlay(
            [
                {
                    _obj: 'get',
                    _target: [
                        { _ref: 'property', _property: 'presetManager' },
                        { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }
                    ],
                    _options: { dialogOptions: 'dontDisplay' }
                }
            ] as any,
            { synchronousExecution: true } as any
        );
        const appDesc: any = Array.isArray(res) ? res[0] : res;
        if (!appDesc || appDesc._obj === 'error') return [];

        let pm: any = appDesc.presetManager;
        if (!pm && (appDesc._obj === 'presetManager' || Array.isArray(appDesc.preset) || Array.isArray(appDesc.brushPreset))) {
            pm = appDesc;
        }
        if (!pm) return [];

        const groups: any[] = [];
        if (Array.isArray(pm)) groups.push(...pm);
        else if (Array.isArray(pm.preset)) groups.push(...pm.preset);
        else if (Array.isArray(pm.brushPreset)) groups.push(...pm.brushPreset);

        const group = groups[0];
        if (!group) return [];
        const rawNames: any = group.name ?? group.names;
        if (!rawNames) return [];
        const arr: any[] = Array.isArray(rawNames) ? rawNames : [rawNames];
        return arr
            .map((n: any) => (typeof n === 'string' ? n : (n?.name ?? n?._value ?? '')))
            .filter((x: any): x is string => typeof x === 'string' && !!x);
    } catch {
        return [];
    }
}

/** 按 id 在清单里找真实预设名（忽略大小写前缀匹配，兼容 PS 加后缀） */
function pickName(names: string[], id: string): string | null {
    const want = TIP_PREFIX + id;
    const exact = names.find((n) => n === want);
    if (exact) return exact;
    const lower = want.toLowerCase();
    return names.find((n) => n.toLowerCase().startsWith(lower)) ?? null;
}

/**
 * 检测上一版 bug 遗留的垃圾笔刷（预设名被误定成文档名 `tip.png`）。
 *
 * ⛔⛔ **只检测、不自动删除**（2026-10-20 真机改口）。
 *    原版用 `{_obj:'delete', _target:[{_ref:'brushPreset',...}]}` 去批量清，
 *    PS 直接弹宿主错误框「删除不可用」—— 那条描述符根本不合法。
 *    实测可用的删除命令只能删**当前选中的画笔**：
 *      `{_obj:'delete', _target:[{_ref:'brush', _enum:'ordinal', _value:'targetEnum'}]}`
 *    也就是说「自动清」必须先按名选中 tip.png 再删；一旦选中静默失败，
 *    真正被删掉的就是用户当前正在用的笔刷。这种风险不该由一次开面板承担。
 *    ⇒ 改为：检测到就明确告知，让用户在画笔面板里框选删掉（一次性，之后再不会产生）。
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
 * 定义单个笔尖。只做「开文档 → defineBrush → 关文档」，名字对不对由调用方用差集判定。
 *
 * ⛔ 不要在这里加「全选」：defineBrush 无选区时取整层内容，与全选结果一致；
 *     而 `selectAll` 这个 stringID 会直接换来 -25920（见文末踩坑记录 ①）。
 * ⛔ **必须**带 `_options:{dialogOptions:'dontDisplay'}`，否则弹「画笔名称」框。
 * ⚠️ 关闭必须按 **_id** 定位，绝不能用 targetEnum —— 一旦定位失手就会关掉
 *     用户正在画的稿子（这是本文件里唯一能造成真实损失的写法）。
 */
async function defineOneTip(brush: BrushDef): Promise<void> {
    const folder = await lfs.getPluginFolder();
    const entry = await folder.getEntry(`brushes/${brush.id}/${brush.tip}`);
    const name = TIP_PREFIX + brush.id;

    const doc: any = await app.open(entry as any);
    try {
        try {
            if (doc && (app as any).activeDocument?.id !== doc.id) {
                (app as any).activeDocument = doc;
            }
        } catch {
            /* 设不了活动文档不致命：targetEnum 通常已经指向新文档 */
        }

        // 只留一条写法：多写法会各弹一次对话框（上一版就是三种写法 × 6 支 = 一堆垃圾笔刷）。
        // 这条是 Alchemist 录制的标准形态：命令 + 显式活动文档 target + 抑制对话框。
        await bp(
            {
                _obj: 'defineBrush',
                name,
                _target: DOC_TARGET,
                _options: { dialogOptions: 'dontDisplay' }
            } as any,
            '定义笔尖'
        );
    } finally {
        await closeQuietly(doc);
    }
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

export interface InstallReport {
    /** 本次真正定义成功、且在清单里确认存在的笔尖 id */
    installed: string[];
    /** 已存在、跳过的笔尖 id */
    skipped: string[];
    failed: { id: string; name: string; msg: string }[];
    /** 检测到的误建笔刷个数（只报告、不自动删，见 detectJunkTips 注释） */
    junk: number;
}

/**
 * 清理历史遗留的 BRS-* 笔尖（保留当前要用的那一支）。
 *
 * ⚠️ PS 没有「按名删除预设」的命令，只能删**当前选中的画笔**：
 *      `{_obj:'delete', _target:[{_ref:'brush', _enum:'ordinal', _value:'targetEnum'}]}`
 *    所以流程必然是「先 select 按名选中 → 再 delete 当前」。
 * ⛔ 安全边界：进入本函数时先把当前画笔切到一个 BRS-* 上。
 *    这样即使某次 select 静默失败、delete 删错了对象，被删的也只会是**我们自己造的**
 *    笔尖，不会伤到用户自己的画笔（这是唯一不可接受的后果）。
 *    第一次 select 就抛错 ⇒ 直接放弃整轮清理，宁可留几支也不冒险。
 */
async function pruneOtherTips(names: string[], keepId: string, onLog?: (m: string) => void): Promise<number> {
    const prefix = TIP_PREFIX.toLowerCase();
    const keep = (TIP_PREFIX + keepId).toLowerCase();
    const others = names.filter((n) => {
        const l = n.toLowerCase();
        return l.startsWith(prefix) && !l.startsWith(keep);
    });
    if (!others.length) return 0;

    // 安全前置：把当前画笔挪到自家笔尖上
    try {
        await bp({ _obj: 'select', _target: [{ _ref: 'paintbrushTool' }] } as any, '切画笔工具');
    } catch {
        /* 已经是画笔工具 */
    }
    try {
        await bp({ _obj: 'select', _target: [{ _ref: 'brush', _name: others[0] }] } as any, '预选笔尖');
    } catch {
        onLog?.(`⚠️ 无法选中旧笔尖，跳过清理（画笔面板里可能残留 ${others.length} 支 BRS-*）`);
        return 0;
    }

    let removed = 0;
    for (const name of others) {
        try {
            await bp({ _obj: 'select', _target: [{ _ref: 'brush', _name: name }] } as any, '选中旧笔尖');
            await bp(
                { _obj: 'delete', _target: [{ _ref: 'brush', _enum: 'ordinal', _value: 'targetEnum' }] } as any,
                '删除旧笔尖'
            );
            removed++;
        } catch {
            onLog?.(`⚠️ 旧笔尖「${name}」删不掉，可在画笔面板手动清理`);
            break;
        }
    }
    if (removed) onLog?.(`已清理 ${removed} 支旧笔尖`);
    return removed;
}

/**
 * 确保**指定这一支**笔尖在 PS 里（按需安装，不再整批）。
 *
 * 2026-10-21 用户口径：点哪支装哪支，别人的不要碰；顺手把历史遗留的 BRS-* 收掉，
 * 让画笔面板里最多只剩当前这一支 —— 「看起来像没装过」。
 *
 * ⚠️ 关于「装完立刻删掉自己」：PS 只能删**当前选中**的画笔，删掉当前这支之后
 *    画笔会回退到别的预设，用户就没法接着画了。所以保留当前这一支，
 *    只清其它遗留（detectJunkTips 负责把误建的 tip.png 数出来提示用户）。
 */
export async function ensureTip(brush: BrushDef, onLog?: (msg: string) => void): Promise<InstallReport> {
    const report: InstallReport = { installed: [], skipped: [], failed: [], junk: 0 };
    if (tipReady[brush.id]) {
        report.skipped.push(brush.id);
        return report;
    }

    await runAsModal(
        async () => {
            // 历史遗留的误建 tip.png：只报不删（见 detectJunkTips 注释）
            report.junk = await detectJunkTips(onLog);

            const names = await listBrushNames();
            if (!names.length) onLog?.('⚠️ 读不到画笔清单，将直接尝试定义');

            const hit = pickName(names, brush.id);
            if (hit) {
                tipNameMap[brush.id] = hit;
                report.skipped.push(brush.id);
                // 已经在了：仍要把别的遗留收掉，否则面板里会一支支攒起来
                await pruneOtherTips(names, brush.id, onLog);
                return;
            }

            // 先清遗留再定义：差集判断才不会被同名/旧项干扰
            await pruneOtherTips(names, brush.id, onLog);

            const prev = new Set(await listBrushNames());
            onLog?.(`安装笔尖 ${brush.name} …`);
            try {
                await defineOneTip(brush);
            } catch (e: any) {
                report.failed.push({ id: brush.id, name: brush.name, msg: e?.message || String(e) });
                return;
            }

            // 预设名的真相：定义前后读两次清单，差集里新增的那个就是它。
            // ⛔ 不信 name 参数、也不信「命令没报错」—— PS 的 defineBrush 会
            //    静默成功但把名字定成文档名，上一版就是在这里给用户假绿勾的。
            const after = await listBrushNames();
            const added = after.filter((n) => !prev.has(n));
            const actual = pickName(added, brush.id) ?? (added.length === 1 ? added[0] : null);
            if (!actual) {
                report.failed.push({
                    id: brush.id,
                    name: brush.name,
                    msg: added.length
                        ? `定义后新增了「${added.join('、')}」，但匹配不上 ${TIP_PREFIX}${brush.id}`
                        : '定义命令返回成功，但画笔清单里没有新增笔尖'
                });
                return;
            }

            tipNameMap[brush.id] = actual;
            if (actual !== TIP_PREFIX + brush.id) {
                onLog?.(`⚠️ PS 把预设名定为「${actual}」，已按真实名记录`);
            }
            report.installed.push(brush.id);
        },
        { commandName: '安装笔尖' }
    );

    if (!report.failed.length) tipReady[brush.id] = true;
    return report;
}

// ------------------------------------------------------------------ 选中笔尖

/** 解析某支笔的真实预设名（缓存优先，失效则重新扫清单；须在模态作用域内调用） */
async function resolveTipName(id: string): Promise<string | null> {
    const cached = tipNameMap[id];
    const names = await listBrushNames();
    if (cached && names.includes(cached)) return cached;
    const hit = pickName(names, id);
    if (hit) tipNameMap[id] = hit;
    return hit;
}

/**
 * 选中笔尖预设。写法来自项目已验证结论（hotkey/HotkeyBridge.ts）：
 *   · 引用里必须用 `_name` 携带名字；
 *   · **不要**加 `_options:{dialogOptions:'dontDisplay'}`（会弹宿主错误框且不进 catch）。
 * 另外先切一次画笔工具：非画笔工具下选笔刷预设，有的版本只改预设不改当前工具，
 * 用户会觉得"点了没反应"。
 */
async function selectTip(name: string) {
    try {
        await bp({ _obj: 'select', _target: [{ _ref: 'paintbrushTool' }] } as any, '切画笔工具');
    } catch {
        /* 已经是画笔工具时可能报错，忽略 */
    }
    await bp({ _obj: 'select', _target: [{ _ref: 'brush', _name: name }] } as any, '选中笔尖');
}

/** 直连失败时回退模态作用域（部分 PS 版本要求批量动作在模态内执行） */
async function selectTipWithFallback(brush: BrushDef) {
    const name = await runAsModal(() => resolveTipName(brush.id), { commandName: '解析笔尖名' });
    if (!name) throw new Error(`画笔清单里找不到 ${TIP_PREFIX}${brush.id}`);
    try {
        await selectTip(name);
    } catch {
        await runAsModal(() => selectTip(name), { commandName: '选中笔尖' });
    }
}

// ------------------------------------------------------------------ 参数下发

/**
 * 几何参数：直径 / 间距 / 角度 / 圆度 / 流量 / 不透明度。
 * 返回第一个"PS 接受"的写法标签，便于日志定位。
 */
async function setBrushGeometry(p: BrushParams): Promise<string> {
    const modern = {
        _obj: 'brush',
        diameter: px(p.diameter.base),
        spacing: pct(p.spacing),
        angle: deg(p.angle),
        roundness: pct(p.roundness),
        flow: pct(p.flow.base),
        opacity: pct(p.opacity.base),
    };
    const legacy = {
        _obj: 'brush',
        Dmtr: px(p.diameter.base),
        Spcn: pct(p.spacing),
        Angl: deg(p.angle),
        Rndn: pct(p.roundness),
        'Flw ': pct(p.flow.base),
        Opct: pct(p.opacity.base),
    };
    const target = [{ _ref: 'brush', _enum: 'ordinal', _value: 'targetEnum' }];

    try {
        await bp({ _obj: 'set', _target: target, to: modern } as any, '下发几何参数');
        return '长键';
    } catch (e: any) {
        try {
            await bp({ _obj: 'set', _target: target, to: legacy } as any, '下发几何参数');
            return 'charID';
        } catch (e2: any) {
            throw new Error(`两种写法都被拒：${e?.message} / ${e2?.message}`);
        }
    }
}

/**
 * 读「当前工具选项」描述符（best-effort）。拿不到返回 null，不抛。
 * 用途：`set` 之后回读，确认流量/不透明度**真的**落到了工具上。
 * 只信"命令没报错"是不够的 —— PS 对不认识的键是静默忽略。
 */
async function readToolOptions(): Promise<any | null> {
    try {
        const res: any = await action.batchPlay(
            [
                {
                    _obj: 'get',
                    _target: [{ _ref: 'property', _property: 'currentToolOptions' }, { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }],
                    _options: { dialogOptions: 'dontDisplay' }
                }
            ] as any,
            { synchronousExecution: true } as any
        );
        const first: any = Array.isArray(res) ? res[0] : res;
        if (!first || first._obj === 'error') return null;
        return first.currentToolOptions ?? first;
    } catch {
        return null;
    }
}

/**
 * 工具级不透明度/流量（画笔选项栏那两格）。
 *
 * ⛔⛔ 这是 P3「厚涂感」的第一前提，不是可选装饰。
 *    PS 的语义：**流量 = 单个笔尖印章的不透明度**，**不透明度 = 一整笔的上限**。
 *    流量 30% 时，每个印章只有三成实心，印章重叠处才逐渐累积到 100%
 *    ⇒ 正是用户截图里「每个图案半透明、重合处才变深」的观感。
 *    Krita 的对应参数是 100%，所以它的印章颗颗实心、互相覆盖，形成厚涂/堆叠感。
 *    ⇒ 要让 PS 逼近 Krita，必须把 flow 打到 100%。
 *
 * 写法按怀疑度排序，成功即停；成功后**回读校验**（读不到就跳过校验，不假失败）。
 */
async function setToolOpacity(p: BrushParams): Promise<string> {
    const op = pct(p.opacity.base);
    const fl = pct(p.flow.base);
    const appTarget = [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }];

    const candidates: { label: string; desc: any }[] = [
        {
            label: 'currentToolOptions',
            desc: {
                _obj: 'set',
                _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...appTarget],
                to: { _obj: 'currentToolOptions', opacity: op, flow: fl }
            }
        },
        {
            label: 'tool(targetEnum)',
            desc: { _obj: 'set', _target: [{ _ref: 'tool', _enum: 'ordinal', _value: 'targetEnum' }], to: { _obj: 'tool', opacity: op, flow: fl } }
        },
        {
            label: 'currentToolOptions(分开)',
            desc: [
                {
                    _obj: 'set',
                    _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...appTarget],
                    to: { _obj: 'currentToolOptions', flow: fl }
                },
                {
                    _obj: 'set',
                    _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...appTarget],
                    to: { _obj: 'currentToolOptions', opacity: op }
                }
            ]
        }
    ];

    const errors: string[] = [];
    for (const c of candidates) {
        try {
            await bp(c.desc, '下发工具不透明度');
        } catch (e: any) {
            errors.push(`${c.label}: ${e?.message || e}`.slice(0, 120));
            continue;
        }

        // 回读校验：命令没报错 ≠ 值真的改了（PS 会静默忽略不认识的键）
        const opts = await readToolOptions();
        const gotFlow: any = opts?.flow?._value;
        const wantFlow = Math.round(p.flow.base * 100);
        if (typeof gotFlow === 'number' && Math.abs(gotFlow - wantFlow) > 2) {
            errors.push(`${c.label}: 回读流量 ${gotFlow}% ≠ ${wantFlow}%`);
            continue;
        }
        return typeof gotFlow === 'number' ? `${c.label}｜回读流量 ${gotFlow}%` : c.label;
    }
    throw new Error(errors.join(' / '));
}

// ------------------------------------------------------------------ 主入口

export interface ApplyResult {
    steps: ApplyStep[];
    ok: boolean;
    /** 检测到的误建笔刷数（>0 时面板要提示用户去画笔面板手删） */
    junk: number;
}

/**
 * 应用一支笔。流程：
 *   补齐笔尖 → 选中笔尖 → 几何参数 → 工具不透明度（尽力）→ 汇总报告
 * 首次调用时会自动补装笔尖（自愈：不需要用户先点"初始化"）。
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
    const push = (s: ApplyStep) => {
        steps.push(s);
        onStep?.(s);
    };

    if (!tipReady[brush.id]) {
        // 按需单支：点哪支装哪支，不去碰其它笔刷
        const report = await ensureTip(brush, onLog);
        junk = report.junk;
        report.failed.forEach((f) => push({ name: `安装笔尖 ${f.name}`, ok: false, msg: f.msg }));
    }

    let s1 = await step(`选中笔尖 ${brush.id}`, () => selectTipWithFallback(brush), push);

    if (!s1.ok) {
        // 自愈：可能上一支 PS 会话留下的笔尖没了 / 被用户删了 —— 重装一次再试
        onLog?.('笔尖缺失，重新安装…');
        delete tipReady[brush.id];
        const report = await ensureTip(brush, onLog);
        junk = report.junk || junk;
        report.failed.forEach((f) => push({ name: `安装笔尖 ${f.name}`, ok: false, msg: f.msg }));
        s1 = await step(`重试选中 ${brush.id}`, () => selectTipWithFallback(brush), push);
        if (!s1.ok) {
            onLog?.('选中笔尖失败：画笔面板里没有对应笔尖');
            return { steps, ok: false, junk };
        }
    }

    await step('下发几何参数', async () => {
        // ⛔⛔ 必须进模态作用域：`set` 会改 PS 状态，裸调用一律被拒
        //    「Event: set may modify the state of Photoshop. Such events are only
        //     allowed from inside a modal scope.」（2026-10-20 真机）
        const mode = await runAsModal(() => setBrushGeometry(brush.params), { commandName: '应用画笔参数' });
        onLog?.(`几何参数已下发（${mode} 写法）`);
    }, push);

    // 这一步失败只标黄：`set brush` 已经把透明度/流量写进画笔预设，选项栏那两格属于
    // 工具级冗余（键名待真机校准）。不让它把「笔刷已可用」说成「未完全生效」。
    await step(
        '下发工具不透明度',
        () => runAsModal(() => setToolOpacity(brush.params), { commandName: '应用工具参数' }).then(() => undefined),
        (s) => push(s.ok ? s : { ...s, warn: true })
    );

    return { steps, ok: steps.every((s) => s.ok || s.name === '下发工具不透明度'), junk };
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
 *      ⇒ 改成优先读 `application.currentToolOptions`（工具选项描述符里含
 *        opacity / flow / 画笔设置），`brush` 那条降为兜底；
 *   ② 原实现直接 `JSON.stringify(res)`，**把 `_obj:'error'` 当成功回给面板**，
 *      于是面板显示"已读取"、框里却是一段错误 JSON ⇒ 现在统一走 `bp` 抛错。
 */
export async function readCurrentBrush(): Promise<string> {
    const appTarget = [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }];
    const candidates: { label: string; target: any[] }[] = [
        { label: 'currentToolOptions', target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...appTarget] },
        { label: 'brush(targetEnum)', target: [{ _ref: 'brush', _enum: 'ordinal', _value: 'targetEnum' }] },
        { label: 'application.brush', target: [{ _ref: 'property', _property: 'brush' }, ...appTarget] }
    ];

    return await runAsModal(
        async () => {
            const errors: string[] = [];
            for (const c of candidates) {
                try {
                    const res: any = await action.batchPlay(
                        [{ _obj: 'get', _target: c.target, _options: { dialogOptions: 'dontDisplay' } }] as any,
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
 * 三次踩坑记录（真机，2026-10-20）
 * ----------------------------------------------------------------------------
 * ① -25920「命令"<未知的>"当前不可用」
 *    `_obj:'selectAll'` 不是合法命令名。全选的正确写法是
 *    `set` + `channel.selection` → `allEnum`（AdjustmentPanel.tsx::selectAllDocument），
 *    而 defineBrush 本身不需要选区 ⇒ 这一步整个删掉。
 *
 * ② 每点一次笔刷弹一个「画笔名称」框，默认名 tip.png
 *    缺 `_options:{dialogOptions:'dontDisplay'}`。PS 走交互路径时**忽略 name 参数**，
 *    预填的是文档名。补上 dontDisplay 后不再弹框。
 *
 * ③ 弹框确认后得到一堆 `tip.png`，且「清单里查不到该笔尖」
 *    两层原因：名字被定成文档名（tip.png ×N，无法按 BRS-* 匹配）；旧版查重读不到
 *    清单就每次重装。修法：笔尖文件改名 `BRS-<id>.png`（文档名天然唯一）+
 *    清单优先走 `app.brushes` + 用「定义前后差集」反射真实预设名。
 * ⛔ 教训：`defineBrush` 会「返回成功但名字不对」，所以**永远不要只信返回值**，
 *    必须以清单新增项为准 —— 这也是 report 里要区分 installed / failed 的原因。
 * ========================================================================== */
