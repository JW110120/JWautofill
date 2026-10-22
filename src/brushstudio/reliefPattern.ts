/**
 * 混合器**储层图案**的运行时生成 + 上色（Krita 印章笔公式的 JS 版）。
 *
 * ── 这个文件替代了什么 ──────────────────────────────────────────────
 * 2026-10-22 上午的方案是「PS 里跑通道混合器给图案上色」。走通 B 方案（原生合成
 * Alt+点）之后这条弯路可以整体砍掉：图案的像素**本来就是我们自己写进临时文档**的
 * （`imaging.putPixels`），上色在 JS 里一步乘法就完了 ——
 * 没有命令、没有失败、没有描述符键名要猜。
 *
 * ── 公式（与 `scripts/build_mixer_pattern.py` 逐项对齐）─────────────────
 *   RGB   = 前景色 × luma^0.6          ← 明暗决定"这一块颜料多厚"
 *   alpha = cover_mask(luma, .04, .30)^0.85  ← **覆盖度**，不是亮度
 *
 * ⛔⛔ 两条都别再改回去：
 *   · 直接把亮度当 alpha ⇒ 沟槽半透明 + 颜色又被乘暗 = 一坨暗红泥（10-22 预览实证）；
 *     颜料是不透明的，明暗只走 RGB。
 *   · 用「常量」上色（`+ c`）是加法 ⇒ v≥0.5 就削顶，一半层次被压平。
 *     要 `v × 前景色` 只能用**乘法**（这里就是 `fg * luma`）。
 */

export interface PatternBuf {
    width: number;
    height: number;
    /** RGBA，直序（非预乘），与 `imaging.createImageDataFromBuffer` 的 pixelFormat:'RGBA' 对应 */
    data: Uint8Array;
}

export interface Rgb { red: number; green: number; blue: number }

/** 明暗 gamma：抬中间调，让"有厚度的颜料"不糊成黑片 */
const GAMMA_RGB = 0.6;
/** 形状 gamma：轮廓比明暗更实一点 */
const GAMMA_ALPHA = 0.85;
/** 覆盖度斜坡：低于 floor 全透（笔丝间隙），高于 ceil 全实 */
const COVER_FLOOR = 0.04;
const COVER_CEIL = 0.30;

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 32 位整数哈希 → 0..1（deterministic，不用 Math.random：同一支笔每次都得一样） */
function hash2(x: number, y: number, seed: number): number {
    let h = (x * 374761393 + y * 668265263 + seed * 1013904223) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177) | 0;
    h = (h ^ (h >>> 16)) | 0;
    return (h >>> 0) / 4294967295;
}

function smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
}

/** 双线性平滑的值噪声 */
function valueNoise(x: number, y: number, seed: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smoothstep(x - xi);
    const ty = smoothstep(y - yi);
    const a = hash2(xi, yi, seed);
    const b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed);
    const d = hash2(xi + 1, yi + 1, seed);
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
}

/**
 * 造一张 0..1 的浮雕高度图（fBm + 山脊化）。
 *
 * 为什么是「山脊」：颜料堆起来是一条条亮脊 + 暗沟，纯 fBm 出来像云不像颜料。
 * `1-|2v-1|` 把平滑噪声折成尖脊，正好是"刀尖推过"的形状。
 */
function buildRelief(side: number, seed: number): Float32Array {
    const out = new Float32Array(side * side);
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            let v = 0;
            let amp = 1;
            let sum = 0;
            let freq = 1 / 96;
            for (let o = 0; o < 4; o++) {
                v += valueNoise(x * freq, y * freq, seed + o * 17) * amp;
                sum += amp;
                amp *= 0.55;
                freq *= 2.1;
            }
            v /= sum;
            const ridge = 1 - Math.abs(2 * v - 1);
            const m = 0.55 * v + 0.45 * ridge;
            out[y * side + x] = m;
            if (m < lo) lo = m;
            if (m > hi) hi = m;
        }
    }
    // 线性拉伸到满量程：不拉的话整张图只有中间一小段，浮雕会"雾里看花"
    const span = hi - lo;
    if (span > 1e-6) {
        for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / span;
    }
    return out;
}

/**
 * 生成一张可直接 `putPixels` 的储层图案（已按前景色上好色）。
 *
 * @param fg   前景色（0..255）
 * @param side 方形边长 = 储层要吸的边长（px），务必与笔刷直径同量级
 * @param seed 图案种子：换一笔想换纹理就改它，保持不变则每次完全一致
 */
export function buildReservoirPattern(fg: Rgb, side = 400, seed = 7): PatternBuf {
    const s = Math.max(32, Math.round(side));
    const relief = buildRelief(s, seed);
    const data = new Uint8Array(s * s * 4);
    const r0 = Math.round(fg.red);
    const g0 = Math.round(fg.green);
    const b0 = Math.round(fg.blue);
    const aSpan = (COVER_CEIL - COVER_FLOOR) * 255;

    for (let i = 0; i < relief.length; i++) {
        const v = relief[i] * 255;                       // 0..255 高度
        const l = 255 * Math.pow(v / 255, GAMMA_RGB);    // 明暗
        const t = clamp01((v - COVER_FLOOR * 255) / aSpan);
        const a = 255 * Math.pow(t, GAMMA_ALPHA);        // 覆盖度
        const k = l / 255;
        const j = i * 4;
        data[j] = r0 * k;
        data[j + 1] = g0 * k;
        data[j + 2] = b0 * k;
        data[j + 3] = a;
    }
    return { width: s, height: s, data };
}
