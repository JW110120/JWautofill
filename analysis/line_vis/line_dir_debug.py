# -*- coding: utf-8 -*-
"""调试：检查结构张量方向场是否正确。"""
import re
import numpy as np
from scipy import ndimage
from line_smooth_proto_v1 import parse_log, structure_tensor_angle, sobel_grad

src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
a = parse_log(src)
h, w = a.shape
tan = structure_tensor_angle(a)

# 在 y=50 行附近检查切线角
print('y=50, x=0..40 的切线角(度):')
row = []
for x in range(0, 42, 2):
    t = np.degrees(tan[50, x])
    row.append(f'x{x}:{t:+.0f}')
print(' '.join(row))

# 检查一个线内点周围的结构张量
cx, cy = 8, 50
print(f'\n({cx},{cy}) alpha={a[cy,cx]:.0f}, 切线角={np.degrees(tan[cy,cx]):.1f}°')
gx, gy = sobel_grad(a)
print(f'梯度: gx={gx[cy,cx]:.1f}, gy={gy[cy,cx]:.1f}')

# 可视化：把切线画在 alpha 图上（ASCII，放大 2x 采样）
print('\nASCII 方向场（每2px采样一次，字符表示角度）:')
chars = '→↘↓↙←↖↑↗'
for y in range(0, h, 4):
    line_str = ''
    for x in range(0, w, 2):
        t = tan[y, x]
        deg = np.degrees(t)
        idx = int(round(((deg + 90) / 180) * 7)) % 8
        line_str += chars[idx]
    print(line_str)
