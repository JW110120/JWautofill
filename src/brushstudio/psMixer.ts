/**
 * 混合器画笔（Mixer Brush）探针 —— **只为回答 E1：储层能否脚本化。**
 *
 * ── 要回答什么 ────────────────────────────────────────────────────────
 * 用户实测：混合器画笔在「400×400 方形笔刷 + 400×400 图案 + 画布正中吸一下」之后，
 * 笔尖形状变成图案的形状，一笔能画出多个亮度 —— 这是复现 Krita 印章笔
 * （`前景色 × 笔尖R × alpha`）唯一可行的路，因为 PS 里只有混合器能一笔多亮度。
 *
 * 但有个致命副作用（用户原话）：
 *
 *   「当用户主动修改前景色，我们之前吸的图案就会立刻改为前景色。」
 *
 * ⇒ 用户每换一次颜色，储层就毁了。要"实时跟随前景色"，就必须能**重新装一次储层**。
 *   这一步能不能脚本化，就是这个文件存在的全部理由。
 *
 * ── 为什么先只读、不写 ────────────────────────────────────────────────
 * ⛔ 已立的铁律：**PS 把每一条失败的 batchPlay 都画成一条黄色通知**。
 *    在不知道字段名的情况下盲试写入，一次点击能刷十几条黄条（12:05 的教训）。
 *    所以第一步只做 `get`：**读一次，看清楚储层到底以什么形态存在**，再决定怎么写。
 *
 * ── 判读方法（三种结局，对应三条完全不同的技术路线）────────────────────
 *   ① `currentToolOptions` 里出现 `reservoir` / `load` / 图案位图字段
 *      ⇒ 储层是描述符的一部分 ⇒ 能读就能 `set`，方案最干净，零手工步骤。
 *   ② 出现一个"引用"（UUID / 文件路径 / `sampledBrush.sampledData` 那样的句柄）
 *      ⇒ 储层本体在 PS 内存，但**句柄可存盘复用** ⇒ 初始化手动吸一次，
 *        之后靠回灌句柄恢复（和 `brushstate/` 那套缓存一模一样的套路）。
 *   ③ 只有 wet / load / mix / flow / sampleAllLayers 这些**参数**，没有任何图案数据
 *      ⇒ 储层是纯位图、完全不进描述符 ⇒ 只能走"模拟采样"（E3）。
 *
 * ── 用法（不需要装任何 Adobe 插件）────────────────────────────────────
 * 探针本身只发 2~4 条只读命令。用户在 PS 里切到**混合器画笔**、把图案吸好之后
 * 点面板上的入口，结果落盘到 `brushstate/_mixer.json`，随后可直接读文件判读。
 */
import { action, app, imaging } from 'photoshop';
import { storage } from 'uxp';
import { runAsModal } from '../utils/psAccess';
import { sendHostMessage, waitHostMessage } from '../lasso/SmoothBridge';
import { buildReservoirPattern, type PatternBuf } from './reliefPattern';

const lfs = storage.localFileSystem;
const DIR = 'brushstate';
const FILE = '_mixer.json';

const APP_TARGET = [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }];

export interface ProbeTry {
    label: string;
    ok: boolean;
    err?: string;
    res?: any;
}

export interface MixerProbe {
    at: string;
    /**
     * PS 自己在描述符里报的类名。
     * ⛔ 别指望它：`get currentTool` 在 PS 27 上报 -25920（详见 `looksLikeMixer` 注释），
     *    这里通常是 null。判定工具身份**一律用指纹字段**，不用这个。
     */
    toolName: string | null;
    /** `currentToolOptions` 全文（含 reservoir* 那一族） */
    toolOptions: any;
    /** cto 顶层字段名 —— 判读第一眼就看这个 */
    fields: string[];
    /** cto.brush 的字段名（如果有） */
    brushFields: string[];
    /** 储层字段原样（`reservoir*` 一族） */
    reservoir: { key: string; value: any }[];
    /**
     * 储层体检摘要 —— **判读先看这段**：
     * `cols/rows`（位图尺寸，实测 43×44）、`channelNumber`（4=RGBA）、
     * `state/imageMode`（PS 状态码，改完要回读）、`channelsShape`（像素以什么形态存在）
     */
    reservoirSummary: any;
    /**
     * 「储层像素能不能单独取到」的探测结果。
     * `cto` 里 `reservoirChannels` 实测是空对象 ⇒ 这里记录单独 `get` 是否给数据。
     * 全 empty 就意味着**像素不可脚本读写**，换色只能走"重新采样"。
     */
    pixelProbe: Record<string, any>;
    /** 像素是否真的读到了（决定走"回灌"还是"模拟采样"） */
    pixelsReadable: boolean;
    /** 每条探测的原始成败，读不出东西时靠它排障 */
    tried: ProbeTry[];
    /** 一句话结论（三种结局之一） */
    verdict: string;
}

/**
 * 储层的键名。2026-10-22 14:40 真机探针已确认**实际存在的就是 `reservoir*` 这一族**：
 *
 *   reservoirState / reservoirImageMode / reservoirCols / reservoirRows /
 *   reservoirChannelNumber / reservoirChannels / reservoirSampleData
 *
 * ⛔ 别再往里加 `texture` / `pattern` / `image` / `data` 这类宽词 —— 它们会把
 *    画笔纹理（`texture: pattern`）也捞进来，把"储层在不在"误判成"在"。
 *    实测的 43×44 × 4 通道就是储层本体（PS 内部对储层做了降采样）。
 */
const RESERVOIR_PREFIX = 'reservoir';
/** 万一别的版本换了叫法，这两个是同义候选 */
const RESERVOIR_ALIAS = ['pickup', 'well'];

function isReservoirKey(k: string): boolean {
    const low = k.toLowerCase();
    return low.startsWith(RESERVOIR_PREFIX) || RESERVOIR_ALIAS.some((a) => low === a);
}

/**
 * 混合器的**指纹字段**。普通画笔的 cto 里没有 `wetness` / `dryness` / `reservoir*`。
 *
 * ⛔⛔ 为什么不用 `get currentTool` 判断"人站在哪个工具上"：
 *    PS 27 上那条命令直接报 -25920（`_mixer.json` 的 `tried[0]` 就是它），
 *    于是 `toolName` 恒为 null，判定把**正确的结果**误报成"当前是「未知」"。
 *    改用指纹：零额外命令、零黄条、且比读工具名更本质。
 */
const MIXER_FINGERPRINT = ['wetness', 'dryness', 'reservoirState', 'autoFill', 'autoClean', 'loadSolidColorOnly'];

function looksLikeMixer(cto: any): boolean {
    if (!cto || typeof cto !== 'object') return false;
    const hits = MIXER_FINGERPRINT.filter((k) => cto[k] !== undefined).length;
    return hits >= 2;
}

/** 递归找"像储层"的字段（只走三层，够用且不会把整个描述符翻成噪音） */
function findReservoir(obj: any): { key: string; value: any }[] {
    const out: { key: string; value: any }[] = [];
    if (!obj || typeof obj !== 'object') return out;

    const look = (o: any, depth: number) => {
        if (!o || typeof o !== 'object' || depth > 3) return;
        for (const k of Object.keys(o)) {
            if (k === '_options') continue;
            if (isReservoirKey(k)) out.push({ key: k, value: o[k] });
            const v = o[k];
            if (v && typeof v === 'object') look(v, depth + 1);
        }
    };
    look(obj, 0);
    return out;
}

/**
 * 储层的"体检摘要"。**判读时先看这一段**，比翻整份 JSON 快得多。
 *
 * 关键三个数：
 *   · `cols × rows` —— 储层位图尺寸（实测 43×44，远小于 400×400 的图案，
 *     说明 PS 对储层做了降采样；写回去时也得按这个尺寸给，给 400×400 大概率被拒）
 *   · `channelNumber` —— 4 = RGBA（实测）
 *   · `state` / `imageMode` —— PS 自己的状态码，改完要回读它们确认真的变了
 */
function summarizeReservoir(res: { key: string; value: any }[]): any {
    const get = (k: string) => res.find((r) => r.key === k)?.value;
    const ch = get('reservoirChannels');
    const sd = get('reservoirSampleData');
    const shape = (v: any) => {
        if (v === undefined) return 'absent';
        if (v === null) return 'null';
        if (Array.isArray(v)) return `array(${v.length})`;
        if (typeof v === 'object') return `object{${Object.keys(v).slice(0, 10).join(',')}}`;
        return `${typeof v}`;
    };
    return {
        cols: get('reservoirCols'),
        rows: get('reservoirRows'),
        channelNumber: get('reservoirChannelNumber'),
        state: get('reservoirState'),
        imageMode: get('reservoirImageMode'),
        channelsShape: shape(ch),
        sampleDataShape: shape(sd),
        /** 抽样：看第一个通道长什么样（是像素数组、还是 base64、还是 hex 串） */
        firstChannelHead:
            ch && typeof ch === 'object'
                ? Array.isArray(ch)
                    ? (ch[0] && typeof ch[0] === 'object'
                          ? { keys: Object.keys(ch[0]).slice(0, 12), head: previewVal((ch[0] as any).data ?? ch[0]) }
                          : { head: previewVal(ch[0]) })
                    : { keys: Object.keys(ch).slice(0, 12), head: previewVal((ch as any)[Object.keys(ch)[0]]) }
                : previewVal(ch),
        sampleDataHead: previewVal(sd)
    };
}

/** 把任意值压成一小段可读预览（长数组/长字符串都截断） */
function previewVal(v: any): any {
    if (v === undefined) return '(absent)';
    if (v === null) return null;
    if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…(len=${v.length})` : v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) {
        return { type: `array(${v.length})`, head: v.slice(0, 12).map(previewVal) };
    }
    if (typeof v === 'object') {
        const ks = Object.keys(v).slice(0, 10);
        const o: any = {};
        for (const k of ks) o[k] = previewVal(v[k]);
        return o;
    }
    return String(v);
}

async function bp(desc: any): Promise<ProbeTry & { res?: any }> {
    try {
        const res: any = await action.batchPlay([{ ...desc, _options: { dialogOptions: 'silent' } }], {
            synchronousExecution: true
        } as any);
        const first: any = Array.isArray(res) ? res[0] : res;
        if (first && first._obj === 'error') {
            return { label: '', ok: false, err: first.message || String(first.result ?? 'PS 拒绝') };
        }
        return { label: '', ok: true, res: first };
    } catch (e: any) {
        return { label: '', ok: false, err: e?.message || String(e) };
    }
}

/**
 * 跑一次探针。
 *
 * ⚠️ **只发一条命令**。`get currentTool` 那条在 PS 27 上必报 -25920
 *    （`_mixer.json` 的 `tried[0]` 就是它），以前每次点都白刷一条黄条；
 *    改用**指纹字段**判断工具身份后，这条命令已被删除。
 */
export async function probeMixer(onLog?: (m: string) => void): Promise<MixerProbe> {
    const tried: ProbeTry[] = [];
    let cto: any = null;
    let toolName: string | null = null;

    const o = await bp({
        _obj: 'get',
        _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET]
    });
    tried.push({ label: 'get currentToolOptions', ok: o.ok, err: o.err, res: undefined });
    if (o.ok && o.res) {
        cto = o.res.currentToolOptions ?? o.res;
        // 顺手记一下 PS 自己在描述符里报的类名（有就记，没有也不影响判定）
        if (typeof o.res?._obj === 'string' && o.res._obj !== 'currentToolOptions') toolName = o.res._obj;
    }

    // 兜底：上面那条读不到（或读到的不含任何东西）才试工具引用形态
    if (!cto || typeof cto !== 'object' || !Object.keys(cto).length) {
        for (const [label, desc] of [
            ['get mixerBrushTool+property', { _obj: 'get', _target: [{ _ref: 'mixerBrushTool' }], property: 'currentToolOptions' }],
            ['get mixerBrushTool', { _obj: 'get', _target: [{ _ref: 'mixerBrushTool' }] }]
        ] as [string, any][]) {
            const r = await bp(desc);
            tried.push({ label, ok: r.ok, err: r.err, res: undefined });
            if (r.ok && r.res) {
                cto = r.res.currentToolOptions ?? r.res;
                break;
            }
        }
    }

    const fields = cto && typeof cto === 'object' ? Object.keys(cto).filter((k) => k !== '_options') : [];
    const brushObj = cto?.brush;
    const brushFields = brushObj && typeof brushObj === 'object' ? Object.keys(brushObj).filter((k) => k !== '_options') : [];
    const reservoir = findReservoir(cto);
    const reservoirSummary = summarizeReservoir(reservoir);
    const onMixer = looksLikeMixer(cto);

    /**
     * `cto` 里的 `reservoirChannels` / `reservoirSampleData` 实测都是**空对象 `{}`**
     * （2026-10-22 14:40 `_mixer.json`）。两种可能：
     *   · 懒加载 —— 单独 `get` 某个 property 才吐数据
     *   · 本来就不导出 —— PS 只给元数据（尺寸/通道数/状态），像素留在内存
     * ⇒ 只能真机问一次。这一步**是唯一会刷黄条的探测**（属性名猜错就报 -25920），
     *   放在探针里一次性问完，绝不进日常路径。
     */
    const pixelProbe: Record<string, any> = {};
    if (onMixer) {
        for (const prop of ['reservoirChannels', 'reservoirSampleData']) {
            const r = await bp({
                _obj: 'get',
                _target: [{ _ref: 'property', _property: prop }, ...APP_TARGET]
            });
            const val = r.ok ? (r.res as any)?.[prop] ?? r.res : null;
            const empty =
                !val || (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0);
            pixelProbe[prop] = {
                ok: r.ok,
                err: r.err,
                empty,
                shape: empty ? 'empty' : Array.isArray(val) ? `array(${val.length})` : typeof val,
                head: empty ? null : previewVal(val)
            };
            tried.push({
                label: `get ${prop}`,
                ok: r.ok,
                err: r.err,
                res: pixelProbe[prop].head
            });
        }
    }
    const pixelsReadable = Object.values(pixelProbe).some((x: any) => x.ok && !x.empty);

    /**
     * 结论判词。⛔ 判据是「reservoir* 这一族在不在」，不是「字段像不像」——
     *    `texture` / `pattern` 是画笔纹理，和储层无关，混进来就会把结论带偏。
     */
    let verdict: string;
    if (!cto || !fields.length) {
        verdict = '读不到工具状态 —— 可能当前不是混合器画笔，或该形态在本版本不可用（看 tried）';
    } else if (!onMixer) {
        verdict = `当前工具不像混合器（没有 wetness/dryness/reservoirState）—— 读到的是 ${fields.length} 个通用字段`;
    } else if (reservoir.length && pixelsReadable) {
        verdict = `结局① 储层全套可读：${reservoir.length} 个字段 + 像素 ⇒ 能读就有机会写`;
    } else if (reservoir.length) {
        verdict = `结局② 储层元数据可读、像素取不到（${reservoir.map((r) => r.key.replace(/^reservoir/, '')).join('/')}）⇒ 只能回灌或模拟采样`;
    } else {
        verdict = `结局③ 混合器的参数在（${fields.length} 项），但没有 reservoir* 字段 ⇒ 储层是纯位图`;
    }

    onLog?.(`混合器探针：${verdict}`);
    return {
        at: new Date().toISOString(),
        toolName,
        toolOptions: cto,
        fields,
        brushFields,
        reservoir,
        reservoirSummary,
        pixelProbe,
        pixelsReadable,
        tried,
        verdict
    };
}

/**
 * 真·环检测序列化。
 *
 * ⛔⛔ 上一版用 `WeakSet` 把"第二次出现的对象"一律标 `[circular]`，
 *    于是 `reservoirChannels` / `reservoirSampleData` 被当成环给删了 ——
 *    明明读到了储层，文件里只剩两个 `[circular]`，白跑一次真机。
 *    正解：**只检查祖先链**（真环才截断），重复引用照常展开。
 *    另外用 `depth` 上限兜底，防止结构过深把文件写到几 MB。
 */
function stringifySafe(obj: any): string {
    const stack: any[] = [];
    const walk = (v: any, depth: number): any => {
        if (v === undefined) return null;
        if (v === null || typeof v !== 'object') return v;
        if (depth > 12) return '[depth-limit]';
        if (stack.includes(v)) return '[circular]';
        stack.push(v);
        let r: any;
        if (Array.isArray(v)) {
            r = v.map((x) => walk(x, depth + 1));
        } else {
            r = {};
            for (const k of Object.keys(v)) r[k] = walk(v[k], depth + 1);
        }
        stack.pop();
        return r;
    };
    return JSON.stringify(walk(obj, 0), null, 1);
}

/** 落盘（`brushstate/<name>`），供直接在文件系统里读 */
async function writeState(name: string, obj: any): Promise<void> {
    try {
        const data = await lfs.getDataFolder();
        let folder: any;
        try {
            folder = await data.getEntry(DIR);
        } catch {
            folder = await data.createFolder(DIR);
        }
        const file = await folder.createFile(name, { overwrite: true });
        await file.write(stringifySafe(obj));
    } catch {
        /* 写不进去不致命 */
    }
}

export async function dumpProbe(p: MixerProbe): Promise<void> {
    await writeState(FILE, p);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ── E1 第二问：**「Alt+点画布把图案吸进储槽」这一步，PS 会派发什么通知？** ──
 *
 * 背景（2026-10-22 14:58 用户实测纠正）：
 *   · 储层的**元数据**可读（`361×362×4`），**像素取不到**（`reservoirChannels` = `{}`，
 *     单独 `get` 报 -25920）⇒ 我们**写不进**储层。
 *   · 用户纠正了我的一个错误结论：`autoFill` 开不开都不影响——
 *     **改前景色 ⇒ 储槽内容变成该前景色** 是 PS 的必然行为。
 *
 * ⇒ 结论：要在换色后把图案装回储槽，只剩「重新采样」一条路。
 *   而采样要能被脚本触发，才谈得上"实时"。
 *
 * 这个函数就是去拿那个触发方式：**监听 N 秒，用户手动 Alt+点一次**，
 * 把 PS 期间派发的每一条 AM 通知原样记下来。
 *
 * 判读：
 *   · 抓到带 `reservoir*` 键的通知 ⇒ 采样是一条可派发的 AM 事件 ⇒ **可能脚本化**
 *   · 只抓到无关通知 / 一条都没有 ⇒ 采样是纯 UI 手势 ⇒ 走模拟输入或半自动
 *
 * ⛔ 本函数**不发任何 batchPlay**，所以零黄条。
 */
export interface SampleListen {
    at: string;
    seconds: number;
    /** 监听器是否成功装上（装不上说明本版本 UXP 不开放通知监听） */
    listening: boolean;
    /** 抓到的通知总条数 */
    total: number;
    /** 优先看这段：带储层/湿混关键字的事件 */
    hits: { evt: string; keys: string[]; desc?: any }[];
    /** 全部事件名（去重计数）—— 一眼看出这段时间 PS 到底在忙什么 */
    evtNames: Record<string, number>;
    /**
     * 监听前后的储层元数据。
     * 用途：证明"用户确实点上了"（采样成功 ⇒ `state` / `imageMode` 会变），
     * 也证明**元数据可观测**—— 将来若真能写储层，就用这一族当回读判据。
     */
    reservoirBefore?: any;
    reservoirAfter?: any;
    err?: string;
}

/** 读一次储层元数据（只读，不发会失败的探测） */
async function readReservoirMeta(): Promise<any> {
    const r = await bp({
        _obj: 'get',
        _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET]
    });
    if (!r.ok || !r.res) return null;
    const cto = r.res.currentToolOptions ?? r.res;
    const res = findReservoir(cto);
    if (!res.length) return null;
    const s = summarizeReservoir(res);
    return {
        state: s.state,
        imageMode: s.imageMode,
        cols: s.cols,
        rows: s.rows,
        channelNumber: s.channelNumber,
        /** 指纹：元数据全拼起来 —— 采样前后对比这一个字符串就够 */
        fingerprint: `${s.state}|${s.imageMode}|${s.cols}|${s.rows}|${s.channelNumber}`
    };
}

export async function listenSampling(
    seconds: number,
    onTick?: (left: number) => void,
    onMid?: (evt: string) => void
): Promise<SampleListen> {
    const hits: SampleListen['hits'] = [];
    const evtNames: Record<string, number> = {};
    let total = 0;
    let listening = false;
    let err: string | undefined;
    let listener: any = null;

    const KEY_RE = /reservoir|wetness|dryness|mix|well/i;

    // 先记一份采样前的储层元数据，结束时再读一次 → 能证明"点上了"
    const reservoirBefore = await readReservoirMeta();

    const cb = (evt: any, desc: any) => {
        total += 1;
        // UXP 两种签名：`(evt, desc)` 或 `(info)`，都兼容一下
        const name =
            typeof evt === 'string'
                ? evt
                : typeof evt?.evt === 'string'
                  ? evt.evt
                  : typeof desc?.evt === 'string'
                    ? desc.evt
                    : 'unknown';
        evtNames[name] = (evtNames[name] || 0) + 1;
        const d = desc && typeof desc === 'object' ? desc : evt?.descriptor;
        const keys = d && typeof d === 'object' ? Object.keys(d).filter((k) => k !== '_options').slice(0, 30) : [];
        if (keys.some((k) => KEY_RE.test(k))) {
            hits.push({ evt: name, keys, desc: d });
            onMid?.(name);
        }
    };

    // ⛔ 两个 API 都试：`action` 和 `core` 在不同版本上不是同一个对象
    for (const holder of [action as any, (globalThis as any).require?.('photoshop')?.core]) {
        if (!holder || typeof holder.addNotificationListener !== 'function') continue;
        try {
            listener = await holder.addNotificationListener(['all'], cb);
            listening = true;
            break;
        } catch (e: any) {
            err = e?.message || String(e);
        }
    }

    if (listening) {
        for (let i = seconds; i > 0; i--) {
            onTick?.(i);
            await sleep(1000);
        }
        // ⚠️ 采样动作常在鼠标抬起之后才派发，多等 400ms 再摘监听
        await sleep(400);
        try {
            const holder = (action as any)?.removeNotificationListener ? (action as any) : null;
            if (holder && listener) await holder.removeNotificationListener(listener);
        } catch {
            /* 摘不掉不致命 */
        }
    }

    const reservoirAfter = await readReservoirMeta();

    const out: SampleListen = {
        at: new Date().toISOString(),
        seconds,
        listening,
        total,
        hits,
        evtNames,
        reservoirBefore,
        reservoirAfter,
        err
    };
    await writeState('_mixer-listen.json', out);
    return out;
}
/* ================================================================ 储层重装（合成 Alt+点）

 * 一句话：**把「前景色上过色的图案」装进混合器储层**，靠原生合成一次 Alt+左键。
 *
 * ── 为什么必须绕（别再试别的路，都堵死了）──────────────────────────────
 *  · 储层像素不可脚本读写：元数据（Cols/Rows/ChannelNumber）可读，
 *    `reservoirChannels` / `reservoirSampleData` 恒 `{}`，单独 get 报 -25920。
 *  · AM 命令表里没有「载入画笔」：`loadBrush` / `cleanBrush` / `mixerBrushTool` 在
 *    Photoshop.exe 的 ID 表里 0 命中；这个手势也**不派发任何通知**（15:05 实测 30 条通知全无关）。
 *  ⇒ 只剩「本模块在 PS 进程内合成 Alt+左键」这一条。
 *
 * ── 2026-10-22 15:5x 改版（用户三条要求）─────────────────────────────
 *  ① 不再固定 640×640：临时候选文档的边长 = **图案文件的长边**
 *     （178×400 的图案 ⇒ 400×400 的方块，图案居中、两侧留透明边）。
 *  ② 吸之前必须把**方形笔刷直径改成同一个数**，否则吸的区域与图案尺寸不一致，
 *     图案会被裁掉或缩放进笔尖 —— 这就是用户说的"严丝合缝"。
 *  ③ 没有方形笔尖时**首次自己建一个**（白方块文档 → defineBrush），建不成才报错。
 *
 * ── 顺序为什么是「先开图案 → 再定尺寸 → 再建方块 → 再吸」──────────────
 * 边长来自**图案文件本身**，所以必须先读文件；而直径要等于边长，所以读完之后才设。
 *
 * ⛔ 两个不能动的约束：
 *   · **合成点击必须发生在模态作用域之外**。`executeAsModal` 期间 PS 会挡工具输入，
 *     那一枪会被吞掉，日志却一切"成功"。所以本函数只把「开文档/读像素/写像素」
 *     包进模态，点击前后是裸的。
 *   · 临时文档必须 ≥240×240 且为 100% 缩放：原生挑点时用「命中窗口面积 ≥240²」把
 *     停靠坞/工具条排掉（见 plugin_main.c 的 click_pick_point）。缩放不是 100% 时
 *     窗口可能只有一百多像素宽，会被自己人误判成工具条而跳过。
 */
export interface ReservoirReload {
    at: string;
    ok: boolean;
    /** 断在第几步：读到 stage 就知道去哪看 */
    stage: string;
    fg: [number, number, number] | null;
    /** 图案文件（相对插件根）与它的**原始**尺寸 */
    pattern: string;
    patSize: string;
    /** 'file' = 用的是笔刷自带图案；'procedural' = 读不出来，退回程序化浮雕兜底 */
    patSource: string;
    /** 方形边长 = 图案长边 = 笔刷直径 */
    side: number;
    /** 吸之前/之后工具上的笔刷直径 */
    diaBefore: number;
    diaAfter: number;
    /** 装储层时工具上的笔尖名（`brush.name`） */
    tipName: string;
    /** 直径没改成功时的兜底说明（空 = 直径已改到目标值） */
    degraded: string;
    /** ⚠️ 历史字段（0x0202 起不再发 `set` 改直径，恒为 `[]`；留着是为了旧 JSON 还能读） */
    diaTried: { form: string; ok: boolean; err?: string; dia: number; tip: string }[];
    /** 为了装储层切过工具就记在这里（空 = 本来就在混合器上） */
    switched: string;
    docMode: string;
    pxInfo: string;
    before: string | null;
    after: string | null;
    beforeSnap: ResSnap | null;
    afterSnap: ResSnap | null;
    /** 储层里**确认**装进了位图（图案）。false = 还是纯色/空 */
    loaded: boolean;
    /** 原生那一枪的回执（alt/ok/why/坐标）—— "点了没效果"时先看这里 */
    click: { alt: number; ok: number; why: number; x: number; y: number } | null;
    /** 每一枪的坐标与补偿量（0x0203）：多枪时 `click` 只留最后一发，这里全留 */
    clicks: { dx: number; dy: number; x: number; y: number }[];
    dab: {
        side: number;
        /** 与底色明显不同的像素数（= 这一笔到底落下了多少颜料） */
        opaque: number;
        mean: [number, number, number];
        lumaMean: number;
        lumaStd: number;
        tintCos: number;
        /** 笔迹外接框 [left, top, right, bottom]（文档坐标）；读不到为 null */
        bbox: [number, number, number, number] | null;
    } | null;
    ms: number;
    /** 每条命令的成败。**ok=false 的条数 = PS 会画出来的黄条数** */
    cmds: { cmd: string; ok: boolean; err?: string }[];
    log: string[];
    err?: string;
}

export interface ReservoirOpts {
    /** 图案文件（相对插件根），如 `brushes/impasto-detail/MIX-impasto-detail.png` */
    pattern?: string;
    /** 强制方形边长；不传就取图案文件的长边 */
    side?: number;
}

/** 读一次 cto（只读，不做任何探测） */
async function readCtoOnce(): Promise<any> {
    const o = await bp({
        _obj: 'get',
        _target: [{ _ref: 'property', _property: 'currentToolOptions' }, ...APP_TARGET]
    });
    if (!o.ok || !o.res) return null;
    return o.res.currentToolOptions ?? o.res;
}

/**
 * 储层快照。**「装没装上」就靠它判，不靠画一笔去猜。**
 *
 * 2026-10-22 16:16 打出来是 `1|undefined|undefined|undefined|undefined` —— 四个字段都丢。
 * 不是字段名写错，而是 **PS 只在储层里真有位图时才序列化 `reservoirCols/Rows/ChannelNumber`**：
 *   · 储层是纯色/空（state=1）  ⇒ 只有 `reservoirState`
 *   · 储层装进了图案（state=2）  ⇒ 四个字段齐全（14:53 用户手动吸过的那次是 361×362×4）
 * ⇒ 这个"丢字段"本身就是最好的判据，比画一笔读像素更早、更准、也不用污染画布。
 */
interface ResSnap {
    state: number;
    cols: number;
    rows: number;
    ch: number;
    mode: number;
    /** 储层里有位图（= 装的是图案，不是纯色） */
    bitmap: boolean;
}

function reservoirSnap(cto: any): ResSnap | null {
    const r = findReservoir(cto);
    if (!r.length) return null;
    const num = (k: string) => {
        const v = r.find((x) => x.key === k)?.value;
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    };
    const cols = num('reservoirCols');
    const rows = num('reservoirRows');
    return {
        state: num('reservoirState'),
        cols,
        rows,
        ch: num('reservoirChannelNumber'),
        mode: num('reservoirImageMode'),
        bitmap: cols > 0 && rows > 0
    };
}

function snapText(s: ResSnap | null): string {
    if (!s) return '读不到储层字段';
    return s.bitmap ? `state=${s.state} 位图 ${s.cols}×${s.rows}×${s.ch}` : `state=${s.state} 无位图（纯色/空）`;
}

/**
 * 发一枪合成点击，并**等原生回执**。
 * 返回 null = WS 没连上（连"点没点"都不知道）。
 *
 * ⛔ 必须先挂 waiter 再发：原生是异步线程，回执可能比 JS 的下一条语句还早。
 *
 * 0x0204：**只单击，不拖**。用户裁定（16:59）：
 *   「拖动逻辑完全是没必要的，只要正确点到画布中央，吸一下就行。」
 *   ⇒ `drag` 已从协议里删除；"像素少"的真因是旧版点落在画布外（吸歪）。
 */
async function synthClick(
    alt: 0 | 1,
    opts?: { waitMs?: number; dx?: number; dy?: number }
): Promise<any | null> {
    const waitMs = opts?.waitMs ?? 3500;
    const waited = waitHostMessage('canvasClickResult', waitMs);
    const msg: any = { type: 'canvasClick', alt };
    if (opts?.dx) msg.dx = Math.round(opts.dx);
    if (opts?.dy) msg.dy = Math.round(opts.dy);
    if (!sendHostMessage(msg)) return null;
    return await waited;
}

/** 切到混合器画笔的工具名候选。
 *  `wetBrushTool` 是 PS 内部对混合器画笔的通行叫法；第二个只是同义兜底。
 *  ⚠️ UXP 的 `app.currentTool` **只读**（官方 API 表里没有 W），所以只能发 `select`。 */
const MIXER_TOOLS = ['wetBrushTool', 'mixerBrushTool'];

/** 本会话里**验证成功过**的切工具写法下标（-1 = 还没成功过） */
let toolForm = -1;

async function switchToMixer(
    cmd: (desc: any, label: string) => Promise<ProbeTry & { res?: any }>
): Promise<string> {
    const order = toolForm >= 0 ? [toolForm, ...MIXER_TOOLS.map((_, i) => i).filter((i) => i !== toolForm)] : [0, 1];
    for (const i of order) {
        const name = MIXER_TOOLS[i];
        if (!name) continue;
        const r = await cmd({ _obj: 'select', _target: [{ _ref: 'tool', _name: name }] }, `select tool ${name}`);
        if (!r.ok) continue;
        const cto = await readCtoOnce();
        if (looksLikeMixer(cto)) {
            toolForm = i;
            return name;
        }
    }
    return '';
}

/* ---------------------------------------------------------------- 图案 → 方块像素 */

interface Pat {
    w: number;
    h: number;
    /** 1=灰、3=RGB、4=RGBA */
    comps: number;
    data: Uint8Array;
}

/**
 * 用 **PS 自己**解码图案文件：open → getPixels → close。
 *
 * 为什么不自己解 PNG：UXP 没有 zlib，手写 inflate 是给未来埋雷；
 * 而且 PS 已经在我们进程里，一开一关比多一个解码器便宜。
 * ⚠️ 必须在一个模态作用域内调用（open/close 都是模态操作）。
 */
async function readPatternPixels(relPath: string): Promise<Pat> {
    const folder: any = await lfs.getPluginFolder();
    const entry: any = await folder.getEntry(relPath);
    let doc: any = null;
    try {
        doc = await app.open(entry);
        const w = Math.round(Number(doc.width));
        const h = Math.round(Number(doc.height));
        const px: any = await imaging.getPixels({
            documentID: doc.id,
            sourceBounds: { left: 0, top: 0, right: w, bottom: h },
            targetSize: { width: w, height: h }
        });
        const data = new Uint8Array(await px.imageData.getData());
        const comps = Number(px.imageData.components ?? 4);
        px.imageData.dispose();
        return { w, h, comps, data };
    } finally {
        if (doc) {
            try {
                await doc.closeWithoutSaving();
            } catch {
                /* 关不掉也不影响主链，PS 里最多留一张没存的白图 */
            }
        }
    }
}

/**
 * 把图案摆进 side×side 方块，并按前景色上色。
 *
 * 两条通道分工（与 `scripts/build_mixer_pattern.py` 逐项对齐）：
 *   RGB   = 图案亮度 × 前景色   ← 「这一笔什么颜色、有多亮」
 *   alpha = 图案覆盖度          ← 「笔尖轮廓」，**上色时不碰它**，所以换色不改形状
 *
 * ⛔ 两处不能想当然：
 *   · alpha 不是亮度：颜料是不透明的，明暗只走 RGB（把亮度当 alpha = 一坨暗红泥）。
 *   · 上色是**乘法**不是加法：加法常量会在亮处削顶，一半层次被压平。
 *
 * 图案比方块小的话，**居中**摆放、四周留全透明（178×400 ⇒ 左右各 111px 透明）。
 * 那一圈透明不是装饰：混合器会把整块方形都当图案，留一点不透明边就会拖出一个方框。
 */

function composeSquare(pat: Pat, side: number, fg: { red: number; green: number; blue: number }): PatternBuf {
    const out = new Uint8Array(side * side * 4);
    const ox = Math.floor((side - pat.w) / 2);
    const oy = Math.floor((side - pat.h) / 2);
    const k = 1 / 255;

    /**
     * 灰度图案（`PAT-*.png`）先做**线性拉伸到满量程**，再补 gamma / 覆盖度。
     *
     * ⛔ 为什么必须拉伸：我们的 PAT 最亮只有 ~112（2026-10-22 实测），
     *    不拉的话「最浓处」也只有 44% 不透明 ⇒ 叠出来的浮雕像雾里看花；
     *    这与 `scripts/build_mixer_pattern.py` 的 `normalize()` 是同一件事。
     */
    let lo = 255;
    let hi = 0;
    if (pat.comps === 1) {
        for (let i = 0; i < pat.data.length; i++) {
            const v = pat.data[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        if (hi <= lo) hi = lo + 1;
    }
    const stretch = (v: number) => {
        if (pat.comps !== 1) return v;
        const t = ((v - lo) * 255) / (hi - lo);
        return t < 0 ? 0 : t > 255 ? 255 : t;
    };

    const grayToRgb = (v0: number) => Math.round(255 * Math.pow(stretch(v0) * k, 0.6));
    const grayToAlpha = (v0: number) => {
        const v = stretch(v0);
        const t = Math.max(0, Math.min(1, (v - 0.04 * 255) / ((0.30 - 0.04) * 255)));
        return Math.round(255 * Math.pow(t, 0.85));
    };

    for (let y = 0; y < pat.h; y++) {
        const ty = y + oy;
        if (ty < 0 || ty >= side) continue;
        for (let x = 0; x < pat.w; x++) {
            const tx = x + ox;
            if (tx < 0 || tx >= side) continue;
            const si = (y * pat.w + x) * pat.comps;
            const di = (ty * side + tx) * 4;
            let r: number, g: number, b: number, a: number;
            if (pat.comps === 1) {
                const l = grayToRgb(pat.data[si]);
                r = (l * fg.red) / 255; g = (l * fg.green) / 255; b = (l * fg.blue) / 255;
                a = grayToAlpha(pat.data[si]);
            } else if (pat.comps === 3) {
                r = (pat.data[si] * fg.red) / 255;
                g = (pat.data[si + 1] * fg.green) / 255;
                b = (pat.data[si + 2] * fg.blue) / 255;
                a = 255;
            } else {
                r = (pat.data[si] * fg.red) / 255;
                g = (pat.data[si + 1] * fg.green) / 255;
                b = (pat.data[si + 2] * fg.blue) / 255;
                a = pat.data[si + 3];
            }
            out[di] = Math.max(0, Math.min(255, Math.round(r)));
            out[di + 1] = Math.max(0, Math.min(255, Math.round(g)));
            out[di + 2] = Math.max(0, Math.min(255, Math.round(b)));
            out[di + 3] = Math.max(0, Math.min(255, a));
        }
    }
    return { width: side, height: side, data: out };
}

/* ---------------------------------------------------------------- 临时文档 */

/** `documents.add` 的 `mode` 取值在 UXP 各版本之间不一致 —— 2026-10-22 在 PS 27 上
 *  传 `'RGBColor'` 被直接拒绝：
 *  `Invalid constant. Expected 'RGBColor' to be one of NewDocumentMode.`
 *  而官方文档示例写的是 `'RGBColorMode'`。
 *  ⚠️ 这种校验失败是**普通 JS 异常、不产生 PS 黄色通知**（没走 batchPlay），
 *  所以按候选表静默回退是安全的；真正生效的那个值会写进 `_mixer-reload.json`。 */
const DOC_MODE_CANDIDATES = ['RGBColorMode', 'RGB', 'RGBColor'];

async function addDoc(
    side: number,
    name: string,
    fill: 'transparent' | 'white',
    put: (m: string) => void
): Promise<{ doc: any; mode: string }> {
    const errs: string[] = [];
    for (const mode of DOC_MODE_CANDIDATES) {
        try {
            const doc: any = await app.documents.add({
                width: side,
                height: side,
                resolution: 72,
                mode,
                fill,
                name
            } as any);
            put(`临时文档已建：${side}×${side}（${fill}），mode=${mode}`);
            return { doc, mode };
        } catch (e: any) {
            errs.push(`${mode} → ${e?.message || String(e)}`);
        }
    }
    throw new Error(`建临时文档失败（mode 候选全被拒）：${errs.join(' ｜ ')}`);
}

/* ---------------------------------------------------------------- 笔尖身份（方形）

 * 用户口径（2026-10-22 16:36）：
 *   ① 插件要能**自动选中名字叫「方形」的画笔**；
 *   ② 没有这支笔时，要能**自己新建**一支；
 *   ③ 手动选中 250px 的方笔后，要能把直径**改成 400px**。
 *
 * 上一版三条全没做到，因为它只有"直径≈side 就复用、否则 defineBrush"一条路：
 * 顺手拿到的「250方头 @400」满足了早退条件，于是既没换笔、也没改尺寸，
 * 用户看到的还是那支 250 的笔被 PS 当成 400 用。
 */

/** 从 `brush` 描述符抄一份**完整**副本（只去掉 `_options`）。
 *  ⛔ 少带一个键，PS 就把当前笔当成"一支新笔"重建：直径是对的，`sampledData` 没了。 */
function brushCopy(src: any): any {
    const out: any = {};
    if (src && typeof src === 'object') {
        for (const k of Object.keys(src)) if (k !== '_options') out[k] = src[k];
    }
    return out;
}

/**
 * 把描述符里**不能过 JSON 的值递归剔掉**。
 *
 * ⛔⛔ 0x0204 的硬证据：`set wetBrushTool 直径=400` 报
 *    `Illegal data type. ByteArray is not supported for this operation`。
 *    `currentToolOptions` 里确实挂着二进制字段（缩略图/采样数据之类），
 *    整份原样回灌 ⇒ PS 在类型检查那一步就拒了，直径也就没改。
 *    ⇒ 下发前统一过一遍：`ArrayBuffer` / TypedArray / `DataView` 一律丢弃，
 *      其余原样保留（**不能只挑几个键**，少带一个键笔尖就没了，见铁律 49）。
 */
function jsonSafe(v: any): any {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    const g: any = globalThis as any;
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return undefined;
    if (g.ArrayBuffer?.isView && g.ArrayBuffer.isView(v)) return undefined;
    if (Array.isArray(v)) {
        const arr = v.map(jsonSafe).filter((x) => x !== undefined);
        return arr;
    }
    const out: any = {};
    for (const k of Object.keys(v)) {
        const r = jsonSafe(v[k]);
        if (r !== undefined) out[k] = r;
    }
    return out;
}

interface TipState {
    name: string;
    dia: number;
    /** 笔尖句柄（`sampledData`）。它是「笔尖还在不在」的唯一硬证据 */
    sample: string;
    ok: boolean;
}

function tipState(cto: any): TipState {
    const b = cto?.brush ?? {};
    return {
        name: String(b.name ?? ''),
        dia: Math.round(Number(b.diameter?._value ?? 0)),
        sample: String(b.sampledData ?? ''),
        ok: !!b.sampledData
    };
}

const normName = (s: string) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** 方形笔尖的名字判据。用户手上的方笔叫「方形」「250方头」——都带「方」。 */
const SQUARE_HINT = /方/;
/** 没有方形笔尖时，插件自己建的那支叫什么（用户口径：名字就叫「方形」） */
const WANT_TIP_NAME = '方形';

/**
 * 从预设清单里挑一支方形笔尖，**尺寸优先**：
 *   ① 名字里带的目标尺寸（`方形400`、`400方头`）—— 装上来就能直接用，零改动；
 *   ② 精确叫「方形」的；
 *   ③ 名字最短的含「方」那支（尺寸未知，装上后回读再判）。
 * ⛔ 不能只认精确「方形」：用户手上的方笔叫「250方头」，认不出来就会去新建，
 *    于是每点一次多一支预设（16:53 之后正是这么攒出重复项的）。
 */
function pickSquareName(names: string[], side?: number): string {
    if (!names.length) return '';
    const hit = names.filter((n) => SQUARE_HINT.test(n));
    if (!hit.length) return '';
    if (side) {
        const sized = hit.filter((n) => {
            const m = String(n).match(/(\d{2,4})/);
            return !!m && Math.abs(Number(m[1]) - side) <= 2;
        });
        if (sized.length) return sized.slice().sort((a, b) => a.length - b.length)[0];
    }
    const exact = names.find((n) => n === WANT_TIP_NAME);
    if (exact) return exact;
    return hit.slice().sort((a, b) => a.length - b.length)[0];
}

/**
 * 读「画笔预设名清单」。会话内记住哪条读法能用 ——
 * ⛔ 失败的那条每撞一次 PS 就画一条黄条（铁律 51），所以只允许第一次可能失败。
 *
 * ⚠️ 清单是**惰性快照**（删掉的预设还列着），只用来"找方形笔尖在不在"，
 *    绝不用它判断"删没删掉"（那种判据只能按名 select 试一次）。
 */
let tipListForm = -1;

async function listTipNames(): Promise<string[]> {
    for (const idx of tipListForm >= 0 ? [tipListForm] : [0, 1]) {
        const prop = idx === 0 ? 'brushes' : 'presetManager';
        let desc: any = null;
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
            desc = Array.isArray(res) ? res[0] : res;
        } catch {
            continue;
        }
        if (!desc || desc._obj === 'error') continue;

        let names: string[] = [];
        const raw = desc.brush ?? desc.brushes;
        if (prop === 'brushes' && raw) {
            const arr = Array.isArray(raw) ? raw : [raw];
            names = arr.map((b: any) => b?.name).filter((n: any) => typeof n === 'string' && !!n);
        }
        if (!names.length) {
            let pm: any = desc.presetManager;
            if (!pm && (Array.isArray(desc.preset) || Array.isArray(desc.brushPreset))) pm = desc;
            const groups: any[] = [];
            if (Array.isArray(pm)) groups.push(...pm);
            else if (pm) {
                if (Array.isArray(pm.preset)) groups.push(...pm.preset);
                else if (Array.isArray(pm.brushPreset)) groups.push(...pm.brushPreset);
            }
            const g = groups[0];
            const rawNames: any = g?.name ?? g?.names;
            if (rawNames) {
                const arr: any[] = Array.isArray(rawNames) ? rawNames : [rawNames];
                names = arr
                    .map((n: any) => (typeof n === 'string' ? n : (n?.name ?? n?._value ?? '')))
                    .filter((x: any): x is string => typeof x === 'string' && !!x);
            }
        }
        if (names.length) {
            tipListForm = idx;
            return names;
        }
    }
    return [];
}

/**
 * 「按名装笔尖」的写法候选。
 *
 * ⛔⛔ 顺序按 PS 27 的实测结果排，不按"看起来最像"排：
 *    · `select + brush + makeVisible:false`（AM 里的 `MkVs`）是**唯一真正换笔尖**的形态；
 *      少了 `makeVisible` 只把面板那一格高亮，笔尖一点没变（铁律 50/60）。
 *    · `set + brush` 在 27 上报 -1715 ⇒ 放最后当兜底，别让它先刷一条黄条。
 */
const TIP_APPLY_FORMS: { label: string; make: (n: string) => any }[] = [
    { label: 'select+brush+MkVs', make: (n) => ({ _obj: 'select', _target: [{ _ref: 'brush', _name: n }], makeVisible: false }) },
    {
        label: 'select+brushPreset+MkVs',
        make: (n) => ({ _obj: 'select', _target: [{ _ref: 'brushPreset', _name: n }], makeVisible: false })
    },
    { label: 'set+brush', make: (n) => ({ _obj: 'set', _target: [{ _ref: 'brush', _name: n }] }) }
];
let tipApplyForm = -1;
const tipApplyErr: string[] = [];

type Cmd = (d: any, l: string) => Promise<ProbeTry & { res?: any }>;

/** 按名把预设**真正装到当前工具**上。判据只看回读的笔尖名，不信"命令没报错"。 */
async function applyTipByName(name: string, put: (m: string) => void, cmd: Cmd): Promise<boolean> {
    for (const i of tipApplyForm >= 0 ? [tipApplyForm] : TIP_APPLY_FORMS.map((_, k) => k)) {
        const f = TIP_APPLY_FORMS[i];
        const r = await cmd(f.make(name), `装笔尖「${name}」（${f.label}）`);
        if (!r.ok) {
            tipApplyErr[i] = `#${i + 1} ${f.label}: ${r.err ?? '被拒'}`;
            continue;
        }
        const st = tipState(await readCtoOnce());
        if (normName(st.name) === normName(name)) {
            if (tipApplyForm !== i) {
                tipApplyForm = i;
                put(`装笔尖用「${f.label}」写法`);
            }
            return true;
        }
        tipApplyErr[i] = `#${i + 1} ${f.label}: 命令没报错，但工具上还是「${st.name || '无笔尖'}」`;
    }
    return false;
}

/**
 * 把**当前笔尖**的直径改成 `side`，笔尖身份必须原样保住。
 *
 * ⛔⛔ 为什么不能用 `set brush to {几个几何键}`：那会让 PS 整体替换成 `computedBrush`
 *    —— 直径对了，笔尖变成一支软边圆笔（铁律 49/60）。
 *    ⇒ 只走「整份 cto + 只改 `brush.diameter`」这一条，和 `setToolOpacity` 同一套路。
 * 判据：`sampledData` 没变 **且** 回读直径到了目标值，缺一不算成功。
 */
async function setTipDiameter(
    side: number,
    put: (m: string) => void,
    cmd: Cmd
): Promise<{ ok: boolean; dia: number; err?: string }> {
    const cto0 = await readCtoOnce();
    const st0 = tipState(cto0);
    if (!st0.ok) return { ok: false, dia: st0.dia, err: '工具上没有采样笔尖' };
    if (Math.abs(st0.dia - side) <= 1) return { ok: true, dia: st0.dia };

    const to = jsonSafe(brushCopy(cto0));
    to.brush = { ...jsonSafe(brushCopy(cto0?.brush)), diameter: { _unit: 'pixelsUnit', _value: side } };

    const tries: { label: string; desc: any }[] = [
        { label: 'set wetBrushTool', desc: { _obj: 'set', _target: [{ _ref: 'wetBrushTool' }], to } },
        {
            label: 'set brush targetEnum',
            desc: { _obj: 'set', _target: [{ _ref: 'brush', _enum: 'ordinal', _value: 'targetEnum' }], to: to.brush }
        }
    ];
    const errs: string[] = [];
    for (const t of tries) {
        const r = await cmd(t.desc, `${t.label} 直径=${side}`);
        if (!r.ok) {
            errs.push(`${t.label}: ${r.err ?? '被拒'}`);
            continue;
        }
        const st = tipState(await readCtoOnce());
        if (st.ok && st.sample && st0.sample && st.sample !== st0.sample) {
            errs.push(`${t.label}: 笔尖被冲掉了（${st0.sample.slice(0, 8)}… → 换了支新笔）`);
            continue;
        }
        if (Math.abs(st.dia - side) <= 2) return { ok: true, dia: st.dia };
        errs.push(`${t.label}: 回读 ${st.dia}px，没到 ${side}px`);
    }
    return { ok: false, dia: tipState(await readCtoOnce()).dia, err: errs.join(' / ') };
}

/**
 * 自己造一支 `side×side` 的方形笔尖。
 *
 * `defineBrush` 出来的笔尖**直径天生 = 方块边长**，所以它一步同时解决形状和尺寸，
 * 而且不用碰 `set`（`set` 会丢笔尖）。方块必须**白色不透明**：白 = 笔尖全覆盖。
 * ⚠️ 预设名取的是**文档名** ⇒ 名字带边长（`方形400`），下次能直接按名字找回来。
 *
 * ⛔⛔ 0x0204：**必须先把白方块真的画进图层再 defineBrush**。
 *    16:53 那次报的是「无法完成请求，因为所选区域是空的」—— `documents.add` 的
 *    `fill:'white'` 只算"背景填充"，`defineBrush` 的判据是**图层上有没有像素**。
 *    所以这里走 imaging 直接铺一张 side×side 全白 RGBA（和铺图案同一条已验证的路）。
 */
async function createSquareTip(
    side: number,
    put: (m: string) => void,
    cmd: Cmd
): Promise<{ ok: boolean; dia: number; name: string; err?: string }> {
    const tipName = `${WANT_TIP_NAME}${side}`;
    put(`新建一支 ${side}×${side} 的方形笔尖（defineBrush →「${tipName}」）…`);
    let doc: any = null;
    let err = '';
    try {
        await runAsModal(
            async () => {
                const made = await addDoc(side, tipName, 'white', put);
                doc = made.doc;
                const layer: any = made.doc.layers[0];
                const white = new Uint8Array(side * side * 4);
                white.fill(255);
                const img: any = await imaging.createImageDataFromBuffer(white as any, {
                    width: side,
                    height: side,
                    colorSpace: 'RGB',
                    pixelFormat: 'RGBA',
                    components: 4,
                    componentSize: 8
                } as any);
                await imaging.putPixels({
                    documentID: made.doc.id,
                    layerID: layer.id,
                    imageData: img,
                    targetBounds: { left: 0, top: 0, right: side, bottom: side }
                } as any);
                img.dispose();
                const r = await cmd({ _obj: 'defineBrush' }, 'defineBrush');
                if (!r.ok) err = r.err ?? 'defineBrush 被拒';
            },
            { commandName: '悦绘：定义方形笔尖' }
        );
    } catch (e: any) {
        err = e?.message || String(e);
    }
    if (doc) {
        const d = doc;
        try {
            await runAsModal(
                async () => {
                    await d.closeWithoutSaving();
                },
                { commandName: '悦绘：关闭笔尖临时文档' }
            );
        } catch {
            /* 关不掉就留着，不影响主链 */
        }
    }

    /* 回读。⚠️ defineBrush 有可能顺手把工具换掉（换到画笔工具）⇒ 先确认还站在混合器上 */
    let after = await readCtoOnce();
    if (after && !looksLikeMixer(after)) {
        put('定义笔尖后工具被换走了，切回混合器…');
        await switchToMixer(cmd);
        after = await readCtoOnce();
    }
    const st = tipState(after);
    if (st.ok) {
        put(`方形笔尖已建好「${st.name}」，直径 ${st.dia}px`);
        return { ok: true, dia: st.dia, name: st.name };
    }
    return { ok: false, dia: st.dia, name: '', err: err || 'defineBrush 之后工具上仍没有采样笔尖' };
}

/**
 * 保证工具上挂着一个**边长 = side 的方形采样笔尖**。
 *
 * 顺序就是用户提的三条，一步对应一条：
 *   ① 已经是方形笔尖且直径正好 ⇒ 零命令复用（不打扰用户）
 *   ② 不是方形 ⇒ 读预设清单，**按名选中「方形」**（`pickSquareName` 会退而选「250方头」这类）
 *   ③ 有方形笔尖但直径不对 ⇒ **改直径**（整份 cto 下发，笔尖身份保住）
 *   ④ 一支方形都没有 ⇒ **自己 defineBrush 新建**一支，名字叫「方形」
 */
async function ensureSquareTip(
    side: number,
    put: (m: string) => void,
    cmd: Cmd
): Promise<{ ok: boolean; dia: number; name: string; created: boolean; err?: string }> {
    let cto = await readCtoOnce();
    let st = tipState(cto);
    put(`工具上的笔尖：${st.ok ? `「${st.name || '未命名'}」${st.dia}px` : '（没有采样笔尖）'}，目标 ${side}px 方形`);

    /* ① 已经是方形、尺寸也对 —— 一个命令都不发 */
    if (st.ok && SQUARE_HINT.test(st.name) && Math.abs(st.dia - side) <= 1) {
        return { ok: true, dia: st.dia, name: st.name, created: false };
    }

    /* ② 不是方形 ⇒ 去预设清单里找「方形」按名装上来 */
    if (!(st.ok && SQUARE_HINT.test(st.name))) {
        const names = await listTipNames();
        const want = pickSquareName(names, side);
        if (want) {
            put(`当前不是方形笔尖 ⇒ 按名选中预设「${want}」`);
            if (await applyTipByName(want, put, cmd)) {
                cto = await readCtoOnce();
                st = tipState(cto);
                put(`已选中「${st.name}」${st.dia}px`);
            } else {
                put(`⚠️ 按名装「${want}」没成：${tipApplyErr.filter(Boolean).join(' ／ ') || '未知原因'}`);
            }
        } else {
            put(
                names.length
                    ? `预设清单里没有名字带「方」的笔尖（共 ${names.length} 支）`
                    : '读不到画笔预设清单 —— 直接新建方形笔尖'
            );
        }
    }

    /* ③ 手上是方形笔尖了 ⇒ 把直径改成 side
     * ⛔⛔ 必须包在模态作用域里：16:53 那轮 `set brush targetEnum` 报的原话是
     *    `Event: set may modify the state of Photoshop. Such events are only allowed
     *     from inside a modal scope.` —— 改直径这一步一直在模态外发，所以从来没成过。
     */
    if (st.ok && SQUARE_HINT.test(st.name) && Math.abs(st.dia - side) > 1) {
        const from = st.dia;
        let set: { ok: boolean; dia: number; err?: string };
        try {
            set = await runAsModal(() => setTipDiameter(side, put, cmd), {
                commandName: '悦绘：调整方形笔尖直径'
            });
        } catch (e: any) {
            set = { ok: false, dia: from, err: e?.message || String(e) };
        }
        if (set.ok) {
            put(`方形笔尖「${st.name}」直径 ${from} → ${set.dia}px`);
            return { ok: true, dia: set.dia, name: st.name, created: false };
        }
        put(`⚠️ 改直径没成（${set.err}）—— 改为新建一支 ${side}px 的方形笔尖`);
        st = tipState(await readCtoOnce());
    }

    /* ④ 都没有 ⇒ 自己造一支 */
    const made = await createSquareTip(side, put, cmd);
    if (made.ok) {
        if (Math.abs(made.dia - side) > 2) {
            put(`⚠️ 新笔尖回读 ${made.dia}px（目标是 ${side}px）—— 图案会按回读值对齐，仍严丝合缝`);
        }
        return { ok: true, dia: made.dia, name: made.name, created: true };
    }
    return { ok: false, dia: made.dia, name: '', created: false, err: made.err };
}

/* ---------------------------------------------------------------- 主流程 */
/**
 * 把「已上色的图案」装进混合器储层。
 *
 * 流程（失败停在哪一步，看返回的 `stage`）：
 *   ① 工具必须是混合器 —— 不是就切（`select tool wetBrushTool`），切不过来就中止。
 *      否则那一枪是"画一笔"，会污染用户的画布。
 *   ② 读图案文件 → 边长 = 长边（178×400 ⇒ 400）
 *   ③ 把笔刷直径设成边长并回读（严丝合缝的唯一前提）
 *   ④ 建 side×side 临时文档，铺上「按前景色上过色的图案」
 *   ⑤ 100% 缩放（原生挑点要求窗口够大）
 *   ⑥ 合成 Alt+左键 = 装载储层
 *   ⑦ 再补一枪普通点击画个 dab 验货 → 读像素判"颜色跟不跟前景色、有没有多亮度"
 *      （验货前**先清空画布**，否则读到的是我们自己铺的图案，永远"验上"）
 *   ⑧ 关掉临时文档（不保存）
 */
export async function reloadReservoir(
    onLog?: (m: string) => void,
    opts?: ReservoirOpts
): Promise<ReservoirReload> {
    const t0 = Date.now();
    const logLines: string[] = [];
    const cmds: { cmd: string; ok: boolean; err?: string }[] = [];
    const put = (m: string) => {
        logLines.push(m);
        onLog?.(m);
    };
    /** 带记账的 batchPlay：失败条数就是 PS 会画出来的黄条数 */
    const cmd = async (desc: any, label: string) => {
        const r = await bp(desc);
        cmds.push({ cmd: label, ok: r.ok, err: r.err });
        return r;
    };

    const out: ReservoirReload = {
        at: new Date().toISOString(),
        ok: false,
        stage: 'start',
        fg: null,
        pattern: opts?.pattern ?? '',
        patSize: '',
        patSource: '',
        side: 0,
        diaBefore: 0,
        diaAfter: 0,
        tipName: '',
        switched: '',
        degraded: '',
        diaTried: [],
        docMode: '',
        pxInfo: '',
        before: null,
        after: null,
        beforeSnap: null,
        afterSnap: null,
        loaded: false,
        click: null,
        clicks: [],
        dab: null,
        ms: 0,
        cmds,
        log: logLines
    };
    let tempDoc: any = null;

    const cleanup = async () => {
        if (!tempDoc) return;
        const d = tempDoc;
        tempDoc = null;
        try {
            await runAsModal(async () => {
                try {
                    await d.closeWithoutSaving();
                } catch {
                    /* 已经关掉了就忽略 */
                }
            }, { commandName: '悦绘：关闭储层临时文档' });
        } catch {
            /* ignore */
        }
    };

    try {
        /* ① 工具身份 / 切换 */
        let cto = await readCtoOnce();
        if (!looksLikeMixer(cto)) {
            put('当前不是混合器画笔，尝试切过去（wetBrushTool）…');
            const how = await switchToMixer(cmd);
            if (!how) {
                out.stage = 'not-mixer';
                put('切不到混合器画笔 —— 这一枪点下去只会画一笔，已中止');
                out.ms = Date.now() - t0;
                await writeState('_mixer-reload.json', out);
                return out;
            }
            out.switched = how;
            cto = await readCtoOnce();
            put(`已切到混合器画笔（${how}）`);
        }
        out.stage = 'tool-ok';
        out.beforeSnap = reservoirSnap(cto);
        out.before = snapText(out.beforeSnap);
        out.diaBefore = Math.round(Number(cto?.brush?.diameter?._value ?? 0));
        out.tipName = String(cto?.brush?.name ?? '');

        /* ② 图案 → 边长 */
        const rel = String(opts?.pattern ?? '');
        if (!rel) throw new Error('没给图案文件（brush.json 里缺 mixer.pattern）');
        let pat: Pat | null = null;
        let patErr = '';
        try {
            await runAsModal(
                async () => {
                    pat = await readPatternPixels(rel);
                },
                { commandName: '悦绘：读取储层图案' }
            );
        } catch (e: any) {
            patErr = e?.message || String(e);
        }
        const p: Pat | null = pat;
        out.patSource = p ? 'file' : 'procedural';
        out.patSize = p ? `${p.w}×${p.h}` : '(读不到)';
        /* 边长 = 图案长边（178×400 ⇒ 400）。读不到图案时退回 400：宁可尺寸对不上，
           也要让整条链跑完并把原因写进日志 —— 半路中止只会让用户对着"没反应"猜。 */
        const wantSide = Math.max(64, Math.round(opts?.side ?? (p ? Math.max(p.w, p.h) : 400)));
        if (p) {
            put(`图案 ${rel} = ${out.patSize} ⇒ 方形 ${wantSide}×${wantSide}（笔刷直径也设成 ${wantSide}）`);
        } else {
            put(`⚠️ 图案读不出来（${patErr}）—— 本轮改用**程序化浮雕**兜底，边长按 ${wantSide}`);
        }
        out.side = wantSide;
        out.stage = 'pattern';

        /* ③ 方形笔尖：边长 = 图案长边，**由笔尖自己带**，全程不发 `set` 直径
         * （`set` 会把 sampledData 抹掉 ⇒ 方形笔尖变成计算圆笔，见 ensureSquareTip 注释） */
        const tip = await ensureSquareTip(wantSide, put, cmd);
        if (!tip.ok) {
            throw new Error(
                `没有方形笔尖，自动创建也失败了（${tip.err}）—— 请在画笔面板选一个方形笔尖后重试`
            );
        }
        out.tipName = tip.name;
        out.diaAfter = tip.dia;
        if (tip.created) put(`注意：这次新建了方形笔尖「${tip.name}」，下次会直接复用它`);

        /* ④ **笔尖直径必须等于图案长边，没有降级。**
         *
         * ⛔⛔ 0x0204 的教训（用户 16:59 现场）：
         *    旧代码在"笔尖 ≠ 长边"时把图案缩到笔尖尺寸，于是 250 的笔 + 178×400 的图案
         *    ⇒ 临时文档建成 250×250，图案被压小，用户看到「新建的画布和我选中的笔一样大」。
         *    严丝合缝的前提是**方块边长 = 笔尖直径**，这只能靠把笔尖做到 400 来满足；
         *    把图案缩小是"看起来对齐、实际丢掉分辨率"，而且会让画布小于图案。
         *    ⇒ 差超过容差就抛，让人往上修笔尖，绝不偷偷改小目标。
         *    PS 会做 400→407 这类向上取整（+1.75%），所以容差给 2px 并按回读值走。
         */
        const sideUsed = tip.dia;
        if (Math.abs(tip.dia - wantSide) > 2) {
            throw new Error(
                `笔尖是 ${tip.dia}px、图案长边 ${wantSide}px —— 改直径和新建都没能对齐，` +
                    `请检查画笔面板里是否禁用了笔尖尺寸，或手动把笔刷设为 ${wantSide}px 再点`
            );
        }
        put(`笔尖 ${tip.dia}px = 图案长边 ${wantSide}，图案 1:1 装进去`);
        out.side = sideUsed;

        /* ⑤ 前景色 → 像素 → 临时文档 */
        const fgc: any = app.foregroundColor;
        const fg = {
            red: Math.round(Number(fgc?.rgb?.red ?? 0)),
            green: Math.round(Number(fgc?.rgb?.green ?? 0)),
            blue: Math.round(Number(fgc?.rgb?.blue ?? 0))
        };
        out.fg = [fg.red, fg.green, fg.blue];
        /* 图案**不缩放**，直接居中放进 sideUsed×sideUsed 的方块。
         * 笔尖回读 407、图案长边 400 时，多出来的 7px 是透明边 —— 采样方块仍是 407，
         * 图案完整落在中间，严丝合缝；反过来缩放反而把分辨率改掉（0x0204 起不再缩）。 */
        const patt: PatternBuf = p
            ? composeSquare(p, sideUsed, fg)
            : buildReservoirPattern(fg, sideUsed, 7);
        put(
            p
                ? `前景色 rgb(${fg.red},${fg.green},${fg.blue}) × 图案 → 方块已上色`
                : `前景色 rgb(${fg.red},${fg.green},${fg.blue}) × 程序化浮雕 → 方块已上色`
        );

        await runAsModal(
            async () => {
                const made = await addDoc(sideUsed, '悦绘·储层临时', 'transparent', put);
                out.docMode = made.mode;
                tempDoc = made.doc;
                const layer: any = made.doc.layers[0];
                const img: any = await imaging.createImageDataFromBuffer(patt.data as any, {
                    width: sideUsed,
                    height: sideUsed,
                    colorSpace: 'RGB',
                    pixelFormat: 'RGBA',
                    components: 4,
                    componentSize: 8
                } as any);
                await imaging.putPixels({
                    documentID: made.doc.id,
                    layerID: layer.id,
                    imageData: img,
                    targetBounds: { left: 0, top: 0, right: sideUsed, bottom: sideUsed }
                } as any);
                img.dispose();
            },
            { commandName: '悦绘：铺开储层图案' }
        );
        out.stage = 'doc';
        put('临时文档已铺满图案');

        /* ⑥ 视图居中 + 100% ---------------------------------------------------
         *   · `fitOnScreen` 不是为了"看清楚"，是为了**把图像摆到视口正中**：
         *     原生那一枪点的是主框客户区中心，只有图像居中，它才落在图案中心。
         *     16:33 那次只发 `actualPixels`（只改缩放、不动滚动位置），结果正是
         *     用户说的「吸的位置不是临时图层的正中央，吸歪了」。
         *   · 再 `actualPixels` 钉到 100%，让 1 屏幕像素 = 1 文档像素
         *     （将来按偏移量做 dx/dy 补偿时要靠它折算）。
         */
        let zoomNote = '';
        await runAsModal(
            async () => {
                const fit = await cmd(
                    {
                        _obj: 'select',
                        _target: [{ _ref: 'menuItemClass', _enum: 'menuItemType', _value: 'fitOnScreen' }]
                    },
                    'select menuItem fitOnScreen'
                );
                if (!fit.ok) zoomNote = `居中没成（${fit.err}）`;
                const act = await cmd(
                    {
                        _obj: 'select',
                        _target: [{ _ref: 'menuItemClass', _enum: 'menuItemType', _value: 'actualPixels' }]
                    },
                    'select menuItem actualPixels'
                );
                if (!act.ok) zoomNote += ` 100% 没成（${act.err}）`;
            },
            { commandName: '悦绘：视图居中' }
        );
        put(zoomNote ? `⚠️ ${zoomNote} —— 图像可能没居中，点击会吸歪` : '视图已居中并切到 100%（点击落在图案正中）');
        await sleep(300);

        /* ⑦ 合成 Alt+左键 = 装储层 ---------------------------------------------
         *
         * ⛔⛔ 每枪都等原生回执再核对（0x0202 的教训）：`alt` 被吞成 0 时，
         *    "发了"和"点了"完全是两件事，而面板毫不知情 —— 那次两枪都成了普通落笔，
         *    储层纹丝不动，面板却报「装上了」。
         */
        const altShot = async (dx: number, dy: number): Promise<void> => {
            const shot = await synthClick(1, { dx, dy });
            if (!shot) {
                out.stage = 'no-ws';
                throw new Error('原生宿主没连上（WS 18924）—— 请重载插件或重启 PS');
            }
            out.click = {
                alt: Number(shot.alt ?? -1),
                ok: Number(shot.ok ?? 0),
                why: Number(shot.why ?? -1),
                x: Number(shot.x ?? 0),
                y: Number(shot.y ?? 0)
            };
            if (!out.click.ok) {
                out.stage = 'click-fail';
                throw new Error(`原生合成点击没执行（why=${out.click.why}）—— 挑不到画布上的点`);
            }
            if (out.click.alt !== 1) {
                out.stage = 'click-noalt';
                throw new Error(
                    `原生把 Alt 弄丢了（回执 alt=${out.click.alt}）—— 这一枪只是普通落笔，储层没被装`
                );
            }
            out.clicks.push({ dx, dy, x: out.click.x, y: out.click.y });
            put(
                `合成点击 alt=1，点 (${out.click.x},${out.click.y})` +
                    (dx || dy ? `（补偿 dx=${dx} dy=${dy}）` : '')
            );
            await sleep(700);
            const afterCto = await readCtoOnce();
            out.afterSnap = reservoirSnap(afterCto);
            out.after = snapText(out.afterSnap);
            out.loaded = !!out.afterSnap?.bitmap;
            put(`储层 before=${out.before ?? '无'} → after=${out.after ?? '无'}`);
        };

        /* ⑧ 验货：铺一层中性底 → 拖一笔 → 读像素 -------------------------------
         *
         * ⛔⛔ 两个都被 16:33 那轮证伪过：
         *   ① **清空画布**是错的。混合器是"湿笔"，在**全透明**画布上几乎落不下颜料
         *      （那次 dab 只有 340 个像素），于是判据把它写成"纯色"——冤枉了储层。
         *      改成铺一层不透明中灰：既像用户真实作画的场景，也让"与底色的差异"
         *      成为干净的判据。
         *   ② **单击**是错的。混合器一次点击只吐出一点点颜料，必须按住拖一小段
         *      才是用户真实的一笔。
         *
         * 判据因此从"不透明像素"换成"与底色差异明显的像素"：
         *   底色本来就不透明，再用 alpha 判会永远全中。
         */
        const BASE_V = 128;
        const fillBase = async (v: number) => {
            await runAsModal(
                async () => {
                    const buf = new Uint8Array(sideUsed * sideUsed * 4);
                    for (let i = 0; i < sideUsed * sideUsed; i++) {
                        buf[i * 4] = v;
                        buf[i * 4 + 1] = v;
                        buf[i * 4 + 2] = v;
                        buf[i * 4 + 3] = 255;
                    }
                    const img: any = await imaging.createImageDataFromBuffer(buf as any, {
                        width: sideUsed,
                        height: sideUsed,
                        colorSpace: 'RGB',
                        pixelFormat: 'RGBA',
                        components: 4,
                        componentSize: 8
                    } as any);
                    await imaging.putPixels({
                        documentID: tempDoc?.id ?? 0,
                        layerID: tempDoc?.layers?.[0]?.id ?? 0,
                        imageData: img,
                        targetBounds: { left: 0, top: 0, right: sideUsed, bottom: sideUsed }
                    } as any);
                    img.dispose();
                },
                { commandName: '悦绘：铺验货底色' }
            );
        };

        const probeDab = async (): Promise<NonNullable<ReservoirReload['dab']>> => {
            await fillBase(BASE_V);
            const shot2 = await synthClick(0);
            if (!shot2) put('⚠️ 验货那一枪没发出去（WS 断了），下面的读数不作数');
            else if (!Number(shot2.ok)) put(`⚠️ 验货那一枪没执行（why=${shot2.why}）`);
            await sleep(700);

            const shot = await runAsModal(
                async () => {
                    const px: any = await imaging.getPixels({
                        documentID: tempDoc?.id ?? 0,
                        sourceBounds: { left: 0, top: 0, right: sideUsed, bottom: sideUsed },
                        targetSize: { width: sideUsed, height: sideUsed }
                    } as any);
                    const buf = new Uint8Array(await px.imageData.getData());
                    const w = Number(px.imageData.width ?? sideUsed);
                    const h = Number(px.imageData.height ?? sideUsed);
                    const comps = Number(px.imageData.components ?? 4);
                    px.imageData.dispose();
                    return { buf, w, h, comps };
                },
                { commandName: '悦绘：读验货像素' }
            );

            const data = shot.buf;
            const comps = shot.comps === 3 ? 3 : shot.comps === 1 ? 1 : 4;
            out.pxInfo = `${shot.w}×${shot.h}×${comps}`;

            let count = 0;
            let sr = 0, sg = 0, sb = 0, sumL = 0, sumL2 = 0;
            let left = 1e9, top = 1e9, right = -1, bot = -1;
            const n = Math.min(shot.w * shot.h, Math.floor(data.length / comps));
            for (let i = 0; i < n; i++) {
                const j = i * comps;
                const cr = data[j];
                const cg = comps === 1 ? cr : data[j + 1];
                const cb = comps === 1 ? cr : data[j + 2];
                const diff = Math.abs(cr - BASE_V) + Math.abs(cg - BASE_V) + Math.abs(cb - BASE_V);
                if (diff <= 18) continue;
                count++;
                sr += cr; sg += cg; sb += cb;
                const lu = 0.299 * cr + 0.587 * cg + 0.114 * cb;
                sumL += lu; sumL2 += lu * lu;
                const x = i % shot.w;
                const y = Math.floor(i / shot.w);
                if (x < left) left = x;
                if (x > right) right = x;
                if (y < top) top = y;
                if (y > bot) bot = y;
            }
            const lumaMean = count ? sumL / count : 0;
            const lumaStd = count ? Math.sqrt(Math.max(0, sumL2 / count - lumaMean * lumaMean)) : 0;
            const mr = count ? sr / count : 0;
            const mg = count ? sg / count : 0;
            const mb = count ? sb / count : 0;

            return {
                side: sideUsed,
                opaque: count,
                mean: [Math.round(mr), Math.round(mg), Math.round(mb)],
                lumaMean: Math.round(lumaMean * 10) / 10,
                lumaStd: Math.round(lumaStd * 10) / 10,
                tintCos: 0,
                bbox: right >= 0 ? [left, top, right, bot] : null
            };
        };

        await altShot(0, 0);
        if (!out.loaded) {
            /* 没有位图 = 储层里只有纯色。这时再补一枪 dab 也只会读到纯色
               （16:16 就是这么白跑一轮，还把"纯色"报成了"装上了"），所以直接停。 */
            throw new Error(
                `Alt+点击没把图案装进储层（${out.after ?? '读不到储层'}）—— 储层仍是纯色。` +
                    ` 多半是这一枪没落在画布上，或 PS 没把它当成「载入画笔」`
            );
        }
        put('储层里已经有位图了 —— 点一笔看它到底有没有图案');

        const dab = await probeDab();
        out.dab = dab;

        /* 色相方向一致性：笔迹均色方向 vs 前景色方向；1 = 完全同向 */
        const dL = (dab.mean[0] + dab.mean[1] + dab.mean[2]) / 3;
        const fL = (fg.red + fg.green + fg.blue) / 3;
        const dv = [dab.mean[0] - dL, dab.mean[1] - dL, dab.mean[2] - dL];
        const fv = [fg.red - fL, fg.green - fL, fg.blue - fL];
        const dn = Math.hypot(dv[0], dv[1], dv[2]);
        const fn = Math.hypot(fv[0], fv[1], fv[2]);
        dab.tintCos = dn > 1e-6 && fn > 1e-6
            ? Math.round(((dv[0] * fv[0] + dv[1] * fv[1] + dv[2] * fv[2]) / (dn * fn)) * 1000) / 1000
            : 0;
        /* 前景色接近中性灰（黑/白/灰）时「色相方向」没有意义 —— 那时只看层次 */
        const fgNeutral = fn < 8;

        /* 三层判据，一层一句话（混在一起用户只会看到"失败了"）：
         *   ① `opp` 太少   ⇒ 这一笔几乎没落下颜料（八成是吸到了空白，或视图没居中）
         *   ② `lumaStd` 低 ⇒ 落下了，但整片一个颜色（储层里是纯色，不是图案）
         *   ③ 色相不对     ⇒ 图案进去了，但没跟着前景色走
         */
        const opp = dab.opaque || 0;
        const enough = opp > sideUsed * 6;
        const rich = enough && dab.lumaStd >= 6;
        const tintOk = fgNeutral || dab.tintCos > 0.8;
        out.ok = out.loaded && rich && tintOk;
        out.stage = 'done';
        const dabLine =
            `点击落色 ${opp}px（${out.pxInfo}${dab.bbox ? ` bbox ${dab.bbox.join(',')}` : ''}），` +
            `均色 rgb(${dab.mean.join(',')})，亮度 ${dab.lumaMean}±${dab.lumaStd}，色相 cosine=${dab.tintCos}` +
            `${fgNeutral ? '（前景近灰，不看色相）' : ''}`;
        if (!enough) {
            put(
                `${dabLine} ⇒ 这一笔几乎没落下颜料：Alt 那一枪多半吸到了空白（视图没居中 / 点击落在图案外）`
            );
        } else if (!rich) {
            put(`${dabLine} ⇒ 有颜料但一片纯色，储层里装的不是图案`);
        } else if (!tintOk) {
            put(`${dabLine} ⇒ 有层次，但色相没跟着前景色走`);
        } else {
            put(`${dabLine} ⇒ 储层装上了、有层次、颜色跟随前景色`);
        }
    } catch (e: any) {
        out.err = e?.message || String(e);
        put(`失败（${out.stage}）：${out.err}`);
    } finally {
        await cleanup();
        out.ms = Date.now() - t0;
        await writeState('_mixer-reload.json', out);
    }
    return out;
}
