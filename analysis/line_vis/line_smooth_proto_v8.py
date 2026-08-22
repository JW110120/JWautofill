# -*- coding: utf-8 -*-
"""v8 最终：边缘位置平滑 + 同深度 alpha 平滑"""
import numpy as np
from scipy import ndimage
import line_smooth_proto_v7 as m7
from line_smooth_proto_v5 import structure_tensor_angle

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

def main():
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = m7.parse_log(src)
    line = a > 16
    dist_in = ndimage.distance_transform_edt(line)
    dist_out = ndimage.distance_transform_edt(~line)
    tan = structure_tensor_angle(a)

    base = m7.smooth_main_line(a, window=5)
    res = same_depth_smooth(base, line, tan, dist_in, dist_out, radius=4, tol=0.6, w0=1.5, iters=1)

    bg = a == 0
    n_res = (res > 16).sum()
    mae = np.abs(res[line] - a[line]).mean()
    ms = res[line].mean() - a[line].mean()
    std0 = a[line].std(); std1 = res[line].std()
    print(f'背景保持: {(res[bg]==0).mean()*100:.2f}%')
    print(f'线宽变化: {100*(n_res-line.sum())/line.sum():+.1f}%')
    print(f'线内 MAE: {mae:.2f}, 均值偏移: {ms:+.1f}')
    print(f'线内 std: {std0:.1f} -> {std1:.1f} ({(1-std1/max(1e-6,std0))*100:.0f}%)')

    print('\n=== 病灶2 复查（y=48-52 x=24-27） ===')
    for y in range(48, 53):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(24,28)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(24,28)) }')
    print('\n=== 病灶1 复查（主线左侧 y=25-31 x=2..8） ===')
    for y in range(25, 32):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(2,9)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(2,9)) }')
    # 反复描线区域（y=26 第二支 x=33-40）
    print('\n=== 反复描线复查（y=26 x=33..41） ===')
    for y in range(25, 29):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(33,42)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(33,42)) }')

    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v8_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v8_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v8结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    print('saved v8_res.log')

if __name__ == '__main__':
    main()
