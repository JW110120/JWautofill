# -*- coding: utf-8 -*-
"""单像素调试：x=33,y=28 的方向平滑计算。"""
import numpy as np
from line_smooth_proto_v1 import parse_log, structure_tensor_angle, tangent_samples

src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
a = parse_log(src)
tan = structure_tensor_angle(a)

cy, cx = 28, 33
print(f'alpha={a[cy,cx]:.0f}, 切线角={np.degrees(tan[cy,cx]):.1f}°')
print(f'周围 7x7:')
for yy in range(cy-3, cy+4):
    row = ''
    for xx in range(cx-3, cx+4):
        row += f'{a[yy,xx]:4.0f}'
    print(row)

sx, sy = tangent_samples(140, 105, tan, cx, cy, 4)
print('\n采样点:')
for d in range(1, 5):
    for off in (-1, 0, 1):
        idx = (d-1)*3 + (off+1)
        x, y = sx[idx], sy[idx]
        xi, yi = int(round(x)), int(round(y))
        if 0 <= xi < 105 and 0 <= yi < 140:
            print(f'  d={d} off={off}: ({x:.2f},{y:.2f}) -> ({xi},{yi}) alpha={a[yi,xi]:.0f}')
        else:
            print(f'  d={d} off={off}: ({x:.2f},{y:.2f}) -> 越界')

# 手动算加权平均
a0 = a[cy, cx]
sigma_d = max(1.0, 4*0.45)
dist_w = np.exp(-(np.arange(0, 5)**2)/(2*sigma_d**2))
print(f'\ndist_w: {[f"{w:.3f}" for w in dist_w]}')
acc_w, acc_a = 1.0, a0*1.0
for d in range(1, 5):
    for off in (-1, 0, 1):
        idx = (d-1)*3 + (off+1)
        x, y = sx[idx], sy[idx]
        xi, yi = int(round(x)), int(round(y))
        if not (0 <= xi < 105 and 0 <= yi < 140):
            continue
        aj = a[yi, xi]
        w_off = 0.6 if off == 0 else (0.45 if abs(x-xi)+abs(y-yi) < 0.4 else 0.3)
        w_sim = np.exp(-abs(aj-a0)/90.0)
        w = dist_w[d]*w_off*w_sim
        acc_w += w
        acc_a += aj*w
print(f'\n平滑结果: {acc_a/acc_w:.1f} (原 {a0:.0f})')
