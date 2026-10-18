/**
 * 套索平滑「总开关」的用户意图持久化（settings/smooth-enabled.json）。
 *
 * 背景（2026-10-17 用户要求「套索平滑开关状态需要持久化」）：
 * 平滑的开关意图此前的唯一载体是 LassoSmoothing.ts 的模块级 `penOn`（初值 false），
 * 虽然能靠 .8li 回帧的 `pen.enabled` 反推，但那个值只活在同一次 PS 会话里 ——
 * PS 重启后 .8li 的 `g_pen.enabled` 归零，面板开关就自己弹回「关」。
 * 而 smoothParams（强度/半径/模式等）早已随 panel-state.json 落盘，于是出现
 * 「参数都还在、开关自己关了」的割裂观感。
 *
 * 设计（与 hotkey-arm.json 完全同款，放在同一个 settings 目录）：
 *   · setPenSmooth() 每次被调用都把**用户意图**落盘（同值不写，避免 I/O）；
 *   · 面板把 state 恢复完之后调 restorePersistedPenSmooth()，若持久值为 true
 *     且当前未打开，就按持久值重新开一次（未连接也安全：penOn 会被记住，
 *     WS 建连后 resendLassoSmoothing 自动重放）；
 *   · 文件缺失 / 损坏 = 用户没表过态 ⇒ 保持原有「默认关」行为，不擅自打开。
 */

import { storage } from 'uxp';

const FILE_NAME = 'smooth-enabled.json';

/** 内存镜像：null = 尚未落过盘（此时沿用「默认关」） */
let persisted: boolean | null = null;
let loaded = false;
/** 串行写链：开关点按与回帧可能并发，避免 read-modify-write 交错 */
let writeChain: Promise<unknown> = Promise.resolve();

function formats(): string {
  return (storage as any).formats?.utf8 ?? 'utf8';
}

async function getFolder(): Promise<any> {
  const dataFolder: any = await storage.localFileSystem.getDataFolder();
  try {
    return await dataFolder.getEntry('settings');
  } catch {
    return await dataFolder.createFolder('settings');
  }
}

/** 读一次持久值（模块级缓存，重复调用无 I/O）。缺失/损坏返回 null。 */
export async function loadPersistedSmoothOn(): Promise<boolean | null> {
  if (loaded) return persisted;
  try {
    const folder = await getFolder();
    const entry: any = await folder.getEntry(FILE_NAME);
    if (entry && !entry.isFolder) {
      const text = await entry.read({ format: formats() });
      if (text && text.trim()) {
        const j = JSON.parse(text);
        if (j && typeof j.enabled === 'boolean') persisted = j.enabled;
      }
    }
  } catch { /* 不存在 / 损坏：当作无持久值 */ }
  loaded = true;
  return persisted;
}

/** 同步 peek（供「先渲染一帧」的场合）；未读过返回 null。 */
export function peekPersistedSmoothOn(): boolean | null {
  return persisted;
}

/** 把开关意图落盘（异步串行；写失败只告警，内存值仍驱动本次会话）。 */
export function persistSmoothOn(on: boolean): Promise<void> {
  const run = writeChain.then(async () => {
    if (persisted === on) return;
    persisted = on;
    loaded = true;
    try {
      const folder = await getFolder();
      const file = await folder.createFile(FILE_NAME, { overwrite: true });
      await file.write(JSON.stringify({ enabled: on, ts: Date.now() }), { format: formats() });
    } catch (e) {
      console.warn('⚠️ 套索平滑开关落盘失败（本次会话仍按新状态生效）:', e);
    }
  });
  writeChain = run.then(() => {}, () => {});
  return run;
}
