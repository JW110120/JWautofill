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
 * 只读 PNG 头部拿宽高（IHDR 就在第 16..24 字节，大端）。
 *
 * ⛔ 为什么不整个读进来再解：UXP 没有 zlib，解码 PNG 是给未来埋雷；
 *    而宽高只在文件头，读 8KB 就够判。图案换尺寸后这里自动跟着变，
 *    不需要任何人手改 brush.json（"图案尺寸是唯一权威"）。
 */
async function readPngSize(relPath: string): Promise<{ w: number; h: number } | null> {
    const folder = await pluginFolder();
    const entry: any = await folder.getEntry(relPath);
    // ⛔ 必须显式要 binary：默认 `entry.read()` 按文本读，二进制会被截断/乱码
    const buf: ArrayBuffer = await entry.read({ format: storage.formats.binary });
    const b = new Uint8Array(buf);
    if (b.length < 24) return null;
    // PNG 签名 89 50 4E 47 0D 0A 1A 0A
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const u32 = (o: number) => b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
    return { w: u32(16), h: u32(20) };
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
                const def = await readJson<BrushDef>(`brushes/${item.id}/brush.json`);
                // 混合器笔补上**真实**方形边长（图案长边）；读不出来就留空，
                // 面板显示 "—" 而不是拿 params 里那个作废值糊上去。
                if (def?.mixer?.pattern) {
                    try {
                        const size = await readPngSize(`brushes/${def.id}/${def.mixer.pattern}`);
                        if (size) def.mixerSize = Math.max(size.w, size.h);
                    } catch (e) {
                        console.warn('[brushstudio] 图案尺寸读不出来：', def.id, e);
                    }
                }
                return def;
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
