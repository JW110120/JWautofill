import { app, action, core, imaging } from 'photoshop';

/**
 * 蒙版同步引擎（MaskSyncEngine）
 *
 * 功能：把一个图层的某个灰度通道（灰阶 / R / G / B / A，可反相）"实时"复制到
 * 另一个图层（或图层组）的图层蒙版上。
 *
 * 同步策略（性能优先、兼顾响应）：
 * 1. 事件驱动 + 防抖：监听 Photoshop 操作通知（set/select/make/delete 等），
 *    操作停止后约 500ms 统一调度一次同步，避免高频操作期间反复读像素。
 * 2. 内容指纹去重：同步时先读取"源通道"与"目标蒙版"像素，逐像素比较；
 *    内容一致则跳过写入，避免无意义写回与写入-通知-再写入的循环。
 * 3. 脏矩形局部写回：仅把差异区域通过 putLayerMask 写回（含 targetBounds），
 *    大幅减少大图局部变化时的写入成本。
 * 4. 低频兜底轮询：每 5 秒用轻量文档签名检查一次活动文档结构是否变化，
 *    覆盖通知遗漏的场景；签名未变不触发像素读取。
 *
 * 持久化：按文档名（doc.name）保存各文档的任务列表，重开同名文档后自动恢复。
 * 图层引用使用"名称路径"（从文档根到图层的层级名称链）保存，文档重开后
 * layerId 会变化，引擎会按路径重新解析；解析失败的任务保持存在但不同步。
 */

export type MaskSyncChannel = 'gray' | 'r' | 'g' | 'b' | 'a';

export const MASK_SYNC_CHANNEL_LABELS: Record<MaskSyncChannel, string> = {
  gray: '灰阶',
  r: 'R通道',
  g: 'G通道',
  b: 'B通道',
  a: 'A通道',
};

export interface MaskSyncTask {
  id: string;
  name: string;
  // —— 样本（部分一）——
  sampleLayerId: number | null;
  sampleLayerPath: string[] | null; // 名称路径，用于文档重开后解析
  sampleLayerName: string;
  channel: MaskSyncChannel;
  invert: boolean;
  // —— 目标（部分二）——
  targetLayerId: number | null;
  targetLayerPath: string[] | null;
  targetLayerName: string;
  // —— 同步开关（部分三）——
  enabled: boolean;
}

export interface LayerTreeEntry {
  id: number;
  name: string;
  path: string[]; // 名称路径
  kind: string; // 'pixel' | 'group' | 'layer' | ...
  depth: number;
  hasUserMask: boolean;
  label: string; // 带缩进与后缀的展示文本
}

export interface SyncResult {
  synced: boolean;
  reason: string;
}

const NOTIF_EVENTS = ['set', 'select', 'clearEvent', 'delete', 'make'];
const SYNC_DEBOUNCE_MS = 500; // 事件驱动防抖
const POLL_INTERVAL_MS = 5000; // 兜底轮询
const SYNC_MIN_INTERVAL_MS = 300; // 同一任务两次同步的最小间隔（防止抖动）

type Listener = (info: { docChanged: boolean }) => void;

export class MaskSyncEngine {
  private static _instance: MaskSyncEngine | null = null;

  static get instance(): MaskSyncEngine {
    if (!this._instance) this._instance = new MaskSyncEngine();
    return this._instance;
  }

  // ---------------- 持久化 ----------------
  private persisted: Record<string, MaskSyncTask[]> = {};
  private persistedLoaded = false;

  // ---------------- 运行时状态 ----------------
  private refCount = 0;
  private listeners: Set<Listener> = new Set();
  private lastNotifiedDocKey: string | null = null;
  private currentDocKey = '';
  private currentDocName = '';
  private syncTimer: any = 0;
  private pollTimer: any = 0;
  private running = false;
  private lastDocSignature = '';
  private lastSyncAt: Record<string, number> = {}; // taskKey -> timestamp

  private constructor() {}

  // ================= 对外 API =================

  /** 初始化：加载持久化 + 注册通知监听 + 启动兜底轮询。返回当前文档任务。 */
  async init(): Promise<void> {
    this.refCount++;
    if (this.running) return;
    this.running = true;
    await this.loadPersisted();
    this.refreshActiveDoc();
    this.registerNotification();
    this.startPolling();
    this.notify();
  }

  dispose(): void {
    this.refCount--;
    if (this.refCount > 0 || !this.running) return;
    this.running = false;
    try {
      action.removeNotificationListener(NOTIF_EVENTS as any, this.handleNotification);
    } catch {}
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = 0;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = 0;
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 当前活动文档的持久化键（文档名；无文档时为空串）。 */
  getDocKey(): string {
    return this.currentDocKey;
  }

  getDocName(): string {
    return this.currentDocName;
  }

  /** 读取当前文档的任务列表（深拷贝，避免外部误改）。 */
  getTasks(): MaskSyncTask[] {
    const key = this.currentDocKey;
    if (!key) return [];
    const list = this.persisted[key] || [];
    return list.map(t => ({ ...t }));
  }

  /** 新增一个任务（默认命名 同步任务N）。 */
  async addTask(): Promise<MaskSyncTask> {
    const key = this.currentDocKey;
    const list = this.persisted[key] || [];
    let n = list.length + 1;
    let name = `同步任务${n}`;
    // 若名字冲突（删过任务），递增直至不重复
    while (list.some(t => t.name === name)) {
      n++;
      name = `同步任务${n}`;
    }
    const task: MaskSyncTask = {
      id: this.genId(),
      name,
      sampleLayerId: null,
      sampleLayerPath: null,
      sampleLayerName: '',
      channel: 'gray',
      invert: false,
      targetLayerId: null,
      targetLayerPath: null,
      targetLayerName: '',
      enabled: false,
    };
    list.push(task);
    await this.save(list, key);
    this.notify();
    return { ...task };
  }

  /** 更新任务（整对象替换）。 */
  async updateTask(task: MaskSyncTask): Promise<void> {
    const key = this.currentDocKey;
    const list = (this.persisted[key] || []).map(t => (t.id === task.id ? { ...task } : t));
    await this.save(list, key);
    // 任务配置变化：立即尝试同步一次（若启用且引用完整）
    if (task.enabled && task.sampleLayerId && task.targetLayerId) {
      this.scheduleSync(0);
    }
    this.notify();
  }

  /** 删除任务。 */
  async removeTask(id: string): Promise<void> {
    const key = this.currentDocKey;
    const list = (this.persisted[key] || []).filter(t => t.id !== id);
    await this.save(list, key);
    this.notify();
  }

  /**
   * 构建活动文档的图层树（含缩进展示文本与"是否有用户蒙版"标记）。
   * 目标下拉只应展示 hasUserMask === true 的图层/组。
   */
  async buildLayerTree(doc?: any): Promise<LayerTreeEntry[]> {
    try {
      const d = doc || app.activeDocument;
      if (!d) return [];
      const layers = d.layers || [];
      const entries: LayerTreeEntry[] = [];
      const walk = (list: any[], path: string[], depth: number) => {
        for (const layer of list || []) {
          if (!layer || typeof layer.id !== 'number') continue;
          const children = (layer as any)?.layers;
          const hasChildren = !!(children && Array.isArray(children) && children.length > 0);
          const kind = (layer as any)?.kind;
          const curPath = path.concat([layer.name || `图层 ${layer.id}`]);
          const indent = depth > 0 ? '　'.repeat(Math.min(6, depth)) + '└ ' : '';
          const kindSuffix = hasChildren ? '（组）' : (kind === 'pixel' ? '（像素）' : '');
          entries.push({
            id: layer.id,
            name: layer.name || `图层 ${layer.id}`,
            path: curPath,
            kind,
            depth,
            hasUserMask: false,
            label: `${indent}${layer.name || `图层 ${layer.id}`}${kindSuffix}`,
          });
          if (hasChildren) walk(children, curPath, depth + 1);
        }
      };
      walk(layers, [], 0);

      // 批量查询每个图层的 hasUserMask（一个 batchPlay 完成，避免逐个调用）
      await this.fillUserMaskFlags(d, entries);
      return entries;
    } catch (e) {
      console.warn('⚠️ 构建图层树失败:', e);
      return [];
    }
  }

  /** 按名称路径解析图层（文档重开后 layerId 会变化）。找不到返回 null。 */
  resolveLayerByPath(tree: LayerTreeEntry[], path: string[] | null): LayerTreeEntry | null {
    if (!path || path.length === 0 || !tree || tree.length === 0) return null;
    const target = path.join('/');
    const flat = tree.slice().sort((a, b) => a.depth - b.depth);
    for (const entry of flat) {
      if (entry.path.join('/') === target) return entry;
    }
    return null;
  }

  /**
   * 执行一次任务同步（读取源通道 → 与目标蒙版比较 → 有差异才整图写回蒙版）。
   * 供"手动立即同步"与引擎内部调度共用。
   *
   * ⚠️ 关键约束：imaging API（getPixels/getLayerMask/createImageDataFromBuffer/
   *    putLayerMask）**全部必须在 core.executeAsModal 的回调里调用**，否则
   *    会抛出 "The requested functionality is only allowed from inside a
   *    modal scope"。所以整个同步流程（含读取）都包在同一个 modal scope 内。
   *
   * 数据流（对齐项目中已验证的 pixelDataProcessor / ClearHandler 模式）：
   * 1. 样本像素：先取图层 bounds，再 getPixels({ sourceBounds: 图层bounds,
   *    targetSize: 图层宽高 })——**不能用"全文档 sourceBounds + 全文档 targetSize"**，
   *    图层像素不覆盖全文档时 sourceBounds 会被裁剪到图层区域，导致数组尺寸
   *    与文档尺寸对不上（数组错位/拉伸，蒙版写出来是空白）。
   * 2. 通道数据按图层 bounds 偏移映射到全文档数组，图层外填 0（黑=隐藏，
   *    透明区域对应蒙版黑）。
   * 3. 写回：整图尺寸单通道灰度 ImageData + putLayerMask（不带 targetBounds/
   *    replace，默认 replace:true），与 ClearHandler.updateLayerMask 一致。
   */
  async syncTask(task: MaskSyncTask, doc?: any): Promise<SyncResult> {
    try {
      const d = doc || app.activeDocument;
      if (!d || !task || !task.sampleLayerId || !task.targetLayerId) {
        return { synced: false, reason: 'incomplete' };
      }
      if (!task.enabled) return { synced: false, reason: 'disabled' };

      const taskKey = this.fpKey(this.docKeyOf(d), task.id);
      const now = Date.now();
      const last = this.lastSyncAt[taskKey] || 0;
      if (now - last < SYNC_MIN_INTERVAL_MS) {
        return { synced: false, reason: 'throttled' };
      }
      this.lastSyncAt[taskKey] = now;

      // imaging API 必须在 executeAsModal 内执行；同步流程（读+写）全部包在 modal 中
      let result: SyncResult = { synced: false, reason: 'error' };
      try {
        await core.executeAsModal(async () => {
          // 1) 文档像素尺寸
          const docSize = await this.getDocPixelSize(d);
          if (!docSize) { result = { synced: false, reason: 'no-doc-size' }; return; }
          const docW = docSize.width;
          const docH = docSize.height;

          // 2) 获取样本图层 bounds
          const layerBounds = await this.getLayerBounds(d.id, task.sampleLayerId);
          if (!layerBounds) { result = { synced: false, reason: 'layer-bounds-failed' }; return; }
          const layerW = layerBounds.right - layerBounds.left;
          const layerH = layerBounds.bottom - layerBounds.top;
          if (layerW <= 0 || layerH <= 0) { result = { synced: false, reason: 'empty-layer' }; return; }

          // 3) 按图层 bounds 读取像素（sourceBounds 与 targetSize 一致）
          const srcPixels = await imaging.getPixels({
            documentID: d.id,
            layerID: task.sampleLayerId,
            sourceBounds: layerBounds,
            targetSize: { width: layerW, height: layerH },
            componentSize: 8,
          });
          const imgData = srcPixels.imageData;
          const raw = new Uint8Array(await imgData.getData());
          srcPixels.imageData.dispose();
          // 诊断日志（实际尺寸与请求不一致时极易引发数据错位）
          console.log(
            `🩺 [诊断] 任务=${task.name} 样本=${task.sampleLayerId} bounds=`,
            layerBounds, '请求宽高=', layerW, 'x', layerH,
            'imageData=', imgData.width, 'x', imgData.height,
            'raw.length=', raw.length,
            'actualBounds=', srcPixels.sourceBounds
          );
          const comps = raw.length > 0 ? Math.round(raw.length / (imgData.width * imgData.height)) : 0;
          if (comps !== 3 && comps !== 4) {
            result = { synced: false, reason: 'unsupported-components' };
            return;
          }

          // 4) 提取目标通道灰度（灰阶取亮度，R/G/B/A 取对应分量，可反相），
          //    再按图层 bounds 偏移映射到全文档数组（图层外=0=黑）。
          //    通道提取与映射都以 imageData 实际宽高为准（更可靠，匹配 raw 实际长度）。
          const srcW = imgData.width;
          const srcH = imgData.height;
          const layerChannel = this.extractChannel(raw, comps, task.channel, task.invert, srcW, srcH);
          const srcChannel = new Uint8Array(docW * docH);
          const copyW = Math.min(srcW, docW - layerBounds.left);
          const copyH = Math.min(srcH, docH - layerBounds.top);
          if (copyW > 0 && copyH > 0) {
            for (let y = 0; y < copyH; y++) {
              const srcRow = y * srcW;
              const dstRow = (layerBounds.top + y) * docW + layerBounds.left;
              for (let x = 0; x < copyW; x++) {
                srcChannel[dstRow + x] = layerChannel[srcRow + x];
              }
            }
          }

          // 5) 读取目标蒙版
          let maskImg: any;
          try {
            maskImg = await imaging.getLayerMask({
              documentID: d.id,
              layerID: task.targetLayerId,
              kind: 'user',
              sourceBounds: { left: 0, top: 0, right: docW, bottom: docH },
              componentSize: 8,
            });
          } catch (e) {
            console.warn('⚠️ 蒙版同步：目标图层蒙版读取失败（可能无蒙版或不可用）', e);
            result = { synced: false, reason: 'mask-unavailable' };
            return;
          }
          const maskRaw = new Uint8Array(await maskImg.imageData.getData());
          maskImg.imageData.dispose();

          // 6) 差异检测：无差异跳过
          let hasDiff = false;
          const cmpLen = Math.min(srcChannel.length, maskRaw.length);
          for (let i = 0; i < cmpLen; i++) {
            if (srcChannel[i] !== maskRaw[i]) {
              hasDiff = true;
              break;
            }
          }
          if (!hasDiff) {
            result = { synced: false, reason: 'unchanged' };
            return;
          }

          // 7) 整图写回蒙版
          const imageData = await imaging.createImageDataFromBuffer(srcChannel, {
            width: docW,
            height: docH,
            components: 1,
            chunky: true,
            colorProfile: 'Dot Gain 15%',
            colorSpace: 'Grayscale',
          });
          await imaging.putLayerMask({
            documentID: d.id,
            layerID: task.targetLayerId,
            kind: 'user',
            imageData,
            commandName: '蒙版同步',
          });
          imageData.dispose();
          result = { synced: true, reason: 'applied' };
        }, { commandName: '蒙版同步' });
      } catch (e) {
        console.warn('⚠️ 蒙版同步执行失败:', e);
        result = { synced: false, reason: 'error' };
      }
      return result;
    } catch (e) {
      console.warn('⚠️ 蒙版同步执行失败:', e);
      return { synced: false, reason: 'error' };
    }
  }

  /** 同步当前文档中所有"启用且引用完整"的任务。 */
  async syncAll(doc?: any): Promise<void> {
    const d = doc || app.activeDocument;
    if (!d) return;
    const key = this.docKeyOf(d);
    const tasks = this.persisted[key] || [];
    const enabled = tasks.filter(t => t.enabled && t.sampleLayerId && t.targetLayerId);
    if (enabled.length === 0) return;
    for (const task of enabled) {
      const r = await this.syncTask(task, d);
      if (r.synced || r.reason !== 'unchanged') {
        console.log(`🔄 蒙版同步[${task.name}]: ${r.synced ? '已写入蒙版' : '跳过(' + r.reason + ')'}`);
      }
    }
  }

  /** 把当前文档任务中的图层引用与当前文件树对齐（文档切换/重开时调用）：
   *  按名称路径重新解析 layerId（文档重开后 id 会变化）；路径失效的引用置为 null（由用户重新选择）。 */
  async reconcileTasks(tree?: LayerTreeEntry[]): Promise<boolean> {
    const key = this.currentDocKey;
    if (!key) return false;
    const list = this.persisted[key] || [];
    if (list.length === 0) return false;
    const hasPaths = list.some(t =>
      (t.sampleLayerPath && t.sampleLayerPath.length) ||
      (t.targetLayerPath && t.targetLayerPath.length)
    );
    if (!hasPaths) return false;
    const entries = tree || (await this.buildLayerTree());
    const byId = new Map<number, LayerTreeEntry>();
    for (const e of entries) byId.set(e.id, e);
    let changed = false;
    for (const t of list) {
      // 样本层：优先校验当前 id 是否仍指向同一路径的像素层
      if (t.sampleLayerPath && t.sampleLayerPath.length) {
        const cur = t.sampleLayerId != null ? byId.get(t.sampleLayerId) : undefined;
        const curOk = !!cur && cur.kind === 'pixel' && cur.path.join('/') === t.sampleLayerPath.join('/');
        if (!curOk) {
          const hit = this.resolveLayerByPath(entries, t.sampleLayerPath);
          if (hit && hit.kind === 'pixel') {
            if (t.sampleLayerId !== hit.id) {
              t.sampleLayerId = hit.id;
              t.sampleLayerName = hit.name;
              changed = true;
            }
          } else if (t.sampleLayerId != null) {
            t.sampleLayerId = null;
            changed = true;
          }
        }
      }
      // 目标层：同上，但要求有用户蒙版
      if (t.targetLayerPath && t.targetLayerPath.length) {
        const cur = t.targetLayerId != null ? byId.get(t.targetLayerId) : undefined;
        const curOk = !!cur && cur.hasUserMask && cur.path.join('/') === t.targetLayerPath.join('/');
        if (!curOk) {
          const hit = this.resolveLayerByPath(entries, t.targetLayerPath);
          if (hit && hit.hasUserMask) {
            if (t.targetLayerId !== hit.id) {
              t.targetLayerId = hit.id;
              t.targetLayerName = hit.name;
              changed = true;
            }
          } else if (t.targetLayerId != null) {
            t.targetLayerId = null;
            changed = true;
          }
        }
      }
    }
    if (changed) await this.save(list, key);
    return changed;
  }

  // ================= 内部实现 =================

  private genId(): string {
    return 'sync_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** 获取文档像素尺寸（point×分辨率/72 换算，与 ClearHandler.getSelectionData 一致）。 */
  private async getDocPixelSize(doc: any): Promise<{ width: number; height: number } | null> {
    try {
      const result = await action.batchPlay([
        {
          _obj: 'get',
          _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
          _options: { dialogOptions: 'dontDisplay' },
        },
      ], { synchronousExecution: true });
      const info = result && result[0];
      if (!info || !info.width || !info.height) {
        // 兜底：用 DOM 属性（像素单位）
        const w = Math.round(doc.width || 0);
        const h = Math.round(doc.height || 0);
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      const resolution = (info.resolution && info.resolution._value) || 72;
      // 依单位换算：pixelsUnit 直接取值；point/其他单位按分辨率换算为像素
      const toPx = (v: any): number => {
        const value = v && typeof v._value === 'number' ? v._value : 0;
        const unit = (v && v._unit) || '';
        if (typeof unit === 'string' && unit.toLowerCase().includes('pixel')) {
          return Math.round(value);
        }
        return Math.round(value * resolution / 72);
      };
      const width = toPx(info.width);
      const height = toPx(info.height);
      return width > 0 && height > 0 ? { width, height } : null;
    } catch (e) {
      console.warn('⚠️ 获取文档尺寸失败:', e);
      return null;
    }
  }

  /** 通过 DOM 查找指定 layerId 的图层对象，返回像素 bounds（left/top/right/bottom）。
   *  与项目 pixelDataProcessor.processPixelData 的标准做法一致（直接用 UXP DOM
   *  的 layer.bounds 属性），避免 batchPlay get layer 返回 bounds 单位不一致的问题。 */
  private async getLayerBounds(
    docId: number,
    layerId: number
  ): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
    try {
      const d = app.activeDocument;
      if (!d || d.id !== docId) return null;
      const walk = (list: any[]): any | null => {
        for (const layer of list || []) {
          if (!layer) continue;
          if (layer.id === layerId) return layer;
          if (layer.layers && layer.layers.length > 0) {
            const found = walk(layer.layers);
            if (found) return found;
          }
        }
        return null;
      };
      const layer = walk(d.layers);
      if (!layer || !layer.bounds) return null;
      const b = layer.bounds;
      return {
        left: Math.round(b.left || 0),
        top: Math.round(b.top || 0),
        right: Math.round(b.right || 0),
        bottom: Math.round(b.bottom || 0),
      };
    } catch (e) {
      console.warn('⚠️ 获取图层边界失败:', e);
      return null;
    }
  }

  private docKeyOf(doc: any): string {
    return (doc && doc.name) || '';
  }

  private fpKey(docKey: string, taskId: string): string {
    return docKey + '|' + taskId;
  }

  /** 从 RGBA/RGB 数据中提取目标通道灰度（0-255），支持反相。 */
  private extractChannel(
    raw: Uint8Array,
    comps: number,
    channel: MaskSyncChannel,
    invert: boolean,
    w: number,
    h: number
  ): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = i * comps;
      let v = 0;
      switch (channel) {
        case 'r': v = raw[o]; break;
        case 'g': v = raw[o + 1]; break;
        case 'b': v = raw[o + 2]; break;
        case 'a': v = comps >= 4 ? raw[o + 3] : 255; break;
        default: v = (raw[o] * 54 + raw[o + 1] * 183 + raw[o + 2] * 19) >> 8; break;
      }
      out[i] = invert ? 255 - v : v;
    }
    return out;
  }

  private async loadPersisted(): Promise<void> {
    if (this.persistedLoaded) return;
    try {
      const lfs = await this.getLocalFS();
      const dataFolder = await lfs.getDataFolder();
      let file: any;
      try {
        file = await dataFolder.getEntry('mask-sync-state.json');
      } catch (_) {
        file = null;
      }
      if (file) {
        const formats = (window as any)?.uxp?.storage?.formats || require('uxp').storage.formats;
        const content = await file.read({ format: formats.utf8 });
        const json = JSON.parse(content || '{}');
        if (json && typeof json === 'object' && json.byDocument && typeof json.byDocument === 'object') {
          this.persisted = json.byDocument;
        }
      }
    } catch (e) {
      console.warn('⚠️ 蒙版同步状态加载失败:', e);
    }
    this.persistedLoaded = true;
  }

  private async save(tasks: MaskSyncTask[], docKey?: string): Promise<void> {
    const key = docKey || this.currentDocKey;
    if (key) this.persisted[key] = tasks.map(t => ({ ...t }));
    try {
      const lfs = await this.getLocalFS();
      const dataFolder = await lfs.getDataFolder();
      let file: any;
      try {
        file = await dataFolder.getEntry('mask-sync-state.json');
      } catch (_) {
        file = await dataFolder.createFile('mask-sync-state.json', { overwrite: true });
      }
      const formats = (window as any)?.uxp?.storage?.formats || require('uxp').storage.formats;
      await file.write(JSON.stringify({ byDocument: this.persisted }, null, 2), { format: formats.utf8 });
    } catch (e) {
      console.warn('⚠️ 蒙版同步状态保存失败:', e);
    }
  }

  private async getLocalFS(): Promise<any> {
    let localFileSystem: any;
    try {
      localFileSystem = require('uxp').storage.localFileSystem;
    } catch (_) {
      localFileSystem = (window as any)?.uxp?.storage?.localFileSystem;
    }
    if (!localFileSystem) throw new Error('无法获取 UXP localFileSystem');
    return localFileSystem;
  }

  /** 批量查询每个图层的 hasUserMask（分批执行，避免单批过大）。 */
  private async fillUserMaskFlags(doc: any, entries: LayerTreeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const BATCH = 40;
    for (let start = 0; start < entries.length; start += BATCH) {
      const chunk = entries.slice(start, start + BATCH);
      const descriptors: any[] = chunk.map(e => ({
        _obj: 'get',
        _target: [{ _property: 'hasUserMask' }, { _ref: 'layer', _id: e.id }, { _ref: 'document', _id: doc.id }],
        _options: { dialogOptions: 'dontDisplay' },
      }));
      try {
        const results = await action.batchPlay(descriptors, { synchronousExecution: true });
        if (Array.isArray(results)) {
          for (let i = 0; i < results.length && i < chunk.length; i++) {
            const r = results[i];
            if (r && typeof r.hasUserMask === 'boolean') {
              chunk[i].hasUserMask = r.hasUserMask;
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ 查询图层蒙版状态失败:', e);
      }
    }
  }

  /** 刷新活动文档上下文；返回是否发生了文档切换。 */
  private refreshActiveDoc(): boolean {
    let docKey = '';
    let docName = '';
    try {
      const d = app.activeDocument;
      if (d) {
        docKey = d.name || '';
        docName = d.name || '';
      }
    } catch {
      docKey = '';
      docName = '';
    }
    if (docKey !== this.currentDocKey) {
      this.currentDocKey = docKey;
      this.currentDocName = docName;
      this.lastDocSignature = '';
      return true;
    }
    return false;
  }

  private docSignature(): string {
    try {
      const d = app.activeDocument;
      if (!d) return 'none';
      const layers = d.layers || [];
      let h = 2166136261 >>> 0;
      const walk = (list: any[]) => {
        for (const layer of list || []) {
          if (!layer) continue;
          const id = layer.id || 0;
          const kind = layer.kind === 'pixel' ? 1 : (layer.kind === 'group' ? 2 : 3);
          h = Math.imul(h ^ id, 16777619) >>> 0;
          h = Math.imul(h ^ kind, 16777619) >>> 0;
          const name = layer.name || '';
          for (let i = 0; i < name.length; i++) {
            h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
          }
          walk((layer as any)?.layers);
        }
      };
      walk(layers);
      return d.name + '#' + h.toString(36);
    } catch {
      return 'none';
    }
  }

  private registerNotification(): void {
    try {
      action.addNotificationListener(NOTIF_EVENTS as any, this.handleNotification);
    } catch (e) {
      console.warn('⚠️ 蒙版同步通知监听注册失败:', e);
    }
  }

  private handleNotification = (event?: any) => {
    try {
      // 检测文档切换：切换后立即通知 React 重载任务并同步
      const docChanged = this.refreshActiveDoc();
      if (docChanged) {
        this.notify();
        this.scheduleSync(300);
        return;
      }
      const evt = typeof event === 'string' ? event : (event as any)?.eventName || '';
      // make/delete 会改变图层结构，需要重建文件树上下文（重解析引用）
      if (evt === 'make' || evt === 'delete') {
        this.scheduleSync(200);
        return;
      }
      this.scheduleSync(SYNC_DEBOUNCE_MS);
    } catch {
      this.scheduleSync(SYNC_DEBOUNCE_MS);
    }
  };

  /** 防抖调度同步。delay=0 表示立即（下一帧）。 */
  private scheduleSync(delay: number): void {
    if (!this.running) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = 0;
      this.doTimedSync();
    }, Math.max(0, delay));
  }

  private async doTimedSync(): Promise<void> {
    try {
      const d = app.activeDocument;
      if (!d) return;
      this.refreshActiveDoc();
      // 若任务引用了失效的 layerId（文档重开），先尝试按路径重解析
      const list = this.persisted[this.currentDocKey] || [];
      const needReconcile = list.some(t => t.enabled && (
        (t.sampleLayerId == null && t.sampleLayerPath && t.sampleLayerPath.length) ||
        (t.targetLayerId == null && t.targetLayerPath && t.targetLayerPath.length)
      ));
      if (needReconcile) {
        await this.reconcileTasks();
      }
      await this.syncAll(d);
    } catch (e) {
      console.warn('⚠️ 蒙版同步调度执行失败:', e);
    }
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      try {
        const prevKey = this.currentDocKey;
        this.refreshActiveDoc();
        const sig = this.docSignature();
        const keyChanged = prevKey !== this.currentDocKey;
        const sigChanged = sig !== this.lastDocSignature;
        if (keyChanged) {
          this.lastDocSignature = sig;
          this.notify(); // React 侧重新加载当前文档任务 + 刷新文件树
          this.scheduleSync(300);
          return;
        }
        if (sigChanged) {
          this.lastDocSignature = sig;
          this.scheduleSync(SYNC_DEBOUNCE_MS);
        }
      } catch {}
    }, POLL_INTERVAL_MS);
  }

  private notify(): void {
    const docChanged = this.currentDocKey !== this.lastNotifiedDocKey;
    this.lastNotifiedDocKey = this.currentDocKey;
    this.listeners.forEach(fn => {
      try {
        fn({ docChanged });
      } catch {}
    });
  }
}

/** 便捷的单例引用。 */
export const maskSyncEngine = MaskSyncEngine.instance;
