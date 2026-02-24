import type { Gradient } from '../types/state';
import { } from 'react';

/**
 * PanelStateManager
 * 在 Photoshop UXP 环境下持久化面板相关的 UI 状态（折叠、开关、分区顺序等）。
 * 存储位置：UXP 数据目录下的 settings/panel-state.json
 */
export type AppPanelState = {
  isEnabled?: boolean;
  isExpanded?: boolean;
  isSelectionOptionsExpanded?: boolean;
  autoUpdateHistory?: boolean;
  deselectAfterFill?: boolean;
  strokeEnabled?: boolean;
  createNewLayer?: boolean;
  clearMode?: boolean;
  fillMode?: 'foreground' | 'pattern' | 'gradient';
  selectedGradient?: Gradient | null;
};

export type AdjustmentPanelState = {
  sections?: Array<{ id: string; isCollapsed: boolean; isVisible: boolean; order: number }>;
  subFeatures?: Array<{ id: string; parentId: string; isVisible: boolean; order: number }>;
  // 新增：面板内的“开关”类状态
  toggles?: {
    useWeightedAverage?: boolean;
    preserveDetail?: boolean;
  };
  // 新增：全部数值类参数（滑块/数字输入）
  values?: {
    radius?: number;
    sigma?: number;
    weightedIntensity?: number;
    highFreqIntensity?: number;
    highFreqRange?: number;
    edgeAlphaThreshold?: number;
    edgeColorThreshold?: number;
    edgeSmoothRadius?: number;
    edgeIntensity?: number;
  };
};

export type PanelState = {
  appPanel?: AppPanelState;
  adjustmentPanel?: AdjustmentPanelState;
};

export class PanelStateManager {
  private static readonly SETTINGS_FOLDER = 'settings';
  private static readonly PANEL_STATE_FILE = 'panel-state.json';
  private static saveTimer: any = null;
  private static cache: PanelState | null = null;
  private static initializing = false;

  // 获取 UXP 的 localFileSystem
  private static async getLocalFS() {
    let localFileSystem: any;
    try {
      localFileSystem = require('uxp').storage.localFileSystem;
    } catch (_) {
      localFileSystem = (window as any)?.uxp?.storage?.localFileSystem;
    }
    if (!localFileSystem) throw new Error('无法获取 UXP localFileSystem');
    return localFileSystem;
  }

  // 获取存放状态的文件夹
  private static async getSettingsFolder() {
    const lfs = await this.getLocalFS();
    const dataFolder = await lfs.getDataFolder();
    let settingsFolder: any;
    try {
      settingsFolder = await dataFolder.getEntry(this.SETTINGS_FOLDER);
    } catch (_) {
      settingsFolder = await dataFolder.createFolder(this.SETTINGS_FOLDER);
    }
    return settingsFolder;
  }

  // 读取文件内容
  private static async readStateFile(): Promise<PanelState | null> {
    try {
      const folder = await this.getSettingsFolder();
      const file = await folder.getEntry(this.PANEL_STATE_FILE);
      const formats = require('uxp').storage.formats;
      const content = await file.read({ format: formats.utf8 });
      const json = JSON.parse(content);
      return (json || {}) as PanelState;
    } catch (_) {
      return null;
    }
  }

  // 原子写入（简单且可靠）：直接覆盖写入
  private static async writeStateFileWithRetry(state: PanelState): Promise<void> {
    const formats = require('uxp').storage.formats;
    let attempt = 0;
    let delay = 200;
    while (true) {
      try {
        const folder = await this.getSettingsFolder();
        const file = await folder.createFile(this.PANEL_STATE_FILE, { overwrite: true });
        await file.write(JSON.stringify(state ?? {}, null, 2), { format: formats.utf8 });
        return;
      } catch (e) {
        attempt++;
        console.warn(`面板状态写入失败，正在重试(${attempt})`, e);
        await new Promise(res => setTimeout(res, Math.min(5000, delay)));
        delay = Math.min(5000, Math.floor(delay * 1.5));
      }
    }
  }

  // 浅+递归合并（仅对象层级）
  private static deepMerge<T extends Record<string, any>>(base: T, update: Partial<T>): T {
    const out: any = { ...base };
    if (!update) return out;
    for (const k of Object.keys(update)) {
      const bv = (out as any)[k];
      const uv = (update as any)[k];
      if (uv && typeof uv === 'object' && !Array.isArray(uv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
        out[k] = this.deepMerge(bv, uv);
      } else if (uv !== undefined) {
        out[k] = uv;
      }
    }
    return out;
  }

  // 初始化：读取已有状态并与传入默认值合并
  static async initialize(defaults: PanelState = {}): Promise<PanelState> {
    if (this.initializing && this.cache) return this.cache;
    this.initializing = true;
    try {
      const existing = await this.readStateFile();
      const merged = this.deepMerge(defaults as any, existing || {});
      this.cache = merged;
      return merged;
    } catch (_) {
      this.cache = defaults || {};
      return this.cache;
    } finally {
      this.initializing = false;
    }
  }

  // 读取（不会触发文件访问，如果有缓存则直接返回）
  static async load(): Promise<PanelState> {
    if (this.cache) return this.cache;
    const existing = await this.readStateFile();
    this.cache = existing || {};
    return this.cache;
  }

  // 读取最新（强制从磁盘读取，覆盖缓存）
  static async loadLatest(): Promise<PanelState> {
    const existing = await this.readStateFile();
    this.cache = existing || {};
    return this.cache;
  }

  // 立即保存（将传入更新与缓存合并后写入磁盘）
  static async saveNow(updates?: Partial<PanelState>): Promise<void> {
    const current = this.cache || {};
    const next = updates ? this.deepMerge(current, updates) : current;
    this.cache = next;
    await this.writeStateFileWithRetry(next);
  }

  // 更新并可选防抖写入
  static async update(updates: Partial<PanelState>, options?: { debounceMs?: number }): Promise<void> {
    const debounceMs = options?.debounceMs ?? 300;
    const current = this.cache || (await this.load()) || {};
    this.cache = this.deepMerge(current, updates);

    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (debounceMs > 0) {
      this.saveTimer = setTimeout(async () => {
        this.saveTimer = null;
        try { await this.writeStateFileWithRetry(this.cache!); } catch (e) { console.error('保存面板状态失败:', e); }
      }, debounceMs);
    } else {
      try { await this.writeStateFileWithRetry(this.cache!); } catch (e) { console.error('保存面板状态失败:', e); }
    }
  }
}
