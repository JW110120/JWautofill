# -*- coding: utf-8 -*-
"""v8 关键验证：R 内 fill=0 像素，用 nbr(M_fill)==9（被纯填充完全包围）区分真孔洞 vs 凹尖角"""
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
def nbr(i, mask):
    x,y=i%CW,i//CW; cnt=0
    for dx in (-1,0,1):
        for dy in (-1,0,1):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH:
                if mask[ny*CW+nx]: cnt+=1
    return cnt

M_fill = [1 if fill[i]>16 else 0 for i in range(N)]
Lm = [1 if line[i]>16 else 0 for i in range(N)]
DF = dist_to_mask(M_fill)   # 距填充距离
DL = dist_to_mask(Lm)       # 距线稿描边距离
R_all = hole_fill(close_m(Lm, 1))

# R 内 fill=0 的像素分类
rz = [i for i in range(N) if R_all[i] and fill[i]==0]
true_hole = [i for i in rz if good[i]==255]   # 真孔洞（凸尖角）该填
false_hole = [i for i in rz if good[i]==0]    # 凹尖角/边缘带 不该填
print(f"R 内 fill=0: 真孔洞(该填)={len(true_hole)}, 凹尖角/边缘(不该填)={len(false_hole)}")

# 特征1: nbr(M_fill) 纯填充邻域
print("\n=== 特征 nbr(M_fill)（纯填充掩码 8 邻域实体数）===")
nb_t = Counter(nbr(i, M_fill) for i in true_hole)
nb_f = Counter(nbr(i, M_fill) for i in false_hole)
print(f"真孔洞 nbr(M_fill) 分布: {dict(sorted(nb_t.items()))}")
print(f"凹尖角 nbr(M_fill) 分布: {dict(sorted(nb_f.items()))}")
for th in (8, 9):
    t_hit = sum(1 for i in true_hole if nbr(i,M_fill)>=th)
    f_hit = sum(1 for i in false_hole if nbr(i,M_fill)>=th)
    print(f"规则 nbr(M_fill)>={th}: 真孔洞保留 {t_hit}/{len(true_hole)} ({t_hit*100.0/len(true_hole):.1f}%), 凹尖角误留 {f_hit}/{len(false_hole)} ({f_hit*100.0/len(false_hole):.1f}%)")

# 特征2: DF 分布（v7 的规则）
print("\n=== 特征 DF（距填充距离）===")
df_t = Counter(DF[i] for i in true_hole)
df_f = Counter(DF[i] for i in false_hole)
print(f"真孔洞 DF 分布: {dict(sorted(df_t.items()))}")
print(f"凹尖角 DF 分布: {dict(sorted(df_f.items()))}")
for th in (1, 2):
    t_hit = sum(1 for i in true_hole if DF[i]<=th)
    f_hit = sum(1 for i in false_hole if DF[i]<=th)
    print(f"规则 DF<={th}: 真孔洞保留 {t_hit}/{len(true_hole)} ({t_hit*100.0/len(true_hole):.1f}%), 凹尖角误留 {f_hit}/{len(false_hole)} ({f_hit*100.0/len(false_hole):.1f}%)")

# 特征3: 组合 nbr(M_fill)>=8 或 DF<=1
print("\n=== 组合规则 ===")
t_hit = sum(1 for i in true_hole if nbr(i,M_fill)>=8 or DF[i]<=1)
f_hit = sum(1 for i in false_hole if nbr(i,M_fill)>=8 or DF[i]<=1)
print(f"规则 nbr>=8 或 DF<=1: 真孔洞保留 {t_hit}/{len(true_hole)} ({t_hit*100.0/len(true_hole):.1f}%), 凹尖角误留 {f_hit}/{len(false_hole)} ({f_hit*100.0/len(false_hole):.1f}%)")
t_hit = sum(1 for i in true_hole if nbr(i,M_fill)>=9 or DF[i]<=1)
f_hit = sum(1 for i in false_hole if nbr(i,M_fill)>=9 or DF[i]<=1)
print(f"规则 nbr>=9 或 DF<=1: 真孔洞保留 {t_hit}/{len(true_hole)} ({t_hit*100.0/len(true_hole):.1f}%), 凹尖角误留 {f_hit}/{len(false_hole)} ({f_hit*100.0/len(false_hole):.1f}%)")
