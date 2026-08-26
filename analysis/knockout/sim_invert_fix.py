# -*- coding: utf-8 -*-
"""
反色法扣黑验证：Z(黑底) --Invert--> Z'(=X'白底合成) --扣白流程--> --Invert--> 结果
对比：用户原始扣黑（选亮部反选删暗部，N份合并） vs 反色法（动态N）
验证"偏暗"根因与纠正效果。
"""

def luma601(rgb):
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255.0

# X 三个区域（来自用户案例）
X_px = {
    'red':   [241.0, 52.0, 52.0, 128.0],
    'green': [76.0, 221.0, 56.0, 179.0],
    'cross': [105.0, 191.0, 55.0, 217.0],
}

def over(fg, bg):
    a_f = fg[3] / 255.0
    a_b = bg[3] / 255.0
    a_o = a_f + a_b * (1 - a_f)
    rgb = (fg[0] * a_f + bg[0] * a_b * (1 - a_f)) / a_o
    return [rgb, rgb, rgb, a_o * 255.0]

def comp_over(fg, bg):
    a_f = fg[3] / 255.0
    a_b = bg[3] / 255.0
    a_o = a_f + a_b * (1 - a_f)
    return [fg[i] * a_f + bg[i] * a_b * (1 - a_f) / a_o for i in range(3)] + [a_o * 255.0]

WHITE = [255.0, 255.0, 255.0, 255.0]
BLACK = [0.0, 0.0, 0.0, 255.0]

def merge_n(rgb, a, n):
    """normal 合并 n 份相同 RGBA。"""
    a_t = 1 - (1 - a) ** n
    return rgb, a_t

def show(k, name, x, z, y):
    print(f"\n===== {name} 区域 =====")
    print(f"  X = ({x[0]:.0f},{x[1]:.0f},{x[2]:.0f},a{x[3]:.0f})")
    print(f"  Y(白底) = ({y[0]:.0f},{y[1]:.0f},{y[2]:.0f},a{y[3]:.0f})  Z(黑底) = ({z[0]:.0f},{z[1]:.0f},{z[2]:.0f},a{z[3]:.0f})")
    a = x[3] / 255.0

    # ---- 扣白（用户方案）----
    sel_y = luma601(y)
    a_p = 1 - sel_y  # Clear 后单份 alpha
    for n in [7, 16]:
        rgb_m, a_m = merge_n(y[:3], a_p, n)
        # 白底视觉
        vis = [rgb_m[i] * a_m + 255 * (1 - a_m) for i in range(3)]
        xvis = [x[i] * a + 255 * (1 - a) for i in range(3)]
        err = max(abs(vis[i] - xvis[i]) for i in range(3))
        print(f"  扣白 N={n:2d}: alpha_merge={a_m:.4f} 白底视觉差 max={err:.2f}/255")

    # ---- 扣黑：用户原始方案（不反色，N 份）----
    sel_z = luma601(z)
    a_q = sel_z  # 保留亮部 alpha = luma(Z)
    print(f"  [用户扣黑] sel=luma(Z)={sel_z:.4f} 单份alpha={a_q:.4f}")
    for n in [7, 23]:
        rgb_m, a_m = merge_n(z[:3], a_q, n)
        vis = [rgb_m[i] * a_m for i in range(3)]  # 黑底视觉
        xvis = [x[i] * a for i in range(3)]
        err = max(abs(vis[i] - xvis[i]) for i in range(3))
        print(f"  扣黑(原方案) N={n:2d}: alpha_merge={a_m:.4f} 黑底视觉差 max={err:.2f}/255")

    # ---- 扣黑：反色法（Invert -> 扣白 -> Invert），N 动态 ----
    zp = [255 - v for v in z[:3]]  # Z' = invert(Z)，alpha 保持
    sel_zp = luma601(zp)
    a_pp = 1 - sel_zp  # P' 单份 alpha（= luma(Z)，数学等价）
    # 动态 N：目标合并后 alpha >= 0.995
    import math
    n_dyn = max(3, min(40, math.ceil(math.log(0.005) / math.log(1 - a_pp))))
    rgb_m, a_m = merge_n(zp[:3], a_pp, n_dyn)
    rgb_back = [255 - v for v in rgb_m]  # invert 回来
    vis = [rgb_back[i] * a_m for i in range(3)]
    xvis = [x[i] * a for i in range(3)]
    err = max(abs(vis[i] - xvis[i]) for i in range(3))
    print(f"  扣黑(反色法) N={n_dyn:2d}(动态): alpha_merge={a_m:.4f} 黑底视觉差 max={err:.2f}/255")

for k in X_px:
    x = X_px[k]
    y = comp_over(x, WHITE)
    z = comp_over(x, BLACK)
    show(k, k, x, z, y)
