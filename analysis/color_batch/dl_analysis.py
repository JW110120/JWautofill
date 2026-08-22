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
DL = dist_to_mask(Lm)
R_all = hole_fill(close_m(Lm, 1))
M = [1 if (M_fill[i] or Lm[i]) else 0 for i in range(N)]
for _ in range(3):
    new = M[:]; ch=False
    for i in range(N):
        if M[i]: continue
        if nbr(i, M) >= 5: new[i]=1; ch=True
    M = new
    if not ch: break
H = hole_fill(close_m(M, 2))
DF = dist_to_mask(M_fill)
D = dist_bg(H)
pred = fill[:]
for i in range(N):
    a = fill[i]
    if a >= 255: continue
    nH = nbr(i, H)
    cand = (a > 16) or (DF[i] <= 1) or (R_all[i] and nH == 9)
    if not cand: continue
    if R_all[i]: pred[i]=255; continue
    if not H[i]: continue
    d = D[i]
    if d >= 2: pred[i]=255
    elif d == 1 and (nH >= 7 or a >= 80): pred[i]=255

over = [i for i in range(N) if pred[i]==255 and good[i]==0 and fill[i]==0 and R_all[i] and nbr(i,H)==9]
tips = [i for i in range(N) if good[i]==255 and fill[i]==0 and R_all[i] and nbr(i,H)==9 and pred[i]==255]
print(f"误填: {len(over)}, 真孔洞: {len(tips)}")
print(f"误填 DL(距线稿) 分布: {dict(sorted(Counter(DL[i] for i in over).items()))}")
print(f"真孔洞 DL 分布: {dict(sorted(Counter(DL[i] for i in tips).items()))}")
# 误填中 在线稿描边内(Lm) vs 不在
print(f"误填 Lm内: {sum(1 for i in over if Lm[i])}/{len(over)}")
print(f"真孔洞 Lm内: {sum(1 for i in tips if Lm[i])}/{len(tips)}")
# 误填 line 值分布
print(f"误填 line 值: {dict(sorted(Counter(line[i] for i in over).items())[:8])}")
print(f"真孔洞 line 值: {dict(sorted(Counter(line[i] for i in tips).items())[:8])}")
# 尝试规则: Lm 外 或 DL>=2
rule1 = [i for i in over if not Lm[i]]
print(f"\n规则[非Lm]: 误填排除 {len(over)-len(rule1)}/{len(over)}, 真孔洞保留 {sum(1 for i in tips if not Lm[i])}/{len(tips)}")
rule2 = [i for i in over if DL[i]>=2]
print(f"规则[DL>=2]: 误填排除 {len(over)-len(rule2)}/{len(over)}, 真孔洞保留 {sum(1 for i in tips if DL[i]>=2)}/{len(tips)}")
