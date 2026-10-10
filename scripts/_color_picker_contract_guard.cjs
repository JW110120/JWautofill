#!/usr/bin/env node
/**
 * 拾色器契约守卫（JWautofill）
 * ---------------------------------------------------------------------------
 * 背景（2026-10-09 用户报障）：灰色显示态（清除模式 / 图层蒙版 / 快速蒙版 /
 * 单通道）下，描边色板把「灰色显示色」当成了 PS 原生拾色器的**初始值**
 * （`pickColorWithInitial(this.getStrokeDisplayColor())`）。后果是连踩两坑：
 *   ① 拾色器一打开就显示灰（#b34d4d → #6b6b6b）；
 *   ② 用户确认后把灰度 setState 回 strokeColor ⇒ 真实色被永久覆盖，
 *      退出灰色态也恢复不了（灰色态本应只影响显示）。
 *
 * 铁律：**灰色态只影响显示**。PS 原生拾色器（`pickColorWithInitial`）永远在
 * 「真实色空间」工作 ⇒ 初值必须是真实色（strokeColor / stop.color），
 * 绝不能是任何「显示色」（getStrokeDisplayColor / getDisplayColorHex …）。
 *
 * 断言：
 *   G1  无 `pickColorWithInitial(getStrokeDisplayColor(...))` 形状（全仓 src）；
 *   G2  `getStrokeDisplayColor` 的代码引用点只允许「定义行 + 预览样式读取」；
 *   G3  两个调用点的初值正确且调用点总数稳定（app=1, gradient=1）。
 *
 * 用法：`node scripts/_color_picker_contract_guard.cjs`（从仓库根运行）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
let failed = 0;
function check(name, ok, detail) {
    if (ok) {
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`);
    }
}

/** 去掉 // 行注释与 /* *\/ 块注释（避免注释里的类名造成误报）。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const read = f => stripComments(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
const APP = path.join(ROOT, 'src', 'app.tsx');
const GRAD = path.join(ROOT, 'src', 'components', 'GradientPicker.tsx');

const app = read(APP);
const grad = read(GRAD);

console.log('=== 拾色器契约守卫 ===');

// ---- G1: 禁止把「灰色显示色」当拾色器初值 ---------------------------------
(function G1() {
    const files = [];
    (function walk(d) {
        for (const n of fs.readdirSync(d)) {
            const p = path.join(d, n);
            const s = fs.statSync(p);
            if (s.isDirectory()) walk(p);
            else if (/\.tsx?$/.test(n)) files.push(p);
        }
    })(path.join(ROOT, 'src'));

    const offenders = [];
    for (const f of files) {
        const src = read(f);
        const re = /pickColorWithInitial\s*\(/g;
        let m;
        while ((m = re.exec(src))) {
            const window = src.slice(m.index, m.index + 220);
            if (/getStrokeDisplayColor/.test(window)) {
                const line = src.slice(0, m.index).split('\n').length;
                offenders.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${line}`);
            }
        }
    }
    check('G1 无「用灰色显示色当拾色器初值」的调用点', offenders.length === 0, offenders.join(', '));
})();

// ---- G2: getStrokeDisplayColor 只用于「显示」------------------------------
(function G2() {
    const lines = app.split('\n');
    const refs = [];
    lines.forEach((ln, i) => {
        if (/getStrokeDisplayColor/.test(ln)) refs.push({ n: i + 1, text: ln.trim() });
    });
    const illegal = refs.filter(r => {
        const isDef = /^getStrokeDisplayColor\s*\(\s*\)\s*\{/.test(r.text);
        const isDisplay = /=\s*this\.getStrokeDisplayColor\(\s*\)\s*;?$/.test(r.text);
        return !isDef && !isDisplay;
    });
    check(`G2 getStrokeDisplayColor 的引用全为显示用途（共 ${refs.length} 处）`,
        illegal.length === 0, illegal.map(r => `${r.n}: ${r.text}`).join(' | '));
})();

// ---- G3: 调用点就位（描边板真实色 / 渐变板真实色）-------------------------
(function G3() {
    const appCalls = (app.match(/pickColorWithInitial\s*\(/g) || []).length;
    const gradCalls = (grad.match(/pickColorWithInitial\s*\(/g) || []).length;

    const strokeOk = /openStrokeColorPicker[\s\S]{0,900}?pickColorWithInitial\(\s*initial\b/.test(app)
        && /const \{ strokeColor \} = this\.state;/.test(app);
    const gradOk = /pickColorWithInitial\(\s*\n?\s*parseCssRgb\(stop\.color\)/.test(grad);

    check(`G3-a 描边板拾色器初值 = 真实色 strokeColor`, strokeOk);
    check(`G3-b 渐变板拾色器初值 = parseCssRgb(stop.color)`, gradOk);
    check('G3-c 拾色器调用点总数稳定（app=1, gradient=1）', appCalls === 1 && gradCalls === 1,
        `app=${appCalls}, gradient=${gradCalls}`);
})();

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
