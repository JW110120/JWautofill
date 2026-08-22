# -*- coding: utf-8 -*-
"""深入分析：
1) B 中 fillNbr=0 的 67 个 vs A 的 121 个 —— line 值 / Lm 分布
2) 同层用户实测误填特征（same_result.json 起点 10,9）
3) V7 漏掉的凸尖角（DF>1 的 B）特征
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
user_layer = place('analysis/layer_result.json', 11, 10)
user_same  = place('analysis/same_result.json', 10, 9)
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
DL = dist_to_mask(Lm)
R_all = hole_fill(close_m(Lm, 1))

A = [i for i in range(N) if user_layer[i]==255 and good[i]==0]          # 分层误填（凹尖角）
B = [i for i in range(N) if good[i]==255 and fill[i]<121 and user_layer[i]==255]  # 分层正确填

# 1) B 中 fillNbr=0 vs A 的 line/Lm 分布
B0 = [i for i in B if nbr_cnt(i, M_fill)==0]
B1 = [i for i in B if nbr_cnt(i, M_fill)>=1]
print(f"B fillNbr=0: {len(B0)}, B fillNbr>=1: {len(B1)}")
for name, pts in [('A(误填)', A), ('B0(孔洞fillNbr0)', B0), ('B1(孔洞fillNbr>=1)', B1)]:
    lv = Counter(line[i] for i in pts)
    lm = Counter(Lm[i] for i in pts)
    dl = Counter(DL[i] for i in pts)
    df = Counter(DF[i] for i in pts)
    print(f"\n{name} ({len(pts)}):")
    print(f"  line值桶: 0:{lv[0]} 1-40:{sum(v for k,v in lv.items() if 0<k<=40)} 41-120:{sum(v for k,v in lv.items() if 41<k<=120)} >120:{sum(v for k,v in lv.items() if k>120)}")
    print(f"  Lm(线稿掩码内): {lm.get(1,0)}/{len(pts)}")
    print(f"  DL: {dict(sorted(dl.items()))}")
    print(f"  DF: {dict(sorted(df.items()))}")

# 规则：R内 nH==9 fill=0 → 提升条件（排除实心线稿描边内）
print("\n===== R 内 fill=0 nH==9 像素：line<=16 (半透明线稿) vs line>16 =====")
M = [1 if (M_fill[i] or Lm[i]) else 0 for i in range(N)]
for _ in range(3):
    new = M[:]; ch=False
    for i in range(N):
        if M[i]: continue
        if nbr_cnt(i, M) >= 5: new[i]=1; ch=True
    M = new
    if not ch: break
H = hole_fill(close_m(M, 2))
def nH9_fill0():
    return [i for i in range(N) if R_all[i] and fill[i]==0 and nbr_cnt(i,H)==9]
cand = nH9_fill0()
print(f"候选总数: {len(cand)}")
cA = [i for i in cand if good[i]==0]
cB = [i for i in cand if good[i]==255]
print(f"  其中误填(good0): {len(cA)}, 该填(good255): {len(cB)}")
for name, pts in [('误填', cA), ('该填', cB)]:
    lv = Counter(line[i] for i in pts)
    lm = Counter(Lm[i] for i in pts)
    print(f"  {name}: line>16(Lm=1): {lm.get(1,0)}/{len(pts)}, line<=16: {lm.get(0,0)}/{len(pts)}")

# 2) 同层误填（用户实测 same_result）特征
print("\n===== 同层误填分析 =====")
same_over = [i for i in range(N) if user_same[i]==255 and good[i]==0]
same_fill = [i for i in range(N) if user_same[i]==255 and good[i]==255]
print(f"同层误填: {len(same_over)}, 同层正确填: {len(same_fill)}")
for name, pts in [('同层误填', same_over), ('同层正确', same_fill)]:
    df = Counter(DF[i] for i in pts)
    fn = Counter(nbr_cnt(i, M_fill) for i in pts)
    ln = Counter(nbr_cnt(i, Lm) for i in pts)
    dl = Counter(DL[i] for i in pts)
    lv = Counter(fill[i] for i in pts)
    print(f"\n{name} ({len(pts)}):")
    print(f"  DF: {dict(sorted(df.items()))}")
    print(f"  fillNbr: {dict(sorted(fn.items()))}")
    print(f"  lineNbr: {dict(sorted(ln.items()))}")
    print(f"  DL: {dict(sorted(dl.items()))}")
    print(f"  fill值: 0:{lv[0]} 1-40:{sum(v for k,v in lv.items() if 0<k<=40)} 41-120:{sum(v for k,v in lv.items() if 41<k<=120)} >120:{sum(v for k,v in lv.items() if k>120)}")
