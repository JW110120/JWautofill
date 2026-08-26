# -*- coding: utf-8 -*-
"""
整图模拟：64x64 画布，红圆+绿圆（半透明，绿在后），背景透明。
Y = X over 白底；Z = X over 黑底。
模拟 PS 流程：
  扣白：载入亮度选区(sel=luma) -> Clear(alpha*=1-sel) -> 复制N份合并
  扣黑：Invert -> 同扣白 -> Invert，N 动态计算
输出：最终结果放回对应背景 vs 原图放回对应背景 的像素差统计。
并生成 PPM 文件供人工查看。
"""
import math

W = H = 64

def luma(rgb):
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255.0

def over_px(fg, bg):
    """fg/bg: (r,g,b,a) 0-255，返回合成后的 (r,g,b,a)。"""
    a_f = fg[3] / 255.0
    a_b = bg[3] / 255.0
    a_o = a_f + a_b * (1 - a_f)
    if a_o <= 0:
        return (0, 0, 0, 0)
    r = (fg[0] * a_f + bg[0] * a_b * (1 - a_f)) / a_o
    g = (fg[1] * a_f + bg[1] * a_b * (1 - a_f)) / a_o
    b = (fg[2] * a_f + bg[2] * a_b * (1 - a_f)) / a_o
    return (r, g, b, a_o * 255)

def build_X():
    """X: (r,g,b,a) per pixel, 透明背景。"""
    px = {}
    for y in range(H):
        for x in range(W):
            # 红圆圆心(20,32) r=14；绿圆圆心(44,32) r=14
            d_red = math.hypot(x - 20, y - 32)
            d_grn = math.hypot(x - 44, y - 32)
            red = (241, 52, 52, 128)
            grn = (76, 221, 56, 179)
            val = (0, 0, 0, 0)
            if d_red <= 14:
                val = over_px(red, val) if d_grn > 14 else over_px(grn, over_px(red, val))
            if d_grn <= 14:
                val = over_px(grn, val)
            px[(x, y)] = val
    return px

def compose(X, bg):
    out = {}
    for k, v in X.items():
        out[k] = over_px(v, bg)
    return out

def simulate_knockout(Y, mode):
    """模拟 PS 流程。Y: 合并图。mode: 'white'/'black'。
    返回 (结果图层RGBA, 使用的N)。"""
    # 反色（扣黑）
    work = {}
    if mode == 'black':
        for k, v in Y.items():
            work[k] = (255 - v[0], 255 - v[1], 255 - v[2], v[3])
    else:
        work = dict(Y)
    # 亮度选区灰度 + Clear：alpha *= (1-luma)
    cleared = {}
    alphas = []
    for k, v in work.items():
        sel = luma(v[:3])
        a = v[3] / 255.0 * (1 - sel)
        cleared[k] = (v[0], v[1], v[2], a * 255)
        if 0 < a < 1:
            alphas.append(a)
    # 动态 N（P5 分位）
    if not alphas:
        n = 7 if mode == 'white' else 3
    else:
        alphas.sort()
        a_min = alphas[min(len(alphas) - 1, int(len(alphas) * 0.05))]
        if a_min <= 0.02:
            n = 40
        else:
            n = max(7 if mode == 'white' else 3, min(40, math.ceil(math.log(0.005) / math.log(1 - a_min))))
    # 复制 n 份合并：alpha = 1-(1-a)^n，RGB 不变
    merged = {}
    for k, v in cleared.items():
        a = v[3] / 255.0
        a_m = 1 - (1 - a) ** n
        merged[k] = (v[0], v[1], v[2], a_m * 255)
    # 反色回来（扣黑）
    if mode == 'black':
        for k, v in merged.items():
            merged[k] = (255 - v[0], 255 - v[1], 255 - v[2], v[3])
    return merged, n

def report(name, result, X, bg):
    """把 result 与 X 都放回 bg 上比较视觉差。"""
    maxd = 0.0
    total = 0.0
    cnt = 0
    for k in X:
        r1 = over_px(result[k], bg)
        r2 = over_px(X[k], bg)
        d = max(abs(r1[i] - r2[i]) for i in range(3))
        maxd = max(maxd, d)
        total += d
        cnt += 1
    print(f"  {name}: 放回{'白' if bg[3]==255 and bg[0]==255 else '黑'}底 视觉差 mean={total/cnt:.2f}/255 max={maxd:.2f}/255")
    return total / cnt, maxd

def save_ppm(path, px, w, h):
    with open(path, 'w') as f:
        f.write(f"P3\n{w} {h}\n255\n")
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[(x, y)]
                # 透明棋盘模拟：alpha 混合到灰
                a_n = a / 255.0
                r = r * a_n + 200 * (1 - a_n)
                g = g * a_n + 200 * (1 - a_n)
                b = b * a_n + 200 * (1 - a_n)
                f.write(f"{int(round(r))} {int(round(g))} {int(round(b))} ")
            f.write("\n")

X = build_X()
WHITE = (255, 255, 255, 255)
BLACK = (0, 0, 0, 255)
Y = compose(X, WHITE)
Z = compose(X, BLACK)

print("=== 扣白（用户方案，N 动态 min7）===")
res_w, n_w = simulate_knockout(Y, 'white')
print(f"  动态 N = {n_w}")
report("扣白结果", res_w, X, WHITE)
# 结果 vs X 的图层级差异（像素 RGBA）
d_rgb = sum(max(abs(res_w[k][i] - X[k][i]) for i in range(3)) for k in X) / (W * H)
d_a = sum(abs(res_w[k][3] - X[k][3]) for k in X) / (W * H)
print(f"  图层级: 平均RGB差={d_rgb:.1f} 平均alpha差={d_a:.1f}/255")

print("\n=== 扣黑（反色法纠正，N 动态 min3）===")
res_b, n_b = simulate_knockout(Z, 'black')
print(f"  动态 N = {n_b}")
report("扣黑结果", res_b, X, BLACK)
d_rgb = sum(max(abs(res_b[k][i] - X[k][i]) for i in range(3)) for k in X) / (W * H)
d_a = sum(abs(res_b[k][3] - X[k][3]) for k in X) / (W * H)
print(f"  图层级: 平均RGB差={d_rgb:.1f} 平均alpha差={d_a:.1f}/255")

print("\n=== 对比：用户原扣黑（不反色、固定7份）===")
def sim_orig_black(Z, n=7):
    out = {}
    for k, v in Z.items():
        sel = luma(v[:3])
        a = sel  # 保留亮部 alpha = luma(Z)
        a_m = 1 - (1 - a) ** n
        out[k] = (v[0], v[1], v[2], a_m * 255)
    return out
res_orig = sim_orig_black(Z)
report("用户原方案N=7", res_orig, X, BLACK)

# 保存 PPM 供人工查看
save_ppm('analysis/knockout/X.ppm', X, W, H)
save_ppm('analysis/knockout/Y.ppm', Y, W, H)
save_ppm('analysis/knockout/white_result.ppm', res_w, W, H)
save_ppm('analysis/knockout/Z.ppm', Z, W, H)
save_ppm('analysis/knockout/black_result.ppm', res_b, W, H)
save_ppm('analysis/knockout/black_orig7.ppm', res_orig, W, H)
print("\nPPM 文件已保存到 analysis/knockout/")
