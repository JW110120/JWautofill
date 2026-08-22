# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— 原型 v11（剖面规范化完整版）
=================================================
v10 教训：对称方向平滑削锯齿强，但"过渡带只降不升"导致锯齿低点磨不平；
病灶2 分析：x=26 列的 181/133/57/13/1 是"每行边缘位置不同(1px 抖动)+每行剖面不同"，
          单靠 alpha 场平滑无法同时磨平两者。

v11 核心：**几何 + 剖面双平滑** ——
  1. 每行提取段，段用「左剖面 prof_L + 右剖面 prof_R」描述（到边缘距离→alpha）
  2. 段跨行匹配 → 每段 L/R 边缘位置沿线移动平均（消除几何锯齿/粗细不均）
     同时每段 prof_L/prof_R 沿线平均（消除剖面波动 → 毛刺/反复描线磨平）
  3. 重建：alpha(x) = 该段平均剖面[到平滑后边缘的距离]
     → 每行剖面规则、边缘位置顺滑 → 无锯齿、无毛刺、深浅统一
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

def row_segments(mask_row, w):
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

def subpixel_edge(row_a, x_edge, w, edge_alpha=64.0, direction=1):
    """亚像素边缘：在 x_edge-1（<64）与 x_edge（>=64）之间插值（direction=1 左缘），
    或在 x_edge（>=64）与 x_edge+1（<64）之间插值（direction=-1 右缘）。"""
    if direction == 1:
        x0, x1 = x_edge - 1, x_edge
    else:
        x0, x1 = x_edge, x_edge + 1
    if x0 < 0 or x1 >= w:
        return float(x_edge)
    v0, v1 = row_a[x0], row_a[x1]
    if v1 - v0 < 1e-6:
        return float(x_edge)
    t = (edge_alpha - v0) / (v1 - v0)
    return x0 + max(0.0, min(1.0, t))

def segment_edges(row_a, x0, x1, w, edge_alpha=64.0):
    """段 [x0,x1]（alpha>16 连续区间）的亚像素左右缘（alpha 64 等高线）。"""
    # 左缘：从 x0 向左找 alpha 跨过 64 的位置（x0 处可能已 >64）
    le = x0
    while le > 0 and row_a[le - 1] >= edge_alpha:
        le -= 1
    if row_a[le] >= edge_alpha:
        L = subpixel_edge(row_a, le, w, edge_alpha, 1)
    else:
        L = float(le)
    # 右缘
    re_ = x1
    while re_ < w - 1 and row_a[re_ + 1] >= edge_alpha:
        re_ += 1
    if row_a[re_] >= edge_alpha:
        R = subpixel_edge(row_a, re_, w, edge_alpha, -1)
    else:
        R = float(re_)
    return L, R

def extract_profile(row_a, L, R, w, max_depth=5):
    """提取段剖面：左剖面 profL[d]=距左缘 d 处 alpha，右剖面 profR[d]=距右缘 d 处 alpha。
    返回 (profL, profR)（长度 max_depth+1，缺失补 None）。"""
    profL = [None] * (max_depth + 1)
    profR = [None] * (max_depth + 1)
    for x in range(max(0, int(np.floor(L)) - 2), min(w, int(np.ceil(R)) + 3)):
        dL = x - L
        dR = R - x
        if 0 <= dL <= max_depth and x < (L + R) / 2:
            profL[int(round(dL))] = row_a[x]
        if 0 <= dR <= max_depth and x >= (L + R) / 2:
            profR[int(round(dR))] = row_a[x]
    # 缺口补齐（沿深度线性插值）
    for prof in (profL, profR):
        last = None
        for i in range(max_depth + 1):
            if prof[i] is None:
                if last is not None:
                    # 向后找下一个有效值插值
                    nxt = None
                    for j in range(i + 1, max_depth + 1):
                        if prof[j] is not None:
                            nxt = prof[j]
                            break
                    if nxt is not None:
                        prof[i] = last + (nxt - last) * (i - (i - 1))  # 简化：用 last
            else:
                last = prof[i]
    return profL, profR

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

def smooth_avg_profiles(profiles, window):
    """跨行平均剖面序列（每行一个 (profL, profR) 对）。"""
    n = len(profiles)
    half = window // 2
    out = []
    for i in range(n):
        cntL = [0] * len(profiles[i][0])
        sumL = [0.0] * len(profiles[i][0])
        cntR = [0] * len(profiles[i][1])
        sumR = [0.0] * len(profiles[i][1])
        for k in range(-half, half + 1):
            j = i + k
            if 0 <= j < n:
                pL, pR = profiles[j]
                for d in range(len(pL)):
                    if pL[d] is not None:
                        sumL[d] += pL[d]; cntL[d] += 1
                    if pR[d] is not None:
                        sumR[d] += pR[d]; cntR[d] += 1
        avgL = [sumL[d] / cntL[d] if cntL[d] else None for d in range(len(sumL))]
        avgR = [sumR[d] / cntR[d] if cntR[d] else None for d in range(len(sumR))]
        out.append((avgL, avgR))
    return out

def smooth_main_line(a, thr=16, window=5, edge_alpha=64.0, max_depth=5):
    h, w = a.shape
    line_mask = a > thr
    bg = a == 0
    out = a.copy()

    # ---- Phase 1+2: 逐行段边缘 + 剖面 ----
    row_data = []  # row_data[y] = [(L0, R0, profL, profR), ...]
    for y in range(h):
        entries = []
        for (x0, x1) in row_segments(line_mask[y], w):
            L0, R0 = segment_edges(a[y], x0, x1, w, edge_alpha)
            profL, profR = extract_profile(a[y], L0, R0, w, max_depth)
            entries.append((L0, R0, profL, profR))
        row_data.append(entries)

    # ---- Phase 3: 段匹配 + L/R 平滑 + 剖面平均 ----
    tracks = []
    for y in range(h):
        entries = row_data[y]
        used = [False] * len(entries)
        for tr in tracks:
            if not tr['active']:
                continue
            best = None
            best_d = 1e9
            for si, (L0, R0, pL, pR) in enumerate(entries):
                if used[si]:
                    continue
                c = (L0 + R0) / 2
                tc = (tr['Ls'][-1] + tr['Rs'][-1]) / 2
                d = abs(c - tc)
                if d < best_d:
                    best_d = d
                    best = si
            if best is not None and best_d <= 6:
                L0, R0, pL, pR = entries[best]
                tr['Ls'].append(L0); tr['Rs'].append(R0)
                tr['profs'].append((pL, pR))
                tr['y1'] = y
                used[best] = True
            else:
                tr['active'] = False
        for si, (L0, R0, pL, pR) in enumerate(entries):
            if not used[si]:
                tracks.append({'Ls': [L0], 'Rs': [R0], 'profs': [(pL, pR)],
                               'y0': y, 'y1': y, 'active': True})

    for tr in tracks:
        tr['Ls_sm'] = smooth_sequence(tr['Ls'], window)
        tr['Rs_sm'] = smooth_sequence(tr['Rs'], window)
        tr['profs_sm'] = smooth_avg_profiles(tr['profs'], window)

    # ---- Phase 4: 重建 ----
    row_info = [[] for _ in range(h)]
    for tr in tracks:
        y0 = tr['y0']
        n = len(tr['Ls'])
        for i in range(n):
            y = y0 + i
            if tr['Ls_sm'][i] is None or tr['Rs_sm'][i] is None:
                continue
            row_info[y].append((tr['Ls_sm'][i], tr['Rs_sm'][i], tr['profs_sm'][i]))

    for y in range(h):
        if not row_info[y]:
            continue
        row_out = out[y]
        for L1, R1, (profL, profR) in row_info[y]:
            mid = (L1 + R1) / 2
            x0 = max(0, int(np.floor(L1)) - 2)
            x1 = min(w - 1, int(np.ceil(R1)) + 2)
            for x in range(x0, x1 + 1):
                if x < L1 - 0.5 or x > R1 + 0.5:
                    continue
                if x < mid:
                    d = int(round(x - L1))
                    if 0 <= d < len(profL) and profL[d] is not None:
                        row_out[x] = profL[d]
                else:
                    d = int(round(R1 - x))
                    if 0 <= d < len(profR) and profR[d] is not None:
                        row_out[x] = profR[d]

    out[bg] = 0
    return out

def eval_v11(name, orig, res):
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
    d_row0 = np.abs(np.diff(orig.astype(float), axis=0)).mean()
    d_row1 = np.abs(np.diff(res.astype(float), axis=0)).mean()
    print(f'相邻行突变: {d_row0:.2f} -> {d_row1:.2f} ({(1-d_row1/d_row0)*100:.0f}%)')

if __name__ == '__main__':
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = parse_log(src)
    for wdw in (3, 5, 7):
        res = smooth_main_line(a, window=wdw)
        print(f'--- window={wdw} ---')
        eval_v11(f'v11 w={wdw}', a, res)
    res = smooth_main_line(a, window=5)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v11_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v11_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v11结果 =====\n尺寸: {w}x{h}\n')
        for y in range(h):
            f.write(f'y={y}: ' + ','.join(str(int(round(res[y, x]))) for x in range(w)) + '\n')
        f.write('===== [alpha采样] 结束 =====\n')
    print('\n=== 病灶2 复查（y=48-52 x=24-27） ===')
    for y in range(48, 53):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(24,28)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(24,28)) }')
    print('\n=== 病灶1 复查（主线左侧 y=25-31 x=2..8） ===')
    for y in range(25, 32):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(2,9)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(2,9)) }')
    print('\n=== 反复描线复查（第二支 y=25-28 x=33..41） ===')
    for y in range(25, 29):
        print(f'y={y} 原:{ " ".join(f"{a[y,x]:3.0f}" for x in range(33,42)) }  出:{ " ".join(f"{res[y,x]:3.0f}" for x in range(33,42)) }')
    print('saved v11_res.log')
