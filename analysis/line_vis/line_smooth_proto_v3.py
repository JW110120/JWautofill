# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— Python 原型 v3
====================================
v3 关键改进（解决 v2 线宽 +9.8% 问题）：
  - 把像素分成三类，分别处理：
    A. 线内核心（dist_in >= 2.0）：沿切线全采样平滑（off=-1,0,1）+ 局部主体收敛
       —— 磨平内部 alpha 不均（去反复描线）、削内部毛刺
    B. 线内边缘（dist_in < 2.0）：只沿纯切线方向采样（off=0）
       —— 平滑沿线条方向的起伏（削锯齿节律），但不跨线采样 → 不改变垂直剖面 → 不粗不细
    C. 线外过渡带（dist_in < radius+1）：只沿切线采样，结果限制 [原值-40, 原值+8]
       —— 削毛刺（降低突出的暗痕），几乎不提升 → 防变粗
  - 主体收敛只对 A 类像素
  - 背景（alpha==0）绝对保持
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

def smooth_main_line(a, thr=16, iters=2, radius=4, body_pct=85, max_body_boost=30,
                     w0=1.8, clean_isolated=True):
    h, w = a.shape
    line_mask = a > thr
    bg = a == 0
    out = a.copy()

    tan = structure_tensor_angle(a)
    # 注意：scipy EDT 语义 = "非零元素到最近零元素的距离"
    # dist_in: 线内深度（线内像素到线外边界的距离）；线外像素 = 0
    dist_in = ndimage.distance_transform_edt(line_mask)
    # dist_out: 线外像素到最近线内像素的距离；线内像素 = 0
    dist_out = ndimage.distance_transform_edt(~line_mask)

    sigma_d = max(1.0, radius * 0.5)
    dist_w = np.exp(-(np.arange(0, radius + 1) ** 2) / (2 * sigma_d ** 2))

    core_mask = line_mask & (dist_in >= 2.0)
    edge_mask = line_mask & (dist_in < 2.0)
    outer_mask = (~line_mask) & (dist_out < radius + 1)

    ys, xs = np.nonzero(core_mask | edge_mask | outer_mask)
    pairs = list(zip(ys.tolist(), xs.tolist()))

    # ---- Phase 2: 分区域各向异性平滑 ----
    cur = out.copy()
    for it in range(iters):
        nxt = cur.copy()
        for cy, cx in pairs:
            in_core = core_mask[cy, cx]
            in_edge = edge_mask[cy, cx]
            a0 = cur[cy, cx]
            t = tan[cy, cx]
            tx, ty = np.cos(t), np.sin(t)
            pxv, pyv = -ty, tx
            acc_w = w0 if in_core else 1.6
            acc_a = a0 * acc_w
            sim_sigma = 90.0
            for d in range(1, radius + 1):
                if in_core:
                    # 核心：全采样（含垂直偏移）
                    offs = (-1, 0, 1)
                else:
                    # 边缘/过渡带：只沿纯切线（轻微垂直偏移允许 0.3）
                    offs = (0,)
                for off in offs:
                    x = cx + tx * d + pxv * off
                    y = cy + ty * d + pyv * off
                    xi = int(round(x)); yi = int(round(y))
                    if xi < 0 or xi >= w or yi < 0 or yi >= h:
                        continue
                    aj = cur[yi, xi]
                    if in_core:
                        w_off = 0.6 if off == 0 else (0.45 if abs(x - xi) + abs(y - yi) < 0.4 else 0.3)
                    else:
                        w_off = 0.8
                    w_sim = np.exp(-abs(aj - a0) / sim_sigma)
                    wt = dist_w[d] * w_off * w_sim
                    acc_w += wt
                    acc_a += aj * wt
            sm = acc_a / acc_w
            if in_core:
                nxt[cy, cx] = sm
            elif in_edge:
                # 边缘：结果限制在小范围（削锯齿节律，不粗不细）；保底线内身份（>=17 防缩线）
                nxt[cy, cx] = max(max(a0 - 25, 17), min(a0 + 12, sm))
            else:
                # 过渡带：只降不升（削毛刺）
                nxt[cy, cx] = max(a0 - 40, min(a0, sm))
        cur = nxt

    # ---- Phase 3: 局部主体收敛（仅核心；主体水平基于原始 alpha）----
    cur2 = cur.copy()
    cy_s, cx_s = np.nonzero(core_mask)
    if len(cy_s):
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
        boost = np.clip(local_body - cur[core_mask], 0, max_body_boost)
        cur2[core_mask] = cur[core_mask] + boost

    # ---- Phase 3.5: 部分均值补偿（核心；对称平滑会拉低亮痕，按比例补偿回，保持整体深浅）----
    if core_mask.any():
        m0 = a[core_mask].mean()
        m1 = cur2[core_mask].mean()
        offset = (m0 - m1) * 0.4
        if abs(offset) > 0.5:
            cur2[core_mask] = np.clip(cur2[core_mask] + offset, 0, 255)

    # ---- Phase 4: 碎点清理 ----
    out2 = cur2.copy()
    if clean_isolated:
        low = (out2 > 0) & (out2 <= 48) & (~line_mask)
        lab_low, n_low = ndimage.label(low, structure=np.ones((3, 3)))
        sizes = ndimage.sum(low, lab_low, range(1, n_low + 1))
        for i in range(1, n_low + 1):
            if sizes[i - 1] > 5:
                continue
            ys_l, xs_l = np.nonzero(lab_low == i)
            if all(dist_out[y, x] > 1.5 for y, x in zip(ys_l, xs_l)):
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
    low0 = ((orig > 0) & (orig <= 48) & (~line))
    # 孤立碎点簇统计（面积<=5 的线外低 alpha 簇）
    lab0, n0 = ndimage.label(low0, structure=np.ones((3, 3)))
    sizes0 = ndimage.sum(low0, lab0, range(1, n0 + 1))
    iso0 = int(sum(s for s in sizes0 if s <= 5))
    res_line = res > 16
    low1 = (res > 0) & (res <= 48) & (~res_line)
    lab1, n1 = ndimage.label(low1, structure=np.ones((3, 3)))
    sizes1 = ndimage.sum(low1, lab1, range(1, n1 + 1))
    iso1 = int(sum(s for s in sizes1 if s <= 5))
    print(f'线外低 alpha: {low0.sum()} -> {low1.sum()} | 孤立碎点簇(<=5px): {iso0} -> {iso1}')
    return dict(bg_keep=bg_keep, width_pct=100*(n_res-n_orig)/max(1,n_orig),
                mae_line=mae_line, std_conv=(1-std1/max(1e-6,std0))*100)

if __name__ == '__main__':
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = parse_log(src)
    res = smooth_main_line(a, thr=16, iters=2, radius=4, body_pct=85, max_body_boost=30, w0=1.8)
    evaluate('样本 v3', a, res)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v3_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v3_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v3结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    print('saved v3_res.log')
