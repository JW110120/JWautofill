"""确认 WTI_DEVICES / DVC_X 的真实数值（hook 里写的是 0/1，需要核实）。

做法：对 cat 0..9 × idx 0..40 调 WTInfoA，打印所有「返回成功且像 AXIS」的原始 16 字节。
AXIS = { int axMin; int axMax; UINT axUnits; UINT axResolution; }
"""
import ctypes
import struct

wt = ctypes.WinDLL("WinTab32.dll")
WTInfoA = wt.WTInfoA
WTInfoA.restype = ctypes.c_uint
WTInfoA.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p]

BUFSZ = 128
buf = ctypes.create_string_buffer(BUFSZ)

# 默认上下文里读到的 lcInExtX / lcInExtY（偏移 96 / 100），用作对照
d = ctypes.create_string_buffer(256)
WTInfoA(4, 0, ctypes.byref(d))
raw = bytes(d[:256])
in_ext_x = struct.unpack_from("<i", raw, 96)[0]
in_ext_y = struct.unpack_from("<i", raw, 100)[0]
print(f"默认上下文 lcInExtX={in_ext_x}  lcInExtY={in_ext_y}  （对照用）\n")

print("cat/idx 扫描（只打印返回成功且 axMin==0 且 axMax>0 的项）：")
for cat in range(0, 10):
    hits = []
    for idx in range(0, 41):
        ctypes.memset(buf, 0, BUFSZ)
        r = WTInfoA(cat, idx, ctypes.byref(buf))
        if not r:
            continue
        b = bytes(buf[:16])
        axMin, axMax, units, res = struct.unpack_from("<iiII", b, 0)
        if axMin == 0 and axMax > 0:
            hits.append((idx, axMin, axMax, units, res))
    if hits:
        print(f"  cat={cat}:")
        for idx, axMin, axMax, units, res in hits:
            mark = ""
            if axMax == in_ext_x:
                mark = "   <== == lcInExtX  (这就是 DVC_X)"
            elif axMax == in_ext_y:
                mark = "   <== == lcInExtY  (这就是 DVC_Y)"
            print(f"    idx={idx}: axMin={axMin} axMax={axMax} units={units} res={res}{mark}")

# 顺便确认 X/Y 轴各自的上界（用上面找到的 cat + idx 就不必硬猜了）
print("\n结论所需的两个常量请从上表读取。")
