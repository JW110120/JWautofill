# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— 最终版 v4
================================
设计（对应产品需求）：
  1. 线条不变粗不变细（边缘/过渡带限制 + 线内身份保底）
  2. alpha 不偏离太多（核心亮痕 max 截断保持；整体水平自然保持）
  3. 毛刺感极大削弱（边缘/过渡带沿切线平滑 + 过渡带有限提升填锯齿缺口）
  4. 反复描线极大削弱（核心沿切线非对称平滑 + 局部 P88 主体收敛）

管线：
  Phase 1  方向场：结构张量（Sobel 梯度 + 7x7 高斯窗口）→ 切线角
  Phase 2  沿切线各向异性平滑（迭代 2 次）：
             A. 核心（线内深度>=2）：全采样(off=-1,0,1)，结果 max(sm, a0) —— 暗痕被拉亮、亮痕保持
             B. 边缘带（线内深度<2）：仅纯切线采样(off=0)，限制 [a0-25, a0+12]，保底 17（防缩线）
             C. 过渡带（线外距线<radius+1）：仅纯切线采样，允许提升到 min(127, 切线相邻采样最大alpha) —— 填锯齿缺口不外扩
  Phase 3  局部主体收敛（仅核心）：向沿切线窗口 P88 收敛，提升上限 60
  Phase 4  碎点清理：线外孤立低 alpha 簇（面积<=12、距主线>1.2px）移除
  Phase 5  背景（alpha==0）绝对保持
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

def smooth_main_line(a, thr=16, iters=2, radius=4, body_pct=88, max_body_boost=60,
                     w0=1.8, clean_isolated=True, clean_area=12, clean_dist=1.2,
                     core_depth=1.2):
    h, w = a.shape
    line_mask = a > thr
    bg = a == 0
    out = a.copy()

    # 方向场 + 距离场（scipy EDT 语义：非零到最近零的距离）
    tan = structure_tensor_angle(a)
    dist_in = ndimage.distance_transform_edt(line_mask)   # 线内深度
    dist_out = ndimage.distance_transform_edt(~line_mask)  # 线外距线距离

    sigma_d = max(1.0, radius * 0.5)
    dist_w = np.exp(-(np.arange(0, radius + 1) ** 2) / (2 * sigma_d ** 2))

    core_mask = line_mask & (dist_in >= core_depth)
    edge_mask = line_mask & (dist_in < core_depth)
    outer_mask = (~line_mask) & (dist_out < radius + 1)
    pairs = list(zip(*np.nonzero(core_mask | edge_mask | outer_mask)))

    # ---- Phase 2: 沿切线各向异性平滑 ----
    cur = out.copy()
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
            max_adj = a0  # 过渡带提升上限参考
            sim_sigma = 90.0
            for d in range(1, radius + 1):
                offs = (-1, 0, 1) if in_core else (0,)
                for off in offs:
                    x = cx + tx * d + pxv * off
                    y = cy + ty * d + pyv * off
                    xi = int(round(x)); yi = int(round(y))
                    if xi < 0 or xi >= w or yi < 0 or yi >= h:
                        continue
                    aj = cur[yi, xi]
                    if aj > max_adj:
                        max_adj = aj
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
                # 核心：非对称 —— 暗痕被拉亮，亮痕保持（max 截断）
                nxt[cy, cx] = max(sm, a0)
            elif in_edge:
                # 边缘带：削沿线起伏；限制基于原始值（防多轮迭代累积漂移）；保底 17 防缩线
                lo = max(a_orig - 25, 17)
                hi = a_orig + 12
                nxt[cy, cx] = max(lo, min(hi, sm))
            else:
                # 过渡带：只降不升（削毛刺凸起，绝不外扩 → 线宽严格保持）
                lo = a_orig - 40
                nxt[cy, cx] = max(lo, min(a0, sm))
        cur = nxt

    # ---- Phase 3: 局部主体收敛（仅核心）----
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

    # ---- Phase 4: 碎点清理 ----
    out2 = cur2.copy()
    if clean_isolated:
        low = (out2 > 0) & (out2 <= 48) & (~line_mask)
        lab_low, n_low = ndimage.label(low, structure=np.ones((3, 3)))
        sizes = ndimage.sum(low, lab_low, range(1, n_low + 1))
        for i in range(1, n_low + 1):
            if sizes[i - 1] > clean_area:
                continue
            ys_l, xs_l = np.nonzero(lab_low == i)
            if all(dist_out[y, x] > clean_dist for y, x in zip(ys_l, xs_l)):
                for y, x in zip(ys_l, xs_l):
                    out2[y, x] = 0

    # ---- Phase 5: 背景保持 ----
    out2[bg] = 0
    return out2

def evaluate(name, orig, res):
    line = orig > 16
    bg = orig == 0
    dist_in = ndimage.distance_transform_edt(line)
    core = line & (dist_in >= 2.0)
    edge = line & (dist_in < 2.0)
    print(f'\n===== {name} =====')
    print(f'背景保持: {(res[bg]==0).mean()*100:.2f}%')
    n_orig, n_res = line.sum(), (res > 16).sum()
    print(f'线宽变化: {n_orig} -> {n_res} ({100*(n_res-n_orig)/max(1,n_orig):+.1f}%)')
    mae = np.abs(res[line]-orig[line]).mean()
    print(f'alpha MAE(线内): {mae:.2f}')
    if core.any():
        c0, c1 = orig[core].std(), res[core].std()
        p = np.percentile(res[core], [50, 85])
        print(f'核心主体 P50/P85: {p[0]:.0f}/{p[1]:.0f} | 核心波动(反复描线) {c0:.1f} -> {c1:.1f} ({(1-c1/max(1e-6,c0))*100:.0f}% 收敛)')
    d0 = np.abs(np.diff(orig.astype(float), axis=0)).mean()
    d1 = np.abs(np.diff(res.astype(float), axis=0)).mean()
    d0c = np.abs(np.diff(orig.astype(float), axis=1)).mean()
    d1c = np.abs(np.diff(res.astype(float), axis=1)).mean()
    print(f'相邻行突变: {d0:.2f} -> {d1:.2f} ({(1-d1/d0)*100:.0f}%) | 列: {d0c:.2f} -> {d1c:.2f} ({(1-d1c/d0c)*100:.0f}%)')
    low0 = (orig > 0) & (orig <= 48) & (~line)
    lab0, n0 = ndimage.label(low0, structure=np.ones((3, 3)))
    s0 = ndimage.sum(low0, lab0, range(1, n0 + 1))
    iso0 = int(sum(s for s in s0 if s <= 12))
    res_line = res > 16
    low1 = (res > 0) & (res <= 48) & (~res_line)
    lab1, n1 = ndimage.label(low1, structure=np.ones((3, 3)))
    s1 = ndimage.sum(low1, lab1, range(1, n1 + 1))
    iso1 = int(sum(s for s in s1 if s <= 12))
    print(f'孤立碎点簇(<=12px): {iso0} -> {iso1}')
    return dict(bg=(res[bg]==0).mean()*100, width=100*(n_res-n_orig)/max(1,n_orig), mae=mae)

if __name__ == '__main__':
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = parse_log(src)
    res = smooth_main_line(a)
    evaluate('样本 v4 最终', a, res)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v4_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v4_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v4结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    print('saved v4_res.log')
