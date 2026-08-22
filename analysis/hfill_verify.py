# -*- coding: utf-8 -*-
"""验证：分层/同层的提升区 = 填充掩码闭包 H_fill（不合并线稿），
A（线稿描边误填）应在 H_fill 外，B（该填的孔洞/缝隙/凸尖角）应在 H_fill 内。
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

# H_fill = holeFill(close(M_fill, 2))
H_fill = hole_fill(close_m(M_fill, 2))
D_fill = dist_bg(H_fill)
print(f"H_fill(填充闭包) 像素数: {sum(H_fill)}")

# ===== 分层 =====
A = [i for i in range(N) if user_layer[i]==255 and good[i]==0]
B = [i for i in range(N) if good[i]==255 and fill[i]<121 and user_layer[i]==255]
Ain = sum(1 for i in A if H_fill[i])
Bin = sum(1 for i in B if H_fill[i])
print(f"\n分层: A(误填) {len(A)}, 在 H_fill 内 {Ain} ({Ain*100.0/len(A):.1f}%)")
print(f"分层: B(该填) {len(B)}, 在 H_fill 内 {Bin} ({Bin*100.0/len(B):.1f}%)")

# B 中不在 H_fill 内的（需要额外规则）—— 特征
B_out = [i for i in B if not H_fill[i]]
print(f"B 在 H_fill 外: {len(B_out)}")
for name, fn in [('DF', lambda i: DF[i]), ('DL', lambda i: dist_to_mask(Lm)[i]),
                 ('fillNbr', lambda i: nbr_cnt(i, M_fill)), ('lineNbr', lambda i: nbr_cnt(i, Lm))]:
    print(f"  {name}: {dict(sorted(Counter(fn(i) for i in B_out).items()))}")
# B_out 位置
if B_out:
    xs=[i%CW for i in B_out]; ys=[i//CW for i in B_out]
    print(f"  x[{min(xs)}-{max(xs)}] y[{min(ys)}-{max(ys)}]")

# ===== 同层 =====
same_A = [i for i in range(N) if user_same[i]==255 and good[i]==0]
same_B = [i for i in range(N) if user_same[i]==255 and good[i]==255]
sAin = sum(1 for i in same_A if H_fill[i])
sBin = sum(1 for i in same_B if H_fill[i])
print(f"\n同层: A(误填) {len(same_A)}, 在 H_fill 内 {sAin} ({sAin*100.0/len(same_A):.1f}%)")
print(f"同层: B(正确填) {len(same_B)}, 在 H_fill 内 {sBin} ({sBin*100.0/len(same_B):.1f}%)")

# 模拟完整提升：H_fill 内 D>=2 提升 + D==1 尖角（分层再叠加 DF<=1 尖角）
def simulate(use_line_region):
    pred = fill[:]
    for i in range(N):
        a = fill[i]
        if a >= 255: continue
        if not H_fill[i]:
            # 分层：紧贴填充的尖角（DF<=1 且 R 内 nH9？不，这里只测 H_fill 内）
            continue
        d = D_fill[i]
        if d >= 2: pred[i] = 255
        elif d == 1 and (nbr_cnt(i, H_fill) >= 7 or a >= 80): pred[i] = 255
    return pred

pred = simulate(False)
# 指标
g255 = [i for i in range(N) if good[i]==255]
b0 = [i for i in range(N) if good[i]==0]
gacc = sum(1 for i in g255 if pred[i]==255) / len(g255)
bacc = sum(1 for i in b0 if pred[i]==0) / len(b0)
over = sum(1 for i in range(N) if pred[i]==255 and good[i]==0)
under = sum(1 for i in range(N) if good[i]==255 and pred[i]!=255)
print(f"\n纯 H_fill 方案(全图): 补全区={gacc*100:.2f}% 背景={bacc*100:.2f}% 误填={over} 漏填={under}")

# 分层版：H_fill + (R 内 nH9 且 DF<=1) 补充
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
def pred2():
    p = fill[:]
    for i in range(N):
        a = fill[i]
        if a >= 255: continue
        nH = nbr_cnt(i, H)
        cand = a > 16 or DF[i] <= 1 or (R_all[i] and nH == 9)
        if not cand: continue
        # 只填：H_fill 内（填充闭包）或 R 内紧贴填充（DF<=1）或 R 内 nH9 且 DF<=1
        if H_fill[i]:
            d = D_fill[i]
            if d >= 2: p[i] = 255
            elif d == 1 and (nH >= 7 or a >= 80): p[i] = 255
        elif R_all[i] and DF[i] <= 1:
            p[i] = 255
    return p
p2 = pred2()
gacc2 = sum(1 for i in g255 if p2[i]==255) / len(g255)
bacc2 = sum(1 for i in b0 if p2[i]==0) / len(b0)
over2 = sum(1 for i in range(N) if p2[i]==255 and good[i]==0)
under2 = sum(1 for i in range(N) if good[i]==255 and p2[i]!=255)
print(f"分层 H_fill+DF<=1 补充: 补全区={gacc2*100:.2f}% 背景={bacc2*100:.2f}% 误填={over2} 漏填={under2}")
