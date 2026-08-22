# -*- coding: utf-8 -*-
"""v8 续3：凹尖角簇位置 + 线稿关系 + ASCII 图"""
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

Lm = [1 if line[i]>16 else 0 for i in range(N)]
M_fill = [1 if fill[i]>16 else 0 for i in range(N)]
R_all = hole_fill(close_m(Lm, 1))

rz = [i for i in range(N) if R_all[i] and fill[i]==0]
false_hole = [i for i in rz if good[i]==0]
true_hole = [i for i in rz if good[i]==255]

# 凹尖角簇（按连通域）
def clusters_of(pxs):
    pset = set(pxs)
    visited = set(); out = []
    for i in pxs:
        if i in visited: continue
        stack=[i]; visited.add(i); pts=[]
        while stack:
            j=stack.pop(); pts.append(j)
            x,y=j%CW,j//CW
            for dx in (-1,0,1):
                for dy in (-1,0,1):
                    nx,ny=x+dx,y+dy
                    if 0<=nx<CW and 0<=ny<CH:
                        ni=ny*CW+nx
                        if ni in pset and ni not in visited:
                            visited.add(ni); stack.append(ni)
        out.append(pts)
    return sorted(out, key=len, reverse=True)

fc = clusters_of(false_hole)
tc = clusters_of(true_hole)
print(f"凹尖角簇数: {len(fc)}, 大小: {[len(c) for c in fc]}")
print(f"真孔洞簇数: {len(tc)}, 大小: {[len(c) for c in tc]}")

# 每个凹尖角簇的位置 + 是否接触线稿描边 / 线稿内部判定
print("\n=== 凹尖角簇详情（位置/大小/是否紧贴线稿描边）===")
for ci, c in enumerate(fc):
    xs=[p%CW for p in c]; ys=[p//CW for p in c]
    touch_line = sum(1 for p in c if Lm[p])
    nbr_line = 0
    for p in c:
        x,y=p%CW,p//CW
        for dx in (-1,0,1):
            for dy in (-1,0,1):
                nx,ny=x+dx,y+dy
                if 0<=nx<CW and 0<=ny<CH and Lm[ny*CW+nx]:
                    nbr_line += 1
    print(f"  簇{ci}: {len(c)}px x[{min(xs)}-{max(xs)}] y[{min(ys)}-{max(ys)}] 描边内={touch_line} 邻描边={nbr_line}")

# 真孔洞大簇（34px 那个）的详情
print("\n=== 真孔洞大簇详情 ===")
for ci, c in enumerate(tc):
    if len(c) < 5: continue
    xs=[p%CW for p in c]; ys=[p//CW for p in c]
    touch_line = sum(1 for p in c if Lm[p])
    print(f"  真孔洞簇{ci}: {len(c)}px x[{min(xs)}-{max(xs)}] y[{min(ys)}-{max(ys)}] 描边内={touch_line}")
