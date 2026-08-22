# -*- coding: utf-8 -*-
"""最小复现：Phase 2 核心循环写入是否生效。"""
import numpy as np
from line_smooth_proto_v1 import parse_log, structure_tensor_angle, tangent_samples

src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
a = parse_log(src)
h, w = a.shape
tan = structure_tensor_angle(a)
line_mask = a > 16
from scipy import ndimage
dist_in = ndimage.distance_transform_edt(line_mask)

radius = 4
sigma_d = max(1.0, radius * 0.45)
dist_w = np.exp(-(np.arange(0, radius + 1) ** 2) / (2 * sigma_d ** 2))

cur = a.copy()
nxt = cur.copy()
ys, xs = np.nonzero(line_mask | (dist_in < radius + 2))
print(f'循环像素数: {len(ys)}')

count = 0
for cy, cx in zip(ys.tolist(), xs.tolist()):
    if not line_mask[cy, cx] and dist_in[cy, cx] >= radius + 2:
        continue
    count += 1
    a0 = cur[cy, cx]
    sx, sy = tangent_samples(h, w, tan, cx, cy, radius)
    if cy == 28 and cx == 33:
        print(f'处理 ({cx},{cy}) a0={a0:.1f} tan={np.degrees(tan[cy,cx]):.1f}°')
        print(f'  sx={[f"{v:.2f}" for v in sx]}')
        print(f'  sy={[f"{v:.2f}" for v in sy]}')
    acc_w = 1.0
    acc_a = a0 * 1.0
    sim_sigma = 90.0
    for d in range(1, radius + 1):
        for off in (-1, 0, 1):
            idx = (d - 1) * 3 + (off + 1)
            x = sx[idx]; y = sy[idx]
            xi = int(round(x)); yi = int(round(y))
            if xi < 0 or xi >= w or yi < 0 or yi >= h:
                continue
            aj = cur[yi, xi]
            w_off = 0.6 if off == 0 else (0.45 if abs(x - xi) + abs(y - yi) < 0.4 else 0.3)
            w_sim = np.exp(-abs(aj - a0) / sim_sigma)
            w = dist_w[d] * w_off * w_sim
            acc_w += w
            acc_a += aj * w
    if cy == 28 and cx == 33:
        print(f'  acc_w={acc_w:.2f} acc_a={acc_a:.1f} -> {acc_a/acc_w:.1f}')
        try:
            for d in range(1, radius + 1):
                for off in (-1, 0, 1):
                    idx = (d - 1) * 3 + (off + 1)
                    x = sx[idx]; y = sy[idx]
                    xi = int(round(x)); yi = int(round(y))
                    if 0 <= xi < w and 0 <= yi < h:
                        aj = cur[yi, xi]
                        w_off = 0.6 if off == 0 else (0.45 if abs(x - xi) + abs(y - yi) < 0.4 else 0.3)
                        w_sim = np.exp(-abs(aj - a0) / 90.0)
                        w = dist_w[d] * w_off * w_sim
                        print(f'    d={d} off={off} ({xi},{yi}) a={aj:.0f} w={w:.4f}')
                    else:
                        print(f'    越界: d={d} off={off} ({x:.2f},{y:.2f})->({xi},{yi})')
        except Exception as e:
            print(f'  !! 打印块异常: {e}')
        # 手动重算一次（完全独立）
        acc2w, acc2a = 1.0, a0 * 1.0
        for k in range(12):
            x, y = sx[k], sy[k]
            xi, yi = int(round(x)), int(round(y))
            if xi < 0 or xi >= w or yi < 0 or yi >= h:
                continue
            aj = cur[yi, xi]
            dd = k // 3 + 1
            off = (k % 3) - 1
            w_off = 0.6 if off == 0 else 0.4
            acc2w += dist_w[dd] * w_off
            acc2a += aj * dist_w[dd] * w_off
        print(f'  独立重算(无sim): {acc2a/acc2w:.1f} (acc2w={acc2w:.2f})')
    nxt[cy, cx] = acc_a / acc_w

print(f'处理像素数: {count}')
print(f'nxt[28,33] = {nxt[28,33]:.1f} (期望 ~203.6)')
