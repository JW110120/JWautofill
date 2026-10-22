/**
 * 笔刷库装载：从插件目录 brushes/ 读 library.json + 每支笔的 brush.json。
 *
 * 只读、纯数据，不碰 PS。加一支笔 = 加一个目录 + 在 library.json 里加一行，
 * 无需改代码（这是从样本机制里学到的唯一"必须抄"的设计：库要数据驱动）。
 */
import { storage } from 'uxp';
import type { BrushDef, BrushLibrary } from './types';

const lfs = storage.localFileSystem;

/** 插件根目录（dist/），brushes 随 copyWebpackPlugin 拷到这里 */
async function pluginFolder() {
    return lfs.getPluginFolder();
}

async function readJson<T>(path: string): Promise<T> {
    const folder = await pluginFolder();
    const entry = await folder.getEntry(path);
    const text = await entry.read();
    return JSON.parse(text) as T;
}

export interface LoadedLibrary {
    lib: BrushLibrary;
    brushes: BrushDef[];
}

/**
 * 读整个库。单支笔解析失败不应该让整个面板白屏：
 * 失败的那支跳过并在控制台留名，其余照常显示。
 */
export async function loadLibrary(): Promise<LoadedLibrary> {
    const lib = await readJson<BrushLibrary>('brushes/library.json');
    const list = await Promise.all(
        lib.brushes.map(async (item) => {
            try {
                return await readJson<BrushDef>(`brushes/${item.id}/brush.json`);
            } catch (e) {
                console.warn('[brushstudio] 跳过损坏的笔：', item.id, e);
                return null;
            }
        })
    );
    return { lib, brushes: list.filter((b): b is BrushDef => !!b) };
}

/** 预览图相对 index.html 的路径（dist/brushes/<id>/preview.png） */
export function previewSrc(id: string): string {
    return `./brushes/${id}/preview.png`;
}
