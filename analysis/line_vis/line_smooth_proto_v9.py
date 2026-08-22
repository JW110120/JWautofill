# -*- coding: utf-8 -*-
"""
仅主线条平滑算法 —— 原型 v9（剖面规范化 / profile normalization）
================================================================
目标（用户核心诉求）：
  - 线条顺滑：边缘位置沿线平滑（无锯齿）、粗细均匀
  - alpha 不偏离：主体水平取样本自身水平（局部高百分位），不系统拉亮/拉暗
  - 反复描线极大削弱：同一段线主体水平统一（body 沿线平滑）
  - 不粗不细：重建剖面宽度 = 平滑后边缘位置之差（移动平均不系统改变宽度）

思路：每行的线段被描述为「梯形剖面」= 左缘 L + 右缘 R + 主体水平 body + 单侧渐变宽度 gw：
        alpha(x) = body * clamp(min(x-L, R-x) / gw, 0, 1)
  其中 L/R/body/gw 各自沿线做移动平均 → 边缘位置顺滑、主体统一、渐变规则。
  剖面从"不规则锯齿形"重建为"规则梯形"→ 视觉顺滑、无毛刺、无台阶。

管线：
  Phase 1  逐行提取线内段（alpha>16）→ [x0,x1]
  Phase 2  段特征：L=x0-0.5, R=x1+0.5, body=段内 P85, gw=渐变宽度(从边缘到主体的横向距离)
  Phase 3  段跨行匹配 → L/R/body/gw 序列沿线移动平均（窗口 w=平滑力度）
  Phase 4  逐行重建梯形剖面
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

def seg_features(row_a, x0, x1, body_pct=85):
    """段特征：(L, R, body, gw)。L/R 为亚像素边缘（像素中心坐标）；body=段内 P85；
    gw = 单侧渐变宽度 = 从 alpha=16 到 body 的横向距离（取左右两侧平均，>=0.8）。"""
    vals = row_a[x0:x1 + 1]
    body = float(np.percentile(vals, body_pct)) if len(vals) else 0.0
    # 左缘渐变宽度：从 x0 向右，alpha 从 <=16 升到 >=0.8*body 的像素数
    gwL = 0.8
    for k in range(x0, x1 + 1):
        if row_a[k] >= 0.8 * body:
            gwL = max(0.8, k - x0 + 0.5)
            break
    gwR = 0.8
    for k in range(x1, x0 - 1, -1):
        if row_a[k] >= 0.8 * body:
            gwR = max(0.8, x1 - k + 0.5)
            break
    gw = max(0.8, (gwL + gwR) / 2)
    return x0 - 0.5, x1 + 0.5, body, gw

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

def smooth_main_line(a, thr=16, window=5, body_pct=85, gw_min=0.8):
    h, w = a.shape
    line_mask = a > thr
    bg = a == 0
    out = a.copy()

    # ---- Phase 1+2: 段特征提取 ----
    rows_feat = []  # rows_feat[y] = [(L, R, body, gw), ...]
    for y in range(h):
        feats = []
        for (x0, x1) in row_segments(line_mask[y], w):
            feats.append(seg_features(a[y], x0, x1, body_pct))
        rows_feat.append(feats)

    # ---- Phase 3: 段匹配 + 特征平滑 ----
    tracks = []
    for y in range(h):
        feats = rows_feat[y]
        used = [False] * len(feats)
        for tr in tracks:
            if not tr['active']:
                continue
            best = None
            best_d = 1e9
            for si, (L0, R0, b, g) in enumerate(feats):
                if used[si]:
                    continue
                c = (L0 + R0) / 2
                tc = (tr['Ls'][-1] + tr['Rs'][-1]) / 2
                d = abs(c - tc)
                if d < best_d:
                    best_d = d
                    best = si
            if best is not None and best_d <= 6:
                L0, R0, b, g = feats[best]
                tr['Ls'].append(L0)
                tr['Rs'].append(R0)
                tr['Bs'].append(b)
                tr['Gs'].append(g)
                tr['y1'] = y
                used[best] = True
            else:
                tr['active'] = False
        for si, (L0, R0, b, g) in enumerate(feats):
            if not used[si]:
                tracks.append({'Ls': [L0], 'Rs': [R0], 'Bs': [b], 'Gs': [g],
                               'y0': y, 'y1': y, 'active': True})

    for tr in tracks:
        tr['Ls_sm'] = smooth_sequence(tr['Ls'], window)
        tr['Rs_sm'] = smooth_sequence(tr['Rs'], window)
        tr['Bs_sm'] = smooth_sequence(tr['Bs'], window)
        tr['Gs_sm'] = smooth_sequence(tr['Gs'], window)

    # ---- Phase 4: 重建梯形剖面 ----
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
            gw = max(gw_min, gw1)
            x0 = int(np.floor(L1)) - 1
            x1 = int(np.ceil(R1)) + 1
            for x in range(max(0, x0), min(w, x1 + 1)):
                d = min(x - L1, R1 - x)
                t = d / gw
                if t >= 1.0:
                    v = body1
                elif t <= 0:
                    v = 0.0
                else:
                    # smoothstep 渐变（边缘柔化）
                    t2 = t * t * (3 - 2 * t)
                    v = body1 * t2
                row_out[x] = v

    out[bg] = 0
    return out

def eval_v9(name, orig, res):
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

if __name__ == '__main__':
    src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
    a = parse_log(src)
    for wdw in (3, 5, 7):
        res = smooth_main_line(a, window=wdw)
        print(f'--- window={wdw} ---')
        eval_v9(f'v9 w={wdw}', a, res)
    res = smooth_main_line(a, window=5)
    np.save(r'F:\Coding\JWautofill\analysis\line_vis\v9_res.npy', res)
    with open(r'F:\Coding\JWautofill\analysis\line_vis\v9_res.log', 'w', encoding='utf-8') as f:
        h, w = res.shape
        f.write(f'===== [alpha采样] 图层: v9结果 =====\n尺寸: {w}x{h}\n')
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
    print('saved v9_res.log')
