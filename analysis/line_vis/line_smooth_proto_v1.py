# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— Python 原型（v1）
========================================
设计目标（对应产品需求）：
  1. 线条平滑后不变粗不变细太多（宽度守恒）
  2. 不与原本线条 alpha 偏离太多（主体水平收敛而非拉平到 255）
  3. 毛刺感极大削弱（沿切线方向各向异性平滑 + 碎点清理）
  4. 反复描线极大削弱（线内主体分位数收敛）

管线：
  Phase0  预处理：lineMask = alpha>thr；bg 保持
  Phase1  方向场：结构张量（Sobel 梯度 + 高斯加权窗口）→ 切线角
  Phase2  各向异性平滑：沿切线方向多尺度采样加权平均（迭代 N 次）
  Phase3  主体收敛：线内深度>=dBody 的像素向局部 P85 收敛（限制最大提升量）
  Phase4  边缘清理：线外过渡带轻度方向平滑；孤立小碎点移除
"""
import re
import numpy as np
from scipy import ndimage

DEBUG = True

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

# ---------------- 工具 ----------------
def sobel_grad(a):
    """Sobel 梯度 (gx, gy)。"""
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float64)
    ky = kx.T
    gx = ndimage.convolve(a, kx, mode='nearest')
    gy = ndimage.convolve(a, ky, mode='nearest')
    return gx, gy

def gauss_kernel_2d(sigma, size):
    ax = np.linspace(-(size // 2), size // 2, size)
    g = np.exp(-(ax ** 2) / (2 * sigma ** 2))
    return np.outer(g, g) / g.sum()

def structure_tensor_angle(a, sigma=1.5, win=5):
    """结构张量主方向角（弧度），返回切线角 tan = 主方向 + pi/2。
    返回角度在 [-pi/2, pi/2)。"""
    gx, gy = sobel_grad(a)
    gxx = gx * gx
    gyy = gy * gy
    gxy = gx * gy
    kern = gauss_kernel_2d(sigma, win)
    Sxx = ndimage.convolve(gxx, kern, mode='nearest')
    Syy = ndimage.convolve(gyy, kern, mode='nearest')
    Sxy = ndimage.convolve(gxy, kern, mode='nearest')
    # 主方向角
    phi = 0.5 * np.arctan2(2 * Sxy, Sxx - Syy)
    # 切线方向 = 主方向 + 90°
    tan = phi + np.pi / 2
    # 规范化到 [-pi/2, pi/2)（切线方向不分正负）
    tan = np.mod(tan, np.pi) - np.pi / 2
    return tan

def tangent_samples(h, w, tan, cx, cy, r):
    """沿切线方向取 2r 个采样点（±1..±r，含垂直偏移探测），返回 (xs, ys, ws)。
    垂直偏移探测：每个距离 d 采样 3 点（中心 ± 垂直 1px），由调用方按 alpha 相似加权。"""
    t = tan[cy, cx]
    tx, ty = np.cos(t), np.sin(t)
    # 垂直方向
    px, py = -ty, tx
    xs, ys = [], []
    for d in range(1, r + 1):
        for off in (-1, 0, 1):
            x = cx + tx * d + px * off
            y = cy + ty * d + py * off
            xs.append(x)
            ys.append(y)
    return xs, ys

def smooth_main_line(a, thr=16, iters=3, radius=4, body_pct=85, max_body_boost=40,
                     smooth_ratio=1.0, edge_light=0.6, clean_isolated=True):
    h, w = a.shape
    out = a.copy()
    line_mask = a > thr
    bg = a == 0

    # ---- Phase 1: 方向场 ----
    tan = structure_tensor_angle(a)

    # ---- 线内深度（EDT in-mask）----
    dist_in = ndimage.distance_transform_edt(line_mask)

    # ---- Phase 2: 各向异性平滑（迭代）----
    cur = out.copy()
    # 高斯权重（沿切线距离）
    sigma_d = max(1.0, radius * 0.45)
    dist_w = np.exp(-(np.arange(0, radius + 1) ** 2) / (2 * sigma_d ** 2))
    for it in range(iters):
        nxt = cur.copy()
        ys, xs = np.nonzero(line_mask | (dist_in < radius + 2))
        for cy, cx in zip(ys.tolist(), xs.tolist()):
            # 只处理线内 + 紧邻过渡带
            if not line_mask[cy, cx] and dist_in[cy, cx] >= radius + 2:
                continue
            a0 = cur[cy, cx]
            if DEBUG and cy == 28 and cx == 33:
                print(f'[dbg2] iter={it} a0={a0:.1f}')
            sx, sy = tangent_samples(h, w, tan, cx, cy, radius)
            acc_w = 1.0
            acc_a = a0 * 1.0
            # alpha 相似权重（preserveDetail=0 → 大 sigma，接近恒等）
            sim_sigma = 90.0
            for d in range(1, radius + 1):
                for off in (-1, 0, 1):
                    idx = (d - 1) * 3 + (off + 1)
                    x = sx[idx]; y = sy[idx]
                    xi = int(round(x)); yi = int(round(y))
                    if xi < 0 or xi >= w or yi < 0 or yi >= h:
                        continue
                    aj = cur[yi, xi]
                    # 垂直偏移惩罚：偏离中心线的采样权重降低（保曲线）
                    w_off = 0.6 if off == 0 else (0.45 if abs(x - xi) + abs(y - yi) < 0.4 else 0.3)
                    w_sim = np.exp(-abs(aj - a0) / sim_sigma)
                    wt = dist_w[d] * w_off * w_sim
                    acc_w += wt
                    acc_a += aj * wt
            nxt[cy, cx] = acc_a / acc_w
        cur = nxt

    # ---- Phase 3: 主体收敛（去反复描线）----
    # 线内深度 >= dBody 的核心像素：向局部 P85 收敛，限制最大提升量
    dBody = 1.5
    core = line_mask & (dist_in >= dBody)
    body = np.percentile(cur[line_mask], body_pct) if line_mask.any() else 192
    body = min(255, max(body, 160))
    if DEBUG:
        d2 = cur - a
        print(f'[debug] Phase2 后: 改变 {np.abs(d2)>0.5} 像素 {(np.abs(d2)>0.5).sum()}, 正向 {(d2>0.5).sum()}, 负向 {(d2<-0.5).sum()}, 变化均值 {d2[np.abs(d2)>0.5].mean():.1f} (body={body:.0f})')
    boost = np.clip(body - cur, 0, max_body_boost)
    cur2 = cur.copy()
    cur2[core] = cur[core] + boost[core] * smooth_ratio
    # 边缘带（线内深度 < dBody）：只保留方向平滑结果，不做主体提升（保持渐变）
    edge_band = line_mask & (dist_in < dBody)
    cur2[edge_band] = cur[edge_band] * (1 - edge_light) + cur2[edge_band] * edge_light

    # ---- Phase 4: 碎点清理 ----
    out2 = cur2.copy()
    if clean_isolated:
        # 线外孤立小簇（alpha>0 且 <=40，面积<=4，且离主线 >2px）→ 移除
        low = (out2 > 0) & (out2 <= 40) & (~line_mask)
        lab, n = ndimage.label(low, structure=np.ones((3, 3)))
        sizes = ndimage.sum(low, lab, range(1, n + 1))
        for i in range(1, n + 1):
            if sizes[i - 1] > 4:
                continue
            ys_l, xs_l = np.nonzero(lab == i)
            # 簇内像素到主线（line_mask）的最小距离
            if all(dist_in[y, x] > 2 for y, x in zip(ys_l, xs_l)):
                for y, x in zip(ys_l, xs_l):
                    out2[y, x] = 0
    out2[bg] = 0  # 背景绝对保持

    return out2

# ---------------- 评估 ----------------
def evaluate(name, orig, res, ideal=None, minimum=None):
    line = orig > 16
    bg = orig == 0
    print(f'\n===== {name} =====')
    # 1. 背景保持
    bg_keep = (res[bg] == 0).mean() * 100
    print(f'背景保持: {bg_keep:.2f}%')
    # 2. 宽度变化（线内像素数）
    n_orig = line.sum()
    n_res = (res > 16).sum()
    print(f'线宽变化: {n_orig} -> {n_res} ({100*(n_res-n_orig)/max(1,n_orig):+.1f}%)')
    # 3. alpha 偏离（整体 MAE + 线内 MAE）
    mae_all = np.abs(res - orig).mean()
    mae_line = np.abs(res[line] - orig[line]).mean()
    print(f'alpha MAE: 整体 {mae_all:.2f}, 线内 {mae_line:.2f}')
    # 4. 主体均匀（线内 alpha 标准差，去反复描线）
    std0 = orig[line].std()
    std1 = res[line].std()
    print(f'线内 alpha 标准差: {std0:.1f} -> {std1:.1f} ({(1-std1/max(1e-6,std0))*100:.1f}% 收敛)')
    # 5. 毛刺削弱（相邻行/列突变）
    d0 = np.abs(np.diff(orig.astype(float), axis=0)).mean()
    d1 = np.abs(np.diff(res.astype(float), axis=0)).mean()
    d0c = np.abs(np.diff(orig.astype(float), axis=1)).mean()
    d1c = np.abs(np.diff(res.astype(float), axis=1)).mean()
    print(f'相邻行突变: {d0:.2f} -> {d1:.2f} ({(1-d1/max(1e-6,d0))*100:.1f}%) | 相邻列: {d0c:.2f} -> {d1c:.2f} ({(1-d1c/max(1e-6,d0c))*100:.1f}%)')
    # 6. 碎点
    low0 = ((orig > 0) & (orig <= 40) & (~line)).sum()
    low1 = ((res > 0) & (res <= 40) & (res > 0) & (~(res > 16))).sum()
    print(f'线外低 alpha 碎点像素: {low0} -> {low1}')
    return dict(bg_keep=bg_keep, width_pct=100*(n_res-n_orig)/max(1,n_orig),
                mae_line=mae_line, std_conv=(1-std1/max(1e-6,std0))*100)

if __name__ == '__main__':
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = parse_log(src)
    res = smooth_main_line(a, thr=16, iters=3, radius=4)
    evaluate('样本 v1', a, res)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v1_res.npy', res)
    # 保存为 log 格式便于对比
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v1_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v1结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    print('saved v1_res.log')
