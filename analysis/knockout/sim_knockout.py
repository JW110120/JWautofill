# -*- coding: utf-8 -*-
"""
模拟 PS「亮度选区 + Delete + 复制N份合并」的扣白/扣黑操作，验证数学原理。
案例来自用户：红圆 RGBA(241,52,52,128) 绿圆 RGBA(76,221,56,179)，绿在后，相交=绿over红。
纯 Python，无第三方依赖。
"""

def over(fg, bg):
    """标准 over 合成（预乘），输入/输出 0-255 RGBA。"""
    a_f = fg[3] / 255.0
    a_b = bg[3] / 255.0
    a_o = a_f + a_b * (1 - a_f)
    if a_o <= 0:
        return [0.0, 0.0, 0.0, 0.0]
    rgb = (fg[0] * a_f + bg[0] * a_b * (1 - a_f),
           fg[1] * a_f + bg[1] * a_b * (1 - a_f),
           fg[2] * a_f + bg[2] * a_b * (1 - a_f))
    return [rgb[0] / a_o, rgb[1] / a_o, rgb[2] / a_o, a_o * 255.0]

def luma601(rgb):
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255.0

def luma709(rgb):
    return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255.0

def avg(rgb):
    return (rgb[0] + rgb[1] + rgb[2]) / 3.0 / 255.0

def maxc(rgb):
    return max(rgb[0], rgb[1], rgb[2]) / 255.0

def minc(rgb):
    return min(rgb[0], rgb[1], rgb[2]) / 255.0

SEL_FUNCS = {
    'luma601': luma601,
    'luma709': luma709,
    'avg': avg,
    'max': maxc,
    'min': minc,
}

# X 图层（透明底）的三个区域像素
X_px = {
    'red':   [241.0, 52.0, 52.0, 128.0],
    'green': [76.0, 221.0, 56.0, 179.0],
    'cross': [105.0, 191.0, 55.0, 217.0],  # 绿 over 红
}

WHITE = [255.0, 255.0, 255.0, 255.0]
BLACK = [0.0, 0.0, 0.0, 255.0]

# 1) 生成 Y(白底) / Z(黑底)
Y = {k: over(v, WHITE) for k, v in X_px.items()}
Z = {k: over(v, BLACK) for k, v in X_px.items()}

print("== 白底合并 Y ==")
for k, v in Y.items():
    print(f"  {k}: RGBA=({v[0]:.0f},{v[1]:.0f},{v[2]:.0f},{v[3]:.0f})")
print("== 黑底合并 Z ==")
for k, v in Z.items():
    print(f"  {k}: RGBA=({v[0]:.0f},{v[1]:.0f},{v[2]:.0f},{v[3]:.0f})")

def delete_white(Ypx, sel_func):
    """模拟：Ctrl+点击RGB通道(选区强度=灰度) + Delete => alpha *= (1-sel)，RGB 不变。"""
    sel = sel_func(Ypx)
    a = Ypx[3] / 255.0
    return [Ypx[0], Ypx[1], Ypx[2], a * (1 - sel) * 255.0]

def merge_n(layers, n):
    """normal 模式合并 n 份相同图层（底下透明）。"""
    a = layers[3] / 255.0
    a_t = 1 - (1 - a) ** n
    return [layers[0], layers[1], layers[2], a_t * 255.0]

print("\n===== 扣白模拟：Delete 亮部（alpha*=(1-sel)），找最佳 n 份合并 vs X =====")
for sname, sfunc in SEL_FUNCS.items():
    for key in X_px:
        P = delete_white(Y[key], sfunc)
        best = None
        for n in range(1, 31):
            M = merge_n(P, n)
            err = (abs(M[0] - X_px[key][0]) + abs(M[1] - X_px[key][1]) + abs(M[2] - X_px[key][2])) / 3.0 \
                  + abs(M[3] - X_px[key][3]) / 255.0
            if best is None or err < best[0]:
                best = (err, n, M)
        err, n, M = best
        print(f"  [{sname}/{key}] n*={n}: M=({M[0]:.1f},{M[1]:.1f},{M[2]:.1f},a{M[3]:.1f}) "
              f"X=({X_px[key][0]:.0f},{X_px[key][1]:.0f},{X_px[key][2]:.0f},a{X_px[key][3]:.0f}) err={err:.3f}")

print("\n===== 扣黑模拟（用户方式：选中亮部→反选→删除暗部 => alpha=sel，RGB=Z），n=7 =====")
for sname, sfunc in SEL_FUNCS.items():
    for key in X_px:
        sel = sfunc(Z[key])
        Q = [Z[key][0], Z[key][1], Z[key][2], sel * 255.0]
        M = merge_n(Q, 7)
        err = (abs(M[0] - X_px[key][0]) + abs(M[1] - X_px[key][1]) + abs(M[2] - X_px[key][2])) / 3.0 \
              + abs(M[3] - X_px[key][3]) / 255.0
        print(f"  [{sname}/{key}] M=({M[0]:.1f},{M[1]:.1f},{M[2]:.1f},a{M[3]:.1f}) "
              f"X=({X_px[key][0]:.0f},{X_px[key][1]:.0f},{X_px[key][2]:.0f},a{X_px[key][3]:.0f}) err={err:.3f}")

# 关键洞察：扣黑时 Z_rgb = X_rgb * a（预乘），复制合并不改变 RGB
print("\n===== 关键：扣黑时 Z_rgb = X_rgb * a（预乘），复制合并不改变 RGB =====")
for key in X_px:
    z = Z[key]
    x = X_px[key]
    a = x[3] / 255.0
    print(f"  {key}: Z_rgb/255=({z[0]/255:.3f},{z[1]/255:.3f},{z[2]/255:.3f})  "
          f"X_rgb*a=({x[0]/255*a:.3f},{x[1]/255*a:.3f},{x[2]/255*a:.3f})  "
          f"X_rgb/255=({x[0]/255:.3f},{x[1]/255:.3f},{x[2]/255:.3f})")

# 关键洞察2：扣白时 Y_rgb = X_rgb*a + (1-a)，RGB 未预乘（是"预乘白"），
# 所以复制合并 RGB=Y_rgb 至少颜色方向对；扣黑方向 RGB 直接被 alpha 压暗。
