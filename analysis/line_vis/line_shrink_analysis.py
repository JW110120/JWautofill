# -*- coding: utf-8 -*-
"""分析 v3 线宽变化来源：逐行线宽 + 边缘剖面。"""
import numpy as np
from line_smooth_proto_v3 import parse_log

src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
a = parse_log(src)
res = np.load(r'F:\Coding\JWautofill\analysis\line_vis\v3_res.npy')

line = a > 16
res_line = res > 16

# 哪些像素从线内变线外（变细）
shrink = line & ~res_line
grow = ~line & res_line
print(f'变细像素: {shrink.sum()}, 变粗像素: {grow.sum()}')

# 变细像素的分布
ys, xs = np.nonzero(shrink)
if len(ys):
    print(f'变细像素范围: y {ys.min()}..{ys.max()}, 原 alpha 分布:')
    vals = a[ys, xs]
    for lo in range(0, 256, 32):
        n = ((vals >= lo) & (vals < lo + 32)).sum()
        print(f'  alpha {lo}-{lo+31}: {n}')
    print(f'变细像素的 dist_in:')
    from scipy import ndimage
    dist_in = ndimage.distance_transform_edt(line)
    dv = dist_in[ys, xs]
    print(f'  dist_in: min {dv.min():.1f}, mean {dv.mean():.1f}, <1.5 占比 {(dv<1.5).mean()*100:.0f}%')

# 逐行线宽变化 top 行
w0 = line.sum(axis=1)
w1 = res_line.sum(axis=1)
delta = w1 - w0
idx = np.argsort(delta)
print('\n变细最多的 8 行:')
for i in idx[:8]:
    print(f'  y={i}: {w0[i]} -> {w1[i]} ({delta[i]:+d})')
print('变粗最多的 8 行:')
for i in idx[::-1][:8]:
    print(f'  y={i}: {w0[i]} -> {w1[i]} ({delta[i]:+d})')
