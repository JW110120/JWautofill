# -*- coding: utf-8 -*-
"""v8 续8：线稿腐蚀掩码区分内侧/外侧"""
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
Lm_er1 = erode(Lm, 1)   # 剥 1 圈
Lm_er2 = erode(Lm, 2)   # 剥 2 圈
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

def ev(name, rule):
    t = sum(1 for i in true_hole if rule(i))
    f = sum(1 for i in false_hole if rule(i))
    print(f"  {name:46s}: 真 {t}/{len(true_hole)} ({t*100.0/len(true_hole):.1f}%), 凹 {f}/{len(false_hole)} ({f*100.0/len(false_hole):.1f}%)")

print("=== 腐蚀掩码特征 ===")
ev('DF<=1 | Lm_er1', lambda i: DF[i]<=1 or Lm_er1[i]==1)
ev('DF<=1 | Lm_er2', lambda i: DF[i]<=1 or Lm_er2[i]==1)
ev('DF<=2 | Lm_er1', lambda i: DF[i]<=2 or Lm_er1[i]==1)
ev('DF<=3 | Lm_er1', lambda i: DF[i]<=3 or Lm_er1[i]==1)

# 具体看 Lm_er1 内像素分布
print(f"\nLm_er1 覆盖: {sum(Lm_er1)}, Lm_er2 覆盖: {sum(Lm_er2)}")
print(f"真孔洞在 Lm_er1: {sum(1 for i in true_hole if Lm_er1[i])}/{len(true_hole)}")
print(f"凹尖角在 Lm_er1: {sum(1 for i in false_hole if Lm_er1[i])}/{len(false_hole)}")
print(f"真孔洞在 Lm_er2: {sum(1 for i in true_hole if Lm_er2[i])}/{len(true_hole)}")
print(f"凹尖角在 Lm_er2: {sum(1 for i in false_hole if Lm_er2[i])}/{len(false_hole)}")
