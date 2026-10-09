/**
 * 临时诊断探针（**已停用，保留备查**）
 * ==========================================================
 *
 * ⚠️ 现状（2026-10-09）：**本模块已从 `index.tsx` 摘除挂载**，因此不参与构建、
 * 也不会在插件加载时运行（未被任何模块 import ⇒ webpack 根本不会把它打进 bundle）。
 * 需要再做一次同类取证时，在 `src/index.tsx` 末尾加两行即可复活：
 *     `import { startIsModalProbe } from './utils/isModalProbe';`
 *     `startIsModalProbe();`
 *
 * 它已经回答了要回答的问题（结论：**isModal 会采信宿主模态，必须弃用**，
 * 见 psAccess.isInOwnModalScope 的注释），因此判据本身不再需要它。
 *
 * 原始用途记录 ——
 * 要回答的问题只有一个：
 *   `photoshop.core.isModal()` 到底只表示「本插件自己持有模态作用域」，
 *   还是会把宿主（Photoshop 自己的「另存为」/打开/保存等原生对话框）的模态态也算进来？
 *
 * 为什么这个问题是致命的：
 *   src/utils/psAccess.ts 的 psTryRead() 第 ① 分支是
 *       if (isInOwnModalScope()) { ...直接 await fn()... }   // 直读 == 裸 get
 *   而 isInOwnModalScope() 当时采信 core.isModal()。
 *   一旦它在宿主忙碌时也返回 true，保护就会在最需要它的瞬间退化成裸 get，
 *   被 PS 弹出原生框「命令"获取"当前不可用」——且该框绕过 JS try/catch。
 *
 * 探针同时采集三样东西：
 *   1. isModal() 本身（核心）
 *   2. 插件的忙碌闸门 isPsBusy() / 闩锁 / 同步租约（看闸门到底拦住没有）
 *   3. 采样间隔（若宿主模态期 UXP 定时器被冻结，这里会出现巨大缺口 —— 另一条独立线索）
 *
 * 真机结果（2026-10-09 17:42）：53 样本 / isModal=true 7 个（最长连续 1025ms）/ 采样
 * 间隔正常（最长 217ms）/ 这 7 个里闸门拦住 6 个、放行 1 个。
 *
 * 结果：写入插件数据目录的 jw_ismodal_probe.txt，并弹窗给出摘要与完整路径。
 */

import { core } from 'photoshop';
import { isPsBusy, isDocLatchActive, canSyncReadHost } from './psProbe';

const SAMPLE_MS = 200;
const MAX_DURATION_MS = 90000;
const SETTLE_AFTER_MODAL_MS = 5000;
const BOOT_DELAY_MS = 1200;
const GAP_FACTOR = 4;
const RESULT_FILE = 'jw_ismodal_probe.txt';

interface Sample {
    t: number;
    modal: number;      // 1 = true, 0 = false, -1 = 抛错
    err?: string;
    busy: boolean;
    latch: boolean;
    lease: boolean;
}

let started = false;

function pad2(n: number): string {
    return n < 10 ? '0' + n : String(n);
}

function clockOf(base: number, offset: number): string {
    const d = new Date(base + offset);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
        + '.' + String(d.getMilliseconds() + 1000).slice(1);
}

function padR(n: number, w: number): string {
    let s = String(n);
    while (s.length < w) s = ' ' + s;
    return s;
}

/**
 * 启动探针。模块级 started 保证两个面板共用同一 bundle 时也只启动一次。
 */
export function startIsModalProbe(): void {
    if (started) return;
    started = true;

    const samples: Sample[] = [];
    let t0 = 0;
    let timer: any = null;
    let modalOpen = false;
    let modalClosedAt = 0;
    let finished = false;

    function tick(): void {
        if (finished) return;
        const t = Date.now() - t0;

        let modal = -1;
        let err: string | undefined;
        try {
            modal = core.isModal() ? 1 : 0;
        } catch (e: any) {
            err = String((e && e.message) || e);
        }

        let busy = false;
        let latch = false;
        let lease = false;
        try { busy = isPsBusy(); } catch (_) { /* ignore */ }
        try { latch = isDocLatchActive(); } catch (_) { /* ignore */ }
        try { lease = canSyncReadHost(); } catch (_) { /* ignore */ }

        samples.push({ t: t, modal: modal, err: err, busy: busy, latch: latch, lease: lease });

        if (modal === 1) {
            if (!modalOpen) {
                modalOpen = true;
                console.log('🔎 [isModal探针] ' + clockOf(t0, t) + '  isModal -> true   (busy=' + busy + ', latch=' + latch + ')');
            }
            modalClosedAt = 0;
        } else if (modalOpen) {
            modalOpen = false;
            modalClosedAt = Date.now();
            console.log('🔎 [isModal探针] ' + clockOf(t0, t) + '  isModal -> false');
        }

        const timedOut = t >= MAX_DURATION_MS;
        const settled = modalClosedAt > 0 && (Date.now() - modalClosedAt) >= SETTLE_AFTER_MODAL_MS;
        if (timedOut || settled) {
            stop(timedOut ? '已跑满 ' + (MAX_DURATION_MS / 1000) + ' 秒上限' : '检测到一次完整的模态开/关周期');
        }
    }

    function stop(reason: string): void {
        if (finished) return;
        finished = true;
        if (timer) { clearInterval(timer); timer = null; }

        const report = buildReport(reason);
        const summary = buildSummary(reason);
        console.log('[isModal探针] ' + reason + '\n' + report);
        void persist(report, summary);
    }

    async function persist(report: string, summary: string): Promise<void> {
        let savedPath = '';
        try {
            const lfs: any = require('uxp').storage.localFileSystem;
            const formats: any = require('uxp').storage.formats;
            const dataFolder: any = await lfs.getDataFolder();
            const file: any = await dataFolder.createFile(RESULT_FILE, { overwrite: true });
            await file.write(report, { format: formats.utf8 });
            savedPath = String(file.nativePath || RESULT_FILE);
        } catch (e: any) {
            console.error('❌ [isModal探针] 落盘失败:', e);
        }

        const tail = savedPath
            ? '\n\n完整报告已写入：\n' + savedPath
            : '\n\n（落盘失败，完整报告请从控制台日志获取）';
        try {
            core.showAlert({ message: summary + tail });
        } catch (_) { /* ignore */ }
    }

    function buildSummary(reason: string): string {
        const n = samples.length;
        let trueCount = 0;
        for (const s of samples) if (s.modal === 1) trueCount++;

        let maxGap = 0;
        for (let i = 1; i < n; i++) {
            const g = samples[i].t - samples[i - 1].t;
            if (g > maxGap) maxGap = g;
        }

        let tBusy = 0;
        let tFree = 0;
        for (const s of samples) {
            if (s.modal === 1) { if (s.busy) tBusy++; else tFree++; }
        }

        const L: string[] = [];
        L.push('【诊断探针 结果】 结束原因：' + reason);
        L.push('');
        L.push('采样 ' + SAMPLE_MS + 'ms 一次，共 ' + n + ' 次（约 ' + Math.round(n * SAMPLE_MS / 1000) + ' 秒）');
        L.push('isModal() = true 的样本：' + trueCount + ' 次');
        L.push('最长采样间隔：' + maxGap + ' ms（正常应接近 ' + SAMPLE_MS + '）');
        L.push('');
        if (trueCount === 0) {
            L.push('本插件自己没进过模态态，所以 isModal() 应该全程 false。');
            L.push('若你确实开过「另存为」并停留，则说明它【不采信宿主模态】—— 假设不成立。');
        } else {
            L.push('isModal() 在宿主模态期返回了 true，共 ' + trueCount + ' 次。');
            L.push('');
            L.push('关键交叉表（这 ' + trueCount + ' 次里，插件闸门的状态）：');
            L.push('  闸门拦住了（isPsBusy=true）  : ' + tBusy + ' 次');
            L.push('  闸门没拦住（isPsBusy=false）: ' + tFree + ' 次');
            if (tFree > 0) {
                L.push('');
                L.push('=> 误报坐实：闸门放行而 isModal 又答「可以读」，');
                L.push('   插件就会在宿主忙碌时执行裸 get，被弹原生框。');
            }
        }
        return L.join('\n');
    }

    function buildReport(reason: string): string {
        const n = samples.length;
        const L: string[] = [];

        let trueCount = 0;
        let falseCount = 0;
        let errCount = 0;
        for (const s of samples) {
            if (s.modal === 1) trueCount++;
            else if (s.modal === 0) falseCount++;
            else errCount++;
        }

        const gaps: { from: number; to: number; gap: number }[] = [];
        let maxGap = 0;
        let maxGapAt = -1;
        for (let i = 1; i < n; i++) {
            const g = samples[i].t - samples[i - 1].t;
            if (g > maxGap) { maxGap = g; maxGapAt = samples[i].t; }
            if (g > SAMPLE_MS * GAP_FACTOR) {
                const last = gaps.length ? gaps[gaps.length - 1] : null;
                if (last && samples[i - 1].t - last.to <= SAMPLE_MS * 2) {
                    last.to = samples[i].t;
                    last.gap = last.to - last.from;
                } else {
                    gaps.push({ from: samples[i - 1].t, to: samples[i].t, gap: g });
                }
            }
        }

        const runs: { from: number; to: number; n: number }[] = [];
        let cur: { from: number; to: number; n: number } | null = null;
        for (const s of samples) {
            if (s.modal === 1) {
                if (!cur) { cur = { from: s.t, to: s.t, n: 1 }; runs.push(cur); }
                else { cur.to = s.t; cur.n++; }
            } else {
                cur = null;
            }
        }

        let tBusy = 0;
        let tFree = 0;
        let tLatch = 0;
        let tLease = 0;
        for (const s of samples) {
            if (s.modal === 1) {
                if (s.busy) tBusy++; else tFree++;
                if (s.latch) tLatch++;
                if (s.lease) tLease++;
            }
        }

        L.push('===== JWautofill isModal 诊断探针 / 完整报告 =====');
        L.push('结束原因 : ' + reason);
        L.push('开始时间 : ' + new Date(t0).toLocaleString());
        L.push('结束时间 : ' + new Date().toLocaleString());
        L.push('采样间隔 : ' + SAMPLE_MS + ' ms');
        L.push('样本总数 : ' + n + '  （约 ' + Math.round(n * SAMPLE_MS / 1000) + ' 秒）');
        L.push('  isModal=true  : ' + trueCount);
        L.push('  isModal=false : ' + falseCount);
        L.push('  isModal 抛错  : ' + errCount);
        L.push('');
        L.push('最长采样间隔 : ' + maxGap + ' ms' + (maxGapAt >= 0 ? ('  （出现在 ' + clockOf(t0, maxGapAt) + ' / +' + maxGapAt + 'ms）') : ''));
        L.push('');

        L.push('----- 结论 1：isModal 是否采信宿主模态 -----');
        if (runs.length === 0) {
            L.push('全程未出现 isModal=true。');
            L.push('本插件自己没进过模态作用域，因此这是「否定式结果」：');
            L.push('该假设不成立，弹框另有成因（请重点看结论 2 与结论 3）。');
        } else {
            L.push('出现 isModal=true 的区间共 ' + runs.length + ' 段：');
            for (let i = 0; i < runs.length && i < 12; i++) {
                const r = runs[i];
                L.push('  ' + clockOf(t0, r.from) + ' ~ ' + clockOf(t0, r.to)
                    + '   持续约 ' + (r.to - r.from) + ' ms   (' + r.n + ' 个样本)');
            }
            if (runs.length > 12) L.push('  ...（其余 ' + (runs.length - 12) + ' 段省略）');
            L.push('');
            L.push('=> 本插件未持有模态作用域，但 isModal() 仍返回 true。');
            L.push('   说明它会采信宿主（或其它插件）的模态态。');
            L.push('   而 psTryRead 的第 ① 分支正是靠它判断能否直接读 —— 于是裸 get 发生。');
        }
        L.push('');

        L.push('----- 结论 2：采样间隔有没有缺口（UXP 定时器是否被冻结） -----');
        if (gaps.length === 0) {
            L.push('未检出 >' + (SAMPLE_MS * GAP_FACTOR) + 'ms 的间隔缺口，定时器全程正常推进。');
        } else {
            L.push('检出 ' + gaps.length + ' 处间隔缺口：');
            for (let i = 0; i < gaps.length && i < 12; i++) {
                const g = gaps[i];
                L.push('  ' + clockOf(t0, g.from) + ' ~ ' + clockOf(t0, g.to)
                    + '   缺口 ' + g.gap + ' ms');
            }
            if (gaps.length > 12) L.push('  ...（其余 ' + (gaps.length - 12) + ' 处省略）');
            L.push('');
            L.push('=> 这些时刻 UXP 的定时器被卡住。若与上面 isModal=true 的区间重合，');
            L.push('   说明宿主模态不仅让 isModal 撒谎，还让插件自己的计时/轮询一起停摆 ——');
            L.push('   这会同时破坏「事件静默窗口」与「闩锁探针」，是一条独立的弹框成因。');
        }
        L.push('');

        L.push('----- 结论 3：isModal=true 时，插件闸门的状态 -----');
        if (trueCount === 0) {
            L.push('（本项无样本）');
        } else {
            L.push('  闸门拦住了（isPsBusy=true）  : ' + tBusy + ' / ' + trueCount);
            L.push('  闸门没拦住（isPsBusy=false）: ' + tFree + ' / ' + trueCount);
            L.push('  其中文档闩锁生效（latch=true） : ' + tLatch);
            L.push('  其中同步租约有效（lease=true） : ' + tLease);
            if (tFree > 0) {
                L.push('');
                L.push('=> 「闸门放行 + isModal 撒谎」同时成立，这正是裸 get 被执行的组合。');
                L.push('   修复方向：不再采信 core.isModal()，改为插件自己记账（ownModalDepth）。');
            }
        }
        L.push('');
        L.push('===== 报告结束 =====');
        return L.join('\r\n');
    }

    // 延迟启动：先让面板完成首次渲染，避免与插件的启动流程抢时序。
    setTimeout(function () {
        try {
            core.showAlert({
                message: '【诊断探针 已启动】\n\n'
                    + '接下来 90 秒内，请做这件事：\n'
                    + '   1. 菜单：文件 → 另存为…\n'
                    + '   2. 停在那个对话框上约 10 秒\n'
                    + '   3. 点「取消」把它关掉\n\n'
                    + '（如果你还想复现原来的问题，可以顺便删一个图层）\n\n'
                    + '检测到你开过一次对话框后，约 5 秒就会自动弹出结果。'
            });
        } catch (_) { /* ignore */ }

        t0 = Date.now();
        timer = setInterval(tick, SAMPLE_MS);
    }, BOOT_DELAY_MS);
}
