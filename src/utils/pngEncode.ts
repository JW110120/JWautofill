/**
 * 极简 PNG 编码器（8bit / Truecolor+Alpha，即 colorType=6）。
 *
 * ⛔ 为什么需要自己编码（2026-10-10 定论）：UXP 的 `imaging.encodeImageData` **只支持 JPEG**
 *    （官方类型定义原文：With the current version of UXP you must use jpeg/base64 encoding
 *    when assigning to an image element），JPEG 没有 alpha 通道 ⇒ 任何「需要透明」的像素
 *    都无法表达，只能补一块底色 —— 图案旋转预览的「四角补 --dark-bg-color，darkest 主题下
 *    近乎纯黑」就是这么来的。
 * ⛔ UXP 也没有 Canvas / zlib / node 的 zlib ⇒ 只能手写。
 *
 * 实现取舍：**不做压缩**，deflate 只发「存储块（BTYPE=00）」。
 *   - 数据量由调用方封顶（图案旋转预览的输出长边 ≤512 ⇒ ≤512×512×4 ≈ 1MB）；
 *   - 存储块 = 原始字节 + 每 64KB 5 字节头，膨胀率 ~0.008%；
 *   - 换成固定 Huffman 反而更大（每字节 8~9 bit），故存储块是这里的最优解；
 *   - 换来的是「零依赖 + 零算法风险」，格式绝对合法。
 */

/** CRC-32（PNG 每个 chunk 尾部的校验），查表法，表在模块加载时建一次。 */
const CRC_TABLE: number[] = (() => {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = (bytes: Uint8Array, start: number, end: number): number => {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
};

/** Adler-32（zlib 流尾部校验）。 */
const adler32 = (bytes: Uint8Array, start: number, end: number): number => {
    const MOD = 65521;
    let a = 1;
    let b = 0;
    for (let i = start; i < end; i++) {
        a += bytes[i];
        if (a >= MOD) a -= MOD;
        b += a;
        if (b >= MOD) b -= MOD;
    }
    return ((b << 16) | a) >>> 0;
};

const writeU32 = (dst: Uint8Array, offset: number, value: number) => {
    dst[offset] = (value >>> 24) & 0xff;
    dst[offset + 1] = (value >>> 16) & 0xff;
    dst[offset + 2] = (value >>> 8) & 0xff;
    dst[offset + 3] = value & 0xff;
};

const CHUNK_LEN = 12; // 4(长度) + 4(类型) + 数据 + 4(CRC)

/** 写入一个 chunk（type 为 4 个 ASCII 码），返回下一个 chunk 的起始下标。 */
const writeChunk = (
    dst: Uint8Array,
    offset: number,
    t0: number, t1: number, t2: number, t3: number,
    data: Uint8Array | null,
    dataStart: number,
    dataLen: number
): number => {
    writeU32(dst, offset, dataLen);
    dst[offset + 4] = t0;
    dst[offset + 5] = t1;
    dst[offset + 6] = t2;
    dst[offset + 7] = t3;
    for (let i = 0; i < dataLen; i++) {
        dst[offset + 8 + i] = data![dataStart + i];
    }
    // CRC 覆盖「类型 + 数据」，故直接把两段写成连续内存再算
    const crcBuf = new Uint8Array(4 + dataLen);
    crcBuf[0] = t0; crcBuf[1] = t1; crcBuf[2] = t2; crcBuf[3] = t3;
    if (dataLen > 0) crcBuf.set(data!.subarray(dataStart, dataStart + dataLen), 4);
    writeU32(dst, offset + 8 + dataLen, crc32(crcBuf, 0, crcBuf.length));
    return offset + CHUNK_LEN + dataLen;
};

const STORED_BLOCK_MAX = 65535;

/**
 * 把 RGBA8 像素编码为 PNG 字节流。
 * @param rgba 长度必须是 width * height * 4（直通 alpha，未预乘）
 */
export const encodePngRgba = (rgba: Uint8Array, width: number, height: number): Uint8Array => {
    const stride = width * 4;
    // 每行前置 1 字节 filter（恒为 0 = None）
    const rawLen = (stride + 1) * height;
    const raw = new Uint8Array(rawLen);
    for (let y = 0; y < height; y++) {
        const o = y * (stride + 1);
        raw[o] = 0;
        raw.set(rgba.subarray(y * stride, y * stride + stride), o + 1);
    }

    // zlib 流：2 字节头 + 存储块(5 字节头 + 数据) + 4 字节 Adler-32
    const blockCount = Math.max(1, Math.ceil(rawLen / STORED_BLOCK_MAX));
    const zlibLen = 2 + blockCount * 5 + rawLen + 4;
    const zlib = new Uint8Array(zlibLen);
    let p = 0;
    zlib[p++] = 0x78; // CM=8(deflate) + CINFO=7(32K 窗口)
    zlib[p++] = 0x01; // FLG：(0x78<<8|0x01) % 31 === 0，无预设字典、最快压缩档
    if (rawLen === 0) {
        zlib[p++] = 1; zlib[p++] = 0; zlib[p++] = 0; zlib[p++] = 0xff; zlib[p++] = 0xff;
    } else {
        for (let i = 0; i < rawLen; i += STORED_BLOCK_MAX) {
            const len = Math.min(STORED_BLOCK_MAX, rawLen - i);
            const isFinal = (i + len >= rawLen) ? 1 : 0;
            zlib[p++] = isFinal; // BFINAL(bit0) + BTYPE=00(存储块)
            zlib[p++] = len & 0xff;
            zlib[p++] = (len >>> 8) & 0xff;
            zlib[p++] = (~len) & 0xff;
            zlib[p++] = ((~len) >>> 8) & 0xff;
            zlib.set(raw.subarray(i, i + len), p);
            p += len;
        }
    }
    writeU32(zlib, p, adler32(raw, 0, rawLen));
    p += 4;

    // IHDR 数据：宽 4 + 高 4 + 位深 1 + 颜色类型 1 + 压缩 1 + 滤波 1 + 隔行 1
    const ihdr = new Uint8Array(13);
    writeU32(ihdr, 0, width);
    writeU32(ihdr, 4, height);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // colorType 6 = RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // interlace

    const total = 8 + (CHUNK_LEN + 13) + (CHUNK_LEN + zlibLen) + CHUNK_LEN;
    const png = new Uint8Array(total);
    // 签名
    png[0] = 137; png[1] = 80; png[2] = 78; png[3] = 71;
    png[4] = 13; png[5] = 10; png[6] = 26; png[7] = 10;
    let off = 8;
    off = writeChunk(png, off, 73, 72, 68, 82, ihdr, 0, 13);            // "IHDR"
    off = writeChunk(png, off, 73, 68, 65, 84, zlib, 0, zlibLen);       // "IDAT"
    writeChunk(png, off, 73, 69, 78, 68, null, 0, 0);                   // "IEND"
    return png;
};

/**
 * Uint8Array → base64（分块构建二进制串后一次 btoa）。
 * ⚠️ 不可逐字符 `bin += String.fromCharCode(b)`：1MB = 百万次字符串拼接，UXP 引擎下极慢
 *    （imported 图片时踩过同一个坑，见 PatternPicker.arrayBufferToBase64 的注释）。
 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(
            null,
            Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))) as unknown as number[]
        );
    }
    return btoa(bin);
};
