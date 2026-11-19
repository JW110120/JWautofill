/**
 * 落地日志模板（trace-first debugging）—— 复制到 `src/utils/` 后按需改通道名。
 *
 * 设计要点（详见 .workbuddy/skills/uxp-debug-trace/SKILL.md）：
 *  · fire-and-forget：调用方**不 await**，日志写失败不影响任何业务逻辑；
 *  · 串行写链：多次调用的行序不乱；
 *  · 滚动截断：只保留最近 `maxChars`，避免文件无限膨胀；
 *  · 全 try/catch：写日志本身永不让流程崩。
 *
 * 用法：
 *   const trace = createTrace({ channel: 'special-mask' });
 *   trace.session('填充', { mode, plan });
 *   trace.log('交接·①收窄', { ok, boundary, content });
 *
 * 落点：<PluginData>/debug/<channel>.log
 */

import { storage } from 'uxp';

export interface TraceOptions {
    /** 文件名（不含 .log）。不同链路各用一个通道，读日志时不必过滤。 */
    channel?: string;
    /** 保留的最大字符数（默认 30000 ≈ 400 行）。 */
    maxChars?: number;
    /** 同时打一份到 UXP 控制台（调试器开着时方便）。 */
    mirrorToConsole?: boolean;
}

export interface Trace {
    log: (...parts: unknown[]) => void;
    /** 拉一条分割线 + 本次操作的输入快照。 */
    session: (title: string, payload?: Record<string, unknown>) => void;
    /** 日志文件的相对路径（仅用于打印/提示，不保证可读）。 */
    fileName: string;
}

function fmtValue(v: unknown): string {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

function utf8(): string {
    return (storage as any).formats?.utf8 ?? 'utf8';
}

export function createTrace(opts: TraceOptions = {}): Trace {
    const channel = opts.channel ?? 'trace';
    const maxChars = opts.maxChars ?? 30000;
    const mirror = opts.mirrorToConsole ?? true;
    const fileName = `debug/${channel}.log`;

    let chain: Promise<unknown> = Promise.resolve();
    let headerWritten = false;

    async function append(line: string): Promise<void> {
        try {
            const dataFolder: any = await storage.localFileSystem.getDataFolder();
            let folder: any;
            try {
                folder = await dataFolder.getEntry('debug');
            } catch {
                folder = await dataFolder.createFolder('debug');
            }
            let file: any;
            try {
                file = await folder.getEntry(`${channel}.log`);
            } catch {
                file = await folder.createFile(`${channel}.log`, { overwrite: true });
            }
            let prev = '';
            try {
                prev = await file.read({ format: utf8() });
            } catch { /* 首次写入 */ }
            let next = `${prev || ''}${line}\n`;
            if (next.length > maxChars) next = next.slice(next.length - maxChars);
            await file.write(next, { format: utf8() });
        } catch {
            /* 日志写不进去不影响业务 */
        }
    }

    function log(...parts: unknown[]): void {
        const stamp = new Date().toISOString().replace('T', ' ').slice(0, 23);
        const body = parts.map(fmtValue).join(' | ');
        if (mirror) {
            try {
                // eslint-disable-next-line no-console
                console.log(`[${channel}]`, body);
            } catch { /* 忽略 */ }
        }
        chain = chain.then(() => append(`[${stamp}] ${body}`)).catch(() => { /* 忽略 */ });
    }

    function session(title: string, payload: Record<string, unknown> = {}): void {
        if (!headerWritten) {
            headerWritten = true;
            log('================ 新会话 ================');
        }
        log(`---- ${title} ----`, payload);
    }

    return { log, session, fileName };
}
