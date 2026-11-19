#!/usr/bin/env node
/**
 * 读 UXP 插件的落地日志（trace-first debugging 的配套工具）。
 *
 *   node .workbuddy/skills/uxp-debug-trace/scripts/trace-tail.mjs
 *   node .workbuddy/skills/uxp-debug-trace/scripts/trace-tail.mjs --plugin com.listen2me.jwautofill --lines 200
 *   node .workbuddy/skills/uxp-debug-trace/scripts/trace-tail.mjs --channel special-mask --list
 *
 * 会自动在 `<APPDATA>/Adobe/UXP/PluginsStorage/PHSP/<版本>/<External|Developer>/<plugin>/PluginData/debug/`
 * 里找最新的日志，并比对 `dist/bundle.js` 的 mtime —— 若产物比日志还新，说明覆盖后还没重启 PS，
 * 日志里是旧代码的行为（这是最容易白分析一次的地方）。
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const hasFlag = (name) => args.includes(`--${name}`);

const pluginId = arg('plugin', 'com.listen2me.jwautofill');
const channel = arg('channel', null);
const lines = Number(arg('lines', '60')) || 60;
const repo = path.resolve(arg('repo', process.cwd()));
const psVersion = arg('ps', null);

const appData =
  process.env.APPDATA ||
  path.join(os.homedir(), 'AppData', 'Roaming');
const storageRoot = path.join(appData, 'Adobe', 'UXP', 'PluginsStorage', 'PHSP');

async function listDirs(p) {
  try {
    const items = await readdir(p, { withFileTypes: true });
    return items.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

async function collect() {
  const found = [];
  const versions = psVersion ? [psVersion] : await listDirs(storageRoot);
  for (const ver of versions) {
    const verDir = path.join(storageRoot, ver);
    for (const scope of ['External', 'Developer']) {
      const dbg = path.join(verDir, scope, pluginId, 'PluginData', 'debug');
      let files = [];
      try {
        files = await readdir(dbg);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.log')) continue;
        if (channel && !f.includes(channel)) continue;
        const full = path.join(dbg, f);
        try {
          const st = await stat(full);
          found.push({ path: full, size: st.size, mtime: st.mtime });
        } catch { /* 读不到就跳过 */ }
      }
    }
  }
  return found;
}

const fmtTime = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

async function main() {
  const files = await collect();

  if (files.length === 0) {
    console.log(`未找到日志。搜索根目录：${storageRoot}`);
    console.log(`期望位置形如：PHSP\\27\\External\\${pluginId}\\PluginData\\debug\\*.log`);
    console.log('若插件还没铺过日志（或本轮改动前没有 trace），先按模板加 smLog 再复测。');
    return;
  }

  files.sort((a, b) => b.mtime - a.mtime);

  if (hasFlag('list')) {
    console.log('候选日志（按 mtime 倒序）：');
    for (const f of files) {
      console.log(`  ${fmtTime(f.mtime)}  ${String(f.size).padStart(7)}B  ${f.path}`);
    }
    return;
  }

  const target = files[0];
  console.log(`日志文件：${target.path}`);
  console.log(`大小：${target.size}B   最后写入：${fmtTime(target.mtime)}`);

  // 产物时间核对：bundle 比日志新 ⇒ 覆盖后没重启 PS，日志是旧代码行为
  try {
    const bundle = path.join(repo, 'dist', 'bundle.js');
    const bs = await stat(bundle);
    console.log(`产物时间：${fmtTime(bs.mtime)}   ${bundle}`);
    if (bs.mtime > target.mtime) {
      console.log('⚠️  产物比日志新：说明 bundle 覆盖之后还没重启 PS / 还没复测。');
      console.log('    先完全退出 Photoshop 再启动并复现一次，否则日志里是旧代码的行为。');
    }
  } catch {
    /* 没有 dist/bundle.js 就不比对 */
  }

  const text = await readFile(target.path, 'utf8');
  const all = text.split('\n').filter((l) => l.length > 0);
  const tail = all.slice(Math.max(0, all.length - lines));
  console.log(`--- 最近 ${tail.length} / ${all.length} 行 ---`);
  console.log(tail.join('\n'));
}

main().catch((e) => {
  console.error('读日志失败：', e);
  process.exitCode = 1;
});
