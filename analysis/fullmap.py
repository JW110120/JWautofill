# -*- coding: utf-8 -*-
"""打印 A（误填）与 B0_far（远孔洞）完整位置图，寻找空间结构差异"""
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

line  = place('analysis/line.json', 10, 9)
fill  = place('analysis/fill_with_holes.json', 13, 11)
good  = place('analysis/fill_filled.json', 11, 9)
user_layer = place('analysis/layer_result.json', 11, 10)
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
def nbr_cnt(i, mask):
    x,y=i%CW,i//CW; cnt=0
    for dx in (-1,0,1):
        for dy in (-1,0,1):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH and mask[ny*CW+nx]: cnt+=1
    return cnt

M_fill = [1 if fill[i]>16 else 0 for i in range(N)]
Lm = [1 if line[i]>16 else 0 for i in range(N)]
DF = dist_to_mask(M_fill)
R_all = hole_fill(close_m(Lm, 1))
M = [1 if (M_fill[i] or Lm[i]) else 0 for i in range(N)]
for _ in range(3):
    new = M[:]; ch=False
    for i in range(N):
        if M[i]: continue
        if nbr_cnt(i, M) >= 5: new[i]=1; ch=True
    M = new
    if not ch: break
H = hole_fill(close_m(M, 2))
H_fill = hole_fill(close_m(M_fill, 2))

A = [i for i in range(N) if user_layer[i]==255 and good[i]==0]
B0_far = [i for i in range(N) if good[i]==255 and fill[i]<121 and user_layer[i]==255 and not H_fill[i] and nbr_cnt(i,M_fill)==0]
sa = set(A); sb = set(B0_far)

# 全图打印：X=A(误填) o=B0_far(远孔洞) L=线稿 .=填充 空格=背景
print("全图（每 2 行采样）: X=误填 o=远孔洞 L=线稿 .=填充")
for y in range(0, CH, 1):
    row = ''
    for x in range(0, CW):
        i = y*CW+x
        if i in sa: row += 'X'
        elif i in sb: row += 'o'
        elif Lm[i]: row += 'L'
        elif M_fill[i]: row += '.'
        else: row += ' '
    print(f"{y:3d}|{row}")
