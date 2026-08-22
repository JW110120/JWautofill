# -*- coding: utf-8 -*-
"""分析平滑线条样本的 alpha 统计特征，为重构仅主线条平滑算法提供依据。"""
import re
import numpy as np

LOG_LINE = re.compile(r'^(?:AdjustmentPanel\.tsx:\d+\s+)?y=(\d+):\s*(.*)$')

def parse_log(path):
    grid = {}
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            m = LOG_LINE.match(line)
            if not m:
                continue
            grid[int(m.group(1))] = [int(v) for v in m.group(2).split(',')]
    h = max(grid.keys()) + 1
    w = max(len(v) for v in grid.values())
    a = np.zeros((h, w), dtype=np.uint8)
    for y, vals in grid.items():
        for x, v in enumerate(vals):
            a[y, x] = v
    return a

a = parse_log(r'C:\Users\Administrator\Desktop\平滑线条样本.log')
h, w = a.shape
print(f'尺寸: {w}x{h}')
nonzero = a > 0
print(f'非零像素: {nonzero.sum()} / {h*w} ({nonzero.sum()/(h*w)*100:.2f}%)')

# alpha 直方图（非零像素）
hist = np.bincount(a[nonzero].ravel(), minlength=256)
print('\nalpha 分布（非零）:')
for lo in range(0, 256, 16):
    seg = hist[lo:lo+16].sum()
    print(f'  {lo:3d}-{lo+15:3d}: {seg:6d}  {"#" * (seg // 50)}')

# 线内主体水平（alpha > 16）
body = a[nonzero & (a > 16)]
print(f'\nalpha>16 像素: {body.size}, 均值 {body.mean():.1f}, P50 {np.percentile(body,50):.0f}, P90 {np.percentile(body,90):.0f}, max {body.max()}')

# 每行 alpha>16 的像素数（线宽变化）
widths = []
for y in range(h):
    widths.append((a[y] > 16).sum())
print(f'\n每行线宽(alpha>16): min {min(widths)}, max {max(widths)}, 均值 {np.mean(widths):.1f}')
print('y=0..24:', widths[:25])
print('y=135..139:', widths[135:])

# 碎点检测：alpha>0 且 <40 的孤立小簇（毛刺/脏点候选）
from scipy import ndimage
mask_low = (a > 0) & (a <= 40)
lab, n = ndimage.label(mask_low, structure=np.ones((3,3)))
sizes = ndimage.sum(mask_low, lab, range(1, n+1))
small = [i+1 for i, s in enumerate(sizes) if s <= 3]
print(f'\n小碎点簇(alpha<=40, 面积<=3): {len(small)} 个, 像素数 {sum(int(sizes[i]) for i in range(len(sizes)) if sizes[i]<=3)}')

# alpha 波动：相邻行同列 alpha 突变（毛刺/反复描线痕迹）
d = np.abs(np.diff(a.astype(int), axis=0))
print(f'相邻行 alpha 突变: 平均 {d.mean():.2f}, >100 的像素对数: {(d>100).sum()}')
