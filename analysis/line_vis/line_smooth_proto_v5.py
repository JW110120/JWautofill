# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— 原型 v5（视觉平滑导向，重构）
====================================================
针对 v4 反馈的根本修正：
  v4 问题：① Phase3 主体收敛抬高核心 alpha → 制造台阶、视觉变粗；
           ② 边缘带"可提升 +12" → 局部变粗；
           ③ alpha 场平滑削不掉"边缘位置抖动"型锯齿（锯齿=同深度层 alpha 起伏）。
  v5 思路：**同深度层约束的沿线平滑** —— 只平均"深度(到边缘距离)相同"的沿线像素：
           - 不跨层平均 → alpha 剖面（垂直于线的渐变形状）严格保持 → 不粗不细、无台阶
           - 同深度层的沿线 alpha 起伏（正是锯齿/毛刺）被磨平 → 视觉顺滑
           - 彻底移除 alpha 提升（无主体收敛、边缘带不可提升）→ alpha 不偏离

管线：
  Phase 1  结构张量方向场 → 切线角
  Phase 2  同深度层方向平滑（迭代 N 次，N 由平滑力度决定）：
             A. 线内像素（core+edge 统一）：沿切线采样，仅接受 |深度差|<=tol 的采样点
                → 边缘带锯齿磨平、核心内部 alpha 均匀化（去反复描线），剖面不变
             B. 过渡带（线外距线<radius+1）：同上（深度=dist_out）→ 过渡带锯齿磨平，不外扩
  Phase 3  背景保持 + RGB 直通不变
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

def smooth_main_line(a, thr=16, radius=4, depth_tol=1.0, w0=2.0, iters=2, smooth_mix=1.0):
    h, w = a.shape
    line_mask = a > thr
    bg = a == 0
    out = a.copy()

    tan = structure_tensor_angle(a)
    # scipy EDT：非零到最近零的距离
    dist_in = ndimage.distance_transform_edt(line_mask)   # 线内深度（线外=0）
    dist_out = ndimage.distance_transform_edt(~line_mask)  # 线外距线距离（线内=0）

    sigma_d = max(1.0, radius * 0.5)
    dist_w = np.exp(-(np.arange(0, radius + 1) ** 2) / (2 * sigma_d ** 2))

    in_mask = line_mask | (dist_out < radius + 1)
    pairs = list(zip(*np.nonzero(in_mask)))

    cur = a.copy()
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
            acc_w = w0
            acc_a = a0 * w0
            for d in range(1, radius + 1):
                # 纯切线方向 + 轻微垂直偏移（0.5px 内，避免过度跨层）
                for off in (-1, 0, 1):
                    x = cx + tx * d + pxv * off * 0.5
                    y = cy + ty * d + pyv * off * 0.5
                    xi = int(round(x)); yi = int(round(y))
                    if xi < 0 or xi >= w or yi < 0 or yi >= h:
                        continue
                    # 同深度层约束（带符号深度：线内正、线外负，语义统一）：
                    # 采样点与中心深度差 <= tol 才参与 → 不跨层、不跨边
                    if line_mask[yi, xi]:
                        dq = dist_in[yi, xi]
                    else:
                        dq = -dist_out[yi, xi]
                    if abs(dq - dp) > depth_tol:
                        continue
                    aj = cur[yi, xi]
                    w_off = 0.6 if off == 0 else 0.4
                    wt = dist_w[d] * w_off
                    acc_w += wt
                    acc_a += aj * wt
            sm = acc_a / acc_w
            # 平滑结果按力度混合；线内允许轻微双向，线外只降不升（防外扩）
            nv = a0 + (sm - a0) * smooth_mix
            if not in_line and nv > a0:
                nv = a0
            nxt[cy, cx] = nv
        cur = nxt

    cur[bg] = 0
    return cur

def eval_v5(name, orig, res, w0_depth=2.0):
    line = orig > 16
    bg = orig == 0
    dist_in = ndimage.distance_transform_edt(line)
    dist_out = ndimage.distance_transform_edt(~line)
    print(f'\n===== {name} =====')
    print(f'背景保持: {(res[bg]==0).mean()*100:.2f}%')
    n_orig, n_res = line.sum(), (res > 16).sum()
    print(f'线宽变化: {100*(n_res-n_orig)/max(1,n_orig):+.1f}%')
    mae = np.abs(res[line]-orig[line]).mean()
    m_shift = res[line].mean() - orig[line].mean()
    print(f'线内 MAE: {mae:.2f}, 均值偏移: {m_shift:+.1f}')
    # 边缘带沿线程起伏（真正的锯齿指标）：边缘带像素与同深度相邻采样 alpha 差
    edge = line & (dist_in < 2.0)
    # 用 3x3 内"同深度"像素差衡量（粗糙近似：垂直方向差）
    # 精确：沿切线方向。简化用行内相邻线内像素差
    d_row_edge0 = 0; d_row_edge1 = 0; cnt = 0
    for y in range(h):
        for x in range(1, w - 1):
            if not edge[y, x]: continue
            # 相邻像素（横向）中同在线内的
            if line[y, x-1] and line[y, x+1]:
                d_row_edge0 += abs(orig[y, x-1] - orig[y, x+1])
                d_row_edge1 += abs(res[y, x-1] - res[y, x+1])
                cnt += 1
    if cnt:
        print(f'边缘带横向二阶差(锯齿): {d_row_edge0/cnt:.2f} -> {d_row_edge1/cnt:.2f} ({(1-d_row_edge1/max(1e-6,d_row_edge0))*100:.0f}%)')
    # 线内 alpha 波动（反复描线）
    std0 = orig[line].std(); std1 = res[line].std()
    print(f'线内 std: {std0:.1f} -> {std1:.1f} ({(1-std1/max(1e-6,std0))*100:.0f}%)')

if __name__ == '__main__':
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = parse_log(src)
    res = smooth_main_line(a, radius=4, depth_tol=1.0, iters=2, smooth_mix=1.0)
    eval_v5('样本 v5', a, res)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v5_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v5_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v5结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    # 病灶复查
    print('\n=== 病灶1 复查（x=2..8） ===')
    for y in range(25, 32):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(2,9)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(2,9)) }')
    print('\n=== 病灶2 复查（y=48-52 x=24-27） ===')
    for y in range(48, 53):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(24,28)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(24,28)) }')
    print('saved v5_res.log')
