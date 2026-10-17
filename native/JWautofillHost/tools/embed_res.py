#!/usr/bin/env python3
"""把 PiPL 二进制作为 'PIPL' 资源（ID 16000, 语言 0x409）嵌入 PE（.dll → .8li）。

不走 rc.exe（本机无 MSVC/Windows SDK），直接调 kernel32 UpdateResource。
真机标本核对：MouseHookPro64.8li 的树为 字符串类型名 'PIPL' + ID 16042 + lang 1033；
我们统一用 ID 16000（Adobe 自家 Automate 插件同款）。

用法: python embed_res.py <输入.dll> <PiPL.bin> <输出.8li>
"""

import ctypes
import ctypes.wintypes as wt
import shutil
import struct
import sys

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

BeginUpdateResourceW = kernel32.BeginUpdateResourceW
BeginUpdateResourceW.argtypes = [wt.LPCWSTR, wt.BOOL]
BeginUpdateResourceW.restype = wt.HANDLE

UpdateResourceW = kernel32.UpdateResourceW
UpdateResourceW.argtypes = [wt.HANDLE, wt.LPCWSTR, wt.LPCWSTR, wt.WORD, wt.LPVOID, wt.DWORD]
UpdateResourceW.restype = wt.BOOL

EndUpdateResourceW = kernel32.EndUpdateResourceW
EndUpdateResourceW.argtypes = [wt.HANDLE, wt.BOOL]
EndUpdateResourceW.restype = wt.BOOL

RT_PIPL = "PIPL"
RES_ID = 16000
LANG = 0x0409


def main():
    src, pipl_path, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    blob = open(pipl_path, "rb").read()
    shutil.copyfile(src, dst)

    h = BeginUpdateResourceW(dst, False)
    if not h:
        print(f"BeginUpdateResource 失败: {ctypes.get_last_error()}")
        return 1
    ok = UpdateResourceW(h, RT_PIPL, ctypes.c_wchar_p(RES_ID), LANG, blob, len(blob))
    if not ok:
        print(f"UpdateResource 失败: {ctypes.get_last_error()}")
        EndUpdateResourceW(h, True)
        return 1
    if not EndUpdateResourceW(h, False):
        print(f"EndUpdateResource 失败: {ctypes.get_last_error()}")
        return 1
    print(f"已嵌入 {RT_PIPL} id={RES_ID} ({len(blob)} 字节) → {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
