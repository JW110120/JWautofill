# -*- coding: utf-8 -*-
"""分析 v1 输出 vs 输入：哪些像素变了、方向平滑是否生效。"""
import numpy as np
from line_smooth_proto_v1 import parse_log

src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
a = parse_log(src)
res = np.load(r'F:\Coding\JWautofill\analysis\line_vis\v1_res.npy')

diff = res - a
changed = diff != 0
print(f'改变的像素: {changed.sum()} / {a.size}')

# 改变的像素分布在哪
ys, xs = np.nonzero(changed)
if len(ys):
    print(f'改变范围: x {xs.min()}..{xs.max()}, y {ys.min()}..{ys.max()}')
    # 线内/线外
    line = a > 16
    print(f'线内改变: {(changed & line).sum()}, 线外改变: {(changed & ~line).sum()}')
    # 改变量分布
    print(f'改变量: min {diff[changed].min():.0f}, max {diff[changed].max():.0f}, 均值 {diff[changed].mean():.2f}')
    print(f'正向(提升) {(diff>0).sum()}, 负向(降低) {(diff<0).sum()}')

# 看一条线 y=50 上的 alpha 剖面：输入 vs 输出
print('\ny=50 alpha 剖面 (x=0..40):')
for x in range(0, 42, 2):
    print(f'x{x}: {a[50,x]:5.0f}->{res[50,x]:5.0f}  ', end='')
print()

# 顶部主线 y=12 剖面
print('\ny=12 alpha 剖面 (x=0..30):')
for x in range(0, 32, 2):
    print(f'x{x}: {a[12,x]:5.0f}->{res[12,x]:5.0f}  ', end='')
print()

# 反复描线区域 y=28（主线+第二支）
print('\ny=28 alpha 剖面 (x=0..45):')
for x in range(0, 46, 3):
    print(f'x{x}: {a[28,x]:5.0f}->{res[28,x]:5.0f}  ', end='')
print()
