#!/usr/bin/env python3
"""从 PE 文件（.8li/.8bi/.dll）中提取资源，用于逆向 Adobe PiPL 资源的二进制格式。

用法:
    python pe_res_extract.py <pe文件> [--type PiPL] [--out <输出文件>] [--hexdump]

纯标准库实现（沙箱 pip 无网络）。支持类型目录条目为「字符串名（fourcc）」或「整数 ID」。
"""

import argparse
import struct
import sys


def read_sections(pe):
    """返回 [(va, vsize, raw_ptr, raw_size), ...]"""
    e_lfanew = struct.unpack_from("<I", pe, 0x3C)[0]
    assert pe[e_lfanew:e_lfanew + 4] == b"PE\0\0", "不是 PE 文件"
    coff = e_lfanew + 4
    nsec, opt_size = struct.unpack_from("<HH", pe, coff + 2)[0], struct.unpack_from("<H", pe, coff + 16)[0]
    opt = coff + 20
    magic = struct.unpack_from("<H", pe, opt)[0]
    pe32plus = magic == 0x20B
    dd_off = opt + (112 if pe32plus else 96)
    res_rva, res_size = struct.unpack_from("<II", pe, dd_off + 2 * 8)
    sec_off = opt + opt_size
    sections = []
    for i in range(nsec):
        b = sec_off + i * 40
        vsize, va, rsize, rptr = struct.unpack_from("<IIII", pe, b + 8)
        if vsize or rsize:
            sections.append((va, vsize, rptr, rsize))
    return res_rva, res_size, sections


def rva_to_off(rva, sections):
    for va, vsize, rptr, rsize in sections:
        if va <= rva < va + max(vsize, rsize):
            return rva - va + rptr
    return None


def walk_dir(pe, off):
    """遍历资源目录，产出 [(type, name, lang, data_rva, size)]"""
    n_named, n_id = struct.unpack_from("<HH", pe, off + 12)
    entries = []
    for i in range(n_named + n_id):
        e = off + 16 + i * 8
        name_field, eoff = struct.unpack_from("<II", pe, e)
        if eoff & 0x80000000:
            entries.append((name_field, eoff & 0x7FFFFFFF))
        else:
            entries.append((name_field, None))
    return entries


def dir_name(pe, field, base):
    if field & 0x80000000:
        off = base + (field & 0x7FFFFFFF)
        ln = struct.unpack_from("<H", pe, off)[0]
        return pe[off + 2:off + 2 + ln * 2].decode("utf-16le", errors="replace")
    return field


def extract(pe):
    """层级无关的资源树遍历：条目 OffsetToData 高位=1 → 子目录；=0 → 数据叶子。"""
    res_rva, _, sections = read_sections(pe)
    root = rva_to_off(res_rva, sections)
    assert root is not None, "找不到资源目录"

    def visit(off, path):
        n_named, n_id = struct.unpack_from("<HH", pe, off + 12)
        for i in range(n_named + n_id):
            name_field, eoff = struct.unpack_from("<II", pe, off + 16 + i * 8)
            label = dir_name(pe, name_field, root)
            if eoff & 0x80000000:
                yield from visit(root + (eoff & 0x7FFFFFFF), path + [label])
            else:
                drva, size, _cp, _rsv = struct.unpack_from("<IIII", pe, root + eoff)
                yield path + [label], drva, size

    out = []
    for path, drva, size in visit(root, []):
        ttype = path[0]
        nname = path[1] if len(path) > 1 else 0
        lang = path[2] if len(path) > 2 else 0
        out.append((ttype, nname, lang, drva, size))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pe")
    ap.add_argument("--type", default=None)
    ap.add_argument("--name", default=None, type=int)
    ap.add_argument("--out", default=None)
    ap.add_argument("--hexdump", action="store_true")
    ap.add_argument("--ascii", action="store_true", help="打印可读 ASCII 视图")
    a = ap.parse_args()

    pe = open(a.pe, "rb").read()
    items = extract(pe)
    print(f"资源条目数: {len(items)}")
    for ttype, nname, lang, rva, size in items:
        print(f"  type={ttype!r:>12} name={nname!r:>6} lang={lang} rva=0x{rva:X} size={size}")

    sel = [it for it in items if a.type is None or str(it[0]) == a.type]
    if a.type and a.name is not None:
        sel = [it for it in sel if it[1] == a.name]
    if not sel:
        return
    sections = read_sections(pe)[2]
    for ttype, nname, lang, rva, size in sel[:1]:
        off = rva_to_off(rva, sections)
        data = pe[off:off + size]
        if a.out:
            open(a.out, "wb").write(data)
            print(f"已写出 {len(data)} 字节 → {a.out}")
        if a.hexdump:
            for i in range(0, len(data), 16):
                chunk = data[i:i + 16]
                hx = " ".join(f"{b:02X}" for b in chunk)
                asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
                print(f"{i:06X}  {hx:<47}  {asc}")
        if a.ascii:
            txt = "".join(chr(b) if 32 <= b < 127 else "\n" for b in data)
            print(txt)


if __name__ == "__main__":
    sys.exit(main())
