# -*- coding: utf-8 -*-
"""v8 续：DL 分布 + 漏填(DF>1 真孔洞)位置 + 连通域特征"""
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
DL = dist_to_mask(Lm)
R_all = hole_fill(close_m(Lm, 1))

rz = [i for i in range(N) if R_all[i] and fill[i]==0]
true_hole = [i for i in rz if good[i]==255]
false_hole = [i for i in rz if good[i]==0]
miss = [i for i in true_hole if DF[i] > 1]   # DF>1 的真孔洞（v7 漏的）

print(f"真孔洞 DF>1: {len(miss)}")

# DL 分布
print("\n=== DL（距线稿描边）分布 ===")
print(f"真孔洞(全部) DL: {dict(sorted(Counter(DL[i] for i in true_hole).items()))}")
print(f"真孔洞(DF>1漏) DL: {dict(sorted(Counter(DL[i] for i in miss).items()))}")
print(f"凹尖角 DL: {dict(sorted(Counter(DL[i] for i in false_hole).items()))}")

# 漏填位置（DF>1 真孔洞）
print("\n=== DF>1 真孔洞位置（聚簇）===")
miss_set = set(miss)
visited = set(); clusters = []
for i in miss:
    if i in visited: continue
    stack=[i]; visited.add(i); sz=0; pts=[]
    while stack:
        j=stack.pop(); sz+=1; pts.append(j)
        x,y=j%CW,j//CW
        for dx in (-1,0,1):
            for dy in (-1,0,1):
                nx,ny=x+dx,y+dy
                if 0<=nx<CW and 0<=ny<CH:
                    ni=ny*CW+nx
                    if ni in miss_set and ni not in visited:
                        visited.add(ni); stack.append(ni)
    clusters.append((sz, pts))
clusters.sort(reverse=True)
for sz, pts in clusters:
    xs=[p%CW for p in pts]; ys=[p//CW for p in pts]
    dl_vals = [DL[p] for p in pts]
    df_vals = [DF[p] for p in pts]
    print(f"  簇: {sz}px  x[{min(xs)}-{max(xs)}] y[{min(ys)}-{max(ys)}]  DL min={min(dl_vals)} max={max(dl_vals)}  DF min={min(df_vals)} max={max(df_vals)}")

# 凹尖角聚簇（看最大簇的形态）
print("\n=== 凹尖角聚簇（前5大）===")
fh_set = set(false_hole)
visited = set(); clusters2 = []
for i in false_hole:
    if i in visited: continue
    stack=[i]; visited.add(i); sz=0
    while stack:
        j=stack.pop(); sz+=1
        x,y=j%CW,j//CW
        for dx in (-1,0,1):
            for dy in (-1,0,1):
                nx,ny=x+dx,y+dy
                if 0<=nx<CW and 0<=ny<CH:
                    ni=ny*CW+nx
                    if ni in fh_set and ni not in visited:
                        visited.add(ni); stack.append(ni)
    clusters2.append(sz)
print(f"凹尖角连通簇大小: {sorted(clusters2, reverse=True)[:10]}")

# 规则组合: DF<=1 或 (DL 很大 = 远离线稿描边 = 填充内部洞)
print("\n=== 组合规则 (DF<=1 或 DL>=3) ===")
t = sum(1 for i in true_hole if DF[i]<=1 or DL[i]>=3)
f = sum(1 for i in false_hole if DF[i]<=1 or DL[i]>=3)
print(f"真孔洞保留 {t}/{len(true_hole)} ({t*100.0/len(true_hole):.1f}%), 凹尖角误留 {f}/{len(false_hole)} ({f*100.0/len(false_hole):.1f}%)")
print("\n=== 组合规则 (DF<=1 或 DL>=2) ===")
t = sum(1 for i in true_hole if DF[i]<=1 or DL[i]>=2)
f = sum(1 for i in false_hole if DF[i]<=1 or DL[i]>=2)
print(f"真孔洞保留 {t}/{len(true_hole)} ({t*100.0/len(true_hole):.1f}%), 凹尖角误留 {f}/{len(false_hole)} ({f*100.0/len(false_hole):.1f}%)")
