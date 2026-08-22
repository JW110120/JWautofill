# -*- coding: utf-8 -*-
"""凹尖角（V6 误填）vs 凸尖角/孔洞（该填）的可分特征分析
坐标对齐：线稿(10,9)、含孔隙(13,11)、补全(11,9)、用户实测分层结果(11,10)
"""
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
user_res = place('analysis/layer_result.json', 11, 10)  # 用户实测 V6 分层输出
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
DF = dist_to_mask(M_fill)   # 距填充掩码距离（掩码内=0）
DL = dist_to_mask(Lm)       # 距线稿描边距离（描边内=0）
R_all = hole_fill(close_m(Lm, 1))

def nbr_cnt(i, mask):
    x,y=i%CW,i//CW; cnt=0
    for dx in (-1,0,1):
        for dy in (-1,0,1):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH and mask[ny*CW+nx]: cnt+=1
    return cnt

# A = 用户实测 V6 分层误填：结果255 但 目标0（凹尖角）
A = [i for i in range(N) if user_res[i]==255 and good[i]==0]
# B = 该填的真孔洞/凸尖角：目标255 且 含孔隙 alpha<121（V6 正确填的）
B = [i for i in range(N) if good[i]==255 and fill[i]<121 and user_res[i]==255]
print(f"A(凹尖角误填): {len(A)}  B(凸尖角/孔洞): {len(B)}")

def report(pts, name):
    print(f"\n===== {name} ({len(pts)}) =====")
    for feat, fn, label in [
        ('DF', lambda i: DF[i], '距填充距离'),
        ('DL', lambda i: DL[i], '距线稿距离'),
        ('fillNbr', lambda i: nbr_cnt(i, M_fill), '8邻域填充数'),
        ('lineNbr', lambda i: nbr_cnt(i, Lm), '8邻域线稿数'),
        ('R内', lambda i: 1 if R_all[i] else 0, '线稿内部R'),
    ]:
        c = Counter(fn(i) for i in pts)
        print(f"  {label}({feat}): {dict(sorted(c.items()))}")

report(A, 'A 凹尖角(误填)')
report(B, 'B 凸尖角/孔洞(该填)')

# 组合区分度
print("\n===== 组合特征区分度 =====")
rules = [
    ('DF<=1', lambda i: DF[i]<=1),
    ('DL>=2', lambda i: DL[i]>=2),
    ('DL>=1', lambda i: DL[i]>=1),
    ('fillNbr>=2', lambda i: nbr_cnt(i,M_fill)>=2),
    ('fillNbr>=3', lambda i: nbr_cnt(i,M_fill)>=3),
    ('lineNbr<=3', lambda i: nbr_cnt(i,Lm)<=3),
    ('lineNbr<=2', lambda i: nbr_cnt(i,Lm)<=2),
    ('DL>=1 且 fillNbr>=2', lambda i: DL[i]>=1 and nbr_cnt(i,M_fill)>=2),
    ('DL>=1 且 fillNbr>=3', lambda i: DL[i]>=1 and nbr_cnt(i,M_fill)>=3),
    ('DL>=2 且 fillNbr>=1', lambda i: DL[i]>=2 and nbr_cnt(i,M_fill)>=1),
    ('DL>=2 或 fillNbr>=3', lambda i: DL[i]>=2 or nbr_cnt(i,M_fill)>=3),
    ('lineNbr<=3 且 fillNbr>=2', lambda i: nbr_cnt(i,Lm)<=3 and nbr_cnt(i,M_fill)>=2),
    ('lineNbr<=2 且 fillNbr>=2', lambda i: nbr_cnt(i,Lm)<=2 and nbr_cnt(i,M_fill)>=2),
    ('DF<=2', lambda i: DF[i]<=2),
    ('DF<=2 且 fillNbr>=2', lambda i: DF[i]<=2 and nbr_cnt(i,M_fill)>=2),
    ('DF<=1 或 DL>=2', lambda i: DF[i]<=1 or DL[i]>=2),
    ('DF<=1 或 (DL>=1 且 fillNbr>=2)', lambda i: DF[i]<=1 or (DL[i]>=1 and nbr_cnt(i,M_fill)>=2)),
    ('DF<=2 或 DL>=2', lambda i: DF[i]<=2 or DL[i]>=2),
]
for name, rule in rules:
    a_hit = sum(1 for i in A if rule(i))   # 凹尖角被误放行（不好）
    b_hit = sum(1 for i in B if rule(i))   # 凸尖角被保留（好）
    print(f"  {name:34s}: A误放行 {a_hit}/{len(A)} ({a_hit*100.0/max(1,len(A)):.0f}%) | B保留 {b_hit}/{len(B)} ({b_hit*100.0/len(B):.0f}%)")

# A/B 像素样例
print("\n===== A 样例（前10）=====")
for i in A[:10]:
    print(f"  ({i%CW},{i//CW}) fill={fill[i]} good={good[i]} line={line[i]} DF={DF[i]} DL={DL[i]} fillNbr={nbr_cnt(i,M_fill)} lineNbr={nbr_cnt(i,Lm)} R={R_all[i]}")
print("\n===== B 样例（前10）=====")
for i in B[:10]:
    print(f"  ({i%CW},{i//CW}) fill={fill[i]} good={good[i]} line={line[i]} DF={DF[i]} DL={DL[i]} fillNbr={nbr_cnt(i,M_fill)} lineNbr={nbr_cnt(i,Lm)} R={R_all[i]}")
