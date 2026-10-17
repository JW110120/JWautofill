"""零依赖 Wintab 侦察（不注入、不模拟输入，只读信息）。

目的（回答真机日志里的两个疑点）：
  1. LOGCONTEXT 里 lcPktData 的**真实字节偏移**是多少？（hook 里硬编码 64）
  2. WTI_DEVICES / DVC_X 的真实数值是多少？（hook 里写的是 0 / 1，日志里的 32767
     也可能是「读不到就兜底」的常量，看不出来）

只调用 WTInfoA（只读查询），不 WTOpen、不改任何状态。
"""
import ctypes
import struct
import sys

try:
    wt = ctypes.WinDLL("WinTab32.dll")
except OSError as e:
    print("LoadLibrary WinTab32.dll 失败:", e)
    sys.exit(1)

WTInfoA = wt.WTInfoA
WTInfoA.restype = ctypes.c_uint
WTInfoA.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p]

BUFSZ = 512
buf = ctypes.create_string_buffer(BUFSZ)


def q(cat, idx, nbytes=BUFSZ):
    ctypes.memset(buf, 0, BUFSZ)
    r = WTInfoA(cat, idx, ctypes.byref(buf))
    if not r:
        return None
    return bytes(buf[:nbytes])


def dump(tag, data):
    print(f"\n--- {tag} ---")
    for i in range(0, min(len(data), 160), 16):
        row = " ".join(f"{b:02X}" for b in data[i:i + 16])
        print(f"  +{i:04X}  {row}")


print("=== 1) 找 WTI_DEFCONTEXT / WTI_DEFSYSCTX（LOGCONTEXT 大小恒为 ~172） ===")
for cat in range(0, 10):
    for idx in (0,):
        d = q(cat, idx, 256)
        if not d:
            continue
        nz = sum(1 for b in d if b)
        if nz > 20:                      # 像结构体而不是标量
            print(f"  cat={cat} idx={idx}: 非零字节 {nz} 个")
    # 只关心 3/4 两个类别，单独 dump
for cat, name in ((3, "WTI_DEFCONTEXT?"), (4, "WTI_DEFSYSCTX?")):
    d = q(cat, 0, 256)
    if d:
        dump(f"cat={cat} ({name})", d)
        print("  u32@56=%08X u32@60=%08X u32@64=%08X u32@68=%08X u32@72=%08X" % (
            struct.unpack_from("<I", d, 56)[0],
            struct.unpack_from("<I", d, 60)[0],
            struct.unpack_from("<I", d, 64)[0],
            struct.unpack_from("<I", d, 68)[0],
            struct.unpack_from("<I", d, 72)[0],
        ))
        print("  lcName =", d[:40].split(b"\x00")[0])

print("\n=== 2) 扫 WTI_DEVICES：找哪个 cat 能返回 AXIS(axMin,axMax,units,res) ===")
for cat in range(0, 10):
    for idx in range(0, 45):
        d = q(cat, idx, 16)
        if not d:
            continue
        axMin, axMax, units, res = struct.unpack_from("<iiII", d, 0)
        # AXIS 的特征：axMin 小、axMax 是几千~几十万、units/res 有量级
        if 0 <= axMin < 100000 and 1000 <= axMax <= 10 ** 7:
            print(f"  cat={cat} idx={idx}: axMin={axMin} axMax={axMax} units={units} res={res}")
