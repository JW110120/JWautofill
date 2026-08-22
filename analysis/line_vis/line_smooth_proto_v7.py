# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— 原型 v7（亚像素边缘位置平滑 + 深度剖面重建）
================================================================
v6 教训：用"alpha>16 段边界"做边缘位置平滑，重采样把正常渐变填实（线宽+23%）。
v7 核心：**深度剖面保持的边缘位置平滑**：
  1. 每行提取亚像素左/右缘位置（alpha 跨过 64 的等高线，线性插值）
  2. 段跨行匹配 → L/R 序列沿线移动平均（窗口 w=平滑力度）
  3. 重建：每个像素 alpha = 该行"深度→alpha 剖面"在新深度处的值
     （深度 = 到新边缘的距离；剖面 = 原行 alpha 随深度分布）
     → 边缘位置顺滑（锯齿消除）、剖面形状保持（不粗不细、alpha 不偏离）
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

def row_edges(a_row, w, edge_alpha=64.0):
    """提取一行内所有段的亚像素边缘位置。
    返回 [(L0, R0), ...]：L0/R0 为 alpha 跨过 edge_alpha 的插值位置（浮点，像素中心坐标）。
    """
    segs = []
    x = 0
    while x < w - 1:
        if a_row[x] >= edge_alpha:
            x0 = x
            while x < w - 1 and a_row[x] >= edge_alpha:
                x += 1
            # 左缘（x0 处从 <64 到 >=64）：插值
            L = x0
            if x0 > 0:
                v0, v1 = a_row[x0 - 1], a_row[x0]
                if v1 > v0:
                    L = x0 - 1 + (edge_alpha - v0) / (v1 - v0)
            # 右缘（x-1 处从 >=64 到 <64）
            R = x - 1
            if x < w:
                v0, v1 = a_row[x - 1], a_row[x]
                if v0 > v1:
                    R = x - 1 + (edge_alpha - v0) / (v1 - v0)
            segs.append((L, R))
        else:
            x += 1
    return segs

def smooth_sequence(seq, window):
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

def smooth_main_line(a, thr=16, window=5, edge_alpha=64.0, pad=3):
    h, w = a.shape
    bg = a == 0
    out = a.copy()

    # ---- Phase 1+2: 逐行亚像素边缘 + 段匹配 ----
    row_edges_all = []
    for y in range(h):
        row_edges_all.append(row_edges(a[y], w, edge_alpha))

    tracks = []
    for y in range(h):
        segs = row_edges_all[y]
        used = [False] * len(segs)
        for tr in tracks:
            if not tr['active']:
                continue
            best = None
            best_d = 1e9
            for si, (L0, R0) in enumerate(segs):
                if used[si]:
                    continue
                c = (L0 + R0) / 2
                tc = (tr['Ls'][-1] + tr['Rs'][-1]) / 2
                d = abs(c - tc)
                if d < best_d:
                    best_d = d
                    best = si
            if best is not None and best_d <= 6:
                L0, R0 = segs[best]
                tr['Ls'].append(L0)
                tr['Rs'].append(R0)
                tr['y1'] = y
                used[best] = True
            else:
                tr['active'] = False
        for si, (L0, R0) in enumerate(segs):
            if not used[si]:
                tracks.append({'Ls': [L0], 'Rs': [R0], 'y0': y, 'y1': y, 'active': True})

    # ---- Phase 3: 平滑 L/R ----
    for tr in tracks:
        tr['Ls_sm'] = smooth_sequence(tr['Ls'], window)
        tr['Rs_sm'] = smooth_sequence(tr['Rs'], window)

    # ---- Phase 4: 重建（深度剖面保持） ----
    # 每行的重建信息：[(L1, R1, L0, R0)]
    row_info = [[] for _ in range(h)]
    for tr in tracks:
        y0 = tr['y0']
        n = len(tr['Ls'])
        for i in range(n):
            y = y0 + i
            if tr['Ls_sm'][i] is None or tr['Rs_sm'][i] is None:
                continue
            row_info[y].append((tr['Ls_sm'][i], tr['Rs_sm'][i], tr['Ls'][i], tr['Rs'][i]))

    for y in range(h):
        if not row_info[y]:
            continue
        row_a = a[y]
        row_out = out[y]
        for L1, R1, L0, R0 in row_info[y]:
            w_orig = max(0.5, R0 - L0)
            w_new = max(0.5, R1 - L0)  # 注意：左缘平滑后，宽度 = R1 - L0? 见下
            # 重建范围：新段 [L1, R1] ± pad
            x0 = int(np.floor(min(L0, L1))) - pad
            x1 = int(np.ceil(max(R0, R1))) + pad
            for x in range(max(0, x0), min(w, x1 + 1)):
                # 深度剖面映射：以"左缘-深度/右缘-深度"双剖面重建
                # 左半（x 距 L1 更近）与右半（距 R1 更近）取各自剖面
                dL = x - L1   # 距新左缘
                dR = R1 - x   # 距新右缘
                if dL <= dR:
                    # 左半：alpha = 原行在"距原左缘 dL"处的值（剖面保持）
                    src = L0 + dL
                    if src < -0.5:
                        # 超出原左缘：用原左缘剖面外推（填缺口，浅）
                        v = max(0, row_a[max(0, int(np.floor(L0)))] + (src - L0) * 6)
                        row_out[x] = min(255, v)
                    elif src > R0 + 0.5:
                        row_out[x] = 0
                    else:
                        s0 = int(np.floor(src))
                        f = src - s0
                        s1 = min(w - 1, s0 + 1)
                        s0 = max(0, s0)
                        row_out[x] = row_a[s0] * (1 - f) + row_a[s1] * f
                else:
                    # 右半
                    src = R0 - dR
                    if src > R0 + 0.5:
                        v = max(0, row_a[min(w - 1, int(np.ceil(R0)))] + (R0 - src) * 6)
                        row_out[x] = min(255, v)
                    elif src < L0 - 0.5:
                        row_out[x] = 0
                    else:
                        s0 = int(np.floor(src))
                        f = src - s0
                        s1 = min(w - 1, s0 + 1)
                        s0 = max(0, s0)
                        row_out[x] = row_a[s0] * (1 - f) + row_a[s1] * f

    out[bg] = 0
    return out

def eval_v7(name, orig, res):
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
        eval_v7(f'v7 w={wdw}', a, res)
    res = smooth_main_line(a, window=5)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v7_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v7_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v7结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    print('\n=== 病灶2 复查（y=48-52 x=24-27） ===')
    for y in range(48, 53):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(24,28)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(24,28)) }')
    print('\n=== 病灶1 复查（主线左侧 y=25-31 x=2..8） ===')
    for y in range(25, 32):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(2,9)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(2,9)) }')
    print('saved v7_res.log')
