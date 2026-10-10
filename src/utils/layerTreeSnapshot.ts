import { app } from 'photoshop';
import { isPsBusy } from './psProbe';
import { markPsAccess, psTryRead } from './psAccess';

/**
 * 图层树共享快照（Layer Tree Snapshot）
 * ============================================================================
 * 为什么存在
 * ----------------------------------------------------------------------------
 * UXP 的 `layer.id` / `layer.name` / `layer.kind` / `layer.layers` /
 * `layer.isBackgroundLayer` 每读一次都是一次**向宿主的同步 IPC `get`**。
 * 因此「遍历一棵 N 层图层的树」的成本 ≈ 5N 次 IPC，是本插件里最贵的
 * 主线程操作之一（N=500 ⇒ 2500 次同步往返）。
 *
 * 优化前，同一时刻有**三处独立实现**的全树遍历在跑：
 *   ① MaskSyncEngine.docSignature()            —— 2s 兜底轮询，无条件执行
 *   ② AdjustmentPanel 的 scheduleStructureProbe —— 每次 PS 通知
 *   ③ AdjustmentPanel 的 refreshLineReferenceOptions —— 每次 PS 通知
 * 三者读的是同一棵树、算的是同一类哈希，却各走一遍 ⇒ 一次用户操作
 * 可能触发 1500~5000 次同步 IPC，主线程被占满，折叠标题的 click 只能排队，
 * 表现为「展开/折叠点击无响应」。
 *
 * 本模块的职责：**把「读一次树」变成「全插件读一次」**。
 *   · 一次遍历同时产出「结构签名」+「扁平条目表」，两类消费者共用；
 *   · 带 dirty 标记，PS 通知只需 invalidate()，不必各自重读；
 *   · 带 maxAge 复用，兜底轮询在结构大概率未变时直接吃缓存，不再遍历。
 *
 * ⚠️ 调用方硬约束（与 psProbe 的铁律同源，务必遵守）
 * ----------------------------------------------------------------------------
 * 本模块的所有读取函数都会向宿主发 get，因此**绝不能在 PS 通知回调里直接调用**
 * （通知在命令执行【中途】派发，此刻文档正忙，宿主会弹「悦绘: 命令"获取"当前不可用」，
 *  该原生弹框绕过 JS try/catch 与 dialogOptions，唯一有效防护就是「不发 get」）。
 * 正确用法一律是：通知回调里只调 `invalidateLayerSnapshot()`（纯内存标记，零 IPC），
 * 真正读取交给 `debouncePsProbe` / `runWhenIdle` / 定时器等空闲时机。
 *
 * ⚠️⚠️ 第三轮（2026-10-08 真机「打开 400MB PSD 必弹框」之后）——**两个入口，别用错**：
 *   · `refreshLayerSnapshot()`（async，**默认选它**）：遍历在 `executeAsModal` 模态
 *     作用域内执行 ⇒ 宿主忙碌时最坏也只是「返回旧缓存/拿不到」，**永不弹框**。
 *     事件驱动与轮询驱动的消费方一律用它。
 *   · `getLayerSnapshot()`（sync）：**纯读缓存，零 IPC**（2026-10-09 起彻底删除了
 *     同步遍历路径，见函数注释）。只给 React 渲染/同步决策用，**不要**指望它把
 *     新数据读进来。
 *   ⇒ 原因：同步遍历是**裸 get**，且是**乘法放大器**（一棵 16 层的树 = 80 次宿主
 *     往返）。任何「猜它忙不忙」的判断一旦错，代价不是旧数据而是一屏原生弹框
 *     （用户实测「连点八下」+ 2026-10-09「删一个图层即弹框」）。
 */

/** 快照中的单个图层条目（扁平化，按文档顺序的先序遍历）。 */
export interface LayerSnapshotEntry {
  id: number;
  name: string;
  kind: string;
  depth: number;
  /** 是否为背景图层（只有 RGB 三通道，无 A）。 */
  isBackground: boolean;
  /** 是否有子图层（图层组）。 */
  hasChildren: boolean;
  /** 从文档根到本层的 id 路径（含自身），用于按路径重解析引用。 */
  path: number[];
}

export interface LayerSnapshot {
  docId: number | null;
  docName: string;
  /**
   * 结构签名：FNV-1a，覆盖 **先序遍历顺序 + id + kind + name + depth**。
   * 顺序参与哈希 ⇒ 移动图层（顺序变而集合不变）也能被识别。
   * ⚠️ 与旧实现（栈式 pop 遍历）哈希值不同，但签名只在会话内自比较，
   *    不做持久化，故无兼容问题。
   */
  signature: string;
  entries: LayerSnapshotEntry[];
  /** 条目总数（含组）。 */
  count: number;
  /** 快照生成时刻（Date.now()），供 maxAge 复用判断。 */
  at: number;
}

let cached: LayerSnapshot | null = null;
/** 结构可能已变化：true 时下次 getLayerSnapshot() 必须重新遍历。 */
let dirty = true;

const FNV_OFFSET = 2166136261 >>> 0;
const FNV_PRIME = 16777619;

/**
 * 标记图层结构可能已变化（纯内存操作，**不发任何 IPC**，可在通知回调里安全调用）。
 *
 * 只需在会改变图层结构的 PS 通知（make / delete / set / rename / move）到达时调用。
 * 「下一次真正读取时」才会重遍历，因此连续事件不会造成 N 次遍历。
 */
export function invalidateLayerSnapshot(): void {
  dirty = true;
}

/** 仅供测试/调试：丢弃缓存（不主动遍历）。 */
export function resetLayerSnapshotCache(): void {
  cached = null;
  dirty = true;
}

/**
 * 当前快照是否已被标记为「脏」（结构可能变了）。
 *
 * 纯内存查询（零 IPC），可在通知回调 / 防抖探测里安全使用。
 * 典型用法：防抖到期后先问一句「有人 invalidate 吗？」，没有就直接跳过
 * 整轮刷新 —— 省掉「为了确认没变化而做一次全树遍历」这种反向开销。
 */
export function isLayerSnapshotDirty(): boolean {
  return dirty || cached === null;
}

/**
 * 读取图层树快照缓存（**纯内存，永不发 get**）。
 *
 * ⚠️⚠️ 2026-10-09 起本函数**不再有任何遍历路径**（原先那条「持有宿主可读租约时
 * 同步遍历」已删除）。原因是一条明确的乘法关系：
 *
 *   · 同步遍历是**裸 get**，一棵 N 层的树 = 5N 次宿主往返（N=16 ⇒ 80 次）；
 *   · 判据无论多保守，它终究是「猜」或「租约」这类**间接**证据；
 *   · 一旦判错，代价不是「读到旧数据」，而是**一屏宿主原生弹框** —— 因为 5N 次
 *     get 里有任意一次撞上宿主模态作用域，就会弹一个「命令"获取"当前不可用」。
 *
 * 真机取证（`src/utils/isModalProbe.ts`）已证实：`isModal()` 会在宿主忙碌时误报
 * true，而这套「间接证据」体系里至少有一环会因此放行 ⇒ 只要遍历路径还在，弹框
 * 就还有出口。因此把**放大器本身**拆掉：上游判据最坏也只是「数据旧」，不再可能
 * 变成「一屏弹框」。需要新数据一律走 `refreshLayerSnapshot()`（模态作用域内遍历，
 * 永不弹框）。
 *
 * @param maxAgeMs 若给定，且现有快照的年龄小于该值，则顺带把 dirty 标记清掉
 *                 （表示「这轮不再需要遍历」，供兜底轮询使用）。
 * @returns 当前缓存（可能为 `null`，表示还没有任何可用快照）；调用方需自行降级。
 */
export function getLayerSnapshot(maxAgeMs = 0): LayerSnapshot | null {
  if (cached && !dirty) return cached;
  if (cached && maxAgeMs > 0 && Date.now() - cached.at < maxAgeMs) {
    // 轮询兜底窗口内直接复用：省掉整轮遍历。
    // ⚠️ 这会让轮询在结构变化后最多延迟 maxAgeMs 才被发现——这正是轮询作为
    //    「兜底」的定位：真正的时效性由事件驱动的 invalidate + 精确读取保证。
    dirty = false;
    return cached;
  }
  // 结构已被标记为脏（或还没有快照）⇒ 如实返回旧的缓存值，
  // 由调用方在下一个空闲窗口走 `refreshLayerSnapshot()` 取新数据。
  return cached;
}

/**
 * **受保护**的图层树刷新：遍历在 `executeAsModal` 模态作用域内执行。
 *
 * 这是所有「由事件/轮询驱动」的消费方唯一该用的入口：
 *   · 宿主空闲 ⇒ 立即拿到新快照；
 *   · 宿主忙碌（打开/关闭/保存大文档…）⇒ `psRead` 返回失败 ⇒ **保持旧缓存**，
 *     等下一次事件/轮询再来。全程不会向宿主发出一次裸 get。
 *
 * @param maxAgeMs 同 `getLayerSnapshot`：缓存足够新则直接复用，零 IPC。
 */
export async function refreshLayerSnapshot(maxAgeMs = 0): Promise<LayerSnapshot | null> {
  const now = Date.now();
  if (cached && !dirty) return cached;
  if (cached && maxAgeMs > 0 && now - cached.at < maxAgeMs) {
    dirty = false;
    return cached;
  }
  if (isPsBusy()) return cached;

  const r = await psTryRead<TraverseResult>(() => traverseNow(now, '遍历图层树（受保护）'),
    { label: '读取图层树', retries: 0 });
  // 读取失败（宿主忙碌 / 模态被拒）⇒ 保持旧缓存，绝不把「读不到」当成「树是空的」。
  if (!r.ok) return cached;
  return commit(r.value);
}

/** 遍历结果：区分「读到」/「没有活动文档」/「读失败」——三者语义完全不同。 */
type TraverseResult =
  | { kind: 'ok'; snap: LayerSnapshot }
  | { kind: 'none' }
  | { kind: 'fail' };

/** 把一次遍历结果落进缓存。`fail` 一律保持原状（宁可陈旧，也不清空）。 */
function commit(r: TraverseResult): LayerSnapshot | null {
  if (!r || r.kind === 'fail') return cached;
  if (r.kind === 'none') {
    cached = null;
    dirty = false;
    return null;
  }
  cached = r.snap;
  dirty = false;
  return cached;
}

/**
 * 真正发 get 的遍历本体（纯读取，不碰缓存）。
 *
 * ⚠️ 调用方负责保证它只在**安全时机**被执行：**唯一**合法路径是包在
 * `psTryRead` 里（`refreshLayerSnapshot` 已如此）。**本函数自身不做任何忙碌判断**
 * （它一旦开始，get 就已经在路上了 —— 判断必须发生在进入之前）。
 */
function traverseNow(now: number, markLabel: string): TraverseResult {
  markPsAccess(markLabel);
  let doc: any = null;
  try {
    doc = app.activeDocument;
  } catch {
    return { kind: 'fail' };
  }
  if (!doc) return { kind: 'none' };

  const entries: LayerSnapshotEntry[] = [];
  let h = FNV_OFFSET;
  const mix = (n: number) => {
    h = Math.imul(h ^ (n >>> 0), FNV_PRIME) >>> 0;
  };

  // 递归先序遍历。每层恰好读 5 个属性（id/name/kind/isBackgroundLayer/layers），
  // 与旧实现相比：旧 AdjustmentPanel 探针读 3 次 + 选项构建读 4 次 = 7 次/层，
  // 旧引擎签名读 3 次/层；现在全插件共用这 5 次/层、且只走一遍。
  const walk = (list: any[], depth: number, parentPath: number[]) => {
    for (const layer of list || []) {
      if (!layer) continue;
      const id = layer.id;
      if (typeof id !== 'number') continue;
      const name = layer.name || '';
      const kind = layer.kind || '';
      const isBackground = !!layer.isBackgroundLayer;
      const children = (layer as any)?.layers;
      const hasChildren = !!(children && Array.isArray(children) && children.length > 0);

      const path = parentPath.concat([id]);
      entries.push({ id, name, kind, depth, isBackground, hasChildren, path });

      mix(id);
      mix(depth);
      for (let i = 0; i < kind.length; i++) mix(kind.charCodeAt(i));
      for (let i = 0; i < name.length; i++) mix(name.charCodeAt(i));

      if (hasChildren) walk(children, depth + 1, path);
    }
  };

  try {
    walk(doc.layers || [], 0, []);
  } catch {
    return { kind: 'fail' };
  }

  let docId: number | null = null;
  let docName = '';
  try {
    docId = typeof doc.id === 'number' ? doc.id : null;
    docName = doc.name || '';
  } catch {
    /* 名称读不到不影响结构判定 */
  }

  return {
    kind: 'ok',
    snap: {
      docId,
      docName,
      signature: `${docId ?? 'none'}#${h.toString(36)}`,
      entries,
      count: entries.length,
      at: now,
    },
  };
}

/** 按 id 在快照中查找条目（O(1)，不触发遍历、不发 IPC）。 */
export function findInSnapshot(snap: LayerSnapshot | null, id: number): LayerSnapshotEntry | null {
  if (!snap) return null;
  for (let i = 0; i < snap.entries.length; i++) {
    if (snap.entries[i].id === id) return snap.entries[i];
  }
  return null;
}
