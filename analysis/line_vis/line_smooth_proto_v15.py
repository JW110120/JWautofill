# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— 原型 v15（规则剖面重建 · 线宽硬保持）
==========================================================
v9-v14 教训：任何"平均/填充/平滑"都会在磨平波动的同时间接改变剖面 → 变粗/变淡/新台阶。
v15 回到"重建"思路并修正 v9 的线宽问题：

  重建公式（保证 alpha>16 边界 = 平滑后段边界 → 线宽严格保持）：
    alpha(x) = 16 + (body - 16) * smoothstep(clamp(depth / gw, 0, 1))
    depth = min(x - L1, R1 - x)   （到平滑后边缘的距离）
    → x = L1/R1 处 alpha = 16（边界，线宽 = R1-L1 = 原段宽）
    → 主体区（depth >= gw）alpha = body（P90 沿线平滑 → 深浅统一、去反复描线）
    → 边缘区 smoothstep 渐变（无锯齿、无毛刺）

特征沿线平滑（移动平均 window=5）：边缘位置 L/R（消除几何锯齿/粗细不均）、
主体水平 body（消除反复描线）、渐变宽度 gw（消除边缘毛刺）。

管线：
  Phase 1  逐行段（alpha>16）→ [x0,x1]，亚像素边缘 L0/R0（alpha64 等高线）
  Phase 2  段特征：body=段内 P90，gw=单侧渐变宽度（alpha16→body 的横向距离）
  Phase 3  段匹配 → L/R/body/gw 沿线移动平均
  Phase 4  规则剖面重建（上述公式）
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

def seg_features(row_a, x0, x1, w, body_pct=90, edge_alpha=64.0):
    """段特征：(L0, R0, body, gw)。L0/R0=亚像素边缘(alpha64)；body=段内 P90；gw=单侧渐变宽。"""
    # 亚像素边缘（alpha 64 等高线，向段外扩展找到）
    le = x0
    while le > 0 and row_a[le - 1] >= edge_alpha:
        le -= 1
    L0 = subpixel_edge(row_a, le, w, edge_alpha, 1) if row_a[le] >= edge_alpha else float(le)
    re_ = x1
    while re_ < w - 1 and row_a[re_ + 1] >= edge_alpha:
        re_ += 1
    R0 = subpixel_edge(row_a, re_, w, edge_alpha, -1) if row_a[re_] >= edge_alpha else float(re_)

    vals = row_a[x0:x1 + 1]
    body = float(np.percentile(vals, body_pct)) if len(vals) else 0.0
    # 单侧渐变宽度：从 alpha16 边界到 alpha>=0.9*body 的横向距离
    gwL = 0.8
    for k in range(x0, x1 + 1):
        if row_a[k] >= 0.9 * body:
            gwL = max(0.8, k - x0 + 0.5)
            break
    gwR = 0.8
    for k in range(x1, x0 - 1, -1):
        if row_a[k] >= 0.9 * body:
            gwR = max(0.8, x1 - k + 0.5)
            break
    gw = max(0.8, (gwL + gwR) / 2)
    return L0, R0, body, gw

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

def smooth_main_line(a, thr=16, window=5, body_pct=90, edge_alpha=64.0):
    h, w = a.shape
    line_mask = a > thr
    bg = a == 0
    out = a.copy()

    # ---- Phase 1+2: 段特征 ----
    row_data = []
    for y in range(h):
        entries = []
        for (x0, x1) in row_segments(line_mask[y], w):
            entries.append(seg_features(a[y], x0, x1, w, body_pct, edge_alpha))
        row_data.append(entries)

    # ---- Phase 3: 段匹配 + 特征平滑 ----
    tracks = []
    for y in range(h):
        entries = row_data[y]
        used = [False] * len(entries)
        for tr in tracks:
            if not tr['active']:
                continue
            best = None
            best_d = 1e9
            for si, (L0, R0, b, g) in enumerate(entries):
                if used[si]:
                    continue
                c = (L0 + R0) / 2
                tc = (tr['Ls'][-1] + tr['Rs'][-1]) / 2
                d = abs(c - tc)
                if d < best_d:
                    best_d = d
                    best = si
            if best is not None and best_d <= 6:
                L0, R0, b, g = entries[best]
                tr['Ls'].append(L0); tr['Rs'].append(R0)
                tr['Bs'].append(b); tr['Gs'].append(g)
                tr['y1'] = y
                used[best] = True
            else:
                tr['active'] = False
        for si, (L0, R0, b, g) in enumerate(entries):
            if not used[si]:
                tracks.append({'Ls': [L0], 'Rs': [R0], 'Bs': [b], 'Gs': [g],
                               'y0': y, 'y1': y, 'active': True})

    for tr in tracks:
        tr['Ls_sm'] = smooth_sequence(tr['Ls'], window)
        tr['Rs_sm'] = smooth_sequence(tr['Rs'], window)
        tr['Bs_sm'] = smooth_sequence(tr['Bs'], window)
        tr['Gs_sm'] = smooth_sequence(tr['Gs'], window)

    # ---- Phase 4: 规则剖面重建 ----
    row_info = [[] for _ in range(h)]
    for tr in tracks:
        y0 = tr['y0']
        n = len(tr['Ls'])
        for i in range(n):
            y = y0 + i
            if None in (tr['Ls_sm'][i], tr['Rs_sm'][i], tr['Bs_sm'][i], tr['Gs_sm'][i]):
                continue
            row_info[y].append((tr['Ls_sm'][i], tr['Rs_sm'][i], tr['Bs_sm'][i], tr['Gs_sm'][i]))

    for y in range(h):
        if not row_info[y]:
            continue
        row_out = out[y]
        for L1, R1, body1, gw1 in row_info[y]:
            gw = max(0.8, gw1)
            x0 = max(0, int(np.floor(L1)) - 2)
            x1 = min(w - 1, int(np.ceil(R1)) + 2)
            for x in range(x0, x1 + 1):
                d = min(x - L1, R1 - x)
                if d <= 0:
                    v = 0.0
                elif d >= gw:
                    v = body1
                else:
                    t = d / gw
                    t2 = t * t * (3 - 2 * t)  # smoothstep
                    v = 16 + (body1 - 16) * t2
                row_out[x] = v

    out[bg] = 0
    return out

def eval_v15(name, orig, res):
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
        eval_v15(f'v15 w={wdw}', a, res)
    res = smooth_main_line(a, window=5)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v15_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v15_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v15结果 =====\n尺寸: {w}x{h}\n')
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
    print('saved v15_res.log')
