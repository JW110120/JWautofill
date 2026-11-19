/**
 * 「特殊蒙版」收尾链路的落地日志（debug/special-mask.log）。
 *
 * 为什么需要它：这条链路有 5 个都会「静默失败」的宿主动作（读像素 / 写像素 /
 * 删图层 / 选中图层 / 建剪贴）。任何一个被宿主拒绝，JS 侧最多只有一条
 * `console.warn` —— 而 UXP 的控制台不在用户眼前，用户只能看到「结果不对」
 * （没约束、没箭头、图层数不对），却拿不到「哪一步判了什么」。
 * 于是把每一步的**判据 + 返回值 + 回读结果**写进插件数据目录的文本文件，
 * 出问题时直接读文件定位，不用靠猜。
 *
 * ⛔ 写日志绝不允许连累填充：全部 try/catch 吞掉，写失败等于没写。
 * ⛔ 串行写链：多次填充的日志按顺序落地，不互相覆盖。
 * ✅ 系统要求：内置日志（console.log）**照旧打一份**，用 UXP 调试器时也能看到。
 */

import { storage } from 'uxp';

const FOLDER_NAME = 'debug';
const FILE_NAME = 'special-mask.log';
/** 只保留最近这么多字符，避免日志无限膨胀。 */
const MAX_CHARS = 30000;

let chain: Promise<unknown> = Promise.resolve();
/** 本次会话是否已经写过「分割线」，便于把相邻多次填充的日志分开。 */
let sessionHeaderWritten = false;

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

function formats(): string {
    return (storage as any).formats?.utf8 ?? 'utf8';
}

async function appendLine(line: string): Promise<void> {
    try {
        const dataFolder: any = await storage.localFileSystem.getDataFolder();
        let folder: any;
        try {
            folder = await dataFolder.getEntry(FOLDER_NAME);
        } catch {
            folder = await dataFolder.createFolder(FOLDER_NAME);
        }
        let file: any;
        try {
            file = await folder.getEntry(FILE_NAME);
        } catch {
            file = await folder.createFile(FILE_NAME, { overwrite: true });
        }

        let prev = '';
        try {
            prev = await file.read({ format: formats() });
        } catch { /* 首次写入 / 读失败 ⇒ 当作空文件 */ }

        let next = `${prev || ''}${line}\n`;
        if (next.length > MAX_CHARS) next = next.slice(next.length - MAX_CHARS);
        await file.write(next, { format: formats() });
    } catch {
        /* 日志写不进去不影响任何业务逻辑 */
    }
}

/** 记一行日志（永不抛错、永不阻塞调用方）。 */
export function smLog(...parts: unknown[]): void {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const body = parts.map(fmtValue).join(' | ');
    const line = `[${stamp}] ${body}`;
    try {
        // eslint-disable-next-line no-console
        console.log('[SM]', body);
    } catch { /* 忽略 */ }
    chain = chain.then(() => appendLine(line)).catch(() => { /* 忽略 */ });
}

/** 一次填充开始时打一条分割线（同一次会话里多次填充的首行不同，便于对照时间）。 */
export function smLogSession(title: string, payload?: Record<string, unknown>): void {
    if (!sessionHeaderWritten) {
        sessionHeaderWritten = true;
        smLog('================ 新会话 ================');
    }
    smLog(`---- ${title} ----`, payload ?? {});
}
