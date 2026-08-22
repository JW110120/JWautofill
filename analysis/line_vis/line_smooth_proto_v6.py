# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— 原型 v6（边缘位置平滑 / 几何法）
====================================================
针对 v4/v5 反馈的根本修正：
  v4 问题：主体收敛抬高 alpha → 台阶/视觉变粗；边缘可提升 → 局部变粗。
  v5 问题：alpha 场的深度约束无法同时"磨平锯齿"与"保持剖面"（锯齿点深度差 vs 跨层混合矛盾）。

v6 思路：**直接在几何层平滑"边缘位置"** —— 锯齿的本质是边缘位置沿线的抖动，
        把每行线段的左右边缘位置沿线做移动平均，再用平滑后的位置重采样 alpha：
          - 原段内的像素：alpha 平移映射（剖面形状严格保持）
          - 新段比原段宽（锯齿缺口）：缺口处取原段边缘 alpha → 填平缺口
          - 新段比原段窄（锯齿凸起）：凸起超出部分 alpha=0 → 削平凸起
        净效果：边缘位置顺滑（无锯齿）、粗细均匀、alpha 数值几乎不变（不粗不细不偏离）。

管线：
  Phase 1  逐行提取线内段（alpha>16 的连续区间）[L[y], R[y]]
  Phase 2  段跨行匹配（最近邻）→ 每段 L/R 序列
  Phase 3  每段 L/R 沿线移动平均（窗口 w，w 由平滑力度决定）→ L_sm/R_sm
  Phase 4  每行按平滑后位置重采样 alpha（平移映射 + 段外归零）
  Phase 5  背景保持
"""
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
    a = np.zeros((h, w), dtype=np.float64)
    for y, vals in grid.items():
        for x, v in enumerate(vals):
            a[y, x] = v
    return a

def extract_row_segments(mask_row, w):
    """一行内连续 mask=1 的段列表 [(x0,x1),...]"""
    segs = []
    x = 0
    while x < w:
        if mask_row[x]:
            x0 = x
            while x < w and mask_row[x]:
                x += 1
            segs.append((x0, x - 1))
        else:
            x += 1
    return segs

def smooth_sequence(seq, window):
    """移动平均（窗口奇数）。seq: list[float|None]，None=无效。返回同长列表。"""
    n = len(seq)
    out = [None] * n
    half = window // 2
    for i in range(n):
        if seq[i] is None:
            continue
        vals = []
        for k in range(-half, half + 1):
            j = i + k
            if 0 <= j < n and seq[j] is not None:
                vals.append(seq[j])
        if vals:
            out[i] = sum(vals) / len(vals)
    return out

def smooth_main_line(a, thr=16, window=5, pad=2):
    h, w = a.shape
    line_mask = a > thr
    bg = a == 0
    out = a.copy()

    # ---- Phase 1: 逐行提取段 ----
    rows = []  # rows[y] = [(x0,x1), ...]
    for y in range(h):
        rows.append(extract_row_segments(line_mask[y], w))

    # ---- Phase 2: 段跨行匹配（最近邻，维护段轨迹）----
    # tracks: list of {x0s:[...], x1s:[...], active}
    tracks = []
    for y in range(h):
        segs = rows[y]
        used = [False] * len(segs)
        # 与活跃轨迹匹配（中心距离最小）
        for tr in tracks:
            if not tr['active']:
                continue
            best = None
            best_d = 1e9
            for si, (x0, x1) in enumerate(segs):
                if used[si]:
                    continue
                c = (x0 + x1) / 2
                tc = (tr['x0s'][-1] + tr['x1s'][-1]) / 2
                d = abs(c - tc)
                if d < best_d:
                    best_d = d
                    best = si
            if best is not None and best_d <= 6:
                x0, x1 = segs[best]
                tr['x0s'].append(x0)
                tr['x1s'].append(x1)
                tr['y1'] = y
                used[best] = True
            else:
                tr['active'] = False
        # 未匹配的段 → 新轨迹
        for si, (x0, x1) in enumerate(segs):
            if not used[si]:
                tracks.append({'x0s': [x0], 'x1s': [x1], 'y0': y, 'y1': y, 'active': True})

    # ---- Phase 3: 每段 L/R 平滑 ----
    for tr in tracks:
        tr['x0s_sm'] = smooth_sequence(tr['x0s'], window)
        tr['x1s_sm'] = smooth_sequence(tr['x1s'], window)

    # ---- Phase 4: 重采样 ----
    # 记录每行每段的平滑位置，用于重建
    row_info = [[] for _ in range(h)]  # row_info[y] = [(L_sm, R_sm, L_orig, R_orig)]
    for tr in tracks:
        y0 = tr['y0']
        n = len(tr['x0s'])
        for i in range(n):
            y = y0 + i
            L0, R0 = tr['x0s'][i], tr['x1s'][i]
            L1, R1 = tr['x0s_sm'][i], tr['x1s_sm'][i]
            if L1 is None or R1 is None:
                continue
            row_info[y].append((int(round(L1)), int(round(R1)), L0, R0))

    for y in range(h):
        if not row_info[y]:
            continue
        row_a = a[y]
        row_out = out[y]
        for L1, R1, L0, R0 in row_info[y]:
            # 平移映射：目标位置 x ↔ 源位置 src = L0 + (x - L1)
            # 边界：[min(L0,L1)-pad, max(R0,R1)+pad]
            x_start = min(L0, L1) - pad
            x_end = max(R0, R1) + pad
            for x in range(x_start, x_end + 1):
                if x < 0 or x >= w:
                    continue
                src = L0 + (x - L1)
                if src < L0 - 0.5:
                    # 新段左扩（填缺口）：取原左缘剖面外推
                    d = L0 - src
                    v = row_a[max(0, int(L0))] - d * 4
                    row_out[x] = max(0, min(255, v))
                elif src > R0 + 0.5:
                    # 新段右扩（填缺口）：取原右缘剖面外推
                    d = src - R0
                    v = row_a[min(w - 1, int(R0))] - d * 4
                    row_out[x] = max(0, min(255, v))
                else:
                    # 原段内：双线性插值
                    s0 = int(np.floor(src))
                    f = src - s0
                    s1 = min(w - 1, s0 + 1)
                    s0 = max(0, s0)
                    row_out[x] = row_a[s0] * (1 - f) + row_a[s1] * f

    out[bg] = 0
    return out

def eval_v6(name, orig, res):
    line = orig > 16
    bg = orig == 0
    print(f'\n===== {name} =====')
    print(f'背景保持: {(res[bg]==0).mean()*100:.2f}%')
    n_orig, n_res = line.sum(), (res > 16).sum()
    print(f'线宽变化: {100*(n_res-n_orig)/max(1,n_orig):+.1f}%')
    mae = np.abs(res[line]-orig[line]).mean()
    m_shift = res[line].mean() - orig[line].mean()
    print(f'线内 MAE: {mae:.2f}, 均值偏移: {m_shift:+.1f}')
    from scipy import ndimage
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

if __name__ == '__main__':
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = parse_log(src)
    for wdw in (3, 5, 7):
        res = smooth_main_line(a, window=wdw)
        print(f'--- window={wdw} ---')
        eval_v6(f'v6 w={wdw}', a, res)
    res = smooth_main_line(a, window=5)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v6_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v6_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v6结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    print('\n=== 病灶2 复查（y=48-52 x=24-27） ===')
    for y in range(48, 53):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(24,28)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(24,28)) }')
    print('\n=== 病灶1 复查（主线左侧 y=25-31 x=2..8） ===')
    for y in range(25, 32):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(2,9)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(2,9)) }')
    print('saved v6_res.log')
