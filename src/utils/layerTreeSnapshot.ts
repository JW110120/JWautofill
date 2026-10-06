import { app } from 'photoshop';

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
 * （通知在命令执行【中途】派发，此刻文档正忙，宿主会弹「易修: 命令"获取"当前不可用」，
 *  该原生弹框绕过 JS try/catch 与 dialogOptions，唯一有效防护就是「不发 get」）。
 * 正确用法一律是：通知回调里只调 `invalidateLayerSnapshot()`（纯内存标记，零 IPC），
 * 真正读取交给 `debouncePsProbe` / `runWhenIdle` / 定时器等空闲时机。
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
 * 读取图层树快照，必要时重新遍历。
 *
 * @param maxAgeMs 若给定，且现有快照的年龄小于该值，则**直接返回缓存、跳过遍历**。
 *                 用于兜底轮询这类「结构大概率未变」的场合：把稳态轮询的
 *                 遍历成本从「每轮 5N 次 IPC」降到「0 次」。
 *                 传 0 / 不传 ⇒ dirty 时必重新遍历（精确路径）。
 * @returns 快照；无活动文档或读取抛错时返回 null（调用方需自行降级）。
 */
export function getLayerSnapshot(maxAgeMs = 0): LayerSnapshot | null {
  const now = Date.now();
  if (cached && !dirty) return cached;
  if (cached && maxAgeMs > 0 && now - cached.at < maxAgeMs) {
    // 轮询兜底窗口内直接复用：省掉整轮遍历。
    // ⚠️ 这会让轮询在结构变化后最多延迟 maxAgeMs 才被发现——这正是轮询作为
    //    「兜底」的定位：真正的时效性由事件驱动的 invalidate + 精确读取保证。
    dirty = false;
    return cached;
  }

  let doc: any = null;
  try {
    doc = app.activeDocument;
  } catch {
    return null;
  }
  if (!doc) {
    cached = null;
    dirty = false;
    return null;
  }

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
    return null;
  }

  let docId: number | null = null;
  let docName = '';
  try {
    docId = typeof doc.id === 'number' ? doc.id : null;
    docName = doc.name || '';
  } catch {
    /* 名称读不到不影响结构判定 */
  }

  cached = {
    docId,
    docName,
    signature: `${docId ?? 'none'}#${h.toString(36)}`,
    entries,
    count: entries.length,
    at: now,
  };
  dirty = false;
  return cached;
}

/** 按 id 在快照中查找条目（O(1)，不触发遍历、不发 IPC）。 */
export function findInSnapshot(snap: LayerSnapshot | null, id: number): LayerSnapshotEntry | null {
  if (!snap) return null;
  for (let i = 0; i < snap.entries.length; i++) {
    if (snap.entries[i].id === id) return snap.entries[i];
  }
  return null;
}
