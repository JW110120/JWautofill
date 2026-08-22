# -*- coding: utf-8 -*-
"""可视化 A（误填凹尖角）与 B0（该填孔洞）的空间形态 + r=2 填充邻域特征"""
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
def nbr_cnt(i, mask, r=1):
    x,y=i%CW,i//CW; cnt=0
    for dy in range(-r, r+1):
        for dx in range(-r, r+1):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH and mask[ny*CW+nx]: cnt+=1
    return cnt

M_fill = [1 if fill[i]>16 else 0 for i in range(N)]
Lm = [1 if line[i]>16 else 0 for i in range(N)]
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

A = [i for i in range(N) if user_layer[i]==255 and good[i]==0 and fill[i]==0 and R_all[i] and nbr_cnt(i,H)==9]
B = [i for i in range(N) if good[i]==255 and fill[i]<121 and user_layer[i]==255]
B0 = [i for i in B if nbr_cnt(i, M_fill)==0]
print(f"A(误填 fill0 R内 nH9): {len(A)}, B0(孔洞 fillNbr=0): {len(B0)}")

# r=2 填充邻域特征
for name, pts in [('A', A), ('B0', B0)]:
    c2 = Counter(nbr_cnt(i, M_fill, 2) for i in pts)
    c3 = Counter(nbr_cnt(i, M_fill, 3) for i in pts)
    df2 = Counter(dist_to_mask(M_fill)[i] for i in pts)
    print(f"{name}: r2填充邻域: {dict(sorted(c2.items()))}")
    print(f"{name}: r3填充邻域: {dict(sorted(c3.items()))}")
    print(f"{name}: DF: {dict(sorted(df2.items()))}")

# 规则测试：r2填充>=2?
for name, rule in [
    ('r2填充>=1', lambda i: nbr_cnt(i,M_fill,2)>=1),
    ('r2填充>=2', lambda i: nbr_cnt(i,M_fill,2)>=2),
    ('r2填充>=3', lambda i: nbr_cnt(i,M_fill,2)>=3),
    ('r3填充>=2', lambda i: nbr_cnt(i,M_fill,3)>=2),
    ('r3填充>=4', lambda i: nbr_cnt(i,M_fill,3)>=4),
    ('DF<=2', lambda i: dist_to_mask(M_fill)[i]<=2),
    ('DF<=3', lambda i: dist_to_mask(M_fill)[i]<=3),
]:
    a_hit = sum(1 for i in A if rule(i))
    b_hit = sum(1 for i in B0 if rule(i))
    print(f"  {name}: A误放行 {a_hit}/{len(A)} ({a_hit*100.0/len(A):.0f}%) | B0保留 {b_hit}/{len(B0)} ({b_hit*100.0/len(B0):.0f}%)")

# 可视化：打印 A 和 B0 的位置图（叠加线稿）
def show_map(pts_a, pts_b, x0, x1, y0, y1, label):
    print(f"\n=== {label} x[{x0}-{x1}] y[{y0}-{y1}] ===")
    sa = set(pts_a); sb = set(pts_b)
    for y in range(y0, y1+1):
        row = ''
        for x in range(x0, x1+1):
            i = y*CW+x
            if i in sa: row += 'X'
            elif i in sb: row += 'o'
            elif Lm[i]: row += 'L'
            elif M_fill[i]: row += '.'
            else: row += ' '
        print(f"{y:3d}|{row}")

# 找到 A/B0 的分布范围
axs = [i%CW for i in A]; ays = [i//CW for i in A]
bxs = [i%CW for i in B0]; bys = [i//CW for i in B0]
print(f"A x[{min(axs)}-{max(axs)}] y[{min(ays)}-{max(ays)}]")
print(f"B0 x[{min(bxs)}-{max(bxs)}] y[{min(bys)}-{max(bys)}]")
# 帽子区域（线稿右上角 y9-40 x80-120）
show_map(A, B0, 80, 122, 8, 42, '帽子区域')
show_map(A, B0, 30, 70, 108, 140, '底部区域')
