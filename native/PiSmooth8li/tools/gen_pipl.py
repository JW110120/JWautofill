#!/usr/bin/env python3
"""生成 PiPL 二进制资源（格式由 MouseHookPro64.8li / MaterialSuite.8li 真机逆向得出）。

格式（2026-10-14 破解，证据见 build/sample_mousehook_pipl.bin）：
    头部 10 字节: `01 00 | 00 00 00 00 | count(u32)`
    每个属性:     '8BIM'(文件字节序存为 MIB8) + 属性名四字(字节反转) +
                  0x00000000 + 数据长度(u32) + 数据(按 4 字节对齐补零)
    属性名真机样本: dnik='kind' eman='name' gtac='catg' srev='vers'
                    4668='8664'(x64 入口导出名!) tsrp='prst'
    kind 值 '8LIZ'（文件字节 "ZIL8"）= Automation(.8li) 类；PS2026 的
    MouseHookPro64.8li（Lazy Nezumi Pro）与 MaterialSuite.8li 均为此 kind。

用法: python gen_pipl.py <输出.bin> [名字] [入口导出名]
"""

import struct
import sys


def pstr(s: str) -> bytes:
    """Pascal 风格字符串：长度字节 + 内容 + 补零到 4 字节对齐（含长度字节）。"""
    b = s.encode("ascii")
    data = bytes([len(b)]) + b
    return data + b"\x00" * (-len(data) % 4)


def cstr(s: str) -> bytes:
    """C 风格字符串：内容 + NUL + 补零到 4 字节对齐。

    ⛔ '8664'（入口导出名）用 C 字符串，不是 Pascal——真机标本
    MouseHookPro64.8li 里该属性 = "PluginMain\\0\\0"，无长度前缀字节。
    写成 Pascal 会让 PS 读到 "\\x0eAutoPluginMain" ⇒ GetProcAddress
    失败 ⇒ 静默拒载（attach 后 1ms 卸载、入口零调用，2026-10-14 真机坑）。
    """
    b = s.encode("ascii") + b"\x00"
    return b + b"\x00" * (-len(b) % 4)


def prop(tag: str, data: bytes) -> bytes:
    assert len(tag) == 4
    return b"MIB8" + tag[::-1].encode("ascii") + struct.pack("<II", 0, len(data)) + data + b"\x00" * (-len(data) % 4)


def build(name: str, entry: str) -> bytes:
    props = [
        prop("kind", b"8LIZ"[::-1]),   # Automation 类（文件字节序与真机样本一致："ZIL8"）
        prop("name", pstr(name)),
        prop("catg", pstr("**Hidden**")),
        prop("vers", bytes([0x00, 0x00, 0x01, 0x00])),  # 与真机样本一致
        prop("8664", cstr(entry)),     # x64 入口导出名（C 字符串，⛔ 见 cstr 注释）
        prop("prst", struct.pack("<I", 1)),
    ]
    return struct.pack("<H", 1) + b"\x00\x00\x00\x00" + struct.pack("<I", len(props)) + b"".join(props)


if __name__ == "__main__":
    out = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else "JWautofill Smooth"
    entry = sys.argv[3] if len(sys.argv) > 3 else "AutoPluginMain"
    blob = build(name, entry)
    open(out, "wb").write(blob)
    print(f"PiPL {len(blob)} 字节 → {out}  (name={name!r} entry={entry!r})")
