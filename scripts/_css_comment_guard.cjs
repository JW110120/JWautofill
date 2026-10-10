/*
 * 一次性 CSS 注释结构守卫（2026-10-08）。
 * 铁律：CSS 注释块外的游离文本会被当成选择器，静默吃掉紧随其后的整条规则。
 * 本脚本对 src/styles/*.css 做逐字符扫描，检查：
 *   ① 注释开 / 闭配对（文件结束时仍在注释内 ⇒ 报错）；
 *   ② 注释体内出现字面 "/*"（作者想在注释里写它，实际会开启嵌套 ⇒ 提前闭合）；
 *   ③ 注释体外出现字面 "*​/"（无对应开 ⇒ 游离文本）；
 *   ④ 大括号配对。
 * 用法：node scripts/_css_comment_guard.cjs     （全部通过 exit 0，否则 exit 1）
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'styles');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));

let bad = 0;
for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const errors = [];
    let i = 0;
    let inComment = false;
    let commentStart = 0;
    let depth = 0;
    let line = 1;
    let commentLine = 1;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === '\n') line++;
        if (!inComment) {
            if (c === '/' && n === '*') {
                inComment = true;
                commentStart = i;
                commentLine = line;
                i += 2;
                continue;
            }
            if (c === '*' && n === '/') {
                errors.push(`第 ${line} 行：注释体外出现「*/」（无对应开 → 游离文本）`);
                i += 2;
                continue;
            }
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth < 0) {
                    errors.push(`第 ${line} 行：多余「}」`);
                    depth = 0;
                }
            }
        } else {
            if (c === '/' && n === '*') {
                errors.push(`第 ${commentLine} 行起的注释体内出现「/*」（嵌套开启符 → 会提前闭合注释）`);
                i += 2;
                continue;
            }
            if (c === '*' && n === '/') {
                inComment = false;
                i += 2;
                continue;
            }
        }
        i++;
    }
    if (inComment) errors.push(`第 ${commentLine} 行起的注释未闭合（文件结束时仍在注释内）`);
    if (depth !== 0) errors.push(`大括号不配对（结束时 depth=${depth}）`);
    if (errors.length) {
        bad++;
        console.log(`\n[NG] ${f}`);
        errors.forEach((e) => console.log('   - ' + e));
    }
}
console.log(bad === 0 ? `\n[OK] ${files.length} 个 CSS 文件：注释配对 / 括号配对全部通过` : `\n${bad} 个文件有问题`);
process.exit(bad === 0 ? 0 : 1);
