# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— 原型 v10（对称方向平滑 · 温和混合）
========================================================
v4-v9 教训总结：
  - 任何"提升 alpha"的操作（主体收敛/边缘提升/填缺口）都会制造台阶或变粗
  - 对称双向的方向平滑才是削锯齿/磨平波动的主力（v1 突变 -30%）
v10 方案：
  Phase 2  沿切线对称平滑（核心/边缘带双向，过渡带只降不升）
           mix 控制混合比例（不 100% 采用平滑结果 → alpha 偏离可控）
  Phase 3  无主体收敛（不提升 alpha）
"""
import re
import numpy as np
from scipy import ndimage

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
    a = np.zeros((h, w), dtype=np.float64)
    for y, vals in grid.items():
        for x, v in enumerate(vals):
            a[y, x] = v
    return a

def sobel_grad(a):
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float64)
    ky = kx.T
    gx = ndimage.convolve(a, kx, mode='nearest')
    gy = ndimage.convolve(a, ky, mode='nearest')
    return gx, gy

def gauss_kernel_2d(sigma, size):
    ax = np.linspace(-(size // 2), size // 2, size)
    g = np.exp(-(ax ** 2) / (2 * sigma ** 2))
    return np.outer(g, g) / g.sum()

def structure_tensor_angle(a, sigma=2.0, win=7):
    gx, gy = sobel_grad(a)
    gxx, gyy, gxy = gx * gx, gy * gy, gx * gy
    kern = gauss_kernel_2d(sigma, win)
    Sxx = ndimage.convolve(gxx, kern, mode='nearest')
    Syy = ndimage.convolve(gyy, kern, mode='nearest')
    Sxy = ndimage.convolve(gxy, kern, mode='nearest')
    phi = 0.5 * np.arctan2(2 * Sxy, Sxx - Syy)
    tan = phi + np.pi / 2
    return np.mod(tan, np.pi) - np.pi / 2

def smooth_main_line(a, thr=16, radius=4, w0=1.5, iters=2, mix=0.65, core_depth=1.2):
    h, w = a.shape
    line_mask = a > thr
    bg = a == 0
    out = a.copy()

    tan = structure_tensor_angle(a)
    dist_in = ndimage.distance_transform_edt(line_mask)
    dist_out = ndimage.distance_transform_edt(~line_mask)

    sigma_d = max(1.0, radius * 0.5)
    dist_w = np.exp(-(np.arange(0, radius + 1) ** 2) / (2 * sigma_d ** 2))

    core_mask = line_mask & (dist_in >= core_depth)
    edge_mask = line_mask & (dist_in < core_depth)
    outer_mask = (~line_mask) & (dist_out < radius + 1)
    pairs = list(zip(*np.nonzero(core_mask | edge_mask | outer_mask)))

    cur = a.copy()
    for it in range(iters):
        nxt = cur.copy()
        for cy, cx in pairs:
            in_core = core_mask[cy, cx]
            in_edge = edge_mask[cy, cx]
            a0 = cur[cy, cx]
            a_orig = a[cy, cx]
            t = tan[cy, cx]
            tx, ty = np.cos(t), np.sin(t)
            pxv, pyv = -ty, tx
            acc_w = w0 if in_core else 1.6
            acc_a = a0 * acc_w
            for d in range(1, radius + 1):
                offs = (-1, 0, 1) if in_core else (0,)
                for off in offs:
                    x = cx + tx * d + pxv * off * (0.5 if not in_core else 1.0)
                    y = cy + ty * d + pyv * off * (0.5 if not in_core else 1.0)
                    xi = int(round(x)); yi = int(round(y))
                    if xi < 0 or xi >= w or yi < 0 or yi >= h:
                        continue
                    aj = cur[yi, xi]
                    if in_core:
                        w_off = 0.6 if off == 0 else (0.45 if abs(x - xi) + abs(y - yi) < 0.4 else 0.3)
                    else:
                        w_off = 0.8
                    wt = dist_w[d] * w_off
                    acc_w += wt
                    acc_a += aj * wt
            sm = acc_a / acc_w
            nv = a0 + (sm - a0) * mix
            if in_core:
                nxt[cy, cx] = nv
            elif in_edge:
                # 边缘带：双向但保底 17（防缩线）
                nxt[cy, cx] = max(17, nv)
            else:
                # 过渡带：只降不升（防变粗）
                nxt[cy, cx] = min(a0, nv)
        cur = nxt

    cur[bg] = 0
    return cur

def eval_v10(name, orig, res):
    line = orig > 16
    bg = orig == 0
    print(f'\n===== {name} =====')
    print(f'背景保持: {(res[bg]==0).mean()*100:.2f}%')
    n_orig, n_res = line.sum(), (res > 16).sum()
    print(f'线宽变化: {100*(n_res-n_orig)/max(1,n_orig):+.1f}%')
    mae = np.abs(res[line]-orig[line]).mean()
    m_shift = res[line].mean() - orig[line].mean()
    print(f'线内 MAE: {mae:.2f}, 均值偏移: {m_shift:+.1f}')
    std0 = orig[line].std(); std1 = res[line].std()
    print(f'线内 std: {std0:.1f} -> {std1:.1f} ({(1-std1/max(1e-6,std0))*100:.0f}%)')
    dist_in = ndimage.distance_transform_edt(line)
    edge = line & (dist_in < 2.0)
    d0=0; d1=0; cnt=0
    h, w = orig.shape
    for y in range(h):
        for x in range(1, w-1):
            if not edge[y,x]: continue
            if line[y,x-1] and line[y,x+1]:
                d0 += abs(orig[y,x-1]-orig[y,x+1]); d1 += abs(res[y,x-1]-res[y,x+1]); cnt += 1
    if cnt:
        print(f'边缘带横向二阶差(锯齿): {d0/cnt:.2f} -> {d1/cnt:.2f} ({(1-d1/max(1e-6,d0))*100:.0f}%)')
    d_row0 = np.abs(np.diff(orig.astype(float), axis=0)).mean()
    d_row1 = np.abs(np.diff(res.astype(float), axis=0)).mean()
    print(f'相邻行突变: {d_row0:.2f} -> {d_row1:.2f} ({(1-d_row1/d_row0)*100:.0f}%)')

if __name__ == '__main__':
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = parse_log(src)
    for mix in (0.4, 0.6, 0.8):
        for it in (2, 3):
            res = smooth_main_line(a, w0=1.5, iters=it, mix=mix)
            print(f'--- mix={mix} iters={it} ---')
            eval_v10(f'v10', a, res)
    res = smooth_main_line(a, w0=1.5, iters=2, mix=0.6)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v10_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v10_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v10结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    print('\n=== 病灶2 复查（y=48-52 x=24-27） ===')
    for y in range(48, 53):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(24,28)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(24,28)) }')
    print('\n=== 病灶1 复查（主线左侧 y=25-31 x=2..8） ===')
    for y in range(25, 32):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(2,9)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(2,9)) }')
    print('saved v10_res.log')
