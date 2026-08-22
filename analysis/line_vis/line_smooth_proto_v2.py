# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— Python 原型 v2
====================================
v2 相对 v1 的改进：
  1. 方向场窗口加大（7x7, sigma 2.0）→ 折线/并行线区域方向更稳定
  2. 连通域约束：方向平滑采样点若属于不同连通域（另一条线）则拒绝 → 保多线不糊
  3. 局部主体收敛：每个像素沿切线方向窗口的 P85（而非全局）→ 暗痕收敛、亮区不动，MAE 更小
  4. 中心权重提高（w0=2.5）→ 平滑更温和，alpha 偏离更小
  5. 碎点清理改进：线外孤立低 alpha 簇（面积<=5、离主线>1.5px）移除
  6. 迭代 2 次（更稳）
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

def label_components(mask, structure=np.ones((3, 3))):
    lab, n = ndimage.label(mask, structure=structure)
    return lab, n

def smooth_main_line(a, thr=16, iters=2, radius=4, body_pct=85, max_body_boost=28,
                     w0=2.5, clean_isolated=True, debug=False):
    h, w = a.shape
    line_mask = a > thr
    bg = a == 0
    out = a.copy()

    # ---- 方向场 + 连通域 ----
    tan = structure_tensor_angle(a)
    lab, ncomp = label_components(line_mask)

    # 线内深度
    dist_in = ndimage.distance_transform_edt(line_mask)

    # 采样权重
    sigma_d = max(1.0, radius * 0.5)
    dist_w = np.exp(-(np.arange(0, radius + 1) ** 2) / (2 * sigma_d ** 2))

    # 处理像素集合：线内 + 过渡带（dist_in < radius+1）
    ys, xs = np.nonzero(line_mask | (dist_in < radius + 1))

    # ---- Phase 2: 各向异性平滑 ----
    cur = out.copy()
    for it in range(iters):
        nxt = cur.copy()
        for cy, cx in zip(ys.tolist(), xs.tolist()):
            if not line_mask[cy, cx] and dist_in[cy, cx] >= radius + 1:
                continue
            a0 = cur[cy, cx]
            comp0 = lab[cy, cx]
            t = tan[cy, cx]
            tx, ty = np.cos(t), np.sin(t)
            pxv, pyv = -ty, tx
            acc_w = w0
            acc_a = a0 * w0
            sim_sigma = 90.0
            for d in range(1, radius + 1):
                for off in (-1, 0, 1):
                    x = cx + tx * d + pxv * off
                    y = cy + ty * d + pyv * off
                    xi = int(round(x)); yi = int(round(y))
                    if xi < 0 or xi >= w or yi < 0 or yi >= h:
                        continue
                    # 连通域约束：只取同域（或背景域）
                    if comp0 > 0 and lab[yi, xi] > 0 and lab[yi, xi] != comp0:
                        continue
                    aj = cur[yi, xi]
                    w_off = 0.6 if off == 0 else (0.45 if abs(x - xi) + abs(y - yi) < 0.4 else 0.3)
                    w_sim = np.exp(-abs(aj - a0) / sim_sigma)
                    wt = dist_w[d] * w_off * w_sim
                    acc_w += wt
                    acc_a += aj * wt
            nxt[cy, cx] = acc_a / acc_w
        cur = nxt

    # ---- Phase 3: 局部主体收敛（去反复描线）----
    dBody = 1.5
    core = line_mask & (dist_in >= dBody)
    # 局部主体：每个核心像素沿切线方向 ±radius 窗口的 P85（含自身）
    cur2 = cur.copy()
    if core.any():
        cy_s, cx_s = np.nonzero(core)
        local_body = np.empty(len(cy_s))
        for i, (cy, cx) in enumerate(zip(cy_s.tolist(), cx_s.tolist())):
            t = tan[cy, cx]
            tx, ty = np.cos(t), np.sin(t)
            pxv, pyv = -ty, tx
            vals = [cur[cy, cx]]
            for d in range(1, radius + 1):
                for off in (-1, 0, 1):
                    x = cx + tx * d + pxv * off
                    y = cy + ty * d + pyv * off
                    xi = int(round(x)); yi = int(round(y))
                    if 0 <= xi < w and 0 <= yi < h:
                        vals.append(cur[yi, xi])
            local_body[i] = np.percentile(vals, body_pct)
        boost = np.clip(local_body - cur[core], 0, max_body_boost)
        cur2[core] = cur[core] + boost

    # ---- Phase 4: 碎点清理 ----
    out2 = cur2.copy()
    if clean_isolated:
        # 线外孤立低 alpha 簇（alpha>0 且 <=48，面积<=5，离主线 >1.5px）
        low = (out2 > 0) & (out2 <= 48) & (~line_mask)
        lab_low, n_low = ndimage.label(low, structure=np.ones((3, 3)))
        sizes = ndimage.sum(low, lab_low, range(1, n_low + 1))
        for i in range(1, n_low + 1):
            if sizes[i - 1] > 5:
                continue
            ys_l, xs_l = np.nonzero(lab_low == i)
            if all(dist_in[y, x] > 1.5 for y, x in zip(ys_l, xs_l)):
                for y, x in zip(ys_l, xs_l):
                    out2[y, x] = 0
    out2[bg] = 0

    return out2

def evaluate(name, orig, res):
    line = orig > 16
    bg = orig == 0
    print(f'\n===== {name} =====')
    bg_keep = (res[bg] == 0).mean() * 100
    print(f'背景保持: {bg_keep:.2f}%')
    n_orig = line.sum()
    n_res = (res > 16).sum()
    print(f'线宽变化: {n_orig} -> {n_res} ({100*(n_res-n_orig)/max(1,n_orig):+.1f}%)')
    mae_line = np.abs(res[line] - orig[line]).mean()
    mae_all = np.abs(res - orig).mean()
    print(f'alpha MAE: 整体 {mae_all:.2f}, 线内 {mae_line:.2f}')
    std0 = orig[line].std()
    std1 = res[line].std()
    print(f'线内 alpha 标准差: {std0:.1f} -> {std1:.1f} ({(1-std1/max(1e-6,std0))*100:.1f}% 收敛)')
    d0 = np.abs(np.diff(orig.astype(float), axis=0)).mean()
    d1 = np.abs(np.diff(res.astype(float), axis=0)).mean()
    d0c = np.abs(np.diff(orig.astype(float), axis=1)).mean()
    d1c = np.abs(np.diff(res.astype(float), axis=1)).mean()
    print(f'相邻行突变: {d0:.2f} -> {d1:.2f} ({(1-d1/max(1e-6,d0))*100:.1f}%) | 相邻列: {d0c:.2f} -> {d1c:.2f} ({(1-d1c/max(1e-6,d0c))*100:.1f}%)')
    low0 = ((orig > 0) & (orig <= 48) & (~line)).sum()
    low1 = ((res > 0) & (res <= 48) & (~(res > 16))).sum()
    print(f'线外低 alpha 碎点像素: {low0} -> {low1}')
    return dict(bg_keep=bg_keep, width_pct=100*(n_res-n_orig)/max(1,n_orig),
                mae_line=mae_line, std_conv=(1-std1/max(1e-6,std0))*100)

if __name__ == '__main__':
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = parse_log(src)
    res = smooth_main_line(a, thr=16, iters=2, radius=4, body_pct=85, max_body_boost=28, w0=2.5)
    evaluate('样本 v2', a, res)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v2_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v2_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v2结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    print('saved v2_res.log')
