import { app, action, core, imaging } from 'photoshop';

/**
 * 蒙版同步引擎（MaskSyncEngine）
 *
 * 功能：把一个图层的某个灰度通道（灰阶 / R / G / B / A / 蒙版，可反相）"实时"复制到
 * 另一个图层（或图层组）的图层蒙版上。
 *
 * 同步策略（及时性优先、兼顾性能）：
 * 1. 事件驱动 + 防抖：监听 Photoshop 操作通知（set/select/make/delete/rename/move 等），
 *    操作停止后约 200ms 统一调度一次同步（比旧 500ms 更及时）。
 * 2. 内容指纹去重：同步时先读取"源通道"与"目标蒙版"像素，逐像素比较；
 *    内容一致则跳过写入，避免无意义写回与写入-通知-再写入的循环。
 * 3. 整图写回：UXP 的 putLayerMask 局部写（targetBounds+replace:false）不可靠，
 *    采用整图单通道灰度 ImageData 写回（与 ClearHandler.updateLayerMask 一致）。
 * 4. 低频兜底轮询：每 2 秒用轻量文档签名检查一次活动文档结构是否变化，
 *    覆盖通知遗漏的场景；签名未变不触发像素读取。
 *
 * 像素数据流（chunky 格式，虚构数组法）：
 * - getPixels 按图层实际边界读取（sourceBounds 与 targetSize 一致）：普通像素图层
 *   返回 RGBA(4 comps)、背景图层返回 RGB(3 comps 无 A)。
 * - 遍历图层像素，记录 alpha>0 像素在文档坐标系中的索引与 RGBA，再扩展成
 *   4*DocWidth*DocHeight 虚构数组（默认 255），按索引插入。
 * - 从虚构数组提取通道（灰度=0.299R+0.587G+0.114B，R/G/B/A 取对应分量），
 *   蒙版通道直接用 getLayerMask 获取的单通道数组。
 *
 * 持久化：按文档名（doc.name）保存各文档的任务列表，重开同名文档后自动恢复。
 * 图层引用使用"名称路径"（从文档根到图层的层级名称链）保存，文档重开后
 * layerId 会变化，引擎会按路径重新解析；解析失败的任务保持存在但不同步。
 */

/** 引擎版本标识：面板与 console 都会显示，用于确认插件已加载最新代码。 */
export const MASK_SYNC_ENGINE_VERSION = 'v3.3';

console.log(`[蒙版同步] 引擎代码加载 ${MASK_SYNC_ENGINE_VERSION}`);

export type MaskSyncChannel = 'gray' | 'r' | 'g' | 'b' | 'a' | 'mask' | 'hue' | 'sat';

export const MASK_SYNC_CHANNEL_LABELS: Record<MaskSyncChannel, string> = {
  gray: '灰阶',
  r: 'R通道',
  g: 'G通道',
  b: 'B通道',
  a: 'A通道',
  mask: '蒙版',
  hue: '色相通道',
  sat: '饱和度通道',
};

/**
 * RGB → 色相灰阶：以纯黄（色相 60°）为白(255)、纯蓝（色相 240°）为黑(0)，
 * 按到黄的最短角距线性映射（蓝恰在黄的对面 180°）。
 *   - 黄(60°)  → 255（白）
 *   - 蓝(240°) → 0（黑）
 *   - 绿(120°)/红(0°) → 170；青(180°)/品红(300°) → 85（中间过渡）
 * 灰度像素（R=G=B，色相未定义）落入红/黄区间，得 ~170，属中性灰，避免极端黑白。
 */
function rgbToHueGray(r: number, g: number, b: number): number {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 1e-6) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
    if (h < 0) h += 360;
  }
  // 到黄(60°)的最短有向角差，归一到 [-180,180]
  let d = h - 60;
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return Math.round(255 * (1 - Math.abs(d) / 180));
}

/** RGB → 饱和度灰阶：高饱和为白(255)，低饱和为黑(0)。灰度/中性色（S=0）→ 黑。 */
function rgbToSatGray(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const s = max === 0 ? 0 : delta / max; // HSV 饱和度 [0,1]
  return Math.round(s * 255);
}

/** 调整图层（LayerKind）识别集合：kind 值取自 UXP LayerKind 常量（小写）。 */
export const ADJUSTMENT_KINDS = new Set<string>([
  'adjustment', 'blackandwhite', 'brightnesscontrast', 'channelmixer', 'clarity',
  'colorbalance', 'colorlookup', 'curves', 'exposure', 'gradientmap', 'grain',
  'huesaturation', 'inversion', 'levels', 'photofilter', 'posterize',
  'selectivecolor', 'threshold', 'vibrance',
]);

export const isAdjustmentKind = (kind: string): boolean => ADJUSTMENT_KINDS.has(kind);

export interface MaskSyncTask {
  id: string;
  name: string;
  // —— 样本（部分一）——
  sampleLayerId: number | null;
  sampleLayerPath: string[] | null; // 名称路径，用于文档重开后解析
  sampleLayerName: string;
  channel: MaskSyncChannel | ''; // '' = 未选择通道（新建任务默认空白）
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
  isBackground: boolean; // 是否为背景图层（只有 RGB 三通道）
  isAdjustment: boolean; // 是否为调整图层（无 A 通道，有蒙版）
  depth: number;
  hasUserMask: boolean;
  label: string; // 带缩进与后缀的展示文本
}

export interface SyncResult {
  synced: boolean;
  reason: string;
}

/** 同步状态（供 UI 展示，无需看 console 即可诊断）。 */
export interface SyncState {
  time: number; // 上次同步时间戳
  synced: boolean; // 是否成功写入
  reason: string; // 结果/原因（applied/unchanged/error 等）
  detail?: string; // 补充说明（如错误信息截断）
}

const NOTIF_EVENTS = ['set', 'select', 'clearEvent', 'delete', 'make', 'rename', 'move'];
const SYNC_DEBOUNCE_MS = 200; // 事件驱动防抖（更及时）
const POLL_INTERVAL_MS = 2000; // 兜底轮询（更及时）
const SYNC_MIN_INTERVAL_MS = 150; // 同一任务两次同步的最小间隔（防止抖动）

type Listener = (info: { docChanged: boolean; results?: Record<string, SyncState> }) => void;

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
  private lastSyncResults: Record<string, SyncState> = {}; // taskId -> 最近一次同步状态
  private lastNotifLogAt = 0; // 事件日志节流

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
    console.log(
      `[蒙版同步] 初始化完成 ${MASK_SYNC_ENGINE_VERSION}：文档=${this.currentDocName || '（无）'}，` +
      `任务数=${(this.persisted[this.currentDocKey] || []).length}`
    );
  }

  /** 读取某任务最近一次同步状态（供 UI 展示）。 */
  getLastSyncResult(taskId: string): SyncState | undefined {
    return this.lastSyncResults[taskId];
  }

  dispose(): void {
    this.refCount--;
    if (this.refCount > 0 || !this.running) return;
    this.running = false;
    for (const evt of NOTIF_EVENTS) {
      try {
        // UXP 的 add/removeNotificationListener 第一个参数必须是数组（与 app.tsx 一致）
        action.removeNotificationListener([evt] as any, this.handleNotification);
      } catch {}
    }
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
      channel: '', // 新建任务：样本/通道/目标 三个菜单默认全部空白
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
    // 任务配置变化：立即尝试同步一次（若启用且引用完整、通道已选）
    if (task.enabled && task.sampleLayerId && task.targetLayerId && task.channel) {
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
   *
   * ⚠️ 图层名通过 batchPlay 查询（而非直接读 DOM layer.name）：
   * UXP DOM 的 layer.name 在"删除→新建→改名"后会返回缓存旧值，
   * 导致文件树下拉显示旧名称；batchPlay 按 id 实时查询名称可避免该问题。
   */
  async buildLayerTree(doc?: any): Promise<LayerTreeEntry[]> {
    try {
      const d = doc || app.activeDocument;
      if (!d) return [];
      const layers = d.layers || [];
      const entries: LayerTreeEntry[] = [];
      const idPath: number[][] = []; // 与 entries 对应的 id 路径（用于实时名称重建 path）
      const walk = (list: any[], parentIds: number[], depth: number) => {
        for (const layer of list || []) {
          if (!layer || typeof layer.id !== 'number') continue;
          const children = (layer as any)?.layers;
          const hasChildren = !!(children && Array.isArray(children) && children.length > 0);
          const kind = (layer as any)?.kind;
          const isBackground = !!(layer as any)?.isBackgroundLayer;
          const isAdjustment = isAdjustmentKind(kind);
          const curIds = parentIds.concat([layer.id]);
          // 层级缩进由 CSS 的 padding-left（按 depth）体现（见 MaskSyncSelect），
          // 组内的图层/嵌套组前面再补一个 └ 符号增强层级辨识（depth>0 才加）。
          const indent = depth > 0 ? '└ ' : '';
          let kindSuffix = '';
          if (hasChildren) kindSuffix = '（组）';
          else if (isBackground) kindSuffix = '（背景）';
          else if (isAdjustment) kindSuffix = '（调整）';
          else if (kind === 'pixel') kindSuffix = '（像素）';
          entries.push({
            id: layer.id,
            name: layer.name || `图层 ${layer.id}`,
            path: curIds.map(() => ''),
            kind,
            isBackground,
            isAdjustment,
            depth,
            hasUserMask: false,
            label: `${indent}${layer.name || `图层 ${layer.id}`}${kindSuffix}`,
          });
          idPath.push(curIds);
          if (hasChildren) walk(children, curIds, depth + 1);
        }
      };
      walk(layers, [], 0);

      // ① 批量查询每个图层的实时名称（按 id 路径逐级查询，避免 DOM 缓存旧名）
      const nameMap = await this.fetchLayerNamesByIds(d, idPath);

      // ② 批量查询每个图层的 hasUserMask（一个 batchPlay 完成，避免逐个调用）
      await this.fillUserMaskFlags(d, entries);

      // ③ 用实时名称重建 path 与 label
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const ids = idPath[i];
        const names: string[] = [];
        for (const id of ids) {
          const nm = nameMap.get(id);
          names.push(nm !== undefined ? nm : `图层 ${id}`);
        }
        e.name = names[names.length - 1];
        e.path = names;
        // 层级缩进由 CSS padding-left（按 depth）体现；组内图层/嵌套组前面补 └ 符号
        const indent = e.depth > 0 ? '└ ' : '';
        let kindSuffix = '';
        if (e.kind === 'group') kindSuffix = '（组）';
        else if (e.isBackground) kindSuffix = '（背景）';
        else if (e.isAdjustment) kindSuffix = '（调整）';
        else if (e.kind === 'pixel') kindSuffix = '（像素）';
        e.label = `${indent}${e.name}${kindSuffix}`;
      }
      return entries;
    } catch (e) {
      console.warn('⚠️ 构建图层树失败:', e);
      return [];
    }
  }

  /** 按 id 路径批量查询每个图层的实时名称（batchPlay，40/批）。 */
  private async fetchLayerNamesByIds(doc: any, idPaths: number[][]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const allIds = Array.from(new Set(idPaths.flat()));
    const BATCH = 40;
    for (let start = 0; start < allIds.length; start += BATCH) {
      const chunk = allIds.slice(start, start + BATCH);
      const descriptors: any[] = chunk.map(id => ({
        _obj: 'get',
        _target: [{ _property: 'name' }, { _ref: 'layer', _id: id }, { _ref: 'document', _id: doc.id }],
        _options: { dialogOptions: 'dontDisplay' },
      }));
      try {
        const results = await action.batchPlay(descriptors, { synchronousExecution: true });
        if (Array.isArray(results)) {
          for (let i = 0; i < results.length && i < chunk.length; i++) {
            const r = results[i];
            if (r && typeof r.name === 'string') {
              map.set(chunk[i], r.name);
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ 查询图层名称失败:', e);
      }
    }
    return map;
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
   * 数据流（chunky 像素格式，对齐 patternfill 的现成模式）：
   * 1. 样本像素：先取图层 bounds，再 getPixels({ sourceBounds: 图层bounds,
   *    targetSize: 图层宽高 })——若用全文档 sourceBounds，当图层像素没有画满
   *    画布时返回数组会被裁剪/报 Missing image，必须按图层实际像素边界读取。
   *    普通像素图层返回 RGBA(4 comps)：[R,G,B,A,...]，数组长度=4*layerW*layerH；
   *    背景图层返回 RGB(3 comps)：[R,G,B,...]，数组长度=3*layerW*layerH（无 A）。
   * 2. 遍历图层像素，记录 alpha>0 的像素在**文档坐标系**中的索引（通过图层
   *    bounds 偏移换算）以及 RGBA 值。
   * 3. 扩展成一个 4*DocWidth*DocHeight 的"虚构数组"，全部像素默认 RGBA=255，
   *    再把上一步记录的 alpha>0 像素按文档索引插入正确位置。
   * 4. 依据虚构数组提取通道（每个长度 = DocWidth*DocHeight）：
   *    R = virtual[i*4]，G = virtual[i*4+1]，B = virtual[i*4+2]，A = virtual[i*4+3]；
   *    灰度 = 0.299*R + 0.587*G + 0.114*B（标准亮度公式）；
   *    蒙版通道 = imaging.getLayerMask 直接返回的单通道 DocWidth*DocHeight 数组。
   * 5. 写回：整图尺寸单通道灰度 ImageData + putLayerMask（不带 targetBounds/
   *    replace，默认 replace:true），与 ClearHandler.updateLayerMask 一致。
   */
  async syncTask(task: MaskSyncTask, doc?: any): Promise<SyncResult> {
    const result = await this.runSync(task, doc);
    // 记录每次同步状态（含未执行原因），供面板 UI 直接展示，不依赖 console
    if (task && task.id) {
      this.lastSyncResults[task.id] = {
        time: Date.now(),
        synced: result.synced,
        reason: result.reason,
      };
    }
    return result;
  }

  private async runSync(task: MaskSyncTask, doc?: any): Promise<SyncResult> {
    try {
      const d = doc || app.activeDocument;
      if (!d || !task || !task.sampleLayerId || !task.targetLayerId) {
        return { synced: false, reason: 'incomplete' };
      }
      if (!task.enabled) return { synced: false, reason: 'disabled' };
      if (!task.channel) return { synced: false, reason: 'no-channel' };

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
          // 1) 文档像素尺寸（像素单位，batchPlay 换算）
          const docSize = await this.getDocPixelSize(d);
          if (!docSize) { result = { synced: false, reason: 'no-doc-size' }; return; }
          const docW = docSize.width;
          const docH = docSize.height;
          const totalPixels = docW * docH;

          // 2) 样本图层类型（背景图层无 A 通道；调整图层无像素内容）
          const sampleMeta = await this.getLayerMeta(d, task.sampleLayerId);
          if (!sampleMeta) { result = { synced: false, reason: 'layer-not-found' }; return; }
          const layerBounds = sampleMeta.bounds;
          const layerW = layerBounds.right - layerBounds.left;
          const layerH = layerBounds.bottom - layerBounds.top;
          console.log(
            `🩺 [诊断] 文档=${docW}x${docH} 样本图层bounds=`, layerBounds,
            '图层宽高=', layerW, 'x', layerH,
            sampleMeta.isBackground ? '（背景图层）' : (sampleMeta.isAdjustment ? '（调整图层）' : (sampleMeta.isGroup ? '（组图层·按蒙版通道同步）' : '（普通图层）'))
          );

          // 3) 读取样本图层像素（按图层实际边界，sourceBounds 与 targetSize 一致）
          let raw: Uint8Array | null = null;
          let comps = 0;
          let pixelsReadError: string | null = null;
          // 调整图层无像素内容、组图层 getPixels 会报 "Unsupported layer type"，
          // 二者都跳过像素读取（组图层通道锁定为蒙版，由 step5 的 getSampleMaskChannel 读其蒙版）
          if (!sampleMeta.isAdjustment && !sampleMeta.isGroup && layerW > 0 && layerH > 0) {
            try {
              const srcPixels = await imaging.getPixels({
                documentID: d.id,
                layerID: task.sampleLayerId,
                sourceBounds: layerBounds,
                targetSize: { width: layerW, height: layerH },
                componentSize: 8,
              });
              const imgData = srcPixels.imageData;
              const data = new Uint8Array(await imgData.getData());
              const gotW = imgData.width;
              const gotH = imgData.height;
              console.log(
                `🩺 [诊断] 任务=${task.name} 样本=${task.sampleLayerId} bounds=`,
                layerBounds, '请求宽高=', layerW, 'x', layerH,
                'imageData=', gotW, 'x', gotH,
                'raw.length=', data.length,
                'actualBounds=', srcPixels.sourceBounds
              );
              srcPixels.imageData.dispose();
              comps = data.length > 0 ? Math.round(data.length / (gotW * gotH)) : 0;
              if (comps === 3 || comps === 4) {
                raw = data;
              } else {
                pixelsReadError = `comps=${comps}`;
              }
            } catch (e) {
              console.warn('⚠️ 蒙版同步：样本像素读取失败（可能为空图层）', e);
              pixelsReadError = e && typeof e === 'object' && (e as any).message ? (e as any).message : String(e);
            }
          }
          // 像素图层读取失败（非调整图层）→ 不应静默写全白，报告错误
          if (!sampleMeta.isAdjustment && pixelsReadError) {
            result = { synced: false, reason: `sample-pixels-failed:${pixelsReadError}` };
            return;
          }
          // raw 为 null（调整图层/空图层）→ 虚构数组保持全 255（白色，无内容）

          // 4) 遍历图层像素，记录 alpha>0 像素的文档索引与 RGBA
          //    然后扩展成 4*DocWidth*DocHeight 虚构数组（默认 255），按索引插入
          const virtual = new Uint8Array(totalPixels * 4);
          virtual.fill(255);
          if (raw && comps) {
            for (let y = 0; y < layerH; y++) {
              for (let x = 0; x < layerW; x++) {
                const si = (y * layerW + x) * comps;
                const a = comps === 4 ? raw[si + 3] : 255; // 背景图层无 alpha，视为 255
                if (a <= 0) continue;
                const docX = layerBounds.left + x;
                const docY = layerBounds.top + y;
                if (docX < 0 || docX >= docW || docY < 0 || docY >= docH) continue;
                const di = (docY * docW + docX) * 4;
                virtual[di] = raw[si];         // R
                virtual[di + 1] = raw[si + 1]; // G
                virtual[di + 2] = raw[si + 2]; // B
                virtual[di + 3] = a;           // A
              }
            }
          }

          // 5) 提取目标通道数组（长度 = DocWidth*DocHeight）
          let channel: Uint8Array;
          if (task.channel === 'mask') {
            channel = await this.getSampleMaskChannel(d, task.sampleLayerId, docW, docH);
            // 反相：蒙版通道同样需要支持反相（组样本通道锁定为蒙版时尤为关键）
            if (task.invert) for (let i = 0; i < channel.length; i++) channel[i] = 255 - channel[i];
          } else {
            channel = new Uint8Array(totalPixels);
            for (let i = 0; i < totalPixels; i++) {
              const R = virtual[i * 4];
              const G = virtual[i * 4 + 1];
              const B = virtual[i * 4 + 2];
              const A = virtual[i * 4 + 3];
              let v: number;
              switch (task.channel) {
                case 'r': v = R; break;
                case 'g': v = G; break;
                case 'b': v = B; break;
                case 'a': v = A; break;
                case 'hue': v = rgbToHueGray(R, G, B); break;
                case 'sat': v = rgbToSatGray(R, G, B); break;
                default: v = Math.round(0.299 * R + 0.587 * G + 0.114 * B); break;
              }
              channel[i] = task.invert ? 255 - v : v;
            }
          }

          // 6) 目标蒙版上锁检测：全锁/像素锁都会阻止蒙版写入，提前报错避免静默失败
          const targetMeta = await this.getLayerMeta(d, task.targetLayerId);
          if (targetMeta && targetMeta.locked) {
            result = { synced: false, reason: 'target-locked' };
            return;
          }

          // 7) 读取目标蒙版
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

          // 8) 差异检测：无差异跳过
          //    channel 已含反相（mask 与非 mask 通道均在此前完成反相），
          //    因此「无需写入」在反相开启时等价于：样本通道 == 蒙版的反相
          let hasDiff = false;
          const cmpLen = Math.min(channel.length, maskRaw.length);
          for (let i = 0; i < cmpLen; i++) {
            if (channel[i] !== maskRaw[i]) {
              hasDiff = true;
              break;
            }
          }
          if (!hasDiff) {
            result = { synced: false, reason: 'unchanged', detail: task.invert ? '已按反相匹配' : undefined };
            return;
          }

          // 9) 整图写回蒙版
          const imageData = await imaging.createImageDataFromBuffer(channel, {
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
    const enabled = tasks.filter(t => t.enabled && t.sampleLayerId && t.targetLayerId && t.channel);
    if (enabled.length === 0) {
      const pending = tasks.filter(t => t.enabled);
      const missingSample = pending.filter(t => !t.sampleLayerId);
      const missingTarget = pending.filter(t => !t.targetLayerId);
      const missingChannel = pending.filter(t => !t.channel);
      console.log(
        `[蒙版同步] syncAll：无完整任务（启用${pending.length}个，` +
        `其中缺样本引用 ${missingSample.length} 个、缺目标引用 ${missingTarget.length} 个、缺通道 ${missingChannel.length} 个）`
      );
      return;
    }
    for (const task of enabled) {
      const r = await this.syncTask(task, d);
      console.log(`🔄 蒙版同步[${task.name}]: ${r.synced ? '✓ 已写入蒙版' : '跳过(' + r.reason + ')'}`);
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
      // 样本层：
      // - id 仍有效（同一会话内 PS 的 layer id 是唯一且不复用的）→ 保留引用，
      //   仅当类型不再合法时清空；图层改名/移动时同步更新 path/name（不因改名清引用）
      // - id 失效（图层被删 / 文档重开）→ 按名称路径重解析
      if (t.sampleLayerPath && t.sampleLayerPath.length) {
        const cur = t.sampleLayerId != null ? byId.get(t.sampleLayerId) : undefined;
        if (cur) {
          const typeOk = cur.kind === 'pixel' || cur.isAdjustment || cur.isBackground || (cur.kind === 'group' && cur.hasUserMask);
          if (!typeOk) {
            t.sampleLayerId = null;
            changed = true;
          } else if (cur.path.join('/') !== t.sampleLayerPath.join('/') || t.sampleLayerName !== cur.name) {
            t.sampleLayerPath = cur.path; // 图层改名/移动：跟随最新路径
            t.sampleLayerName = cur.name;
            changed = true;
          }
        } else {
          const hit = this.resolveLayerByPath(entries, t.sampleLayerPath);
          if (hit && (hit.kind === 'pixel' || hit.isAdjustment || hit.isBackground || (hit.kind === 'group' && hit.hasUserMask))) {
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
        if (cur) {
          if (!cur.hasUserMask) {
            t.targetLayerId = null;
            changed = true;
          } else if (cur.path.join('/') !== t.targetLayerPath.join('/') || t.targetLayerName !== cur.name) {
            t.targetLayerPath = cur.path; // 图层改名/移动：跟随最新路径
            t.targetLayerName = cur.name;
            changed = true;
          }
        } else {
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

  /** 获取文档像素尺寸。优先用 UXP DOM 的 doc.width/height（官方文档明确为像素单位），
   *  失败时回退 batchPlay（point 值 ×分辨率/72，与 ClearHandler.getSelectionData 一致）。 */
  private async getDocPixelSize(doc: any): Promise<{ width: number; height: number } | null> {
    try {
      // ① UXP DOM 属性（像素单位，最直接、无单位歧义）
      const w = Math.round(doc.width || 0);
      const h = Math.round(doc.height || 0);
      if (w > 0 && h > 0) {
        return { width: w, height: h };
      }
      // ② 回退：batchPlay（point 值 × 分辨率/72 = 像素，与 ClearHandler 一致）
      const result = await action.batchPlay([
        {
          _obj: 'get',
          _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
          _options: { dialogOptions: 'dontDisplay' },
        },
      ], { synchronousExecution: true });
      const info = result && result[0];
      if (info && info.width && info.height) {
        const res = (info.resolution && info.resolution._value) || 72;
        const width = Math.round(info.width._value * res / 72);
        const height = Math.round(info.height._value * res / 72);
        if (width > 0 && height > 0) return { width, height };
      }
      return null;
    } catch (e) {
      console.warn('⚠️ 获取文档尺寸失败:', e);
      return null;
    }
  }

  /** 查找图层对象（含类型标记与 bounds）。返回 isBackground/isAdjustment/bounds。
   *  背景图层 getPixels 只有 RGB 三通道（无 A）；调整图层没有像素内容。
   *  与项目 pixelDataProcessor.processPixelData 的标准做法一致（直接用 UXP DOM
   *  的 layer.bounds 属性），避免 batchPlay get layer 返回 bounds 单位不一致的问题。 */
  private async getLayerMeta(
    doc: any,
    layerId: number
  ): Promise<{
    isBackground: boolean;
    isAdjustment: boolean;
    isGroup: boolean;
    locked: boolean;
    bounds: { left: number; top: number; right: number; bottom: number };
  } | null> {
    try {
      const d = app.activeDocument;
      if (!d || !doc || d.id !== doc.id) return null;
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
      const kind = (layer as any)?.kind || '';
      // 全锁或像素锁都会阻止蒙版写入；二者任一为真即视为上锁
      const locked = !!(layer as any)?.allLocked || !!(layer as any)?.pixelsLocked;
      return {
        isBackground: !!(layer as any)?.isBackgroundLayer,
        isAdjustment: isAdjustmentKind(kind),
        isGroup: kind === 'group',
        locked,
        bounds: {
          left: Math.round(b.left || 0),
          top: Math.round(b.top || 0),
          right: Math.round(b.right || 0),
          bottom: Math.round(b.bottom || 0),
        },
      };
    } catch (e) {
      console.warn('⚠️ 获取图层信息失败:', e);
      return null;
    }
  }

  /** 获取样本图层自身的用户蒙版（单通道 DocWidth*DocHeight 数组）。
   *  若样本图层没有蒙版，返回全 255（白 = 完全显示，等价于无蒙版）。 */
  private async getSampleMaskChannel(
    doc: any,
    layerId: number,
    docW: number,
    docH: number
  ): Promise<Uint8Array> {
    const out = new Uint8Array(docW * docH);
    try {
      const maskImg: any = await imaging.getLayerMask({
        documentID: doc.id,
        layerID: layerId,
        kind: 'user',
        sourceBounds: { left: 0, top: 0, right: docW, bottom: docH },
        componentSize: 8,
      });
      const data = new Uint8Array(await maskImg.imageData.getData());
      const n = Math.min(data.length, out.length);
      out.set(data.subarray(0, n));
      maskImg.imageData.dispose();
    } catch (e) {
      console.warn('⚠️ 蒙版同步：样本图层蒙版读取失败（无蒙版或不可用），按全白处理', e);
      out.fill(255);
    }
    return out;
  }

  private docKeyOf(doc: any): string {
    return (doc && doc.name) || '';
  }

  private fpKey(docKey: string, taskId: string): string {
    return docKey + '|' + taskId;
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
    // 逐个注册：UXP 对事件数组中的非法事件名会整体抛错，逐个注册可保证
    // 单个事件不支持时不影响其他事件（避免监听整体失效）。
    // ⚠️ 注意：addNotificationListener 的第一个参数必须是【数组】（与 app.tsx
    // 一致）；传字符串会报 "Argument 1 has an invalid type. Expected type: array
    // actual type: string"，导致监听完全注册失败。
    for (const evt of NOTIF_EVENTS) {
      try {
        action.addNotificationListener([evt] as any, this.handleNotification);
      } catch (e) {
        console.warn(`⚠️ 蒙版同步通知监听注册失败: ${evt}`, e);
      }
    }
  }

  private handleNotification = (event?: any) => {
    try {
      // 节流打印事件（避免高频操作刷屏）
      const now = Date.now();
      if (now - (this.lastNotifLogAt || 0) > 800) {
        this.lastNotifLogAt = now;
        const evtName = typeof event === 'string' ? event : (event as any)?.eventName || '';
        console.log(`[蒙版同步] 收到事件: ${evtName || '(unknown)'}`);
      }
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
      const key = this.currentDocKey;
      const list = this.persisted[key] || [];
      // 仅当图层结构签名变化时才按路径重解析引用（避免每次同步都全文档 batchPlay）
      const sig = this.docSignature();
      const sigChanged = sig !== this.lastDocSignature;
      this.lastDocSignature = sig;
      const hasPaths = list.some(t => (
        (t.sampleLayerPath && t.sampleLayerPath.length) ||
        (t.targetLayerPath && t.targetLayerPath.length)
      ));
      if (sigChanged && hasPaths) {
        const changed = await this.reconcileTasks();
        if (changed) this.notify();
      }
      await this.syncAll(d);
      this.notify(); // 同步完成后刷新面板上的同步状态
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
        const keyChanged = prevKey !== this.currentDocKey;
        if (keyChanged) {
          this.lastDocSignature = ''; // 强制下次 reconcile
          this.notify(); // React 侧重新加载当前文档任务 + 刷新文件树
          this.scheduleSync(300);
          return;
        }
        // 兜底同步：即使事件驱动失效（如 set 事件未触发），也周期性执行启用任务的
        // 同步。syncTask 内部有 unchanged 差异检测 + 150ms 节流，内容一致时不会写入，
        // 不会造成写回震荡。
        this.doTimedSync();
      } catch {}
    }, POLL_INTERVAL_MS);
  }

  private notify(): void {
    const docChanged = this.currentDocKey !== this.lastNotifiedDocKey;
    this.lastNotifiedDocKey = this.currentDocKey;
    const results = { ...this.lastSyncResults };
    this.listeners.forEach(fn => {
      try {
        fn({ docChanged, results });
      } catch {}
    });
  }
}

/** 便捷的单例引用。 */
export const maskSyncEngine = MaskSyncEngine.instance;
