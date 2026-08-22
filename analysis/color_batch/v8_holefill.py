# -*- coding: utf-8 -*-
"""v8 续2：holeFill(M_fill) 区分真孔洞 vs 凹尖角"""
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
H_fill = hole_fill(M_fill)   # 纯填充掩码的内部洞（关键！）

rz = [i for i in range(N) if R_all[i] and fill[i]==0]
true_hole = [i for i in rz if good[i]==255]
false_hole = [i for i in rz if good[i]==0]

print(f"R 内 fill=0: 真孔洞={len(true_hole)}, 凹尖角={len(false_hole)}")
print(f"holeFill(M_fill) 覆盖像素: {sum(H_fill)}")

# 规则1: R 内 fill=0 且 H_fill[i]==1（被纯填充完全包围）→ 提升
t = sum(1 for i in true_hole if H_fill[i]==1)
f = sum(1 for i in false_hole if H_fill[i]==1)
print(f"\n规则[holeFill(M_fill)]: 真孔洞保留 {t}/{len(true_hole)} ({t*100.0/len(true_hole):.1f}%), 凹尖角误留 {f}/{len(false_hole)} ({f*100.0/len(false_hole):.1f}%)")

# 规则2: H_fill 或 DF<=1
t = sum(1 for i in true_hole if H_fill[i]==1 or DF[i]<=1)
f = sum(1 for i in false_hole if H_fill[i]==1 or DF[i]<=1)
print(f"规则[H_fill 或 DF<=1]: 真孔洞保留 {t}/{len(true_hole)} ({t*100.0/len(true_hole):.1f}%), 凹尖角误留 {f}/{len(false_hole)} ({f*100.0/len(false_hole):.1f}%)")

# 漏掉的：H_fill=0 且 DF>1 的真孔洞
miss = [i for i in true_hole if H_fill[i]==0 and DF[i]>1]
print(f"\nH_fill=0 且 DF>1 的真孔洞: {len(miss)}")
if miss:
    from collections import defaultdict
    cl = {}
    miss_set = set(miss)
    visited = set(); clusters = []
    for i in miss:
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
                        if ni in miss_set and ni not in visited:
                            visited.add(ni); stack.append(ni)
        clusters.append((sz, i))
    clusters.sort(reverse=True)
    print(f"  漏填簇: {[(sz, f'({i%CW},{i//CW})') for sz, i in clusters[:10]]}")

# 误留：H_fill=1 的凹尖角位置
f_over = [i for i in false_hole if H_fill[i]==1]
print(f"\nH_fill=1 的凹尖角(误留): {len(f_over)}")
if f_over:
    xs=[i%CW for i in f_over]; ys=[i//CW for i in f_over]
    print(f"  x[{min(xs)}-{max(xs)}] y[{min(ys)}-{max(ys)}]")
