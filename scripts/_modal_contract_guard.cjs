#!/usr/bin/env node
/**
 * 模态作用域静态契约守卫（2026-10-09）
 * ============================================================================
 * 目的：把「runAsModal 三件套缺陷」钉成机器可校验的契约，防止回归。
 * 用法：node scripts/_modal_contract_guard.cjs     （全部通过 exit 0，否则 exit 1）
 *
 * 覆盖的缺陷（均来自 2026-10-09 真机报障）：
 *   G1 runAsModal 把可能为 undefined 的 opts 无条件传作第二实参
 *      ⇒ UXP 抛 "Argument 2 has an invalid type. Expected type: object actual type: undefined"
 *      ⇒ 所有「不传 opts」的调用点（描边 8 处 / 取前景色 2 处 / 特殊木刻 1 处）全挂。
 *   G2 add/remove 各调用一次 wrapDocLevelLogger，拿到**不同**的闭包
 *      ⇒ removeNotificationListener 按引用找不到目标 ⇒ 注销失败 + 监听器泄漏。
 *   G3 智能对象转换事件名（newPlacedLayer）未注册 ⇒ 该重命令全程无闸门。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let failures = [];
function check(name, ok, detail) {
    console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : '  ← ' + detail}`);
    if (!ok) failures.push(name);
}

function walk(d, out = []) {
    for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(n)) out.push(p);
    }
    return out;
}

/** 逐字符扫描一次调用的实参个数（顶层逗号 + 1）。 */
function countArgs(src, openParenIdx) {
    let depth = 0, str = null, esc = false, line = false, block = false;
    for (let j = openParenIdx; j < src.length; j++) {
        const c = src[j], c2 = src[j + 1];
        if (line) { if (c === '\n') line = false; continue; }
        if (block) { if (c === '*' && c2 === '/') { block = false; j++; } continue; }
        if (str) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === str) str = null; continue; }
        if (c === '/' && c2 === '/') { line = true; j++; continue; }
        if (c === '/' && c2 === '*') { block = true; j++; continue; }
        if (c === "'" || c === '"' || c === '`') { str = c; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return { end: j }; }
    }
    return null;
}

function topLevelCommas(src, from, to) {
    let d = 0, str = null, esc = false, line = false, block = false, n = 0;
    for (let k = from; k < to; k++) {
        const c = src[k], c2 = src[k + 1];
        if (line) { if (c === '\n') line = false; continue; }
        if (block) { if (c === '*' && c2 === '/') { block = false; k++; } continue; }
        if (str) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === str) str = null; continue; }
        if (c === '/' && c2 === '/') { line = true; k++; continue; }
        if (c === '/' && c2 === '*') { block = true; k++; continue; }
        if (c === "'" || c === '"' || c === '`') { str = c; continue; }
        if (c === '(' || c === '[' || c === '{') d++;
        else if (c === ')' || c === ']' || c === '}') d--;
        else if (c === ',' && d === 0) n++;
    }
    return n;
}

/* ---------------- G1：所有模态入口调用点都必须显式传 opts ---------------- */
const CALLEE = /(?:^|[^\w.])(executeAsModal|runAsModal)\s*\(/g;
let offenders = [];
let total = 0;
for (const f of walk(SRC)) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split(/\r?\n/);
    CALLEE.lastIndex = 0;
    let m;
    while ((m = CALLEE.exec(src))) {
        const lineNo = src.slice(0, m.index).split('\n').length;
        const raw = lines[lineNo - 1] || '';
        const trimmed = raw.trim();
        // 跳过注释行与函数定义行
        if (/^(\*|\/\/|\/\*)/.test(trimmed)) continue;
        if (/function\s+(runAsModal|executeAsModal)\s*$/.test(trimmed)) continue;
        const open = CALLEE.lastIndex - 1;
        const r = countArgs(src, open);
        if (!r) continue;
        total++;
        const args = topLevelCommas(src, open + 1, r.end) + 1;
        if (args < 2) offenders.push(`${f.replace(ROOT + path.sep, '').replace(/\\/g, '/')}:${lineNo}`);
    }
}
// ⚠️ 「调用点不传 opts」本身**合法**（executeAsModal 的 opts 是可选的），
//    它不是缺陷 —— 缺陷在**实现**（G1-B：无条件把 undefined 转发下去）。
//    这里只打印清单做「知情登记」，不判失败。
console.log(
    `ℹ️  G1-A 知情清单：${total} 个模态入口调用点，其中 ${offenders.length} 个不传 opts ` +
    `（必须由 runAsModal 的 undefined 容忍性兜住，见 G1-B）`
);
if (offenders.length) console.log(`       ${offenders.join(', ')}`);

const psAccess = fs.readFileSync(path.join(SRC, 'utils', 'psAccess.ts'), 'utf8');
check(
    'G1-B runAsModal 实现按 opts 存在与否**分岔**调用（不得无条件转发 opts）',
    /opts\s*==\s*null/.test(psAccess) &&
    !/\}\s*,\s*opts\s+as\s+any\s*\)/.test(psAccess),
    'psAccess.runAsModal 仍把 opts 无条件作为第二实参'
);

/* ---------------- G2：通知包装器必须按 handler 记忆化 ---------------- */
check(
    'G2-A wrapDocLevelLogger 使用 WeakMap 记忆化（add/remove 拿到同一引用）',
    /WeakMap/.test(psAccess) && /docLevelWrapperCache/.test(psAccess),
    '包装器未记忆化 ⇒ removeNotificationListener 找不到目标'
);
check(
    'G2-B add / remove 都经由 wrapDocLevelLogger（唯一事实来源）',
    /const wrapped = wrapDocLevelLogger\(handler\)/.test(psAccess),
    'add 或 remove 未走同一包装器入口'
);

/* ---------------- G3：智能对象事件名必须注册并分类 ---------------- */
const psProbe = fs.readFileSync(path.join(SRC, 'utils', 'psProbe.ts'), 'utf8');
check(
    "G3-A PS_NOTIF_EVENTS 注册了 PLACED_LAYER_EVENTS（含 'newPlacedLayer'）",
    /\.\.\.PLACED_LAYER_EVENTS/.test(psAccess) && /'newPlacedLayer'/.test(psProbe),
    '智能对象事件名未注册 ⇒ 该重命令全程无闸门'
);
check(
    'G3-B markPsBusyForEvent 对置入图层类事件按文档级处理（beginDocLatch）',
    /isPlacedLayerEvent\(eventName\)/.test(psProbe) &&
    /isPlacedLayerEvent\(eventName\)[\s\S]{0,400}?beginDocLatch\(\)/.test(psProbe),
    '置入图层类事件未开闩锁'
);

console.log('');
if (failures.length) {
    console.error(`❌ 模态契约守卫未通过：${failures.length} 项`);
    process.exit(1);
}
console.log('✅ 模态契约守卫全部通过');
