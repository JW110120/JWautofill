# -*- coding: utf-8 -*-
"""v8 续4：逐像素特征矩阵，扫描最优分离规则"""
import json
from collections import deque, Counter

def load(p):
    d = json.load(open(p))
    return int(d['meta']['w']), int(d['meta']['h']), {int(k): v for k, v in d['rows'].items()}

CW, CH = 150, 145
def place(path, ox, oy):
    w, h, rows = load(path)
    c = [0]*(CW*CH)
    for y in range(h):
        r = rows.get(y, [])
        for x in range(len(r)):
            if x < w: c[(y+oy)*CW+(x+ox)] = r[x]
    return c

line = place('analysis/line.json', 10, 9)
fill = place('analysis/fill_with_holes.json', 13, 11)
good = place('analysis/fill_filled.json', 11, 9)
N = CW*CH

def dilate(mask, r):
    out=mask[:]; dist=[10**9]*N; dq=deque()
    for i in range(N):
        if out[i]: dist[i]=0; dq.append(i)
    while dq:
        i=dq.popleft(); d=dist[i]
        if d>=r: continue
        x=i%CW; y=i//CW
        for dx,dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH:
                ni=ny*CW+nx
                if dist[ni]>d+1: dist[ni]=d+1; out[ni]=1; dq.append(ni)
    return out
def erode(mask, r):
    out=mask[:]; dist=[10**9]*N; dq=deque()
    for i in range(N):
        if not out[i]: dist[i]=0; dq.append(i)
    while dq:
        i=dq.popleft(); d=dist[i]
        if d>=r: continue
        x=i%CW; y=i//CW
        for dx,dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH:
                ni=ny*CW+nx
                if dist[ni]>d+1: dist[ni]=d+1; out[ni]=0; dq.append(ni)
    return out
def close_m(mask, r): return erode(dilate(mask, r), r)
def dist_to_mask(mask):
    D=[10**9]*N; dq=deque()
    for i in range(N):
        if mask[i]: D[i]=0; dq.append(i)
    while dq:
        i=dq.popleft(); d=D[i]
        x=i%CW; y=i//CW
        for dx,dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH:
                ni=ny*CW+nx
                if D[ni]>d+1: D[ni]=d+1; dq.append(ni)
    return D
def hole_fill(mask):
    out = mask[:]
    D=[10**9]*N; dq=deque()
    for i in range(N):
        if not mask[i]:
            x,y=i%CW,i//CW
            if x==0 or y==0 or x==CW-1 or y==CH-1:
                D[i]=0; dq.append(i)
    while dq:
        i=dq.popleft(); x=i%CW; y=i//CW
        for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH:
                ni=ny*CW+nx
                if not mask[ni] and D[ni]==10**9:
                    D[ni]=0; dq.append(ni)
    for i in range(N):
        if not mask[i] and D[i]==10**9: out[i]=1
    return out

M_fill = [1 if fill[i]>16 else 0 for i in range(N)]
Lm = [1 if line[i]>16 else 0 for i in range(N)]
DF = dist_to_mask(M_fill)
R_all = hole_fill(close_m(Lm, 1))

# 联合掩码（含线稿）用于 nH
M_union = [1 if (M_fill[i] or Lm[i]) else 0 for i in range(N)]
def nbr_cnt(i, mask):
    x,y=i%CW,i//CW; cnt=0
    for dx in (-1,0,1):
        for dy in (-1,0,1):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH:
                if mask[ny*CW+nx]: cnt+=1
    return cnt

rz = [i for i in range(N) if R_all[i] and fill[i]==0]
true_hole = [i for i in rz if good[i]==255]
false_hole = [i for i in rz if good[i]==0]

# 特征扫描：规则 = DF<=1 | (in_line==False) | (其他特征)
print("=== 候选规则扫描（R 内 fill=0 像素）===")
rules = {
    'DF<=1': lambda i: DF[i]<=1,
    'not in_line': lambda i: not Lm[i],
    'DF<=1 | not in_line': lambda i: DF[i]<=1 or not Lm[i],
    'DF<=2 | not in_line': lambda i: DF[i]<=2 or not Lm[i],
    'DF<=1 | nH>=9': lambda i: DF[i]<=1 or nbr_cnt(i,M_union)>=9,
    'DF<=2 | nH>=9': lambda i: DF[i]<=2 or nbr_cnt(i,M_union)>=9,
    'DF<=3 | nH>=9': lambda i: DF[i]<=3 or nbr_cnt(i,M_union)>=9,
}
for name, rule in rules.items():
    t = sum(1 for i in true_hole if rule(i))
    f = sum(1 for i in false_hole if rule(i))
    print(f"  {name:20s}: 真孔洞保留 {t}/{len(true_hole)} ({t*100.0/len(true_hole):.1f}%), 凹尖角误留 {f}/{len(false_hole)} ({f*100.0/len(false_hole):.1f}%)")

# nH 分布（联合掩码邻域）
print("\n=== nH(联合掩码8邻域) 分布 ===")
print(f"真孔洞: {dict(sorted(Counter(nbr_cnt(i,M_union) for i in true_hole).items()))}")
print(f"凹尖角: {dict(sorted(Counter(nbr_cnt(i,M_union) for i in false_hole).items()))}")

# in_line 与 DF 交叉
print("\n=== in_line × DF 交叉 ===")
for il in (0, 1):
    sub_t = [i for i in true_hole if Lm[i]==il]
    sub_f = [i for i in false_hole if Lm[i]==il]
    print(f"  in_line={il}: 真孔洞 {len(sub_t)}, 凹尖角 {len(sub_f)}")
    for th in (1,2,3):
        t2 = sum(1 for i in sub_t if DF[i]<=th)
        f2 = sum(1 for i in sub_f if DF[i]<=th)
        print(f"    DF<={th}: 真 {t2}/{len(sub_t)} ({t2*100.0/max(1,len(sub_t)):.0f}%), 凹 {f2}/{len(sub_f)} ({f2*100.0/max(1,len(sub_f)):.0f}%)")
