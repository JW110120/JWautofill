# -*- coding: utf-8 -*-
"""v8 组合测试：v7 边缘位置平滑 + 同深度 alpha 平滑"""
import numpy as np
from scipy import ndimage
import line_smooth_proto_v7 as m7
from line_smooth_proto_v5 import structure_tensor_angle

src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
a = m7.parse_log(src)

def same_depth_smooth(img, line_mask, tan, dist_in, dist_out, radius=4, tol=0.7, w0=1.5, iters=1):
    h, w = img.shape
    sd = max(1.0, radius * 0.5)
    dw = np.exp(-(np.arange(0, radius + 1) ** 2) / (2 * sd ** 2))
    in_mask = line_mask | (dist_out < radius + 1)
    pairs = list(zip(*np.nonzero(in_mask)))
    cur = img.copy()
    for it in range(iters):
        nxt = cur.copy()
        for cy, cx in pairs:
            a0 = cur[cy, cx]
            if a0 <= 0 and dist_out[cy, cx] >= radius + 1:
                continue
            in_line = line_mask[cy, cx]
            dp = dist_in[cy, cx] if in_line else -dist_out[cy, cx]
            t = tan[cy, cx]
            tx, ty = np.cos(t), np.sin(t)
            pxv, pyv = -ty, tx
            acc_w, acc_a = w0, a0 * w0
            for d in range(1, radius + 1):
                for off in (-1, 0, 1):
                    x = cx + tx * d + pxv * off * 0.5
                    y = cy + ty * d + pyv * off * 0.5
                    xi, yi = int(round(x)), int(round(y))
                    if not (0 <= xi < w and 0 <= yi < h):
                        continue
                    dq = dist_in[yi, xi] if line_mask[yi, xi] else -dist_out[yi, xi]
                    if abs(dq - dp) > tol:
                        continue
                    aj = cur[yi, xi]
                    wo = 0.6 if off == 0 else 0.4
                    acc_w += dw[d] * wo
                    acc_a += aj * dw[d] * wo
            nxt[cy, cx] = acc_a / acc_w
        cur = nxt
    return cur

line = a > 16
dist_in = ndimage.distance_transform_edt(line)
dist_out = ndimage.distance_transform_edt(~line)
tan = structure_tensor_angle(a)

print('=== v8 组合（边缘位置平滑 + 同深度 alpha 平滑） ===')
for wdw in (5, 7):
    base = m7.smooth_main_line(a, window=wdw)
    for tol, it2 in ((0.6, 1), (0.8, 1), (0.8, 2)):
        res = same_depth_smooth(base, line, tan, dist_in, dist_out, radius=4, tol=tol, w0=1.5, iters=it2)
        n_res = (res > 16).sum()
        wp = 100 * (n_res - line.sum()) / line.sum()
        mae = np.abs(res[line] - a[line]).mean()
        ms = res[line].mean() - a[line].mean()
        std0 = a[line].std(); std1 = res[line].std()
        edge = line & (dist_in < 2.0)
        d0 = 0; d1 = 0; cnt = 0
        for y in range(140):
            for x in range(1, 104):
                if not edge[y, x]:
                    continue
                if line[y, x - 1] and line[y, x + 1]:
                    d0 += abs(a[y, x - 1] - a[y, x + 1]); d1 += abs(res[y, x - 1] - res[y, x + 1]); cnt += 1
        print(f'v7w={wdw} +同深度tol={tol}x{it2}: 宽{wp:+.1f}% MAE{mae:.1f} 偏移{ms:+.1f} std-{(1-std1/max(1e-6,std0))*100:.0f}% 锯齿-{(1-d1/max(1e-6,d0))*100:.0f}%')
