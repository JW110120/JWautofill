# -*- coding: utf-8 -*-
"""测 DT（线稿掩码内深度=到线稿外背景距离）能否区分 A（线稿描边误填）与 B0（线稿内部孔洞）"""
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
def dist_bg(mask):
    D=[10**9]*N; dq=deque()
    for i in range(N):
        if not mask[i]: D[i]=0; dq.append(i)
    while dq:
        i=dq.popleft(); d=D[i]
        x=i%CW; y=i//CW
        for dx,dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
            nx,ny=x+dx,y+dy
            if 0<=nx<CW and 0<=ny<CH:
                ni=ny*CW+nx
                if D[ni]>d+1: D[ni]=d+1; dq.append(ni)
    return D
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
DL = dist_to_mask(Lm)
DT = dist_bg(Lm)   # 线稿掩码内深度（线稿内像素=到线稿外背景距离）
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

# A = 误填；B0 = H_fill 外、fill<121、good255 的该填像素（V8 需要补的部分）
A = [i for i in range(N) if user_layer[i]==255 and good[i]==0]
B0 = [i for i in range(N) if good[i]==255 and fill[i]<121 and user_layer[i]==255 and not H_fill[i]]
# B0 细分：fillNbr>=1（紧贴填充，可用 fillNbr 规则） vs fillNbr=0（纯孔洞）
B0_near = [i for i in B0 if nbr_cnt(i, M_fill) >= 1]
B0_far  = [i for i in B0 if nbr_cnt(i, M_fill) == 0]
print(f"A(误填): {len(A)} | B0(需补): {len(B0)} = 紧贴{len(B0_near)} + 远孔{len(B0_far)}")

for name, pts in [('A', A), ('B0_far', B0_far), ('B0_near', B0_near)]:
    print(f"\n{name} ({len(pts)}):")
    dt = Counter(DT[i] for i in pts)
    print(f"  DT(线稿内深度): {dict(sorted(dt.items()))}")
    ln = Counter(nbr_cnt(i, Lm) for i in pts)
    print(f"  lineNbr: {dict(sorted(ln.items()))}")
    lv = Counter(line[i] for i in pts)
    print(f"  line值: 0:{lv[0]} 1-40:{sum(v for k,v in lv.items() if 0<k<=40)} 41-120:{sum(v for k,v in lv.items() if 41<k<=120)} >120:{sum(v for k,v in lv.items() if k>120)}")

# 规则测试：A vs B0_far
print("\n===== A vs B0_far 规则 =====")
for name, rule in [
    ('DT>=2', lambda i: DT[i]>=2),
    ('DT>=3', lambda i: DT[i]>=3),
    ('lineNbr>=7', lambda i: nbr_cnt(i,Lm)>=7),
    ('lineNbr>=8', lambda i: nbr_cnt(i,Lm)>=8),
    ('lineNbr>=6', lambda i: nbr_cnt(i,Lm)>=6),
    ('DT>=2 且 lineNbr>=6', lambda i: DT[i]>=2 and nbr_cnt(i,Lm)>=6),
    ('line>120', lambda i: line[i]>120),
    ('DT>=2 且 line>120', lambda i: DT[i]>=2 and line[i]>120),
    ('lineNbr>=7 且 line>120', lambda i: nbr_cnt(i,Lm)>=7 and line[i]>120),
    ('DT>=3 或 lineNbr>=8', lambda i: DT[i]>=3 or nbr_cnt(i,Lm)>=8),
    ('lineNbr>=7 或 line>120', lambda i: nbr_cnt(i,Lm)>=7 or line[i]>120),
]:
    a_hit = sum(1 for i in A if rule(i))    # 误放行（坏）
    b_hit = sum(1 for i in B0_far if rule(i)) # 保留（好）
    print(f"  {name:28s}: A误放行 {a_hit}/{len(A)} ({a_hit*100.0/len(A):.0f}%) | B0_far保留 {b_hit}/{len(B0_far)} ({b_hit*100.0/len(B0_far):.0f}%)")
