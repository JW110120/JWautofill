/**
 * 画笔「完整工具状态」的抓取 / 复灌 / 持久化。
 *
 * ── 为什么需要这个模块 ────────────────────────────────────────────────
 * PS 里要把一张 PNG 变成笔刷，唯一入口是 `defineBrush`，而它在 PS 27 上
 * **必弹「新建画笔」对话框**（`dialogOptions` 三档都挡不住，见 psBrush.ts 文件头）。
 * 弹框意味着：用户每次点笔都要按一次确定，且弹框期间整条命令链的时间线会错位。
 *
 * 但用户真机验证过一件事，它是本方案的全部依据：
 *
 *   「我的画笔工具不会因为删除而自动切成别的笔刷，还是停留在 BRS-xxx，
 *     尽管它的预设已经被我删掉了。」
 *
 * 也就是说：**采样笔尖的数据活在画笔工具的运行时状态里，不依赖画笔预设存在。**
 * 而这份运行时状态就是 `currentToolOptions` —— 一个普通描述符，可以 `get` 出来，
 * 也可以整份 `set` 回去（`setToolOpacity` 早就在这么干了：读整份 cto → 改两个值 →
 * set 到 `paintbrushTool`，用户已验证通过）。
 *
 * ⇒ 于是：**define 一次，把 cto 抓下来存盘；以后每次点击只做 `set cto`。**
 *    · 不调 defineBrush ⇒ 不弹框
 *    · 不建画笔预设 ⇒ 面板里零痕迹
 *    · 参数每次重新下发 ⇒ 改了 brush.json 立刻生效，不会被旧缓存盖住
 *
 * ⚠️ 缓存里 `sampledBrush.sampledData` 是一个 UUID 引用（指向 PS 内存里的笔尖数据），
 *    不是像素本体。跨会话是否仍有效**没有保证** ⇒ 每次复灌后必须回读校验，
 *    不通过就老实退回 define 流程（fallback 是安全的，只是会弹一次框）。
 */
import { action } from 'photoshop';
import { storage } from 'uxp';

const lfs = storage.localFileSystem;

/** 缓存目录（插件数据文件夹下）。与 presets/ 同级，不进插件包 */
const DIR = 'brushstate';

const APP_TARGET = [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }];

// ------------------------------------------------------------------ 读写工具状态

/**
 * 读当前工具的完整选项描述符。拿不到返回 null，不抛。
 *
 * ⚠️ 三条 target 形态都试（缺一条就可能整条链"读不到工具状态"）：
 *    ① `property.currentToolOptions + application`（现代，setToolOpacity 已验证可用）；
 *    ② `paintbrushTool` + `property`；
 *    ③ `get` 整个 `paintbrushTool` —— 和 writeToolOptions 的 target **对称**。
 *       前两条都拿不到 brush 时，这条最可能给出完整结构（读写用同一套引用最稳）。
 */
/**
 * 「读工具状态」用过且**成功**的形态下标（会话级记忆）。
 *
 * ⛔ 为什么要记：PS 会把**每一条失败的 batchPlay** 画成一条黄色通知
 *    「悦绘: 命令"获取"当前不可用」。三条形态里若有一条在本版本不可用，
 *    每次读都撞它一次 ⇒ 一次点击里读十几次，黄条能糊满一屏。
 *    记住成功的那条，之后每次只发一条命令。
 */
let readForm = -1;

export async function readToolOptions(): Promise<any | null> {
    const tries: any[] = [
        { _obj: 'get', _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET] },
        { _obj: 'get', _target: [{ _ref: 'paintbrushTool' }], property: 'currentToolOptions' },
        { _obj: 'get', _target: [{ _ref: 'paintbrushTool' }] }
    ];
    /**
     * ⛔⛔ 2026-10-22 真机铁证（`_last-run.json`）：PS 27 的 `currentToolOptions.brush`
     *    **有两种形态**，长得像但含义天差地别：
     *
     *      · `_obj: 'sampledBrush'`  —— 挂着**采样笔尖**（我们的毛刷），带 `name` + `sampledBrush.sampledData`
     *      · `_obj: 'computedBrush'` —— 一支**纯几何的计算笔刷**，只有直径/圆度/间距，**没有 name、没有 sampledData**
     *
     *    旧实现 `if (cto.brush) return cto` 一视同仁，于是"计算笔刷"也会被当成"读到了工具状态"，
     *    `currentBrushName()` 恒为 null ⇒ 缓存永远建不成、删除安全阀永远判不了、两个黄点永远亮。
     *    ⇒ 现在按**信息量**排序挑结果：带采样笔尖 > 带画笔名 > 只要像工具选项。
     */
    let withTip: any = null;
    let withName: any = null;
    /** 没有 `brush` 但看着像工具选项的兜底结果 */
    let loose: any = null;

    const idxs = readForm >= 0 ? [readForm] : tries.map((_, i) => i);

    for (const idx of idxs) {
        const desc = tries[idx];
        try {
            const res: any = await action.batchPlay([{ ...desc, _options: { dialogOptions: 'silent' } }], {
                synchronousExecution: true
            } as any);
            const first: any = Array.isArray(res) ? res[0] : res;
            if (!first || first._obj === 'error') continue;
            const cto = first.currentToolOptions ?? first;
            if (!cto || typeof cto !== 'object') continue;

            // 这条形态可用 ⇒ 会话内记住它，之后不再试别的（少一条命令 = 少一条潜在黄条）
            readForm = idx;

            if (!withTip && sampledId(cto)) {
                withTip = cto;
                continue;
            }
            if (!withName && typeof cto?.brush?.name === 'string' && cto.brush.name) {
                withName = cto;
                continue;
            }
            if (cto.brush) {
                if (!loose) loose = cto;
                continue;
            }
            // 读到了结构但没有 brush：留着当兜底。
            // ⛔ 不能直接丢 —— "读到了但字段不叫 brush" 和 "完全读不到" 是两种病，
            //    丢掉这一层，排障时就只剩一句"读不到工具状态"。
            if (!loose && (cto.opacity !== undefined || /Tool$/.test(String(cto._obj || '')))) loose = cto;
        } catch {
            /* 试下一条 */
        }
    }
    return withTip ?? withName ?? loose;
}

/**
 * 读工具状态的**原始**结果（不做 `brush` 过滤），只给排障用。
 *
 * 为什么要它：`capture` 失败时面板只能吐一句"读不到工具状态"，
 * 而真实原因可能是"读到了但字段不叫 brush"。把原始 JSON 落盘，
 * 才能在不开 PS 调试器的情况下看清 PS 到底回了什么。
 */
export async function readToolOptionsRaw(): Promise<any> {
    const tries: any[] = [
        { _obj: 'get', _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET] },
        { _obj: 'get', _target: [{ _ref: 'paintbrushTool' }], property: 'currentToolOptions' },
        { _obj: 'get', _target: [{ _ref: 'paintbrushTool' }] }
    ];
    const out: any[] = [];
    for (const desc of tries) {
        try {
            const res: any = await action.batchPlay([{ ...desc, _options: { dialogOptions: 'silent' } }], {
                synchronousExecution: true
            } as any);
            out.push(Array.isArray(res) ? res[0] : res);
        } catch (e: any) {
            out.push({ _threw: e?.message || String(e) });
        }
    }
    return out;
}

/**
 * 把一整份工具状态灌回画笔工具。
 *
 * ⚠️ `to` 用**展开的 cto**而不是 `{ currentToolOptions: cto }`：
 *    setToolOpacity 这条形态已被用户真机验证通过，不换写法。
 */
export async function writeToolOptions(cto: any): Promise<void> {
    const res: any = await action.batchPlay(
        [
            {
                _obj: 'set',
                _target: [{ _ref: 'paintbrushTool' }],
                to: { ...cto, _options: { dialogOptions: 'silent' } }
            }
        ] as any,
        { synchronousExecution: true } as any
    );
    const first: any = Array.isArray(res) ? res[0] : res;
    if (first && first._obj === 'error') {
        throw new Error(first.message || 'PS 拒绝了这份工具状态');
    }
}

/** 当前画笔预设名（`cto.brush.name`），拿不到返回 null */
export async function currentBrushName(cto?: any): Promise<string | null> {
    const t = cto ?? (await readToolOptions());
    const n = t?.brush?.name ?? t?.name;
    return typeof n === 'string' && n ? n : null;
}

/**
 * 当前笔尖的采样数据标识（UUID 字符串）。计算笔刷/普通圆笔没有这一项 ⇒ null。
 *
 * ⚠️ 兼容两种摆放：`brush.sampledBrush.sampledData`（工具状态里）
 *    和 `brush.sampledData`（`get brush` 直接返回时）。
 */
export function sampledId(cto: any): string | null {
    const b = cto?.brush ?? cto;
    const s = b?.sampledBrush?.sampledData ?? b?.sampledData;
    return typeof s === 'string' && s ? s : null;
}

/** 当前工具上挂的是不是**采样笔尖**（= 真毛刷像素），而不是几何计算出来的圆笔 */
export function hasSampledTip(cto: any): boolean {
    return !!sampledId(cto);
}

// ------------------------------------------------------------------ 持久化

async function stateFolder(): Promise<any> {
    const data = await lfs.getDataFolder();
    try {
        return await data.getEntry(DIR);
    } catch {
        return await data.createFolder(DIR);
    }
}

/**
 * 存一份工具状态。
 *
 * ⚠️ 只留 `brush` / `opacity` / `flow` 这几个我们真正需要的字段：
 *    整份 cto 里还有大量与工具无关的东西，存全量会让文件膨胀，
 *    而且把不相干的设置一起灌回去可能顺手改掉用户的其它工具选项。
 */
export async function saveState(id: string, cto: any): Promise<void> {
    const slim: any = {
        _obj: cto._obj,
        brush: cto.brush,
        opacity: cto.opacity,
        flow: cto.flow
    };
    // `_options` 会被 UXP 序列化进 JSON 但它不属于状态，存下来再灌回去可能触发弹框
    delete slim._options;
    if (slim.brush) delete slim.brush._options;

    const folder = await stateFolder();
    const file = await folder.createFile(`${id}.json`, { overwrite: true });
    await file.write(JSON.stringify(slim));
}

/**
 * 读一份工具状态。没有 / 坏了 / **没有采样笔尖**都返回 null，不抛。
 *
 * ⛔ 最后一条是 2026-10-22 加的硬条件：缓存里若没有 `sampledBrush.sampledData`，
 *    它描述的只是一支"计算笔刷"（纯几何圆笔）。把这种缓存灌回工具，
 *    用户看到的就是一支**软边喷枪** —— 宁可不认缓存、老实重装一次，
 *    也不能拿一份空壳把好笔尖换成喷枪。
 */
export async function loadState(id: string): Promise<any | null> {
    try {
        const folder = await stateFolder();
        const entry: any = await folder.getEntry(`${id}.json`);
        const raw = await entry.read();
        const obj = JSON.parse(raw);
        return obj && sampledId(obj) ? obj : null;
    } catch {
        return null;
    }
}

/** 删掉一份缓存（「重建」时用） */
export async function dropState(id: string): Promise<void> {
    try {
        const folder = await stateFolder();
        const entry: any = await folder.getEntry(`${id}.json`);
        await entry.delete();
    } catch {
        /* 不存在就算了 */
    }
}

/** 列出已有缓存的笔 id（诊断面板用） */
export async function listStates(): Promise<string[]> {
    try {
        const folder = await stateFolder();
        const entries = await folder.getEntries();
        return entries
            .map((e: any) => String(e.name || ''))
            .filter((n: string) => n.endsWith('.json'))
            .map((n: string) => n.replace(/\.json$/i, ''));
    } catch {
        return [];
    }
}

/**
 * 把一次点击的完整现场落盘（`brushstate/_last-run.json`），**只为排障**。
 *
 * 面板的状态条一次只能显示一行，而且用户没法把日志发过来。
 * 写文件后可以直接开文件看：每条命令的成败、原始报错、以及 PS 回给我们的
 * 工具状态原文（含真实字段名）——这是"读不到工具状态"这类问题唯一的破案依据。
 */
export async function dumpRun(obj: any): Promise<void> {
    try {
        const folder = await stateFolder();
        const file = await folder.createFile('_last-run.json', { overwrite: true });
        // 大对象可能带循环引用 / undefined，用 JSON.stringify 的 replacer 兜一层
        const seen = new WeakSet();
        await file.write(
            JSON.stringify(
                obj,
                (_k, v) => {
                    if (typeof v === 'object' && v !== null) {
                        if (seen.has(v)) return '[circular]';
                        seen.add(v);
                    }
                    return v === undefined ? null : v;
                },
                2
            )
        );
    } catch {
        /* 诊断写不进去不影响主链 */
    }
}

// ------------------------------------------------------------------ 复灌校验

export type RestoreVerdict = 'ok' | 'no-name' | 'name-mismatch' | 'tip-lost';

/**
 * 复灌一份工具状态并校验它**真的落到了工具上**。
 *
 * 校验分三层（从弱到强）：
 *   ① `set` 本身不抛错；
 *   ② 回读 `brush.name` 与期望名一致 —— 证明工具确实切到了这支笔；
 *   ③ 回读 `sampledBrush.sampledData` 与缓存里一致 —— 证明**笔尖数据**还在。
 *      跨会话时 UUID 可能失效并被子清空，只查名字是查不出来的
 *      （名字对、笔尖却是空心圆 ⇒ 正是「货不对版」）。
 */
export async function restoreState(
    cto: any,
    wantName: string[],
    onLog?: (m: string) => void
): Promise<{ verdict: RestoreVerdict; detail: string }> {
    const wantTip = sampledId(cto);

    await writeToolOptions(cto);

    const after = await readToolOptions();
    const gotTip = sampledId(after);
    const gotName = await currentBrushName(after ?? undefined);
    const norm = (s: string) => s.replace(/\.png$/i, '').toLowerCase();
    const nameOk = !!gotName && wantName.some((w) => norm(w) === norm(gotName));

    // ⛔ 笔尖句柄是**强判据**，名字是弱判据。
    //    PS 27 的 `currentToolOptions.brush` 可能被降级成 `computedBrush`
    //    （没有 name 也没有 sampledData），拿"读不到名字"当失败会把
    //    明明恢复成功的笔尖判死，然后 dropState ⇒ 下次又弹框。
    if (wantTip) {
        if (gotTip !== wantTip) {
            onLog?.(`笔尖数据未随状态恢复（${wantTip.slice(0, 8)}… → ${gotTip ?? '空'}）`);
            return { verdict: 'tip-lost', detail: '状态回了，但采样笔尖丢了' };
        }
        if (!gotName) return { verdict: 'ok', detail: '笔尖已恢复（名字读不到）' };
        if (!nameOk) return { verdict: 'name-mismatch', detail: `工具上是「${gotName}」，不是「${wantName[0]}」` };
        return { verdict: 'ok', detail: `「${gotName}」` };
    }

    if (!gotName) return { verdict: 'no-name', detail: '灌回去了，但读不到当前画笔名' };
    if (!nameOk) return { verdict: 'name-mismatch', detail: `工具上是「${gotName}」，不是「${wantName[0]}」` };
    return { verdict: 'ok', detail: `「${gotName}」` };
}
