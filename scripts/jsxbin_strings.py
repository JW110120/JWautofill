#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
jsxbin_strings.py — 从 JSXBIN（`@JSXBIN@ES@2.0@…`）编码的 ExtendScript 里
把**字符串字面量**还原出来。

用途：逆向分析时，脚本结构被混淆了，但字面量（ActionManager 键名、charID、
文件路径、参数名）几乎承载了全部语义。只还原字面量就能读懂一条脚本在干什么，
不必还原控制流，也不必执行原始代码。

编码规则（从样本实测归纳，非官方文档）：
    · 字面量整体形如   Fe<长度><内容>ff
      - 长度：单字符时 = chr(0x41 + n)（n<=26 常见）；两位数时 = 'h' + chr(n + 0x21)
      - 内容：用「标记 + 字符」两两成对，标记决定该字符所在区间
    · 标记表：
        'j' + c → chr(c + 0x1F)   小写字母
        'i' + c → chr(c - 1)      大写字母
        'h' + c → chr(c - 0x21)   数字与标点
    · 原文里会有按固定宽度插入的换行，**可能正好把一对拆开** ⇒ 先去掉所有换行再解。

用法：
    python scripts/jsxbin_strings.py <file.jsx> [more.jsx ...]
    python scripts/jsxbin_strings.py --dir <目录>      # 批量（只打印按文件名排序的前 N）

注意：本工具只做「字面量还原」，产物用于理解机制；不要把还原结果当成可运行源码。
"""

import argparse
import os
import sys

MARKERS = {
    "j": 0x1F,
    "i": -1,
    "h": -0x21,
}


def decode_body(body: str) -> tuple:
    """返回 (长度字段, 还原后的字符串)。长度字段不可信时返回 -1。"""
    if not body:
        return -1, ""
    if body[0] == "h" and len(body) > 2:
        declared = ord(body[1]) - 0x21
        payload = body[2:]
    else:
        declared = ord(body[0]) - 0x41
        payload = body[1:]

    out = []
    i = 0
    n = len(payload)
    while i < n:
        c = payload[i]
        if c in MARKERS and i + 1 < n:
            out.append(chr(ord(payload[i + 1]) + MARKERS[c]))
            i += 2
        else:
            out.append(c)
            i += 1
    return declared, "".join(out)


def extract(text: str):
    """产出 (偏移, 声明的长度, 字符串)。"""
    text = text.replace("\r", "").replace("\n", "")
    idx = 0
    while True:
        a = text.find("Fe", idx)
        if a < 0:
            return
        b = text.find("ff", a + 2)
        if b < 0:
            return
        declared, s = decode_body(text[a + 2:b])
        yield a, declared, s
        idx = b + 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*", help="一个或多个 .jsx 文件")
    ap.add_argument("--dir", help="批量处理目录下的 *.jsx")
    ap.add_argument("--max-len", type=int, default=200, help="超过该长度的字面量折叠显示（0=不折叠）")
    args = ap.parse_args()

    files = list(args.paths)
    if args.dir:
        files += [os.path.join(args.dir, f) for f in sorted(os.listdir(args.dir)) if f.endswith(".jsx")]

    for p in files:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            data = f.read()
        print("=== %s ===" % os.path.basename(p))
        for off, declared, s in extract(data):
            shown = s
            if args.max_len and len(shown) > args.max_len:
                shown = shown[: args.max_len] + "…(%d chars)" % len(s)
            flag = "" if declared == len(s) else "  <长度字段 %d ≠ %d>" % (declared, len(s))
            print("  %6d  %r%s" % (off, shown, flag))
        print()


if __name__ == "__main__":
    sys.exit(main() or 0)
